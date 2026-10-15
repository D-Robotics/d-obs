#!/usr/bin/env node
/**
 * Additional assistant module acceptance, with a server-enforced GET-only catalog.
 * Existing-resource detail cases use IDs discovered by authenticated GETs. Empty
 * resources, missing account parameters and write-only modules are reported as
 * limits, never counted as completed end-to-end detail tests. No credentials,
 * narrative, resource IDs or payloads are printed. No exports are requested.
 *
 * node tools/platform-assistant-module-smoke.mjs --list
 * node tools/platform-assistant-module-smoke.mjs --public --case config,boards
 * Optional ASSISTANT_SMOKE_ACCOUNT identifies an account authorized for testing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const ROOT = '/api/ops/observability';
const API = ROOT + '/assistant';
const PUBLIC_ORIGIN = 'https://rdkstudio.d-robotics.cc/dobs';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const READ_ONLY = '\n\n仅查询真实现状：只允许 GET，不创建、修改、删除、审批、执行、启停、投递通知、轮换凭据或开始采集；不导出或下载。请根据实际只读回执回答。没有记录、未配置或缺少参数请明确说明，不编造对象 ID、指标、样本或状态。';
const id = (path) => 'GET ' + ROOT + path;
const EMPTY = /暂无|没有|未配置|未接入|未注册|无(?:可用|现有|当前|符合|相关|任何)?(?:数据|记录|样本|设备|对象|结果|行动|会话|采集|看板|面板|策略|维护|组员)|为空|空列表|\b(?:empty|unavailable|not[_ -]configured)\b|(?:数量|总数|共|count|total|targetCount)[^\n。]{0,18}[:：]?\s*0\b|\[\s*\]/i;
const FACT = /\d|启用|停用|健康|离线|在线|可用|不可用|未配置|未接入|暂无|没有|状态|来源|owner|status|state|enabled|disabled|active|critical|warning|available|configured|\[\s*\]/i;

function base(name, group, message, path, topic, detail, listField) {
  return { name, group, message, expected: [id(path)], topic, detail, listField };
}

export const MODULE_SCENARIOS = [
  base('access', '平台总览', '我当前的运营访问权限是什么？请读取访问状态和管理员标志。', '/access', /权限|访问|access/i, /管理员|isAdmin|enabled|启用|可访问/i),
  base('search', '平台总览', '搜索当前平台的观测对象和事故，列出最多五个结果。', '/search', /搜索|对象|事故|results/i, /结果|名称|路径|状态|暂无|没有|\[\s*\]/i, 'results'),
  base('config', '告警配置', '现在告警规则、阈值和通知渠道是怎样配置的？请读取配置概况，不展示秘密。', '/config', /告警|规则|config|rules/i, /阈值|通知|渠道|threshold|notification|global/i),
  base('maintenance', '告警维护窗口', '当前有没有维护窗口，告警静默到什么时候？', '/maintenance-windows', /维护|静默|windows/i, /结束|时间|暂无|没有|为空|expires|end|\[\s*\]/i, 'windows'),
  base('strategies', '告警策略', '当前有哪些自定义告警策略？请查询真实策略和启用状态。', '/strategies', /策略|strategies/i, /启用|状态|规则|暂无|没有|enabled|rules|\[\s*\]/i, 'strategies'),
  base('incident_summary', '事故处置', '最近七天的事故数量、严重度和变化趋势怎么样？请读取事故汇总。', '/incidents/summary', /事故|incident|summary/i, /数量|严重|趋势|critical|warning|total|trend|暂无|没有/i),
  base('copilot', '事故调查', '事故副驾模型研判目前可用吗？请读取实际启用状态。', '/copilot/status', /副驾|研判|copilot|模型/i, /启用|可用|配置|enabled|disabled/i),
  base('metric_catalog', '指标查询', '现有指标目录包含哪些指标和标签？请读取中文说明与接入来源。', '/metrics/catalog', /指标|metric|catalog/i, /标签|说明|来源|labels|description|OTLP|Prometheus/i),
  base('metric_series', '指标查询', '数据库现在落了哪些指标序列和标签？请最多查看十条实际序列。', '/metrics/series', /指标|序列|series/i, /标签|数量|labels|name|metric|暂无|没有|\[\s*\]/i, 'series'),
  base('metric_trend', '指标查询', '请读取最近一小时已落库指标的时间序列趋势，不用自然语言写入接口。', '/metrics/query', /指标|序列|趋势|series/i, /时间|点|样本|points|fromMs|toMs|暂无|没有|\[\s*\]/i, 'series'),
  base('metric_anomalies', '指标查询', '最近一小时有哪些指标异常？请查询异常扫描结果。', '/metrics/anomalies', /异常|anomal/i, /扫描|指标|数量|scanned|暂无|没有|\[\s*\]/i, 'anomalies'),
  base('prometheus', '指标查询', '请通过 Prometheus 查询最近十分钟的 up 指标，PromQL 使用 up，报告真实结果；如果未配置请明确说明。', '/prom/query', /Prometheus|PromQL|\bup\b|promql/i, /序列|样本|状态|series|points|未配置|不可用|暂无|没有|\[\s*\]/i, 'series'),
  base('logs', '日志查询', '请读取最近十分钟的实际日志，最多五条，概括日志来源和严重度。', '/logs', /日志|logs/i, /来源|严重|服务|severity|service|暂无|没有|\[\s*\]/i, 'logs'),
  base('sessions', '运行链路', '最近一小时有哪些会话运行链路？请读取治理保护的会话分页列表。', '/sessions', /会话|链路|session/i, /运行|状态|数量|runs|count|暂无|没有|\[\s*\]/i, 'sessions'),
  base('objects', '对象资产', '平台目前服务、设备等观测对象的聚合资产目录共有多少条、分别有哪些类型？请读取合并运行目录与接入对象注册表的资产目录，概括总数、返回上限和对象类型。', '/objects', /对象|资产|objects/i, /名称|类型|数量|objectId|objectType|暂无|没有|\[\s*\]/i, 'objects'),
  base('object_registry', '对象资产', '接入对象注册表目前有哪些来源、标签和信号类型？请读取真实注册信息。', '/object-registry', /对象|注册|objects/i, /来源|标签|信号|owner|labels|signal|暂无|没有|\[\s*\]/i, 'objects'),
  base('object_bindings', '对象资产', '现在告警规则分别绑定了哪些观测对象？请读取当前生效绑定和默认映射。', '/object-bindings', /绑定|映射|bindings/i, /规则|对象|默认|rule|object|default/i),
  base('database', '数据库资产', '当前 PostgreSQL 数据库运行状态和可预览资产目录怎么样？只读概况，不读取表内账号内容。', '/database', /数据库|PostgreSQL|database/i, /状态|目录|表|status|tables|catalog|可用/i),
  base('learning', '运营洞察', '最近三十天技能数据闭环、经验和进化模块各自的实际可用性怎么样？', '/learning', /技能|闭环|经验|进化|learning/i, /可用|状态|skill|experience|evolution|unavailable/i),
  base('iteration', '运营洞察', '最近三十天失败到重试、失败到下次成功的迭代间隔是多少？请读取真实分布。', '/runs/iteration-cycle', /迭代|重试|间隔|cycle|summary/i, /分布|成功|失败|retry|success|暂无|没有/i),
  base('boards', '自定义看板', '我当前有哪些自定义看板？请查询看板名称和面板概况。', '/boards', /看板|boards/i, /面板|名称|panels|name|暂无|没有|\[\s*\]/i, 'boards'),
  base('library_panels', '面板库', '我保存的可复用库面板有哪些？请读取面板库现状。', '/library/panels', /面板|panels/i, /指标|名称|metric|title|暂无|没有|\[\s*\]/i, 'panels'),
  base('devices', '边缘设备', '目前注册了哪些边缘设备，在线状态和最近心跳怎么样？', '/devices', /设备|devices/i, /在线|离线|心跳|状态|status|heartbeat|暂无|没有|\[\s*\]/i, 'devices'),
  base('ingest_tokens', '接入凭据', '现有生态接入凭据有哪些主体类型和状态？只读元信息，不展示或轮换明文 token。', '/ingest-tokens', /凭据|主体|tokens/i, /类型|状态|subjectType|status|暂无|没有|\[\s*\]/i, 'tokens'),
  base('model_prices', '模型成本', '目前模型的输入和输出 token 单价、币种是什么？请读取价格表。', '/model-prices', /模型|价格|单价|prices/i, /输入|输出|币种|inputPerM|outputPerM|currency/i),
  base('model_pool', '模型池', '目前模型池的目标健康状态和 fallback 路由怎样？请读取实际情况。', '/model-pool', /模型|目标|targets|上游/i, /健康|冷却|半开|healthy|cooldown|fallback|路由/i),
  base('tenants', '租户管理', '目前有哪些租户，它们的状态和组员数是什么？请读取当前列表。', '/tenants', /租户|tenants/i, /状态|组员|status|memberCount|暂无|没有|\[\s*\]/i, 'tenants'),
  base('remediation', '证据行动环', '平台配置了哪些白名单自愈剧本，启用情况和最近结果如何？只读取，不执行。', '/remediation', /自愈|剧本|remediation|playbook/i, /启用|结果|状态|enabled|status|暂无|没有/i),
  { ...base('actions', '证据行动环', '我当前账户范围有哪些行动提案？请读取审批、执行和验证状态，不发起任何行动。', '/actions', /行动|提案|actions/i, /审批|执行|验证|状态|status|暂无|没有|\[\s*\]/i, 'actions'), requiresIdentity: true },
  base('ssh_sessions', 'SSH 日志', '我当前有哪些 SSH 日志采集会话？请读取会话状态，不启动采集。', '/ssh-logs/sessions', /SSH|会话|sessions/i, /采集|状态|status|暂无|没有|\[\s*\]/i, 'sessions'),
  base('rdk_capabilities', 'RDK 日志调查', 'RDK 日志调查目前模型可用性、配置设备数和多源采集限制怎样？只读取能力。', '/rdk-logs/capabilities', /RDK|调查|设备|targetCount/i, /模型|采集|限制|maxSources|modelEnabled|配置/i),
  base('rdk_profiles', 'RDK 日志调查', 'RDK 日志调查有哪些服务端版本化模板？请读取模板适用范围和来源。', '/rdk-logs/profiles', /RDK|模板|profiles/i, /版本|来源|适用|id|version|sources|暂无|没有|\[\s*\]/i, 'profiles'),
  base('rdk_captures', 'RDK 日志调查', '我保存了哪些 RDK 多源采集组？请读取现有采集记录，不开始采集。', '/rdk-logs/captures', /RDK|采集|captures/i, /记录|状态|来源|status|sources|暂无|没有|\[\s*\]/i, 'captures'),
  { name: 'account_activity', group: '账号行为', expected: [id('/account-activity')], account: true,
    message: '查询一个账号最近七天的运行、会话、用量和登录行为。', topic: /账号|行为|账户|activity|report/i, detail: /运行|会话|用量|登录|runs|sessions|usage|login/i },
  { name: 'ingest_selftest', group: '接入自检', expected: [], writeOnly: true },
  detailCase('tenant_members', '租户组员', '/tenants', 'tenants', ['tenantId'], '/tenants/:tenantId/members', '这个已有租户的组员及角色是什么', /组员|成员|members/i, /角色|role|owner|member|暂无|没有|\[\s*\]/i),
  detailCase('object_detail', '对象资产', '/objects', 'objects', ['objectId'], '/objects/:objectId', '这个真实观测对象的画像、汇总和最近运行是什么', /对象|画像|detail/i, /汇总|运行|状态|summary|runs|status|暂无|没有/i),
  detailCase('device_samples', '边缘设备', '/devices', 'devices', ['deviceId'], '/devices/:deviceId/samples', '这个已注册设备最近一小时的实际心跳样本怎么样', /心跳|样本|设备|samples/i, /时间|指标|数量|window|fromMs|toMs|暂无|没有|\[\s*\]/i),
  detailCase('device_commands', '边缘设备', '/devices', 'devices', ['deviceId'], '/devices/:deviceId/commands', '这个已注册设备已有命令的认领和执行状态是什么，不发送新命令', /设备|命令|commands/i, /认领|执行|状态|status|暂无|没有|\[\s*\]/i),
  detailCase('incident_correlate', '事故调查', '/incidents?days=7&limit=5', 'incidents', ['alertKey'], '/incidents/:alertKey/correlate', '这个真实事故在窗口内关联到哪些异常指标、错误日志和离线设备证据', /事故|关联|证据|incident/i, /指标|日志|设备|metrics|logs|devices|暂无|没有/i),
  detailCase('action_detail', '证据行动环', '/actions?limit=5', 'actions', ['id'], '/actions/:id', '这个已有行动的详情、审批、执行和验证状态是什么', /行动|审批|action/i, /执行|验证|状态|status|暂无|没有/i),
  detailCase('ssh_snapshot', 'SSH 日志', '/ssh-logs/sessions', 'sessions', ['id'], '/ssh-logs/sessions/:id', '这个已有 SSH 采集会话目前有哪些日志快照和序列位置', /SSH|日志|会话|session/i, /快照|序列|行|游标|entries|lines|cursor|暂无|没有|\[\s*\]/i),
  detailCase('rdk_snapshot', 'RDK 日志调查', '/rdk-logs/captures', 'captures', ['id'], '/rdk-logs/captures/:id', '这个已有 RDK 采集组的各源日志快照和读取游标是什么', /RDK|采集|日志|capture/i, /来源|源|游标|sources|streams|cursor|暂无|没有|\[\s*\]/i),
  detailCase('rdk_evidence', 'RDK 日志调查', '/rdk-logs/captures', 'captures', ['id'], '/rdk-logs/captures/:id/evidence', '这个已有 RDK 采集组整理出的脱敏证据和真实引用是什么', /RDK|证据|evidence/i, /引用|ref|序列|关键词|暂无|没有|\[\s*\]/i),
  { name: 'run_detail', group: '运行链路', expected: [id('/runs/:locator')],
    discovery: '/overview?hours=1&traceLimit=5', rowsFor: (data) => data?.overview?.runTraces, discover: (data) => findRow(data?.overview?.runTraces, ['locator']),
    messageFor: (row) => `请读取这个刚由平台 GET 总览返回的运行 locator 的完整证据，locator=${JSON.stringify(row.locator)}。不能用原始 Run ID 替代；概括运行状态和证据。`,
    topic: /运行|证据|run|detail/i, detail: /状态|跨度|事件|status|spans|events|暂无|没有/i },
];

function detailCase(name, group, discovery, field, keys, path, question, topic, detail) {
  const resultLists = { tenant_members: 'members', device_samples: 'samples', device_commands: 'commands', ssh_snapshot: 'records' };
  const allowSlash = name === 'object_detail';
  const rowsFor = allowSlash ? observabilityObjectRows : (data) => data?.[field];
  return { name, group, expected: [id(path)], discovery,
    rowsFor, discover: (data) => findRow(rowsFor(data), keys, { allowSlash, preferSlash: allowSlash }),
    messageFor: (row) => `${question}？下列标识来自刚才的真实平台 GET，不自行猜测：${keys.map((key) => `${key}=${JSON.stringify(row[key])}`).join('，')}。`, topic, detail, listField: resultLists[name], requiresIdentity: name === 'action_detail' };
}

function observabilityObjectRows(data) {
  // /objects wraps the catalog snapshot as {ok,objects:{generatedAt,total,
  // limit,objects:[]}}. /object-registry has a separate flat array contract.
  // Retain the older flat /objects response without searching arbitrary paths.
  const snapshot = data?.objects;
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && Object.hasOwn(snapshot, 'objects') ? snapshot.objects : snapshot;
}

function safeResourceId(value, allowSlash) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) return false;
  if (!allowSlash) return !value.includes('/') && value !== '.' && value !== '..';
  // Object namespaces such as device/rdk-s100-0003 are legitimate opaque IDs.
  // They remain a single encoded parameter; never accept traversal selectors.
  if (/[?#]|%(?:2e|2f|5c|00|0a|0d)/i.test(value)) return false;
  return value.split('/').every((segment) => !!segment && segment !== '.' && segment !== '..');
}

function findRow(rows, keys, { allowSlash = false, preferSlash = false } = {}) {
  if (!Array.isArray(rows)) return undefined;
  const valid = rows.filter((row) => row && keys.every((key) => safeResourceId(row[key], allowSlash)));
  return (preferSlash && valid.find((row) => keys.some((key) => row[key].includes('/')))) || valid[0];
}

function fail(code) { throw new Error(code); }
export function validateOrigin(configured) {
  if (typeof configured !== 'string' || configured.length > 4096 || /[\x00-\x20\x7f\\]/.test(configured)) fail('invalid_smoke_origin');
  let origin;
  try { origin = new URL(configured); } catch { fail('invalid_smoke_origin'); }
  const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (origin.username || origin.password || origin.search || origin.hash || /%(?:2f|5c)/i.test(origin.pathname)
    || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))) fail('unsafe_smoke_origin');
  return origin.toString().replace(/\/+$/, '');
}

function credentialText(value) {
  const text = String(value || '').trim();
  if (text.length > 16384 || /[\x00-\x1f\x7f]/.test(text)) fail('invalid_smoke_credential');
  return text;
}

function serviceAdminToken() {
  if (process.platform !== 'linux') return '';
  const service = process.env.ASSISTANT_SMOKE_SERVICE || 'd-obs.service';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}$/.test(service)) fail('invalid_smoke_service');
  try {
    const pid = execFileSync('systemctl', ['show', service, '--property=MainPID', '--value'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return '';
    const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((item) => item.startsWith('RDK_CREDITS_ADMIN_TOKEN='));
    return credentialText(entry?.slice('RDK_CREDITS_ADMIN_TOKEN='.length));
  } catch { return ''; }
}

function credentials() {
  const session = credentialText(process.env.ASSISTANT_SMOKE_SSO_SESSION);
  const token = credentialText(process.env.ASSISTANT_SMOKE_ADMIN_TOKEN || process.env.RDK_CREDITS_ADMIN_TOKEN) || (session ? '' : serviceAdminToken());
  if (!token && !session) fail('smoke_credential_unavailable');
  return { accept: 'application/json', 'x-rdk-ops-read-only': '1', 'x-rdk-ops-action': 'observability-context',
    ...(token ? { 'x-admin-token': token } : {}), ...(session ? { 'x-rdk-sso-session': session } : {}) };
}

function safeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'smoke_request_timeout';
  const code = String(error?.message || '');
  return /^[a-z][a-z0-9_]{2,100}$/.test(code) ? code : 'smoke_request_failed';
}
function httpStatus(error) { return Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : 0; }
function contentType(response) {
  const mime = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]{1,80}\/[a-z0-9!#$&^_.+-]{1,80}$/.test(mime) ? mime : '[unknown_content_type]';
}
function responseError(code, response) {
  const error = new Error(code);
  error.httpStatus = response.status;
  error.httpContentType = contentType(response);
  return error;
}
function transportRecord(caseName, error) {
  const type = typeof error?.httpContentType === 'string' && /^[a-z0-9!#$&^_.+-]{1,80}\/[a-z0-9!#$&^_.+-]{1,80}$/.test(error.httpContentType) ? error.httpContentType : '[unknown_content_type]';
  return { ...record(caseName, httpStatus(error), false, httpStatus(error) === 429 ? 'rate_limited' : 'transport_failed', 0, [safeError(error)]),
    ...(typeof error?.httpContentType === 'string' ? { contentType: type } : {}) };
}
function apiError(data) { return typeof data?.error === 'string' && /^[a-z][a-z0-9_]{2,100}$/.test(data.error) ? data.error : 'smoke_api_rejected'; }
function record(caseName, status, ok, assessment, replyLength = 0, errors = [], receipts = []) {
  return { case: caseName, status, ok, assessment, replyLength, errors: [...new Set(errors)], receipts };
}

function parsedNarratives(narrative) {
  const candidates = [...narrative.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const start = narrative.indexOf('{');
  const end = narrative.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(narrative.slice(start, end + 1));
  const arrayStart = narrative.indexOf('[');
  const arrayEnd = narrative.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(narrative.slice(arrayStart, arrayEnd + 1));
  return candidates.flatMap((candidate) => { try { return [JSON.parse(candidate)]; } catch { return []; } });
}

function learningStatus(data) {
  data = receiptBusinessData(data);
  const learning = data?.learning;
  return {
    skill: learning?.skill?.status,
    experience: learning?.observation?.experience?.status,
    evolution: learning?.observation?.evolution?.status,
  };
}

function receiptBusinessData(data) {
  // Large receipts retain their old preview and provide a separately bounded
  // structural projection. When present, this explicit field is authoritative;
  // a malformed projection must not fall back to guessing a JSON prefix.
  return data && typeof data === 'object' && Object.hasOwn(data, 'structuredData') ? data.structuredData : data;
}

function describesSourceStatus(narrative, source, status) {
  const terms = { skill: /技能|闭环|\bskill\b/i, experience: /经验|\bexperience\b/i, evolution: /进化|演化|\bevolution\b/i };
  const required = status === 'ok' ? /(?<!不)可用|正常|健康|\bok\b/i : status === 'not_configured' ? /未配置|尚未配置|没有配置|not[_ -]configured/i : /不可用|无法(?:读取|获取|访问)|读取失败|获取失败|数据源异常|unavailable/i;
  // Exact structured fallback data provides the same per-source facts.
  for (const parsed of parsedNarratives(narrative)) {
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const candidates = entries.flatMap((entry) => [entry, entry?.data, ...(Array.isArray(entry?.results) ? entry.results.map((item) => item?.data) : [])]);
    if (candidates.some((candidate) => learningStatus(candidate)[source] === status)) return true;
  }
  const clauses = narrative.split(/[。；;\n，,]+/);
  return clauses.some((clause) => {
    if (!terms[source].test(clause) || !required.test(clause)) return false;
    if (status === 'ok') return !/不可用|未配置|unavailable|not[_ -]configured/i.test(clause);
    // "所有模块健康，部分数据不可用" must not hide a failed source.
    if (/全部|所有|均|都/.test(clause) && /健康|正常|(?<!不)可用/.test(clause)) return false;
    const match = terms[source].exec(clause);
    const after = clause.slice(match.index + match[0].length);
    // Reject a positive status explicitly assigned to this source, including
    // "经验模块可用，但部分数据不可用". Grouped unavailable statements remain valid.
    if (/^[^，,和与及]{0,24}(?:健康|正常|(?<!不)可用|\bavailable\b)/i.test(after)) return false;
    return true;
  });
}

export function learningAssessment(reply, operations) {
  const receipt = operations.filter((operation) => operation?.id === id('/learning') && operation.ok === true && operation.status === 200).at(-1);
  const statuses = learningStatus(receipt?.data);
  if (Object.values(statuses).some((status) => !['ok', 'unavailable', 'not_configured'].includes(status))) return { errors: ['invalid_learning_source_status'], limitations: [] };
  const narrative = reply.split('平台实际执行记录：', 1)[0].trim();
  const errors = [];
  const limitations = [];
  for (const [source, status] of Object.entries(statuses)) {
    if (status !== 'ok') limitations.push(`learning_${source}_${status}`);
    if (!describesSourceStatus(narrative, source, status)) errors.push(`learning_${source}_${status}_not_explained`);
  }
  return { errors, limitations };
}

function isAccountParameterClarification(narrative) {
  if (!/账号|账户|用户名|SSO|identifier/i.test(narrative)) return false;
  const asks = /请(?:您|你)?(?:先)?(?:提供|输入|填写|给出|告诉|指定|补充|确认|选择|告知)|(?:需要|麻烦)(?:您|你)?(?:先)?(?:提供|输入|填写|给出|指定|补充)|哪(?:个|些|位|一个|一位)|please\s+(?:provide|enter|specify|give|supply)|which\s+(?:account|user|SSO|identifier)/i.test(narrative)
    || /(?:缺少|尚缺|未(?:提供|指定|填写|明确))[^。！？\n]{0,40}(?:账号|账户|用户名|SSO|identifier)|(?:账号|账户|用户名|SSO|identifier)[^。！？\n]{0,12}(?:尚未|未|没有)(?:提供|指定|填写)/i.test(narrative);
  // With no receipts, a clarification must not smuggle in invented account
  // activity alongside its question. Counts for a time window alone are fine.
  const assertsData = /已(?:经)?(?:查询|读取|获取|统计)|(?:查询|统计|读取)结果\s*[:：]|(?:运行|会话|登录|请求|用量)(?:次数|数量|数|量)?\s*(?:为|共|是|[:：])?\s*\d+\s*(?:次|条|个|tokens?|元|$)|\d+\s*(?:次|条|个)\s*(?:运行|会话|登录|请求)|"(?:runs?|runCount|sessions?|sessionCount|logins?|loginCount|usage|tokenCount)"\s*:\s*[\d{\[]/i.test(narrative);
  return asks && !assertsData;
}

export async function requestJson(url, headers, body, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    throw responseError('smoke_rate_limited', response);
  }
  const reader = response.body?.getReader();
  if (!reader) throw responseError('empty_smoke_response', response);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw responseError('smoke_response_too_large', response); }
      chunks.push(value);
    }
  } catch (error) {
    if (error && typeof error === 'object') { error.httpStatus = response.status; error.httpContentType = contentType(response); }
    throw error;
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw responseError('invalid_smoke_json', response); }
  return { status: response.status, contentType: contentType(response), data };
}

export function narrativeErrors(scenario, reply, operations) {
  // Operation descriptions are appended by the backend and are not an answer.
  const narrative = reply.split('平台实际执行记录：', 1)[0].trim();
  const errors = [];
  if (!scenario.topic.test(narrative) || !scenario.detail.test(narrative) || !FACT.test(narrative)) errors.push('module_narrative_content_missing');
  const matches = operations.filter((op) => scenario.expected.includes(op?.id) && op.ok === true && op.status === 200);
  const originalData = matches.at(-1)?.data;
  const data = receiptBusinessData(originalData);
  const rows = scenario.listField ? scenario.name === 'objects' ? observabilityObjectRows(data) : data?.[scenario.listField] : undefined;
  let partial = !!scenario.listField && originalData?.truncated === true && originalData !== data;
  let empty = !!scenario.listField && Array.isArray(rows) && rows.length === 0;
  if (scenario.listField && matches.length && !Array.isArray(rows)) {
    // The assistant intentionally bounds large receipts. An explicit bounded
    // envelope is a partial result, not a malformed API list or an empty list.
    const projected = rows && typeof rows === 'object' && rows.truncated === true && Array.isArray(rows.items)
      && Number.isInteger(rows.totalItems) && rows.totalItems >= 0
      && Number.isInteger(rows.includedItems) && rows.includedItems === rows.items.length && rows.includedItems <= rows.totalItems;
    const bounded = data?.truncated === true && typeof data.preview === 'string' && data.preview.length > 0;
    if (projected || bounded) { partial = true; empty = projected && rows.totalItems === 0; }
    else errors.push('invalid_module_list_payload');
  }
  if (empty && !EMPTY.test(narrative)) errors.push('empty_resource_not_explained');
  return { errors, empty, partial };
}

export async function runModuleSmoke({ origin, headers, caseNames, account = '', fetchImpl = fetch, emit = (item) => process.stdout.write(JSON.stringify(item) + '\n') }) {
  origin = validateOrigin(origin);
  // Callers cannot accidentally erase the execution-level read-only guard.
  headers = { ...headers, accept: 'application/json', 'x-rdk-ops-read-only': '1', 'x-rdk-ops-action': 'observability-context' };
  const cases = caseNames?.length ? MODULE_SCENARIOS.filter((scenario) => caseNames.includes(scenario.name)) : MODULE_SCENARIOS;
  if (!cases.length || caseNames?.some((name) => !MODULE_SCENARIOS.some((scenario) => scenario.name === name))) fail('invalid_smoke_case');
  let result;
  try { result = await requestJson(origin + API + '/capabilities', headers, undefined, fetchImpl); }
  catch (error) { emit(transportRecord('capabilities', error)); return false; }
  const errors = [];
  if (result.status !== 200) errors.push('capabilities_http_failure');
  if (result.data?.ok !== true) errors.push(apiError(result.data));
  if (result.data?.readOnlyExecutionSupported !== true) errors.push('read_only_execution_not_supported');
  if (result.data?.modelEnabled !== true) errors.push('assistant_model_not_enabled');
  const catalog = new Map();
  if (!Array.isArray(result.data?.operations) || !result.data.operations.length) errors.push('invalid_capability_catalog');
  else for (const operation of result.data.operations) {
    if (!operation || typeof operation.id !== 'string' || operation.method !== 'GET' || operation.mutating !== false || catalog.has(operation.id)
      || typeof operation.path !== 'string' || !operation.path.startsWith(ROOT + '/') || operation.id !== `${operation.method} ${operation.path}`) { errors.push('invalid_capability_catalog'); break; }
    catalog.set(operation.id, operation);
  }
  emit(record('capabilities', result.status, errors.length === 0, errors.length ? 'failed' : 'passed', 0, errors));
  if (errors.length) return false; // No chat or discovery GET before the handshake.
  let failed = false;
  let consecutiveTransportFailures = 0;
  const guardedRequest = async (url, body) => {
    try {
      const response = await requestJson(url, headers, body, fetchImpl);
      // Gateway failures are transport failures even when a proxy returns JSON.
      consecutiveTransportFailures = [502, 503, 504].includes(response.status) ? consecutiveTransportFailures + 1 : 0;
      return response;
    } catch (error) { consecutiveTransportFailures++; throw error; }
  };
  const failFast = () => {
    if (consecutiveTransportFailures < 2) return false;
    emit(record('runner', 0, false, 'stopped', 0, ['consecutive_transport_failures_limit_reached']));
    return true;
  };
  const discoveryCache = new Map();
  for (const scenario of cases) {
    if (scenario.writeOnly) { emit(record(scenario.name, 0, null, 'requires_write', 0, ['no_read_only_capability'])); continue; }
    if (scenario.expected.some((operationId) => !catalog.has(operationId))) {
      emit(record(scenario.name, 0, false, 'failed', 0, ['required_read_capability_missing'])); failed = true; continue;
    }
    if (scenario.requiresIdentity && !headers['x-rdk-sso-session']) {
      // A web-cloud admin token provides legacy access but no account subject.
      // Verify the existing identity gate without treating a token as SSO proof.
      const discoveryPath = '/actions?limit=5';
      let identityRead = discoveryCache.get(discoveryPath);
      if (!identityRead) {
        try { identityRead = await guardedRequest(origin + ROOT + discoveryPath); }
        catch (error) { emit(transportRecord(scenario.name, error)); failed = true; if (failFast()) break; continue; }
        discoveryCache.set(discoveryPath, identityRead);
      }
      const receipt = [{ operationId: id('/actions'), status: identityRead.status, ok: identityRead.status === 200 && identityRead.data?.ok === true }];
      if (identityRead.status === 403 && identityRead.data?.error === 'not_authorized') {
        emit(record(scenario.name, 403, null, 'requires_identity', 0, ['sso_identity_required', 'identity_denial_verified'], receipt));
      } else if (identityRead.status === 200 && identityRead.data?.ok === true) {
        // Local self-host may permit a local operator; it is still not the
        // authenticated SSO acceptance required for the public action module.
        emit(record(scenario.name, 200, null, 'requires_identity', 0, ['sso_identity_not_provided'], receipt));
      } else {
        emit(record(scenario.name, identityRead.status, false, 'unavailable', 0, [apiError(identityRead.data)], receipt)); failed = true;
      }
      if (failFast()) break;
      continue;
    }
    let message = scenario.message;
    if (scenario.account && account) message += ` 被查询账号 identifier=${JSON.stringify(account)}，仅查询该指定账号。`;
    if (scenario.discovery) {
      const discoveryId = id(scenario.discovery.split('?')[0]);
      if (!catalog.has(discoveryId)) { emit(record(scenario.name, 0, false, 'failed', 0, ['discovery_read_capability_missing'])); failed = true; continue; }
      let discovery = discoveryCache.get(scenario.discovery);
      if (!discovery) {
        try { discovery = await guardedRequest(origin + ROOT + scenario.discovery); }
        catch (error) { emit(transportRecord(scenario.name, error)); failed = true; if (failFast()) break; continue; }
        discoveryCache.set(scenario.discovery, discovery);
      }
      const receipt = [{ operationId: discoveryId, status: discovery.status, ok: discovery.status === 200 && discovery.data?.ok === true }];
      if (discovery.status !== 200 || discovery.data?.ok !== true) {
        emit(record(scenario.name, discovery.status, false, 'unavailable', 0, [apiError(discovery.data)], receipt)); failed = true; if (failFast()) break; continue;
      }
      const rows = scenario.rowsFor(discovery.data);
      if (!Array.isArray(rows)) { emit(record(scenario.name, 200, false, 'failed', 0, ['invalid_discovery_payload'], receipt)); failed = true; continue; }
      const row = scenario.discover(discovery.data);
      if (!row) {
        const empty = rows.length === 0;
        emit(record(scenario.name, 200, empty ? null : false, empty ? 'no_resource' : 'failed', 0, [empty ? 'existing_resource_detail_not_tested' : 'invalid_discovered_resource_id'], receipt));
        if (!empty) failed = true;
        continue;
      }
      message = scenario.messageFor(row);
    }
    let chat;
    try { chat = await guardedRequest(origin + API + '/chat', { message: message + READ_ONLY, history: [], context: { view: 'overview' } }); }
    catch (error) { emit(transportRecord(scenario.name, error)); failed = true; if (failFast()) break; continue; }
    const failures = [];
    if (chat.status !== 200) failures.push('chat_http_failure');
    if (chat.data?.ok !== true) failures.push(apiError(chat.data));
    const reply = typeof chat.data?.reply === 'string' ? chat.data.reply : '';
    if (!reply.trim()) failures.push('empty_assistant_reply');
    failures.push(...(reply.match(/\bplatform_assistant_[a-z0-9_]+\b/g) || []));
    const operations = Array.isArray(chat.data?.operations) ? chat.data.operations : [];
    const receipts = [];
    for (const operation of operations) {
      const known = catalog.get(operation?.id);
      if (!known) failures.push('unknown_operation_receipt');
      if (!known || known.method !== 'GET' || known.mutating !== false) failures.push('operation_not_read_only');
      if (/\/(?:export|bundle)(?:\/|$)/.test(known?.path || '') || operation.data?.downloadUrl) failures.push('download_operation_not_permitted');
      if (operation?.ok !== true || operation?.status !== 200) failures.push('operation_receipt_failed');
      receipts.push({ operationId: known?.id || '[unknown_operation]', status: Number.isInteger(operation?.status) ? operation.status : 0, ok: operation?.ok === true });
    }
    if (scenario.account && !account) {
      const narrative = reply.split('平台实际执行记录：', 1)[0];
      if (operations.length) failures.push('account_parameter_not_provided_but_operation_attempted');
      if (!isAccountParameterClarification(narrative)) failures.push('account_parameter_clarification_missing');
      const ok = failures.length === 0;
      emit(record(scenario.name, chat.status, ok, ok ? 'needs_parameter' : 'failed', reply.length, failures, receipts));
      if (!ok) failed = true;
      if (failFast()) break;
      continue;
    }
    if (!operations.length) failures.push('no_real_operation_receipt');
    if (!operations.some((operation) => scenario.expected.includes(operation?.id) && operation.ok === true && operation.status === 200)) failures.push('expected_read_operation_missing');
    const content = narrativeErrors(scenario, reply, operations);
    failures.push(...content.errors);
    const learning = scenario.name === 'learning' ? learningAssessment(reply, operations) : { errors: [], limitations: [] };
    failures.push(...learning.errors);
    const ok = failures.length === 0;
    emit(record(scenario.name, chat.status, ok && learning.limitations.length ? null : ok,
      ok ? (learning.limitations.length ? 'data_source_unavailable' : content.partial ? 'partial_verified' : content.empty ? 'empty_verified' : 'passed') : 'failed',
      reply.length, ok ? [...learning.limitations, ...(content.partial ? ['bounded_receipt_partial'] : [])] : failures, receipts));
    if (!ok) failed = true;
    if (failFast()) break;
  }
  return !failed;
}

async function main() {
  let origin = process.env.ASSISTANT_SMOKE_ORIGIN || 'http://127.0.0.1:18093';
  let caseNames;
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--public') origin = process.env.ASSISTANT_SMOKE_ORIGIN || PUBLIC_ORIGIN;
    else if (argument === '--origin') origin = process.argv[++index] || '';
    else if (argument === '--case') { caseNames = (process.argv[++index] || '').split(',').filter(Boolean); if (!caseNames.length) fail('invalid_smoke_case'); }
    else if (argument === '--list') { for (const scenario of MODULE_SCENARIOS) process.stdout.write(JSON.stringify({ case: scenario.name, group: scenario.group, mode: scenario.writeOnly ? 'requires_write' : scenario.discovery ? 'existing_resource' : scenario.account ? 'account_parameter' : 'query', expected: scenario.expected }) + '\n'); return; }
    else if (argument === '--help' || argument === '-h') { process.stdout.write('Usage: node tools/platform-assistant-module-smoke.mjs [--public | --origin URL] [--case name1,name2] [--list]\nCredentials: ASSISTANT_SMOKE_ADMIN_TOKEN / RDK_CREDITS_ADMIN_TOKEN / ASSISTANT_SMOKE_SSO_SESSION; Linux may read d-obs.service MainPID env. Optional: ASSISTANT_SMOKE_ACCOUNT.\n'); return; }
    else fail('invalid_smoke_argument');
  }
  const account = credentialText(process.env.ASSISTANT_SMOKE_ACCOUNT);
  if (account.length > 200) fail('invalid_smoke_account');
  if (!(await runModuleSmoke({ origin, headers: credentials(), caseNames, account }))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stdout.write(JSON.stringify(transportRecord('runner', error)) + '\n');
  process.exitCode = 1;
});
