import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderEdgeLlmPage, EDGE_LLM_PAGE_SCRIPT } from './edge-llm-page.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

class Node {
  children: Node[] = []; listeners = new Map<string, () => unknown>(); attributes = new Map<string, string>();
  className = ''; text = ''; disabled = false; parent?: Node; href = ''; download = ''; private selected = '';
  constructor(public tag: string) {}
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML must not be rendered'); }
  get value() { return this.selected || (this.tag === 'select' ? this.children[0]?.value : '') || ''; }
  set value(value: string) { this.selected = value; }
  appendChild(node: Node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren() { this.children = []; this.text = ''; this.selected = ''; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(name: string, callback: () => unknown) { this.listeners.set(name, callback); }
  async dispatch(name = 'click') { return this.listeners.get(name)?.(); }
  click() {} remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
}
const catalog = { board: 'X5', backend: 'cpu', models: [{ id: 'qwen-small', label: '<img src=x onerror=attack()>', quantization: 'Q4_K_M' }], runtime: { available: true }, deployment: { ready: false } };
const job = { id: 'a1802f68-6ad1-48b5-8307-ad95d736af62', targetId: 'x5', inputs: { modelId: 'qwen-small' }, operation: 'deploy', status: 'submitting', createdAt: '2026-10-13T00:00:00.000Z' };
type Call = { path: string; options: { method?: string; body?: string; headers: Record<string, string> } };
async function harness(options: { targets?: boolean; readOnly?: boolean; ready?: boolean; targetResponse?: () => Promise<unknown> } = {}) {
  const nodes = new Map<string, Node>();
  for (const id of ['consoleLink','notice','target','model','targetFacts','probe','deploy','benchmark','stop','refresh','jobs','receipt','query','report']) nodes.set(id,new Node(['target','model'].includes(id)?'select':'div'));
  const storage = new Map([['d_obs_admin_token','fixture-admin']]); const calls: Call[] = [];
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, () => void>(); let timerId = 0; let remoteJob = { ...job };
  const context = vm.createContext({
    document: { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Node(tag), body: new Node('body') },
    location: { pathname: '/dobs/ops-observability/edge-llm' }, window: { addEventListener: (name: string, callback: () => void) => listeners.set(name,callback) },
    sessionStorage: { getItem: (key: string) => storage.get(key) || null }, localStorage: { getItem: () => null },
    setTimeout: (fn: () => void) => { timers.set(++timerId,fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id), AbortController, URL, Blob,
    fetch: async (url: string, init: Call['options']) => {
      const path = url.replace('/dobs/api/ops/observability/edge-llm',''); calls.push({ path,options:init });
      let body: unknown;
      if (path === '/capabilities') body = { ok: true, readOnly: options.readOnly, targets: options.targets === false ? [] : [{ id:'x5',label:'X5',board:'X5' }] };
      else if(path === '/targets/x5') body = options.targetResponse ? await options.targetResponse() : { ok:true,target:{board:'X5'},catalog: options.ready ? { ...catalog, deployment: { ready:true, modelId:'qwen-small' } } : catalog };
      else if(path === '/jobs' && init.method === 'POST') body = { ok:true,job:remoteJob };
      else if(path === '/jobs') body = { ok:true,jobs:calls.some(c=>c.options.method==='POST')?[remoteJob]:[] };
      else body = { ok:true,job:remoteJob };
      return { ok:true,status:200,json:async()=>body };
    },
  });
  vm.runInContext(EDGE_LLM_PAGE_SCRIPT,context);
  const flush = async () => { for(let i=0;i<50;i++)await Promise.resolve(); };
  await flush();
  return { nodes,calls,storage,listeners,timers,flush,setJob:(status:string)=>{remoteJob={...job,status};}, node:(id:string)=>nodes.get(id)! };
}

test('unconfigured devices cannot submit and production navigation preserves proxy prefix', async () => {
  const h=await harness({targets:false});
  assert.match(h.node('notice').textContent,/尚未接入/);
  assert.equal(h.node('deploy').disabled,true);
  await h.node('deploy').dispatch();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
  assert.equal(h.node('consoleLink').href,'/dobs/ops-observability');
  assert.match(renderEdgeLlmPage(),/准确率需另设数据集验收/);
  const onclick = OPS_OBSERVABILITY_HTML.match(/id="edgeLlmWorkspaceLink"[^>]*onclick="([^"]+)"/)![1];
  for(const pathname of ['/ops-observability','/dobs/ops-observability/']) {
    const anchor={href:''};vm.runInNewContext('(function(){'+onclick+'}).call(anchor)',{location:{pathname},anchor});
    assert.equal(anchor.href,pathname.replace(/\/$/,'')+'/edge-llm');
  }
});

test('submission stays pending; unknown jobs remain queryable without resubmitting; model labels are text', async () => {
  const h=await harness();assert.equal(h.node('deploy').disabled,false);
  assert.match(h.node('model').textContent,/<img/);
  await h.node('deploy').dispatch();await h.flush();
  const post=h.calls.find(c=>c.options.method==='POST')!;
  assert.equal(post.options.headers['X-RDK-Ops-Action'],'observability');
  assert.deepEqual(JSON.parse(post.options.body!),{targetId:'x5',operation:'deploy',modelId:'qwen-small'});
  assert.match(h.node('receipt').textContent,/提交中/);
  assert.equal(h.node('benchmark').disabled,true);
  h.setJob('unknown');await h.node('query').dispatch();await h.flush();
  assert.match(h.node('receipt').textContent,/不要再次提交/);
  assert.equal(h.node('deploy').disabled,true);
  await h.node('deploy').dispatch();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});

test('read-only mode disables execution and late response after identity switch clears private state', async () => {
  const view=await harness({readOnly:true});assert.equal(view.node('deploy').disabled,true);
  let release!: (data: unknown) => void;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=await harness({targetResponse:()=>pending});
  h.storage.set('d_obs_admin_token','other-admin');
  release({ok:true,target:{board:'X5'},catalog});await h.flush();
  assert.equal(h.node('model').children.length,0);
  assert.equal(h.node('target').children.length,0);
  assert.match(h.node('notice').textContent,/身份已改变/);
  assert.equal(h.node('deploy').disabled,true);
});

test('a ready model requires stopping before another deployment while benchmark stays available', async () => {
  const h=await harness({ready:true});
  assert.equal(h.node('deploy').disabled,true);
  assert.equal(h.node('benchmark').disabled,false);
  assert.equal(h.node('stop').disabled,false);
  await h.node('deploy').dispatch();
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});
