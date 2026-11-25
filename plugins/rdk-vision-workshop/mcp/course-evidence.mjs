import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const sha=/^[a-f0-9]{64}$/;
const imageLimit=16*1024*1024;
const receiptLimit=2*1024*1024;
const snapshotLimit=8*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const classes=['park','qrcode','obstacle'];
const detectionPhases=['before','after','live'];
const comparisonOverlap=.30;
const sdkTime=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);
const validDetection=value=>classes.includes(value?.class)&&typeof value.score==='number'&&value.score>=0&&value.score<=1;

function detectionFrame(frame,modelHash) {
  if(!/^frame-[0-9]{5}\.jpg$/.test(frame?.file)||frame.modelSha256!==modelHash||
      !sha.test(frame.imageSha256)||!sha.test(frame.tuningHash)||!sdkTime(frame.sdkTimestampNs)||
      !detectionPhases.includes(frame.phase)||!Number.isFinite(frame.forwardMs)||frame.forwardMs<0||
      !Array.isArray(frame.detections)||frame.detections.length>1000||!frame.detections.every(validDetection)) return;
  const counts=Object.fromEntries(classes.map(label=>[label,frame.detections.filter(item=>item.class===label).length]));
  const maxScores={};
  for(const {class:label,score} of frame.detections) maxScores[label]=Math.max(maxScores[label]??0,score);
  return {file:frame.file,sha256:frame.imageSha256,tuningHash:frame.tuningHash,sdkTimestampNs:frame.sdkTimestampNs,
    kind:'detection_'+frame.phase,phase:frame.phase,forwardMs:frame.forwardMs,counts,maxScores};
}

async function boundedFile(filename,limit,missing) {
  if(!filename||!path.isAbsolute(filename)) throw new Error(missing);
  let handle;
  try {
    handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>limit) throw new Error('evidence_file_invalid');
    const bytes=await handle.readFile();
    if(bytes.length>limit) throw new Error('evidence_file_invalid');
    return bytes;
  } catch(error) {
    if(error.code==='ENOENT') throw new Error(missing);
    throw error;
  } finally { await handle?.close(); }
}

async function companion(filename,name) {
  try {
    const bytes=await boundedFile(path.join(path.dirname(filename),name),receiptLimit,'companion_missing');
    return {value:JSON.parse(bytes),sha256:digest(bytes)};
  } catch { return undefined; }
}

export async function externalTrainingReceipt(filename=process.env.RDK_VISION_COURSE_TRAINING_RECEIPT) {
  const bytes=await boundedFile(filename,receiptLimit,'training_receipt_unconfigured');
  const data=JSON.parse(bytes);
  if(data.schema!=='vision-course-x5-evidence-v1'||data.stageStatus?.training!=='completed'||data.stageStatus?.ptq!=='completed'||
      !sha.test(data.training?.checkpointSha256)||!sha.test(data.ptq?.modelSha256)||!sha.test(data.dataset?.manifestSha256)||
      data.training.datasetManifestSha256!==data.dataset.manifestSha256||data.ptq.architecture!=='bayes-e'||data.ptq.onnxOpset!==11||
      JSON.stringify(data.dataset.classes)!==JSON.stringify(classes)) throw new Error('training_receipt_invalid');
  const [manifest,lineage,profile]=await Promise.all(['dataset-manifest.json','onnx-lineage.json','model-profile.json']
    .map(name=>companion(filename,name)));
  const {training,ptq}=data;
  const proof={completed_checkpoint:'sha256:'+training.checkpointSha256,x5_model_hash:'sha256:'+ptq.modelSha256};
  const metrics=training.validationMetrics;
  if(Number.isFinite(metrics?.['metrics/mAP50(B)'])&&Number.isFinite(metrics?.['metrics/mAP50-95(B)'])) {
    proof.validation_prediction=`训练回执 · mAP50 ${metrics['metrics/mAP50(B)']} · mAP50–95 ${metrics['metrics/mAP50-95(B)']}`;
  }
  const checked=lineage?.value;
  if(sha.test(ptq.exportedOnnxSha256)&&checked?.exportedOnnxSha256===ptq.exportedOnnxSha256&&
      sha.test(ptq.compilationWorkCopyOnnxSha256)&&checked.comparisonOnnxSha256===ptq.compilationWorkCopyOnnxSha256&&
      checked.exportedOpsets?.['ai.onnx']===ptq.onnxOpset&&checked.onnxChecker==='passed for both') {
    proof.checker_report='ONNX Checker 已通过 · onnx-lineage.json sha256:'+lineage.sha256;
    const contract=profile?.value;
    if(contract?.sha256===ptq.modelSha256&&checked.graphFieldsByteEqual?.input===true&&checked.graphFieldsByteEqual?.output===true&&
        JSON.stringify(contract.classes)===JSON.stringify(classes)&&contract.input?.width===training.imageSize&&
        contract.input.height===training.imageSize&&Array.isArray(contract.decoder?.heads)&&contract.decoder.heads.length===6) {
      proof.onnx_contract=`opset 11 · ${training.imageSize}×${training.imageSize} · 六个输出头 · ${classes.join(' / ')} · ONNX sha256:${ptq.exportedOnnxSha256}`;
    }
  }
  if(manifest?.sha256===data.dataset.manifestSha256&&Array.isArray(manifest.value.files)&&
      Number.isInteger(ptq.calibrationImages)&&ptq.calibrationImages>0&&
      manifest.value.files.filter(row=>typeof row?.file==='string'&&row.file.startsWith('train/')&&sha.test(row.imageSha256)).length===ptq.calibrationImages) {
    proof.calibration_manifest=`训练分组 ${ptq.calibrationImages} 张 · dataset-manifest.json sha256:${manifest.sha256}`;
  }
  const runId=training.id??data.runId;
  return {source:'external',...(typeof runId==='string'&&runId.trim()&&runId.length<=300?{runId}:{}),
    dataset:data.dataset.source,device:training.device,epochs:training.epochsCompleted,
    requestedEpochs:data.training.epochsRequested,validationQrcodeBoxes:data.dataset.validationQrcodeBoxes,
    modelSha256:data.ptq.modelSha256,checkpointSha256:data.training.checkpointSha256,
    calibrationImages:ptq.calibrationImages,receiptSha256:digest(bytes),evidence:proof};
}

