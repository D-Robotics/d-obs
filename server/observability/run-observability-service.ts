import { createHash, createHmac } from 'node:crypto';
import type {
  StudioDeploymentEnvironment,
  StudioNormalizedTraceSpan,
  StudioTraceCoverage,
  StudioTraceCoverageSegment,
  StudioTraceSurface,
} from '../../shared/studio-observability.js';
import { projectStudioTraceCoverage } from '../../shared/studio-trace-coverage.js';
import {
  redactTelemetryPayload,
  sanitizeLowSensitivityAttributes,
} from '../../shared/telemetry-data-governance.js';
import {
  resolveObservabilityLocatorSecret,
  runDisplayRef,
  verifyRunLocator,
  type ObservabilityAccessScope,
} from './run-locator.js';
import {
  PostgresStudioTraceReadAdapter,
  type StudioTraceReadAdapter,
  type TraceReadDb,
  type TraceReadResult,
} from './trace-read-adapter.js';
import { telemetryGovernanceProtectedReadsReady } from './governance-runtime-service.js';

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type RunObservabilityDb = TraceReadDb & {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

export type RunObservabilityAccess = ObservabilityAccessScope & {
  advancedTraceAccess?: boolean;
};

export interface RunObservabilityEvidenceItem {
  source: 'run_fact' | 'run_summary' | 'ops_event' | 'product_event';
  sourceRef: string;
  occurredAt: string | null;
  correlationBasis: 'canonical_run_id';
  availability: 'available';
  kind: string;
  outcome?: string;
  summary?: string;
}

export interface RunObservabilityEvidenceAvailability {
  runFact: 'available';
  runSummary: 'available' | 'missing' | 'unavailable';
  operations: 'available' | 'missing' | 'unavailable';
  productEvents: 'available' | 'missing' | 'unavailable' | 'unsupported';
}

export interface RunObservabilitySpanNode {
  spanRef: string;
  parentSpanRef: string | null;
  name: string;
  kind: StudioNormalizedTraceSpan['kind'];
  startedAt: string;
  startOffsetMs: number;
  durationMs: number;
  service: {
    name: string;
    instanceRef: string;
  };
  mocVersion: string;
  outcome: StudioNormalizedTraceSpan['outcome'];
  status: StudioNormalizedTraceSpan['status'];
  sourceSegment: StudioNormalizedTraceSpan['sourceSegment'];
  attributes: Record<string, string | number | boolean>;
  orphan: boolean;
}

export interface RunObservabilityTraceGroup {
  traceRef: string;
  startedAt: string | null;
  durationMs: number;
  spans: RunObservabilitySpanNode[];
  integrity: Array<{
    code:
      | 'orphan_parent'
      | 'identifier_conflict'
      | 'invalid_timing'
      | 'duplicate_identity'
      | 'topology_cycle';
    spanRef: string;
    parentSpanRef?: string;
  }>;
}

export interface RunObservabilityDetail {
  schema: 'rdk.studio.run-observability.v1';
  run: {
    runRef: string;
    environment: StudioDeploymentEnvironment;
    startedAt: string | null;
    completedAt: string | null;
    outcome: string;
    elapsedMs: number;
    firstTextMs: number;
    retryCount: number;
    toolCallCount: number;
    toolSequence: string[];
    sessionRef: string | null;
    deviceRef: string | null;
    producer: {
      surface: StudioTraceSurface;
      studioVersion: string | null;
      mossVersion: string | null;
      mocVersion: string | null;
    };
  };
  coverage: StudioTraceCoverage & {
    spanCount: number;
    traceCount: number;
    observedSegments: StudioTraceCoverageSegment[];
    truncated: boolean;
  };
  traces: RunObservabilityTraceGroup[];
  summary:
    | { availability: 'available'; value: unknown }
    | { availability: 'missing' | 'unavailable' };
  evidence: {
    availability: RunObservabilityEvidenceAvailability;
    items: RunObservabilityEvidenceItem[];
  };
  advancedExport:
    | { availability: 'not_authorized' | 'not_configured' | 'not_mapped' | 'unavailable' }
    | { availability: 'available'; url: string };
}

export type RunObservabilityLookup =
  | { status: 'found'; detail: RunObservabilityDetail }
  | { status: 'not_found' };

export class RunObservabilityStoreUnavailableError extends Error {
  readonly code = 'run_observability_unavailable';

  constructor() {
    super('run_observability_unavailable');
  }
}

interface RunObservabilityServiceDependencies {
  db: RunObservabilityDb;
  traceAdapter?: StudioTraceReadAdapter;
  now?: () => number;
  protectedReadReady?: () => boolean;
}

const SAFE_SURFACES = new Set<StudioTraceSurface>([
  'web-cloud',
  'web-self-host',
  'desktop',
  'local-dev',
  'miniapp',
]);

function cleanText(value: unknown, max = 160): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const raw = cleanText(value, 64);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function safeStringArray(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => cleanText(item, 80))
    .filter(Boolean);
}

