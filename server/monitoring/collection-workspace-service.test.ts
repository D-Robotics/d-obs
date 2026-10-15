import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectionWorkspaceError, CollectionWorkspaceService, type CollectionArchive, type CollectionArtifact, type CollectionInspection, type CollectionModuleDescriptor, type CollectionPipelineVersion, type CollectionRun, type CollectionWorkspaceDriver } from './collection-workspace-service.js';

const owner = 'sso:alice'; const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const recipe = (extra = {}) => ({ name: 'Log capture', project: 'camera', source: 'edge', moduleId: 'ssh-logs', moduleVersion: '1.0.0', config: { targetId: 'x5', sourceId: 'kernel' }, createDataset: true, ...extra });
const rejects = (code: string) => (error: unknown) => error instanceof CollectionWorkspaceError && error.code === 'collection_' + code;
class FixtureDriver implements CollectionWorkspaceDriver {
  moduleId = 'ssh-logs'; version = '1.0.0'; available = true; starts = 0; exports = 0; stops = 0;
  sessions = new Map<string, { owner: string; inspection: CollectionInspection; artifact: CollectionArtifact }>();
  pauseStart?: () => Promise<void>;
  startError?: Error;
  describe(): CollectionModuleDescriptor { return { moduleId: this.moduleId, version: this.version, mode: 'pull', label: 'SSH logs', description: 'Fixture driver', available: this.available, configSchema: { fields: [{ key: 'targetId', label: 'Device', type: 'select' }] }, targets: [{ id: 'x5', label: 'X5', sources: [{ id: 'kernel', label: 'Kernel' }] }], canStart: this.available, canStop: true }; }
  validate(config: unknown) { const value = config as Record<string, unknown>; if (Object.keys(value).some((key) => !['targetId', 'sourceId'].includes(key)) || value.targetId !== 'x5' || value.sourceId !== 'kernel') throw new CollectionWorkspaceError('collection_unknown_target'); return { targetId: 'x5', sourceId: 'kernel' }; }
  async start(_config: Record<string, unknown>, actor: string) { this.starts++; await this.pauseStart?.(); if (this.startError) throw this.startError; const upstreamId = randomUUID(); this.sessions.set(upstreamId, { owner: actor, inspection: { state: 'running', recordCount: 0, byteCount: 0 }, artifact: { filename: 'capture.log', mimeType: 'text/plain', kind: 'log', bytes: Buffer.from('INFO ready\nERROR camera stalled\nINFO healthy\n') } }); return { upstreamId }; }
  owned(upstreamId: string, actor: string) { const session = this.sessions.get(upstreamId); if (!session || session.owner !== actor) throw new CollectionWorkspaceError('collection_upstream_not_found', 404); return session; }
  async inspect(upstreamId: string, actor: string) { return { ...this.owned(upstreamId, actor).inspection }; }
  async stop(upstreamId: string, actor: string) { this.stops++; this.owned(upstreamId, actor).inspection.state = 'stopped'; }
  async export(upstreamId: string, actor: string) { this.exports++; const artifact = this.owned(upstreamId, actor).artifact; return { ...artifact, bytes: Buffer.from(artifact.bytes) }; }
  complete(run: CollectionRun, state: 'completed' | 'failed' | 'stopped' = 'completed') { const session = this.sessions.get(run.upstreamId!)!; session.inspection = { state, recordCount: 3, byteCount: session.artifact.bytes.length, ...(state === 'failed' ? { error: 'server_restart' } : {}) }; }
}
let directory: string; let service: CollectionWorkspaceService; let driver: FixtureDriver;
let archives: Array<{ run: CollectionRun; pipeline: CollectionPipelineVersion; artifact: CollectionArtifact }>;
let archival: CollectionArchive; let services: CollectionWorkspaceService[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'collection-workspace-test-')); driver = new FixtureDriver(); archives = []; services = [];
  const receipts = new Map<string, { assetIds: string[]; datasetId?: string }>();
  archival = async (_actor, run, pipeline, artifact) => { archives.push({ run, pipeline, artifact }); const prior = receipts.get(run.id); if (prior) return prior; const receipt = { assetIds: [randomUUID()], ...(pipeline.createDataset ? { datasetId: randomUUID() } : {}) }; receipts.set(run.id, receipt); return receipt; };
  service = create();
});
function create(interval = 0, archive: CollectionArchive = (...args) => archival(...args), stateDir = directory) { const value = new CollectionWorkspaceService({ stateDir, drivers: [driver], archive, pollIntervalMs: interval }); services.push(value); return value; }
afterEach(async () => { for (const value of services) await value.dispose(); await rm(directory, { recursive: true, force: true }); });

