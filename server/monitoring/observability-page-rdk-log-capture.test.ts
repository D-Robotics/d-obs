import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_RDK_LOG_CAPTURE_SCRIPT } from './observability-page-rdk-log-capture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const nodes = new Map<string, any>();
  const requests: Array<{ path: string; options: any }> = [];
  const htmlWrites: unknown[] = [];
  const timers = new Map<number, () => void>();
  const downloads: string[] = [];
  let timer = 0;
  const element = (tag: string = 'div', text: string = ''): any => {
    const node: any = { tagName: tag, textContent: text, value: '', disabled: false, hidden: false, dataset: {}, children: [], listeners: {},
      appendChild(child: any) { node.children.push(child); return child; },
      prepend(child: any) { node.children.unshift(child); },
      replaceChildren() { node.children = []; },
      addEventListener(event: string, fn: (...args: any[]) => any) { node.listeners[event] = fn; },
      scrollIntoView() {}, remove() {}, click() { downloads.push(node.download); },
    };
    Object.defineProperty(node, 'innerHTML', { set(value) { htmlWrites.push(value); } });
    return node;
  };
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)!; };
  node('rdkLogsDuration').value = '300';
  const state = { viewSource: 'devices/logs' };
  const session = { id: 'session-1', sourceId: 'kernel', sourceLabel: '内核日志', state: 'running' };
  const capture = { id: 'capture-1', targetId: 'x5', targetLabel: '实验室 X5', profileId: 'x5-isp', question: '相机启动超时', sessions: [session], markers: [] };
  let read: (path: string, options: any) => Promise<any> = async (path) => {
    if (path.endsWith('/targets')) return { targets: [{ id: 'x5', label: '实验室 X5' }] };
    if (path.endsWith('/profiles')) return { profiles: [{ id: 'x5-isp', label: 'X5 ISP 调试' }, { id: 'runtime', label: '运行日志' }] };
    if (path.endsWith('/capabilities')) return { modelEnabled: false };
    if (path.endsWith('/captures')) return { captures: [] };
    return { capture, streams: [], hasMore: false };
  };
  let blob: () => Promise<any> = async () => ({ size: 10 });
  const context = vm.createContext({
    $: node, make: (tag: string, _className?: string, text?: string) => element(tag, text), when: String,
    state, SSH_LOGS_API: '/api/ops/observability/ssh-logs',
    sshLogsVisible: () => state.viewSource === 'devices/logs',
    sshLogsActive: (row: any) => ['running', 'connecting'].includes(row?.state),
    sshLogsStateLabel: (value: string) => value, sshLogsStopReason: (value: string) => value,
    sshLogsError: () => '操作失败',
    sshLogsSetOptions: (target: any, rows: any[], value: string, empty: string) => {
      target.replaceChildren(); rows.forEach((row) => target.appendChild(Object.assign(element('option', row.label), { value: row.id })));
      target.value = rows.some((row) => row.id === value) ? value : empty ? '' : rows[0]?.id || '';
    },
    request: (path: string, options: any) => { requests.push({ path, options }); return read(path, options); },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id),
    setView: (view: string) => { state.viewSource = view; }, applyAuthMode() {}, obsLogout: async () => {}, obsActiveTenant: () => '',
    document: { body: element(), addEventListener() {} }, base: '', apiHeaders: () => ({}),
    fetch: async () => ({ ok: true, blob }), URL: { createObjectURL: () => 'blob:bundle', revokeObjectURL() {} },
  });
  vm.runInContext(OPS_RDK_LOG_CAPTURE_SCRIPT + '\n globalThis.hooks={ui:rdkLogsUi,load:loadRdkLogsView,poll:pollRdkLogs,select:selectRdkLogsCapture,render:renderRdkLogs,plan:planRdkLogs,start:startRdkLogs,analyze:analyzeRdkLogs,reference:openRdkLogsReference,export:exportRdkLogsBundle,auth:applyAuthMode,logout:obsLogout,setView,invalidate:invalidateRdkLogsPlan};', context);
  return { hooks: (context as any).hooks, node, state, capture, session, requests, timers, htmlWrites, downloads,
    setRead: (next: typeof read) => { read = next; }, setBlob: (next: typeof blob) => { blob = next; } };
}

function flatten(node: any): string {
  return [node.textContent, ...(node.children || []).map(flatten)].join('');
}

