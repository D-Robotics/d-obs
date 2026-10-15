import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { DataCenterService } from './data-center-service.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { importVisionExperiment, registerDataCenterVisionBridge } from './data-center-vision-bridge.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { listPlatformOperations } from './platform-operations.js';

const owner = 'sso:alice';
const metadata = { scene: 'fixture-test', width: 2, height: 2, bitDepth: 10 as const, bayer: 'RGGB' as const,
  packing: 'unpacked16le' as const, stride: 4, blackLevel: 0, whiteLevel: 1023 };

async function fixture(action: (data: DataCenterService, vision: VisionWorkshopService, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'd-obs-data-bridge-'));
  try { await action(new DataCenterService({ dataDir: join(dir, 'data') }), new VisionWorkshopService({ dataDir: join(dir, 'vision') }), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('Vision import preserves actual byte provenance, is idempotent, and leaves quality unverified', async () => {
  await fixture(async (data, vision) => {
    const experiment = await vision.createExperiment(owner, { title: '真实字节fixture', goal: 'test', targetId: 'fixture-camera' });
    const sample = await vision.addRunnerRawSample(owner, experiment.id, { filename: 'sample.raw', metadata, adapterId: 'fixture-camera' }, Buffer.alloc(8));
    const imported = await importVisionExperiment(data, vision, owner, experiment.id, 'camera-test');
    assert.equal(imported.qualityVerification, 'unverified');
    assert.equal(imported.assetIds.length, 2);
    const assets = await data.listAssets(owner);
    const raw = assets.find((entry) => entry.provenance?.artifactType === 'raw');
    assert.ok(raw); assert.equal(raw.sha256, sample.hash); assert.equal(raw.source, 'edge');
    assert.equal(raw.provenance?.artifactId, sample.id); assert.equal(raw.provenance?.experimentId, experiment.id);
    const again = await importVisionExperiment(data, vision, owner, experiment.id, 'camera-test');
    assert.deepEqual(again, imported);
    const concurrent = await Promise.all([importVisionExperiment(data, vision, owner, experiment.id, 'camera-test'), importVisionExperiment(data, vision, owner, experiment.id, 'camera-test')]);
    assert.equal(concurrent[0].datasetId, imported.datasetId); assert.equal(concurrent[1].datasetId, imported.datasetId);
    assert.equal((await data.listDatasets(owner)).length, 1);
    assert.equal((await data.listAssets('sso:bob')).length, 0);
    await assert.rejects(importVisionExperiment(data, vision, 'sso:bob', experiment.id, 'camera-test'));
  });
});

test('import rejects empty or corrupt experiments without creating a misleading snapshot', async () => {
  await fixture(async (data, vision, dir) => {
    const experiment = await vision.createExperiment(owner, { title: 'test', goal: 'test' });
    await assert.rejects(importVisionExperiment(data, vision, owner, experiment.id, 'camera-test'), /实验尚无/);
    const sample = await vision.addRawSample(owner, experiment.id, { filename: 'sample.raw', metadata }, Buffer.alloc(8));
    await writeFile(join(dir, 'vision', 'assets', sample.id + '.raw'), Buffer.alloc(8, 255));
    await assert.rejects(importVisionExperiment(data, vision, owner, experiment.id, 'camera-test'));
    assert.equal((await data.listAssets(owner)).length, 0);
    assert.equal((await data.listDatasets(owner)).length, 0);
  });
});

test('changed Vision data creates a new immutable dataset, keeping the former lineage intact', async () => {
  await fixture(async (data, vision) => {
    const experiment = await vision.createExperiment(owner, { title: 'test', goal: 'test' });
    await vision.addRawSample(owner, experiment.id, { filename: 'sample.raw', metadata }, Buffer.alloc(8));
    const first = await importVisionExperiment(data, vision, owner, experiment.id, 'camera-test');
    await vision.addRawSample(owner, experiment.id, { filename: 'second.raw', metadata }, Buffer.alloc(8, 1));
    const second = await importVisionExperiment(data, vision, owner, experiment.id, 'camera-test');
    assert.notEqual(first.datasetId, second.datasetId);
    assert.equal((await data.listDatasets(owner)).length, 2);
    const datasets = await data.listDatasets(owner);
    assert.equal(datasets.find((entry) => entry.id === first.datasetId)?.assetIds.length, 2);
    assert.equal(datasets.find((entry) => entry.id === second.datasetId)?.assetIds.length, 3);
  });
});

test('bridge HTTP enforces identity, intent and read-only mode; reviewed operations are discoverable', async () => {
  await fixture(async (data, vision) => {
    const saved = process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;
    process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
    configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('x-test-user') ? { id: req.header('x-test-user')!, email: 'fixture@example.invalid' } : null,
      isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
    const router = express.Router(); const app = express(); app.use(express.json());
    registerDataCenterVisionBridge(router, { getDataService: () => data, getVisionService: () => vision }); app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); const origin = 'http://127.0.0.1:' + addr.port;
    const experiment = await vision.createExperiment(owner, { title: 'test', goal: 'test' });
    await vision.addRawSample(owner, experiment.id, { filename: 'sample.raw', metadata }, Buffer.alloc(8));
    const path = '/api/ops/observability/data-center';
    try {
      assert.equal((await fetch(origin + path + '/vision-experiments')).status, 403);
      const client = await fetch(origin + '/ops-observability/data-center/upload-client.mjs');
      assert.equal(client.status, 200);
      assert.ok(client.headers.get('content-disposition')?.includes('attachment'));
      const clientSource = await client.text();
      assert.match(clientSource, /RDK_DATA_COLLECTION_TOKEN/);
      assert.equal(await (await fetch(origin + '/ops-observability/data-center/upload-client.mjs?path=/etc/passwd')).text(), clientSource);
      const opts = { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'alice' }, body: JSON.stringify({ project: 'camera-test' }) };
      assert.equal((await fetch(origin + path + '/imports/vision/' + experiment.id, opts)).status, 400);
      assert.equal((await fetch(origin + path + '/imports/vision/' + experiment.id, { ...opts, headers: { ...opts.headers, 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1' } })).status, 403);
      assert.equal((await fetch(origin + path + '/imports/vision/' + experiment.id, { ...opts, headers: { ...opts.headers, 'x-rdk-ops-action': 'observability', 'x-test-user': 'bob' } })).status, 404);
      assert.equal((await data.listAssets(owner)).length, 0);
      const result = await fetch(origin + path + '/imports/vision/' + experiment.id, { ...opts, headers: { ...opts.headers, 'x-rdk-ops-action': 'observability' } });
      assert.equal(result.status, 201);
      assert.equal(listPlatformOperations(router).filter((entry) => entry.group === '数据闭环中心').length, 2);
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      if (saved === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = saved;
      resetObservabilityAccessAdapter();
    }
  });
});
