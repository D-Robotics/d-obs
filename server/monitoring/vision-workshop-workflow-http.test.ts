import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { VisionDeviceRegistry, type VisionDeviceAdapter } from './vision-workshop-device.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP } from './vision-workshop-routes.js';

test('workflow and stream analysis use owned evidence over HTTP and typed MCP without operating a device', async () => {
  const before = process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') ? { id: req.header('x-fixture-user')! } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const directory = await mkdtemp(join(tmpdir(), 'camera-workflow-http-')); const service = new VisionWorkshopService({ dataDir: directory });
  let deviceCalls = 0;
  const adapter: VisionDeviceAdapter = { profile: { id: 'new-sensor-fixture', label: 'No hardware', board: 'fixture-board', sensorModel: 'fixture-new-sensor', sdkVersion: 'fixture-sdk', operations: ['probe', 'bringup', 'pipeline_validate', 'controls_get', 'apply_tuning', 'capture_frame', 'restore_tuning'] }, execute: async () => { deviceCalls++; throw new Error('No device execution allowed'); } };
  const registry = new VisionDeviceRegistry([adapter]); const app = express(); app.use(express.json()); const router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => true }); app.use(router);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  const headers = (actor = 'alice') => ({ 'content-type': 'application/json', 'x-fixture-user': actor, 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1' });
  const experiment = await service.createExperiment('sso:alice', { title: '新型号协议验收', goal: 'No real hardware', targetId: adapter.profile.id, board: adapter.profile.board, sensorModel: adapter.profile.sensorModel, sdkVersion: adapter.profile.sdkVersion });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(origin + MCP, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  try {
    const response = await fetch(origin + API + '/experiments/' + experiment.id + '/workflow', { headers: headers() }); assert.equal(response.status, 200);
    const workflow = ((await response.json()) as { workflow: { contract: string; nextActions: Array<{ tool: string }>; automaticExecution: boolean } }).workflow; assert.equal(workflow.contract, 'rdk.vision-camera-workflow.v1');
    assert.equal(workflow.nextActions[0].tool, 'vision_camera_probe'); assert.equal(workflow.automaticExecution, false);
    const read = await rpc('vision_camera_workflow', { experimentId: experiment.id }); assert.equal(read.result.isError, false);
    assert.equal(JSON.parse(read.result.content[0].text).data.workflow.experimentId, experiment.id);
    assert.equal((await fetch(origin + API + '/experiments/' + experiment.id + '/workflow', { headers: headers('bob') })).status, 404);
    assert.equal((await fetch(origin + API + '/experiments/' + experiment.id + '/stream-analysis', { headers: headers('bob') })).status, 404);
    const tuningHash = 'a'.repeat(64); const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await service.recordDeviceRun('sso:alice', experiment.id, { operation: 'capture_frame', adapterId: adapter.profile.id, board: adapter.profile.board, sensorModel: adapter.profile.sensorModel, sdkVersion: adapter.profile.sdkVersion, status: 'completed', evidence: { result: { tuningHash, evidence: { frameId: String(1 + 464 * i), sdkTimestampNs: String(1_000_000_000 + 10_000_000_000 * i), timestampSource: 'hbn_frame_info.tv_timeval', pipelineEpoch: 0 } } } });
      ids.push(run.id);
    }
    const analyzed = await rpc('vision_camera_stream_analyze', { experimentId: experiment.id, runIds: ids, expectedFps: 30, tolerancePercent: 5, minimumDurationSeconds: 10 });
    assert.equal(analyzed.result.isError, false); const analysis = JSON.parse(analyzed.result.content[0].text).data.analysis;
    assert.equal(analysis.groups.length, 1); assert.equal(analysis.groups[0].frameIdRatePerSecond, 46.4);
    assert.equal(analysis.groups[0].targetComparison.withinTolerance, false); assert.equal(analysis.actualSensorFpsVerified, false);
    const rejected = await rpc('vision_camera_stream_analyze', { experimentId: experiment.id, samples: [{ fps: 30 }] }); assert.equal(rejected.result.isError, true);
    assert.equal((await fetch(origin + API + '/experiments/' + experiment.id + '/stream-analysis?expectedFps=NaN', { headers: headers() })).status, 400);
    assert.equal((await fetch(origin + API + '/experiments/' + experiment.id + '/stream-analysis?runIds=invalid', { headers: headers() })).status, 400);
    assert.equal(deviceCalls, 0);
    const readiness = await fetch(origin + API + '/experiments/' + experiment.id + '/readiness', { headers: headers() });
    assert.equal(((await readiness.json()) as { readiness: { aiDebug: { missingOperations: string[] } } }).readiness.aiDebug.missingOperations.length, 0, 'native apply_tuning does not require a controls_set fallback');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); resetObservabilityAccessAdapter();
    if (before === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = before;
  }
});
