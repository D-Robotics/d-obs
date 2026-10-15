import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function run(ref = 'run-a') { return { runRef: ref, sessionRef: 'session-a', locator: 'locator-' + ref, model: 'fixture', outcome: 'completed', elapsedMs: 20, startedAt: '2026-10-12T10:00:00Z', coverage: { state: 'complete', spanCount: 1, traceCount: 1 } }; }
function detail(ref = 'run-a', reply = 'fixture reply') { return { run: run(ref), coverage: { state: 'complete', spanCount: 1, traceCount: 1 }, traces: [{ traceRef: 'trace-a', durationMs: 20, spans: [{ spanRef: 'span-a', name: 'fixture.tool', startOffsetMs: 0, durationMs: 20, sourceSegment: 'moss', status: 'ok', outcome: 'ok', attributes: { 'gen_ai.request.model': 'fixture' }, content: { availability: 'available', schema: 'rdk.studio.trace-content.v1', entries: [{ kind: 'user_input', text: 'fixture question' }, { kind: 'tool_input', text: '{"query":"RDK X5"}' }, { kind: 'model_output', text: reply }], truncated: false, redacted: false } }] }], evidence: { availability: { runFact: 'available', runSummary: 'available', operations: 'unavailable', productEvents: 'missing' }, items: [] }, advancedExport: { availability: 'not_authorized' } }; }
const api = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value });

