/** Historical alert context uses the workbench's authenticated and tenant-scoped API. */
export const OPS_OBSERVABILITY_ALERT_EVIDENCE_STYLE = `
    .alert-evidence{width:100%;max-width:100%;box-sizing:border-box;margin:20px 0;border-top:1px solid var(--line);padding-top:18px;min-width:0}
    .alert-evidence h3{margin:0 0 8px;font-size:15px}
    .alert-evidence h4{font-size:13px;margin:18px 0 8px}
    .alert-evidence-note{color:var(--muted);font-size:12px;line-height:1.6;margin:6px 0 12px;overflow-wrap:anywhere}
    .alert-evidence-counts{font-size:13px;font-weight:600;margin:10px 0}
    .alert-evidence-table-wrap{overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:8px}
    .alert-evidence-table{width:100%;border-collapse:collapse;font-size:12px}
    .alert-evidence-table th,.alert-evidence-table td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere;min-width:74px}
    .alert-evidence-table th{font-weight:600;white-space:nowrap;color:var(--muted)}
    .alert-evidence-table tr:last-child td{border-bottom:0}
    .alert-evidence-samples{display:grid;gap:10px}
    .alert-evidence-sample{border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
    .alert-evidence-sample p{font-size:12px;line-height:1.6;overflow-wrap:anywhere;margin:6px 0}
    .alert-evidence-sample .btn{margin-top:6px}
    .alert-evidence-state{font-size:12px;line-height:1.6;padding:12px;border:1px solid var(--line);border-radius:8px}
    .alert-evidence-state.error{color:var(--danger,#b42318)}
    .alert-evidence-state .btn{display:block;margin-top:10px}
  `;

