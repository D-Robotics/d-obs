import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

type UiEvent = { target: Node; key?: string; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void };
class Node {
  id = ''; value = ''; type = ''; hidden = false; disabled = false; draggable = false; open = false; selectionStart = 0; selectionEnd = 0;
  parentNode: Node | null = null; children: Node[] = []; dataset: Record<string, string> = {};
  style: Record<string, unknown> = {}; attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: UiEvent) => unknown>>();
  private copy = ''; private classes = new Set<string>();
  constructor(readonly tagName: string, private readonly onFocus: (node: Node) => void) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => { const active = force ?? !this.classes.has(name); if (active) this.classes.add(name); else this.classes.delete(name); return active; },
  };
  get textContent(): string { return this.copy + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.copy = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML write'); }
  get isConnected(): boolean { return this.tagName === 'BODY' || Boolean(this.parentNode?.isConnected); }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() { const siblings = this.parentNode?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  get nextElementSibling() { return this.nextSibling; }
  get childNodes() { return this.children; }
  get offsetParent(): Node | null { return this.hidden ? null : this.parentNode; }
  appendChild(node: Node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node: Node, reference: Node | null) { node.remove(); const index = reference ? this.children.indexOf(reference) : -1; node.parentNode = this; if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); return node; }
  replaceChildren(...nodes: Node[]) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.copy = ''; nodes.forEach(node => this.appendChild(node)); }
  removeChild(node: Node) { this.children = this.children.filter(child => child !== node); node.parentNode = null; return node; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); if (name === 'hidden') this.hidden = true; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name) || name === 'hidden' && this.hidden; }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; }
  addEventListener(name: string, callback: (event: UiEvent) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  removeEventListener() {}
  dispatch(name: string, patch: Partial<UiEvent> = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...patch }; return Promise.all((this.listeners.get(name) ?? []).map(callback => callback(event))); }
  click() { if (this.tagName === 'SUMMARY' && this.parentNode?.tagName === 'DETAILS') this.parentNode.open = !this.parentNode.open; return this.dispatch('click'); }
  focus() { this.onFocus(this); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
  reportValidity() { return true; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  contains(node: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 240, width: 640, height: 240 }; }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const match = selector.match(/^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]+)")?\])?$/i);
    return Boolean(match && (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.classes.has(match[2])) && (!match[3] || this.hasAttribute(match[3]) && (!match[4] || this.getAttribute(match[3]) === match[4])));
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  descendants(): Node[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

type Response = { ok: boolean; status: number; json(): Promise<unknown> };
function response(value: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => value }; }
function harness(options: { initialHash?: string; fetch?: (call: { url: string; method: string; body: Record<string, any> | null }) => Promise<Response> } = {}) {
  let focused: Node | null = null;
  const make = (tag: string) => new Node(tag.toUpperCase(), node => { focused = node; });
  const body = make('body');
  // Parse the real assembled HTML. Absent IDs stay absent, and modal nodes are
  // created by the actual renderer rather than generated by getElementById.
  const html = OPS_OBSERVABILITY_HTML.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, '');
  const bodyHtml = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
  const stack = [body];
  for (const token of bodyHtml.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const raw = token[0]; const tag = raw.match(/^<\/?([a-z][\w-]*)/i)?.[1]?.toLowerCase();
    if (!tag || tag === 'body') continue;
    if (raw.startsWith('</')) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.splice(i); break; } continue; }
    const node = make(tag); for (const attribute of raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (attribute.index !== 1) node.setAttribute(attribute[1], attribute[2] ?? '');
    stack.at(-1)!.appendChild(node);
    if (!['input', 'img', 'br', 'hr', 'meta', 'link', 'source'].includes(tag)) stack.push(node);
  }
  const storage = new Map<string, string>();
  const timers = new Map<number, { fn: () => unknown; ms: number }>(); let timer = 0;
  const calls: Array<{ url: string; method: string; body: Record<string, any> | null }> = [];
  let handle = options.fetch ?? (async (_call: typeof calls[number]): Promise<Response> => response({ ok: true, series: [], boards: [], panels: [], templates: [] }));
  const document = { body, documentElement: make('html'), activeElement: null as Node | null, hidden: false, title: '', visibilityState: 'visible', createElement: make, createElementNS: (_ns: string, tag: string) => make(tag), createTextNode: (text: string) => { const node = make('#text'); node.textContent = text; return node; }, getElementById: (id: string) => body.querySelector('#' + id), querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector), addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  const context = vm.createContext({ document, window: { addEventListener() {}, removeEventListener() {}, scrollTo() {} }, location: { pathname: '/ops-observability', hash: options.initialHash ?? '', href: 'http://localhost/ops-observability', reload() {} }, history: { replaceState() {}, pushState() {}, scrollRestoration: 'auto' }, navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, fetch: (url: string, init?: { method?: string; body?: string }) => { const call = { url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) as Record<string, any> : null }; calls.push(call); return handle(call); }, setTimeout: (fn: () => unknown, ms = 0) => { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout: (id: number) => timers.delete(id), setInterval: () => 0, clearInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {}, getComputedStyle: () => ({ display: 'block', getPropertyValue: () => '' }), matchMedia: () => ({ matches: false, addEventListener() {} }), console, URL, AbortController, crypto: { randomUUID: () => 'fixture-id' }, Event: class {}, CustomEvent: class {} });
  const assembled = [...OPS_OBSERVABILITY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n').trim();
  assert.ok(assembled.endsWith('})();'));
  const hook = ';globalThis.boardTest={state,obsAuthState,loadBoards,renderBoard,renderBoardPanels,openPanelModal,boardTemplatesFlow,persistBoardSpec,applyAuthMode,retryBoardSave,boardVariables,createBoardFromSpec,boardDialogControlVisible};})();';
  vm.runInContext(assembled.slice(0, -'})();'.length) + hook, context, { timeout: 10000 });
  const api = vm.runInContext('boardTest', context) as Record<string, any>;
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const fire = async (ms: number) => { for (const [id, item] of [...timers]) if (item.ms === ms) { timers.delete(id); await item.fn(); } await flush(); };
  const id = (value: string) => { const node = body.querySelector('#' + value); assert.ok(node, value); return node; };
  const buttons = (root: Node, label: string) => root.querySelectorAll('button').filter(node => node.textContent === label);
  const field = (root: Node, label: string) => { const row = root.querySelectorAll('label').find(node => node.children[0]?.textContent === label); const node = row?.children[1]; assert.ok(node, label); return node; };
  return { api, body, calls, id, buttons, field, fire, flush, focused: () => focused, setResponse: (fn: typeof handle) => { handle = fn; } };
}

