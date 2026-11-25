import {normalizedModelHash,presetModelHash} from '/guide.mjs';

const phases={before:'调前',after:'调后',live:'本轮'};
const liveWindowMs=3500;
const errors={board_launcher_unconfigured:'本工位还没连接一键检测入口。请助教配置检测启动器，或由助教运行课程检测后读取回执。',
  board_launcher_invalid:'本工位检测启动配置无法读取。请助教检查启动配置。',
  board_launcher_model_unbound:'检测启动器尚未绑定这条路径的模型。请助教核对模型 SHA-256。',
  board_launcher_camera_unbound:'当前相机和工位检测配置不一致。请助教核对工位绑定。',
  board_launcher_route_unready:'请先补齐所选路径的模型回执，并通过本工位连接预检。',
  board_launcher_camera_busy:'相机正在采集或有 ISP 修改待处理。请先完成当前操作并恢复原始 ISP。',
  board_launcher_running:'检测已启动。请等待本轮结束。',
  board_launcher_locked:'工位正被另一轮检测占用，或上次任务没有完成清理。请助教检查板端采流状态。',
  board_launcher_start_failed:'检测启动失败。请助教核对板卡连接和本机启动配置。',
  board_launcher_run_failed:'板端检测未完成。请助教检查本轮 runner.log。',
  board_launcher_timeout:'等待板端检测超时。请助教检查板卡和 runner.log。',
  board_launcher_receipt_incomplete:'检测未形成完整回执。请助教检查实拍、ISP 回读和停流结果。',
  board_launcher_isp_unavailable:'当前工位无法运行已核对的 Gamma。请确认本轮已完成回读并保存取舍。',
  board_launcher_comparison_unavailable:'请先完成单项 Gamma、核对回读并恢复原始配置。工位检测启动器须支持双段对照。',
  board_launcher_comparison_scene_unconfirmed:'请先固定相机、照明和场景。',
  board_comparison_unavailable:'本轮缺少两段完整的实拍或原始配置恢复回执。',
  board_comparison_region_invalid:'请选择课程类别，再圈出一个完整目标所在的区域。',
  board_archive_unconfigured:'没有可读取的板端结果目录。',
  board_receipt_pending:'板端尚未写出回执。请确认本组任务已启动，再刷新。',
  board_model_mismatch:'板端模型与本工位所选模型的 SHA-256 不一致，请核对当前路径使用的 .bin 文件。',
  board_receipt_changed:'板端已写出新的运行回执。请刷新板端结果后再对照或留证。',
  board_asset_integrity_failed:'文件字节或配置回读和板端回执不一致，请检查原始制品。',
  board_asset_missing:'这份证据还没有归档，请刷新或核对板端结果。'};

