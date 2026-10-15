import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { VisionDeviceRegistry } from './vision-workshop-device.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API } from './vision-workshop-routes.js';

test('isolated HTTP calibration computes known BLC values, preserves lineage and denies cross-owner or unsupported SDK application', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-calibration-http-'));
  const previous = process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'calibration-alice,calibration-bob';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-owner') ? { id: req.header('x-fixture-owner')! } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const app = express(); app.use(express.json()); const router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => newService, getDevices: () => new VisionDeviceRegistry([]), modelEnabled: () => false });
  const newService = new VisionWorkshopService({ dataDir: dir });
  app.use(router); const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); resetObservabilityAccessAdapter(); if (previous === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = previous; });
  const headers = { 'x-fixture-owner': 'calibration-alice', 'x-rdk-ops-action': 'observability', 'content-type': 'application/json' };
  async function call(path: string, body?: object, status = 200, actor = 'calibration-alice') {
    const response = await fetch(origin + API + path, { headers: { ...headers, 'x-fixture-owner': actor }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const data = await response.json() as any; assert.equal(response.status, status, JSON.stringify(data)); return data;
  }
  const experiment = (await call('/experiments', { title: 'Synthetic BLC HTTP fixture', goal: 'Known math solution; no camera or hardware proof' }, 201)).experiment;
  const base = '/experiments/' + experiment.id;
  const inputs = [];
  for (const jitter of [-1, 0, 1]) {
    const raw = Buffer.alloc(32 * 32 * 2);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.writeUInt16LE([64, 66, 68, 70][(y % 2) * 2 + x % 2] + jitter, (y * 32 + x) * 2);
    const sample = (await call(base + '/samples', { filename: 'fixture-dark.raw', metadata: { scene: 'synthetic-dark', width: 32, height: 32, bitDepth: 12, bayer: 'RGGB', packing: 'unpacked16le', stride: 64, blackLevel: 0, whiteLevel: 4095, exposureUs: 1000, gain: 1 }, contentBase64: raw.toString('base64') }, 201)).sample;
    inputs.push({ sampleId: sample.id, capture: { target: 'lens_covered_dark', source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'fixture-raw12', exposureUs: 1000, analogGain: 1, lightBlocked: true } });
  }
  const task = (await call(base + '/calibration/tasks', { operation: 'blc', inputs }, 201)).task;
  await call(base + '/calibration/tasks/' + task.id, undefined, 404, 'calibration-bob');
  const denied = await fetch(origin + API + base + '/calibration/tasks/' + task.id + '/run', { method: 'POST', headers: { ...headers, 'x-rdk-ops-read-only': '1' }, body: '{}' }); assert.equal(denied.status, 403);
  const completed = (await call(base + '/calibration/tasks/' + task.id + '/run', {})).task;
  assert.equal(completed.status, 'completed'); assert.equal(completed.execution.executor, 'cpu-offline-numpy'); assert.equal(completed.execution.exitCode, 0);
  const result = (await call(base + '/calibration/tasks/' + task.id + '/result')).result;
  assert.equal(result.status, 'computed'); assert.equal(result.hardwareVerification, 'unverified'); assert.equal(result.qualityVerification, 'unverified');
  assert.equal(result.inputArtifacts.length, 3); assert.match(result.outputSha256, /^[a-f0-9]{64}$/);
  const plan = (await call(base + '/calibration/tasks/' + task.id + '/apply-plan')).plan;
  assert.equal(plan.status, 'sdk_mapping_required'); assert.equal(plan.mappingAvailability, 'unavailable'); assert.equal(plan.writesDevice, false);
  const ready = (await call(base + '/readiness')).readiness;
  assert.equal(ready.stages.find((stage: any) => stage.id === 'calibration').status, 'observed'); assert.equal(ready.hardwareVerification, 'unverified');
  await call(base + '/calibration/tasks/' + task.id + '/run', {}, 409);
});
