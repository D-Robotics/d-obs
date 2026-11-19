import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {plan} from './course.mjs';
import {guideCourse} from './guide.mjs';
import {normalizeTrainingJob,trainingProfile} from './robogo.mjs';
import {steps} from './steps.mjs';
import {startWorkbench} from './workbench.mjs';

const fill=(...ids)=>Object.fromEntries(ids.flatMap(id=>steps[id].fields).map(k=>[k,'fixture']));
const digest=value=>createHash('sha256').update(value).digest('hex');
const beforeTraining={elapsedMinutes:46,evidence:fill('intro','connect','baseline','data')};
const ownModel='1'.repeat(64);
const anotherModel='2'.repeat(64);
const run={id:'real-a-fixture',source:'robogo',state:'running',receipt:'fixture'};
const ready=(resume)=>guideCourse(plan,resume).routing.choices.find(p=>p.id==='A').available;

async function session(input,problem,options={}) {
  const app=await startWorkbench(input,0,undefined,options);
  const base=new URL(app.url);
  const http=async(route,opts={})=>{
    const {confirmation,body,method=body===undefined?'GET':'POST'}=opts;
    const h={'X-Workshop-Session':base.hash.slice(1)};
    if(confirmation) h['X-Workshop-Confirmation']=confirmation;
    if(body!==undefined) h['Content-Type']='application/json';
    const r=await fetch(new URL(route,base),{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};
  };
  try {await problem(http);}
  finally {await new Promise(resolve=>app.server.close(resolve));}
}
const post=(http,route,opts={})=>http(route,{method:'POST',...opts});

test('RoboGO A only unlocks with the X5 INT8 hash issued for the same original Run',async()=>{
  const artifact={kind:'int8_model',march:'bayes-e',sha256:ownModel,run_id:run.id};
  const remote={job:{id:run.id,status:'completed',artifacts:[artifact]}};
  const verified=normalizeTrainingJob(remote,run.id);
  assert.equal(verified.modelSha256,ownModel);
  assert.equal(normalizeTrainingJob({job:{...remote.job,artifacts:[{...artifact,run_id:'another-run'}]}},run.id).modelSha256,undefined);
  assert.equal(normalizeTrainingJob({job:{...remote.job,artifacts:[artifact,{...artifact,sha256:anotherModel}]}},run.id).modelSha256,undefined);
  const input={...beforeTraining,elapsedMinutes:130,run:{...verified},
    evidence:{...beforeTraining.evidence,...fill('quantize'),x5_model_hash:'sha256:'+anotherModel}};
  assert.equal(ready(input),false);
  await session(input,async http=>{
    const prior=(await http('/session')).data.resume;
    assert.equal(prior.run.modelSha256,undefined);
    assert.equal((await post(http,'/robogo/refresh')).data.resume.run.modelSha256,ownModel);
    assert.equal(ready((await http('/session')).data.resume),false);
    const forged=await http('/session',{body:{patch:{run:{...verified,modelSha256:anotherModel}}}});
    assert.equal(forged.data.resume.run.modelSha256,ownModel);
    const fixed=await http('/session',{body:{patch:{evidence:{x5_model_hash:'sha256:'+ownModel}}}});
    assert.equal(ready(fixed.data.resume),true);
    const bad=guideCourse(plan,{...fixed.data.resume,path:'A',evidence:{
      ...fixed.data.resume.evidence,...fill('deploy','live'),board_model_hash:'sha256:'+anotherModel,
      inference_result:'运行成功',target_result:'未验证',
    }});
    assert.equal(bad.completion.modelChainEvidenceRecorded,false);
  },{roboGo:{refresh:async()=>verified}});
});

test('RoboGO confirmation uses the actual request and freezes the plan on restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workshop-submission-'));
  t.after(()=>rm(root,{force:true,recursive:true}));
  const profile=join(root,'profile.json');
  const stateFile=join(root,'state.json');
  const old=process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE;
  process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE=profile;
  t.after(()=>{if(old===undefined) delete process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE; else process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE=old;});
  const configuration=(name,epochs=100)=>writeFile(profile,JSON.stringify({input:{name,epochs},display:{name:'untrusted display',epochs:100}}));
  await configuration('one',1);
  await assert.rejects(trainingProfile(),/robogo_profile_invalid/);
  let submitCount=0;
  const cloud={connected:()=>true,prepare:async input=>'plan-'+input.name,
    submit:async ref=>{submitCount++;assert.equal((JSON.parse(await readFile(stateFile,'utf8'))).submission,'pending');return {...run,receipt:ref};}};
  await session({...beforeTraining,blockers:{training_image_unavailable:'等待共享镜像'}},async http=>{
    assert.equal((await http('/robogo/state')).data.profileIssue,'robogo_profile_invalid');
    await configuration('first tab');
    assert.equal((await http('/robogo/state')).data.profileConfigured,true);
    const first=(await post(http,'/robogo/prepare')).data;
    assert.deepEqual(first.parameters,{name:'first tab',epochs:100});
    assert.equal((await http('/session')).data.resume.blockers.training_image_unavailable,undefined);
    await configuration('second tab');
    const second=(await post(http,'/robogo/prepare')).data;
    assert.equal((await post(http,'/robogo/submit',{confirmation:first.confirmationId})).data.error,'robogo_plan_changed');
    assert.equal(submitCount,0);
    const accepted=await post(http,'/robogo/submit',{confirmation:second.confirmationId});
    assert.equal(accepted.data.resume.run.receipt,'plan-second tab');
  },{roboGo:cloud,stateFile});
  await session(beforeTraining,async http=>{
    assert.equal((await http('/session')).data.resume.run.id,run.id);
    assert.equal((await http('/session',{body:{patch:beforeTraining,replace:true}})).data.resume.run.id,run.id);
    assert.equal((await post(http,'/robogo/prepare')).data.error,'robogo_run_exists');
    assert.equal(submitCount,1);
  },{roboGo:cloud,stateFile});

  const uncertainFile=join(root,'uncertain.json');
  const timeout={...cloud,submit:async()=>{throw new Error('network timeout');}};
  await session(beforeTraining,async http=>{
    const prepared=(await post(http,'/robogo/prepare')).data;
    assert.equal((await post(http,'/robogo/submit',{confirmation:prepared.confirmationId})).data.error,'robogo_submit_unconfirmed');
  },{roboGo:timeout,stateFile:uncertainFile});
  await session(beforeTraining,async http=>{
    assert.equal((await post(http,'/robogo/prepare')).data.error,'robogo_submit_unconfirmed');
  },{roboGo:cloud,stateFile:uncertainFile});
});

