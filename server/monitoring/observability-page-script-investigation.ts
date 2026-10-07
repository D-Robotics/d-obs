/**
 * Evidence-driven investigation workspace. It only consumes the existing low-sensitivity
 * overview and the admin-gated single-event context endpoint; it never accepts arbitrary
 * queries, log commands, SQL, or external targets.
 */
export const OPS_OBSERVABILITY_SCRIPT_INVESTIGATION = `
      state.investigationQuery='';
      state.investigationOutcome='problem';
      state.investigationVersion='all';
      state.investigationErrorType='all';
      state.investigationComponent='all';
      state.investigationHours=24;
      state.investigationOverview=null;
      state.eventDetailReturnFocus=null;
      state.investigationLoading=false;
      state.investigationError='';
      state.investigationTrendExpanded=false;
      state.investigationEvidenceLimit=20;
      state.investigationRetryHours=24;

      function investigationEvents(o){return Array.isArray(o&&o.events)?o.events:[]}
      function investigationTrend(o){return Array.isArray(o&&o.trend)?o.trend:[]}
      function occurrenceCount(event){const raw=event&&event.metadata&&event.metadata.occurrence_count;const value=Number(raw);return Number.isFinite(value)&&value>0?value:1}
      function shortTime(value){if(!value)return '—';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '—';return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}
      function outcomeName(value){return value==='error'?'失败':(value==='degraded'?'降级':((value==='ok'||value==='completed')?'成功':((value==='partial'||value==='completed_partial')?'部分完成':(value==='cancelled'?'已取消':(value||'未知')))))}
      function severityName(value){const names={critical:'严重',error:'错误',warning:'警告',info:'提示'};return names[String(value||'').toLowerCase()]||String(value||'未知')}
      function detailDuration(value){const ms=Number(value);if(!Number.isFinite(ms)||ms<0)return String(value??'—');if(ms<1000)return Math.round(ms)+' ms';if(ms<60000)return (ms/1000).toFixed(ms<10000?1:0)+' s';return (ms/60000).toFixed(1)+' min'}
      function detailMetadataLabel(key){const labels={route:'请求路径',method:'请求方法',status:'HTTP 状态',status_code:'HTTP 状态',duration_ms:'耗时',code:'失败原因',error_code:'错误代码',partial_reason:'部分完成原因',operational:'业务可用',occurrence_count:'匹配次数',client_type:'客户端类型',channel:'渠道',app_version:'应用版本',release:'发布版本',tool_name:'工具',source:'来源',failure_category:'失败分类',error_category:'错误分类'};return labels[key]||key.replace(/_/g,' ')}
      function detailMetadataValue(key,value){if(value===null||value===undefined||value==='')return '—';if(key==='duration_ms'||key==='elapsed_ms')return detailDuration(value);if(key==='operational'){const flag=value===true||String(value).toLowerCase()==='true';return flag?'业务可用':'业务不可用'}if(key==='code'&&String(value)==='ssh_connect_timeout')return 'SSH 连接超时';if(key==='partial_reason'){const names={acceptance_audit:'验收审计',actuation_guard:'执行安全提醒',tool_intent_only:'仅表达工具意图',tool_loop_guard:'工具循环保护',unclassified:'未分类',max_tokens:'输出长度上限',length:'输出长度上限',timeout:'运行超时',aborted_by_user:'用户中止'};return names[String(value)]||String(value)}if((key==='status'||key==='status_code')&&Number.isFinite(Number(value)))return 'HTTP '+String(value);return String(value)}
      function detailHasValue(value){return value!==null&&value!==undefined&&String(value).trim()!==''}
      function isInvestigationProblem(event){return ['error','partial','degraded'].includes(event&&event.outcome)}
      function versionLabel(value){if(!value)return '';const version=String(value);return version.startsWith('v')?version:('v'+version)}
      function eventContextText(event){
        const context=event.context||{};
        const user=context.user&&(context.user.displayName||context.user.ref);
        const device=context.device&&(context.device.model||context.device.ref);
        return [user,eventVersion(event),eventErrorType(event),context.clientType,context.channel,device,context.runRef,context.sessionRef].filter(Boolean).join(' ');
      }
      function eventVersion(event){const context=event&&event.context||{};const metadata=event&&event.metadata||{};return versionLabel(context.appVersion||metadata.app_version||metadata.release)}
      function eventErrorType(event){const metadata=event&&event.metadata||{};return String(metadata.failure_category||metadata.error_category||metadata.error_name||metadata.error_code||metadata.code||event&&event.eventCode||'').trim()}
      function investigationErrorLabel(value){const names={device_timeout:'设备超时',auth:'认证失败',quota_exceeded:'额度超限',rate_limit:'请求限流',api:'API 错误',web:'Web 客户端错误',device_state:'设备状态',network:'网络错误',timeout:'运行超时',policy_denied:'策略拒绝',unknown:'未分类'};return names[String(value)]||String(value).replace(/_/g,' ')}
      function investigationFilterValues(o,resolver){const counts=new Map();investigationEvents(o).forEach(event=>{const value=String(resolver(event)||'').trim();if(value)counts.set(value,(counts.get(value)||0)+occurrenceCount(event))});return Array.from(counts.entries()).sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0],'zh-CN'))}
      function eventSearchText(event){
        const metadata=Object.entries(event.metadata||{}).map(item=>item[0]+' '+String(item[1])).join(' ');
        return [event.id,eventEvidenceId(event),event.component,event.eventCode,event.outcome,event.severity,event.summary,metadata,eventContextText(event)].filter(Boolean).join(' ').toLowerCase();
      }
      function eventEvidenceId(event){const explicit=String(event&&event.evidenceId||'').trim();if(explicit)return explicit;const id=String(event&&event.id||'').trim();return id?('event:'+id):''}
      async function copyEvidenceText(value){
        if(!value)return false;
        try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(value);return true}}catch{}
        const input=make('textarea');input.value=value;input.setAttribute('readonly','');input.style.position='fixed';input.style.opacity='0';input.style.pointerEvents='none';document.body.appendChild(input);input.select();input.setSelectionRange(0,value.length);let copied=false;try{copied=document.execCommand('copy')}catch{}input.remove();return copied;
      }
      async function copyOpsEventId(event,button){
        const evidenceId=eventEvidenceId(event);if(!evidenceId){toast('该事件暂无可用证据 ID',false);return}
        const original=button&&button.textContent;const copied=await copyEvidenceText(evidenceId);toast(copied?('已复制证据 ID：'+evidenceId):'复制失败，请在详情中手动选择 ID',copied);if(button&&button.isConnected){button.textContent=copied?'已复制':original;setTimeout(()=>{if(button.isConnected)button.textContent=original},1600)}
      }
      function filteredInvestigationEvents(o){
        const query=String(state.investigationQuery||'').trim().toLowerCase();
        return investigationEvents(o).filter(event=>(state.investigationOutcome==='all'||(state.investigationOutcome==='problem'&&isInvestigationProblem(event))||event.outcome===state.investigationOutcome)&&(!query||eventSearchText(event).includes(query))&&(state.investigationVersion==='all'||eventVersion(event)===state.investigationVersion)&&(state.investigationErrorType==='all'||eventErrorType(event)===state.investigationErrorType)&&(state.investigationComponent==='all'||String(event.component||'')===state.investigationComponent)&&investigationMatchesFocus(event)).sort((left,right)=>new Date(right.occurredAt||0).getTime()-new Date(left.occurredAt||0).getTime());
      }
      function groupInvestigationEvents(events,keyFor){
        const grouped=new Map();
        events.forEach(event=>{
          const key=String(keyFor(event)||'').trim();
          if(!key)return;
          const current=grouped.get(key)||{key,count:0,event};
          current.count+=occurrenceCount(event);
          if(new Date(event.occurredAt||0).getTime()>new Date(current.event.occurredAt||0).getTime())current.event=event;
          grouped.set(key,current);
        });
        return Array.from(grouped.values()).sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key,'zh-CN'));
      }
      function eventFailureKey(event){
        const metadata=event.metadata||{};
        const source=metadata.tool_name||metadata.source||event.component;
        const category=metadata.failure_category||metadata.error_category||metadata.code||metadata.error_code||metadata.error_name||event.eventCode;
        const resource=metadata.source==='resource_error'?metadata.route:null;
        return [source,category,resource].filter(Boolean).join(' · ');
      }
      function impactKey(event,type){
        const context=event.context||{};
        if(type==='version')return eventVersion(event);
        if(type==='user')return context.user&&(context.user.displayName||context.user.ref);
        if(type==='device')return context.device&&([context.device.model,context.device.ref].filter(Boolean).join(' · '));
        if(type==='client')return context.clientType;
        return event.component;
      }
      function investigationHypothesis(events){
        const failures=events.filter(isInvestigationProblem);
        if(!failures.length)return {status:'healthy',title:'当前筛选范围没有失败证据',detail:'可以扩大时间范围或清空筛选；系统不会在没有证据时生成根因结论。'};
        const versions=groupInvestigationEvents(failures,event=>impactKey(event,'version'));
        const components=groupInvestigationEvents(failures,event=>impactKey(event,'component'));
        const weighted=failures.reduce((sum,event)=>sum+occurrenceCount(event),0);
        if(versions[0]&&versions[0].count>=2&&versions[0].count/weighted>=0.6){
          return {status:'warning',title:'优先验证 '+versions[0].key+' 的变更影响',detail:'该版本覆盖 '+versions[0].count+' / '+weighted+' 个失败样本。先与其他版本对比同组件、同设备，再决定是否回滚。'};
        }
        if(components[0]&&components[0].count/weighted>=0.5){
          return {status:'warning',title:'优先检查 '+components[0].key+' 组件',detail:'该组件承载 '+components[0].count+' / '+weighted+' 个失败样本。打开代表事件，核对 run、工具序列和相邻对话证据。'};
        }
        return {status:'warning',title:'异常分布较分散，先按峰值时间对齐变更',detail:'没有单一版本或组件占据多数证据。建议从趋势峰值开始，逐项排除模型、工具、客户端与基础设施。'};
      }
      function createTrendSvg(o){
        const points=investigationTrend(o);
        const wrap=make('div');
        const ns='http://www.w3.org/2000/svg';
        const svg=document.createElementNS(ns,'svg');
        svg.setAttribute('class','trend-chart');
        svg.setAttribute('viewBox','0 0 760 174');
        svg.setAttribute('role','img');
        svg.setAttribute('aria-label','最近窗口失败信号堆叠趋势');
        const series=[['aiErrors','#ef4444','AI 失败'],['toolFailures','#f97316','工具失败'],['clientErrors','#0ea5e9','客户端错误'],['apiErrors','#a855f7','API 5xx'],['loginErrors','#eab308','登录基础设施']];
        const totals=points.map(point=>series.reduce((sum,item)=>sum+Number(point[item[0]]||0),0));
        const maximum=Math.max(1,...totals);
        [0,1,2,3].forEach(index=>{
          const y=15+index*42;
          const line=document.createElementNS(ns,'line');
          line.setAttribute('x1','38');line.setAttribute('x2','748');line.setAttribute('y1',String(y));line.setAttribute('y2',String(y));line.setAttribute('stroke','#dfe5e3');line.setAttribute('stroke-width','1');
          svg.appendChild(line);
        });
        if(!points.length){
          const label=document.createElementNS(ns,'text');label.setAttribute('x','380');label.setAttribute('y','88');label.setAttribute('text-anchor','middle');label.setAttribute('fill','#7a8481');label.setAttribute('font-size','11');label.textContent='当前窗口暂无趋势数据';svg.appendChild(label);wrap.appendChild(svg);return wrap;
        }
        const usable=704;const gap=points.length>48?1:2;const width=Math.max(2,usable/points.length-gap);
        points.forEach((point,index)=>{
          const x=40+index*(usable/points.length);let bottom=151;
          series.forEach(item=>{
            const value=Number(point[item[0]]||0);if(!value)return;
            const height=Math.max(2,value/maximum*126);
            const rect=document.createElementNS(ns,'rect');
            rect.setAttribute('x',String(x));rect.setAttribute('y',String(bottom-height));rect.setAttribute('width',String(width));rect.setAttribute('height',String(height));rect.setAttribute('fill',item[1]);rect.setAttribute('rx','1');
            const title=document.createElementNS(ns,'title');title.textContent=when(point.bucket)+' · '+item[2]+' '+value;rect.appendChild(title);svg.appendChild(rect);bottom-=height;
          });
        });
        const first=document.createElementNS(ns,'text');first.setAttribute('x','40');first.setAttribute('y','168');first.setAttribute('fill','#7a8481');first.setAttribute('font-size','9');first.textContent=shortTime(points[0].bucket);svg.appendChild(first);
        const last=document.createElementNS(ns,'text');last.setAttribute('x','748');last.setAttribute('y','168');last.setAttribute('text-anchor','end');last.setAttribute('fill','#7a8481');last.setAttribute('font-size','9');last.textContent=shortTime(points[points.length-1].bucket);svg.appendChild(last);
        wrap.appendChild(svg);
        const legend=make('div','trend-legend');legend.setAttribute('role','list');series.forEach(item=>{const node=make('span');node.setAttribute('role','listitem');const dot=make('i');dot.style.background=item[1];dot.setAttribute('aria-hidden','true');node.appendChild(dot);node.appendChild(document.createTextNode(item[2]));legend.appendChild(node)});wrap.appendChild(legend);
        const tableDetails=make('details','trend-data-table');const tableSummary=make('summary','btn','查看趋势数据表');tableSummary.setAttribute('aria-label','查看失败信号趋势数据表');tableDetails.appendChild(tableSummary);const table=make('table');table.className='data-table';const head=make('thead');const headRow=make('tr');['时间',...series.map(item=>item[2])].forEach(label=>add(headRow,'th','',label));head.appendChild(headRow);table.appendChild(head);const body=make('tbody');points.forEach(point=>{const row=make('tr');add(row,'td','',when(point.bucket));series.forEach(item=>add(row,'td','',String(Number(point[item[0]]||0))));body.appendChild(row)});table.appendChild(body);tableDetails.appendChild(table);wrap.appendChild(tableDetails);
        return wrap;
      }
      function renderInvestigationStats(root,events,o){
        const failures=events.filter(isInvestigationProblem);
        const users=new Set(failures.map(event=>impactKey(event,'user')).filter(Boolean));
        const devices=new Set(failures.map(event=>impactKey(event,'device')).filter(Boolean));
        const versions=new Set(events.map(event=>impactKey(event,'version')).filter(Boolean));
        const contextReady=events.filter(event=>event.context&&event.context.detailsAvailable).length;
        const grid=make('div','investigation-summary');
        [['筛选事件',events.length,'最近 '+(o.windowHours||state.investigationHours)+' 小时'],['失败样本',failures.reduce((sum,event)=>sum+occurrenceCount(event),0),failures.length+' 条代表事件'],['影响用户',users.size,'脱敏用户引用'],['影响设备',devices.size,'设备型号或引用'],['证据完整度',events.length?Math.round(contextReady/events.length*100)+'%':'—',versions.size+' 个应用版本']].forEach(item=>{const card=make('div','panel investigation-stat');add(card,'span','',item[0]);add(card,'strong','',item[1]);add(card,'small','',item[2]);grid.appendChild(card)});
        root.appendChild(grid);
      }
      function renderTrendPanel(root,o){
        const panel=make('details','panel investigation-trend');panel.open=Boolean(state.investigationTrendExpanded);
        const points=investigationTrend(o);const totals=points.map(point=>Number(point.aiErrors||0)+Number(point.toolFailures||0)+Number(point.clientErrors||0)+Number(point.apiErrors||0)+Number(point.loginErrors||0));const peak=Math.max(0,...totals);const peakIndex=totals.indexOf(peak);
        const summary=make('summary','trend-summary');const summaryCopy=make('div');add(summaryCopy,'strong','','多信号失败趋势');add(summaryCopy,'span','',peak?('窗口峰值 '+peak+' · '+when(points[peakIndex]&&points[peakIndex].bucket)):'窗口内无失败峰值');summary.appendChild(summaryCopy);add(summary,'span','trend-toggle',panel.open?'收起趋势':'展开趋势');panel.appendChild(summary);
        const body=make('div','trend-body');const head=make('div','trend-head');const title=make('div');add(title,'h3','','失败信号按时间对齐');add(title,'p','','全量趋势不受关键词和结果筛选影响，可用于对齐发布和故障峰值。');head.appendChild(title);renderInvestigationTrendActions(head,o,peak,peakIndex);body.appendChild(head);body.appendChild(createTrendSvg(o));panel.appendChild(body);
        panel.addEventListener('toggle',()=>{state.investigationTrendExpanded=panel.open;const toggle=panel.querySelector('.trend-toggle');if(toggle)toggle.textContent=panel.open?'收起趋势':'展开趋势'});root.appendChild(panel);
      }
      function eventContextChips(event){
        const box=make('div','context-chips');const context=event.context||{};
        const values=[eventVersion(event),isInvestigationProblem(event)&&investigationErrorLabel(eventErrorType(event)),context.user&&(context.user.displayName||context.user.ref),context.clientType,context.device&&(context.device.model||context.device.ref),context.runRef];
        values.filter(Boolean).slice(0,5).forEach(value=>add(box,'span','context-chip',value));
        return box;
      }
      function renderEvidenceList(panel,events,o){
        const list=make('div','evidence-list');
        if(!events.length){const empty=make('div','investigation-empty');add(empty,'strong','','当前条件没有匹配证据');add(empty,'p','',hasCustomInvestigationView()?'搜索、结果或聚焦条件可能过窄，可一键恢复系统推荐视图。':'该时间窗口暂无异常事件，可扩大到 7 天继续核对。');const actions=make('div','empty-actions');if(hasCustomInvestigationView()){const restore=add(actions,'button','btn primary','恢复推荐视图');restore.type='button';restore.addEventListener('click',()=>restoreRecommendedInvestigation(o))}if(state.investigationHours!==168){const widen=add(actions,'button','btn','查看最近 7 天');widen.type='button';widen.addEventListener('click',()=>loadInvestigationWindow(168,widen))}empty.appendChild(actions);list.appendChild(empty);panel.appendChild(list);return}
        const visible=Math.min(events.length,Math.max(20,Number(state.investigationEvidenceLimit)||20));events.slice(0,visible).forEach(event=>{
          const row=make('article','evidence-row '+(event.outcome||''));
          const timeBox=make('div','evidence-time');add(timeBox,'strong','',shortTime(event.occurredAt));add(timeBox,'span','',new Date(event.occurredAt||0).toLocaleDateString('zh-CN'));row.appendChild(timeBox);
          const copy=make('div','evidence-copy');const title=make('div','evidence-title');add(title,'strong','',event.component+' · '+event.eventCode);add(title,'span','status-chip',outcomeName(event.outcome));copy.appendChild(title);add(copy,'div','evidence-summary',event.summary||'暂无摘要');copy.appendChild(eventContextChips(event));const identity=make('div','evidence-id-line');add(identity,'code','evidence-id-value',eventEvidenceId(event));const copyId=add(identity,'button','copy-evidence-id','复制 ID');copyId.type='button';copyId.setAttribute('aria-label','复制证据 ID '+eventEvidenceId(event));copyId.addEventListener('click',()=>copyOpsEventId(event,copyId));copy.appendChild(identity);row.appendChild(copy);
          const button=add(row,'button','btn','查看证据');button.type='button';button.addEventListener('click',()=>openOpsEventDetail(event));row.appendChild(button);list.appendChild(row);
        });
        if(visible<events.length){const more=make('div','evidence-more');add(more,'span','', '已显示 '+visible+' / '+events.length+' 条');const button=add(more,'button','btn','再显示 '+Math.min(20,events.length-visible)+' 条');button.type='button';button.addEventListener('click',()=>{state.investigationEvidenceLimit=visible+20;updateInvestigationResults(o)});more.appendChild(button);list.appendChild(more)}
        panel.appendChild(list);
      }
      function renderClusters(panel,events){
        const failures=events.filter(isInvestigationProblem);
        const groups=groupInvestigationEvents(failures,event=>eventFailureKey(event)).slice(0,5);
        const list=make('div','cluster-list');
        if(!groups.length){list.appendChild(make('div','empty','当前筛选范围没有失败聚类'));panel.appendChild(list);return}
        groups.forEach(group=>{const row=make('button','cluster-row');row.type='button';row.setAttribute('aria-label','查看失败聚类代表事件：'+group.key);const copy=make('div');add(copy,'strong','',group.key);add(copy,'span','',group.event.summary||'代表样本');row.appendChild(copy);add(row,'span','cluster-count',group.count);row.addEventListener('click',()=>openOpsEventDetail(group.event));list.appendChild(row)});panel.appendChild(list);
      }
      function renderImpactFacets(panel,events,o){
        [['version','版本'],['component','组件'],['user','用户'],['device','设备']].forEach(item=>{
          const group=make('details','facet-group');const summary=make('summary','facet-summary');add(summary,'strong','',item[1]+'影响面');const values=groupInvestigationEvents(events,event=>impactKey(event,item[0])).slice(0,4);add(summary,'span','',values.length?values.length+' 个维度':'暂无');group.appendChild(summary);const list=make('div','facet-list');
          if(!values.length)add(list,'div','hint','未关联'+item[1]+'证据');else values.forEach(value=>{const row=make('button','facet-row clickable');row.type='button';row.setAttribute('aria-label','聚焦'+item[1]+'：'+value.key);add(row,'strong','',value.key);add(row,'span','',value.count+' 条');row.addEventListener('click',()=>applyInvestigationFocus({kind:item[0],value:value.key,label:item[1]+' '+value.key},o));list.appendChild(row)});group.appendChild(list);panel.appendChild(group);
        });
      }
      function updateInvestigationResults(o){
        const root=$('investigationResults');if(!root)return;root.replaceChildren();const events=filteredInvestigationEvents(o);renderInvestigationGuide(root,events,o);renderInvestigationStats(root,events,o);
        const grid=make('div','investigation-grid');
        const evidence=make('section','panel evidence-panel');const evidenceHead=make('div','section-head');const evidenceTitle=make('div');add(evidenceTitle,'h2','','事件证据流');add(evidenceTitle,'div','hint','按时间倒序；用户、设备、版本和 run 均为低敏摘要或不可逆引用。');evidenceHead.appendChild(evidenceTitle);const resultCount=add(evidenceHead,'div','right',events.length+' 条匹配');resultCount.setAttribute('role','status');resultCount.setAttribute('aria-live','polite');evidence.appendChild(evidenceHead);renderEvidenceList(evidence,events,o);grid.appendChild(evidence);
        const sideStack=make('div','investigation-side-stack');const hypothesis=investigationHypothesis(events);const hypothesisPanel=make('section','panel investigation-side');const hypothesisBox=make('div','hypothesis '+hypothesis.status);add(hypothesisBox,'strong','',hypothesis.title);add(hypothesisBox,'p','',hypothesis.detail);add(hypothesisBox,'small','','可证伪假设，不是自动根因结论');hypothesisPanel.appendChild(hypothesisBox);sideStack.appendChild(hypothesisPanel);
        const clusterPanel=make('details','panel investigation-side investigation-disclosure');const clusterSummary=make('summary','investigation-disclosure-summary');add(clusterSummary,'strong','','失败聚类');add(clusterSummary,'span','', '按组件、工具和错误分类归并');clusterPanel.appendChild(clusterSummary);renderClusters(clusterPanel,events);sideStack.appendChild(clusterPanel);
        const impactPanel=make('details','panel investigation-side investigation-disclosure');const impactSummary=make('summary','investigation-disclosure-summary');add(impactSummary,'strong','','异常影响范围');add(impactSummary,'span','', '点击维度即可聚焦，再用 Esc 恢复推荐视图');impactPanel.appendChild(impactSummary);renderImpactFacets(impactPanel,events.filter(isInvestigationProblem),o);sideStack.appendChild(impactPanel);grid.appendChild(sideStack);root.appendChild(grid);renderTrendPanel(root,o);
      }
      function updateIncidentNavigationCount(o){
        const incidents=Array.isArray(o&&o.incidents)?o.incidents:[];const active=incidents.filter(item=>['open','acknowledged','silenced'].includes(item.status));
        const badge=$('incidentCount');if(badge){badge.textContent=String(active.length);badge.hidden=active.length===0;badge.title=active.length+' 个进行中事故';const button=badge.closest('[data-view="investigate"]');if(button)button.setAttribute('aria-label',active.length?('事故调查，'+active.length+' 个进行中事故'):'事故调查，当前无进行中事故')}
        if(typeof setNavGroupAlerts==='function')setNavGroupAlerts(o)
      }
      function renderInvestigationStatus(toolbar,o){
        if(!state.investigationLoading&&!state.investigationError)return;
        const status=make('div','investigation-status '+(state.investigationError?'error':'loading'));status.setAttribute('role',state.investigationError?'alert':'status');status.setAttribute('aria-live','polite');
        add(status,'span','',state.investigationError?('调查数据加载失败：'+state.investigationError):'正在切换调查时间窗口…');
        if(state.investigationError){const retry=add(status,'button','btn','重试');retry.type='button';retry.addEventListener('click',()=>loadInvestigationWindow(state.investigationRetryHours,retry))}toolbar.appendChild(status);
      }
      function addInvestigationSelect(parent,o,stateKey,labelText,allText,resolver,formatValue){
        const control=make('label','filter-select-control');add(control,'span','filter-label',labelText);const select=make('select','investigation-select');select.setAttribute('aria-label',labelText);const all=make('option','',allText);all.value='all';select.appendChild(all);investigationFilterValues(o,resolver).forEach(item=>{const option=make('option','',formatValue(item[0])+' · '+item[1]);option.value=item[0];option.selected=item[0]===state[stateKey];select.appendChild(option)});if(state[stateKey]==='all')all.selected=true;select.disabled=state.investigationLoading;select.addEventListener('change',()=>{state[stateKey]=select.value;state.investigationEvidenceLimit=20;updateInvestigationResults(o);renderInvestigationHelper(parent.parentElement,o)});control.appendChild(select);parent.appendChild(control);return select;
      }
      function renderInvestigation(o){
        const root=$('investigationContent');if(!root||!o)return;root.replaceChildren();updateIncidentNavigationCount(state.overview||o);root.setAttribute('aria-busy',String(Boolean(state.investigationLoading)));
        const toolbar=make('section','panel investigation-toolbar');toolbar.setAttribute('aria-label','调查筛选');
        const primaryRow=make('div','investigation-filter-row investigation-filter-row-primary');
        const searchWrap=make('label','search-wrap');add(searchWrap,'span','filter-label','搜索证据');const search=make('input','search');search.id='investigationSearch';search.type='search';search.placeholder='组件、版本、错误码、设备或 run';search.value=state.investigationQuery;search.autocomplete='off';search.disabled=state.investigationLoading;search.setAttribute('aria-label','搜索证据');searchWrap.appendChild(search);primaryRow.appendChild(searchWrap);
        const outcomeWrap=make('div','filter-control');add(outcomeWrap,'span','filter-label','结果');const outcome=make('div','segmented');outcome.setAttribute('role','group');outcome.setAttribute('aria-label','事件结果');[['all','全部'],['problem','异常'],['ok','成功']].forEach(item=>{const active=state.investigationOutcome===item[0];const button=add(outcome,'button',active?'active':'',item[1]);button.type='button';button.setAttribute('aria-pressed',String(active));button.disabled=state.investigationLoading;button.addEventListener('click',()=>{state.investigationOutcome=item[0];state.investigationEvidenceLimit=20;updateInvestigationResults(o);renderInvestigationHelper(toolbar,o)})});outcomeWrap.appendChild(outcome);primaryRow.appendChild(outcomeWrap);
        const windowWrap=make('div','filter-control');add(windowWrap,'span','filter-label','时间范围');const windows=make('div','window-switch');windows.setAttribute('role','group');windows.setAttribute('aria-label','调查时间窗口');[[1,'1 小时'],[24,'24 小时'],[168,'7 天']].forEach(item=>{const active=state.investigationHours===item[0];const button=add(windows,'button',active?'active':'',item[1]);button.type='button';button.setAttribute('aria-pressed',String(active));button.disabled=state.investigationLoading;button.addEventListener('click',()=>loadInvestigationWindow(item[0],button));windows.appendChild(button)});windowWrap.appendChild(windows);primaryRow.appendChild(windowWrap);toolbar.appendChild(primaryRow);
        const advancedRow=make('div','investigation-filter-row investigation-filter-row-advanced');addInvestigationSelect(advancedRow,o,'investigationVersion','应用版本','全部版本',event=>eventVersion(event),value=>value);addInvestigationSelect(advancedRow,o,'investigationErrorType','错误类型','全部错误类型',event=>isInvestigationProblem(event)&&eventErrorType(event),value=>investigationErrorLabel(value));addInvestigationSelect(advancedRow,o,'investigationComponent','组件','全部组件',event=>event.component,value=>value);const clear=add(advancedRow,'button','btn filter-clear-action','清除筛选');clear.type='button';clear.disabled=!hasCustomInvestigationView();clear.addEventListener('click',()=>restoreRecommendedInvestigation(o));toolbar.appendChild(advancedRow);
        renderInvestigationHelper(toolbar,o);renderInvestigationStatus(toolbar,o);root.appendChild(toolbar);root.appendChild(renderAiCopilotPanel(o));const results=make('div','overview-stack');results.id='investigationResults';root.appendChild(results);search.addEventListener('input',event=>{state.investigationQuery=event.target.value;state.investigationEvidenceLimit=20;updateInvestigationResults(o);renderInvestigationHelper(toolbar,o)});updateInvestigationResults(o);
      }
      function renderInvestigationLegacy(o){
        const root=$('investigationContent');if(!root||!o)return;root.replaceChildren();updateIncidentNavigationCount(state.overview||o);
        root.setAttribute('aria-busy',String(Boolean(state.investigationLoading)));const toolbar=make('section','panel investigation-toolbar');toolbar.setAttribute('aria-label','调查筛选');const searchWrap=make('label','search-wrap');add(searchWrap,'span','filter-label','搜索证据');const search=make('input','search');search.id='investigationSearch';search.type='search';search.placeholder='按 / 搜索组件、版本、设备或 run';search.value=state.investigationQuery;search.autocomplete='off';search.disabled=state.investigationLoading;searchWrap.appendChild(search);toolbar.appendChild(searchWrap);
        const outcomeWrap=make('div','filter-control');add(outcomeWrap,'span','filter-label','结果');const outcome=make('div','segmented');outcome.setAttribute('role','group');outcome.setAttribute('aria-label','事件结果');[['all','全部'],['problem','异常'],['ok','成功']].forEach(item=>{const active=state.investigationOutcome===item[0];const button=add(outcome,'button',active?'active':'',item[1]);button.type='button';button.setAttribute('aria-pressed',String(active));button.disabled=state.investigationLoading;button.addEventListener('click',()=>{state.investigationOutcome=item[0];state.investigationEvidenceLimit=20;outcome.querySelectorAll('button').forEach(node=>{node.classList.toggle('active',node===button);node.setAttribute('aria-pressed',String(node===button))});updateInvestigationResults(o);renderInvestigationHelper(toolbar,o)})});outcomeWrap.appendChild(outcome);toolbar.appendChild(outcomeWrap);
        const windowWrap=make('div','filter-control');add(windowWrap,'span','filter-label','时间');const windows=make('div','window-switch');windows.setAttribute('role','group');windows.setAttribute('aria-label','调查时间窗口');[[1,'1 小时'],[24,'24 小时'],[168,'7 天']].forEach(item=>{const active=state.investigationHours===item[0];const button=add(windows,'button',active?'active':'',item[1]);button.type='button';button.setAttribute('aria-pressed',String(active));button.disabled=state.investigationLoading;button.addEventListener('click',()=>loadInvestigationWindow(item[0],button));windows.appendChild(button)});windowWrap.appendChild(windows);toolbar.appendChild(windowWrap);renderInvestigationHelper(toolbar,o);renderInvestigationStatus(toolbar,o);root.appendChild(toolbar);root.appendChild(renderAiCopilotPanel(o));
        const results=make('div','overview-stack');results.id='investigationResults';root.appendChild(results);search.addEventListener('input',event=>{state.investigationQuery=event.target.value;state.investigationEvidenceLimit=20;updateInvestigationResults(o);renderInvestigationHelper(toolbar,o)});updateInvestigationResults(o);
      }
      async function loadInvestigationWindow(hours,button){
        if(state.investigationLoading)return;const previous=state.investigationOverview||state.overview;state.investigationRetryHours=hours;state.investigationLoading=true;state.investigationError='';renderInvestigation(previous);
        try{const data=await request('/api/ops/observability/overview?hours='+hours);state.investigationHours=hours;state.investigationOverview=data.overview;state.investigationEvidenceLimit=20;state.investigationLoading=false;renderInvestigation(data.overview);toast('调查窗口已切换为最近 '+(hours===168?'7 天':hours+' 小时'))}catch(error){state.investigationLoading=false;state.investigationError=friendlyError(error.message);renderInvestigation(previous);toast('切换调查窗口失败：'+state.investigationError,false)}
      }
      function renderInvestigationBridge(o){
        const events=investigationEvents(o);const failures=events.filter(isInvestigationProblem);const detailed=events.filter(event=>event.context&&event.context.detailsAvailable).length;
        const panel=make('section','panel investigation-bridge');add(panel,'div','investigation-bridge-icon','⌕');const copy=make('div','investigation-bridge-copy');add(copy,'strong','','跨信号调查工作台');add(copy,'span','',failures.reduce((sum,event)=>sum+occurrenceCount(event),0)+' 个失败样本 · '+(events.length?Math.round(detailed/events.length*100):0)+'% 事件可下钻上下文 · 趋势、聚类与影响面已对齐');panel.appendChild(copy);overviewActionButton(panel,'一键开始调查 →','investigate',{outcome:'problem'},Boolean(failures.length));return panel;
      }
      // 上下文 GET（事件详情 / 链路详情 / 行动列表）既要 ops 会话鉴权，又要
      // observability-context 守卫头。必须复用 apiHeaders：自带 headers 会把主站
      // 会话、运营令牌、租户令牌整个替换掉，服务端只认守卫头随后就 403。
      function contextRequestHeaders(){return Object.assign({},apiHeaders(false),{'X-RDK-Ops-Action':'observability-context'})}
      function closeOpsEventDetail(){const drawer=$('eventDrawer');drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');drawer.removeAttribute('aria-busy');document.body.style.overflow='';$('copyEventId').disabled=true;$('eventDrawerMeta').replaceChildren();if(state.eventDetailReturnFocus&&state.eventDetailReturnFocus.isConnected)state.eventDetailReturnFocus.focus();state.eventDetailReturnFocus=null;state.activeDetailEvent=null}
      function detailFact(parent,label,value,className){const fact=make('div','evidence-fact'+(className?' '+className:''));add(fact,'span','',label);add(fact,'strong','',value===undefined||value===null||value===''?'—':value);parent.appendChild(fact);return fact}
      function optionalDetailFact(parent,label,value,className){return detailHasValue(value)?detailFact(parent,label,value,className):null}
      function detailTone(value){const normalized=String(value||'').toLowerCase();return normalized==='critical'||normalized==='error'?'critical':(normalized==='warning'||normalized==='degraded'||normalized==='partial'?'warning':'info')}
      function eventDrawerMeta(detail){const meta=$('eventDrawerMeta');if(!meta)return;meta.replaceChildren();const metadata=detail.event.metadata||{};const chips=[[outcomeName(detail.event.outcome),detailTone(detail.event.outcome)],[severityName(detail.event.severity),'severity-'+detailTone(detail.event.severity)]];const status=metadata.status??metadata.status_code;if(detailHasValue(status))chips.push([detailMetadataValue('status',status),'http-status']);chips.forEach(item=>add(meta,'span','event-drawer-chip '+item[1],item[0]))}
      function renderEventFacts(detail){const section=make('section','panel evidence-section event-facts-section');const head=make('div','event-section-head');const title=make('div');add(title,'h3','','事件摘要');add(title,'p','',detail.event.summary||'暂无摘要');head.appendChild(title);section.appendChild(head);const facts=make('div','evidence-facts event-core-facts');detailFact(facts,'证据 ID',eventEvidenceId(detail.event),'evidence-fact-id');detailFact(facts,'发生时间',when(detail.event.occurredAt));detailFact(facts,'结果',outcomeName(detail.event.outcome),'fact-'+detailTone(detail.event.outcome));optionalDetailFact(facts,'严重度',severityName(detail.event.severity),'fact-'+detailTone(detail.event.severity));const context=detail.context||{};const user=context.user&&(context.user.displayName||context.user.ref);const client=[context.clientType,versionLabel(context.appVersion),context.channel].filter(Boolean).join(' · ');const device=context.device&&([context.device.model,context.device.ref].filter(Boolean).join(' · '));optionalDetailFact(facts,'用户',user);optionalDetailFact(facts,'客户端 / 版本',client);optionalDetailFact(facts,'设备',device);section.appendChild(facts);return section}
      function renderEventMetadata(detail){const entries=Object.entries(detail.event.metadata||{}).filter(item=>detailHasValue(item[1]));if(!entries.length)return null;const section=make('details','panel evidence-section event-metadata-disclosure');const summary=make('summary','event-section-summary');add(summary,'strong','','请求与运行证据');add(summary,'span','',entries.length+' 个字段');section.appendChild(summary);const grid=make('div','metadata-grid event-request-facts');entries.forEach(item=>{const node=make('div','metadata-item');add(node,'span','',detailMetadataLabel(item[0]));add(node,'strong','',detailMetadataValue(item[0],item[1]));if(['code','error_code','status','status_code'].includes(item[0]))add(node,'code','metadata-raw',item[0]+'='+String(item[1]));grid.appendChild(node)});section.appendChild(grid);section.setAttribute('open','');return section}
      function renderEventContext(detail){const context=detail.context||{};const contextFacts=[];if(context.sessionRef)contextFacts.push(['会话引用',context.sessionRef]);if(context.runRef)contextFacts.push(['Run 引用',context.runRef]);if(context.clientType&&!context.appVersion&&!context.channel)contextFacts.push(['客户端类型',context.clientType]);if(!contextFacts.length)return null;const section=make('details','panel evidence-section event-context-disclosure');const summary=make('summary','event-section-summary');add(summary,'strong','','关联上下文');add(summary,'span','',contextFacts.length+' 个引用');section.appendChild(summary);const grid=make('div','metadata-grid');contextFacts.forEach(item=>{const node=make('div','metadata-item');add(node,'span','',item[0]);add(node,'strong','',item[1]);grid.appendChild(node)});section.appendChild(grid);section.removeAttribute('open');return section}
      function detailTraceRows(spans){const byId=new Map(spans.map(span=>[span.spanId,span]));const children=new Map();spans.forEach(span=>{const parent=span.parentSpanId&&byId.has(span.parentSpanId)?span.parentSpanId:null;const list=children.get(parent)||[];list.push(span);children.set(parent,list)});children.forEach(list=>list.sort((a,b)=>Number(a.startTime)-Number(b.startTime)));const rows=[];const walk=(parent,depth)=>{(children.get(parent)||[]).forEach(span=>{rows.push({span,depth:Math.min(depth,6)});walk(span.spanId,depth+1)})};walk(null,0);const seen=new Set(rows.map(row=>row.span.spanId));spans.forEach(span=>{if(!seen.has(span.spanId))rows.push({span,depth:0})});return rows}
      function detailTraceLabel(span){if(span.name==='studio.agent_chat')return 'client · agent chat';if(span.name==='http.client')return 'client · HTTP';if(span.name==='moss.tool.invoke')return 'tool · '+String((span.attributes||{}).toolName||'unknown');if(span.name==='moss.llm.request')return 'llm request';if(span.name==='moss.agent.turn')return 'turn '+String((span.attributes||{}).turn||'');return String(span.name||'span').replace(/^moss\\./,'')}
      function renderDetailTrace(detail){const spans=Array.isArray(detail.trace)?detail.trace:[];if(!spans.length)return null;const section=make('section','event-associated-block event-trace-block');add(section,'h3','','客户端 → 服务端链路');add(section,'p','',spans.length+' 个低敏 span；绿色为客户端，紫色为模型，橙色为工具，红色为失败。');const start=Math.min(...spans.map(span=>Number(span.startTime)||0));const end=Math.max(...spans.map(span=>Number(span.endTime)||0));const total=Math.max(1,end-start);const list=make('div','trace-span-list');list.style.display='grid';list.style.gap='6px';detailTraceRows(spans).forEach(row=>{const span=row.span;const duration=Math.max(0,Number(span.endTime)-Number(span.startTime));const line=make('div','trace-span-row');line.style.display='grid';line.style.gridTemplateColumns='minmax(120px,190px) 58px 1fr';line.style.gap='8px';line.style.alignItems='center';line.style.fontSize='11px';const label=add(line,'span','',detailTraceLabel(span));label.style.paddingLeft=(row.depth*12)+'px';label.style.overflow='hidden';label.style.textOverflow='ellipsis';label.style.whiteSpace='nowrap';if(span.status==='error')label.style.color='#dc2626';add(line,'span','',detailDuration(duration));const track=make('span','trace-span-track');const bar=make('i');bar.style.left=(Math.max(0,(Number(span.startTime)-start)/total*100))+'%';bar.style.width=(Math.max(.5,duration/total*100))+'%';bar.style.background=span.status==='error'?'#dc2626':(span.source==='client'?'#0f9f8f':(span.name==='moss.tool.invoke'?'#d97706':(span.name==='moss.llm.request'?'#6366f1':'#64748b')));track.appendChild(bar);line.appendChild(track);list.appendChild(line)});section.appendChild(list);return section}
      function renderRunEvidence(detail){if(!detail.run)return null;const section=make('section','event-associated-block event-run-block');add(section,'h3','','Run 与工具证据');add(section,'p','',[detail.run.ref,detail.run.model,detail.run.outcome].filter(Boolean).join(' · ')||'已关联 Agent run');const runFacts=make('div','evidence-facts');detailFact(runFacts,'耗时',detail.run.elapsedMs?detailDuration(detail.run.elapsedMs):'—');detailFact(runFacts,'工具调用',detail.run.toolCallCount);detailFact(runFacts,'重试次数',detail.run.retryCount);optionalDetailFact(runFacts,'错误分类',detail.run.errorCategory);optionalDetailFact(runFacts,'部分完成原因',detail.run.partialReason&&detailMetadataValue('partial_reason',detail.run.partialReason));optionalDetailFact(runFacts,'开始',when(detail.run.startedAt));optionalDetailFact(runFacts,'完成',when(detail.run.completedAt));section.appendChild(runFacts);if(detail.run.toolSequence&&detail.run.toolSequence.length){const tools=make('div','tool-sequence');detail.run.toolSequence.forEach(tool=>add(tools,'span','',tool));section.appendChild(tools)}if(detail.run.locator){const openTrace=add(section,'button','btn primary','在统一链路中查看');openTrace.type='button';openTrace.style.marginTop='12px';openTrace.addEventListener('click',()=>{const trace={locator:detail.run.locator,runRef:detail.run.ref};closeOpsEventDetail();setView('agent-traces');openRunObservability(trace)})}return section}
      function renderAssociatedEvidence(detail){const blocks=[renderRunEvidence(detail),renderDetailTrace(detail)].filter(Boolean);const conversation=detail.conversation||{};const status=[];if(detail.run)status.push('Agent run');else status.push('未关联 Agent run');if(detail.trace&&detail.trace.length)status.push(detail.trace.length+' 个链路 span');if(conversation.status==='unified-read-only')status.push('会话摘要在统一链路中');else if(conversation.status==='missing-correlation')status.push('无会话关联');const section=make('details','panel evidence-section event-associated-disclosure');const summary=make('summary','event-section-summary');add(summary,'strong','','关联证据');add(summary,'span','',status.join(' · '));section.appendChild(summary);const body=make('div','event-associated-body');if(!blocks.length)add(body,'div','event-conditional-note','该事件当前没有可关联的低敏 Agent run 或统一链路证据。');else blocks.forEach(block=>body.appendChild(block));section.appendChild(body);section.removeAttribute('open');return section}
      function renderOpsEventDetail(detail){const root=$('eventDrawerBody');root.replaceChildren();$('eventDrawerTitle').textContent=detail.event.component+' · '+detail.event.eventCode;eventDrawerMeta(detail);[renderEventFacts(detail),renderEventMetadata(detail),renderEventContext(detail),renderAssociatedEvidence(detail)].filter(Boolean).forEach(section=>root.appendChild(section))}
      async function loadOpsEventDetail(event){
        const drawer=$('eventDrawer');const root=$('eventDrawerBody');drawer.setAttribute('aria-busy','true');const loading=make('div','event-detail-state');loading.setAttribute('role','status');add(loading,'strong','','正在读取事件证据');add(loading,'span','', '正在按精确事件关联键读取受保护的低敏上下文…');root.replaceChildren(loading);
        try{const locator=String(event?.id||'').trim();if(!locator)throw new Error('ops_event_not_found');const response=await fetch(base+'/api/ops/observability/events/'+encodeURIComponent(locator),{credentials:'same-origin',headers:contextRequestHeaders()});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok||!data.detail)throw new Error(data.error||('HTTP '+response.status));renderOpsEventDetail(data.detail)}catch(error){const failed=make('div','event-detail-state error');failed.setAttribute('role','alert');add(failed,'strong','','事件上下文读取失败');add(failed,'span','',friendlyError(error.message));const retry=add(failed,'button','btn primary','重试读取');retry.type='button';retry.addEventListener('click',()=>loadOpsEventDetail(event));root.replaceChildren(failed)}finally{drawer.removeAttribute('aria-busy')}
      }
      async function openOpsEventDetail(event){
        state.activeDetailEvent=event;state.eventDetailReturnFocus=document.activeElement;const drawer=$('eventDrawer');drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';$('copyEventId').disabled=!eventEvidenceId(event);$('focusSimilarEvents').disabled=!eventFailureKey(event);$('eventDrawerTitle').textContent=event.component+' · '+event.eventCode;$('eventDrawerMeta').replaceChildren();$('closeEventDrawer').focus();await loadOpsEventDetail(event);
      }
      $('copyEventId').addEventListener('click',()=>copyOpsEventId(state.activeDetailEvent,$('copyEventId')));
      $('closeEventDrawer').addEventListener('click',closeOpsEventDetail);
      $('eventDrawer').addEventListener('click',event=>{if(event.target===$('eventDrawer'))closeOpsEventDetail()});
      document.addEventListener('keydown',event=>{const drawer=$('eventDrawer');if(!drawer.classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeOpsEventDetail();return}if(event.key==='Tab'){const focusable=Array.from(drawer.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(node=>node.offsetParent!==null);if(!focusable.length)return;const first=focusable[0];const last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}}});
`;
