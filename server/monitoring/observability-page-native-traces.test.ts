import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';

function run(runRef: string, sessionRef = 'session-safe-1', overrides: Record<string, unknown> = {}) {
  return { runRef, sessionRef, locator: 'safe-locator-' + runRef, startedAt: '2026-10-10T01:00:00Z',
    outcome: 'completed', elapsedMs: 2400, promptTokens: 5, completionTokens: 10, model: 'test-model',
    toolSequence: ['read_file'], coverage: { state: 'partial', spanCount: 2, traceCount: 1, reasonCodes: ['not_received'], missingSegments: ['client'] },
    ...overrides };
}

function response(runs: ReturnType<typeof run>[], nextCursor: string | null = null, environment = 'production', unassignedRunCount = 0) {
  return { ok: true, sessions: [{ sessionRef: 'session-safe-1', runs }],
    page: { environment, limit: 40, nextCursor }, unassignedRunCount };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const roots = new Map<string, any>();
  const innerHTMLWrites: unknown[] = [];
  const requests: Array<{ path: string; options: any }> = [];
  const detailRequests: Array<{ path: string; options: any }> = [];
  const element = (tag = 'div', className = '', text = ''): any => {
    const classes = new Set(className.split(' ').filter(Boolean));
    const node: any = { tagName: tag, className, textContent: text, value: '', dataset: {}, style: {},
      children: [], parentElement: null, attributes: {}, listeners: {}, hidden: false,
      appendChild(child: any) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
      replaceChildren(...children: any[]) { node.children.slice().forEach((child: any) => child.remove()); children.forEach((child) => node.appendChild(child)); },
      remove() { if (node.parentElement) { node.parentElement.children = node.parentElement.children.filter((child: any) => child !== node); node.parentElement = null; } },
      addEventListener(event: string, callback: (...args: any[]) => any) { node.listeners[event] = callback; },
      setAttribute(key: string, value: unknown) { node.attributes[key] = String(value); },
      removeAttribute(key: string) { delete node.attributes[key]; }, focus() {},
      classList: { add: (name: string) => classes.add(name), contains: (name: string) => classes.has(name) },
    };
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    Object.defineProperty(node, 'innerHTML', { set(value) { innerHTMLWrites.push(value); } });
    return node;
  };
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const all = () => [...new Set([...roots.values()].flatMap(walk))];
  const byId = (id: string) => all().find((node) => node.id === id) || null;
  for (const id of ['nativeRunTraceHost', 'nativeSessionTraceContent', 'nativeTraceContent']) {
    const node = element(); node.id = id; roots.set(id, node);
  }
  byId('nativeRunTraceHost').appendChild(byId('nativeTraceContent'));
  const state: any = { view: 'traces', viewChild: 'runs', overviewHours: 24,
    overview: { runTraces: [run('run-safe-1')], runTracePage: { environment: 'production', limit: 40, nextCursor: null } } };
  let read: (path: string, options: any) => Promise<any> = async () => response([run('run-safe-1')]);
  const detail = { run: run('run-safe-1'), coverage: { state: 'summary_only', spanCount: 0, traceCount: 0 }, traces: [],
    evidence: { availability: {}, items: [] }, advancedExport: { availability: 'not_configured' } };
  const context = vm.createContext({ state, $: byId, make: element,
    add: (parent: any, tag: string, className: string, text: string) => parent.appendChild(element(tag, className, text)),
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: number) => String(value * 100) + '%',
    when: (value: unknown) => String(value || '—'), outcomeName: (value: unknown) => String(value),
    request: (path: string, options: any) => { requests.push({ path, options }); return read(path, options); },
    fetch: async (path: string, options: any) => { detailRequests.push({ path, options }); return { ok: true, status: 200, json: async () => ({ ok: true, detail }) }; },
    contextRequestHeaders: () => ({ 'X-RDK-Ops-Action': 'observability-context' }),
    applyAuthMode: () => false, obsActiveTenant: () => '', obsLogout: async () => {},
    document: { addEventListener() {}, querySelectorAll: () => all().filter((node) => node.className.includes('trace-row')) },
    setTimeout: (callback: () => void) => { callback(); }, AbortController, URL, base: '/dobs',
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_TRACES + '\n globalThis.hooks={render:renderNativeTraces,renderSessions:renderNativeSessionTraces,load:loadNativeSessionTraces,ui:nativeSessionTrace,merge:mergeNativeSessions,open:openRunObservability,auth:applyAuthMode,logout:obsLogout};', context);
  return { hooks: (context as any).hooks, state, byId, all, requests, detailRequests, innerHTMLWrites,
    text: (id: string) => walk(byId(id)).map((node) => node.textContent).join(' '),
    setRead: (next: typeof read) => { read = next; } };
}

