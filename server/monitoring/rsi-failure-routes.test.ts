import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { RsiFailureInboxService } from '../evolution/rsi-failure-inbox.js';
import { createRsiLedgerService, type RsiLedgerService } from '../evolution/rsi-ledger.js';
import type { RsiReason, RsiSlice } from '../evolution/rsi-replay.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { executePlatformOperation, listPlatformOperations, registerPlatformOperations } from './platform-operations.js';
import { configureRsiFailureObserverForTests, flushRsiPlatformFailures, RsiFailureObserver } from './rsi-failure-observer.js';
import { registerRsiFailureRoutes, RSI_FAILURE_OPERATIONS, type RsiFailureRouteOptions } from './rsi-failure-routes.js';
import { registerRsiLearningRoutes } from './rsi-learning-routes.js';
import { RSI_LEARNING_API as API, RSI_LEARNING_CONTRACT } from './rsi-learning-operations.js';

const FIXTURE_OPERATION = 'GET /api/ops/observability/rsi-test-failure/:id';
let server: Server;
let origin: string;
let directory: string;
let service: RsiFailureInboxService;
let ledger: RsiLedgerService;
let saved: Record<string, string | undefined>;

async function start(options: RsiFailureRouteOptions = {}) {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((req, _res, next) => {
    if (req.header('x-fixture-tenant') === '1') {
      req.opsTenantAccess = { tenantId: 'tenant-a', displayName: 'Tenant A', source: 'member', role: 'owner' };
    }
    next();
  });
  const router = express.Router();
  registerRsiFailureRoutes(router, { service, ledger, ...options });
  registerRsiLearningRoutes(router, { service: ledger });
  // Real Express receipts exercise the platform dispatch/observer integration.
  // These are explicit test fixtures, not evidence of production improvement.
  router.get('/api/ops/observability/rsi-test-failure/:id', (req, res) => {
    const status = Number(req.params.id);
    res.status(status).json({ ok: false, error: status === 401 ? 'AUTH_DENIED' : 'ETIMEDOUT',
      message: 'private raw response', debug: '/private/fixtures/raw.json' });
  });
  registerPlatformOperations(router, { [FIXTURE_OPERATION]: {
    tenantAccessible: false, group: 'Test fixture', description: 'Controlled failure receipt fixture.',
  } });
  router.post('/fixture/invoke', async (req, res) => {
    const result = await executePlatformOperation(router, req, res, req.body.operationId ?? FIXTURE_OPERATION,
      req.body.args ?? { params: { id: String(req.body.status) } });
    res.json(result);
  });
  app.use('/prefix', router);
  app.use(router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  return router;
}

beforeEach(async () => {
  saved = {
    RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN,
    RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS,
  };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({
    getSessionSsoUser: (req) => {
      const id = req.header('x-fixture-user');
      return id ? { id, email: 'same@example.invalid' } : null;
    },
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });
  directory = await mkdtemp(join(tmpdir(), 'd-obs-rsi-evidence-http-'));
  service = new RsiFailureInboxService({ stateDir: join(directory, 'inbox'), operationIds: [FIXTURE_OPERATION] });
  ledger = createRsiLedgerService({ stateDir: join(directory, 'ledger') });
  configureRsiFailureObserverForTests(new RsiFailureObserver({ inbox: service, ledger }));
});

afterEach(async () => {
  await flushRsiPlatformFailures();
  configureRsiFailureObserverForTests();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetObservabilityAccessAdapter();
});

function headers(user = 'alice', extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', 'x-fixture-user': user, 'x-rdk-ops-action': 'observability', ...extra };
}
function get(path: string, user = 'alice', extra: Record<string, string> = {}) {
  return fetch(origin + API + path, { headers: headers(user, extra) });
}
function post(path: string, body: unknown, user = 'alice', extra: Record<string, string> = {}) {
  return fetch(origin + API + path, { method: 'POST', headers: headers(user, extra), body: JSON.stringify(body) });
}
async function json(response: Response, status = 200): Promise<any> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function invoke(status: number, user = 'alice', extra: Record<string, string> = {}) {
  const result = await json(await fetch(origin + '/fixture/invoke', {
    method: 'POST', headers: headers(user, extra), body: JSON.stringify({ status }),
  }));
  assert.equal(result.status, status);
  assert.equal(result.ok, false);
  await flushRsiPlatformFailures();
  return result;
}
async function evidence(user = 'alice') { return (await json(await get('/evidence', user))).overview; }
async function confirm(id: string, expectedReason: RsiReason, slice: RsiSlice) {
  const current = await evidence();
  return json(await post(`/evidence/${id}/confirm`, { expectedRevision: current.revision, expectedReason, slice }));
}
async function observedLoop() {
  for (const status of [401, 504, 408]) await invoke(status);
  const initial = await evidence();
  const find = (status: number) => initial.records.find((item: any) => item.input.httpStatus === status).id;
  await confirm(find(401), 'auth_denied', 'frozen');
  await confirm(find(504), 'timeout', 'adaptive');
  await confirm(find(408), 'timeout', 'holdout');
  const current = await evidence();
  return (await json(await post('/evidence/experiment', {
    expectedRevision: current.revision, evidenceIds: current.records.map((item: any) => item.id), title: '真实调用测试夹具 · 超时归因',
  }), 201)).loop;
}
async function acceptLoop(loop: any) {
  for (const action of ['propose', 'replay', 'accept']) {
    loop = (await json(await post(`/loops/${loop.id}/${action}`, { expectedRevision: loop.revision }))).loop;
  }
  return loop;
}

test('evidence reads require operator account identity and publish only reviewed read capability', async () => {
  const router = await start();
  for (const auth of [{}, { 'x-admin-token': 'wrong' }, { 'x-fixture-user': 'outsider' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) {
    assert.equal((await fetch(origin + API + '/evidence', { headers: auth })).status, 403);
  }
  assert.equal((await get('/evidence', 'alice', { 'x-fixture-tenant': '1' })).status, 403);
  const response = await get('/evidence', 'alice', { 'x-rdk-ops-read-only': '1' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-rdk-ops-read-only'), '1');
  const body = await json(response);
  assert.equal(body.contract, RSI_LEARNING_CONTRACT);
  assert.equal(body.readOnly, true);
  assert.equal(body.overview.binding, null);
  const prefixed = await json(await fetch(origin + '/prefix' + API + '/evidence', { headers: headers() }));
  assert.equal(prefixed.readOnly, false);
  const published = listPlatformOperations(router).filter((item) => item.id.includes('/evidence'));
  assert.deepEqual(published.map((item) => item.id), Object.keys(RSI_FAILURE_OPERATIONS));
  assert.ok(published.every((item) => !item.mutating && !item.tenantAccessible));
});

test('evidence mutations enforce CSRF, origin, readonly and tenant guards before storage', async () => {
  await start();
  const paths = [`/evidence/${randomUUID()}/confirm`, `/evidence/${randomUUID()}/exclude`, '/evidence/experiment', '/binding'];
  for (const path of paths) {
    assert.equal((await post(path, {}, 'alice', { 'x-rdk-ops-action': '' })).status, 400);
    assert.equal((await post(path, {}, 'alice', { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await post(path, {}, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
    assert.equal((await post(path, {}, 'alice', { 'x-fixture-tenant': '1' })).status, 403);
  }
  assert.equal((await evidence()).revision, 1);
});

test('evidence requests reject ownership, raw observation writes and malformed bodies', async () => {
  await start();
  assert.equal((await get('/evidence?owner=sso:bob')).status, 400);
  for (const body of [null, [], 'payload', {}, { expectedRevision: '1', loopId: null }, { expectedRevision: -1, loopId: null },
    { expectedRevision: 1.5, loopId: null }, { expectedRevision: 1, loopId: null, owner: 'sso:bob' }]) {
    assert.equal((await post('/binding', body)).status, 400);
  }
  assert.equal((await post('/evidence', { operationId: FIXTURE_OPERATION, input: { httpStatus: 504 } })).status, 404);
  assert.equal((await post('/evidence/observe', { status: 504 })).status, 404);
  await invoke(504);
  const current = await evidence();
  const id = current.records[0].id;
  const valid = { expectedRevision: current.revision, expectedReason: 'timeout', slice: 'adaptive' };
  for (const body of [{ ...valid, input: { httpStatus: 401 } }, { ...valid, expectedReason: 'secret-text' },
    { ...valid, slice: 'production' }, { ...valid, owner: 'sso:bob' }]) {
    assert.equal((await post(`/evidence/${id}/confirm`, body)).status, 400);
  }
  assert.equal((await post('/evidence/experiment', { expectedRevision: current.revision,
    evidenceIds: [id, id, id], title: '重复证据', provenance: [] })).status, 400);
});

test('account isolation, stale evidence revisions and exclusion preserve bounded errors', async () => {
  await start();
  await invoke(504);
  let current = await evidence();
  const id = current.records[0].id;
  assert.equal((await evidence('bob')).records.length, 0);
  assert.equal((await post(`/evidence/${id}/confirm`, { expectedRevision: current.revision, expectedReason: 'timeout', slice: 'adaptive' }, 'bob')).status, 404);
  const stale = await json(await post(`/evidence/${id}/exclude`, { expectedRevision: current.revision - 1 }), 409);
  assert.equal(stale.error, 'rsi_inbox_stale_revision');
  assert.equal((await evidence()).revision, current.revision);
  current = (await json(await post(`/evidence/${id}/exclude`, { expectedRevision: current.revision }))).overview;
  assert.equal(current.records[0].status, 'excluded');
  assert.equal(current.counts.excluded, 1);
  const finalized = await json(await post(`/evidence/${id}/confirm`, { expectedRevision: current.revision, expectedReason: 'timeout', slice: 'adaptive' }), 409);
  assert.equal(finalized.error, 'rsi_inbox_record_finalized');
});

test('actual platform failure receipts become frozen confirmed cases and accepted runtime classification', async () => {
  await start();
  let loop = await observedLoop();
  assert.equal(loop.provenance.length, 3);
  assert.ok(loop.cases.every((item: any) => item.source === 'operator'));
  assert.deepEqual(new Set(loop.cases.map((item: any) => item.slice)), new Set(['frozen', 'adaptive', 'holdout']));
  for (const item of loop.cases) {
    const provenance = loop.provenance.find((ref: any) => ref.caseId === item.id);
    assert.equal(provenance.operationId, FIXTURE_OPERATION);
    assert.equal(item.id, 'evidence.' + provenance.evidenceId);
    assert.match(provenance.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance.confirmedAt >= provenance.observedAt);
  }
  let current = await evidence();
  const withoutAcceptance = await json(await post('/binding', { expectedRevision: current.revision, loopId: loop.id }), 409);
  assert.equal(withoutAcceptance.error, 'rsi_binding_acceptance_required');
  loop = await acceptLoop(loop);
  assert.equal(loop.replays.at(-1).report.gate.passed, true);
  assert.equal(loop.replays.at(-1).report.scenarios.candidate.slices.holdout.accuracy, 1);
  const acceptedId = loop.activeVersionId;
  const binding = (await json(await post('/binding', { expectedRevision: current.revision, loopId: loop.id }))).overview;
  assert.deepEqual(binding.binding, { loopId: loop.id, activeVersionId: acceptedId, usable: true, state: 'accepted' });
  assert.equal((await post('/binding', { expectedRevision: binding.revision, loopId: loop.id }, 'bob')).status, 404);

  await invoke(502);
  current = await evidence();
  const future = current.records.find((item: any) => item.input.httpStatus === 502);
  assert.equal(future.source, 'platform_operation');
  assert.equal(future.status, 'unconfirmed');
  assert.equal(future.expectedReason, null);
  assert.equal(future.slice, null);
  assert.deepEqual(future.classification, { loopId: loop.id, activeVersionId: acceptedId, reason: 'timeout' });
  assert.equal(future.suggestedReason, 'timeout');
  assert.doesNotMatch(JSON.stringify(current), /private raw response|private\/fixtures|raw.json/);

  loop = (await json(await post(`/loops/${loop.id}/rollback`, { expectedRevision: loop.revision, versionId: loop.initialVersionId }))).loop;
  assert.equal((await evidence()).binding.usable, false);
  await invoke(503);
  current = await evidence();
  assert.equal(current.records.find((item: any) => item.input.httpStatus === 503).classification, null);
  current = (await json(await post('/binding', { expectedRevision: current.revision, loopId: null }))).overview;
  assert.equal(current.activeLoopId, null);
  assert.equal(current.binding, null);
});

test('retiring bound source evidence pauses learned classification and preserves frozen experiment evidence', async () => {
  await start();
  const loop = await acceptLoop(await observedLoop());
  let current = await evidence();
  current = (await json(await post('/binding', { expectedRevision: current.revision, loopId: loop.id }))).overview;
  assert.equal(current.binding.usable, true);
  const frozenHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = {
    cases: frozenHash(loop.cases), provenance: frozenHash(loop.provenance), replays: frozenHash(loop.replays),
    casesHash: loop.casesHash, reportHashes: loop.replays.map((item: any) => item.reportHash),
  };
  const timeoutCase = loop.cases.find((item: any) => item.slice === 'adaptive' && item.expectedReason === 'timeout');
  const reference = loop.provenance.find((item: any) => item.caseId === timeoutCase.id);
  const original = current.records.find((item: any) => item.id === reference.evidenceId);
  assert.equal(original.status, 'confirmed');
  const exclusion = await json(await post(`/evidence/${original.id}/exclude`, { expectedRevision: current.revision }));
  assert.equal(exclusion.evidence.status, 'excluded');
  assert.equal(exclusion.evidence.expectedReason, original.expectedReason);
  assert.equal(exclusion.evidence.slice, original.slice);
  assert.equal(exclusion.evidence.confirmedAt, original.confirmedAt);

  current = await evidence();
  assert.deepEqual(current.binding, {
    loopId: loop.id, activeVersionId: loop.activeVersionId, usable: false, state: 'evidence_excluded',
  });
  const retired = await json(await post('/binding', { expectedRevision: current.revision, loopId: loop.id }), 409);
  assert.equal(retired.error, 'rsi_binding_evidence_retired');
  assert.equal((await evidence()).revision, current.revision);

  // A later real platform-operation receipt is retained, while the retired
  // experiment no longer supplies a classification or a human label.
  await invoke(502);
  current = await evidence();
  const future = current.records.find((item: any) => item.input.httpStatus === 502);
  assert.ok(future);
  assert.equal(future.source, 'platform_operation');
  assert.equal(future.classification, null);
  assert.equal(future.suggestedReason, 'timeout');
  assert.equal(future.expectedReason, null);
  assert.equal(future.slice, null);
  assert.equal(future.status, 'unconfirmed');
  assert.equal(current.counts.total, 4);
  assert.equal(current.counts.excluded, 1);
  assert.equal(current.counts.confirmed, 2);
  const retainedSource = current.records.find((item: any) => item.id === original.id);
  assert.equal(retainedSource.status, 'excluded');
  assert.equal(retainedSource.expectedReason, original.expectedReason);
  assert.equal(retainedSource.slice, original.slice);
  const after = (await json(await get(`/loops/${loop.id}`))).loop;
  assert.equal(after.activeVersionId, loop.activeVersionId);
  assert.equal(after.revision, loop.revision);
  assert.deepEqual({
    cases: frozenHash(after.cases), provenance: frozenHash(after.provenance), replays: frozenHash(after.replays),
    casesHash: after.casesHash, reportHashes: after.replays.map((item: any) => item.reportHash),
  }, before);
});

test('binding blocks synthetic accepted versions and pending candidates', async () => {
  await start();
  let demo = (await json(await post('/demo', {}), 201)).loop;
  demo = await acceptLoop(demo);
  let current = await evidence();
  const synthetic = await json(await post('/binding', { expectedRevision: current.revision, loopId: demo.id }), 409);
  assert.equal(synthetic.error, 'rsi_binding_observed_evidence_required');
  const loop = await observedLoop();
  const pending = (await json(await post(`/loops/${loop.id}/propose`, { expectedRevision: loop.revision }))).loop;
  assert.ok(pending.candidateVersionId);
  current = await evidence();
  const candidate = await json(await post('/binding', { expectedRevision: current.revision, loopId: loop.id }), 409);
  assert.equal(candidate.error, 'rsi_candidate_pending');
  assert.equal((await evidence()).activeLoopId, null);
});

test('experimental creation requires human labels, all slices and independent inputs', async () => {
  await start();
  for (const status of [401, 504, 408]) await invoke(status);
  let current = await evidence();
  const ids = current.records.map((item: any) => item.id);
  const unconfirmed = await json(await post('/evidence/experiment', { expectedRevision: current.revision, evidenceIds: ids, title: '未确认' }), 409);
  assert.equal(unconfirmed.error, 'rsi_inbox_confirmation_required');
  for (const item of current.records) await confirm(item.id, item.input.httpStatus === 401 ? 'auth_denied' : 'timeout', 'adaptive');
  current = await evidence();
  const missingSlices = await json(await post('/evidence/experiment', { expectedRevision: current.revision, evidenceIds: ids, title: '切片不足' }), 400);
  assert.equal(missingSlices.error, 'rsi_inbox_slices_required');
  assert.equal((await ledger.overview('sso:alice')).loops.length, 0);
});

test('injected access cannot grant a generic anonymous owner or leak storage paths', async () => {
  await start({ access: (_req, _res, next) => next(), owner: () => 'ops-admin' });
  assert.equal((await get('/evidence')).status, 403);
  assert.equal((await post('/binding', { expectedRevision: 1, loopId: null })).status, 403);
});

test('unexpected evidence storage failures return only a bounded redacted machine code', async () => {
  await start({ service: { overview: () => { throw new Error('ENOENT /private/inbox/sso-alice.json'); } } as unknown as RsiFailureInboxService });
  const response = await get('/evidence');
  const body = await json(response, 503);
  assert.deepEqual(body, { ok: false, error: 'rsi_learning_unavailable' });
});
