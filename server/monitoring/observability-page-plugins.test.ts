import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { PLUGIN_CENTER_HTML, PLUGIN_CENTER_SCRIPT, renderPluginCenterPage } from './observability-page-plugins.js';

type Event = { target: Element; preventDefault(): void; stopPropagation(): void };
class Element {
  id = ''; value = ''; type = ''; rows = 0; disabled = false; hidden = false; readOnly = false; open = false;
  files: Array<{ size: number; text(): Promise<string> }> | null = null;
  parentNode: Element | null = null; children: Element[] = [];
  private copy = ''; private classes = new Set<string>();
  readonly attrs = new Map<string,string>(); readonly events = new Map<string,Array<(event: Event) => unknown>>();
  constructor(readonly tagName: string) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  readonly classList = { add: (...names: string[]) => names.forEach(name => this.classes.add(name)), remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)), toggle: (name: string, force?: boolean) => { const show = force ?? !this.classes.has(name); if (show) this.classes.add(name); else this.classes.delete(name); return show; }, contains: (name: string) => this.classes.has(name) };
  get textContent(): string { return this.copy + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.copy = String(value); this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML write'); }
  appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  replaceChildren(...nodes: Element[]) { this.copy = ''; this.children.forEach(child => { child.parentNode = null; }); this.children = []; nodes.forEach(child => this.appendChild(child)); }
  setAttribute(name: string, value: unknown) { this.attrs.set(name,String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); if (name === 'hidden') this.hidden = true; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  addEventListener(name: string, action: (event: Event) => unknown) { this.events.set(name,[...this.events.get(name) ?? [],action]); }
  async dispatch(name: string) { if (name === 'click' && this.disabled) return; const event = { target: this, preventDefault() {}, stopPropagation() {} }; for (const action of this.events.get(name) ?? []) await action(event); }
  click() { return this.dispatch('click'); }
  descendants(): Element[] { return this.children.flatMap(child => [child,...child.descendants()]); }
  matches(selector: string): boolean { if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return this.classes.has(selector.slice(1)); const attribute = selector.match(/^\[([^\]]+)\]$/); if (attribute) return this.attrs.has(attribute[1]); return this.tagName.toLowerCase() === selector.toLowerCase(); }
  querySelectorAll(selector: string) { return this.descendants().filter(child => child.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
type Call = { url: string; method: string; body: Record<string,any> | null; headers: Record<string,string>; signal: AbortSignal };
type Response = { ok: boolean; status: number; json(): Promise<unknown> };
const response = (data: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => data });
function manifest(version = '1.0.0') { return { schemaVersion: 1, id: 'device-diagnostics', version, label: '设备诊断', description: '读取真实设备状态', dependencies: [], configSchema: { type: 'object', properties: {}, additionalProperties: false }, tools: [{ id: 'status', description: '查询设备状态', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, source: { type: 'platform', operationId: 'devices.list' } }], dataSources: [{ id: 'devices', toolId: 'status' }], panels: [{ id: 'count', title: '设备数', dataSourceId: 'devices', kind: 'stat' }], workflows: [{ id: 'investigate', title: '诊断流程', steps: [{ toolId: 'status', label: '读取状态' }] }], prompts: [{ id: 'diagnose', text: '请依据回执分析。' }] }; }
function detail(revision = 1, enabled = true) { return { id: 'device-diagnostics', revision, enabled, draft: { manifest: manifest('1.0.1'), config: {} }, published: { manifest: manifest(), config: {}, publishedAt: '2026-10-13T01:00:00Z' }, history: [{ manifest: manifest(), config: {}, publishedAt: '2026-10-13T01:00:00Z' }, { manifest: manifest('1.0.1'), config: {}, publishedAt: '2026-10-13T02:00:00Z' }], createdAt: '2026-10-13T01:00:00Z', updatedAt: '2026-10-13T02:00:00Z' }; }
function summary(record = detail()) { return { id: record.id, label: record.draft?.manifest.label || record.published?.manifest.label, description: '读取真实设备状态', revision: record.revision, enabled: record.enabled, version: record.published?.manifest.version, hasDraft: Boolean(record.draft), draftVersion: record.draft?.manifest.version }; }
const execution = (data: unknown) => ({ ok: true, result: { pluginId: 'device-diagnostics', version: '1.0.0', toolId: 'status', data, receipt: { id: 'receipt-1', source: 'platform:devices.list', durationMs: 8, startedAt: '2026-10-13T01:00:00Z', completedAt: '2026-10-13T01:00:01Z' } } });
function harness() {
  const body = new Element('body'); const stack = [body];
  for (const match of PLUGIN_CENTER_HTML.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const token = match[0], tag = token.match(/^<\/?([a-z][\w-]*)/i)![1].toLowerCase();
    if (token.startsWith('</')) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag) { stack.splice(i); break; } continue; }
    const node = new Element(tag); for (const attr of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (attr.index !== 1) node.setAttribute(attr[1],attr[2] ?? ''); stack.at(-1)!.appendChild(node); if (!['input','br','hr','img'].includes(tag)) stack.push(node);
  }
  const calls: Call[] = []; let record = detail();
  let handle = async (call: Call): Promise<Response> => {
    if (call.url.endsWith('/catalog')) return response({ ok: true, plugins: [summary(record)], templates: [{ manifest: manifest(), config: {} }] });
    if (call.url.endsWith('/capabilities')) return response({ ok: true, readOnly: false });
    if (call.method === 'GET' && call.url.endsWith('/device-diagnostics')) return response({ ok: true, plugin: structuredClone(record) });
    if (call.method === 'GET' && call.url.includes('/data/')) return response(execution(4));
    if (call.method !== 'GET') { record = { ...record, revision: record.revision + 1 }; return response({ ok: true, plugin: structuredClone(record) }); }
    return response(execution({ devices: [] }));
  };
  const context = vm.createContext({ document: { body, createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), getElementById: (id: string) => body.querySelector('#'+id) }, base: '/studio', $: (id: string) => body.querySelector('#'+id), state: { view: 'plugins' }, obsAuthState: { version: 1, me: { user: { id: 'admin-a' }, admin: true } }, opsTenantMode: false, opsMemberMode: false, activeTenant: '', apiHeaders: (mutation: boolean) => ({ 'content-type': 'application/json', 'x-rdk-sso-session': 'test-session', ...(mutation ? { 'X-RDK-Ops-Action': 'observability' } : {}) }), fetch: (url: string, init: { method: string; body?: string; headers: Record<string,string>; signal: AbortSignal }) => { const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers, signal: init.signal }; calls.push(call); return handle(call); }, AbortController, URL, Blob, Date, console });
  vm.runInContext("function obsActiveTenant(){return activeTenant}function adminTenantQuery(){return activeTenant?'&tenant='+encodeURIComponent(activeTenant):''}" + PLUGIN_CENTER_SCRIPT + ';globalThis.pluginTest={pluginCenter,loadPluginCenter,resetPluginCenterScope,pluginCenterScopeChanged}',context);
  const api = vm.runInContext('pluginTest',context) as Record<string,any>;
  const id = (name: string) => { const node = body.querySelector('#'+name); assert.ok(node,name); return node; };
  const button = (label: string, root = id('pluginDetail')) => { const node = root.querySelectorAll('button').find(item => item.textContent === label); assert.ok(node,label); return node; };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return { api, context, body, calls, id, button, flush, setResponse: (next: typeof handle) => { handle = next; }, setRecord: (next: typeof record) => { record = next; } };
}
async function installed(h: ReturnType<typeof harness>) { await h.api.loadPluginCenter(); await h.api.pluginCenter.selectPlugin('device-diagnostics'); }