test('dynamic module descriptors stay current and receiver recipes cannot execute', async () => {
  assert.equal((await service.modules(owner))[0].available, true); driver.available = false; assert.equal((await service.modules(owner))[0].available, false);
  const pipeline = await service.savePipeline(owner, recipe()); await assert.rejects(service.startRun(owner, pipeline.id), rejects('module_execution_unavailable')); assert.equal(driver.starts, 0);
  await assert.rejects(service.modules('ops-admin'), rejects('identity_required'));
});

test('immutable configuration versions survive restart and are isolated by stable actor ID', async () => {
  const v1 = await service.savePipeline(owner, recipe()); const v2 = await service.savePipeline(owner, recipe({ pipelineId: v1.id, name: 'Second revision', quality: { minBytes: 20 } }));
  assert.equal(v2.currentVersion, 2); assert.equal(v2.versions[0].name, 'Log capture'); assert.equal(v2.versions[1].name, 'Second revision');
  v2.versions[0].config.targetId = 'caller mutation'; const restarted = create(); assert.equal((await restarted.listPipelines(owner))[0].versions[0].config.targetId, 'x5'); assert.deepEqual(await restarted.listPipelines('sso:bob'), []);
  await assert.rejects(restarted.savePipeline('sso:bob', recipe({ pipelineId: v1.id })), rejects('pipeline_not_found'));
  assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(join(directory, 'manifest.json'))).mode & 0o777, 0o600);
});

test('unknown fields, credential material and command/address configuration fail before execution', async () => {
  for (const extra of [{ command: 'uname' }, { owner: 'sso:bob' }, { moduleVersion: '2.0.0' }, { config: { targetId: 'x5', sourceId: 'kernel', command: 'uname' } }, { config: { host: '1.2.3.4' } }, { config: { token: 'secret' } }, { config: { password: 'secret' } }]) await assert.rejects(service.savePipeline(owner, recipe(extra)));
  assert.equal(driver.starts, 0); assert.deepEqual(await service.listPipelines(owner), []);
});

test('real source receipts and terminal archive use the pinned configuration, and GET never archives', async () => {
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); assert.equal(run.origin, 'started'); assert.equal(run.state, 'running');
  await assert.rejects(service.finalizeRun(owner, run.id), rejects('run_not_terminal')); assert.equal(driver.exports, 0);
  await service.savePipeline(owner, recipe({ pipelineId: pipeline.id, createDataset: false, name: 'Later recipe' })); driver.complete(run);
  assert.equal((await service.getRun(owner, run.id)).upstreamState, 'completed'); assert.equal((await service.listRuns(owner))[0].archiveState, 'pending'); assert.equal(archives.length, 0);
  const finished = await service.finalizeRun(owner, run.id); assert.equal(finished.state, 'completed'); assert.equal(finished.archiveState, 'completed'); assert.ok(finished.datasetId); assert.equal(archives[0].pipeline.version, 1); assert.equal(archives[0].pipeline.createDataset, true);
  assert.ok(Buffer.isBuffer(archives[0].artifact.bytes)); assert.deepEqual(archives[0].artifact.bytes, driver.sessions.get(run.upstreamId!)!.artifact.bytes); assert.deepEqual(finished.nodeStates.map((node) => node.state), ['completed', 'completed', 'completed']);
  await service.finalizeRun(owner, run.id); assert.equal(archives.length, 1); await assert.rejects(service.getRun('sso:bob', run.id), rejects('run_not_found'));
});

test('include/exclude plain keywords preserve raw bytes and do not accept regex programs', async () => {
  const pipeline = await service.savePipeline(owner, recipe({ filter: { keywords: ['error'], mode: 'include' }, quality: { minBytes: 10 } })); const run = await service.startRun(owner, pipeline.id); driver.complete(run); const finished = await service.finalizeRun(owner, run.id);
  assert.equal(finished.state, 'completed'); assert.equal(archives[0].artifact.bytes.toString(), 'ERROR camera stalled\n'); assert.deepEqual(archives[0].artifact.rawBytes, driver.sessions.get(run.upstreamId!)!.artifact.bytes);
  const other = await service.savePipeline(owner, recipe({ filter: { keywords: ['ERROR'], mode: 'exclude' } })); const second = await service.startRun(owner, other.id); driver.complete(second); await service.finalizeRun(owner, second.id); assert.equal(archives[1].artifact.bytes.toString(), 'INFO ready\nINFO healthy\n');
  const literal = await service.savePipeline(owner, recipe({ filter: { keywords: ['.*'], mode: 'include' } })); const third = await service.startRun(owner, literal.id); driver.complete(third); const noMatch = await service.finalizeRun(owner, third.id); assert.equal(noMatch.state, 'failed'); assert.equal(noMatch.archiveError, 'collection_quality_min_bytes'); assert.equal(archives.length, 2);
});

