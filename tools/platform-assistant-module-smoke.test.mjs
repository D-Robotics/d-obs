import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_SCENARIOS, runModuleSmoke, validateOrigin, requestJson, learningAssessment } from './platform-assistant-module-smoke.mjs';

const ROOT = '/api/ops/observability';
const OP = (path) => ({ id: 'GET ' + ROOT + path, method: 'GET', path: ROOT + path, mutating: false });
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function fixture({ operations = [OP('/boards')], readOnly = true, reply = '当前有 1 个自定义看板，包含 2 个指标面板。', receipts = [{ id: OP('/boards').id, status: 200, ok: true, data: { boards: [{ name: 'fixture' }] } }], discovery = { ok: true, devices: [] }, discoveryStatus = 200, chatStatus = 200 } = {}) {
  const calls = [];
  const output = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, ...request });
    if (url.endsWith('/assistant/capabilities')) return json({ ok: true, modelEnabled: true, readOnlyExecutionSupported: readOnly, operations });
    if (url.endsWith('/assistant/chat')) return json({ ok: true, reply, operations: receipts }, chatStatus);
    return json(discovery, discoveryStatus);
  };
  return { calls, output, run: (caseNames = ['boards'], account = '', extraHeaders = {}) => runModuleSmoke({ origin: 'http://127.0.0.1:18093', headers: { 'x-admin-token': 'secret-only-for-fixture', ...extraHeaders }, caseNames, account, fetchImpl, emit: (item) => output.push(item) }) };
}

test('all 25 published groups appear; unavailable resources are explicit modes', () => {
  assert.equal(new Set(MODULE_SCENARIOS.map((item) => item.group)).size, 25);
  assert.equal(MODULE_SCENARIOS.filter((item) => item.discovery).length, 10);
  assert.equal(MODULE_SCENARIOS.filter((item) => item.writeOnly).length, 1);
});

test('server handshake is required before any chat or discovery request', async () => {
  const old = fixture({ readOnly: false });
  assert.equal(await old.run(), false);
  assert.equal(old.calls.length, 1);
  assert.deepEqual(old.output[0].errors, ['read_only_execution_not_supported']);
  const writable = fixture({ operations: [{ ...OP('/boards'), method: 'POST', id: 'POST ' + ROOT + '/boards', mutating: true }] });
  assert.equal(await writable.run(), false);
  assert.equal(writable.calls.length, 1);
  assert.ok(writable.output[0].errors.includes('invalid_capability_catalog'));
});

test('successful narrative and GET receipt pass with guards and no secret output', async () => {
  const mock = fixture();
  assert.equal(await mock.run(), true);
  assert.equal(mock.output.at(-1).assessment, 'passed');
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.equal(call.headers['x-rdk-ops-read-only'], '1');
    assert.equal(call.redirect, 'error');
  }
  assert.equal(mock.calls[1].method, 'POST');
  assert.equal(mock.calls[1].headers['x-rdk-ops-action'], 'observability');
  assert.match(JSON.parse(mock.calls[1].body).message, /仅查询真实现状/);
  assert.equal(JSON.stringify(mock.output).includes('secret-only-for-fixture'), false);
  assert.equal(JSON.stringify(mock.output).includes('fixture'), false);
  assert.equal(JSON.stringify(mock.output).includes('当前有'), false);
});

test('receipt-only module description cannot pass substantive narrative acceptance', async () => {
  const mock = fixture({ reply: '已完成。\n平台实际执行记录：\n成功读取自定义看板名称和指标面板。' });
  assert.equal(await mock.run(), false);
  assert.ok(mock.output.at(-1).errors.includes('module_narrative_content_missing'));
});

test('empty actual list must be explained; a generic nonempty claim fails', async () => {
  const receipts = [{ id: OP('/boards').id, status: 200, ok: true, data: { boards: [] } }];
  const valid = fixture({ receipts, reply: '当前没有自定义看板，面板列表为空。' });
  assert.equal(await valid.run(), true);
  assert.equal(valid.output.at(-1).assessment, 'empty_verified');
  const wrong = fixture({ receipts, reply: '自定义看板状态正常，包含面板。' });
  assert.equal(await wrong.run(), false);
  assert.ok(wrong.output.at(-1).errors.includes('empty_resource_not_explained'));
});

