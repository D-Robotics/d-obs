/** Pure saved-receipt fixtures. These tests perform no SDK/hardware operations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { buildVisionWorkshopDelivery, visionDeliveryTargets, type VisionAcceptanceRecord } from './vision-workshop-delivery.js';
import type { VisionDeviceRun, VisionExperiment, VisionJsonObject } from './vision-workshop-service.js';
import { VisionWorkshopService } from './vision-workshop-service.js';

const h = (n: number) => n.toString(16).repeat(64);
const at = (n: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, n)).toISOString();
const identity = { board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'explicit-software-fixture', cameraInterface: 'MIPI CSI-2', cameraMode: 'linear-fixture' };
const stream = () => ({ status: 'verified', source: 'x5-hbn-sdk', frameId: '90', sdkTimestampNs: '9000000000' });
const obj = (value: unknown) => value as Record<string, any>;
function run(operation: VisionDeviceRun['operation'], second: number, result: Record<string, unknown>, status: VisionDeviceRun['status'] = 'completed'): VisionDeviceRun {
  return { ...identity, id: randomUUID(), adapterId: 'native-fixture', operation, status, evidence: { result: result as VisionJsonObject }, createdAt: at(second) };
}
function fixture(): VisionExperiment {
  const planId = randomUUID(), frameId = randomUUID();
  const candidate = { status: 'generated_requires_target_validation', artifactRole: 'vendor_effect_library_candidate', sha256: h(1), bindingHash: h(2),
    sourceReadbackHash: h(3), sourceModulesSha256: h(4), templateSha256: h(5), baselineModulesSha256: h(6),
    coverageScope: 'all_modified_normalized_sdk_readable_configuration_fields', contentBase64: 'PRIVATE_BYTES_MUST_NOT_BE_PROJECTED' };
  const receipt = { status: 'target_reload_recorded', candidateSha256: h(1), bindingHash: h(2), sourceReadbackHash: h(3), actualReloadReadbackHash: h(7), actualReloadModulesSha256: h(4),
    source: 'x5-hbn-sdk', streamVerification: stream(), exportSessionId: 'a'.repeat(32), reloadSessionId: 'b'.repeat(32), sessionBoundary: 'native_sdk_pipeline_open', freshSessionObserved: true,
    modeQualifications: { exposure: 'private_evidence_configured', awb: 'private_evidence_configured' }, validationScope: 'public_sdk_modules_normalized_selected_mode_configuration' };
  const record: VisionAcceptanceRecord = { id: randomUUID(), planId, candidateId: 'vendor:' + h(1), imageIds: [frameId], createdAt: at(7), tuningHash: h(7),
    observations: [{ criterionId: 'detail', verdict: 'pass', notes: 'Explicit software fixture observation' }, { criterionId: 'measurement', value: 31 }],
    report: 'Explicit software fixture input; not a calibrated measurement',
    evidenceImages: [{ id: frameId, hash: h(8), tuningHash: h(7), scene: 'fixture-scene', source: 'runner', createdAt: at(6) }],
    recordedBy: h(9), source: 'operator_recorded', measurementAuthenticity: 'unverified', hash: h(9), outcomes: [] };
  return { ...identity, id: randomUUID(), title: 'Delivery contract fixture only', goal: 'No real device or quality qualification', targetId: 'native-fixture',
    baseline: null, baselineHistory: [{ id: randomUUID(), hash: h(0), tuning: { kind: 'x5-hbn-isp-v2', snapshotId: 'PRIVATE_NATIVE_SNAPSHOT' }, rules: [], createdAt: at(0) }],
    candidates: [], samples: [], processedImages: [], evaluations: [], comparisons: [], aiDebugRuns: [], selectedCandidateId: null,
    cameraFrames: [{ ...identity, id: frameId, filename: 'fixture.png', mimeType: 'image/png', hash: h(8), byteLength: 16, width: 2, height: 2,
      adapterId: 'native-fixture', source: 'runner', scene: 'fixture-scene', tuningHash: h(7), verification: 'unverified', createdAt: at(6) }],
    deviceRuns: [run('bringup', 1, { passed: true, baseline: { config: { sha256: h(0) } } }), run('tuning_get', 2, { readbackHash: h(0) }),
      run('tuning_export', 3, { readbackHash: h(3), vendorCandidate: candidate }), run('tuning_load', 4, { readbackHash: h(7), appliedHash: h(7), evidence: { vendorCandidateValidation: receipt } }),
      run('restore_tuning', 8, { readbackHash: h(0), appliedHash: h(0), evidence: { streamVerification: stream() } }), run('probe', 9, { facts: { cleanupRequired: false, writeOutcome: 'idle' } })],
    acceptancePlan: { id: planId, scene: 'fixture-scene', lighting: 'Explicit fixture lighting record', createdAt: at(0), criteria: [
      { id: 'detail', label: 'Detail observation', kind: 'visual', required: true },
      { id: 'measurement', label: 'Recorded measurement', kind: 'measurement', required: true, operator: 'gte', minimum: 30, unit: 'fixture-unit', method: 'External operator-supplied report' }] },
    acceptancePlans: [], acceptanceRecords: [record], vendorArtifacts: [{ id: randomUUID(), filename: 'fixture-vendor.json', hash: h(1), byteLength: 16, bindingHash: h(2), sourceReadbackHash: h(3), createdAt: at(3), artifactRole: 'vendor_effect_library_candidate' }],
    bytesStored: 0, createdAt: at(0), updatedAt: at(9) };
}
function receipt(e: VisionExperiment) { return obj(obj(e.deviceRuns[3].evidence.result).evidence).vendorCandidateValidation; }
function candidate(e: VisionExperiment) { return obj(e.deviceRuns[2].evidence.result).vendorCandidate; }

test('complete target record chain derives readiness without certifying operator quality or exposing native bytes', () => {
  const e = fixture(), result = buildVisionWorkshopDelivery(e);
  assert.equal(result.workshopReady, true); assert.deepEqual(result.blockers, []);
  assert.equal(result.tuning.independentDeployment, 'fresh_session_reload_recorded'); assert.equal(result.restoration.status, 'original_restoration_recorded');
  assert.equal(result.quality.status, 'recorded_pass'); assert.equal(result.quality.independentVerification, 'unverified'); assert.equal(result.qualityVerification, 'unverified'); assert.equal(result.hardwareVerification, 'unverified');
  assert.equal(result.selectedTargetId, 'vendor:' + h(1)); assert.equal(result.targets[0].hash, h(7));
  assert.doesNotMatch(JSON.stringify(result.targets), /PRIVATE_|contentBase64|snapshotId/);
  assert.equal(result.stages.find(stage => stage.id === 'handoff')!.status, 'recorded');
});
test('a generated file or forged role cannot replace actual reload evidence', () => {
  for (const edit of [(e: VisionExperiment) => { e.deviceRuns.splice(3, 1); }, (e: VisionExperiment) => { candidate(e).artifactRole = 'archived_original_library'; },
    (e: VisionExperiment) => { candidate(e).status = 'blocked'; }, (e: VisionExperiment) => { delete candidate(e).bindingHash; }]) {
    const e = fixture(); edit(e); assert.equal(buildVisionWorkshopDelivery(e).workshopReady, false);
  }
  const e = fixture(); e.deviceRuns.splice(3, 1); const target = visionDeliveryTargets(e).find(item => item.source === 'vendor-library')!;
  assert.equal(target.hash, h(3)); assert.equal(target.vendor!.reloadStatus, 'not_recorded');
});
test('only matching native source, hashes, qualifiers, verified frame and SDK session boundary qualify a reload', () => {
  const edits: Array<(r: Record<string, any>) => void> = [r => { r.source = 'sdk-state-fixture'; }, r => { r.candidateSha256 = h(9); }, r => { r.bindingHash = h(9); },
    r => { r.sourceReadbackHash = h(9); }, r => { r.actualReloadReadbackHash = h(9); }, r => { r.actualReloadModulesSha256 = h(9); },
    r => { r.streamVerification.status = 'failed'; }, r => { r.streamVerification.sdkTimestampNs = '0'; }, r => { r.sessionBoundary = 'unqualified_backend_instance'; },
    r => { r.modeQualifications.awb = 'qualification_required'; }, r => { r.modeQualifications.hdr_exposure = 'qualification_required'; }, r => { delete r.modeQualifications.exposure; },
    r => { r.validationScope = 'configured_public_modules_partial'; }];
  for (const edit of edits) { const e = fixture(); edit(receipt(e)); const result = buildVisionWorkshopDelivery(e); assert.equal(result.workshopReady, false); assert.notEqual(result.tuning.independentDeployment, 'fresh_session_reload_recorded'); }
});
test('same-session reload remains distinct even if a boolean claims a fresh session', () => {
  for (const edit of [(r: Record<string, any>) => { r.freshSessionObserved = false; }, (r: Record<string, any>) => { r.reloadSessionId = r.exportSessionId; }]) {
    const e = fixture(); edit(receipt(e)); const result = buildVisionWorkshopDelivery(e);
    assert.equal(result.tuning.independentDeployment, 'target_reload_recorded'); assert.equal(result.workshopReady, false); assert.ok(result.blockers.includes('standalone_tuning_reload_unverified'));
  }
});
test('old, foreign-profile, unbound or copied acceptance frames cannot support delivery', () => {
  const edits: Array<(e: VisionExperiment) => void> = [e => { e.cameraFrames[0].createdAt = at(2); }, e => { e.cameraFrames[0].adapterId = 'other'; },
    e => { e.cameraFrames[0].sdkVersion = 'other'; }, e => { e.cameraFrames[0].tuningHash = h(9); }, e => { e.acceptanceRecords![0].evidenceImages[0].hash = h(9); },
    e => { e.cameraFrames[0].scene = 'another-scene'; }, e => { e.acceptanceRecords![0].evidenceImages[0].source = 'uploaded'; e.cameraFrames = []; }];
  for (const edit of edits) { const e = fixture(); edit(e); assert.equal(buildVisionWorkshopDelivery(e).workshopReady, false); }
});
test('successful reads never erase a manual unconfirmed write or failed stream', () => {
  const e = fixture(); const failed = run('apply_tuning', 10, {}, 'failed'); failed.evidence = { outcome: 'unconfirmed' };
  e.deviceRuns.push(failed, run('tuning_export', 11, {}), run('probe', 12, { facts: { cleanupRequired: false, writeOutcome: 'idle' } }));
  let result = buildVisionWorkshopDelivery(e); assert.equal(result.workshopReady, false); assert.equal(result.recovery.manualFence, true); assert.ok(result.blockers.includes('device_recovery_unconfirmed'));
  e.deviceRuns.push(run('restore_tuning', 13, { readbackHash: h(0), appliedHash: h(0), evidence: { streamVerification: stream() } }));
  result = buildVisionWorkshopDelivery(e); assert.equal(result.recovery.manualFence, false); assert.equal(result.workshopReady, true);
  e.deviceRuns.push(run('pipeline_validate', 14, { passed: false }, 'failed'), run('tuning_get', 15, { readbackHash: h(0) }));
  result = buildVisionWorkshopDelivery(e); assert.equal(result.workshopReady, false); assert.equal(result.recovery.streamBlocked, true);
});
test('saved probe fence persists through reads and successful restoration until a new clean probe', () => {
  const e = fixture(); e.deviceRuns.push(run('probe', 10, { facts: { cleanupRequired: true, writeOutcome: 'unconfirmed' } }), run('tuning_export', 11, {}));
  assert.equal(buildVisionWorkshopDelivery(e).recovery.status, 'unconfirmed');
  e.deviceRuns.push(run('restore_tuning', 12, { readbackHash: h(0), appliedHash: h(0), evidence: { streamVerification: stream() } }));
  assert.equal(buildVisionWorkshopDelivery(e).workshopReady, false);
  e.deviceRuns.push(run('probe', 13, { facts: { cleanupRequired: false, writeOutcome: 'idle' } })); assert.equal(buildVisionWorkshopDelivery(e).workshopReady, true);
});
test('matching original hash without native new-frame evidence or original getter provenance is insufficient', () => {
  for (const edit of [(e: VisionExperiment) => { obj(e.deviceRuns[4].evidence.result).evidence = {}; }, (e: VisionExperiment) => { obj(e.deviceRuns[4].evidence.result).readbackHash = h(9); },
    (e: VisionExperiment) => { obj(e.deviceRuns[0].evidence.result).baseline = {}; obj(e.deviceRuns[1].evidence.result).readbackHash = h(9); },
    (e: VisionExperiment) => { e.deviceRuns.push(run('controls_set', 10, {})); }]) {
    const e = fixture(); edit(e); const result = buildVisionWorkshopDelivery(e); assert.equal(result.workshopReady, false); assert.ok(result.blockers.includes('original_baseline_restore_and_new_frame_required'));
  }
});
test('new threshold versions, failed numbers and missing required observations remain authoritative', () => {
  for (const edit of [(e: VisionExperiment) => { e.acceptancePlan!.id = randomUUID(); }, (e: VisionExperiment) => { e.acceptanceRecords![0].observations[1].value = 29; },
    (e: VisionExperiment) => { e.acceptanceRecords![0].observations.pop(); }]) {
    const e = fixture(); e.acceptanceRecords![0].outcomes = [{ criterionId: 'measurement', met: true }, { criterionId: 'detail', met: true }]; edit(e);
    assert.equal(buildVisionWorkshopDelivery(e).workshopReady, false);
  }
});
test('duplicate export preserves original chain; a new actual reload invalidates old hash/image acceptance', () => {
  const e = fixture(); e.deviceRuns.push(run('tuning_export', 10, structuredClone(obj(e.deviceRuns[2].evidence.result))));
  assert.equal(buildVisionWorkshopDelivery(e).workshopReady, true);
  const later = structuredClone(e.deviceRuns[3]); later.id = randomUUID(); later.createdAt = at(11); obj(later.evidence.result).readbackHash = h(8); obj(later.evidence.result).appliedHash = h(8); obj(obj(later.evidence.result).evidence).vendorCandidateValidation.actualReloadReadbackHash = h(8);
  e.deviceRuns.push(later); const result = buildVisionWorkshopDelivery(e); assert.equal(result.tuning.hash, h(8)); assert.equal(result.quality.status, 'pending'); assert.equal(result.workshopReady, false);
});
test('explicit delivery target is authoritative and an absent explicit ID cannot fall back', () => {
  const e = fixture(); e.deliveryTargetId = 'vendor:' + h(1); assert.equal(buildVisionWorkshopDelivery(e).workshopReady, true);
  e.deliveryTargetId = 'vendor:' + h(9); const result = buildVisionWorkshopDelivery(e); assert.equal(result.selectedTargetId, null); assert.equal(result.workshopReady, false); assert.ok(result.blockers.includes('delivery_target_required'));
});
test('vendor artifact metadata must match the selected file, binding and source snapshot', () => {
  for (const edit of [(e: VisionExperiment) => { e.vendorArtifacts = []; }, (e: VisionExperiment) => { e.vendorArtifacts![0].hash = h(9); },
    (e: VisionExperiment) => { e.vendorArtifacts![0].bindingHash = h(9); }, (e: VisionExperiment) => { e.vendorArtifacts![0].sourceReadbackHash = h(9); }]) {
    const e = fixture(); edit(e); const result = buildVisionWorkshopDelivery(e); assert.equal(result.workshopReady, false); assert.ok(result.blockers.includes('vendor_artifact_archive_required'));
  }
});
test('actual archive store preserves exact JSON bytes across reload and rejects foreign owners or corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vision-vendor-archive-fixture-'));
  try {
    const service = new VisionWorkshopService({ dataDir: directory });
    const experiment = await service.createExperiment('alice', { title: 'Software archive fixture', goal: 'No camera acceptance' });
    const bytes = Buffer.from('{"fixtureOnly":true,"value":17}\n'), input = { bindingHash: h(2), sourceReadbackHash: h(3) };
    const artifact = await service.archiveVendorArtifact('alice', experiment.id, input, bytes);
    const again = await service.archiveVendorArtifact('alice', experiment.id, input, bytes); assert.equal(again.id, artifact.id);
    const restarted = new VisionWorkshopService({ dataDir: directory });
    assert.deepEqual((await restarted.readVendorArtifact('alice', experiment.id, artifact.id)).data, bytes);
    await assert.rejects(restarted.readVendorArtifact('bob', experiment.id, artifact.id));
    await assert.rejects(restarted.archiveVendorArtifact('bob', experiment.id, input, bytes));
    await assert.rejects(restarted.archiveVendorArtifact('alice', experiment.id, { ...input, bindingHash: 'not-a-hash' }, bytes));
    await assert.rejects(restarted.archiveVendorArtifact('alice', experiment.id, input, Buffer.from('[]')));
    await writeFile(join(directory, 'assets', artifact.id + '.json'), Buffer.from('{"corrupt":true}'));
    await assert.rejects(restarted.readVendorArtifact('alice', experiment.id, artifact.id), /制品校验失败/);
    await assert.rejects(restarted.archiveVendorArtifact('alice', experiment.id, input, bytes), /制品校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
