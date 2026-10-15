/** Exercise the shipped navigation on nodes parsed from the shipped page.
 * The DOM model implements capture/bubble, reparenting, native disclosures and
 * focus; routing, visibility and keyboard selection come from production code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { integrateCollectionScriptA } from './observability-page-collection-integration.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';
import { OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import { OPS_OBSERVABILITY_SCRIPT_FOCUS } from './observability-page-focus.js';
import { OPS_OBSERVABILITY_SCRIPT_RESTRAINT } from './observability-page-restraint.js';

type ShellEvent = {
  target: ShellNode; currentTarget: ShellNode | null; key?: string;
  defaultPrevented: boolean; stopped: boolean; immediate: boolean;
  preventDefault(): void; stopPropagation(): void; stopImmediatePropagation(): void;
};
type Listener = { callback: (event: ShellEvent) => unknown; capture: boolean };

class ShellNode {
  children: ShellNode[] = [];
  parentElement: ShellNode | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = {};
  listeners = new Map<string, Listener[]>();
  hidden = false; disabled = false; open = false; value = ''; type = ''; title = ''; id = ''; tabIndex = 0;
  private text = '';
  private classes = new Set<string>();
  constructor(readonly tagName: string, private focusNode: (node: ShellNode) => void, private detachNode: (node: ShellNode) => void) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    contains: (name: string) => this.classes.has(name),
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    toggle: (name: string, force?: boolean) => { const on = force ?? !this.classes.has(name); if (on) this.classes.add(name); else this.classes.delete(name); return on; },
  };
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  appendText(value: string) { this.text += value; }
  set innerHTML(_value: string) { throw new Error('navigation must use safe DOM'); }
  get firstElementChild(): ShellNode | null { return this.children[0] ?? null; }
  get lastElementChild(): ShellNode | null { return this.children.at(-1) ?? null; }
  get parentNode() { return this.parentElement; }
  get nextSibling(): ShellNode | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  get nextElementSibling(): ShellNode | null { return this.nextSibling; }
  appendChild(node: ShellNode) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node: ShellNode, before: ShellNode | null) { if (before === node) return node; node.remove(); node.parentElement = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); return node; }
  remove() { if (this.parentElement) { this.detachNode(this); this.parentElement.children = this.parentElement.children.filter(node => node !== this); } this.parentElement = null; }
  replaceChildren(...nodes: ShellNode[]) { [...this.children].forEach(node => node.remove()); this.text = ''; nodes.forEach(node => this.appendChild(node)); }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'open') this.open = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return name === 'id' ? this.id || null : name === 'class' ? this.className || null : this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; if (name === 'open') this.open = false; }
  addEventListener(name: string, callback: Listener['callback'], options?: boolean | { capture?: boolean }) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], { callback, capture: options === true || typeof options === 'object' && options.capture === true }]);
  }
  removeEventListener(name: string, callback: Listener['callback']) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(listener => listener.callback !== callback)); }
  emit(name: string, key?: string) {
    const event: ShellEvent = {
      target: this, currentTarget: null, key, defaultPrevented: false, stopped: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.immediate = true; this.stopped = true; },
    };
    const path: ShellNode[] = [];
    for (let node: ShellNode | null = this; node; node = node.parentElement) path.push(node);
    const invoke = (node: ShellNode, capture: boolean) => {
      event.currentTarget = node;
      for (const listener of node.listeners.get(name) ?? []) {
        if (listener.capture !== capture) continue;
        listener.callback(event);
        if (event.immediate) break;
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) break; }
    if (!event.stopped) for (const node of path) { invoke(node, false); if (event.stopped) break; }
    if (name === 'click' && !event.defaultPrevented) {
      const summary = this.closest('summary');
      if (summary?.parentElement?.tagName === 'DETAILS') { summary.parentElement.open = !summary.parentElement.open; summary.parentElement.emit('toggle'); }
    }
    return event;
  }
  click() { this.emit('click'); }
  focus() { this.focusNode(this); }
  scrollIntoView() {}
  contains(node: ShellNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    const exclusions = [...selector.matchAll(/:not\(([^)]+)\)/g)];
    if (exclusions.some(match => this.matches(match[1]))) return false;
    const clean = selector.replace(/:not\([^)]+\)/g, '');
    if (clean.includes(':scope')) return false;
    const attrs = [...clean.matchAll(/\[([\w-]+)(?:(\^?=)["']([^"']*)["'])?\]/g)];
    const plain = clean.replace(/\[[^\]]*\]/g, '');
    const id = plain.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    const tag = plain.match(/^[a-z][\w-]*/i)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
    if ([...plain.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
    return attrs.every(([, name, op, expected]) => { const value = this.getAttribute(name); return op === '=' ? value === expected : op === '^=' ? value?.startsWith(expected) : value != null; });
  }
  closest(selector: string): ShellNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): ShellNode[] {
    if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(part => this.querySelectorAll(part.trim())))];
    if (selector.startsWith(':scope > ')) return this.children.filter(child => child.matches(selector.slice(9)));
    const parts = selector.trim().split(/\s+(?![^[]*\])/); const leaf = parts.pop()!;
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

