/** Pure projections of persisted receipts. This module never executes tools or SDK calls. */
import type { VisionExperiment, VisionDeviceRun } from './vision-workshop-service.js';
import type { VisionDeviceProfile, VisionDeviceOperation } from './vision-workshop-device.js';
import type { VisionCalibrationTask } from './vision-workshop-calibration.js';
import { buildVisionWorkshopReadiness } from './vision-workshop-readiness.js';

export type VisionWorkflowSideEffect = 'knowledge' | 'read' | 'device' | 'model' | 'write';
export interface VisionCameraWorkflowAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  requiredEvidence: string[];
  sideEffect: VisionWorkflowSideEffect;
}
const identityKeys = ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const resultOf = (run?: VisionDeviceRun) => record(run?.evidence.result);
const adaptationRequirements = [
  ['vendor-datasheet', 'Obtain the exact vendor/module revision, datasheet and electrical pinout, voltage and power/reset requirements.'],
  ['clock-and-mode', 'Confirm the actual oscillator or input clock, lane count/rate, resolution, frame timing and supported modes against the matching SDK profile.'],
  ['raw-layout', 'Establish Bayer order, bit depth, packing, stride and black/white levels from source and real capture evidence.'],
  ['driver-and-sdk', 'Identify the matching OS/BSP/SDK, sensor driver, device tree and reviewed register initialization/timing tables.'],
  ['typed-schema', 'Bind typed SDK getters/setters, storage types, documented ranges, active modes and independent readback; do not infer vendor fields.'],
  ['build-and-restore', 'Build against matching headers/libraries, run isolated protocol tests, then verify bounded real bringup, original snapshot, write/readback/new-frame recovery and cleanup.'],
  ['quality-evidence', 'Acquire fixed-scene before/candidate/restored images and appropriate real calibration measurements; proxy metrics do not certify SNR, MTF or image quality.'],
] as const;