test('quality failure and non-text filtering never falsely archive or create a dataset', async () => {
  const pipeline = await service.savePipeline(owner, recipe({ quality: { minBytes: 1000 } })); const run = await service.startRun(owner, pipeline.id); driver.complete(run); const failed = await service.finalizeRun(owner, run.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.nodeStates.find((node) => node.kind === 'quality')?.state, 'failed'); assert.equal(failed.nodeStates.at(-1)?.state, 'skipped'); assert.deepEqual(failed.assetIds, []); assert.equal(failed.datasetId, undefined); assert.equal(archives.length, 0);
  const json = await service.savePipeline(owner, recipe({ filter: { keywords: ['error'], mode: 'include' } })); const jsonRun = await service.startRun(owner, json.id); driver.sessions.get(jsonRun.upstreamId!)!.artifact.mimeType = 'application/json'; driver.complete(jsonRun); const rejected = await service.finalizeRun(owner, jsonRun.id); assert.equal(rejected.archiveError, 'collection_filter_requires_bounded_text'); assert.equal(archives.length, 0);
});

test('archive failures retry receipts idempotently without repeating source execution', async () => {
  let attempts = 0; const archive = archival; archival = async (...args) => { attempts++; const actual = await archive(...args); if (attempts === 1) throw new Error('private backend details'); return actual; };
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); driver.complete(run); const failed = await service.finalizeRun(owner, run.id); assert.equal(failed.archiveState, 'failed'); assert.equal(failed.archiveError, 'collection_archive_failed');
  const retried = await service.finalizeRun(owner, run.id); assert.equal(retried.state, 'completed'); assert.equal(retried.archiveState, 'completed'); assert.equal(retried.nodeStates.at(-1)?.error, undefined); assert.equal(driver.starts, 1); assert.equal(attempts, 2); assert.ok(!JSON.stringify(retried).includes('private backend'));
  await service.finalizeRun(owner, run.id); assert.equal(attempts, 2);
});

test('durable reservations cap active execution at two per actor and four globally', async () => {
  let finish!: () => void; driver.pauseStart = () => new Promise<void>((done) => { finish = done; }); const pipeline = await service.savePipeline(owner, recipe()); const pending = service.startRun(owner, pipeline.id);
  while (driver.starts < 1) await new Promise<void>((done) => setTimeout(done, 2)); driver.pauseStart = undefined;
  await service.startRun(owner, pipeline.id); await assert.rejects(service.startRun(owner, pipeline.id), rejects('concurrency_limit'));
  const bobs = await service.savePipeline('sso:bob', recipe()); await service.startRun('sso:bob', bobs.id); await service.startRun('sso:bob', bobs.id);
  const charlies = await service.savePipeline('sso:charlie', recipe()); await assert.rejects(service.startRun('sso:charlie', charlies.id), rejects('concurrency_limit')); finish(); await pending; assert.equal(driver.starts, 4);
});

test('legacy adoption uses real owner receipts, marks its origin and does not start again', async () => {
  const legacy = await driver.start({}, owner); const input = { name: 'Legacy capture', project: 'camera', source: 'edge', moduleId: 'ssh-logs', config: { targetId: 'x5', sourceId: 'kernel' }, upstreamId: legacy.upstreamId, createDataset: false };
  const adopted = await service.adoptRun(owner, input); assert.equal(adopted.origin, 'adopted'); assert.equal(driver.starts, 1); assert.equal((await service.adoptRun(owner, input)).id, adopted.id); assert.equal((await service.listPipelines(owner)).length, 1);
  await assert.rejects(service.adoptRun('sso:bob', input), rejects('upstream_not_found')); assert.deepEqual(await service.listPipelines('sso:bob'), []);
  const stopped = await service.stopRun(owner, adopted.id); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.archiveState, 'completed'); assert.equal(driver.stops, 1); assert.equal(stopped.datasetId, undefined);
});

