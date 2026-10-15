import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configuredVisionDevices, type VisionDeviceOperation } from './vision-workshop-device.js';
import { VisionWorkshopService, type VisionExperiment } from './vision-workshop-service.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP } from './vision-workshop-routes.js';
import { visionCrc32 } from './vision-workshop-export.js';
import type { VisionIspCandidate } from './vision-workshop-model.js';
import type { VisionAiDebugPlanner } from './vision-workshop-ai-debug.js';
import type { VisionAiDebugDecision, VisionAiDebugInput } from './vision-workshop-ai-model.js';

type Json = Record<string, any>;
const TOKEN = 'x5-http-sdk-protocol-fixture-token-0123456789';
const identity = { board: 'RDK X5', sensorModel: 'IMX415', sensorVendor: 'Sony', sdkVersion: 'sdk-protocol-fixture-only', cameraInterface: 'MIPI CSI-2', cameraMode: '2x2-sdk-protocol-fixture-only' };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const proposal: VisionIspCandidate = { source: 'model', model: 'sdk-protocol-fixture-model', modelInput: 'raw_statistics_and_baseline', patches: [{ path: '/controls/brightness', value: 80, reason: 'Protocol fixture candidate; hardware and image quality remain unverified.' }], text: 'Explicit local fixture, no external model call.' };

// Temporary test helper imports the same stateful backend tested in Python.
// There is no production config switch, registered fixture driver or SDK call.
const helperSource = String.raw`
import copy, importlib.util, json, signal, struct, sys, threading
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("x5_fixture_tests", sys.argv[1])
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
native = fixture.native
config = json.loads(Path(sys.argv[2]).read_text())
audit_path = Path(sys.argv[3])
mode_path = Path(sys.argv[4])

class Backend(fixture.StatefulSdkFixture):
    def __init__(self):
        super().__init__()
        self.values = {"brightness":64,"contrast":1,"saturation":1}
        self.initial = copy.deepcopy(self.values)
    def persist(self):
        target = audit_path.with_suffix(".tmp")
        target.write_text(json.dumps({"source":self.source,"values":self.values,"events":self.events}))
        target.replace(audit_path)
    def controls(self):
        value = super().controls()
        for key, row in value.items():
            row["nativeName"] = "hbn_isp_cproc_attr_t.manual_attr." + ("bright" if key == "brightness" else key)
            row.pop("step", None)
            row["min"] = -127 if key == "brightness" else 0
            row["max"] = 127 if key == "brightness" else struct.unpack("=f",struct.pack("=f",1.999))[0]
        self.persist()
        return value
    def set_control(self, name, value):
        mode = mode_path.read_text().strip()
        self.ignore_writes = mode == "ignore"
        self.fail_write_after_change = mode == "partial"
        try:
            return super().set_control(name, value)
        finally:
            self.persist()
    def close(self):
        super().close()
        self.persist()

backend = Backend()
camera = native.Camera(config, backend=backend, preflight=lambda: {"source":"sdk-protocol-fixture","hardwareVerified":False})
server = native.create_server({**config,"port":0}, camera=camera)
def stop(_signum, _frame):
    camera.closing = True
    threading.Thread(target=server.shutdown,daemon=True).start()
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
print(json.dumps({"url":"http://127.0.0.1:"+str(server.server_port),"source":"sdk-protocol-fixture"}),flush=True)
try:
    server.serve_forever()
finally:
    try:
        camera.close()
    finally:
        server.server_close()
`;

