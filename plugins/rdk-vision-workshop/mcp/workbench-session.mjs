import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname,join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startWorkbench } from './workbench.mjs';
import { readWorkbenchState,writeWorkbenchState } from './workbench-state.mjs';

const worker=fileURLToPath(import.meta.url);
const sessionUrl=/^http:\/\/127\.0\.0\.1:\d{1,5}\/#[-a-f0-9]{36}$/;
const idleMs=8*60*60*1000;
const launchTimeoutMs=8000;

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

export function workbenchSession(root=join(homedir(),'.rdk-vision-workshop')) {
  const scope=createHash('sha256').update(worker+'|persistent-workbench').digest('hex').slice(0,32);
  const directory=join(root,scope);
  // The 1.4.1 detached worker may still be running after an in-place import.
  const registry=join(directory,'session-capture-v1');
  const lock=join(directory,'starting-capture-v1');
  async function open() {
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
        const child=spawn(process.execPath,[worker,'--serve',registry],{detached:true,stdio:'ignore',windowsHide:true});
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

  return {open,async sync(body) {
    const url=await active(registry);
    if (!url) throw new Error('open_workbench_first');
    return request(url,body);
  },async camera(body) {
    const url=await open();
    const target=new URL(url);
    target.searchParams.set('panel','capture');
    return {url:target.href,...await request(url,body,'/camera/capture')};
  }};
}

async function serve(registry) {
  const temporary=registry+'.'+process.pid;
  const stateFile=join(dirname(registry),'workbench-state-capture-v1.json');
  const previous=process.env.RDK_VISION_COURSE_PREVIOUS_SESSION;
  if(!readWorkbenchState(stateFile)) {
    const legacy=readWorkbenchState(join(dirname(registry),'workbench-state.json'));
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
  const view=await startWorkbench({},0,undefined,{idleMs,stateFile});
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
  await serve(process.argv[3]);
}
