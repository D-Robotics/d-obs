import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,rmdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {boardEvidence} from './course-evidence.mjs';

export function createBoardLauncher(configFile=process.env.RDK_VISION_COURSE_BOARD_LAUNCHER) {
  const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const modelPattern=/^[a-f0-9]{64}$/;
  const validProfile=value=>path.isAbsolute(value.executable)&&Array.isArray(value.args)&&value.args.length<=32&&
    value.args.every(arg=>typeof arg==='string'&&arg.length<=4096&&!arg.includes('\0'))&&modelPattern.test(value.modelSha256);
  let config;
  let issue='board_launcher_unconfigured';
  if(configFile) {
    try {
      if(!path.isAbsolute(configFile)) throw new Error();
      const source=lstatSync(configFile);
      const writableByOthers=value=>process.platform!=='win32'&&(value.uid!==process.getuid()||Boolean(value.mode&0o022));
      if(!source.isFile()||source.size>32768||writableByOthers(source)) throw new Error();
      const data=JSON.parse(readFileSync(configFile,'utf8'));
      const profiles=data.profiles??{[data.path]:data};
      if(!path.isAbsolute(data.archiveRoot)) throw new Error();
      const archive=lstatSync(data.archiveRoot);
      if(!archive.isDirectory()||writableByOthers(archive)||
          !idPattern.test(data.experimentId)||!Object.keys(profiles).length||
          Object.entries(profiles).some(([route,value])=>!['A','B'].includes(route)||!validProfile(value))) throw new Error();
      config={...data,profiles};
    } catch {issue='board_launcher_invalid';}
  }
  const lease=config&&path.join(config.archiveRoot,'.course-detection-active');
  const pointer=route=>path.join(config.archiveRoot,'last-'+config.experimentId+'-'+route+'.json');
  const runs=new Map();
  function profile(selection) {
    if(!['A','B'].includes(selection.path)) return;
    const value=config?.profiles[selection.path];
    if(value&&value.modelSha256===selection.modelHash) return value;
  }
  function ready(selection) {
    if(!config) return issue;
    if(!profile(selection)) return 'board_launcher_model_unbound';
    if(selection.experimentId!==config.experimentId) return 'board_launcher_camera_unbound';
    if(!selection.available) return 'board_launcher_route_unready';
    if(selection.cameraBusy) return 'board_launcher_camera_busy';
    if(running()) return [...runs.values()].some(run=>run.state==='running')?'board_launcher_running':'board_launcher_locked';
  }
  function current(selection) {
    if(!profile(selection)||selection.experimentId!==config.experimentId) return;
    if(runs.has(selection.path)) return runs.get(selection.path);
    try {
      const filepath=pointer(selection.path);
      const file=lstatSync(filepath);
      if(!file.isFile()||file.size>4096) return;
      const {id,modelHash}=JSON.parse(readFileSync(filepath,'utf8'));
      if(!idPattern.test(id)||modelHash!==selection.modelHash) return;
      const run={id,state:'completed',evidence:boardEvidence(path.join(config.archiveRoot,id),{runId:id})};
      runs.set(selection.path,run);
      return run;
    } catch {return;}
  }
  function status(selection) {
    const reason=ready(selection);
    const run=current(selection);
    const canUseApprovedIsp=Boolean(profile(selection)?.supportsApprovedIsp===true&&selection.approvedIsp);
    return {ready:!reason,reason,canUseApprovedIsp,
      canCompareIsp:canUseApprovedIsp&&profile(selection)?.supportsIspComparison===true&&selection.comparisonEligible===true,
      ...(run?{run:{id:run.id,state:run.state,error:run.error}}:{})};
  }
  function running() {return Boolean(lease&&existsSync(lease));}
  function evidence(selection) {return current(selection)?.evidence;}
  function start(selection,mode='current') {
    const reason=ready(selection);
    if(reason) throw new Error(reason);
    const target=profile(selection);
    if(!['current','approved','comparison'].includes(mode)) throw new Error('board_launcher_isp_unavailable');
    const comparison=mode==='comparison';
    if(comparison&&(target.supportsIspComparison!==true||!selection.comparisonEligible)) throw new Error('board_launcher_comparison_unavailable');
    const approved=mode==='current'?undefined:selection.approvedIsp;
    const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if(mode!=='current'&&(target.supportsApprovedIsp!==true||!approved?.config||!approved.originalConfig||
        hash(approved.originalConfig)!==approved.originalHash||hash(approved.config)!==approved.hash)) {
      throw new Error('board_launcher_isp_unavailable');
    }
    try {mkdirSync(lease,{mode:0o700});}
    catch (error) {throw new Error(error.code==='EEXIST'?'board_launcher_locked':'board_launcher_start_failed');}
    const id=randomUUID();
    const directory=path.join(config.archiveRoot,id);
    const settings=approved?path.join(directory,'approved-isp.json'):'';
    const next={id,state:'running',evidence:boardEvidence(directory,{runId:id})};
    let log,child;
    try {
      mkdirSync(directory,{mode:0o700});
      if(approved) writeFileSync(settings,JSON.stringify(approved),{mode:0o600,flag:'wx'});
      log=openSync(path.join(directory,'runner.log'),'wx',0o600);
      child=spawn(target.executable,target.args,{shell:false,windowsHide:true,stdio:['ignore',log,log],
        env:{...process.env,RDK_COURSE_RUN_ID:id,RDK_COURSE_RUN_ARCHIVE:directory,
          RDK_COURSE_MODEL_SHA256:target.modelSha256,RDK_COURSE_APPROVED_ISP:settings,
          RDK_COURSE_COMPARE_ISP:comparison?'1':'0'}});
    } catch {
      rmdirSync(lease);
      throw new Error('board_launcher_start_failed');
    } finally {if(log!==undefined) closeSync(log);}
    runs.set(selection.path,next);
    let startFailed=false;
    let timedOut=false;
    child.once('error',()=>{startFailed=true;});
    const timeout=setTimeout(()=>{timedOut=true;child.kill();},180000);
    child.once('close',async code=>{
      clearTimeout(timeout);
      try {
        if(timedOut||startFailed||code!==0) throw new Error(timedOut?'board_launcher_timeout':startFailed?'board_launcher_start_failed':'board_launcher_run_failed');
        const {view}=await next.evidence.get(target.modelSha256);
        if(view.status!=='completed'||!view.previewStopped||!view.staticBpu||!view.latestDetection||
            !['verified','no_write'].includes(view.restoration)) throw new Error('board_launcher_receipt_incomplete');
        if(approved&&(view.readbackHash!==approved.hash||view.restoration!=='verified'||!view.approvedGamma)) throw new Error('board_launcher_receipt_incomplete');
        if(comparison) {
          if(view.comparison?.settings.approvedBaselineHash!==approved.originalHash||view.comparison?.after.tuningHash!==approved.hash) {
            throw new Error('board_launcher_receipt_incomplete');
          }
          await next.evidence.file(target.modelSha256,view.comparison.before.file,view.receiptSha256);
        }
        await next.evidence.file(target.modelSha256,view.latestDetection.file,view.receiptSha256);
        await next.evidence.file(target.modelSha256,'loaded-isp.json',view.receiptSha256);
        if(view.restoration==='verified') await next.evidence.file(target.modelSha256,'restored-isp.json',view.receiptSha256);
        const latest=pointer(selection.path);
        const temporary=path.join(lease,'receipt.json');
        writeFileSync(temporary,JSON.stringify({id,modelHash:target.modelSha256}),{flag:'wx',mode:0o600});
        renameSync(temporary,latest);
        next.state='completed';
      } catch (error) {
        next.state='failed';
        next.error=error.message.startsWith('board_launcher_')?error.message:'board_launcher_receipt_incomplete';
      } finally {
        try {rmdirSync(lease);}
        catch {next.state='failed';next.error='board_launcher_locked';}
      }
    });
    return status(selection);
  }
  return {status,start,running,evidence};
}
