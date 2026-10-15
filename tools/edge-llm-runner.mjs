#!/usr/bin/env node
/** Operator-configured X5 CPU llama.cpp runner. All control routes require a token. */
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, stat, mkdir, readFile, writeFile, rename, rm, realpath, statfs } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { arch, platform, totalmem, freemem, homedir } from 'node:os';
import { isAbsolute, join, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const EDGE_LLM_CONTRACT = 'rdk.edge-llm-runner.v1';
export const BENCHMARK_SUITE = 'qwen-text-smoke-v1';
const executeFile = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 16_384;
const MAX_JOBS = 10_000;
const MAX_STATE = 32 * 1024 * 1024;
const delay = ms => new Promise(done => setTimeout(done, ms));
const now = () => new Date().toISOString();
const prompts = [
  { id: 'warmup', text: '请用一句中文介绍你能做什么。' },
  { id: 'introduction', text: '请用三句话介绍机器人开发板的用途。' },
  { id: 'explanation', text: '请用简短中文说明 CPU 推理和模型量化的关系。' },
  { id: 'planning', text: '请列出在开发板上验证文本模型能正常运行的三个步骤。' },
];

export class EdgeLlmError extends Error {
  constructor(code, status = 400) { super(`edge_llm_${code}`); this.code = `edge_llm_${code}`; this.status = status; }
}
function fail(code, status = 400) { throw new EdgeLlmError(code, status); }
function object(value, keys, code = 'invalid_input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail(code);
  return value;
}
function integer(value, minimum, maximum, code = 'invalid_config') {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}
function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_config');
  return resolve(value);
}
function safeError(error) { return error instanceof EdgeLlmError ? error.code : 'edge_llm_internal_error'; }
function within(root, path) { return path.startsWith(root + sep); }

export function normalizeEdgeLlmConfig(input) {
  const config = object(input, ['board', 'binary', 'modelDir', 'port', 'threads', 'contextSize', 'models', 'startupTimeoutMs', 'requestTimeoutMs', 'downloadTimeoutMs', 'maxModelBytes'], 'invalid_config');
  if (config.board !== 'X5' || !Array.isArray(config.models) || !config.models.length || config.models.length > 100) fail('invalid_config');
  const modelDir = absolute(config.modelDir);
  const ids = new Set();
  const models = config.models.map(entry => {
    const model = object(entry, ['id', 'label', 'url', 'path', 'sha256', 'sizeBytes', 'quantization', 'redirectHosts'], 'invalid_config');
    if (typeof model.id !== 'string' || !MODEL_ID.test(model.id) || ids.has(model.id)
      || typeof model.label !== 'string' || !model.label.trim() || model.label.length > 120
      || /[\u0000-\u001f\u007f]/.test(model.label) || !SHA.test(model.sha256)
      || typeof model.quantization !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(model.quantization)) fail('invalid_config');
    ids.add(model.id);
    if (!model.path && !model.url) fail('invalid_config');
    const path = model.path ? absolute(model.path) : join(modelDir, `${model.id}.gguf`);
    if (!within(modelDir, path)) fail('invalid_config');
    if (model.url !== undefined) {
      let url; try { url = new URL(model.url); } catch { fail('invalid_config'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_config');
    }
    const redirectHosts = model.redirectHosts ?? [];
    if (!Array.isArray(redirectHosts) || redirectHosts.length > 12 || redirectHosts.some(host => typeof host !== 'string'
      || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || host.includes('..'))) fail('invalid_config');
    const sizeBytes = model.sizeBytes === undefined ? undefined : integer(model.sizeBytes, 4, 64 * 1024 ** 3);
    return { id: model.id, label: model.label.trim(), path, sha256: model.sha256, quantization: model.quantization,
      ...(model.url ? { url: model.url } : {}), redirectHosts: [...new Set(redirectHosts)], ...(sizeBytes === undefined ? {} : { sizeBytes }) };
  });
  return { board: 'X5', binary: absolute(config.binary), modelDir, models,
    port: integer(config.port ?? 8086, 1024, 65535), threads: integer(config.threads ?? 4, 1, 8),
    contextSize: integer(config.contextSize ?? 2048, 256, 32768),
    startupTimeoutMs: integer(config.startupTimeoutMs ?? 180_000, 1000, 900_000),
    requestTimeoutMs: integer(config.requestTimeoutMs ?? 180_000, 1000, 900_000),
    downloadTimeoutMs: integer(config.downloadTimeoutMs ?? 3_600_000, 1000, 14_400_000),
    maxModelBytes: integer(config.maxModelBytes ?? 16 * 1024 ** 3, 4, 64 * 1024 ** 3) };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (process.getuid && info.uid !== process.getuid())) fail('insecure_state_directory', 503);
}
async function safeAdminFile(path, strict = false, maximum = 1024 * 1024) {
  const handle = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || (strict ? (info.mode & 0o777) !== 0o600 : (info.mode & 0o022) !== 0)
      || (process.getuid && info.uid !== process.getuid())) fail('insecure_admin_file', 503);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

/** Hash the actual opened file; reject symlinks and non-GGUF bytes before launching. */
export async function verifyGguf(path, expectedHash, expectedSize) {
  if (!SHA.test(expectedHash)) fail('invalid_model_hash');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 4 || (expectedSize !== undefined && before.size !== expectedSize)) fail('model_size_mismatch', 422);
    if (before.mode & 0o022) fail('model_is_writable_by_others', 422);
    const first = Buffer.alloc(4); await handle.read(first, 0, 4, 0);
    if (first.toString('ascii') !== 'GGUF') fail('invalid_gguf_magic', 422);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('model_changed_during_hash', 422);
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedHash) fail('model_hash_mismatch', 422);
    return { sha256, sizeBytes: before.size };
  } finally { await handle.close(); }
}

