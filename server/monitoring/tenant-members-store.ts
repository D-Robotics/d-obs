/**
 * 租户组员登记：studio_obs_tenants 与主站 SSO 账号的映射。
 *
 * d-obs 不建立第二套账号体系（D-010：鉴权不复制）：组员以主站 SSO user id
 * 引用，登录与会话校验由 sso-relay.ts 经主站完成。一个账号可加入多个租户；
 * 租户内分 owner（管理组员、轮换探针 token）与 member（本租户只读视图）。
 *
 * 表结构幂等自建；数据库不可用时调用方 fail-closed（401/403/503），异常
 * 不得穿透 Express async handler 触发进程崩溃。函数接受可选 Pool 注入，
 * 供回归测试使用假连接池。
 */
import { ensureTenantTables, validTenantId } from './tenant-store.js';

const SSO_USER_ID_PATTERN = /^[A-Za-z0-9_.:@-]{4,128}$/;

export type TenantMemberRole = 'owner' | 'member';

export interface TenantMember {
  tenantId: string;
  ssoUserId: string;
  displayName: string;
  role: TenantMemberRole;
  addedBy: string;
  createdAt: string;
}

/** 账号在某租户中的成员关系（租户必须处于 active 状态）。 */
export interface TenantMembership {
  tenantId: string;
  tenantDisplayName: string;
  ssoUserId: string;
  memberDisplayName: string;
  role: TenantMemberRole;
}

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

let membersPool: Promise<Pool> | null = null;
let testPool: Pool | null = null;

/** 回归测试注入点：整体替换默认池解析并重置 schema 缓存。 */
export function configureTenantMembersPoolForTest(p: Pool | null): void {
  testPool = p;
  membersSchemaReady = null;
}

async function pool(): Promise<Pool> {
  if (testPool) return testPool;
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!membersPool) {
    membersPool = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      membersPool = null;
      throw error;
    });
  }
  return membersPool;
}

export function validSsoUserId(value: unknown): value is string {
  const id = String(value ?? '').trim();
  return SSO_USER_ID_PATTERN.test(id);
}

let membersSchemaReady: Promise<void> | null = null;
async function ensureMembersSchema(p: Pool): Promise<void> {
  if (!membersSchemaReady) {
    membersSchemaReady = (async () => {
      // 组员表引用租户表行，先保证租户表存在（幂等，DDL 与 tenant-store 同源）。
      await ensureTenantTables(p);
      await p.query(`
        create table if not exists public.studio_obs_tenant_members (
          tenant_id text not null,
          sso_user_id text not null,
          display_name text not null default '',
          role text not null default 'member' check (role in ('owner', 'member')),
          added_by text not null default '',
          created_at timestamptz not null default now(),
          primary key (tenant_id, sso_user_id)
        )
      `);
      await p.query(
        `create index if not exists studio_obs_tenant_members_user_idx
           on public.studio_obs_tenant_members (sso_user_id)`,
      );
    })().catch((error) => {
      membersSchemaReady = null;
      throw error;
    });
  }
  await membersSchemaReady;
}

function rowToMember(row: Record<string, unknown>): TenantMember {
  return {
    tenantId: String(row.tenant_id ?? ''),
    ssoUserId: String(row.sso_user_id ?? ''),
    displayName: String(row.display_name ?? ''),
    role: row.role === 'owner' ? 'owner' : 'member',
    addedBy: String(row.added_by ?? ''),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
}

function rowToMembership(row: Record<string, unknown>): TenantMembership {
  return {
    tenantId: String(row.tenant_id ?? ''),
    tenantDisplayName: String(row.tenant_display_name ?? ''),
    ssoUserId: String(row.sso_user_id ?? ''),
    memberDisplayName: String(row.display_name ?? ''),
    role: row.role === 'owner' ? 'owner' : 'member',
  };
}

/** 组员查询基线：只 join active 租户，停用租户的成员关系对请求不可见。 */
const MEMBER_SELECT = `
  select m.tenant_id, m.sso_user_id, m.display_name, m.role, m.added_by, m.created_at,
         t.display_name as tenant_display_name
    from public.studio_obs_tenant_members m
    join public.studio_obs_tenants t on t.tenant_id = m.tenant_id
   where t.status = 'active'`;

export async function listMembers(
  tenantId: string,
  injectedPool?: Pool,
): Promise<TenantMember[]> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `${MEMBER_SELECT} and m.tenant_id = $1 order by m.created_at asc, m.sso_user_id asc`,
    [String(tenantId ?? '').trim()],
  );
  return result.rows.map(rowToMember);
}

