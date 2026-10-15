/** Private daemon reload and acknowledgements; no endpoint or source configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const strict = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function normalizeCloudBridgeTunables(value) {
  if (!strict(value, ['pollMs', 'flushMs', 'batch', 'queueLimit'])) throw new Error('config_invalid');
  for (const [key, minimum, maximum] of [['pollMs',1000,60000],['flushMs',1000,60000],['batch',1,512],['queueLimit',512,20000]]) if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) throw new Error('config_invalid');
  return { pollMs: value.pollMs, flushMs: value.flushMs, batch: value.batch, queueLimit: value.queueLimit };
}
function validateRecord(row) {
  if (!strict(row,['version','hash','updatedAt','actorHash','config']) || !UUID.test(row.version) || !SHA.test(row.hash) || !SHA.test(row.actorHash) || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('config_invalid');
  const config = normalizeCloudBridgeTunables(row.config); if (hash(JSON.stringify(config)) !== row.hash) throw new Error('config_invalid');
}
async function readConfiguration(filename) {
  let file;
  try {
    const directory = await lstat(dirname(filename)); if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('config_invalid');
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat(); if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) !== 0) throw new Error('config_invalid');
    const raw = JSON.parse(await file.readFile('utf8'));
    if (!strict(raw,['sha256','payload']) || !SHA.test(raw.sha256) || !strict(raw.payload,['schemaVersion','desired','history']) || raw.payload.schemaVersion !== 1 || !Array.isArray(raw.payload.history) || !raw.payload.history.length || raw.payload.history.length > 20 || hash(JSON.stringify(raw.payload)) !== raw.sha256) throw new Error('config_invalid');
    validateRecord(raw.payload.desired); raw.payload.history.forEach(validateRecord);
    if (JSON.stringify(raw.payload.desired) !== JSON.stringify(raw.payload.history.at(-1)) || new Set(raw.payload.history.map(row => row.version)).size !== raw.payload.history.length) throw new Error('config_invalid');
    return raw.payload.desired;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(error.message === 'config_invalid' || error instanceof SyntaxError ? 'config_invalid' : 'config_read_failed'); }
  finally { await file?.close(); }
}
async function writeReceipt(filename, receipt) {
  const dir = dirname(filename); await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('receipt_unavailable'); await chmod(dir,0o700);
  try { const existing = await lstat(filename); if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('receipt_unavailable'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary=join(dir,'.collection-status-'+randomUUID()+'.tmp'); let file;
  try {
    file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await file.writeFile(JSON.stringify(receipt)); await file.sync(); await file.close(); file=undefined;
    await rename(temporary,filename); const folder=await open(dir,constants.O_RDONLY); try { await folder.sync(); } finally { await folder.close(); }
  } finally { await file?.close(); await unlink(temporary).catch(()=>{}); }
}
function safeCounts(input) {
  const output={};
  for (const key of ['cycles','pending','dropped','sent','flushFailures']) { const value=input?.[key]; output[key]=Number.isSafeInteger(value)&&value>=0 ? value : 0; }
  return output;
}
export class CloudBridgeRuntime {
  constructor({configPath=process.env.RDK_COLLECTION_BRIDGE_CONFIG||'/var/lib/d-obs-log-bridge/collection-config.json',initialConfig={pollMs:5000,flushMs:3000,batch:100,queueLimit:5000},sourceCounts={journald:0,docker:0,file:0},now=Date.now}={}) {
    if (!isAbsolute(configPath) || /[\x00-\x1f\x7f]/.test(configPath) || configPath.split('/').some(part=>part==='..'||part==='.')) throw new Error('config_invalid');
    this.configPath=configPath; this.receiptPath=join(dirname(configPath),'collection-status.json'); this.config=normalizeCloudBridgeTunables(initialConfig); this.version='environment'; this.now=now; this.appliedAt=new Date(now()).toISOString(); this.errors={configuration:0,receipt:0}; this.reason=undefined;
    this.sourceCounts=Object.fromEntries(['journald','docker','file'].map(key=>[key,Number.isSafeInteger(sourceCounts[key])&&sourceCounts[key]>=0&&sourceCounts[key]<=10000?sourceCounts[key]:0]));
  }
  async reload() {
    try {
      const desired=await readConfiguration(this.configPath);
      if (!desired && this.version!=='environment') throw new Error('config_read_failed');
      if (desired && desired.version===this.version && hash(JSON.stringify(this.config))!==desired.hash) throw new Error('config_invalid');
      if (desired && desired.version!==this.version) { this.config=normalizeCloudBridgeTunables(desired.config);this.version=desired.version;this.appliedAt=new Date(this.now()).toISOString(); }
      this.reason=undefined;
    } catch(error) { this.errors.configuration++;this.reason=error.message==='config_invalid'?'config_invalid':'config_read_failed'; }
    return {...this.config};
  }
  async publish(counts={}) {
    const receipt={schemaVersion:1,state:this.reason?'failed':'applied',appliedVersion:this.version,appliedAt:this.appliedAt,updatedAt:new Date(this.now()).toISOString(),config:{...this.config},counts:safeCounts(counts),sourceCounts:{...this.sourceCounts},errors:{...this.errors},...(this.reason?{reason:this.reason}:{})};
    try { await writeReceipt(this.receiptPath,receipt);return true; } catch { this.errors.receipt++;return false; }
  }
}
