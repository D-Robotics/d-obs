import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { OPS_OBSERVABILITY_SCRIPT_TRACES as SOURCE_TRACES } from './observability-page-script-traces.js';
import { OPS_OBSERVABILITY_SCRIPT_A as SOURCE_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_B as SOURCE_B } from './observability-page-script-b.js';

// The same regression can run against the exact deployed/next compiled modules.
const moduleRoot = process.env.TRACE_POLL_MODULE_ROOT;
const runtimeModule = async (name: string, fallback: string, symbol: string): Promise<string> => moduleRoot
  ? (await import(pathToFileURL(moduleRoot + '/server/monitoring/' + name + '.js').href))[symbol]
  : fallback;
const [OPS_OBSERVABILITY_SCRIPT_TRACES, OPS_OBSERVABILITY_SCRIPT_A, OPS_OBSERVABILITY_SCRIPT_B] = await Promise.all([
  runtimeModule('observability-page-script-traces', SOURCE_TRACES, 'OPS_OBSERVABILITY_SCRIPT_TRACES'),
  runtimeModule('observability-page-script-a', SOURCE_A, 'OPS_OBSERVABILITY_SCRIPT_A'),
  runtimeModule('observability-page-script-b', SOURCE_B, 'OPS_OBSERVABILITY_SCRIPT_B'),
]);
const RAW_RUN_A = '123e4567-e89b-42d3-a456-426614174000';
const RAW_RUN_B = '123e4567-e89b-42d3-a456-426614174001';
const overview = (ref = 'run-a') => ({ ok: true, overview: { alerting: { lastCheckedAt: '2026-10-12T10:00:00Z' }, runTraces: [run(ref)], runTracePage: { environment: 'production', limit: 40, nextCursor: null } } });

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
      setAttribute(name: string, value: unknown) { node.attributes[name] = String(value); if (name.startsWith('data-')) node.dataset[dataName(name)] = String(value); },
      getAttribute(name: string) { if (name.startsWith('data-')) return node.dataset[dataName(name)] ?? null; return node.attributes[name] ?? null; },
      removeAttribute(name: string) { delete node.attributes[name]; },
      focus(options?: unknown) { if (node.isConnected && !node.disabled) { document.activeElement = node; node.lastFocusOptions = options; } },
      setSelectionRange(start: number, end: number) { node.selectionStart = start; node.selectionEnd = end; },
    };
    Object.defineProperty(node, 'isConnected', { get: () => Boolean(body && body.contains(node)) });
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    node.classList = { add: (name: string) => { node.className += ' ' + name; }, contains: (name: string) => node.className.split(' ').includes(name) };
    return node;
  };
  body = make('body'); document.activeElement = body; document.scrollingElement = body;
  const byId = (id: string) => walk(body).find((node) => node.id === id) || null;
  ['nativeRunTraceHost', 'nativeSessionTraceContent', 'refresh', 'pageMeta'].forEach((id) => { const node = make(); node.id = id; body.appendChild(node); });
  const content = make(); content.id = 'nativeTraceContent'; byId('nativeRunTraceHost').appendChild(content);
  document.querySelectorAll = (selector: string) => walk(body).filter((node) => matches(node, selector));
  document.querySelector = (selector: string) => document.querySelectorAll(selector)[0] || null;
  document.addEventListener = (name: string, callback: Function) => { const callbacks = document.listeners.get(name) || []; callbacks.push(callback); document.listeners.set(name, callbacks); };
  const state: any = { view: 'traces', viewSource: 'traces/runs', viewChild: 'runs', domain: 'cloud', overviewHours: 24, overview: overview().overview, config: { updatedAt: '2026-10-12T10:00:00Z' } };
  let tenant = 'tenant-a';
  let readDetail = async (path: string): Promise<any> => api({ ok: true, detail: detail(path.includes('run-b') ? 'run-b' : 'run-a') });
  let readSessions = async (): Promise<any> => ({ ok: true, sessions: [{ sessionRef: 'session-a', runs: [run()] }], page: { environment: 'production', limit: 40, nextCursor: null } });
  let readOverview = async (path: string): Promise<any> => overview(new URL(path, 'http://fixture').searchParams.get('traceRunId') === RAW_RUN_B ? 'run-b' : 'run-a');
  const detailRequests: string[] = []; const sessionRequests: string[] = []; const applied: any[] = []; const warnings: unknown[] = [];
  const context = vm.createContext({ state, history: { replaceState() {} }, document, $: byId, make, add: (parent: any, tag: string, cls: string, text: string) => parent.appendChild(make(tag, cls, text)),
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: number) => String(value * 100) + '%', when: (value: unknown) => String(value || '—'), outcomeName: (value: unknown) => String(value),
    fetch: (path: string) => { detailRequests.push(path); return readDetail(path); }, request: (path: string) => { sessionRequests.push(path); return path.includes('/overview?') ? readOverview(path) : path.includes('/sessions?') ? readSessions() : Promise.resolve({ ok: true, config: { updatedAt: '2026-10-12T10:00:00Z' }, objects: [] }); }, contextRequestHeaders: () => ({ 'X-RDK-Ops-Action': 'observability-context' }),
    apiHeaders: () => ({}), adminTenantQuery: () => '', obsAuthState: { me: { admin: true } }, readOverviewPayload: (data: any) => data.overview, applyOverviewSnapshot: (value: any) => applied.push(value), toast() {}, friendlyError: (value: unknown) => String(value), console: { warn: (...values: unknown[]) => warnings.push(values) }, applyAuthMode: () => false, obsActiveTenant: () => tenant, obsLogout: async () => {}, setTimeout: scheduleRestore, AbortController, URL, base: '/dobs',
  });
  const routingDeclarations = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('const viewNames'), OPS_OBSERVABILITY_SCRIPT_A.indexOf('const state ='));
  const routing = OPS_OBSERVABILITY_SCRIPT_A.slice(OPS_OBSERVABILITY_SCRIPT_A.indexOf('function applyViewModules('), OPS_OBSERVABILITY_SCRIPT_A.indexOf('function loadErrorHint('));
  const loadAll = OPS_OBSERVABILITY_SCRIPT_B.slice(OPS_OBSERVABILITY_SCRIPT_B.indexOf('async function loadAll('));
  assert.ok(routing.includes('function setView(')); assert.ok(loadAll.startsWith('async function loadAll('));
  vm.runInContext(routingDeclarations + '\nlet opsTenantMode=false,opsMemberMode=false;function updateViewHeader(){} function syncScopeVisibility(){} function openNavGroupForView(){} \n' + routing + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\n' + loadAll + '\nglobalThis.hooks={render:renderNativeTraces,open:openRunObservability,close:closeRunObservability,retry:retryRunObservability,load:loadRunObservability,sessions:loadNativeSessionTraces,auth:applyAuthMode,ui:nativeSessionTrace,setView,loadAll,cancel:cancelTracePageLoad};', context);
  const nodes = (selector: string): any[] => document.querySelectorAll(selector);
  const dispatch = (node: any, type: string, extra: Record<string, unknown> = {}) => { const event = { target: node, currentTarget: node, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const callback of node.listeners.get(type) || []) callback(event); return event; };
  const escape = () => { const event = { key: 'Escape', target: document.activeElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const callback of document.listeners.get('keydown') || []) callback(event); };
  return { hooks: (context as any).hooks, settle, flushRestoreTimers, pendingRestoreTimers: () => restoreTimers.length, state, byId, document, body, make, nodes, dispatch, escape, detailRequests, sessionRequests, applied, warnings,
    text: () => walk(body).map((node) => node.textContent).join(' '),
    setOverview: (reader: typeof readOverview) => { readOverview = reader; }, setDetail: (reader: typeof readDetail) => { readDetail = reader; }, setSessions: (reader: typeof readSessions) => { readSessions = reader; }, setTenant: (value: string) => { tenant = value; } };
}


