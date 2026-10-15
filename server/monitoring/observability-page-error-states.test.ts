/** 页面实际脚本的接口失败回归：失败、空数据和身份限制必须能区分。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';
import { OPS_OBSERVABILITY_SCRIPT_B } from './observability-page-script-b.js';
import { OPS_OBSERVABILITY_SCRIPT_SIGNALS } from './observability-page-script-signals.js';
import { OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT } from './observability-page-action-loop.js';

class Node {
  tagName: string;
  children: Node[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(event: { preventDefault(): void }) => unknown>> = {};
  style: Record<string, unknown> = {};
  dataset: Record<string, string> = {};
  parentNode: Node | null = null;
  textContent = ''; className = ''; value = ''; id = ''; type = ''; disabled = false;
  innerHTML = '';
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  appendChild(node: Node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes: Node[]) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(type: string, listener: typeof this.listeners[string][number]) { (this.listeners[type] ||= []).push(listener); }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

type Json = Record<string, unknown>;
function response(status: number, data: Json) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function setup(options: { token?: boolean; cookieUser?: boolean; includeBaseLoader?: boolean } = {}) {
  const ids = new Map<string, Node>();
  for (const id of ['toast', 'incidentList', 'incidentSummary', 'signalsPanelGrid', 'nlQueryInput', 'nlQueryResult', 'promqlNativeLink']) {
    const node = new Node('div'); node.id = id; ids.set(id, node);
  }
  const body = new Node('body');
  const html = new Node('html');
  const calls: string[] = [];
  let accessScreens = 0;
  let serve: (path: string) => ReturnType<typeof response> = () => response(200, { ok: true });
  const context = vm.createContext({
    document: {
      body, documentElement: html,
      createElement: (tag: string) => new Node(tag),
      createElementNS: (_ns: string, tag: string) => new Node(tag),
      getElementById: (id: string) => ids.get(id) ?? null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {},
    location: { pathname: '/dobs/ops-observability', href: 'https://example.test/dobs/ops-observability' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: (key: string) => options.token && key === 'd_obs_admin_token' ? 'test-only-token' : null, setItem() {} },
    fetch: async (path: string) => { calls.push(path); return serve(path); },
    renderOverview() {}, loadAll: async () => {}, renderCopilotAnalysis() {},
    setTimeout: () => 0, clearTimeout() {}, console: { warn() {} },
    URL, URLSearchParams,
  });
  const baseLoader = options.includeBaseLoader ? OPS_OBSERVABILITY_SCRIPT_B : '';
  const hook = `
    renderAccess=()=>globalThis.onAccessScreen();
    adminTenantQuery=()=>'';
    renderRules=()=>{};renderMetrics=()=>{};renderChannels=()=>{};renderSettings=()=>{};
    setView=()=>{};
    if(${Boolean(options.cookieUser)})obsAuthState.me={user:{id:'test-cookie-user'},admin:true};
    globalThis.obs={state,obsAuthState,obsLoadMe,applyAuthMode,loadIncidentCenter,renderBoardPanels,openPanelModal,runNlQuery,loadActionLoop,loadAll,actionLoopRequest};
  `;
  context.onAccessScreen = () => { accessScreens += 1; };
  vm.runInContext(`${OPS_OBSERVABILITY_SCRIPT_UI}\n${OPS_OBSERVABILITY_SCRIPT_A}\n${baseLoader}\n${OPS_OBSERVABILITY_SCRIPT_SIGNALS}\n${OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT}\n${hook}})();`, context);
  const obs = context.obs as {
    state: Record<string, any>;
    obsAuthState: { me: Json | null };
    obsLoadMe(): Promise<Json | null>;
    applyAuthMode(me: Json): boolean;
    loadIncidentCenter(): Promise<void>;
    renderBoardPanels(): void;
    openPanelModal(panel: unknown, index: number): void;
    runNlQuery(): Promise<void>;
    loadActionLoop(force: boolean): Promise<void>;
    loadAll(manual: boolean): Promise<void>;
    actionLoopRequest(path: string): Promise<unknown>;
  };
  return { obs, body, calls, ids, serve(fn: typeof serve) { serve = fn; }, get accessScreens() { return accessScreens; } };
}

const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const text = (node: Node) => all(node).map(item => item.textContent).join(' ');
const settle = () => new Promise(resolve => setImmediate(resolve));
const board = { id: 'b1', name: 'Test', spec: { windowMinutes: 240, range: null, filters: null, panels: [{ title: 'CPU', metric: 'system.cpu', chart: 'line', width: 1 }] } };

test('事故列表和汇总503显示失败与重试，不能冒充没有事故或零严重事故', async () => {
  const h = setup();
  h.obs.state.viewChild = 'center'; h.obs.state.config = {};
  h.serve(() => response(503, { ok: false, error: 'central_store_disabled' }));
  await h.obs.loadIncidentCenter();
  const list = h.ids.get('incidentList')!;
  const summary = h.ids.get('incidentSummary')!;
  assert.match(text(list), /事故列表加载失败.*中心库未启用/);
  assert.match(text(summary), /处置概览加载失败/);
  assert.doesNotMatch(text(list), /没有匹配的事故/);
  assert.equal(all(summary).filter(node => node.className === 'ic-viz').length, 0);
  const retry = all(list).find(node => node.tagName === 'BUTTON' && node.textContent === '重试')!;
  h.serve(path => response(200, path.includes('/summary') ? { ok: true, summary: { pending: 0, processing: 0, closed: 0, todayNew: 0, criticalActive: 0, warningActive: 0, daily: [] } } : { ok: true, incidents: [], total: 0 }));
  await retry.listeners.click[0]({ preventDefault() {} });
  assert.match(text(list), /没有匹配的事故/);
  assert.doesNotMatch(text(summary), /加载失败/);
});

for (const status of [403, 503]) {
  test(`看板面板${status}显示错误，200空序列才显示没有数据`, async () => {
    const h = setup();
    h.obs.state.boards = [board]; h.obs.state.currentBoardId = 'b1';
    h.serve(() => response(status, { ok: false, error: status === 403 ? 'not_authorized' : 'metrics_query_unavailable' }));
    h.obs.renderBoardPanels(); await settle();
    const grid = h.ids.get('signalsPanelGrid')!;
    assert.doesNotMatch(text(grid), /所选范围内没有数据点/);
    assert.ok(all(grid).some(node => node.attrs.role === 'alert'));
    assert.match(text(grid), status === 403 ? /没有访问权限/ : /OTLP 指标存储暂不可用/);
    const retry = all(grid).find(node => node.tagName === 'BUTTON' && node.textContent === '重试')!;
    h.serve(path => response(200, path.endsWith('/boards') ? { ok: true, boards: [board] } : { ok: true, series: [] }));
    await retry.listeners.click[0]({ preventDefault() {} }); await settle();
    assert.match(text(grid), /所选范围内没有数据点/);
  });
}

test('面板编辑器预览与库面板503不能显示无数据/库面板为空', async () => {
  const h = setup(); h.obs.state.boards = [board]; h.obs.state.currentBoardId = 'b1'; h.obs.state.boardEditMode = true;
  h.serve(() => response(503, { ok: false, error: 'metrics_query_unavailable' }));
  h.obs.openPanelModal(board.spec.panels[0], 0); await settle();
  assert.match(text(h.body), /OTLP 指标存储暂不可用/);
  assert.match(text(h.body), /库面板读取失败/);
  assert.doesNotMatch(text(h.body), /所选范围内没有数据点|库面板为空/);
});

test('智能查询识别成功但时序查询503保留接口错误，不显示空序列', async () => {
  const h = setup(); h.ids.get('nlQueryInput')!.value = '查CPU';
  h.serve(path => path.includes('/nl-query') ? response(200, { ok: true, source: 'rules', spec: { metric: 'system.cpu', plane: 'otlp', windowMinutes: 240 } }) : response(503, { ok: false, error: 'metrics_query_unavailable' }));
  await h.obs.runNlQuery(); await settle();
  assert.match(text(h.ids.get('nlQueryResult')!), /平台内指标查询失败/);
  assert.doesNotMatch(text(h.ids.get('nlQueryResult')!), /所选范围内没有数据点/);
});

test('token-only原生Prom入口说明SSO要求，cookie SSO保留原生导航', async () => {
  for (const cookieUser of [false, true]) {
    const h = setup({ token: true, cookieUser });
    let prevented = false;
    const native = h.ids.get('promqlNativeLink')!;
    await native.listeners.click[0]({ preventDefault() { prevented = true; } });
    assert.equal(prevented, !cookieUser);
    if (!cookieUser) assert.match(h.ids.get('toast')!.textContent, /SSO 运营账号.*本页 PromQL/);
  }
});

test('行动域403保持cookie登录界面，401才显示登录屏', async () => {
  const h = setup({ cookieUser: true });
  h.serve(() => response(403, { ok: false, error: 'not_authorized' }));
  await assert.rejects(h.obs.actionLoopRequest('/api/ops/observability/actions'), /not_authorized/);
  assert.equal(h.accessScreens, 0);
  h.serve(() => response(401, { ok: false, error: 'authentication_required' }));
  await assert.rejects(h.obs.actionLoopRequest('/api/ops/observability/actions'), /not_authorized/);
  assert.equal(h.accessScreens, 1);
});

test('行动队列token-only403说明SSO身份限制，不再轮询；手动刷新恢复请求', async () => {
  const h = setup({ token: true, includeBaseLoader: true });
  h.serve(path => {
    if (path.includes('/actions')) return response(403, { ok: false, error: 'not_authorized' });
    if (path.includes('/overview')) return response(200, { ok: true, overview: { alerting: { lastCheckedAt: '2026-10-10T00:00:00Z' } } });
    if (path.includes('/config')) return response(200, { ok: true, config: {} });
    return response(200, { ok: true });
  });
  await h.obs.loadAll(false); await settle();
  assert.match(h.obs.state.actionLoop.error, /SSO 运营账号身份.*管理 token/);
  const count = () => h.calls.filter(path => path.includes('/actions')).length;
  assert.equal(count(), 1);
  await h.obs.loadAll(false); await h.obs.loadActionLoop(false); await settle();
  assert.equal(count(), 1, '后续自动刷新不重复403');
  await h.obs.loadAll(true); await settle();
  assert.equal(count(), 2, '手动刷新再尝试一次');
});

test('cookie身份或管理员权限变化清除旧行动缓存并自动重试，同身份保留403缓存', async () => {
  const h = setup({ includeBaseLoader: true });
  let identity = { user: { id: 'account-a' }, admin: true };
  let denied = true;
  h.serve(path => {
    if (path.includes('/auth/me')) return response(200, { ok: true, ...identity });
    if (path.includes('/actions')) return denied
      ? response(403, { ok: false, error: 'not_authorized' })
      : response(200, { ok: true, actions: [{ id: identity.user.id }], stats: [{ status: 'pending_approval', count: 1 }] });
    if (path.includes('/overview')) return response(200, { ok: true, overview: { alerting: { lastCheckedAt: '2026-10-10T00:00:00Z' } } });
    if (path.includes('/config')) return response(200, { ok: true, config: {} });
    return response(200, { ok: true });
  });
  const refreshIdentity = async () => {
    const me = await h.obs.obsLoadMe();
    assert.ok(me);
    assert.equal(h.obs.obsAuthState.me, me, '真实加载器先赋新身份快照');
    h.obs.applyAuthMode(me);
  };
  const count = () => h.calls.filter(path => path.includes('/actions')).length;
  await refreshIdentity();
  await h.obs.loadAll(false); await settle();
  assert.equal(h.obs.state.actionLoop.accessDenied, true);
  assert.equal(count(), 1);
  const oldError = h.obs.state.actionLoop.error;
  await refreshIdentity();
  assert.equal(h.obs.state.actionLoop.accessDenied, true, '同账号同权限保留拒绝缓存');
  assert.equal(h.obs.state.actionLoop.error, oldError);
  await h.obs.loadAll(false); await settle();
  assert.equal(count(), 1, '同身份自动刷新不反复403');

  denied = false;
  for (const next of [{ user: { id: 'account-b' }, admin: true }, { user: { id: 'account-b' }, admin: false }]) {
    h.obs.state.actions = [{ id: 'old-account-action' }];
    Object.assign(h.obs.state.actionLoop, { accessDenied: true, error: oldError, loaded: true, actions: [{ id: 'old-account-action' }], stats: [{ status: 'old', count: 9 }] });
    identity = next;
    const before = count();
    await refreshIdentity();
    assert.equal(h.obs.state.actions, null);
    assert.equal(h.obs.state.actionLoop.accessDenied, false);
    assert.equal(h.obs.state.actionLoop.error, '');
    assert.equal(h.obs.state.actionLoop.loaded, false);
    assert.equal(h.obs.state.actionLoop.actions.length, 0);
    assert.equal(h.obs.state.actionLoop.stats.length, 0);
    await h.obs.loadAll(false); await settle();
    assert.ok(count() > before, '身份或管理员权限变化后自动刷新恢复读取');
    assert.equal(h.obs.state.actionLoop.loaded, true);
    assert.equal(h.obs.state.actionLoop.actions[0].id, 'account-b');
    assert.equal(h.obs.state.actionLoop.stats[0].count, 1);
  }
});