function rowJson(row: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = row?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function refSecret(): string {
  return resolveObservabilityLocatorSecret();
}

function displayRef(
  kind: 'session' | 'device' | 'trace' | 'span' | 'service' | 'evidence',
  scope: { accountScopeId: string; environment: StudioDeploymentEnvironment },
  value: unknown,
): string | null {
  const normalized = cleanText(value, 256);
  if (!normalized) return null;
  const digest = createHmac('sha256', createHash('sha256').update(refSecret()).digest())
    .update(`${kind}\0${scope.accountScopeId}\0${scope.environment}\0${normalized}`)
    .digest('hex')
    .slice(0, 12);
  return `${kind}-${digest}`;
}

function surfaceFrom(
  fact: Record<string, unknown>,
  spans: StudioNormalizedTraceSpan[],
): StudioTraceSurface {
  const fromSpan = spans.find((span) => SAFE_SURFACES.has(span.resource.surface))?.resource.surface;
  if (fromSpan) return fromSpan;
  const explicit = cleanText(fact.surface, 32) as StudioTraceSurface;
  if (SAFE_SURFACES.has(explicit)) return explicit;
  const clientType = cleanText(fact.client_type, 32).toLowerCase();
  if (clientType === 'local-dev') return 'local-dev';
  if (clientType.includes('desktop') || clientType === 'electron') return 'desktop';
  if (clientType.includes('self-host')) return 'web-self-host';
  if (clientType.includes('mini')) return 'miniapp';
  return 'web-cloud';
}

function versionFrom(
  fact: Record<string, unknown>,
  spans: StudioNormalizedTraceSpan[],
  key: 'studioVersion' | 'mossVersion' | 'mocVersion',
): string | null {
  const fromSpan = spans.map((span) => cleanText(span.resource[key], 40)).find(Boolean);
  if (fromSpan) return fromSpan;
  const factKey =
    key === 'studioVersion'
      ? 'app_version'
      : key === 'mossVersion'
        ? 'moss_version'
        : 'moc_version';
  return cleanText(fact[factKey], 40) || null;
}

function observedSegments(spans: StudioNormalizedTraceSpan[]): StudioTraceCoverageSegment[] {
  const observed = new Set<StudioTraceCoverageSegment>();
  for (const span of spans) {
    if (span.sourceSegment === 'client') observed.add('client');
    if (span.sourceSegment === 'studio_transport') observed.add('studio_transport');
    if (span.sourceSegment === 'moss') {
      if (span.name === 'moss.session') {
        observed.add('moss_root');
        observed.add('terminal');
      } else {
        observed.add('moss_children');
      }
    }
  }
  return [...observed];
}

const SAFE_SUMMARY_KEYS = new Set([
  'schema',
  'channel',
  'startedAt',
  'updatedAt',
  'prompt',
  'provider',
  'model',
  'systemPromptHashShort',
  'systemPromptStableHashShort',
  'systemPromptDynamicHashShort',
  'systemPromptLayerCount',
  'effectiveContextTokens',
  'context',
  'decisionSource',
  'decisionReason',
  'delegationMode',
  'workspaceSource',
  'matchedSkills',
  'boardSkillsCount',
  'boardPluginsCount',
  'memoryRefsCount',
  'memoryWriteCount',
  'memoryWriteKinds',
  'memoryWriteOutcome',
  'attachmentsCount',
  'attachmentTypes',
  'runtimeSafeMode',
  'capabilities',
  'registeredTools',
  'tools',
  'sse',
  'approvals',
  'channelDeliveries',
  'completion',
  'capabilityId',
  'layer',
  'available',
  'reason',
  'name',
  'permissionBoundary',
  'uiSurface',
  'toolName',
  'count',
  'errors',
  'executors',
  'permissionBoundaries',
  'uiSurfaces',
  'eventCounts',
  'uiProjectionCounts',
  'uiProjectionByEvent',
  'required',
  'decisions',
  'approved',
  'denied',
  'decisionCounts',
  'byTool',
  'risks',
  'attempts',
  'failures',
  'status',
  'elapsedMs',
  'finalTextChars',
  'stopReason',
  'errorCategory',
  'failedToolNames',
  'identityGuardNeutralized',
  'toolLoopGuardFallback',
]);

function safeSummary(value: unknown): unknown | null {
  const project = (candidate: unknown, depth: number): unknown => {
    if (depth > 5) return undefined;
    if (Array.isArray(candidate)) {
      return candidate
        .slice(0, 24)
        .map((item) => project(item, depth + 1))
        .filter(Boolean);
    }
    if (!candidate || typeof candidate !== 'object') {
      if (typeof candidate === 'boolean') return candidate;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
      if (typeof candidate === 'string') return cleanText(candidate, 160);
      return undefined;
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>).slice(0, 64)) {
      if (!SAFE_SUMMARY_KEYS.has(key)) continue;
      if (key === 'prompt' && (!child || typeof child !== 'object' || Array.isArray(child)))
        continue;
      const projected = project(child, depth + 1);
      if (projected !== undefined) output[key] = projected;
    }
    return output;
  };
  const result = redactTelemetryPayload(project(value, 0), {
    maxDepth: 5,
    maxObjectFields: 64,
    maxArrayItems: 24,
    maxStringBytes: 320,
    maxTotalBytes: 16_384,
  });
  return result.ok ? result.value : null;
}

