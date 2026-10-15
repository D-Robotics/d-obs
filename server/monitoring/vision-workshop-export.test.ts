import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionArchive, visionCrc32, renderVisionHandbook, buildVisionAiDebugExport, buildVisionWorkshopDeliveryExport, VISION_WORKSHOP2_AGENDA } from './vision-workshop-export.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import type { VisionAiDebugRun } from './vision-workshop-ai-debug.js';
import { analyzeVisionProcessedPng } from './vision-workshop-quality.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

function acceptanceFixturePng(): Buffer {
  const chunk = (name: string, content: Buffer) => { const payload = Buffer.concat([Buffer.from(name), content]); const size = Buffer.alloc(4); size.writeUInt32BE(content.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(payload)); return Buffer.concat([size, payload, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 96, 160]))), chunk('IEND', Buffer.alloc(0))]);
}

test('ZIP preserves original tuning and Raw bytes with valid CRC and directory offsets', () => {
  const raw = Buffer.from([0, 255, 1, 0, 10, 13, 128, 17]);
  const files = [{ name: 'candidate_tuning.json', data: Buffer.from('{"strength":2}') }, { name: 'raw/sample.raw', data: raw }, { name: 'handbook.md', data: Buffer.from('调优记录\n') }];
  const zip = createVisionArchive(files); let position = 0;
  for (const file of files) {
    assert.equal(zip.readUInt32LE(position), 0x04034b50);
    const nameSize = zip.readUInt16LE(position + 26); const size = zip.readUInt32LE(position + 18);
    assert.equal(zip.subarray(position + 30, position + 30 + nameSize).toString(), file.name);
    const bytes = zip.subarray(position + 30 + nameSize, position + 30 + nameSize + size);
    assert.deepEqual(bytes, file.data); assert.equal(zip.readUInt32LE(position + 14), visionCrc32(bytes));
    position += 30 + nameSize + size;
  }
  assert.equal(zip.readUInt32LE(position), 0x02014b50);
  const end = zip.length - 22; assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), files.length); assert.equal(zip.readUInt32LE(end + 16), position);
  assert.equal(visionCrc32(Buffer.from('123456789')), 0xcbf43926);
});
test('ZIP refuses duplicate, traversal and absolute entries', () => {
  for (const name of ['../x', '/x', 'foo/../../x', 'foo//x', 'foo\\bar', '']) assert.throws(() => createVisionArchive([{ name, data: Buffer.alloc(0) }]), /invalid_name/);
  assert.throws(() => createVisionArchive([{ name: 'x', data: Buffer.alloc(0) }, { name: 'x', data: Buffer.alloc(0) }]), /invalid_name/);
});
test('ZIP admits the full 517-artifact experiment graph including delivery/vendor files and refuses more than 640 entries', () => {
  const files = ['manifest.json', 'handbook.md', 'delivery.json', 'ai-debug/runs.json', 'calibration/tasks.json'].map(name => ({ name, data: Buffer.from('{}') }));
  for (const [prefix, count] of [['frames', 128], ['processed', 128], ['raw', 64], ['ai-debug/reports', 48], ['calibration/results', 128], ['vendor-tuning', 16]] as const) {
    for (let index = 0; index < count; index++) files.push({ name: prefix + '/' + index + '.json', data: Buffer.from('{}') });
  }
  assert.equal(files.length, 517);
  const archive = createVisionArchive(files); assert.equal(archive.readUInt16LE(archive.length - 12), 517);
  for (let index = 0; index < 124; index++) files.push({ name: 'additional/' + index + '.json', data: Buffer.from('{}') });
  assert.equal(files.length, 641); assert.throws(() => createVisionArchive(files), /vision_archive_entry_limit/);
});
test('handbook shows unknown camera fields as unrecorded and never fills a demonstration vendor or board', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-generic-'));
  try {
    const service = new VisionWorkshopService({ dataDir });
    const experiment = await service.createExperiment('owner', { title: '相机实验', goal: '建立可复用调优记录' });
    const manifest = await service.exportManifest('owner', experiment.id); const handbook = await service.exportHandbook('owner', experiment.id);
    const document = renderVisionHandbook(handbook, manifest);
    assert.match(document, /平台：待记录；相机厂商：待记录；型号：待记录；SDK：待记录/);
    assert.match(document, /相机接口：待记录；工作模式：待记录/);
    assert.doesNotMatch(document, /Sony|IMX415|RDK X5|undefined|null/);
    const supplied = await service.createExperiment('owner', { title: '其他相机', goal: '沿用同一导出流程', board: 'Other Board', sensorVendor: 'Other Vendor', sensorModel: 'Other Sensor', sdkVersion: 'vendor-sdk', cameraInterface: 'USB', cameraMode: 'RAW12 static' });
    const other = renderVisionHandbook(await service.exportHandbook('owner', supplied.id), await service.exportManifest('owner', supplied.id));
    assert.match(other, /平台：Other Board；相机厂商：Other Vendor；型号：Other Sensor；SDK：vendor-sdk/);
    assert.match(other, /相机接口：USB；工作模式：RAW12 static/);
    assert.doesNotMatch(other, /Sony|IMX415|RDK X5/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('UVC handbook preserves real frame hashes, control readback, failed recovery and manual iteration without RAW claims', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-uvc-'));
  try {
    const service = new VisionWorkshopService({ dataDir });
    const experiment = await service.createExperiment('owner', { title: 'UVC 测试证据', goal: '保存实际画面观察', board: 'Fixture board', sensorModel: 'Fixture UVC', sdkVersion: 'Fixture V4L2', cameraInterface: 'USB UVC' });
    const baseline = await service.setBaseline('owner', experiment.id, { tuning: { kind: 'uvc-controls-v1', controls: { gamma: 100 } }, rules: [{ path: '/controls/gamma', label: 'Gamma', min: 72, max: 500, step: 1 }] });
    const chunk = (name: string, content: Buffer) => { const payload = Buffer.concat([Buffer.from(name), content]); const size = Buffer.alloc(4); size.writeUInt32BE(content.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(payload)); return Buffer.concat([size, payload, crc]); };
    const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 0;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 64, 128]))), chunk('IEND', Buffer.alloc(0))]);
    const frame = await service.addCameraFrame('owner', experiment.id, { adapterId: 'fixture-uvc', mimeType: 'image/png', scene: '固定测试场景', tuningHash: baseline.hash, controls: { gamma: { value: 100, min: 72, max: 500, step: 1, writable: true } } }, png);
    await service.addEvaluation('owner', experiment.id, { imageId: frame.id, rating: 3, notes: '暗部仍需下一轮人工检查' });
    await service.recordDeviceRun('owner', experiment.id, { operation: 'restore_tuning', adapterId: 'fixture-uvc', sensorModel: 'Fixture UVC', status: 'failed', evidence: { outcome: 'unconfirmed', code: 'fixture_readback_failure' } });
    const manifest = await service.exportManifest('owner', experiment.id);
    const text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), manifest);
    assert.match(text, /属于处理后的视频画面，不能替代 Bayer RAW/);
    assert.ok(text.includes(frame.hash)); assert.ok(text.includes(baseline.hash));
    assert.match(text, /采集时参数回读/); assert.match(text, /"gamma"/);
    assert.match(text, /暗部仍需下一轮人工检查/); assert.match(text, /restore_tuning \| failed/);
    assert.match(text, /UVC 控制配置只适用于对应相机的驱动控制接口/);
    assert.doesNotMatch(text, /相机已验证|画质验收通过|自动达到所需画质/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

function nativeExportFixture(): VisionAiDebugRun {
  const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const png = (pixels: number[]) => { const chunk = (name: string, bytes: Buffer) => { const payload = Buffer.concat([Buffer.from(name), bytes]); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(payload)); return Buffer.concat([length, payload, crc]); }; const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, ...pixels]))), chunk('IEND', Buffer.alloc(0))]); };
  const originalTuning = { kind: 'uvc-controls-v1', controls: { autoExposure: true, exposureUs: 15000, gain: 1 } };
  const bestTuning = { kind: 'uvc-controls-v1', controls: { autoExposure: false, exposureUs: 1500, gain: 1 } };
  const originalControls = { exposureUs: { value: 15000, min: 100, max: 20000, step: 100, writable: true, active: false }, autoExposure: { value: true, writable: true }, gain: { value: 1, min: 1, max: 8, writable: true } };
  const bestControls = { ...originalControls, exposureUs: { ...originalControls.exposureUs, value: 1500, active: true }, autoExposure: { value: false, writable: true } };
  const beforeBytes = png([128, 255]); const afterBytes = png([100, 240]);
  const before = { frameId: randomUUID(), frameHash: sha256(beforeBytes), controls: originalControls, statistics: analyzeVisionProcessedPng(beforeBytes), tuningHash: sha256(JSON.stringify(originalTuning)) };
  const after = { frameId: randomUUID(), frameHash: sha256(afterBytes), controls: bestControls, statistics: analyzeVisionProcessedPng(afterBytes), tuningHash: sha256(JSON.stringify(bestTuning)) };
  const assessment = { improved: true, sceneUsable: true, goalSatisfied: false, issue: 'exposure' as const, reason: '文字仍可见，但反光无法仅用曝光完全修复' };
  return { id: randomUUID(), source: 'model', tool: 'camera_debug_decision', status: 'completed', goal: '减轻过曝，保留文字', maxRounds: 4, adjustmentCount: 1,
    original: { controls: originalControls, tuning: originalTuning, hash: before.tuningHash, frameId: before.frameId, frameHash: before.frameHash },
    best: { controls: bestControls, tuning: bestTuning, hash: after.tuningHash, frameId: after.frameId, frameHash: after.frameHash, iteration: 2, reason: assessment.reason, assessment },
    final: { controls: bestControls, hash: after.tuningHash, restored: false, reason: 'model_selected_best_retained', frameId: after.frameId, frameHash: after.frameHash, visualVerification: 'unverified' },
    iterations: [{ index: 1, source: 'model', model: 'explicit-vision-fixture', tool: 'camera_debug_decision', modelInput: 'camera_images_controls_and_history', action: 'adjust', notes: '温和降低曝光后重新采集', assessment: { ...assessment, improved: false }, before, requestedValues: { autoExposure: false, exposureUs: 1500 }, readback: bestControls, after, createdAt: '2026-10-13T12:00:01Z' },
      { index: 2, source: 'model', model: 'explicit-vision-fixture', tool: 'camera_debug_decision', modelInput: 'camera_images_controls_and_history', action: 'keep', notes: '保留可用细节，说明剩余反光限制', assessment, before: after, createdAt: '2026-10-13T12:00:02Z' }],
    operations: [{ operationId: 'POST /api/ops/observability/vision-workshop/experiments/:id/device/restore_tuning', status: 'completed', receipt: { appliedHash: after.tuningHash, readbackHash: after.tuningHash }, createdAt: '2026-10-13T12:00:03Z' }],
    cancelRequested: false, goalSatisfied: false, stopReason: 'model_completed', createdAt: '2026-10-13T12:00:00Z', updatedAt: '2026-10-13T12:00:03Z', completedAt: '2026-10-13T12:00:03Z' };
}

