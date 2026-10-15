/** Server-to-server camera actor assertions. They confer no platform administrator authority. */
import type { Request, RequestHandler } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { VisionDeviceRegistry } from './vision-workshop-device.js';
import { VisionWorkshopError } from './vision-workshop-service.js';
import { VISION_WORKSHOP_API, VISION_WORKSHOP_MCP } from './vision-workshop-operations.js';

export const VISION_BRIDGE_ASSERTION_HEADER = 'x-rdk-camera-assertion';
export const VISION_BRIDGE_SIGNATURE_HEADER = 'x-rdk-camera-signature';
export const VISION_BRIDGE_MAX_AGE_SECONDS = 60;
const NONCE_CAPACITY = 4096;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type BindingHeaders = { contentType: string; sample: string; result: string; readOnly: string; action: string };
export type VisionActorAssertion = {
  v: 1; iss: 'rdk-studio'; aud: 'd-obs-camera'; sub: string; iat: number; exp: number; nonce: string;
  method: 'GET' | 'POST'; target: string; bodyKind: 'empty' | 'json' | 'binary'; bodySha256: string; headers: BindingHeaders;
};
type TrustedActor = { request: Request; owner: string; sub: string; adapterIds: readonly string[] };
const actors = new WeakMap<object, TrustedActor>();
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function denied(code = 'vision_bridge_not_authorized'): never { throw new Error(code); }

/** Cross-repository canonical JSON: UTF-16 key sort, array order, JSON primitives. */
export function visionBridgeCanonicalJson(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 500_000 || depth > 64) return denied();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(row => visit(row, depth + 1)).join(',') + ']';
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return '{' + Object.keys(item).sort(compare).map(key => JSON.stringify(key) + ':' + visit((item as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
    }
    return denied();
  };
  return visit(value, 0);
}

