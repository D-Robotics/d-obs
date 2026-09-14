import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { TelemetryPermission, TelemetryRole } from '../../shared/telemetry-data-governance.js';

export interface TelemetryActor {
  actorId: string;
  role: TelemetryRole;
  /** Scope derived from the authenticated server session, never request input. */
  authenticatedAccountScopeId: string;
  /** Required for administrators; owners are always limited to their authenticated scope. */
  entitledAccountScopeIds?: readonly string[];
  permissions: readonly TelemetryPermission[];
  /** Changes on logout/account switch and binds cursors to one authorization context. */
  authorizationRevision: string;
}

export interface TelemetryAccessRequest {
  permission: TelemetryPermission;
  selectedAccountScopeId?: string;
  /** Accepted only to make ignoring client claims explicit and testable. */
  claimedAccountScopeId?: string;
}

export type TelemetryAccessDecision =
  | {
      allowed: true;
      accountScopeId: string;
      actorId: string;
      role: TelemetryRole;
      permission: TelemetryPermission;
      authorizationRevision: string;
    }
  | { allowed: false; publicReason: 'not_found' };

const clean = (value: unknown, max = 256): string =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, max);

export function authorizeTelemetryAccess(
  actor: TelemetryActor,
  request: TelemetryAccessRequest,
): TelemetryAccessDecision {
  const actorId = clean(actor.actorId);
  const authenticatedScope = clean(actor.authenticatedAccountScopeId);
  const authorizationRevision = clean(actor.authorizationRevision, 128);
  if (
    !actorId ||
    !authenticatedScope ||
    !authorizationRevision ||
    !actor.permissions.includes(request.permission)
  ) {
    return { allowed: false, publicReason: 'not_found' };
  }

  if (actor.role === 'account_owner') {
    const selected = clean(request.selectedAccountScopeId || authenticatedScope);
    return selected === authenticatedScope
      ? {
          allowed: true,
          accountScopeId: authenticatedScope,
          actorId,
          role: actor.role,
          permission: request.permission,
          authorizationRevision,
        }
      : { allowed: false, publicReason: 'not_found' };
  }

  const selected = clean(request.selectedAccountScopeId);
  const entitled = new Set((actor.entitledAccountScopeIds ?? []).map((scope) => clean(scope)));
  if (!selected || !entitled.has(selected)) return { allowed: false, publicReason: 'not_found' };
  return {
    allowed: true,
    accountScopeId: selected,
    actorId,
    role: actor.role,
    permission: request.permission,
    authorizationRevision,
  };
}

export interface ScopePredicate {
  sql: string;
  values: readonly [string];
}

/** Every governed repository query starts with this authoritative predicate. */
export function authoritativeScopePredicate(
  decision: Extract<TelemetryAccessDecision, { allowed: true }>,
  placeholder = 1,
): ScopePredicate {
  if (!Number.isSafeInteger(placeholder) || placeholder < 1) {
    throw new TypeError('invalid SQL placeholder');
  }
  return { sql: `account_scope_id = $${placeholder}`, values: [decision.accountScopeId] };
}

export interface ScopedLookupRepository<T> {
  findInAccountScope(accountScopeId: string, opaqueIdentifier: string): Promise<T | null>;
}

export type IdorSafeLookupResult<T> =
  | { found: true; value: T }
  | { found: false; publicReason: 'not_found' };

/** A foreign identifier and a missing identifier intentionally have the same result. */
export async function idorSafeScopedLookup<T>(input: {
  decision: TelemetryAccessDecision;
  opaqueIdentifier: string;
  repository: ScopedLookupRepository<T>;
}): Promise<IdorSafeLookupResult<T>> {
  const identifier = clean(input.opaqueIdentifier, 512);
  if (!input.decision.allowed || !identifier) return { found: false, publicReason: 'not_found' };
  const value = await input.repository.findInAccountScope(
    input.decision.accountScopeId,
    identifier,
  );
  return value === null ? { found: false, publicReason: 'not_found' } : { found: true, value };
}

interface GovernanceCursorPayload {
  version: 1;
  scopeDigest: string;
  authorizationDigest: string;
  permission: TelemetryPermission;
  position: string;
  expiresAt: number;
}

function digest(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret).update(`${domain}\0${value}`).digest('base64url');
}

function cursorKey(secret: string): Buffer {
  return createHash('sha256').update(`governance-cursor-v1\0${secret}`).digest();
}

function sealCursor(secret: string, payload: GovernanceCursorPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  cipher.setAAD(Buffer.from('governance-cursor-v1'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher
    .getAuthTag()
    .toString('base64url')}`;
}

function unsealCursor(secret: string, token: unknown): Partial<GovernanceCursorPayload> | null {
  const [version, encodedIv, encodedCiphertext, encodedTag, ...rest] = String(token ?? '').split(
    '.',
  );
  if (version !== 'v1' || !encodedIv || !encodedCiphertext || !encodedTag || rest.length)
    return null;
  try {
    const iv = Buffer.from(encodedIv, 'base64url');
    const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
    const tag = Buffer.from(encodedTag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4_096) return null;
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), iv);
    decipher.setAAD(Buffer.from('governance-cursor-v1'));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    ) as Partial<GovernanceCursorPayload>;
  } catch {
    return null;
  }
}

export function issueGovernanceCursor(input: {
  decision: Extract<TelemetryAccessDecision, { allowed: true }>;
  position: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}): string | null {
  const secret = clean(input.secret, 1_024);
  const position = clean(input.position, 512);
  if (!secret || secret.length < 16 || !position) return null;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const ttlMs = Math.max(30_000, Math.min(30 * 60_000, input.ttlMs ?? 10 * 60_000));
  const payload: GovernanceCursorPayload = {
    version: 1,
    scopeDigest: digest(secret, 'scope', input.decision.accountScopeId),
    authorizationDigest: digest(
      secret,
      'authorization',
      `${input.decision.actorId}\0${input.decision.authorizationRevision}`,
    ),
    permission: input.decision.permission,
    position,
    expiresAt: now + ttlMs,
  };
  return sealCursor(secret, payload);
}

export function verifyGovernanceCursor(input: {
  token: unknown;
  decision: TelemetryAccessDecision;
  secret: string;
  now?: number;
}): { position: string } | null {
  if (!input.decision.allowed) return null;
  const secret = clean(input.secret, 1_024);
  if (secret.length < 16) return null;
  try {
    const parsed = unsealCursor(secret, input.token);
    if (!parsed) return null;
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    if (
      parsed.version !== 1 ||
      parsed.permission !== input.decision.permission ||
      parsed.scopeDigest !== digest(secret, 'scope', input.decision.accountScopeId) ||
      parsed.authorizationDigest !==
        digest(
          secret,
          'authorization',
          `${input.decision.actorId}\0${input.decision.authorizationRevision}`,
        ) ||
      !Number.isFinite(parsed.expiresAt) ||
      Number(parsed.expiresAt) <= now
    ) {
      return null;
    }
    const position = clean(parsed.position, 512);
    return position ? { position } : null;
  } catch {
    return null;
  }
}

/** Prevent a desktop outbox partition from being sent after an account switch. */
export function mayDrainTelemetryPartition(input: {
  partitionAccountScopeId: string;
  activeCredentialAccountScopeId: string;
  access: TelemetryAccessDecision;
}): boolean {
  return (
    input.access.allowed &&
    clean(input.partitionAccountScopeId) === input.access.accountScopeId &&
    clean(input.activeCredentialAccountScopeId) === input.access.accountScopeId
  );
}