function fixture(editable = true) { return { id: 'board-a', name: 'AI 业务', visibility: editable ? 'private' : 'team', editable, spec: { windowMinutes: 240, variables: [{ name: 'service', label: '业务', type: 'custom', value: 'chat', options: ['chat', 'search'] }], panels: [{ title: '请求量', metric: '', source: 'prometheus', queries: [{ refId: 'A', expr: 'sum(rate(requests_total{service="$service"}[5m]))', legendFormat: '{{service}}' }, { refId: 'B', expr: 'up{service="$service"}', instant: true }], chart: 'stat', reducer: 'sum', unit: 'ms', width: 1, warnValue: null, critValue: null }] } }; }
function savedResponse(call: { url: string; body: Record<string, any> | null }) { return response({ ok: true, board: { id: call.url.split('/').at(-1), visibility: call.body?.visibility || 'private', spec: JSON.parse(JSON.stringify(call.body?.spec)) } }); }
async function load(h: ReturnType<typeof harness>, board = fixture()) { h.setResponse(async call => call.method === 'PUT' ? savedResponse(call) : call.url.endsWith('/boards') ? response({ ok: true, boards: [board] }) : response({ ok: true, series: [{ name: '<script>alert(1)</script>', points: [{ ts: 1710000000000, value: 2 }, { ts: 1710000060000, value: 3 }] }], panels: [] })); await h.api.loadBoards(); await h.flush(); }

test('actual assembled page opens in view mode, renders multiquery results and variable changes query every panel', async () => {
  const h = harness(); await load(h); const grid = h.id('signalsPanelGrid');
  assert.equal(h.api.state.boardEditMode, false); assert.equal(h.id('boardAddPanelBtn').hidden, true);
  assert.equal(grid.querySelector('.signals-panel-card')?.draggable, false); assert.equal(h.buttons(grid, '编辑').length, 0);
  assert.match(grid.textContent, /5\.00 ms/); assert.match(grid.textContent, /<script>alert\(1\)<\/script>/);
  const query = h.calls.findLast(call => call.url.endsWith('/boards/query')); assert.equal(query?.body?.panel.queries.length, 2);
  assert.deepEqual(query?.body?.variables, { service: 'chat' });
  const input = h.id('boardVariables').querySelector('select')!; input.value = 'search'; await input.dispatch('change'); await h.flush();
  assert.deepEqual(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.variables, { service: 'search' });
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0, 'viewer filters never mutate saved board');
});

