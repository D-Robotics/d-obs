import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';
import { DATA_CENTER_SCRIPT, renderDataCenterPage, DATA_CENTER_WORKSPACE_HTML, DATA_CENTER_WORKSPACE_STYLE, DATA_CENTER_WORKSPACE_BOOTSTRAP } from './data-center-page.js';

type Event = { preventDefault(): void; target: Node; clientX?: number; clientY?: number };
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  ownText = '';
  className = '';
  private controlValue = '';
  name = '';
  private controlType = '';
  id = '';
  required = false;
  disabled = false;
  readOnly = false;
  hidden = false;
  checked = false;
  open = false;
  min = '';
  max = '';
  href = '';
  download = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  files: Array<{ name: string; size: number; type?: string; arrayBuffer(): Promise<ArrayBuffer> }> = [];
  listeners: Record<string, Array<(event: Event) => unknown>> = {};
  constructor(readonly tagName: string, readonly document: Document) {}
  get type(): string { return this.tagName === 'textarea' ? 'textarea' : this.tagName === 'select' ? 'select-one' : this.controlType; }
  set type(value: string) { if (this.tagName === 'textarea' || this.tagName === 'select') throw new TypeError('HTMLTextAreaElement / HTMLSelectElement type is read only'); this.controlType = value; }
  get value(): string { return this.controlValue; }
  set value(value: string) { this.controlValue = this.tagName !== 'select' || this.children.some(option => option.value === value) ? value : ''; }
  get textContent(): string { return this.ownText + this.children.map(node => node.textContent).join(' '); }
  set textContent(text: string) { this.ownText = String(text); this.replaceChildren(); }
  get innerHTML(): never { throw new Error('Unsafe innerHTML read'); }
  set innerHTML(_text: string) { throw new Error('Unsafe innerHTML write'); }
  get isConnected(): boolean { return this === this.document.body || Boolean(this.parent?.isConnected); }
  appendChild(node: Node) { node.parent = this; this.children.push(node); if (this.tagName === 'select' && this.children.length === 1) this.value = node.value; return node; }
  replaceChildren(...nodes: Node[]) { this.children.forEach(node => { node.parent = null; }); this.children = []; nodes.forEach(node => this.appendChild(node)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter: string) => letter.toUpperCase())] = value; if (name === 'class') this.className = value; if (name === 'id') this.id = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(type: string, handler: (event: Event) => unknown) { (this.listeners[type] ||= []).push(handler); }
  querySelectorAll(selector: string): Node[] { return descendants(this).slice(1).filter(node => matches(node,selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.document.activeElement = this; }
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return {left:0,right:600,top:0,bottom:500}; }
  reportValidity() { return this.querySelectorAll('input,select,textarea').every(node => node.disabled || !node.required || (node.type === 'checkbox' ? node.checked : node.type === 'file' ? node.files.length > 0 : node.value !== '')); }
  click() { return this.fire('click'); }
  async fire(type: string) { if (this.disabled && type !== 'submit') return; for (const handler of this.listeners[type] || []) await handler({preventDefault() {},target:this}); }
}
const descendants = (node: Node): Node[] => [node,...node.children.flatMap(descendants)];
function matches(node: Node,selector: string): boolean {
  return selector.split(',').some(part => { const item = part.trim(); if (item.startsWith('.')) return node.className.split(' ').includes(item.slice(1)); if (item.startsWith('#')) return node.id === item.slice(1); const attribute = item.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/); if (attribute) return attribute[2] === undefined ? attribute[1] in node.attributes || attribute[1].startsWith('data-') && node.dataset[attribute[1].slice(5)] !== undefined : node.attributes[attribute[1]] === attribute[2]; return node.tagName === item; });
}
class Document {
  body = new Node('body',this);
  documentElement = new Node('html',this);
  activeElement: Node | null = null;
  constructor(html: string) {
    const stack = [this.body]; const source = html.slice(html.indexOf('<body>') + 6,html.indexOf('<script>')); const pattern = /<([^>]+)>|([^<]+)/g;
    for (const match of source.matchAll(pattern)) {
      if (match[2]) { stack[stack.length - 1].ownText += match[2]; continue; }
      const token = match[1]; if (token.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
      const tag = token.match(/^([a-z-]+)/)?.[1]; if (!tag) continue; const node = this.createElement(tag);
      for (const attr of token.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)) { node.setAttribute(attr[1],attr[2] ?? ''); if (attr[1] === 'type') node.type = attr[2]; if (attr[1] === 'required') node.required = true; if (attr[1] === 'hidden') node.hidden = true; }
      stack[stack.length - 1].appendChild(node); if (!['input','meta','br','hr','img'].includes(tag)) stack.push(node);
    }
  }
  getElementById(id: string) { return descendants(this.body).find(node => node.id === id) || null; }
  createElement(tag: string) { return new Node(tag,this); }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
}
type Asset = {id:string;title:string;kind:string;source:string;project:string;targetId?:string;storage:string;sizeBytes:number;sha256?:string;filename?:string;taskId?:string;referenceUri?:string;createdAt:string;tags?:string[]};
type Task = {id:string;title:string;kind:string;source:string;project:string;targetId:string;status:string;expectedCount:number;assetIds:string[]};
type Dataset = {id:string;name:string;project:string;version:number;assetIds:string[];assets:Asset[]};
type Evidence = {stage:string;assetId:string;sha256?:string;version:string;targetId:string;notes:string;baselineValue?:number;candidateValue?:number;passed?:boolean};
type Loop = {id:string;title:string;goal:string;project:string;targetId:string;datasetId:string;status:string;baseline:{metric:string;value:number;assetId:string;version:string;unit?:string};criterion:{direction:string;threshold:number};evidence:Evidence[]};
type Request = {path:string;options:{method?:string;body?:unknown;credentials:string;headers:Record<string,string>;signal:AbortSignal}};
const uploaded = (id='asset-1',title='实际基线文件'): Asset => ({id,title,kind:'image',source:'edge',project:'vision-project',targetId:'camera-1',storage:'uploaded',sizeBytes:8,filename:id+'.png',sha256:'a'.repeat(64),createdAt:'2026-10-12T01:00:00Z'});
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(options: {assets?:Asset[];tasks?:Task[];datasets?:Dataset[];loops?:Loop[];failed?:string;readOnly?:boolean;token?:string;session?:string;experiments?:unknown[];failMutation?:string;partialAssetIds?:string[];deferMutation?:boolean;denyToken?:string;deferBodySuffix?:string;unauthorized?:boolean;mounted?:boolean} = {}) {
  const document = new Document(options.mounted ? '<body>'+DATA_CENTER_WORKSPACE_HTML+'<script>' : renderDataCenterPage()); const requests: Request[] = []; const assets = [...(options.assets || [])]; const tasks = [...(options.tasks || [])]; const datasets = [...(options.datasets || [])]; const loops = [...(options.loops || [])]; const session = new Map<string,string>([['d_obs_admin_token',options.token || 'admin-fixture'],['d_obs_sso_session',options.session || 'sso-fixture']]); const local = new Map<string,string>(); let failed = options.failed; let mutationFailure = options.failMutation; let readOnly=options.readOnly; let unauthorized=options.unauthorized; let releaseMutation: (() => void) | null = null; let releaseBody: (() => void) | null = null; let createdDownloads=0;
  const context = vm.createContext({ document,location:{pathname:'/dobs/ops-observability/data-center',search:'',hash:'',href:'https://example.test/dobs/ops-observability/data-center',origin:'https://example.test'},history:{replaceState() {}},window:{addEventListener() {},matchMedia:() => ({matches:false})},sessionStorage:{getItem:(key:string) => session.get(key),setItem:(key:string,value:string) => session.set(key,value)},localStorage:{getItem:(key:string) => local.get(key),setItem:(key:string,value:string) => local.set(key,value)},URL:class extends URL {static createObjectURL() {createdDownloads++;return 'blob:protected-download';} static revokeObjectURL() {}},AbortController,setTimeout,clearTimeout,crypto:webcrypto,navigator:{clipboard:{writeText:async (token:string) => {copied = token;}}},fetch:async (path:string,request:Request['options']) => {
    requests.push({path,options:request}); const suffix = path.replace('/dobs/api/ops/observability/data-center',''); const method = request.method || 'GET'; let status = 200; let data: any = {ok:true,contract:'rdk.data-center.v1'};
    if (method !== 'GET' && options.deferMutation) await new Promise<void>(resolve => {releaseMutation=resolve;});
    if (unauthorized || options.denyToken && request.headers['x-admin-token'] === options.denyToken) {status=403;data={ok:false,error:'not_authorized'};}
    else if (suffix === failed) {status=503;data={ok:false,error:'storage_unavailable'};}
    else if (method !== 'GET' && mutationFailure) {status=503;data={ok:false,error:mutationFailure,assetIds:options.partialAssetIds};}
    else if (suffix === '/capabilities') data.readOnly = Boolean(readOnly);
    else if (suffix === '/overview') data.overview = {counts:{assets:assets.length,tasks:tasks.length,datasets:datasets.length,loops:loops.length,uploadedBytes:assets.filter(asset => asset.storage === 'uploaded').reduce((sum,asset) => sum+asset.sizeBytes,0)},sources:{cloud:assets.filter(asset => asset.source === 'cloud').length,edge:assets.filter(asset => asset.source === 'edge').length},pendingLoops:loops.filter(loop => loop.status !== 'verified')};
    else if (suffix === '/assets/upload') {const meta=JSON.parse(decodeURIComponent(request.headers['x-data-asset']));const file=request.body as {size:number}; const asset={...meta,id:'asset-'+(assets.length+1),storage:'uploaded',sizeBytes:file.size,createdAt:'2026-10-12T01:00:00Z'};assets.push(asset);if(meta.taskId){const task=tasks.find(task => task.id === meta.taskId)!;task.assetIds.push(asset.id);task.status='collecting';}data.asset=asset;}
    else if (suffix === '/assets' && method === 'POST') {const asset={...JSON.parse(String(request.body)),id:'asset-'+(assets.length+1),storage:'external',sizeBytes:0,createdAt:'2026-10-12T01:00:00Z'};assets.push(asset);data.asset=asset;}
    else if (suffix === '/assets') data.assets=assets;
    else if (/^\/assets\/[^/]+$/.test(suffix) && method === 'DELETE') {const id=decodeURIComponent(suffix.split('/')[2]);if(datasets.some(dataset => dataset.assetIds.includes(id))){status=409;data={ok:false,error:'data_center_asset_in_use'};}else assets.splice(assets.findIndex(asset => asset.id === id),1);}
    else if (suffix === '/tasks' && method === 'POST') {const task={...JSON.parse(String(request.body)),id:'task-'+(tasks.length+1),status:'planned',assetIds:[]};tasks.push(task);data.task=task;}
    else if (suffix === '/tasks') data.tasks=tasks;
    else if (suffix.endsWith('/status')) {const task=tasks.find(task => task.id === suffix.split('/')[2])!;const body=JSON.parse(String(request.body));if(body.status==='completed'&&task.assetIds.length!==task.expectedCount){status=409;data={ok:false,error:'data_center_task_incomplete'};}else task.status=body.status;}
    else if (suffix.endsWith('/token')) {data.token='task-only-secret';data.ingestPath='/api/data-center/ingest/'+suffix.split('/')[2];}
    else if (suffix === '/datasets' && method === 'POST') {const body=JSON.parse(String(request.body));const dataset={...body,id:'dataset-'+(datasets.length+1),version:1,assets:assets.filter(asset => body.assetIds.includes(asset.id))};datasets.push(dataset);data.dataset=dataset;}
    else if (suffix === '/datasets') data.datasets=datasets;
    else if (suffix === '/loops' && method === 'POST') {const loop={...JSON.parse(String(request.body)),id:'loop-'+(loops.length+1),status:'open',evidence:[]};loops.push(loop);data.loop=loop;}
    else if (suffix === '/loops') data.loops=loops;
    else if (suffix.endsWith('/evidence')) {const loop=loops.find(loop => loop.id === suffix.split('/')[2])!;const evidence=JSON.parse(String(request.body));evidence.sha256=assets.find(asset=>asset.id===evidence.assetId)?.sha256;if(evidence.stage==='verification'){evidence.passed=loop.criterion.direction==='increase'?evidence.candidateValue-loop.baseline.value>=loop.criterion.threshold:loop.baseline.value-evidence.candidateValue>=loop.criterion.threshold;loop.status=evidence.passed?'verified':'verification_failed';}else loop.status={analysis:'analyzed',evaluation:'evaluated',deployment:'deployed'}[evidence.stage as 'analysis'];loop.evidence.push(evidence);data.loop=loop;}
    else if (suffix === '/vision-experiments') data.experiments=options.experiments || [];
    else if (suffix.startsWith('/imports/vision/')) {assets.push(uploaded('imported-1'));datasets.push({id:'imported-dataset',name:'真实视觉实验',project:'vision-project',version:1,assetIds:['imported-1'],assets:[uploaded('imported-1')]});data.qualityVerification='unverified';}
    const snapshot=JSON.parse(JSON.stringify(data)); const waitForBody=async()=>{if(suffix===options.deferBodySuffix)await new Promise<void>(resolve=>{releaseBody=resolve;});};return {status,ok:status<400,headers:{get:(key:string)=>key==='x-rdk-ops-read-only'&&readOnly?'1':null},json:async()=>{await waitForBody();return snapshot;},blob:async()=>{await waitForBody();return {protected:true};}};
  }}); let copied=''; const navigations:string[]=[]; let mounted:any=null; if(options.mounted){vm.runInContext(DATA_CENTER_WORKSPACE_BOOTSTRAP,context);mounted=vm.runInContext('createDataCenterWorkspace',context)({root:document.getElementById('dataCenterWorkspace'),base:'/dobs',headers:(mutation:boolean)=>({'x-admin-token':session.get('d_obs_admin_token'),'x-rdk-sso-session':session.get('d_obs_sso_session'),...(mutation?{'X-RDK-Ops-Action':'observability'}:{})}),identity:()=>JSON.stringify([...session]),navigate:(view:string)=>navigations.push(view)});}else vm.runInContext(DATA_CENTER_SCRIPT,context);
  const get=(id:string) => {const node=document.getElementById(options.mounted?'dc-'+id:id);assert.ok(node,'missing actual shell ID '+id);return node;};
  return {document,requests,assets,tasks,datasets,loops,session,local,get,mounted,navigations,get copied(){return copied;},get createdDownloads(){return createdDownloads;},failRead(value?:string){failed=value;},failWrite(value?:string){mutationFailure=value;},setReadOnly(value:boolean){readOnly=value;},setUnauthorized(value:boolean){unauthorized=value;},release(){assert.ok(releaseMutation);releaseMutation();},releaseBody(){assert.ok(releaseBody);releaseBody();},async view(view:string){const node=document.querySelectorAll('[data-view]').find(node=>node.dataset.view===view);assert.ok(node);await node.fire('click');},async submit(){await get('editorForm').fire('submit');await settle();}};
}
function byText(root:Node,text:string) { const node=descendants(root).find(node=>node.tagName==='button'&&node.textContent===text);assert.ok(node,'missing button '+text);return node; }
function control(root:Node,name:string) { const node=descendants(root).find(node=>node.name===name);assert.ok(node,'missing field '+name);return node; }
function fill(root:Node,values:Record<string,string>) {Object.entries(values).forEach(([name,value])=>{control(root,name).value=value;});}
const file = () => ({name:'actual.png',size:8,type:'image/png',async arrayBuffer(){return new Uint8Array([0,1,2,3,4,5,6,7]).buffer;}});
const ready = async (h:ReturnType<typeof setup>) => {await settle();await settle();assert.match(h.get('workspace').textContent,/建立一个可验证的闭环/);};