function parseShell(create: (tag: string) => ShellNode) {
  const html = OPS_OBSERVABILITY_HTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = create('ROOT'); const stack = [root];
  const voids = new Set(['INPUT', 'BR', 'HR', 'META', 'LINK', 'IMG', 'AREA', 'BASE', 'COL', 'EMBED', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  for (const token of html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>|([^<]+)/gi)) {
    if (token[3]) { stack.at(-1)!.appendText(token[3]); continue; }
    const tag = token[1].toUpperCase();
    if (token[0].startsWith('</')) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const node = create(tag);
    for (const attr of token[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    stack.at(-1)!.appendChild(node); if (!voids.has(tag) && !token[0].endsWith('/>')) stack.push(node);
  }
  return root;
}

function setup(options: { tenantToken?: string; member?: boolean } = {}) {
  let active: ShellNode | null = null;
  let body: ShellNode;
  const create = (tag: string): ShellNode => new ShellNode(tag.toUpperCase(), node => { active = node; }, node => { if (active && node.contains(active)) active = body; });
  const shell = parseShell(create); body = shell.querySelector('body')!; active = body;
  const originalTabs = shell.querySelectorAll('[data-module-tab]');
  const storage = new Map<string, string>();
  if (options.tenantToken) storage.set('d_obs_tenant_token', options.tenantToken);
  if (options.member) { storage.set('d_obs_sso_session', 'synthetic-member-session'); storage.set('d_obs_active_tenant', 'synthetic-team'); }
  const renders: string[] = [];
  const windowListeners = new Map<string, Array<() => void>>();
  const document = {
    body, documentElement: shell.querySelector('html'), title: '', get activeElement() { return active; },
    createElement: create, createTextNode: (text: string) => { const node = create('TEXT'); node.textContent = text; return node; },
    getElementById: (id: string) => shell.querySelector('#' + id), querySelector: shell.querySelector.bind(shell), querySelectorAll: shell.querySelectorAll.bind(shell),
    addEventListener: shell.addEventListener.bind(shell), removeEventListener: shell.removeEventListener.bind(shell),
  };
  const context = vm.createContext({
    document, window: { addEventListener(name: string, callback: () => void) { windowListeners.set(name, [...windowListeners.get(name) ?? [], callback]); } }, location: { pathname: '/ops-observability', href: 'http://localhost/ops-observability#overview', reload() {} }, history: { replaceState() {} },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key) },
    localStorage: { getItem: () => null, setItem() {} }, URL, console: { warn() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    setTimeout: () => 0, clearTimeout() {}, markRender: (name: string) => renders.push(name),
  });
  const c = OPS_OBSERVABILITY_SCRIPT_C;
  const accountStart = c.indexOf('function renderObsAccountBar('); const pruneEnd = c.indexOf('function renderObsNoTenantScreen(');
  const bindingsStart = c.indexOf("if(typeof initNavGroups==='function')"); const bindingsEnd = c.indexOf('const hashRaw=', bindingsStart);
  assert.ok(accountStart > 0 && pruneEnd > accountStart && bindingsStart > pruneEnd && bindingsEnd > bindingsStart);
  const dataStubs = ['renderRules', 'renderChannels', 'renderSettings', 'renderEvolution', 'renderServiceLevels', 'bindTenantPanel', 'loadTenants', 'loadIncidentCenter', 'renderObjects', 'renderMetrics', 'renderSignalsView', 'renderModelPool', 'loadDevicesView'];
  const bindingsStubs = ['saveSettings', 'closeEditor', 'testRule', 'saveRule'];
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_UI + '\n' + integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A) + '\n' + c.slice(0, pruneEnd) + '\n' + dataStubs.map(name => 'function ' + name + '(){markRender(' + JSON.stringify(name) + ')}').join('\n') + '\n' + bindingsStubs.map(name => 'function ' + name + '(){}').join('\n') + '\nfunction renderOverview(){}\nfunction renderActionLoopMount(){}\nasync function loadAll(){}\n' + OPS_OBSERVABILITY_SCRIPT_HIERARCHY + '\n' + OPS_OBSERVABILITY_SCRIPT_FOCUS + '\n' + OPS_OBSERVABILITY_SCRIPT_RESTRAINT + '\n' + c.slice(bindingsStart, bindingsEnd) + `
    globalThis.hooks={setView,state,pruneMemberNav,applyAuthMode};
  })();`, context);
  const hooks = context.hooks as { setView(view: string, hash?: boolean): void; state: { viewSource: string }; pruneMemberNav(): void; applyAuthMode(me: unknown): void };
  if (options.member) { hooks.applyAuthMode({ user: { id: 'synthetic-member' }, admin: false, tenants: [{ tenantId: 'synthetic-team' }] }); hooks.pruneMemberNav(); }
  const list = (name: string) => shell.querySelector('#view-' + name + ' .module-switcher')!;
  const tab = (route: string) => shell.querySelector('[data-module-tab="' + route + '"]')!;
  const directRoutes = (name: string) => list(name).querySelectorAll('[data-module-tab]').filter(node => !node.closest('details') && !node.hidden && !node.classList.contains('hidden')).map(node => node.dataset.moduleTab);
  const menu = (name: string) => list(name).querySelector('details')!;
  return { shell, body, hooks, renders, originalTabs, list, tab, directRoutes, menu, active: () => active, byId: document.getElementById, resize: () => windowListeners.get('resize')?.forEach(callback => callback()) };
}

