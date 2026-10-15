#!/usr/bin/env node
/** Private, operator-configured SDK bridge. No sensor commands are built in. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VISION_RUNNER_CONTRACT = 'rdk.vision-device-runner.v1';
const OPERATIONS = ['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning', 'preview_start', 'preview_stop', 'preview_frame', 'capture_frame', 'controls_get', 'controls_set', 'restore_tuning'];
const MIB = 1024 * 1024;
const MAX_REQUEST = 96 * MIB;
const MAX_RAW = 64 * MIB;
const MAX_IMAGE = 16 * MIB;
const MAX_OUTPUT = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const IDENTITY_FIELDS = ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'];
class RunnerError extends Error {
  constructor(code, status = 400) { super(`vision_runner_${code}`); this.code = `vision_runner_${code}`; this.status = status; }
}
function fail(code, status = 400) { throw new RunnerError(code, status); }
function record(value, keys, code = 'invalid_input') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (keys && Object.keys(value).some(key => !keys.includes(key)))) fail(code);
  return value;
}
function text(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) fail('invalid_input');
  return value.trim();
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid_input');
  return value;
}
function assertHash(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash'); return value; }
function jsonTree(value, maxBytes = MIB) {
  let nodes = 0; let bytes = 0; const active = new Set();
  const walk = (item, depth) => {
    if (++nodes > 50_000 || depth > 32) fail('invalid_json');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('invalid_json'); return item; }
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > maxBytes || CONTROL.test(item.replace(/[\r\n\t]/g, ''))) fail('invalid_json'); return item; }
    if (!item || typeof item !== 'object' || active.has(item)) fail('invalid_json');
    active.add(item);
    const output = Array.isArray(item) ? [] : {};
    for (const [key, entry] of Object.entries(item)) {
      bytes += Buffer.byteLength(key);
      if (bytes > maxBytes || !key || CONTROL.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid_json');
      output[key] = walk(entry, depth + 1);
    }
    active.delete(item);
    return output;
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('invalid_json');
  return result;
}
function decodeBase64(value, maximum) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4) fail('invalid_base64');
  // A repeated four-byte regex exhausts the V8 regexp stack on large frames.
  const unpadded = value.endsWith('==') ? value.slice(0, -2) : value.endsWith('=') ? value.slice(0, -1) : value;
  if (/[^A-Za-z0-9+/]/.test(unpadded)) fail('invalid_base64');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) fail('invalid_base64');
  return bytes;
}
function filename(value) {
  const name = text(value, 200);
  if (name === '.' || name === '..' || /[\/\\]/.test(name)) fail('invalid_filename');
  return name;
}
function rawMetadata(value, byteLength) {
  const input = record(value, ['scene', 'width', 'height', 'bitDepth', 'bayer', 'packing', 'stride', 'blackLevel', 'whiteLevel', 'exposureUs', 'gain']);
  const scene = text(input.scene); const width = integer(input.width, 2, 8192); const height = integer(input.height, 2, 8192);
  if (width % 2 || height % 2 || width * height > 32 * MIB || ![8, 10, 12, 14, 16].includes(input.bitDepth)
    || !['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(input.bayer) || !['unpacked16le', 'mipi-raw10', 'mipi-raw12'].includes(input.packing)) fail('invalid_raw_metadata');
  if (input.packing === 'mipi-raw10' && (input.bitDepth !== 10 || width % 4)) fail('invalid_raw_metadata');
  if (input.packing === 'mipi-raw12' && input.bitDepth !== 12) fail('invalid_raw_metadata');
  const rowBytes = input.packing === 'unpacked16le' ? width * 2 : input.packing === 'mipi-raw10' ? width / 4 * 5 : width / 2 * 3;
  const stride = integer(input.stride, rowBytes, rowBytes + 4096);
  const blackLevel = integer(input.blackLevel, 0, 2 ** input.bitDepth - 2);
  const whiteLevel = integer(input.whiteLevel, blackLevel + 1, 2 ** input.bitDepth - 1);
  if (stride * height !== byteLength || byteLength > MAX_RAW) fail('invalid_raw_byte_count');
  const result = { scene, width, height, bitDepth: input.bitDepth, bayer: input.bayer, packing: input.packing, stride, blackLevel, whiteLevel };
  for (const [key, maximum] of [['exposureUs', 60_000_000], ['gain', 65_536]]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] <= 0 || input[key] > maximum) fail('invalid_raw_metadata');
      result[key] = input[key];
    }
  }
  return result;
}
function validateRawPixels(bytes, metadata) {
  if (metadata.packing !== 'unpacked16le' || metadata.bitDepth === 16) return;
  const maximum = 2 ** metadata.bitDepth - 1;
  for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
    const offset = y * metadata.stride + x * 2;
    if ((bytes[offset] | bytes[offset + 1] << 8) > maximum) fail('invalid_raw_bit_depth');
  }
}
function normalizeConfig(input) {
  const config = record(input, ['token', ...IDENTITY_FIELDS, 'host', 'port', 'jobRoot', 'timeoutMs', 'commands'], 'invalid_config');
  if (typeof config.token !== 'string' || !/^[\x21-\x7e]{24,4096}$/.test(config.token)) fail('invalid_config');
  const identity = Object.fromEntries(IDENTITY_FIELDS.flatMap((key, index) => {
    if (index >= 3 && config[key] === undefined) return [];
    const value = text(config[key], 120);
    if (value !== config[key]) fail('invalid_config');
    return [[key, value]];
  }));
  const commands = record(config.commands ?? {}, OPERATIONS, 'invalid_config');
  const timeoutMs = config.timeoutMs === undefined ? 110_000 : integer(config.timeoutMs, 1, 120_000);
  const normalized = {};
  for (const [operation, command] of Object.entries(commands)) {
    const row = record(command, ['argv', 'timeoutMs'], 'invalid_config');
    if (!Array.isArray(row.argv) || !row.argv.length || row.argv.length > 64 || typeof row.argv[0] !== 'string' || !isAbsolute(row.argv[0])) fail('invalid_config');
    const argv = row.argv.map(argument => {
      if (typeof argument !== 'string' || argument.length > 4096 || CONTROL.test(argument)) fail('invalid_config');
      for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
        if (!['jobDir', 'requestFile', 'rawFile', 'tuningFile'].includes(match[1])) fail('invalid_config');
        if (match[1] === 'rawFile' && operation !== 'process_raw') fail('invalid_config');
        if (match[1] === 'tuningFile' && !['process_raw', 'apply_tuning', 'restore_tuning'].includes(operation)) fail('invalid_config');
      }
      if (/[{}]/.test(argument.replace(/\{(?:jobDir|requestFile|rawFile|tuningFile)\}/g, ''))) fail('invalid_config');
      return argument;
    });
    if (/[{}]/.test(argv[0])) fail('invalid_config');
    normalized[operation] = { argv, timeoutMs: row.timeoutMs === undefined ? timeoutMs : integer(row.timeoutMs, 1, 120_000) };
  }
  const host = config.host === undefined ? '127.0.0.1' : text(config.host, 255);
  const port = config.port === undefined ? 3215 : integer(config.port, 0, 65535);
  const jobRoot = resolve(config.jobRoot === undefined ? 'var/vision-device-runner/jobs' : text(config.jobRoot, 4096));
  return { token: config.token, ...identity, host, port, jobRoot, commands: normalized };
}
function cameraControls(input) {
  const rows = record(input, undefined, 'invalid_camera_controls'); const output = {};
  if (Object.keys(rows).length > 64) fail('invalid_camera_controls', 502);
  for (const [key, descriptor] of Object.entries(rows)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid_camera_controls', 502);
    const row = record(descriptor, ['value', 'min', 'max', 'step', 'writable', 'active', 'nativeName', 'unit'], 'invalid_camera_controls');
    if (typeof row.writable !== 'boolean' || row.active !== undefined && typeof row.active !== 'boolean') fail('invalid_camera_controls', 502);
    if (typeof row.value === 'boolean') { if (['min', 'max', 'step'].some(field => row[field] !== undefined)) fail('invalid_camera_controls', 502); }
    else if (![row.value, row.min, row.max].every(number => typeof number === 'number' && Number.isFinite(number)) || row.min > row.max || row.value < row.min || row.value > row.max || row.step !== undefined && (typeof row.step !== 'number' || !Number.isFinite(row.step) || row.step <= 0)) fail('invalid_camera_controls', 502);
    for (const field of ['nativeName', 'unit']) if (row[field] !== undefined) text(row[field], 120);
    output[key] = { ...row };
  }
  return output;
}
function controlValues(input) {
  const values = record(input); if (!Object.keys(values).length || Object.keys(values).length > 64) fail('invalid_control_values');
  for (const [key, value] of Object.entries(values)) if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || !(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) fail('invalid_control_values');
  return { ...values };
}
function normalizeRequest(body, config) {
  const input = record(body, ['contract', 'operation', 'context', 'inputs']);
  if (input.contract !== VISION_RUNNER_CONTRACT || !OPERATIONS.includes(input.operation)) fail('invalid_contract');
  const context = record(input.context, ['jobId', 'experimentId', ...IDENTITY_FIELDS]);
  if (typeof context.jobId !== 'string' || typeof context.experimentId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(context.jobId) || !/^[A-Za-z0-9_-]{1,128}$/.test(context.experimentId)
    || !IDENTITY_FIELDS.every(key => context[key] === config[key])) fail('profile_mismatch', 409);
  if (!config.commands[input.operation]) fail('operation_unavailable', 503);
  const operation = input.operation; let inputs; let rawBytes;
  if (['probe', 'pipeline_validate', 'bringup', 'preview_start', 'preview_stop', 'preview_frame', 'controls_get'].includes(operation)) inputs = record(input.inputs, []);
  else if (operation === 'capture_frame') { const row = record(input.inputs, ['scene']); inputs = row.scene === undefined ? {} : { scene: text(row.scene, 120) }; }
  else if (operation === 'controls_set') { const row = record(input.inputs, ['values']); inputs = { values: controlValues(row.values) }; }
  else if (operation === 'capture_raw') inputs = { scene: text(record(input.inputs, ['scene']).scene) };
  else {
    const row = record(input.inputs, operation === 'process_raw' ? ['raw', 'tuning', 'tuningHash'] : ['tuning', 'tuningHash']);
    const tuning = jsonTree(record(row.tuning)); const tuningHash = assertHash(row.tuningHash);
    if (hash(JSON.stringify(tuning)) !== tuningHash) fail('tuning_hash_mismatch');
    inputs = { tuning, tuningHash };
    if (operation === 'process_raw') {
      const raw = record(row.raw, ['filename', 'metadata', 'sha256', 'contentBase64']);
      rawBytes = decodeBase64(raw.contentBase64, MAX_RAW); const sha256 = assertHash(raw.sha256);
      if (hash(rawBytes) !== sha256) fail('raw_hash_mismatch');
      const metadata = rawMetadata(raw.metadata, rawBytes.length); validateRawPixels(rawBytes, metadata);
      // Commands read bytes from {rawFile}; request.json remains a small manifest.
      inputs.raw = { filename: filename(raw.filename), metadata, sha256 };
    }
  }
  return { contract: VISION_RUNNER_CONTRACT, operation, context: { ...context }, inputs, rawBytes };
}

async function readBoundedFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) fail('result_file_limit', 502);
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) {
      const next = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) fail('result_file_changed', 502);
      offset += next.bytesRead;
    }
    const extra = Buffer.alloc(1); const next = await file.read(extra, 0, 1, offset);
    if (next.bytesRead) fail('result_file_limit', 502);
    return bytes;
  } finally { await file.close(); }
}
async function readArtifact(jobDir, value, maximum) {
  if (typeof value !== 'string' || !value || value.length > 512 || CONTROL.test(value) || isAbsolute(value) || value.includes('\\')) fail('unsafe_artifact', 502);
  const pieces = value.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..')) fail('unsafe_artifact', 502);
  let path = jobDir;
  for (const piece of pieces) {
    path = join(path, piece);
    if ((await lstat(path)).isSymbolicLink()) fail('unsafe_artifact', 502);
  }
  if (!resolve(path).startsWith(resolve(jobDir) + sep)) fail('unsafe_artifact', 502);
  return readBoundedFile(path, maximum);
}
async function artifactBytes(result, jobDir, maximum) {
  if ((result.contentBase64 === undefined) === (result.artifactFile === undefined)) fail('invalid_result', 502);
  const bytes = result.artifactFile === undefined ? decodeBase64(result.contentBase64, maximum) : await readArtifact(jobDir, result.artifactFile, maximum);
  if (!bytes.length) fail('invalid_result', 502);
  const sha256 = hash(bytes);
  if (result.sha256 !== undefined && assertHash(result.sha256) !== sha256) fail('result_hash_mismatch', 502);
  return { bytes, sha256 };
}
function imageSize(bytes, mimeType) {
  let width; let height;
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) fail('invalid_image', 502);
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) fail('invalid_image', 502);
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) fail('invalid_image', 502);
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) fail('invalid_image', 502);
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) fail('invalid_image', 502);
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32 * MIB) fail('invalid_image', 502);
  return { width, height };
}
async function normalizeResult(value, request, jobDir) {
  const operation = request.operation;
  if (operation === 'controls_get' || operation === 'controls_set') {
    const row = record(value, ['controls', 'evidence'], 'invalid_result'); const controls = cameraControls(row.controls);
    if (operation === 'controls_set') for (const [key, expected] of Object.entries(request.inputs.values)) {
      const control = controls[key];
      if (!control || typeof control.value !== typeof expected || (typeof expected === 'boolean' ? control.value !== expected : control.active === false || Math.abs(control.value - expected) > Math.max(1e-8, (control.step ?? 0) / 2))) fail('control_readback_mismatch', 502);
    }
    return { controls, ...(row.evidence === undefined ? {} : { evidence: jsonTree(row.evidence) }) };
  }
  if (operation === 'preview_start' || operation === 'preview_stop') {
    const row = record(value, ['running', 'width', 'height', 'fps', 'evidence'], 'invalid_result');
    if (row.running !== (operation === 'preview_start')) fail('invalid_result', 502);
    if (operation === 'preview_start') {
      integer(row.width, 1, 16384); integer(row.height, 1, 16384);
      if (row.fps !== undefined && (typeof row.fps !== 'number' || !Number.isFinite(row.fps) || row.fps <= 0 || row.fps > 1000)) fail('invalid_result', 502);
    }
    return jsonTree(row);
  }
  if (['probe', 'pipeline_validate', 'bringup'].includes(operation)) {
    const row = record(value, ['passed', 'checks', 'facts', 'evidence', 'baseline'], 'invalid_result');
    if (!Object.keys(row).length || row.passed !== undefined && typeof row.passed !== 'boolean'
      || row.checks !== undefined && (!Array.isArray(row.checks) || row.checks.length > 128)) fail('invalid_result', 502);
    return jsonTree(row);
  }
  if (operation === 'apply_tuning' || operation === 'restore_tuning') {
    const row = record(value, ['appliedHash', 'readbackHash', 'evidence'], 'invalid_result');
    const appliedHash = assertHash(row.appliedHash); const readbackHash = assertHash(row.readbackHash);
    if (appliedHash !== request.inputs.tuningHash || readbackHash !== request.inputs.tuningHash) fail('readback_mismatch', 502);
    return { appliedHash, readbackHash, ...(row.evidence === undefined ? {} : { evidence: jsonTree(row.evidence) }) };
  }
  const imageFields = ['filename', 'mimeType', 'contentBase64', 'artifactFile', 'sha256', 'controls', 'tuningHash', 'capturedAt', 'scene'];
  const row = record(value, operation === 'capture_raw' ? ['filename', 'metadata', 'contentBase64', 'artifactFile', 'sha256']
    : operation === 'process_raw' ? [...imageFields, 'rawHash', 'readbackHash'] : imageFields, 'invalid_result');
  const { bytes, sha256 } = await artifactBytes(row, jobDir, operation === 'capture_raw' ? MAX_RAW : MAX_IMAGE);
  const name = filename(row.filename);
  if (operation === 'capture_raw') {
    const metadata = rawMetadata(row.metadata, bytes.length); validateRawPixels(bytes, metadata);
    if (metadata.scene !== request.inputs.scene) fail('capture_scene_mismatch', 502);
    return { filename: name, metadata, contentBase64: bytes.toString('base64'), sha256 };
  }
  if (!['image/png', 'image/jpeg'].includes(row.mimeType)) fail('invalid_image', 502);
  const dimensions = imageSize(bytes, row.mimeType);
  let replayWitness;
  if (operation === 'process_raw') {
    // These hashes must come from the SDK command's actual input and independent
    // configuration readback. Never fill missing evidence from the request.
    const rawHash = assertHash(row.rawHash); const tuningHash = assertHash(row.tuningHash); const readbackHash = assertHash(row.readbackHash);
    if (rawHash !== request.inputs.raw.sha256 || tuningHash !== request.inputs.tuningHash || readbackHash !== request.inputs.tuningHash) fail('replay_witness_mismatch', 502);
    replayWitness = { rawHash, readbackHash };
  }
  if (row.capturedAt !== undefined && (typeof row.capturedAt !== 'string' || row.capturedAt.length > 64 || !Number.isFinite(Date.parse(row.capturedAt)))) fail('invalid_result', 502);
  return { filename: name, mimeType: row.mimeType, contentBase64: bytes.toString('base64'), sha256, ...(['capture_frame', 'preview_frame'].includes(operation) ? dimensions : {}), ...(row.controls === undefined ? {} : { controls: cameraControls(row.controls) }), ...(row.tuningHash === undefined ? {} : { tuningHash: assertHash(row.tuningHash) }), ...replayWitness, ...(row.capturedAt === undefined ? {} : { capturedAt: row.capturedAt }), ...(row.scene === undefined ? {} : { scene: text(row.scene, 120) }) };
}

/** Spawn a fixed argv, count but do not expose stdout/stderr, and kill its group on abort. */
async function runSdkCommand({ argv, jobDir, signal, outputLimit }) {
  return new Promise((resolveRun, rejectRun) => {
    let child; let outputBytes = 0; let failure; let killTimer;
    const kill = () => {
      if (!child?.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* already exited */ }
      if (!killTimer) killTimer = setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 150);
    };
    const abort = () => { failure ??= new RunnerError(signal.reason === 'timeout' ? 'command_timeout' : 'client_disconnected', signal.reason === 'timeout' ? 504 : 499); kill(); };
    if (signal.aborted) { rejectRun(new RunnerError('client_disconnected', 499)); return; }
    try { child = spawn(argv[0], argv.slice(1), { cwd: jobDir, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { rejectRun(new RunnerError('command_failed', 502)); return; }
    signal.addEventListener('abort', abort, { once: true });
    const receive = chunk => { outputBytes += chunk.length; if (outputBytes > outputLimit && !failure) { failure = new RunnerError('command_output_limit', 502); kill(); } };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', () => { failure ??= new RunnerError('command_failed', 502); });
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort); if (killTimer) clearTimeout(killTimer);
      if (failure && child.pid) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* all group members already exited */ }
      }
      if (failure) rejectRun(failure); else resolveRun({ code, signal: exitSignal });
    });
  });
}
async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) fail('content_type', 415);
  if (Number(request.headers['content-length']) > MAX_REQUEST) fail('request_limit', 413);
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > MAX_REQUEST) fail('request_limit', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_json'); }
}
function responseJson(response, status, body) {
  if (response.destroyed) return;
  const content = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(content),
    ...(status >= 400 ? { connection: 'close' } : {}) });
  response.end(content);
}

