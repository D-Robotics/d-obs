import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { type RemediationRun } from './alert-remediation.js';
import { type ActionStorePool, type ObservabilityActionRecord, resetObservabilityActionSchemaReadinessForTest } from './observability-action-loop.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { createObservabilityActionRouter, type ObservabilityActionRouterOptions } from './observability-action-routes.js';
import { actionRegressionMarker, buildActionRegressionSnapshot, ObservabilityActionRegressionError, ObservabilityActionRegressionService, type ObservabilityActionRegressionCase } from './observability-action-regression.js';

const ACTION_ID = 'action-0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';
const RUN_ID = '1f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';
const START = '2026-10-12T12:00:00.000Z';
const FINISH = '2026-10-12T12:01:00.000Z';
const CHECKED = '2026-10-12T12:02:00.000Z';
const READY_ROW = { relation_exists: true, rls_enabled: true, columns_ready: true, nullability_ready: true, constraints_ready: true, indexes_ready: true, privileges_ready: true };

function action(overrides: Partial<ObservabilityActionRecord> = {}): ObservabilityActionRecord {
  return {
    id: ACTION_ID, accountScopeId: 'studio:alice', environment: 'production', runId: null,
    type: 'remediate', title: 'private incident text', rationale: 'credential=private-secret', playbookId: 'restart-app',
    evidenceRefs: ['event:0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b'], requiresApproval: true,
    status: 'succeeded', origin: 'ai-copilot', proposedBy: 'private-alice', approvedBy: 'private-bob',
    approvalExpiresAt: CHECKED, createdAt: START, updatedAt: CHECKED, regressionMarker: null, revision: 3,
    execution: { accepted: true, runId: RUN_ID, playbookId: 'restart-app', startedAt: START, finishedAt: CHECKED,
      request: { accepted: true, runId: RUN_ID },
      verification: { ok: true, checkedAt: CHECKED, detail: 'private verification details', checks: [{ name: 'remediation-run', ok: true, detail: 'private-health-url' }] } },
    ...overrides,
  };
}
function run(overrides: Partial<RemediationRun> = {}): RemediationRun {
  return { id: RUN_ID, environment: 'production', startedAt: START, finishedAt: FINISH, playbookId: 'restart-app',
    trigger: 'manual', triggeredBy: 'private-bob', status: 'succeeded', summary: 'private log body',
    steps: [{ name: 'private name', ok: true, detail: 'private token' }], ...overrides };
}
function actionRow(item: ObservabilityActionRecord): Record<string, unknown> {
  return { id: item.id, account_scope_id: item.accountScopeId, environment: item.environment, run_id: item.runId,
    type: item.type, title: item.title, rationale: item.rationale, playbook_id: item.playbookId, evidence_refs: item.evidenceRefs,
    requires_approval: item.requiresApproval, status: item.status, origin: item.origin, proposed_by: item.proposedBy,
    approved_by: item.approvedBy, approval_expires_at: item.approvalExpiresAt, created_at: item.createdAt, updated_at: item.updatedAt,
    execution: item.execution, regression_marker: item.regressionMarker, revision: item.revision };
}
function runRow(item: RemediationRun): Record<string, unknown> {
  return { id: item.id, environment: item.environment, started_at: item.startedAt, finished_at: item.finishedAt,
    playbook_id: item.playbookId, trigger: item.trigger, triggered_by: item.triggeredBy, status: item.status, summary: item.summary, steps: item.steps };
}

