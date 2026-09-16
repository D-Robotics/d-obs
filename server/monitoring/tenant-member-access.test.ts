/**
 * SSO 组员访问矩阵集成回归：登录中继路由、/auth/me 会话恢复、组员作用域
 * 只读本租户 overview、owner 加删组员与轮换 token、member 越权 403、
 * 最后 owner 防锁死、admin token 优先级、未配置中继时全部端点 fail-closed。
 *
 * 起真实 HTTP 服务器驱动 ops router（模式与 ops-event-ingest.test.ts 相同）：
 * 组员库/租户库/审计库通过 store 的测试池注入点替换（不 monkey-patch ESM
 * namespace），主站中继用全局 fetch 替换注入。服务器在 finally 中关闭。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';

import { createOpsObservabilityRouter } from './observability-routes.js';
import { resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import {
  configureOpsObservabilityPoolForTest,
  recordOpsConfigurationAudit,
} from './observability-store.js';
import {
  configureTenantPoolForTest,
  invalidateTenantTokenCache,
} from './tenant-store.js';
import { configureTenantMembersPoolForTest } from './tenant-members-store.js';
import {
  resetSsoRelayLoginRateForTest,
  resetSsoRelaySessionCacheForTest,
  type SsoRelayUser,
} from './sso-relay.js';

const SID = 'a'.repeat(64);
const SID_MEMBER = 'b'.repeat(64);
const ADMIN_TOKEN = 't'.repeat(64);
const ENV_KEYS = [
  'RDK_CREDITS_ADMIN_TOKEN',
  'RDK_SSO_RELAY_BASE_URL',
  'RDK_FLYWHEEL_ADMIN_USER_IDS',
  'RDK_CHAT_CREDITS_DB_URL',
] as const;

type FakePool = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let closedServers: Array<() => Promise<void>> = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  savedFetch = globalThis.fetch;
  resetSsoRelaySessionCacheForTest();
  resetSsoRelayLoginRateForTest();
  resetObservabilityAccessAdapter();
  configureOpsObservabilityPoolForTest(null);
  configureTenantPoolForTest(null);
  configureTenantMembersPoolForTest(null);
});

afterEach(async () => {
  for (const close of closedServers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  (globalThis as { fetch: unknown }).fetch = savedFetch;
  resetSsoRelaySessionCacheForTest();
  resetSsoRelayLoginRateForTest();
  resetObservabilityAccessAdapter();
  configureOpsObservabilityPoolForTest(null);
  configureTenantPoolForTest(null);
  configureTenantMembersPoolForTest(null);
});

/**
 * 假 relay fetch：会话→用户表（不同用户用不同会话 ID，60s 缓存按 SID 键）+
 * 登录账本（alice/secret 成功，其余 401）。
 */
