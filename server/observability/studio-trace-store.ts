import { normalizeStudioTraceSpans, type StudioTraceSpan } from '../../shared/studio-tracing.js';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';
import { resolveAiSessionBinding } from '../../shared/ai-observability-semantics.js';
import { ensureUnifiedStudioTraceSchema } from './studio-trace-schema.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = { query: (text: string, params?: unknown[]) => Promise<PgQueryResult>; on?(event: 'error', listener: (error: Error) => void): void; end?(): Promise<void> };

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

export function isStudioTraceStoreConfigured(): boolean {
  return centralDbUrl().length > 0;
}

function validAccountScopeId(value: string | undefined): string | null {
  const accountScopeId = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 256);
  return accountScopeId || null;
}

export function resolveStudioTraceStoreEnvironment(): StudioDeploymentEnvironment {
  const configured = String(process.env.RDK_OBSERVABILITY_ENVIRONMENT ?? '')
    .trim()
    .toLowerCase();
  if (
    configured === 'production' ||
    configured === 'staging' ||
    configured === 'development' ||
    configured === 'test'
  ) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number; connectionTimeoutMillis?: number; statement_timeout?: number; lock_timeout?: number }) => Pool };
      };
      const p = new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 2, connectionTimeoutMillis: 3_000, statement_timeout: 3_000, lock_timeout: 3_000 });
      p.on?.('error', () => console.warn('[studio-trace-store] idle PostgreSQL connection failed'));
      return p;
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

async function ensureSchema(p: Pool): Promise<void> {
  await ensureUnifiedStudioTraceSchema(p);
}

export async function ensureStudioTraceStoreSchema(): Promise<void> {
  if (!isStudioTraceStoreConfigured()) return;
  const p = await pool();
  await ensureSchema(p);
}

export async function persistStudioTraceSpans(input: {
  spans: StudioTraceSpan[];
  ownerUserId: string | null | undefined;
  runId?: string;
  /** Authenticated/producer-declared conversation identity; never inferred from time. */
  sessionId?: string;
  /** Optional authenticated account attribution; defaults to the owner. */
  accountScopeId?: string;
  /** Test seam; production always uses the bounded central pool. */
  pool?: Pool;
  /** A transaction owner has already committed the schema migration before acquiring entity locks. */
  schemaInitialized?: boolean;
}): Promise<boolean> {
  const ownerUserId = String(input.ownerUserId ?? '')
    .trim()
    .slice(0, 256);
  const accountScopeId = validAccountScopeId(input.accountScopeId) ?? ownerUserId;
  const forcedRunId = String(input.runId ?? '')
    .trim()
    .slice(0, 200);
  if (!ownerUserId || !isStudioTraceStoreConfigured()) return false;
  const sessionByIdentity = new Map<string, string | undefined>();
  for (const span of input.spans) {
    const binding = resolveAiSessionBinding(span.attributes, input.sessionId);
    if (binding.conflict) return false;
    const identity = `${span.traceId}:${span.spanId}`;
    if (sessionByIdentity.has(identity) && sessionByIdentity.get(identity) !== binding.sessionId) {
      return false;
    }
    sessionByIdentity.set(identity, binding.sessionId);
  }
  const spans = normalizeStudioTraceSpans(input.spans, {
    ...(forcedRunId ? { runId: forcedRunId } : {}),
  });
  if (!spans.length) return false;
  try {
    const p = input.pool ?? (await pool());
    if (!input.schemaInitialized) await ensureSchema(p);
    const environment = resolveStudioTraceStoreEnvironment();
    const rows = spans.map((span) => ({
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId || null,
      run_id: forcedRunId || span.runId,
      session_id: sessionByIdentity.get(`${span.traceId}:${span.spanId}`) ?? null,
      source: span.source,
      source_segment: span.source === 'client' ? 'client' : 'moss',
      name: span.name,
      start_time_ms: Math.trunc(span.startTime),
      end_time_ms: Math.trunc(span.endTime),
      status: span.status,
      status_message: span.statusMessage || null,
      attributes: span.attributes,
    }));
    const persisted = await p.query(
      `insert into public.studio_trace_spans
         (account_scope_id, environment, trace_id, span_id, parent_span_id, run_id, session_id,
          owner_user_id, source, source_segment, name, start_time_ms, end_time_ms,
          status, status_message, attributes)
       select $1, $2, x.trace_id, x.span_id, x.parent_span_id, x.run_id, x.session_id,
              $3, x.source, x.source_segment, x.name, x.start_time_ms,
              x.end_time_ms, x.status, x.status_message, x.attributes
       from jsonb_to_recordset($4::jsonb) as x(
         trace_id text, span_id text, parent_span_id text, run_id text, session_id text,
         source text, source_segment text, name text, start_time_ms bigint,
         end_time_ms bigint, status text, status_message text, attributes jsonb
       )
       on conflict (account_scope_id, environment, trace_id, span_id) do update set
         session_id = coalesce(public.studio_trace_spans.session_id, excluded.session_id),
         parent_span_id = excluded.parent_span_id,
         start_time_ms = least(public.studio_trace_spans.start_time_ms, excluded.start_time_ms),
         end_time_ms = greatest(public.studio_trace_spans.end_time_ms, excluded.end_time_ms),
         status = case when public.studio_trace_spans.status = 'error' then 'error' else excluded.status end,
         status_message = coalesce(public.studio_trace_spans.status_message, excluded.status_message),
         attributes = public.studio_trace_spans.attributes || excluded.attributes
       where public.studio_trace_spans.owner_user_id = excluded.owner_user_id
         and public.studio_trace_spans.run_id = excluded.run_id
         and (public.studio_trace_spans.session_id is null or excluded.session_id is null
              or public.studio_trace_spans.session_id = excluded.session_id)
         and public.studio_trace_spans.source = excluded.source
         and public.studio_trace_spans.canonical_hash is null
       returning span_id`,
      [accountScopeId, environment, ownerUserId, JSON.stringify(rows)],
    );
    return Number(persisted.rowCount ?? persisted.rows.length) === rows.length;
  } catch (error) {
    if (process.env.RDK_CENTRAL_TELEMETRY_LOG_ERRORS === '1') {
      console.warn(
        '[studio-trace-store] persist failed:',
        error instanceof Error ? error.message : error,
      );
    }
    return false;
  }
}

