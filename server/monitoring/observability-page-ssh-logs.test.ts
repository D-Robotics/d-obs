import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_OBSERVABILITY_SCRIPT_SSH_LOGS } from './observability-page-ssh-logs.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const nodes = new Map<string, any>();
  const innerHTMLWrites: unknown[] = [];
  const requests: Array<{ path: string; options: any }> = [];
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, () => void>();
  const downloads: string[] = [];
  let nextTimer = 1;
  const element = (tag = 'div', text = ''): any => {
    const classes = new Set<string>();
    const node: any = { tagName: tag, textContent: text, value: '', checked: false,
      disabled: false, dataset: {}, children: [], listeners: {},
      appendChild(child: any) { node.children.push(child); return child; },
      replaceChildren() { node.children = []; },
      addEventListener(event: string, callback: (...args: any[]) => any) { node.listeners[event] = callback; },
      remove() {}, click() { downloads.push(node.download); },
      classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name) },
    };
    Object.defineProperty(node, 'innerHTML', { set(value) { innerHTMLWrites.push(value); } });
    return node;
  };
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  node('sshLogsDuration').value = '300';
  node('sshLogsLines').value = '200';
  node('sshLogsAutoScroll').checked = true;
  const state = { viewSource: 'overview' };
  const session = { id: 'capture-1', targetId: 'x5', targetLabel: 'RDK X5', sourceId: 'kernel', sourceLabel: '内核日志', state: 'running', startedAt: '2026-10-10T00:00:00Z', recordCount: 0, byteCount: 0 };
  let read: (path: string, options?: unknown) => Promise<any> = async (path) => {
    if (path.endsWith('/targets')) return { ok: true, targets: [{ id: 'x5', label: 'RDK X5', sources: [{ id: 'kernel', label: '内核日志', type: 'kernel' }] }] };
    if (path.endsWith('/sessions')) return { ok: true, sessions: [] };
    return { ok: true, session, records: [], cursor: 0, hasMore: false };
  };
  let blob: () => Promise<unknown> = async () => ({ size: 10 });
  const context = vm.createContext({
    state, $: node, make: (tag: string, _className?: string, text?: string) => element(tag, text),
    when: (value: unknown) => String(value),
    request: (path: string, options?: unknown) => { requests.push({ path, options }); return read(path, options); },
    apiHeaders: () => ({ 'x-admin-token': 'test-token' }), base: '/dobs',
    document: { visibilityState: 'visible', body: element(), addEventListener: (event: string, callback: () => void) => listeners.set(event, callback) },
    setTimeout: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    setView: (requested: string) => { state.viewSource = requested; },
    obsLogout: async () => {}, applyAuthMode: () => false, obsActiveTenant: () => '', renderAccess: () => {},
    fetch: async () => ({ ok: true, status: 200, blob }),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_SSH_LOGS + '\n globalThis.hooks={ui:sshLogsUi,load:loadSshLogsView,poll:pollSshLogs,select:selectSshLogsSession,render:renderSshLogs,start:startSshLogs,stop:stopSshLogs,export:exportSshLogs,setView,auth:applyAuthMode,logout:obsLogout};', context);
  const hooks = (context as any).hooks;
  return { hooks, state, session, node, requests, timers, innerHTMLWrites, downloads, listeners,
    setRead: (next: typeof read) => { read = next; }, setBlob: (next: typeof blob) => { blob = next; } };
}

test('SSH 日志页接入设备子模块，且仅在进入日志页后读取设备与会话', async () => {
  assert.match(OPS_OBSERVABILITY_HTML, /data-module-tab="devices\/logs"/);
  assert.match(OPS_OBSERVABILITY_HTML, /data-view-module="devices\/logs"/);
  const h = harness();
  assert.equal(h.requests.length, 0);
  await h.hooks.load();
  assert.equal(h.requests.length, 0);
  h.state.viewSource = 'devices/logs';
  await h.hooks.load();
  assert.deepEqual(h.requests.map(({ path }) => path), ['/api/ops/observability/ssh-logs/targets', '/api/ops/observability/ssh-logs/sessions']);
  assert.equal(h.node('sshLogsStart').disabled, false);
  h.hooks.ui.session = h.session;
  h.hooks.render();
  assert.equal(h.node('sshLogsStart').disabled, true);
  assert.equal(h.node('sshLogsStop').disabled, false);
});

test('SSH 深链的令牌登录验证独立于中心库，其他页面保持原验证路径', () => {
  const generatedHelper = OPS_OBSERVABILITY_HTML.match(/function accessVerificationPath\(\)\{[^}]+\}/)?.[0];
  assert.ok(generatedHelper, '最终 HTML 应包含登录验证路径选择函数');
  assert.match(OPS_OBSERVABILITY_HTML, /fetch\(base\+accessVerificationPath\(\),/);
  const resolve = new Function('state', generatedHelper + ';return accessVerificationPath()');
  assert.equal(resolve({ view: 'devices', viewChild: 'logs' }), '/api/ops/observability/ssh-logs/targets');
  for (const state of [{ view: 'overview' }, { view: 'devices', viewChild: 'list' }, { view: 'signals', viewChild: 'logs' }]) {
    assert.equal(resolve(state), '/api/ops/observability/access');
  }
});

