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
    .tenant-row.head{font-size:11px;font-weight:650;color:var(--muted);background:var(--panel2)}
    .tenant-row .tenant-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tenant-row .tenant-status{font-size:12px}
    .tenant-row .tenant-status .state-dot{margin-right:5px}
    .tenant-row .tenant-last{font-size:12px;color:var(--muted)}
    .tenant-row .tenant-actions{display:flex;gap:6px;justify-self:end}
    .tenant-token-result{margin-top:10px;padding:12px 14px;border:1px dashed var(--line2);border-radius:8px;background:#fffdf3}
    .tenant-token-result strong{display:block;font-size:12px;color:#8a6100;margin-bottom:6px}
    .tenant-token-result code{display:block;padding:8px 10px;border-radius:6px;background:#f6f7f5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;color:#39443f}
    .tenant-token-result .btn{margin-top:8px}
    .tenant-empty{padding:26px 20px;border:1px dashed var(--line2);border-radius:8px;color:var(--muted);font-size:12px;text-align:center}
    .member-toolbar{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    .member-toolbar .field{margin:0}
    .member-toolbar .field input{width:180px}
    .member-grid{display:grid;gap:1px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--line);margin-top:8px}
    .member-row{display:grid;grid-template-columns:minmax(140px,1.4fr) minmax(100px,1fr) minmax(80px,.6fr) minmax(90px,.8fr) auto;align-items:center;gap:8px;padding:10px 14px;background:var(--panel)}
    .member-row.head{font-size:11px;font-weight:650;color:var(--muted);background:var(--panel2)}
    .member-row .member-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .member-row .member-role{font-size:11px}
    .member-row .member-actions{display:flex;gap:6px;justify-self:end}
    .role-chip{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:650}
    .role-chip.owner{background:#e8f0fe;color:#1a56db}
    .role-chip.member{background:#f1f5f4;color:#4b5b57}
    .obs-account-bar{display:flex;align-items:center;gap:10px;margin-left:auto}
    .obs-user-chip{font-size:12px;color:var(--text);border:1px solid var(--line);border-radius:999px;padding:4px 12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .obs-tenant-select{font-size:12px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);max-width:200px}
    .obs-logout-btn{font-size:12px;padding:4px 12px}
    @media(max-width:720px){.tenant-toolbar .field{flex:1 1 100%}.tenant-toolbar .field input{width:100%}.member-toolbar{display:grid;grid-template-columns:1fr 1fr;align-items:end;gap:8px}.member-toolbar .field{margin:0}.member-toolbar .field input,.member-toolbar .field select{width:100%}.tenant-row{grid-template-columns:1fr 1fr}.tenant-row.head{display:none}.tenant-row .tenant-actions{grid-column:1/-1;justify-self:stretch;flex-wrap:wrap}.member-row{grid-template-columns:1fr 1fr}.member-row.head{display:none}.member-row .member-actions{grid-column:1/-1;justify-self:stretch;flex-wrap:wrap}.tenant-row [data-label]::before,.member-row [data-label]::before{content:attr(data-label);margin-right:4px;color:var(--muted);font-size:10px}.obs-account-bar{flex-wrap:wrap}}
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
          add(row,'div','tenant-id',item.tenantId).dataset.label='租户';
          add(row,'div','tenant-last',item.displayName||'—').dataset.label='名称';
          const status=make('div','tenant-status');
          status.dataset.label='状态';
          const dot=make('span','state-dot '+(item.status==='disabled'?'critical':'healthy'));
          status.appendChild(dot);
          status.appendChild(document.createTextNode(item.status==='disabled'?'已停用':'启用'));
          row.appendChild(status);
          add(row,'div','tenant-last',whenShort(item.lastReportAt)).dataset.label='最近上报';
          const actions=make('div','tenant-actions');
          const members=add(actions,'button','btn','组员 '+(item.memberCount!=null?'('+item.memberCount+')':''));
          members.type='button';
          members.title='查看与管理本租户组员（owner/member）';
          members.addEventListener('click',()=>openAdminMembersEditor(item.tenantId,members));
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
      // 显示名称是 ASCII 时顺手把 ID 填好（用户一旦手动改过 ID 就不再覆盖）。
      function bindTenantIdSuggestion(){
        const nameInput=$('newTenantName');const idInput=$('newTenantId');
        if(!nameInput||!idInput||nameInput.dataset.idSuggestBound)return;
        nameInput.dataset.idSuggestBound='1';
        idInput.addEventListener('input',()=>{idInput.dataset.userEdited='1'});
        nameInput.addEventListener('input',()=>{
          if(idInput.dataset.userEdited)return;
          const suggestion=tenantIdSuggestion(nameInput.value);
          idInput.value=suggestion;
        });
      }
      async function createTenantSubmit(){
        const idInput=$('newTenantId');
        const nameInput=$('newTenantName');
        const button=$('createTenantBtn');
        const id=(idInput&&idInput.value||'').trim();
        const name=(nameInput&&nameInput.value||'').trim();
        if(!id){toast('请输入租户 ID（小写 ASCII 字母开头，2–40 字符）',false);if(idInput)idInput.focus();return}
        // 就地校验并给出可用的整理结果：服务端只接受 /^[a-z][a-z0-9-]{1,39}$/，
        // 直接抛「不符合规范」对用户没有指导意义，这里把原因与建议一起给出。
        if(!/^[a-z][a-z0-9-]{1,39}$/.test(id)){
          const suggestion=tenantIdSuggestion(id);
          toast('租户 ID 只能用小写 ASCII（它要拼进告警键 t.<ID>.<检查项>，并出现在 URL/请求头里）'+(suggestion?('；按规则可写作 '+suggestion):'；中文请填到「显示名称」'),false);
          if(idInput)idInput.focus();
          return;
        }
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
        bindTenantIdSuggestion();
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
      // 管理员行内组员管理：复用组员面板渲染，挂到一个 dialog 容器。
      function openAdminMembersEditor(tenantId,button){
        const existed=document.getElementById('obsMembersDialog');
        if(existed){existed.remove()}
        const dialog=make('details','detail-sections obs-members-dialog');dialog.id='obsMembersDialog';dialog.open=true;dialog.style.margin='10px 0';
        const summary=make('summary','detail-summary');
        add(summary,'strong','','租户 '+tenantId+' 的组员管理');
        const closeChip=make('span','','');closeChip.textContent='收起';summary.appendChild(closeChip);
        dialog.appendChild(summary);
        const content=make('div');content.id='tenantMembersContent';
        dialog.appendChild(content);
        const toolbar=make('div','member-toolbar');
        const idField=make('label','field');idField.textContent='账号 ID';
        const idInput=make('input');idInput.id='newMemberId';idInput.type='text';idInput.autocomplete='off';idInput.spellcheck=false;idInput.placeholder='主站账号 ID';idField.appendChild(idInput);
        toolbar.appendChild(idField);
        const nameField=make('label','field');nameField.textContent='显示名';
        const nameInput=make('input');nameInput.id='newMemberName';nameInput.type='text';nameInput.autocomplete='off';nameInput.placeholder='可留空';nameField.appendChild(nameInput);
        toolbar.appendChild(nameField);
        const roleField=make('label','field');roleField.textContent='角色';
        const roleSelect=make('select');roleSelect.id='newMemberRole';
        [['member','member（只读）'],['owner','owner（可管理）']].forEach(optionData=>{const option=make('option','',optionData[1]);option.value=optionData[0];roleSelect.appendChild(option)});
        roleField.appendChild(roleSelect);
        toolbar.appendChild(roleField);
        const button2=make('button','btn primary');button2.id='addMemberBtn';button2.type='button';button2.textContent='添加组员';
        toolbar.appendChild(button2);
        dialog.appendChild(toolbar);
        if(button&&button.parentElement){const host=button.closest('.tenant-grid');(host&&host.parentElement||$('tenantsContent')).insertBefore(dialog,host)}
        // admin 模式下 loadTenantMembers 读 window.obsAdminMembersTenant。
        window.obsAdminMembersTenant=tenantId;
        bindTenantMembersPanel();
        loadTenantMembers();
      }
      // ---- 租户组员管理（admin 面板行内 + SSO owner/member 模式专用面板） ----
      let membersState={tenantId:null,list:null,error:null};
      function memberRoleChip(role){return make('span','role-chip '+role,role==='owner'?'owner':'member')}
      function renderMemberList(){
        const root=$('tenantMembersContent');
        if(!root)return;
        root.replaceChildren();
        if(membersState.error){root.appendChild(make('div','empty','组员列表加载失败：'+friendlyError(membersState.error)+'。'));return}
        const list=Array.isArray(membersState.list)?membersState.list:null;
        if(list===null){root.appendChild(make('div','empty','正在加载组员…'));return}
        if(!list.length){root.appendChild(make('div','tenant-empty','本租户暂无组员。owner 可通过上方表单添加组员。'));return}
        const me=obsAuthState.me||{};
        const selfId=me&&me.user?me.user.id:'';
        // 可管理 = SSO allowlist 管理员 / 本租户 owner / 运营令牌直连（服务端
        // resolveTenantMutationActor 对 admin token 同样放行，权限矩阵也是这么写的）。
        // 令牌直连时 /auth/me 返回 user:null，me.admin 为 false，早先会因此漏掉按钮。
        const canManage=Boolean(me.admin||opsAdminToken||(me.tenants||[]).some(item=>item.tenantId===membersState.tenantId&&item.role==='owner'));
        const grid=make('div','member-grid');
        const head=make('div','member-row head');
        ['账号 ID','显示名','角色','加入时间','操作'].forEach(label=>add(head,'div','',label));
        grid.appendChild(head);
        list.forEach(item=>{
          const row=make('div','member-row');
          const idCell=make('div','member-id',item.ssoUserId);
          idCell.dataset.label='账号';
          if(item.ssoUserId===selfId)add(idCell,'span','member-role','（你）');
          row.appendChild(idCell);
          add(row,'div','',item.displayName||'—').dataset.label='显示名';
          const roleCell=memberRoleChip(item.role);
          roleCell.dataset.label='角色';
          row.appendChild(roleCell);
          add(row,'div','tenant-last',whenShort(item.createdAt)).dataset.label='加入';
          const actions=make('div','member-actions');
          if(canManage){
            const roleToggle=add(actions,'button','btn',item.role==='owner'?'降为 member':'升为 owner');
            roleToggle.type='button';
            roleToggle.title=item.role==='owner'?'移除管理权（最后一个 owner 不可降级）':'授予组员管理权';
            roleToggle.addEventListener('click',()=>setTenantMemberRole(item.ssoUserId,item.role==='owner'?'member':'owner',roleToggle));
            const remove=add(actions,'button','btn','移除');
            remove.type='button';
            remove.title='把该账号移出本租户（最后一个 owner 不可移除）';
            remove.addEventListener('click',()=>removeTenantMember(item.ssoUserId,remove));
          }
          row.appendChild(actions);
          grid.appendChild(row);
        });
        root.appendChild(grid);
      }
      async function loadTenantMembers(){
        const root=$('tenantMembersContent');
        if(!root)return;
        const tenantId=opsMemberMode?opsSsoActiveTenant:(window.obsAdminMembersTenant||'');
        if(!tenantId)return;
        membersState.tenantId=tenantId;
        try{
          const data=await request('/api/ops/observability/tenants/'+encodeURIComponent(tenantId)+'/members');
          membersState.list=data.members||[];
          membersState.error=null;
        }catch(error){
          membersState.error=error.message;
        }
        renderMemberList();
      }
      async function addTenantMemberSubmit(){
        const idInput=$('newMemberId');
        const nameInput=$('newMemberName');
        const roleInput=$('newMemberRole');
        const button=$('addMemberBtn');
        const tenantId=opsMemberMode?opsSsoActiveTenant:(window.obsAdminMembersTenant||'');
        const id=(idInput&&idInput.value||'').trim();
        if(!tenantId){toast('请先选择租户',false);return}
        if(!id){toast('请输入账号 ID',false);if(idInput)idInput.focus();return}
        if(!button)return;
        button.disabled=true;button.textContent='添加中…';
        try{
          await request('/api/ops/observability/tenants/'+encodeURIComponent(tenantId)+'/members',{method:'POST',body:JSON.stringify({ssoUserId:id,displayName:(nameInput&&nameInput.value||'').trim(),role:(roleInput&&roleInput.value)||'member'})});
          if(idInput)idInput.value='';
          if(nameInput)nameInput.value='';
          await loadTenantMembers();
          toast('组员 '+id+' 已加入租户 '+tenantId);
        }catch(error){
          toast('添加组员失败：'+friendlyError(error.message),false);
        }finally{
          button.disabled=false;button.textContent='添加组员';
        }
      }
      async function setTenantMemberRole(ssoUserId,role,button){
        if(!confirm('把组员 '+ssoUserId+' 的角色改为 '+role+'？'))return;
        button.disabled=true;
        try{
          await request('/api/ops/observability/tenants/'+encodeURIComponent(membersState.tenantId)+'/members/'+encodeURIComponent(ssoUserId)+'/role',{method:'POST',body:JSON.stringify({role})});
          await loadTenantMembers();
          toast('组员 '+ssoUserId+' 角色已改为 '+role);
        }catch(error){
          toast('修改角色失败：'+friendlyError(error.message),false);
          button.disabled=false;
        }
      }
      async function removeTenantMember(ssoUserId,button){
        if(!confirm('把组员 '+ssoUserId+' 移出租户 '+membersState.tenantId+'？该账号将立即失去本租户视图。'))return;
        button.disabled=true;
        try{
          await request('/api/ops/observability/tenants/'+encodeURIComponent(membersState.tenantId)+'/members/'+encodeURIComponent(ssoUserId),{method:'DELETE'});
          await loadTenantMembers();
          toast('组员 '+ssoUserId+' 已移除');
        }catch(error){
          toast('移除失败：'+friendlyError(error.message),false);
          button.disabled=false;
        }
      }
      function bindTenantMembersPanel(){
        const add=$('addMemberBtn');
        if(add&&!add.dataset.bound){
          add.dataset.bound='1';
          add.addEventListener('click',addTenantMemberSubmit);
        }
        const idInput=$('newMemberId');
        if(idInput&&!idInput.dataset.bound){
          idInput.dataset.bound='1';
          idInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addTenantMemberSubmit()}});
        }
      }
      // SSO 组员模式进入租户视图：渲染本租户组员面板（owner 可管理）。
      // 本租户 owner 轮换探针 token：新 token 只显示一次（库里只有哈希）。
      let obsMemberToken='';
      function renderObsMemberTokenResult(){
        const box=make('div','tenant-token-result');
        add(box,'strong','','新探针 token（仅显示一次）');
        const code=make('code','',obsMemberToken);
        box.appendChild(code);
        const copy=add(box,'button','btn','复制 token');
        copy.type='button';
        copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(obsMemberToken);toast('探针 token 已复制')}catch{toast('复制失败，请手动复制',false)}});
        add(box,'div','hint','系统仅保存 token 摘要，本页刷新后无法再次查看；请立即保存并更新接入方的凭据文件。');
        return box;
      }
      async function rotateOwnTenantToken(button){
        const tenantId=opsSsoActiveTenant;
        if(!tenantId){toast('请先选择租户',false);return}
        if(!confirm('轮换租户 '+tenantId+' 的探针 token？旧 token 将立即失效；接入方完成更新前，其拨测上报将无法通过鉴权。'))return;
        button.disabled=true;
        try{
          const data=await request('/api/ops/observability/tenants/'+encodeURIComponent(tenantId)+'/token',{method:'POST',body:'{}'});
          obsMemberToken=String(data.probeToken||'');
          if(typeof renderObsMemberTenantsView==='function')renderObsMemberTenantsView();
          toast('探针 token 已轮换，请立即保存');
        }catch(error){
          toast('轮换失败：'+friendlyError(error.message),false);
          button.disabled=false;
        }
      }
      function renderObsMemberTenantsView(){
        const section=$('view-tenants');
        if(!section)return;
        const me=obsAuthState.me||{};
        const isOwner=(me.tenants||[]).some(item=>item.tenantId===opsSsoActiveTenant&&item.role==='owner');
        const membership=(me.tenants||[]).find(item=>item.tenantId===opsSsoActiveTenant);
        section.replaceChildren();
        const head=make('div','view-head');
        const copy=make('div');
        add(copy,'div','eyebrow','可观测中心 / 租户');
        add(copy,'h2','','租户 '+opsSsoActiveTenant+(isOwner?' · 组员管理':' · 组员名单'));
        add(copy,'p','',isOwner?'管理本租户的组员、角色与探针 token。':'查看本租户的组员名单；组员变更请联系本租户 owner 或平台管理员。');
        head.appendChild(copy);
        add(head,'div','right',membership?('你的角色：'+membership.role):'');
        section.appendChild(head);
        if(isOwner){
          const manage=make('details','detail-sections');manage.open=true;
          const summary=make('summary','detail-summary');
          add(summary,'strong','','添加组员');
          add(summary,'span','','用主站账号 ID 邀请（成员需先把账号 ID 发给你）');
          manage.appendChild(summary);
          const toolbar=make('div','member-toolbar');
          const idField=make('label','field');idField.textContent='账号 ID';
          const idInput=make('input');idInput.id='newMemberId';idInput.type='text';idInput.autocomplete='off';idInput.spellcheck=false;idInput.placeholder='主站账号 ID';idField.appendChild(idInput);
          toolbar.appendChild(idField);
          const nameField=make('label','field');nameField.textContent='显示名';
          const nameInput=make('input');nameInput.id='newMemberName';nameInput.type='text';nameInput.autocomplete='off';nameInput.placeholder='可留空';nameField.appendChild(nameInput);
          toolbar.appendChild(nameField);
          const roleField=make('label','field');roleField.textContent='角色';
          const roleSelect=make('select');roleSelect.id='newMemberRole';
          [['member','member（只读）'],['owner','owner（可管理）']].forEach(optionData=>{const option=make('option','',optionData[1]);option.value=optionData[0];roleSelect.appendChild(option)});
          roleField.appendChild(roleSelect);
          toolbar.appendChild(roleField);
          const button=make('button','btn primary');button.id='addMemberBtn';button.type='button';button.textContent='添加组员';
          toolbar.appendChild(button);
          manage.appendChild(toolbar);
          section.appendChild(manage);
          // 探针 token 轮换：服务端对「本租户 owner」开放（与权限矩阵一致），
          // 这里给出入口，避免 owner 被引导去找平台管理员。
          const tokenPanel=make('details','detail-sections');
          const tokenSummary=make('summary','detail-summary');
          add(tokenSummary,'strong','','探针 token');
          add(tokenSummary,'span','','轮换后旧 token 立即失效，需同步更新接入方配置');
          tokenPanel.appendChild(tokenSummary);
          const tokenBody=make('div');
          const rotate=add(tokenBody,'button','btn','轮换本租户探针 token');
          rotate.type='button';
          rotate.addEventListener('click',()=>rotateOwnTenantToken(rotate));
          tokenPanel.appendChild(tokenBody);
          if(obsMemberToken){
            tokenPanel.appendChild(renderObsMemberTokenResult());
          }
          section.appendChild(tokenPanel);
        }
        const list=make('details','detail-sections');list.open=true;
        const listSummary=make('summary','detail-summary');
        add(listSummary,'strong','','组员名单');
        add(listSummary,'span','',isOwner?'账号、角色与移出操作':'账号与角色（只读）');
        list.appendChild(listSummary);
        const content=make('div');content.id='tenantMembersContent';
        list.appendChild(content);
        section.appendChild(list);
        bindTenantMembersPanel();
        loadTenantMembers();
      }
`;