test('native AI export preserves exact original/best tuning hashes and actual image/model/readback provenance without manual candidates', () => {
  const run = nativeExportFixture();
  const entries = buildVisionAiDebugExport({ aiDebugRuns: [run] });
  assert.deepEqual(entries.map(entry => entry.name), ['ai-debug/' + run.id + '/original_tuning.json', 'ai-debug/' + run.id + '/best_tuning.json', 'ai-debug/' + run.id + '/report.json']);
  for (const [entry, snapshot] of [[entries[0], run.original!], [entries[1], run.best!]] as const) { assert.deepEqual(JSON.parse(entry.data.toString()), snapshot.tuning); assert.equal(createHash('sha256').update(entry.data).digest('hex'), snapshot.hash); }
  const report = JSON.parse(entries[2].data.toString());
  assert.equal(report.source, 'model'); assert.equal(report.tool, 'camera_debug_decision'); assert.equal(report.modelInput, 'camera_images_controls_and_history');
  assert.equal(report.goalSatisfied, false); assert.equal(report.visualVerification, 'unverified');
  assert.equal(report.actualAdjustments, 1); assert.equal(report.visualDecisions, 2);
  assert.equal(report.iterations[0].before.frameHash, run.original!.frameHash); assert.equal(report.iterations[0].after.frameHash, run.best!.frameHash);
  assert.equal(report.iterations[0].readback.exposureUs.value, 1500); assert.equal(report.iterations[0].requestedValues.autoExposure, false);
  assert.equal(report.final.restored, false); assert.equal(report.final.tuningHash, run.best!.hash);
  assert.equal(report.humanEvaluation, 'not_recorded_by_ai_debug'); assert.doesNotMatch(entries[2].data.toString(), /"rating"|"candidateId"/);
  assert.ok(createVisionArchive(entries).length > 0);
});

