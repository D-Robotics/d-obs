import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dispatch } from './server.mjs';
import { guideCourse } from './guide.mjs';
import { plan } from './course.mjs';
import { studioConfig } from './studio-config.mjs';
import { startWorkbench } from './workbench.mjs';
import { writeWorkbenchState } from './workbench-state.mjs';
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

test('station changes require the active workbench and the local session key',async t=>{
  let active=true;
  const changed=[];
  const view=await startWorkbench({elapsedMinutes:140},0,undefined,{stationKind:'original',
    isActiveStation:async()=>active,lastStation:async()=>false,
    stationActions:async action=>{changed.push(action);active=false;return 'http://127.0.0.1:1234/';}});
  t.after(()=>new Promise(resolve=>view.server.close(resolve)));
  const url=new URL(view.url);
  const route=new URL('/station/new',url);
  const headers={'X-Workshop-Session':url.hash.slice(1)};
  assert.equal((await fetch(route,{method:'POST'})).status,404);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,Origin:'http://example.invalid'}})).status,404);
  const attempts=await Promise.all([fetch(route,{method:'POST',headers}),fetch(route,{method:'POST',headers})]);
  assert.deepEqual(attempts.map(response=>response.status).sort(),[200,409]);
  assert.deepEqual(changed,['new']);
  const inactive=await fetch(new URL('/session',url),{method:'POST',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({patch:{elapsedMinutes:10}})});
  assert.equal((await inactive.json()).error,'station_inactive');
  assert.equal((await (await fetch(new URL('/session',url),{headers})).json()).resume.elapsedMinutes,140);
});

test('camera status reports the workbench binding and its blocked preflight before any capture',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workshop-camera-status-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const worker=fileURLToPath(new URL('./workbench-session.mjs',import.meta.url));
  const scope=createHash('sha256').update(worker+'|persistent-workbench').digest('hex').slice(0,32);
  const directory=join(root,scope);
  await mkdir(directory);
  let checks=0;
  const experimentId=randomUUID();
  const view=await startWorkbench({},0,{async preflight(binding,report) {
    assert.equal(binding.experimentId,experimentId);
    checks++;
    report('service',{status:'passed'});
    report('board',{status:'blocked',code:'vision_device_history_capacity'});
  }});
  t.after(()=>new Promise(resolve=>view.server.close(resolve)));
  await writeFile(join(directory,'session-learner-isp-v6'),view.url);
  const entry=fileURLToPath(new URL('./server.mjs',import.meta.url));
  async function cameraStatus() {
    const child=promisify(execFile)(process.execPath,[entry],{env:{...process.env,RDK_VISION_COURSE_SESSION_DIR:root}});
    child.child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'vision_course_camera_status'}})+'\n');
    const {stdout}=await child;
    const {result}=JSON.parse(stdout);
    assert.equal(result.isError,false);
    return JSON.parse(result.content[0].text);
  }
  const unbound=await cameraStatus();
  assert.deepEqual(unbound.cameraBinding,{source:'workbench',status:'unbound',experimentId:null});
  assert.equal(unbound.latestPreflight,null);
  view.update({camera:{experimentId}});
  const bound=await cameraStatus();
  assert.deepEqual(bound.cameraBinding,{source:'workbench',status:'bound',experimentId});
  assert.equal(bound.capture,undefined);
  assert.equal(bound.baselineRequested,false);
  assert.equal(checks,0);
  const url=new URL(view.url);
  const response=await fetch(new URL('/camera/preflight',url),{method:'POST',body:'{}',
    headers:{'X-Workshop-Session':url.hash.slice(1),'Content-Type':'application/json'}});
  assert.equal(response.status,202);
  const blocked=await cameraStatus();
  assert.deepEqual(blocked.cameraBinding,bound.cameraBinding);
  assert.equal(blocked.latestPreflight.checks.board.code,'vision_device_history_capacity');
  assert.equal(blocked.latestPreflight.checks.frame.status,'waiting');
  assert.equal(checks,1);
});

