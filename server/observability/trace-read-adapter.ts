import type {
  StudioDeploymentEnvironment,
  StudioNormalizedTraceSpan,
  StudioOtelStatus,
  StudioSamplingDecision,
  StudioTraceOutcome,
  StudioTraceSourceSegment,
} from '../../shared/studio-observability.js';
import { sanitizeLowSensitivityAttributes } from '../../shared/telemetry-data-governance.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type TraceReadDb = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

export interface TraceReadScope {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
}

export type TraceIntegrityIssue =
  | { code: 'orphan_parent'; traceId: string; spanId: string; parentSpanId: string }
  | { code: 'identifier_conflict'; traceId: string; spanId: string }
  | { code: 'invalid_timing'; traceId: string; spanId: string }
  | { code: 'duplicate_identity'; traceId: string; spanId: string }
  | { code: 'topology_cycle'; traceId: string; spanId: string };

export interface TraceReadFragment {
  traceId: string;
  spans: StudioNormalizedTraceSpan[];
  integrity: TraceIntegrityIssue[];
}

export interface TraceReadResult {
  fragments: TraceReadFragment[];
  spanCount: number;
  truncated: boolean;
}

export interface StudioTraceReadAdapter {
  readByRun(scope: TraceReadScope, runId: string, limit?: number): Promise<TraceReadResult>;
  readByTrace(scope: TraceReadScope, traceId: string, limit?: number): Promise<TraceReadResult>;
}

const SAFE_OUTCOMES = new Set<StudioTraceOutcome>([
  'ok',
  'error',
  'cancelled',
  'denied',
  'incomplete',
  'blocked',
  'replayed',
  'suppressed',
]);
const SAFE_STATUSES = new Set<StudioOtelStatus>(['unset', 'ok', 'error']);
const SAFE_SEGMENTS = new Set<StudioTraceSourceSegment>(['client', 'studio_transport', 'moss']);
const SAFE_SAMPLING = new Set<StudioSamplingDecision>(['pending', 'retained', 'dropped']);

function text(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
}

function scalarAttributes(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (typeof raw === 'string') result[text(key, 80)] = text(raw, 160);
    else if (typeof raw === 'number' && Number.isFinite(raw)) result[text(key, 80)] = raw;
    else if (typeof raw === 'boolean') result[text(key, 80)] = raw;
  }
  return result;
}

