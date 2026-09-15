/**
 * Studio-owned transport, resource, ingestion, and coverage contracts.
 * Canonical Moss span names and attributes remain owned by MOC upstream.
 */
export const STUDIO_TRACE_BATCH_SCHEMA = 'rdk.studio.trace-batch.v2';
export const STUDIO_AGENT_TRACE_REQUEST_SCHEMA = 'rdk.studio.agent-trace-request.v1';
export const STUDIO_RUN_START_SCHEMA = 'rdk.studio.run-start.v1';
export const STUDIO_CLIENT_OPERATION_SCHEMA = 'rdk.studio.client-operation.v1';
export const STUDIO_TRACE_BATCH_MAX_ITEMS = 128;
export const STUDIO_TRACE_BATCH_MAX_BYTES = 256 * 1024;
export const STUDIO_TRACE_ATTRIBUTE_MAX_COUNT = 32;
export const STUDIO_TRACE_ATTRIBUTE_MAX_LENGTH = 160;
export const STUDIO_TRACE_MAX_DURATION_MS = 24 * 60 * 60_000;
export const STUDIO_TRACE_MAX_PAST_AGE_MS = 35 * 24 * 60 * 60_000;
export const STUDIO_TRACE_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const BATCH_ID_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
const CLIENT_OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const PROPAGATION_REASONS = new Set([
    'continued',
    'missing',
    'malformed',
    'zero_identifier',
    'unsupported_version',
    'untrusted_sampling_ignored',
]);
const SOURCE_SEGMENTS = new Set(['client', 'studio_transport', 'moss']);
const SPAN_KINDS = new Set(['internal', 'client', 'server']);
const OUTCOMES = new Set([
    'ok',
    'error',
    'cancelled',
    'denied',
    'incomplete',
    'blocked',
    'replayed',
    'suppressed',
]);
const STATUSES = new Set(['unset', 'ok', 'error']);
const SAMPLING_DECISIONS = new Set(['pending', 'retained', 'dropped']);
const SURFACES = new Set([
    'web-cloud',
    'web-self-host',
    'desktop',
    'local-dev',
    'miniapp',
]);
const ENVIRONMENTS = new Set([
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
function text(value, max = STUDIO_TRACE_ATTRIBUTE_MAX_LENGTH) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}
function validTraceId(value) {
    return typeof value === 'string' && TRACE_ID_RE.test(value) && !/^0+$/.test(value);
}
function validSpanId(value) {
    return typeof value === 'string' && SPAN_ID_RE.test(value) && !/^0+$/.test(value);
}
/**
 * Validate the authoritative early SSE correlation signal and return a new,
 * allowlisted object. Extra client/account/analytics fields are never copied.
 */
export function normalizeStudioRunStartSignal(value, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.schema !== STUDIO_RUN_START_SCHEMA)
        return null;
    const runId = text(raw.runId, 200);
    const traceId = text(raw.traceId, 32).toLowerCase();
    const serverSpanId = text(raw.serverSpanId, 16).toLowerCase();
    const clientOperationId = text(raw.clientOperationId, 120);
    if (!OPAQUE_ID_RE.test(runId) ||
        !validTraceId(traceId) ||
        !validSpanId(serverSpanId) ||
        !CLIENT_OPERATION_ID_RE.test(clientOperationId) ||
        runId === clientOperationId) {
        return null;
    }
    if (options.expectedClientOperationId &&
        clientOperationId !== options.expectedClientOperationId) {
        return null;
    }
    const propagationRaw = raw.propagation && typeof raw.propagation === 'object' && !Array.isArray(raw.propagation)
        ? raw.propagation
        : null;
    if (!propagationRaw || typeof propagationRaw.continued !== 'boolean')
        return null;
    const reason = text(propagationRaw.reason, 40);
    if (!PROPAGATION_REASONS.has(reason))
        return null;
    const continuedReason = reason === 'continued' || reason === 'untrusted_sampling_ignored';
    if (propagationRaw.continued !== continuedReason)
        return null;
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
export function isStudioRunStartSignal(value) {
    return normalizeStudioRunStartSignal(value) !== null;
}
function normalizeResource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    const serviceName = text(raw.serviceName, 80);
    const serviceInstanceId = text(raw.serviceInstanceId, 120);
    const deploymentEnvironment = text(raw.deploymentEnvironment, 32);
    const surface = text(raw.surface, 32);
    const studioVersion = text(raw.studioVersion, 40);
    const mossVersion = text(raw.mossVersion, 40);
    const mocVersion = text(raw.mocVersion, 40);
    if (!serviceName ||
        !serviceInstanceId ||
        !ENVIRONMENTS.has(deploymentEnvironment) ||
        !SURFACES.has(surface) ||
        !VERSION_RE.test(studioVersion) ||
        !VERSION_RE.test(mossVersion) ||
        !VERSION_RE.test(mocVersion)) {
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
function normalizeSafeAttributes(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const result = {};
    for (const [key, raw] of Object.entries(value).slice(0, STUDIO_TRACE_ATTRIBUTE_MAX_COUNT)) {
        if (!SAFE_ATTRIBUTE_KEYS.has(key))
            continue;
        if (typeof raw === 'string') {
            const normalized = text(raw);
            if (normalized)
                result[key] = normalized;
        }
        else if (typeof raw === 'boolean') {
            result[key] = raw;
        }
        else if (typeof raw === 'number' && Number.isFinite(raw)) {
            result[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, raw));
        }
    }
    return result;
}
/** Normalize untrusted transport input without accepting account or authorization fields. */
export function normalizeStudioTraceBatch(value, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'invalid_schema' };
    }
    const raw = value;
    if (raw.schema !== STUDIO_TRACE_BATCH_SCHEMA)
        return { ok: false, reason: 'invalid_schema' };
    const requestBytes = Number(options.requestBytes ?? JSON.stringify(value).length);
    if (!Number.isFinite(requestBytes) || requestBytes > STUDIO_TRACE_BATCH_MAX_BYTES) {
        return { ok: false, reason: 'request_bytes_limit' };
    }
    const batchId = text(raw.batchId, 64).toLowerCase();
    if (!BATCH_ID_RE.test(batchId))
        return { ok: false, reason: 'invalid_batch_id' };
    const mocVersion = text(raw.mocVersion, 40);
    if (!VERSION_RE.test(mocVersion))
        return { ok: false, reason: 'invalid_contract_version' };
    if (options.supportedMocMajor !== undefined &&
        Number(mocVersion.split('.')[0]) !== options.supportedMocMajor) {
        return { ok: false, reason: 'invalid_contract_version' };
    }
    if (!Array.isArray(raw.spans) || raw.spans.length === 0) {
        return { ok: false, reason: 'empty_batch' };
    }
    if (raw.spans.length > STUDIO_TRACE_BATCH_MAX_ITEMS) {
        return { ok: false, reason: 'item_limit' };
    }
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const spans = [];
    for (const [itemIndex, candidate] of raw.spans.entries()) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return { ok: false, reason: 'invalid_identifier', itemIndex };
        }
        const span = candidate;
        const traceId = text(span.traceId, 32).toLowerCase();
        const spanId = text(span.spanId, 16).toLowerCase();
        const parentSpanId = text(span.parentSpanId, 16).toLowerCase();
        if (!validTraceId(traceId) ||
            !validSpanId(spanId) ||
            (parentSpanId && !validSpanId(parentSpanId))) {
            return { ok: false, reason: 'invalid_identifier', itemIndex };
        }
        const sourceSegment = text(span.sourceSegment, 32);
        if (!SOURCE_SEGMENTS.has(sourceSegment)) {
            return { ok: false, reason: 'invalid_source_segment', itemIndex };
        }
        const runId = text(span.runId, 200);
        if (!runId && sourceSegment !== 'client') {
            return { ok: false, reason: 'missing_run_id', itemIndex };
        }
        const sessionId = text(span.sessionId, 200);
        const clientOperationId = text(span.clientOperationId, 200);
        if ((runId && !OPAQUE_ID_RE.test(runId)) ||
            (sessionId && !OPAQUE_ID_RE.test(sessionId)) ||
            (clientOperationId && !OPAQUE_ID_RE.test(clientOperationId))) {
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
        if (endTimeUnixMs < startTimeUnixMs ||
            endTimeUnixMs - startTimeUnixMs > STUDIO_TRACE_MAX_DURATION_MS) {
            return { ok: false, reason: 'duration_limit', itemIndex };
        }
        const resource = normalizeResource(span.resource);
        if (!resource || resource.mocVersion !== mocVersion) {
            return { ok: false, reason: 'invalid_resource', itemIndex };
        }
        const kind = text(span.kind, 16);
        const outcome = text(span.outcome, 24);
        const status = text(span.status, 16);
        const samplingRaw = span.sampling && typeof span.sampling === 'object' && !Array.isArray(span.sampling)
            ? span.sampling
            : {};
        const decision = text(samplingRaw.decision, 16);
        const policyVersion = text(samplingRaw.policyVersion, 40);
        if (!SPAN_KINDS.has(kind) ||
            !OUTCOMES.has(outcome) ||
            !STATUSES.has(status) ||
            !SAMPLING_DECISIONS.has(decision) ||
            !policyVersion) {
            return { ok: false, reason: 'invalid_schema', itemIndex };
        }
        const name = text(span.name, 100);
        if (!name)
            return { ok: false, reason: 'invalid_schema', itemIndex };
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
