import { detectionResults, guideCourse, guideSchema } from '/guide.mjs';
import { labels, steps } from '/steps.mjs';
import { storedZip } from '/zip.mjs';
import { createCameraPanel } from '/camera-panel.mjs';
import { createCapturePanel } from '/capture-panel.mjs';
import { createPreflightPanel } from '/preflight-panel.mjs';
import { createIspPanel } from '/isp-panel.mjs';
import { renderIspDemo } from '/isp-demo.mjs';
import { createBoardPanel } from '/board-panel.mjs';

const $=id=>document.getElementById(id);
const element=(tag,text='',className='')=>{
  const node=document.createElement(tag);
  node.className=className;
  node.textContent=text;
  return node;
};
function button(text, fn, style='ghost') {
  const b=element('button',text,'button '+style);
  b.type='button';
  b.addEventListener('click',fn);
  return b;
}
function roboGoLink(receipt,style='ghost') {
  const link=element('a','打开 RoboGO 训练任务','button '+style);
  link.href='https://robogo.d-robotics.cc/train-job';
  try {
    const url=new URL(receipt);
    if(url.origin==='https://robogo.d-robotics.cc'&&!url.username&&!url.password) link.href=url.href;
  } catch {}
  link.target='_blank';link.rel='noopener noreferrer';
  return link;
}
function field(key,title,{value='',type='text',options=[],required=true,max=300,placeholder=''}={}) {
  const label=element('label',title,'field');
  const input=element(options.length?'select':type==='textarea'?'textarea':'input');
  input.name=key;
  if(options.length) for(const [k,v] of options) {const option=element('option',v);option.value=k;input.append(option);}
  else if(type!=='textarea') input.type=type;
  input.value=value??'';
  input.required=required;
  input.placeholder=placeholder;
  if(type==='number') {input.min='0';input.max=String(max);input.step='1';}
  else input.maxLength=max;
  label.append(input);
  return label;
}
const key=location.hash.slice(1);
const storageKey='rdk-vision-classroom-v2:'+key;
const response=await fetch('/course.json?view='+encodeURIComponent(key));
if (!response.ok) throw new Error('课程数据无法读取');
const {plan,resume,revision=0}=await response.json();
const stages=new Map([...plan.schedule,...plan.parallel].map(stage=>[stage.id,stage]));
const runStatus={not_submitted:'待提交',submitted:'已受理',queued:'排队中',running:'后台训练',completed:'训练完成',artifact_ready:'INT8 已就绪',failed:'训练失败',missed:'提交窗口已结束'};
let state={resume:resume??{},anchor:null,manual:false};
let files=[];
let report, updateDialog, timer, lastMinute;
let sessionRevision=revision;
let updates=0;
let updateQueue=Promise.resolve();
let photoSlot;
let photos={};
let blindOrder;
let revealed=false;
let trainingEvidence, boardProof;
let comparisonReadback;
let roboGoStatus={}, roboGoBusy=false, roboGoNote='', lastRoboGoCall=0;
const attachedCameraEvidence=new Map();
const ispPanel=createIspPanel({key,$,element,button,openDialog,field,notify,getBinding:()=>report?.resume.camera,
  pick:(pair,readback)=>{
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos=Object.fromEntries(pair.map((file,index)=>[index?'candidate':'original',{file,url:URL.createObjectURL(file)}]));
    comparisonReadback={label:'候选独立 ISP 回读',hash:readback.hash};
    resetBlindOrder();render();$('comparison').scrollIntoView({block:'nearest'});
  },
});
const preflightPanel=createPreflightPanel({key,$,element,button,notify,getBinding:()=>report?.resume.camera});
const capturePanel=createCapturePanel({key,$,element,button,field,openDialog,notify,
  getBinding:()=>report?.resume.camera,
  attach:entries=>{addCameraFiles(entries);render();notify('已附入相机原件与回执。');},
});
const cameraPanel=createCameraPanel({key,$,element,button,field,openDialog,notify,
  getBinding:()=>report?.resume.camera,
  bind:camera=>save({camera},camera?'已关联本工位相机实验。':'已解除关联。'),
  canRefresh:()=>updates===0,
  attach:entries=>{addCameraFiles(entries);render();notify('已附入本工位成果包。');},
  compare:entries=>{
    addCameraFiles(entries);
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos=Object.fromEntries(entries.map((entry,index)=>[index?'candidate':'original',{
      file:attachedCameraEvidence.get(entry.frame.id).file,url:URL.createObjectURL(entry.file),
    }]));
    const proof=entries[1]?.readback;
    comparisonReadback=proof&&{label:'同帧 ISP 回读',hash:proof.hash};
    resetBlindOrder();render();$('comparison').scrollIntoView({block:'nearest'});
  },
});
const boardPanel=createBoardPanel({key,$,element,button,notify,getReport:()=>report,save,
  attach:(assets,receipt)=>{
    const prior=new Set(boardProof?.fileNames??[]);
    const retained=files.filter(asset=>!prior.has(asset.name));
    const added=[...retained,...assets];
    if(added.length>32||added.reduce((total,file)=>total+file.size,0)>128*1024*1024) throw new Error('成果包最多保存 32 个文件，合计 128 MB。');
    files=added;
    boardProof={receipt,fileNames:assets.map(asset=>asset.name)};
    render();
  },
  compare:(frames,assets,readback)=>{
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos=Object.fromEntries(frames.map((file,index)=>[index?'candidate':'original',{
      file,sha256:assets[index].sha256,url:URL.createObjectURL(file),
    }]));
    comparisonReadback=readback&&{label:'同次 Gamma 曲线回读',hash:readback.actualCurrentCurveSha256};
    resetBlindOrder();render();$('comparison').scrollIntoView({block:'nearest'});
  },
});
try {
  const saved=JSON.parse(localStorage.getItem(storageKey));
  if(saved) {guideCourse(plan,saved.resume);state={...saved,resume:resume??saved.resume};}
} catch {}
const minute=()=>state.anchor!==null?Math.min(180,Math.max(0,Math.floor((Date.now()-state.anchor)/60000))):state.resume.elapsedMinutes;
const formatted=n=>{
  const total=570+n;
  return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');
};
function notify(message) {
  $('notice').textContent=message; $('notice').hidden=false;
  clearTimeout(timer); timer=setTimeout(()=>$('notice').hidden=true,5000);
}
function derive() {
  const time=minute();
  return guideCourse(plan,{...state.resume,...(time!==undefined?{elapsedMinutes:time}:{})});
}
function storeState() {
  try {localStorage.setItem(storageKey,JSON.stringify(state));} catch {}
}
function applySession(result) {
  if (result.revision<sessionRevision || updates>1) return;
  sessionRevision=result.revision;
  state.resume=result.resume;
  storeState();
  render();
}
function publish(patch, clearBlockers=[], replace=false) {
  if (!resume) return;
  updates++;
  updateQueue=updateQueue.then(async()=>{
    const reply=await fetch('/session',{method:'POST',headers:{'Content-Type':'application/json','X-Workshop-Session':key},
      body:JSON.stringify({patch,clearBlockers,replace})});
    if (!reply.ok) throw new Error('session_update_failed');
    applySession(await reply.json());
  }).catch(()=>notify('进度暂存在此窗口。同步失败，可下载进度留存。')).finally(()=>{updates--;cameraPanel.syncBinding();});
}
function save(patch,message='已保存') {
  try {
    const previous=state.resume;
    const time=minute();
    const update={...(time!==undefined?{elapsedMinutes:time}:{}),...patch};
    const next=guideCourse(plan,{...state.resume,...update});
    state.resume=next.resume;
    storeState();
    const changes={...update};
    for (const field of ['evidence','blockers']) {
      if (changes[field]) changes[field]=Object.fromEntries(Object.entries(changes[field]).filter(([k,v])=>previous[field]?.[k]!==v));
    }
    const clearBlockers=patch.blockers?Object.keys(previous.blockers??{}).filter(k=>!Object.hasOwn(patch.blockers,k)):[];
    publish(changes,clearBlockers);
    render();
    if (message) notify(message);
  } catch(error) {
    notify(error.message==='run_receipt_mismatch'?'Run ID 与上次记录不一致，请检查原任务。':error.message==='invalid_detection_results'?
      '推理失败时，请把本次目标检出结果选为「未验证」。':'内容无法保存，请核对必填项和时间。');
    throw error;
  }
}
function openDialog(title,fields,onSave,verb='保存') {
  $('dialog-title').textContent=title;$('dialog-fields').replaceChildren(...fields);
  $('dialog-fields').className='fields';
  $('dialog-save').textContent=verb;
  updateDialog=onSave;
  if(!$('dialog').open) $('dialog').showModal();
}
$('dialog-close').onclick=()=>$('dialog').close();
$('dialog-form').onsubmit=event=>{
  event.preventDefault();
  try { updateDialog(Object.fromEntries(new FormData(event.currentTarget)));$('dialog').close(); }
  catch {}
};
function editEvidence(title,keys,required=true) {
  openDialog(title,keys.map(k=>field(k,labels[k],{value:report.resume.evidence[k],required:required&&k!=='misses_false_positives',placeholder:'回执 ID、文件名、链接或哈希',
    ...(detectionResults[k]?{options:[['','请选择实际结果'],...detectionResults[k].map(value=>[value,value])]}:{})})),data=>{
    save({evidence:{...report.resume.evidence,...Object.fromEntries(Object.entries(data).filter(([,v])=>v.trim()))}});
  });
}
function editRun() {
  const old=report.resume.run??{};
  openDialog('记录原训练任务',[
    field('source','任务来源',{value:old.source??'robogo',options:[['robogo','RoboGO 原 Run'],['external','外部训练']]}),
    field('id','原 Run ID',{value:report.training.id??'',placeholder:'从 RoboGO 的任务详情复制'}),
    field('state','实际状态',{value:old.state??'submitted',options:[['submitted','已受理'],['queued','排队中'],['running','运行中'],['completed','训练完成'],['artifact_ready','INT8 已就绪'],['failed','失败']]}),
    field('receipt','状态回执',{value:old.receipt,placeholder:'Run 链接或对应记录'}),
    field('eta','预计完成于开场后第几分钟（可选）',{type:'number',max:1440,value:old.etaMinute,required:false}),
  ],data=>save({run:{id:data.id.trim(),source:data.source,state:data.state,receipt:data.receipt.trim(),
    ...(minute()!==undefined?{checkedAtMinute:minute()}:{}),...(data.eta!==''?{etaMinute:Number(data.eta)}:{})}}));
}
const roboGoErrors={
  robogo_login_required:'RoboGO 授权已失效，请重新连接。原 Run 和已保存状态仍在。',
  robogo_profile_required:'本工位没有配置课程训练镜像和算力。可打开 RoboGO 的训练页提交，随后绑定原 Run。',
  robogo_profile_invalid:'课程训练配置格式不正确，请助教检查。',
  robogo_tool_rejected:'RoboGO 拒绝了本次请求，请核对任务 ID、镜像、算力和本组权限。',
  robogo_run_name_required:'无法用原 Run ID 找到任务名称。请在「更新原任务状态」中保存 RoboGO 任务详情链接。',
  robogo_run_receipt_invalid:'RoboGO 没有返回可核对的原 Run 状态，保留了上一次记录。',
  robogo_submit_unconfirmed:'暂时无法确认提交结果，请先到 RoboGO 任务列表核对，避免重复提交。',
  robogo_submit_window:'本组提交窗口是 10:15–10:20。请核对课堂进度。',
  robogo_training_step_required:'请先核对并记录课程数据集。',
  robogo_plan_expired:'本次提交预检已过期，请重新核对课程任务。',
  robogo_plan_changed:'该确认页对应的计划已更新，请重新核对后提交。',
  robogo_state_required:'请从 Studio 打开工位，让插件保存提交状态后再提交。',
};
async function roboGo(action,method='POST',confirmationId) {
  const response=await fetch('/robogo/'+action,{method,headers:{'X-Workshop-Session':key,
    ...(confirmationId?{'X-Workshop-Confirmation':confirmationId}:{})}});
  const result=await response.json();
  if(!response.ok) {
    if(result.error==='robogo_login_required') roboGoStatus.connected=false;
    throw new Error(roboGoErrors[result.error]??'暂时无法读取 RoboGO。已保存的状态仍在。');
  }
  return result;
}
async function connectRoboGo() {
  const popup=window.open('about:blank','_blank','popup');
  if(!popup) {notify('请允许这个工作台打开 RoboGO 授权窗口。');return;}
  popup.opener=null;
  try {popup.location.replace((await roboGo('connect')).url);}
  catch(error) {popup.close();notify(error.message);}
}
async function pollRoboGo(force=false) {
  if(!key||roboGoBusy||updates) return;
  roboGoBusy=true;
  try {
    const prior=roboGoStatus;
    roboGoStatus=await roboGo('state','GET');
    if(prior.connected!==roboGoStatus.connected||prior.profileConfigured!==roboGoStatus.profileConfigured||
      prior.uncertainTraining!==roboGoStatus.uncertainTraining||prior.profileIssue!==roboGoStatus.profileIssue) renderRoboGo();
    const run=report?.resume.run;
    const shouldCheck=run?.source==='robogo'&&(force||run.state!=='failed'&&!run.modelSha256);
    if(!roboGoStatus.connected||!shouldCheck||!force&&Date.now()-lastRoboGoCall<20000) return;
    lastRoboGoCall=Date.now();
    const result=await roboGo('refresh');
    if(!updates&&result.revision>sessionRevision) applySession(result);
    roboGoNote='已自动核对原 Run · '+new Date().toLocaleTimeString('zh-CN');
  } catch(error) {roboGoNote=error.message;}
  finally {roboGoBusy=false;renderRoboGo();}
}
async function prepareRoboGo() {
  try {
    const {parameters,confirmationId}=await roboGo('prepare');
    openDialog('核对 RoboGO 提交配置',[
      element('p','以下是本次实际发给 RoboGO 的配置。请核对课程数据集、镜像、算力和计费，再确认提交。','action-copy'),
      element('pre',JSON.stringify(parameters,null,2),'robogo-parameters'),
    ],()=>void submitRoboGo(confirmationId),'确认提交一次');
  } catch(error) {notify(error.message);}
}
async function submitRoboGo(confirmationId) {
  try {
    const result=await roboGo('submit','POST',confirmationId);
    if(!updates) applySession(result);
    roboGoNote='RoboGO 已返回原 Run 回执，等待时可继续 ISP。';
  } catch(error) {roboGoNote=error.message;notify(error.message);}
  finally {void pollRoboGo();}
}
function renderRoboGo() {
  const run=report?.resume.run;
  const ownExternal=run?.source==='external';
  const actions=$('robogo-actions');
  actions.replaceChildren();
  const note=$('robogo-note');
  const checks=$('training-readiness');
  note.textContent=ownExternal?'当前工位已使用外部训练回执。':roboGoNote||
    (roboGoStatus.connected?'RoboGO 已授权。登记原 Run 后自动查询状态。':'授权后可在工作台查询原 Run。');
  checks.replaceChildren();
  if(ownExternal) return;
  const datasetReady=steps.data.fields.every(field=>report?.resume.evidence[field]);
  for(const [label,value,ready] of [
    ['课堂数据',datasetReady?'类别、划分与版本已记录':'核对类别顺序、训练与验证划分',datasetReady],
    ['RoboGO',roboGoStatus.connected?'账号已授权':'等待本组授权',roboGoStatus.connected],
    ['训练模板',roboGoStatus.profileConfigured?'已读到本机模板，提交前再核对实际镜像和算力':
      roboGoStatus.profileIssue==='robogo_profile_invalid'?'格式无效，请助教核对模板':'待助教提供训练镜像与本组配置',roboGoStatus.profileConfigured],
  ]) {
    const item=element('div','','preflight-check');
    item.append(element('h3',label),element('span',ready?'已记录':'待核对','status-tag'+(ready?' ok':'')),element('p',value));
    checks.append(item);
  }
  if(!roboGoStatus.connected) actions.append(button('连接 RoboGO',connectRoboGo));
  if(run?.source==='robogo') {
    if(roboGoStatus.connected) actions.append(button('刷新原 Run',()=>pollRoboGo(true)));
    actions.append(roboGoLink(run.name?'https://robogo.d-robotics.cc/train-job/detail/'+run.name:run.receipt));
  }
  const elapsed=report?.resume.elapsedMinutes;
  const insideWindow=elapsed>=plan.deadlines.submitStart&&elapsed<plan.deadlines.submitBy;
  const canCheckSharedImage=insideWindow&&datasetReady&&roboGoStatus.profileConfigured&&
    Boolean(report?.resume.blockers.training_image_unavailable)&&!report?.training.id;
  if((report?.nextStep?.stageId==='train'||canCheckSharedImage)&&!roboGoStatus.uncertainTraining) {
    if(roboGoStatus.connected&&roboGoStatus.profileConfigured) actions.append(button('核对并提交课程训练',prepareRoboGo,'primary'));
    else {
      actions.append(roboGoLink(undefined));
      if(roboGoStatus.connected&&!roboGoStatus.profileConfigured) note.textContent='本工位未配置课程训练模板。可在 RoboGO 网页提交一次，并在这里登记原 Run。';
    }
  }
  if(roboGoStatus.uncertainTraining) {
    note.textContent='上一笔提交结果仍待核对。请在 RoboGO 查找原任务并登记，工作台会查询该 Run。';
    actions.append(roboGoLink(undefined));
  }
}
async function readExternalTraining() {
  try {
    const response=await fetch('/training/receipt',{headers:{'X-Workshop-Session':key}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error==='training_receipt_unconfigured'?'工位还没有配置本组训练回执。已有 RoboGO Run 时，可记录平台上的原任务。':'训练与量化回执格式或绑定错误，请核对出处。');
    const old=report.resume.run;
    if(report.training.id&&old?.source!=='external') throw new Error('本工位已有原 Run，请核对并继续更新原任务。');
    const checkpoint=report.resume.evidence.completed_checkpoint;
    if(checkpoint?.startsWith('sha256:')&&checkpoint!==data.evidence.completed_checkpoint) {
      throw new Error('本次回执的权重与已记录的本组权重不一致，请核对来源。');
    }
    const id=report.training.id??'本组 RTX 训练 · '+data.checkpointSha256.slice(0,12);
    trainingEvidence=data;
    save({run:{id,source:'external',state:'artifact_ready',receipt:'训练与量化回执 sha256:'+data.receiptSha256,
      ...(minute()!==undefined?{checkedAtMinute:minute()}:{} )},evidence:{...report.resume.evidence,
        run_id:id,...data.evidence}},'已读取本组训练与量化回执。');
  } catch(error) {notify(error.message);}
}
function editBlockers() {
  const map={vision_device_transport_failed:'X5 连接失败',dataset_unconfirmed:'数据集待选',training_image_unavailable:'RoboGO 训练资源不可用',
    training_run_failed:'原训练任务失败',ptq_image_unavailable:'PTQ 资源不可用',course_runner_unavailable:'板端执行入口缺失',recovery_unconfirmed:'ISP 恢复待确认'};
  openDialog('更新仍存在的问题',Object.keys(guideSchema.properties.blockers.properties).map(k=>
    field(k,map[k],{required:false,value:report.resume.blockers[k],placeholder:'填写当前回执；已解决则留空'})),
  data=>save({blockers:Object.fromEntries(Object.entries(data).filter(([,v])=>v.trim()))}));
}
function renderComparison() {
  const stage=report.nextStep?.stageId;
  const visible=['gamma_demo','gamma_trial','blind','reproduce'].includes(stage)||Object.keys(photos).length>0;
  $('comparison').hidden=!visible;
  if (!visible) return;
  const blind=stage==='blind'&&!revealed;
  const slots=blind&&blindOrder?blindOrder:['original','candidate'];
  const labels={original:'原始画面',candidate:'调整后的新图'};
  const content=$('comparison-images');
  const actions=$('comparison-actions');
  const ready=Boolean(photos.original&&photos.candidate);
  content.replaceChildren();actions.replaceChildren();
  $('comparison-state').textContent=blind&&ready?'盲选中':ready?'两张图已添加':'等待现场图片';
  $('comparison-help').textContent=blind&&ready?'先选一张并说明理由，再揭晓前后。':
    '从相机工具保存两张现场图。选定同一观察区域，核对实际回读后再判断变化。';
  for (const [index,slot] of slots.entries()) {
    const title=blind&&ready?`画面 ${index+1}`:labels[slot];
    const figure=element('figure','','comparison-frame');
    if (photos[slot]) {
      const image=element('img');image.src=photos[slot].url;image.alt=title;figure.append(image);
    } else figure.append(element('div','等待取图','comparison-placeholder'));
    const caption=element('figcaption',title);
    if (!blind||!ready) caption.append(button(photos[slot]?'更换':'添加图片',()=>{
      photoSlot=slot;$('comparison-file').click();
    },'plain'));
    figure.append(caption);content.append(figure);
  }
  if (ready&&!blind) actions.append(element('small',comparisonReadback?`${comparisonReadback.label} · ${comparisonReadback.hash}`:
    '当前图片未关联同次 ISP 回读。可从相机实验或板端回执重新打开配对实拍。','comparison-readback'));
  if (blind&&ready) actions.append(button('记录选择并揭晓',()=>openDialog('这两张图，你更偏好哪张？',[
    field('choice','画面',{options:[['first','画面 1'],['second','画面 2'],['same','差异不明显']]}),
    field('reason','你看的区域和理由',{placeholder:'例如暗处轮廓更清楚，亮处细节还在',max:210}),
  ],data=>{
    const preference=data.choice==='same'?'差异不明显':labels[blindOrder[data.choice==='first'?0:1]];
    revealed=true;
    save({evidence:{...report.resume.evidence,blind_review:preference+' · '+data.reason.trim()}},'已记录盲选。两张图的身份已揭晓。');
  },'保存并揭晓'),'primary'));
}
function resetBlindOrder() {
  blindOrder=crypto.getRandomValues(new Uint8Array(1))[0]%2?['candidate','original']:['original','candidate'];
  revealed=false;
}
function addCameraFiles(entries) {
  const incoming=entries.filter(entry=>!attachedCameraEvidence.has(entry.frame.id));
  if(files.length+incoming.length>32||files.reduce((total,file)=>total+file.size,0)+incoming.reduce((total,entry)=>total+entry.file.size,0)>128*1024*1024) {
    const error=new Error('成果包最多保存 32 个文件，合计 128 MB。');notify(error.message);throw error;
  }
  for(const entry of incoming) {
    files.push(entry.file);
    attachedCameraEvidence.set(entry.frame.id,entry);
  }
}
$('comparison-file').onchange=event=>{
  const file=event.target.files[0];event.target.value='';
  if (!file||!photoSlot) return;
  const prior=photos[photoSlot];
  const priorIsArchived=prior&&[...attachedCameraEvidence.values()].some(entry=>entry.file===prior.file);
  const retained=prior&&!priorIsArchived?files.filter(item=>item!==prior.file):files;
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)||retained.length>=32||retained.reduce((n,f)=>n+f.size,0)+file.size>128*1024*1024) {
    notify('请选择 PNG、JPG 或 WebP 图片。成果包最多 32 个文件、128 MB。');return;
  }
  if (prior) URL.revokeObjectURL(prior.url);
  photos[photoSlot]={file,url:URL.createObjectURL(file)};
  files=[...retained,file];
  comparisonReadback=undefined;
  resetBlindOrder();
  render();
};
function renderDetection() {
  const path=report.routing.selected;
  const evidence=report.resume.evidence;
  const own=path==='A';
  const stage=report.nextStep?.stageId;
  const prefix=own?'':'preset_';
  const runtime=prefix+'inference_result';
  const target=prefix+'target_result';
  const visible=['live','preset_deploy'].includes(stage)||(path==='A'||path==='B')&&Boolean(evidence[runtime]);
  $('detection').hidden=!visible;
  if (!visible) return;
  $('detection-summary').replaceChildren(...[[path+' · '+(own?'本人模型':'预置模型'),'模型来源'],
    [evidence[runtime]??'待回执','推理是否运行'],[evidence[target]??'待观察','目标是否检出']].map(([value,label])=>{
    const card=element('div');card.append(element('span',label),element('strong',value));return card;
  }));
  const fields=own?['board_model_hash','tuning_in_detection_pipeline','fresh_frames','live_detections']:
    ['preset_board_model_hash','preset_stream_isp','preset_live_frame','preset_live_detections'];
  $('detection-evidence').replaceChildren(...fields.map(key=>element('li',`${labels[key]} · ${evidence[key]??'等待本轮回执'}`)));
  if(evidence.misses_false_positives) $('detection-evidence').append(element('li','现场观察 · '+evidence.misses_false_positives));
  $('detection-actions').replaceChildren(...(evidence[runtime]?[button('复核检测结果',()=>editEvidence('本次检测结果',[runtime,target,'misses_false_positives']),'plain')]:[]));
}
function renderRoutes() {
  const area=$('route');
  area.replaceChildren();
  if (!report.routing.eligible && report.nextStep?.stageId!=='route') return;
  area.append(element('div','A / B / C 完成路径','route-heading'));
  const group=element('div','','routes');
  for(const p of report.routing.choices) {
    const active=report.routing.selected===p.id;
    const box=button('',()=>save({path:p.id},'已选择 '+p.id+' 路径'),'');
    box.className='route-card'+(active?' active':'');
    box.disabled=!p.available;
    box.setAttribute('aria-pressed',String(active));
    box.append(element('strong',p.id+' · '+p.name),element('small',p.description),
      element('small',p.reason));
    if(active||report.routing.recommended===p.id) box.append(element('span',active?'已选择':'当前建议','status-tag'));
    group.append(box);
  }
  area.append(group,backupButton());
}
function backupButton() {
  return button('登记预置模型或演示',()=>editEvidence('登记备用来源',['preset_model','demo_reference'],false));
}
function renderStep() {
  const next=report.nextStep;
  $('step-title').textContent=next?.title??(report.completion.lessonEvidenceComplete?'本工位记录已齐备':'当前记录可交接');
  $('step-help').textContent=next?.instruction??'查看成果包和未完成事项，保留本工位的实际记录。';
  $('step-tag').textContent=next?.kind==='resolve_blocker'?'需要处理':next?.kind==='recovery'?'先恢复设备':next?.kind==='select_path'?'等待选择':next?'进行中':'本轮结果';
  $('step-tag').className='status-tag'+(['resolve_blocker','recovery'].includes(next?.kind)?' blocked':'');
  $('step-tools').hidden=!next?.tool;
  $('tool-chain').textContent=next?.tool??'';
  const slot=$('step-form'), footer=$('step-footer');
  slot.replaceChildren(); footer.replaceChildren();
  const instructions=next?.kind==='action'?steps[next.stageId]?.actions:undefined;
  if (instructions) {
    const list=element('ol','','action-checklist');
    for (const item of instructions) list.append(element('li',item));
    slot.append(list);
  }
  if(next?.requiredEvidence.length) {
    const ul=element('ul','','review-list');
    for(const row of next.requiredEvidence) ul.append(element('li',row.label));
    slot.append(element('div','完成后留下','route-heading'),ul);
    if(!['gamma_demo','gamma_trial'].includes(next.stageId)) {
      footer.append(button('记录本步回执',()=>editEvidence(next.title,next.requiredEvidence.map(x=>x.key)),next.entry?'ghost':'primary'));
    }
  }
  if(next?.entry) footer.prepend(button(next.entry.label,()=>{
    const section=$(next.entry.section);
    if(section.hidden) {notify('此操作还缺本步所需的产物或回执。');return;}
    section.scrollIntoView({behavior:'smooth'});
  },'primary'));
  if(next?.stageId==='connect'&&report.resume.camera) footer.append(button('保存原始 ISP',()=>$('camera-isp').scrollIntoView({behavior:'smooth'}),'ghost'));
  if(next?.stageId==='baseline'&&next.requiredEvidence.some(x=>x.key==='baseline_raw')) {
    footer.append(button('登记 RAW 实采受阻',()=>editEvidence('记录 RAW 样例和实采缺口',['baseline_raw_sample']),'plain'));
  }
  if(['data','check_run','train','break'].includes(next?.stageId)) footer.append(roboGoLink(report.training.source==='robogo'?report.training.receipt:undefined),
    button('记录 RoboGO Run',editRun,next?.stageId==='check_run'?'primary':'ghost'));
  if(next?.stageId==='await_route') footer.append(backupButton());
  if(['resolve_blocker','recovery'].includes(next?.kind)) footer.append(button('更新阻塞回执',editBlockers,'primary'));
  if(next && next.stageId!=='route') footer.append(button('复制给 Studio 助手',async()=>{
    try {await navigator.clipboard.writeText(next.instruction+(next.tool?'\n优先使用实际可用的工具：'+next.tool:'')+'\n请给出本工位真实回执。');notify('已复制本步指令');}
    catch {notify('无法访问剪贴板，可选中文案复制。');}
  },'plain'));
  renderRoutes();
}
function render() {
  report=derive();
  const current=minute();
  lastMinute=current;
  $('clock-value').textContent=current===undefined?'未开始':(state.manual?'彩排 · ':'')+formatted(current);
  const timeline=$('timeline');
  timeline.replaceChildren();
  for(const s of report.stages.filter(s=>stages.has(s.id)&&s.id!=='train'&&s.id!=='wait_run')) {
    const li=element('li','','state-'+s.status);
    if(s.status==='current') li.setAttribute('aria-current','step');
    const item=element('div');
    item.append(element('div',s.topic,'stage-name'),element('span',formatted(s.start)+' – '+formatted(s.end)
      +(s.status==='evidence_recorded'?' · 已留证':s.status==='blocked'?' · 受阻':''),'stage-time'));
    li.append(element('span','','marker'),item); timeline.append(li);
  }
  renderStep();
  cameraPanel.render();
  preflightPanel.syncBinding();
  ispPanel.syncBinding();
  capturePanel.syncBinding();
  renderComparison();
  renderDetection();
  boardPanel.syncModel();boardPanel.render();
  $('training-state').textContent=runStatus[report.training.state]??'待检查';
  $('training-state').className='status-tag'+(['failed','missed'].includes(report.training.state)?' blocked':report.training.state==='artifact_ready'?' ok':'');
  $('training-help').textContent=report.training.instruction;
  $('run-edit').textContent=report.training.id?'更新原任务状态':'记录已有 Run';
  const training=$('training-detail');
  training.replaceChildren();
  if(report.training.id) training.append(element('span',(report.training.source==='external'?'外部训练':report.training.source==='robogo'?'RoboGO 原 Run':'来源待核对')+' · '+report.training.id,'run-ref'),
    button('补充模型与 PTQ 回执',()=>editEvidence('补充本人模型与 PTQ',steps.quantize.fields,false),'plain'));
  if(report.resume.run?.modelSha256) training.append(element('p','原 Run 的 X5 INT8 SHA-256 · '+report.resume.run.modelSha256,'run-ref'));
  if(trainingEvidence?.modelSha256&&report.resume.evidence.x5_model_hash==='sha256:'+trainingEvidence.modelSha256) {
    training.append(element('p',`${trainingEvidence.dataset} · ${trainingEvidence.device} · ${trainingEvidence.epochs}/${trainingEvidence.requestedEpochs} 轮`,'last-checked'));
  }
  if(report.training.checkedAtMinute!==undefined) training.append(element('small','最近核对 · '+formatted(report.training.checkedAtMinute),'last-checked'));
  if(report.training.etaMinute!==undefined) training.append(element('small','预计完成 · '+formatted(report.training.etaMinute),'last-checked'));
  const preflight=$('training-preflight');
  const preflightMessages={due:'11:30 预检到点，请核对原 Run，记录状态和预计完成时间。可以接着做当前 ISP 步骤。',
    checked:'已记录 11:30 预检。继续本工位 ISP 步骤，11:40 开放分流。',
    prepare_backup:'本组产物预计赶不上 11:40，或原任务未受理／失败。现在登记预置模型或讲师演示，11:40 再选路。'};
  preflight.hidden=!report.training.preflight;
  preflight.replaceChildren();
  if(!preflight.hidden) {
    const actions=element('div','','button-row');
    if(report.training.id) actions.append(roboGoLink(report.training.source==='robogo'?report.training.receipt:undefined,'plain'),button('更新原任务状态',editRun));
    if(report.training.preflight==='prepare_backup') actions.append(backupButton());
    preflight.append(element('p',preflightMessages[report.training.preflight]),actions);
  }
  const {submitStart,submitBy,checkpointAt,deployAt}=report.training;
  $('milestones').replaceChildren(...[[formatted(submitStart)+'–'+formatted(submitBy),'分批提交'],
    [formatted(checkpointAt),'助教预检'],[formatted(deployAt),'分流与部署']].map(([time,label])=>{
    const entry=element('div');entry.append(element('strong',time),element('span',label));return entry;
  }));
  $('evidence-count').textContent=Object.keys(report.resume.evidence).length+' 项回执';
  $('delivery-help').textContent=report.completion.lessonEvidenceComplete
    ?'打开下载的文件，检查本工位记录与实际附件。'
    :'可先保存当前记录和实际附件。未完成的环节会写进成果包。';
  const assets=$('attachments');
  assets.replaceChildren(...files.map(file=>element('li',file.name+' · '+Math.round(file.size/1024)+' KB')));
  const review=$('review');
  const summary=element('ul','','review-list');
  for(const [k,v] of Object.entries(report.resume.evidence)) summary.append(element('li',labels[k]+' · '+v));
  review.replaceChildren(button('更新阻塞回执',editBlockers),summary);
  renderRoboGo();
}
$('run-edit').onclick=editRun;
$('read-training').onclick=readExternalTraining;
$('start').onclick=()=>{
  if(state.anchor!==null||state.manual) {notify('课堂已有进度，可用「设定进度」调整彩排时间。');return;}
  state.anchor=Date.now();state.manual=false;
  save({elapsedMinutes:0},'课堂计时已开始');
};
$('clock-config').onclick=()=>openDialog('设定彩排进度',[
  field('minute','开场后经过的分钟（0–180）',{type:'number',max:180,value:minute()??0}),
],data=>{
  const n=Number(data.minute);
  const run=report.resume.run;
  const adjusted=run?.checkedAtMinute!==undefined && run.checkedAtMinute>n
    ?Object.fromEntries(Object.entries(run).filter(([key])=>key!=='checkedAtMinute')):run;
  state.anchor=null;state.manual=true;
  save({elapsedMinutes:n,...(adjusted?{run:adjusted}:{})},'已设定彩排进度');
});
$('import').onclick=()=>$('progress-file').click();
$('progress-file').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';
  if(!file||file.size>1024*1024) {if(file) notify('请选择小于 1 MB 的进度 JSON。');return;}
  try {
    const input=JSON.parse(await file.text());
    const result=guideCourse(plan,input.resume??input);
    state={resume:result.resume,anchor:null,manual:result.resume.elapsedMinutes!==undefined};
    files=[];
    attachedCameraEvidence.clear();
    trainingEvidence=undefined;boardProof=undefined;
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos={};blindOrder=undefined;revealed=false;comparisonReadback=undefined;
    storeState();publish(result.resume,[],true);render();notify('已导入工位进度');
  } catch {notify('无法导入。请选择工作台下载的进度或工具的原始 JSON。');}
};
function download(blob,name) {
  const url=URL.createObjectURL(blob);
  const a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$('resume').onclick=()=>download(new Blob([JSON.stringify({resume:report.resume},null,2)],{type:'application/json'}),'视觉-Pipeline-接续进度.json');
$('attach').onclick=()=>$('evidence-file').click();
$('evidence-file').onchange=event=>{
  const next=[...files,...event.target.files];event.target.value='';
  if(next.length>32||next.reduce((n,f)=>n+f.size,0)>128*1024*1024) {notify('成果包最多添加 32 个文件，总大小 128 MB。');return;}
  files=next;render();
};
$('export').onclick=async()=>{
  const pending=$('export');pending.disabled=true;
  const snapshot=report;
  const comparison=photos.original&&photos.candidate?{...photos,readback:comparisonReadback}:undefined;
  const encode=s=>new TextEncoder().encode(s);
  try {
    const ispEvidence=await ispPanel.evidence();
    const capturedFiles=[...files,...(ispEvidence?.files??[])];
    const artifacts=[],entries=[];
    for(const [i,file] of capturedFiles.entries()) {
      const bytes=new Uint8Array(await file.arrayBuffer());
      const safe=file.name.replace(/[^\p{L}\p{N}. _-]/gu,'_').replace(/^\.+/,'').slice(-96)||'evidence';
      const path='attachments/'+(i+1)+'-'+safe;
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      artifacts.push({path,bytes:bytes.length,sha256});
      entries.push([path,bytes]);
    }
    const cameraEvidence=[...attachedCameraEvidence.values()].map(entry=>({experimentId:entry.experimentId,frame:entry.frame,
      ...(entry.readback?{readback:entry.readback}:{})}));
    const meta={schema:'rdk.vision-workshop-delivery.v1',exportedAt:new Date().toISOString(),generatedFrom:'learner_record',clockMode:state.manual?'rehearsal':'observed_or_unstarted',
      path:snapshot.routing.selected,completion:snapshot.completion,artifacts,resume:snapshot.resume};
    const cameraPreflight=preflightPanel.receipt();
    if(cameraPreflight) meta.cameraPreflight=cameraPreflight;
    if(ispEvidence) meta.ispSession=ispEvidence.receipt;
    if(cameraEvidence.length) meta.cameraEvidence=cameraEvidence;
    if(trainingEvidence?.modelSha256&&snapshot.resume.evidence.x5_model_hash==='sha256:'+trainingEvidence.modelSha256) meta.trainingEvidence=trainingEvidence;
    if(boardProof) meta.boardEvidence=boardProof.receipt;
    if(comparison) {
      const findPhoto=photo=>artifacts[capturedFiles.indexOf(photo.file)]?.path??artifacts.find(item=>item.sha256===photo.sha256)?.path;
      const original=findPhoto(comparison.original);
      const candidate=findPhoto(comparison.candidate);
      if(original&&candidate) meta.gammaComparison={original,candidate,readback:comparison.readback??null};
    }
    const notes=['# 视觉 Pipeline 个人手册','','完成路径 · '+(meta.path??'待选择'),
      '课程记录 · '+(snapshot.completion.lessonEvidenceComplete?'本工位出具了所需回执':'还有待完成项'),
      '实际附件 · '+artifacts.length,'','## Gamma 两轮记录','',
      ...(meta.ispSession?.rounds??[]).map(round=>'- 第 '+round.number+' 轮 · '+(round.goal??'旧版记录')+' · '+
        (round.decision?(round.decision.choice==='keep'?'保留调整':'恢复原值')+' · '+round.decision.reason:'待记录取舍')),
      '','## 已有回执','',
      ...Object.entries(snapshot.resume.evidence).map(([k,v])=>'- '+labels[k]+'：'+v),
      '','## 待完成与阻塞','',...snapshot.completion.unfinished.map(v=>'- '+v),
      ...Object.values(snapshot.resume.blockers).map(v=>'- '+v),
      ...(snapshot.nextStep?['- 下一步：'+snapshot.nextStep.instruction]:[]),''];
    download(storedZip([['manifest.json',encode(JSON.stringify(meta,null,2))],
      ['resume.json',encode(JSON.stringify({resume:snapshot.resume},null,2))],
      ['handbook.md',encode(notes.join('\n'))],...entries]),'视觉-Pipeline-个人成果.zip');
    notify('已生成成果包。请打开 ZIP 核对文件。');
  } catch {notify('成果包生成失败，请检查附件。');}
  finally {pending.disabled=false;}
};
render();
void renderIspDemo({$,element,button});
cameraPanel.syncBinding();
void pollRoboGo();
setInterval(()=>void pollRoboGo(),4000);
setInterval(()=>{
  if(minute()!==lastMinute&&!$('dialog').open) {
    if(state.anchor!==null) save({elapsedMinutes:minute()},null);
    else render();
  }
},5000);
if(resume) setInterval(async()=>{
  if(updates) return;
  try {
    const response=await fetch('/session',{headers:{'X-Workshop-Session':key}});
    if(!response.ok) return;
    const result=await response.json();
    if(!updates&&result.revision>sessionRevision) {applySession(result);cameraPanel.syncBinding();}
  } catch {}
},2000);
setInterval(cameraPanel.poll,3500);
setInterval(capturePanel.poll,1800);
setInterval(preflightPanel.poll,1800);
setInterval(ispPanel.poll,1800);
const initialPanel=new URLSearchParams(location.search).get('panel');
if(['capture','preflight','isp'].includes(initialPanel)) $('camera-'+initialPanel).scrollIntoView();
setInterval(boardPanel.poll,1800);
