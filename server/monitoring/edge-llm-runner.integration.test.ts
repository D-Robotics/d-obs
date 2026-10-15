/** Actual platform service <-> actual runner HTTP contract; inference uses a labelled fixture. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EdgeLlmService } from './edge-llm-service.js';

async function unusedPort() { const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as AddressInfo).port;await new Promise<void>(done=>server.close(()=>done()));return port; }
test('platform and runner complete deploy, fixed benchmark, report and stop through real HTTP, including a lost receipt', async () => {
  const { createEdgeLlmRunner } = await import(pathToFileURL(resolve('tools/edge-llm-runner.mjs')).href);
  const directory=await mkdtemp(join(tmpdir(),'edge-llm-contract-'));const modelDir=join(directory,'models');await mkdir(modelDir);
  const modelBytes=Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(128)]);const sha256=createHash('sha256').update(modelBytes).digest('hex');await writeFile(join(modelDir,'fixture.gguf'),modelBytes,{mode:0o600});
  const binary=join(directory,'fixture-llama-server');
  await writeFile(binary,`#!/usr/bin/env node
const http=require('node:http');
if(process.argv.includes('--version')){console.log('llama-server version fixture-1');process.exit(0);}
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const server=http.createServer((req,res)=>{
 if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return;}
 req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'你好'},finish_reason:null}]})+'\\n\\n');setTimeout(()=>{res.write('data: '+JSON.stringify({choices:[{delta:{content:'。'},finish_reason:'stop'}],usage:{completion_tokens:2},timings:{predicted_n:2,predicted_per_second:20}})+'\\n\\n');res.end('data: [DONE]\\n\\n');},10);});
});server.listen(port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,{mode:0o700});
  let runner: any;
  try {
    runner=await createEdgeLlmRunner({board:'X5',binary,modelDir,port:await unusedPort(),models:[{id:'fixture-qwen',label:'Contract fixture',path:join(modelDir,'fixture.gguf'),sha256,sizeBytes:modelBytes.length,quantization:'Q4_K_M'}]},
      {token:'contract-fixture-token-long-enough',stateDir:join(directory,'runner'),systemProbe:async()=>({configuredBoard:'X5',detectedBoard:'X5',identityVerification:'verified',platform:'linux',architecture:'arm64',freeDiskBytes:1e9})});
    await new Promise<void>(done=>runner.server.listen(0,'127.0.0.1',done));
    const adapters=[{id:'fixture-x5',label:'Contract fixture',board:'X5' as const,url:'http://127.0.0.1:'+runner.server.address().port,token:'contract-fixture-token-long-enough'}];
    let submitted=0;
    const fetcher: typeof fetch = async (input,init) => { const response=await fetch(input,init);if(init?.method==='POST' && ++submitted===1){await response.arrayBuffer();throw new Error('fixture-lost-receipt');}return response; };
    const platform=new EdgeLlmService({dataDir:join(directory,'platform'),adapters,fetcher});
    const settle=async (id:string) => {const end=Date.now()+8000;while(Date.now()<end){const job=await platform.getJob('sso:contract-owner',id);if(['succeeded','failed','superseded'].includes(job.status))return job;await new Promise(done=>setTimeout(done,20));}throw new Error('fixture_job_did_not_finish');};
    const pending=await platform.submitJob('sso:contract-owner',{targetId:'fixture-x5',operation:'deploy',modelId:'fixture-qwen'});
    assert.equal(pending.status,'submitting');const deployed=await settle(pending.id);assert.equal(deployed.status,'succeeded',JSON.stringify(deployed));assert.equal(deployed.result?.modelSha256,sha256);assert.equal(submitted,1);
    const benchmark=await platform.submitJob('sso:contract-owner',{targetId:'fixture-x5',operation:'benchmark',modelId:'fixture-qwen'});const measured=await settle(benchmark.id);assert.equal(measured.status,'succeeded',JSON.stringify(measured));
    const cases=measured.result?.cases as Array<Record<string,unknown>>;assert.equal(cases.length,3);assert.ok(cases.every(c=>c.outputPresent===true && c.tokensPerSecond===20 && Number(c.ttftMs)>=0));
    const report=await platform.exportReport('sso:contract-owner',measured.id);assert.equal(report.job.id,measured.id);assert.ok(!JSON.stringify(report).includes(adapters[0].token));
    const stop=await platform.submitJob('sso:contract-owner',{targetId:'fixture-x5',operation:'stop'});const stopped=await settle(stop.id);assert.equal(stopped.status,'succeeded',JSON.stringify(stopped));assert.equal(stopped.result?.inferencePortAvailable,true);
    assert.equal((await platform.getTarget('fixture-x5')).catalog.deployment.ready,false);
  } finally { await runner?.close();await rm(directory,{recursive:true,force:true}); }
});
