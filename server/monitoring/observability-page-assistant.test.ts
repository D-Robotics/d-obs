import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_ASSISTANT_STYLE, OPS_OBSERVABILITY_SCRIPT_ASSISTANT } from './observability-page-assistant.js';

type Event = { target: Element; key?: string; shiftKey?: boolean; isComposing?: boolean; preventDefault(): void; stopImmediatePropagation?(): void };
class Element {
  id = '';
  className = '';
  value = '';
  type = '';
  href = '';
  download = '';
  hidden = false;
  disabled = false;
  inert = false;
  open = false;
  children: Element[] = [];
  parent: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: Event) => unknown>>();
  private text = '';
  private classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
  constructor(readonly tagName: string, private readonly setFocus: (element: Element) => void) {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error('Assistant rendering must use safe DOM'); }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceChildren() { this.children.forEach(child => { child.parent = null; }); this.children = []; this.text = ''; }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(name: string, callback: (event: Event) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  dispatch(name: string, event: Partial<Event> = {}) { return this.listeners.get(name)?.map(callback => callback({ target: this, preventDefault() {}, ...event })); }
  click() { return this.dispatch('click'); }
  focus() { this.setFocus(this); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  get nextElementSibling(): Element | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
    const tag = selector.split(/[:\[]/)[0];
    return (!tag || this.tagName === tag.toUpperCase()) && attributes.every(([, key, value]) => this.attributes.has(key) && (value === undefined || this.getAttribute(key) === value)) && (!selector.includes(':not([disabled])') || !this.disabled);
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  contains(element: Element) { return element === this || this.descendants().includes(element); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector: string): Element[] {
    return this.descendants().filter(element => selector.split(',').some(part => {
      const value = part.trim();
      // Disabled is represented by a property in this small DOM fixture.
      return element.matches(value.replace(':not([disabled])', '')) && (!value.includes(':not([disabled])') || !element.disabled);
    }));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function harness(storage = new Map<string, string>()) {
  let active: Element | null = null;
  const downloads: Array<{ href: string; filename: string }> = [];
  const blobUrls: unknown[] = [];
  const revoked: string[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const create = (tag: string) => {
    const element = new Element(tag.toUpperCase(), element => { active = element; });
    if (tag === 'a') element.click = () => { downloads.push({ href: element.href, filename: element.download }); return []; };
    return element;
  };
  const body = create('body');
  const main = body.appendChild(create('main'));
  const previous = main.appendChild(create('button')); previous.focus();
  const docListeners = new Map<string, (event: Event) => unknown>();
  const requests: Array<{ path: string; options: { method: string; credentials: string; headers: Record<string, string>; body?: string; redirect?: string } }> = [];
  let tenant = 'team-a';
  let capabilities: Record<string, unknown> = { ok: true, modelEnabled: true, operations: [] };
  let chat: () => Promise<{ status: number; data: unknown }> = async () => ({ status: 200, data: { ok: true, reply: '真实回复', operations: [] } });
  let tasks: () => Promise<{ status: number; data: unknown }> = async () => ({ status: 200, data: { ok: true, tasks: [] } });
  let detail: () => Promise<{ status: number; data: unknown }> = async () => ({ status: 404, data: { ok: false, error: 'assistant_task_not_found' } });
  let feedback: () => Promise<{ status: number; data: unknown }> = async () => ({ status: 200, data: { ok: true } });
  type DownloadReply = { status: number; data?: unknown; headers?: Record<string, string>; blob?: unknown };
  let download: () => Promise<DownloadReply> = async () => ({ status: 200, headers: { 'content-type': 'application/json' }, blob: { size: 10 } });
  class DownloadUrl extends URL {
    static createObjectURL(blob: unknown) { blobUrls.push(blob); return 'blob:fixture-download'; }
    static revokeObjectURL(value: string) { revoked.push(value); }
  }
  const auth = { version: 1, me: { admin: true, user: { id: 'operator-a' } } };
  const pageState: Record<string, unknown> = { view: 'devices', viewSource: 'devices/logs' };
  const context = vm.createContext({
    document: { body, createElement: create, getElementById: (id: string) => body.querySelector('#' + id), get activeElement() { return active; }, addEventListener: (name: string, callback: (event: Event) => unknown) => docListeners.set(name, callback) },
    state: pageState, obsAuthState: auth,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    opsTenantMode: false, opsMemberMode: false, obsActiveTenant: () => tenant, adminTenantQuery: () => tenant ? '&tenant=' + encodeURIComponent(tenant) : '',
    base: '/dobs', apiHeaders: (mutating: boolean) => ({ 'content-type': 'application/json', 'x-rdk-sso-session': 'fixture-session', ...(mutating ? { 'X-RDK-Ops-Action': 'observability' } : {}) }),
    location: { href: 'https://platform.example/dobs/ops-observability', origin: 'https://platform.example' }, URL: DownloadUrl,
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); },
    fetch: async (path: string, options: (typeof requests)[number]['options']) => {
      requests.push({ path, options });
      const result: DownloadReply = path.includes('/capabilities') ? { status: 200, data: capabilities } : /\/assistant\/tasks(?:\?|$)/.test(path) ? await tasks() : path.includes('/assistant/tasks/') ? path.includes('/feedback') ? await feedback() : await detail() : options.method === 'GET' ? await download() : await chat();
      return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.data, blob: async () => result.blob, headers: { get: (name: string) => result.headers?.[name] ?? null } };
    },
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_ASSISTANT + '\n globalThis.assistant = PlatformAssistant;', context);
  const assistant = (context as any).assistant as { open(): void; close(): void; submit(): Promise<void>; loadCapabilities(): Promise<void>; gatherWorkContext(): Record<string, unknown>; loadTasks(): Promise<void>; restoreTask(id: string): Promise<void>; startNewTask(): void; submitFeedback(rating: string): Promise<void> };
  const node = (id: string) => { const found = body.querySelector('#' + id); assert.ok(found, id); return found; };
  const input = node('platformAssistantInput');
  const panel = node('platformAssistantDialog');
  const log = panel.querySelector('.platform-assistant-conversation')!;
  return { assistant, body, main, panel, input, log, requests, auth, node, downloads, blobUrls, revoked, timers, storage, pageState, create, focused: () => active,
    setTenant: (value: string) => { tenant = value; },
    setCapabilities: (value: Record<string, unknown>) => { capabilities = value; },
    setChat: (handler: typeof chat) => { chat = handler; },
    setTasks: (handler: typeof tasks) => { tasks = handler; },
    setDetail: (handler: typeof detail) => { detail = handler; },
    setFeedback: (handler: typeof feedback) => { feedback = handler; },
    setDownload: (handler: typeof download) => { download = handler; },
    key: (key: string, shiftKey = false) => docListeners.get('keydown')?.({ target: panel, key, shiftKey, preventDefault() {} }),
    send: async (message: string) => { input.value = message; input.dispatch('input'); await assistant.submit(); },
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('助手脚本可编译，自行挂载抽屉，支持焦点圈定与关闭归还', async () => {
  assert.doesNotThrow(() => new vm.Script(OPS_OBSERVABILITY_SCRIPT_ASSISTANT));
  const h = harness();
  assert.equal(h.node('platformAssistantTrigger').getAttribute('aria-controls'), 'platformAssistantDialog');
  assert.equal(h.panel.getAttribute('role'), 'dialog');
  assert.equal(h.panel.getAttribute('aria-modal'), 'true');
  h.assistant.open(); await flush();
  assert.equal(h.main.inert, true);
  assert.equal(h.focused(), h.input);
  const buttons = h.panel.querySelectorAll('button');
  buttons[0].focus(); h.key('Tab', true);
  assert.equal(h.focused(), h.input, '发送按钮禁用时，焦点回到最后的输入框');
  h.key('Escape');
  assert.equal(h.main.inert, false);
  assert.equal(h.body.classList.contains('platform-assistant-open'), false);
  assert.match(OPS_OBSERVABILITY_ASSISTANT_STYLE, /@media\(max-width:600px\)/);
  assert.match(OPS_OBSERVABILITY_ASSISTANT_STYLE, /\[hidden\].*display:none!important/);
});

test('能力按组展示，未配置模型说明真实，建议只填入草稿且内容安全', async () => {
  const h = harness(); const hostile = '<img src=x onerror=alert(1)>';
  h.setCapabilities({ ok: true, modelEnabled: false, operations: [
    { id: 'query_logs', group: '观测查询', description: hostile, mutating: false, parameters: { service: '服务名称' } },
    { id: 'create_board', group: '自定义看板', description: '创建看板', mutating: true },
  ] });
  h.assistant.open(); await flush();
  assert.match(h.panel.textContent, /AI 模型未启用，暂时无法通过对话执行操作/);
  assert.match(h.panel.textContent, /观测查询 · 1 项/);
  assert.match(h.panel.textContent, /自定义看板 · 1 项/);
  assert.match(h.panel.textContent, /所需参数/);
  assert.ok(h.panel.textContent.includes(hostile));
  const suggestions = h.panel.querySelectorAll('.platform-assistant-suggestion');
  suggestions[0].click();
  assert.ok(h.input.value.includes(hostile));
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.equal(h.focused(), h.input);
});

test('聊天请求复用身份及管理员租户视角，历史不超过12条，不重复提交本轮问题', async () => {
  const h = harness();
  for (let index = 0; index < 8; index++) await h.send('查看日志 ' + index);
  const last = h.requests.at(-1)!;
  assert.equal(last.path, '/dobs/api/ops/observability/assistant/chat?tenant=team-a');
  assert.equal(last.options.credentials, 'same-origin');
  assert.equal(last.options.headers['x-rdk-sso-session'], 'fixture-session');
  assert.equal(last.options.headers['X-RDK-Ops-Action'], 'observability');
  const payload = JSON.parse(last.options.body!);
  assert.equal(payload.message, '查看日志 7');
  assert.deepEqual(payload.context, { view: 'devices/logs', tenant: 'team-a' });
  assert.equal(payload.history.length, 12);
  assert.equal(payload.history.at(-1).role, 'assistant');
  assert.equal(payload.history.some((message: { content: string }) => message.content === payload.message), false);
  assert.deepEqual(Object.keys(payload.history[0]).sort(), ['content', 'role']);
});

test('失败工具回执清晰保留，不因助手文字而显示操作成功，不执行HTML', async () => {
  const h = harness(); const hostile = '<script>alert(1)</script>';
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: hostile, operations: [
    { id: 'create_board', description: '创建看板', status: 'failed', ok: false, data: { error: 'missing_ops_action_guard', raw: hostile } },
    { id: 'query_logs', description: '查看日志', status: 'success', ok: true, data: { logs: [] } },
  ] } }));
  await h.send('创建看板并查看日志');
  assert.match(h.log.textContent, /未完成 · 创建看板/);
  assert.match(h.log.textContent, /已完成 · 查看日志/);
  assert.match(h.log.textContent, /missing_ops_action_guard/);
  assert.ok(h.log.textContent.includes(hostile));
  assert.equal(h.log.querySelectorAll('script').length, 0);
});

test('忙状态阻止重复提交，关闭仍可完成原操作，完成后可以清空', async () => {
  const h = harness(); let resolve!: (value: { status: number; data: unknown }) => void;
  h.setChat(() => new Promise(done => { resolve = done; }));
  h.assistant.open(); await flush();
  h.input.value = '查看设备'; const pending = h.assistant.submit();
  await h.assistant.submit();
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  const clear = h.panel.querySelectorAll('button').find(button => button.textContent === '清空')!;
  assert.equal(clear.disabled, true);
  h.assistant.close();
  resolve({ status: 200, data: { ok: true, reply: '设备查询完成', operations: [] } }); await pending;
  assert.match(h.log.textContent, /设备查询完成/);
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  clear.click();
  assert.doesNotMatch(h.log.textContent, /设备查询完成/);
});

test('失败请求显示真实失败并保留问题，重新发送不把假答复送进历史', async () => {
  const h = harness();
  h.setChat(async () => ({ status: 403, data: { ok: false, error: 'tenant_read_only' } }));
  await h.send('修改规则');
  assert.match(h.log.textContent, /操作未完成/);
  assert.match(h.log.textContent, /没有执行此操作的权限/);
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '查询完成', operations: [] } }));
  await h.send('查看规则');
  const history = JSON.parse(h.requests.at(-1)!.options.body!).history;
  assert.equal(history.some((message: { role: string }) => message.role === 'assistant'), false);
});