test('plugin script is valid inline JavaScript and debug landing uses the authenticated shell', () => {
  new vm.Script(PLUGIN_CENTER_SCRIPT); const debug = renderPluginCenterPage(); assert.match(debug,/\/ops-observability#plugins/); assert.doesNotMatch(debug,/<script|ops-token|fetch\(/); assert.doesNotMatch(PLUGIN_CENTER_SCRIPT,/\.innerHTML\s*=|\beval\s*\(/);
});

test('catalog and selection make authenticated reads without writes or automatic workflow calls', async () => {
  const h = harness(); await installed(h); assert.match(h.id('pluginCatalog').textContent,/设备诊断.*v1\.0\.0.*已启用/s); assert.match(h.id('pluginDetail').textContent,/已发布 v1\.0\.0/); assert.ok(h.calls.every(call => call.method === 'GET')); assert.ok(h.calls.every(call => call.headers['x-rdk-sso-session'] === 'test-session')); assert.equal(h.calls.filter(call => call.url.includes('/data/') || call.url.includes('/workflows/')).length,0); assert.match(h.id('pluginManifestEditor').value,/1\.0\.1/,'draft stays distinct from the running version');
});

test('template creates a draft with no expectedRevision; subsequent publish and disable use returned revisions', async () => {
  const h = harness(); await h.api.loadPluginCenter(); await h.id('pluginTemplatesTab').click(); await h.id('pluginCatalog').querySelectorAll('button')[0].click(); const editor = h.id('pluginManifestEditor'); const parsed = JSON.parse(editor.value); parsed.id = 'new-plugin'; parsed.version = '2.0.0'; editor.value = JSON.stringify(parsed); await editor.dispatch('input');
  let record = { ...detail(1,false), id: 'new-plugin', published: null as any, draft: { manifest: parsed, config: {} } };
  h.setResponse(async call => { if (call.url.endsWith('/catalog')) return response({ ok: true, plugins: [summary(record)], templates: [] }); if (call.url.endsWith('/capabilities')) return response({ ok: true }); if (call.url.endsWith('/publish')) { record = { ...record, revision: 2, enabled: true, draft: null as any, published: { manifest: parsed, config: {}, publishedAt: 'now' } }; return response({ ok: true, plugin: record }); } if (call.url.endsWith('/enabled')) { record = { ...record, revision: 3, enabled: false }; return response({ ok: true, plugin: record }); } return response({ ok: true, plugin: record }); });
  await h.button('创建草稿').click(); const create = h.calls.find(call => call.url.endsWith('/draft'))!; assert.equal(create.body?.expectedRevision,undefined); assert.equal(create.body?.manifest.id,'new-plugin'); assert.equal(create.headers['X-RDK-Ops-Action'],'observability'); await h.button('校验并发布').click(); assert.equal(h.calls.find(call => call.url.endsWith('/publish'))?.body?.expectedRevision,1); await h.button('停用').click(); assert.equal(h.calls.find(call => call.url.endsWith('/enabled'))?.body?.expectedRevision,2); assert.match(h.id('pluginDetail').textContent,/已停用/);
});

test('invalid JSON and unsaved local edits cannot publish; conflict refresh preserves local editor text', async () => {
  const h = harness(); await installed(h); const editor = h.id('pluginManifestEditor'); editor.value='{broken'; await editor.dispatch('input'); await h.button('保存草稿').click(); assert.match(h.id('pluginEditorReceipt').textContent,/JSON 格式错误/); assert.equal(h.calls.some(call => call.method === 'POST'),false); editor.value=JSON.stringify({ ...manifest('1.0.2'),label:'本地改动' }); await editor.dispatch('input'); await h.button('校验并发布').click(); assert.match(h.id('pluginEditorReceipt').textContent,/请先保存/);
  h.setResponse(async call => call.method === 'POST' ? response({ ok: false,error: 'revision_conflict' },409) : response({ ok: true,plugin: detail(8) })); await h.button('保存草稿').click(); assert.equal(h.calls.find(call => call.method === 'POST')?.body?.expectedRevision,1); await h.button('刷新服务端版本并保留编辑',h.id('pluginEditorReceipt')).click(); assert.match(h.id('pluginManifestEditor').value,/本地改动/); assert.match(h.id('pluginDetail').textContent,/修订 8/); assert.match(h.id('pluginStatus').textContent,/本地未保存编辑已保留/);
});

test('rollback uses the current revision and uninstall requires its explicit inline confirmation', async () => {
  const h = harness(); await installed(h); await h.button('回滚到此版本').click(); assert.equal(h.calls.find(call => call.url.endsWith('/rollback'))?.body?.expectedRevision,1); assert.equal(h.calls.find(call => call.url.endsWith('/rollback'))?.body?.version,'1.0.1'); await h.button('卸载插件').click(); assert.equal(h.calls.some(call => call.method === 'DELETE'),false); const confirm = h.id('pluginDetail').querySelector('.plugin-remove-confirm')!; assert.equal(confirm.hidden,false); await h.button('取消',confirm).click(); assert.equal(confirm.hidden,true); await h.button('卸载插件').click(); await h.button('确认卸载',confirm).click(); assert.equal(h.calls.find(call => call.method === 'DELETE')?.body?.expectedRevision,2);
});

test('stat, table and SVG line panels render actual query values using safe DOM', async () => {
  const h = harness(); const record = detail(); record.published.manifest.panels = [ { id:'stat',title:'真实设备数',kind:'stat',dataSourceId:'count' }, { id:'table',title:'设备列表',kind:'table',dataSourceId:'table' }, { id:'line',title:'趋势',kind:'line',dataSourceId:'line' } ]; h.setRecord(record); await installed(h); const xss = '<img src=x onerror=alert(1)>';
  h.setResponse(async call => { const payload=call.url.includes('/data/count')?execution(7):call.url.includes('/data/table')?execution([{device:xss,status:'online'}]):execution({series:[{name:xss,points:[{ts:1791849600000,value:2},{ts:1791849660000,value:5}]}]});const source=call.url.includes('/data/count')?{type:'platform',operationId:'GET /api/ops/observability/devices'}:call.url.includes('/data/table')?{type:'mcp',connectorId:'evidence',toolName:'inspect_device'}:payload.result.receipt.source;return response({...payload,result:{...payload.result,receipt:{...payload.result.receipt,source}}}) });
  await h.button('查询全部面板').click(); assert.equal(h.calls.filter(call => call.url.includes('/data/')).length,3); assert.equal(h.id('pluginDetail').querySelector('.plugin-stat')?.textContent,'7'); assert.match(h.id('pluginDetail').querySelector('.plugin-table')!.textContent,/<img src=x onerror=alert\(1\)>/); assert.equal(h.id('pluginDetail').querySelectorAll('img').length,0); const line = h.id('pluginDetail').querySelector('polyline')!; assert.match(line.getAttribute('points')!,/^20\.00,130\.00 580\.00,20\.00$/); assert.equal(line.querySelector('title')?.textContent,xss); const outputs=h.id('pluginDetail').querySelectorAll('.plugin-panel-output');assert.equal(outputs[0].querySelector('.plugin-hint')?.textContent,'平台接口 · 8 ms');assert.equal(outputs[1].querySelector('.plugin-hint')?.textContent,'MCP · evidence / inspect_device · 8 ms');assert.ok(outputs[2].querySelectorAll('.plugin-hint').some(node=>node.textContent==='平台接口 · 8 ms'));const rawReceipt=outputs[0].querySelector('.plugin-runtime-receipt')!;assert.equal(rawReceipt.open,false);rawReceipt.open=true;await rawReceipt.dispatch('toggle');const raw=JSON.parse(rawReceipt.querySelector('pre')!.textContent);assert.deepEqual(raw.receipt.source,{type:'platform',operationId:'GET /api/ops/observability/devices'});assert.equal(raw.receipt.completedAt,'2026-10-13T01:00:01Z');assert.equal(outputs[0].children.filter(child=>child.classList.contains('plugin-hint')&&child.textContent.includes('上次查询')).length,1);
});

test('empty, corrupt and failed data keep unknown/error states visible rather than producing zero', async () => {
  const h = harness(); await installed(h); h.setResponse(async () => response(execution(null))); await h.button('查询').click(); assert.match(h.id('pluginDetail').textContent,/没有可显示的数值/); assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null); h.setResponse(async () => response({ ok: true,result: { receipt: {} } })); await h.button('查询').click(); assert.match(h.id('pluginDetail').textContent,/缺少真实数据回执/); h.setResponse(async () => response({ ok: false,error:'source_unavailable' },503)); await h.button('查询').click(); assert.match(h.id('pluginDetail').textContent,/请求未完成|暂不可用/); assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null);
});

