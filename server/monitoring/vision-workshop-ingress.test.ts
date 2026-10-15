import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { createAiEcosystemRouter } from '../observability/ai-ecosystem-routes.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { VisionWorkshopService, type VisionRawMetadata, type VisionRawSample } from './vision-workshop-service.js';
import { VisionDeviceRegistry } from './vision-workshop-device.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API } from './vision-workshop-routes.js';

const RAW = Buffer.alloc(3 * 1024 * 1024);
const METADATA: VisionRawMetadata = { scene: 'ingress fixture only', width: 1536, height: 1024, bitDepth: 10,
  bayer: 'RGGB', packing: 'unpacked16le', stride: 3072, blackLevel: 0, whiteLevel: 1023 };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const adminHeaders = { 'x-fixture-user': 'ingress-admin', 'x-rdk-ops-action': 'observability' };
const envNames = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_PUBLIC_OBSERVABILITY_API_TOKEN',
  'RDK_CHAT_CREDITS_DB_URL', 'RDK_OBSERVABILITY_PG_URL', 'DATABASE_URL'] as const;
let saved: Array<string | undefined>; let server: Server; let origin: string; let dir: string; let service: VisionWorkshopService;
let experimentId: string; let nonOtlpObservedUnparsed: boolean;

beforeEach(async () => {
  saved = envNames.map(name => process.env[name]);
  for (const name of envNames) delete process.env[name];
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-ingress-admin-token';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'ingress-admin';
  process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = 'fixture-ingress-otlp-token';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') === 'ingress-admin' ? { id: 'ingress-admin' } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await mkdtemp(join(tmpdir(), 'vision-ingress-fixture-')); service = new VisionWorkshopService({ dataDir: dir });
  const app = express();
  // This order reproduces production main.ts, including the unrelated OTLP
  // router ahead of the vision uploader. Mounting vision alone misses the bug.
  app.use(express.json({ limit: '2mb' }));
  app.use(createAiEcosystemRouter());
  nonOtlpObservedUnparsed = false;
  app.post('/fixture/non-otlp-binary', (req, _res, next) => {
    nonOtlpObservedUnparsed = !Buffer.isBuffer(req.body) && !req.readableEnded;
    next();
  }, express.raw({ type: 'application/octet-stream', limit: '4mb' }), (req, res) => {
    assert.ok(Buffer.isBuffer(req.body)); res.json({ bytes: req.body.length, hash: digest(req.body) });
  });
  const router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => new VisionDeviceRegistry(),
    modelEnabled: () => false, generateCandidate: async () => { throw new Error('fixture must never call a model'); } });
  app.use(router);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(Number(error.status) || 500).json({ ok: false, error: typeof error.type === 'string' ? error.type : 'fixture_ingress_error' });
  };
  app.use(errors);
  server = createServer(app); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  const created = await fetch(origin + API + '/experiments', { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'isolated ingress fixture', goal: 'verify binary parsing boundaries' }) });
  assert.equal(created.status, 201); experimentId = (await created.json() as { experiment: { id: string } }).experiment.id;
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  if (dir) await rm(dir, { recursive: true, force: true });
  envNames.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  resetObservabilityAccessAdapter();
});
function upload(auth: boolean) {
  return fetch(origin + API + '/experiments/' + experimentId + '/samples', { method: 'POST',
    headers: { ...(auth ? adminHeaders : {}), 'content-type': 'application/octet-stream', 'x-vision-sample': encodeURIComponent(JSON.stringify(METADATA)) }, body: RAW });
}

test('anonymous 3 MiB vision Raw reaches the vision access guard and receives 403 instead of an OTLP 413', async () => {
  const response = await upload(false); assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: string }).error, 'not_authorized');
  const experiment = await service.getExperiment('sso:ingress-admin', experimentId); assert.equal(experiment.samples.length, 0);
});

test('admin 3 MiB valid Raw passes the mounted OTLP router and archives exact bytes and SHA-256', async () => {
  const response = await upload(true); assert.equal(response.status, 201, await response.clone().text());
  const { sample } = await response.json() as { sample: VisionRawSample };
  assert.equal(sample.byteLength, RAW.length); assert.equal(sample.hash, digest(RAW)); assert.deepEqual(sample.metadata, METADATA);
  const stored = await service.readRawSample('sso:ingress-admin', experimentId, sample.id);
  assert.deepEqual(stored.data, RAW); assert.equal(digest(stored.data), sample.hash); assert.equal(stored.sample.source, 'uploaded');
});

test('all nine OTLP aliases retain the 2 MiB binary limit before any telemetry ingest or database write', async () => {
  const paths = ['traces', 'metrics', 'logs'].flatMap(signal => ['/v1/' + signal, '/api/public/otel/v1/' + signal, '/api/v1/otel/v1/' + signal]);
  assert.equal(paths.length, 9);
  for (const path of paths) for (const mime of ['application/octet-stream', 'application/x-protobuf', 'application/protobuf']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': mime, 'x-rdk-observability-token': 'fixture-ingress-otlp-token' }, body: RAW });
    assert.equal(response.status, 413, path + ' ' + mime);
    assert.equal((await response.json() as { error: string }).error, 'entity.too.large');
  }
  assert.equal((await service.getExperiment('sso:ingress-admin', experimentId)).samples.length, 0);
});

test('non-OTLP binary keeps its stream unconsumed until the downstream route selects its own parser', async () => {
  const response = await fetch(origin + '/fixture/non-otlp-binary', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: RAW });
  assert.equal(response.status, 200); assert.equal(nonOtlpObservedUnparsed, true);
  assert.deepEqual(await response.json(), { bytes: RAW.length, hash: digest(RAW) });
});
