import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
/** Host-only OTLP/HTTP receiver. This address is deliberately not configurable. */
export const STUDIO_COLLECTOR_RELAY_ENDPOINT = 'http://127.0.0.1:14318/v1/traces';
export const STUDIO_COLLECTOR_RELAY_SCOPE_REF_VERSION = 'scope-v1';
export const STUDIO_COLLECTOR_SCOPE_ISOLATION_ATTESTATION_SCHEMA = 'rdk-studio.otel-scope-isolation-attestation.v1';
const RELAY_TOKEN_FILE_ENV = 'STUDIO_OTEL_RELAY_INGRESS_TOKEN_FILE';
const SCOPE_HASH_KEY_FILE_ENV = 'STUDIO_OTEL_SCOPE_HASH_KEY_FILE';
const SCOPE_ISOLATION_ATTESTATION_FILE_ENV = 'STUDIO_OTEL_SCOPE_ISOLATION_ATTESTATION_FILE';
const EXPORT_COHORT_SCOPE_REFS_FILE_ENV = 'STUDIO_OTEL_EXPORT_COHORT_SCOPE_REFS_FILE';
const EXPORT_ENABLED_ENV = 'STUDIO_TRACE_COLLECTOR_EXPORT';
const SCOPE_ISOLATED_PIPELINE_ENV = 'STUDIO_OTEL_SCOPE_ISOLATED_PIPELINE';
const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_ATTESTATION_AGE_MS = 35 * 24 * 60 * 60_000;
const ATTESTATION_FUTURE_SKEW_MS = 5 * 60_000;
const SPAN_ATTRIBUTE_ALLOWLIST = new Set([
    'moss.run.id',
    'moss.session.id',
    'moss.turn.index',
    'moss.outcome',
    'moss.tool.name',
    'moss.tool.call.id',
    'moss.tool.outcome_kind',
    'gen_ai.operation.name',
    'gen_ai.provider.name',
    'gen_ai.request.model',
    'gen_ai.response.model',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'http.request.method',
    'http.response.status_code',
    'rdk.client.operation.id',
    'rdk.propagation.reason',
    'rdk.retry.attempt',
    'rdk.clock.adjusted',
    'rdk.source.segment',
    'rdk.telemetry.sampling.decision',
    'rdk.telemetry.sampling.policy.version',
    'rdk.telemetry.sampling.reason',
]);
const SPAN_KIND = {
    internal: 1,
    server: 2,
    client: 3,
};
const STATUS_CODE = {
    unset: 0,
    ok: 1,
    error: 2,
};
function emptyHealth() {
    return {
        accepted: 0,
        rejected: 0,
        queued: 0,
        retried: 0,
        expired: 0,
        sampled: 0,
        dropped: 0,
    };
}
function result(ok, forwarded, reason, health = {}) {
    return { ok, forwarded, reason, health: { ...emptyHealth(), ...health } };
}
function cleanScopePart(value, maxLength) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .trim()
        .slice(0, maxLength);
}
function isValidScope(scope) {
    return (cleanScopePart(scope.accountScopeId, 256).length > 0 &&
        ['production', 'staging', 'development', 'test'].includes(scope.environment));
}
function anyValue(value) {
    if (typeof value === 'string')
        return { stringValue: value };
    if (typeof value === 'boolean')
        return { boolValue: value };
    if (Number.isInteger(value))
        return { intValue: String(value) };
    return { doubleValue: value };
}
function attributes(value) {
    return Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => ({ key, value: anyValue(child) }));
}
function timeUnixNano(milliseconds) {
    if (!Number.isSafeInteger(milliseconds))
        throw new Error('invalid timestamp');
    return (BigInt(milliseconds) * 1000000n).toString();
}
/**
 * Derive a non-reversible, low-sensitivity partition reference. The account
 * scope itself remains only in the durable store's protected index.
 */