/** Guidance for an AI/host to call existing typed tools; not an automatic background Run. */
export function buildVisionCameraWorkflow(experiment: VisionExperiment, profiles: readonly VisionDeviceProfile[], modelConfigured: boolean, calibrationTasks: readonly VisionCalibrationTask[] = []) {
  const readiness = buildVisionWorkshopReadiness(experiment, profiles, modelConfigured, calibrationTasks);
  const profile = profiles.find(entry => entry.id === experiment.targetId);
  const nextActions: VisionCameraWorkflowAction[] = [];
  const blockedBy: string[] = [];
  const supports = (operation: VisionDeviceOperation) => Boolean(profile?.operations.includes(operation));
  const action = (tool: string, sideEffect: VisionWorkflowSideEffect, reason: string, requiredEvidence: string[], args: Record<string, unknown> = tool === 'vision_workshop_runtime_status' ? {} : { experimentId: experiment.id }) => nextActions.push({ tool, arguments: args, reason, requiredEvidence, sideEffect });
  const knowledge = () => action('vision_camera_knowledge_search', 'knowledge', 'review_exact_sensor_sources', ['versioned primary sources', 'unverified adaptation gaps'], Object.fromEntries([['board', experiment.board], ['sensorModel', experiment.sensorModel]].filter(([, value]) => typeof value === 'string')));
  const missingAdaptation = profile ? [] : adaptationRequirements.map(([id, requirement]) => ({ id, requirement, status: 'needs_evidence' as const, executed: false }));
  const finish = () => ({ contract: 'rdk.vision-camera-workflow.v1' as const, evidenceSource: 'persisted-experiment' as const, experimentId: experiment.id,
    execution: 'host_guided_existing_tools' as const, automaticExecution: false,
    identity: { ...Object.fromEntries(identityKeys.flatMap(key => experiment[key] === undefined ? [] : [[key, experiment[key]]])), targetId: experiment.targetId ?? null, adapterConfigured: Boolean(profile), identityMatches: readiness.target.identityMatches },
    recovery: readiness.recovery, stages: readiness.stages, blockedBy, nextActions, missingAdaptation,
    hardwareVerification: 'unverified' as const, qualityVerification: 'unverified' as const,
    limitations: ['Saved receipts do not establish current connectivity or long-term stability.', 'New sensor driver/profile generation and deployment are not executed by this workflow.', 'Processed frames and image proxy metrics are not calibrated Bayer RAW or independent quality certification.'] });

  if (readiness.recovery.status === 'unconfirmed') blockedBy.push(readiness.recovery.reason ?? 'restoration_unconfirmed');
  if (!profile) {
    blockedBy.push('vision_device_adapter_required'); knowledge();
    action('vision_workshop_runtime_status', 'read', 'find_an_actual_matching_adapter', ['registered adapter identity', 'implemented typed operations']);
    return finish();
  }
  if (!readiness.target.identityMatches) {
    blockedBy.push('vision_device_profile_mismatch');
    action('vision_workshop_runtime_status', 'read', 'correct_the_experiment_profile_binding_before_device_operations', ['exact board/vendor/sensor/SDK/interface/mode match']);
    return finish();
  }
  const active = experiment.aiDebugRuns.findLast(run => run.status === 'queued' || run.status === 'running');
  if (active) {
    blockedBy.push('vision_device_busy');
    action('vision_ai_debug_status', 'read', 'an_existing_run_owns_the_device', ['current run state and recovery receipt'], { experimentId: experiment.id, runId: active.id });
    action('vision_ai_debug_cancel', 'write', 'cancel_only_if_the_user_intends_to_stop_the_active_run', ['terminal run state', 'independent original hash and new frame'], { experimentId: experiment.id, runId: active.id });
    return finish();
  }
  if (readiness.recovery.status === 'unconfirmed') {
    const readRecovery = () => action('vision_experiment_get', 'read', 'locate_the_durable_original_and_matching_recovery_record_without_replaying_writes', ['durable journal original hash', 'matching saved original snapshot', 'deviceRuns and recovery failure evidence']);
    if (readiness.recovery.source === 'saved-device-probe') {
      const probe = experiment.deviceRuns.find(entry => entry.id === readiness.recovery.probeRunId);
      const facts = record(resultOf(probe).facts);
      if (facts.cleanupRequired === true && !blockedBy.includes('camera_stream_cleanup_required')) blockedBy.push('camera_stream_cleanup_required');
      if (facts.writeOutcome === 'unconfirmed' && !blockedBy.includes('isp_write_unconfirmed_restore_required')) blockedBy.push('isp_write_unconfirmed_restore_required');
      const probeMatches = probe?.adapterId === profile.id && identityKeys.every(key => probe[key] === experiment[key]);
      if (!probeMatches) { blockedBy.push('durable_original_binding_required'); readRecovery(); return finish(); }
      if (facts.cleanupRequired === true) {
        if (supports('preview_stop')) action('vision_camera_preview_stop', 'device', 'explicit_cleanup_must_precede_restoration', ['actual stopped receipt']);
        else { blockedBy.push('missing_operation:preview_stop', 'durable_original_binding_required'); readRecovery(); return finish(); }
      }
      const originalHash = hashOf(facts.recoveryOriginalHash);
      const run = originalHash ? experiment.aiDebugRuns.findLast(entry => entry.original?.hash === originalHash) : undefined;
      if (run?.original && supports('restore_tuning')) {
        action('vision_ai_debug_restore_original', 'write', 'restore_only_the_original_bound_to_the_durable_probe_hash_after_cleanup', ['durable original hash equals saved AI original', 'independent getter', 'new frame', 'cleared recovery fence'], { experimentId: experiment.id, runId: run.id });
      } else if (originalHash && experiment.baseline?.hash === originalHash && supports('restore_tuning')) {
        action('vision_isp_restore', 'write', 'restore_only_the_baseline_bound_to_the_durable_probe_hash_after_cleanup', ['durable original hash equals saved baseline', 'independent full-scope hash', 'new frame', 'cleared recovery fence'], { experimentId: experiment.id, baselineId: experiment.baseline.id });
      } else { blockedBy.push('durable_original_binding_required'); readRecovery(); }
    } else {
      const run = experiment.aiDebugRuns.find(entry => entry.id === readiness.recovery.runId);
      if (run?.original && supports('restore_tuning')) action('vision_ai_debug_restore_original', 'write', 'confirm_the_existing_original_before_new_work', ['original full-scope hash', 'independent getter', 'new frame', 'cleared recovery fence'], { experimentId: experiment.id, runId: run.id });
      else { blockedBy.push('durable_original_binding_required'); readRecovery(); }
    }
    return finish();
  }

  // Evidence order matters: a new start/failure invalidates older downstream steps.
  const runs = experiment.deviceRuns.filter(run => run.adapterId === profile.id && identityKeys.every(key => run[key] === undefined || run[key] === experiment[key]));
  const last = (operation: VisionDeviceOperation) => runs.findLastIndex(run => run.operation === operation);
  const successful = (index: number) => index >= 0 && runs[index].status === 'completed' && resultOf(runs[index]).passed !== false;
  const propose = (operation: VisionDeviceOperation, tool: string, reason: string, evidence: string[], sideEffect: VisionWorkflowSideEffect = 'device') => {
    if (supports(operation)) action(tool, sideEffect, reason, evidence);
    else { blockedBy.push('missing_operation:' + operation); action('vision_workshop_runtime_status', 'read', 'the_adapter_does_not_implement_the_required_operation', [operation + ' implemented by the matching adapter']); }
  };
  const probe = last('probe'); const probeResult = resultOf(runs[probe]); const facts = record(probeResult.facts);
  if (!successful(probe) || facts.nativeSdkAvailable === false || facts.connected === false || facts.online === false) {
    const failure = JSON.stringify(runs[probe]?.evidence ?? {});
    if (facts.nativeSdkAvailable === false || /native_sdk_(?:unavailable|runtime_unavailable)/.test(failure)) {
      blockedBy.push('native_sdk_runtime_unavailable');
      action('vision_workshop_runtime_status', 'read', 'resolve_matching_native_sdk_before_bringup', ['actual SDK/library/version compatibility']);
    } else {
      if (probe >= 0) blockedBy.push(/offline|unreachable|connection|timeout|host_down|transport/i.test(failure) || facts.connected === false || facts.online === false ? 'device_connection_unconfirmed' : 'device_probe_failed');
      propose('probe', 'vision_camera_probe', 'obtain_a_current_saved_connection_receipt', ['adapter identity', 'SDK availability', 'real nonempty facts']);
    }
    return finish();
  }
  const latestStreamFailure = runs.findLastIndex(run => ['bringup', 'pipeline_validate', 'preview_start', 'preview_frame', 'capture_frame'].includes(run.operation) && (run.status === 'failed' || resultOf(run).passed === false));
  const bringup = Math.max(last('bringup'), last('preview_start'));
  if (latestStreamFailure >= bringup && latestStreamFailure >= probe && latestStreamFailure >= 0) {
    blockedBy.push('camera_stream_failure_requires_diagnosis');
    propose('probe', 'vision_camera_probe', 'inspect_stream_failure_before_another_bounded_start', ['last SDK failure stage/code', 'cleanup fence', 'actual current connectivity']);
    return finish();
  }
  if (!successful(bringup) || bringup < probe) {
    propose('bringup', 'vision_camera_bringup', 'start_only_the_already_adapted_driver_and_mode', ['real start checks', 'new frame', 'cleanup receipt']); return finish();
  }
  const pipeline = last('pipeline_validate');
  if (!successful(pipeline) || pipeline < bringup) {
    propose('pipeline_validate', 'vision_pipeline_validate', 'validate_a_new_frame_after_bringup', ['actual-current-stream-frame check', 'frame identity and timestamp']); return finish();
  }
  if (!experiment.baseline) {
    if (supports('tuning_get')) propose('tuning_get', 'vision_isp_tuning_get', 'save_the_actual_typed_sdk_baseline_before_any_adjustment', ['original snapshot', 'full configured scope hash', 'editable bounded rules'], 'read');
    else propose('probe', 'vision_camera_probe', 'obtain_the_adapter_actual_restorable_baseline_after_stream_start', ['getter-derived original configuration', 'actual writable/active controls', 'restoration capability']);
    return finish();
  }
  const capture = last('capture_frame');
  const matchingFrame = experiment.cameraFrames.some(frame => frame.source === 'runner' && frame.adapterId === profile.id && frame.tuningHash === experiment.baseline!.hash && frame.createdAt >= runs[pipeline].createdAt);
  if (!successful(capture) || capture < pipeline || !matchingFrame) {
    propose('capture_frame', 'vision_camera_capture_frame', 'capture_the_current_scene_with_the_saved_baseline', ['real image bytes/hash', 'baseline tuning hash', 'new frame and SDK timestamp']); return finish();
  }
  const completed = experiment.aiDebugRuns.findLast(run => run.status === 'completed' && run.final?.streamVerification === 'verified'
    && run.original?.hash === experiment.baseline!.hash && run.updatedAt >= runs[pipeline].createdAt);
  if (!completed) {
    if (readiness.aiDebug.canStart) action('vision_ai_debug_start', 'model', 'let_the_model_compare_actual_original_best_and_current_images', ['real image inputs', 'actual bounded active controls', 'independent readback', 'restoration/new-frame receipt'], { experimentId: experiment.id, goal: experiment.goal });
    else { blockedBy.push(readiness.aiDebug.reason ?? 'vision_ai_debug_atomic_unavailable'); action('vision_workshop_runtime_status', 'read', 'resolve_the_model_or_atomic_capability_gap', ['configured model', ...readiness.aiDebug.missingOperations]); }
    return finish();
  }
  const wantsCalibration = /标定|校准|calibrat/i.test(experiment.goal);
  if (wantsCalibration) {
    if (!supports('capture_raw') || !supports('tuning_get')) {
      blockedBy.push('calibration_raw_and_native_isp_qualification_required');
      action('vision_calibration_asset_list', 'read', 'inspect_existing_measurements_without_inventing_calibration_inputs', ['real calibration measurements', 'Bayer layout and capture conditions', 'SDK mapping capability']);
    } else {
      const task = [...calibrationTasks].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
      if (task?.status === 'completed') action('vision_calibration_apply_plan', 'read', 'check_the_trusted_result_mapping_before_any_sdk_application', ['trusted task result', 'matching SDK field mapping', 'runtime prerequisites'], { experimentId: experiment.id, taskId: task.id });
      else action('vision_calibration_asset_list', 'read', 'real_measured_assets_are_required_before_creating_or_running_calibration', ['actual input artifacts and hashes', 'recorded illumination/target/exposure conditions']);
    }
    return finish();
  }
  action('vision_workshop_delivery', 'read', 'review_bound_versions_evidence_and_remaining_acceptance_gaps', ['actual final tuning/image hashes', 'recovery confirmation', 'quality limitations']);
  return finish();
}

