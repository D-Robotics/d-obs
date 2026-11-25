import { cameraIdPattern, labels, steps, stepEntries } from './steps.mjs';

const cameraId=new RegExp(cameraIdPattern);

const issues = {
  vision_device_transport_failed: { stageId:'connect', message:'X5 未连通。请上电并接上可传数据的 Type-C，或提供可达的局域网地址。', userAction:'接回 X5，或提供板卡的局域网地址。' },
  dataset_unconfirmed: { stageId:'data', message:'需要确定数据集版本和划分。', userAction:'选择课堂数据集，或提供本组标注的目录。' },
  training_image_unavailable: { stageId:'train', message:'RoboGO 训练镜像不可选。让助教检查兑换码、项目和镜像权限，并在提交截止时分流。' },
  devmachine_unavailable: { stageId:'train', message:'本组开发机入口、权限或数据尚未就绪。保留阻塞记录，先做相机和 ISP，到点按产物分流。' },
  training_run_failed: { stageId:'train', message:'原 Run 已失败。保留失败日志，按当前时间和已有产物分流。' },
  ptq_image_unavailable: { stageId:'quantize', message:'量化镜像不可选。让助教检查 X5 工具链或课程预跑产物。' },
  course_runner_unavailable: { stageId:'deploy', message:'当前 runner 无法加载课程模型。需要匹配三类标签和输出头的 X5 运行入口。' },
  recovery_unconfirmed: { stageId:'restore', message:'先核对设备实际状态和恢复账本，再恢复原始 ISP、独立回读并停止采集。' },
};
const paths = [
  { id:'A', name:'本人产物', description:'使用本人训练和量化的模型，在自己的 X5 + IMX415 留下检测画面。' },
  { id:'B', name:'预置产物', description:'记录明确来源的预置模型，完成自己的板端操作，个人训练或 PTQ 保持待完成。' },
  { id:'C', name:'观看演示', description:'记录演示或录像来源与观察，个人板端实操保持待完成。' },
];
const mainCamera = ['connect','baseline','formats','gamma_demo','gamma_trial','blind','reproduce'];
const boardSteps = ['connect','baseline','gamma_demo','gamma_trial','reproduce','deploy','live','preset_deploy'];
const evidenceKey = { type:'string', minLength:1, maxLength:300 };
const modelHashPattern=/^(?:sha256:)?[a-f0-9]{64}$/i;
export const normalizedModelHash=value=>typeof value==='string'&&modelHashPattern.test(value)
  ?value.replace(/^sha256:/i,'').toLowerCase():undefined;
export function presetModelHash(reference) {
  const all=typeof reference==='string'?[...reference.matchAll(/\bsha256:\s*([a-f0-9]{64})(?![a-f0-9])/gi)]:[];
  return all.length===1?all[0][1].toLowerCase():normalizedModelHash(reference?.trim());
}
const validReference = v => typeof v==='string' && v.trim().length>0 && v.length<=300 && !/[\u0000-\u001f\u007f]/u.test(v);
const isObject = v => v!==null && typeof v==='object' && !Array.isArray(v);
const minuteValid = n => Number.isInteger(n) && n>=0 && n<=180;
export function classroomClock(plan, offset) {
  const [hour,minute]=plan.referenceStart.split(':').map(Number);
  const total=hour*60+minute+offset;
  return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');
}
const runStates = ['submitted','queued','running','completed','artifact_ready','failed'];
const inferenceResults=['运行成功','运行失败'];
const targetResults=['检出','未检出','未验证'];
export const detectionResults = { inference_result:inferenceResults, target_result:targetResults,
  preset_inference_result:inferenceResults,preset_target_result:targetResults };

