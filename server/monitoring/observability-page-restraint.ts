import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW_RESTRAINT } from './observability-page-overview-restraint.js';

/** Keep task controls visible and move secondary destinations into native disclosures. */
export const OPS_OBSERVABILITY_RESTRAINT_STYLE = `
  body.ops-observability #pageIntro,body.ops-observability #scopeStatus,body.ops-observability #domainContext{display:none}
  body.ops-observability[data-restraint-view="alerts"] #globalIncidentFact{display:none}
  body.ops-observability .page-head{align-items:center;gap:18px;margin-bottom:20px}
  body.ops-observability .page-head h1{font-size:26px;margin:0;line-height:1.35;letter-spacing:-.02em}
  body.ops-observability .page-head-actions{gap:6px}
  body.ops-observability .workspace-facts{font-size:11px;gap:10px}
  body.ops-observability .workspace-facts #fresh{border:0;background:none;padding:0;white-space:normal}
  body.ops-observability .module-switch-tab>small{display:none}
  body.ops-observability .restraint-switcher{position:relative;overflow:visible;gap:4px;padding:0;border:0;border-bottom:1px solid var(--line);border-radius:0;background:none;box-shadow:none;margin-bottom:20px;align-items:center}
  body.ops-observability .restraint-switcher>.module-switch-tab{flex:0 1 auto;min-width:0;min-height:44px;padding:10px 14px;border:0;border-radius:0;background:none;box-shadow:none;text-align:center;font-size:13px}
  body.ops-observability .restraint-switcher>.module-switch-tab.is-active{background:none;color:var(--text);box-shadow:inset 0 -2px 0 var(--accent,var(--green));font-weight:600}
  body.ops-observability .restraint-module-more{position:relative;margin-left:auto;flex:0 0 auto;min-width:0}
  body.ops-observability .restraint-module-more>summary{display:flex;align-items:center;gap:8px;padding:10px 12px;min-height:44px;list-style:none;cursor:pointer;color:var(--muted);font-size:13px;border-radius:6px}
  body.ops-observability .restraint-module-more>summary::-webkit-details-marker{display:none}
  body.ops-observability .restraint-module-more>summary:after{content:'⌄';font-size:13px}
  body.ops-observability .restraint-module-more[open]>summary{color:var(--text);background:var(--panel2)}
  body.ops-observability .restraint-module-options{position:absolute;right:0;top:calc(100% + 6px);z-index:80;width:240px;max-width:calc(100vw - 32px);display:grid;gap:2px;padding:6px;border:1px solid var(--line);border-radius:10px;background:var(--ui-surface,var(--c2));box-shadow:0 8px 24px color-mix(in srgb,var(--text) 12%,transparent)}
  body.ops-observability .restraint-module-options>.module-switch-tab{display:block;flex:none;width:100%;min-width:0;min-height:44px;text-align:left;padding:10px 12px;border:0;border-radius:6px;font-size:13px;background:none;box-shadow:none;color:var(--text)}
  body.ops-observability .restraint-module-options>.module-switch-tab:hover{background:var(--panel2)}
  body.ops-observability .restraint-module-more>summary:focus-visible{outline:2px solid var(--accent,var(--green));outline-offset:2px}
  body.ops-observability .overview-group-head{display:none}
  body.ops-observability #overviewSecondary{border-top:0;padding-top:10px;gap:0}
  body.ops-observability #overviewSecondary .focus-overview{gap:0}
  body.ops-observability #overviewSecondary .focus-overview>details,body.ops-observability #actionLoopEmptyDetails,body.ops-observability #overviewContent>details{margin:0;border:0;border-top:1px solid var(--line);border-radius:0;background:none;box-shadow:none}
  body.ops-observability #overviewSecondary .focus-overview>details>summary,body.ops-observability #actionLoopEmptyDetails>summary,body.ops-observability #overviewContent>details>summary{min-height:48px;padding:14px 0;background:none}
  body.ops-observability .overview-restraint-note{margin:0;padding:10px 0;color:var(--muted);font-size:12px;line-height:1.7;border-top:1px solid var(--line)}
  body.ops-observability .overview-restraint-metric-detail,body.ops-observability .overview-restraint-queue-detail{border:0;border-top:1px solid var(--line);border-radius:0;background:none;box-shadow:none;margin:0}
  body.ops-observability .overview-restraint-metric-detail>summary,body.ops-observability .overview-restraint-queue-detail>summary{padding:14px 0;font-size:13px;min-height:44px}
  body.ops-observability .overview-restraint-supporting-metrics,body.ops-observability .overview-restraint-attention-metrics{gap:0;border:0;background:none;box-shadow:none;grid-template-columns:repeat(4,minmax(0,1fr))}
  body.ops-observability :is(.overview-restraint-supporting-metrics,.overview-restraint-attention-metrics)>.metric{border:0;border-right:1px solid var(--line);border-radius:0;background:none;padding:12px 18px;box-shadow:none}
  body.ops-observability :is(.overview-restraint-supporting-metrics,.overview-restraint-attention-metrics)>.metric:last-child{border-right:0}
  body.ops-observability .ic-summary-priority{border-bottom:1px solid var(--line);margin-bottom:16px;background:none}
  body.ops-observability .ic-filter-card{padding:12px 16px;background:none;border-radius:0}
  body.ops-observability .ic-filter-card .summary-value{font-size:23px;line-height:1.4}
  body.ops-observability .signals-query-card{border:0;background:none;box-shadow:none;padding:0 0 16px}
  body.ops-observability .nl-hint{display:none}
  body.ops-observability .restraint-secondary-note{display:block;color:var(--muted);font-size:12px;line-height:1.7}
  body.ops-observability #view-traces .trace-stats{display:flex;flex-wrap:wrap;gap:0;padding:4px 0;border:0;border-bottom:1px solid var(--line);border-radius:0;background:none;box-shadow:none}
  body.ops-observability #view-traces .trace-stat{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 8px;padding:8px 14px;border:0;background:none;min-width:0}
  body.ops-observability #view-traces .trace-stat>span{font-size:11px;line-height:1.6}
  body.ops-observability #view-traces .trace-stat>strong{font-size:16px;line-height:1.5}
  body.ops-observability #view-traces .trace-stat>small{font-size:10px;line-height:1.6}
  body.ops-observability #devices-list.restraint-device-list{border:0;background:none;box-shadow:none;margin:0}
  body.ops-observability #devices-list.restraint-device-list>summary,body.ops-observability .ssh-logs-device-link{display:none}
  body.ops-observability #devices-list.restraint-device-list>*:not(summary){margin:0}
  @media(max-width:720px){
    body.ops-observability .page-head{align-items:flex-start;gap:12px;margin-bottom:16px}
    body.ops-observability .page-head h1{font-size:24px}
    body.ops-observability #scopeStatus:not(.live){display:inline-flex;border:0;background:none;padding:0;font-size:11px}
    body.ops-observability .restraint-switcher{gap:0;flex-wrap:wrap;margin-bottom:16px}
    body.ops-observability .restraint-switcher>.module-switch-tab{padding:10px;flex:0 1 auto;font-size:12px}
    body.ops-observability .restraint-module-more>summary{padding:10px;font-size:12px}
    body.ops-observability .overview-restraint-supporting-metrics,body.ops-observability .overview-restraint-attention-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
    body.ops-observability :is(.overview-restraint-supporting-metrics,.overview-restraint-attention-metrics)>.metric{padding:12px}
  }
`;

