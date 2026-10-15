import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_SIMPLE_OVERVIEW_SCRIPT } from './observability-page-simple-overview.js';

/** Small DOM with real move semantics, selector matching and focus ownership. */
class Element {
  tagName: string; children: Element[] = []; parentNode: Element | null = null;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => unknown>> = {}; className = ''; id = ''; open = false;
  ownText = ''; document!: FixtureDocument;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.ownText + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.ownText = value; this.replaceChildren(); }
  get nextSibling(): Element | null { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get isConnected(): boolean { return this === this.document.body || Boolean(this.parentNode?.isConnected); }
  get classList() { return { contains: (name: string) => this.className.split(/\s+/).includes(name), add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); } }; }
  appendChild(node: Element) { this.insertBefore(node, null); return node; }
  insertBefore(node: Element, before: Element | null) { node.parentNode?.removeChild(node); const index = before ? this.children.indexOf(before) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, node); node.parentNode = this; return node; }
  removeChild(node: Element) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
  replaceChildren(...nodes: Element[]) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; nodes.forEach(node => this.appendChild(node)); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  addEventListener(event: string, listener: () => unknown) { (this.listeners[event] ||= []).push(listener); }
  fire(event: string) { this.listeners[event]?.forEach(listener => listener()); }
  focus() { this.document.activeElement = this; }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const attrs = [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      let bare = part.replace(/\[[^\]]+\]/g, '').trim();
      const tag = bare.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const name of bare.matchAll(/\.([a-z0-9_-]+)/gi)) if (!this.classList.contains(name[1])) return false;
      for (const [, name, value] of attrs) {
        const actual = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase())] : this.attributes[name];
        if (actual === undefined || (value !== undefined && actual !== value)) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(_value: string) { throw new Error('unsafe HTML rendering'); }
}
class FixtureDocument {
  body = new Element('body'); activeElement = this.body;
  constructor() { this.body.document = this; }
  createElement(tag: string) { const node = new Element(tag); node.document = this; return node; }
  getElementById(id: string): Element | null { const find = (node: Element): Element | null => node.id === id ? node : node.children.map(find).find(Boolean) || null; return find(this.body); }
}