test('large Prometheus receipts with an explicit bound remain partial, never false schema failures', async () => {
  const original = { ok: true, promql: 'up', series: Array.from({ length: 13 }, () => ({ name: 'private-not-output', points: Array.from({ length: 41 }, () => ({ ts: 1, value: 1 })) })) };
  const mock = fixture({ operations: [OP('/prom/query')], reply: 'Prometheus up 查询返回 13 个时间序列，样本状态正常；操作回执已截断显示。',
    receipts: [{ id: OP('/prom/query').id, status: 200, ok: true, data: { truncated: true, preview: JSON.stringify(original).slice(0, 5900) } }] });
  assert.equal(await mock.run(['prometheus']), true);
  assert.equal(mock.output.at(-1).assessment, 'partial_verified');
  assert.deepEqual(mock.output.at(-1).errors, ['bounded_receipt_partial']);
  assert.equal(JSON.stringify(mock.output).includes('private-not-output'), false);
  const receiptOnly = fixture({ operations: [OP('/prom/query')], reply: '已完成。\n平台实际执行记录：Prometheus up 查询返回时间序列。',
    receipts: [{ id: OP('/prom/query').id, status: 200, ok: true, data: { truncated: true, preview: JSON.stringify(original).slice(0, 5900) } }] });
  assert.equal(await receiptOnly.run(['prometheus']), false);
  assert.ok(receiptOnly.output.at(-1).errors.includes('module_narrative_content_missing'));
});

test('projected list samples preserve original counts and malformed lists still fail', async () => {
  const projected = fixture({ operations: [OP('/prom/query')], reply: 'Prometheus up 的时间序列查询返回 13 个序列，当前展示部分样本。',
    receipts: [{ id: OP('/prom/query').id, status: 200, ok: true, data: { series: { items: [], totalItems: 13, includedItems: 0, truncated: true } } }] });
  assert.equal(await projected.run(['prometheus']), true);
  assert.equal(projected.output.at(-1).assessment, 'partial_verified');
  for (const data of [{ ok: true }, { truncated: true, preview: '' }, { truncated: false, preview: 'not-an-envelope' }, { series: { items: [], totalItems: '13', includedItems: 0, truncated: true } }]) {
    const invalid = fixture({ operations: [OP('/prom/query')], reply: 'Prometheus up 的时间序列查询返回 13 个序列，展示实际样本。', receipts: [{ id: OP('/prom/query').id, status: 200, ok: true, data }] });
    assert.equal(await invalid.run(['prometheus']), false);
    assert.ok(invalid.output.at(-1).errors.includes('invalid_module_list_payload'));
  }
});

test('write and download receipts fail even with a plausible answer', async () => {
  const writable = fixture({ receipts: [{ id: 'POST ' + ROOT + '/boards', status: 201, ok: true }] });
  assert.equal(await writable.run(), false);
  assert.ok(writable.output.at(-1).errors.includes('operation_not_read_only'));
  const download = fixture({ receipts: [{ id: OP('/boards').id, status: 200, ok: true, data: { downloadUrl: '/protected' } }] });
  assert.equal(await download.run(), false);
  assert.ok(download.output.at(-1).errors.includes('download_operation_not_permitted'));
});

test('empty discovery does not invent or request a detail ID', async () => {
  const mock = fixture({ operations: [OP('/devices'), OP('/devices/:deviceId/samples')] });
  assert.equal(await mock.run(['device_samples']), true);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].method, 'GET');
  assert.equal(mock.calls[1].headers['x-rdk-ops-action'], 'observability-context');
  assert.equal(mock.output.at(-1).ok, null);
  assert.equal(mock.output.at(-1).assessment, 'no_resource');
});

test('discovery payload mismatch and unsafe discovered ID fail, never count as empty', async () => {
  for (const discovery of [{ ok: true }, { ok: true, devices: [{ deviceId: '../../unsafe' }] }]) {
    const mock = fixture({ operations: [OP('/devices'), OP('/devices/:deviceId/samples')], discovery });
    assert.equal(await mock.run(['device_samples']), false);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.output.at(-1).assessment, 'failed');
  }
});