/** Sign the upstream API target, without an nginx deployment prefix. */
export function visionBridgeCanonicalTarget(target: string): string {
  if (!safeText(target, 16384) || !target.startsWith('/') || target.startsWith('//') || /[\\#]/.test(target)) return denied();
  const url = new URL(target, 'http://camera.invalid');
  const query = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => compare(a, b) || compare(av, bv));
  const search = new URLSearchParams(query).toString();
  return url.pathname + (search ? '?' + search : '');
}
export function isVisionBridgeScope(target: string): boolean {
  try { const pathname = visionBridgeCanonicalTarget(target).split('?')[0]; return pathname === VISION_WORKSHOP_MCP || pathname === VISION_WORKSHOP_API || pathname.startsWith(VISION_WORKSHOP_API + '/'); } catch { return false; }
}
export function visionBridgeRequestBinding(req: Pick<Request, 'method' | 'originalUrl' | 'url' | 'body' | 'header'>): Pick<VisionActorAssertion, 'method' | 'target' | 'bodyKind' | 'bodySha256' | 'headers'> {
  if (!['GET', 'POST'].includes(req.method)) return denied();
  const contentType = (req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  let bodyKind: VisionActorAssertion['bodyKind']; let bytes: Buffer;
  if (req.method === 'GET') { bodyKind = 'empty'; bytes = Buffer.alloc(0); }
  else if (Buffer.isBuffer(req.body)) { bodyKind = 'binary'; bytes = req.body; }
  else if (contentType === 'application/json' && req.body !== undefined) { bodyKind = 'json'; bytes = Buffer.from(visionBridgeCanonicalJson(req.body)); }
  else if (req.body === undefined || req.body === null) { bodyKind = 'empty'; bytes = Buffer.alloc(0); }
  else return denied();
  return { method: req.method as 'GET' | 'POST', target: visionBridgeCanonicalTarget(req.originalUrl || req.url), bodyKind, bodySha256: digest(bytes), headers: { contentType, sample: req.header('x-vision-sample') ?? '', result: req.header('x-vision-result') ?? '', readOnly: req.header('x-rdk-ops-read-only') ?? '', action: req.header('x-rdk-ops-action') ?? '' } };
}
function actor(req: Request): TrustedActor | undefined {
  // executePlatformOperation inherits the actual request with Object.create(req).
  // The WeakMap is private: headers and user-supplied properties cannot mint a principal.
  let node: object | null = req;
  for (let depth = 0; node && depth < 32; depth++, node = Object.getPrototypeOf(node)) { const found = actors.get(node); if (found) return found; }
  return undefined;
}
function permittedAdapters(sub: string): string[] {
  let owners: unknown;
  try { owners = JSON.parse(process.env.RDK_VISION_BRIDGE_ADAPTER_OWNERS || '{}'); } catch { return denied('vision_bridge_config_invalid'); }
  if (!owners || typeof owners !== 'object' || Array.isArray(owners) || Object.keys(owners).length > 100) return denied('vision_bridge_config_invalid');
  const allowed: string[] = [];
  for (const [id, subjects] of Object.entries(owners)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !Array.isArray(subjects) || subjects.length > 100 || subjects.some(item => !safeText(item, 256) || !item || /\s/.test(item))) return denied('vision_bridge_config_invalid');
    if (subjects.includes(sub)) allowed.push(id);
  }
  return allowed;
}
/** Immutable fixed slots bound capacity without a crash-prone cross-process lock. */
async function claimNonce(assertion: VisionActorAssertion, _verifiedAt: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (assertion.exp <= now) return denied('vision_bridge_assertion_expired');
  const state = process.env.RDK_VISION_BRIDGE_STATE_DIR;
  if (!state || !path.isAbsolute(state)) return denied('vision_bridge_config_invalid');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const checkDirectory = async (directory: string) => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid() || await realpath(directory) !== path.resolve(directory)) return denied('vision_bridge_config_invalid');
  };
  await checkDirectory(state);
  const buckets = await readdir(state);
  if (buckets.length > 8) return denied('vision_bridge_nonce_capacity');
  for (const name of buckets) {
    if (!/^[0-9]{1,12}\.bucket$/.test(name)) return denied('vision_bridge_config_invalid');
    const directory = path.join(state, name); await checkDirectory(directory);
    // Never remove or recycle a slot while an assertion in its iat bucket could remain valid.
    if ((Number(name.split('.')[0]) + 1) * 60 < now - 120) await rm(directory, { recursive: true, force: true });
  }
  const directory = path.join(state, Math.floor(assertion.iat / 60) + '.bucket');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await checkDirectory(directory);
  const nonce = digest(assertion.iss + '\0' + assertion.nonce);
  const start = parseInt(nonce.slice(0, 8), 16) % NONCE_CAPACITY;
  for (let attempt = 0; attempt < NONCE_CAPACITY; attempt++) {
    const filename = path.join(directory, ((start + attempt) % NONCE_CAPACITY).toString(16).padStart(4, '0') + '.nonce');
    let descriptor;
    try { descriptor = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (descriptor) {
      try { await descriptor.writeFile(nonce + '\n'); await descriptor.sync(); } finally { await descriptor.close(); }
      return;
    }
    // A concurrent creator may not yet have written its immutable slot. Never skip it,
    // because concurrent replays of that nonce must follow exactly the same probe chain.
    let existing = '';
    for (let wait = 0; wait < 6; wait++) {
      const reader = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await reader.stat();
        if (!info.isFile() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid() || info.size > 65) return denied('vision_bridge_config_invalid');
        const bytes = Buffer.alloc(66); const result = await reader.read(bytes, 0, bytes.length, 0); existing = bytes.subarray(0, result.bytesRead).toString('ascii');
      } finally { await reader.close(); }
      if (/^[a-f0-9]{64}\n$/.test(existing)) break;
      if (existing) return denied('vision_bridge_config_invalid');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!existing) return denied('vision_bridge_nonce_store_busy');
    if (existing === nonce + '\n') return denied('vision_bridge_replay');
  }
  return denied('vision_bridge_nonce_capacity');
}

