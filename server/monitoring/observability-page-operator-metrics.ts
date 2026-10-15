export const OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE = `
    .operator-metrics-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}
    .operator-metrics-toolbar .segmented{display:inline-flex;gap:4px;flex-wrap:wrap}
    .operator-metrics-toolbar .segmented button{min-height:34px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--c2);color:var(--muted);font-size:12px;cursor:pointer}
    .operator-metrics-toolbar .segmented button.active{border-color:var(--c79);background:var(--c12);color:var(--green);font-weight:650}
    .operator-metrics-toolbar .segmented button:focus-visible{outline:2px solid var(--c11);outline-offset:1px}
    .operator-metrics-group{margin-bottom:18px}.operator-metrics-group h2{margin:0 0 10px;font-size:14px;font-weight:650}
    .operator-metrics-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .operator-metrics-kpi{min-width:0;padding:16px 0;border:0;background:transparent}
    .operator-metrics-kpi .label{color:var(--muted);font-size:12px}
    .operator-metrics-kpi .value{margin-top:6px;color:var(--text);font-size:30px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .operator-metrics-kpi .detail{margin-top:5px;color:var(--muted);font-size:11px;line-height:1.5}
    .operator-metrics-growth{border-bottom:1px solid var(--line)}.operator-metrics-growth .operator-metrics-kpi:first-child .value{color:var(--green)}
    .operator-metrics-usage{padding:0;border:0;background:transparent}.operator-metrics-usage .operator-metrics-kpi{padding:0 14px;border:0;border-left:1px solid var(--line);border-radius:0;background:transparent}.operator-metrics-usage .operator-metrics-kpi:first-child{padding-left:0;border-left:0}.operator-metrics-usage .operator-metrics-kpi .value{font-size:21px}
    .operator-metrics-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-bottom:12px}
    .operator-metrics-chart{min-width:0;padding:18px 20px}.operator-metrics-chart h2{margin:0;font-size:15px}.operator-metrics-chart .hint{margin-top:4px}
    .omc-series{display:inline-flex;gap:4px;flex-wrap:wrap;margin:12px 0 2px}
    .omc-series button{min-height:32px;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--c2);color:var(--muted);font-size:12px;cursor:pointer}
    .omc-series button.active{border-color:var(--c79);background:var(--c12);color:var(--green);font-weight:650}
    .omc-series button:focus-visible{outline:2px solid var(--c11);outline-offset:1px}
    .omc-chart-svg{width:100%;height:auto;display:block;margin-top:10px}
    .omc-grid{stroke:var(--line);stroke-width:1}
    .omc-axis{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums}
    .omc-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
    .omc-dot{stroke:var(--c2);stroke-width:1.5}
    .omc-color-token{stroke:var(--c340)}.omc-color-user{stroke:var(--c336)}.omc-color-dau{stroke:var(--c3)}.omc-color-conv{stroke:var(--c337)}.omc-color-run{stroke:var(--c338)}
    .omc-fill-token{stop-color:var(--c340)}.omc-fill-user{stop-color:var(--c336)}.omc-fill-dau{stop-color:var(--c3)}.omc-fill-conv{stop-color:var(--c337)}.omc-fill-run{stop-color:var(--c338)}
    .operator-metrics-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;align-content:start}
    .operator-metrics-side .source-card{min-width:0}
    .operator-metrics-side h3{margin:0;font-size:12px}.operator-metrics-side p{margin:5px 0 0;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
    .operator-metrics-secondary{margin-top:20px}.operator-metrics-disclosure{margin-top:8px}.operator-metrics-disclosure>.detail-summary{display:flex;align-items:center;gap:12px;cursor:pointer}.operator-metrics-disclosure>.detail-summary:focus-visible{outline:2px solid var(--c11);outline-offset:2px}.operator-metrics-disclosure>.detail-summary span{margin-left:auto}.operator-metrics-disclosure>.detail-summary span.unavailable{color:var(--orange)}.operator-metrics-disclosure .operator-metrics-table{border:0;border-radius:0;box-shadow:none}.operator-metrics-disclosure .operator-metrics-table>.table-title{display:none}
    .operator-metrics-note{padding:12px 14px;border:1px dashed var(--c119);border-radius:7px;background:var(--c57);color:var(--muted);font-size:12px;line-height:1.5}
    .operator-metrics-table .scroll{max-height:420px}.operator-metrics-table table{min-width:760px}
    .operator-metrics-table td,.operator-metrics-table th{font-variant-numeric:tabular-nums}
    .operator-metrics-empty{padding:18px;border:1px dashed var(--line);border-radius:8px;color:var(--muted);font-size:11px}
    .operator-dispatch-panel{padding:0}.operator-dispatch-panel h2{margin:0;font-size:15px}.operator-dispatch-panel .hint{margin-top:4px}
    .operator-dispatch-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-top:12px}.operator-dispatch-kpi{padding:0;border:0;background:transparent}.operator-dispatch-kpi .label{color:var(--muted);font-size:11px}.operator-dispatch-kpi .value{margin-top:4px;font-size:21px;font-weight:700;font-variant-numeric:tabular-nums}.operator-dispatch-kpi .detail{margin-top:3px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}
    .operator-dispatch-table{margin-top:12px}.operator-dispatch-table .scroll{max-height:300px}.operator-dispatch-table table{min-width:820px}
    .operator-model-token-panel{padding:0}.operator-model-token-panel h2{margin:0;font-size:15px}.operator-model-token-panel .hint{margin-top:4px}.operator-model-token-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
    .operator-model-token-rows{display:grid;gap:7px;margin-top:14px}
    .operator-model-token-row{display:grid;grid-template-columns:minmax(120px,220px) minmax(0,1fr) minmax(120px,auto) minmax(150px,auto);align-items:center;gap:12px;font-size:12px}
    .operator-model-token-name{color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .operator-model-token-track{height:5px;border-radius:3px;background:var(--line);overflow:hidden}
    .operator-model-token-fill{height:100%;min-width:2px;border-radius:3px;background:var(--green)}
    .operator-model-token-value{min-width:0;color:var(--text);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    .operator-model-token-detail{min-width:0;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
    @media(max-width:1200px){.operator-dispatch-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:900px){.operator-model-token-row{grid-template-columns:minmax(100px,1fr) minmax(0,1fr)}.operator-model-token-value{grid-column:1;text-align:left}.operator-model-token-detail{grid-column:2;overflow-wrap:anywhere}}
    @media(max-width:620px){.operator-metrics-kpis{grid-template-columns:1fr}.operator-metrics-growth .operator-metrics-kpis{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.operator-metrics-growth .operator-metrics-kpi .value{font-size:23px}.operator-metrics-growth .operator-metrics-kpi .detail{font-size:10px}.operator-metrics-usage .operator-metrics-kpi{padding:10px 0 0;border-left:0;border-top:1px solid var(--line)}.operator-metrics-usage .operator-metrics-kpi:first-child{padding-top:0;border-top:0}.operator-metrics-side{grid-template-columns:1fr}.operator-metrics-disclosure>.detail-summary{flex-wrap:wrap}.operator-metrics-disclosure>.detail-summary span{margin-left:0}.operator-dispatch-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.operator-metrics-kpi .value{font-size:26px}}
`;