export function deriveStudioCollectorScopeRef(input) {
    const accountScopeId = cleanScopePart(input.accountScopeId, 256);
    const environment = cleanScopePart(input.environment, 32);
    if (!accountScopeId || !environment || Buffer.byteLength(input.key, 'utf8') < 32) {
        throw new Error('invalid scope reference input');
    }
    const digest = createHmac('sha256', input.key)
        .update(`${STUDIO_COLLECTOR_RELAY_SCOPE_REF_VERSION}\0${environment}\0${accountScopeId}`)
        .digest('hex')
        .slice(0, 32);
    return `${STUDIO_COLLECTOR_RELAY_SCOPE_REF_VERSION}:${digest}`;
}
function scopeIsolationAttestationPayload(attestation) {
    return [
        attestation.schema,
        attestation.capability,
        attestation.samplerProcessor,
        ...attestation.stateKey,
        String(attestation.preservesNativeTraceIds),
        attestation.collectorConfigSha256,
        attestation.verificationEvidenceSha256,
        String(attestation.issuedAt),
        String(attestation.validUntil),
    ].join('\n');
}
export function signStudioCollectorScopeIsolationAttestation(attestation, key) {
    return createHmac('sha256', key)
        .update(scopeIsolationAttestationPayload(attestation))
        .digest('hex');
}
function validScopeIsolationAttestation(value, key, now) {
    if (Buffer.byteLength(value, 'utf8') > MAX_ATTESTATION_BYTES)
        return false;
    try {
        const attestation = JSON.parse(value);
        if (attestation.schema !== STUDIO_COLLECTOR_SCOPE_ISOLATION_ATTESTATION_SCHEMA ||
            attestation.capability !== 'scope-isolated-tail-sampling' ||
            !/^scope_tail_sampling\/[a-z0-9][a-z0-9_-]*$/.test(attestation.samplerProcessor) ||
            !Array.isArray(attestation.stateKey) ||
            attestation.stateKey.length !== 2 ||
            attestation.stateKey[0] !== 'rdk.telemetry.scope.ref' ||
            attestation.stateKey[1] !== 'trace_id' ||
            attestation.preservesNativeTraceIds !== true ||
            !/^[0-9a-f]{64}$/.test(attestation.collectorConfigSha256) ||
            !/^[0-9a-f]{64}$/.test(attestation.verificationEvidenceSha256) ||
            !Number.isSafeInteger(attestation.issuedAt) ||
            !Number.isSafeInteger(attestation.validUntil) ||
            attestation.issuedAt > now + ATTESTATION_FUTURE_SKEW_MS ||
            now - attestation.issuedAt > MAX_ATTESTATION_AGE_MS ||
            attestation.validUntil <= now ||
            attestation.validUntil > attestation.issuedAt + MAX_ATTESTATION_AGE_MS ||
            !/^[0-9a-f]{64}$/.test(attestation.signature)) {
            return false;
        }
        const expected = signStudioCollectorScopeIsolationAttestation(attestation, key);
        return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(attestation.signature, 'hex'));
    }
    catch {
        return false;
    }
}
function canonicalSpanAttributes(span) {
    const safe = {};
    for (const [key, value] of Object.entries(span.attributes)) {
        if (SPAN_ATTRIBUTE_ALLOWLIST.has(key))
            safe[key] = value;
    }
    // Structured contract fields always win over compatibility attributes.
    delete safe['moss.run.id'];
    delete safe['moss.session.id'];
    delete safe['moss.outcome'];
    delete safe['rdk.client.operation.id'];
    delete safe['rdk.source.segment'];
    delete safe['rdk.telemetry.sampling.decision'];
    delete safe['rdk.telemetry.sampling.policy.version'];
    delete safe['rdk.telemetry.sampling.reason'];
    if (span.runId)
        safe['moss.run.id'] = span.runId;
    if (span.sessionId)
        safe['moss.session.id'] = span.sessionId;
    if (span.clientOperationId)
        safe['rdk.client.operation.id'] = span.clientOperationId;
    safe['moss.outcome'] = span.outcome;
    safe['rdk.source.segment'] = span.sourceSegment;
    safe['rdk.telemetry.sampling.decision'] = span.sampling.decision;
    safe['rdk.telemetry.sampling.policy.version'] = span.sampling.policyVersion;
    if (span.sampling.reason)
        safe['rdk.telemetry.sampling.reason'] = span.sampling.reason;
    return attributes(safe);
}
/**
 * Project an already-normalized Studio batch into OTLP/JSON. Native structural
 * IDs and status are copied verbatim; no destination-specific IDs are created.
 */