test('运行证据链为唯一原生列表，旧 agent 视图状态回落到运行列表并渲染视图切换', () => {
  const h = harness();
  h.state.viewChild = 'agent';
  h.hooks.render();
  assert.equal(h.byId('nativeTraceContent').parentElement, h.byId('nativeRunTraceHost'));
  assert.ok(h.all().some((node)=>node.tagName==='h2'&&node.textContent==='运行列表'));
  assert.match(h.text('nativeTraceContent'), /run-safe-1/);
  assert.equal(h.requests.length, 0);
  const modeSwitch = h.all().find((node) => String(node.className).includes('trace-mode-switch'));
  assert.ok(modeSwitch, '页头应包含按运行/按会话切换');
  assert.match(h.text('nativeTraceContent'), /按会话/);
  h.state.viewChild = 'runs';
  h.hooks.render();
  assert.equal(h.byId('nativeTraceContent').parentElement, h.byId('nativeRunTraceHost'));
  assert.equal(h.all().filter((node) => node.id === 'nativeTraceDetail').length, 1);
});

test('链路缺失提示区分版本不支持、尚未入库与真实收到的 span', () => {
  const h = harness();
  h.state.overview.runTraces = [
    run('old-client', 'session-safe-1', { coverage: { state: 'summary_only', spanCount: 0, reasonCodes: ['version_unsupported'] } }),
    run('not-received', 'session-safe-1', { coverage: { state: 'unavailable', spanCount: 0, reasonCodes: ['not_received'] } }),
    run('received'),
  ];
  h.hooks.render();
  const text = h.text('nativeTraceContent');
  assert.match(text, /生产方版本不支持完整链路 1 次 · 尚未收到详细 span 1 次/);
  assert.match(text, /1 次运行已收到 span/);
  assert.match(text, /历史运行摘要不会自动补成完整链路/);
});

test('会话查询携带账号上下文，分页按会话合并并按运行去重', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  h.setRead(async () => response([run('run-safe-1')], 'safe-cursor-1', 'production', 2));
  await h.hooks.load(true);
  h.setRead(async () => response([run('run-safe-1'), run('run-safe-2', 'session-safe-1', {
    startedAt: '2026-10-10T02:00:00Z', outcome: 'error', coverage: { state: 'complete', spanCount: 3 },
  })], null, 'production', 1));
  await h.hooks.load(false);
  assert.equal(h.hooks.ui.sessions.length, 1);
  const session = h.hooks.ui.sessions[0];
  assert.equal(session.runCount, 2);
  assert.equal(session.spanCount, 5);
  assert.equal(session.errorCount, 1);
  assert.equal(session.completeRunCount, 1);
  assert.equal(h.hooks.ui.unassignedRunCount, 3);
  assert.match(h.requests[0].path, /^\/api\/ops\/observability\/sessions\?hours=24&environment=production&limit=40$/);
  assert.match(h.requests[1].path, /&cursor=safe-cursor-1$/);
  assert.equal(h.requests[0].options.headers['X-RDK-Ops-Action'], 'observability-context');
  assert.match(h.text('nativeSessionTraceContent'), /统计基于已加载样本/);
  assert.match(h.text('nativeSessionTraceContent'), /3 次已加载运行未关联会话/);
});

