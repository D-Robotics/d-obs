#!/usr/bin/env node
/**
 * Read-only end-to-end assistant smoke against an already-running service.
 *
 * node tools/platform-assistant-read-smoke.mjs
 * ASSISTANT_SMOKE_ORIGIN=https://rdkstudio.d-robotics.cc/dobs node tools/platform-assistant-read-smoke.mjs
 * node tools/platform-assistant-read-smoke.mjs --public
 *
 * Credentials: ASSISTANT_SMOKE_ADMIN_TOKEN / RDK_CREDITS_ADMIN_TOKEN, or
 * ASSISTANT_SMOKE_SSO_SESSION. With neither, Linux servers may read the admin
 * token from the selected systemd service's MainPID environment. No credentials,
 * reply text, account data, or raw tool payloads are printed.
 *
 * The server must advertise readOnlyExecutionSupported:true and enforce
 * x-rdk-ops-read-only:1 before dispatch. Older servers fail before any chat.
 * A prompt alone cannot prevent side effects when the chat route requires its
 * normal observability action guard. This script never sends a writable chat.
 * Eleven sequential scenarios include two exact model-pool questions and one
 * history-bearing follow-up that must still read current model-pool state.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const LOOPBACK_ORIGIN = 'http://127.0.0.1:18093';
const PUBLIC_ORIGIN = 'https://rdkstudio.d-robotics.cc/dobs';
const API = '/api/ops/observability/assistant';
// The host's fixed diagnostic workflow is a read-only POST. This permits its
// catalog declaration; the scenarios below still require GET-only receipts.
const READ_ONLY_CATALOG_OPERATIONS = new Set(['POST /api/ops/observability/plugins/:id/workflows/:workflowId/run']);
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const READ_ONLY_INSTRUCTION = '\n\n本次仅查询：只允许读取当前平台数据，不创建、修改、删除、审批、执行、启停、投递通知、轮换凭据或开始采集。请根据真实只读工具回执回答；需要写操作时停止并说明，不能发起写操作。';

const scenarios = [
  { name: 'model_pool_first', message: '目前rdkstudio背后模型池情况', exact: true, expected: ['GET /api/ops/observability/model-pool'] },
  { name: 'model_pool_repeat', message: '目前rdkstudio背后模型池情况', exact: true, expected: ['GET /api/ops/observability/model-pool'] },
  {
    name: 'model_pool_followup',
    message: '看一下刚才这些模型的fallback路由现状',
    history: [
      { role: 'user', content: '目前rdkstudio背后模型池情况' },
      { role: 'assistant', content: '刚才已经查询过模型池，但未修改配置。模型与 fallback 路由的现状需要重新读取平台确认。' },
    ],
    expected: ['GET /api/ops/observability/model-pool'],
  },
  { name: 'alerts', message: '目前平台有哪些待处理告警？请查询真实状态。', expected: ['GET /api/ops/observability/incidents', 'GET /api/ops/observability/overview'] },
  { name: 'slo', message: '目前rdkstudio的 SLO 和错误预算情况怎么样？请查询实际数据。', expected: ['GET /api/ops/observability/overview'] },
  { name: 'operator_metrics', message: '最近一个月平台的运营指标怎么样？', expected: ['GET /api/ops/observability/operator-metrics'] },
  { name: 'tenants', message: '现在平台接入了哪些租户？请读取当前租户列表。', expected: ['GET /api/ops/observability/tenants'] },
  { name: 'log_entries', message: '平台目前有哪些日志来源和日志查询入口？请读取现有日志来源信息，不开始采集。', expected: ['GET /api/ops/observability/logs/facets', 'GET /api/ops/observability/logs', 'GET /api/ops/observability/ssh-logs/targets', 'GET /api/ops/observability/rdk-logs/targets', 'GET /api/ops/observability/rdk-logs/profiles'] },
  { name: 'copilot_status', message: '事故副驾的模型研判目前启用了吗？请查询实际状态。', expected: ['GET /api/ops/observability/copilot/status'] },
  { name: 'overview', message: '平台目前整体状态怎么样？请查询最近一小时的总览。', expected: ['GET /api/ops/observability/overview'] },
  { name: 'quality', message: '最近30天的运行质量和用户反馈情况怎么样？请查询真实趋势。', expected: ['GET /api/ops/observability/quality/summary'] },
];

function fail(code) {
  throw new Error(code);
}

function parseOrigin() {
  let configured = process.env.ASSISTANT_SMOKE_ORIGIN || LOOPBACK_ORIGIN;
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--public') configured = process.env.ASSISTANT_SMOKE_ORIGIN || PUBLIC_ORIGIN;
    else if (argument === '--origin') configured = process.argv[++index] || '';
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: node tools/platform-assistant-read-smoke.mjs [--public | --origin URL]\nCredentials: ASSISTANT_SMOKE_ADMIN_TOKEN / RDK_CREDITS_ADMIN_TOKEN / ASSISTANT_SMOKE_SSO_SESSION; Linux may read d-obs.service MainPID env.\n');
      return null;
    } else fail('invalid_smoke_argument');
  }
  if (typeof configured !== 'string' || configured.length > 4096 || /[\x00-\x20\x7f\\]/.test(configured)) fail('invalid_smoke_origin');
  let origin;
  try { origin = new URL(configured); } catch { fail('invalid_smoke_origin'); }
  const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (origin.username || origin.password || origin.search || origin.hash
    || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))
    || /%(?:2f|5c)/i.test(origin.pathname)) fail('unsafe_smoke_origin');
  return origin.toString().replace(/\/+$/, '');
}

function credentialText(value) {
  const text = String(value || '').trim();
  if (text.length > 16_384 || /[\x00-\x1f\x7f]/.test(text)) fail('invalid_smoke_credential');
  return text;
}

function serviceAdminToken() {
  if (process.platform !== 'linux') return '';
  const service = process.env.ASSISTANT_SMOKE_SERVICE || 'd-obs.service';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}$/.test(service)) fail('invalid_smoke_service');
  try {
    const pid = execFileSync('systemctl', ['show', service, '--property=MainPID', '--value'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return '';
    const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const entry = entries.find((item) => item.startsWith('RDK_CREDITS_ADMIN_TOKEN='));
    return credentialText(entry?.slice('RDK_CREDITS_ADMIN_TOKEN='.length));
  } catch { return ''; }
}

function requestHeaders() {
  const session = credentialText(process.env.ASSISTANT_SMOKE_SSO_SESSION);
  const token = credentialText(process.env.ASSISTANT_SMOKE_ADMIN_TOKEN || process.env.RDK_CREDITS_ADMIN_TOKEN)
    || (session ? '' : serviceAdminToken());
  if (!token && !session) fail('smoke_credential_unavailable');
  return {
    accept: 'application/json',
    'x-rdk-ops-read-only': '1',
    ...(token ? { 'x-admin-token': token } : {}),
    ...(session ? { 'x-rdk-sso-session': session } : {}),
  };
}

async function requestJson(url, headers, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const reader = response.body?.getReader();
  if (!reader) fail('empty_smoke_response');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('smoke_response_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid_smoke_json'); }
  return { status: response.status, data };
}

function safeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'smoke_request_timeout';
  const code = String(error?.message || '');
  return /^[a-z][a-z0-9_]{2,100}$/.test(code) ? code : 'smoke_request_failed';
}

function apiError(data) {
  return typeof data?.error === 'string' && /^[a-z][a-z0-9_]{2,100}$/.test(data.error) ? data.error : 'smoke_api_rejected';
}

function hasStructuredState(narrative) {
  const candidates = [...narrative.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const start = narrative.indexOf('{');
  const end = narrative.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(narrative.slice(start, end + 1));
  for (const candidate of candidates) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    const pending = [value];
    let remaining = 2000;
    while (pending.length && remaining-- > 0) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      for (const [key, field] of Object.entries(item)) {
        if (/^(?:state|status)$/i.test(key) && typeof field === 'string' && field.trim()) return true;
        if (field && typeof field === 'object') pending.push(field);
      }
    }
  }
  return false;
}

function modelPoolNarrativeErrors(scenario, reply) {
  // Receipt descriptions contain "模型目标健康状态" even when the assistant
  // did not explain the pool. Only inspect the preceding substantive answer.
  const narrative = reply.split('平台实际执行记录：', 1)[0].trim();
  const errors = [];
  if (scenario.name === 'slo') {
    if (!/SLO|服务等级|服务级别|serviceLevels/i.test(narrative)) errors.push('slo_content_missing');
    if (!/错误预算|预算|errorBudget/i.test(narrative)) errors.push('slo_budget_content_missing');
    return errors;
  }
  if (!scenario.name.startsWith('model_pool_')) return [];
  if (!/模型|目标|上游|model(?:Mapping|s)?|targets?|providers?/i.test(narrative)) {
    errors.push('model_pool_target_content_missing');
  }
  if (scenario.name === 'model_pool_followup') {
    if (!/fallback|降级|路由|\brouting\b|modelMapping/i.test(narrative)) errors.push('model_pool_fallback_content_missing');
  } else if (!/健康|healthy|cooldown|half[_ -]?open|degraded|降级|冷却|熔断|半开/i.test(narrative)
    && !hasStructuredState(narrative)) {
    errors.push('model_pool_health_content_missing');
  }
  return errors;
}

function output(operationId, status, ok, replyLength, errors, receipts = []) {
  // Every receipt contains only the exact public operation identity and status.
  process.stdout.write(JSON.stringify({ operationId, status, ok, replyLength, errors, receipts }) + '\n');
}

async function main() {
  const origin = parseOrigin();
  if (!origin) return;
  const headers = requestHeaders();
  const capabilityId = `GET ${API}/capabilities`;
  const { status, data } = await requestJson(origin + API + '/capabilities', headers);
  const errors = [];
  if (status !== 200) errors.push('capabilities_http_failure');
  if (data?.ok !== true) errors.push(apiError(data));
  if (data?.readOnlyExecutionSupported !== true) errors.push('read_only_execution_not_supported');
  if (data?.modelEnabled !== true) errors.push('assistant_model_not_enabled');
  const catalog = new Map();
  if (!Array.isArray(data?.operations) || !data.operations.length) errors.push('invalid_capability_catalog');
  else {
    for (const operation of data.operations) {
      if (!operation || typeof operation.id !== 'string' || typeof operation.method !== 'string'
        || typeof operation.mutating !== 'boolean' || catalog.has(operation.id)
        || operation.id !== `${operation.method} ${operation.path}`
        || (operation.mutating === false && operation.method !== 'GET' && !READ_ONLY_CATALOG_OPERATIONS.has(operation.id))) {
        errors.push('invalid_capability_catalog');
        break;
      }
      catalog.set(operation.id, operation);
    }
  }
  output(capabilityId, status, errors.length === 0, 0, [...new Set(errors)]);
  if (errors.length) {
    process.exitCode = 1;
    return; // No chat is sent without a verified server-side read-only contract.
  }

  let failed = false;
  // One principal, one request at a time. This also respects the route's global
  // four-request concurrency cap and avoids testing our own 429 contention.
  for (const scenario of scenarios) {
    const failures = [];
    const expected = scenario.expected.filter((id) => catalog.get(id)?.mutating === false);
    if (!expected.length) {
      output(`${API}/chat#${scenario.name}`, 0, false, 0, ['required_read_capability_missing']);
      failed = true;
      continue;
    }
    let result;
    try {
      result = await requestJson(origin + API + '/chat', headers, {
        message: scenario.exact ? scenario.message : scenario.message + READ_ONLY_INSTRUCTION,
        history: scenario.history || [], context: { view: 'overview' },
      });
    } catch (error) {
      output(`${API}/chat#${scenario.name}`, 0, false, 0, [safeError(error)]);
      failed = true;
      continue;
    }
    if (result.status !== 200) failures.push('chat_http_failure');
    if (result.data?.ok !== true) failures.push(apiError(result.data));
    const reply = typeof result.data?.reply === 'string' ? result.data.reply : '';
    if (!reply.trim()) failures.push('empty_assistant_reply');
    failures.push(...modelPoolNarrativeErrors(scenario, reply));
    const markers = reply.match(/\bplatform_assistant_[a-z0-9_]+\b/g) || [];
    failures.push(...markers);
    const receipts = [];
    const operations = result.data?.operations;
    if (!Array.isArray(operations) || !operations.length) failures.push('no_real_operation_receipt');
    else {
      for (const operation of operations) {
        const id = typeof operation?.id === 'string' ? operation.id : '';
        const known = catalog.get(id);
        if (!known) failures.push('unknown_operation_receipt');
        if (/^(?:POST|PUT|PATCH|DELETE) /.test(id) || known?.mutating === true) failures.push('write_operation_rejected_by_smoke');
        if (known && (known.mutating !== false || known.method !== 'GET')) failures.push('operation_not_read_only');
        if (operation?.ok !== true || operation?.status !== 200) failures.push('operation_receipt_failed');
        receipts.push({
          operationId: known ? known.id : '[unknown_operation]',
          status: Number.isInteger(operation?.status) ? operation.status : 0,
          ok: operation?.ok === true,
        });
      }
      if (!operations.some((operation) => expected.includes(operation?.id) && operation.ok === true && operation.status === 200)) {
        failures.push('expected_read_operation_missing');
      }
    }
    const ok = failures.length === 0;
    output(`${API}/chat#${scenario.name}`, result.status, ok, reply.length, [...new Set(failures)], receipts);
    if (!ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  output(`GET ${API}/capabilities`, 0, false, 0, [safeError(error)]);
  process.exitCode = 1;
});