async function fixture(t: TestContext, planner?: VisionAiDebugPlanner) {
  const directory = await mkdtemp(join(tmpdir(), 'x5-http-sdk-protocol-fixture-'));
  const modePath = join(directory, 'fault-mode.txt'); const auditPath = join(directory, 'backend-audit.json');
  const helperPath = join(directory, 'test-only-http-session.py'); const configPath = join(directory, 'private-config.json');
  const saved = { token: process.env.RDK_CREDITS_ADMIN_TOKEN, admins: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'x5-e2e-fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'x5-e2e-reviewer';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') ? { id: req.header('x-fixture-user')!, email: 'fixture@example.invalid' } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  await writeFile(helperPath, helperSource, { mode: 0o600 }); await writeFile(modePath, 'none', { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ token: TOKEN, ...identity, nativeLibrary: join(directory, 'unused-fixture-sdk.so'), sensorConfig: 'imx415-30fps-2lane', csiPort: 0, port: 3217, stateDir: join(directory, 'camera-state'), colorMatrix: 'bt601', colorRange: 'limited', blackLevel: 0, whiteLevel: 1023, discardFrames: 1 }), { mode: 0o600 });
  const child = spawn('python3', [helperPath, resolve('tools/vision-x5-camera.test.py'), configPath, auditPath, modePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise<{ code: number | null; signal: string | null }>(done => child.once('close', (code, signal) => done({ code, signal })));
  let appServer: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    if (appServer) { appServer.closeAllConnections(); await new Promise<void>(done => appServer!.close(() => done())); }
    await writeFile(modePath, 'none').catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    const status = await closed; clearTimeout(killer);
    await rm(directory, { recursive: true, force: true });
    if (saved.token === undefined) delete process.env.RDK_CREDITS_ADMIN_TOKEN; else process.env.RDK_CREDITS_ADMIN_TOKEN = saved.token;
    if (saved.admins === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = saved.admins;
    resetObservabilityAccessAdapter();
    assert.equal(status.code, 0, stderr); assert.equal(stderr, '');
  });
  const ready = await new Promise<{ url: string; source: string }>((done, reject) => {
    let stdout = ''; const timeout = setTimeout(() => reject(new Error('Python fixture did not start: ' + stderr)), 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Python fixture exited before ready: ' + code + ' ' + stderr)); });
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) { clearTimeout(timeout); try { done(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
  });
  assert.equal(ready.source, 'sdk-protocol-fixture');
  const response = await fetch(ready.url + '/capabilities', { headers: { authorization: 'Bearer ' + TOKEN } }); assert.equal(response.status, 200);
  const nativeCapabilities = await response.json() as Json;
  assert.equal(nativeCapabilities.hardwareVerified, false); assert.equal(nativeCapabilities.rawReplay, false);
  const registry = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([{ id: 'x5-sdk-protocol-fixture', label: 'Python HBN protocol fixture, no hardware', ...identity, operations: nativeCapabilities.operations as VisionDeviceOperation[], url: ready.url, token: TOKEN }]) });
  const service = new VisionWorkshopService({ dataDir: join(directory, 'platform-state') });
  let modelCalls = 0;
  const app = express(); app.use(express.json({ limit: '2mb' })); const router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => true, generateCandidate: async input => { modelCalls++; assert.ok(input.rawStatistics); return structuredClone(proposal); }, ...(planner ? { planDebug: planner } : {}) });
  app.use(router); appServer = createServer(app);
  await new Promise<void>(done => appServer!.listen(0, '127.0.0.1', done));
  const address = appServer.address(); assert.ok(address && typeof address !== 'string'); const origin = 'http://127.0.0.1:' + address.port;
  const headers = { 'content-type': 'application/json', 'x-fixture-user': 'x5-e2e-reviewer', 'x-rdk-ops-action': 'observability' };
  async function call(name: string, args: Json = {}, expectError = false): Promise<Json> {
    const response = await fetch(origin + MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200, await response.clone().text()); const reply = await response.json() as Json;
    assert.equal(reply.result.isError, expectError, JSON.stringify(reply));
    if (expectError) return reply;
    const result = JSON.parse(reply.result.content[0].text); assert.equal(result.ok, true); return result.data;
  }
  const get = (suffix: string) => fetch(origin + API + suffix, { headers });
  const experiment = (await call('vision_experiment_create', { title: 'X5 SDK protocol fixture', goal: 'Verify atomics only; hardware and quality remain unverified', targetId: 'x5-sdk-protocol-fixture' })).experiment as VisionExperiment;
  const experimentId = experiment.id;
  async function prepare() {
    const bringup = await call('vision_camera_bringup', { experimentId });
    assert.equal(bringup.result.passed, true);
    assert.equal(bringup.result.evidence.evidence.source, 'sdk-protocol-fixture');
    assert.equal(bringup.result.evidence.evidence.hardwareAcceptance, 'unverified');
    const baseline = await call('vision_tuning_baseline_import', { experimentId, ...bringup.result.baseline });
    assert.deepEqual(Object.keys(baseline.baseline.tuning.controls), ['brightness', 'contrast', 'saturation']);
    return { bringup, baseline: baseline.baseline };
  }
  const audit = async () => JSON.parse(await readFile(auditPath, 'utf8')) as Json;
  const journal = async () => JSON.parse(await readFile(join(directory, 'camera-state', 'isp-write.json'), 'utf8')) as Json;
  return { call, get, origin, headers, experimentId, prepare, audit, journal, fault: (mode: string) => writeFile(modePath, mode), modelCalls: () => modelCalls };
}

