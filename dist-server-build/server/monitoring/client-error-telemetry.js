import { CLIENT_ERROR_ENVIRONMENTS, CLIENT_ERROR_NON_ACTIONABLE_API_CODES, CLIENT_ERROR_SOURCES, CLIENT_ERROR_TELEMETRY_SCHEMA, } from '../../shared/client-error-telemetry.js';
import { reportClientErrorsToCentral, reportClientErrorsToCentralResult, } from '../central-telemetry-http-client.js';
import { isOpsEventStoreConfigured, recordOpsEvent, sanitizeOpsSummary, } from './ops-event-store.js';
const MAX_BATCH = 20;
const MAX_PAST_CLOCK_SKEW_MS = 7 * 24 * 60 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const sourceSet = new Set(CLIENT_ERROR_SOURCES);
const environmentSet = new Set(CLIENT_ERROR_ENVIRONMENTS);
const nonActionableApiCodeSet = new Set(CLIENT_ERROR_NON_ACTIONABLE_API_CODES);
const runtimeErrorSourceSet = new Set([
    'window_error',
    'console_error',
    'react_boundary',
]);
function text(value, maxLength) {
    return sanitizeOpsSummary(value, maxLength).replace(/((?:(?:https?|file):\/\/|\/)[^\s?#]*)[?#][^\s),;]+/gi, '$1');
}
function slug(value, maxLength) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLength);
}
function route(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return '';
    try {
        const parsed = new URL(raw, 'https://rdk.invalid');
        return parsed.pathname
            .replace(/\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8,}|\d{4,})(?=\/|$)/gi, '/:id')
            .slice(0, 240);
    }
    catch {
        return raw.split(/[?#]/, 1)[0].slice(0, 240);
    }
}
function occurredAt(value) {
    const parsed = Date.parse(String(value ?? ''));
    const now = Date.now();
    if (!Number.isFinite(parsed) ||
        parsed < now - MAX_PAST_CLOCK_SKEW_MS ||
        parsed > now + MAX_FUTURE_CLOCK_SKEW_MS) {
        return new Date(now).toISOString();
    }
    return new Date(parsed).toISOString();
}
function topFrame(stack) {
    const lines = String(stack ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const frame = lines.find((line) => /^at\s+/i.test(line) || /^[^@\s]+@(?:(?:https?|file):\/\/|webpack:|\/)/i.test(line)) ?? '';
    return text(frame
        .replace(/\/Users\/[^/]+/gi, '/Users/[USER]')
        .replace(/[A-Z]:\\Users\\[^\\]+/gi, 'C:\\Users\\[USER]')
        .replace(/((?:https?|file):\/\/[^?\s]*)[?#][^\s)]+/gi, '$1'), 240);
}
export function normalizeClientErrorTelemetryEvent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const raw = input;
    const source = String(raw.source ?? '');
    if (!sourceSet.has(source))
        return null;
    const message = text(raw.message, 400) || 'unknown client error';
    const status = Number(raw.status);
    const occurrences = Number(raw.occurrences);
    const environment = slug(raw.environment, 32);
    return {
        schema: CLIENT_ERROR_TELEMETRY_SCHEMA,
        source: source,
        occurredAt: occurredAt(raw.occurredAt),
        message,
        ...(text(raw.errorName, 80) ? { errorName: text(raw.errorName, 80) } : {}),
        ...(topFrame(raw.stack) ? { stack: topFrame(raw.stack) } : {}),
        ...(route(raw.route) ? { route: route(raw.route) } : {}),
        ...(slug(raw.release, 64) ? { release: slug(raw.release, 64) } : {}),
        ...(slug(raw.clientType, 32) ? { clientType: slug(raw.clientType, 32) } : {}),
        ...(environmentSet.has(environment)
            ? { environment: environment }
            : {}),
        ...(Number.isInteger(status) && status >= 0 && status <= 599 ? { status } : {}),
        ...(slug(raw.code, 80) ? { code: slug(raw.code, 80) } : {}),
        ...(raw.fatal === true ? { fatal: true } : {}),
        ...(Number.isFinite(occurrences)
            ? { occurrences: Math.max(1, Math.min(100, Math.floor(occurrences))) }
            : {}),
    };
}
export function normalizeClientErrorTelemetryBatch(input) {
    const rawEvents = input && typeof input === 'object' && !Array.isArray(input)
        ? input.events
        : undefined;
    if (!Array.isArray(rawEvents))
        return [];
    return rawEvents
        .slice(0, MAX_BATCH)
        .map(normalizeClientErrorTelemetryEvent)
        .filter((event) => event !== null);
}
export function isOperationalClientError(event) {
    if (event.environment === 'development' || event.environment === 'test')
        return false;
    const message = String(event.message ?? '');
    const code = String(event.code ?? '').trim();
    const route = String(event.route ?? '');
    const surface = `${message}\n${route}`;
    if (/\[vite\]|localhost:5173|requested module ['"]\/src\/|resource failed to load:\s*\/src\//i.test(surface)) {
        return false;
    }
    if (event.source === 'resource_error' &&
        !/(?:^|\/)assets\/|\.(?:m?js|css|wasm)(?:[?#]|$)/i.test(route || message)) {
        return false;
    }
    if (event.source === 'electron_child_gone' &&
        (['15', 'sigterm'].includes(code.toLowerCase()) || /signal\s*=\s*SIGTERM/i.test(message)) &&
        /\b(?:killed|sigterm)\b/i.test(message)) {
        return false;
    }
    if ((event.source === 'electron_child_gone' || event.source === 'electron_renderer_gone') &&
        code === '1073807364' &&
        /\b(?:killed|embedded server exited)\b/i.test(message)) {
        return false;
    }
    if (event.source === 'electron_load_failure' &&
        code === '-3' &&
        /\bERR_ABORTED\b/i.test(message)) {
        return false;
    }
    if (/No handler registered for ['"]rdk:(?:client-errors-drain|get-pending-desktop-update)['"]/i.test(message)) {
        return false;
    }
    if (event.source === 'api_error') {
        if (nonActionableApiCodeSet.has(String(event.code ?? '').toLowerCase()))
            return false;
        return event.status === 0 || (event.status ?? 0) >= 500;
    }
    return true;
}
/** Normalize the batch once so the boolean and structured compatibility seams share the same policy. */
function dedupeOperationalEvents(events) {
    if (!events.length)
        return null;
    const operationalEvents = events.filter(isOperationalClientError);
    if (!operationalEvents.length)
        return [];
    const uniqueEvents = new Map();
    for (const event of operationalEvents) {
        const key = JSON.stringify([
            runtimeErrorSourceSet.has(event.source) ? 'runtime_error' : event.source,
            event.errorName,
            event.route,
            event.code,
            event.stack,
            event.status,
            event.message,
        ]);
        const previous = uniqueEvents.get(key);
        if (!previous) {
            uniqueEvents.set(key, event);
            continue;
        }
        uniqueEvents.set(key, {
            ...(event.source === 'react_boundary' ? event : previous),
            occurrences: Math.max(previous.occurrences ?? 1, event.occurrences ?? 1),
        });
    }
    return [...uniqueEvents.values()];
}
async function persistOperationalEventsToOps(dedupedEvents, ssoUserId) {
    const results = await Promise.all(dedupedEvents.map((event) => {
        // 版本归因：仅把形态合法的 release（semver 形）提升为统一 app_version 维度；
        // 'latest-dev' 这类非版本字符串不进入归因字段，避免污染按版本聚合的错误视图。
        const release = String(event.release ?? '').trim();
        const appVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release) ? release : null;
        return recordOpsEvent({
            component: `client-${event.clientType || 'unknown'}`,
            eventCode: 'client_error',
            outcome: 'error',
            severityHint: event.fatal ? 'critical' : 'warning',
            safeSummary: `${event.source}: ${event.message}`,
            fingerprintParts: [
                runtimeErrorSourceSet.has(event.source) ? 'runtime_error' : event.source,
                event.errorName,
                event.route,
                event.code,
                event.stack,
                event.status,
            ],
            metadata: {
                source: event.source,
                error_name: event.errorName,
                route: event.route,
                release: event.release,
                app_version: appVersion,
                client_type: event.clientType,
                environment: event.environment,
                status: event.status,
                code: event.code,
                top_frame: event.stack,
                fatal: event.fatal === true,
                operational: isOperationalClientError(event),
                occurrence_count: event.occurrences ?? 1,
            },
            correlation: {
                userId: ssoUserId,
                clientType: event.clientType,
                appVersion,
            },
            occurredAt: event.occurredAt,
            dedupeWithinMs: 5 * 60_000,
        });
    }));
    return results.every(Boolean);
}
async function persistPreparedClientErrorTelemetryResult(dedupedEvents, ssoUserId) {
    if (!dedupedEvents.length) {
        return { ok: true, authExpired: false, retryable: false };
    }
    if (!isOpsEventStoreConfigured()) {
        return reportClientErrorsToCentralResult(ssoUserId, dedupedEvents);
    }
    try {
        const ok = await persistOperationalEventsToOps(dedupedEvents, ssoUserId);
        return ok
            ? { ok: true, authExpired: false, retryable: false }
            : { ok: false, authExpired: false, retryable: true, reason: 'unavailable' };
    }
    catch {
        // Error telemetry is a side channel. A local store failure must be
        // represented as retryable rather than escaping the request handler.
        return { ok: false, authExpired: false, retryable: true, reason: 'unavailable' };
    }
}
/** Structured result used by the relay route to distinguish auth expiry from outages. */
export async function persistClientErrorTelemetryResult(events, ssoUserId) {
    const dedupedEvents = dedupeOperationalEvents(events);
    if (dedupedEvents === null) {
        return { ok: false, authExpired: false, retryable: false, reason: 'unavailable' };
    }
    return persistPreparedClientErrorTelemetryResult(dedupedEvents, ssoUserId);
}
/**
 * Legacy boolean API retained for existing callers. Keep the direct central
 * call here so older integrations/mocks continue to observe the same seam.
 */
export async function persistClientErrorTelemetry(events, ssoUserId) {
    const dedupedEvents = dedupeOperationalEvents(events);
    if (dedupedEvents === null)
        return false;
    if (!dedupedEvents.length)
        return true;
    if (!isOpsEventStoreConfigured()) {
        return reportClientErrorsToCentral(ssoUserId, dedupedEvents);
    }
    return persistOperationalEventsToOps(dedupedEvents, ssoUserId);
}