test('readonly tools send JSON args over GET; workflows submit only on demand with an action guard and real receipts', async () => {
  const h = harness(); await installed(h); const tool=h.id('pluginDetail').querySelectorAll('.plugin-tool')[0]; const input=tool.querySelector('textarea')!; input.value='{"deviceId":"rdk-x5"}';
  h.setResponse(async call => call.url.includes('/workflows/') ? response({ ok: true,result:{ steps:[{ label:'读取设备',toolId:'status',data:{ online: true },receipt:{ id:'real-step-receipt',durationMs:12 } }] } }) : response(execution({ deviceId:'rdk-x5' })));
  await h.button('执行只读查询',tool).click(); const call = h.calls.find(call=>call.url.includes('/tools/'))!; assert.equal(call.method,'GET'); assert.deepEqual(JSON.parse(new URL('https://example.test'+call.url).searchParams.get('args')!),{ deviceId:'rdk-x5' }); assert.equal(call.headers['X-RDK-Ops-Action'],undefined); const workflow=h.id('pluginDetail').querySelectorAll('.plugin-tool')[1]; assert.equal(h.calls.some(call=>call.url.includes('/workflows/')),false); await h.button('运行只读工作流',workflow).click(); const run=h.calls.find(call=>call.url.includes('/workflows/'))!; assert.equal(run.method,'POST'); assert.equal(run.headers['X-RDK-Ops-Action'],'observability'); assert.deepEqual(run.body,{ args:{} }); assert.match(workflow.textContent,/real-step-receipt/);
});