test('native report excludes adapter/model private extras and full SDK receipts while preserving recovery proof', () => {
  const run = nativeExportFixture();
  (run as any).apiKey = 'PRIVATE_MODEL_KEY'; (run as any).adapterUrl = 'https://private-adapter.invalid';
  run.operations[0].receipt = { ...run.operations[0].receipt, token: 'PRIVATE_ADAPTER_TOKEN', contentBase64: 'PRIVATE_FRAME_PAYLOAD', authorization: 'PRIVATE_AUTH', url: 'https://private-runner.invalid' };
  const entries = buildVisionAiDebugExport({ aiDebugRuns: [run] }); const text = entries[2].data.toString();
  assert.doesNotMatch(text, /PRIVATE_|private-adapter|private-runner|contentBase64|authorization/);
  const report = JSON.parse(text); assert.equal(report.operations[0].readbackHash, run.best!.hash); assert.equal(report.operations[0].appliedHash, run.best!.hash);
  assert.throws(() => buildVisionAiDebugExport({ aiDebugRuns: [{ ...run, id: '../escape' }] }), /invalid_run/);
  assert.throws(() => buildVisionAiDebugExport({ aiDebugRuns: [run, run] }), /invalid_run/);
});

test('native handbook remains truthful without manual selection and separates unconfirmed restoration/image errors from visual judgment', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-ai-native-'));
  try {
    const service = new VisionWorkshopService({ dataDir }); const experiment = await service.createExperiment('owner', { title: '自主看图调试', goal: '改善反光，保留可辨认内容' });
    const run = nativeExportFixture(); await service.saveAiDebugRun('owner', experiment.id, run);
    const text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), await service.exportManifest('owner', experiment.id));
    assert.match(text, /AI 自主看图调试/); assert.match(text, /source:model/); assert.match(text, /实际调整 1 次.*模型判断 2 次/);
    assert.match(text, /目标尚未达到，不作为画质验收通过/); assert.ok(text.includes('ai-debug/' + run.id + '/best_tuning.json'));
    assert.ok(text.includes(run.original!.frameHash!)); assert.ok(text.includes(run.best!.frameHash!)); assert.ok(text.includes(run.final!.hash!));
    assert.doesNotMatch(text, /交付包中没有最终 tuning 文件|画质已通过|人工评价：|[1-5]\/5/);
    const failed = { ...run, id: randomUUID(), status: 'failed' as const, stopReason: 'restoration_unconfirmed', restorationError: 'vision_device_readback_mismatch', final: undefined };
    await service.saveAiDebugRun('owner', experiment.id, failed);
    const failureReport = JSON.parse(buildVisionAiDebugExport({ aiDebugRuns: [failed] }).at(-1)!.data.toString());
    assert.equal(failureReport.restorationError, 'vision_device_readback_mismatch'); assert.equal(failureReport.final, undefined);
    const failedText = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), await service.exportManifest('owner', experiment.id));
    assert.match(failedText, /最终设备回读尚未确认/);
    const restored = { ...run, id: randomUUID(), status: 'canceled' as const, final: { ...run.final!, restored: true, hash: run.original!.hash, frameId: undefined, frameHash: undefined, imageError: 'vision_camera_frame_failed' } };
    const restoredReport = JSON.parse(buildVisionAiDebugExport({ aiDebugRuns: [restored] }).at(-1)!.data.toString());
    assert.equal(restoredReport.final.restored, true); assert.equal(restoredReport.final.imageError, 'vision_camera_frame_failed'); assert.equal(restoredReport.final.frameId, undefined); assert.equal(restoredReport.final.visualVerification, 'unverified');
    restored.iterations = restored.iterations.map(iteration => ({ ...iteration, assessment: { ...iteration.assessment, improved: false, regressions: ['noise', 'detail'] } }));
    await service.saveAiDebugRun('owner', experiment.id, restored);
    const recoveryText = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), await service.exportManifest('owner', experiment.id));
    assert.match(recoveryText, /AI 曾推荐的历史参数（当前设备已恢复原始参数）/);
    assert.match(recoveryText, /AI 观察到的画质回退/); assert.match(recoveryText, /噪点\/颗粒、文字\/边缘细节/);
    const regressionReport = JSON.parse(buildVisionAiDebugExport({ aiDebugRuns: [restored] }).at(-1)!.data.toString());
    assert.deepEqual(regressionReport.iterations[0].assessment.regressions, ['noise', 'detail']);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('Workshop 2 guide has a bounded 225-minute agenda while an empty experiment remains incomplete', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-workshop2-empty-'));
  try {
    const service = new VisionWorkshopService({ dataDir });
    const experiment = await service.createExperiment('owner', { title: '课前设备待确认', goal: '建立现场计划' });
    const before = JSON.stringify(experiment), entries = buildVisionWorkshopDeliveryExport(experiment);
    assert.equal(JSON.stringify(experiment), before); assert.deepEqual(entries.map(entry => entry.name), ['delivery.json']);
    const delivery = JSON.parse(entries[0].data.toString());
    assert.equal(delivery.quality.status, 'not_configured'); assert.equal(delivery.tuning.status, 'missing');
    assert.equal(delivery.workshopReady, false); assert.equal(delivery.hardwareVerification, 'unverified');
    for (const blocker of ['device_adapter_required', 'acceptance_plan_required', 'delivery_target_required', 'bringup_evidence_required']) assert.ok(delivery.blockers.includes(blocker));
    assert.equal(VISION_WORKSHOP2_AGENDA.reduce((sum, phase) => sum + phase.minutes, 0), 225);
    assert.ok(VISION_WORKSHOP2_AGENDA.every(phase => phase.minutes > 0));
    const text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), await service.exportManifest('owner', experiment.id));
    let start = 0;
    for (const phase of VISION_WORKSHOP2_AGENDA) { assert.ok(text.includes('| ' + start + '–' + (start + phase.minutes) + ' 分钟 | ' + phase.title)); start += phase.minutes; }
    assert.match(text, /设备未预验收.*不承诺准时完成/); assert.match(text, /未绑定；仅可进行资料与文件实验/);
    assert.match(text, /未建立验收计划（not_configured）/); assert.match(text, /尚未满足当前交付规则/);
    assert.match(text, /- \[ \] 最终参数已经实际加载并独立回读/); assert.doesNotMatch(text, /- \[[xX]\]/);
    const raw = Buffer.from([0, 255, 13, 10, 64, 128]), tuning = Buffer.from('{\n "kind": "fixture", "value": 1.00\n}\n');
    const files = [{ name: 'raw/fixture.raw', data: raw }, { name: 'candidate_tuning.json', data: tuning }, ...entries];
    const zip = createVisionArchive(files); let offset = 0;
    for (const file of files) {
      const nameSize = zip.readUInt16LE(offset + 26), size = zip.readUInt32LE(offset + 18), actual = zip.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size);
      assert.equal(zip.subarray(offset + 30, offset + 30 + nameSize).toString(), file.name);
      assert.deepEqual(actual, file.data); assert.equal(zip.readUInt32LE(offset + 14), visionCrc32(file.data)); offset += 30 + nameSize + size;
    }
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('customer handbook binds actual acceptance measurements and image/config hashes without promoting operator records to quality certification', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-workshop2-records-'));
  try {
    const service = new VisionWorkshopService({ dataDir });
    const experiment = await service.createExperiment('owner', { title: '合成软件验收流程', goal: '验证记录导出，不验证真实相机', board: 'Fixture board', sdkVersion: 'fixture-sdk', cameraMode: 'fixture-mode' });
    const run = nativeExportFixture(); await service.saveAiDebugRun('owner', experiment.id, run);
    const frame = await service.addCameraFrame('owner', experiment.id, { adapterId: 'synthetic-fixture', mimeType: 'image/png', scene: '固定灰卡软件场景', tuningHash: run.best!.hash }, acceptanceFixturePng());
    const criteria = [
      { id: 'readability', label: '固定目标可辨认', kind: 'visual', required: true },
      { id: 'delta', label: '软件示例差值', kind: 'measurement', required: true, operator: 'lte', maximum: 2, unit: 'fixture-code', method: '合成报告输入，不代表校准测量' },
    ];
    const plan = await service.setAcceptancePlan('owner', experiment.id, { scene: '固定灰卡软件场景', lighting: '合成素材；无实际照明设备', criteria });
    const observations = [{ criterionId: 'readability', verdict: 'pass', notes: '软件示例像素可辨认；未连接硬件' }, { criterionId: 'delta', value: 1.25, notes: '测试输入值' }];
    const record = await service.recordAcceptance('owner', experiment.id, { planId: plan.id, candidateId: 'ai-run:' + run.id, imageIds: [frame.id], observations, report: 'synthetic fixture report: delta=1.25 fixture-code' });
    let manifest = await service.exportManifest('owner', experiment.id), delivery = JSON.parse(buildVisionWorkshopDeliveryExport(manifest.experiment)[0].data.toString());
    assert.equal(delivery.quality.status, 'recorded_pass'); assert.equal(delivery.quality.recordId, record.id);
    assert.equal(delivery.quality.requiredCriteriaMet, true); assert.equal(delivery.quality.independentVerification, 'unverified'); assert.equal(delivery.workshopReady, false);
    assert.equal(delivery.acceptanceRecords[0].measurementAuthenticity, 'unverified'); assert.equal(delivery.acceptanceRecords[0].evidenceImages[0].hash, frame.hash);
    assert.equal(delivery.acceptanceRecords[0].tuningHash, run.best!.hash); assert.equal(delivery.acceptanceRecords[0].reportSha256, createHash('sha256').update('synthetic fixture report: delta=1.25 fixture-code').digest('hex'));
    let text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), manifest);
    for (const actual of [record.id, record.hash, plan.id, frame.id, frame.hash, run.best!.hash, '≤ 2 fixture-code', '| delta | 记录满足 | 1.25 | 测试输入值 |']) assert.ok(text.includes(actual), actual);
    assert.match(text, /recorded_pass/); assert.match(text, /操作者记录满足约定项；仍需核验真实性与独立证据/);
    assert.match(text, /测量真实性：unverified/); assert.match(text, /硬件 \/ 画质验证状态 \| unverified \/ unverified/);
    assert.doesNotMatch(text, /画质已达标|独立画质验证 \| verified|Workshop 就绪投影 \| 满足当前交付规则/);

    const stricterPlan = await service.setAcceptancePlan('owner', experiment.id, { scene: plan.scene, lighting: plan.lighting, criteria: [criteria[0], { ...criteria[1], maximum: 1 }] });
    manifest = await service.exportManifest('owner', experiment.id); delivery = JSON.parse(buildVisionWorkshopDeliveryExport(manifest.experiment)[0].data.toString());
    assert.equal(delivery.quality.status, 'pending'); assert.equal(delivery.quality.recordId, null); assert.equal(delivery.acceptanceRecords[0].id, record.id);
    text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), manifest);
    assert.ok(text.includes(stricterPlan.id)); assert.match(text, /等待当前计划与配置的验收记录（pending）/); assert.doesNotMatch(text, /记录 ID：/);
    const failed = await service.recordAcceptance('owner', experiment.id, { planId: stricterPlan.id, candidateId: 'ai-run:' + run.id, imageIds: [frame.id], observations, report: 'same fixture measurement under stricter plan' });
    manifest = await service.exportManifest('owner', experiment.id); delivery = JSON.parse(buildVisionWorkshopDeliveryExport(manifest.experiment)[0].data.toString());
    assert.equal(delivery.quality.status, 'recorded_fail'); assert.equal(delivery.quality.recordId, failed.id); assert.deepEqual(delivery.quality.failedCriteria, ['delta']);
    // A stale cached outcome must not override the plan and actual observation.
    manifest.experiment.acceptanceRecords!.at(-1)!.outcomes = [{ criterionId: 'delta', met: true, value: 1.25 }, { criterionId: 'readability', met: true, verdict: 'pass' }];
    text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), manifest);
    assert.match(text, /\| delta \| 记录未满足 \| 1.25/); assert.match(text, /≤ 1 fixture-code/); assert.match(text, /acceptance_criteria_failed/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('native snapshot configuration remains session-bound and is never described as a directly loadable vendor library', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-workshop2-native-'));
  try {
    const service = new VisionWorkshopService({ dataDir }); const experiment = await service.createExperiment('owner', { title: '原生配置格式边界', goal: '保留真实部署限制' });
    const run = nativeExportFixture();
    run.best!.tuning = { kind: 'x5-hbn-isp-v2', snapshotId: 'fixture-private-snapshot', layout: 'fixture-layout', modules: { exposure: 1000 } };
    run.best!.hash = createHash('sha256').update(JSON.stringify(run.best!.tuning)).digest('hex');
    await service.saveAiDebugRun('owner', experiment.id, run);
    const manifest = await service.exportManifest('owner', experiment.id), delivery = JSON.parse(buildVisionWorkshopDeliveryExport(manifest.experiment)[0].data.toString());
    assert.equal(delivery.tuning.status, 'session_bound_configuration'); assert.equal(delivery.tuning.independentDeployment, 'unverified'); assert.equal(delivery.tuning.hash, run.best!.hash);
    const text = renderVisionHandbook(await service.exportHandbook('owner', experiment.id), manifest);
    assert.match(text, /依赖适配器快照的会话配置（x5-hbn-isp-v2）/);
    assert.match(text, /含 snapshotId 的配置不是可直接送入厂商库加载器的文件/);
    assert.match(text, /vendor_effect_library_candidate/); assert.match(text, /blocked 没有候选字节/); assert.match(text, /freshSessionObserved/);
    assert.doesNotMatch(text, /在匹配的 SDK 中加载 candidate_tuning.json/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('vendor handoff guide renders a completed saved evidence chain and downgrades same-session reload without claiming independent quality', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vision-export-vendor-guide-'));
  try {
    const service = new VisionWorkshopService({ dataDir });
    const identity = { board: 'Fixture board', sensorModel: 'Fixture sensor', sdkVersion: 'fixture-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'fixture-mode' };
    const experiment = await service.createExperiment('owner', { ...identity, title: '合成回执渲染测试', goal: '只验证文档状态投影', targetId: 'fixture-adapter' });
    const manifest = await service.exportManifest('owner', experiment.id), handbook = await service.exportHandbook('owner', experiment.id), saved = manifest.experiment;
    const h = (number: number) => String(number).repeat(64), at = (number: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, number)).toISOString();
    const frameId = randomUUID(), planId = randomUUID(), artifactId = randomUUID();
    const stream = { status: 'verified', source: 'x5-hbn-sdk', frameId: '42', sdkTimestampNs: '42000000000' };
    const receipt = { status: 'target_reload_recorded', candidateSha256: h(1), bindingHash: h(2), sourceReadbackHash: h(3), actualReloadReadbackHash: h(7), actualReloadModulesSha256: h(4),
      source: 'x5-hbn-sdk', streamVerification: stream, exportSessionId: 'a'.repeat(32), reloadSessionId: 'b'.repeat(32), sessionBoundary: 'native_sdk_pipeline_open', freshSessionObserved: true,
      modeQualifications: { exposure: 'private_evidence_configured', awb: 'private_evidence_configured' }, validationScope: 'public_sdk_modules_normalized_selected_mode_configuration' };
    const run = (operation: typeof saved.deviceRuns[number]['operation'], second: number, result: Record<string, unknown>) => ({ ...identity, id: randomUUID(), adapterId: 'fixture-adapter', operation, status: 'completed' as const, evidence: { result: result as import('./vision-workshop-service.js').VisionJsonObject }, createdAt: at(second) });
    saved.deliveryTargetId = 'vendor:' + h(1);
    saved.baselineHistory = [{ id: randomUUID(), hash: h(0), tuning: { kind: 'x5-hbn-isp-v2', snapshotId: 'private-fixture-snapshot' }, rules: [], createdAt: at(0) }];
    saved.deviceRuns = [run('bringup', 1, { passed: true }), run('tuning_get', 2, { readbackHash: h(0) }), run('tuning_export', 3, { vendorCandidate: {
      status: 'generated_requires_target_validation', artifactRole: 'vendor_effect_library_candidate', sha256: h(1), bindingHash: h(2), sourceReadbackHash: h(3), sourceModulesSha256: h(4), templateSha256: h(5), baselineModulesSha256: h(6), coverageScope: 'all_modified_normalized_sdk_readable_configuration_fields',
    } }), run('tuning_load', 4, { appliedHash: h(7), readbackHash: h(7), evidence: { vendorCandidateValidation: receipt } }), run('restore_tuning', 8, { appliedHash: h(0), readbackHash: h(0), evidence: { streamVerification: stream } })];
    saved.cameraFrames = [{ ...identity, id: frameId, filename: 'fixture.png', mimeType: 'image/png', hash: h(8), byteLength: 16, width: 2, height: 1, source: 'runner', adapterId: 'fixture-adapter', tuningHash: h(7), scene: 'fixture-scene', verification: 'unverified', createdAt: at(6) }];
    saved.acceptancePlan = { id: planId, scene: 'fixture-scene', lighting: '合成测试照明说明', createdAt: at(0), criteria: [{ id: 'detail', label: '合成观察项', kind: 'visual', required: true }] };
    saved.acceptanceRecords = [{ id: randomUUID(), planId, candidateId: saved.deliveryTargetId, imageIds: [frameId], createdAt: at(7), tuningHash: h(7), observations: [{ criterionId: 'detail', verdict: 'pass', notes: '仅测试投影，无实机验收' }],
      evidenceImages: [{ id: frameId, hash: h(8), tuningHash: h(7), source: 'runner', scene: 'fixture-scene', createdAt: at(6) }], recordedBy: h(9), source: 'operator_recorded', measurementAuthenticity: 'unverified', hash: h(9), outcomes: [{ criterionId: 'detail', met: true, verdict: 'pass' }] }];
    saved.vendorArtifacts = [{ id: artifactId, filename: 'fixture-vendor.json', hash: h(1), byteLength: 16, bindingHash: h(2), sourceReadbackHash: h(3), artifactRole: 'vendor_effect_library_candidate', createdAt: at(3) }];
    let delivery = JSON.parse(buildVisionWorkshopDeliveryExport(saved)[0].data.toString()); assert.equal(delivery.workshopReady, true);
    let text = renderVisionHandbook(handbook, manifest);
    for (const expected of ['满足当前交付规则；仍限所列范围', 'fresh_session_reload_recorded', 'original_restoration_recorded', saved.deviceRuns[2].id, saved.deviceRuns[3].id, saved.deviceRuns[4].id, 'vendor-tuning/' + artifactId + '.json', h(1), h(7)]) assert.ok(text.includes(expected), expected);
    assert.match(text, /本次选定厂商效果库交付目标：vendor:/); assert.doesNotMatch(text, /尚未选定候选|交付包中没有最终 tuning 文件/);
    assert.match(text, /硬件 \/ 画质验证状态 \| unverified \/ unverified/); assert.match(text, /文件哈希标识原字节；装载后的配置哈希标识独立 SDK 回读/);
    receipt.reloadSessionId = receipt.exportSessionId;
    delivery = JSON.parse(buildVisionWorkshopDeliveryExport(saved)[0].data.toString()); assert.equal(delivery.workshopReady, false);
    text = renderVisionHandbook(handbook, manifest); assert.match(text, /新会话证据未齐（target_reload_recorded）/); assert.match(text, /standalone_tuning_reload_unverified/); assert.match(text, /尚未满足当前交付规则/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
