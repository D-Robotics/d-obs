/** Execute the actual renderers and tab enhancement against a small DOM model.
 * These assertions cover operator choices and panel state, not CSS geometry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW } from './observability-page-script-overview.js';
import { OPS_OBSERVABILITY_COCKPIT_SCRIPT } from './observability-page-cockpit.js';
import { OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import { OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT } from './observability-page-action-loop.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

const NOW = Date.parse('2026-10-10T03:00:00Z');
type DomEvent = { target: TestNode; key?: string; preventDefault(): void };

class TestNode {
  id = '';
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = {};
  children: TestNode[] = [];
  parentElement: TestNode | null = null;
  hidden = false;
  disabled = false;
  open = false;
  tabIndex = 0;
  type = '';
  value = '';
  title = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: DomEvent) => void>>();
  private classes = new Set<string>();
  scrollCalls = 0;
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const selected = force ?? !this.classes.has(name);
      if (selected) this.classes.add(name); else this.classes.delete(name);
      return selected;
    },
  };
  constructor(readonly tagName: string, private focusNode: (node: TestNode) => void, private recordHtmlWrite: (value: unknown) => void) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  set innerHTML(value: string) { this.recordHtmlWrite(value); throw new Error('safe-DOM renderer wrote innerHTML'); }
  get parentNode() { return this.parentElement; }
  get firstElementChild() { return this.children[0] ?? null; }
  appendChild(child: TestNode) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child: TestNode, before: TestNode | null) {
    child.remove(); const index = before ? this.children.indexOf(before) : -1;
    child.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, child); return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  replaceChildren(...nodes: TestNode[]) { [...this.children].forEach(node => node.remove()); nodes.forEach(node => this.appendChild(node)); }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'title') this.title = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return name === 'id' ? this.id || null : this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; if (name === 'title') this.title = ''; }
  addEventListener(name: string, listener: (event: DomEvent) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  dispatch(name: string, event: DomEvent = { target: this, preventDefault() {} }) { this.listeners.get(name)?.forEach(listener => listener(event)); }
  click() { this.dispatch('click'); }
  focus() { this.focusNode(this); }
  scrollIntoView() { this.scrollCalls += 1; }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const match = selector.match(/^([a-z]+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (match) {
      if (match[1] && this.tagName !== match[1].toUpperCase()) return false;
      const value = this.getAttribute(match[2]); return match[3] == null ? value != null : value === match[3];
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector: string): TestNode[] { return this.children.flatMap(child => [child, ...child.descendants()]).filter(node => node.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): TestNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  private descendants(): TestNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function snapshot(patch: Record<string, unknown> = {}) {
  return {
    alerting: { status: 'healthy', lastCheckedAt: new Date(NOW).toISOString(), shadowMode: false, webhookConfigured: true },
    summary: { totalChecks: 2, healthyChecks: 2, disabledChecks: 0, openIncidents: 0, criticalIncidents: 0 },
    ai: { total: 40, successRate: 1, errors: 0 },
    signals: { toolFailures: 0, clientErrors: 0, api5xx: 0, processErrors: 0, loginInfrastructureErrors: 0, totalEvents: 40 },
    windowHours: 24, tenantScope: null as string | null, incidents: [], checks: [], events: [], notifications: [], incidentActivity: [], configurationAudit: [],
    ...patch,
  };
}

function harness(overview = snapshot(), includeActionLoop = false) {
  const htmlWrites: unknown[] = [];
  let activeElement: TestNode | null = null;
  const make = (tag: string, className = '', text = '') => {
    const node = new TestNode(tag.toUpperCase(), value => { activeElement = value; }, value => htmlWrites.push(value));
    node.className = className; node.textContent = String(text ?? ''); return node;
  };
  const add = (parent: TestNode, tag: string, className = '', text = '') => parent.appendChild(make(tag, className, text));
  const body = make('body');
  const root = add(body, 'div'); root.id = 'overviewContent';
  const fresh = add(body, 'span'); fresh.id = 'fresh';
  const byId = (id: string) => body.querySelector('#' + id);
  const state: {
    overview: ReturnType<typeof snapshot>; actions: unknown[] | null; remediation: null;
    actionLoop?: { actions: unknown[]; stats: unknown[]; loading: boolean; loaded: boolean; error: string; mutationError: string; busyId: string; accessDenied: boolean };
  } = { overview, actions: [], remediation: null };
  let loadText = '';
  let loadResult: unknown = { ok: true };
  let loadError: Error | null = null;
  const loadCalls: Array<boolean | undefined> = [];
  const docListeners = new Map<string, (event: DomEvent) => void>();
  const viewCalls: Array<{ requested: string; updateHash: boolean }> = [];
  const modules = ['traces/runs', 'traces/session'];
  const view = add(body, 'section', 'view'); view.id = 'view-traces';
  const list = add(view, 'div', 'module-switcher'); list.setAttribute('role', 'tablist');
  const tabs = modules.map((key, index) => {
    const tab = add(list, 'button', 'module-switch-tab'); tab.setAttribute('role', 'tab'); tab.setAttribute('data-module-tab', key); tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    tab.addEventListener('click', () => vm.runInContext('setView(' + JSON.stringify(key) + ')', context)); return tab;
  });
  const panels = modules.map(key => { const panel = add(view, 'div'); panel.setAttribute('data-view-module', key); return panel; });
  // Preserve explicit page IDs as well as assigning IDs to anonymous tabs/panels.
  tabs[0].id = 'existing-run-tab'; panels[0].id = 'existing-run-panel';
  const document = {
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener: (name: string, listener: (event: DomEvent) => void) => docListeners.set(name, listener),
    createElement: make,
  };
  class Clock extends Date { static now() { return NOW; } }
  const context = vm.createContext({
    document, state, make, add, $: byId, Date: Clock,
    fmt: (value: unknown) => String(Number(value) || 0),
    pct: (value: unknown) => (Number(value) * 100).toFixed(1) + '%',
    when: (value: unknown) => String(value || '—'),
    statusNames: { open: '待确认', acknowledged: '已确认', silenced: '已静默', healthy: '正常' },
    severityNames: { critical: '严重', warning: '警告' }, outcomeNames: {},
    overviewChecks: (value: { checks?: unknown[] }) => value.checks || [],
    overviewNumber: (value: unknown) => Number(value) || 0,
    opsTenantMode: Boolean(overview.tenantScope), opsMemberMode: false,
    renderCopilotAnalysis() {},
    async loadAll(manual?: boolean) { loadCalls.push(manual); fresh.textContent = loadText; if (loadError) throw loadError; return loadResult; },
    section: (title: string, hint: string) => { const panel = make('section', 'panel section'); const head = add(panel, 'div', 'section-head'); add(head, 'h2', '', title); add(head, 'p', 'hint', hint); return panel; },
    setView(requested: string, updateHash = true) { viewCalls.push({ requested, updateHash }); vm.runInContext('applyViewModules("traces",' + JSON.stringify(requested) + ')', context); },
  });
  // Use production panel activation rather than duplicating the routing behavior.
  const applyModules = OPS_OBSERVABILITY_SCRIPT_A.split('\n').find(line => line.includes('function applyViewModules('));
  assert.ok(applyModules, 'actual panel activation must be available');
  vm.runInContext(applyModules + '\n' + OPS_OBSERVABILITY_SCRIPT_UI + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + (includeActionLoop ? OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' : '') + OPS_OBSERVABILITY_SCRIPT_HIERARCHY, context);
  const text = (node: TestNode): string => [node.textContent, ...node.children.map(text)].join(' ');
  const render = () => { vm.runInContext('renderOverview()', context); assert.deepEqual(htmlWrites, []); };
  const key = (target: TestNode, value: string) => { let prevented = false; list.dispatch('keydown', { target, key: value, preventDefault() { prevented = true; } }); return prevented; };
  const toggle = (node: TestNode, open: boolean) => { node.open = open; const event = { target: node, preventDefault() {} }; node.dispatch('toggle', event); docListeners.get('toggle')?.(event); };
  const setLoad = (text: string, result: unknown = loadResult, error: Error | null = null) => { loadText = text; loadResult = result; loadError = error; };
  return { body, root, fresh, state, view, list, tabs, panels, context, byId, add, text, render, key, toggle, setLoad, loadCalls, htmlWrites, viewCalls, active: () => activeElement };
}

function assertActive(h: ReturnType<typeof harness>, index: number) {
  h.tabs.forEach((tab, i) => {
    assert.equal(tab.getAttribute('aria-selected'), String(i === index));
    assert.equal(tab.tabIndex, i === index ? 0 : -1, 'only the selected tab belongs in the Tab sequence');
    assert.equal(tab.getAttribute('aria-controls'), h.panels[i].id);
    assert.equal(h.panels[i].getAttribute('aria-labelledby'), tab.id);
    assert.equal(h.panels[i].hidden, i !== index, 'inactive content must actually be hidden');
    assert.equal(h.panels[i].classList.contains('is-active'), i === index);
  });
  assert.deepEqual(h.htmlWrites, []);
}

test('子模块键盘箭头、Home、End 激活真实面板，循环焦点并维护唯一 Tab 入口', () => {
  const h = harness();
  vm.runInContext('setView("traces/runs",false)', h.context);
  assertActive(h, 0);
  assert.equal(h.tabs[0].id, 'existing-run-tab');
  assert.equal(h.panels[0].id, 'existing-run-panel');
  const label = h.add(h.tabs[0], 'small', '', '运行说明');
  assert.equal(h.key(label, 'ArrowRight'), true, 'nested tab label must route through its tab');
  assertActive(h, 1); assert.equal(h.active(), h.tabs[1]);
  h.key(h.tabs[1], 'End'); assertActive(h, 1);
  h.key(h.tabs[1], 'ArrowRight'); assertActive(h, 0);
  h.key(h.tabs[0], 'ArrowLeft'); assertActive(h, 1);
  h.key(h.tabs[1], 'Home'); assertActive(h, 0);
  assert.ok(h.tabs.every(tab => tab.scrollCalls > 0), 'keyboard selection scrolls each destination into view');
  assert.equal(h.viewCalls[0].updateHash, false, 'enhancement preserves the base router arguments');
});

test('子模块键盘跳过禁用或隐藏入口，普通键和非 tab 目标不触发导航', () => {
  const h = harness();
  vm.runInContext('setView("traces/runs",false)', h.context);
  h.tabs[1].disabled = true;
  h.key(h.tabs[0], 'ArrowRight'); assertActive(h, 0);
  h.tabs[1].disabled = false; h.tabs[1].hidden = true;
  h.key(h.tabs[0], 'ArrowRight'); assertActive(h, 0);
  const calls = h.viewCalls.length;
  assert.equal(h.key(h.tabs[0], 'PageDown'), false);
  assert.equal(h.key(h.list, 'ArrowRight'), false);
  assert.equal(h.viewCalls.length, calls);
  assertActive(h, 0);
});

test('实际页面所有子模块 tab 都有对应面板，新增键盘行为确实拼进页面', () => {
  const tabs = [...OPS_OBSERVABILITY_HTML.matchAll(/<button\b[^>]*data-module-tab="([^"]+)"[^>]*>/g)].map(match => match[1]);
  const panels = [...OPS_OBSERVABILITY_HTML.matchAll(/\bdata-view-module="([^"]+)"/g)].map(match => match[1]);
  assert.ok(tabs.length > 20);
  assert.equal(new Set(tabs).size, tabs.length);
  tabs.forEach(key => assert.equal(panels.filter(panel => panel === key).length, 1, 'tab must control exactly one panel: ' + key));
  assert.ok(OPS_OBSERVABILITY_HTML.includes(OPS_OBSERVABILITY_SCRIPT_HIERARCHY));
});

test('总览刷新重建 DOM 后保留已展开与已收起的披露选择，初次查看默认收起', () => {
  const h = harness(); h.render();
  const first = h.byId('overviewDiagnostics')!;
  const product = h.byId('overviewProductHealthEmpty')!;
  assert.equal(first.open, false); assert.equal(product.open, false);
  // Programmatic opening must survive even before a queued native toggle event.
  first.open = true; h.toggle(product, true); h.render();
  assert.notEqual(h.byId('overviewDiagnostics'), first, 'test must exercise an actual rebuilt renderer tree');
  assert.equal(h.byId('overviewDiagnostics')!.open, true);
  assert.equal(h.byId('overviewProductHealthEmpty')!.open, true);
  h.toggle(h.byId('overviewDiagnostics')!, false); h.render();
  assert.equal(h.byId('overviewDiagnostics')!.open, false);
  assert.equal(h.byId('overviewProductHealthEmpty')!.open, true, 'closing one disclosure leaves other operator choices intact');
});

test('缺失、过期或零检查快照不能呈现健康；只有新鲜有效快照显示正常', () => {
  for (const patch of [
    { alerting: { status: 'healthy', lastCheckedAt: null, webhookConfigured: true } },
    { alerting: { status: 'healthy', lastCheckedAt: 'invalid', webhookConfigured: true } },
    { alerting: { status: 'healthy', lastCheckedAt: new Date(NOW - 6 * 60000).toISOString(), webhookConfigured: true } },
    { alerting: { status: 'stale', lastCheckedAt: new Date(NOW).toISOString(), webhookConfigured: true } },
    { summary: { totalChecks: 0, healthyChecks: 0, disabledChecks: 0, openIncidents: 0 } },
  ]) {
    const h = harness(snapshot(patch)); h.render();
    const hero = h.root.querySelector('.overview-status')!;
    assert.ok(hero.classList.contains('stale'));
    assert.match(h.text(hero), /巡检数据待确认/);
    assert.doesNotMatch(h.text(hero), /全部已启用检查正常/);
  }
  const fresh = harness(); fresh.render();
  const hero = fresh.root.querySelector('.overview-status')!;
  assert.ok(hero.classList.contains('healthy'));
  assert.match(fresh.text(hero), /全部已启用检查正常/);
});

test('所有进行中事故在首层可见，严重优先，展开处置定位实际事故而非丢进折叠区', () => {
  const incidents = Array.from({ length: 7 }, (_, i) => ({ key: 'alert-' + i, title: '待处置 ' + i, status: i === 6 ? 'resolved' : i === 5 ? 'silenced' : i % 2 ? 'acknowledged' : 'open', severity: i === 4 ? 'critical' : 'warning', summary: '证据摘要 ' + i, lastSeenAt: new Date(NOW - i * 60000).toISOString() }));
  const h = harness(snapshot({ incidents, summary: { totalChecks: 2, healthyChecks: 1, disabledChecks: 0, openIncidents: 6, criticalIncidents: 1 } })); h.render();
  const primary = h.byId('overviewPrimary')!;
  const visible = primary.querySelectorAll('.overview-incident-row');
  assert.equal(visible.length, 6, 'active incidents must not be truncated to the first three');
  assert.match(h.text(visible[0]), /待处置 4/);
  assert.doesNotMatch(h.text(primary), /待处置 6/);
  visible[0].querySelector('button')!.click();
  assert.equal(h.byId('overviewDiagnostics')!.open, true);
  assert.equal(h.active()?.dataset.incidentKey, 'alert-4');
  h.render(); assert.equal(h.byId('overviewDiagnostics')!.open, true);
});

test('产品指标零值保留为零，stale 与样本不足不涂成正常状态', () => {
  const checks = [
    { key: 'north-star-skill-hit-rate', status: 'healthy', summary: '当前 0.0% · 样本 100 · 产品目标 ≥ 80%', checkedAt: new Date(NOW).toISOString() },
    { key: 'north-star-retention-d1', status: 'stale', summary: '当前 95.0% · 样本 100', checkedAt: new Date(NOW - 6 * 60000).toISOString() },
    { key: 'north-star-first-success-rate', status: 'unknown', summary: '样本不足', checkedAt: null },
  ];
  const h = harness(snapshot({ checks })); h.render();
  const cards = h.root.querySelectorAll('.north-star-card');
  assert.equal(cards.length, 3);
  assert.match(h.text(cards[0]), /0\.0%/);
  assert.ok(cards[0].classList.contains('target-miss'));
  for (const card of cards.slice(1)) { assert.ok(card.classList.contains('unknown')); assert.ok(!card.classList.contains('healthy')); assert.match(h.text(card), /—/); }
});

test('租户总览保留本租户事件，隔离平台配置审计与通知投递，即使响应含这些字段', () => {
  const payload = {
    tenantScope: 'preview-team',
    events: [{ occurredAt: '2026-10-10', component: 'tenant-source', eventCode: 'tenant-event', outcome: 'success', summary: '<tenant evidence>' }],
    configurationAudit: [{ occurredAt: '2026-10-10', actor: 'platform-admin', action: 'save', summary: 'platform-audit-secret-marker' }],
    notifications: [{ occurredAt: '2026-10-10', alertKey: 'platform-alert', transition: 'open', channel: 'platform-notification-secret-marker', delivered: true }],
  };
  const tenant = harness(snapshot(payload)); tenant.render();
  assert.match(tenant.text(tenant.root), /<tenant evidence>/);
  assert.doesNotMatch(tenant.text(tenant.root), /platform-audit-secret-marker|platform-notification-secret-marker/);
  const admin = harness(snapshot({ ...payload, tenantScope: null })); admin.render();
  assert.match(admin.text(admin.root), /platform-audit-secret-marker/);
  assert.match(admin.text(admin.root), /platform-notification-secret-marker/);
  assert.deepEqual(tenant.htmlWrites, []); assert.deepEqual(admin.htmlWrites, []);
});

test('刷新状态只缩短成功摘要并保留完整语义，后续失败不能残留旧的成功辅助标签', async () => {
  const h = harness();
  const full = '每分钟评估 · 最近检查 2026/10/10 11:00 · 配置更新 2026/10/10 10:00';
  const result = { marker: 'base-load-return' };
  h.setLoad(full, result);
  assert.equal(await vm.runInContext('loadAll(true)', h.context), result);
  assert.deepEqual(h.loadCalls, [true]);
  assert.equal(h.fresh.textContent, '最近评估 ' + h.state.overview.alerting.lastCheckedAt);
  assert.equal(h.fresh.title, full); assert.equal(h.fresh.getAttribute('aria-label'), full);
  const failed = '刷新失败：总览数据暂不可用，可点击刷新重试';
  h.setLoad(failed);
  await vm.runInContext('loadAll(false)', h.context);
  assert.equal(h.fresh.textContent, failed, 'failure guidance remains visible');
  assert.notEqual(h.fresh.getAttribute('aria-label'), full, 'screen readers must not read the previous successful state');
  assert.notEqual(h.fresh.title, full, 'the tooltip must not contradict the visible failure');
  const thrown = new Error('base-load-rejected'); h.setLoad(failed, result, thrown);
  await assert.rejects(vm.runInContext('loadAll(true)', h.context), error => error === thrown);
  assert.deepEqual(h.htmlWrites, []);
});

test('行动闭环空队列在辅助层折叠，展开选择跨刷新保留；待审批和错误在运行首层可见', () => {
  const h = harness(snapshot(), true); h.render();
  const mount = h.byId('actionLoopMount')!;
  assert.equal(mount.parentElement?.id, 'overviewSecondary');
  const empty = h.byId('actionLoopEmptyDetails')!;
  assert.equal(empty.open, false); assert.match(h.text(empty), /当前无待处理行动/);
  h.toggle(empty, true); h.render();
  assert.equal(h.byId('actionLoopEmptyDetails')!.open, true);
  h.state.actions = [{ id: 'action-review', status: 'pending_approval', type: 'investigate', title: '<pending review>', rationale: '需要人工复核证据', createdAt: new Date(NOW).toISOString(), evidenceRefs: ['check:agent-runtime'] }];
  h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
  assert.equal(h.byId('actionLoopEmptyDetails'), null);
  const card = h.root.querySelector('.action-loop-card')!;
  assert.match(h.text(card), /<pending review>/); assert.match(h.text(card), /待审批/);
  assert.equal(card.querySelectorAll('button').filter(button => button.textContent === '批准').length, 1);
  h.state.actions = null;
  Object.assign(h.state.actionLoop!, { actions: [], error: '请求返回 503，请稍后重试', loaded: true });
  h.render();
  assert.equal(h.byId('actionLoopMount')!.parentElement?.id, 'overviewPrimary');
  assert.equal(h.byId('actionLoopEmptyDetails'), null);
  const error = h.byId('actionLoopPanel')!.querySelector('[role="alert"]')!;
  assert.match(h.text(error), /行动队列暂时不可用/); assert.match(h.text(error), /503/);
  assert.deepEqual(h.htmlWrites, []);
});