function fixture() {
  const document = new FixtureDocument();
  const make = (tag: string, cls = '', text?: string) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = String(text); return node; };
  const add = (parent: Element, tag: string, cls: string, text?: string) => parent.appendChild(make(tag, cls, text));
  const root = add(document.body, 'div', ''); root.id = 'overviewContent';
  const state: any = { domain: 'cloud', overviewHours: 24, overview: { windowHours: 24, checks: [], ai: { successRate: 1, total: 3, errors: 0 }, signals: { toolFailures: 0, clientErrors: 0, api5xx: 0, processErrors: 0, loginInfrastructureErrors: 0 }, summary: { openIncidents: 0 }, alerting: { lastCheckedAt: '2026-10-13T01:00:00Z', status: 'healthy' } }, actionLoop: { actions: [], loaded: true, loading: false, error: '', mutationError: '' } };
  const auth = { me: { user: { id: 'actor-a' }, admin: true } }; let tenant = 'tenant-a'; let refreshCalls = 0;
  let originals: Element[] = [];
  const baseAction = () => {
    const mount = document.getElementById('actionLoopMount'); if (!mount) return;
    const panel = make('section', 'action-loop-panel'); panel.id = 'actionLoopPanel';
    const identity = add(panel, 'div', 'action-loop-identity'); add(identity, 'h2', '', '行动闭环'); add(identity, 'p', '', '真实流程说明');
    const headActions = add(panel, 'div', 'action-loop-head-actions'); add(headActions, 'span', 'action-loop-count', state.actionLoop.actions.length + ' 条行动'); const refresh = add(headActions, 'button', 'action-loop-refresh', '刷新'); refresh.addEventListener('click', () => { refreshCalls++; });
    add(panel, 'div', 'action-loop-flow', '原流程'); const body = add(panel, 'div', 'action-loop-body');
    if (state.actionLoop.loading) add(body, 'div', 'action-loop-state', '正在读取行动队列');
    else if (state.actionLoop.error) add(body, 'div', 'action-loop-state error', state.actionLoop.error);
    else if (!state.actionLoop.actions.length) { const empty = add(body, 'div', 'action-loop-empty'); add(empty, 'strong', '', '还没有持久化行动'); add(empty, 'span', '', '原空态'); add(empty, 'button', '', '打开事故调查'); }
    const list = add(body, 'div', 'action-loop-list');
    for (const action of state.actionLoop.actions) { const card = add(list, 'article', 'action-loop-card', action.id); card.dataset.status = action.status; const button = add(card, 'button', '', '原行动控件'); button.addEventListener('click', () => { refreshCalls++; }); }
    if (state.actionLoop.mutationError) { const error = add(body, 'div', 'action-loop-state error', state.actionLoop.mutationError); error.id = 'actionLoopMutationError'; }
    add(body, 'div', 'action-loop-note', '原安全说明'); mount.replaceChildren(panel); originals.push(...panel.querySelectorAll('button'));
  };
  const baseOverview = () => {
    originals = []; root.replaceChildren(); add(root, 'section', 'hero', '原健康摘要');
    const action = add(root, 'section', 'panel section'); add(action, 'h2', '', '运营行动中心'); const link = add(action, 'a', '', '进入事故工作台 →'); link.setAttribute('href', '#overview');
    const metrics = add(root, 'div', 'metrics');
    for (const label of ['AI 完成率', '工具失败', '系统错误', '进行中告警']) { const card = add(metrics, 'div', 'panel metric'); add(card, 'div', 'label', label); add(card, 'div', 'value good', label === 'AI 完成率' ? '100.0%' : '0'); }
    const impact = add(root, 'div', 'impact-grid'); add(impact, 'section', 'impact-panel', '原服务健康'); const health = add(impact, 'section', 'impact-panel'); add(health, 'div', state.fixtureObservationGood ? 'value good' : 'value warn', state.fixtureObservationGood ? '3' : '—');
    const product = add(root, 'section', 'north-star-panel'); add(product, 'article', state.fixtureProductGood ? 'north-star-card healthy' : 'north-star-card unknown', '原产品指标');
    const details = add(root, 'details', 'detail-sections'); add(details, 'summary', '', '详细监控'); add(details, 'section', 'incident-section', '原事故控件');
    const mount = add(root, 'div', ''); mount.id = 'actionLoopMount';
    context.renderActionLoopMount();
  };
  const context = vm.createContext({ document, state, obsAuthState: auth, obsActiveTenant: () => tenant, opsTenantMode: false, opsMemberMode: false, make, add, $: (id: string) => document.getElementById(id), when: (value: unknown) => String(value), renderOverview: baseOverview, renderActionLoopMount: baseAction });
  vm.runInContext(OPS_OBSERVABILITY_SIMPLE_OVERVIEW_SCRIPT, context);
  const render = () => context.renderOverview();
  const detail = (key: string) => root.querySelectorAll('details[data-simple-overview-key]').find(node => node.dataset.simpleOverviewKey === key)!;
  return { root, document, state, auth, context, render, detail, originals: () => originals, refreshCalls: () => refreshCalls, tenant: (value: string) => { tenant = value; } };
}

test('confirmed zero actions become one disclosure, retaining genuine refresh and all original nodes', () => {
  const h = fixture(); h.render(); const empty = h.detail('action-empty'); assert.ok(empty); assert.equal(empty.open, false);
  const refresh = empty.querySelector('summary')!.querySelector('button')!; assert.ok(h.originals().includes(refresh)); refresh.fire('click'); assert.equal(h.refreshCalls(), 1);
  assert.equal(h.root.querySelectorAll('.action-loop-panel').length, 1); assert.equal(h.root.children[2].id, 'actionLoopMount');
  assert.match(h.detail('action-guide').textContent, /真实流程说明.*原流程.*原安全说明/);
  assert.equal(h.root.querySelector('a')!.getAttribute('href'), '#alerts/center');
  assert.ok(h.root.querySelector('.incident-section')!.parentNode!.classList.contains('detail-sections'));
});

