/** Route the production navigation against nodes parsed from the real HTML shell.
 * Missing elements stay missing: unlike the interaction renderer harness, this
 * model cannot silently invent an element that the page no longer contains.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { integrateCollectionScriptA } from './observability-page-collection-integration.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_FOCUS } from './observability-page-focus.js';
import { OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';

type DomEvent = { target: ShellNode; key?: string; preventDefault(): void; stopPropagation(): void };
class ShellNode {
  children: ShellNode[] = [];
  parentElement: ShellNode | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = {};
  listeners = new Map<string, Array<(event: DomEvent) => unknown>>();
  hidden = false; disabled = false; open = false; selected = false; focused = false; value = ''; type = ''; title = ''; id = '';
  private text = '';
  private classes = new Set<string>();
  constructor(readonly tagName: string) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    contains: (value: string) => this.classes.has(value),
    add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
    remove: (...values: string[]) => values.forEach(value => this.classes.delete(value)),
    toggle: (value: string, force?: boolean) => { const active = force ?? !this.classes.has(value); if (active) this.classes.add(value); else this.classes.delete(value); return active; },
  };
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.replaceChildren(); }
  appendText(value: string) { this.text += value; }
  set innerHTML(_value: string) { throw new Error('navigation must not write HTML from dynamic values'); }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentNode() { return this.parentElement; }
  appendChild(node: ShellNode) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceChildren(...nodes: ShellNode[]) { [...this.children].forEach(node => node.remove()); nodes.forEach(node => this.appendChild(node)); }
  setAttribute(key: string, value: unknown) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'hidden') this.hidden = true;
    if (key === 'open') this.open = true;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = String(value);
  }
  getAttribute(key: string) { if (key === 'id') return this.id || null; if (key === 'class') return this.className || null; return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); if (key === 'hidden') this.hidden = false; }
  addEventListener(type: string, listener: (event: DomEvent) => unknown) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  async dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.focused = true; } scrollIntoView() {}
  contains(node: ShellNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)];
    const plain = selector.replace(/\[[^\]]*\]/g, '');
    const id = plain.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    const tag = plain.match(/^[a-z][\w-]*/i)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
    if ([...plain.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
    return attrs.every(([, key, op, expected]) => { const actual = this.getAttribute(key); return op === '=' ? actual === expected : op === '^=' ? actual?.startsWith(expected) : actual != null; });
  }
  closest(selector: string): ShellNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): ShellNode[] {
    const parts = selector.trim().split(/\s+(?![^[]*\])/);
    const leaf = parts.pop()!;
    const descendants = (node: ShellNode): ShellNode[] => node.children.flatMap(child => [child, ...descendants(child)]);
    return descendants(this).filter(node => {
      if (!node.matches(leaf)) return false;
      let ancestor = node.parentElement;
      for (const part of [...parts].reverse()) { while (ancestor && !ancestor.matches(part)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
      return true;
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function parseShell() {
  const html = OPS_OBSERVABILITY_HTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = new ShellNode('ROOT'); const stack = [root];
  const voids = new Set(['INPUT', 'BR', 'HR', 'META', 'LINK', 'IMG', 'AREA', 'BASE', 'COL', 'EMBED', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  for (const token of html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>|([^<]+)/gi)) {
    if (token[3]) { stack.at(-1)!.appendText(token[3]); continue; }
    const tag = token[1].toUpperCase();
    if (token[0].startsWith('</')) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const node = new ShellNode(tag);
    for (const attribute of token[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    stack.at(-1)!.appendChild(node); if (!voids.has(tag) && !token[0].endsWith('/>')) stack.push(node);
  }
  return root;
}

function setup(options: { tenantToken?: string; session?: string; tenant?: string } = {}) {
  const shell = parseShell(); const body = shell.querySelector('body')!; const html = shell.querySelector('html')!;
  const storage = new Map<string, string>();
  if (options.tenantToken) storage.set('d_obs_tenant_token', options.tenantToken);
  if (options.session) storage.set('d_obs_sso_session', options.session);
  if (options.tenant) storage.set('d_obs_active_tenant', options.tenant);
  const calls: string[] = []; const renders: string[] = []; let reloads = 0;
  const documentListeners = new Map<string, Array<(event: DomEvent) => unknown>>();
  const document = { body, documentElement: html, title: '', addEventListener: (type: string, listener: (event: DomEvent) => unknown) => documentListeners.set(type, [...documentListeners.get(type) ?? [], listener]), createElement: (tag: string) => new ShellNode(tag.toUpperCase()), createTextNode: (value: string) => { const node = new ShellNode('TEXT'); node.textContent = value; return node; }, getElementById: (id: string) => shell.querySelector('#' + id), querySelector: (selector: string) => shell.querySelector(selector), querySelectorAll: (selector: string) => shell.querySelectorAll(selector) };
  const context = vm.createContext({
    document, window: {}, location: { pathname: '/ops-observability', href: 'http://localhost/ops-observability#overview', reload() { reloads += 1; } }, history: { replaceState() {} },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key) },
    localStorage: { getItem: () => null, setItem() {} }, URL, console: { warn() {} },
    fetch: async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    setTimeout: () => 0, clearTimeout() {}, markRender: (name: string) => renders.push(name),
  });
  const accountStart = OPS_OBSERVABILITY_SCRIPT_C.indexOf('function renderObsAccountBar(');
  const pruneStart = OPS_OBSERVABILITY_SCRIPT_C.indexOf('function pruneMemberNav(');
  const pruneEnd = OPS_OBSERVABILITY_SCRIPT_C.indexOf('function renderObsNoTenantScreen(', pruneStart);
  assert.ok(accountStart >= 0 && pruneStart > accountStart && pruneEnd > pruneStart);
  const dataStubs = ['renderRules', 'renderChannels', 'renderSettings', 'renderEvolution', 'renderServiceLevels', 'bindTenantPanel', 'loadTenants', 'loadIncidentCenter', 'renderObjects', 'renderMetrics'];
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_UI + '\n' + integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A) + '\n' + OPS_OBSERVABILITY_SCRIPT_C.slice(accountStart, pruneEnd) + '\n' + dataStubs.map(name => 'function ' + name + '(){markRender(' + JSON.stringify(name) + ')}').join('\n') + '\nfunction renderOverview(){}\nfunction renderActionLoopMount(){}\nasync function loadAll(){}\n' + OPS_OBSERVABILITY_SCRIPT_HIERARCHY + '\n' + OPS_OBSERVABILITY_SCRIPT_FOCUS + `
    globalThis.hooks={setView,setDomain,setNavGroupAlerts,resolveViewRequest,renderObsAccountBar,pruneMemberNav,state,
      member:enabled=>{opsMemberMode=enabled}, identity:me=>{obsAuthState.me=me}};
  })();`, context);
  const hooks = context.hooks as {
    setView(view: string, updateHash?: boolean): void; setDomain(domain: string, navigate?: boolean): void;
    setNavGroupAlerts(overview: { incidents: Array<{ status: string }> }): void;
    resolveViewRequest(view: string): { name: string; source: string }; renderObsAccountBar(): void; pruneMemberNav(): void;
    member(enabled: boolean): void; identity(me: unknown): void; state: { view: string; viewSource: string; domain: string };
  };
  const dispatchDocument = async (type: string, target: ShellNode, key?: string) => { for (const listener of documentListeners.get(type) ?? []) await listener({ target, key, preventDefault() {}, stopPropagation() {} }); };
  return { shell, body, hooks, calls, renders, storage, dispatchDocument, byId: document.getElementById, reloads: () => reloads };
}

test('真实壳保留七个日常入口和三个分类菜单，每个强绑定 ID 唯一存在', () => {
  const shell = parseShell(); const primary = shell.querySelector('.nav-main')!;
  assert.deepEqual(primary.querySelectorAll('.module-tab[data-view]').map(node => node.dataset.view), ['overview', 'collection/tasks', 'data/assets', 'alerts/center', 'traces', 'signals', 'devices']);
  const groups = shell.querySelectorAll('.nav-group');
  assert.deepEqual(groups.map(node => node.dataset.navGroup), ['data', 'infra', 'advanced']);
  for (const group of groups) { assert.equal(group.tagName, 'DETAILS'); assert.equal(group.id, 'nav-group-' + group.dataset.navGroup); }
  assert.equal(shell.querySelectorAll('.global-nav').length, 0);
  const nav = shell.querySelector('.module-tabs')!; const keys = nav.querySelectorAll('.module-tab[data-view]').map(node => node.dataset.view);
  assert.equal(new Set(keys).size, keys.length, 'the shell must not duplicate daily entries inside secondary groups');
  const directBindings = [...OPS_OBSERVABILITY_SCRIPT_C.matchAll(/\$\('([^']+)'\)\.addEventListener\(/g)].map(match => match[1]);
  const required = new Set([...directBindings, 'globalSearchTrigger', 'themeToggle', 'headerTelemetryStatus', 'domainContext', 'overviewWindow', 'fresh', 'runChecks', 'runEvolution', 'ruleCount', 'evolutionCount', 'skillLoopCount', 'incidentCount', 'navReviewNotice']);
  for (const id of required) assert.equal(shell.querySelectorAll('#' + id).length, 1, 'real binding target must exist exactly once: ' + id);
  assert.equal(shell.querySelector('#runChecks')!.closest('details')?.id, 'workspaceOptions');
  assert.equal(shell.querySelector('#domainContext')!.tagName, 'SPAN');
  assert.equal(shell.querySelector('#domainSwitcher'), null);
});

test('主导航与更多入口按实际目标高亮，旧深链仍定位正确父级和真实面板', () => {
  const h = setup(); const groups = h.shell.querySelectorAll('.nav-group');
  const routes: Array<[string, string, string]> = [
    ['overview', 'overview', 'overview'], ['alerts', 'alerts/center', 'alerts/center'],
    ['signals/logs', 'signals', 'signals/logs'], ['agent-traces', 'traces', 'traces/runs'],
    ['session-traces', 'traces', 'traces/session'], ['signals/panels', 'signals/panels', 'signals/panels'],
    ['model-pool', 'platform', 'platform/model-pool'], ['platform/probing', 'platform', 'platform/probing'],
    ['rules', 'alerts/rules', 'alerts/rules'], ['objects', 'alerts/rules', 'alerts/objects'],
    ['devices/logs', 'devices', 'devices/logs'], ['tenants/create', 'tenants', 'tenants/create'],
  ];
  for (const [route, navKey, canonical] of routes) {
    h.hooks.setView(route, false);
    const active = h.shell.querySelectorAll('.module-tab[data-view]').filter(node => node.classList.contains('active'));
    assert.equal(active.length, 1, 'exactly one navigation destination must be active for ' + route);
    assert.equal(active[0].dataset.view, navKey); assert.equal(active[0].getAttribute('aria-current'), 'page');
    assert.equal(h.hooks.state.viewSource, canonical);
    for (const group of groups) assert.equal(group.open, active[0].closest('.nav-group') === group, 'disclosure follows the actual parent of ' + route);
    const controlled = active[0].getAttribute('aria-controls'); assert.ok(controlled && h.byId(controlled), 'active entry controls a real view');
    if (canonical === 'signals/panels') assert.equal(h.byId('pageTitle')!.textContent, '自定义看板');
    if (canonical.includes('/')) { const panel = h.shell.querySelector('[data-view-module="' + canonical + '"]')!; assert.ok(panel); assert.equal(panel.hidden, false); assert.ok(panel.classList.contains('is-active')); }
  }
});

test('巡检原生菜单保留内部操作，外部点击和 Escape 关闭，切换工作区不残留展开', async () => {
  const h = setup(); const options = h.byId('workspaceOptions')!; const summary = options.querySelector('summary')!;
  options.open = true; await h.dispatchDocument('click', h.byId('runChecks')!);
  assert.equal(options.open, true, 'a click inside the native menu must remain usable');
  await h.dispatchDocument('click', h.byId('refresh')!); assert.equal(options.open, false);
  options.open = true; await h.dispatchDocument('keydown', summary, 'Enter'); assert.equal(options.open, true);
  await h.dispatchDocument('keydown', h.body, 'Escape'); assert.equal(options.open, false); assert.equal(summary.focused, true);
  summary.focused = false; await h.dispatchDocument('keydown', h.body, 'Escape'); assert.equal(summary.focused, false, 'Escape must not steal focus when this menu is already closed');
  options.open = true; h.hooks.setView('signals/panels', false); assert.equal(options.open, false);
  assert.equal(h.byId('pageTitle')!.textContent, '自定义看板');
});

test('云端/端侧上下文随真实设备路由变化，设置域不导航时不改当前页面', () => {
  const h = setup(); h.hooks.setView('devices/logs', false);
  assert.equal(h.hooks.state.domain, 'edge'); assert.equal(h.body.dataset.domain, 'edge');
  assert.match(h.byId('domainContext')!.textContent, /端侧/);
  h.hooks.setView('traces/session', false);
  assert.equal(h.hooks.state.domain, 'cloud'); assert.match(h.byId('domainContext')!.textContent, /云侧/);
  h.hooks.setDomain('edge', false); assert.equal(h.hooks.state.viewSource, 'traces/session');
  assert.equal(h.body.dataset.domain, 'edge'); assert.match(h.byId('domainContext')!.textContent, /端侧/);
  h.hooks.setDomain('cloud'); assert.equal(h.hooks.state.viewSource, 'overview');
});

test('组员权限裁剪同时覆盖主导航和更多入口，受限深链不会渲染平台数据域', () => {
  const h = setup(); h.hooks.member(true); h.hooks.pruneMemberNav();
  const allowed = new Set(['overview', 'alerts/center', 'alerts/strategies', 'tenants']);
  for (const node of h.shell.querySelectorAll('.module-tab[data-view]')) assert.equal(node.hidden, !allowed.has(node.dataset.view), 'permission visibility: ' + node.dataset.view);
  for (const route of ['platform/model-pool', 'signals/panels', 'devices/logs', 'database']) {
    const before = h.renders.length; h.hooks.setView(route, false);
    assert.equal(h.hooks.state.viewSource, 'overview'); assert.equal(h.renders.length, before, 'blocked route must not call a platform renderer');
  }
  const tenant = setup({ tenantToken: 'synthetic-tenant-preview' }); tenant.hooks.setView('platform/model-pool', false);
  assert.equal(tenant.hooks.state.viewSource, 'overview'); assert.deepEqual(tenant.renders, []);
});

test('静态域收敛不隐藏事故计数，恢复后同一主导航徽章回到空态', () => {
  const h = setup();
  h.hooks.setNavGroupAlerts({ incidents: [{ status: 'open' }, { status: 'acknowledged' }, { status: 'resolved' }] });
  const badge = h.byId('incidentCount')!; assert.equal(badge.hidden, false); assert.equal(badge.textContent, '2');
  assert.match(badge.title, /2.*进行中事故/);
  h.hooks.setNavGroupAlerts({ incidents: [] }); assert.equal(badge.hidden, true); assert.equal(badge.textContent, ''); assert.equal(badge.title, '');
});

test('折叠分类的候选摘要随真实徽章变化，权限裁剪后不泄露其他工作区待办', () => {
  const h = setup(); const skill = h.byId('skillLoopCount')!; const evolution = h.byId('evolutionCount')!; const notice = h.byId('navReviewNotice')!;
  skill.textContent = '2'; evolution.textContent = '0'; h.hooks.setView('overview', false);
  assert.equal(notice.hidden, false); assert.match(notice.textContent, /待审核/); assert.match(notice.title, /候选待审核/);
  skill.textContent = '0'; evolution.textContent = '1'; h.hooks.setView('signals', false); assert.equal(notice.hidden, false);
  evolution.textContent = '0'; h.hooks.setView('overview', false); assert.equal(notice.hidden, true); assert.equal(notice.title, '');
  skill.textContent = '2'; h.hooks.member(true); h.hooks.pruneMemberNav(); h.hooks.setView('overview', false);
  assert.equal(notice.hidden, true, 'hidden learning tabs must not project their count into an allowed navigation group');
});

test('精简后的账号栏仍提供当前身份、租户切换与退出，操作保持原会话约束', async () => {
  const h = setup({ session: 'synthetic-sso-session', tenant: 'team-a' });
  h.hooks.identity({ user: { id: 'user-preview', name: '<preview user>' }, admin: true, tenants: [{ tenantId: 'team-a', displayName: 'A团队' }, { tenantId: 'team-b', displayName: 'B团队' }] });
  h.hooks.renderObsAccountBar(); const bar = h.byId('obsAccountBar')!;
  assert.ok(bar.closest('.side-nav')); assert.match(bar.textContent, /<preview user>/);
  const select = h.byId('obsTenantSelect')!; assert.equal(select.getAttribute('aria-label'), '切换租户');
  select.value = 'team-b'; await select.dispatch('change');
  assert.equal(h.storage.get('d_obs_active_tenant'), 'team-b'); assert.equal(h.reloads(), 1);
  const logout = bar.querySelector('.obs-logout-btn')!; await logout.dispatch('click');
  assert.ok(h.calls.some(path => path.endsWith('/api/ops/auth/logout')));
  assert.equal(h.storage.has('d_obs_sso_session'), false); assert.equal(h.storage.has('d_obs_active_tenant'), false); assert.equal(h.reloads(), 2);
});
