import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VisionWorkshopService } from './vision-workshop-service.js';
import type { VisionDeviceProfile } from './vision-workshop-device.js';
import type { VisionAiDebugRun } from './vision-workshop-ai-debug.js';
import { buildVisionWorkshopReadiness, visionRecoveryStatus } from './vision-workshop-readiness.js';

const profile: VisionDeviceProfile = { id: 'explicit-fixture', label: 'Software fixture', board: 'fixture', sensorModel: 'fixture', sdkVersion: 'fixture', operations: ['probe','bringup','pipeline_validate','controls_get','controls_set','capture_frame','restore_tuning'] };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vision-readiness-')); const service = new VisionWorkshopService({ dataDir: dir });
  const experiment = await service.createExperiment('alice', { title: 'Explicit software readiness fixture', goal: 'No hardware execution', targetId: profile.id, board: profile.board, sensorModel: profile.sensorModel, sdkVersion: profile.sdkVersion });
  return { experiment, cleanup: () => rm(dir, { recursive:true, force:true }) };
}
test('configuration alone never becomes observed pipeline, native ISP or hardware quality readiness', async () => {
  const env = await fixture(); try {
    const readiness = buildVisionWorkshopReadiness(env.experiment, [profile], true);
    assert.equal(readiness.aiDebug.canStart, true, 'admission only means the executor may attempt fresh evidence');
    assert.equal(readiness.stages.find(stage => stage.id === 'connection')?.status, 'configured');
    assert.equal(readiness.stages.find(stage => stage.id === 'pipeline')?.status, 'configured');
    assert.equal(readiness.stages.find(stage => stage.id === 'isp')?.status, 'unavailable');
    assert.equal(readiness.hardwareVerification, 'unverified'); assert.equal(readiness.qualityVerification, 'unverified');
    assert.equal(buildVisionWorkshopReadiness(env.experiment, [], true).aiDebug.reason, 'vision_device_adapter_required');
    assert.equal(buildVisionWorkshopReadiness(env.experiment, [{ ...profile, sdkVersion: 'different' }], true).aiDebug.reason, 'vision_device_profile_mismatch');
  } finally { await env.cleanup(); }
});
test('saved SDK probe or UVC control hashes do not certify live frames or native ISP qualification', async () => {
  const env = await fixture(); try {
    env.experiment.deviceRuns.push({ id: randomUUID(), operation: 'probe', adapterId: profile.id, sensorModel: profile.sensorModel, status: 'completed', evidence: { result: { facts: { nativeSdkAvailable: false } } }, createdAt: new Date().toISOString() });
    env.experiment.deviceRuns.push({ id: randomUUID(), operation: 'restore_tuning', adapterId: profile.id, sensorModel: profile.sensorModel, status: 'completed', evidence: { result: { appliedHash: 'a'.repeat(64), readbackHash: 'a'.repeat(64) } }, createdAt: new Date().toISOString() });
    const result = buildVisionWorkshopReadiness(env.experiment, [profile], true);
    assert.equal(result.stages.find(stage => stage.id === 'connection')?.status, 'failed');
    assert.equal(result.stages.find(stage => stage.id === 'connection')?.reason, 'native_sdk_runtime_unavailable');
    assert.equal(result.aiDebug.canStart, false);
    assert.equal(result.stages.find(stage => stage.id === 'pipeline')?.status, 'configured');
    assert.equal(result.stages.find(stage => stage.id === 'isp')?.status, 'unavailable');
  } finally { await env.cleanup(); }
});
test('failed or interrupted restoration is blocking until the same original snapshot is confirmed', async () => {
  const env = await fixture(); try {
    const hash = 'a'.repeat(64);
    const run: VisionAiDebugRun = { id: randomUUID(), source:'model', tool:'camera_debug_decision', status:'interrupted', goal:'fixture', maxRounds:1, adjustmentCount:0, iterations:[], operations:[], cancelRequested:false, createdAt:'fixture',updatedAt:'fixture', original:{hash,tuning:{fixture:1},controls:{}} };
    env.experiment.aiDebugRuns.push(run);
    assert.equal(visionRecoveryStatus(env.experiment).status, 'unconfirmed');
    assert.equal(buildVisionWorkshopReadiness(env.experiment,[profile],true).aiDebug.reason,'vision_ai_debug_recovery_required');
    run.final = { restored:true, hash, controls:{},visualVerification:'unverified',reason:'operator_restored_original' };
    assert.equal(visionRecoveryStatus(env.experiment).status,'confirmed');
    assert.equal(visionRecoveryStatus(env.experiment).streamVerification,'unverified', 'legacy configuration readback never certifies streaming');
    assert.equal(buildVisionWorkshopReadiness(env.experiment,[profile],true).aiDebug.canStart,true, 'legacy absence of a stream verdict does not create a recovery failure');
    run.restorationError='vision_device_readback_mismatch';
    assert.equal(visionRecoveryStatus(env.experiment).status,'unconfirmed');
    delete run.restorationError; run.final.hash='b'.repeat(64);
    assert.equal(visionRecoveryStatus(env.experiment).status,'unconfirmed');
  } finally { await env.cleanup(); }
});

