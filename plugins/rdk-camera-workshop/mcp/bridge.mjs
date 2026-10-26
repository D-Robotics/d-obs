#!/usr/bin/env node
/** Bounded stdio MCP transport for the reviewed d-obs camera tools. Node >= 22. */
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 150_000;
const ENDPOINT = '/api/ops/vision-workshop/mcp';
const modulePath = fileURLToPath(import.meta.url);
const protocols = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const onboarding = process.env.RDK_CAMERA_WORKSHOP_ONBOARDING === '1';
const PLUGIN_VERSION = '1.3.0';
const connectionTool = {
  name: 'vision_connection_status', description: '检查本机相机服务连接配置。首次安装或远端工具缺失时先调用；仅验证配置，不表示设备在线。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};
const versionTool = {
  name: 'vision_plugin_version', description: '返回本插件版本号。用于检查是否有更新版本可用。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};
// Deliberately omit vision_workshop_execute: this transport has no arbitrary operation executor.
const TOOL_ARGUMENTS = new Map(Object.entries({
  vision_workshop_capabilities: ['search', 'limit', 'offset'], vision_workshop_runtime_status: [], vision_experiment_list: ['limit', 'offset'],
  vision_experiment_get: ['experimentId'], vision_camera_readiness: ['experimentId'], vision_camera_workflow: ['experimentId'],
  vision_camera_stream_analyze: ['experimentId', 'runIds', 'expectedFps', 'tolerancePercent', 'minimumDurationSeconds'], vision_workshop_delivery: ['experimentId'],
  vision_camera_response_analyze: ['experimentId', 'baselineFrameIds', 'candidateFrameIds', 'restoredFrameIds', 'roi'],
  vision_delivery_target_select: ['experimentId', 'targetId'], vision_acceptance_plan_save: ['experimentId', 'plan'], vision_acceptance_record: ['experimentId', 'record'],
  vision_experiment_create: ['title', 'goal', 'board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode', 'targetId'],
  vision_tuning_baseline_import: ['experimentId', 'config', 'rules'],
  vision_camera_knowledge_search: ['q', 'board', 'sensorModel'], vision_camera_knowledge_get: ['knowledgeId', 'section'],
  vision_ai_debug_start: ['experimentId', 'goal', 'maxRounds'],
  vision_ai_debug_status: ['experimentId', 'runId'], vision_ai_debug_cancel: ['experimentId', 'runId'],
  vision_ai_debug_restore_original: ['experimentId', 'runId'],
  vision_camera_probe: ['experimentId'], vision_pipeline_validate: ['experimentId'], vision_camera_bringup: ['experimentId'],
  vision_camera_preview_start: ['experimentId', 'mode'], vision_camera_preview_stop: ['experimentId'], vision_camera_preview_frame: ['experimentId', 'afterSdkTimestampNs'],
  vision_camera_controls_get: ['experimentId'], vision_camera_controls_set: ['experimentId', 'values'],
  vision_camera_capture_frame: ['experimentId', 'scene', 'candidateId'], vision_raw_capture: ['experimentId', 'scene'],
  vision_isp_generate: ['experimentId', 'goal', 'frameIds'], vision_isp_process_raw: ['experimentId', 'sampleId', 'candidateId'],
  vision_isp_apply: ['experimentId', 'candidateId'], vision_isp_restore: ['experimentId', 'baselineId', 'candidateId'],
  vision_image_evaluate: ['experimentId', 'imageId', 'rating', 'notes'],
  vision_image_compare: ['experimentId', 'baselineImageId', 'candidateImageId', 'roi'], vision_workshop_export: ['experimentId', 'includeRaw'],
  vision_isp_tuning_get: ['experimentId'], vision_isp_tuning_load: ['experimentId', 'contentBase64', 'sha256', 'artifactRole', 'artifactId'], vision_isp_tuning_export: ['experimentId'],
  vision_calibration_asset_import: ['experimentId', 'measurement'], vision_calibration_asset_list: ['experimentId'],
  vision_calibration_task_create: ['experimentId', 'operation', 'inputs', 'options'], vision_calibration_task_list: ['experimentId'],
  vision_calibration_task_get: ['experimentId', 'taskId'], vision_calibration_task_run: ['experimentId', 'taskId'],
  vision_calibration_task_result: ['experimentId', 'taskId'], vision_calibration_apply_plan: ['experimentId', 'taskId'],
  vision_calibration_apply: ['experimentId', 'taskId', 'options'],
}));
const READ_ONLY = new Set([
  'vision_workshop_capabilities', 'vision_workshop_runtime_status', 'vision_experiment_list', 'vision_experiment_get',
  'vision_camera_knowledge_search', 'vision_camera_knowledge_get', 'vision_ai_debug_status', 'vision_camera_readiness',
  'vision_camera_workflow', 'vision_camera_stream_analyze', 'vision_camera_response_analyze',
  'vision_workshop_delivery', 'vision_camera_probe', 'vision_pipeline_validate', 'vision_camera_preview_frame', 'vision_camera_controls_get', 'vision_workshop_export',
  'vision_isp_tuning_get', 'vision_isp_tuning_export', 'vision_calibration_asset_list', 'vision_calibration_task_list',
  'vision_calibration_task_get', 'vision_calibration_task_result', 'vision_calibration_apply_plan',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
class BridgeError extends Error { constructor(code) { super(code); } }
const fail = code => { throw new BridgeError(code); };
const remediation = {
  camera_bridge_unconfigured: '尚未配置连接。运行 configure，并指定服务 URL、认证类型和已有私有凭据文件。',
  camera_bridge_config_invalid: '连接配置字段不完整：url、auth.type（sso/admin）、credentialFile（绝对路径）为必填，且不含其他字段。',
  camera_bridge_url_invalid: '服务地址须为 HTTPS（本机可为 loopback HTTP），路径以 /api/ops/vision-workshop/mcp 结尾，且不含 query、hash 或内嵌凭据。',
  camera_bridge_timeout_invalid: 'timeoutMs 须为 1–300000 的整数。',
  camera_bridge_private_file_permissions_invalid: '连接配置与凭据文件须由当前用户持有，POSIX 权限为 600。',
  camera_bridge_private_file_inside_package: '将连接配置和凭据移到插件及源码仓库之外。',
  camera_bridge_credential_invalid: '凭据文件为空或含控制字符；在原服务重新导出后重试。',
  camera_bridge_remote_http_401: '认证失效，请在原服务更新凭据后重试。',
  camera_bridge_remote_http_403: '当前身份无权访问该服务，请核对服务权限与入口。',
  camera_bridge_remote_transport_failed: '无法访问相机服务，请检查服务运行状态、地址和网络。',
};
export function describeError(code) {
  return remediation[code] ?? '检查服务地址、私有文件和认证类型；参阅 README 的连接与自检说明。';
}

export function resolveConfigPath(env = process.env, home = homedir()) {
  return env.RDK_CAMERA_WORKSHOP_CONFIG || path.join(home, '.config', 'rdk-camera-workshop', 'connection.json');
}

async function forbiddenRoot() {
  let current = path.dirname(modulePath);
  for (;;) {
    try { await access(path.join(current, '.git')); return realpath(current); } catch {}
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return realpath(path.resolve(path.dirname(modulePath), '..'));
}
const within = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
async function privateFile(filename, root, maxBytes, kind) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('camera_bridge_' + kind + '_path_invalid');
  let handle;
  try {
    const resolved = await realpath(filename);
    if (within(root, resolved)) fail('camera_bridge_private_file_inside_package');
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    // Windows mode bits do not validate ACLs. The owner must protect both files with private ACLs.
    if (!stat.isFile() || process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('camera_bridge_private_file_permissions_invalid');
    if (stat.size > maxBytes) fail('camera_bridge_private_file_too_large');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) fail('camera_bridge_private_file_too_large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    fail(kind === 'config' && error?.code === 'ENOENT' ? 'camera_bridge_unconfigured' : 'camera_bridge_' + kind + '_unavailable');
  } finally { await handle?.close().catch(() => {}); }
}
async function connection(filename = resolveConfigPath()) {
  const root = await forbiddenRoot();
  const text = await privateFile(filename, root, 64 * 1024, 'config');
  let config;
  try { config = JSON.parse(text); } catch { fail('camera_bridge_config_invalid'); }
  if (!onlyKeys(config, ['url', 'auth', 'timeoutMs']) || typeof config.url !== 'string'
    || !onlyKeys(config.auth, ['type', 'credentialFile']) || !['admin', 'sso'].includes(config.auth.type)) fail('camera_bridge_config_invalid');
  let url;
  try { url = new URL(config.url); } catch { fail('camera_bridge_url_invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !loopback || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith(ENDPOINT) || /[\u0000-\u0020\u007f\\?#]/.test(config.url)) fail('camera_bridge_url_invalid');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) fail('camera_bridge_timeout_invalid');
  const credential = (await privateFile(config.auth.credentialFile, root, 16 * 1024, 'credential')).trim();
  if (!credential || /[\u0000-\u001f\u007f]/.test(credential)) fail('camera_bridge_credential_invalid');
  return { url: url.href, timeoutMs, credential, authType: config.auth.type };
}

// Setup uses the exact runtime checks without returning credentials or contacting the service.
export async function validateConfiguration(filename = resolveConfigPath()) {
  await connection(filename);
  return { status: 'configured' };
}

function redact(value, credential) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.split(credential).join('[redacted]') : item));
}
async function boundedBody(response, controller) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { controller.abort(); fail('camera_bridge_remote_response_too_large'); }
  if (!response.body) fail('camera_bridge_remote_response_invalid');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) { controller.abort(); await reader.cancel().catch(() => {}); fail('camera_bridge_remote_response_too_large'); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))); }
  catch { fail('camera_bridge_remote_response_invalid'); }
}
async function remote(message) {
  const config = await connection(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-rdk-ops-action': 'observability',
        [config.authType === 'admin' ? 'x-admin-token' : 'x-rdk-sso-session']: config.credential },
      body: JSON.stringify(message),
    });
    if (!response.ok) fail('camera_bridge_remote_http_' + response.status);
    const data = await boundedBody(response, controller);
    if (!record(data) || data.jsonrpc !== '2.0' || data.id !== message.id || (!record(data.result) && !record(data.error))) fail('camera_bridge_remote_response_invalid');
    if (record(data.error)) return rpcError(message.id, Number.isInteger(data.error.code) ? data.error.code : -32002, 'camera_bridge_remote_rpc_error');
    if (message.method === 'tools/list') {
      if (!Array.isArray(data.result.tools)) fail('camera_bridge_remote_response_invalid');
      const names = new Set();
      data.result.tools = data.result.tools.filter(tool => record(tool) && TOOL_ARGUMENTS.has(tool.name) && !names.has(tool.name)
        && typeof tool.description === 'string' && record(tool.inputSchema) && (names.add(tool.name), true));
      data.result.tools = data.result.tools.map(tool => ({ ...tool, annotations: {
        ...(record(tool.annotations) ? tool.annotations : {}), readOnlyHint: READ_ONLY.has(tool.name),
        destructiveHint: !READ_ONLY.has(tool.name), idempotentHint: READ_ONLY.has(tool.name),
      } }));
    }
    const result = redact(data, config.credential);
    if (Buffer.byteLength(JSON.stringify(result)) + 1 > MAX_BYTES) fail('camera_bridge_remote_response_too_large');
    return result;
  } catch (error) {
    const code = error instanceof BridgeError ? error.message : 'camera_bridge_remote_transport_failed';
    const text = code + ': ' + describeError(code);
    if (message.method === 'tools/call' && !READ_ONLY.has(message.params?.name)) return rpcError(message.id, -32002, text + ': execution outcome unknown; no automatic retry. Check experiment deviceRuns and actual camera state before another write. Restoration is unconfirmed.');
    return rpcError(message.id, -32002, text);
  } finally { clearTimeout(timer); }
}

