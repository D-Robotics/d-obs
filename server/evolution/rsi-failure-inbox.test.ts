import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { RsiFailureInboxError, RsiFailureInboxService, type RsiFailureRecord } from './rsi-failure-inbox.js';
import { RsiErrorCodeSchema, type RsiInput, type RsiReason, type RsiSlice } from './rsi-replay.js';

const owner = 'sso:alice';
const operationId = 'GET /api/ops/observability/overview';
let directory: string;
let service: RsiFailureInboxService;
const ownerDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const error = (code: string, status?: number) => (cause: unknown) => cause instanceof RsiFailureInboxError && cause.code === 'rsi_inbox_' + code && (status === undefined || cause.status === status);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'd-obs-rsi-inbox-')); service = new RsiFailureInboxService({ stateDir: directory }); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function confirmed(input: RsiInput, expectedReason: RsiReason, slice: RsiSlice, op = operationId) {
  const record = await service.record(owner, { operationId: op, input, suggestedReason: 'unknown' });
  return service.confirm(owner, record.id, { expectedRevision: (await service.overview(owner)).revision, expectedReason, slice });
}
async function threeConfirmed() {
  return [await confirmed({ httpStatus: 401 }, 'auth_denied', 'frozen'),
    await confirmed({ httpStatus: 504, errorCode: 'ETIMEDOUT' }, 'timeout', 'adaptive'),
    await confirmed({ httpStatus: 408, errorCode: 'ETIMEDOUT' }, 'timeout', 'holdout')];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
async function stateFixture(update: (payload: { records: RsiFailureRecord[]; revision: number }) => void) {
  const file = join(directory, ownerDigest(owner) + '.json');
  const envelope = JSON.parse(await readFile(file, 'utf8')); update(envelope.payload); envelope.sha256 = hash(envelope.payload);
  await writeFile(file, JSON.stringify(envelope));
}
function child(code: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const subprocess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    subprocess.stdout.on('data', (data: Buffer) => { stdout += data.toString(); }); subprocess.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    subprocess.on('error', reject); subprocess.on('close', (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}

test('empty owner inboxes are isolated and do not create synthetic failure records', async () => {
  const overview = await service.overview(owner);
  assert.equal(overview.revision, 1); assert.equal(overview.activeLoopId, null); assert.deepEqual(overview.records, []);
  assert.deepEqual(overview.counts, { total: 0, unconfirmed: 0, confirmed: 0, excluded: 0, observations: 0 }); assert.deepEqual(await readdir(directory), []);
  const record = await service.record(owner, { operationId, input: { httpStatus: 504 } });
  assert.equal(record.source, 'platform_operation'); assert.equal(record.executionOutcome, 'failed'); assert.equal(record.expectedReason, null);
  assert.equal((await service.overview('sso:bob')).records.length, 0);
  await assert.rejects(service.confirm('sso:bob', record.id, { expectedRevision: 1, expectedReason: 'timeout', slice: 'adaptive' }), error('not_found', 404));
  await assert.rejects(service.exclude('sso:bob', record.id, { expectedRevision: 1 }), error('not_found', 404));
  await assert.rejects(service.overview(''), error('identity_required', 401)); await assert.rejects(service.overview(' sso:alice'), error('identity_required', 401));
});

test('strict schemas refuse raw error details, operation arguments and instantiated URLs', async () => {
  const valid = { operationId, input: { httpStatus: 504, errorCode: 'ETIMEDOUT' } };
  for (const extra of ['message', 'error', 'body', 'args', 'prompt', 'identity', 'observedAt', 'id']) {
    await assert.rejects(service.record(owner, { ...valid, [extra]: 'secret-owner-or-body' }), error('invalid_input'));
  }
  await assert.rejects(service.record(owner, { ...valid, input: { ...valid.input, errorMessage: 'private error' } }), error('invalid_input'));
  await assert.rejects(service.record(owner, { operationId: operationId + '?tenant=secret', input: valid.input }), error('invalid_input'));
  await assert.rejects(service.record(owner, { operationId: 'GET /api/ops/observability/incidents/customer-secret/actions', input: valid.input }), error('unregistered_operation'));
  await assert.rejects(service.record(owner, { ...valid, input: { errorCode: 'E_SECRET' } }), error('invalid_input'));
  await assert.rejects(service.record(owner, { ...valid, input: {} }), error('invalid_input'));
  await assert.rejects(service.record(owner, { ...valid, input: { httpStatus: 200 } }), error('invalid_input'));
  const record = await service.record(owner, valid);
  const disk = await readFile(join(directory, ownerDigest(owner) + '.json'), 'utf8');
  assert.ok(!disk.includes(owner)); assert.ok(!disk.includes('secret')); assert.ok(disk.includes(record.id));
  const isolatedRegistry = new RsiFailureInboxService({ stateDir: directory, operationIds: [] });
  await assert.rejects(isolatedRegistry.record(owner, valid), error('unregistered_operation'));
});

test('persistent records, classifications and revisions survive restart with private permissions', async () => {
  const loopId = randomUUID(); const activeVersionId = randomUUID();
  const binding = await service.bindLoop(owner, { expectedRevision: 1, loopId }); assert.equal(binding.revision, 2);
  const record = await service.record(owner, { operationId, input: { httpStatus: 504 }, executionOutcome: 'unknown', suggestedReason: 'timeout', classification: { loopId, activeVersionId, reason: 'unknown' } });
  const restarted = new RsiFailureInboxService({ stateDir: directory });
  assert.deepEqual(await restarted.overview(owner), await service.overview(owner));
  assert.equal(record.executionOutcome, 'unknown'); assert.equal(record.classification!.activeVersionId, activeVersionId);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(join(directory, ownerDigest(owner) + '.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), [ownerDigest(owner) + '.json']);
});

test('HTTP 200 failure receipts require a trusted true literal and retain unknown labels until confirmation', async () => {
  const input = { operationId, input: { httpStatus: 200 }, suggestedReason: 'unknown' };
  await assert.rejects(service.record(owner, input), error('invalid_input'));
  for (const receiptFailure of [false, 'true', 1, null]) {
    await assert.rejects(service.record(owner, { ...input, receiptFailure }), error('invalid_input'));
  }
  await assert.rejects(service.record(owner, { ...input, receiptFailure: true, input: {} }), error('invalid_input'));
  await assert.rejects(service.record(owner, { ...input, receiptFailure: true, message: 'private error' }), error('invalid_input'));
  await assert.rejects(service.record(owner, { ...input, receiptFailure: true, input: { httpStatus: 200, rawError: 'private error' } }), error('invalid_input'));
  const observed = await service.record(owner, { ...input, receiptFailure: true });
  assert.equal(observed.receiptFailure, true); assert.equal(observed.status, 'unconfirmed');
  assert.equal(observed.expectedReason, null); assert.equal(observed.slice, null); assert.equal(observed.suggestedReason, 'unknown');
  const restarted = new RsiFailureInboxService({ stateDir: directory });
  assert.deepEqual((await restarted.overview(owner)).records[0], observed);
  const repeated = await restarted.record(owner, { ...input, receiptFailure: true });
  assert.equal(repeated.id, observed.id); assert.equal(repeated.count, 2); assert.equal(repeated.fingerprint, observed.fingerprint);
  const frozen = await confirmed({ httpStatus: 401 }, 'auth_denied', 'frozen');
  const holdout = await confirmed({ httpStatus: 408, errorCode: 'ETIMEDOUT' }, 'timeout', 'holdout');
  const evidenceIds = [frozen.id, observed.id, holdout.id];
  await assert.rejects(service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds }), error('confirmation_required', 409));
  await service.confirm(owner, observed.id, { expectedRevision: (await service.overview(owner)).revision, expectedReason: 'unknown', slice: 'adaptive' });
  const cases = await service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds });
  assert.deepEqual(cases.cases[1].input, { httpStatus: 200 }); assert.equal(cases.cases[1].expectedReason, 'unknown');
  assert.equal(cases.provenance[1].evidenceId, observed.id);
  assert.equal('receiptFailure' in cases.cases[1], false);
});

test('aggregated observations preserve stable evidence and confirmed labels while replacing actual-version classification', async () => {
  const first = await confirmed({ httpStatus: 504, errorCode: 'ETIMEDOUT' }, 'timeout', 'adaptive');
  const loopId = randomUUID(); await service.bindLoop(owner, { expectedRevision: (await service.overview(owner)).revision, loopId });
  const activeVersionId = randomUUID();
  const second = await service.record(owner, { operationId, input: { errorCode: 'ETIMEDOUT', httpStatus: 504 }, suggestedReason: 'auth_denied', classification: { loopId, activeVersionId, reason: 'rate_limited' } });
  assert.equal(second.id, first.id); assert.equal(second.fingerprint, first.fingerprint); assert.equal(second.observedAt, first.observedAt); assert.equal(second.count, 2);
  assert.equal(second.status, 'confirmed'); assert.equal(second.expectedReason, 'timeout'); assert.equal(second.slice, 'adaptive'); assert.equal(second.confirmedAt, first.confirmedAt);
  assert.equal(second.classification!.activeVersionId, activeVersionId); assert.equal(second.suggestedReason, 'auth_denied');
  const third = await service.record(owner, { operationId, input: first.input });
  assert.equal(third.classification, null); assert.equal(third.count, 3); assert.equal(third.expectedReason, 'timeout');
  const unknownOutcome = await service.record(owner, { operationId, input: first.input, executionOutcome: 'unknown' });
  assert.notEqual(unknownOutcome.id, first.id); assert.notEqual(unknownOutcome.fingerprint, first.fingerprint);
  await assert.rejects(service.confirm(owner, first.id, { expectedRevision: (await service.overview(owner)).revision, expectedReason: 'auth_denied', slice: 'holdout' }), error('record_finalized', 409));
});

test('global owner revision prevents stale operator decisions and stale binding changes', async () => {
  const a = await service.record(owner, { operationId, input: { httpStatus: 404 } });
  const revision = (await service.overview(owner)).revision;
  await service.record(owner, { operationId, input: { httpStatus: 504 } });
  await assert.rejects(service.confirm(owner, a.id, { expectedRevision: revision, expectedReason: 'not_found', slice: 'frozen' }), error('stale_revision', 409));
  await assert.rejects(service.exclude(owner, a.id, { expectedRevision: revision }), error('stale_revision', 409));
  await assert.rejects(service.bindLoop(owner, { expectedRevision: revision, loopId: randomUUID() }), error('stale_revision', 409));
  const current = await service.overview(owner); const excluded = await service.exclude(owner, a.id, { expectedRevision: current.revision });
  assert.equal(excluded.status, 'excluded'); assert.equal(excluded.expectedReason, null);
  const repeated = await service.record(owner, { operationId, input: a.input, suggestedReason: 'not_found' }); assert.equal(repeated.status, 'excluded');
  await assert.rejects(service.record(owner, { operationId, input: a.input, classification: { loopId: randomUUID(), activeVersionId: randomUUID(), reason: 'not_found' } }), error('binding_required', 409));
});

test('building cases needs explicit confirmations and three isolated slices, then freezes provenance', async () => {
  const records = await threeConfirmed(); const revision = (await service.overview(owner)).revision;
  const result = await service.buildCases(owner, { expectedRevision: revision, evidenceIds: records.map((record) => record.id) });
  assert.equal(result.cases.length, 3); assert.ok(result.cases.every((item) => item.source === 'operator'));
  assert.equal(result.cases[1].expectedReason, 'timeout'); assert.equal(records[1].suggestedReason, 'unknown');
  assert.deepEqual(result.provenance[1], { caseId: 'evidence.' + records[1].id, evidenceId: records[1].id, fingerprint: records[1].fingerprint, operationId, observedAt: records[1].observedAt, confirmedAt: records[1].confirmedAt });
  result.cases[1].expectedReason = 'auth_denied'; result.provenance[1].fingerprint = 'private';
  assert.equal((await service.buildCases(owner, { expectedRevision: revision, evidenceIds: records.map((record) => record.id) })).cases[1].expectedReason, 'timeout');
  await assert.rejects(service.buildCases(owner, { expectedRevision: revision, evidenceIds: [records[0].id, records[1].id, records[1].id] }), error('duplicate_evidence'));
  await assert.rejects(service.buildCases('sso:bob', { expectedRevision: 1, evidenceIds: records.map((record) => record.id) }), error('not_found', 404));
  await assert.rejects(service.buildCases(owner, { expectedRevision: revision - 1, evidenceIds: records.map((record) => record.id) }), error('stale_revision', 409));
  const suggested = await service.record(owner, { operationId, input: { httpStatus: 429 }, suggestedReason: 'rate_limited' });
  await assert.rejects(service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds: [records[0].id, records[1].id, suggested.id] }), error('confirmation_required', 409));
  await service.exclude(owner, records[0].id, { expectedRevision: (await service.overview(owner)).revision });
  await assert.rejects(service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds: records.map((record) => record.id) }), error('confirmation_required', 409));
});