export const OPS_OBSERVABILITY_SCRIPT_RESTRAINT = OPS_OBSERVABILITY_SCRIPT_OVERVIEW_RESTRAINT + String.raw`
      const restraintTabGroups=[];
      const restraintPrimaryTabs={signals:['signals/metrics','signals/logs','signals/promql'],platform:['platform/model-pool'],alerts:['alerts/center']};
      function restraintPermissionVisible(node){return !node.hidden&&!node.classList.contains('hidden')&&!node.disabled}
      function restraintTabVisible(node){
        if(!restraintPermissionVisible(node))return false;
        for(let parent=node.parentElement;parent;parent=parent.parentElement){if(parent.hidden||parent.classList.contains('hidden')||parent.tagName==='DETAILS'&&!parent.open)return false}
        return true;
      }
      function restraintPlaceTabs(parent,tabs,before){
        let next=before||null;
        for(let index=tabs.length-1;index>=0;index--){const tab=tabs[index];if(tab.parentElement!==parent||tab.nextElementSibling!==next)parent.insertBefore(tab,next);next=tab}
      }
      function restraintSyncTabs(){
        if(document.body)document.body.dataset.restraintView=state.view||'overview';
        restraintTabGroups.forEach(group=>{
          const focused=document.activeElement;
          const active=group.tabs.find(tab=>tab.getAttribute('aria-selected')==='true');
          const primary=group.tabs.filter(tab=>group.primary.includes(tab.dataset.moduleTab)||tab===active);
          const other=group.tabs.filter(tab=>!primary.includes(tab));
          restraintPlaceTabs(group.items,other);restraintPlaceTabs(group.list,primary,group.menu);
          group.menu.hidden=!other.some(restraintPermissionVisible);
          group.items.querySelectorAll('[data-module-tab]').forEach(tab=>tab.tabIndex=group.menu.open&&restraintPermissionVisible(tab)?0:-1);
          primary.forEach(tab=>tab.tabIndex=tab===active?0:-1);
          if(focused&&focused===active&&document.activeElement!==focused&&restraintTabVisible(focused))focused.focus({preventScroll:true});
        });
      }
      function restraintCloseMenus(restoreFocus=false){
        restraintTabGroups.forEach(group=>{
          if(!group.menu.open)return;
          const focused=group.menu.contains(document.activeElement);
          group.menu.open=false;
          if(restoreFocus&&focused)group.summary.focus({preventScroll:true});
        });
        restraintSyncTabs();
      }
      function restraintInitTabs(){
        document.querySelectorAll('.module-switcher').forEach(list=>{
          const view=list.closest('.view');const key=view&&view.id.replace(/^view-/,'');const primary=restraintPrimaryTabs[key];
          if(!primary||list.dataset.restraintBound==='true')return;
          const tabs=Array.from(list.querySelectorAll('[data-module-tab]'));if(tabs.length<4)return;
          list.dataset.restraintBound='true';list.classList.add('restraint-switcher');
          tabs.forEach(tab=>{const note=tab.querySelector('small');if(note&&!tab.title)tab.title=note.textContent||'';if(!tab.getAttribute('aria-label'))tab.setAttribute('aria-label',String(tab.textContent||'').replace(note&&note.textContent||'','').trim())});
          const menu=make('details','restraint-module-more');const summary=add(menu,'summary','','更多');summary.setAttribute('aria-label','更多'+(list.getAttribute('aria-label')||'模块'));
          const items=add(menu,'div','restraint-module-options');list.appendChild(menu);
          const group={list,tabs,primary,menu,summary,items};restraintTabGroups.push(group);
          menu.addEventListener('toggle',()=>{if(menu.open)restraintTabGroups.forEach(other=>{if(other!==group)other.menu.open=false});restraintSyncTabs()});
          list.addEventListener('keydown',event=>{
            const tab=event.target.closest('[data-module-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
            const visible=Array.from(list.querySelectorAll('[data-module-tab]')).filter(restraintTabVisible);const index=visible.indexOf(tab);if(index<0||!visible.length)return;
            event.preventDefault();event.stopImmediatePropagation();
            const next=event.key==='Home'?0:event.key==='End'?visible.length-1:(index+(event.key==='ArrowRight'?1:-1)+visible.length)%visible.length;
            visible[next].click();visible[next].focus({preventScroll:true});
          },true);
        });
        const deviceList=$('devices-list');if(deviceList&&deviceList.tagName==='DETAILS'){deviceList.open=true;deviceList.classList.add('restraint-device-list')}
        const anomalies=$('signals-anomalies');const anomalySummary=anomalies&&anomalies.querySelector('summary');const anomalyNote=anomalySummary&&anomalySummary.querySelector('span');
        if(anomalyNote){anomalyNote.classList.add('restraint-secondary-note');anomalies.insertBefore(anomalyNote,anomalySummary.nextElementSibling)}
        restraintSyncTabs();
      }
      const restraintBaseSetView=setView;
      setView=function(requested,updateHash=true){const previous=state.viewSource;const result=restraintBaseSetView(requested,updateHash);restraintSyncTabs();if(state.viewSource!==previous)restraintCloseMenus();return result};
      document.addEventListener('click',event=>{restraintTabGroups.forEach(group=>{if(group.menu.open&&!group.menu.contains(event.target))group.menu.open=false});restraintSyncTabs()},true);
      document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const open=restraintTabGroups.some(group=>group.menu.open);if(open){event.preventDefault();event.stopImmediatePropagation();restraintCloseMenus(true)}},true);
      if(typeof window!=='undefined')window.addEventListener('resize',()=>restraintCloseMenus(true));
      if(typeof renderTraceRunFacts==='function'){
        const restraintBaseRunFacts=renderTraceRunFacts;
        renderTraceRunFacts=function(parent,detail){
          const run=detail&&detail.run||{};const metrics=make('details','trace-detail-section trace-detail-disclosure restraint-run-facts');metrics.dataset.traceDisclosureKey='detail:run-facts';
          const summary=add(metrics,'summary','trace-section-head');add(summary,'strong','','运行指标');
          add(summary,'span','',(run.outcome?outcomeName(run.outcome):'状态待确认')+' · '+traceDuration(run.elapsedMs)+' · '+fmt(run.toolCallCount)+' 次工具');
          restraintBaseRunFacts(metrics,detail);parent.appendChild(metrics);return metrics;
        };
      }
      restraintInitTabs();
`;
