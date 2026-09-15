export const PUBLIC_OBSERVABILITY_SPAN_SCHEMA = 'rdk.public.observability.span.v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RUN_FIELDS = 24;
const MAX_SPANS_PER_BATCH = 64;
export class PublicObservabilityApiError extends Error {
    status;
    code;
    retryable;
    safeForUser;
    details;
    url;
    method;
    responseBody;
    responseJson;
    constructor(message, options) {
        super(message);
        this.name = 'PublicObservabilityApiError';
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable ?? options.status >= 500;
        this.safeForUser = options.safeForUser === true ? true : undefined;
        this.details = options.details;
        this.url = options.url;
        this.method = options.method;
        this.responseBody = options.responseBody;
        this.responseJson = options.responseJson;
    }
}
function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function cleanText(value, max = 256) {
    return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}
function normalizeBaseUrl(baseUrl) {
    const url = new URL(cleanText(baseUrl, 2_048));
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Public observability baseUrl must use http or https.');
    }
    url.pathname = url.pathname.replace(/\/?$/, '/');
    return url;
}
function normalizeAuthorizationHeader(value) {
    const text = cleanText(value, 4_096);
    if (!text)
        throw new Error('Public observability authorization is required.');
    if (/^[A-Za-z][A-Za-z0-9_-]*\s+/.test(text))
        return text;
    return `Bearer ${text}`;
}
async function resolveAuthorizationHeader(authorization) {
    const value = typeof authorization === 'function' ? await authorization() : authorization;
    return normalizeAuthorizationHeader(String(value ?? ''));
}
function asTimestamp(value) {
    if (value instanceof Date)
        return Number.isFinite(value.getTime()) ? String(value.getTime()) : '';
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(Math.trunc(value)) : '';
    return cleanText(value, 64);
}
function finiteInteger(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}
function finiteNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return parsed;
}
function compactScalarMap(value, maxEntries = MAX_RUN_FIELDS) {
    if (!isObject(value))
        return undefined;
    const result = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, maxEntries)) {
        const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
        if (!key)
            continue;
        if (typeof rawValue === 'string') {
            const text = cleanText(rawValue, 1_000);
            if (text)
                result[key] = text;
        }
        else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
            result[key] = rawValue;
        }
        else if (typeof rawValue === 'boolean') {
            result[key] = rawValue;
        }
    }
    return Object.keys(result).length ? result : undefined;
}
function compactStringList(value, maxEntries = 16, maxLength = 64) {
    if (!Array.isArray(value))
        return undefined;
    const result = [...new Set(value
            .filter((item) => typeof item === 'string')
            .map((item) => cleanText(item, maxLength))
            .filter(Boolean))].slice(0, maxEntries);
    return result.length ? result : undefined;
}
function compactObject(value) {
    const result = {};
    for (const [key, rawValue] of Object.entries(value)) {
        if (rawValue === undefined || rawValue === null || rawValue === '')
            continue;
        result[key] = rawValue;
    }
    return result;
}
function normalizeRunInput(input) {
    return compactObject({
        ...(input.runId ? { runId: cleanText(input.runId, 200) } : {}),
        ...(input.traceId ? { traceId: cleanText(input.traceId, 64) } : {}),
        ...(input.team ? { team: cleanText(input.team, 120) } : {}),
        ...(input.objectType ? { objectType: cleanText(input.objectType, 120) } : {}),
        ...(input.objectId ? { objectId: cleanText(input.objectId, 200) } : {}),
        ...(input.objectName ? { objectName: cleanText(input.objectName, 160) } : {}),
        ...(input.objectVersion ? { objectVersion: cleanText(input.objectVersion, 120) } : {}),
        ...(input.projectId ? { projectId: cleanText(input.projectId, 160) } : {}),
        ...(input.environment ? { environment: cleanText(input.environment, 120) } : {}),
        ...(input.service ? { service: cleanText(input.service, 160) } : {}),
        ...(input.release ? { release: cleanText(input.release, 120) } : {}),
        ...(input.name ? { name: cleanText(input.name, 120) } : {}),
        ...(input.sessionRef ? { sessionRef: cleanText(input.sessionRef, 200) } : {}),
        ...(input.metadata ? { metadata: compactScalarMap(input.metadata) ?? {} } : {}),
        ...(input.status ? { status: input.status } : {}),
    });
}
function normalizeObjectUpdateInput(input) {
    return compactObject({
        team: cleanText(input.team, 120),
        objectType: cleanText(input.objectType, 120),
        ...(input.displayName ? { displayName: cleanText(input.displayName, 160) } : {}),
        ...(input.ownerTeam ? { ownerTeam: cleanText(input.ownerTeam, 120) } : {}),
        ...(input.description ? { description: cleanText(input.description, 2_000) } : {}),
        ...(input.labels ? { labels: compactStringList(input.labels) ?? [] } : {}),
        ...(input.archived !== undefined ? { archived: Boolean(input.archived) } : {}),
    });
}
function randomHex(bytes) {
    const crypto = globalThis.crypto;
    if (crypto?.getRandomValues) {
        const chunk = new Uint8Array(bytes);
        crypto.getRandomValues(chunk);
        return [...chunk].map((part) => part.toString(16).padStart(2, '0')).join('');
    }
    return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}
