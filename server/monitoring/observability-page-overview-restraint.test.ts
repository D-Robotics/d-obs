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
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW_RESTRAINT } from './observability-page-overview-restraint.js';
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

function harness(mode: 'platform' | 'tenant' | 'member' = 'platform') {
  const htmlWrites: unknown[] = [];
  const requests: string[] = [];
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
    opsTenantMode: mode === 'tenant', opsMemberMode: mode === 'member', loadAll: async () => {}, renderCopilotAnalysis() {},
    base: '/dobs', contextRequestHeaders: () => ({}), apiHeaders: () => ({}), friendlyError: (value: unknown) => String(value),
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, actions: [], stats: [] }) }; },
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
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_UI + '\n' + productionLines.join('\n') + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_HIERARCHY + '\n' + OPS_OBSERVABILITY_SCRIPT_FOCUS + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW_RESTRAINT, context);
  const text = (node: DomNode): string => [node.textContent, ...node.children.map(text)].join(' ');
  const render = () => { vm.runInContext('renderOverview()', context); assert.deepEqual(htmlWrites, []); };
  const toggle = (id: string, open: boolean) => { const node = byId(id)!; node.open = open; node.dispatch('toggle'); documentListeners.get('toggle')?.({ target: node }); };
  return { state, context, root, byId, groups, navGroupByView, moduleNavKey, viewMeta, viewCalls, text, render, toggle, htmlWrites, requests };
}

const action = (id: string, status: string) => ({ id, status, type: 'investigate', title: id,
  evidenceRefs: ['check:agent-runtime'], createdAt: new Date(NOW).toISOString() });

test('正常总览只展开当前状态，支持指标和空行动各占一条按需入口', () => {
  const h = harness(); h.render();
  const primary = h.byId('overviewPrimary')!;
  assert.equal(primary.querySelector('.overview-metrics'), null);
  assert.equal(primary.querySelector('.overview-status')!.closest('details'), null);
  const metrics = h.byId('overviewSupportingMetrics')!;
  assert.equal(metrics.open, false);
  assert.equal(metrics.querySelectorAll('.metric').length, 4);
  const empty = h.byId('actionLoopEmptyDetails')!;
  assert.equal(empty.open, false);
  assert.equal(h.text(empty.querySelector('summary')!), ' 当前无待处理行动');
  assert.equal(h.root.querySelectorAll('.action-loop-flow').length, 0);
  assert.ok(h.byId('overviewPrimaryHeading'));
  assert.ok(primary.querySelector('.overview-group-head')!.classList.contains('sr-only'));
  assert.equal(h.byId('actionLoopPanel')!.closest('details'), empty);
});

test('事故和真实错误先于支持指标，事故处置监听仍能打开原始工作台', () => {
  const h = harness();
  h.state.overview.incidents = [{ key: 'alert-1', title: '生产故障', status: 'open', severity: 'critical',
    summary: '接口失败', firstSeenAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), occurrences: 1 }];
  h.state.overview.summary.openIncidents = 1;
  h.state.overview.ai.errors = 2;
  h.state.overview.signals.api5xx = 3;
  h.state.overview.signals.toolFailures = 1;
  h.render();
  const primary = h.byId('overviewPrimary')!;
  const errors = primary.querySelector('.overview-metrics')!;
  assert.equal(errors.querySelectorAll('.metric').length, 3);
  assert.equal(errors.closest('details'), null);
  assert.match(h.text(errors), /AI 完成率|工具失败|系统错误/);
  const support = h.byId('overviewSupportingMetrics')!;
  assert.equal(support.querySelectorAll('.metric').length, 1);
  assert.match(h.text(support), /进行中告警/);
  const incidents = primary.querySelector('.overview-active-incidents')!;
  assert.ok(primary.children.indexOf(incidents) < primary.children.indexOf(errors));
  incidents.querySelector('button')!.dispatch('click');
  assert.equal(h.byId('overviewDiagnostics')!.open, true);
});

test('混合队列只首层展示待审批、执行、失败和未知，历史卡的原有控件保留', () => {
  const h = harness();
  h.state.actions = ['pending_approval','approved','executing','failed','verification_failed','unrecognized','completed','denied','succeeded']
    .map(status => action(status, status));
  h.render();
  const primary = h.byId('overviewPrimary')!;
  const cards = primary.querySelectorAll('.action-loop-card');
  const current = cards.filter(card => !card.closest('details'));
  assert.deepEqual(current.map(card => card.dataset.status), ['pending_approval','approved','executing','failed','verification_failed','unrecognized']);
  const history = h.byId('actionLoopDetails')!;
  assert.equal(history.open, false);
  assert.equal(history.querySelectorAll('.action-loop-card').length, 3);
  assert.ok(history.querySelector('.action-loop-card')!.querySelector('button'));
  assert.equal(h.byId('actionLoopPanel')!.closest('details'), null);
  assert.equal(h.byId('actionLoopMount')!.parentElement, primary);
  assert.equal(h.byId('actionLoopMutationError'), null);
  assert.ok(primary.querySelectorAll('[role="alert"]').some(node => /后置验证未通过/.test(h.text(node))));
});

