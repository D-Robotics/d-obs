import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW } from './observability-page-script-overview.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';
import { OPS_OBSERVABILITY_COCKPIT_SCRIPT } from './observability-page-cockpit.js';
import { OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT } from './observability-page-action-loop.js';
import { OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import { OPS_OBSERVABILITY_SCRIPT_FOCUS } from './observability-page-focus.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

const NOW = Date.parse('2026-10-10T04:00:00Z');
type ToggleEvent = { target: DomNode };

/** A small DOM model runs the actual renderers, including safe-DOM guards. */
class DomNode {
  id = ''; textContent = ''; title = ''; open = false; hidden = false;
  value = ''; type = ''; disabled = false; tabIndex = 0;
  dataset: Record<string, string> = {}; style: Record<string, unknown> = {};
  children: DomNode[] = []; parentElement: DomNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: ToggleEvent) => void>>();
  private classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => { const next = force ?? !this.classes.has(name); if (next) this.classes.add(name); else this.classes.delete(name); return next; },
  };
  constructor(readonly tagName: string, private htmlWrite: (value: unknown) => void) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  set innerHTML(value: string) { this.htmlWrite(value); throw new Error('unsafe HTML write'); }
  get parentNode() { return this.parentElement; }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  appendChild(node: DomNode) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node: DomNode, before: DomNode | null) {
    if (!before || !this.children.includes(before)) return this.appendChild(node);
    node.remove();
    this.children.splice(this.children.indexOf(before), 0, node);
    node.parentElement = this;
    return node;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceChildren(...nodes: DomNode[]) { [...this.children].forEach(node => node.remove()); nodes.forEach(node => this.appendChild(node)); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: ToggleEvent) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  dispatch(name: string) { this.listeners.get(name)?.forEach(listener => listener({ target: this })); }
  matches(selector: string): boolean {
    const classAttribute = selector.match(/^\.([\w-]+)(\[.*\])$/);
    if (classAttribute) return this.classes.has(classAttribute[1]) && this.matches(classAttribute[2]);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attr = selector.match(/^([a-z]+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) return (!attr[1] || this.tagName === attr[1].toUpperCase()) && (attr[3] == null ? (attr[2] === 'id' ? !!this.id : this.attributes.has(attr[2])) : this.getAttribute(attr[2]) === attr[3]);
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector: string): DomNode[] { return this.children.flatMap(node => [node, ...node.querySelectorAll('*')]).filter(node => selector === '*' || node.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): DomNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
}

function harness() {
  const htmlWrites: unknown[] = [];
  const make = (tag: string, cls = '', text: unknown = '') => { const node = new DomNode(tag.toUpperCase(), value => htmlWrites.push(value)); node.className = cls; node.textContent = String(text ?? ''); return node; };
  const add = (node: DomNode, tag: string, cls = '', text: unknown = '') => node.appendChild(make(tag, cls, text));
  const body = make('body');
  const root = add(body, 'div'); root.id = 'overviewContent';
  for (const id of ['fresh', 'globalIncidentFact', 'pageKicker', 'pageTitle', 'pageIntro']) add(body, 'span').id = id;
  const options = add(body, 'details', 'workspace-options'); options.id = 'workspaceOptions';
  add(options, 'button').id = 'runChecks';
  const addNavButtons = (parent: DomNode, html: string) => [...html.matchAll(/<button\b[^>]*data-view="([^"]+)"[^>]*>/g)].forEach(match => { const tab = add(parent, 'button', 'module-tab'); tab.dataset.view = match[1]; tab.setAttribute('data-view', match[1]); });
  const groups = ['data', 'infra', 'advanced'].map(name => {
    const group = add(body, 'details', 'nav-group'); group.dataset.navGroup = name;
    const html = OPS_OBSERVABILITY_HTML.match(new RegExp('<details\\b[^>]*data-nav-group="' + name + '"[^>]*>[\\s\\S]*?</details>'))?.[0];
    assert.ok(html, 'production navigation group exists: ' + name); addNavButtons(group, html); return group;
  });
  addNavButtons(body, OPS_OBSERVABILITY_HTML.match(/<div class="nav-main"[^>]*>[\s\S]*?<\/div>/)?.[0] || '');
  const byId = (id: string) => body.querySelector('#' + id);
  const documentListeners = new Map<string, (event: ToggleEvent) => void>();
  // 页面脚本经 OpsUI 组件层（OpsUI.table/state）与 toast 走 document.createElement /
  // getElementById；桩与真实 DOM 对齐，缺面会让渲染链在桩边界误报。
  const document = { title: '', createElement: (tag: string) => make(tag), getElementById: (id: string) => body.querySelector('#' + id), querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector), addEventListener: (name: string, fn: (event: ToggleEvent) => void) => documentListeners.set(name, fn) };
  const overview = {
    alerting: { status: 'healthy', lastCheckedAt: new Date(NOW).toISOString(), shadowMode: false, webhookConfigured: true },
    summary: { totalChecks: 3, healthyChecks: 3, disabledChecks: 0, openIncidents: 0, criticalIncidents: 0 },
    ai: { total: 10, successRate: 1, errors: 0 },
    signals: { totalEvents: 10, toolFailures: 0, clientErrors: 0, api5xx: 0, processErrors: 0, loginInfrastructureErrors: 0 },
    windowHours: 24, tenantScope: null,
    incidents: [] as Array<{ key: string; title: string; status: string; severity: string; summary: string; firstSeenAt: string; lastSeenAt: string; occurrences: number }>,
    events: [], incidentActivity: [], configurationAudit: [], notifications: [],
    checks: [
      { key: 'agent-runtime', title: 'Agent Runtime', status: 'healthy', summary: '正常', checkedAt: new Date(NOW).toISOString() },
      { key: 'north-star-first-success-rate', title: '首次成功率', status: 'healthy', summary: '当前 0.0% · 样本 100 · 产品目标 ≥ 80%', checkedAt: new Date(NOW).toISOString() },
      { key: 'north-star-retention-d1', title: '次日留存', status: 'unknown', summary: '样本不足', checkedAt: null },
    ],
  };
  type ActionState = { actions: unknown[]; error: string; mutationError: string; loaded: boolean; loading: boolean };
  const state: { overview: typeof overview; actions: unknown[] | null; remediation: null; view: string; viewSource: string; viewChild: string; actionLoop?: ActionState } = { overview, actions: [], remediation: null, view: 'overview', viewSource: 'overview', viewChild: '' };
  const viewMeta: Record<string, string[]> = {};
  const navGroupByView: Record<string, string> = { overview: 'primary', signals: 'data', devices: 'infra' };
  const moduleNavKey: Record<string, string> = { 'platform/model-pool': 'model-pool' };
  const viewCalls: Array<{ requested: string; updateHash: boolean }> = [];
  const context = vm.createContext({
    document, make, add, $: byId, state, viewMeta, navGroupByView, moduleNavKey,
    Date: class extends Date { static now() { return NOW; } },
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: unknown) => (Number(value) * 100).toFixed(1) + '%', when: (value: unknown) => String(value || '—'),
    statusNames: { healthy: '正常', unknown: '未知', open: '进行中' }, severityNames: { critical: '严重', warning: '告警' }, outcomeNames: {},
    overviewChecks: (o: typeof overview) => o.checks || [], overviewNumber: (value: unknown) => Number(value) || 0,
    opsTenantMode: false, opsMemberMode: false, loadAll: async () => {}, renderCopilotAnalysis() {},
    section(title: string, hint: string) { const panel = make('section', 'panel section'); const head = add(panel, 'div', 'section-head'); add(head, 'h2', '', title); add(head, 'p', 'hint', hint); return panel; },
    setView(requested: string, updateHash = true) {
      viewCalls.push({ requested, updateHash });
      const resolved = vm.runInContext('resolveViewRequest(' + JSON.stringify(requested) + ')', context) as { name: string; source: string; child: string };
      Object.assign(state, { view: resolved.name, viewSource: resolved.source, viewChild: resolved.child });
      vm.runInContext('updateViewHeader(state.viewSource,state.view);openNavGroupForView(state.view,state.viewSource)', context);
      return 'base-result';
    },
  });
  const productionLines = ['const viewAliases =', 'const viewModuleChildren =', 'function resolveViewRequest(', 'function updateViewHeader(', 'function openNavGroupForView('].map(marker => OPS_OBSERVABILITY_SCRIPT_A.split('\n').find(line => line.includes(marker)));
  assert.ok(productionLines.every(Boolean));
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_UI + '\n' + productionLines.join('\n') + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_HIERARCHY + '\n' + OPS_OBSERVABILITY_SCRIPT_FOCUS, context);
  const text = (node: DomNode): string => [node.textContent, ...node.children.map(text)].join(' ');
  const render = () => { vm.runInContext('renderOverview()', context); assert.deepEqual(htmlWrites, []); };
  const toggle = (id: string, open: boolean) => { const node = byId(id)!; node.open = open; node.dispatch('toggle'); documentListeners.get('toggle')?.({ target: node }); };
  return { state, context, root, byId, groups, navGroupByView, moduleNavKey, viewMeta, viewCalls, text, render, toggle, htmlWrites };
}

