import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import express, { type Router } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { VisionWorkshopService, type VisionCandidate, type VisionExperiment, type VisionRawMetadata, type VisionRawSample } from './vision-workshop-service.js';
import { VisionDeviceRegistry, VISION_DEVICE_OPERATIONS, type VisionDeviceAdapter, type VisionDeviceOperation, type VisionDeviceContext, type VisionDeviceProfile } from './vision-workshop-device.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP, VISION_WORKSHOP_OPERATIONS } from './vision-workshop-routes.js';
import { listPlatformOperations } from './platform-operations.js';
import { visionCrc32 } from './vision-workshop-export.js';
import { VISION_CALIBRATION_OPERATIONS } from './vision-workshop-calibration.js';
import type { VisionModelInput, VisionIspCandidate } from './vision-workshop-model.js';
import type { VisionAiDebugDecision, VisionAiDebugInput } from './vision-workshop-ai-model.js';

const metadata: VisionRawMetadata = { scene: '逆光', width: 4, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 8, blackLevel: 0, whiteLevel: 1023 };
const raw = Buffer.alloc(16);
for (let i = 0; i < 8; i++) raw.writeUInt16LE(100 + i * 100, i * 2);
const baseline = { config: { denoise: { strength: 2 } }, rules: [{ path: '/denoise/strength', label: '降噪强度', min: 0, max: 10 }] };
const defaultProposal: VisionIspCandidate = { source: 'model', model: 'fixture-vision-model', modelInput: 'raw_statistics_and_baseline', patches: [{ path: '/denoise/strength', value: 3, reason: '针对实验场景提出候选，待实际验证' }], text: 'controlled fixture' };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function png(width = 4, height = 2, pixel = 0): Buffer {
  const chunk = (name: string, bytes: Buffer) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length); Buffer.from(name).copy(header, 4);
    const trailer = Buffer.alloc(4); trailer.writeUInt32BE(visionCrc32(Buffer.concat([Buffer.from(name), bytes])));
    return Buffer.concat([header, bytes, trailer]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) rows.fill(pixel, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

class FixtureAdapter implements VisionDeviceAdapter {
  profile = { id: 'x5-imx415', label: '本地受控适配器', board: 'RDK X5' as const, sensorModel: 'IMX415' as const, sdkVersion: 'fixture-sdk', operations: [...VISION_DEVICE_OPERATIONS] };
  calls: Array<{ operation: VisionDeviceOperation; context: VisionDeviceContext; inputs: Record<string, unknown> }> = [];
  reply: ((operation: VisionDeviceOperation, inputs: Record<string, unknown>) => Record<string, unknown>) | undefined;
  appliedTuning: Record<string, unknown> = { denoise: { strength: 2 } };
  private load(inputs: Record<string, unknown>): string {
    assert.equal(hash(Buffer.from(JSON.stringify(inputs.tuning))), inputs.tuningHash);
    this.appliedTuning = structuredClone(inputs.tuning as Record<string, unknown>);
    // Read the stored fixture state independently, never echo the supplied hash.
    return hash(Buffer.from(JSON.stringify(structuredClone(this.appliedTuning))));
  }
  async execute(operation: VisionDeviceOperation, context: VisionDeviceContext, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ operation, context: structuredClone(context), inputs: structuredClone(inputs) });
    if (this.reply) return this.reply(operation, inputs);
    if (operation === 'probe') return { facts: { sensorModel: 'IMX415', mipiLanes: 4 } };
    if (operation === 'pipeline_validate' || operation === 'bringup') return { passed: true, checks: [{ name: 'fixture-media-link', passed: true }] };
    if (operation === 'capture_raw') return { filename: 'captured.raw', metadata: { ...metadata, scene: inputs.scene }, contentBase64: raw.toString('base64'), sha256: hash(raw) };
    if (operation === 'process_raw') {
      const readbackHash = this.load(inputs); const input = inputs.raw as { contentBase64: string; sha256: string };
      const rawHash = hash(Buffer.from(input.contentBase64, 'base64')); assert.equal(rawHash, input.sha256);
      return { filename: 'processed.png', mimeType: 'image/png', contentBase64: png().toString('base64'), sha256: hash(png()), rawHash, tuningHash: readbackHash, readbackHash };
    }
    const readbackHash = this.load(inputs);
    return { appliedHash: readbackHash, readbackHash };
  }
}
let server: Server; let origin: string; let dir: string; let service: VisionWorkshopService; let adapter: FixtureAdapter; let registry: VisionDeviceRegistry; let router: Router;
let saved: Record<string, string | undefined>; let enabled: boolean;
let generate: (input: VisionModelInput) => Promise<VisionIspCandidate>; let modelCalls: VisionModelInput[];
let debugPlan: (input: VisionAiDebugInput) => Promise<VisionAiDebugDecision>;
beforeEach(async () => {
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: (req) => { const id = req.header('x-fixture-user'); return id ? { id, email: 'shared@example.invalid' } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await mkdtemp(join(tmpdir(), 'd-obs-vision-routes-')); service = new VisionWorkshopService({ dataDir: dir });
  adapter = new FixtureAdapter(); registry = new VisionDeviceRegistry([adapter]); enabled = true; modelCalls = [];
  generate = async () => structuredClone(defaultProposal);
  debugPlan = async () => ({ source: 'model', model: 'explicit-vision-fixture', modelInput: 'camera_images_controls_and_history', action: 'keep', notes: '仅为HTTP协议测试的明确模型fixture', assessment: { improved: false, sceneUsable: true, goalSatisfied: false, issue: 'acceptable', reason: '保留原始参数' }, done: true });
  const app = express(); app.use(express.json({ limit: '2mb' })); router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => enabled, generateCandidate: async (input) => { modelCalls.push(structuredClone(input)); return generate(input); }, planDebug: input => debugPlan(input) });
  app.use('/prefix', router); app.use(router); server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (dir) await rm(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  resetObservabilityAccessAdapter();
});
function headers(actor = 'alice') { return { 'content-type': 'application/json', 'x-fixture-user': actor, 'x-rdk-ops-action': 'observability' }; }
async function post(suffix: string, body: unknown, actor = 'alice', extra: Record<string, string> = {}) { return fetch(origin + API + suffix, { method: 'POST', headers: { ...headers(actor), ...extra }, body: JSON.stringify(body) }); }
async function get(suffix: string, actor = 'alice') { return fetch(origin + API + suffix, { headers: headers(actor) }); }
async function expectJson(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function create(extra: Record<string, unknown> = {}, actor = 'alice'): Promise<VisionExperiment> { return (await expectJson(await post('/experiments', { title: 'Sony IMX415 调优', goal: '改善逆光暗部细节', ...extra }, actor), 201)).experiment; }
async function upload(experimentId: string, bytes = raw, info = metadata): Promise<VisionRawSample> {
  const response = await fetch(origin + API + '/experiments/' + experimentId + '/samples', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-vision-sample': encodeURIComponent(JSON.stringify(info)) }, body: bytes });
  return (await expectJson(response, 201)).sample;
}
async function prepared(extra: Record<string, unknown> = {}) {
  const experiment = await create(extra);
  await expectJson(await post('/experiments/' + experiment.id + '/baseline', baseline));
  const sample = await upload(experiment.id);
  return { experiment, sample };
}
async function candidate(experimentId: string): Promise<VisionCandidate> { return (await expectJson(await post('/experiments/' + experimentId + '/candidates', {}), 201)).candidate; }
async function rpc(body: unknown, actor = 'alice', extra: Record<string, string> = {}) { return fetch(origin + MCP, { method: 'POST', headers: { ...headers(actor), ...extra }, body: JSON.stringify(body) }); }
function call(operationId: string, body: Record<string, unknown> = {}, params?: Record<string, string>, messageId = 1) { return { jsonrpc: '2.0', id: messageId, method: 'tools/call', params: { name: 'vision_workshop_execute', arguments: { operationId, body, ...(params ? { params } : {}) } } }; }
function unzipStored(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18); const nameSize = bytes.readUInt16LE(offset + 26); const extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameSize); const start = offset + 30 + nameSize + extraSize; const data = bytes.subarray(start, start + size);
    assert.equal(visionCrc32(data), bytes.readUInt32LE(offset + 14)); files.set(name, data); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50); return files;
}

