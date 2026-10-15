/** Real CPU math + REST/MCP fixtures. No physical camera or ISP validation. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Router } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { requireSshLogAccess } from './ssh-log-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { handleMcpJsonRpc } from '../observability/agent-mcp.js';
import { VisionWorkshopService, type VisionExperiment, type VisionRawMetadata } from './vision-workshop-service.js';
import { VisionDeviceRegistry, configuredVisionDevices, VISION_DEVICE_CONTRACT, type VisionDeviceOperation } from './vision-workshop-device.js';
import { VISION_WORKSHOP_API as API } from './vision-workshop-operations.js';
import { listPlatformOperations } from './platform-operations.js';
import { registerVisionCalibrationRoutes, buildVisionCalibrationMcpTools, VisionCalibrationService, VISION_CALIBRATION_OPERATIONS, type VisionCalibrationOptions } from './vision-workshop-calibration.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_MCP } from './vision-workshop-routes.js';

const MCP = '/calibration-test-mcp';
const BLACK = { R: 64, Gr: 66, Gb: 68, B: 70 };
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const meta = (width = 32, height = 32): VisionRawMetadata => ({ scene: 'synthetic-known-solution-fixture', width, height, bitDepth: 12, bayer: 'RGGB', packing: 'unpacked16le', stride: width * 2, blackLevel: 0, whiteLevel: 4095, exposureUs: 1000, gain: 1 });
function mosaic(values: typeof BLACK | ((channel: keyof typeof BLACK, x: number, y: number) => number), width = 32, height = 32): Buffer {
  const data = Buffer.alloc(width * height * 2); const channels = ['R', 'Gr', 'Gb', 'B'] as const;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const channel = channels[y % 2 * 2 + x % 2]; data.writeUInt16LE(Math.round(typeof values === 'function' ? values(channel, x, y) : values[channel]), (y * width + x) * 2); }
  return data;
}
const conditions = (target: string, extra: Record<string, unknown> = {}) => ({ target, source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'fixture-raw12', exposureUs: 1000, analogGain: 1, ...extra });
let dir: string; let service: VisionWorkshopService; let calibration: VisionCalibrationService; let experiment: VisionExperiment; let router: Router; let server: Server; let origin: string;
let saved: Record<string, string | undefined>;
let backendServer: Server | undefined;
const devices = () => new VisionDeviceRegistry();
async function start(options: Partial<VisionCalibrationOptions> = {}) {
  const app = express(); app.use(express.json({ limit: '2mb' })); router = express.Router();
  calibration = registerVisionCalibrationRoutes(router, { service: () => service, devices, stateDir: path.join(dir, 'calibration'), ...options });
  router.post(MCP, requireSshLogAccess, requireOpsMutationGuard, async (req, res) => res.json(await handleMcpJsonRpc(req.body, buildVisionCalibrationMcpTools(router, req, res), { name: 'explicit-calibration-fixture', version: '1' })));
  app.use(router); app.use('/prefix', router); server = createServer(app);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
}
async function stop() { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } }
beforeEach(async () => {
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'calibration-server-secret-do-not-print'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: req => { const id = req.header('x-fixture-user'); return id ? { id, email: 'same-mail@example.invalid' } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await mkdtemp(path.join(tmpdir(), 'd-obs-calibration-')); service = new VisionWorkshopService({ dataDir: path.join(dir, 'vision') });
  experiment = await service.createExperiment('sso:alice', { title: 'Explicit numerical fixture', goal: 'Test offline algorithms only', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk' });
  await start();
});
afterEach(async () => { await stop(); if (backendServer) { backendServer.closeAllConnections(); await new Promise<void>(done => backendServer!.close(() => done())); backendServer = undefined; } await rm(dir, { recursive: true, force: true }); resetObservabilityAccessAdapter(); for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
function headers(actor = 'alice') { return { 'content-type': 'application/json', 'x-fixture-user': actor, 'x-rdk-ops-action': 'observability' }; }
const route = (exp = experiment.id) => API + '/experiments/' + exp + '/calibration';
async function post(suffix: string, body: unknown, actor = 'alice', extra: Record<string, string> = {}) { return fetch(origin + route() + suffix, { method: 'POST', headers: { ...headers(actor), ...extra }, body: JSON.stringify(body) }); }
async function get(suffix: string, actor = 'alice') { return fetch(origin + route() + suffix, { headers: headers(actor) }); }
async function json(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function tool(name: string, args: Record<string, unknown>, actor = 'alice', extra: Record<string, string> = {}) { return json(await fetch(origin + MCP, { method: 'POST', headers: { ...headers(actor), ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })); }
function value(rpc: any): any { assert.equal(rpc.result.isError, false, JSON.stringify(rpc)); const result = JSON.parse(rpc.result.content[0].text); assert.equal(result.ok, true); return result.data; }
async function raw(bytes: Buffer, metadata = meta()) { return service.addRawSample('sso:alice', experiment.id, { metadata }, bytes); }
async function dark() {
  const samples = []; for (const jitter of [-1, 0, 1]) samples.push(await raw(mosaic(Object.fromEntries(Object.entries(BLACK).map(([key, value]) => [key, value + jitter])) as typeof BLACK)));
  return { operation: 'blc', inputs: samples.map(sample => ({ sampleId: sample.id, capture: conditions('lens_covered_dark', { lightBlocked: true }) })) };
}
const ledger = () => path.join(dir, 'calibration', hash('sso:alice'), experiment.id, 'ledger.json');

test('real BLC Python math executes through typed MCP and REST, with persisted owned hash evidence and neutral apply plan', async () => {
  const input = await dark(); const task = value(await tool('vision_calibration_task_create', { experimentId: experiment.id, ...input })).task;
  assert.equal(task.status, 'queued'); assert.equal(task.inputs.length, 3); assert.deepEqual(task.inputs.map((row: any) => row.artifactId), input.inputs.map(row => row.sampleId));
  assert.equal(task.hardwareVerification, 'unverified');
  const completed = value(await tool('vision_calibration_task_run', { experimentId: experiment.id, taskId: task.id })).task;
  assert.equal(completed.status, 'completed'); assert.equal(completed.attempt, 1); assert.equal(completed.execution.executor, 'cpu-offline-numpy'); assert.equal(completed.execution.exitCode, 0);
  const result = (await json(await get('/tasks/' + task.id + '/result'))).result;
  assert.deepEqual(result.parameters.values, BLACK); assert.equal(result.hardwareVerification, 'unverified'); assert.equal(result.qualityVerification, 'unverified');
  assert.equal(result.parameters.method, 'multi_dark_frame_per_bayer_channel_median_mad'); assert.ok(result.parameters.statistics.Gr.robustSigmaCodes > 0);
  const file = path.join(path.dirname(ledger()), task.id + '.result.json'); const bytes = await readFile(file); assert.equal(hash(bytes), completed.result.sha256); assert.equal(result.outputSha256, completed.result.outputSha256);
  const manifest = await readFile(path.join(path.dirname(ledger()), task.id + '.manifest.json')); assert.equal(hash(manifest), completed.submittedManifestSha256); assert.equal(JSON.parse(manifest.toString()).datasetId, task.id);
  const plan = value(await tool('vision_calibration_apply_plan', { experimentId: experiment.id, taskId: task.id })).plan;
  assert.equal(plan.status, 'sdk_mapping_required'); assert.equal(plan.writesDevice, false); assert.equal(plan.target.adapterStatus, 'unconfigured'); assert.deepEqual(plan.calibration.values, BLACK); assert.equal(plan.lineage.resultFileSha256, hash(bytes)); assert.match(plan.prerequisites.join(' '), /BLC.*effect library/);
  assert.equal((await readdir(path.dirname(ledger()))).some(name => name.startsWith('job-')), false);
  if (process.platform !== 'win32') { assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(ledger())).mode & 0o777, 0o600); }
  assert.equal((await post('/tasks/' + task.id + '/run', {})).status, 409); // completed jobs are not replayed automatically
  await stop(); await start(); assert.equal((await json(await get('/tasks/' + task.id))).task.status, 'completed'); assert.deepEqual((await calibration.getResult('sso:alice', experiment.id, task.id)).parameters.values, BLACK);
  assert.equal(listPlatformOperations(router).length, Object.keys(VISION_CALIBRATION_OPERATIONS).length); assert.ok(listPlatformOperations(router).every(operation => !operation.tenantAccessible));
});

test('CCM measurement upload binds actual owned image hashes and known train/heldout solution, with explicit sRGB decoding', async () => {
  const source = await raw(mosaic(BLACK, 128, 32), meta(128, 32));
  const matrix = [[1.05, -.03, .02], [.01, .97, .03], [-.02, .04, 1.01]];
  const linear = Array.from({ length: 12 }, (_, index) => [.15 + .025 * index, .2 + .04 * (index % 5), .18 + .07 * (index % 7)]);
  const srgb = (v: number) => v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055;
  const measurement = { target: 'recorded_color_chart', measurementSpace: 'camera-linear-rgb', preprocessing: 'synthetic-known-linear-fixed-wb', referenceEncoding: 'srgb', referenceWhitePoint: 'D65', referenceIlluminantId: 'fixture-D65', imageWidth: 128, imageHeight: 32, illuminant: { id: 'fixture-D65', colorTemperatureK: 6500, source: 'synthetic-fixture' }, patches: linear.map((rgb, index) => ({ patchId: 'patch-' + index, sourceArtifactId: source.id, roi: { x: index * 8, y: 4, width: 4, height: 4 }, measuredLinearRgb: rgb, referenceRgb: matrix.map(row => srgb(row.reduce((sum, factor, channel) => sum + factor * rgb[channel], 0))), split: index < 9 ? 'train' : 'heldout' })) };
  const imported = value(await tool('vision_calibration_asset_import', { experimentId: experiment.id, measurement })).asset;
  assert.equal(imported.verification, 'unverified'); assert.deepEqual(imported.sourceArtifacts, [{ id: source.id, sha256: source.hash, kind: 'raw-sample' }]);
  assert.equal((await json(await get('/assets'))).assets[0].sha256, imported.sha256);
  const task = (await json(await post('/tasks', { operation: 'ccm', inputs: [{ artifactId: imported.id }] }), 201)).task;
  await json(await post('/tasks/' + task.id + '/run', {})); const result = value(await tool('vision_calibration_task_result', { experimentId: experiment.id, taskId: task.id })).result;
  assert.equal(result.parameters.referenceEncoding, 'srgb'); assert.equal(result.parameters.statistics.heldoutCount, 3); assert.ok(result.parameters.statistics.heldoutRmseLinear < 1e-12);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) assert.ok(Math.abs(result.parameters.values[row][col] - matrix[row][col]) < 1e-12);
  assert.equal(result.inputArtifacts[0].sha256, imported.sha256); assert.equal(result.qualityVerification, 'unverified');
  assert.equal((await post('/assets', { measurement: { ...measurement, patches: measurement.patches.map(patch => ({ ...patch, sourceArtifactId: '00000000-0000-4000-8000-000000000000' })) } })).status, 404);
});

test('LSC and multi-illuminant AWB use actual RAW bytes and recorded conditions via REST, without ISP execution', async () => {
  const flat = []; for (let index = 0; index < 3; index++) flat.push(await raw(mosaic((channel, x, y) => BLACK[channel] + [[300, 400], [400, 600]][Math.floor(y / 16)][Math.floor(x / 16)])));
  const input = { operation: 'lsc', inputs: flat.map(sample => ({ sampleId: sample.id, capture: conditions('neutral_uniform_flat_field', { illuminantId: 'fixture-light', illuminationUniformity: { method: 'independent_meter_grid', luxSamples: [100, 100.2, 99.8, 100.1, 99.9] } }) })), options: { blackLevels: BLACK, grid: { rows: 2, cols: 2 } } };
  const lsc = (await json(await post('/tasks', input), 201)).task; await json(await post('/tasks/' + lsc.id + '/run', {}));
  const mesh = (await json(await get('/tasks/' + lsc.id + '/result'))).result.parameters.values; assert.deepEqual(mesh.R, [[2, 1.5], [1.5, 1]]); assert.deepEqual(mesh.Gb, mesh.R);
  const samples = [];
  for (const [illuminantId, colorTemperatureK, red, blue] of [['warm-fixture', 2850, 500, 200], ['daylight-fixture', 6500, 200, 500]] as const) for (let index = 0; index < 3; index++) {
    const sample = await raw(mosaic({ R: BLACK.R + red, Gr: BLACK.Gr + 400, Gb: BLACK.Gb + 400, B: BLACK.B + blue }));
    samples.push({ sampleId: sample.id, capture: conditions('neutral_gray_card', { illuminantId, colorTemperatureK, roi: { x: 4, y: 4, width: 16, height: 16 } }) });
  }
  const awb = (await json(await post('/tasks', { operation: 'awb', inputs: samples, options: { blackLevels: BLACK } }), 201)).task;
  await json(await post('/tasks/' + awb.id + '/run', {})); const result = (await json(await get('/tasks/' + awb.id + '/result'))).result;
  assert.deepEqual(result.parameters.values.map((sample: any) => [sample.colorTemperatureK, sample.redGain, sample.greenGain, sample.blueGain]), [[2850, .8, 1, 2], [6500, 2, 1, .8]]);
  assert.equal(result.executor, 'cpu-offline-numpy'); assert.equal(result.hardwareVerification, 'unverified');
});

test('REST/MCP enforce auth, mutation intent, account isolation and strict asset IDs, with no path/command admission', async () => {
  const input = await dark(); const task = (await json(await post('/tasks', input), 201)).task;
  for (const actor of ['', 'outsider']) assert.equal((await get('/tasks', actor)).status, 403);
  for (const suffix of ['/tasks', '/tasks/' + task.id, '/tasks/' + task.id + '/result', '/assets']) assert.equal((await get(suffix, 'bob')).status, 404);
  assert.equal((await post('/tasks/' + task.id + '/run', {}, 'bob')).status, 404);
  for (const extra of [{ path: '/etc/passwd' }, { command: 'echo secret' }, { scriptPath: '/tmp/client.py' }, { owner: 'sso:bob' }, { host: '127.0.0.1' }]) assert.equal((await post('/tasks', { ...input, ...extra })).status, 400);
  assert.equal((await post('/tasks', { ...input, inputs: [{ sampleId: '../../etc/passwd', capture: input.inputs[0].capture }] })).status, 400);
  assert.equal((await post('/tasks', input, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
  const missingIntent = await fetch(origin + route() + '/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': 'alice' }, body: JSON.stringify(input) }); assert.equal(missingIntent.status, 400);
  const rpc = await tool('vision_calibration_task_run', { experimentId: experiment.id, taskId: task.id }, 'alice', { 'x-rdk-ops-read-only': '1' }); assert.equal(rpc.result.isError, true); assert.match(rpc.result.content[0].text, /platform_read_only_operation_denied/);
  const foreign = await service.createExperiment('sso:bob', { title: 'Bob private', goal: 'isolation' }); const foreignSample = await service.addRawSample('sso:bob', foreign.id, { metadata: meta() }, mosaic(BLACK));
  assert.equal((await post('/tasks', { ...input, inputs: [...input.inputs.slice(0, 2), { ...input.inputs[2], sampleId: foreignSample.id }] })).status, 404);
  assert.equal((await json(await get('/tasks/' + task.id))).task.attempt, 0); assert.equal((await json(await get('/tasks'))).tasks.length, 1);
  const untrusted = await tool('vision_calibration_task_create', { experimentId: experiment.id, ...input, path: '/etc/passwd' }); assert.equal(untrusted.result.isError, true);
});

test('algorithm failure, dependency_missing and interrupted restart remain real failed evidence with no success/result records', async () => {
  const input = await dark(); (input.inputs[0].capture as Record<string, unknown>).lightBlocked = false;
  const task = (await json(await post('/tasks', input), 201)).task;
  const failure = await json(await post('/tasks/' + task.id + '/run', {}), 422); assert.equal(failure.error, 'vision_calibration_blocked_light_dark_capture_required');
  const stored = (await json(await get('/tasks/' + task.id))).task; assert.equal(stored.status, 'failed'); assert.equal(stored.execution.exitCode, 1); assert.equal(stored.result, undefined);
  assert.equal((await get('/tasks/' + task.id + '/result')).status, 409); assert.equal((await get('/tasks/' + task.id + '/apply-plan')).status, 409);
  await stop();
  const venv = path.join(dir, 'no-numpy'); execFileSync('python3', ['-m', 'venv', '--without-pip', venv], { timeout: 15_000, stdio: 'pipe' });
  await start({ pythonExecutable: path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') });
  const queued = (await json(await post('/tasks', await dark()), 201)).task;
  const missing = await json(await post('/tasks/' + queued.id + '/run', {}), 503); assert.equal(missing.error, 'vision_calibration_dependency_numpy_missing');
  assert.equal((await json(await get('/tasks/' + queued.id))).task.status, 'failed'); assert.equal((await get('/tasks/' + queued.id + '/result')).status, 409);
  await stop();
  const state = JSON.parse(await readFile(ledger(), 'utf8')); const row = state.tasks.find((row: any) => row.id === queued.id); row.status = 'running'; row.coordinatorPid = 2147483000; delete row.error; await writeFile(ledger(), JSON.stringify(state), { mode: 0o600 });
  await start(); assert.equal((await json(await get('/tasks/' + queued.id))).task.status, 'interrupted'); assert.equal((await get('/tasks/' + queued.id + '/result')).status, 409);
  const restored = (await json(await post('/tasks/' + queued.id + '/run', {}))).task; assert.equal(restored.status, 'completed'); assert.equal(restored.attempt, 2);
});

test('fixed server subprocess timeout/output errors are sanitized and corrupted result bytes cannot be read as valid', async () => {
  const input = await dark(); const good = (await json(await post('/tasks', input), 201)).task; await json(await post('/tasks/' + good.id + '/run', {}));
  await writeFile(path.join(path.dirname(ledger()), good.id + '.result.json'), '{"forged":true}', { mode: 0o600 });
  const corrupted = await json(await get('/tasks/' + good.id + '/result'), 503); assert.equal(corrupted.error, 'vision_calibration_result_corrupt');
  await stop();
  const timeoutScript = path.join(dir, 'trusted-timeout-fixture.py'); await writeFile(timeoutScript, 'import time\ntime.sleep(10)\n', { mode: 0o600 }); await start({ scriptPath: timeoutScript, timeoutMs: 50 });
  const slow = (await json(await post('/tasks', await dark()), 201)).task; await json(await post('/tasks/' + slow.id + '/run', {}), 422); const expired = (await json(await get('/tasks/' + slow.id))).task; assert.equal(expired.error, 'vision_calibration_timeout'); assert.equal(expired.execution.termination, 'timeout'); assert.equal(expired.result, undefined);
  await stop();
  const unsafeScript = path.join(dir, 'trusted-error-fixture.py'); await writeFile(unsafeScript, 'import json,os,sys\nprint(json.dumps({"ok":False,"error":"calibration_server_secret_do_not_print"}))\nprint(os.environ.get("RDK_CREDITS_ADMIN_TOKEN","no-service-secrets"),file=sys.stderr)\nsys.exit(1)\n', { mode: 0o600 }); await start({ scriptPath: unsafeScript });
  const rejected = (await json(await post('/tasks', await dark()), 201)).task; const response = await post('/tasks/' + rejected.id + '/run', {}); assert.equal(response.status, 422); const text = await response.text(); assert.doesNotMatch(text, /secret[-_]do[-_]not[-_]print|\/private/); assert.match(text, /vision_calibration_process_failed/);
  const actual = await readFile(ledger(), 'utf8'); assert.doesNotMatch(actual, /secret[-_]do[-_]not[-_]print|\/private/); assert.equal((await json(await get('/tasks/' + rejected.id))).task.result, undefined);
});

test('tampered real algorithm payload or echoed manifest digest cannot become a completed calibration', async () => {
  const realScript = path.resolve('tools/vision-x5-calibration.py');
  for (const fault of ['payload', 'manifest']) {
    await stop(); const wrapper = path.join(dir, 'trusted-proof-fault-' + fault + '.py');
    await writeFile(wrapper, [
      'import json,pathlib,subprocess,sys',
      'run=subprocess.run([sys.executable,' + JSON.stringify(realScript) + ',*sys.argv[1:]],capture_output=True,text=True)',
      'summary=json.loads(run.stdout)',
      ...(fault === 'payload' ? ['output=pathlib.Path(sys.argv[sys.argv.index("--output")+1])', 'result=json.loads(output.read_text())', 'result["parameters"]["values"]["R"]=999', 'output.write_text(json.dumps(result,sort_keys=True,separators=(",",":")))'] : ['summary["submittedManifestSha256"]="0"*64']),
      'print(json.dumps(summary))', 'sys.exit(run.returncode)',
    ].join('\n') + '\n', { mode: 0o600 });
    await start({ scriptPath: wrapper }); const task = (await json(await post('/tasks', await dark()), 201)).task;
    const failed = await json(await post('/tasks/' + task.id + '/run', {}), 422); assert.equal(failed.error, fault === 'payload' ? 'vision_calibration_output_hash_invalid' : 'vision_calibration_output_contract_invalid');
    const stored = (await json(await get('/tasks/' + task.id))).task; assert.equal(stored.status, 'failed'); assert.equal(stored.result, undefined); assert.equal(stored.execution.exitCode, 0); assert.equal((await get('/tasks/' + task.id + '/result')).status, 409);
  }
});

test('archived RAW bytes changed after task creation fail before Python and retain no output record', async () => {
  const input = await dark(); const task = (await json(await post('/tasks', input), 201)).task;
  await writeFile(path.join(service.dataDir, 'assets', input.inputs[0].sampleId + '.raw'), mosaic({ R: 0, Gr: 0, Gb: 0, B: 0 }), { mode: 0o600 });
  await json(await post('/tasks/' + task.id + '/run', {}), 422); const stored = (await json(await get('/tasks/' + task.id))).task;
  assert.equal(stored.status, 'failed'); assert.equal(stored.execution, undefined); assert.equal(stored.result, undefined); assert.equal(stored.error, 'asset_corrupt'); assert.equal((await get('/tasks/' + task.id + '/result')).status, 409);
});

/** A stateful independent HTTP peer, explicitly a SDK protocol fixture. */
async function mainRoutesFixture() {
  await stop();
  let snapshot = { brightness: 64, contrast: 1, saturation: 1, ccm: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } };
  let effectBytes = Buffer.from(JSON.stringify({ fixtureEffectLibrary: { contrast: 1 }, source: 'sdk-protocol-fixture' }));
  let mismatch = false; let exportCorrupt = false;
  const calls: Array<{ operation: VisionDeviceOperation; inputs: Record<string, any> }> = [];
  let getters = 0; let setters = 0;
  const readSnapshot = () => { getters++; return structuredClone(snapshot); };
  const rules = () => [
    { path: '/brightness', label: 'fixture CPROC brightness', min: -127, max: 127, precision: 'float32' },
    ...['contrast', 'saturation'].map(key => ({ path: '/' + key, label: 'fixture CPROC ' + key, min: 0, max: Math.fround(1.999), precision: 'float32' })),
    ...Array.from({ length: 9 }, (_, index) => ({ path: '/ccm/matrix/' + Math.floor(index / 3) + '/' + index % 3, label: 'fixture CCM coefficient', min: -8, max: 8, precision: 'float32' })),
  ];
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.post('/execute', (req, res) => {
    assert.equal(req.header('authorization'), 'Bearer fixture-private-http-calibration-token');
    assert.equal(req.body.contract, VISION_DEVICE_CONTRACT); const { operation, context, inputs } = req.body; calls.push({ operation, inputs: structuredClone(inputs) });
    let result: Record<string, unknown>;
    if (operation === 'tuning_export') result = { source: 'sdk-protocol-fixture', filename: 'fixture-effect-library.json', mimeType: 'application/json', contentBase64: effectBytes.toString('base64'), sha256: exportCorrupt ? '0'.repeat(64) : hash(effectBytes), moduleReadbackHash: hash(JSON.stringify(readSnapshot())), verification: 'unverified' };
    else {
      if (operation === 'tuning_load') { const bytes = Buffer.from(inputs.contentBase64, 'base64'); assert.equal(hash(bytes), inputs.sha256); const library = JSON.parse(bytes.toString()); setters++; effectBytes = bytes; snapshot.contrast = Math.fround(library.fixtureEffectLibrary.contrast); }
      else if (operation === 'calibration_apply') {
        assert.equal(inputs.result.executor, 'cpu-offline-numpy'); assert.equal(inputs.result.operation, 'ccm'); assert.equal(inputs.result.hardwareVerification, 'unverified'); assert.equal(inputs.result.qualityVerification, 'unverified');
        setters++; snapshot.ccm.matrix = inputs.result.parameters.values.map((row: number[]) => row.map(Math.fround));
      } else assert.equal(operation, 'tuning_get');
      const actual = readSnapshot(); const currentHash = hash(JSON.stringify(actual));
      result = { source: 'sdk-protocol-fixture', baseline: { config: actual, rules: rules() }, readbackHash: mismatch ? '0'.repeat(64) : currentHash, ...(operation !== 'tuning_get' ? { appliedHash: currentHash } : {}), hardwareVerification: 'unverified', qualityVerification: 'unverified' };
    }
    res.json({ ok: true, contract: VISION_DEVICE_CONTRACT, operation, jobId: context.jobId, result });
  });
  backendServer = createServer(app); await new Promise<void>(done => backendServer!.listen(0, '127.0.0.1', done)); const address = backendServer.address(); assert.ok(address && typeof address !== 'string');
  const profile = { id: 'fixture-calibration-sdk', label: 'Stateful HTTP SDK protocol fixture', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk', operations: ['tuning_get', 'tuning_load', 'tuning_export', 'calibration_apply'] };
  const registry = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([{ ...profile, url: `http://127.0.0.1:${address.port}`, token: 'fixture-private-http-calibration-token' }]) });
  const platform = express(); platform.use(express.json({ limit: '2mb' })); router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => true, generateCandidate: async () => ({ source: 'model', model: 'explicit-calibration-test-fixture-planner', modelInput: 'raw_statistics_and_baseline', patches: [{ path: '/contrast', value: 1.3, reason: 'Fixture proposal only; no physical image evaluation' }], text: 'SDK protocol fixture' }) });
  platform.use(router); server = createServer(platform); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const platformAddress = server.address(); assert.ok(platformAddress && typeof platformAddress !== 'string'); origin = `http://127.0.0.1:${platformAddress.port}`;
  async function rpc(name: string, args: Record<string, unknown>, actor = 'alice') { return json(await fetch(origin + VISION_WORKSHOP_MCP, { method: 'POST', headers: headers(actor), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) })); }
  experiment = value(await rpc('vision_experiment_create', { title: 'SDK calibration integration fixture', goal: 'Software evidence only; no physical camera', targetId: profile.id })).experiment;
  return { inflateSnapshot: () => { Object.assign(snapshot, { fixtureLut: Array.from({length:10_000},(_,i)=>i) }); }, calls, rpc, snapshot: () => structuredClone(snapshot), setters: () => setters, getters: () => getters, mismatch: (enabled: boolean) => { mismatch = enabled; }, exportCorrupt: (enabled: boolean) => { exportCorrupt = enabled; } };
}
async function ccmTaskMain() {
  const source = await raw(mosaic(BLACK, 128, 32), meta(128, 32)); const matrix = [[1.1, -.02, .01], [.02, .98, .03], [-.01, .04, 1.02]];
  const measurement = { target: 'recorded_color_chart', measurementSpace: 'camera-linear-rgb', preprocessing: 'synthetic-known-linear-fixed-wb', referenceEncoding: 'linear-srgb', referenceWhitePoint: 'D65', referenceIlluminantId: 'fixture-D65', imageWidth: 128, imageHeight: 32, illuminant: { id: 'fixture-D65', colorTemperatureK: 6500, source: 'synthetic-fixture' }, patches: Array.from({ length: 12 }, (_, index) => { const rgb = [.15 + .025 * index, .2 + .04 * (index % 5), .18 + .07 * (index % 7)]; return { patchId: 'patch-' + index, sourceArtifactId: source.id, roi: { x: index * 8, y: 4, width: 4, height: 4 }, measuredLinearRgb: rgb, referenceRgb: matrix.map(row => row.reduce((sum, factor, channel) => sum + factor * rgb[channel], 0)), split: index < 9 ? 'train' : 'heldout' }; }) };
  const asset = (await json(await post('/assets', { measurement }), 201)).asset; const task = (await json(await post('/tasks', { operation: 'ccm', inputs: [{ artifactId: asset.id }] }), 201)).task;
  await json(await post('/tasks/' + task.id + '/run', {})); return { task, matrix };
}

