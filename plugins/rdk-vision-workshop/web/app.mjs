import { classroomClock, detectionResults, guideCourse, guideSchema, normalizedModelHash, presetModelHash } from '/guide.mjs';
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
window.addEventListener('hashchange',()=>location.reload());
const storageKey='rdk-vision-classroom-v2:'+key;
function startupIssue(title, detail, retry=false) {
  const card=element('section','','box');
  card.setAttribute('role','alert');
  card.append(element('h1',title),element('p',detail,'action-copy'));
  if(retry) card.append(button('重新读取',()=>location.reload(),'primary'));
  document.querySelector('main').replaceChildren(card);
  document.querySelector('.top-actions').remove();
}
async function loadCourse() {
  if(!key) {
    startupIssue('课堂链接缺少工位会话','回到 RDK Studio，在当前学员对话重新打开课堂工作台。复制到浏览器时，请复制包含 # 后面内容的完整链接。');
    return;
  }
  try {
    const response=await fetch('/course.json?view='+encodeURIComponent(key),{signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error('course_unavailable');
    const course=await response.json();
    if(!Array.isArray(course.plan?.schedule)||!Array.isArray(course.plan?.parallel)) throw new Error('course_invalid');
    if(!course.resume) {
      startupIssue('工位链接已失效','回到 RDK Studio，从当前学员对话重新打开课堂工作台，使用新打开的地址。');
      return;
    }
    return course;
  } catch {
    startupIssue('课堂数据暂时无法读取','确认 RDK Studio 仍在运行，再点“重新读取”。如果仍打不开，请从学员对话重新打开课堂工作台。',true);
  }
}
const course=await loadCourse();
if(course) startClassroom(course);

function startClassroom({plan,resume,revision=0,practiceReturnUrl,stationKind,lastStation,stationActive,developerMachine}) {
const direct=plan.training.workflow==='devmachine';
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
let routeExpanded=false;
let trainingEvidence, boardProof;
let comparisonReadback;
let roboGoStatus={}, roboGoBusy=false, roboGoNote='', lastRoboGoCall=0;
const attachedCameraEvidence=new Map();
const toolPanels=Array.from($('tool-panels').children).filter(panel=>!practiceReturnUrl||panel.id!=='isp-demo');
const activePanels={
  connect:['camera-preflight','camera'],
  baseline:['camera-capture'],formats:['camera-capture'],
  deploy:['board'],live:['board'],preset_deploy:['board'],
};
const wide=matchMedia('(min-width: 1000px)');
function syncTimeline() { $('timeline').parentElement.open=wide.matches; }
wide.addEventListener('change',syncTimeline);
syncTimeline();
function showPanel(id) {
  const panel=$(id);
  if(panel.hidden) {notify('此操作还缺本步所需的产物或回执。');return;}
  if($('tool-panels').contains(panel)) $('station-tools').open=true;
  const title=panel.querySelector('h2,summary')??panel;
  title.tabIndex=-1;
  title.focus({preventScroll:true});
  panel.scrollIntoView({block:'start'});
}
function compareFrames(frames) {
  const controls=['frame-scale','frame-x','frame-y'].map($);
  [controls[0].value,controls[1].value,controls[2].value]=['1','50','50'];
  $('frame-dialog-images').replaceChildren(...frames.map(({src,label})=>{
    const figure=element('figure','','comparison-frame');
    const view=element('div','','zoom-photo');
    const image=element('img');image.src=src;image.alt=label;
    view.append(image);figure.append(view,element('figcaption',label));
    return figure;
  }));
  const zoom=()=>{
    const [scale,x,y]=controls.map(control=>control.valueAsNumber);
    $('frame-scale-value').textContent=scale+'×';
    controls[1].disabled=controls[2].disabled=scale===1;
    for(const image of $('frame-dialog-images').querySelectorAll('img')) {
      image.style.transformOrigin=x+'% '+y+'%';
      image.style.transform='scale('+scale+')';
    }
  };
  for(const control of controls) control.oninput=zoom;
  zoom();
  $('frame-dialog').showModal();
}
const pageParams=new URLSearchParams(location.search);
const initialPanel=pageParams.get('panel');
const ispPanel=createIspPanel({key,$,element,button,openDialog,field,notify,getBinding:()=>report?.resume.camera,
  compareFrames,onEvidenceChange:renderDeliveryChecklist,initialRound:initialPanel==='isp'?Number(pageParams.get('round')):null,
  pick:(pair,readback)=>{
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos=Object.fromEntries(pair.map((file,index)=>[index?'candidate':'original',{file,url:URL.createObjectURL(file)}]));
    comparisonReadback={label:'候选独立 ISP 回读',hash:readback.hash};
    resetBlindOrder();render();showPanel('comparison');
  },
});
const preflightPanel=createPreflightPanel({key,$,element,button,notify,showCamera:()=>showPanel('camera'),getBinding:()=>report?.resume.camera});
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
    resetBlindOrder();render();showPanel('comparison');
  },
});
const boardPanel=createBoardPanel({key,$,element,button,notify,getReport:()=>report,save,
  attach:(assets,receipt)=>{
    const prior=new Set(boardProof?.fileNames??[]);
    const retained=files.filter(asset=>!prior.has(asset.name));
    const added=[...retained,...assets];
    if(added.length>32||added.reduce((total,file)=>total+file.size,0)>128*1024*1024) throw new Error('成果包最多保存 32 个文件，合计 128 MB。');
    files=added;
    boardProof={receipt,path:report.routing.selected,fileNames:assets.map(asset=>asset.name)};
    render();
  },
  compare:(frames,assets,readback)=>{
    for(const photo of Object.values(photos)) URL.revokeObjectURL(photo.url);
    photos=Object.fromEntries(frames.map((file,index)=>[index?'candidate':'original',{
      file,sha256:assets[index].sha256,url:URL.createObjectURL(file),
    }]));
    comparisonReadback=readback&&{label:'同次 Gamma 曲线回读',hash:readback.actualCurrentCurveSha256};
    resetBlindOrder();render();showPanel('comparison');
  },
});
try {
  const saved=JSON.parse(localStorage.getItem(storageKey));
  if(saved) {guideCourse(plan,saved.resume);state={...saved,resume:resume??saved.resume};}
} catch {}
const minute=()=>state.anchor!==null?Math.min(180,Math.max(0,Math.floor((Date.now()-state.anchor)/60000))):state.resume.elapsedMinutes;
let entryDismissed=false;
function renderEntryChoice() {
  const choice=$('entry-choice');
  const time=minute();
  const {camera,evidence,run,path}=report.resume;
  const hasProgress=time!==undefined||camera||run||path||Object.keys(evidence).length>0;
  choice.hidden=!practiceReturnUrl&&entryDismissed&&stationActive!==false;
  if(choice.hidden) return;
  $('entry-title').textContent=practiceReturnUrl?'ISP 案例练习':hasProgress?'已有课堂工位':'进入课堂';
  $('entry-summary').textContent=practiceReturnUrl?'选一项参数，比对归档画面和回读，写下观察后下载记录。':
    stationActive===false?'此页面是已切出的工位，可以查看之前的记录。需要操作时请打开当前工位。':
    hasProgress?'当前步骤 · '+(report.nextStep?.title??'核对成果包')+'。案例练习单独保存。':
    stationKind==='fresh'?'从提交准备开始。同组已有训练时，先记录原 Run 继续。':'进入本组工位开始实操，也可以先用课程案例练习看图。';
  $('entry-continue').textContent=practiceReturnUrl?'返回原工位':hasProgress?'继续工位'+(time===undefined?'':' · '+formatted(time)):'开始工位实操';
  if(stationActive===false) $('entry-continue').textContent='打开当前工位';
  $('entry-station').hidden=!stationKind||stationActive===false||stationKind==='original'&&!hasProgress;
  $('entry-station').textContent=stationKind==='fresh'?'返回原工位':'新建空白工位';
  $('entry-last-station').hidden=!lastStation||stationKind!=='original'||stationActive===false;
  $('entry-practice').hidden=Boolean(practiceReturnUrl);
  $('entry-practice').textContent='进入案例练习';
}
$('entry-continue').onclick=()=>{
  if(practiceReturnUrl) {location.assign(practiceReturnUrl);return;}
  if(stationActive===false) {void changeStation('active',$('entry-continue'));return;}
  entryDismissed=true;
  renderEntryChoice();
  showPanel('step-title');
};
async function changeStation(action,control) {
  control.disabled=true;
  try {
    const response=await fetch('/station/'+action,{method:action==='active'?'GET':'POST',headers:{'X-Workshop-Session':key}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error);
    location.assign(data.url);
  } catch(error) {
    notify(error.message==='station_busy'?'请等训练提交确认，完成检测或相机恢复后再切换。':
      '工位暂时无法切换，请刷新后重试。原有记录已保留。');
    control.disabled=false;
  }
}
$('entry-station').onclick=()=>{
  if(stationKind==='fresh') {void changeStation('original',$('entry-station'));return;}
  openDialog('新建空白工位',[
    element('p','课堂计时、实验记录和训练绑定从第一步开始。原工位记录可随时回看。同组已有训练任务时，请在新工位记录原 Run。'),
  ],()=>{void changeStation('new',$('entry-station'));},'新建工位');
};
$('entry-last-station').onclick=()=>void changeStation('latest',$('entry-last-station'));
const stationLink=$('station-link');
stationLink.hidden=!key||Boolean(practiceReturnUrl);
stationLink.onclick=()=>{
  const link=new URL('/',location.href);
  link.hash=location.hash;
  const field=element('label','本机浏览器地址','field');
  const address=element('input');
  address.type='url';
  address.value=link.href;
  address.readOnly=true;
  field.append(address);
  const tip=element('p','复制完整地址，在这台电脑的浏览器粘贴打开。');
  openDialog('当前工位链接',[tip,field],()=>{});
  $('dialog-save').textContent='关闭';
  address.focus();
  address.select();
};
$('entry-practice').onclick=async()=>{
  const control=$('entry-practice');
  control.disabled=true;
  try {
    const result=await fetch('/practice',{method:'POST',headers:{'X-Workshop-Session':key}});
    if(!result.ok) throw new Error('practice_unavailable');
    const {url}=await result.json();
    location.assign(url);
  } catch {
    notify('独立练习暂时打不开。可重试，或继续原工位。');
    control.disabled=false;
  }
};
const formatted=n=>{
  return classroomClock(plan,n);
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
  const source=old.source??(direct?'external':'robogo');
  openDialog('记录原训练任务',[
    ...(!direct?[field('source','任务来源',{value:source,options:[['robogo','RoboGO 原 Run'],['external','外部训练']]})]:[]),
    field('id','原任务 ID',{value:report.training.id??'',placeholder:direct?'从本组任务回执或启动日志复制':'从 RoboGO 的任务详情复制'}),
    field('state','实际状态',{value:old.state??'submitted',options:[['submitted','已受理'],['queued','排队中'],['running','运行中'],['completed','训练完成'],['artifact_ready','INT8 已就绪'],['failed','失败']]}),
    field('receipt','状态回执',{value:old.receipt,placeholder:'Run 链接或对应记录'}),
    field('eta','预计完成于开场后第几分钟（可选）',{type:'number',max:1440,value:old.etaMinute,required:false}),
  ],data=>save({run:{id:data.id.trim(),source:data.source??source,state:data.state,receipt:data.receipt.trim(),
    ...(minute()!==undefined?{checkedAtMinute:minute()}:{}),...(data.eta!==''?{etaMinute:Number(data.eta)}:{})}}));
}
const roboGoErrors={
  robogo_login_required:'RoboGO 授权已失效，请重新连接。原 Run 和已保存状态仍在。',
  robogo_profile_required:'本工位没有配置课程训练镜像和算力。可在 RoboGO 核对已有任务并绑定原 Run。',
  robogo_other_station_run:'这台电脑的另一工位已有 RoboGO 提交记录。请找回原 Run 并在此绑定。',
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
  finally {roboGoBusy=false;renderRoboGo();renderParallelTraining();}
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
  $('training-title').textContent=direct?'本组开发机与模型产物':'训练与量化进度';
  if(direct) {
    checks.replaceChildren();
    const ready=developerMachine?.status==='ready';
    note.textContent=run?'继续核对原任务日志与产物。':
      ready?'按本组连接卡准备。到 '+formatted(plan.deadlines.submitStart)+' 只启动一次。':
        '本组开发机连接卡'+(developerMachine?.status==='invalid'?'格式有误':'尚未配置')+'。请向助教报组号，先做相机和 ISP。';
    if(ready) {
      for(const [label,key] of [['连接方式','connection'],['课程数据','dataset'],['启动命令','startCommand'],
        ['训练日志','logPath'],['ONNX／INT8 位置','artifactPath']]) {
        const card=element('div','','preflight-check');
        card.append(element('h3',label),element('code',developerMachine[key],'station-command'));
        checks.append(card);
      }
    }
    actions.append(button(run?'更新原任务状态':'登记已有任务',editRun));
    if(run?.source==='robogo') {
      actions.append(roboGoLink(run.receipt));
      if(roboGoStatus.connected) actions.append(button('刷新原 RoboGO Run',()=>pollRoboGo(true)));
      else actions.append(button('授权查询原 RoboGO Run',connectRoboGo));
    }
    return;
  }
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
  if(!run&&roboGoStatus.otherStationTraining) {
    const previous=roboGoStatus.otherStationTraining;
    note.textContent=previous.runId?'另一工位已有原 Run '+previous.runId+'。请登记该任务继续。':
      '另一工位的训练提交待确认。请在 RoboGO 找到原任务，再登记 Run。';
    actions.append(button('登记原 Run',editRun,'primary'),roboGoLink(undefined));
    return;
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
    if(data.error==='training_receipt_task_unverified') throw new Error('请先登记本组原任务。回执须包含相同任务 ID，再读取训练与 PTQ。');
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
    devmachine_unavailable:'本组开发机或数据未就绪',
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
  if(ready) actions.append(button('放大同一区域',()=>compareFrames(slots.map((slot,index)=>({
    src:photos[slot].url,label:blind?`画面 ${index+1}`:labels[slot],
  }))),'ghost'));
  if(ready&&!blind) {
    if(comparisonReadback) {
      const proof=element('details','','proof-details');
      proof.append(element('summary','已关联 ISP 回读'),element('code',comparisonReadback.hash,'comparison-readback'));
      actions.append(proof);
    } else actions.append(element('small','当前图片未关联同次 ISP 回读。可从相机实验或板端回执重新打开配对实拍。','comparison-readback'));
  }
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
  $('detection-summary').replaceChildren(...[[path+' · '+(own?'本组':'预置'),'模型来源'],
    [evidence[runtime]??'待回执','推理是否运行'],[evidence[target]??'待观察','目标是否检出']].map(([value,label])=>{
    const card=element('div');card.append(element('span',label),element('strong',value));return card;
  }));
  const fields=own?['board_model_hash','tuning_in_detection_pipeline','fresh_frames','live_detections']:
    ['preset_board_model_hash','preset_stream_isp','preset_live_frame','preset_live_detections'];
  $('detection-evidence').replaceChildren(...fields.map(key=>element('li',`${labels[key]} · ${evidence[key]??'等待本轮回执'}`)));
  if(evidence[target]&&evidence[target]!=='未验证'&&evidence.misses_false_positives) {
    $('detection-evidence').append(element('li','现场观察 · '+evidence.misses_false_positives));
  }
  const proof=boardProof?.path===path?boardProof:undefined;
  const frame=proof?.receipt.latestDetection;
  const validFrame=frame&&proof.fileNames.includes('板端-'+frame.file);
  $('detection-actions').replaceChildren(...(validFrame?
    [button('记录本帧目标结果',()=>openDialog('记录本帧目标结果',[
      element('p','核对已留证的板端帧 · SDK '+frame.sdkTimestampNs),
      field('label','观察类别',{options:[['','请选择观察类别'],['park','park'],['qrcode','qrcode'],['obstacle','obstacle']]}),
      field('answer','目标是否检出',{options:[['未验证','未验证'],['检出','检出'],['未检出','未检出']]}),
      field('note','观察依据',{max:180,placeholder:'例如目标完整入镜，框覆盖了目标'}),
    ],({label,answer,note})=>{
      if(boardProof!==proof||report.routing.selected!==path) {
        notify('板端回执已变，请打开当前实拍后记录。');throw new Error('board_receipt_changed');
      }
      save({evidence:{...report.resume.evidence,[target]:answer,
        misses_false_positives:label+' · SDK '+frame.sdkTimestampNs+' · '+note.trim()}},'已保存目标判定');
    }),'primary')]:evidence[runtime]?
    [button('复核检测结果',()=>editEvidence('本次检测结果',[runtime,target,'misses_false_positives']),'plain')]:[]));
}
function renderRoutes() {
  const area=$('route');
  area.replaceChildren();
  if (!report.routing.eligible && report.nextStep?.stageId!=='route') return;
  const chosen=report.routing.choices.find(path=>path.id===report.routing.selected);
  const chooser=report.nextStep?.stageId==='route'||!chosen?area:element('details','','proof-details route-review');
  if(chooser!==area) {
    chooser.open=routeExpanded;
    chooser.ontoggle=()=>{if(chooser.isConnected) routeExpanded=chooser.open;};
    chooser.append(element('summary','已选 '+chosen.id+' · '+chosen.name+' · 查看其他路径'));
    area.append(chooser);
  }
  const group=element('div','','routes');
  for(const p of report.routing.choices) {
    const active=report.routing.selected===p.id;
    const box=button('',()=>{
      routeExpanded=false;
      save({path:p.id},'已选择 '+p.id+' 路径');
    },'');
    box.className='route-card'+(active?' active':'');
    box.disabled=!p.available;
    box.setAttribute('aria-pressed',String(active));
    box.append(element('strong',p.id+' · '+p.name),element('small',p.description),
      element('small',p.reason));
    if(active||report.routing.recommended===p.id) box.append(element('span',active?'已选择':'当前建议','status-tag'));
    group.append(box);
  }
  chooser.append(group,backupButton());
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
  const instructions=next?.kind==='action'?next.actions??steps[next.stageId]?.actions:undefined;
  if (instructions) {
    const list=element('ol','','action-checklist');
    for (const item of instructions) list.append(element('li',item));
    slot.append(list);
  }
  if(next?.requiredEvidence.length) {
    const ul=element('ul','','review-list');
    for(const row of next.requiredEvidence) ul.append(element('li',row.label));
    slot.append(element('div','完成后留下','route-heading'),ul);
    if(!next.actions&&!['gamma_demo','gamma_trial'].includes(next.stageId)) {
      footer.append(button('记录本步回执',()=>editEvidence(next.title,next.requiredEvidence.map(x=>x.key)),next.entry?'ghost':'primary'));
    }
  }
  if(next?.entry) footer.prepend(button(next.entry.label,()=>showPanel(next.entry.section),'plain'));
  if(next?.stageId==='connect'&&report.resume.camera) footer.append(button('定位原始 ISP',()=>showPanel('camera-isp'),'plain'));
  if(next?.stageId==='baseline'&&next.requiredEvidence.some(x=>x.key==='baseline_raw')) {
    footer.append(button('登记 RAW 实采受阻',()=>editEvidence('记录 RAW 样例和实采缺口',['baseline_raw_sample']),'plain'));
  }
  if(['data','check_run','train','break'].includes(next?.stageId)) {
    if(!direct) footer.append(roboGoLink(report.training.source==='robogo'?report.training.receipt:undefined));
    if(!direct||next.stageId!=='data') footer.append(button(direct?'记录原任务':'记录 RoboGO Run',editRun,next.stageId==='check_run'?'primary':'ghost'));
  }
  if(['data','train'].includes(next?.stageId)&&!report.training.id&&!roboGoStatus.uncertainTraining) {
    footer.append(button(direct?'入口未就绪，继续 ISP':'跳过本组训练',()=>openDialog('先继续相机与 ISP',[
      element('p','继续相机和 ISP 步骤。到分流时，可使用课程预置模型或记录讲师演示。'),
    ],()=>save({blockers:{[direct?'devmachine_unavailable':'training_image_unavailable']:'本组暂缓启动训练，分流时按实际产物选择。'}},
      '已跳过训练，继续当前课堂步骤'),'跳过训练'),'plain'));
  }
  if(next?.stageId==='await_route') footer.append(backupButton());
  if(['resolve_blocker','recovery'].includes(next?.kind)) footer.append(button('更新阻塞回执',editBlockers,'primary'));
  if(next && next.stageId!=='route') footer.append(button('复制给 Studio 助手',async()=>{
    try {await navigator.clipboard.writeText(next.instruction+(next.tool?'\n优先使用实际可用的工具：'+next.tool:'')+'\n请给出本工位真实回执。');notify('已复制本步指令');}
    catch {notify('无法访问剪贴板，可选中文案复制。');}
  },'plain'));
  renderRoutes();
}
function renderWorkspace() {
  const next=report.nextStep;
  const primary=$('step-workspace');
  const tools=$('tool-panels');
  const selected=[...(activePanels[next?.stageId]??(next?.entry?[next.entry.section]:next?[]:['delivery']))];
  if(next?.stageId==='connect'&&report.resume.camera) selected.push('camera-capture','camera-isp');
  if(selected.includes('camera-capture')&&!report.resume.camera) selected.unshift('camera');
  for(const panel of toolPanels) {
    if(selected.includes(panel.id)) continue;
    const following=toolPanels.slice(toolPanels.indexOf(panel)+1).find(item=>item.parentElement===tools);
    if(panel.parentElement!==tools) tools.insertBefore(panel,following??null);
  }
  for(const [index,id] of selected.entries()) {
    const panel=$(id);
    if(primary.children[index]!==panel) primary.insertBefore(panel,primary.children[index]??null);
  }
  primary.classList.toggle('connect-panels',next?.stageId==='connect');
  $('isp-title').textContent=next?.stageId==='connect'?'保存期初 ISP':'ISP 调参 · 两轮 Gamma 与单项练习';
}
function renderParallelTraining() {
  const training=report?.training;
  if(!training) return;
  const elapsed=report.resume.elapsedMinutes;
  const panel=$('parallel-training');
  panel.hidden=Boolean(practiceReturnUrl)||!training.id||!['submitted','queued','running'].includes(training.state);
  if(panel.hidden) return;
  $('parallel-training-title').textContent=(training.id?'RoboGO 原 Run':'RoboGO 训练')+' · '+(runStatus[training.state]??'待核对');
  if(training.source==='external') $('parallel-training-title').textContent=(direct?'本组开发机任务':'本组外部训练')+' · '+(runStatus[training.state]??'待核对');
  const last=training.checkedAtMinute===undefined?'': '最近核对 '+formatted(training.checkedAtMinute);
  const cutoff=elapsed>=training.deployAt?'已到分流时间':'部署分流 '+formatted(training.deployAt);
  $('parallel-training-detail').textContent=[roboGoNote||last,cutoff].filter(Boolean).join(' · ');
  $('parallel-training-open').textContent=training.id?'查看训练与量化':'查看训练条件';
  $('parallel-training-isp').hidden=!(training.id&&['submitted','queued','running'].includes(training.state));
}
function renderDeliveryChecklist() {
  if(!report) return;
  const summary=ispPanel.evidenceIndex();
  const path=report.routing.selected;
  const {evidence}=report.resume;
  const target=path==='B'?evidence.preset_target_result:evidence.target_result;
  const model=path==='B'?presetModelHash(evidence.preset_model):normalizedModelHash(evidence.x5_model_hash);
  const currentProof=Boolean(model&&boardProof?.receipt.modelSha256===model&&
    (path==='A'||path==='B')&&boardProof.path===path);
  const demoRecorded=Boolean(path==='C'&&evidence.demo_reference);
  const demoWithoutDevice=Boolean(path==='C'&&!evidence.original_snapshot&&evidence.device_unused);
  const rows=[
    ...(path!=='C'||evidence.original_snapshot||summary.rounds?[['两轮 Gamma 实拍与回读',summary.rounds===2,summary.rounds+' / 2 轮已齐备']]:[]),
    [path==='C'?'讲师演示':'板端检测',demoRecorded||Boolean(currentProof&&target&&target!=='未验证'),path==='C'?
      (demoRecorded?'已记录演示来源':'等待演示来源'):currentProof?
        (target&&target!=='未验证'?target:'已有板端回执，待记录目标判定'):'等待本工位板端回执'],
    ['期初 ISP 恢复与停流',summary.restored||Boolean(evidence.restoration_and_release)||demoWithoutDevice,
      summary.restored?'独立回读一致，已停止采流':evidence.restoration_and_release?'已登记恢复回执':
        demoWithoutDevice?'已记录本工位未启用设备':'等待恢复与停流回执'],
  ];
  $('delivery-checklist').replaceChildren(...rows.map(([title,complete,detail])=>{
    const row=element('li');
    row.append(element('strong',title),element('span',detail,complete?'evidence-ready':''));
    return row;
  }));
}
function render() {
  report=derive();
  const current=minute();
  lastMinute=current;
  $('clock-value').textContent=current===undefined?'未开始':(state.manual?'彩排 · ':'')+formatted(current);
  $('start').textContent=state.anchor!==null?'计时中':current===undefined?'开始计时':'继续计时';
  $('start').disabled=state.anchor!==null||state.manual;
  const currentStage=report.stages.find(stage=>stage.status==='current');
  $('timeline-summary').textContent=currentStage?'课堂流程 · '+currentStage.topic:'课堂流程';
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
  renderEntryChoice();
  renderWorkspace();
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
  const cutoff=formatted(plan.deadlines.deployAt);
  const checkpoint=formatted(plan.deadlines.runCheckpoint);
  const preflightMessages={due:checkpoint+' 预检到点，请核对原任务，记录状态和预计完成时间。可以接着做当前 ISP。',
    checked:'已记录 '+checkpoint+' 预查。继续本工位 ISP，'+cutoff+' 开放分流。',
    prepare_backup:'本组产物预计赶不上 '+cutoff+'，或原任务未受理／失败。现在登记预置模型或讲师演示。'};
  preflight.hidden=!report.training.preflight;
  preflight.replaceChildren();
  if(!preflight.hidden) {
    const actions=element('div','','button-row');
    if(report.training.id) {
      if(!direct||report.training.source==='robogo') actions.append(roboGoLink(report.training.receipt,'plain'));
      actions.append(button('更新原任务状态',editRun));
    }
    if(report.training.preflight==='prepare_backup') actions.append(backupButton());
    preflight.append(element('p',preflightMessages[report.training.preflight]),actions);
  }
  const {submitStart,submitBy,checkpointAt,deployAt}=report.training;
  $('milestones').replaceChildren(...[[formatted(submitStart)+'–'+formatted(submitBy),direct?'启动一次':'分批提交'],
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
  renderParallelTraining();
  renderDeliveryChecklist();
}
$('parallel-training-open').onclick=()=>showPanel('training');
$('parallel-training-isp').onclick=()=>showPanel(report.resume.camera?'camera-isp':'camera');
$('run-edit').onclick=editRun;
$('read-training').onclick=readExternalTraining;
$('start').onclick=()=>{
  if(state.anchor!==null||state.manual) return;
  const elapsed=minute()??0;
  state.anchor=Date.now()-elapsed*60000;
  save({elapsedMinutes:elapsed},elapsed?'课堂计时已继续':'课堂计时已开始');
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
    const meta={schema:'rdk.vision-workshop-delivery.v1',exportedAt:new Date().toISOString(),generatedFrom:practiceReturnUrl?'classroom_practice':'learner_record',clockMode:state.manual?'rehearsal':'observed_or_unstarted',
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
      ...(meta.ispSession?.adjustments?.length?['','## 学员单项 ISP 实验','',
        ...meta.ispSession.adjustments.map(item=>'- 第 '+item.number+' 次 · '+item.label+' · '+
          (item.after?item.beforeValue+' → '+item.afterValue+' '+item.unit:'实拍或回读待补')+' · '+
          (item.decision?(item.decision.choice==='keep'?'保留':'恢复')+'：'+item.decision.reason:'取舍待记录')+
          (item.restorationReadback?' · 恢复已回读':''))]:[]),
      ...(meta.ispSession?.exposure?.after?['','## 讲师现场曝光对照','',
        '- 曝光时间 · '+(meta.ispSession.exposure.beforeUs/1000).toFixed(3)+' ms → '+(meta.ispSession.exposure.afterUs/1000).toFixed(3)+' ms',
        '- 模拟增益 · '+meta.ispSession.exposure.gain.toFixed(3)+'×',
        '- 期初 ISP · '+(meta.ispSession.exposure.restorationReadback?'回读已核对':'待恢复核对')]:[]),
      '','## 已有回执','',
      ...Object.entries(snapshot.resume.evidence).map(([k,v])=>'- '+labels[k]+'：'+v),
      '','## 待完成与阻塞','',...snapshot.completion.unfinished.map(v=>'- '+v),
      ...Object.values(snapshot.resume.blockers).map(v=>'- '+v),
      ...(snapshot.nextStep?['- 下一步：'+snapshot.nextStep.instruction]:[]),''];
    download(storedZip([['manifest.json',encode(JSON.stringify(meta,null,2))],
      ['resume.json',encode(JSON.stringify({resume:snapshot.resume},null,2))],
      ['handbook.md',encode(notes.join('\n'))],...entries]),practiceReturnUrl?'视觉-Pipeline-练习成果.zip':'视觉-Pipeline-个人成果.zip');
    notify('已生成成果包。请打开 ZIP 核对文件。');
  } catch {notify('成果包生成失败，请检查附件。');}
  finally {pending.disabled=false;}
};
let practiceSample;
if(practiceReturnUrl) {
  document.body.classList.add('is-practice');
  const content=$('practice-content');
  const demo=$('isp-demo');
  content.hidden=false;
  content.prepend(demo);
  demo.open=true;
  $('isp-demo-title').textContent='选择一项参数';
  const note=$('practice-observation');
  const draftKey=()=>storageKey+':observation:'+practiceSample.title;
  note.oninput=()=>{
    if(!practiceSample) return;
    try {localStorage.setItem(draftKey(),note.value);} catch {}
  };
  $('practice-note').onsubmit=event=>{
    event.preventDefault();
    if(!practiceSample||!note.value.trim()) {note.focus();return;}
    const record={schema:'rdk.isp-case-observation.v1',source:'archived_course_example',
      sample:practiceSample,observation:note.value.trim(),exportedAt:new Date().toISOString()};
    download(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}),'ISP-案例观察记录.json');
  };
  void renderIspDemo({$,element,button,onSelect:sample=>{
    practiceSample=sample;
    note.value='';
    try {note.value=localStorage.getItem(draftKey())??'';} catch {}
    $('practice-export').disabled=false;
  }});
} else {
  void renderIspDemo({$,element,button});
}
render();
cameraPanel.syncBinding();
if(!practiceReturnUrl&&(!direct||state.resume.run?.source==='robogo')) {
  void pollRoboGo();
  setInterval(()=>void pollRoboGo(),4000);
}
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
    if(typeof result.stationActive==='boolean'&&result.stationActive!==stationActive) {
      stationActive=result.stationActive;
      renderEntryChoice();
    }
    if(!updates&&result.revision>sessionRevision) {applySession(result);cameraPanel.syncBinding();}
  } catch {}
},2000);
setInterval(cameraPanel.poll,3500);
setInterval(capturePanel.poll,1800);
setInterval(preflightPanel.poll,1800);
setInterval(ispPanel.poll,1800);
if(['capture','preflight','isp'].includes(initialPanel)) showPanel('camera-'+initialPanel);
if(initialPanel==='board'&&!$('board').hidden) showPanel('board');
setInterval(boardPanel.poll,350);
}