test('健康信息按需展开，新旧披露选择在实际 DOM 重建后都保持', () => {
  const h = harness(); h.render();
  for (const id of ['focusServiceHealth', 'focusProductHealth', 'overviewDiagnostics']) assert.equal(h.byId(id)!.open, false);
  assert.equal(h.byId('focusServiceHealth')!.parentElement?.className, 'focus-overview');
  assert.equal(h.root.querySelector('.overview-impact')!.closest('details')!.id, 'focusServiceHealth');
  assert.equal(h.root.querySelector('.north-star-panel')!.closest('details')!.id, 'focusProductHealth');
  assert.match(h.text(h.byId('focusProductHealth')!.querySelector('summary')!), /2 项指标 · 1 项需关注 · 1 项待确认/);
  const oldService = h.byId('focusServiceHealth');
  h.byId('focusServiceHealth')!.open = true; // A queued toggle is not required.
  h.toggle('focusProductHealth', true); h.toggle('overviewDiagnostics', true); h.render();
  assert.notEqual(h.byId('focusServiceHealth'), oldService);
  for (const id of ['focusServiceHealth', 'focusProductHealth', 'overviewDiagnostics']) assert.equal(h.byId(id)!.open, true);
  h.toggle('focusServiceHealth', false); h.render();
  assert.equal(h.byId('focusServiceHealth')!.open, false);
  assert.equal(h.byId('focusProductHealth')!.open, true);
  const zero = h.root.querySelector('.north-star-card')!;
  assert.match(h.text(zero), /0\.0%/); assert.ok(zero.classList.contains('target-miss'));
});