test('catalog failures do not turn loaded plugins into an empty successful catalog; access denial clears private data', async () => {
  const h=harness(); await installed(h); h.setResponse(async()=>response({ ok:false,error:'central_store_disabled' },503)); await h.api.loadPluginCenter(); assert.match(h.id('pluginStatus').textContent,/暂不可用/); assert.match(h.id('pluginCatalog').textContent,/设备诊断/); assert.doesNotMatch(h.id('pluginCatalog').textContent,/尚未安装/); h.setResponse(async()=>response({ ok:false,error:'not_authorized' },403)); await h.api.loadPluginCenter(); assert.equal(h.api.pluginCenter.state.plugins.length,0); assert.equal(h.api.pluginCenter.state.editors.size,0); assert.doesNotMatch(h.id('pluginDetail').textContent,/读取真实设备状态/); assert.match(h.id('pluginStatus').textContent,/没有此操作的权限/);
});

test('identity reset aborts requests, removes editor caches and rejects late responses from the previous tenant', async () => {
  const h=harness(); await installed(h); h.id('pluginManifestEditor').value='{"private":"previous-account"}'; await h.id('pluginManifestEditor').dispatch('input'); let complete!: (response: Response)=>void; h.setResponse(call=>call.url.includes('/data/')?new Promise(resolve=>{complete=resolve}):Promise.resolve(response({ ok:true,plugins:[],templates:[] })));
  const pending=h.button('查询').click(); await h.flush(); const old=h.calls.at(-1)!; vm.runInContext("activeTenant='new-tenant';obsAuthState.me={user:{id:'admin-b'},admin:true}",h.context); h.api.resetPluginCenterScope(); assert.equal(old.signal.aborted,true); assert.equal(h.api.pluginCenter.state.editors.size,0); assert.doesNotMatch(h.id('pluginDetail').textContent,/previous-account/); complete(response(execution(999))); await pending; assert.doesNotMatch(h.id('pluginDetail').textContent,/999/); await h.api.loadPluginCenter(); assert.ok(h.calls.at(-1)!.url.includes('tenant=new-tenant'));
});

