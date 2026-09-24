/**
 * ops 事件 → OTLP 日志域增量镜像。
 *
 * 工具调用失败、客户端错误、进程级崩溃等离散错误事件正本在 studio_ops_events
 * （告警/事故域），日志查询与事故根因关联读的是日志域——本镜像按白名单把
 * 错误类事件以 ERROR/WARN 级别补写进 studio_observability_logs，让日志页
 * 能按应用检索工具/客户端错误。
 *
 * 约束：计数型事件（http_5xx、action_list_read、sso_login_attempt 等）是
 * 指标语义，不镜像；created_at 单调游标增量拉取、幂等；归属经凭据注册表
 * 反查（rdkstudio-web → owner 哈希），查不到回退平台自身。
 */
import { insertLogRecords, type NormalizedLogRecord } from '../observability/ai-ecosystem-logs-store.js';

export const MIRROR_EVENT_CODES = [
  'tool_call',
  'client_error',
  'console_error',
  'dependency_unavailable',
  'process_unhandled_error',
  'policy_refresh_failed',
] as const;

const MIRROR_BATCH = 5_000;
const MIRROR_SERVICE = 'rdstudio-web-opt';
const MIRROR_ENVIRONMENT = 'production';
const DEFAULT_OWNER = 'service:d-obs';
const MAX_BODY = 1_000;

function severityFor(outcome: string, hint: string): { text: string; number: number } {
  if (outcome === 'error' || hint === 'critical') return { text: 'ERROR', number: 17 };
  if (hint === 'warning') return { text: 'WARN', number: 13 };
  return { text: 'INFO', number: 9 };
}

export type MirrorableOpsEventRow = {
  occurred_at: Date | string;
  component: unknown;
  event_code: unknown;
  outcome: unknown;
  severity_hint: unknown;
  safe_summary: unknown;
  tenant_id: unknown;
};

export function eventToLogRecord(row: MirrorableOpsEventRow): NormalizedLogRecord | null {
  const summary = String(row.safe_summary ?? '').trim();
  if (!summary) return null;
  const severity = severityFor(String(row.outcome ?? ''), String(row.severity_hint ?? 'warning'));
  const occurredMs = Date.parse(String(row.occurred_at));
  return {
    service: MIRROR_SERVICE,
    environment: MIRROR_ENVIRONMENT,
    severityText: severity.text,
    severityNumber: severity.number,
    body: summary.slice(0, MAX_BODY),
    attributes: {
      'event.code': String(row.event_code ?? '').slice(0, 64),
      'event.component': String(row.component ?? '').slice(0, 64),
      'event.tenant': String(row.tenant_id ?? '').slice(0, 64),
    },
    traceId: null,
    spanId: null,
    timestampMs: Number.isFinite(occurredMs) ? occurredMs : Date.now(),
  };
}

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

async function resolveRdkstudioOwner(pool: Pool): Promise<string> {
  try {
    const result = await pool.query(
      `select owner from public.studio_obs_ingest_tokens
        where subject_id = 'rdkstudio-web' and status = 'active'
        order by created_at desc limit 1`,
    );
    const owner = result.rows[0] ? String(result.rows[0].owner ?? '') : '';
    if (owner) return owner;
  } catch {
    // 注册表不可用时回退平台归属，不阻断镜像。
  }
  return DEFAULT_OWNER;
}

export async function mirrorOpsEventsToLogs(
  pool: Pool,
  cursor: string | null,
  insert: typeof insertLogRecords = insertLogRecords,
): Promise<{ mirrored: number; nextCursor: string | null }> {
  const result = await pool.query(
    `select occurred_at, component, event_code, outcome, severity_hint, safe_summary, tenant_id, created_at
       from public.studio_ops_events
      where event_code = any($1::text[])
        and ($2::timestamptz is null or created_at > $2::timestamptz)
      order by created_at asc
      limit $3`,
    [[...MIRROR_EVENT_CODES], cursor, MIRROR_BATCH],
  );
  if (!result.rows.length) return { mirrored: 0, nextCursor: cursor };
  const owner = await resolveRdkstudioOwner(pool);
  const records = result.rows
    .map((row) => eventToLogRecord(row as MirrorableOpsEventRow))
    .filter((record): record is NormalizedLogRecord => record !== null);
  const mirrored = records.length ? await insert(owner, records) : 0;
  const lastCreated = result.rows[result.rows.length - 1]!.created_at;
  return { mirrored, nextCursor: new Date(String(lastCreated)).toISOString() };
}
