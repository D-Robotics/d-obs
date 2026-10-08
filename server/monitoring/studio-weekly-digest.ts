/**
 * 每周运营周报：复用每日稳定性摘要的采集与投递通道，窗口固定 7 天。
 *
 * 周维度增量：事故新开/恢复/仍进行中、MTTR（均值与 p80）、按天分布、
 * 与上一个 7 天窗口的环比。只含聚合计数与低敏摘要，不查询用户正文。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  collectDailyErrorDigest,
  type DailyErrorDigest,
  type ErrorDigestPool,
} from './studio-error-digest.js';
import { loadAlertConfig, type AlertConfig } from './alert-config.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { installNodeConsoleErrorTelemetry } from './node-console-error-telemetry.js';
import { ensureAlertHistorySchema, sendAlertWebhookWithRetry } from './studio-alert-delivery.js';

const WEEKLY_DIGEST_SCHEMA = 'rdk.studio.weekly_digest.v1' as const;
export const WEEKLY_LOOKBACK_HOURS = 168;
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };

export interface WeeklyIncidentAggregate {
  opened: number;
  resolved: number;
  mttrAvgMinutes: number | null;
  mttrP80Minutes: number | null;
  previousOpened: number;
}

export interface WeeklyOpsDigest {
  schema: typeof WEEKLY_DIGEST_SCHEMA;
  generatedAt: string;
  window: DailyErrorDigest['window'];
  weekly: {
    incidents: WeeklyIncidentAggregate;
    dailyHistogram: Array<{ day: string; weekday: string; count: number }>;
  };
  core: DailyErrorDigest;
}

export interface WeeklyOpsDigestDelivery {
  delivered: boolean;
  channel: 'feishu' | 'shadow' | 'unconfigured' | 'disabled';
  attempts: number;
  error?: string;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: 'short',
});
/** en-CA 连字符日期：YYYY-MM-DD，与 SQL to_char(date_trunc(...), 'YYYY-MM-DD') 同构。 */
const DAY_KEY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function shanghaiDayKey(ms: number): string {
  return DAY_KEY_FORMAT.format(ms);
}

function shortDay(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? shanghaiDayKey(parsed).slice(5) : '-';
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

function formatDayRange(from: string, to: string): string {
  return `${shortDay(from)} ~ ${shortDay(to)}`;
}

function formatMinutes(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} 分钟`;
  return `${Math.floor(whole / 60)} 小时 ${whole % 60} 分钟`;
}

function formatPercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`;
}