/** A small DOM that detaches focus like a browser, without inventing missing server nodes. */
function harness() {
  const document: any = { activeElement: null, listeners: new Map<string, Function[]>() };
  const restoreTimers: Array<() => void> = [];
  const scheduleRestore = (callback: () => void, delay: number) => {
    assert.equal(delay, 0, 'this harness controls only queued interaction restore callbacks');
    restoreTimers.push(callback);
    return restoreTimers.length;
  };
  const flushRestoreTimers = () => {
    const batch = restoreTimers.splice(0);
    batch.forEach((callback) => callback());
    return batch.length;
  };
  // Complete promise continuations on an event-loop barrier before explicitly running
  // UI restoration. This observes both phases without relying on elapsed time.
  const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let turn = 0; restoreTimers.length; turn++) {
      assert.ok(turn < 20, 'interaction restoration must settle without a render loop');
      flushRestoreTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const dataName = (name: string) => name.slice(5).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const matches = (node: any, selector: string): boolean => selector.split(',').some((part) => {
    const value = part.trim();
    if (value.startsWith('.')) return node.className.split(' ').includes(value.slice(1));
    const match = /^([\w-]+)?\[([^\]]+)\]$/.exec(value);
    if (match) return (!match[1] || node.tagName === match[1].toUpperCase()) && node.getAttribute(match[2]) !== null;
    return node.tagName === value.toUpperCase();
  });
  let body: any;
  const make = (tag = 'div', className = '', text = ''): any => {
    const node: any = { tagName: tag.toUpperCase(), className, textContent: text, dataset: {}, style: {}, children: [], parentElement: null, attributes: {}, listeners: new Map<string, Function[]>(), open: false, hidden: false, scrollTop: 0, scrollLeft: 0, value: '', disabled: false,
      appendChild(child: any) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
      replaceChildren(...children: any[]) { node.children.slice().forEach((child: any) => child.remove()); children.forEach((child) => node.appendChild(child)); },
      remove() { if (node.parentElement) { if (node.contains(document.activeElement)) document.activeElement = body; node.parentElement.children = node.parentElement.children.filter((child: any) => child !== node); node.parentElement = null; } },
      contains(other: any) { return Boolean(other) && walk(node).includes(other); },
      querySelectorAll(selector: string) { return walk(node).slice(1).filter((child) => matches(child, selector)); },
      addEventListener(name: string, callback: Function) { const callbacks = node.listeners.get(name) || []; callbacks.push(callback); node.listeners.set(name, callbacks); },
      setAttribute(name: string, value: unknown) { node.attributes[name] = String(value); if (name.startsWith('data-')) node.dataset[dataName(name)] = String(value); if(name==='hidden'){node.hidden=true;if(node.contains(document.activeElement))document.activeElement=body;} },
      getAttribute(name: string) { if (name.startsWith('data-')) return node.dataset[dataName(name)] ?? null; return node.attributes[name] ?? null; },
      removeAttribute(name: string) { delete node.attributes[name]; if(name==='hidden')node.hidden=false; },
      focus(options?: unknown) { if (node.isConnected && !node.disabled && !walk(body).some((parent: any)=>parent.hidden&&parent.contains(node))) { document.activeElement = node; node.lastFocusOptions = options; } },
      setSelectionRange(start: number, end: number) { node.selectionStart = start; node.selectionEnd = end; },
    };
    Object.defineProperty(node, 'isConnected', { get: () => Boolean(body && body.contains(node)) });
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    node.classList = { add: (name: string) => { node.className += ' ' + name; }, contains: (name: string) => node.className.split(' ').includes(name), toggle: (name: string, force: boolean) => { const names=new Set(node.className.split(' ').filter(Boolean)); if(force)names.add(name);else names.delete(name);node.className=[...names].join(' ');return force;} };
    return node;
  };
  body = make('body'); document.activeElement = body; document.scrollingElement = body;
  const byId = (id: string) => walk(body).find((node) => node.id === id) || null;
  ['nativeRunTraceHost', 'nativeSessionTraceContent'].forEach((id) => { const node = make(); node.id = id; body.appendChild(node); });
  const view = make(); view.id='view-traces'; body.appendChild(view); view.appendChild(byId('nativeRunTraceHost')); const sessionPanel=make(); sessionPanel.dataset.viewModule='traces/session'; sessionPanel.hidden=true; view.appendChild(sessionPanel); sessionPanel.appendChild(byId('nativeSessionTraceContent')); byId('nativeRunTraceHost').dataset.viewModule='traces/runs';
  const content = make(); content.id = 'nativeTraceContent'; byId('nativeRunTraceHost').appendChild(content);
  document.querySelector = (selector: string) => document.querySelectorAll(selector)[0] || null;
  document.querySelectorAll = (selector: string) => walk(body).filter((node) => matches(node, selector));
  document.addEventListener = (name: string, callback: Function) => { const callbacks = document.listeners.get(name) || []; callbacks.push(callback); document.listeners.set(name, callbacks); };
  const state: any = { view: 'traces', viewChild: 'runs', domain: 'cloud', overviewHours: 24, overview: { runTraces: [run(), run('run-b')], runTracePage: { environment: 'production', limit: 40, nextCursor: null } } };
  let tenant = 'tenant-a';
  let readDetail = async (path: string): Promise<any> => api({ ok: true, detail: detail(path.includes('run-b') ? 'run-b' : 'run-a') });
  let readSessions = async (_path: string): Promise<any> => ({ ok: true, sessions: [{ sessionRef: 'session-a', runs: [run()] }], page: { environment: 'production', limit: 40, nextCursor: null } });
  const detailRequests: string[] = []; const sessionRequests: string[] = [];
  const context = vm.createContext({ state, history: { replaceState() {} }, document, $: byId, make, add: (parent: any, tag: string, cls: string, text: string) => parent.appendChild(make(tag, cls, text)),
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: number) => String(value * 100) + '%', when: (value: unknown) => String(value || '—'), outcomeName: (value: unknown) => String(value),
    fetch: (path: string) => { detailRequests.push(path); return readDetail(path); }, request: (path: string) => { sessionRequests.push(path); return readSessions(path); }, contextRequestHeaders: () => ({ 'X-RDK-Ops-Action': 'observability-context' }),
    applyAuthMode: () => false, obsActiveTenant: () => tenant, obsLogout: async () => {}, setTimeout: scheduleRestore, AbortController, URL, base: '/dobs',
  });
  const routingDeclarations = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('const viewNames'), OPS_OBSERVABILITY_SCRIPT_A.indexOf('const state ='));
  const routing = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('function applyViewModules('), OPS_OBSERVABILITY_SCRIPT_A.indexOf('function loadErrorHint('));
  vm.runInContext(routingDeclarations + '\nlet opsTenantMode=false,opsMemberMode=false;function updateViewHeader(){} function syncScopeVisibility(){} function openNavGroupForView(){} \n' + routing + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\nglobalThis.hooks={render:renderNativeTraces,open:openRunObservability,close:closeRunObservability,retry:retryRunObservability,load:loadRunObservability,sessions:loadNativeSessionTraces,auth:applyAuthMode,ui:nativeSessionTrace,setView,modules:()=>applyViewModules(state.view,"traces/"+state.viewChild),member:v=>opsMemberMode=v,tenant:v=>opsTenantMode=v};', context);
  const nodes = (selector: string): any[] => document.querySelectorAll(selector);
  const dispatch = (node: any, type: string, extra: Record<string, unknown> = {}) => { const event = { target: node, currentTarget: node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const callback of node.listeners.get(type) || []) callback(event); return event; };
  const escape = () => { const event = { key: 'Escape', target: document.activeElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const callback of document.listeners.get('keydown') || []) callback(event); };
  return { hooks: (context as any).hooks, settle, flushRestoreTimers, pendingRestoreTimers: () => restoreTimers.length, state, byId, document, body, make, nodes, dispatch, escape, detailRequests, sessionRequests,
    text: () => walk(body).map((node) => node.textContent).join(' '),
    setDetail: (reader: typeof readDetail) => { readDetail = reader; }, setSessions: (reader: typeof readSessions) => { readSessions = reader; }, setTenant: (value: string) => { tenant = value; } };
}