test('known upstream restarts inherit the real failure while unknown starts never replay', async () => {
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); driver.complete(run, 'failed');
  const restarted = create(); const inherited = await restarted.getRun(owner, run.id); assert.equal(inherited.upstreamState, 'failed'); assert.equal(inherited.error, 'server_restart'); assert.equal(archives.length, 0);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); const entry = manifest.payload.runs[0]; entry.run.state = 'starting'; delete entry.run.upstreamId; delete entry.run.upstreamState; entry.startLease = { pid: 2147483647, instanceId: randomUUID(), token: randomUUID() }; manifest.sha256 = hash(JSON.stringify(manifest.payload)); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const interrupted = await create().getRun(owner, run.id); assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.error, 'collection_start_interrupted'); assert.equal(driver.starts, 1); await assert.rejects(service.finalizeRun(owner, run.id), rejects('run_not_terminal'));
});

test('executed-but-unconfirmed source starts stay interrupted, reserve capacity and never replay', async () => {
  const start = driver.start.bind(driver); driver.start = async (...args) => { await start(...args); throw new Error('private address and credentials'); };
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); assert.equal(run.state, 'interrupted'); assert.equal(run.error, 'collection_start_unconfirmed'); assert.equal(run.upstreamId, undefined); assert.ok(run.unknownUntil); assert.equal(driver.sessions.size, 1);
  await create().getRun(owner, run.id); await service.listRuns(owner); assert.equal(driver.starts, 1); assert.ok(!JSON.stringify(run).includes('private address'));
  await service.startRun(owner, pipeline.id); await assert.rejects(service.startRun(owner, pipeline.id), rejects('concurrency_limit')); assert.equal(driver.starts, 2);
});

test('background poll begins only after authorized execution and finalizes actual terminal output', async () => {
  const automatic = create(25); await automatic.modules(owner); await automatic.listPipelines(owner); await new Promise<void>((done) => setTimeout(done, 50)); assert.equal(driver.starts, 0); assert.equal(archives.length, 0);
  const pipeline = await automatic.savePipeline(owner, recipe()); const run = await automatic.startRun(owner, pipeline.id); driver.complete(run);
  const deadline = Date.now() + 3000; let result = await automatic.getRun(owner, run.id); while (result.archiveState !== 'completed' && Date.now() < deadline) { await new Promise<void>((done) => setTimeout(done, 20)); result = await automatic.getRun(owner, run.id); }
  assert.equal(result.archiveState, 'completed'); assert.equal(driver.starts, 1); assert.equal(archives.length, 1);
});

test('restart resumes known source polling without starting a second capture, and terminal stop finalizes', async () => {
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); driver.complete(run); const restarted = create(25);
  await restarted.getRun(owner, run.id); const deadline = Date.now() + 3000; let current = await restarted.getRun(owner, run.id); while (current.archiveState !== 'completed' && Date.now() < deadline) { await new Promise<void>((done) => setTimeout(done, 20)); current = await restarted.getRun(owner, run.id); }
  assert.equal(current.archiveState, 'completed'); assert.equal(driver.starts, 1);
  const another = await service.startRun(owner, pipeline.id); driver.complete(another); const finalized = await service.stopRun(owner, another.id); assert.equal(finalized.archiveState, 'completed'); assert.equal(driver.stops, 0);
});

test('corrupt or missing historical manifests and symlink state directories fail closed', async () => {
  const pipeline = await service.savePipeline(owner, recipe()); const original = await readFile(join(directory, 'manifest.json')); const payload = JSON.parse(original.toString()); payload.payload.pipelines[0].pipeline.name = 'tampered'; await writeFile(join(directory, 'manifest.json'), JSON.stringify(payload));
  await assert.rejects(service.listPipelines(owner), rejects('state_integrity_failure')); await writeFile(join(directory, 'manifest.json'), original); await rm(join(directory, 'manifest.json')); await assert.rejects(service.listPipelines(owner), rejects('state_integrity_failure'));
  await writeFile(join(directory, 'manifest.json'), original); assert.equal((await service.listPipelines(owner))[0].id, pipeline.id);
  const link = directory + '-link'; try { await symlink(directory, link); await assert.rejects(create(0, archival, link).listPipelines(owner), rejects('unsafe_state_directory')); } finally { await rm(link, { force: true }); }
});

test('exclusive metadata backup restores versions and completed receipts without executing drivers', async () => {
  const pipeline = await service.savePipeline(owner, recipe()); const run = await service.startRun(owner, pipeline.id); driver.complete(run); const finished = await service.finalizeRun(owner, run.id); const output = directory + '-backup';
  try { await service.backupTo(output); const restored = create(0, archival, output); assert.equal((await restored.listPipelines(owner))[0].currentVersion, 1); assert.deepEqual((await restored.getRun(owner, run.id)).assetIds, finished.assetIds); assert.equal(driver.starts, 1); assert.equal((await lstat(join(output, 'manifest.json'))).mode & 0o777, 0o600); } finally { await rm(output, { recursive: true, force: true }); }
});
