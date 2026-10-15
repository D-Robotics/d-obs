/** Real stores and HTTP handlers; generated images and SDK receipts are explicitly software fixtures. */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import express from 'express';
import { visionCrc32 } from './vision-workshop-export.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { buildVisionWorkshopDelivery, visionAcceptancePlanInput } from './vision-workshop-delivery.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP } from './vision-workshop-routes.js';
import { VisionDeviceRegistry } from './vision-workshop-device.js';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function png(): Buffer {
  const chunk = (name: string, data: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(name, 4); const c = Buffer.alloc(4); c.writeUInt32BE(visionCrc32(Buffer.concat([Buffer.from(name), data]))); return Buffer.concat([h,data,c]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(14,0))),chunk('IEND',Buffer.alloc(0))]);
}
const planInput = { scene:'software-fixture-dark-scene', lighting:'Fixed synthetic scene; not physical light measurements', criteria:[
  {id:'detail',label:'Visible target detail',kind:'visual' as const,required:true},
  {id:'snr',label:'Operator supplied calibrated SNR',kind:'measurement' as const,required:true,unit:'dB',operator:'gte' as const,minimum:30,method:'External measurement report; no SNR computed from PNG variation'},
] };
async function fixture(owner = 'alice') {
  const dir=await mkdtemp(join(tmpdir(),'vision-delivery-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const service=new VisionWorkshopService({dataDir:dir});const exp=await service.createExperiment(owner,{title:'Explicit software acceptance fixture',goal:'Never hardware or quality certification'});
  const base=await service.setBaseline(owner,exp.id,{tuning:{strength:1},rules:[{path:'/strength',label:'Fixture strength',min:0,max:3}]});
  const raw=await service.addRawSample(owner,exp.id,{metadata:{scene:planInput.scene,width:2,height:2,bitDepth:10,bayer:'RGGB',packing:'unpacked16le',stride:4,blackLevel:0,whiteLevel:1023}},Buffer.alloc(8));
  const candidate=await service.createCandidate(owner,exp.id,{baselineHash:base.hash,patches:[{path:'/strength',value:2,reason:'Software fixture only'}],sampleIds:[raw.id],source:'manual'});
  const image=await service.addProcessedImage(owner,exp.id,{sampleId:raw.id,candidateId:candidate.id,mimeType:'image/png'},png());
  await service.addEvaluation(owner,exp.id,{imageId:image.id,rating:3,notes:'Test input record, not human acceptance'});await service.selectCandidate(owner,exp.id,candidate.id);
  const plan=await service.setAcceptancePlan(owner,exp.id,planInput);
  const input={planId:plan.id,candidateId:candidate.id,imageIds:[image.id],observations:[{criterionId:'detail',verdict:'pass' as const,notes:'Explicit software observation'},{criterionId:'snr',value:31}],report:'Explicit external measurement fixture report; no hardware measured'};
  return {dir,service,exp,candidate,image,plan,input};
}
test('acceptance plans reject vacuous passes, unbounded metrics, duplicates and client verified claims',()=>{
  for(const input of [ {...planInput,criteria:[]}, {...planInput,criteria:planInput.criteria.map(c=>({...c,required:false}))}, {...planInput,criteria:[planInput.criteria[0],planInput.criteria[0]]}, {...planInput,qualityVerified:true}, {...planInput,criteria:[{...planInput.criteria[1],unit:undefined}]}, {...planInput,criteria:[{...planInput.criteria[1],operator:'between',minimum:40,maximum:30}]} ]) assert.equal(visionAcceptancePlanInput.safeParse(input).success,false);
});
test('thresholds are server-computed from operator records; pass never certifies measurement authenticity',async()=>{
  const f=await fixture();const record=await f.service.recordAcceptance('alice',f.exp.id,f.input);assert.equal(record.outcomes.every(row=>row.met),true);
  assert.equal(record.source,'operator_recorded');assert.equal(record.measurementAuthenticity,'unverified');assert.equal(record.reportSha256,createHash('sha256').update(f.input.report).digest('hex'));assert.notEqual(record.recordedBy,'alice');
  let d=buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id));assert.equal(d.quality.status,'recorded_pass');assert.equal(d.qualityVerification,'unverified');assert.equal(d.workshopReady,false);
  await f.service.recordAcceptance('alice',f.exp.id,{...f.input,observations:[{criterionId:'detail',verdict:'pass',notes:'software fixture'},{criterionId:'snr',value:29}]});
  d=buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id));assert.equal(d.quality.status,'recorded_fail');assert.deepEqual(d.quality.failedCriteria,['snr']);
});
test('missing criteria and scene mismatch stay visible, and new plans invalidate old records',async()=>{
  const f=await fixture();await f.service.recordAcceptance('alice',f.exp.id,{...f.input,observations:f.input.observations.slice(0,1)});
  let d=buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id));assert.equal(d.quality.status,'incomplete');assert.deepEqual(d.quality.missingCriteria,['snr']);
  const newPlan=await f.service.setAcceptancePlan('alice',f.exp.id,{...planInput,scene:'a different scene'});await assert.rejects(f.service.recordAcceptance('alice',f.exp.id,f.input),/验收标准已更新/);
  d=buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id));assert.equal(d.quality.status,'pending');assert.equal(d.acceptanceRecords.length,1);
  await f.service.recordAcceptance('alice',f.exp.id,{...f.input,planId:newPlan.id});d=buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id));assert.equal(d.quality.status,'scene_mismatch');assert.equal(d.quality.requiredCriteriaMet,false);
});
test('a later optional failed criterion cannot erase required failure; reports and visual reasons are mandatory',async()=>{
  const f=await fixture();for(const input of [{...f.input,report:undefined},{...f.input,observations:[{criterionId:'detail',verdict:'pass'}]},{...f.input,observations:[{criterionId:'invented',value:1}]},{...f.input,observations:[{criterionId:'snr',value:31,verdict:'pass'}]},{...f.input,qualityVerification:'verified'}]) await assert.rejects(f.service.recordAcceptance('alice',f.exp.id,input));
  const plan=await f.service.setAcceptancePlan('alice',f.exp.id,{...planInput,criteria:[...planInput.criteria,{id:'optional',label:'Optional',kind:'visual',required:false}]});
  await f.service.recordAcceptance('alice',f.exp.id,{...f.input,planId:plan.id,observations:[{criterionId:'detail',verdict:'fail',notes:'Important fixture target missing'},{criterionId:'snr',value:31},{criterionId:'optional',verdict:'pass',notes:'Irrelevant success'}]});assert.equal(buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id)).quality.status,'recorded_fail');
});
test('foreign accounts, foreign images and wrong tuning cannot supply acceptance evidence',async()=>{
  const f=await fixture();await assert.rejects(f.service.setAcceptancePlan('bob',f.exp.id,planInput));await assert.rejects(f.service.recordAcceptance('bob',f.exp.id,f.input));
  await assert.rejects(f.service.recordAcceptance('alice',f.exp.id,{...f.input,imageIds:[randomUUID()]}),/图像必须属于/);
  const other=await f.service.addCameraFrame('alice',f.exp.id,{mimeType:'image/png',adapterId:'software-fixture',scene:planInput.scene,tuningHash:'a'.repeat(64)},png());await assert.rejects(f.service.recordAcceptance('alice',f.exp.id,{...f.input,imageIds:[other.id]}),/参数版本/);
});
test('records survive reload while corrupted image bytes are refused before accepting a new record',async()=>{
  const f=await fixture();await f.service.recordAcceptance('alice',f.exp.id,f.input);const reloaded=new VisionWorkshopService({dataDir:f.dir});assert.equal(buildVisionWorkshopDelivery(await reloaded.getExperiment('alice',f.exp.id)).quality.status,'recorded_pass');
  await writeFile(join(f.dir,'assets',f.image.id+'.png'),Buffer.from('corrupted fixture image'));await assert.rejects(reloaded.recordAcceptance('alice',f.exp.id,f.input));
});
test('native snapshot and brightness statistics cannot silently become standalone library or verified quality',async()=>{
  const f=await fixture();const e=await f.service.getExperiment('alice',f.exp.id);e.candidates[0].tuning={kind:'x5-hbn-isp-v2',snapshotId:'private-session-reference'};const d=buildVisionWorkshopDelivery(e);assert.equal(d.tuning.status,'session_bound_configuration');assert.equal(d.tuning.independentDeployment,'unverified');assert.equal(d.hardwareVerification,'unverified');assert.ok(d.blockers.includes('standalone_tuning_reload_unverified'));
});
test('REST and typed MCP preserve guards, ownership, current plan ID, and export actual delivery records',async()=>{
  const f=await fixture('sso:alice');const old=process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;process.env.RDK_FLYWHEEL_ADMIN_USER_IDS='alice,bob';configureObservabilityAccess({getSessionSsoUser:req=>{const user=req.header('x-fixture-user');return user?{id:user}:null;},isMultiUserWebDeployment:()=>true,allowsAnonymousLocalOperator:()=>false,resolveChatPrincipalAccountId:()=>''});cleanup.push(async()=>{resetObservabilityAccessAdapter();if(old===undefined)delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS=old;});
  const app=express();app.use(express.json());const router=express.Router();registerVisionWorkshopRoutes(router,{getService:()=>f.service,getDevices:()=>new VisionDeviceRegistry(),modelEnabled:()=>false});app.use(router);const server=createServer(app);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));cleanup.push(()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());}));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const call=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-fixture-user':'alice','x-rdk-ops-action':'observability',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await call(API+'/experiments/'+f.exp.id+'/delivery',undefined,{'x-fixture-user':'bob'})).status,404);
  assert.equal((await call(API+'/experiments/'+f.exp.id+'/acceptance-records',f.input,{'x-rdk-ops-read-only':'1'})).status,403);
  assert.equal((await call(API+'/experiments/'+f.exp.id+'/acceptance-records',f.input,{'x-rdk-ops-action':''})).status,400);
  assert.equal((await call(API+'/experiments/'+f.exp.id+'/acceptance-records',f.input)).status,201);
  const d=await (await call(API+'/experiments/'+f.exp.id+'/delivery')).json() as {delivery:ReturnType<typeof buildVisionWorkshopDelivery>};assert.equal(d.delivery.quality.status,'recorded_pass');assert.equal(d.delivery.workshopReady,false);
  const tools=await (await call(MCP,{jsonrpc:'2.0',id:1,method:'tools/list',params:{}})).json() as {result:{tools:Array<{name:string}>}};assert.ok(tools.result.tools.some((tool:{name:string})=>tool.name==='vision_workshop_delivery'));
  const rpc=await (await call(MCP,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'vision_workshop_delivery',arguments:{experimentId:f.exp.id}}})).json() as {result:{isError?:boolean}};assert.equal(Boolean(rpc.result.isError),false);
  const handbook=await call(API+'/experiments/'+f.exp.id+'/handbook');assert.equal(handbook.status,200);assert.match(handbook.headers.get('content-type')||'',/text\/markdown/);
});
test('archived vendor JSON keeps exact bytes, account ownership, deduplication, quota and corruption checks',async()=>{
  const f=await fixture(), data=Buffer.from('{"fixtureLibrary":{"strength":17}}\n'), input={bindingHash:'b'.repeat(64),sourceReadbackHash:f.candidate.hash};
  const artifact=await f.service.archiveVendorArtifact('alice',f.exp.id,input,data);assert.equal(artifact.hash,createHash('sha256').update(data).digest('hex'));assert.equal(artifact.byteLength,data.length);
  assert.equal((await f.service.archiveVendorArtifact('alice',f.exp.id,input,data)).id,artifact.id);
  const reloaded=new VisionWorkshopService({dataDir:f.dir});assert.deepEqual((await reloaded.readVendorArtifact('alice',f.exp.id,artifact.id)).data,data);
  await assert.rejects(reloaded.readVendorArtifact('bob',f.exp.id,artifact.id));await assert.rejects(reloaded.readVendorArtifact('alice',f.exp.id,'../private'));
  await assert.rejects(f.service.archiveVendorArtifact('alice',f.exp.id,input,Buffer.from('[]')));await assert.rejects(f.service.archiveVendorArtifact('alice',f.exp.id,{...input,bindingHash:'invalid'},data));await assert.rejects(f.service.archiveVendorArtifact('alice',f.exp.id,input,Buffer.alloc(16*1024*1024+1)));
  await writeFile(join(f.dir,'assets',artifact.id+'.json'),Buffer.from('{}'));await assert.rejects(reloaded.readVendorArtifact('alice',f.exp.id,artifact.id));
});
test('delivery target selection is explicit and never changes through recording an observation',async()=>{
  const f=await fixture();const beforeTarget=(await f.service.getExperiment('alice',f.exp.id)).deliveryTargetId;await f.service.recordAcceptance('alice',f.exp.id,f.input);assert.equal((await f.service.getExperiment('alice',f.exp.id)).deliveryTargetId,beforeTarget);
  await f.service.setDeliveryTarget('alice',f.exp.id,f.candidate.id);assert.equal(buildVisionWorkshopDelivery(await f.service.getExperiment('alice',f.exp.id)).selectedTargetId,f.candidate.id);
  await assert.rejects(f.service.setDeliveryTarget('alice',f.exp.id,'vendor:invented'));await assert.rejects(f.service.setDeliveryTarget('bob',f.exp.id,f.candidate.id));
});
test('vendor export REST archives verified bytes, strips nested base64 from ledger, and preserves explicit reload role',async()=>{
  const f=await fixture('sso:alice');const previous=process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;process.env.RDK_FLYWHEEL_ADMIN_USER_IDS='alice,bob';configureObservabilityAccess({getSessionSsoUser:req=>{const value=req.header('x-fixture-user');return value?{id:value}:null;},isMultiUserWebDeployment:()=>true,allowsAnonymousLocalOperator:()=>false,resolveChatPrincipalAccountId:()=>''});cleanup.push(async()=>{resetObservabilityAccessAdapter();if(previous===undefined)delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS=previous;});
  const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex'),oldBytes=Buffer.from('{"archivedOriginal":true}\n'),candidateBytes=Buffer.from('{"fixtureVendor":{"strength":17}}\n');let receivedRole:unknown;
  const profile={id:'vendor-software-fixture',label:'Software vendor protocol fixture',board:'software-fixture',sensorModel:'software-fixture',sdkVersion:'software-fixture',operations:['tuning_export','tuning_load'] as const};
  const devices=new VisionDeviceRegistry([{profile:{...profile,operations:[...profile.operations]},execute:async(operation,_context,inputs)=>{
    if(operation==='tuning_export')return {filename:'archived-original.json',mimeType:'application/json',artifactRole:'sdk_configuration_with_archived_declared_library',contentBase64:oldBytes.toString('base64'),sha256:digest(oldBytes),vendorCandidate:{status:'generated_requires_target_validation',artifactRole:'vendor_effect_library_candidate',contentBase64:candidateBytes.toString('base64'),sha256:digest(candidateBytes),bindingHash:'b'.repeat(64),sourceReadbackHash:'a'.repeat(64)}};
    receivedRole=inputs.artifactRole;const config={strength:17},readbackHash=digest(JSON.stringify(config));return {baseline:{config,rules:[{path:'/strength',label:'Software fixture',min:0,max:30}]},appliedHash:readbackHash,readbackHash,evidence:{source:'software-fixture'}};
  }}]);
  const experiment=await f.service.createExperiment('sso:alice',{title:'Vendor HTTP protocol fixture',goal:'No physical device',targetId:profile.id,board:profile.board,sensorModel:profile.sensorModel,sdkVersion:profile.sdkVersion});
  const app=express();app.use(express.json());const router=express.Router();registerVisionWorkshopRoutes(router,{getService:()=>f.service,getDevices:()=>devices,modelEnabled:()=>false});app.use(router);const server=createServer(app);await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));cleanup.push(()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());}));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  const call=(path:string,body?:unknown,user='alice')=>fetch(origin+API+'/experiments/'+experiment.id+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-fixture-user':user,'x-rdk-ops-action':'observability'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const response=await call('/device/tuning_export',{});assert.equal(response.status,200);const exported=await response.json() as {vendorArtifact:{id:string;sha256:string;contentBase64:string};result:{vendorCandidate:Record<string,unknown>};deviceRun:{evidence:{result:{vendorCandidate:Record<string,unknown>}}}};
  assert.equal(exported.vendorArtifact.sha256,digest(candidateBytes));assert.deepEqual(Buffer.from(exported.vendorArtifact.contentBase64,'base64'),candidateBytes);assert.equal(exported.result.vendorCandidate.contentBase64,undefined);assert.equal(exported.deviceRun.evidence.result.vendorCandidate.contentBase64,undefined);
  const download=await call('/vendor-artifacts/'+exported.vendorArtifact.id+'/download');assert.equal(download.headers.get('x-vision-sha256'),digest(candidateBytes));assert.deepEqual(Buffer.from(await download.arrayBuffer()),candidateBytes);assert.equal((await call('/vendor-artifacts/'+exported.vendorArtifact.id+'/download',undefined,'bob')).status,404);
  const load=await call('/device/tuning_load',{contentBase64:candidateBytes.toString('base64'),sha256:digest(candidateBytes),artifactRole:'vendor_effect_library_candidate'});assert.equal(load.status,200);assert.equal(receivedRole,'vendor_effect_library_candidate');
  const bundle=Buffer.from(await (await call('/bundle')).arrayBuffer());assert.ok(bundle.includes(Buffer.from('vendor-tuning/'+exported.vendorArtifact.id+'.json')));assert.ok(bundle.includes(candidateBytes));assert.ok(bundle.includes(Buffer.from('delivery.json')));
});
