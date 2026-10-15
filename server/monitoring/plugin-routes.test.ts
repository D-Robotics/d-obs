import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import express, { Router } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { PluginRuntime } from '../plugins/plugin-runtime.js';
import { BUILTIN_PLUGIN_TEMPLATES } from '../plugins/plugin-builtins.js';
import { PluginMcpClient } from '../plugins/plugin-mcp-client.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { executePlatformOperation, listPlatformOperations, registerPlatformOperations } from './platform-operations.js';
import { loadPluginAssistantContext } from './plugin-assistant-context.js';

async function fixture(t: TestContext, suppliedMcp?: PluginMcpClient) {
  const previous = { token: process.env.RDK_CREDITS_ADMIN_TOKEN, admins: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'plugin-fixture-admin';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'operator-a,operator-b';
  configureObservabilityAccess({ getSessionSsoUser: req => { const id = req.header('x-fixture-user'); return id ? { id } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const directory = await mkdtemp(join(tmpdir(), 'plugin-routes-'));
  const runtime = new PluginRuntime({ stateDir: directory, builtins: BUILTIN_PLUGIN_TEMPLATES });
  const mcp = suppliedMcp ?? new PluginMcpClient({ connectors: {} });
  const app = express(); app.use(express.json()); const router = Router();
  let slowClosed = 0;
  router.get('/api/ops/observability/devices', (req, res) => res.json({ ok: true, devices: [{ deviceId: 'fixture-x5', model: 'X5', online: true }], actor: req.header('x-fixture-user'), guard: req.header('x-rdk-ops-action') }));
  router.get('/api/ops/observability/devices/:deviceId/samples', (req, res) => res.json({ ok: true, samples: [{ deviceId: req.params.deviceId, cpuPercent: 12 }] }));
  router.get('/api/ops/observability/overview', (_req, res) => res.json({ ok: true, overview: { summary: { healthyChecks: 7, openIncidents: 2, criticalIncidents: 1 }, checks: [{ title: 'Fixture health', status: 'healthy', summary: 'fixture' }] } }));
  router.get('/api/ops/observability/logs', (_req, res) => res.json({ ok: true, logs: [{ body: 'fixture error', severityText: 'ERROR' }] }));
  router.get('/api/ops/observability/slow', (_req, res) => { const timer = setTimeout(() => res.json({ ok: true }), 2000); res.once('close', () => { slowClosed++; clearTimeout(timer); }); });
  registerPlatformOperations(router, Object.fromEntries(['/devices', '/devices/:deviceId/samples', '/overview', '/logs', '/slow'].map(path => ['GET /api/ops/observability' + path, { tenantAccessible: false, group: 'Fixture', description: path }])));
  registerPluginRoutes(router, { runtime, mcp });
  router.post('/harness/abort', async (req, res) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30);
    const result = await executePlatformOperation(router, req, res, 'GET /api/ops/observability/slow', {}, { signal: controller.signal }); clearTimeout(timer); res.json(result);
  });
  router.post('/harness/operation', async (req, res) => res.json(await executePlatformOperation(router, req, res, req.body.id, req.body.args ?? {})));
  app.use(router); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = async (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; anonymous?: boolean } = {}) => {
    const response = await fetch(origin + path, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json', ...(!options.anonymous ? { 'x-fixture-user': 'operator-a' } : {}), ...options.headers }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  };
  t.after(async () => { await runtime.dispose(); await mcp.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); resetObservabilityAccessAdapter(); for (const [key, value] of [['RDK_CREDITS_ADMIN_TOKEN', previous.token], ['RDK_FLYWHEEL_ADMIN_USER_IDS', previous.admins]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
  const write = (path: string, body: unknown, headers: Record<string, string> = {}) => request('/api/ops/observability/plugins' + path, { method: 'POST', body, headers: { 'x-rdk-ops-action': 'observability', ...headers } });
  const install = async (templateIndex = 0) => { const template = structuredClone(BUILTIN_PLUGIN_TEMPLATES[templateIndex]); const draft = await write('/draft', template); assert.equal(draft.status, 201); const published = await write('/' + template.manifest.id + '/publish', { expectedRevision: draft.data.plugin.revision }); assert.equal(published.status, 200, JSON.stringify(published.data)); return published.data.plugin; };
  return { runtime, router, request, write, install, slowClosed: () => slowClosed };
}

test('plugin routes retain real admin and owner authority', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/ops/observability/plugins/catalog', { anonymous: true })).status, 403);
  assert.equal((await f.request('/api/ops/observability/plugins/catalog', { headers: { 'x-fixture-user': 'member' } })).status, 403);
  assert.equal((await f.request('/api/ops/observability/plugins/catalog', { anonymous: true, headers: { 'x-admin-token': 'incorrect' } })).status, 403);
  assert.equal((await f.request('/api/ops/observability/plugins/catalog', { anonymous: true, headers: { 'x-admin-token': 'plugin-fixture-admin' } })).status, 200);
  const plugin = await f.install();
  assert.equal((await f.request('/api/ops/observability/plugins/' + plugin.id, { headers: { 'x-fixture-user': 'operator-b' } })).status, 404);
  assert.equal((await f.request('/api/ops/observability/plugins/' + plugin.id)).data.plugin.id, plugin.id);
});

test('published builtin data sources use actual wrapped platform response shapes', async t => {
  const f = await fixture(t); const plugin = await f.install();
  const devices = await f.request('/api/ops/observability/plugins/' + plugin.id + '/data/devices?tenant=fixture-team');
  assert.equal(devices.status, 200); assert.equal(devices.data.result.data[0].deviceId, 'fixture-x5'); assert.ok(devices.data.result.receipt.id);
  const overview = await f.request('/api/ops/observability/plugins/' + plugin.id + '/data/overview');
  assert.equal(overview.data.result.data.summary.openIncidents, 2);
  const logs = await f.request('/api/ops/observability/plugins/' + plugin.id + '/data/recent-errors');
  assert.equal(logs.data.result.data[0].severityText, 'ERROR');
  const samples = await f.request('/api/ops/observability/plugins/' + plugin.id + '/tools/device-samples?args=' + encodeURIComponent(JSON.stringify({ params: { deviceId: 'fixture-x5' } })));
  assert.equal(samples.status, 200); assert.equal(samples.data.result.data.data.samples[0].cpuPercent, 12);
});

test('pure diagnostic workflows work in read-only executor while configuration writes are rejected', async t => {
  const f = await fixture(t); const plugin = await f.install();
  const id = 'POST /api/ops/observability/plugins/:id/workflows/:workflowId/run';
  assert.equal(listPlatformOperations(f.router).find(item => item.id === id)?.mutating, false);
  const workflow = await f.request('/harness/operation', { method: 'POST', body: { id, args: { params: { id: plugin.id, workflowId: 'diagnostic-evidence' }, body: {} } }, headers: { 'x-rdk-ops-read-only': '1', 'x-rdk-ops-action': 'observability' } });
  assert.equal(workflow.data.ok, true, JSON.stringify(workflow.data)); assert.equal(workflow.data.data.result.steps.length, 3);
  const disabled = await f.write('/' + plugin.id + '/enabled', { enabled: false, expectedRevision: plugin.revision }, { 'x-rdk-ops-read-only': '1' });
  assert.equal(disabled.status, 403); assert.equal((await f.runtime.detail('sso:operator-a', plugin.id)).enabled, true);
  const noGuard = await f.request('/api/ops/observability/plugins/draft', { method: 'POST', body: BUILTIN_PLUGIN_TEMPLATES[0] });
  assert.equal(noGuard.status, 400);
});

test('publication checks revision and source permissions without replacing current live version', async t => {
  const f = await fixture(t); const plugin = await f.install();
  const next = structuredClone(BUILTIN_PLUGIN_TEMPLATES[0]); next.manifest.version = '1.1.0'; next.manifest.tools[0].source = { type: 'platform', operationId: 'GET /api/ops/observability/not-registered' };
  const saved = await f.write('/draft', { ...next, expectedRevision: plugin.revision }); assert.equal(saved.status, 201);
  assert.equal((await f.write('/' + plugin.id + '/publish', { expectedRevision: saved.data.plugin.revision + 1 })).status, 409);
  assert.equal((await f.write('/' + plugin.id + '/publish', { expectedRevision: saved.data.plugin.revision })).status, 403);
  assert.equal((await f.runtime.detail('sso:operator-a', plugin.id)).published!.manifest.version, '1.0.0');
  const forbidden = structuredClone(next); forbidden.manifest.tools[0].source = { type: 'platform', operationId: 'POST /api/ops/observability/model-pool/cleanup' };
  assert.equal((await f.write('/draft', { ...forbidden, expectedRevision: saved.data.plugin.revision })).status, 403);
});

test('enable disable rollback and uninstall return truthful state and remove execution', async t => {
  const f = await fixture(t); let plugin = await f.install(1);
  const next = structuredClone(BUILTIN_PLUGIN_TEMPLATES[1]); next.manifest.version = '1.1.0'; next.config.hours = 2;
  const saved = await f.write('/draft', { ...next, expectedRevision: plugin.revision }); plugin = (await f.write('/' + plugin.id + '/publish', { expectedRevision: saved.data.plugin.revision })).data.plugin;
  plugin = (await f.write('/' + plugin.id + '/rollback', { version: '1.0.0', expectedRevision: plugin.revision })).data.plugin;
  assert.equal(plugin.published.config.hours, 24);
  plugin = (await f.write('/' + plugin.id + '/enabled', { enabled: false, expectedRevision: plugin.revision })).data.plugin;
  assert.equal((await f.request('/api/ops/observability/plugins/' + plugin.id + '/data/overview')).status, 409);
  const deleted = await f.request('/api/ops/observability/plugins/' + plugin.id, { method: 'DELETE', body: { expectedRevision: plugin.revision }, headers: { 'x-rdk-ops-action': 'observability' } });
  assert.equal(deleted.status, 200); assert.equal((await f.request('/api/ops/observability/plugins/' + plugin.id)).status, 404);
});

test('published editable prompts enter only their owner assistant context and disappear when disabled', async t => {
  const f = await fixture(t); const plugin = await f.install();
  const fragments = await loadPluginAssistantContext('sso:operator-a', f.runtime); assert.equal(fragments[0].pluginId, plugin.id); assert.equal(fragments[0].version, '1.0.0');
  assert.deepEqual(await loadPluginAssistantContext('sso:operator-b', f.runtime), []);
  assert.deepEqual(await loadPluginAssistantContext('ops-admin', f.runtime), []);
  await f.write('/' + plugin.id + '/enabled', { enabled: false, expectedRevision: plugin.revision });
  assert.deepEqual(await loadPluginAssistantContext('sso:operator-a', f.runtime), []);
});

test('platform cancellation closes the captured handler and returns a failed receipt', async t => {
  const f = await fixture(t); const result = await f.request('/harness/abort', { method: 'POST', body: {} });
  assert.equal(result.data.status, 499); assert.equal(result.data.ok, false); assert.equal(f.slowClosed(), 1);
});

test('query arguments cannot manufacture request identity headers or arbitrary URLs', async t => {
  const f = await fixture(t); const plugin = await f.install();
  const bad = await f.request('/api/ops/observability/plugins/' + plugin.id + '/tools/devices?args=' + encodeURIComponent(JSON.stringify({ headers: { 'x-admin-token': 'forged' }, url: 'https://example.com' })));
  assert.equal(bad.status, 400);
  assert.equal((await f.request('/api/ops/observability/plugins/' + plugin.id + '/data/devices?args=%5B%5D')).status, 400);
});

test('missing MCP credentials prevent publication and preserve the previous active version', async t => {
  const mcp = new PluginMcpClient({ connectors: { private: { url: 'http://127.0.0.1:9/mcp', readOnlyTools: ['inspect'], credentialEnv: 'PLUGIN_FIXTURE_UNSET_CREDENTIAL' } }, env: {} });
  const f = await fixture(t, mcp); const plugin = await f.install();
  const next = structuredClone(BUILTIN_PLUGIN_TEMPLATES[0]); next.manifest.version = '1.1.0'; next.manifest.tools[0].source = { type: 'mcp', connectorId: 'private', toolName: 'inspect' };
  const draft = await f.write('/draft', { ...next, expectedRevision: plugin.revision }); assert.equal(draft.status, 201);
  const publication = await f.write('/' + plugin.id + '/publish', { expectedRevision: draft.data.plugin.revision });
  assert.equal(publication.status, 503); assert.equal(publication.data.error, 'plugin_mcp_connector_unavailable');
  assert.equal((await f.runtime.detail('sso:operator-a', plugin.id)).published!.manifest.version, '1.0.0');
});

test('HTTP publication verifies live MCP tool permissions before registering an external data source', async t => {
  let remoteReadOnly = true; let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: remoteReadOnly } }] };
    else { calls++; result = { content: [{ type: 'text', text: 'fixture device' }], structuredContent: { devices: [{ deviceId: 'mcp-fixture-x5', online: true }] } }; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const mcp = new PluginMcpClient({ connectors: { edge: { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp', readOnlyTools: ['inspect'] } } });
  const f = await fixture(t, mcp); const pack = structuredClone(BUILTIN_PLUGIN_TEMPLATES[0]); pack.manifest.tools[0].source = { type: 'mcp', connectorId: 'edge', toolName: 'inspect' }; pack.manifest.dataSources[0].resultPath = 'devices';
  const draft = await f.write('/draft', pack); assert.equal(draft.status, 201, JSON.stringify(draft.data)); const published = await f.write('/' + pack.manifest.id + '/publish', { expectedRevision: draft.data.plugin.revision }); assert.equal(published.status, 200, JSON.stringify(published.data)); let plugin = published.data.plugin;
  assert.ok(plugin.enabled); assert.equal(calls, 0, 'publication discovers tools without running them');
  const query = await f.request('/api/ops/observability/plugins/' + pack.manifest.id + '/data/devices'); assert.equal(query.status, 200); assert.equal(query.data.result.data[0].deviceId, 'mcp-fixture-x5'); assert.equal(calls, 1);
  remoteReadOnly = false; pack.manifest.version = '1.1.0';
  const next = await f.write('/draft', { ...pack, expectedRevision: plugin.revision });
  const denied = await f.write('/' + pack.manifest.id + '/publish', { expectedRevision: next.data.plugin.revision }); assert.equal(denied.status, 503);
  plugin = await f.runtime.detail('sso:operator-a', pack.manifest.id); assert.equal(plugin.published!.manifest.version, '1.0.0'); assert.equal(calls, 1);
});
