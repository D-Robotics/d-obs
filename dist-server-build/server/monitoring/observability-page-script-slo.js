export const OPS_OBSERVABILITY_SCRIPT_SLO = `      function renderServiceLevels(){
        const root=$('serviceLevelContent');
        if(!root)return;
        root.replaceChildren();
        const data=state.overview&&state.overview.serviceLevels;
        if(!data){
          root.appendChild(make('div','panel empty','服务等级数据暂不可用'));
          return;
        }
        const statusLabels={healthy:'达标',at_risk:'预算告急',budget_exhausted:'SLO 未达标',sla_breached:'低于 SLA 参考线',no_data:'样本不足'};
        // Older preview/edge responses may omit one of the optional SLO
        // aggregates.  Keep the module useful instead of throwing while the
        // rest of the observability workbench continues to render.
        const summary=Object.assign({total:0,healthy:0,atRisk:0,exhausted:0,slaBreached:0,noData:0},data.summary||{});
        const overallClass=(summary.slaBreached||summary.exhausted)?'critical':((summary.atRisk||summary.noData)?'warning':'healthy');
        const hero=make('section','panel hero '+overallClass);
        add(hero,'div','hero-icon',overallClass==='healthy'?'✓':'!');
        const heroBody=make('div');
        add(heroBody,'div','hero-title',overallClass==='healthy'?'核心服务目标全部达标':'服务等级需要关注');
        add(heroBody,'div','hero-detail',summary.healthy+'/'+summary.total+' 项达标 · '+summary.atRisk+' 项预算告急 · '+(summary.exhausted+summary.slaBreached)+' 项未达标');
        hero.appendChild(heroBody);
        const heroRight=make('div','right','28 天滚动窗口');
        add(heroRight,'div','',data.policy.fastWindowMinutes+' / '+data.policy.slowWindowMinutes+' 分钟燃烧率');
        hero.appendChild(heroRight);
        root.appendChild(hero);

        const metrics=make('div','metrics');
        [
          ['核心目标',summary.total,'28 天滚动',''],
          ['当前达标',summary.healthy,'满足 SLO','good'],
          ['预算告急',summary.atRisk,'剩余低或燃烧 > 1x',summary.atRisk?'warn':'good'],
          ['目标未达',summary.exhausted+summary.slaBreached,'含 SLA 参考线',summary.exhausted+summary.slaBreached?'bad':'good'],
          ['样本不足',summary.noData,'达到门槛后判定',summary.noData?'warn':'good']
        ].forEach(item=>{const card=make('div','panel metric');add(card,'div','label',item[0]);add(card,'div','value '+item[3],item[1]);add(card,'div','detail',item[2]);metrics.appendChild(card)});
        root.appendChild(metrics);
        root.appendChild(make('div','notice',data.policy.slaNote+' 当前策略为 baseline，目标调整应经过业务负责人评审。'));

        const grid=make('div','slo-grid');
        (Array.isArray(data.objectives)?data.objectives:[]).forEach(item=>{
          const card=make('article','panel slo-card '+item.status);
          const head=make('div','slo-head');
          const title=make('div');
          add(title,'h3','',item.title);
          add(title,'p','',item.userJourney);
          head.appendChild(title);
          add(head,'span','status-chip slo-status '+item.status,statusLabels[item.status]||item.status);
          card.appendChild(head);

          const score=make('div','slo-score');
          const scoreMain=make('div');
          add(scoreMain,'span','','当前 SLI');
          add(scoreMain,'strong','',item.compliancePercent==null?'—':Number(item.compliancePercent).toFixed(3)+'%');
          score.appendChild(scoreMain);
          const targets=make('div','slo-targets');
          add(targets,'div','','SLO '+item.targetPercent+'%');
          add(targets,'div','','SLA 参考 '+item.slaReferencePercent+'%');
          score.appendChild(targets);
          card.appendChild(score);

          const budget=make('div','slo-budget');
          const budgetHead=make('div','slo-budget-head');
          add(budgetHead,'span','','错误预算剩余');
          const errorBudget=Object.assign({remainingPercent:null,allowedBad:0,remainingBad:0},item.errorBudget||{});
          const burnRate=Object.assign({fast:null,slow:null},item.burnRate||{});
          const remaining=errorBudget.remainingPercent;
          add(budgetHead,'strong','',remaining==null?'—':Number(remaining).toFixed(1)+'%');
          budget.appendChild(budgetHead);
          const track=make('div','budget-track');
          const fill=make('div','budget-fill '+(remaining==null?'unknown':remaining<0?'bad':remaining<25?'warn':'good'));
          fill.style.width=Math.max(0,Math.min(100,Number(remaining)||0))+'%';
          track.appendChild(fill);
          budget.appendChild(track);
          add(budget,'small','',Number(item.badCount||0)+' 次坏事件 / 允许 '+Number(errorBudget.allowedBad).toFixed(2)+' 次 · 剩余 '+Number(errorBudget.remainingBad).toFixed(2));
          card.appendChild(budget);

          const facts=make('div','slo-facts');
          [
            ['样本',item.sampleCount+' / 最少 '+item.minimumSamples],
            ['1h 燃烧',burnRate.fast==null?'—':Number(burnRate.fast).toFixed(2)+'x'],
            ['6h 燃烧',burnRate.slow==null?'—':Number(burnRate.slow).toFixed(2)+'x'],
            ['负责人',item.owner]
          ].forEach(fact=>{const box=make('div');add(box,'span','',fact[0]);add(box,'strong','',fact[1]);facts.appendChild(box)});
          card.appendChild(facts);
          const details=make('details','slo-definition');
          add(details,'summary','','查看 SLI 定义与数据源');
          add(details,'p','',item.sliDescription);
          add(details,'p','','好事件：'+item.goodEvent);
          add(details,'p','','总事件：'+item.totalEvent);
          add(details,'p','','数据源：'+item.source);
          card.appendChild(details);
          grid.appendChild(card);
        });
        root.appendChild(grid);
      }
`;
