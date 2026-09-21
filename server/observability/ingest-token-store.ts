/**
 * 生态接入凭据（ingest token）注册表：人 / 服务 / 租户三级签发。
 *
 * 身份只存在于凭据层：遥测数据仍按 owner（sha256(token)）归账、零 PII，
 * 注册表负责 owner → 签发对象的映射，让"查 owner 即查人/服务/租户"。
 * 库内只存 token sha256，明文仅在签发/轮换响应出现一次。表结构与
 * tools/observability-signals-schema.sql 同源；store 首次写入时执行相同幂等 DDL。
 */
import { createHash, randomBytes } from 'node:crypto';

export type IngestTokenSubjectType = 'user' | 'service' | 'tenant';

export type IngestTokenRecord = {
  tokenId: string;
  subjectType: IngestTokenSubjectType;
  subjectId: string;
  displayName: string;
  labels: Record<string, unknown>;
  owner: string;
  status: 'active' | 'revoked';
  createdAt: string;
  createdBy: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type ResolvedIngestToken = {
  tokenId: string;
  subjectType: IngestTokenSubjectType;
  subjectId: string;
  owner: string;
};

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

const ENSURE_SCHEMA_SQL = `
create table if not exists public.studio_obs_ingest_tokens (
  token_id text primary key,
  token_hash text not null unique,
  subject_type text not null check (subject_type in ('user', 'service', 'tenant')),
  subject_id text not null,
  display_name text not null default '',
  labels jsonb not null default '{}'::jsonb,
  owner text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  last_seen_at timestamptz null,
  revoked_at timestamptz null
);
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p.query(ENSURE_SCHEMA_SQL).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export const INGEST_TOKEN_SUBJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.@_:-]{1,127}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function ingestOwnerForToken(token: string): string {
  return `public_${hashToken(token)}`;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function parseLabels(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    const normalizedKey = cleanText(key, 64);
    if (!normalizedKey) continue;
    if (typeof entry === 'string') result[normalizedKey] = cleanText(entry, 120);
    else if (typeof entry === 'number' && Number.isFinite(entry)) result[normalizedKey] = entry;
    else if (typeof entry === 'boolean') result[normalizedKey] = entry;
  }
  return result;
}

function normalizeSubjectType(value: unknown): IngestTokenSubjectType | null {
  return value === 'user' || value === 'service' || value === 'tenant' ? value : null;
}

function rowToRecord(row: Record<string, unknown>): IngestTokenRecord {
  const revokedAt = row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at ? String(row.revoked_at) : null;
  return {
    tokenId: String(row.token_id ?? ''),
    subjectType: normalizeSubjectType(row.subject_type) ?? 'service',
    subjectId: String(row.subject_id ?? ''),
    displayName: String(row.display_name ?? ''),
    labels: parseLabels(row.labels),
    owner: String(row.owner ?? ''),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    createdBy: String(row.created_by ?? ''),
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at ? String(row.last_seen_at) : null,
    revokedAt,
  };
}

export type IssueIngestTokenInput = {
  subjectType: unknown;
  subjectId: unknown;
  displayName?: unknown;
  labels?: unknown;
  createdBy?: unknown;
};

/** 校验签发入参并生成明文 token；不落库（由调用方决定走签发还是轮换）。 */
export function prepareIngestToken(input: IssueIngestTokenInput): { token: string; subjectType: IngestTokenSubjectType; subjectId: string; displayName: string; labels: Record<string, unknown> } {
  const subjectType = normalizeSubjectType(input.subjectType);
  if (!subjectType) throw new Error('invalid_subject_type');
  const subjectId = cleanText(input.subjectId, 128);
  if (!INGEST_TOKEN_SUBJECT_PATTERN.test(subjectId)) throw new Error('invalid_subject_id');
  return {
    token: randomBytes(32).toString('hex'),
    subjectType,
    subjectId,
    displayName: cleanText(input.displayName, 120),
    labels: parseLabels(input.labels),
  };
}

export async function issueIngestToken(input: IssueIngestTokenInput & { tokenId?: string }): Promise<{ record: IngestTokenRecord; token: string }> {
  const prepared = prepareIngestToken(input);
  const tokenId = cleanText(input.tokenId, 32) || randomBytes(8).toString('hex');
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `insert into public.studio_obs_ingest_tokens
       (token_id, token_hash, subject_type, subject_id, display_name, labels, owner, created_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     returning *`,
    [
      tokenId,
      hashToken(prepared.token),
      prepared.subjectType,
      prepared.subjectId,
      prepared.displayName,
      JSON.stringify(prepared.labels),
      ingestOwnerForToken(prepared.token),
      cleanText(input.createdBy, 120) || 'admin',
    ],
  );
  invalidateIngestTokenCache();
  return { record: rowToRecord(result.rows[0] ?? {}), token: prepared.token };
}

export async function rotateIngestToken(tokenId: string): Promise<{ record: IngestTokenRecord; token: string }> {
  const id = cleanText(tokenId, 32);
  const token = randomBytes(32).toString('hex');
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `update public.studio_obs_ingest_tokens
     set token_hash = $2, owner = $3, status = 'active', revoked_at = null, last_seen_at = null
     where token_id = $1
     returning *`,
    [id, hashToken(token), ingestOwnerForToken(token)],
  );
  if (!result.rows.length) throw new Error('ingest_token_not_found');
  invalidateIngestTokenCache();
  return { record: rowToRecord(result.rows[0]), token };
}

export async function revokeIngestToken(tokenId: string): Promise<IngestTokenRecord> {
  const id = cleanText(tokenId, 32);
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `update public.studio_obs_ingest_tokens
     set status = 'revoked', revoked_at = now()
     where token_id = $1
     returning *`,
    [id],
  );
  if (!result.rows.length) throw new Error('ingest_token_not_found');
  invalidateIngestTokenCache();
  return rowToRecord(result.rows[0]);
}

export async function listIngestTokens(): Promise<IngestTokenRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select * from public.studio_obs_ingest_tokens
     order by (status = 'active') desc, created_at desc limit 500`,
  );
  return result.rows.map(rowToRecord);
}