function mapRows(rows: Array<Record<string, unknown>>, requestedLimit: number): TraceReadResult {
  const issues: TraceIntegrityIssue[] = [];
  const spans: StudioNormalizedTraceSpan[] = [];
  const seenIdentity = new Set<string>();
  for (const row of rows.slice(0, requestedLimit)) {
    const traceId = text(row.trace_id, 32).toLowerCase();
    const spanId = text(row.span_id, 16).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) continue;
    const rawAttributes = scalarAttributes(row.attributes);
    const identity = `${traceId}:${spanId}`;
    if (seenIdentity.has(identity)) {
      issues.push({ code: 'duplicate_identity', traceId, spanId });
      continue;
    }
    seenIdentity.add(identity);
    const sanitizedAttributes = sanitizeLowSensitivityAttributes(rawAttributes);
    const attributes = sanitizedAttributes.ok
      ? (sanitizedAttributes.value as Record<string, string | number | boolean>)
      : {};
    const canonicalRunId = text(row.run_id, 200);
    const mocRunId = text(rawAttributes['moss.run.id'], 200);
    const legacyRunId = text(rawAttributes.runId, 200);
    if (
      (canonicalRunId && mocRunId && canonicalRunId !== mocRunId) ||
      (canonicalRunId && legacyRunId && canonicalRunId !== legacyRunId) ||
      (mocRunId && legacyRunId && mocRunId !== legacyRunId)
    ) {
      issues.push({ code: 'identifier_conflict', traceId, spanId });
    }
    const startTimeUnixMs = Math.trunc(Number(row.start_time_ms));
    const endTimeUnixMs = Math.trunc(Number(row.end_time_ms));
    if (
      !Number.isFinite(startTimeUnixMs) ||
      !Number.isFinite(endTimeUnixMs) ||
      endTimeUnixMs < startTimeUnixMs
    ) {
      issues.push({ code: 'invalid_timing', traceId, spanId });
      continue;
    }
    const sourceCandidate = text(row.source_segment, 32) as StudioTraceSourceSegment;
    const sourceSegment = SAFE_SEGMENTS.has(sourceCandidate)
      ? sourceCandidate
      : row.source === 'client'
        ? 'client'
        : 'moss';
    const outcomeCandidate = text(row.outcome, 24) as StudioTraceOutcome;
    const outcome: StudioTraceOutcome = SAFE_OUTCOMES.has(outcomeCandidate)
      ? outcomeCandidate
      : row.status === 'error'
        ? 'error'
        : 'incomplete';
    const statusCandidate = text(row.otel_status, 16) as StudioOtelStatus;
    const status: StudioOtelStatus = SAFE_STATUSES.has(statusCandidate)
      ? statusCandidate
      : row.status === 'error'
        ? 'error'
        : 'unset';
    const samplingCandidate = text(row.sampling_decision, 16) as StudioSamplingDecision;
    spans.push({
      traceId,
      spanId,
      ...(text(row.parent_span_id, 16) ? { parentSpanId: text(row.parent_span_id, 16) } : {}),
      ...(canonicalRunId || mocRunId || legacyRunId
        ? { runId: canonicalRunId || mocRunId || legacyRunId }
        : {}),
      ...(text(row.session_id, 200) ? { sessionId: text(row.session_id, 200) } : {}),
      ...(text(row.client_operation_id, 200)
        ? { clientOperationId: text(row.client_operation_id, 200) }
        : {}),
      sourceSegment,
      name: text(row.name, 100) || 'unknown',
      kind: row.span_kind === 'client' || row.span_kind === 'server' ? row.span_kind : 'internal',
      startTimeUnixMs,
      endTimeUnixMs,
      outcome,
      status,
      resource: {
        serviceName: text(row.service_name, 80) || 'rdk-studio',
        serviceInstanceId: text(row.service_instance_id, 120) || 'legacy',
        deploymentEnvironment:
          row.resource_environment === 'staging' ||
          row.resource_environment === 'development' ||
          row.resource_environment === 'test'
            ? row.resource_environment
            : 'production',
        surface:
          row.surface === 'desktop' ||
          row.surface === 'web-self-host' ||
          row.surface === 'local-dev' ||
          row.surface === 'miniapp'
            ? row.surface
            : 'web-cloud',
        studioVersion: text(row.studio_version, 40) || '0.0.0',
        mossVersion: text(row.moss_version, 40) || '0.0.0',
        mocVersion: text(row.moc_version, 40) || '0.0.0',
      },
      attributes,
      sampling: {
        decision: SAFE_SAMPLING.has(samplingCandidate) ? samplingCandidate : 'pending',
        policyVersion: text(row.sampling_policy_version, 40) || 'legacy',
        ...(text(row.sampling_reason, 80) ? { reason: text(row.sampling_reason, 80) } : {}),
      },
    });
  }
  spans.sort(
    (left, right) =>
      left.startTimeUnixMs - right.startTimeUnixMs ||
      left.endTimeUnixMs - right.endTimeUnixMs ||
      left.spanId.localeCompare(right.spanId),
  );
  const byTrace = new Map<string, StudioNormalizedTraceSpan[]>();
  for (const span of spans) byTrace.set(span.traceId, [...(byTrace.get(span.traceId) ?? []), span]);
  const fragments = [...byTrace.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([traceId, traceSpans]) => {
      const ids = new Set(traceSpans.map((span) => span.spanId));
      const traceIssues = issues.filter((issue) => issue.traceId === traceId);
      for (const span of traceSpans) {
        if (span.parentSpanId && !ids.has(span.parentSpanId)) {
          traceIssues.push({
            code: 'orphan_parent',
            traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
          });
        }
      }
      const byId = new Map(traceSpans.map((span) => [span.spanId, span]));
      const reportedCycles = new Set<string>();
      for (const span of traceSpans) {
        const path = new Set<string>();
        let current: StudioNormalizedTraceSpan | undefined = span;
        while (current?.parentSpanId && byId.has(current.parentSpanId)) {
          if (path.has(current.spanId)) {
            const cycleKey = [...path].sort().join(':');
            if (!reportedCycles.has(cycleKey)) {
              reportedCycles.add(cycleKey);
              traceIssues.push({ code: 'topology_cycle', traceId, spanId: current.spanId });
            }
            break;
          }
          path.add(current.spanId);
          current = byId.get(current.parentSpanId);
        }
      }
      return { traceId, spans: traceSpans, integrity: traceIssues };
    });
  return { fragments, spanCount: spans.length, truncated: rows.length > requestedLimit };
}

