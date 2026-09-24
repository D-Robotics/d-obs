/**
 * 告警域租户作用域回归：组员只读本租户事故列表与统计、组员可处置本租户
 * 事故（归属校验由 updateOpsIncident 的租户 WHERE 兜底）、跨租户键按
 * incident_not_found 拒绝（不泄露存在性）、探针 token 通道保持只读、
 * 管理员 ?tenant= 视角切换（未知租户回落全局）。
 *
 * 起真实 HTTP 服务器驱动 ops router（模式与 tenant-member-access.test.ts
 * 相同）：中心库用按 SQL 语境分发的假池注入，主站中继用全局 fetch 替换。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';

import { createOpsObservabilityRouter } from './observability-routes.js';
import { resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configureOpsObservabilityPoolForTest } from './observability-store.js';
import { configureTenantPoolForTest } from './tenant-store.js';
import { configureTenantMembersPoolForTest } from './tenant-members-store.js';
import { configureOpsEventPoolForTest } from './ops-event-store.js';
import {
  resetSsoRelayLoginRateForTest,
  resetSsoRelaySessionCacheForTest,
  type SsoRelayUser,
} from './sso-relay.js';

const SID_MEMBER = 'b'.repeat(64);
const ADMIN_TOKEN = 't'.repeat(64);
const TENANT_IDS = ['sim2real', 'microduck'];
const ENV_KEYS = [
  'RDK_CREDITS_ADMIN_TOKEN',
  'RDK_SSO_RELAY_BASE_URL',
  'RDK_FLYWHEEL_ADMIN_USER_IDS',
  'RDK_CHAT_CREDITS_DB_URL',
] as const;

type IncidentRow = {
  alert_key: string;
  tenant_id: string;
  status: 'open' | 'acknowledged' | 'silenced' | 'resolved';
  severity?: 'critical' | 'warning';
};

type FakePool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

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

function fakeRelayFetch(sessions: Record<string, SsoRelayUser>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/sso/me')) {
      const sid = new Headers(init?.headers).get('x-rdk-sso-session') ?? '';
      const user = sessions[sid];
      return Response.json(user ? { user, sessionId: sid } : { user: null });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as unknown as typeof fetch;
}

/**
 * 告警域假中心库：内存事故表 + 租户/组员表。租户过滤语义与生产一致——
 * 查询参数里出现哪个租户 id 就按哪个租户过滤（coalesce tenant_id），
 * update 的最后一个参数恒为归属过滤值（生产侧 tenantScope ?? 按键推导）。
 */
