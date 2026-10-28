import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { VisionWorkshopError, VisionWorkshopService, visionWorkshopLimitsFromEnv, type VisionRawMetadata, type VisionWorkshopOptions } from './vision-workshop-service.js';
import { analyzeVisionRaw } from './vision-workshop-raw.js';
import { compareVisionProcessedPng } from './vision-workshop-quality.js';
import { createVisionArchive, renderVisionHandbook } from './vision-workshop-export.js';

const metadata: VisionRawMetadata = { scene: '逆光', width: 4, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 8, blackLevel: 0, whiteLevel: 1023, exposureUs: 5000, gain: 1 };
const raw = Buffer.alloc(16);
for (let i = 0; i < 8; i += 1) raw.writeUInt16LE(100 + i * 100, i * 2);
const baselineInput = { tuning: { denoise: { strength: 2 }, gamma: [0, 0.5, 1] }, rules: [{ path: '/denoise/strength', label: '降噪强度', min: 0, max: 10 }, { path: '/gamma/1', label: '中间亮度', min: 0, max: 1 }] };
const input = { title: 'IMX415 Workshop', goal: '改善逆光场景的暗部细节' };
const errorCode = (code: string) => (error: unknown) => error instanceof VisionWorkshopError && error.code === code;

async function fixture(options: VisionWorkshopOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'd-obs-vision-service-'));
  return { dataDir, service: new VisionWorkshopService({ ...options, dataDir }), cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

function png(width = 4, height = 2, compressedPixels?: Buffer, pixel = 0): Buffer {
  const chunk = (name: string, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), payload]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
    const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) rows.fill(pixel, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressedPixels ?? deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('vision experiment retains genuine assets, immutable baselines and evaluated selection across restart', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    assert.equal(experiment.sensorModel, undefined);
    assert.equal(experiment.board, undefined);
    assert.ok(!Object.hasOwn(experiment, 'sensorVendor'));
    assert.equal(env.service.capabilities().apply.status, 'unavailable');
    const baseline = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRawSample('account-a', experiment.id, { filename: 'frame.raw', metadata }, raw);
    assert.equal(sample.hash, createHash('sha256').update(raw).digest('hex'));
    assert.equal(sample.source, 'uploaded');
    const candidate = await env.service.createCandidate('account-a', experiment.id, {
      baselineHash: baseline.hash, source: 'model', model: 'test-model', sampleIds: [sample.id],
      patches: [{ path: '/denoise/strength', value: 3, reason: '基于场景目标提出候选' }, { path: '/gamma/1', value: 0.6, reason: '提升中间亮度' }],
    });
    assert.equal(candidate.verification, 'unverified');
    assert.deepEqual(candidate.tuning, { denoise: { strength: 3 }, gamma: [0, 0.6, 1] });
    assert.equal(candidate.baselineHash, baseline.hash);
    assert.deepEqual(candidate.sampleHashes, [sample.hash]);
    await assert.rejects(env.service.selectCandidate('account-a', experiment.id, candidate.id), errorCode('evaluation_required'));
    const image = await env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, candidateId: candidate.id, mimeType: 'image/png' }, png());
    assert.equal(image.source, 'uploaded');
    assert.equal(image.verification, 'unverified');
    const evaluation = await env.service.addEvaluation('account-a', experiment.id, { imageId: image.id, rating: 4, notes: '暗部细节更清晰，仍需真机检验' });
    assert.equal(evaluation.source, 'manual');
    const selected = await env.service.selectCandidate('account-a', experiment.id, candidate.id);
    assert.equal(selected.selectedCandidateId, candidate.id);
    const manifest = await env.service.exportManifest('account-a', experiment.id);
    assert.deepEqual(manifest.selectedTuning, candidate.tuning);
    assert.equal(manifest.provenance.boardValidation, 'unavailable');
    const handbook = await env.service.exportHandbook('account-a', experiment.id);
    assert.equal(handbook.selectedCandidate?.id, candidate.id);
    const restarted = new VisionWorkshopService({ dataDir: env.dataDir });
    assert.deepEqual(await restarted.getExperiment('account-a', experiment.id), selected);
    const recoveredRaw = await restarted.readRawSample('account-a', experiment.id, sample.id);
    assert.ok(Buffer.isBuffer(recoveredRaw.data));
    assert.deepEqual(recoveredRaw.data, raw);
    assert.deepEqual((await restarted.readProcessedImage('account-a', experiment.id, image.id)).data, png());
    const next = await restarted.setBaseline('account-a', experiment.id, { ...baselineInput, tuning: { denoise: { strength: 4 }, gamma: [0, 0.5, 1] } });
    const revised = await restarted.getExperiment('account-a', experiment.id);
    assert.equal(revised.selectedCandidateId, null);
    assert.equal(revised.baselineHistory.length, 2);
    assert.deepEqual(revised.candidates[0]?.tuning, candidate.tuning);
    assert.equal(revised.candidates[0]?.baselineHash, baseline.hash);
    assert.notEqual(next.hash, baseline.hash);
    await assert.rejects(restarted.createCandidate('account-a', experiment.id, { baselineHash: baseline.hash, source: 'manual', sampleIds: [sample.id], patches: [{ path: '/denoise/strength', value: 5, reason: 'test' }] }), errorCode('stale_baseline'));
  } finally { await env.cleanup(); }
});