test('main typed MCP applies an owned real-computed CCM through stateful HTTP, independently reads snapshot and updates AI baseline', async () => {
  const fixture = await mainRoutesFixture(); const { task, matrix } = await ccmTaskMain();
  const plan = value(await fixture.rpc('vision_calibration_apply_plan', { experimentId: experiment.id, taskId: task.id })).plan;
  assert.equal(plan.status, 'mapping_requires_runtime_qualification'); assert.equal(plan.mappingAvailability, 'configured-adapter'); assert.equal(plan.writesDevice, false); assert.equal(plan.hardwareVerification, 'unverified'); assert.equal(fixture.setters(), 0);
  const read = value(await fixture.rpc('vision_isp_tuning_get', { experimentId: experiment.id })); assert.equal(read.result.source, 'sdk-protocol-fixture'); assert.equal(fixture.getters(), 1);
  const initial = await service.getExperiment('sso:alice', experiment.id); assert.equal(initial.baselineHistory.length, 1);
  const applied = value(await fixture.rpc('vision_calibration_apply', { experimentId: experiment.id, taskId: task.id })); assert.equal(applied.deviceRun.status, 'completed'); assert.equal(fixture.setters(), 1); assert.equal(fixture.getters(), 2);
  const actual = fixture.snapshot(); for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) assert.ok(Math.abs(actual.ccm.matrix[row][col] - Math.fround(matrix[row][col])) < 1e-6);
  assert.equal(applied.result.readbackHash, hash(JSON.stringify(actual))); assert.equal(applied.result.appliedHash, applied.result.readbackHash);
  assert.equal(fixture.calls.find(row => row.operation === 'calibration_apply')!.inputs.result.outputSha256, (await json(await get('/tasks/' + task.id + '/result'))).result.outputSha256);
  const current = await service.getExperiment('sso:alice', experiment.id); assert.equal(current.baselineHistory.length, 2); assert.equal(current.baseline!.hash, applied.result.readbackHash); assert.equal(current.deviceRuns.at(-1)!.evidence.result && (current.deviceRuns.at(-1)!.evidence.result as any).source, 'sdk-protocol-fixture');
  const candidate = value(await fixture.rpc('vision_isp_generate', { experimentId: experiment.id })).candidate;
  assert.equal(candidate.baselineHash, current.baseline!.hash); assert.equal(candidate.verification, 'unverified'); assert.equal(candidate.model, 'explicit-calibration-test-fixture-planner'); assert.equal(candidate.tuning.contrast, Math.fround(1.3));
});