function unzipStored(bytes: Buffer) {
  const files = new Map<string, Buffer>(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameSize); const start = offset + 30 + nameSize + extraSize; const data = bytes.subarray(start, start + size);
    assert.equal(visionCrc32(data), bytes.readUInt32LE(offset + 14)); files.set(name, data); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50); return files;
}

test('Python native camera HTTP fixture completes typed MCP bringup, assets, independent CPROC readback, recovery and ZIP', async t => {
  const f = await fixture(t); const { baseline } = await f.prepare(); const experimentId = f.experimentId;
  const frame = await f.call('vision_camera_capture_frame', { experimentId, scene: 'CPROC baseline fixture' });
  const png = Buffer.from(await (await f.get('/experiments/' + experimentId + '/frames/' + frame.asset.id)).arrayBuffer());
  assert.equal(hash(png), frame.asset.hash); assert.equal(frame.asset.source, 'runner'); assert.equal(frame.asset.verification, 'unverified');
  assert.deepEqual([frame.asset.width, frame.asset.height], [2, 2]); assert.equal(frame.asset.tuningHash, baseline.hash);
  const raw = await f.call('vision_raw_capture', { experimentId, scene: 'RAW16 container fixture' });
  const rawBytes = Buffer.from(await (await f.get('/experiments/' + experimentId + '/samples/' + raw.asset.id + '/download')).arrayBuffer());
  const expectedRaw = Buffer.alloc(8); [0, 100, 500, 1023].forEach((value, index) => expectedRaw.writeUInt16LE(value, index * 2));
  assert.deepEqual(rawBytes, expectedRaw); assert.equal(hash(rawBytes), raw.asset.hash); assert.equal(raw.asset.source, 'runner');
  assert.equal(raw.result.evidence.source, 'sdk-protocol-fixture'); assert.equal(raw.result.evidence.hardwareAcceptance, 'unverified');
  const candidate = (await f.call('vision_isp_generate', { experimentId })).candidate;
  assert.equal(f.modelCalls(), 1); assert.equal(candidate.model, 'sdk-protocol-fixture-model'); assert.equal(candidate.verification, 'unverified');
  assert.deepEqual(candidate.sampleHashes, [hash(rawBytes)]);
  const applied = await f.call('vision_isp_apply', { experimentId, candidateId: candidate.id });
  assert.equal(applied.result.readbackHash, candidate.hash); assert.equal(applied.result.appliedHash, candidate.hash);
  assert.deepEqual(applied.result.evidence.config, candidate.tuning); assert.equal(applied.result.evidence.fullEffectLibrary, false);
  assert.equal((await f.audit()).values.brightness, 80);
  const readback = await f.call('vision_camera_controls_get', { experimentId }); assert.equal(readback.result.controls.brightness.value, 80);
  const candidateFrame = await f.call('vision_camera_capture_frame', { experimentId, scene: 'Applied CPROC fixture', candidateId: candidate.id });
  assert.equal(candidateFrame.asset.tuningHash, candidate.hash); assert.equal(candidateFrame.asset.verification, 'unverified');
  const restored = await f.call('vision_isp_restore', { experimentId }); assert.equal(restored.result.readbackHash, baseline.hash);
  assert.deepEqual((await f.audit()).values, { brightness: 64, contrast: 1, saturation: 1 });
  assert.equal((await f.journal()).outcome, 'restored');
  const ledger = (await f.call('vision_experiment_get', { experimentId })).experiment;
  assert.ok(ledger.deviceRuns.some((run: Json) => run.operation === 'apply_tuning' && run.status === 'completed' && run.evidence.result.readbackHash === candidate.hash));
  assert.ok(ledger.deviceRuns.some((run: Json) => run.operation === 'restore_tuning' && run.status === 'completed' && run.evidence.result.readbackHash === baseline.hash));
  const exported = await f.call('vision_workshop_export', { experimentId, includeRaw: true });
  const zipResponse = await fetch(f.origin + exported.downloadUrl, { headers: f.headers }); assert.equal(zipResponse.status, 200);
  const files = unzipStored(Buffer.from(await zipResponse.arrayBuffer()));
  assert.deepEqual(files.get('raw/' + raw.asset.id + '.raw'), rawBytes); assert.deepEqual(files.get('frames/' + frame.asset.id + '.png'), png);
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  assert.equal(manifest.provenance.boardValidation, 'parameters_applied_quality_unverified');
  assert.ok(manifest.experiment.cameraFrames.every((frame: Json) => frame.verification === 'unverified'));
  assert.ok(manifest.experiment.candidates.every((candidate: Json) => candidate.verification === 'unverified'));
  assert.match(files.get('handbook.md')!.toString(), /未获得完整.*画质验收/);
  assert.doesNotMatch(files.get('manifest.json')!.toString(), new RegExp(TOKEN));
});