test('HTTP 200的回答校验失败保留成功读取回执，但不作为可信回答送进下一轮历史', async () => {
  const h = harness();
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '回答未核实（platform_assistant_unverified_completion）',
    operations: [{ id: 'GET /api/ops/observability/model-pool', description: '读取模型池', status: 200, ok: true, data: { count: 5 } }] } }));
  await h.send('目前rdkstudio背后模型池情况');
  assert.match(h.log.textContent, /答复未完成/);
  assert.match(h.log.textContent, /已完成 · 读取模型池/);
  assert.match(h.log.textContent, /count/);
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '重新读取模型池', operations: [] } }));
  await h.send('再查一次');
  const history = JSON.parse(h.requests.at(-1)!.options.body!).history;
  assert.equal(history.some((message: { role: string }) => message.role === 'assistant'), false);
});

test('租户或身份变化丢弃晚到回复，清除历史且重新读取能力', async () => {
  const h = harness(); let resolve!: (value: { status: number; data: unknown }) => void;
  h.setChat(() => new Promise(done => { resolve = done; }));
  h.assistant.open(); await flush();
  h.input.value = '原租户日志'; const pending = h.assistant.submit();
  h.setTenant('team-b'); h.auth.version++;
  resolve({ status: 200, data: { ok: true, reply: '原租户私有回复', operations: [] } }); await pending; await flush();
  assert.doesNotMatch(h.log.textContent, /原租户私有回复|原租户日志/);
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  assert.ok(h.requests.some(request => request.path.endsWith('/capabilities?tenant=team-b')));
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '新租户回复', operations: [] } }));
  await h.send('查看新租户日志');
  const payload = JSON.parse(h.requests.at(-1)!.options.body!);
  assert.deepEqual(payload.history, []);
  assert.equal(payload.context.tenant, 'team-b');
});