test('valid discovered resource is used internally but never printed', async () => {
  const actualId = 'real-device-private';
  const mock = fixture({ operations: [OP('/devices'), OP('/devices/:deviceId/samples')], discovery: { ok: true, devices: [{ deviceId: actualId }] },
    reply: '设备最近一小时没有心跳样本，窗口内样本列表为空。', receipts: [{ id: OP('/devices/:deviceId/samples').id, status: 200, ok: true, data: { samples: [], window: { fromMs: 1, toMs: 2 } } }] });
  assert.equal(await mock.run(['device_samples']), true);
  assert.equal(mock.calls.length, 3);
  assert.match(JSON.parse(mock.calls[2].body).message, new RegExp(actualId));
  assert.equal(JSON.stringify(mock.output).includes(actualId), false);
});

test('object detail prioritizes a safe slash namespace while other resource IDs remain strict', async () => {
  const privateId = 'device/rdk-s100-0003';
  const mock = fixture({ operations: [OP('/objects'), OP('/objects/:objectId')], discovery: { ok: true, objects: [{ objectId: 'plain-id' }, { objectId: privateId }] },
    reply: '对象画像显示最近运行状态健康，汇总包含 3 次运行。', receipts: [{ id: OP('/objects/:objectId').id, status: 200, ok: true, data: { detail: { summary: { runs: 3 } } } }] });
  assert.equal(await mock.run(['object_detail']), true);
  assert.match(JSON.parse(mock.calls[2].body).message, /device\/rdk-s100-0003/);
  assert.doesNotMatch(JSON.parse(mock.calls[2].body).message, /plain-id/);
  assert.equal(JSON.stringify(mock.output).includes(privateId), false);
  const device = fixture({ operations: [OP('/devices'), OP('/devices/:deviceId/samples')], discovery: { ok: true, devices: [{ deviceId: privateId }] } });
  assert.equal(await device.run(['device_samples']), false);
  assert.equal(device.calls.length, 2);
});

test('objects accepts the explicit catalog snapshot wrapper and validates real empty lists', async () => {
  const snapshot = { generatedAt: 100, total: 1, limit: 200, objects: [{ objectId: 'device/real-object-private', objectType: 'device' }] };
  const mock = fixture({ operations: [OP('/objects')], reply: '对象资产目录有 1 个设备对象，类型为 device。', receipts: [{ id: OP('/objects').id, status: 200, ok: true, data: { ok: true, objects: snapshot } }] });
  assert.equal(await mock.run(['objects']), true);
  assert.equal(mock.output.at(-1).assessment, 'passed');
  const empty = fixture({ operations: [OP('/objects')], reply: '当前没有观测对象，资产目录对象列表为空。', receipts: [{ id: OP('/objects').id, status: 200, ok: true, data: { ok: true, objects: { ...snapshot, total: 0, objects: [] } } }] });
  assert.equal(await empty.run(['objects']), true);
  assert.equal(empty.output.at(-1).assessment, 'empty_verified');
});

test('aggregate object intent requires the combined catalog; registry-only reads do not prove coverage', async () => {
  const aggregate = MODULE_SCENARIOS.find((scenario) => scenario.name === 'objects');
  const registry = MODULE_SCENARIOS.find((scenario) => scenario.name === 'object_registry');
  assert.ok(aggregate); assert.ok(registry);
  assert.match(aggregate.message, /合并运行目录与接入对象注册表/);
  assert.match(aggregate.message, /总数.*返回上限.*对象类型/);
  assert.equal(registry.message, '接入对象注册表目前有哪些来源、标签和信号类型？请读取真实注册信息。');
  const wrongSource = fixture({ operations: [OP('/objects'), OP('/object-registry')], reply: '对象资产注册表中有 3 个对象，包含服务和设备类型。',
    receipts: [{ id: OP('/object-registry').id, status: 200, ok: true, data: { objects: [{ objectId: 'private-fixture' }] } }] });
  assert.equal(await wrongSource.run(['objects']), false);
  assert.ok(wrongSource.output.at(-1).errors.includes('expected_read_operation_missing'));
  assert.match(JSON.parse(wrongSource.calls.at(-1).body).message, /聚合资产目录/);
  assert.equal(JSON.stringify(wrongSource.output).includes('private-fixture'), false);
});

