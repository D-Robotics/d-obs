const messages={
  camera_unconfigured:'先在 Camera Workshop 配置相机服务，再回来刷新。',
  camera_configuration_invalid:'本机连接配置不可读或格式有误。请在相机插件运行连接自检。',
  camera_service_unreachable:'暂时联系不到相机服务，请检查服务是否在线。',
  camera_auth_required:'当前身份无法读取相机实验，请在 Camera Workshop 核对账号。',
  camera_archive_missing:'当前身份看不到这个实验或帧，请重新选择实验。',
  camera_frame_integrity_failed:'存档字节与回执不符。请在相机插件检查原始帧。',
  camera_binding_invalid:'工位相机关联已变更，请刷新当前实验。',
};
const archiveTime=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'时间待核对';
const statusLabels={queued:'排队',running:'执行中',completed:'完成',canceled:'已取消',failed:'失败',interrupted:'中断'};

export function createCameraPanel({key, $, element, button, field, openDialog, notify, getBinding, bind, canRefresh, attach, compare}) {
  let archive;
  let selection;
  let failure='';
  let requestId=0;
  let loading=false;
  let thumbnail;

  async function request(path) {
    const response=await fetch(path,{headers:{'X-Workshop-Session':key}});
    if(!response.ok) {
      const body=await response.json().catch(()=>({}));
      throw new Error(messages[body.error]??'读取相机记录失败，请刷新重试。');
    }
    return response;
  }
  async function chooseExperiment() {
    try {
      const {experiments}=await (await request('/camera/experiments')).json();
      if(!experiments.length) {notify('当前账号没有相机实验。请先在 Camera Workshop 创建本工位实验。');return;}
      openDialog('关联本工位相机实验',[
        field('experimentId','实验名称',{value:getBinding()?.experimentId??'',options:[['','选择此工位的实验'],
          ...experiments.map(exp=>[exp.id,exp.title+' · '+(exp.sensorModel??'相机型号待确认')])]}),
      ],data=>bind({experimentId:data.experimentId}),'关联');
    } catch(error) { notify(error.message); }
  }
  async function refresh() {
    if(!getBinding()||!canRefresh()) return;
    const id=++requestId;
    const fromBinding=JSON.stringify(getBinding());
    let readMetadata=false;
    failure='';loading=true;render();
    try {
      const detail=await (await request('/camera')).json();
      if(id===requestId&&fromBinding===JSON.stringify(getBinding())) {
        archive=detail;
        readMetadata=true;
        const latest=detail.frames[0];
        if(latest&&latest.id!==thumbnail?.frame.id) {
          const entry=await readFrame(latest);
          if(id===requestId&&fromBinding===JSON.stringify(getBinding())) {
            if(thumbnail) URL.revokeObjectURL(thumbnail.url);
            thumbnail={...entry,url:URL.createObjectURL(entry.file)};
          }
        }
      }
    } catch(error) {
      if(id===requestId) {failure=error.message;if(!readMetadata) archive=undefined;}
    } finally { if(id===requestId) {loading=false;render();} }
  }
  function syncBinding() {
    const next=JSON.stringify(getBinding()??null);
    if(!canRefresh()||selection===next) return;
    selection=next;
    requestId++;
    if(thumbnail) {URL.revokeObjectURL(thumbnail.url);thumbnail=undefined;}
    archive=undefined;failure='';loading=false;
    if(getBinding()) void refresh();
    else render();
  }
  async function readFrame(frame) {
    const experimentId=getBinding().experimentId;
    const response=await request('/camera/frame/'+frame.id);
    const ext=frame.mimeType==='image/png'?'png':'jpg';
    const file=new File([await response.blob()],`相机存档-${frame.id}.${ext}`,{type:frame.mimeType});
    if(experimentId!==getBinding()?.experimentId) throw new Error(messages.camera_binding_invalid);
    const readback=archive?.readback;
    return {experimentId,frame,file,...(readback&&readback.hash===frame.tuningHash?{readback}:{})};
  }
  async function showFrame(frame) {
    try {
      const entry=thumbnail?.frame.id===frame.id?thumbnail:await readFrame(frame);
      const image=element('img','','camera-frame-preview');
      const href=URL.createObjectURL(entry.file);
      image.alt='Camera Workshop 相机存档';image.src=href;
      openDialog('本工位相机存档',[image,element('p',`${frame.width} × ${frame.height} · 存档于 ${archiveTime(frame.archivedAt)}`)],()=>{
        if(entry.experimentId!==getBinding()?.experimentId) throw new Error(messages.camera_binding_invalid);
        attach([entry]);
      },'附入成果包');
      $('dialog').addEventListener('close',()=>URL.revokeObjectURL(href),{once:true});
    } catch(error) {notify(error.message);}
  }
  async function showPair(pair) {
    try { compare(await Promise.all([pair.before,pair.after].map(readFrame))); }
    catch(error) { notify(error.message); }
  }
  function render() {
    const binding=getBinding();
    const badge=$('camera-status'),help=$('camera-help'),evidence=$('camera-evidence'),actions=$('camera-actions');
    evidence.replaceChildren();actions.replaceChildren();
    badge.textContent=loading?'正在读取':failure?'需要处理':archive?'存档可读取':binding?'等待读取':'未关联';
    badge.className='status-tag'+(failure?' blocked':archive?' ok':'');
    help.textContent=failure||(archive?'以下是所选实验的服务端存档。请根据采集时间确认属于本轮。':'关联你在 Camera Workshop 里使用的实验，直接查看相机存档帧和实际回读。');
    actions.append(button(binding?'更换实验':'关联相机实验',chooseExperiment,binding?'ghost':'primary'));
    if(binding) actions.append(button('刷新存档',refresh,'plain'),button('解除关联',()=>bind(null),'plain'));
    if(!archive||archive.experiment.id!==binding?.experimentId) return;
    const {experiment,readback,frames,runs,activeRun,probe}=archive;
    const latest=frames[0];
    const summary=element('dl','','camera-summary');
    for(const [title,value] of [['相机',experiment.sensorModel??'待核对'],['最新归档帧',latest?`${latest.width} × ${latest.height}`:'待归档'],
      ['ISP 独立回读',readback?(latest?.tuningHash===readback.hash?'与新帧一致':'已归档，待核对'):'待回读']]) {
      const item=element('div');item.append(element('dt',title),element('dd',value));summary.append(item);
    }
    evidence.append(element('strong',experiment.title),summary);
    if(latest&&thumbnail?.frame.id===latest.id) {
      const preview=element('figure','','camera-archive-preview');
      const photo=element('img');photo.src=thumbnail.url;photo.alt='最新相机归档画面';
      preview.append(photo,element('figcaption','归档于 '+archiveTime(latest.archivedAt)));evidence.append(preview);
    }
    const details=element('details','','tool-details');
    details.append(element('summary','查看参数与帧的技术回执'));
    const list=element('ul','','review-list');
    const device=[experiment.board,experiment.sensorModel,experiment.cameraMode].filter(Boolean).join(' · ');
    if(device) list.append(element('li',device));
    if(probe) list.append(element('li',`最近探针${probe.status==='completed'?'有回执':'执行失败'} · ${archiveTime(probe.recordedAt)}`));
    list.append(element('li',readback?`独立 ISP 回读 · ${readback.hash} · ${archiveTime(readback.recordedAt)}`:'当前实验还没有成功的独立 ISP 回读。'));
    list.append(element('li',latest?`最新归档画面 · ${latest.width} × ${latest.height} · ${archiveTime(latest.archivedAt)}${latest.sdkTimestampNs?' · SDK '+latest.sdkTimestampNs:''}`:'当前实验还没有相机归档帧。'));
    if(latest?.tuningHash&&readback) list.append(element('li',latest.tuningHash===readback.hash?'最新归档帧与独立回读的配置哈希一致。':'最新归档帧与最近一次回读属于不同配置，请核对版本。'));
    details.append(list);evidence.append(details);
    if(readback?.gamma) {
      const {gamma}=readback;
      list.append(element('li',`Gamma 表回读 · ${gamma.mode}${gamma.autoRows?' · '+gamma.autoRows+' 档':''}`));
      details.append(element('code','64 个节点 · '+gamma.nodes.join(' / ')));
    }
    if(latest) actions.append(button('查看原图并留证',()=>showFrame(latest),'primary'));
    if(runs.length) actions.append(button(activeRun?'切换相机 Run':'选择相机 Run',()=>openDialog('查看相机 AI 调参 Run',[
      field('runId','选择本轮 Run',{value:binding.runId??'',options:[['','选择相机 Run'],...runs.map(run=>[run.id,archiveTime(run.updatedAt)+' · '+run.id.slice(0,8)])]}),
    ],data=>bind({experimentId:experiment.id,runId:data.runId}),'查看'),'ghost'));
    if(activeRun?.id===binding.runId&&activeRun) {
      evidence.append(element('p',`相机 AI Run · ${statusLabels[activeRun.status]??'待核对'} · 已执行 ${activeRun.adjustmentCount??0} 次调整`,'camera-run-state'));
      if(activeRun.issue) evidence.append(element('p','相机 Run 提示 · '+activeRun.issue,'camera-run-state'));
      if(activeRun.pair) actions.append(button('打开实际前后帧',()=>showPair(activeRun.pair),'ghost'));
    }
  }
  function poll() {
    if(!loading&&!$('dialog').open&&['queued','running'].includes(archive?.activeRun?.status)) void refresh();
  }
  return {render,syncBinding,poll};
}
