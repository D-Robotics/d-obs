import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname,isAbsolute,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startWorkbench } from './workbench.mjs';
import { plan } from './course.mjs';
import { readWorkbenchState,writeWorkbenchState } from './workbench-state.mjs';

const worker=fileURLToPath(import.meta.url);
const sessionUrl=/^http:\/\/127\.0\.0\.1:\d{1,5}\/#[-a-f0-9]{36}$/;
const idleMs=8*60*60*1000;
const launchTimeoutMs=8000;
const photoMimeExtensions=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp']]);
const photoPreviewLimit=24*1024*1024;

function studioMediaDir() {
  const directory=process.env.RDK_VISION_COURSE_STUDIO_MEDIA_DIR;
  return directory&&isAbsolute(directory)?directory:undefined;
}

async function readArchivedImage(url,route,asset) {
  if(!photoMimeExtensions.has(asset.mimeType)||!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('camera_photo_preview_unavailable');
  const address=new URL(url);
  const response=await fetch(new URL(route,address),{
    headers:{'X-Workshop-Session':address.hash.slice(1)},redirect:'error',signal:AbortSignal.timeout(12000),
  });
  if(!response.ok||response.headers.get('content-type')!==asset.mimeType) {
    await response.body?.cancel();
    throw new Error('camera_photo_preview_unavailable');
  }
  const chunks=[];
  let size=0;
  for await(const chunk of response.body) {
    size+=chunk.length;
    if(size>photoPreviewLimit) throw new Error('camera_photo_preview_unavailable');
    chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks,size);
  if(!size||asset.byteLength!==undefined&&size!==asset.byteLength||createHash('sha256').update(bytes).digest('hex')!==asset.sha256) {
    throw new Error('camera_frame_integrity_failed');
  }
  return bytes;
}

async function publishImage(mediaDir,asset,bytes,label) {
  const extension=photoMimeExtensions.get(asset.mimeType);
  const fileName='workshop-photo-'+asset.sha256+'.'+extension;
  const temporary=join(mediaDir,'.workshop-photo-'+randomUUID()+'.tmp');
  await mkdir(mediaDir,{recursive:true,mode:0o700});
  try {
    await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
    await rename(temporary,join(mediaDir,fileName));
  } finally {
    await rm(temporary,{force:true});
  }
  return {fileName:label,imageUrl:'/api/local-files/'+fileName};
}

async function request(url,body,route='/session') {
  const address=new URL(url);
  const headers={'X-Workshop-Session':address.hash.slice(1)};
  if (body) headers['Content-Type']='application/json';
  const response=await fetch(new URL(route,address),{
    method:body?'POST':'GET',headers,body:body&&JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(1500),
  });
  if ([400,409,422].includes(response.status)) throw new Error((await response.json()).error);
  if (!response.ok) throw new Error('workbench_unavailable');
  return response.json();
}

async function active(registry) {
  try {
    const url=await readFile(registry,'utf8');
    if (sessionUrl.test(url)) {
      await request(url);
      return url;
    }
  } catch(error) {
    if (error.code==='EACCES') throw error;
  }
}

const stationIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sessionVersion=plan.classroomId?'v7-'+plan.classroomId:'v6';
const registryFor=(base,id)=>join(id?join(base,'stations',id):base,'session-learner-isp-'+sessionVersion);
const pointerFor=base=>join(base,'active-station');
const lastStationFor=base=>join(base,'last-new-station');
const stateFor=(base,id)=>join(dirname(registryFor(base,id)),'workbench-state-learner-isp-'+sessionVersion+'.json');
async function lastNewStation(base) {
  const id=await readFile(lastStationFor(base),'utf8').catch(()=>undefined);
  return stationIdPattern.test(id)?id:undefined;
}
async function selectedStation(base) {
  try {
    const id=await readFile(pointerFor(base),'utf8');
    if(id==='original') return '';
    if(stationIdPattern.test(id)) return id;
    throw new Error('workbench_station_invalid');
  } catch(error) {
    if(error.code==='ENOENT') return '';
    throw error;
  }
}

async function openStation(base,id) {
  // An older detached workbench can still be listening after an in-place import.
    const registry=registryFor(base,id);
    const directory=dirname(registry);
    const lock=join(directory,'starting-learner-isp-'+sessionVersion);
    await mkdir(directory,{recursive:true,mode:0o700});
    const deadline=Date.now()+launchTimeoutMs;
    while (Date.now()<deadline) {
      const url=await active(registry);
      if (url) return url;
      try {
        await mkdir(lock);
      } catch(error) {
        if (error.code!=='EEXIST') throw error;
        const info=await stat(lock).catch(err=>{if(err.code!=='ENOENT') throw err;});
        if (info&&Date.now()-info.mtimeMs>launchTimeoutMs*2) await rm(lock,{recursive:true,force:true});
        await delay(80);
        continue;
      }
      try {
        const existing=await active(registry);
        if (existing) return existing;
        const child=spawn(process.execPath,[worker,'--serve',base,id],{detached:true,stdio:'ignore',windowsHide:true});
        let failure;
        child.once('error',error=>{failure=error;});
        child.once('exit',()=>{failure??=new Error('workbench_start_failed');});
        child.unref();
        while (Date.now()<deadline) {
          if (failure) throw failure;
          const ready=await active(registry);
          if (ready) return ready;
          await delay(80);
        }
        if (child.pid) child.kill();
      } finally {
        await rm(lock,{recursive:true,force:true});
      }
    }
    throw new Error('workbench_start_timeout');
}

export function workbenchSession(root=join(homedir(),'.rdk-vision-workshop')) {
  const scope=createHash('sha256').update(worker+'|persistent-workbench').digest('hex').slice(0,32);
  const directory=join(root,scope);
  const open=async()=>openStation(directory,await selectedStation(directory));
  return {open,async sync(body) {
    const url=await active(registryFor(directory,await selectedStation(directory)));
    if (!url) throw new Error('open_workbench_first');
    return request(url,body);
  },async camera(body) {
    const url=await open();
    const target=new URL(url);
    target.searchParams.set('panel','capture');
    return {url:target.href,...await request(url,body,'/camera/capture')};
  },async cameraStatus(photoRequestId) {
    const url=await open();
    for (let attempt=0;attempt<2;attempt++) {
      const [{resume,revision},captureResult,{preflight}]=await Promise.all([
        request(url),request(url,undefined,'/camera/capture'),request(url,undefined,'/camera/preflight'),
      ]);
      const experimentId=resume.camera?.experimentId??null;
      if (revision!==captureResult.recordingRevision||
          captureResult.capture&&captureResult.capture.experimentId!==experimentId||
          preflight&&preflight.experimentId!==experimentId) continue;
      const target=new URL(url);
      target.searchParams.set('panel','capture');
      const status={url:target.href,...captureResult,
        cameraBinding:{source:'workbench',status:experimentId?'bound':'unbound',experimentId},
        baselineRequested:Boolean(captureResult.capture?.scene),latestPreflight:preflight??null};
      if(!photoRequestId) return status;
      const capture=captureResult.capture;
      if(capture?.photoRequestId!==photoRequestId) return {...status,photoPreview:'request_changed'};
      if(!capture.assets.photo) return {...status,photoPreview:capture.errors.photo||capture.recording?'capture_failed':'pending'};
      const mediaDir=studioMediaDir();
      if(!mediaDir) return {...status,photoPreview:'studio_media_unavailable'};
      try {
        const photo=capture.assets.photo;
        const bytes=await readArchivedImage(url,'/camera/capture/file/photo?id='+encodeURIComponent(photo.id),photo);
        const preview=await publishImage(mediaDir,photo,bytes,'相机实拍.'+photoMimeExtensions.get(photo.mimeType));
        return {...status,__type:'studio_local_preview',ok:true,...preview,photoPreview:'ready'};
      } catch {
        return {...status,photoPreview:'preview_unavailable'};
      }
    }
    throw new Error('camera_status_changed');
  },async preflight(run) {
    const url=await open();
    const target=new URL(url);
    target.searchParams.set('panel','preflight');
    return {url:target.href,...await request(url,run?{}:undefined,'/camera/preflight')};
  },async detection() {
    const workbenchUrl=await open();
    const target=new URL(workbenchUrl);
    target.searchParams.set('panel','board');
    const url=target.href;
    let receipt;
    try {
      receipt=await request(url,undefined,'/board/receipt');
    } catch (error) {
      if(!/^board_[a-z_]+$/.test(error.message)) throw error;
      return {url,detectionPreview:'archive_unavailable',error:error.message};
    }
    const frame=receipt.latestDetection;
    const status={url,runId:receipt.runId,modelSha256:receipt.modelSha256,boardStatus:receipt.status,
      targetObservation:receipt.targetObservation,receiptSha256:receipt.receiptSha256,frame};
    if(!frame) return {...status,detectionPreview:'no_verified_frame'};
    const mediaDir=studioMediaDir();
    if(!mediaDir) return {...status,detectionPreview:'studio_media_unavailable'};
    try {
      const asset={...frame,mimeType:'image/jpeg'};
      const bytes=await readArchivedImage(url,'/board/file/'+encodeURIComponent(frame.file)+
        '?receipt='+encodeURIComponent(receipt.receiptSha256),asset);
      const boxes=Object.entries(frame.counts).filter(([,count])=>count>0).map(([label,count])=>{
        const score=frame.maxScores?.[label];
        return label+' × '+count+(Number.isFinite(score)?'（最高 '+(score*100).toFixed(1)+'%）':'');
      });
      const label='板端检测归档帧 · '+(boxes.length?boxes.join(' · '):'本帧无检测框');
      const preview=await publishImage(mediaDir,asset,bytes,label);
      return {...status,__type:'studio_local_preview',ok:true,...preview,detectionPreview:'ready'};
    } catch {
      return {...status,detectionPreview:'preview_unavailable'};
    }
  },async isp(body,selection) {
    const url=await open();
    const target=new URL(url);
    target.searchParams.set('panel','isp');
    const result=await request(url,body,'/camera/isp');
    const proposal=result.isp?.gammaProposal;
    const round=proposal??result.isp?.rounds?.findLast(item=>item.before&&item.after);
    if(round) target.searchParams.set('round',String(round.number));
    const status={url:target.href,...result,presentation:{panel:'isp',
      ...(round?{round:round.number}:{}),...(proposal?{candidatePending:true}:{}),
      archivedFrames:['before','after','restored'].filter(name=>round?.[name])}};
    if(!selection) return status;
    const {round:roundNumber,trial}=selection;
    if(roundNumber!==undefined) target.searchParams.set('round',String(roundNumber));
    else target.searchParams.delete('round');
    status.url=target.href;
    const item=trial===undefined?result.isp?.rounds?.find(value=>value.number===roundNumber):
      result.isp?.adjustments?.find(value=>value.number===trial);
    const afterReadback=trial===undefined?item?.gammaReadback:item?.afterReadback;
    if(!item?.before||!item.after||!item.beforeReadback?.hash||!afterReadback?.hash||
        item.before.tuningHash!==item.beforeReadback.hash||item.after.tuningHash!==afterReadback.hash) {
      return {...status,ispPreview:result.isp?.running?'pending':'no_verified_pair'};
    }
    const mediaDir=studioMediaDir();
    if(!mediaDir) return {...status,ispPreview:'studio_media_unavailable'};
    try {
      const route=trial===undefined?{round:String(roundNumber)}:{scope:'learner',trial:String(trial)};
      const pair=await Promise.all(['before','after'].map(async phase=>{
        const asset=item[phase];
        const query=new URLSearchParams({...route,file:phase,sha256:asset.sha256});
        return {asset,bytes:await readArchivedImage(url,'/camera/isp?'+query,asset)};
      }));
      const [before,after]=await Promise.all(pair.map(({asset,bytes},index)=>
        publishImage(mediaDir,asset,bytes,index===0?'调前实拍':'调后实拍')));
      const adjustment=trial===undefined?('第 '+roundNumber+' 轮 Gamma'+
        (item.curveChange?.changed?' · '+item.curveChange.changed+' 个曲线节点变化':'')):
        item.label+' '+item.beforeValue+' → '+item.afterValue+(item.unit?' '+item.unit:'');
      const caption=adjustment+' · 板端独立回读 '+afterReadback.hash.slice(0,12);
      return {...status,__type:'studio_local_preview',ok:true,...before,
        comparison:{...after,caption},ispPreview:'ready'};
    } catch {
      return {...status,ispPreview:'preview_unavailable'};
    }
  }};
}

async function serve(base,id) {
  if(id&&!stationIdPattern.test(id)) throw new Error('workbench_station_invalid');
  const registry=registryFor(base,id);
  const temporary=registry+'.'+process.pid;
  const stateFile=stateFor(base,id);
  const previous=process.env.RDK_VISION_COURSE_PREVIOUS_SESSION;
  const previousPlanState=plan.classroomId&&!readWorkbenchState(stateFile)?
    readWorkbenchState(join(dirname(registry),'workbench-state-learner-isp-v6.json')):undefined;
  if(previousPlanState) writeWorkbenchState(stateFile,previousPlanState);
  if(!id&&!readWorkbenchState(stateFile)) {
    const legacy=readWorkbenchState(join(dirname(registry),'workbench-state-learner-isp-v5.json'))??
      readWorkbenchState(join(dirname(registry),'workbench-state-isp-rounds-v4.json'))??
      readWorkbenchState(join(dirname(registry),'workbench-state-capture-v3.json'))??
      readWorkbenchState(join(dirname(registry),'workbench-state-capture-v2.json'))??
      readWorkbenchState(join(dirname(registry),'workbench-state-capture-v1.json'))??
      readWorkbenchState(join(dirname(registry),'workbench-state.json'));
    if(legacy) writeWorkbenchState(stateFile,legacy);
    else if(previous) {
      const url=await active(previous);
      if(url) {
        const [{resume},status]=await Promise.all([request(url),request(url,undefined,'/robogo/state')]);
        const lockedRun=resume.run?.source==='robogo'?resume.run:undefined;
        writeWorkbenchState(stateFile,{resume,lockedRun,submission:lockedRun?'accepted':status.uncertainTraining?'pending':'idle'});
      }
    }
  }
  const stationActions=async action=>{
    if(action==='active') return openStation(base,await selectedStation(base));
    const nextId=action==='new'?randomUUID():action==='latest'?await lastNewStation(base):'';
    if(nextId===undefined) throw new Error('workbench_station_invalid');
    const url=await openStation(base,nextId);
    const draft=pointerFor(base)+'.'+randomUUID();
    try {
      await writeFile(draft,nextId||'original',{mode:0o600,flag:'wx'});
      if(action==='new') await writeFile(lastStationFor(base),nextId,{mode:0o600});
      await rename(draft,pointerFor(base));
    } finally {await rm(draft,{force:true});}
    return url;
  };
  const priorTraining=async()=>{
    const children=await readdir(join(base,'stations')).catch(error=>{
      if(error.code==='ENOENT') return [];
      throw error;
    });
    for(const other of ['',...children.filter(name=>stationIdPattern.test(name))]) {
      if(other===id) continue;
      const previous=readWorkbenchState(stateFor(base,other));
      const run=previous?.lockedRun??previous?.resume.run;
      if(previous?.submission==='pending'||run?.source==='robogo') {
        return {runId:run?.id,uncertain:previous.submission==='pending'};
      }
    }
  };
  const view=await startWorkbench({},0,undefined,{idleMs,stateFile,stationActions,
    isActiveStation:async()=>await selectedStation(base).catch(()=>undefined)===id,
    stationKind:id?'fresh':'original',lastStation:async()=>Boolean(await lastNewStation(base)),priorTraining});
  try {
    await writeFile(temporary,view.url,{mode:0o600,flag:'wx'});
    await rename(temporary,registry);
  } catch(error) {
    await rm(temporary,{force:true});
    view.server.close();
    throw error;
  }
}

if (process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url&&process.argv[2]==='--serve') {
  await serve(process.argv[3],process.argv[4]??'');
}