test('missing holdout and identical classifier input in different slices are rejected even for different operations', async () => {
  const a = await confirmed({ httpStatus: 401 }, 'auth_denied', 'frozen');
  const b = await confirmed({ httpStatus: 504 }, 'timeout', 'adaptive');
  const c = await confirmed({ httpStatus: 408 }, 'timeout', 'adaptive');
  await assert.rejects(service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds: [a.id, b.id, c.id] }), error('slices_required'));
  const duplicate = await confirmed(b.input, 'timeout', 'holdout', 'GET /api/ops/observability/config');
  await assert.rejects(service.buildCases(owner, { expectedRevision: (await service.overview(owner)).revision, evidenceIds: [a.id, b.id, duplicate.id] }), error('invalid_case_isolation'));
});

test('concurrent instances serialize aggregation without losing observations or revision changes', async () => {
  const second = new RsiFailureInboxService({ stateDir: directory });
  const records = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? service : second).record(owner, { operationId, input: { httpStatus: 504, errorCode: 'ETIMEDOUT' } })));
  assert.equal(new Set(records.map((record) => record.id)).size, 1);
  const overview = await service.overview(owner); assert.equal(overview.records[0].count, 20); assert.equal(overview.revision, 21);
  const actions = await Promise.allSettled([service.confirm(owner, records[0].id, { expectedRevision: overview.revision, expectedReason: 'timeout', slice: 'adaptive' }), second.exclude(owner, records[0].id, { expectedRevision: overview.revision })]);
  assert.equal(actions.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = actions.find((item) => item.status === 'rejected') as PromiseRejectedResult; assert.ok(error('stale_revision', 409)(rejected.reason));
});

