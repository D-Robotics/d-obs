import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createRsiLedgerService, type RsiLedgerService } from '../evolution/rsi-ledger.js';
import { BASELINE_RULES, DEMO_CASES } from '../evolution/rsi-replay.js';
import {
  registerRsiLearningRoutes, RSI_LEARNING_API as API, RSI_LEARNING_CONTRACT,
  RSI_LEARNING_OPERATIONS, type RsiLearningRouteOptions,
} from './rsi-learning-routes.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { listPlatformOperations } from './platform-operations.js';

let server: Server;
let origin: string;
let directory: string;
let service: RsiLedgerService;
let saved: Record<string, string | undefined>;

async function start(options: RsiLearningRouteOptions = {}) {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((req, _res, next) => {
    if (req.header('x-fixture-tenant') === '1') {
      req.opsTenantAccess = { tenantId: 'tenant-a', displayName: 'Tenant A', source: 'member', role: 'owner' };
    }
    next();
  });
  const router = express.Router();
  registerRsiLearningRoutes(router, { service, ...options });
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
  directory = await mkdtemp(join(tmpdir(), 'd-obs-rsi-http-'));
  service = createRsiLedgerService({ stateDir: directory });
});

afterEach(async () => {
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

test('RSI ledger reads require operator authority and account identity, without widening tenant access', async () => {
  const router = await start();
  for (const path of ['/capabilities', '/loops']) {
    for (const auth of [{}, { 'x-admin-token': 'wrong' }, { 'x-fixture-user': 'outsider' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) {
      assert.equal((await fetch(origin + API + path, { headers: auth })).status, 403);
    }
    assert.equal((await get(path, 'alice', { 'x-fixture-tenant': '1' })).status, 403);
  }
  const prefix = await json(await fetch(origin + '/prefix' + API + '/capabilities', { headers: headers() }));
  assert.equal(prefix.contract, RSI_LEARNING_CONTRACT);
  assert.equal(prefix.readOnly, false);
  const readonly = await get('/loops', 'alice', { 'x-rdk-ops-read-only': '1' });
  assert.equal(readonly.headers.get('x-rdk-ops-read-only'), '1');
  assert.equal((await json(readonly)).readOnly, true);
  const token = await json(await fetch(origin + API + '/capabilities', { headers: { 'x-admin-token': 'fixture-admin' } }));
  assert.equal(token.contract, RSI_LEARNING_CONTRACT);
  assert.deepEqual(listPlatformOperations(router).map((operation) => operation.id).sort(), Object.keys(RSI_LEARNING_OPERATIONS).sort());
  assert.ok(listPlatformOperations(router).every((operation) => !operation.mutating && !operation.tenantAccessible));
});

test('all RSI mutations require CSRF intent, same origin and writable operator scope', async () => {
  await start();
  assert.equal((await post('/demo', {}, 'alice', { 'x-rdk-ops-action': '' })).status, 400);
  assert.equal((await post('/demo', {}, 'alice', { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('/demo', {}, 'alice', { origin: 'malformed-origin' })).status, 403);
  const actions = ['/demo', '/loops', ...['propose', 'replay', 'accept', 'reject', 'rollback'].map((action) => '/loops/unknown/' + action)];
  for (const path of actions) {
    assert.equal((await post(path, {}, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
    assert.equal((await post(path, {}, 'alice', { 'x-fixture-tenant': '1' })).status, 403);
  }
  assert.equal((await json(await get('/loops'))).overview.loops.length, 0);
  assert.equal((await post('/demo', {}, 'alice', { origin })).status, 201);
});

test('RSI requests reject caller ownership claims, extra payloads and malformed revisions', async () => {
  await start();
  for (const body of [{ owner: 'sso:bob' }, { command: 'run' }, { source: 'real' }, [], 'synthetic', null]) {
    assert.equal((await post('/demo', body)).status, 400);
  }
  assert.equal((await get('/loops?owner=sso:bob')).status, 400);
  assert.equal((await post('/loops', { title: 'owned', cases: [], owner: 'sso:bob' })).status, 400);
  const loop = (await json(await post('/demo', {}), 201)).loop;
  for (const action of ['propose', 'replay', 'accept', 'reject', 'rollback']) {
    for (const body of [{}, { expectedRevision: '1' }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { expectedRevision: loop.revision, owner: 'sso:bob' }]) {
      assert.equal((await post(`/loops/${loop.id}/${action}`, body)).status, 400);
    }
  }
});

test('injected access cannot grant anonymous generic owner or tenant an RSI ledger', async () => {
  await start({ access: (_req, _res, next) => next(), owner: () => 'ops-admin' });
  assert.equal((await get('/capabilities')).status, 403);
  assert.equal((await post('/demo', {})).status, 403);
});

test('RSI unexpected storage failures return a bounded code without file paths', async () => {
  await start({ service: { capabilities: () => { throw new Error('ENOENT /private/ledger/alice.json'); } } as unknown as RsiLedgerService });
  const response = await get('/capabilities');
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /rsi_learning_unavailable/);
  assert.doesNotMatch(body, /private|alice.json|ENOENT/);
});

test('HTTP demo learns two inherited rounds with a fixed baseline, stale revisions and owned classification', async () => {
  await start();
  assert.equal((await json(await get('/loops'))).overview.status, 'empty');
  let loop = (await json(await post('/demo', {}), 201)).loop;
  const id = loop.id;
  const baselineVersionId = loop.activeVersionId;
  const classifyPath = `/loops/${id}/classify?httpStatus=408&errorCode=ETIMEDOUT`;
  const before = await json(await get(classifyPath));
  assert.equal(before.activeVersionId, baselineVersionId);
  assert.equal(before.classification.reason, 'unknown');
  assert.equal((await json(await get(`/loops/${id}`))).loop.revision, loop.revision);

  const mutate = async (action: string, extra: object = {}) => {
    loop = (await json(await post(`/loops/${id}/${action}`, { expectedRevision: loop.revision, ...extra }))).loop;
    return loop;
  };
  await mutate('propose');
  const proposedRevision = loop.revision;
  assert.equal((await post(`/loops/${id}/accept`, { expectedRevision: loop.revision })).status, 409);
  const stale = await json(await post(`/loops/${id}/replay`, { expectedRevision: loop.revision - 1 }), 409);
  assert.equal(stale.error, 'rsi_stale_revision');
  assert.equal((await json(await get(`/loops/${id}`))).loop.revision, proposedRevision);
  await mutate('replay');
  await mutate('accept');
  const firstVersionId = loop.activeVersionId;
  assert.notEqual(firstVersionId, baselineVersionId);
  const learned = await json(await get(classifyPath));
  assert.equal(learned.activeVersionId, firstVersionId);
  assert.equal(learned.classification.reason, 'timeout');

  await mutate('propose');
  const secondCandidate = loop.versions.at(-1);
  assert.equal(secondCandidate.parentVersionId, firstVersionId);
  assert.equal(secondCandidate.loadedVersionId, firstVersionId);
  await mutate('replay');
  const secondReplay = loop.replays.at(-1);
  assert.equal(secondReplay.loadedVersionId, firstVersionId);
  assert.equal(secondReplay.counterfactualLoadedVersionId, baselineVersionId);
  assert.equal(secondReplay.casesHash, loop.replays[0].casesHash);
  assert.equal(secondReplay.report.scenarios.candidate.slices.holdout.accuracy, 1);
  assert.equal(secondReplay.report.scenarios.noRetention.slices.holdout.accuracy, 0.5);
  assert.equal(secondReplay.report.retention.holdout.accuracyDelta, 0.5);
  assert.equal(secondReplay.report.budget.equalPerCaseLimit, true);
  assert.equal(secondReplay.report.budget.withinBudget, true);
  await mutate('accept');
  assert.notEqual(loop.activeVersionId, firstVersionId);
  const active = loop.versions.find((version: any) => version.id === loop.activeVersionId);
  assert.equal(active.rules.length, BASELINE_RULES.length + 2);
  const rate = await json(await get(`/loops/${id}/classify?httpStatus=503&errorCode=RATE_LIMITED`));
  assert.equal(rate.activeVersionId, loop.activeVersionId);
  assert.equal(rate.classification.reason, 'rate_limited');
  assert.equal((await json(await get(classifyPath))).classification.reason, 'timeout');

  assert.equal((await get(`/loops/${id}`, 'bob')).status, 404);
  assert.equal((await get(classifyPath, 'bob')).status, 404);
  for (const action of ['propose', 'replay', 'accept', 'reject', 'rollback']) {
    assert.equal((await post(`/loops/${id}/${action}`, {
      expectedRevision: loop.revision,
      ...(action === 'rollback' ? { versionId: baselineVersionId } : {}),
    }, 'bob')).status, 404);
  }
  assert.equal((await json(await get('/loops', 'bob'))).overview.loops.length, 0);
  const overview = (await json(await get('/loops'))).overview;
  assert.equal(overview.counts.acceptedRounds, 2);
  assert.equal(overview.counts.inheritedRounds, 1);
  await mutate('rollback', { versionId: baselineVersionId });
  assert.equal(loop.activeVersionId, baselineVersionId);
  assert.equal((await json(await get(classifyPath))).classification.reason, 'unknown');
});

test('a replay regression is recorded and blocks acceptance before explicit rejection', async () => {
  await start();
  const cases = DEMO_CASES.map((item) => item.id === 'frozen.auth'
    ? { ...item, input: { httpStatus: 401, errorCode: 'ETIMEDOUT' } }
    : item);
  let loop = (await json(await post('/loops', { title: '冻结案例回归验证', cases, rules: BASELINE_RULES }), 201)).loop;
  const baselineVersionId = loop.activeVersionId;
  loop = (await json(await post(`/loops/${loop.id}/propose`, { expectedRevision: loop.revision }))).loop;
  loop = (await json(await post(`/loops/${loop.id}/replay`, { expectedRevision: loop.revision }))).loop;
  assert.equal(loop.replays.at(-1).report.gate.passed, false);
  assert.ok(loop.replays.at(-1).report.gate.reasons.includes('frozen_regression'));
  const revision = loop.revision;
  const response = await json(await post(`/loops/${loop.id}/accept`, { expectedRevision: revision }), 409);
  assert.equal(response.error, 'rsi_gate_failed');
  assert.equal((await json(await get(`/loops/${loop.id}`))).loop.activeVersionId, baselineVersionId);
  loop = (await json(await post(`/loops/${loop.id}/reject`, { expectedRevision: revision }))).loop;
  assert.equal(loop.activeVersionId, baselineVersionId);
  assert.equal(loop.decisions.at(-1).action, 'reject');
  assert.equal(loop.replays.at(-1).report.gate.passed, false);
  assert.ok(loop.revision > revision);
});

test('classification accepts only bounded structured input and never writes a ledger revision', async () => {
  await start();
  const loop = (await json(await post('/demo', {}), 201)).loop;
  const path = `/loops/${loop.id}/classify`;
  for (const query of [
    '?httpStatus=099', '?httpStatus=600', '?httpStatus=401.0', '?httpStatus=401&httpStatus=500',
    '?errorCode=caller-secret', '?log=raw-text', '?owner=sso:bob', '?httpStatus[]=401',
  ]) assert.equal((await get(path + query)).status, 400);
  const result = await json(await get(path + '?httpStatus=401'));
  assert.equal(result.classification.reason, 'auth_denied');
  assert.equal(result.activeVersionId, loop.activeVersionId);
  assert.equal((await json(await get(`/loops/${loop.id}`))).loop.revision, loop.revision);
  assert.equal((await get(path + '?httpStatus=401', 'alice', { 'x-fixture-tenant': '1' })).status, 403);
});