function safeMarkdown(value: unknown, maxLength: number): string {
  return sanitizeOpsSummary(value, maxLength)
    .replace(/[<>]/g, (character) => (character === '<' ? '‹' : '›'))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * 周窗口内的事故开闭与 MTTR。studio_alert_incidents 以 alert_key 为主键，
 * first_seen_at=首次发生、resolved_at=最近一次恢复（reopen 会清空），
 * 因此「窗口内恢复」以 resolved_at 落窗为准，可能包含此前开启的事故。
 */
async function collectWeeklyIncidents(
  p: ErrorDigestPool,
  windowTo: Date,
  lookbackHours: number,
): Promise<WeeklyIncidentAggregate> {
  const aggregate = async (to: Date): Promise<WeeklyIncidentAggregate> => {
    const result = await p.query(
      `with window_incidents as (
         select first_seen_at, resolved_at
         from public.studio_alert_incidents
         where first_seen_at >= $1::timestamptz - make_interval(hours => $2::int)
            or resolved_at >= $1::timestamptz - make_interval(hours => $2::int)
       )
       select count(*) filter (where first_seen_at >= $1::timestamptz - make_interval(hours => $2::int))::int opened,
              count(*) filter (where resolved_at >= $1::timestamptz - make_interval(hours => $2::int)
                                 and resolved_at <= $1::timestamptz + interval '5 minutes')::int resolved,
              avg(extract(epoch from (resolved_at - first_seen_at)) / 60)
                filter (where resolved_at >= $1::timestamptz - make_interval(hours => $2::int))::double precision mttr_avg,
              percentile_cont(0.8) within group (order by extract(epoch from (resolved_at - first_seen_at)) / 60)
                filter (where resolved_at >= $1::timestamptz - make_interval(hours => $2::int))::double precision mttr_p80
       from window_incidents`,
      [to.toISOString(), lookbackHours],
    );
    const row = result.rows[0] ?? {};
    return {
      opened: number(row.opened),
      resolved: number(row.resolved),
      mttrAvgMinutes: nullableNumber(row.mttr_avg),
      mttrP80Minutes: nullableNumber(row.mttr_p80),
      previousOpened: 0,
    };
  };
  const current = await aggregate(windowTo);
  const previous = await aggregate(
    new Date(windowTo.getTime() - lookbackHours * 60 * 60_000),
  );
  return { ...current, previousOpened: previous.opened };
}

async function collectWeeklyHistogram(
  p: ErrorDigestPool,
  windowTo: Date,
  lookbackHours: number,
): Promise<Array<{ day: string; weekday: string; count: number }>> {
  const result = await p.query(
    `select to_char(date_trunc('day', first_seen_at at time zone $3), 'YYYY-MM-DD') day,
            count(*)::int opened
     from public.studio_alert_incidents
     where first_seen_at >= $1::timestamptz - make_interval(hours => $2::int)
       and first_seen_at <= $1::timestamptz + interval '5 minutes'
     group by 1`,
    [windowTo.toISOString(), lookbackHours, DISPLAY_TIME_ZONE],
  );
  const byDay = new Map<string, number>();
  for (const row of records(result.rows)) {
    byDay.set(String(row.day ?? ''), number(row.opened));
  }
  const toMs = windowTo.getTime();
  const histogram: Array<{ day: string; weekday: string; count: number }> = [];
  for (let index = 6; index >= 0; index -= 1) {
    const dayMs = toMs - index * 24 * 3_600_000;
    const key = shanghaiDayKey(dayMs);
    histogram.push({
      day: key,
      weekday: WEEKDAY_FORMAT.format(dayMs),
      count: byDay.get(key) ?? 0,
    });
  }
  return histogram;
}

export async function collectWeeklyOpsDigest(
  p: ErrorDigestPool,
  options?: { now?: Date },
): Promise<WeeklyOpsDigest> {
  const now = options?.now ?? new Date();
  const core = await collectDailyErrorDigest(p, {
    now,
    lookbackHours: WEEKLY_LOOKBACK_HOURS,
  });
  const [incidents, dailyHistogram] = await Promise.all([
    collectWeeklyIncidents(p, now, WEEKLY_LOOKBACK_HOURS),
    collectWeeklyHistogram(p, now, WEEKLY_LOOKBACK_HOURS),
  ]);
  return {
    schema: WEEKLY_DIGEST_SCHEMA,
    generatedAt: core.generatedAt,
    window: core.window,
    weekly: { incidents, dailyHistogram },
    core,
  };
}

export type WeeklyDigestPriority = 'P0' | 'P1' | 'P2' | 'OK';

export function weeklyDigestStatus(digest: WeeklyOpsDigest): {
  label: string;
  emoji: string;
  template: 'red' | 'orange' | 'green';
  priority: WeeklyDigestPriority;
} {
  const { core } = digest;
  if (
    core.incidents.critical > 0 ||
    (core.notifications.attempts > 0 && core.notifications.delivered === 0)
  ) {
    return { label: '立即处理', emoji: '🚨', template: 'red', priority: 'P0' };
  }
  if (
    core.incidents.open > 0 ||
    digest.weekly.incidents.opened > 0 ||
    core.checks.active > 0 ||
    core.checks.pending > 0 ||
    core.checks.stale > 0 ||
    core.notifications.failed > 0 ||
    core.errors.items.some((item) => item.criticalCount > 0) ||
    (core.aiRuns.total > 0 && (core.aiRuns.successRate ?? 1) < 0.9)
  ) {
    return { label: '需处理', emoji: '⚠️', template: 'orange', priority: 'P1' };
  }
  if (core.errors.totalEvents > 0)
    return { label: '持续观察', emoji: '🔎', template: 'orange', priority: 'P2' };
  return { label: '平稳', emoji: '✅', template: 'green', priority: 'OK' };
}

function trendSuffix(current: number, previous: number): string {
  const delta = current - previous;
  if (delta === 0) return '（环比持平）';
  return delta > 0 ? `（环比 +${delta}）` : `（环比 ${delta}）`;
}

function headlineLine(digest: WeeklyOpsDigest): string {
  const { incidents } = digest.weekly;
  const mttr = incidents.mttrAvgMinutes;
  const parts = [
    `本周新开事故 ${incidents.opened} 起${trendSuffix(incidents.opened, incidents.previousOpened)}`,
    `恢复 ${incidents.resolved} 起`,
    `截至当前进行中 ${digest.core.incidents.open} 起`,
  ];
  if (mttr != null) parts.push(`恢复耗时均值 ${formatMinutes(mttr)}（p80 ${formatMinutes(incidents.mttrP80Minutes)}）`);
  return `${parts.join(' · ')}。`;
}

function histogramLines(digest: WeeklyOpsDigest): string[] {
  return digest.weekly.dailyHistogram.map(
    (entry) =>
      `- ${entry.day}（${entry.weekday}）${'▇'.repeat(Math.min(entry.count, 10)) || '·'} ${entry.count} 起`,
  );
}

function aiRunLine(digest: WeeklyOpsDigest): string {
  const runs = digest.core.aiRuns;
  if (runs.total <= 0) return 'AI Run：窗口内无运行记录';
  return `AI Run：${runs.successful}/${runs.total} 成功（${formatPercent(runs.successRate)}） · ${runs.errors} 失败 · ${runs.partials} 部分完成`;
}

function notificationLine(digest: WeeklyOpsDigest): string {
  const notifications = digest.core.notifications;
  if (notifications.attempts <= 0) return '通知：窗口内无投递尝试';
  return `通知：${notifications.delivered}/${notifications.attempts} 已投递（${formatPercent(notifications.delivered / notifications.attempts)}） · ${notifications.failed} 失败 · ${notifications.suppressed} 抑制`;
}

export function buildWeeklyOpsDigestText(digest: WeeklyOpsDigest, config: AlertConfig): string {
  const status = weeklyDigestStatus(digest);
  const incidentLines = digest.core.incidents.items.length
    ? digest.core.incidents.items
        .slice(0, 5)
        .map(
          (item) =>
            `- [${item.severity === 'critical' ? '严重' : '警告'}] ${safeMarkdown(item.title, 80)}：${safeMarkdown(item.summary, 140)}`,
        )
    : ['- 当前无进行中事故'];
  const errorLines = digest.core.errors.items.length
    ? digest.core.errors.items
        .slice(0, 5)
        .map(
          (item) =>
            `- ${safeMarkdown(item.component, 60)} · ${safeMarkdown(item.eventCode, 40)}：${item.count} 次 / ${item.fingerprints} 指纹`,
        )
    : ['- 窗口内无可操作错误证据'];
  return [
    `${status.emoji} [${config.notification.titlePrefix} · 运营周报 · ${status.priority} ${status.label}]`,
    `环境：${config.global.environmentLabel} · 窗口：${formatDayRange(digest.window.from, digest.window.to)}（7 天）`,
    `本周结论：${headlineLine(digest)}`,
    '',
    '关键指标',
    `- 巡检：${digest.core.checks.healthy}/${digest.core.checks.enabled} 最近一次正常 · ${digest.core.checks.active} 触发 · ${digest.core.checks.pending} Pending`,
    aiRunLine(digest),
    `- 错误：${digest.core.errors.totalEvents} 条 · ${digest.core.errors.distinctFingerprints} 指纹 · ${digest.core.errors.affectedComponents} 组件`,
    notificationLine(digest),
    '',
    '按天事故分布',
    ...histogramLines(digest),
    '',
    '进行中事故',
    ...incidentLines,
    '',
    '错误 Top 聚类',
    ...errorLines,
    '',
    `生成时间：${formatTime(digest.generatedAt)} · 聚合统计与脱敏证据`,
    `谛听：${config.notification.dashboardUrl}`,
  ].join('\n');
}

export function buildFeishuWeeklyOpsDigestCard(
  digest: WeeklyOpsDigest,
  config: AlertConfig,
): Record<string, unknown> {
  const status = weeklyDigestStatus(digest);
  const dashboardBaseUrl = config.notification.dashboardUrl.replace(/#.*$/, '');
  const { incidents } = digest.weekly;
  const incidentContent = digest.core.incidents.items.length
    ? digest.core.incidents.items
        .slice(0, 5)
        .map(
          (item) =>
            `- **${safeMarkdown(item.title, 80)}** · ${item.severity === 'critical' ? "<font color='red'>严重</font>" : "<font color='orange'>警告</font>"}\n  ${safeMarkdown(item.summary, 150)}`,
        )
        .join('\n')
    : '当前无进行中事故。';
  const errorContent = digest.core.errors.items.length
    ? digest.core.errors.items
        .slice(0, 5)
        .map(
          (item) =>
            `- **${safeMarkdown(item.component, 60)} · ${safeMarkdown(item.eventCode, 40)}** · ${item.count} 次 / ${item.fingerprints} 指纹${item.criticalCount ? ` · <font color='red'>${item.criticalCount} 严重</font>` : ''}`,
        )
        .join('\n')
    : '窗口内无可操作错误证据。';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: status.template,
      title: {
        tag: 'plain_text',
        content: `📊 ${config.notification.titlePrefix} · 运营周报（${formatDayRange(digest.window.from, digest.window.to)}） · ${status.priority} ${status.label}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `**本周结论**\n<font color='${status.template}'>${safeMarkdown(headlineLine(digest), 220)}</font>\n\n**环境** ${safeMarkdown(config.global.environmentLabel, 80)}　|　**窗口** ${formatTime(digest.window.from)} → ${formatTime(digest.window.to)}（7 天）`,
      },
      {
        tag: 'markdown',
        content: `**关键指标**\n巡检 **${digest.core.checks.healthy}/${digest.core.checks.enabled}** 最近一次正常　|　**${digest.core.checks.active}** 触发　|　**${digest.core.checks.pending}** Pending\n${digest.core.aiRuns.total > 0 ? `AI Run **${formatPercent(digest.core.aiRuns.successRate)}**　|　${digest.core.aiRuns.errors} 失败 / ${digest.core.aiRuns.partials} 部分完成` : 'AI Run **—**　|　窗口内无运行记录'}\n错误 **${digest.core.errors.totalEvents}** 条　|　${digest.core.errors.distinctFingerprints} 指纹 / ${digest.core.errors.affectedComponents} 组件\n${digest.core.notifications.attempts > 0 ? `通知 **${formatPercent(digest.core.notifications.delivered / digest.core.notifications.attempts)}**　|　${digest.core.notifications.delivered}/${digest.core.notifications.attempts} 已投递` : '通知 **—**　|　窗口内无投递尝试'}`,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**按天事故分布**（本周新开 ${incidents.opened} 起${trendSuffix(incidents.opened, incidents.previousOpened)} · 恢复 ${incidents.resolved} 起${incidents.mttrAvgMinutes != null ? ` · MTTR ${formatMinutes(incidents.mttrAvgMinutes)}` : ''}）\n${histogramLines(digest).join('\n')}`,
      },
      { tag: 'hr' },
      { tag: 'markdown', content: `**进行中事故（${digest.core.incidents.open}）**\n${incidentContent}` },
      { tag: 'markdown', content: `**错误 Top 聚类**\n${errorContent}` },
      {
        tag: 'markdown',
        content: `<font color='grey'>生成于 ${formatTime(digest.generatedAt)} · 聚合统计与脱敏证据 · 建议不是根因结论 · 处置动作需人工确认</font>`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开告警中心' },
            type: status.priority === 'P0' || status.priority === 'P1' ? 'primary' : 'default',
            url: `${dashboardBaseUrl}#alerts`,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '质量与反馈' },
            type: 'default',
            url: `${dashboardBaseUrl}#signals/quality`,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看链路' },
            type: 'default',
            url: `${dashboardBaseUrl}#traces`,
          },
        ],
      },
    ],
  };
}

