/**
 * Read-only, bounded probe for the managed Agent gateway control/data path.
 *
 * It is intentionally opt-in: the probe needs a dedicated canary key and a
 * gateway `/models` URL. The admin credential is never accepted as a model
 * credential, and the result contains only status/latency/category fields.
 */
import { readStudioAgentEnv } from '../agent/studio-agent-env.js';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LATENCY_BUDGET_MS = 1_500;
const MAX_LATENCY_BUDGET_MS = 10_000;
const DEFAULT_TTFT_TIMEOUT_MS = 20_000;
const MAX_TTFT_TIMEOUT_MS = 60_000;
const MAX_TTFT_STREAM_BYTES = 256 * 1024;
export function gatewayProbeLatencyBudgetMs() {
    const configured = Number(readStudioAgentEnv('healthLatencyBudgetMs', process.env, String(DEFAULT_LATENCY_BUDGET_MS)));
    if (!Number.isFinite(configured))
        return DEFAULT_LATENCY_BUDGET_MS;
    return Math.max(250, Math.min(MAX_LATENCY_BUDGET_MS, Math.round(configured)));
}
export function gatewayProbeWithinLatencyBudget(result) {
    return result.configured && result.ok && result.elapsedMs <= gatewayProbeLatencyBudgetMs();
}
function timeoutMs() {
    const value = Number(readStudioAgentEnv('healthTimeoutMs', process.env, String(DEFAULT_TIMEOUT_MS)));
    if (!Number.isFinite(value))
        return DEFAULT_TIMEOUT_MS;
    return Math.max(500, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}
function resolveProbeUrl() {
    const explicit = readStudioAgentEnv('healthUrl');
    if (!explicit)
        return '';
    try {
        const url = new URL(explicit);
        const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (url.protocol !== 'https:' &&
            hostname !== 'localhost' &&
            hostname !== '127.0.0.1' &&
            hostname !== '::1') {
            return '';
        }
        return url.toString();
    }
    catch {
        return '';
    }
}
function resolveProbeKey() {
    return readStudioAgentEnv('healthKey');
}
function ttftProbeEnabled() {
    return String(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_ENABLED ?? '').trim() === '1';
}
function ttftProbeTimeoutMs() {
    const value = Number(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_TIMEOUT_MS ?? DEFAULT_TTFT_TIMEOUT_MS);
    if (!Number.isFinite(value))
        return DEFAULT_TTFT_TIMEOUT_MS;
    return Math.max(2_000, Math.min(MAX_TTFT_TIMEOUT_MS, Math.round(value)));
}
function resolveTtftProbeUrl() {
    const explicit = String(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_URL ?? '').trim();
    if (explicit) {
        try {
            const url = new URL(explicit);
            if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
                return '';
            }
            return url.toString();
        }
        catch {
            return '';
        }
    }
    const modelsUrl = resolveProbeUrl();
    if (!modelsUrl)
        return '';
    try {
        const url = new URL(modelsUrl);
        if (/\/models\/?$/i.test(url.pathname)) {
            url.pathname = url.pathname.replace(/\/models\/?$/i, '/chat/completions');
        }
        else {
            url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
        }
        return url.toString();
    }
    catch {
        return '';
    }
}
function textContent(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    return value
        .map((part) => {
        if (!part || typeof part !== 'object')
            return '';
        const item = part;
        return typeof item.text === 'string' ? item.text : '';
    })
        .join('');
}
function firstVisibleText(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return '';
    const root = payload;
    const choices = Array.isArray(root.choices) ? root.choices : [];
    for (const rawChoice of choices) {
        if (!rawChoice || typeof rawChoice !== 'object' || Array.isArray(rawChoice))
            continue;
        const choice = rawChoice;
        const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
        const message = choice.message && typeof choice.message === 'object'
            ? choice.message
            : null;
        const text = textContent(delta?.content) || textContent(message?.content) || textContent(choice.text);
        if (text.trim())
            return text;
    }
    return '';
}
async function readBodyBounded(response) {
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        return { bytes: declaredLength, complete: false };
    }
    if (!response.body) {
        const body = await response.text();
        const bytes = Buffer.byteLength(body, 'utf8');
        return { bytes, complete: bytes <= MAX_BODY_BYTES };
    }
    const reader = response.body.getReader();
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                return { bytes, complete: true };
            bytes += next.value.byteLength;
            if (bytes > MAX_BODY_BYTES) {
                await reader.cancel();
                return { bytes, complete: false };
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
export async function probeManagedAgentGateway(deps = {}) {
    const startedAt = (deps.now ?? Date.now)();
    const url = resolveProbeUrl();
    const key = resolveProbeKey();
    if (!url || !key) {
        return {
            configured: false,
            ok: false,
            elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
            status: null,
            errorCategory: 'not_configured',
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
        const response = await (deps.fetchImpl ?? fetch)(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            signal: controller.signal,
        });
        const body = await readBodyBounded(response);
        const ok = response.ok && body.complete;
        return {
            configured: true,
            ok,
            elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
            status: response.status,
            ...(ok
                ? {}
                : { errorCategory: body.complete ? 'http' : 'invalid_response' }),
        };
    }
    catch (error) {
        const aborted = controller.signal.aborted;
        return {
            configured: true,
            ok: false,
            elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
            status: null,
            errorCategory: aborted ? 'timeout' : 'network',
        };
    }
    finally {
        clearTimeout(timer);
    }
}
export async function probeManagedAgentGatewayTtft(deps = {}) {
    const startedAt = (deps.now ?? Date.now)();
    if (!ttftProbeEnabled()) {
        return {
            configured: false,
            ok: false,
            elapsedMs: 0,
            firstTextMs: null,
            status: null,
            errorCategory: 'disabled',
        };
    }
    const url = resolveTtftProbeUrl();
    const key = resolveProbeKey();
    if (!url || !key) {
        return {
            configured: false,
            ok: false,
            elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
            firstTextMs: null,
            status: null,
            errorCategory: 'not_configured',
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ttftProbeTimeoutMs());
    let firstTextMs = null;
    try {
        const response = await (deps.fetchImpl ?? fetch)(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${key}`,
                accept: 'text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: String(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_MODEL ?? 'qwen3.6-plus').trim(),
                messages: [{ role: 'user', content: '可靠性拨测，只回复“健康”。' }],
                stream: true,
                temperature: 0,
                max_tokens: 16,
                // Measure the user-visible text path, not provider-internal reasoning
                // tokens. Real Studio runs may enable thinking separately; this canary
                // keeps the gateway transport/first-visible-text SLO deterministic.
                extra_body: { enable_thinking: false },
            }),
            signal: controller.signal,
        });
        if (!response.ok || !response.body) {
            return {
                configured: true,
                ok: false,
                elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
                firstTextMs: null,
                status: response.status,
                errorCategory: response.ok ? 'invalid_response' : 'http',
            };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let bytes = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                bytes += next.value.byteLength;
                if (bytes > MAX_TTFT_STREAM_BYTES) {
                    await reader.cancel();
                    return {
                        configured: true,
                        ok: false,
                        elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
                        firstTextMs,
                        status: response.status,
                        errorCategory: 'invalid_response',
                    };
                }
                pending += decoder.decode(next.value, { stream: true });
                const events = pending.split(/\r?\n\r?\n/);
                pending = events.pop() ?? '';
                for (const event of events) {
                    const data = event
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trimStart())
                        .join('\n')
                        .trim();
                    if (!data || data === '[DONE]')
                        continue;
                    try {
                        if (firstTextMs == null && firstVisibleText(JSON.parse(data))) {
                            firstTextMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
                        }
                    }
                    catch {
                        // Ignore non-JSON SSE comments/heartbeats; a missing text event is
                        // reported as invalid_response after the bounded stream ends.
                    }
                }
            }
            if (pending.trim()) {
                const data = pending
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n')
                    .trim();
                if (data && data !== '[DONE]' && firstTextMs == null) {
                    try {
                        if (firstVisibleText(JSON.parse(data))) {
                            firstTextMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
                        }
                    }
                    catch {
                        // see comment above
                    }
                }
            }
        }
        finally {
            reader.releaseLock();
        }
        const elapsedMs = Math.max(0, (deps.now ?? Date.now)() - startedAt);
        return {
            configured: true,
            ok: firstTextMs != null,
            elapsedMs,
            firstTextMs,
            status: response.status,
            ...(firstTextMs == null ? { errorCategory: 'invalid_response' } : {}),
        };
    }
    catch (error) {
        const aborted = controller.signal.aborted;
        return {
            configured: true,
            ok: false,
            elapsedMs: Math.max(0, (deps.now ?? Date.now)() - startedAt),
            firstTextMs,
            status: null,
            errorCategory: aborted ? 'timeout' : 'network',
        };
    }
    finally {
        clearTimeout(timer);
    }
}