test('refresh keeps prior chart visibly pending, current failure explicit, and retry can return a real zero', async () => {
  const h = harness(); await load(h); const grid = h.id('signalsPanelGrid'), card = grid.querySelector('.signals-panel-card')!, chart = card.querySelector('.board-panel-chart')!;
  const oldValue = chart.querySelector('.signals-stat-value')!; let resolve!: (value: Response) => void;
  h.setResponse(async () => new Promise(done => { resolve = done; })); h.api.renderBoardPanels();
  assert.equal(grid.querySelector('.signals-panel-card'), card); assert.equal(chart.querySelector('.signals-stat-value'), oldValue);
  assert.equal(card.classList.contains('query-pending'), true); assert.equal(chart.classList.contains('board-panel-previous'), true);
  assert.match(card.textContent, /更新中.*上次查询结果/); assert.match(h.id('boardQueryStatus').textContent, /更新中/);
  resolve(response({ ok: false, error: 'prometheus_unreachable' }, 502)); await h.flush();
  assert.equal(chart.querySelector('.signals-stat-value'), oldValue); assert.equal(chart.classList.contains('board-panel-previous'), true);
  assert.match(card.textContent, /当前筛选查询失败.*上次结果/); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert');
  h.setResponse(async () => response({ ok: true, series: [{ name: 'zero', points: [{ ts: 1710000060000, value: 0 }] }] }));
  await h.buttons(card, '重试')[0].click(); await h.flush();
  assert.equal(card.classList.contains('query-error'), false); assert.equal(chart.classList.contains('board-panel-previous'), false); assert.match(chart.textContent, /0 ms/);
  assert.match(h.id('boardQueryStatus').textContent, /已更新/);
});

test('global query summary preserves a failed panel when another succeeds with warnings', async () => {
  const h = harness(); const board = fixture(); board.spec.panels.push({ ...board.spec.panels[0], title: 'Second' }); await load(h, board);
  h.setResponse(async call => call.body?.panel.title === '请求量' ? response({ ok: false, error: 'invalid_promql' }, 400) : response({ ok: true, series: [], warnings: ['sample warning'] }));
  h.api.renderBoardPanels(); await h.flush(); assert.match(h.id('boardQueryStatus').textContent, /1 个面板查询失败/); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert');
  const cards = h.id('signalsPanelGrid').querySelectorAll('.signals-panel-card'); assert.match(cards[1].textContent, /1 条提示/); assert.match(cards[1].textContent, /sample warning/);
  const before = h.calls.length; h.setResponse(async () => response({ ok: true, series: [] })); await h.buttons(cards[0], '重试')[0].click(); await h.flush();
  assert.equal(h.calls.length, before + 1, 'panel retry only queries its own panel'); assert.match(h.id('boardQueryStatus').textContent, /已更新.*1 个有提示/);
});

for (const status of [401, 403]) test('scope denial ' + status + ' clears all old charts and rejects late panel/board success until fresh authorization', async () => {
  const h = harness(); const board = fixture(); board.spec.panels.push({ ...board.spec.panels[0], title: 'Second' }); await load(h, board);
  h.api.state.boardServiceOptions = ['private-service']; h.api.renderBoard(); await h.flush();
  const oldCards = h.id('signalsPanelGrid').querySelectorAll('.signals-panel-card'); const queries: Array<(value: Response) => void> = []; let resolveList!: (value: Response) => void;
  h.setResponse(async call => call.url.endsWith('/boards') ? new Promise(done => { resolveList = done; }) : call.url.endsWith('/boards/query') ? new Promise(done => { queries.push(done); }) : response({ ok: true, series: [] }));
  const oldList = h.api.loadBoards(); h.api.renderBoardPanels(); assert.equal(queries.length, 2);
  queries[0](response({ ok: false, error: status === 401 ? 'authentication_required' : 'not_authorized' }, status)); await h.flush();
  assert.equal(h.id('signalsPanelGrid').querySelectorAll('.signals-stat-value').length, 0); assert.equal(h.api.state.boards.length, 0);
  assert.ok(oldCards.every(card => card.querySelectorAll('.signals-stat-value').length === 0), 'detached chart nodes are also cleared');
  assert.equal(h.id('boardName').textContent, '业务看板'); assert.equal(h.id('boardDuplicateBtn').hidden, true);
  assert.equal(h.api.state.boardServiceOptions.length, 0); assert.equal(h.id('boardServiceWrap').classList.contains('hidden'), true); assert.equal(h.id('boardServiceFilter').children.length, 0, 'denied scope retains no private service options');
  queries[1](response({ ok: true, series: [{ name: 'after-denial-private', points: [{ ts: 1710000060000, value: 777 }] }] }));
  resolveList(response({ ok: true, boards: [board] })); await oldList; await h.flush();
  assert.doesNotMatch(h.id('signalsPanelGrid').textContent, /after-denial-private|777/); assert.equal(h.api.state.boards.length, 0);
  assert.match(h.id('signalsPanelGrid').textContent, status === 401 ? /登录会话已失效/ : /没有访问权限/); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert');
  h.setResponse(async call => response(call.url.endsWith('/boards') ? { ok: true, boards: [JSON.parse(JSON.stringify(board))] } : { ok: true, series: [] }));
  await h.buttons(h.id('signalsPanelGrid'), '重试')[0].click(); await h.flush();
  assert.equal(h.api.state.boards.length, 1); assert.match(h.id('signalsPanelGrid').textContent, /所选范围内没有数据点/); assert.match(h.id('boardQueryStatus').textContent, /已更新/);
});

