/** Presentation-only final pass over the live overview and action renderers. */
export const OPS_OBSERVABILITY_SIMPLE_OVERVIEW_STYLE = `
    .simple-overview-detail{border:1px solid var(--line);border-radius:12px;background:var(--c2);min-width:0}
    .simple-overview-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;cursor:pointer;color:var(--text);list-style:none}
    .simple-overview-summary:before{content:'›';font-size:18px;transition:transform .15s}.simple-overview-detail[open]>.simple-overview-summary:before{transform:rotate(90deg)}
    .simple-overview-summary strong{font-size:13px}.simple-overview-summary span{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.simple-overview-summary .simple-overview-concern{color:var(--orange)}
    .simple-overview-summary:focus-visible{outline:2px solid var(--green);outline-offset:-3px;border-radius:12px}.simple-overview-content{padding:0 16px 16px;min-width:0}
    .simple-overview-content>.impact-grid,.simple-overview-content>.metrics{margin:0}.simple-overview-content>.north-star-panel{margin:0;box-shadow:none;border:0}
    .simple-overview-content>.action-loop-panel{margin:0;box-shadow:none;border:0;padding:4px 0 0}.simple-overview-summary>.action-loop-refresh{margin-left:auto}
    .simple-overview-detail+.simple-overview-detail{margin-top:12px}.simple-overview-guide{margin-top:12px}.simple-overview-guide>.simple-overview-content{font-size:11px;color:var(--muted)}
    .simple-overview-action-archive{margin-top:12px}.simple-overview-action-archive .action-loop-card+.action-loop-card{margin-top:10px}
    .simple-overview-metric-group:empty{display:none}.simple-overview-confirmation{padding:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted)}
    @media(max-width:640px){.simple-overview-summary{gap:7px;padding:12px}.simple-overview-summary span{flex-basis:100%;padding-left:18px}.simple-overview-summary>.action-loop-refresh{margin-left:auto}.simple-overview-content{padding:0 12px 12px}}
`;