async function searchAndOpen(h: ReturnType<typeof harness>, rawRunId = RAW_RUN_A, ref = 'run-a') {
  h.state.traceQuery = rawRunId; h.hooks.setView('traces/runs', false); await h.settle();
  assert.equal(h.state.traceSearchLoaded, rawRunId); assert.equal(h.state.tracePageLoading, false);
  h.hooks.open(run(ref)); await h.settle();
  const root = h.byId('nativeTraceDetail'); assert.ok(root); assert.equal(h.state.traceDetailStatus, 'ready');
  const tool = h.nodes('details[data-trace-disclosure-key]').find((node) => node.dataset.traceDisclosureKey.includes('conversation:entry') && node.dataset.traceDisclosureKey.endsWith('tool_input'));
  assert.ok(tool); tool.open = true; tool.children[0].focus(); root.scrollTop = 240;
  return { root, tool };
}

for (const manual of [false, true]) {
  test(`${manual ? 'manual refresh' : 'periodic poll'} uses real B loadAll and A setView without clearing UUID search or open detail`, async () => {
    const h = harness(); const { root, tool } = await searchAndOpen(h);
    const before = h.sessionRequests.filter((path) => path.includes('/overview?')).length;
    await h.hooks.loadAll(manual); await h.settle();
    const paths = h.sessionRequests.filter((path) => path.includes('/overview?'));
    assert.equal(paths.length, before + 1, 'setView must not start a second search reset after the overview read');
    assert.ok(paths.every((path) => new URL(path, 'http://fixture').searchParams.get('traceRunId') === RAW_RUN_A), 'overview refresh must retain the exact UUID server filter');
    assert.equal(h.state.traceSearchLoaded, RAW_RUN_A); assert.equal(h.state.traceDetailLocator, 'locator-run-a');
    assert.equal(h.byId('nativeTraceDetail') === root, true); assert.equal(tool.isConnected, true); assert.equal(tool.open, true);
    assert.equal(h.document.activeElement === tool.children[0], true); assert.equal(root.scrollTop, 240); assert.equal(h.detailRequests.length, 1);
    assert.equal(h.byId('refresh').disabled, false); assert.equal(h.warnings.length, 0); assert.equal(h.applied.length, 1);
  });
}

