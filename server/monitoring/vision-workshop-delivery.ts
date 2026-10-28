/** Project acceptance records, never an implicit hardware or calibrated-quality certificate. */
import { z } from 'zod';
import type { VisionExperiment, VisionJsonObject, VisionDeviceRun, VisionCameraFrame } from './vision-workshop-service.js';
import { visionRecoveryStatus } from './vision-workshop-readiness.js';

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Control characters are not allowed');
export const visionAcceptanceCriterionInput = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), label: text(160),
  kind: z.enum(['visual', 'measurement']), required: z.boolean(), unit: text(80).optional(),
  operator: z.enum(['lte', 'gte', 'between']).optional(), minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), method: text(1000).optional(),
}).strict().superRefine((criterion, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (criterion.kind === 'visual') {
    if (criterion.operator || criterion.minimum !== undefined || criterion.maximum !== undefined || criterion.unit) bad('Visual criteria cannot claim numerical measurements');
  } else {
    if (!criterion.operator || !criterion.unit || !criterion.method) bad('Measurements require an explicit operator, unit and method');
    if (criterion.operator === 'lte' && (criterion.maximum === undefined || criterion.minimum !== undefined)) bad('lte requires only maximum');
    if (criterion.operator === 'gte' && (criterion.minimum === undefined || criterion.maximum !== undefined)) bad('gte requires only minimum');
    if (criterion.operator === 'between' && (criterion.minimum === undefined || criterion.maximum === undefined || criterion.minimum > criterion.maximum)) bad('between requires ordered minimum and maximum');
  }
});
export const visionAcceptancePlanInput = z.object({ scene: text(120), lighting: text(1000), criteria: z.array(visionAcceptanceCriterionInput).min(1).max(32) }).strict().superRefine((plan, ctx) => {
  if (!plan.criteria.some(item => item.required) || new Set(plan.criteria.map(item => item.id)).size !== plan.criteria.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one required criterion and unique criterion IDs are required' });
});
export const visionAcceptanceRecordInput = z.object({
  planId: z.string().uuid(), candidateId: text(80), imageIds: z.array(z.string().uuid()).min(1).max(8),
  observations: z.array(z.object({ criterionId: text(64), value: z.number().finite().optional(), verdict: z.enum(['pass', 'fail']).optional(), notes: text(2000).optional() }).strict()).min(1).max(32),
  report: text(16000).optional(), notes: text(2000).optional(),
}).strict().superRefine((record, ctx) => {
  if (new Set(record.imageIds).size !== record.imageIds.length || new Set(record.observations.map(item => item.criterionId)).size !== record.observations.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate evidence or criteria are not allowed' });
});
export type VisionAcceptanceCriterion = z.infer<typeof visionAcceptanceCriterionInput>;
export type VisionAcceptancePlan = z.infer<typeof visionAcceptancePlanInput> & { id: string; createdAt: string };
export interface VisionAcceptanceImage { id: string; hash: string; tuningHash?: string; scene?: string; source: 'uploaded' | 'runner'; createdAt: string }
export interface VisionAcceptanceRecord extends z.infer<typeof visionAcceptanceRecordInput> {
  id: string; createdAt: string; tuningHash: string; evidenceImages: VisionAcceptanceImage[];
  recordedBy: string; source: 'operator_recorded'; measurementAuthenticity: 'unverified'; reportSha256?: string; hash: string;
  outcomes: Array<{ criterionId: string; met: boolean | null; value?: number; verdict?: 'pass' | 'fail' }>;
}
interface VisionVendorTarget {
  candidateSha256: string; bindingHash: string; sourceReadbackHash: string; sourceModulesSha256: string;
  templateSha256: string; baselineModulesSha256: string; exportRunId: string; exportCreatedAt: string;
  reloadRunId?: string; reloadCreatedAt?: string; reloadStatus: 'not_recorded' | 'target_reload_recorded' | 'fresh_session_reload_recorded';
}
export interface VisionDeliveryTarget { id: string; label: string; hash: string; source: 'candidate' | 'ai-run' | 'vendor-library'; tuning: VisionJsonObject; createdAt: string; vendor?: VisionVendorTarget }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sessionId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const resultOf = (run?: VisionDeviceRun) => object(run?.evidence.result);
const evidenceOf = (run?: VisionDeviceRun) => object(resultOf(run).evidence);
function matchedDevice(experiment: VisionExperiment, run: VisionDeviceRun): boolean {
  return Boolean(experiment.targetId && experiment.board && experiment.sensorModel && experiment.sdkVersion && run.adapterId === experiment.targetId &&
    (['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'] as const).every(key => run[key] === experiment[key]));
}
function nativeStream(value: unknown): boolean {
  const stream = object(value);
  return stream.status === 'verified' && stream.source === 'x5-hbn-sdk' && typeof stream.frameId === 'string' && /^\d+$/.test(stream.frameId) &&
    typeof stream.sdkTimestampNs === 'string' && /^[1-9]\d*$/.test(stream.sdkTimestampNs);
}
function vendorReload(experiment: VisionExperiment, target: VisionVendorTarget, run: VisionDeviceRun): { fresh: boolean; hash: string } | undefined {
  const result = resultOf(run), receipt = object(evidenceOf(run).vendorCandidateValidation);
  const modes = object(receipt.modeQualifications);
  if (!matchedDevice(experiment, run) || run.operation !== 'tuning_load' || run.status !== 'completed' || run.createdAt <= target.exportCreatedAt ||
    receipt.status !== 'target_reload_recorded' || receipt.candidateSha256 !== target.candidateSha256 || receipt.bindingHash !== target.bindingHash ||
    receipt.sourceReadbackHash !== target.sourceReadbackHash || receipt.actualReloadModulesSha256 !== target.sourceModulesSha256 ||
    !digest(receipt.actualReloadReadbackHash) || receipt.actualReloadReadbackHash !== result.readbackHash || result.appliedHash !== result.readbackHash ||
    receipt.source !== 'x5-hbn-sdk' || !nativeStream(receipt.streamVerification) ||
    receipt.sessionBoundary !== 'native_sdk_pipeline_open' || !sessionId(receipt.exportSessionId) || !sessionId(receipt.reloadSessionId) ||
    modes.exposure !== 'private_evidence_configured' || modes.awb !== 'private_evidence_configured' || Object.values(modes).some(value => value !== 'private_evidence_configured') ||
    typeof receipt.validationScope !== 'string' || !receipt.validationScope.startsWith('public_sdk_modules_normalized_selected_mode_configuration')) return undefined;
  const fresh = receipt.freshSessionObserved === true && receipt.exportSessionId !== receipt.reloadSessionId;
  return { fresh, hash: receipt.actualReloadReadbackHash };
}
export function visionDeliveryTargets(experiment: VisionExperiment): VisionDeliveryTarget[] {
  const candidates: VisionDeliveryTarget[] = experiment.candidates.map(candidate => ({ id: candidate.id, label: candidate.title, hash: candidate.hash, source: 'candidate', tuning: candidate.tuning, createdAt: candidate.createdAt }));
  for (const run of experiment.aiDebugRuns ?? []) if (!['queued', 'running', 'restoring'].includes(run.status) && run.best) candidates.push({ id: 'ai-run:' + run.id, label: run.goal, hash: run.best.hash, source: 'ai-run', tuning: run.best.tuning, createdAt: run.updatedAt });
  const vendors = new Map<string, VisionVendorTarget>();
  for (const run of experiment.deviceRuns ?? []) {
    const metadata = object(resultOf(run).vendorCandidate);
    if (!matchedDevice(experiment, run) || run.operation !== 'tuning_export' || run.status !== 'completed' || metadata.status !== 'generated_requires_target_validation' || metadata.artifactRole !== 'vendor_effect_library_candidate' ||
      !['sha256', 'bindingHash', 'sourceReadbackHash', 'sourceModulesSha256', 'templateSha256', 'baselineModulesSha256'].every(key => digest(metadata[key])) ||
      metadata.coverageScope !== 'all_modified_normalized_sdk_readable_configuration_fields') continue;
    const checksum = metadata.sha256 as string, old = vendors.get(checksum);
    if (old && old.bindingHash === metadata.bindingHash && old.sourceReadbackHash === metadata.sourceReadbackHash && old.sourceModulesSha256 === metadata.sourceModulesSha256) continue;
    vendors.set(checksum, { candidateSha256: checksum, bindingHash: metadata.bindingHash as string, sourceReadbackHash: metadata.sourceReadbackHash as string,
      sourceModulesSha256: metadata.sourceModulesSha256 as string, templateSha256: metadata.templateSha256 as string, baselineModulesSha256: metadata.baselineModulesSha256 as string,
      exportRunId: run.id, exportCreatedAt: run.createdAt, reloadStatus: 'not_recorded' });
  }
  for (const vendor of vendors.values()) {
    let actualHash = vendor.sourceReadbackHash;
    for (const run of experiment.deviceRuns) {
      const reload = vendorReload(experiment, vendor, run);
      if (reload) { actualHash = reload.hash; vendor.reloadRunId = run.id; vendor.reloadCreatedAt = run.createdAt; vendor.reloadStatus = reload.fresh ? 'fresh_session_reload_recorded' : 'target_reload_recorded'; }
    }
    candidates.push({ id: 'vendor:' + vendor.candidateSha256, label: 'Vendor effect-library candidate', hash: actualHash, source: 'vendor-library',
      tuning: { kind: 'vendor_effect_library_candidate', sha256: vendor.candidateSha256, bindingHash: vendor.bindingHash }, createdAt: vendor.reloadCreatedAt ?? vendor.exportCreatedAt, vendor });
  }
  return candidates;
}
export function evaluateVisionAcceptance(plan: VisionAcceptancePlan, input: z.infer<typeof visionAcceptanceRecordInput>): VisionAcceptanceRecord['outcomes'] {
  for (const observation of input.observations) {
    const criterion = plan.criteria.find(item => item.id === observation.criterionId);
    if (!criterion) throw new Error('acceptance_unknown_criterion');
    if (criterion.kind === 'visual' && (!observation.verdict || observation.value !== undefined || !observation.notes)) throw new Error('acceptance_visual_reason_required');
    if (criterion.kind === 'measurement' && (observation.value === undefined || observation.verdict !== undefined || !input.report)) throw new Error('acceptance_measurement_report_required');
  }
  return plan.criteria.map(criterion => {
    const observation = input.observations.find(item => item.criterionId === criterion.id);
    if (!observation) return { criterionId: criterion.id, met: null };
    const met = criterion.kind === 'visual' ? observation.verdict === 'pass' : criterion.operator === 'lte' ? observation.value! <= criterion.maximum! : criterion.operator === 'gte' ? observation.value! >= criterion.minimum! : observation.value! >= criterion.minimum! && observation.value! <= criterion.maximum!;
    return { criterionId: criterion.id, met, ...(observation.value !== undefined ? { value: observation.value } : {}), ...(observation.verdict ? { verdict: observation.verdict } : {}) };
  });
}
function matchedFrame(experiment: VisionExperiment, image: VisionCameraFrame): boolean {
  return image.source === 'runner' && image.adapterId === experiment.targetId &&
    (['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'] as const).every(key => image[key] === experiment[key]);
}
const writes = new Set(['apply_tuning', 'tuning_load', 'controls_set', 'calibration_apply', 'restore_tuning', 'process_raw']);
export function buildVisionWorkshopDelivery(experiment: VisionExperiment) {
  const targets = visionDeliveryTargets(experiment), plan = experiment.acceptancePlan ?? null;
  const selected = experiment.deliveryTargetId !== undefined ? targets.find(target => target.id === experiment.deliveryTargetId) ?? null : targets.find(target => target.id === experiment.selectedCandidateId) ??
    targets.filter(target => target.source === 'vendor-library' && target.vendor?.reloadStatus !== 'not_recorded').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ??
    targets.filter(target => target.source === 'ai-run').at(-1) ?? null;
  const records = experiment.acceptanceRecords ?? [];
  const latest = plan && selected ? records.filter(record => record.planId === plan.id && record.candidateId === selected.id && record.tuningHash === selected.hash).at(-1) ?? null : null;
  const blockers: string[] = [];
  if (!experiment.targetId) blockers.push('device_adapter_required');
  if (!plan) blockers.push('acceptance_plan_required');
  if (!selected) blockers.push('delivery_target_required');
  if (!latest) blockers.push('current_acceptance_record_required');
  const required = plan?.criteria.filter(item => item.required) ?? [];
  if (plan && !required.length) blockers.push('acceptance_required_criteria_missing');
  // Re-evaluate the recorded values against the current saved plan; cached
  // outcome labels never become independent measurement authentication.
  let outcomes: VisionAcceptanceRecord['outcomes'] = [];
  try { if (plan && latest) outcomes = evaluateVisionAcceptance(plan, latest); } catch { blockers.push('acceptance_record_invalid'); }
  const failed = latest ? required.filter(item => outcomes.find(row => row.criterionId === item.id)?.met === false).map(item => item.id) : [];
  const missing = latest ? required.filter(item => !outcomes.some(row => row.criterionId === item.id && row.met !== null)).map(item => item.id) : required.map(item => item.id);
  const sceneMatches = Boolean(latest && latest.evidenceImages.length && latest.evidenceImages.every(image => image.scene === plan?.scene));
  if (latest && !sceneMatches) blockers.push('acceptance_scene_mismatch');
  if (failed.length) blockers.push('acceptance_criteria_failed');
  if (missing.length) blockers.push('acceptance_measurements_missing');
  const recordedPass = Boolean(latest && required.length && sceneMatches && !failed.length && !missing.length && !blockers.includes('acceptance_record_invalid'));
  const runs = experiment.deviceRuns ?? [], recovery = visionRecoveryStatus(experiment);
  const bringup = runs.findLast(run => matchedDevice(experiment, run) && run.operation === 'bringup' && run.status === 'completed' && resultOf(run).passed === true);
  const reload = selected?.vendor?.reloadRunId ? runs.find(run => run.id === selected.vendor!.reloadRunId) : undefined;
  const applied = selected?.source === 'vendor-library' ? reload : selected ? runs.findLast(run => matchedDevice(experiment, run) && ['apply_tuning', 'tuning_load'].includes(run.operation) && run.status === 'completed' && resultOf(run).readbackHash === selected.hash && resultOf(run).appliedHash === selected.hash) : undefined;
  const frame = selected && applied ? experiment.cameraFrames.findLast(image => matchedFrame(experiment, image) && image.tuningHash === selected.hash && image.createdAt > applied.createdAt && image.scene === plan?.scene) : undefined;
  const acceptanceFrameBound = Boolean(latest && frame && latest.evidenceImages.some(image => image.id === frame.id && image.hash === frame.hash && image.tuningHash === selected?.hash));
  if (latest && !acceptanceFrameBound) blockers.push('acceptance_post_reload_frame_required');
  if (!bringup) blockers.push('bringup_evidence_required');
  if (!applied || !frame) blockers.push('applied_config_and_new_frame_required');
  const exportAt = selected?.vendor?.exportCreatedAt ?? applied?.createdAt;
  // Re-anchored baselines supersede older ones; the undo target is the baseline
  // in effect when the candidate was applied, and older layout hashes no longer load.
  const original = [...experiment.baselineHistory].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(base => exportAt && base.createdAt <= exportAt && runs.some(run =>
    matchedDevice(experiment, run) && run.status === 'completed' && ['tuning_get', 'bringup'].includes(run.operation) && run.createdAt <= exportAt &&
    (resultOf(run).readbackHash === base.hash || object(object(resultOf(run).baseline).config).sha256 === base.hash)));
  const restored = original && applied ? runs.findLast(run => matchedDevice(experiment, run) && run.operation === 'restore_tuning' && run.status === 'completed' && run.createdAt > applied.createdAt &&
    resultOf(run).readbackHash === original.hash && resultOf(run).appliedHash === original.hash &&
    (nativeStream(evidenceOf(run).streamVerification) || experiment.cameraFrames.some(image => matchedFrame(experiment, image) && image.tuningHash === original.hash && image.createdAt > run.createdAt))) : undefined;
  const restoredIndex = restored ? runs.indexOf(restored) : -1;
  const lastWriteIndex = runs.findLastIndex(run => matchedDevice(experiment, run) && writes.has(run.operation));
  const originalRestored = Boolean(restored && lastWriteIndex === restoredIndex);
  if (!originalRestored) blockers.push('original_baseline_restore_and_new_frame_required');
  // visionRecoveryStatus retains saved probe/AI fences. Manual failures also
  // persist until a later original restoration, regardless of successful reads.
  const uncertainManualIndex = runs.findLastIndex(run => matchedDevice(experiment, run) && run.status === 'failed' && object(run.evidence).outcome === 'unconfirmed');
  const active = experiment.aiDebugRuns.some(run => ['queued', 'running', 'restoring'].includes(run.status));
  const manualFence = uncertainManualIndex > restoredIndex;
  const streamFailure = runs.findLastIndex(run => matchedDevice(experiment, run) && (
    ['bringup', 'pipeline_validate'].includes(run.operation) && resultOf(run).passed === false ||
    ['capture_frame', 'preview_frame', 'preview_start'].includes(run.operation) && run.status === 'failed' ||
    object(resultOf(run).facts).cleanupRequired === true));
  const lastGoodStream = runs.findLastIndex(run => matchedDevice(experiment, run) && run.status === 'completed' && (
    ['bringup', 'pipeline_validate'].includes(run.operation) && resultOf(run).passed === true || nativeStream(evidenceOf(run).streamVerification)));
  const streamBlocked = recovery.streamVerification === 'failed' || streamFailure > lastGoodStream;
  const recoveryBlocked = recovery.status === 'unconfirmed' || manualFence || active || streamBlocked;
  if (recoveryBlocked) blockers.push('device_recovery_unconfirmed');
  const sessionBound = selected?.tuning.kind === 'x5-hbn-isp-v2';
  const freshReload = selected?.source === 'vendor-library' && selected.vendor?.reloadStatus === 'fresh_session_reload_recorded';
  if (!freshReload) blockers.push('standalone_tuning_reload_unverified');
  const vendorArtifacts = (experiment.vendorArtifacts ?? []).map(({ id, filename, hash, byteLength, bindingHash, sourceReadbackHash, createdAt }) => ({ id, filename, hash, byteLength, bindingHash, sourceReadbackHash, createdAt }));
  const artifact = selected?.vendor ? vendorArtifacts.findLast(item => item.hash === selected.vendor!.candidateSha256 && item.bindingHash === selected.vendor!.bindingHash && item.sourceReadbackHash === selected.vendor!.sourceReadbackHash && item.byteLength > 0) : undefined;
  if (selected?.vendor && !artifact) blockers.push('vendor_artifact_archive_required');
  const tuning = {
    status: !selected ? 'missing' as const : selected.source === 'vendor-library' ? 'vendor_library_candidate' as const : sessionBound ? 'session_bound_configuration' as const : 'configuration_exportable' as const,
    kind: typeof selected?.tuning.kind === 'string' ? selected.tuning.kind : 'unspecified', hash: selected?.hash ?? null,
    independentDeployment: selected?.vendor?.reloadStatus ?? 'unverified' as const,
    ...(selected?.vendor ? { candidateSha256: selected.vendor.candidateSha256, bindingHash: selected.vendor.bindingHash, exportRunId: selected.vendor.exportRunId, reloadRunId: selected.vendor.reloadRunId } : {}),
    ...(artifact ? { artifactId: artifact.id } : {}),
    requiredValidation: ['matched_sdk_format', 'fresh_session_reload', 'independent_readback', 'new_frame', 'restore_original'],
  };
  const workshopReady = blockers.length === 0 && recordedPass && freshReload && originalRestored;
  return {
    contract: 'rdk.vision-workshop.delivery.v1' as const, experimentId: experiment.id,
    targets: targets.map(({ tuning: _tuning, ...target }) => target), selectedTargetId: selected?.id ?? null, vendorArtifacts,
    acceptancePlan: plan, acceptancePlans: experiment.acceptancePlans ?? [], acceptanceRecords: records,
    quality: { status: !plan ? 'not_configured' as const : !latest ? 'pending' as const : !sceneMatches ? 'scene_mismatch' as const : failed.length ? 'recorded_fail' as const : missing.length ? 'incomplete' as const : 'recorded_pass' as const, recordId: latest?.id ?? null, requiredCriteriaMet: recordedPass, failedCriteria: failed, missingCriteria: missing, source: 'operator_recorded' as const, independentVerification: 'unverified' as const },
    tuning, recovery: { ...recovery, manualFence, streamBlocked, active },
    restoration: { status: originalRestored ? 'original_restoration_recorded' as const : 'pending' as const, baselineHash: original?.hash ?? null, runId: restored?.id ?? null },
    stages: [
      { id: 'bringup', status: bringup ? 'recorded' : 'pending', evidenceIds: bringup ? [bringup.id] : [] },
      { id: 'capture', status: frame && acceptanceFrameBound ? 'recorded' : 'pending', evidenceIds: frame ? [frame.id] : [] },
      { id: 'tuning', status: applied ? 'recorded' : 'pending', evidenceIds: applied ? [applied.id] : [] },
      { id: 'evaluation', status: recordedPass && acceptanceFrameBound ? 'recorded' : failed.length ? 'failed' : 'pending', evidenceIds: latest ? [latest.id] : [] },
      { id: 'handoff', status: workshopReady ? 'recorded' : 'pending', evidenceIds: workshopReady && restored && selected?.vendor ? [selected.vendor.exportRunId, applied!.id, restored.id] : [] },
    ], blockers: [...new Set(blockers)], workshopReady, readinessScope: 'project_recorded_acceptance_and_target_reload' as const,
    hardwareVerification: 'unverified' as const, qualityVerification: 'unverified' as const,
  };
}
export type VisionWorkshopDelivery = ReturnType<typeof buildVisionWorkshopDelivery>;
