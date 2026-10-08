/**
 * Bounded Agent Run listing for the operations dashboard.
 *
 * The detail reader lives in run-observability-service.ts.  This module only
 * selects the latest low-sensitivity row for each run and issues opaque,
 * short-lived locators.  It deliberately does not select prompts, output,
 * error detail, dispatch JSON, or account identifiers for the response.
 */
import { getPostgresDashboardPool } from '../monitoring/postgres-dashboard-store.js';
import { clientReportedStudioVersion } from '../telemetry-identity.js';
import {
  issueRunLocator,
  issueScopeCursor,
  verifyScopeCursor,
  runDisplayRef,
  scopedDisplayRef,
  type ObservabilityAccessScope,
} from './run-locator.js';
import { projectStudioTraceCoverage } from '../../shared/studio-trace-coverage.js';
import type {
  StudioDeploymentEnvironment,
  StudioTraceCoverage,
  StudioTraceCoverageSegment,
  StudioTraceSurface,
} from '../../shared/studio-observability.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type QueryPool = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };

export const OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE = 'ops-admin';

export interface RunTraceListOptions {
  hours: number;
  environment?: StudioDeploymentEnvironment;
  limit?: number;
  cursor?: string;
  /** Optional exact bounded run-id lookup used by cross-view "查链路" links. */
  runId?: string;
  /** Scope used to verify cursors. Admin listings use a fixed opaque scope. */
  cursorScope?: ObservabilityAccessScope;
  /** Test seam; production always uses the bounded dashboard pool. */
  pool?: QueryPool;
}

export interface RunTraceListRow {
  runRef: string;
  locator: string;
  environment: StudioDeploymentEnvironment;
  startedAt: string | null;
  completedAt: string | null;
  outcome: string;
  elapsedMs: number;
  firstTextMs: number;
  retryCount: number;
  toolCallCount: number;
  toolSequence: string[];
  userRef: string | null;
  sessionRef: string | null;
  deviceRef: string | null;
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  errorCategory: string | null;
  clientType: string | null;
  channel: string | null;
  appVersion: string | null;
  deviceModel: string | null;
  clientSpanCount: number;
  serverSpanCount: number;
  clientDurationMs: number;
  traceCount: number;
  coverage: StudioTraceCoverage & {
    spanCount: number;
    observedSegments: StudioTraceCoverageSegment[];
  };
  producer: {
    surface: StudioTraceSurface;
    studioVersion: string | null;
    mossVersion: string | null;
    mocVersion: string | null;
  };
  evidence: {
    runSummary: boolean;
    operations: number;
    productEvents: number;
  };
}

export interface RunTraceListPage {
  runTraces: RunTraceListRow[];
  runTracePage: {
    environment: StudioDeploymentEnvironment;
    limit: number;
    nextCursor: string | null;
    windowStart: string;
    windowEnd: string;
    snapshotAt: string;
  };
}

export class InvalidTraceCursorError extends Error {
  readonly code = 'invalid_trace_cursor';

  constructor() {
    super('invalid_trace_cursor');
  }
}

const ENVIRONMENTS = new Set<StudioDeploymentEnvironment>([
  'production',
  'staging',
  'development',
  'test',
]);

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function text(value: unknown, max = 160): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const raw = text(value, 64);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function stringArray(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map((item) => text(item, 100))
    .filter(Boolean);
}

// Run ids are UUIDs in the hosted client, but local/self-hosted producers are
// allowed to use a bounded opaque id (for example `local-run-1`). Keep the
// lookup parameter narrow and let the response remain HMAC/AEAD protected.
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function canonicalRunId(value: unknown): string | null {
  const candidate = text(value, 200);
  return RUN_ID_PATTERN.test(candidate) ? candidate : null;
}

interface TraceCoverageAggregate {
  spanCount: number;
  traceCount: number;
  clientSpanCount: number;
  serverSpanCount: number;
  clientDurationMs: number;
  observedSegments: StudioTraceCoverageSegment[];
  hasRunSummary: boolean;
  surface: StudioTraceSurface | null;
  studioVersion: string | null;
  mossVersion: string | null;
  mocVersion: string | null;
}

