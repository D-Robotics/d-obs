import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { RsiLedgerError, RsiLedgerService, type RsiLoop } from './rsi-ledger.js';
import { BASELINE_RULES, DEMO_CASES, type RsiCase } from './rsi-replay.js';

let directory: string;
let service: RsiLedgerService;
const owner = 'sso:alice';
const ownerDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const error = (code: string) => (cause: unknown) => cause instanceof RsiLedgerError && cause.code === 'rsi_' + code;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'd-obs-rsi-ledger-')); service = new RsiLedgerService({ stateDir: directory }); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function round(loop: RsiLoop): Promise<RsiLoop> {
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision });
  loop = await service.replay(owner, loop.id, { expectedRevision: loop.revision });
  return service.accept(owner, loop.id, { expectedRevision: loop.revision });
}
function child(code: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    processChild.stdout.on('data', (data: Buffer) => { stdout += data.toString(); }); processChild.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    processChild.on('error', reject); processChild.on('close', (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}
const childSetup = () => `const { RsiLedgerService } = await import(${JSON.stringify(new URL('./rsi-ledger.ts', import.meta.url).href)}); const { DEMO_CASES } = await import(${JSON.stringify(new URL('./rsi-replay.ts', import.meta.url).href)}); const service = new RsiLedgerService({stateDir:${JSON.stringify(directory)}});`;

test('overview is genuinely empty until an explicit seed; owners and returned objects are isolated', async () => {
  assert.deepEqual((await service.overview(owner)).counts, { loops: 0, acceptedRounds: 0, inheritedRounds: 0, replays: 0, pendingCandidates: 0 });
  assert.equal((await service.overview(owner)).status, 'empty'); assert.deepEqual(await readdir(directory), []);
  const loop = await service.seedDemo(owner); assert.ok(loop.cases.every((item) => item.source === 'synthetic'));
  const summary = (await service.overview(owner)).loops[0]; assert.equal(summary.synthetic, true); assert.equal(summary.acceptedRounds, 0); assert.equal(summary.inheritedRounds, 0);
  assert.equal((await service.overview('sso:bob')).status, 'empty'); await assert.rejects(service.detail('sso:bob', loop.id), error('not_found'));
  const revised = await service.propose(owner, loop.id, { expectedRevision: loop.revision });
  revised.versions[1].rules[0].reason = 'auth_denied'; revised.cases[0].expectedReason = 'unknown';
  const actual = await service.detail(owner, loop.id); assert.equal(actual.versions[1].rules[0].reason, 'timeout'); assert.equal(actual.cases[0].expectedReason, 'auth_denied');
  await assert.rejects(service.overview(''), error('identity_required')); await assert.rejects(service.overview(' sso:alice'), error('identity_required'));
  assert.deepEqual(await readdir(directory), [ownerDigest(owner) + '.json']);
  const disk = await readFile(join(directory, ownerDigest(owner) + '.json'), 'utf8'); assert.ok(!disk.includes(owner)); assert.ok(!disk.includes('sso:bob'));
});

test('durable evidence survives a new service instance with private file and directory permissions', async () => {
  const loop = await round(await service.seedDemo(owner));
  const restarted = new RsiLedgerService({ stateDir: directory }); assert.deepEqual(await restarted.detail(owner, loop.id), loop);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(join(directory, ownerDigest(owner) + '.json'))).mode & 0o777, 0o600);
  assert.equal(loop.replays.length, 1); assert.equal(loop.decisions.length, 1); assert.equal(loop.decisions[0].action, 'accept');
  assert.equal(loop.decisions[0].replayId, loop.replays[0].id); assert.equal(loop.decisions[0].casesHash, loop.casesHash);
});

test('two accepted rounds load the previous active package and outperform an equally proposed reset control', async () => {
  let loop = await service.seedDemo(owner); const initial = structuredClone(loop.versions[0]);
  loop = await round(loop); const firstVersion = loop.activeVersionId; const firstReplay = structuredClone(loop.replays[0]);
  assert.equal(loop.versions[1].loadedVersionId, initial.id); assert.equal(firstReplay.report.retention.adaptive.accuracyDelta, 0);
  loop = await round(loop); const second = loop.versions.find((version) => version.id === loop.activeVersionId)!;
  assert.equal(second.parentVersionId, firstVersion); assert.equal(second.loadedVersionId, firstVersion);
  assert.deepEqual(second.rules.slice(1), loop.versions[1].rules); assert.deepEqual(loop.versions[0], initial); assert.deepEqual(loop.replays[0], firstReplay);
  const secondReplay = loop.replays[1]; assert.equal(secondReplay.activeVersionId, firstVersion); assert.equal(secondReplay.candidateVersionId, second.id);
  assert.equal(secondReplay.counterfactualLoadedVersionId, initial.id); assert.deepEqual(secondReplay.counterfactualProposal.rules, firstReplay.counterfactualProposal.rules);
  assert.equal(secondReplay.report.scenarios.active.slices.holdout.accuracy, 0.5); assert.equal(secondReplay.report.scenarios.candidate.slices.holdout.accuracy, 1);
  assert.equal(secondReplay.report.scenarios.noRetention.slices.holdout.accuracy, 0.5); assert.equal(secondReplay.report.retention.holdout.accuracyDelta, 0.5);
  assert.equal(secondReplay.report.budget.equalPerCaseLimit, true); assert.equal(secondReplay.report.budget.withinBudget, true);
  assert.deepEqual(secondReplay.proposalBudget, { adaptiveCaseCount: 2, maxNewRulesPerProposal: 1, proposalsPerVariant: 1, labelAccess: 'adaptive_only' });
  assert.equal((await service.overview(owner)).counts.acceptedRounds, 2); assert.equal((await service.overview(owner)).counts.inheritedRounds, 1);
  await assert.rejects(service.propose(owner, loop.id, { expectedRevision: loop.revision }), error('proposal_no_change'));
});