test('experiment readiness is account-scoped persisted evidence and never calls an adapter', async () => {
  const experiment = await create({ targetId: adapter.profile.id });
  const response = await expectJson(await get('/experiments/' + experiment.id + '/readiness'));
  assert.equal(response.readiness.target.configured, true);
  assert.equal(response.readiness.stages.find((stage: any) => stage.id === 'connection').status, 'configured');
  assert.equal(response.readiness.hardwareVerification, 'unverified');
  assert.equal(adapter.calls.length, 0);
  assert.equal((await get('/experiments/' + experiment.id + '/readiness', 'bob')).status, 404);
  const mcp = await expectJson(await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vision_camera_readiness', arguments: { experimentId: experiment.id } } }));
  assert.equal(mcp.result.isError, false);
  assert.equal(adapter.calls.length, 0);
});

test('baseline typed schema advertises the actual native rule limit and canonical precision', async () => {
  const list = await expectJson(await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' }));
  const schema = list.result.tools.find((tool: any) => tool.name === 'vision_tuning_baseline_import').inputSchema;
  assert.equal(schema.properties.rules.maxItems, 128);
  assert.deepEqual(schema.properties.rules.items.properties.precision.enum, ['float32', 'seconds-float32-us']);
  const experiment = await create();
  const config = Object.fromEntries(Array.from({ length: 128 }, (_, index) => ['p' + index, Math.fround(.25)]));
  const rules = Object.keys(config).map(key => ({ path: '/' + key, label: key, min: 0, max: 1, precision: 'float32' }));
  const call = await expectJson(await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'vision_tuning_baseline_import', arguments: { experimentId: experiment.id, config, rules } } }));
  assert.equal(call.result.isError, false);
  assert.equal((await service.getExperiment('sso:alice', experiment.id)).baseline?.rules.length, 128);
  assert.equal(adapter.calls.length, 0);
});