test('中文输入法组合中的Enter不提交，Shift + Enter保留换行', async () => {
  const h = harness(); h.input.value = '设备';
  h.input.dispatch('keydown', { key: 'Enter', isComposing: true });
  h.input.dispatch('keydown', { key: 'Enter', shiftKey: true });
  await flush();
  assert.equal(h.requests.length, 0);
});

test('业务根相对附件在真实/dobs页面补齐prefix，以当前身份下载并回收URL', async () => {
  const h = harness(); const blob = { size: 42 };
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '日志包已准备好', operations: [{ id: 'export', description: '导出日志', ok: true, status: 'success', data: { downloadUrl: '/api/ops/observability/rdk-logs/captures/capture-a/bundle?tenant=team-a' } }] } }));
  h.setDownload(async () => ({ status: 200, headers: { 'content-disposition': "attachment; filename*=UTF-8''%E6%97%A5%E5%BF%97%3Atrace.json", 'content-type': 'application/json' }, blob }));
  await h.send('导出日志包');
  const download = h.log.querySelector('.platform-assistant-download')!; assert.ok(download);
  await Promise.all(download.click() || []);
  const request = h.requests.at(-1)!;
  assert.equal(request.path, '/dobs/api/ops/observability/rdk-logs/captures/capture-a/bundle?tenant=team-a');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['x-rdk-sso-session'], 'fixture-session');
  assert.equal(request.options.headers['X-RDK-Ops-Action'], 'observability');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(h.blobUrls, [blob]);
  assert.deepEqual(h.downloads, [{ href: 'blob:fixture-download', filename: '日志-trace.json' }]);
  assert.equal(h.body.querySelectorAll('a').length, 0, '临时下载元素已移除');
  h.timers.forEach(timer => timer.callback());
  assert.deepEqual(h.revoked, ['blob:fixture-download']);
  assert.match(h.log.textContent, /下载已开始/);
});

