import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import express, { Router } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PluginRuntime } from '../plugins/plugin-runtime.js';
import { CAMERA_WORKSHOP_PLUGIN_TEMPLATE } from '../plugins/plugin-camera-workshop.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_MCP } from './vision-workshop-routes.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { VisionDeviceRegistry } from './vision-workshop-device.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { loadPluginAssistantContext } from './plugin-assistant-context.js';

async function fixture(t: TestContext) {
  const saved = { token: process.env.RDK_CREDITS_ADMIN_TOKEN, admins: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'camera-plugin-fixture'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'reviewer-a,reviewer-b';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') ? { id: req.header('x-fixture-user')! } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const dir = await mkdtemp(join(tmpdir(), 'camera-plugin-integration-'));
  const runtime = new PluginRuntime({ stateDir: join(dir, 'plugins') });
  const service = new VisionWorkshopService({ dataDir: join(dir, 'vision') });
  const app = express(); app.use(express.json()); const router = Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => new VisionDeviceRegistry([]), modelEnabled: () => false });
  registerPluginRoutes(router, { runtime }); app.use('/dobs', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/dobs';
  async function request(path: string, method = 'GET', body?: unknown, actor = 'reviewer-a', extra: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': actor, 'x-rdk-ops-action': 'observability', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  t.after(async () => { runtime.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); resetObservabilityAccessAdapter(); if (saved.token === undefined) delete process.env.RDK_CREDITS_ADMIN_TOKEN; else process.env.RDK_CREDITS_ADMIN_TOKEN = saved.token; if (saved.admins === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = saved.admins; });
  return { runtime, service, request };
}

test('published camera plugin queries real protected knowledge and removes its assistant guide when disabled', async t => {
  const f = await fixture(t); const base = '/api/ops/observability/plugins';
  const draft = await f.request(base + '/draft', 'POST', CAMERA_WORKSHOP_PLUGIN_TEMPLATE); assert.equal(draft.status, 201);
  assert.deepEqual(await loadPluginAssistantContext('sso:reviewer-a', f.runtime), []);
  const published = await f.request(base + '/camera-workshop/publish', 'POST', { expectedRevision: draft.data.plugin.revision }); assert.equal(published.status, 200, JSON.stringify(published.data));
  const facts = await f.request(base + '/camera-workshop/data/facts'); assert.equal(facts.status, 200); assert.ok(facts.data.result.data.some((fact: { id: string }) => fact.id === 'vendor-versions'));
  const readiness = await f.request(base + '/camera-workshop/data/readiness'); assert.equal(readiness.status, 200); assert.equal(readiness.data.result.data.status, 'adapter_unavailable'); assert.equal(readiness.data.result.data.hardwareVerification, 'unverified');
  const workflow = await f.request(base + '/camera-workshop/workflows/readiness/run', 'POST', {}, 'reviewer-a', { 'x-rdk-ops-read-only': '1' }); assert.equal(workflow.status, 200); assert.equal(workflow.data.result.steps.length, 3);
  assert.deepEqual(await f.service.listExperiments('sso:reviewer-a'), []);
  const guide = await loadPluginAssistantContext('sso:reviewer-a', f.runtime); assert.equal(guide[0].pluginId, 'camera-workshop');
  assert.equal((await f.request(base + '/camera-workshop/data/facts', 'GET', undefined, 'reviewer-b')).status, 404);
  const disabled = await f.request(base + '/camera-workshop/enabled', 'POST', { enabled: false, expectedRevision: published.data.plugin.revision }); assert.equal(disabled.status, 200);
  assert.deepEqual(await loadPluginAssistantContext('sso:reviewer-a', f.runtime), []); assert.equal((await f.request(base + '/camera-workshop/data/facts')).status, 409);
});

test('portable typed MCP tools discover runtime and create experiments without manufacturing a hardware adapter', async t => {
  const f = await fixture(t);
  const call = async (name: string, args: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const response = await f.request(VISION_WORKSHOP_MCP, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'reviewer-a', extra);
    assert.equal(response.status, 200); return response.data.result;
  };
  const status = await call('vision_workshop_runtime_status', {}); assert.equal(status.isError, false); assert.equal(JSON.parse(status.content[0].text).data.bringup.status, 'unavailable');
  const unavailable = await call('vision_experiment_create', { title: 'X5 IMX415', goal: '点亮', targetId: 'not-configured' }); assert.equal(unavailable.isError, true);
  const denied = await call('vision_experiment_create', { title: '只读', goal: '导入' }, { 'x-rdk-ops-read-only': '1' }); assert.equal(denied.isError, true);
  const created = await call('vision_experiment_create', { title: '协议验收导入实验', goal: '无设备，仅验证接口' }); assert.equal(created.isError, false);
  const experiment = JSON.parse(created.content[0].text).data.experiment;
  const fetched = await call('vision_experiment_get', { experimentId: experiment.id }); assert.equal(fetched.isError, false); assert.equal(JSON.parse(fetched.content[0].text).data.experiment.deviceRuns.length, 0);
  const baseline = await call('vision_tuning_baseline_import', { experimentId: experiment.id, config: { denoise: 1 }, rules: [{ path: '/denoise', label: 'fixture rule', min: 0, max: 2 }] }); assert.equal(baseline.isError, false);
  const invalid = await call('vision_experiment_create', { title: '非法输入', goal: '拒绝', command: 'untrusted' }); assert.equal(invalid.isError, true);
  const listed = await call('vision_experiment_list', {}); assert.equal(listed.isError, false); assert.equal(JSON.parse(listed.content[0].text).data.experiments.length, 1);
});