for (const status of [401, 403]) test('editor preview ' + status + ' invalidates private background charts and closes the stale editor', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click(); await h.flush();
  assert.equal(h.id('signalsPanelGrid').querySelectorAll('.signals-stat-value').length, 1);
  h.setResponse(async call => call.url.endsWith('/boards/query') ? response({ ok: false, error: status === 401 ? 'authentication_required' : 'not_authorized' }, status) : response({ ok: true, panels: [] }));
  await h.buttons(h.id('signalsPanelGrid'), '编辑')[0].click(); await h.flush();
  assert.equal(h.body.querySelector('.board-modal'), null); assert.equal(h.id('signalsPanelGrid').querySelectorAll('.signals-stat-value').length, 0); assert.equal(h.api.state.boards.length, 0);
  assert.match(h.id('signalsPanelGrid').textContent, status === 401 ? /登录会话已失效/ : /没有访问权限/); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert');
});

test('compact action menu survives refresh, Escape restores summary focus, and copy preserves query fields', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click(); await h.flush();
  const card = h.id('signalsPanelGrid').querySelector('.signals-panel-card')!, menu = card.querySelector('.panel-action-menu')!, summary = menu.querySelector('summary')!;
  assert.equal(h.buttons(card, '编辑').length, 1); await summary.click(); assert.equal(menu.open, true);
  h.api.renderBoardPanels(); await h.flush(); assert.equal(h.id('signalsPanelGrid').querySelector('.panel-action-menu'), menu); assert.equal(menu.open, true);
  await menu.dispatch('keydown', { key: 'Escape' }); assert.equal(menu.open, false); assert.equal(h.focused(), summary);
  await summary.click(); await h.buttons(menu, '复制')[0].click(); await h.flush();
  assert.equal(h.api.state.boards[0].spec.panels.length, 2); assert.equal(h.api.state.boards[0].spec.panels[1].queries.length, 2); assert.equal(h.api.state.boards[0].spec.panels[1].unit, 'ms');
});

test('textbox filtering preserves focus and selection on refresh; reset restores saved variables/service without writes', async () => {
  const h = harness(); const board = fixture(); board.spec.variables[0] = { name: 'model', label: '模型', type: 'textbox', value: 'saved-model', options: [] }; Object.assign(board.spec, { filters: { service: 'saved-service' } });
  board.spec.panels[0] = { ...board.spec.panels[0], source: 'otlp', metric: 'requests.count', queries: [] }; await load(h, board);
  const input = h.id('boardVariables').querySelector('input')!; input.focus(); input.value = 'typed-model'; input.setSelectionRange(2, 5); await input.dispatch('input');
  assert.equal(h.id('boardResetFiltersBtn').hidden, false); h.api.renderBoard(); await h.flush();
  assert.equal(h.id('boardVariables').querySelector('input'), input); assert.equal(h.focused(), input); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 5);
  const service = h.id('boardServiceFilter'); service.value = 'other-service'; await service.dispatch('change'); await h.flush();
  assert.deepEqual(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.filters, { service: 'other-service', model: 'typed-model' });
  const writes = h.calls.filter(call => call.method === 'PUT').length; await h.id('boardResetFiltersBtn').click(); await h.flush();
  assert.equal(input.value, 'saved-model'); assert.equal(service.value, 'saved-service'); assert.equal(h.id('boardResetFiltersBtn').hidden, true);
  assert.deepEqual(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.variables, { model: 'saved-model' }); assert.equal(h.calls.filter(call => call.method === 'PUT').length, writes);
  assert.equal(board.spec.variables[0].value, 'saved-model', 'runtime reset does not rewrite the saved variable definition');
});

test('metadata reflects access and panel count, list failures stay errors, and identity changes clear old results', async () => {
  const h = harness(); await load(h, fixture(false)); assert.equal(h.id('boardName').textContent, 'AI 业务'); assert.equal(h.id('boardScopeBadge').textContent, '共享 · 只读'); assert.equal(h.id('boardPanelCount').textContent, '1 个面板'); assert.equal(h.id('boardDuplicateBtn').hidden, false);
  h.setResponse(async () => response({ ok: false, error: 'central_store_disabled' }, 503)); await h.api.loadBoards(); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert');
  assert.doesNotMatch(h.id('boardQueryStatus').textContent, /已更新|没有数据/);
  h.setResponse(async () => response({ ok: true, series: [] })); h.api.renderBoardPanels(); await h.flush(); assert.equal(h.id('boardQueryStatus').getAttribute('role'), 'alert', 'panel success cannot hide a failed board definition load');
  h.api.obsAuthState.me = { user: { id: 'other' }, admin: false }; h.api.applyAuthMode(h.api.obsAuthState.me);
  assert.equal(h.id('signalsPanelGrid').querySelectorAll('.signals-stat-value').length, 0); assert.equal(h.id('boardName').textContent, '业务看板'); assert.equal(h.id('boardScopeBadge').hidden, true);
});