test('实际页面默认只铺开三个查询入口、一个平台配置入口和一个告警入口', () => {
  const h = setup();
  assert.deepEqual(h.directRoutes('signals'), ['signals/metrics', 'signals/logs', 'signals/promql']);
  assert.deepEqual(h.directRoutes('platform'), ['platform/model-pool']);
  assert.deepEqual(h.directRoutes('alerts'), ['alerts/center']);
  for (const name of ['signals', 'platform', 'alerts']) {
    const menus = h.list(name).querySelectorAll('details'); assert.equal(menus.length, 1);
    assert.match(menus[0].querySelector('summary')!.textContent, /更多/); assert.equal(menus[0].open, false);
  }
  const chain = [integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A), OPS_OBSERVABILITY_SCRIPT_HIERARCHY, OPS_OBSERVABILITY_SCRIPT_FOCUS, OPS_OBSERVABILITY_SCRIPT_RESTRAINT, OPS_OBSERVABILITY_SCRIPT_C];
  let previous = -1;
  for (const script of chain) { const offset = OPS_OBSERVABILITY_HTML.indexOf(script); assert.ok(offset > previous, 'the tested navigation chain must match the shipped script order'); previous = offset; }
});

test('旧深链把当前模块升到可见栏，往返复用原节点和路由监听', () => {
  const h = setup(); const originals = h.originalTabs;
  for (const [route, name, base] of [['signals/catalog', 'signals', 3], ['platform/probing', 'platform', 1], ['alerts/objects', 'alerts', 1]] as const) {
    const original = h.tab(route); h.hooks.setView(route, false);
    assert.equal(h.hooks.state.viewSource, route); assert.equal(original.closest('details'), null);
    assert.equal(original.getAttribute('aria-selected'), 'true'); assert.equal(h.directRoutes(name).length, base + 1);
    assert.equal(h.shell.querySelector('[data-view-module="' + route + '"]')!.hidden, false);
  }
  for (let cycle = 0; cycle < 3; cycle += 1) {
    h.hooks.setView('signals', false); const menu = h.menu('signals'); menu.open = true;
    const catalog = h.tab('signals/catalog'); catalog.click();
    assert.equal(h.hooks.state.viewSource, 'signals/catalog', 'the original C click listener must still route');
    assert.equal(h.tab('signals/catalog'), catalog); assert.equal(h.menu('signals').open, false);
    assert.equal(catalog.listeners.get('click')?.length, 1, 'reparenting must not add a second routing listener');
  }
  const current = h.shell.querySelectorAll('[data-module-tab]');
  assert.equal(current.length, originals.length); assert.equal(new Set(current).size, originals.length);
  for (const original of originals) assert.equal(current.filter(node => node === original).length, 1);
  for (const name of ['signals', 'platform', 'alerts']) assert.equal(h.list(name).querySelectorAll('details').length, 1);
});