function emptyTraceCoverageAggregate(): TraceCoverageAggregate {
  return {
    spanCount: 0,
    traceCount: 0,
    clientSpanCount: 0,
    serverSpanCount: 0,
    clientDurationMs: 0,
    observedSegments: [],
    hasRunSummary: false,
    surface: null,
    studioVersion: null,
    mossVersion: null,
    mocVersion: null,
  };
}

function aggregateKey(accountScopeId: string, runId: string): string {
  return `${accountScopeId}\0${runId}`;
}

function mapSurface(value: unknown): StudioTraceSurface | null {
  const candidate = text(value, 32).toLowerCase();
  return ['web-cloud', 'web-self-host', 'desktop', 'local-dev', 'miniapp'].includes(candidate)
    ? (candidate as StudioTraceSurface)
    : null;
}

function safeVersion(value: unknown): string | null {
  const version = clientReportedStudioVersion(value);
  // Unified trace rows default resource versions to 0.0.0 when a producer
  // did not send one. Treat that sentinel as unknown so a valid Run fact
  // app_version can still identify an eligible producer.
  return version === '0.0.0' ? null : version;
}

/**
 * Read trace/summary coverage independently from the run facts.  This is a
 * best-effort projection: a partially migrated database must still return
 * the run list, so callers can retain the summary-only fallback when either
 * optional table is unavailable.
 */
async function readTraceCoverageAggregates(
  pool: QueryPool,
  environmentValue: StudioDeploymentEnvironment,
  windowStart: number,
  windowEnd: number,
  accountScopeIds: string[],
  runIds: string[],
  exactRunId: string | null,
): Promise<Map<string, TraceCoverageAggregate>> {
  const aggregates = new Map<string, TraceCoverageAggregate>();
  if (!accountScopeIds.length || !runIds.length) return aggregates;
  try {
    const result = await pool.query(
      `with wanted(account_scope_id, run_id) as (
             select * from unnest($4::text[], $5::text[])
           )
       select s.account_scope_id, s.run_id,
              count(*)::int span_count,
              count(distinct s.trace_id)::int trace_count,
              count(*) filter (where s.span_kind = 'client')::int client_span_count,
              count(*) filter (where s.span_kind = 'server')::int server_span_count,
              coalesce(sum(greatest(0, s.end_time_ms - s.start_time_ms))
                filter (where s.span_kind = 'client'), 0)::bigint client_duration_ms,
              bool_or(s.source_segment = 'client') has_client,
              bool_or(s.source_segment = 'studio_transport') has_studio_transport,
              bool_or(s.source_segment = 'moss' and s.name = 'moss.session') has_moss_root,
              bool_or(s.source_segment = 'moss' and s.name <> 'moss.session') has_moss_children,
              max(nullif(s.surface, '')) trace_surface,
              max(nullif(s.studio_version, '')) studio_version,
              max(nullif(s.moss_version, '')) moss_version,
              max(nullif(s.moc_version, '')) moc_version
         from public.studio_trace_spans s
         join wanted on wanted.account_scope_id = s.account_scope_id
                   and wanted.run_id = s.run_id
        where s.environment = $1
          and ($6::text is not null or s.start_time_ms >= $2)
          and ($6::text is not null or s.start_time_ms <= $3)
          and coalesce(
            s.governance_expires_at,
            to_timestamp(s.start_time_ms / 1000.0) + interval '35 days'
          ) > now()
          and not exists (
            select 1 from public.studio_telemetry_tombstones tombstone
             where tombstone.account_scope_id = s.account_scope_id
               and tombstone.environment = s.environment
               and (tombstone.user_id is null or tombstone.user_id = s.owner_user_id)
               and (tombstone.run_id is null or tombstone.run_id = s.run_id)
               and (tombstone.trace_id is null or tombstone.trace_id = s.trace_id)
               and (tombstone.session_id is null or tombstone.session_id = s.session_id)
               and tombstone.grant_id is null
          )
        group by s.account_scope_id, s.run_id`,
      [environmentValue, windowStart, windowEnd, accountScopeIds, runIds, exactRunId],
    );
    for (const row of result.rows) {
      const accountScopeId = text(row.account_scope_id, 256);
      const runId = text(row.run_id, 200);
      if (!accountScopeId || !runId) continue;
      const observedSegments: StudioTraceCoverageSegment[] = [];
      if (row.has_client === true) observedSegments.push('client');
      if (row.has_studio_transport === true) observedSegments.push('studio_transport');
      if (row.has_moss_root === true) {
        observedSegments.push('moss_root', 'terminal');
      }
      if (row.has_moss_children === true) observedSegments.push('moss_children');
      aggregates.set(aggregateKey(accountScopeId, runId), {
        spanCount: number(row.span_count),
        traceCount: number(row.trace_count),
        clientSpanCount: number(row.client_span_count),
        serverSpanCount: number(row.server_span_count),
        clientDurationMs: number(row.client_duration_ms),
        observedSegments,
        hasRunSummary: false,
        surface: mapSurface(row.trace_surface),
        studioVersion: safeVersion(row.studio_version),
        mossVersion: safeVersion(row.moss_version),
        mocVersion: safeVersion(row.moc_version),
      });
    }
  } catch {
    // Trace tables are optional during a rolling schema migration. Preserve
    // the run facts and report summary-only coverage in that case.
  }

  try {
    const result = await pool.query(
      `with wanted(account_scope_id, run_id) as (
             select * from unnest($4::text[], $5::text[])
           )
       select o.account_scope_id, o.run_id
         from public.agent_run_observability o
         join wanted on wanted.account_scope_id = o.account_scope_id
                   and wanted.run_id = o.run_id
        where o.environment = $1
          and ($6::text is not null or (
            o.updated_at >= to_timestamp($2::double precision / 1000.0) - interval '35 days'
            and o.updated_at <= to_timestamp($3::double precision / 1000.0)
          ))
          and ($6::text is null or o.updated_at > now() - interval '35 days')
        group by o.account_scope_id, o.run_id`,
      [environmentValue, windowStart, windowEnd, accountScopeIds, runIds, exactRunId],
    );
    for (const row of result.rows) {
      const accountScopeId = text(row.account_scope_id, 256);
      const runId = text(row.run_id, 200);
      if (!accountScopeId || !runId) continue;
      const key = aggregateKey(accountScopeId, runId);
      const aggregate = aggregates.get(key) ?? emptyTraceCoverageAggregate();
      aggregate.hasRunSummary = true;
      aggregates.set(key, aggregate);
    }
  } catch {
    // Summary rows are optional; trace spans can still establish coverage.
  }
  return aggregates;
}

