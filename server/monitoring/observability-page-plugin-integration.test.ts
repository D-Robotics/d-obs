/** Plugin integration uses production routing and nodes parsed from the final HTML shell.
 * Missing elements stay missing: unlike the interaction renderer harness, this
 * model cannot silently invent an element that the page no longer contains.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { integrateCollectionScriptA } from './observability-page-collection-integration.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_FOCUS } from './observability-page-focus.js';
import { OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';

import { PLUGIN_CENTER_HTML, PLUGIN_CENTER_STYLE, PLUGIN_CENTER_SCRIPT } from './observability-page-plugins.js';
import { PLUGIN_CENTER_SHELL_SCRIPT } from './observability-page-plugin-shell.js';

type DomEvent = { target: ShellNode; key?: string; preventDefault(): void; stopPropagation(): void };
class ShellNode {
  children: ShellNode[] = [];
  parentElement: ShellNode | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = new Proxy({}, { set: (target: Record<string,string>, key: string, value: string) => { target[key]=String(value); this.attributes.set('data-'+key.replace(/[A-Z]/g,char=>'-'+char.toLowerCase()),String(value)); return true; } });
  style: Record<string, unknown> = {};
  listeners = new Map<string, Array<(event: DomEvent) => unknown>>();
  hidden = false; disabled = false; open = false; selected = false; focused = false; value = ''; type = ''; title = ''; id = '';
  private text = '';
  private classes = new Set<string>();
  constructor(readonly tagName: string) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  classList = {
    contains: (value: string) => this.classes.has(value),
    add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
    remove: (...values: string[]) => values.forEach(value => this.classes.delete(value)),
    toggle: (value: string, force?: boolean) => { const active = force ?? !this.classes.has(value); if (active) this.classes.add(value); else this.classes.delete(value); return active; },
  };
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.replaceChildren(); }
  appendText(value: string) { this.text += value; }
  set innerHTML(_value: string) { throw new Error('navigation must not write HTML from dynamic values'); }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentNode() { return this.parentElement; }
  appendChild(node: ShellNode) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceChildren(...nodes: ShellNode[]) { [...this.children].forEach(node => node.remove()); nodes.forEach(node => this.appendChild(node)); }
  setAttribute(key: string, value: unknown) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'hidden') this.hidden = true;
    if (key === 'open') this.open = true;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = String(value);
  }
  getAttribute(key: string) { if (key === 'id') return this.id || null; if (key === 'class') return this.className || null; return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); if (key === 'hidden') this.hidden = false; }
  addEventListener(type: string, listener: (event: DomEvent) => unknown) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  async dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.focused = true; } scrollIntoView() {}
  contains(node: ShellNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string): boolean {
    const attrs = [...selector.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)];
    const plain = selector.replace(/\[[^\]]*\]/g, '');
    const id = plain.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    const tag = plain.match(/^[a-z][\w-]*/i)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
    if ([...plain.matchAll(/\.([\w-]+)/g)].some(match => !this.classes.has(match[1]))) return false;
    return attrs.every(([, key, op, expected]) => { const actual = this.getAttribute(key); return op === '=' ? actual === expected : op === '^=' ? actual?.startsWith(expected) : actual != null; });
  }
  closest(selector: string): ShellNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector: string): ShellNode[] {
    const parts = selector.trim().split(/\s+(?![^[]*\])/);
    const leaf = parts.pop()!;
    const descendants = (node: ShellNode): ShellNode[] => node.children.flatMap(child => [child, ...descendants(child)]);
    return descendants(this).filter(node => {
      if (!node.matches(leaf)) return false;
      let ancestor = node.parentElement;
      for (const part of [...parts].reverse()) { while (ancestor && !ancestor.matches(part)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
      return true;
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function parseShell() {
  const html = OPS_OBSERVABILITY_HTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = new ShellNode('ROOT'); const stack = [root];
  const voids = new Set(['INPUT', 'BR', 'HR', 'META', 'LINK', 'IMG', 'AREA', 'BASE', 'COL', 'EMBED', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  for (const token of html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>|([^<]+)/gi)) {
    if (token[3]) { stack.at(-1)!.appendText(token[3]); continue; }
    const tag = token[1].toUpperCase();
    if (token[0].startsWith('</')) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const node = new ShellNode(tag);
    for (const attribute of token[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    stack.at(-1)!.appendChild(node); if (!voids.has(tag) && !token[0].endsWith('/>')) stack.push(node);
  }
  return root;
}


type Call = { url: string; method: string; headers: Record<string,string>; signal?: AbortSignal };
function integration(options: { mode?: 'admin'|'member'|'tenant'|'unknown'; hash?: string } = {}) {
  const shell=parseShell(),body=shell.querySelector('body')!,html=shell.querySelector('html')!;
  const storage=new Map<string,string>(); const calls:Call[]=[]; const mode=options.mode||'admin';
  if(mode==='member'){storage.set('d_obs_sso_session','member-session');storage.set('d_obs_active_tenant','team-a')}
  if(mode==='tenant')storage.set('d_obs_tenant_token','tenant-token');
  const me=mode==='admin'?{user:{id:'admin-a'},admin:true}:mode==='member'?{user:{id:'member-a'},admin:false,tenants:[{tenantId:'team-a'}]}:null;
  const document={body,documentElement:html,title:'',addEventListener(){},createElement:(tag:string)=>new ShellNode(tag.toUpperCase()),createElementNS:(_ns:string,tag:string)=>new ShellNode(tag.toUpperCase()),createTextNode:(value:string)=>{const node=new ShellNode('TEXT');node.textContent=value;return node},getElementById:(id:string)=>shell.querySelector('#'+id),querySelector:(selector:string)=>shell.querySelector(selector),querySelectorAll:(selector:string)=>shell.querySelectorAll(selector)};
  const manifest={schemaVersion:1,id:'integration-plugin',version:'1.0.0',label:'集成诊断',description:'实际接口返回',tools:[],dataSources:[],panels:[],workflows:[],prompts:[]};
  const record={id:manifest.id,revision:1,enabled:false,draft:{manifest,config:{}},published:null,history:[]};
  const context=vm.createContext({document,window:{},location:{pathname:'/ops-observability',href:'http://localhost/ops-observability'+(options.hash||'#overview'),hash:options.hash||'#overview',reload(){}},history:{replaceState(){}},sessionStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},localStorage:{getItem:()=>null,setItem(){}},AbortController,URL,Blob,console,setTimeout:()=>0,clearTimeout(){},fetch:async(url:string,init?:{method?:string;headers?:Record<string,string>;signal?:AbortSignal})=>{calls.push({url,method:init?.method||'GET',headers:init?.headers||{},signal:init?.signal});const data=url.includes('/plugins/catalog')?{ok:true,plugins:[{id:manifest.id,label:manifest.label,revision:1,version:null,enabled:false,hasDraft:true,draftVersion:'1.0.0'}],templates:[]}:url.includes('/plugins/capabilities')?{ok:true,connectors:[]}:url.includes('/plugins/')?{ok:true,plugin:record}:{ok:true};return{ok:true,status:200,json:async()=>data}}});
  const dataStubs=['renderRules','renderChannels','renderSettings','renderEvolution','renderServiceLevels','bindTenantPanel','loadTenants','loadIncidentCenter','renderObjects','renderMetrics'];
  const script=OPS_OBSERVABILITY_SCRIPT_UI+'\n'+integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A)+'\n'+dataStubs.map(name=>'function '+name+'(){}').join('\n')+'\nfunction renderOverview(){}function renderActionLoopMount(){}async function loadAll(){}\n'+OPS_OBSERVABILITY_SCRIPT_HIERARCHY+'\n'+OPS_OBSERVABILITY_SCRIPT_FOCUS+'\nobsAuthState.me='+JSON.stringify(me)+';\n'+PLUGIN_CENTER_SCRIPT+'\n'+PLUGIN_CENTER_SHELL_SCRIPT+String.raw`
    globalThis.hooks={setView,state,pluginCenter,applyAuthMode,obsLogout,auth:me=>{obsAuthState.me=me;applyAuthMode(me)},boot:request=>{state.view=resolveViewRequest(request).name;setView(request,false)}};
  })();`;
  vm.runInContext(script,context);
  const hooks=context.hooks as Record<string,any>;
  const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve()};
  return{shell,body,storage,calls,hooks,context,flush,id:(id:string)=>document.getElementById(id)};
}

test('final page includes one plugin view and its exact executable fragments in the production order',()=>{
  assert.equal(OPS_OBSERVABILITY_HTML.split('id="view-plugins"').length-1,1);
  assert.ok(OPS_OBSERVABILITY_HTML.includes(PLUGIN_CENTER_HTML));assert.ok(OPS_OBSERVABILITY_HTML.includes(PLUGIN_CENTER_STYLE));
  const page=OPS_OBSERVABILITY_HTML;
  assert.ok(page.indexOf(PLUGIN_CENTER_SCRIPT)>page.indexOf(integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A)));
  assert.ok(page.indexOf(PLUGIN_CENTER_SHELL_SCRIPT)>page.indexOf(PLUGIN_CENTER_SCRIPT));
  assert.ok(page.indexOf(OPS_OBSERVABILITY_SCRIPT_C)>page.indexOf(PLUGIN_CENTER_SHELL_SCRIPT));
  for(const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(match[1]));
});

test('production setView opens the real plugin section with one low-frequency navigation entry and authenticated reads',async()=>{
  const h=integration();h.hooks.setView('plugins',false);await h.flush();
  assert.equal(h.hooks.state.view,'plugins');assert.equal(h.id('view-plugins')?.classList.contains('hidden'),false);
  const nav=h.id('pluginCenterNav')!;assert.equal(nav.closest('.nav-group')?.id,'nav-group-advanced');assert.equal(nav.getAttribute('aria-current'),'page');assert.equal(nav.getAttribute('aria-controls'),'view-plugins');
  assert.equal(h.shell.querySelectorAll('#pluginCenterNav').length,1);assert.equal(h.shell.querySelector('.nav-main')!.querySelectorAll('[data-view="plugins"]').length,0);
  assert.ok(h.calls.some(call=>call.url.endsWith('/plugins/catalog')));assert.ok(h.calls.every(call=>call.method==='GET'));assert.match(h.id('pluginCatalog')!.textContent,/集成诊断/);
  await h.hooks.pluginCenter.selectPlugin('integration-plugin');assert.match(h.id('pluginDetail')!.textContent,/保存草稿/);assert.equal(h.id('pageTitle')?.textContent,'插件与诊断');
});

test('member and tenant readonly routing hides plugin navigation and never calls the plugin API',async()=>{
  for(const mode of ['member','tenant'] as const){const h=integration({mode});h.hooks.setView('plugins',false);await h.flush();assert.equal(h.hooks.state.view,'overview');assert.equal(h.id('pluginCenterNav')?.hidden,true);assert.equal(h.id('view-plugins')?.classList.contains('hidden'),true);assert.equal(h.calls.filter(call=>call.url.includes('/plugins')).length,0)}
});

test('cookie-admin plugin deep link survives asynchronous identity resolution and does not query before authentication',async()=>{
  const h=integration({mode:'unknown',hash:'#plugins'});h.hooks.boot('plugins');await h.flush();assert.equal(h.calls.filter(call=>call.url.includes('/plugins')).length,0);
  h.hooks.auth({user:{id:'cookie-admin'},admin:true});await h.flush();assert.equal(h.hooks.state.view,'plugins');assert.equal(h.id('pluginCenterNav')?.hidden,false);assert.ok(h.calls.some(call=>call.url.endsWith('/plugins/catalog')));
});

test('auth role change clears the plugin editor and read cache before returning to the readonly view',async()=>{
  const h=integration();h.hooks.setView('plugins',false);await h.flush();await h.hooks.pluginCenter.selectPlugin('integration-plugin');h.storage.set('d_obs_active_tenant','team-a');
  h.hooks.auth({user:{id:'member-b'},admin:false,tenants:[{tenantId:'team-a'}]});await h.flush();assert.equal(h.id('pluginCenterNav')?.hidden,true);assert.equal(h.hooks.state.view,'overview');assert.equal(h.hooks.pluginCenter.state.editors.size,0);assert.equal(h.hooks.pluginCenter.state.plugins.length,0);assert.doesNotMatch(h.id('pluginDetail')!.textContent,/集成诊断/);
});
