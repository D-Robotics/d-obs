import os from 'node:os';
import { sendWebhookPayload } from '../analytics-cloud-forward.js';
import {
  ALERT_CHANNEL_LABELS,
  ALERT_CHANNEL_SECRET_FIELDS,
  ALERT_CHANNEL_WEBHOOK_FIELDS,
  isAlertDeliveryChannel,
  sendAlertChannelPayload,
  type AlertDeliveryChannel,
} from './alert-notification-channels.js';
import {
  ALERT_MESSAGE_TEMPLATE_VARIABLES,
  ALERT_RULE_DEFINITIONS,
  alertRuleObjectTarget,
  type AlertConfig,
} from './alert-config.js';
import { remediationDeepLink, remediationPlaybooksForRule } from './alert-remediation.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import type { AlertObservation, AlertTransition, AlertWorkerState } from './studio-alert-state.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end: () => Promise<void>;
};

type FeishuCardTemplate = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'grey';

const ALERT_RULE_CATEGORY_LABELS: Record<string, string> = {
  metric: '指标聚合',
  log: '日志签名',
  probe: '异地拨测',
};

function formatUtcTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return `${new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
}

function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '-';
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} 分钟`;
  return `${Math.floor(whole / 60)} 小时 ${whole % 60} 分钟`;
}

/** 卡片 header 颜色与状态标签：告警红/橙、升级红、持续黄、恢复绿、测试蓝。 */
function transitionCardSpec(
  transition: AlertTransition,
  isTest: boolean,
): { template: FeishuCardTemplate; emoji: string; status: string } {
  if (isTest) return { template: 'blue', emoji: '🧪', status: '测试' };
  switch (transition.kind) {
    case 'resolved':
      return { template: 'green', emoji: '✅', status: '恢复' };
    case 'escalated':
      return { template: 'red', emoji: '🚨', status: '升级' };
    case 'reminder':
      return { template: 'yellow', emoji: '⏰', status: '持续' };
    default:
      return transition.severity === 'critical'
        ? { template: 'red', emoji: '🚨', status: '严重' }
        : { template: 'orange', emoji: '⚠️', status: '告警' };
  }
}

function buildFeishuAlertCard(
  transition: AlertTransition,
  config: AlertConfig,
  options?: { forceTest?: boolean },
): Record<string, unknown> {
  const spec = transitionCardSpec(transition, Boolean(options?.forceTest));
  const rule = ALERT_RULE_DEFINITIONS.find((definition) => definition.key === transition.key);
  const severityLabel = transition.severity === 'critical' ? '严重' : '警告';
  const severityColor = transition.severity === 'critical' ? 'red' : 'orange';
  const factLines = [
    `**环境** ${config.global.environmentLabel}　|　**级别** <font color='${severityColor}'>${severityLabel}</font>${
      rule ? `　|　**类别** ${ALERT_RULE_CATEGORY_LABELS[rule.category] ?? rule.category}` : ''
    }`,
    `**本次时间** ${formatUtcTimestamp(transition.at)}`,
  ];
  if (transition.kind === 'resolved') {
    factLines.push(
      `**持续时长** ${formatDuration(transition.durationMinutes)}　|　**连续正常检查** ${transition.successStreak ?? '-'} 次`,
    );
  } else {
    if (transition.firstSeenAt) {
      const firstSeen = Date.parse(transition.firstSeenAt);
      const current = Date.parse(transition.at);
      const ongoingMinutes =
        Number.isFinite(firstSeen) && Number.isFinite(current)
          ? Math.max(0, Math.round((current - firstSeen) / 60_000))
          : null;
      factLines.push(
        `**首次发现** ${formatUtcTimestamp(transition.firstSeenAt)}　|　**已持续** ${formatDuration(ongoingMinutes)}`,
      );
    }
    if (transition.failureStreak) {
      factLines.push(`**连续异常检查** ${transition.failureStreak} 次`);
    }
  }
  const actionGuide =
    transition.kind === 'resolved'
      ? '告警已恢复，可在看板确认事故状态。'
      : config.notification.actionGuide;
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: factLines.join('\n') },
    { tag: 'markdown', content: `**摘要** ${transition.summary}` },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**指纹** \`${transition.key}\`\n**处置** ${actionGuide}`,
    },
  ];
  const actions: Array<Record<string, unknown>> = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '查看看板' },
      type: 'default',
      url: config.notification.dashboardUrl,
    },
  ];
  if (
    (transition.kind === 'opened' || transition.kind === 'escalated') &&
    remediationPlaybooksForRule(transition.key).length > 0
  ) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '一键自愈' },
      type: 'primary',
      url: remediationDeepLink(config, transition.key),
    });
  }
  elements.push({ tag: 'action', actions });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: spec.template,
      title: {
        tag: 'plain_text',
        content: `${spec.emoji} [${config.notification.titlePrefix} · ${spec.status}] ${transition.title}`,
      },
    },
    elements,
  };
}

