/**
 * 自定义策略评估引擎（吸收理想 op-observability 语义，单机 PG 实现同构行为，
 * 不引入 Redis/MQ/XXL-Job）：
 *
 *  - 每轮对启用策略逐规则执行 PromQL 即时查询，逐序列（md5(labels) 为时序身份）
 *    与阈值比较；NaN/±Inf 按 0 处理。
 *  - for 持续时长用 studio_alert_strategy_states 的 first_hit_at 时间戳差值实现：
 *    首次命中记时间戳，持续时长满足才 firing；阈值不再满足即删行。
 *  - 恢复无独立条件：某序列的活跃事故在本轮没有任何命中状态时发 resolved。
 *  - 重复通知按规则行 send_interval_minutes 控制节流（last_notify_at）。
 *  - 无数据告警：查询零序列且规则行开启 no_data_alert 时，按合成序列 'no-data'
 *    处理（value null）。
 *
 * 事故键命名空间与租户约定对齐：platform 策略 = `strat-<sid>-<hash8>`（裸键），
 * 租户策略 = `t.<tenant>.strat-<sid>-<hash8>`（tenantScopeFromAlertKey 可推导）。
 */
import { createHash } from 'node:crypto';
import { ensureStrategyTables, type StrategyPool } from './alert-strategy-store.js';
import type { AlertStrategy, StrategyRuleRow } from './alert-strategy-store.js';
import { listEnabledStrategiesWithRules } from './alert-strategy-store.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import type { AlertSeverity } from './studio-alert-state.js';
import type { AlertDeliveryChannel } from './alert-notification-channels.js';
import type { AlertTransition } from './studio-alert-state.js';

export interface StrategyTransition {
  transition: AlertTransition;
  /** 策略级渠道覆盖：'default' 交回平台默认/分级路由，'none' 由 worker 抑制。 */
  channel?: AlertDeliveryChannel | 'none';
}

interface PromSeries {
  labels: Record<string, string>;
  value: number | null;
}

interface RuleHit {
  rule: StrategyRuleRow;
  seriesKey: string;
  seriesLabels: Record<string, string>;
  value: number | null;
}

const NO_DATA_SERIES_KEY = 'no-data';
const STATE_RETENTION_DAYS = 7;

export function strategyComparatorHolds(
  comparator: string,
  rawValue: number,
  threshold: number,
): boolean {
  // NaN/±Inf 按 0 处理（理想语义）：Prometheus 空值/异常值不做命中豁免。
  const value = Number.isFinite(rawValue) ? rawValue : 0;
  switch (comparator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'ne':
      return value !== threshold;
    default:
      return false;
  }
}

function finiteOrZero(value: number | null): number {
  return value != null && Number.isFinite(value) ? value : 0;
}

function seriesIdentity(labels: Record<string, string>): {
  key: string;
  hash8: string;
} {
  const canonical = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0001');
  const hash = createHash('md5').update(canonical).digest('hex');
  return { key: hash, hash8: hash.slice(0, 8) };
}

export function strategyIncidentKey(
  strategyId: string,
  tenantId: string,
  seriesHash8: string,
): string {
  const base = `strat-${strategyId}-${seriesHash8}`;
  return tenantId === 'platform' ? base : `t.${tenantId}.${base}`;
}

export function comparatorLabel(comparator: string): string {
  const labels: Record<string, string> = {
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    eq: '=',
    ne: '≠',
  };
  return labels[comparator] ?? comparator;
}

/** 渠道覆盖解析：'default'/空 = 交回平台默认与分级路由；写入侧已白名单校验。 */
function resolveStrategyChannel(value: string): AlertDeliveryChannel | 'none' | undefined {
  if (!value || value === 'default') return undefined;
  return value as AlertDeliveryChannel | 'none';
}

function ruleConditionText(rule: StrategyRuleRow): string {
  const duration =
    rule.durationSeconds > 0 ? `持续 ${Math.round(rule.durationSeconds / 60)} 分钟` : '立即';
  return `查询结果 ${comparatorLabel(rule.comparator)} ${rule.threshold}，${duration}`;
}

/** 多序列 PromQL 即时查询；未配置/失败返回 null（调用方按「本轮跳过」处理）。 */
async function promInstantQuerySeries(query: string): Promise<PromSeries[] | null> {
  const base = String(process.env.RDK_PROMETHEUS_QUERY_URL ?? '').trim();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: {
        result?: Array<{ metric?: Record<string, string>; value?: [unknown, string] }>;
      };
    };
    return (payload.data?.result ?? []).map((series) => ({
      labels: series.metric ?? {},
      value: Number(series.value?.[1]),
    }));
  } catch {
    return null;
  }
}