function mapTraceGroups(
  result: TraceReadResult,
  scope: { accountScopeId: string; environment: StudioDeploymentEnvironment },
): RunObservabilityTraceGroup[] {
  return result.fragments.map((fragment) => {
    const orderedSpans = [...fragment.spans].sort(
      (left, right) =>
        left.startTimeUnixMs - right.startTimeUnixMs ||
        left.endTimeUnixMs - right.endTimeUnixMs ||
        left.spanId.localeCompare(right.spanId),
    );
    const traceRef = displayRef('trace', scope, fragment.traceId) ?? 'trace-unavailable';
    const startedAtMs = orderedSpans.length
      ? Math.min(...orderedSpans.map((span) => span.startTimeUnixMs))
      : 0;
    const endedAtMs = orderedSpans.length
      ? Math.max(...orderedSpans.map((span) => span.endTimeUnixMs))
      : 0;
    const spanRefs = new Map(
      orderedSpans.map((span) => [
        span.spanId,
        displayRef('span', scope, `${fragment.traceId}:${span.spanId}`) ?? 'span-unavailable',
      ]),
    );
    const missingParents = new Set(
      fragment.integrity
        .filter((issue) => issue.code === 'orphan_parent')
        .map((issue) => `${issue.traceId}:${issue.spanId}`),
    );
    return {
      traceRef,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      spans: orderedSpans.map((span) => {
        const sanitizedAttributes = sanitizeLowSensitivityAttributes(span.attributes);
        const attributes = sanitizedAttributes.ok
          ? Object.fromEntries(
              Object.entries(sanitizedAttributes.value).filter(
                ([key]) =>
                  key !== 'moss.run.id' &&
                  key !== 'moss.session.id' &&
                  key !== 'moss.tool.call.id' &&
                  key !== 'rdk.client.operation.id',
              ),
            )
          : {};
        return {
          spanRef: spanRefs.get(span.spanId) ?? 'span-unavailable',
          parentSpanRef: span.parentSpanId
            ? (spanRefs.get(span.parentSpanId) ??
              displayRef('span', scope, `${fragment.traceId}:${span.parentSpanId}`))
            : null,
          name: cleanText(span.name, 100) || 'unknown',
          kind: span.kind,
          startedAt: new Date(span.startTimeUnixMs).toISOString(),
          startOffsetMs: Math.max(0, span.startTimeUnixMs - startedAtMs),
          durationMs: Math.max(0, span.endTimeUnixMs - span.startTimeUnixMs),
          service: {
            name: cleanText(span.resource.serviceName, 80) || 'rdk-studio',
            instanceRef:
              displayRef('service', scope, span.resource.serviceInstanceId) ??
              'service-unavailable',
          },
          mocVersion: cleanText(span.resource.mocVersion, 40) || '0.0.0',
          outcome: span.outcome,
          status: span.status,
          sourceSegment: span.sourceSegment,
          attributes: attributes as Record<string, string | number | boolean>,
          orphan: missingParents.has(`${fragment.traceId}:${span.spanId}`),
        };
      }),
      integrity: fragment.integrity.map((issue) => ({
        code: issue.code,
        spanRef:
          spanRefs.get(issue.spanId) ??
          displayRef('span', scope, `${fragment.traceId}:${issue.spanId}`) ??
          'span-unavailable',
        ...(issue.code === 'orphan_parent'
          ? {
              parentSpanRef:
                displayRef('span', scope, `${fragment.traceId}:${issue.parentSpanId}`) ??
                'span-unavailable',
            }
          : {}),
      })),
    };
  });
}

