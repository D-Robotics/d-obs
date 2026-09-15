import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { resolveObservabilityLocatorSecret } from '../observability/run-locator.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';
/** Maximum lifetime for a server-issued evidence proof packet. */
export const OBSERVABILITY_EVIDENCE_PROOF_TTL_MS = 10 * 60_000;
export const REF_PATTERN = /^(summary|incident|check|event|slo|trace):[A-Za-z0-9._:-]{1,160}$/;
export const MAX_REFS = 32;
const MAX_TEXT = 500;
const MAX_EVIDENCE_PROOF_TOKEN_BYTES = 16 * 1024;
const ENVIRONMENTS = new Set([
    'production',
    'staging',
    'development',
    'test',
]);
function normalizeEnvironment(value) {
    const candidate = String(value ?? '').trim().toLowerCase();
    return ENVIRONMENTS.has(candidate)
        ? candidate
        : null;
}
function text(value, max = MAX_TEXT) {
    return sanitizeOpsSummary(value, max).trim();
}
function scopeDigest(scope) {
    return createHash('sha256').update(`rdk-observability-action-scope\0${scope}`).digest('hex');
}
function proofSignature(encodedPayload) {
    return createHmac('sha256', resolveObservabilityLocatorSecret())
        .update(`rdk-observability-evidence-v1\0${encodedPayload}`)
        .digest('base64url');
}
/** Issue a bounded, account-scoped proof for the exact refs shown by copilot. */
export function issueObservabilityEvidenceProof(input) {
    const scopeDigests = [
        ...new Set(input.accountScopeIds.map((scope) => text(scope, 256)).filter(Boolean)),
    ]
        .map(scopeDigest)
        .slice(0, 1_024)
        .sort();
    const refs = [
        ...new Set(input.evidenceRefs.map((ref) => text(ref, 180)).filter((ref) => REF_PATTERN.test(ref))),
    ]
        .slice(0, MAX_REFS)
        .sort();
    const environment = normalizeEnvironment(input.environment ?? resolveStudioTraceStoreEnvironment());
    if (!scopeDigests.length || !refs.length || !environment) {
        throw new Error('action_evidence_proof_input_invalid');
    }
    const issuedAt = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const payload = {
        v: 1,
        scopeDigests,
        refs,
        environment,
        runId: input.runId ? text(input.runId, 256) : null,
        issuedAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${proofSignature(encoded)}`;
}
/** Verify that every proposed ref was present in a recent, server-issued packet. */
export function verifyObservabilityEvidenceProof(token, input) {
    if (typeof token !== 'string' ||
        Buffer.byteLength(token, 'utf8') > MAX_EVIDENCE_PROOF_TOKEN_BYTES) {
        return false;
    }
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1])
        return false;
    let payload;
    try {
        const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (parsed?.v !== 1 || !Array.isArray(parsed.scopeDigests) || !Array.isArray(parsed.refs))
            return false;
        const environment = normalizeEnvironment(parsed.environment);
        if (!environment)
            return false;
        payload = {
            v: 1,
            scopeDigests: parsed.scopeDigests.map((item) => String(item)).slice(0, 1_024),
            refs: parsed.refs.map((item) => String(item)).slice(0, MAX_REFS),
            environment,
            runId: parsed.runId ? text(parsed.runId, 256) : null,
            issuedAt: Number(parsed.issuedAt),
        };
    }
    catch {
        return false;
    }
    const expectedSignature = proofSignature(parts[0]);
    const actualBytes = Buffer.from(parts[1]);
    const expectedBytes = Buffer.from(expectedSignature);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
        return false;
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    if (!Number.isFinite(payload.issuedAt) ||
        payload.issuedAt > now + 30_000 ||
        now - payload.issuedAt > OBSERVABILITY_EVIDENCE_PROOF_TTL_MS)
        return false;
    const scope = text(input.accountScopeId, 256);
    if (!scope || !payload.scopeDigests.includes(scopeDigest(scope)))
        return false;
    const environment = normalizeEnvironment(input.environment ?? resolveStudioTraceStoreEnvironment());
    if (!environment || payload.environment !== environment)
        return false;
    const proposedRefs = [...new Set(input.evidenceRefs.map((ref) => text(ref, 180)))];
    if (!proposedRefs.length ||
        proposedRefs.some((ref) => !REF_PATTERN.test(ref) || !payload.refs.includes(ref)))
        return false;
    const requestedRunId = input.runId ? text(input.runId, 256) : null;
    return payload.runId === requestedRunId;
}