export function buildStudioCollectorOtlpRequest(input) {
    const grouped = new Map();
    for (const span of input.batch.spans) {
        const resourceValues = {
            'service.name': span.resource.serviceName,
            'service.version': span.resource.studioVersion,
            'service.instance.id': span.resource.serviceInstanceId,
            // The authenticated server scope overrides the producer's environment.
            'deployment.environment.name': input.scope.environment,
            'deployment.profile': span.resource.surface,
            'moss.version': span.resource.mossVersion,
            'moss.observability.contract.version': span.resource.mocVersion,
            'rdk.telemetry.scope.ref': input.scopeRef,
        };
        const resourceAttributes = attributes(resourceValues);
        const groupKey = JSON.stringify(resourceAttributes);
        let group = grouped.get(groupKey);
        if (!group) {
            group = { resource: { attributes: resourceAttributes }, spans: [] };
            grouped.set(groupKey, group);
        }
        group.spans.push({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            kind: SPAN_KIND[span.kind],
            startTimeUnixNano: timeUnixNano(span.startTimeUnixMs),
            endTimeUnixNano: timeUnixNano(span.endTimeUnixMs),
            attributes: canonicalSpanAttributes(span),
            status: { code: STATUS_CODE[span.status] },
        });
    }
    return {
        resourceSpans: [...grouped.values()].map((group) => ({
            resource: group.resource,
            scopeSpans: [
                {
                    scope: { name: 'rdk-studio-central-relay', version: '1.0.0' },
                    spans: group.spans,
                },
            ],
        })),
    };
}
async function defaultReadTextFile(file) {
    return readFile(file, 'utf8');
}
function isEnabled(env) {
    return env[EXPORT_ENABLED_ENV] === '1';
}
function cleanFileSetting(env, name) {
    return cleanScopePart(env[name], 4_096);
}
function cleanRelayToken(value) {
    const token = value.trim();
    if (token.length < 16 || token.length > 1_024 || /[\u0000-\u001f\u007f\s]/.test(token)) {
        return '';
    }
    return token;
}
function configuredCohortScopeRefs(value) {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024)
        return null;
    const refs = new Set(value
        .split(/[\s,]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean));
    return refs.size > 0 && [...refs].every((item) => /^scope-v1:[0-9a-f]{32}$/.test(item))
        ? refs
        : null;
}
function retryableStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}
async function partialRejectedSpans(response, total) {
    if (!response.text)
        return 0;
    try {
        const raw = (await response.text()).slice(0, MAX_RESPONSE_BYTES).trim();
        if (!raw)
            return 0;
        const parsed = JSON.parse(raw);
        const rejected = Math.trunc(Number(parsed.partialSuccess?.rejectedSpans ?? 0));
        return Number.isFinite(rejected) ? Math.max(0, Math.min(total, rejected)) : 0;
    }
    catch {
        return 0;
    }
}
/**
 * Best-effort post-commit fan-out. All configuration, serialization, timeout,
 * network, and Collector failures are returned as bounded health deltas and
 * never escape to the Agent or durable-ingestion acknowledgement path.
 */
