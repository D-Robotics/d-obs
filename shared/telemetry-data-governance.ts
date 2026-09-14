/**
 * Privacy and authorization contracts shared by Studio telemetry producers and
 * the server-side governance layer. This module is deliberately dependency-free:
 * it may run before a retry queue or any durable telemetry boundary.
 */

export const LOW_SENSITIVITY_RETENTION_DAYS = 35 as const;
export const PAYLOAD_RETENTION_DAYS = 7 as const;

export const TELEMETRY_PAYLOAD_CLASSES = [
  'prompt',
  'response',
  'tool_arguments',
  'tool_result',
  'sanitized_exception',
] as const;

export type TelemetryPayloadClass = (typeof TELEMETRY_PAYLOAD_CLASSES)[number];

export const TELEMETRY_ROLES = ['account_owner', 'telemetry_administrator'] as const;
export type TelemetryRole = (typeof TELEMETRY_ROLES)[number];

export const TELEMETRY_PERMISSIONS = [
  'telemetry.read',
  'telemetry.search',
  'telemetry.advanced_link',
  'telemetry.payload.read',
  'telemetry.payload.capture',
  'telemetry.payload.grant',
  'telemetry.policy.change',
  'telemetry.retention.change',
  'telemetry.delete',
] as const;

export type TelemetryPermission = (typeof TELEMETRY_PERMISSIONS)[number];

export interface RedactionLimits {
  maxDepth: number;
  maxObjectFields: number;
  maxArrayItems: number;
  maxStringBytes: number;
  maxTotalBytes: number;
}

export interface RedactionStats {
  droppedFields: number;
  redactedValues: number;
  truncatedValues: number;
}

export type RedactionResult<T = unknown> =
  | { ok: true; value: T; encodedBytes: number; stats: RedactionStats }
  | {
      ok: false;
      reason: 'invalid_input' | 'indeterminate_value' | 'size_limit' | 'redactor_failed';
      stats: RedactionStats;
    };

const DEFAULT_REDACTION_LIMITS: Readonly<RedactionLimits> = {
  maxDepth: 8,
  maxObjectFields: 256,
  maxArrayItems: 64,
  maxStringBytes: 2_048,
  maxTotalBytes: 32_768,
};

const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

const SENSITIVE_KEY =
  /(?:^|[._-])(?:authorization|proxy_authorization|cookie|set_cookie|password|passwd|secret|token|api_key|apikey|access_key|private_key|client_secret|credential|email|e_mail|phone|mobile|username|user_name|user_id|account_id|account_scope_id|device_id|device_serial|serial_number|ip|ip_address|host|hostname|address|file|filename|filepath|path|stack|stacktrace|exception_message|raw_exception|query|querystring|search_params)(?:$|[._-])/i;

const HEADER_CONTAINER_KEY = /^(?:headers|request_headers|response_headers|http_headers)$/i;
const PRIVATE_KEY =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_SECRET =
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;&]+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d ().-]{7,}\d)(?!\d)/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{0,4}\b/gi;
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\r\n\t"'<>|]+/g;
const POSIX_PATH = /(?:^|\s)\/(?:home|Users|var|tmp|etc|opt|root|mnt)\/[^\s"'<>]*/g;
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"'<>]+/gi;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= Math.max(0, maxBytes - utf8Bytes(TRUNCATED))) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: `${value.slice(0, low)}${TRUNCATED}`, truncated: true };
}

function stripUrlQuery(match: string): string {
  try {
    const parsed = new URL(match);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return REDACTED;
  }
}

function redactString(raw: string, limits: RedactionLimits, stats: RedactionStats): string {
  let changed = false;
  let value = raw
    .replace(PRIVATE_KEY, () => {
      changed = true;
      return REDACTED;
    })
    .replace(BEARER, () => {
      changed = true;
      return REDACTED;
    })
    .replace(ASSIGNMENT_SECRET, () => {
      changed = true;
      return REDACTED;
    })
    .replace(EMAIL, () => {
      changed = true;
      return REDACTED;
    })
    .replace(PHONE, () => {
      changed = true;
      return REDACTED;
    })
    .replace(IPV4, () => {
      changed = true;
      return REDACTED;
    })
    .replace(IPV6, () => {
      changed = true;
      return REDACTED;
    })
    .replace(WINDOWS_PATH, () => {
      changed = true;
      return REDACTED;
    })
    .replace(POSIX_PATH, (match) => {
      changed = true;
      return `${match.startsWith(' ') ? ' ' : ''}${REDACTED}`;
    })
    .replace(URL_WITH_QUERY, (match) => {
      const safe = stripUrlQuery(match);
      if (safe !== match) changed = true;
      return safe;
    });
  if (changed) stats.redactedValues += 1;
  const bounded = truncateUtf8(value, limits.maxStringBytes);
  if (bounded.truncated) stats.truncatedValues += 1;
  value = bounded.value;
  return value;
}

