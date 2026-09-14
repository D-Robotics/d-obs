/**
 * Studio-owned transport, resource, ingestion, and coverage contracts.
 * Canonical Moss span names and attributes remain owned by MOC upstream.
 */

// MossOutcome 原属已删除的旧内置 runtime 包；迁移后内联为 Studio 自有类型。
// 取值与历史 MossOutcome 完全一致（从 server/observability/trace-read-adapter.ts 的
// SAFE_OUTCOMES 反推），保证 trace 数据的读写兼容。
export type StudioTraceOutcome =
  | 'ok'
  | 'error'
  | 'cancelled'
  | 'denied'
  | 'incomplete'
  | 'blocked'
  | 'replayed'
  | 'suppressed';

export const STUDIO_TRACE_BATCH_SCHEMA = 'rdk.studio.trace-batch.v2' as const;
export const STUDIO_AGENT_TRACE_REQUEST_SCHEMA = 'rdk.studio.agent-trace-request.v1' as const;
export const STUDIO_RUN_START_SCHEMA = 'rdk.studio.run-start.v1' as const;
export const STUDIO_CLIENT_OPERATION_SCHEMA = 'rdk.studio.client-operation.v1' as const;
export const STUDIO_TRACE_BATCH_MAX_ITEMS = 128;
export const STUDIO_TRACE_BATCH_MAX_BYTES = 256 * 1024;
export const STUDIO_TRACE_ATTRIBUTE_MAX_COUNT = 32;
export const STUDIO_TRACE_ATTRIBUTE_MAX_LENGTH = 160;
export const STUDIO_TRACE_MAX_DURATION_MS = 24 * 60 * 60_000;
export const STUDIO_TRACE_MAX_PAST_AGE_MS = 35 * 24 * 60 * 60_000;
export const STUDIO_TRACE_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type StudioTraceSurface =
  | 'web-cloud'
  | 'web-self-host'
  | 'desktop'
  | 'local-dev'
  | 'miniapp';

export type StudioDeploymentEnvironment = 'production' | 'staging' | 'development' | 'test';
export type StudioTraceSourceSegment = 'client' | 'studio_transport' | 'moss';
export type StudioTraceSpanKind = 'internal' | 'client' | 'server';
export type StudioOtelStatus = 'unset' | 'ok' | 'error';
export type StudioSamplingDecision = 'pending' | 'retained' | 'dropped';

export type StudioTraceCoverageState = 'complete' | 'partial' | 'summary_only' | 'unavailable';
export type StudioTraceCoverageSegment =
  | 'client'
  | 'studio_transport'
  | 'moss_root'
  | 'moss_children'
  | 'terminal'
  | 'remote_ingestion';
export type StudioTraceCoverageReason =
  | 'legacy'
  | 'unsampled'
  | 'not_received'
  | 'within_grace'
  | 'query_failed'
  | 'export_degraded'
  | 'invalid_parent'
  | 'identifier_conflict'
  | 'multiple_fragments'
  | 'duplicate_identity'
  | 'topology_cycle'
  | 'version_unsupported';

export type StudioTracePropagationReason =
  | 'continued'
  | 'disabled'
  | 'missing'
  | 'malformed'
  | 'zero_identifier'
  | 'unsupported_version'
  | 'untrusted_sampling_ignored';

export type StudioClientCorrelationReason =
  | StudioTracePropagationReason
  | 'missing_run_start'
  | 'invalid_run_start'
  | 'run_start_operation_mismatch'
  | 'run_start_trace_mismatch'
  | 'run_identifier_conflict';

/**
 * The only tracing metadata a Web/Electron renderer may add to an Agent request.
 * Canonical run, account, device, conversation, and analytics identifiers are
 * deliberately not part of this header contract.
 */
export interface StudioAgentTraceRequest {
  schema: typeof STUDIO_AGENT_TRACE_REQUEST_SCHEMA;
  traceparent: string;
  tracestate?: string;
  clientOperationId: string;
}

export interface StudioTracePropagationResult {
  continued: boolean;
  reason: StudioTracePropagationReason;
}

export interface StudioClientOperation {
  schema: typeof STUDIO_CLIENT_OPERATION_SCHEMA;
  clientOperationId: string;
  state: 'provisional' | 'correlated' | 'pre_run_terminal';
  runId?: string;
  correlationReason: StudioClientCorrelationReason;
}

export interface StudioTraceResource {
  serviceName: string;
  serviceInstanceId: string;
  deploymentEnvironment: StudioDeploymentEnvironment;
  surface: StudioTraceSurface;
  studioVersion: string;
  mossVersion: string;
  mocVersion: string;
}