test('RDK 调查接入真实页面，未配置设备显示接入说明且不造示例设备', async () => {
  assert.match(OPS_OBSERVABILITY_HTML, /id="rdkLogsObjective"/);
  assert.match(OPS_OBSERVABILITY_HTML, /单源采集 · 自行选择日志源/);
  const h = harness();
  h.setRead(async (path) => path.endsWith('/profiles') ? { profiles: [{ id: 'runtime', label: '运行日志' }] } : path.endsWith('/capabilities') ? { modelEnabled: false } : path.endsWith('/targets') ? { targets: [] } : { captures: [] });
  await h.hooks.load();
  assert.match(h.node('rdkLogsMessage').textContent, /尚未接入设备/);
  assert.equal(h.node('rdkLogsSetup').hidden, false);
  assert.equal(h.node('rdkLogsTarget').children.length, 0);
  assert.equal(h.node('rdkLogsPlan').disabled, true);
  assert.equal(h.node('rdkLogsStart').disabled, true);
});

test('计划由自然语言目标与模板生成，启动只提交可审查来源 ID', async () => {
  const h = harness();
  h.node('rdkLogsTarget').value = 'x5'; h.node('rdkLogsProfile').value = 'x5-isp'; h.node('rdkLogsObjective').value = '相机启动超时';
  h.setRead(async (path, options) => path.endsWith('/plan') ? { plan: { targetId: 'x5', profileId: 'x5-isp', question: '相机启动超时', ready: true, sources: [{ id: 'kernel', label: '内核日志' }, { id: 'media', label: '媒体日志' }], warnings: ['设备媒体日志可用'] } } : path.endsWith('/captures') && options?.method === 'POST' ? { capture: h.capture } : { capture: h.capture, streams: [], hasMore: false });
  await h.hooks.plan();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { targetId: 'x5', profileId: 'x5-isp', question: '相机启动超时' });
  assert.match(flatten(h.node('rdkLogsPlanSources')), /内核日志媒体日志/);
  assert.equal(h.node('rdkLogsStart').disabled, false);
  await h.hooks.start();
  const start = h.requests.find((row) => row.path.endsWith('/captures') && row.options?.method === 'POST')!;
  assert.deepEqual(JSON.parse(start.options.body), { targetId: 'x5', profileId: 'x5-isp', question: '相机启动超时', sourceIds: ['kernel', 'media'], lines: 200, durationSeconds: 300 });
  assert.equal(h.hooks.ui.selectedId, h.capture.id);
  h.hooks.invalidate();
  assert.equal(h.hooks.ui.plan, null);
});

test('多源读取不重叠，各来源游标独立推进，窗口有界，离开页面停止轮询', async () => {
  const h = harness();
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture, hasMore: true });
  const pending = deferred<any>(); h.setRead(async () => pending.promise);
  const first = h.hooks.poll(); await h.hooks.poll();
  assert.equal(h.requests.length, 1);
  pending.resolve({ capture: h.capture, streams: [{ session: h.session, records: Array.from({ length: 2001 }, (_, index) => ({ seq: index + 1, text: '<img onerror=alert(1)> ' + index + '\n', receivedAt: '2026-10-10T00:00:00Z' })), cursor: 2001, hasMore: false }], hasMore: false });
  await first;
  assert.equal(h.hooks.ui.cursors['session-1'], 2001);
  assert.equal(h.hooks.ui.records.length, 2000);
  assert.equal(h.hooks.ui.dropped, 1);
  assert.equal(h.htmlWrites.length, 0);
  h.node('rdkLogsFilter').value = 'onerror'; h.hooks.render();
  assert.equal(h.hooks.ui.cursors['session-1'], 2001);
  assert.equal(h.timers.size, 1);
  h.hooks.setView('devices/list');
  assert.equal(h.timers.size, 0);
});

test('模型未配置仅调用证据模式，真实 AI 分析标签与证据模式严格区分', async () => {
  const h = harness();
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture, capabilities: { modelEnabled: false } });
  h.setRead(async () => ({ analysis: { source: 'evidence', headline: '需要继续采集', hypotheses: [], missingEvidence: ['未采集媒体日志'] } }));
  h.hooks.render();
  assert.match(h.node('rdkLogsModel').textContent, /AI 模型待配置/);
  await h.hooks.analyze();
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { mode: 'evidence' });
  assert.match(flatten(h.node('rdkLogsAnalysis')), /证据分析 · 未调用 AI 模型/);
  h.hooks.ui.capabilities.modelEnabled = true;
  await h.hooks.analyze('evidence');
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { mode: 'evidence' });
  h.hooks.ui.analysis = { source: 'model', headline: '相机链路需要检查', hypotheses: [] }; h.hooks.render();
  assert.match(flatten(h.node('rdkLogsAnalysis')), /AI 模型分析 · 请核对引用/);
});