test('vision operations isolate authenticated accounts including direct asset reads and exports', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const baseline = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    const candidate = await env.service.createCandidate('account-a', experiment.id, { baselineHash: baseline.hash, sampleIds: [sample.id], source: 'manual', patches: [{ path: '/denoise/strength', value: 3, reason: 'test' }] });
    const image = await env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, candidateId: candidate.id, mimeType: 'image/png' }, png());
    assert.deepEqual(await env.service.listExperiments('account-b'), []);
    for (const operation of [
      () => env.service.getExperiment('account-b', experiment.id),
      () => env.service.setBaseline('account-b', experiment.id, baselineInput),
      () => env.service.addRawSample('account-b', experiment.id, { metadata }, raw),
      () => env.service.readRawSample('account-b', experiment.id, sample.id),
      () => env.service.readProcessedImage('account-b', experiment.id, image.id),
      () => env.service.addEvaluation('account-b', experiment.id, { imageId: image.id, rating: 5, notes: 'fake' }),
      () => env.service.selectCandidate('account-b', experiment.id, candidate.id),
      () => env.service.exportManifest('account-b', experiment.id),
      () => env.service.exportHandbook('account-b', experiment.id),
      () => env.service.recordDeviceRun('account-b', experiment.id, { operation: 'probe', status: 'completed', sensorModel: 'IMX415', adapterId: 'test', evidence: {} }),
    ]) await assert.rejects(operation(), errorCode('not_found'));
    await assert.rejects(env.service.createExperiment('account-b', { ...input, accountId: 'account-a' } as never), errorCode('invalid_input'));
    await assert.rejects(env.service.getExperiment('account-a', '../manifest.json'), errorCode('not_found'));
  } finally { await env.cleanup(); }
});

test('vision candidates reject an entire invalid patch batch and foreign evidence without mutating the baseline', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const baseline = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    const common = { baselineHash: baseline.hash, sampleIds: [sample.id], source: 'manual' as const };
    for (const badPatch of [
      { path: '/invented/strength', value: 3, reason: 'fake' },
      { path: '/denoise/strength', value: 99, reason: 'outside range' },
      { path: '/__proto__/polluted', value: 1, reason: 'unsafe' },
      { path: '/denoise/strength', value: NaN, reason: 'not numeric' },
    ]) await assert.rejects(env.service.createCandidate('account-a', experiment.id, { ...common, patches: [{ path: '/gamma/1', value: 0.7, reason: 'valid first change' }, badPatch] }), errorCode('invalid_input'));
    assert.equal((await env.service.getExperiment('account-a', experiment.id)).candidates.length, 0);
    assert.deepEqual((await env.service.getExperiment('account-a', experiment.id)).baseline?.tuning, baselineInput.tuning);
    await assert.rejects(env.service.createCandidate('account-a', experiment.id, { ...common, sampleIds: [randomUUID()], patches: [{ path: '/gamma/1', value: 0.7, reason: 'test' }] }), errorCode('not_found'));
    await assert.rejects(env.service.setBaseline('account-a', experiment.id, { tuning: JSON.parse('{"__proto__":{"polluted":1},"n":2}'), rules: [{ path: '/n', label: 'n', min: 0, max: 10 }] }), errorCode('invalid_input'));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  } finally { await env.cleanup(); }
});