function fakeRelayFetch(options: {
  sessionUser?: SsoRelayUser | null;
  /** 与 sessionUser 并列的额外会话（如同测试里 owner/member 双角色）。 */
  sessions?: Record<string, SsoRelayUser>;
}): typeof fetch {
  const sessions: Record<string, SsoRelayUser> = {
    ...(options.sessionUser ? { [SID]: options.sessionUser } : {}),
    ...(options.sessions ?? {}),
  };
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/sso/me')) {
      const sid = new Headers(init?.headers).get('x-rdk-sso-session') ?? '';
      const user = sessions[sid];
      if (user) {
        return Response.json({ user, sessionId: sid });
      }
      return Response.json({ user: null });
    }
    if (url.endsWith('/api/sso/direct/login')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { userName?: string; password?: string };
      if (body.userName === 'alice' && body.password === 'secret') {
        return Response.json({ ok: true, user: { id: 'u-0001' }, sessionId: SID });
      }
      return Response.json({ ok: false, error: 'bad credentials' }, { status: 401 });
    }
    if (url.endsWith('/api/sso/logout')) {
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * 假中心库：内存成员表 + 租户表 + 审计账本，一个池同时喂三个 store。
 * SQL 文本语境分发（与 tenant-members-store.test.ts 同款判定思路）。
 */
function fakeCentralDb(
  tenants: Array<{ tenantId: string; displayName?: string; status?: 'active' | 'disabled' }>,
  members: Array<{ tenantId: string; ssoUserId: string; role: 'owner' | 'member' }>,
  probeTokens: Record<string, string> = {},
): FakePool {
  const tokenHashToTenant = new Map(
    Object.entries(probeTokens).map(([token, tenantId]) => [
      createHash('sha256').update(token).digest('hex'),
      tenantId,
    ]),
  );
  const tenantRows = new Map(
    tenants.map((t) => [
      t.tenantId,
      {
        tenant_id: t.tenantId,
        display_name: t.displayName ?? `显示名 ${t.tenantId}`,
        status: t.status ?? 'active',
        created_at: new Date(0),
        created_by: 'test',
        probe_token_hash: '',
        last_report_at: null,
      },
    ]),
  );
  const memberRows = members.map((m, i) => ({
    tenant_id: m.tenantId,
    sso_user_id: m.ssoUserId,
    display_name: '',
    role: m.role,
    added_by: 'test',
    created_at: new Date(i * 1000),
    tenant_display_name: tenantRows.get(m.tenantId)?.display_name ?? '',
  }));
  const auditRows: unknown[] = [];
  const db: FakePool = {
    query: async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      // 幂等 DDL 直接成功（create table / create index / alter table）。
      if (/^(create (table|index)|alter table)/.test(sql)) return { rows: [] };
      // 探针 token 哈希查找（findTenantByToken；SQL 里限定 active）。
      if (sql.includes('probe_token_hash = $1')) {
        const tid = tokenHashToTenant.get(String(params?.[0] ?? ''));
        const tenant = tid ? tenantRows.get(tid) : undefined;
        if (!tenant || tenant.status !== 'active') return { rows: [] };
        return { rows: [tenant] };
      }
      // 审计写入：记录后返回空。
      if (sql.startsWith('insert into public.studio_alert_configuration_audit')) {
        auditRows.push({ actor: params?.[0], action: params?.[1] });
        return { rows: [] };
      }
      // addMember 的 insert…select…returning：租户存在且 active 才有行。
      if (sql.startsWith('insert into public.studio_obs_tenant_members')) {
        const tid = String(params?.[0] ?? '');
        const uid = String(params?.[1] ?? '');
        const tenant = tenantRows.get(tid);
        if (!tenant || tenant.status !== 'active') return { rows: [] };
        if (memberRows.some((r) => r.tenant_id === tid && r.sso_user_id === uid)) {
          return { rows: [] };
        }
        const row = {
          tenant_id: tid,
          sso_user_id: uid,
          display_name: String(params?.[2] ?? ''),
          role: (String(params?.[3] ?? 'member') === 'owner' ? 'owner' : 'member') as
            | 'owner'
            | 'member',
          added_by: String(params?.[4] ?? ''),
          created_at: new Date(),
          tenant_display_name: tenant.display_name,
        };
        memberRows.push(row);
        return { rows: [row] };
      }
      // 角色更新 / 删除（带 returning，写回内存表）。
      if (sql.startsWith('update public.studio_obs_tenant_members set role')) {
        const tid = String(params?.[0] ?? '');
        const uid = String(params?.[1] ?? '');
        const row = memberRows.find((r) => r.tenant_id === tid && r.sso_user_id === uid);
        if (!row) return { rows: [] };
        row.role = String(params?.[2] ?? 'member') === 'owner' ? 'owner' : 'member';
        return { rows: [row] };
      }
      if (sql.startsWith('delete from public.studio_obs_tenant_members')) {
        const tid = String(params?.[0] ?? '');
        const uid = String(params?.[1] ?? '');
        const index = memberRows.findIndex((r) => r.tenant_id === tid && r.sso_user_id === uid);
        if (index < 0) return { rows: [] };
        const [row] = memberRows.splice(index, 1);
        return { rows: [row] };
      }
      // token 轮换 / 状态更新（写回租户表）。
      if (sql.startsWith('update public.studio_obs_tenants')) {
        const tid = String(params?.[0] ?? '');
        const tenant = tenantRows.get(tid);
        if (!tenant) return { rows: [] };
        if (sql.includes('probe_token_hash')) {
          tenant.probe_token_hash = String(params?.[1] ?? '');
          return { rows: [{ tenant_id: tid }] };
        }
        tenant.status = String(params?.[1] ?? 'active') === 'disabled' ? 'disabled' : 'active';
        return { rows: [{ tenant_id: tid }] };
      }
      if (sql.startsWith('select status from public.studio_obs_tenants')) {
        const tenant = tenantRows.get(String(params?.[0] ?? ''));
        return { rows: tenant ? [{ status: tenant.status }] : [] };
      }
      // addMember 冲突消歧：select status（上面的分支先命中，这里保底）。
      if (sql.startsWith('select count(*)') && sql.includes("role = 'owner'")) {
        const tid = String(params?.[0] ?? '');
        return {
          rows: [
            { owners: memberRows.filter((r) => r.tenant_id === tid && r.role === 'owner').length },
          ],
        };
      }
      if (sql.startsWith('select tenant_id, count(*)')) {
        const counts: Record<string, number> = {};
        for (const r of memberRows) counts[r.tenant_id] = (counts[r.tenant_id] ?? 0) + 1;
        return { rows: Object.entries(counts).map(([tid, n]) => ({ tenant_id: tid, members: n })) };
      }
      // MEMBER_SELECT 基线：m.sso_user_id = $1 → 用户全部成员关系。
      if (sql.includes('m.sso_user_id = $1')) {
        return { rows: memberRows.filter((r) => r.sso_user_id === String(params?.[0] ?? '')) };
      }
      if (sql.includes('m.tenant_id = $1 and m.sso_user_id = $2')) {
        return {
          rows: memberRows.filter(
            (r) =>
              r.tenant_id === String(params?.[0] ?? '') && r.sso_user_id === String(params?.[1] ?? ''),
          ),
        };
      }
      // 其余 select：租户列表 / 单租户成员列表（按 tenant_id = $1 过滤）。
      if (sql.includes('from public.studio_obs_tenants t')) {
        return { rows: [...tenantRows.values()] };
      }
      return { rows: memberRows.filter((r) => r.tenant_id === String(params?.[0] ?? '')) };
    },
  };
  return db;
}

