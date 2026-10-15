import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { COLLECTION_WORKSPACE_HTML, COLLECTION_WORKSPACE_STYLE, COLLECTION_WORKSPACE_BOOTSTRAP, COLLECTION_WORKSPACE_SCRIPT } from './collection-workspace-page.js';
import { DATA_CENTER_WORKSPACE_HTML, DATA_CENTER_WORKSPACE_SCRIPT } from './data-center-page.js';
import { COLLECTION_SHELL_IDENTITY_SCRIPT } from './observability-page-collection-integration.js';
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
  private controlDisabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection = 'none';
  readOnly = false;
  hidden = false;
  checked = false;
  selected = false;
  multiple = false;
  size = 0;
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
  get disabled(): boolean { return this.controlDisabled; }
  set disabled(value: boolean) { this.controlDisabled=value;if(value&&this.document.activeElement===this)this.document.activeElement=this.document.body; }
  setSelectionRange(start: number,end: number,direction='none') { this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction; }
  get type(): string { return this.tagName === 'textarea' ? 'textarea' : this.tagName === 'select' ? 'select-one' : this.controlType; }
  set type(value: string) { if (this.tagName === 'textarea' || this.tagName === 'select') throw new TypeError('HTMLTextAreaElement / HTMLSelectElement type is read only'); this.controlType = value; }
  get selectedOptions(): Node[] { return this.children.filter(option=>option.selected); }
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
  contains(node: Node) { return descendants(this).includes(node); }
  closest(selector: string): Node | null { let current:Node|null=this;while(current){if(matches(current,selector))return current;current=current.parent;}return null; }
  focus() { this.document.activeElement = this; }
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return {left:0,right:600,top:0,bottom:500}; }
  reportValidity() { return this.querySelectorAll('input,select,textarea').every(node => node.disabled || !node.required || (node.type === 'checkbox' ? node.checked : node.type === 'file' ? node.files.length > 0 : node.value !== '')); }
  click() { return this.fire('click'); }
  async fire(type: string) { if (this.disabled && type !== 'submit') return; let prevented=false;for (const handler of this.listeners[type] || []) await handler({preventDefault() { prevented=true; },target:this});if(type==='click'&&this.tagName==='summary'&&this.parent?.tagName==='details'&&!prevented){this.parent.open=!this.parent.open;await this.parent.fire('toggle');} }
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
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const moduleFixture=()=>({id:'ssh-logs',version:'1.0.0',mode:'pull',label:'SSH 单源日志',description:'已配置的真实来源',available:true,canStart:true,canStop:true,targets:[{id:'board-1',label:'已配置设备'}],fields:[{key:'targetId',label:'目标',type:'select',required:true,options:[{value:'board-1',label:'已配置设备'},{value:'board-2',label:'另一设备'}]},{key:'sourceId',label:'日志来源',type:'select',required:true,options:[{value:'journal',label:'系统日志',targetId:'board-1'},{value:'kernel',label:'内核日志',targetId:'board-2'}]},{key:'lines',label:'历史行数',type:'number',min:0,max:10000,default:200},{key:'durationSeconds',label:'采集时长',type:'number',min:5,max:1800,default:300},{key:'follow',label:'持续读取',type:'boolean',default:true}]});
type Request={path:string;options:{method?:string;body?:string;headers:Record<string,string>;credentials:string}};
function setup(options:{unavailable?:boolean;failed?:string;unauthorized?:boolean;deferBody?:string;receivers?:unknown[];legacyJobs?:unknown[];multiselect?:boolean;runs?:any[];pipelines?:any[];passive?:boolean;readOnly?:boolean}={}){
  const document=new Document('<body>'+COLLECTION_WORKSPACE_HTML+'<script>');const root=document.getElementById('collectionWorkspace')!;const outside=document.createElement('button');outside.textContent='主导航';document.body.appendChild(outside);const requests:Request[]=[];const navigations:string[]=[];let identity='account-1';let failed=options.failed;let releaseBody:(()=>void)|undefined;
  const module:any=moduleFixture();if(options.unavailable){module.available=false;module.reason='尚未配置采集目标';}if(options.passive){module.id='otlp';module.label='OTLP 遥测';module.canStart=false;module.canStop=false;module.mode='receiver';module.fields=[];}if(options.multiselect){module.id='rdk-logs';module.label='RDK 多源日志';module.fields[1]={...module.fields[1],key:'sourceIds',label:'日志来源',type:'multiselect',required:false};}
  const catalog:any={ok:true,readOnly:options.readOnly,modules:[module],sources:[{id:'source-1',label:'真实终端来源',source:'edge',state:'unknown',links:[{label:'查看设备',view:'devices/list'}]},{id:'source-2',label:'真实云端来源',source:'cloud',state:'configured',links:[{label:'查看接入凭据',view:'signals/tokens'}]}],receivers:options.receivers||[],legacyJobs:options.legacyJobs||[]};
  const pipelines:any[]=[...(options.pipelines||[])];const runs:any[]=[...(options.runs||[])];let timer=0;const timers=new Map<number,{fn:()=>unknown;delay:number}>();
  const context=vm.createContext({document,AbortController,setTimeout:(fn:()=>unknown,delay:number)=>{const id=++timer;timers.set(id,{fn,delay});return id;},clearTimeout(id:number){timers.delete(id);},fetch:async(path:string,request:Request['options'])=>{requests.push({path,options:request});const suffix=path.replace('/dobs/api/ops/observability/collection-workspace','');let status=200;let response:any={ok:true};
    if(options.unauthorized){status=403;response={ok:false,error:'not_authorized'};}
    else if(failed===suffix){status=503;response={ok:false,error:'collection_store_unavailable'};}
    else if(suffix==='/catalog')response=catalog;
    else if(suffix==='/pipelines'&&!request.method)response.pipelines=pipelines;
    else if(suffix==='/runs'&&!request.method)response.runs=runs;
    else if(suffix==='/pipelines'){const data=JSON.parse(request.body!);let pipeline=pipelines.find(item=>item.id===data.pipelineId);if(!pipeline){pipeline={id:'pipeline-1',versions:[],currentVersion:0};pipelines.push(pipeline);}Object.assign(pipeline,{name:data.name,project:data.project,source:data.source,moduleId:data.moduleId,moduleVersion:data.moduleVersion});pipeline.currentVersion++;pipeline.versions.push({...data,version:pipeline.currentVersion});response.pipeline=pipeline;}
    else if(suffix.endsWith('/runs')){const run={id:'run-1',pipelineId:'pipeline-1',pipelineVersion:JSON.parse(request.body!).version,moduleId:module.id,state:'running',nodeStates:[{id:'source',state:'running'},{id:'filter',state:'pending'},{id:'quality',state:'pending'},{id:'archive',state:'pending'}],assetIds:[],archiveState:'pending'};runs.unshift(run);response.run=run;}
    else if(suffix.endsWith('/stop')){runs[0].state='stopped';response.run=runs[0];}
    else if(suffix.endsWith('/finalize')){runs[0].archiveState='completed';runs[0].assetIds=['asset-actual'];runs[0].datasetId='dataset-actual';response.run=runs[0];}
    else if(suffix==='/runs/adopt'){const data=JSON.parse(request.body!);const run={id:'adopted-1',moduleId:data.moduleId,state:'completed',pipelineVersion:1,assetIds:['asset-1'],archiveState:'completed',nodeStates:[]};runs.push(run);response.run=run;}
    else if(suffix.includes('/receivers/')){const receiver=catalog.receivers.find((item:any)=>suffix.includes(item.id));receiver.config=JSON.parse(request.body!);receiver.desiredVersion=3;receiver.appliedVersion=2;response={ok:true,receiver:{...receiver,desiredVersion:3,appliedVersion:2}};}
    const data=JSON.parse(JSON.stringify(response));return {status,ok:status<400,headers:{get:()=>null},json:async()=>{if(suffix===options.deferBody)await new Promise<void>(resolve=>releaseBody=resolve);return data;}};
  }});
  vm.runInContext(COLLECTION_WORKSPACE_BOOTSTRAP,context);const workspace=vm.runInContext('createCollectionWorkspace',context)({root,base:'/dobs',headers:(mutation:boolean)=>({'x-admin-token':'fixture-admin',...(mutation?{'X-RDK-Ops-Action':'observability'}:{})}),identity:()=>identity,navigate:(view:string)=>navigations.push(view)});
  const q=(role:string)=>{const node=root.querySelector('[data-cw-role="'+role+'"]');assert.ok(node);return node;};
  return {document,root,outside,workspace,requests,navigations,pipelines,runs,q,timers,catalog,setIdentity(value:string){identity=value;},fail(value?:string){failed=value;},setUnauthorized(value:boolean){options.unauthorized=value;},setDeferredBody(value?:string){options.deferBody=value;},releaseBody(){assert.ok(releaseBody);releaseBody();},async poll(delay=4000){const pending=[...timers].find(([,value])=>value.delay===delay);assert.ok(pending);timers.delete(pending[0]);await pending[1].fn();await settle();}};
}
const byText=(root:Node,value:string)=>{const node=descendants(root).find(node=>node.tagName==='button'&&node.textContent===value);assert.ok(node,'missing button '+value);return node;};
const control=(root:Node,key:string)=>{const node=descendants(root).find(node=>node.name===key);assert.ok(node,'missing field '+key);return node;};
const visibleText=(node:Node):string=>node.hidden?'':node.ownText+(node.tagName==='details'&&!node.open?node.children.filter(child=>child.tagName==='summary'):node.children).map(visibleText).join(' ');
const disclosure=(root:Node,key:string)=>{const node=descendants(root).find(node=>node.dataset.cwDisclosure===key);assert.ok(node,'missing disclosure '+key);return node;};
async function input(root:Node,key:string,value:string){const node=control(root,key);node.value=value;await node.fire(node.tagName==='select'?'change':'input');}
async function configure(h:ReturnType<typeof setup>){await h.workspace.show('tasks');await byText(h.root,'新流程').fire('click');await input(h.root,'name','真实运行日志流程');await input(h.root,'project','现场项目');await input(h.root,'moduleId',h.root.textContent.includes('RDK 多源日志')?'rdk-logs':'ssh-logs');await input(h.root,'targetId','board-1');if(control(h.root,'moduleId').value==='ssh-logs')await input(h.root,'sourceId','journal');}