function normalizedLimits(overrides?: Partial<RedactionLimits>): RedactionLimits {
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  };
  return {
    maxDepth: integer(overrides?.maxDepth, DEFAULT_REDACTION_LIMITS.maxDepth, 1, 32),
    maxObjectFields: integer(
      overrides?.maxObjectFields,
      DEFAULT_REDACTION_LIMITS.maxObjectFields,
      1,
      4_096,
    ),
    maxArrayItems: integer(
      overrides?.maxArrayItems,
      DEFAULT_REDACTION_LIMITS.maxArrayItems,
      1,
      1_024,
    ),
    maxStringBytes: integer(
      overrides?.maxStringBytes,
      DEFAULT_REDACTION_LIMITS.maxStringBytes,
      16,
      65_536,
    ),
    maxTotalBytes: integer(
      overrides?.maxTotalBytes,
      DEFAULT_REDACTION_LIMITS.maxTotalBytes,
      128,
      1_048_576,
    ),
  };
}

/**
 * Recursively removes secrets and direct identifiers and bounds every payload.
 * It never returns the original value after an exception or indeterminate read.
 */
export function redactTelemetryPayload(
  input: unknown,
  overrides?: Partial<RedactionLimits>,
): RedactionResult {
  const limits = normalizedLimits(overrides);
  const stats: RedactionStats = { droppedFields: 0, redactedValues: 0, truncatedValues: 0 };
  const seen = new WeakSet<object>();
  let objectFields = 0;

  const visit = (value: unknown, depth: number, key?: string): unknown => {
    if (depth > limits.maxDepth) {
      stats.truncatedValues += 1;
      return TRUNCATED;
    }
    if (key && (SENSITIVE_KEY.test(key) || HEADER_CONTAINER_KEY.test(key))) {
      stats.redactedValues += 1;
      return REDACTED;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return redactString(value, limits, stats);
    if (typeof value === 'undefined') {
      stats.droppedFields += 1;
      return undefined;
    }
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
      throw new TypeError('indeterminate telemetry value');
    }
    if (typeof value !== 'object') throw new TypeError('indeterminate telemetry value');
    if (seen.has(value)) throw new TypeError('cyclic telemetry value');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        const limit = Math.min(value.length, limits.maxArrayItems);
        for (let index = 0; index < limit; index += 1) {
          const item = visit(value[index], depth + 1);
          if (item !== undefined) output.push(item);
        }
        if (value.length > limit) stats.truncatedValues += value.length - limit;
        return output;
      }
      const output: Record<string, unknown> = {};
      const entries = Object.keys(value as object).sort((left, right) => left.localeCompare(right));
      for (const entryKey of entries) {
        if (objectFields >= limits.maxObjectFields) {
          stats.truncatedValues += 1;
          break;
        }
        objectFields += 1;
        const child = visit((value as Record<string, unknown>)[entryKey], depth + 1, entryKey);
        if (child !== undefined) output[entryKey] = child;
      }
      return output;
    } finally {
      seen.delete(value);
    }
  };

  try {
    const value = visit(input, 0);
    if (value === undefined) return { ok: false, reason: 'invalid_input', stats };
    const encodedBytes = utf8Bytes(JSON.stringify(value));
    if (encodedBytes > limits.maxTotalBytes) return { ok: false, reason: 'size_limit', stats };
    return { ok: true, value, encodedBytes, stats };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof TypeError && /indeterminate|cyclic/.test(error.message)
          ? 'indeterminate_value'
          : 'redactor_failed',
      stats,
    };
  }
}

const SAFE_ATTRIBUTE_KEYS = new Set([
  'moss.observability.contract.version',
  'moss.run.id',
  'moss.session.id',
  'moss.turn.index',
  'moss.outcome',
  'moss.error.category',
  'moss.model.category',
  'moss.tool.category',
  'moss.tool.outcome_kind',
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'service.name',
  'service.version',
  'deployment.environment.name',
  'rdk.studio.version',
  'rdk.client.version',
  'rdk.client.surface',
  'rdk.source.segment',
  'rdk.sampling.decision',
  'rdk.sampling.reason_category',
  'rdk.sampling.policy_version',
]);

const SAFE_ROOT_KEYS = new Set([
  'trace_id',
  'span_id',
  'parent_span_id',
  'name',
  'kind',
  'start_time_unix_nano',
  'end_time_unix_nano',
  'start_time_ms',
  'end_time_ms',
  'duration_ms',
  'status_code',
]);

