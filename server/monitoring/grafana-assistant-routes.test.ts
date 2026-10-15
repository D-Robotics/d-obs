import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router, type Request } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { registerGrafanaAssistantRoutes, type GrafanaAssistantOptions } from './grafana-assistant-routes.js';
import { GRAFANA_ASSISTANT_API as API, GRAFANA_ASSISTANT_OPERATIONS } from './grafana-assistant-operations.js';
import { buildPlatformMcpTools, executePlatformOperation, listPlatformOperations, registerPlatformOperations, visiblePlatformOperations } from './platform-operations.js';
import { handleMcpJsonRpc } from '../observability/agent-mcp.js';

const ADMIN = 'grafana-fixture-admin-only';
const adminHeaders = { 'x-admin-token': ADMIN };
type UpstreamHandler = (request: IncomingMessage, response: ServerResponse) => void;
type Fixture = {
  request: (path: string, headers?: Record<string, string>, body?: unknown) => Promise<{ status: number; cache: string | null; data: any }>;
  router: ReturnType<typeof Router>; calls: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }>;
  setUpstream: (handler: UpstreamHandler) => void;
};
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
const panelExpression = 'sum by(instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m]))';
function nativeResponse(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (path.endsWith('/api/search')) return json(res, [{ uid: 'native-a', title: 'Native 主机', type: 'dash-db', folderUid: 'dobs-folder', folderTitle: 'd-obs', tags: ['host'], url: 'http://private.invalid/', privateConfig: 'hidden' }]);
  if (path.endsWith('/api/datasources')) return json(res, [{ uid: 'prometheus', name: 'Prometheus', type: 'prometheus', isDefault: true, readOnly: true, url: 'http://private.invalid/', user: 'private-user', password: 'private-password', basicAuthPassword: 'private-basic', jsonData: { httpHeaderName1: 'Authorization' }, secureJsonData: { httpHeaderValue1: 'private-header' } }]);
  return json(res, { dashboard: { uid: 'native-a', title: 'Native 主机', version: 3, panels: [{ id: 1, title: 'CPU', type: 'timeseries', datasource: { uid: 'prometheus', type: 'prometheus', url: 'http://private.invalid/' }, targets: [{ refId: 'A', expr: panelExpression, datasource: { uid: 'prometheus', type: 'prometheus' }, rawSql: 'private-sql', query: 'private-plugin', headers: { Authorization: 'private-header' } }] }], templating: { list: [] } }, meta: { provisioned: true, folderUid: 'dobs-folder', folderTitle: 'd-obs', canSave: true, createdBy: 'private-creator' } });
}
async function fixture(run: (value: Fixture) => Promise<void>, options: GrafanaAssistantOptions = {}, basePath = '') {
  const envKeys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_CHAT_CREDITS_DB_URL', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_GRAFANA_API_URL'] as const;
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = ADMIN;
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused-grafana-fixture.invalid/db';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'fixture-admin-sso';
  delete process.env.RDK_GRAFANA_API_URL;
  configureObservabilityAccess({
    getSessionSsoUser: (req) => req.header('x-fixture-sso') ? { id: req.header('x-fixture-sso')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });
  const calls: Fixture['calls'] = []; let upstreamHandler: UpstreamHandler = nativeResponse;
  const upstream = createServer((req, res) => { calls.push({ method: req.method!, path: req.url!, headers: req.headers }); upstreamHandler(req, res); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const app = express(); app.use(express.json()); const router = Router();
  registerGrafanaAssistantRoutes(router, { baseUrl: upstreamBase + basePath, ...options });
  registerPlatformOperations(router, GRAFANA_ASSISTANT_OPERATIONS);
  router.post('/fixture-invoke', async (req, res) => res.json(await executePlatformOperation(router, req, res, req.body.id, req.body.args)));
  router.post('/fixture-mcp', async (req, res) => res.json(await handleMcpJsonRpc(req.body, buildPlatformMcpTools(router, req, res), { name: 'grafana-fixture', version: '1' })));
  app.use(router); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request: Fixture['request'] = async (path, headers = adminHeaders, body) => {
    const response = await fetch(base + path, { headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json().catch(() => null) };
  };
  try { await run({ request, router, calls, setUpstream: (handler) => { upstreamHandler = handler; } }); }
  finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    resetObservabilityAccessAdapter();
  }
}

test('native Grafana reads require existing administrator identity before any upstream access', async () => {
  await fixture(async ({ request, calls }) => {
    for (const endpoint of ['/dashboards', '/dashboards/native-a', '/datasources']) {
      for (const headers of [{}, { 'x-admin-token': 'incorrect' }, { 'x-fixture-sso': 'fixture-member' }, { 'x-tenant-token': 'fixture-tenant-token' }]) {
        const response = await request(API + endpoint, headers as Record<string, string>);
        assert.equal(response.status, 403); assert.equal(response.cache, 'no-store');
      }
    }
    assert.equal(calls.length, 0);
    assert.equal((await request(API + '/dashboards')).status, 200);
    assert.equal((await request(API + '/datasources', { 'x-fixture-sso': 'fixture-admin-sso' })).status, 200);
    assert.equal(calls.length, 2);
    delete process.env.RDK_CHAT_CREDITS_DB_URL;
    const disabled = await request(API + '/dashboards'); assert.equal(disabled.status, 503); assert.equal(disabled.data.error, 'central_store_disabled');
    assert.equal(calls.length, 2);
  });
});

test('single-user deployment exposes Grafana only to authenticated admin or a verified anonymous loopback operator', async () => {
  await fixture(async ({ request, calls }) => {
    const configureLocal = (anonymousLocal: boolean) => configureObservabilityAccess({
      getSessionSsoUser: () => null, isMultiUserWebDeployment: () => false,
      allowsAnonymousLocalOperator: () => anonymousLocal, resolveChatPrincipalAccountId: () => '',
    });
    configureLocal(false);
    for (const endpoint of ['/dashboards', '/dashboards/native-a', '/datasources']) {
      const denied = await request(API + endpoint, {}); assert.equal(denied.status, 403); assert.equal(denied.cache, 'no-store');
    }
    assert.equal(calls.length, 0);
    const generic = await request('/fixture-invoke', {}, { id: `GET ${API}/dashboards`, args: {} }); assert.equal(generic.data.status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request(API + '/datasources')).status, 200); assert.equal(calls.length, 1);
    configureLocal(true);
    for (const endpoint of ['/dashboards', '/dashboards/native-a', '/datasources']) assert.equal((await request(API + endpoint, {})).status, 200);
    const count = calls.length;
    assert.equal((await request(API + '/dashboards', { 'x-admin-token': 'incorrect' })).status, 403);
    assert.equal((await request(API + '/dashboards', { 'x-tenant-token': 'fixture-tenant' })).status, 403);
    assert.equal(calls.length, count);
  });
});

test('explicit three GET capabilities are hidden from tenants and dispatch through real guards in assistant/MCP', async () => {
  await fixture(async ({ request, router, calls }) => {
    const operations = listPlatformOperations(router);
    assert.equal(operations.length, 3); assert.ok(operations.every((operation) => !operation.mutating && !operation.tenantAccessible));
    assert.equal(visiblePlatformOperations(router, { opsTenantAccess: { tenantId: 'tenant-fixture', displayName: 'tenant', source: 'token' } } as Request).length, 0);
    assert.match(operations.find((operation) => operation.path.endsWith('/:uid'))!.parameters.params.uid, /必填/);
    const denied = await request('/fixture-invoke', {}, { id: `GET ${API}/dashboards`, args: {} });
    assert.equal(denied.data.status, 403); assert.equal(calls.length, 0);
    const allowed = await request('/fixture-invoke?tenant=selected', adminHeaders, { id: `GET ${API}/dashboards/:uid`, args: { params: { uid: 'native-a' } } });
    assert.equal(allowed.data.ok, true); assert.equal(allowed.data.data.dashboard.uid, 'native-a');
    const rpc = await request('/fixture-mcp', adminHeaders, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute_platform_operation', arguments: { operationId: `GET ${API}/datasources` } } });
    assert.equal(rpc.data.result.isError, false); assert.match(JSON.stringify(rpc.data.result), /Prometheus/);
    const unsafe = await request('/fixture-mcp', {}, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_platform_operation', arguments: { operationId: `GET ${API}/datasources` } } });
    assert.equal(unsafe.data.result.isError, true); assert.match(JSON.stringify(unsafe.data.result), /platform_http_403/);
    const missing = await request('/fixture-invoke', adminHeaders, { id: `GET ${API}/dashboards/:uid`, args: {} });
    assert.equal(missing.data.data.error, 'invalid_operation_params');
  });
});

test('catalog search preserves title filtering and uses only fixed API GET without forwarding caller credentials', async () => {
  await fixture(async ({ request, calls }) => {
    const response = await request(API + '/dashboards?q=' + encodeURIComponent('原生 & CPU') + '&limit=1', { ...adminHeaders, cookie: 'private-cookie', authorization: 'Bearer private-bearer', 'x-fixture-sso': 'fixture-admin-sso' });
    assert.equal(response.status, 200); assert.equal(response.cache, 'no-store');
    assert.deepEqual(response.data.dashboards[0], { uid: 'native-a', title: 'Native 主机', folderUid: 'dobs-folder', folderTitle: 'd-obs', tags: ['host'], path: '/dobs/grafana/d/native-a' });
    assert.equal(response.data.returnedCount, 1); assert.equal(response.data.mayHaveMore, true);
    assert.equal(response.data.scope, 'platform'); assert.equal(response.data.containsLiveMetrics, false);
    const upstream = calls[0]; assert.equal(upstream.method, 'GET');
    const url = new URL(upstream.path, 'http://localhost'); assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('type'), 'dash-db'); assert.equal(url.searchParams.get('query'), '原生 & CPU'); assert.equal(url.searchParams.get('limit'), '1');
    for (const key of ['x-admin-token', 'cookie', 'authorization', 'x-fixture-sso', 'x-tenant-token']) assert.equal(upstream.headers[key], undefined);
    assert.doesNotMatch(JSON.stringify(response.data), /private/);
  });
});

test('dashboard definition preserves full PromQL and datasource references while excluding unsafe plugin and private metadata', async () => {
  await fixture(async ({ request, calls }) => {
    const response = await request(API + '/dashboards/native-a');
    assert.equal(response.status, 200); assert.equal(response.data.containsLiveMetrics, false);
    const dashboard = response.data.dashboard; assert.equal(dashboard.readOnly, true); assert.equal(dashboard.provisioned, true);
    assert.equal(dashboard.panelCount, 1); assert.equal(dashboard.panelsTruncated, false); assert.equal(dashboard.panelCountIsLowerBound, false);
    const target = dashboard.panels[0].targets[0]; assert.equal(target.expr, panelExpression); assert.equal(target.queryExecutableViaPlatform, true);
    assert.deepEqual(target.datasource, { uid: 'prometheus', type: 'prometheus' });
    assert.doesNotMatch(JSON.stringify(response.data), /private-|http:\/\//);
    assert.equal(calls[0].path, '/api/dashboards/uid/native-a');
  });
});

test('datasource reads project only safe metadata and never expose URL, users, credentials, headers or secure config', async () => {
  await fixture(async ({ request }) => {
    const response = await request(API + '/datasources'); assert.equal(response.status, 200);
    assert.deepEqual(response.data.datasources, [{ uid: 'prometheus', name: 'Prometheus', type: 'prometheus', isDefault: true, readOnly: true }]);
    assert.equal(response.data.returnedCount, 1); assert.equal(response.data.truncated, false);
    assert.doesNotMatch(JSON.stringify(response.data), /private|url|password|secureJsonData|jsonData|user/i);
  });
});

test('invalid caller inputs and attempts to set proxy URL are rejected without upstream requests', async () => {
  await fixture(async ({ request, calls }) => {
    for (const path of [
      '/dashboards?q=a&q=b', '/dashboards?q=' + 'x'.repeat(121), '/dashboards?q=%00', '/dashboards?limit=0', '/dashboards?limit=101',
      '/dashboards?limit=1.2', '/dashboards?limit=NaN', '/dashboards?limit=1&limit=2', '/dashboards?url=http://external.invalid/',
      '/datasources?baseUrl=http://external.invalid/', '/dashboards/native%2Fa', '/dashboards/%2e%2e%2Fa', '/dashboards/native%5Ca', '/dashboards/native%00a', '/dashboards/native-a?q=forbidden',
    ]) assert.equal((await request(API + path)).status, 400, path);
    assert.equal(calls.length, 0);
    assert.equal((await request(API + '/dashboards', adminHeaders, {})).status, 404);
    assert.equal(calls.length, 0);
  });
});

test('upstream configuration fails closed for non-loopback hosts, credentials, query, fragment and encoded paths', async () => {
  for (const baseUrl of ['https://grafana.example.invalid', 'http://192.0.2.1', 'http://fixture:private@127.0.0.1:3000', 'http://127.0.0.1:3000/?x=1', 'http://127.0.0.1:3000/#private', 'http://127.0.0.1:3000/%2foutside', 'file:///tmp/grafana']) {
    await fixture(async ({ request, calls }) => {
      const response = await request(API + '/datasources'); assert.equal(response.status, 503); assert.equal(response.data.error, 'grafana_invalid_configuration'); assert.equal(calls.length, 0);
    }, { baseUrl });
  }
});

test('server configured loopback subpath is preserved without double slash or client proxy selection', async () => {
  await fixture(async ({ request, calls }) => {
    assert.equal((await request(API + '/dashboards')).status, 200);
    assert.equal((await request(API + '/dashboards/native-a')).status, 200);
    assert.equal((await request(API + '/datasources')).status, 200);
    assert.deepEqual(calls.map((call) => new URL(call.path, 'http://localhost').pathname), ['/dobs/grafana/api/search', '/dobs/grafana/api/dashboards/uid/native-a', '/dobs/grafana/api/datasources']);
  }, {}, '/dobs/grafana/');
});

test('upstream auth, not-found, HTTP, content-type, JSON and structural failures retain honest safe errors', async () => {
  await fixture(async ({ request, setUpstream }) => {
    const cases: Array<{ status: number; expected: string; write: UpstreamHandler }> = [
      { status: 404, expected: 'grafana_dashboard_not_found', write: (_req, res) => json(res, { message: 'private-account' }, 404) },
      { status: 502, expected: 'grafana_upstream_access_denied', write: (_req, res) => json(res, { message: 'private-account' }, 403) },
      { status: 502, expected: 'grafana_upstream_failed', write: (_req, res) => json(res, { message: 'private-account' }, 500) },
      { status: 502, expected: 'grafana_invalid_response', write: (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>private-account</html>'); } },
      { status: 502, expected: 'grafana_invalid_response', write: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{invalid private-account'); } },
      { status: 502, expected: 'grafana_invalid_response', write: (_req, res) => json(res, { dashboard: { uid: 'wrong-id', title: 'wrong', panels: [] } }) },
    ];
    for (const value of cases) {
      setUpstream(value.write); const response = await request(API + '/dashboards/native-a');
      assert.equal(response.status, value.status); assert.deepEqual(response.data, { ok: false, error: value.expected });
      assert.doesNotMatch(JSON.stringify(response.data), /private-account/);
    }
    setUpstream((_req, res) => json(res, { message: 'private-account' }));
    assert.equal((await request(API + '/datasources')).data.error, 'grafana_invalid_response');
    assert.equal((await request(API + '/dashboards')).data.error, 'grafana_invalid_response');
  });
});

test('upstream redirects are rejected and their target is never requested', async () => {
  await fixture(async ({ request, calls, setUpstream }) => {
    setUpstream((_req, res) => { res.writeHead(302, { location: '/private-redirect-target' }); res.end(); });
    const response = await request(API + '/datasources'); assert.equal(response.status, 502); assert.equal(response.data.error, 'grafana_unreachable');
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/datasources');
  });
});

test('upstream timeout and declared/streaming size bounds stop unbounded reads', async () => {
  await fixture(async ({ request, setUpstream }) => {
    setUpstream(() => undefined); const response = await request(API + '/datasources');
    assert.equal(response.status, 504); assert.equal(response.data.error, 'grafana_upstream_timeout');
    setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); });
    const stalledBody = await request(API + '/datasources'); assert.equal(stalledBody.status, 504); assert.equal(stalledBody.data.error, 'grafana_upstream_timeout');
  }, { timeoutMs: 50 });
  await fixture(async ({ request, setUpstream }) => {
    setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2048' }); res.write('['); });
    assert.equal((await request(API + '/datasources')).data.error, 'grafana_upstream_response_too_large');
    setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('[' + ' '.repeat(600)); });
    const response = await request(API + '/datasources'); assert.equal(response.status, 502); assert.equal(response.data.error, 'grafana_upstream_response_too_large');
  }, { maxResponseBytes: 128 });
});

test('panel/target/variable bounds and incomplete or redacted expressions are explicit and never become executable', async () => {
  await fixture(async ({ request, setUpstream }) => {
    setUpstream((_req, res) => json(res, { dashboard: {
      uid: 'native-a', title: 'Big dashboard', panels: [{ type: 'row', panels: Array.from({ length: 81 }, (_, id) => ({ id, title: 'panel', type: 'timeseries', datasource: { uid: 'prometheus', type: 'prometheus' }, targets: [
        { refId: 'A', expr: 'up{instance="$host"}' }, { refId: 'B', expr: 'up{token="private-expression-token"}' },
        { refId: 'C', expr: 'x'.repeat(2001) }, { refId: 'D', expr: 'up\u0000' }, ...Array.from({ length: 5 }, () => ({ expr: 'up' })),
      ] })) }], templating: { list: Array.from({ length: 41 }, () => ({ name: 'host', type: 'query', multi: true, includeAll: false, query: 'private-variable', current: { value: 'private-variable' } })) },
    } }));
    const response = await request(API + '/dashboards/native-a'); assert.equal(response.status, 200);
    const dashboard = response.data.dashboard; assert.equal(dashboard.panels.length, 80); assert.equal(dashboard.panelCount, 81); assert.equal(dashboard.panelsTruncated, true);
    assert.equal(dashboard.panels[0].targets.length, 8); assert.equal(dashboard.panels[0].targetCount, 9); assert.equal(dashboard.panels[0].targetsTruncated, true);
    const targets = dashboard.panels[0].targets;
    assert.equal(targets[0].hasTemplateVariables, true); assert.equal(targets[1].expressionRedacted, true); assert.equal(targets[2].expressionOmitted, true); assert.equal(targets[2].expr, undefined); assert.equal(targets[3].expressionRedacted, true);
    assert.ok(targets.slice(0, 4).every((target: any) => target.queryExecutableViaPlatform === false));
    assert.equal(dashboard.variables.length, 40); assert.equal(dashboard.variablesTruncated, true);
    assert.doesNotMatch(JSON.stringify(response.data), /private-expression-token|private-variable/);
    let nested: unknown[] = [{ id: 1, title: 'deep-panel', type: 'timeseries', targets: [] }];
    for (let index = 0; index < 10; index++) nested = [{ type: 'row', panels: nested }];
    setUpstream((_req, res) => json(res, { dashboard: { uid: 'native-a', title: 'Deep dashboard', panels: nested } }));
    const deep = (await request(API + '/dashboards/native-a')).data.dashboard;
    assert.equal(deep.panelsTruncated, true); assert.equal(deep.panelCountIsLowerBound, true);
  });
});

test('bounded datasource and search arrays preserve explicit result limits instead of claiming a false global total', async () => {
  await fixture(async ({ request, setUpstream }) => {
    setUpstream((req, res) => json(res, Array.from({ length: 101 }, (_, index) => req.url!.includes('/api/search') ? { uid: `dash-${index}`, title: 'panel', type: 'dash-db' } : { uid: `source-${index}`, name: 'source', type: 'prometheus' })));
    const catalog = await request(API + '/dashboards?limit=10'); assert.equal(catalog.data.dashboards.length, 10); assert.equal(catalog.data.mayHaveMore, true); assert.equal(catalog.data.total, undefined);
    const sources = await request(API + '/datasources'); assert.equal(sources.data.datasources.length, 100); assert.equal(sources.data.returnedCount, 100); assert.equal(sources.data.truncated, true);
  });
});