test('object detail discovers IDs only at objects.objects or the explicit older flat path', async () => {
  const privateId = 'device/rdk-s100-0003';
  const mock = fixture({ operations: [OP('/objects'), OP('/objects/:objectId')], discovery: { ok: true, objects: { generatedAt: 100, total: 2, limit: 200, objects: [{ objectId: 'plain-object' }, { objectId: privateId }] } },
    reply: '对象画像包含最近运行，汇总状态健康。', receipts: [{ id: OP('/objects/:objectId').id, status: 200, ok: true, data: { detail: { summary: {} } } }] });
  assert.equal(await mock.run(['object_detail']), true);
  assert.match(JSON.parse(mock.calls[2].body).message, /device\/rdk-s100-0003/);
  assert.equal(JSON.stringify(mock.output).includes(privateId), false);
  const empty = fixture({ operations: [OP('/objects'), OP('/objects/:objectId')], discovery: { ok: true, objects: { generatedAt: 100, total: 0, limit: 200, objects: [] } } });
  assert.equal(await empty.run(['object_detail']), true);
  assert.equal(empty.output.at(-1).assessment, 'no_resource');
  assert.equal(empty.calls.length, 2);
});

test('object wrapper support never searches unrelated unknown shapes', async () => {
  for (const discovery of [{ ok: true, catalog: { objects: [] } }, { ok: true, objects: { items: [] } }, { ok: true, objects: { objects: 'wrong-type' } }]) {
    const mock = fixture({ operations: [OP('/objects'), OP('/objects/:objectId')], discovery });
    assert.equal(await mock.run(['object_detail']), false);
    assert.ok(mock.output.at(-1).errors.includes('invalid_discovery_payload'));
    assert.equal(mock.calls.length, 2);
  }
});

test('slash object namespaces still reject traversal, empty segments and route selectors', async () => {
  for (const objectId of ['device/../etc', './device/x', '/device/x', 'device//x', 'device/x/', 'device\\x', 'device/x?route=other', 'device/%2e%2e/x', 'device/%2fx', 'device/\nx']) {
    const mock = fixture({ operations: [OP('/objects'), OP('/objects/:objectId')], discovery: { ok: true, objects: [{ objectId }] } });
    assert.equal(await mock.run(['object_detail']), false, objectId);
    assert.equal(mock.calls.length, 2);
    assert.ok(mock.output.at(-1).errors.includes('invalid_discovered_resource_id'));
  }
});

const learningData = (skill = 'ok', experience = 'unavailable', evolution = 'not_configured') => ({ ok: true, learning: { skill: { status: skill }, observation: { experience: { status: experience }, evolution: { status: evolution } } } });
const learningReceipt = (data = learningData()) => [{ id: OP('/learning').id, status: 200, ok: true, data }];

test('learning source availability is separate from assistant connection success', async () => {
  const mock = fixture({ operations: [OP('/learning')], receipts: learningReceipt(), reply: '技能数据闭环可用，经验模块数据不可用，进化模块未配置。' });
  assert.equal(await mock.run(['learning']), true);
  assert.equal(mock.output.at(-1).ok, null);
  assert.equal(mock.output.at(-1).assessment, 'data_source_unavailable');
  assert.deepEqual(mock.output.at(-1).errors, ['learning_experience_unavailable', 'learning_evolution_not_configured']);
  const all = fixture({ operations: [OP('/learning')], receipts: learningReceipt(learningData('ok', 'ok', 'ok')), reply: '技能、经验、进化这三个模块全部可用，状态正常。' });
  assert.equal(await all.run(['learning']), true);
  assert.equal(all.output.at(-1).assessment, 'passed');
});

test('learning outer HTTP 200 cannot hide failed sources or missing source statuses', async () => {
  for (const reply of ['技能、经验和进化全部健康可用。', '技能可用，经验模块可用，但部分数据不可用。进化未配置。', '技能可用，部分数据源不可用，进化未配置。']) {
    const mock = fixture({ operations: [OP('/learning')], receipts: learningReceipt(), reply });
    assert.equal(await mock.run(['learning']), false, reply);
    assert.equal(mock.output.at(-1).assessment, 'failed');
    assert.ok(mock.output.at(-1).errors.includes('learning_experience_unavailable_not_explained'));
  }
  assert.deepEqual(learningAssessment('技能、经验、进化全部正常。', learningReceipt({ ok: true, learning: { skill: { status: 'ok' } } })).errors, ['invalid_learning_source_status']);
});