test('overview polling preserves the same detail DOM, open tools, text scroll and keyboard focus', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle();
  const root = h.byId('nativeTraceDetail');
  const tool = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey.includes('conversation:entry') && node.dataset.traceDisclosureKey.endsWith('tool_input'));
  assert.ok(tool); tool.open = true;
  const summary = tool.children[0]; summary.focus(); root.scrollTop = 180; h.body.scrollTop = 440;
  const text = h.nodes('[data-trace-scroll-key]').find((node) => node.dataset.traceScrollKey.includes('tool_input')); assert.ok(text); text.scrollTop = 37; text.scrollLeft = 22;
  const live = h.nodes('[role]').find((node) => node.getAttribute('role') === 'status' && node.className.includes('trace-detail-state')); const message = live.children[0];
  h.state.overview = { ...h.state.overview, fetchedAt: 'poll-2' }; h.hooks.render(); await h.settle();
  assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(tool.isConnected, true); assert.equal(tool.open, true);
  assert.equal(h.document.activeElement === summary, true); assert.equal(root.scrollTop, 180); assert.equal(text.scrollTop, 37); assert.equal(text.scrollLeft, 22); assert.equal(h.body.scrollTop, 440);
  assert.equal(h.nodes('[role]').find((node) => node.getAttribute('role') === 'status' && node.className.includes('trace-detail-state')), live);
  assert.equal(live.children[0] === message, true, 'unchanged polling must not rewrite live message text');
  assert.equal(h.detailRequests.length, 1);
});

test('background detail refresh keeps reading content, then restores keyed disclosure and focus on new spans', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle();
  const tool = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey.endsWith('tool_input') && node.dataset.traceDisclosureKey.includes('conversation:entry'));
  tool.open = true; tool.children[0].focus(); const key = tool.dataset.traceDisclosureKey;
  const root = h.byId('nativeTraceDetail'); root.scrollTop = 240;
  const response = deferred<any>(); h.setDetail(async () => response.promise); const loading = h.hooks.load('locator-run-a'); await h.settle();
  assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(tool.isConnected, true); assert.match(h.text(), /当前正文保持可读/); assert.equal(root.getAttribute('aria-busy'), 'true');
  response.resolve(api({ ok: true, detail: detail('run-a', 'updated fixture reply') })); await loading; await h.settle();
  const updated = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey === key);
  assert.equal(updated === tool, false); assert.equal(updated.open, true); assert.equal(h.document.activeElement === updated.children[0], true); assert.equal(root.scrollTop, 240); assert.equal(root.getAttribute('aria-busy'), 'false'); assert.match(h.text(), /updated fixture reply/);
  assert.equal(h.nodes('[data-trace-focus-key]').find((node) => node.dataset.traceFocusKey === 'detail:refresh').getAttribute('aria-disabled'), 'false');
});

