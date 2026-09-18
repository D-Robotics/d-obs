/**
 * 值班升级链：事故通知后超时未确认（ack）→ 自动升级重发。
 *
 * 与人工 reminder 的区别：reminder 是「事故还在」的例行提醒；升级是
 * 「通知发出去 N 分钟没人认领」的责任升级信号（PagerDuty/Grafana OnCall 的
 * escalation 语义）。数据在 incidents 表上扩展两列：last_escalated_at（升级
 * 时间）与 escalation_count（次数），由 worker 每轮推进，不新增投递路径
 * ——升级通知复用 deliverTransition，只是作为一条 escalated transition。
 */
import { sanitizeOpsSummary } from './ops-event-store.js';

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

export const DEFAULT_ACK_TIMEOUT_MINUTES = 15;
export const MAX_ESCALATIONS_PER_INCIDENT = 3;

export interface EscalationCandidate {
  alertKey: string;
  title: string;
  severity: 'warning' | 'critical';
  summary: string;
  firstSeenAt: string;
  escalatedCount: number;
}

function boundedAckTimeout(): number {
  const parsed = Number(process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES);
  return Number.isFinite(parsed)
    ? Math.min(720, Math.max(5, Math.round(parsed)))
    : DEFAULT_ACK_TIMEOUT_MINUTES;
}

/**
 * worker 每轮调用：找出「已通知、未 ack、超时」的 open 事故，标记升级时间
 * 并返回应发出 escalated 通知的候选。resilient 后未 ack 的重发由升级链接管
 * （与 PagerDuty 语义一致：恢复本身止息告警，不需要人手 ack）。
 */
export async function collectEscalationCandidates(
  p: Pool,
  options: { ackTimeoutMinutes?: number; maxEscalations?: number } = {},
): Promise<EscalationCandidate[]> {
  const ackTimeout = options.ackTimeoutMinutes ?? boundedAckTimeout();
  const maxEscalations = options.maxEscalations ?? MAX_ESCALATIONS_PER_INCIDENT;
  const result = await p.query(
    `update public.studio_alert_incidents
     set last_escalated_at = now(),
         escalation_count = coalesce(escalation_count, 0) + 1
     where status = 'open'
       and acknowledged_at is null
       and coalesce(escalation_count, 0) < $1::int
       and last_notified_at is not null
       and last_notified_at < now() - make_interval(mins => $2::int)
       and (last_escalated_at is null or last_escalated_at < now() - make_interval(mins => $2::int))
     returning alert_key, title, severity, summary, first_seen_at,
               coalesce(escalation_count, 1) as escalation_count`,
    [maxEscalations, ackTimeout],
  );
  return result.rows.map((row) => ({
    alertKey: String(row.alert_key),
    title: String(row.title ?? row.alert_key),
    severity: row.severity === 'critical' ? 'critical' : 'warning',
    summary: sanitizeOpsSummary(
      `第 ${Number(row.escalation_count)} 次升级：通知 ${ackTimeout} 分钟无人确认。${String(row.summary ?? '')}`,
      800,
    ),
    firstSeenAt: new Date(row.first_seen_at as string).toISOString(),
    escalatedCount: Number(row.escalation_count),
  }));
}

/** 初始化 incidents 表的升级链列（幂等）。 */
export async function ensureEscalationColumns(p: Pool): Promise<void> {
  await p.query(
    `alter table public.studio_alert_incidents
       add column if not exists last_escalated_at timestamptz null`,
  );
  await p.query(
    `alter table public.studio_alert_incidents
       add column if not exists escalation_count int not null default 0`,
  );
}

export function ackTimeoutMinutes(): number {
  return boundedAckTimeout();
}