test('an explicit failed stream remains fenced even with matching restored configuration hashes', async () => {
  const env = await fixture(); try {
    const hash = 'a'.repeat(64);
    const run: VisionAiDebugRun = { id: randomUUID(), source:'model', tool:'camera_debug_decision', status:'completed', goal:'fixture', maxRounds:1, adjustmentCount:0, iterations:[], operations:[], cancelRequested:false, createdAt:'fixture',updatedAt:'fixture', original:{hash,tuning:{fixture:1},controls:{}}, final:{restored:true,hash,controls:{},visualVerification:'unverified',reason:'operator_restored_original',streamVerification:'failed',imageError:'vision_device_sdk_error'} };
    env.experiment.aiDebugRuns.push(run);
    assert.equal(visionRecoveryStatus(env.experiment).status,'unconfirmed');
    assert.equal(visionRecoveryStatus(env.experiment).streamVerification,'failed');
    assert.equal(buildVisionWorkshopReadiness(env.experiment,[profile],true).aiDebug.reason,'vision_ai_debug_stream_recovery_required');
    run.final!.streamVerification='verified'; delete run.final!.imageError;
    assert.equal(visionRecoveryStatus(env.experiment).status,'confirmed');
    assert.equal(buildVisionWorkshopReadiness(env.experiment,[profile],true).aiDebug.canStart,true);
  } finally { await env.cleanup(); }
});

test('completed validation with passed false and later frame failures override prior stream receipts', async () => {
  const env = await fixture(); try {
    const record = (operation: 'pipeline_validate' | 'capture_frame', result: any, status: 'completed' | 'failed' = 'completed') => ({ id: randomUUID(), operation, adapterId: profile.id, sensorModel: profile.sensorModel, status, evidence:{result}, createdAt:new Date().toISOString() });
    env.experiment.deviceRuns.push(record('pipeline_validate',{passed:false,checks:[{name:'actual-current-stream-frame',passed:false}]}));
    let stage = buildVisionWorkshopReadiness(env.experiment,[profile],true).stages.find(stage => stage.id==='pipeline');
    assert.equal(stage?.status,'failed'); assert.equal(stage?.reason,'camera_stream_validation_failed');
    env.experiment.deviceRuns.push(record('pipeline_validate',{passed:true,evidence:{warning:'mipi mclk is not configed',externalSensorClock:true}}));
    stage = buildVisionWorkshopReadiness(env.experiment,[profile],true).stages.find(stage => stage.id==='pipeline');
    assert.equal(stage?.status,'observed', 'a clock configuration warning alone never becomes a hardware failure');
    env.experiment.deviceRuns.push(record('capture_frame',{},'failed'));
    stage = buildVisionWorkshopReadiness(env.experiment,[profile],true).stages.find(stage => stage.id==='pipeline');
    assert.equal(stage?.status,'failed'); assert.equal(stage?.reason,'camera_stream_capture_failed');
  } finally { await env.cleanup(); }
});

test('saved daemon cleanup and unknown write flags fence an experiment without AI history until a new probe clears them', async () => {
  for (const [facts, expectedReason] of [
    [{nativeSdkAvailable:true,cleanupRequired:true,writeOutcome:'idle',streaming:null},'camera_stream_cleanup_required'],
    [{nativeSdkAvailable:true,cleanupRequired:false,writeOutcome:'unconfirmed',streaming:null},'isp_write_unconfirmed_restore_required'],
  ] as const) {
    const env = await fixture(); try {
      const probe = {id:randomUUID(),operation:'probe' as const,adapterId:profile.id,sensorModel:profile.sensorModel,status:'completed' as const,evidence:{result:{facts}},createdAt:new Date().toISOString()};
      env.experiment.deviceRuns.push(probe);
      const readiness = buildVisionWorkshopReadiness(env.experiment,[profile],true);
      assert.equal(readiness.aiDebug.canStart,false); assert.equal(readiness.aiDebug.reason,expectedReason);
      assert.equal(readiness.recovery.status,'unconfirmed'); assert.equal(readiness.recovery.source,'saved-device-probe'); assert.equal(readiness.recovery.probeRunId,probe.id);
      for (const id of ['connection','pipeline']) { const stage=readiness.stages.find(entry=>entry.id===id); assert.equal(stage?.status,'failed');assert.equal(stage?.reason,expectedReason); }
      env.experiment.deviceRuns.push({...probe,id:randomUUID(),status:'failed',evidence:{code:'probe_unavailable'}});
      assert.equal(buildVisionWorkshopReadiness(env.experiment,[profile],true).recovery.status,'unconfirmed','a failed refresh cannot erase the last recorded daemon fence');
      env.experiment.deviceRuns.push({...probe,id:randomUUID(),evidence:{result:{facts:{nativeSdkAvailable:true,cleanupRequired:false,writeOutcome:'idle',streaming:false}}}});
      const cleared=buildVisionWorkshopReadiness(env.experiment,[profile],true);
      assert.equal(cleared.aiDebug.canStart,true); assert.equal(cleared.recovery.status,'not_recorded'); assert.equal(cleared.recovery.streamVerification,'unverified','stopped streaming is neither a failure nor proof of a new frame');
    } finally { await env.cleanup(); }
  }
});