function buildNotificationText(transition: AlertTransition, config: AlertConfig): string {
  const label =
    transition.kind === 'resolved'
      ? '恢复'
      : transition.kind === 'escalated'
        ? '升级'
        : transition.kind === 'reminder'
          ? '持续'
          : transition.severity === 'critical'
            ? '严重'
            : '警告';
  const values: Record<(typeof ALERT_MESSAGE_TEMPLATE_VARIABLES)[number], string> = {
    product: config.notification.titlePrefix,
    status: label,
    title: transition.title,
    environment: config.global.environmentLabel,
    occurredAt: transition.at,
    severity: transition.severity === 'critical' ? '严重' : '警告',
    summary: transition.summary,
    alertKey: transition.key,
    actionGuide:
      transition.kind === 'resolved'
        ? '告警已恢复，可在看板确认事故状态。'
        : config.notification.actionGuide,
    dashboardUrl: config.notification.dashboardUrl,
  };
  const rendered = config.notification.messageTemplate
    .replace(
      /\{\{([a-zA-Z]+)\}\}/g,
      (_match, key: string) => values[key as keyof typeof values] ?? '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 有白名单自愈剧本的规则，告警消息附带看板深链，运营一点即达自愈中心。
  if (
    (transition.kind === 'opened' || transition.kind === 'escalated') &&
    remediationPlaybooksForRule(transition.key).length > 0
  ) {
    return `${rendered}\n一键自愈：${remediationDeepLink(config, transition.key)}`;
  }
  return rendered;
}

export async function ensureAlertHistorySchema(p: Pool): Promise<void> {
  await p.query(`
    create table if not exists public.studio_ops_events (
      id uuid primary key default gen_random_uuid(),
      occurred_at timestamptz not null,
      component text not null,
      event_code text not null,
      outcome text not null,
      severity_hint text not null default 'warning',
      fingerprint text not null,
      safe_summary text null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);
  await p.query(
    `create index if not exists studio_ops_events_occurred_idx
     on public.studio_ops_events (occurred_at desc)`,
  );
  await p.query(
    `create index if not exists studio_ops_events_code_outcome_idx
     on public.studio_ops_events (event_code, outcome, occurred_at desc)`,
  );
  await p.query(
    `create index if not exists studio_ops_events_fingerprint_idx
     on public.studio_ops_events (fingerprint, occurred_at desc)`,
  );
  await p.query(`
    create table if not exists public.studio_alert_incidents (
      alert_key text primary key,
      title text not null,
      severity text not null,
      status text not null,
      summary text null,
      first_seen_at timestamptz not null,
      last_seen_at timestamptz not null,
      last_notified_at timestamptz null,
      resolved_at timestamptz null,
      occurrence_count int not null default 1
    )
  `);
  await p.query(`
    create table if not exists public.studio_alert_notifications (
      id uuid primary key default gen_random_uuid(),
      occurred_at timestamptz not null default now(),
      alert_key text not null,
      transition text not null,
      severity text not null,
      delivered boolean not null,
      channel text not null,
      error text null,
      attempt_count int not null default 1
    )
  `);
  await p.query(
    `alter table public.studio_alert_notifications
       add column if not exists attempt_count int not null default 1`,
  );
  await p.query(
    `create index if not exists studio_alert_notifications_occurred_idx
     on public.studio_alert_notifications (occurred_at desc)`,
  );
  await p.query(`
    create table if not exists public.studio_alert_checks (
      alert_key text primary key,
      title text not null,
      category text not null default 'metric',
      enabled boolean not null default true,
      severity text not null,
      unhealthy boolean not null,
      active boolean not null,
      summary text null,
      checked_at timestamptz not null,
      failure_streak int not null default 0,
      success_streak int not null default 0
    )
  `);
  await p.query(
    `alter table public.studio_alert_checks
       add column if not exists category text not null default 'metric'`,
  );
  await p.query(
    `alter table public.studio_alert_checks
       add column if not exists enabled boolean not null default true`,
  );
  await p.query(
    `create index if not exists studio_alert_checks_checked_idx
     on public.studio_alert_checks (checked_at desc)`,
  );
  await p.query(`
    create table if not exists public.studio_alert_worker_status (
      singleton boolean primary key default true check (singleton),
      last_run_at timestamptz not null,
      enabled boolean not null,
      shadow_mode boolean not null,
      channel_configured boolean not null,
      channel text not null,
      config_updated_at timestamptz null,
      check_count int not null,
      active_count int not null,
      worker_version text not null
    )
  `);
}

export async function recordCheckSnapshots(
  p: Pool,
  observations: AlertObservation[],
  state: AlertWorkerState,
  checkedAt: string,
): Promise<void> {
  const rows = observations.map((observation) => {
    const keyState = state.keys[observation.key];
    return {
      alert_key: observation.key,
      title: observation.title,
      category:
        ALERT_RULE_DEFINITIONS.find((definition) => definition.key === observation.key)?.category ??
        'metric',
      enabled: observation.enabled !== false,
      severity: observation.severity,
      unhealthy: observation.unhealthy,
      active: keyState?.active ?? false,
      summary: sanitizeOpsSummary(observation.summary, 800),
      checked_at: checkedAt,
      failure_streak: keyState?.failureStreak ?? 0,
      success_streak: keyState?.successStreak ?? 0,
    };
  });
  await p.query(
    `insert into public.studio_alert_checks
       (alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at, failure_streak, success_streak)
     select alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at, failure_streak, success_streak
     from jsonb_to_recordset($1::jsonb) as row(
       alert_key text,
       title text,
       category text,
       enabled boolean,
       severity text,
       unhealthy boolean,
       active boolean,
       summary text,
       checked_at timestamptz,
       failure_streak int,
       success_streak int
     )
     on conflict (alert_key) do update
       set title = excluded.title,
           category = excluded.category,
           enabled = excluded.enabled,
           severity = excluded.severity,
           unhealthy = excluded.unhealthy,
           active = excluded.active,
           summary = excluded.summary,
           checked_at = excluded.checked_at,
           failure_streak = excluded.failure_streak,
           success_streak = excluded.success_streak`,
    [JSON.stringify(rows)],
  );
}

function incidentObjectId(alertKey: string): string {
  const target = alertRuleObjectTarget(alertKey);
  return target === 'host/self' ? `host/${os.hostname()}` : target;
}

export async function recordIncidentSnapshots(
  p: Pool,
  observations: AlertObservation[],
  state: AlertWorkerState,
  checkedAt: string,
): Promise<void> {
  for (const observation of observations) {
    const keyState = state.keys[observation.key];
    if (!keyState?.active) continue;
    await p.query(
      `insert into public.studio_alert_incidents
         (alert_key, object_id, title, severity, status, summary, first_seen_at, last_seen_at, occurrence_count)
       values ($1, $2, $3, $4, 'open', $5, $6, $7, 1)
       on conflict (alert_key) do update
         set title = excluded.title,
             severity = excluded.severity,
             status = case when public.studio_alert_incidents.status = 'resolved'
                                or (public.studio_alert_incidents.status = 'silenced'
                                    and coalesce(public.studio_alert_incidents.silence_until, now()) <= now())
                           then 'open' else public.studio_alert_incidents.status end,
             summary = excluded.summary,
             last_seen_at = excluded.last_seen_at,
             object_id = coalesce(public.studio_alert_incidents.object_id, excluded.object_id),
             occurrence_count = public.studio_alert_incidents.occurrence_count + 1,
             silence_until = case when public.studio_alert_incidents.status = 'silenced'
                                      and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                   then null else public.studio_alert_incidents.silence_until end,
             silence_reason = case when public.studio_alert_incidents.status = 'silenced'
                                       and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                    then null else public.studio_alert_incidents.silence_reason end,
             acknowledged_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_at end,
             acknowledged_by = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_by end,
             resolved_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.resolved_at end`,
      [
        observation.key,
        incidentObjectId(observation.key),
        observation.title,
        observation.severity,
        sanitizeOpsSummary(observation.summary, 800),
        keyState.firstSeenAt ?? checkedAt,
        checkedAt,
      ],
    );
  }
}

/**
 * 状态文件可能被重建，而数据库仍保留旧的 open 事故。只对“当前检查已明确健康且达到恢复次数”
 * 或“规则已停用”的 inactive 规则做闭环；unknown 观测绝不能借机关闭事故。
 */
export async function resolveInactiveIncidentSnapshots(
  p: Pool,
  observations: AlertObservation[],
  state: AlertWorkerState,
  checkedAt: string,
): Promise<void> {
  const resolvedKeys = observations
    .filter((observation) => {
      const keyState = state.keys[observation.key];
      if (!keyState || keyState.active || observation.unknown) return false;
      if (observation.enabled === false) return true;
      return (
        !observation.unhealthy &&
        keyState.successStreak >= Math.max(1, observation.resolveAfter ?? 2)
      );
    })
    .map((observation) => observation.key);
  if (!resolvedKeys.length) return;
  await p.query(
    `update public.studio_alert_incidents
     set status = 'resolved',
         summary = '当前检查已恢复，worker 对账关闭历史事故',
         last_seen_at = $2,
         resolved_at = $2
     where status = 'open' and alert_key = any($1::text[])`,
    [resolvedKeys, checkedAt],
  );
}

export async function recordWorkerStatus(
  p: Pool,
  config: AlertConfig,
  checkedAt: string,
  checkCount: number,
  activeCount: number,
): Promise<void> {
  await p.query(
    `insert into public.studio_alert_worker_status
       (singleton, last_run_at, enabled, shadow_mode, channel_configured, channel,
        config_updated_at, check_count, active_count, worker_version)
     values (true, $1, $2, $3, $4, $5, $6, $7, $8, '2')
     on conflict (singleton) do update
       set last_run_at = excluded.last_run_at,
           enabled = excluded.enabled,
           shadow_mode = excluded.shadow_mode,
           channel_configured = excluded.channel_configured,
           channel = excluded.channel,
           config_updated_at = excluded.config_updated_at,
           check_count = excluded.check_count,
           active_count = excluded.active_count,
           worker_version = excluded.worker_version`,
    [
      checkedAt,
      config.global.enabled,
      config.notification.shadowMode || !config.notification.enabled,
      Boolean(
        config.notification.channel === 'feishu'
          ? config.notification.feishuWebhookUrl
          : config.notification.webhookUrl,
      ) || configuredAlertChannelSummary(config) !== 'none',
      config.notification.channel,
      config.updatedAt,
      checkCount,
      activeCount,
    ],
  );
}

export async function recordIncident(
  p: Pool,
  transition: AlertTransition,
  delivered: boolean,
): Promise<void> {
  if (transition.kind === 'resolved') {
    await p.query(
      `update public.studio_alert_incidents
       set status = 'resolved', summary = $2, last_seen_at = $3, resolved_at = $3,
           last_notified_at = case when $4 then $3 else last_notified_at end
       where alert_key = $1`,
      [transition.key, transition.summary, transition.at, delivered],
    );
    return;
  }
  await p.query(
    `insert into public.studio_alert_incidents
       (alert_key, object_id, title, severity, status, summary, first_seen_at, last_seen_at, last_notified_at, occurrence_count)
     values ($1, $7, $2, $3, 'open', $4, $5, $5, case when $6 then $5::timestamptz else null end, 1)
     on conflict (alert_key) do update
       set title = excluded.title,
           severity = excluded.severity,
           status = case when public.studio_alert_incidents.status = 'resolved'
                              or (public.studio_alert_incidents.status = 'silenced'
                                  and coalesce(public.studio_alert_incidents.silence_until, now()) <= now())
                         then 'open' else public.studio_alert_incidents.status end,
           summary = excluded.summary,
           last_seen_at = excluded.last_seen_at,
           last_notified_at = case when $6 then excluded.last_seen_at else public.studio_alert_incidents.last_notified_at end,
           resolved_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.resolved_at end,
           occurrence_count = public.studio_alert_incidents.occurrence_count + 1,
           silence_until = case when public.studio_alert_incidents.status = 'silenced'
                                    and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                 then null else public.studio_alert_incidents.silence_until end,
           silence_reason = case when public.studio_alert_incidents.status = 'silenced'
                                     and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                  then null else public.studio_alert_incidents.silence_reason end,
           acknowledged_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_at end,
           acknowledged_by = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_by end`,
    [
      transition.key,
      transition.title,
      transition.severity,
      transition.summary,
      transition.at,
      delivered,
      incidentObjectId(transition.key),
    ],
  );
}

export type AlertNotificationRetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

const DEFAULT_NOTIFICATION_RETRY_POLICY: AlertNotificationRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

export function alertNotificationRetryPolicy(): AlertNotificationRetryPolicy {
  return {
    maxAttempts: boundedEnvNumber(
      'RDK_ALERT_NOTIFICATION_MAX_ATTEMPTS',
      DEFAULT_NOTIFICATION_RETRY_POLICY.maxAttempts,
      1,
      5,
    ),
    baseDelayMs: boundedEnvNumber(
      'RDK_ALERT_NOTIFICATION_RETRY_BASE_MS',
      DEFAULT_NOTIFICATION_RETRY_POLICY.baseDelayMs,
      0,
      5_000,
    ),
    maxDelayMs: boundedEnvNumber(
      'RDK_ALERT_NOTIFICATION_RETRY_MAX_MS',
      DEFAULT_NOTIFICATION_RETRY_POLICY.maxDelayMs,
      0,
      30_000,
    ),
  };
}

/** Only transient transport/server failures are retried; malformed or rejected payloads are terminal. */
export function isRetryableAlertDelivery(result: { status?: number; error?: string }): boolean {
  if (result.status === 408 || result.status === 425 || result.status === 429) return true;
  if (result.status != null) return result.status >= 500 && result.status <= 599;
  return (
    !result.error?.startsWith('invalid_webhook_url') && result.error !== 'webhook_not_configured'
  );
}

type WebhookSender = typeof sendWebhookPayload;

export async function sendAlertWebhookWithRetry(
  url: string,
  payload: Parameters<WebhookSender>[1],
  options: Parameters<WebhookSender>[2],
  retryPolicy: AlertNotificationRetryPolicy = alertNotificationRetryPolicy(),
  sender: WebhookSender = sendWebhookPayload,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ delivered: boolean; attempts: number; status?: number; error?: string }> {
  let last: { ok: boolean; status?: number; error?: string } = {
    ok: false,
    error: 'delivery_failed',
  };
  let attempts = 0;
  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      last = await sender(url, payload, options);
    } catch (error) {
      last = { ok: false, error: sanitizeOpsSummary(error, 240) || 'delivery_failed' };
    }
    if (last.ok) return { delivered: true, attempts: attempt, status: last.status };
    if (attempt >= retryPolicy.maxAttempts || !isRetryableAlertDelivery(last)) break;
    const delay = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** (attempt - 1));
    if (delay > 0) await sleep(delay);
  }
  const baseError = sanitizeOpsSummary(last.error, 240) || 'delivery_failed';
  return {
    delivered: false,
    attempts: Math.max(1, attempts),
    ...(last.status == null ? {} : { status: last.status }),
    error: `${baseError}${attempts > 1 ? `_after_${attempts}_attempts` : ''}`,
  };
}

/** 渠道对应的 Webhook URL（trim 后）。 */
export function alertChannelUrl(
  channel: AlertDeliveryChannel,
  config: AlertConfig,
): string {
  const field = ALERT_CHANNEL_WEBHOOK_FIELDS[channel] as
    | 'feishuWebhookUrl'
    | 'dingtalkWebhookUrl'
    | 'wecomWebhookUrl'
    | 'slackWebhookUrl'
    | 'telegramWebhookUrl'
    | 'webhookUrl';
  return String(config.notification[field] ?? '').trim();
}

/** 渠道可选密钥（钉钉加签 / 飞书加签 / 通用 Bearer）。 */
function alertChannelSecret(
  channel: AlertDeliveryChannel,
  config: AlertConfig,
): string {
  const field = ALERT_CHANNEL_SECRET_FIELDS[channel as keyof typeof ALERT_CHANNEL_SECRET_FIELDS];
  if (!field) return '';
  return String(config.notification[field as 'feishuSignSecret'] ?? '').trim();
}

export async function deliverTransition(
  transition: AlertTransition,
  config: AlertConfig,
  options?: { forceTest?: boolean; channel?: AlertDeliveryChannel },
): Promise<{ delivered: boolean; channel: string; attempts: number; error?: string }> {
  const ruleChannel = config.rules[transition.key]?.notificationChannel ?? 'default';
  if (!options?.forceTest && ruleChannel === 'none') {
    return {
      delivered: false,
      channel: 'suppressed',
      attempts: 0,
      error: 'rule_notification_disabled',
    };
  }
  const rawChannel =
    options?.channel ?? (ruleChannel === 'default' ? config.notification.channel : ruleChannel);
  if (!isAlertDeliveryChannel(rawChannel)) {
    return {
      delivered: false,
      channel: 'suppressed',
      attempts: 0,
      error: 'notification_channel_not_selected',
    };
  }
  const channel: AlertDeliveryChannel = rawChannel;
  const channelField = ALERT_CHANNEL_WEBHOOK_FIELDS[channel];
  const url = alertChannelUrl(channel, config);
  const message = buildNotificationText(transition, config);
  if (!options?.forceTest && transition.kind === 'resolved' && !config.global.notifyOnRecovery) {
    return {
      delivered: false,
      channel: 'suppressed',
      attempts: 0,
      error: 'recovery_notification_disabled',
    };
  }
  if (
    !options?.forceTest &&
    config.notification.minSeverity === 'critical' &&
    transition.severity !== 'critical'
  ) {
    return {
      delivered: false,
      channel: 'suppressed',
      attempts: 0,
      error: 'below_minimum_severity',
    };
  }
  const shadow =
    !options?.forceTest && (!config.notification.enabled || config.notification.shadowMode || !url);
  if (shadow) {
    console.log(`[alert-worker][shadow] ${message.replace(/\n/g, ' | ')}`);
    return {
      delivered: false,
      channel: url ? 'shadow' : 'unconfigured',
      attempts: 0,
      error: !url
        ? `${channelField}_not_configured`
        : !config.notification.enabled
          ? 'notification_disabled'
          : 'shadow_mode',
    };
  }
  if (!url) {
    return {
      delivered: false,
      channel: 'unconfigured',
      attempts: 0,
      error: `${channelField}_not_configured`,
    };
  }
  const payload = {
    schema: 'rdk.studio.alert.v1',
    transition: transition.kind,
    severity: transition.severity,
    alertKey: transition.key,
    title: transition.title,
    summary: transition.summary,
    occurredAt: transition.at,
    environment: config.global.environmentLabel,
    message,
    actionGuide:
      transition.kind === 'resolved'
        ? '告警已恢复，可在看板确认事故状态。'
        : config.notification.actionGuide,
    dashboardUrl: config.notification.dashboardUrl,
  };
  const result = await sendAlertWebhookWithRetry(
    url,
    payload,
    {
      bearerSecret: undefined,
      feishuSignSecret: undefined,
      logTag: 'alert-worker',
      suppressResponseBodyInLogs: true,
    },
    alertNotificationRetryPolicy(),
    async (target, body, sendOptions) =>
      sendAlertChannelPayload(channel, target, {
        message,
        title: transition.title,
        secret: alertChannelSecret(channel, config) || undefined,
        payload: body,
        feishuCard:
          channel === 'feishu' ? buildFeishuAlertCard(transition, config, options) : undefined,
      }).then((sendResult) => ({
        ok: sendResult.ok,
        ...(sendResult.status == null ? {} : { status: sendResult.status }),
        ...(sendResult.error == null ? {} : { error: sendResult.error }),
      })),
  );
  return {
    delivered: result.delivered,
    channel,
    attempts: result.attempts,
    ...(result.error ? { error: sanitizeOpsSummary(result.error, 240) } : {}),
  };
}

export async function sendAlertTestNotification(
  config: AlertConfig,
  channel: AlertDeliveryChannel = config.notification.channel,
): Promise<{ delivered: boolean; channel: string; error?: string }> {
  return deliverTransition(
    {
      kind: 'opened',
      key: 'public-health',
      title: '通知渠道测试',
      severity: 'warning',
      summary: '这是一条由生产可观测看板主动发送的测试通知，不代表真实故障。',
      at: new Date().toISOString(),
    },
    config,
    { forceTest: true, channel },
  );
}

/** Worker 状态单例行：所有已配置渠道（供看板如实展示通知能力）。 */
export function configuredAlertChannelSummary(config: AlertConfig): string {
  const configured = (Object.keys(ALERT_CHANNEL_WEBHOOK_FIELDS) as AlertDeliveryChannel[]).filter(
    (channel) => alertChannelUrl(channel, config),
  );
  return configured.join(',') || 'none';
}

export { ALERT_CHANNEL_LABELS };