// token 哈希 → 解析结果 60s 缓存：摄取路径每次请求都要验凭据，避免每次打库。
// 只缓存 active 命中（新签发 token 立即可用）；吊销/轮换走显式失效。
const tokenCache = new Map<string, { resolved: ResolvedIngestToken; expiresAt: number }>();

export async function resolveIngestToken(token: string): Promise<ResolvedIngestToken | null> {
  const presented = cleanText(token, 128);
  if (!/^[a-f0-9]{64}$/i.test(presented)) return null;
  // 注册表不可用（未配库/库故障）按"非注册表凭据"处理：固定 token 未配置时
  // 调用方回落到匿名凭据隔离，配置了固定 token 时自然拒绝——鉴权路径不允许抛错。
  if (!String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim()) return null;
  const tokenHash = hashToken(presented);
  const cached = tokenCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.resolved;
  if (cached) tokenCache.delete(tokenHash);
  let result: { rows: Array<Record<string, unknown>> };
  try {
    const p = await pool();
    await ensureSchema(p);
    result = await p.query(
      `select token_id, subject_type, subject_id, owner
         from public.studio_obs_ingest_tokens
        where token_hash = $1 and status = 'active'
        limit 1`,
      [tokenHash],
    );
  } catch {
    return null;
  }
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const resolved: ResolvedIngestToken = {
    tokenId: String(row.token_id ?? ''),
    subjectType: normalizeSubjectType(row.subject_type) ?? 'service',
    subjectId: String(row.subject_id ?? ''),
    owner: String(row.owner ?? ''),
  };
  tokenCache.set(tokenHash, { resolved, expiresAt: Date.now() + 60_000 });
  void pool()
    .then((client) => client.query(
      `update public.studio_obs_ingest_tokens set last_seen_at = now() where token_id = $1`,
      [resolved.tokenId],
    ))
    .catch(() => undefined);
  return resolved;
}
export function invalidateIngestTokenCache(): void {
  tokenCache.clear();
}
