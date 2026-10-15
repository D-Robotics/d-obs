import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { PLATFORM_OPERATION_METADATA, type PlatformOperationMetadata } from './platform-operation-metadata.js';

/** This partial router declares only its actually mounted, reviewed operations. */
function registerFixtureCatalog(router: ReturnType<typeof express.Router>) {
  type Layer = {
    route?: { path: string | string[]; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  };
  const known: Record<string, PlatformOperationMetadata> = {
    ...PLATFORM_OPERATION_METADATA,
    'GET /api/ops/observability/fixture': { tenantAccessible: false, group: 'Test fixture', description: 'Read fixture identity' },
    'POST /api/ops/observability/fixture': { tenantAccessible: false, group: 'Test fixture', description: 'Mutate fixture' },
  };
  const mounted: Record<string, PlatformOperationMetadata> = {};
  function walk(layers: Layer[]) {
    for (const layer of layers) {
      if (!layer.route) { if (layer.handle?.stack) walk(layer.handle.stack); continue; }
      for (const path of [layer.route.path].flat()) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          const id = `${method.toUpperCase()} ${path}`;
          if (enabled && known[id]) mounted[id] = known[id];
        }
      }
    }
  }
  walk((router as unknown as { stack: Layer[] }).stack);
  registerPlatformOperations(router, mounted);
}

