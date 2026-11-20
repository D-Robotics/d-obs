import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { cameraIdPattern } from './steps.mjs';

const mcpSuffix='/api/ops/vision-workshop/mcp';
const restSuffix='/api/ops/observability/vision-workshop';
const maxBytes=16*1024*1024;
const maxRawBytes=64*1024*1024;
const cameraId=new RegExp(cameraIdPattern);
const hash=/^[a-f0-9]{64}$/;
const mimeTypes=new Set(['image/png','image/jpeg']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function readbackDetails(receipt, experiment) {
  if(!receipt) return undefined;
  const value=receipt.evidence.result.readbackHash;
  const saved=[experiment.baseline,...(Array.isArray(experiment.baselineHistory)?experiment.baselineHistory:[])].find(item=>item?.hash===value);
  const gamma=saved?.tuning?.modules?.gamma;
  const result={id:receipt.id,hash:value,recordedAt:receipt.createdAt};
  if(!gamma||sha256(JSON.stringify(saved.tuning))!==value) return result;
  const mode=gamma.mode;
  const table=mode===0?gamma['auto_attr.curve']:mode===1?gamma['manual_attr.curve']:undefined;
  const nodes=mode===0&&Array.isArray(table)?table.slice(0,64):table;
  if(!Array.isArray(nodes)||nodes.length!==64||nodes.some(node=>!Number.isSafeInteger(node)||node<0||node>1023)) return result;
  return {...result,gamma:{mode:mode===0?'AUTO':'MANUAL',nodes, ...(mode===0&&Number.isInteger(gamma['auto_attr.auto_level'])?{autoRows:gamma['auto_attr.auto_level']}:{})}};
}

async function readPrivate(file,limit) {
  if (typeof file!=='string'||!path.isAbsolute(file)) throw new Error('camera_configuration_invalid');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>limit||process.platform!=='win32'&&((stat.mode&0o777)!==0o600||stat.uid!==process.getuid())) {
      throw new Error('camera_configuration_invalid');
    }
    const bytes=await handle.readFile();
    if(bytes.length>limit) throw new Error('camera_configuration_invalid');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } finally { await handle.close(); }
}

async function responseBytes(response,limit) {
  if (Number(response.headers.get('content-length'))>limit||!response.body) {
    await response.body?.cancel();
    throw new Error('camera_response_invalid');
  }
  const reader=response.body.getReader();
  const chunks=[];
  let length=0;
  for (;;) {
    const {done,value}=await reader.read();
    if(done) return Buffer.concat(chunks,length);
    if((length+=value.byteLength)>limit) { await reader.cancel(); throw new Error('camera_response_invalid'); }
    chunks.push(Buffer.from(value));
  }
}

