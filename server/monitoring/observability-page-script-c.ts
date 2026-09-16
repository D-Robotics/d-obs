export const OPS_OBSERVABILITY_SCRIPT_C = `      async function runChecks(){const button=$('runChecks');button.disabled=true;button.textContent='评估中…';try{await request('/api/ops/observability/run-checks',{method:'POST',body:'{}'});toast('评估任务已触发，正在刷新结果');await new Promise(resolve=>setTimeout(resolve,1200));await loadAll(true);toast('即时评估已完成，结果已刷新')}catch(error){toast('运行评估失败：'+friendlyError(error.message),false)}finally{button.disabled=false;button.textContent='立即评估'}}
      function runEvolution(){setView('overview');setTimeout(()=>{const node=$('actionLoopMount');if(node)node.scrollIntoView({behavior:'smooth',block:'start'});toast('候选进化直达触发已关闭；请在证据化行动队列中查看或提交动作。',false)},0)}
      function runRemediation(playbookId,button){const rem=state.remediation;const pb=rem&&rem.playbooks.find(item=>item.id===playbookId);const title=pb?pb.title:playbookId;if(button){button.disabled=true;button.setAttribute('aria-disabled','true')}toast('自愈「'+title+'」必须先绑定事件证据并提交行动提案，由另一位管理员审批后才能执行；本页不会直接修改生产。',false);if(button){button.disabled=false;button.removeAttribute('aria-disabled')}}
      // 顶栏账号区：用户名 chip + 租户切换 select + 退出按钮（SSO 会话）。
      function renderObsAccountBar(){
        const me=obsAuthState.me;if(!me||!me.user)return;
        let bar=document.getElementById('obsAccountBar');
        if(!bar){bar=make('div','obs-account-bar');bar.id='obsAccountBar';const header=document.querySelector('header');if(!header)return;header.appendChild(bar)}
        bar.replaceChildren();
        const label=me.user.name||me.user.email||me.user.id||'账号';
        const chip=make('span','obs-user-chip',label+(me.admin?' · 管理员':''));
        bar.appendChild(chip);
        if(me.tenants&&me.tenants.length){
          const select=make('select','obs-tenant-select');select.id='obsTenantSelect';select.setAttribute('aria-label','切换租户');
          me.tenants.forEach(item=>{const option=make('option','',item.displayName||item.tenantId+(item.role==='owner'?'（owner）':''));option.value=item.tenantId;option.selected=item.tenantId===opsSsoActiveTenant;select.appendChild(option)});
          if(me.admin){const option=make('option','','平台全局视图');option.value='';option.selected=!opsSsoActiveTenant;select.appendChild(option)}
          select.addEventListener('change',()=>{const value=select.value;try{if(value)sessionStorage.setItem('d_obs_active_tenant',value);else sessionStorage.removeItem('d_obs_active_tenant')}catch{}location.reload()});
          bar.appendChild(select);
        }
        const logout=make('button','btn obs-logout-btn','退出');logout.type='button';logout.title='退出账号登录';logout.addEventListener('click',()=>obsLogout());
        bar.appendChild(logout);
      }
      function renderObsNoTenantScreen(user){
        document.querySelectorAll('.view').forEach(node=>node.classList.add('hidden'));
        const box=make('section','panel access');box.dataset.accessScreen='true';
        add(box,'h2','','账号尚未加入任何租户');
        add(box,'p','','你的账号已通过主站身份验证，但还没有加入任何租户。把下方账号 ID 发给平台管理员，即可为你开通组员权限。');
        const idBox=make('div','tenant-token-result');
        add(idBox,'strong','','你的账号 ID');
        const code=make('code','',user.id||'');idBox.appendChild(code);
        const copy=add(idBox,'button','btn','复制账号 ID');copy.type='button';
        copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(user.id||'');toast('账号 ID 已复制')}catch{toast('复制失败，请手动复制',false)}});
        box.appendChild(idBox);
        const actions=make('div','form-actions');
        const logout=add(actions,'button','btn','退出登录');logout.type='button';logout.addEventListener('click',()=>obsLogout());
        box.appendChild(actions);
        const main=document.querySelector('main');if(main)main.appendChild(box);
        projectTelemetryState('unauthorized','账号未加入租户');
      }
      if(typeof initNavGroups==='function')initNavGroups();
      document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
      document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{state.category=button.dataset.category;document.querySelectorAll('[data-category]').forEach(item=>item.classList.toggle('active',item===button));renderRules()}));
      document.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>{state.statusFilter=button.dataset.status;document.querySelectorAll('[data-status]').forEach(item=>item.classList.toggle('active',item===button));renderRules()}));
      $('ruleSearch').value='';$('ruleSearch').addEventListener('focus',()=>$('ruleSearch').removeAttribute('readonly'),{once:true});$('ruleSearch').addEventListener('input',event=>{state.search=event.target.value.trim();renderRules()});
      $('filterTrigger').addEventListener('click',event=>{event.stopPropagation();$('ruleFilters').classList.toggle('hidden')});$('ruleFilters').addEventListener('click',event=>event.stopPropagation());$('closeFilters').addEventListener('click',()=>$('ruleFilters').classList.add('hidden'));$('clearFilters').addEventListener('click',()=>{state.category='all';state.statusFilter='all';document.querySelectorAll('[data-category]').forEach(item=>item.classList.toggle('active',item.dataset.category==='all'));document.querySelectorAll('[data-status]').forEach(item=>item.classList.toggle('active',item.dataset.status==='all'));renderRules()});document.addEventListener('click',()=>$('ruleFilters').classList.add('hidden'));
      $('refresh').addEventListener('click',()=>loadAll(true));$('runChecks').addEventListener('click',runChecks);$('runEvolution').addEventListener('click',runEvolution);$('closeEditor').addEventListener('click',closeEditor);$('cancelEditor').addEventListener('click',closeEditor);$('testRule').addEventListener('click',testRule);$('saveRule').addEventListener('click',saveRule);$('closeTemplateEditor').addEventListener('click',()=>{state.templateEditing=false;$('templateEditorZone').classList.add('hidden');$('templateSummary').scrollIntoView({behavior:'smooth',block:'start'})});$('ruleDrawer').addEventListener('click',event=>{if(event.target===$('ruleDrawer'))closeEditor()});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEditor()});window.addEventListener('hashchange',()=>{const raw=location.hash.replace(/^#/,'');if(raw.startsWith('remediate=')){try{state.pendingRemediate=decodeURIComponent(raw.slice(10))}catch{state.pendingRemediate=raw.slice(10)}setView('overview',false);return}const alias=viewAliases[raw]||raw;if(viewNames.includes(raw)||viewNames.includes(alias))setView(raw,false)});
      const hashRaw=location.hash.replace(/^#/,'');if(hashRaw.startsWith('remediate=')){try{state.pendingRemediate=decodeURIComponent(hashRaw.slice(10))}catch{state.pendingRemediate=hashRaw.slice(10)}state.view='overview'}else{const alias=viewAliases[hashRaw]||hashRaw;/* Keep the raw alias for this first call so setView can open its legacy accordion. It canonicalizes state.view before loadAll runs. */state.view=(viewNames.includes(hashRaw)||viewNames.includes(alias))?(hashRaw||'overview'):'overview'}setView(state.view,false);
      // 启动序列：先问一次 /auth/me 恢复登录态（免登时身份由服务端从同源 Cookie
      // 解析，前端本地可能一个凭证都没有），再决定进入哪个视图分支。
      (async()=>{
        if(typeof applyAuthMode!=='function'){loadAll();return}
        const me=await obsLoadMe();
        const user=me&&me.user;
        if(!user){
          // 未登录：本地会话可能是真过期（清掉），也可能是网络抖动（obsLoadMe 返回
          // null 时不要误清，避免把用户踢回登录屏）。
          if(sessionStorage.getItem('d_obs_sso_session')&&!me){loadAll();return}
          if(opsAdminToken||opsTenantMode){loadAll();return}
          const enabled=await obsAccessEnabled();
          if(enabled===true){loadAll();return}
          renderAccess();return
        }
        renderObsAccountBar();
        if(me.admin){applyAuthMode(me);loadAll();return}
        const tenants=me.tenants||[];
        if(!tenants.length){renderObsNoTenantScreen(user);return}
        const active=obsActiveTenant();
        if(!active||!tenants.some(item=>item.tenantId===active)){
          // 已加入租户但尚未选择（或所选租户已失效）：默认选第一个，整页 reload
          // 一次以重建 opsMemberMode / 租户头所在的作用域。
          try{sessionStorage.setItem('d_obs_active_tenant',tenants[0].tenantId)}catch{}
          location.reload();return
        }
        applyAuthMode(me);
        // #tenants 深链/刷新时 setView 早于本次 /auth/me 解析执行过，组员面板会按
        // 「未登录」渲染成只读名单；身份到手后重渲染一次，owner 才有管理操作。
        if(opsMemberMode&&state.view==='tenants'&&typeof renderObsMemberTenantsView==='function')renderObsMemberTenantsView();
        loadAll();
      })();
      }
      if(typeof document!=='undefined'&&document.addEventListener){
        document.addEventListener('visibilitychange',()=>{
          if(document.visibilityState==='hidden'){obsPollStop();return}
          // 回到前台：只在数据确实过期时补一次，避免频繁切换标签页放大请求。
          if(!obsLastOkAt||Date.now()-obsLastOkAt>=OBS_POLL_BASE_MS)loadAll(false);
          obsPollSchedule();
        });
      }
      obsPollSchedule();
    })();`;
