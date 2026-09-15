/**
 * Production Node console-error telemetry.
 *
 * Many server and worker failures are deliberately caught so the product can
 * degrade gracefully. Historically those paths only wrote stderr and therefore
 * never reached studio_ops_events. This bridge keeps the original console
 * behaviour, emits only a low-sensitivity summary, and always fails open.
 */
import { recordOpsEvent, sanitizeOpsSummary } from './ops-event-store.js';
function safeObjectErrorField(value, key) {
    if (!value || typeof value !== 'object')
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
function safeArgumentText(value) {
    if (value instanceof Error)
        return `${value.name}: ${value.message}`;
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value);
    }
    const name = safeObjectErrorField(value, 'name');
    const message = safeObjectErrorField(value, 'message');
    const code = safeObjectErrorField(value, 'code');
    if (name || message || code) {
        return [name, message, code ? `code=${String(code)}` : ''].filter(Boolean).join(': ');
    }
    if (value === null)
        return 'null';
    if (value === undefined)
        return 'undefined';
    // Never stringify arbitrary objects: they can contain prompts, command args,
    // credentials, cookies, or device payloads.
    return '[Object]';
}
function firstError(args) {
    for (const value of args) {
        if (value instanceof Error)
            return value;
    }
    return null;
}
function topStackFrame(error) {
    if (!error?.stack)
        return '';
    const line = error.stack
        .split(/\r?\n/)
        .slice(1)
        .map((value) => value.trim())
        .find(Boolean);
    return sanitizeOpsSummary(line ?? '', 240);
}
function consoleTag(args) {
    const first = typeof args[0] === 'string' ? args[0] : '';
    return sanitizeOpsSummary(first.match(/^\s*(\[[^\]]{1,80}\])/)?.[1] ?? '', 80);
}
export function buildNodeConsoleErrorOpsEvent(component, args, logLevel = 'error') {
    const first = typeof args[0] === 'string' ? args[0] : '';
    // process-guards already emits a richer process_unhandled_error event.
    if (/^\[process\]\s+(?:unhandledRejection|uncaughtException)\b/.test(first))
        return null;
    // Avoid recursive reporting when the event store itself is unavailable.
    if (/^\[ops-events\]\s+insert failed:/i.test(first))
        return null;
    const summary = sanitizeOpsSummary(args.map(safeArgumentText).join(' '), 500);
    if (!summary)
        return null;
    if (logLevel === 'warn' &&
        !args.some((value) => value instanceof Error) &&
        !/\b(?:error|failed|failure|exception|timeout|unavailable)\b|(?:失败|异常|错误|超时|不可用)/i.test(summary)) {
        return null;
    }
    const error = firstError(args);
    const frame = topStackFrame(error);
    const tag = consoleTag(args);
    const critical = /\b(?:fatal|uncaught|crash(?:ed)?|out of memory|oom)\b/i.test(summary);
    return {
        component,
        eventCode: 'console_error',
        outcome: 'error',
        severityHint: critical ? 'critical' : 'warning',
        safeSummary: summary,
        fingerprintParts: [tag, error?.name, frame, summary],
        metadata: {
            source: 'console_error',
            log_level: logLevel,
            process_role: component,
            error_name: sanitizeOpsSummary(error?.name ?? '', 80),
            top_frame: frame,
            tag,
        },
        dedupeWithinMs: 5 * 60_000,
    };
}
export function installNodeConsoleErrorTelemetry(options) {
    if (!options.force && process.env.NODE_ENV !== 'production')
        return () => { };
    const telemetryGlobal = globalThis;
    if (telemetryGlobal.__rdkNodeConsoleErrorTelemetryRestore) {
        return telemetryGlobal.__rdkNodeConsoleErrorTelemetryRestore;
    }
    const original = console.error;
    const originalWarn = console.warn;
    const recorder = options.recorder ?? recordOpsEvent;
    let emitting = false;
    const patched = (...args) => {
        original.apply(console, args);
        if (emitting)
            return;
        let event = null;
        try {
            event = buildNodeConsoleErrorOpsEvent(options.component, args);
        }
        catch {
            return;
        }
        if (!event)
            return;
        emitting = true;
        try {
            Promise.resolve(recorder(event)).catch(() => undefined);
        }
        catch {
            // Error telemetry must never become a second application error.
        }
        finally {
            emitting = false;
        }
    };
    const patchedWarn = (...args) => {
        originalWarn.apply(console, args);
        if (emitting)
            return;
        let event = null;
        try {
            event = buildNodeConsoleErrorOpsEvent(options.component, args, 'warn');
        }
        catch {
            return;
        }
        if (!event)
            return;
        emitting = true;
        try {
            Promise.resolve(recorder(event)).catch(() => undefined);
        }
        catch {
            // Error telemetry must never become a second application error.
        }
        finally {
            emitting = false;
        }
    };
    console.error = patched;
    console.warn = patchedWarn;
    const restore = () => {
        if (console.error === patched)
            console.error = original;
        if (console.warn === patchedWarn)
            console.warn = originalWarn;
        delete telemetryGlobal.__rdkNodeConsoleErrorTelemetryRestore;
    };
    telemetryGlobal.__rdkNodeConsoleErrorTelemetryRestore = restore;
    return restore;
}