test('late detail selection never overwrites a newer selected plugin', async () => {
  const h=harness(); await installed(h); let complete!: (response: Response)=>void; h.setResponse(call=>call.url.endsWith('/slow')?new Promise(resolve=>{complete=resolve}):Promise.resolve(response({ ok:true,plugin:detail() })));
  const slow=h.api.pluginCenter.selectPlugin('slow'); await h.flush(); await h.api.pluginCenter.selectPlugin('device-diagnostics'); complete(response({ ok:true,plugin:{ ...detail(),id:'slow',draft:{ manifest:{...manifest(),label:'过期详情'},config:{} } } })); await slow; assert.doesNotMatch(h.id('pluginDetail').textContent,/过期详情/); assert.equal(h.api.pluginCenter.state.selected,'device-diagnostics');
});

test('import parses a package locally and awaits explicit draft creation; read-only users cannot write', async () => {
  const h=harness(); await h.api.loadPluginCenter(); await h.id('pluginImportBtn').click(); const input=h.id('pluginDetail').querySelector('textarea')!; input.value=JSON.stringify({ manifest:manifest(),config:{} }); await h.button('检查并编辑').click(); assert.ok(h.calls.every(call=>call.method==='GET')); assert.equal(h.button('校验并发布').disabled,true); assert.equal(h.button('创建草稿').disabled,false); vm.runInContext('opsMemberMode=true',h.context); h.api.resetPluginCenterScope(); h.setResponse(async call=>call.url.endsWith('/catalog')?response({ ok:true,plugins:[summary()],templates:[] }):call.url.endsWith('/capabilities')?response({ ok:true,readOnly:true }):response({ ok:true,plugin:detail() })); await installed(h); assert.equal(h.button('保存草稿').disabled,true); assert.equal(h.id('pluginManifestEditor').readOnly,true); const before=h.calls.length; await h.button('保存草稿').click(); assert.equal(h.calls.length,before);
});

test('a stale save control cannot submit previous identity data before the shell auth hook runs', async () => {
  const h=harness(); await installed(h); const oldSave=h.button('保存草稿'); h.id('pluginConfigEditor').value='{"private":"old-account"}'; await h.id('pluginConfigEditor').dispatch('input'); vm.runInContext("obsAuthState.me={user:{id:'new-admin'},admin:true}",h.context); await oldSave.click(); assert.equal(h.calls.some(call=>call.method==='POST'),false); assert.equal(h.api.pluginCenter.state.editors.size,0); assert.doesNotMatch(h.id('pluginDetail').textContent,/old-account/);
});

test('empty arrays, objects, whitespace and booleans are never coerced into a zero stat', async () => {
  const h=harness(); await installed(h); for(const value of [[],{},' ',false]) { h.setResponse(async()=>response(execution(value))); await h.button('查询').click(); assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null); assert.match(h.id('pluginDetail').textContent,/没有可显示的数值/); }
});

test('creating from a template that already exists preserves edits while resolving the revision conflict', async () => {
  const h=harness(); await h.api.loadPluginCenter(); await h.id('pluginTemplatesTab').click(); await h.id('pluginCatalog').querySelectorAll('button')[0].click(); const editor=h.id('pluginManifestEditor'); editor.value=JSON.stringify({...manifest('1.0.2'),label:'保留模板改动'}); await editor.dispatch('input'); h.setResponse(async call=>call.method==='POST'?response({ok:false,error:'plugin_revision_conflict'},409):response({ok:true,plugin:detail(9)})); await h.button('创建草稿').click(); await h.button('刷新服务端版本并保留编辑',h.id('pluginEditorReceipt')).click(); assert.match(h.id('pluginManifestEditor').value,/保留模板改动/); assert.match(h.id('pluginDetail').textContent,/修订 9/);
});

test('local file import arriving after identity reset cannot repopulate the previous private editor', async () => {
  const h=harness(); await h.api.loadPluginCenter(); await h.id('pluginImportBtn').click(); const oldInput=h.id('pluginDetail').querySelector('textarea')!,file=h.id('pluginDetail').querySelector('input')!; let complete!: (value:string)=>void; file.files=[{size:100,text:()=>new Promise(resolve=>{complete=resolve})}]; const pending=file.dispatch('change'); await h.flush(); vm.runInContext("activeTenant='tenant-b'",h.context); h.api.resetPluginCenterScope(); complete('{"private":"account-a"}'); await pending; assert.equal(oldInput.value,''); assert.equal(h.api.pluginCenter.state.detail,null);
});

function configField(h: ReturnType<typeof harness>, key: string) { const input=h.id('pluginBasicConfig').querySelectorAll('[data-plugin-config]').find(node=>node.getAttribute('data-plugin-config')===key);assert.ok(input,key);return input; }
function installFixtureServer(h: ReturnType<typeof harness>, current:()=>ReturnType<typeof detail>, query?: (call: Call)=>Promise<Response>) {
  h.setResponse(async call=>{
    if(call.url.endsWith('/catalog'))return response({ok:true,plugins:[summary(current())],templates:[]});
    if(call.url.endsWith('/capabilities'))return response({ok:true});
    if(call.method==='GET'&&call.url.endsWith('/device-diagnostics'))return response({ok:true,plugin:structuredClone(current())});
    if(call.url.includes('/data/')||call.url.includes('/tools/')||call.url.includes('/workflows/'))return query?query(call):response(execution(4));
    return response({ok:true,plugin:structuredClone(current())});
  });
}

