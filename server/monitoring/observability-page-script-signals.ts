/**
 * 观测查询（指标/日志/自定义面板）与边缘设备视图的客户端逻辑。
 * 依赖外层脚本提供的共享工具：state、base、$、make、add、apiHeaders、toast、when。
 */

export const OPS_OBSERVABILITY_SCRIPT_SIGNALS =
  `
      // ============ 零依赖折线图渲染器（观测查询 / 设备 / 自定义面板共用） ============
      const SIGNALS_CHART_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'];
      function signalsFormatValue(value){const n=Number(value)||0;const abs=Math.abs(n);if(abs>=1e9)return (n/1e9).toFixed(1)+'G';if(abs>=1e6)return (n/1e6).toFixed(1)+'M';if(abs>=1e3)return (n/1e3).toFixed(1)+'k';if(abs>=10)return n.toFixed(0);if(abs>=1)return n.toFixed(2);if(abs===0)return '0';return n.toFixed(3)}
      function signalsFormatTs(ts,windowMinutes){const date=new Date(Number(ts));if(!Number.isFinite(date.getTime()))return '';const pad=v=>String(v).padStart(2,'0');if(windowMinutes<=1440)return pad(date.getHours())+':'+pad(date.getMinutes());return (date.getMonth()+1)+'/'+date.getDate()+' '+pad(date.getHours())+':00'}
      // series: [{name, points:[{ts,value}]}]; 渲染 SVG 折线 + 网格 + 图例。
      function renderSignalsChart(container,series,windowMinutes,mode,onZoom){container.replaceChildren();const usable=series.filter(item=>item.points&&item.points.length);if(!usable.length){container.appendChild(make('div','signals-empty','所选范围内没有数据点'));return}
        const width=Math.max(320,container.clientWidth||640);const height=200;const padL=52;const padR=12;const padT=10;const padB=24;
        let minV=Infinity,maxV=-Infinity,minT=Infinity,maxT=-Infinity;usable.forEach(item=>item.points.forEach(p=>{minV=Math.min(minV,p.value);maxV=Math.max(maxV,p.value);minT=Math.min(minT,p.ts);maxT=Math.max(maxT,p.ts)}));
        if(minT===maxT){maxT=minT+60000}if(minV===maxV){maxV=minV+1}const padV=(maxV-minV)*0.08;minV-=padV;maxV+=padV;
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('role','img');svg.setAttribute('aria-label','时序折线图');
        const x=ts=>padL+((ts-minT)/(maxT-minT))*(width-padL-padR);const y=v=>padT+(1-(v-minV)/(maxV-minV))*(height-padT-padB);
        for(let i=0;i<=3;i++){const value=minV+(maxV-minV)*(i/3);const gy=y(value);const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',padL);line.setAttribute('x2',width-padR);line.setAttribute('y1',gy);line.setAttribute('y2',gy);line.setAttribute('stroke','rgba(148,163,184,.18)');line.setAttribute('stroke-width','1');svg.appendChild(line);
          const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',padL-6);label.setAttribute('y',gy+4);label.setAttribute('text-anchor','end');label.setAttribute('font-size','10');label.setAttribute('fill','var(--muted)');label.textContent=signalsFormatValue(value);svg.appendChild(label)}
        const tickCount=Math.min(5,usable[0].points.length);for(let i=0;i<tickCount;i++){const ts=minT+(maxT-minT)*(tickCount===1?0:i/(tickCount-1));const tx=x(ts);const tlabel=document.createElementNS('http://www.w3.org/2000/svg','text');tlabel.setAttribute('x',Math.min(Math.max(tx,padL),width-padR));tlabel.setAttribute('y',height-6);tlabel.setAttribute('text-anchor','middle');tlabel.setAttribute('font-size','10');tlabel.setAttribute('fill','var(--muted)');tlabel.textContent=signalsFormatTs(ts,windowMinutes||240);svg.appendChild(tlabel)}
        if(mode==='bar'){const slot=(width-padL-padR)/Math.max(1,usable[0].points.length);const barW=Math.max(1.5,slot/usable.length*0.72);usable.forEach((item,index)=>{const color=SIGNALS_CHART_COLORS[index%SIGNALS_CHART_COLORS.length];item.points.forEach(p=>{const top=y(p.value);const bottom=height-padB;const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('x',(x(p.ts)-slot/2+index*(slot/usable.length)).toFixed(1));rect.setAttribute('y',top.toFixed(1));rect.setAttribute('width',barW.toFixed(1));rect.setAttribute('height',Math.max(0.5,bottom-top).toFixed(1));rect.setAttribute('fill',color);rect.setAttribute('opacity','0.85');const tip=document.createElementNS('http://www.w3.org/2000/svg','title');tip.textContent=item.name+' '+signalsFormatValue(p.value);rect.appendChild(tip);svg.appendChild(rect)})})}
        else{usable.forEach((item,index)=>{const color=SIGNALS_CHART_COLORS[index%SIGNALS_CHART_COLORS.length];const d=item.points.map((p,i2)=>(i2?'L':'M')+x(p.ts).toFixed(1)+' '+y(p.value).toFixed(1)).join(' ');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke',color);path.setAttribute('stroke-width','1.6');path.setAttribute('stroke-linejoin','round');svg.appendChild(path)})}
        const crosshair=document.createElementNS('http://www.w3.org/2000/svg','line');crosshair.setAttribute('y1',padT);crosshair.setAttribute('y2',height-padB);crosshair.setAttribute('stroke','rgba(148,163,184,.5)');crosshair.setAttribute('stroke-width','1');crosshair.setAttribute('visibility','hidden');svg.appendChild(crosshair);
        container.appendChild(svg);
        const tip=make('div','signals-chart-tip');tip.style.display='none';container.appendChild(tip);
        svg.addEventListener('mousemove',event=>{const bounds=svg.getBoundingClientRect();const mx=event.clientX-bounds.left;if(mx<padL||mx>width-padR){tip.style.display='none';crosshair.setAttribute('visibility','hidden');return}
          const hoverTs=minT+(mx-padL)/(width-padL-padR)*(maxT-minT);let nearest=usable[0].points[0].ts;usable.forEach(item=>item.points.forEach(p=>{if(Math.abs(p.ts-hoverTs)<Math.abs(nearest-hoverTs))nearest=p.ts}));
          crosshair.setAttribute('x1',x(nearest).toFixed(1));crosshair.setAttribute('x2',x(nearest).toFixed(1));crosshair.setAttribute('visibility','visible');
          tip.replaceChildren();add(tip,'strong','',signalsFormatTs(nearest,windowMinutes||240));usable.forEach((item,index)=>{let bp=item.points[0];item.points.forEach(p=>{if(Math.abs(p.ts-nearest)<Math.abs(bp.ts-nearest))bp=p});const row=make('span');const swatch=make('span','swatch');swatch.style.background=SIGNALS_CHART_COLORS[index%SIGNALS_CHART_COLORS.length];row.appendChild(swatch);row.appendChild(document.createTextNode(signalsFormatValue(bp.value)));tip.appendChild(row)});
          tip.style.display='flex';const tw=tip.offsetWidth||120;tip.style.left=Math.min(Math.max(x(nearest)-tw/2,0),(container.clientWidth||320)-tw)+'px';tip.style.top='4px'});
        svg.addEventListener('mouseleave',()=>{tip.style.display='none';crosshair.setAttribute('visibility','hidden')});
        if(onZoom){svg.style.cursor='crosshair';let brushStartX=null;const brushRect=make('div','signals-chart-brush');brushRect.style.display='none';container.appendChild(brushRect);
          svg.addEventListener('pointerdown',event=>{if(event.button!==0)return;brushStartX=event.clientX;brushRect.style.display='none';tip.style.display='none';try{svg.setPointerCapture(event.pointerId)}catch{}});
          svg.addEventListener('pointermove',event=>{if(brushStartX==null)return;const offset=event.clientX-brushStartX;if(Math.abs(offset)<4){brushRect.style.display='none';return}
            const bounds=container.getBoundingClientRect();brushRect.style.display='block';brushRect.style.left=Math.min(brushStartX,event.clientX)-bounds.left+'px';brushRect.style.width=Math.abs(offset)+'px';brushRect.style.top='0px';brushRect.style.height='100%'});
          svg.addEventListener('pointerup',event=>{if(brushStartX==null)return;const offset=event.clientX-brushStartX;const startX=brushStartX;brushStartX=null;brushRect.style.display='none';if(Math.abs(offset)<8)return;
            const bounds=svg.getBoundingClientRect();const scale=width/(bounds.width||width);const toTs=clientX=>((clientX-bounds.left)*scale-padL)/(width-padL-padR)*(maxT-minT)+minT;
            const a=Math.max(minT,toTs(Math.min(startX,event.clientX)));const b=Math.min(maxT,toTs(Math.max(startX,event.clientX)));
            if(b-a>60_000)onZoom(a,b)});}
        const legend=make('div','signals-legend');usable.forEach((item,index)=>{const entry=make('span');const swatch=make('span','swatch');swatch.style.background=SIGNALS_CHART_COLORS[index%SIGNALS_CHART_COLORS.length];entry.appendChild(swatch);entry.appendChild(document.createTextNode(item.name+(item.points.length?(' ('+item.points.length+')'):'')));legend.appendChild(entry)});container.appendChild(legend)}

      // ============ 指标查询 ============
      state.signalMetricNames=state.signalMetricNames||[];
      async function loadSignalMetricNames(){try{const response=await fetch(base+'/api/ops/observability/metrics/series?limit=500',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){state.signalMetricNames=[...new Set((data.series||[]).map(item=>item.metric))].sort();const list=$('signalMetricList');if(list){list.replaceChildren();state.signalMetricNames.forEach(name=>{const option=make('option');option.value=name;list.appendChild(option)})}const input=$('signalMetricInput');if(input&&!input.value&&state.signalMetricNames.length)input.value=state.signalMetricNames[0]}}catch{}}
      async function runSignalsMetricQuery(){const metric=String(($('signalMetricInput')||{}).value||'').trim();const minutes=Number(($('signalMinutes')||{}).value||240);const target=$('signalsMetricChart');if(!target)return;if(!metric){toast('请先输入指标名',false);return}target.replaceChildren();const loading=make('div','signals-empty','正在查询 '+metric+' …');target.appendChild(loading);
        try{const response=await fetch(base+'/api/ops/observability/metrics/query?metric='+encodeURIComponent(metric)+'&minutes='+encodeURIComponent(String(minutes))+'&points=240',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);if(!response.ok||!data||!data.ok){loading.textContent=data&&data.error==='central_store_disabled'?'指标存储未启用（未配置中心库）':'查询失败，请稍后重试';return}
          const series=(data.series||[]).map(item=>({name:item.metric+' '+JSON.stringify(item.labels||{}),points:item.points||[]}));renderSignalsChart(target,series,minutes)}catch{loading.textContent='查询失败，请检查网络后重试'}}
      async function runSignalsLogQuery(){const service=String(($('signalLogService')||{}).value||'').trim();const severityMin=Number(($('signalLogSeverity')||{}).value||9);const minutes=Number(($('signalLogMinutes')||{}).value||240);const target=$('signalsLogTable');if(!target)return;target.replaceChildren();target.appendChild(make('div','signals-empty','正在查询日志…'));
        try{const params='/api/ops/observability/logs?minutes='+encodeURIComponent(String(minutes))+'&severityMin='+encodeURIComponent(String(severityMin))+(service?'&service='+encodeURIComponent(service):'')+'&limit=200';const response=await fetch(base+params,{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty','日志查询失败'));return}
          const logs=data.logs||[];if(!logs.length){target.appendChild(make('div','signals-empty','所选范围内没有日志记录'));return}
          const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['时间','服务','级别','内容'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');logs.forEach(row=>{const tr=make('tr');add(tr,'td','',when(row.timestampMs));add(tr,'td','',row.service||'—');const sev=add(tr,'td');add(sev,'span','signals-log-sev '+String(row.severityText||'INFO'),String(row.severityText||'INFO'));add(tr,'td','',row.body||'');tbody.appendChild(tr)});table.appendChild(tbody);target.appendChild(table)}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','日志查询失败，请检查网络'))}}

      // ============ 自定义看板（多看板 / 拖拽排序 / 模板导入导出） ============
      state.boards=state.boards||[];
      state.currentBoardId=state.currentBoardId||'';
      state.boardDragIndex=-1;
      state.boardsLoaded=false;
      state.boardRefreshTimer=null;
      const BOARD_WINDOW_LABELS={60:'1 小时',240:'4 小时',1440:'24 小时',10080:'7 天',20160:'14 天'};
      function boardWindowLabel(minutes){return BOARD_WINDOW_LABELS[minutes]||(minutes>=1440?(minutes/1440)+'天':minutes+'分钟')}
      function currentBoard(){return state.boards.find(board=>board.id===state.currentBoardId)||state.boards[0]||null}
      function setCurrentBoard(id){state.currentBoardId=id;sessionStorage.setItem('d_obs_board_id',String(id))}
      function setBoardAutoRefresh(ms){if(state.boardRefreshTimer){clearInterval(state.boardRefreshTimer);state.boardRefreshTimer=null}if(ms>0)state.boardRefreshTimer=setInterval(()=>{if(document.hidden)return;renderBoardPanels()},ms)}
      function toggleBoardKiosk(){const active=document.body.classList.toggle('obs-kiosk');const btn=$('boardKioskBtn');if(btn)btn.textContent=active?'退出大屏':'大屏';
        if(active){try{const request=document.documentElement.requestFullscreen();if(request&&request.catch)request.catch(()=>{})}catch{}}
        else if(document.fullscreenElement){try{document.exitFullscreen()}catch{}}}
      function renderBoardChart(container,series,minutes,panel){if(panel.chart==='stat'){renderSignalsStat(container,series,panel);return}renderSignalsChart(container,series,minutes,panel.chart,(fromMs,toMs)=>setBoardRange(Math.round(fromMs),Math.round(toMs)))}
      function tsToInputValue(ms){const date=new Date(Number(ms));const pad=v=>String(v).padStart(2,'0');return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes())}
      function inputValueToTs(value){const ms=new Date(String(value||'')).getTime();return Number.isFinite(ms)?ms:null}
      function setBoardRange(fromMs,toMs){const board=currentBoard();if(!board)return;if(!(toMs>fromMs))return;board.spec.range={fromMs:fromMs,toMs:toMs};persistBoardSpec();renderBoard()}
      function renderSignalsStat(container,series,panel){container.replaceChildren();const usable=series.filter(item=>item.points&&item.points.length);if(!usable.length){container.appendChild(make('div','signals-empty','所选范围内没有数据点'));return}
        const primary=usable[0];const last=primary.points[primary.points.length-1];
        const warn=panel&&panel.warnValue!=null?Number(panel.warnValue):null;const crit=panel&&panel.critValue!=null?Number(panel.critValue):null;
        let valueClass='signals-stat-value';if(crit!=null&&Number(last.value)>=crit)valueClass+=' crit';else if(warn!=null&&Number(last.value)>=warn)valueClass+=' warn';
        container.appendChild(make('div',valueClass,signalsFormatValue(last.value)));
        const meta=make('div','signals-stat-meta');add(meta,'span','',primary.name);meta.appendChild(document.createTextNode(' · 最新 '+when(last.ts)));
        if(warn!=null||crit!=null)meta.appendChild(document.createTextNode(' · 阈值 '+(warn==null?'—':signalsFormatValue(warn))+' / '+(crit==null?'—':signalsFormatValue(crit))));
        usable.slice(1,4).forEach(item=>{const p2=item.points[item.points.length-1];meta.appendChild(document.createTextNode(' · '+item.name.split(' ')[0]+' '+signalsFormatValue(p2.value)))});container.appendChild(meta)}
      async function loadBoards(){const grid=$('signalsPanelGrid');try{const response=await fetch(base+'/api/ops/observability/boards',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);if(!response.ok||!data||!data.ok){if(grid){grid.replaceChildren();grid.appendChild(make('div','signals-empty','看板读取失败（需要中心库）'))}return}
          state.boards=data.boards||[];state.boardsLoaded=true;const remembered=String(sessionStorage.getItem('d_obs_board_id')||'');if(remembered&&state.boards.find(board=>board.id===remembered))setCurrentBoard(remembered);else if(!state.boards.find(board=>board.id===state.currentBoardId))setCurrentBoard(state.boards.length?state.boards[0].id:'');renderBoardSelect();renderBoard()}catch{if(grid){grid.replaceChildren();grid.appendChild(make('div','signals-empty','看板读取失败，请检查网络'))}}}
      function renderBoardSelect(){const select=$('boardSelect');if(!select)return;select.replaceChildren();if(!state.boards.length){const option=make('option');option.value='';option.textContent='（还没有看板）';select.appendChild(option);return}
        state.boards.forEach(board=>{const option=make('option');option.value=board.id;option.textContent=board.name+'（'+board.spec.panels.length+'）';if(board.id===state.currentBoardId)option.selected=true;select.appendChild(option)})}
      function persistBoardSpec(){const board=currentBoard();if(!board)return;fetch(base+'/api/ops/observability/boards/'+encodeURIComponent(board.id),{method:'PUT',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({spec:board.spec})}).then(response=>response.json().catch(()=>null)).then(data=>{if(!data||!data.ok){toast('看板保存失败',false);loadBoards()}}).catch(()=>{toast('看板保存失败，请检查网络',false)})}
      function renderBoard(){const board=currentBoard();const windowSelect=$('boardWindow');const fromInput=$('boardRangeFrom');const toInput=$('boardRangeTo');
        if(windowSelect&&board)windowSelect.value=board.spec.range?'custom':String(board.spec.windowMinutes);
        if(fromInput)fromInput.value=board&&board.spec.range?tsToInputValue(board.spec.range.fromMs):'';
        if(toInput)toInput.value=board&&board.spec.range?tsToInputValue(board.spec.range.toMs):'';
        renderBoardPanels()}
      function applyBoardRange(){const board=currentBoard();if(!board)return;const from=inputValueToTs(($('boardRangeFrom')||{}).value);const to=inputValueToTs(($('boardRangeTo')||{}).value);
        if(from==null||to==null){toast('请先选择起止时间',false);return}
        if(to<=from){toast('结束时间要晚于起始时间',false);return}
        if(to-from<5*60_000){toast('区间至少 5 分钟',false);return}
        if(to-from>14*24*3_600_000){toast('区间最多 14 天',false);return}
        board.spec.range={fromMs:from,toMs:to};persistBoardSpec();renderBoard()}
      function clearBoardRange(){const board=currentBoard();if(!board||!board.spec.range)return;board.spec.range=null;persistBoardSpec();renderBoard()}
      function moveBoardPanel(from,to,after){const board=currentBoard();if(!board)return;const panels=board.spec.panels;const moved=panels.splice(from,1)[0];let target=to;if(from<to)target=to-1;if(after)target+=1;panels.splice(Math.max(0,Math.min(panels.length,target)),0,moved);persistBoardSpec();renderBoardPanels();renderBoardSelect()}
      function renderBoardPanels(){const target=$('signalsPanelGrid');if(!target)return;const board=currentBoard();target.replaceChildren();
        if(!board){target.appendChild(make('div','signals-empty','还没有看板：点「新建看板」创建，或「导入模板」生成'));return}
        if(!board.spec.panels.length){target.appendChild(make('div','signals-empty','看板是空的：点「添加面板」，或在指标查询里查好指标后点「存入看板」'))}
        board.spec.panels.forEach((panel,index)=>{const card=make('div','signals-panel-card'+(panel.width===2?' full':''));card.draggable=true;
          const head=make('h4');const titleWrap=make('span');add(titleWrap,'strong','',panel.title);add(titleWrap,'div','',panel.metric+' · '+(panel.windowMinutes?'固定 '+boardWindowLabel(panel.windowMinutes):'跟随看板'));head.appendChild(titleWrap);
          const actions=make('span','panel-actions');const editBtn=add(actions,'button','btn','编辑');editBtn.type='button';editBtn.addEventListener('click',()=>openPanelModal(panel,index));const delBtn=add(actions,'button','btn','删除');delBtn.type='button';delBtn.addEventListener('click',()=>openConfirmModal('删除面板','从看板移除面板「'+panel.title+'」？',()=>{board.spec.panels.splice(index,1);persistBoardSpec();renderBoardPanels();renderBoardSelect()}));head.appendChild(actions);card.appendChild(head);
          card.addEventListener('dragstart',event=>{state.boardDragIndex=index;card.classList.add('dragging');if(event.dataTransfer){event.dataTransfer.effectAllowed='move';try{event.dataTransfer.setData('text/plain',String(index))}catch{}}});
          card.addEventListener('dragend',()=>{card.classList.remove('dragging');state.boardDragIndex=-1});
          card.addEventListener('dragover',event=>{if(state.boardDragIndex<0||state.boardDragIndex===index)return;event.preventDefault();card.classList.add('drop-target')});
          card.addEventListener('dragleave',()=>card.classList.remove('drop-target'));
          card.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();card.classList.remove('drop-target');const from=state.boardDragIndex;if(from<0||from===index)return;const rect=card.getBoundingClientRect();const after=(event.clientX-rect.left)>rect.width/2;moveBoardPanel(from,index,after)});
          const chartWrap=make('div','signals-chart-wrap');card.appendChild(chartWrap);target.appendChild(card);
          const activeRange=board.spec.range;
          const minutes=activeRange?Math.max(5,Math.round((activeRange.toMs-activeRange.fromMs)/60_000)):(panel.windowMinutes||board.spec.windowMinutes);
          let queryParams='/api/ops/observability/metrics/query?metric='+encodeURIComponent(panel.metric)+'&points=120&minutes='+encodeURIComponent(String(minutes));
          if(activeRange)queryParams+='&fromMs='+encodeURIComponent(String(activeRange.fromMs))+'&toMs='+encodeURIComponent(String(activeRange.toMs));
          fetch(base+queryParams,{headers:apiHeaders(false),credentials:'same-origin'}).then(r=>r.json()).then(data=>{const series=(data&&data.ok?data.series:[]).map(item=>({name:item.metric+' '+JSON.stringify(item.labels||{}),points:item.points||[]}));renderBoardChart(chartWrap,series,minutes,panel)}).catch(()=>{chartWrap.replaceChildren();chartWrap.appendChild(make('div','signals-empty','加载失败'))})});
        target.ondragover=event=>event.preventDefault();
        target.ondrop=event=>{event.preventDefault();const dropBoard=currentBoard();if(!dropBoard)return;const from=state.boardDragIndex;if(from<0||from>=dropBoard.spec.panels.length-1)return;moveBoardPanel(from,dropBoard.spec.panels.length-1,true)}}
      function openPanelModal(existing,index){const board=currentBoard();if(!board){toast('先创建一个看板',false);return}
        const overlay=make('div','board-modal');const box=make('div','board-modal-box');add(box,'h3','',existing&&index>=0?'编辑面板':'添加面板');
        const titleLabel=add(box,'label','board-field');add(titleLabel,'span','','面板标题');const titleInput=add(titleLabel,'input');titleInput.type='text';titleInput.value=existing?existing.title:'';
        const metricLabel=add(box,'label','board-field');add(metricLabel,'span','','指标名');const metricInput=add(metricLabel,'input');metricInput.type='text';metricInput.setAttribute('list','signalMetricList');metricInput.value=existing?existing.metric:'';
        const windowLabel=add(box,'label','board-field');add(windowLabel,'span','','时间窗口');const windowSelect=add(windowLabel,'select');[[0,'跟随看板（'+boardWindowLabel(board.spec.windowMinutes)+'）'],[60,'最近 1 小时'],[240,'最近 4 小时'],[1440,'最近 24 小时'],[10080,'最近 7 天'],[20160,'最近 14 天']].forEach(opt=>{const option=make('option');option.value=String(opt[0]);option.textContent=opt[1];windowSelect.appendChild(option)});windowSelect.value=String(existing&&existing.windowMinutes?existing.windowMinutes:0);
        const chartLabel=add(box,'label','board-field');add(chartLabel,'span','','图表类型');const chartSelect=add(chartLabel,'select');[['line','折线图'],['bar','柱状图'],['stat','大数字']].forEach(opt=>{const option=make('option');option.value=opt[0];option.textContent=opt[1];chartSelect.appendChild(option)});chartSelect.value=existing?existing.chart:'line';
        const warnLabel=add(box,'label','board-field');add(warnLabel,'span','','告警阈值（stat 大数字着色，可留空）');const warnInput=add(warnLabel,'input');warnInput.type='number';warnInput.step='any';if(existing&&existing.warnValue!=null)warnInput.value=String(existing.warnValue);
        const critLabel=add(box,'label','board-field');add(critLabel,'span','','严重阈值（stat 大数字着色，可留空）');const critInput=add(critLabel,'input');critInput.type='number';critInput.step='any';if(existing&&existing.critValue!=null)critInput.value=String(existing.critValue);
        const widthLabel=add(box,'label','board-field');add(widthLabel,'span','','宽度');const widthSelect=add(widthLabel,'select');[[1,'半宽'],[2,'整行']].forEach(opt=>{const option=make('option');option.value=String(opt[0]);option.textContent=opt[1];widthSelect.appendChild(option)});widthSelect.value=String(existing?existing.width:1);
        const row=make('div','board-modal-actions');const cancelBtn=add(row,'button','btn','取消');cancelBtn.type='button';const saveBtn=add(row,'button','btn primary','保存');saveBtn.type='button';box.appendChild(row);
        overlay.appendChild(box);document.body.appendChild(overlay);
        const close=()=>overlay.remove();overlay.addEventListener('click',event=>{if(event.target===overlay)close()});cancelBtn.addEventListener('click',close);
        saveBtn.addEventListener('click',()=>{const title=String(titleInput.value||'').trim().slice(0,120);const metric=String(metricInput.value||'').trim();if(!title||!metric){toast('标题和指标名都要填',false);return}
          const numOrNull=v=>{const text=String(v).trim();if(text==='')return null;const n=Number(text);return Number.isFinite(n)?n:null};
          const panel={title:title,metric:metric,windowMinutes:Number(windowSelect.value)>0?Number(windowSelect.value):null,chart:chartSelect.value,width:Number(widthSelect.value)===2?2:1,warnValue:numOrNull(warnInput.value),critValue:numOrNull(critInput.value)};
          if(index>=0)board.spec.panels[index]=panel;else board.spec.panels.push(panel);
          close();persistBoardSpec();renderBoardPanels();renderBoardSelect()})}
      async function saveSignalsPanel(){const metric=String(($('signalMetricInput')||{}).value||'').trim();const minutes=Number(($('signalMinutes')||{}).value||240);if(!metric){toast('先查询一个指标再存入看板',false);return}
        if(!state.boardsLoaded)await loadBoards();
        let board=currentBoard();
        if(!board){try{const response=await fetch(base+'/api/ops/observability/boards',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({name:'默认看板'})});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){state.boards.push(data.board);setCurrentBoard(data.board.id);board=data.board;renderBoardSelect()}else{toast(data&&data.error==='too_many_boards'?'看板数量已达上限':'创建默认看板失败',false);return}}catch{toast('创建默认看板失败，请检查网络',false);return}}
        openPanelModal({title:metric,metric:metric,windowMinutes:minutes,chart:'line',width:1},-1)}
      function openTextModal(title,label,initial,onSave){const overlay=make('div','board-modal');const box=make('div','board-modal-box');add(box,'h3','',title);
        const field=add(box,'label','board-field');add(field,'span','',label);const input=add(field,'input');input.type='text';input.value=initial||'';
        const row=make('div','board-modal-actions');const cancelBtn=add(row,'button','btn','取消');cancelBtn.type='button';const okBtn=add(row,'button','btn primary','确定');okBtn.type='button';box.appendChild(row);
        overlay.appendChild(box);document.body.appendChild(overlay);
        const close=()=>overlay.remove();overlay.addEventListener('click',event=>{if(event.target===overlay)close()});cancelBtn.addEventListener('click',close);
        const submit=()=>{const value=String(input.value||'').trim();if(!value){toast('内容不能为空',false);return}close();onSave(value)};okBtn.addEventListener('click',submit);input.addEventListener('keydown',event=>{if(event.key==='Enter')submit()});input.focus()}
      function openConfirmModal(title,message,onOk){const overlay=make('div','board-modal');const box=make('div','board-modal-box');add(box,'h3','',title);add(box,'p','board-confirm-text',message);
        const row=make('div','board-modal-actions');const cancelBtn=add(row,'button','btn','取消');cancelBtn.type='button';const okBtn=add(row,'button','btn danger','删除');okBtn.type='button';box.appendChild(row);
        overlay.appendChild(box);document.body.appendChild(overlay);
        const close=()=>overlay.remove();overlay.addEventListener('click',event=>{if(event.target===overlay)close()});cancelBtn.addEventListener('click',close);okBtn.addEventListener('click',()=>{close();onOk()})}
      function createBoardFlow(){openTextModal('新建看板','看板名称','',name=>{
        fetch(base+'/api/ops/observability/boards',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({name:name.slice(0,120)})}).then(r=>r.json().catch(()=>null)).then(data=>{if(data&&data.ok){setCurrentBoard(data.board.id);toast('看板已创建');loadBoards()}else toast(data&&data.error==='too_many_boards'?'看板数量已达上限（20）':'创建失败',false)}).catch(()=>toast('创建失败，请检查网络',false))})}
      function renameBoardFlow(){const board=currentBoard();if(!board)return;openTextModal('重命名看板','看板名称',board.name,name=>{
        fetch(base+'/api/ops/observability/boards/'+encodeURIComponent(board.id),{method:'PUT',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({name:name.slice(0,120)})}).then(r=>r.json().catch(()=>null)).then(data=>{if(data&&data.ok){toast('已重命名');loadBoards()}else toast('重命名失败',false)}).catch(()=>toast('重命名失败，请检查网络',false))})}
      function deleteBoardFlow(){const board=currentBoard();if(!board)return;openConfirmModal('删除看板','删除看板「'+board.name+'」及其 '+board.spec.panels.length+' 个面板配置？查询历史不受影响。',()=>{
        fetch(base+'/api/ops/observability/boards/'+encodeURIComponent(board.id),{method:'DELETE',headers:apiHeaders(true),credentials:'same-origin'}).then(response=>{if(response.ok){toast('看板已删除');setCurrentBoard('');loadBoards()}else toast('删除失败',false)}).catch(()=>toast('删除失败，请检查网络',false))})}
      function exportBoardFlow(){const board=currentBoard();if(!board){toast('没有可导出的看板',false);return}
        const template={kind:'d-obs-board',version:1,name:board.name,spec:board.spec,exportedAt:new Date().toISOString()};
        const blob=new Blob([JSON.stringify(template,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=board.name+'.board.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已导出看板模板')}
      async function importBoardFile(file){let template;try{template=JSON.parse(await file.text())}catch{toast('模板文件不是合法 JSON',false);return}
        try{const response=await fetch(base+'/api/ops/observability/boards/import',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({template:template})});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){setCurrentBoard(data.board.id);toast('已导入看板「'+data.board.name+'」');loadBoards()}else toast(data&&data.error==='invalid_board_template'?'模板结构不合法（需要 spec.panels）':'导入失败',false)}catch{toast('导入失败，请检查网络',false)}}
      function importBoardFlow(){const input=$('boardImportFile');if(!input)return;input.value='';input.click()}
      function aiBoardFlow(){openTextModal('AI 生成看板','用一句中文描述想监控什么（如：结账服务流量与性能总览）','',question=>{
        toast('正在生成看板…');
        fetch(base+'/api/ops/observability/boards/from-nl',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({question:question})}).then(r=>r.json().catch(()=>null)).then(data=>{
          if(data&&data.ok){setCurrentBoard(data.board.id);toast(data.source==='model'?'AI 看板已生成（'+data.board.spec.panels.length+' 个面板）':'已按规则生成单面板看板');loadBoards();return}
          if(data&&data.error==='nl_board_no_match'){toast('没匹配到落库指标：换个说法，或先在指标查询页确认指标有数据',false);return}
          if(data&&data.error==='too_many_boards'){toast('看板数量已达上限（20）',false);return}
          toast('生成失败，请稍后重试',false)}).catch(()=>toast('生成失败，请检查网络',false))})}

      // ============ 边缘设备 ============
      state.deviceRevealToken=state.deviceRevealToken||'';
      async function loadDevicesView(){const target=$('devicesContent');if(!target)return;target.replaceChildren();const loading=make('div','shell-status');loading.setAttribute('role','status');add(loading,'span','shell-spinner','');add(loading,'strong','','正在读取设备清单');add(loading,'small','','查询注册设备、心跳与在线状态…');target.appendChild(loading);
        try{const response=await fetch(base+'/api/ops/observability/devices',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){const failed=make('div','signals-empty','设备清单读取失败（需要运营权限与中心库）');target.appendChild(failed);return}
          const devices=data.devices||[];state.deviceRevealToken='';
          const table=make('table','devices-table');const thead=make('thead');const headRow=make('tr');[['设备','device'],['归属','tenant'],['型号 / 固件','model'],['状态','status'],['最近心跳','seen'],['操作','ops']].forEach(h=>add(headRow,'th','',h[0]));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');
          if(!devices.length){const emptyRow=make('tr');const emptyCell=add(emptyRow,'td','',"还没有注册设备：在上方注册并部署 edge-agent 后，心跳会自动出现在这里");emptyCell.colSpan=6;tbody.appendChild(emptyRow)}
          devices.forEach(device=>{const tr=make('tr');const idCell=add(tr,'td');add(idCell,'strong','',device.deviceId);if(device.displayName&&device.displayName!==device.deviceId)add(idCell,'div','',device.displayName);
            add(tr,'td','',device.tenantId);const modelCell=add(tr,'td','');add(modelCell,'div','',device.model||'—');if(device.firmware)add(modelCell,'small','','固件 '+device.firmware);
            const statusCell=add(tr,'td');if(device.status==='disabled')add(statusCell,'span','device-pill offline','已停用');else add(statusCell,'span','device-pill '+(device.online?'online':'offline'),device.online?'在线':'离线');
            add(tr,'td','',device.lastSeenAt?when(device.lastSeenAt):'从未上报');
            const opsCell=add(tr,'td');const detailBtn=add(opsCell,'button','btn','指标');detailBtn.type='button';detailBtn.addEventListener('click',()=>toggleDeviceDetail(device.deviceId,detailBtn));const cmdsBtn=add(opsCell,'button','btn','命令');cmdsBtn.type='button';cmdsBtn.addEventListener('click',()=>openDeviceCommandsModal(device.deviceId));const rotateBtn=add(opsCell,'button','btn','轮换 token');rotateBtn.type='button';rotateBtn.addEventListener('click',()=>rotateDeviceTokenFlow(device.deviceId));const toggleBtn=add(opsCell,'button','btn',device.status==='disabled'?'启用':'停用');toggleBtn.type='button';toggleBtn.addEventListener('click',async()=>{try{const next=device.status==='disabled'?'active':'disabled';const r=await fetch(base+'/api/ops/observability/devices/'+encodeURIComponent(device.deviceId)+'/status',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({status:next})});if(r.ok){toast(next==='active'?'设备已启用':'设备已停用');loadDevicesView()}else toast('操作失败',false)}catch{toast('操作失败',false)}});
            tbody.appendChild(tr)});table.appendChild(tbody);target.appendChild(table)}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','设备清单读取失败，请检查网络'))}}
      function openDeviceCommandsModal(deviceId){
        const overlay=make('div','board-modal');const box=make('div','board-modal-box');add(box,'h3','','设备命令 · '+deviceId);
        const typeLabel=add(box,'label','board-field');add(typeLabel,'span','','命令类型');const typeSelect=add(typeLabel,'select');
        [['ping','ping（连通性检查）'],['set-interval','set-interval（调整上报间隔）'],['update-agent','update-agent（拉取最新 agent 并重启）']].forEach(opt=>{const option=make('option');option.value=opt[0];option.textContent=opt[1];typeSelect.appendChild(option)});
        const secondsLabel=add(box,'label','board-field');add(secondsLabel,'span','','间隔秒数（5-3600，仅 set-interval 需要）');const secondsInput=add(secondsLabel,'input');secondsInput.type='number';secondsInput.value='60';
        const issueBtn=add(box,'button','btn primary','下发命令');issueBtn.type='button';
        const listWrap=make('div');box.appendChild(listWrap);
        const row=make('div','board-modal-actions');const closeBtn=add(row,'button','btn','关闭');closeBtn.type='button';box.appendChild(row);
        overlay.appendChild(box);document.body.appendChild(overlay);
        const close=()=>overlay.remove();overlay.addEventListener('click',event=>{if(event.target===overlay)close()});closeBtn.addEventListener('click',close);
        async function reload(){listWrap.replaceChildren();try{const response=await fetch(base+'/api/ops/observability/devices/'+encodeURIComponent(deviceId)+'/commands',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);listWrap.replaceChildren();if(!data||!data.ok){add(listWrap,'div','signals-empty','命令清单读取失败');return}
          const commands=data.commands||[];if(!commands.length){add(listWrap,'div','signals-empty','还没有下发过命令');return}
          const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['时间','类型','状态','结果'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');
          commands.forEach(cmd=>{const tr=make('tr');add(tr,'td','',when(cmd.createdAt));add(tr,'td','',cmd.type);const st=add(tr,'td');add(st,'span','signals-log-sev '+(cmd.status==='ok'?'INFO':cmd.status==='failed'?'ERROR':'WARN'),cmd.status);add(tr,'td','',cmd.result||'—');tbody.appendChild(tr)});
          table.appendChild(tbody);listWrap.appendChild(table)}catch{listWrap.replaceChildren();add(listWrap,'div','signals-empty','命令清单读取失败')}}
        issueBtn.addEventListener('click',async()=>{const payload=typeSelect.value==='set-interval'?{intervalSeconds:Number(secondsInput.value)||60}:{};issueBtn.disabled=true;
          try{const response=await fetch(base+'/api/ops/observability/devices/'+encodeURIComponent(deviceId)+'/commands',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({type:typeSelect.value,payload:payload})});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){toast('命令已下发，等设备下一轮心跳认领');await reload()}else toast(data&&data.error==='invalid_command_payload'?'参数不合法':'下发失败',false)}catch{toast('下发失败，请检查网络',false)}
          issueBtn.disabled=false});
        reload()}
      function toggleDeviceDetail(deviceId,button){const existing=$('device-detail-'+deviceId);if(existing){existing.remove();button.textContent='指标';return}button.textContent='收起';const table=button.closest('table');if(!table)return;const row=button.closest('tr');const holder=make('tr');const cell=add(holder,'td');cell.colSpan=6;const detail=make('div','device-detail');detail.id='device-detail-'+deviceId;add(detail,'strong','','设备指标（最近 24 小时）');const chartWrap=make('div','signals-chart-wrap');detail.appendChild(chartWrap);cell.appendChild(detail);if(row&&row.parentNode)row.parentNode.insertBefore(holder,row.nextSibling);
        fetch(base+'/api/ops/observability/devices/'+encodeURIComponent(deviceId)+'/samples?minutes=1440&points=240',{headers:apiHeaders(false),credentials:'same-origin'}).then(r=>r.json()).then(data=>{if(!data||!data.ok){chartWrap.appendChild(make('div','signals-empty','样本读取失败'));return}
          const samples=data.samples||[];const keys={};samples.forEach(s=>Object.keys(s.metrics||{}).forEach(k=>{keys[k]=true}));const preferred=['cpu_percent','mem_percent','temp_c','disk_percent','load1','bpu0_util'].filter(k=>keys[k]);const chosen=preferred.length?preferred.slice(0,4):Object.keys(keys).slice(0,4);
          const series=chosen.map(k=>({name:k,points:samples.map(s=>({ts:s.ts,value:Number(s.metrics[k])||0}))}));renderSignalsChart(chartWrap,series,1440)}).catch(()=>{chartWrap.appendChild(make('div','signals-empty','样本读取失败'))})}
      async function registerDeviceFlow(){const deviceId=String(($('newDeviceId')||{}).value||'').trim();const displayName=String(($('newDeviceName')||{}).value||'').trim();const model=String(($('newDeviceModel')||{}).value||'').trim();if(!deviceId){toast('请填写设备 ID（小写字母/数字/点/连字符）',false);return}
        try{const response=await fetch(base+'/api/ops/observability/devices',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({deviceId:deviceId,displayName:displayName,model:model})});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){state.deviceRevealToken=data.token;toast('设备已注册');loadDevicesView();const hint=$('newDeviceTokenHint');if(hint){hint.classList.remove('hidden');hint.textContent='设备 '+data.device.deviceId+' 的 token（只显示一次，立即保存）：'+data.token+'  |  部署：RDK_OBS_REPORT_URL 指向本服务，RDK_DEVICE_TOKEN_FILE 存入该 token，运行 tools/edge-agent.mjs'}}else toast(data&&data.error==='invalid_device_id'?'设备 ID 不合法（小写字母/数字开头，2-64 位）':'注册失败',false)}catch{toast('注册失败，请检查网络',false)}}
      async function rotateDeviceTokenFlow(deviceId){if(!window.confirm('轮换设备 '+deviceId+' 的 token？旧 token 立即失效。'))return;
        try{const response=await fetch(base+'/api/ops/observability/devices/'+encodeURIComponent(deviceId)+'/token',{method:'POST',headers:apiHeaders(true),credentials:'same-origin'});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){const hint=$('newDeviceTokenHint');if(hint){hint.classList.remove('hidden');hint.textContent='设备 '+deviceId+' 的新 token（只显示一次，立即保存）：'+data.token}toast('token 已轮换')}else toast('轮换失败',false)}catch{toast('轮换失败',false)}}
      // ============ 质量与反馈趋势 ============
      async function loadQualitySummary(){const target=$('signalsQualityContent');if(!target)return;try{const response=await fetch(base+'/api/ops/observability/quality/summary?days=30',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty','质量趋势读取失败（需要中心库）'));return}
          const trend=data.trend||{};const totals=trend.totals||{};
          const kpis=make('div','signals-legend');[['反馈条数',String(totals.feedbackCount??0)],['好评率',totals.positiveRate==null?'—':Math.round(totals.positiveRate*100)+'%'],['评分样本',String(totals.scoreCount??0)],['平均评分',totals.avgScore==null?'—':String(totals.avgScore)]].forEach(item=>{const node=make('span');add(node,'strong','',item[1]);add(node,'span','', ' '+item[0]);node.style.gap='4px';kpis.appendChild(node)});target.appendChild(kpis);
          const active=(trend.series||[]).filter(p=>p.feedbackCount>0||p.scoreCount>0);if(!active.length){target.appendChild(make('div','signals-empty','近 30 天还没有评分或反馈数据；在链路追踪里对 run 打分/点 👍👎 后这里会出现趋势'));return}
          const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['日期','反馈','好评率','评分样本','平均评分'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');active.slice(-14).forEach(p=>{const tr=make('tr');add(tr,'td','',p.day);add(tr,'td','',String(p.feedbackCount));add(tr,'td','',p.positiveRate==null?'—':Math.round(p.positiveRate*100)+'%');add(tr,'td','',String(p.scoreCount));add(tr,'td','',p.avgScore==null?'—':String(p.avgScore));tbody.appendChild(tr)});table.appendChild(tbody);target.appendChild(table)}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','质量趋势读取失败，请检查网络'))}}

      // ============ 生态接入凭据（人/服务/租户三级） ============
      const ingestSubjectNames={user:'用户',service:'服务',tenant:'租户'};
      function showIngestTokenSecret(token,prefix){const hint=$('ingestTokenSecretHint');if(hint){hint.classList.remove('hidden');hint.textContent=prefix+token+'  |  上报示例：OTEL_EXPORTER_OTLP_HEADERS=\\'Authorization=Bearer '+token.slice(0,8)+'…\\'（完整值见上方，只显示一次）'}}
      async function loadIngestTokens(){const target=$('ingestTokensContent');if(!target)return;try{const response=await fetch(base+'/api/ops/observability/ingest-tokens',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty','凭据清单读取失败（需要中心库）'));return}
          const tokens=data.tokens||[];if(!tokens.length){target.appendChild(make('div','signals-empty','还没有签发凭据；上方选择对象类型与 ID 后点「签发」'));return}
          const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['对象','类型','显示名','owner 前缀','状态','最近上报','操作'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');
          tokens.forEach(row=>{const tr=make('tr');add(tr,'td','',row.subjectId||'—');add(tr,'td','',ingestSubjectNames[row.subjectType]||row.subjectType);add(tr,'td','',row.displayName||'—');add(tr,'td','',String(row.owner||'').slice(0,22)+'…');const st=add(tr,'td');add(st,'span','signals-log-sev '+(row.status==='active'?'INFO':'ERROR'),row.status==='active'?'active':'revoked');add(tr,'td','',when(row.lastSeenAt));const op=add(tr,'td');const rotate=add(op,'button','btn','轮换');rotate.type='button';rotate.addEventListener('click',()=>ingestTokenAction(row.tokenId,'rotate'));const revoke=add(op,'button','btn','吊销');revoke.type='button';revoke.addEventListener('click',()=>ingestTokenAction(row.tokenId,'revoke'));tbody.appendChild(tr)});
          table.appendChild(tbody);target.appendChild(table)}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','凭据清单读取失败，请检查网络'))}}
      async function ingestTokenAction(tokenId,action){if(action==='rotate'&&!window.confirm('轮换该凭据？旧 token 立即失效。'))return;
        try{const response=await fetch(base+'/api/ops/observability/ingest-tokens/'+encodeURIComponent(tokenId)+'/'+action,{method:'POST',headers:apiHeaders(true),credentials:'same-origin'});const data=await response.json().catch(()=>null);if(!response.ok||!data||!data.ok){toast(action==='rotate'?'轮换失败':'吊销失败',false);return}
          if(action==='rotate')showIngestTokenSecret(data.token,'轮换成功，新 token（只显示一次）：');else toast('已吊销');loadIngestTokens()}catch{toast('操作失败，请检查网络',false)}}
      async function issueIngestTokenFlow(){const subjectType=String(($('ingestTokenSubjectType')||{}).value||'');const subjectId=String(($('ingestTokenSubjectId')||{}).value||'').trim();const displayName=String(($('ingestTokenDisplayName')||{}).value||'').trim();if(!subjectId){toast('请填写对象 ID（如 sso 用户 ID / 服务名 / 租户 ID）',false);return}
        try{const response=await fetch(base+'/api/ops/observability/ingest-tokens',{method:'POST',headers:apiHeaders(true),credentials:'same-origin',body:JSON.stringify({subjectType:subjectType,subjectId:subjectId,displayName:displayName})});const data=await response.json().catch(()=>null);if(response.ok&&data&&data.ok){toast('凭据已签发');showIngestTokenSecret(data.token,'对象 '+data.record.subjectId+' 的 token（只显示一次，立即保存）：');loadIngestTokens()}else toast(data&&data.error==='invalid_subject_id'?'对象 ID 格式不合法（2-128 位字母数字与.@_:-）':'签发失败',false)}catch{toast('签发失败，请检查网络',false)}}

      // ============ 自然语言查询与指标字典 ============
      async function renderNlChart(series, minutes){const target=$('nlQueryResult');if(!target)return;const chartWrap=make('div','signals-chart-wrap');target.appendChild(chartWrap);renderSignalsChart(chartWrap,series,minutes)}
      async function executePromql(promql,minutes){const target=$('nlQueryResult');if(!target)return;const status=make('div','signals-empty','正在执行 PromQL…');target.appendChild(status);
        try{const response=await fetch(base+'/api/ops/observability/prom/query?query='+encodeURIComponent(promql)+'&minutes='+encodeURIComponent(String(minutes)),{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);status.remove();if(!response.ok||!data||!data.ok){const note=make('div','signals-empty',data&&data.error==='prometheus_not_configured'?'未配置 RDK_PROMETHEUS_QUERY_URL，无法直接执行；语句已生成，可在 Prometheus 里查询':'Prometheus 查询失败');target.appendChild(note);return}
          renderNlChart(data.series||[],minutes)}catch{status.remove();target.appendChild(make('div','signals-empty','Prometheus 查询失败，请检查网络'))}}
      async function runNlQuery(){const input=$('nlQueryInput');const target=$('nlQueryResult');if(!input||!target)return;const question=String(input.value||'').trim();if(!question){toast('先用一句中文描述你想查什么',false);return}
        target.replaceChildren();target.appendChild(make('div','signals-empty','正在理解问题…'));
        try{const response=await fetch(base+'/api/ops/observability/nl-query',{method:'POST',headers:apiHeaders(false),credentials:'same-origin',body:JSON.stringify({question:question})});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty',data&&data.error==='nl_query_no_match'?'没能识别目标指标；换个问法，或在指标字典里直接选。':'智能查询暂时不可用'));return}
          const spec=data.spec||{};const head=make('div','signals-legend');const badge=make('span','signals-log-sev '+(data.source==='model'?'INFO':'WARN'));badge.textContent=data.source==='model'?'AI':'规则';head.appendChild(badge);
          const explain=add(head,'span','',spec.explanation||'');head.style.gap='6px';target.appendChild(head);
          if(spec.metric&&(spec.plane==='prometheus'||spec.plane==='otlp')&&data.promql){const code=add(target,'code','',data.promql);code.style.display='block';code.style.margin='6px 0';const run=add(target,'button','btn primary','执行查询');run.type='button';run.addEventListener('click',()=>executePromql(data.promql,spec.windowMinutes||240))}
          if(spec.metric&&spec.plane==='otlp'){
            const loading=make('div','signals-empty','正在查询平台内指标 '+spec.metric+' …');target.appendChild(loading);
            const params='/api/ops/observability/metrics/query?metric='+encodeURIComponent(spec.metric)+'&minutes='+encodeURIComponent(String(spec.windowMinutes||240))+'&points=240';
            fetch(base+params,{headers:apiHeaders(false),credentials:'same-origin'}).then(r=>r.json()).then(data2=>{loading.remove();const series=(data2&&data2.ok?data2.series:[]).map(item=>({name:item.metric+' '+JSON.stringify(item.labels||{}),points:item.points||[]}));if(!series.length){target.appendChild(make('div','signals-empty','所选范围内没有数据点'));return}renderNlChart(series,spec.windowMinutes||240)}).catch(()=>{loading.textContent='平台内指标查询失败'})}
          if(!spec.metric){target.appendChild(make('div','signals-empty','未能定位到具体指标；试试「指标字典」页签，或在下方直接输入指标名。'))}
        }catch{target.replaceChildren();target.appendChild(make('div','signals-empty','智能查询失败，请检查网络'))}}
      async function loadMetricCatalog(){const target=$('metricCatalogContent');if(!target)return;try{const response=await fetch(base+'/api/ops/observability/metrics/catalog',{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty','指标字典读取失败'));return}
          const groups=new Map();for(const entry of (data.catalog||[])){if(!groups.has(entry.category))groups.set(entry.category,[]);groups.get(entry.category).push(entry)}
          for(const [category,entries] of groups){const details=make('details','detail-sections');const summary=add(details,'summary','detail-summary');add(summary,'strong','',category+'（'+entries.length+'）');details.appendChild(summary);
            const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['指标','说明','标签'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');
            entries.forEach(entry=>{const tr=make('tr');const nameTd=add(tr,'td');if(entry.metric.startsWith('otlp://')){add(nameTd,'em','',entry.zhName)}else{const btn=add(nameTd,'button','btn','');btn.type='button';btn.textContent=entry.zhName+' · '+entry.metric;btn.addEventListener('click',()=>{const input=$('signalMetricInput');if(input&&entry.metric&&!entry.metric.includes('*')){input.value=entry.metric;toast('已填入指标查询');}})}add(tr,'td','',entry.description);add(tr,'td','',entry.labels.join(', ')||'—');tbody.appendChild(tr)});
            table.appendChild(tbody);details.appendChild(table);target.appendChild(details)}}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','指标字典读取失败，请检查网络'))}}

      async function loadMetricAnomalies(){const target=$('metricAnomaliesContent');if(!target)return;const minutes=Number(($('anomalyMinutes')||{}).value||240);target.replaceChildren();target.appendChild(make('div','signals-empty','正在扫描统计异常…'));
        try{const response=await fetch(base+'/api/ops/observability/metrics/anomalies?minutes='+encodeURIComponent(String(minutes)),{headers:apiHeaders(false),credentials:'same-origin'});const data=await response.json().catch(()=>null);target.replaceChildren();if(!response.ok||!data||!data.ok){target.appendChild(make('div','signals-empty','异常检测失败（需要中心库）'));return}
          const anomalies=data.anomalies||[];const scanned=(data.scanned||{}).metrics||0;
          const head=add(target,'div','signals-legend');add(head,'span','','已扫描 '+scanned+' 个指标的窗口数据');
          if(!anomalies.length){target.appendChild(make('div','signals-empty','窗口内没有统计异常（或样本不足）'));return}
          const table=make('table','signals-log-table');const thead=make('thead');const headRow=make('tr');['指标','标签','最新值','基线','z 分数','时间'].forEach(h=>add(headRow,'th','',h));thead.appendChild(headRow);table.appendChild(thead);const tbody=make('tbody');
          anomalies.forEach(item=>{const tr=make('tr');add(tr,'td','',item.metric);add(tr,'td','',JSON.stringify(item.labels||{}));add(tr,'td','',signalsFormatValue(item.value));add(tr,'td','',signalsFormatValue(item.baseline));const scoreCell=add(tr,'td');add(scoreCell,'span','signals-log-sev '+(item.score>=5?'ERROR':'WARN'),String(item.score));add(tr,'td','',when(item.ts));tbody.appendChild(tr)});
          table.appendChild(tbody);target.appendChild(table)}catch{target.replaceChildren();target.appendChild(make('div','signals-empty','异常检测失败，请检查网络'))}}
      function renderSignalsView(){loadSignalMetricNames();loadBoards();runSignalsMetricQuery();runSignalsLogQuery();loadQualitySummary();loadIngestTokens();loadMetricCatalog()}
      (function bindSignalsControls(){const bind=(id,event,handler)=>{const node=$(id);if(node)node.addEventListener(event,handler)};
        bind('signalQueryBtn','click',runSignalsMetricQuery);
        bind('signalMetricInput','keydown',event=>{if(event.key==='Enter')runSignalsMetricQuery()});
        bind('signalSavePanelBtn','click',saveSignalsPanel);
        bind('signalLogQueryBtn','click',runSignalsLogQuery);
        bind('anomalyDetectBtn','click',loadMetricAnomalies);
        bind('boardSelect','change',event=>{setCurrentBoard(String(event.target.value||''));renderBoard()});
        bind('boardWindow','change',event=>{const board=currentBoard();if(!board)return;if(event.target.value==='custom'){renderBoard();return}board.spec.range=null;board.spec.windowMinutes=Number(event.target.value)||240;persistBoardSpec();renderBoard()});
        bind('boardRangeApplyBtn','click',applyBoardRange);
        bind('boardRangeClearBtn','click',clearBoardRange);
        bind('boardAutoRefresh','change',event=>setBoardAutoRefresh(Number(event.target.value)||0));
        bind('boardKioskBtn','click',toggleBoardKiosk);
        bind('boardAiBtn','click',aiBoardFlow);
        bind('boardAddPanelBtn','click',()=>openPanelModal(null,-1));
        bind('boardRefreshBtn','click',renderBoardPanels);
        bind('boardNewBtn','click',createBoardFlow);
        bind('boardRenameBtn','click',renameBoardFlow);
        bind('boardImportBtn','click',importBoardFlow);
        bind('boardExportBtn','click',exportBoardFlow);
        bind('boardDeleteBtn','click',deleteBoardFlow);
        bind('boardImportFile','change',event=>{const file=event.target.files&&event.target.files[0];if(file)importBoardFile(file)});
        bind('registerDeviceBtn','click',registerDeviceFlow);
        bind('nlQueryBtn','click',runNlQuery);
        bind('nlQueryInput','keydown',event=>{if(event.key==='Enter')runNlQuery()});
        bind('ingestTokenIssueBtn','click',issueIngestTokenFlow)})();
`