test('vision candidate snapshot identity rejects changed rules even when tuning bytes keep the same hash', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const first = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    const second = await env.service.setBaseline('account-a', experiment.id, { ...baselineInput, rules: baselineInput.rules.map((rule) => ({ ...rule, label: rule.label + '新版本' })) });
    assert.equal(first.hash, second.hash); assert.notEqual(first.id, second.id);
    await assert.rejects(env.service.createCandidate('account-a', experiment.id, { baselineId: first.id, baselineHash: first.hash, source: 'model', model: 'fixture-model', sampleIds: [sample.id], patches: [{ path: '/denoise/strength', value: 3, reason: 'test' }] }), errorCode('stale_baseline'));
    assert.equal((await env.service.getExperiment('account-a', experiment.id)).candidates.length, 0);
  } finally { await env.cleanup(); }
});

test('vision raw and processed uploads enforce real frame lengths, formats and dimensions', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    for (const invalid of [Buffer.concat([raw, raw]), raw.subarray(0, 8)]) await assert.rejects(env.service.addRawSample('account-a', experiment.id, { metadata }, invalid), errorCode('invalid_input'));
    await assert.rejects(env.service.addRawSample('account-a', experiment.id, { metadata: { ...metadata, bitDepth: 8 } }, raw), errorCode('invalid_input'));
    await assert.rejects(env.service.addRawSample('account-a', experiment.id, { metadata, filename: '../bad.raw' }, raw), errorCode('invalid_input'));
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    await assert.rejects(env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png' }, Buffer.from('<svg width="4" height="2"/>')), errorCode('invalid_image'));
    await assert.rejects(env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png' }, png(2, 2)), errorCode('invalid_image_dimensions'));
    await assert.rejects(env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png' }, png().subarray(0, 33)), errorCode('invalid_image'));
    const badCrc = png(); badCrc[badCrc.length - 1] ^= 1;
    for (const invalidPng of [badCrc, png(4, 2, Buffer.from('invalid zlib')), png(4, 2, deflateSync(Buffer.alloc(1))), png(4, 2, deflateSync(Buffer.alloc(200_000)))]) {
      await assert.rejects(env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png' }, invalidPng), errorCode('invalid_image'));
    }
    await assert.rejects(env.service.addRawSample('account-a', experiment.id, { metadata, source: 'runner' } as never, raw), errorCode('invalid_input'));
    assert.equal((await env.service.getExperiment('account-a', experiment.id)).bytesStored, raw.length);
  } finally { await env.cleanup(); }
});

test('vision bounded quota checks remain correct across simultaneous service instances', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const metadataBytes = Buffer.byteLength(JSON.stringify(experiment));
    const first = new VisionWorkshopService({ dataDir: env.dataDir, maxTotalBytes: metadataBytes + 620 });
    const second = new VisionWorkshopService({ dataDir: env.dataDir, maxTotalBytes: metadataBytes + 620 });
    const results = await Promise.allSettled([first, second, first, second].map((service) => service.addRawSample('account-a', experiment.id, { metadata }, raw)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results) if (result.status === 'rejected') assert.equal((result.reason as VisionWorkshopError).code, 'quota_exceeded');
    const saved = await env.service.getExperiment('account-a', experiment.id);
    assert.equal(saved.samples.length, 1);
    assert.equal(saved.bytesStored, raw.length);
    assert.equal((await readdir(join(env.dataDir, 'assets'))).length, 1);
    const limited = new VisionWorkshopService({ dataDir: env.dataDir, maxExperiments: 1, maxRawBytes: 8 });
    await assert.rejects(limited.createExperiment('account-b', input), errorCode('quota_exceeded'));
    await assert.rejects(limited.addRawSample('account-a', experiment.id, { metadata }, raw), errorCode('file_too_large'));
  } finally { await env.cleanup(); }
});

test('storage limits are deployable per host, default unchanged and never exceed their ceilings', () => {
  assert.deepEqual(visionWorkshopLimitsFromEnv({}), { maxExperimentBytes: undefined, maxExperiments: undefined });
  assert.deepEqual(visionWorkshopLimitsFromEnv({ RDK_VISION_MAX_EXPERIMENT_BYTES: '536870912', RDK_VISION_MAX_EXPERIMENTS: '20' }), { maxExperimentBytes: 512 * 1024 * 1024, maxExperiments: 20 });
  for (const bad of ['0', '-1', '1.5', 'abc', '1073741825']) assert.throws(() => visionWorkshopLimitsFromEnv({ RDK_VISION_MAX_EXPERIMENT_BYTES: bad }), /RDK_VISION_MAX_EXPERIMENT_BYTES/);
  for (const bad of ['0', '101']) assert.throws(() => visionWorkshopLimitsFromEnv({ RDK_VISION_MAX_EXPERIMENTS: bad }), /RDK_VISION_MAX_EXPERIMENTS/);
  const limits = (options: VisionWorkshopOptions) => new VisionWorkshopService({ dataDir: join(tmpdir(), `d-obs-vision-limits-${randomUUID()}`), ...options }).capabilities().limits;
  const defaults = limits({});
  assert.equal(defaults.maxExperimentBytes, 128 * 1024 * 1024);
  assert.equal(defaults.maxExperiments, 100);
  assert.equal(defaults.maxTotalBytes, 128 * 1024 * 1024 * 100);
  const loopback = limits(visionWorkshopLimitsFromEnv({ RDK_VISION_MAX_EXPERIMENT_BYTES: String(512 * 1024 * 1024), RDK_VISION_MAX_EXPERIMENTS: '20' }));
  assert.equal(loopback.maxExperimentBytes, 512 * 1024 * 1024);
  assert.equal(loopback.maxExperiments, 20);
  assert.equal(loopback.maxTotalBytes, 10 * 1024 * 1024 * 1024);
  // A raised per-experiment limit alone must not raise the host disk budget.
  assert.equal(limits({ maxExperimentBytes: 512 * 1024 * 1024 }).maxTotalBytes, 128 * 1024 * 1024 * 100);
  assert.throws(() => new VisionWorkshopService({ maxExperimentBytes: 1024 * 1024 * 1024 + 1 }), /between 1 and 1073741824/);
});

test('vision recovery removes crash orphans and detects corrupted assets without returning unchecked bytes', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    const orphan = `${randomUUID()}.raw`;
    await writeFile(join(env.dataDir, 'assets', orphan), raw);
    const restarted = new VisionWorkshopService({ dataDir: env.dataDir });
    await restarted.getExperiment('account-a', experiment.id);
    assert.ok(!(await readdir(join(env.dataDir, 'assets'))).includes(orphan));
    await writeFile(join(env.dataDir, 'assets', `${sample.id}.raw`), Buffer.alloc(16));
    await assert.rejects(restarted.readRawSample('account-a', experiment.id, sample.id), errorCode('asset_corrupt'));
    const originalManifest = await readFile(join(env.dataDir, 'manifest.json'));
    await writeFile(join(env.dataDir, 'manifest.json'), '{bad');
    await assert.rejects(restarted.listExperiments('account-a'), errorCode('store_corrupt'));
    assert.equal((await readFile(join(env.dataDir, 'manifest.json'))).toString(), '{bad');
    await writeFile(join(env.dataDir, 'manifest.json'), originalManifest);
  } finally { await env.cleanup(); }
});