test('learning raw JSON fallback preserves individual availability without narrative guesswork', async () => {
  const data = learningData();
  const reply = '真实数据如下：\n' + JSON.stringify([{ id: OP('/boards').id, data: { boards: [] } }, { id: OP('/learning').id, data }], null, 2);
  assert.deepEqual(learningAssessment(reply, learningReceipt(data)), { errors: [], limitations: ['learning_experience_unavailable', 'learning_evolution_not_configured'] });
  const falselyHealthy = JSON.stringify({ learning: { skill: { status: 'ok' }, observation: { experience: { status: 'ok' }, evolution: { status: 'ok' } } } });
  assert.equal(learningAssessment(falselyHealthy, learningReceipt(data)).errors.length, 2);
});

test('large learning receipts validate all three tail statuses through explicit structuredData', async () => {
  const data = { truncated: true, preview: '{"ok":true,"learning":{"skill":{"overview":"' + 'x'.repeat(5900), structuredData: learningData('ok', 'ok', 'ok') };
  const mock = fixture({ operations: [OP('/learning')], receipts: learningReceipt(data), reply: '技能、经验、进化三个模块当前状态全部正常可用。' });
  assert.equal(await mock.run(['learning']), true);
  assert.equal(mock.output.at(-1).assessment, 'passed');
  const unavailable = fixture({ operations: [OP('/learning')], receipts: learningReceipt({ ...data, structuredData: learningData() }), reply: '技能可用，经验模块不可用，进化模块未配置。' });
  assert.equal(await unavailable.run(['learning']), true);
  assert.equal(unavailable.output.at(-1).assessment, 'data_source_unavailable');
  const prefixOnly = fixture({ operations: [OP('/learning')], receipts: learningReceipt({ truncated: true, preview: JSON.stringify(learningData('ok', 'ok', 'ok')) }), reply: '技能、经验、进化三个模块全部健康可用。' });
  assert.equal(await prefixOnly.run(['learning']), false);
  assert.ok(prefixOnly.output.at(-1).errors.includes('invalid_learning_source_status'));
});

test('bad structuredData is authoritative and never replaced with other apparent healthy fields', async () => {
  for (const structuredData of [null, 'not-an-object', {}, { learning: { skill: { status: 'ok' } } }, learningData('ok', 'healthy', 'ok')]) {
    const mock = fixture({ operations: [OP('/learning')], receipts: learningReceipt({ ...learningData('ok', 'ok', 'ok'), truncated: true, preview: 'healthy-looking-prefix', structuredData }), reply: '技能、经验、进化模块状态正常可用。' });
    assert.equal(await mock.run(['learning']), false);
    assert.ok(mock.output.at(-1).errors.includes('invalid_learning_source_status'));
  }
});

test('large list receipts inspect explicit structuredData and preserve truncation limits', async () => {
  const valid = fixture({ operations: [OP('/prom/query')], reply: 'Prometheus up 返回 13 个序列，展示了部分时间序列样本。', receipts: [{ id: OP('/prom/query').id, status: 200, ok: true,
    data: { truncated: true, preview: 'old-prefix', structuredData: { ok: true, series: { items: [{ points: [] }], totalItems: 13, includedItems: 1, truncated: true } } } }] });
  assert.equal(await valid.run(['prometheus']), true);
  assert.equal(valid.output.at(-1).assessment, 'partial_verified');
  for (const structuredData of [null, 'not-an-object', {}, { series: 'wrong-type' }]) {
    const invalid = fixture({ operations: [OP('/prom/query')], reply: 'Prometheus up 返回 13 个序列，样本状态正常。', receipts: [{ id: OP('/prom/query').id, status: 200, ok: true,
      data: { truncated: true, preview: 'old-prefix', series: [], structuredData } }] });
    assert.equal(await invalid.run(['prometheus']), false);
    assert.ok(invalid.output.at(-1).errors.includes('invalid_module_list_payload'));
  }
});

