/** Runs shipped alert drawers against a safe DOM and deferred evidence API. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT, OPS_OBSERVABILITY_ALERT_EVIDENCE_STYLE } from './observability-page-alert-evidence.js';

class Node {
  children: Node[] = []; parentNode: Node | null = null; textContent = ''; id = ''; type = ''; className = '';
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => unknown>> = {};
  get firstElementChild() { return this.children[0] ?? null; }
  get isConnected(): boolean { return this.tagName === 'BODY' || !!this.parentNode?.isConnected; }
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (name: string) => { this.className += ' ' + name; },
    remove: (name: string) => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
  };
  constructor(readonly tagName: string) {}
  appendChild(child: Node) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children: Node[]) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; children.forEach(child => this.appendChild(child)); }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  addEventListener(name: string, fn: () => unknown) { (this.listeners[name] ||= []).push(fn); }
  set innerHTML(_value: string) { throw new Error('Alert evidence must use safe DOM'); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const text = (node: Node): string => all(node).map(item => item.textContent).join(' ');
const button = (node: Node, label: string) => all(node).find(item => item.tagName === 'BUTTON' && item.textContent === label)!;
const at = '2026-10-15T09:43:57.000Z';
const evidence = (marker = 'account-a') => ({
  applicability: 'business', windowStart: '2026-10-15T09:33:57.000Z', windowEnd: at,
  eventCount: 6, runCount: 2, totalGroups: 3,
  groups: [{ accountId: marker, appVersion: '1.4.6', clientType: 'desktop', module: 'agent/tool', failureCount: 6, runCount: 2 }],
  samples: [{ eventId: 'event-a', occurredAt: at, accountId: marker, appVersion: '1.4.6', clientType: 'desktop', module: 'agent/tool', toolName: 'device_file_download_to_local', failureCategory: 'permission_denied', failureDetail: '<script>sample detail</script>' }],
});

function harness() {
  const body = new Node('BODY');
  const make = (tag: string, cls = '', value: unknown = '') => { const node = new Node(tag.toUpperCase()); node.className = cls; node.textContent = String(value ?? ''); return node; };
  const add = (parent: Node, tag: string, cls = '', value: unknown = '') => parent.appendChild(make(tag, cls, value));
  const def = { key: 'tool-failure-repeat', title: '工具调用连续失败', category: 'metric' };
  const state = { config: { definitions: [def], rules: { [def.key]: { enabled: true, openAfter: 2, resolveAfter: 2 } } }, overview: { notifications: [] }, pendingAlertDetail: null as string | null, pendingAlertEvidenceAt: null as string | null };
  const calls: string[] = []; const openedEvents: unknown[] = []; let tenant = '';
  let serve: (path: string) => unknown = () => ({ ok: true, alertKey: def.key, occurredAt: at, evidence: evidence() });
  const context = vm.createContext({
    document: { body, getElementById: (id: string) => all(body).find(node => node.id === id) ?? null },
    make, add, state, URLSearchParams,
    OpsUI: { dialog(options: { id: string }) { const shell = make('div'); shell.id = options.id; shell.appendChild(make('div')); Object.assign(shell, { opsui: { open() { shell.classList.add('open'); }, close() { shell.classList.remove('open'); } } }); return { shell }; } },
    checkStatus: () => ({ status: 'healthy', summary: '当前已恢复', checkedAt: at }),
    statusNames: { healthy: '正常' }, dataSourceName: () => 'RDK 运营遥测', when: (value: unknown) => String(value ?? '—'),
    conditionText: () => '阈值', criticalText: () => '', channelLabel: () => '飞书', resolvedChannel: () => 'feishu', channelConfigured: () => true, ruleAuthor: () => '内置',
    overviewIncidents: () => [], buildTable: () => make('table'), setView() {}, toast() {},
    adminTenantQuery: () => tenant ? '&tenant=' + tenant : '',
    obsActiveTenant: () => tenant,
    async request(path: string) { calls.push(path); return serve(path); },
    openOpsEventDetail(event: unknown) { openedEvents.push(event); },
  });
  const drawerCode = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('      function ensureAlertDetailDrawer'), OPS_OBSERVABILITY_SCRIPT_A.indexOf("      let icScope="));
  vm.runInContext(drawerCode + '\n' + OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT + '\n globalThis.ops={openAlertDetail,closeAlertDetail,consumePendingAlertDetail,queueAlertEvidenceHash:typeof queueAlertEvidenceHash===\'function\'?queueAlertEvidenceHash:null};', context);
  const ops = context.ops as { openAlertDetail(definition: { key: string; title: string; category: string }, at?: string | null): void; closeAlertDetail(): void; consumePendingAlertDetail(): void; queueAlertEvidenceHash(raw: string): void };
  return { body, def, state, ops, calls, openedEvents, serve(fn: typeof serve) { serve = fn; }, tenant(value: string) { tenant = value; }, scope(kind: string) { Object.assign(context, { opsMemberMode: kind === 'member', opsTenantMode: kind === 'token', opsTenantToken: kind === 'token' ? 'fixture-token' : '' }); }, async flush() { await Promise.resolve(); await Promise.resolve(); } };
}

test('Historical deep link retains occurrence time; recovered alerts show the original account, client, version, module and counts', async () => {
  const h = harness();
  h.ops.queueAlertEvidenceHash('alert=tool-failure-repeat&at=' + encodeURIComponent(at));
  assert.equal(h.state.pendingAlertDetail, h.def.key); assert.equal(h.state.pendingAlertEvidenceAt, at);
  h.ops.consumePendingAlertDetail(); await h.flush();
  assert.match(h.calls[0], /alerts\/tool-failure-repeat\/evidence\?at=2026-10-15T09%3A43%3A57\.000Z$/);
  assert.equal(h.state.pendingAlertEvidenceAt, null);
  const content = text(h.body);
  for (const value of ['本次告警证据', '发生时窗口', '当前已恢复', 'account-a', '1.4.6', '桌面客户端', 'agent/tool', '6 条失败记录', '2 个独立 Run', '3 组', 'device_file_download_to_local', 'permission_denied', '<script>sample detail</script>']) assert.ok(content.includes(value), 'missing ' + value);
  assert.match(content, /展示 1.*共 3/); assert.match(content, /样本.*1.*6/);
  button(h.body, '查看事件详情').listeners.click[0]();
  assert.equal(h.openedEvents.length, 1); assert.equal((h.openedEvents[0] as { id: string }).id, 'event-a');
});

test('Legacy deep links and ordinary rule clicks read latest evidence without account or version URL fields', async () => {
  const h = harness(); h.ops.queueAlertEvidenceHash('alert=tool-failure-repeat'); h.ops.consumePendingAlertDetail(); await h.flush();
  assert.equal(h.calls[0], '/api/ops/observability/alerts/tool-failure-repeat/evidence');
  assert.match(text(h.body), /最近告警证据/);
  h.ops.closeAlertDetail(); h.ops.openAlertDetail(h.def); await h.flush();
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(path => !path.includes('account') && !path.includes('1.4.6')));
});

test('Both initial URL and hash changes queue the occurrence snapshot in the shipped page', () => {
  assert.equal((OPS_OBSERVABILITY_SCRIPT_C.match(/queueAlertEvidenceHash\(/g) || []).length, 2);
  assert.ok(OPS_OBSERVABILITY_HTML.includes(OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT));
  assert.ok(OPS_OBSERVABILITY_HTML.includes(OPS_OBSERVABILITY_ALERT_EVIDENCE_STYLE));
});

test('Missing historical snapshot has a distinct explanation and retry; infrastructure fields are explicitly inapplicable', async () => {
  const h = harness(); h.serve(() => ({ ok: true, alertKey: h.def.key, occurredAt: at, evidence: null }));
  h.ops.openAlertDetail(h.def, at); await h.flush();
  assert.match(text(h.body), /没有保存.*历史.*快照/); assert.ok(button(h.body, '重试读取'));
  h.serve(() => ({ ok: true, evidence: { ...evidence(), applicability: 'infrastructure', groups: [], totalGroups: 0, samples: [] } }));
  await button(h.body, '重试读取').listeners.click[0](); await h.flush();
  assert.match(text(h.body), /基础设施.*账号.*客户端.*不适用/);
});

test('Business fields absent from telemetry say unreported and preserve each real client type', async () => {
  const h = harness(); h.serve(() => ({ ok: true, evidence: { ...evidence(), totalGroups: 5, groups: ['web-cloud', 'miniapp', 'web-self-host', 'local-dev', null].map(clientType => ({ accountId: null, appVersion: null, clientType, module: 'client', failureCount: 2, runCount: 1 })) } }));
  h.ops.openAlertDetail(h.def); await h.flush();
  for (const label of ['网页云端', '小程序', '自部署网页', '本地开发', '未上报']) assert.ok(text(h.body).includes(label));
});

for (const staleAfter of ['close', 'new-rule', 'tenant'] as const) {
  test(`Evidence responses cannot mutate a drawer after ${staleAfter}`, async () => {
    const h = harness(); let resolve!: (value: unknown) => void;
    h.serve(() => new Promise(done => { resolve = done; })); h.ops.openAlertDetail(h.def, at);
    if (staleAfter === 'close') h.ops.closeAlertDetail();
    if (staleAfter === 'new-rule') { const otherDef = { ...h.def, key: 'other-alert' }; h.state.config.rules[otherDef.key] = { enabled: true, openAfter: 2, resolveAfter: 2 }; h.serve(() => ({ ok: true, evidence: evidence('current-marker') })); h.ops.openAlertDetail(otherDef); await h.flush(); }
    if (staleAfter === 'tenant') h.tenant('tenant-b');
    resolve({ ok: true, evidence: evidence('stale-marker') }); await h.flush();
    assert.doesNotMatch(text(h.body), /stale-marker/);
    if (staleAfter === 'new-rule') assert.match(text(h.body), /current-marker/);
  });
}

test('Evidence load failure offers retry and successful retry replaces the error', async () => {
  const h = harness(); h.serve(() => { throw new Error('unavailable'); }); h.ops.openAlertDetail(h.def); await h.flush();
  assert.match(text(h.body), /告警证据加载失败/); assert.ok(button(h.body, '重试读取'));
  h.serve(() => ({ ok: true, evidence: evidence('retry-marker') })); await button(h.body, '重试读取').listeners.click[0](); await h.flush();
  assert.match(text(h.body), /retry-marker/); assert.doesNotMatch(text(h.body), /告警证据加载失败/);
});


test('The real request helper 404 error is presented as missing history, with the occurrence time retained on retry', async () => {
  const h = harness(); h.serve(() => { const error = new Error('alert_evidence_not_found'); Object.assign(error, { status: 404 }); throw error; });
  h.ops.openAlertDetail(h.def, at); await h.flush();
  assert.match(text(h.body), /没有保存.*历史.*快照/); assert.doesNotMatch(text(h.body), /告警证据加载失败/);
  await button(h.body, '重试读取').listeners.click[0](); await h.flush();
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(path => path.includes('at=' + encodeURIComponent(at))));
});

for (const invalidAt of ['invalid-time', '']) {
  test(`An invalid occurrence locator ${JSON.stringify(invalidAt)} never reads a different latest snapshot`, async () => {
    const h = harness(); h.ops.queueAlertEvidenceHash('alert=tool-failure-repeat&at=' + encodeURIComponent(invalidAt));
    assert.equal(h.state.pendingAlertEvidenceAt, invalidAt);
    h.ops.consumePendingAlertDetail(); await h.flush();
    assert.equal(h.calls.length, 0); assert.match(text(h.body), /告警发生时间无效/); assert.doesNotMatch(text(h.body), /account-a/);
  });
}

for (const staleAfter of ['close', 'new-rule', 'tenant'] as const) {
  test(`Late evidence failure cannot replace the current state after ${staleAfter}`, async () => {
    const h = harness(); let reject!: (error: unknown) => void;
    h.serve(() => new Promise((_done, fail) => { reject = fail; })); h.ops.openAlertDetail(h.def, at);
    if (staleAfter === 'close') h.ops.closeAlertDetail();
    if (staleAfter === 'new-rule') { h.serve(() => ({ ok: true, evidence: evidence('current-marker') })); h.ops.openAlertDetail(h.def); await h.flush(); }
    if (staleAfter === 'tenant') h.tenant('tenant-b');
    reject(new Error('unavailable')); await h.flush();
    assert.doesNotMatch(text(h.body), /告警证据加载失败/);
    if (staleAfter === 'new-rule') assert.match(text(h.body), /current-marker/);
  });
}

for (const invalidAt of ['2026-02-30T08:00:00Z', 'October 15, 2026 17:43:57', '2026-10-15']) {
  test(`Invalid timestamp ${invalidAt} is never normalized into a different snapshot locator`, async () => {
    const h = harness(); h.serve(() => { throw new Error('invalid_alert_evidence_time'); });
    h.ops.queueAlertEvidenceHash('alert=tool-failure-repeat&at=' + encodeURIComponent(invalidAt));
    assert.equal(h.state.pendingAlertEvidenceAt, invalidAt);
    h.ops.consumePendingAlertDetail(); await h.flush();
    assert.ok(h.calls.every(path => path.includes('at=' + encodeURIComponent(invalidAt))));
    assert.match(text(h.body), /告警发生时间无效/); assert.doesNotMatch(text(h.body), /account-a|告警证据加载失败/);
  });
}

test('Selected tenant evidence remains visible but never offers a platform-only event detail path', async () => {
  const h = harness(); h.tenant('tenant-scoped'); h.ops.openAlertDetail(h.def, at); await h.flush();
  assert.match(text(h.body), /account-a|permission_denied/);
  assert.equal(all(h.body).filter(item => item.tagName === 'BUTTON' && item.textContent === '查看事件详情').length, 0);
  assert.match(text(h.body), /当前租户.*样本证据.*平台视图/);
  assert.ok(h.calls[0].endsWith('&tenant=tenant-scoped'));
});


for (const scope of ['member', 'token']) {
  test(`${scope} scope keeps visible samples without the platform-only detail button`, async () => {
    const h = harness(); h.scope(scope); h.ops.openAlertDetail(h.def); await h.flush();
    assert.match(text(h.body), /account-a/);
    assert.equal(all(h.body).filter(item => item.tagName === 'BUTTON' && item.textContent === '查看事件详情').length, 0);
    assert.match(text(h.body), /当前租户.*样本证据/);
  });
}

test('A reconstructed historical window explicitly states its provenance and save time', async () => {
  const h = harness(); const capturedAt = '2026-10-15T10:30:00.000Z';
  h.serve(() => ({ ok: true, occurredAt: at, evidence: { ...evidence(), source: 'historical-reconstruction', capturedAt } }));
  h.ops.openAlertDetail(h.def, at); await h.flush();
  assert.match(text(h.body), /根据原始失败记录回溯生成/); assert.ok(text(h.body).includes('保存时间：' + capturedAt));
});