let directory: string;
let service: ObservabilityActionRegressionService;
let server: Server | undefined;
let origin: string;
let savedEnvironment: Record<string, string | undefined>;
beforeEach(async () => {
  savedEnvironment = Object.fromEntries(['RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_OBSERVABILITY_ENVIRONMENT', 'RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES'].map(key => [key, process.env[key]]));
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  process.env.RDK_OBSERVABILITY_ENVIRONMENT = 'production';
  process.env.RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES = '{"bob":["studio:alice"]}';
  configureObservabilityAccess({ getSessionSsoUser: req => { const id = req.header('x-fixture-user'); return id ? { id } : null; },
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  resetObservabilityActionSchemaReadinessForTest();
  directory = await mkdtemp(join(tmpdir(), 'd-obs-action-regression-'));
  service = new ObservabilityActionRegressionService({ stateDir: join(directory, 'cases') });
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  resetObservabilityAccessAdapter();
  resetObservabilityActionSchemaReadinessForTest();
  for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(directory, { recursive: true, force: true });
});

test('case survives service restart, excludes raw text and actor identity, and remains owner isolated', async () => {
  const stored = await service.save('studio:alice', action(), run());
  const restarted = new ObservabilityActionRegressionService({ stateDir: service.stateDir });
  assert.deepEqual(await restarted.get('studio:alice', ACTION_ID), stored);
  assert.equal(await restarted.get('studio:bob', ACTION_ID), null);
  assert.equal(stored.snapshot.labelAuthority, 'server_verified_remediation_run');
  assert.equal(stored.snapshot.diagnosisAccuracyMeasured, false);
  assert.equal(stored.snapshot.automaticallyReplayed, false);
  assert.match(stored.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(actionRegressionMarker(stored).length <= 160);
  assert.doesNotMatch(JSON.stringify(stored), /private|credential|studio:alice/);
  await assert.rejects(service.save('studio:bob', action(), run()), /action_regression_owner_mismatch/);
});

test('unknown, pending, unverified, missing, mismatched and rejected outcomes are never evaluation labels', () => {
  for (const status of ['pending_approval', 'approved', 'executing', 'failed', 'denied', 'completed'] as const) {
    assert.throws(() => buildActionRegressionSnapshot(action({ status }), run()), /action_regression_verified_outcome_required/);
  }
  const base = action();
  assert.throws(() => buildActionRegressionSnapshot(action({ execution: { ...base.execution!, verification: undefined } }), run()), /action_regression_verified_outcome_required/);
  assert.throws(() => buildActionRegressionSnapshot(action({ execution: { ...base.execution!, verification: { ...base.execution!.verification!, pending: true } } }), run()), /action_regression_verified_outcome_required/);
  for (const unavailable of [null, run({ id: '2f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b' }), run({ environment: 'staging' }),
    run({ status: 'running' }), run({ status: 'rejected' }), run({ finishedAt: null }), run({ steps: [] }), run({ playbookId: 'reload-nginx' })]) {
    assert.throws(() => buildActionRegressionSnapshot(base, unavailable), /action_regression_exact_run_required/);
  }
  assert.throws(() => buildActionRegressionSnapshot(base, run({ status: 'failed', steps: [{ name: 'check', ok: false, detail: '' }] })), /action_regression_outcome_mismatch/);
  assert.throws(() => buildActionRegressionSnapshot(base, run({ finishedAt: '2026-10-13T12:00:00.000Z' })), /action_regression_invalid_evidence/);
});

test('independently verified failure retains the failed check without inventing a diagnosis', async () => {
  const base = action();
  const failed = action({ status: 'verification_failed', execution: { ...base.execution!, verification: { ...base.execution!.verification!, ok: false } } });
  const stored = await service.save('studio:alice', failed, run({ status: 'failed', steps: [{ name: 'health', ok: false, detail: 'private raw body' }] }));
  assert.deepEqual(stored.snapshot.execution.stepOutcomes, [false]);
  assert.equal(stored.snapshot.expectedOutcome.verificationOk, false);
  assert.equal(stored.snapshot.expectedOutcome.remediationStatus, 'failed');
});

test('concurrent capture and repeat marker revisions are idempotent; changed results and tampering fail closed', async () => {
  const captured = await Promise.all([service.save('studio:alice', action(), run()), service.save('studio:alice', action(), run())]);
  assert.deepEqual(captured[0], captured[1]);
  const repeated = await service.save('studio:alice', action({ revision: 99, regressionMarker: actionRegressionMarker(captured[0]) }), run());
  assert.deepEqual(repeated, captured[0]);
  await assert.rejects(service.save('studio:alice', action({ evidenceRefs: ['check:different'] }), run()), /action_regression_result_conflict/);
  const ownerPath = join(service.stateDir, (await readdir(service.stateDir))[0]);
  const files = await readdir(ownerPath);
  assert.deepEqual(files, [captured[0].id + '.json']);
  const file = join(ownerPath, files[0]);
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.regressionCase.snapshot.expectedOutcome.verificationOk = false;
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(service.get('studio:alice', ACTION_ID), /action_regression_corrupt_state/);
});

type Fixture = { current: ObservabilityActionRecord; actualRun: RemediationRun | null; writes: number; pool: ActionStorePool };
function fixture(): Fixture {
  const state: Fixture = { current: action(), actualRun: run(), writes: 0, pool: { async query() { return { rows: [] }; } } };
  state.pool = { async query(sql, params = []) {
    if (sql.includes('relrowsecurity')) return { rows: [READY_ROW] };
    if (sql.includes('studio_remediation_runs')) return { rows: state.actualRun && params[0] === state.actualRun.id ? [runRow(state.actualRun)] : [] };
    if (sql.trim().startsWith('update public.studio_observability_actions')) {
      state.writes += 1;
      state.current = { ...state.current, regressionMarker: String(params[9]), revision: Number(params[10]) };
      return { rows: [{ id: state.current.id }], rowCount: 1 };
    }
    if (sql.includes('studio_observability_actions') && Array.isArray(params[1])) return {
      rows: params[0] === state.current.id && params[1].includes(state.current.accountScopeId) && params[2] === state.current.environment ? [actionRow(state.current)] : [],
    };
    return { rows: [] };
  } };
  return state;
}
async function start(state: Fixture, options: Partial<ObservabilityActionRouterOptions> = {}) {
  const app = express(); app.use(express.json());
  app.use(createObservabilityActionRouter({ getPool: async () => state.pool, regressionCases: service, ...options }));
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
}
function request(method: 'GET' | 'POST', user = 'alice', suffix = '', payload: object = {}) {
  return fetch(origin + '/api/ops/observability/actions/' + ACTION_ID + '/regression' + suffix, {
    method, headers: { 'x-fixture-user': user, 'x-rdk-ops-action': 'observability', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
  });
}

test('HTTP save failure cannot write a marker or claim successful regression capture', async () => {
  const state = fixture();
  await start(state, { regressionCases: { async save() { throw new ObservabilityActionRegressionError('action_regression_store_unavailable', 503); }, async get() { return null; } } });
  const response = await request('POST', 'alice', '', { marker: 'diagnosis-100-percent' });
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal(state.writes, 0);
  assert.equal(state.current.regressionMarker, null);
  assert.deepEqual(await response.json(), { ok: false, error: 'action_regression_store_unavailable' });
});

test('HTTP captures exact evidence, retries idempotently, and exports only through the owner action gate', async () => {
  const state = fixture(); await start(state);
  assert.equal((await request('GET')).status, 404);
  const response = await request('POST', 'alice', '', { marker: 'diagnosis-100-percent' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { regressionCase: { id: string; contentHash: string; exportUrl: string } };
  assert.equal(state.writes, 1);
  assert.equal(state.current.regressionMarker, 'regression-case:' + body.regressionCase.id + ':' + body.regressionCase.contentHash);
  assert.equal((await request('POST')).status, 200); assert.equal(state.writes, 1);
  const exported = await request('GET', 'alice', '?download=1');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /^attachment; filename="case-[a-f0-9]{32}\.json"$/);
  const downloaded = await exported.json() as ObservabilityActionRegressionCase;
  assert.equal(downloaded.contentHash, body.regressionCase.contentHash);
  assert.doesNotMatch(JSON.stringify(downloaded), /private|diagnosis-100-percent/);
  assert.equal((await request('GET', 'bob')).status, 404); // approval grants are insufficient for another owner's case
  assert.equal((await request('POST', 'bob')).status, 404);
  assert.equal((await request('GET', 'outsider')).status, 403);
});

test('HTTP missing exact run refuses capture and leaves the action unmarked', async () => {
  const state = fixture(); state.actualRun = null; await start(state);
  const response = await request('POST');
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(state.writes, 0);
  assert.equal(await service.get('studio:alice', ACTION_ID), null);
});

test('case saved before a conflicting action update stays unbound and a later retry can bind it', async () => {
  const state = fixture();
  const originalQuery = state.pool.query.bind(state.pool);
  let conflict = true;
  state.pool.query = async (sql, params) => {
    if (conflict && sql.trim().startsWith('update public.studio_observability_actions')) return { rows: [], rowCount: 0 };
    return originalQuery(sql, params);
  };
  await start(state);
  assert.equal((await request('POST')).status, 409);
  const saved = await service.get('studio:alice', ACTION_ID); assert.ok(saved);
  assert.equal(state.current.regressionMarker, null);
  assert.equal((await request('GET')).status, 404);
  conflict = false;
  assert.equal((await request('POST')).status, 200);
  assert.equal((await request('GET')).status, 200);
  assert.deepEqual(await service.get('studio:alice', ACTION_ID), saved);
});
