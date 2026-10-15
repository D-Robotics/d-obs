import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CloudBridgeRuntime, normalizeCloudBridgeTunables } from './collection-log-bridge-runtime.mjs';

const CONFIG={pollMs:1000,flushMs:1000,batch:1,queueLimit:512};
const hash=value=>createHash('sha256').update(value).digest('hex');
const counters={cycles:1,pending:0,dropped:0,sent:2,flushFailures:0};
async function fixture(action) { const dir=await mkdtemp(join(tmpdir(),'cloud-bridge-runtime-')); try { await action({dir,configPath:join(dir,'collection-config.json')}); } finally { await rm(dir,{recursive:true,force:true}); } }
async function configure(path,config=CONFIG) { const record={version:randomUUID(),hash:hash(JSON.stringify(config)),updatedAt:new Date().toISOString(),actorHash:hash('operator'),config}; const payload={schemaVersion:1,desired:record,history:[record]}; await writeFile(path,JSON.stringify({sha256:hash(JSON.stringify(payload)),payload}),{mode:0o600}); return record; }
async function status(dir) { return JSON.parse(await readFile(join(dir,'collection-status.json'),'utf8')); }
test('runtime validates bounded tunables and reports only explicit aggregate counters and source counts', async ()=>fixture(async ({dir,configPath})=>{
  for(const input of [{...CONFIG,url:'secret'}, {...CONFIG,queueLimit:1}, {...CONFIG,batch:513}, {...CONFIG,pollMs:999}, {...CONFIG,batch:Infinity}]) assert.throws(()=>normalizeCloudBridgeTunables(input),/config_invalid/);
  const runtime=new CloudBridgeRuntime({configPath,sourceCounts:{journald:8,docker:1,file:1,token:'SECRET'}});
  await runtime.reload(); assert.equal(await runtime.publish({...counters,token:'SECRET',endpoint:'PRIVATE_ADDRESS',rawLogs:'PRIVATE_LOG'}),true);
  const actual=await status(dir); assert.equal(actual.appliedVersion,'environment'); assert.deepEqual(actual.counts,counters); assert.deepEqual(actual.sourceCounts,{journald:8,docker:1,file:1});
  assert.doesNotMatch(JSON.stringify(actual),/SECRET|PRIVATE|endpoint|rawLogs|actor/); assert.equal((await stat(join(dir,'collection-status.json'))).mode&0o777,0o600);
}));
test('actual desired configuration is loaded before an applied acknowledgement; corruption retains last good settings', async ()=>fixture(async ({dir,configPath})=>{
  const desired=await configure(configPath); const runtime=new CloudBridgeRuntime({configPath});
  assert.deepEqual(await runtime.reload(),CONFIG); await runtime.publish(counters);
  assert.equal((await status(dir)).appliedVersion,desired.version);
  await writeFile(configPath,'{broken'); assert.deepEqual(await runtime.reload(),CONFIG); await runtime.publish(counters);
  const failed=await status(dir); assert.equal(failed.state,'failed'); assert.equal(failed.appliedVersion,desired.version); assert.equal(failed.reason,'config_invalid'); assert.equal(failed.errors.configuration,1);
  await rm(configPath); assert.deepEqual(await runtime.reload(),CONFIG); await runtime.publish(); assert.equal((await status(dir)).reason,'config_read_failed');
  const next=await configure(configPath,{...CONFIG,batch:2}); assert.deepEqual(await runtime.reload(),{...CONFIG,batch:2}); await runtime.publish(); assert.equal((await status(dir)).appliedVersion,next.version); assert.equal((await status(dir)).state,'applied');
}));
test('symlink, oversized, unsafe mode and tampered checksum configurations never replace running settings', async ()=>fixture(async ({dir,configPath})=>{
  const desired=await configure(configPath); const runtime=new CloudBridgeRuntime({configPath}); await runtime.reload();
  const outside=join(dir,'outside'); await writeFile(outside,'PRIVATE_LOG',{mode:0o600}); await rm(configPath); await symlink(outside,configPath);
  assert.deepEqual(await runtime.reload(),CONFIG); await runtime.publish(); assert.equal((await status(dir)).state,'failed');
  await rm(configPath); await writeFile(configPath,' '.repeat(65537),{mode:0o600}); assert.deepEqual(await runtime.reload(),CONFIG);
  await configure(configPath,{...CONFIG,batch:2}); await chmod(configPath,0o644); assert.deepEqual(await runtime.reload(),CONFIG);
  await chmod(configPath,0o600); const raw=JSON.parse(await readFile(configPath,'utf8')); raw.payload.desired.version=desired.version; raw.payload.history[0].version=desired.version; raw.sha256=hash(JSON.stringify(raw.payload)); await writeFile(configPath,JSON.stringify(raw));
  assert.deepEqual(await runtime.reload(),CONFIG); await runtime.publish(); assert.equal((await status(dir)).state,'failed');
  const alias=join(dir,'alias'); await symlink(dir,alias); const unsafe=new CloudBridgeRuntime({configPath:join(alias,'collection-config.json'),initialConfig:CONFIG});
  assert.deepEqual(await unsafe.reload(),CONFIG); assert.equal(await unsafe.publish(),false); assert.equal(unsafe.errors.configuration,1); assert.equal(unsafe.errors.receipt,1);
}));
test('server desired writer and daemon reader share the exact durable protocol', async ()=>fixture(async ({dir,configPath})=>{
  const {register}=await import('tsx/esm/api'); const loader=register({namespace:'cloud-config-contract-fixture'});
  try {
    const {updateCloudBridgeConfig,getCloudBridgeConfig}=await loader.import('../server/monitoring/collection-log-bridge-config.js',import.meta.url);
    const desired=await updateCloudBridgeConfig(CONFIG,'fixture-actor',{configPath}); assert.equal(desired.state,'unavailable');
    const runtime=new CloudBridgeRuntime({configPath,sourceCounts:{journald:1,docker:0,file:0}}); const applied=await runtime.reload(); assert.deepEqual(applied,CONFIG); await runtime.publish(counters);
    const actual=await getCloudBridgeConfig({configPath}); assert.equal(actual.state,'applied'); assert.equal(actual.appliedVersion,desired.desiredVersion);
    assert.deepEqual(actual.sourceCounts,{journald:1,docker:0,file:0});
  } finally { await loader.unregister(); }
}));
test('patched daemon applies desired scheduling in a real child fixture and reloads without changing its private sources', async ()=>fixture(async ({dir,configPath})=>{
  const bin=join(dir,'bin'); const {mkdir}=await import('node:fs/promises'); await mkdir(bin);
  const command=join(bin,'journalctl'); await writeFile(command,'#!/bin/sh\nprintf "\\n"\n',{mode:0o700});
  const desired=await configure(configPath); const child=spawn(process.execPath,[resolve('tools/d-obs-log-bridge.mjs')],{cwd:resolve('.'),env:{PATH:bin+':'+process.env.PATH,RDK_LOG_BRIDGE_TOKEN:'fixture-token-for-no-log-empty-source',RDK_LOG_BRIDGE_UNITS:'fixture.service',RDK_LOG_BRIDGE_STATE_DIR:join(dir,'state'),RDK_COLLECTION_BRIDGE_CONFIG:configPath,RDK_LOG_BRIDGE_POLL_MS:'1000',RDK_LOG_BRIDGE_FLUSH_MS:'1000',RDK_LOG_BRIDGE_BATCH:'1',RDK_LOG_BRIDGE_QUEUE:'512'},stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',data=>{stderr+=data.toString();}); const closed=once(child,'close');
  async function wait(version) { for(let index=0;index<300;index++) { try { const actual=await status(dir); if(actual.appliedVersion===version) return actual; } catch {} if(child.exitCode!==null) throw new Error('fixture daemon exited: '+stderr); await new Promise(done=>setTimeout(done,30)); } throw new Error('runtime acknowledgement was not observed'); }
  try {
    const actual=await wait(desired.version); assert.equal(actual.state,'applied'); assert.deepEqual(actual.sourceCounts,{journald:1,docker:0,file:0}); assert.deepEqual(actual.config,CONFIG);
    const next=await configure(configPath,{...CONFIG,pollMs:2000,flushMs:2000,batch:2}); const updated=await wait(next.version); assert.deepEqual(updated.config,{...CONFIG,pollMs:2000,flushMs:2000,batch:2});
    assert.deepEqual(updated.sourceCounts,actual.sourceCounts); assert.doesNotMatch(JSON.stringify(updated),/fixture.service|token|endpoint|PRIVATE/);
  } finally { child.kill('SIGTERM'); const timer=setTimeout(()=>child.kill('SIGKILL'),1000); await closed; clearTimeout(timer); }
}));
