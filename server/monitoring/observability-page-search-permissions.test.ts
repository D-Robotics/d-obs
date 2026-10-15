import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_UX } from './observability-page-ux.js';

type UiEvent = { target: UiNode; key?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; preventDefault(): void };

class UiNode {
  id = '';
  value = '';
  type = '';
  hidden = false;
  disabled = false;
  inert = false;
  parent: UiNode | null = null;
  children: UiNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: UiEvent) => void>>();
  private copy = '';
  private classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => { const active = force ?? !this.classes.has(name); if (active) this.classes.add(name); else this.classes.delete(name); return active; },
  };
  constructor(readonly tagName: string, private readonly setFocus: (node: UiNode | null) => void) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get textContent(): string { return this.copy + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.copy = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error('command palette must use safe DOM'); }
  get offsetParent() { return this.parent; }
  appendChild(node: UiNode) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = this; this.children.push(node); return node; }
  replaceChildren(...nodes: UiNode[]) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.copy = ''; nodes.forEach(node => this.appendChild(node)); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, callback: (event: UiEvent) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  dispatch(name: string, patch: Partial<UiEvent> = {}) { const event = { target: this, preventDefault() {}, ...patch }; this.listeners.get(name)?.forEach(callback => callback(event)); }
  click() { this.dispatch('click'); }
  focus() { this.setFocus(this); }
  blur() { this.setFocus(null); }
  contains(node: UiNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.includes(':not([disabled])')) return !this.disabled && this.matches(selector.replace(':not([disabled])', ''));
    if (selector === '[tabindex]:not([tabindex="-1"])') return this.hasAttribute('tabindex') && this.getAttribute('tabindex') !== '-1';
    const match = selector.match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]+)")?\])?$/);
    if (!match) return false;
    return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.classes.has(match[2])) && (!match[3] || this.hasAttribute(match[3]) && (!match[4] || this.getAttribute(match[3]) === match[4]));
  }
  closest(selector: string): UiNode | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  descendants(): UiNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function harness(mode: 'admin' | 'member' | 'tenant' = 'admin') {
  let focused: UiNode | null = null;
  const make = (tag: string, className = '', text = '') => { const node = new UiNode(tag.toUpperCase(), value => { focused = value; }); node.className = className; node.textContent = text; return node; };
  const add = (parent: UiNode, tag: string, className = '', text = '') => parent.appendChild(make(tag, className, text));
  const body = make('body');
  const header = add(body, 'header');
  const trigger = add(header, 'button'); trigger.id = 'globalSearchTrigger';
  const main = add(body, 'main');
  const backdrop = add(body, 'div'); backdrop.id = 'commandPaletteBackdrop';
  const input = add(backdrop, 'input'); input.id = 'commandPaletteSearch';
  const close = add(backdrop, 'button'); close.id = 'closeCommandPalette';
  const results = add(backdrop, 'div'); results.id = 'commandPaletteResults';
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  let timer = 0;
  const requests: string[] = [];
  let response = async (): Promise<unknown> => ({ results: [] });
  const navigations: string[] = [];
  const docListeners = new Map<string, Array<(event: UiEvent) => void>>();
  let activeTenant = 'tenant-a';
  const obsAuthState = { me: { user: { id: 'account-a' }, admin: mode === 'admin' }, version: 1 };
  const context = vm.createContext({
    document: { body, get activeElement() { return focused; }, querySelectorAll: (selector: string) => body.querySelectorAll(selector), addEventListener(name: string, callback: (event: UiEvent) => void) { docListeners.set(name, [...docListeners.get(name) ?? [], callback]); } },
    $: (id: string) => body.querySelector('#' + id), make, add,
    opsTenantMode: mode === 'tenant', opsMemberMode: mode === 'member', obsAuthState,
    obsActiveTenant: () => activeTenant,
    state: { view: 'traces', viewSource: 'traces/runs', overview: null },
    setView: (route: string) => navigations.push(route),
    request: (path: string) => { requests.push(path); return response(); },
    setTimeout: (callback: () => unknown, delay: number) => { timers.set(++timer, { callback, delay }); return timer; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  // Reuse the actual canonical routing and legacy aliases; the test does not
  // maintain a second route or permission list for commandAllowed to resolve.
  const routes = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('const viewNames ='), OPS_OBSERVABILITY_SCRIPT_A.indexOf('const state ='));
  vm.runInContext(routes + '\n' + OPS_OBSERVABILITY_SCRIPT_UX, context);
  const run = (code: string) => vm.runInContext(code, context);
  const json = (code: string) => JSON.parse(run('JSON.stringify(' + code + ')') as string) as unknown;
  const buttons = () => results.querySelectorAll('button.command-item');
  const labels = () => buttons().map(button => button.querySelector('strong')?.textContent);
  const routesShown = () => json('commandVisibleItems().map(item=>item.view)') as string[];
  const search = (query: string) => { if (!run('commandState.open')) trigger.click(); input.value = query; input.dispatch('input'); };
  const fire = async (delay: number) => { const due = [...timers].filter(([, value]) => value.delay === delay); await Promise.all(due.map(([id, value]) => { timers.delete(id); return value.callback(); })); };
  const key = (value: string) => input.dispatch('keydown', { key: value });
  return { run, json, body, header, main, trigger, backdrop, input, results, buttons, labels, routesShown, search, fire, key, requests, navigations, obsAuthState, setResponse: (handler: () => Promise<unknown>) => { response = handler; }, setTenant: (value: string) => { activeTenant = value; } };
}

test('打开搜索只显示五个主入口，并按可见候选设置当前链路选中项', async () => {
  const h = harness(); h.trigger.click(); await h.fire(0);
  assert.deepEqual(h.routesShown(), ['overview', 'alerts/center', 'traces', 'signals', 'devices']);
  assert.deepEqual(h.labels(), ['总览', '告警中心', '链路追踪', '观测查询', '边缘设备']);
  assert.equal(h.buttons()[2].getAttribute('aria-selected'), 'true');
  assert.equal(h.header.inert, true); assert.equal(h.main.inert, true);
  h.key('Enter');
  assert.deepEqual(h.navigations, ['traces']);
  assert.equal(h.header.inert, false); assert.equal(h.main.inert, false);
});

test('输入可找到低频子模块，点击仍使用原路由，包括已有 RDK 日志入口', () => {
  const h = harness();
  for (const [query, route] of [
    ['日志查询', 'signals/logs'], ['PromQL 查询', 'signals/promql'], ['指标字典', 'signals/catalog'],
    ['接入凭据', 'signals/tokens'], ['自定义策略', 'alerts/strategies'], ['RDK 日志调查', 'devices/logs'],
    ['看板', 'signals/panels'], ['运营指标', 'operator-metrics'],
  ]) {
    h.search(query); const index = h.routesShown().indexOf(route); assert.ok(index >= 0, query + '应可搜索到');
    h.buttons()[index].click(); assert.equal(h.navigations.at(-1), route);
  }
});

test('组员候选只包含真实可访问页面，不能点击旧的管理员候选扩大权限', () => {
  const h = harness(); h.search('凭据'); const oldAdminButton = h.buttons()[h.routesShown().indexOf('signals/tokens')]; assert.ok(oldAdminButton);
  h.run('opsMemberMode=true'); h.obsAuthState.me.admin = false;
  oldAdminButton.click();
  assert.deepEqual(h.navigations, [], '身份收敛后点击旧按钮也不能路由到接入凭据');
  assert.deepEqual(h.json('commandItems.filter(commandAllowed).map(item=>item.view)'), ['overview', 'alerts/center', 'alerts/strategies', 'tenants']);
  h.search(''); assert.deepEqual(h.routesShown(), ['overview', 'alerts/center']);
  h.search('自定义策略'); h.key('Enter'); assert.deepEqual(h.navigations, ['alerts/strategies']);
});

test('租户 token 只显示总览，搜索实体不会发起超出可见面的请求', async () => {
  const h = harness('tenant'); h.trigger.click(); assert.deepEqual(h.routesShown(), ['overview']);
  h.search('对象'); await h.fire(180);
  assert.deepEqual(h.routesShown(), []); assert.deepEqual(h.requests, []);
  assert.equal(h.run('commandState.searchLoading'), false);
  h.search('总览'); h.key('Enter'); assert.deepEqual(h.navigations, ['overview']);
});

test('异步实体结果按 deepLink 权限裁剪：组员只可打开事故处置，不可打开对象注册表', async () => {
  const h = harness('member');
  h.setResponse(async () => ({ results: [
    { type: 'incident', id: 'incident-a', title: '本租户事故', status: 'open', view: 'investigate', deepLink: '#alerts/center' },
    { type: 'object', id: 'object-a', title: '对象注册表', view: 'alerts', deepLink: '#alerts/objects' },
    { type: 'incident', id: 'incident-b', title: '管理员调查', view: 'investigate', deepLink: '#investigate' },
  ] }));
  h.search('事故'); await h.fire(180);
  assert.deepEqual(h.labels(), ['本租户事故', '告警中心']);
  assert.equal(h.requests.length, 1); assert.match(h.requests[0], /\/api\/ops\/observability\/search\?q=/);
  h.key('Enter'); assert.deepEqual(h.navigations, ['alerts/center']);
});

for (const change of ['account', 'tenant', 'version', 'role'] as const) {
  test('异步搜索在 ' + change + ' 变化后丢弃旧实体响应', async () => {
    const h = harness(); let resolve!: (value: unknown) => void;
    h.setResponse(() => new Promise(value => { resolve = value; }));
    h.search('旧实体'); const pending = h.fire(180);
    if (change === 'account') h.obsAuthState.me.user.id = 'account-b';
    if (change === 'tenant') h.setTenant('tenant-b');
    if (change === 'version') h.obsAuthState.version += 1;
    if (change === 'role') h.run('opsTenantMode=true');
    resolve({ results: [{ type: 'incident', id: 'old', title: '旧实体', view: 'alerts', deepLink: '#alerts/center' }] }); await pending;
    assert.ok(!h.labels().includes('旧实体')); assert.equal(h.run('commandState.entityItems.length'), 0);
    assert.equal(h.run('commandState.searchLoading'), false); assert.deepEqual(h.navigations, []);
  });
}

test('已完成的实体搜索也不能跨身份保留，新的查询立即清除上一批实体', async () => {
  const h = harness();
  h.setResponse(async () => ({ results: [{ type: 'incident', id: 'old', title: '旧实体', view: 'alerts', deepLink: '#alerts/center' }] }));
  h.search('旧实体'); await h.fire(180); assert.ok(h.labels().includes('旧实体'));
  h.obsAuthState.me.user.id = 'account-b'; h.run('renderCommandResults()'); assert.ok(!h.labels().includes('旧实体'));
  h.obsAuthState.me.user.id = 'account-a'; h.run('renderCommandResults()'); assert.ok(!h.labels().includes('旧实体'), '旧结果不能在切回相同账号后重新出现');
  h.search('新实体'); assert.ok(!h.labels().includes('旧实体'), '新查询等待期间不能显示旧的查询结果');
});

test('搜索服务失败明确显示失败，同时保留可用模块结果', async () => {
  const h = harness(); h.setResponse(async () => { throw new Error('HTTP 503'); });
  h.search('日志查询'); await h.fire(180);
  assert.match(h.results.querySelector('[role="alert"]')?.textContent ?? '', /实体搜索暂不可用/);
  assert.ok(h.routesShown().includes('signals/logs'));
  assert.doesNotMatch(h.results.textContent, /没有匹配/);
  h.key('Enter'); assert.deepEqual(h.navigations, ['signals/logs']);
});

test('关闭或更新查询后，迟到的实体请求不替换当前结果', async () => {
  const h = harness(); let resolve!: (value: unknown) => void;
  h.setResponse(() => new Promise(value => { resolve = value; }));
  h.search('旧实体'); const pending = h.fire(180);
  h.search('指标字典'); const before = h.labels();
  resolve({ results: [{ type: 'incident', id: 'old', title: '旧实体', view: 'alerts', deepLink: '#alerts/center' }] }); await pending;
  assert.deepEqual(h.labels(), before); assert.ok(!h.labels().includes('旧实体'));
  h.run('setCommandPalette(false)'); assert.equal(h.backdrop.classList.contains('open'), false);
  assert.equal(h.run('commandState.entityItems.length'), 0);
});
