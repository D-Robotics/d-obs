import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, request, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { DataCenterService } from './data-center-service.js';
import { registerDataCenterRoutes, DATA_CENTER_API as API, DATA_CENTER_OPERATIONS } from './data-center-routes.js';
import { executePlatformOperation, listPlatformOperations } from './platform-operations.js';
let directory: string; let service: DataCenterService; let origin: string; let server: Server; let router: Router;
let saved: Record<string, string | undefined>;
const scope = { source: 'edge', kind: 'raw', project: 'camera', targetId: 'x5-camera-1' };
const headers = (user = 'alice') => ({ 'x-fixture-user': user, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' });
const get = (suffix: string, user = 'alice') => fetch(origin + API + suffix, { headers: headers(user) });
const post = (suffix: string, body: unknown, user = 'alice', extra: Record<string, string> = {}) => fetch(origin + API + suffix, { method: 'POST', headers: { ...headers(user), ...extra }, body: JSON.stringify(body) });
async function json(response: Response, status = 200): Promise<any> { const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; }
async function upload(bytes: Buffer, extra: Record<string, unknown> = {}, user = 'alice') {
  return fetch(origin + API + '/assets/upload', { method: 'POST', headers: { ...headers(user), 'content-type': 'application/octet-stream', 'x-data-asset': encodeURIComponent(JSON.stringify({ title: 'actual file', ...scope, filename: 'capture.raw', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(bytes).digest('hex'), ...extra })) }, body: bytes });
}
beforeEach(async () => {
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS }; process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: (req) => { const id = req.header('x-fixture-user'); return id ? { id, email: 'shared@example.invalid' } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  directory = await mkdtemp(join(tmpdir(), 'd-obs-data-center-routes-')); service = new DataCenterService({ dataDir: directory }); const app = express(); app.use(express.json()); router = express.Router(); registerDataCenterRoutes(router, { getService: () => service });
  router.post('/fixture-execute', async (req, res) => res.json(await executePlatformOperation(router, req, res, req.body.operationId, req.body.args ?? {})));
  app.use('/dobs', router); app.use(router); server = createServer(app); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); resetObservabilityAccessAdapter(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); });

test('HTTP requires authenticated ops identity, mutation intent and read-only enforcement', async () => {
  for (const auth of [{}, { 'x-admin-token': 'wrong' }, { 'x-fixture-user': 'outsider' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) assert.equal((await fetch(origin + API + '/overview', { headers: auth })).status, 403);
  const capabilities = await json(await fetch(origin + '/dobs' + API + '/capabilities', { headers: headers() })); assert.equal(capabilities.contract, 'rdk.data-center.v1'); assert.equal(capabilities.collection.remoteExecution, 'unavailable'); assert.equal(capabilities.verification.measurementSource, 'reported');
  const read = await fetch(origin + API + '/capabilities', { headers: { ...headers(), 'x-rdk-ops-read-only': '1' } }); assert.equal(read.headers.get('x-rdk-ops-read-only'), '1'); assert.equal((await json(read)).readOnly, true);
  assert.equal((await post('/tasks', { title: 'capture', ...scope, expectedCount: 1 }, 'alice', { 'x-rdk-ops-action': '' })).status, 400);
  assert.equal((await post('/tasks', { title: 'capture', ...scope, expectedCount: 1 }, 'alice', { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('/tasks', { title: 'capture', ...scope, expectedCount: 1 }, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
  for (const extra of [{ owner: 'bob' }, { command: 'capture' }, { host: '1.2.3.4' }, { token: 'unsafe' }, { expectedCount: 0 }]) assert.equal((await post('/tasks', { title: 'capture', ...scope, expectedCount: 1, ...extra })).status, 400);
  assert.equal((await service.listTasks('sso:alice')).length, 0); assert.equal((await fetch(origin + '/ops-observability/data-center')).status, 200);
});

test('HTTP real uploads create data snapshots and a verifiable four-stage closed loop', async () => {
  const task = (await json(await post('/tasks', { title: 'capture baseline', ...scope, expectedCount: 1 }), 201)).task;
  const baseline = (await json(await upload(Buffer.from('baseline real file'), { taskId: task.id }), 201)).asset; await json(await post('/tasks/' + task.id + '/status', { status: 'completed' }));
  const content = await get('/assets/' + baseline.id + '/content'); assert.equal(content.status, 200); assert.match(content.headers.get('content-disposition')!, /attachment/); assert.match(content.headers.get('content-type')!, /application\/octet-stream/); assert.deepEqual(Buffer.from(await content.arrayBuffer()), Buffer.from('baseline real file'));
  const dataset = (await json(await post('/datasets', { name: 'baseline scenes', project: 'camera', assetIds: [baseline.id] }), 201)).dataset;
  const loop = (await json(await post('/loops', { title: 'Improve exposure', goal: 'Reduce clip rate', project: 'camera', targetId: scope.targetId, datasetId: dataset.id, baseline: { metric: 'clip-rate', value: 20, assetId: baseline.id, version: 'v1' }, criterion: { direction: 'decrease', threshold: 5 } }), 201)).loop;
  for (const stage of ['analysis', 'evaluation', 'deployment', 'verification']) { const asset = (await json(await upload(Buffer.from('actual ' + stage)), 201)).asset; const updated = await json(await post('/loops/' + loop.id + '/evidence', { stage, assetId: asset.id, version: 'v2', targetId: scope.targetId, notes: 'Attached evidence', ...(stage === 'verification' ? { baselineValue: 20, candidateValue: 12 } : {}) })); if (stage === 'deployment') assert.equal(updated.loop.status, 'deployed'); if (stage === 'verification') { assert.equal(updated.loop.status, 'verified'); assert.equal(updated.loop.evidence.at(-1).passed, true); } }
  const overview = (await json(await get('/overview'))).overview; assert.equal(overview.counts.assets, 5); assert.equal(overview.sources.edge, 5); assert.equal(overview.pendingLoops.length, 0);
  assert.equal((await json(await get('/datasets/' + dataset.id))).dataset.version, 1); assert.equal((await json(await get('/loops/' + loop.id))).loop.status, 'verified');
});

test('SSO stable IDs isolate shared-email users, all detail reads and exported manifests', async () => {
  const asset = (await json(await upload(Buffer.from('private alice')), 201)).asset; const dataset = (await json(await post('/datasets', { name: 'private dataset', project: 'camera', assetIds: [asset.id] }), 201)).dataset;
  assert.deepEqual((await json(await get('/assets', 'bob'))).assets, []); assert.equal((await get('/assets/' + asset.id, 'bob')).status, 404); assert.equal((await get('/assets/' + asset.id + '/content', 'bob')).status, 404); assert.equal((await get('/datasets/' + dataset.id, 'bob')).status, 404);
  assert.equal((await post('/datasets', { name: 'stolen', project: 'camera', assetIds: [asset.id] }, 'bob')).status, 404); const manifest = await get('/manifest', 'bob'); assert.match(manifest.headers.get('content-disposition')!, /attachment/); assert.deepEqual((await json(manifest)).assets, []);
  const own = await get('/manifest'); const raw = await own.text(); assert.ok(raw.includes(asset.id)); assert.ok(!raw.includes('ownerHash')); assert.ok(!raw.includes('collectionTokens'));
});

test('scoped HTTP ingress only receives its task, works under prefix and rejects rotated or read-only tokens', async () => {
  const task = (await json(await post('/tasks', { title: 'endpoint capture', ...scope, expectedCount: 1 }), 201)).task; const old = await json(await post('/tasks/' + task.id + '/token', {})); const credential = await json(await post('/tasks/' + task.id + '/token', {}));
  const bytes = Buffer.from('terminal file'); const metadata = encodeURIComponent(JSON.stringify({ filename: 'frame.raw', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(bytes).digest('hex') }));
  const ingest = (token: string, extra = {}, path = '') => fetch(origin + path + credential.ingestPath, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-collection-token': token, 'x-data-asset': metadata, ...extra }, body: bytes });
  assert.equal((await ingest(old.token)).status, 403); assert.equal((await ingest(credential.token, { 'x-rdk-ops-read-only': '1' })).status, 403); assert.equal((await fetch(origin + credential.ingestPath, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes })).status, 403);
  const first = (await json(await ingest(credential.token, {}, '/dobs'), 201)).asset; const retry = (await json(await ingest(credential.token), 201)).asset; assert.equal(first.id, retry.id); assert.equal(first.targetId, scope.targetId); assert.equal(first.source, 'edge');
  assert.equal((await json(await get('/tasks'))).tasks[0].status, 'collecting'); await json(await post('/tasks/' + task.id + '/status', { status: 'completed' })); assert.equal((await ingest(credential.token)).status, 403);
});

test('strict upload protocol, URL references, search filters and deletion report concrete failures', async () => {
  assert.equal((await upload(Buffer.from('real'), { sha256: 'a'.repeat(64) })).status, 422); assert.equal((await upload(Buffer.from('real'), { filename: '../../unsafe' })).status, 400); assert.equal((await upload(Buffer.from('real'), { provenance: { system: 'runner' } })).status, 400);
  assert.equal((await post('/assets/upload', { contentBase64: 'eA==' })).status, 415);
  const external = (await json(await post('/assets', { title: 'Cloud logs', kind: 'log', source: 'cloud', project: 'camera', referenceUri: 'https://storage.example.test/logs.json' }), 201)).asset; assert.equal((await get('/assets/' + external.id + '/content')).status, 409);
  for (const referenceUri of ['http://example.test/a', 'https://user:password@example.test/a', 'https://example.test/a?signature=secret']) assert.equal((await post('/assets', { title: 'bad', ...scope, referenceUri })).status, 400);
  assert.equal((await json(await get('/assets?kind=log&source=cloud&search=logs'))).assets.length, 1); assert.equal((await get('/assets?owner=bob')).status, 400);
  assert.equal((await fetch(origin + API + '/assets/' + external.id, { method: 'DELETE', headers: headers('bob') })).status, 404); await json(await fetch(origin + API + '/assets/' + external.id, { method: 'DELETE', headers: headers() })); assert.equal((await get('/assets/' + external.id)).status, 404);
});

test('registered platform operations reuse identity and deny read-only writes', async () => {
  assert.deepEqual(listPlatformOperations(router).map((operation) => operation.id).sort(), Object.keys(DATA_CENTER_OPERATIONS).sort());
  const run = (operationId: string, args = {}, extra = {}) => fetch(origin + '/fixture-execute', { method: 'POST', headers: { ...headers(), ...extra }, body: JSON.stringify({ operationId, args }) });
  const read = await json(await run('GET ' + API + '/overview')); assert.equal(read.ok, true); assert.equal(read.data.overview.counts.assets, 0);
  const denied = await json(await run('POST ' + API + '/tasks', { body: { title: 'capture', ...scope, expectedCount: 1 } }, { 'x-rdk-ops-read-only': '1' })); assert.equal(denied.status, 403); assert.equal(denied.data.error, 'platform_read_only_operation_denied');
  const created = await json(await run('POST ' + API + '/tasks', { body: { title: 'capture', ...scope, expectedCount: 1 } })); assert.equal(created.status, 201); assert.equal(created.data.task.status, 'planned');
});

test('upload reservations survive client disconnect until buffered service work settles', async () => {
  const original = service.uploadAsset.bind(service); const pending: Array<() => void> = []; let entered = 0;
  service.uploadAsset = async (...args) => { entered++; await new Promise<void>((done) => pending.push(done)); return original(...args); };
  const bytes = Buffer.from('bounded pending bytes'); const metadata = encodeURIComponent(JSON.stringify({ title: 'pending', ...scope, filename: 'pending.raw', mimeType: 'application/octet-stream', sha256: createHash('sha256').update(bytes).digest('hex') }));
  const clients = [];
  try {
    for (let i = 0; i < 4; i++) {
      const client = request(origin + API + '/assets/upload', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-data-asset': metadata } }); client.on('error', () => undefined); client.end(bytes); clients.push(client);
      while (entered < i + 1) await new Promise<void>((done) => setTimeout(done, 5)); client.destroy();
    }
    assert.equal((await upload(bytes)).status, 429); assert.equal(entered, 4);
  } finally { for (const done of pending) done(); for (const client of clients) client.destroy(); while ((await service.listAssets('sso:alice')).length < 4) await new Promise<void>((done) => setTimeout(done, 5)); }
  service.uploadAsset = original; assert.equal((await upload(Buffer.from('next available slot'))).status, 201);
});
