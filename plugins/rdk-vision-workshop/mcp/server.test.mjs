import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from './server.mjs';
import { guideCourse } from './guide.mjs';
import { plan } from './course.mjs';
import { studioConfig } from './studio-config.mjs';
import { startWorkbench } from './workbench.mjs';
import { steps } from './steps.mjs';

const intro={group_and_target_identified:'目标与工位记录'};
const camera={plugin_tools_available:'工具检查',current_device_identity:'probe-id',fresh_camera_image:'image.png',original_snapshot:'baseline.json'};
const data={label_schema:'labels',grouped_split:'split',dataset_version:'dataset-sha'};
const baseline={baseline_images:'固定机位',baseline_raw:'raw-1',baseline_isp:'isp.png',baseline_render:'display.png'};
const own={run_id:'run-19',completed_checkpoint:'checkpoint',validation_prediction:'prediction',onnx_contract:'io',checker_report:'checker',calibration_manifest:'calibration',x5_model_hash:'sha256:'+'b'.repeat(64)};
const disconnected={vision_device_transport_failed:'observed-probe-unreachable'};
const running={id:'run-19',state:'running',receipt:'robogo-receipt'};
const external={...running,source:'external',state:'artifact_ready'};
const next=input=>guideCourse(plan,input);
const rpc=(name,args={})=>dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});

test('Feishu clock is contiguous, with early submission overlapping baseline and a separate deployment cutoff',()=>{
  assert.equal(plan.totalMinutes,180);
  assert.deepEqual(plan.deadlines,{submitStart:45,submitBy:50,runCheckpoint:120,deployAt:130,deliverAt:160,perBoardMinutes:2});
  assert.equal(plan.schedule.at(-1).end,180);
  for (let k=1;k<plan.schedule.length;k++) assert.equal(plan.schedule[k-1].end,plan.schedule[k].start);
  assert.equal(plan.parallel.find(s=>s.id==='train').start,plan.schedule.find(s=>s.id==='baseline').start);
  assert.deepEqual(plan.training.classes,['park','qrcode','obstacle']);
});

test('submits once during baseline, then advances with the original run running in the background',()=>{
  const evidence={...intro,...camera,...data};
  assert.equal(next({elapsedMinutes:40,evidence}).nextStep.stageId,'baseline');
  assert.equal(next({elapsedMinutes:45,evidence:{...evidence,...baseline}}).nextStep.stageId,'train');
  const runningResult=next({elapsedMinutes:49,evidence:{...evidence,...baseline},run:running});
  assert.equal(runningResult.nextStep.stageId,'formats');
  assert.equal(runningResult.training.state,'running');
  assert.equal(runningResult.resume.evidence.run_id,'run-19');
  const gamma=next({elapsedMinutes:68,evidence:{...runningResult.resume.evidence,format_observation:'RAW formats'},run:running});
  assert.equal(gamma.nextStep.stageId,'gamma_demo');
  assert.equal(gamma.training.id,'run-19');
  assert.throws(()=>next({evidence:{run_id:'different-run'},run:running}),/run_receipt_mismatch/);
});

test('samples carry an explicit RAW gap, and personal blind review follows tea break',()=>{
  const evidence={...intro,...camera,...baseline,format_observation:'Formats',gamma_decision:'保留原值',gamma_readback:'Getter',
    gamma_fresh_frame:'B.png',trial_readback:'Getter 2',trial_fresh_frame:'B2.png',trial_decision:'看不出改善'};
  delete evidence.baseline_raw;
  assert.deepEqual(next({elapsedMinutes:42,evidence}).nextStep.requiredEvidence.map(x=>x.key),['baseline_raw']);
  evidence.baseline_raw_sample='相机 RAW 实采受阻，样例 RAW-1';
  assert.equal(next({elapsedMinutes:105,evidence,run:running}).nextStep.stageId,'break');
  const blind=next({elapsedMinutes:110,evidence,run:running});
  assert.equal(blind.nextStep.stageId,'blind');
  assert.ok(blind.completion.unfinished.includes('本人 Bayer RAW 实采'));
  assert.equal(next({elapsedMinutes:115,evidence:{...evidence,blind_review:'原始'},run:running}).nextStep.stageId,'reproduce');
});