test('refresh errors expose a stale snapshot and safe retry; denied access removes all previous body', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle();
  h.setDetail(async () => api({ ok: false, error: 'run_observability_unavailable', retryable: true }, 503)); await h.hooks.load('locator-run-a'); await h.settle();
  assert.match(h.text(), /本次刷新未成功/); assert.match(h.text(), /fixture question/); assert.equal(h.byId('nativeTraceDetail').getAttribute('aria-busy'), 'false');
  const retry = h.nodes('[data-trace-focus-key]').find((node) => node.dataset.traceFocusKey === 'detail:retry'); assert.ok(retry);
  h.setDetail(async () => api({ ok: true, detail: detail() })); h.dispatch(retry, 'click'); await h.settle(); assert.equal(h.state.traceDetailStatus, 'ready');
  h.setDetail(async () => api({ ok: false, error: 'not_authorized', retryable: false }, 403)); await h.hooks.load('locator-run-a'); await h.settle();
  assert.equal(h.state.traceDetailData, null); assert.match(h.text(), /没有读取该链路的权限/); assert.doesNotMatch(h.text(), /fixture question|fixture reply/); assert.equal(h.nodes('[data-trace-focus-key]').some((node) => node.dataset.traceFocusKey === 'detail:retry'), false);
});

test('run or account switches clear disclosure state and reject old asynchronous body results', async () => {
  const h = harness(); h.hooks.auth({ user: { id: 'account-a' }, admin: true }); h.hooks.render(); h.hooks.open(run()); await h.settle();
  const tool = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey.includes('conversation:entry') && node.dataset.traceDisclosureKey.endsWith('tool_input')); tool.open = true;
  const old = deferred<any>(); h.setDetail(async (path) => path.includes('run-b') ? api({ ok: true, detail: detail('run-b') }) : old.promise);
  h.hooks.retry(); h.hooks.open(run('run-b')); await h.settle(); old.resolve(api({ ok: true, detail: detail('run-a', 'old account body') })); await h.settle();
  assert.equal(h.state.traceDetailRunRef, 'run-b'); assert.equal(h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey === tool.dataset.traceDisclosureKey).open, false); assert.doesNotMatch(h.text(), /old account body/);
  const stale = deferred<any>(); h.setDetail(async () => stale.promise); h.hooks.retry(); h.hooks.auth({ user: { id: 'account-b' }, admin: true }); stale.resolve(api({ ok: true, detail: detail('run-b', 'private old body') })); await h.settle();
  assert.equal(h.state.traceDetailLocator, null); assert.equal(h.state.traceDetailData, null); assert.doesNotMatch(h.text(), /private old body/);
});

test('tenant context changes clear cached detail even before an old response finishes', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle();
  const old = deferred<any>(); h.setDetail(async () => old.promise); h.hooks.retry(); h.setTenant('tenant-b'); old.resolve(api({ ok: true, detail: detail('run-a', 'old tenant body') })); await h.settle();
  assert.equal(h.state.traceDetailLocator, null); assert.equal(h.state.traceDetailData, null); assert.doesNotMatch(h.text(), /old tenant body|fixture question/);
});