test('published plugins put runnable diagnostics before collapsed editor, JSON and history controls',async()=>{
  const h=harness();await installed(h);const root=h.id('pluginDetail'),runtime=root.querySelector('.plugin-runtime')!,edit=h.id('pluginEditSection');assert.ok(root.children.indexOf(runtime)<root.children.indexOf(edit));assert.equal(edit.open,false);assert.equal(h.id('pluginJsonSection').open,false);assert.equal(root.querySelector('.plugin-history')!.open,false);assert.equal(root.querySelector('.plugin-runtime-receipt'),null);assert.equal(h.calls.some(call=>call.url.includes('/data/')),false);
});

test('template overview exposes basic typed configuration and creates a draft without requiring JSON editing',async()=>{
  const h=harness();const source:any=manifest();source.configSchema={type:'object',properties:{hours:{type:'integer',minimum:1,maximum:168,description:'回看小时'},label:{type:'string',description:'显示名'},enabled:{type:'boolean',description:'包含健康项'},level:{type:'string',enum:['warning','critical'],description:'级别'}},required:['hours'],additionalProperties:false};
  h.setResponse(async call=>call.url.endsWith('/catalog')?response({ok:true,plugins:[],templates:[{manifest:source,config:{hours:24,label:'巡检',enabled:false,level:'warning'}}]}):call.url.endsWith('/capabilities')?response({ok:true}):response({ok:true,plugin:{...detail(),published:null,enabled:false,draft:{manifest:source,config:call.body?.config||{}}}}));
  await h.api.loadPluginCenter();await h.id('pluginTemplatesTab').click();await h.id('pluginCatalog').querySelectorAll('button')[0].click();assert.match(h.id('pluginDetail').querySelector('.plugin-package-overview')!.textContent,/设备数.*诊断流程/s);assert.equal(h.id('pluginEditSection').open,true);assert.equal(h.id('pluginJsonSection').open,false);
  configField(h,'hours').value='48';await configField(h,'hours').dispatch('input');configField(h,'label').value='每周巡检';await configField(h,'label').dispatch('input');configField(h,'enabled').value='0';await configField(h,'enabled').dispatch('change');configField(h,'level').value='1';await configField(h,'level').dispatch('change');
  assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{hours:48,label:'每周巡检',enabled:true,level:'critical'});await h.button('创建草稿').click();const created=h.calls.find(call=>call.url.endsWith('/draft'))!;assert.deepEqual(created.body?.config,{hours:48,label:'每周巡检',enabled:true,level:'critical'});assert.equal(created.body?.expectedRevision,undefined);
});

test('JSON and basic configuration stay in sync; invalid typed input blocks writes and preserves unknown config keys',async()=>{
  const h=harness();const record:any=detail();record.draft.manifest.configSchema={type:'object',properties:{hours:{type:'integer',description:'回看小时'}},required:['hours']};record.draft.config={hours:24,nested:{keep:'unchanged'}};h.setRecord(record);await installed(h);
  configField(h,'hours').value='1.5';await configField(h,'hours').dispatch('input');await h.button('保存草稿').click();assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.match(h.id('pluginEditorReceipt').textContent,/有效的回看小时/);assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{hours:24,nested:{keep:'unchanged'}});
  h.id('pluginConfigEditor').value='{"hours":72,"nested":{"keep":"unchanged"}}';await h.id('pluginConfigEditor').dispatch('input');assert.equal(configField(h,'hours').value,'72');configField(h,'hours').value='48';await configField(h,'hours').dispatch('input');assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{hours:48,nested:{keep:'unchanged'}});await h.button('保存草稿').click();assert.equal(h.calls.find(call=>call.method==='POST')?.body?.config.hours,48);
});

test('save responses preserve later input and queued DOM text while advancing the confirmed revision',async()=>{
  for(const deliverInput of [true,false]){
    const h=harness();await installed(h);h.id('pluginConfigEditor').value='{"hours":24}';await h.id('pluginConfigEditor').dispatch('input');let complete!:(value:Response)=>void;let record:any=detail(2);record.draft.config={hours:24};
    h.setResponse(async call=>call.method==='POST'?new Promise(resolve=>{complete=resolve}):call.url.endsWith('/catalog')?response({ok:true,plugins:[summary(record)],templates:[]}):call.url.endsWith('/capabilities')?response({ok:true}):response({ok:true,plugin:record}));
    const pending=h.button('保存草稿').click();await h.flush();assert.equal(h.id('pluginConfigEditor').readOnly,true);h.id('pluginConfigEditor').value='{"hours":48}';if(deliverInput)await h.id('pluginConfigEditor').dispatch('input');complete(response({ok:true,plugin:record}));await pending;
    assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{hours:48});assert.equal(h.api.pluginCenter.state.detail.revision,2);assert.equal(h.api.pluginCenter.state.editors.get('device-diagnostics').dirty,true);assert.equal(h.id('pluginConfigEditor').readOnly,false);assert.match(h.id('pluginStatus').textContent,/提交时的草稿.*仍未保存/);
    installFixtureServer(h,()=>record);await h.button('保存草稿').click();const writes=h.calls.filter(call=>call.url.endsWith('/draft'));assert.equal(writes[1].body?.expectedRevision,2);assert.deepEqual(writes[1].body?.config,{hours:48});
  }
});

