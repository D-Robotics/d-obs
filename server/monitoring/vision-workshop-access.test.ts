/** Real camera REST/MCP handlers, isolated filesystem and explicit software adapters. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Router, type Request } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { requireSshLogAccess } from './ssh-log-routes.js';
import { registerPlatformOperations } from './platform-operations.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP } from './vision-workshop-routes.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { VisionDeviceRegistry, type VisionDeviceAdapter } from './vision-workshop-device.js';
import { visionCrc32 } from './vision-workshop-export.js';
import type { VisionAiDebugPlanner } from './vision-workshop-ai-debug.js';
import { requireVisionWorkshopAccess, visionWorkshopOwner, visionWorkshopDevices, visionBridgeCanonicalJson, visionBridgeCanonicalTarget, visionBridgeRequestBinding, type VisionActorAssertion } from './vision-workshop-access.js';

const envNames = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_VISION_BRIDGE_SECRET', 'RDK_VISION_BRIDGE_STATE_DIR', 'RDK_VISION_BRIDGE_ADAPTER_OWNERS'] as const;
const secret = 'software-fixture-key-32-bytes-minimum-never-real';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const canonical = (data: unknown): string => data === null || typeof data !== 'object' ? JSON.stringify(data) : Array.isArray(data) ? '[' + data.map(canonical).join(',') + ']' : '{' + Object.keys(data).sort().map(key => JSON.stringify(key) + ':' + canonical((data as Record<string, unknown>)[key])).join(',') + '}';
let server: Server; let origin: string; let dir: string; let saved: Array<string | undefined>; let service: VisionWorkshopService; let router: Router; let executed: string[]; let unrelatedCalls: number;
let registry: VisionDeviceRegistry; let modelEnabled: boolean; let planner: VisionAiDebugPlanner;
function signed(method: 'GET' | 'POST', target: string, body?: unknown, sub = 'alice', headers: Record<string, string> = {}, override: Partial<VisionActorAssertion> = {}) {
  const contentType = (headers['content-type'] ?? (method === 'POST' ? 'application/json' : '')).split(';')[0].trim().toLowerCase();
  const bodyKind = method === 'GET' ? 'empty' : Buffer.isBuffer(body) ? 'binary' : body === undefined ? 'empty' : 'json';
  const bytes = bodyKind === 'empty' ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(canonical(body));
  const assertion: VisionActorAssertion = { v: 1, iss: 'rdk-studio', aud: 'd-obs-camera', sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 45, nonce: randomBytes(16).toString('hex'), method, target: visionBridgeCanonicalTarget(target), bodyKind, bodySha256: hash(bytes), headers: { contentType, sample: headers['x-vision-sample'] ?? '', result: headers['x-vision-result'] ?? '', readOnly: headers['x-rdk-ops-read-only'] ?? '', action: headers['x-rdk-ops-action'] ?? '' }, ...override };
  const encoded = Buffer.from(canonical(assertion)).toString('base64url');
  return { ...headers, ...(contentType ? { 'content-type': contentType } : {}), 'x-rdk-camera-assertion': encoded, 'x-rdk-camera-signature': createHmac('sha256', secret).update(encoded).digest('hex') };
}
async function request(method: 'GET' | 'POST', target: string, body?: unknown, sub = 'alice', extra: Record<string, string> = {}) {
  return fetch(origin + target, { method, headers: signed(method, target, body, sub, extra), ...(method === 'POST' ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
}
async function value(response: Response, status = 200): Promise<any> { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function create(sub = 'alice', targetId?: string) { return (await value(await request('POST', API + '/experiments', { title: 'Account bridge fixture', goal: 'Software isolation only', ...(targetId ? { targetId } : {}) }, sub, { 'x-rdk-ops-action': 'observability' }), 201)).experiment; }
async function tool(name: string, args: unknown, sub = 'alice') { return value(await request('POST', MCP, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, sub, { 'x-rdk-ops-action': 'observability' })); }
const decoded = (rpc: any) => JSON.parse(rpc.result.content[0].text);

beforeEach(async () => {
  saved = envNames.map(key => process.env[key]);
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'legacy-software-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'legacy-admin';
  process.env.RDK_VISION_BRIDGE_SECRET = secret;
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') ? { id: req.header('x-fixture-user')! } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await realpath(await mkdtemp(join(tmpdir(), 'vision-account-bridge-')));
  process.env.RDK_VISION_BRIDGE_STATE_DIR = join(dir, 'nonce-state');
  process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = JSON.stringify({ 'alice-camera': ['alice'], 'bob-camera': ['bob'] });
  service = new VisionWorkshopService({ dataDir: join(dir, 'vision') }); executed = []; unrelatedCalls = 0;
  const adapter = (id: string): VisionDeviceAdapter => ({ profile: { id, label: 'Explicit software fixture ' + id, board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk', cameraInterface: 'MIPI CSI-2', operations: ['probe', 'bringup'] }, execute: async operation => { executed.push(id + ':' + operation); return { facts: { softwareFixture: true } }; } });
  registry = new VisionDeviceRegistry(['alice-camera', 'bob-camera', 'unassigned-camera'].map(adapter)); modelEnabled = false; planner = async () => { throw new Error('Fixture must not call a real model'); };
  const app = express(); app.use(express.json({ limit: '2mb' })); router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => modelEnabled, planDebug: input => planner(input) });
  const unrelated = '/api/ops/observability/not-camera';
  router.get(unrelated, requireVisionWorkshopAccess, (_req, res) => { unrelatedCalls++; res.json({ ok: true }); });
  registerPlatformOperations(router, { ['GET ' + unrelated]: { group: '视觉 Workshop', description: 'Unrelated fixture must never leak into the camera catalog', tenantAccessible: false } });
  router.post('/api/ops/mcp', requireSshLogAccess, (_req, res) => { unrelatedCalls++; res.json({ ok: true }); });
  // Directly exercise the actual internal Object.create(req) authority contract.
  router.get(API + '/fixture-internal-scope', requireVisionWorkshopAccess, (req, res) => {
    const inherited = Object.create(req); inherited.originalUrl = unrelated; inherited.url = unrelated;
    requireVisionWorkshopAccess(inherited, res, () => res.json({ ok: true, owner: visionWorkshopOwner(inherited) }));
  });
  app.use(router); server = createServer(app); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } resetObservabilityAccessAdapter(); for (let i = 0; i < envNames.length; i++) if (saved[i] === undefined) delete process.env[envNames[i]]; else process.env[envNames[i]] = saved[i]; if (dir) await rm(dir, { recursive: true, force: true }); });

test('cross-repository canonical protocol has stable JSON/query/body bindings', () => {
  assert.equal(visionBridgeCanonicalJson({ z: [false, 2], a: { y: '白', b: null } }), '{"a":{"b":null,"y":"白"},"z":[false,2]}');
  assert.equal(visionBridgeCanonicalTarget(API + '/knowledge?q=b&q=a&board=RDK%20X5'), API + '/knowledge?board=RDK+X5&q=a&q=b');
  const headers = { 'content-type': 'application/json; charset=utf-8', 'x-rdk-ops-action': 'observability' };
  const binding = visionBridgeRequestBinding({ method: 'POST', originalUrl: API + '/experiments', url: '', body: { z: 2, a: 1 }, header: ((key: string) => headers[key as keyof typeof headers]) as Request['header'] });
  assert.equal(binding.bodySha256, hash('{"a":1,"z":2}')); assert.equal(binding.headers.contentType, 'application/json');
});

test('ordinary Studio identities own separate experiments and cannot use administrator authority', async () => {
  assert.equal((await fetch(origin + API + '/experiments', { headers: { 'x-fixture-user': 'alice' } })).status, 403);
  const alice = await create(); const bob = await create('bob');
  assert.deepEqual((await value(await request('GET', API + '/experiments'))).experiments.map((row: any) => row.id), [alice.id]);
  assert.deepEqual((await value(await request('GET', API + '/experiments', undefined, 'bob'))).experiments.map((row: any) => row.id), [bob.id]);
  assert.equal((await request('GET', API + '/experiments/' + alice.id, undefined, 'bob')).status, 404);
  assert.equal((await service.getExperiment('sso:alice', alice.id)).id, alice.id);
  assert.equal((await fetch(origin + API + '/capabilities', { headers: { 'x-admin-token': 'legacy-software-admin' } })).status, 200);
  const invalid = signed('GET', API + '/experiments'); invalid['x-rdk-camera-signature'] = '0'.repeat(64);
  assert.equal((await fetch(origin + API + '/experiments', { headers: { ...invalid, 'x-admin-token': 'legacy-software-admin' } })).status, 403);
  const longSubject = 'a'.repeat(256); const longExperiment = await create(longSubject);
  assert.deepEqual((await value(await request('GET', API + '/experiments', undefined, longSubject))).experiments.map((row: any) => row.id), [longExperiment.id]);
  assert.equal((await request('GET', API + '/experiments/' + longExperiment.id)).status, 404);
  for (const invalidSub of ['b'.repeat(257), 'has space', 'has\ttab']) assert.equal((await request('GET', API + '/capabilities', undefined, invalidSub)).status, 403);
});

test('adapter catalogs and actual device dispatch require the actor-specific trusted assignment', async () => {
  const alice = await value(await request('GET', API + '/capabilities')); assert.deepEqual(alice.deviceAdapters.map((row: any) => row.id), ['alice-camera']);
  const bob = await value(await request('GET', API + '/capabilities', undefined, 'bob')); assert.deepEqual(bob.deviceAdapters.map((row: any) => row.id), ['bob-camera']);
  delete process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS;
  const empty = await value(await request('GET', API + '/capabilities')); assert.deepEqual(empty.deviceAdapters, []); assert.equal(empty.bringup.status, 'unavailable');
  process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = JSON.stringify({ 'alice-camera': ['alice'] });
  const other = await request('POST', API + '/experiments', { title: 'Forbidden', goal: 'No devices', targetId: 'bob-camera' }, 'alice', { 'x-rdk-ops-action': 'observability' }); assert.equal(other.status, 503); assert.deepEqual(executed, []);
  const exp = await create('alice', 'alice-camera');
  await value(await request('POST', API + '/experiments/' + exp.id + '/device/probe', {}, 'alice', { 'x-rdk-ops-action': 'observability' })); assert.deepEqual(executed, ['alice-camera:probe']);
  process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = '{}';
  assert.equal((await request('POST', API + '/experiments/' + exp.id + '/device/probe', {}, 'alice', { 'x-rdk-ops-action': 'observability' })).status, 503); assert.deepEqual(executed, ['alice-camera:probe']);
});

test('method/query/JSON/metadata/read-only tampering and stale or extended assertions fail closed', async () => {
  const target = API + '/knowledge?q=IMX415'; const headers = signed('GET', target);
  assert.equal((await fetch(origin + target.replace('IMX415', 'other'), { headers })).status, 403);
  assert.equal((await fetch(origin + API + '/knowledge?q=IMX415', { method: 'POST', headers })).status, 404); // no route; no extra authority
  const expTarget = API + '/experiments'; const body = { title: 'Bound', goal: 'No writes after tamper' };
  assert.equal((await fetch(origin + expTarget, { method: 'POST', headers: signed('POST', expTarget, body, 'alice', { 'x-rdk-ops-action': 'observability' }), body: JSON.stringify({ ...body, goal: 'Changed' }) })).status, 403);
  assert.equal((await fetch(origin + expTarget, { method: 'POST', headers: { ...signed('POST', expTarget, body, 'alice', { 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1' }), 'x-rdk-ops-read-only': '0' }, body: JSON.stringify(body) })).status, 403);
  for (const patch of [{ exp: Math.floor(Date.now() / 1000) - 1 }, { iat: Math.floor(Date.now() / 1000) + 31 }, { exp: Math.floor(Date.now() / 1000) + 1000 }]) assert.equal((await fetch(origin + target, { headers: signed('GET', target, undefined, 'alice', {}, patch) })).status, 403);
  assert.equal((await fetch(origin + target, { headers: signed('GET', target, undefined, 'alice', {}, { nonce: ['a'.repeat(32)] as unknown as string }) })).status, 403);
  process.env.RDK_VISION_BRIDGE_SECRET = 'short'; assert.equal((await request('GET', target)).status, 503);
});

test('nonce claim persists, duplicate requests are rejected, and corrupt/unsafe state fails closed', async () => {
  const target = API + '/knowledge'; const headers = signed('GET', target);
  assert.equal((await fetch(origin + target, { headers })).status, 200); assert.equal((await fetch(origin + target, { headers })).status, 403);
  const files = await readdir(process.env.RDK_VISION_BRIDGE_STATE_DIR!); assert.equal(files.filter(name => name.endsWith('.bucket')).length, 1); assert.equal((await readdir(join(process.env.RDK_VISION_BRIDGE_STATE_DIR!, files[0]))).filter(name => name.endsWith('.nonce')).length, 1);
  await writeFile(join(process.env.RDK_VISION_BRIDGE_STATE_DIR!, 'unexpected'), 'not a nonce'); assert.equal((await request('GET', target)).status, 503);
  await rm(join(process.env.RDK_VISION_BRIDGE_STATE_DIR!, 'unexpected')); await chmod(process.env.RDK_VISION_BRIDGE_STATE_DIR!, 0o755); assert.equal((await request('GET', target)).status, 503);
});

test('parallel first reads use immutable nonce slots without a global lock, including cross-process replay', async () => {
  const target = API + '/knowledge';
  const concurrent = await Promise.all(Array.from({ length: 24 }, () => request('GET', target))); assert.ok(concurrent.every(response => response.status === 200));
  const headers = signed('GET', target); assert.equal((await fetch(origin + target, { headers })).status, 200);
  const module = new URL('./vision-workshop-access.' + (import.meta.url.endsWith('.ts') ? 'ts' : 'js'), import.meta.url).href;
  const code = `import {requireVisionWorkshopAccess} from ${JSON.stringify(module)};const headers=JSON.parse(process.env.VISION_TEST_HEADERS);const req={method:'GET',originalUrl:${JSON.stringify(target)},url:${JSON.stringify(target)},body:undefined,socket:{remoteAddress:'127.0.0.1'},header:key=>headers[key]};const res={setHeader(){},status(s){this.s=s;return this},json(){console.log(this.s)}};requireVisionWorkshopAccess(req,res,()=>console.log(200));`;
  const child = execFileSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []), '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...process.env, VISION_TEST_HEADERS: JSON.stringify(headers) } });
  assert.equal(child.trim(), '403');
  const remoteHeaders = signed('GET', target); const remoteRequest = { method: 'GET', originalUrl: target, url: target, body: undefined, socket: { remoteAddress: '203.0.113.1' }, header: (key: string) => key === 'x-forwarded-for' ? '127.0.0.1' : remoteHeaders[key as keyof typeof remoteHeaders] };
  const denied = await new Promise<number>(resolve => { const response = { setHeader() {}, status(code: number) { resolve(code); return this; }, json() {} }; requireVisionWorkshopAccess(remoteRequest as unknown as Request, response as any, () => resolve(200)); }); assert.equal(denied, 403);
});

test('bounded immutable nonce capacity fails closed and an interrupted writer does not lock other nonces', async () => {
  const target = API + '/knowledge'; const headers = signed('GET', target);
  const assertion = JSON.parse(Buffer.from(headers['x-rdk-camera-assertion'], 'base64url').toString());
  const directory = join(process.env.RDK_VISION_BRIDGE_STATE_DIR!, Math.floor(assertion.iat / 60) + '.bucket');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const start = parseInt(hash('rdk-studio\0' + assertion.nonce).slice(0, 8), 16) % 4096;
  const emptySlot = join(directory, start.toString(16).padStart(4, '0') + '.nonce'); await writeFile(emptySlot, '', { mode: 0o600 });
  assert.equal((await fetch(origin + target, { headers })).status, 503);
  let other = signed('GET', target);
  while (parseInt(hash('rdk-studio\0' + JSON.parse(Buffer.from(other['x-rdk-camera-assertion'], 'base64url').toString()).nonce).slice(0, 8), 16) % 4096 === start) other = signed('GET', target);
  assert.equal((await fetch(origin + target, { headers: other })).status, 200);
  await rm(directory, { recursive: true }); await mkdir(directory, { mode: 0o700 });
  for (let batch = 0; batch < 4096; batch += 128) await Promise.all(Array.from({ length: 128 }, (_, offset) => writeFile(join(directory, (batch + offset).toString(16).padStart(4, '0') + '.nonce'), '0'.repeat(64) + '\n', { mode: 0o600 })));
  const full = await fetch(origin + target, { headers }); assert.equal(full.status, 503); assert.equal((await full.json() as any).error, 'vision_bridge_nonce_capacity');
  assert.equal((await readdir(directory)).length, 4096);
});

test('revoked assignment denies old-experiment AI start/cancel/restore and rechecks captured background registries', async () => {
  const exp = await create('alice', 'alice-camera');
  const original = { controls: {}, tuning: { exposure: 1 }, hash: hash(JSON.stringify({ exposure: 1 })) };
  const run = { id: randomUUID(), source: 'model' as const, tool: 'camera_debug_decision' as const, status: 'completed' as const, goal: 'Fixture only', maxRounds: 1, adjustmentCount: 0, iterations: [], operations: [], cancelRequested: false, original, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await service.saveAiDebugRun('sso:alice', exp.id, run);
  process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = '{}';
  const action = { 'x-rdk-ops-action': 'observability' };
  for (const suffix of ['/ai-debug/runs/' + run.id + '/cancel', '/ai-debug/runs/' + run.id + '/restore-original', '/device/calibration_apply']) {
    const result = await request('POST', API + '/experiments/' + exp.id + suffix, suffix.endsWith('calibration_apply') ? { taskId: randomUUID() } : {}, 'alice', action); assert.equal(result.status, 503);
  }
  const start = await request('POST', API + '/experiments/' + exp.id + '/ai-debug', { goal: 'Do not run a model' }, 'alice', action);
  assert.equal(start.status, 503); assert.equal((await start.json() as any).error, 'vision_device_adapter_unavailable');
  assert.deepEqual(executed, []);
  // Hold an actual request-authorized registry across a policy change, as AI jobs do.
  process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = JSON.stringify({ 'alice-camera': ['alice'] });
  const profile = { id: 'alice-camera', label: 'Captured software fixture', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture', operations: ['probe' as const] };
  const registry = new VisionDeviceRegistry([{ profile, execute: async () => { executed.push('unexpected'); return {}; } }]);
  router.get(API + '/fixture-captured-registry', requireVisionWorkshopAccess, async (req, res) => { const scoped = visionWorkshopDevices(req, registry); process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS = '{}'; try { await scoped.execute('alice-camera', 'probe', { experimentId: exp.id, board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture' }, {}); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  assert.equal((await request('GET', API + '/fixture-captured-registry')).status, 503); assert.deepEqual(executed, []);
});

test('signed cross-request AI status/cancel retains the active run, global device lease and actual fixture restoration', async () => {
  const controls = { gamma: { value: 100, min: 72, max: 500, step: 1, writable: true, active: true } };
  const tuning = () => ({ kind: 'explicit-software-fixture-controls', controls: { gamma: controls.gamma.value } });
  const chunk = (name: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(name, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(visionCrc32(Buffer.concat([Buffer.from(name), data]))); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 110, 110, 110, 110, 110, 110, 0, 110, 110, 110, 110, 110, 110]))), chunk('IEND', Buffer.alloc(0))]);
  registry = new VisionDeviceRegistry([{ profile: { id: 'alice-camera', label: 'Explicit cancellable software fixture', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk', cameraInterface: 'MIPI CSI-2', operations: ['probe', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning'] }, execute: async (operation, _context, input) => {
    executed.push(operation);
    if (operation === 'probe') return { facts: { softwareFixture: true }, baseline: { config: tuning(), rules: [{ path: '/controls/gamma', label: 'gamma', min: 72, max: 500, step: 1 }] } };
    if (operation === 'controls_get') return { controls: structuredClone(controls) };
    if (operation === 'controls_set') { controls.gamma.value = (input.values as any).gamma; return { controls: structuredClone(controls) }; }
    if (operation === 'capture_frame') return { filename: 'fixture.png', mimeType: 'image/png', contentBase64: image.toString('base64'), sha256: hash(image), tuningHash: hash(JSON.stringify(tuning())), controls: structuredClone(controls) };
    controls.gamma.value = (input.tuning as any).controls.gamma;
    const actual = hash(JSON.stringify(tuning())); return { appliedHash: actual, readbackHash: actual };
  } }]);
  let inferenceReady!: () => void; const inference = new Promise<void>(resolve => { inferenceReady = resolve; });
  planner = async input => { inferenceReady(); return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('vision_ai_debug_canceled')), { once: true })); };
  modelEnabled = true; const exp = await create('alice', 'alice-camera'); const other = await create('alice', 'alice-camera'); const action = { 'x-rdk-ops-action': 'observability' };
  const started = (await value(await request('POST', API + '/experiments/' + exp.id + '/ai-debug', { goal: 'Synthetic cancellation fixture only', maxRounds: 1 }, 'alice', action), 202)).run;
  const runPath = API + '/experiments/' + exp.id + '/ai-debug/runs/' + started.id;
  try {
    await Promise.race([inference, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('fixture_inference_timeout')), 5000).unref())]);
    const active = (await value(await request('GET', runPath))).run; assert.equal(active.status, 'running'); assert.notEqual(active.stopReason, 'process_interrupted_restoration_unconfirmed');
    const busy = await request('POST', API + '/experiments/' + other.id + '/device/probe', {}, 'alice', action); assert.equal(busy.status, 429);
    const cancel = (await value(await request('POST', runPath + '/cancel', {}, 'alice', action))).run; assert.equal(cancel.cancelRequested, true);
    let final = cancel;
    for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(final.status); attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); final = (await value(await request('GET', runPath))).run; }
    assert.equal(final.status, 'canceled'); assert.equal(final.final.restored, true); assert.ok(final.final.frameId); assert.equal(final.final.frameHash, hash(image)); assert.equal(final.final.hash, hash(JSON.stringify(tuning()))); assert.equal(final.final.controls.gamma.value, 100); assert.equal(controls.gamma.value, 100); assert.equal(executed.filter(operation => operation === 'restore_tuning').length, 1);
    await value(await request('POST', API + '/experiments/' + other.id + '/device/probe', {}, 'alice', action));
  } finally {
    const pending = (await value(await request('GET', runPath))).run;
    if (['queued', 'running'].includes(pending.status)) await request('POST', runPath + '/cancel', {}, 'alice', action);
  }
});

test('typed MCP retains trusted owner internally and never exposes or executes another platform operation', async () => {
  const rpc = await tool('vision_experiment_create', { title: 'Typed account fixture', goal: 'No hardware' }); assert.equal(rpc.result.isError, false); const exp = decoded(rpc).data.experiment;
  assert.equal((await service.getExperiment('sso:alice', exp.id)).id, exp.id);
  const denied = await tool('vision_experiment_get', { experimentId: exp.id }, 'bob'); assert.equal(denied.result.isError, true);
  const catalog = await tool('vision_workshop_capabilities', {}); assert.ok(decoded(catalog).operations.every((op: any) => op.path.startsWith(API + '/')));
  const outside = await tool('vision_workshop_execute', { operationId: 'GET /api/ops/observability/not-camera' }); assert.equal(outside.result.isError, true); assert.equal(unrelatedCalls, 0);
  assert.equal((await request('GET', API + '/fixture-internal-scope')).status, 403);
  assert.equal((await request('POST', '/api/ops/mcp', {})).status, 403); assert.equal(unrelatedCalls, 0);
});

test('calibration and binary uploads preserve actor ownership and bind actual bytes and metadata', async () => {
  const exp = await create(); const target = API + '/experiments/' + exp.id + '/samples';
  const bytes = Buffer.alloc(16); for (let i = 0; i < 8; i++) bytes.writeUInt16LE(64 + i, i * 2);
  const metadata = { scene: 'Explicit software fixture', width: 4, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 8, blackLevel: 0, whiteLevel: 1023 };
  const extra = { 'content-type': 'application/octet-stream', 'x-rdk-ops-action': 'observability', 'x-vision-sample': encodeURIComponent(JSON.stringify(metadata)) };
  const sample = (await value(await request('POST', target, bytes, 'alice', extra), 201)).sample;
  const changed = Buffer.from(bytes); changed[0]++;
  assert.equal((await fetch(origin + target, { method: 'POST', headers: signed('POST', target, bytes, 'alice', extra), body: changed })).status, 403);
  const changedMetadata = { ...extra, 'x-vision-sample': encodeURIComponent(JSON.stringify({ ...metadata, scene: 'Changed' })) };
  assert.equal((await fetch(origin + target, { method: 'POST', headers: { ...signed('POST', target, bytes, 'alice', extra), 'x-vision-sample': changedMetadata['x-vision-sample'] }, body: bytes })).status, 403);
  const tasks = API + '/experiments/' + exp.id + '/calibration/tasks';
  const input = { operation: 'blc', inputs: [{ sampleId: sample.id, capture: { target: 'lens_covered_dark', source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'fixture-mode', exposureUs: 1000, analogGain: 1, lightBlocked: true } }] };
  const task = (await value(await request('POST', tasks, input, 'alice', { 'x-rdk-ops-action': 'observability' }), 201)).task;
  assert.equal((await request('GET', tasks + '/' + task.id, undefined, 'bob')).status, 404);
  const typed = await tool('vision_calibration_task_get', { experimentId: exp.id, taskId: task.id }); assert.equal(typed.result.isError, false); assert.equal(decoded(typed).data.task.id, task.id);
  assert.deepEqual(executed, []);
});

test('account-owned experiment ZIP contains verified CPU results and explicit pending/failed states without private internals', async () => {
  const exp = await create(); const root = API + '/experiments/' + exp.id; const action = { 'x-rdk-ops-action': 'observability' };
  const inputs = [];
  for (const jitter of [-1, 0, 1]) {
    const bytes = Buffer.alloc(16); for (let i = 0; i < 8; i++) bytes.writeUInt16LE(64 + i % 4 + jitter, i * 2);
    const metadata = { scene: 'Synthetic dark fixture', width: 4, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 8, blackLevel: 0, whiteLevel: 1023 };
    const sample = (await value(await request('POST', root + '/samples', bytes, 'alice', { ...action, 'content-type': 'application/octet-stream', 'x-vision-sample': encodeURIComponent(JSON.stringify(metadata)) }), 201)).sample;
    inputs.push({ sampleId: sample.id, capture: { target: 'lens_covered_dark', source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'fixture-mode', exposureUs: 1000, analogGain: 1, lightBlocked: true } });
  }
  const task = (await value(await request('POST', root + '/calibration/tasks', { operation: 'blc', inputs }, 'alice', action), 201)).task;
  const run = await value(await request('POST', root + '/calibration/tasks/' + task.id + '/run', {}, 'alice', action)); assert.equal(run.task.status, 'completed');
  const queued = (await value(await request('POST', root + '/calibration/tasks', { operation: 'blc', inputs }, 'alice', action), 201)).task;
  const failing = (await value(await request('POST', root + '/calibration/tasks', { operation: 'blc', inputs: [inputs[0]] }, 'alice', action), 201)).task;
  assert.equal((await request('POST', root + '/calibration/tasks/' + failing.id + '/run', {}, 'alice', action)).status, 422);
  const download = await request('GET', root + '/bundle'); assert.equal(download.status, 200); assert.match(download.headers.get('content-type') ?? '', /zip/);
  const bytes = Buffer.from(await download.arrayBuffer()); const files = new Map<string, Buffer>(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) { const size = bytes.readUInt32LE(offset + 18); const nameSize = bytes.readUInt16LE(offset + 26); const extra = bytes.readUInt16LE(offset + 28); const begin = offset + 30 + nameSize + extra; const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString(); files.set(name, bytes.subarray(begin, begin + size)); offset = begin + size; }
  const tasks = JSON.parse(files.get('calibration/tasks.json')!.toString()); assert.equal(tasks.hardwareVerification, 'unverified');
  assert.equal(tasks.tasks.find((row: any) => row.id === task.id).status, 'completed'); assert.equal(tasks.tasks.find((row: any) => row.id === queued.id).status, 'queued'); assert.equal(tasks.tasks.find((row: any) => row.id === failing.id).status, 'failed');
  const result = JSON.parse(files.get('calibration/' + task.id + '/result.json')!.toString()); assert.equal(result.datasetId, task.id); assert.equal(result.hardwareVerification, 'unverified');
  assert.ok(!files.has('calibration/' + queued.id + '/result.json')); assert.ok(!files.has('calibration/' + failing.id + '/result.json'));
  assert.doesNotMatch(files.get('calibration/tasks.json')!.toString(), /coordinatorPid|\/Users\/|scriptPath|sdkMapping|privatePath/);
  assert.equal((await request('GET', root + '/bundle', undefined, 'bob')).status, 404);
  // Corrupting actual saved result bytes must make export fail instead of exporting bad evidence.
  const resultFile = join(service.dataDir, 'calibration', hash('sso:alice'), exp.id, task.id + '.result.json');
  const originalBytes = await readFile(resultFile);
  const exportedBytes = files.get('calibration/' + task.id + '/result.json')!;
  const completed = tasks.tasks.find((row: any) => row.id === task.id);
  assert.deepEqual(exportedBytes, originalBytes, 'ZIP preserves the verified result file bytes');
  assert.equal(hash(exportedBytes), completed.result.sha256, 'ZIP result bytes match the public task evidence digest');
  assert.equal(exportedBytes.length, completed.result.bytes);
  await writeFile(resultFile, Buffer.concat([originalBytes, Buffer.from(' ')]));
  assert.equal((await request('GET', root + '/bundle')).status, 503);
  assert.deepEqual(executed, []);
});
