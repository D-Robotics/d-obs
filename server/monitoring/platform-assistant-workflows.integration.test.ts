/** Real assistant/confirmation routes and business handlers against an isolated PostgreSQL fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { registerTenantRoutes } from './observability-tenant-routes.js';
import { registerStrategyRoutes, configureStrategyPoolForTest } from './alert-strategy-routes.js';
import { PLATFORM_OPERATION_METADATA } from './platform-operation-metadata.js';
import { registerPlatformOperations } from './platform-operations.js';
import { requirePlatformAssistantAccess } from './platform-assistant-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';

const databaseUrl = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();
const API = '/api/ops/observability/assistant';
const BOARDS = '/api/ops/observability/boards';
const TENANTS = '/api/ops/observability/tenants';
const STRATEGIES = '/api/ops/observability/strategies';
const TIMEOUT = '/api/ops/observability/workflow-fixture-timeout';
type Json = Record<string, any>;
type ControlClient = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Json[] }> };
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function listen(app: ReturnType<typeof express>): Promise<{ server: Server; origin: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test('assistant proposals and confirmations preserve real board, tenant and strategy permissions', {
  skip: !databaseUrl, timeout: 75_000,
}, async (t) => {
  const selected = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname), 'workflow fixtures must use loopback');
  assert.match(selected.pathname, /^\/dobs_[a-z0-9_]*test[a-z0-9_]*$/, 'workflow fixtures must use a dedicated dobs test database');
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_CREDITS_ADMIN_TOKEN', 'RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET',
    'RDK_COPILOT_MODEL_ENABLED', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_PLATFORM_ASSISTANT_BASE_URL',
    'RDK_PLATFORM_ASSISTANT_MODEL', 'RDK_PLATFORM_ASSISTANT_API_KEY', 'GATEWAY_ADMIN_KEY'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const actorA = `workflow-a-${randomUUID()}`;
  const actorB = `workflow-b-${randomUUID()}`;
  const tenantOwner = `workflow-owner-${randomUUID()}`;
  const tenantMember = `workflow-member-${randomUUID()}`;
  const tenantId = `wf-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let outputs: Json[] = [];
  let modelCalls = 0;
  const gateway = express(); gateway.use(express.json());
  gateway.post('/v1/chat/completions', (req, res) => {
    modelCalls++;
    assert.match(req.body.messages[0].content, /确认|参数|能力目录/);
    const next = outputs.shift();
    assert.ok(next, 'an unexpected extra model request must fail this fixture');
    res.json({ choices: [{ message: { content: JSON.stringify(next) } }] });
  });
  const model = await listen(gateway);
  process.env.RDK_CHAT_CREDITS_DB_URL = databaseUrl;
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'workflow-fixture-admin';
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = 'workflow-fixture-authorization';
  process.env.RDK_COPILOT_MODEL_ENABLED = '1';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = `${actorA},${actorB}`;
  process.env.RDK_PLATFORM_ASSISTANT_BASE_URL = model.origin + '/v1';
  process.env.RDK_PLATFORM_ASSISTANT_MODEL = 'workflow-fixture';
  process.env.RDK_PLATFORM_ASSISTANT_API_KEY = 'workflow-fixture-key';
  process.env.GATEWAY_ADMIN_KEY = 'workflow-fixture-gateway';
  configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const router = express.Router();
  registerSignalsRoutes(router);
  registerTenantRoutes(router);
  registerStrategyRoutes(router);
  let uncertainSideEffects = 0;
  let uncertainClosed = false;
  let markTimeoutStarted!: () => void;
  const timeoutStarted = new Promise<void>((resolve) => { markTimeoutStarted = resolve; });
  // A fixture deliberately loses its response after a side effect. The real
  // executor's 45-second timeout and the real PostgreSQL claim remain in use.
  router.post(TIMEOUT, requirePlatformAssistantAccess, requireOpsMutationGuard, (_req, res) => {
    uncertainSideEffects++;
    res.once('close', () => { uncertainClosed = true; });
    res.flushHeaders();
    markTimeoutStarted();
  });
  const ids = [`GET ${BOARDS}`, `POST ${BOARDS}`, `POST ${BOARDS}/import`, `PUT ${BOARDS}/:boardId`,
    `DELETE ${BOARDS}/:boardId`, `GET ${BOARDS}/:boardId/export/grafana`,
    `GET ${TENANTS}`, `POST ${TENANTS}`, `POST ${TENANTS}/:tenantId/token`, `POST ${TENANTS}/:tenantId/status`,
    `GET ${TENANTS}/:tenantId/members`, `POST ${TENANTS}/:tenantId/members`,
    `POST ${TENANTS}/:tenantId/members/:ssoUserId/role`, `DELETE ${TENANTS}/:tenantId/members/:ssoUserId`,
    `GET ${STRATEGIES}`, `POST ${STRATEGIES}`, `PUT ${STRATEGIES}/:strategyId`, `DELETE ${STRATEGIES}/:strategyId`];
  registerPlatformOperations(router, Object.fromEntries(ids.map((id) => [id, PLATFORM_OPERATION_METADATA[id]])));
  registerPlatformOperations(router, { [`POST ${TIMEOUT}`]: {
    description: '仅测试：变更发生后丢失回执', group: '隔离故障测试', tenantAccessible: false,
  } });
  const app = express(); app.use(express.json()); app.use(router);
  const service = await listen(app);
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => ControlClient } }).default.Client;
  const control = new Client({ connectionString: databaseUrl }); await control.connect();
  const headers = { 'content-type': 'application/json', 'x-admin-token': 'workflow-fixture-admin',
    'x-rdk-ops-action': 'observability', 'fixture-actor': actorA };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(service.origin + path, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  const list = async (actor = actorA): Promise<Json[]> => {
    const response = await fetch(service.origin + BOARDS, { headers: { ...headers, 'fixture-actor': actor } });
    assert.equal(response.status, 200);
    return (await response.json() as Json).boards;
  };
  const chat = async (message: string, next: Json[], extra: Record<string, string> = {}): Promise<Json> => {
    assert.equal(outputs.length, 0); outputs = next;
    const response = await post(API + '/chat', { message }, extra);
    assert.equal(response.status, 200);
    const result = await response.json() as Json;
    assert.equal(outputs.length, 0);
    return result;
  };
  const proposal = async (message: string, id: string, args: Json = {}, actor = actorA): Promise<Json> => {
    const result = await chat(message, [{ operation: { id, ...args } }], { 'fixture-actor': actor });
    assert.match(result.reply, /尚未执行/);
    assert.equal(result.operations.length, 0);
    assert.equal(result.proposal.operationId, id);
    return result.proposal;
  };
  const confirm = async (item: Json, actor = actorA, extra: Record<string, string> = {}): Promise<Json> => {
    const response = await post(API + '/confirm', { token: item.token }, { 'fixture-actor': actor, ...extra });
    assert.equal(response.status, 200);
    return await response.json() as Json;
  };
  let boardId = '';
  let importedId = '';
  let probeToken = '';
  let strategyId = '';
  const tenantHeaders = (actor = tenantOwner): Record<string, string> => ({ ...headers, 'x-admin-token': '',
    'fixture-actor': actor, 'x-rdk-obs-tenant': tenantId });
  const tenantProposal = async (id: string, args: Json, actor = tenantOwner): Promise<Json> => {
    const result = await chat('请执行指定的本租户变更', [{ operation: { id, ...args } }], tenantHeaders(actor));
    assert.equal(result.operations.length, 0); assert.equal(result.proposal.operationId, id);
    return result.proposal;
  };
  try {
    assert.deepEqual(await list(), []);
    await t.test('capability guidance and missing-target clarification are returned without a mutation', async () => {
      const caps = await (await fetch(service.origin + API + '/capabilities', { headers })).json() as Json;
      assert.equal(caps.mutationConfirmationRequired, true);
      const update = caps.operations.find((item: Json) => item.id === `PUT ${BOARDS}/:boardId`);
      assert.match(update.parameters.params.boardId, /必填/);
      assert.match(update.parameters.body.spec, /panels|看板定义/);
      const before = modelCalls;
      const result = await chat('修改看板名称', [{ reply: '请提供要修改的看板 ID 和新的名称。' }]);
      assert.match(result.reply, /请提供/); assert.equal(result.proposal, undefined);
      assert.deepEqual(result.operations, []); assert.equal(modelCalls, before + 1);
      assert.deepEqual(await list(), []);
    });

    await t.test('chat creates a proposal only; exact confirmation persists a real board once', async () => {
      const spec = { windowMinutes: 60, filters: { service: 'fixture-service' },
        panels: [{ title: '错误数量', metric: 'fixture.errors', chart: 'stat', width: 2, warnValue: 5, critValue: 10 }] };
      const item = await proposal('创建一小时错误数量看板', `POST ${BOARDS}`, { body: { name: '流程验收', spec } });
      assert.deepEqual(await list(), []);
      for (const [body, extra, status] of [
        [{ token: item.token }, { 'fixture-actor': actorB }, 400],
        [{ token: item.token, body: { name: '篡改' } }, {}, 400],
        [{ token: item.token }, { 'x-rdk-ops-read-only': '1' }, 403],
        [{ token: item.token }, { 'x-rdk-ops-action': '' }, 400],
        [{ token: item.token }, { origin: 'https://foreign.invalid' }, 403],
      ] as Array<[Json, Record<string, string>, number]>) {
        assert.equal((await post(API + '/confirm', body, extra)).status, status);
      }
      assert.deepEqual(await list(), []);
      const result = await confirm(item);
      assert.equal(result.operations[0].status, 201); assert.equal(result.operations[0].ok, true);
      const board = result.operations[0].data.board; boardId = board.id;
      assert.equal(board.name, '流程验收'); assert.equal(board.spec.windowMinutes, 60);
      assert.deepEqual(board.spec.filters, spec.filters);
      assert.equal(board.spec.panels[0].metric, 'fixture.errors');
      assert.equal(board.spec.panels[0].critValue, 10);
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 409);
      assert.equal((await list()).length, 1); assert.deepEqual(await list(actorB), []);
      const persisted = await control.query('select owner,name,spec from public.studio_obs_dashboards where id=$1', [boardId]);
      assert.equal(persisted.rows[0].owner, `sso:${actorA}`); assert.equal(persisted.rows[0].name, '流程验收');
    });

    await t.test('update waits for confirmation and original handlers enforce owner isolation', async () => {
      const item = await proposal('把看板改名为更新验收', `PUT ${BOARDS}/:boardId`, { params: { boardId }, body: { name: '更新验收' } });
      assert.equal((await list())[0].name, '流程验收');
      const updated = await confirm(item); assert.equal(updated.operations[0].ok, true);
      assert.equal((await list())[0].name, '更新验收');
      const foreign = await proposal('修改这个看板名称', `PUT ${BOARDS}/:boardId`,
        { params: { boardId }, body: { name: '跨用户写入' } }, actorB);
      const denied = await confirm(foreign, actorB);
      assert.equal(denied.operations[0].status, 404); assert.equal(denied.operations[0].ok, false);
      assert.equal(denied.operations[0].data.error, 'board_not_found');
      assert.equal((await list())[0].name, '更新验收');
      assert.equal((await post(API + '/confirm', { token: foreign.token }, { 'fixture-actor': actorB })).status, 409);
    });

    await t.test('import and guarded Grafana export retain real data and authenticated download access', async () => {
      const template = { name: '导入验收', spec: { windowMinutes: 240,
        panels: [{ title: '延迟', metric: '', source: 'prometheus', queries: [{ refId: 'A', expr: 'fixture_latency' }], chart: 'line' }] } };
      const item = await proposal('导入这个看板模板', `POST ${BOARDS}/import`, { body: { template } });
      assert.equal((await list()).length, 1);
      const imported = await confirm(item); assert.equal(imported.operations[0].ok, true);
      importedId = imported.operations[0].data.board.id;
      const result = await chat('导出导入验收看板的 Grafana 文件', [
        { operation: { id: `GET ${BOARDS}/:boardId/export/grafana`, params: { boardId: importedId } } },
        { reply: '看板文件已可通过回执中的下载链接获取。' },
      ]);
      assert.equal(result.operations[0].ok, true);
      const url = result.operations[0].data.downloadUrl;
      assert.equal(url, `${BOARDS}/${importedId}/export/grafana`);
      assert.equal((await fetch(service.origin + url)).status, 403);
      assert.equal((await fetch(service.origin + url, { headers: { ...headers, 'fixture-actor': actorB } })).status, 404);
      const exported = await fetch(service.origin + url, { headers }); assert.equal(exported.status, 200);
      const dashboard = await exported.json() as Json;
      assert.match(JSON.stringify(dashboard), /fixture_latency/);
    });

    await t.test('invalid input, absent target and read-only mode cannot create or alter a board', async () => {
      const bad = await proposal('创建看板', `POST ${BOARDS}`, { body: { name: '坏参数', spec: { panels: 'invalid' } } });
      const result = await confirm(bad);
      assert.equal(result.operations[0].status, 400); assert.equal(result.operations[0].data.error, 'invalid_board_spec');
      const missing = await chat('修改看板名称', [{ operation: { id: `PUT ${BOARDS}/:boardId`, body: { name: '缺少目标' } } }]);
      assert.deepEqual(missing.operations, []);
      assert.equal(missing.proposal, undefined, 'an incomplete target must be clarified before confirmation');
      assert.match(missing.reply, /boardId|看板/);
      const missingTenant = await chat('创建租户', [{ operation: { id: `POST ${TENANTS}`, body: { tenantId: null } } }]);
      assert.deepEqual(missingTenant.operations, []); assert.equal(missingTenant.proposal, undefined);
      assert.match(missingTenant.reply, /tenantId|租户/);
      const missingMember = await chat('添加租户组员', [{ operation: { id: `POST ${TENANTS}/:tenantId/members`,
        params: { tenantId: 'never-created-fixture-tenant' }, body: { role: 'member' } } }]);
      assert.deepEqual(missingMember.operations, []); assert.equal(missingMember.proposal, undefined);
      assert.match(missingMember.reply, /ssoUserId|SSO|组员/);
      const blocked = await chat('创建看板', [{ operation: { id: `POST ${BOARDS}`, body: { name: '禁止写入' } } }], { 'x-rdk-ops-read-only': '1' });
      assert.match(blocked.reply, /unknown_operation/); assert.equal(blocked.proposal, undefined);
      assert.deepEqual(blocked.operations, []); assert.equal((await list()).length, 2);
    });

    await t.test('deletion requires its own confirmation and subsequent live reads see persisted changes', async () => {
      const item = await proposal('删除更新验收看板', `DELETE ${BOARDS}/:boardId`, { params: { boardId } });
      assert.equal((await list()).length, 2);
      const deleted = await confirm(item); assert.equal(deleted.operations[0].ok, true);
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 409);
      const remaining = await list(); assert.equal(remaining.length, 1); assert.equal(remaining[0].id, importedId);
      const result = await chat('目前有几个看板', [
        { operation: { id: `GET ${BOARDS}` } }, { reply: '当前只有一个看板：导入验收。' },
      ]);
      assert.equal(result.operations.length, 1); assert.equal(result.operations[0].data.boards.length, 1);
      assert.equal(result.operations[0].data.boards[0].name, '导入验收');
    });

    await t.test('confirmed tenant creation and membership changes persist only to the intended tenant', async () => {
      const before = await (await fetch(service.origin + TENANTS, { headers })).json() as Json;
      const item = await proposal('创建流程验收租户', `POST ${TENANTS}`, { body: { tenantId, displayName: '流程验收团队' } });
      const unchanged = await (await fetch(service.origin + TENANTS, { headers })).json() as Json;
      assert.equal(unchanged.tenants.length, before.tenants.length);
      const created = await confirm(item); assert.equal(created.operations[0].ok, true);
      probeToken = created.operations[0].data.probeToken;
      assert.match(probeToken, /^[a-f0-9]{64}$/);
      const addOwner = await proposal('添加租户 owner', `POST ${TENANTS}/:tenantId/members`, {
        params: { tenantId }, body: { ssoUserId: tenantOwner, role: 'owner' },
      });
      assert.equal((await confirm(addOwner)).operations[0].ok, true);
      const addMember = await tenantProposal(`POST ${TENANTS}/:tenantId/members`, {
        params: { tenantId }, body: { ssoUserId: tenantMember, role: 'member' },
      });
      const added = await confirm(addMember, tenantOwner, tenantHeaders());
      assert.equal(added.operations[0].ok, true);
      const members = await (await fetch(service.origin + `${TENANTS}/${tenantId}/members`, { headers: tenantHeaders() })).json() as Json;
      assert.equal(members.members.length, 2);
      assert.equal(members.members.find((row: Json) => row.ssoUserId === tenantMember).role, 'member');
      const persisted = await control.query('select tenant_id,sso_user_id,role from public.studio_obs_tenant_members where tenant_id=$1', [tenantId]);
      assert.equal(persisted.rows.length, 2);
      assert.ok(persisted.rows.every((row: Json) => row.tenant_id === tenantId));
    });

    await t.test('tenant members cannot write; cross-tenant targets and last-owner deletion remain guarded', async () => {
      const denied = await tenantProposal(`POST ${TENANTS}/:tenantId/members`, {
        params: { tenantId }, body: { ssoUserId: 'unexpected-member', role: 'member' },
      }, tenantMember);
      const result = await confirm(denied, tenantMember, tenantHeaders(tenantMember));
      assert.equal(result.operations[0].status, 403); assert.equal(result.operations[0].ok, false);
      const cross = await tenantProposal(`POST ${TENANTS}/:tenantId/members`, {
        params: { tenantId: 'another-fixture-tenant' }, body: { ssoUserId: 'cross-tenant-member', role: 'member' },
      });
      assert.equal((await confirm(cross, tenantOwner, tenantHeaders())).operations[0].status, 403);
      const removeOwner = await tenantProposal(`DELETE ${TENANTS}/:tenantId/members/:ssoUserId`, {
        params: { tenantId, ssoUserId: tenantOwner },
      });
      const protectedOwner = await confirm(removeOwner, tenantOwner, tenantHeaders());
      assert.equal(protectedOwner.operations[0].ok, false);
      assert.match(protectedOwner.operations[0].data.error, /last_owner/);
      const rows = await control.query('select sso_user_id,role from public.studio_obs_tenant_members where tenant_id=$1', [tenantId]);
      assert.equal(rows.rows.length, 2);
      assert.equal(rows.rows.find((row: Json) => row.sso_user_id === tenantOwner)?.role, 'owner');
    });

    await t.test('confirmed strategy CRUD retains tenant scope and member read-only policy', async () => {
      const body = { name: '流程策略', description: '隔离数据库验证，不运行告警 worker', enabled: false, notificationChannel: 'none',
        rules: [{ query: 'fixture_errors > 0', durationSeconds: 120, comparator: 'gt', threshold: 5,
          severity: 'warning', sendIntervalMinutes: 30, noDataAlert: true }] };
      const item = await tenantProposal(`POST ${STRATEGIES}`, { query: { tenant: 'another-fixture-tenant' }, body });
      const created = await confirm(item, tenantOwner, tenantHeaders()); assert.equal(created.operations[0].ok, true);
      const strategy = created.operations[0].data.strategy; strategyId = strategy.id;
      assert.equal(strategy.tenantId, tenantId); assert.equal(strategy.enabled, false);
      assert.equal(strategy.notificationChannel, 'none'); assert.equal(strategy.rules[0].threshold, 5);
      const memberWrite = await tenantProposal(`PUT ${STRATEGIES}/:strategyId`, { params: { strategyId }, body }, tenantMember);
      assert.equal((await confirm(memberWrite, tenantMember, tenantHeaders(tenantMember))).operations[0].status, 403);
      const edit = await tenantProposal(`PUT ${STRATEGIES}/:strategyId`, {
        params: { strategyId }, body: { ...body, name: '更新策略', rules: [{ ...body.rules[0], threshold: 9 }] },
      });
      assert.equal((await confirm(edit, tenantOwner, tenantHeaders())).operations[0].ok, true);
      const response = await fetch(service.origin + STRATEGIES, { headers: tenantHeaders(tenantMember) });
      const listed = await response.json() as Json; assert.equal(response.status, 200); assert.equal(listed.canWrite, false);
      const stored = listed.strategies.find((row: Json) => row.id === strategyId);
      assert.equal(stored.name, '更新策略'); assert.equal(stored.rules[0].threshold, 9);
      const remove = await tenantProposal(`DELETE ${STRATEGIES}/:strategyId`, { params: { strategyId } });
      assert.equal((await confirm(remove, tenantOwner, tenantHeaders())).operations[0].ok, true);
      assert.equal((await control.query('select id from public.studio_alert_strategies where id=$1', [strategyId])).rows.length, 0);
    });

    await t.test('confirmed boolean flags preserve explicit true and false while invalid types cannot enable a strategy', async () => {
      const rule = { query: 'fixture_only_metric', durationSeconds: 120, comparator: 'gt', threshold: 5,
        severity: 'warning', noDataAlert: false };
      const body = { name: '布尔状态验收', enabled: false, notificationChannel: 'none', rules: [rule] };
      const countBefore = await control.query('select count(*)::int as count from public.studio_alert_strategies where tenant_id=$1', [tenantId]);
      const auditBefore = await control.query('select count(*)::int as count from public.studio_alert_configuration_audit where actor=$1', [tenantOwner]);
      for (const [field, value] of [['enabled', null], ['enabled', 'false'], ['enabled', 0],
        ['noDataAlert', null], ['noDataAlert', 'true'], ['noDataAlert', 1]] as Array<[string, unknown]>) {
        const input = field === 'enabled' ? { ...body, enabled: value } : { ...body, rules: [{ ...rule, noDataAlert: value }] };
        const item = await tenantProposal(`POST ${STRATEGIES}`, { body: input });
        const result = await confirm(item, tenantOwner, tenantHeaders());
        assert.equal(result.operations[0].status, 400); assert.equal(result.operations[0].ok, false);
        assert.equal(result.operations[0].data.error, field === 'enabled' ? 'strategy_enabled_invalid' : 'strategy_rule_no_data_alert_invalid');
      }
      const countAfter = await control.query('select count(*)::int as count from public.studio_alert_strategies where tenant_id=$1', [tenantId]);
      const auditAfter = await control.query('select count(*)::int as count from public.studio_alert_configuration_audit where actor=$1', [tenantOwner]);
      assert.equal(countAfter.rows[0].count, countBefore.rows[0].count);
      assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count);
      for (const flag of [true, false]) {
        const item = await tenantProposal(`POST ${STRATEGIES}`, { body: { ...body, enabled: flag, rules: [{ ...rule, noDataAlert: flag }] } });
        const result = await confirm(item, tenantOwner, tenantHeaders());
        assert.equal(result.operations[0].status, 201);
        const strategy = result.operations[0].data.strategy;
        assert.equal(strategy.enabled, flag); assert.equal(strategy.rules[0].noDataAlert, flag);
        const remove = await tenantProposal(`DELETE ${STRATEGIES}/:strategyId`, { params: { strategyId: strategy.id } });
        assert.equal((await confirm(remove, tenantOwner, tenantHeaders())).operations[0].ok, true);
      }
    });

    await t.test('probe tokens remain read-only, and confirmed rotation and disabling invalidate prior access', async () => {
      const probeHeaders = { ...headers, 'x-admin-token': '', 'fixture-actor': '', 'x-rdk-obs-tenant': '', 'x-tenant-token': probeToken };
      assert.equal((await fetch(service.origin + API + '/capabilities', { headers: probeHeaders })).status, 200);
      const result = await chat('为团队添加组员', [{ operation: { id: `POST ${TENANTS}/:tenantId/members`,
        params: { tenantId }, body: { ssoUserId: 'probe-cannot-write', role: 'member' } } }], probeHeaders);
      assert.equal(result.proposal.operationId, `POST ${TENANTS}/:tenantId/members`);
      assert.equal((await confirm(result.proposal, '', probeHeaders)).operations[0].status, 403);
      const rotate = await tenantProposal(`POST ${TENANTS}/:tenantId/token`, { params: { tenantId } });
      const rotated = await confirm(rotate, tenantOwner, tenantHeaders()); assert.equal(rotated.operations[0].ok, true);
      const nextToken = rotated.operations[0].data.probeToken;
      assert.notEqual(nextToken, probeToken);
      assert.equal((await fetch(service.origin + API + '/capabilities', { headers: probeHeaders })).status, 401);
      const nextHeaders = { ...probeHeaders, 'x-tenant-token': nextToken };
      assert.equal((await fetch(service.origin + API + '/capabilities', { headers: nextHeaders })).status, 200);
      const disable = await proposal('停用流程验收租户', `POST ${TENANTS}/:tenantId/status`, {
        params: { tenantId }, body: { status: 'disabled' },
      });
      assert.equal((await confirm(disable)).operations[0].ok, true);
      assert.equal((await fetch(service.origin + API + '/capabilities', { headers: nextHeaders })).status, 401);
    });

    await t.test('an actual executor timeout leaves the exact claim consumed and never replays uncertain side effects', async () => {
      const item = await proposal('执行隔离故障测试变更', `POST ${TIMEOUT}`);
      assert.equal(uncertainSideEffects, 0);
      const started = Date.now();
      const pending = post(API + '/confirm', { token: item.token });
      await timeoutStarted;
      assert.equal(uncertainSideEffects, 1);
      const replays = await Promise.all(Array.from({ length: 6 }, () => post(API + '/confirm', { token: item.token })));
      assert.ok(replays.every((response) => response.status === 409));
      const response = await pending; assert.equal(response.status, 200);
      const result = await response.json() as Json;
      assert.equal(result.operations[0].status, 504); assert.equal(result.operations[0].ok, false);
      assert.equal(result.operations[0].data.outcome, 'unknown');
      assert.equal(result.operations[0].data.error, 'platform_operation_timeout');
      assert.match(result.reply, /结果未确认|未完成/);
      assert.ok(Date.now() - started >= 44_000 && Date.now() - started < 60_000);
      assert.equal(uncertainClosed, true);
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 409);
      assert.equal(uncertainSideEffects, 1, 'timed-out mutations must never be submitted again');
    });
  } finally {
    await close(service.server); await close(model.server);
    await control.query('delete from public.studio_obs_dashboards where owner=any($1::text[])', [[`sso:${actorA}`, `sso:${actorB}`]]).catch(() => undefined);
    await control.query('delete from public.studio_alert_strategies where tenant_id=$1', [tenantId]).catch(() => undefined);
    await control.query('delete from public.studio_obs_tenant_members where tenant_id=$1', [tenantId]).catch(() => undefined);
    await control.query('delete from public.studio_obs_tenants where tenant_id=$1', [tenantId]).catch(() => undefined);
    await control.end();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetObservabilityAccessAdapter();
  }
});

test('required strategy numbers reject coercible nonnumeric values before PostgreSQL persistence', {
  skip: !databaseUrl, timeout: 10_000,
}, async () => {
  const selected = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname));
  assert.match(selected.pathname, /^\/dobs_[a-z0-9_]*test[a-z0-9_]*$/);
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_CREDITS_ADMIN_TOKEN'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CHAT_CREDITS_DB_URL = databaseUrl;
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'strategy-validation-fixture-admin';
  configureObservabilityAccess({ getSessionSsoUser: () => null, isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => ControlClient } }).default.Client;
  const control = new Client({ connectionString: databaseUrl }); await control.connect();
  configureStrategyPoolForTest(control);
  const router = express.Router(); registerStrategyRoutes(router);
  const app = express(); app.use(express.json()); app.use(router);
  const service = await listen(app);
  const fixtureName = `strategy-validation-${randomUUID()}`;
  const rule = { query: 'fixture_only_metric', durationSeconds: 120, comparator: 'gt', threshold: 5,
    severity: 'warning', sendIntervalMinutes: 30 };
  const request = async (input: Record<string, unknown>, options: { enabled?: unknown } = { enabled: false }): Promise<{ status: number; data: Json }> => {
    const response = await fetch(service.origin + STRATEGIES, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-admin-token': 'strategy-validation-fixture-admin', 'x-rdk-ops-action': 'observability',
    }, body: JSON.stringify({ name: fixtureName, enabled: options.enabled, notificationChannel: 'none', rules: [input] }) });
    return { status: response.status, data: await response.json() as Json };
  };
  try {
    const initialized = await fetch(service.origin + STRATEGIES, { headers: { 'x-admin-token': 'strategy-validation-fixture-admin' } });
    assert.equal(initialized.status, 200);
    for (const field of ['durationSeconds', 'threshold', 'sendIntervalMinutes']) {
      for (const value of [null, false, [], {}, '', '30']) {
        const result = await request({ ...rule, [field]: value });
        assert.equal(result.status, 400, `${field}=${JSON.stringify(value)} must be rejected instead of silently becoming a number`);
        assert.equal(result.data.ok, false);
      }
    }
    for (const value of [null, 0, [], {}, 'false']) {
      const enabled = await request(rule, { enabled: value });
      assert.equal(enabled.status, 400); assert.equal(enabled.data.error, 'strategy_enabled_invalid');
      const noData = await request({ ...rule, noDataAlert: value });
      assert.equal(noData.status, 400); assert.equal(noData.data.error, 'strategy_rule_no_data_alert_invalid');
    }
    assert.equal((await control.query('select id from public.studio_alert_strategies where name=$1', [fixtureName])).rows.length, 0);
    const zero = await request({ ...rule, durationSeconds: 0, threshold: 0, sendIntervalMinutes: 0 });
    assert.equal(zero.status, 201); assert.equal(zero.data.strategy.rules[0].durationSeconds, 0);
    assert.equal(zero.data.strategy.rules[0].threshold, 0); assert.equal(zero.data.strategy.rules[0].sendIntervalMinutes, 0);
    assert.equal(zero.data.strategy.enabled, false); assert.equal(zero.data.strategy.rules[0].noDataAlert, false);
    const negative = await request({ ...rule, threshold: -2 });
    assert.equal(negative.status, 201, 'negative finite thresholds are legitimate strategy values');
    assert.equal(negative.data.strategy.rules[0].threshold, -2);
    const omittedInterval = { ...rule } as Record<string, unknown>; delete omittedInterval.sendIntervalMinutes;
    const defaulted = await request(omittedInterval);
    assert.equal(defaulted.status, 201); assert.equal(defaulted.data.strategy.rules[0].sendIntervalMinutes, 0);
    const defaultEnabled = await request(rule, {});
    assert.equal(defaultEnabled.status, 201); assert.equal(defaultEnabled.data.strategy.enabled, true);
  } finally {
    await close(service.server);
    await control.query('delete from public.studio_alert_strategies where name=$1', [fixtureName]).catch(() => undefined);
    configureStrategyPoolForTest(null); await control.end(); resetObservabilityAccessAdapter();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
