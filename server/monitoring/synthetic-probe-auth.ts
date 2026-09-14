import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const SYNTHETIC_PROBE_TIMESTAMP_HEADER = 'x-rdk-synthetic-probe-timestamp';
export const SYNTHETIC_PROBE_SIGNATURE_HEADER = 'x-rdk-synthetic-probe-signature';
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const SIGNATURE_VERSION = 'rdk-synthetic-probe.v1';

type EnvLike = Record<string, string | undefined>;
type HeaderLike = Record<string, unknown>;

export function syntheticProbeSigningConfigured(env: EnvLike = process.env): boolean {
  const material = String(
    env.RDK_SYNTHETIC_PROBE_HMAC_SECRET || env.SSO_DIRECT_AES_KEY || '',
  ).trim();
  return Buffer.byteLength(material, 'utf8') >= 16;
}

function probeSigningKey(env: EnvLike): Buffer | null {
  const material = String(
    env.RDK_SYNTHETIC_PROBE_HMAC_SECRET || env.SSO_DIRECT_AES_KEY || '',
  ).trim();
  if (!syntheticProbeSigningConfigured(env)) return null;
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(material, 'utf8'),
      Buffer.from('rdk-studio/synthetic-probe/salt/v1', 'utf8'),
      Buffer.from('request-authentication', 'utf8'),
      32,
    ),
  );
}

function headerValue(headers: HeaderLike, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? String(value[0] ?? '').trim() : String(value ?? '').trim();
}

function probePayload(timestamp: number, sessionId: string, message: string): string {
  const messageHash = createHash('sha256').update(message, 'utf8').digest('hex');
  return [SIGNATURE_VERSION, String(timestamp), sessionId, messageHash].join('\n');
}

function isSyntheticProbeSessionId(sessionId: string): boolean {
  return /-synthetic-(?:ai-chat|tool-call)-\d+$/.test(sessionId);
}

export function buildSyntheticProbeRequestHeaders(input: {
  sessionId: string;
  message: string;
  now?: number;
  env?: EnvLike;
}): Record<string, string> {
  const sessionId = String(input.sessionId || '').trim();
  const message = String(input.message || '');
  if (!isSyntheticProbeSessionId(sessionId)) {
    throw new Error('synthetic probe session id is invalid');
  }
  const key = probeSigningKey(input.env ?? process.env);
  if (!key) throw new Error('synthetic probe signing secret is not configured');
  const timestamp = Math.trunc(input.now ?? Date.now());
  const signature = createHmac('sha256', key)
    .update(probePayload(timestamp, sessionId, message), 'utf8')
    .digest('hex');
  return {
    [SYNTHETIC_PROBE_TIMESTAMP_HEADER]: String(timestamp),
    [SYNTHETIC_PROBE_SIGNATURE_HEADER]: signature,
  };
}

export function isTrustedSyntheticProbeRequest(input: {
  headers: HeaderLike;
  sessionId: string;
  message: string;
  now?: number;
  env?: EnvLike;
}): boolean {
  const sessionId = String(input.sessionId || '').trim();
  if (!isSyntheticProbeSessionId(sessionId)) return false;
  const timestampText = headerValue(input.headers, SYNTHETIC_PROBE_TIMESTAMP_HEADER);
  const signature = headerValue(input.headers, SYNTHETIC_PROBE_SIGNATURE_HEADER).toLowerCase();
  if (!/^\d{13}$/.test(timestampText) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const timestamp = Number(timestampText);
  const now = Math.trunc(input.now ?? Date.now());
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const key = probeSigningKey(input.env ?? process.env);
  if (!key) return false;
  const expected = createHmac('sha256', key)
    .update(probePayload(timestamp, sessionId, String(input.message || '')), 'utf8')
    .digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