test('same-board definition reload preserves runtime service overrides while reset still uses saved service', async () => {
  const h = harness(); const board = fixture(); board.spec.variables = []; Object.assign(board.spec, { filters: { service: 'saved-service' } }); await load(h, board);
  const service = h.id('boardServiceFilter'); service.value = 'runtime-service'; await service.dispatch('change'); await h.flush();
  const card = h.id('signalsPanelGrid').querySelector('.signals-panel-card')!;
  const fetched = fixture(); fetched.spec.variables = []; Object.assign(fetched.spec, { filters: { service: 'saved-service' } });
  h.setResponse(async call => response(call.url.endsWith('/boards') ? { ok: true, boards: [fetched] } : { ok: true, series: [] }));
  await h.api.loadBoards(); await h.flush(); assert.equal(service.value, 'runtime-service'); assert.equal(h.id('signalsPanelGrid').querySelector('.signals-panel-card'), card);
  await h.id('boardResetFiltersBtn').click(); await h.flush(); assert.equal(service.value, 'saved-service'); assert.equal(h.calls.some(call => call.method === 'PUT'), false);
});

test('reused cards edit and copy the latest board record after same-ID definition reload', async () => {
  const h = harness(); const original = fixture(); await load(h, original); await h.id('boardEditBtn').click(); await h.flush();
  const card = h.id('signalsPanelGrid').querySelector('.signals-panel-card')!;
  const latest = fixture(); latest.name = 'Latest record';
  h.setResponse(async call => call.method === 'PUT' ? savedResponse(call) : response(call.url.endsWith('/boards') ? { ok: true, boards: [latest] } : { ok: true, series: [], panels: [] }));
  await h.api.loadBoards(); await h.flush(); assert.equal(h.id('signalsPanelGrid').querySelector('.signals-panel-card'), card); assert.equal(h.api.state.boards[0], latest);
  await h.buttons(card, '编辑')[0].click(); await h.flush(); const modal = h.body.querySelector('.board-modal')!;
  h.field(modal, '标题').value = 'Latest edited panel'; await h.buttons(modal, '保存面板')[0].click(); await h.flush();
  assert.equal(latest.spec.panels[0].title, 'Latest edited panel'); assert.equal(original.spec.panels[0].title, '请求量', 'detached original record is untouched');
  const menu = h.id('signalsPanelGrid').querySelector('.panel-action-menu')!; await menu.querySelector('summary')!.click(); await h.buttons(menu, '复制')[0].click(); await h.flush();
  assert.equal(latest.spec.panels.length, 2); assert.equal(latest.spec.panels[1].title, 'Latest edited panel 副本'); assert.equal(original.spec.panels.length, 1);
  assert.equal(h.calls.findLast(call => call.method === 'PUT')?.body?.spec.panels.length, 2);
});

test('open delete confirmation removes the latest record after equivalent same-ID definition reload', async () => {
  const h = harness(); const original = fixture(); await load(h, original); await h.id('boardEditBtn').click(); await h.flush();
  const card = h.id('signalsPanelGrid').querySelector('.signals-panel-card')!, menu = card.querySelector('.panel-action-menu')!;
  await menu.querySelector('summary')!.click(); await h.buttons(menu, '删除')[0].click(); const confirm = h.body.querySelector('.board-modal')!;
  assert.ok(confirm); const latest = fixture(); latest.name = 'Latest record';
  h.setResponse(async call => call.method === 'PUT' ? savedResponse(call) : response(call.url.endsWith('/boards') ? { ok: true, boards: [latest] } : { ok: true, series: [], panels: [] }));
  await h.api.loadBoards(); await h.flush(); assert.equal(h.id('signalsPanelGrid').querySelector('.signals-panel-card'), card);
  await h.buttons(confirm, '删除')[0].click(); await h.flush();
  assert.equal(latest.spec.panels.length, 0); assert.equal(original.spec.panels.length, 1, 'detached original record is untouched');
  assert.equal(h.calls.findLast(call => call.method === 'PUT')?.body?.spec.panels.length, 0);
});

test('editing a PromQL panel previews both queries, saves all fields, and library writes retain the definition', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click();
  assert.equal(h.id('boardAddPanelBtn').hidden, false); await h.buttons(h.id('signalsPanelGrid'), '编辑')[0].click(); await h.flush();
  const modal = h.body.querySelector('.board-modal')!; assert.equal(modal.querySelectorAll('textarea').length, 2);
  const title = h.field(modal, '标题'); title.value = '业务请求率'; await title.dispatch('input');
  await h.fire(400); assert.equal(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.panel.queries.length, 2);
  h.field(modal, '单位（可选：ms、s、percent、bytes）').value = 'percent'; await h.buttons(modal, '保存面板')[0].click(); await h.flush();
  const put = h.calls.findLast(call => call.method === 'PUT')!; assert.equal(put.body?.spec.panels[0].unit, 'percent'); assert.equal(put.body?.spec.panels[0].reducer, 'sum'); assert.equal(put.body?.spec.panels[0].queries.length, 2);
  await h.buttons(h.id('signalsPanelGrid'), '存库')[0].click(); await h.flush(); const library = h.calls.findLast(call => call.url.endsWith('/library/panels') && call.method === 'POST')!;
  assert.equal(library.body?.panel.source, 'prometheus'); assert.equal(library.body?.panel.queries.length, 2); assert.equal(library.body?.panel.unit, 'percent');
});