function severityRank(severity: AlertSeverity): number {
  return severity === 'critical' ? 2 : 1;
}

/**
 * 评估全部启用策略并产出投递转换。任何一处数据源/数据库异常都按「本轮跳过」
 * 收敛为空数组，不穿透 worker 主循环。
 */
export async function evaluateStrategies(
  p: StrategyPool,
  checkedAt: Date,
): Promise<StrategyTransition[]> {
  let strategies: AlertStrategy[];
  try {
    strategies = await listEnabledStrategiesWithRules(p);
  } catch (error) {
    console.warn('[strategy-engine] load failed:', sanitizeOpsSummary(error, 200));
    return [];
  }
  if (!strategies.length) return [];
  const at = checkedAt.toISOString();
  const out: StrategyTransition[] = [];

  for (const strategy of strategies) {
    if (!strategy.rules.length) continue;
    try {
      out.push(...(await evaluateOneStrategy(p, strategy, checkedAt)));
    } catch (error) {
      console.warn(
        `[strategy-engine] strategy ${strategy.id} failed:`,
        sanitizeOpsSummary(error, 200),
      );
    }
  }

  // 状态留存清理：一周无命中的序列行不再保留。
  await p
    .query(
      `delete from public.studio_alert_strategy_states
        where last_hit_at < now() - make_interval(days => $1::int)`,
      [STATE_RETENTION_DAYS],
    )
    .catch(() => undefined);
  void at;
  return out;
}