export async function getStudioTraceSpansForRun(input: {
  runId: string;
  ownerUserId: string;
  environment?: 'production' | 'staging' | 'development' | 'test';
  limit?: number;
  /** Index authority already initialized the dependent trace schema. */
  schemaInitialized?: boolean;
}): Promise<StudioTraceSpan[] | null> {
  const runId = String(input.runId ?? '')
    .trim()
    .slice(0, 200);
  const ownerUserId = String(input.ownerUserId ?? '')
    .trim()
    .slice(0, 256);
  if (!runId || !ownerUserId || !isStudioTraceStoreConfigured()) return null;
  const p = await pool();
  if (!input.schemaInitialized) await ensureSchema(p);
  const environment = input.environment ?? resolveStudioTraceStoreEnvironment();
  const result = await p.query(
    `select trace_id, span_id, parent_span_id, run_id, source, name,
            start_time_ms, end_time_ms, status, status_message, attributes
     from public.studio_trace_spans span
     where span.account_scope_id = $1 and span.environment = $2 and span.run_id = $3
       and coalesce(
         span.governance_expires_at,
         to_timestamp(span.start_time_ms / 1000.0) + interval '35 days'
       ) > now()
       and not exists (
         select 1 from public.studio_telemetry_tombstones tombstone
         where tombstone.account_scope_id = $1
           and tombstone.environment = $2
           and (tombstone.user_id is null or tombstone.user_id = span.owner_user_id)
           and (tombstone.run_id is null or tombstone.run_id = span.run_id)
           and (tombstone.trace_id is null or tombstone.trace_id = span.trace_id)
           and (tombstone.session_id is null or tombstone.session_id = span.session_id)
           and tombstone.grant_id is null
       )
     order by start_time_ms asc, end_time_ms asc
     limit $4`,
    [ownerUserId, environment, runId, Math.max(1, Math.min(256, input.limit ?? 128))],
  );
  const spans = normalizeStudioTraceSpans(
    result.rows.map((row) => ({
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      runId: row.run_id,
      source: row.source,
      name: row.name,
      startTime: Number(row.start_time_ms),
      endTime: Number(row.end_time_ms),
      status: row.status,
      statusMessage: row.status_message,
      attributes: row.attributes,
    })),
    { runId, max: 64 },
  );
  return spans.length ? spans : null;
}


export async function closeStudioTraceStoreForTest(): Promise<void> {
  if (poolReady) await (await poolReady).end?.();
  poolReady = null;
}