export async function downloadGgufModel(model, config, { signal, fetchImpl = fetch } = {}) {
  const temporary = join(config.modelDir, `.download-${randomUUID()}.gguf`);
  try {
    const downloadSignal = AbortSignal.any([AbortSignal.timeout(config.downloadTimeoutMs), ...(signal ? [signal] : [])]);
    let currentUrl = model.url; let response;
    for (let redirects = 0; ; redirects++) {
      // No control authorization is ever sent to the model host or its CDN.
      response = await fetchImpl(currentUrl, { redirect: 'manual', signal: downloadSignal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (redirects >= 4 || !location) fail('model_redirect_rejected', 422);
      let next; try { next = new URL(location, currentUrl); } catch { fail('model_redirect_rejected', 422); }
      if (next.protocol !== 'https:' || next.username || next.password || next.hash || next.port
        || !(model.redirectHosts ?? []).includes(next.hostname)) fail('model_redirect_rejected', 422);
      currentUrl = next.href;
    }
    if (!response.ok || !response.body) fail('model_download_failed', 502);
    const declared = Number(response.headers.get('content-length'));
    const maximum = Math.min(config.maxModelBytes, model.sizeBytes ?? config.maxModelBytes);
    if (Number.isFinite(declared) && declared > maximum) fail('model_download_too_large', 422);
    const handle = await open(temporary, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) fail('model_download_too_large', 422);
        await handle.writeFile(chunk);
      }
      await handle.sync();
    } finally { await handle.close(); }
    const facts = await verifyGguf(temporary, model.sha256, model.sizeBytes);
    const root = await realpath(config.modelDir); const parent = await realpath(dirname(model.path));
    if (parent !== root && !within(root, parent)) fail('model_outside_directory', 422);
    await rename(temporary, model.path);
    return facts;
  } finally { await rm(temporary, { force: true }); }
}

export async function probeSystemFacts(config) {
  let identity = null;
  for (const path of ['/sys/class/socinfo/board_id', '/sys/firmware/devicetree/base/model']) {
    try { identity = (await readFile(path, 'utf8')).replace(/\0/g, '').trim().slice(0, 160); if (identity) break; } catch { /* unavailable on this host */ }
  }
  let freeBytes = null;
  try { const disk = await statfs(config.modelDir); freeBytes = Number(disk.bavail) * Number(disk.bsize); } catch { /* returned as unavailable */ }
  const detectedBoard = identity && /(?:rdk[^a-z0-9]*)?\bX5\b/i.test(identity) ? 'X5' : null;
  return { platform: platform(), architecture: arch(), ramBytes: totalmem(), freeRamBytes: freemem(), freeDiskBytes: freeBytes,
    configuredBoard: 'X5', detectedBoard, identityVerification: detectedBoard === 'X5' ? 'verified' : 'unverified',
    boardIdentityStatus: identity ? 'observed' : 'unavailable', ...(identity ? { boardIdentity: identity } : {}) };
}