test('vision store recovers a dead process lock before preserving its existing manifest', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    await writeFile(join(env.dataDir, 'store.lock'), JSON.stringify({ pid: 2_000_000_000, token: randomUUID() }));
    const restarted = new VisionWorkshopService({ dataDir: env.dataDir });
    assert.equal((await restarted.getExperiment('account-a', experiment.id)).id, experiment.id);
    assert.ok(!(await readdir(env.dataDir)).includes('store.lock'));
    assert.ok(!(await readdir(env.dataDir)).includes('store.lock.recovery'));
  } finally { await env.cleanup(); }
});

test('vision recovery reclaims a complete dead recovery owner and its interrupted cleanup claim', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const lockPath = join(env.dataDir, 'store.lock'); const recoveryPath = lockPath + '.recovery';
    const dead = 2_000_000_000; const recoveryToken = randomUUID();
    await writeFile(lockPath, JSON.stringify({ pid: dead, token: randomUUID() }));
    await writeFile(recoveryPath, JSON.stringify({ pid: dead, token: recoveryToken }));
    // Simulate a second abrupt exit while recovering the first stale claim.
    await writeFile(recoveryPath + '.recover-' + recoveryToken, JSON.stringify({ pid: dead, token: randomUUID() }));
    const restarted = new VisionWorkshopService({ dataDir: env.dataDir });
    assert.equal((await restarted.getExperiment('account-a', experiment.id)).id, experiment.id);
    assert.deepEqual((await readdir(env.dataDir)).filter((name) => name.startsWith('store.lock')), []);
  } finally { await env.cleanup(); }
});