test('AI 调用失败不生成假分析，并保留可切换的证据分析按钮', async () => {
  const h = harness();
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture, capabilities: { modelEnabled: true } });
  h.setRead(async () => { throw new Error('rdk_log_model_unavailable'); });
  await h.hooks.analyze();
  assert.equal(h.hooks.ui.analysis, null);
  assert.match(h.node('rdkLogsMessage').textContent, /AI 模型暂时不可用/);
  assert.equal(h.node('rdkLogsAnalyzeEvidence').hidden, false);
});

test('证据引用读取保留原文，按来源与序号定位并安全展示', async () => {
  const h = harness();
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture });
  h.setRead(async () => ({ records: [{ seq: 3, text: 'VIN time' }, { seq: 4, text: 'out <script>bad</script>\n' }, { seq: 5, text: 'outside range' }] }));
  await h.hooks.reference('E1', [{ ref: 'E1', sessionId: 'session-1', sourceLabel: '内核日志', seqFrom: 3, seqTo: 4 }]);
  assert.equal(h.requests[0].path, '/api/ops/observability/ssh-logs/sessions/session-1?after=2&limit=2');
  assert.equal(h.hooks.ui.reference.text, 'VIN timeout <script>bad</script>\n');
  assert.match(flatten(h.node('rdkLogsEvidence')), /E1.*原始输出 #3–4/);
  assert.equal(h.htmlWrites.length, 0);
});

test('按来源拼接原始片段后筛选，分片边界不会漏掉同一行的关键词', () => {
  const h = harness();
  h.hooks.ui.records = [
    { sessionId: 'one', sourceLabel: '内核', seq: 1, text: 'VIN time', receivedAt: '2026-10-10T00:00:00Z' },
    { sessionId: 'two', sourceLabel: '应用', seq: 1, text: 'interleaved\n', receivedAt: '2026-10-10T00:00:00Z' },
    { sessionId: 'one', sourceLabel: '内核', seq: 2, text: 'out\nready\n', receivedAt: '2026-10-10T00:00:01Z' },
  ];
  h.node('rdkLogsFilter').value = 'timeout'; h.hooks.render();
  const shown = flatten(h.node('rdkLogsEvidence'));
  assert.match(shown, /VIN timeout/);
  assert.doesNotMatch(shown, /interleaved|ready/);
  assert.equal(h.hooks.ui.records.length, 3);
});

test('身份变更立刻清空目标和证据，并丢弃旧轮询、AI分析与导出结果', async () => {
  const h = harness(); h.hooks.auth({ user: { id: 'one' }, admin: true });
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture, records: [{ text: 'private' }], capabilities: { modelEnabled: true } });
  h.node('rdkLogsObjective').value = 'private question';
  const readPending = deferred<any>(); h.setRead(async () => readPending.promise);
  const poll = h.hooks.poll(); const analyze = h.hooks.analyze();
  h.hooks.auth({ user: { id: 'two' }, admin: true });
  assert.equal(h.hooks.ui.selectedId, ''); assert.equal(h.hooks.ui.records.length, 0); assert.equal(h.node('rdkLogsObjective').value, '');
  readPending.resolve({ capture: h.capture, streams: [{ session: h.session, records: [{ seq: 1, text: 'old log' }], cursor: 1 }], analysis: { source: 'model', headline: 'private conclusion' } });
  await Promise.all([poll, analyze]);
  assert.equal(h.hooks.ui.analysis, null); assert.equal(h.hooks.ui.records.length, 0);
  Object.assign(h.hooks.ui, { selectedId: h.capture.id, capture: h.capture });
  const downloadPending = deferred<any>(); h.setBlob(async () => downloadPending.promise);
  const exporting = h.hooks.export(); await Promise.resolve(); h.hooks.logout();
  downloadPending.resolve({ size: 10 }); await exporting;
  assert.equal(h.downloads.length, 0);
});

test('旧身份的能力加载结果不会覆盖新身份的加载状态与设备列表', async () => {
  const h = harness(); h.hooks.auth({ user: { id: 'one' }, admin: true });
  const old = deferred<any>(); h.setRead(async () => old.promise); const first = h.hooks.load();
  h.hooks.auth({ user: { id: 'two' }, admin: true });
  const fresh = deferred<any>(); h.setRead(async () => fresh.promise); const second = h.hooks.load();
  old.resolve({ targets: [{ id: 'private', label: 'private' }] }); await first;
  assert.equal(h.hooks.ui.loading, true); assert.equal(h.hooks.ui.targets.length, 0);
  fresh.resolve({ targets: [], profiles: [], captures: [], modelEnabled: false }); await second;
  assert.equal(h.hooks.ui.loading, false); assert.equal(h.hooks.ui.targets.length, 0);
});