test('日志按原始输出拼接且不会执行 HTML；筛选不推进或重置读取游标', () => {
  const h = harness();
  h.hooks.ui.records = [{ seq: 1, text: '<img src=x onerror=alert(1)>\nIS' }, { seq: 2, text: 'P error\nplain\n' }];
  h.hooks.ui.cursor = 2;
  h.hooks.render();
  assert.equal(h.node('sshLogsOutput').textContent, '<img src=x onerror=alert(1)>\nISP error\nplain\n');
  assert.deepEqual(h.innerHTMLWrites, []);
  h.node('sshLogsFilter').value = 'ISP';
  h.hooks.render();
  assert.equal(h.node('sshLogsOutput').textContent, 'ISP error');
  assert.equal(h.hooks.ui.cursor, 2);
  assert.equal(h.hooks.ui.records.length, 2);
});

test('实时读取不重叠，游标继续推进，浏览器窗口有界且离开页面暂停轮询', async () => {
  const h = harness();
  h.state.viewSource = 'devices/logs';
  Object.assign(h.hooks.ui, { selectedId: h.session.id, session: h.session, hasMore: true });
  const pending = deferred<any>();
  h.setRead(async () => pending.promise);
  const first = h.hooks.poll();
  await h.hooks.poll();
  assert.equal(h.requests.length, 1);
  pending.resolve({ ok: true, session: h.session, records: Array.from({ length: 2_001 }, (_, index) => ({ seq: index + 1, text: String(index) + '\n' })), cursor: 2_001, hasMore: false });
  await first;
  assert.equal(h.hooks.ui.cursor, 2_001);
  assert.equal(h.hooks.ui.records.length, 2_000);
  assert.equal(h.hooks.ui.dropped, 1);
  assert.match(h.node('sshLogsWindow').textContent, /已移出 1 段/);
  assert.equal(h.timers.size, 1);
  h.hooks.setView('devices/list');
  assert.equal(h.timers.size, 0);
});

test('账号切换立即清空日志，并丢弃旧读取与导出的异步结果', async () => {
  const h = harness();
  h.state.viewSource = 'devices/logs';
  h.hooks.auth({ user: { id: 'operator-1' }, admin: true });
  Object.assign(h.hooks.ui, { selectedId: h.session.id, session: h.session, records: [{ text: 'private runtime log' }] });
  const readPending = deferred<any>();
  const blobPending = deferred<unknown>();
  h.setRead(async () => readPending.promise);
  h.setBlob(async () => blobPending.promise);
  const reading = h.hooks.poll();
  const exporting = h.hooks.export();
  await Promise.resolve();
  h.hooks.auth({ user: { id: 'operator-2' }, admin: true });
  assert.equal(h.hooks.ui.selectedId, '');
  assert.equal(h.hooks.ui.records.length, 0);
  assert.equal(h.node('sshLogsOutput').textContent, '尚未采集日志');
  assert.equal(h.node('sshLogsRefresh').disabled, false);
  readPending.resolve({ ok: true, session: h.session, records: [{ seq: 1, text: 'old operator log' }], cursor: 1 });
  blobPending.resolve({ size: 10 });
  await Promise.all([reading, exporting]);
  assert.equal(h.hooks.ui.records.length, 0);
  assert.equal(h.downloads.length, 0);
});

test('旧身份的设备加载结果不会恢复设备列表或影响新请求的加载状态', async () => {
  const h = harness();
  h.state.viewSource = 'devices/logs';
  h.hooks.auth({ user: { id: 'operator-1' }, admin: true });
  const oldPending = deferred<any>();
  h.setRead(async () => oldPending.promise);
  const oldLoad = h.hooks.load();
  h.hooks.auth({ user: { id: 'operator-2' }, admin: true });
  const newPending = deferred<any>();
  h.setRead(async () => newPending.promise);
  const newLoad = h.hooks.load();
  oldPending.resolve({ targets: [{ id: 'private-device', label: 'Private device' }], sessions: [] });
  await oldLoad;
  assert.equal(h.hooks.ui.loading, true);
  assert.equal(h.hooks.ui.targets.length, 0);
  newPending.resolve({ targets: [], sessions: [] });
  await newLoad;
  assert.equal(h.hooks.ui.loading, false);
  assert.equal(h.node('sshLogsRefresh').disabled, false);
});

test('未配置 SSH 设备时显示管理员接入提示并禁用采集', async () => {
  const h = harness();
  h.state.viewSource = 'devices/logs';
  h.setRead(async (path) => path.endsWith('/targets') ? { targets: [] } : { sessions: [] });
  await h.hooks.load();
  assert.match(h.node('sshLogsMessage').textContent, /尚未配置 SSH 设备/);
  assert.match(h.node('sshLogsMessage').textContent, /RDK_SSH_LOG_TARGETS/);
  assert.equal(h.node('sshLogsStart').disabled, true);
});

test('开始采集只发送设备与来源 ID，停止使用当前会话并读取剩余输出', async () => {
  const h = harness();
  h.state.viewSource = 'devices/logs';
  h.node('sshLogsTarget').value = 'x5';
  h.node('sshLogsSource').value = 'kernel';
  h.setRead(async (path, options: any) => {
    if (path.endsWith('/sessions') && options?.method === 'POST') return { session: h.session };
    if (path.endsWith('/stop')) return { session: { ...h.session, state: 'stopped', stopReason: 'user' } };
    return { session: h.session, records: [{ seq: 1, text: 'ISP ready\n' }], cursor: 1, hasMore: false };
  });
  await h.hooks.start();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { targetId: 'x5', sourceId: 'kernel', lines: 200, durationSeconds: 300, follow: true });
  assert.equal(h.hooks.ui.selectedId, h.session.id);
  await h.hooks.stop();
  assert.ok(h.requests.some((call) => call.path.endsWith('/capture-1/stop') && call.options.method === 'POST'));
});
