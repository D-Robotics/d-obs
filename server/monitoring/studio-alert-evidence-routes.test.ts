import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configureOpsObservabilityPoolForTest } from './observability-store.js';
import { configureTenantPoolForTest, invalidateTenantTokenCache } from './tenant-store.js';
import { configureTenantMembersPoolForTest } from './tenant-members-store.js';
import { registerAlertEvidenceRoutes } from './studio-alert-evidence-routes.js';

const at = '2026-10-15T09:43:57.000Z';
const token = 'f'.repeat(64);
const admin = 'a'.repeat(64);
const evidence = { windowStart: '2026-10-15T09:33:57.000Z', windowEnd: at, eventCount: 6, runCount: 2, totalGroups: 0, groups: [], samples: [], applicability: 'business' };
const envKeys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_CHAT_CREDITS_DB_URL'] as const;
let env: Record<string, string | undefined>;
let closes: Array<() => Promise<void>> = [];
beforeEach(() => {
  env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = admin;
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgres://fixture@127.0.0.1:1/none';
  configureObservabilityAccess({
    getSessionSsoUser: (req) => req.header('x-test-session') === 'member' ? { id: 'member-a' } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });
});
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  configureOpsObservabilityPoolForTest(null); configureTenantPoolForTest(null); configureTenantMembersPoolForTest(null);
  invalidateTenantTokenCache(); resetObservabilityAccessAdapter();
});

async function serve() {
  const reads: unknown[][] = [];
  const db = { query: async (sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes('from public.studio_alert_evidence_snapshots')) {
      reads.push(params);
      const [tenant, key, when] = params;
      if (key !== 'tool-failure-repeat' || (when && when !== at)) return { rows: [] };
      return { rows: tenant === 'platform' || tenant === 'team-a' ? [{ alert_key: key, occurred_at: new Date(at), evidence: { ...evidence, eventCount: tenant === 'team-a' ? 1 : 6 } }] : [] };
    }
    if (sql.includes('probe_token_hash = $1')) return { rows: params[0] === createHash('sha256').update(token).digest('hex') ? [{ tenant_id: 'team-a', display_name: 'Team A', status: 'active', created_at: new Date(0) }] : [] };
    if (sql.includes('m.tenant_id = $1 and m.sso_user_id = $2')) return { rows: params[0] === 'team-a' && params[1] === 'member-a' ? [{ tenant_id: 'team-a', sso_user_id: 'member-a', role: 'member', tenant_display_name: 'Team A' }] : [] };
    if (sql.includes('from public.studio_obs_tenants t')) return { rows: [{ tenant_id: 'team-a', display_name: 'Team A', status: 'active', created_at: new Date(0) }, { tenant_id: 'team-b', display_name: 'Team B', status: 'active', created_at: new Date(0) }] };
    return { rows: [] };
  } };
  configureOpsObservabilityPoolForTest(db); configureTenantPoolForTest(db); configureTenantMembersPoolForTest(db);
  const app = express(); const router = express.Router(); registerAlertEvidenceRoutes(router); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  closes.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ops/observability/alerts/`;
  return { reads, get: async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { headers });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as Record<string, any> };
  } };
}

test('anonymous and invalid credentials cannot read platform alert evidence', async () => {
  const api = await serve();
  assert.equal((await api.get('tool-failure-repeat/evidence')).status, 403);
  assert.equal((await api.get('tool-failure-repeat/evidence', { 'x-admin-token': 'invalid' })).status, 403);
  assert.equal((await api.get('tool-failure-repeat/evidence', { 'x-tenant-token': '0'.repeat(64) })).status, 401);
  assert.equal(api.reads.length, 0);
});

test('admin historical reads use exact at, old cards use latest, malformed at is rejected', async () => {
  const api = await serve(); const headers = { 'x-admin-token': admin };
  const exact = await api.get(`tool-failure-repeat/evidence?at=${encodeURIComponent(at)}`, headers);
  assert.equal(exact.status, 200); assert.equal(exact.body.evidence.runCount, 2);
  assert.equal(exact.body.occurredAt, at); assert.equal(exact.body.alertKey, 'tool-failure-repeat');
  assert.equal(exact.cache, 'no-store'); assert.equal(api.reads[0][0], 'platform');
  const offset = await api.get('tool-failure-repeat/evidence?at=2026-10-15T17%3A43%3A57%2B08%3A00', headers);
  assert.equal(offset.status, 200); assert.equal(offset.body.occurredAt, at);
  assert.equal((await api.get('tool-failure-repeat/evidence', headers)).status, 200);
  assert.equal((await api.get('tool-failure-repeat/evidence?at=2026-10-15T08%3A00%3A00Z', headers)).status, 404);
  assert.equal((await api.get('missing-rule/evidence', headers)).status, 404);
  const before = api.reads.length;
  for (const query of ['at=yesterday', 'at=', 'at=2026-10-15', 'at=2026-02-30T08%3A00%3A00Z',
    'at=2026-10-15T25%3A00%3A00Z', 'at=2026-10-15T09%3A43%3A57%2B24%3A00', 'at=1&at=2']) assert.equal((await api.get(`tool-failure-repeat/evidence?${query}`, headers)).status, 400);
  assert.equal(api.reads.length, before);
});

test('tenant tokens and SSO members stay in their own snapshot scope despite forged tenant query', async () => {
  const api = await serve();
  const probe = await api.get('tool-failure-repeat/evidence?tenant=platform', { 'x-tenant-token': token });
  assert.equal(probe.status, 200); assert.equal(probe.body.evidence.eventCount, 1); assert.equal(api.reads.at(-1)?.[0], 'team-a');
  const member = await api.get('tool-failure-repeat/evidence?tenant=team-b', { 'x-test-session': 'member', 'x-rdk-obs-tenant': 'team-a' });
  assert.equal(member.status, 200); assert.equal(member.body.evidence.eventCount, 1); assert.equal(api.reads.at(-1)?.[0], 'team-a');
  assert.equal((await api.get('tool-failure-repeat/evidence', { 'x-test-session': 'member', 'x-rdk-obs-tenant': 'team-b' })).status, 403);
  const selected = await api.get('tool-failure-repeat/evidence?tenant=team-b', { 'x-admin-token': admin });
  assert.equal(selected.status, 404); assert.equal(api.reads.at(-1)?.[0], 'team-b');
});