for (const fault of ['ignore', 'partial']) test('Python SDK ' + fault + ' write has failed unconfirmed ledger, no blind replay and explicit complete recovery', async t => {
  const f = await fixture(t); const { baseline } = await f.prepare(); const experimentId = f.experimentId;
  await f.call('vision_raw_capture', { experimentId, scene: 'fault fixture' });
  const candidate = (await f.call('vision_isp_generate', { experimentId })).candidate;
  await f.fault(fault); const failed = await f.call('vision_isp_apply', { experimentId, candidateId: candidate.id }, true);
  assert.match(failed.result.content[0].text, /vision_device_execution_failed/);
  const journal = await f.journal(); assert.equal(journal.outcome, 'unconfirmed');
  const audit = await f.audit(); assert.equal(audit.values.brightness, fault === 'partial' ? 80 : 64);
  const setCount = audit.events.filter((event: unknown[]) => event[0] === 'set').length;
  const failedRun = (await f.call('vision_experiment_get', { experimentId })).experiment.deviceRuns.at(-1);
  assert.equal(failedRun.operation, 'apply_tuning'); assert.equal(failedRun.status, 'failed'); assert.equal(failedRun.evidence.outcome, 'unconfirmed');
  assert.match(failedRun.evidence.jobId, /^[a-f0-9-]{36}$/); assert.equal(failedRun.evidence.operation, 'apply_tuning');
  assert.equal(failedRun.evidence.adapterCode, fault === 'partial' ? 'fixture_write_failed' : 'isp_readback_mismatch');
  if (fault === 'partial') assert.equal(failedRun.evidence.sdkCode, -5);
  assert.doesNotMatch(JSON.stringify(failedRun), new RegExp(TOKEN));
  await f.fault('none');
  await f.call('vision_isp_apply', { experimentId, candidateId: candidate.id }, true);
  assert.equal((await f.audit()).events.filter((event: unknown[]) => event[0] === 'set').length, setCount);
  const current = await f.call('vision_camera_probe', { experimentId }); assert.equal(current.result.facts.writeOutcome, 'unconfirmed');
  const restored = await f.call('vision_isp_restore', { experimentId }); assert.equal(restored.result.readbackHash, baseline.hash);
  assert.deepEqual((await f.audit()).values, { brightness: 64, contrast: 1, saturation: 1 }); assert.equal((await f.journal()).outcome, 'restored');
});

const naturalGoal = '请降低测试画面对比度并保留细节；本轮仅为协议 fixture，不表示物理相机画质验收。';
function fixtureDecision(action: 'adjust' | 'stop'): VisionAiDebugDecision {
  return { source: 'model', model: 'explicit-sdk-protocol-fixture-planner', modelInput: 'camera_images_controls_and_history', action,
    ...(action === 'adjust' ? { values: { contrast: 1.3 } } : {}),
    notes: 'Programmatic protocol fixture: no model inspected a physical camera and no image quality improvement is claimed.',
    assessment: { improved: false, sceneUsable: true, goalSatisfied: false, issue: 'unknown', reason: 'Explicit fixture assessment only; preserve the original configuration and keep quality unverified.' },
    done: action === 'stop' };
}