test('会话详情继续使用安全 Run locator，且详情挂载在当前会话页', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  await h.hooks.load(true);
  h.hooks.open(run('run-safe-1'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.detailRequests[0].path, '/dobs/api/ops/observability/runs/safe-locator-run-safe-1');
  assert.equal(h.detailRequests[0].options.headers['X-RDK-Ops-Action'], 'observability-context');
  assert.equal(h.byId('nativeTraceDetail').parentElement, h.byId('nativeSessionTraceContent'));
  assert.equal(h.all().filter((node) => node.id === 'nativeTraceDetail').length, 1);
  assert.match(h.text('nativeTraceDetail'), /高级追踪尚未配置，本地详情不受影响/);
});

test('总览轮询重新读取会话并保留展开选择、分页与当前运行详情', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  h.setRead(async () => response([run('run-safe-1')], 'safe-cursor-1'));
  await h.hooks.load(true);
  const card = h.all().find((node) => node.tagName === 'details' && node.dataset.sessionRef === 'session-safe-1');
  card.open = true;
  card.listeners.toggle();
  h.state.overview = { ...h.state.overview, fetchedAt: 'new-poll' };
  h.hooks.render();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2, '同范围新总览应真实重读会话，而非永久缓存旧列表');
  assert.equal(h.all().find((node) => node.dataset.sessionRef === 'session-safe-1').open, true, '新会话列表保留展开选择');
  assert.equal(h.hooks.ui.page.nextCursor, 'safe-cursor-1');
  h.hooks.open(run('run-safe-1'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const detail = h.byId('nativeTraceDetail');
  const currentCard = h.all().find((node) => node.dataset.sessionRef === 'session-safe-1');
  assert.equal(currentCard.open, true, '打开运行详情时仍保留会话展开状态');
  h.state.overview = { ...h.state.overview, fetchedAt: 'another-poll' };
  h.hooks.render();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 3);
  assert.equal(h.state.traceDetailStatus, 'ready');
  assert.equal(h.state.traceDetailLocator, 'safe-locator-run-safe-1');
  assert.equal(h.byId('nativeTraceDetail'), detail);
  assert.equal(h.hooks.ui.page.nextCursor, 'safe-cursor-1');
  assert.match(h.text('nativeTraceDetail'), /高级追踪尚未配置，本地详情不受影响/);
});

test('会话显式刷新和时间窗口变化仍重新加载；窗口变化清除旧展开引用', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  await h.hooks.load(true);
  const card = h.all().find((node) => node.dataset.sessionRef === 'session-safe-1');
  card.open = true;
  card.listeners.toggle();
  await h.hooks.load(true);
  assert.equal(h.requests.length, 2);
  h.state.overviewHours = 168;
  h.hooks.render();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 3);
  assert.match(h.requests[2].path, /hours=168/);
  assert.equal(h.hooks.ui.expanded.size, 0);
});

test('从运行视图切回会话页重新挂载共享详情，保留已加载会话', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  await h.hooks.load(true);
  h.hooks.open(run('run-safe-1'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.state.viewChild = 'runs';
  h.hooks.render();
  assert.notEqual(h.byId('nativeTraceDetail').parentElement, h.byId('nativeSessionTraceContent'));
  h.state.viewChild = 'session';
  h.hooks.render();
  assert.equal(h.requests.length, 1);
  assert.equal(h.byId('nativeTraceDetail').parentElement, h.byId('nativeSessionTraceContent'));
  assert.equal(h.state.traceDetailStatus, 'ready');
});

test('会话失败样本计入 error、failed 和 timeout，统计与服务端保持一致', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  h.setRead(async () => response(['completed', 'error', 'failed', 'timeout'].map((outcome) => run(outcome, 'session-safe-1', { outcome }))));
  await h.hooks.load(true);
  assert.equal(h.hooks.ui.sessions[0].errorCount, 3);
  assert.match(h.text('nativeSessionTraceContent'), /4 次运行 · 8 spans · 3 次失败/);
});

