export const OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE = `
    .operator-metrics-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}
    .operator-metrics-toolbar .segmented{display:inline-flex;gap:4px;flex-wrap:wrap}
    .operator-metrics-toolbar .segmented button{min-height:30px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--c2);color:var(--muted);font-size:10px;cursor:pointer}
    .operator-metrics-toolbar .segmented button.active{border-color:var(--c79);background:var(--c12);color:var(--green);font-weight:650}
    .operator-metrics-toolbar .segmented button:focus-visible{outline:2px solid var(--c11);outline-offset:1px}
    .operator-metrics-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:12px}
    .operator-metrics-kpi{min-width:0;padding:14px 15px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
    .operator-metrics-kpi .label{color:var(--muted);font-size:10px}
    .operator-metrics-kpi .value{margin-top:5px;color:var(--text);font-size:23px;font-weight:700;letter-spacing:-.02em}
    .operator-metrics-kpi .detail{margin-top:4px;color:var(--muted);font-size:10px;line-height:1.45}
    .operator-metrics-kpi.token .value{color:var(--c3)}.operator-metrics-kpi.user .value{color:var(--c336)}.operator-metrics-kpi.conversation .value{color:var(--c337)}.operator-metrics-kpi.run .value{color:var(--c338)}
    .operator-metrics-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:12px;margin-bottom:12px}
    .operator-metrics-chart{min-width:0;padding:15px 16px}.operator-metrics-chart h2{margin:0;font-size:13px}.operator-metrics-chart .hint{margin-top:3px}
    .operator-metrics-bars{display:grid;gap:7px;margin-top:14px}
    .operator-metrics-bar-row{display:grid;grid-template-columns:68px minmax(0,1fr) 78px;align-items:center;gap:8px;font-size:10px}
    .operator-metrics-bar-label{color:var(--muted);font-variant-numeric:tabular-nums}
    .operator-metrics-bar-track{height:11px;border-radius:3px;background:var(--c339);overflow:hidden}
    .operator-metrics-bar-fill{height:100%;min-width:2px;border-radius:3px;background:linear-gradient(90deg,var(--c340),var(--c341))}
    .operator-metrics-bar-value{color:var(--text);text-align:right;font-variant-numeric:tabular-nums}
    .operator-metrics-side{display:grid;gap:10px;align-content:start}
    .operator-metrics-side .source-card{padding:13px 14px;border:1px solid var(--line);border-radius:8px;background:var(--c113)}
    .operator-metrics-side h3{margin:0;font-size:11px}.operator-metrics-side p{margin:5px 0 0;color:var(--muted);font-size:10px;line-height:1.5}
    .operator-metrics-note{padding:10px 12px;border:1px dashed var(--c119);border-radius:7px;background:var(--c57);color:var(--muted);font-size:10px;line-height:1.5}
    .operator-metrics-table .scroll{max-height:420px}.operator-metrics-table table{min-width:760px}
    .operator-metrics-table td,.operator-metrics-table th{font-variant-numeric:tabular-nums}
    .operator-metrics-empty{padding:18px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:11px}
    .operator-dispatch-panel{padding:15px 16px;margin-top:12px}.operator-dispatch-panel h2{margin:0;font-size:13px}.operator-dispatch-panel .hint{margin-top:3px}
    .operator-dispatch-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-top:12px}.operator-dispatch-kpi{padding:11px 12px;border:1px solid var(--line);border-radius:7px;background:var(--c113)}.operator-dispatch-kpi .label{color:var(--muted);font-size:10px}.operator-dispatch-kpi .value{margin-top:4px;font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}.operator-dispatch-kpi .detail{margin-top:3px;color:var(--muted);font-size:10px}.operator-dispatch-kpi.good .value{color:var(--c3)}.operator-dispatch-kpi.warn .value{color:var(--c338)}
    .operator-dispatch-table{margin-top:12px}.operator-dispatch-table .scroll{max-height:300px}.operator-dispatch-table table{min-width:820px}
    .operator-model-token-panel{padding:15px 16px;margin-top:12px}.operator-model-token-panel h2{margin:0;font-size:13px}.operator-model-token-panel .hint{margin-top:3px}
    .operator-model-token-rows{display:grid;gap:7px;margin-top:14px}
    .operator-model-token-row{display:grid;grid-template-columns:minmax(120px,220px) minmax(0,1fr) 90px 110px;align-items:center;gap:10px;font-size:10px}
    .operator-model-token-name{color:var(--text);font:10px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .operator-model-token-track{height:11px;border-radius:3px;background:var(--c339);overflow:hidden}
    .operator-model-token-fill{height:100%;min-width:2px;border-radius:3px;background:linear-gradient(90deg,var(--c337),var(--c342))}
    .operator-model-token-value{color:var(--text);text-align:right;font-variant-numeric:tabular-nums}
    .operator-model-token-detail{color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
    @media(max-width:1200px){.operator-metrics-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.operator-metrics-grid{grid-template-columns:1fr}}
    @media(max-width:1200px){.operator-dispatch-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:620px){.operator-metrics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.operator-dispatch-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.operator-metrics-bar-row{grid-template-columns:56px minmax(0,1fr) 66px}.operator-metrics-kpi .value{font-size:20px}}
`;