export async function listMembershipsForUser(
  ssoUserId: string,
  injectedPool?: Pool,
): Promise<TenantMembership[]> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `${MEMBER_SELECT} and m.sso_user_id = $1 order by m.created_at asc`,
    [String(ssoUserId ?? '').trim()],
  );
  return result.rows.map(rowToMembership);
}

export async function findMembership(
  tenantId: string,
  ssoUserId: string,
  injectedPool?: Pool,
): Promise<TenantMembership | null> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `${MEMBER_SELECT} and m.tenant_id = $1 and m.sso_user_id = $2`,
    [String(tenantId ?? '').trim(), String(ssoUserId ?? '').trim()],
  );
  return result.rows[0] ? rowToMembership(result.rows[0]) : null;
}

export async function countOwners(
  tenantId: string,
  injectedPool?: Pool,
): Promise<number> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `select count(*)::int as owners
       from public.studio_obs_tenant_members m
       join public.studio_obs_tenants t on t.tenant_id = m.tenant_id
      where m.tenant_id = $1 and m.role = 'owner' and t.status = 'active'`,
    [String(tenantId ?? '').trim()],
  );
  return Number(result.rows[0]?.owners ?? 0);
}

export async function countMembersByTenant(
  injectedPool?: Pool,
): Promise<Record<string, number>> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `select tenant_id, count(*)::int as members
       from public.studio_obs_tenant_members group by tenant_id`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [String(row.tenant_id ?? ''), Number(row.members ?? 0)]),
  );
}

export async function addMember(
  input: {
    tenantId: string;
    ssoUserId: unknown;
    displayName?: unknown;
    role: TenantMemberRole;
    addedBy: string;
  },
  injectedPool?: Pool,
): Promise<TenantMember> {
  const tenantId = String(input.tenantId ?? '').trim();
  const ssoUserId = String(input.ssoUserId ?? '').trim();
  const displayName = String(input.displayName ?? '').trim().slice(0, 80);
  if (!validTenantId(tenantId)) throw new Error('tenant_id_invalid');
  if (!validSsoUserId(ssoUserId)) throw new Error('invalid_sso_user_id');
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `insert into public.studio_obs_tenant_members (tenant_id, sso_user_id, display_name, role, added_by)
     select $1, $2, $3, $4, $5
       from public.studio_obs_tenants t
      where t.tenant_id = $1 and t.status = 'active'
      on conflict (tenant_id, sso_user_id) do nothing
      returning tenant_id, sso_user_id, display_name, role, added_by, created_at`,
    [tenantId, ssoUserId, displayName, input.role, String(input.addedBy ?? '').slice(0, 120)],
  );
  if (!result.rows[0]) {
    const tenant = await p.query(
      `select status from public.studio_obs_tenants where tenant_id = $1`,
      [tenantId],
    );
    if (!tenant.rows[0]) throw new Error('tenant_not_found');
    if (String(tenant.rows[0].status ?? '') !== 'active') throw new Error('tenant_disabled');
    throw new Error('member_already_exists');
  }
  return rowToMember(result.rows[0]);
}

export async function setMemberRole(
  tenantId: string,
  ssoUserId: string,
  role: TenantMemberRole,
  injectedPool?: Pool,
): Promise<TenantMember> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `update public.studio_obs_tenant_members set role = $3
      where tenant_id = $1 and sso_user_id = $2
      returning tenant_id, sso_user_id, display_name, role, added_by, created_at`,
    [String(tenantId ?? '').trim(), String(ssoUserId ?? '').trim(), role],
  );
  if (!result.rows[0]) throw new Error('member_not_found');
  return rowToMember(result.rows[0]);
}

export async function removeMember(
  tenantId: string,
  ssoUserId: string,
  injectedPool?: Pool,
): Promise<TenantMember> {
  const p = injectedPool ?? (await pool());
  await ensureMembersSchema(p);
  const result = await p.query(
    `delete from public.studio_obs_tenant_members
      where tenant_id = $1 and sso_user_id = $2
      returning tenant_id, sso_user_id, display_name, role, added_by, created_at`,
    [String(tenantId ?? '').trim(), String(ssoUserId ?? '').trim()],
  );
  if (!result.rows[0]) throw new Error('member_not_found');
  return rowToMember(result.rows[0]);
}