test('at the deployment deadline, A needs completed own artifacts, B requires a preset, C records a demo',()=>{
  const evidence={...intro,...camera,...data,...own,preset_model:'class sha256:'+'a'.repeat(64)};
  const route=next({elapsedMinutes:130,evidence,run:running});
  assert.equal(route.nextStep.stageId,'route');
  assert.equal(route.routing.recommended,'B');
  assert.equal(route.routing.choices[0].available,false);
  const ready=next({elapsedMinutes:130,evidence,run:external});
  assert.equal(ready.routing.recommended,'A');
  const late=next({elapsedMinutes:130,evidence:intro,blockers:disconnected});
  assert.equal(late.routing.recommended,'C');
  const demo=next({elapsedMinutes:135,evidence:{...intro,demo_reference:'approved-demo.mp4',demo_viewed:'viewing-notes'},
    blockers:disconnected,path:'C'});
  assert.equal(demo.nextStep.requiredEvidence[0].key,'device_unused');
  assert.equal(demo.completion.learnerBoardEvidenceRecorded,false);
});

test('11:30 preflight stays visible during ISP and route selection opens at 11:40',async()=>{
  const fill=id=>Object.fromEntries(steps[id].fields.map(key=>[key,'receipt']));
  const evidence={...intro,...camera,...baseline,...data,...fill('formats'),...fill('gamma_demo'),...fill('gamma_trial'),...fill('blind')};
  const late={...running,etaMinute:150,checkedAtMinute:120};
  const checking=next({elapsedMinutes:120,evidence,run:late});
  assert.equal(checking.nextStep.stageId,'reproduce');
  assert.equal(checking.training.preflight,'prepare_backup');
  assert.equal(checking.training.etaMinute,150);
  assert.equal(checking.routing.eligible,false);
  assert.equal(next({elapsedMinutes:120,evidence,run:running}).training.preflight,'due');
  const ready={...evidence,...own,...fill('reproduce')};
  const before=next({elapsedMinutes:129,evidence:ready,run:external});
  assert.equal(before.nextStep.stageId,'await_route');
  assert.equal(before.routing.eligible,false);
  const view=await startWorkbench(before.resume);
  try {
    assert.throws(()=>view.update({path:'A'}),/route_not_open/);
    assert.equal(view.update({elapsedMinutes:130,path:'A'}).resume.path,'A');
  } finally {await new Promise(resolve=>view.server.close(resolve));}
});

test('original Studio resume retains real software records and invalidates fresh device evidence',()=>{
  const r=next({evidence:{...intro,...camera,...data,...own,live_detections:'old-picture'},blockers:disconnected});
  assert.equal(r.nextStep.stageId,'connect');
  assert.equal(r.resume.evidence.x5_model_hash,own.x5_model_hash);
  assert.equal(r.resume.evidence.original_snapshot,camera.original_snapshot);
  assert.ok(r.evidenceToRecheck.includes('live_detections'));
  assert.ok(!Object.hasOwn(r.resume.evidence,'fresh_camera_image'));
  const restoring=next({elapsedMinutes:160,evidence:{...intro,...camera,...own,restoration_and_release:'old'},
    blockers:{recovery_unconfirmed:'failed-restore'},path:'A'});
  assert.equal(restoring.nextStep.kind,'recovery');
  assert.equal(restoring.completion.recoveryConfirmedInRecord,false);
});