async function runtimeInfo(binary) {
  try {
    const info = await stat(binary);
    if (!info.isFile() || !(info.mode & 0o111)) return { available: false };
    const output = await executeFile(binary, ['--version'], { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, LLAMA_LOG_COLORS: '0' } });
    // llama.cpp prints version on stderr on some releases. Preserve version/build tokens only.
    const raw = `${output.stdout}\n${output.stderr}`;
    const match = raw.match(/\b(?:version|build)\s*[:=]?\s*([a-zA-Z0-9][a-zA-Z0-9._+-]{0,79})(?:\s*\(([a-fA-F0-9]{7,40})\))?/i);
    const version = match ? `${match[1]}${match[2] ? ` (${match[2]})` : ''}` : undefined;
    return { available: true, ...(version ? { version } : {}) };
  } catch { return { available: false }; }
}

/** OpenAI SSE timing measured locally, tokens only from the runtime's usage/timings. */
export async function measureCompletion(endpoint, modelId, prompt, { timeoutMs = 180_000, maxTokens = 96, signal } = {}) {
  const started = performance.now();
  let first = null; let outputPresent = false; let generatedTokens = null; let tokenSource = null; let runtimeTokensPerSecond = null;
  let completed = false; let pending = ''; let bytes = 0;
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], stream: true,
      stream_options: { include_usage: true }, cache_prompt: false, max_tokens: maxTokens, temperature: 0, seed: 42 }),
  });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) fail('inference_stream_failed', 502);
  const consume = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { completed = true; return; }
    let event; try { event = JSON.parse(data); } catch { fail('invalid_inference_event', 502); }
    if (event.error) fail('inference_failed', 502);
    for (const choice of event.choices ?? []) {
      const content = choice.delta?.content;
      if (typeof content === 'string' && content.trim()) { outputPresent = true; first ??= performance.now(); }
      if (choice.finish_reason != null) completed = true;
    }
    // Nonempty output with a zero token count is inconsistent; expose it as unavailable.
    if (Number.isSafeInteger(event.usage?.completion_tokens) && event.usage.completion_tokens > 0) {
      generatedTokens = event.usage.completion_tokens; tokenSource = 'usage';
    } else if (generatedTokens === null && Number.isSafeInteger(event.timings?.predicted_n) && event.timings.predicted_n > 0) {
      generatedTokens = event.timings.predicted_n; tokenSource = 'timings';
    }
    if (typeof event.timings?.predicted_per_second === 'number' && Number.isFinite(event.timings.predicted_per_second)
      && event.timings.predicted_per_second > 0) runtimeTokensPerSecond = event.timings.predicted_per_second;
  };
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength; if (bytes > 2 * 1024 * 1024) fail('inference_output_too_large', 502);
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) { consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
  }
  pending += decoder.decode(); if (pending.trim()) consume(pending);
  const finished = performance.now();
  if (!completed) fail('inference_incomplete', 502);
  if (!outputPresent || first === null) fail('inference_empty_output', 502);
  const totalMs = finished - started;
  const generationMs = finished - first;
  const wallClockTokensPerSecond = generatedTokens !== null && generatedTokens > 0 && totalMs > 0
    ? generatedTokens / (totalMs / 1000) : null;
  const tokensPerSecond = runtimeTokensPerSecond ?? wallClockTokensPerSecond;
  return { ttftMs: first - started, totalMs, generationMs, generatedTokens, tokensPerSecond, tokenSource,
    wallClockTokensPerSecond, runtimeTokensPerSecond,
    metricStatus: generatedTokens === null || tokensPerSecond === null ? 'partial' : 'available', outputPresent: true,
    unavailableReasons: generatedTokens === null || tokensPerSecond === null ? ['runtime_token_count_unavailable_or_zero'] : [],
    rateDefinition: runtimeTokensPerSecond === null ? 'reported_output_tokens_per_client_request_wall_seconds' : 'runtime_timings_predicted_per_second' };
}

