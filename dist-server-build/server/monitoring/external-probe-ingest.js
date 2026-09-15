/**
 * 异地拨测心跳摄取（多团队版）。
 *
 * 入口位于 /api/health/external-probe-report（SSO 公共豁免范围），必须携带
 * 独立 256-bit 探针 token：
 *  - 平台自带探针：x-rdk-external-probe-token（token 文件，常量时间比较），
 *    写入归属 'platform'；
 *  - 租户探针：x-rdk-tenant-probe-token（库内哈希查找，60s 缓存），写入归属
 *    该租户。两类 token 同为 64-hex；先匹配平台 token，再走租户查找，两者
 *    命中任一才接受上报，否则 401。
 *
 * 只接受固定检查 key、布尔状态、计数和短摘要。租户上报的 alert_key 统一
 * 命名空间化为 `t.<tenantId>.<key>`，与平台自身的裸 key 互不冲突。
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { findTenantByToken } from './tenant-store.js';
const TOKEN_PATH = String(process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH ?? '').trim() ||
    '/var/lib/rdstudio-alert-worker/external-probe-token';
const ALLOWED_KEYS = new Set([
    'external-dns',
    'external-tls',
    'external-health',
    'external-entry-asset',
]);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
let cachedToken = '';
let cachedTokenAt = 0;
async function fileToken() {
    if (cachedToken && Date.now() - cachedTokenAt < 60_000)
        return cachedToken;
    const token = String(await readFile(TOKEN_PATH, 'utf8')).trim();
    if (!TOKEN_PATTERN.test(token))
        throw new Error('external probe token is not configured');
    cachedToken = token;
    cachedTokenAt = Date.now();
    return token;
}
async function platformTokenMatches(provided) {
    try {
        const expected = await fileToken();
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    catch {
        return false;
    }
}
/** 兼容旧签名：平台自带探针 token 校验。 */
export async function externalProbeTokenMatches(provided) {
    const actual = String(provided ?? '').trim();
    if (!TOKEN_PATTERN.test(actual))
        return false;
    return platformTokenMatches(actual);
}
/**
 * 解析一次上报的身份：平台 token → platform；否则按租户 token 哈希查找。
 * 返回 null 表示两类凭证都不匹配（401）。
 */
export async function resolveProbeReportIdentity(platformHeader, tenantHeader) {
    const platform = String(platformHeader ?? '').trim();
    if (platform && TOKEN_PATTERN.test(platform) && (await platformTokenMatches(platform))) {
        return { scopeId: 'platform', source: '106.53' };
    }
    const tenant = await findTenantByToken(String(tenantHeader ?? '').trim());
    if (tenant)
        return { scopeId: tenant.tenantId, source: `tenant:${tenant.tenantId}` };
    return null;
}
export function parseExternalProbeReport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    const generatedAt = String(input.generatedAt ?? '').trim();
    if (!Number.isFinite(Date.parse(generatedAt)))
        return null;
    if (input.source !== '106.53' || !Array.isArray(input.checks))
        return null;
    const checks = [];
    for (const raw of input.checks.slice(0, 8)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        const item = raw;
        const key = String(item.key ?? '').trim();
        if (!ALLOWED_KEYS.has(key) ||
            typeof item.enabled !== 'boolean' ||
            typeof item.ok !== 'boolean' ||
            typeof item.active !== 'boolean') {
            return null;
        }
        checks.push({
            key,
            title: sanitizeOpsSummary(item.title, 120) || key,
            enabled: item.enabled,
            ok: item.ok,
            active: item.active,
            failures: Math.max(0, Math.min(1000, Math.floor(Number(item.failures) || 0))),
            successes: Math.max(0, Math.min(1000, Math.floor(Number(item.successes) || 0))),
            detail: sanitizeOpsSummary(item.detail, 300),
        });
    }
    if (checks.length !== ALLOWED_KEYS.size || new Set(checks.map((item) => item.key)).size !== checks.length) {
        return null;
    }
    return { generatedAt: new Date(generatedAt).toISOString(), source: '106.53', checks };
}
let poolReady = null;
async function pool() {
    const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
    if (!connectionString)
        throw new Error('central database is not configured');
    if (!poolReady) {
        poolReady = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString, max: 2 });
        })().catch((error) => {
            poolReady = null;
            throw error;
        });
    }
    return poolReady;
}
/** 租户行的 alert_key 命名空间：t.<tenantId>.<checkKey>。 */
export function tenantAlertKey(tenantId, checkKey) {
    return `t.${tenantId}.${checkKey}`;
}
async function ensureTenantColumns(p) {
    await p.query(`create table if not exists public.studio_external_probe_status (
       tenant_id text not null default 'platform',
       source text not null,
       reported_at timestamptz not null,
       status text not null,
       checks jsonb not null default '[]'::jsonb,
       primary key (tenant_id, source)
     )`);
    await p.query(`alter table public.studio_external_probe_status
       add column if not exists tenant_id text not null default 'platform'`);
    // 旧单列主键部署升级：删除以 source 为唯一键的约束（单列 PK 或唯一
    // 索引），再建 (tenant_id, source) 复合主键。幂等：已是复合主键时
    // drop/add 都不生效。
    await p
        .query(`select conname from pg_catalog.pg_constraint
        where conrelid = 'public.studio_external_probe_status'::regclass
          and contype = 'p'`)
        .then(async (result) => {
        const names = result.rows.map((row) => String(row.conname));
        const singleColumnPk = names.length === 1 && /studio_external_probe_status/.test(names[0]);
        if (!singleColumnPk)
            return;
        await p.query(`alter table public.studio_external_probe_status drop constraint ${names[0]}`);
    })
        .catch(() => { });
    await p
        .query(`alter table public.studio_external_probe_status
         add primary key (tenant_id, source)`)
        .catch((error) => {
        // 已存在同名复合主键时忽略（42P10 之前的部署或并发建表）。
        if (error.code === '42P10')
            return undefined;
        if (error.code === '42P07')
            return undefined;
        throw error;
    });
    await p.query(`create index if not exists studio_external_probe_status_tenant_idx
       on public.studio_external_probe_status (tenant_id)`);
    await p.query(`alter table public.studio_alert_checks add column if not exists tenant_id text not null default 'platform'`);
    await p.query(`create index if not exists studio_alert_checks_tenant_idx
       on public.studio_alert_checks (tenant_id)`);
    await p.query(`alter table public.studio_alert_incidents add column if not exists tenant_id text not null default 'platform'`);
    await p.query(`create index if not exists studio_alert_incidents_tenant_idx
       on public.studio_alert_incidents (tenant_id)`);
    await p.query(`alter table public.studio_alert_notifications add column if not exists tenant_id text not null default 'platform'`);
    await p.query(`create index if not exists studio_alert_notifications_tenant_idx
       on public.studio_alert_notifications (tenant_id)`);
}
/**
 * 按上报身份写入探针状态/检查/事故行。平台身份保持裸 key（向后兼容），
 * 租户身份写 `t.<tid>.<key>`，同时带 tenant_id 列，读侧按租户过滤。
 */