test('same published package refresh retains panel receipts, tool args and disclosures; changed draft revision does not reset diagnostics',async()=>{
  const h=harness();let record:any=detail();installFixtureServer(h,()=>record,async()=>response(execution(7)));await installed(h);await h.button('查询').click();const tool=h.id('pluginDetail').querySelectorAll('.plugin-tool')[0];tool.open=true;await tool.dispatch('toggle');const input=tool.querySelector('textarea')!;input.value='{"params":{"deviceId":"x5"}}';await input.dispatch('input');const edit=h.id('pluginEditSection');edit.open=true;await edit.dispatch('toggle');record={...record,revision:9,draft:{...record.draft,config:{hours:72}}};
  const queries=h.calls.filter(call=>call.url.includes('/data/')).length;await h.api.loadPluginCenter();assert.equal(h.id('pluginDetail').querySelector('.plugin-stat')?.textContent,'7');assert.match(h.id('pluginDetail').textContent,/上次查询：/);assert.equal(h.id('pluginDetail').querySelectorAll('.plugin-tool')[0].querySelector('textarea')?.value,'{"params":{"deviceId":"x5"}}');assert.equal(h.id('pluginDetail').querySelectorAll('.plugin-tool')[0].open,true);assert.equal(h.id('pluginEditSection').open,true);assert.equal(h.calls.filter(call=>call.url.includes('/data/')).length,queries,'refresh does not rerun queries or workflows');
  record={...record,published:{...record.published,manifest:{...record.published.manifest,version:'2.0.0'}}};await h.api.loadPluginCenter();assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null);assert.equal(h.id('pluginDetail').querySelectorAll('.plugin-tool')[0].querySelector('textarea')?.value,'{}');assert.equal(h.id('pluginDetail').querySelectorAll('.plugin-tool')[0].open,false);assert.doesNotMatch(h.id('pluginDetail').textContent,/上次查询：/);
});

test('disabled, uninstalled and identity-reset plugins release cached data and parameters',async()=>{
  const h=harness();let record:any=detail();installFixtureServer(h,()=>record);await installed(h);await h.button('查询').click();assert.equal(h.api.pluginCenter.state.runtime.size,1);assert.ok(h.api.pluginCenter.state.cacheChars>0);record={...record,enabled:false};await h.api.loadPluginCenter();assert.equal(h.api.pluginCenter.state.runtime.size,0);assert.equal(h.api.pluginCenter.state.cacheChars,0);
  record={...record,enabled:true};await h.api.loadPluginCenter();await h.button('查询').click();await h.button('卸载插件').click();await h.button('确认卸载').click();assert.equal(h.api.pluginCenter.state.runtime.size,0);await h.api.pluginCenter.selectPlugin('device-diagnostics');await h.button('查询').click();h.api.resetPluginCenterScope();assert.equal(h.api.pluginCenter.state.runtime.size,0);assert.equal(h.api.pluginCenter.state.cacheChars,0);assert.equal(h.api.pluginCenter.state.disclosures.size,0);assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null);
});

test('query failure remains explicit after a same-package refresh and cannot resurrect the previous successful value',async()=>{
  const h=harness();const record=detail();let failed=false;installFixtureServer(h,()=>record,async()=>failed?response({ok:false,error:'source_unavailable'},503):response(execution(5)));await installed(h);await h.button('查询').click();failed=true;await h.button('查询').click();await h.api.loadPluginCenter();assert.equal(h.id('pluginDetail').querySelector('.plugin-stat'),null);assert.match(h.id('pluginDetail').textContent,/请求未完成|暂不可用/);assert.match(h.id('pluginDetail').textContent,/上次尝试：/);assert.equal(h.id('pluginDetail').querySelector('.plugin-panel-output')!.querySelector('.plugin-feedback')!.getAttribute('role'),'alert');
});

test('inflight query survives same-package detail reload without a stuck loading state',async()=>{
  const h=harness();const record=detail();let complete!:(value:Response)=>void;installFixtureServer(h,()=>record,()=>new Promise(resolve=>{complete=resolve}));await installed(h);const pending=h.button('查询').click();await h.flush();await h.api.loadPluginCenter();complete(response(execution(11)));await pending;assert.equal(h.id('pluginDetail').querySelector('.plugin-stat')?.textContent,'11');assert.doesNotMatch(h.id('pluginDetail').querySelector('.plugin-panel-output')!.textContent,/正在查询/);assert.equal(h.api.pluginCenter.state.runtime.get('device-diagnostics').panels.get('count').busy,false);
});