test('附件拒绝跨域、越出base和编码斜线的路径，失败不触发下载', async () => {
  for (const downloadUrl of ['https://other.example/dobs/api/ops/observability/export', '/other/api/ops/observability/export', '/dobs/api/ops/auth/me', '/dobs/api/ops/observability/%2f..%2fauth/me', '/api/ops/observability/%2f..%2fauth/me', '/dobs/api/ops/observability/export#fragment']) {
    const h = harness();
    h.setChat(async () => ({ status: 200, data: { ok: true, reply: '准备下载', operations: [{ id: 'export', ok: true, data: { downloadUrl } }] } }));
    await h.send('导出'); await Promise.all(h.log.querySelector('.platform-assistant-download')!.click() || []);
    assert.equal(h.requests.length, 1, downloadUrl);
    assert.equal(h.downloads.length, 0);
    assert.match(h.log.textContent, /下载未完成：invalid_download_url/);
  }
  const h = harness();
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '准备下载', operations: [{ id: 'export', ok: true, data: { downloadUrl: '/dobs/api/ops/observability/export' } }] } }));
  h.setDownload(async () => ({ status: 503, data: { error: 'export_unavailable' } }));
  await h.send('导出'); await Promise.all(h.log.querySelector('.platform-assistant-download')!.click() || []);
  assert.equal(h.blobUrls.length, 0);
  assert.match(h.log.textContent, /下载未完成：export_unavailable/);
});

