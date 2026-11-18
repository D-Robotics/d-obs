import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCameraSource } from './camera-source.mjs';
import { startWorkbench } from './workbench.mjs';

const experimentId='273ec1b7-a1e1-4e27-844b-ab7c7158e2c3';
const otherExperiment='273ec1b7-a1e1-4e27-844b-ab7c7158e2c4';
const beforeId='d9958e79-5369-419f-9e9e-0ea8ced76f01';
const afterId='d9958e79-5369-419f-9e9e-0ea8ced76f02';
const runId='27a61cca-3185-40bf-92cb-f79cf7814105';
const sourceRoute='/api/ops/observability/vision-workshop/experiments';
const original=Buffer.from('original fixture bytes');
const candidate=Buffer.from('candidate fixture bytes');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalHash='a'.repeat(64),candidateHash='b'.repeat(64);
const token='private-fixture-credential-for-camera-source';
const frame=(id,bytes,tuningHash,adapterId='cam-a')=>({id,adapterId,source:'runner',hash:digest(bytes),tuningHash,mimeType:'image/png',byteLength:bytes.length,width:16,height:16});

test('protected workbench reads only bound archive frames and verifies camera readback lineage',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'workshop-camera-test-'));
  let corrupt=false;
  const source=createServer((req,res)=>{
    if(req.headers['x-admin-token']!==token) {res.writeHead(403).end();return;}
    const json=body=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,...body}));
    if(req.url===sourceRoute+'?view=index&limit=30') return json({experiments:[{id:experimentId,title:'Fixture camera'}]});
    if(req.url===sourceRoute+'/'+experimentId) return json({experiment:{id:experimentId,title:'Fixture camera',targetId:'cam-a',
      cameraFrames:[frame(beforeId,original,originalHash),frame(afterId,candidate,candidateHash),frame(otherExperiment,candidate,candidateHash,'another-board')],
      deviceRuns:[{operation:'tuning_get',adapterId:'cam-a',status:'completed',id:'real-readback',evidence:{result:{readbackHash:candidateHash}}},
        {operation:'capture_frame',adapterId:'cam-a',status:'completed',id:'capture',evidence:{result:{sha256:digest(candidate),tuningHash:candidateHash,evidence:{sdkTimestampNs:'1234'}}}},
        {operation:'tuning_get',adapterId:'another-board',status:'completed',id:'wrong-readback',evidence:{result:{readbackHash:originalHash}}}],
      aiDebugRuns:[{id:runId,status:'completed'}]}});
    if(req.url===sourceRoute+'/'+experimentId+'/ai-debug/runs/'+runId) return json({run:{id:runId,source:'model',status:'completed',
      iterations:[{action:'adjust',before:{frameId:beforeId,frameHash:digest(original)},after:{frameId:afterId,frameHash:digest(candidate)},readbackHash:candidateHash}]}});
    if(req.url===sourceRoute+'/'+experimentId+'/frames/'+afterId) return res.writeHead(200,{'Content-Type':'image/png'}).end(corrupt?original:candidate);
    res.writeHead(404).end();
  });
  let view;
  try {
    await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
    const configuration=path.join(temp,'connection.json');
    const secretFile=path.join(temp,'creator');
    await writeFile(secretFile,token,{mode:0o600});
    await writeFile(configuration,JSON.stringify({url:`http://127.0.0.1:${source.address().port}/api/ops/vision-workshop/mcp`,auth:{type:'admin',credentialFile:secretFile}}),{mode:0o600});
    view=await startWorkbench({},0,createCameraSource(configuration));
    const home=new URL(view.url);
    const headers={'X-Workshop-Session':home.hash.slice(1)};
    const get=(route,options={headers})=>fetch(new URL(route,home),options);
    assert.equal((await get('/camera/experiments',{})).status,404);
    assert.deepEqual(await(await get('/camera/experiments')).json(),{experiments:[{id:experimentId,title:'Fixture camera'}]});
    assert.equal((await get('/camera')).status,422);
    view.update({camera:{experimentId,runId}});
    const detail=await(await get('/camera')).json();
    assert.equal(detail.readback.id,'real-readback');
    assert.equal(detail.activeRun.pair.after.id,afterId);
    assert.equal(detail.frames[0].sdkTimestampNs,'1234');
    assert.deepEqual(Buffer.from(await(await get('/camera/frame/'+afterId)).arrayBuffer()),candidate);
    assert.equal((await get('/camera/frame/'+otherExperiment)).status,404);
    corrupt=true;
    assert.deepEqual(await(await get('/camera/frame/'+afterId)).json(),{error:'camera_frame_integrity_failed'});
    view.update({camera:null});
    assert.equal((await get('/camera/frame/'+afterId)).status,422);
  } finally {
    if(view) await new Promise(resolve=>view.server.close(resolve));
    await new Promise(resolve=>source.close(resolve));
    await rm(temp,{recursive:true,force:true});
  }
});