test('shell uses five task entries, real native dialog, responsive themes and executable safe script',()=>{
  const html=renderDataCenterPage(); new vm.Script(DATA_CENTER_SCRIPT);
  assert.equal((html.match(/class="nav-item"/g)||[]).length,5);
  assert.match(html,/<dialog[^>]+aria-labelledby="editorTitle"[^>]+aria-describedby="editorHint"/);
  assert.match(html,/@media\(prefers-color-scheme:dark\)/);assert.match(html,/@media\(max-width:760px\)/);assert.match(html,/跳到主内容/);assert.match(html,/role="status" aria-live="polite"/);
  assert.match(html,/\.btn\.primary:hover:enabled\{background:var\(--accent\);color:var\(--paper\)\}/);
  assert.doesNotMatch(html,/innerHTML|<script\s+src=|模拟数据|所有设备已接入|设备已上线|零异常/);
});
test('initial reads keep deployment prefix and authentication, with no automatic writes or external fetch',async()=>{
  const h=setup();await ready(h);assert.equal(h.requests.length,6);for(const request of h.requests){assert.match(request.path,/^\/dobs\/api\/ops\/observability\/data-center\//);assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.headers['x-admin-token'],'admin-fixture');assert.equal(request.options.headers['x-rdk-sso-session'],'sso-fixture');assert.equal(request.options.method,undefined);}
  assert.equal(h.get('consoleLink').href,'/dobs/ops-observability');assert.equal(h.get('visionLink').href,'/dobs/ops-observability/vision-workshop');
  await h.view('assets');assert.match(h.get('workspace').textContent,/还没有数据资产/);await h.view('tasks');assert.match(h.get('workspace').textContent,/还没有采集任务/);
});
test('failed storage reads are visible, never shown as zero or empty, and recover on retry',async()=>{
  const h=setup({failed:'/assets'});await settle();await settle();assert.match(h.get('workspace').textContent,/数据中心暂时无法读取.*storage_unavailable/);assert.doesNotMatch(h.get('workspace').textContent,/还没有数据资产|暂无待处理闭环/);h.failRead();await byText(h.get('workspace'),'重试').fire('click');await settle();assert.match(h.get('workspace').textContent,/建立一个可验证的闭环/);
});
test('upload sends original file bytes, actual SHA-256 and declared provenance',async()=>{
  const h=setup();await ready(h);await h.view('assets');await byText(h.get('workspace'),'上传文件').fire('click');fill(h.get('editorFields'),{title:'真实逆光样本',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',tags:'逆光, 基线',collectedAt:'2026-10-12T09:00'});const actual=file();control(h.get('editorFields'),'file').files=[actual];await h.submit();
  const request=h.requests.find(item=>item.path.endsWith('/assets/upload'))!;assert.ok(request);assert.equal(request.options.body,actual);assert.equal(request.options.headers['content-type'],'application/octet-stream');assert.equal(request.options.headers['X-RDK-Ops-Action'],'observability');const meta=JSON.parse(decodeURIComponent(request.options.headers['x-data-asset']));assert.equal(meta.sha256,createHash('sha256').update(Buffer.from([0,1,2,3,4,5,6,7])).digest('hex'));assert.equal(meta.collectedAt,'2026-10-12T01:00:00.000Z');assert.deepEqual(meta.tags,['逆光','基线']);assert.equal(h.get('editor').open,false);assert.match(h.get('feedback').textContent,/真实文件已归档/);assert.equal(byText(h.get('workspace'),'上传文件').disabled,false);
});
test('external registration never reads its URI and asset search safely renders hostile names',async()=>{
  const h=setup({assets:[uploaded('existing','<img src=x onerror=alert(1)>')]});await ready(h);await h.view('assets');assert.equal(h.get('workspace').querySelectorAll('img').length,0);assert.match(h.get('workspace').textContent,/<img src=x onerror=alert\(1\)>/);await byText(h.get('workspace'),'登记外部引用').fire('click');fill(h.get('editorFields'),{title:'远程结果',source:'cloud',kind:'document',project:'cloud-project',referenceUri:'s3://results/actual/report.json'});await h.submit();assert.equal(h.assets[1].storage,'external');assert.equal(h.requests.filter(request=>!request.path.startsWith('/dobs/api/')).length,0);const source=control(h.get('workspace'),'source');source.value='cloud';await source.fire('change');assert.match(h.get('workspace').textContent,/远程结果/);assert.doesNotMatch(h.get('workspace').textContent,/<img/);const search=control(h.get('workspace'),'search');search.value='does-not-exist';await search.fire('input');assert.match(h.get('workspace').textContent,/没有符合条件的资产/);
});
test('task collection, scoped credential and immutable dataset flows use actual form requests',async()=>{
  const h=setup();await ready(h);await h.view('tasks');await byText(h.get('workspace'),'创建采集任务').fire('click');fill(h.get('editorFields'),{title:'终端现场采集',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:'1'});await h.submit();assert.equal(h.tasks[0].status,'planned');assert.match(h.get('workspace').textContent,/待采集/);assert.doesNotMatch(h.get('workspace').textContent,/采集完成/);
  await byText(h.get('workspace'),'采集接入').fire('click');assert.match(h.get('editorHint').textContent,/重新签发会使旧凭据失效/);await h.submit();assert.equal(control(h.get('editorFields'),'token').value,'task-only-secret');await byText(h.get('editorFields'),'复制 token').fire('click');assert.equal(h.copied,'task-only-secret');assert.equal([...h.local.values()].includes('task-only-secret'),false);assert.equal([...h.session.values()].includes('task-only-secret'),false);const client=h.get('editorFields').querySelector('a')!;assert.equal(client.href,'/dobs/ops-observability/data-center/upload-client.mjs');assert.equal(client.download,'data-center-upload.mjs');const code=h.get('editorFields').querySelectorAll('pre')[0];assert.match(code.textContent,/RDK_DATA_COLLECTION_TOKEN/);assert.doesNotMatch(code.textContent,/task-only-secret/);assert.match(code.textContent,/--origin https:\/\/example.test\/dobs --task task-1 --file/);await h.get('editorClose').fire('click');assert.equal(h.get('editorFields').textContent,'');
  await byText(h.get('workspace'),'上传任务文件').fire('click');fill(h.get('editorFields'),{title:'终端现场文件'});control(h.get('editorFields'),'file').files=[file()];assert.equal(control(h.get('editorFields'),'project').disabled,true);await h.submit();assert.equal(h.tasks[0].status,'collecting');await byText(h.get('workspace'),'更新状态').fire('click');fill(h.get('editorFields'),{status:'completed'});await h.submit();assert.equal(h.tasks[0].status,'completed');
  await h.view('datasets');await byText(h.get('workspace'),'创建数据集').fire('click');fill(h.get('editorFields'),{name:'现场基线',project:'vision-project'});h.get('editorFields').querySelectorAll('input').find(node=>node.type==='checkbox')!.checked=true;await h.submit();assert.deepEqual(h.datasets[0].assetIds,[h.assets[0].id]);assert.match(h.get('workspace').textContent,/不可变快照/);
});
test('incomplete task cannot become completed and preserves the server rejection',async()=>{
  const task:Task={id:'task-1',title:'需要两张图',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:2,status:'collecting',assetIds:[]};const h=setup({tasks:[task]});await ready(h);await h.view('tasks');await byText(h.get('workspace'),'更新状态').fire('click');fill(h.get('editorFields'),{status:'completed'});await h.submit();assert.equal(h.tasks[0].status,'collecting');assert.match(h.get('editorError').textContent,/data_center_task_incomplete/);assert.equal(h.get('editor').open,true);assert.equal(h.get('editorSubmit').disabled,false);
});
test('measured loop goes through all evidence stages and deployment stays unverified',async()=>{
  const base=uploaded();const result={...uploaded('asset-2','真实评测文件'),sha256:'b'.repeat(64)};const verification={...uploaded('asset-3','独立真实验收文件'),sha256:'c'.repeat(64)};const dataset:Dataset={id:'dataset-1',name:'真实基线集',project:'vision-project',version:1,assetIds:[base.id,result.id],assets:[base,result]};const h=setup({assets:[base,result,verification],datasets:[dataset]});await ready(h);await h.view('loops');await byText(h.get('workspace'),'创建闭环').fire('click');fill(h.get('editorFields'),{title:'提高真实效果',goal:'清晰度提升',project:'vision-project',targetId:'camera-1',datasetId:'dataset-1',metric:'清晰度',baselineValue:'10',version:'v1',direction:'increase',threshold:'2'});await control(h.get('editorFields'),'datasetId').fire('change');control(h.get('editorFields'),'assetId').value=base.id;await h.submit();assert.equal(h.loops[0].status,'open');await byText(h.get('workspace'),'查看证据').fire('click');
  for(const [label,stage] of [['分析','analysis'],['评测','evaluation'],['部署','deployment'],['效果验收','verification']]){await byText(h.get('workspace'),'提交'+label+'证据').fire('click');fill(h.get('editorFields'),{assetId:stage==='verification'?verification.id:result.id,version:'v2',notes:'实际文件和测量记录'});if(stage==='verification'){assert.equal(control(h.get('editorFields'),'baselineValue').value,'10');assert.deepEqual(control(h.get('editorFields'),'assetId').children.map(option=>option.value),['',verification.id]);control(h.get('editorFields'),'candidateValue').value='13';}await h.submit();if(stage==='deployment'){assert.equal(h.loops[0].status,'deployed');assert.match(h.get('workspace').textContent,/待验收 · unverified/);assert.doesNotMatch(h.get('workspace').textContent,/验收通过 · passed/);}}
  assert.equal(h.loops[0].status,'verified');assert.match(h.get('workspace').textContent,/验收通过 · passed/);assert.match(h.get('workspace').textContent,/测量来源：提交者申报；平台按固定标准计算结果，未自动执行设备测量/);const writes=h.requests.filter(item=>item.path.endsWith('/evidence'));assert.deepEqual(writes.map(item=>JSON.parse(String(item.options.body)).stage),['analysis','evaluation','deployment','verification']);assert.equal(JSON.parse(String(writes[3].options.body)).candidateValue,13);
});
test('failed measurements remain failed and can submit a later verification without inventing pass',async()=>{
  const base=uploaded();const result=uploaded('asset-2');const loop:Loop={id:'loop-1',title:'验收仍不足',goal:'实际目标',project:'vision-project',targetId:'camera-1',datasetId:'dataset-1',status:'verification_failed',baseline:{metric:'分数',value:10,assetId:base.id,version:'v1'},criterion:{direction:'increase',threshold:2},evidence:[{stage:'evaluation',assetId:result.id,version:'v2',targetId:'camera-1',notes:'真实评测'},{stage:'verification',assetId:result.id,version:'v2',targetId:'camera-1',notes:'实际测量',baselineValue:10,candidateValue:11,passed:false}]};const h=setup({assets:[base,result],loops:[loop]});await ready(h);await h.view('loops');await byText(h.get('workspace'),'查看证据').fire('click');assert.match(h.get('workspace').textContent,/验收未通过 · failed/);assert.equal(byText(h.get('workspace'),'提交效果验收证据').disabled,false);assert.doesNotMatch(h.get('workspace').textContent,/验收通过 · passed/);
});
test('read-only capability disables writes while keeping protected manifest downloads authenticated',async()=>{
  const h=setup({readOnly:true,assets:[uploaded()]});await ready(h);assert.match(h.get('accessNotice').textContent,/当前会话为只读/);await h.view('assets');assert.equal(byText(h.get('workspace'),'上传文件').disabled,true);assert.equal(byText(h.get('workspace'),'登记外部引用').disabled,true);await h.get('manifest').fire('click');const download=h.requests.find(request=>request.path.endsWith('/manifest'))!;assert.ok(download);assert.equal(download.options.headers['x-admin-token'],'admin-fixture');assert.equal(download.options.headers['x-rdk-ops-read-only'],'1');assert.equal(h.requests.filter(request=>request.options.method).length,0);
});
test('busy mutation freezes navigation and dialog cancellation, and restores controls on completion',async()=>{
  const h=setup({deferMutation:true});await ready(h);await h.view('tasks');await byText(h.get('workspace'),'创建采集任务').fire('click');fill(h.get('editorFields'),{title:'正在保存',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:'1'});const saving=h.get('editorForm').fire('submit');await settle();assert.equal(h.get('editorClose').disabled,true);assert.equal(h.document.querySelectorAll('[data-view]').every(node=>node.disabled),true);await h.view('assets');assert.match(h.get('workspace').textContent,/还没有采集任务/);h.release();await saving;assert.equal(h.get('editor').open,false);assert.equal(h.document.querySelectorAll('[data-view]').every(node=>!node.disabled),true);
});
test('vision import is on demand, exposes partial failure, and retains unverified semantics',async()=>{
  const h=setup({experiments:[{id:'exp-1',title:'真实实验',samples:1,images:1}],failMutation:'vision_import_partial',partialAssetIds:['partial-1']});await ready(h);assert.equal(h.requests.some(request=>request.path.endsWith('/vision-experiments')),false);await h.view('datasets');await byText(h.get('workspace'),'纳入视觉实验').fire('click');fill(h.get('editorFields'),{experimentId:'exp-1',project:'vision-project'});await h.submit();assert.match(h.get('editorError').textContent,/已部分归档 1 份资产；可安全重试/);h.failWrite();await h.submit();assert.match(h.get('feedback').textContent,/画质状态仍为 unverified/);assert.equal(h.datasets.length,1);assert.equal(h.get('editor').open,false);
});
test('asset removal requires deliberate confirmation and preserves in-use rejection',async()=>{
  const asset=uploaded();const dataset:Dataset={id:'dataset-1',name:'基线',project:asset.project,version:1,assetIds:[asset.id],assets:[asset]};const h=setup({assets:[asset],datasets:[dataset]});await ready(h);await h.view('assets');await byText(h.get('workspace'),'移除未引用资产').fire('click');await h.submit();assert.equal(h.requests.some(request=>request.options.method==='DELETE'),false);h.get('editorFields').querySelectorAll('input').find(node=>node.type==='checkbox')!.checked=true;await h.submit();assert.match(h.get('editorError').textContent,/data_center_asset_in_use/);assert.equal(h.assets.length,1);
});
test('uncertain write outcome is explicit and never automatically retried',async()=>{
  const h=setup({failMutation:'storage_write_timeout'});await ready(h);await h.view('tasks');await byText(h.get('workspace'),'创建采集任务').fire('click');fill(h.get('editorFields'),{title:'真实任务',source:'cloud',kind:'log',project:'p',targetId:'service-1',expectedCount:'1'});await h.submit();assert.match(h.get('editorError').textContent,/保存结果未知，请先刷新记录核对/);assert.equal(h.requests.filter(request=>request.options.method==='POST').length,1);assert.equal(h.get('editorSubmit').disabled,false);
});
test('switching credentials to a denied account clears all previous private assets and open token dialogs',async()=>{
  const task:Task={id:'task-1',title:'先前账号私有任务',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:1,status:'planned',assetIds:[]};const h=setup({assets:[uploaded('private-asset','先前账号私有资产')],tasks:[task],denyToken:'denied-account'});await ready(h);await h.view('tasks');await byText(h.get('workspace'),'采集接入').fire('click');await h.submit();assert.equal(control(h.get('editorFields'),'token').value,'task-only-secret');h.session.set('d_obs_admin_token','denied-account');await h.get('refresh').fire('click');assert.equal(h.get('editor').open,false);assert.equal(h.get('editorFields').textContent,'');assert.match(h.get('workspace').textContent,/请先登录可观测中心，再使用数据中心/);assert.doesNotMatch(h.get('workspace').textContent,/先前账号私有任务|先前账号私有资产|上次读取的记录/);await h.view('assets');assert.doesNotMatch(h.get('workspace').textContent,/先前账号私有资产/);
});
test('credential change before a form submission clears the old draft and sends no stale mutation',async()=>{
  const h=setup();await ready(h);await h.view('tasks');await byText(h.get('workspace'),'创建采集任务').fire('click');fill(h.get('editorFields'),{title:'旧账号创建草稿',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:'1'});h.session.set('d_obs_admin_token','new-admin');await h.submit();assert.equal(h.requests.filter(request=>request.options.method==='POST').length,0);assert.equal(h.get('editor').open,false);assert.equal(h.get('editorFields').textContent,'');assert.match(h.get('workspace').textContent,/账号或租户已变化/);
});
test('changing from a read-only identity to an authorized admin recomputes capabilities and unlocks writes',async()=>{
  const h=setup({readOnly:true});await ready(h);await h.view('assets');assert.equal(byText(h.get('workspace'),'上传文件').disabled,true);h.session.set('d_obs_admin_token','new-admin');h.setReadOnly(false);await h.get('refresh').fire('click');assert.equal(byText(h.get('workspace'),'上传文件').disabled,false);assert.equal(h.get('accessNotice').hidden,true);assert.equal(h.requests.slice(-6).some(request=>request.options.headers['x-rdk-ops-read-only']==='1'),false);
});
test('a token body resolving after an account switch cannot reveal the previous account credential',async()=>{
  const task:Task={id:'task-1',title:'先前账号采集任务',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:1,status:'planned',assetIds:[]};const h=setup({tasks:[task],deferBodySuffix:'/tasks/task-1/token'});await ready(h);await h.view('tasks');await byText(h.get('workspace'),'采集接入').fire('click');const pending=h.get('editorForm').fire('submit');await settle();h.session.set('d_obs_sso_session','another-account-session');h.releaseBody();await pending;assert.equal(h.get('editor').open,false);assert.equal(h.get('editorFields').textContent,'');assert.doesNotMatch(h.document.body.textContent,/task-only-secret/);assert.match(h.get('workspace').textContent,/账号或租户已变化/);
});
test('a protected file body resolving after an account switch cannot start the previous account download',async()=>{
  const h=setup({assets:[uploaded('private-asset','先前账号私有资产')],deferBodySuffix:'/manifest'});await ready(h);const pending=h.get('manifest').fire('click');await settle();h.session.set('d_obs_admin_token','another-account-admin');h.releaseBody();await pending;assert.equal(h.createdDownloads,0);assert.match(h.get('feedback').textContent,/下载失败.*账号或租户已变化/);assert.doesNotMatch(h.get('workspace').textContent,/先前账号私有资产/);assert.match(h.get('workspace').textContent,/账号或租户已变化/);
});
test('six denied reads produce one login guide without API paths or error codes, and authorized refresh restores actions',async()=>{
  const h=setup({assets:[uploaded('private-asset','私有资产不应泄露')],unauthorized:true});await settle();await settle();const visible=h.get('workspace').textContent;assert.equal((visible.match(/请先登录可观测中心，再使用数据中心。/g)||[]).length,1);assert.doesNotMatch(visible,/\/capabilities|\/overview|\/assets|\/tasks|\/datasets|\/loops|not_authorized|私有资产不应泄露/);assert.equal(h.get('feedback').hidden,true);assert.equal(h.get('feedback').textContent,'');const login=h.get('workspace').querySelector('a')!;assert.equal(login.textContent,'前往登录');assert.equal(login.href,'/dobs/ops-observability');assert.equal(h.get('manifest').disabled,true);assert.equal(h.get('accessNotice').hidden,true);await h.get('manifest').fire('click');assert.equal(h.requests.length,6);h.setUnauthorized(false);await byText(h.get('workspace'),'已登录，刷新').fire('click');assert.equal(h.get('manifest').disabled,false);await h.view('assets');assert.equal(byText(h.get('workspace'),'上传文件').disabled,false);assert.match(h.get('workspace').textContent,/私有资产不应泄露/);
});
test('a permission rejection during submission clears the draft and shows the same single login guide',async()=>{
  const h=setup();await ready(h);await h.view('tasks');await byText(h.get('workspace'),'创建采集任务').fire('click');fill(h.get('editorFields'),{title:'未保存的私有草稿',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1',expectedCount:'1'});h.setUnauthorized(true);await h.submit();assert.equal(h.get('editor').open,false);assert.equal(h.get('editorFields').textContent,'');assert.equal((h.get('workspace').textContent.match(/请先登录可观测中心，再使用数据中心。/g)||[]).length,1);assert.doesNotMatch(h.get('workspace').textContent,/not_authorized|\/tasks|未保存的私有草稿/);assert.equal(h.get('feedback').hidden,true);assert.equal(h.get('manifest').disabled,true);
});
test('mounted data uses the shared shell, root scope and lazy shared identity without its own navigation or theme',async()=>{
  new vm.Script(DATA_CENTER_WORKSPACE_BOOTSTRAP);assert.doesNotMatch(DATA_CENTER_WORKSPACE_HTML,/<html|<body|<header|<iframe|<h1/);assert.doesNotMatch(DATA_CENTER_WORKSPACE_STYLE,/(?:^|\n)(?:body|:root|h1|button)\s*\{/);assert.match(DATA_CENTER_WORKSPACE_STYLE,/\.data-center-workspace/);const h=setup({mounted:true});const outside=h.document.createElement('button');outside.textContent='主壳导航';h.document.body.appendChild(outside);assert.equal(h.requests.length,0);await h.mounted.show('assets');assert.equal(h.requests.length,6);assert.match(h.get('workspace').textContent,/还没有数据资产/);assert.equal(outside.disabled,false);for(const request of h.requests){assert.match(request.path,/^\/dobs\/api\/ops\/observability\/data-center\//);assert.equal(request.options.headers['x-rdk-sso-session'],'sso-fixture');}const tab=h.document.querySelectorAll('[data-dc-view]').find(node=>node.dataset.dcView==='datasets')!;await tab.fire('click');assert.deepEqual(h.navigations,['data/datasets']);assert.match(h.get('workspace').textContent,/还没有数据集版本/);h.mounted.reset();assert.equal(h.get('manifest').disabled,true);await h.mounted.show('assets');assert.equal(h.requests.length,12);
});
test('mounted data upload preserves exact bytes and scoped controls without changing the main shell',async()=>{
  const h=setup({mounted:true});const outside=h.document.createElement('input');outside.value='主壳筛选';h.document.body.appendChild(outside);await h.mounted.show('assets');await byText(h.get('workspace'),'上传文件').fire('click');fill(h.get('editorFields'),{title:'真实纳管文件',source:'edge',kind:'image',project:'vision-project',targetId:'camera-1'});const actual=file();control(h.get('editorFields'),'file').files=[actual];await h.submit();assert.equal(h.requests.find(request=>request.path.endsWith('/assets/upload'))!.options.body,actual);assert.match(h.get('feedback').textContent,/真实文件已归档/);assert.equal(outside.disabled,false);assert.equal(outside.value,'主壳筛选');assert.equal(h.get('editor').open,false);assert.equal(h.document.querySelectorAll('#editor').length,0);
});
test('mounted reset during initial loading schedules a fresh read after the in-flight request settles',async()=>{
  const h=setup({mounted:true,deferBodySuffix:'/assets'});const initial=h.mounted.show('assets');await settle();h.session.set('d_obs_sso_session','resolved-account-session');h.mounted.reset();h.mounted.show('assets');h.releaseBody();await initial;await settle();h.releaseBody();await settle();await settle();assert.equal(h.requests.length,12);assert.match(h.get('workspace').textContent,/还没有数据资产/);assert.equal(h.get('manifest').disabled,false);
});
test('mounted data exposes a global refresh method that reads current protected records',async()=>{
  const h=setup({mounted:true});await h.mounted.show('assets');assert.equal(typeof h.mounted.refresh,'function');h.assets.push(uploaded('global-refresh-asset','全局刷新后真实资产'));await h.mounted.refresh();assert.equal(h.requests.length,12);assert.match(h.get('workspace').textContent,/全局刷新后真实资产/);assert.equal(h.requests.some(request=>request.options.method),false);
});
