import assert from 'node:assert/strict';
import { test } from 'node:test';
import express, { Router, type Request } from 'express';
import type { AddressInfo } from 'node:net';
import { buildPlatformMcpTools, executePlatformOperation, isPlatformOperationPath, listPlatformOperations, registerPlatformOperations, visiblePlatformOperations } from './platform-operations.js';
import { PLATFORM_OPERATION_METADATA, PLATFORM_OPERATION_EXCLUSIONS } from './platform-operation-metadata.js';
import { createOpsObservabilityRouter } from './observability-routes.js';
import { handleMcpJsonRpc } from '../observability/agent-mcp.js';
import { tenantScopeGate } from './observability-route-kit.js';

function registerFixtureOperations(router: ReturnType<typeof Router>, ...ids: string[]) {
  registerPlatformOperations(router, Object.fromEntries(ids.map((id) => [id, {
    tenantAccessible: false, group: 'Test operations', description: id,
    ...(id === 'GET /api/ops/observability/test/:id' ? { query: { tenant: '可选管理员租户视角。' } } : {}),
  }])));
}

/** Inspect Express internals only in verification; production uses declarations. */
function mountedBusinessOperations(router: ReturnType<typeof Router>) {
  type Layer = {
    route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: Function }> };
    handle?: { stack?: Layer[] };
  };
  const operations: Array<{ id: string; tenantAccessible: boolean }> = [];
  function walk(layers: Layer[]) {
    for (const layer of layers) {
      if (!layer.route) { if (layer.handle?.stack) walk(layer.handle.stack); continue; }
      for (const path of [layer.route.path].flat()) {
        if (typeof path !== 'string' || !isPlatformOperationPath(path)) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          const id = `${method.toUpperCase()} ${path}`;
          if (enabled && !PLATFORM_OPERATION_EXCLUSIONS[id]) operations.push({
            id, tenantAccessible: layer.route.stack.some(({ handle }) => handle === tenantScopeGate) ||
              /^\/api\/ops\/observability\/tenants\/:tenantId\/(?:members(?:\/|$)|token$)/.test(path),
          });
        }
      }
    }
  }
  walk((router as unknown as { stack: Layer[] }).stack);
  return operations;
}

