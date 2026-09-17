/**
 * 每日生产错误摘要：复用实时告警的飞书联系人、签名、重试和影子模式。
 *
 * 摘要只包含聚合计数、低敏错误摘要和告警规则标题；不查询用户、设备、会话或请求正文。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLIENT_ERROR_NON_ACTIONABLE_API_CODES } from '../../shared/client-error-telemetry.js';
import { loadAlertConfig, type AlertConfig } from './alert-config.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { installNodeConsoleErrorTelemetry } from './node-console-error-telemetry.js';
import { ensureAlertHistorySchema, sendAlertWebhookWithRetry } from './studio-alert-delivery.js';

const ERROR_DIGEST_SCHEMA = 'rdk.studio.error_digest.v1' as const;
const DEFAULT_LOOKBACK_HOURS = 24;
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
const CHECK_CATEGORY_LABELS = { metric: '指标', log: '日志', probe: '拨测' } as const;
const INCIDENT_STATUS_LABELS: Record<string, string> = {
  open: '待确认',
  acknowledged: '已确认',
  silenced: '已静默',
};
const ERROR_CATEGORY_LABELS = {
  api: 'API 服务',
  tool: 'Agent 工具',
  desktop: 'Electron 桌面端',
  web: 'Web 前端',
  login: '登录链路',
  process: 'Node 进程',
  other: '其他平台信号',
} as const;

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type ErrorDigestPool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end?: () => Promise<void>;
};

export interface DailyErrorDigest {
  schema: typeof ERROR_DIGEST_SCHEMA;
  generatedAt: string;
  window: {
    from: string;
    to: string;
    hours: number;
    timeZone: typeof DISPLAY_TIME_ZONE;
  };
  checks: {
    total: number;
    enabled: number;
    healthy: number;
    pending: number;
    active: number;
    disabled: number;
    stale: number;
    categories: Array<{
      key: 'metric' | 'log' | 'probe';
      total: number;
      healthy: number;
      pending: number;
      active: number;
      disabled: number;
      stale: number;
    }>;
  };
  incidents: {
    open: number;
    critical: number;
    items: Array<{
      alertKey: string;
      title: string;
      severity: 'warning' | 'critical';
      status: string;
      summary: string;
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      occurrenceCount: number;
    }>;
  };
  errors: {
    totalEvents: number;
    distinctFingerprints: number;
    affectedComponents: number;
    categories: Array<{
      key: 'api' | 'tool' | 'desktop' | 'web' | 'login' | 'process' | 'other';
      count: number;
      fingerprints: number;
      criticalCount: number;
    }>;
    items: Array<{
      component: string;
      eventCode: string;
      count: number;
      fingerprints: number;
      criticalCount: number;
      latestAt: string | null;
      summary: string;
    }>;
  };
  aiRuns: {
    total: number;
    successful: number;
    errors: number;
    partials: number;
    successRate: number | null;
  };
  notifications: {
    attempts: number;
    delivered: number;
    failed: number;
    suppressed: number;
    incidentTransitions: number;
    recoveries: number;
  };
}

export interface DailyErrorDigestDelivery {
  delivered: boolean;
  channel: 'feishu' | 'shadow' | 'unconfigured' | 'disabled';
  attempts: number;
  error?: string;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function iso(value: unknown): string | null {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function text(value: unknown, maxLength = 500): string {
  return sanitizeOpsSummary(value, maxLength);
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') {
    try {
      return records(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function boundedLookbackHours(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(168, Math.round(value as number)))
    : DEFAULT_LOOKBACK_HOURS;
}

/**
 * The exclusions intentionally mirror the investigation feed: development
 * noise, duplicate API/client reports and expected device-offline states do
 * not belong in the production digest.
 */
