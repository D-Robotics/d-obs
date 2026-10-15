import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { RSI_LEARNING_SCRIPT } from './rsi-learning-page.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

class Element {
  children: Element[] = []; parent: Element | null = null;
  attributes: Record<string,string> = {}; listeners: Record<string,Function> = {};
  textContent = ''; className = ''; disabled = false; value = '';
  classList = { add: (v:string) => { this.className += ' '+v; } };
  constructor(public tag: string) {}
  appendChild(node: Element) { this.children.push(node); node.parent=this; return node; }
  insertBefore(node: Element, before: Element | null) { const index=before?this.children.indexOf(before):-1;node.parent=this;if(index<0)this.children.push(node);else this.children.splice(index,0,node);return node; }
  setAttribute(key:string,value:string) { this.attributes[key]=value; }
  addEventListener(key:string,fn:Function) { this.listeners[key]=fn; }
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this); }
  querySelector(selector:string): Element | null { return all(this).find(node=>selector==='[data-rsi-learning]'&&node.attributes['data-rsi-learning']!==undefined)??null; }
}
const all=(node:Element):Element[]=>[node,...node.children.flatMap(all)];
const text=(node:Element)=>all(node).map(n=>n.textContent).join(' ');
function setup() {
  const root=new Element('div');const calls:Array<{path:string,options?:any}>=[];
  let serve:(path:string,options?:any)=>Promise<any>=async()=>({ok:true,overview:{loops:[]}});
  const context=vm.createContext({
    apiHeaders:()=>({}),obsAuthState:{me:{user:{id:'alice'},admin:true}},state:{view:'evolution'},
    $:()=>root,make:(tag:string,cls='')=>{const node=new Element(tag);node.className=cls;return node;},
    add:(parent:Element,tag:string,cls:string,value='')=>{const node=new Element(tag);node.className=cls;node.textContent=value;parent.appendChild(node);return node;},
    section:()=>new Element('section'),learningPercent:(v:number|null)=>v===null?'—':(v*100).toFixed(1)+'%',
    renderLearningModules(){},setView(){},loadAll:async()=>{},applyAuthMode:(me:any)=>{context.obsAuthState.me=me;},
    request:async(path:string,options?:any)=>{calls.push({path,options});if(path.endsWith('/evidence'))return {overview:{revision:1,records:[],counts:{}}};return serve(path,options);},URLSearchParams,
  });
  vm.runInContext(RSI_LEARNING_SCRIPT+';globalThis.rsi={state:rsiState,load:rsiLoad,render:rsiRender,mutate:rsiMutate};',context);
  return {root,calls,context,rsi:context.rsi,serve:(fn:typeof serve)=>{serve=fn;}};
}

test('page integrates the experimental workspace and the complete assembled script parses',()=>{
  const html=OPS_OBSERVABILITY_HTML;
  assert.match(html,/可验证进化实验/);
  for(const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('empty reads never create demo data and failures are distinct from empty evidence',async()=>{
  const h=setup();await h.rsi.load(true);
  assert.deepEqual(h.calls.map(c=>c.path).sort(),['/api/ops/observability/evolution/learning/evidence','/api/ops/observability/evolution/learning/loops']);
  assert.match(text(h.root),/还没有进化实验/);
  h.serve(async()=>{throw new Error('rsi_ledger_corrupt');});await h.rsi.load(true);
  assert.match(text(h.root),/读取失败/);assert.doesNotMatch(text(h.root),/还没有进化实验/);
});
test('a delayed response from the previous cookie identity cannot populate the next account',async()=>{
  const h=setup();let release:(value:any)=>void=()=>{};
  h.serve(()=>new Promise(resolve=>{release=resolve;}));
  const pending=h.rsi.load(true);
  h.context.applyAuthMode({user:{id:'bob'},admin:true});
  release({overview:{loops:[{id:'alice-loop',title:'Alice private case'}]}});await pending;
  assert.equal(h.rsi.state.overview,null);assert.equal(h.rsi.state.loop,null);
  assert.doesNotMatch(text(h.root),/Alice private case/);
});
test('read-only access disables mutations while keeping refresh available',async()=>{
  const h=setup();h.serve(async()=>({overview:{loops:[]},readOnly:true}));await h.rsi.load(true);
  const demo=all(h.root).find(n=>n.textContent==='创建合成示例')!;
  const refresh=all(h.root).find(n=>n.textContent==='刷新')!;
  assert.equal(demo.disabled,true);assert.equal(refresh.disabled,false);
  await h.rsi.mutate('/demo',{});assert.equal(h.calls.filter(c=>c.options?.method==='POST').length,0);
});
test('a candidate cannot be accepted before a passing replay for its own version',()=>{
  const h=setup();h.rsi.render();h.rsi.state.overview={loops:[{id:'loop',title:'Test'}]};
  h.rsi.state.loop={id:'loop',title:'Test',revision:2,cases:[],activeVersionId:'v0',candidateVersionId:'v2',initialVersionId:'v0',versions:[{id:'v0',parentVersionId:null,rules:[]},{id:'v2',parentVersionId:'v0',loadedVersionId:'v0',rules:[]}],replays:[{candidateVersionId:'v1',report:{gate:{passed:true}}}],decisions:[]};
  h.rsi.render();assert.equal(all(h.root).find(n=>n.textContent==='3. 接受改进')!.disabled,true);
});
test('refresh retains the current identity import draft and a new identity clears it',()=>{
  const h=setup();h.rsi.render();
  h.rsi.state.overview={loops:[]};
  h.rsi.state.importTitle='Confirmed timeout cases';h.rsi.state.importCases='[{"id":"draft-case"}]';h.rsi.state.importOpen=true;
  h.context.renderLearningModules();
  assert.equal(all(h.root).find(n=>n.attributes['aria-label']==='实验名称')!.value,'Confirmed timeout cases');
  assert.equal(all(h.root).find(n=>n.attributes['aria-label']==='案例 JSON 数组')!.value,'[{"id":"draft-case"}]');
  h.context.applyAuthMode({user:{id:'bob'},admin:true});
  assert.equal(h.rsi.state.importTitle,'');assert.equal(h.rsi.state.importCases,'');
});
test('a pending detail read locks selection so action targets cannot diverge from the selected experiment',async()=>{
  const h=setup();h.rsi.render();h.rsi.state.selectedId='a';h.rsi.state.overview={loops:[{id:'a',title:'A'},{id:'b',title:'B'}]};
  let release:(value:any)=>void=()=>{};h.serve(async path=>path.endsWith('/loops')?{overview:h.rsi.state.overview}:new Promise(resolve=>{release=resolve;}));
  const pending=h.rsi.load(true);await new Promise(resolve=>setImmediate(resolve));
  const selector=all(h.root).find(n=>n.attributes['aria-label']==='选择进化实验')!;
  assert.equal(selector.disabled,true);selector.value='b';selector.listeners.change();assert.equal(h.rsi.state.selectedId,'a');
  release({loop:{id:'a',title:'A',revision:1,activeVersionId:'v0',candidateVersionId:null,cases:[],initialVersionId:'v0',versions:[],replays:[],decisions:[]}});await pending;
  assert.equal(h.rsi.state.loop.id,h.rsi.state.selectedId);
});
