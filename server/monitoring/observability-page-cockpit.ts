/**
 * Operations cockpit additions for the observability workspace.
 *
 * This module intentionally stays inside the existing safe-DOM renderer. It does not add
 * data sources or mutation paths; it only turns the existing low-sensitivity check snapshot
 * into an impact-first product-health section.
 */
export const OPS_OBSERVABILITY_COCKPIT_STYLE = `
    .module-tab[data-view="service-levels"]:before{content:"◒"}
    .scope-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;margin:-5px 0 14px;border:1px solid var(--c343);border-radius:9px;background:var(--c2);box-shadow:0 2px 8px var(--c344)}
    .scope-copy{display:flex;align-items:baseline;gap:7px;min-width:190px}.scope-copy strong{font-size:12px;color:var(--c45)}.scope-copy span{font-size:10px;color:var(--muted)}.scope-copy small{font-size:10px;color:var(--muted)}
    .scope-control{display:flex;align-items:center;gap:6px;margin-left:auto;color:var(--muted);font-size:10px}.scope-control select{height:29px;border:1px solid var(--line2);border-radius:6px;background:var(--c2);color:var(--text);padding:3px 8px;outline:none}.scope-control select:focus{border-color:var(--green);box-shadow:0 0 0 2px var(--c23)}
    .scope-status{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:10px}.scope-status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c19)}.scope-status.stale:before{background:var(--orange)}
    .north-star-panel{padding:16px}.north-star-panel .section-head{margin-bottom:12px}.north-star-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.north-star-card{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--c113);text-align:left}.north-star-card.warning{border-color:var(--c345);background:var(--c55)}.north-star-card.critical{border-color:var(--c346);background:var(--c53)}.north-star-card.unknown{border-color:var(--c347);background:var(--c268)}.north-star-head{display:flex;align-items:center;gap:7px;min-width:0}.north-star-head strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.north-star-head .status-chip{margin-left:auto}.north-star-value{font-size:23px;font-weight:650;line-height:1;color:var(--c26)}.north-star-card.warning .north-star-value{color:var(--orange)}.north-star-card.critical .north-star-value{color:var(--red)}.north-star-card.unknown .north-star-value{color:var(--c282)}.north-star-meta{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:9px}.north-star-bar{height:5px;border-radius:99px;background:var(--c178);overflow:hidden}.north-star-bar span{display:block;height:100%;border-radius:99px;background:var(--green)}.north-star-card.warning .north-star-bar span{background:var(--orange)}.north-star-card.critical .north-star-bar span{background:var(--red)}.north-star-card.unknown .north-star-bar span{background:var(--c348);width:0!important}
    .impact-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:12px}.impact-panel{padding:16px}.impact-list{display:grid;gap:7px}.impact-row{display:grid;grid-template-columns:minmax(150px,1.2fr) 74px minmax(130px,1fr) auto;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--c113)}.impact-row strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.impact-row small{display:block;color:var(--muted);font-size:9px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.impact-row .impact-value{font-size:12px;font-weight:650;text-align:right}.impact-row .impact-signal{color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.impact-row .btn{height:27px;padding:3px 9px;font-size:10px}.impact-row.critical{border-color:var(--c52);background:var(--c53)}.impact-row.warning{border-color:var(--c54);background:var(--c55)}.impact-empty{padding:20px;text-align:center;color:var(--muted);font-size:11px;border:1px dashed var(--line2);border-radius:7px}
    @media(max-width:1100px){.north-star-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.impact-grid{grid-template-columns:1fr}}
    @media(max-width:640px){.scope-bar{align-items:flex-start;flex-direction:column}.scope-control{margin-left:0}.north-star-grid{grid-template-columns:1fr}.impact-row{grid-template-columns:minmax(0,1fr) auto}.impact-row .impact-signal{grid-column:1/-1}.impact-row .btn{grid-column:2;grid-row:1}}
`;