test('Studio previews only the requested archived photo and preserves it after a failed retake',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workshop-chat-photo-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const worker=fileURLToPath(new URL('./workbench-session.mjs',import.meta.url));
  const scope=createHash('sha256').update(worker+'|persistent-workbench').digest('hex').slice(0,32);
  const directory=join(root,scope);
  const mediaDir=join(root,'agent-downloads');
  const experimentId=randomUUID();
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcX8AAAAASUVORK5CYII=','base64');
  const photo={id:randomUUID(),mimeType:'image/png',byteLength:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex')};
  let complete,fail=false,corrupt=false;
  const captureWait=new Promise(resolve=>{complete=resolve;});
  const view=await startWorkbench({camera:{experimentId}},0,{
    async capture() {
      if(fail) throw new Error('camera_service_error');
      await captureWait;
      return photo;
    },
    async captureFile(binding,kind,asset) {
      assert.equal(binding.experimentId,experimentId);
      assert.equal(kind,'photo');
      assert.deepEqual(asset,photo);
      return {type:photo.mimeType,bytes:corrupt?Buffer.alloc(bytes.length):bytes};
    },
  });
  t.after(()=>new Promise(resolve=>view.server.close(resolve)));
  await mkdir(directory);
  await writeFile(join(directory,'session-learner-isp-v6'),view.url);
  const entry=fileURLToPath(new URL('./server.mjs',import.meta.url));
  async function call(name,args,dir=mediaDir) {
    const child=promisify(execFile)(process.execPath,[entry],{env:{...process.env,
      RDK_VISION_COURSE_SESSION_DIR:root,RDK_VISION_COURSE_STUDIO_MEDIA_DIR:dir}});
    child.child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');
    const {result}=JSON.parse((await child).stdout);
    assert.equal(result.isError,false);
    return JSON.parse(result.content[0].text);
  }
  const status=(photoRequestId,dir)=>call('vision_course_camera_status',{photoRequestId},dir);
  const first=await call('vision_course_camera',{action:'photo'});
  const id=first.capture.photoRequestId;
  assert.equal((await status(id)).photoPreview,'pending');
  complete();
  const delivered=await status(id);
  assert.equal(delivered.photoPreview,'ready');
  assert.equal(delivered.__type,'studio_local_preview');
  assert.equal(delivered.fileName,'相机实拍.png');
  const savedFile='workshop-photo-'+photo.sha256+'.png';
  assert.equal(delivered.imageUrl,'/api/local-files/'+savedFile);
  assert.deepEqual(await readFile(join(mediaDir,savedFile)),bytes);
  assert.equal((await status(id,'')).photoPreview,'studio_media_unavailable');
  corrupt=true;
  assert.equal((await status(id)).photoPreview,'preview_unavailable');
  fail=true;
  const second=await call('vision_course_camera',{action:'photo'});
  assert.notEqual(second.capture.photoRequestId,id);
  assert.equal((await status(id)).photoPreview,'request_changed');
  const failed=await status(second.capture.photoRequestId);
  assert.equal(failed.photoPreview,'capture_failed');
  assert.equal(failed.imageUrl,undefined);
  assert.deepEqual(await readFile(join(mediaDir,savedFile)),bytes);
});

