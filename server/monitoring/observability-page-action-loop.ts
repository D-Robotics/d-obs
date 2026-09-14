/**
 * Browser projection for the evidence-first AI SRE action loop.
 *
 * This fragment is concatenated into the existing safe-DOM observability page.
 * It deliberately has no command runner of its own: mutations are limited to
 * the allowlisted action API and every destructive transition remains behind
 * the server-side approval and remediation gates.
 */
export const OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT = `
      state.actionLoop={actions:[],loading:false,loaded:false,error:'',mutationError:'',busyId:''};
      const ACTION_LOOP_STATUS_LABELS={pending_approval:'待审批',approved:'已批准',completed:'已记录',denied:'已拒绝',executing:'执行中',succeeded:'已验证',failed:'执行失败',verification_failed:'验证未通过'};
      const ACTION_LOOP_TYPE_LABELS={investigate:'调查',observe:'观察',escalate:'升级',remediate:'白名单处置'};
      const ACTION_LOOP_REF_PATTERN=/^(summary|incident|check|event|slo|trace):[A-Za-z0-9._:-]{1,160}$/;

      function actionLoopStatusLabel(status){return ACTION_LOOP_STATUS_LABELS[String(status||'')]||'待确认'}
      function actionLoopTypeLabel(type){return ACTION_LOOP_TYPE_LABELS[String(type||'')]||'行动'}
      function actionLoopActionList(){return Array.isArray(state.actionLoop&&state.actionLoop.actions)?state.actionLoop.actions:[]}
      function actionLoopFriendlyError(value){const message=String(value&&value.message||value||'action_loop_failed');return friendlyError(message)||'行动暂时不可用，请稍后重试'}
      function actionLoopRequest(path,options){const requestOptions=options||{};const method=String(requestOptions.method||'GET').toUpperCase();const headers=method==='GET'?(typeof contextRequestHeaders==='function'?contextRequestHeaders():apiHeaders(false)):apiHeaders(true);return fetch(base+path,Object.assign({credentials:'same-origin',headers},requestOptions)).then(async response=>{if(response.status===401||response.status===403){renderAccess();throw new Error('not_authorized')}const data=await response.json().catch(()=>({}));const acceptedAsync=response.status===202&&data.action; if(!response.ok||(!data.ok&&!acceptedAsync))throw new Error(data.error||data.message||('HTTP '+response.status));return data})}
      function actionLoopPlaybook(playbookId){const rem=state.remediation;return rem&&Array.isArray(rem.playbooks)?rem.playbooks.find(item=>item.id===playbookId):null}
      function actionLoopEvidenceButton(parent,ref,o){const value=String(ref||'').trim();if(!ACTION_LOOP_REF_PATTERN.test(value))return;const button=add(parent,'button','action-loop-ref',value);button.type='button';button.title='打开证据 '+value;button.addEventListener('click',()=>{if(typeof navigateCopilotEvidence==='function')navigateCopilotEvidence(value,o||state.overview)});return button}
      function actionLoopMeta(parent,label,value){if(value===null||value===undefined||String(value)==='')return;const node=add(parent,'span','',label+' '+String(value));node.title=String(value);return node}
      // If the host cannot present a confirmation dialog, fail closed instead
      // of silently authorizing a potentially mutating action.
      function actionLoopConfirm(message){return typeof window.confirm==='function'&&window.confirm(message)}

      async function loadActionLoop(force){
        if(!state.actionLoop||state.actionLoop.loading)return;
        if(!force&&state.actionLoop.loaded)return;
        state.actionLoop.loading=true;state.actionLoop.error='';renderActionLoopMount();
        try{const data=await actionLoopRequest('/api/ops/observability/actions?limit=20');state.actionLoop.actions=Array.isArray(data.actions)?data.actions:[];state.actionLoop.loaded=true}
        catch(error){state.actionLoop.error=actionLoopFriendlyError(error);state.actionLoop.loaded=false}
        finally{state.actionLoop.loading=false;renderActionLoopMount()}
      }

      async function runActionLoopMutation(action,path,body,button){
        if(!action||state.actionLoop.busyId)return;
        if(button){button.disabled=true;button.setAttribute('aria-busy','true')}
        state.actionLoop.busyId=action.id;renderActionLoopMount();
        try{const data=await actionLoopRequest('/api/ops/observability/actions/'+encodeURIComponent(action.id)+path,{method:'POST',body:JSON.stringify(body||{})});state.actionLoop.mutationError='';const next=data.action;const status=next&&next.status?actionLoopStatusLabel(next.status):'已更新';toast(path==='/verify'?(next&&next.status==='succeeded'?'行动验证通过':'行动已复核，等待下一次真实检查'):status);await loadActionLoop(true)}
        catch(error){const message='行动未更新：'+actionLoopFriendlyError(error);state.actionLoop.mutationError=message;toast(message,false)}
        finally{state.actionLoop.busyId='';if(button&&button.isConnected){button.disabled=false;button.removeAttribute('aria-busy')}renderActionLoopMount();const alert=$('actionLoopMutationError');if(alert){alert.focus()}}
      }

      function actionLoopRenderControls(parent,action){
        const controls=make('div','action-loop-controls');
        const busy=state.actionLoop.busyId===action.id;
        if(action.status==='pending_approval'){
          const approve=add(controls,'button','btn primary',busy?'处理中…':'批准');approve.type='button';approve.disabled=busy;approve.addEventListener('click',()=>{if(actionLoopConfirm('确认批准该行动？白名单处置仍需在下一步单独执行。'))runActionLoopMutation(action,'/decision',{decision:'approve'},approve)});
          const deny=add(controls,'button','btn danger','拒绝');deny.type='button';deny.disabled=busy;deny.addEventListener('click',()=>{if(actionLoopConfirm('确认拒绝该行动？'))runActionLoopMutation(action,'/decision',{decision:'deny'},deny)});
        }else if(action.status==='approved'){
          if(action.type==='remediate'&&action.playbookId){const playbook=actionLoopPlaybook(action.playbookId);const execute=add(controls,'button','btn primary',busy?'启动中…':'执行白名单剧本');execute.type='button';execute.disabled=busy;execute.title=playbook?playbook.description:'仅允许服务端白名单剧本';execute.addEventListener('click',()=>{if(actionLoopConfirm('确认执行「'+(playbook?playbook.title:action.playbookId)+'」？执行会进入独立 systemd 单元，并等待后置验证。'))runActionLoopMutation(action,'/execute',{},execute)})}
          else{const complete=add(controls,'button','btn primary',busy?'处理中…':'标记已完成');complete.type='button';complete.disabled=busy;complete.title='只记录人工完成，不执行设备或生产变更';complete.addEventListener('click',()=>{if(actionLoopConfirm('确认将该只读行动标记为已完成？这只会记录审计，不会执行任何命令。'))runActionLoopMutation(action,'/complete',{},complete)})}
        }else if(action.status==='executing'){
          const verify=add(controls,'button','btn primary',busy?'检查中…':'检查真实结果');verify.type='button';verify.disabled=busy;verify.addEventListener('click',()=>runActionLoopMutation(action,'/verify',{},verify));
        }else if(action.status==='verification_failed'){
          const regression=add(controls,'button','btn danger','加入回归集');regression.type='button';regression.disabled=busy;regression.addEventListener('click',()=>runActionLoopMutation(action,'/regression',{marker:'regression-suite:observability-action'},regression));
        }else if(action.status==='succeeded'||action.status==='failed'){
          if(action.regressionMarker)add(controls,'span','action-created','已加入回归集 · '+action.regressionMarker);
          else{const regression=add(controls,'button','btn','加入回归集');regression.type='button';regression.disabled=busy;regression.addEventListener('click',()=>runActionLoopMutation(action,'/regression',{marker:'regression-suite:observability-action'},regression))}
        }
        return controls;
      }

      function renderActionLoopCard(action,o){
        const card=make('article','action-loop-card');card.dataset.status=String(action.status||'');
        const head=make('div','action-loop-card-head');const title=make('div','action-loop-card-title');const type=add(title,'span','action-loop-type',actionLoopTypeLabel(action.type));const copy=make('div');add(copy,'h3', '',action.title||'未命名行动');add(copy,'p','',action.type==='remediate'&&action.playbookId?(actionLoopPlaybook(action.playbookId)?.title||action.playbookId):(action.rationale||'证据约束的运营建议'));title.appendChild(copy);head.appendChild(title);add(head,'span','action-loop-status '+String(action.status||''),actionLoopStatusLabel(action.status));card.appendChild(head);
        const meta=make('div','action-loop-meta');actionLoopMeta(meta,'ID',action.id);actionLoopMeta(meta,'提出',action.proposedBy);actionLoopMeta(meta,'创建',when(action.createdAt));if(action.approvedBy)actionLoopMeta(meta,'批准',action.approvedBy);if(action.runId)actionLoopMeta(meta,'Run',action.runId);if(action.execution&&action.execution.runId)actionLoopMeta(meta,'处置 Run',action.execution.runId);card.appendChild(meta);
        if(action.rationale)add(card,'div','action-loop-rationale',action.rationale);
        const evidence=make('div','action-loop-evidence');add(evidence,'span','action-loop-evidence-label','证据');const refs=Array.isArray(action.evidenceRefs)?action.evidenceRefs:[];refs.slice(0,8).forEach(ref=>actionLoopEvidenceButton(evidence,ref,o));if(!refs.length)add(evidence,'span','action-unavailable','没有可引用证据，服务端不会执行');card.appendChild(evidence);
        const footer=make('div','action-loop-footer');const safety=make('div','action-loop-safety');add(safety,'span','',action.type==='remediate'?'白名单剧本 · 审批后执行':'只读建议 · 不直接改生产');if(action.execution&&action.execution.verification&&action.status==='executing')add(safety,'strong','', '等待真实验证');footer.appendChild(safety);footer.appendChild(actionLoopRenderControls(make('div','action-loop-controls-wrap'),action));card.appendChild(footer);return card;
      }

      function renderActionLoopPanel(){
        const panel=make('section','panel action-loop-panel');panel.id='actionLoopPanel';panel.setAttribute('aria-labelledby','actionLoopHeading');
        const head=make('div','action-loop-head');const identity=make('div','action-loop-identity');add(identity,'span','action-loop-orb','SRE');const copy=make('div');const heading=add(copy,'h2','','行动闭环');heading.id='actionLoopHeading';add(copy,'div','action-loop-kicker','AI SRE · Evidence first');add(copy,'p','','证据 → 审批 → 执行 → 验证 → 回归。只有后置检查通过，行动才会显示为已验证；只读行动关闭后显示为已记录。');identity.appendChild(copy);head.appendChild(identity);const headActions=make('div','action-loop-head-actions');const count=add(headActions,'span','action-loop-count '+(actionLoopActionList().some(item=>['pending_approval','executing','verification_failed'].includes(item.status))?'warn':''),actionLoopActionList().length+' 条行动');const refresh=add(headActions,'button','btn action-loop-refresh',state.actionLoop.loading?'读取中…':'刷新');refresh.type='button';refresh.disabled=state.actionLoop.loading;refresh.addEventListener('click',()=>loadActionLoop(true));headActions.appendChild(refresh);head.appendChild(headActions);panel.appendChild(head);
        const flow=make('div','action-loop-flow');['证据','审批','执行','验证','回归'].forEach((label,index)=>{const step=add(flow,'div','action-loop-flow-step '+(index===0?'is-active':index===4?'is-safe':''),label);step.setAttribute('aria-label',label)});panel.appendChild(flow);
        const body=make('div','action-loop-body');
        if(state.actionLoop.mutationError){const mutationError=add(body,'div','action-loop-state error',state.actionLoop.mutationError);mutationError.id='actionLoopMutationError';mutationError.setAttribute('role','alert');mutationError.setAttribute('aria-live','assertive');mutationError.tabIndex=-1;const retry=add(mutationError,'button','btn','重新读取');retry.type='button';retry.addEventListener('click',()=>{state.actionLoop.mutationError='';void loadActionLoop(true)});}
        if(state.actionLoop.loading){const loading=make('div','action-loop-state');loading.setAttribute('role','status');add(loading,'strong','','正在读取行动队列');add(loading,'span','','只读取当前账号有权查看的行动与审计状态。');const skeleton=make('div','action-loop-skeleton');skeleton.appendChild(make('i'));skeleton.appendChild(make('i'));skeleton.appendChild(make('i'));loading.appendChild(skeleton);body.appendChild(loading)}
        else if(state.actionLoop.error){const failed=make('div','action-loop-state error');failed.setAttribute('role','alert');add(failed,'strong','','行动队列暂时不可用');add(failed,'span','',state.actionLoop.error);const retry=add(failed,'button','btn primary','重试');retry.type='button';retry.addEventListener('click',()=>loadActionLoop(true));body.appendChild(failed)}
        else if(!actionLoopActionList().length){const empty=make('div','action-loop-empty');add(empty,'strong','','还没有持久化行动');add(empty,'span','','在“事故调查 → AI 事故副驾”生成结构化建议后，批准、执行和验证会集中显示在这里。');const go=add(empty,'button','btn','打开事故调查');go.type='button';go.addEventListener('click',()=>{if(typeof setView==='function')setView('investigate')});body.appendChild(empty)}
        else{const list=make('div','action-loop-list');actionLoopActionList().slice().sort((a,b)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime()).forEach(action=>list.appendChild(renderActionLoopCard(action,state.investigationOverview||state.overview)));body.appendChild(list)}
        const note=make('div','action-loop-note');add(note,'strong','','安全说明');add(note,'span','', '模型不能提交命令；处置只接受服务端白名单剧本，执行成功也必须等待精确 remediation Run 的后置验证。');body.appendChild(note);panel.appendChild(body);return panel;
      }

      function renderActionLoopMount(){const root=$('actionLoopMount');if(!root)return;root.replaceChildren(renderActionLoopPanel())}
      const actionLoopBaseRenderOverview=renderOverview;
      renderOverview=function(){actionLoopBaseRenderOverview();const root=$('overviewContent');if(!root||!state.overview)return;const legacy=root.querySelector('.action-queue');if(legacy)legacy.remove();if(Array.isArray(state.actions)){state.actionLoop.actions=state.actions;state.actionLoop.error='';state.actionLoop.loaded=true}let mount=$('actionLoopMount');if(!mount||mount.parentNode!==root){mount=make('div');mount.id='actionLoopMount';const focus=root.querySelector('.unified-focus');if(focus)root.insertBefore(mount,focus);else root.appendChild(mount)}renderActionLoopMount();if(!state.actionLoop.loaded&&!state.actionLoop.loading)void loadActionLoop(false)};
      const actionLoopBaseLoadAll=loadAll;
      loadAll=async function(manual){if(state.actionLoop)state.actionLoop.loaded=false;const result=await actionLoopBaseLoadAll(manual);void loadActionLoop(Boolean(manual));return result};

      function actionLoopCopilotRefs(item,analysis){const allowed=new Set((analysis&&analysis.evidenceIndex||[]).map(value=>String(value&&value.ref||'')));return (Array.isArray(item&&item.evidenceRefs)?item.evidenceRefs:[]).map(value=>String(value||'').trim()).filter(value=>ACTION_LOOP_REF_PATTERN.test(value)&&allowed.has(value)).slice(0,32)}
      function actionLoopCandidatePlaybooks(item){const all=state.remediation&&Array.isArray(state.remediation.playbooks)?state.remediation.playbooks:[];const refs=Array.isArray(item&&item.evidenceRefs)?item.evidenceRefs:[];const keys=refs.filter(ref=>String(ref).startsWith('check:')).map(ref=>String(ref).slice(6));const matching=all.filter(playbook=>keys.some(key=>Array.isArray(playbook.appliesTo)&&playbook.appliesTo.includes(key)));return matching.length?matching:all}
      async function proposeActionFromCopilot(item,analysis,o,button,select){if(!item||!analysis)return;const evidenceRefs=actionLoopCopilotRefs(item,analysis);if(!evidenceRefs.length){toast('缺少可验证证据，不能加入行动队列',false);return}if(!analysis.evidenceProof){toast('证据包已过期，请重新研判后再加入行动队列',false);return}let playbookId=null;if(item.actionType==='remediate'){playbookId=select&&select.value||'';if(!playbookId){toast('请先选择一个白名单剧本',false);return}}if(button){button.disabled=true;button.textContent='加入中…'}try{const data=await actionLoopRequest('/api/ops/observability/actions',{method:'POST',body:JSON.stringify({runId:null,type:item.actionType,title:item.title,rationale:item.rationale,evidenceRefs,playbookId,evidenceProof:analysis.evidenceProof,requiresApproval:item.requiresApproval!==false})});toast(data.action&&data.action.status==='pending_approval'?'已加入待审批队列':'已加入行动队列');if(button){button.textContent='已加入';button.classList.remove('primary');button.classList.add('action-created')}await loadActionLoop(true)}catch(error){toast('加入行动失败：'+actionLoopFriendlyError(error),false);if(button){button.disabled=false;button.textContent='加入行动队列'}}}
      const actionLoopBaseRenderCopilotAnalysis=renderCopilotAnalysis;
      renderCopilotAnalysis=function(root,analysis,o){actionLoopBaseRenderCopilotAnalysis(root,analysis,o);const rows=root.querySelectorAll('.copilot-action');const items=Array.isArray(analysis&&analysis.nextActions)?analysis.nextActions:[];Array.from(rows).forEach((row,index)=>{const item=items[index];if(!item)return;const controls=make('div','copilot-action-controls');let select=null;if(item.actionType==='remediate'){select=make('select','');select.setAttribute('aria-label','选择白名单剧本');const options=actionLoopCandidatePlaybooks(item);if(!options.length){const option=make('option','', '暂无匹配白名单剧本');option.value='';select.appendChild(option);select.disabled=true}else{const placeholder=make('option','', '选择白名单剧本…');placeholder.value='';placeholder.selected=true;select.appendChild(placeholder);options.forEach(playbook=>{const option=make('option','',playbook.title);option.value=playbook.id;select.appendChild(option)})}controls.appendChild(select)}const button=add(controls,'button','btn '+(item.actionType==='remediate'?'':'primary'),'加入行动队列');button.type='button';button.addEventListener('click',()=>proposeActionFromCopilot(item,analysis,o,button,select));row.appendChild(controls)})};
`;