async function fixture(run: (request: (body: unknown, headers?: Record<string, string>) => Promise<any>, router: ReturnType<typeof Router>) => Promise<void>, executionOptions: { timeoutMs?: number; maxResultBytes?: number } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-tenant-token') === 'fixture-tenant-identity') req.opsTenantAccess = { tenantId: 'credential-tenant', displayName: 'Fixture tenant', source: 'token' };
    next();
  });
  const router = Router();
  let changes = 0;
  router.get('/api/ops/observability/test/:id', (req, res) => {
    if (req.header('x-admin-token') !== 'real-identity') { res.status(403).json({ ok: false, error: 'not_authorized' }); return; }
    res.json({ ok: true, id: req.params.id, tenant: req.query.tenant, filter: req.query.filter, guard: req.header('x-rdk-ops-action') });
  });
  router.post('/api/ops/observability/test/:id', (req, res) => {
    if (req.header('x-admin-token') !== 'real-identity') { res.status(403).json({ ok: false, error: 'not_authorized' }); return; }
    if (req.header('origin') && req.header('origin') !== `http://${req.header('host')}`) { res.status(403).json({ ok: false, error: 'cross_origin_ops_action_denied' }); return; }
    res.status(201).json({ ok: true, changes: ++changes, id: req.params.id, body: req.body });
  });
  const child = Router();
  child.get('/api/ops/observability/test-export', (_req, res) => res.attachment('test.csv').type('text/csv').send('a,b\n1,2'));
  router.use(child);
  registerFixtureOperations(router, 'GET /api/ops/observability/test/:id', 'POST /api/ops/observability/test/:id', 'GET /api/ops/observability/test-export');
  router.post('/invoke', async (req, res) => {
    const before = { method: req.method, url: req.url, body: req.body, query: { ...req.query }, headers: { ...req.headers }, tenantAccess: req.opsTenantAccess };
    const result = await executePlatformOperation(router, req, res, req.body.id, req.body.args, executionOptions);
    assert.deepEqual({ method: req.method, url: req.url, body: req.body, query: { ...req.query }, headers: { ...req.headers }, tenantAccess: req.opsTenantAccess }, before);
    res.json(result);
  });
  router.post('/mcp-test', async (req, res) => res.json(await handleMcpJsonRpc(req.body, buildPlatformMcpTools(router, req, res), { name: 'test', version: '1' })));
  app.use('/dobs', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = async (body: unknown, headers: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${port}/dobs/invoke?tenant=current`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
  try { await run(request, router); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('declared capabilities match all mounted business routes and their existing tenant policy', () => {
  const router = createOpsObservabilityRouter();
  const operations = listPlatformOperations(router);
  assert.ok(operations.length >= 116);
  assert.equal(new Set(operations.map((operation) => operation.id)).size, operations.length);
  for (const operation of operations) {
    assert.ok(PLATFORM_OPERATION_METADATA[operation.id], `missing assistant guidance: ${operation.id}`);
    assert.ok(!PLATFORM_OPERATION_EXCLUSIONS[operation.id]);
    assert.ok(!operation.path.includes('/assistant/'));
    assert.ok(!operation.path.endsWith('/mcp'));
  }
  for (const id of Object.keys(PLATFORM_OPERATION_METADATA)) assert.ok(operations.some((operation) => operation.id === id), `stale assistant guidance: ${id}`);
  const mounted = mountedBusinessOperations(router);
  assert.deepEqual(operations.map(({ id }) => id).sort(), mounted.map(({ id }) => id).sort());
  for (const operation of operations) {
    assert.equal(operation.tenantAccessible, mounted.find(({ id }) => id === operation.id)?.tenantAccessible, `tenant policy changed: ${operation.id}`);
  }
  assert.ok(operations.find((operation) => operation.path === '/api/ops/observability/actions/:id'));
  assert.ok(operations.find((operation) => operation.path === '/api/ops/observability/rdk-logs/captures/:id/analysis'));
});

test('in-process dispatch preserves original request, identity, context guard, and selected tenant', async () => {
  await fixture(async (request) => {
    const result = await request({ id: 'GET /api/ops/observability/test/:id', args: { params: { id: 'run:abc' }, query: { filter: 'errors' } } }, { 'x-admin-token': 'real-identity' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { ok: true, id: 'run:abc', tenant: 'current', filter: 'errors', guard: 'observability-context' });
  });
});

test('panel query remains a read-only assistant operation and retains its HTTP request guard', async () => {
  await fixture(async (request, router) => {
    const id = 'POST /api/ops/observability/boards/query';
    let queries = 0;
    router.post('/api/ops/observability/boards/query', (req, res) => {
      assert.equal(req.header('x-rdk-ops-action'), 'observability');
      queries += 1;
      res.json({ ok: true, series: [{ name: 'A', points: [{ ts: 1700000000000, value: 23 }] }] });
    });
    registerPlatformOperations(router, { [id]: PLATFORM_OPERATION_METADATA[id] });
    assert.equal(listPlatformOperations(router).find((operation) => operation.id === id)?.mutating, false);
    const result = await request({ id, args: { body: { panel: { title: 'CPU', metric: 'cpu' }, windowMinutes: 60 } } },
      { 'x-admin-token': 'real-identity', 'x-rdk-ops-read-only': '1' });
    assert.equal(result.ok, true); assert.equal(queries, 1);
    assert.equal(result.data.series[0].points[0].value, 23);
  });
});

test('an operation explicitly declaring tenant inherits the outer administrator view', async () => {
  await fixture(async (request, router) => {
    const id = 'GET /api/ops/observability/fixture-tenant-view';
    router.get('/api/ops/observability/fixture-tenant-view', (req, res) => res.json({ ok: true, query: req.query }));
    registerPlatformOperations(router, { [id]: { tenantAccessible: false, group: 'Test', description: 'Declared tenant filter', query: { tenant: 'Optional tenant filter' } } });
    const result = await request({ id, args: {} }, { 'x-admin-token': 'real-identity' });
    assert.equal(result.ok, true); assert.deepEqual(result.data.query, { tenant: 'current' });
  });
});

test('an operation without a tenant declaration receives no implicit filter and keeps strict handler validation', async () => {
  await fixture(async (request, router) => {
    const id = 'GET /api/ops/observability/fixture-global-assets';
    router.get('/api/ops/observability/fixture-global-assets', (req, res) => {
      if (Object.keys(req.query).some((key) => key !== 'search')) { res.status(400).json({ ok: false, error: 'fixture_invalid_query' }); return; }
      res.json({ ok: true, query: req.query });
    });
    registerPlatformOperations(router, { [id]: { tenantAccessible: false, group: 'Test', description: 'Global assets', query: { search: 'Optional search' } } });
    const result = await request({ id, args: { query: { search: 'native' } } }, { 'x-admin-token': 'real-identity' });
    assert.equal(result.ok, true); assert.deepEqual(result.data.query, { search: 'native' });
    const explicit = await request({ id, args: { query: { tenant: 'explicit' } } }, { 'x-admin-token': 'real-identity' });
    assert.equal(explicit.status, 400); assert.equal(explicit.data.error, 'fixture_invalid_query');
  });
});

test('explicit tenant arguments retain priority including clearing an inherited administrator filter', async () => {
  await fixture(async (request) => {
    const id = 'GET /api/ops/observability/test/:id';
    const overridden = await request({ id, args: { params: { id: 'fixture' }, query: { tenant: 'explicit-view' } } }, { 'x-admin-token': 'real-identity' });
    assert.equal(overridden.ok, true); assert.equal(overridden.data.tenant, 'explicit-view');
    const cleared = await request({ id, args: { params: { id: 'fixture' }, query: { tenant: null } } }, { 'x-admin-token': 'real-identity' });
    assert.equal(cleared.ok, true); assert.equal(cleared.data.tenant, undefined);
  });
});

test('omitting a global tenant query preserves tenant visibility, credential headers and authenticated scope', async () => {
  await fixture(async (request, router) => {
    const id = 'GET /api/ops/observability/fixture-tenant-resource'; let calls = 0;
    router.get('/api/ops/observability/fixture-tenant-resource', (req, res) => {
      if (req.header('x-tenant-token') !== 'fixture-tenant-identity' || req.header('x-rdk-obs-tenant') !== 'credential-tenant') { res.status(403).json({ ok: false, error: 'fixture_not_authorized' }); return; }
      // Like the actual tenant gate, scope is resolved again from credentials.
      req.opsTenantAccess = { tenantId: 'credential-tenant', displayName: 'Fixture tenant', source: 'token' };
      calls++; res.json({ ok: true, tenantId: req.opsTenantAccess.tenantId, query: req.query, tenantHeader: req.header('x-rdk-obs-tenant'), session: req.header('x-rdk-sso-session'), cookie: req.header('cookie'), readOnly: req.header('x-rdk-ops-read-only') });
    });
    registerPlatformOperations(router, {
      [id]: { tenantAccessible: true, group: 'Test', description: 'Credential scoped resource' },
      'GET /api/ops/observability/fixture-admin-only': { tenantAccessible: false, group: 'Test', description: 'Administrator only' },
    });
    const headers = { 'x-tenant-token': 'fixture-tenant-identity', 'x-rdk-obs-tenant': 'credential-tenant', 'x-rdk-sso-session': 'fixture-sso-session', cookie: 'fixture-cookie', 'x-rdk-ops-read-only': '1' };
    const result = await request({ id, args: {} }, headers);
    assert.equal(result.ok, true); assert.deepEqual(result.data, { ok: true, tenantId: 'credential-tenant', query: {}, tenantHeader: 'credential-tenant', session: 'fixture-sso-session', cookie: 'fixture-cookie', readOnly: '1' });
    const denied = await request({ id: 'GET /api/ops/observability/fixture-admin-only', args: {} }, headers);
    assert.equal(denied.status, 404); assert.equal(denied.data.error, 'unknown_platform_operation'); assert.equal(calls, 1);
  });
});

test('mutations need caller guard and retain existing origin and identity checks', async () => {
  await fixture(async (request) => {
    const body = { id: 'POST /api/ops/observability/test/:id', args: { params: { id: 'device' }, body: { displayName: 'RDK' } } };
    assert.equal((await request(body, { 'x-admin-token': 'real-identity' })).data.error, 'missing_ops_action_guard');
    assert.equal((await request(body, { 'x-admin-token': 'forged', 'x-rdk-ops-action': 'observability' })).status, 403);
    assert.equal((await request(body, { 'x-admin-token': 'real-identity', 'x-rdk-ops-action': 'observability', origin: 'https://evil.invalid' })).status, 403);
    const result = await request(body, { 'x-admin-token': 'real-identity', 'x-rdk-ops-action': 'observability' });
    assert.equal(result.status, 201);
    assert.equal(result.data.changes, 1);
    assert.deepEqual(result.data.body, { displayName: 'RDK' });
  });
});

test('unknown/auth/retired routes, path injection, and header impersonation cannot be executed', async () => {
  await fixture(async (request) => {
    for (const id of ['POST /api/ops/auth/login', 'POST /api/ops/mcp', 'POST /api/ops/observability/remediate', 'GET https://evil.invalid/']) {
      assert.equal((await request({ id, args: {} })).data.error, 'unknown_platform_operation');
    }
    for (const id of ['../config', '..', 'a/b', '\\config']) {
      assert.equal((await request({ id: 'GET /api/ops/observability/test/:id', args: { params: { id } } })).data.error, 'invalid_operation_params');
    }
    assert.equal((await request({ id: 'GET /api/ops/observability/test/:id', args: { params: { id: 'abc' }, headers: { 'x-admin-token': 'real-identity' } } })).data.error, 'invalid_operation_arguments');
    const fail = await request({ id: 'GET /api/ops/observability/test/:id', args: { params: { id: 'abc' }, body: { token: 'real-identity' } } });
    assert.equal(fail.status, 403);
  });
});

test('nested exports retain API authorization and return an authenticated download address', async () => {
  await fixture(async (request, router) => {
    assert.ok(listPlatformOperations(router).some((operation) => operation.path.endsWith('test-export')));
    const result = await request({ id: 'GET /api/ops/observability/test-export', args: {} });
    assert.equal(result.ok, true);
    assert.equal(result.data.downloadUrl, '/api/ops/observability/test-export');
    assert.equal(result.data.preview, undefined);
    assert.match(result.data.contentType, /text\/csv/);
  });
});

test('opaque object and model IDs keep their slash inside one encoded route segment without enabling traversal', async () => {
  await fixture(async (request, router) => {
    let calls = 0;
    router.get('/api/ops/observability/objects/:objectId', (req, res) => { calls++; res.json({ ok: true, objectId: req.params.objectId, query: req.query }); });
    router.put('/api/ops/observability/model-prices/:model', (req, res) => { calls++; res.json({ ok: true, model: req.params.model }); });
    registerFixtureOperations(router, 'GET /api/ops/observability/objects/:objectId', 'PUT /api/ops/observability/model-prices/:model');
    const object = await request({ id: 'GET /api/ops/observability/objects/:objectId', args: { params: { objectId: 'device/rdk-s100-0003' } } });
    assert.equal(object.ok, true); assert.equal(object.data.objectId, 'device/rdk-s100-0003');
    const model = await request({ id: 'PUT /api/ops/observability/model-prices/:model', args: { params: { model: 'provider/model' }, body: {} } }, { 'x-rdk-ops-action': 'observability' });
    assert.equal(model.ok, true); assert.equal(model.data.model, 'provider/model');
    assert.equal(calls, 2);
    for (const objectId of ['../config', 'device/../config', 'device/./name', 'device//name', '/device', 'device/', 'device\\name', 'device/%2fconfig', 'device/%2e%2e/config', 'device/%5cconfig', 'device/\u0000name']) {
      const result = await request({ id: 'GET /api/ops/observability/objects/:objectId', args: { params: { objectId } } });
      assert.equal(result.data.error, 'invalid_operation_params');
    }
    assert.equal(calls, 2, 'rejected IDs never dispatch a handler');
  });
});

test('bounded export response closes the iterator without waiting forever for drain', async () => {
  let released = false;
  await fixture(async (request, router) => {
    async function* rows() {
      try { for (let index = 0; index < 100; index++) yield 'private_token=do-not-send-to-model\n'; }
      finally { released = true; }
    }
    router.get('/api/ops/observability/streamed-export', async (_req, res) => {
      res.attachment('test.txt').flushHeaders();
      for await (const row of rows()) {
        if (res.destroyed) break;
        if (!res.write(row)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      if (!res.destroyed) res.end();
    });
    registerFixtureOperations(router, 'GET /api/ops/observability/streamed-export');
    const result = await request({ id: 'GET /api/ops/observability/streamed-export', args: {} });
    assert.equal(result.ok, true);
    assert.ok(result.data.downloadUrl);
    assert.doesNotMatch(JSON.stringify(result), /do-not-send-to-model/);
    assert.equal(released, true);
  }, { maxResultBytes: 60 });
});

test('timeout emits close to release pending writers and reports uncertain mutation outcome', async () => {
  let closed = false;
  await fixture(async (request, router) => {
    router.post('/api/ops/observability/stalled-change', (_req, res) => {
      res.once('close', () => { closed = true; });
      res.flushHeaders();
    });
    registerFixtureOperations(router, 'POST /api/ops/observability/stalled-change');
    const result = await request({ id: 'POST /api/ops/observability/stalled-change', args: {} }, { 'x-rdk-ops-action': 'observability' });
    assert.equal(result.status, 504);
    assert.equal(result.data.outcome, 'unknown');
    assert.equal(closed, true);
  }, { timeoutMs: 20 });
});

test('unexpected middleware error after a mutation is never a confirmed failure', async () => {
  await fixture(async (request, router) => {
    router.post('/api/ops/observability/failed-change', (_req, _res, next) => next(new Error('internal secret details')));
    registerFixtureOperations(router, 'POST /api/ops/observability/failed-change');
    const result = await request({ id: 'POST /api/ops/observability/failed-change', args: {} }, { 'x-rdk-ops-action': 'observability' });
    assert.equal(result.status, 500);
    assert.equal(result.data.outcome, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /internal secret details/);
  });
});

test('new HTTP routes remain hidden and unexecutable until explicitly declared', async () => {
  await fixture(async (request, router) => {
    let called = false;
    router.get('/api/ops/observability/unannounced', (_req, res) => { called = true; res.json({ ok: true }); });
    assert.ok(!listPlatformOperations(router).some(({ path }) => path.endsWith('/unannounced')));
    const result = await request({ id: 'GET /api/ops/observability/unannounced', args: {} });
    assert.equal(result.status, 404);
    assert.equal(result.data.error, 'unknown_platform_operation');
    assert.equal(called, false);
    registerFixtureOperations(router, 'GET /api/ops/observability/unannounced');
    assert.equal((await request({ id: 'GET /api/ops/observability/unannounced', args: {} })).ok, true);
    assert.equal(called, true);
  });
});

test('tenant capability visibility follows explicit policy and never middleware names', () => {
  const router = Router();
  router.get('/api/ops/observability/admin-only', function tenantScopeGate(_req, _res, next) { next(); });
  router.get('/api/ops/observability/tenant-view', (_req, res) => res.json({ ok: true }));
  registerPlatformOperations(router, {
    'GET /api/ops/observability/admin-only': { tenantAccessible: false, group: 'Test', description: 'Admin' },
    'GET /api/ops/observability/tenant-view': { tenantAccessible: true, group: 'Test', description: 'Tenant' },
  });
  const tenantRequest = { opsTenantAccess: { tenantId: 'team' } } as Request;
  assert.deepEqual(visiblePlatformOperations(router, tenantRequest).map(({ path }) => path), ['/api/ops/observability/tenant-view']);
  assert.equal(visiblePlatformOperations(router, {} as Request).length, 2);
});

test('capability registration and listing never read the private Express route stack', () => {
  const router = Router();
  Object.defineProperty(router, 'stack', { get() { throw new Error('private stack must not be read'); } });
  assert.deepEqual(listPlatformOperations(router), []);
  registerFixtureOperations(router, 'GET /api/ops/observability/declared');
  assert.equal(listPlatformOperations(router)[0].id, 'GET /api/ops/observability/declared');
});

test('changing listed descriptors cannot override registry policy or bypass the read-only guard', async () => {
  await fixture(async (request, router) => {
    const listed = listPlatformOperations(router).find(({ method }) => method === 'POST')!;
    listed.mutating = false;
    listed.tenantAccessible = true;
    listed.parameters.params.id = 'changed';
    const stored = listPlatformOperations(router).find(({ id }) => id === listed.id)!;
    assert.equal(stored.mutating, true);
    assert.equal(stored.tenantAccessible, false);
    assert.notEqual(stored.parameters.params.id, 'changed');
    const result = await request({ id: listed.id, args: { params: { id: 'device' } } }, {
      'x-admin-token': 'real-identity', 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1',
    });
    assert.equal(result.status, 403);
    assert.equal(result.data.error, 'platform_read_only_operation_denied');
  });
});

test('invalid transport/retired declarations fail closed without publishing a partial batch', () => {
  const router = Router();
  for (const id of ['POST /api/ops/mcp', 'POST /api/ops/observability/remediate', 'POST /api/ops/observability/assistant/chat', 'GET /api/ops/observability/live/stream']) {
    assert.throws(() => registerPlatformOperations(router, {
      'GET /api/ops/observability/valid': { tenantAccessible: false, group: 'Test', description: 'Valid' },
      [id]: { tenantAccessible: false, group: 'Test', description: 'Invalid' },
    }), /invalid_platform_operation_declaration/);
    assert.deepEqual(listPlatformOperations(router), []);
  }
});
