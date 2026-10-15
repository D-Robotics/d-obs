import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataCenterError, DataCenterService } from './data-center-service.js';

let directory: string; let service: DataCenterService;
const owner = 'sso:alice';
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const scope = { source: 'edge', kind: 'raw', project: 'camera', targetId: 'x5-camera-1' };
const uploadInput = (data: Buffer, extra = {}) => ({ title: 'sample', ...scope, filename: 'sample.raw', mimeType: 'application/octet-stream', sha256: hash(data), ...extra });
const error = (code: string) => (cause: unknown) => cause instanceof DataCenterError && cause.code === 'data_center_' + code;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'd-obs-data-center-service-')); service = new DataCenterService({ dataDir: directory }); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test('real file custody survives restart, is private, and returns defensive copies', async () => {
  const bytes = Buffer.from('real baseline frame'); const asset = await service.uploadAsset(owner, uploadInput(bytes), bytes);
  assert.equal(asset.storage, 'uploaded'); assert.equal(asset.sizeBytes, bytes.length); assert.equal(asset.sha256, hash(bytes));
  asset.title = 'local mutation';
  const restarted = new DataCenterService({ dataDir: directory }); assert.equal((await restarted.getAsset(owner, asset.id)).title, 'sample');
  assert.deepEqual((await restarted.readAsset(owner, asset.id)).data, bytes);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(join(directory, 'manifest.json'))).mode & 0o777, 0o600); assert.equal((await lstat(join(directory, 'blobs', asset.id + '.bin'))).mode & 0o777, 0o600);
  await assert.rejects(restarted.getAsset('sso:bob', asset.id), error('not_found')); await assert.rejects(service.overview('ops-admin'), error('identity_required'));
});

