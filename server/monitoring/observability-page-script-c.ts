export const OPS_OBSERVABILITY_SCRIPT_C = `      async function runChecks(){const button=$('runChecks');button.disabled=true;button.textContent='评估中…';try{await request('/api/ops/observability/run-checks',{method:'POST',body:'{}'});toast('评估任务已触发，正在刷新结果');await new Promise(resolve=>setTimeout(resolve,1200));await loadAll(true);toast('即时评估已完成，结果已刷新')}catch(error){toast('运行评估失败：'+friendlyError(error.message),false)}finally{button.disabled=false;button.textContent='立即评估'}}
      function runEvolution(){setView('overview');setTimeout(()=>{const node=$('actionLoopMount');if(node)node.scrollIntoView({behavior:'smooth',block:'start'});toast('候选进化直达触发已关闭；请在证据化行动队列中查看或提交动作。',false)},0)}
      function runRemediation(playbookId,button){const rem=state.remediation;const pb=rem&&rem.playbooks.find(item=>item.id===playbookId);const title=pb?pb.title:playbookId;if(button){button.disabled=true;button.setAttribute('aria-disabled','true')}toast('自愈「'+title+'」必须先绑定事件证据并提交行动提案，由另一位管理员审批后才能执行；本页不会直接修改生产。',false);if(button){button.disabled=false;button.removeAttribute('aria-disabled')}}
      // 账号状态常驻侧边栏左下角（Studio 式）：身份 chip + 租户切换 + 退出。
      // 无 SSO 身份时降级展示令牌模式（运营令牌直连 / 租户只读）。
      function renderObsAccountBar(){
        const me=obsAuthState.me;
        const label=me&&me.user?(me.user.name||me.user.email||me.user.id||'账号')+(me.admin?' · 管理员':''):(opsTenantMode?'租户只读':(opsAdminToken?'运营令牌直连':''));
        if(!label)return;
        let bar=document.getElementById('obsAccountBar');
        if(!bar){bar=make('div','side-nav-footer');bar.id='obsAccountBar';const side=document.querySelector('.side-nav');if(!side)return;side.appendChild(bar)}
        bar.replaceChildren();
        const chip=make('span','obs-user-chip',label);
        bar.appendChild(chip);
        if(me&&me.user&&me.tenants&&me.tenants.length){
          const select=make('select','obs-tenant-select');select.id='obsTenantSelect';select.setAttribute('aria-label','切换租户');
          me.tenants.forEach(item=>{const option=make('option','',item.displayName||item.tenantId+(item.role==='owner'?'（owner）':''));option.value=item.tenantId;option.selected=item.tenantId===opsSsoActiveTenant;select.appendChild(option)});
          if(me.admin){const option=make('option','','平台全局视图');option.value='';option.selected=!opsSsoActiveTenant;select.appendChild(option)}
          select.addEventListener('change',()=>{const value=select.value;try{if(value)sessionStorage.setItem('d_obs_active_tenant',value);else sessionStorage.removeItem('d_obs_active_tenant')}catch{}location.reload()});
          bar.appendChild(select);
        }
        const logout=make('button','btn obs-logout-btn',opsAdminToken?'退出令牌':'退出');logout.type='button';logout.title='退出账号登录';logout.addEventListener('click',()=>obsLogout());
        bar.appendChild(logout);
      }
      function renderObsNoTenantScreen(user){
        document.body.classList.add('auth-gate');
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
        let gate=document.getElementById('authGate');if(!gate){gate=make('div');gate.id='authGate'}
        gate.replaceChildren();const brand=make('div','auth-gate-brand');const mark=add(brand,'div','brand-mark','d');const brandCopy=make('div','auth-gate-brand-copy');add(brandCopy,'strong','','可观测中心');add(brandCopy,'small','','D-OBS · Reliability Operations');brand.appendChild(brandCopy);gate.appendChild(brand);gate.appendChild(box);
        document.body.appendChild(gate);
        projectTelemetryState('unauthorized','账号未加入租户');
      }
      if(typeof initNavGroups==='function')initNavGroups();
      document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
      document.querySelectorAll('[data-module-tab]').forEach(tab=>tab.addEventListener('click',()=>setView(tab.dataset.moduleTab)));
      $('saveSettings').addEventListener('click',saveSettings);
      document.querySelectorAll('[data-domain-tab]').forEach(button=>button.addEventListener('click',()=>setDomain(button.dataset.domainTab)));
      document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{state.category=button.dataset.category;document.querySelectorAll('[data-category]').forEach(item=>item.classList.toggle('active',item===button));renderRules()}));
      document.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>{state.statusFilter=button.dataset.status;document.querySelectorAll('[data-status]').forEach(item=>item.classList.toggle('active',item===button));renderRules()}));
      $('ruleSearch').value='';$('ruleSearch').addEventListener('focus',()=>$('ruleSearch').removeAttribute('readonly'),{once:true});$('ruleSearch').addEventListener('input',event=>{state.search=event.target.value.trim();renderRules()});
      $('filterTrigger').addEventListener('click',event=>{event.stopPropagation();$('ruleFilters').classList.toggle('hidden')});$('ruleFilters').addEventListener('click',event=>event.stopPropagation());$('closeFilters').addEventListener('click',()=>$('ruleFilters').classList.add('hidden'));$('clearFilters').addEventListener('click',()=>{state.category='all';state.statusFilter='all';document.querySelectorAll('[data-category]').forEach(item=>item.classList.toggle('active',item.dataset.category==='all'));document.querySelectorAll('[data-status]').forEach(item=>item.classList.toggle('active',item.dataset.status==='all'));renderRules()});document.addEventListener('click',()=>$('ruleFilters').classList.add('hidden'));
      $('refresh').addEventListener('click',()=>loadAll(true));$('runChecks').addEventListener('click',runChecks);$('runEvolution').addEventListener('click',runEvolution);$('closeEditor').addEventListener('click',closeEditor);$('cancelEditor').addEventListener('click',closeEditor);$('testRule').addEventListener('click',testRule);$('saveRule').addEventListener('click',saveRule);$('closeTemplateEditor').addEventListener('click',()=>{state.templateEditing=false;$('templateEditorZone').classList.add('hidden');$('templateSummary').scrollIntoView({behavior:'smooth',block:'start'})});$('ruleDrawer').addEventListener('click',event=>{if(event.target===$('ruleDrawer'))closeEditor()});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEditor()});window.addEventListener('hashchange',()=>{const raw=location.hash.replace(/^#/,'');if(raw.startsWith('remediate=')){try{state.pendingRemediate=decodeURIComponent(raw.slice(10))}catch{state.pendingRemediate=raw.slice(10)}setView('overview',false);return}setView(raw,false)});
      const hashRaw=location.hash.replace(/^#/,'');let bootRequest='overview';if(hashRaw.startsWith('remediate=')){try{state.pendingRemediate=decodeURIComponent(hashRaw.slice(10))}catch{state.pendingRemediate=hashRaw.slice(10)}}else if(hashRaw){bootRequest=hashRaw}
      // 启动即按「视图/子模块」两级解析；未知 hash 由 setView 统一回落到总览。
      const bootResolved=resolveViewRequest(bootRequest);state.view=viewNames.includes(bootResolved.name)?bootResolved.name:'overview';setDomain(state.view==='devices'?'edge':'cloud',false);setView(bootRequest,false);
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
          if(opsAdminToken||opsTenantMode){renderObsAccountBar();loadAll();return}
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
      // ---- 轮询节流 ----
      // 原来是无条件 setInterval(30s)：每个打开的工作台（含被切到后台的标签页）
      // 都会持续全量拉 overview + 各域数据，每次请求还会触发一次 SSO 会话校验。
      // 现在：隐藏标签页完全不发请求；回到前台若数据已过期先补一次；连续失败按
      // 指数退避（30s→60s→…→上限 5 分钟），一次成功即复位。
      // obsLastOkAt 由 applyOverviewSnapshot 更新——它是租户/组员/平台三条加载
      // 分支共同的成功出口。
      const OBS_POLL_BASE_MS=30000;
      const OBS_POLL_MAX_MS=300000;
      let obsPollTimer=null;
      let obsPollFailures=0;
      function obsPollInterval(){return Math.min(OBS_POLL_MAX_MS,OBS_POLL_BASE_MS*Math.pow(2,Math.min(obsPollFailures,4)))}
      function obsPollStop(){if(obsPollTimer){clearTimeout(obsPollTimer);obsPollTimer=null}}
      function obsPollSchedule(){obsPollStop();if(typeof document==='undefined'||document.visibilityState==='hidden')return;obsPollTimer=setTimeout(obsPollTick,obsPollInterval())}
      async function obsPollTick(){
        obsPollTimer=null;
        if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
        try{await loadAll(false)}catch{}
        if(obsLastOkAt&&Date.now()-obsLastOkAt<obsPollInterval())obsPollFailures=0;
        else obsPollFailures+=1;
        obsPollSchedule();
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
