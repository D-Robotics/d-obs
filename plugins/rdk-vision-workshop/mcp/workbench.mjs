#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { plan } from './course.mjs';
import { guideCourse, guideSchema, normalizedModelHash, presetModelHash } from './guide.mjs';
import { createCameraSource } from './camera-source.mjs';
import { boardEvidence, externalTrainingReceipt } from './course-evidence.mjs';
import { createRoboGo, trainingProfile } from './robogo.mjs';
import { readWorkbenchState, writeWorkbenchState } from './workbench-state.mjs';

const cameraErrors=new Set(['camera_unconfigured','camera_configuration_invalid','camera_service_unreachable','camera_auth_required',
  'camera_archive_missing','camera_response_invalid','camera_service_error','camera_frame_integrity_failed','camera_binding_invalid']);
const captureActions=new Set(['photo','baseline','retake','render']);
const unconfirmedCapture=new Set(['camera_capture_unconfirmed','vision_device_transport_failed']);
const evidenceErrors=new Set(['training_receipt_unconfigured','training_receipt_invalid','board_archive_unconfigured','board_receipt_pending',
  'board_model_mismatch','board_receipt_changed','board_asset_missing','board_asset_integrity_failed','evidence_file_invalid']);

const routes = new Map([
  ['/', ['text/html', '../web/index.html']],
  ['/style.css', ['text/css', '../web/style.css']],
  ['/app.mjs', ['text/javascript', '../web/app.mjs']],
  ['/camera-panel.mjs', ['text/javascript', '../web/camera-panel.mjs']],
  ['/capture-panel.mjs', ['text/javascript', '../web/capture-panel.mjs']],
  ['/preflight-panel.mjs', ['text/javascript', '../web/preflight-panel.mjs']],
  ['/isp-panel.mjs', ['text/javascript', '../web/isp-panel.mjs']],
  ['/isp-demo.mjs', ['text/javascript', '../web/isp-demo.mjs']],
  ['/isp-demo/manifest.json', ['application/json', '../web/isp-demo/manifest.json']],
  ['/board-panel.mjs', ['text/javascript', '../web/board-panel.mjs']],
  ['/zip.mjs', ['text/javascript', '../web/zip.mjs']],
  ['/guide.mjs', ['text/javascript', './guide.mjs']],
  ['/steps.mjs', ['text/javascript', './steps.mjs']],
]);
for(const name of ['exposure','gain','contrast','sharpness','white-balance']) {
  for(const phase of ['before','after']) {
    const asset='/isp-demo/'+name+'-'+phase+'.jpg';
    routes.set(asset,['image/jpeg','../web'+asset]);
  }
}
const files = new Map([...routes].map(([path,[type,name]])=>[path,[type,readFileSync(new URL(name,import.meta.url))]]));