function fakeIncidentDb(input: {
  incidents: IncidentRow[];
  members: Array<{ tenantId: string; ssoUserId: string; role: 'owner' | 'member' }>;
  probeTokens?: Record<string, string>;
}): FakePool & {
  updates: Array<{ key: string; tenantFilter: string; status: string }>;
  readonly lastListParams: unknown[];
} {
  const incidents = input.incidents.map((row) => ({
    alert_key: row.alert_key,
    tenant_id: row.tenant_id,
    status: row.status,
    severity: row.severity ?? 'warning',
    title: row.alert_key,
    summary: null,
    first_seen_at: new Date('2026-09-24T00:00:00Z'),
    last_seen_at: new Date('2026-09-24T00:00:00Z'),
    resolved_at: row.status === 'resolved' ? new Date('2026-09-24T01:00:00Z') : null,
    occurrence_count: 1,
    acknowledged_at: null,
    acknowledged_by: null,
    assignee: null,
    object_id: null,
    resolution_note: null,
    silence_until: null,
    silence_reason: null,
    last_notified_at: null,
  }));
  const updates: Array<{ key: string; tenantFilter: string; status: string }> = [];
  let lastListParams: unknown[] = [];
  const tokenHashToTenant = new Map(
    Object.entries(input.probeTokens ?? {}).map(([token, tenantId]) => [
      createHash('sha256').update(token).digest('hex'),
      tenantId,
    ]),
  );
  const tenantParam = (params?: unknown[]): string | null =>
    (params ?? []).find((value): value is string => TENANT_IDS.includes(String(value))) ?? null;
  const visible = (params?: unknown[]): typeof incidents => {
    const tenant = tenantParam(params);
    return incidents.filter((row) => !tenant || (row.tenant_id || 'platform') === tenant);
  };
  const db = Object.assign(
    {
      query: async (text: string, params?: unknown[]) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (/^(create (table|index)|alter table)/.test(sql)) return { rows: [] };
        // 探针 token 哈希查找（findTenantByToken）。
        if (sql.includes('probe_token_hash = $1')) {
          const tenantId = tokenHashToTenant.get(String(params?.[0] ?? ''));
          return {
            rows: tenantId
              ? [
                  {
                    tenant_id: tenantId,
                    display_name: tenantId,
                    status: 'active',
                    created_at: new Date(0),
                    created_by: 'test',
                  },
                ]
              : [],
          };
        }
        // 组员关系查询（findMembership：tenant_id + sso_user_id 双条件）。
        if (sql.includes('m.tenant_id = $1 and m.sso_user_id = $2')) {
          return {
            rows: input.members
              .filter(
                (m) =>
                  m.tenantId === String(params?.[0] ?? '') &&
                  m.ssoUserId === String(params?.[1] ?? ''),
              )
              .map((m) => ({
                tenant_id: m.tenantId,
                sso_user_id: m.ssoUserId,
                display_name: '',
                role: m.role,
                added_by: 'test',
                created_at: new Date(0),
                tenant_display_name: m.tenantId,
              })),
          };
        }
        // 租户列表（resolveAdminTenantScope → listTenants）。
        if (sql.includes('from public.studio_obs_tenants t')) {
          return {
            rows: TENANT_IDS.map((tenantId) => ({
              tenant_id: tenantId,
              display_name: tenantId,
              status: 'active',
              created_at: new Date(0),
              created_by: 'test',
              last_report_at: null,
            })),
          };
        }
        // 事故列表 / 计数 / 统计 / 日趋势：共用租户过滤语义。
        if (sql.startsWith('select alert_key, title, severity')) {
          lastListParams.length = 0;
          lastListParams.push(...(params ?? []));
          return { rows: visible(params) };
        }
        if (sql.startsWith('select count(*)::int total from public.studio_alert_incidents')) {
          return { rows: [{ total: visible(params).length }] };
        }
        if (sql.includes('pending_count')) {
          const rows = visible(params);
          return {
            rows: [
              {
                pending_count: rows.filter((row) => row.status === 'open').length,
                processing_count: rows.filter((row) =>
                  ['acknowledged', 'silenced'].includes(row.status),
                ).length,
                closed_count: rows.filter((row) => row.status === 'resolved').length,
                today_new: 0,
                critical_active: 0,
                warning_active: 0,
                avg_ack_seconds: null,
                avg_resolve_seconds: null,
              },
            ],
          };
        }
        if (sql.includes('to_char(date_trunc')) return { rows: [] };
        // 事故处置：最后一个参数恒为归属过滤（与生产 WHERE 同语义）。
        if (sql.startsWith('update public.studio_alert_incidents')) {
          const key = String(params?.[0] ?? '');
          const tenantFilter = String(params?.[(params?.length ?? 1) - 1] ?? '');
          const row = incidents.find(
            (item) => item.alert_key === key && (item.tenant_id || 'platform') === tenantFilter,
          );
          if (!row) return { rows: [] };
          const isSilence = sql.includes('silence_until');
          const isClose = sql.includes('resolution_note');
          row.status = isClose ? 'resolved' : isSilence ? 'silenced' : 'acknowledged';
          updates.push({ key, tenantFilter, status: row.status });
          return { rows: [{ alert_key: key }], rowCount: 1 };
        }
        if (sql.startsWith('insert into public.studio_alert_incident_activity')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    },
    { updates, get lastListParams() { return lastListParams; } },
  );
  return db as FakePool & {
    updates: Array<{ key: string; tenantFilter: string; status: string }>;
    readonly lastListParams: unknown[];
  };
}

async function buildRouter(options: {
  relayFetch?: typeof fetch;
  db: FakePool;
  env?: Record<string, string | undefined>;
}) {
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  configureTenantPoolForTest(options.db);
  configureTenantMembersPoolForTest(options.db);
  configureOpsObservabilityPoolForTest(options.db);
  configureOpsEventPoolForTest(options.db);
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgres://test:test@127.0.0.1:1/none';
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

function seedDb(probeTokens: Record<string, string> = {}) {
  return fakeIncidentDb({
    incidents: [
      { alert_key: 't.sim2real.disk-full', tenant_id: 'sim2real', status: 'open', severity: 'critical' },
      { alert_key: 't.sim2real.old-flap', tenant_id: 'sim2real', status: 'resolved' },
      { alert_key: 't.microduck.latency', tenant_id: 'microduck', status: 'open' },
      { alert_key: 'north-star-retention-d1', tenant_id: 'platform', status: 'open' },
    ],
    members: [{ tenantId: 'sim2real', ssoUserId: 'u-member', role: 'member' }],
    probeTokens,
  });
}

const memberHeaders = {
  'x-rdk-sso-session': SID_MEMBER,
  'x-rdk-obs-tenant': 'sim2real',
};
const adminHeaders = { 'x-admin-token': ADMIN_TOKEN };

test('组员：事故列表与统计自动限定本租户', async () => {
  const db = seedDb();
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ [SID_MEMBER]: { id: 'u-member', name: 'member', email: 'member@example.com' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const list = await router.dispatch(
    'GET',
    '/api/ops/observability/incidents?scope=all&state=all&days=30&limit=100',
    { headers: memberHeaders },
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  assert.ok(list.body.incidents.every((row: any) => row.key.startsWith('t.sim2real.')));

  const summary = await router.dispatch(
    'GET',
    '/api/ops/observability/incidents/summary?days=7',
    { headers: memberHeaders },
  );
  assert.equal(summary.status, 200);
  assert.equal(summary.body.summary.pending, 1);
  assert.equal(summary.body.summary.closed, 1);

  // scope=mine：actor 与写侧同样脱敏后再比较（SSO 邮箱落库即 '[REDACTED]'）。
  await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.sim2real.disk-high/actions',
    { headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'acknowledge' } },
  );
  await router.dispatch('GET', '/api/ops/observability/incidents?scope=mine&state=all&days=30&limit=100', {
    headers: memberHeaders,
  });
  assert.ok(
    db.lastListParams.includes('[REDACTED]'),
    `scope=mine 的 actor 应脱敏后比较，实际参数：${JSON.stringify(db.lastListParams)}`,
  );
});

test('组员：可处置本租户事故；跨租户键按 not_found 拒绝', async () => {
  const db = seedDb();
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ [SID_MEMBER]: { id: 'u-member', name: 'member', email: 'member@example.com' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const own = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.sim2real.disk-full/actions',
    { headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'acknowledge' } },
  );
  assert.equal(own.status, 200);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].key, 't.sim2real.disk-full');
  // 归属过滤 = 组员租户本身（而非按键推导），证明走的是租户作用域链路。
  assert.equal(db.updates[0].tenantFilter, 'sim2real');

  const cross = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.microduck.latency/actions',
    { headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'acknowledge' } },
  );
  assert.equal(cross.status, 400);
  assert.equal(cross.body.error, 'incident_not_found');

  const platformRow = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/north-star-retention-d1/actions',
    { headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'acknowledge' } },
  );
  assert.equal(platformRow.status, 400);
  assert.equal(platformRow.body.error, 'incident_not_found');
});

