import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBoardLauncher} from './board-launcher.mjs';
import {startWorkbench} from './workbench.mjs';
import {steps} from './steps.mjs';

const hashA='a'.repeat(64);
const hashB='b'.repeat(64);
const experimentId='2dd7c9bf-bcf9-48f0-89bf-14c0b1c747a4';
const selection={path:'A',modelHash:hashA,experimentId,available:true};
const fixture=`
const fs=require('node:fs');
const path=require('node:path');
const sha=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
const dir=process.env.RDK_COURSE_RUN_ARCHIVE,id=process.env.RDK_COURSE_RUN_ID;
const modelSha256=process.env.RDK_COURSE_MODEL_SHA256;
const config={modules:{gamma:{example:42}}};
const tuningHash=sha(JSON.stringify(config));
const file=(name,b)=>fs.writeFileSync(path.join(dir,name),b);
file('loaded-isp.json',JSON.stringify({readbackHash:tuningHash,config}));
const frames=[1,2,3].map(i=>{
  const fileName='frame-0000'+i+'.jpg';
  const jpeg=Buffer.from([255,216,i,255,217]);
  file(fileName,jpeg);
  return {file:fileName,imageSha256:sha(jpeg),sdkTimestampNs:String(i),phase:'live',
    forwardMs:33,tuningHash,modelSha256,detections:[]};
});
const receipt={runId:id,schema:'rdk.vision-course-board.v1',modelSha256,
  classes:['park','qrcode','obstacle'],status:'started',tuningHash,frames,
  staticBpu:{detections:[{class:'obstacle',score:.92}]},restoration:'no_write'};
function record() {
  file('temporary',JSON.stringify(receipt));
  fs.renameSync(path.join(dir,'temporary'),path.join(dir,'receipt.json'));
}
record();
setTimeout(()=>{receipt.status='completed';receipt.previewStopped=true;record();},600);
`;

async function configure(t) {
  const directory=await mkdtemp(join(tmpdir(),'course-board-launcher-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=join(directory,'launcher.json');
  const profile=modelSha256=>({executable:process.execPath,args:['-e',fixture],modelSha256});
  await writeFile(config,JSON.stringify({archiveRoot:directory,experimentId,profiles:{A:profile(hashA),B:profile(hashB)}}),{mode:0o600});
  return config;
}

test('the station binds A and B separately, blocks concurrent camera users and retains the completed archive',async t=>{
  const config=await configure(t);
  const launcher=createBoardLauncher(config);
  const peer=createBoardLauncher(config);
  const preset={...selection,path:'B',modelHash:hashB};
  assert.equal(launcher.status({...selection,path:'C'}).ready,false);
  assert.equal(launcher.status({...selection,modelHash:hashB}).reason,'board_launcher_model_unbound');
  assert.equal(launcher.status({...selection,experimentId:undefined}).reason,'board_launcher_camera_unbound');
  assert.equal(launcher.status({...selection,cameraBusy:true}).reason,'board_launcher_camera_busy');
  assert.throws(()=>launcher.start(selection,'approved'),/board_launcher_isp_unavailable/);
  assert.throws(()=>launcher.start(selection,'comparison'),/board_launcher_comparison_unavailable/);
  const launch=launcher.start(selection);
  assert.equal(launch.run.state,'running');
  assert.throws(()=>launcher.start(selection),/board_launcher_running/);
  assert.throws(()=>peer.start(preset),/board_launcher_locked/);
  assert.equal(peer.evidence(preset),undefined);
  const archive=launcher.evidence(selection);
  let view;
  for(let attempt=0;attempt<25&&!view;attempt++) {
    await delay(20);
    try {view=(await archive.get(hashA)).view;} catch(error) {
      assert.match(error.message,/board_receipt_pending/);
    }
  }
  assert.equal(view.runId,launch.run.id);
  const previous=view.assets.find(asset=>asset.file==='frame-00001.jpg').sha256;
  const update=await archive.preview(hashA,previous,true);
  assert.deepEqual(update.frames.map(item=>item.frame.sdkTimestampNs),['2','3']);
  for(let attempt=0;attempt<60&&launcher.running();attempt++) await delay(25);
  assert.equal(launcher.status(selection).run.state,'completed');
  assert.equal(peer.status(selection).run.id,launch.run.id);
  assert.equal(peer.status(preset).ready,true);
});

test('launch is keyed to the classroom and rejects cross-origin instructions',async t=>{
  const config=await configure(t);
  const old=process.env.RDK_VISION_COURSE_BOARD_LAUNCHER;
  process.env.RDK_VISION_COURSE_BOARD_LAUNCHER=config;
  t.after(()=>{if(old===undefined) delete process.env.RDK_VISION_COURSE_BOARD_LAUNCHER; else process.env.RDK_VISION_COURSE_BOARD_LAUNCHER=old;});
  const evidence=Object.fromEntries(['intro','connect','quantize'].flatMap(id=>steps[id].fields.map(field=>[field,'fixture'])));
  const workbench=await startWorkbench({elapsedMinutes:135,camera:{experimentId},path:'A',
    evidence:{...evidence,x5_model_hash:hashA},run:{source:'external',id:'fixture-run',state:'artifact_ready',receipt:'Fixture'}});
  t.after(()=>new Promise(resolve=>workbench.server.close(resolve)));
  const base=new URL(workbench.url);
  const route=new URL('/board/launch',base);
  const headers={'X-Workshop-Session':base.hash.slice(1)};
  assert.equal((await fetch(route,{method:'POST'})).status,404);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,Origin:'http://example.invalid'}})).status,404);
  assert.equal((await (await fetch(route,{headers})).json()).ready,true);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,'X-Workshop-ISP-Mode':'untrusted'}})).status,409);
  const noScene=await fetch(route,{method:'POST',headers:{...headers,'X-Workshop-ISP-Mode':'comparison'}});
  assert.equal((await noScene.json()).error,'board_launcher_comparison_scene_unconfirmed');
});