test('关闭助手保留底层模态滚动锁和原inert状态', () => {
  const h = harness(); h.main.inert = true; h.body.classList.add('opsui-modal-open');
  h.assistant.open(); h.assistant.close();
  assert.equal(h.main.inert, true);
  assert.equal(h.body.classList.contains('opsui-modal-open'), true);
});


test('变更提案只展示参数，确认才发送绑定令牌，重复点击不重试', async () => {
  const h = harness();
  const proposal = { token: 'opaque-exact-args', operationId: 'PATCH /config', description: '修改阈值', preview: '<script>untrusted</script>', expiresAt: Date.now()+300_000 };
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '此变更尚未执行。', operations: [], proposal } }));
  await h.send('修改阈值');
  assert.equal(h.requests.filter(request => request.path.includes('/confirm')).length, 0);
  assert.match(h.log.textContent, /待确认.*修改阈值/);
  assert.equal(h.log.querySelectorAll('script').length, 0);
  const confirm = h.log.querySelectorAll('button').find(button => button.textContent === '确认执行')!;
  assert.ok(confirm);
  assert.equal(confirm.disabled, false, 'chat 首个提案在请求完成后可由真实用户确认');
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '已执行确认的变更', operations: [{ id:'PATCH /config', description:'修改阈值', status:200, ok:true, data:{ok:true} }] } }));
  await Promise.all(confirm.click() ?? []);
  const request = h.requests.at(-1)!;
  assert.equal(request.path, '/dobs/api/ops/observability/assistant/confirm?tenant=team-a');
  assert.deepEqual(JSON.parse(request.options.body!), { token:'opaque-exact-args' });
  assert.match(h.log.textContent, /已完成 · 修改阈值/);
  await Promise.all(confirm.click() ?? []);
  assert.equal(h.requests.filter(request => request.path.includes('/confirm')).length, 1);
});

test('切换身份后丢弃旧提案，确认请求不会向新租户发出', async () => {
  const h = harness();
  h.setChat(async () => ({ status: 200, data: { ok: true, reply:'请确认', operations:[], proposal:{ token:'old-scope', operationId:'PATCH /config', description:'修改阈值', preview:'{}', expiresAt:Date.now()+300_000 } } }));
  await h.send('修改阈值');
  const confirm=h.log.querySelectorAll('button').find(button=>button.textContent==='确认执行')!;
  h.setTenant('team-b');
  await Promise.all(confirm.click() ?? []);
  assert.equal(h.requests.filter(request=>request.path.includes('/confirm')).length,0);
  assert.doesNotMatch(h.log.textContent,/待确认/);
});

