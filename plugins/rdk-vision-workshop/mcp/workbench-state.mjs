import {closeSync,fsyncSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export function readWorkbenchState(file) {
  if (!file) return undefined;
  try {
    const state=JSON.parse(readFileSync(file,'utf8'));
    if (state.version!==1||!state.resume||!['idle','pending','accepted'].includes(state.submission)) {
      throw new Error('workbench_state_invalid');
    }
    return state;
  } catch (error) {
    if (error.code==='ENOENT') return undefined;
    throw error;
  }
}

export function writeWorkbenchState(file,state) {
  if (!file) return;
  const pending=file+'.'+randomUUID();
  try {
    const fd=openSync(pending,'wx',0o600);
    try {
      writeFileSync(fd,JSON.stringify({version:1,...state}));
      fsyncSync(fd);
    } finally {closeSync(fd);}
    renameSync(pending,file);
  } finally {rmSync(pending,{force:true});}
}
