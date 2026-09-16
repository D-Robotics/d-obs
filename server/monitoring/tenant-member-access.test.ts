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
import { configureOpsEventPoolForTest } from './ops-event-store.js';
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
  configureOpsEventPoolForTest(null);
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
  configureOpsEventPoolForTest(null);
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
  ) => Promise<{ status: number; headers: Headers; body: any }>;
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
  // studio_ops_events 的 schema bootstrap 也要走假池，否则集成测试会去打真实库。
  configureOpsEventPoolForTest(options.db ?? null);
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
      return { status: response.status, headers: response.headers, body };
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

test('免登：只带主站 HttpOnly Cookie（无任何自定义头）即可进入组员视图', async () => {
  // 这是「SSO 打通」的核心断言：用户在业务站登录过、从未在 d-obs 登录，浏览器
  // 只会自动带上同源 Cookie（Path=/），d-obs 必须据此解析出身份。
  const db = fakeCentralDb(
    [{ tenantId: 'team-a' }, { tenantId: 'team-b' }],
    [
      { tenantId: 'team-a', ssoUserId: 'u-0001', role: 'member' },
      { tenantId: 'team-b', ssoUserId: 'u-9999', role: 'owner' },
    ],
  );
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ sessionUser: { id: 'u-0001' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const cookie = `rdk_sso_session=${SID}; theme=dark`;

  const me = await router.dispatch('GET', '/api/ops/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, 'u-0001');
  assert.deepEqual(
    me.body.tenants.map((item: { tenantId: string }) => item.tenantId),
    ['team-a'],
  );

  const overview = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { cookie, 'x-rdk-obs-tenant': 'team-a' },
  });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.overview.tenantScope, 'team-a');

  // 没有 Cookie 就没有身份：免登不会退化成匿名放行。
  const anon = await router.dispatch('GET', '/api/ops/auth/me');
  assert.equal(anon.body.user, null);
  // 无效 Cookie 同样不解出身份。
  const stale = await router.dispatch('GET', '/api/ops/auth/me', {
    headers: { cookie: `rdk_sso_session=${'9'.repeat(64)}` },
  });
  assert.equal(stale.body.user, null);
});