export async function collectDailyErrorDigest(
  p: ErrorDigestPool,
  options?: { now?: Date; lookbackHours?: number },
): Promise<DailyErrorDigest> {
  const now = options?.now ?? new Date();
  const lookbackHours = boundedLookbackHours(options?.lookbackHours);
  const [checksResult, incidentsResult, errorsResult, aiRunsResult, notificationsResult] =
    await Promise.all([
      p.query(
        `with check_rows as (
         select category, enabled, unhealthy, active, checked_at
         from public.studio_alert_checks
       ), category_summary as (
         select category,
                count(*)::int total,
                count(*) filter (where enabled and not unhealthy)::int healthy,
                count(*) filter (where enabled and unhealthy and not active)::int pending,
                count(*) filter (where enabled and active)::int active,
                count(*) filter (where not enabled)::int disabled,
                count(*) filter (where checked_at < now() - interval '5 minutes')::int stale
         from check_rows
         group by category
       )
       select count(*)::int total,
              count(*) filter (where enabled)::int enabled,
              count(*) filter (where enabled and not unhealthy)::int healthy,
              count(*) filter (where enabled and unhealthy and not active)::int pending,
              count(*) filter (where enabled and active)::int active,
              count(*) filter (where not enabled)::int disabled,
              count(*) filter (where checked_at < now() - interval '5 minutes')::int stale,
              coalesce(
                (select jsonb_agg(to_jsonb(category_summary)
                                  order by case category when 'metric' then 1 when 'log' then 2 else 3 end)
                   from category_summary),
                '[]'::jsonb
              ) categories
       from check_rows`,
      ),
      p.query(
        `with current_incidents as (
         select alert_key, title, severity, status, summary,
                first_seen_at, last_seen_at, occurrence_count
         from public.studio_alert_incidents
         where status in ('open', 'acknowledged')
            or (status = 'silenced' and coalesce(silence_until, now()) > now())
       ), top_incidents as (
         select *
         from current_incidents
         order by (severity = 'critical') desc, last_seen_at desc
         limit 8
       )
       select count(*)::int open_count,
              count(*) filter (where severity = 'critical')::int critical_count,
              coalesce(
                (select jsonb_agg(to_jsonb(top_incidents)
                                  order by (severity = 'critical') desc, last_seen_at desc)
                   from top_incidents),
                '[]'::jsonb
              ) items
       from current_incidents`,
      ),
      p.query(
        `with recent_errors as (
         select occurred_at, component, event_code, severity_hint, fingerprint, safe_summary,
                case
                  when event_code = 'http_5xx' then 'api'
                  when event_code = 'tool_call' then 'tool'
                  when event_code = 'sso_login_attempt' then 'login'
                  when event_code in ('process_unhandled_error', 'console_error') then 'process'
                  when component like 'client-electron%' then 'desktop'
                  when component like 'client-web%' then 'web'
                  else 'other'
                end error_category
         from public.studio_ops_events
         where occurred_at >= $1::timestamptz - make_interval(hours => $2::int)
           and occurred_at <= $1::timestamptz + interval '5 minutes'
           and outcome in ('error', 'degraded')
           and coalesce(metadata->>'client_type', '') <> 'local-dev'
           and coalesce(metadata->>'environment', 'production') not in ('development', 'test')
           and not (coalesce(metadata->>'code', '') = any($3::text[]))
           and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
           and coalesce(safe_summary, '') !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
           and not (
             event_code = 'client_error'
             and coalesce(metadata->>'source', '') = 'resource_error'
             and (
               coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
               or coalesce(metadata->>'route', '') ~* '(^|/)assets/.*[.](avif|gif|ico|jpe?g|png|svg|webp|woff2?|ttf)([?#]|$)'
             )
           )
           and not (
             event_code = 'client_error'
             and (
               coalesce(metadata->>'operational', 'true') = 'false'
               or (
                 coalesce(metadata->>'source', '') = 'api_error'
                 and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
               )
               or (
                 coalesce(metadata->>'source', '') = 'electron_child_gone'
                 and (
                   lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
                   or coalesce(safe_summary, '') ~* 'signal=SIGTERM'
                 )
               )
               or (
                 coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
                 and coalesce(metadata->>'code', '') = '1073807364'
                 and coalesce(safe_summary, '') ~* '(killed|embedded server exited)'
               )
               or coalesce(safe_summary, '') ~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
             )
           )
           and not (
             event_code = 'http_5xx'
             and coalesce(metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
             and coalesce(metadata->>'status', '') in ('503', '504')
           )
       ), grouped_errors as (
         select component,
                event_code,
                count(*)::int event_count,
                count(distinct fingerprint)::int fingerprint_count,
                count(*) filter (where severity_hint = 'critical')::int critical_count,
                max(occurred_at) latest_at,
                (array_agg(safe_summary order by occurred_at desc)
                   filter (where nullif(safe_summary, '') is not null))[1] latest_summary
         from recent_errors
         group by component, event_code
       ), category_summary as (
         select error_category,
                count(*)::int event_count,
                count(distinct fingerprint)::int fingerprint_count,
                count(*) filter (where severity_hint = 'critical')::int critical_count
         from recent_errors
         group by error_category
       ), top_errors as (
         select *
         from grouped_errors
         order by event_count desc, latest_at desc
         limit 10
       )
       select count(*)::int total_events,
              count(distinct fingerprint)::int distinct_fingerprints,
              count(distinct component)::int affected_components,
              coalesce(
                (select jsonb_agg(to_jsonb(category_summary) order by event_count desc)
                   from category_summary),
                '[]'::jsonb
              ) categories,
              coalesce(
                (select jsonb_agg(to_jsonb(top_errors)
                                  order by event_count desc, latest_at desc)
                   from top_errors),
                '[]'::jsonb
              ) items
       from recent_errors`,
        [now.toISOString(), lookbackHours, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
      ),
      p.query(
        `with latest as (
         select distinct on (run_id)
                run_id, outcome, error_detail, tool_call_count, completion_tokens
         from public.agent_run_records
         where started_at >= $1::timestamptz - make_interval(hours => $2::int)
           and started_at <= $1::timestamptz + interval '5 minutes'
           and coalesce(client_type, '') <> 'local-dev'
         order by run_id, created_at desc
       )
       select count(*)::int total,
              count(*) filter (where outcome = 'error')::int errors,
              count(*) filter (
                where outcome = 'completed_partial'
                  and not (
                    coalesce(error_detail, '') ~ 'partial_reason=(acceptance_audit|actuation_guard|tool_intent_only|tool_loop_guard)'
                    or (coalesce(error_detail, '') = ''
                        and tool_call_count = 0
                        and coalesce(completion_tokens, 0) > 0)
                  )
              )::int partials
       from latest`,
        [now.toISOString(), lookbackHours],
      ),
      p.query(
        `select count(*)::int attempts,
              count(*) filter (where delivered)::int delivered,
              count(*) filter (where not delivered and attempt_count > 0)::int failed,
              count(*) filter (where not delivered and attempt_count = 0)::int suppressed,
              count(*) filter (where transition in ('opened', 'escalated', 'reminder'))::int incident_transitions,
              count(*) filter (where transition = 'resolved')::int recoveries
       from public.studio_alert_notifications
       where occurred_at >= $1::timestamptz - make_interval(hours => $2::int)
         and occurred_at <= $1::timestamptz + interval '5 minutes'`,
        [now.toISOString(), lookbackHours],
      ),
    ]);

  const checks = checksResult.rows[0] ?? {};
  const incidents = incidentsResult.rows[0] ?? {};
  const errors = errorsResult.rows[0] ?? {};
  const aiRuns = aiRunsResult.rows[0] ?? {};
  const notifications = notificationsResult.rows[0] ?? {};
  const aiRunTotal = number(aiRuns.total);
  const aiRunErrors = number(aiRuns.errors);
  const aiRunPartials = number(aiRuns.partials);
  const aiRunSuccessful = Math.max(0, aiRunTotal - aiRunErrors - aiRunPartials);

  return {
    schema: ERROR_DIGEST_SCHEMA,
    generatedAt: now.toISOString(),
    window: {
      from: new Date(now.getTime() - lookbackHours * 60 * 60_000).toISOString(),
      to: now.toISOString(),
      hours: lookbackHours,
      timeZone: DISPLAY_TIME_ZONE,
    },
    checks: {
      total: number(checks.total),
      enabled: number(checks.enabled),
      healthy: number(checks.healthy),
      pending: number(checks.pending),
      active: number(checks.active),
      disabled: number(checks.disabled),
      stale: number(checks.stale),
      categories: records(checks.categories).flatMap((item) => {
        const key = String(item.category ?? '');
        if (key !== 'metric' && key !== 'log' && key !== 'probe') return [];
        return [
          {
            key,
            total: number(item.total),
            healthy: number(item.healthy),
            pending: number(item.pending),
            active: number(item.active),
            disabled: number(item.disabled),
            stale: number(item.stale),
          },
        ];
      }),
    },
    incidents: {
      open: number(incidents.open_count),
      critical: number(incidents.critical_count),
      items: records(incidents.items).map((item) => ({
        alertKey: text(item.alert_key, 120),
        title: text(item.title, 160),
        severity: item.severity === 'critical' ? 'critical' : 'warning',
        status: text(item.status, 32),
        summary: text(item.summary, 500),
        firstSeenAt: iso(item.first_seen_at),
        lastSeenAt: iso(item.last_seen_at),
        occurrenceCount: number(item.occurrence_count),
      })),
    },
    errors: {
      totalEvents: number(errors.total_events),
      distinctFingerprints: number(errors.distinct_fingerprints),
      affectedComponents: number(errors.affected_components),
      categories: records(errors.categories).flatMap((item) => {
        const key = String(item.error_category ?? '');
        if (
          key !== 'api' &&
          key !== 'tool' &&
          key !== 'desktop' &&
          key !== 'web' &&
          key !== 'login' &&
          key !== 'process' &&
          key !== 'other'
        ) {
          return [];
        }
        return [
          {
            key,
            count: number(item.event_count),
            fingerprints: number(item.fingerprint_count),
            criticalCount: number(item.critical_count),
          },
        ];
      }),
      items: records(errors.items).map((item) => ({
        component: text(item.component, 100) || 'unknown',
        eventCode: text(item.event_code, 100) || 'unknown',
        count: number(item.event_count),
        fingerprints: number(item.fingerprint_count),
        criticalCount: number(item.critical_count),
        latestAt: iso(item.latest_at),
        summary: text(item.latest_summary, 500),
      })),
    },
    aiRuns: {
      total: aiRunTotal,
      successful: aiRunSuccessful,
      errors: aiRunErrors,
      partials: aiRunPartials,
      successRate: aiRunTotal > 0 ? aiRunSuccessful / aiRunTotal : null,
    },
    notifications: {
      attempts: number(notifications.attempts),
      delivered: number(notifications.delivered),
      failed: number(notifications.failed),
      suppressed: number(notifications.suppressed),
      incidentTransitions: number(notifications.incident_transitions),
      recoveries: number(notifications.recoveries),
    },
  };
}

function formatTime(value: string | null): string {
  if (!value) return '-';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(parsed);
}

function safeMarkdown(value: unknown, maxLength: number): string {
  return text(value, maxLength)
    .replace(/[<>]/g, (character) => (character === '<' ? '‹' : '›'))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Keep operational summaries useful to a human without changing the stored
 * evidence. The digest is often the first place a duty engineer sees a raw
 * provider code, so expand the handful of stable codes we know how to act on.
 */
function humanizeDigestSummary(value: unknown, maxLength: number): string {
  const summary = safeMarkdown(value, maxLength);
  if (!summary) return '';
  if (/local-flash-bridge\.mjs not found/i.test(summary)) {
    return '服务器缺少 local-flash-bridge.mjs（检查生产发布包资源）';
  }
  const localFlashStatus = summary.match(/HTTP\s+(\d{3})\b/i)?.[1];
  if (/local-flash(?:-bridge)?/i.test(summary) && localFlashStatus) {
    return `local-flash bridge 资源异常（HTTP ${localFlashStatus}；检查生产发布包资源）`;
  }
  return summary
    .replace(/\bquota_or_limit\b/gi, '配额或限流')
    .replace(/\bcooldown\b/gi, '冷却中')
    .replace(/\bstandby\b/gi, '备用路由')
    .replace(/\bprimary\b/gi, '主路由')
    .replace(/\bexecution_failed\b/gi, '执行失败')
    .replace(/HTTP\s+402\b/gi, 'HTTP 402（配额/限流）')
    .replace(/备用路由\s+当前/g, '备用路由当前')
    .replace(/主路由\s+冷却中/g, '主路由冷却中')
    .replace(/HTTP 402（配额\/限流）[,，]\s*配额或限流/g, 'HTTP 402（配额/限流）');
}

function formatPercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatDuration(from: string | null, to: string): string {
  const fromMs = Date.parse(String(from ?? ''));
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '-';
  const minutes = Math.max(0, Math.round((toMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function incidentAgeLabel(from: string | null, to: string): string {
  const fromMs = Date.parse(String(from ?? ''));
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '持续时间未知';
  const ageHours = Math.max(0, (toMs - fromMs) / 3_600_000);
  if (ageHours >= 24 * 7) return '长期未恢复';
  if (ageHours >= 24) return '跨日未恢复';
  return '新近事故';
}

function errorCategoryLines(digest: DailyErrorDigest): string[] {
  return digest.errors.categories.map((category) => {
    const share = digest.errors.totalEvents > 0 ? category.count / digest.errors.totalEvents : null;
    return `- **${ERROR_CATEGORY_LABELS[category.key]}** ${category.count} 条（${formatPercent(share)}） · ${category.fingerprints} 指纹${category.criticalCount ? ` · ${category.criticalCount} 严重` : ''}`;
  });
}

function displayErrorComponent(component: string): string {
  const labels: Record<string, string> = {
    'http-api': 'API 服务',
    'agent-tool': 'Agent 工具',
    'server-console': 'Node 进程',
    'client-electron': 'Electron 桌面端',
    'client-web': 'Web 前端',
  };
  const label = labels[component];
  return label && label !== component ? `${label} · ${component}` : component;
}

type DigestPriority = 'P0' | 'P1' | 'P2' | 'OK';

interface DigestTriageItem {
  priority: Exclude<DigestPriority, 'OK'>;
  title: string;
  detail: string;
}

function notificationSuccessRate(digest: DailyErrorDigest): number | null {
  return digest.notifications.attempts > 0
    ? digest.notifications.delivered / digest.notifications.attempts
    : null;
}

function aiRunMetricLine(digest: DailyErrorDigest): string {
  if (digest.aiRuns.total <= 0) return '- AI Run：窗口内无运行记录';
  return `- AI Run：${digest.aiRuns.successful}/${digest.aiRuns.total} 成功（${formatPercent(digest.aiRuns.successRate)}） · ${digest.aiRuns.errors} 失败 · ${digest.aiRuns.partials} 部分完成`;
}

function notificationMetricLine(digest: DailyErrorDigest): string {
  if (digest.notifications.attempts <= 0) return '- 通知：窗口内无投递尝试';
  return `- 通知：${digest.notifications.delivered}/${digest.notifications.attempts} 已投递（${formatPercent(notificationSuccessRate(digest))}） · ${digest.notifications.failed} 失败 · ${digest.notifications.suppressed} 抑制`;
}

function priorityColor(priority: DigestTriageItem['priority']): 'red' | 'orange' | 'blue' {
  return priority === 'P0' ? 'red' : priority === 'P1' ? 'orange' : 'blue';
}

function incidentGuidance(alertKey: string): string {
  if (alertKey === 'moss-model-target-degraded') {
    return '核对退化 Target 的配额、限流和备用路由，确认是否需要人工切换。';
  }
  if (alertKey === 'slo-error-budget-burn') {
    return '下钻失败 Run 与燃烧窗口；证据确认前暂停扩大高风险发布。';
  }
  if (/api|5xx/i.test(alertKey)) {
    return '按接口、版本和时间窗口核对 5xx 代表样本与变更记录。';
  }
  if (/login|sso/i.test(alertKey)) {
    return '区分凭据拒绝与基础设施失败，核对受影响入口和版本。';
  }
  return '打开代表证据，确认影响范围、负责人和下一次更新时间。';
}

function errorClusterGuidance(item: DailyErrorDigest['errors']['items'][number]): string {
  if (/local-flash(?:-bridge)?/i.test(item.summary)) {
    return '补齐生产发布包中的 local-flash-bridge.mjs，重启服务后确认该 5xx 聚类归零。';
  }
  return `打开 ${item.eventCode} 代表样本，核对发生时间与发布版本。`;
}

function buildDigestTriage(digest: DailyErrorDigest): DigestTriageItem[] {
  const items: DigestTriageItem[] = [];
  if (digest.notifications.failed > 0) {
    items.push({
      priority:
        digest.notifications.attempts > 0 && digest.notifications.delivered === 0 ? 'P0' : 'P1',
      title: `${digest.notifications.failed} 次通知投递失败`,
      detail: '先恢复通知链路，避免后续事故无人感知。',
    });
  }
  for (const incident of digest.incidents.items.slice(0, 3)) {
    items.push({
      priority: incident.severity === 'critical' ? 'P0' : 'P1',
      title: incident.title,
      detail: `${incidentGuidance(incident.alertKey).replace(/。$/, '')}；已持续 ${formatDuration(incident.firstSeenAt, digest.generatedAt)}。`,
    });
  }
  const unrepresentedActiveChecks = Math.max(0, digest.checks.active - digest.incidents.open);
  if (unrepresentedActiveChecks > 0 || digest.checks.pending > 0 || digest.checks.stale > 0) {
    const checkProblems = [
      unrepresentedActiveChecks ? `${unrepresentedActiveChecks} 项未归入事故的触发` : '',
      digest.checks.pending ? `${digest.checks.pending} 项 Pending` : '',
      digest.checks.stale ? `${digest.checks.stale} 项数据过期` : '',
    ].filter(Boolean);
    items.push({
      priority: unrepresentedActiveChecks > 0 || digest.checks.stale > 0 ? 'P1' : 'P2',
      title: `巡检异常：${checkProblems.join(' · ')}`,
      detail: digest.checks.stale
        ? `先恢复 ${digest.checks.stale} 项过期数据源，再确认 Pending 和触发状态。`
        : '核对触发规则的代表证据，Pending 项等待连续评估确认。',
    });
  }
  if (digest.aiRuns.total > 0 && (digest.aiRuns.successRate ?? 1) < 0.95) {
    items.push({
      priority: (digest.aiRuns.successRate ?? 1) < 0.9 ? 'P1' : 'P2',
      title: `AI Run 成功率 ${formatPercent(digest.aiRuns.successRate)}`,
      detail: `下钻 ${digest.aiRuns.errors} 个失败和 ${digest.aiRuns.partials} 个部分完成 Run，优先看错误集中模型、工具与版本。`,
    });
  }
  const criticalCluster = digest.errors.items.find((item) => item.criticalCount > 0);
  if (criticalCluster && !items.some((item) => /5xx|API/i.test(item.title))) {
    items.push({
      priority: 'P1',
      title: `${displayErrorComponent(criticalCluster.component)} 出现 ${criticalCluster.criticalCount} 条严重错误`,
      detail: errorClusterGuidance(criticalCluster),
    });
  }
  const priorityRank: Record<DigestTriageItem['priority'], number> = { P0: 0, P1: 1, P2: 2 };
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        priorityRank[left.item.priority] - priorityRank[right.item.priority] ||
        left.index - right.index,
    )
    // Keep a critical error cluster visible even when an incident, notification
    // and AI-run issue already occupy the first four slots.
    .slice(0, 5)
    .map(({ item }) => item);
}

function buildDigestConclusion(digest: DailyErrorDigest): { headline: string; detail: string } {
  const validIncidentStarts = digest.incidents.items
    .map((item) => Date.parse(String(item.firstSeenAt ?? '')))
    .filter(Number.isFinite);
  const oldestIncidentAt = validIncidentStarts.length ? Math.min(...validIncidentStarts) : null;
  const dominantCategory = digest.errors.categories
    .slice()
    .sort((left, right) => right.count - left.count)[0];
  const incidentSummary = digest.incidents.open
    ? `${digest.incidents.open} 个事故未恢复${oldestIncidentAt === null ? '' : `，最长已持续 ${formatDuration(new Date(oldestIncidentAt).toISOString(), digest.generatedAt)}`}`
    : '当前没有进行中事故';
  const details: string[] = [];
  if (dominantCategory && digest.errors.totalEvents > 0) {
    details.push(
      `错误主要集中在 ${ERROR_CATEGORY_LABELS[dominantCategory.key]}（${formatPercent(dominantCategory.count / digest.errors.totalEvents)}）`,
    );
  }
  if (digest.aiRuns.total > 0) {
    details.push(`AI Run 成功率 ${formatPercent(digest.aiRuns.successRate)}`);
  }
  if (!details.length) details.push('当前窗口未发现可操作错误证据');
  return { headline: incidentSummary, detail: `${details.join('；')}。` };
}

function checkIssueLines(digest: DailyErrorDigest): string[] {
  const abnormal = digest.checks.categories.filter(
    (category) => category.active > 0 || category.pending > 0 || category.stale > 0,
  );
  if (!abnormal.length) return ['- 所有已启用巡检均正常'];
  return abnormal.map((category) => {
    const enabled = Math.max(0, category.total - category.disabled);
    return `- **${CHECK_CATEGORY_LABELS[category.key]}** ${category.active} 触发 · ${category.pending} Pending${category.stale ? ` · ${category.stale} 数据过期` : ''} · ${category.healthy}/${enabled} 最近一次正常`;
  });
}

function compactErrorCategoryLines(digest: DailyErrorDigest): string[] {
  return digest.errors.categories.slice(0, 5).map((category) => {
    const share = digest.errors.totalEvents > 0 ? category.count / digest.errors.totalEvents : null;
    return `- **${ERROR_CATEGORY_LABELS[category.key]}** ${formatPercent(share)} · ${category.count} 条 / ${category.fingerprints} 指纹${category.criticalCount ? ` · <font color='red'>${category.criticalCount} 严重</font>` : ''}`;
  });
}

function digestStatus(digest: DailyErrorDigest): {
  label: string;
  emoji: string;
  template: 'red' | 'orange' | 'green';
  priority: DigestPriority;
} {
  if (
    digest.incidents.critical > 0 ||
    (digest.notifications.attempts > 0 && digest.notifications.delivered === 0)
  ) {
    return { label: '立即处理', emoji: '🚨', template: 'red', priority: 'P0' };
  }
  if (
    digest.incidents.open > 0 ||
    digest.checks.active > 0 ||
    digest.checks.pending > 0 ||
    digest.checks.stale > 0 ||
    digest.notifications.failed > 0 ||
    digest.errors.items.some((item) => item.criticalCount > 0) ||
    (digest.aiRuns.total > 0 && (digest.aiRuns.successRate ?? 1) < 0.9)
  ) {
    return { label: '需处理', emoji: '⚠️', template: 'orange', priority: 'P1' };
  }
  if (digest.errors.totalEvents > 0)
    return { label: '持续观察', emoji: '🔎', template: 'orange', priority: 'P2' };
  return { label: '平稳', emoji: '✅', template: 'green', priority: 'OK' };
}

export function buildDailyErrorDigestText(digest: DailyErrorDigest, config: AlertConfig): string {
  const status = digestStatus(digest);
  const conclusion = buildDigestConclusion(digest);
  const triageLines = buildDigestTriage(digest).map(
    (item) =>
      `- ${item.priority} · ${safeMarkdown(item.title, 100)}：${safeMarkdown(item.detail, 220)}`,
  );
  const checkLines = checkIssueLines(digest);
  const categoryLines = errorCategoryLines(digest).slice(0, 5);
  const visibleIncidents = digest.incidents.items.slice(0, 5);
  const hiddenIncidentCount = Math.max(0, digest.incidents.open - visibleIncidents.length);
  const incidentLines = visibleIncidents.length
    ? [
        ...visibleIncidents.map(
          (item) =>
            `- [${item.severity === 'critical' ? '严重' : '警告'} · ${INCIDENT_STATUS_LABELS[item.status] ?? item.status} · ${incidentAgeLabel(item.firstSeenAt, digest.generatedAt)}] ${safeMarkdown(item.title, 80)}：持续 ${formatDuration(item.firstSeenAt, digest.generatedAt)} · 出现 ${item.occurrenceCount} 次 · 最近 ${formatTime(item.lastSeenAt)}；${humanizeDigestSummary(item.summary, 160)}`,
        ),
        ...(hiddenIncidentCount ? [`- 另有 ${hiddenIncidentCount} 个事故，请打开看板查看。`] : []),
      ]
    : ['- 当前无进行中事故'];
  const errorLines = digest.errors.items.length
    ? digest.errors.items
        .slice(0, 8)
        .map(
          (item) =>
            `- ${safeMarkdown(displayErrorComponent(item.component), 72)} · ${safeMarkdown(item.eventCode, 48)}：${item.count} 次 / ${item.fingerprints} 指纹，最近 ${formatTime(item.latestAt)}；${humanizeDigestSummary(item.summary, 150)}`,
        )
    : ['- 最近窗口未发现可操作错误证据'];
  return [
    `${status.emoji} [${config.notification.titlePrefix} · 每日稳定性摘要 · ${status.priority} ${status.label}]`,
    `环境：${config.global.environmentLabel} · 窗口：${formatTime(digest.window.from)} → ${formatTime(digest.window.to)}（${digest.window.hours}h）`,
    `值班结论：${conclusion.headline}；${conclusion.detail}`,
    '',
    '关键指标',
    `- 巡检：${digest.checks.healthy}/${digest.checks.enabled} 最近一次正常 · ${digest.checks.active} 触发 · ${digest.checks.pending} Pending${digest.checks.stale ? ` · ${digest.checks.stale} 数据过期` : ''}${digest.checks.disabled ? ` · ${digest.checks.disabled} 停用` : ''}`,
    aiRunMetricLine(digest),
    `- 错误：${digest.errors.totalEvents} 条 · ${digest.errors.distinctFingerprints} 指纹 · ${digest.errors.affectedComponents} 组件`,
    notificationMetricLine(digest),
    '',
    '建议处置顺序（按优先级）',
    ...(triageLines.length ? triageLines : ['- 当前无待处理动作，继续观察。']),
    '',
    `当前事故（${digest.incidents.open}）`,
    ...incidentLines,
    '',
    '异常巡检',
    ...(checkLines.length ? checkLines : ['- 暂无巡检分类数据']),
    '',
    '错误归类（按来源）',
    ...(categoryLines.length ? categoryLines : ['- 最近窗口无错误分类']),
    '',
    '代表错误聚类',
    ...errorLines,
    '',
    `生成时间：${formatTime(digest.generatedAt)} · 事故流转 ${digest.notifications.incidentTransitions} 次告警 / ${digest.notifications.recoveries} 次恢复`,
    `谛听：${config.notification.dashboardUrl}`,
  ].join('\n');
}

export function buildFeishuDailyErrorDigestCard(
  digest: DailyErrorDigest,
  config: AlertConfig,
): Record<string, unknown> {
  const status = digestStatus(digest);
  const conclusion = buildDigestConclusion(digest);
  const triageContent =
    buildDigestTriage(digest)
      .map(
        (item) =>
          `- <font color='${priorityColor(item.priority)}'>${item.priority}</font> · **${safeMarkdown(item.title, 100)}**\n  ${safeMarkdown(item.detail, 220)}`,
      )
      .join('\n') || '当前无待处理动作，继续观察。';
  const checkContent = checkIssueLines(digest).join('\n');
  const categoryContent = compactErrorCategoryLines(digest).join('\n') || '最近窗口无错误分类。';
  const visibleIncidents = digest.incidents.items.slice(0, 5);
  const hiddenIncidentCount = Math.max(0, digest.incidents.open - visibleIncidents.length);
  const incidentContent = visibleIncidents.length
    ? [
        ...visibleIncidents.map((item) => {
          const ageLabel = incidentAgeLabel(item.firstSeenAt, digest.generatedAt);
          const ageColor = ageLabel === '长期未恢复' ? 'red' : 'orange';
          return `- **${safeMarkdown(item.title, 80)}** · ${item.severity === 'critical' ? "<font color='red'>严重</font>" : "<font color='orange'>警告</font>"} · ${INCIDENT_STATUS_LABELS[item.status] ?? safeMarkdown(item.status, 20)} · <font color='${ageColor}'>${ageLabel}</font>\n  持续 ${formatDuration(item.firstSeenAt, digest.generatedAt)} · 出现 ${item.occurrenceCount} 次 · 最近 ${formatTime(item.lastSeenAt)}\n  ${humanizeDigestSummary(item.summary, 160)}`;
        }),
        ...(hiddenIncidentCount
          ? [`- 另有 ${hiddenIncidentCount} 个事故，请打开故障调查查看。`]
          : []),
      ].join('\n')
    : '当前无进行中事故。';
  const errorContent = digest.errors.items.length
    ? digest.errors.items
        .slice(0, 4)
        .map(
          (item) =>
            `- **${safeMarkdown(displayErrorComponent(item.component), 72)} · ${safeMarkdown(item.eventCode, 48)}** · ${item.count} 次 / ${item.fingerprints} 指纹${item.criticalCount ? ` · <font color='red'>${item.criticalCount} 严重</font>` : ''}\n  最近 ${formatTime(item.latestAt)} · ${humanizeDigestSummary(item.summary, 125)}`,
        )
        .join('\n')
    : '最近窗口未发现可操作错误证据。';
  const dashboardBaseUrl = config.notification.dashboardUrl.replace(/#.*$/, '');
  return {
    config: { wide_screen_mode: true },
    header: {
      template: status.template,
      title: {
        tag: 'plain_text',
        content: `${status.emoji} ${config.notification.titlePrefix} · 每日稳定性摘要 · ${status.priority} ${status.label}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `**值班结论**\n<font color='${status.template === 'red' ? 'red' : status.template === 'orange' ? 'orange' : 'green'}'>${safeMarkdown(conclusion.headline, 160)}</font>\n${safeMarkdown(conclusion.detail, 240)}\n\n**环境** ${safeMarkdown(config.global.environmentLabel, 80)}　|　**窗口** ${formatTime(digest.window.from)} → ${formatTime(digest.window.to)}（${digest.window.hours}h）`,
      },
      {
        tag: 'markdown',
        content: `**关键指标**\n巡检 **${digest.checks.healthy}/${digest.checks.enabled}** 最近一次正常　|　**${digest.checks.active}** 触发　|　**${digest.checks.pending}** Pending${digest.checks.stale ? `　|　**${digest.checks.stale}** 数据过期` : ''}${digest.checks.disabled ? `　|　**${digest.checks.disabled}** 停用` : ''}\n${digest.aiRuns.total > 0 ? `AI Run **${formatPercent(digest.aiRuns.successRate)}**　|　${digest.aiRuns.errors} 失败 / ${digest.aiRuns.partials} 部分完成` : 'AI Run **—**　|　窗口内无运行记录'}\n错误 **${digest.errors.totalEvents}** 条　|　${digest.errors.distinctFingerprints} 指纹 / ${digest.errors.affectedComponents} 组件\n${digest.notifications.attempts > 0 ? `通知 **${formatPercent(notificationSuccessRate(digest))}**　|　${digest.notifications.delivered}/${digest.notifications.attempts} 已投递 · ${digest.notifications.failed} 失败 · ${digest.notifications.suppressed} 抑制` : '通知 **—**　|　窗口内无投递尝试'}`,
      },
      { tag: 'hr' },
      { tag: 'markdown', content: `**建议处置顺序**\n${triageContent}` },
      { tag: 'hr' },
      { tag: 'markdown', content: `**当前事故（${digest.incidents.open}）**\n${incidentContent}` },
      { tag: 'markdown', content: `**异常巡检**\n${checkContent}` },
      { tag: 'hr' },
      { tag: 'markdown', content: `**错误分布**\n${categoryContent}` },
      { tag: 'markdown', content: `**代表错误聚类**\n${errorContent}` },
      {
        tag: 'markdown',
        content: `<font color='grey'>事故流转 ${digest.notifications.incidentTransitions} 次告警 · ${digest.notifications.recoveries} 次恢复\n生成于 ${formatTime(digest.generatedAt)} · 聚合统计与脱敏证据 · 建议不是根因结论 · 处置动作需人工确认</font>`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开事故副驾' },
            type: status.priority === 'P0' || status.priority === 'P1' ? 'primary' : 'default',
            url: `${dashboardBaseUrl}#investigation`,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看 Agent Trace' },
            type: 'default',
            url: `${dashboardBaseUrl}#traces`,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看告警策略' },
            type: 'default',
            url: `${dashboardBaseUrl}#alerts`,
          },
        ],
      },
    ],
  };
}

export async function deliverDailyErrorDigest(
  digest: DailyErrorDigest,
  config: AlertConfig,
): Promise<DailyErrorDigestDelivery> {
  const url = config.notification.feishuWebhookUrl.trim();
  if (!config.notification.enabled) {
    return { delivered: false, channel: 'disabled', attempts: 0, error: 'notification_disabled' };
  }
  if (config.notification.shadowMode) {
    console.log(
      `[error-digest][shadow] checks=${digest.checks.enabled} errors=${digest.errors.totalEvents} incidents=${digest.incidents.open}`,
    );
    return { delivered: false, channel: 'shadow', attempts: 0, error: 'shadow_mode' };
  }
  if (!url) {
    return {
      delivered: false,
      channel: 'unconfigured',
      attempts: 0,
      error: 'feishu_contact_point_not_configured',
    };
  }
  const result = await sendAlertWebhookWithRetry(url, digest, {
    feishuSignSecret: config.notification.feishuSignSecret || undefined,
    forceFeishuFormat: true,
    feishuText: buildDailyErrorDigestText(digest, config),
    feishuCard: buildFeishuDailyErrorDigestCard(digest, config),
    logTag: 'error-digest',
    suppressResponseBodyInLogs: true,
  });
  return {
    delivered: result.delivered,
    channel: 'feishu',
    attempts: result.attempts,
    ...(result.error ? { error: text(result.error, 240) } : {}),
  };
}

async function createPool(): Promise<ErrorDigestPool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  const pgMod = (await import('pg' as string)) as {
    default: { Pool: new (cfg: { connectionString: string; max?: number }) => ErrorDigestPool };
  };
  return new pgMod.default.Pool({ connectionString, max: 2 });
}

export async function runDailyErrorDigest(options?: { dryRun?: boolean }): Promise<{
  digest: DailyErrorDigest;
  delivery: DailyErrorDigestDelivery | null;
}> {
  const config = await loadAlertConfig();
  if (!config.global.enabled) throw new Error('告警评估已停用，日报未执行');
  const p = await createPool();
  try {
    // Preview is strictly read-only so it can be used for production evidence
    // before the timer or any notification delivery is enabled.
    if (!options?.dryRun) {
      await ensureAlertHistorySchema(p as Parameters<typeof ensureAlertHistorySchema>[0]);
    }
    const digest = await collectDailyErrorDigest(p);
    if (options?.dryRun) {
      console.log(JSON.stringify(digest, null, 2));
      return { digest, delivery: null };
    }
    const delivery = await deliverDailyErrorDigest(digest, config);
    const severity = digest.incidents.critical > 0 ? 'critical' : 'warning';
    await p
      .query(
        `insert into public.studio_alert_notifications
           (alert_key, transition, severity, delivered, channel, error, attempt_count)
         values ('daily-error-digest', 'digest', $1, $2, $3, $4, $5)`,
        [severity, delivery.delivered, delivery.channel, delivery.error ?? null, delivery.attempts],
      )
      .catch((error) => {
        console.warn('[error-digest] notification audit failed:', text(error, 240));
      });
    console.log(
      `[error-digest] delivered=${delivery.delivered} attempts=${delivery.attempts} errors=${digest.errors.totalEvents} incidents=${digest.incidents.open}`,
    );
    // Feishu application-level rate limits (11232/11233) are retried with a
    // minute-scale backoff above. If the bounded retry window is still
    // throttled, keep the audit record and let the next scheduled digest retry
    // without turning a notification problem into a new process error.
    const deferredRateLimit = /^feishu_(?:11232|11233)(?:_after_\d+_attempts)?$/.test(
      String(delivery.error ?? ''),
    );
    if (!delivery.delivered && delivery.attempts > 0 && !deferredRateLimit) {
      throw new Error(delivery.error || 'daily_error_digest_delivery_failed');
    }
    return { digest, delivery };
  } finally {
    if (p.end) await p.end().catch(() => {});
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
})();

if (invokedAsScript) {
  installNodeConsoleErrorTelemetry({ component: 'error-digest' });
  runDailyErrorDigest({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    console.error('[error-digest] fatal:', text(error, 500));
    process.exitCode = 1;
  });
}
