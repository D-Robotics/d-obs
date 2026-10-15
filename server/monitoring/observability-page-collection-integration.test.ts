import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {integrateCollectionScriptA,integrateCollectionNavScript,COLLECTION_SHELL_IDENTITY_SCRIPT} from './observability-page-collection-integration.js';
import {OPS_OBSERVABILITY_SCRIPT_A} from './observability-page-script-a.js';
import {OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT} from './observability-page-simple-nav.js';
import {renderDataCenterCompatibilityPage} from './data-center-compatibility-page.js';
test('unified shell preserves legacy routes and correctly resolves modular workspace deep links',()=>{
 const result=integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A);
 const lines=result.split('\n').filter(l=>['const viewNames =','const viewAliases =','const viewModuleChildren =','function resolveViewRequest(','const moduleNavKey ='].some(k=>l.includes(k))).join('\n');
 const ctx=vm.createContext({});vm.runInContext(lines+';globalThis.resolve=resolveViewRequest',ctx);
 for(const route of ['collection/tasks','collection/sources','collection/modules','collection/runs','data/assets','data/datasets','data/loops','data/tasks'])assert.equal(ctx.resolve(route).source,route);
 assert.equal(ctx.resolve('session-traces').source,'traces/session');assert.equal(ctx.resolve('rules').source,'alerts/rules');
 assert.match(result,/!\['devices','collection','data'\]\.includes\(name\)/);assert.match(integrateCollectionNavScript(OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT),/primaryRoutes=\['overview','collection\/tasks','data\/assets'/);
 assert.throws(()=>integrateCollectionScriptA('unknown source'),/baseline_mismatch/);
});
test('legacy standalone data links migrate fragments and consume tokens without leaking them into new URLs',()=>{
 const html=renderDataCenterCompatibilityPage();const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];new vm.Script(script);
 let replaced='';const link={href:''};const values=new Map<string,string>();
 vm.runInNewContext(script,{location:{pathname:'/dobs/ops-observability/data-center',hash:'#loops',origin:'https://example.invalid',href:'https://example.invalid/dobs/ops-observability/data-center?ops-token=private#loops',replace:(v:string)=>{replaced=v;}},document:{getElementById:()=>link},sessionStorage:{setItem:(k:string,v:string)=>values.set(k,v)},URL});
 assert.equal(replaced,'/dobs/ops-observability#data/loops');assert.equal(values.get('d_obs_admin_token'),'private');assert.ok(!replaced.includes('private'));
});
test('the global force refresh also reads the active workspace while ordinary polling keeps its original scope',async()=>{
 const calls:string[]=[];const state={view:'collection'};
 const context=vm.createContext({state,obsAuthState:{me:null},obsActiveTenant:()=>'',apiHeaders:()=>({}),applyAuthMode:()=>false,obsLogout:async()=>{},loadAll:async(force:boolean)=>{calls.push('platform:'+force);return 'preserved-result';},collectionWorkspace:{refresh:async()=>{calls.push('collection');},reset:()=>{}},dataCenterWorkspace:{refresh:async()=>{calls.push('data');},reset:()=>{}}});
 vm.runInContext(COLLECTION_SHELL_IDENTITY_SCRIPT,context);
 assert.equal(await context.loadAll(true),'preserved-result');assert.deepEqual(calls,['collection','platform:true']);calls.length=0;
 state.view='data';await context.loadAll(true);assert.deepEqual(calls,['data','platform:true']);calls.length=0;
 state.view='overview';await context.loadAll(true);assert.deepEqual(calls,['platform:true']);calls.length=0;
 state.view='collection';await context.loadAll(false);assert.deepEqual(calls,['platform:false']);
});