test('登录响应把主站会话 Cookie 透传给浏览器（登录一次 = 主站也已登录）', async () => {
  const router = await buildRouter({
    relayFetch: (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/api/sso/direct/login')) {
        return new Response(JSON.stringify({ ok: true, user: { id: 'u-0001' }, sessionId: SID }), {
          status: 200,
          headers: [
            ['content-type', 'application/json'],
            ['set-cookie', `rdk_sso_session=${SID}; Path=/; HttpOnly; SameSite=Lax`],
            ['set-cookie', 'unrelated=1; Path=/'],
          ],
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as unknown as typeof fetch,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const login = await router.dispatch('POST', '/api/ops/auth/login', {
    body: { userName: 'alice', password: 'secret' },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie();
  assert.deepEqual(setCookie, [`rdk_sso_session=${SID}; Path=/; HttpOnly; SameSite=Lax`]);
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

/**
 * 用 node:vm 执行完整页面脚本（A+TENANTS+B+C），并按登录态预置 storage。
 *
 * 页面脚本顶层是 `(() => { ... })()`，求值时会同步跑完常量声明并进入异步启动
 * 序列。沙箱里的 fetch/storage/location 全部可控，用来断言启动分支走到了哪里。
 */
async function runWorkbenchScript(options: {
  storage?: Array<[string, string]>;
  localMirror?: Record<string, string>;
  /** /auth/me 的响应体。 */
  me?: Record<string, unknown>;
  /** 所有 API 的统一响应（默认成功空体）。 */
  accessEnabled?: boolean;
  /** 深链 hash（如 '#tenants'），用于覆盖按视图渲染的分支。 */
  hash?: string;
  /** 让非身份类请求失败（测试轮询退避）。 */
  failData?: boolean;
  /** 指定路径返回 403 + 错误码（测试 403 分级处理）。 */
  forbidden?: Record<string, string>;
}): Promise<{
  sessionStore: Map<string, string>;
  reloads: number;
  calls: Array<{ path: string; headers: Record<string, string> }>;
  /** 尚未触发的 setTimeout 回调（轮询节流用）。 */
  timers: Array<{ id: number; fn: () => void; ms: number }>;
  /** 已被 clearTimeout 取消的定时器 id。 */
  clearedTimers: number[];
  /** 切换 document.visibilityState 并派发 visibilitychange。 */
  setVisibility: (value: 'visible' | 'hidden') => void;
  /** 取出最早的待触发定时器并执行（模拟到点）。 */
  runNextTimer: () => void;
  /** 按 id 触发指定定时器（并从待触发队列移除，模拟真实到点语义）。 */
  fireTimer: (id: number) => void;
  /** 页面写入 DOM 的全部文本（toast / 提示 / 状态等）。 */
  texts: string[];
}> {
  const { Script, createContext } = await import('node:vm');
  const { OPS_TENANT_SCOPE_JS } = await import('./observability-page-tenant-scope.js');
  const { OPS_OBSERVABILITY_SCRIPT_A } = await import('./observability-page-script-a.js');
  const { OPS_OBSERVABILITY_SCRIPT_TENANTS } = await import('./observability-page-tenants.js');
  const { OPS_OBSERVABILITY_SCRIPT_B } = await import('./observability-page-script-b.js');
  const { OPS_OBSERVABILITY_SCRIPT_C } = await import('./observability-page-script-c.js');
  const sessionStore = new Map<string, string>(options.storage ?? []);
  const reloadState = { reloads: 0 };
  const calls: Array<{ path: string; headers: Record<string, string> }> = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  const textLog: string[] = [];
  const clearedTimers: number[] = [];
  let timerSeq = 0;
  let visibility: 'visible' | 'hidden' = 'visible';
  const docListeners = new Map<string, Array<() => void>>();
  const fakeElement = (): Record<string, unknown> => {
    const el: Record<string, unknown> = {
    style: {},
    value: '',
    className: '',
    hidden: false,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {
      return undefined;
    },
    replaceChildren() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    remove() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {},
    focus() {},
    getContext: () => null,
    };
    // textContent 用 setter 记日志：这样能断言页面到底给用户显示了什么。
    Object.defineProperty(el, 'textContent', {
      get: () => '',
      set: (value: unknown) => {
        const text = String(value ?? '');
        if (text.trim()) textLog.push(text);
      },
    });
    return el;
  };
  const fakeDocument = {
    getElementById: () => fakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
    createTextNode: (text: string) => ({ text }),
    get visibilityState() {
      return visibility;
    },
    addEventListener(type: string, handler: () => void) {
      const list = docListeners.get(type) ?? [];
      list.push(handler);
      docListeners.set(type, list);
    },
    body: fakeElement(),
  };
  const sandboxGlobals: Record<string, unknown> = {
    // 真实页面一定有 console；缺了它会让页面脚本里任何 console.* 直接抛
    // ReferenceError（曾经把一处探针变成“假失败”）。
    console,
    document: fakeDocument,
    addEventListener() {},
    removeEventListener() {},
    location: {
      pathname: '/dobs/ops-observability',
      href: 'https://d-obs.test/dobs/ops-observability',
      reload() {
        reloadState.reloads += 1;
      },
      hash: options.hash ?? '',
      search: '',
    },
    sessionStorage: {
      getItem: (key: string) => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStore.set(key, value),
      removeItem: (key: string) => sessionStore.delete(key),
    },
    localStorage: {
      getItem: (key: string) => options.localMirror?.[key] ?? null,
      setItem() {},
      removeItem() {},
    },
    setTimeout: (fn: () => void, ms?: number) => {
      timerSeq += 1;
      timers.push({ id: timerSeq, fn, ms: Number(ms) || 0 });
      return timerSeq;
    },
    clearTimeout: (id: number) => {
      clearedTimers.push(Number(id));
      const index = timers.findIndex((timer) => timer.id === Number(id));
      if (index >= 0) timers.splice(index, 1);
    },
    setInterval: () => 0,
    history: { replaceState() {} },
    URL,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: (input: string | URL, init?: RequestInit) => {
      const path = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({ path, headers });
      if (path.endsWith('/api/ops/auth/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              options.me ?? { ok: true, user: null, admin: false, relayConfigured: false },
            ),
        });
      }
      if (path.endsWith('/api/ops/observability/access')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, enabled: options.accessEnabled ?? false }),
        });
      }
      const forbiddenCode = Object.entries(options.forbidden ?? {}).find(([prefix]) =>
        path.includes(prefix),
      )?.[1];
      if (forbiddenCode) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ ok: false, error: forbiddenCode }),
        });
      }
      if (options.failData) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ ok: false, error: 'test_data_failure' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
  };
  sandboxGlobals.window = sandboxGlobals;
  const sandbox = createContext(sandboxGlobals);
  // 顺序与 observability-page.ts 的拼接保持一致（归属片段在最前）。
  const fullScript = [
    OPS_TENANT_SCOPE_JS,
    OPS_OBSERVABILITY_SCRIPT_A,
    OPS_OBSERVABILITY_SCRIPT_TENANTS,
    OPS_OBSERVABILITY_SCRIPT_B,
    OPS_OBSERVABILITY_SCRIPT_C,
  ].join('\n');
  const script = new Script(fullScript, { filename: 'ops-observability-inline.js' });
  script.runInContext(sandbox, { timeout: 5_000 });
  // 启动序列是 async IIFE：让微任务跑完，再断言分支结果。
  // 注意要 drain 足够多：fetch→json→403 处理→toast 这条链每个 await 会消耗
  // 不止一个 tick，drain 太少会让断言跑在 toast 之前（曾经造成一次“假失败”）。
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  return {
    sessionStore,
    reloads: reloadState.reloads,
    calls,
    timers,
    clearedTimers,
    setVisibility(value: 'visible' | 'hidden') {
      visibility = value;
      for (const handler of docListeners.get('visibilitychange') ?? []) handler();
    },
    runNextTimer() {
      const next = timers.shift();
      if (next) next.fn();
    },
    texts: textLog,
    fireTimer(id: number) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index < 0) return;
      const [timer] = timers.splice(index, 1);
      timer.fn();
    },
  };
}