test('vision HTTP and MCP require current admin identity and protected mutation intent', async () => {
  for (const suffix of ['/capabilities', '/experiments']) {
    for (const auth of [{}, { 'x-admin-token': 'wrong' }, { 'x-fixture-user': 'outsider' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) assert.equal((await fetch(origin + API + suffix, { headers: auth })).status, 403);
  }
  const caps = await expectJson(await fetch(origin + '/prefix' + API + '/capabilities', { headers: headers() }));
  assert.equal(caps.bringup.status, 'available'); assert.equal(caps.modelEnabled, true);
  assert.deepEqual(new Set(caps.atomicOperations), new Set(listPlatformOperations(router).map(operation => operation.id)));
  assert.ok(caps.atomicOperations.includes('POST ' + API + '/experiments/:id/calibration/tasks'));
  const bearer = await expectJson(await fetch(origin + API + '/capabilities', { headers: { 'x-admin-token': 'fixture-admin' } })); assert.equal(bearer.contract, 'rdk.vision-workshop.v1');
  assert.equal((await fetch(origin + API + '/experiments', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': 'alice' }, body: JSON.stringify({ title: 'test', goal: 'test' }) })).status, 400);
  assert.equal((await post('/experiments', { title: 'test', goal: 'test' }, 'alice', { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('/experiments', { title: 'test', goal: 'test' }, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
  assert.equal((await fetch(origin + MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 403);
  for (const extra of [{ owner: 'bob' }, { command: 'uname' }, { host: '1.2.3.4' }, { source: 'runner' }]) assert.equal((await post('/experiments', { title: 'test', goal: 'test', ...extra })).status, 400);
  assert.equal(adapter.calls.length, 0); assert.equal((await service.listExperiments('sso:alice')).length, 0);
});

test('vision HTTP completes real bytes → Raw preview → controlled model → evaluated tuning and validated ZIP', async () => {
  const { experiment, sample } = await prepared();
  assert.equal(sample.source, 'uploaded'); assert.equal(sample.hash, hash(raw));
  const analysis = await expectJson(await get('/experiments/' + experiment.id + '/samples/' + sample.id));
  assert.equal(analysis.statistics.sampleCount, 8); assert.equal(analysis.preview.kind, 'raw-bayer-preview'); assert.match(analysis.preview.label, /非 ISP/);
  const preview = await get('/experiments/' + experiment.id + '/samples/' + sample.id + '/preview.png'); assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type')!, /image\/png/);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.deepEqual(Buffer.from(await (await get('/experiments/' + experiment.id + '/samples/' + sample.id + '/download')).arrayBuffer()), raw);
  const proposed = await candidate(experiment.id); assert.equal(proposed.source, 'model'); assert.equal(proposed.model, 'fixture-vision-model'); assert.equal(proposed.verification, 'unverified');
  assert.deepEqual(proposed.sampleHashes, [sample.hash]); assert.equal(modelCalls.length, 1); assert.ok(!JSON.stringify(modelCalls[0]).includes('contentBase64'));
  assert.equal((await post('/experiments/' + experiment.id + '/selection', { candidateId: proposed.id })).status, 409);
  const resultResponse = await fetch(origin + API + '/experiments/' + experiment.id + '/results', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-vision-result': encodeURIComponent(JSON.stringify({ sampleId: sample.id, candidateId: proposed.id, mimeType: 'image/png', filename: 'actual.png' })) }, body: png() });
  const image = (await expectJson(resultResponse, 201)).image; assert.equal(image.source, 'uploaded'); assert.equal(image.verification, 'unverified');
  const evaluation = (await expectJson(await post('/experiments/' + experiment.id + '/evaluations', { imageId: image.id, rating: 4, notes: '暗部细节更清楚，真机视频待验收' }), 201)).evaluation; assert.equal(evaluation.source, 'manual');
  await expectJson(await post('/experiments/' + experiment.id + '/selection', { candidateId: proposed.id }));
  const tuningResponse = await get('/experiments/' + experiment.id + '/tuning'); assert.equal(tuningResponse.headers.get('x-vision-verification'), 'unverified'); assert.deepEqual(await tuningResponse.json(), { denoise: { strength: 3 } });
  const zipResponse = await get('/experiments/' + experiment.id + '/bundle?includeRaw=1'); assert.equal(zipResponse.status, 200); assert.match(zipResponse.headers.get('content-disposition')!, /\.zip/);
  const files = unzipStored(Buffer.from(await zipResponse.arrayBuffer())); assert.deepEqual(files.get('raw/' + sample.id + '.raw'), raw); assert.deepEqual(files.get('images/' + image.id + '.png'), png());
  assert.deepEqual(JSON.parse(files.get('candidate_tuning.json')!.toString()), proposed.tuning); assert.match(files.get('handbook.md')!.toString(), /未获得完整.*画质验收/);
  const manifest = JSON.parse(files.get('manifest.json')!.toString()); assert.equal(manifest.provenance.boardValidation, 'unavailable'); assert.equal(manifest.experiment.selectedCandidateId, proposed.id);
});

test('vision uploads reject forged source, unknown metadata, caller addresses and falsely labelled images', async () => {
  const experiment = await create(); const suffix = '/experiments/' + experiment.id;
  for (const extra of [{ source: 'runner' }, { adapterId: 'x5-imx415' }, { owner: 'bob' }, { command: 'capture_raw' }]) {
    const forged = await fetch(origin + API + suffix + '/samples', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-vision-sample': encodeURIComponent(JSON.stringify({ ...metadata, ...extra })) }, body: raw });
    assert.equal(forged.status, 400);
    assert.equal((await post(suffix + '/samples', { metadata: { ...metadata, ...extra }, contentBase64: raw.toString('base64') })).status, 400);
  }
  const sample = await upload(experiment.id);
  for (const body of [{ sampleId: sample.id, source: 'runner', contentBase64: png().toString('base64') }, { sampleId: sample.id, mimeType: 'image/jpeg', contentBase64: png().toString('base64') }, { sampleId: sample.id, mimeType: 'image/png', contentBase64: Buffer.from('<svg/>').toString('base64') }]) assert.equal((await post(suffix + '/results', body)).status, 400);
  assert.equal((await post(suffix + '/samples', { metadata, contentBase64: 'AA=A' })).status, 400);
  const forgedCommand = await post(suffix + '/device/probe', { targetId: 'http://evil.invalid', command: 'uname', host: 'evil.invalid' }); assert.equal(forgedCommand.status, 400);
  assert.equal(adapter.calls.length, 0);
});

test('vision model failures and changed baseline versions do not leave a candidate or consume invalid evidence', async () => {
  const { experiment } = await prepared(); const suffix = '/experiments/' + experiment.id;
  enabled = false; assert.equal((await post(suffix + '/candidates', {})).status, 503); assert.equal(modelCalls.length, 0); enabled = true;
  generate = async () => { throw new Error('fixture upstream with private details'); }; const failed = await post(suffix + '/candidates', {}); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private details/);
  generate = async () => ({ ...defaultProposal, patches: [{ path: '/invented', value: 5, reason: 'fake' }] }); assert.equal((await post(suffix + '/candidates', {})).status, 400);
  let begin!: () => void; const started = new Promise<void>((resolve) => { begin = resolve; }); let finish!: (candidate: VisionIspCandidate) => void;
  generate = async () => { begin(); return new Promise<VisionIspCandidate>((resolve) => { finish = resolve; }); };
  const pending = post(suffix + '/candidates', {}); await started;
  // Even with identical tuning bytes, changing rules creates a new baseline.
  await expectJson(await post(suffix + '/baseline', { ...baseline, rules: [{ ...baseline.rules[0], max: 9 }] }));
  finish(defaultProposal); const changed = await pending; assert.equal(changed.status, 409); assert.equal((await changed.json() as { error: string }).error, 'vision_baseline_changed');
  assert.equal((await expectJson(await get(suffix))).experiment.candidates.length, 0);
});

test('vision REST, downloads and MCP cannot operate on another SSO account with the same email', async () => {
  const { experiment, sample } = await prepared({ targetId: adapter.profile.id }); const proposed = await candidate(experiment.id); const suffix = '/experiments/' + experiment.id;
  for (const path of ['', '/samples/' + sample.id, '/samples/' + sample.id + '/preview.png', '/samples/' + sample.id + '/download', '/tuning?candidateId=' + proposed.id, '/bundle?includeRaw=1']) assert.equal((await get(suffix + path, 'bob')).status, 404);
  for (const [path, body] of [['/baseline', baseline], ['/candidates', {}], ['/device/probe', {}], ['/selection', { candidateId: proposed.id }]] as const) assert.equal((await post(suffix + path, body, 'bob')).status, 404);
  assert.equal((await expectJson(await get('/experiments', 'bob'))).experiments.length, 0);
  const read = await expectJson(await rpc(call('GET ' + API + '/experiments/:id', {}, { id: experiment.id }), 'bob')); assert.equal(read.result.isError, true); assert.match(read.result.content[0].text, /404/);
  assert.equal(adapter.calls.length, 0);
});

test('vision SDK atomic operations archive actual receipts and assets while candidate quality stays unverified', async () => {
  const experiment = await create({ targetId: adapter.profile.id }); assert.equal(experiment.sdkVersion, 'fixture-sdk'); const suffix = '/experiments/' + experiment.id;
  for (const operation of ['probe', 'pipeline_validate', 'bringup']) { const result = await expectJson(await post(suffix + '/device/' + operation, {})); assert.equal(result.deviceRun.status, 'completed'); assert.ok(result.deviceRun.evidence.jobId); }
  await expectJson(await post(suffix + '/baseline', baseline));
  const capture = await expectJson(await post(suffix + '/device/capture_raw', { scene: '逆光' })); assert.equal(capture.asset.source, 'runner'); assert.equal(capture.asset.adapterId, adapter.profile.id); assert.equal(capture.deviceRun.sampleId, capture.asset.id); assert.ok(!JSON.stringify(capture).includes('contentBase64'));
  const proposed = await candidate(experiment.id);
  const process = await expectJson(await post(suffix + '/device/process_raw', { sampleId: capture.asset.id, candidateId: proposed.id })); assert.equal(process.asset.source, 'runner'); assert.equal(process.deviceRun.sampleId, capture.asset.id); assert.equal(process.deviceRun.candidateId, proposed.id);
  const sent = adapter.calls.find((item) => item.operation === 'process_raw')!.inputs.raw as Record<string, unknown>; assert.equal(sent.sha256, hash(raw)); assert.equal(sent.contentBase64, raw.toString('base64'));
  const apply = await expectJson(await post(suffix + '/device/apply_tuning', { candidateId: proposed.id })); assert.equal(apply.result.readbackHash, proposed.hash);
  const stored = (await expectJson(await get(suffix))).experiment; assert.equal(stored.deviceRuns.length, 6); assert.equal(stored.candidates[0].verification, 'unverified');
  const manifest = await service.exportManifest('sso:alice', experiment.id); assert.equal(manifest.provenance.boardValidation, 'parameters_applied_quality_unverified');
  const handbook = await service.exportHandbook('sso:alice', experiment.id); assert.equal(handbook.stages[0]?.status, 'recorded'); assert.equal(handbook.stages.at(-1)?.status, 'recorded');
});

test('vision failed SDK checks preserve their actual failure rather than claiming successful bring-up', async () => {
  const experiment = await create({ targetId: adapter.profile.id }); const suffix = '/experiments/' + experiment.id;
  adapter.reply = () => ({ passed: false, checks: [{ name: 'mipi-link', passed: false, reason: 'no signal' }] });
  for (const operation of ['pipeline_validate', 'bringup']) {
    const response = await expectJson(await post(suffix + '/device/' + operation, {}), 422);
    assert.equal(response.error, 'vision_device_checks_failed'); assert.equal(response.deviceRun.status, 'failed'); assert.equal(response.deviceRun.evidence.result.passed, false); assert.equal(response.result.checks[0].reason, 'no signal');
  }
  assert.equal((await service.getExperiment('sso:alice', experiment.id)).deviceRuns.length, 2);
  adapter.reply = () => ({ facts: {} }); assert.equal((await post(suffix + '/device/probe', {})).status, 502);
  assert.equal((await service.exportHandbook('sso:alice', experiment.id)).stages[0]?.status, 'unavailable');
});

test('vision device receipts reject tampered Raw and mismatched application readback without granting proof', async () => {
  const { experiment, sample } = await prepared({ targetId: adapter.profile.id }); const suffix = '/experiments/' + experiment.id; const proposed = await candidate(experiment.id);
  adapter.reply = () => ({ filename: 'capture.raw', metadata, contentBase64: raw.toString('base64'), sha256: '0'.repeat(64) });
  const badCapture = await expectJson(await post(suffix + '/device/capture_raw', { scene: '逆光' }), 502); assert.equal(badCapture.error, 'vision_device_artifact_hash_mismatch'); assert.equal((await service.getExperiment('sso:alice', experiment.id)).samples.length, 1);
  adapter.reply = () => ({ appliedHash: proposed.hash, readbackHash: 'different' }); const badApply = await expectJson(await post(suffix + '/device/apply_tuning', { candidateId: proposed.id }), 502); assert.equal(badApply.error, 'vision_device_readback_mismatch');
  const state = await service.getExperiment('sso:alice', experiment.id); assert.ok(state.deviceRuns.every((run) => run.status === 'failed')); assert.equal((await service.exportManifest('sso:alice', experiment.id)).provenance.boardValidation, 'unavailable');
  await writeFile(join(dir, 'assets', sample.id + '.raw'), Buffer.alloc(raw.length));
  const beforeCalls = adapter.calls.length; assert.equal((await post(suffix + '/device/process_raw', { sampleId: sample.id, candidateId: proposed.id })).status, 503); assert.equal(adapter.calls.length, beforeCalls);
});

test('RAW replay receipts must bind the actual input and independently read tuning state', async () => {
  const { experiment, sample } = await prepared({ targetId: adapter.profile.id }); const proposed = await candidate(experiment.id);
  for (const field of ['rawHash', 'tuningHash', 'readbackHash']) {
    adapter.reply = () => ({ filename: 'processed.png', mimeType: 'image/png', contentBase64: png().toString('base64'), sha256: hash(png()), rawHash: sample.hash, tuningHash: proposed.hash, readbackHash: proposed.hash, [field]: '0'.repeat(64) });
    const rejected = await expectJson(await post('/experiments/' + experiment.id + '/device/process_raw', { sampleId: sample.id, candidateId: proposed.id }), 502);
    assert.equal(rejected.error, 'vision_device_replay_witness_mismatch');
  }
  const state = await service.getExperiment('sso:alice', experiment.id);
  assert.equal(state.processedImages.length, 0); assert.ok(state.deviceRuns.every(run => run.status === 'failed'));
});

test('vision adapter Sensor/SDK mismatches and absent capabilities fail before execution', async () => {
  assert.equal((await post('/experiments', { title: 'bad', goal: 'bad', targetId: adapter.profile.id, sensorModel: 'IMX219' })).status, 409);
  for (const identity of [{ sdkVersion: 'other-sdk' }, { board: 'other-board' }, { cameraMode: 'unconfigured-mode' }, { cameraInterface: 'unconfigured-interface' }]) assert.equal((await post('/experiments', { title: 'bad', goal: 'bad', targetId: adapter.profile.id, ...identity })).status, 409);
  assert.equal(adapter.calls.length, 0);
  registry = new VisionDeviceRegistry([]); const caps = await expectJson(await get('/capabilities')); assert.equal(caps.apply.status, 'unavailable'); assert.equal(caps.capture.status, 'unavailable');
  const manual = await create(); assert.equal((await post('/experiments/' + manual.id + '/device/probe', {})).status, 409);
});

test('public atomics are camera neutral and do not invent an unbound camera identity', async () => {
  const experiment = await create();
  for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode']) assert.equal((experiment as unknown as Record<string, unknown>)[field], undefined);
  const caps = await expectJson(await get('/capabilities'));
  assert.equal(caps.board, undefined); assert.equal(caps.sensorVendor, undefined); assert.ok(caps.supportedFormats);
  const explicit = await create({ board: 'Fixture Board B', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'fixture-b', cameraInterface: 'MIPI CSI-2', cameraMode: 'fixture-mode-b' });
  assert.equal(explicit.sensorVendor, 'OmniVision'); assert.equal(explicit.sensorModel, 'OV5647'); assert.equal(explicit.cameraMode, 'fixture-mode-b');
  const suffix = '/experiments/' + explicit.id;
  await expectJson(await post(suffix + '/baseline', baseline)); await upload(explicit.id); await candidate(explicit.id);
  assert.deepEqual(modelCalls.at(-1)!.cameraContext, { board: explicit.board, sensorVendor: explicit.sensorVendor, sensorModel: explicit.sensorModel, sdkVersion: explicit.sdkVersion, cameraInterface: explicit.cameraInterface, cameraMode: explicit.cameraMode });
  assert.equal((await post(suffix + '/candidates', { cameraContext: { sensorModel: 'IMX415' } })).status, 400);
});

test('two camera profiles reuse the identical REST sequence with different Raw layouts and ISP parameter schemas', async () => {
  const packed = Buffer.from([25, 50, 75, 100, 0, 125, 150, 175, 200, 0]);
  const fixtures: Array<{ profile: VisionDeviceProfile; metadata: VisionRawMetadata; data: Buffer; config: Record<string, unknown>; path: string; value: number }> = [
    { profile: { id: 'fixture-camera-a', label: 'Sony fixture A', board: 'RDK X5', sensorVendor: 'Sony', sensorModel: 'IMX415', sdkVersion: 'fixture-a', cameraInterface: 'MIPI CSI-2', cameraMode: 'fixture-mode-a', operations: [...VISION_DEVICE_OPERATIONS] }, metadata, data: raw, config: { denoise: { strength: 2 } }, path: '/denoise/strength', value: 3 },
    { profile: { id: 'fixture-camera-b', label: 'OmniVision fixture B', board: 'Fixture Board B', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'fixture-b', cameraInterface: 'MIPI CSI-2', cameraMode: 'fixture-mode-b', operations: [...VISION_DEVICE_OPERATIONS] }, metadata: { ...metadata, bayer: 'BGGR', packing: 'mipi-raw10', stride: 5 }, data: packed, config: { tone: { gammaGain: 1.1 } }, path: '/tone/gammaGain', value: 1.4 },
  ];
  const contexts: VisionDeviceContext[] = [];
  registry = new VisionDeviceRegistry(fixtures.map(fixture => {
    let actualTuning = structuredClone(fixture.config);
    const load = (inputs: Record<string, unknown>) => {
      assert.equal(hash(Buffer.from(JSON.stringify(inputs.tuning))), inputs.tuningHash);
      actualTuning = structuredClone(inputs.tuning as Record<string, unknown>);
      return hash(Buffer.from(JSON.stringify(structuredClone(actualTuning))));
    };
    return { profile: fixture.profile, execute: async (operation, context, inputs) => {
    contexts.push(structuredClone(context));
    if (operation === 'probe') return { facts: { board: context.board, sensorVendor: context.sensorVendor, sensorModel: context.sensorModel, cameraMode: context.cameraMode } };
    if (operation === 'pipeline_validate' || operation === 'bringup') return { passed: true, checks: [{ name: 'fixture-only', passed: true }] };
    if (operation === 'capture_raw') return { filename: 'capture.raw', metadata: { ...fixture.metadata, scene: inputs.scene }, contentBase64: fixture.data.toString('base64'), sha256: hash(fixture.data) };
    if (operation === 'process_raw') { const bytes = png(4, 2, contexts.length % 2 ? 64 : 128); const readbackHash = load(inputs);
      const source = inputs.raw as { contentBase64: string; sha256: string }; const rawHash = hash(Buffer.from(source.contentBase64, 'base64')); assert.equal(rawHash, source.sha256);
      return { filename: 'result.png', mimeType: 'image/png', contentBase64: bytes.toString('base64'), sha256: hash(bytes), rawHash, tuningHash: readbackHash, readbackHash }; }
    const readbackHash = load(inputs); return { appliedHash: readbackHash, readbackHash };
  } }; }));
  for (const fixture of fixtures) {
    const experiment = await create({ targetId: fixture.profile.id }); const suffix = '/experiments/' + experiment.id;
    for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const) assert.equal(experiment[field], fixture.profile[field]);
    await expectJson(await post(suffix + '/baseline', { config: fixture.config, rules: [{ path: fixture.path, label: 'fixture numeric parameter', min: 0, max: 10 }] }));
    for (const operation of ['probe', 'pipeline_validate', 'bringup']) await expectJson(await post(suffix + '/device/' + operation, {}));
    const capture = await expectJson(await post(suffix + '/device/capture_raw', { scene: 'fixture controlled scene' })); const sample = capture.asset;
    assert.equal(sample.source, 'runner'); assert.equal(sample.metadata.packing, fixture.metadata.packing);
    generate = async () => ({ ...defaultProposal, patches: [{ path: fixture.path, value: fixture.value, reason: 'fixture only' }] });
    const proposed = await candidate(experiment.id); assert.equal(proposed.patches[0].path, fixture.path); assert.equal(modelCalls.at(-1)!.cameraContext!.sensorModel, fixture.profile.sensorModel);
    const before = await expectJson(await post(suffix + '/device/process_raw', { sampleId: sample.id }));
    const after = await expectJson(await post(suffix + '/device/process_raw', { sampleId: sample.id, candidateId: proposed.id }));
    const comparison = await expectJson(await post(suffix + '/comparisons', { baselineImageId: before.asset.id, candidateImageId: after.asset.id }), 201); assert.equal(comparison.comparison.source, 'computed');
    await expectJson(await post(suffix + '/evaluations', { imageId: after.asset.id, rating: 4, notes: 'fixture visual observation' }), 201);
    await expectJson(await post(suffix + '/selection', { candidateId: proposed.id })); await expectJson(await post(suffix + '/device/apply_tuning', { candidateId: proposed.id }));
    const bundle = await get(suffix + '/bundle?includeRaw=1'); assert.equal(bundle.status, 200); const files = unzipStored(Buffer.from(await bundle.arrayBuffer()));
    const manifest = JSON.parse(files.get('manifest.json')!.toString()); assert.equal(manifest.experiment.sensorModel, fixture.profile.sensorModel); assert.equal(manifest.experiment.comparisons.length, 1); assert.equal(manifest.experiment.candidates[0].verification, 'unverified');
    assert.match(files.get('handbook.md')!.toString(), new RegExp(fixture.profile.sensorModel)); assert.deepEqual(files.get('raw/' + sample.id + '.raw'), fixture.data);
    assert.ok(contexts.filter(context => context.experimentId === experiment.id).every(context => context.board === fixture.profile.board && context.sensorModel === fixture.profile.sensorModel && context.cameraMode === fixture.profile.cameraMode));
  }
});

test('vision MCP exposes reviewed typed atomic operations and preserves direct HTTP guards', async () => {
  const declarations = listPlatformOperations(router); assert.deepEqual(new Set(declarations.map(row => row.id)), new Set([...Object.keys(VISION_WORKSHOP_OPERATIONS), ...Object.keys(VISION_CALIBRATION_OPERATIONS)])); assert.ok(declarations.every((operation) => operation.tenantAccessible === false)); assert.ok(declarations.some((operation) => operation.id.endsWith('/device/apply_tuning') && operation.mutating));
  const tools = await expectJson(await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })); const names = tools.result.tools.map((tool: { name: string }) => tool.name); for (const name of ['vision_workshop_capabilities', 'vision_workshop_execute', 'vision_camera_probe', 'vision_pipeline_validate', 'vision_camera_bringup', 'vision_raw_capture', 'vision_isp_generate', 'vision_isp_process_raw', 'vision_isp_apply', 'vision_image_evaluate', 'vision_image_compare', 'vision_workshop_export']) assert.ok(names.includes(name));
  const catalog = await expectJson(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vision_workshop_capabilities', arguments: {} } })); const operationList = JSON.parse(catalog.result.content[0].text).operations; assert.equal(operationList.length, declarations.length);
  const createArgs = call('POST ' + API + '/experiments', { title: 'MCP 创建实验', goal: '测试原子工具', targetId: adapter.profile.id });
  const created = await expectJson(await rpc(createArgs)); assert.equal(created.result.isError, false); const experiment = JSON.parse(created.result.content[0].text).data.experiment;
  const probe = await expectJson(await rpc(call('POST ' + API + '/experiments/:id/device/probe', {}, { id: experiment.id }))); assert.equal(probe.result.isError, false); assert.equal(adapter.calls.length, 1);
  const typed = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
  const typedProbe = await expectJson(await rpc(typed('vision_camera_probe', { experimentId: experiment.id }))); assert.equal(typedProbe.result.isError, false); assert.equal(adapter.calls.length, 2);
  const typedBad = await expectJson(await rpc(typed('vision_camera_probe', { experimentId: experiment.id, host: 'evil.invalid' }))); assert.equal(typedBad.result.isError, true); assert.equal(adapter.calls.length, 2);
  const typedReadOnly = await expectJson(await rpc(typed('vision_camera_probe', { experimentId: experiment.id }), 'alice', { 'x-rdk-ops-read-only': '1' })); assert.equal(typedReadOnly.result.isError, true); assert.match(typedReadOnly.result.content[0].text, /403/); assert.equal(adapter.calls.length, 2);
  for (const [name, input] of [
    ['vision_pipeline_validate', {}], ['vision_camera_bringup', {}], ['vision_raw_capture', { scene: '逆光' }], ['vision_isp_generate', {}],
    ['vision_isp_process_raw', { sampleId: 'sample' }], ['vision_isp_apply', { candidateId: 'candidate' }], ['vision_image_evaluate', { imageId: 'image', rating: 4, notes: 'manual' }],
    ['vision_image_compare', { baselineImageId: 'base-image', candidateImageId: 'candidate-image' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const denied = await expectJson(await rpc(typed(name, { experimentId: experiment.id, ...input }), 'alice', { 'x-rdk-ops-read-only': '1' })); assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /403/);
    const unknown = await expectJson(await rpc(typed(name, { experimentId: experiment.id, ...input, command: 'untrusted' }))); assert.equal(unknown.result.isError, true);
  }
  const exported = await expectJson(await rpc(typed('vision_workshop_export', { experimentId: experiment.id, includeRaw: false }), 'alice', { 'x-rdk-ops-read-only': '1' })); assert.equal(exported.result.isError, false); assert.match(JSON.parse(exported.result.content[0].text).data.downloadUrl, /\/bundle\?includeRaw=0$/);
  const readOnly = await expectJson(await rpc(call('POST ' + API + '/experiments/:id/device/probe', {}, { id: experiment.id }), 'alice', { 'x-rdk-ops-read-only': '1' })); assert.equal(readOnly.result.isError, true); assert.match(readOnly.result.content[0].text, /403/); assert.equal(adapter.calls.length, 2);
  const bad = await expectJson(await rpc(call('POST ' + API + '/experiments/:id/device/probe', { host: 'evil.invalid', command: 'shell' }, { id: experiment.id }))); assert.equal(bad.result.isError, true); assert.equal(adapter.calls.length, 2);
  const unrelated = await expectJson(await rpc(call('GET /api/ops/observability/tenants'))); assert.equal(unrelated.result.isError, true); assert.match(unrelated.result.content[0].text, /unknown_vision_operation/);
  const notification = { ...createArgs } as { id?: number }; delete notification.id; const response = await rpc(notification); assert.equal(response.status, 202); assert.equal((await service.listExperiments('sso:alice')).length, 1);
});

test('vision ZIP capabilities use the same current model and configured-adapter truth as discovery', async () => {
  const experiment = await create({ targetId: adapter.profile.id }); enabled = false;
  const capabilities = await expectJson(await get('/capabilities')); assert.equal(capabilities.candidateGeneration.status, 'unavailable'); assert.equal(capabilities.bringup.verification, 'configured-adapter');
  const files = unzipStored(Buffer.from(await (await get('/experiments/' + experiment.id + '/bundle')).arrayBuffer()));
  const manifest = JSON.parse(files.get('manifest.json')!.toString()); assert.equal(manifest.capabilities.modelEnabled, false); assert.equal(manifest.capabilities.candidateGeneration.status, 'unavailable'); assert.equal(manifest.capabilities.bringup.status, 'available'); assert.equal(manifest.capabilities.deviceAdapters[0].id, adapter.profile.id); assert.ok(!JSON.stringify(manifest.capabilities).includes('token'));
  assert.match(files.get('handbook.md')!.toString(), /配置存在不能代替设备探测/); assert.equal(adapter.calls.length, 0);
});

test('vision captures normal IMX415 4K frames from Base64 receipts and supports large binary imports', async () => {
  const largeMetadata: VisionRawMetadata = { ...metadata, width: 3840, height: 2160, stride: 7680, bitDepth: 12, whiteLevel: 4095 };
  const large = Buffer.alloc(largeMetadata.stride * largeMetadata.height);
  const experiment = await create({ targetId: adapter.profile.id });
  adapter.reply = () => ({ filename: 'imx415-4k.raw', metadata: largeMetadata, contentBase64: large.toString('base64'), sha256: hash(large) });
  const receipt = await expectJson(await post('/experiments/' + experiment.id + '/device/capture_raw', { scene: '逆光' })); assert.equal(receipt.asset.byteLength, 16_588_800); assert.equal(receipt.asset.hash, hash(large)); assert.equal(receipt.asset.source, 'runner');
  const uploaded = await upload(experiment.id, large, largeMetadata); assert.equal(uploaded.byteLength, large.length); assert.equal(uploaded.source, 'uploaded');
  const state = await service.getExperiment('sso:alice', experiment.id); assert.equal(state.samples.length, 2); assert.equal(state.bytesStored, large.length * 2);
});

test('vision comparisons compute server-side PNG metrics with immutable tuning and same-Raw provenance', async () => {
  const { experiment, sample } = await prepared(); const suffix = '/experiments/' + experiment.id; const proposed = await candidate(experiment.id);
  const before = (await expectJson(await post(suffix + '/results', { sampleId: sample.id, contentBase64: png().toString('base64') }), 201)).image;
  const after = (await expectJson(await post(suffix + '/results', { sampleId: sample.id, candidateId: proposed.id, contentBase64: png(4, 2, 255).toString('base64') }), 201)).image;
  assert.equal(before.tuningHash, proposed.baselineHash); assert.equal(after.tuningHash, proposed.hash);
  const comparisonInput = { baselineImageId: before.id, candidateImageId: after.id, roi: { x: 0, y: 0, width: 2, height: 2 } };
  const output = await expectJson(await post(suffix + '/comparisons', comparisonInput), 201);
  assert.equal(output.method, 'png-output-comparison'); assert.equal(output.comparison.source, 'computed'); assert.equal(output.comparison.metrics.baseline.meanLuma, 0); assert.equal(output.comparison.metrics.candidate.meanLuma, 1); assert.equal(output.comparison.metrics.delta.meanLuma, 1);
  assert.deepEqual(output.comparison.metrics.baseline.roi, comparisonInput.roi); assert.equal(output.comparison.baselineImageHash, before.hash); assert.equal(output.comparison.baselineTuningHash, proposed.baselineHash);
  assert.equal((await post(suffix + '/comparisons', { ...comparisonInput, metrics: { delta: { meanLuma: 99 } } })).status, 400);
  assert.equal((await post(suffix + '/comparisons', { baselineImageId: after.id, candidateImageId: before.id })).status, 409);
  const invalidRoi = await expectJson(await post(suffix + '/comparisons', { ...comparisonInput, roi: { x: 0, y: 0, width: 999, height: 2 } }), 400); assert.match(invalidRoi.error, /^vision_quality_/);
  assert.equal((await post(suffix + '/comparisons', comparisonInput, 'bob')).status, 404);
  const typed = await expectJson(await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vision_image_compare', arguments: { experimentId: experiment.id, ...comparisonInput } } })); assert.equal(typed.result.isError, false);
  const readOnly = await expectJson(await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vision_image_compare', arguments: { experimentId: experiment.id, ...comparisonInput } } }, 'alice', { 'x-rdk-ops-read-only': '1' })); assert.equal(readOnly.result.isError, true);
  const otherSample = await upload(experiment.id); const wrongRawBase = (await expectJson(await post(suffix + '/results', { sampleId: otherSample.id, contentBase64: png().toString('base64') }), 201)).image;
  assert.equal((await post(suffix + '/comparisons', { baselineImageId: wrongRawBase.id, candidateImageId: after.id })).status, 409);
  await expectJson(await post(suffix + '/baseline', { ...baseline, config: { denoise: { strength: 4 } } }));
  const wrongTuningBase = (await expectJson(await post(suffix + '/results', { sampleId: sample.id, contentBase64: png().toString('base64') }), 201)).image;
  assert.notEqual(wrongTuningBase.tuningHash, proposed.baselineHash);
  assert.equal((await post(suffix + '/comparisons', { baselineImageId: wrongTuningBase.id, candidateImageId: after.id })).status, 409);
  // Updating the current baseline cannot relabel old output images or metrics.
  assert.equal((await expectJson(await post(suffix + '/comparisons', comparisonInput), 201)).comparison.baselineTuningHash, proposed.baselineHash);
  const state = await service.getExperiment('sso:alice', experiment.id); assert.equal(state.comparisons.length, 3); assert.equal(state.processedImages.find((image) => image.id === before.id)?.tuningHash, proposed.baselineHash);
  const files = unzipStored(Buffer.from(await (await get(suffix + '/bundle')).arrayBuffer())); assert.equal(JSON.parse(files.get('manifest.json')!.toString()).experiment.comparisons.length, 3);
});

test('explicit camera fixture HTTP flow keeps preview and archived frames distinct from Raw and restores measured tuning', async () => {
  const experiment = await create({ targetId: adapter.profile.id });
  const savedBaseline = (await expectJson(await post('/experiments/' + experiment.id + '/baseline', baseline))).baseline;
  let activeHash = savedBaseline.hash;
  const controls = { exposureUs: { value: 1000, min: 100, max: 5000, step: 100, writable: true }, gain: { value: 2, min: 0, max: 8, step: 1, writable: true }, autoExposure: { value: false, writable: true } };
  adapter.reply = (operation, inputs) => {
    if (operation === 'preview_start') return { running: true, width: 4, height: 2, fps: 30 };
    if (operation === 'preview_stop') return { running: false };
    if (operation === 'controls_get') return { controls: structuredClone(controls) };
    if (operation === 'controls_set') { const values = inputs.values as any; for (const [key, value] of Object.entries(values)) (controls as any)[key].value = value; return { controls: structuredClone(controls) }; }
    if (operation === 'capture_frame' || operation === 'preview_frame') return { filename: 'fixture-camera.png', mimeType: 'image/png', contentBase64: png().toString('base64'), sha256: hash(png()), controls: structuredClone(controls), tuningHash: activeHash, capturedAt: '2026-10-13T00:00:00.000Z' };
    if (operation === 'apply_tuning' || operation === 'restore_tuning') { activeHash = String(inputs.tuningHash); return { appliedHash: activeHash, readbackHash: activeHash }; }
    return { facts: { source: 'protocol-fixture-only' } };
  };
  const route = '/experiments/' + experiment.id;
  await expectJson(await post(route + '/device/preview_start', {}));
  const preview = await expectJson(await post(route + '/device/preview_frame', {}));
  assert.deepEqual(Buffer.from(preview.frame.contentBase64, 'base64'), png());
  const first = (await expectJson(await post(route + '/device/capture_frame', { scene: '逆光' }))).asset;
  const state = (await expectJson(await get(route))).experiment;
  assert.equal(state.samples.length, 0); assert.equal(state.processedImages.length, 0); assert.equal(state.cameraFrames.length, 1);
  assert.equal(state.deviceRuns.length, 2); // Preview polling does not consume the durable ledger.
  assert.equal((await get(route + '/frames/' + first.id, 'bob')).status, 404);
  assert.deepEqual(Buffer.from(await (await get(route + '/frames/' + first.id)).arrayBuffer()), png());
  const observation = await expectJson(await get(route + '/frames/' + first.id + '/analysis?roi=' + encodeURIComponent(JSON.stringify({ x: 1, y: 0, width: 2, height: 2 }))));
  assert.equal(observation.inputKind, 'processed-camera-frame'); assert.equal(observation.statistics.pixelCount, 4);
  assert.equal((await get(route + '/frames/' + first.id + '/analysis?roi=' + encodeURIComponent(JSON.stringify({ x: 0, y: 0, width: 100, height: 100 })))).status, 400);
  assert.equal((await post(route + '/device/controls_set', { values: { exposureUs: 1050 } })).status, 409);
  const set = await expectJson(await post(route + '/device/controls_set', { values: { exposureUs: 1200, autoExposure: true } })); assert.equal(set.result.controls.exposureUs.value, 1200);
  generate = async modelInput => { assert.equal(modelInput.rawStatistics, undefined); assert.ok(Array.isArray(modelInput.frameStatistics)); return { ...structuredClone(defaultProposal), modelInput: 'processed_frame_statistics_and_baseline' }; };
  const generated = await candidate(experiment.id);
  assert.deepEqual(generated.sampleIds, []); assert.deepEqual(generated.frameIds, [first.id]);
  assert.equal((await post(route + '/device/capture_frame', { candidateId: generated.id })).status, 409);
  await expectJson(await post(route + '/device/apply_tuning', { candidateId: generated.id }));
  const after = (await expectJson(await post(route + '/device/capture_frame', { scene: '逆光候选', candidateId: generated.id }))).asset;
  await expectJson(await post(route + '/evaluations', { imageId: after.id, rating: 4, notes: '人工观察实际相机帧；不同采集输入' }), 201);
  await expectJson(await post(route + '/selection', { candidateId: generated.id }));
  const restored = await expectJson(await post(route + '/device/restore_tuning', { baselineId: savedBaseline.id })); assert.equal(restored.result.readbackHash, savedBaseline.hash);
  await expectJson(await post(route + '/device/preview_stop', {}));
  const bundle = unzipStored(Buffer.from(await (await get(route + '/bundle')).arrayBuffer()));
  assert.deepEqual(bundle.get('frames/' + first.id + '.png'), png()); assert.ok(bundle.has('candidate_tuning.json'));
  assert.equal((await post(route + '/device/restore_tuning', { baselineId: savedBaseline.id, candidateId: generated.id })).status, 400);
});

test('frame candidate evidence uses newest matching PNG settings and preserves selectable history', async () => {
  const experiment = await create({ targetId: adapter.profile.id });
  const initial = (await expectJson(await post('/experiments/' + experiment.id + '/baseline', baseline))).baseline;
  const oldFrame = await service.addCameraFrame('sso:alice', experiment.id, { mimeType: 'image/png', adapterId: adapter.profile.id, tuningHash: initial.hash }, png());
  const latest = (await expectJson(await post('/experiments/' + experiment.id + '/baseline', { ...baseline, config: { denoise: { strength: 4 } } }))).baseline;
  const missing = await expectJson(await post('/experiments/' + experiment.id + '/candidates', {}), 409);
  assert.equal(missing.error, 'vision_matching_frame_required'); assert.equal(modelCalls.length, 0);
  const frames = [];
  for (let index = 0; index < 17; index++) frames.push(await service.addCameraFrame('sso:alice', experiment.id, { mimeType: 'image/png', adapterId: adapter.profile.id, tuningHash: latest.hash }, png()));
  generate = async input => { assert.equal(input.rawStatistics, undefined); return { ...structuredClone(defaultProposal), modelInput: 'processed_frame_statistics_and_baseline' }; };
  const selected = await candidate(experiment.id);
  assert.deepEqual(selected.frameIds, frames.slice(-16).map(frame => frame.id));
  assert.equal((modelCalls[0].frameStatistics as any[]).length, 16);
  const exact = (await expectJson(await post('/experiments/' + experiment.id + '/candidates', { frameIds: [frames[0].id] }), 201)).candidate;
  assert.deepEqual(exact.frameIds, [frames[0].id]);
  assert.equal((await post('/experiments/' + experiment.id + '/candidates', { frameIds: [oldFrame.id] })).status, 409);
  assert.equal((await post('/experiments/' + experiment.id + '/candidates', { frameIds: [frames[0].id, frames[0].id] })).status, 400);
  const state = (await expectJson(await get('/experiments/' + experiment.id))).experiment;
  assert.equal(state.cameraFrames.length, 18); assert.equal(state.candidates.length, 2);
});

test('AI-native HTTP start preserves action guard, account isolation, async progress and true frame-ledger authority', async () => {
  const experiment = await create({ targetId: adapter.profile.id });
  const route = '/experiments/' + experiment.id;
  const controls = { gamma: { value: 100, min: 72, max: 500, step: 1, writable: true, active: true } };
  const config = () => ({ kind: 'explicit-fixture-controls', controls: { gamma: controls.gamma.value } });
  adapter.reply = (operation, inputs) => {
    if (operation === 'probe') return { facts: { fixture: true }, baseline: { config: config(), rules: [{ path: '/controls/gamma', label: 'gamma', min: 72, max: 500, step: 1 }] } };
    if (operation === 'controls_get') return { controls: structuredClone(controls) };
    if (operation === 'restore_tuning') return { appliedHash: inputs.tuningHash, readbackHash: inputs.tuningHash };
    return { filename: 'actual-fixture.png', mimeType: 'image/png', contentBase64: png().toString('base64'), sha256: hash(png()), controls: structuredClone(controls), tuningHash: hash(Buffer.from(JSON.stringify(config()))) };
  };
  const body = { goal: '观察真实画面并自主调试', maxRounds: 1 };
  assert.equal((await post(route + '/ai-debug', body, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
  assert.equal((await post(route + '/ai-debug', body, 'bob')).status, 404);
  enabled = false; assert.equal((await post(route + '/ai-debug', body)).status, 503); enabled = true;
  assert.equal((await post(route + '/ai-debug', { ...body, command: 'camera-script' })).status, 400);
  const started = await expectJson(await post(route + '/ai-debug', body), 202);
  let final: any;
  for (let index = 0; index < 300; index++) {
    const state = await expectJson(await get(route + '/ai-debug/runs/' + started.run.id));
    if (!['running', 'queued'].includes(state.run.status)) { final = state.run; break; }
    await new Promise(done => setTimeout(done, 10));
  }
  assert.equal(final.status, 'completed'); assert.equal(final.iterations.length, 1); assert.equal(final.final.restored, true);
  assert.equal(final.iterations[0].source, 'model'); assert.equal(final.iterations[0].tool, 'camera_debug_decision');
  assert.equal((await get(route + '/ai-debug/runs/' + started.run.id, 'bob')).status, 404);
  assert.equal((await post(route + '/ai-debug/runs/' + started.run.id + '/cancel', {}, 'bob')).status, 404);
  const saved = (await expectJson(await get(route))).experiment;
  assert.equal(saved.evaluations.length, 0); assert.ok(saved.cameraFrames.length >= 2); assert.equal(saved.aiDebugRuns[0].status, 'completed');
  const tools = await expectJson(await rpc({ jsonrpc: '2.0', id: 777, method: 'tools/list' }));
  assert.ok(tools.result.tools.some((tool: any) => tool.name === 'vision_ai_debug_start'));
  const status = await expectJson(await rpc({ jsonrpc: '2.0', id: 778, method: 'tools/call', params: { name: 'vision_ai_debug_status', arguments: { experimentId: experiment.id, runId: started.run.id } } }));
  assert.equal(status.result.isError, false);
});
