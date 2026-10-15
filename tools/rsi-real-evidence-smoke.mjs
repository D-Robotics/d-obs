#!/usr/bin/env node
/**
 * Reproduce the real HTTP collection/application path using local test fixtures.
 * Run: node --import tsx tools/rsi-real-evidence-smoke.mjs [--state-dir DIR] [--output FILE]
 * No production data, environment credentials, external requests or device actions.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import { RsiFailureInboxService } from '../server/evolution/rsi-failure-inbox.ts';
import { RsiLedgerService } from '../server/evolution/rsi-ledger.ts';
import { registerRsiFailureRoutes } from '../server/monitoring/rsi-failure-routes.ts';
import { registerRsiLearningRoutes } from '../server/monitoring/rsi-learning-routes.ts';
import { RSI_LEARNING_API as API } from '../server/monitoring/rsi-learning-operations.ts';
import { PLATFORM_OPERATION_METADATA } from '../server/monitoring/platform-operation-metadata.ts';
import { executePlatformOperation, registerPlatformOperations } from '../server/monitoring/platform-operations.ts';
import {
  configureRsiFailureObserverForTests, flushRsiPlatformFailures, RsiFailureObserver,
} from '../server/monitoring/rsi-failure-observer.ts';

const usage = 'Usage: node --import tsx tools/rsi-real-evidence-smoke.mjs [--state-dir DIR] [--output FILE]';
const options = {};
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index += 2) {
  const option = argumentsList[index];
  const value = argumentsList[index + 1];
  if (!['--state-dir', '--output'].includes(option) || options[option] || !value || value.startsWith('--')) throw new Error(usage);
  options[option] = value;
}

// Dedicated fixture credentials are supplied only by this process. No ambient
// token, SSO session, configured host or production operation is consulted.
const FIXTURE_KEY = 'fixture-only-rsi-real-evidence-smoke';
const owner = 'fixture:rsi-real-evidence-smoke:' + randomUUID();
const operationId = 'GET /api/ops/observability/rdk-logs/captures/:id/evidence';
const operationPath = operationId.slice(4);
const fixtures = [
  { id: 'frozen-auth', input: { httpStatus: 401 }, slice: 'frozen', expectedReason: 'auth_denied' },
  { id: 'frozen-missing', input: { httpStatus: 404 }, slice: 'frozen', expectedReason: 'not_found' },
  { id: 'frozen-input', input: { httpStatus: 400 }, slice: 'frozen', expectedReason: 'invalid_input' },
  { id: 'adaptive-timeout', input: { httpStatus: 504, errorCode: 'ETIMEDOUT' }, slice: 'adaptive', expectedReason: 'timeout' },
  { id: 'adaptive-rate', input: { httpStatus: 429, errorCode: 'RATE_LIMITED' }, slice: 'adaptive', expectedReason: 'rate_limited' },
  { id: 'holdout-timeout', input: { httpStatus: 408, errorCode: 'ETIMEDOUT' }, slice: 'holdout', expectedReason: 'timeout' },
  { id: 'holdout-rate', input: { httpStatus: 503, errorCode: 'RATE_LIMITED' }, slice: 'holdout', expectedReason: 'rate_limited' },
];
const futureFixture = { id: 'future-timeout', input: { httpStatus: 502, errorCode: 'ETIMEDOUT' } };
const receipts = new Map([...fixtures, futureFixture].map((fixture) => [fixture.id, fixture]));
const runDirectory = options['--state-dir'] ? resolve(options['--state-dir']) : await mkdtemp(join(tmpdir(), 'd-obs-rsi-evidence-fixture-'));
const stateDir = join(runDirectory, 'fixture-' + randomUUID());
const output = resolve(options['--output'] ?? join(runDirectory, 'rsi-fixture-manifest.json'));
const inbox = new RsiFailureInboxService({ stateDir: join(stateDir, 'inbox'), operationIds: [operationId] });
const ledger = new RsiLedgerService({ stateDir: join(stateDir, 'ledger') });
const observer = new RsiFailureObserver({ inbox, ledger, owner: () => owner,
  allowed: (req) => req.header('x-rsi-smoke-fixture-key') === FIXTURE_KEY });
configureRsiFailureObserverForTests(observer);

const app = express();
app.use(express.json());
const access = (req, res, next) => {
  if (req.header('x-rsi-smoke-fixture-key') !== FIXTURE_KEY) {
    res.status(403).json({ ok: false, error: 'fixture_access_required' });
    return;
  }
  next();
};
const router = express.Router();
registerRsiFailureRoutes(router, { service: inbox, ledger, access, owner: () => owner });
registerRsiLearningRoutes(router, { service: ledger, access, owner: () => owner });
// This reviewed operation template resolves only to this in-process fixture
// handler. There is no connection to a real RDK capture source.
router.get(operationPath, access, (req, res) => {
  const fixture = receipts.get(req.params.id);
  if (!fixture) { res.status(404).json({ ok: false, error: 'fixture_not_found' }); return; }
  res.status(fixture.input.httpStatus).json({ ok: false, source: 'fixture',
    error: fixture.input.errorCode ?? 'fixture_http_failure',
    message: 'fixture raw text must not enter inbox', debug: '/fixture-only/private/raw.json' });
});
registerPlatformOperations(router, { [operationId]: PLATFORM_OPERATION_METADATA[operationId] });
router.post('/fixture/invoke', access, async (req, res) => {
  if (!receipts.has(req.body.fixtureId)) {
    res.status(400).json({ ok: false, error: 'invalid_fixture_id' });
    return;
  }
  res.json(await executePlatformOperation(router, req, res, operationId, { params: { id: req.body.fixtureId } }));
});
app.use(router);
const server = createServer(app);
let origin;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const sameInput = (before, after) => canonical(before) === canonical(after);

async function request(path, body, expectedStatus = 200) {
  assert.ok(origin?.startsWith('http://127.0.0.1:'), 'Smoke requests must stay on the random local loopback server');
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-rsi-smoke-fixture-key': FIXTURE_KEY,
      'x-rdk-ops-action': 'observability', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text);
}
async function overview() { return (await request(API + '/evidence')).overview; }
async function invoke(fixture) {
  const result = await request('/fixture/invoke', { fixtureId: fixture.id });
  assert.equal(result.ok, false);
  assert.equal(result.status, fixture.input.httpStatus);
  await flushRsiPlatformFailures();
  const current = await overview();
  const evidence = current.records.find((record) => sameInput(record.input, fixture.input));
  assert.ok(evidence, 'The actual platform-operation receipt must be captured by the observer');
  assert.equal(evidence.operationId, operationId);
  assert.doesNotMatch(JSON.stringify(current), /fixture raw text|fixture-only\/private|raw.json/);
  return { overview: current, evidence };
}

try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  const observations = [];
  for (const fixture of fixtures) {
    const result = await invoke(fixture);
    assert.equal(result.evidence.status, 'unconfirmed');
    assert.equal(result.evidence.expectedReason, null);
    observations.push({ source: 'fixture', fixtureId: fixture.id, input: fixture.input,
      evidenceId: result.evidence.id, fingerprint: result.evidence.fingerprint,
      observedAt: result.evidence.observedAt, observationRevision: result.overview.revision });
  }

  const confirmations = [];
  for (const fixture of fixtures) {
    const current = await overview();
    const item = current.records.find((record) => sameInput(record.input, fixture.input));
    const confirmed = await request(API + '/evidence/' + item.id + '/confirm', {
      expectedRevision: current.revision, expectedReason: fixture.expectedReason, slice: fixture.slice,
    });
    assert.equal(confirmed.evidence.status, 'confirmed');
    confirmations.push({ source: 'fixture', fixtureId: fixture.id, evidenceId: item.id,
      expectedReason: confirmed.evidence.expectedReason, slice: confirmed.evidence.slice,
      confirmedAt: confirmed.evidence.confirmedAt, confirmationRevision: confirmed.overview.revision });
  }
  const confirmed = await overview();
  assert.equal(confirmed.counts.confirmed, 7);
  // Evidence order is explicit: timeout is learned first, then rate limiting.
  const evidenceIds = fixtures.map((fixture) => observations.find((item) => item.fixtureId === fixture.id).evidenceId);
  let loop = (await request(API + '/evidence/experiment', { expectedRevision: confirmed.revision,
    evidenceIds, title: '本地测试夹具 · 两轮失败归因继承' }, 201)).loop;
  assert.equal(loop.provenance.length, fixtures.length);
  assert.equal(new Set(loop.provenance.map((item) => item.evidenceId)).size, fixtures.length);
  const initialVersionId = loop.initialVersionId;
  const provenanceHash = hash(loop.provenance);
  const rounds = [];
  for (let round = 1; round <= 2; round += 1) {
    const loadedVersionId = loop.activeVersionId;
    loop = (await request(API + '/loops/' + loop.id + '/propose', { expectedRevision: loop.revision })).loop;
    const candidate = loop.versions.find((version) => version.id === loop.candidateVersionId);
    assert.equal(candidate.loadedVersionId, loadedVersionId);
    assert.equal(candidate.parentVersionId, loadedVersionId);
    loop = (await request(API + '/loops/' + loop.id + '/replay', { expectedRevision: loop.revision })).loop;
    const replay = loop.replays.at(-1);
    assert.equal(replay.report.gate.passed, true);
    assert.equal(replay.report.budget.equalPerCaseLimit, true);
    assert.equal(replay.report.budget.withinBudget, true);
    assert.equal(replay.counterfactualLoadedVersionId, initialVersionId);
    loop = (await request(API + '/loops/' + loop.id + '/accept', { expectedRevision: loop.revision })).loop;
    assert.equal(hash(loop.provenance), provenanceHash);
    rounds.push({ round, loadedVersionId, candidateVersionId: candidate.id, acceptedVersionId: loop.activeVersionId,
      addedRule: candidate.proposal.addedRule, replayId: replay.id, decisionId: loop.decisions.at(-1).id,
      casesHash: replay.casesHash, provenanceHash, reportHash: replay.reportHash, report: replay.report });
  }
  assert.equal(rounds[0].report.scenarios.candidate.slices.holdout.accuracy, 0.5);
  assert.equal(rounds[1].report.scenarios.candidate.slices.holdout.accuracy, 1);
  assert.equal(rounds[1].report.scenarios.noRetention.slices.holdout.accuracy, 0.5);
  assert.equal(rounds[1].report.retention.holdout.accuracyDelta, 0.5);
  assert.equal(rounds[1].loadedVersionId, rounds[0].acceptedVersionId);
  const current = await overview();
  const binding = (await request(API + '/binding', { expectedRevision: current.revision, loopId: loop.id })).overview;
  assert.equal(binding.binding.usable, true);
  assert.equal(binding.binding.activeVersionId, rounds[1].acceptedVersionId);

  const future = await invoke(futureFixture);
  assert.equal(future.evidence.status, 'unconfirmed');
  assert.equal(future.evidence.expectedReason, null);
  assert.equal(future.evidence.slice, null);
  assert.deepEqual(future.evidence.classification, {
    loopId: loop.id, activeVersionId: rounds[1].acceptedVersionId, reason: 'timeout',
  });
  const learningApplication = { source: 'fixture', evidenceId: future.evidence.id,
    input: future.evidence.input, observationCount: future.evidence.count, status: future.evidence.status,
    expectedReason: future.evidence.expectedReason, slice: future.evidence.slice,
    classification: future.evidence.classification, actualAcceptedVersionUsed: true };

  loop = (await request(API + '/loops/' + loop.id + '/rollback', {
    expectedRevision: loop.revision, versionId: initialVersionId,
  })).loop;
  const rollbackBinding = (await overview()).binding;
  assert.equal(rollbackBinding.usable, false);
  const afterRollback = await invoke(futureFixture);
  assert.equal(afterRollback.evidence.classification, null);
  assert.equal(afterRollback.evidence.expectedReason, null);
  assert.equal(afterRollback.evidence.count, 2);
  const rollback = { source: 'fixture', decisionId: loop.decisions.at(-1).id, activeVersionId: loop.activeVersionId,
    binding: rollbackBinding, evidenceId: afterRollback.evidence.id, observationCount: afterRollback.evidence.count,
    classification: afterRollback.evidence.classification, learnedClassificationStopped: true };

  const manifest = {
    contract: 'rdk.rsi-real-evidence-smoke.v1', source: 'fixture', scope: 'local_loopback_test_fixture',
    productionDataUsed: false, productionImprovementClaimed: false, externalRequests: false,
    labelAuthority: 'preset_fixture_labels_submitted_through_operator_confirmation_http',
    collectionPath: 'Express fixture handler -> executePlatformOperation -> finish observer -> owner inbox',
    generatedAt: new Date().toISOString(), stateDir, owner, operationId, loopId: loop.id,
    initialVersionId, casesHash: loop.casesHash, provenanceHash,
    observations, confirmations, provenance: loop.provenance, rounds,
    bindingBeforeRollback: binding.binding, learningApplication, rollback,
    explanation: 'The operation receipt, confirmation, replay, binding and application paths are real local code execution. All seven training/evaluation inputs and the later failure are controlled fixtures; this demonstrates the pipeline and retention comparison, not production quality or autonomous human labeling.',
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ source: 'fixture', passed: true, output, loopId: loop.id,
    holdoutAccuracy: rounds.map((round) => round.report.scenarios.candidate.slices.holdout.accuracy),
    secondRoundNoRetentionAccuracy: 0.5, acceptedVersionApplied: true, rollbackStoppedApplication: true }));
} finally {
  await flushRsiPlatformFailures();
  configureRsiFailureObserverForTests();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
}