export const OPS_OBSERVABILITY_SIMPLE_OVERVIEW_SCRIPT = `
      const simpleOverviewDisclosureState=new Map();
      function simpleOverviewScope(){
        const me=typeof obsAuthState==='object'&&obsAuthState?obsAuthState.me:null;
        const user=me&&me.user;
        const identity=user&&user.id!=null?String(user.id):'';
        const tenant=typeof obsActiveTenant==='function'?String(obsActiveTenant()||''):'';
        const snapshotTenant=state.overview&&state.overview.tenantScope;
        const snapshotScope=typeof snapshotTenant==='string'?snapshotTenant:(snapshotTenant&&typeof snapshotTenant==='object'?String(snapshotTenant.slug||snapshotTenant.tenantId||snapshotTenant.id||''):'');
        return JSON.stringify([identity,me&&me.admin===true,Boolean(typeof opsTenantMode!=='undefined'&&opsTenantMode),Boolean(typeof opsMemberMode!=='undefined'&&opsMemberMode),tenant,snapshotScope,String(state.domain||''),String(state.overviewHours||state.overview&&state.overview.windowHours||'')]);
      }
      function simpleOverviewRemember(root){
        const scope=simpleOverviewScope();
        const values=simpleOverviewDisclosureState.get(scope)||{};
        const active=document.activeElement;
        let focus='';
        if(root)root.querySelectorAll('details[data-simple-overview-key]').forEach(detail=>{
          if(detail.simpleOverviewScope!==scope)return;
          const key=detail.dataset.simpleOverviewKey;
          values[key]=Boolean(detail.open);
          const summary=detail.querySelector('summary');
          if(active===summary)focus=key;
        });
        simpleOverviewDisclosureState.set(scope,values);
        // Bound in-memory preferences; no account or disclosure state is persisted.
        while(simpleOverviewDisclosureState.size>64)simpleOverviewDisclosureState.delete(simpleOverviewDisclosureState.keys().next().value);
        return {scope:scope,focus:focus};
      }
      function simpleOverviewRestoreFocus(root,saved){
        if(!saved||!saved.focus||saved.scope!==simpleOverviewScope()||!root)return;
        const active=document.activeElement;
        if(active&&active!==document.body&&active.isConnected)return;
        const details=Array.from(root.querySelectorAll('details[data-simple-overview-key]')).find(detail=>detail.dataset.simpleOverviewKey===saved.focus&&detail.simpleOverviewScope===saved.scope);
        const summary=details&&details.querySelector('summary');
        if(summary&&typeof summary.focus==='function')summary.focus({preventScroll:true});
      }
      function simpleOverviewDetail(key,title,description,nodes,extraClass){
        const scope=simpleOverviewScope();
        const detail=make('details','simple-overview-detail '+(extraClass||''));
        detail.dataset.simpleOverviewKey=key;detail.simpleOverviewScope=scope;
        const values=simpleOverviewDisclosureState.get(scope);
        detail.open=Boolean(values&&values[key]);
        const summary=make('summary','simple-overview-summary');
        add(summary,'strong','',title);add(summary,'span','',description);
        detail.appendChild(summary);
        const content=make('div','simple-overview-content');
        nodes.filter(Boolean).forEach(node=>content.appendChild(node));detail.appendChild(content);
        detail.addEventListener('toggle',()=>{
          if(detail.simpleOverviewScope!==simpleOverviewScope())return;
          const saved=simpleOverviewDisclosureState.get(scope)||{};saved[key]=Boolean(detail.open);simpleOverviewDisclosureState.set(scope,saved);
        });
        return detail;
      }
      function simpleOverviewCounts(checks){
        const result={abnormal:0,unknown:0,stale:0,disabled:0,healthy:0};
        checks.forEach(check=>{const status=String(check&&check.status||'');if(['critical','warning','observing'].includes(status))result.abnormal++;else if(status==='stale')result.stale++;else if(status==='disabled')result.disabled++;else if(status==='healthy')result.healthy++;else result.unknown++});
        return result;
      }
      function simpleOverviewCountsText(counts){return [['异常',counts.abnormal],['未确认',counts.unknown],['过期',counts.stale],['停用',counts.disabled]].filter(item=>item[1]>0).map(item=>item[0]+' '+item[1]).join(' · ')}
      function simpleOverviewNumberKnown(value){return (typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))&&Number(value)>=0}
      function simpleOverviewMetricConfirmed(card,o){
        const value=card.querySelector('.value');const label=card.querySelector('.label');
        if(!value||!value.classList.contains('good')||!/^\\d[\\d,]*(?:\\.\\d+)?%?$/.test(String(value.textContent||'').trim()))return false;
        const signals=o.signals||{};const ai=o.ai||{};const summary=o.summary||{};
        switch(String(label&&label.textContent||'')){
          case 'AI 完成率':return simpleOverviewNumberKnown(ai.successRate)&&Number(ai.successRate)<=1&&simpleOverviewNumberKnown(ai.total)&&Number(ai.total)>0&&simpleOverviewNumberKnown(ai.errors)&&Number(ai.errors)===0;
          case '工具失败':return simpleOverviewNumberKnown(signals.toolFailures)&&Number(signals.toolFailures)===0;
          case '系统错误':return ['clientErrors','api5xx','processErrors','loginInfrastructureErrors'].every(key=>simpleOverviewNumberKnown(signals[key])&&Number(signals[key])===0);
          case '进行中告警':return simpleOverviewNumberKnown(summary.openIncidents)&&Number(summary.openIncidents)===0;
          default:return false;
        }
      }
      function simpleOverviewActionPresentation(){
        const mount=$('actionLoopMount');const panel=mount&&mount.querySelector('.action-loop-panel');
        if(!mount||!panel||panel.dataset.simpleOverviewPrepared==='true')return;
        panel.dataset.simpleOverviewPrepared='true';
        const loop=state.actionLoop||{};const actions=Array.isArray(loop.actions)?loop.actions:[];
        const body=panel.querySelector('.action-loop-body');
        const flow=panel.querySelector('.action-loop-flow');const note=panel.querySelector('.action-loop-note');
        const identity=panel.querySelector('.action-loop-identity');const guideCopy=identity&&identity.querySelector('p');const kicker=panel.querySelector('.action-loop-kicker');
        if(body&&(flow||note||guideCopy||kicker))body.appendChild(simpleOverviewDetail('action-guide','行动流程与安全说明','证据 → 审批 → 执行 → 验证 → 回归',[guideCopy,kicker,flow,note],'simple-overview-guide'));
        // Only recorded/denied actions may be archived. Verified, failed and
        // unrecognised states retain their genuine controls at the first level.
        const archived=Array.from(panel.querySelectorAll('.action-loop-card')).filter(card=>['completed','denied'].includes(String(card.dataset.status||'')));
        if(body&&archived.length)body.appendChild(simpleOverviewDetail('action-archive','已记录与已拒绝',archived.length+' 条行动 · 保留证据与审计',archived,'simple-overview-action-archive'));
        if(!loop.loaded&&!loop.loading&&!loop.error){
          const empty=panel.querySelector('.action-loop-empty');const strong=empty&&empty.querySelector('strong');const description=empty&&empty.querySelector('span');
          if(strong)strong.textContent='行动状态尚未确认';if(description)description.textContent='尚未取得当前账号的行动快照；请刷新后确认，不能据此判断没有待办。';
          if(body&&!empty){const notice=make('div','simple-overview-confirmation','行动快照尚未确认；以下保留已读记录，请刷新后确认当前状态。');notice.setAttribute('role','status');body.insertBefore(notice,body.children[0]||null)}
        }
        const confirmedEmpty=loop.loaded===true&&!loop.loading&&!loop.error&&!loop.mutationError&&!loop.busyId&&actions.length===0;
        if(confirmedEmpty){
          const detail=simpleOverviewDetail('action-empty','行动闭环','当前无待处理行动',[panel],'simple-overview-action-empty');
          const refresh=panel.querySelector('.action-loop-refresh');if(refresh)detail.querySelector('summary').appendChild(refresh);
          mount.appendChild(detail);
        }
      }
      function simpleOverviewPresentation(){
        const root=$('overviewContent');const o=state.overview;if(!root||!o)return;
        const actionCenter=Array.from(root.children).find(node=>node.querySelector&&Array.from(node.querySelectorAll('h2')).some(heading=>heading.textContent==='运营行动中心'));
        if(actionCenter)actionCenter.querySelectorAll('a').forEach(link=>{if(String(link.textContent||'').includes('进入事故工作台')&&link.getAttribute('href')==='#overview')link.setAttribute('href','#alerts/center')});
        const mount=$('actionLoopMount');if(mount&&mount.parentNode===root&&actionCenter&&actionCenter.nextSibling!==mount)root.insertBefore(mount,actionCenter.nextSibling);
        const metrics=Array.from(root.children).find(node=>node.classList&&node.classList.contains('metrics'));
        if(metrics&&!metrics.dataset.simpleOverviewPrepared){
          metrics.dataset.simpleOverviewPrepared='true';metrics.classList.add('simple-overview-metric-group');
          const cards=Array.from(metrics.children).filter(card=>simpleOverviewMetricConfirmed(card,o));
          if(cards.length){const inner=make('div','metrics');cards.forEach(card=>inner.appendChild(card));const detail=simpleOverviewDetail('runtime-metrics','运行指标',cards.length+' 项已确认正常 · 完整数值按需查看',[inner]);root.insertBefore(detail,metrics.nextSibling)}
        }
        const impact=Array.from(root.children).find(node=>node.classList&&node.classList.contains('impact-grid'));
        if(impact){
          const checks=Array.isArray(o.checks)?o.checks:[];const serviceChecks=checks.filter(check=>!String(check.key||'').startsWith('north-star-'));const service=simpleOverviewCounts(serviceChecks);
          const alerting=o.alerting||{};const checkedAt=new Date(alerting.lastCheckedAt||'').getTime();
          const freshness=!Number.isFinite(checkedAt)?'巡检时间未确认':alerting.status==='stale'?'巡检已过期':!['healthy','warning','critical'].includes(String(alerting.status||''))?'巡检状态未确认 · 最近评估 '+when(alerting.lastCheckedAt):'最近评估 '+when(alerting.lastCheckedAt);
          const warnings=impact.querySelectorAll('.value.warn,.value.bad').length;
          const concerns=[serviceChecks.length?simpleOverviewCountsText(service):'服务检查未确认 · 暂无快照',warnings?'观测待确认 '+warnings:'',!Number.isFinite(checkedAt)||alerting.status!=='healthy'?freshness:''].filter(Boolean);
          const description=concerns.length?concerns.join(' · '):serviceChecks.length+' 项检查 · 未见异常';
          const detail=simpleOverviewDetail('service-health','服务与观测健康',description,[impact]);
          if(!serviceChecks.length||service.abnormal||service.unknown||service.stale||service.disabled||warnings||!Number.isFinite(checkedAt)||!['healthy','warning','critical'].includes(String(alerting.status||'')))detail.querySelector('summary').querySelector('span').classList.add('simple-overview-concern');
          root.insertBefore(detail,root.querySelector('.detail-sections'));
        }
        const product=Array.from(root.children).find(node=>node.classList&&node.classList.contains('north-star-panel'));
        if(product){
          const checks=(Array.isArray(o.checks)?o.checks:[]).filter(check=>String(check.key||'').startsWith('north-star-'));
          const counts=simpleOverviewCounts(checks);
          // The original cockpit additionally treats missing values/small samples
          // as unknown and below-target cards as a concern. Reflect both safely.
          const unknownCards=product.querySelectorAll('.north-star-card.unknown').length;const targetMiss=product.querySelectorAll('.north-star-card.target-miss').length;
          counts.unknown=Math.max(counts.unknown,unknownCards);
          const concerns=[simpleOverviewCountsText(counts),targetMiss?'未达产品目标 '+targetMiss:''].filter(Boolean);
          const description=!checks.length?'未确认 · 产品快照尚未接入':concerns.length?concerns.join(' · '):checks.length+' 项指标 · 未见异常 · 产品目标见详情';
          const detail=simpleOverviewDetail('product-health','产品健康',description,[product]);
          if(!checks.length||counts.abnormal||counts.unknown||counts.stale||counts.disabled||targetMiss)detail.querySelector('summary').querySelector('span').classList.add('simple-overview-concern');
          root.insertBefore(detail,root.querySelector('.detail-sections'));
        }
        simpleOverviewActionPresentation();
      }
      const simpleOverviewBaseRenderActionLoopMount=renderActionLoopMount;
      renderActionLoopMount=function(){const root=$('actionLoopMount');const saved=simpleOverviewRemember(root);const result=simpleOverviewBaseRenderActionLoopMount.apply(this,arguments);simpleOverviewActionPresentation();simpleOverviewRestoreFocus($('actionLoopMount'),saved);return result};
      const simpleOverviewBaseRenderOverview=renderOverview;
      renderOverview=function(){const root=$('overviewContent');const saved=simpleOverviewRemember(root);const result=simpleOverviewBaseRenderOverview.apply(this,arguments);simpleOverviewPresentation();simpleOverviewRestoreFocus($('overviewContent'),saved);return result};
`;
