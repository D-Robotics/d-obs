/** 模型池控制面：路由拓扑可视化 + 权重/备用顺序就地调整；替换与回滚收在高级操作。 */
export const OPS_OBSERVABILITY_SCRIPT_MODEL_POOL = `
      async function loadModelPool(){
        try{const data=await request('/api/ops/observability/model-pool');state.modelPool=data;renderModelPool()}catch(error){if(error.message!=='not_authorized')toast('模型池加载失败：'+friendlyError(error.message),false)}}
      function modelStateName(value){return ({healthy:'正常',half_open:'半开',cooldown:'冷却',degraded:'退化'})[value]||value||'未知'}
      function modelStateClass(value){return value==='healthy'?'good':(value==='cooldown'?'bad':(value==='half_open'?'warn':''))}
      function modelTargetName(target){return (target.frontendModels&&target.frontendModels[0])||target.label||target.model}
      function modelCleanupCandidate(target){return !(target.frontendModels&&target.frontendModels.length)&&!(target.roles||[]).includes('primary')}
      async function cleanupModelTarget(target){
        const label=target.label||target.model;
        try{await request('/api/ops/observability/model-pool/cleanup',{method:'POST',body:JSON.stringify({confirm:'CLEANUP',frontendModel:(target.frontendModels&&target.frontendModels[0])||'',target:{baseUrl:target.baseUrl,model:target.model}})});return true}
        catch(error){toast('清理 '+label+' 失败：'+friendlyError(error.message),false);return false}
      }
      function modelTargetKey(entry){const raw=String((entry&&entry.baseUrl)||'');let host=raw;try{host=new URL(raw).host}catch{host=raw.replace(/^https?:\\/\\//,'').split('/')[0]||raw}return host+'/'+((entry&&entry.model)||'')}
      function mpSvg(tag){return document.createElementNS('http://www.w3.org/2000/svg',tag)}
      function mpShort(value,max){const text=String(value==null?'':value);return text.length>max?text.slice(0,max-1)+'…':text}
      function mpEdgeWidth(weight){const w=Number(weight);if(!Number.isFinite(w))return 1.6;return 1.6+4*Math.sqrt(Math.min(Math.max(w,0),200)/200)}
      function modelRouteSlug(name){return String(name).replace(/[^a-zA-Z0-9_-]/g,'_')}
      function focusModelRouteRow(name){const row=document.getElementById('mp-route-'+modelRouteSlug(name));if(!row)return;if(row.scrollIntoView)row.scrollIntoView({behavior:'smooth',block:'center'});row.classList.add('mp-flash');setTimeout(()=>row.classList.remove('mp-flash'),1500)}
      function renderModelTopology(mount,mapping,targets,protectedModel){
        const section=make('section','panel model-pool-topo');const head=make('div','table-title');const headCopy=make('div');add(headCopy,'h2','','路由拓扑');add(headCopy,'div','hint','实线为主目标（线宽随权重加粗），虚线为备用顺序；目标节点右侧圆点即健康状态。点击左侧路由可跳到下方编辑行。');head.appendChild(headCopy);section.appendChild(head);
        const routeNames=Object.keys(mapping);
        if(!routeNames.length||!targets.length){add(section,'div','empty',routeNames.length?'网关未上报目标健康数据，暂时无法绘制拓扑':'网关未返回模型映射，暂时无法绘制拓扑');mount.appendChild(section);return}
        const targetByKey=new Map();targets.forEach(t=>targetByKey.set(modelTargetKey(t),t));
        const primaryKeyOf=name=>modelTargetKey(mapping[name]||{});
        const rowH=54,padTop=14,leftX=252,rightX=568;
        const routePos=new Map();const targetPos=new Map();
        routeNames.forEach((name,i)=>routePos.set(name,{y:padTop+i*rowH+rowH/2}));
        targets.forEach((t,j)=>targetPos.set(modelTargetKey(t),{y:padTop+j*rowH+rowH/2}));
        const missing=[];routeNames.forEach(name=>{const key=primaryKeyOf(name);if(!targetByKey.has(key)&&!targetPos.has(key)&&!missing.includes(key))missing.push(key)});
        missing.forEach((key,k)=>targetPos.set(key,{y:padTop+(targets.length+k)*rowH+rowH/2}));
        const height=padTop+Math.max(routeNames.length,targets.length+missing.length)*rowH+6;
        const svg=mpSvg('svg');svg.setAttribute('class','mp-topo-svg');svg.setAttribute('viewBox','0 0 920 '+height);svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.setAttribute('role','img');svg.setAttribute('aria-label','模型路由拓扑图');
        const edges=mpSvg('g');
        routeNames.forEach(name=>{
          const from=routePos.get(name);const to=targetPos.get(primaryKeyOf(name));if(!from||!to)return;
          const weight=mapping[name]&&mapping[name].weight;
          const path=mpSvg('path');path.setAttribute('d','M '+leftX+' '+from.y+' C '+(leftX+110)+' '+from.y+', '+(rightX-110)+' '+to.y+', '+rightX+' '+to.y);path.setAttribute('class','mp-edge-primary');path.setAttribute('stroke-width',String(mpEdgeWidth(weight)));edges.appendChild(path);
          if(weight!=null&&Number.isFinite(Number(weight))){const label=mpSvg('text');label.setAttribute('x',String((leftX+rightX)/2));label.setAttribute('y',String((from.y+to.y)/2-7));label.setAttribute('text-anchor','middle');label.setAttribute('class','mp-edge-weight');label.textContent='权重 '+Number(weight);edges.appendChild(label)}
          const fallbacks=(((mapping[name]||{}).fallbacks)||[]).map(v=>typeof v==='string'?v:(v&&v.ref)||'').filter(Boolean);
          fallbacks.forEach((fb,order)=>{const fto=targetPos.get(primaryKeyOf(fb));if(!fto)return;const dashed=mpSvg('path');dashed.setAttribute('d','M '+leftX+' '+from.y+' C '+(leftX+110)+' '+from.y+', '+(rightX-110)+' '+fto.y+', '+rightX+' '+fto.y);dashed.setAttribute('class','mp-edge-fallback');edges.appendChild(dashed);const badge=mpSvg('text');badge.setAttribute('x',String((leftX+rightX)/2));badge.setAttribute('y',String((from.y+fto.y)/2+11));badge.setAttribute('text-anchor','middle');badge.setAttribute('class','mp-edge-order');badge.textContent='备 '+(order+1);edges.appendChild(badge)});
        });
        svg.appendChild(edges);
        const nodes=mpSvg('g');
        routeNames.forEach(name=>{
          const pos=routePos.get(name);const entry=mapping[name]||{};const locked=name===protectedModel;
          const node=mpSvg('g');node.setAttribute('class','mp-node'+(locked?' mp-locked':''));node.setAttribute('data-route',name);
          const rect=mpSvg('rect');rect.setAttribute('x',String(leftX-238));rect.setAttribute('y',String(pos.y-19));rect.setAttribute('width','236');rect.setAttribute('height','38');rect.setAttribute('rx','9');rect.setAttribute('class','mp-node-rect');node.appendChild(rect);
          const t1=mpSvg('text');t1.setAttribute('x',String(leftX-222));t1.setAttribute('y',String(pos.y-3));t1.setAttribute('class','mp-node-title');t1.textContent=mpShort(name,26)+(locked?' · 已锁定':'');node.appendChild(t1);
          const t2=mpSvg('text');t2.setAttribute('x',String(leftX-222));t2.setAttribute('y',String(pos.y+12));t2.setAttribute('class','mp-node-sub');t2.textContent=mpShort((entry.label?entry.label+' · ':'')+(entry.model||''),34);node.appendChild(t2);
          node.addEventListener('click',()=>focusModelRouteRow(name));
          nodes.appendChild(node);
        });
        targets.concat(missing.map(key=>({__missing:key}))).forEach(t=>{
          const pos=targetPos.get(t.__missing||modelTargetKey(t));if(!pos)return;const state=t.__missing?'missing':(t.state||'unknown');
          const node=mpSvg('g');node.setAttribute('class','mp-node');
          const rect=mpSvg('rect');rect.setAttribute('x',String(rightX));rect.setAttribute('y',String(pos.y-19));rect.setAttribute('width','352');rect.setAttribute('height','38');rect.setAttribute('rx','9');rect.setAttribute('class','mp-node-rect'+(t.__missing?' mp-state-missing':''));node.appendChild(rect);
          const t1=mpSvg('text');t1.setAttribute('x',String(rightX+14));t1.setAttribute('y',String(pos.y-3));t1.setAttribute('class','mp-node-title');t1.textContent=mpShort(t.__missing?primaryKeyOf(t.__missing):(t.label||t.model),36);node.appendChild(t1);
          const t2=mpSvg('text');t2.setAttribute('x',String(rightX+14));t2.setAttribute('y',String(pos.y+12));t2.setAttribute('class','mp-node-sub');
          t2.textContent=t.__missing?'映射指向的目标未在健康数据中上报':mpShort(modelTargetKey(t)+(t.attempts!=null?' · 调用 '+fmt(t.attempts):'')+(t.successRate!=null?' · 成功 '+(Number(t.successRate)*100).toFixed(1)+'%':''),52);node.appendChild(t2);
          const dot=mpSvg('circle');dot.setAttribute('cx',String(rightX+334));dot.setAttribute('cy',String(pos.y));dot.setAttribute('r','5');dot.setAttribute('class','mp-state-dot mp-state-'+state);node.appendChild(dot);
          nodes.appendChild(node);
        });
        svg.appendChild(nodes);section.appendChild(svg);mount.appendChild(section);
      }
      function renderModelRouteEditor(mount,mapping,protectedModel){
        const section=make('section','panel model-pool-editor model-pool-routes');const head=make('div','section-head');const headCopy=make('div');add(headCopy,'h2','','路由权重与备用顺序');add(headCopy,'div','hint','权重 0-1000，备用顺序按优先级用逗号分隔；保存即写入网关。Agent 主路由锁定只读。');head.appendChild(headCopy);section.appendChild(head);
        const names=Object.keys(mapping);
        if(!names.length){add(section,'div','empty','网关未返回可编辑的模型映射');mount.appendChild(section);return}
        names.forEach(name=>{
          const entry=mapping[name]||{};const locked=name===protectedModel;
          const row=make('div','mp-route-row'+(locked?' locked':''));row.id='mp-route-'+modelRouteSlug(name);
          const info=make('div','mp-route-info');add(info,'strong','',name);let host=entry.baseUrl||'?';try{host=new URL(entry.baseUrl).host}catch{}add(info,'div','metric-source',(entry.label?entry.label+' · ':'')+(entry.model||'')+' @ '+host);row.appendChild(info);
          if(locked){const lockNote=make('div','mp-route-locked');add(lockNote,'span','model-pool-unused','Agent 主路由受保护');add(lockNote,'div','metric-source','如需调整请走配置变更流程');row.appendChild(lockNote);section.appendChild(row);return}
          const weightBox=make('div','mp-route-field');add(weightBox,'label','','权重');const weightInput=make('input');weightInput.type='number';weightInput.value=entry.weight==null?'':String(entry.weight);weightBox.appendChild(weightInput);row.appendChild(weightBox);
          const fbBox=make('div','mp-route-field grow');add(fbBox,'label','','备用顺序（逗号分隔，按优先级）');const fbInput=make('input');fbInput.type='text';fbInput.value=((entry.fallbacks||[]).map(v=>typeof v==='string'?v:(v&&v.ref)||'').filter(Boolean)).join(', ');fbBox.appendChild(fbInput);row.appendChild(fbBox);
          const saveBox=make('div','mp-route-field');add(saveBox,'label','','操作');const save=add(saveBox,'button','btn primary','保存');save.type='button';const feedback=add(saveBox,'span','feedback','');row.appendChild(saveBox);
          save.addEventListener('click',async()=>{
            const fallbacks=fbInput.value.split(',').map(v=>v.trim()).filter(Boolean);
            const weightText=weightInput.value.trim();const weight=weightText===''?undefined:Number(weightText);
            const dup=fallbacks.find((v,i)=>fallbacks.indexOf(v)!==i);
            if(dup){feedback.textContent='备用顺序里有重复项：'+dup;feedback.className='feedback bad';return}
            if(weight!=null&&(!Number.isFinite(weight)||weight<0||weight>1000)){feedback.textContent='权重需在 0-1000 之间';feedback.className='feedback bad';return}
            const unknown=fallbacks.filter(v=>!mapping[v]);
            if(unknown.length){feedback.textContent='以下备用名不在模型映射里，请核对：'+unknown.join('、');feedback.className='feedback bad';return}
            save.disabled=true;feedback.textContent='正在保存…';feedback.className='feedback';
            try{await request('/api/ops/observability/model-pool/routing',{method:'PUT',body:JSON.stringify({frontendModel:name,fallbacks:fallbacks,weight:weight})});toast('已更新 '+name+' 的路由');await loadModelPool()}
            catch(error){feedback.textContent='保存失败：'+friendlyError(error.message);feedback.className='feedback bad'}
            finally{save.disabled=false}
          });
          section.appendChild(row);
        });
        mount.appendChild(section);
      }
      function renderModelPool(){
        const root=$('modelPoolContent');if(!root)return;root.replaceChildren();
        if(!state.modelPool){add(root,'div','empty','正在读取模型池状态…');loadModelPool();return}
        const health=state.modelPool.health||{};const config=state.modelPool.config||{};const allTargets=health.targets||[];const summary=health.summary||{};const mapping=config.modelMapping||{};const protectedFrontendModel=state.modelPool.protectedFrontendModel||'';
        const cleanupTargets=allTargets.filter(modelCleanupCandidate);const filter=state.modelPoolFilter||'all';const targets=filter==='cleanup'?cleanupTargets:filter==='attention'?allTargets.filter(target=>target.state!=='healthy'):allTargets;
        const head=make('div','model-pool-toolbar');const copy=make('div');add(copy,'h2','','模型池');add(copy,'p','','常用操作直接在列表完成；路由权重与备用顺序在拓扑下方就地调整，替换与回滚收在高级操作。');head.appendChild(copy);const headActions=make('div','model-pool-actions');const refresh=add(headActions,'button','btn','刷新');refresh.type='button';refresh.addEventListener('click',()=>loadModelPool());if(cleanupTargets.length){const cleanAll=add(headActions,'button','btn danger','清理 '+cleanupTargets.length+' 个无用目标');cleanAll.type='button';cleanAll.addEventListener('click',async()=>{if(!window.confirm('确认清理 '+cleanupTargets.length+' 个没有路由引用的模型目标？此操作会从网关模型池移除目标。'))return;cleanAll.disabled=true;let count=0;for(const target of cleanupTargets){if(await cleanupModelTarget(target))count++}toast(count?'已清理 '+count+' 个模型目标':'没有模型被清理',Boolean(count));await loadModelPool()})}head.appendChild(headActions);root.appendChild(head);
        const cards=make('div','metrics model-pool-summary');[['目标总数',summary.totalTargets??allTargets.length,''],['健康',summary.healthy||0,'good'],['需关注',allTargets.filter(target=>target.state!=='healthy').length,allTargets.some(target=>target.state!=='healthy')?'bad':'good'],['可清理',cleanupTargets.length,cleanupTargets.length?'warn':'good']].forEach(item=>{const card=make('div','panel metric');add(card,'div','label',item[0]);add(card,'div','value '+item[2],item[1]);add(card,'div','detail',item[0]==='可清理'?'没有路由引用的目标':'Redis 状态同步');cards.appendChild(card)});root.appendChild(cards);
        renderModelTopology(root,mapping,allTargets,protectedFrontendModel);
        renderModelRouteEditor(root,mapping,protectedFrontendModel);
        const totalAttempts=targets.reduce((sum,target)=>sum+(Number(target.attempts)||0),0);
        const table=make('section','panel table-panel');const title=make('div','table-title');const titleCopy=make('div');add(titleCopy,'h2','','模型目标');add(titleCopy,'div','hint','调用类计数为网关累计口径（自进程启动），占比为该目标在当前列表总调用中的份额；清理按钮只会出现在没有任何路由引用的目标上。');title.appendChild(titleCopy);const filterSelect=make('select','model-pool-filter');[['all','全部目标'],['attention','仅看需关注'],['cleanup','仅看可清理']].forEach(item=>{const option=make('option','',item[1]);option.value=item[0];option.selected=item[0]===filter;filterSelect.appendChild(option)});filterSelect.addEventListener('change',event=>{state.modelPoolFilter=event.target.value;renderModelPool()});title.appendChild(filterSelect);table.appendChild(title);const scroll=make('div','scroll');const tableEl=make('table');const tr=make('tr');['目标','状态','调用与占比','成功率','并发','延迟 P95','路由用途','操作'].forEach(v=>add(tr,'th','',v));tableEl.appendChild(tr);if(!targets.length){const empty=make('tr');const cell=add(empty,'td','empty','没有符合筛选条件的目标');cell.colSpan=8;tableEl.appendChild(empty)}
        targets.forEach(target=>{
          const row=make('tr');
          const name=make('td');add(name,'strong','',target.label||target.model);add(name,'div','metric-source',target.model+' · '+target.baseUrl);if(target.credentialFingerprint)add(name,'div','metric-source','Key '+target.credentialFingerprint);row.appendChild(name);
          const stateCell=make('td');add(stateCell,'span','status-chip '+modelStateClass(target.state),modelStateName(target.state));if(target.lastHealthError)add(stateCell,'div','metric-source',target.lastHealthError);row.appendChild(stateCell);
          const calls=make('td');
          if(target.attempts==null){add(calls,'span','','—')}
          else{add(calls,'strong','',fmt(target.attempts)+' 次');const split=[];if(target.successes!=null)split.push('成功 '+fmt(target.successes));if(target.failures!=null)split.push('失败 '+fmt(target.failures));if(split.length)add(calls,'div','metric-source',split.join(' · '));const share=totalAttempts>0?(Number(target.attempts)/totalAttempts*100):0;const wrap=add(calls,'div','mp-bar');const fill=add(wrap,'i','mp-bar-fill');fill.style.width=Math.min(Math.max(share,0),100).toFixed(1)+'%'}
          row.appendChild(calls);
          const rate=make('td');
          if(target.successRate==null){add(rate,'span','','—')}
          else{const pct=Number(target.successRate)*100;add(rate,'strong','',pct.toFixed(1)+'%');const wrap=add(rate,'div','mp-bar');const fill=add(wrap,'i','mp-bar-fill '+(pct>=90?'mp-bar-good':(pct>=70?'mp-bar-warn':'mp-bar-bad')));fill.style.width=Math.min(Math.max(pct,0),100).toFixed(1)+'%'}
          row.appendChild(rate);
          const load=make('td');
          if(target.inFlight==null&&target.maxInFlight==null){add(load,'span','','—')}
          else{const cur=Number(target.inFlight)||0;const max=Number(target.maxInFlight)||0;add(load,'strong','',max?cur+' / '+max:String(cur));if(max){const wrap=add(load,'div','mp-bar');const fill=add(wrap,'i','mp-bar-fill'+(cur>=max?' mp-bar-bad':(cur*2>=max?' mp-bar-warn':'')));fill.style.width=Math.min(cur/max*100,100).toFixed(1)+'%'}}
          row.appendChild(load);
          add(row,'td','',target.latencyP95Ms==null?'—':fmt(target.latencyP95Ms)+' ms');
          const usage=make('td');const refs=(target.frontendModels||[]).filter(Boolean);if(refs.length)add(usage,'div','',refs.join('、'));else add(usage,'span','model-pool-unused','未被路由引用');if((target.roles||[]).length)add(usage,'div','metric-source',(target.roles||[]).join('、'));row.appendChild(usage);
          const action=make('td');
          if(modelCleanupCandidate(target)){const clean=add(action,'button','btn danger','清理');clean.type='button';clean.title='从网关移除没有路由引用的目标';clean.addEventListener('click',async()=>{if(!window.confirm('确认清理 '+(target.label||target.model)+'？此操作会从网关模型池移除目标。'))return;clean.disabled=true;if(await cleanupModelTarget(target)){toast('已清理 '+(target.label||target.model));await loadModelPool()}clean.disabled=false})}
          else{const probe=add(action,'button','btn','探测');probe.type='button';probe.addEventListener('click',async()=>{probe.disabled=true;probe.textContent='探测中…';try{await request('/api/ops/observability/model-pool/probe',{method:'POST',body:JSON.stringify({model:modelTargetName(target)})});toast('已完成 '+modelTargetName(target)+' 真实探测');await loadModelPool()}catch(error){toast('探测失败：'+friendlyError(error.message),false)}finally{probe.disabled=false;probe.textContent='探测'}})}
          row.appendChild(action);tableEl.appendChild(row)});
        scroll.appendChild(tableEl);table.appendChild(scroll);root.appendChild(table);
        const advanced=make('details','panel model-pool-editor model-pool-advanced');const advancedSummary=make('summary','model-pool-advanced-summary');add(advancedSummary,'strong','','高级操作');add(advancedSummary,'span','','替换目标、回滚快照');advanced.appendChild(advancedSummary);const advancedBody=make('div','model-pool-advanced-body');
        const editableModels=Object.keys(mapping).filter(k=>k!==protectedFrontendModel);
        const replace=make('section','model-pool-subsection');const replaceHead=make('div','section-head');const replaceBox=make('div');add(replaceBox,'h3','','替换模型目标');add(replaceBox,'div','hint','提交前会真实预探测新目标，失败不会写入网关；旧目标可从快照回滚。');replaceHead.appendChild(replaceBox);replace.appendChild(replaceHead);const replaceFields=make('div','fields');const replaceModel=selectField(replaceFields,'modelPoolReplace','要替换的映射',editableModels[0]||'',editableModels.map(k=>[k,k]));const replaceBase=field(replaceFields,'modelPoolBase','Base URL','','url');const replaceName=field(replaceFields,'modelPoolModel','上游模型','','text');const replaceLabel=field(replaceFields,'modelPoolLabel','展示名称','','text');const replaceKey=field(replaceFields,'modelPoolKey','API Key（仅本次提交）','','password',true);replace.appendChild(replaceFields);const replaceButton=add(replace,'button','btn','提交替换');replaceButton.type='button';replaceButton.addEventListener('click',async()=>{if(replaceModel.value===protectedFrontendModel){toast('Agent 主路由受保护，请替换具体备用映射',false);return}if(!replaceBase.value.startsWith('https://')||!replaceName.value.trim()||replaceKey.value.length<20){toast('请填写有效 HTTPS 地址、模型名和 Key',false);return}if(!window.confirm('确认替换 '+replaceModel.value+'？将先预探测新目标，通过后才写入网关配置。'))return;replaceButton.disabled=true;try{await request('/api/ops/observability/model-pool/replace',{method:'PUT',body:JSON.stringify({confirm:'REPLACE',frontendModel:replaceModel.value,target:{baseUrl:replaceBase.value.trim(),model:replaceName.value.trim(),label:replaceLabel.value.trim(),apiKey:replaceKey.value}})});replaceKey.value='';toast('模型目标已替换');await loadModelPool()}catch(error){const detail=error&&error.preflight?('预探测 '+(error.preflight.errorCategory||'失败')+' · HTTP '+(error.preflight.status==null?'—':error.preflight.status)+' · '+(error.preflight.elapsedMs||0)+'ms，未写入网关'):friendlyError(error.message);toast('替换失败：'+detail,false)}finally{replaceButton.disabled=false}});advancedBody.appendChild(replace);
        const rollback=make('section','model-pool-subsection');const rollbackHead=make('div','section-head');const rollbackBox=make('div');add(rollbackBox,'h3','','回滚最近一次替换');add(rollbackBox,'div','hint','快照不保存 Key，需要重新输入原目标 Key；回滚前同样会预探测。');rollbackHead.appendChild(rollbackBox);rollback.appendChild(rollbackHead);const rollbackFields=make('div','fields');const rollbackModel=selectField(rollbackFields,'modelPoolRollback','要回滚的映射',editableModels[0]||'',editableModels.map(k=>[k,k]));const rollbackKey=field(rollbackFields,'modelPoolRollbackKey','原目标 API Key（仅本次提交）','','password',true);rollback.appendChild(rollbackFields);const rollbackFeedback=add(rollback,'div','feedback','');rollbackFeedback.id='modelPoolRollbackFeedback';const rollbackButton=add(rollback,'button','btn','回滚到替换前目标');rollbackButton.type='button';rollbackButton.addEventListener('click',async()=>{if(!window.confirm('确认回滚 '+rollbackModel.value+' 到最近一次替换前的目标？'))return;rollbackButton.disabled=true;try{await request('/api/ops/observability/model-pool/rollback',{method:'POST',body:JSON.stringify({confirm:'ROLLBACK',frontendModel:rollbackModel.value,apiKey:rollbackKey.value})});rollbackKey.value='';setFeedback('modelPoolRollbackFeedback','已回滚',true);toast('已回滚到替换前目标');await loadModelPool()}catch(error){const detail=friendlyError(error.message);const snap=error&&error.snapshot&&error.snapshot.previous?('替换前快照：'+(error.snapshot.previous.model||'?')+' @ '+(error.snapshot.previous.baseUrl||'?')+'（'+(error.snapshot.occurredAt||'时间未知')+'）'):'没有可用的替换前快照';setFeedback('modelPoolRollbackFeedback','回滚未完成：'+detail+' · '+snap,false)}finally{rollbackButton.disabled=false}});advancedBody.appendChild(rollback);advanced.appendChild(advancedBody);root.appendChild(advanced);
      }
`;