export interface StudioNormalizedTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId?: string;
  sessionId?: string;
  clientOperationId?: string;
  sourceSegment: StudioTraceSourceSegment;
  name: string;
  kind: StudioTraceSpanKind;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  outcome: StudioTraceOutcome;
  status: StudioOtelStatus;
  resource: StudioTraceResource;
  attributes: Record<string, string | number | boolean>;
  sampling: {
    decision: StudioSamplingDecision;
    policyVersion: string;
    reason?: string;
  };
}

export interface StudioTraceBatch {
  schema: typeof STUDIO_TRACE_BATCH_SCHEMA;
  batchId: string;
  producerVersion: string;
  mocVersion: string;
  deviceRef?: string;
  createdAt: number;
  spans: StudioNormalizedTraceSpan[];
}

export interface StudioRunStartSignal {
  schema: typeof STUDIO_RUN_START_SCHEMA;
  runId: string;
  traceId: string;
  serverSpanId: string;
  clientOperationId: string;
  propagation: StudioTracePropagationResult;
}

export interface StudioTraceCoverage {
  state: StudioTraceCoverageState;
  missingSegments: StudioTraceCoverageSegment[];
  reasonCodes: StudioTraceCoverageReason[];
  eligible: boolean;
  surface: StudioTraceSurface;
  studioVersion?: string;
  mossVersion?: string;
  mocVersion?: string;
  graceExpiresAt?: string;
  exportDegraded?: boolean;
}

export type StudioTraceBatchRejection =
  | 'invalid_schema'
  | 'invalid_batch_id'
  | 'invalid_contract_version'
  | 'empty_batch'
  | 'item_limit'
  | 'request_bytes_limit'
  | 'invalid_identifier'
  | 'missing_run_id'
  | 'invalid_timestamp'
  | 'expired'
  | 'future_timestamp'
  | 'duration_limit'
  | 'invalid_resource'
  | 'invalid_source_segment';

export type NormalizeStudioTraceBatchResult =
  | { ok: true; batch: StudioTraceBatch }
  | { ok: false; reason: StudioTraceBatchRejection; itemIndex?: number };

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const BATCH_ID_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const CLIENT_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const PROPAGATION_REASONS = new Set<StudioTracePropagationReason>([
  'continued',
  'missing',
  'malformed',
  'zero_identifier',
  'unsupported_version',
  'untrusted_sampling_ignored',
]);
const SOURCE_SEGMENTS = new Set<StudioTraceSourceSegment>(['client', 'studio_transport', 'moss']);
const SPAN_KINDS = new Set<StudioTraceSpanKind>(['internal', 'client', 'server']);
const OUTCOMES = new Set<StudioTraceOutcome>([
  'ok',
  'error',
  'cancelled',
  'denied',
  'incomplete',
  'blocked',
  'replayed',
  'suppressed',
]);
const STATUSES = new Set<StudioOtelStatus>(['unset', 'ok', 'error']);
const SAMPLING_DECISIONS = new Set<StudioSamplingDecision>(['pending', 'retained', 'dropped']);
const SURFACES = new Set<StudioTraceSurface>([
  'web-cloud',
  'web-self-host',
  'desktop',
  'local-dev',
  'miniapp',
]);
const ENVIRONMENTS = new Set<StudioDeploymentEnvironment>([
  'production',
  'staging',
  'development',
  'test',
]);

// Studio-only and MOC low-sensitivity fields accepted at the remote boundary.
const SAFE_ATTRIBUTE_KEYS = new Set([
  'moss.observability.contract.version',
  'moss.run.id',
  'moss.session.id',
  'moss.turn.index',
  'moss.outcome',
  'moss.error.category',
  'moss.tool.name',
  'moss.tool.call.id',
  'moss.tool.outcome_kind',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  // MOC 1.x dual-write aliases. Reads always prefer the canonical field and
  // report disagreements; these aliases are removed from operator output by
  // the governance projection after the compatibility window.
  'runId',
  'sessionKey',
  'turn',
  'model',
  'inputTokens',
  'outputTokens',
  'toolName',
  'toolCallId',
  'is_error',
  'outcome',
  'outcome_kind',
  'http.request.method',
  'http.response.status_code',
  'rdk.client.operation.id',
  'rdk.propagation.reason',
  'rdk.retry.attempt',
  'rdk.clock.adjusted',
  'rdk.moc.compatibility_drift',
]);

function text(value: unknown, max = STUDIO_TRACE_ATTRIBUTE_MAX_LENGTH): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_RE.test(value) && !/^0+$/.test(value);
}

function validSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID_RE.test(value) && !/^0+$/.test(value);
}

/**
 * Validate the authoritative early SSE correlation signal and return a new,
 * allowlisted object. Extra client/account/analytics fields are never copied.
 */