async function evaluateOneStrategy(
  p: StrategyPool,
  strategy: AlertStrategy,
  checkedAt: Date,
): Promise<StrategyTransition[]> {
  const nowMs = checkedAt.getTime();
  const firing = new Map<
    string,
    { hash8: string; labels: Record<string, string>; topRule: StrategyRuleRow; value: number | null }
  >();

  for (const rule of strategy.rules) {
    const seriesList = await promInstantQuerySeries(rule.query);
    if (seriesList == null) continue; // 数据源未配置/查询失败：本轮跳过，不做状态变更
    const hits: RuleHit[] = [];
    if (!seriesList.length) {
      if (rule.noDataAlert) {
        hits.push({
          rule,
          seriesKey: NO_DATA_SERIES_KEY,
          seriesLabels: {},
          value: null,
        });
      }
    } else {
      for (const series of seriesList) {
        const value = finiteOrZero(Number.isFinite(series.value) ? series.value : 0);
        if (!strategyComparatorHolds(rule.comparator, value, rule.threshold)) continue;
        hits.push({ rule, seriesKey: '', seriesLabels: series.labels, value });
      }
    }
    for (const hit of hits) {
      const identity = seriesIdentity(hit.seriesLabels);
      const seriesKey = hit.seriesKey || identity.key;
      hit.seriesKey = seriesKey;
      // 首次命中记 first_hit_at；不再命中即删行（理想 Redis 时间戳语义的 PG 版）。
      const upsert = await p.query(
        `insert into public.studio_alert_strategy_states
           (strategy_id, rule_id, series_key, series_labels, first_hit_at, last_hit_at, last_value)
         values ($1, $2, $3, $4::jsonb, $5, $5, $6)
         on conflict (strategy_id, rule_id, series_key)
           do update set last_hit_at = $5, last_value = $6`,
        [
          strategy.id,
          hit.rule.id,
          seriesKey,
          JSON.stringify(hit.seriesLabels),
          checkedAt,
          hit.value,
        ],
      );
      void upsert;
      const stateRow = await p.query(
        `select first_hit_at from public.studio_alert_strategy_states
          where strategy_id = $1 and rule_id = $2 and series_key = $3`,
        [strategy.id, hit.rule.id, seriesKey],
      );
      const firstHitAt = stateRow.rows[0]?.first_hit_at;
      const firstMs = firstHitAt instanceof Date ? firstHitAt.getTime() : Number.NaN;
      if (!Number.isFinite(firstMs)) continue;
      if (nowMs - firstMs < hit.rule.durationSeconds * 1000) continue;
      const existing = firing.get(seriesKey);
      if (!existing || severityRank(hit.rule.severity) > severityRank(existing.topRule.severity)) {
        firing.set(seriesKey, {
          hash8: identity.hash8,
          labels: hit.seriesLabels,
          topRule: hit.rule,
          value: hit.value,
        });
      }
    }
    // 未命中的既有状态行：删除（恢复语义的一部分）。
    if (seriesList.length || rule.noDataAlert) {
      const keepKeys = hits.map((hit) => hit.seriesKey);
      await p.query(
        `delete from public.studio_alert_strategy_states
          where strategy_id = $1 and rule_id = $2
            and series_key <> all($3::text[])`,
        [strategy.id, rule.id, keepKeys.length ? keepKeys : ['__none__']],
      );
    }
  }

  const transitions: StrategyTransition[] = [];
  const labelSummary = (labels: Record<string, string>): string => {
    const pairs = Object.entries(labels)
      .filter(([key]) => key !== '__name__')
      .slice(0, 4)
      .map(([key, value]) => `${key}=${value}`);
    return pairs.length ? pairs.join(', ') : '无标签序列';
  };

  // 活跃事故清单（本策略前缀）：opened/reminder/resolved 都要对齐它。
  const prefix =
    strategy.tenantId === 'platform'
      ? `strat-${strategy.id}-%`
      : `t.${strategy.tenantId}.strat-${strategy.id}-%`;
  const activeIncidents = await p.query(
    `select alert_key from public.studio_alert_incidents
      where alert_key like $1 and status in ('open','acknowledged','silenced')`,
    [prefix],
  );
  const activeKeys = new Set(activeIncidents.rows.map((row) => String(row.alert_key ?? '')));

  for (const [seriesKey, fire] of firing) {
    const incidentKey = strategyIncidentKey(strategy.id, strategy.tenantId, fire.hash8);
    const stateRow = await p.query(
      `select min(first_hit_at) as first_hit_at, max(last_notify_at) as last_notify_at
         from public.studio_alert_strategy_states
        where strategy_id = $1 and series_key = $2`,
      [strategy.id, seriesKey],
    );
    const firstHitAt = stateRow.rows[0]?.first_hit_at;
    const lastNotifyAt = stateRow.rows[0]?.last_notify_at;
    const lastNotifyMs = lastNotifyAt instanceof Date ? lastNotifyAt.getTime() : 0;
    const intervalMs = fire.topRule.sendIntervalMinutes * 60_000;
    const valueText = fire.value == null ? '无数据' : String(fire.value);
    const title = `${strategy.name}`;
    const summary = `${ruleConditionText(fire.topRule)}：${labelSummary(fire.labels)}，当前值 ${valueText}（级别 ${fire.topRule.severity === 'critical' ? '严重' : '告警'}）`;

    if (!activeKeys.has(incidentKey)) {
      transitions.push({
        transition: {
          kind: 'opened',
          key: incidentKey as AlertTransition['key'],
          title,
          severity: fire.topRule.severity,
          summary,
          at: checkedAt.toISOString(),
          firstSeenAt: firstHitAt instanceof Date ? firstHitAt.toISOString() : undefined,
        },
        channel: resolveStrategyChannel(strategy.notificationChannel),
      });
      await p
        .query(
          `update public.studio_alert_strategy_states
              set last_notify_at = $4
            where strategy_id = $1 and series_key = $2 and rule_id = $3`,
          [strategy.id, seriesKey, fire.topRule.id, checkedAt],
        )
        .catch(() => undefined);
    } else if (intervalMs > 0 && nowMs - lastNotifyMs >= intervalMs) {
      transitions.push({
        transition: {
          kind: 'reminder',
          key: incidentKey as AlertTransition['key'],
          title,
          severity: fire.topRule.severity,
          summary: `持续未恢复，重复提醒：${summary}`,
          at: checkedAt.toISOString(),
        },
        channel: resolveStrategyChannel(strategy.notificationChannel),
      });
      await p
        .query(
          `update public.studio_alert_strategy_states
              set last_notify_at = $4
            where strategy_id = $1 and series_key = $2 and rule_id = $3`,
          [strategy.id, seriesKey, fire.topRule.id, checkedAt],
        )
        .catch(() => undefined);
    }
  }

  // 恢复：活跃事故对应的序列本轮无任何命中状态 → resolved。
  for (const incidentKey of activeKeys) {
    const hash8 = incidentKey.split('-').pop() ?? '';
    const stillFiring = [...firing.values()].some((fire) => fire.hash8 === hash8);
    if (stillFiring) continue;
    transitions.push({
      transition: {
        kind: 'resolved',
        key: incidentKey as AlertTransition['key'],
        title: strategy.name,
        severity: 'warning',
        summary: '策略查询结果已恢复到阈值内，事故自动关闭。',
        at: checkedAt.toISOString(),
      },
      channel: resolveStrategyChannel(strategy.notificationChannel),
    });
  }
  return transitions;
}
