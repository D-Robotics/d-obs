import { normalizeStudioTraceSpans } from '../../shared/studio-tracing.js';
export function normalizeClientTraceTelemetryBatch(value) {
    return normalizeStudioTraceSpans(value, { source: 'client', now: Date.now() });
}
