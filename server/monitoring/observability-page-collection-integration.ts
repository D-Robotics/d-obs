export const COLLECTION_SHELL_STYLE = `
body.ops-observability #domainSwitcher[hidden]{display:none!important}
body.ops-observability:has(#view-collection:not(.hidden)) .page-head :is(.workspace-facts,#domainContext,#workspaceOptions,#simpleInspectionOptions){display:none!important}
`;
/** Narrow composition patches preserve the deployed console's independent workspaces. */
function once(script:string,before:string,after:string){if(script.split(before).length!==2)throw new Error('collection_shell_baseline_mismatch');return script.replace(before,after);}
export function integrateCollectionScriptA(script:string):string{
  let result=once(script,"const viewNames = ['overview'","const viewNames = ['collection','data','overview'");
  result=once(result,'const viewModuleChildren = {platform:',"const viewModuleChildren = {collection:['tasks','sources','modules','runs'],data:['assets','datasets','loops','tasks','overview'],platform:");
  result=once(result,'const viewMeta = {overview:',"const viewMeta = {collection:['数据与可观测中心 / 采集','统一采集工作区','配置现有云端与终端采集，固定流程版本，跟踪每个模块的实际运行与结果。'],data:['数据与可观测中心 / 数据','数据资产与改善闭环','从采集结果追溯资产和固定数据集，以真实证据验证改善。'],overview:");
  result=once(result,'const moduleNavKey = {',"const moduleNavKey = {'collection/tasks':'collection/tasks','collection/sources':'collection/tasks','collection/modules':'collection/tasks','collection/runs':'collection/tasks','data/assets':'data/assets','data/datasets':'data/assets','data/loops':'data/assets','data/tasks':'data/assets','data/overview':'data/assets',");
  result=once(result,"else if(name!=='devices'&&state.domain==='edge')","else if(!['devices','collection','data'].includes(name)&&state.domain==='edge')");
  result=once(result,'applyViewModules(name,source);',"applyViewModules(name,source);const collectionDomainSwitcher=$('domainSwitcher');if(collectionDomainSwitcher)collectionDomainSwitcher.hidden=['collection','data'].includes(name);if(typeof collectionWorkspace!=='undefined'&&name!=='collection')collectionWorkspace.hide();if(typeof dataCenterWorkspace!=='undefined'&&name!=='data')dataCenterWorkspace.hide();if(name==='collection'&&typeof collectionWorkspace!=='undefined')collectionWorkspace.show(resolved.child);if(name==='data'&&typeof dataCenterWorkspace!=='undefined')dataCenterWorkspace.show(resolved.child);");
  return result;
}
export function integrateCollectionNavScript(script:string):string{return once(script,"const primaryRoutes=['overview','alerts/center','traces','signals','devices'];","const primaryRoutes=['overview','collection/tasks','data/assets','alerts/center','traces','signals','devices'];");}
export const COLLECTION_SHELL_IDENTITY_SCRIPT=String.raw`
      function collectionShellContext(){return JSON.stringify([obsAuthState.me&&obsAuthState.me.user&&obsAuthState.me.user.id,Boolean(obsAuthState.me&&obsAuthState.me.admin),obsActiveTenant(),apiHeaders(false)])}
      let collectionShellIdentity=null;
      const collectionShellPreviousAuth=applyAuthMode;
      applyAuthMode=function(me){const identity=JSON.stringify([me&&me.user&&me.user.id,Boolean(me&&me.admin),obsActiveTenant()]);if(collectionShellIdentity!==null&&collectionShellIdentity!==identity){collectionWorkspace.reset();dataCenterWorkspace.reset()}collectionShellIdentity=identity;const result=collectionShellPreviousAuth(me);if(me&&me.admin){if(state.view==='collection')collectionWorkspace.show(state.viewChild);if(state.view==='data')dataCenterWorkspace.show(state.viewChild)}return result};
      const collectionShellPreviousLogout=obsLogout;
      obsLogout=async function(){collectionWorkspace.reset();dataCenterWorkspace.reset();return collectionShellPreviousLogout()};
      if(typeof loadAll==='function'){
        const collectionShellPreviousLoadAll=loadAll;
        loadAll=async function(force){const workspace=force&&state.view==='collection'?collectionWorkspace:force&&state.view==='data'?dataCenterWorkspace:null;const refresh=workspace&&typeof workspace.refresh==='function'?workspace.refresh():null;const result=await collectionShellPreviousLoadAll(force);if(refresh)await refresh;return result};
      }
`;