test('B uses the preset archive; original and restored ISP are bound without Gamma photos',async t=>{
  const root=await mkdtemp(join(tmpdir(),'workshop-board-'));
  t.after(()=>rm(root,{force:true,recursive:true}));
  const old=process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE;
  process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE=root;
  t.after(()=>{if(old===undefined)delete process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE;else process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE=old;});
  const configs=[{gain:1},{gain:2}];
  const [originalHash,loadedHash]=configs.map(x=>digest(JSON.stringify(x)));
  const files={'original-isp.json':{config:configs[0],readbackHash:originalHash},
    'loaded-isp.json':{config:configs[1],readbackHash:loadedHash},'restored-isp.json':{readbackHash:originalHash}};
  const snapshots={};
  for(const [name,value] of Object.entries(files)){
    const bytes=JSON.stringify(value);
    snapshots[name]=digest(bytes);
    await writeFile(join(root,name),bytes);
  }
  await writeFile(join(root,'receipt.json'),JSON.stringify({
    schema:'rdk.vision-course-board.v1',classes:['park','qrcode','obstacle'],status:'completed',modelSha256:ownModel,
    restoration:'verified',tuningHash:loadedHash,ispSnapshots:snapshots,
  }));
  const input={elapsedMinutes:130,path:'B',evidence:{...beforeTraining.evidence,preset_model:'课程预置 sha256:'+ownModel}};
  await session(input,async http=>{
    const board=await http('/board/receipt');
    assert.equal(board.status,200);
    assert.deepEqual(board.data.snapshotNames,Object.keys(files));
    const byName=name=>http('/board/file/'+name+'?receipt='+board.data.receiptSha256);
    for(const name of Object.keys(files)) assert.deepEqual((await byName(name)).data,files[name]);
    await writeFile(join(root,'restored-isp.json'),JSON.stringify({readbackHash:loadedHash}));
    assert.equal((await byName('restored-isp.json')).data.error,'board_asset_integrity_failed');
  });
  await session({...input,evidence:{...input.evidence,preset_model:'别的预置 sha256:'+anotherModel}},async http=>{
    assert.equal((await http('/board/receipt')).data.error,'board_model_mismatch');
  });
});