export async function recordExternalProbeReport(report, identity = { scopeId: 'platform', source: '106.53' }) {
    const tenantId = identity.scopeId;
    const p = await pool();
    await ensureTenantColumns(p);
    await p.query(`insert into public.studio_external_probe_status (tenant_id, source, reported_at, status, checks)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (tenant_id, source) do update
       set reported_at = excluded.reported_at,
           status = excluded.status,
           checks = excluded.checks`, [
        tenantId,
        identity.source,
        report.generatedAt,
        report.checks.some((item) => item.active) ? 'critical' : 'healthy',
        JSON.stringify(report.checks),
    ]);
    for (const check of report.checks) {
        const alertKey = tenantId === 'platform' ? check.key : tenantAlertKey(tenantId, check.key);
        const severity = check.key === 'external-dns' ? 'warning' : 'critical';
        await p.query(`insert into public.studio_alert_checks
         (alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at,
          failure_streak, success_streak, tenant_id)
         values ($1, $2, 'probe', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (alert_key) do update
         set title = excluded.title,
             category = 'probe',
             enabled = excluded.enabled,
             severity = excluded.severity,
             unhealthy = excluded.unhealthy,
             active = excluded.active,
             summary = excluded.summary,
             checked_at = excluded.checked_at,
             failure_streak = excluded.failure_streak,
             success_streak = excluded.success_streak,
             tenant_id = excluded.tenant_id`, [
            alertKey,
            check.title,
            check.enabled,
            severity,
            check.enabled ? !check.ok : false,
            check.enabled ? check.active : false,
            check.enabled
                ? tenantId === 'platform'
                    ? `异地 106.53：${check.detail}`
                    : `租户 ${tenantId} 拨测：${check.detail}`
                : '规则已停用',
            report.generatedAt,
            check.failures,
            check.successes,
            tenantId,
        ]);
        if (check.enabled && check.active) {
            await p.query(`insert into public.studio_alert_incidents
           (alert_key, title, severity, status, summary, first_seen_at, last_seen_at, occurrence_count, tenant_id)
         values ($1, $2, $3, 'open', $4, $5, $5, 1, $6)
         on conflict (alert_key) do update
           set status = case when public.studio_alert_incidents.status = 'resolved'
                                or (public.studio_alert_incidents.status = 'silenced'
                                    and coalesce(public.studio_alert_incidents.silence_until, now()) <= now())
                           then 'open' else public.studio_alert_incidents.status end,
               summary = excluded.summary,
               last_seen_at = excluded.last_seen_at,
               severity = excluded.severity,
               occurrence_count = public.studio_alert_incidents.occurrence_count + 1,
               silence_until = case when public.studio_alert_incidents.status = 'silenced'
                                        and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                     then null else public.studio_alert_incidents.silence_until end,
               silence_reason = case when public.studio_alert_incidents.status = 'silenced'
                                         and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                      then null else public.studio_alert_incidents.silence_reason end,
               acknowledged_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_at end,
               acknowledged_by = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_by end,
               resolved_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.resolved_at end,
               tenant_id = excluded.tenant_id`, [alertKey, check.title, severity, check.detail, report.generatedAt, tenantId]);
        }
        else {
            await p.query(`update public.studio_alert_incidents
         set status = 'resolved', last_seen_at = $2, resolved_at = $2,
             summary = '异地拨测已恢复'
         where alert_key = $1 and status = 'open'`, [alertKey, report.generatedAt]);
        }
    }
}