for (const state of [{ loading: true }, { error: '真实读取失败' }, { mutationError: '真实写入失败' }, { loaded: false }, { busyId: 'busy' }]) {
  test(`unconfirmed/error/busy zero-action snapshot remains at first level: ${JSON.stringify(state)}`, () => {
    const h = fixture(); Object.assign(h.state.actionLoop, state); h.render(); assert.equal(h.detail('action-empty'), undefined);
    assert.equal(h.root.querySelector('.action-loop-panel')!.parentNode!.id, 'actionLoopMount');
    if (state.loaded === false) assert.match(h.root.querySelector('.action-loop-empty')!.textContent, /状态尚未确认/);
  });
}

test('only completed and denied archive; every other known and unknown action keeps its genuine controls visible', () => {
  const h = fixture(); const statuses = ['pending_approval', 'approved', 'executing', 'failed', 'verification_failed', 'succeeded', 'unknown', '', 'completed', 'denied'];
  h.state.actionLoop.actions = statuses.map((status, index) => ({ id: 'action-' + index, status })); h.render();
  const archived = h.detail('action-archive'); assert.equal(archived.querySelectorAll('.action-loop-card').length, 2);
  for (const card of h.root.querySelectorAll('.action-loop-card')) { const isArchived = archived.querySelectorAll('.action-loop-card').includes(card); assert.equal(isArchived, ['completed', 'denied'].includes(card.dataset.status)); card.querySelector('button')!.fire('click'); }
  assert.equal(h.refreshCalls(), 10); assert.equal(h.root.querySelectorAll('.action-loop-card').length, 10);
});

test('an unconfirmed snapshot with retained records still shows an explicit first-level notice', () => {
  const h = fixture(); h.state.actionLoop.loaded = false; h.state.actionLoop.actions = [{ id: 'retained', status: 'pending_approval' }]; h.render();
  const notice = h.root.querySelector('.simple-overview-confirmation')!; assert.match(notice.textContent, /行动快照尚未确认/);
  assert.ok(notice.parentNode!.classList.contains('action-loop-body')); assert.equal(h.detail('action-empty'), undefined);
});

test('health summaries disclose unknown, stale, disabled and abnormal states without replacing real panels', () => {
  const h = fixture(); h.state.overview.checks = ['warning', 'critical', 'observing', 'unknown', 'stale', 'disabled', 'healthy', 'future-status'].map((status, index) => ({ key: 'service-' + index, status }));
  h.state.overview.checks.push({ key: 'north-star-test', status: 'disabled' }); h.state.overview.alerting.lastCheckedAt = null; h.render();
  const service = h.detail('service-health'); assert.match(service.querySelector('summary')!.textContent, /异常 3 · 未确认 2 · 过期 1 · 停用 1.*观测待确认 1.*巡检时间未确认/);
  assert.equal(service.querySelectorAll('.impact-grid').length, 1); assert.equal(service.open, false);
  assert.match(h.detail('product-health').querySelector('summary')!.textContent, /未确认 1.*停用 1/);
  assert.equal(h.root.querySelectorAll('.north-star-card').length, 1);
});

test('only explicitly confirmed good numeric metrics fold; missing samples and missing counters remain visible', () => {
  const h = fixture(); h.state.overview.ai.total = 0; delete h.state.overview.signals.toolFailures; delete h.state.overview.signals.api5xx; h.render();
  const firstMetrics = h.root.children.find(node => node.classList.contains('metrics'))!;
  assert.equal(firstMetrics.children.length, 3); assert.equal(h.detail('runtime-metrics').querySelectorAll('.metric').length, 1);
  const metrics = h.root.querySelectorAll('.metric'); assert.equal(metrics.length, 4);
});