test('工作台页面脚本：登录态下 opsMemberMode 求值无 TDZ 违例（声明先于引用）', async () => {
  // 前置：登录后 sessionStorage 同时有 d_obs_sso_session 与 d_obs_active_tenant，
  // && 链不再短路；若 opsMemberMode 的声明被挪到 opsAdminToken/opsTenantToken
  // 之前，整个启动 IIFE 会因 ReferenceError 静默死亡（页面无任何渲染）。
  const result = await runWorkbenchScript({
    storage: [
      ['d_obs_sso_session', SID],
      ['d_obs_active_tenant', 'team-a'],
    ],
  });
  assert.equal(result.reloads, 0);
});

test('工作台页面脚本：免登（无本地会话、只有同源 Cookie）也走组员分支', async () => {
  // 用户在业务站登录过、从未在 d-obs 登录：sessionStorage 里没有任何会话 id，
  // 身份只能由服务端从 Cookie 解析。启动序列不能因为没有本地会话就停在登录屏。
  const result = await runWorkbenchScript({
    me: {
      ok: true,
      user: { id: 'u-0001' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'owner' }],
      admin: false,
      relayConfigured: true,
    },
  });
  // 免登路径不写本地会话（凭证在 HttpOnly Cookie 里），只落默认租户后重载一次。
  assert.equal(result.sessionStore.get('d_obs_active_tenant'), 'team-a');
  assert.equal(result.sessionStore.get('d_obs_sso_session'), undefined);
  assert.equal(result.reloads, 1);
  // 没有写任何 admin/tenant token。
  assert.equal(result.sessionStore.get('d_obs_admin_token'), undefined);
});

test('工作台页面脚本：已选租户的免登组员会带租户头拉本租户视图', async () => {
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    me: {
      ok: true,
      user: { id: 'u-0001' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'member' }],
      admin: false,
      relayConfigured: true,
    },
  });
  assert.equal(result.reloads, 0);
  const overview = result.calls.find((call) => call.path.includes('/observability/overview'));
  assert.ok(overview, '应请求总览');
  assert.equal(overview.headers['x-rdk-obs-tenant'], 'team-a');
});

test('工作台页面脚本：未登录且部署要求鉴权时展示登录屏（不再静默空白）', async () => {
  const result = await runWorkbenchScript({ me: { ok: true, user: null, relayConfigured: true } });
  // 公开 /access 判定 enabled=false → 必须进登录屏；不再依赖业务端点的 401。
  assert.ok(result.calls.some((call) => call.path.endsWith('/api/ops/observability/access')));
  assert.equal(result.sessionStore.get('d_obs_active_tenant'), undefined);
});