for (const ending of ['stop', 'planner-failure']) test('X5 HBN AI orchestration fixture normalizes float32, records actual PNG/readback and restores original after ' + ending, { timeout: 25_000 }, async t => {
  const plannerInputs: VisionAiDebugInput[] = [];
  const planner: VisionAiDebugPlanner = async input => {
    plannerInputs.push(structuredClone({ ...input, signal: undefined }));
    assert.equal(input.goal, naturalGoal); assert.equal(input.cameraContext?.sdkVersion, identity.sdkVersion);
    assert.equal(input.controls.contrast.nativeName, 'hbn_isp_cproc_attr_t.manual_attr.contrast');
    const original = Buffer.from(input.originalImage.contentBase64, 'base64');
    const current = Buffer.from(input.currentImage.contentBase64, 'base64');
    assert.deepEqual(original.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.deepEqual(current.subarray(0, 8), original.subarray(0, 8));
    if (plannerInputs.length === 1) { assert.equal(input.round, 1); assert.deepEqual(input.history, []); return fixtureDecision('adjust'); }
    assert.equal(input.controls.contrast.value, Math.fround(1.3));
    assert.equal(input.history.length, 1); assert.notEqual(hash(current), hash(original));
    if (ending === 'planner-failure') throw new Error('vision_ai_debug_fixture_planner_failed');
    return fixtureDecision('stop');
  };
  const f = await fixture(t, planner); const experimentId = f.experimentId;
  const before = await f.call('vision_camera_probe', { experimentId });
  assert.equal(before.result.facts.streaming, false); assert.equal(before.result.baseline, undefined);
  await assert.rejects(f.audit(), { code: 'ENOENT' });
  const bringup = await f.call('vision_camera_bringup', { experimentId });
  assert.equal(bringup.result.passed, true); assert.equal(bringup.result.baseline.config.kind, 'x5-hbn-isp-controls-v1');
  const originalTuning = bringup.result.baseline.config;
  const started = await f.call('vision_ai_debug_start', { experimentId, goal: naturalGoal, maxRounds: 2 });
  const runId = started.run.id;
  let final: Json | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = (await f.call('vision_ai_debug_status', { experimentId, runId })).run;
    if (!['queued', 'running'].includes(run.status)) { final = run; break; }
    await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(final, 'AI fixture must finish within 20 seconds');
  assert.equal(final.status, ending === 'stop' ? 'completed' : 'failed');
  if (ending === 'planner-failure') assert.equal(final.error, 'vision_ai_debug_fixture_planner_failed');
  assert.equal(plannerInputs.length, 2); assert.equal(final.goal, naturalGoal);
  assert.equal(final.source, 'model'); assert.equal(final.tool, 'camera_debug_decision'); assert.equal(final.adjustmentCount, 1);
  assert.equal(final.goalSatisfied, false); assert.equal(final.final.visualVerification, 'unverified');
  assert.equal(final.final.restored, true); assert.equal(final.final.imageError, undefined); assert.equal(final.restorationError, undefined);
  assert.deepEqual(final.original.tuning, originalTuning); assert.deepEqual(Object.keys(final.original.tuning.controls), ['brightness', 'contrast', 'saturation']);
  assert.equal(final.original.hash, hash(Buffer.from(JSON.stringify(originalTuning)))); assert.equal(final.final.hash, final.original.hash);
  const adjusted = final.iterations[0];
  assert.equal(adjusted.model, 'explicit-sdk-protocol-fixture-planner'); assert.equal(adjusted.source, 'model');
  assert.equal(adjusted.modelInput, 'camera_images_controls_and_history'); assert.match(adjusted.notes, /Programmatic protocol fixture/);
  assert.equal(adjusted.requestedValues.contrast, Math.fround(1.3)); assert.equal(adjusted.readback.contrast.value, Math.fround(1.3));
  assert.equal(adjusted.after.controls.contrast.value, Math.fround(1.3));
  const adjustedTuning = { ...originalTuning, controls: { ...originalTuning.controls, contrast: Math.fround(1.3) } };
  assert.equal(adjusted.after.tuningHash, hash(Buffer.from(JSON.stringify(adjustedTuning))));
  assert.ok(final.operations.some((operation: Json) => operation.operationId.endsWith('/restore_tuning') && operation.status === 'completed' && operation.receipt.readbackHash === final.original.hash));
  assert.deepEqual((await f.audit()).values, originalTuning.controls); assert.equal((await f.journal()).outcome, 'restored');
  const experiment = (await f.call('vision_experiment_get', { experimentId })).experiment;
  assert.equal(experiment.candidates.length, 0); assert.equal(experiment.evaluations.length, 0);
  for (const [frameId, expectedHash] of [[final.original.frameId, final.original.frameHash], [adjusted.after.frameId, adjusted.after.frameHash], [final.final.frameId, final.final.frameHash]]) {
    const recorded = experiment.cameraFrames.find((frame: Json) => frame.id === frameId); assert.equal(recorded.verification, 'unverified');
    assert.equal(recorded.source, 'runner');
    const png = Buffer.from(await (await f.get('/experiments/' + experimentId + '/frames/' + frameId)).arrayBuffer());
    assert.equal(hash(png), expectedHash); assert.equal(recorded.hash, expectedHash);
  }
});
