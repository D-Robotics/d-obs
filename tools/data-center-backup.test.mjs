import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, readFile, readdir, cp, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backupDataCenter } from './data-center-backup.mjs';
import { DataCenterService } from '../server/monitoring/data-center-service.js';
import { CollectionWorkspaceService } from '../server/monitoring/collection-workspace-service.js';

test('consistent data snapshot restores real bytes and retains only managed backup directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-center-backup-test-'));
  try {
    const state = join(dir, 'state'), backups = join(dir, 'backups');
    const service = new DataCenterService({ dataDir: state });
    const bytes = Buffer.from('fixture real sample'); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset = await service.uploadAsset('fixture:alice', { title: 'fixture', kind: 'document', source: 'cloud', project: 'test', filename: 'sample.txt', mimeType: 'text/plain', sha256 }, bytes);
    const dataset = await service.createDataset('fixture:alice', { name: 'fixture', project: 'test', assetIds: [asset.id] });
    await mkdir(backups); await mkdir(join(backups, 'unrelated')); await symlink(state, join(backups, 'unrelated-link'));
    const first = await backupDataCenter({ stateDir: state, backupDir: backups, keep: 1, now: new Date('2026-10-12T01:00:00.000Z') });
    assert.equal(first.assets, 1); assert.equal(first.manifestSha256, createHash('sha256').update(await readFile(join(backups, first.snapshot, 'manifest.json'))).digest('hex'));
    const restoredDir = join(dir, 'restored'); await cp(join(backups, first.snapshot), restoredDir, { recursive: true });
    const restored = new DataCenterService({ dataDir: restoredDir });
    assert.deepEqual((await restored.readAsset('fixture:alice', asset.id)).data, bytes);
    assert.equal((await restored.getDataset('fixture:alice', dataset.id)).assets[0].sha256, sha256);
    const second = await backupDataCenter({ stateDir: state, backupDir: backups, keep: 1, now: new Date('2026-10-12T02:00:00.000Z') });
    const entries = await readdir(backups); assert.ok(entries.includes(second.snapshot)); assert.ok(!entries.includes(first.snapshot));
    assert.ok(entries.includes('unrelated')); assert.ok(entries.includes('unrelated-link'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('backup refuses unsafe directory relationships and symlink destinations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-center-backup-unsafe-'));
  try {
    const state = join(dir, 'state'); await mkdir(state); const elsewhere = join(dir, 'elsewhere'); await mkdir(elsewhere); const link = join(dir, 'link'); await symlink(elsewhere, link);
    for (const backupDir of [state, join(state, 'snapshots'), dir, link]) await assert.rejects(backupDataCenter({ stateDir: state, backupDir }));
    assert.deepEqual(await readdir(elsewhere), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('combined snapshot restores immutable collection versions/receipts and revokes ingest credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-center-collection-backup-')); let collection, restoredCollection;
  try {
    const state = join(dir, 'state'), backups = join(dir, 'backups'); const data = new DataCenterService({ dataDir: state }); const owner = 'sso:alice'; const bytes = Buffer.from('actual captured output\n');
    const task = await data.createTask(owner, { title: 'receive', project: 'test', kind: 'log', source: 'edge', targetId: 'x5', expectedCount: 1 }); const credential = await data.rotateCollectionToken(owner, task.id);
    const upstreamId = randomUUID(); let starts = 0;
    const driver = { moduleId: 'ssh-logs', version: '1.0.0', describe: () => ({ moduleId: 'ssh-logs', version: '1.0.0', mode: 'pull', label: 'Logs', description: 'fixture', available: true, targets: [], configSchema: { fields: [] }, canStart: true, canStop: true }), validate: () => ({}), start: async () => { starts++; return { upstreamId }; }, inspect: async () => ({ state: 'completed', recordCount: 1, byteCount: bytes.length }), export: async () => ({ filename: 'capture.log', mimeType: 'text/plain', kind: 'log', bytes }) };
    collection = new CollectionWorkspaceService({ stateDir: join(state, 'collection-workspace'), drivers: [driver], pollIntervalMs: 0, archive: async (actor, _run, pipeline, artifact) => { const asset = await data.uploadAsset(actor, { title: 'captured', project: pipeline.project, source: pipeline.source, kind: artifact.kind, filename: artifact.filename, mimeType: artifact.mimeType, sha256: createHash('sha256').update(artifact.bytes).digest('hex') }, artifact.bytes); const dataset = await data.createDataset(actor, { name: 'run', project: pipeline.project, assetIds: [asset.id] }); return { assetIds: [asset.id], datasetId: dataset.id }; } });
    const input = { name: 'logs', project: 'test', source: 'edge', moduleId: 'ssh-logs', moduleVersion: '1.0.0', config: {}, createDataset: true }; const pipeline = await collection.savePipeline(owner, input); await collection.savePipeline(owner, { ...input, pipelineId: pipeline.id, name: 'new version' }); const run = await collection.startRun(owner, pipeline.id, 1); const completed = await collection.finalizeRun(owner, run.id);
    const snapshot = await backupDataCenter({ stateDir: state, backupDir: backups }); assert.equal(starts, 1); const restored = join(dir, 'restored'); await cp(join(backups, snapshot.snapshot), restored, { recursive: true });
    const restoredData = new DataCenterService({ dataDir: restored }); restoredCollection = new CollectionWorkspaceService({ stateDir: join(restored, 'collection-workspace'), drivers: [], archive: async () => { throw new Error('must not execute'); }, pollIntervalMs: 0 });
    assert.equal((await restoredCollection.listPipelines(owner))[0].versions.length, 2); assert.deepEqual((await restoredCollection.getRun(owner, run.id)).assetIds, completed.assetIds); assert.deepEqual((await restoredData.readAsset(owner, completed.assetIds[0])).data, bytes); assert.equal((await restoredData.getDataset(owner, completed.datasetId)).assetIds[0], completed.assetIds[0]);
    await assert.rejects(restoredData.validateCollectionToken(task.id, credential.token)); await data.validateCollectionToken(task.id, credential.token); assert.equal((await lstat(join(restored, 'collection-workspace', 'manifest.json'))).mode & 0o777, 0o600);
  } finally { await collection?.dispose(); await restoredCollection?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('corrupt collection state aborts combined backup before publishing a snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-center-corrupt-collection-backup-')); let collection;
  try {
    const state = join(dir, 'state'), backups = join(dir, 'backups'); const data = new DataCenterService({ dataDir: state }); await data.overview('sso:alice');
    const collectionDir = join(state, 'collection-workspace'); collection = new CollectionWorkspaceService({ stateDir: collectionDir, drivers: [], archive: async () => ({ assetIds: [] }), pollIntervalMs: 0 }); await collection.listPipelines('sso:alice'); await writeFile(join(collectionDir, 'manifest.json'), '{broken');
    await assert.rejects(backupDataCenter({ stateDir: state, backupDir: backups })); assert.deepEqual(await readdir(backups), []);
  } finally { await collection?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
