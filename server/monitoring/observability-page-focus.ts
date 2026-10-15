/** Task-first navigation and progressive disclosure for the existing console.
 * This layer only reorganizes presentation. Routing, permissions, freshness and
 * action execution stay with the existing owners.
 */
export const OPS_OBSERVABILITY_SCRIPT_FOCUS = `
      Object.assign(viewMeta,{
        overview:['可观测中心 / 总览','总览','确认运行状态，处理当前待办。'],
        'alerts/center':['可观测中心 / 告警中心','告警中心','认领告警，跟进处置。'],
        signals:['可观测中心 / 观测查询','观测查询','查指标、日志与运行信号。'],
        'signals/metrics':['可观测中心 / 观测查询','指标查询','选择指标，查看变化。'],
        'signals/logs':['可观测中心 / 观测查询','日志查询','按应用和级别查找日志。'],
        traces:['可观测中心 / 链路追踪','链路追踪','定位失败步骤与慢调用。'],
        'traces/runs':['可观测中心 / 链路追踪','链路追踪','选择一次运行，查看完整证据。'],
        devices:['可观测中心 / 设备','设备','查看在线状态，调查设备问题。'],
        'devices/list':['可观测中心 / 设备','设备','查看在线状态与最近心跳。']
      });
      // Preserve the shared map reference for navigation consumers and aliases.
      Object.keys(navGroupByView).forEach(key=>{delete navGroupByView[key]});
      Object.assign(navGroupByView,{
        'operator-metrics':'data','signals/panels':'data','signals/quality':'data',
        investigate:'data','service-levels':'data','skill-loop':'data',evolution:'data',
        'data-health':'infra',database:'infra',
        platform:'advanced',tenants:'advanced','alerts/rules':'advanced',
        'alerts/strategies':'advanced','alerts/metrics':'advanced','alerts/objects':'advanced',
        'alerts/channels':'advanced','alerts/silence':'advanced'
      });
      moduleNavKey['platform/model-pool']='platform';
      function syncFocusContext(){
        const overview=state.view==='overview';
        const incidentFact=$('globalIncidentFact');
        if(incidentFact)incidentFact.classList.toggle('focus-context-hidden',overview);
        const evaluate=$('runChecks');
        const platformEvaluation=state.view==='platform'&&['general','probing','logs','heal'].includes(state.viewChild||String(state.viewSource||'').split('/')[1]);
        const hideEvaluation=!overview&&!platformEvaluation;
        // A context class cannot remove a permission-driven hidden class.
        if(evaluate)evaluate.classList.toggle('focus-context-hidden',hideEvaluation);
        const options=$('workspaceOptions');
        if(options)options.classList.toggle('focus-context-hidden',hideEvaluation);
      }
      const focusBaseSetView=setView;
      setView=function(requested,updateHash=true){const result=focusBaseSetView(requested,updateHash);syncFocusContext();return result};
      const focusDisclosureState=new Map();
      function focusDisclosure(id,className,title,description){
        const details=make('details','detail-sections '+className);details.id=id;
        const summary=add(details,'summary','detail-summary focus-summary');
        add(summary,'strong','',title);add(summary,'span','focus-summary-meta',description);
        details.open=focusDisclosureState.get(id)||false;
        details.addEventListener('toggle',()=>{focusDisclosureState.set(id,details.open)});
        return details;
      }
      function focusServiceSummary(o){
        const checks=overviewChecks(o).filter(check=>!String(check.key||'').startsWith('north-star-'));
        const abnormal=checks.filter(check=>['critical','warning','observing'].includes(check.status)).length;
        const uncertain=checks.filter(check=>['unknown','stale','disabled'].includes(check.status)).length;
        if(abnormal)return abnormal+' 项需关注'+(uncertain?' · '+uncertain+' 项待确认':'');
        return uncertain?uncertain+' 项待确认':(checks.length?checks.length+' 项巡检 · 查看观测健康':'暂无服务快照');
      }
      function focusProductSummary(o){
        const checks=cockpitNorthStarChecks(o);
        if(!checks.length)return '暂无产品快照';
        let uncertain=0;let attention=0;
        checks.forEach(check=>{
          const {value,unknown}=cockpitProductState(check);
          if(unknown){uncertain++;return}
          const status=cockpitStatus(check.status,false);const target=cockpitTarget(check.summary);
          if(['critical','warning'].includes(status)||(target!=null&&value<target))attention++;
        });
        return [checks.length+' 项指标',attention?attention+' 项需关注':'',uncertain?uncertain+' 项待确认':''].filter(Boolean).join(' · ');
      }
      function focusPrioritizeOverview(){
        const primary=$('overviewPrimary');const metrics=primary&&primary.querySelector('.overview-metrics');
        if(metrics&&primary.lastElementChild!==metrics)primary.appendChild(metrics);
      }
      // The action queue may update independently after a fetch. Keep newly
      // visible approvals and errors ahead of the supporting metric strip too.
      const focusBaseRenderActionLoopMount=renderActionLoopMount;
      renderActionLoopMount=function(){const result=focusBaseRenderActionLoopMount();focusPrioritizeOverview();return result};
      const focusBaseRenderOverview=renderOverview;
      renderOverview=function(){
        // Read before the hierarchy wrapper rebuilds the DOM, including changes
        // made programmatically before a native toggle event has been delivered.
        ['focusServiceHealth','focusProductHealth'].forEach(id=>{const node=$(id);if(node)focusDisclosureState.set(id,node.open)});
        focusBaseRenderOverview();
        focusPrioritizeOverview();
        const secondary=$('overviewSecondary');if(!secondary||!state.overview)return;
        const service=secondary.querySelector('.overview-impact');
        const product=secondary.querySelector('.overview-product-health');
        if(!service&&!product)return;
        const group=make('div','focus-overview');
        if(service){const detail=focusDisclosure('focusServiceHealth','focus-health','服务健康',focusServiceSummary(state.overview));const body=add(detail,'div','focus-detail-body');body.appendChild(service);group.appendChild(detail)}
        if(product){
          const detail=focusDisclosure('focusProductHealth','focus-product','产品健康',focusProductSummary(state.overview));
          const body=add(detail,'div','focus-detail-body');
          // The empty snapshot renderer already has a disclosure. Its message
          // belongs to the outer disclosure, avoiding two clicks to see it.
          if(product.tagName==='DETAILS'){product.open=true;product.classList.add('focus-inline-empty')}
          body.appendChild(product);group.appendChild(detail);
        }
        // Move only the two health surfaces. Action mounts and errors retain
        // their current primary/secondary destination and all existing IDs.
        secondary.appendChild(group);
      };
      syncFocusContext();
`;