export const OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS = `
      function operatorMetricNumber(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
      function operatorMetricFmt(value){return operatorMetricNumber(value).toLocaleString('zh-CN')}
      function operatorMetricPercent(value){const parsed=Number(value);return Number.isFinite(parsed)?(parsed*100).toFixed(1)+'%':'—'}
      function operatorMetricDay(value){const text=String(value||'');return text.length>=10?text.slice(5):text||'—'}
      function operatorMetricRows(metrics){return Array.isArray(metrics&&metrics.daily)?metrics.daily.slice().sort((a,b)=>String(a.day).localeCompare(String(b.day))):[]}
      // Grafana 风格日序列折线：坐标轴用紧凑中文数量级（万/亿），悬停数据点看当日精确值。
      let operatorChartField='newAccounts';
      let operatorUsageChartField='totalTokens';
      const operatorMetricExpanded=new Set();
      function operatorMetricDisclosure(key,title,hint,unavailable=false){const details=make('details','detail-sections operator-metrics-disclosure');details.id='operatorMetricsDetails-'+key;details.open=operatorMetricExpanded.has(key);const summary=add(details,'summary','detail-summary');add(summary,'strong','',title);add(summary,'span',unavailable?'unavailable':'',hint);details.addEventListener('toggle',()=>{if(details.open)operatorMetricExpanded.add(key);else operatorMetricExpanded.delete(key)});return details}
      const OPERATOR_SERIES=[['newAccounts','新增用户','user'],['activeUsers','日活 DAU','dau'],['conversations','对话次数','conv'],['runs','Agent Run','run'],['totalTokens','token 消耗','token']];
      function operatorSeriesDef(field){return OPERATOR_SERIES.find(item=>item[0]===field)||OPERATOR_SERIES[0]}
      function operatorSeriesColor(key){return ({token:'var(--c340)',user:'var(--c336)',dau:'var(--c3)',conv:'var(--c337)',run:'var(--c338)'})[key]||'var(--c340)'}
      function operatorCompact(value){const v=operatorMetricNumber(value);const abs=Math.abs(v);if(abs>=1e8)return (v/1e8).toFixed(abs>=1e9?0:1)+'亿';if(abs>=1e4)return (v/1e4).toFixed(abs>=1e5?0:1)+'万';return operatorMetricFmt(v)}
      function operatorLineChart(rows,field,availableWidth=920){const NS='http://www.w3.org/2000/svg';const def=operatorSeriesDef(field);const W=Math.max(320,Math.min(920,availableWidth>0?availableWidth:920)),H=232,L=58,R=14,T=14,B=26;const innerW=W-L-R,innerH=H-T-B;const values=rows.map(row=>operatorMetricNumber(row[field]));const max=Math.max.apply(null,values.concat([1]))*1.08;const n=rows.length;const xAt=i=>L+(n<2?innerW/2:innerW*i/(n-1));const yAt=v=>T+innerH*(1-v/max);const svg=document.createElementNS(NS,'svg');svg.setAttribute('class','omc-chart-svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('preserveAspectRatio','xMidYMid meet');svg.setAttribute('role','img');svg.setAttribute('aria-label','每日 '+def[1]+'趋势折线图');const defs=document.createElementNS(NS,'defs');const grad=document.createElementNS(NS,'linearGradient');grad.setAttribute('id','omc-area-'+def[2]);grad.setAttribute('x1','0');grad.setAttribute('y1','0');grad.setAttribute('x2','0');grad.setAttribute('y2','1');[[0,'0.28'],[1,'0.02']].forEach(pair=>{const stop=document.createElementNS(NS,'stop');stop.setAttribute('offset',String(pair[0]));stop.setAttribute('class','omc-fill-'+def[2]);stop.setAttribute('stop-opacity',String(pair[1]));grad.appendChild(stop)});defs.appendChild(grad);svg.appendChild(defs);
        for(let i=0;i<=4;i++){const value=max*i/4;const y=yAt(value);const grid=document.createElementNS(NS,'line');grid.setAttribute('class','omc-grid');grid.setAttribute('x1',String(L));grid.setAttribute('y1',String(y));grid.setAttribute('x2',String(W-R));grid.setAttribute('y2',String(y));svg.appendChild(grid);const tick=document.createElementNS(NS,'text');tick.setAttribute('class','omc-axis');tick.setAttribute('x',String(L-8));tick.setAttribute('y',String(y+3));tick.setAttribute('text-anchor','end');tick.textContent=operatorCompact(value);svg.appendChild(tick)}
        const step=Math.max(1,Math.ceil(n/8));const lastIdx=n-1;rows.forEach((row,i)=>{const isLast=i===lastIdx;if(i%step!==0&&i!==lastIdx)return;if(isLast&&lastIdx%step===0&&lastIdx!==0)return;const label=document.createElementNS(NS,'text');label.setAttribute('class','omc-axis');label.setAttribute('x',String(xAt(i)));label.setAttribute('y',String(H-8));label.setAttribute('text-anchor','middle');label.textContent=operatorMetricDay(row.day);svg.appendChild(label)});
        if(n){let area='M '+xAt(0)+' '+yAt(values[0]);let line='';rows.forEach((row,i)=>{const x=xAt(i);const y=yAt(values[i]);line+=(i?' L ':'M ')+x+' '+y;if(i)area+=' L '+x+' '+y});area+=' L '+xAt(n-1)+' '+(T+innerH)+' L '+xAt(0)+' '+(T+innerH)+' Z';const fill=document.createElementNS(NS,'path');fill.setAttribute('d',area);fill.setAttribute('fill','url(#omc-area-'+def[2]+')');svg.appendChild(fill);const path=document.createElementNS(NS,'path');path.setAttribute('class','omc-line omc-color-'+def[2]);path.setAttribute('d',line);svg.appendChild(path);rows.forEach((row,i)=>{const dot=document.createElementNS(NS,'circle');dot.setAttribute('class','omc-dot omc-color-'+def[2]);dot.setAttribute('cx',String(xAt(i)));dot.setAttribute('cy',String(yAt(values[i])));dot.setAttribute('r','3');dot.setAttribute('fill',operatorSeriesColor(def[2]));const tip=document.createElementNS(NS,'title');tip.textContent=String(row.day)+' · '+operatorMetricFmt(row[field]);dot.appendChild(tip);svg.appendChild(dot)})}
        return svg}
      function operatorMetricChart(root,rows,usage=false){
        const field=usage?operatorUsageChartField:operatorChartField;const chart=make('section',(usage?'':'panel ')+'operator-metrics-chart'+(usage?' operator-metrics-usage-chart':''));chart.id=usage?'operatorUsageChart':'operatorGrowthChart';const chartDef=operatorSeriesDef(field);add(chart,'h2','', '每日 '+chartDef[1]+'趋势');
        const seriesBar=make('div','omc-series');seriesBar.setAttribute('aria-label',usage?'使用量趋势指标':'增长趋势指标');OPERATOR_SERIES.filter(item=>usage?!['newAccounts','activeUsers'].includes(item[0]):['newAccounts','activeUsers'].includes(item[0])).forEach(item=>{const selected=item[0]===field;const button=add(seriesBar,'button',selected?'active':'',item[1]);button.type='button';button.setAttribute('aria-pressed',String(selected));button.addEventListener('click',()=>{if(usage)operatorUsageChartField=item[0];else operatorChartField=item[0];renderOperatorMetrics(root)})});chart.appendChild(seriesBar);chart.appendChild(operatorLineChart(rows,field,operatorMetricNumber(root.clientWidth)-40));return chart;
      }
      function renderOperatorMetrics(root){
        if(!root)return;
        root.replaceChildren();
        const metrics=state.operatorMetrics&&state.operatorMetrics.metrics;
        if(!metrics){
          const notice=make('div','operator-metrics-empty','运营指标暂未接入：请确认中心库已配置，并重试读取。');
          root.appendChild(notice);return;
        }
        const rows=operatorMetricRows(metrics);
        if(!rows.length){
          root.appendChild(make('div','operator-metrics-empty','当前窗口没有可展示的运营样本；数据写入后会自动出现在这里。'));return;
        }
        const toolbar=make('div','operator-metrics-toolbar');
        const windowCopy=make('div');add(windowCopy,'strong','', '近 '+operatorMetricNumber(metrics.windowDays)+' 天');toolbar.appendChild(windowCopy);
        const segmented=make('div','segmented');segmented.setAttribute('aria-label','运营指标时间窗口');
        [7,30,90].forEach(days=>{const selected=days===operatorMetricNumber(metrics.windowDays);const button=add(segmented,'button',selected?'active':'',days+' 天');button.type='button';button.setAttribute('aria-pressed',String(selected));button.addEventListener('click',()=>loadOperatorMetrics(false,days))});
        toolbar.appendChild(segmented);root.appendChild(toolbar);
        const totals=metrics.totals||{};
        const totalAccounts=metrics.totalAccounts;
        const growth=make('section','operator-metrics-group operator-metrics-growth');growth.setAttribute('aria-label','用户增长与活跃');
        const kpis=make('div','operator-metrics-kpis');
        const cards=[
          ['user','新增用户',operatorMetricFmt(totals.newAccounts),'窗口总计 · 日峰值 '+operatorMetricFmt(Math.max(...rows.map(row=>operatorMetricNumber(row.newAccounts)),0))],
          ['user','用户总数',totalAccounts==null?'—':operatorMetricFmt(totalAccounts),totalAccounts==null?'全量用户总数暂不可用':'全部注册账号，包含导入'],
          ['','日活峰值',operatorMetricFmt(totals.activeUsersPeak),'当前选定窗口 DAU 峰值'],
        ];
        cards.forEach(item=>{const card=make('section','operator-metrics-kpi '+item[0]);add(card,'div','label',item[1]);add(card,'div','value',item[2]);add(card,'div','detail',item[3]);kpis.appendChild(card)});growth.appendChild(kpis);root.appendChild(growth);
        const secondary=make('section','operator-metrics-secondary');secondary.setAttribute('aria-label','运营细节');
        const modelTokens=metrics.modelTokens;const modelUnavailable=Boolean(modelTokens&&!modelTokens.configured);const missingPrices=Boolean(modelTokens&&modelTokens.configured&&Array.isArray(modelTokens.models)&&modelTokens.models.some(item=>!item.cost));
        const usageDetails=operatorMetricDisclosure('usage','使用量与成本',modelUnavailable?'模型 token 明细暂不可用':missingPrices?'有模型未配置单价':'对话、Run、token 与模型成本',modelUnavailable||missingPrices);
        const usage=make('section','operator-metrics-group operator-metrics-usage');const usageKpis=make('div','operator-metrics-kpis');
        [
          ['conversation','对话次数',operatorMetricFmt(totals.conversations),'当前选定窗口总计'],
          ['run','Agent Run',operatorMetricFmt(totals.runs),'当前选定窗口总计'],
          ['token','Moss token 消耗',operatorMetricFmt(totals.totalTokens),'Prompt '+operatorMetricFmt(totals.promptTokens)+' · Completion '+operatorMetricFmt(totals.completionTokens)],
        ].forEach(item=>{const card=make('section','operator-metrics-kpi '+item[0]);add(card,'div','label',item[1]);add(card,'div','value',item[2]);add(card,'div','detail',item[3]);usageKpis.appendChild(card)});usage.appendChild(usageKpis);usageDetails.appendChild(usage);
        const grid=make('div','operator-metrics-grid');grid.appendChild(operatorMetricChart(root,rows));root.appendChild(grid);usageDetails.appendChild(operatorMetricChart(root,rows,true));
        if(modelTokens&&modelTokens.configured&&modelTokens.models&&modelTokens.models.length){
          const panel=make('section','operator-model-token-panel');const panelHead=make('div','operator-model-token-head');const headCopy=make('div');add(headCopy,'h2','', '模型消耗与成本');panelHead.appendChild(headCopy);
          const priceBtn=add(panelHead,'button','btn','设置单价');priceBtn.type='button';priceBtn.addEventListener('click',async()=>{const model=window.prompt('模型名（与运行记录中的 model 字段一致）');if(!model)return;const input=Number(window.prompt('输入单价：每百万 prompt token','0'));if(!Number.isFinite(input)||input<0)return toast('单价不合法',false);const output=Number(window.prompt('输出单价：每百万 completion token','0'));if(!Number.isFinite(output)||output<0)return toast('单价不合法',false);try{const r=await fetch(base+'/api/ops/observability/model-prices/'+encodeURIComponent(model),{method:'PUT',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({inputPerM:input,outputPerM:output})});if(r.ok){toast('单价已保存，刷新后生效');loadOperatorMetrics(true)}else toast('保存失败',false)}catch{toast('保存失败',false)}});
          panel.appendChild(panelHead);
          const rowsWrap=make('div','operator-model-token-rows');const maxModelTokens=Math.max(...modelTokens.models.map(item=>operatorMetricNumber(item.totalTokens)),1);
          modelTokens.models.forEach(item=>{const line=make('div','operator-model-token-row');add(line,'span','operator-model-token-name',item.model);line.title=item.model;const track=make('div','operator-model-token-track');const fill=make('div','operator-model-token-fill');fill.style.width=Math.max(2,Math.round(operatorMetricNumber(item.totalTokens)/maxModelTokens*100))+'%';track.appendChild(fill);line.appendChild(track);add(line,'span','operator-model-token-value',operatorMetricFmt(item.totalTokens)+(item.cost?' · '+item.cost.totalCost.toFixed(2)+' '+item.cost.currency:''));add(line,'span','operator-model-token-detail',operatorMetricFmt(item.runs)+' run'+(item.share==null?'':' · '+operatorMetricPercent(item.share))+(item.cost?(' · 输入 '+item.cost.inputCost.toFixed(2)+' + 输出 '+item.cost.outputCost.toFixed(2)+' '+item.cost.currency):' · 未配置单价'));rowsWrap.appendChild(line)});
          if(modelTokens.totals&&modelTokens.totals.cost)add(panel,'div','hint','窗口内已定价模型成本合计：'+modelTokens.totals.cost.totalCost.toFixed(2)+' '+modelTokens.totals.cost.currency+'（未定价模型不计入）。');
          panel.appendChild(rowsWrap);usageDetails.appendChild(panel);
        }else if(modelTokens&&!modelTokens.configured){
          usageDetails.appendChild(make('div','operator-metrics-note','模型 token 明细暂不可用；总 token 消耗仍以当前窗口汇总为准。'));
        }
        secondary.appendChild(usageDetails);
        const dispatch=metrics.dispatch;
        if(dispatch){
          const dispatchMissing=!dispatch.configured;const dispatchEmpty=dispatch.configured&&!operatorMetricNumber(dispatch.runsWithPlan);const dispatchDetails=operatorMetricDisclosure('dispatch','Agent 调度',dispatchMissing?'调度指标暂不可用':dispatchEmpty?'当前没有调度样本':'计划、成功率与耗时',dispatchMissing);const panel=make('section','operator-dispatch-panel');if(dispatchMissing)add(panel,'div','hint','中心库尚未完成 agent_dispatch_plan 迁移，调度指标暂不可用。');
          if(dispatch.configured){
            const dispatchKpis=make('div','operator-dispatch-kpis');
            [['调度样本',operatorMetricFmt(dispatch.runsWithPlan), '窗口内有 receipt 的 run',''],['实际多 Agent 率',operatorMetricPercent(dispatch.dispatchRate), 'auto / approved / model dispatch','good'],['自动 preflight',operatorMetricFmt(dispatch.autoPreflightRuns), '实际分配的宿主只读分支',''],['调度成功率',operatorMetricPercent(dispatch.successRate), 'completed + partial / 非取消失败','good'],['p95 总耗时',dispatch.latency&&dispatch.latency.p95Ms!=null?operatorMetricFmt(dispatch.latency.p95Ms)+' ms':'—', '仅非取消 run','warn']].forEach(item=>{const card=make('section','operator-dispatch-kpi '+item[3]);add(card,'div','label',item[0]);add(card,'div','value',item[1]);add(card,'div','detail',item[2]);dispatchKpis.appendChild(card)});panel.appendChild(dispatchKpis);
            const dispatchRows=Array.isArray(dispatch.daily)?dispatch.daily.slice().reverse().map(row=>[operatorMetricDay(row.day),operatorMetricFmt(row.runsWithPlan),operatorMetricFmt(row.dispatchRuns),operatorMetricFmt(row.autoPreflightRuns),operatorMetricFmt(row.approvedPreflightRuns),operatorMetricFmt(row.modelDispatchRuns),operatorMetricPercent(row.successRate),row.p50ElapsedMs==null?'—':operatorMetricFmt(row.p50ElapsedMs)+' ms',row.p95ElapsedMs==null?'—':operatorMetricFmt(row.p95ElapsedMs)+' ms']):[];
            if(dispatchRows.length){const dispatchDetails=operatorMetricDisclosure('dispatch-daily','每日调度明细',dispatchRows.length+' 天 · 计划、派发与耗时');const dispatchTable=buildTable('每日调度明细',['日期','计划样本','实际多 Agent','自动 preflight','审批 preflight','模型派发','成功率','p50','p95'],dispatchRows,'当前没有调度样本');dispatchTable.classList.add('operator-metrics-table','operator-dispatch-table');dispatchDetails.appendChild(dispatchTable);panel.appendChild(dispatchDetails)}else add(panel,'div','operator-metrics-empty','当前没有调度样本');
          }
          dispatchDetails.appendChild(panel);secondary.appendChild(dispatchDetails);
        }
        const dailyDetails=operatorMetricDisclosure('daily','每日运营明细',rows.length+' 天 · 精确数值');const table=buildTable('每日运营明细',['日期','新增用户','DAU','对话次数','Agent Run','Prompt token','Completion token','总 token'],rows.slice().reverse().map(row=>[operatorMetricDay(row.day),operatorMetricFmt(row.newAccounts),operatorMetricFmt(row.activeUsers),operatorMetricFmt(row.conversations),operatorMetricFmt(row.runs),operatorMetricFmt(row.promptTokens),operatorMetricFmt(row.completionTokens),operatorMetricFmt(row.totalTokens)]),'当前没有每日样本');table.classList.add('operator-metrics-table');dailyDetails.appendChild(table);secondary.appendChild(dailyDetails);
        const sources=metrics.sources||{};const sourceDetails=operatorMetricDisclosure('sources','指标口径与数据来源','去重方式与新鲜度');const side=make('div','operator-metrics-side');[['指标口径',(sources.tokens||'token 来自 agent_run_records')+'；'+(sources.activity||'对话来自 conversation_turns')+'；'+(sources.accounts||'新增来自 credit_account')],['调度口径',sources.dispatch||'agent_dispatch_plan 规范化 receipt，仅聚合标签、结果与耗时'],['数据窗口','近 '+operatorMetricNumber(metrics.windowDays)+' 天；新增用户剔除迁移导入。用户总数为全量累计，不随窗口变化。'],['数据新鲜度','刷新时重新读取中心库，不缓存用户身份或对话正文。']].forEach(item=>{const card=make('section','source-card');add(card,'h3','',item[0]);add(card,'p','',item[1]);side.appendChild(card)});sourceDetails.appendChild(side);secondary.appendChild(sourceDetails);root.appendChild(secondary);
      }
      async function loadOperatorMetrics(manual=false,days){
        const root=$('operatorMetricsContent');if(!root)return;
        const nextDays=days||operatorMetricNumber(state.operatorMetrics&&state.operatorMetrics.metrics&&state.operatorMetrics.metrics.windowDays)||30;
        if(manual||!state.operatorMetrics){renderLoadPanel(root,'运营指标',false)}
        try{state.operatorMetrics=await request('/api/ops/observability/operator-metrics?days='+encodeURIComponent(Math.max(1,Math.min(180,nextDays))));renderOperatorMetrics(root)}catch(error){if(error.message==='not_authorized')return;renderLoadPanel(root,'运营指标加载失败：'+friendlyError(error.message),true)}
      }
      const legacyOperatorLoadAll=loadAll;loadAll=async function(manual=false){await legacyOperatorLoadAll(manual);if(state.view==='operator-metrics')await loadOperatorMetrics(manual)};
`;