test('跨账号切换清空所有链路数据，并拒绝旧请求恢复会话或加载状态', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  h.hooks.auth({ user: { id: 'account-1' }, admin: true });
  const oldResponse = deferred<any>();
  h.setRead(async () => oldResponse.promise);
  const oldLoad = h.hooks.load(true);
  h.hooks.auth({ user: { id: 'account-2' }, admin: true });
  assert.equal(h.hooks.ui.sessions.length, 0);
  assert.equal(h.state.overview.runTraces.length, 0);
  assert.equal(h.byId('nativeTraceDetail'), null);
  const newResponse = deferred<any>();
  h.setRead(async () => newResponse.promise);
  const newLoad = h.hooks.load(true);
  oldResponse.resolve(response([run('old-account-run')]));
  await oldLoad;
  assert.equal(h.hooks.ui.sessions.length, 0);
  assert.equal(h.hooks.ui.loading, true);
  newResponse.resolve(response([run('new-account-run')]));
  await newLoad;
  assert.equal(h.hooks.ui.sessions[0].runs[0].runRef, 'new-account-run');
  assert.equal(h.hooks.ui.loading, false);
});

test('环境切换丢弃旧结果，服务端返回错误环境时显示可重试失败', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  const oldResponse = deferred<any>();
  h.setRead(async () => oldResponse.promise);
  const oldLoad = h.hooks.load(true);
  h.hooks.ui.environment = 'test';
  h.setRead(async () => response([run('wrong-environment-run')], null, 'production'));
  await h.hooks.load(true);
  oldResponse.resolve(response([run('late-production-run')]));
  await oldLoad;
  assert.equal(h.hooks.ui.sessions.length, 0);
  assert.match(h.hooks.ui.error, /会话环境不匹配/);
  assert.match(h.text('nativeSessionTraceContent'), /重新加载/);
  assert.match(h.requests[1].path, /environment=test/);
});

test('缺少会话引用的运行不生成虚假会话；文本与搜索不发送原始会话ID或执行HTML', async () => {
  const h = harness();
  h.state.viewChild = 'session';
  h.setRead(async () => ({ ok: true, sessions: [
    { sessionRef: '', runs: [run('unassigned-run', '')] },
    { sessionRef: 'session-safe-1', runs: [run('html-run', 'session-safe-1', { model: '<img src=x onerror=alert(1)>' }), run('mismatched-run', 'other-session')] },
  ], page: { environment: 'production', nextCursor: null }, unassignedRunCount: 1 }));
  await h.hooks.load(true);
  assert.equal(h.hooks.ui.sessions.length, 1);
  assert.equal(h.hooks.ui.sessions[0].runCount, 1);
  assert.match(h.text('nativeSessionTraceContent'), /<img src=x onerror=alert\(1\)>/);
  h.hooks.ui.query = 'session-safe-1';
  h.hooks.renderSessions();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path.includes('session-safe-1'), false);
  assert.deepEqual(h.innerHTMLWrites, []);
});

test('未展开详情时往返运行与会话仍只有一个共享详情节点', async () => {
  const h=harness(); h.hooks.render();
  h.state.viewChild='session'; await h.hooks.load(true);
  for(let cycle=0;cycle<2;cycle++){
    assert.equal(h.all().filter(node=>node.id==='nativeTraceDetail').length,1);
    h.state.viewChild='runs';h.hooks.render();
    assert.equal(h.all().filter(node=>node.id==='nativeTraceDetail').length,1);
    h.state.viewChild='session';h.hooks.render();
  }
});
