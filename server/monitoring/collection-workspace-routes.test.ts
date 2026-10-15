import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {CollectionWorkspaceService,type CollectionWorkspaceDriver} from './collection-workspace-service.js';
import {registerCollectionWorkspaceRoutes} from './collection-workspace-routes.js';
import {COLLECTION_WORKSPACE_API as API,COLLECTION_WORKSPACE_OPERATIONS} from './collection-workspace-operations.js';
import {configureObservabilityAccess,resetObservabilityAccessAdapter} from './observability-access-adapter.js';
import {listPlatformOperations} from './platform-operations.js';
import {DataCenterService} from './data-center-service.js';
import {createHash} from 'node:crypto';

test('unified HTTP executes owned fixed versions, validates writes and exposes real archive bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collection-http-'));const previous=process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;process.env.RDK_FLYWHEEL_ADMIN_USER_IDS='alice,bob';
 configureObservabilityAccess({getSessionSsoUser:req=>{const id=req.header('x-user');return id?{id,email:'same@example.invalid'}:null;},isMultiUserWebDeployment:()=>true,allowsAnonymousLocalOperator:()=>false,resolveChatPrincipalAccountId:()=>''});
 const data=new DataCenterService({dataDir:join(directory,'data')});const bytes=Buffer.from('INFO boot\nERROR actual failure\n');let started=0;const real=new Map<string,{owner:string,state:'running'|'completed'}>();
 const driver:CollectionWorkspaceDriver={moduleId:'ssh-logs',version:'1.0.0',describe:()=>({moduleId:'ssh-logs',version:'1.0.0',mode:'pull',label:'fixture SSH',description:'actual bytes fixture',available:true,canStart:true,canStop:true,targets:[],configSchema:{fields:[]}}),validate:input=>{assert.deepEqual(input,{targetId:'owned'});return{targetId:'owned'};},start:async(_config,owner)=>{started++;const id=randomUUID();real.set(id,{owner,state:'running'});return{upstreamId:id};},inspect:async(id,owner)=>{const job=real.get(id);assert.equal(job?.owner,owner);return{state:job!.state,byteCount:bytes.length,recordCount:2};},stop:async(id,owner)=>{assert.equal(real.get(id)?.owner,owner);real.get(id)!.state='completed';},export:async(id,owner)=>{assert.equal(real.get(id)?.owner,owner);return{filename:'source.txt',mimeType:'text/plain',kind:'log',bytes};}};
 const service=new CollectionWorkspaceService({stateDir:join(directory,'workspace'),drivers:[driver],pollIntervalMs:1000,archive:async(owner,run,pipeline,artifact)=>data.archiveCollectionRun(owner,{runId:run.id,pipelineId:run.pipelineId,pipelineVersion:run.pipelineVersion,moduleId:run.moduleId,upstreamId:run.upstreamId!,name:pipeline.name,project:pipeline.project,source:pipeline.source,createDataset:true,artifacts:[{filename:artifact.filename,mimeType:artifact.mimeType,kind:artifact.kind,bytes:artifact.bytes,sha256:createHash('sha256').update(artifact.bytes).digest('hex'),role:'original'}]})});
 const app=express();app.use(express.json());const router=express.Router();registerCollectionWorkspaceRoutes(router,{getService:()=>service,catalog:async(owner,s)=>({modules:await s.modules(owner),sources:[],legacyJobs:[],receivers:[]})});app.use('/dobs',router);const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port+'/dobs'+API;
 const headers=(user='alice',extra={})=>({'content-type':'application/json','x-user':user,'x-rdk-ops-action':'observability',...extra});
 const post=(path:string,body:unknown,user='alice',extra={})=>fetch(origin+path,{method:'POST',headers:headers(user,extra),body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(origin+'/catalog')).status,403);assert.equal((await fetch(origin+'/catalog',{headers:headers('outsider')})).status,403);
  const read=await fetch(origin+'/catalog',{headers:headers('alice',{'x-rdk-ops-read-only':'1'})});assert.equal(read.status,200);assert.equal(read.headers.get('x-rdk-ops-read-only'),'1');
  const input={name:'cloud logs',project:'project',source:'cloud',moduleId:'ssh-logs',moduleVersion:'1.0.0',config:{targetId:'owned'},quality:{minBytes:1},createDataset:true};
  assert.equal((await post('/pipelines',input,'alice',{'x-rdk-ops-action':''})).status,400);assert.equal((await post('/pipelines',input,'alice',{'x-rdk-ops-read-only':'1'})).status,403);assert.equal((await post('/pipelines',{...input,command:'arbitrary'})).status,400);
  const saved=await post('/pipelines',input);assert.equal(saved.status,201);const pipeline=(await saved.json() as any).pipeline;assert.equal(started,0);
  const runResponse=await post('/pipelines/'+pipeline.id+'/runs',{});assert.equal(runResponse.status,201);const run=(await runResponse.json() as any).run;assert.equal(started,1);assert.equal(run.pipelineVersion,1);
  assert.equal((await fetch(origin+'/runs/'+run.id,{headers:headers('bob')})).status,404);assert.equal((await post('/runs/'+run.id+'/stop',{},'bob')).status,404);assert.equal((await post('/runs/'+run.id+'/stop',{},'alice',{'x-rdk-ops-read-only':'1'})).status,403);
  const ended=await post('/runs/'+run.id+'/stop',{});assert.equal(ended.status,200);const final=await post('/runs/'+run.id+'/finalize',{});assert.equal(final.status,200);const receipt=(await final.json() as any).run;assert.equal(receipt.archiveState,'completed');assert.equal(started,1);assert.equal(receipt.assetIds.length,1);
  assert.deepEqual((await data.readAsset('sso:alice',receipt.assetIds[0])).data,bytes);assert.equal((await data.listAssets('sso:bob')).length,0);const repeat=await post('/runs/'+run.id+'/finalize',{});assert.equal((await repeat.json() as any).run.assetIds[0],receipt.assetIds[0]);assert.equal((await data.listAssets('sso:alice')).length,1);
  assert.deepEqual(listPlatformOperations(router).map(x=>x.id).sort(),Object.keys(COLLECTION_WORKSPACE_OPERATIONS).sort());
 }finally{await service.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));resetObservabilityAccessAdapter();if(previous===undefined)delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS=previous;await rm(directory,{recursive:true,force:true});}
});