export interface VisionStreamAnalysisOptions {
  runIds?: string[];
  expectedFps?: number;
  tolerancePercent?: number;
  minimumDurationSeconds?: number;
}
function validateOptions(input: VisionStreamAnalysisOptions) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['runIds', 'expectedFps', 'tolerancePercent', 'minimumDurationSeconds'].includes(key))) throw new Error('vision_stream_analysis_options_invalid');
  if (input.runIds !== undefined && (!Array.isArray(input.runIds) || !input.runIds.length || input.runIds.length > 500 || input.runIds.some(id => typeof id !== 'string' || !id.length || id.length > 100) || new Set(input.runIds).size !== input.runIds.length)) throw new Error('vision_stream_analysis_options_invalid');
  for (const [value, low, high, inclusive] of [[input.expectedFps, 0, 1000, false], [input.tolerancePercent, 0, 100, true], [input.minimumDurationSeconds, 0, 86400, false]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || (inclusive ? value < low : value <= low) || value > high)) throw new Error('vision_stream_analysis_options_invalid');
  }
  return { ...input, tolerancePercent: input.tolerancePercent ?? 10, minimumDurationSeconds: input.minimumDurationSeconds ?? 1 };
}
function unsigned(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) { const n = BigInt(value); if (n <= 18446744073709551615n) return n; }
  return undefined;
}
type StreamEvent = { id: string; runId: string; source: 'deviceRun' | 'aiDebugRun'; createdAt: string; operation: string; failed: boolean; failureReason?: string; profile: string; result: Record<string, unknown>; sequence: number };
type StreamSample = { recordId: string; runId: string; frameId?: bigint; timestampNs?: bigint };
type StreamGroup = { source: StreamEvent['source']; profile: string; configurationHash?: string; pipelineEpoch?: string; timestampSource?: string; boundary: number; samples: StreamSample[] };
const hashOf = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;

