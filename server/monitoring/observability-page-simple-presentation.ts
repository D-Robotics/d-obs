/** Presentation only. Keep original controls, routing and access owners intact. */
export const OPS_OBSERVABILITY_SIMPLE_STYLE = `
  body.ops-simple .page-head{display:flex;align-items:flex-start;gap:24px;padding-bottom:18px;margin-bottom:20px}
  body.ops-simple .page-head-copy{flex:1 1 240px;min-width:180px}
  body.ops-simple #pageTitle{font-size:28px;line-height:1.3;letter-spacing:-.02em;word-break:normal;margin-bottom:6px}
  body.ops-simple #pageKicker{display:none}
  body.ops-simple .page-head-actions{flex:0 1 auto;max-width:540px;min-width:0}
  body.ops-simple .page-head-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  body.ops-simple .workspace-facts{flex-wrap:wrap;white-space:normal;gap:6px;font-size:11px}
  body.ops-simple #scopeStatus:not(.live):not(.hidden){display:inline-flex!important}
  body.ops-simple #scopeStatus.live{display:none}
  body.ops-simple .simple-page-help{font-size:12px;color:var(--muted)}
  body.ops-simple .simple-page-help>summary{cursor:pointer;display:inline-block}
  body.ops-simple .simple-page-help[open] #pageIntro{display:block;margin:8px 0 0;max-width:640px;font-size:13px}
  body.ops-simple .simple-page-help:has(#pageIntro:empty){display:none}
  body.ops-simple .simple-inspection-options{position:relative;font-size:12px}
  body.ops-simple .simple-inspection-options>summary{cursor:pointer;padding:9px 12px;border:1px solid var(--line);border-radius:7px;list-style:none}
  body.ops-simple .simple-inspection-options>div{position:absolute;right:0;top:calc(100% + 6px);z-index:30;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:200px;box-shadow:var(--shadow)}
  body.ops-simple .simple-inspection-options:has(#runChecks.hidden),body.ops-simple .simple-inspection-options:has(#runChecks.focus-context-hidden){display:none}
  body.ops-simple .simple-inspection-options p{font-size:11px;line-height:1.6;color:var(--muted);margin:8px 0 0}
  body.ops-simple .side-nav .global-tab:not(.active){color:var(--text);opacity:1}
  body.ops-simple .panel{box-shadow:none;border-radius:10px}
  body.ops-simple .overview-stack>.panel:not(.hero):not(.action-loop-panel):before,
  body.ops-simple .overview-stack>.detail-sections:before{display:none}
  body.ops-simple .overview-stack{gap:16px}
  body.ops-simple .view{grid-template-columns:minmax(0,1fr)}
  body.ops-simple #signalsLogTable{min-width:0;max-width:100%;overflow-x:auto}
  body.ops-simple .section-head{margin-bottom:12px}
  body.ops-simple .section-head h2{font-size:16px}
  body.ops-simple .north-star-card,.ops-simple .metric,.ops-simple .incident-card{box-shadow:none;transform:none}
  body.ops-simple .module-switcher{display:flex;flex-wrap:wrap;align-items:center;overflow:visible;gap:5px;padding:5px;border-radius:9px;box-shadow:none}
  body.ops-simple .module-switch-tab{min-height:38px;padding:8px 12px;font-size:12px;white-space:nowrap;box-shadow:none}
  body.ops-simple .module-switch-tab small{display:none}
  body.ops-simple .simple-role-hidden{display:none!important}
  body.ops-simple .simple-module-more{position:relative;margin-left:auto}
  body.ops-simple .simple-module-more[hidden]{display:none!important}
  body.ops-simple .simple-module-more>summary{cursor:pointer;padding:9px 12px;color:var(--text);font-size:12px;list-style:none;border-radius:7px}
  body.ops-simple .simple-module-more>summary:after{content:' ▾';color:var(--muted)}
  body.ops-simple .simple-module-more>.simple-module-more-items{position:absolute;right:0;top:calc(100% + 5px);z-index:25;display:grid;gap:4px;min-width:190px;background:var(--panel);border:1px solid var(--line);padding:7px;border-radius:9px;box-shadow:var(--shadow)}
  body.ops-simple .simple-module-more:not([open])>.simple-module-more-items{display:none}
  body.ops-simple .simple-module-more-items .module-switch-tab{text-align:left;justify-content:flex-start;width:100%}
  body.ops-simple :is(button,a,summary,input,select,textarea):focus-visible{outline:2px solid var(--green);outline-offset:3px}
  @media(max-width:1100px){
    body.ops-simple .page-head{flex-direction:column;gap:14px;align-items:stretch}
    body.ops-simple .page-head-copy{flex:auto;min-width:0}
    body.ops-simple .page-head-actions{max-width:none;width:100%;flex:auto}
    body.ops-simple #pageTitle{font-size:26px}
  }
  @media(max-width:720px){
    body.ops-simple .page-head{gap:10px;margin-bottom:14px}
    body.ops-simple .page-head-controls{gap:6px}
    body.ops-simple .page-head-controls .btn{min-height:36px}
    body.ops-simple #pageTitle{font-size:23px}
    body.ops-simple .module-switcher{flex-wrap:wrap;overflow:visible}
    body.ops-simple .module-switch-tab{font-size:11px;padding:7px 8px;min-width:0}
    body.ops-simple .simple-module-more>summary{padding:8px;font-size:11px}
    body.ops-simple .simple-inspection-options>div{right:0;max-width:calc(100vw - 40px)}
  }
`;