/**
 * 起真实 HTTP 服务器驱动 ops router。测试结束统一由 afterEach 关闭。
 * env 设置、fetch 替换、三库注入在启动前完成。
 */
async function buildRouter(options: {
  relayFetch?: typeof fetch;
  db?: FakePool;
  env?: Record<string, string | undefined>;
}): Promise<{
  dispatch: (
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: unknown },
  ) => Promise<{ status: number; body: any }>;
}> {
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // 中心库注入（同一假池喂租户/组员/审计三个 store），并把 DB URL 设为
  // 非空占位（isOpsObservabilityConfigured 为真；真实 pg 池永不构造）。
  configureTenantPoolForTest(options.db ?? null);
  configureTenantMembersPoolForTest(options.db ?? null);
  configureOpsObservabilityPoolForTest(options.db ?? null);
  process.env.RDK_CHAT_CREDITS_DB_URL = options.db
    ? 'postgres://test:test@127.0.0.1:1/none'
    : undefined as unknown as string;
  if (!options.db) delete process.env.RDK_CHAT_CREDITS_DB_URL;
  if (options.relayFetch) {
    (globalThis as { fetch: unknown }).fetch = options.relayFetch;
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createOpsObservabilityRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  closedServers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    dispatch: async (
      method: string,
      path: string,
      init?: { headers?: Record<string, string>; body?: unknown },
    ) => {
      const response = await savedFetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => ({}))) as any;
      return { status: response.status, body };
    },
  };
}

test('登录中继路由：成功写缓存；错误凭据透传 401；未配置中继 503', async () => {
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({}),
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090', RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  const ok = await router.dispatch('POST', '/api/ops/auth/login', {
    body: { userName: 'alice', password: 'secret' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.sessionId, SID);
  assert.equal(ok.body.user.id, 'u-0001');

  const rejected = await router.dispatch('POST', '/api/ops/auth/login', {
    body: { userName: 'alice', password: 'wrong' },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error, 'bad credentials');

  const disabled = await buildRouter({
    env: { RDK_SSO_RELAY_BASE_URL: undefined, RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  const failClosed = await disabled.dispatch('POST', '/api/ops/auth/login', {
    body: { userName: 'alice', password: 'secret' },
  });
  assert.equal(failClosed.status, 503);
  assert.equal(failClosed.body.error, 'sso_relay_disabled');
});

test('组员作用域：member 只读本租户 overview；切到未加入租户 403 not_a_member', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }], [
    { tenantId: 'team-a', ssoUserId: 'u-0001', role: 'member' },
  ]);
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ sessionUser: { id: 'u-0001' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const memberView = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { 'x-rdk-sso-session': SID, 'x-rdk-obs-tenant': 'team-a' },
  });
  // 通过组员闸门后 overview 走假中心库聚合（不 401/403/503 鉴权类错误）。
  assert.notEqual(memberView.status, 403);
  assert.notEqual(memberView.body.error, 'not_a_member');
  assert.notEqual(memberView.body.error, 'invalid_tenant_token');

  const other = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { 'x-rdk-sso-session': SID, 'x-rdk-obs-tenant': 'team-b' },
  });
  assert.equal(other.status, 403);
  assert.equal(other.body.error, 'not_a_member');
});