let server: Server;
let origin: string;
let changes = 0;
let saved: Record<string, string | undefined>;
const API = '/api/ops/observability/assistant';
beforeEach(async () => {
  const keys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_COPILOT_MODEL_ENABLED', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_PLATFORM_ASSISTANT_BASE_URL', 'RDK_PLATFORM_ASSISTANT_MODEL', 'RDK_PLATFORM_ASSISTANT_API_KEY', 'GATEWAY_ADMIN_KEY'];
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'assistant-test-token';
  delete process.env.RDK_COPILOT_MODEL_ENABLED;
  delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;
  configureObservabilityAccess({ getSessionSsoUser: () => null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  changes = 0;
  const router = express.Router();
  registerSignalsRoutes(router);
  router.get('/api/ops/observability/fixture', (req, res) => res.json({ ok: true, actorTokenVerified: req.header('x-admin-token') === 'assistant-test-token' }));
  router.post('/api/ops/observability/fixture', requireOpsMutationGuard, (_req, res) => res.json({ ok: true, changes: ++changes }));
  registerFixtureCatalog(router);
  const app = express(); app.use(express.json()); app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetObservabilityAccessAdapter();
});
const headers = { 'content-type': 'application/json', 'x-admin-token': 'assistant-test-token' };
function rpc(name: string, args: Record<string, unknown> = {}) { return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }; }
async function post(body: unknown, extra: Record<string, string> = {}, path = '/api/ops/mcp') {
  return fetch(origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
}

test('assistant and unified MCP remain fail-closed, including invalid credentials', async () => {
  const invalidCredentials: Array<Record<string, string>> = [{}, { 'x-admin-token': 'wrong' }, { 'x-tenant-token': 'wrong' }];
  for (const badHeaders of invalidCredentials) {
    assert.ok((await fetch(origin + API + '/capabilities', { headers: badHeaders })).status >= 400);
    const response = await fetch(origin + '/api/ops/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...badHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.ok(response.status >= 400);
  }
  assert.equal(changes, 0);
});

test('capabilities expose explicitly registered mounted routes, and MCP keeps eight legacy tools', async () => {
  const response = await fetch(origin + API + '/capabilities', { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.equal(data.modelEnabled, false);
  assert.equal(data.readOnlyExecutionSupported, true);
  assert.ok(data.operations.find((operation: any) => operation.id === 'POST /api/ops/observability/fixture'));
  assert.ok(data.operations.find((operation: any) => operation.id === 'POST /api/ops/observability/boards/from-nl'));
  assert.ok(!data.operations.some((operation: any) => operation.path.includes('/assistant/')));
  assert.ok(!data.operations.some((operation: any) => operation.path.startsWith('/api/ops/observability/actions')));
  assert.ok(!data.operations.some((operation: any) => operation.path === '/api/ops/observability/overview'));
  const list = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as any;
  assert.equal(list.result.tools.length, 10);
  assert.ok(list.result.tools.some((tool: any) => tool.name === 'query_metric'));
  assert.ok(list.result.tools.some((tool: any) => tool.name === 'list_platform_capabilities'));
  assert.ok(list.result.tools.some((tool: any) => tool.name === 'execute_platform_operation'));
});

test('read-only capability catalog excludes mutations and executor rejects a write before dispatch', async () => {
  const restricted = { 'x-rdk-ops-read-only': '1' };
  const response = await fetch(origin + API + '/capabilities', { headers: { ...headers, ...restricted } });
  const data = await response.json() as any;
  assert.equal(data.readOnlyExecutionSupported, true);
  assert.ok(data.operations.length > 0);
  assert.ok(data.operations.every((operation: any) => !operation.mutating &&
    (operation.method === 'GET' || operation.id === 'POST /api/ops/observability/boards/query')));
  assert.ok(data.operations.some((operation: any) => operation.id === 'POST /api/ops/observability/boards/query'));
  const denied = await (await post(rpc('execute_platform_operation', { operationId: 'POST /api/ops/observability/fixture' }),
    { ...restricted, 'x-rdk-ops-action': 'observability' })).json() as any;
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /platform_read_only_operation_denied/);
  assert.equal(changes, 0);
});

test('read-only chat cannot dispatch a mutation even if the model requests one', async () => {
  const gateway = express(); gateway.use(express.json());
  gateway.post('/v1/chat/completions', (req, res) => {
    assert.doesNotMatch(req.body.messages[0].content, /POST \/api\/ops\/observability\/fixture/);
    res.json({ choices: [{ message: { content: JSON.stringify({ operation: { id: 'POST /api/ops/observability/fixture' } }) } }] });
  });
  const gatewayServer = gateway.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => gatewayServer.once('listening', resolve));
  const address = gatewayServer.address(); assert.ok(address && typeof address !== 'string');
  process.env.RDK_COPILOT_MODEL_ENABLED = '1';
  process.env.GATEWAY_ADMIN_KEY = 'non-secret-admin-test-key';
  process.env.RDK_PLATFORM_ASSISTANT_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.RDK_PLATFORM_ASSISTANT_MODEL = 'read-only-test';
  process.env.RDK_PLATFORM_ASSISTANT_API_KEY = 'non-secret-test-key';
  try {
    const response = await post({ message: '看看平台' }, { 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1' }, API + '/chat');
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.match(data.reply, /platform_assistant_unknown_operation/);
    assert.deepEqual(data.operations, []);
    assert.equal(changes, 0);
  } finally {
    gatewayServer.closeAllConnections();
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
  }
});

test('MCP operation calls preserve authority and turn HTTP failures into isError', async () => {
  const read = await (await post(rpc('execute_platform_operation', { operationId: 'GET /api/ops/observability/fixture' }))).json() as any;
  assert.equal(read.result.isError, false);
  assert.equal(JSON.parse(read.result.content[0].text).data.actorTokenVerified, true);
  const mutation = rpc('execute_platform_operation', { operationId: 'POST /api/ops/observability/fixture' });
  const denied = await (await post(mutation)).json() as any;
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /missing_ops_action_guard/);
  const foreign = await (await post(mutation, { 'x-rdk-ops-action': 'observability', origin: 'https://evil.invalid' })).json() as any;
  assert.equal(foreign.result.isError, true);
  assert.match(foreign.result.content[0].text, /cross_origin_ops_action_denied/);
  assert.equal(changes, 0);
  const accepted = await (await post(mutation, { 'x-rdk-ops-action': 'observability' })).json() as any;
  assert.equal(accepted.result.isError, false);
  assert.equal(changes, 1);
});

test('chat without a configured model returns an honest unavailable reply and no side effects', async () => {
  const denied = await post({ message: '创建一个看板' }, {}, API + '/chat');
  assert.equal(denied.status, 400);
  const response = await post({ message: '创建一个看板', history: [], context: { view: 'overview' } }, { 'x-rdk-ops-action': 'observability' }, API + '/chat');
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.equal(data.ok, true);
  assert.match(data.reply, /platform_assistant_model_disabled/);
  assert.deepEqual(data.operations, []);
  assert.equal(changes, 0);
});
