/** Actor-bound, encrypted, single-use authorization for an exact assistant mutation. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { getSessionSsoUser } from './observability-access-adapter.js';
import { resolveOpsActorId } from './observability-access.js';
import type { PlatformAssistantArgs, PlatformAssistantOperation, PlatformAssistantProposal } from '../observability/platform-assistant.js';
import { redactPlatformAssistantText } from '../observability/platform-assistant-redaction.js';

const TTL_MS = 5 * 60_000;
const MAX_TOKEN_BYTES = 32_000;
type Authorization = { version: 1; nonce: string; expiresAt: number; principal: string; operationId: string; args: PlatformAssistantArgs };
function key(): Buffer {
  const secret = [process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET, process.env.RDK_OBSERVABILITY_LOCATOR_SECRET, process.env.RDK_CREDITS_ADMIN_TOKEN]
    .map((value) => String(value ?? '').trim()).find(Boolean);
  if (!secret) throw new Error('platform_assistant_authorization_unconfigured');
  return createHash('sha256').update('d-obs:assistant-exact-mutation:v1\0').update(secret).digest();
}
function principal(req: Request): string {
  const credential = req.header('x-admin-token') || req.header('x-rdk-sso-session') || req.header('cookie') || req.header('x-tenant-token') || '';
  return createHash('sha256').update(JSON.stringify({
    actor: getSessionSsoUser(req)?.id || resolveOpsActorId(req), credential,
    tenant: req.opsTenantAccess?.tenantId ?? '', role: req.opsTenantAccess?.role ?? '',
    view: typeof req.query.tenant === 'string' ? req.query.tenant : '',
  })).digest('hex');
}
function preview(args: PlatformAssistantArgs): string {
  const redact = (name: string, item: unknown) => /(?:token|secret|password|passwd|credential|api.?key|authorization|cookie)$/i.test(name) ? '[REDACTED]' : item;
  let value = redactPlatformAssistantText(JSON.stringify(args, redact, 2));
  if (value.length > MAX_TOKEN_BYTES) value = redactPlatformAssistantText(JSON.stringify(args, redact));
  if (value.length > MAX_TOKEN_BYTES) throw new Error('platform_assistant_authorization_too_large');
  return value;
}
export function proposePlatformMutation(req: Request, operation: PlatformAssistantOperation, args: PlatformAssistantArgs, now = Date.now()): PlatformAssistantProposal {
  if (!operation.mutating) throw new Error('platform_assistant_invalid_authorization');
  if (!process.env.RDK_CHAT_CREDITS_DB_URL?.trim()) throw new Error('platform_assistant_authorization_store_unavailable');
  const authorization: Authorization = { version: 1, nonce: randomBytes(24).toString('hex'), expiresAt: now + TTL_MS, principal: principal(req), operationId: operation.id, args };
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from('d-obs:assistant-mutation:v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(authorization), 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  if (token.length > MAX_TOKEN_BYTES) throw new Error('platform_assistant_authorization_too_large');
  return { token, operationId: operation.id, description: operation.description, preview: preview(args), expiresAt: authorization.expiresAt };
}
export function inspectPlatformMutation(req: Request, token: unknown, now = Date.now()): Authorization {
  try {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const encrypted = Buffer.from(token, 'base64url');
    if (encrypted.length < 29) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(), encrypted.subarray(0, 12));
    decipher.setAAD(Buffer.from('d-obs:assistant-mutation:v1')); decipher.setAuthTag(encrypted.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')) as Authorization;
    if (value.version !== 1 || !/^[0-9a-f]{48}$/.test(value.nonce) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + TTL_MS || typeof value.operationId !== 'string' || !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) throw new Error();
    const expected = Buffer.from(principal(req)); const actual = Buffer.from(value.principal);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    return value;
  } catch { throw new Error('platform_assistant_invalid_or_expired_authorization'); }
}

type ClaimPool = {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
let claimPool: { connectionString: string; ready: Promise<ClaimPool> } | undefined;

/** Claims have their own bounded pool; dashboard/export queries cannot hold up confirmation. */
async function authorizationStore(): Promise<ClaimPool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('platform_assistant_authorization_store_unavailable');
  if (claimPool?.connectionString === connectionString) return claimPool.ready;
  const previous = claimPool;
  if (previous) void previous.ready.then((pool) => pool.end()).catch(() => undefined);
  const ready = (async () => {
    const pg = await import('pg' as string);
    const Pool = (pg as unknown as { default: { Pool: new (config: Record<string, unknown>) => ClaimPool } }).default.Pool;
    const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3_000,
      statement_timeout: 3_000, idleTimeoutMillis: 1_000, application_name: 'd-obs-assistant-authorization' });
    // An idle socket error must not escape EventEmitter and crash the web process.
    pool.on('error', () => console.warn('[platform-assistant] authorization store connection lost'));
    try {
      await pool.query(`create table if not exists public.studio_assistant_mutation_claims (
        nonce_hash text primary key, operation_id text not null, expires_at timestamptz not null,
        claimed_at timestamptz not null default now()
      )`);
      return pool;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  })();
  claimPool = { connectionString, ready };
  void ready.catch(() => { if (claimPool?.ready === ready) claimPool = undefined; });
  return ready;
}

export async function claimPlatformMutation(value: Authorization): Promise<void> {
  try {
    if (value.expiresAt <= Date.now()) throw new Error('platform_assistant_invalid_or_expired_authorization');
    const pool = await authorizationStore();
    const result = await pool.query(`insert into public.studio_assistant_mutation_claims (nonce_hash, operation_id, expires_at)
      select $1,$2,to_timestamp($3 / 1000.0) where to_timestamp($3 / 1000.0) > clock_timestamp()
      on conflict do nothing returning nonce_hash`,
      [createHash('sha256').update(value.nonce).digest('hex'), value.operationId, value.expiresAt]);
    if (!result.rows.length) throw new Error(value.expiresAt <= Date.now()
      ? 'platform_assistant_invalid_or_expired_authorization' : 'platform_assistant_authorization_already_used');
    await pool.query('delete from public.studio_assistant_mutation_claims where expires_at < now() - interval \'1 day\'').catch(() => undefined);
  } catch (error) {
    if (['platform_assistant_authorization_already_used', 'platform_assistant_invalid_or_expired_authorization'].includes((error as Error).message)) throw error;
    throw new Error('platform_assistant_authorization_store_unavailable');
  }
}