export const OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT = `
      let alertEvidenceRequestRevision=0;
      function queueAlertEvidenceHash(raw){
        const params=new URLSearchParams(String(raw||''));
        state.pendingAlertDetail=params.get('alert')||null;
        const at=params.get('at');
        // Keep the original locator for the API's strict ISO/calendar validation. Date.parse alone normalizes February 30.
        state.pendingAlertEvidenceAt=at;
      }
      function invalidateAlertEvidence(){alertEvidenceRequestRevision++}
      function alertEvidenceIdentityContext(){
        const me=typeof obsAuthState==='object'&&obsAuthState?obsAuthState.me:null;
        return JSON.stringify([
          me&&me.user&&me.user.id,Boolean(me&&me.admin),
          typeof opsSsoActiveTenant==='undefined'?null:opsSsoActiveTenant,
          typeof obsActiveTenant==='function'?obsActiveTenant():null,
          typeof opsAdminToken==='undefined'?null:opsAdminToken,
          typeof opsTenantToken==='undefined'?null:opsTenantToken,
          typeof opsMemberMode==='undefined'?false:Boolean(opsMemberMode),
          typeof adminTenantQuery==='function'?adminTenantQuery():''
        ]);
      }
      function alertEvidenceCanOpenEvent(){
        return !(typeof adminTenantQuery==='function'&&adminTenantQuery())&&
          !(typeof opsMemberMode!=='undefined'&&opsMemberMode)&&
          !(typeof opsTenantMode!=='undefined'&&opsTenantMode)&&
          !(typeof opsTenantToken!=='undefined'&&opsTenantToken);
      }
      function renderInvalidAlertEvidenceTime(root){
        root.replaceChildren();add(root,'h3','','本次告警证据');
        const invalid=add(root,'div','alert-evidence-state error','链接中的告警发生时间无效，请从告警卡片重新进入。');
        invalid.setAttribute('role','alert');
      }
      function alertEvidenceField(value){return value===null||value===undefined||String(value).trim()===''?'未上报':String(value)}
      function alertEvidenceClient(value){
        const names={desktop:'桌面客户端','web-cloud':'网页云端','web-self-host':'自部署网页','local-dev':'本地开发',web:'本地网页',miniapp:'小程序',cli:'命令行'};
        return names[value]||alertEvidenceField(value);
      }
      function alertEvidenceTable(parent,groups){
        const wrap=add(parent,'div','alert-evidence-table-wrap');
        const table=add(wrap,'table','alert-evidence-table');
        add(table,'caption','sr-only','账号、版本、客户端与功能模块的失败分布');
        const header=add(add(table,'thead'),'tr');
        ['SSO 账号','版本','客户端','功能模块','失败次数','独立 Run'].forEach(label=>add(header,'th','',label).setAttribute('scope','col'));
        const body=add(table,'tbody');
        groups.forEach(group=>{
          const row=add(body,'tr');
          [alertEvidenceField(group.accountId),alertEvidenceField(group.appVersion),alertEvidenceClient(group.clientType),alertEvidenceField(group.module),String(group.failureCount??'—'),String(group.runCount??'—')].forEach(value=>add(row,'td','',value));
        });
      }
      function renderAlertEvidence(root,payload,at){
        root.replaceChildren();
        add(root,'h3','',at?'本次告警证据':'最近告警证据');
        const evidence=payload.evidence;
        if(!evidence){
          const empty=add(root,'div','alert-evidence-state');empty.setAttribute('role','status');
          add(empty,'p','',at?'此告警发生时没有保存可用的历史证据快照。早期告警无法还原账号、版本与功能模块，请查看已有事件或告警历史。':'暂无已保存的告警证据快照；等待下一次告警评估采集。');
          return false;
        }
        if(payload.occurredAt)add(root,'p','alert-evidence-note','告警发生时间：'+when(payload.occurredAt));
        if(evidence.source==='historical-reconstruction')add(root,'p','alert-evidence-note','根据原始失败记录回溯生成，保存时间：'+(evidence.capturedAt?when(evidence.capturedAt):'未记录')+'。');
        add(root,'p','alert-evidence-note','发生时窗口：'+when(evidence.windowStart)+' → '+when(evidence.windowEnd)+'。此处保留发生时证据；上方状态是当前评估，告警恢复后仍可查看。');
        if(evidence.applicability==='infrastructure'){
          add(root,'p','alert-evidence-note','此为基础设施告警，SSO 账号、版本、客户端与用户功能模块维度不适用。');
          return true;
        }
        const groups=Array.isArray(evidence.groups)?evidence.groups:[];
        const samples=Array.isArray(evidence.samples)?evidence.samples:[];
        add(root,'div','alert-evidence-counts',String(evidence.eventCount??'—')+' 条失败记录 · '+String(evidence.runCount??'—')+' 个独立 Run · '+String(evidence.totalGroups??groups.length)+' 组账号 / 版本 / 客户端 / 模块组合');
        if(groups.length)alertEvidenceTable(root,groups);
        else add(root,'p','alert-evidence-note','此窗口没有可展示的账号与客户端分组。');
        if(Number(evidence.totalGroups)>groups.length)add(root,'p','alert-evidence-note','分组展示 '+groups.length+' 组，共 '+evidence.totalGroups+' 组；仅展示主要分组，其余分组未展开。');
        add(root,'h4','','失败事件样本');
        add(root,'p','alert-evidence-note','样本展示 '+samples.length+' 条，共 '+String(evidence.eventCount??'—')+' 条失败记录；样本用于定位，可能未包含全部事件。未上报表示该事件未携带对应字段。');
        const list=add(root,'div','alert-evidence-samples');
        samples.forEach(sample=>{
          const item=add(list,'article','alert-evidence-sample');
          add(item,'strong','',when(sample.occurredAt));
          add(item,'p','','SSO 账号：'+alertEvidenceField(sample.accountId)+' · 版本：'+alertEvidenceField(sample.appVersion)+' · 客户端：'+alertEvidenceClient(sample.clientType));
          add(item,'p','','功能模块：'+alertEvidenceField(sample.module)+' · 工具：'+alertEvidenceField(sample.toolName));
          add(item,'p','','失败分类：'+alertEvidenceField(sample.failureCategory));
          add(item,'p','','失败详情：'+alertEvidenceField(sample.failureDetail));
          if(sample.eventId&&alertEvidenceCanOpenEvent()){
            const open=add(item,'button','btn','查看事件详情');open.type='button';
            open.addEventListener('click',()=>{
              closeAlertDetail();
              openOpsEventDetail({id:sample.eventId,occurredAt:sample.occurredAt,component:sample.module||'告警证据',eventCode:sample.toolName||sample.failureCategory||'failure',summary:sample.failureDetail||'',outcome:'failure',metadata:{tool_name:sample.toolName,failure_category:sample.failureCategory}});
            });
          }else if(sample.eventId){
            add(item,'p','alert-evidence-note','当前租户可见的样本证据已展示；事件详情下钻仅在平台视图提供。');
          }
        });
        return true;
      }
      function mountAlertEvidence(body,def,at){
        const root=add(body,'section','alert-evidence');root.setAttribute('aria-live','polite');
        if(at!==null&&at!==undefined&&!Number.isFinite(Date.parse(at))){
          renderInvalidAlertEvidenceTime(root);return;
        }
        const scope=alertEvidenceIdentityContext();
        const shell=document.getElementById('alertDetailDrawer');
        const revision=++alertEvidenceRequestRevision;
        const current=()=>revision===alertEvidenceRequestRevision&&scope===alertEvidenceIdentityContext()&&root.isConnected&&shell&&shell.classList.contains('open');
        const retry=()=>{const button=add(root,'button','btn','重试读取');button.type='button';button.addEventListener('click',load)};
        const load=async()=>{
          if(!root.isConnected)return;
          root.replaceChildren();root.setAttribute('aria-busy','true');
          add(root,'h3','',at?'本次告警证据':'最近告警证据');
          const loading=add(root,'div','alert-evidence-state','正在读取告警发生时的证据…');loading.setAttribute('role','status');
          try{
            const tenantQuery=adminTenantQuery();
            const query=at?'?at='+encodeURIComponent(at)+tenantQuery:tenantQuery.replace(/^&/,'?');
            const result=await request('/api/ops/observability/alerts/'+encodeURIComponent(def.key)+'/evidence'+query);
            if(!current())return;
            if(!renderAlertEvidence(root,result,at))retry();
          }catch(error){
            if(!current())return;
            if(error&&error.message==='invalid_alert_evidence_time'){
              renderInvalidAlertEvidenceTime(root);
            }else if(error&&error.message==='alert_evidence_not_found'){
              renderAlertEvidence(root,{evidence:null},at);retry();
            }else{
              root.replaceChildren();add(root,'h3','',at?'本次告警证据':'最近告警证据');
              const failed=add(root,'div','alert-evidence-state error');failed.setAttribute('role','alert');
              add(failed,'strong','','告警证据加载失败');
              add(failed,'p','','暂时无法读取发生时证据，请重试。');
              retry();
            }
          }finally{if(current())root.setAttribute('aria-busy','false')}
        };
        load();
      }
  `;