export const guideSchema = {
  type:'object',
  properties:{
    evidence:{ type:'object', description:'本工位实际回执引用。已核对的工具回执、Run ID、文件路径或哈希可以作为引用。',
      properties:Object.fromEntries(Object.keys(labels).map(k=>[k,detectionResults[k]?{type:'string',enum:detectionResults[k]}:evidenceKey])), additionalProperties:false },
    blockers:{ type:'object', description:'仍存在的问题及诊断回执。', properties:Object.fromEntries(Object.keys(issues).map(k=>[k,evidenceKey])), additionalProperties:false },
    elapsedMinutes:{ type:'integer', minimum:0, maximum:180, description:'实际开场后经过的分钟。彩排可传明确的彩排时钟。' },
    camera:{anyOf:[{type:'null'},{type:'object',properties:{experimentId:{type:'string',pattern:cameraIdPattern},runId:{type:'string',pattern:cameraIdPattern}},required:['experimentId'],additionalProperties:false}],
      description:'与 Camera Workshop 的实际实验和可选 AI Run 绑定。null 解除绑定。'},
    path:{ type:'string', enum:['A','B','C'], description:'本工位已明确选择的完成路径。' },
    run:{ type:'object', description:'RoboGO 已有 Run 的只读状态回执。', properties:{
      id:evidenceKey, state:{ type:'string', enum:runStates }, receipt:evidenceKey,
      name:{type:'string',pattern:'^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$',description:'RoboGO 任务名，用于查询并核对原 Run ID。'},
      source:{type:'string',enum:['robogo','external']},
      modelSha256:{type:'string',pattern:'^[a-f0-9]{64}$',description:'由 RoboGO 原 Run 的 X5 INT8 制品回执核对的 SHA-256。'},
      checkedAtMinute:{ type:'integer',minimum:0,maximum:180 }, etaMinute:{ type:'integer',minimum:0,maximum:1440 },
    }, required:['id','state','receipt'], additionalProperties:false },
  },
  additionalProperties:false,
};

function references(v, allowed) {
  if (!isObject(v) || Object.entries(v).some(([k,x])=>!Object.hasOwn(allowed,k)||!validReference(x))) {
    throw new Error('invalid_evidence_reference');
  }
  return {...v};
}
function task(id, fields=steps[id].fields) {
  const { title, ask, tool }=steps[id];
  return { stageId:id, title, instruction:ask, ...(tool?{tool}:{}), ...(stepEntries[id]?{entry:stepEntries[id]}:{}),
    requiredEvidence:fields.map(key=>({key,label:labels[key]})) };
}

export function classroomStep(plan,id) {
  if(plan.training.workflow!=='devmachine') return steps[id];
  const cutoff=classroomClock(plan,plan.deadlines.deployAt);
  const blindStart=classroomClock(plan,plan.breakPolicy.endMinute);
  const overrides={
    data:{title:'核对本组开发机与课程数据',ask:'打开开发机连接卡，核对 GPU、数据版本、三类顺序及训练验证划分。'},
    train:{title:'启动一次本组开发机训练',ask:'到点按本组连接卡启动。记下原任务 ID、启动回执和日志位置，回 Studio 继续 ISP。'},
    check_run:{title:'核对本组原训练任务',ask:'查看本组任务的原日志和预计完成时间。更新已有记录，再继续相机步骤。'},
    quantize:{title:'核对本组 ONNX 和 X5 INT8 产物',ask:'从本组连接卡的产物位置取同一次任务的 ONNX、PTQ 回执和 INT8 BIN，核对 SHA-256。'},
    break:{ask:'茶歇期间助教核对各组原任务，并为超时工位准备预置产物。'+blindStart+' 开始个人盲选。'},
    await_route:{title:'核对部署准备，等待 '+cutoff+' 分流',ask:'先核对模型来源和本组相机。'+cutoff+' 开放 A/B/C 选择。'},
  };
  return {...steps[id],...overrides[id]};
}