test('行动队列的待审批和错误保持首层，空队列独立于健康披露', () => {
  const h = harness(); h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewSecondary');
  assert.equal(h.byId('actionLoopMount')!.closest('.focus-overview'), null);
  h.state.actions = [{ id: 'review', status: 'pending_approval', type: 'investigate', title: '<img src=x onerror=alert(1)>', evidenceRefs: ['check:agent-runtime'], createdAt: new Date(NOW).toISOString() }];
  h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
  assert.equal(h.byId('actionLoopMount')!.closest('details'), null);
  assert.match(h.text(h.root.querySelector('.action-loop-card')!), /<img src=x onerror=alert\(1\)>/);
  h.state.actions = null;
  Object.assign(h.state.actionLoop!, { actions: [], error: '请求返回 503', loaded: true }); h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
  assert.match(h.text(h.byId('actionLoopPanel')!.querySelector('[role="alert"]')!), /503/);
  assert.deepEqual(h.htmlWrites, []);
});

test('全部事故与行动排在指标前，独立行动刷新也维持顺序', () => {
  const h = harness();
  h.state.overview.incidents = Array.from({ length: 5 }, (_, i) => ({ key: 'alert-' + i, title: '事故 ' + i, status: 'open', severity: i === 4 ? 'critical' : 'warning', summary: '需要处置', firstSeenAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), occurrences: 1 }));
  h.state.actions = [{ id: 'review', status: 'pending_approval', type: 'investigate', title: '待审核行动', evidenceRefs: [], createdAt: new Date(NOW).toISOString() }];
  h.render();
  const primary = h.byId('overviewPrimary')!;
  const metrics = primary.querySelector('.overview-metrics')!;
  const incidents = primary.querySelector('.overview-active-incidents')!;
  const mount = h.byId('actionLoopMount')!;
  assert.equal(primary.querySelectorAll('.overview-incident-row').length, 5);
  assert.ok(primary.children.indexOf(incidents) < primary.children.indexOf(metrics));
  assert.ok(primary.children.indexOf(mount) < primary.children.indexOf(metrics));
  h.state.actions = []; h.render();
  Object.assign(h.state.actionLoop!, { actions: [], error: '异步请求失败 503', loaded: true });
  vm.runInContext('renderActionLoopMount()', h.context);
  const refreshedPrimary = h.byId('overviewPrimary')!;
  assert.equal(h.byId('actionLoopMount')!.parentElement, refreshedPrimary);
  assert.equal(refreshedPrimary.lastElementChild?.classList.contains('overview-metrics'), true);
  assert.equal(h.byId('actionLoopMount')!.closest('details'), null);
});