test('租户 overview 不返回平台告警运行时元数据（不读 worker 单例/平台配置）', async () => {
  const db = fakeCentralDb([{ tenantId: 'team-a' }], [
    { tenantId: 'team-a', ssoUserId: 'u-0001', role: 'member' },
  ]);
  // 记录本次请求真正下发到中心库的 SQL，用于断言「没去读平台表」。
  const seen: string[] = [];
  const originalQuery = db.query;
  db.query = async (text: string, params?: unknown[]) => {
    seen.push(text);
    return originalQuery(text, params);
  };
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ sessionUser: { id: 'u-0001' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const viaCookie = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { cookie: `rdk_sso_session=${SID}`, 'x-rdk-obs-tenant': 'team-a' },
  });
  assert.equal(viaCookie.status, 200);
  const alerting = viaCookie.body.overview.alerting;
  // 平台配置项在租户视图里必须是中性默认值，而不是平台真实配置。
  assert.equal(alerting.workerVersion, null);
  assert.equal(alerting.channel, '');
  assert.equal(alerting.configUpdatedAt, null);
  assert.equal(alerting.webhookConfigured, false);
  assert.equal(alerting.shadowMode, false);
  // 且根本没有去查平台 worker 单例行。
  assert.equal(
    seen.some((sql) => sql.includes('studio_alert_worker_status')),
    false,
    '租户视图不应查询 studio_alert_worker_status',
  );
});

test('租户凭证只在租户面有效：gate 覆盖的只读面放行，非租户面显式 403', async () => {
  const probeToken = 'f'.repeat(64);
  const db = fakeCentralDb([{ tenantId: 'team-a' }], [], { [probeToken]: 'team-a' });
  const router = await buildRouter({ db, env: {} });

  // 1) gate 覆盖的只读面：有效租户 token 照常进入本租户视图。
  const scoped = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { 'x-tenant-token': probeToken },
  });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.overview.tenantScope, 'team-a');

  // 2) 非租户面（没有 tenantScopeGate 的管理员面）：带租户凭证必须显式拒绝，
  //    不允许退化成管理员/匿名访问。
  for (const path of [
    '/api/ops/observability/tenants',
    '/api/ops/observability/database',
    '/api/ops/observability/learning',
    '/api/ops/observability/operator-metrics',
    '/api/ops/observability/model-pool',
  ]) {
    const denied = await router.dispatch('GET', path, {
      headers: { 'x-tenant-token': probeToken },
    });
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.error, 'tenant_scope_only', path);
  }

  // 2b) 同样在 gate 覆盖内、但只给租户返回收敛桩的配置面：放行且不泄漏平台配置。
  const config = await router.dispatch('GET', '/api/ops/observability/config', {
    headers: { 'x-tenant-token': probeToken },
  });
  assert.equal(config.status, 200);
  assert.equal(config.body.config.tenantReadOnly, true);

  // 3) 无效的租户 token 在租户面上仍然是明确的 401（gate 先判定）。
  const badToken = await router.dispatch('GET', '/api/ops/observability/overview?hours=24', {
    headers: { 'x-tenant-token': '9'.repeat(64) },
  });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.error, 'invalid_tenant_token');

  // 4) 管理员 token 不受影响（租户凭证检查只在没有管理员身份时生效）。
  const adminToken = 'a1'.repeat(32);
  const adminDb = fakeCentralDb([{ tenantId: 'team-a' }], []);
  const adminRouter = await buildRouter({
    db: adminDb,
    env: { RDK_CREDITS_ADMIN_TOKEN: adminToken },
  });
  const admin = await adminRouter.dispatch('GET', '/api/ops/observability/tenants', {
    headers: { 'x-admin-token': adminToken },
  });
  assert.equal(admin.status, 200);
});

