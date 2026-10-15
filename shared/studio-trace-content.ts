import { redactTelemetryPayload } from './telemetry-data-governance.js';

export const STUDIO_TRACE_CONTENT_SCHEMA = 'rdk.studio.trace-content.v1' as const;
export const STUDIO_TRACE_CONTENT_ENTRY_MAX_BYTES = 8 * 1024;
export const STUDIO_TRACE_CONTENT_MAX_BYTES = 32 * 1024;
export const STUDIO_TRACE_CONTENT_MAX_ENTRIES = 16;

export type StudioTraceContentKind = 'user_input' | 'model_input' | 'model_output' | 'tool_input' | 'tool_output';
export interface StudioTraceContent {
  schema: typeof STUDIO_TRACE_CONTENT_SCHEMA;
  entries: Array<{ kind: StudioTraceContentKind; text: string }>;
  truncated: boolean;
  redacted: boolean;
}

const KINDS = new Set<StudioTraceContentKind>([
  'user_input',
  'model_input',
  'model_output',
  'tool_input',
  'tool_output',
]);
const encoder = new TextEncoder();
const TRUNCATED = '[TRUNCATED]';
const REDACTED = '[REDACTED]';
const CONTENT_KEY_PREFIX = 'rdkstudiobodyfield';
const CONTENT_QUERY_ALIAS = `${CONTENT_KEY_PREFIX}q`;
// JSON fragments, fenced output and truncated logs may not be parseable objects.
const QUOTED_CREDENTIAL_ASSIGNMENT =
  /(["'])([\w.-]*(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w.-]*)\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;}\]]+)/gi;

function redactQuotedCredentials(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  const text = value.replace(
    QUOTED_CREDENTIAL_ASSIGNMENT,
    (match, quote: string, key: string, separator: string, credential: string) => {
      if ([REDACTED, JSON.stringify(REDACTED), `'${REDACTED}'`].includes(credential)) return match;
      redacted = true;
      return `${quote}${key}${quote}${separator}${JSON.stringify(REDACTED)}`;
    },
  );
  return { text, redacted };
}

function parseTraceContentPayload(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    // Preserve readable fragments; quoted assignments are still redacted below.
    return value;
  }
}

function mappedContentKey(key: PropertyKey, restore: boolean): PropertyKey {
  if (typeof key !== 'string') return key;
  if (restore) {
    if (key === CONTENT_QUERY_ALIAS) return 'query';
    return key.startsWith(CONTENT_KEY_PREFIX + CONTENT_KEY_PREFIX)
      ? key.slice(CONTENT_KEY_PREFIX.length)
      : key;
  }
  if (key === 'query') return CONTENT_QUERY_ALIAS;
  return key.startsWith(CONTENT_KEY_PREFIX) ? CONTENT_KEY_PREFIX + key : key;
}

/** Only native body query keys bypass key-wide masking; values keep every redactor rule. */
function contentQueryView(value: unknown, views = new WeakMap<object, object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  const previous = views.get(value);
  if (previous) return previous;
  // A lazy view preserves the original redactor's depth, field, array and cycle limits.
  const view = new Proxy(Array.isArray(value) ? [] : {}, {
    ownKeys: () =>
      Reflect.ownKeys(value).map((key) => mappedContentKey(key, false) as string | symbol),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, mappedContentKey(key, true));
      return descriptor ? { configurable: true, enumerable: descriptor.enumerable } : undefined;
    },
    get: (_target, key) => contentQueryView(Reflect.get(value, mappedContentKey(key, true)), views),
  });
  views.set(value, view);
  return view;
}

function restoreContentKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(restoreContentKeys);
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, child]) =>
          [mappedContentKey(key, true) as string, restoreContentKeys(child)] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function boundedText(value: string): { text: string; truncated: boolean } {
  if (encoder.encode(value).byteLength <= STUDIO_TRACE_CONTENT_ENTRY_MAX_BYTES) {
    return { text: value, truncated: false };
  }
  let bytes = encoder.encode(TRUNCATED).byteLength;
  const chars: string[] = [];
  for (const char of value) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > STUDIO_TRACE_CONTENT_ENTRY_MAX_BYTES) break;
    chars.push(char);
    bytes += size;
  }
  return { text: chars.join('') + TRUNCATED, truncated: true };
}

/** Redact before serialization, so structured credential fields cannot hide in JSON text. */
export function createStudioTraceContentEntry(
  kind: StudioTraceContentKind,
  value: unknown,
): StudioTraceContent | undefined {
  const payload = parseTraceContentPayload(value);
  const textPayload = typeof payload === 'string' ? redactQuotedCredentials(payload) : undefined;
  let payloadView: unknown;
  try {
    payloadView = contentQueryView(textPayload?.text ?? payload);
  } catch {
    return undefined;
  }
  const redaction = redactTelemetryPayload(payloadView, {
    maxStringBytes: STUDIO_TRACE_CONTENT_ENTRY_MAX_BYTES,
    maxTotalBytes: STUDIO_TRACE_CONTENT_MAX_BYTES,
  });
  if (!redaction.ok) return undefined;
  const redactedValue = restoreContentKeys(redaction.value);
  let embeddedRedacted = textPayload?.redacted ?? false;
  const redactText = (text: string): string => {
    const result = redactQuotedCredentials(text);
    embeddedRedacted ||= result.redacted;
    return result.text;
  };
  const serialized =
    typeof redactedValue === 'string'
      ? redactText(redactedValue)
      : JSON.stringify(redactedValue, (_key, entry: unknown) =>
          typeof entry === 'string' ? redactText(entry) : entry,
        );
  const bounded = boundedText(redactText(serialized));
  return {
    schema: STUDIO_TRACE_CONTENT_SCHEMA,
    entries: [{ kind, text: bounded.text }],
    truncated: bounded.truncated || redaction.stats.truncatedValues > 0,
    redacted:
      embeddedRedacted || redaction.stats.redactedValues > 0 || redaction.stats.droppedFields > 0,
  };
}

/** Shared by producer, authenticated ingestion, storage and scoped detail reads. */
export function normalizeStudioTraceContent(value: unknown): StudioTraceContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== STUDIO_TRACE_CONTENT_SCHEMA || !Array.isArray(raw.entries)) return undefined;
  const result: StudioTraceContent = {
    schema: STUDIO_TRACE_CONTENT_SCHEMA,
    entries: [],
    truncated: raw.truncated === true || raw.entries.length > STUDIO_TRACE_CONTENT_MAX_ENTRIES,
    redacted: raw.redacted === true,
  };
  for (const candidate of raw.entries.slice(0, STUDIO_TRACE_CONTENT_MAX_ENTRIES)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (!KINDS.has(entry.kind as StudioTraceContentKind) || typeof entry.text !== 'string')
      continue;
    const normalized = createStudioTraceContentEntry(
      entry.kind as StudioTraceContentKind,
      entry.text,
    );
    if (!normalized) {
      result.redacted = true;
      result.truncated = true;
      continue;
    }
    const next = { ...result, entries: [...result.entries, ...normalized.entries] };
    if (encoder.encode(JSON.stringify(next)).byteLength > STUDIO_TRACE_CONTENT_MAX_BYTES) {
      result.truncated = true;
      break;
    }
    result.entries = next.entries;
    result.redacted ||= normalized.redacted;
    result.truncated ||= normalized.truncated;
  }
  return result.entries.length ? result : undefined;
}
