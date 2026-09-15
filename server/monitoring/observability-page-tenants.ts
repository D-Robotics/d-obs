/**
 * 管理员租户管理面板（“系统配置”组，view-tenants）。
 *
 * 后端租户 API（列表/创建/轮换 token/停启用）早已存在但只能 curl；此面板
 * 把它们接进工作台。只读渲染走安全 DOM API；创建/轮换/停启用的响应由
 * 后端审计记录，页面不做额外授权判断（requireObservabilityAccess 兜底）。
 *
 * token 明文只在创建/轮换成功后的结果框展示一次，并附复制按钮；不在
 * 列表里回显，避免被肩窥或截屏泄漏。
 */
export const OPS_OBSERVABILITY_TENANTS_STYLE = `
    .tenant-toolbar{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    .tenant-toolbar .field{margin:0}
    .tenant-toolbar .field input{width:200px}
    .tenant-grid{display:grid;gap:1px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--line)}
    .tenant-row{display:grid;grid-template-columns:minmax(140px,1.2fr) minmax(110px,.9fr) minmax(90px,.7fr) minmax(120px,.9fr) auto;align-items:center;gap:8px;padding:10px 14px;background:var(--panel)}
    .tenant-row.head{font-size:10px;font-weight:650;color:var(--muted);background:var(--panel2)}
    .tenant-row .tenant-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tenant-row .tenant-status{font-size:11px}
    .tenant-row .tenant-status .state-dot{margin-right:5px}
    .tenant-row .tenant-last{font-size:11px;color:var(--muted)}
    .tenant-row .tenant-actions{display:flex;gap:6px;justify-self:end}
    .tenant-token-result{margin-top:10px;padding:12px 14px;border:1px dashed var(--line2);border-radius:8px;background:#fffdf3}
    .tenant-token-result strong{display:block;font-size:12px;color:#8a6100;margin-bottom:6px}
    .tenant-token-result code{display:block;padding:8px 10px;border-radius:6px;background:#f6f7f5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:#39443f}
    .tenant-token-result .btn{margin-top:8px}
    .tenant-empty{padding:26px 20px;border:1px dashed var(--line2);border-radius:8px;color:var(--muted);font-size:12px;text-align:center}
    @media(max-width:720px){.tenant-row{grid-template-columns:1fr 1fr}.tenant-row.head{display:none}.tenant-row .tenant-actions{grid-column:1/-1;justify-self:stretch;flex-wrap:wrap}}
`;

