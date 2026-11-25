import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {classroomClock, classroomStep, guideCourse} from './guide.mjs';
import {steps} from './steps.mjs';
import {startWorkbench} from './workbench.mjs';

const plan=JSON.parse(readFileSync(new URL('../skills/rdk-vision-workshop/assets/ddc-2026-12-06.json',import.meta.url)));
const model='a'.repeat(64);
const evidence=Object.fromEntries(['intro','connect','data','quantize'].flatMap(id=>steps[id].fields.map(key=>[key,'课堂测试回执'])));
evidence.x5_model_hash=model;
evidence.preset_model='课程备用 · sha256:'+'b'.repeat(64);
const run={id:'fixture-ddc-task',source:'external',state:'artifact_ready',receipt:'模拟原训练回执'};

test('event plan aligns the wall clock and direct training instructions and gates A/B/C at 11:45',()=>{
  assert.deepEqual(['submitStart','runCheckpoint','deployAt'].map(key=>classroomClock(plan,plan.deadlines[key])),
    ['10:10','11:30','11:45']);
  for(const [i,stage] of plan.schedule.entries()) {
    assert.equal(stage.start,plan.schedule[i-1]?.end??0);
    assert.equal(stage.end-stage.start,stage.minutes);
  }
  assert.equal(plan.schedule.at(-1).end,180);
  assert.match(classroomStep(plan,'train').title,/开发机/);
  assert.doesNotMatch(classroomStep(plan,'train').ask,/RoboGO/);
  assert.equal(guideCourse(plan,{evidence,elapsedMinutes:40}).nextStep.stageId,'train');
  assert.equal(guideCourse(plan,{evidence,run,elapsedMinutes:134}).routing.eligible,false);
  assert.equal(guideCourse(plan,{evidence,run,elapsedMinutes:135}).routing.recommended,'A');
  assert.equal(guideCourse(plan,{evidence,elapsedMinutes:135}).routing.recommended,'B');
  assert.equal(guideCourse(plan,{evidence,elapsedMinutes:135,blockers:{vision_device_transport_failed:'板卡未连'} }).routing.recommended,'C');
  const withoutConnection={...evidence};
  delete withoutConnection.fresh_camera_image;
  assert.equal(guideCourse(plan,{evidence:withoutConnection,run,elapsedMinutes:135}).routing.recommended,'C');
});

test('event workbench rejects cloud submission, early routing and accidental replacement of the original task',async t=>{
  const view=await startWorkbench({elapsedMinutes:130,evidence,run},0,undefined,{classroomPlan:plan});
  t.after(()=>new Promise(resolve=>view.server.close(resolve)));
  const base=new URL(view.url);
  const secret=base.hash.slice(1);
  const headers={'X-Workshop-Session':secret,'Content-Type':'application/json'};
  const call=(path,body)=>fetch(new URL(path,base),{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  for(const route of ['prepare','submit','connect']) {
    const response=await call('/robogo/'+route,{});
    assert.equal((await response.json()).error,'robogo_devmachine_classroom');
  }
  const course=await(await call('/course.json?view='+secret)).json();
  assert.equal(course.plan.classroomId,plan.classroomId);
  const external=await call('/session',{replace:true,patch:{path:'A',elapsedMinutes:134}});
  assert.equal((await external.json()).error,'route_not_open');
  const wrong=await call('/session',{patch:{run:{...run,id:'wrong'}}});
  assert.equal((await wrong.json()).error,'run_receipt_mismatch');
  const accepted=await call('/session',{patch:{path:'A',elapsedMinutes:135}});
  assert.equal((await accepted.json()).resume.path,'A');
});