test('Escape returns keyboard focus to the active run row and the active session opener', async () => {
  const h = harness(); h.hooks.render(); const row = h.nodes('.trace-row')[0]; row.focus(); h.dispatch(row, 'keydown', { key: 'Enter' }); await h.settle(); h.escape(); await h.settle();
  assert.equal(h.document.activeElement.dataset.runRef, 'run-a'); assert.equal(h.state.traceDetailLocator, null);
  h.state.viewChild = 'session'; h.hooks.modules(); await h.hooks.sessions(true); await h.settle(); const card = h.nodes('details[data-trace-list-disclosure-key]')[0]; card.open = true; h.dispatch(card, 'toggle');
  const opener = h.nodes('[data-trace-return-run]')[0]; opener.focus(); h.dispatch(opener, 'click'); await h.settle(); h.escape(); await h.settle();
  assert.equal(h.document.activeElement.dataset.traceReturnRun, 'run-a'); assert.equal(h.document.activeElement.dataset.traceFocusKey, 'session-list:run:run-a');
});

test('overview replacement refreshes sessions once without resetting the same run detail or tools', async (t) => {
  for (const responseOrder of ['before restoration', 'after restoration'] as const) {
    await t.test('session response ' + responseOrder, async () => {
      const h = harness(); h.state.viewChild = 'session'; h.hooks.modules(); await h.hooks.sessions(true); h.hooks.open(run()); await h.settle(); const root = h.byId('nativeTraceDetail');
      const tool = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey.includes('conversation:entry') && node.dataset.traceDisclosureKey.endsWith('tool_input')); tool.open = true; tool.children[0].focus();
      const response = deferred<any>(); h.setSessions(async () => response.promise);
      h.state.overview = { ...h.state.overview, fetchedAt: 'manual-or-periodic-refresh' }; h.hooks.render();
      assert.equal(h.sessionRequests.length, 2); assert.equal(h.hooks.ui.loading, true); assert.ok(h.pendingRestoreTimers() > 0);
      assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(tool.isConnected, true); assert.equal(tool.open, true);
      if (responseOrder === 'after restoration') {
        assert.ok(h.flushRestoreTimers() > 0);
        assert.equal(h.document.activeElement === tool.children[0], true, 'loading render restores the currently read tool');
      }
      response.resolve({ ok: true, sessions: [{ sessionRef: 'session-a', runs: [run()] }], page: { environment: 'production', limit: 40, nextCursor: null } });
      await h.settle();
      assert.equal(h.hooks.ui.loading, false); assert.equal(h.pendingRestoreTimers(), 0);
      assert.equal(h.state.traceDetailLocator, 'locator-run-a'); assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(tool.isConnected, true); assert.equal(tool.open, true); assert.equal(h.document.activeElement === tool.children[0], true);
      h.hooks.render(); await h.settle(); assert.equal(h.sessionRequests.length, 2, 'same overview reference must not create a request/render loop');
    });
  }
});

test('list row and search caret remain focused across polling without stealing an outside focus', async () => {
  const h = harness(); h.hooks.render(); const row = h.nodes('.trace-row')[0]; row.focus(); h.hooks.render(); await h.settle(); assert.equal(h.document.activeElement.dataset.runRef, 'run-a');
  const search = h.nodes('[data-trace-focus-key]').find((node) => node.dataset.traceFocusKey === 'run-list:search'); search.focus(); search.setSelectionRange(1, 3); h.hooks.render(); await h.settle(); assert.equal(h.document.activeElement.dataset.traceFocusKey, 'run-list:search'); assert.equal(h.document.activeElement.selectionStart, 1); assert.equal(h.document.activeElement.selectionEnd, 3);
  h.hooks.open(run()); await h.settle(); const pending = deferred<any>(); h.setDetail(async () => pending.promise); h.hooks.retry(); const newSearch = h.nodes('[data-trace-focus-key]').find((node) => node.dataset.traceFocusKey === 'run-list:search'); newSearch.focus(); pending.resolve(api({ ok: true, detail: detail() })); await h.settle(); assert.equal(h.document.activeElement.dataset.traceFocusKey, 'run-list:search');
});

