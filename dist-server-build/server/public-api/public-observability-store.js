import crypto from 'node:crypto';
import { getStudioTraceSpansForRun, persistStudioTraceSpans, resolveStudioTraceStoreEnvironment, } from '../observability/studio-trace-store.js';
import { normalizeStudioTraceSpans } from '../../shared/studio-tracing.js';
export const PUBLIC_OBSERVABILITY_SPAN_SCHEMA = 'rdk.public.observability.span.v1';
export class PublicObservabilityConflictError extends Error {
    constructor(message = 'observability_run_conflict: runId already belongs to another owner') {
        super(message);
        this.name = 'PublicObservabilityConflictError';
    }
}
function isGlobalOwner(owner) {
    return cleanText(owner, 256) === '*';
}
const MAX_RUNS = 2_000;
const MAX_SPANS_PER_RUN = 256;
const MAX_SCORES_PER_RUN = 100;
const MAX_FEEDBACK_PER_RUN = 100;
const MAX_ATTRIBUTES = 24;
const MAX_TEXT = 160;
const MAX_LONG_TEXT = 1_000;
const LOW_SENSITIVITY_RETENTION_MS = 35 * 24 * 60 * 60_000;
const MAX_GOVERNANCE_TOMBSTONES = 4_096;
const PUBLIC_OBSERVABILITY_SPAN_ATTRIBUTE_KEYS = new Set([
    'team',
    'objectType',
    'objectId',
    'objectName',
    'objectVersion',
    'projectId',
    'service',
    'environment',
    'release',
    'sessionRef',
    'external.name',
    'external.kind',
    'model',
    'provider',
    'inputTokens',
    'outputTokens',
    'toolName',
    'route',
    'method',
    'http.status_code',
    'retry.attempt',
    'client.type',
    'client.release',
    'stream.outcome',
    'outcome',
    'outcome_kind',
    'is_error',
    'statusCode',
    'error.kind',
    'promptVersion',
]);
const PUBLIC_OBSERVABILITY_RUN_METADATA_KEYS = new Set([
    'team',
    'objectType',
    'objectId',
    'objectName',
    'objectVersion',
    'projectId',
    'service',
    'environment',
    'release',
    'sessionRef',
    'agentFramework',
    'modelFamily',
    'promptVersion',
    'channel',
    'client.type',
    'client.release',
    'model',
    'provider',
    'external.name',
    'external.kind',
]);
const VALID_KINDS = new Set([
    'agent',
    'generation',
    'tool',
    'retrieval',
    'http',
    'approval',
    'custom',
]);
function cleanText(value, max = MAX_TEXT) {
    return typeof value === 'string'
        ? value.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
        : '';
}
function normalizeScalarMap(value, allowed = PUBLIC_OBSERVABILITY_SPAN_ATTRIBUTE_KEYS) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const result = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_ATTRIBUTES)) {
        const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
        if (!key || !allowed.has(key))
            continue;
        if (typeof rawValue === 'string') {
            const text = cleanText(rawValue, MAX_LONG_TEXT);
            if (text)
                result[key] = text;
        }
        else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
            result[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, rawValue));
        }
        else if (typeof rawValue === 'boolean') {
            result[key] = rawValue;
        }
    }
    return result;
}
function normalizeLabelList(value, maxEntries = 16) {
    if (!Array.isArray(value))
        return [];
    return [...new Set(value
            .filter((item) => typeof item === 'string')
            .map((item) => cleanText(item, 64))
            .filter(Boolean))].slice(0, maxEntries);
}
function objectProfileKey(owner, team, objectType, objectId) {
    return [cleanText(owner, 256), cleanText(team, 120), cleanText(objectType, 120), cleanText(objectId, 200)].join('\u0000');
}
function normalizeSearchText(value, max = 120) {
    return cleanText(value, max).toLowerCase();
}
function normalizeStatus(value) {
    const status = cleanText(value, 16);
    return status === 'queued' || status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled'
        ? status
        : 'running';
}
function normalizeKind(value) {
    const kind = cleanText(value, 32);
    return VALID_KINDS.has(kind) ? kind : 'custom';
}
function normalizeSource(value, fallback = 'server') {
    const source = cleanText(value, 16);
    return source === 'client' || source === 'server' ? source : fallback;
}
function isTraceId(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}
function isSpanId(value) {
    return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}
