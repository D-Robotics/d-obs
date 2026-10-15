import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { requirePlatformAssistantAccess } from './platform-assistant-routes.js';
import { registerPlatformAssistantTaskRoutes } from './platform-assistant-task-routes.js';
import { PlatformAssistantTaskService } from './platform-assistant-tasks.js';
import { registerPlatformOperations } from './platform-operations.js';
import { PLATFORM_OPERATION_METADATA } from './platform-operation-metadata.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';

const database = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();
test('persistent tasks create and update a real PostgreSQL board, read it back, and resume the latest user request', { skip: !database, timeout: 25_000 }, async () => {
  assert.match(new URL(database).pathname, /^\/dobs_[a-z0-9_]*test[a-z0-9_]*$/);
  const root = await mkdtemp(join(tmpdir(), 'd-obs-native-workflow-test-'));
  const actor = 'native-test-' + randomUUID(); const other = 'native-other-' + randomUUID();
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_CREDITS_ADMIN_TOKEN', 'RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET', 'RDK_FLYWHEEL_ADMIN_USER_IDS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CHAT_CREDITS_DB_URL = database; process.env.RDK_CREDITS_ADMIN_TOKEN = 'native-workflow-test-admin';
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = 'native-workflow-test-authorization'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = `${actor},${other}`;
  configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const api = '/api/ops/observability/assistant'; const boards = '/api/ops/observability/boards';
  let outputs: unknown[] = []; const router = express.Router(); const tasks = new PlatformAssistantTaskService({ stateDir: join(root, 'tasks') });
  registerPlatformAssistantTaskRoutes(router, requirePlatformAssistantAccess, { getTasks: () => tasks, enabled: () => true,
    complete: async () => { assert.ok(outputs.length, 'unexpected planning'); return JSON.stringify(outputs.shift()); } });
  registerSignalsRoutes(router);
  const ids = [`GET ${boards}`, `POST ${boards}`, `PUT ${boards}/:boardId`];
  registerPlatformOperations(router, Object.fromEntries(ids.map((id) => [id, PLATFORM_OPERATION_METADATA[id]])));
  const app = express(); app.use(express.json()); app.use(router); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { 'content-type': 'application/json', 'x-admin-token': 'native-workflow-test-admin', 'x-rdk-ops-action': 'observability', 'fixture-actor': actor };
  const post = (path: string, body: unknown) => fetch(origin + api + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> } } }).default.Client;
  const control = new Client({ connectionString: database }); await control.connect();
  try {
    const spec = { windowMinutes: 60, panels: [{ title: '错误数', metric: 'native.errors', chart: 'line' }] };
    outputs = [{ operation: { id: `POST ${boards}`, body: { name: '错误率', spec } } }];
    const proposed = await (await post('/chat', { taskId: null, message: '创建错误率看板并检查保存配置', context: { view: 'signals/panels' } })).json() as any;
    assert.equal(proposed.task.status, 'awaiting_confirmation');
    outputs = [{ reply: '看板已创建，已读回保存的配置。' }];
    const confirmedResponse = await post('/confirm', { taskId: proposed.task.id, token: proposed.proposal.token }); assert.equal(confirmedResponse.status, 200);
    const created = await confirmedResponse.json() as any; const board = created.operations[0].data.board;
    assert.deepEqual(created.operations.map((item: any) => item.id), [`POST ${boards}`, `GET ${boards}`]);
    assert.equal(created.operations[1].data.boards.find((item: any) => item.id === board.id).name, '错误率');
    let persisted = await control.query('select owner,name,spec from public.studio_obs_dashboards where id=$1', [board.id]);
    assert.equal(persisted.rows[0].owner, `sso:${actor}`); assert.equal(persisted.rows[0].name, '错误率');
    outputs = [{ operation: { id: `PUT ${boards}/:boardId`, body: { name: '排障看板' } } }];
    const update = await (await post('/chat', { taskId: created.task.id, message: '把这个看板改名为排障看板并检查保存结果', context: { view: 'signals/panels', selection: { boardId: board.id } } })).json() as any;
    outputs = [{ reply: '看板名称已更新，已读回保存配置。' }];
    const updated = await (await post('/confirm', { taskId: update.task.id, token: update.proposal.token })).json() as any;
    assert.equal(updated.task.status, 'completed'); assert.equal(updated.operations[0].id, `PUT ${boards}/:boardId`);
    assert.equal(updated.operations[1].data.boards.find((item: any) => item.id === board.id).name, '排障看板');
    persisted = await control.query('select name from public.studio_obs_dashboards where owner=$1', [`sso:${actor}`]); assert.deepEqual(persisted.rows, [{ name: '排障看板' }]);
    const foreign = await fetch(origin + api + '/tasks/' + updated.task.id, { headers: { ...headers, 'fixture-actor': other } }); assert.equal(foreign.status, 404);
  } finally {
    await control.query('delete from public.studio_obs_dashboards where owner=$1', [`sso:${actor}`]).catch(() => undefined); await control.end();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    resetObservabilityAccessAdapter(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