test('query editor keeps settings and library collapsed, footer errors accessible and hidden values intact through save', async () => {
  const h = harness(); const board = fixture(); Object.assign(board.spec.panels[0], { libraryId: 'library-a', warnValue: 2, critValue: 5 });
  const originalQueries = JSON.parse(JSON.stringify(board.spec.panels[0].queries));
  await load(h, board); await h.id('boardEditBtn').click(); await h.buttons(h.id('signalsPanelGrid'), '编辑')[0].click(); await h.flush();
  const overlay = h.body.querySelector('.board-modal')!, dialog = overlay.querySelector('.panel-query-dialog')!, form = dialog.querySelector('.panel-editor-form')!;
  const display = dialog.querySelector('.panel-display-details')!, library = dialog.querySelector('.panel-library-details')!, footer = dialog.querySelector('.panel-editor-footer')!;
  assert.equal(display.open, false); assert.equal(library.open, false); assert.equal(display.querySelector('summary')?.textContent, '展示设置'); assert.equal(library.querySelector('summary')?.textContent, '复用库面板');
  assert.equal(form.querySelector('.panel-editor-footer'), null, 'footer stays outside the scrolling query form');
  assert.equal(footer.parentNode, dialog); assert.equal(dialog.querySelectorAll('.board-query-options').length, 2);
  assert.equal(h.field(display, '单位（可选：ms、s、percent、bytes）').value, 'ms'); assert.equal(h.field(display, '大数字计算').value, 'sum');
  await display.querySelector('summary')!.click(); assert.equal(display.open, true);
  const unit = h.field(display, '单位（可选：ms、s、percent、bytes）'); unit.value = 'percent'; await unit.dispatch('input');
  await display.querySelector('summary')!.click(); assert.equal(display.open, false);
  const source = h.field(dialog, '数据源'); source.value = 'otlp'; await source.dispatch('change'); source.value = 'prometheus'; await source.dispatch('change');
  const title = h.field(dialog, '标题'); title.value = ''; await h.buttons(footer, '保存面板')[0].click();
  assert.match(footer.textContent, /请填写面板标题/); assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  title.value = 'Optimized query'; await h.buttons(footer, '保存面板')[0].click(); await h.flush();
  const saved = h.calls.findLast(call => call.method === 'PUT')!.body!.spec.panels[0];
  assert.equal(saved.unit, 'percent'); assert.equal(saved.reducer, 'sum'); assert.equal(saved.warnValue, 2); assert.equal(saved.critValue, 5); assert.equal(saved.libraryId, 'library-a');
  assert.deepEqual(saved.queries, originalQueries); assert.equal(saved.source, 'prometheus');
});

test('dialog focus includes disclosure summaries, excludes closed/hidden fields, wraps and returns on Escape', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click(); const edit = h.buttons(h.id('signalsPanelGrid'), '编辑')[0]; edit.focus(); await edit.click(); await h.flush();
  const overlay = h.body.querySelector('.board-modal')!, dialog = overlay.querySelector('.panel-query-dialog')!;
  const details = dialog.querySelector('.panel-display-details')!, summary = details.querySelector('summary')!, unit = h.field(details, '单位（可选：ms、s、percent、bytes）');
  const metric = h.field(dialog, 'OTLP 指标名'), title = h.field(dialog, '标题'), save = h.buttons(dialog, '保存面板')[0];
  assert.equal(h.api.boardDialogControlVisible(summary, dialog), true); assert.equal(h.api.boardDialogControlVisible(unit, dialog), false); assert.equal(h.api.boardDialogControlVisible(metric, dialog), false);
  await summary.click(); assert.equal(h.api.boardDialogControlVisible(unit, dialog), true); await summary.click(); assert.equal(h.api.boardDialogControlVisible(unit, dialog), false);
  save.focus(); let prevented = false; await overlay.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(h.focused(), title);
  await overlay.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(h.focused(), save);
  await overlay.dispatch('keydown', { key: 'Escape' }); assert.equal(h.body.querySelector('.board-modal'), null); assert.equal(h.focused(), edit);
});

test('OTLP variables become label filters and avoid a second service control', async () => {
  const h = harness(); const board = fixture(); board.spec.panels[0] = { ...board.spec.panels[0], source: 'otlp', metric: 'requests.count', queries: [] };
  await load(h, board);
  assert.deepEqual(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.filters, { service: 'chat' });
  assert.equal(h.id('boardServiceWrap').classList.contains('hidden'), true);
  const input = h.id('boardVariables').querySelector('select')!; input.value = 'search'; await input.dispatch('change'); await h.flush();
  assert.deepEqual(h.calls.findLast(call => call.url.endsWith('/boards/query'))?.body?.filters, { service: 'search' });
});