test('bound context and captured conversation each appear once before the collapsed waterfall and evidence', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle(); const root = h.byId('nativeTraceDetail');
  assert.equal(root.querySelectorAll('.trace-conversation').length, 2);
  assert.equal(root.querySelectorAll('.trace-bound-context').length, 1);
  const main = root.querySelectorAll('.trace-detail-body')[0];
  assert.equal(main.children.findIndex((node: any) => node.className.includes('trace-bound-context')) < main.children.findIndex((node: any) => node.className === 'trace-conversation'), true);
  assert.equal(main.children.findIndex((node: any) => node.className === 'trace-conversation') < main.children.findIndex((node: any) => node.className.includes('trace-waterfall-section')), true);
  for (const key of ['detail:waterfalls', 'detail:evidence', 'detail:context']) assert.equal(h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey === key).open, false);
  assert.match(h.text(), /运维 暂不可用/); assert.match(h.text(), /当前权限未开放外部高级追踪/);
});

test('background session updates expose busy state without repeating polite announcements', async () => {
  const h = harness(); h.state.viewChild = 'session'; h.hooks.modules(); await h.hooks.sessions(true);
  const pending = deferred<any>(); h.setSessions(async () => pending.promise);
  h.state.overview = { ...h.state.overview, fetchedAt: 'background-refresh' }; h.hooks.render();
  assert.equal(h.byId('nativeSessionTraceContent').getAttribute('aria-busy'), 'true');
  assert.equal(h.nodes('.trace-pagination')[0].getAttribute('aria-live'), 'off');
  assert.equal(h.nodes('.trace-count')[0].getAttribute('aria-live'), 'off');
  assert.match(h.text(), /后台更新会话样本，当前列表仍可使用/);
  pending.resolve({ ok: true, sessions: [{ sessionRef: 'session-a', runs: [run()] }], page: { environment: 'production', nextCursor: null } }); await h.settle();
  assert.equal(h.byId('nativeSessionTraceContent').getAttribute('aria-busy'), 'false');
});

test('Escape outside the trace view does not close an inactive detail or move its focus', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle();
  h.state.view = 'overview'; h.escape(); await h.settle(); assert.equal(h.state.traceDetailLocator, 'locator-run-a');
});