export function createBoardPanel({key,$,element,button,notify,getReport,save,attach,compare}) {
  let report;
  let lastModel;
  let lastPath;
  let issue='';
  let reading=false;
  let saving=false;
  let generation=0;
  let preview;
  let lastAdvance;
  let watchRequested=false;
  let pending=false;
  let staticUrl;
  let launchState,launchIssue='',launching=false,launchCheck=0,checkingLaunch=false;
  let advances=[];
  let buffered=[],receivedSha;
  let scored;
  const ispMode=document.createElement('select');
  const currentIsp=element('option','用当前 ISP');currentIsp.value='current';
  const approvedIsp=element('option','用已核对的 Gamma，检测后恢复');approvedIsp.value='approved';
  const comparisonIsp=element('option','对照当前 ISP 与已核对的 Gamma');comparisonIsp.value='comparison';
  ispMode.setAttribute('aria-label','检测使用的 ISP 配置');
  ispMode.append(currentIsp,approvedIsp,comparisonIsp);
  ispMode.onchange=()=>{fixedScene.checked=false;render();};
  const sceneControl=element('label','','board-fixed-scene');
  const fixedScene=document.createElement('input');
  fixedScene.type='checkbox';
  fixedScene.onchange=render;
  sceneControl.append(fixedScene,element('span','已固定相机、照明和场景，采集期间保持不动。'));
  const launchButton=button('加载模型并开始检测',launch,'primary');
  const refreshButton=button('读取既有板端回执',()=>refresh(),'ghost');
  const gammaButton=button('看 Gamma 实拍前后',compareGamma,'ghost');
  const staticButton=button('查看静态样张结果',toggleStatic,'ghost');
  const adoptButton=button('采用回执并留证',saveEvidence,'ghost');
  const staticFigure=element('figure','','camera-archive-preview board-preview');
  const staticImage=element('img');
  staticImage.alt='课程静态样张的 BPU 检测结果';
  staticFigure.append(staticImage,element('figcaption','课程静态样张 · 用于核对 BPU 与标签'));
  staticFigure.hidden=true;
  const comparisonRoot=element('section','','board-comparison');
  comparisonRoot.hidden=true;
  let comparisonReceipt,comparisonUrls=[];
  $('board-actions').append(ispMode,sceneControl,launchButton,refreshButton,staticButton,gammaButton,adoptButton);
  $('board-evidence').before(staticFigure,comparisonRoot);
  async function fetchResult(part,timeout=15000,method='GET',mode,body) {
    const headers={'X-Workshop-Session':key,...(mode?{'X-Workshop-ISP-Mode':mode}:{}),
      ...(mode==='comparison'&&fixedScene.checked?{'X-Workshop-Fixed-Scene':'1'}:{}),
      ...(body?{'Content-Type':'application/json'}:{})};
    const response=await fetch('/board/'+part,{method,headers,body:body&&JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
    if(!response.ok) {
      const {error}=await response.json().catch(()=>({}));
      throw new Error(errors[error]??'板端回执读取失败，请核对结果文件。');
    }
    return response;
  }
  function fetchArtifact(receipt,name) {
    return fetchResult('file/'+encodeURIComponent(name)+'?receipt='+encodeURIComponent(receipt.receiptSha256));
  }
  function activeModel(course) {
    if(course.routing.selected==='C') return;
    if(course.routing.selected==='B') return presetModelHash(course.resume.evidence.preset_model);
    const model=normalizedModelHash(course.resume.evidence.x5_model_hash);
    const run=course.resume.run;
    if(run?.source!=='robogo'||model===run.modelSha256) return model;
  }
  function syncModel() {
    const course=getReport();
    const model=activeModel(course);
    const path=course.routing.selected;
    if(lastModel===model&&lastPath===path) return;
    lastModel=model;lastPath=path;generation++;report=undefined;issue='';reading=false;
    launchState=undefined;launchIssue='';launchCheck=0;
    ispMode.value='current';
    watchRequested=false;pending=false;clearPreview();
  }
  function clearPreview() {
    if(preview) URL.revokeObjectURL(preview.url);
    if(staticUrl) URL.revokeObjectURL(staticUrl);
    staticUrl=undefined;staticFigure.hidden=true;staticImage.removeAttribute('src');
    staticButton.textContent='查看静态样张结果';
    preview=undefined;lastAdvance=undefined;advances=[];
    buffered=[];receivedSha=undefined;
    clearComparison();
  }
  function clearComparison() {
    for(const url of comparisonUrls) URL.revokeObjectURL(url);
    comparisonUrls=[];
    comparisonReceipt=undefined;scored=undefined;
    comparisonRoot.hidden=true;
    comparisonRoot.replaceChildren();
  }
  function renderComparison(recorded) {
    if(!recorded?.comparison) return;
    if(comparisonReceipt===recorded.receiptSha256) return;
    clearComparison();
    comparisonReceipt=recorded.receiptSha256;
    comparisonRoot.hidden=false;
    const initialHint='核对同一目标在两张实拍里的位置。在调前图点目标框的两个对角，再选择类别计算。';
    const hint=element('p',initialHint);
    const grid=element('div','','board-comparison-images');
    const result=element('div','','board-comparison-result');
    result.setAttribute('aria-live','polite');
    comparisonRoot.append(element('h3','同一场景 · Gamma 检测对照'),hint,grid);
    const markers=[];
    const values=['左','上','右','下'].map(label=>{
      const field=element('label',label+' (%)');
      const input=element('input');
      input.type='number';input.min='0';input.max='100';input.step='0.1';
      field.append(input);
      return {field,input};
    });
    let first;
    const region=()=>values.map(({input})=>input.value===''?NaN:Number(input.value)/100);
    function updateRegion() {
      scored=undefined;
      result.replaceChildren();
      const [left,top,right,bottom]=region();
      hint.textContent=[left,top,right,bottom].every(Number.isFinite)&&left<right&&top<bottom?
        '已标记同一个区域。核对两张图，再计算检出与不匹配框。':initialHint;
      for(const marker of markers) {
        marker.hidden=![left,top,right,bottom].every(Number.isFinite)||left>=right||top>=bottom;
        if(!marker.hidden) {
          marker.style.setProperty('--roi-left',left*100+'%');
          marker.style.setProperty('--roi-top',top*100+'%');
          marker.style.setProperty('--roi-width',(right-left)*100+'%');
          marker.style.setProperty('--roi-height',(bottom-top)*100+'%');
        }
      }
    }
    for(const {input} of values) input.oninput=updateRegion;
    for(const [phase,title] of [['before','当前 ISP'],['after','已核对的 Gamma']]) {
      const figure=element('figure');
      const surface=element('div','','board-comparison-frame');
      const photo=element('img');
      photo.alt=title+'的 X5 实拍与检测框';
      const marker=element('div','','board-roi');
      marker.hidden=true;
      markers.push(marker);
      const state=element('p','正在读取实拍…','board-image-status');
      surface.append(photo,marker,state);
      figure.append(surface,element('figcaption',title));
      grid.append(figure);
      if(phase==='before') {
        surface.classList.add('select-region');
        surface.onclick=event=>{
          if(!photo.complete||!photo.naturalWidth) return;
          const rect=photo.getBoundingClientRect();
          const limit=value=>Math.max(0,Math.min(100,value));
          const point=[limit(100*(event.clientX-rect.left)/rect.width),limit(100*(event.clientY-rect.top)/rect.height)];
          if(!first) {
            first=point;
            hint.textContent='已选第一个角，点目标框的另一个对角。';
            return;
          }
          const bounds=[Math.min(first[0],point[0]),Math.min(first[1],point[1]),
            Math.max(first[0],point[0]),Math.max(first[1],point[1])];
          values.forEach(({input},i)=>{input.value=bounds[i].toFixed(1);});
          first=undefined;updateRegion();
        };
      }
      void fetchArtifact(recorded,recorded.comparison[phase].file).then(response=>response.blob()).then(blob=>{
        if(comparisonReceipt!==recorded.receiptSha256) return;
        const url=URL.createObjectURL(blob);
        comparisonUrls.push(url);
        photo.onload=()=>{state.hidden=true;};
        photo.onerror=()=>{state.textContent='实拍解码失败，请重新读取板端回执。';};
        photo.src=url;
      }).catch(error=>{state.textContent=error.message;});
    }
    const label=document.createElement('select');
    label.setAttribute('aria-label','目标课程类别');
    label.append(...[['','选择课程类别'],['park','停车标识 park'],['qrcode','二维码 qrcode'],['obstacle','路锥等障碍物 obstacle']].map(([value,title])=>{
      const option=element('option',title);option.value=value;return option;
    }));
    label.onchange=updateRegion;
    const form=element('div','','board-comparison-tools');
    const coordinates=element('details','','proof-details');
    const fields=element('div','','board-coordinates');
    fields.append(...values.map(({field})=>field));
    coordinates.append(element('summary','键盘输入目标框坐标'),fields);
    async function evaluateTarget(targetAbsent) {
      scoreButton.disabled=absentButton.disabled=true;
      try {
        if(targetAbsent) {
          first=undefined;
          values.forEach(({input})=>{input.value='';});
          label.value='';
          updateRegion();
        }
        const inputs={receiptSha256:recorded.receiptSha256,...(targetAbsent?{targetAbsent}:{label:label.value,region:region()})};
        const next=await(await fetchResult('score',10000,'POST',undefined,inputs)).json();
        if(comparisonReceipt!==recorded.receiptSha256||(targetAbsent?label.value||region().some(Number.isFinite):
            inputs.label!==label.value||!inputs.region.every((value,index)=>value===region()[index]))) return;
        scored=next;
        if(targetAbsent) hint.textContent='两张图用于核对取流、Gamma 和背景框。';
        const cards=element('div','','board-comparison-images');
        for(const [phase,title] of [['before','当前 ISP'],['after','Gamma']]) {
          const data=next.results[phase];
          const card=element('div','','board-comparison-card');
          card.append(element('strong',title),
            element('b',targetAbsent?`${data.frames} 帧 · ${data.unmatchedBoxes} 个框`:`${data.matchedFrames}/${data.frames} 帧检出`),
            element('span',targetAbsent?'课程目标待测':`最长连续 ${data.longestMatch} 帧 · ${data.unmatchedBoxes} 个不匹配框`));
          cards.append(card);
        }
        result.replaceChildren(cards,element('p',(targetAbsent?'目标检出留待课程实物验收。':
          '框须匹配所选类别，且与所圈区域重叠达到 IoU 0.30。不匹配框需结合画面复核。')+
          '原始 ISP 已恢复，采用回执时会一并保存本次对照。'));
      } catch(error) {result.textContent=error.message;}
      finally {scoreButton.disabled=absentButton.disabled=false;}
    }
    const scoreButton=button('计算检出对照',()=>evaluateTarget(false),'primary');
    const absentButton=button('未摆放课程目标',()=>evaluateTarget(true),'ghost');
    form.append(label,scoreButton,absentButton);
    comparisonRoot.append(form,coordinates,result);
  }
  async function checkLaunch() {
    if(checkingLaunch||launching||Date.now()-launchCheck<1400) return;
    launchCheck=Date.now();checkingLaunch=true;
    const model=lastModel,path=lastPath,checkedAt=launchCheck;
    try {
      const next=await(await fetchResult('launch',2500)).json();
      if(model===lastModel&&path===lastPath&&checkedAt===launchCheck&&!launching) {launchState=next;launchIssue='';}
    } catch(error) {
      if(model===lastModel&&path===lastPath&&checkedAt===launchCheck&&!launching) launchIssue=error.name==='TimeoutError'?'工位检测状态读取超时，正在重试。':error.message;
    } finally {checkingLaunch=false;render();}
  }
  async function launch() {
    if(launching||!launchState?.ready) return;
    launching=true;launchIssue='';render();
    const model=lastModel,path=lastPath;
    try {
      const next=await(await fetchResult('launch',5000,'POST',ispMode.value)).json();
      if(model!==lastModel||path!==lastPath) return;
      launchState=next;generation++;reading=false;report=undefined;
      watchRequested=true;issue='';pending=false;clearPreview();
      void refresh(true);
    } catch(error) {
      launchIssue=error.name==='TimeoutError'?'正在核对启动状态。请等状态刷新后再操作。':error.message;
    } finally {launching=false;launchCheck=0;render();}
  }
  async function refresh(automatic=false) {
    if(reading) return;
    const current=++generation;
    reading=true;
    if(!automatic) {watchRequested=true;issue='';render();}
    try {
      const known=receivedSha;
      const {view:next,imageBase64,previewPending,frames}=await(await fetchResult('preview?batch=1'+(known?'&known='+known:''),2800)).json();
      if(current!==generation) return;
      if(next.modelSha256!==lastModel) throw new Error(errors.board_model_mismatch);
      if(report&&next.runId!==report.runId) clearPreview();
      const frame=next.latestDetection;
      const sameRun=Boolean(preview&&next.runId&&preview.runId===next.runId);
      if(sameRun&&frame&&BigInt(frame.sdkTimestampNs)<BigInt(preview.frame.sdkTimestampNs)) return;
      if(frames?.length) {
        buffered=[...buffered,...frames].slice(-4);
        receivedSha=frames.at(-1).frame.sha256;
      } else if(frame&&(imageBase64||known===frame.sha256&&preview?.frame.sha256===frame.sha256)) {
        if(next.status!=='started') buffered=[];
        receivedSha=frame.sha256;
        displayFrame(frame,imageBase64,next.runId);
      }
      if(next.status!=='started'&&buffered.length) {
        const latest=buffered.at(-1);buffered=[];
        displayFrame(latest.frame,latest.imageBase64,next.runId);
      }
      report=next;pending=Boolean(previewPending);issue='';
    } catch(error) {
      if(current===generation) issue=error.name==='TimeoutError'?'检测画面读取超时。会继续尝试读取新帧。':error.message;
    }
    finally {if(current===generation) {reading=false;render();}}
  }
  function displayFrame(frame,imageBase64,runId) {
    const sameRun=Boolean(preview&&runId&&preview.runId===runId);
    const advanced=sameRun&&BigInt(frame.sdkTimestampNs)>BigInt(preview.frame.sdkTimestampNs);
    if(imageBase64) {
      const bytes=Uint8Array.from(atob(imageBase64),value=>value.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
      if(preview) URL.revokeObjectURL(preview.url);
      preview={url,frame,runId};
    } else if(preview) {preview.frame=frame;preview.runId=runId;}
    if(advanced) {
      lastAdvance=Date.now();
      advances=[...advances.filter(value=>value>=lastAdvance-5000),lastAdvance];
    } else if(!sameRun) {lastAdvance=undefined;}
  }
  async function toggleStatic() {
    if(!staticFigure.hidden) {staticFigure.hidden=true;staticButton.textContent='查看静态样张结果';return;}
    const current=report;
    staticButton.disabled=true;
    try {
      if(!staticUrl) {
        const result=await(await fetchArtifact(current,'static-detection.jpg')).blob();
        if(current?.runId!==report?.runId||current?.modelSha256!==report?.modelSha256) return;
        staticUrl=URL.createObjectURL(result);staticImage.src=staticUrl;
      }
      staticFigure.hidden=false;staticButton.textContent='收起静态样张';
    } catch(error) {notify(error.message);}
    finally {staticButton.disabled=false;}
  }
  async function compareGamma() {
    const current=report;
    try {
      const assets=['before','after'].map(kind=>current.assets.find(item=>item.kind===kind));
      const stills=await Promise.all(assets.map(async asset=>{
        const contents=await(await fetchArtifact(current,asset.file)).blob();
        return new File([contents],'板端-'+asset.file,{type:contents.type});
      }));
      const proof=current.gamma?.curveReadback;
      const matched=proof?.status==='verified'&&assets[1].tuningHash===current.readbackHash&&
        /^[a-f0-9]{64}$/.test(proof.actualCurrentCurveSha256);
      compare(stills,assets,matched?proof:undefined);
    } catch(error) {notify(error.message);}
  }
  async function saveEvidence() {
    if(saving||report?.status!=='completed'||launchState?.run&&launchState.run.state!=='completed') return;
    saving=true;render();
    const recorded=report;
    const comparisonScore=scored?.receiptSha256===recorded.receiptSha256?scored:undefined;
    const receiptNames=['receipt.json',...recorded.snapshotNames];
    const initialPath=getReport().routing.selected;
    try {
      const samples=recorded.comparison?[recorded.comparison.before.file,recorded.comparison.after.file,
        ...recorded.assets.filter(asset=>asset.kind==='static_detection').map(asset=>asset.file)]:
        recorded.assets.map(item=>item.file);
      const names=[...receiptNames,...samples];
      const files=await Promise.all(names.map(async name=>{
        const blob=await(await fetchArtifact(recorded,name)).blob();
        return new File([blob],'板端-'+name,{type:blob.type});
      }));
      if(comparisonScore) files.push(new File([JSON.stringify(comparisonScore,null,2)],'板端-Gamma检测对照.json',{type:'application/json'}));
      const course=getReport();
      if(course.routing.selected!==initialPath||activeModel(course)!==recorded.modelSha256) throw new Error('工位路径或模型已变化，请重新读取回执。');
      attach(files,recorded);
      const evidence={...course.resume.evidence};
      if(recorded.status==='completed'&&recorded.frameCount>0&&recorded.previewStopped&&recorded.staticBpu) {
        const frame=recorded.latestDetection??recorded.assets.findLast(asset=>asset.kind==='detection_after')??
          recorded.assets.findLast(asset=>asset.kind==='detection_live');
        if(frame&&frame.tuningHash===recorded.readbackHash) {
          const blockers={...course.resume.blockers};delete blockers.vision_device_transport_failed;
          const original=recorded.assets.find(asset=>asset.kind==='before');
          const candidate=recorded.assets.find(asset=>asset.kind==='after');
          if(recorded.cameraIdentity&&original&&recorded.restoration==='verified') {
            evidence.current_device_identity=[recorded.cameraIdentity.board,recorded.cameraIdentity.sensorModel,recorded.cameraIdentity.cameraMode].filter(Boolean).join(' · ');
            evidence.fresh_camera_image='SDK '+original.sdkTimestampNs+' · 板端-'+original.file;
            evidence.original_snapshot='板端-original-isp.json · '+original.tuningHash;
          }
          if(candidate&&candidate.tuningHash===recorded.readbackHash&&recorded.gamma?.curveReadback?.status==='verified'&&
              /^[a-f0-9]{64}$/.test(recorded.gamma.curveReadback.actualCurrentCurveSha256)) {
            evidence.gamma_readback='sha256:'+recorded.gamma.curveReadback.actualCurrentCurveSha256;
            evidence.gamma_fresh_frame='SDK '+candidate.sdkTimestampNs+' · 板端-'+candidate.file;
          }
          const previous=recorded.receiptSha256===course.resume.evidence[
            course.routing.selected==='A'?'board_detection_receipt':'preset_detection_receipt'];
          if(course.routing.selected==='A') {
            evidence.board_model_hash='sha256:'+recorded.modelSha256;
            evidence.actual_bpu_inference='板端静态 BPU 推理，板端-receipt.json';
            evidence.matching_pre_postprocess='板端运行确认 640 NV12、六个输出头、park/qrcode/obstacle';
            evidence.exclusive_camera_owner='单一路 SDK 相机流，板端-receipt.json';
            evidence.tuning_in_detection_pipeline='sha256:'+recorded.readbackHash;
            evidence.fresh_frames='SDK '+frame.sdkTimestampNs;
            evidence.inference_result='运行成功';
            evidence.board_detection_receipt=recorded.receiptSha256;
            if(!previous) evidence.target_result='未验证';
            evidence.live_detections='本轮持续采集推理，板端-'+frame.file+'；目标判定待学员核对';
          } else if(course.routing.selected==='B') {
            evidence.preset_board_model_hash='sha256:'+recorded.modelSha256;
            evidence.preset_bpu_inference='预置模型板端静态 BPU 推理，板端-receipt.json';
            evidence.preset_stream_isp='sha256:'+recorded.readbackHash;
            evidence.preset_live_frame='SDK '+frame.sdkTimestampNs;
            evidence.preset_inference_result='运行成功';
            evidence.preset_detection_receipt=recorded.receiptSha256;
            if(!previous) evidence.preset_target_result='未验证';
            evidence.preset_live_detections='预置模型实时帧 · 板端-'+frame.file;
          }
          if(course.routing.selected==='A'||course.routing.selected==='B') {
            if(recorded.restoration==='verified') evidence.restoration_and_release='已恢复及停止采流，板端-restored-isp.json';
            if(recorded.restoration==='no_write') evidence.restoration_and_release='未写入 ISP，已停流，见板端-receipt.json';
          }
          save({evidence,blockers},'已采用本轮设备回执，现场检出结果可单独复核。');
        }
      }
      notify('板端实拍、ISP 回读和检测回执已加入成果包。');
    } catch(error) {notify(error.message);}
    finally {saving=false;render();}
  }
  function render() {
    const course=getReport();const panel=$('board');
    panel.hidden=!activeModel(course);
    if(panel.hidden) return;
    $('board-title').textContent=course.routing.selected==='B'?'预置模型检测':'本组模型检测';
    const r=report;
    const job=launchState?.run;
    const preparing=launching||job?.state==='running';
    const comparing=ispMode.value==='comparison';
    const jobError=launchIssue||errors[job?.error];
    const streaming=r?.status==='started'&&Boolean(preview)&&!issue&&!pending&&
      lastAdvance!==undefined&&Date.now()-lastAdvance<=liveWindowMs;
    const done=r?.status==='completed'||r?.status==='failed';
    $('board-status').textContent=jobError?'检测需要处理':streaming?'实时更新':preparing?'正在加载模型和相机':issue?'需要处理':r?.status==='failed'?'板端任务失败':
      pending?'同步新帧中':r?.status==='completed'?'运行结束 · 已归档':r||reading?'等待板端新帧':'等待读取';
    $('board-status').className='status-tag'+(issue||r?.status==='failed'?' blocked':streaming||r?.status==='completed'?' ok':'');
    $('board-help').textContent=jobError||(!preparing&&issue)||(preview?
      done?'查看本轮归档帧，按你选定的目标记录是否检出。':
      comparing||r?.stage==='before'||r?.stage==='after'?'请保持相机、照明和场景不动，等待两段采集和恢复。':
      '移动课程目标，观察框和类别的变化。按你选择的目标记录是否检出。':
      preparing?'正在核对模型、启动 BPU 和相机。':
      errors[launchState?.reason]||'启动课程检测，在画面里移动目标，观察检测框与类别。');
    const figure=$('board-frame');
    const img=$('board-frame-image');
    figure.hidden=!preview;
    if(preview) {
      const {frame,url}=preview;
      if(img.getAttribute('src')!==url) img.src=url;
      $('board-frame-caption').textContent=phases[frame.phase]+' · '+(streaming?'新帧正在更新':done?'本轮归档帧':'最近已验证帧')+
        ' · SDK '+frame.sdkTimestampNs;
      const boxes=Object.entries(frame.counts).filter(([,count])=>count>0).map(([name,count])=>name+' ×'+count).join('、');
      const fps=streaming&&advances.length>2?((advances.length-1)*1000/(advances.at(-1)-advances[0])).toFixed(1):undefined;
      $('board-frame-detail').textContent='此帧 BPU 推理 '+frame.forwardMs.toFixed(1)+' ms · '+(boxes||'此帧无检测框')+
        (fps?' · 工作台显示 '+fps+' 帧/秒':'');
    } else {
      img.removeAttribute('src');
      $('board-frame-detail').textContent='';
    }
    launchButton.hidden=!launchState?.ready&&!preparing;
    launchButton.disabled=preparing||comparing&&!fixedScene.checked;
    launchButton.textContent=preparing?'检测运行中':comparing?'开始两段检测':job?'重新检测':'加载模型并开始检测';
    ispMode.hidden=!launchState?.canUseApprovedIsp||launchButton.hidden;
    ispMode.disabled=preparing;
    comparisonIsp.disabled=!launchState?.canCompareIsp&&!preparing;
    sceneControl.hidden=!comparing||launchButton.hidden;
    if(!launchState?.canUseApprovedIsp) ispMode.value='current';
    refreshButton.textContent=preview?'刷新板端画面':'读取既有板端回执';
    refreshButton.disabled=reading;
    staticButton.hidden=r?.status!=='completed'||!r.assets.some(asset=>asset.kind==='static_detection');
    gammaButton.hidden=!(r?.assets.some(asset=>asset.kind==='before')&&r.assets.some(asset=>asset.kind==='after'));
    adoptButton.hidden=r?.status!=='completed'||Boolean(job&&job.state!=='completed');
    adoptButton.textContent=saving?'正在保存':'采用回执并留证';
    adoptButton.disabled=saving;
    const display=$('board-evidence');
    const auditOpen=display.querySelector('details')?.open??false;
    display.replaceChildren();
    if(!r) return;
    renderComparison(r);
    const items=element('ol','','action-checklist');
    for(const [name,value] of [['核对板上模型',`${course.routing.selected==='B'?'预置模型':'本组模型'} SHA-256 已匹配 · ${r.modelSha256.slice(0,12)}…`],
      ['执行 BPU 推理',r.staticBpu?'静态前向已通过':'等待静态前向'],
      ['ISP 与相机',r.approvedGamma?'实际生效的 Gamma 曲线已回读':
        r.assets.some(asset=>asset.kind==='after')?'调前调后实拍已留证':
        r.readbackHash?'实际检测流 ISP 已回读':r.cameraIdentity?'相机已启动，正在读 ISP':'等待相机取流'],
      ['保存板端结果',r.frameCount?`已归档 ${r.frameCount} 张连续检测帧`:'等待真实 SDK 帧'],
      ['恢复原配置',r.restoration==='verified'&&r.previewStopped?'回读一致，已停止采流':r.restoration==='no_write'&&r.previewStopped?'未写入 ISP，已停止采流':r.restoration==='unconfirmed'?'恢复待复核':'等待恢复和停流']]) {
      const row=element('li');row.append(element('strong',name+' · '),element('span',value));items.append(row);
    }
    const audit=element('details','','proof-details');
    audit.open=auditOpen;
    audit.append(element('summary','查看上板、取流和恢复回执'),items);
    const counts=Object.entries(r.phases??{}).map(([phase,v])=>`${phase==='before'?'调整前':phase==='after'?'调整后':'实时采流'} ${v.frames} 帧，${v.boxes} 个检测框`+
      (Number.isFinite(v.processingFps)?`，板端处理 ${v.processingFps.toFixed(1)} 帧/秒`:''));
    if(counts.length) display.append(element('p',counts.join(' ｜ '),'camera-run-state'));
    if(r.failure) display.append(element('p','板端提示 · '+r.failure,'camera-run-state'));
    display.append(audit);
  }
  function poll() {
    if(!lastModel||$('board').hidden||document.hidden) return;
    void checkLaunch();
    const next=buffered.shift();
    if(next) {displayFrame(next.frame,next.imageBase64,report?.runId);render();}
    const current=getReport().nextStep?.stageId;
    if(!watchRequested&&launchState?.run?.state!=='running'&&!['deploy','live','preset_deploy'].includes(current)) return;
    if(report?.status==='failed'||report?.status==='completed'&&!pending||issue===errors.board_archive_unconfigured) return;
    void refresh(true);
  }
  return {syncModel,render,poll};
}