test('owner 权限：可加组员/轮换本租户 token；member/探针 token 403；最后 owner 防锁死', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }], [
    { tenantId: 'team-a', ssoUserId: 'u-owner', role: 'owner' },
    { tenantId: 'team-a', ssoUserId: 'u-0002', role: 'member' },
  ]);
  // 同一 relay 携带 owner 与 member 两个会话（缓存按 SID 键，互不覆盖）。
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({
      sessions: {
        [SID]: { id: 'u-owner' },
        [SID_MEMBER]: { id: 'u-0002' },
      },
    }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const ownerHeaders = {
    'x-rdk-sso-session': SID,
    'x-rdk-obs-tenant': 'team-a',
  };
  const mutationHeaders = { ...ownerHeaders, 'x-rdk-ops-action': 'observability' };
  const memberHeaders = {
    'x-rdk-sso-session': SID_MEMBER,
    'x-rdk-obs-tenant': 'team-a',
  };
  const list = await router.dispatch('GET', '/api/ops/observability/tenants/team-a/members', {
    headers: ownerHeaders,
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.members.length, 2);

  const rotate = await router.dispatch('POST', '/api/ops/observability/tenants/team-a/token', {
    headers: mutationHeaders,
    body: {},
  });
  assert.notEqual(rotate.status, 403);

  const add = await router.dispatch('POST', '/api/ops/observability/tenants/team-a/members', {
    headers: mutationHeaders,
    body: { ssoUserId: 'u-new10', role: 'member', displayName: '新组员' },
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.member.ssoUserId, 'u-new10');

  // member 视角：名单只读（本租户可见），变更 403。
  const memberList = await router.dispatch(
    'GET',
    '/api/ops/observability/tenants/team-a/members',
    { headers: memberHeaders },
  );
  assert.equal(memberList.status, 200);
  const memberMutate = await router.dispatch(
    'POST',
    '/api/ops/observability/tenants/team-a/members',
    {
      headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' },
      body: { ssoUserId: 'u-evil1', role: 'member' },
    },
  );
  assert.equal(memberMutate.status, 403);

  // 最后 owner 降级/移除被拒（防锁死）。
  const demote = await router.dispatch(
    'POST',
    '/api/ops/observability/tenants/team-a/members/u-owner/role',
    { headers: mutationHeaders, body: { role: 'member' } },
  );
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error, 'last_owner_role_required');
  const remove = await router.dispatch(
    'DELETE',
    '/api/ops/observability/tenants/team-a/members/u-owner',
    { headers: mutationHeaders },
  );
  assert.equal(remove.status, 400);
  assert.equal(remove.body.error, 'last_owner_required');

  // 探针 token 通道：成员名单 403 tenant_read_only（同库挂探针 token，
  // 避免二次 buildRouter 替换共享池 seam）。
  const probeToken = 'e'.repeat(64);
  const tokenDb = fakeCentralDb([{ tenantId: 'team-a' }], [], { [probeToken]: 'team-a' });
  const tokenRouter = await buildRouter({ db: tokenDb, env: {} });
  const probeTokenList = await tokenRouter.dispatch(
    'GET',
    '/api/ops/observability/tenants/team-a/members',
    { headers: { 'x-tenant-token': probeToken } },
  );
  assert.equal(probeTokenList.status, 403);
  assert.equal(probeTokenList.body.error, 'tenant_read_only');
});

test('admin token 优先于 SSO 组员头：带租户头仍走全局视图', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }], []);
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ sessionUser: { id: 'u-0001' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090', RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  const res = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: {
      'x-admin-token': ADMIN_TOKEN,
      'x-rdk-sso-session': SID,
      'x-rdk-obs-tenant': 'team-a',
    },
  });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.body.error, 'not_a_member');
});

test('/auth/me：未登录 user:null；登录返回租户与 admin 标记', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }, { tenantId: 'team-b' }], [
    { tenantId: 'team-a', ssoUserId: 'u-0001', role: 'owner' },
    { tenantId: 'team-b', ssoUserId: 'u-0001', role: 'member' },
  ]);
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ sessionUser: { id: 'u-0001' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090', RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  const anonymous = await router.dispatch('GET', '/api/ops/auth/me');
  assert.equal(anonymous.body.user, null);
  assert.equal(anonymous.body.relayConfigured, true);

  const me = await router.dispatch('GET', '/api/ops/auth/me', {
    headers: { 'x-rdk-sso-session': SID },
  });
  assert.equal(me.body.user.id, 'u-0001');
  assert.equal(me.body.tenants.length, 2);
  assert.equal(me.body.tenants[0].role, 'owner');
  assert.equal(me.body.tenants[1].tenantId, 'team-b');
  assert.equal(me.body.admin, false);
});

test('未配置中继时：组员头无会话即被拒；admin token 直连不受影响', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }], []);
  const router = await buildRouter({
    db,
    env: { RDK_SSO_RELAY_BASE_URL: undefined, RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN },
  });
  // 无会话（水合 fail-closed）→ 带 tenant 头但 getSessionSsoUser 为 null → not_a_member。
  const denied = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { 'x-rdk-obs-tenant': 'team-a' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'not_a_member');
  // admin token 直连照常（租户列表走假库返回 200）。
  const admin = await router.dispatch('GET', '/api/ops/observability/tenants', {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.tenants.length, 1);
  assert.equal(admin.body.tenants[0].memberCount, 0);
});