test('three-image capture preserves partial evidence and retries RAW replay without recapturing or writing ISP',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'workshop-baseline-test-'));
  const calls=[];
  const raw=Buffer.alloc(3840*2160*2);
  const rawId='d9958e79-5369-419f-9e9e-0ea8ced76f03';
  const rawAsset={id:rawId,source:'runner',adapterId:'cam-a',hash:digest(raw),byteLength:raw.length,
    metadata:{width:3840,height:2160,bayer:'GBRG',bitDepth:10},createdAt:'2026-11-18T08:00:00Z'};
  const rendered=Buffer.from('render fixture');
  const png=Buffer.from('89504e470d0a1a0a','hex');
  let blocked=true,wrongHash=false;
  const source=createServer(async(req,res)=>{
    const json=(data,status=200)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify({ok:status===200,...data}));
    const binary=(type,data)=>res.writeHead(200,{'Content-Type':type}).end(data);
    if(req.headers['x-admin-token']!==token) return json({},401);
    const prefix=sourceRoute+'/'+experimentId;
    const route=req.url.slice(prefix.length);
    if(req.url===prefix) return json({experiment:{id:experimentId,title:'Fixture camera',targetId:'cam-a',cameraFrames:[],deviceRuns:[]}});
    if(route==='/samples/'+rawId+'/preview.png') return binary('image/png',png);
    if(route==='/samples/'+rawId+'/download') return binary('application/octet-stream',wrongHash?Buffer.alloc(raw.length,1):raw);
    if(route==='/frames/'+beforeId) return binary('image/png',original);
    if(route==='/results/'+afterId) return binary('image/png',rendered);
    if(req.method!=='POST'||!route.startsWith('/device/')) return json({},404);
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const operation=route.slice('/device/'.length);
    calls.push({operation,body});
    const deviceRun={id:'d9958e79-5369-419f-9e9e-'+String(calls.length).padStart(12,'0'),adapterId:'cam-a',status:'completed'};
    if(operation==='capture_raw') return json({operation,deviceRun:{...deviceRun,sampleId:rawId},asset:rawAsset,result:{sha256:rawAsset.hash}});
    if(operation==='capture_frame') {
      const asset=frame(beforeId,original,originalHash);
      return json({operation,deviceRun,asset,result:{sha256:asset.hash}});
    }
    if(operation==='tuning_get') return json({operation,deviceRun,result:{readbackHash:originalHash}});
    if(operation==='process_raw') {
      if(blocked) return json({error:'vision_raw_replay_manual_modes_required'},409);
      const asset={...frame(afterId,rendered,originalHash),sampleId:rawId};
      return json({operation,deviceRun,asset,result:{sha256:asset.hash,rawHash:rawAsset.hash,readbackHash:originalHash}});
    }
    return json({},400);
  });
  let view;
  try {
    await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
    const configuration=path.join(temp,'connection.json');
    const secretFile=path.join(temp,'creator');
    const stateFile=path.join(temp,'state.json');
    await writeFile(secretFile,token,{mode:0o600});
    await writeFile(configuration,JSON.stringify({url:`http://127.0.0.1:${source.address().port}/api/ops/vision-workshop/mcp`,auth:{type:'admin',credentialFile:secretFile}}),{mode:0o600});
    const camera=createCameraSource(configuration);
    view=await startWorkbench({camera:{experimentId}},0,camera,{stateFile});
    const request=(route,body,extra={})=>{
      const url=new URL(view.url);
      return fetch(new URL(route,url),{headers:{'X-Workshop-Session':url.hash.slice(1),'Content-Type':'application/json',...extra},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    };
    const status=async()=>{
      for(let i=0;i<80;i++) {
        const state=(await(await request('/camera/capture')).json()).capture;
        if(state&&!state.running) return state;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.fail('capture did not finish');
    };
    assert.equal((await request('/camera/capture',{action:'baseline',scene:'fixture'},{Origin:'https://invalid.example'})).status,404);
    assert.equal((await request('/camera/capture',{action:'baseline'})).status,422);
    assert.equal((await request('/camera/capture',{action:'baseline',scene:'fixture'})).status,202);
    assert.equal((await request('/camera/capture',{action:'photo'})).status,409);
    assert.equal((await status()).errors.render,'vision_raw_replay_manual_modes_required');
    assert.equal(view.read().resume.evidence.baseline_render,undefined);
    assert.deepEqual(Buffer.from(await(await request('/camera/capture/file/raw?id='+rawId+'&preview=1')).arrayBuffer()),png);
    assert.equal((await request('/camera/capture/file/raw?id=forged')).status,404);
    assert.deepEqual(Buffer.from(await(await request('/camera/capture/file/raw?id='+rawId)).arrayBuffer()),raw);
    wrongHash=true;
    assert.deepEqual(await(await request('/camera/capture/file/raw?id='+rawId)).json(),{error:'camera_frame_integrity_failed'});
    blocked=false;
    assert.equal((await request('/camera/capture',{action:'render'})).status,202);
    assert.equal((await status()).assets.render.sampleId,rawId);
    assert.match(view.read().resume.evidence.baseline_render,/sha256:/);
    assert.deepEqual(calls.map(item=>item.operation),['capture_raw','capture_frame','tuning_get','process_raw','tuning_get','process_raw']);
    assert.deepEqual(calls.at(-1).body,{sampleId:rawId});
    assert.equal((await request('/camera/capture',{action:'baseline',scene:'fixture'})).status,202);
    assert.equal(calls.length,6);
    await new Promise(resolve=>view.server.close(resolve));
    view=await startWorkbench({},0,camera,{stateFile});
    assert.equal((await status()).assets.raw.id,rawId);
    assert.equal((await request('/camera/capture',{action:'photo'})).status,202);
    assert.equal((await status()).assets.photo.id,beforeId);
    assert.equal(calls.at(-1).operation,'capture_frame');
    view.update({camera:{experimentId:otherExperiment}});
    assert.equal((await(await request('/camera/capture')).json()).capture,undefined);
    assert.equal((await request('/camera/capture/file/raw?id='+rawId)).status,404);
  } finally {
    if(view) await new Promise(resolve=>view.server.close(resolve));
    await new Promise(resolve=>source.close(resolve));
    await rm(temp,{recursive:true,force:true});
  }
});