export function boardEvidence(directory=process.env.RDK_VISION_COURSE_BOARD_ARCHIVE,{runId}={}) {
  async function get(modelHash) {
    if(!directory||!path.isAbsolute(directory)) throw new Error('board_archive_unconfigured');
    const bytes=await boundedFile(path.join(directory,'receipt.json'),receiptLimit,'board_receipt_pending');
    const report=JSON.parse(bytes);
    const expected=modelHash?.replace(/^sha256:/,'');
    if(runId&&report.runId!==runId) throw new Error('board_receipt_pending');
    if(report.schema!=='rdk.vision-course-board.v1'||!sha.test(report.modelSha256)||
        report.modelSha256!==expected||JSON.stringify(report.classes)!==JSON.stringify(classes)) throw new Error('board_model_mismatch');
    const assets=[];
    if(sha.test(report.staticBpu?.outputImageSha256)) {
      assets.push({file:'static-detection.jpg',sha256:report.staticBpu.outputImageSha256,kind:'static_detection'});
    }
    for(const phase of ['before','after','restored']) {
      const image=report.gamma?.images?.[phase];
      if(image&&/^(A1-original|B-candidate|A2-restored)\.png$/.test(image.file)&&sha.test(image.sha256)) {
        assets.push({file:image.file,sha256:image.sha256,tuningHash:image.tuningHash,sdkTimestampNs:image.sdkTimestampNs,kind:phase});
      }
    }
    const frames=Array.isArray(report.frames)?report.frames:[];
    const detections=frames.map(frame=>detectionFrame(frame,expected)).filter(Boolean);
    for(const phase of detectionPhases) {
      const slice=frames.filter(row=>row?.phase===phase&&row.modelSha256===expected).slice(-6);
      for(const frame of slice) if(/^frame-[0-9]{5}\.jpg$/.test(frame.file)&&sha.test(frame.imageSha256)) {
        assets.push({file:frame.file,sha256:frame.imageSha256,tuningHash:frame.tuningHash,sdkTimestampNs:frame.sdkTimestampNs,kind:'detection_'+phase});
      }
    }
    // After the ISP change, only show a frame bound to the loaded readback.
    const latestDetection=detections.findLast(frame=>assets.some(asset=>asset.file===frame.file&&asset.sha256===frame.sha256)&&(report.tuningHash?
      frame.tuningHash===report.tuningHash&&(frame.phase==='after'||frame.phase==='live'):
      report.stage==='before'&&frame.phase==='before'));
    const viewsByPhase=Object.fromEntries(Object.entries(report.phases??{}).map(([phase,summary])=>[phase,{
      ...summary,boxes:frames.filter(row=>row?.phase===phase&&row.modelSha256===expected)
        .reduce((total,row)=>total+(Array.isArray(row.detections)?row.detections.length:0),0),
    }]));
    const snapshotNames=report.tuningHash?['original-isp.json','loaded-isp.json']:[];
    if(report.restoration==='verified') snapshotNames.push('restored-isp.json');
    const representative=(phase,hash)=>detections.findLast(frame=>frame.phase===phase&&frame.tuningHash===hash&&
      assets.some(asset=>asset.file===frame.file&&asset.sha256===frame.sha256));
    const settings=report.comparison;
    const before=representative('before',report.baselineTuningHash);
    const after=representative('after',report.tuningHash);
    const comparison=report.status==='completed'&&report.restoration==='verified'&&report.previewStopped===true&&
      report.approvedGamma?.hash===report.tuningHash&&report.approvedGamma?.curveReadback?.status==='verified'&&before&&after&&
      before.tuningHash!==after.tuningHash&&BigInt(before.sdkTimestampNs)<BigInt(after.sdkTimestampNs)&&
      settings?.width===960&&settings.height===540&&Number.isInteger(settings.durationPerPhaseSec)&&
      settings.durationPerPhaseSec>0&&settings.durationPerPhaseSec<=60&&settings.scoreThreshold===.25&&settings.nmsThreshold===.70&&
      sha.test(settings.approvedBaselineHash)?
      {before,after,settings}:undefined;
    const view={status:report.status,stage:report.stage,modelSha256:report.modelSha256,staticBpu:report.staticBpu,
      phases:viewsByPhase,frameCount:frames.length,restoration:report.restoration,previewStopped:report.previewStopped,
      failure:report.failure??report.restorationFailure,cameraIdentity:report.cameraIdentity,
      gamma:report.gamma&&{scope:report.gamma.scope,strength:report.gamma.strength,curveReadback:report.gamma.curveReadback},
      targetObservation:report.targetObservation,readbackHash:report.tuningHash,assets,snapshotNames,receiptSha256:digest(bytes),
      ...(report.approvedGamma?.hash===report.tuningHash&&report.approvedGamma?.curveReadback?.status==='verified'?{approvedGamma:true}:{}),
      ...(latestDetection?{latestDetection}:{}),
      ...(comparison?{comparison}:{}),
      ...(typeof report.runId==='string'&&/^[a-f0-9-]{36}$/.test(report.runId)?{runId:report.runId}:{})};
    return {view,bytes,snapshots:report.ispSnapshots,detections,frames};
  }
  async function snapshot(current,name) {
    if(!current.view.snapshotNames.includes(name)) throw new Error('board_asset_missing');
    const bytes=await boundedFile(path.join(directory,name),snapshotLimit,'board_asset_missing');
    const declared=current.snapshots?.[name];
    if(current.snapshots&&(!sha.test(declared)||digest(bytes)!==declared)) throw new Error('board_asset_integrity_failed');
    const data=JSON.parse(bytes);
    if(!sha.test(data.readbackHash)) throw new Error('board_asset_integrity_failed');
    if(name==='restored-isp.json') {
      const original=await snapshot(current,'original-isp.json');
      if(data.readbackHash!==original.hash) throw new Error('board_asset_integrity_failed');
    } else if(digest(JSON.stringify(data.config))!==data.readbackHash) throw new Error('board_asset_integrity_failed');
    const kind={'original-isp.json':'before','loaded-isp.json':'after','restored-isp.json':'restored'}[name];
    const expected=kind==='after'||kind==='before'&&current.view.restoration==='no_write'?current.view.readbackHash:
      current.view.comparison?.[kind]?.tuningHash??current.view.assets.find(asset=>asset.kind===kind)?.tuningHash;
    if(expected&&data.readbackHash!==expected) throw new Error('board_asset_integrity_failed');
    return {bytes,hash:data.readbackHash};
  }
  async function file(modelHash,name,receiptSha256) {
    const current=await get(modelHash);
    if(receiptSha256!==null&&receiptSha256!==undefined&&current.view.receiptSha256!==receiptSha256) throw new Error('board_receipt_changed');
    if(name==='receipt.json') return {type:'application/json',bytes:current.bytes};
    if(['original-isp.json','loaded-isp.json','restored-isp.json'].includes(name)) {
      const {bytes}=await snapshot(current,name);
      return {type:'application/json',bytes};
    }
    const expected=current.view.assets.find(asset=>asset.file===name);
    if(!expected) throw new Error('board_asset_missing');
    const bytes=await boundedFile(path.join(directory,expected.file),imageLimit,'board_asset_missing');
    if(digest(bytes)!==expected.sha256) throw new Error('board_asset_integrity_failed');
    return {type:name.endsWith('.png')?'image/png':'image/jpeg',bytes};
  }
  async function preview(modelHash,knownSha256,batch=false) {
    const {view,detections}=await get(modelHash);
    const frame=view.latestDetection;
    if(!frame||frame.sha256===knownSha256) return {view};
    async function image(detection) {
      const bytes=await boundedFile(path.join(directory,detection.file),imageLimit,'board_asset_missing');
      if(digest(bytes)!==detection.sha256||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9) {
        throw new Error('board_asset_integrity_failed');
      }
      return bytes.toString('base64');
    }
    try {
      if(batch&&knownSha256&&view.runId&&view.status==='started') {
        const cursor=detections.find(item=>item.sha256===knownSha256);
        const fresh=detections.filter(item=>item.phase===frame.phase&&item.tuningHash===frame.tuningHash&&
          (!cursor||BigInt(item.sdkTimestampNs)>BigInt(cursor.sdkTimestampNs))&&
          view.assets.some(asset=>asset.file===item.file&&asset.sha256===item.sha256)).slice(-4);
        const frames=await Promise.all(fresh.map(async item=>({frame:item,imageBase64:await image(item)})));
        return {view,frames};
      }
      return {view,imageBase64:await image(frame)};
    } catch(error) {
      if(error.message==='board_asset_missing') return {view,previewPending:true};
      throw error;
    }
  }
  async function score(modelHash,{receiptSha256,label,region,targetAbsent=false}) {
    const current=await get(modelHash);
    const {view}=current;
    if(view.receiptSha256!==receiptSha256) throw new Error('board_receipt_changed');
    if(!view.comparison) throw new Error('board_comparison_unavailable');
    if(typeof targetAbsent!=='boolean'||(targetAbsent?(label!==undefined||region!==undefined):
        !classes.includes(label)||!Array.isArray(region)||region.length!==4||
        !region.every(value=>Number.isFinite(value)&&value>=0&&value<=1)||
        region[2]<=region[0]||region[3]<=region[1])) throw new Error('board_comparison_region_invalid');
    await snapshot(current,'loaded-isp.json');
    await snapshot(current,'restored-isp.json');
    const {settings}=view.comparison;
    const target=region?.map((value,index)=>value*(index%2?settings.height:settings.width));
    const area=([left,top,right,bottom])=>Math.max(0,right-left)*Math.max(0,bottom-top);
    const numberSet=new Set(current.detections.map(frame=>frame.file));
    const results={};
    for(const phase of ['before','after']) {
      const sample=view.comparison[phase];
      const frames=current.frames.filter(row=>row?.phase===phase&&row.modelSha256===modelHash&&row.tuningHash===sample.tuningHash&&numberSet.has(row.file));
      const times=frames.map(row=>BigInt(row.sdkTimestampNs));
      if(frames.length!==view.phases[phase]?.frames||times.some((time,i)=>i>0&&time<=times[i-1])||
          phase==='after'&&times[0]<=BigInt(view.comparison.before.sdkTimestampNs)||
          new Set(frames.map(row=>row.file)).size!==frames.length||
          frames.some(row=>row.detections.some(({box})=>!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||
              box[0]>=box[2]||box[1]>=box[3]))) throw new Error('board_comparison_unavailable');
      await file(modelHash,sample.file,receiptSha256);
      let matchedFrames=0,unmatchedBoxes=0,bestScore=null,consecutive=0,longestMatch=0;
      for(const {detections} of frames) {
        const matched=detections.filter(({class:detected,box})=>{
          if(!target||detected!==label) return false;
          const [left,top,right,bottom]=box.map((value,index)=>Math.max(0,Math.min(index%2?settings.height:settings.width,value)));
          const overlap=area([Math.max(left,target[0]),Math.max(top,target[1]),Math.min(right,target[2]),Math.min(bottom,target[3])]);
          return overlap>0&&overlap/(area(target)+area([left,top,right,bottom])-overlap)>=comparisonOverlap;
        });
        if(matched.length) {
          matchedFrames++;
          longestMatch=Math.max(longestMatch,++consecutive);
          bestScore=Math.max(bestScore??0,...matched.map(item=>item.score));
        } else consecutive=0;
        unmatchedBoxes+=detections.length-matched.length;
      }
      results[phase]={frames:frames.length,matchedFrames,longestMatch,unmatchedBoxes,bestScore,tuningHash:sample.tuningHash,sample};
    }
    return {schema:'rdk.vision-course-comparison.v1',runId:view.runId,modelSha256:view.modelSha256,receiptSha256,
      settings,targetAbsent,region,label,...(targetAbsent?{}:{iouThreshold:comparisonOverlap}),
      restoration:view.restoration,previewStopped:view.previewStopped,results};
  }
  return {get,file,preview,score};
}
