import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configuredVisionDevices, VISION_DEVICE_CONTRACT, type VisionDeviceOperation, type VisionDeviceContext } from './vision-workshop-device.js';
import { analyzeVisionRaw, type VisionRawMetadata } from './vision-workshop-raw.js';
import { VisionWorkshopError, VisionWorkshopService } from './vision-workshop-service.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API } from './vision-workshop-routes.js';

// The standalone runner deliberately uses only Node standard libraries.
const { createVisionDeviceRunner } = await import(new URL('../../tools/vision-workshop-device-runner.mjs', import.meta.url).href) as {
  createVisionDeviceRunner: (config: unknown) => Server;
};
const TOKEN = 'http-integration-private-token-0123456789';
const CONTEXT = { experimentId: 'fixture-experiment', board: 'RDK X5' as const, sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-http-v1' };
const RAW = Buffer.from([0, 0, 0, 2, 0, 1, 255, 3]);
// A complete 2 × 2 RGB PNG, matching both fixture RAW layouts and archival checks.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGNoAAMGCAUAKg4GARWeQtcAAAAASUVORK5CYII=', 'base64');
const TUNING = { fixture_isp: { gamma: 1.2 } };
type CameraFixture = { identity: Omit<VisionDeviceContext, 'jobId' | 'experimentId'>; raw: Buffer; metadata: VisionRawMetadata; tuning: Record<string, unknown>; channelMeans: { R: number; G: number; B: number } };
const CAMERAS: CameraFixture[] = [
  { identity: { board: 'RDK X5', sensorVendor: 'Sony', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-http-v1', cameraInterface: 'CSI-2', cameraMode: 'fixture-linear-10' }, raw: RAW,
    metadata: { scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 }, tuning: TUNING, channelMeans: { R: 0, G: 384, B: 1023 } },
  { identity: { board: 'Fixture board B', sensorVendor: 'OmniVision', sensorModel: 'OV9281', sdkVersion: 'fixture-sdk-http-v2', cameraInterface: 'Parallel', cameraMode: 'fixture-linear-12' }, raw: Buffer.from([255, 1, 0x0f, 128, 0, 0xf0]),
    metadata: { scene: '逆光', width: 2, height: 2, bitDepth: 12, bayer: 'BGGR', packing: 'mipi-raw12', stride: 3, blackLevel: 0, whiteLevel: 4095 },
    tuning: { calibration_v2: { noise_coefficients: [0.1, 0.2], tone_mapping: { curve: [0, 64, 192, 255] } } }, channelMeans: { R: 15, G: 1032, B: 4095 } },
];
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const fixtureSdk = `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [mode, requestFile, rawFile, tuningFile, auditFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile, 'utf8'));
const digest = input => createHash('sha256').update(input).digest('hex');
await appendFile(auditFile, JSON.stringify({ operation: request.operation, context: request.context, contract: request.contract,
  tuningHash: request.inputs.tuningHash, raw: request.inputs.raw }) + '\\n');
const save = result => writeFile(join(process.cwd(), 'result.json'), JSON.stringify(result));
if (mode === 'slow') {
  setInterval(() => {}, 1000);
} else if (request.operation === 'probe') {
  await save({ facts: { sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-http-v1', source: 'local-fixture-only' } });
} else if (request.operation === 'capture_raw') {
  await writeFile(join(process.cwd(), 'captured.raw'), Buffer.from('${RAW.toString('base64')}', 'base64'));
  await save({ filename: 'fixture-capture.raw', artifactFile: 'captured.raw', metadata: { scene: request.inputs.scene, width: 2, height: 2,
    bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 } });
} else if (request.operation === 'process_raw') {
  const raw = await readFile(rawFile); const tuning = await readFile(tuningFile);
  if (digest(raw) !== request.inputs.raw.sha256 || digest(tuning) !== request.inputs.tuningHash) process.exit(7);
  await writeFile(join(process.cwd(), 'fixture-isp.png'), Buffer.from('${PNG.toString('base64')}', 'base64'));
  await writeFile(join(process.cwd(), 'fixture-loaded.json'), tuning);
  const readback = await readFile(join(process.cwd(), 'fixture-loaded.json'));
  await save({ filename: 'fixture-isp.png', mimeType: 'image/png', artifactFile: 'fixture-isp.png',
    rawHash: digest(raw), tuningHash: digest(tuning), readbackHash: digest(readback) });
} else if (request.operation === 'apply_tuning') {
  // A disk-backed fixture load/readback verifies protocol only, never real ISP.
  const tuning = await readFile(tuningFile); await writeFile(join(process.cwd(), 'fixture-loaded.json'), tuning);
  const readback = await readFile(join(process.cwd(), 'fixture-loaded.json'));
  await save({ appliedHash: digest(tuning), readbackHash: digest(readback) });
} else await save({ passed: true, checks: [{ label: 'local fixture only', passed: true }] });
`;

async function start(options: { slow?: VisionDeviceOperation; timeoutMs?: number; camera?: CameraFixture } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vision-sdk-http-'));
  const executable = join(dir, 'fixture-sdk.mjs'); const auditFile = join(dir, 'audit.jsonl');
  const camera = options.camera;
  const identity = camera?.identity ?? { board: CONTEXT.board, sensorModel: CONTEXT.sensorModel, sdkVersion: CONTEXT.sdkVersion };
  const context = { experimentId: CONTEXT.experimentId, ...identity };
  // The same fixture command protocol handles the different identity, layout and SDK JSON.
  const source = camera ? fixtureSdk
    .replace(RAW.toString('base64'), camera.raw.toString('base64'))
    .replace("sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-http-v1'", '...request.context')
    .replace("scene: request.inputs.scene, width: 2, height: 2,\n    bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023", `...${JSON.stringify(camera.metadata)}, scene: request.inputs.scene`) : fixtureSdk;
  await writeFile(executable, source, { mode: 0o600 });
  const operations: VisionDeviceOperation[] = ['probe', 'pipeline_validate', 'capture_raw', 'process_raw', 'apply_tuning'];
  const commands = Object.fromEntries(operations.map(operation => [operation, { argv: [process.execPath, executable,
    operation === options.slow ? 'slow' : operation, '{requestFile}', operation === 'process_raw' ? '{rawFile}' : '-',
    ['process_raw', 'apply_tuning'].includes(operation) ? '{tuningFile}' : '-', auditFile],
    ...(operation === options.slow ? { timeoutMs: options.timeoutMs ?? 5000 } : {}) }]));
  const server = createVisionDeviceRunner({ token: TOKEN, ...identity,
    // Only the deliberately stalled command gets the short timeout. A later
    // successful probe still needs its normal subprocess startup budget in CI.
    commands, timeoutMs: 5000, jobRoot: join(dir, 'jobs') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local HTTP fixture address');
  const url = `http://127.0.0.1:${address.port}`;
  const id = 'fixture-' + address.port;
  const adapterConfig = { id, label: 'Local fixture SDK bridge', ...identity, operations, url, token: TOKEN };
  const registry = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([adapterConfig]) });
  return { dir, server, url, id, registry, adapterConfig, auditFile, context,
    close: async () => { server.closeIdleConnections(); await new Promise<void>(done => server.close(() => done())); await rm(dir, { recursive: true, force: true }); } };
}
async function audit(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
async function waitForAudit(path: string): Promise<void> {
  for (let index = 0; index < 200; index++) { try { await readFile(path); return; } catch { await delay(10); } }
  throw new Error('Local fixture did not begin');
}

test('configured HTTP adapter interoperates with the real SDK runner for probe, capture, processing and readback', async () => {
  const fixture = await start();
  try {
    const probe = await fixture.registry.execute(fixture.id, 'probe', CONTEXT, {});
    assert.deepEqual(probe.result.facts, { sensorModel: 'IMX415', sdkVersion: CONTEXT.sdkVersion, source: 'local-fixture-only' });
    const captured = await fixture.registry.execute(fixture.id, 'capture_raw', CONTEXT, { scene: '逆光' });
    const bytes = Buffer.from(captured.result.contentBase64 as string, 'base64');
    assert.deepEqual(bytes, RAW); assert.equal(captured.result.sha256, digest(RAW));
    assert.deepEqual(analyzeVisionRaw(bytes, captured.result.metadata).statistics.channelMeans, { R: 0, G: 384, B: 1023 });
    const tuningHash = digest(JSON.stringify(TUNING));
    const processed = await fixture.registry.execute(fixture.id, 'process_raw', CONTEXT, {
      raw: { filename: captured.result.filename, metadata: captured.result.metadata, sha256: captured.result.sha256, contentBase64: captured.result.contentBase64 },
      tuning: TUNING, tuningHash,
    });
    assert.deepEqual(Buffer.from(processed.result.contentBase64 as string, 'base64'), PNG);
    assert.equal(processed.result.sha256, digest(PNG)); assert.equal(processed.result.mimeType, 'image/png');
    const applied = await fixture.registry.execute(fixture.id, 'apply_tuning', CONTEXT, { tuning: TUNING, tuningHash });
    assert.deepEqual(applied.result, { appliedHash: tuningHash, readbackHash: tuningHash });
    const entries = await audit(fixture.auditFile);
    assert.deepEqual(entries.map(entry => entry.operation), ['probe', 'capture_raw', 'process_raw', 'apply_tuning']);
    const jobs = [probe.jobId, captured.jobId, processed.jobId, applied.jobId];
    assert.equal(new Set(jobs).size, 4);
    entries.forEach((entry, index) => {
      assert.equal(entry.contract, VISION_DEVICE_CONTRACT);
      assert.deepEqual(entry.context, { ...CONTEXT, jobId: jobs[index] });
      assert.match(jobs[index]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
    const manifest = entries[2]!.raw as Record<string, unknown>;
    assert.equal(manifest.sha256, digest(RAW)); assert.equal(manifest.contentBase64, undefined);
    assert.equal(entries[2]!.tuningHash, tuningHash); assert.equal(entries[3]!.tuningHash, tuningHash);
    assert.doesNotMatch(JSON.stringify(fixture.registry.list()), new RegExp(TOKEN));
    assert.ok(!JSON.stringify(fixture.registry.list()).includes(fixture.url));
  } finally { await fixture.close(); }
});

test('workshop HTTP routes archive RAW replay witnesses from the standalone SDK runner', async () => {
  const fixture = await start();
  const previousAdmins = process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;
  let http: Server | undefined;
  try {
    process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'replay-fixture-user';
    configureObservabilityAccess({ getSessionSsoUser: () => ({ id: 'replay-fixture-user' }), isMultiUserWebDeployment: () => true,
      allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
    const service = new VisionWorkshopService({ dataDir: join(fixture.dir, 'workshop-state') });
    const app = express(); app.use(express.json());
    const router = express.Router();
    registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => fixture.registry, modelEnabled: () => false });
    app.use(router); http = createServer(app); http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const post = async (suffix: string, body: unknown, status = 200): Promise<any> => {
      const response = await fetch(origin + VISION_WORKSHOP_API + suffix, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' }, body: JSON.stringify(body) });
      assert.equal(response.status, status, await response.clone().text()); return response.json();
    };
    const { experiment } = await post('/experiments', { title: 'Explicit SDK fixture replay', goal: 'Verify HTTP contract only', targetId: fixture.id }, 201);
    await post('/experiments/' + experiment.id + '/baseline', { config: TUNING, rules: [{ path: '/fixture_isp/gamma', label: 'Fixture gamma', min: .1, max: 4 }] });
    const captured = await post('/experiments/' + experiment.id + '/device/capture_raw', { scene: '逆光' });
    const processed = await post('/experiments/' + experiment.id + '/device/process_raw', { sampleId: captured.asset.id });
    assert.equal(processed.asset.source, 'runner');
    assert.equal(processed.asset.sampleId, captured.asset.id);
    assert.equal(processed.asset.tuningHash, digest(JSON.stringify(TUNING)));
    assert.equal(processed.result.rawHash, digest(RAW));
    assert.equal(processed.result.tuningHash, digest(JSON.stringify(TUNING)));
    assert.equal(processed.result.readbackHash, digest(JSON.stringify(TUNING)));
    const stored = await service.getExperiment('sso:replay-fixture-user', experiment.id);
    assert.equal(stored.processedImages.length, 1);
    assert.equal(stored.deviceRuns.at(-1)?.status, 'completed');
  } finally {
    if (http) { http.closeAllConnections(); await new Promise<void>(done => http!.close(() => done())); }
    if (previousAdmins === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = previousAdmins;
    resetObservabilityAccessAdapter(); await fixture.close();
  }
});

test('an incorrect private bearer token fails over real HTTP without starting an SDK command', async () => {
  const fixture = await start();
  try {
    const wrong = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([{ ...fixture.adapterConfig, token: 'incorrect-private-token-0123456789' }]) });
    await assert.rejects(wrong.execute(fixture.id, 'probe', CONTEXT, {}), error => {
      assert.ok(error instanceof VisionWorkshopError); assert.equal(error.code, 'vision_device_execution_failed'); return true;
    });
    await assert.rejects(readFile(fixture.auditFile), { code: 'ENOENT' });
    assert.equal((await fixture.registry.execute(fixture.id, 'probe', CONTEXT, {})).result.facts !== undefined, true);
  } finally { await fixture.close(); }
});

test('real SDK bridge rejects a mismatched tuning hash and preserves the private client error boundary', async () => {
  const fixture = await start();
  try {
    await assert.rejects(fixture.registry.execute(fixture.id, 'apply_tuning', CONTEXT, { tuning: TUNING, tuningHash: '0'.repeat(64) }), error => {
      assert.ok(error instanceof VisionWorkshopError); assert.equal(error.code, 'vision_device_execution_failed');
      assert.ok(!error.message.includes(TOKEN)); return true;
    });
    await assert.rejects(readFile(fixture.auditFile), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

test('real runner device mutex and timeout map to adapter errors and permit a later probe', async () => {
  const fixture = await start({ slow: 'pipeline_validate', timeoutMs: 1500 });
  try {
    // This direct request occupies the real runner; the registry must map its HTTP 429.
    const pending = fetch(fixture.url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: VISION_DEVICE_CONTRACT, operation: 'pipeline_validate', context: { ...CONTEXT, jobId: 'fixture-direct-job' }, inputs: {} }) });
    await waitForAudit(fixture.auditFile);
    await assert.rejects(fixture.registry.execute(fixture.id, 'probe', CONTEXT, {}), error => {
      assert.ok(error instanceof VisionWorkshopError); assert.equal(error.code, 'vision_device_busy'); assert.equal(error.status, 429); return true;
    });
    const timeout = await pending; assert.equal(timeout.status, 504); assert.equal((await timeout.json() as { ok: boolean }).ok, false);
    await delay(20);
    assert.equal((await fixture.registry.execute(fixture.id, 'probe', CONTEXT, {})).result.facts !== undefined, true);
  } finally { await fixture.close(); }
});

test('two camera vendors, Raw layouts and SDK tuning schemas use the same real HTTP atomic pipeline', async () => {
  for (const camera of CAMERAS) {
    const fixture = await start({ camera });
    try {
      const context = fixture.context;
      const probe = await fixture.registry.execute(fixture.id, 'probe', context, {});
      const facts = probe.result.facts as Record<string, unknown>;
      assert.equal(facts.sensorModel, camera.identity.sensorModel); assert.equal(facts.sensorVendor, camera.identity.sensorVendor);
      const capture = await fixture.registry.execute(fixture.id, 'capture_raw', context, { scene: camera.metadata.scene });
      const bytes = Buffer.from(capture.result.contentBase64 as string, 'base64');
      assert.deepEqual(bytes, camera.raw); assert.equal(capture.result.sha256, digest(camera.raw));
      assert.deepEqual(capture.result.metadata, camera.metadata);
      assert.deepEqual(analyzeVisionRaw(bytes, capture.result.metadata).statistics.channelMeans, camera.channelMeans);
      const tuningHash = digest(JSON.stringify(camera.tuning));
      const processed = await fixture.registry.execute(fixture.id, 'process_raw', context, { raw: { filename: capture.result.filename, metadata: capture.result.metadata, sha256: capture.result.sha256, contentBase64: capture.result.contentBase64 }, tuning: camera.tuning, tuningHash });
      assert.equal(processed.result.sha256, digest(PNG));
      const applied = await fixture.registry.execute(fixture.id, 'apply_tuning', context, { tuning: camera.tuning, tuningHash });
      assert.deepEqual(applied.result, { appliedHash: tuningHash, readbackHash: tuningHash });
      const entries = await audit(fixture.auditFile);
      assert.deepEqual(entries.map(entry => entry.operation), ['probe', 'capture_raw', 'process_raw', 'apply_tuning']);
      for (const entry of entries) for (const field of ['board', 'sensorModel', 'sensorVendor', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const) assert.equal((entry.context as Record<string, unknown>)[field], camera.identity[field]);
    } finally { await fixture.close(); }
  }
});

test('declared pipeline identity mismatches fail before any SDK command over HTTP', async () => {
  const fixture = await start({ camera: CAMERAS[1] });
  try {
    for (const field of ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'] as const) {
      await assert.rejects(fixture.registry.execute(fixture.id, 'probe', { ...fixture.context, [field]: 'mismatched' }, {}), error => {
        assert.ok(error instanceof VisionWorkshopError); assert.equal(error.code, 'vision_device_profile_mismatch'); return true;
      });
      const response = await fetch(fixture.url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ contract: VISION_DEVICE_CONTRACT, operation: 'probe', context: { ...fixture.context, jobId: 'fixture-mismatch', [field]: 'mismatched' }, inputs: {} }) });
      assert.equal(response.status, 409); await response.body?.cancel();
    }
    await assert.rejects(readFile(fixture.auditFile), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});