export function createCameraSource(configFile=process.env.RDK_CAMERA_WORKSHOP_CONFIG??path.join(homedir(),'.config','rdk-camera-workshop','connection.json')) {
  async function fetchArchive(suffix,{body,limit=maxBytes}={}) {
    let result;
    try {
      const config=JSON.parse(await readPrivate(configFile,32768));
      const url=new URL(config.url);
      if(url.username||url.password||url.search||url.hash||!url.pathname.endsWith(mcpSuffix)||
          !(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))||
          !['admin','sso'].includes(config.auth?.type)) throw new Error('camera_configuration_invalid');
      const secret=(await readPrivate(config.auth.credentialFile,16384)).trim();
      if(!secret||/[\u0000-\u001f\u007f]/u.test(secret)) throw new Error('camera_configuration_invalid');
      result={url:url.origin+url.pathname.slice(0,-mcpSuffix.length)+restSuffix,
        headers:{[config.auth.type==='admin'?'x-admin-token':'x-rdk-sso-session']:secret}};
    } catch(error) {
      throw new Error(error.code==='ENOENT'?'camera_unconfigured':'camera_configuration_invalid');
    }
    let response;
    const headers={...result.headers,...(body===undefined?{}:{'content-type':'application/json','x-rdk-ops-action':'observability'})};
    try { response=await fetch(result.url+suffix,{headers,redirect:'error',
      ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(body===undefined?15000:120000)}); }
    catch { throw new Error(body===undefined?'camera_service_unreachable':'camera_capture_unconfirmed'); }
    if(!response.ok) {
      if(response.status===401||response.status===403) {
        await response.body?.cancel();
        throw new Error('camera_auth_required');
      }
      if(body!==undefined&&response.headers.get('content-type')?.startsWith('application/json')) {
        const bytes=await responseBytes(response,256*1024);
        let receipt;
        try {receipt=JSON.parse(bytes.toString('utf8'));} catch {}
        if(/^vision_[a-z0-9_]{1,90}$/.test(receipt?.error)) throw new Error(receipt.error);
        throw new Error('camera_service_error');
      }
      await response.body?.cancel();
      throw new Error(response.status===404?'camera_archive_missing':'camera_service_error');
    }
    try {return {type:response.headers.get('content-type')?.split(';')[0],bytes:await responseBytes(response,limit)};}
    catch(error) {
      if(body!==undefined&&(error instanceof TypeError||['AbortError','TimeoutError'].includes(error.name))) throw new Error('camera_capture_unconfirmed');
      throw error;
    }
  }
  async function json(suffix,options) {
    const {bytes,type}=await fetchArchive(suffix,options);
    try {
      const result=JSON.parse(bytes.toString('utf8'));
      if(type!=='application/json'||!record(result)||result.ok!==true) throw new Error();
      return result;
    } catch { throw new Error('camera_response_invalid'); }
  }
  async function list() {
    const {experiments}=await json('/experiments?view=index&limit=30');
    if(!Array.isArray(experiments)) throw new Error('camera_response_invalid');
    return experiments.filter(exp=>cameraId.test(exp?.id)&&typeof exp.title==='string').map(exp=>({id:exp.id,title:exp.title,sensorModel:exp.sensorModel,updatedAt:exp.updatedAt}));
  }
  async function experimentArchive(binding) {
    if(!cameraId.test(binding?.experimentId)||binding.runId!==undefined&&!cameraId.test(binding.runId)) throw new Error('camera_binding_invalid');
    const {experiment}=await json('/experiments/'+binding.experimentId);
    if(experiment?.id!==binding.experimentId||!Array.isArray(experiment.cameraFrames)||!Array.isArray(experiment.deviceRuns)) throw new Error('camera_response_invalid');
    return experiment;
  }
  async function inspect(binding) {
    const experiment=await experimentArchive(binding);
    const route='/experiments/'+experiment.id;
    const target=typeof experiment.targetId==='string'&&experiment.targetId;
    const receipts=target?experiment.deviceRuns.filter(item=>item?.adapterId===target):[];
    const latestProbe=receipts.findLast(item=>item.operation==='probe');
    const readback=receipts.findLast(item=>item.operation==='tuning_get'&&item.status==='completed'&&hash.test(item.evidence?.result?.readbackHash));
    const frames=experiment.cameraFrames.filter(frame=>target&&frame?.source==='runner'&&frame.adapterId===target&&
      cameraId.test(frame.id)&&mimeTypes.has(frame.mimeType)&&hash.test(frame.hash)&&Number.isSafeInteger(frame.byteLength)&&frame.byteLength>0&&frame.byteLength<=maxBytes)
      .map(frame=>{
        const receipt=receipts.findLast(item=>item.operation==='capture_frame'&&item.status==='completed'&&item.evidence?.result?.sha256===frame.hash&&item.evidence.result.tuningHash===frame.tuningHash);
        const sdkTimestampNs=receipt?.evidence?.result?.evidence?.sdkTimestampNs;
        return {id:frame.id,sha256:frame.hash,byteLength:frame.byteLength,mimeType:frame.mimeType,tuningHash:frame.tuningHash,
          scene:frame.scene, width:frame.width,height:frame.height, archivedAt:frame.createdAt,
          ...(sdkTimestampNs?{sdkTimestampNs,receiptId:receipt.id}:{})};
      });
    const recent=frames.slice(-8).reverse();
    let activeRun;
    const savedRuns=Array.isArray(experiment.aiDebugRuns)?experiment.aiDebugRuns.filter(run=>cameraId.test(run?.id)):[];
    if(binding.runId) {
      const {run}=await json(route+'/ai-debug/runs/'+binding.runId);
      if(run?.id!==binding.runId||run.source!=='model') throw new Error('camera_response_invalid');
      const change=Array.isArray(run.iterations)?run.iterations.findLast(item=>item.action==='adjust'&&item.after):undefined;
      const before=frames.find(frame=>frame.id===change?.before?.frameId&&frame.sha256===change.before.frameHash);
      const after=frames.find(frame=>frame.id===change?.after?.frameId&&frame.sha256===change.after.frameHash);
      const pair=before&&after&&before.id!==after.id&&hash.test(change.readbackHash)&&after.tuningHash===change.readbackHash?{before,after}:undefined;
      activeRun={id:run.id,status:run.status,adjustmentCount:run.adjustmentCount,updatedAt:run.updatedAt,
        issue:run.restorationError??run.error,restored:run.final?.restored===true,
        ...(pair?{pair,readbackHash:change.readbackHash}:{} )};
    }
    return {experiment:{id:experiment.id,title:experiment.title,board:experiment.board,sensorModel:experiment.sensorModel,
      cameraMode:experiment.cameraMode,targetId:experiment.targetId},
      probe:latestProbe&&{status:latestProbe.status,recordedAt:latestProbe.createdAt},
      readback:readbackDetails(readback,experiment),
      frames:recent,runs:savedRuns.slice(-12).reverse().map(run=>({id:run.id,status:run.status,updatedAt:run.updatedAt})),activeRun};
  }
  async function frame(binding,frameId,known) {
    if(!cameraId.test(frameId)) throw new Error('camera_archive_missing');
    const report=known??await inspect(binding);
    if(report.experiment.id!==binding.experimentId) throw new Error('camera_archive_missing');
    const pair=report.activeRun?.pair;
    const asset=[...report.frames,...(pair?[pair.before,pair.after]:[])].find(item=>item.id===frameId);
    if(!asset) throw new Error('camera_archive_missing');
    const contents=await fetchArchive('/experiments/'+binding.experimentId+'/frames/'+asset.id);
    if(contents.type!==asset.mimeType||contents.bytes.length!==asset.byteLength||sha256(contents.bytes)!==asset.sha256) {
      throw new Error('camera_frame_integrity_failed');
    }
    return contents;
  }
  async function device(experiment,operation,body) {
    const data=await json('/experiments/'+experiment.id+'/device/'+operation,{body});
    if(data.operation!==operation||data.deviceRun?.status!=='completed'||
      data.deviceRun.adapterId!==experiment.targetId||!cameraId.test(data.deviceRun.id)) throw new Error('camera_response_invalid');
    return data;
  }
  async function ispReadback(experiment,{captureSnapshot=false}={}) {
    if(!experiment.targetId) throw new Error('vision_device_adapter_required');
    // tuning_get creates a new SDK snapshot ID. Verification must read the
    // current modules while preserving the snapshot bound to the candidate.
    const receipt=await device(experiment,captureSnapshot?'tuning_get':'tuning_export',{});
    const config=receipt.result?.baseline?.config??receipt.result?.config;
    const readbackHash=receipt.result?.readbackHash;
    if(!record(config)||!hash.test(readbackHash)||sha256(JSON.stringify(config))!==readbackHash) {
      throw new Error('camera_isp_readback_invalid');
    }
    return {config,hash:readbackHash,receiptId:receipt.deviceRun.id,recordedAt:new Date().toISOString()};
  }
  async function saveOriginalIsp(binding) {
    const experiment=await experimentArchive(binding);
    if(!experiment.targetId) throw new Error('vision_device_adapter_required');
    const {result}=await device(experiment,'probe',{});
    if(result.facts?.cleanupRequired===true||result.facts?.writeOutcome==='unconfirmed') throw new Error('camera_recovery_required');
    if(result.facts?.streaming!==true) throw new Error('camera_isp_stream_required');
    const original=await ispReadback(experiment,{captureSnapshot:true});
    const saved=await experimentArchive(binding);
    const version=[saved.baseline,...(saved.baselineHistory??[])].find(entry=>entry?.hash===original.hash&&cameraId.test(entry.id));
    if(saved.targetId!==experiment.targetId||!version||sha256(JSON.stringify(version.tuning))!==original.hash) {
      throw new Error('camera_isp_snapshot_missing');
    }
    return {...original,baselineId:version.id,adapterId:experiment.targetId};
  }
  async function restoreOriginalIsp(binding,original,{previousReadback,onPhase,stopStream=true,captureRestored=true}) {
    const experiment=await experimentArchive(binding);
    const saved=[experiment.baseline,...(experiment.baselineHistory??[])].find(item=>item?.id===original.baselineId);
    if(experiment.targetId!==original.adapterId||!cameraId.test(original.baselineId)||
        !record(saved?.tuning)||saved.hash!==original.hash||sha256(JSON.stringify(saved.tuning))!==original.hash||
        sha256(JSON.stringify(original.config))!==original.hash) {
      throw new Error('camera_isp_snapshot_changed');
    }
    // A full experiment still accepts restore_tuning and preview_stop. Read
    // operations consume ordinary history, so those two actions must also be
    // able to complete using the SDK getter returned by restore_tuning.
    const ordinary=async operation=>{
      try { return await operation(); }
      catch (error) { if(error.message!=='vision_device_history_capacity') throw error; }
    };
    const probe=await ordinary(()=>device(experiment,'probe',{}));
    const facts=probe?.result?.facts;
    if(probe) {
      if(!record(facts)||typeof facts.streaming!=='boolean'||facts.cleanupRequired===true) throw new Error('camera_recovery_required');
      if(facts.writeOutcome==='unconfirmed'&&facts.recoveryOriginalHash!==original.hash) {
        throw new Error('camera_isp_snapshot_changed');
      }
      if(facts.streaming===false) {
        if(stopStream&&previousReadback?.hash===original.hash&&facts.writeOutcome!=='unconfirmed') {
          return {readback:previousReadback,stop:{alreadyStopped:true,receiptId:probe.deviceRun.id}};
        }
        if(facts.writeOutcome!=='unconfirmed') throw new Error('camera_isp_stream_required');
      }
    }
    let readback;
    if(facts&&facts.writeOutcome!=='unconfirmed') {
      onPhase('readback');
      readback=await ordinary(()=>ispReadback(experiment));
    }
    if(readback?.hash!==original.hash) {
      onPhase('restore');
      const {result,deviceRun}=await device(experiment,'restore_tuning',{baselineId:original.baselineId});
      if(result?.appliedHash!==original.hash||result.readbackHash!==original.hash) throw new Error('camera_isp_restore_unconfirmed');
      onPhase('readback');
      if(probe) readback=await ordinary(()=>ispReadback(experiment));
      if(!readback) {
        const config=result.evidence?.config;
        if(!record(config)||sha256(JSON.stringify(config))!==original.hash) throw new Error('camera_isp_restore_unconfirmed');
        readback={config,hash:result.readbackHash,receiptId:deviceRun.id,recordedAt:new Date().toISOString(),
          verification:'restore_tuning_sdk_readback'};
      }
      if(readback.hash!==original.hash) throw new Error('camera_isp_restore_unconfirmed');
    }
    if(!stopStream) {
      if(!captureRestored) return {readback};
      try {
        const restored=await capture(binding,'isp',{scene:'课堂 Gamma 对照 · 恢复后'});
        if(restored.tuningHash!==original.hash||!restored.sdkTimestampNs) throw new Error('camera_isp_readback_invalid');
        return {readback,restored};
      } catch(error) {
        return {readback,comparisonIssue:error.message};
      }
    }
    onPhase('stop',readback);
    const stopped=await device(experiment,'preview_stop',{});
    if(stopped.result?.running!==false) throw new Error('camera_stop_unconfirmed');
    return {readback,stop:{receiptId:stopped.deviceRun.id}};
  }
  async function exposureTrial(binding,original,onPhase) {
    const experiment=await experimentArchive(binding);
    if(original.config.kind!=='x5-hbn-isp-v2'||experiment.targetId!==original.adapterId||
        experiment.baseline?.id!==original.baselineId||experiment.baseline.hash!==original.hash) {
      throw new Error('camera_isp_snapshot_changed');
    }
    const {result}=await device(experiment,'probe',{});
    if(result.facts?.cleanupRequired===true||result.facts?.writeOutcome==='unconfirmed') throw new Error('camera_recovery_required');
    if(result.facts?.streaming!==true) throw new Error('camera_isp_stream_required');
    if((await ispReadback(experiment)).hash!==original.hash) throw new Error('camera_isp_snapshot_changed');
    const readControls=async()=>{
      // controls_get has no ledger entry. The full tuning_export below supplies independent receipts.
      const {operation,result}=await json('/experiments/'+experiment.id+'/device/controls_get',{body:{}});
      if(operation!=='controls_get'||!record(result?.controls)) throw new Error('camera_response_invalid');
      if(result.evidence?.writeOutcome==='unconfirmed') throw new Error('camera_recovery_required');
      return result.controls;
    };
    const controls=await readControls();
    const initial=controls.exposureUs;
    if(typeof controls.autoExposure?.value!=='boolean'||!Number.isFinite(controls.gain?.value)||
        ![initial?.value,initial?.min,initial?.max,initial?.nativeLinePeriodUs].every(Number.isFinite)||
        initial.nativeLinePeriodUs<=0||initial.nativePrecision!=='seconds-float32-us'||
        controls.autoExposure.value&&!controls.autoExposure.writable) throw new Error('camera_exposure_unavailable');
    let modeReceipt;
    if(controls.autoExposure.value) {
      onPhase('exposure_manual',undefined,true);
      const {deviceRun}=await device(experiment,'controls_set',{values:{autoExposure:false}});
      modeReceipt=deviceRun.id;
    }
    const manual=modeReceipt?await readControls():controls;
    const time=manual.exposureUs;
    const gain=manual.gain?.value;
    if(manual.autoExposure?.value!==false||!time?.active||!time.writable||!Number.isFinite(gain)||
        ![time.value,time.min,time.max,time.nativeLinePeriodUs].every(Number.isFinite)||
        time.nativeLinePeriodUs!==initial.nativeLinePeriodUs||time.nativePrecision!==initial.nativePrecision) {
      throw new Error('camera_exposure_unavailable');
    }
    const line=time.nativeLinePeriodUs;
    const lines=Math.max(Math.ceil(time.min/line-1e-5),Math.round(time.value/line/2));
    const targetUs=Math.fround(lines*line/1e6)*1e6;
    if(targetUs<time.min||targetUs>time.max||targetUs>=time.value) throw new Error('camera_exposure_no_room');
    const verifyExposure=(readback,expectedUs)=>{
      const exposure=readback.config.modules?.exposure;
      if(exposure?.mode!==1||exposure['manual_attr.exp_time']*1e6!==expectedUs||exposure['manual_attr.again']!==gain) {
        throw new Error('camera_exposure_readback_mismatch');
      }
    };
    onPhase('exposure_before');
    const beforeReadback=await ispReadback(experiment);
    verifyExposure(beforeReadback,time.value);
    const before=await capture(binding,'isp',{scene:'讲师曝光对照 · 手动基线'});
    if(before.tuningHash!==beforeReadback.hash||!before.sdkTimestampNs) throw new Error('camera_exposure_freshness_failed');
    onPhase('exposure_apply',{before,beforeReadback,beforeUs:time.value,targetUs,gain,modeReceipt},true);
    const {deviceRun}=await device(experiment,'controls_set',{values:{exposureUs:targetUs}});
    onPhase('exposure_verify',{writeReceipt:deviceRun.id});
    const afterReadback=await ispReadback(experiment);
    verifyExposure(afterReadback,targetUs);
    const withoutTime=config=>{
      const {exposure,...otherModules}=config.modules;
      const {'manual_attr.exp_time':_time,...otherExposure}=exposure;
      return {...config,modules:{...otherModules,exposure:otherExposure}};
    };
    if(JSON.stringify(withoutTime(beforeReadback.config))!==JSON.stringify(withoutTime(afterReadback.config))) {
      throw new Error('camera_exposure_readback_mismatch');
    }
    const after=await capture(binding,'isp',{scene:'讲师曝光对照 · 缩短曝光'});
    if(after.tuningHash!==afterReadback.hash||!after.sdkTimestampNs||after.id===before.id||
        BigInt(after.sdkTimestampNs)<=BigInt(before.sdkTimestampNs)) throw new Error('camera_exposure_freshness_failed');
    onPhase('exposure_verify',{after,afterReadback,afterUs:targetUs});
  }
  async function gammaTrial(binding,original,goal,onPhase) {
    const experiment=await experimentArchive(binding);
    if(experiment.targetId!==original.adapterId||experiment.baseline?.id!==original.baselineId||
        experiment.baseline.hash!==original.hash) {
      throw new Error('camera_isp_snapshot_changed');
    }
    const beforeReadback=await ispReadback(experiment);
    if(beforeReadback.hash!==original.hash) throw new Error('camera_isp_snapshot_changed');
    onPhase('gamma_before');
    const before=await capture(binding,'isp',{scene:'课堂 Gamma 对照 · 原始'});
    if(before.tuningHash!==original.hash||!before.sdkTimestampNs) throw new Error('camera_isp_readback_invalid');
    onPhase('gamma_plan',{before});
    const {candidate}=await json('/experiments/'+experiment.id+'/candidates',
      {body:{frameIds:[before.id],goal:'课程 Gamma 单次对照，只允许修改 Gamma 曲线，不切换模式。观察目标：'+goal}});
    const mode=original.config.modules?.gamma?.mode;
    const field=mode===0?'auto_attr.curve':mode===1?'manual_attr.curve':undefined;
    const stripCurve=config=>{
      const {gamma,...otherModules}=config.modules??{};
      const {[field]:_curve,...settings}=gamma??{};
      return {...config,modules:{...otherModules,gamma:settings}};
    };
    if(!field||!Array.isArray(candidate?.tuning?.modules?.gamma?.[field])||
        candidate?.source!=='model'||!cameraId.test(candidate.id)||candidate.baselineHash!==original.hash||
        candidate.baselineId!==original.baselineId||!candidate.frameIds?.includes(before.id)||
        !hash.test(candidate.hash)||!record(candidate.tuning)||sha256(JSON.stringify(candidate.tuning))!==candidate.hash||
        candidate.hash===original.hash||!Array.isArray(candidate.patches)||!candidate.patches.length||
        candidate.patches.some(patch=>typeof patch.path!=='string'||!patch.path.startsWith('/modules/gamma/'))||
        JSON.stringify(stripCurve(candidate.tuning))!==JSON.stringify(stripCurve(original.config))) {
      throw new Error('camera_gamma_candidate_rejected');
    }
    if((await ispReadback(experiment)).hash!==original.hash) throw new Error('camera_isp_snapshot_changed');
    onPhase('gamma_apply',{before,candidateId:candidate.id},true);
    const result=await applyGammaFrame(binding,experiment,candidate,before.sdkTimestampNs,()=>onPhase('gamma_verify'));
    return {before,beforeReadback,...result,candidateId:candidate.id};
  }
  async function confirmIsp(binding,original,expectedHash) {
    const experiment=await experimentArchive(binding);
    if(experiment.targetId!==original.adapterId) throw new Error('camera_isp_snapshot_changed');
    const readback=await ispReadback(experiment);
    if(readback.hash!==expectedHash) throw new Error('camera_isp_snapshot_changed');
    return readback;
  }
  async function applyGammaFrame(binding,experiment,candidate,previousTimestamp,onReadback) {
    const {result}=await device(experiment,'apply_tuning',{candidateId:candidate.id});
    if(result?.appliedHash!==candidate.hash||result.readbackHash!==candidate.hash) throw new Error('camera_isp_restore_unconfirmed');
    onReadback();
    const readback=await ispReadback(experiment);
    const after=await capture(binding,'isp',{scene:'课堂 Gamma 对照 · 候选',candidateId:candidate.id});
    if(readback.hash!==candidate.hash||after.tuningHash!==readback.hash||!after.sdkTimestampNs||
        BigInt(after.sdkTimestampNs)<=BigInt(previousTimestamp)) throw new Error('camera_gamma_freshness_failed');
    return {after,readback};
  }
  async function reloadGamma(binding,original,candidate,restored,onPhase) {
    const experiment=await experimentArchive(binding);
    if(experiment.targetId!==original.adapterId||(await ispReadback(experiment)).hash!==original.hash) {
      throw new Error('camera_isp_snapshot_changed');
    }
    onPhase('gamma_apply',true);
    return applyGammaFrame(binding,experiment,candidate,restored.sdkTimestampNs,()=>onPhase('gamma_verify'));
  }
  async function capture(binding,kind,{scene,raw,candidateId}={}) {
    const {experiment}=await inspect({...binding,runId:undefined});
    if(!experiment.targetId) throw new Error('vision_device_adapter_required');
    let readbackHash;
    if(kind==='render') {
      const readback=await device(experiment,'tuning_get',{});
      readbackHash=readback.result?.readbackHash;
      if(!hash.test(readbackHash)) throw new Error('camera_response_invalid');
    }
    const operation=kind==='raw'?'capture_raw':kind==='render'?'process_raw':'capture_frame';
    const {asset,deviceRun,result}=await device(experiment,operation,kind==='render'?{sampleId:raw.id}:{scene,...(candidateId?{candidateId}:{})});
    const width=kind==='raw'?asset?.metadata?.width:asset?.width;
    const height=kind==='raw'?asset?.metadata?.height:asset?.height;
    const mimeType=kind==='raw'?'application/octet-stream':asset?.mimeType;
    if(asset?.source!=='runner'||asset.adapterId!==experiment.targetId||!cameraId.test(asset.id)||!hash.test(asset.hash)||
      !Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||
      !Number.isSafeInteger(asset.byteLength)||asset.byteLength<1||asset.byteLength>(kind==='raw'?maxRawBytes:maxBytes)||
      result?.sha256!==asset.hash||
      kind==='raw'&&(!/^(RGGB|BGGR|GRBG|GBRG)$/.test(asset.metadata.bayer)||deviceRun.sampleId!==asset.id)||
      kind!=='raw'&&!mimeTypes.has(mimeType)||
      kind==='render'&&(asset.sampleId!==raw.id||asset.tuningHash!==readbackHash||
        result?.rawHash!==raw.sha256||result?.readbackHash!==readbackHash)) throw new Error('camera_response_invalid');
    const sdkTimestampNs=result?.evidence?.sdkTimestampNs;
    return {id:asset.id,receiptId:deviceRun.id,sha256:asset.hash,byteLength:asset.byteLength,mimeType,width,height,
      archivedAt:asset.createdAt,...(typeof asset.capturedAt==='string'?{deviceCapturedAt:asset.capturedAt}:{}),
      ...(/^\d{1,20}$/.test(String(sdkTimestampNs))?{sdkTimestampNs:String(sdkTimestampNs)}:{}),
      ...(kind==='raw'?{bayer:asset.metadata.bayer,bitDepth:asset.metadata.bitDepth}:{}),
      ...(kind==='render'?{sampleId:raw.id,readbackHash}:{}),...(hash.test(asset.tuningHash)?{tuningHash:asset.tuningHash}:{})};
  }
  async function captureFile(binding,kind,asset,preview=false) {
    if(!cameraId.test(binding?.experimentId)||!cameraId.test(asset?.id)) throw new Error('camera_archive_missing');
    const raw=kind==='raw';
    const route=raw?'/samples/'+asset.id+(preview?'/preview.png':'/download'):
      (kind==='render'?'/results/':'/frames/')+asset.id;
    const result=await fetchArchive('/experiments/'+binding.experimentId+route,{limit:raw&&!preview?maxRawBytes:maxBytes});
    if(raw&&preview) {
      if(result.type!=='image/png'||!result.bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw new Error('camera_response_invalid');
    } else if(result.type!==asset.mimeType||result.bytes.length!==asset.byteLength||sha256(result.bytes)!==asset.sha256) {
      throw new Error('camera_frame_integrity_failed');
    }
    return result;
  }
  async function preflight(binding,report) {
    let layer='service';
    try {
      if(!binding) {
        await list();
        report(layer,{status:'passed'});
        report('board',{status:'blocked',code:'camera_binding_required'});
        return;
      }
      const {experiment}=await inspect({...binding,runId:undefined});
      report(layer,{status:'passed'});
      layer='board';
      report(layer,{status:'checking'});
      if(!experiment.targetId) throw new Error('vision_device_adapter_required');
      const probe=await device(experiment,'probe',{});
      const facts=probe.result?.facts;
      if(!record(facts)) throw new Error('camera_response_invalid');
      const identity={board:experiment.board,sensorModel:experiment.sensorModel,mode:experiment.cameraMode,receiptId:probe.deviceRun.id};
      report(layer,{status:'passed',...identity});
      layer='frame';
      if(facts.nativeSdkAvailable===false) throw new Error('camera_sdk_unavailable');
      if(facts.cleanupRequired===true||facts.writeOutcome==='unconfirmed') throw new Error('camera_recovery_required');
      if(facts.streaming!==true) throw new Error('camera_stream_not_running');
      report(layer,{status:'checking'});
      const readPreview=async after=>{
        const data=await json('/experiments/'+experiment.id+'/device/preview_frame',
          {body:{receiptOnly:true,...(after?{afterSdkTimestampNs:after}:{})}});
        const frame=data.frame;
        const timestamp=String(frame?.evidence?.sdkTimestampNs);
        if(data.operation!=='preview_frame'||frame?.pixels!=='native_studio_preview_only'||!hash.test(frame.sha256)||
            !mimeTypes.has(frame.mimeType)||!Number.isSafeInteger(frame.width)||frame.width<1||
            !Number.isSafeInteger(frame.height)||frame.height<1||!/^\d{1,20}$/.test(timestamp)||BigInt(timestamp)<=0n) {
          throw new Error('camera_live_receipt_invalid');
        }
        if(after&&BigInt(timestamp)<=BigInt(after)) throw new Error('camera_live_frame_stale');
        return {timestamp,width:frame.width,height:frame.height,sha256:frame.sha256};
      };
      const previous=await readPreview();
      const current=await readPreview(previous.timestamp);
      report(layer,{status:'passed',previousTimestamp:previous.timestamp,...current});
    } catch(error) {
      const code=/^(vision|camera)_[a-z0-9_]{1,90}$/.test(error.message)?error.message:'camera_service_error';
      report(layer,{status:'blocked',code});
    }
  }
  return {list,inspect,frame,capture,captureFile,preflight,saveOriginalIsp,restoreOriginalIsp,exposureTrial,gammaTrial,reloadGamma,confirmIsp};
}