test('running the model and finding the target are independent, and preset evidence stays separate',()=>{
  const fill=id=>Object.fromEntries(steps[id].fields.map(key=>[key,'fixture']));
  const evidence={...intro,...camera,...own,...fill('reproduce'),...fill('deploy'),...fill('live'),
    board_model_hash:own.x5_model_hash,inference_result:'运行成功',target_result:'未检出',preset_model:'备用 .bin'};
  assert.equal(next({elapsedMinutes:145,evidence,path:'A',run:external}).completion.learnerBoardEvidenceRecorded,true);
  const {independent_readback,...withoutReproduction}=evidence;
  const technicalRun=next({elapsedMinutes:145,evidence:withoutReproduction,path:'A',run:external}).completion;
  assert.equal(technicalRun.modelChainEvidenceRecorded,true);
  assert.equal(technicalRun.lessonEvidenceComplete,false);
  assert.ok(technicalRun.unfinished.includes('重载自己的 tuning'));
  assert.ok(!technicalRun.unfinished.includes('本工位部署与实时检测'));
  assert.equal(next({elapsedMinutes:145,evidence,path:'B'}).completion.learnerBoardEvidenceRecorded,false);
  const unobserved={...evidence,target_result:'未验证'};
  const pending=next({elapsedMinutes:145,evidence:unobserved,path:'A',run:external});
  assert.equal(pending.completion.learnerBoardEvidenceRecorded,false);
  assert.ok(pending.nextStep.requiredEvidence.some(row=>row.key==='target_result'));
  const failed={...evidence,inference_result:'运行失败',target_result:'未验证'};
  assert.equal(next({elapsedMinutes:145,evidence:failed,path:'A'}).completion.learnerBoardEvidenceRecorded,false);
  assert.throws(()=>next({evidence:{...failed,target_result:'未检出'}}),/invalid_detection_results/);
});

test('native MCP validates inputs and exposes the workbench through its registered loopback route',async()=>{
  const bad=await rpc('vision_course_next',{passed:true});
  assert.equal(bad.result.isError,true);
  const step=JSON.parse((await rpc('vision_course_stage',{stageId:'live'})).result.content[0].text).stage;
  assert.ok(step.requiredEvidence.some(k=>k.key==='tuning_in_detection_pipeline'));
  const policy=studioConfig().mcpServers['rdk-vision-workshop'].permissions;
  assert.equal(policy.tools.vision_course_view,'readonly');
  assert.equal(policy.tools.vision_course_camera,'approval');
  assert.equal(policy.tools.vision_course_camera_status,'readonly');
  assert.equal(policy.tools.vision_course_preflight,'readonly');
  const invalidPreflight=await rpc('vision_course_preflight',{run:'yes'});
  assert.equal(invalidPreflight.result.isError,true);
  assert.equal(policy.default,'deny');
  const view=await startWorkbench({evidence:intro,elapsedMinutes:130});
  try {
    const url=new URL(view.url);
    assert.equal(url.hostname,'127.0.0.1');
    const generic=await (await fetch(new URL('/course.json',url))).json();
    assert.ok(!generic.resume);
    const selected=new URL('/course.json',url);
    selected.searchParams.set('view',url.hash.slice(1));
    const actual=await (await fetch(selected)).json();
    assert.equal(actual.resume.elapsedMinutes,130);
    assert.match(await (await fetch(url)).text(),/从相机出图到板端检测/);
    const endpoint=new URL('/session',url);
    assert.equal((await fetch(endpoint)).status,404);
    const headers={'X-Workshop-Session':url.hash.slice(1),'Content-Type':'application/json'};
    view.update({run:running});
    const sync=await(await fetch(endpoint,{headers})).json();
    assert.equal(sync.revision,1);
    assert.equal(sync.resume.run.id,running.id);
    const recorded=await fetch(endpoint,{headers,method:'POST',body:JSON.stringify({patch:{evidence:{preset_model:'来源与哈希'}}})});
    assert.equal((await recorded.json()).revision,2);
    assert.equal(view.read().resume.evidence.preset_model,'来源与哈希');
    assert.throws(()=>view.update({run:{...running,id:'other-run'}}),/run_receipt_mismatch/);
    assert.equal((await fetch(endpoint,{headers:{...headers,Origin:'https://other.example'},method:'POST',body:'{}'})).status,405);
  } finally {await new Promise(resolve=>view.server.close(resolve));}
});
