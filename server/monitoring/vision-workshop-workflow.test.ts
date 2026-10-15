import assert from 'node:assert/strict';
import { test } from 'node:test';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { VisionExperiment, VisionDeviceRun, VisionCameraFrame } from './vision-workshop-service.js';
import type { VisionDeviceProfile, VisionDeviceOperation } from './vision-workshop-device.js';
import type { VisionAiDebugRun } from './vision-workshop-ai-debug.js';
import { analyzeVisionCameraStreamEvidence, buildVisionCameraWorkflow } from './vision-workshop-workflow.js';
import { buildVisionWorkshopMcpTools } from './vision-workshop-routes.js';

const hash = 'a'.repeat(64);
const profile: VisionDeviceProfile = { id: 'explicit-software-fixture', label: 'No hardware execution', board: 'fixture-board', sensorModel: 'new-fixture-sensor', sdkVersion: 'fixture-sdk', operations: ['probe', 'bringup', 'pipeline_validate', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning', 'preview_stop', 'tuning_get'] };
function experiment(): VisionExperiment {
  return { id: 'fixture-experiment', title: 'Pure projection test', goal: 'Inspect actual image quality', targetId: profile.id, board: profile.board, sensorModel: profile.sensorModel, sdkVersion: profile.sdkVersion,
    baseline: null, baselineHistory: [], samples: [], candidates: [], processedImages: [], cameraFrames: [], evaluations: [], comparisons: [], deviceRuns: [], aiDebugRuns: [], selectedCandidateId: null, bytesStored: 0, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z' };
}
function run(index: number, operation: VisionDeviceOperation, result: Record<string, unknown> = {}, status: 'completed' | 'failed' = 'completed'): VisionDeviceRun {
  return { id: 'device-' + index, operation, status, adapterId: profile.id, board: profile.board, sensorModel: profile.sensorModel, sdkVersion: profile.sdkVersion, createdAt: new Date(1792022400000 + index * 1000).toISOString(), evidence: { result: result as never } };
}
function ai(status: VisionAiDebugRun['status']): VisionAiDebugRun {
  return { id: 'ai-fixture', source: 'model', tool: 'camera_debug_decision', status, goal: 'fixture', maxRounds: 1, adjustmentCount: 0, iterations: [], operations: [], cancelRequested: false, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', original: { hash, tuning: { fixture: 1 }, controls: {} } };
}
function baseline(exp: VisionExperiment) {
  exp.baseline = { id: 'original', hash, tuning: { fixture: 1 }, rules: [], createdAt: '2026-10-15T00:00:03.000Z' };
}
function prepared(): VisionExperiment {
  const exp = experiment(); baseline(exp);
  exp.deviceRuns = [run(0, 'probe', { facts: { nativeSdkAvailable: true } }), run(1, 'bringup', { passed: true }), run(2, 'pipeline_validate', { passed: true }), run(3, 'capture_frame', { tuningHash: hash })];
  exp.cameraFrames.push({ id: 'frame', filename: 'fixture.png', mimeType: 'image/png', hash, byteLength: 1, width: 2, height: 2, adapterId: profile.id, source: 'runner', tuningHash: hash, verification: 'unverified', createdAt: exp.deviceRuns[3].createdAt } as VisionCameraFrame);
  return exp;
}
function frame(index: number, frameId: unknown, timestampNs: unknown, extra: Record<string, unknown> = {}): VisionDeviceRun {
  return run(index, 'capture_frame', { tuningHash: hash, evidence: { frameId, sdkTimestampNs: timestampNs, timestampSource: 'hbn_frame_info.tv_timeval', pipelineEpoch: 0, ...extra } });
}

test('unknown sensors require adaptation evidence and never produce fake bringup or AI admission', () => {
  const exp = experiment(); const before = structuredClone(exp);
  const plan = buildVisionCameraWorkflow(exp, [], true);
  assert.equal(plan.contract, 'rdk.vision-camera-workflow.v1');
  assert.equal(plan.evidenceSource, 'persisted-experiment'); assert.equal(plan.automaticExecution, false);
  assert.ok(plan.blockedBy.includes('vision_device_adapter_required'));
  assert.ok(plan.missingAdaptation.some(item => item.id === 'clock-and-mode'));
  assert.ok(plan.missingAdaptation.every(item => item.status === 'needs_evidence' && item.executed === false));
  assert.ok(plan.nextActions.every(item => ['knowledge', 'read'].includes(item.sideEffect)));
  assert.equal('experimentId' in plan.nextActions.find(item => item.tool === 'vision_camera_knowledge_search')!.arguments, false);
  assert.deepEqual(plan.nextActions.find(item => item.tool === 'vision_workshop_runtime_status')!.arguments, {});
  assert.deepEqual(z.object({}).strict().parse(plan.nextActions.find(item => item.tool === 'vision_workshop_runtime_status')!.arguments), {});
  assert.deepEqual(exp, before);
});

test('recovery blocks new AI, identity mismatch prevents device operations, and active runs only offer status/cancel', () => {
  const exp = prepared(); exp.aiDebugRuns.push(ai('interrupted'));
  let plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.equal(plan.recovery.status, 'unconfirmed'); assert.equal(plan.nextActions[0].tool, 'vision_ai_debug_restore_original');
  assert.equal(plan.nextActions.some(item => item.tool === 'vision_ai_debug_start'), false);
  plan = buildVisionCameraWorkflow(exp, [{ ...profile, sdkVersion: 'different' }], true);
  assert.ok(plan.blockedBy.includes('vision_device_profile_mismatch')); assert.ok(plan.nextActions.every(item => item.sideEffect === 'read'));
  exp.aiDebugRuns.push({ ...ai('running'), id: 'active' });
  plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.deepEqual(plan.nextActions.map(item => item.tool), ['vision_ai_debug_status', 'vision_ai_debug_cancel']);
});

test('workflow requires saved probe, bringup, post-bringup pipeline, actual baseline and matching capture in that order', () => {
  const exp = experiment(); const tool = () => buildVisionCameraWorkflow(exp, [profile], true).nextActions[0]?.tool;
  assert.equal(tool(), 'vision_camera_probe');
  exp.deviceRuns.push(run(0, 'probe', { facts: { nativeSdkAvailable: true } })); assert.equal(tool(), 'vision_camera_bringup');
  exp.deviceRuns.push(run(1, 'pipeline_validate', { passed: true })); assert.equal(tool(), 'vision_camera_bringup', 'validation before bringup is insufficient');
  exp.deviceRuns.push(run(2, 'bringup', { passed: true })); assert.equal(tool(), 'vision_pipeline_validate');
  exp.deviceRuns.push(run(3, 'pipeline_validate', { passed: true })); assert.equal(tool(), 'vision_isp_tuning_get');
  baseline(exp); assert.equal(tool(), 'vision_camera_capture_frame');
  exp.deviceRuns.push(run(4, 'capture_frame', { tuningHash: hash })); assert.equal(tool(), 'vision_camera_capture_frame', 'a receipt without an archived bound image is insufficient');
  exp.cameraFrames.push({ ...prepared().cameraFrames[0], createdAt: exp.deviceRuns[4].createdAt }); assert.equal(tool(), 'vision_ai_debug_start');
  const noModel = buildVisionCameraWorkflow(exp, [profile], false); assert.ok(noModel.blockedBy.includes('vision_model_disabled'));
});

test('a saved probe fence prioritizes cleanup and matches its durable hash to the AI original it overrides', () => {
  const exp = prepared(); const interrupted = ai('interrupted'); exp.aiDebugRuns.push(interrupted);
  exp.deviceRuns.push(run(4, 'probe', { facts: { cleanupRequired: true, writeOutcome: 'unconfirmed', recoveryOriginalHash: hash } }));
  const plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.equal(plan.recovery.source, 'saved-device-probe'); assert.equal(plan.recovery.runId, undefined);
  assert.deepEqual(plan.nextActions.map(item => item.tool), ['vision_camera_preview_stop', 'vision_ai_debug_restore_original']);
  assert.ok(plan.blockedBy.includes('camera_stream_cleanup_required')); assert.ok(plan.blockedBy.includes('isp_write_unconfirmed_restore_required'));
  assert.equal(plan.nextActions[1].arguments.runId, interrupted.id);
  assert.equal(plan.nextActions.some(item => item.tool === 'vision_isp_restore'), false, 'prefer the exact saved AI original over an equal baseline');
});

test('missing, malformed or unmatched durable original hashes never promote an arbitrary baseline to recovery', () => {
  for (const recoveryOriginalHash of [undefined, 'b'.repeat(64), 'not-a-hash', 'a'.repeat(63)]) {
    const exp = prepared(); exp.aiDebugRuns.push(ai('interrupted'));
    exp.deviceRuns.push(run(4, 'probe', { facts: { writeOutcome: 'unconfirmed', recoveryOriginalHash } }));
    const plan = buildVisionCameraWorkflow(exp, [profile], true);
    assert.ok(plan.blockedBy.includes('durable_original_binding_required'));
    assert.deepEqual(plan.nextActions.map(item => item.tool), ['vision_experiment_get']);
    assert.ok(plan.nextActions.every(item => item.sideEffect === 'read'));
  }
});

test('baseline restoration from a probe fence requires an exact saved durable hash and cleanup first', () => {
  const exp = prepared();
  exp.deviceRuns.push(run(4, 'probe', { facts: { cleanupRequired: true, writeOutcome: 'unconfirmed', recoveryOriginalHash: hash } }));
  const before = structuredClone(exp);
  const plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.deepEqual(plan.nextActions.map(item => item.tool), ['vision_camera_preview_stop', 'vision_isp_restore']);
  assert.equal(plan.nextActions[1].arguments.baselineId, exp.baseline!.id); assert.deepEqual(exp, before);
  const unsupported = buildVisionCameraWorkflow(exp, [{ ...profile, operations: profile.operations.filter(operation => operation !== 'preview_stop') }], true);
  assert.ok(unsupported.blockedBy.includes('missing_operation:preview_stop')); assert.ok(unsupported.nextActions.every(item => item.sideEffect === 'read'));
});

test('current getter values or a probe baseline cannot replace the stored original recovery binding', () => {
  const exp = prepared(); const currentHash = 'b'.repeat(64);
  exp.deviceRuns.push(run(4, 'probe', { facts: { writeOutcome: 'unconfirmed', recoveryOriginalHash: currentHash }, readbackHash: currentHash, baseline: { hash: currentHash, config: { changedCurrentValue: 999 } } }));
  const original = structuredClone(exp.baseline);
  const plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.ok(plan.blockedBy.includes('durable_original_binding_required')); assert.deepEqual(plan.nextActions.map(item => item.tool), ['vision_experiment_get']);
  assert.deepEqual(exp.baseline, original);
  exp.deviceRuns[4].adapterId = 'other-adapter';
  (exp.deviceRuns[4].evidence.result as Record<string, unknown>).facts = { writeOutcome: 'unconfirmed', recoveryOriginalHash: hash };
  assert.ok(buildVisionCameraWorkflow(exp, [profile], true).blockedBy.includes('durable_original_binding_required'), 'a different adapter probe cannot establish this adapter original');
});

test('all emitted action arguments match the actual strict MCP tool declarations', () => {
  const catalog = new Map(buildVisionWorkshopMcpTools(express.Router(), {} as Request, {} as Response).map(tool => [tool.name, tool.inputSchema]));
  const plans = [buildVisionCameraWorkflow(experiment(), [], true), buildVisionCameraWorkflow(experiment(), [{ ...profile, sdkVersion: 'mismatch' }], true)];
  const progressing = experiment();
  for (const saved of [undefined, run(0, 'probe', { facts: { nativeSdkAvailable: true } }), run(1, 'bringup', { passed: true }), run(2, 'pipeline_validate', { passed: true })]) {
    if (saved) progressing.deviceRuns.push(saved);
    plans.push(buildVisionCameraWorkflow(progressing, [profile], true));
  }
  plans.push(buildVisionCameraWorkflow(prepared(), [profile], true), buildVisionCameraWorkflow(prepared(), [profile], false));
  const recovering = prepared(); recovering.aiDebugRuns.push(ai('interrupted'));
  plans.push(buildVisionCameraWorkflow(recovering, [profile], true));
  recovering.deviceRuns.push(run(4, 'probe', { facts: { cleanupRequired: true, writeOutcome: 'unconfirmed', recoveryOriginalHash: hash } }));
  plans.push(buildVisionCameraWorkflow(recovering, [profile], true));
  recovering.aiDebugRuns = []; plans.push(buildVisionCameraWorkflow(recovering, [profile], true));
  (recovering.deviceRuns[4].evidence.result as Record<string, unknown>).facts = { writeOutcome: 'unconfirmed' };
  plans.push(buildVisionCameraWorkflow(recovering, [profile], true));
  const active = prepared(); active.aiDebugRuns.push(ai('running')); plans.push(buildVisionCameraWorkflow(active, [profile], true));
  const delivered = prepared(); const completed = ai('completed'); completed.updatedAt = delivered.deviceRuns[3].createdAt;
  completed.final = { controls: {}, hash, restored: true, reason: 'restored', streamVerification: 'verified', visualVerification: 'unverified' }; delivered.aiDebugRuns.push(completed);
  plans.push(buildVisionCameraWorkflow(delivered, [profile], true));
  delivered.goal = 'calibrate'; plans.push(buildVisionCameraWorkflow(delivered, [profile], true));
  const actions = plans.flatMap(plan => plan.nextActions);
  for (const action of actions) {
    const declaration = catalog.get(action.tool); assert.ok(declaration, action.tool + ' must be an actual MCP tool');
    const schema = declaration as { properties: Record<string, { type?: string; minLength?: number; maxLength?: number; pattern?: string }>; required?: string[]; additionalProperties: boolean };
    assert.equal(schema.additionalProperties, false);
    const shape = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => Object.hasOwn(action.arguments, key) || schema.required?.includes(key)).map(([key, property]) => {
      // Workflow arguments currently use only the catalog's scalar string fields.
      assert.equal(property.type, 'string', action.tool + '.' + key);
      let field = z.string(); if (property.minLength !== undefined) field = field.min(property.minLength);
      if (property.maxLength !== undefined) field = field.max(property.maxLength);
      if (property.pattern) field = field.regex(new RegExp(property.pattern));
      return [key, schema.required?.includes(key) ? field : field.optional()];
    }));
    assert.deepEqual(z.object(shape).strict().parse(action.arguments), action.arguments, action.tool);
  }
});

test('probe SDK/offline and stream failures remain distinct and a fresh probe allows a bounded next bringup', () => {
  const exp = prepared();
  exp.deviceRuns.push(run(4, 'probe', { facts: { nativeSdkAvailable: false } }));
  assert.ok(buildVisionCameraWorkflow(exp, [profile], true).blockedBy.includes('native_sdk_runtime_unavailable'));
  exp.deviceRuns[4] = run(4, 'probe', { facts: { connected: false } });
  assert.ok(buildVisionCameraWorkflow(exp, [profile], true).blockedBy.includes('device_connection_unconfirmed'));
  exp.deviceRuns[4] = run(4, 'capture_frame', { sdkCode: -43 }, 'failed');
  assert.ok(buildVisionCameraWorkflow(exp, [profile], true).blockedBy.includes('camera_stream_failure_requires_diagnosis'));
  exp.deviceRuns.push(run(5, 'probe', { facts: { nativeSdkAvailable: true } }));
  assert.equal(buildVisionCameraWorkflow(exp, [profile], true).nextActions[0].tool, 'vision_camera_bringup');
});

test('calibration remains conditional on real assets and native capabilities; completed AI leads to delivery', () => {
  const exp = prepared(); exp.goal = 'Calibrate this camera';
  const completed = ai('completed'); completed.updatedAt = exp.deviceRuns[3].createdAt;
  completed.final = { controls: {}, hash, restored: true, reason: 'restored', streamVerification: 'verified', visualVerification: 'unverified' }; exp.aiDebugRuns.push(completed);
  let plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.ok(plan.blockedBy.includes('calibration_raw_and_native_isp_qualification_required'));
  assert.equal(plan.nextActions[0].tool, 'vision_calibration_asset_list');
  assert.equal(plan.nextActions.some(item => item.tool === 'vision_calibration_apply'), false);
  exp.goal = 'Inspect image';
  plan = buildVisionCameraWorkflow(exp, [profile], true);
  assert.equal(plan.nextActions[0].tool, 'vision_workshop_delivery'); assert.equal(plan.qualityVerification, 'unverified');
  completed.updatedAt = '2026-10-15T00:00:00.000Z';
  assert.equal(buildVisionCameraWorkflow(exp, [profile], true).nextActions[0].tool, 'vision_ai_debug_start', 'historical AI completion does not finish a new pipeline');
});

test('saved differences expose a frame-ID growth anomaly against a caller target, never a sensor FPS certification', () => {
  const exp = experiment(); exp.deviceRuns = [frame(0, '0', '1000000000'), frame(1, '232', '6000000000')];
  const analysis = analyzeVisionCameraStreamEvidence(exp, { expectedFps: 30, tolerancePercent: 5, minimumDurationSeconds: 2 });
  assert.equal(analysis.status, 'observed_frame_id_rate'); assert.equal(analysis.groups.length, 1);
  assert.equal(analysis.groups[0].frameIdRatePerSecond, 46.4); assert.equal(analysis.groups[0].targetComparison?.withinTolerance, false);
  assert.equal(analysis.groups[0].targetComparison?.source, 'caller_target_not_vendor_verified');
  assert.equal(analysis.actualSensorFpsVerified, false); assert.equal(analysis.groups[0].longTermStabilityVerified, false);
});

test('duplicate/reversed IDs and timestamps invalidate differences rather than silently dropping samples', () => {
  for (const [id, ts, reason] of [[0, '2000000000', 'duplicate_frame_id'], [1, '2000000000', 'frame_id_reversed'], [3, '1000000000', 'duplicate_timestamp'], [3, '900000000', 'timestamp_reversed']] as const) {
    const exp = experiment(); exp.deviceRuns = [frame(0, id === 0 ? 0 : 2, '1000000000'), frame(1, id, ts)];
    const group = analyzeVisionCameraStreamEvidence(exp).groups[0];
    assert.equal(group.status, 'unqualified'); assert.ok(group.reasons.includes(reason)); assert.equal(group.frameIdRatePerSecond, undefined);
  }
});

test('missing timestamp/timebase/hash/restart and short windows remain explicitly unqualified', () => {
  const exp = experiment(); exp.deviceRuns = [frame(0, 0, undefined), frame(1, 30, '2000000000')];
  assert.ok(analyzeVisionCameraStreamEvidence(exp).groups.some(group => group.reasons.includes('frame_id_or_timestamp_missing')));
  exp.deviceRuns = [frame(0, 0, '1000000000', { timestampSource: undefined, pipelineEpoch: undefined }), frame(1, 30, '2000000000', { timestampSource: undefined, pipelineEpoch: undefined })];
  const group = analyzeVisionCameraStreamEvidence(exp, { expectedFps: 30 }).groups[0];
  assert.ok(group.reasons.includes('timestamp_source_missing')); assert.ok(group.reasons.includes('restart_epoch_unrecorded')); assert.equal(group.targetComparison?.withinTolerance, null);
  exp.deviceRuns = [frame(0, 0, '1000000000'), frame(1, 3, '1100000000')];
  assert.ok(analyzeVisionCameraStreamEvidence(exp).groups[0].reasons.includes('observation_duration_insufficient'));
  exp.deviceRuns[0].evidence.result = { evidence: { frameId: 0, sdkTimestampNs: '1000000000', timestampSource: 'sdk-vsync', pipelineEpoch: 0 } };
  assert.ok(analyzeVisionCameraStreamEvidence(exp).groups[0].reasons.includes('configuration_hash_missing'));
});

test('different hashes, profiles, epochs and faults cannot be combined into a long observation, even when filtering run IDs', () => {
  const exp = experiment();
  const a = frame(0, 0, '1000000000'), b = frame(1, 30, '2000000000'); b.evidence.result = { ...(b.evidence.result as object), tuningHash: 'b'.repeat(64) };
  exp.deviceRuns = [a, b, frame(2, 60, '3000000000')]; assert.equal(analyzeVisionCameraStreamEvidence(exp).groups.length, 3);
  exp.deviceRuns = [a, run(1, 'capture_frame', { sdkCode: -43 }, 'failed'), frame(2, 60, '3000000000')];
  let analysis = analyzeVisionCameraStreamEvidence(exp, { runIds: ['device-0', 'device-2'] });
  assert.equal(analysis.groups.length, 2); assert.ok(analysis.groups.every(group => group.sampleCount === 1)); assert.equal(analysis.boundaries[0].reason, 'saved_operation_failed');
  exp.deviceRuns = [a, frame(1, 30, '2000000000', { pipelineEpoch: 1 })]; assert.equal(analyzeVisionCameraStreamEvidence(exp).groups.length, 2);
  exp.deviceRuns = [a, { ...frame(1, 30, '2000000000'), sensorModel: 'other-sensor' }]; assert.equal(analyzeVisionCameraStreamEvidence(exp).groups.length, 2);
});

test('owned AI receipts are accepted separately; precomputed untrusted FPS and client sample inputs are rejected', () => {
  const exp = experiment(); const debug = ai('completed');
  debug.operations = [0, 1].map(index => ({ operationId: 'POST /api/device/capture_frame', jobId: 'job-' + index, status: 'completed', createdAt: run(index, 'capture_frame').createdAt,
    receipt: { tuningHash: hash, evidence: { frameId: index * 30, sdkTimestampNs: String((index + 1) * 1e9), timestampSource: 'sdk-vsync', pipelineEpoch: 0 } } }));
  exp.aiDebugRuns.push(debug);
  assert.equal(analyzeVisionCameraStreamEvidence(exp, { runIds: [debug.id] }).groups[0].frameIdRatePerSecond, 30);
  exp.deviceRuns.push(run(2, 'capture_frame', { fps: 999, metrics: { measuredFps: 999 } }));
  assert.equal(analyzeVisionCameraStreamEvidence(exp).groups.length, 1);
  assert.throws(() => analyzeVisionCameraStreamEvidence(exp, { samples: [{ frameId: 1 }] } as never), /options_invalid/);
  for (const input of [{ expectedFps: NaN }, { expectedFps: Infinity }, { expectedFps: 0 }, { tolerancePercent: -1 }, { minimumDurationSeconds: 0 }, { runIds: ['unknown'] }]) assert.throws(() => analyzeVisionCameraStreamEvidence(exp, input));
});