export async function deliverWeeklyOpsDigest(
  digest: WeeklyOpsDigest,
  config: AlertConfig,
): Promise<WeeklyOpsDigestDelivery> {
  const url = config.notification.feishuWebhookUrl.trim();
  if (!config.notification.enabled) {
    return { delivered: false, channel: 'disabled', attempts: 0, error: 'notification_disabled' };
  }
  if (config.notification.shadowMode) {
    console.log(
      `[weekly-digest][shadow] incidents=${digest.weekly.incidents.opened} errors=${digest.core.errors.totalEvents}`,
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
    feishuText: buildWeeklyOpsDigestText(digest, config),
    feishuCard: buildFeishuWeeklyOpsDigestCard(digest, config),
    logTag: 'weekly-digest',
    suppressResponseBodyInLogs: true,
  });
  return {
    delivered: result.delivered,
    channel: 'feishu',
    attempts: result.attempts,
    ...(result.error ? { error: sanitizeOpsSummary(result.error, 240) } : {}),
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

export async function runWeeklyOpsDigest(options?: { dryRun?: boolean }): Promise<{
  digest: WeeklyOpsDigest;
  delivery: WeeklyOpsDigestDelivery | null;
}> {
  const config = await loadAlertConfig();
  if (!config.global.enabled) throw new Error('告警评估已停用，周报未执行');
  const p = await createPool();
  try {
    if (!options?.dryRun) {
      await ensureAlertHistorySchema(p as Parameters<typeof ensureAlertHistorySchema>[0]);
    }
    const digest = await collectWeeklyOpsDigest(p);
    if (options?.dryRun) {
      console.log(JSON.stringify(digest, null, 2));
      return { digest, delivery: null };
    }
    const delivery = await deliverWeeklyOpsDigest(digest, config);
    const severity = digest.core.incidents.critical > 0 ? 'critical' : 'warning';
    await p
      .query(
        `insert into public.studio_alert_notifications
           (alert_key, transition, severity, delivered, channel, error, attempt_count)
         values ('weekly-ops-digest', 'digest', $1, $2, $3, $4, $5)`,
        [severity, delivery.delivered, delivery.channel, delivery.error ?? null, delivery.attempts],
      )
      .catch((error) => {
        console.warn('[weekly-digest] notification audit failed:', sanitizeOpsSummary(error, 240));
      });
    console.log(
      `[weekly-digest] delivered=${delivery.delivered} attempts=${delivery.attempts} incidents_opened=${digest.weekly.incidents.opened} errors=${digest.core.errors.totalEvents}`,
    );
    const deferredRateLimit = /^feishu_(?:11232|11233)(?:_after_\d+_attempts)?$/.test(
      String(delivery.error ?? ''),
    );
    if (!delivery.delivered && delivery.attempts > 0 && !deferredRateLimit) {
      throw new Error(delivery.error || 'weekly_ops_digest_delivery_failed');
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
  installNodeConsoleErrorTelemetry({ component: 'weekly-digest' });
  runWeeklyOpsDigest({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    console.error('[weekly-digest] fatal:', sanitizeOpsSummary(error, 500));
    process.exitCode = 1;
  });
}