test('cross-process writes use complete exclusive locks and leave no partial records', async () => {
  const setup = `const {RsiFailureInboxService}=await import(${JSON.stringify(new URL('./rsi-failure-inbox.ts', import.meta.url).href)}); const service=new RsiFailureInboxService({stateDir:${JSON.stringify(directory)}});`;
  const results = await Promise.all(Array.from({ length: 3 }, () => child(setup + `for(let i=0;i<5;i++)await service.record(${JSON.stringify(owner)},{operationId:${JSON.stringify(operationId)},input:{httpStatus:504}});`)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const overview = await service.overview(owner); assert.equal(overview.records[0].count, 15); assert.equal(overview.revision, 16);
  assert.deepEqual(await readdir(directory), [ownerDigest(owner) + '.json']);
});

test('bounded retention evicts unconfirmed observations, preserves confirmed evidence, and reports full quota', async () => {
  const first = await confirmed({ httpStatus: 400, errorCode: 'ETIMEDOUT' }, 'timeout', 'adaptive');
  await stateFixture((payload) => {
    const base = payload.records[0]; payload.records = Array.from({ length: 500 }, (_, index) => {
      const input = { httpStatus: 400 + Math.floor(index / 8), errorCode: RsiErrorCodeSchema.options[index % 8] };
      const record: RsiFailureRecord = { ...base, id: index === 0 ? first.id : randomUUID(), input, status: index === 0 ? 'confirmed' : 'unconfirmed', expectedReason: index === 0 ? base.expectedReason : null, slice: index === 0 ? base.slice : null, confirmedAt: index === 0 ? base.confirmedAt : null };
      record.fingerprint = hash({ operationId, input, executionOutcome: record.executionOutcome }); return record;
    });
  });
  await service.record(owner, { operationId, input: { httpStatus: 599 } });
  const overview = await service.overview(owner); assert.equal(overview.records.length, 500); assert.ok(overview.records.some((record) => record.id === first.id));
  await stateFixture((payload) => { for (const record of payload.records) { record.status = 'confirmed'; record.expectedReason = 'unknown'; record.slice = 'adaptive'; record.confirmedAt = record.lastSeenAt; } });
  await assert.rejects(service.record(owner, { operationId, input: { httpStatus: 598 } }), error('record_limit', 409));
  assert.equal((await service.overview(owner)).records.length, 500);
});

test('corrupt, symlinked and identity-forged files are refused instead of becoming trusted evidence', async () => {
  const record = await service.record(owner, { operationId, input: { httpStatus: 504 } });
  const file = join(directory, ownerDigest(owner) + '.json'); const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace(record.id, randomUUID())); await assert.rejects(service.overview(owner), error('corrupt_state', 503));
  await writeFile(file, original); await stateFixture((payload) => { payload.records[0].expectedReason = 'timeout'; });
  await assert.rejects(service.overview(owner), error('corrupt_state', 503));
  await writeFile(file, original); const outside = join(directory, 'elsewhere.json'); await writeFile(outside, original); await rm(file); await symlink(outside, file);
  await assert.rejects(service.overview(owner), error('corrupt_state', 503));
  await assert.rejects(service.record(owner, { operationId, input: { httpStatus: 504 } }), error('corrupt_state', 503));
});