test('vision recovery preserves live main and recovery owners and fails closed on unknown partial claims', async () => {
  const env = await fixture();
  try {
    await env.service.createExperiment('account-a', input);
    const lockPath = join(env.dataDir, 'store.lock'); const recoveryPath = lockPath + '.recovery';
    const recovery = env.service as unknown as { recoverDeadLock(path: string): Promise<boolean> };
    const liveMain = JSON.stringify({ pid: process.pid, token: randomUUID() }); await writeFile(lockPath, liveMain);
    assert.equal(await recovery.recoverDeadLock(lockPath), false); assert.equal(await readFile(lockPath, 'utf8'), liveMain);
    const deadMain = JSON.stringify({ pid: 2_000_000_000, token: randomUUID() }); const liveRecovery = JSON.stringify({ pid: process.pid, token: randomUUID() });
    await writeFile(lockPath, deadMain); await writeFile(recoveryPath, liveRecovery);
    assert.equal(await recovery.recoverDeadLock(lockPath), false); assert.equal(await readFile(lockPath, 'utf8'), deadMain); assert.equal(await readFile(recoveryPath, 'utf8'), liveRecovery);
    await rm(recoveryPath);
    for (const damaged of ['', '{"pid":', JSON.stringify({ pid: process.pid })]) {
      await writeFile(lockPath, damaged);
      await assert.rejects(env.service.listExperiments('account-a'), errorCode('store_lock_corrupt'));
      assert.equal(await readFile(lockPath, 'utf8'), damaged);
    }
  } finally { await env.cleanup(); }
});

test('an interrupted private owner write never publishes an empty or partial store lock', async () => {
  const env = await fixture();
  try {
    const internals = env.service as unknown as { atomicFile(path: string, data: Buffer): Promise<void> };
    const original = internals.atomicFile.bind(env.service);
    let inspected = false;
    internals.atomicFile = async (path, data) => {
      if (path.includes('store.lock.owner.')) {
        assert.deepEqual((await readdir(env.dataDir)).filter((name) => name === 'store.lock'), []);
        await writeFile(path, '{"pid":'); inspected = true;
        throw new Error('fixture owner write interrupted');
      }
      return original(path, data);
    };
    await assert.rejects(env.service.createExperiment('account-a', input), /owner write interrupted/);
    assert.equal(inspected, true);
    assert.deepEqual((await readdir(env.dataDir)).filter((name) => name.startsWith('store.lock')), []);
    internals.atomicFile = original;
    const experiment = await env.service.createExperiment('account-a', input);
    assert.equal((await new VisionWorkshopService({ dataDir: env.dataDir }).getExperiment('account-a', experiment.id)).id, experiment.id);
  } finally { await env.cleanup(); }
});

test('vision server adapter provenance records evidence without marking candidate quality verified', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const baseline = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRunnerRawSample('account-a', experiment.id, { metadata, adapterId: 'configured-x5' }, raw);
    assert.equal(sample.source, 'runner');
    assert.equal(sample.adapterId, 'configured-x5');
    const candidate = await env.service.createCandidate('account-a', experiment.id, { baselineHash: baseline.hash, sampleIds: [sample.id], source: 'manual', patches: [{ path: '/gamma/1', value: 0.7, reason: 'test' }] });
    const image = await env.service.addRunnerProcessedImage('account-a', experiment.id, { sampleId: sample.id, candidateId: candidate.id, mimeType: 'image/png', adapterId: 'configured-x5' }, png());
    assert.equal(image.source, 'runner');
    const run = await env.service.recordDeviceRun('account-a', experiment.id, { operation: 'apply_tuning', status: 'completed', sensorModel: 'IMX415', sdkVersion: 'test-sdk', adapterId: 'configured-x5', candidateId: candidate.id, evidence: { readbackHash: candidate.hash } });
    assert.equal(run.status, 'completed');
    const state = await env.service.getExperiment('account-a', experiment.id);
    assert.equal(state.deviceRuns.length, 1);
    assert.equal(state.candidates[0]?.verification, 'unverified');
    assert.equal((await env.service.exportManifest('account-a', experiment.id)).provenance.boardValidation, 'unavailable');
    await assert.rejects(env.service.recordDeviceRun('account-a', experiment.id, { operation: 'probe', status: 'completed', sensorModel: 'IMX415', adapterId: 'configured-x5', evidence: JSON.parse('{"__proto__":{"x":1}}') }), errorCode('invalid_input'));
    state.samples[0]!.metadata.width = 999;
    state.deviceRuns[0]!.evidence.readbackHash = 'fake';
    assert.equal((await env.service.getExperiment('account-a', experiment.id)).samples[0]?.metadata.width, 4);
    assert.equal((await env.service.getExperiment('account-a', experiment.id)).deviceRuns[0]?.evidence.readbackHash, candidate.hash);
  } finally { await env.cleanup(); }
});

