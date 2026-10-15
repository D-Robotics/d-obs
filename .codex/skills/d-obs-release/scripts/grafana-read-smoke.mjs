#!/usr/bin/env node
/** Native Grafana real-model acceptance. GET tools only; no retries/confirm.
 * node grafana-read-smoke.mjs --origin http://127.0.0.1:PORT/dobs [--limit 4..10]
 * node grafana-read-smoke.mjs --origin https://rdkstudio.d-robotics.cc/dobs
 * Linux root can read only the admin-token entry from d-obs.service MainPID env.
 * Logs contain case names, HTTP statuses, counts, safe codes and reply length.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = '/api/ops/observability';
const API = ROOT + '/grafana';
const ASSISTANT = ROOT + '/assistant';
const PUBLIC = 'https://rdkstudio.d-robotics.cc/dobs';
const LIST = 'GET ' + API + '/dashboards';
const DETAIL = 'GET ' + API + '/dashboards/:uid';
const SOURCES = 'GET ' + API + '/datasources';
const PROM = 'GET ' + ROOT + '/prom/query';
const UID = /^[A-Za-z0-9_-]{1,128}$/;
const validUid = (value) => typeof value === 'string' && UID.test(value);
const READ_ONLY = '本次只查询真实现状；只允许只读 GET 工具，不创建、修改、删除、确认、审批、启停、发送通知或开始采集。请依据真实回执回答。';
const MAX_BYTES = 2 * 1024 * 1024;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
function failure(code, status = 0) { const error = new Error(code); error.status = status; throw error; }
function safeError(error) {
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'smoke_request_timeout';
  return typeof error?.message === 'string' && /^[a-z][a-z0-9_]{2,100}$/.test(error.message) ? error.message : 'smoke_request_failed';
}
function apiError(data) { return typeof data?.error === 'string' && /^[a-z][a-z0-9_]{2,100}$/.test(data.error) ? data.error : 'smoke_api_rejected'; }
function safeCredential(value) {
  const credential = String(value ?? '').trim();
  if (credential.length > 16384 || /[\x00-\x1f\x7f]/.test(credential)) failure('invalid_smoke_credential');
  return credential;
}
export function validateOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) failure('invalid_smoke_origin');
  let url; try { url = new URL(value); } catch { failure('invalid_smoke_origin'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  const origin = url.toString().replace(/\/+$/, '');
  if (url.username || url.password || url.search || url.hash || !['/', '/dobs', '/dobs/'].includes(url.pathname)
    || !((url.protocol === 'http:' && local) || origin === PUBLIC)) failure('unsafe_smoke_origin');
  return origin;
}
function serviceToken() {
  if (process.platform !== 'linux') return '';
  try {
    const pid = execFileSync('systemctl', ['show', 'd-obs.service', '--property=MainPID', '--value'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return '';
    const entry = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').find((value) => value.startsWith('RDK_CREDITS_ADMIN_TOKEN='));
    return safeCredential(entry?.slice('RDK_CREDITS_ADMIN_TOKEN='.length));
  } catch { return ''; }
}
function headersFromEnvironment() {
  const token = safeCredential(process.env.ASSISTANT_SMOKE_ADMIN_TOKEN || process.env.RDK_CREDITS_ADMIN_TOKEN) || serviceToken();
  if (!token) failure('smoke_credential_unavailable');
  return { 'x-admin-token': token };
}
async function requestJson(origin, path, headers, fetchImpl, body) {
  // Only the assistant chat transport can be POSTed; all tools remain GET-only.
  if (body !== undefined && path !== ASSISTANT + '/chat') failure('smoke_write_transport_rejected');
  const response = await fetchImpl(origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { ...headers, accept: 'application/json', 'x-rdk-ops-read-only': '1', 'x-rdk-ops-action': body === undefined ? 'observability-context' : 'observability', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const status = response.status;
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => undefined); failure('invalid_smoke_content_type', status); }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BYTES) { await response.body?.cancel().catch(() => undefined); failure('smoke_response_too_large', status); }
  const reader = response.body?.getReader(); if (!reader) failure('empty_smoke_response', status);
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel().catch(() => undefined); failure('smoke_response_too_large', status); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { failure('invalid_smoke_json', status); }
  return { status, data };
}
function redactText(value) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/((?:["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|authorization|cookie|dsn|(?:[A-Z_]{0,64}DB_URL))["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}
function safeText(value) { return typeof value === 'string' && redactText(value) === value && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function nativeEnvelope(value) {
  if (!object(value) || value.ok !== true || value.scope !== 'platform' || value.source !== 'grafana-api' || value.containsLiveMetrics !== false) failure('invalid_grafana_source_contract');
}
function validCatalog(data, limit) {
  nativeEnvelope(data);
  if (!keys(data, ['ok', 'scope', 'source', 'containsLiveMetrics', 'dashboards', 'returnedCount', 'limit', 'mayHaveMore']) || !Array.isArray(data.dashboards) || data.dashboards.length > limit || data.returnedCount !== data.dashboards.length || data.limit !== limit || typeof data.mayHaveMore !== 'boolean') failure('invalid_grafana_catalog_shape');
  const seen = new Set();
  for (const item of data.dashboards) {
    if (!keys(item, ['uid', 'title', 'folderUid', 'folderTitle', 'tags', 'path']) || !validUid(item.uid) || seen.has(item.uid) || !safeText(item.title) || !safeText(item.folderTitle) || !(item.folderUid === null || validUid(item.folderUid)) || !Array.isArray(item.tags) || !item.tags.every(safeText) || item.path !== '/dobs/grafana/d/' + item.uid) failure('invalid_grafana_catalog_shape');
    seen.add(item.uid);
  }
  return data.dashboards;
}
function validSources(data) {
  nativeEnvelope(data);
  if (!keys(data, ['ok', 'scope', 'source', 'containsLiveMetrics', 'datasources', 'returnedCount', 'truncated']) || !Array.isArray(data.datasources) || data.datasources.length > 100 || data.returnedCount !== data.datasources.length || typeof data.truncated !== 'boolean') failure('invalid_grafana_datasource_shape');
  for (const item of data.datasources) {
    if (!keys(item, ['uid', 'name', 'type', 'isDefault', 'readOnly']) || !validUid(item.uid) || !safeText(item.name) || !safeText(item.type) || typeof item.isDefault !== 'boolean' || !(item.readOnly === null || typeof item.readOnly === 'boolean')) failure('unsafe_grafana_datasource_projection');
  }
  return data.datasources;
}
function validRef(value) { return value === null || (keys(value, ['uid', 'type']) && safeText(value.uid) && safeText(value.type)); }
function validDetail(data, uid) {
  nativeEnvelope(data);
  const item = data.dashboard;
  if (!keys(data, ['ok', 'scope', 'source', 'containsLiveMetrics', 'dashboard']) || !keys(item, ['uid', 'title', 'version', 'provisioned', 'readOnly', 'folderUid', 'folderTitle', 'path', 'panels', 'panelCount', 'panelCountIsLowerBound', 'panelsTruncated', 'variables', 'variablesTruncated']) || item.uid !== uid || item.readOnly !== true || !safeText(item.title) || !safeText(item.folderTitle) || item.path !== '/dobs/grafana/d/' + uid || !Array.isArray(item.panels) || item.panels.length > 80 || !Number.isInteger(item.panelCount) || item.panelCount < item.panels.length || typeof item.panelsTruncated !== 'boolean' || typeof item.panelCountIsLowerBound !== 'boolean' || !Array.isArray(item.variables) || item.variables.length > 40 || typeof item.variablesTruncated !== 'boolean') failure('invalid_grafana_detail_shape');
  for (const variable of item.variables) if (!keys(variable, ['name', 'type', 'multi', 'includeAll']) || !safeText(variable.name) || !safeText(variable.type) || typeof variable.multi !== 'boolean' || typeof variable.includeAll !== 'boolean') failure('unsafe_grafana_variable_projection');
  let targets = 0; const executable = [];
  for (const panel of item.panels) {
    if (!keys(panel, ['id', 'title', 'type', 'datasource', 'targets', 'targetCount', 'targetsTruncated']) || !safeText(panel.title) || !safeText(panel.type) || !validRef(panel.datasource) || !Array.isArray(panel.targets) || panel.targets.length > 8 || !Number.isInteger(panel.targetCount) || panel.targetCount < panel.targets.length || typeof panel.targetsTruncated !== 'boolean') failure('unsafe_grafana_panel_projection');
    for (const target of panel.targets) {
      if (!keys(target, ['refId', 'datasource', 'hidden', 'expr', 'expressionOmitted', 'expressionRedacted', 'hasTemplateVariables', 'queryExecutableViaPlatform']) || !safeText(target.refId) || !validRef(target.datasource) || ['hidden', 'expressionOmitted', 'expressionRedacted', 'hasTemplateVariables', 'queryExecutableViaPlatform'].some((key) => typeof target[key] !== 'boolean') || (target.expr !== undefined && (!safeText(target.expr) || target.expr.length > 2000))) failure('unsafe_grafana_target_projection');
      targets++;
      if (target.queryExecutableViaPlatform) {
        if (!target.expr?.trim() || target.expr.includes('$') || target.expressionOmitted || target.expressionRedacted || target.hasTemplateVariables || target.datasource?.type !== 'prometheus') failure('invalid_grafana_executable_query');
        executable.push(target.expr);
      }
    }
  }
  return { dashboard: item, panelCount: item.panels.length, targetCount: targets, executable };
}
function unwrap(value) { return object(value) && value.truncated === true && object(value.structuredData) ? value.structuredData : value; }
function arrayInfo(value) {
  if (Array.isArray(value)) return { items: value, total: value.length, partial: false };
  if (object(value) && Array.isArray(value.items) && Number.isInteger(value.totalItems) && value.totalItems >= value.items.length && value.includedItems === value.items.length && value.truncated === true) return { items: value.items, total: value.totalItems, partial: true };
  failure('invalid_bounded_array');
}
function promEvidence(value, expression) {
  const data = unwrap(value);
  if (!object(data) || data.ok !== true || data.promql !== expression) failure('prom_query_receipt_mismatch');
  const rows = arrayInfo(data.series); let points = 0; let partial = rows.partial || value?.truncated === true;
  for (const row of rows.items) {
    if (!object(row) || !safeText(row.name)) failure('invalid_prom_query_result');
    const samples = arrayInfo(row.points); partial ||= samples.partial;
    if (samples.items.some((point) => !object(point) || !Number.isFinite(point.ts) || !Number.isFinite(point.value))) failure('invalid_prom_query_result');
    points += samples.total;
  }
  if (rows.total > 0 && rows.items.length && points === 0) failure('invalid_prom_query_result');
  return { seriesCount: rows.total, includedSeriesCount: rows.items.length, pointCount: points, empty: rows.total === 0, partial };
}
function evaluateChat(result, catalog, expected) {
  const errors = []; const data = result.data; const reply = typeof data?.reply === 'string' ? data.reply : '';
  if (result.status !== 200) errors.push('chat_http_failure');
  if (data?.ok !== true) errors.push(apiError(data));
  if (!reply.trim()) errors.push('empty_assistant_reply');
  if (redactText(reply) !== reply) errors.push('unsafe_assistant_text');
  if (/\bplatform_assistant_[a-z0-9_]+\b/.test(reply)) errors.push('assistant_error_marker');
  if (data?.confirmationRequired === true || data?.authorization !== undefined) errors.push('unexpected_mutation_proposal');
  const receipts = Array.isArray(data?.operations) ? data.operations : [];
  if (!receipts.length) errors.push('no_real_operation_receipt');
  for (const receipt of receipts) {
    const operation = catalog.get(receipt?.id);
    if (!operation || operation.method !== 'GET' || operation.mutating !== false) errors.push('operation_not_read_only');
    if (receipt?.ok !== true || receipt.status !== 200) errors.push('operation_receipt_failed');
    if (receipt?.data?.downloadUrl !== undefined) errors.push('download_operation_not_permitted');
  }
  for (const id of expected) if (!receipts.some((receipt) => receipt.id === id && receipt.ok === true && receipt.status === 200)) errors.push('expected_get_receipt_missing');
  return { errors, reply, receipts, replyLength: reply.length, receiptCount: receipts.length, receiptStatuses: receipts.map((receipt) => Number.isInteger(receipt?.status) ? receipt.status : 0) };
}

export async function runGrafanaReadSmoke({ origin, limit = 10, headers = {}, fetchImpl = fetch, emit = (item) => process.stdout.write(JSON.stringify(item) + '\n') }) {
  origin = validateOrigin(origin);
  if (!Number.isInteger(limit) || limit < 4 || limit > 10) failure('invalid_smoke_limit');
  let failed = false;
  const output = (name, value) => { const item = { case: name, ...value }; emit(item); if (item.ok === false) failed = true; };
  const get = (path) => requestJson(origin, path, headers, fetchImpl);
  let capability;
  try { capability = await get(ASSISTANT + '/capabilities'); }
  catch (error) { output('handshake', { status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }); return false; }
  const handshakeErrors = []; const catalog = new Map(); const data = capability.data;
  if (capability.status !== 200 || data?.ok !== true) handshakeErrors.push('capabilities_http_failure');
  if (data?.readOnlyExecutionSupported !== true) handshakeErrors.push('read_only_execution_not_supported');
  if (data?.modelEnabled !== true) handshakeErrors.push('assistant_model_not_enabled');
  if (!Array.isArray(data?.operations) || !data.operations.length) handshakeErrors.push('invalid_capability_catalog');
  else for (const operation of data.operations) {
    if (!object(operation) || typeof operation.id !== 'string' || operation.id !== `GET ${operation.path}` || operation.method !== 'GET' || operation.mutating !== false || catalog.has(operation.id)) { handshakeErrors.push('invalid_capability_catalog'); break; }
    catalog.set(operation.id, operation);
  }
  for (const id of [LIST, DETAIL, SOURCES, PROM]) if (!catalog.has(id)) handshakeErrors.push('required_read_capability_missing');
  output('handshake', { status: capability.status, ok: handshakeErrors.length === 0, capabilityCount: catalog.size, errors: [...new Set(handshakeErrors)], replyLength: 0 });
  if (handshakeErrors.length) return false;
  let list; let sources; const details = [];
  try {
    const result = await get(API + '/dashboards?limit=' + limit);
    if (result.status !== 200) failure(apiError(result.data), result.status);
    const dashboards = validCatalog(result.data, limit); list = result.data;
    output('native_catalog', { status: result.status, ok: true, dashboardCount: dashboards.length, partial: result.data.mayHaveMore, errors: [], replyLength: 0 });
  } catch (error) { output('native_catalog', { status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }); }
  try {
    const result = await get(API + '/datasources');
    if (result.status !== 200) failure(apiError(result.data), result.status);
    sources = validSources(result.data);
    output('native_datasources', { status: result.status, ok: true, datasourceCount: sources.length, partial: result.data.truncated, errors: [], replyLength: 0 });
  } catch (error) { output('native_datasources', { status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }); }
  if (!list || !sources) return false;
  for (const [index, dashboard] of list.dashboards.entries()) {
    try {
      const result = await get(API + '/dashboards/' + encodeURIComponent(dashboard.uid));
      if (result.status !== 200) failure(apiError(result.data), result.status);
      const detail = validDetail(result.data, dashboard.uid); details.push(detail);
      output('native_detail', { sequence: index + 1, status: result.status, ok: true, panelCount: detail.panelCount, targetCount: detail.targetCount, executableQueryCount: detail.executable.length, partial: detail.dashboard.panelsTruncated || detail.dashboard.variablesTruncated || detail.dashboard.panels.some((panel) => panel.targetsTruncated), errors: [], replyLength: 0 });
    } catch (error) { output('native_detail', { sequence: index + 1, status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }); }
  }
  async function chat(name, message, expected, check) {
    let result;
    try { result = await requestJson(origin, ASSISTANT + '/chat', headers, fetchImpl, { message: message + '\n\n' + READ_ONLY, history: [], context: { view: 'overview' } }); }
    catch (error) { output(name, { status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }); return; }
    const assessed = evaluateChat(result, catalog, expected); let counts = {};
    try { counts = check(assessed); } catch (error) { assessed.errors.push(safeError(error)); }
    output(name, { status: result.status, ok: assessed.errors.length === 0, receiptCount: assessed.receiptCount, receiptStatuses: assessed.receiptStatuses, replyLength: assessed.replyLength, ...counts, errors: [...new Set(assessed.errors)] });
  }
  await chat('assistant_native_catalog', '看看当前原生 Grafana 有哪些大盘，以及配置了哪些数据源。请分别读取原生目录和数据源，区分配置定义与实时指标。', [LIST, SOURCES], ({ receipts, reply }) => {
    const listData = unwrap(receipts.find((receipt) => receipt.id === LIST)?.data);
    const sourceData = unwrap(receipts.find((receipt) => receipt.id === SOURCES)?.data);
    nativeEnvelope(listData); nativeEnvelope(sourceData);
    const dashboards = arrayInfo(listData.dashboards); const datasources = arrayInfo(sourceData.datasources);
    if (!/Grafana|原生/i.test(reply) || !/数据源|datasource/i.test(reply)) failure('native_catalog_narrative_missing');
    return { dashboardCount: dashboards.total, datasourceCount: datasources.total, partial: dashboards.partial || datasources.partial || listData.mayHaveMore === true };
  });
  const choices = details.flatMap((detail) => detail.executable.map((expression) => ({ detail, expression }))).sort((a, b) => a.expression.length - b.expression.length);
  const selected = choices[0]; const selectedDetail = selected?.detail ?? details[0];
  if (!selectedDetail) {
    output('assistant_native_detail', { status: 0, ok: false, dashboardCount: 0, errors: ['no_real_dashboard_available'], replyLength: 0 });
    output('assistant_native_metrics', { status: 0, ok: false, errors: ['no_real_query_available'], replyLength: 0 });
    return false;
  }
  await chat('assistant_native_detail', `读取原生 Grafana 大盘 UID ${selectedDetail.dashboard.uid}，告诉我有哪些面板、数据源引用及查询表达式定义。这里查询的是定义，不要把定义当成实时指标值。`, [DETAIL], ({ receipts, reply }) => {
    const receiptData = unwrap(receipts.find((receipt) => receipt.id === DETAIL)?.data); nativeEnvelope(receiptData);
    if (receiptData.dashboard?.uid !== selectedDetail.dashboard.uid) failure('native_detail_receipt_mismatch');
    const panels = arrayInfo(receiptData.dashboard.panels);
    let targets = 0; for (const panel of panels.items) targets += arrayInfo(panel.targets).total;
    if (!/定义|表达式|PromQL|配置/i.test(reply)) failure('native_definition_narrative_missing');
    if (selectedDetail.targetCount > 0 && targets === 0 && !panels.partial) failure('native_query_definitions_missing');
    return { panelCount: panels.total, targetCount: targets, partial: panels.partial || receipts.find((receipt) => receipt.id === DETAIL)?.data?.truncated === true };
  });
  if (!selected) { output('assistant_native_metrics', { status: 0, ok: false, errors: ['no_real_query_available'], replyLength: 0 }); return false; }
  await chat('assistant_native_metrics', `请查询原生 Grafana 大盘 ${selected.detail.dashboard.uid} 中这个已验证可执行的 PromQL 最近 5 分钟的实际指标数据：\n${selected.expression}\n请通过平台 Prometheus 查询获取实际时间序列与样本，不能只返回 Grafana 面板定义。如果实际结果为空，请明确说明窗口内没有数据。`, [PROM], ({ receipts, reply }) => {
    const evidence = promEvidence(receipts.find((receipt) => receipt.id === PROM)?.data, selected.expression);
    if (evidence.empty && !/为空|没有.{0,12}(?:数据|样本|序列)|未返回|未查到|0\s*(?:个)?(?:序列|样本)|empty|no\s+(?:data|series)/i.test(reply)) failure('empty_prom_result_not_explained');
    if (!evidence.empty && !/指标|序列|样本|数据|series|samples?|points?/i.test(reply)) failure('prom_data_narrative_missing');
    return evidence;
  });
  output('summary', { status: 0, ok: !failed, dashboardCount: list.dashboards.length, detailCount: details.length, datasourceCount: sources.length, partial: list.mayHaveMore, errors: [], replyLength: 0 });
  return !failed;
}

async function main() {
  let origin; let limit = 10;
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === '--origin') origin = process.argv[++index];
    else if (process.argv[index] === '--limit') limit = Number(process.argv[++index]);
    else if (['--help', '-h'].includes(process.argv[index])) { process.stdout.write('Usage: node grafana-read-smoke.mjs --origin loopback-http-or-fixed-platform-https [--limit 4..10]\n'); return; }
    else failure('invalid_smoke_argument');
  }
  // Origin validation precedes credential access; no default destination.
  origin = validateOrigin(origin);
  if (!Number.isInteger(limit) || limit < 4 || limit > 10) failure('invalid_smoke_limit');
  process.exitCode = await runGrafanaReadSmoke({ origin, limit, headers: headersFromEnvironment() }) ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  process.stdout.write(JSON.stringify({ case: 'startup', status: error.status || 0, ok: false, errors: [safeError(error)], replyLength: 0 }) + '\n'); process.exitCode = 1;
});
