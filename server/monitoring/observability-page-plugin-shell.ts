/** Attach one low-frequency workspace without changing existing route or role semantics. */
export const PLUGIN_CENTER_SHELL_SCRIPT = String.raw`
      (function attachPluginWorkspace(){
        if(!viewNames.includes('plugins'))viewNames.push('plugins');
        viewMeta.plugins=['可观测中心 / 插件','插件与诊断','安装、编辑和发布诊断能力，查看实际数据与执行回执。'];
        const group=document.getElementById('nav-group-advanced');
        const items=group&&group.querySelector('.nav-group-items');
        let button=document.getElementById('pluginCenterNav');
        if(items&&!button){button=make('button','module-tab','插件与诊断');button.id='pluginCenterNav';button.type='button';button.dataset.view='plugins';button.dataset.adminOnly='true';button.setAttribute('aria-controls','view-plugins');items.appendChild(button)}
        function allowed(){return Boolean(opsAdminToken||obsAuthState.me&&obsAuthState.me.admin)&&!opsTenantMode&&!opsMemberMode}
        function visibility(){if(button){const denied=!allowed();button.hidden=denied;button.classList.toggle('hidden',denied)}if(!allowed()&&state.view==='plugins'&&(obsAuthState.me||opsTenantMode||opsMemberMode))setView('overview',false)}
        let entered=false;
        const previousSetView=setView;
        setView=function(){const before=state.view;const result=previousSetView.apply(this,arguments);visibility();if(state.view==='plugins'&&allowed()&&(!entered||before!=='plugins')){entered=true;loadPluginCenter()}return result};
        const previousAuth=applyAuthMode;
        applyAuthMode=function(){const result=previousAuth.apply(this,arguments);visibility();pluginCenterScopeChanged();return result};
        const previousLogout=obsLogout;
        obsLogout=async function(){resetPluginCenterScope();entered=false;return previousLogout.apply(this,arguments)};
        visibility();
      })();
`;
