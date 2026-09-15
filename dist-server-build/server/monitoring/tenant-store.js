/**
 * 多团队租户注册与探针 token 管理。
 *
 * 租户 = 一支团队的可观测隔离单元：自有探针 token（库里只存 sha256 哈希）、
 * 按租户隔离的 external-* 检查/事故/通知行（tenant_id 列过滤）、独立的
 * 工作台只读视图。平台管理员用 x-admin-token 管理租户；团队用
 * RDK_TENANT_REGISTRATION_TOKEN 对应的自助注册端点建租户。
 *
 * 命名空间约定：租户 external 检查的 alert_key 为 `t.<tenantId>.<checkKey>`，
 * 与平台自身（'platform'，沿用裸 key）互不冲突。
 */
import { createHash, randomBytes } from 'node:crypto';
const TENANT_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const RESERVED_TENANT_IDS = new Set(['platform', 'admin', 'self', 'default', '106.53']);
const TENANT_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
let tenantsPool = null;
async function pool() {
    const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
    if (!connectionString)
        throw new Error('central database is not configured');
    if (!tenantsPool) {
        tenantsPool = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString, max: 2 });
        })().catch((error) => {
            tenantsPool = null;
            throw error;
        });
    }
    return tenantsPool;
}
export function hashTenantToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export function generateTenantToken() {
    return randomBytes(32).toString('hex');
}
export function validTenantId(value) {
    const id = String(value ?? '').trim();
    return TENANT_ID_PATTERN.test(id) && !RESERVED_TENANT_IDS.has(id);
}
let tenantsSchemaReady = null;
async function ensureTenantsSchema(p) {
    if (!tenantsSchemaReady) {
        tenantsSchemaReady = (async () => {
            await p.query(`
        create table if not exists public.studio_obs_tenants (
          tenant_id text primary key,
          display_name text not null,
          probe_token_hash text not null unique,
          status text not null default 'active' check (status in ('active', 'disabled')),
          created_at timestamptz not null default now(),
          created_by text not null default ''
        )
      `);
            await p.query(`create index if not exists studio_obs_tenants_status_idx on public.studio_obs_tenants (status)`);
        })().catch((error) => {
            tenantsSchemaReady = null;
            throw error;
        });
    }
    await tenantsSchemaReady;
}
function rowToTenant(row) {
    return {
        tenantId: String(row.tenant_id ?? ''),
        displayName: String(row.display_name ?? ''),
        status: row.status === 'disabled' ? 'disabled' : 'active',
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
        createdBy: String(row.created_by ?? ''),
    };
}
/** token → 租户的短缓存（60s）；rotate/禁用后必须显式失效。 */
const tenantByTokenHash = new Map();
export function invalidateTenantTokenCache() {
    tenantByTokenHash.clear();
}
export async function findTenantByToken(token) {
    const provided = String(token ?? '').trim();
    if (!TENANT_TOKEN_PATTERN.test(provided))
        return null;
    const hash = hashTenantToken(provided);
    const cached = tenantByTokenHash.get(hash);
    if (cached && Date.now() - cached.at < 60_000)
        return cached.tenant;
    const p = await pool();
    await ensureTenantsSchema(p);
    const result = await p.query(`select tenant_id, display_name, status, created_at, created_by
       from public.studio_obs_tenants
      where probe_token_hash = $1 and status = 'active'`, [hash]);
    const tenant = result.rows[0] ? rowToTenant(result.rows[0]) : null;
    if (tenant)
        tenantByTokenHash.set(hash, { tenant, at: Date.now() });
    return tenant;
}
export async function createTenant(input) {
    const tenantId = String(input.tenantId ?? '').trim();
    const displayName = String(input.displayName ?? '').trim() || tenantId;
    if (!validTenantId(tenantId))
        throw new Error('tenant_id_invalid');
    if (displayName.length > 80)
        throw new Error('tenant_display_name_too_long');
    const p = await pool();
    await ensureTenantsSchema(p);
    const token = generateTenantToken();
    const result = await p.query(`insert into public.studio_obs_tenants (tenant_id, display_name, probe_token_hash, status, created_by)
     values ($1, $2, $3, 'active', $4)
     on conflict (tenant_id) do nothing
     returning tenant_id, display_name, status, created_at, created_by`, [tenantId, displayName, hashTenantToken(token), input.createdBy]);
    if (!result.rows[0])
        throw new Error('tenant_already_exists');
    return { tenant: rowToTenant(result.rows[0]), token };
}
export async function listTenants() {
    const p = await pool();
    await ensureTenantsSchema(p);
    const result = await p.query(`select t.tenant_id, t.display_name, t.status, t.created_at, t.created_by,
            max(s.reported_at) last_report_at
       from public.studio_obs_tenants t
       left join public.studio_external_probe_status s on s.tenant_id = t.tenant_id
      group by t.tenant_id
      order by t.created_at desc`);
    return result.rows.map((row) => ({
        ...rowToTenant(row),
        lastReportAt: row.last_report_at instanceof Date ? row.last_report_at.toISOString() : null,
    }));
}
export async function rotateTenantToken(tenantId) {
    const p = await pool();
    await ensureTenantsSchema(p);
    const token = generateTenantToken();
    const result = await p.query(`update public.studio_obs_tenants set probe_token_hash = $2 where tenant_id = $1 returning tenant_id`, [tenantId, hashTenantToken(token)]);
    if (!result.rows[0])
        throw new Error('tenant_not_found');
    invalidateTenantTokenCache();
    return token;
}
export async function setTenantStatus(tenantId, status) {
    const p = await pool();
    await ensureTenantsSchema(p);
    const result = await p.query(`update public.studio_obs_tenants set status = $2 where tenant_id = $1 returning tenant_id`, [tenantId, status]);
    if (!result.rows[0])
        throw new Error('tenant_not_found');
    invalidateTenantTokenCache();
}
