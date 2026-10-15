/** Reparent the existing navigation before MOBILE records its return parents.
 * Routes, permission guards, existing controls and their listeners stay intact.
 */
export const OPS_OBSERVABILITY_SIMPLE_NAV_STYLE = `
  body.ops-observability .nav-main{display:grid;gap:4px;margin-bottom:16px}
  body.ops-observability .nav-main:empty,body.ops-observability .nav-retired-group{display:none!important}
  body.ops-observability .nav-main .module-tab{min-height:42px;color:var(--text)}
  body.ops-observability .nav-secondary-label{margin:12px 10px 4px;color:var(--muted);font-size:11px}
  @media(max-width:720px){
    body.ops-observability .module-tabs:not(.mobile-expanded) .nav-main{display:none}
    body.ops-observability .module-tabs.mobile-expanded .nav-main{display:grid;margin:0}
    body.ops-observability .nav-secondary-label{display:none}
  }
`;

/** Adapt only the verified mobile task list on the actual compiled baseline. */
export function simplifyMobileTourScript(script: string): string {
  const previous = "const MOBILE_PRIMARY=['overview','investigate','alerts/center','traces','signals/panels'];";
  const desired = "const MOBILE_PRIMARY=['overview','alerts/center','traces','signals','devices'];";
  if ((script.match(/\bconst\s+MOBILE_PRIMARY\s*=/g) || []).length !== 1) {
    throw new Error('simple_navigation_mobile_primary_count');
  }
  if (script.includes(desired)) return script;
  if (!script.includes(previous)) throw new Error('simple_navigation_mobile_primary_unrecognized');
  return script.replace(previous, desired);
}