test('accept requires a fresh candidate report, explicit revision and a passing gate', async () => {
  let loop = await service.seedDemo(owner); await assert.rejects(service.accept(owner, loop.id, { expectedRevision: loop.revision }), error('candidate_required'));
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision }); await assert.rejects(service.accept(owner, loop.id, { expectedRevision: loop.revision }), error('gate_required'));
  await assert.rejects(service.replay(owner, loop.id, { expectedRevision: loop.revision - 1 }), error('stale_revision'));
  loop = await service.replay(owner, loop.id, { expectedRevision: loop.revision }); const replay = structuredClone(loop.replays[0]);
  loop = await service.replay(owner, loop.id, { expectedRevision: loop.revision }); assert.equal(loop.replays.length, 2); assert.deepEqual(loop.replays[0], replay);
  const previousRevision = loop.revision; loop = await service.accept(owner, loop.id, { expectedRevision: loop.revision });
  await assert.rejects(service.accept(owner, loop.id, { expectedRevision: previousRevision }), error('stale_revision'));
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision }); await assert.rejects(service.accept(owner, loop.id, { expectedRevision: loop.revision }), error('stale_replay'));
  assert.equal(loop.decisions.length, 1);
});

test('a regressing candidate can be rejected, never accepted, and its report remains evidence', async () => {
  const cases: RsiCase[] = [
    { id: 'frozen.auth', slice: 'frozen', input: { httpStatus: 401, errorCode: 'ETIMEDOUT' }, expectedReason: 'auth_denied', source: 'operator' },
    { id: 'adaptive.timeout', slice: 'adaptive', input: { httpStatus: 504, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
    { id: 'holdout.timeout', slice: 'holdout', input: { httpStatus: 408, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
  ];
  let loop = await service.createLoop(owner, { title: 'Regression', cases, rules: BASELINE_RULES }); const initial = loop.activeVersionId;
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision }); const candidate = loop.candidateVersionId;
  loop = await service.replay(owner, loop.id, { expectedRevision: loop.revision }); assert.equal(loop.replays[0].report.gate.passed, false);
  await assert.rejects(service.accept(owner, loop.id, { expectedRevision: loop.revision }), error('gate_failed'));
  loop = await service.reject(owner, loop.id, { expectedRevision: loop.revision }); assert.equal(loop.activeVersionId, initial); assert.equal(loop.candidateVersionId, null);
  assert.equal(loop.versions.find((version) => version.id === candidate)!.status, 'rejected'); assert.equal(loop.replays.length, 1); assert.equal(loop.decisions[0].action, 'reject');
  assert.equal((await service.overview(owner)).counts.acceptedRounds, 0);
  await assert.rejects(service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: candidate }), error('rollback_ancestor_required'));
});

test('rollback only selects accepted ancestors and appends history without deleting proofs', async () => {
  let loop = await service.seedDemo(owner); const initial = loop.initialVersionId; loop = await round(loop); const first = loop.activeVersionId; loop = await round(loop); const second = loop.activeVersionId;
  const replays = structuredClone(loop.replays); const versions = structuredClone(loop.versions);
  await assert.rejects(service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: randomUUID() }), error('rollback_ancestor_required'));
  loop = await service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: first }); assert.equal(loop.activeVersionId, first);
  assert.deepEqual(loop.versions, versions); assert.deepEqual(loop.replays, replays); assert.equal(loop.decisions.at(-1)?.action, 'rollback');
  await assert.rejects(service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: second }), error('rollback_ancestor_required'));
  loop = await service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: initial }); assert.equal(loop.activeVersionId, initial);
  await assert.rejects(service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: initial }), error('rollback_ancestor_required'));
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision }); assert.equal(loop.versions.at(-1)!.loadedVersionId, initial);
  await assert.rejects(service.rollback(owner, loop.id, { expectedRevision: loop.revision, versionId: first }), error('candidate_pending'));
});