test('version-exists errors offer a local patch bump rather than a revision refresh; prerelease versions remain manual',async()=>{
  const h=harness();await installed(h);h.setResponse(async()=>response({ok:false,error:'plugin_version_exists'},409));await h.button('校验并发布').click();assert.match(h.id('pluginEditorReceipt').textContent,/提升发布版本/);assert.equal(h.id('pluginEditorReceipt').querySelectorAll('button').some(node=>node.textContent.includes('刷新')),false);const count=h.calls.length;await h.button('使用下一补丁版本',h.id('pluginEditorReceipt')).click();assert.equal(h.calls.length,count);assert.equal(JSON.parse(h.id('pluginManifestEditor').value).version,'1.0.2');assert.equal(h.api.pluginCenter.state.editors.get('device-diagnostics').dirty,true);
  h.id('pluginManifestEditor').value=JSON.stringify({...manifest('1.0.2-rc.1')});await h.id('pluginManifestEditor').dispatch('input');await h.button('恢复服务端内容').click();await h.button('确认恢复').click();assert.equal(JSON.parse(h.id('pluginManifestEditor').value).version,'1.0.1');assert.equal(h.calls.length,count);
});

test('restore requires inline confirmation for dirty content and clears only the selected editor without API writes',async()=>{
  const h=harness();await installed(h);h.api.pluginCenter.state.editors.set('another-plugin',{manifest:'{"private":"keep"}',config:'{}',dirty:true});h.id('pluginConfigEditor').value='{"local":true}';await h.id('pluginConfigEditor').dispatch('input');const count=h.calls.length;await h.button('恢复服务端内容').click();assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{local:true});await h.button('取消恢复').click();assert.equal(h.id('pluginDetail').querySelector('.plugin-restore-confirm')!.hidden,true);await h.button('恢复服务端内容').click();await h.button('确认恢复').click();assert.deepEqual(JSON.parse(h.id('pluginConfigEditor').value),{});assert.equal(h.api.pluginCenter.state.editors.get('device-diagnostics').dirty,false);assert.match(h.api.pluginCenter.state.editors.get('another-plugin').manifest,/private/);assert.equal(h.calls.length,count);
});

test('diagnostic receipts stay collapsed until requested and empty workflow receipts remain an error',async()=>{
  const h=harness();const record=detail();let empty=false;installFixtureServer(h,()=>record,async call=>call.url.includes('/workflows/')?response({ok:true,result:{steps:empty?[]:[{toolId:'status',data:{online:true},receipt:{id:'actual-step'}}]}}):response(execution({online:true})));await installed(h);const tool=h.id('pluginDetail').querySelectorAll('.plugin-tool')[0];await h.button('执行只读查询',tool).click();assert.equal(tool.querySelector('.plugin-runtime-receipt')!.open,false);assert.match(tool.textContent,/只读查询完成/);const workflow=h.id('pluginDetail').querySelectorAll('.plugin-tool')[1];await h.button('运行只读工作流',workflow).click();assert.equal(workflow.querySelector('.plugin-runtime-receipt')!.open,false);assert.match(workflow.textContent,/actual-step/);empty=true;await h.button('运行只读工作流',workflow).click();assert.match(workflow.textContent,/未返回步骤回执/);assert.equal(h.id('pluginStatus').getAttribute('role'),'alert');
});

test('invalid typed values survive a detail refresh as unsaved input, instead of reverting to the old valid value',async()=>{
  const h=harness();const record:any=detail();record.draft.manifest.configSchema={type:'object',properties:{hours:{type:'integer',description:'回看小时'}},required:['hours']};record.draft.config={hours:24};installFixtureServer(h,()=>record);await installed(h);configField(h,'hours').value='1.5';await configField(h,'hours').dispatch('input');await h.api.loadPluginCenter();assert.equal(configField(h,'hours').value,'1.5');await h.button('保存草稿').click();assert.equal(h.calls.some(call=>call.method==='POST'),false);assert.match(h.id('pluginEditorReceipt').textContent,/有效的回看小时/);
});

test('prerelease version helper makes no automatic change or write and explains manual editing',async()=>{
  const h=harness();const record:any=detail();record.draft.manifest.version='1.0.1-rc.1';h.setRecord(record);await installed(h);h.setResponse(async()=>response({ok:false,error:'plugin_version_exists'},409));await h.button('校验并发布').click();const count=h.calls.length;await h.button('使用下一补丁版本',h.id('pluginEditorReceipt')).click();assert.equal(h.calls.length,count);assert.equal(JSON.parse(h.id('pluginManifestEditor').value).version,'1.0.1-rc.1');assert.match(h.id('pluginStatus').textContent,/预发布版本不自动递增/);
});

test('invalid diagnostic JSON parameters keep their error and raw input after a same-package refresh',async()=>{
  const h=harness();const record=detail();installFixtureServer(h,()=>record);await installed(h);const tool=h.id('pluginDetail').querySelectorAll('.plugin-tool')[0],input=tool.querySelector('textarea')!;input.value='{invalid';await input.dispatch('input');await h.button('执行只读查询',tool).click();assert.equal(h.calls.some(call=>call.url.includes('/tools/')),false);await h.api.loadPluginCenter();const restored=h.id('pluginDetail').querySelectorAll('.plugin-tool')[0];assert.equal(restored.querySelector('textarea')?.value,'{invalid');assert.match(restored.textContent,/参数 JSON 无效/);
});
