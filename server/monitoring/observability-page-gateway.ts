export const OPS_OBSERVABILITY_GATEWAY_STYLE = `
  .gateway-workspace{display:grid;gap:16px}
  .gateway-workspace .gateway-panel{min-width:0;padding:18px}
  .gateway-panel h2{margin:0 0 12px;font-size:16px;color:var(--text)}
  .gateway-checks{list-style:none;margin:0;padding:0}
  .gateway-checks li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
  .gateway-checks p{margin:4px 0 0;color:var(--muted);overflow-wrap:anywhere}
  .gateway-checks .gateway-status{display:flex;gap:7px;align-items:center;white-space:nowrap}
  .gateway-checks time{color:var(--muted);font-size:12px}
  .gateway-checks .gateway-evidence{grid-column:1/-1;justify-self:start}
  .gateway-slo{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
  .gateway-slo article{min-width:0;border-top:1px solid var(--line);padding-top:12px}
  .gateway-slo h3{margin:0;color:var(--text);font-size:13px;font-weight:600}
  .gateway-slo strong{display:block;margin:7px 0;font-size:22px;font-variant-numeric:tabular-nums}
  .gateway-slo small{display:block;color:var(--muted);line-height:1.5}
  .gateway-panel>.btn{margin-top:14px}
  @media(min-width:1050px){
    .gateway-workspace:has(.gateway-public){grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}
    .gateway-public{grid-column:2;grid-row:1/3}
    .gateway-reliability{grid-column:1;grid-row:2}
  }
  @media(max-width:720px){.gateway-workspace .gateway-panel{padding:14px}.gateway-slo{grid-template-columns:1fr;gap:12px}}
`;

export const OPS_OBSERVABILITY_GATEWAY_HTML = `
    <section id="view-gateway" class="view hidden" aria-label="网关">
      <div class="module-switcher" role="tablist" aria-label="网关视图">
        <button class="module-switch-tab" type="button" role="tab" data-module-tab="gateway/overview" aria-selected="true">概况</button>
        <button class="module-switch-tab" type="button" role="tab" data-module-tab="gateway/model-pool" aria-selected="false">模型池</button>
      </div>
      <div class="view-module is-active" data-view-module="gateway/overview" role="tabpanel" aria-label="网关概况">
        <div id="gatewayOverviewContent" class="gateway-workspace"></div>
      </div>
      <div class="view-module" data-view-module="gateway/model-pool" role="tabpanel" aria-label="模型池" hidden>
        <div id="modelPoolContent"></div>
      </div>
    </section>`;

export const OPS_OBSERVABILITY_GATEWAY_SCRIPT = String.raw`
      const gatewayCheckGroups=[
        ['模型网关', [['agent-model-target-degraded','主备模型目标']]],
        ['公网入口', [['public-health','入口健康'],['nginx-5xx-log','Nginx 5xx'],['external-dns','异地 DNS'],['external-tls','异地 TLS']]],
      ];
      function gatewayPlatformAvailable(){return !opsTenantMode&&!opsMemberMode&&!adminTenantQuery()}
      function gatewayScopeNotice(root){
        OpsUI.state(root,{kind:'empty',title:'网关属于平台视图',hint:'切换到平台范围后查看。'});
      }
      function updateGatewayReadError(message){
        state.gatewayReadError=message;
        if(state.viewSource==='gateway/overview')renderGatewayOverview();
      }
      function renderGatewayOverview(){
        const root=$('gatewayOverviewContent');if(!root)return;
        root.replaceChildren();
        if(!gatewayPlatformAvailable()){gatewayScopeNotice(root);return}
        if(state.gatewayReadError){
          OpsUI.state(root,{kind:'error',title:'网关状态读取失败',hint:'刷新数据后重新确认当前状态。',retry:()=>loadAll(true)});
          return;
        }
        if(!state.overview){OpsUI.state(root,{kind:'loading',title:'正在读取网关状态…'});return}
        const checks=new Map((state.overview.checks||[]).map(check=>[check.key,check]));
        const knownStatuses={...statusNames,observing:'观察中',unknown:'待确认'};
        gatewayCheckGroups.forEach(([title,rows])=>{
          const panel=add(root,'section','panel gateway-panel'+(title==='公网入口'?' gateway-public':''));add(panel,'h2','',title);
          const list=add(panel,'ul','gateway-checks');
          rows.forEach(([key,label])=>{
            const check=checks.get(key);
            const status=check&&Object.hasOwn(knownStatuses,check.status)?check.status:'unknown';
            const item=add(list,'li','');const body=add(item,'div','');add(body,'strong','',label);
            add(body,'p','',check?.summary||'暂无检查回执');
            if(check?.checkedAt){const time=add(body,'time','','最近检查 '+when(check.checkedAt));time.dateTime=check.checkedAt}
            const indicator=add(item,'div','gateway-status');add(indicator,'span','state-dot '+status);add(indicator,'span','',knownStatuses[status]);
            const def=['agent-model-target-degraded','nginx-5xx-log'].includes(key)&&state.config?.definitions?.find(rule=>rule.key===key);
            if(check&&def&&state.config?.rules?.[key]){
              const button=add(item,'button','btn gateway-evidence','查看'+label+'证据');button.type='button';
              button.addEventListener('click',()=>openAlertDetail(def));
            }
          });
        });
        const panel=add(root,'section','panel gateway-panel gateway-reliability');add(panel,'h2','','可用性与延迟');
        const metrics=add(panel,'div','gateway-slo');
        const objectives=state.overview.serviceLevels?.objectives||[];
        [['gateway-availability','网关可用性'],['gateway-latency','网关响应时间达标率'],['ai-ttft','Studio AI 首字延迟达标率']].forEach(([key,label])=>{
          const objective=objectives.find(item=>item.key===key);
          const card=add(metrics,'article','');add(card,'h3','',label);
          if(!objective){add(card,'strong','','暂无读数');return}
          const rate=objective.compliancePercent;
          const measured=objective.dataAvailable&&Number.isFinite(rate);
          add(card,'strong',measured&&rate<objective.targetPercent?'bad':'',measured?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(rate)+'%':'样本不足');
          add(card,'small','','目标 '+objective.targetPercent+'% · '+objective.windowDays+' 天 · '+Number(objective.sampleCount).toLocaleString('zh-CN')+' 个样本');
        });
        const more=add(panel,'button','btn','查看服务可靠性');more.type='button';more.addEventListener('click',()=>setView('service-levels'));
      }
`;