test('折叠摘要保留过期与样本不足，不把未知产品状态写成健康', () => {
  const h = harness();
  h.state.overview.checks[0].status = 'stale';
  h.state.overview.checks[1].status = 'stale';
  h.render();
  const service = h.text(h.byId('focusServiceHealth')!.querySelector('summary')!);
  const product = h.text(h.byId('focusProductHealth')!.querySelector('summary')!);
  assert.match(service, /1 项待确认/);
  assert.match(product, /2 项待确认/); assert.doesNotMatch(product, /正常|全部健康/);
  const cards = h.root.querySelectorAll('.north-star-card');
  assert.ok(cards.every(card => card.classList.contains('unknown')));
});

for (const suffix of [';快照已 18h 未刷新', ';快照刷新失败(数据库不可达)']) {
  test('产品旧快照提示 ' + suffix + ' 在首层保留数值并标为待确认，刷新恢复后才显示正常', () => {
    const h = harness();
    const check = h.state.overview.checks[1];
    h.state.overview.checks = [check];
    check.summary = '当前 95.0% · 样本 100 · 产品目标 ≥ 80%' + suffix;
    h.render();
    assert.match(h.text(h.byId('focusProductHealth')!.querySelector('summary')!), /1 项指标 · 1 项待确认/);
    const card = h.root.querySelector('.north-star-card')!;
    assert.equal(card.querySelector('.status-chip')!.textContent, '快照过期');
    assert.equal(card.querySelector('.north-star-value')!.textContent, '95.0%');
    assert.ok(card.classList.contains('unknown'));
    assert.ok(!card.classList.contains('healthy'));
    assert.ok(!card.classList.contains('target-miss'));
    assert.match(h.text(h.byId('overviewProductHealthDetails')!), /快照已 18h 未刷新|快照刷新失败/);
    h.toggle('focusProductHealth', true);
    check.summary = '当前 95.0% · 样本 100 · 产品目标 ≥ 80%';
    h.render();
    assert.equal(h.byId('focusProductHealth')!.open, true);
    assert.doesNotMatch(h.text(h.byId('focusProductHealth')!.querySelector('summary')!), /待确认/);
    const refreshed = h.root.querySelector('.north-star-card')!;
    assert.equal(refreshed.querySelector('.status-chip')!.textContent, '正常');
    assert.equal(refreshed.querySelector('.north-star-value')!.textContent, '95.0%');
    assert.ok(refreshed.classList.contains('healthy'));
  });
}