function savedTask(overrides: Record<string, unknown> = {}) {
  return { id: 'task-a', goal: '调查当前运行为什么失败', status: 'completed', revision: 1, updatedAt: '2026-10-13T08:00:00.000Z', context: { view: 'traces/runs', tenant: 'team-a' }, history: [{ role: 'user', content: '调查当前运行' }, { role: 'assistant', content: '安全历史摘要' }], response: { reply: '已读取运行证据。', operations: [{ id: 'read_run', description: '读取运行', ok: true, status: 200, data: { runRef: 'run-real' } }] }, ...overrides };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('上下文来自当前已选运行、真实时间范围与筛选，不发送正文或凭据', async () => {
  const h = harness();
  Object.assign(h.pageState, { view: 'traces', viewSource: 'traces/runs', traceDetailLocator: 'locator-encrypted-real', traceDetailRunRef: 'run-real', traceEnvironment: 'staging', overviewHours: 2, traceQuery: 'tool.failed', traceOutcome: 'error', timeWindow: { from: '2026-10-13T08:00:00.000Z', to: '2026-10-13T10:00:00.000Z' }, traceDetailData: { prompt: 'private-prompt', logs: 'private-log', token: 'private-token' }, selectedDeviceId: 'old-device', currentBoardId: 'old-board' });
  await h.send('分析这次运行');
  const payload = JSON.parse(h.requests.at(-1)!.options.body!);
  assert.deepEqual(payload.context, { view: 'traces/runs', tenant: 'team-a', timeWindow: { hours: 2, from: '2026-10-13T08:00:00.000Z', to: '2026-10-13T10:00:00.000Z' }, environment: 'staging', selection: { runLocator: 'locator-encrypted-real', runRef: 'run-real' }, filters: { query: 'tool.failed', status: 'error' } });
  assert.equal(payload.taskId, null, '现代 UI 显式启用持久任务，旧客户端省略该字段');
  assert.match(h.node('platformAssistantWorkContext').textContent, /运行 run-real|环境 staging|最近 2 小时/);
  for (const secret of ['private-prompt', 'private-log', 'private-token', 'fixture-session', 'old-device', 'old-board']) assert.equal(JSON.stringify(payload.context).includes(secret), false);
  h.pageState.viewSource = 'overview';
  assert.equal((h.assistant.gatherWorkContext().selection as any)?.runLocator, undefined, '离开 Trace 不继承旧选择');
});

test('未选对象不从列表首项推断，真正展开的设备和选中数据集才进入上下文', () => {
  const h = harness();
  Object.assign(h.pageState, { viewSource: 'devices', devices: [{ deviceId: 'first-device' }], overviewHours: 9999, selectedDeviceId: '' });
  assert.deepEqual(plain(h.assistant.gatherWorkContext()), { view: 'devices', tenant: 'team-a' });
  const devices = h.main.appendChild(h.create('div')); devices.id = 'devicesContent';
  const detail = devices.appendChild(h.create('div')); detail.className = 'device-detail'; detail.id = 'device-detail-rdk-x5';
  assert.deepEqual(plain(h.assistant.gatherWorkContext().selection), { deviceId: 'rdk-x5' });
  h.pageState.viewSource = 'data/datasets';
  const workspace = h.main.appendChild(h.create('div')); workspace.id = 'dataCenterWorkspace';
  const unselected = workspace.appendChild(h.create('div')); unselected.setAttribute('data-dataset-id', 'first-dataset');
  assert.equal(h.assistant.gatherWorkContext().selection, undefined);
  const selected = workspace.appendChild(h.create('button')); selected.setAttribute('aria-selected', 'true'); selected.setAttribute('data-dataset-id', 'dataset-selected');
  assert.deepEqual(plain(h.assistant.gatherWorkContext().selection), { datasetId: 'dataset-selected' });
  selected.setAttribute('data-dataset-id', '<script>private</script>');
  assert.equal(h.assistant.gatherWorkContext().selection, undefined, '不接受 HTML 作为标识');
});

test('刷新后从当前身份保存的任务 ID 恢复历史和回执，下一轮沿用该任务', async () => {
  const storage = new Map<string, string>();
  const first = harness(storage); const task = savedTask();
  first.setChat(async () => ({ status: 200, data: { ok: true, reply: '已读取运行证据。', operations: task.response.operations, task } }));
  await first.send('调查当前运行');
  assert.equal(storage.size, 1);
  assert.deepEqual([...storage.values()], ['task-a']);
  assert.equal(JSON.stringify([...storage]).includes('fixture-session'), false);
  assert.equal(JSON.stringify([...storage]).includes(task.goal), false);
  const reopened = harness(storage);
  reopened.setTasks(async () => ({ status: 200, data: { ok: true, tasks: [task] } }));
  reopened.setDetail(async () => ({ status: 200, data: { ok: true, task } }));
  reopened.assistant.open(); await flush(); await flush();
  assert.match(reopened.log.textContent, /已读取运行证据|已完成 · 读取运行|run-real/);
  assert.equal(reopened.node('platformAssistantTaskSelect').value, 'task-a');
  await reopened.send('继续查工具错误');
  const payload = JSON.parse(reopened.requests.at(-1)!.options.body!);
  assert.equal(payload.taskId, 'task-a');
  assert.ok(payload.history.some((message: { content: string }) => message.content === '调查当前运行'));
  reopened.node('platformAssistantNewTask').click();
  assert.equal(storage.size, 0);
  assert.doesNotMatch(reopened.log.textContent, /已读取运行证据/);
  await reopened.send('开启新调查');
  assert.equal(JSON.parse(reopened.requests.at(-1)!.options.body!).taskId, null);
});

test('任务恢复晚到或跨租户任务 ID 不会污染新身份', async () => {
  const h = harness(); let finish!: (value: { status: number; data: unknown }) => void;
  h.assistant.open(); await flush();
  h.setDetail(() => new Promise(resolve => { finish = resolve; }));
  const restore = h.assistant.restoreTask('task-a');
  h.setTenant('team-b'); h.auth.version++;
  finish({ status: 200, data: { ok: true, task: savedTask({ goal: '旧租户私有目标' }) } });
  await restore; await flush();
  assert.doesNotMatch(h.panel.textContent, /旧租户私有目标|run-real/);
  assert.equal(h.storage.size, 0);
  assert.ok(h.requests.some(request => request.path.endsWith('/tasks?tenant=team-b')));
});

test('任务确认保留已执行回执并呈现下一提案，原令牌不能重复确认', async () => {
  const h = harness(); const proposal = (token: string) => ({ token, operationId: 'create', description: token === 'first-token' ? '创建看板' : '添加面板', preview: '{}', expiresAt: Date.now() + 300_000 });
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '确认后创建看板。', operations: [], proposal: proposal('first-token'), task: savedTask({ status: 'awaiting_confirmation' }) } }));
  await h.send('建看板并加面板');
  const firstConfirm = h.log.querySelectorAll('button').find(node => node.textContent === '确认执行')!;
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '看板已创建，添加面板需要确认。', operations: [{ id: 'create_board', description: '创建看板', ok: true, status: 200, data: { id: 'board-real' } }], proposal: proposal('second-token'), task: savedTask({ revision: 2, status: 'awaiting_confirmation' }) } }));
  await Promise.all(firstConfirm.click() ?? []);
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { token: 'first-token', taskId: 'task-a' });
  assert.match(h.log.textContent, /已完成 · 创建看板/);
  assert.match(h.log.textContent, /待确认 · 添加面板/);
  await Promise.all(firstConfirm.click() ?? []);
  assert.equal(h.requests.filter(request => request.path.includes('/confirm')).length, 1);
  const secondConfirm = h.log.querySelectorAll('button').filter(node => node.textContent === '确认执行').at(-1)!;
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '看板与面板已创建。', operations: [{ id: 'add_panel', description: '添加面板', ok: true, status: 200, data: { id: 'panel-real' } }], task: savedTask({ revision: 3, status: 'completed' }) } }));
  await Promise.all(secondConfirm.click() ?? []);
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { token: 'second-token', taskId: 'task-a' });
  assert.match(h.log.textContent, /已完成 · 创建看板|已完成 · 添加面板|看板与面板已创建/);
  assert.match(h.node('platformAssistantTaskStatus').textContent, /回答完成/);
});