let toolChain = Promise.resolve();
async function dispatch(message) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
    || message.id !== undefined && message.id !== null && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id))) return rpcError(null, -32600, 'invalid json-rpc request');
  // Match the d-obs handler: notifications never execute tools or emit responses.
  if (message.id === undefined || message.id === null) return null;
  const id = message.id; const params = message.params ?? {};
  if (!record(params)) return rpcError(id, -32602, 'invalid params');
  if (message.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: protocols.has(params.protocolVersion) ? params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'rdk-camera-workshop-http-bridge', version: '1.2.0' }, ...(process.platform === 'win32' ? { instructions: 'Windows file ACLs are not verified by this bridge. Protect the private configuration and credential files with owner-only ACLs.' } : {}) } };
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (message.method === 'tools/list') {
    if (!onlyKeys(params, ['cursor', '_meta'])) return rpcError(id, -32602, 'invalid params');
    let response;
    try { response = await remote({ jsonrpc: '2.0', id, method: message.method, params }); }
    catch (error) {
      if (!onboarding) throw error;
      response = rpcError(id, -32001, error instanceof BridgeError ? error.message : 'camera_bridge_unavailable');
    }
    if (!onboarding) return response;
    // Keep a usable diagnostic entrypoint when remote auth/configuration is missing.
    if (response.error) return { jsonrpc: '2.0', id, result: { tools: [connectionTool, versionTool] } };
    return { ...response, result: { ...response.result, tools: [versionTool, connectionTool, ...response.result.tools] } };
  }
  if (message.method === 'tools/call') {
    if (onboarding && params.name === connectionTool.name) {
      if (!onlyKeys(params, ['name', 'arguments', '_meta']) || !onlyKeys(params.arguments ?? {}, [])) return rpcError(id, -32602, 'invalid params');
      let status;
      try { await validateConfiguration(); status = { configuration: 'configured', service: 'unverified', hardware: 'unverified', next: '运行插件 mcp/setup.mjs doctor，或读取远端 vision_workshop_runtime_status。' }; }
      catch (error) { status = { configuration: 'unavailable', code: error instanceof BridgeError ? error.message : 'camera_bridge_unavailable', hint: describeError(error instanceof BridgeError ? error.message : 'camera_bridge_unavailable'), service: 'unverified', hardware: 'unverified', next: '阅读插件连接与自检说明，使用 mcp/setup.mjs configure 配置私有连接；不要在对话中发送凭据。' }; }
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(status) }], isError: false } };
    }
    if (params.name === versionTool.name) {
      if (!onlyKeys(params, ['name', 'arguments', '_meta']) || !onlyKeys(params.arguments ?? {}, [])) return rpcError(id, -32602, 'invalid params');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ version: PLUGIN_VERSION }) }], isError: false } };
    }
    const allowed = TOOL_ARGUMENTS.get(params.name);
    const args = params.arguments ?? {};
    if (!onlyKeys(params, ['name', 'arguments', '_meta']) || !allowed || !onlyKeys(args, allowed)) return rpcError(id, -32602, 'unknown camera tool or invalid arguments');
    // All tool calls are serialized, including read-modify-write camera operations.
    const run = () => remote({ jsonrpc: '2.0', id, method: message.method, params: { name: params.name, arguments: args } });
    const operation = toolChain.then(run, run); toolChain = operation.then(() => {}, () => {}); return operation;
  }
  return rpcError(id, -32601, 'method not found');
}
let outputChain = Promise.resolve();
function output(message) {
  if (!message) return Promise.resolve();
  let line;
  try { line = JSON.stringify(message) + '\n'; } catch { line = JSON.stringify(rpcError(null, -32603, 'camera_bridge_output_invalid')) + '\n'; }
  if (Buffer.byteLength(line) > MAX_BYTES) line = JSON.stringify(rpcError(null, -32603, 'camera_bridge_output_too_large')) + '\n';
  outputChain = outputChain.then(async () => { if (!process.stdout.write(line)) await once(process.stdout, 'drain'); });
  return outputChain;
}
export async function runBridge() {
  const active = new Set();
  const schedule = async bytes => {
    while (active.size >= MAX_CONCURRENT) await Promise.race(active);
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { await output(rpcError(null, -32700, 'parse error')); return; }
    const task = dispatch(message).catch(error => {
      const code = error instanceof BridgeError ? error.message : 'camera_bridge_unavailable';
      return rpcError(message?.id, -32001, code + ': ' + describeError(code));
    }).then(output);
    active.add(task); task.then(() => active.delete(task), () => active.delete(task));
  };
  let pending = Buffer.alloc(0); let oversized = false;
  for await (const chunk of process.stdin) {
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      if (end !== chunk.length && chunk[end] !== 10) continue;
      const fragment = chunk.subarray(start, end);
      if (!oversized) {
        if (pending.length + fragment.length > MAX_INPUT_BYTES) { pending = Buffer.alloc(0); oversized = true; }
        else pending = Buffer.concat([pending, fragment]);
      }
      if (end !== chunk.length) {
        if (oversized) await output(rpcError(null, -32600, 'camera_bridge_input_too_large'));
        else if (pending.length) await schedule(pending);
        pending = Buffer.alloc(0); oversized = false;
      }
      start = end + 1;
    }
  }
  if (oversized) await output(rpcError(null, -32600, 'camera_bridge_input_too_large'));
  else if (pending.length) await schedule(pending);
  await Promise.all(active); await outputChain;
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === modulePath) {
  runBridge().catch(async () => { await output(rpcError(null, -32603, 'camera_bridge_stdio_failed')).catch(() => {}); process.exitCode = 1; });
}
