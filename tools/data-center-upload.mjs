#!/usr/bin/env node
/** Upload one real file using a collection task's scoped token. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_DATA_ASSET_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESPONSE_LIMIT = 64 * 1024;

export class DataCenterUploadError extends Error {
  constructor(code, { httpStatus, outcomeUnknown = false } = {}) {
    super(code);
    this.name = 'DataCenterUploadError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.outcomeUnknown = outcomeUnknown;
  }
}
function fail(code, context) { throw new DataCenterUploadError(code, context); }

export function validateDataCenterOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || CONTROL.test(value) || value.includes('\\')) fail('invalid_origin');
  // URL parsing normalizes dot segments; reject traversal before normalization.
  let raw;
  try { raw = decodeURIComponent(value); } catch { fail('invalid_origin'); }
  if (CONTROL.test(raw) || raw.includes('\\') || /%(?:2f|5c)/i.test(value) || /%[0-9a-f]{2}/i.test(raw) || raw.split(/[/?#]/).some(part => part === '.' || part === '..')) fail('invalid_origin');
  let url;
  try { url = new URL(value); } catch { fail('invalid_origin'); }
  if (url.username || url.password || url.search || url.hash || /\/\//.test(url.pathname)) fail('invalid_origin');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail('https_required');
  return url.href.replace(/\/$/, '');
}

export function parseDataCenterUploadArgs(argv) {
  const keys = new Map([['--origin', 'origin'], ['--task', 'taskId'], ['--file', 'filePath'], ['--title', 'title']]);
  const result = {};
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || result[key] !== undefined || typeof argv[index + 1] !== 'string' || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('invalid_arguments');
    result[key] = argv[index + 1];
  }
  if (!result.origin || !result.taskId || !result.filePath) fail('missing_arguments');
  return result;
}

async function readDataAsset(filePath) {
  if (typeof filePath !== 'string' || !filePath || CONTROL.test(filePath) || filePath.split(/[\/\\]/).includes('..')) fail('invalid_file');
  const fullPath = resolve(filePath);
  const filename = basename(fullPath);
  if (!filename || filename.length > 200 || CONTROL.test(filename) || filename.includes('\\')) fail('invalid_filename');
  let handle;
  try {
    const entry = await lstat(fullPath);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('regular_file_required');
    handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('regular_file_required');
    if (!before.size) fail('empty_file');
    if (before.size > MAX_DATA_ASSET_BYTES) fail('file_too_large');
    const chunks = []; const hash = createHash('sha256'); let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_DATA_ASSET_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_DATA_ASSET_BYTES) fail('file_too_large');
      const bytes = chunk.subarray(0, bytesRead);
      chunks.push(bytes); hash.update(bytes);
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('file_changed_during_read');
    return { bytes: Buffer.concat(chunks, size), filename, sha256: hash.digest('hex'), byteLength: size };
  } catch (error) {
    if (error instanceof DataCenterUploadError) throw error;
    fail('file_unreadable');
  } finally { await handle?.close(); }
}

async function readReceipt(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('invalid_response', { httpStatus: response.status, outcomeUnknown: true });
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_response', { httpStatus: response.status, outcomeUnknown: true });
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) fail('response_too_large', { httpStatus: response.status, outcomeUnknown: true });
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { fail('invalid_response', { httpStatus: response.status, outcomeUnknown: true }); }
}

export async function uploadDataCenterAsset(input, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const origin = validateDataCenterOrigin(input?.origin);
  if (typeof input.taskId !== 'string' || !UUID.test(input.taskId)) fail('invalid_task_id');
  const token = env.RDK_DATA_COLLECTION_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('collection_token_required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('invalid_timeout');
  const file = await readDataAsset(input.filePath);
  const title = input.title ?? file.filename.slice(0, 160);
  if (typeof title !== 'string' || !title.trim() || title.length > 160 || CONTROL.test(title)) fail('invalid_title');
  const metadata = { title: title.trim(), filename: file.filename, mimeType: 'application/octet-stream', sha256: file.sha256 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/api/data-center/ingest/${input.taskId}`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/octet-stream', 'x-collection-token': token, 'x-data-asset': encodeURIComponent(JSON.stringify(metadata)) },
      body: file.bytes,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      fail(status === 401 || status === 403 ? 'collection_unauthorized' : status === 413 ? 'upload_too_large' : status === 422 ? 'upload_checksum_rejected' : status === 409 ? 'upload_conflict' : status >= 500 ? 'server_error' : 'upload_rejected', { httpStatus: status, outcomeUnknown: status >= 500 || status === 408 });
    }
    const body = await readReceipt(response);
    const asset = body?.asset;
    if (body?.ok !== true || body.contract !== 'rdk.data-center.v1' || !asset || typeof asset.id !== 'string' || !UUID.test(asset.id)) fail('invalid_receipt', { httpStatus: response.status, outcomeUnknown: true });
    if (typeof asset.sha256 !== 'string' || !HASH.test(asset.sha256) || asset.sha256 !== file.sha256 || asset.sizeBytes !== file.byteLength) fail('receipt_checksum_mismatch', { httpStatus: response.status, outcomeUnknown: true });
    return { id: asset.id, hash: file.sha256, bytes: file.byteLength, httpStatus: response.status };
  } catch (error) {
    if (error instanceof DataCenterUploadError) throw error;
    fail(controller.signal.aborted ? 'upload_timeout' : 'upload_transport_error', { outcomeUnknown: true });
  } finally { clearTimeout(timer); }
}

export async function dataCenterUploadMain(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  try {
    const input = parseDataCenterUploadArgs(argv);
    if (input.help) {
      stdout.write('Usage: RDK_DATA_COLLECTION_TOKEN=<task token> node tools/data-center-upload.mjs --origin https://rdkstudio.d-robotics.cc/dobs --task <UUID> --file <file> [--title <title>]\nUse a task-scoped token from the environment; no token argument is accepted.\n');
      return 0;
    }
    stdout.write(JSON.stringify(await uploadDataCenterAsset(input, dependencies)) + '\n');
    return 0;
  } catch (error) {
    const safe = error instanceof DataCenterUploadError ? error : new DataCenterUploadError('upload_failed');
    stderr.write(JSON.stringify({ error: safe.code, ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}), outcome: safe.outcomeUnknown ? 'unknown' : 'rejected' }) + '\n');
    if (safe.outcomeUnknown) stderr.write('Upload outcome is unknown. Query the collection task and asset catalog before retrying; this client does not retry.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await dataCenterUploadMain();
