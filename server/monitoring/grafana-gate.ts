/**
 * Short-lived browser handoff credential for the Grafana reverse-proxy gate.
 *
 * The d-obs admin credential must never be copied into a browser cookie.  A
 * gate is an opaque, expiring HMAC token; it can only be used by the dedicated
 * Grafana auth subrequest and cannot be replayed as an operations credential.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 30;

export type GrafanaGateEnvironment = {
  RDK_GRAFANA_GATE_SECRET?: string;
  RDK_CREDITS_ADMIN_TOKEN?: string;
};

/** Resolve a dedicated secret, with an upgrade-safe fallback derived from the admin token. */
export function resolveGrafanaGateSecret(
  environment: GrafanaGateEnvironment = process.env,
): string {
  const configured = String(environment.RDK_GRAFANA_GATE_SECRET ?? '').trim();
  if (configured) return configured;
  const adminToken = String(environment.RDK_CREDITS_ADMIN_TOKEN ?? '').trim();
  if (!adminToken) return '';
  return createHmac('sha256', 'd-obs:grafana-gate:v1').update(adminToken).digest('hex');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Issue an opaque gate token. Returns null when no gate secret is configured. */
export function issueGrafanaGate(
  options: {
    environment?: GrafanaGateEnvironment;
    nowMs?: number;
    ttlSeconds?: number;
  } = {},
): string | null {
  const secret = resolveGrafanaGateSecret(options.environment);
  if (!secret) return null;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  const ttl = Math.max(
    60,
    Math.min(MAX_TTL_SECONDS, Math.floor(Number(options.ttlSeconds ?? DEFAULT_TTL_SECONDS))),
  );
  const payload = `${VERSION}.${nowSeconds + ttl}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Validate only Grafana gate tokens; admin tokens are intentionally not accepted here. */
export function verifyGrafanaGate(
  token: unknown,
  options: { environment?: GrafanaGateEnvironment; nowMs?: number } = {},
): boolean {
  const secret = resolveGrafanaGateSecret(options.environment);
  if (!secret) return false;
  const parts = String(token ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  if (expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS) return false;
  // Reject malformed/far-future values even though only holders of the secret
  // can forge a valid signature. This keeps the token contract bounded.
  if (expiresAt > nowSeconds + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) return false;
  if (!parts[2] || !parts[3]) return false;
  const expected = Buffer.from(sign(parts.slice(0, 3).join('.'), secret));
  const actual = Buffer.from(parts[3]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const GRAFANA_GATE_TTL_SECONDS = DEFAULT_TTL_SECONDS;