test('token-only action access verifies denial and never claims an SSO action read', async () => {
  const mock = fixture({ operations: [OP('/actions'), OP('/actions/:id')], discovery: { ok: false, error: 'not_authorized' }, discoveryStatus: 403 });
  assert.equal(await mock.run(['actions', 'action_detail']), true);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1].method, 'GET');
  assert.equal(mock.output.at(-1).assessment, 'requires_identity');
  assert.equal(mock.output.at(-1).ok, null);
  assert.deepEqual(mock.output.at(-1).errors, ['sso_identity_required', 'identity_denial_verified']);
  const local = fixture({ operations: [OP('/actions')], discovery: { ok: true, actions: [] } });
  assert.equal(await local.run(['actions']), true);
  assert.equal(local.output.at(-1).assessment, 'requires_identity');
  assert.equal(local.calls.length, 2);
});

test('an explicitly provided SSO session can exercise real account action read', async () => {
  const mock = fixture({ operations: [OP('/actions')], reply: '当前账户没有行动提案，审批和验证状态列表为空。', receipts: [{ id: OP('/actions').id, status: 200, ok: true, data: { actions: [] } }] });
  assert.equal(await mock.run(['actions'], '', { 'x-rdk-sso-session': 'fixture-session-private' }), true);
  assert.equal(mock.calls[1].method, 'POST');
  assert.equal(mock.output.at(-1).assessment, 'empty_verified');
  assert.equal(JSON.stringify(mock.output).includes('fixture-session-private'), false);
});

test('missing account identifier is a clarification, never an account query pass', async () => {
  const mock = fixture({ operations: [OP('/account-activity')], reply: '请提供需要查询的 SSO 账号或用户名。', receipts: [] });
  assert.equal(await mock.run(['account_activity']), true);
  assert.equal(mock.output.at(-1).assessment, 'needs_parameter');
  const attempted = fixture({ operations: [OP('/account-activity')], reply: '请提供需要查询的 SSO 账号或用户名。', receipts: [{ id: OP('/account-activity').id, status: 400, ok: false }] });
  assert.equal(await attempted.run(['account_activity']), false);
  assert.ok(attempted.output.at(-1).errors.includes('account_parameter_not_provided_but_operation_attempted'));
});

test('natural account parameter questions accept input, give, fill and which-one phrasing', async () => {
  for (const reply of ['你要查询哪一个账号？', '请输入SSO ID或用户名。', '请给出要查询的账户标识。', '请填写被查询账号的 identifier。', '需要你先提供用户名，才能读取实际数据。', '未指定账号，请补充 SSO ID。']) {
    const mock = fixture({ operations: [OP('/account-activity')], reply, receipts: [] });
    assert.equal(await mock.run(['account_activity']), true, reply);
    assert.equal(mock.output.at(-1).assessment, 'needs_parameter');
    assert.equal(mock.output.at(-1).receipts.length, 0);
  }
});

test('account module descriptions and fabricated results cannot pass as parameter clarification', async () => {
  for (const reply of ['账号行为模块提供运行、会话、用量和登录审计能力。', 'SSO ID 或用户名用于账号行为查询。', '账号行为模块缺少接入数据，需要配置数据源。', '请输入SSO ID或用户名。该账号最近有12次运行和3次登录。', '请提供账号。已读取该账号的运行数据。', '你要查询哪一个账号？统计结果：{"runCount":42}']) {
    const mock = fixture({ operations: [OP('/account-activity')], reply, receipts: [] });
    assert.equal(await mock.run(['account_activity']), false, reply);
    assert.ok(mock.output.at(-1).errors.includes('account_parameter_clarification_missing'));
  }
});

test('write-only selftest is reported as a limitation without a chat', async () => {
  const mock = fixture();
  assert.equal(await mock.run(['ingest_selftest']), true);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.output.at(-1).assessment, 'requires_write');
  assert.equal(mock.output.at(-1).ok, null);
});

test('origin policy rejects credentials, redirects through URL selectors, and external HTTP', () => {
  for (const unsafe of ['http://example.org', 'https://user:pass@example.org', 'https://example.org/?token=x', 'https://example.org/#x', 'https://example.org/%2felse', 'https://example.org\\else']) assert.throws(() => validateOrigin(unsafe));
  assert.equal(validateOrigin('https://example.org/dobs/'), 'https://example.org/dobs');
  assert.equal(validateOrigin('http://127.0.0.2:18093'), 'http://127.0.0.2:18093');
});