test('旧快照中不可用的指标保持未知，不能把摘要里的目标值显示成观测值', () => {
  const h = harness();
  const check = h.state.overview.checks[1];
  h.state.overview.checks = [check];
  check.status = 'unknown';
  check.summary = '首次成功率 - · 产品目标 ≥ 80%;快照刷新失败;指标当前不可用,暂不评估';
  h.render();
  const card = h.root.querySelector('.north-star-card')!;
  assert.equal(card.querySelector('.status-chip')!.textContent, '快照过期');
  assert.equal(card.querySelector('.north-star-value')!.textContent, '—');
  assert.ok(card.classList.contains('unknown'));
  assert.match(h.text(h.byId('focusProductHealth')!.querySelector('summary')!), /1 项待确认/);
});

test('产品无快照时只需一次展开，有数据后保留相同外层披露选择', () => {
  const h = harness(); const checks = [...h.state.overview.checks];
  h.state.overview.checks = checks.filter(check => !check.key.startsWith('north-star-')); h.render();
  assert.equal(h.byId('focusProductHealth')!.open, false);
  assert.equal(h.byId('overviewProductHealthEmpty')!.open, true);
  assert.ok(h.byId('overviewProductHealthEmpty')!.classList.contains('focus-inline-empty'));
  h.toggle('focusProductHealth', true); h.state.overview.checks = checks; h.render();
  assert.equal(h.byId('focusProductHealth')!.open, true);
  assert.equal(h.byId('overviewProductHealthEmpty'), null);
});

test('新导航分组复用真实路由解析，旧别名与平台高亮继续可用', () => {
  const h = harness();
  for (const view of ['overview', 'alerts/center', 'traces', 'signals', 'devices']) assert.equal(h.navGroupByView[view], undefined);
  assert.equal(h.moduleNavKey['platform/model-pool'], 'platform');
  for (const [request, group] of [['investigate', 'data'], ['signals/panels', 'data'], ['learning', 'data'], ['postgres', 'infra'], ['rules', 'advanced'], ['model-pool', 'advanced']] as const) {
    vm.runInContext('setView(' + JSON.stringify(request) + ',false)', h.context);
    assert.equal(h.groups.find(node => node.open)?.dataset.navGroup, group);
  }
  vm.runInContext('setView("signals",false)', h.context);
  assert.equal(h.groups.some(node => node.open), false);
  assert.equal(h.viewCalls.every(call => call.updateHash === false), true);
});

test('页头操作按当前任务显示，保留权限隐藏和刷新失败状态', () => {
  const h = harness(); const checks = h.byId('runChecks')!; const incident = h.byId('globalIncidentFact')!; const options = h.byId('workspaceOptions')!;
  assert.ok(incident.classList.contains('focus-context-hidden'));
  assert.ok(!checks.classList.contains('focus-context-hidden'));
  checks.classList.add('hidden'); checks.hidden = true;
  const fresh = h.byId('fresh')!; fresh.textContent = '刷新失败：请重试';
  vm.runInContext('setView("traces",false)', h.context);
  assert.ok(!incident.classList.contains('focus-context-hidden'));
  assert.ok(checks.classList.contains('focus-context-hidden'));
  assert.ok(options.classList.contains('focus-context-hidden'));
  vm.runInContext('setView("platform/probing",false)', h.context);
  assert.ok(!checks.classList.contains('focus-context-hidden'));
  assert.ok(!options.classList.contains('focus-context-hidden'));
  assert.ok(checks.classList.contains('hidden')); assert.equal(checks.hidden, true);
  vm.runInContext('setView("platform/model-pool",false)', h.context);
  assert.ok(checks.classList.contains('focus-context-hidden'));
  vm.runInContext('setView("overview",false)', h.context);
  assert.equal(h.byId('pageTitle')!.textContent, '总览');
  assert.equal(fresh.textContent, '刷新失败：请重试');
});
