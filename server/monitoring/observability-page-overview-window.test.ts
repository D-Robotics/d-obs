import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_B } from './observability-page-script-b.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW_WINDOW } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const run = (ref: string) => ({ runRef: ref, locator: 'locator-' + ref, sessionRef: 'session-safe',
  startedAt: '2026-10-10T00:00:00Z', outcome: 'completed', toolSequence: [],
  coverage: { state: 'summary_only', spanCount: 0, reasonCodes: ['not_received'] } });
const overview = (hours: number, ref = 'run-' + hours, environment = 'production') => ({
  ok: true, overview: { windowHours: hours, alerting: { lastCheckedAt: 'now' }, runTraces: [run(ref)],
    runTracePage: { environment, limit: 40, nextCursor: null } },
});
const sessions = (ref: string) => ({ ok: true, sessions: [{ sessionRef: 'session-safe', runs: [run(ref)] }],
  page: { environment: 'production', limit: 40, nextCursor: null }, unassignedRunCount: 0 });

function harness(mode: 'platform' | 'tenant' | 'member' = 'platform') {
  const roots = new Map<string, any>();
  const requests: Array<{ path: string; options: any }> = [];
  const applied: number[] = [];
  const warnings: unknown[] = [];
  const element = (tag = 'div', className = '', text = ''): any => {
    const node: any = { tagName: tag, className, textContent: text, value: '', dataset: {}, style: {},
      children: [], parentElement: null, listeners: {}, hidden: false,
      appendChild(child: any) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
      replaceChildren() { node.children.slice().forEach((child: any) => child.remove()); },
      remove() { if (node.parentElement) { node.parentElement.children = node.parentElement.children.filter((child: any) => child !== node); node.parentElement = null; } },
      addEventListener(event: string, listener: (...args: any[]) => any) { (node.listeners[event] ||= []).push(listener); },
      setAttribute() {}, removeAttribute() {}, focus() {}, classList: { add() {} },
    };
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    return node;
  };
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const all = () => [...new Set([...roots.values()].flatMap(walk))];
  const byId = (id: string) => all().find((node) => node.id === id) || null;
  for (const id of ['refresh', 'pageMeta', 'overviewWindow', 'overviewContent', 'nativeRunTraceHost', 'nativeAgentTraceHost', 'nativeSessionTraceContent', 'nativeTraceContent']) {
    const node = element(); node.id = id; roots.set(id, node);
  }
  byId('nativeRunTraceHost').appendChild(byId('nativeTraceContent'));
  const state: any = { view: 'traces', viewSource: 'traces/runs', viewChild: 'runs', overviewHours: 24,
    overview: overview(24).overview, config: { updatedAt: 'now' } };
  let read: (path: string, options: any) => Promise<any> = async (path) => {
    if (path.startsWith('/api/ops/observability/overview?')) {
      const query = new URL(path, 'https://test.invalid').searchParams;
      return overview(Number(query.get('hours')), undefined, query.get('traceEnvironment') || 'production');
    }
    if (path.startsWith('/api/ops/observability/sessions?')) return sessions('session-run-' + state.overviewHours);
    return { ok: true, config: { updatedAt: 'now' }, objects: [] };
  };
  const defaultRead = (path: string, options?: any) => read(path, options);
  const context = vm.createContext({ state, $: byId, make: element,
    add: (parent: any, tag: string, className: string, text: string) => parent.appendChild(element(tag, className, text)),
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: number) => String(value * 100) + '%',
    when: (value: unknown) => String(value || '—'), outcomeName: (value: unknown) => String(value),
    request: (path: string, options: any) => { requests.push({ path, options }); return defaultRead(path, options); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, detail: {} }) }),
    contextRequestHeaders: () => ({ 'X-RDK-Ops-Action': 'observability-context' }),
    apiHeaders: () => ({}), adminTenantQuery: () => '', obsAuthState: { me: { admin: true } },
    opsTenantMode: mode === 'tenant', opsMemberMode: mode === 'member', opsSsoActiveTenant: 'tenant-safe',
    applyAuthMode: () => false, obsActiveTenant: () => '', obsLogout: async () => {},
    readOverviewPayload: (data: any) => data.overview,
    applyOverviewSnapshot: (value: any) => { applied.push(value.windowHours); byId('overviewWindow').value = String(state.overviewHours); },
    setView: (source: string) => { if (source.startsWith('traces')) vm.runInContext('renderNativeTraces()', context); },
    toast() {}, friendlyError: (value: unknown) => String(value),
    document: { querySelector: () => null, addEventListener() {}, querySelectorAll: () => [] },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    setTimeout: (callback: () => void) => { callback(); }, AbortController, URL, base: '/dobs',
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_TRACES + OPS_OBSERVABILITY_SCRIPT_B + OPS_OBSERVABILITY_SCRIPT_OVERVIEW_WINDOW +
    '\n renderChannels=function(){};renderSettings=function(){};globalThis.hooks={change:changeOverviewWindow,bind:bindOverviewWindow,loadAll,loadSession:loadNativeSessionTraces,ui:nativeSessionTrace,render:renderNativeTraces,workspace:nativeTraceWorkspace};', context);
  const hooks = (context as any).hooks;
  hooks.bind();
  return { hooks, state, byId, all, requests, applied, warnings,
    read: defaultRead, setRead: (next: typeof read) => { read = next; } };
}

