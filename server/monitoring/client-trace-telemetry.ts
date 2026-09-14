import { normalizeStudioTraceSpans, type StudioTraceSpan } from '../../shared/studio-tracing.js';

export function normalizeClientTraceTelemetryBatch(value: unknown): StudioTraceSpan[] {
  return normalizeStudioTraceSpans(value, { source: 'client', now: Date.now() });
}