export const OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS = `
      function operatorMetricNumber(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
      function operatorMetricFmt(value){return operatorMetricNumber(value).toLocaleString('zh-CN')}
      function operatorMetricPercent(value){const parsed=Number(value);return Number.isFinite(parsed)?(parsed*100).toFixed(1)+'%':'—'}
      function operatorMetricDay(value){const text=String(value||'');return text.length>=10?text.slice(5):text||'—'}
      function operatorMetricRows(metrics){return Array.isArray(metrics&&metrics.daily)?metrics.daily.slice().sort((a,b)=>String(a.day).localeCompare(String(b.day))):[]}
      function renderOperatorMetrics(root){
        if(!root)return;
        root.replaceChildren();
        const metrics=state.operatorMetrics&&state.operatorMetrics.metrics;
        if(!metrics){
          const notice=make('div','operator-metrics-empty','运营指标暂未接入：请确认中心库已配置，并重试读取。');
          root.appendChild(notice);return;
        }
        const windowLabel=$('operatorMetricsWindowLabel');if(windowLabel)windowLabel.textContent='近 '+operatorMetricNumber(metrics.windowDays)+' 天 · 低敏聚合';
        const rows=operatorMetricRows(metrics);
        if(!rows.length){
          root.appendChild(make('div','operator-metrics-empty','当前窗口没有可展示的运营样本；数据写入后会自动出现在这里。'));return;
        }
        const toolbar=make('div','operator-metrics-toolbar');
        const windowCopy=make('div');add(windowCopy,'strong','', '近 '+operatorMetricNumber(metrics.windowDays)+' 天 · 运营低敏聚合');add(windowCopy,'div','hint','新增用户剔除迁移导入；token 按 run_id 去重后汇总。');toolbar.appendChild(windowCopy);
        const segmented=make('div','segmented');
        [7,30,90].forEach(days=>{const button=add(segmented,'button',days===operatorMetricNumber(metrics.windowDays)?'active':'',days+' 天');button.type='button';button.addEventListener('click',()=>loadOperatorMetrics(false,days))});
        toolbar.appendChild(segmented);root.appendChild(toolbar);
        const totals=metrics.totals||{};
        const kpis=make('div','operator-metrics-kpis');
        const cards=[
          ['token','Moss token 消耗',operatorMetricFmt(totals.totalTokens),'Prompt '+operatorMetricFmt(totals.promptTokens)+' · Completion '+operatorMetricFmt(totals.completionTokens)],
          ['user','新增用户',operatorMetricFmt(totals.newAccounts),'窗口总计 · 日峰值 '+operatorMetricFmt(Math.max(...rows.map(row=>operatorMetricNumber(row.newAccounts)),0))],
          ['conversation','对话次数',operatorMetricFmt(totals.conversations),'当前选定窗口总计'],
          ['run','Agent Run',operatorMetricFmt(totals.runs),'当前选定窗口总计'],
          ['','日活峰值',operatorMetricFmt(totals.activeUsersPeak),'当前选定窗口 DAU 峰值'],
        ];
        cards.forEach(item=>{const card=make('section','operator-metrics-kpi '+item[0]);add(card,'div','label',item[1]);add(card,'div','value',item[2]);add(card,'div','detail',item[3]);kpis.appendChild(card)});root.appendChild(kpis);
        const grid=make('div','operator-metrics-grid');
        const chart=make('section','panel operator-metrics-chart');add(chart,'h2','', '每日 token 消耗');add(chart,'div','hint','以 token 总量展示趋势，右侧为当日精确值。');
        const bars=make('div','operator-metrics-bars');const chartRows=rows.slice(-14);const maxTokens=Math.max(...chartRows.map(row=>operatorMetricNumber(row.totalTokens)),1);
        chartRows.forEach(row=>{const line=make('div','operator-metrics-bar-row');add(line,'span','operator-metrics-bar-label',operatorMetricDay(row.day));const track=make('div','operator-metrics-bar-track');const fill=make('div','operator-metrics-bar-fill');fill.style.width=Math.max(2,Math.round(operatorMetricNumber(row.totalTokens)/maxTokens*100))+'%';fill.title=operatorMetricFmt(row.totalTokens)+' tokens';track.appendChild(fill);line.appendChild(track);add(line,'span','operator-metrics-bar-value',operatorMetricFmt(row.totalTokens));bars.appendChild(line)});chart.appendChild(bars);grid.appendChild(chart);
        const sources=metrics.sources||{};const side=make('div','operator-metrics-side');[['指标口径',(sources.tokens||'token 来自 agent_run_records')+'；'+(sources.activity||'对话来自 conversation_turns')+'；'+(sources.accounts||'新增来自 credit_account')],['调度口径',sources.dispatch||'agent_dispatch_plan 规范化 receipt，仅聚合标签、结果与耗时'],['数据窗口','当前返回近 '+operatorMetricNumber(metrics.windowDays)+' 天；可切换 7 / 30 / 90 天。'],['数据新鲜度','页面刷新时重新读取中心库，不缓存用户身份或对话正文。']].forEach(item=>{const card=make('section','source-card');add(card,'h3','',item[0]);add(card,'p','',item[1]);side.appendChild(card)});grid.appendChild(side);root.appendChild(grid);
        const table=buildTable('每日运营明细',['日期','新增用户','DAU','对话次数','Agent Run','Prompt token','Completion token','总 token'],rows.slice().reverse().map(row=>[operatorMetricDay(row.day),operatorMetricFmt(row.newAccounts),operatorMetricFmt(row.activeUsers),operatorMetricFmt(row.conversations),operatorMetricFmt(row.runs),operatorMetricFmt(row.promptTokens),operatorMetricFmt(row.completionTokens),operatorMetricFmt(row.totalTokens)]),'当前没有每日样本');table.classList.add('operator-metrics-table');root.appendChild(table);
        const modelTokens=metrics.modelTokens;
        if(modelTokens&&modelTokens.configured&&modelTokens.models&&modelTokens.models.length){
          const panel=make('section','panel operator-model-token-panel');add(panel,'h2','', 'token 消耗（按模型）');add(panel,'div','hint','与总消耗同一去重口径（按 run_id 取最新记录）；只统计模型名与 token 数，不含账号或正文。');
          const rowsWrap=make('div','operator-model-token-rows');const maxModelTokens=Math.max(...modelTokens.models.map(item=>operatorMetricNumber(item.totalTokens)),1);
          modelTokens.models.forEach(item=>{const line=make('div','operator-model-token-row');add(line,'span','operator-model-token-name',item.model);line.title=item.model;const track=make('div','operator-model-token-track');const fill=make('div','operator-model-token-fill');fill.style.width=Math.max(2,Math.round(operatorMetricNumber(item.totalTokens)/maxModelTokens*100))+'%';track.appendChild(fill);line.appendChild(track);add(line,'span','operator-model-token-value',operatorMetricFmt(item.totalTokens));add(line,'span','operator-model-token-detail',operatorMetricFmt(item.runs)+' run'+(item.share==null?'':' · '+operatorMetricPercent(item.share)));rowsWrap.appendChild(line)});
          panel.appendChild(rowsWrap);root.appendChild(panel);
        }
        const dispatch=metrics.dispatch;
        if(dispatch){
          const panel=make('section','panel operator-dispatch-panel');add(panel,'h2','', 'Agent 调度闭环');add(panel,'div','hint',dispatch.configured?'只展示规范化调度 receipt 的聚合结果；不包含 prompt、账号或原始 signals。':'中心库尚未完成 agent_dispatch_plan 迁移，调度指标暂不可用。');
          if(dispatch.configured){
            const dispatchKpis=make('div','operator-dispatch-kpis');
            [['调度样本',operatorMetricFmt(dispatch.runsWithPlan), '窗口内有 receipt 的 run',''],['实际多 Agent 率',operatorMetricPercent(dispatch.dispatchRate), 'auto / approved / model dispatch','good'],['自动 preflight',operatorMetricFmt(dispatch.autoPreflightRuns), '实际分配的宿主只读分支',''],['调度成功率',operatorMetricPercent(dispatch.successRate), 'completed + partial / 非取消失败','good'],['p95 总耗时',dispatch.latency&&dispatch.latency.p95Ms!=null?operatorMetricFmt(dispatch.latency.p95Ms)+' ms':'—', '仅非取消 run','warn']].forEach(item=>{const card=make('section','operator-dispatch-kpi '+item[3]);add(card,'div','label',item[0]);add(card,'div','value',item[1]);add(card,'div','detail',item[2]);dispatchKpis.appendChild(card)});panel.appendChild(dispatchKpis);
            const dispatchRows=Array.isArray(dispatch.daily)?dispatch.daily.slice().reverse().map(row=>[operatorMetricDay(row.day),operatorMetricFmt(row.runsWithPlan),operatorMetricFmt(row.dispatchRuns),operatorMetricFmt(row.autoPreflightRuns),operatorMetricFmt(row.approvedPreflightRuns),operatorMetricFmt(row.modelDispatchRuns),operatorMetricPercent(row.successRate),row.p50ElapsedMs==null?'—':operatorMetricFmt(row.p50ElapsedMs)+' ms',row.p95ElapsedMs==null?'—':operatorMetricFmt(row.p95ElapsedMs)+' ms']):[];
            const dispatchTable=buildTable('每日调度明细',['日期','计划样本','实际多 Agent','自动 preflight','审批 preflight','模型派发','成功率','p50','p95'],dispatchRows,'当前没有调度样本');dispatchTable.classList.add('operator-metrics-table','operator-dispatch-table');panel.appendChild(dispatchTable);
          }
          root.appendChild(panel);
        }
      }
      async function loadOperatorMetrics(manual=false,days){
        const root=$('operatorMetricsContent');if(!root)return;
        const nextDays=days||operatorMetricNumber(state.operatorMetrics&&state.operatorMetrics.metrics&&state.operatorMetrics.metrics.windowDays)||30;
        if(manual||!state.operatorMetrics){renderLoadPanel(root,'运营指标',false)}
        try{state.operatorMetrics=await request('/api/ops/observability/operator-metrics?days='+encodeURIComponent(Math.max(1,Math.min(180,nextDays))));renderOperatorMetrics(root)}catch(error){if(error.message==='not_authorized')return;renderLoadPanel(root,'运营指标加载失败：'+friendlyError(error.message),true)}
      }
      const legacyOperatorLoadAll=loadAll;loadAll=async function(manual=false){await legacyOperatorLoadAll(manual);if(state.view==='operator-metrics')await loadOperatorMetrics(manual)};
`;