function randomTraceId() {
    return crypto.randomBytes(16).toString('hex');
}
function randomSpanId() {
    return crypto.randomBytes(8).toString('hex');
}
function mapKindToInternalName(kind, source) {
    if (source === 'client' && kind === 'http')
        return 'http.client';
    if (source === 'client' && kind === 'agent')
        return 'studio.agent_chat';
    if (kind === 'generation')
        return 'moss.llm.request';
    if (kind === 'tool')
        return 'moss.tool.invoke';
    if (kind === 'retrieval' || kind === 'approval')
        return 'moss.agent.turn';
    if (kind === 'http')
        return 'moss.agent.turn';
    if (kind === 'agent')
        return 'moss.agent.turn';
    return 'moss.agent.turn';
}
function mapInternalNameToKind(name, source, attributes) {
    const external = cleanText(attributes['external.kind'], 32);
    if (external && VALID_KINDS.has(external))
        return external;
    if (source === 'client' && name === 'http.client')
        return 'http';
    if (source === 'client' && name === 'studio.agent_chat')
        return 'agent';
    if (name === 'moss.llm.request')
        return 'generation';
    if (name === 'moss.tool.invoke')
        return 'tool';
    if (name === 'moss.session' || name === 'moss.agent.turn')
        return 'agent';
    return 'custom';
}
function publicSpanFromStudioSpan(span) {
    const attributes = normalizeScalarMap(span.attributes);
    const kind = mapInternalNameToKind(span.name, span.source, attributes);
    const name = cleanText(attributes['external.name'] ?? span.name, 80) || span.name;
    return {
        schema: PUBLIC_OBSERVABILITY_SPAN_SCHEMA,
        runId: span.runId,
        traceId: span.traceId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        source: span.source,
        kind,
        name,
        startTime: span.startTime,
        endTime: span.endTime,
        status: span.status,
        ...(span.statusMessage ? { statusMessage: span.statusMessage } : {}),
        attributes,
    };
}
function pickRunStatus(current, next) {
    if (!next)
        return current;
    if (next === 'failed' || next === 'cancelled')
        return next;
    if (next === 'completed')
        return 'completed';
    if (current === 'running' || current === 'queued')
        return next;
    return current;
}
class PublicObservabilityStore {
    runs = new Map();
    idempotency = new Map();
    objectProfiles = new Map();
    governanceTombstones = [];
    quarantineAllTelemetry = false;
    deleteCachedRun(runId) {
        const removed = this.runs.delete(runId);
        if (!removed)
            return false;
        for (const [key, value] of this.idempotency) {
            if (value === runId)
                this.idempotency.delete(key);
        }
        return true;
    }
    pruneExpiredRuns(now = Date.now()) {
        let removed = 0;
        for (const run of this.runs.values()) {
            const eventTime = Math.min(run.createdAt, run.firstSpanAt ?? run.createdAt);
            if (this.quarantineAllTelemetry ||
                !Number.isFinite(eventTime) ||
                eventTime + LOW_SENSITIVITY_RETENTION_MS <= now ||
                this.governanceTombstones.some((tombstone) => this.tombstoneMatchesRun(tombstone, run))) {
                if (this.deleteCachedRun(run.runId))
                    removed += 1;
            }
        }
        return removed;
    }
    tombstoneMatchesRun(tombstone, run) {
        return (tombstone.accountScopeId === run.owner &&
            (!tombstone.userId || tombstone.userId === run.owner) &&
            (!tombstone.runId || tombstone.runId === run.runId) &&
            (!tombstone.traceId || tombstone.traceId === run.traceId) &&
            (!tombstone.sessionId || tombstone.sessionId === run.sessionRef) &&
            !tombstone.grantId);
    }
    tombstoneCoversLookup(owner, runId) {
        if (this.quarantineAllTelemetry)
            return true;
        return this.governanceTombstones.some((tombstone) => tombstone.accountScopeId === owner &&
            (!tombstone.userId || tombstone.userId === owner) &&
            (!tombstone.runId || tombstone.runId === runId));
    }
    rememberGovernanceTombstone(tombstone) {
        if (this.governanceTombstones.some((item) => item.tombstoneId === tombstone.tombstoneId || item.requestId === tombstone.requestId)) {
            return;
        }
        const normalized = {
            tombstoneId: cleanText(tombstone.tombstoneId, 256),
            requestId: cleanText(tombstone.requestId, 256),
            accountScopeId: cleanText(tombstone.accountScopeId, 256),
            environment: tombstone.environment,
            createdAt: tombstone.createdAt,
            ...(tombstone.userId ? { userId: cleanText(tombstone.userId, 256) } : {}),
            ...(tombstone.runId ? { runId: cleanText(tombstone.runId, 256) } : {}),
            ...(tombstone.traceId ? { traceId: cleanText(tombstone.traceId, 256) } : {}),
            ...(tombstone.sessionId ? { sessionId: cleanText(tombstone.sessionId, 256) } : {}),
        };
        const broad = !normalized.runId && !normalized.traceId && !normalized.sessionId;
        if (broad) {
            for (let index = this.governanceTombstones.length - 1; index >= 0; index -= 1) {
                const existing = this.governanceTombstones[index];
                if (existing?.accountScopeId === normalized.accountScopeId &&
                    existing.environment === normalized.environment) {
                    this.governanceTombstones.splice(index, 1);
                }
            }
        }
        this.governanceTombstones.push(normalized);
        if (this.governanceTombstones.length > MAX_GOVERNANCE_TOMBSTONES) {
            // Losing a deletion selector would permit a future cache/restore read;
            // bounded global quarantine is the safe shedding behavior.
            this.governanceTombstones.length = 0;
            this.quarantineAllTelemetry = true;
        }
    }
    trimRuns() {
        if (this.runs.size <= MAX_RUNS)
            return;
        const overflow = [...this.runs.values()]
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, this.runs.size - MAX_RUNS);
        for (const item of overflow)
            this.deleteCachedRun(item.runId);
    }
    upsertStoredRun(record) {
        this.runs.set(record.runId, record);
        this.trimRuns();
        return record;
    }
    createStoredRun(owner, keyId, input) {
        const runId = cleanText(input.runId || `obs_${crypto.randomUUID().replace(/-/g, '')}`, 200);
        const traceId = isTraceId(input.traceId) ? input.traceId : randomTraceId();
        const now = Date.now();
        const record = {
            runId,
            traceId,
            owner,
            keyId,
            ...(cleanText(input.team, 120) ? { team: cleanText(input.team, 120) } : {}),
            ...(cleanText(input.objectType, 120) ? { objectType: cleanText(input.objectType, 120) } : {}),
            ...(cleanText(input.objectId, 200) ? { objectId: cleanText(input.objectId, 200) } : {}),
            ...(cleanText(input.objectName, 160) ? { objectName: cleanText(input.objectName, 160) } : {}),
            ...(cleanText(input.objectVersion, 120) ? { objectVersion: cleanText(input.objectVersion, 120) } : {}),
            projectId: cleanText(input.projectId, 160) || 'unknown',
            environment: cleanText(input.environment, 120) || 'unknown',
            service: cleanText(input.service, 160) || 'unknown',
            ...(cleanText(input.release, 120) ? { release: cleanText(input.release, 120) } : {}),
            ...(cleanText(input.name, 120) ? { name: cleanText(input.name, 120) } : {}),
            ...(cleanText(input.sessionRef, 200) ? { sessionRef: cleanText(input.sessionRef, 200) } : {}),
            metadata: normalizeScalarMap(input.metadata, PUBLIC_OBSERVABILITY_RUN_METADATA_KEYS),
            status: normalizeStatus(input.status),
            createdAt: now,
            updatedAt: now,
            spanCount: 0,
            errorSpanCount: 0,
            scoreCount: 0,
            feedbackCount: 0,
            ...(input.idempotencyKey ? { idempotencyKey: cleanText(input.idempotencyKey, 256) } : {}),
            spans: new Map(),
            scores: [],
            feedback: [],
        };
        this.upsertStoredRun(record);
        if (record.idempotencyKey)
            this.idempotency.set(`${keyId}:${record.idempotencyKey}`, record.runId);
        return record;
    }
    mergeRunMetadata(run, input) {
        if (input.team !== undefined) {
            const team = cleanText(input.team, 120);
            if (team)
                run.team = team;
        }
        if (input.objectType !== undefined) {
            const objectType = cleanText(input.objectType, 120);
            if (objectType)
                run.objectType = objectType;
        }
        if (input.objectId !== undefined) {
            const objectId = cleanText(input.objectId, 200);
            if (objectId)
                run.objectId = objectId;
        }
        if (input.objectName !== undefined) {
            const objectName = cleanText(input.objectName, 160);
            if (objectName)
                run.objectName = objectName;
        }
        if (input.objectVersion !== undefined) {
            const objectVersion = cleanText(input.objectVersion, 120);
            if (objectVersion)
                run.objectVersion = objectVersion;
        }
        if (input.projectId) {
            const projectId = cleanText(input.projectId, 160);
            if (projectId && projectId !== 'unknown')
                run.projectId = projectId;
        }
        if (input.environment) {
            const environment = cleanText(input.environment, 120);
            if (environment && environment !== 'unknown')
                run.environment = environment;
        }
        if (input.service) {
            const service = cleanText(input.service, 160);
            if (service && service !== 'unknown')
                run.service = service;
        }
        if (input.release !== undefined) {
            const release = cleanText(input.release, 120);
            if (release)
                run.release = release;
        }
        if (input.name !== undefined) {
            const name = cleanText(input.name, 120);
            if (name)
                run.name = name;
        }
        if (input.sessionRef !== undefined) {
            const sessionRef = cleanText(input.sessionRef, 200);
            if (sessionRef)
                run.sessionRef = sessionRef;
        }
        if (input.metadata)
            run.metadata = { ...run.metadata, ...normalizeScalarMap(input.metadata, PUBLIC_OBSERVABILITY_RUN_METADATA_KEYS) };
    }
    toRootSpan(run) {
        const startTime = run.createdAt;
        return {
            schema: PUBLIC_OBSERVABILITY_SPAN_SCHEMA,
            runId: run.runId,
            traceId: run.traceId,
            spanId: randomSpanId(),
            source: 'server',
            kind: 'agent',
            name: run.name || run.runId,
            startTime,
            endTime: startTime,
            status: 'ok',
            attributes: normalizeScalarMap({
                ...run.metadata,
                ...(run.team ? { team: run.team } : {}),
                ...(run.objectType ? { objectType: run.objectType } : {}),
                ...(run.objectId ? { objectId: run.objectId } : {}),
                ...(run.objectName ? { objectName: run.objectName } : {}),
                ...(run.objectVersion ? { objectVersion: run.objectVersion } : {}),
                projectId: run.projectId,
                environment: run.environment,
                service: run.service,
                ...(run.release ? { release: run.release } : {}),
                ...(run.name ? { 'external.name': run.name } : {}),
                'external.kind': 'agent',
                ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
            }, PUBLIC_OBSERVABILITY_SPAN_ATTRIBUTE_KEYS),
        };
    }
    toInternalSpan(span) {
        const source = normalizeSource(span.source);
        const traceId = isTraceId(span.traceId) ? span.traceId : randomTraceId();
        const spanId = isSpanId(span.spanId) ? span.spanId : randomSpanId();
        const parentSpanId = span.parentSpanId && isSpanId(span.parentSpanId) ? span.parentSpanId : '';
        const kind = normalizeKind(span.kind);
        const name = cleanText(span.name, 80) || 'observability.span';
        const startTime = Math.trunc(Number(span.startTime));
        const endTime = Math.trunc(Number(span.endTime));
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime)
            return null;
        const normalized = normalizeStudioTraceSpans([
            {
                schema: 'rdk.studio.trace-span.v1',
                traceId,
                spanId,
                ...(parentSpanId ? { parentSpanId } : {}),
                runId: span.runId,
                source,
                name: mapKindToInternalName(kind, source),
                startTime,
                endTime,
                status: span.status === 'error' ? 'error' : 'ok',
                ...(span.statusMessage ? { statusMessage: cleanText(span.statusMessage, 160) } : {}),
                attributes: normalizeScalarMap({
                    ...span.attributes,
                    'external.name': name,
                    'external.kind': kind,
                }, PUBLIC_OBSERVABILITY_SPAN_ATTRIBUTE_KEYS),
            },
        ], { source, runId: span.runId });
        return normalized[0] ?? null;
    }
    updateRunStats(run) {
        const ordered = [...run.spans.values()].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
        run.spanCount = ordered.length;
        run.errorSpanCount = ordered.filter((span) => span.status === 'error').length;
        run.firstSpanAt = ordered[0]?.startTime;
        run.lastSpanAt = ordered.at(-1)?.endTime;
    }
    async createRun(owner, keyId, input) {
        const normalizedOwner = cleanText(owner, 256);
        const normalizedKeyId = cleanText(keyId, 96);
        if (!normalizedOwner || !normalizedKeyId)
            throw new Error('owner and keyId are required.');
        const idempotencyKey = cleanText(input.idempotencyKey, 256);
        if (idempotencyKey) {
            const hit = this.idempotency.get(`${normalizedKeyId}:${idempotencyKey}`);
            if (hit) {
                const existing = this.runs.get(hit);
                if (existing && existing.owner === normalizedOwner)
                    return { run: this.publicRun(existing), replayed: true };
            }
        }
        const existingRunId = cleanText(input.runId, 200);
        if (existingRunId) {
            const existing = this.runs.get(existingRunId);
            if (existing) {
                if (existing.owner !== normalizedOwner)
                    throw new PublicObservabilityConflictError();
                this.mergeRunMetadata(existing, input);
                existing.updatedAt = Date.now();
                if (idempotencyKey)
                    this.idempotency.set(`${normalizedKeyId}:${idempotencyKey}`, existing.runId);
                return { run: this.publicRun(existing), replayed: false };
            }
        }
        const run = this.createStoredRun(normalizedOwner, normalizedKeyId, input);
        const rootSpan = this.toInternalSpan(this.toRootSpan(run));
        if (rootSpan)
            await this.persistAndStoreSpans(run, [rootSpan]);
        this.updateRunStats(run);
        run.updatedAt = Date.now();
        return { run: this.publicRun(run), replayed: false };
    }
    async ensureRun(owner, keyId, input) {
        const normalizedOwner = cleanText(owner, 256);
        const normalizedKeyId = cleanText(keyId, 96);
        const runId = cleanText(input.runId, 200);
        if (!normalizedOwner || !normalizedKeyId || !runId)
            throw new Error('owner, keyId and runId are required.');
        const existing = this.runs.get(runId);
        if (existing) {
            if (existing.owner !== normalizedOwner)
                throw new PublicObservabilityConflictError();
            this.mergeRunMetadata(existing, input);
            existing.updatedAt = Date.now();
            return this.publicRun(existing);
        }
        const run = this.createStoredRun(normalizedOwner, normalizedKeyId, { ...input, runId });
        const rootSpan = this.toInternalSpan(this.toRootSpan(run));
        if (rootSpan)
            await this.persistAndStoreSpans(run, [rootSpan]);
        this.updateRunStats(run);
        run.updatedAt = Date.now();
        return this.publicRun(run);
    }
    async appendSpans(input) {
        const owner = cleanText(input.owner, 256);
        const keyId = cleanText(input.keyId, 96);
        const runId = cleanText(input.runId, 200);
        if (!owner || !keyId || !runId)
            throw new Error('owner, keyId and runId are required.');
        let run = this.runs.get(runId);
        if (!run) {
            run = this.createStoredRun(owner, keyId, {
                runId,
                traceId: input.traceId,
                projectId: cleanText(input.run?.projectId, 160) || 'unknown',
                environment: cleanText(input.run?.environment, 120) || 'unknown',
                service: cleanText(input.run?.service, 160) || 'unknown',
                team: cleanText(input.run?.team, 120) || undefined,
                objectType: cleanText(input.run?.objectType, 120) || undefined,
                objectId: cleanText(input.run?.objectId, 200) || undefined,
                objectName: cleanText(input.run?.objectName, 160) || undefined,
                objectVersion: cleanText(input.run?.objectVersion, 120) || undefined,
                release: cleanText(input.run?.release, 120) || undefined,
                name: cleanText(input.run?.name, 120) || runId,
                sessionRef: cleanText(input.run?.sessionRef, 200) || undefined,
                metadata: normalizeScalarMap(input.run?.metadata),
                status: normalizeStatus(input.run?.status),
            });
        }
        else if (run.owner !== owner) {
            throw new PublicObservabilityConflictError();
        }
        if (input.run) {
            this.mergeRunMetadata(run, input.run);
        }
        const normalizedSpans = [];
        for (const raw of input.spans.slice(0, 64)) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                continue;
            const row = raw;
            const span = {
                schema: PUBLIC_OBSERVABILITY_SPAN_SCHEMA,
                runId,
                traceId: run.traceId,
                spanId: cleanText(row.spanId, 16) || randomSpanId(),
                ...(cleanText(row.parentSpanId, 16) ? { parentSpanId: cleanText(row.parentSpanId, 16) } : {}),
                source: normalizeSource(row.source, 'server'),
                kind: normalizeKind(row.kind),
                name: cleanText(row.name, 80) || 'observability.span',
                startTime: Math.trunc(Number(row.startTime)),
                endTime: Math.trunc(Number(row.endTime)),
                status: row.status === 'error' ? 'error' : 'ok',
                ...(cleanText(row.statusMessage, 160) ? { statusMessage: cleanText(row.statusMessage, 160) } : {}),
                attributes: normalizeScalarMap(row.attributes, PUBLIC_OBSERVABILITY_SPAN_ATTRIBUTE_KEYS),
            };
            const internal = this.toInternalSpan(span);
            if (!internal)
                continue;
            normalizedSpans.push({
                ...span,
                traceId: internal.traceId,
                spanId: internal.spanId,
                ...(internal.parentSpanId ? { parentSpanId: internal.parentSpanId } : {}),
                source: internal.source,
                kind: mapInternalNameToKind(internal.name, internal.source, internal.attributes),
                name: cleanText(internal.attributes['external.name'] ?? span.name, 80) || span.name,
                startTime: internal.startTime,
                endTime: internal.endTime,
                status: internal.status,
                ...(internal.statusMessage ? { statusMessage: internal.statusMessage } : {}),
                attributes: normalizeScalarMap(internal.attributes),
            });
        }
        if (!normalizedSpans.length && input.status) {
            run.status = pickRunStatus(run.status, input.status);
            if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
                run.completedAt = input.completedAt ?? Date.now();
            }
            run.updatedAt = Date.now();
            return { run: this.publicRun(run), spans: [] };
        }
        await this.persistAndStoreSpans(run, normalizedSpans.map((span) => this.toInternalSpan(span)).filter((span) => Boolean(span)));
        this.updateRunStats(run);
        if (input.status) {
            run.status = pickRunStatus(run.status, input.status);
            if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
                run.completedAt = input.completedAt ?? Date.now();
            }
        }
        else if (run.status === 'queued') {
            run.status = 'running';
        }
        run.updatedAt = Date.now();
        return { run: this.publicRun(run), spans: normalizedSpans };
    }
    matchingRuns(owner, options = {}) {
        this.pruneExpiredRuns();
        const normalizedOwner = cleanText(owner, 256);
        const globalOwner = isGlobalOwner(normalizedOwner);
        if (!normalizedOwner && !globalOwner)
            return [];
        return [...this.runs.values()]
            .filter((run) => globalOwner || run.owner === normalizedOwner)
            .filter((run) => !options.team || run.team === options.team)
            .filter((run) => !options.objectType || run.objectType === options.objectType)
            .filter((run) => !options.objectId || run.objectId === options.objectId)
            .filter((run) => !options.objectVersion || run.objectVersion === options.objectVersion)
            .filter((run) => !options.projectId || run.projectId === options.projectId)
            .filter((run) => !options.environment || run.environment === options.environment)
            .filter((run) => !options.service || run.service === options.service)
            .filter((run) => !options.status || run.status === options.status)
            .filter((run) => options.from == null || (run.lastSpanAt ?? run.updatedAt) >= options.from)
            .filter((run) => options.to == null || (run.firstSpanAt ?? run.createdAt) <= options.to)
            .sort((a, b) => (b.lastSpanAt ?? b.updatedAt) - (a.lastSpanAt ?? a.updatedAt));
    }
    listRuns(owner, options = {}) {
        const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
        return this.matchingRuns(owner, options).slice(0, limit).map((run) => this.publicRun(run));
    }
    collectObjectAggregates(owner, options = {}, includeProfileOnly = false) {
        const normalizedOwner = cleanText(owner, 256);
        const globalOwner = isGlobalOwner(normalizedOwner);
        const aggregates = new Map();
        if (!normalizedOwner && !globalOwner)
            return aggregates;
        if (this.quarantineAllTelemetry)
            return aggregates;
        const ensureAggregate = (team, objectType, objectId) => {
            const normalizedObjectId = cleanText(objectId, 200);
            if (!normalizedObjectId)
                return null;
            const key = objectProfileKey(globalOwner ? '*' : normalizedOwner, team, objectType, normalizedObjectId);
            let aggregate = aggregates.get(key);
            if (!aggregate) {
                aggregate = {
                    ...(team ? { team } : {}),
                    ...(objectType ? { objectType } : {}),
                    objectId: normalizedObjectId,
                    versions: new Set(),
                    runCount: 0,
                    errorRuns: 0,
                    lastSeenAt: 0,
                    firstSeenAt: Number.POSITIVE_INFINITY,
                    environments: new Set(),
                    services: new Set(),
                    releases: new Set(),
                    projects: new Set(),
                    runs: [],
                };
                aggregates.set(key, aggregate);
            }
            return aggregate;
        };
        for (const run of this.matchingRuns(normalizedOwner, { ...options, limit: undefined })) {
            if (!run.objectId)
                continue;
            const aggregate = ensureAggregate(run.team, run.objectType, run.objectId);
            if (!aggregate)
                continue;
            aggregate.runs.push(run);
            aggregate.runCount += 1;
            if (run.objectVersion)
                aggregate.versions.add(run.objectVersion);
            if (run.environment)
                aggregate.environments.add(run.environment);
            if (run.service)
                aggregate.services.add(run.service);
            if (run.release)
                aggregate.releases.add(run.release);
            if (run.projectId)
                aggregate.projects.add(run.projectId);
            if (run.status === 'failed' || run.errorSpanCount > 0)
                aggregate.errorRuns += 1;
            aggregate.firstSeenAt = Math.min(aggregate.firstSeenAt, run.firstSpanAt ?? run.createdAt);
            aggregate.lastSeenAt = Math.max(aggregate.lastSeenAt, run.lastSpanAt ?? run.updatedAt);
            if (run.team)
                aggregate.team = run.team;
            if (run.objectType)
                aggregate.objectType = run.objectType;
            if (run.objectName)
                aggregate.objectName = run.objectName;
        }
        const hasTelemetryFilters = options.projectId != null || options.environment != null || options.service != null || options.status != null || options.from != null || options.to != null;
        const mergeProfile = (current, profile) => {
            if (!current)
                return { ...profile, labels: [...profile.labels] };
            const latest = profile.updatedAt >= current.updatedAt ? profile : current;
            return {
                owner: latest.owner,
                team: latest.team ?? current.team,
                objectType: latest.objectType ?? current.objectType,
                objectId: latest.objectId,
                displayName: latest.displayName ?? current.displayName,
                ownerTeam: latest.ownerTeam ?? current.ownerTeam,
                description: latest.description ?? current.description,
                labels: [...new Set([...current.labels, ...profile.labels])].sort(),
                archived: latest.archived,
                createdAt: Math.min(current.createdAt, profile.createdAt),
                updatedAt: Math.max(current.updatedAt, profile.updatedAt),
                updatedBy: latest.updatedBy,
            };
        };
        for (const profile of this.objectProfiles.values()) {
            if (this.governanceTombstones.some((tombstone) => tombstone.accountScopeId === profile.owner &&
                !tombstone.runId &&
                !tombstone.traceId &&
                !tombstone.sessionId)) {
                continue;
            }
            if (!globalOwner && profile.owner !== normalizedOwner)
                continue;
            if (options.team && profile.team !== options.team)
                continue;
            if (options.objectType && profile.objectType !== options.objectType)
                continue;
            if (options.objectId && profile.objectId !== options.objectId)
                continue;
            if (!includeProfileOnly && hasTelemetryFilters)
                continue;
            const aggregate = ensureAggregate(profile.team, profile.objectType, profile.objectId);
            if (!aggregate)
                continue;
            aggregate.profile = mergeProfile(aggregate.profile, profile);
            if (profile.displayName)
                aggregate.objectName = profile.displayName;
            if (profile.team)
                aggregate.team = profile.team;
            if (profile.objectType)
                aggregate.objectType = profile.objectType;
            if (!aggregate.runCount) {
                aggregate.firstSeenAt = profile.createdAt;
                aggregate.lastSeenAt = profile.updatedAt;
            }
            else {
                aggregate.lastSeenAt = Math.max(aggregate.lastSeenAt, profile.updatedAt);
            }
        }
        return aggregates;
    }
    pickAggregateByObjectId(aggregates, objectId, options = {}) {
        const normalizedObjectId = cleanText(objectId, 200);
        if (!normalizedObjectId)
            return null;
        const candidates = [...aggregates.values()].filter((item) => item.objectId === normalizedObjectId);
        if (!candidates.length)
            return null;
        const exact = candidates.find((item) => (!options.team || item.team === options.team) && (!options.objectType || item.objectType === options.objectType));
        if (exact)
            return exact;
        return candidates.sort((a, b) => b.runCount - a.runCount || b.lastSeenAt - a.lastSeenAt || (b.profile?.updatedAt ?? 0) - (a.profile?.updatedAt ?? 0))[0] ?? null;
    }
    objectAggregateToCatalogObject(item) {
        return {
            ...(item.team ? { team: item.team } : {}),
            ...(item.objectType ? { objectType: item.objectType } : {}),
            objectId: item.objectId,
            ...(item.objectName ? { objectName: item.objectName } : {}),
            versions: [...item.versions].sort().slice(-24),
            runCount: item.runCount,
            errorRate: item.runCount ? item.errorRuns / item.runCount : null,
            lastSeenAt: item.lastSeenAt,
            ...(item.profile
                ? {
                    profile: {
                        ...(item.profile.team ? { team: item.profile.team } : {}),
                        ...(item.profile.objectType ? { objectType: item.profile.objectType } : {}),
                        objectId: item.profile.objectId,
                        ...(item.profile.displayName ? { displayName: item.profile.displayName } : {}),
                        ...(item.profile.ownerTeam ? { ownerTeam: item.profile.ownerTeam } : {}),
                        ...(item.profile.description ? { description: item.profile.description } : {}),
                        labels: [...item.profile.labels],
                        archived: item.profile.archived,
                        createdAt: item.profile.createdAt,
                        updatedAt: item.profile.updatedAt,
                        ...(item.profile.updatedBy ? { updatedBy: item.profile.updatedBy } : {}),
                    },
                }
                : {}),
        };
    }
    objectAggregateToDetail(owner, item, options) {
        const team = item.team ?? item.profile?.team;
        const objectType = item.objectType ?? item.profile?.objectType;
        return {
            object: {
                ...(team ? { team } : {}),
                ...(objectType ? { objectType } : {}),
                objectId: item.objectId,
                ...(item.objectName ? { objectName: item.objectName } : {}),
                versions: [...item.versions].sort().slice(-24),
                runCount: item.runCount,
                errorRate: item.runCount ? item.errorRuns / item.runCount : null,
                lastSeenAt: item.lastSeenAt,
                ...(item.profile
                    ? {
                        profile: {
                            ...(item.profile.team ? { team: item.profile.team } : {}),
                            ...(item.profile.objectType ? { objectType: item.profile.objectType } : {}),
                            objectId: item.profile.objectId,
                            ...(item.profile.displayName ? { displayName: item.profile.displayName } : {}),
                            ...(item.profile.ownerTeam ? { ownerTeam: item.profile.ownerTeam } : {}),
                            ...(item.profile.description ? { description: item.profile.description } : {}),
                            labels: [...item.profile.labels],
                            archived: item.profile.archived,
                            createdAt: item.profile.createdAt,
                            updatedAt: item.profile.updatedAt,
                            ...(item.profile.updatedBy ? { updatedBy: item.profile.updatedBy } : {}),
                        },
                    }
                    : {}),
                firstSeenAt: item.runCount ? item.firstSeenAt : (item.profile?.createdAt ?? item.lastSeenAt),
                environments: [...item.environments].sort(),
                services: [...item.services].sort(),
                releases: [...item.releases].sort().slice(-24),
                projects: [...item.projects].sort(),
            },
            summary: this.summarize(owner, {
                ...options,
                team,
                objectType,
                objectId: item.objectId,
            }),
            recentRuns: item.runs.slice(0, 50).map((run) => this.publicRun(run)),
        };
    }
    upsertObject(owner, objectId, input) {
        const normalizedOwner = cleanText(owner, 256);
        const normalizedObjectId = cleanText(objectId, 200);
        const team = cleanText(input.team, 120);
        const objectType = cleanText(input.objectType, 120);
        if (!normalizedOwner || !normalizedObjectId || !team || !objectType) {
            throw new Error('owner, objectId, team and objectType are required.');
        }
        const now = Date.now();
        const key = objectProfileKey(normalizedOwner, team, objectType, normalizedObjectId);
        const existing = this.objectProfiles.get(key);
        const next = {
            owner: normalizedOwner,
            team,
            objectType,
            objectId: normalizedObjectId,
            displayName: existing?.displayName,
            ownerTeam: existing?.ownerTeam,
            description: existing?.description,
            labels: [...(existing?.labels ?? [])],
            archived: existing?.archived ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            updatedBy: normalizedOwner,
        };
        if (input.displayName !== undefined) {
            const displayName = cleanText(input.displayName, 160);
            if (displayName)
                next.displayName = displayName;
            else
                delete next.displayName;
        }
        if (input.ownerTeam !== undefined) {
            const ownerTeam = cleanText(input.ownerTeam, 120);
            if (ownerTeam)
                next.ownerTeam = ownerTeam;
            else
                delete next.ownerTeam;
        }
        if (input.description !== undefined) {
            const description = cleanText(input.description, 2_000);
            if (description)
                next.description = description;
            else
                delete next.description;
        }
        if (input.labels !== undefined) {
            next.labels = normalizeLabelList(input.labels);
        }
        if (input.archived !== undefined) {
            next.archived = Boolean(input.archived);
        }
        this.objectProfiles.set(key, next);
        const aggregate = this.collectObjectAggregates(normalizedOwner, { team, objectType, objectId: normalizedObjectId }, true);
        const selected = this.pickAggregateByObjectId(aggregate, normalizedObjectId, { team, objectType });
        if (!selected) {
            return this.objectAggregateToDetail(normalizedOwner, {
                team,
                objectType,
                objectId: normalizedObjectId,
                objectName: next.displayName,
                versions: new Set(),
                runCount: 0,
                errorRuns: 0,
                lastSeenAt: next.updatedAt,
                firstSeenAt: next.createdAt,
                environments: new Set(),
                services: new Set(),
                releases: new Set(),
                projects: new Set(),
                runs: [],
                profile: next,
            }, { team, objectType, objectId: normalizedObjectId, windowStart: now - 24 * 60 * 60_000, windowEnd: now });
        }
        return this.objectAggregateToDetail(normalizedOwner, selected, {
            team,
            objectType,
            objectId: normalizedObjectId,
            windowStart: now - 24 * 60 * 60_000,
            windowEnd: now,
        });
    }
    listCatalog(owner, options = {}) {
        const includeProfileOnly = options.projectId == null
            && options.environment == null
            && options.service == null
            && options.status == null
            && options.from == null
            && options.to == null;
        const aggregates = this.collectObjectAggregates(owner, options, includeProfileOnly);
        const catalogObjects = [...aggregates.values()]
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.runCount - a.runCount)
            .slice(0, 500)
            .map((item) => this.objectAggregateToCatalogObject(item));
        const runs = this.matchingRuns(owner, { ...options, limit: undefined });
        const teams = new Set();
        const objectTypes = new Set();
        const environments = new Set();
        const services = new Set();
        for (const run of runs) {
            if (run.team)
                teams.add(run.team);
            if (run.objectType)
                objectTypes.add(run.objectType);
            if (run.environment)
                environments.add(run.environment);
            if (run.service)
                services.add(run.service);
        }
        for (const item of aggregates.values()) {
            if (item.team)
                teams.add(item.team);
            if (item.objectType)
                objectTypes.add(item.objectType);
        }
        return {
            generatedAt: Date.now(),
            runCount: runs.length,
            teams: [...teams].sort(),
            objectTypes: [...objectTypes].sort(),
            environments: [...environments].sort(),
            services: [...services].sort(),
            objects: catalogObjects,
        };
    }
    listObjects(owner, options = {}) {
        const aggregates = this.collectObjectAggregates(owner, options, true);
        const q = normalizeSearchText(options.q);
        const ownerTeam = normalizeSearchText(options.ownerTeam);
        const label = normalizeSearchText(options.label);
        const objects = [...aggregates.values()]
            .map((item) => this.objectAggregateToCatalogObject(item))
            .filter((item) => {
            if (options.archived === undefined)
                return true;
            return Boolean(item.profile?.archived) === options.archived;
        })
            .filter((item) => {
            if (!ownerTeam)
                return true;
            const candidates = [item.profile?.ownerTeam, item.team].map((value) => normalizeSearchText(value));
            return candidates.includes(ownerTeam);
        })
            .filter((item) => {
            if (!label)
                return true;
            return (item.profile?.labels ?? []).map((entry) => normalizeSearchText(entry)).includes(label);
        })
            .filter((item) => {
            if (!q)
                return true;
            const haystack = [
                item.objectId,
                item.objectName,
                item.team,
                item.objectType,
                item.profile?.displayName,
                item.profile?.ownerTeam,
                item.profile?.description,
                ...(item.profile?.labels ?? []),
            ]
                .map((value) => normalizeSearchText(value))
                .join(' ');
            return haystack.includes(q);
        })
            .sort((a, b) => (b.profile?.updatedAt ?? b.lastSeenAt) - (a.profile?.updatedAt ?? a.lastSeenAt) || b.lastSeenAt - a.lastSeenAt || b.runCount - a.runCount);
        const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
        return {
            generatedAt: Date.now(),
            total: objects.length,
            limit,
            objects: objects.slice(0, limit),
        };
    }
    getObject(owner, objectId, options = {}) {
        const normalizedObjectId = cleanText(objectId, 200);
        if (!normalizedObjectId)
            return null;
        const aggregates = this.collectObjectAggregates(owner, { ...options, objectId: normalizedObjectId }, true);
        const selected = this.pickAggregateByObjectId(aggregates, normalizedObjectId, options);
        if (!selected)
            return null;
        return this.objectAggregateToDetail(owner, selected, {
            ...options,
            objectId: normalizedObjectId,
        });
    }
    summarize(owner, options = {}) {
        const now = Date.now();
        const windowEnd = Number.isFinite(options.windowEnd) ? Math.trunc(options.windowEnd) : now;
        const windowStart = Number.isFinite(options.windowStart)
            ? Math.trunc(options.windowStart)
            : windowEnd - 24 * 60 * 60_000;
        const runs = this.matchingRuns(owner, {
            ...options,
            from: options.from ?? windowStart,
            to: options.to ?? windowEnd,
            limit: undefined,
        });
        const terminalRuns = runs.filter((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
        const completedRuns = runs.filter((run) => run.status === 'completed').length;
        const failedRuns = runs.filter((run) => run.status === 'failed').length;
        const cancelledRuns = runs.filter((run) => run.status === 'cancelled').length;
        const runningRuns = runs.filter((run) => run.status === 'running' || run.status === 'queued').length;
        const spanCount = runs.reduce((sum, run) => sum + run.spanCount, 0);
        const errorSpanCount = runs.reduce((sum, run) => sum + run.errorSpanCount, 0);
        const durations = runs
            .map((run) => Math.max(0, (run.lastSpanAt ?? run.updatedAt) - (run.firstSpanAt ?? run.createdAt)))
            .sort((a, b) => a - b);
        const percentile = (ratio) => {
            if (!durations.length)
                return null;
            return durations[Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * ratio) - 1))];
        };
        let inputTokens = 0;
        let outputTokens = 0;
        let generationSpanCount = 0;
        let toolSpanCount = 0;
        let feedbackCount = 0;
        let positiveFeedbackCount = 0;
        const scoreTotals = new Map();
        for (const run of runs) {
            feedbackCount += run.feedbackCount;
            positiveFeedbackCount += run.feedback.filter((item) => item.kind === 'up').length;
            for (const score of run.scores) {
                const current = scoreTotals.get(score.name) ?? { total: 0, count: 0 };
                current.total += score.value;
                current.count += 1;
                scoreTotals.set(score.name, current);
            }
            for (const span of run.spans.values()) {
                if (span.kind === 'generation') {
                    generationSpanCount += 1;
                    inputTokens += Number(span.attributes.inputTokens ?? 0) || 0;
                    outputTokens += Number(span.attributes.outputTokens ?? 0) || 0;
                }
                if (span.kind === 'tool')
                    toolSpanCount += 1;
            }
        }
        const totalTerminal = terminalRuns.length;
        return {
            generatedAt: now,
            windowStart,
            windowEnd,
            traffic: {
                runCount: runs.length,
                spanCount,
                averageSpansPerRun: runs.length ? spanCount / runs.length : null,
            },
            reliability: {
                completedRuns,
                failedRuns,
                cancelledRuns,
                runningRuns,
                successRate: totalTerminal ? completedRuns / totalTerminal : null,
                errorRate: runs.length ? failedRuns / runs.length : null,
                errorSpanRate: spanCount ? errorSpanCount / spanCount : null,
            },
            latency: {
                p50Ms: percentile(0.5),
                p95Ms: percentile(0.95),
                maxMs: durations.length ? durations.at(-1) : null,
            },
            saturation: {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                generationSpanCount,
                toolSpanCount,
            },
            quality: {
                scoreCount: [...scoreTotals.values()].reduce((sum, item) => sum + item.count, 0),
                averageScores: Object.fromEntries([...scoreTotals.entries()].map(([name, item]) => [name, item.total / item.count])),
                feedbackCount,
                positiveFeedbackRate: feedbackCount ? positiveFeedbackCount / feedbackCount : null,
            },
        };
    }
    async getRun(owner, runId) {
        this.pruneExpiredRuns();
        const normalizedOwner = cleanText(owner, 256);
        const normalizedRunId = cleanText(runId, 200);
        if (!normalizedOwner || !normalizedRunId)
            return null;
        const existing = this.runs.get(normalizedRunId);
        if (existing) {
            if (existing.owner !== normalizedOwner)
                return null;
            return this.publicRun(existing);
        }
        const trace = await this.getTrace(normalizedOwner, normalizedRunId, 256);
        if (!trace)
            return null;
        const root = trace.find((span) => span.kind === 'agent') ?? trace[0];
        if (!root)
            return null;
        const now = Date.now();
        const record = this.createStoredRun(normalizedOwner, 'recovered', {
            runId: normalizedRunId,
            traceId: root.traceId,
            team: cleanText(root.attributes.team, 120) || undefined,
            objectType: cleanText(root.attributes.objectType, 120) || undefined,
            objectId: cleanText(root.attributes.objectId, 200) || undefined,
            objectName: cleanText(root.attributes.objectName, 160) || undefined,
            objectVersion: cleanText(root.attributes.objectVersion, 120) || undefined,
            projectId: cleanText(root.attributes.projectId, 160) || 'unknown',
            environment: cleanText(root.attributes.environment, 120) || 'unknown',
            service: cleanText(root.attributes.service, 160) || 'unknown',
            release: cleanText(root.attributes.release, 120) || undefined,
            name: cleanText(root.attributes['external.name'] ?? root.name, 120) || normalizedRunId,
            sessionRef: cleanText(root.attributes.sessionRef, 200) || undefined,
            metadata: normalizeScalarMap(root.attributes, PUBLIC_OBSERVABILITY_RUN_METADATA_KEYS),
            status: root.status === 'error' ? 'failed' : 'running',
        });
        record.createdAt = trace[0]?.startTime ?? now;
        record.updatedAt = trace.at(-1)?.endTime ?? now;
        record.firstSpanAt = trace[0]?.startTime;
        record.lastSpanAt = trace.at(-1)?.endTime;
        record.spanCount = trace.length;
        record.errorSpanCount = trace.filter((span) => span.status === 'error').length;
        record.scoreCount = 0;
        record.feedbackCount = 0;
        record.spans = new Map(trace.map((span) => [`${span.traceId}:${span.spanId}`, span]));
        this.upsertStoredRun(record);
        return this.publicRun(record);
    }
    async getTrace(owner, runId, limit = 256) {
        this.pruneExpiredRuns();
        const normalizedOwner = cleanText(owner, 256);
        const normalizedRunId = cleanText(runId, 200);
        if (!normalizedOwner || !normalizedRunId)
            return null;
        if (this.tombstoneCoversLookup(normalizedOwner, normalizedRunId))
            return null;
        const existing = this.runs.get(normalizedRunId);
        if (existing) {
            if (existing.owner !== normalizedOwner)
                return null;
            return [...existing.spans.values()]
                .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
                .slice(0, Math.max(1, Math.min(256, Math.floor(limit))))
                .map((span) => ({ ...span, attributes: { ...span.attributes } }));
        }
        const stored = await getStudioTraceSpansForRun({ runId: normalizedRunId, ownerUserId: normalizedOwner, limit });
        if (!stored)
            return null;
        const publicSpans = stored
            .map(publicSpanFromStudioSpan)
            .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
            .slice(0, Math.max(1, Math.min(256, Math.floor(limit))));
        if (publicSpans.length) {
            const traceId = publicSpans[0].traceId;
            const record = this.createStoredRun(normalizedOwner, 'recovered', {
                runId: normalizedRunId,
                traceId,
                team: cleanText(publicSpans[0].attributes.team, 120) || undefined,
                objectType: cleanText(publicSpans[0].attributes.objectType, 120) || undefined,
                objectId: cleanText(publicSpans[0].attributes.objectId, 200) || undefined,
                objectName: cleanText(publicSpans[0].attributes.objectName, 160) || undefined,
                objectVersion: cleanText(publicSpans[0].attributes.objectVersion, 120) || undefined,
                projectId: cleanText(publicSpans[0].attributes.projectId, 160) || 'unknown',
                environment: cleanText(publicSpans[0].attributes.environment, 120) || 'unknown',
                service: cleanText(publicSpans[0].attributes.service, 160) || 'unknown',
                release: cleanText(publicSpans[0].attributes.release, 120) || undefined,
                name: cleanText(publicSpans[0].attributes['external.name'] ?? publicSpans[0].name, 120) || normalizedRunId,
                metadata: normalizeScalarMap(publicSpans[0].attributes, PUBLIC_OBSERVABILITY_RUN_METADATA_KEYS),
                status: publicSpans.some((span) => span.status === 'error') ? 'failed' : 'running',
            });
            record.spans = new Map(publicSpans.map((span) => [`${span.traceId}:${span.spanId}`, span]));
            record.spanCount = publicSpans.length;
            record.errorSpanCount = publicSpans.filter((span) => span.status === 'error').length;
            record.scoreCount = 0;
            record.feedbackCount = 0;
            record.firstSpanAt = publicSpans[0]?.startTime;
            record.lastSpanAt = publicSpans.at(-1)?.endTime;
            record.createdAt = publicSpans[0]?.startTime ?? Date.now();
            record.updatedAt = publicSpans.at(-1)?.endTime ?? Date.now();
            this.upsertStoredRun(record);
        }
        return publicSpans;
    }
    /** Purge only this process's authoritative account/environment cache partition. */
    purgeTelemetryCache(tombstone) {
        const accountScopeId = cleanText(tombstone.accountScopeId, 256);
        if (!accountScopeId ||
            tombstone.environment !== resolveStudioTraceStoreEnvironment() ||
            (tombstone.userId && cleanText(tombstone.userId, 256) !== accountScopeId)) {
            return { removed: 0, indeterminate: 0 };
        }
        // This cache contains low-sensitivity run/span projections, not payloads.
        if (tombstone.grantId)
            return { removed: 0, indeterminate: 0 };
        this.rememberGovernanceTombstone(tombstone);
        let removed = 0;
        for (const run of [...this.runs.values()]) {
            if (run.owner !== accountScopeId)
                continue;
            if (tombstone.runId && run.runId !== tombstone.runId)
                continue;
            if (tombstone.traceId && run.traceId !== tombstone.traceId)
                continue;
            if (tombstone.sessionId && run.sessionRef !== tombstone.sessionId)
                continue;
            if (this.deleteCachedRun(run.runId))
                removed += 1;
        }
        if (!tombstone.runId && !tombstone.traceId && !tombstone.sessionId) {
            for (const [key, profile] of this.objectProfiles) {
                if (profile.owner === accountScopeId) {
                    this.objectProfiles.delete(key);
                    removed += 1;
                }
            }
        }
        return { removed, indeterminate: 0 };
    }
    async recordScore(input) {
        const run = this.runs.get(cleanText(input.runId, 200));
        if (!run)
            throw new Error('run not found');
        if (!run.owner)
            throw new Error('run not owned');
        const score = {
            scoreId: `score_${crypto.randomUUID().replace(/-/g, '')}`,
            runId: run.runId,
            owner: run.owner,
            name: cleanText(input.name, 120) || 'score',
            value: Number.isFinite(input.value) ? input.value : 0,
            dataType: cleanText(input.dataType, 32) || 'numeric',
            source: cleanText(input.source, 64) || 'manual',
            ...(cleanText(input.comment, 1_000) ? { comment: cleanText(input.comment, 1_000) } : {}),
            createdAt: Date.now(),
        };
        run.scores = [...run.scores, score].slice(-MAX_SCORES_PER_RUN);
        run.scoreCount = run.scores.length;
        run.updatedAt = score.createdAt;
        return score;
    }
    async recordFeedback(input) {
        const run = this.runs.get(cleanText(input.runId, 200));
        if (!run)
            throw new Error('run not found');
        const feedback = {
            feedbackId: `fb_${crypto.randomUUID().replace(/-/g, '')}`,
            runId: run.runId,
            owner: run.owner,
            kind: input.kind,
            ...(cleanText(input.messageId, 200) ? { messageId: cleanText(input.messageId, 200) } : {}),
            ...(cleanText(input.comment, 4_000) ? { comment: cleanText(input.comment, 4_000) } : {}),
            ...(cleanText(input.userMessage, 12_000) ? { userMessage: cleanText(input.userMessage, 12_000) } : {}),
            ...(cleanText(input.assistantMessage, 12_000) ? { assistantMessage: cleanText(input.assistantMessage, 12_000) } : {}),
            ...(cleanText(input.timeline, 24_000) ? { timeline: cleanText(input.timeline, 24_000) } : {}),
            createdAt: Date.now(),
        };
        run.feedback = [...run.feedback, feedback].slice(-MAX_FEEDBACK_PER_RUN);
        run.feedbackCount = run.feedback.length;
        run.updatedAt = feedback.createdAt;
        return feedback;
    }
    async persistAndStoreSpans(run, spans) {
        if (!spans.length)
            return;
        for (const span of spans) {
            const publicSpan = publicSpanFromStudioSpan(span);
            const key = `${publicSpan.traceId}:${publicSpan.spanId}`;
            run.spans.set(key, publicSpan);
        }
        run.status = run.status === 'queued' ? 'running' : run.status;
        run.updatedAt = Date.now();
        this.updateRunStats(run);
        await persistStudioTraceSpans({ spans, ownerUserId: run.owner, runId: run.runId }).catch(() => undefined);
    }
    publicRun(run) {
        return {
            runId: run.runId,
            traceId: run.traceId,
            owner: run.owner,
            keyId: run.keyId,
            ...(run.team ? { team: run.team } : {}),
            ...(run.objectType ? { objectType: run.objectType } : {}),
            ...(run.objectId ? { objectId: run.objectId } : {}),
            ...(run.objectName ? { objectName: run.objectName } : {}),
            ...(run.objectVersion ? { objectVersion: run.objectVersion } : {}),
            projectId: run.projectId,
            environment: run.environment,
            service: run.service,
            ...(run.release ? { release: run.release } : {}),
            ...(run.name ? { name: run.name } : {}),
            ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
            metadata: { ...run.metadata },
            status: run.status,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            ...(run.completedAt ? { completedAt: run.completedAt } : {}),
            ...(run.firstSpanAt ? { firstSpanAt: run.firstSpanAt } : {}),
            ...(run.lastSpanAt ? { lastSpanAt: run.lastSpanAt } : {}),
            spanCount: run.spanCount,
            errorSpanCount: run.errorSpanCount,
            scoreCount: run.scoreCount,
            feedbackCount: run.feedbackCount,
            ...(run.idempotencyKey ? { idempotencyKey: run.idempotencyKey } : {}),
        };
    }
}
const publicObservabilityStore = new PublicObservabilityStore();
export function getPublicObservabilityStore() {
    return publicObservabilityStore;
}
