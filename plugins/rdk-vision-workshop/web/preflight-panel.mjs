const checks={service:'相机服务',board:'X5 板端连接',frame:'当前画面'};
const states={waiting:'待检查',checking:'检查中',passed:'通过',blocked:'待处理'};
const fixes={
  camera_binding_required:'先在下方关联本工位相机实验，再检查 X5。',
  camera_unconfigured:'在相机插件完成连接设置后重试。',
  camera_configuration_invalid:'运行相机插件连接自检，核对私有连接文件。',
  camera_auth_required:'确认当前身份可读取本工位相机实验。',
  camera_service_unreachable:'确认本机相机服务已启动，然后重试。',
  camera_archive_missing:'重新选择当前身份可访问的相机实验。',
  vision_device_adapter_required:'让助教确认本工位的板端适配器，再重新关联实验。',
  vision_device_transport_failed:'检查板卡供电、Studio 设备连接和相机服务的板端转发。',
  camera_capture_unconfirmed:'板端未及时响应。检查连接和转发，再重试预检。',
  camera_sdk_unavailable:'让助教检查本工位 SDK 与相机模式。',
  camera_recovery_required:'先用相机插件核对并恢复 ISP 与采流，再检查画面。',
  camera_stream_not_running:'在相机实验里点亮并打开预览，再重试。',
  camera_live_frame_stale:'预览帧未推进。检查当前采流后再试。',
  camera_live_receipt_invalid:'相机服务缺少可验证的实时帧回执。请助教检查服务版本。',
};
const pending={status:'waiting'};
const freshnessMs=120000;

export function createPreflightPanel({key,$,element,button,notify,getBinding,showCamera}) {
  let binding;
  let observation;
  let posting=false;
  let checking=false;
  let expired=false;
  const fresh=()=>observation?.completedAt&&Date.now()-Date.parse(observation.completedAt)<freshnessMs;
  async function request(method='GET') {
    const response=await fetch('/camera/preflight',{method,headers:{'X-Workshop-Session':key,
      ...(method==='POST'?{'Content-Type':'application/json'}:{})}});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error==='camera_capture_busy'?'相机有操作正在进行，请稍后重试。':'预检暂时无法运行。');
    return result.preflight;
  }
  async function poll() {
    if(checking||posting||!key) return;
    const current=binding;
    checking=true;
    try {
      const next=await request();
      if(current!==binding||posting) return;
      const nextExpired=Boolean(next?.completedAt&&Date.now()-Date.parse(next.completedAt)>=freshnessMs);
      if(JSON.stringify(next)!==JSON.stringify(observation)||expired!==nextExpired) {
        observation=next;expired=nextExpired;render();
      }
    } catch {}
    finally {checking=false;}
  }
  async function start() {
    if(posting||observation?.running) return;
    const current=binding;
    posting=true;
    render();
    try {
      const next=await request('POST');
      if(current===binding) {observation=next;expired=false;}
    } catch(error) {notify(error.message);}
    finally {posting=false;render();}
  }
  function render() {
    const status=$('preflight-status'),list=$('preflight-checks'),actions=$('preflight-actions');
    const busy=posting||observation?.running;
    const ready=!expired&&Object.keys(checks).every(key=>observation?.checks[key]?.status==='passed');
    status.textContent=busy?'检查中':expired?'回执已过期':ready?'三项通过':observation?'查看检查结果':'待检查';
    status.className='status-tag'+(ready?' ok':'');
    list.replaceChildren();actions.replaceChildren();
    for(const [id,label] of Object.entries(checks)) {
      const result=observation?.checks[id]??pending;
      const card=element('article','','preflight-check');
      card.append(element('h3',label),element('span',states[result.status]??states.waiting,
        'status-tag'+(result.status==='passed'&&!expired?' ok':result.status==='blocked'?' blocked':'')));
      if(result.code) card.append(element('p',fixes[result.code]??('检查未完成 · '+result.code),'preflight-error'));
      if(result.status==='passed'&&id==='board') card.append(element('p',[result.board,result.sensorModel,result.mode].filter(Boolean).join(' · ')));
      if(result.status==='passed'&&id==='frame') card.append(element('p',result.width+' × '+result.height+' · 已验证 SDK 帧时间推进'));
      if(result.checkedAt) card.append(element('p','工位记录于 '+new Date(result.checkedAt).toLocaleTimeString('zh-CN',{hour12:false})));
      list.append(card);
    }
    const check=button(observation?'重新检查':'运行连接预检',start,'primary');
    check.disabled=Boolean(busy);actions.append(check);
    if(!binding) actions.append(button('去关联相机实验',showCamera,'plain'));
  }
  function syncBinding() {
    const next=getBinding()?.experimentId??null;
    if(next===binding) return;
    binding=next;observation=undefined;expired=false;
    render();void poll();
  }
  return {syncBinding,poll,receipt:()=>fresh()?observation:undefined};
}