export const OPS_OBSERVABILITY_SIMPLE_PRESENTATION_SCRIPT = `
      document.body.classList.add('ops-simple');
      if(typeof viewMeta!=='undefined')viewMeta.overview=['可观测中心 / 总览','总览','确认运行状态，处理当前待办。'];
      function simplePresentationHeader(){
        const intro=$('pageIntro');
        if(intro&&intro.parentNode&&!intro.closest('details')){
          const help=make('details','simple-page-help');help.id='simplePageHelp';
          add(help,'summary','','页面说明');intro.parentNode.insertBefore(help,intro);help.appendChild(intro);
        }
        const check=$('runChecks');
        if(check&&check.parentNode&&!check.closest('details')){
          const options=make('details','simple-inspection-options');options.id='simpleInspectionOptions';
          add(options,'summary','','巡检选项');check.parentNode.insertBefore(options,check);
          const body=add(options,'div');body.appendChild(check);add(body,'p','','重新运行巡检。刷新只读取当前数据。');
        }
      }
      const simpleTabDefaults={signals:['signals/metrics','signals/logs','signals/promql'],alerts:['alerts/center'],platform:['platform/model-pool'],devices:['devices/list'],tenants:['tenants/list']};
      const simpleTabGroups=[];
      function simpleVisibleTab(tab){
        if(tab.hidden||tab.disabled||tab.getAttribute('aria-disabled')==='true'||tab.classList.contains('hidden')||tab.classList.contains('simple-role-hidden'))return false;
        let parent=tab.parentElement;
        while(parent){if(parent.hidden||parent.classList.contains('hidden')||(parent.tagName==='DETAILS'&&!parent.open))return false;parent=parent.parentElement}
        return true;
      }
      function simpleClosePopovers(restore=false){
        document.querySelectorAll('.simple-module-more[open],.simple-inspection-options[open]').forEach(detail=>{
          const focused=detail.contains(document.activeElement);detail.open=false;
          if(restore&&focused){const summary=detail.querySelector('summary');if(summary)summary.focus()}
        });
      }
      function simpleUpdateModuleTabs(){
        simpleTabGroups.forEach(group=>{
          const focused=document.activeElement;const focusedTab=group.tabs.includes(focused);
          const source=group.section.getAttribute('data-active-module');
          const signature=source||'';
          if(group.signature!==undefined&&group.signature!==signature)group.more.open=false;
          group.signature=signature;
          const direct=[];const extra=[];
          group.tabs.forEach(tab=>{
            const denied=(typeof opsTenantMode!=='undefined'&&opsTenantMode)||
              (typeof opsMemberMode!=='undefined'&&opsMemberMode&&!['alerts/center','alerts/strategies','tenants/list'].includes(tab.dataset.moduleTab));
            tab.classList.toggle('simple-role-hidden',Boolean(denied));
            (!denied&&(group.primary.includes(tab.dataset.moduleTab)||tab.dataset.moduleTab===source)?direct:extra).push(tab);
          });
          direct.forEach(tab=>{if(tab.parentNode!==group.bar)group.bar.insertBefore(tab,group.more)});
          extra.forEach(tab=>{if(tab.parentNode!==group.items)group.items.appendChild(tab)});
          const available=extra.some(tab=>!tab.hidden&&!tab.classList.contains('hidden')&&!tab.classList.contains('simple-role-hidden'));
          group.more.hidden=!available;
          if(focusedTab&&focused.isConnected&&simpleVisibleTab(focused)&&(!document.activeElement||document.activeElement===document.body))focused.focus({preventScroll:true});
        });
      }
      function simpleInitModuleTabs(){
        Object.entries(simpleTabDefaults).forEach(([name,primary])=>{
          const section=$('view-'+name);const bar=section&&section.querySelector('.module-switcher');if(!bar)return;
          const tabs=Array.from(bar.querySelectorAll('[data-module-tab]'));if(tabs.length<2)return;
          // Reuse a pre-existing progressive menu in a future source baseline.
          let more=bar.querySelector('details.module-more,details.restraint-module-more,details.simple-module-more');let items;
          if(more){more.classList.add('simple-module-more');items=more.querySelector('.module-more-items,.restraint-module-options,.restraint-module-more-items,.simple-module-more-items');}
          else{more=make('details','simple-module-more');more.id='simpleMore-'+name;add(more,'summary','','更多');bar.appendChild(more);}
          if(!items){items=add(more,'div','simple-module-more-items')}else items.classList.add('simple-module-more-items');
          const group={section,bar,tabs,more,items,primary,signature:undefined};simpleTabGroups.push(group);
          bar.addEventListener('keydown',event=>{
            const tab=event.target.closest('[data-module-tab]');
            if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
            const visible=Array.from(bar.querySelectorAll('[data-module-tab]')).filter(simpleVisibleTab);
            const index=visible.indexOf(tab);if(index<0||!visible.length)return;
            event.preventDefault();event.stopImmediatePropagation();
            const next=event.key==='Home'?0:event.key==='End'?visible.length-1:(index+(event.key==='ArrowRight'?1:-1)+visible.length)%visible.length;
            visible[next].focus();visible[next].click();
          },true);
          more.addEventListener('keydown',event=>{if(event.key==='Escape'&&more.open){event.preventDefault();event.stopPropagation();more.open=false;const summary=more.querySelector('summary');if(summary)summary.focus()}});
        });
        simpleUpdateModuleTabs();
      }
      const simplePresentationBaseApplyViewModules=applyViewModules;
      applyViewModules=function(name,source){const result=simplePresentationBaseApplyViewModules(name,source);simpleUpdateModuleTabs();return result};
      if(typeof applyAuthMode==='function'){
        const simplePresentationBaseApplyAuthMode=applyAuthMode;
        applyAuthMode=function(me){const result=simplePresentationBaseApplyAuthMode(me);simpleUpdateModuleTabs();return result};
      }
      document.addEventListener('click',event=>{
        document.querySelectorAll('.simple-module-more[open],.simple-inspection-options[open]').forEach(detail=>{if(!detail.contains(event.target))detail.open=false});
      });
      document.addEventListener('keydown',event=>{
        if(event.key!=='Escape')return;
        const target=event.target.closest('.simple-inspection-options');
        if(target&&target.open){event.preventDefault();target.open=false;const summary=target.querySelector('summary');if(summary)summary.focus()}
      });
      simplePresentationHeader();simpleInitModuleTabs();
`;
