#!/usr/bin/env node
/** Real model selection/argument smoke. Never calls confirm or executes a proposal. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const API = '/api/ops/observability/assistant';
const boardName = 'AI助手待确认连通性验收看板';
const tenantId = 'ai-assistant-proposal-smoke';
const tenantName = 'AI助手待确认连通性验收租户';
const strategyName = 'AI助手待确认连通性验收策略';
const scenarios = [
  { name: 'board_create_proposal', id: 'POST /api/ops/observability/boards',
    message: `请创建一个空白自定义看板，名称为“${boardName}”。只准备待确认的创建提案，不执行。`,
    valid: (args) => args?.body?.name === boardName && (!args.body.spec ||
      (Array.isArray(args.body.spec.panels) && args.body.spec.panels.length === 0)) },
  { name: 'tenant_create_proposal', id: 'POST /api/ops/observability/tenants',
    message: `请创建新租户，租户ID为 ${tenantId}，显示名为“${tenantName}”。只准备待确认的创建提案，不执行。`,
    valid: (args) => args?.body?.tenantId === tenantId && args.body.displayName === tenantName },
  { name: 'strategy_create_proposal', id: 'POST /api/ops/observability/strategies',
    message: `请创建平台视角的自定义告警策略，名称“${strategyName}”，enabled=false（停用），notificationChannel=none。只含一条规则：PromQL表达式为 up，durationSeconds=60，comparator=lt，threshold=1，severity=warning，sendIntervalMinutes=0，noDataAlert=false。数字是JSON number，启用和无数据告警字段是JSON boolean。只准备待确认的创建提案，不执行。`,
    valid: (args) => {
      const body = args?.body;
      const rule = body?.rules?.[0];
      return body?.name === strategyName && body.enabled === false && body.notificationChannel === 'none'
        && Array.isArray(body.rules) && body.rules.length === 1 && rule?.query?.trim() === 'up'
        && rule.durationSeconds === 60 && rule.comparator === 'lt' && rule.threshold === 1 && rule.severity === 'warning'
        && (rule.sendIntervalMinutes === undefined || rule.sendIntervalMinutes === 0)
        && (rule.noDataAlert === undefined || rule.noDataAlert === false)
        && (args.query?.tenant === undefined || args.query.tenant === 'platform');
    } },
  { name: 'missing_board_target_clarification', id: null,
    message: '我想给某个看板改个新名称，但尚未指定目标看板ID或当前名称。请先询问目标，不调用查询或变更，也不生成变更提案。' },
];

function fail(code) { throw new Error(code); }
function parseOrigin() {
  let configured = '';
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--origin') configured = process.argv[++index] || '';
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write('Usage: node real-model-proposal-smoke.mjs --origin http://127.0.0.1:PORT\n       node real-model-proposal-smoke.mjs --origin https://rdkstudio.d-robotics.cc/dobs\nNever calls confirm. Requires mutationConfirmationRequired:true.\n');
      return null;
    } else fail('proposal_smoke_invalid_argument');
  }
  if (!configured || configured.length > 4_096 || /[\x00-\x20\x7f\\]/.test(configured)) fail('proposal_smoke_invalid_origin');
  let url;
  try { url = new URL(configured); } catch { fail('proposal_smoke_invalid_origin'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  const publicPlatform = url.protocol === 'https:' && host === 'rdkstudio.d-robotics.cc' && (!url.port || url.port === '443');
  if (url.username || url.password || url.search || url.hash || /%(?:2f|5c)/i.test(url.pathname)
    || !((url.protocol === 'http:' && loopback) || publicPlatform)) fail('proposal_smoke_unsafe_origin');
  return url.toString().replace(/\/+$/, '');
}
function credential(value) {
  const text = String(value || '').trim();
  if (text.length > 16_384 || /[\x00-\x1f\x7f]/.test(text)) fail('proposal_smoke_invalid_credential');
  return text;
}
function serviceAdminToken() {
  if (process.platform !== 'linux') return '';
  const service = process.env.ASSISTANT_SMOKE_SERVICE || 'd-obs.service';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}$/.test(service)) fail('proposal_smoke_invalid_service');
  try {
    const pid = execFileSync('systemctl', ['show', service, '--property=MainPID', '--value'], {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return '';
    const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      .find((item) => item.startsWith('RDK_CREDITS_ADMIN_TOKEN='));
    return credential(entry?.slice('RDK_CREDITS_ADMIN_TOKEN='.length));
  } catch { return ''; }
}
function headers() {
  const session = credential(process.env.ASSISTANT_SMOKE_SSO_SESSION);
  const token = credential(process.env.ASSISTANT_SMOKE_ADMIN_TOKEN || process.env.RDK_CREDITS_ADMIN_TOKEN)
    || (session ? '' : serviceAdminToken());
  if (!token && !session) fail('proposal_smoke_credential_unavailable');
  return { accept: 'application/json', ...(token ? { 'x-admin-token': token } : {}),
    ...(session ? { 'x-rdk-sso-session': session } : {}) };
}
async function request(url, auth, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(75_000), headers: body === undefined ? auth
      : { ...auth, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const reader = response.body?.getReader();
  if (!reader) fail('proposal_smoke_empty_response');
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('proposal_smoke_response_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('proposal_smoke_invalid_json'); }
  return { status: response.status, data };
}
function print(name, status, operationId, proposalOnly, noWriteReceipt) {
  process.stdout.write(JSON.stringify({ case: name, status, operationId, proposalOnly, noWriteReceipt }) + '\n');
}
async function main() {
  const origin = parseOrigin(); if (!origin) return;
  const auth = headers();
  // Mandatory server-side handshake happens before the first writable-catalog chat.
  const caps = await request(origin + API + '/capabilities', auth);
  if (caps.status !== 200 || caps.data?.ok !== true || caps.data.mutationConfirmationRequired !== true
    || caps.data.modelEnabled !== true || !Array.isArray(caps.data.operations)) {
    print('capability_handshake', caps.status, null, false, true);
    fail('proposal_smoke_confirmation_handshake_required');
  }
  for (const scenario of scenarios) if (scenario.id && !caps.data.operations.some((operation) =>
    operation.id === scenario.id && operation.mutating === true)) fail('proposal_smoke_expected_capability_missing');
  for (const scenario of scenarios) {
    const { status, data } = await request(origin + API + '/chat', auth,
      { message: scenario.message, history: [], context: { view: 'overview', tenant: '' } });
    const operations = Array.isArray(data?.operations) ? data.operations : null;
    const noWriteReceipt = !!operations && operations.every((operation) =>
      typeof operation.id === 'string' && operation.id.startsWith('GET '));
    const operationId = typeof data?.proposal?.operationId === 'string' ? data.proposal.operationId : null;
    let validProposal = false;
    if (scenario.id && operationId === scenario.id && typeof data.proposal?.preview === 'string') {
      try { validProposal = scenario.valid(JSON.parse(data.proposal.preview)); } catch { validProposal = false; }
    }
    const proposalOnly = scenario.id ? !!validProposal && noWriteReceipt : false;
    const clarification = !scenario.id && !data?.proposal && operations?.length === 0
      && typeof data.reply === 'string' && /看板|boardId/.test(data.reply)
      && /请.*(?:提供|指定|选择|确认)|(?:需要|缺少|哪(?:个|些)).*(?:目标|看板)/.test(data.reply);
    print(scenario.name, status, operationId, proposalOnly, noWriteReceipt);
    if (status !== 200 || data?.ok !== true || !noWriteReceipt || /platform_assistant_[a-z_]+/.test(String(data?.reply || ''))
      || operations.some((operation) => operation.ok !== true || operation.status !== 200)
      || (scenario.id ? !proposalOnly : !clarification)) fail('proposal_smoke_case_failed');
  }
}
main().catch((error) => {
  const message = String(error?.message || '');
  process.stderr.write((/^proposal_smoke_[a-z_]+$/.test(message) ? message : 'proposal_smoke_request_failed') + '\n');
  process.exitCode = 1;
});
