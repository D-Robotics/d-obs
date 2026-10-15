import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudBridgeConfigError, DEFAULT_CLOUD_BRIDGE_TUNABLES, getCloudBridgeConfig, updateCloudBridgeConfig } from './collection-log-bridge-config.js';

const CONFIG = { pollMs: 2000, flushMs: 1000, batch: 256, queueLimit: 4096 };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const counts = { cycles: 3, pending: 1, dropped: 0, sent: 20, flushFailures: 0 };
async function fixture(action: (value: { dir: string; configPath: string; now: () => number }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-bridge-config-')); const configPath = join(dir, 'collection-config.json'); const time = Date.now();
  try { await action({ dir, configPath, now: () => time }); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function receipt(dir: string, config = DEFAULT_CLOUD_BRIDGE_TUNABLES, version = 'environment', time = Date.now()) {
  await writeFile(join(dir,'collection-status.json'), JSON.stringify({ schemaVersion: 1, state: 'applied', appliedVersion: version, appliedAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), config, counts, sourceCounts: { journald: 8, docker: 1, file: 1 }, errors: { configuration: 0, receipt: 0 } }), { mode: 0o600 });
}
test('server writes only a desired version; daemon receipt is required for applied state', async () => fixture(async options => {
  assert.equal((await getCloudBridgeConfig(options)).state, 'unavailable');
  const unavailable = await updateCloudBridgeConfig(CONFIG, 'fixture-operator', options);
  assert.equal(unavailable.state, 'unavailable'); assert.equal(unavailable.reason, 'daemon_status_missing');
  const stored = JSON.parse(await readFile(options.configPath,'utf8'));
  assert.equal(stored.payload.desired.hash, hash(JSON.stringify(CONFIG)));
  assert.equal(stored.payload.desired.actorHash,hash('fixture-operator'));
  assert.equal(stored.sha256,hash(JSON.stringify(stored.payload)));
  assert.doesNotMatch(JSON.stringify(stored), /fixture-operator|endpoint|token|source/);
  assert.equal((await stat(options.configPath)).mode & 0o777, 0o600);
  await receipt(options.dir, DEFAULT_CLOUD_BRIDGE_TUNABLES, 'environment', options.now());
  assert.equal((await getCloudBridgeConfig(options)).state, 'pending');
  await receipt(options.dir, CONFIG, stored.payload.desired.version, options.now());
  const applied = await getCloudBridgeConfig(options);
  assert.equal(applied.state,'applied'); assert.deepEqual(applied.counts,counts); assert.deepEqual(applied.sourceCounts,{journald:8,docker:1,file:1});
  await receipt(options.dir, DEFAULT_CLOUD_BRIDGE_TUNABLES, stored.payload.desired.version, options.now());
  assert.equal((await getCloudBridgeConfig(options)).state,'pending');
}));
test('strict bounded tunables reject source definitions, credentials, types, limits and unidentified actors', async () => fixture(async options => {
  for (const input of [{...CONFIG,url:'https://example.com'}, {...CONFIG,path:'/tmp/file'}, {...CONFIG,sources:[]}, {...CONFIG,token:'secret'}, {...CONFIG,pollMs:999}, {...CONFIG,flushMs:60001}, {...CONFIG,batch:513}, {...CONFIG,queueLimit:20001}, {...CONFIG,queueLimit:511}, {...CONFIG,batch:1.5}, {...CONFIG,pollMs:'2000'}, {batch:100}]) await assert.rejects(updateCloudBridgeConfig(input,'operator',options), error => error instanceof CloudBridgeConfigError && error.status === 400);
  for (const actor of ['', ' ', 'operator\nsecret']) await assert.rejects(updateCloudBridgeConfig(CONFIG,actor,options), error => error instanceof CloudBridgeConfigError && error.status === 403);
  assert.equal((await getCloudBridgeConfig(options)).state,'unavailable');
}));
test('serialized desired writes persist only the latest twenty complete audit records', async () => fixture(async options => {
  await Promise.all(Array.from({length:30},(_,index)=>updateCloudBridgeConfig({...CONFIG,batch:index+1},'actor-'+index,options)));
  const stored=JSON.parse(await readFile(options.configPath,'utf8'));
  assert.equal(stored.payload.history.length,20); assert.equal(stored.payload.history[0].config.batch,11); assert.equal(stored.payload.desired.config.batch,30);
  assert.equal(new Set(stored.payload.history.map((item: {version:string})=>item.version)).size,20);
  assert.equal(stored.sha256,hash(JSON.stringify(stored.payload)));
}));
test('corrupted or public state is fail-closed and never overwritten as a fresh configuration', async () => fixture(async options => {
  const desired=await updateCloudBridgeConfig(CONFIG,'operator',options);
  await receipt(options.dir,CONFIG,desired.desiredVersion,options.now());
  const before=await readFile(options.configPath,'utf8'); await writeFile(options.configPath,before.replace('"batch":256','"batch":257'));
  assert.equal((await getCloudBridgeConfig(options)).state,'failed');
  assert.deepEqual((await getCloudBridgeConfig(options)).config,CONFIG);
  await assert.rejects(updateCloudBridgeConfig(CONFIG,'operator',options),CloudBridgeConfigError);
  assert.notEqual(await readFile(options.configPath,'utf8'),before);
  await writeFile(options.configPath,before); await chmod(options.configPath,0o644);
  assert.equal((await getCloudBridgeConfig(options)).state,'failed');
  await assert.rejects(updateCloudBridgeConfig(CONFIG,'operator',options),CloudBridgeConfigError);
}));
test('symlink state is refused; stale or malformed daemon receipts never claim application', async () => fixture(async options => {
  const outside=join(options.dir,'outside'); await writeFile(outside,'do not overwrite',{mode:0o600}); await symlink(outside,options.configPath);
  await assert.rejects(updateCloudBridgeConfig(CONFIG,'operator',options),CloudBridgeConfigError); assert.equal(await readFile(outside,'utf8'),'do not overwrite');
  await rm(options.configPath); const updated=await updateCloudBridgeConfig(CONFIG,'operator',options);
  await receipt(options.dir,CONFIG,updated.desiredVersion,options.now()-120000);
  assert.equal((await getCloudBridgeConfig(options)).state,'unavailable');
  await writeFile(join(options.dir,'collection-status.json'),'{}',{mode:0o600});
  assert.equal((await getCloudBridgeConfig(options)).state,'failed');
  const alias=join(options.dir,'alias'); await symlink(options.dir,alias);
  const unsafe={...options,configPath:join(alias,'collection-config.json')};
  assert.equal((await getCloudBridgeConfig(unsafe)).state,'failed');
  await assert.rejects(updateCloudBridgeConfig(CONFIG,'operator',unsafe),CloudBridgeConfigError);
}));