test('dialog Tab boundaries loop through visible controls and skip folded, hidden and disabled tails', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle(); const root = h.byId('nativeTraceDetail');
  assert.equal(root.getAttribute('role'), 'dialog'); assert.equal(root.getAttribute('aria-modal'), 'false'); assert.equal(root.getAttribute('aria-labelledby'), 'nativeTraceDetailTitle');
  const first = h.nodes('[data-trace-focus-key]').find((node) => node.dataset.traceFocusKey === 'detail:refresh');
  const closed = h.make('details'); const last = h.make('summary', '', 'optional visible section'); closed.appendChild(last); closed.appendChild(h.make('button', '', 'folded control')); root.appendChild(closed);
  for (const kind of ['hidden', 'disabled', 'aria-disabled', 'negative-tabindex', 'display-none', 'aria-hidden']) {
    const hidden = h.make('button', '', kind);
    if (kind === 'hidden') hidden.hidden = true;
    if (kind === 'disabled') hidden.disabled = true;
    if (kind === 'aria-disabled') hidden.setAttribute('aria-disabled', 'true');
    if (kind === 'negative-tabindex') hidden.setAttribute('tabindex', '-1');
    if (kind === 'display-none') hidden.style.display = 'none';
    if (kind === 'aria-hidden') hidden.setAttribute('aria-hidden', 'true');
    root.appendChild(hidden);
  }
  first.focus(); const back = h.dispatch(root, 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(back.defaultPrevented, true); assert.equal(h.document.activeElement === last, true);
  const forward = h.dispatch(root, 'keydown', { key: 'Tab' }); assert.equal(forward.defaultPrevented, true); assert.equal(h.document.activeElement === first, true);
  root.focus(); h.dispatch(root, 'keydown', { key: 'Tab' }); assert.equal(h.document.activeElement === first, true);
  root.focus(); h.dispatch(root, 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(h.document.activeElement === last, true);
  first.focus(); assert.equal(h.dispatch(root, 'keydown', { key: 'Tab' }).defaultPrevented, false, 'middle navigation remains native');
});

test('dialog binding is installed once and does not pull external navigation focus back inside', async () => {
  const h = harness(); h.hooks.render(); h.hooks.open(run()); await h.settle(); const root = h.byId('nativeTraceDetail');
  await h.hooks.load('locator-run-a'); await h.hooks.load('locator-run-a'); await h.settle();
  assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(root.listeners.get('keydown').length, 1);
  const external = h.make('button', '', 'shared navigation'); h.body.appendChild(external); external.focus();
  const tab = h.dispatch(root, 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(tab.defaultPrevented, false); assert.equal(h.document.activeElement === external, true);
  h.hooks.render(); await h.settle(); assert.equal(h.document.activeElement === external, true);
});

function mode(h: ReturnType<typeof harness>, label: string) {
  const host = h.byId(h.state.viewChild === 'session' ? 'nativeSessionTraceContent' : 'nativeTraceContent');
  return host.querySelectorAll('button').find((node: any) => node.textContent === label);
}

test('按运行/按会话使用真实 setView，切换和后台加载保留当前按钮键盘焦点', async () => {
  const h = harness(); h.hooks.render(); await h.settle();
  const toSession = mode(h, '按会话'); assert.ok(toSession); toSession.focus();
  h.dispatch(toSession, 'click'); await h.settle();
  assert.equal(h.state.viewSource, 'traces/session');
  assert.equal(h.sessionRequests.length, 1);
  h.dispatch(mode(h,'按会话'),'click'); await h.settle(); assert.equal(h.sessionRequests.length,1,'同一模式重复点击不触发请求');
  assert.equal(h.document.activeElement===mode(h,'按会话'),true,'已选模式按钮应保留焦点');
  const toRuns = mode(h, '按运行'); toRuns.focus(); h.dispatch(toRuns, 'click'); await h.settle();
  assert.equal(h.state.viewSource, 'traces/runs');
  assert.equal(h.document.activeElement===mode(h,'按运行'),true);
  const focused = mode(h, '按运行');
  h.state.overview = {...h.state.overview, fetchedAt: 'poll'}; h.hooks.render(); await h.settle();
  assert.equal(h.document.activeElement===mode(h,'按运行'),true,'轮询不丢模式焦点');
  assert.equal(h.document.activeElement===focused,false,'实际观察到重建按钮后的恢复');
});

test('真实旧深链归一为两种模式，组员与租户拒绝 Trace 域并不触发会话请求', async () => {
  const h = harness();
  for (const [legacy, canonical] of [['agent-traces', 'traces/runs'], ['traces/agent', 'traces/runs'], ['session-traces','traces/session']]) {
    h.hooks.setView(legacy); await h.settle(); assert.equal(h.state.viewSource, canonical);
  }
  assert.equal(h.sessionRequests.length, 1);
  h.hooks.member(true);
  h.hooks.setView('session-traces'); await h.settle();
  assert.equal(h.state.viewSource, 'overview'); assert.equal(h.sessionRequests.length, 1);
  h.hooks.member(false); h.hooks.tenant(true);
  h.hooks.setView('traces/agent'); await h.settle();
  assert.equal(h.state.viewSource, 'overview'); assert.equal(h.sessionRequests.length, 1);
});

test('按会话继承运行列表的已选环境，不悄悄改查生产', async () => {
  const h=harness(); h.setSessions(async path=>({ok:true,sessions:[],page:{environment:new URL(path,'http://fixture').searchParams.get('environment'),nextCursor:null}})); h.state.traceEnvironment='test'; h.state.overview.runTracePage.environment='test'; h.hooks.render(); await h.settle();
  const toSession=mode(h,'按会话'); h.dispatch(toSession,'click'); await h.settle();
  assert.equal(h.state.viewSource,'traces/session');
  assert.match(h.sessionRequests[0],/environment=test/);
});

test('按会话改环境后回到运行会真实重读该环境，不能混用旧生产样本', async () => {
  const h=harness(); h.hooks.setView('traces/session'); await h.settle();
  h.setSessions(async path=>{ const url=new URL(path,'http://fixture'); const environment=url.searchParams.get('traceEnvironment')||url.searchParams.get('environment'); return path.includes('/overview?')?{ok:true,overview:{runTraces:[run('new-test-run')],runTracePage:{environment,limit:40,nextCursor:null}}}:{ok:true,sessions:[],page:{environment,nextCursor:null}}; });
  const environment=h.byId('nativeSessionTraceContent').querySelectorAll('select')[0]; environment.value='test'; h.dispatch(environment,'change'); await h.settle();
  h.dispatch(mode(h,'按运行'),'click'); await h.settle();
  assert.equal(h.state.traceEnvironment,'test'); assert.equal(h.state.overview.runTracePage.environment,'test');
  assert.ok(h.sessionRequests.some(path=>path.includes('/overview?')&&path.includes('traceEnvironment=test')));
  assert.deepEqual(h.state.overview.runTraces.map((item:any)=>item.runRef),['new-test-run']);
});

test('关闭会话详情后切到空环境再回运行，以及身份重置后切换，始终只有一个详情节点', async () => {
  const h = harness();
  const assertSingleDetail = () => assert.equal(h.nodes('aside').filter(node => node.id === 'nativeTraceDetail').length, 1, '切换后仅保留当前模式的共享详情');
  h.hooks.auth({ user: { id: 'account-a' }, admin: true });
  h.hooks.setView('traces/runs'); await h.settle(); assertSingleDetail();
  h.dispatch(mode(h, '按会话'), 'click'); await h.settle(); assertSingleDetail();
  const card = h.nodes('details[data-trace-list-disclosure-key]').find(node => node.dataset.sessionRef === 'session-a');
  card.open = true; h.dispatch(card, 'toggle');
  h.dispatch(h.nodes('[data-trace-return-run]')[0], 'click'); await h.settle(); assertSingleDetail();
  assert.equal(h.byId('nativeTraceDetail').getAttribute('role'), 'dialog');
  h.hooks.close(); await h.settle(); assertSingleDetail();
  h.setSessions(async path => {
    const url = new URL(path, 'http://fixture');
    const environment = url.searchParams.get('traceEnvironment') || url.searchParams.get('environment');
    return path.includes('/overview?')
      ? { ok: true, overview: { runTraces: [], runTracePage: { environment, limit: 40, nextCursor: null } } }
      : { ok: true, sessions: [], page: { environment, limit: 40, nextCursor: null } };
  });
  const environment = h.byId('nativeSessionTraceContent').querySelectorAll('select')[0];
  environment.value = 'staging'; h.dispatch(environment, 'change'); await h.settle(); assertSingleDetail();
  h.dispatch(mode(h, '按运行'), 'click'); await h.settle(); assertSingleDetail();
  assert.equal(h.document.activeElement.dataset.traceFocusKey, 'trace-list:mode:runs', '环境重读期间也要恢复当前模式按钮焦点');
  assert.equal(h.state.traceDetailLocator, null);
  assert.equal(h.state.overview.runTracePage.environment, 'staging');
  assert.equal(h.byId('nativeTraceDetail').className, 'trace-detail-placeholder');
  h.hooks.auth({ user: { id: 'account-b' }, admin: true });
  h.hooks.render(); await h.settle(); assertSingleDetail();
  h.dispatch(mode(h, '按会话'), 'click'); await h.settle(); assertSingleDetail();
  h.dispatch(mode(h, '按运行'), 'click'); await h.settle(); assertSingleDetail();
});
