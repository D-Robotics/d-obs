/** CPU model deployment workspace. Every state and metric comes from a protected API. */
export function renderEdgeLlmPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>端侧大模型 · d-obs</title>
<style>
:root{color-scheme:light dark;--bg:#f5f7fa;--paper:#fff;--ink:#182d3a;--muted:#627381;--line:#dce5ea;--accent:#08786d;--bad:#b33939}
@media(prefers-color-scheme:dark){:root{--bg:#111a21;--paper:#1a2730;--ink:#e8eef2;--muted:#a6b7c2;--line:#35454f;--accent:#70d6c4;--bad:#ffb0ac}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);background:var(--paper);padding:18px 28px}main{max-width:1150px;margin:auto;padding:30px 24px}h1,h2,p{margin:0}h1{font-size:28px}h2{font-size:17px;margin-bottom:14px}a{color:var(--accent)}.muted{color:var(--muted)}.intro{margin:9px 0 24px}.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:20px}.panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:20px;min-width:0}label{display:block;margin:16px 0 6px}select,button{font:inherit;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);padding:9px 12px}select{width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--accent);color:var(--paper);border-color:var(--accent)}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:19px}.status{padding:13px 16px;margin-bottom:20px;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap}.status.bad{color:var(--bad);border-color:var(--bad)}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}.fact{padding:12px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.fact small{display:block;color:var(--muted);margin-bottom:3px}.fact strong{font-size:17px}.job{width:100%;display:block;text-align:left;margin-bottom:9px;padding:13px;overflow-wrap:anywhere}.job[aria-pressed=true]{border-color:var(--accent)}.job small{display:block;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace;margin:14px 0 0}details{margin-top:16px}summary{cursor:pointer}.note{font-size:12px;color:var(--muted);margin-top:14px}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:760px){.grid{grid-template-columns:1fr}main{padding:22px 15px}header{padding:15px}}
</style></head><body><header><strong>d-obs · 端侧大模型</strong><a id="consoleLink">返回工作台</a></header><main>
<h1>在 RDK X5 上运行 Qwen</h1><p class="intro muted">选择模型，部署本地推理服务，再用同一组任务测量性能。当前后端为 CPU。</p>
<div id="notice" class="status" role="status" aria-live="polite">正在读取设备与模型目录…</div>
<div class="grid"><section><div class="panel"><h2>部署与验证</h2><label for="target">目标设备</label><select id="target" disabled></select><label for="model">模型</label><select id="model" disabled></select><div id="targetFacts" class="facts"></div>
<div class="actions"><button id="probe" disabled>检查环境</button><button id="deploy" class="primary" disabled>部署模型</button><button id="benchmark" disabled>性能实测</button><button id="stop" disabled>停止本模块服务</button></div>
<p class="note">性能实测包含预热与三条固定中文任务，记录首字延迟、生成速度和总耗时。准确率需另设数据集验收。</p>
<details><summary>接入说明</summary><p class="note">由管理员在 X5 上安装部署客户端、配置 llama.cpp 与经过哈希校验的 GGUF 模型，再将客户端接入平台。客户端未接通时无法部署；不会用示例设备冒充已连接。</p><p class="note">推理服务监听板端回环地址。通过受控隧道访问 OpenAI 兼容接口。部署与停止仅管理本模块启动的服务。</p></details>
</div><div class="panel"><h2>任务记录</h2><button id="refresh">刷新记录</button><div id="jobs" style="margin-top:14px"></div></div></section>
<section class="panel"><h2>执行回执</h2><div id="receipt" aria-live="polite"><p class="muted">选择一条任务查看进度、验证结果与性能数据。</p></div><div class="actions"><button id="query" disabled>查询任务状态</button><button id="report" disabled>下载报告</button></div></section></div>
</main><script>${EDGE_LLM_PAGE_SCRIPT}</script></body></html>`;
}

export const EDGE_LLM_PAGE_SCRIPT = String.raw`
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = location.pathname.replace(/\/ops-observability\/edge-llm\/?$/, '');
  const api = base + '/api/ops/observability/edge-llm';
  $('consoleLink').href = base + '/ops-observability';
  const operations = {probe:'环境检查',deploy:'模型部署',benchmark:'性能实测',stop:'停止服务'};
  const statuses = {submitting:'提交中',queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',unknown:'结果未知',superseded:'已结束，原结果未知'};
  const errors = {edge_llm_runtime_unavailable:'设备尚未安装可用的 llama.cpp 运行环境',edge_llm_unsupported_architecture:'部署目标需要 Linux ARM64 设备',edge_llm_board_mismatch:'检测到的板型与 X5 配置不一致',edge_llm_insufficient_disk:'设备存储空间不足',edge_llm_model_hash_mismatch:'模型文件校验失败，请核对模型来源与哈希',edge_llm_inference_port_in_use:'推理端口已被其他服务占用',edge_llm_runtime_start_timeout:'模型加载超时，请检查设备内存与运行日志',edge_llm_deployment_not_ready:'推理服务尚未就绪',edge_llm_inference_empty_output:'模型没有返回有效文本',edge_llm_transport_failed:'设备连接中断，请查询原任务状态',edge_llm_target_unavailable:'该设备尚未完成客户端接入',edge_llm_job_pending:'设备还有未确认的任务，请先查询或恢复设备状态',edge_llm_interrupted_by_restart:'客户端重启中断了任务，原执行结果尚未确认'};
  const errorText = value => errors[value] || String(value);
  let targets = [], models = [], jobs = [], selected = null, catalog = null;
  let epoch = 0, loadedIdentity = '', busy = false, blocked = false, readOnly = false, timer = 0, targetRevision = 0;
  const controllers = new Set();
  const stored = (kind,key) => { try { return kind.getItem(key) || ''; } catch { return ''; } };
  function headers(mutation) {
    const h = {};
    const admin = stored(sessionStorage,'d_obs_admin_token') || stored(localStorage,'d_obs_admin_token');
    const tenant = stored(sessionStorage,'d_obs_tenant_token');
    const session = stored(sessionStorage,'d_obs_sso_session') || stored(localStorage,'rdk_sso_session_mirror');
    if (admin) h['x-admin-token'] = admin;
    else if (tenant) { h['x-tenant-token'] = tenant; h['x-rdk-ops-read-only'] = '1'; }
    if (session) h['x-rdk-sso-session'] = session;
    const cloud = stored(localStorage,'rdk_sso_session_mirror_cloud');
    if (cloud) h['x-rdk-sso-session-cloud'] = cloud;
    const activeTenant = stored(sessionStorage,'d_obs_active_tenant');
    if (activeTenant && !admin && !tenant) h['x-rdk-obs-tenant'] = activeTenant;
    if (mutation) h['X-RDK-Ops-Action'] = 'observability';
    return h;
  }
  const identity = () => JSON.stringify(headers(false));
  const active = job => job && ['submitting','queued','running'].includes(job.status);
  function add(parent,tag,text,className) { const el=document.createElement(tag); el.textContent=text == null ? '' : String(text); if(className)el.className=className; parent.appendChild(el); return el; }
  function notice(text,bad=false) { $('notice').textContent=text; $('notice').className='status'+(bad?' bad':''); }
  function fact(parent,label,value,unit='') { const el=add(parent,'div','','fact'); add(el,'small',label); add(el,'strong',typeof value==='number' && Number.isFinite(value)?(Number.isInteger(value)&&!unit?String(value):value.toFixed(2))+unit:value == null?'未测得':String(value)); }
  function clear() {
    epoch++; targetRevision++; clearTimeout(timer); controllers.forEach(c=>c.abort()); controllers.clear();
    targets=[]; models=[]; jobs=[]; selected=null; catalog=null; busy=false; blocked=true;
    $('target').replaceChildren(); $('model').replaceChildren(); $('targetFacts').replaceChildren(); $('jobs').replaceChildren(); $('receipt').replaceChildren();
    controls();
  }
  async function request(path, options={}) {
    const context=identity(), generation=epoch;
    if (loadedIdentity && context!==loadedIdentity) { clear(); loadedIdentity=context; throw new Error('身份已改变，请刷新记录'); }
    const controller=new AbortController(); controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(api+path,{...options,credentials:'same-origin',signal:controller.signal,headers:{...headers(Boolean(options.method && options.method!=='GET')),...(options.body?{'content-type':'application/json'}:{})}});
      const data=await response.json();
      if (context!==identity()) { clear(); loadedIdentity=identity(); throw new Error('身份已改变，请刷新记录'); }
      if (generation!==epoch) throw new Error('identity_changed');
      if (!response.ok || data.ok===false) {
        if (response.status===401 || response.status===403) { clear(); notice('需要平台管理员权限，请返回工作台登录。',true); }
        throw new Error(errorText(data.error || 'HTTP '+response.status));
      }
      return data;
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  function controls() {
    $('target').disabled=busy || !targets.length || blocked;
    $('model').disabled=busy || !models.length || blocked;
    const running=jobs.some(j=>j.targetId===$('target').value && (active(j)||j.status==='unknown'));
    const executing=jobs.some(j=>j.targetId===$('target').value && active(j));
    const recovering=jobs.some(j=>j.targetId===$('target').value && j.status==='unknown');
    $('probe').disabled=busy || !catalog || running || blocked || readOnly;
    $('deploy').disabled=busy || !catalog || !models.length || !catalog.runtime?.available || catalog.deployment?.ready || running || blocked || readOnly;
    $('benchmark').disabled=busy || !catalog?.deployment?.ready || catalog.deployment.modelId!==$('model').value || running || blocked || readOnly;
    $('stop').disabled=busy || !catalog || executing || blocked || readOnly;
    $('stop').textContent=recovering?'恢复设备状态':'停止本模块服务';
    $('query').disabled=busy || !selected || blocked;
    $('report').disabled=busy || !selected || blocked;
    $('refresh').disabled=busy;
  }
  function renderJobs() {
    $('jobs').replaceChildren();
    if(!jobs.length)add($('jobs'),'p','暂无任务记录','muted');
    jobs.forEach(job=>{const b=add($('jobs'),'button',(operations[job.operation]||job.operation)+' · '+(statuses[job.status]||job.status),'job'); b.setAttribute('aria-pressed',String(selected?.id===job.id)); add(b,'small',job.targetId+' · '+(job.inputs?.modelId||'设备')+' · '+job.createdAt); b.addEventListener('click',()=>selectJob(job.id));});
    controls();
  }
  function renderReceipt() {
    const root=$('receipt'); root.replaceChildren();
    if(!selected){add(root,'p','选择一条任务查看执行回执。','muted');controls();return;}
    add(root,'p',(operations[selected.operation]||selected.operation)+' · '+(statuses[selected.status]||selected.status));
    add(root,'p','任务 '+selected.id,'note');
    if(selected.status==='unknown')add(root,'p','执行结果尚未确认。请查询这条任务；不要再次提交部署。','note');
    if(selected.status==='superseded')add(root,'p','设备已通过停止操作恢复。原任务结果仍未知，历史回执保留。','note');
    if(selected.error)add(root,'p',typeof selected.error==='string'?errorText(selected.error):JSON.stringify(selected.error),'note');
    const result=selected.result;
    if(result){
      const grid=add(root,'div','','facts');
      if(result.backend)fact(grid,'运行后端',result.backend.toUpperCase());
      if(result.ready!==undefined)fact(grid,'推理服务',result.ready?'就绪':'未就绪');
      if(result.modelId)fact(grid,'模型',result.modelId);
      if(Array.isArray(result.cases))result.cases.forEach((item,index)=>{
        const section=add(root,'div');add(section,'h3','任务 '+(index+1));const values=add(section,'div','','facts');
        fact(values,'首字延迟',item.ttftMs,' ms');fact(values,'总耗时',item.totalMs,' ms');fact(values,'生成速度',item.tokensPerSecond,' token/s');fact(values,'生成 token',item.generatedTokens);
        if(Array.isArray(item.unavailableReasons) && item.unavailableReasons.length)add(section,'p',item.unavailableReasons.join('；'),'note');
        if(item.rateDefinition)add(section,'p',item.rateDefinition==='runtime_timings_predicted_per_second'?'速度来自运行时生成阶段计时。':'速度按整次请求耗时计算，包含首字等待。','note');
      });
      const detail=add(root,'details');add(detail,'summary','完整回执');add(detail,'pre',JSON.stringify(result,null,2));
    }
    controls();
  }
  function merge(job){const i=jobs.findIndex(j=>j.id===job.id);if(i>=0)jobs[i]=job;else jobs.unshift(job);if(selected?.id===job.id)selected=job;renderJobs();renderReceipt();}
  async function loadTarget() {
    const rev=++targetRevision, id=$('target').value; models=[];catalog=null;$('model').replaceChildren();$('targetFacts').replaceChildren();controls();
    if(!id)return;
    const data=await request('/targets/'+encodeURIComponent(id));
    if(rev!==targetRevision || id!==$('target').value)return;
    catalog=data.catalog; models=Array.isArray(catalog.models)?catalog.models:[];
    models.forEach(model=>{const option=add($('model'),'option',model.label+' · '+(model.quantization||'GGUF'));option.value=model.id;});
    if(models.some(m=>m.id===catalog.deployment?.modelId))$('model').value=catalog.deployment.modelId;
    fact($('targetFacts'),'目标板型',data.target.board);fact($('targetFacts'),'后端',catalog.backend?.toUpperCase());fact($('targetFacts'),'运行环境',catalog.runtime?.available?'已安装':'待安装');fact($('targetFacts'),'服务状态',catalog.deployment?.ready?'就绪':'未启动');
    controls();
  }
  function schedule(){clearTimeout(timer);if(active(selected))timer=setTimeout(()=>queryJob().catch(e=>{notice('状态查询失败：'+e.message+'。可手动继续查询。',true);controls();}),3000);}
  async function queryJob(){if(!selected)return;const id=selected.id;const data=await request('/jobs/'+encodeURIComponent(id));if(selected?.id!==id)return;merge(data.job);if(!active(selected)){await loadTarget().catch(e=>notice('任务已更新，设备状态读取失败：'+e.message,true));}schedule();}
  async function selectJob(id){clearTimeout(timer);selected=jobs.find(j=>j.id===id)||null;renderJobs();renderReceipt();await queryJob().catch(e=>notice('任务读取失败：'+e.message,true));}
  async function refresh(){if(loadedIdentity && loadedIdentity!==identity())clear();busy=true;blocked=false;loadedIdentity=identity();controls();try{const data=await request('/capabilities');readOnly=data.readOnly===true;targets=data.targets||[];const previous=$('target').value;$('target').replaceChildren();targets.forEach(t=>{const o=add($('target'),'option',t.label+' · '+t.board);o.value=t.id;});if(targets.some(t=>t.id===previous))$('target').value=previous;const list=await request('/jobs');jobs=list.jobs||[];if(selected)selected=jobs.find(j=>j.id===selected.id)||null;renderJobs();renderReceipt();if(targets.length){await loadTarget();notice(readOnly?'当前为只读视图。':'设备目录已读取。部署完成后运行性能实测。');}else notice('尚未接入 X5 部署客户端。请由管理员完成设备接入。');schedule();}catch(e){catalog=null;notice('读取失败：'+e.message,true);}finally{busy=false;controls();}}
  async function run(operation){
    if(busy || blocked || $(operation).disabled)return;busy=true;controls();clearTimeout(timer);
    const input={targetId:$('target').value,operation};if(operation==='deploy'||operation==='benchmark')input.modelId=$('model').value;
    try{const data=await request('/jobs',{method:'POST',body:JSON.stringify(input)});selected=data.job;merge(data.job);notice('任务已提交，请以执行回执确认结果。');schedule();}
    catch(e){notice('提交未确认：'+e.message+'。先刷新记录查询任务，避免重复执行。',true);await request('/jobs').then(data=>{jobs=data.jobs||[];renderJobs();}).catch(()=>{});}
    finally{busy=false;controls();}
  }
  ['probe','deploy','benchmark','stop'].forEach(op=>$(op).addEventListener('click',()=>run(op)));
  $('target').addEventListener('change',()=>loadTarget().catch(e=>notice('设备读取失败：'+e.message,true)));
  $('model').addEventListener('change',controls);
  $('refresh').addEventListener('click',refresh);
  $('query').addEventListener('click',()=>queryJob().catch(e=>notice('状态查询失败：'+e.message,true)));
  $('report').addEventListener('click',async()=>{if(!selected || busy)return;busy=true;controls();const id=selected.id;try{const data=await request('/jobs/'+encodeURIComponent(id)+'/report');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=add(document.body,'a','');a.href=url;a.download='edge-llm-'+id+'.json';a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){notice('报告下载失败：'+e.message,true);}finally{busy=false;controls();}});
  window.addEventListener('storage',()=>{if(loadedIdentity!==identity()){clear();loadedIdentity=identity();notice('身份已改变，请刷新记录。',true);}});
  window.addEventListener('pagehide',clear);
  refresh();
})();`;