test('vision runner baseline image keeps its actual requested tuning snapshot after a concurrent baseline change', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', input);
    const first = await env.service.setBaseline('account-a', experiment.id, baselineInput);
    const sample = await env.service.addRawSample('account-a', experiment.id, { metadata }, raw);
    const second = await env.service.setBaseline('account-a', experiment.id, { ...baselineInput, tuning: { denoise: { strength: 4 }, gamma: [0, 0.5, 1] } });
    const archived = await env.service.addRunnerProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png', adapterId: 'configured-x5', tuningHash: first.hash }, png());
    assert.equal(archived.tuningHash, first.hash); assert.notEqual(archived.tuningHash, second.hash);
    await assert.rejects(env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png', tuningHash: first.hash } as never, png()), errorCode('invalid_input'));
    await assert.rejects(env.service.addRunnerProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png', adapterId: 'configured-x5', tuningHash: 'fake' }, png()), errorCode('invalid_evidence'));
  } finally { await env.cleanup(); }
});

test('camera context remains unknown unless supplied, and supported formats do not imply universal hardware support', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('account-a', { title: '通用相机实验', goal: '先导入真实样本' });
    for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode']) assert.ok(!Object.hasOwn(experiment, field), `invented ${field}`);
    const capabilities = env.service.capabilities();
    assert.ok(!Object.hasOwn(capabilities, 'board')); assert.ok(!Object.hasOwn(capabilities, 'sensorVendor'));
    assert.deepEqual(capabilities.supportedFormats.raw.packing, ['unpacked16le', 'mipi-raw10', 'mipi-raw12']);
    assert.equal(capabilities.supportedFormats.objectiveComparison.opaqueOnly, true);
    assert.equal(capabilities.supportedFormats.objectiveComparison.format, 'image/png');
    assert.equal(capabilities.capture.status, 'unavailable');
    for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode', 'targetId']) {
      await assert.rejects(env.service.createExperiment('account-a', { ...input, [field]: 'unsafe\nidentity' }), errorCode('invalid_input'));
    }
    await assert.rejects(env.service.createExperiment('account-a', { ...input, cameraSerial: 'not-an-allowed-field' } as never), errorCode('invalid_input'));
  } finally { await env.cleanup(); }
});