/** Returns a Node HTTP server; callers decide when to listen/close it. */
export function createVisionDeviceRunner(input, { run = runSdkCommand } = {}) {
  const config = normalizeConfig(input); const token = Buffer.from(`Bearer ${config.token}`);
  let busy = false;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const presented = Buffer.from(String(request.headers.authorization ?? ''));
    if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
      responseJson(response, 401, { ok: false, error: 'vision_runner_unauthorized' }); request.resume(); return;
    }
    if (request.url === '/capabilities' && request.method === 'GET') {
      responseJson(response, 200, { ok: true, contract: VISION_RUNNER_CONTRACT,
        ...Object.fromEntries(IDENTITY_FIELDS.flatMap(key => config[key] === undefined ? [] : [[key, config[key]]])), operations: Object.keys(config.commands) }); return;
    }
    if (request.url !== '/execute' || request.method !== 'POST') {
      responseJson(response, 404, { ok: false, error: 'vision_runner_not_found' }); request.resume(); return;
    }
    if (busy) { responseJson(response, 429, { ok: false, error: 'vision_runner_busy' }); request.resume(); return; }
    busy = true; let jobDir; let timer;
    const controller = new AbortController();
    const abort = () => controller.abort('client_disconnected');
    const close = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort); response.once('close', close);
    try {
      const task = normalizeRequest(await bodyJson(request), config);
      if (controller.signal.aborted) fail('client_disconnected', 499);
      await mkdir(config.jobRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(config.jobRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe_job_root', 500);
      jobDir = await mkdtemp(join(config.jobRoot, 'vision-'));
      const requestFile = join(jobDir, 'request.json'); const rawFile = join(jobDir, 'input.raw'); const tuningFile = join(jobDir, 'tuning.json');
      const manifest = { contract: task.contract, operation: task.operation, context: task.context, inputs: task.inputs };
      await writeFile(requestFile, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
      if (task.rawBytes) await writeFile(rawFile, task.rawBytes, { mode: 0o600, flag: 'wx' });
      if (task.inputs.tuning) await writeFile(tuningFile, JSON.stringify(task.inputs.tuning), { mode: 0o600, flag: 'wx' });
      const substitutions = { jobDir, requestFile, rawFile, tuningFile }; const command = config.commands[task.operation];
      const argv = command.argv.map(argument => argument.replace(/\{(jobDir|requestFile|rawFile|tuningFile)\}/g, (_, key) => substitutions[key]));
      timer = setTimeout(() => controller.abort('timeout'), command.timeoutMs);
      const exit = await run({ argv, jobDir, signal: controller.signal, outputLimit: MAX_OUTPUT });
      if (controller.signal.aborted) fail(controller.signal.reason === 'timeout' ? 'command_timeout' : 'client_disconnected', controller.signal.reason === 'timeout' ? 504 : 499);
      if (!exit || exit.code !== 0 || exit.signal) fail('command_failed', 502);
      let value;
      try { value = JSON.parse((await readBoundedFile(join(jobDir, 'result.json'), MAX_REQUEST)).toString('utf8')); }
      catch (error) { if (error instanceof RunnerError) throw error; fail('missing_or_invalid_result', 502); }
      let result;
      try { result = await normalizeResult(value, task, jobDir); }
      catch (error) { if (error instanceof RunnerError) error.status = 502; throw error; }
      if (controller.signal.aborted) fail(controller.signal.reason === 'timeout' ? 'command_timeout' : 'client_disconnected', controller.signal.reason === 'timeout' ? 504 : 499);
      // A completed receipt means the device lease is ready for the next step.
      // Cleanup before the response avoids a spurious busy error on capture
      // immediately following a successful probe.
      await rm(jobDir, { recursive: true, force: true }); jobDir = undefined;
      if (controller.signal.aborted) fail(controller.signal.reason === 'timeout' ? 'command_timeout' : 'client_disconnected', controller.signal.reason === 'timeout' ? 504 : 499);
      responseJson(response, 200, { ok: true, contract: VISION_RUNNER_CONTRACT, operation: task.operation, jobId: task.context.jobId, result });
    } catch (error) {
      const known = error instanceof RunnerError;
      if (jobDir) { await rm(jobDir, { recursive: true, force: true }).catch(() => {}); jobDir = undefined; }
      responseJson(response, known ? error.status : 502, { ok: false, error: known ? error.code : 'vision_runner_execution_failed' });
    } finally {
      if (timer) clearTimeout(timer);
      request.removeListener('aborted', abort); response.removeListener('close', close);
      if (jobDir) await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      busy = false;
    }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  return server;
}

async function cli() {
  const args = process.argv.slice(2); let configFile; let port;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--config' && args[index + 1]) configFile = args[++index];
    else if (args[index] === '--port' && args[index + 1]) port = Number(args[++index]);
    else throw new Error('Usage: node tools/vision-workshop-device-runner.mjs --config /private/runner.json [--port 3215]');
  }
  if (!configFile) throw new Error('A private SDK runner --config file is required');
  const configPath = resolve(configFile); const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MIB || stat.mode & 0o077) throw new Error('Runner configuration must be a regular private file (chmod 600)');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (port !== undefined) config.port = port;
  // Relative private job roots resolve beside the config file.
  if (config.jobRoot && !isAbsolute(config.jobRoot)) config.jobRoot = resolve(dirname(configPath), config.jobRoot);
  const normalized = normalizeConfig(config); const server = createVisionDeviceRunner(config);
  server.listen(normalized.port, normalized.host, () => {
    const address = server.address();
    process.stdout.write(`Vision SDK runner listening on ${normalized.host}:${typeof address === 'object' ? address.port : normalized.port}; ${Object.keys(normalized.commands).length} configured operations\n`);
  });
  const stop = () => server.close(() => process.exit(0)); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli().catch(() => { process.stderr.write('Vision SDK runner failed to start; inspect the private configuration and executable paths.\n'); process.exitCode = 1; });
}
