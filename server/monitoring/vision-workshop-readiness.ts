/** Read-only projections of saved evidence. No SDK execution or hardware certification. */
import type { VisionExperiment, VisionDeviceRun } from './vision-workshop-service.js';
import type { VisionDeviceProfile, VisionDeviceOperation } from './vision-workshop-device.js';
import type { VisionCalibrationTask } from './vision-workshop-calibration.js';
import { VISION_AI_DEBUG_REQUIRED_OPERATIONS } from './vision-workshop-experience.js';

export type VisionRecoveryStatus = { status: 'not_recorded' | 'confirmed' | 'unconfirmed'; streamVerification: 'verified' | 'unverified' | 'failed'; runId?: string; reason?: string; source?: 'saved-device-probe'; probeRunId?: string;
  probeState?: { cleanupRequired: boolean; writeOutcome: 'unconfirmed' | 'idle' | 'unknown'; recoveryOriginalHash?: string };
  relatedFailures?: Array<{ runId: string; streamVerification: 'failed'; restorationError?: string }> };
export interface VisionReadinessStage {
  id: 'connection' | 'pipeline' | 'baseline' | 'samples' | 'isp' | 'calibration' | 'evaluation' | 'delivery';
  status: 'unavailable' | 'configured' | 'observed' | 'failed' | 'pending' | 'available';
  reason: string; missingOperations: string[]; evidenceIds: string[];
}
export function visionRecoveryStatus(experiment: VisionExperiment): VisionRecoveryStatus {
  const probe = experiment.deviceRuns.findLast(run => run.operation === 'probe' && run.status === 'completed');
  const probeFence = savedProbeFenceReason(probe);
  if (probeFence) {
    const facts = savedResult(probe)?.facts as Record<string, unknown>;
    const originalHash = typeof facts.recoveryOriginalHash === 'string' && /^[a-f0-9]{64}$/.test(facts.recoveryOriginalHash) ? facts.recoveryOriginalHash : undefined;
    return { status: 'unconfirmed', streamVerification: 'unverified', source: 'saved-device-probe', probeRunId: probe!.id, reason: probeFence,
      probeState: { cleanupRequired: facts.cleanupRequired === true, writeOutcome: facts.writeOutcome === 'unconfirmed' ? 'unconfirmed' : facts.writeOutcome === 'idle' ? 'idle' : 'unknown', ...(originalHash ? { recoveryOriginalHash: originalHash } : {}) },
      relatedFailures: experiment.aiDebugRuns.filter(run => run.final?.streamVerification === 'failed').map(run => ({ runId: run.id, streamVerification: 'failed' as const, ...(run.restorationError ? { restorationError: run.restorationError } : {}) })) };
  }
  const terminal = experiment.aiDebugRuns.filter(run => !['queued', 'running'].includes(run.status));
  const blocking = [...terminal].reverse().find(run => run.final?.streamVerification === 'failed' || run.restorationError || run.original && (
    run.status === 'interrupted' || ['failed', 'canceled'].includes(run.status)) && !(
      run.final?.restored && run.final.hash === run.original.hash && !run.restorationError));
  if (blocking) return { status: 'unconfirmed', streamVerification: blocking.final?.streamVerification || 'unverified', runId: blocking.id, reason: blocking.final?.streamVerification === 'failed' ? 'vision_ai_debug_stream_recovery_required' : 'vision_ai_debug_recovery_required' };
  const latest = terminal.at(-1);
  const streamVerification = latest?.final?.streamVerification || 'unverified';
  if (latest?.final?.hash && !latest.restorationError && latest.final.hash === (latest.final.restored ? latest.original?.hash : latest.best?.hash)) return { status: 'confirmed', streamVerification, runId: latest.id, reason: 'saved_configuration_readback_confirmed' };
  return { status: 'not_recorded', streamVerification, ...(latest ? { runId: latest.id } : {}) };
}

