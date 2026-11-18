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
  ['/board-panel.mjs', ['text/javascript', '../web/board-panel.mjs']],
  ['/zip.mjs', ['text/javascript', '../web/zip.mjs']],
  ['/guide.mjs', ['text/javascript', './guide.mjs']],
  ['/steps.mjs', ['text/javascript', './steps.mjs']],
]);
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
  const persist=(next=resume)=>writeWorkbenchState(stateFile,{resume:next,submission,verifiedRun,lockedRun,cameraCapture});
  const selectedModelHash=()=>resume.path==='B'?presetModelHash(resume.evidence.preset_model)
    :resume.path==='C'||resume.run?.source==='robogo'&&resume.run.modelSha256!==normalizedModelHash(resume.evidence.x5_model_hash)
      ?undefined:normalizedModelHash(resume.evidence.x5_model_hash);
  function checkTrainingWindow() {
    if(!stateFile) throw new Error('robogo_state_required');
    if(resume.run||resume.evidence.run_id) throw new Error('robogo_run_exists');
    if(submittingTraining||submission!=='idle') throw new Error('robogo_submit_unconfirmed');
    const minute=resume.elapsedMinutes;
    if(minute===undefined||minute<plan.deadlines.submitStart||minute>=plan.deadlines.submitBy) throw new Error('robogo_submit_window');
    if(guideCourse(plan,resume).nextStep?.stageId!=='train') throw new Error('robogo_training_step_required');
  }
  async function prepareTraining() {
    checkTrainingWindow();
    const round=authorizationRound;
    const profile=await trainingProfile();
    const ref=await roboGo.prepare(profile.input);
    checkTrainingWindow();
    if(round!==authorizationRound) throw new Error('robogo_plan_changed');
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
      const result=await roboGo.refresh(run.id);
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
    if(cameraJob) throw new Error('camera_capture_busy');
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
      const verified=run.source==='robogo'&&run.id===verifiedRun?.id?verifiedRun.modelSha256:undefined;
      candidate.run={...run,...(verified?{modelSha256:verified}:{})};
    }
    if (!replace&&patch.path&&patch.path!==current.path&&candidate.elapsedMinutes!==undefined&&candidate.elapsedMinutes<plan.deadlines.deployAt) {
      throw new Error('route_not_open');
    }
    const next=guideCourse(plan,candidate).resume;
    if(cameraJob&&next.camera?.experimentId!==resume.camera?.experimentId) throw new Error('camera_capture_busy');
    const changed=JSON.stringify(next)!==JSON.stringify(resume);
    if(changed||submission!=='idle'||verifiedRun) persist(next);
    if (changed) {
      if(JSON.stringify(next.camera)!==JSON.stringify(resume.camera)) inspected=undefined;
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
        if(req.method==='GET'&&url.pathname==='/robogo/state') return res.end(JSON.stringify({connected:roboGo.connected(),
          profileConfigured:Boolean(process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE)&&Boolean(stateFile),uncertainTraining:submission==='pending'}));
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