test('in-process concurrent service instances share a queue and reject stale CAS', async () => {
  const loop = await service.seedDemo(owner); const other = new RsiLedgerService({ stateDir: directory });
  const results = await Promise.allSettled([service.propose(owner, loop.id, { expectedRevision: loop.revision }), other.propose(owner, loop.id, { expectedRevision: loop.revision })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult; assert.ok(error('stale_revision')(rejected.reason));
  assert.equal((await other.detail(owner, loop.id)).versions.length, 2);
});

test('independent processes do not lose writes and conflicting revisions produce one winner', async () => {
  const loop = await service.seedDemo(owner);
  const creators = await Promise.all(Array.from({ length: 8 }, (_, index) => child(childSetup() + `await service.createLoop(${JSON.stringify(owner)}, {title:'parallel-${index}',cases:DEMO_CASES});`)));
  for (const result of creators) assert.equal(result.status, 0, result.stderr);
  assert.equal((await service.overview(owner)).counts.loops, 9);
  const contenders = await Promise.all(Array.from({ length: 6 }, () => child(childSetup() + `try { await service.propose(${JSON.stringify(owner)},${JSON.stringify(loop.id)},{expectedRevision:1}); console.log('ok'); } catch(error) { console.log(error.code); }`)));
  for (const result of contenders) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(contenders.map((result) => result.stdout.trim()).sort(), ['ok', ...Array.from({ length: 5 }, () => 'rsi_stale_revision')]);
  assert.equal((await service.detail(owner, loop.id)).versions.length, 2); assert.equal((await readdir(directory)).filter((name) => name.endsWith('.guard') || name.endsWith('.lock')).length, 0);
});

test('dead writer lock is safely recovered under the guard; orphaned guards fail closed', async () => {
  const dead = await child('console.log(process.pid)'); assert.equal(dead.status, 0); const pid = Number(dead.stdout.trim());
  const lock = { pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  await writeFile(join(directory, ownerDigest(owner) + '.lock'), JSON.stringify(lock), { mode: 0o600 });
  const loop = await service.seedDemo(owner); assert.ok(loop.id); assert.equal((await readdir(directory)).filter((name) => name.endsWith('.lock')).length, 0);
  await writeFile(join(directory, ownerDigest(owner) + '.guard'), JSON.stringify(lock), { mode: 0o600 });
  await assert.rejects(service.propose(owner, loop.id, { expectedRevision: loop.revision }), error('stale_lock'));
  assert.equal((await service.detail(owner, loop.id)).revision, 1);
});

test('corrupt, mismatched and symlink states are never silently replaced or disclosed', async () => {
  const loop = await service.seedDemo(owner); const path = join(directory, ownerDigest(owner) + '.json'); const good = await readFile(path, 'utf8');
  await writeFile(path, '{broken'); await assert.rejects(service.overview(owner), error('corrupt_state')); await assert.rejects(service.createLoop(owner, { title: 'No replacement', cases: DEMO_CASES }), error('corrupt_state')); assert.equal(await readFile(path, 'utf8'), '{broken');
  await writeFile(path, good); const raw = JSON.parse(good); raw.payload.loops[0].activeVersionId = randomUUID(); await writeFile(path, JSON.stringify(raw)); await assert.rejects(service.detail(owner, loop.id), error('corrupt_state'));
  await writeFile(path, good); await writeFile(join(directory, ownerDigest('sso:bob') + '.json'), good); await assert.rejects(service.overview('sso:bob'), error('corrupt_state'));
  await rm(path); await symlink(join(directory, ownerDigest('sso:bob') + '.json'), path); await assert.rejects(service.overview(owner), error('corrupt_state'));
});

test('strict low-sensitivity schemas reject arbitrary code, extra fields, unsafe cases and quota overflows', async () => {
  for (const input of [
    { title: 'empty', cases: [] },
    { title: 'missing holdout', cases: DEMO_CASES.filter((item) => item.slice !== 'holdout') },
    { title: 'extra', cases: [], command: 'echo secret' },
    { title: 'unknown', cases: [{ ...DEMO_CASES[0], input: { errorCode: 'run arbitrary code' } }] },
    { title: 'raw body', cases: [{ ...DEMO_CASES[0], prompt: 'raw conversation' }] },
    { title: 'rule code', cases: DEMO_CASES, rules: [{ id: 'bad', predicate: { script: 'process.exit()' }, reason: 'unknown' }] },
    { title: 'oversized', cases: Array.from({ length: 201 }, (_, index) => ({ ...DEMO_CASES[0], id: 'case.' + index })) },
  ]) await assert.rejects(service.createLoop(owner, input), error('invalid_input'));
  const loop = await service.seedDemo(owner); await assert.rejects(service.propose(owner, loop.id, { expectedRevision: '1' }), error('invalid_input')); await assert.rejects(service.propose(owner, loop.id, { expectedRevision: 1, rules: [] }), error('invalid_input'));
  for (let index = 1; index < 50; index += 1) await service.createLoop(owner, { title: 'loop ' + index, cases: DEMO_CASES });
  await assert.rejects(service.seedDemo(owner), error('loop_limit')); assert.equal((await service.overview(owner)).counts.loops, 50);
  assert.equal(service.capabilities().quota.maxVersionsPerLoop, 100); assert.equal(service.capabilities().quota.maxCasesPerLoop, 200);
});