function savedResult(run?: VisionDeviceRun): Record<string, unknown> | undefined {
  const result = run?.evidence.result;
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

function savedProbeFenceReason(run?: VisionDeviceRun): string | undefined {
  if (run?.operation !== 'probe') return undefined;
  const facts = savedResult(run)?.facts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
  const probeFacts = facts as Record<string, unknown>;
  if (probeFacts.cleanupRequired === true) return 'camera_stream_cleanup_required';
  if (probeFacts.writeOutcome === 'unconfirmed') return 'isp_write_unconfirmed_restore_required';
  return undefined;
}

function savedFailureReason(run?: VisionDeviceRun): string | undefined {
  if (!run) return undefined;
  const result = savedResult(run);
  const facts = result?.facts && typeof result.facts === 'object' && !Array.isArray(result.facts) ? result.facts as Record<string, unknown> : undefined;
  const probeFence = savedProbeFenceReason(run);
  if (probeFence) return probeFence;
  if (run.operation === 'probe' && facts?.nativeSdkAvailable === false) return 'native_sdk_runtime_unavailable';
  if (['bringup', 'pipeline_validate'].includes(run.operation) && result?.passed === false) return 'camera_stream_validation_failed';
  return run.status === 'failed' ? ['capture_frame', 'preview_start', 'preview_frame'].includes(run.operation) ? 'camera_stream_capture_failed' : 'saved_operation_failed' : undefined;
}

export function buildVisionWorkshopReadiness(experiment: VisionExperiment, profiles: readonly VisionDeviceProfile[], modelConfigured: boolean, calibrationTasks: readonly VisionCalibrationTask[] = []) {
  const profile = profiles.find(entry => entry.id === experiment.targetId);
  const identityMatches = Boolean(profile && ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'].every(key => experiment[key as keyof VisionExperiment] === profile[key as keyof VisionDeviceProfile]));
  const recovery = visionRecoveryStatus(experiment);
  const active = experiment.aiDebugRuns.some(run => ['queued', 'running'].includes(run.status));
  const missing = VISION_AI_DEBUG_REQUIRED_OPERATIONS.filter(operation => operation === 'controls_set'
    ? !profile?.operations.includes('controls_set') && !profile?.operations.includes('apply_tuning')
    : !profile?.operations.includes(operation));
  const probeFailure = savedFailureReason(experiment.deviceRuns.filter(run => run.operation === 'probe').at(-1));
  const reason = !profile ? 'vision_device_adapter_required' : !identityMatches ? 'vision_device_profile_mismatch' : recovery.status === 'unconfirmed' ? recovery.reason : active ? 'vision_device_busy' : probeFailure ? probeFailure : missing.length ? 'vision_ai_debug_atomic_unavailable' : !modelConfigured ? 'vision_model_disabled' : undefined;
  const stages: VisionReadinessStage[] = [];
  const stage = (id: VisionReadinessStage['id'], required: VisionDeviceOperation[], records: VisionDeviceRun[], observedReason: string, pendingReason: string) => {
    const absent = required.filter(operation => !profile?.operations.includes(operation)); const latest = records.at(-1);
    const failure = savedFailureReason(latest);
    stages.push({ id, status: failure ? 'failed' : latest?.status === 'completed' ? 'observed' : absent.length ? 'unavailable' : 'configured', reason: failure || (latest?.status === 'completed' ? observedReason : pendingReason), missingOperations: absent, evidenceIds: latest ? [latest.id] : [] });
  };
  stage('connection', ['probe'], experiment.deviceRuns.filter(run => run.operation === 'probe'), 'device_service_probe_saved_camera_unverified', 'device_connection_requires_probe');
  stage('pipeline', ['bringup', 'pipeline_validate', 'capture_frame'], experiment.deviceRuns.filter(run => ['bringup', 'pipeline_validate', 'capture_frame', 'preview_start', 'preview_frame'].includes(run.operation)), 'pipeline_receipt_saved_live_state_unverified', 'camera_stream_requires_execution');
  if (recovery.source === 'saved-device-probe') {
    const pipeline = stages.find(entry => entry.id === 'pipeline')!;
    pipeline.status = 'failed'; pipeline.reason = recovery.reason!; pipeline.evidenceIds = [recovery.probeRunId!];
  }
  stages.push({ id: 'baseline', status: experiment.baseline ? 'observed' : 'pending', reason: experiment.baseline ? 'baseline_saved_sdk_load_unverified' : 'restorable_baseline_required', missingOperations: [], evidenceIds: experiment.baseline ? [experiment.baseline.id] : [] });
  const assets = [...experiment.samples, ...experiment.cameraFrames];
  stages.push({ id: 'samples', status: assets.length ? 'observed' : 'pending', reason: experiment.samples.length ? 'raw_assets_saved_acquisition_and_quality_unverified' : experiment.cameraFrames.length ? 'video_frames_saved_not_bayer_raw' : 'actual_sample_required', missingOperations: [], evidenceIds: assets.slice(-16).map(asset => asset.id) });
  const ispRecords = experiment.deviceRuns.filter(run => ['tuning_get', 'tuning_load', 'calibration_apply', 'apply_tuning', 'restore_tuning', 'process_raw'].includes(run.operation));
  const latestIsp = ispRecords.at(-1);
  const result = latestIsp?.evidence.result;
  const receipt = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
  const matched = profile?.operations.includes('tuning_get') && latestIsp?.status === 'completed' && typeof receipt?.readbackHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.readbackHash) && (receipt.appliedHash === undefined || receipt.appliedHash === receipt.readbackHash);
  stages.push({ id: 'isp', status: latestIsp?.status === 'failed' ? 'failed' : matched ? 'observed' : profile?.operations.includes('tuning_get') ? 'configured' : 'unavailable', reason: latestIsp?.status === 'failed' ? 'saved_operation_failed' : matched ? 'sdk_readback_saved_scope_and_quality_unverified' : 'native_isp_runtime_qualification_required', missingOperations: ['capture_raw', 'process_raw', 'tuning_get'].filter(operation => !profile?.operations.includes(operation as VisionDeviceOperation)), evidenceIds: latestIsp ? [latestIsp.id] : [] });
  const calibration = [...calibrationTasks].sort((a,b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
  stages.push({ id: 'calibration', status: calibration?.status === 'completed' ? 'observed' : calibration?.status === 'failed' || calibration?.status === 'interrupted' ? 'failed' : 'pending', reason: calibration?.status === 'completed' ? 'cpu_calibration_computed_sdk_application_unverified' : calibration?.status === 'failed' || calibration?.status === 'interrupted' ? 'saved_calibration_failed' : 'recorded_calibration_inputs_required', missingOperations: [], evidenceIds: calibration ? [calibration.id] : [] });
  stages.push({ id: 'evaluation', status: experiment.evaluations.length || experiment.comparisons.length ? 'observed' : 'pending', reason: experiment.evaluations.length || experiment.comparisons.length ? 'evaluation_saved_full_quality_acceptance_unverified' : 'actual_image_evaluation_required', missingOperations: [], evidenceIds: [...experiment.evaluations, ...experiment.comparisons].slice(-16).map(entry => entry.id) });
  stages.push({ id: 'delivery', status: 'available', reason: 'experiment_export_available_assets_verified_on_download', missingOperations: [], evidenceIds: [] });
  return { contract: 'rdk.vision-workshop-readiness.v1', experimentId: experiment.id, evidenceSource: 'persisted-experiment', target: { configured: Boolean(profile), ...(experiment.targetId ? { id: experiment.targetId } : {}), identityMatches }, model: { configured: modelConfigured }, aiDebug: { canStart: !reason, missingOperations: missing, ...(reason ? { reason } : {}) }, recovery, stages, hardwareVerification: 'unverified', qualityVerification: 'unverified' };
}
