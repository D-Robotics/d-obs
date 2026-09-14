import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';

export type ObservabilityAccessScope =
  | { kind: 'owner'; accountScopeId: string }
  | { kind: 'administrator'; selectedAccountScopeId: string };

export interface VerifiedRunLocator {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  runId: string;
  expiresAt: number;
}

export interface VerifiedEventLocator {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  eventId: string;
  expiresAt: number;
}

interface LocatorPayload extends VerifiedRunLocator {
  version: 1;
  type: 'run';
  nonce: string;
}

interface EventLocatorPayload extends VerifiedEventLocator {
  version: 1;
  type: 'event';
  nonce: string;
}

interface CursorPayload {
  version: 1;
  type: 'cursor';
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  sortTime: number;
  tieBreaker: string;
  windowStart: number;
  windowEnd: number;
  snapshotAt: number;
  expiresAt: number;
  nonce: string;
}

const processFallbackSecret = randomBytes(32).toString('hex');

export function resolveObservabilityLocatorSecret(): string {
  const configured =
    String(process.env.RDK_OBSERVABILITY_LOCATOR_SECRET ?? '').trim() ||
    String(process.env.RDK_CREDITS_ADMIN_TOKEN ?? '').trim() ||
    String(process.env.SSO_CLIENT_SECRET ?? '').trim();
  if (configured.length >= 16) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('stable observability locator secret is not configured');
  }
  return processFallbackSecret;
}

function key(): Buffer {
  return createHash('sha256')
    .update(`rdk-observability-locator-v1\0${resolveObservabilityLocatorSecret()}`)
    .digest();
}

function validEnvironment(value: unknown): value is StudioDeploymentEnvironment {
  return ['production', 'staging', 'development', 'test'].includes(String(value));
}

function cleanOpaque(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, max);
}