test('main SDK apply rejects foreign/uncomputed tasks before device; readback mismatch records unconfirmed failure; load/export verify actual bytes', async () => {
  const fixture = await mainRoutesFixture(); const { task } = await ccmTaskMain(); const expArgs = { experimentId: experiment.id };
  const missing = await fixture.rpc('vision_calibration_apply', { ...expArgs, taskId: '00000000-0000-4000-8000-000000000000' }); assert.equal(missing.result.isError, true);
  const foreign = await fixture.rpc('vision_calibration_apply', { ...expArgs, taskId: task.id }, 'bob'); assert.equal(foreign.result.isError, true);
  const queued = (await json(await post('/tasks', await dark()), 201)).task; const pending = await fixture.rpc('vision_calibration_apply', { ...expArgs, taskId: queued.id }); assert.equal(pending.result.isError, true); assert.equal(fixture.calls.length, 0);
  const sourceBytes = Buffer.from(JSON.stringify({ fixtureEffectLibrary: { contrast: 1.2 }, source: 'sdk-protocol-fixture' }));
  for (const bytes of [Buffer.from('{malformed'), Buffer.from('[]')]) {
    const rejected = await fixture.rpc('vision_isp_tuning_load', { ...expArgs, contentBase64: bytes.toString('base64'), sha256: hash(bytes) }); assert.equal(rejected.result.isError, true);
  }
  const badHash = await fixture.rpc('vision_isp_tuning_load', { ...expArgs, contentBase64: sourceBytes.toString('base64'), sha256: '0'.repeat(64) }); assert.equal(badHash.result.isError, true); assert.equal(fixture.calls.length, 0);
  const loaded = value(await fixture.rpc('vision_isp_tuning_load', { ...expArgs, contentBase64: sourceBytes.toString('base64'), sha256: hash(sourceBytes) })); assert.equal(loaded.result.baseline.config.contrast, Math.fround(1.2)); assert.equal(fixture.setters(), 1);
  const exported = value(await fixture.rpc('vision_isp_tuning_export', expArgs)); assert.equal(exported.artifact.mimeType, 'application/json'); assert.equal(exported.artifact.sha256, hash(sourceBytes)); assert.deepEqual(Buffer.from(exported.artifact.contentBase64, 'base64'), sourceBytes);
  fixture.exportCorrupt(true); const invalidExport = await fixture.rpc('vision_isp_tuning_export', expArgs); assert.equal(invalidExport.result.isError, true); fixture.exportCorrupt(false);
  const before = await service.getExperiment('sso:alice', experiment.id); fixture.mismatch(true);
  const rejected = await fixture.rpc('vision_calibration_apply', { ...expArgs, taskId: task.id }); assert.equal(rejected.result.isError, true); assert.match(rejected.result.content[0].text, /vision_device_readback_mismatch/);
  const after = await service.getExperiment('sso:alice', experiment.id); assert.equal(after.baseline!.hash, before.baseline!.hash); assert.equal(after.baselineHistory.length, before.baselineHistory.length); assert.equal(after.deviceRuns.at(-1)!.status, 'failed'); assert.equal(after.deviceRuns.at(-1)!.evidence.outcome, 'unconfirmed'); assert.equal(fixture.setters(), 2);
  assert.equal((await json(await get('/tasks/' + task.id))).task.status, 'completed'); assert.equal((await json(await get('/tasks/' + task.id + '/result'))).result.hardwareVerification, 'unverified');
});


test('full SDK snapshots with a large LUT persist an actual baseline and bounded hash ledger without losing API values', async () => {
  const fixture=await mainRoutesFixture(); fixture.inflateSnapshot();
  const result=value(await fixture.rpc('vision_isp_tuning_get',{experimentId:experiment.id}));
  assert.equal(result.result.baseline.config.fixtureLut.length,10_000);
  const stored=await service.getExperiment('sso:alice',experiment.id);
  assert.equal((stored.baseline!.tuning.fixtureLut as number[]).length,10_000);
  const receipt=stored.deviceRuns.at(-1)!.evidence.result as any;
  assert.equal(receipt.baseline.config.sha256,stored.baseline!.hash);
  assert.equal(receipt.baseline.ruleCount,12);
  assert.equal(JSON.stringify(receipt).length<4096,true);
});