function validateJob(input, config) {
  const request = object(input, ['contract', 'id', 'operation', 'inputs']);
  if (request.contract !== EDGE_LLM_CONTRACT || !UUID.test(request.id)
    || !['probe', 'deploy', 'benchmark', 'stop'].includes(request.operation)) fail('invalid_input');
  const inputs = object(request.inputs ?? {}, request.operation === 'stop' ? ['abandonJobIds'] : ['modelId']);
  if (request.operation === 'probe' && Object.keys(inputs).length) fail('invalid_input');
  let abandonJobIds;
  if (inputs.abandonJobIds !== undefined) {
    if (!Array.isArray(inputs.abandonJobIds) || inputs.abandonJobIds.length > 500
      || inputs.abandonJobIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail('invalid_input');
    abandonJobIds = inputs.abandonJobIds.map(id => id.toLowerCase());
    if (new Set(abandonJobIds).size !== abandonJobIds.length || abandonJobIds.includes(request.id.toLowerCase())) fail('invalid_input');
  }
  if (request.operation === 'deploy' && typeof inputs.modelId !== 'string') fail('model_id_required');
  if (inputs.modelId !== undefined && !config.models.some(model => model.id === inputs.modelId)) fail('unknown_model', 404);
  return { contract: EDGE_LLM_CONTRACT, id: request.id.toLowerCase(), operation: request.operation,
    inputs: inputs.modelId ? { modelId: inputs.modelId } : abandonJobIds ? { abandonJobIds } : {} };
}

/** Creates a loopback HTTP control server; does not install a model or start llama.cpp. */
export async function createEdgeLlmRunner(input, { token, stateDir, systemProbe = probeSystemFacts } = {}) {
  const config = normalizeEdgeLlmConfig(input);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{24,4096}$/.test(token)) fail('invalid_token', 503);
  stateDir = absolute(stateDir ?? join(homedir(), '.local/state/rdk-edge-llm'));
  await privateDirectory(stateDir);
  await mkdir(config.modelDir, { recursive: true, mode: 0o700 });
  const modelRoot = await realpath(config.modelDir);
  const modelDirectory = await lstat(config.modelDir);
  if (!modelDirectory.isDirectory() || modelDirectory.isSymbolicLink() || (modelDirectory.mode & 0o022)) fail('insecure_model_directory', 503);
  const lockPath = join(stateDir, 'runner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid; try { pid = Number(await safeAdminFile(lockPath, true)); } catch { fail('state_locked', 503); }
    if (!Number.isSafeInteger(pid) || pid < 1) fail('state_locked', 503);
    try { process.kill(pid, 0); fail('state_locked', 503); } catch (probeError) { if (probeError.code !== 'ESRCH') throw probeError; }
    await rm(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid)); await lock.close();
  const statePath = join(stateDir, 'state.json');
  const jobs = new Map();
  const abandonedIds = new Set();
  let child = null; let busy = null; let closing = false; let activeOperation = null; let operationAbort = null;
  let deployment = { ready: false };
  const persist = () => atomicJson(statePath, { contract: EDGE_LLM_CONTRACT,
    jobs: [...jobs.values()].map(({ request, job }) => ({ request, job })), abandonedIds: [...abandonedIds], deployment });
  const publicJob = record => {
    const job = structuredClone(record.job);
    if (record.committing) { job.status = 'running'; delete job.result; delete job.error; }
    return job;
  };
  try {
    let saved;
    try {
      const info = await lstat(statePath); if (info.size > MAX_STATE) fail('state_too_large', 503);
      saved = JSON.parse(await safeAdminFile(statePath, true, MAX_STATE));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved) {
      if (saved.contract !== EDGE_LLM_CONTRACT || !Array.isArray(saved.jobs) || saved.jobs.length > MAX_JOBS) fail('invalid_state', 503);
      if (saved.abandonedIds !== undefined && (!Array.isArray(saved.abandonedIds) || saved.abandonedIds.length > MAX_JOBS
        || saved.abandonedIds.some(id => typeof id !== 'string' || !UUID.test(id)))) fail('invalid_state', 503);
      for (const id of saved.abandonedIds ?? []) abandonedIds.add(id.toLowerCase());
      for (const entry of saved.jobs) {
        const request = validateJob(entry.request, config);
        if (entry.job?.id !== request.id || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(entry.job.status)) fail('invalid_state', 503);
        if (['queued', 'running'].includes(entry.job.status)) {
          entry.job.status = 'unknown'; entry.job.updatedAt = now(); entry.job.error = 'edge_llm_interrupted_by_restart';
          delete entry.job.result;
        }
        jobs.set(request.id, { request, job: entry.job });
      }
      // A PID from a prior process is never authority to kill or adopt an existing service.
      deployment = { ready: false, ...(saved.deployment?.modelId ? { modelId: saved.deployment.modelId, status: 'unknown' } : {}) };
    }
    await persist();
  } catch (error) { await rm(lockPath, { force: true }); throw error; }

  const endpoint = `http://127.0.0.1:${config.port}`;
  const runtime = await runtimeInfo(config.binary);
  async function stopOwnedProcess() {
    const owned = child;
    if (!owned || !owned.pid) { child = null; deployment = { ready: false }; return { stopped: true, ownedProcess: false }; }
    child = null;
    if (owned.exitCode === null && owned.signalCode === null) {
      const exited = new Promise(done => owned.once('exit', done));
      owned.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (owned.exitCode === null && owned.signalCode === null) { owned.kill('SIGKILL'); await Promise.race([exited, delay(3000)]); }
      if (owned.exitCode === null && owned.signalCode === null) fail('owned_process_stop_failed', 502);
    }
    deployment = { ready: false };
    return { stopped: true, ownedProcess: true };
  }
  async function health() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try { const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2000) }); return response.ok; } catch { return false; }
  }
  async function assertInferencePortAvailable() {
    const portProbe = createServer();
    try { await new Promise((done, reject) => { portProbe.once('error', reject); portProbe.listen(config.port, '127.0.0.1', done); }); }
    catch { fail('inference_port_in_use', 409); }
    finally { if (portProbe.listening) await new Promise(done => portProbe.close(done)); }
  }
  async function run(request, signal) {
    const facts = () => systemProbe(config);
    if (request.operation === 'probe') return { board: 'X5', backend: 'cpu', runtime: await runtimeInfo(config.binary), ...(await facts()) };
    if (request.operation === 'stop') {
      const result = await stopOwnedProcess(); await assertInferencePortAvailable();
      return { board: 'X5', backend: 'cpu', ...result, inferencePortAvailable: true, abandonedJobIds: request.inputs.abandonJobIds ?? [] };
    }
    if (request.operation === 'benchmark') {
      if (!deployment.ready || !(await health())) fail('deployment_not_ready', 409);
      if (request.inputs.modelId && request.inputs.modelId !== deployment.modelId) fail('model_not_deployed', 409);
      const selected = config.models.find(model => model.id === deployment.modelId);
      const verified = await verifyGguf(selected.path, selected.sha256, selected.sizeBytes);
      const cases = [];
      for (const prompt of prompts) {
        const measurement = await measureCompletion(endpoint, selected.id, prompt.text, { timeoutMs: config.requestTimeoutMs, signal });
        if (prompt.id === 'warmup') continue;
        cases.push({ id: prompt.id, ...measurement });
      }
      return { board: 'X5', backend: 'cpu', modelId: selected.id, modelSha256: verified.sha256,
        suite: BENCHMARK_SUITE, measurementSource: 'runner', purpose: 'performance', accuracyEvaluated: false,
        warmupRuns: 1, cases, runtime, threads: config.threads, contextSize: config.contextSize };
    }
    const system = await facts();
    if (system.platform !== 'linux' || system.architecture !== 'arm64') fail('unsupported_architecture', 422);
    if (system.boardIdentity && /\b(?:S100P?|S600|X3|Ultra)\b/i.test(system.boardIdentity)) fail('board_mismatch', 422);
    if (!runtime.available) fail('runtime_unavailable', 503);
    const model = config.models.find(entry => entry.id === request.inputs.modelId);
    if (child) fail('model_already_running_stop_first', 409);
    // Connecting to an existing listener is insufficient ownership proof. Refuse occupied ports.
    await assertInferencePortAvailable();
    let verified;
    try {
      try {
        const resolved = await realpath(model.path); if (!within(modelRoot, resolved)) fail('model_outside_directory', 422);
        verified = await verifyGguf(model.path, model.sha256, model.sizeBytes);
      } catch (error) {
        if (error.code !== 'ENOENT' || !model.url) throw error;
        if (system.freeDiskBytes !== null && system.freeDiskBytes < (model.sizeBytes ?? 1024 ** 3) + 256 * 1024 ** 2) fail('insufficient_disk', 422);
        verified = await downloadGgufModel(model, config, { signal });
      }
      const log = await open(join(stateDir, 'runtime.log'), 'a', 0o600);
      try {
        child = spawn(config.binary, ['--model', model.path, '--host', '127.0.0.1', '--port', String(config.port),
          '--device', 'none', '-ngl', '0', '--threads', String(config.threads), '--threads-batch', String(config.threads),
          '--parallel', '1', '--ctx-size', String(config.contextSize), '--alias', model.id],
        { stdio: ['ignore', log.fd, log.fd], env: { ...process.env, LLAMA_LOG_COLORS: '0' }, shell: false });
        const spawned = child;
        await new Promise((done, reject) => { spawned.once('spawn', done); spawned.once('error', () => reject(new EdgeLlmError('runtime_start_failed', 502))); });
      } finally { await log.close(); }
      deployment = { modelId: model.id, ready: false, status: 'starting' };
      const deadline = Date.now() + config.startupTimeoutMs;
      while (!(await health())) {
        if (closing || !child || child.exitCode !== null || child.signalCode !== null) fail('runtime_exited_during_start', 502);
        if (Date.now() >= deadline) fail('runtime_start_timeout', 504);
        await delay(250);
      }
      const validation = await measureCompletion(endpoint, model.id, '请只用中文回复一句问候。', { timeoutMs: config.requestTimeoutMs, maxTokens: 32, signal });
      if (!child || child.exitCode !== null || child.signalCode !== null) fail('runtime_exited_during_start', 502);
      deployment = { modelId: model.id, ready: true, status: 'ready', modelSha256: verified.sha256 };
      return { board: 'X5', backend: 'cpu', configuredBoard: 'X5', detectedBoard: system.detectedBoard,
        modelId: model.id, ready: true, modelSha256: verified.sha256, sizeBytes: verified.sizeBytes,
        runtime, threads: config.threads, contextSize: config.contextSize, gpuLayers: 0, validation: { outputPresent: validation.outputPresent } };
    } catch (error) {
      await stopOwnedProcess(); deployment = { modelId: model.id, ready: false, status: 'failed' }; throw error;
    }
  }
  async function executeJob(entry) {
    try {
      if (closing) fail('closing', 503);
      operationAbort = new AbortController();
      entry.job.status = 'running'; entry.job.updatedAt = now(); await persist();
      entry.job.result = await run(entry.request, operationAbort.signal); entry.job.status = 'succeeded';
    } catch (error) { entry.job.status = 'failed'; entry.job.error = safeError(error); delete entry.job.result; }
    finally {
      entry.committing = true;
      entry.job.updatedAt = now();
      try { await persist(); } catch { entry.job.status = 'unknown'; entry.job.error = 'edge_llm_state_write_failed'; delete entry.job.result; }
      entry.committing = false; busy = null; operationAbort = null;
    }
  }
  async function submit(input) {
    if (closing) fail('closing', 503);
    const request = validateJob(input, config);
    if (abandonedIds.has(request.id)) fail('job_abandoned', 409);
    const existing = jobs.get(request.id);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) fail('idempotency_conflict', 409);
      return publicJob(existing);
    }
    if (busy) fail('device_busy', 409);
    const newAbandonedIds = (request.inputs.abandonJobIds ?? []).filter(id => !abandonedIds.has(id));
    if (jobs.size >= MAX_JOBS || abandonedIds.size + newAbandonedIds.length > MAX_JOBS) fail('job_limit_reached', 503);
    const timestamp = now();
    const entry = { request, job: { id: request.id, operation: request.operation, status: 'queued', createdAt: timestamp, updatedAt: timestamp } };
    busy = request.id; jobs.set(request.id, entry);
    for (const id of newAbandonedIds) abandonedIds.add(id);
    try { await persist(); } catch {
      jobs.delete(request.id); for (const id of newAbandonedIds) abandonedIds.delete(id); busy = null; fail('state_write_failed', 503);
    }
    activeOperation = new Promise(done => setImmediate(() => { executeJob(entry).then(done, done); }));
    return publicJob(entry);
  }
  async function catalog() {
    const ready = deployment.ready === true && await health();
    return { ok: true, contract: EDGE_LLM_CONTRACT, board: 'X5', backend: 'cpu',
      models: config.models.map(({ id, label, sha256, sizeBytes, quantization }) => ({ id, label, sha256, ...(sizeBytes === undefined ? {} : { sizeBytes }), quantization })),
      runtime, deployment: { ...(deployment.modelId ? { modelId: deployment.modelId } : {}), ready } };
  }
  const authBytes = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    const respond = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); };
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authBytes.length || !timingSafeEqual(supplied, authBytes)) fail('unauthorized', 401);
      const url = new URL(request.url, 'http://localhost');
      if (url.search) fail('invalid_input');
      if (request.method === 'GET' && url.pathname === '/catalog') return respond(200, await catalog());
      if (request.method === 'GET' && /^\/jobs\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.slice(6).toLowerCase(); if (!UUID.test(id)) fail('invalid_input');
        const entry = jobs.get(id); if (!entry) fail(abandonedIds.has(id) ? 'job_abandoned' : 'job_not_found', 404);
        return respond(200, { ok: true, contract: EDGE_LLM_CONTRACT, job: publicJob(entry) });
      }
      if (request.method === 'POST' && url.pathname === '/jobs') {
        if (!request.headers['content-type']?.startsWith('application/json')) fail('invalid_content_type', 415);
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) fail('request_too_large', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_json'); }
        return respond(202, { ok: true, contract: EDGE_LLM_CONTRACT, job: await submit(body) });
      }
      fail('not_found', 404);
    } catch (error) { respond(error instanceof EdgeLlmError ? error.status : 500, { ok: false, contract: EDGE_LLM_CONTRACT, error: safeError(error) }); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  async function close() {
    closing = true;
    operationAbort?.abort();
    if (server.listening) { server.closeIdleConnections(); await new Promise(done => server.close(done)); }
    if (activeOperation) await activeOperation;
    await stopOwnedProcess();
    await persist(); await rm(lockPath, { force: true });
  }
  return { server, submit, catalog, getJob: id => jobs.has(id) ? publicJob(jobs.get(id)) : null, close };
}