export async function startWorkbench(input={}, port=0, cameraSource=createCameraSource(), {idleMs,roboGo=createRoboGo(),stateFile}={}) {
  const stored=readWorkbenchState(stateFile);
  let verifiedRun=stored?.verifiedRun;
  let lockedRun=stored?.lockedRun;
  const initial={...(stored?.resume??input)};
  if(initial.run?.modelSha256!==undefined&&(initial.run.id!==verifiedRun?.id||initial.run.modelSha256!==verifiedRun?.modelSha256)) {
    initial.run={...initial.run};delete initial.run.modelSha256;
  }
  let resume=guideCourse(plan,initial).resume;
  let revision=0;
  let inspected;
  let preflight;
  let preflightRunning=false;
  let cameraIsp=stored?.cameraIsp;
  if(cameraIsp?.gamma&&!cameraIsp.rounds?.length&&cameraIsp.gammaReadback) {
    cameraIsp={...cameraIsp,rounds:[{number:1,...cameraIsp.gamma,beforeReadback:cameraIsp.original,
      gammaReadback:cameraIsp.gammaReadback,legacy:true}]};
  }
  if(cameraIsp?.running) {
    const {running,...saved}=cameraIsp;
    cameraIsp={...saved,error:saved.recoveryPending?'camera_isp_restore_unconfirmed':'camera_isp_operation_interrupted'};
  }
  let ispBusy=false;
  let cameraCapture=stored?.cameraCapture;
  if(cameraCapture?.running) {
    const {running,...saved}=cameraCapture;
    cameraCapture={...saved,errors:{...saved.errors,[running]:'camera_capture_unconfirmed'}};
  }
  let cameraJob=false;
  const board=boardEvidence();
  const presetBoard=process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE?boardEvidence(process.env.RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE):board;
  const selectedBoard=()=>resume.path==='B'?presetBoard:board;
  let lastRoboGoCheck, checkingRoboGo;
  let preparedTraining, submittingTraining=false, authorizationRound=0, submission=stored?.submission??'idle';
  const persist=(next=resume)=>writeWorkbenchState(stateFile,{resume:next,submission,verifiedRun,lockedRun,cameraCapture,cameraIsp});
  const selectedModelHash=()=>resume.path==='B'?presetModelHash(resume.evidence.preset_model)
    :resume.path==='C'||resume.run?.source==='robogo'&&resume.run.modelSha256!==normalizedModelHash(resume.evidence.x5_model_hash)
      ?undefined:normalizedModelHash(resume.evidence.x5_model_hash);
  function checkTrainingWindow() {
    if(!stateFile) throw new Error('robogo_state_required');
    if(resume.run||resume.evidence.run_id) throw new Error('robogo_run_exists');
    if(submittingTraining||submission!=='idle') throw new Error('robogo_submit_unconfirmed');
    const minute=resume.elapsedMinutes;
    if(minute===undefined||minute<plan.deadlines.submitStart||minute>=plan.deadlines.submitBy) throw new Error('robogo_submit_window');
    const {training_image_unavailable:_,...remainingBlockers}=resume.blockers;
    if(guideCourse(plan,{...resume,blockers:remainingBlockers}).nextStep?.stageId!=='train') throw new Error('robogo_training_step_required');
  }
  async function prepareTraining() {
    checkTrainingWindow();
    const round=authorizationRound;
    const profile=await trainingProfile();
    const ref=await roboGo.prepare(profile.input);
    checkTrainingWindow();
    if(round!==authorizationRound) throw new Error('robogo_plan_changed');
    if(resume.blockers.training_image_unavailable) update({},['training_image_unavailable']);
    const confirmationId=randomUUID();
    preparedTraining={ref,confirmationId,expires:Date.now()+120000};
    return {confirmationId,parameters:profile.input};
  }
  async function submitTraining(confirmationId) {
    checkTrainingWindow();
    const prepared=preparedTraining;
    if(!prepared||Date.now()>=prepared.expires) throw new Error('robogo_plan_expired');
    if(confirmationId!==prepared.confirmationId) throw new Error('robogo_plan_changed');
    submittingTraining=true;
    preparedTraining=undefined;
    try {
      submission='pending';
      persist();
      const run=await roboGo.submit(prepared.ref);
      lockedRun=run;
      submission='accepted';
      verifiedRun=run;
      return update({run:{...run,checkedAtMinute:resume.elapsedMinutes}});
    } catch {
      if(!lockedRun) submission='pending';
      throw new Error('robogo_submit_unconfirmed');
    } finally {submittingTraining=false;}
  }
  async function refreshRoboGo() {
    const run=resume.run;
    if(run?.source!=='robogo') throw new Error('robogo_run_required');
    if(checkingRoboGo?.id===run.id) return checkingRoboGo.promise;
    if(lastRoboGoCheck?.id===run.id&&Date.now()-lastRoboGoCheck.time<15000) return read();
    const promise=(async()=>{
      const result=await roboGo.refresh(run.id,{name:run.name,receipt:run.receipt});
      if(resume.run?.source!=='robogo'||resume.run.id!==result.id) throw new Error('run_receipt_mismatch');
      const elapsedMinutes=resume.elapsedMinutes;
      verifiedRun=result;
      lockedRun=result;submission='accepted';
      const next=update({run:{...result,...(elapsedMinutes!==undefined?{checkedAtMinute:elapsedMinutes}:{}),
        ...(resume.run.etaMinute!==undefined?{etaMinute:resume.run.etaMinute}:{})},
        ...(result.modelSha256&&!resume.evidence.x5_model_hash?{evidence:{x5_model_hash:'sha256:'+result.modelSha256}}:{})});
      lastRoboGoCheck={id:run.id,time:Date.now()};
      return next;
    })();
    checkingRoboGo={id:run.id,promise};
    try {return await promise;}
    finally {if(checkingRoboGo?.promise===promise) checkingRoboGo=undefined;}
  }
  function read() { return {resume,revision}; }
  function readPreflight() {
    return preflight?.experimentId===(resume.camera?.experimentId??null)?preflight:undefined;
  }
  function queuePreflight() {
    if(preflightRunning||cameraJob||ispBusy) throw new Error('camera_capture_busy');
    const binding=resume.camera;
    const result={experimentId:binding?.experimentId??null,startedAt:new Date().toISOString(),running:true,
      checks:{service:{status:'checking'},board:{status:'waiting'},frame:{status:'waiting'}}};
    preflight=result;
    preflightRunning=true;
    void (async()=>{
      try {
        await cameraSource.preflight(binding,(layer,receipt)=>{
          result.checks[layer]={...receipt,checkedAt:new Date().toISOString()};
        });
        if(binding?.experimentId&&binding.experimentId===resume.camera?.experimentId&&
           Object.values(result.checks).every(check=>check.status==='passed')) {
          const {board,sensorModel,mode,receiptId}=result.checks.board;
          update({evidence:{plugin_tools_available:'本轮相机服务与实时帧预检通过',
            current_device_identity:[board,sensorModel,mode,receiptId].filter(Boolean).join(' · ').slice(0,300)}},
            ['vision_device_transport_failed']);
        }
      } catch {
        result.checks.service={status:'blocked',code:'camera_service_error',checkedAt:new Date().toISOString()};
      } finally {
        result.running=false;
        result.completedAt=new Date().toISOString();
        preflightRunning=false;
      }
    })();
    return result;
  }
  function storedIsp() {
    return cameraIsp?.experimentId===resume.camera?.experimentId?cameraIsp:undefined;
  }
  function ispStatus() {
    const status=storedIsp();
    if(!status) return;
    const {original,readback,gammaReadback,reloadReadback,rounds=[],...details}=status;
    const summary=({config,...metadata})=>{
      const gamma=config?.modules?.gamma;
      const curve=gamma?.mode===0?gamma['auto_attr.curve']:gamma?.mode===1?gamma['manual_attr.curve']:null;
      const points=[0,16,32,48,63];
      return {...metadata,...(Array.isArray(curve)&&points.every(index=>Number.isFinite(curve[index]))?
        {curvePreview:{mode:gamma.mode,points:points.map(index=>curve[index])}}:{})};
    };
    return {...details,...(original?{original:summary(original)}:{}),...(readback?{readback:summary(readback)}:{}),
      ...(gammaReadback?{gammaReadback:summary(gammaReadback)}:{}),...(reloadReadback?{reloadReadback:summary(reloadReadback)}:{}),
      rounds:rounds.map(({beforeReadback,gammaReadback,decisionReadback,resetReadback,...round})=>({...round,
        ...(beforeReadback?{beforeReadback:summary(beforeReadback)}:{}),gammaReadback:summary(gammaReadback),
        ...(decisionReadback?{decisionReadback:summary(decisionReadback)}:{}),...(resetReadback?{resetReadback:summary(resetReadback)}:{})}))};
  }
  function saveIsp(value) {
    const previous=cameraIsp;
    cameraIsp=value;
    try {persist();}
    catch(error) {cameraIsp=previous;throw error;}
  }
  function queueIsp(action,goal,{round,choice,reason}={}) {
    const validText=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
    if(!['save','gamma','decision','reload','revert','restore'].includes(action)||
      (action==='gamma'&&!validText(goal,180))||
      (action==='decision'&&(![1,2].includes(round)||!['keep','restore'].includes(choice)||!validText(reason,180)))) {
      throw new Error('camera_isp_action_invalid');
    }
    const binding=resume.camera;
    if(!binding) throw new Error('camera_binding_invalid');
    if(ispBusy||cameraJob||preflightRunning) throw new Error('camera_capture_busy');
    if(cameraIsp?.recoveryPending&&cameraIsp.experimentId!==binding.experimentId) throw new Error('camera_recovery_required');
    const current=storedIsp();
    if(action==='save'&&current?.original) return ispStatus();
    if(action!=='save'&&!current?.original) throw new Error('camera_isp_snapshot_missing');
    if((action==='restore'||action==='revert')&&current.stop) return ispStatus();
    if(['gamma','reload'].includes(action)&&(current.recoveryPending||current.changesActive||current.stop)) throw new Error('camera_recovery_required');
    const rounds=current?.rounds??[];
    const nextRound=rounds.length+1;
    const selected=rounds.at(-1);
    if(action==='gamma'&&(nextRound>2||selected&&!selected.decision||round!==undefined&&round!==nextRound)) {
      throw new Error('camera_gamma_round_locked');
    }
    if(action==='decision'&&(round!==selected?.number||selected.decision||current.stop||choice==='keep'&&
      (!current.changesActive||current.recoveryPending||current.stage==='gamma_reloaded'))) throw new Error('camera_gamma_round_locked');
    if(action==='reload'&&(!current.gamma?.candidateId||!current.gammaReadback||!current.restored)) {
      throw new Error('camera_gamma_reload_required');
    }
    const status={...current,experimentId:binding.experimentId,running:action,
      stage:action==='save'?'snapshot':'checking',
      recoveryPending:['restore','revert'].includes(action)||action==='decision'&&choice==='restore'||current?.recoveryPending===true};
    delete status.error;
    saveIsp(status);
    ispBusy=true;
    void (async()=>{
      try {
        if(action==='save') {
          status.original=await cameraSource.saveOriginalIsp(binding);
          status.stage='saved';
          saveIsp({...status});
          update({evidence:{original_snapshot:status.original.baselineId+' · sha256:'+status.original.hash}});
        } else if(action==='gamma') {
          delete status.pendingGamma;
          const result=await cameraSource.gammaTrial(binding,status.original,goal.trim(),(stage,progress,applyStarted)=>{
            status.stage=stage;
            if(progress) status.pendingGamma={...status.pendingGamma,...progress};
            if(applyStarted) {
              status.recoveryPending=true;
              delete status.readback;
              delete status.stopPending;
              delete status.gammaReadback;
            }
            saveIsp({...status});
          });
          status.gamma={before:result.before,after:result.after,candidateId:result.candidateId};
          status.gammaReadback=result.readback;
          status.rounds=[...rounds,{number:nextRound,goal:goal.trim(),...status.gamma,beforeReadback:result.beforeReadback,
            gammaReadback:result.readback}];
          delete status.pendingGamma;
          delete status.restored;
          delete status.reloaded;
          delete status.reloadReadback;
          delete status.comparisonIssue;
          Object.assign(status,{stage:'gamma_saved',recoveryPending:false,changesActive:true});
          saveIsp({...status});
          update({evidence:{[nextRound===1?'gamma_readback':'trial_readback']:'sha256:'+result.readback.hash+' · '+result.readback.receiptId,
            [nextRound===1?'gamma_fresh_frame':'trial_fresh_frame']:result.after.id+' · SDK '+result.after.sdkTimestampNs}});
        } else if(action==='decision'&&choice==='keep') {
          const decisionReadback=await cameraSource.confirmIsp(binding,status.original,selected.gammaReadback.hash);
          status.rounds=[...rounds.slice(0,-1),{...selected,decisionReadback,decision:{choice,reason:reason.trim(),recordedAt:new Date().toISOString()}}];
          status.stage='gamma_saved';
          saveIsp({...status});
          update({evidence:{[round===1?'gamma_decision':'trial_decision']:'保留调整 · '+reason.trim()}});
        } else if(action==='reload') {
          const result=await cameraSource.reloadGamma(binding,status.original,
            {id:status.gamma.candidateId,hash:status.gammaReadback.hash},status.restored,(stage,applyStarted)=>{
              status.stage=stage;
              if(applyStarted) status.recoveryPending=true;
              saveIsp({...status});
            });
          Object.assign(status,{stage:'gamma_reloaded',recoveryPending:false,changesActive:true,
            reloaded:result.after,reloadReadback:result.readback});
          saveIsp({...status});
          update({evidence:{selected_tuning:status.gamma.candidateId+' · sha256:'+result.readback.hash,
            independent_readback:'sha256:'+result.readback.hash+' · '+result.readback.receiptId,
            tuning_reload_frame:result.after.id+' · SDK '+result.after.sdkTimestampNs}});
        } else {
          const result=await cameraSource.restoreOriginalIsp(binding,status.original,{
            previousReadback:status.stopPending?status.readback:undefined,
            stopStream:action==='restore',
            onPhase(stage,readback) {
              status.stage=stage;
              if(readback) {
                status.readback=readback;
                status.stopPending=stage==='stop';
              }
              saveIsp({...status});
            },
          });
          delete status.comparisonIssue;
          Object.assign(status,result,{stage:action==='restore'?'stopped':'reverted',recoveryPending:false,changesActive:false,stopPending:false});
          if(selected&&action!=='restore') {
            const evidence=action==='decision'?{decisionReadback:result.readback,
              decision:{choice,reason:reason.trim(),recordedAt:new Date().toISOString()}}:
              selected.resetReadback?{}:{resetReadback:result.readback};
            status.rounds=[...rounds.slice(0,-1),{...selected,...evidence,...(result.restored&&!selected.restored?{restored:result.restored}:{})}];
          }
          saveIsp({...status});
          const evidence=action==='restore'?{restoration_and_release:'ISP sha256:'+result.readback.hash+' · 停流回执 '+result.stop.receiptId}:
            result.restored&&status.gamma?.before&&status.gamma?.after?{A1_B_A2:[status.gamma.before.id,status.gamma.after.id,result.restored.id].join(' · ')}:{};
          if(action==='decision') evidence[round===1?'gamma_decision':'trial_decision']='恢复原值 · '+reason.trim();
          update({evidence},['recovery_unconfirmed']);
        }
      } catch(error) {
        if(action==='decision'&&choice==='keep'&&error.message==='camera_isp_snapshot_changed') status.recoveryPending=true;
        status.error=/^(vision|camera)_[a-z0-9_]{1,90}$/.test(error.message)?error.message:'camera_isp_recording_failed';
        if(status.recoveryPending) {
          try {update({blockers:{recovery_unconfirmed:'ISP 恢复与停流待核对 · '+status.error}});} catch {}
        }
      } finally {
        delete status.running;
        try {saveIsp({...status});} catch {}
        ispBusy=false;
      }
    })();
    return ispStatus();
  }
  function captureStatus() {
    return cameraCapture?.experimentId===resume.camera?.experimentId?cameraCapture:undefined;
  }
  function saveCapture(value) {
    const previous=cameraCapture;
    cameraCapture=value;
    try {persist();}
    catch(error) {cameraCapture=previous;throw error;}
  }
  function recordCapture(action,value) {
    const {photo,raw,isp,render}=value.assets;
    const describe=asset=>asset.id+' · sha256:'+asset.sha256;
    const evidence={};
    if(action==='photo'&&photo) evidence.fresh_camera_image=describe(photo);
    if(action!=='photo'&&raw&&isp&&render) Object.assign(evidence,{
      baseline_images:'同一固定场景 · '+value.scene+' · RAW 与 ISP 分次采集，重渲染来自本组 RAW',
      baseline_raw:describe(raw),baseline_isp:describe(isp),baseline_render:describe(render),
    });
    if(Object.keys(evidence).length) update({evidence});
  }
  async function captureParts(action,value,binding) {
    try {
      for(const kind of action==='photo'?['photo']:action==='render'?['render']:['raw','isp','render']) {
        if(kind!=='photo'&&value.assets[kind]) continue;
        if(kind==='render'&&!value.assets.raw) break;
        value.running=kind;
        delete value.errors[kind];
        saveCapture(structuredClone(value));
        try {
          const asset=await cameraSource.capture(binding,kind,{scene:kind==='photo'?'当前相机场景':value.scene,raw:value.assets.raw});
          value.assets[kind]=asset;
          inspected=undefined;
        } catch(error) {
          value.errors[kind]=/^vision_[a-z0-9_]{1,90}$/.test(error.message)||cameraErrors.has(error.message)||
            error.message==='camera_capture_unconfirmed'?error.message:'camera_service_error';
        }
        delete value.running;
        saveCapture(structuredClone(value));
        if(unconfirmedCapture.has(value.errors[kind])) break;
      }
      recordCapture(action,value);
    } finally {cameraJob=false;}
  }
  function queueCapture(action,scene) {
    if(!captureActions.has(action)) throw new Error('camera_capture_invalid');
    if(!resume.camera) throw new Error('camera_binding_invalid');
    if(cameraJob||preflightRunning||ispBusy) throw new Error('camera_capture_busy');
    if(cameraIsp?.recoveryPending) throw new Error('camera_recovery_required');
    if((action==='baseline'||action==='retake')&&
        (typeof scene!=='string'||!scene.trim()||scene.trim().length>100||/[\u0000-\u001f\u007f]/u.test(scene))) throw new Error('camera_scene_required');
    const binding=resume.camera;
    const previous=captureStatus()??{experimentId:binding.experimentId,assets:{},errors:{}};
    const next=structuredClone(previous);
    if(action==='photo') {delete next.assets.photo;delete next.errors.photo;}
    else if(action==='retake'||!previous.scene) {
      for(const kind of ['raw','isp','render']) {delete next.assets[kind];delete next.errors[kind];}
      next.scene=scene?.trim();
    }
    if(action==='render'&&(!next.assets.raw||next.assets.render)) throw new Error('camera_render_raw_required');
    if(action==='baseline'&&next.scene!==scene.trim()) throw new Error('camera_scene_changed');
    if(action==='baseline'&&next.assets.raw&&next.assets.isp&&next.assets.render&&!next.recording) return previous;
    if(action==='baseline'&&['raw','isp','render'].some(kind=>unconfirmedCapture.has(next.errors[kind]))||
       action==='render'&&unconfirmedCapture.has(next.errors.render)) throw new Error('camera_capture_unconfirmed');
    delete next.recording;
    cameraJob=true;
    void captureParts(action,next,binding).catch(()=>{
      if(cameraCapture?.experimentId===binding.experimentId) {
        const {running,...saved}=cameraCapture;
        cameraCapture={...saved,recording:'camera_recording_failed',
          ...(running?{errors:{...saved.errors,[running]:'camera_capture_unconfirmed'}}:{})};
      }
    });
    return captureStatus();
  }
  function update(patch, clearBlockers=[], replace=false) {
    if (!patch || typeof patch!=='object' || Array.isArray(patch) || !Array.isArray(clearBlockers) ||
        clearBlockers.some(code=>typeof code!=='string'||!Object.hasOwn(guideSchema.properties.blockers.properties,code))) {
      throw new Error('invalid_session_update');
    }
    const current=replace?{}:resume;
    const blockers={...current.blockers,...patch.blockers};
    for (const code of clearBlockers) delete blockers[code];
    const boundCloudRun=resume.run?.source==='robogo'?resume.run:undefined;
    const previousId=boundCloudRun?.id??current.run?.id??current.evidence?.run_id;
    const incomingId=patch.run?.id??patch.evidence?.run_id;
    if (previousId&&incomingId&&previousId!==incomingId) throw new Error('run_receipt_mismatch');
    if ((patch.evidence!==undefined&&(!patch.evidence||typeof patch.evidence!=='object'||Array.isArray(patch.evidence))) ||
        (patch.blockers!==undefined&&(!patch.blockers||typeof patch.blockers!=='object'||Array.isArray(patch.blockers)))) {
      throw new Error('invalid_session_update');
    }
    const candidate={...current,...patch,evidence:{...current.evidence,...patch.evidence},blockers};
    if(lockedRun) {
      if((incomingId&&incomingId!==lockedRun.id)||(candidate.run&&candidate.run.source!=='robogo')) throw new Error('run_receipt_mismatch');
      candidate.run??=lockedRun;
    }
    if(boundCloudRun&&candidate.run&&candidate.run.source!=='robogo') throw new Error('run_receipt_mismatch');
    candidate.run??=boundCloudRun;
    if(!candidate.run) delete candidate.run;
    if(candidate.run) {
      const {modelSha256:_claimed,...run}=candidate.run;
      if(run.source==='robogo'&&run.id===verifiedRun?.id&&verifiedRun.name) run.name=verifiedRun.name;
      const verified=run.source==='robogo'&&run.id===verifiedRun?.id?verifiedRun.modelSha256:undefined;
      candidate.run={...run,...(verified?{modelSha256:verified}:{})};
    }
    if (!replace&&patch.path&&patch.path!==current.path&&candidate.elapsedMinutes!==undefined&&candidate.elapsedMinutes<plan.deadlines.deployAt) {
      throw new Error('route_not_open');
    }
    const next=guideCourse(plan,candidate).resume;
    if((cameraJob||ispBusy||cameraIsp?.recoveryPending||cameraIsp?.changesActive)&&next.camera?.experimentId!==resume.camera?.experimentId) throw new Error('camera_capture_busy');
    const changed=JSON.stringify(next)!==JSON.stringify(resume);
    if(changed||submission!=='idle'||verifiedRun) persist(next);
    if (changed) {
      if(JSON.stringify(next.camera)!==JSON.stringify(resume.camera)) inspected=undefined;
      if(next.camera?.experimentId!==resume.camera?.experimentId) preflight=undefined;
      resume=next; revision++;
    }
    return read();
  }
  const key=randomUUID();
  let idle;
  function keepAlive() {
    if (!idleMs) return;
    clearTimeout(idle);
    idle=setTimeout(()=>server.close(),idleMs);
    idle.unref();
  }
  const server=createServer(async (req,res)=>{
    const host='127.0.0.1:'+server.address().port;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; base-uri 'none'; form-action 'none'");
    if (req.headers.host!==host) { res.writeHead(404).end(); return; }
    const url=new URL(req.url,'http://'+host);
    if (req.headers['x-workshop-session']===key||url.pathname==='/course.json'&&url.searchParams.get('view')===key) keepAlive();
    if(url.pathname==='/robogo/callback'&&req.method==='GET') {
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      try {
        await roboGo.callback(url.searchParams);
        authorizationRound++;preparedTraining=undefined;
        res.writeHead(303,{Location:'/#'+key}).end();
      } catch {
        res.writeHead(400).end('RoboGO 授权未完成。请回课堂工作台重新连接。');
      }
      return;
    }
    if(['/robogo/connect','/robogo/state','/robogo/refresh','/robogo/prepare','/robogo/submit'].includes(url.pathname)) {
      if(req.headers['x-workshop-session']!==key||req.headers.origin&&req.headers.origin!=='http://'+host) {
        res.writeHead(404).end();return;
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      try {
        if(req.method==='GET'&&url.pathname==='/robogo/state') {
          const profile=stateFile?await trainingProfile().then(()=>({profileConfigured:true}),
            error=>({profileConfigured:false,profileIssue:error.message})):
            {profileConfigured:false,profileIssue:'robogo_state_required'};
          return res.end(JSON.stringify({connected:roboGo.connected(),...profile,uncertainTraining:submission==='pending'}));
        }
        if(req.method!=='POST') {res.writeHead(405).end();return;}
        if(url.pathname==='/robogo/connect') {
          authorizationRound++;preparedTraining=undefined;
          return res.end(JSON.stringify(await roboGo.authorize('http://'+host)));
        }
        if(url.pathname==='/robogo/refresh') return res.end(JSON.stringify(await refreshRoboGo()));
        if(url.pathname==='/robogo/prepare') return res.end(JSON.stringify(await prepareTraining()));
        if(url.pathname==='/robogo/submit') {
          const id=req.headers['x-workshop-confirmation'];
          return res.end(JSON.stringify(await submitTraining(id)));
        }
        res.writeHead(405).end();
      } catch(error) {
        const code=/^robogo_[a-z_]+$/.test(error.message)?error.message:'robogo_unavailable';
        res.writeHead(code==='robogo_login_required'?401:422).end(JSON.stringify({error:code}));
      }
      return;
    }
    if(url.pathname==='/training/receipt'||url.pathname==='/board/receipt'||url.pathname.startsWith('/board/file/')) {
      if(req.method!=='GET'||req.headers['x-workshop-session']!==key) {res.writeHead(404).end();return;}
      try {
        if(url.pathname.startsWith('/board/file/')) {
          const result=await selectedBoard().file(selectedModelHash(),url.pathname.slice('/board/file/'.length),url.searchParams.get('receipt'));
          res.setHeader('Content-Type',result.type);res.end(result.bytes);return;
        }
        const result=url.pathname==='/training/receipt'?await externalTrainingReceipt():(await selectedBoard().get(selectedModelHash())).view;
        res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));
      } catch(error) {
        const code=evidenceErrors.has(error.message)?error.message:'evidence_file_invalid';
        res.setHeader('Content-Type','application/json; charset=utf-8');res.writeHead(422).end(JSON.stringify({error:code}));
      }
      return;
    }
    if(url.pathname==='/camera/isp') {
      if(req.headers['x-workshop-session']!==key||req.headers.origin&&req.headers.origin!=='http://'+host) {
        res.writeHead(404).end();return;
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.method==='GET') {
        const file=url.searchParams.get('file');
        if(file) {
          const round=url.searchParams.get('round');
          const source=()=>{
            const status=storedIsp();
            return round===null?status:status?.rounds?.find(item=>String(item.number)===round);
          };
          if(['before','after','restored','reloaded'].includes(file)) {
            const match=()=>round===null&&['before','after'].includes(file)?source()?.gamma?.[file]:source()?.[file];
            const asset=match();
            if(!asset||asset.sha256!==url.searchParams.get('sha256')) {
              res.writeHead(404).end(JSON.stringify({error:'camera_archive_missing'}));return;
            }
            try {
              const bytes=await cameraSource.captureFile(resume.camera,'isp',asset);
              if(match()?.sha256!==asset.sha256) throw new Error('camera_archive_missing');
              res.setHeader('Content-Type',bytes.type);res.end(bytes.bytes);
            } catch(error) {res.writeHead(422).end(JSON.stringify({error:'camera_isp_evidence_unavailable'}));}
            return;
          }
          const value=['original','readback','gammaReadback','reloadReadback','beforeReadback','decisionReadback','resetReadback'].includes(file)?source()?.[file]:undefined;
          if(!value||value.hash!==url.searchParams.get('sha256')) {
            res.writeHead(404).end(JSON.stringify({error:'camera_isp_snapshot_missing'}));return;
          }
          res.end(JSON.stringify(value,null,2));return;
        }
        res.end(JSON.stringify({isp:ispStatus()}));return;
      }
      if(req.method!=='POST'||req.headers['content-type']!=='application/json') {res.writeHead(405).end();return;}
      try {
        const chunks=[];
        let size=0;
        for await(const chunk of req) {
          if((size+=chunk.length)>1024) {res.writeHead(413).end();return;}
          chunks.push(chunk);
        }
        const body=JSON.parse(Buffer.concat(chunks));
        if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['action','goal','round','choice','reason'].includes(k))) throw new Error('camera_isp_action_invalid');
        const result=queueIsp(body.action,body.goal,body);
        res.writeHead(202).end(JSON.stringify({isp:result}));
      } catch(error) {
        const code=/^camera_[a-z0-9_]{1,90}$/.test(error.message)?error.message:'camera_isp_action_invalid';
        res.writeHead(code==='camera_capture_busy'?409:422).end(JSON.stringify({error:code}));
      }
      return;
    }
    if(url.pathname==='/camera/preflight') {
      if(req.headers['x-workshop-session']!==key||req.headers.origin&&req.headers.origin!=='http://'+host) {
        res.writeHead(404).end();return;
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.method==='GET') {res.end(JSON.stringify({preflight:readPreflight()}));return;}
      if(req.method!=='POST'||req.headers['content-type']!=='application/json') {res.writeHead(405).end();return;}
      try {
        const result=queuePreflight();
        res.writeHead(202).end(JSON.stringify({preflight:result}));
      } catch(error) {res.writeHead(409).end(JSON.stringify({error:error.message}));}
      return;
    }
    if(url.pathname==='/camera/capture'||url.pathname.startsWith('/camera/capture/file/')) {
      if(req.headers['x-workshop-session']!==key||req.headers.origin&&req.headers.origin!=='http://'+host) {
        res.writeHead(404).end();return;
      }
      try {
        if(url.pathname.startsWith('/camera/capture/file/')&&req.method==='GET') {
          const kind=url.pathname.slice('/camera/capture/file/'.length);
          const capture=captureStatus();
          const asset=capture&&Object.hasOwn(capture.assets,kind)?capture.assets[kind]:undefined;
          if(!asset||asset.id!==url.searchParams.get('id')) throw new Error('camera_archive_missing');
          const file=await cameraSource.captureFile(resume.camera,kind,asset,url.searchParams.get('preview')==='1');
          if(asset.id!==captureStatus()?.assets[kind]?.id) throw new Error('camera_archive_missing');
          res.setHeader('Content-Type',file.type);res.end(file.bytes);return;
        }
        if(url.pathname!=='/camera/capture') {res.writeHead(405).end();return;}
        res.setHeader('Content-Type','application/json; charset=utf-8');
        if(req.method==='GET') {res.end(JSON.stringify({capture:captureStatus(),recordingRevision:revision}));return;}
        if(req.method!=='POST'||req.headers['content-type']!=='application/json') {res.writeHead(405).end();return;}
        const chunks=[];
        let size=0;
        for await(const chunk of req) {
          if((size+=chunk.length)>2048) {res.writeHead(413).end();return;}
          chunks.push(chunk);
        }
        let body;
        try {body=JSON.parse(Buffer.concat(chunks));} catch {throw new Error('camera_capture_invalid');}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','scene'].includes(k))) throw new Error('camera_capture_invalid');
        const capture=queueCapture(body.action,body.scene);
        res.writeHead(202).end(JSON.stringify({capture}));
      } catch(error) {
        const code=/^camera_[a-z0-9_]{1,90}$/.test(error.message)?error.message:'camera_service_error';
        res.setHeader('Content-Type','application/json; charset=utf-8');
        res.writeHead(code==='camera_archive_missing'?404:code==='camera_capture_busy'?409:422).end(JSON.stringify({error:code}));
      }
      return;
    }
    if (url.pathname==='/camera'||url.pathname==='/camera/experiments'||url.pathname.startsWith('/camera/frame/')) {
      if(req.method!=='GET'||req.headers['x-workshop-session']!==key) { res.writeHead(404).end(); return; }
      try {
        if(url.pathname==='/camera/experiments') {
          const experiments=await cameraSource.list();
          res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({experiments}));return;
        }
        const binding=resume.camera;
        if(!binding) throw new Error('camera_binding_invalid');
        const report=url.pathname==='/camera'||!inspected?await cameraSource.inspect(binding):inspected;
        if(binding!==resume.camera && JSON.stringify(binding)!==JSON.stringify(resume.camera)) throw new Error('camera_binding_invalid');
        if(url.pathname==='/camera') {
          inspected=report;
          res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(report));return;
        }
        const file=await cameraSource.frame(binding,url.pathname.slice('/camera/frame/'.length),report);
        if(JSON.stringify(binding)!==JSON.stringify(resume.camera)) throw new Error('camera_binding_invalid');
        res.setHeader('Content-Type',file.type);res.end(file.bytes);
      } catch(error) {
        const code=cameraErrors.has(error.message)?error.message:'camera_service_error';
        res.setHeader('Content-Type','application/json; charset=utf-8');res.writeHead(code==='camera_archive_missing'?404:422).end(JSON.stringify({error:code}));
      }
      return;
    }
    if (url.pathname==='/session') {
      if (req.headers['x-workshop-session']!==key) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if (req.method==='GET') { res.end(JSON.stringify(read())); return; }
      if (req.method!=='POST'||req.headers['content-type']!=='application/json' ||
          req.headers.origin&&req.headers.origin!=='http://'+host) { res.writeHead(405).end(); return; }
      try {
        let size=0;
        const chunks=[];
        for await (const chunk of req) {
          size+=chunk.length;
          if (size>65536) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.end(JSON.stringify(update(input.patch,input.clearBlockers,input.replace===true)));
      } catch(error) { res.writeHead(400).end(JSON.stringify({error:error.message})); }
      return;
    }
    if (req.method!=='GET') { res.writeHead(404).end(); return; }
    if (url.pathname==='/course.json') {
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({plan, ...(url.searchParams.get('view')===key?read():{})}));
      return;
    }
    const file=files.get(url.pathname);
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type',file[0]+'; charset=utf-8');
    res.end(file[1]);
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',resolve);
  });
  server.once('close',()=>clearTimeout(idle));
  keepAlive();
  return {server, read, update, url:'http://127.0.0.1:'+server.address().port+'/#'+key};
}

const entry=process.argv[1];
if(entry && existsSync(entry) && import.meta.url===pathToFileURL(realpathSync(entry)).href) {
  const supported=new Set(['--resume','--port']);
  const flags=process.argv.slice(2);
  if (flags.length%2 || flags.some((v,i)=>i%2===0&&!supported.has(v))) throw new Error('usage: node mcp/workbench.mjs [--resume FILE] [--port PORT]');
  const opt=Object.fromEntries(flags.reduce((all,v,i)=>i%2===0?[...all,[v,flags[i+1]]]:all,[]));
  const source=opt['--resume']?JSON.parse(readFileSync(opt['--resume'],'utf8')):{};
  const result=await startWorkbench(source.resume??source, Number(opt['--port']??0));
  console.log(result.url);
}