test('方向键不会走进关闭的更多菜单，End 和 Home 仅在可见标签间选择', () => {
  const h = setup(); h.hooks.setView('signals', false);
  const metrics = h.tab('signals/metrics'); metrics.focus();
  const event = metrics.emit('keydown', 'End'); assert.equal(event.defaultPrevented, true);
  assert.equal(h.hooks.state.viewSource, 'signals/promql'); assert.equal(h.active(), h.tab('signals/promql'));
  h.active()!.emit('keydown', 'ArrowRight');
  assert.equal(h.hooks.state.viewSource, 'signals/metrics'); assert.equal(h.active(), metrics);
  h.hooks.setView('signals/catalog', false); h.tab('signals/catalog').focus(); h.active()!.emit('keydown', 'Home');
  assert.equal(h.hooks.state.viewSource, 'signals/metrics'); assert.equal(h.active(), metrics);
  assert.equal(h.menu('signals').open, false);
});

test('更多菜单内部可操作，Escape 关闭后焦点回到摘要，外部点击与路由切换都关闭', () => {
  const h = setup(); h.hooks.setView('signals', false); const menu = h.menu('signals'); const summary = menu.querySelector('summary')!;
  summary.click(); assert.equal(menu.open, true);
  menu.emit('click'); assert.equal(menu.open, true, 'inside clicks must not dismiss the menu');
  h.tab('signals/catalog').focus(); const escape = h.active()!.emit('keydown', 'Escape');
  assert.equal(escape.defaultPrevented, true); assert.equal(menu.open, false); assert.equal(h.active(), summary);
  const refresh = h.byId('refresh')!; refresh.focus(); refresh.emit('keydown', 'Escape'); assert.equal(h.active(), refresh, 'closed-menu Escape must not steal focus');
  summary.click(); h.body.click(); assert.equal(menu.open, false);
  summary.click(); h.tab('signals/catalog').focus(); h.resize(); assert.equal(menu.open, false); assert.equal(h.active(), summary);
  summary.click(); h.hooks.setView('platform/model-pool', false); assert.equal(menu.open, false);
});

test('同一路由轮询保留展开的更多菜单和菜单内焦点，真正换页才关闭', () => {
  const h = setup();
  for (const [route, name] of [['signals/metrics', 'signals'], ['platform/model-pool', 'platform'], ['alerts/rules', 'alerts']] as const) {
    h.hooks.setView(route, false);
    const menu = h.menu(name); const summary = menu.querySelector('summary')!;
    const tabs = h.list(name).querySelectorAll('[data-module-tab]');
    summary.click(); assert.equal(menu.open, true);
    const focused = menu.querySelector('[data-module-tab]')!; assert.ok(focused); focused.focus();
    for (let poll = 0; poll < 3; poll += 1) {
      h.hooks.setView(route, false);
      assert.equal(h.hooks.state.viewSource, route);
      assert.equal(h.menu(name), menu, 'polling must reuse the disclosure node');
      assert.equal(menu.open, true, 'reapplying the current route must not dismiss an in-progress choice');
      assert.equal(h.active(), focused, 'polling must leave the focused menu choice in place');
      assert.deepEqual(h.list(name).querySelectorAll('[data-module-tab]'), tabs, 'polling must preserve tab nodes and their order');
    }
    h.hooks.setView('overview', false); assert.equal(menu.open, false);
  }
});

test('权限隐藏的标签不会因菜单重排或方向键重新显示，组员和租户深链继续被拒绝', () => {
  const h = setup(); h.hooks.setView('signals', false);
  const logs = h.tab('signals/logs'); logs.hidden = true; logs.classList.add('hidden');
  h.hooks.setView('signals/metrics', false); h.tab('signals/metrics').focus(); h.active()!.emit('keydown', 'ArrowRight');
  assert.equal(h.hooks.state.viewSource, 'signals/promql'); assert.equal(logs.hidden, true); assert.equal(logs.classList.contains('hidden'), true);
  const member = setup({ member: true });
  for (const route of ['signals/catalog', 'platform/probing', 'alerts/rules']) {
    const before = member.renders.length; member.hooks.setView(route, false);
    assert.equal(member.hooks.state.viewSource, 'overview'); assert.equal(member.renders.length, before);
  }
  member.hooks.setView('alerts/strategies', false); assert.equal(member.hooks.state.viewSource, 'alerts/strategies');
  const token = setup({ tenantToken: 'synthetic-tenant-preview' });
  for (const route of ['signals/catalog', 'platform/probing', 'alerts/strategies']) {
    const before = token.renders.length; token.hooks.setView(route, false);
    assert.equal(token.hooks.state.viewSource, 'overview'); assert.equal(token.renders.length, before);
  }
});