export function normalizeStudioRunStartSignal(
  value: unknown,
  options: { expectedClientOperationId?: string; expectedTraceId?: string } = {},
): StudioRunStartSignal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== STUDIO_RUN_START_SCHEMA) return null;
  const runId = text(raw.runId, 200);
  const traceId = text(raw.traceId, 32).toLowerCase();
  const serverSpanId = text(raw.serverSpanId, 16).toLowerCase();
  const clientOperationId = text(raw.clientOperationId, 120);
  if (
    !OPAQUE_ID_RE.test(runId) ||
    !validTraceId(traceId) ||
    !validSpanId(serverSpanId) ||
    !CLIENT_OPERATION_ID_RE.test(clientOperationId) ||
    runId === clientOperationId
  ) {
    return null;
  }
  if (
    options.expectedClientOperationId &&
    clientOperationId !== options.expectedClientOperationId
  ) {
    return null;
  }
  const propagationRaw =
    raw.propagation && typeof raw.propagation === 'object' && !Array.isArray(raw.propagation)
      ? (raw.propagation as Record<string, unknown>)
      : null;
  if (!propagationRaw || typeof propagationRaw.continued !== 'boolean') return null;
  const reason = text(propagationRaw.reason, 40) as StudioTracePropagationReason;
  if (!PROPAGATION_REASONS.has(reason)) return null;
  const continuedReason = reason === 'continued' || reason === 'untrusted_sampling_ignored';
  if (propagationRaw.continued !== continuedReason) return null;
  if (propagationRaw.continued && options.expectedTraceId && traceId !== options.expectedTraceId) {
    return null;
  }
  return {
    schema: STUDIO_RUN_START_SCHEMA,
    runId,
    traceId,
    serverSpanId,
    clientOperationId,
    propagation: { continued: propagationRaw.continued, reason },
  };
}

export function isStudioRunStartSignal(value: unknown): value is StudioRunStartSignal {
  return normalizeStudioRunStartSignal(value) !== null;
}

function normalizeResource(value: unknown): StudioTraceResource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const serviceName = text(raw.serviceName, 80);
  const serviceInstanceId = text(raw.serviceInstanceId, 120);
  const deploymentEnvironment = text(raw.deploymentEnvironment, 32) as StudioDeploymentEnvironment;
  const surface = text(raw.surface, 32) as StudioTraceSurface;
  const studioVersion = text(raw.studioVersion, 40);
  const mossVersion = text(raw.mossVersion, 40);
  const mocVersion = text(raw.mocVersion, 40);
  if (
    !serviceName ||
    !serviceInstanceId ||
    !ENVIRONMENTS.has(deploymentEnvironment) ||
    !SURFACES.has(surface) ||
    !VERSION_RE.test(studioVersion) ||
    !VERSION_RE.test(mossVersion) ||
    !VERSION_RE.test(mocVersion)
  ) {
    return null;
  }
  return {
    serviceName,
    serviceInstanceId,
    deploymentEnvironment,
    surface,
    studioVersion,
    mossVersion,
    mocVersion,
  };
}

function normalizeSafeAttributes(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(
    0,
    STUDIO_TRACE_ATTRIBUTE_MAX_COUNT,
  )) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof raw === 'string') {
      const normalized = text(raw);
      if (normalized) result[key] = normalized;
    } else if (typeof raw === 'boolean') {
      result[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      result[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, raw));
    }
  }
  return result;
}

