const labels={photo:'本轮照片',raw:'Bayer RAW',isp:'ISP 显示图',render:'RAW 重渲染'};
const descriptions={raw:'传感器采样的灰度预览，可下载原始 Bayer 文件。',isp:'相机经当前 ISP 输出的画面。',render:'使用这组 RAW 和已回读配置重渲染。'};
const messages={
  camera_binding_invalid:'先关联本工位的相机实验。',
  camera_capture_busy:'相机正在采集。请先等待当前操作结束。',
  camera_capture_unconfirmed:'相机服务未返回完整回执。先核对实验存档，再决定是否重采。',
  camera_scene_required:'请填写固定场景。',
  camera_scene_changed:'场景已变更。请用「重采三图」开始新一组。',
  camera_render_raw_required:'请先采到本组 RAW。',
  camera_frame_integrity_failed:'下载的字节与存档哈希不符。请刷新后重新下载。',
  camera_archive_missing:'这个原件已不在当前采集组。请刷新查看。',
  camera_auth_required:'相机服务拒绝了当前身份。请核对插件连接。',
  camera_unconfigured:'相机服务未配置。请核对插件连接。',
  vision_device_adapter_required:'实验还没绑定可用的相机适配器。',
  vision_device_transport_failed:'相机服务无法确认板端采集。请检查设备连接和本实验的新存档，再决定是否重采。',
  vision_baseline_required:'先在相机插件读取并保存当前 ISP 配置。',
  vision_raw_replay_capture_metadata_required:'本组 RAW 缺少可信的曝光或增益回执。请确认手动曝光与增益后重采。',
  vision_raw_replay_manual_exposure_required:'当前是自动曝光。请在相机实验里确认手动曝光后，采集匹配的新 RAW。',
  vision_raw_replay_manual_white_balance_required:'当前是自动白平衡。请在相机实验里确认手动白平衡，再核对本组 RAW 的曝光和增益。',
  vision_raw_replay_capture_settings_mismatch:'当前 ISP 的曝光、增益和本组 RAW 回执不一致。请核对设置，必要时重采。',
};
const explain=code=>messages[code]??(code?.includes('raw_replay')?'请核对 SDK 渲染资格、手动曝光与白平衡，以及 RAW 的采集参数。技术回执 '+code
  :code?'相机服务未完成此项。技术回执 '+code:'相机服务暂无回执。');
const unconfirmedCapture=new Set(['camera_capture_unconfirmed','vision_device_transport_failed']);

