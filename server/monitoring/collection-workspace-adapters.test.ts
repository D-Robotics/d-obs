import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollectionDrivers} from './collection-workspace-adapters.js';
import {CollectionWorkspaceService} from './collection-workspace-service.js';
import {SshLogCollector,parseSshLogTargets} from './ssh-log-collector.js';
import {RdkLogCaptureService} from './rdk-log-capture.js';
test('the actual SSH adapter projects a strict receipt, preserves exact exported bytes and respects legacy ownership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collection-adapter-'));const privateKey=join(dir,'private-key');await writeFile(privateKey,'fixture-only',{mode:0o600});const children:Array<EventEmitter&{stdout:PassThrough;stderr:PassThrough;kill:()=>boolean}>=[];
 const ssh=new SshLogCollector({stateDir:join(dir,'ssh'),targets:parseSshLogTargets(JSON.stringify([{id:'x5',host:'private-host',identityFile:privateKey,label:'X5'}])),spawnProcess:()=>{const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{child.emit('close',null,'SIGTERM');return true;}});children.push(child);return child as unknown as ChildProcess;}});
 const rdk=new RdkLogCaptureService({collector:ssh,stateDir:join(dir,'rdk')});const drivers=createCollectionDrivers({ssh:()=>ssh,rdk:()=>rdk});let archived:Buffer|undefined;
 const service=new CollectionWorkspaceService({stateDir:join(dir,'workspace'),drivers,pollIntervalMs:0,archive:async(_owner,_run,_version,artifact)=>{archived=artifact.bytes;return{assetIds:['11111111-1111-4111-a111-111111111111']};}});
 try{
  const modules=await service.modules('sso:alice');assert.ok(!JSON.stringify(modules).includes('private-host'));assert.ok(!JSON.stringify(modules).includes(privateKey));
  await assert.rejects(()=>service.savePipeline('sso:alice',{name:'bad',project:'p',source:'edge',moduleId:'ssh-logs',moduleVersion:'1.0.0',config:{targetId:'x5',sourceId:'kernel',command:'arbitrary'},createDataset:false}));
  const pipeline=await service.savePipeline('sso:alice',{name:'actual SSH',project:'p',source:'edge',moduleId:'ssh-logs',moduleVersion:'1.0.0',config:{targetId:'x5',sourceId:'kernel',lines:10,durationSeconds:5,follow:false},createDataset:false});
  const run=await service.startRun('sso:alice',pipeline.id);assert.equal(run.state,'running');assert.notEqual(run.state,'interrupted');assert.ok(run.upstreamId);
  children[0]!.stdout.write('kernel actual\n');children[0]!.emit('close',0,null);
  const receipt=await service.finalizeRun('sso:alice',run.id);assert.equal(receipt.archiveState,'completed');assert.deepEqual(archived,Buffer.from(await ssh.exportText(run.upstreamId!,'sso:alice')));
  await assert.rejects(()=>drivers[0]!.inspect!(run.upstreamId!,'sso:bob'));
 }finally{await service.dispose();await rdk.dispose();await ssh.dispose();await rm(dir,{recursive:true,force:true});}
});