test('工作台页面脚本：管理员选中租户后概览带 ?tenant= 作用域（切换器不再是空操作）', async () => {
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    me: {
      ok: true,
      user: { id: 'u-admin' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'owner' }],
      admin: true,
      relayConfigured: true,
    },
  });
  assert.equal(result.reloads, 0, '管理员不应被强制切到组员视图');
  const overview = result.calls.find((call) => call.path.includes('/observability/overview'));
  assert.ok(overview, '应请求总览');
  assert.ok(overview.path.includes('tenant=team-a'), `管理员视角应带 tenant 参数：${overview.path}`);
  // 管理员不走组员头（服务端对管理员忽略该头，前端也不该发）。
  assert.equal(overview.headers['x-rdk-obs-tenant'], undefined);
});

test('工作台页面脚本：owner 打开 #tenants 深链能渲染租户面板并加载组员名单', async () => {
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    hash: '#tenants',
    me: {
      ok: true,
      user: { id: 'u-owner' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'owner' }],
      admin: false,
      relayConfigured: true,
    },
  });
  assert.equal(result.reloads, 0);
  // owner 视图会拉本租户组员名单（若渲染抛错就不会走到这一步）。
  assert.ok(
    result.calls.some((call) => call.path.includes('/tenants/team-a/members')),
    'owner 的 #tenants 视图应加载组员名单',
  );
});

test('工作台轮询节流：后台标签页不发请求，回到前台过期才补一次', async () => {
  const me = {
    ok: true,
    user: { id: 'u-0001' },
    tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'member' }],
    admin: false,
    relayConfigured: true,
  };
  // failData：让业务请求失败，使「最近成功加载」时间戳保持为空——这正是
  // 「数据已过期」的确定性场景（真实时钟无法在测试里快进 30s）。
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    me,
    failData: true,
  });
  const overviewCalls = () =>
    result.calls.filter((call) => call.path.includes('/observability/overview')).length;
  // 页面里还有 toast 的 3.6s 定时器，只按轮询间隔（>=30s）识别轮询排期。
  const pollTimers = () => result.timers.filter((timer) => timer.ms >= 30000);

  // 启动后会排一个轮询定时器（而不是无条件 setInterval）。
  assert.equal(pollTimers().length, 1, '应排下一次轮询');
  assert.equal(pollTimers()[0].ms, 30000, '首次轮询间隔应为 30s');

  // 可见时触发一次轮询：会真的去拉数据，并重新排期。
  const beforeVisible = overviewCalls();
  result.fireTimer(pollTimers()[0].id);
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  assert.ok(overviewCalls() > beforeVisible, '可见时的轮询应发起请求');
  assert.equal(pollTimers().length, 1, '轮询后应重新排期');

  // 切到后台：待触发的轮询被取消，之后不再发请求。
  result.setVisibility('hidden');
  assert.ok(result.clearedTimers.length >= 1, '隐藏时应清掉待触发的轮询');
  assert.equal(pollTimers().length, 0, '隐藏时不应留待触发的轮询');
  const beforeHidden = overviewCalls();
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  assert.equal(overviewCalls(), beforeHidden, '隐藏标签页不应发起任何请求');

  // 回到前台：数据从未成功加载（=已过期）→ 立即补一次；并恢复排期。
  result.setVisibility('visible');
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  assert.ok(overviewCalls() > beforeHidden, '回到前台且数据过期应补一次');
  assert.equal(pollTimers().length, 1, '回到前台应恢复排期');
});

test('工作台轮询节流：数据刚加载过时，回到前台不重复拉取（只恢复节奏）', async () => {
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    me: {
      ok: true,
      user: { id: 'u-0001' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'member' }],
      admin: false,
      relayConfigured: true,
    },
  });
  const overviewCalls = () =>
    result.calls.filter((call) => call.path.includes('/observability/overview')).length;
  const pollTimers = () => result.timers.filter((timer) => timer.ms >= 30000);
  // 成功加载一次（会写入“最近成功”时间戳）。
  result.fireTimer(pollTimers()[0].id);
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  const afterLoad = overviewCalls();
  assert.ok(afterLoad > 0, '应至少拉过一次总览');

  result.setVisibility('hidden');
  assert.equal(pollTimers().length, 0, '隐藏时应清掉轮询');
  result.setVisibility('visible');
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  assert.equal(overviewCalls(), afterLoad, '数据仍新鲜时不应重复拉取');
  assert.equal(pollTimers().length, 1, '回到前台应恢复轮询节奏');
});