test('48 panel boundary rejects add, copy and library inserts, including a modal filled before the limit', async () => {
  const h = harness(); const board = fixture(); board.spec.panels = Array.from({ length: 47 }, (_, index) => ({ ...board.spec.panels[0], title: 'Panel ' + index }));
  await load(h, board); await h.id('boardEditBtn').click();
  h.setResponse(async call => response(call.url.endsWith('/library/panels') ? { ok: true, panels: [{ id: 'library-a', panel: { ...board.spec.panels[0], title: 'Library definition' } }] } : { ok: true, series: [] }));
  await h.id('boardAddPanelBtn').click(); await h.flush();
  const modal = h.body.querySelector('.board-modal')!; assert.ok(modal);
  h.field(modal, '标题').value = '49th'; h.field(modal, 'OTLP 指标名').value = 'requests.count';
  board.spec.panels.push({ ...board.spec.panels[0], title: 'Concurrent 48th' });
  h.field(modal, '库面板').value = 'library-a'; await h.buttons(modal, '链接')[0].click();
  assert.equal(h.field(modal, '标题').value, '49th', 'a new linked panel cannot exceed the limit');
  await h.buttons(modal, '保存面板')[0].click(); assert.equal(board.spec.panels.length, 48); assert.match(modal.textContent, /最多 48/);
  await h.buttons(modal, '取消')[0].click();
  await h.id('boardAddPanelBtn').click(); assert.equal(h.body.querySelector('.board-modal'), null);
  await h.buttons(h.id('signalsPanelGrid'), '复制')[0].click(); assert.equal(board.spec.panels.length, 48);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0); assert.match(h.id('toast').textContent, /最多 48/);
  board.spec.panels.push({ ...board.spec.panels[0], title: 'Invalid overflow' }); await h.api.persistBoardSpec();
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0); assert.match(h.id('boardSaveStatus').textContent, /最多 48/);
});

test('a successful but truncated save response remains a failure and never removes the local draft', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click();
  h.api.state.boards[0].spec.panels.push({ ...h.api.state.boards[0].spec.panels[0], title: 'second panel' });
  h.setResponse(async call => response({ ok: true, board: { id: 'board-a', visibility: 'private', spec: { ...call.body?.spec, panels: call.body?.spec.panels.slice(0, 1) } } }));
  await h.api.persistBoardSpec(); assert.match(h.id('boardSaveStatus').textContent, /保存结果不一致/);
  assert.equal(h.api.state.boards[0].spec.panels.length, 2); assert.doesNotMatch(h.id('boardSaveStatus').textContent, /已保存/);
});

test('save confirmation accepts omitted defaults without replacing local editor state', async () => {
  const h = harness(); const board = fixture(); board.spec.panels[0] = { ...board.spec.panels[0], source: 'otlp', metric: 'requests.count', queries: [], reducer: 'last', unit: '' };
  await load(h, board); await h.id('boardEditBtn').click(); h.setResponse(async call => { const spec = JSON.parse(JSON.stringify(call.body?.spec)); delete spec.panels[0].queries; delete spec.panels[0].unit; delete spec.panels[0].reducer; return response({ ok: true, board: { id: 'board-a', visibility: 'private', spec } }); });
  await h.api.persistBoardSpec(); assert.equal(h.id('boardSaveStatus').textContent, '已保存'); assert.equal(h.api.state.boards[0], board);
});

test('initial asynchronous admin auth reloads the selected dashboard even when overview fails', async () => {
  let resolveAuth!: (value: Response) => void;
  const board = fixture();
  const h = harness({ initialHash: '#signals/panels', fetch: async call => {
    if (call.url.endsWith('/auth/me')) return new Promise(resolve => { resolveAuth = resolve; });
    if (call.url.endsWith('/access')) return response({ ok: true, enabled: true });
    if (call.url.endsWith('/boards')) return response({ ok: true, boards: [JSON.parse(JSON.stringify(board))] });
    if (call.url.includes('/overview')) return response({ ok: false, error: 'overview_unavailable' }, 503);
    return response({ ok: true, series: [], panels: [] });
  } });
  await h.flush(); assert.equal(typeof resolveAuth, 'function');
  const before = h.calls.filter(call => call.url.endsWith('/boards')).length;
  resolveAuth(response({ ok: true, user: { id: 'resolved-admin', name: 'Operator' }, admin: true, tenants: [] }));
  for (let i = 0; i < 4; i++) await h.flush();
  assert.ok(h.calls.filter(call => call.url.endsWith('/boards')).length > before, 'resolved identity starts a fresh scoped dashboard load');
  assert.match(h.id('signalsPanelGrid').textContent, /请求量/); assert.equal(h.id('boardSelect').querySelectorAll('option').length, 1);
});