test('Studio serves a selected ISP pair and a verified detection frame with its scores',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workshop-chat-evidence-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const entry=fileURLToPath(new URL('./server.mjs',import.meta.url));
  const worker=fileURLToPath(new URL('./workbench-session.mjs',import.meta.url));
  const scope=createHash('sha256').update(worker+'|persistent-workbench').digest('hex').slice(0,32);
  const directory=join(root,scope);
  const mediaDir=join(root,'agent-downloads');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const experimentId=randomUUID();
  const model='a'.repeat(64),original='b'.repeat(64),changed='c'.repeat(64);
  const photos=[Buffer.from('archived-before'),Buffer.from('archived-after')];
  const [before,after]=photos.map((bytes,index)=>({id:randomUUID(),mimeType:'image/png',byteLength:bytes.length,
    sha256:digest(bytes),tuningHash:index?changed:original}));
  const pair={number:1,before,after,beforeReadback:{hash:original}};
  const resume={camera:{experimentId},evidence:{x5_model_hash:'sha256:'+model}};
  const stateFile=join(root,'state.json');
  writeWorkbenchState(stateFile,{resume,submission:'idle',cameraIsp:{experimentId,
    rounds:[{...pair,gammaReadback:{hash:changed}}],
    adjustments:[{...pair,label:'曝光时间',beforeValue:30,afterValue:24,unit:'ms',afterReadback:{hash:changed}}]}});
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]);
  const report={schema:'rdk.vision-course-board.v1',classes:['park','qrcode','obstacle'],status:'completed',modelSha256:model,tuningHash:changed,
    frames:[{file:'frame-00001.jpg',phase:'after',modelSha256:model,tuningHash:changed,sdkTimestampNs:'101',
      imageSha256:digest(jpeg),forwardMs:32,detections:[{class:'obstacle',score:0.91},{class:'obstacle',score:0.8}]}]};
  const old=process.env.RDK_VISION_COURSE_BOARD_ARCHIVE;
  process.env.RDK_VISION_COURSE_BOARD_ARCHIVE=root;
  t.after(()=>{if(old===undefined) delete process.env.RDK_VISION_COURSE_BOARD_ARCHIVE;else process.env.RDK_VISION_COURSE_BOARD_ARCHIVE=old;});
  let corruptAfter=false;
  const view=await startWorkbench(resume,0,{async captureFile(binding,kind,asset) {
    assert.equal(binding.experimentId,experimentId);
    assert.equal(kind,'isp');
    return {type:'image/png',bytes:asset.id===before.id?photos[0]:corruptAfter?photos[0]:photos[1]};
  }},{stateFile});
  t.after(()=>new Promise(resolve=>view.server.close(resolve)));
  await mkdir(directory);
  await writeFile(join(directory,'session-learner-isp-v6'),view.url);
  async function call(name,args={}) {
    const child=promisify(execFile)(process.execPath,[entry],{env:{...process.env,
      RDK_VISION_COURSE_SESSION_DIR:root,RDK_VISION_COURSE_STUDIO_MEDIA_DIR:mediaDir}});
    child.child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})+'\n');
    const {result}=JSON.parse((await child).stdout);
    assert.equal(result.isError,false);
    return JSON.parse(result.content[0].text);
  }
  const gamma=await call('vision_course_isp_status',{round:1});
  assert.equal(gamma.ispPreview,'ready');
  assert.match(gamma.comparison.caption,/Gamma.*cccccccccccc/);
  assert.deepEqual(await readFile(join(mediaDir,gamma.imageUrl.split('/').at(-1))),photos[0]);
  assert.deepEqual(await readFile(join(mediaDir,gamma.comparison.imageUrl.split('/').at(-1))),photos[1]);
  const learner=await call('vision_course_isp_status',{trial:1});
  assert.match(learner.comparison.caption,/曝光时间 30 → 24 ms/);
  assert.equal((await call('vision_course_isp_status',{round:2})).ispPreview,'no_verified_pair');
  corruptAfter=true;
  const corrupt=await call('vision_course_isp_status',{round:1});
  assert.equal(corrupt.ispPreview,'preview_unavailable');
  assert.equal(corrupt.imageUrl,undefined);
  assert.equal((await call('vision_course_detection_status')).error,'board_receipt_pending');
  await writeFile(join(root,'receipt.json'),JSON.stringify(report));
  await writeFile(join(root,'frame-00001.jpg'),jpeg);
  const result=await call('vision_course_detection_status');
  assert.equal(result.detectionPreview,'ready');
  assert.match(result.fileName,/obstacle × 2（最高 91\.0%）/);
  assert.equal(result.frame.sdkTimestampNs,'101');
  assert.deepEqual(await readFile(join(mediaDir,result.imageUrl.split('/').at(-1))),jpeg);
  await writeFile(join(root,'frame-00001.jpg'),photos[0]);
  assert.equal((await call('vision_course_detection_status')).detectionPreview,'preview_unavailable');
});

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