/** Analyze only owned persisted receipts, never client-provided samples or precomputed FPS. */
export function analyzeVisionCameraStreamEvidence(experiment: VisionExperiment, input: VisionStreamAnalysisOptions = {}) {
  const options = validateOptions(input); const events: StreamEvent[] = [];
  const ids = new Set<string>(); let sequence = 0;
  for (const run of experiment.deviceRuns) {
    ids.add(run.id);
    events.push({ id: run.id, runId: run.id, source: 'deviceRun', createdAt: run.createdAt, operation: run.operation, failed: run.status === 'failed' || resultOf(run).passed === false,
      profile: JSON.stringify([run.adapterId, ...identityKeys.map(key => run[key] ?? null)]), result: resultOf(run), sequence: sequence++ });
  }
  for (const run of experiment.aiDebugRuns) {
    ids.add(run.id);
    run.operations.forEach((operation, index) => events.push({ id: operation.jobId ?? run.id + ':' + index, runId: run.id, source: 'aiDebugRun', createdAt: operation.createdAt, operation: operation.operationId.split('/').at(-1) ?? '', failed: operation.status === 'failed', profile: JSON.stringify([experiment.targetId, ...identityKeys.map(key => experiment[key] ?? null)]), result: record(operation.receipt), sequence: sequence++ }));
    if (['failed', 'interrupted', 'canceled'].includes(run.status)) events.push({ id: run.id + ':terminal', runId: run.id, source: 'aiDebugRun', createdAt: run.completedAt ?? run.updatedAt, operation: '', failed: true, failureReason: 'saved_ai_run_terminal_failure', profile: JSON.stringify([experiment.targetId, ...identityKeys.map(key => experiment[key] ?? null)]), result: {}, sequence: sequence++ });
  }
  if (options.runIds?.some(id => !ids.has(id))) throw new Error('vision_stream_analysis_unknown_run');
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence);
  const selected = options.runIds ? new Set(options.runIds) : undefined;
  const groups: StreamGroup[] = []; const boundaries: Array<{ recordId: string; reason: string }> = [];
  let boundary = 0; let ignoredRecords = 0;
  const last = new Map<string, { key: string; group: StreamGroup }>();
  const barriers = new Set(['bringup', 'preview_start', 'preview_stop', 'controls_set', 'apply_tuning', 'restore_tuning', 'tuning_load', 'calibration_apply']);
  for (const event of events) {
    if (event.failed || barriers.has(event.operation)) { boundary++; last.clear(); boundaries.push({ recordId: event.id, reason: event.failed ? event.failureReason ?? 'saved_operation_failed' : 'stream_or_configuration_transition' }); }
    if (event.failed || selected && !selected.has(event.runId)) continue;
    const evidence = record(event.result.evidence);
    const frame = Object.hasOwn(evidence, 'frameId') || Object.hasOwn(evidence, 'sdkTimestampNs') ? evidence : record(evidence.streamVerification);
    if (!Object.hasOwn(frame, 'frameId') && !Object.hasOwn(frame, 'sdkTimestampNs')) { ignoredRecords++; continue; }
    const configurationHash = hashOf(event.result.tuningHash) ?? hashOf(event.result.readbackHash) ?? hashOf(evidence.tuningHash) ?? hashOf(frame.tuningHash);
    const rawEpoch = frame.pipelineEpoch ?? evidence.pipelineEpoch ?? event.result.pipelineEpoch ?? frame.restartEpoch ?? evidence.restartEpoch;
    const pipelineEpoch = typeof rawEpoch === 'string' && rawEpoch.length <= 100 ? rawEpoch : typeof rawEpoch === 'number' && Number.isSafeInteger(rawEpoch) && rawEpoch >= 0 ? String(rawEpoch) : undefined;
    const timestampSource = typeof frame.timestampSource === 'string' && frame.timestampSource.trim() && frame.timestampSource.length <= 160 ? frame.timestampSource : undefined;
    const key = JSON.stringify([event.profile, configurationHash, pipelineEpoch, timestampSource, boundary]);
    const channel = event.source + ':' + (event.source === 'aiDebugRun' ? event.runId : event.profile);
    let group = last.get(channel)?.key === key ? last.get(channel)!.group : undefined;
    if (!group) { group = { source: event.source, profile: event.profile, configurationHash, pipelineEpoch, timestampSource, boundary, samples: [] }; groups.push(group); last.set(channel, { key, group }); }
    group.samples.push({ recordId: event.id, runId: event.runId, frameId: unsigned(frame.frameId), timestampNs: unsigned(frame.sdkTimestampNs) });
  }
  const analyzed = groups.map((group, index) => {
    const reasons: string[] = []; const samples = group.samples;
    if (!group.configurationHash) reasons.push('configuration_hash_missing');
    if (group.pipelineEpoch === undefined) reasons.push('restart_epoch_unrecorded');
    if (!group.timestampSource) reasons.push('timestamp_source_missing');
    else if (/host|submitted|replay/i.test(group.timestampSource)) reasons.push('timestamp_is_not_qualified_live_frame_time');
    if (samples.some(sample => sample.frameId === undefined || sample.timestampNs === undefined || sample.timestampNs <= 0n)) reasons.push('frame_id_or_timestamp_missing');
    let validDifferences = true;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (a.frameId !== undefined && b.frameId !== undefined && b.frameId <= a.frameId) { reasons.push(b.frameId === a.frameId ? 'duplicate_frame_id' : 'frame_id_reversed'); validDifferences = false; }
      if (a.timestampNs !== undefined && b.timestampNs !== undefined && b.timestampNs <= a.timestampNs) { reasons.push(b.timestampNs === a.timestampNs ? 'duplicate_timestamp' : 'timestamp_reversed'); validDifferences = false; }
    }
    const first = samples[0], final = samples.at(-1)!;
    const durationSeconds = first.timestampNs !== undefined && final.timestampNs !== undefined && final.timestampNs > first.timestampNs ? Number(final.timestampNs - first.timestampNs) / 1e9 : 0;
    if (samples.length < 2) reasons.push('at_least_two_samples_required');
    if (durationSeconds < options.minimumDurationSeconds) reasons.push('observation_duration_insufficient');
    const canCalculate = samples.length >= 2 && validDifferences && !reasons.includes('frame_id_or_timestamp_missing') && durationSeconds > 0 && first.frameId !== undefined && final.frameId !== undefined;
    const frameIdRatePerSecond = canCalculate ? Number(final.frameId! - first.frameId!) / durationSeconds : undefined;
    const qualified = reasons.length === 0;
    const differencePercent = options.expectedFps !== undefined && frameIdRatePerSecond !== undefined ? (frameIdRatePerSecond - options.expectedFps) / options.expectedFps * 100 : undefined;
    return { id: 'segment-' + (index + 1), source: group.source, profile: JSON.parse(group.profile) as unknown[], configurationHash: group.configurationHash ?? null, pipelineEpoch: group.pipelineEpoch ?? null, timestampSource: group.timestampSource ?? null, boundary: group.boundary,
      status: qualified ? 'frame_id_rate_only' as const : 'unqualified' as const, reasons: [...new Set(reasons)], recordIds: samples.map(sample => sample.recordId), runIds: [...new Set(samples.map(sample => sample.runId))], sampleCount: samples.length, durationSeconds,
      ...(frameIdRatePerSecond === undefined ? {} : { frameIdRatePerSecond }),
      ...(differencePercent === undefined ? {} : { targetComparison: { expectedFps: options.expectedFps!, source: 'caller_target_not_vendor_verified' as const, tolerancePercent: options.tolerancePercent, differencePercent, withinTolerance: qualified ? Math.abs(differencePercent) <= options.tolerancePercent : null } }),
      actualSensorFpsVerified: false, longTermStabilityVerified: false };
  });
  return { contract: 'rdk.vision-camera-stream-analysis.v1' as const, evidenceSource: 'persisted-experiment' as const, experimentId: experiment.id, options,
    status: analyzed.some(group => group.status === 'frame_id_rate_only') ? 'observed_frame_id_rate' as const : analyzed.length ? 'unqualified' as const : 'no_evidence' as const,
    groups: analyzed, boundaries, ignoredRecords, actualSensorFpsVerified: false, hardwareVerification: 'unverified' as const,
    limitations: ['Frame ID differences measure an identifier growth rate, not an independently verified sensor FPS.', 'Clock origin, frame-ID increments and actual sensor timing need matching SDK/driver evidence.', 'Segments never cross saved failures, configuration changes or restart epochs; saved evidence does not establish current connectivity or long-term stability.'] };
}