const BOUNDED_VALUES: Record<string, ReadonlySet<string>> = {
  'moss.outcome': new Set([
    'ok',
    'error',
    'cancelled',
    'denied',
    'blocked',
    'incomplete',
    'replayed',
    'suppressed',
  ]),
  'deployment.environment.name': new Set(['production', 'staging', 'development', 'test']),
  'rdk.client.surface': new Set(['web-cloud', 'desktop']),
  'rdk.source.segment': new Set(['client', 'studio_transport', 'moss']),
  'rdk.sampling.decision': new Set(['pending', 'retained', 'dropped']),
};

function safeOpaqueIdentifier(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized && normalized.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function sanitizeAllowedValue(key: string, value: unknown): unknown {
  if (key === 'moss.run.id' || key === 'moss.session.id') return safeOpaqueIdentifier(value);
  if (key.endsWith('tokens') || key === 'moss.turn.index') {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? value : undefined;
  }
  const bounded = BOUNDED_VALUES[key];
  if (bounded) return typeof value === 'string' && bounded.has(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, '').trim();
    return normalized && utf8Bytes(normalized) <= 256 ? normalized : undefined;
  }
  return undefined;
}

/** Explicit recursive projection for low-sensitivity span attributes. */
export function sanitizeLowSensitivityAttributes(
  input: unknown,
): RedactionResult<Record<string, unknown>> {
  const stats: RedactionStats = { droppedFields: 0, redactedValues: 0, truncatedValues: 0 };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'invalid_input', stats };
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input as object).sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (!SAFE_ATTRIBUTE_KEYS.has(key) || SENSITIVE_KEY.test(key)) {
        stats.droppedFields += 1;
        continue;
      }
      const value = sanitizeAllowedValue(key, (input as Record<string, unknown>)[key]);
      if (value === undefined) {
        stats.droppedFields += 1;
        continue;
      }
      output[key] = value;
    }
    const encodedBytes = utf8Bytes(JSON.stringify(output));
    return { ok: true, value: output, encodedBytes, stats };
  } catch {
    return { ok: false, reason: 'redactor_failed', stats };
  }
}

/**
 * Projects a normalized span to its low-sensitivity durable representation.
 * Unknown root fields and all events/links/content are discarded.
 */
export function sanitizeLowSensitivitySpan(
  input: unknown,
): RedactionResult<Record<string, unknown>> {
  const stats: RedactionStats = { droppedFields: 0, redactedValues: 0, truncatedValues: 0 };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'invalid_input', stats };
    }
    const source = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
      if (key === 'attributes' || key === 'resource') {
        const nested = sanitizeLowSensitivityAttributes(source[key]);
        if (!nested.ok) return { ok: false, reason: nested.reason, stats };
        output[key] = nested.value;
        stats.droppedFields += nested.stats.droppedFields;
        continue;
      }
      if (!SAFE_ROOT_KEYS.has(key)) {
        stats.droppedFields += 1;
        continue;
      }
      const value = source[key];
      if (key.endsWith('_id')) {
        const identifier = safeOpaqueIdentifier(value);
        if (identifier) output[key] = identifier;
        else stats.droppedFields += 1;
        continue;
      }
      if (key === 'name') {
        const name = String(value ?? '').trim();
        if (/^[a-z][a-z0-9._/-]{0,127}$/.test(name)) output[key] = name;
        else stats.droppedFields += 1;
        continue;
      }
      if (key === 'kind') {
        const kind = String(value ?? '').toLowerCase();
        if (['internal', 'client', 'server', 'producer', 'consumer'].includes(kind)) {
          output[key] = kind;
        } else stats.droppedFields += 1;
        continue;
      }
      if (key === 'status_code') {
        const status = String(value ?? '').toLowerCase();
        if (['unset', 'ok', 'error'].includes(status)) output[key] = status;
        else stats.droppedFields += 1;
        continue;
      }
      if (key.endsWith('_unix_nano') && typeof value === 'string') {
        if (/^\d{1,32}$/.test(value)) output[key] = value;
        else stats.droppedFields += 1;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
      else if (typeof value === 'string' && /^\d{1,32}$/.test(value)) output[key] = value;
      else stats.droppedFields += 1;
    }
    const encodedBytes = utf8Bytes(JSON.stringify(output));
    if (encodedBytes > 65_536) return { ok: false, reason: 'size_limit', stats };
    return { ok: true, value: output, encodedBytes, stats };
  } catch {
    return { ok: false, reason: 'redactor_failed', stats };
  }
}