async function verify(req: Request, preflight = false): Promise<TrustedActor> {
  const remote = req.socket?.remoteAddress;
  if (!(remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1')) return denied();
  if (!isVisionBridgeScope(req.originalUrl || req.url)) return denied('vision_bridge_scope_denied');
  const secret = process.env.RDK_VISION_BRIDGE_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096 || /[\x00-\x1f\x7f]/.test(secret)) return denied('vision_bridge_config_invalid');
  const encoded = req.header(VISION_BRIDGE_ASSERTION_HEADER) ?? ''; const signature = req.header(VISION_BRIDGE_SIGNATURE_HEADER) ?? '';
  if (!/^[A-Za-z0-9_-]{1,32768}$/.test(encoded) || !/^[a-f0-9]{64}$/.test(signature)) return denied();
  const expected = createHmac('sha256', secret).update(encoded).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return denied();
  let value: unknown; const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || !Buffer.from(bytes.toString('utf8')).equals(bytes)) return denied();
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return denied(); }
  if (visionBridgeCanonicalJson(value) !== bytes.toString('utf8') || !value || typeof value !== 'object' || Array.isArray(value)) return denied();
  const row = value as Record<string, unknown>;
  const keys = ['v', 'iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'method', 'target', 'bodyKind', 'bodySha256', 'headers'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)) || row.v !== 1 || row.iss !== 'rdk-studio' || row.aud !== 'd-obs-camera' || !safeText(row.sub, 256) || !row.sub || /\s/.test(row.sub) || !Number.isSafeInteger(row.iat) || !Number.isSafeInteger(row.exp) || typeof row.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(row.nonce)) return denied();
  const now = Math.floor(Date.now() / 1000);
  if (Number(row.iat) > now + 30 || Number(row.exp) <= now || Number(row.exp) <= Number(row.iat) || Number(row.exp) - Number(row.iat) > VISION_BRIDGE_MAX_AGE_SECONDS) return denied('vision_bridge_assertion_expired');
  const binding = visionBridgeRequestBinding(preflight ? { method: req.method, originalUrl: req.originalUrl, url: req.url, body: undefined, header: req.header.bind(req) } : req);
  for (const key of (preflight ? ['method', 'target', 'headers'] : ['method', 'target', 'bodyKind', 'bodySha256', 'headers']) as Array<keyof typeof binding>) if (visionBridgeCanonicalJson(row[key]) !== visionBridgeCanonicalJson(binding[key])) return denied('vision_bridge_request_mismatch');
  const adapterIds = permittedAdapters(row.sub); if (!preflight) await claimNonce(row as VisionActorAssertion, now);
  return { request: req, owner: 'sso:' + row.sub, sub: row.sub, adapterIds };
}

function accessGuard(preflight: boolean): RequestHandler { return (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const inherited = actor(req);
  if (inherited) {
    if (!isVisionBridgeScope(req.originalUrl || req.url)) { res.status(403).json({ ok: false, error: 'vision_bridge_scope_denied' }); return; }
    next(); return;
  }
  if (!req.header(VISION_BRIDGE_ASSERTION_HEADER) && !req.header(VISION_BRIDGE_SIGNATURE_HEADER)) { requireSshLogAccess(req, res, next); return; }
  void verify(req, preflight).then(principal => { if (!preflight) actors.set(req, principal); next(); }).catch(error => {
    const code = error instanceof Error && /^vision_bridge_[a-z_]+$/.test(error.message) ? error.message : 'vision_bridge_not_authorized';
    res.status(code.includes('config_invalid') || code.includes('nonce_store_busy') || code.includes('nonce_capacity') ? 503 : 403).json({ ok: false, error: code });
  });
}; }
export const requireVisionWorkshopAccess = accessGuard(false);
/** Reject anonymous/invalid assertions before allocating the bounded binary upload. */
export const requireVisionWorkshopUploadAccess = accessGuard(true);
export function visionWorkshopOwner(req: Request): string { return actor(req)?.owner ?? sessionOwner(req); }
export function visionWorkshopDevices(req: Request, registry: VisionDeviceRegistry): VisionDeviceRegistry {
  const principal = actor(req); if (!principal) return registry;
  const allowed = new Set(principal.adapterIds);
  return new VisionDeviceRegistry(registry.list().filter(profile => allowed.has(profile.id)).map(profile => ({ profile, execute: async (operation, context, inputs) => {
    // Background AI sessions must also observe a server-side assignment revocation.
    if (!permittedAdapters(principal.sub).includes(profile.id)) throw new VisionWorkshopError('vision_device_adapter_unavailable', 'Camera adapter assignment is unavailable', 503);
    return registry.get(profile.id).execute(operation, context, inputs);
  } })));
}