test('different vendors, boards, modes and Raw packings reuse the same evidence, candidate, comparison and delivery pipeline', async () => {
  const env = await fixture();
  try {
    const cameras = [
      { board: 'RDK X5', sensorVendor: 'Sony', sensorModel: 'IMX415', sdkVersion: 'x5-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'RAW10 linear', packing: 'mipi-raw10' as const, bitDepth: 10 as const, stride: 5 },
      { board: 'Other Board', sensorVendor: 'OmniVision', sensorModel: 'OV-fixture-12', sdkVersion: 'camera-sdk-2', cameraInterface: 'MIPI CSI-2', cameraMode: 'RAW12 full-frame', packing: 'mipi-raw12' as const, bitDepth: 12 as const, stride: 6 },
    ];
    for (const camera of cameras) {
      const { packing, bitDepth, stride, ...identity } = camera;
      const experiment = await env.service.createExperiment('account-a', { title: camera.sensorModel, goal: '比较真实输出', ...identity });
      assert.equal(experiment.board, camera.board); assert.equal(experiment.sensorVendor, camera.sensorVendor); assert.equal(experiment.cameraMode, camera.cameraMode);
      const info: VisionRawMetadata = { ...metadata, packing, bitDepth, stride, whiteLevel: 2 ** bitDepth - 1 };
      const bytes = Buffer.alloc(stride * info.height);
      for (let y = 0; y < info.height; y++) {
        const values = [100, 200, 300, 400].map((value) => value + y * 400);
        if (packing === 'mipi-raw10') {
          for (let x = 0; x < 4; x++) { bytes[y * stride + x] = values[x]! >>> 2; bytes[y * stride + 4] |= (values[x]! & 3) << (2 * x); }
        } else for (let x = 0; x < 4; x += 2) {
          const offset = y * stride + x / 2 * 3; bytes[offset] = values[x]! >>> 4; bytes[offset + 1] = values[x + 1]! >>> 4; bytes[offset + 2] = (values[x]! & 15) | (values[x + 1]! & 15) << 4;
        }
      }
      const sample = await env.service.addRawSample('account-a', experiment.id, { metadata: info }, bytes);
      assert.equal(analyzeVisionRaw(bytes, info).statistics.sampleCount, 8);
      const base = await env.service.setBaseline('account-a', experiment.id, baselineInput);
      const candidate = await env.service.createCandidate('account-a', experiment.id, { baselineId: base.id, baselineHash: base.hash, sampleIds: [sample.id], source: 'model', model: 'fixture-generic-model', patches: [{ path: '/denoise/strength', value: 3, reason: '受实际基线字段约束的候选' }] });
      const beforeData = png(); const afterData = png(4, 2, undefined, 128);
      const before = await env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, mimeType: 'image/png' }, beforeData);
      const after = await env.service.addProcessedImage('account-a', experiment.id, { sampleId: sample.id, candidateId: candidate.id, mimeType: 'image/png' }, afterData);
      const metrics = compareVisionProcessedPng(beforeData, afterData);
      const comparison = await env.service.recordComparison('account-a', experiment.id, { baselineImageId: before.id, candidateImageId: after.id, metrics: JSON.parse(JSON.stringify(metrics)) });
      assert.equal(comparison.method, 'png-output-comparison'); assert.equal(comparison.baselineTuningHash, candidate.baselineHash);
      await env.service.addEvaluation('account-a', experiment.id, { imageId: after.id, rating: 4, notes: '实际图像需与动态场景共同评估' });
      await env.service.selectCandidate('account-a', experiment.id, candidate.id);
      const manifest = await env.service.exportManifest('account-a', experiment.id); const handbook = await env.service.exportHandbook('account-a', experiment.id);
      assert.equal(manifest.experiment.sensorVendor, camera.sensorVendor); assert.equal(manifest.experiment.comparisons.length, 1); assert.equal(manifest.experiment.samples[0]?.metadata.packing, packing);
      const document = renderVisionHandbook(handbook, manifest); assert.match(document, new RegExp(camera.sensorVendor)); assert.match(document, new RegExp(camera.sensorModel)); assert.match(document, new RegExp(camera.cameraMode));
      const archive = createVisionArchive([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'handbook.md', data: Buffer.from(document) }, { name: 'candidate_tuning.json', data: Buffer.from(JSON.stringify(manifest.selectedTuning)) }, { name: 'raw/' + sample.id + '.raw', data: bytes }]);
      assert.equal(archive.readUInt32LE(0), 0x04034b50);
      const restarted = new VisionWorkshopService({ dataDir: env.dataDir }); assert.equal((await restarted.getExperiment('account-a', experiment.id)).cameraMode, camera.cameraMode);
    }
  } finally { await env.cleanup(); }
});