const SELECT_COLUMNS = `
  trace_id, span_id, parent_span_id, run_id, session_id, client_operation_id,
  source, source_segment, name, span_kind, start_time_ms, end_time_ms,
  status, otel_status, outcome, attributes, moc_version, service_name,
  service_instance_id, environment resource_environment, surface,
  studio_version, moss_version, sampling_decision, sampling_policy_version,
  sampling_reason
`;

export class PostgresStudioTraceReadAdapter implements StudioTraceReadAdapter {
  constructor(private readonly db: TraceReadDb) {}

  async readByRun(scope: TraceReadScope, runId: string, limit = 512): Promise<TraceReadResult> {
    const bounded = Math.max(1, Math.min(512, Math.trunc(limit)));
    const result = await this.db.query(
      `select ${SELECT_COLUMNS}
       from public.studio_trace_spans
       where account_scope_id = $1 and environment = $2 and run_id = $3
         and coalesce(
           governance_expires_at,
           to_timestamp(start_time_ms / 1000.0) + interval '35 days'
         ) > now()
         and not exists (
           select 1 from public.studio_telemetry_tombstones tombstone
           where tombstone.account_scope_id = $1
             and tombstone.environment = $2
             and (
               tombstone.user_id is null
               or tombstone.user_id = studio_trace_spans.owner_user_id
             )
             and (tombstone.run_id is null or tombstone.run_id = studio_trace_spans.run_id)
             and (tombstone.trace_id is null or tombstone.trace_id = studio_trace_spans.trace_id)
             and (tombstone.session_id is null or tombstone.session_id = studio_trace_spans.session_id)
             and tombstone.grant_id is null
         )
       order by start_time_ms asc, end_time_ms asc, span_id asc
       limit $4`,
      [scope.accountScopeId, scope.environment, text(runId, 200), bounded + 1],
    );
    return mapRows(result.rows, bounded);
  }

  async readByTrace(scope: TraceReadScope, traceId: string, limit = 512): Promise<TraceReadResult> {
    const bounded = Math.max(1, Math.min(512, Math.trunc(limit)));
    const result = await this.db.query(
      `select ${SELECT_COLUMNS}
       from public.studio_trace_spans
       where account_scope_id = $1 and environment = $2 and trace_id = $3
         and coalesce(
           governance_expires_at,
           to_timestamp(start_time_ms / 1000.0) + interval '35 days'
         ) > now()
         and not exists (
           select 1 from public.studio_telemetry_tombstones tombstone
           where tombstone.account_scope_id = $1
             and tombstone.environment = $2
             and (
               tombstone.user_id is null
               or tombstone.user_id = studio_trace_spans.owner_user_id
             )
             and (tombstone.run_id is null or tombstone.run_id = studio_trace_spans.run_id)
             and (tombstone.trace_id is null or tombstone.trace_id = studio_trace_spans.trace_id)
             and (tombstone.session_id is null or tombstone.session_id = studio_trace_spans.session_id)
             and tombstone.grant_id is null
         )
       order by start_time_ms asc, end_time_ms asc, span_id asc
       limit $4`,
      [scope.accountScopeId, scope.environment, text(traceId, 32).toLowerCase(), bounded + 1],
    );
    return mapRows(result.rows, bounded);
  }
}