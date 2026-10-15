import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { RsiFailureInboxError, RsiFailureInboxService } from '../evolution/rsi-failure-inbox.js';
import { RsiLedgerService } from '../evolution/rsi-ledger.js';
import { RsiFailureObserver } from './rsi-failure-observer.js';
import type { PlatformOperation } from './platform-operations.js';

const path='/api/ops/observability/overview';
const operation:PlatformOperation={id:'GET '+path,path,method:'GET',description:'Fixture',group:'Fixture',mutating:false,tenantAccessible:false,parameters:{params:{},query:{},body:{}}};
const req=(headers:Record<string,string>={})=>({header:(key:string)=>headers[key]} as Request);
test('actual receipt observation stores only bounded features and never promotes a suggestion into a label',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-observer-'));
  try{
    const inbox=new RsiFailureInboxService({stateDir:dir,operationIds:[operation.id]});
    const observer=new RsiFailureObserver({inbox,owner:()=> 'operator',allowed:()=>true});
    const secret='fixture-private-response-body-and-arguments';
    observer.capture(req(),operation,{ok:false,status:504,data:{error:'platform_operation_timeout',message:secret,body:{token:secret}}});
    await observer.flush();const summary=await inbox.overview('operator');
    assert.equal(summary.records.length,1);const record=summary.records[0];
    assert.deepEqual(record.input,{httpStatus:504,errorCode:'ETIMEDOUT'});
    assert.equal(record.suggestedReason,'timeout');assert.equal(record.expectedReason,null);assert.equal(record.status,'unconfirmed');
    const file=(await readdir(dir)).find(name=>name.endsWith('.json'))!;
    assert.ok(!(await readFile(join(dir,file),'utf8')).includes(secret));
    observer.capture(req(),operation,{ok:false,status:503,data:{error:'arbitrary-machine-code-'+secret}});
    await observer.flush();assert.deepEqual((await inbox.overview('operator')).records.find(row=>row.input.httpStatus===503)!.input,{httpStatus:503});
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('success, tenant, read-only and recursive learning calls never create failure observations',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-observer-guards-'));
  try{
    const inbox=new RsiFailureInboxService({stateDir:dir,operationIds:[operation.id]});
    const observer=new RsiFailureObserver({inbox,owner:()=> 'operator',allowed:()=>true});
    const failed={ok:false,status:500,data:{error:'platform_operation_failed'}};
    observer.capture(req(),operation,{ok:true,status:200,data:{ok:true}});
    observer.capture(req({'x-rdk-ops-read-only':'1'}),operation,failed);
    const tenant=req();tenant.opsTenantAccess={tenantId:'t1',displayName:'Tenant',source:'token'};observer.capture(tenant,operation,failed);
    observer.capture(req(),{...operation,path:'/api/ops/observability/evolution/learning/evidence'},failed);
    await observer.flush();assert.equal((await inbox.overview('operator')).records.length,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('an uncertain mutation receipt stays unknown even when its request error is a timeout',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-observer-mutation-'));
  try{
    const mutation={...operation,id:'POST '+path,method:'POST',mutating:true};
    const inbox=new RsiFailureInboxService({stateDir:dir,operationIds:[mutation.id]});
    const observer=new RsiFailureObserver({inbox,owner:()=> 'operator',allowed:()=>true});
    observer.capture(req(),mutation,{ok:false,status:504,data:{error:'platform_operation_timeout',outcome:'unknown'}});
    await observer.flush();assert.equal((await inbox.overview('operator')).records[0].executionOutcome,'unknown');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a logical failure inside HTTP 200 is retained with explicit receipt failure and remains unconfirmed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-observer-logical-'));
  try{
    const inbox=new RsiFailureInboxService({stateDir:dir,operationIds:[operation.id]});
    const observer=new RsiFailureObserver({inbox,owner:()=> 'operator',allowed:()=>true});
    observer.capture(req(),operation,{ok:false,status:200,data:{ok:false,error:'fixture-business-rejection',message:'private-raw-body'}});
    await observer.flush();const record=(await inbox.overview('operator')).records[0];
    assert.equal(record.receiptFailure,true);assert.deepEqual(record.input,{httpStatus:200});
    assert.equal(record.suggestedReason,'unknown');assert.equal(record.expectedReason,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('a binding change discards only the stale prediction while retaining the actual failed receipt',async()=>{
  const loopId='10000000-0000-4000-8000-000000000001',versionId='10000000-0000-4000-8000-000000000002';
  const writes:any[]=[];
  const inbox={overview:async()=>({activeLoopId:loopId,records:[{id:'evidence',status:'confirmed',fingerprint:'hash',expectedReason:'timeout',slice:'adaptive'}]}),record:async(_owner:string,input:any)=>{writes.push(input);if(input.classification)throw new RsiFailureInboxError('rsi_inbox_binding_required',409);return input;}} as unknown as RsiFailureInboxService;
  const ledger={getLoop:async()=>({id:loopId,activeVersionId:versionId,candidateVersionId:null,versions:[{id:versionId,status:'accepted',rules:[{id:'timeout',predicate:{errorCode:'ETIMEDOUT'},reason:'timeout'}]}],decisions:[{action:'accept',versionId,replayId:'replay'}],replays:[{id:'replay',candidateVersionId:versionId,report:{gate:{passed:true}}}],cases:[{id:'case',source:'operator',expectedReason:'timeout',slice:'adaptive'}],provenance:[{caseId:'case',evidenceId:'evidence',fingerprint:'hash'}]})} as unknown as RsiLedgerService;
  const observer=new RsiFailureObserver({inbox,ledger,owner:()=> 'operator',allowed:()=>true});
  observer.capture(req(),operation,{ok:false,status:504,data:{error:'platform_operation_timeout'}});await observer.flush();
  assert.equal(writes.length,2);assert.equal(writes[0].classification.activeVersionId,versionId);assert.equal(writes[1].classification,undefined);
  assert.deepEqual(writes[1].input,{httpStatus:504,errorCode:'ETIMEDOUT'});
});