test('bounded response parser rejects non-JSON and oversized data with sanitized codes', async () => {
  await assert.rejects(requestJson('http://127.0.0.1', {}, undefined, async () => new Response('not-json')), /invalid_smoke_json/);
  await assert.rejects(requestJson('http://127.0.0.1', {}, undefined, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /smoke_response_too_large/);
});

test('non-JSON errors retain actual HTTP status and only the MIME type', async () => {
  await assert.rejects(requestJson('http://127.0.0.1', {}, undefined, async () => new Response('<html>private-upstream-detail</html>', { status: 502, headers: { 'content-type': 'text/html; charset=utf-8; private=value' } })), (error) => {
    assert.equal(error.message, 'invalid_smoke_json');
    assert.equal(error.httpStatus, 502);
    assert.equal(error.httpContentType, 'text/html');
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
});

async function transportFixture(statuses, { failCapability = false } = {}) {
  const output = [];
  const calls = [];
  const operations = [OP('/access'), OP('/search'), OP('/config'), OP('/boards')];
  let chatIndex = 0;
  const result = await runModuleSmoke({ origin: 'http://127.0.0.1:18093', headers: { 'x-admin-token': 'secret-fixture' },
    caseNames: ['access', 'search', 'config', 'boards'], emit: (item) => output.push(item), fetchImpl: async (url, request) => {
      calls.push({ url, method: request.method });
      if (url.endsWith('/capabilities') && !failCapability) return json({ ok: true, modelEnabled: true, readOnlyExecutionSupported: true, operations });
      const status = statuses[Math.min(chatIndex++, statuses.length - 1)];
      if (status === 200) return json({ ok: true, reply: '当前搜索对象结果数量为 1，名称已读取。', operations: [{ id: OP('/search').id, status: 200, ok: true, data: { results: [{ id: 'not-output' }] } }] });
      if (status === -1) throw new TypeError('fetch failed: private-network-detail');
      return new Response('<html>private-upstream-detail</html>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    } });
  return { result, calls, output };
}

test('two consecutive proxy/non-JSON failures stop before remaining scenarios', async () => {
  const mock = await transportFixture([502, 502]);
  assert.equal(mock.result, false);
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.output.slice(1, 3).map((item) => [item.status, item.contentType, item.assessment]), [[502, 'text/html', 'transport_failed'], [502, 'text/html', 'transport_failed']]);
  assert.equal(mock.output.at(-1).assessment, 'stopped');
  assert.equal(JSON.stringify(mock.output).includes('private-upstream-detail'), false);
});

test('429 is rate_limited with actual status and stops after two, without retries', async () => {
  const mock = await transportFixture([429, 429]);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.result, false);
  assert.deepEqual(mock.output.slice(1, 3).map((item) => [item.status, item.assessment, item.errors]), [[429, 'rate_limited', ['smoke_rate_limited']], [429, 'rate_limited', ['smoke_rate_limited']]]);
  assert.equal(mock.output.at(-1).assessment, 'stopped');
});

test('a successful transport resets the consecutive failure budget', async () => {
  const mock = await transportFixture([502, 200, 502, 502]);
  assert.equal(mock.calls.length, 5);
  assert.equal(mock.output[2].case, 'search');
  assert.equal(mock.output[2].ok, true);
  assert.equal(mock.output.at(-1).assessment, 'stopped');
});

test('network failures stop after two and never expose exception text', async () => {
  const mock = await transportFixture([-1, -1]);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.output[1].status, 0);
  assert.equal(mock.output.at(-1).assessment, 'stopped');
  assert.equal(JSON.stringify(mock.output).includes('private-network-detail'), false);
});

test('failed capability transport reports status and sends zero chat requests', async () => {
  const mock = await transportFixture([429], { failCapability: true });
  assert.equal(mock.result, false);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.output[0].case, 'capabilities');
  assert.equal(mock.output[0].status, 429);
  assert.equal(mock.output[0].assessment, 'rate_limited');
});