function normalizeSpanInput(input) {
    const startTime = finiteNumber(input.startTime, 'span.startTime');
    const endTime = finiteNumber(input.endTime, 'span.endTime');
    if (endTime < startTime) {
        throw new Error('span.endTime must be greater than or equal to span.startTime.');
    }
    return compactObject({
        schema: PUBLIC_OBSERVABILITY_SPAN_SCHEMA,
        traceId: cleanText(input.traceId, 64),
        spanId: cleanText(input.spanId || randomHex(8), 16),
        ...(input.parentSpanId ? { parentSpanId: cleanText(input.parentSpanId, 16) } : {}),
        source: input.source ?? 'server',
        kind: input.kind ?? 'custom',
        name: cleanText(input.name, 80),
        startTime: Math.trunc(startTime),
        endTime: Math.trunc(endTime),
        status: input.status ?? 'ok',
        ...(input.statusMessage ? { statusMessage: cleanText(input.statusMessage, 160) } : {}),
        ...(input.attributes ? { attributes: compactScalarMap(input.attributes) ?? {} } : {}),
    });
}
function normalizeListQuery(query) {
    const result = {};
    if (query.team)
        result.team = cleanText(query.team, 120);
    if (query.objectType)
        result.objectType = cleanText(query.objectType, 120);
    if (query.objectId)
        result.objectId = cleanText(query.objectId, 200);
    if (query.objectVersion)
        result.objectVersion = cleanText(query.objectVersion, 120);
    if (query.projectId)
        result.projectId = cleanText(query.projectId, 160);
    if (query.environment)
        result.environment = cleanText(query.environment, 120);
    if (query.service)
        result.service = cleanText(query.service, 160);
    if (query.status)
        result.status = query.status;
    if (query.from !== undefined)
        result.from = asTimestamp(query.from);
    if (query.to !== undefined)
        result.to = asTimestamp(query.to);
    if (query.limit !== undefined) {
        const limit = finiteInteger(query.limit);
        if (limit !== undefined)
            result.limit = String(limit);
    }
    if (query.windowMinutes !== undefined) {
        const windowMinutes = finiteInteger(query.windowMinutes);
        if (windowMinutes !== undefined)
            result.windowMinutes = String(windowMinutes);
    }
    return result;
}
function normalizeObjectListQuery(query) {
    const result = normalizeListQuery(query);
    if (query.q)
        result.q = cleanText(query.q, 120);
    if (query.ownerTeam)
        result.ownerTeam = cleanText(query.ownerTeam, 120);
    if (query.label)
        result.label = cleanText(query.label, 64);
    if (query.archived !== undefined)
        result.archived = query.archived ? 'true' : 'false';
    return result;
}
function normalizeObservedSpanInput(input, traceId, startTime, endTime, status, statusMessage) {
    return {
        traceId,
        ...(input.parentSpanId ? { parentSpanId: cleanText(input.parentSpanId, 16) } : {}),
        source: input.source ?? 'server',
        kind: input.kind ?? 'custom',
        name: cleanText(input.name, 80) || 'observability.step',
        startTime,
        endTime,
        status,
        ...(statusMessage ? { statusMessage: cleanText(statusMessage, 160) } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
    };
}
function parseJson(text) {
    if (!text.trim())
        return undefined;
    return JSON.parse(text);
}
function unwrapEnvelope(payload) {
    if (isObject(payload) && payload.ok === true && 'data' in payload) {
        return payload.data;
    }
    return payload;
}
function parseErrorFields(payload) {
    if (!isObject(payload)) {
        return { code: 'PUBLIC_OBSERVABILITY_HTTP_ERROR', message: 'Request failed.' };
    }
    const code = cleanText(payload.code ?? payload.errorCode ?? payload.error, 128) || 'PUBLIC_OBSERVABILITY_HTTP_ERROR';
    const message = cleanText(payload.message ?? payload.error ?? payload.detail, 2_000) || 'Request failed.';
    const retryable = typeof payload.retryable === 'boolean' ? payload.retryable : undefined;
    const safeForUser = payload.safeForUser === true ? true : undefined;
    const details = isObject(payload.details) ? payload.details : undefined;
    return { code, message, retryable, safeForUser, details };
}
function timeoutPromise(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return { clear() { } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${Math.trunc(ms)}ms`)), ms);
    return {
        signal: controller.signal,
        clear() {
            clearTimeout(timer);
        },
    };
}
export async function observePublicRun(client, input, work) {
    const { operationName, spanKind = 'agent', source = 'server', ...runInput } = input;
    const created = await client.createRun(runInput);
    const runStartAt = Date.now();
    const spanName = cleanText(operationName ?? runInput.name ?? created.run.name ?? created.run.objectName ?? created.run.runId, 80) || created.run.runId;
    const context = {
        run: created.run,
        span: async (spanInput, spanWork) => {
            const spanStart = Date.now();
            try {
                const result = await spanWork();
                await client.appendSpans(created.run.runId, {
                    traceId: created.run.traceId,
                    source: spanInput.source ?? source,
                    run: runInput,
                    spans: [
                        normalizeObservedSpanInput(spanInput, created.run.traceId, spanStart, Date.now(), 'ok'),
                    ],
                });
                return result;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                try {
                    await client.appendSpans(created.run.runId, {
                        traceId: created.run.traceId,
                        source: spanInput.source ?? source,
                        run: runInput,
                        spans: [
                            normalizeObservedSpanInput(spanInput, created.run.traceId, spanStart, Date.now(), 'error', message),
                        ],
                    });
                }
                catch {
                    // best-effort span capture; preserve the original failure
                }
                throw error;
            }
        },
        recordScore: (score) => client.recordScore(created.run.runId, score),
        recordFeedback: (feedback) => client.recordFeedback(created.run.runId, feedback),
    };
    try {
        const result = await work(context);
        const completedAt = Date.now();
        const finalized = await client.appendSpans(created.run.runId, {
            traceId: created.run.traceId,
            source,
            status: 'completed',
            completedAt,
            run: runInput,
            spans: [
                normalizeObservedSpanInput({
                    name: spanName,
                    kind: spanKind,
                    source,
                }, created.run.traceId, runStartAt, completedAt, 'ok'),
            ],
        });
        return { run: finalized.run, result };
    }
    catch (error) {
        const failedAt = Date.now();
        try {
            await client.appendSpans(created.run.runId, {
                traceId: created.run.traceId,
                source,
                status: 'failed',
                completedAt: failedAt,
                run: runInput,
                spans: [
                    normalizeObservedSpanInput({
                        name: spanName,
                        kind: spanKind,
                        source,
                    }, created.run.traceId, runStartAt, failedAt, 'error', error instanceof Error ? error.message : String(error)),
                ],
            });
        }
        catch {
            // best-effort finalization; preserve the original failure
        }
        throw error;
    }
}
export function createPublicObservabilityClient(options) {
    const baseUrl = normalizeBaseUrl(options.baseUrl).toString();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('fetch is not available in this environment.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const defaultHeaders = new Headers(options.headers ?? {});
    let client;
    async function requestJson(method, path, init = {}) {
        const url = new URL(path.replace(/^\//, ''), baseUrl);
        if (init.query) {
            for (const [key, value] of Object.entries(init.query)) {
                if (value !== undefined && value !== '')
                    url.searchParams.set(key, value);
            }
        }
        const headers = new Headers(defaultHeaders);
        headers.set('Authorization', await resolveAuthorizationHeader(options.authorization));
        headers.set('Accept', 'application/json');
        if (init.body !== undefined)
            headers.set('Content-Type', 'application/json');
        if (init.extraHeaders) {
            const extra = new Headers(init.extraHeaders);
            extra.forEach((value, key) => headers.set(key, value));
        }
        const timeout = timeoutPromise(timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method,
                headers,
                ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
                ...(timeout.signal ? { signal: timeout.signal } : {}),
            });
            const responseText = await response.text();
            let parsed = undefined;
            if (responseText) {
                try {
                    parsed = parseJson(responseText);
                }
                catch {
                    throw new PublicObservabilityApiError('The server returned a non-JSON response.', {
                        status: response.status,
                        code: 'PUBLIC_OBSERVABILITY_INVALID_RESPONSE',
                        retryable: response.status >= 500,
                        url: url.toString(),
                        method,
                        responseBody: responseText.slice(0, 8_192),
                    });
                }
            }
            if (!response.ok) {
                const errorFields = parseErrorFields(parsed);
                throw new PublicObservabilityApiError(errorFields.message, {
                    status: response.status,
                    code: errorFields.code,
                    retryable: errorFields.retryable ?? response.status >= 500,
                    safeForUser: errorFields.safeForUser,
                    details: errorFields.details,
                    url: url.toString(),
                    method,
                    responseBody: responseText || undefined,
                    responseJson: parsed,
                });
            }
            const payload = unwrapEnvelope(parsed);
            return {
                data: payload,
                response,
            };
        }
        catch (error) {
            if (error instanceof PublicObservabilityApiError)
                throw error;
            if (error instanceof Error && error.name === 'AbortError') {
                throw new PublicObservabilityApiError(`Request timed out after ${Math.trunc(timeoutMs)}ms.`, {
                    status: 0,
                    code: 'PUBLIC_OBSERVABILITY_REQUEST_TIMEOUT',
                    retryable: true,
                    url: url.toString(),
                    method,
                });
            }
            if (error instanceof Error && /fetch failed|networkerror|load failed/i.test(error.message)) {
                throw new PublicObservabilityApiError(error.message || 'Network error.', {
                    status: 0,
                    code: 'PUBLIC_OBSERVABILITY_NETWORK_ERROR',
                    retryable: true,
                    url: url.toString(),
                    method,
                });
            }
            throw error;
        }
        finally {
            timeout.clear();
        }
    }
    client = {
        baseUrl,
        async createRun(input) {
            const { data, response } = await requestJson('POST', '/api/v1/observability/runs', {
                body: normalizeRunInput(input),
                extraHeaders: input.idempotencyKey ? { 'Idempotency-Key': cleanText(input.idempotencyKey, 256) } : undefined,
            });
            return {
                ...data,
                replayed: response.headers.get('idempotent-replayed') === 'true' || response.status === 202,
            };
        },
        async appendSpans(runId, input) {
            const spans = input.spans.slice(0, MAX_SPANS_PER_BATCH).map((span) => normalizeSpanInput(span));
            const { data } = await requestJson('POST', `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/spans:batch`, {
                body: compactObject({
                    ...(input.traceId ? { traceId: cleanText(input.traceId, 64) } : {}),
                    ...(input.source ? { source: input.source } : {}),
                    ...(input.status ? { status: input.status } : {}),
                    ...(input.completedAt !== undefined ? { completedAt: asTimestamp(input.completedAt) } : {}),
                    ...(input.run ? { run: normalizeRunInput(input.run) } : {}),
                    spans,
                }),
            });
            return data;
        },
        async listRuns(query = {}) {
            const { data } = await requestJson('GET', '/api/v1/observability/runs', {
                query: normalizeListQuery(query),
            });
            return data;
        },
        async listCatalog(query = {}) {
            const { data } = await requestJson('GET', '/api/v1/observability/catalog', {
                query: normalizeListQuery(query),
            });
            return data;
        },
        async listObjects(query = {}) {
            const { data } = await requestJson('GET', '/api/v1/observability/objects', {
                query: normalizeObjectListQuery(query),
            });
            return data;
        },
        async getSummary(query = {}) {
            const { data } = await requestJson('GET', '/api/v1/observability/summary', {
                query: normalizeListQuery(query),
            });
            return data;
        },
        async getObject(objectId, query = {}) {
            const normalizedObjectId = cleanText(objectId, 200);
            if (!normalizedObjectId)
                throw new Error('objectId is required.');
            const { data } = await requestJson('GET', `/api/v1/observability/objects/${encodeURIComponent(normalizedObjectId)}`, { query: normalizeListQuery({ ...query, objectId: normalizedObjectId }) });
            return data;
        },
        async updateObject(objectId, input) {
            const normalizedObjectId = cleanText(objectId, 200);
            if (!normalizedObjectId)
                throw new Error('objectId is required.');
            const { data } = await requestJson('PATCH', `/api/v1/observability/objects/${encodeURIComponent(normalizedObjectId)}`, {
                body: normalizeObjectUpdateInput(input),
            });
            return data;
        },
        async getRun(runId) {
            const { data } = await requestJson('GET', `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}`);
            return data;
        },
        async getTrace(runId, options = {}) {
            const limit = options.limit === undefined ? undefined : finiteInteger(options.limit);
            const { data } = await requestJson('GET', `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/trace`, {
                query: limit === undefined ? undefined : { limit: String(limit) },
            });
            return data;
        },
        async recordScore(runId, input) {
            const value = finiteNumber(input.value, 'score.value');
            const { data } = await requestJson('POST', `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/scores`, {
                body: compactObject({
                    name: cleanText(input.name, 120),
                    value,
                    ...(input.dataType ? { dataType: cleanText(input.dataType, 32) } : {}),
                    ...(input.source ? { source: cleanText(input.source, 64) } : {}),
                    ...(input.comment ? { comment: cleanText(input.comment, 1_000) } : {}),
                }),
            });
            return data;
        },
        async recordFeedback(runId, input) {
            const { data } = await requestJson('POST', `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/feedback`, {
                body: compactObject({
                    kind: input.kind,
                    ...(input.messageId ? { messageId: cleanText(input.messageId, 160) } : {}),
                    ...(input.comment ? { comment: cleanText(input.comment, 4_000) } : {}),
                    ...(input.userMessage ? { userMessage: cleanText(input.userMessage, 12_000) } : {}),
                    ...(input.assistantMessage ? { assistantMessage: cleanText(input.assistantMessage, 12_000) } : {}),
                    ...(input.timeline ? { timeline: cleanText(input.timeline, 24_000) } : {}),
                }),
            });
            return data;
        },
        async observeRun(input, work) {
            return observePublicRun(client, input, work);
        },
    };
    return client;
}