test('工作台轮询节流：连续失败按指数退避（由成功时间戳驱动）', async () => {
  const result = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    failData: true,
    me: {
      ok: true,
      user: { id: 'u-0001' },
      tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'member' }],
      admin: false,
      relayConfigured: true,
    },
  });
  const pollDelay = () => {
    const timers = result.timers.filter((timer) => timer.ms >= 30000);
    return timers.length ? timers[timers.length - 1].ms : 0;
  };
  // 基础间隔。
  assert.equal(pollDelay(), 30000);
  // 连续失败：成功时间戳不更新 → 间隔翻倍退避。
  const failOnce = async () => {
    const timers = result.timers.filter((timer) => timer.ms >= 30000);
    assert.ok(timers.length >= 1, '应有待触发的轮询');
    result.fireTimer(timers[0].id);
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  };
  await failOnce();
  assert.equal(pollDelay(), 60000, '一次失败后应退避到 60s');
  await failOnce();
  assert.equal(pollDelay(), 120000, '两次失败后应退避到 120s');
  await failOnce();
  await failOnce();
  await failOnce();
  assert.equal(pollDelay(), 300000, '退避上限为 5 分钟');
});

test('403 分级：模块级降级静默（不误报），身份级变化才提示并重查身份', async () => {
  const me = {
    ok: true,
    user: { id: 'u-0001' },
    tenants: [{ tenantId: 'team-a', displayName: 'A 队', role: 'member' }],
    admin: false,
    relayConfigured: true,
  };
  // ① admin token 直连：行动域 403 是文档写明的预期降级 → 不得弹「权限已变化」。
  const adminTokenResult = await runWorkbenchScript({
    storage: [['d_obs_admin_token', 'service-token']],
    me: { ok: true, user: null, admin: false, relayConfigured: false },
    forbidden: { '/api/ops/observability/actions': 'not_authorized' },
  });
  assert.equal(
    adminTokenResult.texts.some((text) => text.includes('权限已变化')),
    false,
    `模块级 403 不应提示权限变化，实际文本：${JSON.stringify(adminTokenResult.texts.slice(-6))}`,
  );
  // 且不应因为模块级 403 去重查身份。
  const meCalls = adminTokenResult.calls.filter((call) => call.path.endsWith('/api/ops/auth/me')).length;
  assert.ok(meCalls <= 1, `模块级 403 不应触发额外身份重查，实际 ${meCalls} 次`);

  // ② 组员被移出租户：身份级 403 → 必须提示，并重查身份。
  const memberResult = await runWorkbenchScript({
    storage: [['d_obs_active_tenant', 'team-a']],
    me,
    forbidden: { '/api/ops/observability/overview': 'not_a_member' },
  });
  assert.ok(
    memberResult.texts.some((text) => text.includes('权限已变化')),
    `身份级 403 应提示权限变化，实际文本：${JSON.stringify(memberResult.texts.slice(-6))}`,
  );
  assert.ok(
    memberResult.calls.filter((call) => call.path.endsWith('/api/ops/auth/me')).length >= 2,
    '身份级 403 应重查身份',
  );
  // 已渲染内容不被清空：不出现登录屏文案（那是 401 的行为）。
  assert.equal(memberResult.texts.some((text) => text.includes('需要运营账号登录')), false);
});

test('403 分级：租户 token 打平台面是模块级收敛，不该提示“权限已变化”', async () => {
  // 租户 token 用户在平台专属模块（/learning 等）拿到 403 tenant_scope_only——
  // 这是设计内收敛，不是权限变化；若归类错误，每轮轮询都会弹一次误报。
  const probeToken = '9'.repeat(64);
  const db = fakeCentralDb([{ tenantId: 'team-a' }], [], { [probeToken]: 'team-a' });
  const router = await buildRouter({ db, env: {} });
  const denied = await router.dispatch('GET', '/api/ops/observability/learning', {
    headers: { 'x-tenant-token': probeToken },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'tenant_scope_only');

  const result = await runWorkbenchScript({
    storage: [['d_obs_tenant_token', probeToken]],
    hash: '#overview',
    me: { ok: true, user: null, admin: false, relayConfigured: false },
    forbidden: { '/api/ops/observability/learning': 'tenant_scope_only' },
  });
  assert.equal(
    result.texts.some((text) => text.includes('权限已变化')),
    false,
    `租户凭证收敛不应提示权限变化，实际：${JSON.stringify(result.texts.slice(-4))}`,
  );
});