export const OPS_OBSERVABILITY_COCKPIT_SCRIPT = `
      function cockpitNorthStarName(key){return ({'north-star-skill-hit-rate':'Skill 命中率','north-star-ai-human-consistency':'AI-人工一致率','north-star-retention-d1':'D1 次日留存','north-star-first-success-rate':'首次成功率'})[key]||key}
      function cockpitStatus(status,unknown){return unknown?'unknown':(status==='critical'?'critical':(status==='warning'||status==='observing'?'warning':'healthy'))}
      function cockpitStatusLabel(status,targetMiss){if(status==='healthy'&&targetMiss)return '低于目标';return ({healthy:'正常',warning:'需关注',critical:'需处置',unknown:'样本不足'})[status]||status}
      function cockpitPercent(summary){const match=String(summary||'').match(/(?:^|[^0-9])([0-9]+(?:\\.[0-9]+)?)%/);return match?Number(match[1]):null}
      function cockpitSamples(summary){const match=String(summary||'').match(/样本\\s*(?:≥|=)?\\s*([0-9,]+)/);return match?Number(match[1].replace(/,/g,'')):null}
      function cockpitTarget(summary){const match=String(summary||'').match(/产品目标\\s*≥\\s*([0-9]+(?:\\.[0-9]+)?)%/);return match?Number(match[1]):null}
      function cockpitAlertBand(summary){const match=String(summary||'').match(/预警\\s*<\\s*([0-9]+(?:\\.[0-9]+)?)%/);return match?Number(match[1]):null}
      function cockpitFreshness(value,status){if(!value)return['未确认','暂无最近评估时间','warn'];const time=new Date(value).getTime();const age=Math.max(0,Date.now()-time);if(!Number.isFinite(time))return['未确认','评估时间无效','warn'];const minutes=Math.floor(age/60000);const label=minutes<1?'刚刚':minutes<60?minutes+' 分钟前':Math.floor(minutes/60)+' 小时前';return[label,'最近评估 '+when(value),status==='stale'?'warn':'good']}
      function cockpitNorthStarChecks(o){return overviewChecks(o).filter(check=>String(check.key||'').startsWith('north-star-'))}
      function renderNorthStarCockpit(o){
        const panel=make('section','panel north-star-panel');
        panel.setAttribute('aria-labelledby','northStarHeading');
        const head=make('div','section-head');
        const copy=make('div');
        const heading=add(copy,'h2','','产品健康 / 北极星指标');heading.id='northStarHeading';
        add(copy,'div','hint','与线上可靠性分开观察；样本不足显示为未知，不伪装成健康。');
        head.appendChild(copy);
        add(head,'div','right',cockpitNorthStarChecks(o).length+' 项 · 6 小时快照');
        panel.appendChild(head);
        const grid=make('div','north-star-grid');
        const checks=cockpitNorthStarChecks(o);
        if(!checks.length){panel.appendChild(make('div','impact-empty','北极星快照尚未接入；数据可用后会自动显示。'));return panel}
        checks.forEach(check=>{
          const value=cockpitPercent(check.summary);
          const unknown=check.status==='unknown'||value==null||/不可用|暂不评估|样本不足/.test(String(check.summary||''));
          const status=cockpitStatus(check.status,unknown);
          const samples=cockpitSamples(check.summary);
          const target=cockpitTarget(check.summary);const alertBand=cockpitAlertBand(check.summary);const targetMiss=target!=null&&value!=null&&value<target;
          const card=make('article','north-star-card '+status+(targetMiss?' target-miss':''));
          const top=make('div','north-star-head');top.appendChild(make('span','state-dot '+(status==='unknown'?'disabled':status)));add(top,'strong','',cockpitNorthStarName(check.key));add(top,'span','status-chip',cockpitStatusLabel(status,targetMiss));card.appendChild(top);
          add(card,'div','north-star-value',value==null?'—':value.toFixed(1)+'%');
          const bar=make('div','north-star-bar');const fill=make('span');fill.style.width=value==null?'0%':Math.max(0,Math.min(100,value))+'%';bar.appendChild(fill);card.appendChild(bar);
          const meta=make('div','north-star-meta');add(meta,'span','',samples==null?'样本待接入':'样本 '+fmt(samples));add(meta,'span','',check.checkedAt?'更新 '+when(check.checkedAt):'暂无更新时间');card.appendChild(meta);
          if(target!=null||alertBand!=null){const targetRow=make('div','north-star-target');add(targetRow,'span','',target!=null?'产品目标 ≥ '+target+'%':'');add(targetRow,'span',targetMiss?'target-miss':'',targetMiss?'尚未达标':(alertBand!=null?'预警 < '+alertBand+'%':'告警未触发'));card.appendChild(targetRow)}
          add(card,'div','check-summary',unknown?'样本不足，暂不评估':(check.summary||'暂无摘要'));grid.appendChild(card);
        });
        panel.appendChild(grid);return panel;
      }
      function cockpitDomain(check){const key=String(check.key||'');if(key.includes('tool'))return '工具链';if(key.includes('ai-run')||key.includes('moss-model'))return 'Agent Runtime';if(key.includes('login')||key.includes('sso'))return '账号与会话';if(key.includes('postgres')||key.includes('database'))return '中心数据库';if(key.includes('probe')||check.category==='probe')return '用户旅程拨测';if(key.includes('north-star'))return '产品健康';return check.category==='log'?'应用日志':'平台基础设施'}
      function renderImpactCockpit(o){
        const wrapper=make('div','impact-grid');
        const panel=make('section','panel impact-panel');
        const head=make('div','section-head');const copy=make('div');add(copy,'h2','','影响面与服务域');add(copy,'div','hint','将同一类异常聚合到可处理的服务域，避免只看孤立规则。');head.appendChild(copy);add(head,'div','right','异常优先');panel.appendChild(head);
        const list=make('div','impact-list');
        const grouped=new Map();overviewChecks(o).filter(check=>['critical','warning','observing'].includes(check.status)).forEach(check=>{const domain=cockpitDomain(check);const entry=grouped.get(domain)||{domain,critical:0,warning:0,pending:0,checks:[]};if(check.status==='critical')entry.critical++;else if(check.status==='warning')entry.warning++;else entry.pending++;entry.checks.push(check);grouped.set(domain,entry)});
        const rows=[...grouped.values()].sort((a,b)=>b.critical-a.critical||b.warning-a.warning||b.pending-a.pending);
        if(!rows.length){list.appendChild(make('div','impact-empty','当前没有需要处置的异常服务域。'));}
        rows.slice(0,6).forEach(entry=>{const severity=entry.critical?'critical':'warning';const row=make('article','impact-row '+severity);const label=make('div');add(label,'strong','',entry.domain);add(label,'small','',entry.checks.slice(0,2).map(check=>check.title).join('、'));row.appendChild(label);add(row,'div','impact-value',entry.critical?'严重':entry.warning+' 项告警');add(row,'div','impact-signal',entry.pending?'另有 '+entry.pending+' 项 Pending':'已进入处置状态');const button=add(row,'button','btn '+(entry.critical?'primary':''),'查看证据');button.type='button';button.addEventListener('click',()=>{state.investigationQuery=entry.domain;state.investigationOutcome='problem';setView('investigate');renderInvestigation(state.investigationOverview||state.overview);window.scrollTo({top:0,behavior:'smooth'})});row.appendChild(button);list.appendChild(row)});
        panel.appendChild(list);wrapper.appendChild(panel);
        const data=make('section','panel impact-panel');const dataHead=make('div','section-head');const dataCopy=make('div');add(dataCopy,'h2','','观测系统健康');add(dataCopy,'div','hint','先确认数据可信，再判断业务是否健康。');dataHead.appendChild(dataCopy);data.appendChild(dataHead);const stats=make('div','metrics impact-health-metrics');const signals=o.signals||{};const total=overviewNumber(signals.totalEvents);const freshness=cockpitFreshness(o.alerting&&o.alerting.lastCheckedAt,o.alerting&&o.alerting.status);[['Telemetry 事件',fmt(total),total?'已接收':'暂无事件',total?'good':'warn'],['巡检新鲜度',freshness[0],freshness[1],freshness[2]],['Trace 覆盖',o.runTraces&&o.runTraces.length?fmt(o.runTraces.length)+' 条':'—','窗口内原生运行证据',o.runTraces&&o.runTraces.length?'good':'warn']].forEach(item=>{const card=make('div','metric');add(card,'div','label',item[0]);add(card,'div','value '+item[3],item[1]);add(card,'div','detail',item[2]);stats.appendChild(card)});data.appendChild(stats);wrapper.appendChild(data);return wrapper;
      }
      const cockpitBaseRenderOverview=renderOverview;
      renderOverview=function(){cockpitBaseRenderOverview();const root=$('overviewContent');if(!root||!state.overview)return;const firstDetail=root.querySelector('.detail-sections');const impact=renderImpactCockpit(state.overview);if(firstDetail)root.insertBefore(impact,firstDetail);else root.appendChild(impact);const northStar=renderNorthStarCockpit(state.overview);if(firstDetail)root.insertBefore(northStar,firstDetail);else root.appendChild(northStar);const selectedHours=state.overviewHours||state.overview.windowHours||24;const windowSelect=$('overviewWindow');if(windowSelect)windowSelect.value=String(selectedHours);const windowLabel=$('overviewWindowLabel');if(windowLabel)windowLabel.textContent='总览 / SLO / Trace · 最近 '+selectedHours+' 小时'};
`;