function seal(payload: LocatorPayload | EventLocatorPayload | CursorPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from('rdk-observability-locator-v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`;
}

function unseal(token: unknown): Record<string, unknown> | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const encrypted = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || encrypted.length > 2_048) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(Buffer.from('rdk-observability-locator-v1'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf8',
    );
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function scopeMatches(accountScopeId: string, scope: ObservabilityAccessScope): boolean {
  return scope.kind === 'owner'
    ? scope.accountScopeId === accountScopeId
    : scope.selectedAccountScopeId === accountScopeId;
}

export function issueRunLocator(input: {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  runId: string;
  now?: number;
  ttlMs?: number;
}): string | null {
  const accountScopeId = cleanOpaque(input.accountScopeId, 256);
  const runId = cleanOpaque(input.runId, 200);
  if (!accountScopeId || !runId || !validEnvironment(input.environment)) return null;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const ttlMs = Math.max(30_000, Math.min(30 * 60_000, input.ttlMs ?? 10 * 60_000));
  return seal({
    version: 1,
    type: 'run',
    accountScopeId,
    environment: input.environment,
    runId,
    expiresAt: now + ttlMs,
    nonce: randomBytes(8).toString('hex'),
  });
}

export function verifyRunLocator(
  token: unknown,
  scope: ObservabilityAccessScope,
  now = Date.now(),
): VerifiedRunLocator | null {
  const payload = unseal(token);
  if (payload?.version !== 1 || payload.type !== 'run' || !validEnvironment(payload.environment)) {
    return null;
  }
  const accountScopeId = cleanOpaque(payload.accountScopeId, 256);
  const runId = cleanOpaque(payload.runId, 200);
  const expiresAt = Number(payload.expiresAt);
  if (
    !accountScopeId ||
    !runId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !scopeMatches(accountScopeId, scope)
  ) {
    return null;
  }
  return { accountScopeId, environment: payload.environment, runId, expiresAt };
}

/** Verify AEAD first, then let an audited admin explicitly select the embedded scope. */
export function inspectAdministratorRunLocator(
  token: unknown,
  now = Date.now(),
): VerifiedRunLocator | null {
  const payload = unseal(token);
  const accountScopeId = cleanOpaque(payload?.accountScopeId, 256);
  if (!accountScopeId) return null;
  return verifyRunLocator(
    token,
    { kind: 'administrator', selectedAccountScopeId: accountScopeId },
    now,
  );
}

export function issueEventLocator(input: {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  eventId: string;
  now?: number;
  ttlMs?: number;
}): string | null {
  const accountScopeId = cleanOpaque(input.accountScopeId, 256);
  const eventId = cleanOpaque(input.eventId, 64);
  if (
    !accountScopeId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId) ||
    !validEnvironment(input.environment)
  ) {
    return null;
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const ttlMs = Math.max(30_000, Math.min(30 * 60_000, input.ttlMs ?? 10 * 60_000));
  return seal({
    version: 1,
    type: 'event',
    accountScopeId,
    environment: input.environment,
    eventId,
    expiresAt: now + ttlMs,
    nonce: randomBytes(8).toString('hex'),
  });
}

export function verifyEventLocator(
  token: unknown,
  scope: ObservabilityAccessScope,
  now = Date.now(),
): VerifiedEventLocator | null {
  const payload = unseal(token);
  if (
    payload?.version !== 1 ||
    payload.type !== 'event' ||
    !validEnvironment(payload.environment)
  ) {
    return null;
  }
  const accountScopeId = cleanOpaque(payload.accountScopeId, 256);
  const eventId = cleanOpaque(payload.eventId, 64);
  const expiresAt = Number(payload.expiresAt);
  if (
    !accountScopeId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !scopeMatches(accountScopeId, scope)
  ) {
    return null;
  }
  return { accountScopeId, environment: payload.environment, eventId, expiresAt };
}

export function inspectAdministratorEventLocator(
  token: unknown,
  now = Date.now(),
): VerifiedEventLocator | null {
  const payload = unseal(token);
  const accountScopeId = cleanOpaque(payload?.accountScopeId, 256);
  if (!accountScopeId) return null;
  return verifyEventLocator(
    token,
    { kind: 'administrator', selectedAccountScopeId: accountScopeId },
    now,
  );
}

export function runDisplayRef(accountScopeId: string, environment: string, runId: string): string {
  return `run-${createHmac('sha256', key())
    .update(`${cleanOpaque(accountScopeId, 256)}\0${environment}\0${cleanOpaque(runId, 200)}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function scopedDisplayRef(
  domain: 'user' | 'session' | 'device',
  accountScopeId: string,
  environment: StudioDeploymentEnvironment,
  identifier: string,
): string | null {
  const account = cleanOpaque(accountScopeId, 256);
  const value = cleanOpaque(identifier, 256);
  if (!account || !value || !validEnvironment(environment)) return null;
  return `${domain}-${createHmac('sha256', key())
    .update(`${domain}\0${account}\0${environment}\0${value}`)
    .digest('hex')
    .slice(0, 16)}`;
}

export function issueScopeCursor(input: {
  accountScopeId: string;
  environment: StudioDeploymentEnvironment;
  sortTime: number;
  tieBreaker: string;
  windowStart?: number;
  windowEnd?: number;
  snapshotAt?: number;
  now?: number;
  ttlMs?: number;
}): string | null {
  const accountScopeId = cleanOpaque(input.accountScopeId, 256);
  const tieBreaker = cleanOpaque(input.tieBreaker, 512);
  if (
    !accountScopeId ||
    !tieBreaker ||
    !validEnvironment(input.environment) ||
    !Number.isFinite(input.sortTime)
  ) {
    return null;
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const windowEnd = Number.isFinite(input.windowEnd) ? Math.trunc(Number(input.windowEnd)) : now;
  const windowStart = Number.isFinite(input.windowStart)
    ? Math.trunc(Number(input.windowStart))
    : windowEnd - 24 * 60 * 60_000;
  const snapshotAt = Number.isFinite(input.snapshotAt)
    ? Math.trunc(Number(input.snapshotAt))
    : windowEnd;
  if (
    !Number.isSafeInteger(windowStart) ||
    !Number.isSafeInteger(windowEnd) ||
    !Number.isSafeInteger(snapshotAt) ||
    windowStart >= windowEnd ||
    windowEnd - windowStart > 168 * 60 * 60_000 ||
    snapshotAt < windowStart ||
    snapshotAt > windowEnd
  ) {
    return null;
  }
  return seal({
    version: 1,
    type: 'cursor',
    accountScopeId,
    environment: input.environment,
    sortTime: Math.trunc(input.sortTime),
    tieBreaker,
    windowStart,
    windowEnd,
    snapshotAt,
    expiresAt: now + Math.max(30_000, Math.min(30 * 60_000, input.ttlMs ?? 10 * 60_000)),
    nonce: randomBytes(8).toString('hex'),
  });
}

export function verifyScopeCursor(
  token: unknown,
  scope: ObservabilityAccessScope,
  environment: StudioDeploymentEnvironment,
  now = Date.now(),
): {
  sortTime: number;
  tieBreaker: string;
  windowStart: number;
  windowEnd: number;
  snapshotAt: number;
} | null {
  const payload = unseal(token);
  const accountScopeId = cleanOpaque(payload?.accountScopeId, 256);
  const tieBreaker = cleanOpaque(payload?.tieBreaker, 512);
  const expiresAt = Number(payload?.expiresAt);
  const sortTime = Number(payload?.sortTime);
  const windowStart = Number(payload?.windowStart);
  const windowEnd = Number(payload?.windowEnd);
  const snapshotAt = Number(payload?.snapshotAt);
  if (
    payload?.version !== 1 ||
    payload.type !== 'cursor' ||
    payload.environment !== environment ||
    !accountScopeId ||
    !tieBreaker ||
    !scopeMatches(accountScopeId, scope) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !Number.isFinite(sortTime) ||
    !Number.isSafeInteger(windowStart) ||
    !Number.isSafeInteger(windowEnd) ||
    !Number.isSafeInteger(snapshotAt) ||
    windowStart >= windowEnd ||
    windowEnd - windowStart > 168 * 60 * 60_000 ||
    snapshotAt < windowStart ||
    snapshotAt > windowEnd
  ) {
    return null;
  }
  return { sortTime, tieBreaker, windowStart, windowEnd, snapshotAt };
}