export const OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT = String.raw`
      (function simplifyExistingNavigation(){
        const nav=document.querySelector('.module-tabs');
        if(!nav||nav.dataset.simpleNavVersion==='1')return;
        if(!nav.id&&!document.getElementById('moduleTabs'))nav.id='moduleTabs';
        const primaryRoutes=['overview','alerts/center','traces','signals','devices'];
        const groupedRoutes={
          data:['investigate','operator-metrics','signals/panels','signals/quality','service-levels','skill-loop','evolution'],
          infra:['data-health','database'],
          advanced:['alerts/rules','alerts/strategies','alerts/metrics','alerts/objects','alerts/channels','alerts/silence','platform','tenants']
        };
        const labels={data:'分析与洞察',infra:'数据与资产',advanced:'配置与管理'};
        const oldGroups=Array.from(nav.querySelectorAll('.nav-group'));
        const originalTabs=Array.from(nav.querySelectorAll('.module-tab'));
        const originalHidden=new Map();
        // Moving a control out of a permission-hidden ancestor must not reveal it.
        originalTabs.forEach(tab=>{
          let hidden=false;
          for(let parent=tab;parent&&parent!==nav;parent=parent.parentElement){
            if(parent.hidden||parent.classList.contains('hidden')){hidden=true;break}
          }
          originalHidden.set(tab,hidden);
        });
        function create(tag,className){const node=document.createElement(tag);if(className)node.className=className;return node}
        let main=nav.querySelector('.nav-main');
        if(!main){main=create('div','nav-main');const mobile=nav.querySelector('.nav-primary');nav.insertBefore(main,mobile?mobile.nextSibling:nav.firstChild)}
        main.setAttribute('aria-label','常用工作区');
        let moreLabel=nav.querySelector('.nav-secondary-label');
        if(!moreLabel){moreLabel=create('div','nav-secondary-label');moreLabel.textContent='更多工作区'}
        nav.insertBefore(moreLabel,main.nextSibling);
        const groups={};
        Object.keys(labels).forEach(key=>{
          const id='nav-group-'+key;
          let group=oldGroups.find(node=>node.id===id||node.dataset.navGroup===key);
          if(!group){group=create('details','nav-group');group.id=id;group.dataset.navGroup=key}
          group.classList.add('nav-group');group.classList.remove('nav-retired-group');
          let summary=Array.from(group.children).find(node=>node.tagName==='SUMMARY');
          if(!summary){summary=create('summary','nav-section-toggle');group.insertBefore(summary,group.firstChild)}
          summary.classList.add('nav-section-toggle');
          let caret=summary.querySelector('.nav-toggle-caret');
          if(!caret){caret=create('span','nav-toggle-caret');caret.setAttribute('aria-hidden','true');summary.insertBefore(caret,summary.firstChild)}
          let label=summary.querySelector('.nav-toggle-label');
          if(!label){label=create('span','nav-toggle-label');summary.appendChild(label)}
          label.textContent=labels[key];summary.setAttribute('aria-label',labels[key]);summary.setAttribute('title',labels[key]);
          let items=group.querySelector('.nav-group-items');
          if(!items){items=create('div','nav-group-items');group.appendChild(items)}
          if(!items.id)items.id=id+'-items';summary.setAttribute('aria-controls',items.id);
          groups[key]={group,items,summary};
        });
        function route(tab){return String(tab.dataset.view||'')}
        function move(tab,parent){
          let hidden=originalHidden.get(tab)||false;
          if(!originalHidden.has(tab))for(let ancestor=tab;ancestor&&ancestor!==nav;ancestor=ancestor.parentElement){
            if(ancestor.hidden||ancestor.classList.contains('hidden')){hidden=true;break}
          }
          if(hidden){tab.hidden=true;tab.classList.add('hidden')}parent.appendChild(tab);
        }
        function matching(key){return originalTabs.filter(tab=>route(tab)===key)}
        primaryRoutes.forEach(key=>matching(key).forEach(tab=>move(tab,main)));
        Object.keys(groupedRoutes).forEach(key=>groupedRoutes[key].forEach(view=>matching(view).forEach(tab=>move(tab,groups[key].items))));
        const assigned=new Set([...primaryRoutes,...Object.values(groupedRoutes).flat()]);
        originalTabs.filter(tab=>!assigned.has(route(tab))).forEach(tab=>{
          // Future application links and unknown modules remain reachable.
          const href=String(tab.getAttribute('href')||'');
          const key=/grafana|data-center|vision-workshop/.test(href)?'infra':'advanced';
          move(tab,groups[key].items);
        });
        let after=moreLabel;
        Object.keys(groups).forEach(key=>{nav.insertBefore(groups[key].group,after.nextSibling);after=groups[key].group});
        oldGroups.filter(group=>!Object.values(groups).some(value=>value.group===group)).forEach(group=>{
          const items=group.querySelector('.nav-group-items');
          if(items)Array.from(items.children).forEach(node=>{
            // Preserve future controls not marked module-tab, including their IDs.
            move(node,groups.advanced.items);
          });
          const summary=Array.from(group.children).find(node=>node.tagName==='SUMMARY');
          if(summary)Array.from(summary.children).filter(node=>!node.classList.contains('nav-toggle-caret')&&!node.classList.contains('nav-toggle-label')&&node.id!=='navCoreAlert').forEach(node=>move(node,groups.advanced.items));
          Array.from(group.children).filter(node=>node!==summary&&node!==items).forEach(node=>move(node,groups.advanced.items));
          group.open=false;group.hidden=true;group.classList.remove('nav-group');group.classList.add('nav-retired-group');
        });
        // The genuine incident badge belongs on the always-visible task entry.
        const incidents=document.getElementById('incidentCount');
        const alertTab=matching('alerts/center')[0];
        if(incidents&&alertTab&&nav.contains(incidents))alertTab.appendChild(incidents);
        let review=document.getElementById('navReviewNotice');
        if(!review){review=create('span','tab-count');review.id='navReviewNotice';review.textContent='待审核';review.hidden=true}
        if(!review.parentElement||nav.contains(review))groups.data.summary.appendChild(review);
        function syncReviewNotice(){
          if(!nav.contains(review))return;
          const waiting=['skillLoopCount','evolutionCount'].some(id=>{
            const count=document.getElementById(id);const tab=count&&count.closest('.module-tab');
            return count&&!count.hidden&&tab&&!tab.hidden&&!tab.classList.contains('hidden')&&Number(count.textContent)>0;
          });
          review.hidden=!waiting;review.setAttribute('title',waiting?'学习与进化有候选待审核':'');
        }
        if(typeof renderOverview==='function'){
          const previous=renderOverview;
          renderOverview=function(){const result=previous.apply(this,arguments);syncReviewNotice();return result};
        }
        if(typeof loadAll==='function'){
          const previous=loadAll;
          loadAll=async function(){try{return await previous.apply(this,arguments)}finally{syncReviewNotice()}};
        }
        if(typeof navGroupByView!=='undefined'){
          primaryRoutes.forEach(key=>{delete navGroupByView[key]});
          Object.keys(groupedRoutes).forEach(key=>groupedRoutes[key].forEach(view=>{navGroupByView[view]=key}));
          Object.keys(groups).forEach(key=>groups[key].items.querySelectorAll('.module-tab[data-view]').forEach(tab=>{navGroupByView[route(tab)]=key}));
        }
        if(typeof moduleNavKey!=='undefined')Object.assign(moduleNavKey,{
          'platform/model-pool':'platform','platform/general':'platform','platform/probing':'platform',
          'platform/logs':'platform','platform/heal':'platform','platform/accounts':'platform',
          'signals/metrics':'signals','signals/logs':'signals','signals/promql':'signals',
          'signals/catalog':'signals','signals/tokens':'signals',
          'traces/runs':'traces','traces/session':'traces',
          'devices/list':'devices','devices/logs':'devices','devices/register':'devices',
          'tenants/list':'tenants','tenants/create':'tenants',
          'alerts/metrics':'alerts/rules','alerts/objects':'alerts/rules'
        });
        if(typeof setNavGroupAlerts==='function'&&typeof activeIncidentCount==='function'){
          const previous=setNavGroupAlerts;
          setNavGroupAlerts=function(o){
            const before=document.getElementById('incidentCount');
            const pending=before?{text:before.textContent,hidden:before.hidden,title:before.title}:null;
            const result=previous.apply(this,arguments);
            // Only a real incident-list snapshot can confirm an empty queue.
            if(!o||!Array.isArray(o.incidents)){
              if(before&&pending&&document.getElementById('incidentCount')===before){before.textContent=pending.text;before.hidden=pending.hidden;before.title=pending.title}
              return result;
            }
            const count=activeIncidentCount(o);const badge=document.getElementById('incidentCount');
            if(badge){badge.textContent=count?String(count):'';badge.hidden=!count;badge.title=count?count+' 个进行中事故':''}
            return result;
          };
        }
        syncReviewNotice();
        nav.dataset.simpleNavVersion='1';
      })();
`;
