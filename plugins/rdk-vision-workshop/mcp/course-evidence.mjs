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
  return {source:'external',dataset:data.dataset.source,device:training.device,epochs:training.epochsCompleted,
    requestedEpochs:data.training.epochsRequested,validationQrcodeBoxes:data.dataset.validationQrcodeBoxes,
    modelSha256:data.ptq.modelSha256,checkpointSha256:data.training.checkpointSha256,
    calibrationImages:ptq.calibrationImages,receiptSha256:digest(bytes),evidence:proof};
}

export function boardEvidence(directory=process.env.RDK_VISION_COURSE_BOARD_ARCHIVE) {
  async function get(modelHash) {
    if(!directory||!path.isAbsolute(directory)) throw new Error('board_archive_unconfigured');
    const bytes=await boundedFile(path.join(directory,'receipt.json'),receiptLimit,'board_receipt_pending');
    const report=JSON.parse(bytes);
    const expected=modelHash?.replace(/^sha256:/,'');
    if(report.schema!=='rdk.vision-course-board.v1'||!sha.test(report.modelSha256)||
        report.modelSha256!==expected||JSON.stringify(report.classes)!==JSON.stringify(classes)) throw new Error('board_model_mismatch');
    const assets=[];
    for(const phase of ['before','after','restored']) {
      const image=report.gamma?.images?.[phase];
      if(image&&/^(A1-original|B-candidate|A2-restored)\.png$/.test(image.file)&&sha.test(image.sha256)) {
        assets.push({file:image.file,sha256:image.sha256,tuningHash:image.tuningHash,sdkTimestampNs:image.sdkTimestampNs,kind:phase});
      }
    }
    const frames=Array.isArray(report.frames)?report.frames:[];
    for(const phase of ['before','after','live']) {
      const slice=frames.filter(row=>row.phase===phase&&row.modelSha256===expected).slice(-6);
      for(const frame of slice) if(/^frame-[0-9]{5}\.jpg$/.test(frame.file)&&sha.test(frame.imageSha256)) {
        assets.push({file:frame.file,sha256:frame.imageSha256,tuningHash:frame.tuningHash,sdkTimestampNs:frame.sdkTimestampNs,kind:'detection_'+phase});
      }
    }
    const viewsByPhase=Object.fromEntries(Object.entries(report.phases??{}).map(([phase,summary])=>[phase,{
      ...summary,boxes:frames.filter(row=>row.phase===phase&&row.modelSha256===expected).reduce((total,row)=>total+row.detections.length,0),
    }]));
    const snapshotNames=report.tuningHash?['original-isp.json','loaded-isp.json']:[];
    if(report.restoration==='verified') snapshotNames.push('restored-isp.json');
    const view={status:report.status,stage:report.stage,modelSha256:report.modelSha256,staticBpu:report.staticBpu,
      phases:viewsByPhase,frameCount:frames.length,restoration:report.restoration,previewStopped:report.previewStopped,
      failure:report.failure??report.restorationFailure,cameraIdentity:report.cameraIdentity,
      gamma:report.gamma&&{scope:report.gamma.scope,strength:report.gamma.strength,curveReadback:report.gamma.curveReadback},
      targetObservation:report.targetObservation,readbackHash:report.tuningHash,assets,snapshotNames,receiptSha256:digest(bytes)};
    return {view,bytes,snapshots:report.ispSnapshots};
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
      current.view.assets.find(asset=>asset.kind===kind)?.tuningHash;
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
  return {get,file};
}