test('组员：结案动作同样限定本租户，且强制解决方案', async () => {
  const db = seedDb();
  const router = await buildRouter({
    relayFetch: fakeRelayFetch({ [SID_MEMBER]: { id: 'u-member', name: 'member', email: 'member@example.com' } }),
    db,
    env: { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' },
  });
  const missing = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.sim2real.disk-full/actions',
    { headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'close', reason: ' ' } },
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'incident_resolution_required');

  const closed = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.sim2real.disk-full/actions',
    {
      headers: { ...memberHeaders, 'x-rdk-ops-action': 'observability' },
      body: { action: 'close', reason: '已扩容磁盘并验证写入恢复' },
    },
  );
  assert.equal(closed.status, 200);
  assert.equal(db.updates[0].status, 'resolved');
});

test('探针 token 通道：事故处置保持只读（tenant_read_only）', async () => {
  const db = seedDb({ ['f'.repeat(64)]: 'microduck' });
  const router = await buildRouter({ db, env: { RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN } });
  const res = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.microduck.latency/actions',
    {
      headers: { 'x-tenant-token': 'f'.repeat(64), 'x-rdk-ops-action': 'observability' },
      body: { action: 'acknowledge' },
    },
  );
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'tenant_read_only');
  assert.equal(db.updates.length, 0);
});

test('管理员：?tenant= 切换事故视角；未知租户回落全局', async () => {
  const db = seedDb();
  const router = await buildRouter({ db, env: { RDK_CREDITS_ADMIN_TOKEN: ADMIN_TOKEN } });
  const scoped = await router.dispatch(
    'GET',
    '/api/ops/observability/incidents?scope=all&state=all&days=30&limit=100&tenant=sim2real',
    { headers: adminHeaders },
  );
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.total, 2);

  const scopedSummary = await router.dispatch(
    'GET',
    '/api/ops/observability/incidents/summary?days=7&tenant=microduck',
    { headers: adminHeaders },
  );
  assert.equal(scopedSummary.status, 200);
  assert.equal(scopedSummary.body.summary.pending, 1);

  const globalList = await router.dispatch(
    'GET',
    '/api/ops/observability/incidents?scope=all&state=all&days=30&limit=100&tenant=no-such-tenant',
    { headers: adminHeaders },
  );
  assert.equal(globalList.status, 200);
  assert.equal(globalList.body.total, 4);

  // 管理员对任意事故的处置键按 alert_key 命名空间推导归属（现状语义不变）。
  const reopen = await router.dispatch(
    'POST',
    '/api/ops/observability/incidents/t.sim2real.old-flap/actions',
    { headers: { ...adminHeaders, 'x-rdk-ops-action': 'observability' }, body: { action: 'reopen' } },
  );
  assert.equal(reopen.status, 200);
  assert.equal(db.updates[0].key, 't.sim2real.old-flap');
});