test('时间窗口控件只绑定一次，选择2/24/168真正重查并保持运行环境', async () => {
  const h = harness();
  h.hooks.bind(); h.hooks.bind();
  const select = h.byId('overviewWindow');
  assert.equal(select.listeners.change.length, 1);
  h.state.traceEnvironment = 'test';
  for (const hours of [2, 168, 24]) {
    select.value = String(hours);
    await select.listeners.change[0]({ target: select });
    assert.equal(h.state.overviewHours, hours);
    assert.equal(h.state.overview.windowHours, hours);
    assert.equal(select.value, String(hours));
    assert.equal(h.state.overview.runTracePage.environment, 'test');
  }
  assert.deepEqual(h.applied, [2, 168, 24]);
  const paths = h.requests.filter(({ path }) => path.includes('/overview?')).map(({ path }) => path);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.includes('traceEnvironment=test')));
  await h.hooks.change(7);
  await h.hooks.change(24);
  assert.equal(h.requests.filter(({ path }) => path.includes('/overview?')).length, 3);
  assert.equal(select.value, '24');
});

test('旧轮询和快速2→24→2请求迟到时不混入旧数据或解除新请求loading', async () => {
  const h = harness();
  const pending: Array<ReturnType<typeof deferred<any>>> = [];
  h.setRead(async (path) => {
    if (path.includes('/overview?')) { const next = deferred<any>(); pending.push(next); return next.promise; }
    return { ok: true, config: { updatedAt: 'now' } };
  });
  const oldPoll = h.hooks.loadAll(false);
  const firstTwo = h.hooks.change(2);
  const middle = h.hooks.change(24);
  const newestTwo = h.hooks.change(2);
  assert.equal(pending.length, 4);
  pending[0].resolve(overview(24, 'old-poll'));
  pending[1].resolve(overview(2, 'old-two'));
  pending[2].resolve(overview(24, 'middle-twenty-four'));
  await Promise.all([oldPoll, firstTwo, middle]);
  assert.equal(h.state.overview, null);
  assert.equal(h.byId('refresh').disabled, true);
  assert.deepEqual(h.applied, []);
  pending[3].resolve(overview(2, 'new-two'));
  await newestTwo;
  assert.equal(h.state.overview.runTraces[0].runRef, 'new-two');
  assert.deepEqual(h.applied, [2]);
  assert.equal(h.byId('refresh').disabled, false);
  assert.equal(h.warnings.length, 0);
});

test('切换时间窗口立即取消session/run/detail旧请求并拒绝旧会话结果', async () => {
  const h = harness();
  h.state.viewSource = 'traces/session'; h.state.viewChild = 'session';
  const old = deferred<any>();
  const newSession = deferred<any>();
  h.setRead(async (path) => {
    if (path.includes('/sessions?hours=24')) return old.promise;
    if (path.includes('/sessions?hours=2')) return newSession.promise;
    if (path.includes('/overview?')) return overview(2);
    return { ok: true, config: { updatedAt: 'now' } };
  });
  const oldLoad = h.hooks.loadSession(true);
  const oldSessionSignal = h.requests.find(({ path }) => path.includes('/sessions?'))!.options.signal;
  const runController = new AbortController();
  const detailController = new AbortController();
  h.state.tracePageController = runController; h.state.traceDetailController = detailController;
  h.state.traceDetailLocator = 'old-locator'; h.state.traceDetailStatus = 'ready';
  await h.hooks.change(2);
  assert.equal(oldSessionSignal.aborted, true);
  assert.equal(runController.signal.aborted, true);
  assert.equal(detailController.signal.aborted, true);
  assert.equal(h.state.traceDetailLocator, null);
  old.resolve(sessions('old-window-session-run'));
  await oldLoad;
  assert.equal(h.hooks.ui.sessions.length, 0);
  assert.equal(h.hooks.ui.loading, true);
  newSession.resolve(sessions('new-window-session-run'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.hooks.ui.sessions[0].runs[0].runRef, 'new-window-session-run');
  assert.equal(h.hooks.ui.loading, false);
});

for (const mode of ['tenant', 'member'] as const) {
  test(`${mode}总览分支也拒绝旧窗口轮询，不写回平台范围`, async () => {
    const h = harness(mode);
    h.state.view = 'overview'; h.state.viewSource = 'overview';
    const old = deferred<any>();
    h.setRead(async (path) => path.includes('hours=24') ? old.promise : overview(2));
    const oldLoad = h.hooks.loadAll(false);
    await h.hooks.change(2);
    old.resolve(overview(24));
    await oldLoad;
    assert.equal(h.state.overview.windowHours, 2);
    assert.deepEqual(h.applied, [2]);
    assert.equal(h.state.config, null);
  });
}

test('disposing the trace workspace cancels all owners and rejects a late session response', async () => {
  const h = harness();
  const pending = deferred<any>();
  h.setRead(async () => pending.promise);
  const loading = h.hooks.loadSession(true);
  const sessionSignal = h.requests[0].options.signal;
  const runController = new AbortController();
  const detailController = new AbortController();
  h.state.tracePageController = runController;
  h.state.traceDetailController = detailController;
  h.state.traceDetailLocator = 'departing-account';
  h.hooks.ui.query = 'departing-account-search';
  h.hooks.workspace.dispose();
  assert.equal(sessionSignal.aborted, true);
  assert.equal(runController.signal.aborted, true);
  assert.equal(detailController.signal.aborted, true);
  assert.equal(h.state.traceDetailLocator, null);
  assert.equal(h.hooks.ui.query, '');
  pending.resolve(sessions('departing-account-result'));
  await loading;
  assert.equal(h.hooks.ui.sessions.length, 0);
  assert.equal(h.hooks.ui.loading, false);
  assert.equal(h.state.overview.runTraces.length, 0);
});