test('external references never become captured content and credential URLs are rejected', async () => {
  const asset = await service.createAsset(owner, { title: 'external', ...scope, referenceUri: 's3://private-bucket/scene.raw' });
  assert.equal(asset.sizeBytes, 0); assert.equal(asset.storage, 'external'); await assert.rejects(service.readAsset(owner, asset.id), error('content_unavailable'));
  for (const referenceUri of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.test/a', 'https://example.test/a?token=secret', 'https://example.test/a#secret', 'https://example.test/a%0aheader']) await assert.rejects(service.createAsset(owner, { title: 'bad', ...scope, referenceUri }));
  assert.equal((await service.listAssets(owner)).length, 1);
});

test('binary checksum, bounded storage and cleanup provide truthful capacity accounting', async () => {
  service = new DataCenterService({ dataDir: directory, maxAssetBytes: 4, maxUploadedBytes: 5, maxAssets: 2 }); const bytes = Buffer.from('1234');
  await assert.rejects(service.uploadAsset(owner, uploadInput(bytes, { sha256: 'a'.repeat(64) }), bytes), error('hash_mismatch'));
  await assert.rejects(service.uploadAsset(owner, uploadInput(Buffer.from('12345')), Buffer.from('12345')), error('upload_size_exceeded'));
  const asset = await service.uploadAsset(owner, uploadInput(bytes), bytes);
  await assert.rejects(service.uploadAsset('sso:bob', uploadInput(Buffer.from('12')), Buffer.from('12')), error('storage_quota_exceeded'));
  await service.deleteAsset(owner, asset.id); assert.equal((await service.overview(owner)).counts.uploadedBytes, 0);
  const next = await service.uploadAsset(owner, uploadInput(bytes), bytes); assert.ok(next.id !== asset.id); assert.deepEqual(await readdir(join(directory, 'blobs')), [next.id + '.bin']);
});

test('scoped collection tokens rotate, recover on restart, deduplicate retries and never falsely complete', async () => {
  const task = await service.createTask(owner, { title: 'actual capture', ...scope, expectedCount: 2 });
  await assert.rejects(service.updateTaskStatus(owner, task.id, { status: 'completed' }), error('invalid_task_transition'));
  const old = await service.rotateCollectionToken(owner, task.id); const current = await service.rotateCollectionToken(owner, task.id);
  const bytes = Buffer.from('first frame'); const minimal = { filename: 'first.raw', mimeType: 'application/octet-stream', sha256: hash(bytes) };
  await assert.rejects(service.ingestAsset(task.id, old.token, minimal, bytes), error('invalid_collection_token'));
  await assert.rejects(service.ingestAsset(task.id, current.token, { ...minimal, project: 'another-project' }, bytes), error('collection_scope_mismatch'));
  await assert.rejects(service.ingestAsset(task.id, current.token, { ...minimal, taskId: randomUUID() }, bytes), error('collection_scope_mismatch'));
  service = new DataCenterService({ dataDir: directory }); const first = await service.ingestAsset(task.id, current.token, minimal, bytes); const retry = await service.ingestAsset(task.id, current.token, minimal, bytes);
  assert.equal(retry.id, first.id); assert.equal((await service.listTasks(owner))[0].status, 'collecting'); assert.equal((await service.listTasks(owner))[0].assetIds.length, 1);
  await assert.rejects(service.updateTaskStatus(owner, task.id, { status: 'completed' }), error('collection_incomplete'));
  const second = Buffer.from('second frame'); await service.ingestAsset(task.id, current.token, { ...minimal, sha256: hash(second) }, second);
  assert.equal((await service.updateTaskStatus(owner, task.id, { status: 'completed' })).status, 'completed'); await assert.rejects(service.ingestAsset(task.id, current.token, minimal, bytes), error('invalid_collection_token'));
  const exported = JSON.stringify(await service.manifest(owner)); assert.ok(!exported.includes(current.token)); assert.ok(!exported.includes(hash(current.token))); assert.ok(!exported.includes('collectionTokens'));
  await assert.rejects(service.deleteAsset(owner, first.id), error('asset_in_use'));
});

test('cancelled or failed collections close credentials and release unreferenced file capacity', async () => {
  const task = await service.createTask(owner, { title: 'capture', ...scope, expectedCount: 1 }); const token = await service.rotateCollectionToken(owner, task.id); const bytes = Buffer.from('partial frame');
  const asset = await service.uploadAsset(owner, uploadInput(bytes, { taskId: task.id }), bytes);
  await service.updateTaskStatus(owner, task.id, { status: 'failed', notes: 'Capture source unavailable' }); await assert.rejects(service.validateCollectionToken(task.id, token.token), error('invalid_collection_token'));
  await assert.rejects(service.updateTaskStatus(owner, task.id, { status: 'collecting' }), error('invalid_task_transition')); await service.deleteAsset(owner, asset.id); assert.deepEqual((await service.listTasks(owner))[0].assetIds, []);
});

test('immutable dataset versions preserve assets, owner/project scope and enforce retention references', async () => {
  const bytes = Buffer.from('dataset frame'); const asset = await service.uploadAsset(owner, uploadInput(bytes), bytes);
  const v1 = await service.createDataset(owner, { name: 'scenes', project: 'camera', assetIds: [asset.id] }); const v2 = await service.createDataset(owner, { name: 'scenes', project: 'camera', assetIds: [asset.id] });
  assert.equal(v1.version, 1); assert.equal(v2.version, 2); v1.assets[0].title = 'caller edit'; assert.equal((await service.getDataset(owner, v1.id)).assets[0].title, 'sample');
  await assert.rejects(service.createDataset('sso:bob', { name: 'stolen', project: 'camera', assetIds: [asset.id] }), error('not_found'));
  await assert.rejects(service.createDataset(owner, { name: 'wrong', project: 'wrong', assetIds: [asset.id] }), error('project_mismatch'));
  await assert.rejects(service.createDataset(owner, { name: 'dup', project: 'camera', assetIds: [asset.id, asset.id] }), error('duplicate_asset_ids')); await assert.rejects(service.deleteAsset(owner, asset.id), error('asset_in_use'));
});

test('complete snapshots accept more than 200 real assets and remain bounded at 300', async () => {
  assert.equal(service.capabilities().maxDatasetAssets, 300); assert.equal(service.capabilities().quota.maxDatasetAssets, 300);
  const assets = [];
  for (let index = 0; index < 201; index++) { const bytes = Buffer.from('actual artifact ' + index); assets.push(await service.uploadAsset(owner, uploadInput(bytes, { title: 'artifact ' + index }), bytes)); }
  const dataset = await service.createDataset(owner, { name: 'complete vision snapshot', project: scope.project, assetIds: assets.map((asset) => asset.id) });
  assert.equal(dataset.assets.length, 201); assert.equal((await new DataCenterService({ dataDir: directory }).getDataset(owner, dataset.id)).assets.length, 201); assert.equal(dataset.assets.at(-1)?.sha256, hash(Buffer.from('actual artifact 200')));
  await assert.rejects(service.createDataset(owner, { name: 'over ceiling', project: scope.project, assetIds: Array.from({ length: 301 }, () => randomUUID()) })); assert.equal((await service.listDatasets(owner)).length, 1);
});

test('fixed-baseline numeric acceptance binds real independent evidence, target and candidate version', async () => {
  const upload = async (label: string, extra = {}) => { const bytes = Buffer.from(label); return service.uploadAsset(owner, uploadInput(bytes, extra), bytes); };
  const baseline = await upload('baseline'); const dataset = await service.createDataset(owner, { name: 'baseline scenes', project: 'camera', assetIds: [baseline.id] });
  const loop = await service.createLoop(owner, { title: 'Improve capture', goal: 'Reduce overexposure', project: 'camera', targetId: scope.targetId, datasetId: dataset.id, baseline: { assetId: baseline.id, metric: 'clipped-pixels', value: 20, unit: '%', version: 'v1' }, criterion: { direction: 'decrease', threshold: 5 } });
  const analysis = await upload('analysis'); const evaluation = await upload('evaluation'); const deployment = await upload('deployment'); const verification = await upload('new independent test');
  const evidence = (stage: string, assetId: string, extra = {}) => ({ stage, assetId, targetId: scope.targetId, version: 'v2', notes: 'Attached actual evidence file', ...extra });
  await assert.rejects(service.addEvidence(owner, loop.id, evidence('verification', verification.id, { baselineValue: 20, candidateValue: 10 })), error('invalid_loop_transition'));
  await service.addEvidence(owner, loop.id, evidence('analysis', analysis.id)); await service.addEvidence(owner, loop.id, evidence('evaluation', evaluation.id));
  await assert.rejects(service.addEvidence(owner, loop.id, evidence('deployment', deployment.id, { version: 'v3' })), error('candidate_version_mismatch'));
  assert.equal((await service.addEvidence(owner, loop.id, evidence('deployment', deployment.id))).status, 'deployed');
  await assert.rejects(service.addEvidence(owner, loop.id, evidence('verification', verification.id, { baselineValue: 19, candidateValue: 10 })), error('invalid_verification_measurements'));
  const reused = await upload('evaluation'); await assert.rejects(service.addEvidence(owner, loop.id, evidence('verification', reused.id, { baselineValue: 20, candidateValue: 10 })), error('independent_verification_asset_required'));
  const failed = await service.addEvidence(owner, loop.id, evidence('verification', verification.id, { baselineValue: 20, candidateValue: 18 })); assert.equal(failed.status, 'verification_failed'); assert.equal(failed.evidence.at(-1)?.passed, false);
  const fresh = await upload('second independent test'); const passed = await service.addEvidence(owner, loop.id, evidence('verification', fresh.id, { baselineValue: 20, candidateValue: 15 }));
  assert.equal(passed.status, 'verified'); assert.equal(passed.evidence.at(-1)?.improvement, 5); assert.equal(passed.evidence.at(-1)?.measurementSource, 'reported');
  await assert.rejects(service.addEvidence(owner, loop.id, evidence('verification', fresh.id, { baselineValue: 20, candidateValue: 0 })), error('invalid_loop_transition'));
});

test('blob/metadata tampering fails closed instead of completing collections or accepting datasets', async () => {
  const bytes = Buffer.from('frame'); const task = await service.createTask(owner, { title: 'capture', ...scope, expectedCount: 1 }); const asset = await service.uploadAsset(owner, uploadInput(bytes, { taskId: task.id }), bytes);
  await writeFile(join(directory, 'blobs', asset.id + '.bin'), Buffer.from('bogus'));
  await assert.rejects(service.readAsset(owner, asset.id), error('asset_integrity_failure')); await assert.rejects(service.updateTaskStatus(owner, task.id, { status: 'completed' }), error('asset_integrity_failure')); assert.equal((await service.listTasks(owner))[0].status, 'collecting');
  await assert.rejects(service.createDataset(owner, { name: 'invalid', project: 'camera', assetIds: [asset.id] }), error('asset_integrity_failure'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); manifest.payload.accounts[0].assets[0].title = 'tampered'; await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(new DataCenterService({ dataDir: directory }).overview(owner), error('state_integrity_failure'));
});

test('prior evidence corruption or a rehashed forged completion cannot advance the closed loop', async () => {
  const upload = async (content: string) => { const bytes = Buffer.from(content); return service.uploadAsset(owner, uploadInput(bytes), bytes); };
  const baseline = await upload('baseline'); const dataset = await service.createDataset(owner, { name: 'locked scenes', project: 'camera', assetIds: [baseline.id], description: 'First line\nSecond line' });
  const loop = await service.createLoop(owner, { title: 'honest loop', goal: 'First goal\nSecond goal', project: 'camera', targetId: scope.targetId, datasetId: dataset.id, baseline: { assetId: baseline.id, metric: 'quality', value: 10, version: 'v1' }, criterion: { direction: 'increase', threshold: 2 } });
  const analysis = await upload('analysis'); const evaluation = await upload('evaluation'); const evidence = (stage: string, assetId: string) => ({ stage, assetId, targetId: scope.targetId, version: 'v2', notes: 'First observation\nSecond observation' });
  await service.addEvidence(owner, loop.id, evidence('analysis', analysis.id)); await writeFile(join(directory, 'blobs', analysis.id + '.bin'), Buffer.from('tampered'));
  await assert.rejects(service.addEvidence(owner, loop.id, evidence('evaluation', evaluation.id)), error('asset_integrity_failure')); assert.equal((await service.getLoop(owner, loop.id)).status, 'analyzed');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); manifest.payload.accounts[0].loops[0].status = 'verified'; manifest.sha256 = hash(JSON.stringify(manifest.payload)); await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(new DataCenterService({ dataDir: directory }).getLoop(owner, loop.id), error('state_integrity_failure'));
});

test('symlink content cannot expose another file and recovery cleans only uncommitted blobs', async () => {
  const bytes = Buffer.from('frame'); const asset = await service.uploadAsset(owner, uploadInput(bytes), bytes); const blob = join(directory, 'blobs', asset.id + '.bin');
  await rm(blob); await symlink(join(directory, 'manifest.json'), blob); await assert.rejects(service.readAsset(owner, asset.id), error('asset_integrity_failure'));
  await rm(blob); await writeFile(blob, bytes); const orphan = randomUUID() + '.bin'; await writeFile(join(directory, 'blobs', orphan), 'uncommitted');
  await new DataCenterService({ dataDir: directory }).listAssets(owner); assert.deepEqual(await readdir(join(directory, 'blobs')), [asset.id + '.bin']);
});

test('missing historical manifest fails closed and preserves every real blob', async () => {
  const bytes = Buffer.from('irreplaceable capture'); const asset = await service.uploadAsset(owner, uploadInput(bytes), bytes); await rm(join(directory, 'manifest.json'));
  await assert.rejects(new DataCenterService({ dataDir: directory }).overview(owner), error('state_integrity_failure')); assert.deepEqual(await readFile(join(directory, 'blobs', asset.id + '.bin')), bytes);
  await assert.rejects(service.createTask(owner, { title: 'must not reset history', ...scope, expectedCount: 1 }), error('state_integrity_failure'));
});

test('initialization preserves metadata-only history and safely recovers the first uncommitted upload', async () => {
  await service.overview(owner); const orphan = randomUUID() + '.bin'; await writeFile(join(directory, 'blobs', orphan), 'interrupted first upload');
  await new DataCenterService({ dataDir: directory }).overview(owner); assert.deepEqual(await readdir(join(directory, 'blobs')), []);
  await service.createAsset(owner, { title: 'metadata-only history', ...scope, referenceUri: 's3://bucket/sample.raw' }); await rm(join(directory, 'manifest.json'));
  await assert.rejects(service.listAssets(owner), error('state_integrity_failure')); assert.equal((await readdir(directory)).includes('initialized'), true);
});

test('trusted Vision imports are atomically idempotent, and consistent backups restore all accounts', async () => {
  const bytes = Buffer.from('vision file'); const provenance = { system: 'vision-workshop' as const, experimentId: randomUUID(), artifactId: randomUUID(), artifactType: 'raw' as const };
  const [first, second] = await Promise.all([service.importVerifiedAsset(owner, uploadInput(bytes), bytes, provenance), new DataCenterService({ dataDir: directory }).importVerifiedAsset(owner, uploadInput(bytes), bytes, provenance)]);
  assert.equal(first.id, second.id); const bobs = await service.uploadAsset('sso:bob', uploadInput(Buffer.from('bobs')), Buffer.from('bobs'));
  const task = await service.createTask(owner, { title: 'token remains live', ...scope, expectedCount: 1 }); const token = await service.rotateCollectionToken(owner, task.id);
  const backupDir = join(directory, '..', 'd-obs-backup-' + randomUUID());
  try { const backup = await service.backupState(backupDir); assert.equal(backup.assets, 2); const restored = new DataCenterService({ dataDir: backupDir }); assert.deepEqual((await restored.readAsset(owner, first.id)).data, bytes); assert.equal((await restored.listAssets(owner)).length, 1); assert.equal((await restored.getAsset('sso:bob', bobs.id)).id, bobs.id); await service.validateCollectionToken(task.id, token.token); await assert.rejects(restored.validateCollectionToken(task.id, token.token), error('invalid_collection_token')); await assert.rejects(service.backupState(backupDir)); } finally { await rm(backupDir, { recursive: true, force: true }); }
});

test('concurrent processes recover a dead owner and preserve every committed task', async () => {
  await mkdir(join(directory, 'blobs')); await writeFile(join(directory, 'store.lock'), JSON.stringify({ pid: 2147483647, token: randomUUID() }));
  const moduleUrl = new URL('./data-center-service.js', import.meta.url).href;
  const child = (index: number) => new Promise<void>((done, reject) => {
    const script = `import { DataCenterService } from ${JSON.stringify(moduleUrl)}; const service=new DataCenterService({dataDir:${JSON.stringify(directory)}}); for(let i=0;i<5;i++) await service.createTask('sso:alice',{title:'worker-${index}-'+i,source:'edge',kind:'raw',project:'camera',targetId:'x5',expectedCount:1});`;
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: ['ignore', 'ignore', 'pipe'] }); let errors = ''; process.stderr.on('data', (data) => { errors += data; }); process.on('error', reject); process.on('exit', (code) => code === 0 ? done() : reject(new Error(errors)));
  });
  await Promise.all([child(1), child(2), child(3)]); assert.equal((await service.listTasks(owner)).length, 15);
});