export async function forwardNormalizedStudioTraceBatchToCollector(input, dependencies = {}) {
    let total = 0;
    try {
        total = Array.isArray(input?.batch?.spans) ? input.batch.spans.length : 0;
        const env = dependencies.env ?? process.env;
        if (!isEnabled(env))
            return result(true, 0, 'disabled');
        if (total === 0)
            return result(false, 0, 'invalid_batch');
        if (!isValidScope(input.scope)) {
            return result(false, 0, 'invalid_scope', { rejected: total });
        }
        const readTextFile = dependencies.readTextFile ?? defaultReadTextFile;
        if (env[SCOPE_ISOLATED_PIPELINE_ENV] !== '1') {
            return result(false, 0, 'scope_isolation_unavailable', { dropped: total });
        }
        const scopeHashKeyFile = cleanFileSetting(env, SCOPE_HASH_KEY_FILE_ENV);
        if (!scopeHashKeyFile) {
            return result(false, 0, 'scope_key_unavailable', { dropped: total });
        }
        let scopeHashKey = '';
        try {
            scopeHashKey = (await readTextFile(scopeHashKeyFile)).trim();
        }
        catch {
            // Intentionally do not return a path or filesystem error.
        }
        if (Buffer.byteLength(scopeHashKey, 'utf8') < 32) {
            return result(false, 0, 'scope_key_unavailable', { dropped: total });
        }
        const scopeIsolationAttestationFile = cleanFileSetting(env, SCOPE_ISOLATION_ATTESTATION_FILE_ENV);
        if (!scopeIsolationAttestationFile) {
            return result(false, 0, 'scope_isolation_unavailable', { dropped: total });
        }
        let scopeIsolationAttestation = '';
        try {
            scopeIsolationAttestation = await readTextFile(scopeIsolationAttestationFile);
        }
        catch {
            // The caller receives only a bounded capability reason.
        }
        if (!validScopeIsolationAttestation(scopeIsolationAttestation, scopeHashKey, (dependencies.now ?? Date.now)())) {
            return result(false, 0, 'scope_isolation_unavailable', { dropped: total });
        }
        const relayTokenFile = cleanFileSetting(env, RELAY_TOKEN_FILE_ENV);
        if (!relayTokenFile) {
            return result(false, 0, 'credential_unavailable', { dropped: total });
        }
        let relayToken = '';
        try {
            relayToken = cleanRelayToken(await readTextFile(relayTokenFile));
        }
        catch {
            // Intentionally do not return a path or filesystem error.
        }
        if (!relayToken) {
            return result(false, 0, 'credential_unavailable', { dropped: total });
        }
        const scopeRef = deriveStudioCollectorScopeRef({
            accountScopeId: input.scope.accountScopeId,
            environment: input.scope.environment,
            key: scopeHashKey,
        });
        const cohortScopeRefsFile = cleanFileSetting(env, EXPORT_COHORT_SCOPE_REFS_FILE_ENV);
        if (!cohortScopeRefsFile) {
            return result(false, 0, 'cohort_unavailable', { dropped: total });
        }
        let cohortScopeRefs = null;
        try {
            cohortScopeRefs = configuredCohortScopeRefs(await readTextFile(cohortScopeRefsFile));
        }
        catch {
            // Fail closed for export without revealing filesystem details.
        }
        if (!cohortScopeRefs) {
            return result(false, 0, 'cohort_unavailable', { dropped: total });
        }
        if (!cohortScopeRefs.has(scopeRef)) {
            // This is an intentional rollout exclusion, not telemetry loss.
            return result(true, 0, 'outside_cohort');
        }
        const body = JSON.stringify(buildStudioCollectorOtlpRequest({ batch: input.batch, scope: input.scope, scopeRef }));
        const fetchImpl = dependencies.fetchImpl ?? fetch;
        const sleep = dependencies.sleep ??
            ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
        const random = dependencies.random ?? Math.random;
        let retried = 0;
        let terminalReason = 'network_error';
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetchImpl(STUDIO_COLLECTOR_RELAY_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        accept: 'application/json',
                        authorization: `Bearer ${relayToken}`,
                        'content-type': 'application/json',
                    },
                    body,
                    signal: controller.signal,
                });
                if (response.ok) {
                    const rejected = await partialRejectedSpans(response, total);
                    const accepted = total - rejected;
                    return result(rejected === 0, accepted, rejected ? 'partial_rejection' : 'forwarded', {
                        accepted,
                        rejected,
                        retried,
                    });
                }
                if (!retryableStatus(response.status)) {
                    return result(false, 0, 'collector_rejected', { rejected: total, retried });
                }
                terminalReason = 'retry_exhausted';
            }
            catch {
                terminalReason = controller.signal.aborted ? 'timeout' : 'network_error';
            }
            finally {
                clearTimeout(timeout);
            }
            if (attempt < MAX_ATTEMPTS) {
                retried += total;
                await sleep(25 + Math.floor(Math.max(0, Math.min(1, random())) * 50));
            }
        }
        return result(false, 0, terminalReason, { retried, dropped: total });
    }
    catch {
        return result(false, 0, 'network_error', { dropped: total });
    }
}
