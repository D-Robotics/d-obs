import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCameraSource} from './camera-source.mjs';
import {startWorkbench} from './workbench.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fingerprint=value=>hash(JSON.stringify(value));
const copy=structuredClone;

test('Gamma preserves both rounds, gates the next round on decisions and verifies restoration',async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'rdk-course-isp-'));
  const experimentId=randomUUID(),adapterId='x5-fixture';
  const root='/api/ops/observability/vision-workshop/experiments/'+experimentId;
  const original={kind:'x5-hbn-isp-v2',snapshotId:randomUUID(),modules:{gamma:{mode:0,'auto_attr.curve':[0,20,100],
    'manual_attr.curve':[0,21,100]},exposure:{mode:0}}};
  const originalHash=fingerprint(original);
  const ops=[];
  const baselines=new Map(),frames=new Map(),candidates=new Map();
  let current=copy(original),streaming=true,unconfirmed=false,stale=false,rejectOtherModule=true,externalDrift=false,sequence=100,view;
  let latestBaseline;
  let ordinaryCapacity=new Set(),corruptRecovery=false;
  const upstream=createServer(async(req,res)=>{
    const route=req.url.slice(root.length);
    const reply=(body,status=200)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify({ok:status<400,...body}));
    if(req.url===root) return reply({experiment:{id:experimentId,targetId:adapterId,
      cameraFrames:[],deviceRuns:[],baseline:latestBaseline,baselineHistory:[...baselines.values()]}});
    if(route.startsWith('/frames/')) {
      const bytes=frames.get(route.slice(8));
      return bytes?res.writeHead(200,{'Content-Type':'image/png'}).end(bytes):reply({},404);
    }
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    if(route==='/candidates') {
      const tuning=copy(current);
      tuning.modules.gamma['auto_attr.curve']=[0,body.goal.includes('自己的')?38:35,100];
      if(rejectOtherModule) tuning.modules.exposure.mode=1;
      const candidate={id:randomUUID(),source:'model',patches:[{path:'/modules/gamma/auto_attr.curve/1'}],
        frameIds:body.frameIds,tuning,hash:fingerprint(tuning),baselineHash:originalHash,baselineId:baselines.get(originalHash).id};
      candidates.set(candidate.id,candidate);
      if(externalDrift) current.modules.exposure.mode=1;
      return reply({candidate});
    }
    const operation=route.split('/').at(-1);
    ops.push({operation,body});
    if(ordinaryCapacity.has(operation)) return reply({error:'vision_device_history_capacity'},409);
    const deviceRun={id:randomUUID(),adapterId,status:'completed'};
    const complete=(result,asset)=>reply({operation,deviceRun,result,asset});
    if(operation==='probe') return complete({facts:{streaming,cleanupRequired:false,writeOutcome:unconfirmed?'unconfirmed':'idle',
      ...(unconfirmed?{recoveryOriginalHash:originalHash}:{})}});
    if(operation==='tuning_get') {
      if(latestBaseline) current.snapshotId=randomUUID();
      const readbackHash=fingerprint(current);
      if(!baselines.has(readbackHash)) baselines.set(readbackHash,{id:randomUUID(),hash:readbackHash,tuning:copy(current)});
      latestBaseline=baselines.get(readbackHash);
      return complete({baseline:{config:current},readbackHash});
    }
    if(operation==='tuning_export') return complete({config:current,readbackHash:fingerprint(current)});
    if(operation==='capture_frame') {
      const id=randomUUID(),bytes=Buffer.from(id),sha256=hash(bytes);
      frames.set(id,bytes);
      return complete({sha256,evidence:{sdkTimestampNs:String(stale?100:++sequence)}},
        {id,source:'runner',adapterId,hash:sha256,tuningHash:fingerprint(current),width:16,height:16,
          createdAt:new Date().toISOString(),mimeType:'image/png',byteLength:bytes.length});
    }
    if(operation==='apply_tuning') {
      current=copy(candidates.get(body.candidateId).tuning);
      return complete({appliedHash:fingerprint(current),readbackHash:fingerprint(current)});
    }
    if(operation==='restore_tuning') {
      current=copy(baselines.get(originalHash).tuning);
      streaming=true;unconfirmed=false;
      assert.equal(body.baselineId,baselines.get(originalHash).id);
      return complete({appliedHash:originalHash,readbackHash:originalHash,evidence:{config:corruptRecovery?{}:copy(current)}});
    }
    if(operation==='preview_stop') {
      streaming=false;
      return complete({running:false});
    }
    return reply({},404);
  });
  try {
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const secret=join(tmp,'secret'),config=join(tmp,'connection.json'),stateFile=join(tmp,'state.json');
    await writeFile(secret,'fixture-only',{mode:0o600});
    await writeFile(config,JSON.stringify({url:`http://127.0.0.1:${upstream.address().port}/api/ops/vision-workshop/mcp`,
      auth:{type:'admin',credentialFile:secret}}),{mode:0o600});
    const camera=createCameraSource(config);
    view=await startWorkbench({camera:{experimentId}},0,camera,{stateFile});
    const base=new URL(view.url);
    const request=(suffix='',body)=>fetch(new URL('/camera/isp'+suffix,base),{
      headers:{'X-Workshop-Session':base.hash.slice(1),'Content-Type':'application/json'},
      ...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    });
    const perform=async(action,goal,detail={})=>{
      assert.equal((await request('',{action,goal,...detail})).status,202);
      for(let i=0;i<60;i++) {
        const {isp}=await(await request()).json();
        if(!isp.running) return isp;
        await new Promise(resolve=>setTimeout(resolve,15));
      }
      assert.fail('operation did not settle');
    };
    assert.equal((await request('',{action:'restore'})).status,422);
    const saved=await perform('save');
    assert.equal(saved.original.hash,originalHash);
    assert.equal(saved.original.config,undefined);
    assert.equal((await request('',{action:'gamma',goal:'未完成跟做',round:2})).status,422);
    assert.deepEqual((await(await request('?file=original&sha256='+originalHash)).json()).config,original);
    assert.equal((await perform('gamma','看清暗部文字')).error,'camera_gamma_candidate_rejected');
    assert.equal(ops.filter(x=>x.operation==='apply_tuning').length,0);
    rejectOtherModule=false;
    externalDrift=true;
    assert.equal((await perform('gamma','看清暗部文字')).error,'camera_isp_snapshot_changed');
    assert.equal(ops.filter(x=>x.operation==='apply_tuning').length,0);
    externalDrift=false;
    current=copy(original);
    stale=true;
    assert.equal((await perform('gamma','看清暗部文字')).error,'camera_gamma_freshness_failed');
    assert.equal((await request('',{action:'gamma',goal:'再试'})).status,422);
    assert.ok(view.read().resume.blockers.recovery_unconfirmed);
    stale=false;
    streaming=false;
    unconfirmed=true;
    const reverted=await perform('revert');
    assert.equal(reverted.readback.hash,originalHash);
    assert.equal(streaming,true);
    assert.equal(view.read().resume.blockers.recovery_unconfirmed,undefined);
    const trial=await perform('gamma','看清暗部文字');
    assert.equal(trial.stage,'gamma_saved');
    assert.notEqual(trial.gamma.before.id,trial.gamma.after.id);
    assert.equal(trial.gamma.after.tuningHash,trial.gammaReadback.hash);
    assert.equal(view.read().resume.evidence.gamma_decision,undefined);
    assert.throws(()=>view.update({camera:null}),/camera_capture_busy/);
    const keep=await perform('decision',undefined,{round:1,choice:'keep',reason:'暗部更可读'});
    assert.equal(keep.rounds[0].decision.choice,'keep');
    assert.equal(keep.rounds[0].decisionReadback.hash,trial.gammaReadback.hash);
    assert.equal((await request('',{action:'gamma',goal:'原值还未恢复',round:2})).status,422);
    const backToOriginal=await perform('revert');
    assert.ok(backToOriginal.restored.sdkTimestampNs);
    assert.match(view.read().resume.evidence.A1_B_A2,/ · /);
    const second=await perform('gamma','我自己的观察目标',{round:2});
    assert.equal(second.rounds[0].before.id,trial.rounds[0].before.id);
    assert.equal(second.rounds[1].beforeReadback.hash,originalHash);
    assert.notEqual(second.rounds[1].gammaReadback.hash,trial.gammaReadback.hash);
    const firstBytes=await request('?round=1&file=after&sha256='+trial.gamma.after.sha256);
    assert.equal(hash(Buffer.from(await firstBytes.arrayBuffer())),trial.gamma.after.sha256);
    assert.equal((await request('?round=2&file=after&sha256='+trial.gamma.after.sha256)).status,404);
    const declined=await perform('decision',undefined,{round:2,choice:'restore',reason:'亮部细节减少'});
    assert.equal(declined.rounds[1].decisionReadback.hash,originalHash);
    assert.match(view.read().resume.evidence.trial_decision,/恢复原值/);
    assert.equal((await request('',{action:'gamma',goal:'超出课堂额度'})).status,422);
    const reload=await perform('reload');
    assert.equal(reload.stage,'gamma_reloaded');
    assert.equal(reload.reloaded.tuningHash,second.gammaReadback.hash);
    assert.match(view.read().resume.evidence.tuning_reload_frame,/SDK/);
    const stopped=await perform('restore');
    assert.equal(stopped.stage,'stopped');
    assert.equal(stopped.readback.hash,originalHash);
    assert.deepEqual(ops.slice(-3).map(x=>x.operation),['restore_tuning','tuning_export','preview_stop']);
    assert.equal(ops.filter(x=>x.operation==='tuning_get').length,1);
    assert.match(view.read().resume.evidence.restoration_and_release,/停流回执/);
    assert.equal((await perform('restore')).stop.receiptId,stopped.stop.receiptId);
    assert.equal(ops.filter(x=>x.operation==='preview_stop').length,1);
    const snapshot=await(await request('?file=original&sha256='+originalHash)).json();
    const restore=()=>camera.restoreOriginalIsp({experimentId},snapshot,{onPhase:()=>{}});
    for (const denied of ['probe','tuning_export']) {
      await t.test(`history fills at ${denied}, but the reserved restore and stop remain usable`, async()=>{
        ordinaryCapacity=new Set([denied]);
        current=copy(original);
        current.modules.gamma['auto_attr.curve'][1]=73;
        streaming=true;
        const from=ops.length;
        const recovered=await restore();
        const performed=ops.slice(from).map(x=>x.operation);
        assert.deepEqual(performed,denied==='probe'?['probe','restore_tuning','preview_stop']:
          ['probe','tuning_export','restore_tuning','tuning_export','preview_stop']);
        assert.equal(recovered.readback.hash,originalHash);
        assert.equal(recovered.readback.verification,'restore_tuning_sdk_readback');
        assert.deepEqual(recovered.readback.config,original);
        assert.deepEqual(current,original);
        assert.equal(streaming,false);
      });
    }
    await t.test('missing verified SDK bytes cannot be passed off as a successful recovery', async()=>{
      ordinaryCapacity=new Set(['probe']);
      corruptRecovery=true;
      const from=ops.length;
      await assert.rejects(restore(),/camera_isp_restore_unconfirmed/);
      assert.deepEqual(ops.slice(from).map(x=>x.operation),['probe','restore_tuning']);
    });
  } finally {
    if(view) await new Promise(resolve=>view.server.close(resolve));
    await new Promise(resolve=>upstream.close(resolve));
    await rm(tmp,{recursive:true,force:true});
  }
});
