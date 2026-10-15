/** Desired cloud collector tunables. Only the running bridge may acknowledge application. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const cloudBridgeTunablesSchema = z.object({ pollMs: z.number().int().min(1000).max(60000), flushMs: z.number().int().min(1000).max(60000), batch: z.number().int().min(1).max(512), queueLimit: z.number().int().min(512).max(20000) }).strict();
export type CloudBridgeTunables = z.infer<typeof cloudBridgeTunablesSchema>;
export const DEFAULT_CLOUD_BRIDGE_TUNABLES: CloudBridgeTunables = { pollMs: 5000, flushMs: 3000, batch: 100, queueLimit: 5000 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({ version: z.string().uuid(), hash: sha, updatedAt: z.string().datetime(), actorHash: sha, config: cloudBridgeTunablesSchema }).strict();
const payloadSchema = z.object({ schemaVersion: z.literal(1), desired: recordSchema, history: z.array(recordSchema).min(1).max(20) }).strict();
const envelopeSchema = z.object({ sha256: sha, payload: payloadSchema }).strict();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const numbers = z.object({ cycles: counter, pending: counter, dropped: counter, sent: counter, flushFailures: counter }).strict();
const receiptSchema = z.object({ schemaVersion: z.literal(1), state: z.enum(['applied', 'failed']), appliedVersion: z.union([z.literal('environment'), z.string().uuid()]), appliedAt: z.string().datetime(), updatedAt: z.string().datetime(), config: cloudBridgeTunablesSchema, counts: numbers, sourceCounts: z.object({ journald: z.number().int().min(0).max(10000), docker: z.number().int().min(0).max(10000), file: z.number().int().min(0).max(10000) }).strict(), errors: z.object({ configuration: z.number().int().min(0), receipt: z.number().int().min(0) }).strict(), reason: z.enum(['config_invalid', 'config_read_failed']).optional() }).strict();
type Options = { configPath?: string; now?: () => number };
export class CloudBridgeConfigError extends Error { constructor(public readonly code: string, public readonly status = 503) { super(code); this.name = 'CloudBridgeConfigError'; } }
function fail(code: string, status = 503): never { throw new CloudBridgeConfigError(code, status); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const queues = new Map<string, Promise<void>>();
const canonical = (value: CloudBridgeTunables): CloudBridgeTunables => ({ pollMs: value.pollMs, flushMs: value.flushMs, batch: value.batch, queueLimit: value.queueLimit });
function paths(options: Options) {
  const config = options.configPath ?? process.env.RDK_COLLECTION_BRIDGE_CONFIG ?? '/var/lib/d-obs-log-bridge/collection-config.json';
  if (!isAbsolute(config) || /[\x00-\x1f\x7f]/.test(config) || config.split('/').some(part => part === '..' || part === '.')) fail('cloud_bridge_invalid_path');
  return { config, receipt: join(dirname(config), 'collection-status.json') };
}
async function readPrivate(filename: string) {
  let file;
  try {
    const directory = await lstat(dirname(filename)); if (!directory.isDirectory() || directory.isSymbolicLink()) fail('cloud_bridge_state_invalid');
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) !== 0) fail('cloud_bridge_state_invalid');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } catch (error) { if (missing(error)) return null; fail('cloud_bridge_state_invalid'); }
  finally { await file?.close(); }
}
async function desired(filename: string) {
  const raw = await readPrivate(filename); if (raw === null) return null;
  const parsed = envelopeSchema.safeParse(raw); if (!parsed.success) fail('cloud_bridge_config_invalid');
  const { payload } = parsed.data;
  if (hash(JSON.stringify((raw as { payload: unknown }).payload)) !== parsed.data.sha256 || JSON.stringify(payload.desired) !== JSON.stringify(payload.history.at(-1)) || payload.history.some(row => hash(JSON.stringify(canonical(row.config))) !== row.hash) || new Set(payload.history.map(row => row.version)).size !== payload.history.length) fail('cloud_bridge_config_invalid');
  return payload;
}
async function save(filename: string, payload: z.infer<typeof payloadSchema>) {
  const dir = dirname(filename); await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) fail('cloud_bridge_state_invalid'); await chmod(dir, 0o700);
  try { const entry = await lstat(filename); if (!entry.isFile() || entry.isSymbolicLink()) fail('cloud_bridge_state_invalid'); } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(dir, '.collection-config-' + randomUUID() + '.tmp');
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const content = JSON.stringify({ sha256: hash(JSON.stringify(payload)), payload }); if (Buffer.byteLength(content) > 65536) fail('cloud_bridge_state_invalid');
    await file.writeFile(content); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, filename); const folder = await open(dir, constants.O_RDONLY); try { await folder.sync(); } finally { await folder.close(); }
  } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
}
export async function getCloudBridgeConfig(options: Options = {}) {
  const p = paths(options); let state; let configInvalid = false;
  try { state = await desired(p.config); } catch { configInvalid = true; }
  const current = state?.desired;
  let raw;
  try { raw = await readPrivate(p.receipt); } catch { return { state: 'failed' as const, config: current?.config ?? null, desiredVersion: current?.version, reason: 'daemon_status_invalid' }; }
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return { state: configInvalid || raw !== null ? 'failed' as const : 'unavailable' as const, config: current?.config ?? DEFAULT_CLOUD_BRIDGE_TUNABLES, desiredVersion: current?.version, updatedAt: current?.updatedAt, reason: configInvalid ? 'config_invalid' : raw === null ? 'daemon_status_missing' : 'daemon_status_invalid' };
  const receipt = parsed.data;
  const age = (options.now?.() ?? Date.now()) - Date.parse(receipt.updatedAt);
  const common = { config: current?.config ?? receipt.config, desiredConfig: current?.config, appliedConfig: receipt.config, desiredVersion: current?.version, appliedVersion: receipt.appliedVersion, updatedAt: receipt.updatedAt, counts: receipt.counts, sourceCounts: receipt.sourceCounts, errors: receipt.errors };
  if (configInvalid) return { state: 'failed' as const, ...common, reason: 'config_invalid' };
  if (age < -5000 || age > Math.max(receipt.config.pollMs, receipt.config.flushMs) * 3 + 15000) return { state: 'unavailable' as const, ...common, reason: 'daemon_status_stale' };
  if (receipt.state === 'failed') return { state: 'failed' as const, ...common, reason: receipt.reason ?? 'config_invalid' };
  const applied = !current || (receipt.appliedVersion === current.version && JSON.stringify(canonical(receipt.config)) === JSON.stringify(canonical(current.config)));
  return { state: applied ? 'applied' as const : 'pending' as const, ...common };
}
export async function updateCloudBridgeConfig(input: unknown, actor: string, options: Options = {}) {
  const validated = cloudBridgeTunablesSchema.safeParse(input); if (!validated.success) fail('cloud_bridge_invalid_config', 400);
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 500 || /[\x00-\x1f\x7f]/.test(actor)) fail('cloud_bridge_identity_required', 403);
  const p = paths(options); const previous = queues.get(p.config) ?? Promise.resolve(); let release!: () => void;
  const next = new Promise<void>(done => { release = done; }); queues.set(p.config, next); await previous;
  try {
    const stored = await desired(p.config); const config = canonical(validated.data);
    const record = { version: randomUUID(), hash: hash(JSON.stringify(config)), updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(), actorHash: hash(actor), config };
    const payload = { schemaVersion: 1 as const, desired: record, history: [...(stored?.history ?? []), record].slice(-20) };
    await save(p.config, payload); return await getCloudBridgeConfig(options);
  } catch (error) { if (error instanceof CloudBridgeConfigError) throw error; fail('cloud_bridge_update_failed'); }
  finally { release(); if (queues.get(p.config) === next) queues.delete(p.config); }
}
