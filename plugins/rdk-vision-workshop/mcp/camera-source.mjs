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
  async function inspect(binding) {
    if(!cameraId.test(binding?.experimentId)||binding.runId!==undefined&&!cameraId.test(binding.runId)) throw new Error('camera_binding_invalid');
    const route='/experiments/'+binding.experimentId;
    const {experiment}=await json(route);
    if(experiment?.id!==binding.experimentId||!Array.isArray(experiment.cameraFrames)||!Array.isArray(experiment.deviceRuns)) throw new Error('camera_response_invalid');
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
  async function capture(binding,kind,{scene,raw}={}) {
    const {experiment}=await inspect({...binding,runId:undefined});
    if(!experiment.targetId) throw new Error('vision_device_adapter_required');
    let readbackHash;
    if(kind==='render') {
      const readback=await device(experiment,'tuning_get',{});
      readbackHash=readback.result?.readbackHash;
      if(!hash.test(readbackHash)) throw new Error('camera_response_invalid');
    }
    const operation=kind==='raw'?'capture_raw':kind==='render'?'process_raw':'capture_frame';
    const {asset,deviceRun,result}=await device(experiment,operation,kind==='render'?{sampleId:raw.id}:{scene});
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
  return {list,inspect,frame,capture,captureFile};
}