export const OPS_OBSERVABILITY_SCRIPT_TENANTS = `
      let tenantsState={list:null,error:null,tokenResult:null};
      function whenShort(value){if(!value)return '—';const t=Date.parse(value);if(!Number.isFinite(t))return String(value);const diff=Date.now()-t;const minutes=Math.floor(diff/60000);if(minutes<1)return '刚刚';if(minutes<60)return minutes+' 分钟前';const hours=Math.floor(minutes/60);if(hours<24)return hours+' 小时前';const days=Math.floor(hours/24);if(days<30)return days+' 天前';return when(value)}
      function renderTenantList(){
        const root=$('tenantsContent');
        if(!root)return;
        root.replaceChildren();
        if(tenantsState.error){root.appendChild(make('div','empty','租户列表加载失败：'+friendlyError(tenantsState.error)+'。'));return}
        const list=Array.isArray(tenantsState.list)?tenantsState.list:null;
        if(list===null){root.appendChild(make('div','empty','正在加载租户列表…'));return}
        if(tenantsState.tokenResult){
          const box=make('div','tenant-token-result');
          add(box,'strong','',tenantsState.tokenResult.label);
          const code=make('code','',tenantsState.tokenResult.token);
          box.appendChild(code);
          const copy=add(box,'button','btn','复制 token');
          copy.type='button';
          copy.addEventListener('click',async()=>{
            try{await navigator.clipboard.writeText(tenantsState.tokenResult.token);toast('探针 token 已复制')}catch{toast('复制失败，请手动复制',false)}
          });
          add(box,'div','hint','系统仅保存 token 摘要，本页关闭后无法再次查看；请立即保存至接入方的凭据存储。');
          root.appendChild(box);
        }
        if(!list.length){root.appendChild(make('div','tenant-empty','暂无租户。新团队接入时，可通过上方表单创建租户并签发探针 token。'));return}
        const grid=make('div','tenant-grid');
        const head=make('div','tenant-row head');
        ['租户','名称','状态','最近上报','操作'].forEach(label=>add(head,'div','',label));
        grid.appendChild(head);
        list.forEach(item=>{
          const row=make('div','tenant-row');
          add(row,'div','tenant-id',item.tenantId);
          add(row,'div','tenant-last',item.displayName||'—');
          const status=make('div','tenant-status');
          const dot=make('span','state-dot '+(item.status==='disabled'?'critical':'healthy'));
          status.appendChild(dot);
          status.appendChild(document.createTextNode(item.status==='disabled'?'已停用':'启用'));
          row.appendChild(status);
          add(row,'div','tenant-last',whenShort(item.lastReportAt));
          const actions=make('div','tenant-actions');
          const rotate=add(actions,'button','btn','轮换 token');
          rotate.type='button';
          rotate.title='旧 token 立即失效并签发新 token；接入方需同步更新';
          rotate.addEventListener('click',()=>rotateTenantToken(item.tenantId,rotate));
          const statusToggle=add(actions,'button','btn',item.status==='disabled'?'启用':'停用');
          statusToggle.type='button';
          statusToggle.title=item.status==='disabled'?'恢复该团队的拨测上报':'暂停该团队的拨测上报与只读视图';
          statusToggle.addEventListener('click',()=>setTenantStatus(item.tenantId,item.status==='disabled'?'active':'disabled',statusToggle));
          row.appendChild(actions);
          grid.appendChild(row);
        });
        root.appendChild(grid);
      }
      async function loadTenants(){
        const root=$('tenantsContent');
        if(!root)return;
        try{
          const data=await request('/api/ops/observability/tenants');
          tenantsState.list=data.tenants||[];
          tenantsState.error=null;
        }catch(error){
          tenantsState.error=error.message;
        }
        renderTenantList();
      }
      async function createTenantSubmit(){
        const idInput=$('newTenantId');
        const nameInput=$('newTenantName');
        const button=$('createTenantBtn');
        const id=(idInput&&idInput.value||'').trim();
        const name=(nameInput&&nameInput.value||'').trim();
        if(!id){toast('请输入租户 ID：小写字母开头，2–40 字符',false);if(idInput)idInput.focus();return}
        if(!button)return;
        button.disabled=true;button.textContent='创建中…';
        try{
          const data=await request('/api/ops/observability/tenants',{method:'POST',body:JSON.stringify({tenantId:id,displayName:name||id})});
          tenantsState.tokenResult={label:'租户 '+data.tenant.tenantId+' 的探针 token（仅显示一次）',token:data.probeToken};
          if(idInput)idInput.value='';
          if(nameInput)nameInput.value='';
          await loadTenants();
          toast('租户 '+data.tenant.tenantId+' 已创建，探针 token 已生成');
        }catch(error){
          toast('创建租户失败：'+friendlyError(error.message),false);
        }finally{
          button.disabled=false;button.textContent='创建租户';
        }
      }
      async function rotateTenantToken(tenantId,button){
        if(!confirm('轮换租户 '+tenantId+' 的探针 token？旧 token 将立即失效；接入方完成更新前，其拨测上报将无法通过鉴权。'))return;
        button.disabled=true;
        try{
          const data=await request('/api/ops/observability/tenants/'+encodeURIComponent(tenantId)+'/token',{method:'POST',body:'{}'});
          tenantsState.tokenResult={label:'租户 '+tenantId+' 的新 token（仅显示一次）',token:data.probeToken};
          renderTenantList();
          toast('租户 '+tenantId+' 的探针 token 已轮换');
        }catch(error){
          toast('轮换失败：'+friendlyError(error.message),false);
          button.disabled=false;
        }
      }
      async function setTenantStatus(tenantId,status,button){
        const verb=status==='disabled'?'停用':'启用';
        if(!confirm(verb+'租户 '+tenantId+'？'+(status==='disabled'?'该团队的拨测上报将被拒绝，只读视图同步失效。':'该团队的拨测上报与只读视图将恢复。')))return;
        button.disabled=true;
        try{
          await request('/api/ops/observability/tenants/'+encodeURIComponent(tenantId)+'/status',{method:'POST',body:JSON.stringify({status})});
          await loadTenants();
          toast('租户 '+tenantId+' 已'+verb);
        }catch(error){
          toast(verb+'失败：'+friendlyError(error.message),false);
          button.disabled=false;
        }
      }
      function bindTenantPanel(){
        const create=$('createTenantBtn');
        if(create&&!create.dataset.bound){
          create.dataset.bound='1';
          create.addEventListener('click',createTenantSubmit);
        }
        const idInput=$('newTenantId');
        if(idInput&&!idInput.dataset.bound){
          idInput.dataset.bound='1';
          idInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();createTenantSubmit()}});
        }
        const nameInput=$('newTenantName');
        if(nameInput&&!nameInput.dataset.bound){
          nameInput.dataset.bound='1';
          nameInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();createTenantSubmit()}});
        }
      }
`;