test('mounted shell has no independent header, iframe or global styles and uses a keyboard selectable flow',()=>{
  new vm.Script(COLLECTION_WORKSPACE_BOOTSTRAP);assert.match(COLLECTION_WORKSPACE_HTML,/id="view-collection"/);assert.doesNotMatch(COLLECTION_WORKSPACE_HTML,/<html|<body|<header|<iframe|<h1/);assert.doesNotMatch(COLLECTION_WORKSPACE_STYLE,/(?:^|\n)(?:body|:root|button|h1)\s*\{/);assert.match(COLLECTION_WORKSPACE_STYLE,/\.collection-workspace \.cw-node/);
});
test('show lazily reads real catalog and history with shared identity and never implicitly starts collection',async()=>{
  const h=setup();assert.equal(h.requests.length,0);await h.workspace.show('tasks');assert.equal(h.requests.length,3);h.requests.forEach(request=>{assert.match(request.path,/^\/dobs\/api\/ops\/observability\/collection-workspace\//);assert.equal(request.options.headers['x-admin-token'],'fixture-admin');assert.equal(request.options.method,undefined);});assert.equal(h.outside.disabled,false);assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.equal(h.root.querySelector('form[aria-label="采集流程配置"]'),null);assert.match(h.root.textContent,/还没有流程/);assert.doesNotMatch(h.root.textContent,/已完成|已接入/);
});
test('flow inspector serializes real module parameters, filters and quality as an immutable version then starts explicitly',async()=>{
  const h=setup();await configure(h);const source=control(h.root,'sourceId');assert.deepEqual(source.children.map(node=>node.value),['','journal']);await input(h.root,'lines','400');await input(h.root,'durationSeconds','60');const nodes=h.root.querySelectorAll('.cw-node');await nodes[1].fire('click');await input(h.root,'keywords','ERROR\nISP');await input(h.root,'filterMode','exclude');await h.root.querySelectorAll('.cw-node')[2].fire('click');await input(h.root,'minBytes','12');await h.root.querySelector('form')!.fire('submit');const save=h.requests.find(request=>request.options.method==='POST'&&request.path.endsWith('/pipelines'))!;const body=JSON.parse(save.options.body!);assert.deepEqual(body.config,{lines:400,durationSeconds:60,follow:true,targetId:'board-1',sourceId:'journal'});assert.deepEqual(body.filter,{keywords:['ERROR','ISP'],mode:'exclude'});assert.deepEqual(body.quality,{minBytes:12});assert.equal(body.moduleVersion,'1.0.0');assert.equal(body.createDataset,true);assert.equal(h.runs.length,0);await byText(h.root,'按此版本开始采集').fire('click');assert.equal(h.runs[0].state,'running');assert.ok(h.navigations.includes('collection/runs'));assert.match(h.root.textContent,/运行中/);assert.equal(h.outside.disabled,false);h.workspace.hide();
});
test('changing target filters multiselect sources and serializes an array without stale-device options',async()=>{
  const h=setup({multiselect:true});await configure(h);const sources=control(h.root,'sourceIds');assert.equal(sources.multiple,true);assert.deepEqual(sources.children.map(node=>node.value),['journal']);sources.children[0].selected=true;await sources.fire('change');await h.root.querySelector('form')!.fire('submit');let save=h.requests.find(request=>request.options.method==='POST')!;assert.deepEqual(JSON.parse(save.options.body!).config.sourceIds,['journal']);await input(h.root,'targetId','board-2');assert.deepEqual(control(h.root,'sourceIds').children.map(node=>node.value),['kernel']);await h.root.querySelector('form')!.fire('submit');save=h.requests.filter(request=>request.options.method==='POST').at(-1)!;assert.equal(JSON.parse(save.options.body!).config.sourceIds,undefined);assert.equal(h.pipelines[0].currentVersion,2);
});
test('unavailable module cannot save or start and failed reads never become empty or zero success',async()=>{
  const h=setup({unavailable:true});await h.workspace.show('modules');assert.match(h.root.textContent,/尚未配置采集目标/);assert.equal(byText(h.root,'用此模块配置流程').disabled,true);assert.equal(h.requests.filter(request=>request.options.method).length,0);const failure=setup({failed:'/catalog'});await failure.workspace.show('tasks');assert.match(failure.root.textContent,/暂时无法读取.*collection_store_unavailable/);assert.doesNotMatch(failure.root.textContent,/还没有流程/);failure.fail();await failure.workspace.show('tasks');assert.match(failure.root.textContent,/还没有流程/);
});
test('source catalog filters cloud and terminal while links navigate the existing shell',async()=>{
  const h=setup();await h.workspace.show('sources');await input(h.root,'sourceFilter','cloud');assert.match(h.root.textContent,/真实云端来源/);assert.doesNotMatch(h.root.textContent,/真实终端来源/);await byText(h.root,'查看接入凭据').fire('click');assert.deepEqual(h.navigations,['signals/tokens']);assert.equal(h.requests.filter(request=>request.options.method).length,0);
});
test('receiver edit reports desired versus applied versions without claiming daemon configuration is active',async()=>{
  const receiver={id:'cloud-log-bridge',label:'云端日志采集桥',state:'configured',config:{pollMs:3000,flushMs:5000,batch:64,queueLimit:2000},fields:['pollMs','flushMs','batch','queueLimit'].map(key=>({key,label:key,type:'number',required:true})),links:[]};const h=setup({receivers:[receiver]});await h.workspace.show('sources');await byText(h.root,'配置采集参数').fire('click');await input(h.q('dialogFields'),'pollMs','4000');await h.q('dialogForm').fire('submit');const request=h.requests.find(request=>request.path.endsWith('/receivers/cloud-log-bridge/config'))!;assert.deepEqual(JSON.parse(request.options.body!),{pollMs:4000,flushMs:5000,batch:64,queueLimit:2000});assert.match(h.q('feedback').textContent,/等待执行器确认应用/);assert.doesNotMatch(h.q('feedback').textContent,/已确认应用/);assert.equal(h.q('dialog').open,false);
});
test('existing jobs are adopted without a new collection start and terminal archive retry links real assets',async()=>{
  const job={moduleId:'ssh-logs',upstreamId:'actual-session',label:'已有现场日志',state:'completed',source:'edge',config:{targetId:'board-1',sourceId:'journal'},recordCount:3,byteCount:200};const h=setup({legacyJobs:[job]});await h.workspace.show('sources');await byText(h.root,'纳入运行与产物').fire('click');await input(h.q('dialogFields'),'project','现场项目');await h.q('dialogForm').fire('submit');const request=h.requests.find(request=>request.options.method==='POST')!;assert.match(request.path,/\/runs\/adopt$/);assert.equal(JSON.parse(request.options.body!).upstreamId,'actual-session');assert.equal(h.requests.some(request=>/\/pipelines\/[^/]+\/runs$/.test(request.path)),false);
  const terminal=setup({runs:[{id:'run-1',upstreamId:'actual-session',origin:'adopted',moduleId:'ssh-logs',state:'completed',archiveState:'failed',archiveError:'disk_full',assetIds:[],nodeStates:[{id:'archive',state:'failed'}]}]});await terminal.workspace.show('runs');assert.match(terminal.root.textContent,/历史运行已纳管/);assert.match(terminal.root.textContent,/纳管模板版本/);await byText(terminal.root,'重试归档已有产物').fire('click');assert.ok(terminal.requests.some(request=>request.path.endsWith('/runs/run-1/finalize')));await byText(terminal.root,'查看 1 份资产').fire('click');assert.deepEqual(terminal.navigations,['data/assets']);
});
test('deferred response body from an old identity clears drafts and cannot accept the old pipeline mutation',async()=>{
  const h=setup({deferBody:'/pipelines'});const boot=h.workspace.show('tasks');await settle();h.releaseBody();await boot;await configure(h);const pending=h.root.querySelector('form')!.fire('submit');await settle();h.setIdentity('account-2');h.releaseBody();await pending;assert.match(h.root.textContent,/账号或租户已变化|请求范围已变化/);assert.doesNotMatch(h.root.textContent,/真实运行日志流程/);assert.equal(h.requests.filter(request=>request.options.method==='POST').length,1);assert.equal(h.outside.disabled,false);
});
test('authorization failure provides one shared login guide and reset triggers real reads when shown again',async()=>{
  const h=setup({unauthorized:true});await h.workspace.show('tasks');assert.match(h.root.textContent,/请先登录可观测中心/);assert.doesNotMatch(h.root.textContent,/not_authorized|还没有流程/);const working=setup();await working.workspace.show('tasks');const count=working.requests.length;working.workspace.reset();await working.workspace.show('sources');assert.equal(working.requests.length,count+3);
});
test('terminal upstream left pending after restart offers archive recovery without starting collection',async()=>{
  const h=setup({runs:[{id:'run-1',upstreamId:'actual-session',moduleId:'ssh-logs',state:'stopped',archiveState:'pending',assetIds:[],nodeStates:[]}]});await h.workspace.show('runs');await byText(h.root,'归档已有产物').fire('click');assert.equal(h.requests.filter(request=>request.options.method==='POST').length,1);assert.match(h.requests.find(request=>request.options.method==='POST')!.path,/\/runs\/run-1\/finalize$/);
});
test('device pending receipts remain explicitly unconfirmed and partial history is disclosed',async()=>{
  const h=setup({receivers:[{id:'device-heartbeat',label:'设备心跳',state:'configured',commands:[{id:'command-1',deviceId:'board-1',type:'set-interval',payload:{intervalSeconds:30},status:'delivered'}],partial:true}]});await h.workspace.show('sources');assert.match(h.root.textContent,/等待设备回执|等待设备确认/);assert.match(h.root.textContent,/不能确认采集间隔已生效/);assert.match(h.root.textContent,/仅展示部分设备/);assert.doesNotMatch(h.root.textContent,/配置版本已确认应用/);
});
test('default tasks shows existing real receiver counts before a new flow and respects source range',async()=>{
  const receiver={id:'cloud-log-bridge',source:'cloud',label:'云端日志采集桥',state:'applied',sourceCounts:{journald:8,docker:1,file:1},counts:{sent:123,pending:4,dropped:2,flushFailures:1},config:{pollMs:5000,flushMs:3000,batch:100,queueLimit:5000},fields:[{key:'pollMs',label:'轮询',type:'number'}]};const h=setup({receivers:[receiver,{id:'device-heartbeat',source:'edge',label:'实际设备接收',state:'configured',detail:'2 台已登记设备'}]});await h.workspace.show('tasks');assert.ok(h.root.textContent.indexOf('现有采集任务与接收')<h.root.textContent.indexOf('还没有流程'));assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.match(h.root.textContent,/journald 8 · Docker 1 · 文件 1/);assert.match(h.root.textContent,/123/);assert.match(h.root.textContent,/轮询 5000 ms/);await input(h.root,'sourceFilter','cloud');assert.doesNotMatch(h.root.textContent,/实际设备接收/);assert.equal(byText(h.root,'配置采集参数').disabled,false);
});
test('passive catalog modules route to existing receiver configuration rather than an unsupported executable pipeline',async()=>{
  const h=setup({passive:true});await h.workspace.show('modules');await byText(h.root,'查看来源与接入配置').fire('click');assert.deepEqual(h.navigations,['collection/sources']);await h.workspace.show('tasks');await byText(h.root,'新流程').fire('click');assert.deepEqual(control(h.root,'moduleId').children.map(option=>option.value),['']);assert.equal(byText(h.root,'保存流程版本').disabled,true);assert.equal(h.requests.filter(request=>request.options.method).length,0);
});
test('pending receiver configuration polls real catalog until applied and polling stops when hidden',async()=>{
  const receiver={id:'cloud-log-bridge',source:'cloud',label:'云端日志桥',state:'pending',desiredVersion:3,appliedVersion:2};const h=setup({receivers:[receiver]});await h.workspace.show('sources');assert.equal([...h.timers.values()].filter(timer=>timer.delay===4000).length,1);receiver.appliedVersion=3;receiver.state='applied';await h.poll();assert.match(h.root.textContent,/配置版本已确认应用/);assert.equal([...h.timers.values()].filter(timer=>timer.delay===4000).length,0);receiver.appliedVersion=2;await h.workspace.show('sources');h.workspace.hide();assert.equal([...h.timers.values()].filter(timer=>timer.delay===4000).length,0);
});
test('read-only catalog preserves real data and disables configuration mutations',async()=>{
  const h=setup({readOnly:true,receivers:[{id:'cloud-log-bridge',label:'云端日志桥',source:'cloud',state:'applied',fields:[{key:'pollMs',label:'轮询',type:'number'}]}]});await h.workspace.show('tasks');assert.equal(byText(h.root,'新流程').disabled,true);assert.equal(byText(h.root,'配置采集参数').disabled,true);assert.equal(h.requests.filter(request=>request.options.method).length,0);assert.equal(h.outside.disabled,false);
});
test('stale matching versions cannot claim current application and desired versus applied parameters remain distinct',async()=>{
  const h=setup({receivers:[{id:'cloud-log-bridge',source:'cloud',label:'云日志桥',state:'unavailable',desiredVersion:'version-1',appliedVersion:'version-1',desiredConfig:{pollMs:4000,flushMs:5000,batch:64,queueLimit:2000},appliedConfig:{pollMs:3000,flushMs:5000,batch:64,queueLimit:2000}}]});await h.workspace.show('tasks');assert.match(h.root.textContent,/期望参数：轮询 4000 ms/);assert.match(h.root.textContent,/上次回执应用参数：轮询 3000 ms/);assert.match(h.root.textContent,/不能确认新版本已生效/);await h.workspace.show('sources');assert.doesNotMatch(h.root.textContent,/配置版本已确认应用/);assert.match(h.root.textContent,/上次回执应用参数/);
});
test('both shipped constructors use the shared identity helper on a baseline without incidentCenterContext',()=>{
  const document=new Document('<body>'+COLLECTION_WORKSPACE_HTML+DATA_CENTER_WORKSPACE_HTML+'<script>');const context=vm.createContext({document,$:(id:string)=>document.getElementById(id),base:'/dobs',apiHeaders:()=>({'x-admin-token':'synthetic-identity'}),obsAuthState:{me:{user:{id:'actor-1'},admin:true}},obsActiveTenant:()=>'',applyAuthMode(){return true;},obsLogout:async()=>{},setView(){},state:{view:'overview'},AbortController,setTimeout:()=>0,clearTimeout(){}});assert.match(COLLECTION_WORKSPACE_SCRIPT,/identity:collectionShellContext/);assert.match(DATA_CENTER_WORKSPACE_SCRIPT,/identity:collectionShellContext/);assert.doesNotMatch(COLLECTION_WORKSPACE_SCRIPT+DATA_CENTER_WORKSPACE_SCRIPT,/identity:incidentCenterContext/);vm.runInContext(COLLECTION_WORKSPACE_SCRIPT+'\n'+DATA_CENTER_WORKSPACE_SCRIPT+'\n'+COLLECTION_SHELL_IDENTITY_SCRIPT,context);assert.equal(vm.runInContext('typeof incidentCenterContext',context),'undefined');assert.equal(vm.runInContext('typeof collectionWorkspace.show + ":" + typeof dataCenterWorkspace.show',context),'function:function');assert.equal(JSON.parse(vm.runInContext('collectionShellContext()',context))[0],'actor-1');
});
test('continuous receivers refresh actual counts every fifteen seconds and expose manual global refresh',async()=>{
  const receiver={id:'cloud-log-bridge',source:'cloud',label:'真实云日志桥',state:'applied',counts:{sent:100,pending:0,dropped:0,flushFailures:0}};const h=setup({receivers:[receiver]});await h.workspace.show('tasks');receiver.counts.sent=101;await h.poll(15000);assert.equal(h.requests.length,6);assert.match(h.root.textContent,/101/);assert.equal(h.requests.some(request=>request.options.method),false);await h.workspace.refresh();assert.equal(h.requests.length,9);assert.equal([...h.timers.values()].filter(timer=>timer.delay===15000).length,1);
});
test('automatic refresh skips focused pipeline fields and open dialogs without rebuilding or losing draft values',async()=>{
  const receiver={id:'cloud-log-bridge',source:'cloud',label:'真实云日志桥',state:'applied',config:{pollMs:5000},fields:[{key:'pollMs',label:'轮询间隔',type:'number'}]};const h=setup({receivers:[receiver]});await h.workspace.show('tasks');await byText(h.root,'新流程').fire('click');await input(h.root,'name','保留未保存草稿');const name=control(h.root,'name');name.focus();await h.poll(15000);assert.equal(h.requests.length,3);assert.equal(control(h.root,'name'),name);assert.equal(h.document.activeElement,name);assert.equal(name.value,'保留未保存草稿');h.outside.focus();await byText(h.root,'配置采集参数').fire('click');const field=control(h.q('dialogFields'),'pollMs');field.value='6000';await h.poll(15000);assert.equal(h.requests.length,3);assert.equal(h.q('dialog').open,true);assert.equal(control(h.q('dialogFields'),'pollMs'),field);assert.equal(field.value,'6000');await h.q('close').fire('click');h.outside.focus();await h.poll(15000);assert.equal(h.requests.length,6);assert.equal(control(h.root,'name').value,'保留未保存草稿');
});
test('automatic refresh skips busy reads and stops when hidden or permission expires',async()=>{
  const h=setup({receivers:[{id:'otlp',source:'cloud',label:'真实遥测接收',state:'configured'}]});await h.workspace.show('sources');h.setDeferredBody('/catalog');const pending=h.workspace.refresh();await settle();await h.poll(15000);assert.equal(h.requests.length,6);h.releaseBody();await pending;h.setDeferredBody();h.workspace.hide();assert.equal([...h.timers.values()].filter(timer=>timer.delay===15000||timer.delay===4000).length,0);const count=h.requests.length;await h.workspace.show('sources');assert.equal(h.requests.length,count);h.setUnauthorized(true);await h.poll(15000);assert.match(h.root.textContent,/请先登录可观测中心/);assert.equal([...h.timers.values()].filter(timer=>timer.delay===15000||timer.delay===4000).length,0);assert.equal(h.requests.some(request=>request.options.method),false);
});
test('idle external reset clears scheduled polling and an already queued callback cannot issue extra reads',async()=>{
  const h=setup({receivers:[{id:'otlp',source:'cloud',label:'真实遥测接收',state:'configured'}]});await h.workspace.show('sources');const queued=[...h.timers.values()].find(timer=>timer.delay===15000);assert.ok(queued);const count=h.requests.length;h.workspace.reset();assert.equal([...h.timers.values()].filter(timer=>timer.delay===15000||timer.delay===4000).length,0);await queued.fn();await settle();assert.equal(h.requests.length,count);assert.match(h.root.textContent,/请刷新后重新读取/);await h.workspace.show('sources');assert.equal(h.requests.length,count+3);assert.equal([...h.timers.values()].filter(timer=>timer.delay===15000).length,1);
});
test('empty tasks opens the four-step editor only on request and same-route show keeps draft nodes and selection',async()=>{
  const h=setup();await h.workspace.show('tasks');assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.doesNotMatch(visibleText(h.root),/流程名称|最小有效字节数/);await byText(h.root,'新流程').fire('click');assert.equal(h.root.querySelectorAll('.cw-node').length,4);await input(h.root,'name','未保存的现场流程');const name=control(h.root,'name');name.focus();name.setSelectionRange(2,6,'backward');await h.workspace.show('tasks');assert.equal(h.requests.length,3);assert.equal(control(h.root,'name'),name);assert.equal(h.document.activeElement,name);assert.deepEqual([name.selectionStart,name.selectionEnd,name.selectionDirection],[2,6,'backward']);await byText(h.root,'收起编辑器').fire('click');assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.equal(h.requests.some(request=>request.options.method),false);
});
test('receiver cards keep anomalies visible while parameters and technical reasons are progressively disclosed',async()=>{
  const receiver={id:'cloud-log-bridge',label:'云端日志桥',source:'cloud',state:'unavailable',reason:'daemon_status_stale',updatedAt:'2026-10-13T08:30:00Z',desiredVersion:'desired-long-version',appliedVersion:'previous-long-version',desiredConfig:{pollMs:5000,flushMs:3000,batch:100,queueLimit:2000},appliedConfig:{pollMs:4000},counts:{sent:200,pending:null,dropped:5,flushFailures:3},errors:{configuration:1,receipt:null},fields:[{key:'pollMs',label:'轮询间隔',type:'number'}]};const h=setup({receivers:[receiver,{id:'device-heartbeat',label:'设备接收',source:'mixed',state:'unknown',commands:[{deviceId:'board-1',status:'pending'}]}]});await h.workspace.show('tasks');const visible=visibleText(h.root);assert.match(visible,/最近回执过期.*当前状态待确认/);assert.match(visible,/最近回执：2026-10-13/);assert.match(visible,/排队中.*待确认/);assert.match(visible,/丢弃.*5.*发送失败.*3/);assert.match(visible,/配置错误 1/);assert.match(visible,/接收回执错误计数待确认/);assert.match(visible,/1 条设备配置等待回执/);assert.doesNotMatch(visible,/desired-long-version|daemon_status_stale|期望参数|轮询 5000 ms/);assert.equal(byText(h.root,'配置采集参数').disabled,false);const detail=disclosure(h.root,'receiver:cloud-log-bridge');await detail.querySelector('summary')!.fire('click');assert.equal(detail.open,true);assert.match(visibleText(h.root),/期望参数.*desired-long-version|desired-long-version/);assert.match(visibleText(h.root),/上次回执应用参数/);await input(h.root,'sourceFilter','cloud');assert.match(visibleText(h.root),/设备接收/);assert.equal(disclosure(h.root,'receiver:cloud-log-bridge').open,true);
});
test('manual refresh preserves receiver disclosure, unsaved fields and caret without stealing moved focus',async()=>{
  const receiver={id:'cloud-log-bridge',label:'日志桥',source:'cloud',state:'applied',desiredVersion:1,appliedVersion:1,counts:{sent:20,pending:0,dropped:0,flushFailures:0}};const h=setup({receivers:[receiver]});await h.workspace.show('tasks');await disclosure(h.root,'receiver:cloud-log-bridge').querySelector('summary')!.fire('click');await byText(h.root,'新流程').fire('click');await input(h.root,'name','保留草稿与选区');const original=control(h.root,'name');original.focus();original.setSelectionRange(1,5,'forward');receiver.counts.sent=21;await h.workspace.refresh();const refreshed=control(h.root,'name');assert.notEqual(refreshed,original);assert.equal(refreshed.value,'保留草稿与选区');assert.equal(h.document.activeElement,refreshed);assert.deepEqual([refreshed.selectionStart,refreshed.selectionEnd,refreshed.selectionDirection],[1,5,'forward']);assert.equal(disclosure(h.root,'receiver:cloud-log-bridge').open,true);assert.match(visibleText(h.root),/21/);h.setDeferredBody('/catalog');const pending=h.workspace.refresh();await settle();h.outside.focus();h.releaseBody();await pending;assert.equal(h.document.activeElement,h.outside);assert.equal(control(h.root,'name').value,'保留草稿与选区');
});
test('module, target, flow and scope changes restore stable keyboard controls while preserving the draft',async()=>{
  const h=setup();await h.workspace.show('tasks');await byText(h.root,'新流程').fire('click');await input(h.root,'name','键盘操作草稿');let focused=control(h.root,'moduleId');focused.focus();await input(h.root,'moduleId','ssh-logs');assert.equal(h.document.activeElement,control(h.root,'moduleId'));focused=control(h.root,'targetId');focused.focus();await input(h.root,'targetId','board-1');assert.equal(h.document.activeElement,control(h.root,'targetId'));const filter=h.root.querySelectorAll('.cw-node')[1];filter.focus();await filter.fire('click');assert.equal(h.document.activeElement,h.root.querySelectorAll('.cw-node')[1]);await input(h.root,'keywords','ERROR');const scope=control(h.root,'sourceFilter');scope.focus();await input(h.root,'sourceFilter','cloud');assert.equal(h.document.activeElement,control(h.root,'sourceFilter'));assert.equal(control(h.root,'name').value,'键盘操作草稿');assert.equal(control(h.root,'keywords').value,'ERROR');assert.match(visibleText(h.root),/当前编辑终端流程，草稿已保留/);assert.equal(h.requests.some(request=>request.options.method),false);
});
test('identity reset clears editor and disclosures and a delayed old response cannot restore them',async()=>{
  const h=setup({receivers:[{id:'cloud-log-bridge',source:'cloud',label:'私有采集桥',state:'applied'}]});await h.workspace.show('tasks');await disclosure(h.root,'receiver:cloud-log-bridge').querySelector('summary')!.fire('click');await byText(h.root,'新流程').fire('click');await input(h.root,'name','上个账号私有草稿');control(h.root,'name').focus();h.setDeferredBody('/catalog');const pending=h.workspace.refresh();await settle();h.setIdentity('account-2');h.releaseBody();await pending;assert.doesNotMatch(h.root.textContent,/上个账号私有草稿|私有采集桥/);assert.equal(h.root.querySelectorAll('.cw-node').length,0);h.setDeferredBody();await h.workspace.show('tasks');assert.equal(disclosure(h.root,'receiver:cloud-log-bridge').open,false);assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.doesNotMatch(h.root.textContent,/上个账号私有草稿/);
});
test('sources omit unsupported version facts and nonexistent configuration instead of filling empty rows',async()=>{
  const h=setup({receivers:[{id:'otlp',label:'遥测接收',source:'cloud',state:'unknown',detail:'等待真实接收',links:[{label:'配置接入凭据',view:'signals/tokens'}]}]});await h.workspace.show('sources');assert.match(visibleText(h.root),/最近接收：待确认/);assert.doesNotMatch(h.root.textContent,/期望参数|实际应用参数|期望版本|应用版本|当前配置|未记录/);await byText(h.root,'配置接入凭据').fire('click');assert.deepEqual(h.navigations,['signals/tokens']);assert.equal(h.requests.some(request=>request.options.method),false);
});
test('collapsed editor can resume every unsaved parameter and selected immutable version',async()=>{
  const h=setup();await configure(h);await input(h.root,'lines','333');await h.root.querySelector('form')!.fire('submit');await input(h.root,'lines','444');await h.root.querySelector('form')!.fire('submit');await input(h.root,'version','1');await input(h.root,'name','版本一未保存草稿');await input(h.root,'lines','555');await h.root.querySelectorAll('.cw-node')[1].fire('click');await input(h.root,'keywords','保留关键词');byText(h.root,'收起编辑器').focus();await byText(h.root,'收起编辑器').fire('click');assert.equal(h.root.querySelectorAll('.cw-node').length,0);assert.equal(h.document.activeElement,byText(h.root,'继续编辑草稿'));await h.workspace.refresh();assert.equal(h.document.activeElement,byText(h.root,'继续编辑草稿'));await byText(h.root,'继续编辑草稿').fire('click');assert.equal(h.document.activeElement,byText(h.root,'收起编辑器'));assert.equal(control(h.root,'name').value,'版本一未保存草稿');assert.equal(control(h.root,'version').value,'1');assert.equal(control(h.root,'keywords').value,'保留关键词');await h.root.querySelectorAll('.cw-node')[0].fire('click');assert.equal(control(h.root,'lines').value,'555');h.workspace.reset();await h.workspace.show('tasks');assert.doesNotMatch(h.root.textContent,/继续编辑草稿|版本一未保存草稿/);
});
test('refresh restores the second row action by entity identity rather than its repeated label',async()=>{
  const h=setup({runs:[{id:'run-a',moduleId:'ssh-logs',state:'completed',archiveState:'completed',nodeStates:[],assetIds:[]},{id:'run-b',moduleId:'ssh-logs',state:'completed',archiveState:'completed',nodeStates:[],assetIds:[]}]});await h.workspace.show('runs');const actions=h.root.querySelectorAll('button').filter(node=>node.textContent==='查看运行步骤');assert.equal(actions.length,2);actions[1].focus();await h.workspace.refresh();const restored=h.root.querySelectorAll('button').filter(node=>node.textContent==='查看运行步骤');assert.equal(h.document.activeElement,restored[1]);assert.notEqual(h.document.activeElement,restored[0]);assert.equal(restored[1].dataset.cwKey,'button:run:run-b:查看运行步骤');
});
test('a run without filtering renders only actual receipt steps and cannot borrow another workflow draft',async()=>{
  const h=setup({runs:[{id:'run-a',moduleId:'ssh-logs',state:'completed',archiveState:'completed',assetIds:[],nodeStates:[{id:'source',state:'completed',byteCount:100},{id:'quality',state:'completed',byteCount:100},{id:'archive',state:'completed',byteCount:100}]}]});await configure(h);await h.root.querySelectorAll('.cw-node')[1].fire('click');await input(h.root,'keywords','OTHER DRAFT');await h.workspace.show('runs');await byText(h.root,'查看运行步骤').fire('click');const nodes=h.root.querySelectorAll('.cw-node');assert.equal(nodes.length,3);assert.deepEqual(nodes.map(node=>node.dataset.cwKey),['node:source','node:quality','node:archive']);assert.ok(nodes.every(node=>node.dataset.state==='completed'));assert.doesNotMatch(visibleText(h.root),/OTHER DRAFT|仅保留关键词|等待中/);assert.equal(h.requests.some(request=>request.options.method),false);
});