/** Normalize untrusted transport input without accepting account or authorization fields. */
export function normalizeStudioTraceBatch(
  value: unknown,
  options: { now?: number; requestBytes?: number; supportedMocMajor?: number } = {},
): NormalizeStudioTraceBatchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== STUDIO_TRACE_BATCH_SCHEMA) return { ok: false, reason: 'invalid_schema' };
  const requestBytes = Number(options.requestBytes ?? JSON.stringify(value).length);
  if (!Number.isFinite(requestBytes) || requestBytes > STUDIO_TRACE_BATCH_MAX_BYTES) {
    return { ok: false, reason: 'request_bytes_limit' };
  }
  const batchId = text(raw.batchId, 64).toLowerCase();
  if (!BATCH_ID_RE.test(batchId)) return { ok: false, reason: 'invalid_batch_id' };
  const mocVersion = text(raw.mocVersion, 40);
  if (!VERSION_RE.test(mocVersion)) return { ok: false, reason: 'invalid_contract_version' };
  if (
    options.supportedMocMajor !== undefined &&
    Number(mocVersion.split('.')[0]) !== options.supportedMocMajor
  ) {
    return { ok: false, reason: 'invalid_contract_version' };
  }
  if (!Array.isArray(raw.spans) || raw.spans.length === 0) {
    return { ok: false, reason: 'empty_batch' };
  }
  if (raw.spans.length > STUDIO_TRACE_BATCH_MAX_ITEMS) {
    return { ok: false, reason: 'item_limit' };
  }

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const spans: StudioNormalizedTraceSpan[] = [];
  for (const [itemIndex, candidate] of raw.spans.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, reason: 'invalid_identifier', itemIndex };
    }
    const span = candidate as Record<string, unknown>;
    const traceId = text(span.traceId, 32).toLowerCase();
    const spanId = text(span.spanId, 16).toLowerCase();
    const parentSpanId = text(span.parentSpanId, 16).toLowerCase();
    if (
      !validTraceId(traceId) ||
      !validSpanId(spanId) ||
      (parentSpanId && !validSpanId(parentSpanId))
    ) {
      return { ok: false, reason: 'invalid_identifier', itemIndex };
    }
    const sourceSegment = text(span.sourceSegment, 32) as StudioTraceSourceSegment;
    if (!SOURCE_SEGMENTS.has(sourceSegment)) {
      return { ok: false, reason: 'invalid_source_segment', itemIndex };
    }
    const runId = text(span.runId, 200);
    if (!runId && sourceSegment !== 'client') {
      return { ok: false, reason: 'missing_run_id', itemIndex };
    }
    const sessionId = text(span.sessionId, 200);
    const clientOperationId = text(span.clientOperationId, 200);
    if (
      (runId && !OPAQUE_ID_RE.test(runId)) ||
      (sessionId && !OPAQUE_ID_RE.test(sessionId)) ||
      (clientOperationId && !OPAQUE_ID_RE.test(clientOperationId))
    ) {
      return { ok: false, reason: 'invalid_identifier', itemIndex };
    }
    const startTimeUnixMs = Math.trunc(Number(span.startTimeUnixMs));
    const endTimeUnixMs = Math.trunc(Number(span.endTimeUnixMs));
    if (!Number.isFinite(startTimeUnixMs) || !Number.isFinite(endTimeUnixMs)) {
      return { ok: false, reason: 'invalid_timestamp', itemIndex };
    }
    if (startTimeUnixMs < now - STUDIO_TRACE_MAX_PAST_AGE_MS) {
      return { ok: false, reason: 'expired', itemIndex };
    }
    if (endTimeUnixMs > now + STUDIO_TRACE_MAX_FUTURE_SKEW_MS) {
      return { ok: false, reason: 'future_timestamp', itemIndex };
    }
    if (
      endTimeUnixMs < startTimeUnixMs ||
      endTimeUnixMs - startTimeUnixMs > STUDIO_TRACE_MAX_DURATION_MS
    ) {
      return { ok: false, reason: 'duration_limit', itemIndex };
    }
    const resource = normalizeResource(span.resource);
    if (!resource || resource.mocVersion !== mocVersion) {
      return { ok: false, reason: 'invalid_resource', itemIndex };
    }
    const kind = text(span.kind, 16) as StudioTraceSpanKind;
    const outcome = text(span.outcome, 24) as StudioTraceOutcome;
    const status = text(span.status, 16) as StudioOtelStatus;
    const samplingRaw =
      span.sampling && typeof span.sampling === 'object' && !Array.isArray(span.sampling)
        ? (span.sampling as Record<string, unknown>)
        : {};
    const decision = text(samplingRaw.decision, 16) as StudioSamplingDecision;
    const policyVersion = text(samplingRaw.policyVersion, 40);
    if (
      !SPAN_KINDS.has(kind) ||
      !OUTCOMES.has(outcome) ||
      !STATUSES.has(status) ||
      !SAMPLING_DECISIONS.has(decision) ||
      !policyVersion
    ) {
      return { ok: false, reason: 'invalid_schema', itemIndex };
    }
    const name = text(span.name, 100);
    if (!name) return { ok: false, reason: 'invalid_schema', itemIndex };
    spans.push({
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      ...(runId ? { runId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(clientOperationId ? { clientOperationId } : {}),
      sourceSegment,
      name,
      kind,
      startTimeUnixMs,
      endTimeUnixMs,
      outcome,
      status,
      resource,
      attributes: normalizeSafeAttributes(span.attributes),
      sampling: {
        decision,
        policyVersion,
        ...(text(samplingRaw.reason, 80) ? { reason: text(samplingRaw.reason, 80) } : {}),
      },
    });
  }

  const producerVersion = text(raw.producerVersion, 40);
  const createdAt = Math.trunc(Number(raw.createdAt));
  if (!VERSION_RE.test(producerVersion) || !Number.isFinite(createdAt)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const deviceRef = text(raw.deviceRef, 200);
  return {
    ok: true,
    batch: {
      schema: STUDIO_TRACE_BATCH_SCHEMA,
      batchId,
      producerVersion,
      mocVersion,
      ...(deviceRef && OPAQUE_ID_RE.test(deviceRef) ? { deviceRef } : {}),
      createdAt,
      spans,
    },
  };
}