test('任务评价使用真实 revision，冲突保留回执并提示重新读取', async () => {
  const h = harness(); const task = savedTask({ revision: 3 });
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: task.response.reply, operations: task.response.operations, task } }));
  await h.send('分析运行');
  h.setFeedback(async () => ({ status: 200, data: { ok: true, task: savedTask({ revision: 4, feedback: { label: 'helpful' } }) } }));
  await h.assistant.submitFeedback('helpful');
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { rating: 'helpful', expectedRevision: 3 });
  assert.equal(h.node('platformAssistantHelpful').getAttribute('aria-pressed'), 'true');
  h.setFeedback(async () => ({ status: 409, data: { ok: false, error: 'assistant_task_revision_conflict' } }));
  await h.assistant.submitFeedback('not_helpful');
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { rating: 'not_helpful', expectedRevision: 4 });
  assert.match(h.node('platformAssistantTaskStatus').textContent, /任务已更新/);
  assert.match(h.log.textContent, /已完成 · 读取运行/);
});

test('过期任务提案仅显示元数据，要求新请求，不自动刷新授权', async () => {
  const h = harness(); const task = savedTask({ status: 'awaiting_confirmation', response: { reply: '变更尚未执行。', operations: [], proposal: { operationId: 'create', description: '创建看板', preview: '{}', expiresAt: Date.now() - 1000 } } });
  h.setDetail(async () => ({ status: 200, data: { ok: true, task } }));
  await h.assistant.restoreTask('task-a');
  const confirm = h.log.querySelectorAll('button').find(node => node.textContent === '确认执行')!;
  assert.equal(confirm.disabled, true);
  await Promise.all(confirm.click() ?? []);
  assert.equal(h.requests.some(request => request.options.method === 'POST'), false);
  assert.match(h.node('platformAssistantTaskStatus').textContent, /确认已过期/);
});

