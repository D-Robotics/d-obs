import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { VisionAiDebugManager, type VisionAiDebugPlanner } from './vision-workshop-ai-debug.js';
import { VisionDeviceExecutionError, VisionDeviceRegistry, type VisionCameraControls, type VisionDeviceProfile } from './vision-workshop-device.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { visionCrc32 } from './vision-workshop-export.js';
import type { VisionAiDebugDecision } from './vision-workshop-ai-model.js';

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function png(value: number) {
  const chunk = (name: string, bytes: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); const body = Buffer.concat([Buffer.from(name), bytes]); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(body)); return Buffer.concat([size, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.from([0, value, value, value, value, value, value, 0, value, value, value, value, value, value]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const decision = (action: VisionAiDebugDecision['action'], improved = false, values?: Record<string, number | boolean>): VisionAiDebugDecision => ({ source: 'model', model: 'explicit-visual-fixture', modelInput: 'camera_images_controls_and_history', action, ...(values ? { values } : {}), notes: '明确的本机视觉决策fixture，不能作为真实模型画质证明', assessment: { improved, sceneUsable: true, goalSatisfied: improved, issue: improved ? 'acceptable' : 'exposure', reason: '模型fixture按测试安排判断当前与历史画面' }, done: action !== 'adjust' });
async function fixture(planner: VisionAiDebugPlanner, probeFacts: Record<string, unknown> = {}, native?: { applySupported?: boolean; missingRules?: boolean }, captureData?: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'vision-ai-debug-'));
  const service = new VisionWorkshopService({ dataDir: dir });
  const controls: VisionCameraControls = { gamma: { value: 100, min: 72, max: 500, step: 1, writable: true, active: true }, exposureUs: { value: 1000, min: 100, max: 5000, step: 100, writable: true, active: true }, autoExposure: { value: false, writable: true } };
  let sigma = 2;
  const tuning = () => ({ kind: native ? 'x5-hbn-isp-v2' : 'explicit-fixture-controls', controls: Object.fromEntries(Object.entries(controls).map(([key, row]) => [key, row.value])), ...(native ? { modules: { nr2d: { mode: 0, values: { sigma_scale_0_0: sigma }, privateSdkBytes: 'PRIVATE_FIXTURE_SDK_BYTES' } }, snapshotId: 'private-fixture-snapshot', library: { sha256: '1'.repeat(64) } } : {}) });
  const profile: VisionDeviceProfile = { id: 'fixture-' + randomUUID(), label: 'Explicit fixture only', board: 'Fixture S100', sensorModel: 'Fixture UVC', sdkVersion: 'fixture-ai-v1', cameraInterface: 'USB UVC', cameraMode: 'fixture-2x2', operations: ['probe', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning'] };
  if (native && native.applySupported !== false) profile.operations = [...profile.operations.filter(operation => operation !== 'controls_set'), 'apply_tuning'];
  const calls: string[] = []; let badRestore = false; let restoreFailure = false; let captureCount = 0; let badCaptureAt = 0; let streamFailureAt = 0; let badProbe = false;
  let applyFailure = false; let badApplyHash = false; let badTuningCaptureAt = 0;
  const appliedTunings: unknown[] = [];
  let restoreObserver: (() => Promise<void>) | undefined;
  const devices = new VisionDeviceRegistry([{ profile, execute: async (operation, _context, inputs) => {
    calls.push(operation);
    if (operation === 'probe' && badProbe) return { facts: { fixture: true } };
    if (operation === 'probe') return { facts: { fixture: true, rawAvailable: false, ...probeFacts }, baseline: { config: tuning(), rules: native ? native.missingRules ? [] : [{ path: '/modules/nr2d/values/sigma_scale_0_0', label: 'Explicit fixture AUTO sigma slot 0', min: 1, max: 4, precision: 'float32' }] : [{ path: '/controls/gamma', label: 'gamma', min: 72, max: 500, step: 1 }] } };
    if (operation === 'controls_get') return { controls: structuredClone(controls) };
    if (operation === 'controls_set') { for (const [key, value] of Object.entries(inputs.values as Record<string, number | boolean>)) controls[key].value = value; return { controls: structuredClone(controls) }; }
    if (operation === 'apply_tuning') {
      const requested = inputs.tuning as ReturnType<typeof tuning>;
      sigma = requested.modules!.nr2d.values.sigma_scale_0_0;
      appliedTunings.push(structuredClone(requested));
      if (applyFailure) throw new VisionDeviceExecutionError('vision_device_execution_failed', 'Fixture apply failed after SDK mutation', 502, { operation, outcome: 'unconfirmed', adapterCode: 'isp_write_unconfirmed_restore_required' });
      return { appliedHash: inputs.tuningHash, readbackHash: badApplyHash ? '0'.repeat(64) : digest(JSON.stringify(tuning())) };
    }
    if (operation === 'restore_tuning') {
      await restoreObserver?.();
      for (const [key, value] of Object.entries((inputs.tuning as ReturnType<typeof tuning>).controls)) controls[key].value = value;
      if (native) sigma = (inputs.tuning as ReturnType<typeof tuning>).modules!.nr2d.values.sigma_scale_0_0;
      if (restoreFailure) throw new VisionDeviceExecutionError('vision_device_execution_failed', 'Fixture flow restart failed after configuration changed', 502, { operation, outcome: 'unconfirmed', adapterCode: 'camera_stream_start_failed', sdkCode: -36 });
      return { appliedHash: inputs.tuningHash, readbackHash: badRestore ? '0'.repeat(64) : inputs.tuningHash };
    }
    captureCount++;
    if (captureCount === streamFailureAt) throw new VisionDeviceExecutionError('vision_device_execution_failed', 'Fixture capture cannot restart the camera stream', 502, { operation, outcome: 'unconfirmed', adapterCode: 'camera_stream_start_failed', sdkCode: -36 });
    if (captureCount === badCaptureAt) return { filename: 'invalid-fixture.png', mimeType: 'image/png', contentBase64: 'not-base64', sha256: '0'.repeat(64), controls: structuredClone(controls), tuningHash: digest(JSON.stringify(tuning())) };
    const data = captureData ?? png(Math.floor(Number(controls.gamma.value) / 2));
    return { filename: 'actual-fixture.png', mimeType: 'image/png', contentBase64: data.toString('base64'), sha256: digest(data), controls: structuredClone(controls), tuningHash: captureCount === badTuningCaptureAt ? '0'.repeat(64) : digest(JSON.stringify(tuning())), capturedAt: new Date().toISOString() };
  } }]);
  const experiment = await service.createExperiment('alice', { title: 'Explicit autonomous camera fixture', goal: '验收受限模型调用协议', targetId: profile.id, board: profile.board, sensorModel: profile.sensorModel, sdkVersion: profile.sdkVersion, cameraInterface: profile.cameraInterface, cameraMode: profile.cameraMode });
  const manager = new VisionAiDebugManager(service, devices, planner);
  const wait = async (runId: string) => { for (let i = 0; i < 400; i++) { const run = await manager.get('alice', experiment.id, runId); if (!['queued', 'running'].includes(run.status)) return run; await new Promise(done => setTimeout(done, 10)); } throw new Error('fixture run did not finish'); };
  return { manager, service, controls, devices, profile, experiment, calls, wait, appliedTunings, nativeSigma: () => sigma, setApplyFailure: () => { applyFailure = true; }, setBadApplyHash: () => { badApplyHash = true; }, setBadTuningCapture: (index: number) => { badTuningCaptureAt = index; }, setBadRestore: (value = true) => { badRestore = value; }, setRestoreFailure: () => { restoreFailure = true; }, setRestoreObserver: (observer: () => Promise<void>) => { restoreObserver = observer; }, setBadCapture: (index: number) => { badCaptureAt = index; }, setStreamFailure: (index: number) => { streamFailureAt = index; }, setBadProbe: () => { badProbe = true; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('autonomous debug observes actual frames, evaluates improvement and retains verified best with a new final frame', async () => {
  let count = 0;
  const env = await fixture(async input => {
    count++; assert.ok(input.originalImage.contentBase64); assert.ok(input.currentStatistics.pixelCount);
    if (count === 1) return decision('adjust', false, { gamma: 120 });
    assert.equal(input.controls.gamma.value, 120); assert.equal((input.history[0] as any).before.controls, undefined);
    return decision('keep', true);
  });
  try {
    const initial = await env.manager.start('alice', env.experiment.id, '改善现场画面', 4);
    const final = await env.wait(initial.id);
    assert.equal(final.status, 'completed'); assert.equal(final.adjustmentCount, 1); assert.equal(final.iterations.length, 2);
    assert.equal(env.controls.gamma.value, 120); assert.equal(final.final?.restored, false);
    assert.equal(final.final?.streamVerification, 'verified');
    assert.notEqual(final.final?.frameId, final.best?.frameId);
    assert.ok(final.operations.some(op => op.operationId.endsWith('/device/controls_set')));
    assert.ok(final.operations.some(op => op.operationId.endsWith('/device/capture_frame')));
    const state = await env.service.getExperiment('alice', env.experiment.id);
    assert.equal(state.evaluations.length, 0); assert.equal(state.samples.length, 0);
    assert.ok(state.cameraFrames.some(frame => frame.id === final.final?.frameId));
    const reopened = new VisionWorkshopService({ dataDir: env.service.dataDir });
    assert.equal((await reopened.readAiDebugRun('alice', env.experiment.id, final.id)).status, 'completed');
    await assert.rejects(env.manager.get('bob', env.experiment.id, final.id));
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, final.id);
    assert.equal(restored.final?.restored, true); assert.equal(env.controls.gamma.value, 100);
    assert.equal(restored.goalSatisfied, false, 'old best assessment must not describe restored original');
    assert.notEqual(restored.final?.frameId, final.final?.frameId);
    assert.equal(restored.final?.hash, restored.original?.hash);
    assert.ok(restored.final?.frameId);
  } finally { await env.cleanup(); }
});

test('operator restore failure is durable and a successful retry clears the stale failure with a new frame', async () => {
  const env = await fixture(async () => decision('keep'));
  try {
    const started = await env.manager.start('alice', env.experiment.id, '恢复状态验收', 1); const final = await env.wait(started.id);
    assert.equal(final.final?.restored, true);
    env.setBadRestore();
    await assert.rejects(env.manager.restoreOriginal('alice', env.experiment.id, started.id), /restoration was not confirmed/);
    const failed = await env.service.readAiDebugRun('alice', env.experiment.id, started.id);
    assert.equal(failed.restorationError, 'vision_device_readback_mismatch');
    assert.ok(failed.operations.some(operation => operation.status === 'failed' && operation.operationId.endsWith('/restore-original')));
    const callsBeforeBlocked = env.calls.length;
    await assert.rejects(env.manager.start('alice', env.experiment.id, '恢复未确认不能再写', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
    assert.equal(env.calls.length, callsBeforeBlocked, 'blocked admission must not execute a probe or write');
    env.setBadRestore(false);
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(restored.restorationError, undefined);
    assert.equal(restored.final?.hash, restored.original?.hash);
    assert.notEqual(restored.final?.frameId, failed.final?.frameId);
    assert.equal((await env.service.readAiDebugRun('alice', env.experiment.id, started.id)).restorationError, undefined);
    const next = await env.manager.start('alice', env.experiment.id, '已恢复后重新开始', 1);
    assert.equal((await env.wait(next.id)).status, 'completed');
  } finally { await env.cleanup(); }
});

test('operator restore keeps verified parameters distinct from a failed new image', async () => {
  const env = await fixture(async () => decision('keep'));
  try {
    const started = await env.manager.start('alice', env.experiment.id, '人工恢复采图失败', 1); await env.wait(started.id);
    env.setBadCapture(3);
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(restored.final?.restored, true);
    assert.equal(restored.restorationError, undefined);
    assert.equal(restored.final?.imageError, 'vision_ai_debug_frame_invalid');
    assert.equal(restored.final?.streamVerification, 'unverified');
    assert.equal(restored.final?.frameId, undefined);
  } finally { await env.cleanup(); }
});

test('operator restoration persists a recovery fence before changing the device or clearing old final evidence', async () => {
  const env = await fixture(async () => decision('keep'));
  try {
    const started = await env.manager.start('alice', env.experiment.id, '人工恢复写前持久化', 1); const final = await env.wait(started.id); assert.ok(final.final?.frameId);
    env.setRestoreObserver(async () => {
      const pending = await env.service.readAiDebugRun('alice', env.experiment.id, started.id);
      assert.equal(pending.restorationError, 'vision_ai_debug_restoration_pending'); assert.equal(pending.stopReason, 'restoration_unconfirmed');
      assert.equal(pending.final, undefined, 'a crash must not leave the previous successful final frame as current evidence');
      const before = env.calls.length;
      await assert.rejects(env.manager.start('alice', env.experiment.id, '人工恢复中不能开启新run', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
      assert.equal(env.calls.length, before);
    });
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(restored.restorationError, undefined); assert.equal(restored.stopReason, 'operator_restored_original'); assert.equal(restored.final?.streamVerification, 'verified');
  } finally { await env.cleanup(); }
});

test('a failed final SDK restore is not replayed and blocks another AI run', async () => {
  const env = await fixture(async () => { env.setRestoreFailure(); return decision('keep'); });
  try {
    const started = await env.manager.start('alice', env.experiment.id, '恢复失败不得盲目重试', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.stopReason, 'restoration_unconfirmed');
    assert.equal(final.restorationError, 'vision_device_execution_failed');
    assert.equal(env.calls.filter(call => call === 'restore_tuning').length, 1, 'a failed flow restart must not trigger another restore automatically');
    const failure = final.operations.find(operation => operation.operationId.endsWith('/restore_tuning') && operation.status === 'failed');
    assert.equal(failure?.receipt?.sdkCode, -36); assert.equal(failure?.receipt?.adapterCode, 'camera_stream_start_failed');
    const before = env.calls.length;
    await assert.rejects(env.manager.start('alice', env.experiment.id, '禁止接着写', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
    assert.equal(env.calls.length, before);
  } finally { await env.cleanup(); }
});

test('actual SDK capture failure after configuration readback stays recovery blocked without a second restore', async () => {
  const env = await fixture(async () => decision('keep')); env.setStreamFailure(2);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '流失败不能被getter成功掩盖', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.final?.restored, true, 'configuration getter remains confirmed independently');
    assert.equal(final.final?.streamVerification, 'failed'); assert.equal(final.final?.frameId, undefined);
    assert.equal(final.final?.imageError, 'vision_device_execution_failed'); assert.equal(final.restorationError, 'vision_device_execution_failed');
    assert.equal(env.calls.filter(call => call === 'restore_tuning').length, 1);
    const before = env.calls.length;
    await assert.rejects(env.manager.start('alice', env.experiment.id, '流恢复未确认禁止新run', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
    assert.equal(env.calls.length, before);
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(restored.restorationError, undefined); assert.equal(restored.final?.streamVerification, 'verified'); assert.ok(restored.final?.frameId);
  } finally { await env.cleanup(); }
});

test('operator restoration cannot clear recovery when SDK capture fails after a matching getter', async () => {
  const env = await fixture(async () => decision('keep'));
  try {
    const started = await env.manager.start('alice', env.experiment.id, '人工恢复仍需真实流回执', 1); await env.wait(started.id); env.setStreamFailure(3);
    await assert.rejects(env.manager.restoreOriginal('alice', env.experiment.id, started.id), /Fixture capture/);
    const failed = await env.service.readAiDebugRun('alice', env.experiment.id, started.id);
    assert.equal(failed.final?.restored, true); assert.equal(failed.final?.streamVerification, 'failed'); assert.equal(failed.restorationError, 'vision_device_execution_failed');
    assert.equal(failed.final?.frameId, undefined);
    const next = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(next.final?.streamVerification, 'verified'); assert.equal(next.restorationError, undefined);
  } finally { await env.cleanup(); }
});

test('an orphaned persisted run blocks another AI admission until explicit original recovery', async () => {
  const env = await fixture(async () => decision('keep'));
  try {
    const started = await env.manager.start('alice', env.experiment.id, '明确软件中断fixture', 1);
    const orphan = await env.wait(started.id);
    orphan.status = 'running'; delete orphan.final;
    await env.service.saveAiDebugRun('alice', env.experiment.id, orphan);
    const before = env.calls.length;
    await assert.rejects(env.manager.start('alice', env.experiment.id, '不能静默续写', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
    assert.equal(env.calls.length, before);
    assert.equal((await env.manager.get('alice', env.experiment.id, orphan.id)).status, 'interrupted');
    await env.manager.restoreOriginal('alice', env.experiment.id, orphan.id);
    const next = await env.manager.start('alice', env.experiment.id, '明确恢复后可重新开始', 1);
    assert.equal((await env.wait(next.id)).status, 'completed');
  } finally { await env.cleanup(); }
});

test('adjustment budget includes a final visual assessment and never keeps an unassessed or unusable candidate', async () => {
  let count = 0;
  const env = await fixture(async input => { count++; if (count === 1) return decision('adjust', false, { gamma: 120 }); assert.equal(input.assessmentOnly, true); return { ...decision('keep'), assessment: { improved: false, sceneUsable: false, goalSatisfied: false, issue: 'scene', reason: '画面不可用，不能冒充改善' } }; });
  try {
    const start = await env.manager.start('alice', env.experiment.id, '看清真实画面', 1); const final = await env.wait(start.id);
    assert.equal(count, 2); assert.equal(final.adjustmentCount, 1); assert.equal(final.final?.restored, true); assert.equal(env.controls.gamma.value, 100);
    assert.equal(final.goalSatisfied, false);
  } finally { await env.cleanup(); }
});

test('model failure after an actual write restores the initial configuration and preserves failed run evidence', async () => {
  let count = 0;
  const env = await fixture(async () => { if (++count === 1) return decision('adjust', false, { gamma: 120 }); throw new Error('vision_ai_debug_model_unavailable'); });
  try {
    const start = await env.manager.start('alice', env.experiment.id, '有失败证据的调试', 2); const final = await env.wait(start.id);
    assert.equal(final.status, 'failed'); assert.equal(final.error, 'vision_ai_debug_model_unavailable'); assert.equal(final.final?.restored, true); assert.equal(env.controls.gamma.value, 100);
    assert.equal(final.iterations[0].readback?.gamma.value, 120);
  } finally { await env.cleanup(); }
});

test('cancel aborts pending visual inference, waits for verified restoration and releases the whole-run device lease', async () => {
  let ready!: () => void; const reached = new Promise<void>(resolve => { ready = resolve; });
  const env = await fixture(async input => { ready(); return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('vision_ai_debug_canceled')), { once: true })); });
  let startedId: string | undefined; let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = await env.manager.start('alice', env.experiment.id, '取消测试', 4); startedId = start.id;
    await Promise.race([reached, new Promise((_resolve, reject) => { readinessTimer = setTimeout(() => reject(new Error('fixture never reached pending model; inspect run failure')), 2000); })]);
    if (readinessTimer) clearTimeout(readinessTimer);
    await assert.rejects(env.devices.execute(env.profile.id, 'controls_get', { experimentId: env.experiment.id, board: env.profile.board, sensorModel: env.profile.sensorModel, sdkVersion: env.profile.sdkVersion, cameraInterface: env.profile.cameraInterface, cameraMode: env.profile.cameraMode }, {}), /Another operation/);
    const requested = await env.manager.cancel('alice', env.experiment.id, start.id); assert.equal(requested.cancelRequested, true);
    const final = await env.wait(start.id); assert.equal(final.status, 'canceled'); assert.equal(final.final?.restored, true);
    await env.devices.execute(env.profile.id, 'controls_get', { experimentId: env.experiment.id, board: env.profile.board, sensorModel: env.profile.sensorModel, sdkVersion: env.profile.sdkVersion, cameraInterface: env.profile.cameraInterface, cameraMode: env.profile.cameraMode }, {});
  } finally { if (readinessTimer) clearTimeout(readinessTimer); if (startedId) { await env.manager.cancel('alice', env.experiment.id, startedId).catch(() => undefined); await env.wait(startedId).catch(() => undefined); } await env.cleanup(); }
});

test('restoration hash mismatch is recorded as unconfirmed rather than claiming original recovery', async () => {
  const env = await fixture(async () => { env.setBadRestore(); throw new Error('vision_ai_debug_model_unavailable'); });
  try {
    const start = await env.manager.start('alice', env.experiment.id, '失败恢复检查', 1); const final = await env.wait(start.id);
    assert.equal(final.status, 'failed'); assert.equal(final.restorationError, 'vision_device_readback_mismatch'); assert.equal(final.final, undefined); assert.equal(final.stopReason, 'restoration_unconfirmed');
  } finally { await env.cleanup(); }
});

test('failure before any original snapshot does not claim original restoration or make writes', async () => {
  const env = await fixture(async () => { throw new Error('planner must not be called'); }); env.setBadProbe();
  try {
    const started = await env.manager.start('alice', env.experiment.id, '没有配置快照的真实失败', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.stopReason, 'failed_before_original_snapshot_no_write');
    assert.equal(final.original, undefined); assert.equal(final.final, undefined); assert.ok(!env.calls.includes('controls_set')); assert.ok(!env.calls.includes('restore_tuning'));
  } finally { await env.cleanup(); }
});

for (const state of [
  { facts: { cleanupRequired: true }, error: 'camera_stream_cleanup_required' },
  { facts: { writeOutcome: 'unconfirmed' }, error: 'isp_write_unconfirmed_restore_required' },
  { facts: { streaming: false }, error: undefined },
]) test('initial probe admission preserves unresolved device state: ' + JSON.stringify(state.facts), async () => {
  let modelCalls = 0;
  const env = await fixture(async () => { modelCalls++; return decision('keep'); }, state.facts);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '不能把未知写入状态作为本轮原始配置', 1); const final = await env.wait(started.id);
    if (state.error) {
      assert.equal(final.status, 'failed'); assert.equal(final.error, state.error);
      assert.equal(final.stopReason, 'failed_before_original_snapshot_no_write'); assert.equal(final.original, undefined); assert.equal(final.final, undefined);
      assert.equal(modelCalls, 0); assert.deepEqual(env.calls, ['probe'], 'no controls snapshot, adjustment or automatic restore may execute');
      const reopened = await env.service.readAiDebugRun('alice', env.experiment.id, started.id);
      assert.equal(reopened.original, undefined); assert.equal(reopened.error, state.error);
    } else {
      assert.equal(final.status, 'completed'); assert.ok(final.original); assert.equal(modelCalls, 1, 'a stopped healthy stream must remain eligible');
    }
  } finally { await env.cleanup(); }
});

test('failed final image remains separate from verified original configuration and retains model validation warnings', async () => {
  const env = await fixture(async () => ({ ...decision('keep'), validationWarnings: ['vision_ai_debug_model_output_invalid'] })); env.setBadCapture(2);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '区分控制恢复和现场照片', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'completed'); assert.equal(final.final?.restored, true); assert.equal(final.final?.imageError, 'vision_ai_debug_frame_invalid');
    assert.equal(final.final?.frameId, undefined); assert.equal(final.restorationError, undefined);
    assert.deepEqual(final.iterations[0].validationWarnings, ['vision_ai_debug_model_output_invalid']);
    assert.equal(final.iterations[0].modelInput, 'camera_images_controls_and_history'); assert.equal(final.iterations[0].tool, 'camera_debug_decision');
  } finally { await env.cleanup(); }
});

test('completion goal belongs to selected best assessment rather than a different later current frame', async () => {
  let count = 0;
  const env = await fixture(async () => {
    count++;
    if (count === 1) return decision('adjust', false, { gamma: 120 });
    if (count === 2) return { ...decision('adjust', true, { gamma: 140 }), assessment: { improved: true, sceneUsable: true, goalSatisfied: false, issue: 'exposure', reason: '120较好，但尚未满足目标' } };
    return { ...decision('keep'), assessment: { improved: false, sceneUsable: true, goalSatisfied: true, issue: 'acceptable', reason: '当前140有目标内容，但对比最佳120更差；保留最佳' } };
  });
  try {
    const started = await env.manager.start('alice', env.experiment.id, '评估必须对应所选画面', 3); const final = await env.wait(started.id);
    assert.equal(final.status, 'completed'); assert.equal(env.controls.gamma.value, 120);
    assert.equal(final.iterations[2].assessment.goalSatisfied, true); assert.equal(final.best?.assessment?.goalSatisfied, false); assert.equal(final.goalSatisfied, false);
    assert.equal(final.final?.visualVerification, 'unverified'); assert.notEqual(final.final?.frameId, final.best?.frameId);
  } finally { await env.cleanup(); }
});

test('a claimed improvement with noise or detail regression cannot replace verified best', async () => {
  let count = 0;
  const env = await fixture(async () => {
    if (++count === 1) return decision('adjust', false, { gamma: 120 });
    return { ...decision('keep', true), assessment: { ...decision('keep', true).assessment, regressions: ['noise', 'detail'], reason: '错误fixture同时宣称改善，但承认噪声和细节退化' } };
  });
  try {
    const started = await env.manager.start('alice', env.experiment.id, '画质改善不能以噪声和细节退化换取', 2); const final = await env.wait(started.id);
    assert.equal(final.status, 'completed'); assert.equal(final.iterations[1].assessment.improved, true);
    assert.deepEqual(final.iterations[1].assessment.regressions, ['noise', 'detail']);
    assert.equal(final.best?.hash, final.original?.hash); assert.equal(final.final?.restored, true); assert.equal(env.controls.gamma.value, 100); assert.equal(final.goalSatisfied, false);
  } finally { await env.cleanup(); }
});

const nativePatch = { path: '/modules/nr2d/values/sigma_scale_0_0', value: 2.1, reason: '明确fixture只轻微修改AUTO中已资格化的一个数值槽' };
const nativeDecision = (): VisionAiDebugDecision => ({ ...decision('adjust'), patches: [nativePatch] });

test('a controls adapter cannot be promoted to native ISP by a planner patch', async () => {
  const env = await fixture(async input => { assert.equal(input.tuning, undefined); return nativeDecision(); });
  try {
    const started = await env.manager.start('alice', env.experiment.id, 'UVC不能假称原生ISP', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(env.calls.includes('apply_tuning'), false); assert.equal(env.calls.includes('controls_set'), false);
    assert.equal(final.final?.restored, true); assert.equal(final.final?.streamVerification, 'verified');
  } finally { await env.cleanup(); }
});

test('native ISP AI applies a qualified AUTO leaf with full hashes, keeps best and explicitly restores the original', async () => {
  let count = 0;
  const env = await fixture(async input => {
    count++; assert.ok(input.tuning); assert.equal(input.tuning.config.kind, 'x5-hbn-isp-v2');
    assert.deepEqual(input.tuning.rules.map(rule => rule.path), [nativePatch.path]);
    if (count === 1) return nativeDecision();
    assert.equal((input.tuning.config.modules as any).nr2d.values.sigma_scale_0_0, Math.fround(2.1));
    assert.equal((input.history[0] as any).requestedPatches[0].value, Math.fround(2.1));
    return decision('keep', true);
  }, {}, {});
  try {
    const started = await env.manager.start('alice', env.experiment.id, '原生AUTO叶子调优fixture', 2); const final = await env.wait(started.id);
    assert.equal(final.status, 'completed'); assert.equal(final.adjustmentCount, 1); assert.equal(count, 2);
    assert.equal(env.nativeSigma(), Math.fround(2.1)); assert.equal(final.final?.restored, false);
    assert.equal(final.iterations[0].readbackHash, final.iterations[0].after?.tuningHash);
    assert.equal(final.iterations[0].requestedValues, undefined); assert.equal(env.calls.includes('controls_set'), false);
    assert.equal(final.final?.streamVerification, 'verified'); assert.notEqual(final.final?.frameId, final.best?.frameId);
    const applied = env.appliedTunings[0] as any;
    assert.equal(applied.modules.nr2d.mode, 0); assert.equal(applied.modules.nr2d.privateSdkBytes, 'PRIVATE_FIXTURE_SDK_BYTES');
    assert.deepEqual(applied.library, { sha256: '1'.repeat(64) });
    const reopened = new VisionWorkshopService({ dataDir: env.service.dataDir });
    assert.deepEqual((await reopened.readAiDebugRun('alice', env.experiment.id, started.id)).iterations[0].requestedPatches, [{ ...nativePatch, value: Math.fround(2.1) }]);
    const restored = await env.manager.restoreOriginal('alice', env.experiment.id, started.id);
    assert.equal(env.nativeSigma(), 2); assert.equal(restored.final?.hash, restored.original?.hash); assert.equal(restored.final?.streamVerification, 'verified');
  } finally { await env.cleanup(); }
});

for (const invalid of [
  { name: 'unknown path', patches: [{ ...nativePatch, path: '/modules/exposure/values/unqualified' }] },
  { name: 'out of range', patches: [{ ...nativePatch, value: 5 }] },
  { name: 'too many patches', patches: Array.from({ length: 4 }, () => nativePatch) },
  { name: 'flat controls downgrade', values: { gamma: 120 } },
  { name: 'mixed adjustment channels', patches: [nativePatch], values: { gamma: 120 } },
]) test('native AI rejects ' + invalid.name + ' before apply or flat controls', async () => {
  const { name: _name, ...adjustment } = invalid;
  const env = await fixture(async () => ({ ...decision('adjust'), ...adjustment }), {}, {});
  try {
    const started = await env.manager.start('alice', env.experiment.id, '拒绝扩大原生字段资格', 2); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(env.calls.includes('apply_tuning'), false); assert.equal(env.calls.includes('controls_set'), false);
    assert.equal(env.nativeSigma(), 2); assert.equal(final.final?.restored, true); assert.equal(final.final?.streamVerification, 'verified');
  } finally { await env.cleanup(); }
});

for (const options of [{ applySupported: false }, { missingRules: true }]) test('native admission never falls back when qualification is missing: ' + JSON.stringify(options), async () => {
  let calls = 0;
  const env = await fixture(async () => { calls++; return decision('adjust', false, { gamma: 120 }); }, {}, options);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '未资格化不能走平面控制', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.error, 'vision_ai_debug_native_isp_unavailable');
    assert.equal(calls, 0); assert.equal(final.original, undefined); assert.deepEqual(env.calls, ['probe']);
  } finally { await env.cleanup(); }
});

for (const failure of ['setter', 'readback', 'new_frame'] as const) test('native ' + failure + ' failure stops iteration and restores the full original with a new frame', async () => {
  let count = 0;
  const env = await fixture(async () => { count++; return nativeDecision(); }, {}, {});
  if (failure === 'setter') env.setApplyFailure();
  if (failure === 'readback') env.setBadApplyHash();
  if (failure === 'new_frame') env.setBadTuningCapture(2);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '失败不能继续尝试其它参数', 3); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(count, 1); assert.equal(env.calls.filter(call => call === 'apply_tuning').length, 1);
    assert.equal(env.calls.includes('controls_set'), false); assert.equal(env.nativeSigma(), 2);
    assert.equal(final.final?.restored, true); assert.equal(final.final?.hash, final.original?.hash); assert.equal(final.final?.streamVerification, 'verified');
    assert.equal(env.calls.filter(call => call === 'restore_tuning').length, 1);
    assert.ok(final.iterations[0].requestedPatches?.length); assert.equal(final.iterations[0].after, undefined);
  } finally { await env.cleanup(); }
});

test('native restoration failure retains the recovery fence and is never retried within the failed run', async () => {
  const env = await fixture(async () => { env.setApplyFailure(); env.setRestoreFailure(); return nativeDecision(); }, {}, {});
  try {
    const started = await env.manager.start('alice', env.experiment.id, '原生恢复失败必须人工恢复', 2); const final = await env.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.stopReason, 'restoration_unconfirmed'); assert.ok(final.restorationError);
    assert.equal(env.calls.filter(call => call === 'restore_tuning').length, 1);
    const before = env.calls.length;
    await assert.rejects(env.manager.start('alice', env.experiment.id, '禁止继续', 1), error => error instanceof Error && 'code' in error && error.code === 'vision_ai_debug_recovery_required');
    assert.equal(env.calls.length, before);
  } finally { await env.cleanup(); }
});

test('large PNG capture archives exact source bytes and sends only a bounded, source-bound model preview', async () => {
  const width = 1920; const height = 1080;
  const pixels = Buffer.alloc((width * 3 + 1) * height); let state = 19260817;
  for (let row = 0; row < height; row++) for (let col = 0; col < width * 3; col++) {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    pixels[row * (width * 3 + 1) + col + 1] = state >>> 24;
  }
  const chunk = (name: string, data: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(name), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(body)); return Buffer.concat([size, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const original = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(original.length > 1024 * 1024);
  let modelCalls = 0;
  const env = await fixture(async input => {
    modelCalls++;
    for (const image of [input.originalImage, input.bestImage!, input.currentImage]) {
      const bytes = Buffer.from(image.contentBase64, 'base64');
      assert.ok(bytes.length <= 1024 * 1024); assert.equal(digest(bytes), image.provenance?.sha256);
      assert.equal(image.provenance?.sourceSha256, digest(original));
      assert.equal(image.provenance?.sourceWidth, width); assert.equal(image.provenance?.sourceHeight, height);
      assert.ok(image.provenance!.width <= 1280); assert.ok(image.provenance!.height <= 720);
    }
    return decision('keep');
  }, {}, undefined, original);
  try {
    const started = await env.manager.start('alice', env.experiment.id, '原图归档与模型缩图分开', 1); const final = await env.wait(started.id);
    assert.equal(final.status, 'completed'); assert.equal(modelCalls, 1);
    const saved = await env.service.readCameraFrame('alice', env.experiment.id, final.original!.frameId!);
    assert.deepEqual(saved.data, original); assert.equal(saved.frame.width, width); assert.equal(saved.frame.hash, digest(original));
    assert.equal(final.iterations[0].before.modelPreview?.sourceSha256, saved.frame.hash);
    assert.equal(final.final?.streamVerification, 'verified');
  } finally { await env.cleanup(); }
});