function safeEvidenceSummary(row: Record<string, unknown>): string | undefined {
  const summary = cleanText(row.safe_summary ?? row.summary, 240);
  if (!summary) return undefined;
  const redacted = redactTelemetryPayload(summary, { maxStringBytes: 240, maxTotalBytes: 512 });
  return redacted.ok && typeof redacted.value === 'string' ? redacted.value : undefined;
}

async function optionalRows(
  db: RunObservabilityDb,
  sql: string,
  params: unknown[],
): Promise<{
  availability: 'available' | 'missing' | 'unavailable';
  rows: Record<string, unknown>[];
}> {
  try {
    const result = await db.query(sql, params);
    return { availability: result.rows.length ? 'available' : 'missing', rows: result.rows };
  } catch {
    return { availability: 'unavailable', rows: [] };
  }
}

function advancedExportConfig(): { origin: URL; projectRef: string } | null {
  const raw = cleanText(process.env.STUDIO_LANGFUSE_TRACE_ORIGIN, 500);
  const projectRef = cleanText(process.env.STUDIO_LANGFUSE_PROJECT_REF, 128);
  const allowedRaw = cleanText(process.env.STUDIO_LANGFUSE_ALLOWED_ORIGINS, 2_000);
  if (!raw || !projectRef || !/^[A-Za-z0-9_-]{1,128}$/.test(projectRef) || !allowedRaw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      return null;
    }
    const allowedOrigins = new Set(
      allowedRaw
        .split(',')
        .map((candidate) => {
          try {
            const allowed = new URL(candidate.trim());
            if (
              allowed.protocol !== 'https:' ||
              allowed.username ||
              allowed.password ||
              allowed.search ||
              allowed.hash ||
              (allowed.pathname !== '/' && allowed.pathname !== '')
            ) {
              return '';
            }
            return allowed.origin;
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    );
    if (!allowedOrigins.has(parsed.origin)) return null;
    return { origin: parsed, projectRef };
  } catch {
    return null;
  }
}

export function createRunObservabilityService(deps: RunObservabilityServiceDependencies) {
  const traceAdapter = deps.traceAdapter ?? new PostgresStudioTraceReadAdapter(deps.db);
  const now = deps.now ?? Date.now;

  return async function getRunObservability(
    locator: unknown,
    accessScope: RunObservabilityAccess,
  ): Promise<RunObservabilityLookup> {
    const verified = verifyRunLocator(locator, accessScope, now());
    if (!verified) return { status: 'not_found' };
    try {
      if (deps.protectedReadReady && !deps.protectedReadReady()) {
        throw new RunObservabilityStoreUnavailableError();
      }
    } catch (error) {
      if (error instanceof RunObservabilityStoreUnavailableError) throw error;
      throw new RunObservabilityStoreUnavailableError();
    }
    const scope = {
      accountScopeId: verified.accountScopeId,
      environment: verified.environment,
    };

    let factResult: QueryResult;
    try {
      factResult = await deps.db.query(
        `select to_jsonb(r) run_fact
         from public.agent_run_records r
         where r.sso_user_id = $1
           and r.run_id = $2
           and r.started_at > now() - interval '35 days'
           and coalesce(
             nullif(to_jsonb(r)->>'environment', ''),
             case when coalesce(r.client_type, '') = 'local-dev' then 'development' else 'production' end
           ) = $3
           and not exists (
             select 1 from public.studio_telemetry_tombstones tombstone
             where tombstone.account_scope_id = $1
               and tombstone.environment = $3
               and (tombstone.user_id is null or tombstone.user_id = r.sso_user_id)
               and (tombstone.run_id is null or tombstone.run_id = r.run_id)
               and (
                 tombstone.session_id is null
                 or tombstone.session_id = to_jsonb(r)->>'session_id'
               )
               and tombstone.trace_id is null
               and tombstone.grant_id is null
           )
         order by r.created_at desc
         limit 1`,
        [scope.accountScopeId, verified.runId, scope.environment],
      );
    } catch {
      throw new RunObservabilityStoreUnavailableError();
    }
    if (!factResult.rows.length) return { status: 'not_found' };
    const fact = rowJson(factResult.rows[0], 'run_fact');

    const [traceSettled, summaryResult, opsResult, productResult, mappingResult] =
      await Promise.all([
        traceAdapter.readByRun(scope, verified.runId).then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
        optionalRows(
          deps.db,
          `select to_jsonb(o) run_summary
         from public.agent_run_observability o
         where o.run_id = $2
           and o.account_scope_id = $1
           and o.environment = $3
           and o.updated_at > now() - interval '35 days'
         order by o.updated_at desc
         limit 1`,
          [scope.accountScopeId, verified.runId, scope.environment],
        ),
        optionalRows(
          deps.db,
          `select id, occurred_at, event_code, outcome, safe_summary
         from public.studio_ops_events
         where correlation->>'run_id' = $2
           and coalesce(correlation->>'account_scope_id', correlation->>'user_id') = $1
           and coalesce(nullif(correlation->>'environment', ''), 'production') = $3
         order by occurred_at asc, id asc
         limit 100`,
          [scope.accountScopeId, verified.runId, scope.environment],
        ),
        optionalRows(
          deps.db,
          `select id, occurred_at, event_name
         from public.product_events p
         where p.authoritative_run_id = $2
           and p.sso_user_id = $1
           and p.environment = $3
         order by occurred_at asc, id asc
         limit 100`,
          [scope.accountScopeId, verified.runId, scope.environment],
        ),
        optionalRows(
          deps.db,
          `select mapping.trace_id, mapping.backend_project_ref, mapping.backend_trace_id
         from public.studio_trace_backend_mappings mapping
         where mapping.account_scope_id = $1
           and mapping.run_id = $2
           and mapping.environment = $3
           and mapping.backend = 'langfuse'
           and mapping.verified = true
           and mapping.tombstoned_at is null
           and mapping.expires_at > now()
           and not exists (
             select 1 from public.studio_telemetry_tombstones tombstone
             where tombstone.account_scope_id = $1
               and tombstone.environment = $3
               and (tombstone.user_id is null or tombstone.user_id = $1)
               and (tombstone.run_id is null or tombstone.run_id = mapping.run_id)
               and (tombstone.trace_id is null or tombstone.trace_id = mapping.trace_id)
                and (tombstone.session_id is null or tombstone.session_id = mapping.session_id)
               and tombstone.grant_id is null
           )
         order by mapping.verified_at desc
         limit 1`,
          [scope.accountScopeId, verified.runId, scope.environment],
        ),
      ]);

    const traceResult: TraceReadResult = traceSettled.ok
      ? traceSettled.value
      : { fragments: [], spanCount: 0, truncated: false };
    const spans = traceResult.fragments.flatMap((fragment) => fragment.spans);
    const surface = surfaceFrom(fact, spans);
    const studioVersion = versionFrom(fact, spans, 'studioVersion');
    const mossVersion = versionFrom(fact, spans, 'mossVersion');
    const mocVersion = versionFrom(fact, spans, 'mocVersion');
    const observed = observedSegments(spans);
    const integrity = traceResult.fragments.flatMap((fragment) => fragment.integrity);
    const spanSamplingDecisions = new Set(spans.map((span) => span.sampling.decision));
    const samplingDecision = spanSamplingDecisions.has('retained')
      ? 'retained'
      : spanSamplingDecisions.has('pending')
        ? 'pending'
        : cleanText(fact.sampling_decision, 24);
    const baseCoverage = projectStudioTraceCoverage({
      surface,
      ...(studioVersion ? { studioVersion } : {}),
      ...(mossVersion ? { mossVersion } : {}),
      ...(mocVersion ? { mocVersion } : {}),
      admittedAt: safeIso(fact.started_at)
        ? Date.parse(String(safeIso(fact.started_at)))
        : undefined,
      now: now(),
      observedSegments: observed,
      hasRunSummary: summaryResult.availability === 'available' && summaryResult.rows.length > 0,
      sampled: samplingDecision === 'dropped' ? false : undefined,
      queryFailed: !traceSettled.ok,
      identifierConflict: integrity.some((issue) => issue.code === 'identifier_conflict'),
      invalidParent: integrity.some((issue) => issue.code === 'orphan_parent'),
      multipleFragments: traceResult.fragments.length > 1,
      duplicateIdentity: integrity.some((issue) => issue.code === 'duplicate_identity'),
      topologyCycle: integrity.some((issue) => issue.code === 'topology_cycle'),
    });

    const runRef = runDisplayRef(scope.accountScopeId, scope.environment, verified.runId);
    const runSummaryRow = summaryResult.rows[0]
      ? rowJson(summaryResult.rows[0], 'run_summary')
      : {};
    const summaryValue = safeSummary(runSummaryRow.summary);
    const summary: RunObservabilityDetail['summary'] =
      summaryResult.availability === 'available' &&
      summaryValue !== null &&
      summaryValue !== undefined
        ? { availability: 'available', value: summaryValue }
        : {
            availability:
              summaryResult.availability === 'available'
                ? 'unavailable'
                : summaryResult.availability,
          };

    const evidence: RunObservabilityEvidenceItem[] = [
      {
        source: 'run_fact',
        sourceRef:
          displayRef('evidence', scope, `${verified.runId}:run-fact`) ?? 'evidence-unavailable',
        occurredAt: safeIso(fact.started_at),
        correlationBasis: 'canonical_run_id',
        availability: 'available',
        kind: 'agent_run',
        outcome: cleanText(fact.outcome, 40) || undefined,
      },
    ];
    if (summary.availability === 'available') {
      evidence.push({
        source: 'run_summary',
        sourceRef:
          displayRef('evidence', scope, `${verified.runId}:run-summary`) ?? 'evidence-unavailable',
        occurredAt: safeIso(runSummaryRow.updated_at),
        correlationBasis: 'canonical_run_id',
        availability: 'available',
        kind: 'run_summary',
      });
    }
    for (const row of opsResult.rows) {
      evidence.push({
        source: 'ops_event',
        sourceRef: displayRef('evidence', scope, row.id) ?? 'evidence-unavailable',
        occurredAt: safeIso(row.occurred_at),
        correlationBasis: 'canonical_run_id',
        availability: 'available',
        kind: cleanText(row.event_code, 80) || 'ops_event',
        outcome: cleanText(row.outcome, 40) || undefined,
        summary: safeEvidenceSummary(row),
      });
    }
    for (const row of productResult.rows) {
      evidence.push({
        source: 'product_event',
        sourceRef: displayRef('evidence', scope, row.id) ?? 'evidence-unavailable',
        occurredAt: safeIso(row.occurred_at),
        correlationBasis: 'canonical_run_id',
        availability: 'available',
        kind: cleanText(row.event_name, 80) || 'product_event',
      });
    }
    evidence.sort(
      (left, right) =>
        String(left.occurredAt ?? '').localeCompare(String(right.occurredAt ?? '')) ||
        left.sourceRef.localeCompare(right.sourceRef),
    );

    let advancedExport: RunObservabilityDetail['advancedExport'];
    if (!accessScope.advancedTraceAccess) {
      advancedExport = { availability: 'not_authorized' };
    } else {
      const advancedConfig = advancedExportConfig();
      const mapping = mappingResult.rows[0];
      if (!advancedConfig) advancedExport = { availability: 'not_configured' };
      else if (mappingResult.availability === 'unavailable') {
        advancedExport = { availability: 'unavailable' };
      } else if (!mapping) {
        advancedExport = { availability: 'not_mapped' };
      } else {
        const backendTraceId = cleanText(mapping.backend_trace_id, 256);
        const backendProjectRef = cleanText(mapping.backend_project_ref, 128);
        if (
          !backendTraceId ||
          !backendProjectRef ||
          backendProjectRef !== advancedConfig.projectRef
        ) {
          advancedExport = { availability: 'not_mapped' };
        } else {
          const url = new URL(
            `/project/${encodeURIComponent(backendProjectRef)}/traces/${encodeURIComponent(backendTraceId)}`,
            advancedConfig.origin.origin,
          );
          advancedExport = { availability: 'available', url: url.toString() };
        }
      }
    }

    return {
      status: 'found',
      detail: {
        schema: 'rdk.studio.run-observability.v1',
        run: {
          runRef,
          environment: scope.environment,
          startedAt: safeIso(fact.started_at),
          completedAt: safeIso(fact.completed_at),
          outcome: cleanText(fact.outcome, 40) || 'unknown',
          elapsedMs: safeNumber(fact.elapsed_ms),
          firstTextMs: safeNumber(fact.first_text_ms),
          retryCount: safeNumber(fact.retry_count),
          toolCallCount: safeNumber(fact.tool_call_count),
          toolSequence: safeStringArray(fact.tool_sequence),
          sessionRef: displayRef('session', scope, fact.session_id),
          deviceRef: displayRef('device', scope, fact.device_id),
          producer: { surface, studioVersion, mossVersion, mocVersion },
        },
        coverage: {
          ...baseCoverage,
          spanCount: traceResult.spanCount,
          traceCount: traceResult.fragments.length,
          observedSegments: observed,
          truncated: traceResult.truncated,
        },
        traces: mapTraceGroups(traceResult, scope),
        summary,
        evidence: {
          availability: {
            runFact: 'available',
            runSummary: summary.availability,
            operations: opsResult.availability,
            productEvents:
              productResult.availability === 'missing' && !productResult.rows.length
                ? 'missing'
                : productResult.availability,
          },
          items: evidence,
        },
        advancedExport,
      },
    };
  };
}

type PgPool = RunObservabilityDb & { end?: () => Promise<void> };
let productionPoolReady: Promise<PgPool> | null = null;

async function productionPool(): Promise<PgPool> {
  const connectionString = cleanText(process.env.RDK_CHAT_CREDITS_DB_URL, 2_048);
  if (!connectionString) throw new RunObservabilityStoreUnavailableError();
  if (!productionPoolReady) {
    productionPoolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (config: { connectionString: string; max: number }) => PgPool };
      };
      return new pgMod.default.Pool({ connectionString, max: 3 });
    })().catch((error) => {
      productionPoolReady = null;
      throw error;
    });
  }
  return productionPoolReady;
}

export async function getRunObservability(
  locator: unknown,
  accessScope: RunObservabilityAccess,
): Promise<RunObservabilityLookup> {
  const db = await productionPool().catch(() => {
    throw new RunObservabilityStoreUnavailableError();
  });
  return createRunObservabilityService({
    db,
    protectedReadReady: telemetryGovernanceProtectedReadsReady,
  })(locator, accessScope);
}