test('shared viewer cannot save, drag, remove or edit; copying creates an editable private board', async () => {
  const h = harness(); await load(h, fixture(false)); await h.id('boardEditBtn').click();
  assert.equal(h.id('boardEditBtn').hidden, true); assert.equal(h.api.state.boardEditMode, false);
  await h.api.persistBoardSpec(); assert.equal(h.calls.some(call => call.method === 'PUT'), false);
  await h.id('boardDuplicateBtn').click(); const modal = h.body.querySelector('.board-modal')!; const input = modal.querySelector('input')!; input.value = '我的副本';
  h.setResponse(async call => response({ ok: true, board: { ...fixture(), id: 'copy', name: call.body?.name } }));
  await h.buttons(modal, '确定')[0].click(); await h.flush(); const create = h.calls.findLast(call => call.url.endsWith('/boards') && call.method === 'POST')!;
  assert.equal(create.body?.visibility, 'private'); assert.equal(create.body?.spec.panels[0].queries.length, 2); assert.equal(h.api.state.currentBoardId, 'copy'); assert.equal(h.api.state.boardEditMode, true);
});

test('ordered saves coalesce latest snapshot and preserve local edits on failure, with explicit retry', async () => {
  const h = harness(); await load(h); await h.id('boardEditBtn').click(); const pending: Array<(value: Response) => void> = [];
  h.setResponse(call => call.method === 'PUT' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(response({ ok: true, series: [] })));
  h.api.state.boards[0].spec.panels[0].title = 'first'; const first = h.api.persistBoardSpec();
  h.api.state.boards[0].spec.panels[0].title = 'second'; h.api.persistBoardSpec();
  h.api.state.boards[0].spec.panels[0].title = 'latest'; h.api.persistBoardSpec(); assert.equal(pending.length, 1);
  pending[0](savedResponse(h.calls.filter(call => call.method === 'PUT')[0])); await h.flush(); assert.equal(pending.length, 2);
  assert.equal(h.api.state.boards[0].spec.panels[0].title, 'latest', 'older save confirmation cannot replace a newer draft');
  assert.equal(h.calls.findLast(call => call.method === 'PUT')?.body?.spec.panels[0].title, 'latest');
  pending[1](response({ ok: false, error: 'store_unavailable' }, 503)); await first; await h.flush();
  assert.match(h.id('boardSaveStatus').textContent, /保存失败/); assert.equal(h.api.state.boards[0].spec.panels[0].title, 'latest');
  h.api.retryBoardSave(); assert.equal(pending.length, 3); pending[2](savedResponse(h.calls.findLast(call => call.method === 'PUT')!)); await h.flush(); assert.equal(h.id('boardSaveStatus').textContent, '已保存');
});

for (const change of ['board', 'identity', 'range'] as const) test('late dashboard responses cannot overwrite a new ' + change, async () => {
  const h = harness(); await load(h); const pending: Array<(value: Response) => void> = [];
  h.setResponse(async call => call.url.endsWith('/boards/query') ? new Promise(done => { pending.push(done); }) : response({ ok: true }));
  h.api.renderBoardPanels(); const oldCard = h.id('signalsPanelGrid').querySelector('.signals-panel-card')!;
  if (change === 'board') { h.api.state.boards = [{ ...fixture(), id: 'board-b' }]; h.api.state.currentBoardId = 'board-b'; h.api.renderBoard(); }
  if (change === 'identity') { h.api.obsAuthState.me = { user: { id: 'other' }, admin: false }; h.api.applyAuthMode(h.api.obsAuthState.me); }
  if (change === 'range') { h.api.state.boards[0].spec.range = { fromMs: 1710000000000, toMs: 1710000900000 }; h.api.renderBoard(); }
  pending[0](response({ ok: true, series: [{ name: 'late result', points: [{ ts: 1710000000000, value: 999 }] }] })); await h.flush();
  assert.doesNotMatch(oldCard.textContent, /late result/); assert.doesNotMatch(h.id('signalsPanelGrid').textContent, /late result/);
});

test('data source unavailable is explicit, empty differs from zero, and invalid drafts do not save', async () => {
  const h = harness(); await load(h); h.setResponse(async () => response({ ok: false, error: 'prometheus_not_configured' }, 503));
  h.api.renderBoardPanels(); await h.flush(); assert.match(h.id('signalsPanelGrid').textContent, /Prometheus 未配置/); assert.equal(h.id('signalsPanelGrid').querySelectorAll('.board-panel-previous').length, 1);
  await h.id('boardEditBtn').click(); await h.buttons(h.id('signalsPanelGrid'), '编辑')[0].click(); const modal = h.body.querySelector('.board-modal')!;
  h.field(modal, '标题').value = ''; await h.buttons(modal, '保存面板')[0].click(); assert.match(modal.textContent, /请填写面板标题/); assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
});