test('只有已结束的行动归入一条记录入口，失败队列仍在首层', () => {
  const h = harness();
  h.state.actions = [action('completed','completed'), action('denied','denied'), action('succeeded','succeeded')]; h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewSecondary');
  assert.equal(h.byId('actionLoopPanel')!.closest('details')?.id, 'actionLoopEmptyDetails');
  assert.match(h.text(h.byId('actionLoopEmptyDetails')!.querySelector('summary')!), /当前无待处理行动 · 3 条记录/);
  h.state.actions = [action('failed','failed')]; h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
  assert.equal(h.root.querySelector('.action-loop-card')!.closest('details'), null);
});

test('全量刷新和独立行动刷新保持每个披露选择，不串用记录与指标状态', () => {
  const h = harness(); h.render();
  h.byId('overviewSupportingMetrics')!.open = true;
  h.toggle('actionLoopEmptyDetails', true);
  h.toggle('focusProductHealth', true);
  h.render();
  assert.equal(h.byId('overviewSupportingMetrics')!.open, true);
  assert.equal(h.byId('actionLoopEmptyDetails')!.open, true);
  assert.equal(h.byId('focusProductHealth')!.open, true);
  h.state.actions = [action('review','pending_approval')]; h.render();
  assert.equal(h.byId('actionLoopDetails')!.open, false);
  h.byId('actionLoopDetails')!.open = true;
  vm.runInContext('renderActionLoopMount()', h.context);
  assert.equal(h.byId('actionLoopDetails')!.open, true);
  assert.equal(h.byId('overviewSupportingMetrics')!.open, true);
  h.state.actions = []; h.render();
  assert.equal(h.byId('actionLoopEmptyDetails')!.open, true);
  const ids = h.root.querySelectorAll('[id]').map(node => node.id);
  assert.equal(ids.length, new Set(ids).size);
});

for (const change of [{ error: '读取失败 HTTP 503' }, { mutationError: '审批提交失败' }, { loading: true }, { loaded: false }]) {
  test('队列读取/提交/未知状态保持首层：' + JSON.stringify(change), () => {
    const h = harness(); h.render();
    Object.assign(h.state.actionLoop!, change);
    vm.runInContext('renderActionLoopMount()', h.context);
    assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
    assert.equal(h.byId('actionLoopPanel')!.closest('details'), null);
    if ('error' in change) assert.match(h.text(h.byId('actionLoopPanel')!), /读取失败 HTTP 503/);
    if ('mutationError' in change) assert.match(h.text(h.byId('actionLoopMutationError')!), /审批提交失败/);
    if ('loading' in change) assert.equal(h.byId('actionLoopPanel')!.querySelector('[role="status"]')!.closest('details'), null);
    if ('loaded' in change) {
      assert.match(h.text(h.byId('actionLoopPanel')!.querySelector('[role="status"]')!), /尚未确认/);
      assert.equal(h.byId('actionLoopPanel')!.querySelector('.action-loop-empty'), null);
    }
  });
}

test('折叠中的原始刷新按钮真实重读行动 API 并恢复原入口选择', async () => {
  const h = harness(); h.render();
  h.toggle('actionLoopEmptyDetails', true);
  h.toggle('overviewSupportingMetrics', true);
  const button = h.root.querySelector('.action-loop-refresh')!;
  const listener = button.listeners.get('click')![0];
  await listener({ target: button });
  assert.deepEqual(h.requests, ['/dobs/api/ops/observability/actions?limit=20']);
  assert.equal(h.state.actionLoop!.loaded, true);
  assert.equal(h.byId('actionLoopEmptyDetails')!.open, true);
  assert.equal(h.byId('overviewSupportingMetrics')!.open, true);
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewSecondary');
});

test('巡检过期、产品未知和 AI 无样本都在折叠前可确认', () => {
  const h = harness();
  h.state.overview.alerting.lastCheckedAt = new Date(NOW - 10 * 60_000).toISOString();
  h.state.overview.checks[0].status = 'stale';
  h.state.overview.ai.total = 0;
  h.render();
  assert.match(h.text(h.root.querySelector('.overview-status')!), /巡检数据待确认/);
  assert.match(h.text(h.byId('focusServiceHealth')!.querySelector('summary')!), /1 项待确认/);
  assert.match(h.text(h.byId('focusProductHealth')!.querySelector('summary')!), /1 项待确认/);
  assert.match(h.text(h.byId('overviewSupportingMetrics')!.querySelector('summary')!), /1 项暂无样本/);
});

for (const mode of ['tenant','member'] as const) {
  test(mode + '身份不会因为收敛层重新挂载平台行动队列', () => {
    const h = harness(mode); h.render();
    assert.equal(h.byId('actionLoopMount'), null);
    assert.equal(h.byId('actionLoopPanel'), null);
    assert.equal(h.byId('overviewSupportingMetrics')!.open, false);
    assert.deepEqual(h.htmlWrites, []);
  });
}