test('legacy camera identities survive recovery without being rewritten or assigned to unlabelled records', async () => {
  const env = await fixture();
  try {
    const labelled = await env.service.createExperiment('account-a', { ...input, board: 'RDK X5', sensorVendor: 'Sony', sensorModel: 'IMX415' });
    const unknown = await env.service.createExperiment('account-a', { title: '未知相机', goal: '补齐资料后再执行' });
    const path = join(env.dataDir, 'manifest.json'); const store = JSON.parse(await readFile(path, 'utf8'));
    for (const row of store.experiments) { delete row.experiment.comparisons; delete row.experiment.deviceRuns; delete row.experiment.cameraMode; delete row.experiment.cameraInterface; }
    await writeFile(path, JSON.stringify(store));
    const recovered = new VisionWorkshopService({ dataDir: env.dataDir });
    const previous = await recovered.getExperiment('account-a', labelled.id); assert.equal(previous.board, 'RDK X5'); assert.equal(previous.sensorVendor, 'Sony'); assert.equal(previous.sensorModel, 'IMX415'); assert.deepEqual(previous.deviceRuns, []); assert.deepEqual(previous.comparisons, []);
    const empty = await recovered.getExperiment('account-a', unknown.id); assert.ok(!Object.hasOwn(empty, 'board')); assert.ok(!Object.hasOwn(empty, 'sensorModel'));
    const run = await recovered.recordDeviceRun('account-a', labelled.id, { operation: 'probe', adapterId: 'legacy-adapter', board: 'RDK X5', sensorVendor: 'Sony', sensorModel: 'IMX415', cameraInterface: 'MIPI CSI-2', cameraMode: 'RAW10 linear', sdkVersion: 'old-sdk', status: 'completed', evidence: { facts: { identified: true } } });
    assert.equal(run.board, 'RDK X5'); assert.equal(run.cameraMode, 'RAW10 linear');
    await recovered.setBaseline('account-a', labelled.id, baselineInput);
    const afterRestart = await new VisionWorkshopService({ dataDir: env.dataDir }).getExperiment('account-a', labelled.id); assert.equal(afterRestart.board, 'RDK X5'); assert.equal(afterRestart.sensorModel, 'IMX415');
  } finally { await env.cleanup(); }
});

test('camera frames remain processed evidence across recovery and support evaluated frame-based candidates', async () => {
  const env = await fixture();
  try {
    const experiment = await env.service.createExperiment('camera-a', { ...input, board: 'Fixture S100', cameraInterface: 'USB UVC', sensorModel: 'Fixture UVC' });
    const baseline = await env.service.setBaseline('camera-a', experiment.id, { tuning: { kind: 'uvc-controls-v1', controls: { gamma: 100 } }, rules: [{ path: '/controls/gamma', label: 'gamma', min: 72, max: 500 }] });
    const frame = await env.service.addCameraFrame('camera-a', experiment.id, { adapterId: 'uvc-fixture', mimeType: 'image/png', scene: '逆光', tuningHash: baseline.hash, controls: { gamma: { value: 100, min: 72, max: 500, writable: true } } }, png());
    assert.equal((await env.service.getExperiment('camera-a', experiment.id)).samples.length, 0);
    await assert.rejects(env.service.readCameraFrame('camera-b', experiment.id, frame.id), errorCode('not_found'));
    const candidate = await env.service.createCandidate('camera-a', experiment.id, { baselineHash: baseline.hash, sampleIds: [], frameIds: [frame.id], source: 'model', model: 'explicit-fixture-model', modelInput: 'processed_frame_statistics_and_baseline', patches: [{ path: '/controls/gamma', value: 120, reason: '待实际采图验证' }] });
    assert.deepEqual(candidate.sampleIds, []); assert.deepEqual(candidate.frameHashes, [frame.hash]);
    await assert.rejects(env.service.addCameraFrame('camera-a', experiment.id, { adapterId: 'uvc-fixture', mimeType: 'image/png', candidateId: candidate.id, tuningHash: baseline.hash }, png()), errorCode('vision_device_readback_mismatch'));
    const after = await env.service.addCameraFrame('camera-a', experiment.id, { adapterId: 'uvc-fixture', mimeType: 'image/png', candidateId: candidate.id, tuningHash: candidate.hash }, png(4, 2, undefined, 100));
    await env.service.addEvaluation('camera-a', experiment.id, { imageId: after.id, rating: 4, notes: '实际帧人工观察；不是同Raw的校准比较' });
    await env.service.selectCandidate('camera-a', experiment.id, candidate.id);
    const restarted = new VisionWorkshopService({ dataDir: env.dataDir });
    assert.deepEqual((await restarted.readCameraFrame('camera-a', experiment.id, frame.id)).data, png());
    assert.equal((await restarted.getExperiment('camera-a', experiment.id)).cameraFrames.length, 2);
    assert.equal((await restarted.exportHandbook('camera-a', experiment.id)).cameraFrames.length, 2);
  } finally { await env.cleanup(); }
});
