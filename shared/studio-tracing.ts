/**
 * Low-sensitivity distributed trace contract shared by the Studio browser and server.
 * Payloads intentionally exclude prompts, responses, URLs with query strings, session ids,
 * tool arguments/results, stack traces, credentials, and raw account/device identifiers.
 */

export const STUDIO_TRACE_SPAN_SCHEMA = 'rdk.studio.trace-span.v1' as const;
export const STUDIO_TRACE_BATCH_MAX = 64;

export type StudioTraceSource = 'client' | 'server';
export type StudioTraceStatus = 'ok' | 'error';

export interface StudioTraceSpan {
  schema: typeof STUDIO_TRACE_SPAN_SCHEMA;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  source: StudioTraceSource;
  name: string;
  startTime: number;
  endTime: number;
  status: StudioTraceStatus;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const SERVER_SPAN_NAMES = new Set([
  'moss.session',
  'moss.agent.turn',
  'moss.llm.request',
  'moss.tool.invoke',
]);
const CLIENT_SPAN_NAMES = new Set(['studio.agent_chat', 'http.client']);
const SERVER_ATTRIBUTE_KEYS = new Set([
  'model',
  'turn',
  'inputTokens',
  'outputTokens',
  'toolName',
  'team',
  'objectType',
  'objectId',
  'objectName',
  'objectVersion',
  'is_error',
  'outcome',
  'outcome_kind',
  'projectId',
  'service',
  'environment',
  'release',
  'sessionRef',
  'external.name',
  'external.kind',
]);
const CLIENT_ATTRIBUTE_KEYS = new Set([
  'route',
  'method',
  'http.status_code',
  'retry.attempt',
  'client.type',
  'client.release',
  'stream.outcome',
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
]);

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function isValidStudioTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID_RE.test(value) && !/^0+$/.test(value);
}

export function isValidStudioSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID_RE.test(value) && !/^0+$/.test(value);
}

function normalizeAttributes(
  value: unknown,
  source: StudioTraceSource,
): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = source === 'client' ? CLIENT_ATTRIBUTE_KEYS : SERVER_ATTRIBUTE_KEYS;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof raw === 'string') {
      const text = safeText(raw, 160);
      if (text) result[key] = text;
    } else if (typeof raw === 'boolean') {
      result[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      result[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, raw));
    }
  }
  return result;
}

export function normalizeStudioTraceSpans(
  value: unknown,
  options: {
    source?: StudioTraceSource;
    runId?: string;
    now?: number;
    max?: number;
  } = {},
): StudioTraceSpan[] {
  if (!Array.isArray(value)) return [];
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const max = Math.max(1, Math.min(STUDIO_TRACE_BATCH_MAX, options.max ?? STUDIO_TRACE_BATCH_MAX));
  const boundedInput = value.slice(0, max);
  const latestClientEnd =
    options.source === 'client'
      ? Math.max(
          ...boundedInput
            .map((item) =>
              item && typeof item === 'object' && !Array.isArray(item)
                ? Number((item as Record<string, unknown>).endTime)
                : Number.NaN,
            )
            .filter(Number.isFinite),
        )
      : Number.NaN;
  const clientClockShift =
    Number.isFinite(latestClientEnd) && Math.abs(latestClientEnd - now) > 5 * 60_000
      ? now - latestClientEnd
      : 0;
  const result: StudioTraceSpan[] = [];
  for (const raw of boundedInput) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const source =
      options.source ??
      (item.source === 'client' ? 'client' : item.source === 'server' ? 'server' : null);
    if (!source) continue;
    const name = safeText(item.name, 80);
    if (!(source === 'client' ? CLIENT_SPAN_NAMES : SERVER_SPAN_NAMES).has(name)) continue;
    const traceId = safeText(item.traceId, 32).toLowerCase();
    const spanId = safeText(item.spanId, 16).toLowerCase();
    const parentSpanId = safeText(item.parentSpanId, 16).toLowerCase();
    const runId = safeText(options.runId ?? item.runId, 200);
    if (!isValidStudioTraceId(traceId) || !isValidStudioSpanId(spanId) || !runId) continue;
    if (parentSpanId && !isValidStudioSpanId(parentSpanId)) continue;
    let startTime = Math.trunc(Number(item.startTime));
    let endTime = Math.trunc(Number(item.endTime));
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) continue;
    const duration = Math.min(24 * 60 * 60_000, endTime - startTime);
    if (source === 'client' && clientClockShift !== 0) {
      // A browser clock can be wrong. Preserve monotonic duration while anchoring the
      // waterfall near server receipt time so one bad clock cannot flatten every span.
      startTime += clientClockShift;
      endTime = startTime + duration;
    } else {
      endTime = startTime + duration;
    }
    const status: StudioTraceStatus = item.status === 'error' ? 'error' : 'ok';
    const statusMessage = status === 'error' ? safeText(item.statusMessage, 160) : '';
    result.push({
      schema: STUDIO_TRACE_SPAN_SCHEMA,
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      runId,
      source,
      name,
      startTime,
      endTime,
      status,
      ...(statusMessage ? { statusMessage } : {}),
      attributes: normalizeAttributes(item.attributes, source),
    });
  }
  return result;
}