export function guideCourse(plan, args={}) {
  if (!isObject(args) || Object.keys(args).some(k=>!Object.hasOwn(guideSchema.properties,k))) throw new Error('invalid_arguments');
  const evidence=references(Object.hasOwn(args,'evidence')?args.evidence:{}, labels);
  if (Object.entries(detectionResults).some(([key,values])=>evidence[key]&&!values.includes(evidence[key])) ||
      ['','preset_'].some(prefix=>evidence[prefix+'inference_result']==='运行失败'&&['检出','未检出'].includes(evidence[prefix+'target_result']))) throw new Error('invalid_detection_results');
  const blockers=references(Object.hasOwn(args,'blockers')?args.blockers:{}, issues);
  const { elapsedMinutes:minute, path, run, camera }=args;
  if(camera!==undefined&&camera!==null&&(!isObject(camera)||Object.keys(camera).some(k=>k!=='experimentId'&&k!=='runId')||
      typeof camera.experimentId!=='string'||!cameraId.test(camera.experimentId)||
      camera.runId!==undefined&&(typeof camera.runId!=='string'||!cameraId.test(camera.runId)))) throw new Error('invalid_camera_binding');
  if (minute!==undefined && !minuteValid(minute)) throw new Error('invalid_course_time');
  if (path!==undefined && !paths.some(p=>p.id===path)) throw new Error('invalid_course_path');
  if (run!==undefined) {
    if (!isObject(run) || Object.keys(run).some(k=>!Object.hasOwn(guideSchema.properties.run.properties,k))
      || !validReference(run.id)||!validReference(run.receipt)||!runStates.includes(run.state)
      || run.source!==undefined&&!['robogo','external'].includes(run.source)
      || run.name!==undefined&&(run.source!=='robogo'||typeof run.name!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(run.name))
      || (run.modelSha256!==undefined && (run.source!=='robogo'||normalizedModelHash(run.modelSha256)!==run.modelSha256))
      || (run.checkedAtMinute!==undefined && (!minuteValid(run.checkedAtMinute)||minute!==undefined&&run.checkedAtMinute>minute))
      || (run.etaMinute!==undefined && (!Number.isInteger(run.etaMinute)||run.etaMinute<0||run.etaMinute>1440))) throw new Error('invalid_run_receipt');
    if (evidence.run_id && evidence.run_id!==run.id) throw new Error('run_receipt_mismatch');
    evidence.run_id=run.id;
  }
  const { submitStart, submitBy, runCheckpoint, deployAt, deliverAt }=plan.deadlines;
  const direct=plan.training.workflow==='devmachine';
  const blindStart=classroomClock(plan,plan.breakPolicy.endMinute);
  const trainingBlocked=direct?blockers.devmachine_unavailable:blockers.training_image_unavailable;
  const missing=id=>steps[id].fields.filter(k=>(!evidence[k]||
    ['target_result','preset_target_result'].includes(k)&&evidence[k]==='未验证'||
    ['inference_result','preset_inference_result'].includes(k)&&evidence[k]==='运行失败')&&
    !(k==='baseline_raw'&&evidence.baseline_raw_sample));
  const done=id=>!missing(id).length;
  // Configuration snapshots remain available for recovery even when a live device is disconnected.
  const recheck=new Set();
  if (blockers.vision_device_transport_failed) {
    for (const k of ['current_device_identity','fresh_camera_image','independent_readback','tuning_reload_frame',
      ...steps.deploy.fields,...steps.live.fields,...steps.preset_deploy.fields.filter(key=>key!=='preset_model')]) {
      if (evidence[k]) recheck.add(k);
    }
  }
  if (blockers.recovery_unconfirmed && evidence.restoration_and_release) recheck.add('restoration_and_release');
  for (const k of recheck) delete evidence[k];

  const ownModel=normalizedModelHash(evidence.x5_model_hash);
  const cloudModelReady=run?.source!=='robogo'||Boolean(run.modelSha256&&run.modelSha256===ownModel);
  const ownReady=done('quantize')&&Boolean(ownModel&&run?.source)&&cloudModelReady
    && ['completed','artifact_ready'].includes(run.state)&&!blockers.training_run_failed;
  const boardBlocked=Boolean(blockers.vision_device_transport_failed);
  const depBlocked=boardBlocked||Boolean(blockers.course_runner_unavailable);
  const boardReady=done('connect') && !depBlocked;
  const trained=direct?Boolean(run):Boolean(evidence.run_id);
  const passedSubmit=minute!==undefined && minute>=submitBy && !trained;
  const atDeployment=minute!==undefined && minute>=deployAt;
  const isBreak=minute!==undefined && minute>=plan.breakPolicy.startMinute && minute<plan.breakPolicy.endMinute;
  const missedRun=passedSubmit || run?.state==='failed' || Boolean(blockers.training_run_failed);
  const likelyLate=minute!==undefined && minute>=runCheckpoint && run?.etaMinute>deployAt && !ownReady;
  const timeToChoose=atDeployment||(!direct&&minute===undefined&&(missedRun||done('reproduce')));
  const choices=paths.map(p=>{
    if(direct&&p.id!=='C'&&!boardReady) return {...p,available:false,reason:'请先核对本组相机新帧、板卡连接和原始 ISP 快照。'};
    if (p.id==='A') return {...p, available:ownReady&&!depBlocked, reason:!cloudModelReady?'请刷新原 Run，核对平台返回的 X5 INT8 SHA-256 与本组模型一致。':!ownReady?'需要本人训练、验证、ONNX 与 INT8 回执。':depBlocked?'本工位设备或执行入口待恢复。':'本人产物已记录，可以走本人板端验证。'};
    if (p.id==='B') return {...p, available:Boolean(presetModelHash(evidence.preset_model))&&!depBlocked, reason:!presetModelHash(evidence.preset_model)?'请输入预置模型来源及 SHA-256。':depBlocked?'本工位暂时不能运行模型。':'预置产物已记录。'};
    return {...p, available:true, reason:evidence.demo_reference?'已有演示来源。':'选择后补充讲师演示或录像来源。'};
  });
  const recommended=choices.find(p=>p.available).id;
  const actualPath=choices.find(p=>p.id===path);
  const checkpointDue=minute!==undefined&&minute>=runCheckpoint&&!atDeployment;
  const needsPreflight=checkpointDue&&!ownReady;
  const checkedThisCheckpoint=run?.checkedAtMinute>=runCheckpoint;
  const trainState=ownReady?'artifact_ready':run?.state==='artifact_ready'?'completed':run?.state??(trained?'submitted':passedSubmit?'missed':'not_submitted');
  const runCard={ state:trainState, id:evidence.run_id??null, source:run?.source??null, ...(run?.receipt?{receipt:run.receipt}:{}),
    ...(run?.checkedAtMinute!==undefined?{checkedAtMinute:run.checkedAtMinute}:{}), ...(run?.etaMinute!==undefined?{etaMinute:run.etaMinute}:{}),
    preflight:needsPreflight?(likelyLate||missedRun?'prepare_backup':checkedThisCheckpoint?'checked':'due'):null,
    submitStart, submitBy, checkpointAt:runCheckpoint, deployAt,
    instruction:trained
      ? ownReady?'本组模型可用于板端验证。':isBreak||atDeployment?'核对原任务和预计完成时间。按课堂时间分流。':'原任务已登记，继续相机步骤。'
      : passedSubmit?'训练启动窗口已结束，准备预置产物或讲师演示。':direct?
        '按本组连接卡核对 GPU、课程数据和启动命令。只启动一次，登记原任务 ID 和首行日志。':
        '先存基线图，按助教的组序在提交窗口提交一次，保留 Run ID。' };
  const create=(id,fields=missing(id))=>{
    const {title,ask}=classroomStep(plan,id);
    return {...task(id,fields),title,instruction:ask};
  };
  const reportIssue=code=>({ ...task(issues[code].stageId,[]),kind:'resolve_blocker',instruction:issues[code].message });
  const restoreDone=done('restore') || (path==='C' && !evidence.original_snapshot && Boolean(evidence.device_unused));
  const pendingCamera=mainCamera.find(id=>!done(id));
  const pendingBoardObservation=path==='A'?evidence.board_detection_receipt&&evidence.target_result==='未验证':
    path==='B'&&evidence.preset_detection_receipt&&evidence.preset_target_result==='未验证';
  let nextStep=null;
  if (blockers.recovery_unconfirmed) nextStep={...reportIssue('recovery_unconfirmed'),kind:'recovery'};
  else if (minute!==undefined && minute>=deliverAt && evidence.original_snapshot && !restoreDone && !boardBlocked) nextStep=create('restore');
  else if (!done('intro')) nextStep=create('intro');
  else if (path==='C') nextStep=!done('demo')?create('demo'):!restoreDone?create('restore'):!done('deliver')?create('deliver'):null;
  else if (actualPath && !actualPath.available) {
    nextStep={ ...task('route',[]), kind:'select_path', instruction:actualPath.reason+' 可以复查或明确改走可用分支。' };
  } else if (path==='A' || path==='B') {
    if (!done('connect')) nextStep=create('connect');
    else if (path==='A' && !done('deploy')) nextStep=create('deploy');
    else if (!done('reproduce') && !done('restore')) nextStep=create('reproduce');
    else if (path==='A' && !done('live') && (!restoreDone||pendingBoardObservation)) nextStep=create('live');
    else if (path==='B' && !done('preset_deploy') && (!restoreDone||pendingBoardObservation)) nextStep=create('preset_deploy');
    else if (!restoreDone) nextStep=create('restore');
    else if (!done('deliver')) nextStep=create('deliver');
  } else if (atDeployment) nextStep={...task('route',[]),kind:'select_path'};
  else if (!trained && !missedRun && !trainingBlocked && (minute!==undefined&&minute>=submitStart || minute===undefined&&(done('baseline')||boardBlocked))) {
    nextStep=blockers.dataset_unconfirmed?reportIssue('dataset_unconfirmed'):create(done('data')?'train':'data');
  } else if (isBreak) {
    nextStep=create('break');
  } else if (timeToChoose && (depBlocked||!pendingCamera)) {
    nextStep={...task('route',[]),kind:'select_path'};
  } else if (boardBlocked) nextStep=reportIssue('vision_device_transport_failed');
  else if (pendingCamera==='blind'&&minute!==undefined&&minute<plan.breakPolicy.endMinute) {
    nextStep=trained&&!ownReady?create('check_run',[]):{...create('break',[]),instruction:'相机探索已记录。等 '+blindStart+' 开始盲选，也可以先准备两张实际对照图。'};
  }
  else if (pendingCamera) nextStep=create(pendingCamera);
  else if (ownReady||missedRun&&checkpointDue) nextStep={...create('await_route',[]),kind:'await_cutoff'};
  else if (['completed','artifact_ready'].includes(run?.state) && !blockers.ptq_image_unavailable) nextStep=create('quantize');
  else if (trained) nextStep={...create('check_run',[]),kind:'check_existing_run',runReference:evidence.run_id};
  else if (trainingBlocked) nextStep=reportIssue(direct?'devmachine_unavailable':'training_image_unavailable');
  else nextStep=create(done('data')?'train':'data');

  if (pendingBoardObservation&&['live','preset_deploy'].includes(nextStep?.stageId)) {
    nextStep.title='核对归档帧的目标检出';
    nextStep.requiredEvidence=nextStep.requiredEvidence.filter(item=>item.key.endsWith('target_result'));
    nextStep.instruction='板端实拍已留证。查看本轮归档帧，再记录你选择的课程目标是否检出。';
    nextStep.actions=['打开本次检测，核对归档画面和类别。','点击「记录本帧目标结果」，填写观察类别与依据。'];
  }
  if (nextStep && !nextStep.kind) nextStep.kind='action';
  if (nextStep?.stageId==='restore' && path==='C' && !evidence.original_snapshot) {
    nextStep.requiredEvidence=[{key:'device_unused',label:labels.device_unused}];
  }
  if (nextStep?.stageId==='restore' && boardBlocked && evidence.original_snapshot) nextStep=reportIssue('vision_device_transport_failed');
  const liveVerified=prefix=>evidence[prefix+'inference_result']==='运行成功'&&['检出','未检出'].includes(evidence[prefix+'target_result']);
  const boardExecutionRecorded=path==='A'?ownReady&&boardReady&&done('deploy')&&done('live')&&liveVerified('')
    &&normalizedModelHash(evidence.board_model_hash)===ownModel
    :path==='B'&&boardReady&&done('preset_deploy')&&liveVerified('preset_')
      &&Boolean(presetModelHash(evidence.preset_model))&&normalizedModelHash(evidence.preset_board_model_hash)===presetModelHash(evidence.preset_model);
  const pathReady=path==='C'?done('demo'):boardExecutionRecorded&&done('reproduce');
  const requiredLearnerStages=path==='C'?['intro']:['intro',...mainCamera];
  const lessonGaps=requiredLearnerStages.filter(id=>!done(id)).map(id=>steps[id].title);
  if (!evidence.baseline_raw&&evidence.baseline_raw_sample) lessonGaps.push('本人 Bayer RAW 实采');
  const finished=Boolean(pathReady&&restoreDone&&done('deliver')&&lessonGaps.length===0);
  const currentIds=nextStep ? [nextStep.stageId] : [];
  const progress=[...plan.schedule,...plan.parallel].map(s=>{
    const id=s.id;
    const isDone=id==='deploy'?pathReady:id==='deliver'?finished:id==='wait_run'?ownReady:id==='break'?minute!==undefined&&minute>=plan.breakPolicy.endMinute:done(id);
    const isCurrent=currentIds.includes(id)||['data'].includes(nextStep?.stageId)&&id==='train'
      || ['check_run','quantize','await_route'].includes(nextStep?.stageId)&&id==='wait_run'
      || ['route','live','preset_deploy','demo'].includes(nextStep?.stageId)&&id==='deploy'
      || nextStep?.stageId==='restore'&&id==='deliver';
    const affected=boardBlocked&&['connect','baseline','reproduce'].includes(id);
    return {...s,status:affected?'blocked':isDone?'evidence_recorded':isCurrent?'current':'pending'};
  });
  return {
    schema:'rdk.vision-workshop-guide.v2', executionStatus:'planning_only',
    evidenceSource:'caller_supplied_references', nextStep, training:runCard,
    routing:{ eligible:timeToChoose||Boolean(path), selected:path??null, recommended, choices,
      decisionAt:deployAt, perBoardMinutes:plan.deadlines.perBoardMinutes },
    completion:{ currentPath:path??null, lessonEvidenceComplete:finished, modelChainEvidenceRecorded:Boolean(path==='A'&&boardExecutionRecorded),
      learnerBoardEvidenceRecorded:Boolean(boardExecutionRecorded),
      targetResult:path==='A'?evidence.target_result??null:path==='B'?evidence.preset_target_result??null:null,
      unfinished:[...lessonGaps,
        ...(path==='C'?['本人板端模型部署和实时检测']:path==='B'?['本人模型训练、PTQ 和部署闭环']:boardExecutionRecorded?[]:['本工位部署与实时检测'])],
      recoveryConfirmedInRecord:done('restore') },
    awaitingUser:nextStep?.kind==='recovery'?[]:Object.entries(blockers).flatMap(([code])=>issues[code].userAction?[{code,instruction:issues[code].userAction}]:[]),
    evidenceToRecheck:[...recheck], stages:progress,
    resume:{evidence,blockers,...(run?{run}:{}),...(minute!==undefined?{elapsedMinutes:minute}:{}),...(path?{path}:{}),...(camera?{camera}:{})},
  };
}