test('上下文忽略疑似凭据、冲突的选择和反向时间范围', () => {
  const h = harness();
  Object.assign(h.pageState, { viewSource: 'traces/runs', traceEnvironment: 'arbitrary-production-url', traceQuery: 'Authorization: Bearer private-secret', overviewHours: 1.5, timeWindow: { from: '2026-10-13T10:00:00Z', to: '2026-10-13T08:00:00Z' } });
  assert.deepEqual(plain(h.assistant.gatherWorkContext()), { view: 'traces/runs', tenant: 'team-a' });
  h.pageState.viewSource = 'data/datasets';
  const workspace = h.main.appendChild(h.create('div')); workspace.id = 'dataCenterWorkspace';
  for (const id of ['dataset-one', 'dataset-two']) { const node = workspace.appendChild(h.create('button')); node.setAttribute('aria-selected', 'true'); node.setAttribute('data-dataset-id', id); }
  assert.equal(h.assistant.gatherWorkContext().selection, undefined, '多个冲突选中项需要用户重新选择');
});

test('任务列表错误与旧版无持久任务响应仍允许继续对话', async () => {
  const h = harness();
  h.setTasks(async () => ({ status: 404, data: { ok: false, error: 'not_found' } }));
  h.assistant.open(); await flush();
  assert.match(h.node('platformAssistantTaskStatus').textContent, /暂不支持任务恢复/);
  await h.send('继续查看设备');
  assert.match(h.log.textContent, /真实回复/);
  assert.equal(JSON.parse(h.requests.at(-1)!.options.body!).taskId, null);
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
});

test('过长标识整项省略，不能截断成另一个可调用的目标', () => {
  const h = harness();
  Object.assign(h.pageState, { viewSource: 'traces/runs', traceDetailLocator: 'a'.repeat(4097), traceDetailRunRef: 'run-real' });
  assert.equal(h.assistant.gatherWorkContext().selection, undefined);
  h.pageState.viewSource = 'signals/panels'; h.pageState.currentBoardId = 'a'.repeat(201);
  assert.equal(h.assistant.gatherWorkContext().selection, undefined);
});

test('已经过期的旧版确认令牌也不会由界面发送', async () => {
  const h = harness();
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '确认已过期', operations: [], proposal: { token: 'expired-token', description: '修改阈值', preview: '{}', expiresAt: Date.now() - 1000 } } }));
  await h.send('修改阈值');
  const confirm = h.log.querySelectorAll('button').find(node => node.textContent === '确认执行')!;
  assert.equal(confirm.disabled, true);
  await Promise.all(confirm.click() ?? []);
  assert.equal(h.requests.some(request => request.path.includes('/confirm')), false);
});

test('恢复有效待确认任务后确认控件重新启用，可以执行一次确认', async () => {
  const h = harness(); const task = savedTask({ status: 'awaiting_confirmation', response: { reply: '请确认合成变更', operations: [], proposal: { token: 'valid-restored-token', operationId: 'create', description: '创建看板', preview: '{}', expiresAt: Date.now() + 300_000 } } });
  h.setDetail(async () => ({ status: 200, data: { ok: true, task } }));
  await h.assistant.restoreTask('task-a');
  const confirm = h.log.querySelectorAll('button').find(node => node.textContent === '确认执行')!;
  assert.equal(confirm.disabled, false, '加载期间渲染的按钮必须在恢复完成后重新启用');
  await Promise.all(confirm.click() ?? []);
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { token: 'valid-restored-token', taskId: 'task-a' });
});

test('任务评价完成保留键盘焦点，用户移到关闭按钮后不抢回焦点', async () => {
  const h = harness(); h.assistant.open(); await flush();
  h.setChat(async () => ({ status: 200, data: { ok: true, reply: '合成回答完成', operations: [], task: savedTask() } }));
  await h.send('分析运行');
  const helpful = h.node('platformAssistantHelpful'); helpful.focus();
  await h.assistant.submitFeedback('helpful');
  assert.equal(h.focused(), helpful);
  let resolve!: (reply: { status: number; data: unknown }) => void;
  h.setFeedback(() => new Promise(done => { resolve = done; }));
  helpful.focus(); const pending = h.assistant.submitFeedback('not_helpful');
  const close = h.panel.querySelectorAll('button').find(button => button.getAttribute('aria-label') === '关闭平台 AI 助手')!;
  close.focus(); resolve({ status: 200, data: { ok: true } }); await pending;
  assert.equal(h.focused(), close, '不得抢回用户在请求期间主动移开的焦点');
});