export async function startEdgeLlmRunnerFromEnv(env = process.env) {
  if (!env.RDK_EDGE_LLM_CONFIG || !env.RDK_EDGE_LLM_TOKEN_FILE) fail('config_and_token_file_required', 503);
  const token = (await safeAdminFile(env.RDK_EDGE_LLM_TOKEN_FILE, true)).trim();
  let config; try { config = JSON.parse(await safeAdminFile(env.RDK_EDGE_LLM_CONFIG)); } catch (error) { if (error instanceof EdgeLlmError) throw error; fail('invalid_config', 503); }
  const runner = await createEdgeLlmRunner(config, { token, stateDir: env.RDK_EDGE_LLM_STATE_DIR });
  const port = integer(Number(env.RDK_EDGE_LLM_PORT ?? 8876), 1024, 65535);
  try { await new Promise((done, reject) => { runner.server.once('error', reject); runner.server.listen(port, '127.0.0.1', done); }); }
  catch (error) { await runner.close(); throw error; }
  return runner;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const runner = await startEdgeLlmRunnerFromEnv();
    process.stdout.write(`${EDGE_LLM_CONTRACT} listening on 127.0.0.1:${runner.server.address().port}; backend=cpu\n`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { runner.close().then(() => process.exit(0), () => process.exit(1)); });
  } catch (error) { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; }
}
