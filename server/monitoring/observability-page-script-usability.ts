/** Progressive guidance and one-click investigation controls for first-time operators. */
export const OPS_OBSERVABILITY_SCRIPT_USABILITY = `
      state.investigationFocus=null;
      state.activeDetailEvent=null;

      function investigationMatchesFocus(event){
        const focus=state.investigationFocus;if(!focus)return true;
        if(focus.kind==='peak'){const time=new Date(event.occurredAt||0).getTime();return time>=focus.start&&time<focus.end}
        if(focus.kind==='cluster')return eventFailureKey(event)===focus.value;
        return impactKey(event,focus.kind)===focus.value;
      }
      function hasCustomInvestigationView(){return Boolean(state.investigationQuery||state.investigationFocus||state.investigationVersion!=='all'||state.investigationErrorType!=='all'||state.investigationComponent!=='all'||state.investigationOutcome!=='problem')}
      function restoreRecommendedInvestigation(o){state.investigationQuery='';state.investigationFocus=null;state.investigationVersion='all';state.investigationErrorType='all';state.investigationComponent='all';state.investigationOutcome='problem';renderInvestigation(o);toast('已恢复推荐调查视图')}
      function applyInvestigationFocus(focus,o){state.investigationQuery='';state.investigationFocus=focus;state.investigationOutcome='problem';renderInvestigation(o);window.scrollTo({top:0,behavior:'smooth'});toast('已聚焦：'+focus.label)}
      function peakInvestigationFocus(o){
        const points=investigationTrend(o);if(!points.length)return null;
        const totals=points.map(point=>Number(point.aiErrors||0)+Number(point.toolFailures||0)+Number(point.clientErrors||0)+Number(point.apiErrors||0)+Number(point.loginErrors||0));const peak=Math.max(0,...totals);if(!peak)return null;const index=totals.indexOf(peak);const start=new Date(points[index].bucket||0).getTime();if(!Number.isFinite(start))return null;const candidate=index+1<points.length?new Date(points[index+1].bucket||0).getTime():0;const end=candidate>start?candidate:start+60*60*1000;return {kind:'peak',value:String(points[index].bucket),start,end,label:'峰值时段 '+shortTime(points[index].bucket),count:peak};
      }
      function renderInvestigationTrendActions(head,o,peak,peakIndex){
        const actions=make('div','right');const points=investigationTrend(o);add(actions,'span','',peak?'峰值 '+peak+' · '+when(points[peakIndex]&&points[peakIndex].bucket):'窗口内无失败峰值');const focus=peakInvestigationFocus(o);if(focus&&(!state.investigationFocus||state.investigationFocus.kind!=='peak'||state.investigationFocus.value!==focus.value)){const button=add(actions,'button','btn','只看峰值附近');button.type='button';button.addEventListener('click',()=>applyInvestigationFocus(focus,o))}head.appendChild(actions);
      }
      function renderInvestigationHelper(toolbar,o){
        let helper=$('investigationHelper');if(!helper){helper=make('div','investigation-helper');helper.id='investigationHelper';toolbar.appendChild(helper)}helper.replaceChildren();add(helper,'span','','提示：点击峰值、版本或组件即可聚焦，按 / 搜索');
        if(state.investigationQuery)add(helper,'span','active-filter','搜索 “'+state.investigationQuery+'”');
        if(state.investigationFocus)add(helper,'span','active-filter',state.investigationFocus.label);
        if(state.investigationVersion!=='all')add(helper,'span','active-filter','版本 '+state.investigationVersion);
        if(state.investigationErrorType!=='all')add(helper,'span','active-filter','错误 '+investigationErrorLabel(state.investigationErrorType));
        if(state.investigationComponent!=='all')add(helper,'span','active-filter','组件 '+state.investigationComponent);
        if(state.investigationOutcome!=='problem')add(helper,'span','active-filter',state.investigationOutcome==='all'?'全部结果':'仅成功');
        add(helper,'span','spacer','');
        if(hasCustomInvestigationView()){const restore=add(helper,'button','restore-investigation','恢复推荐视图');restore.type='button';restore.addEventListener('click',()=>restoreRecommendedInvestigation(o))}
      }
      function guideStep(parent,index,text){const node=make('div','guide-step');add(node,'b','',index);add(node,'span','',text);parent.appendChild(node)}
      function renderInvestigationGuide(root,events,o){
        const failures=events.filter(isInvestigationProblem);const weighted=failures.reduce((sum,event)=>sum+occurrenceCount(event),0);const panel=make('section','panel investigation-guide');const copy=make('div','guide-copy');add(copy,'div','guide-kicker','系统已替你排序');
        const versions=groupInvestigationEvents(failures,event=>impactKey(event,'version'));const clusters=groupInvestigationEvents(failures,event=>eventFailureKey(event));const users=new Set(failures.map(event=>impactKey(event,'user')).filter(Boolean));const devices=new Set(failures.map(event=>impactKey(event,'device')).filter(Boolean));const peak=peakInvestigationFocus(o);
        if(!failures.length){add(copy,'strong','',events.length?'当前视图没有异常样本':'当前条件没有匹配证据');add(copy,'p','',hasCustomInvestigationView()?'不必逐项撤销条件，恢复推荐视图即可继续调查。':'当前时间窗口没有失败或部分完成事件，可以保持观察。')}else{const lead=versions[0]&&versions[0].count>=2?versions[0]:clusters[0];add(copy,'strong','',lead?(weighted+' 个异常样本，优先核对 '+lead.key):(weighted+' 个异常样本需要核对'));add(copy,'p','',users.size+' 个用户 · '+devices.size+' 台设备受到影响'+(clusters[0]?'；主异常为 '+clusters[0].key+'，打开代表证据验证工具序列与相邻对话。':'。'))}panel.appendChild(copy);
        const actions=make('div','guide-actions');if(failures.length){if(versions[0]&&(!state.investigationFocus||state.investigationFocus.kind!=='version'||state.investigationFocus.value!==versions[0].key)){const versionButton=add(actions,'button','btn','聚焦 '+versions[0].key);versionButton.type='button';versionButton.addEventListener('click',()=>applyInvestigationFocus({kind:'version',value:versions[0].key,label:'版本 '+versions[0].key},o))}if(peak&&(!state.investigationFocus||state.investigationFocus.kind!=='peak'||state.investigationFocus.value!==peak.value)){const peakButton=add(actions,'button','btn','查看峰值附近');peakButton.type='button';peakButton.addEventListener('click',()=>applyInvestigationFocus(peak,o))}if(clusters[0]){const evidence=add(actions,'button','btn primary','打开代表证据');evidence.type='button';evidence.addEventListener('click',()=>openOpsEventDetail(clusters[0].event))}}if(actions.childElementCount)panel.appendChild(actions);else copy.classList.add('full');
        const steps=make('div','guide-steps');guideStep(steps,'1',versions[0]?'先确认 '+versions[0].key+' 的影响是否集中':'先确认用户与设备影响面');guideStep(steps,'2',peak?'再对齐 '+shortTime(peak.value)+' 的多信号峰值':'再观察多信号趋势');guideStep(steps,'3',clusters[0]?'最后验证 '+clusters[0].key+' 的代表证据':'最后打开代表事件核对上下文');panel.appendChild(steps);root.appendChild(panel);
      }

      $('focusSimilarEvents').addEventListener('click',()=>{const event=state.activeDetailEvent;if(!event)return;const key=eventFailureKey(event);const o=state.investigationOverview||state.overview;closeOpsEventDetail();applyInvestigationFocus({kind:'cluster',value:key,label:'同类异常 '+key},o)});
      document.addEventListener('keydown',event=>{const target=event.target;const typing=target&&target.matches&&target.matches('input,textarea,select,[contenteditable="true"]');if(event.key==='/'&&state.view==='investigate'&&!typing){event.preventDefault();const search=$('investigationSearch');if(search)search.focus()}else if(event.key==='Escape'&&state.view==='investigate'&&!$('eventDrawer').classList.contains('open')&&hasCustomInvestigationView()){event.preventDefault();restoreRecommendedInvestigation(state.investigationOverview||state.overview)}});

      // Some production releases do not yet expose the optional object registry
      // endpoint. Do not leave operators staring at an infinite spinner when
      // the core alert overview and incident workbench are already healthy.
      const scheduleInterval=typeof window.setInterval==='function'?window.setInterval.bind(window):setInterval;
      const scheduleTimeout=typeof window.setTimeout==='function'?window.setTimeout.bind(window):setTimeout;
      const cancelInterval=typeof window.clearInterval==='function'?window.clearInterval.bind(window):clearInterval;
      let objectFallbackTimer=0;
      function renderUnavailableObjectRegistry(){
        const root=$('objectsContent');if(!root)return;
        const loading=root.querySelector('.empty');
        if(!loading||loading.textContent!=='对象注册表正在加载…'||root.querySelector('[data-object-fallback]')){if(objectFallbackTimer){cancelInterval(objectFallbackTimer);objectFallbackTimer=0}return;}
        loading.textContent='对象注册表暂不可用；告警策略和事故工作台仍可用，请稍后重试。';
        const retry=add(root,'button','btn','重试对象');retry.type='button';retry.dataset.objectFallback='true';retry.addEventListener('click',()=>loadAll(true));
      }
      objectFallbackTimer=scheduleInterval(renderUnavailableObjectRegistry,1500);
      scheduleTimeout(()=>{if(objectFallbackTimer){cancelInterval(objectFallbackTimer);objectFallbackTimer=0}},30000);
`;