test('an old B overview poll cannot overwrite a different UUID search and its newly opened run', async () => {
  const h = harness(); await searchAndOpen(h);
  const pending = deferred<any>(); h.setOverview(async (path) => new URL(path, 'http://fixture').searchParams.get('traceRunId') === RAW_RUN_A ? pending.promise : overview('run-b'));
  const oldPoll = h.hooks.loadAll(false);
  const { root, tool } = await searchAndOpen(h, RAW_RUN_B, 'run-b');
  pending.resolve(overview('late-old-run')); await oldPoll; await h.settle();
  assert.equal(h.state.traceSearchLoaded, RAW_RUN_B); assert.equal(h.state.overview.runTraces[0].runRef, 'run-b');
  assert.equal(h.state.traceDetailLocator, 'locator-run-b'); assert.equal(h.byId('nativeTraceDetail') === root, true);
  assert.equal(tool.isConnected, true); assert.equal(tool.open, true); assert.equal(h.applied.length, 0, 'old query response is rejected before overview application');
  assert.doesNotMatch(h.text(), /late-old-run/); assert.equal(h.warnings.length, 0);
});

test('default cancellation and account reset still invalidate the loaded search marker', async () => {
  const h = harness(); h.hooks.auth({ user: { id: 'account-a' }, admin: true }); await searchAndOpen(h);
  const controller = new AbortController(); h.state.tracePageController = controller; h.state.tracePageLoading = true;
  h.hooks.cancel(); assert.equal(controller.signal.aborted, true); assert.equal(h.state.traceSearchLoaded, ''); assert.equal(h.state.tracePageLoading, false);
  await searchAndOpen(h); h.hooks.auth({ user: { id: 'account-b' }, admin: true }); await h.settle();
  assert.equal(h.state.traceSearchLoaded, ''); assert.equal(h.state.traceDetailLocator, null); assert.equal(h.state.traceDetailData, null);
});