test('missing service snapshot and unrecognised巡检 status remain explicitly unconfirmed', () => {
  const h = fixture(); h.state.overview.checks = []; h.state.overview.alerting.status = 'unknown'; h.render();
  assert.match(h.detail('service-health').querySelector('summary')!.textContent, /服务检查未确认.*巡检状态未确认/);
});

test('confirmed normal summaries are short, omit zero concern counts, and keep original count inside expanded action content', () => {
  const h = fixture(); h.state.overview.checks = [{ key: 'service-good', status: 'healthy' }, { key: 'north-star-good', status: 'healthy' }]; h.state.fixtureObservationGood = true; h.state.fixtureProductGood = true; h.render();
  const serviceSummary = h.detail('service-health').querySelector('summary')!;
  const productSummary = h.detail('product-health').querySelector('summary')!;
  assert.equal(serviceSummary.textContent, '服务与观测健康1 项检查 · 未见异常'); assert.equal(productSummary.textContent, '产品健康1 项指标 · 未见异常 · 产品目标见详情');
  assert.doesNotMatch(serviceSummary.textContent + productSummary.textContent, /异常 0|未确认 0|过期 0|停用 0/);
  const action = h.detail('action-empty'); assert.equal(action.querySelector('summary')!.textContent, '行动闭环当前无待处理行动刷新');
  assert.ok(action.querySelector('.simple-overview-content')!.querySelector('.action-loop-count')); assert.equal(action.querySelector('summary')!.querySelector('.action-loop-count'), null);
});

test('overview and independent action rebuilds preserve disclosure state and summary focus without nesting copies', () => {
  const h = fixture(); h.render(); const service = h.detail('service-health'); service.open = true; service.fire('toggle'); service.querySelector('summary')!.focus(); h.render();
  assert.equal(h.detail('service-health').open, true); assert.equal(h.document.activeElement, h.detail('service-health').querySelector('summary'));
  const empty = h.detail('action-empty'); empty.open = true; empty.fire('toggle'); empty.querySelector('summary')!.focus(); h.context.renderActionLoopMount();
  assert.equal(h.detail('action-empty').open, true); assert.equal(h.document.activeElement, h.detail('action-empty').querySelector('summary'));
  h.context.renderActionLoopMount(); h.context.renderActionLoopMount(); h.render();
  for (const key of ['service-health', 'product-health', 'action-empty', 'action-guide', 'runtime-metrics']) assert.equal(h.root.querySelectorAll('details[data-simple-overview-key]').filter(node => node.dataset.simpleOverviewKey === key).length, 1);
});

for (const change of ['identity', 'tenant', 'snapshotTenant', 'domain', 'hours', 'role']) {
  test(`disclosure preferences and focus stay isolated after ${change} changes`, () => {
    const h = fixture(); h.render(); const detail = h.detail('service-health'); detail.open = true; detail.fire('toggle'); detail.querySelector('summary')!.focus();
    if (change === 'identity') h.auth.me.user.id = 'actor-b'; if (change === 'tenant') h.tenant('tenant-b'); if (change === 'snapshotTenant') h.state.overview.tenantScope = 'tenant-b'; if (change === 'domain') h.state.domain = 'edge'; if (change === 'hours') h.state.overviewHours = 168; if (change === 'role') h.auth.me.admin = false;
    h.render(); assert.equal(h.detail('service-health').open, false); assert.notEqual(h.document.activeElement, h.detail('service-health').querySelector('summary'));
    detail.open = false; detail.fire('toggle'); // A detached old scope cannot mutate this scope's state.
    h.detail('service-health').open = true; h.detail('service-health').fire('toggle'); h.render(); assert.equal(h.detail('service-health').open, true);
  });
}