export function createCapturePanel({key,$,element,button,field,openDialog,notify,getBinding,attach}) {
  let bindingId;
  let capture;
  let note='';
  let busy=false;
  let refreshing=false;
  const previews=new Map();
  const route=(kind,asset,preview=false)=>'/camera/capture/file/'+kind+'?id='+encodeURIComponent(asset.id)+(preview?'&preview=1':'');
  async function request(path,body) {
    const headers={'X-Workshop-Session':key,...(body?{'Content-Type':'application/json'}:{})};
    const response=await fetch(path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    if(!response.ok) throw new Error(explain((await response.json().catch(()=>({}))).error));
    return response;
  }
  async function readOriginal(kind,asset) {
    const experimentId=bindingId;
    const response=await request(route(kind,asset));
    const extension={ 'application/octet-stream':'raw','image/png':'png','image/jpeg':'jpg' }[asset.mimeType];
    const file=new File([await response.blob()],kind+'-'+asset.id+'.'+extension,{type:asset.mimeType});
    if(experimentId!==bindingId||asset.id!==capture?.assets[kind]?.id) throw new Error(explain('camera_archive_missing'));
    return {experimentId,frame:{...asset,kind},file};
  }
  async function saveOriginal(kind,asset) {
    const {file}=await readOriginal(kind,asset);
    const href=URL.createObjectURL(file);
    const link=element('a');link.href=href;link.download=file.name;
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(href),30000);
  }
  async function loadPreview(kind,asset,entry) {
    try {
      const response=await request(route(kind,asset,kind==='raw'));
      const blob=await response.blob();
      if(previews.get(kind)!==entry) return;
      entry.url=URL.createObjectURL(blob);
    } catch(error) {entry.error=error.message;}
    if(previews.get(kind)===entry) render();
  }
  function update(next) {
    if(JSON.stringify(next)===JSON.stringify(capture)) return;
    capture=next;
    for(const [kind,entry] of previews) {
      if(entry.id!==next?.assets[kind]?.id) {
        if(entry.url) URL.revokeObjectURL(entry.url);
        previews.delete(kind);
      }
    }
    for(const [kind,asset] of Object.entries(next?.assets??{})) {
      if(previews.has(kind)) continue;
      const entry={id:asset.id};previews.set(kind,entry);
      void loadPreview(kind,asset,entry);
    }
    render();
  }
  async function poll() {
    if(!bindingId||refreshing||busy) return;
    const id=bindingId;
    refreshing=true;
    try {
      const value=await(await request('/camera/capture')).json();
      if(id===bindingId&&!busy) {if(note) {note='';render();}update(value.capture);}
    } catch(error) {
      if(id===bindingId&&!busy&&note!==error.message) {note=error.message;render();}
    } finally {refreshing=false;}
  }
  function syncBinding() {
    const next=getBinding()?.experimentId??null;
    if(next===bindingId) return;
    bindingId=next;note='';
    update(undefined);render();void poll();
  }
  async function start(action,scene) {
    if(busy||capture?.running) return;
    busy=true;note='';render();
    try {update((await(await request('/camera/capture',{action,...(scene?{scene}:{})})).json()).capture);}
    catch(error) {note=error.message;}
    finally {busy=false;render();}
  }
  function askScene(action,title) {
    openDialog(title,[
      element('p','固定相机、目标和光照。采集会读取当前 ISP，RAW 渲染时 SDK 可能暂时切换采流。'),
      field('scene','固定场景',{value:capture?.scene??'',max:100,placeholder:'例如：实验台上的课程目标，左侧灯保持不变'}),
    ],({scene})=>start(action,scene),'开始采集');
  }
  function card(kind) {
    const node=element('article','','capture-card');
    const asset=capture?.assets[kind], error=capture?.errors[kind], preview=previews.get(kind);
    node.append(element('h3',labels[kind]));
    if(descriptions[kind]) node.append(element('p',descriptions[kind],'capture-description'));
    const state=capture?.running===kind?'采集中':asset?'已归档':error?'需要处理':'等待采集';
    node.append(element('span',state,'status-tag'+(asset?' ok':error?' blocked':'')));
    if(error) node.append(element('p',explain(error),'capture-error'));
    if(!asset) return node;
    if(preview?.url) {
      const image=element('img');image.src=preview.url;image.alt=labels[kind];
      node.append(image);
    } else if(preview?.error) {
      node.append(element('p',preview.error,'capture-error'),button('重试预览',()=>{
        const entry={id:asset.id};previews.set(kind,entry);void loadPreview(kind,asset,entry);render();
      },'plain'));
    } else node.append(element('p','正在回传预览…'));
    node.append(element('p',asset.width+' × '+asset.height+(asset.bayer?' · '+asset.bayer+' · '+asset.bitDepth+' bit':'')));
    const details=element('details','','tool-details');
    details.append(element('summary','查看采集回执'),element('p','SHA-256 · '+asset.sha256));
    if(asset.archivedAt) details.append(element('p','服务端归档 · '+asset.archivedAt));
    if(asset.sdkTimestampNs) details.append(element('p','SDK 帧时间 · '+asset.sdkTimestampNs+' ns'));
    if(asset.deviceCapturedAt) {
      const deviceTime=Date.parse(asset.deviceCapturedAt),archiveTime=Date.parse(asset.archivedAt);
      const suspect=Number.isFinite(deviceTime)&&Number.isFinite(archiveTime)&&Math.abs(deviceTime-archiveTime)>86400000;
      details.append(element('p','设备时间 · '+asset.deviceCapturedAt+(suspect?'（与归档时间差异大）':'')));
    }
    if(asset.readbackHash) details.append(element('p','渲染 ISP 回读 · '+asset.readbackHash));
    node.append(details,button('下载原件',()=>saveOriginal(kind,asset).catch(error=>notify(error.message)),'plain'));
    return node;
  }
  function render() {
    const status=$('capture-status'),help=$('capture-help'),grid=$('capture-grid'),actions=$('capture-actions');
    grid.replaceChildren();actions.replaceChildren();
    const active=busy||Boolean(capture?.running);
    const complete=['raw','isp','render'].every(kind=>capture?.assets[kind]);
    status.textContent=active?'正在采集':complete?'三图已归档':!bindingId?'未关联':'待采集或补齐';
    status.className='status-tag'+(complete&&!active?' ok':'');
    help.textContent=note||(capture?.recording?'已取到部分回执，课程记录保存失败。请保留原件。':!bindingId?'先在上方关联本工位相机实验。'
      :capture?.scene?'固定场景 · '+capture.scene+'。RAW 与 ISP 分次采集，渲染使用同组 RAW。'
      :'拍一张当前照片，或在固定场景下采集三张基线图。');
    const group=element('div','','capture-cards');
    for(const kind of ['raw','isp','render']) group.append(card(kind));
    grid.append(group);
    if(capture?.assets.photo||capture?.errors.photo||capture?.running==='photo') grid.prepend(card('photo'));
    if(!bindingId) return;
    actions.append(button('拍一张照片',()=>start('photo'),'ghost'));
    if(capture?.scene&&!complete) {
      const unconfirmed=['raw','isp','render'].some(kind=>unconfirmedCapture.has(capture.errors[kind]));
      if(!unconfirmed) actions.append(button('继续补齐三图',()=>start('baseline',capture.scene),'primary'));
      actions.append(button('重采三图',()=>askScene('retake','重采一组基线'),unconfirmed?'primary':'plain'));
      if(capture.assets.raw&&!capture.assets.render&&!unconfirmedCapture.has(capture.errors.render)) {
        actions.append(button('重试本组渲染',()=>start('render'),'plain'));
      }
    } else actions.append(button(complete?'重采三图':'采集三张基线图',()=>askScene(complete?'retake':'baseline','固定场景并采集'),'primary'));
    const assets=Object.entries(capture?.assets??{});
    if(assets.length) actions.append(button('将现有原件附入成果包',async()=>{
      try {attach(await Promise.all(assets.map(([kind,asset])=>readOriginal(kind,asset))));}
      catch(error) {notify(error.message);}
    },'ghost'));
    if(active) for(const control of actions.querySelectorAll('button')) control.disabled=true;
  }
  return {syncBinding,poll};
}