function environment(value: unknown): StudioDeploymentEnvironment {
  const candidate = text(value, 24).toLowerCase() as StudioDeploymentEnvironment;
  return ENVIRONMENTS.has(candidate) ? candidate : 'production';
}

function surface(value: unknown): StudioTraceSurface {
  const candidate = text(value, 32).toLowerCase();
  if (candidate === 'desktop' || candidate === 'electron') return 'desktop';
  if (candidate === 'web-self-host' || candidate === 'self-host') return 'web-self-host';
  if (candidate === 'local-dev') return 'local-dev';
  if (candidate === 'miniapp') return 'miniapp';
  return 'web-cloud';
}

function tieBreaker(accountScopeId: string, runId: string): string {
  return `${accountScopeId.length}:${accountScopeId}:${runId.length}:${runId}`.slice(0, 512);
}

function fallbackPage(
  environmentValue: StudioDeploymentEnvironment,
  limit: number,
  windowStart: number,
  windowEnd: number,
  snapshotAt: number,
): RunTraceListPage {
  return {
    runTraces: [],
    runTracePage: {
      environment: environmentValue,
      limit,
      nextCursor: null,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      snapshotAt: new Date(snapshotAt).toISOString(),
    },
  };
}

/** Read the latest account-scoped row for each run, with no raw identifiers returned. */
export async function getRunTraceList(options: RunTraceListOptions): Promise<RunTraceListPage> {
  const hours = Math.max(1, Math.min(168, Math.floor(Number(options.hours) || 24)));
  const environmentValue = ENVIRONMENTS.has(options.environment ?? 'production')
    ? (options.environment ?? 'production')
    : 'production';
  const limit = Math.max(1, Math.min(80, Math.floor(Number(options.limit) || 40)));
  const cursorScope = options.cursorScope ?? {
    kind: 'administrator',
    selectedAccountScopeId: OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE,
  };
  const now = Date.now();
  let cursor: ReturnType<typeof verifyScopeCursor> = null;
  if (options.cursor) {
    cursor = verifyScopeCursor(options.cursor, cursorScope, environmentValue, now);
    if (!cursor) throw new InvalidTraceCursorError();
  }
  const windowEnd = cursor?.windowEnd ?? now;
  const windowStart = cursor?.windowStart ?? windowEnd - hours * 60 * 60_000;
  const snapshotAt = cursor?.snapshotAt ?? windowEnd;
  const pool = options.pool ?? ((await getPostgresDashboardPool()) as QueryPool);
  const requestedRunId = canonicalRunId(options.runId);

  // `environment` is present on current central rows.  The JSON fallback is
  // retained for older rows created before the explicit column was added.
  const result = await pool.query(
    `with candidates as (
       select r.run_id,
              nullif(trim(r.sso_user_id), '') account_scope_id,
              case
                when coalesce(to_jsonb(r)->>'client_type', '') = 'local-dev' then 'development'
                else coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production')
              end run_environment,
              r.device_id, r.device_model, r.channel, r.outcome,
              r.started_at, r.completed_at, r.elapsed_ms,
              to_jsonb(r)->>'first_text_ms' first_text_ms,
              to_jsonb(r)->>'retry_count' retry_count, r.tool_call_count, r.tool_sequence,
              r.prompt_tokens, r.completion_tokens, r.model,
              to_jsonb(r)->>'error_category' error_category,
              to_jsonb(r)->>'client_type' client_type,
              to_jsonb(r)->>'app_version' app_version,
              nullif(trim(to_jsonb(r)->>'session_id'), '') session_id,
              r.created_at
         from public.agent_run_records r
        where ($8::text is not null or r.started_at >= to_timestamp($1::double precision / 1000.0))
          and ($8::text is not null or r.started_at <= to_timestamp($2::double precision / 1000.0))
          and r.created_at <= to_timestamp($3::double precision / 1000.0)
          and nullif(trim(r.sso_user_id), '') is not null
          and (coalesce(to_jsonb(r)->>'client_type', '') <> 'local-dev' or $4::text = 'development')
          and ($8::text is null or (r.run_id = $8::text and r.started_at > now() - interval '35 days'))
     ), latest as (
       select distinct on (account_scope_id, run_environment, run_id) *
         from candidates
        where run_environment = $4
          and not exists (
            select 1
              from public.studio_telemetry_tombstones tombstone
             where tombstone.account_scope_id = candidates.account_scope_id
               and tombstone.environment = candidates.run_environment
               and (tombstone.user_id is null or tombstone.user_id = candidates.account_scope_id)
               and (tombstone.run_id is null or tombstone.run_id = candidates.run_id)
               and (tombstone.session_id is null or tombstone.session_id = candidates.session_id)
               and tombstone.trace_id is null
               and tombstone.grant_id is null
          )
        order by account_scope_id, run_environment, run_id, created_at desc
     ), keyed as (
       select latest.*,
              floor(extract(epoch from started_at) * 1000)::bigint sort_time_ms,
              length(account_scope_id)::text || ':' || account_scope_id || ':' ||
                length(run_id)::text || ':' || run_id tie_breaker
         from latest
     )
     select * from keyed
      where $5::bigint is null
         or sort_time_ms < $5::bigint
         or (sort_time_ms = $5::bigint and tie_breaker > $6::text)
      order by sort_time_ms desc, tie_breaker
      limit $7::int`,
    [
      windowStart,
      windowEnd,
      snapshotAt,
      environmentValue,
      cursor?.sortTime ?? null,
      cursor?.tieBreaker ?? '',
      limit + 1,
      requestedRunId,
    ],
  );

  const rows = result.rows.slice(0, limit);
  const coverageAggregates = await readTraceCoverageAggregates(
    pool,
    environmentValue,
    windowStart,
    windowEnd,
    rows.map((row) => text(row.account_scope_id, 256)).filter(Boolean),
    rows.map((row) => text(row.run_id, 200)).filter(Boolean),
    requestedRunId,
  );
  const nextRow = rows.at(-1);
  const nextCursor =
    result.rows.length > limit && nextRow
      ? issueScopeCursor({
          accountScopeId:
            cursorScope.kind === 'owner'
              ? cursorScope.accountScopeId
              : OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE,
          environment: environmentValue,
          sortTime: number(nextRow.sort_time_ms),
          tieBreaker: text(nextRow.tie_breaker, 512),
          windowStart,
          windowEnd,
          snapshotAt,
        })
      : null;

  const runTraces: RunTraceListRow[] = rows.flatMap((row) => {
    const accountScopeId = text(row.account_scope_id, 256);
    const runId = text(row.run_id, 200);
    const runEnvironment = environment(row.run_environment);
    if (!accountScopeId || !runId) return [];
    const locator = issueRunLocator({
      accountScopeId,
      environment: runEnvironment,
      runId,
    });
    if (!locator) return [];
    const runRef = runDisplayRef(accountScopeId, runEnvironment, runId);
    const clientType = text(row.client_type, 32) || null;
    const aggregate =
      coverageAggregates.get(aggregateKey(accountScopeId, runId)) ??
      emptyTraceCoverageAggregate();
    const studioVersion = aggregate.studioVersion ?? clientReportedStudioVersion(row.app_version) ?? null;
    const producerSurface = aggregate.surface ?? surface(clientType);
    const observedSegments = aggregate.observedSegments;
    const coverage = projectStudioTraceCoverage({
      surface: producerSurface,
      ...(studioVersion ? { studioVersion } : {}),
      ...(aggregate.mossVersion ? { mossVersion: aggregate.mossVersion } : {}),
      ...(aggregate.mocVersion ? { mocVersion: aggregate.mocVersion } : {}),
      admittedAt: iso(row.started_at) ? Date.parse(String(iso(row.started_at))) : undefined,
      observedSegments,
      hasRunSummary: aggregate.hasRunSummary,
    });
    return [
      {
        runRef,
        locator,
        environment: runEnvironment,
        startedAt: iso(row.started_at),
        completedAt: iso(row.completed_at),
        outcome: text(row.outcome, 40) || 'unknown',
        elapsedMs: number(row.elapsed_ms),
        firstTextMs: number(row.first_text_ms),
        retryCount: number(row.retry_count),
        toolCallCount: number(row.tool_call_count),
        toolSequence: stringArray(row.tool_sequence),
        userRef: scopedDisplayRef('user', accountScopeId, runEnvironment, accountScopeId),
        sessionRef: scopedDisplayRef(
          'session',
          accountScopeId,
          runEnvironment,
          text(row.session_id, 256),
        ),
        deviceRef: scopedDisplayRef(
          'device',
          accountScopeId,
          runEnvironment,
          text(row.device_id, 256),
        ),
        promptTokens: number(row.prompt_tokens),
        completionTokens: number(row.completion_tokens),
        model: text(row.model, 120) || null,
        errorCategory: text(row.error_category, 120) || null,
        clientType,
        channel: text(row.channel, 64) || null,
        appVersion: studioVersion,
        deviceModel: text(row.device_model, 120) || null,
        clientSpanCount: aggregate.clientSpanCount,
        serverSpanCount: aggregate.serverSpanCount,
        clientDurationMs: aggregate.clientDurationMs,
        traceCount: aggregate.traceCount,
        coverage: { ...coverage, spanCount: aggregate.spanCount, observedSegments },
        producer: {
          surface: producerSurface,
          studioVersion,
          mossVersion: aggregate.mossVersion,
          mocVersion: aggregate.mocVersion,
        },
        evidence: { runSummary: aggregate.hasRunSummary, operations: 0, productEvents: 0 },
      },
    ];
  });

  return {
    runTraces,
    runTracePage: {
      environment: environmentValue,
      limit,
      nextCursor,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      snapshotAt: new Date(snapshotAt).toISOString(),
    },
  };
}

export function emptyRunTraceListPage(
  hours: number,
  environmentValue: StudioDeploymentEnvironment = 'production',
): RunTraceListPage {
  const now = Date.now();
  return fallbackPage(
    environmentValue,
    40,
    now - Math.max(1, Math.min(168, Math.floor(Number(hours) || 24))) * 60 * 60_000,
    now,
    now,
  );
}
