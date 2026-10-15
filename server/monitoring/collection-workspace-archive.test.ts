import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DataCenterService} from './data-center-service.js';
test('run archives are atomic, cannot trust forged tags, and reject changed content after the receipt is committed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'collection-archive-'));const service=new DataCenterService({dataDir:dir});const runId=randomUUID(),pipelineId=randomUUID();const bytes=Buffer.from('actual captured data');const sha256=createHash('sha256').update(bytes).digest('hex');
 const input={runId,pipelineId,pipelineVersion:1,moduleId:'ssh-logs',upstreamId:'actual-session',name:'logs',project:'p',source:'edge' as const,createDataset:true,artifacts:[{filename:'logs.txt',mimeType:'text/plain',kind:'log' as const,bytes,sha256,role:'original'}]};
 try{
  const spoof=await service.uploadAsset('alice',{title:'spoofed origin tag',kind:'log',source:'edge',project:'p',tags:['collection-run:'+runId],filename:'spoof.txt',mimeType:'text/plain',sha256},bytes);const receipt=await service.archiveCollectionRun('alice',input);assert.notEqual(receipt.assetIds[0],spoof.id);assert.ok(receipt.datasetId);assert.deepEqual(await service.archiveCollectionRun('alice',input),receipt);
  const changed=Buffer.from('changed capture');await assert.rejects(()=>service.archiveCollectionRun('alice',{...input,artifacts:[{...input.artifacts[0]!,bytes:changed,sha256:createHash('sha256').update(changed).digest('hex')}]}),/collection_output_changed/);assert.deepEqual((await service.readAsset('alice',receipt.assetIds[0]!)).data,bytes);assert.equal((await service.listDatasets('alice')).length,1);
  await assert.rejects(()=>service.readAsset('bob',receipt.assetIds[0]!),/not_found/);
 }finally{await rm(dir,{recursive:true,force:true});}
 const limited=await mkdtemp(join(tmpdir(),'collection-atomic-'));try{const small=new DataCenterService({dataDir:limited,maxDatasets:1});const existing=await small.uploadAsset('alice',{title:'file',kind:'log',source:'edge',project:'p',filename:'a.txt',mimeType:'text/plain',sha256},bytes);await small.createDataset('alice',{name:'quota',project:'p',assetIds:[existing.id]});const before=await readFile(join(limited,'manifest.json'));await assert.rejects(()=>small.archiveCollectionRun('alice',input),/quota_exceeded/);assert.deepEqual(await readFile(join(limited,'manifest.json')),before);assert.equal((await small.listAssets('alice')).length,1);}finally{await rm(limited,{recursive:true,force:true});}
});
