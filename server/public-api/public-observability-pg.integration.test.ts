import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.DOBS_TEST_DATABASE_URL;
const exec = promisify(execFile);
const runChild = async (code:string, url=databaseUrl): Promise<any> => {
  const script = `import { PublicObservabilityStore } from './server/public-api/public-observability-store.ts';
    import { configuredPublicObservabilityIndex } from './server/public-api/public-observability-pg-index.ts';
    import { closePublicObservabilityQualityStoreForTest } from './server/public-api/public-observability-quality-store.ts';
    import { closeStudioTraceStoreForTest } from './server/observability/studio-trace-store.ts';
    const store = new PublicObservabilityStore();
    try { ${code} } finally { await configuredPublicObservabilityIndex()?.close(); await closePublicObservabilityQualityStoreForTest(); await closeStudioTraceStoreForTest(); }`;
  const result = await exec(process.execPath, ['--import','tsx','--input-type=module','-e',script], {
    cwd:process.cwd(), timeout:30_000, env:{...process.env,RDK_CHAT_CREDITS_DB_URL:url!,RDK_OBSERVABILITY_ENVIRONMENT:'test'}, maxBuffer:1024*1024,
  });
  return JSON.parse(result.stdout.trim());
};
const input = {projectId:'restart-project',environment:'test',service:'restart-service',team:'restart-team',objectType:'agent',objectId:'restart-agent'};
const literal=(value:unknown)=>JSON.stringify(value);

async function connect() {
  const module=await import('pg' as string);
  const p = new module.default.Pool({connectionString:databaseUrl,max:2});
  return p;
}

test('PG index survives process restart with run status, profiles, quality and idempotency', {skip:!databaseUrl}, async () => {
  const owner=`pg-restart-${randomUUID()}`, key='restart-key', idem='create-once';
  const created=await runChild(`const result=await store.createRun(${literal(owner)},${literal(key)},${literal({...input,idempotencyKey:idem})});
    await store.appendSpans({owner:${literal(owner)},keyId:${literal(key)},runId:result.run.runId,status:'completed',spans:[{spanId:'aaaa000000000001',kind:'generation',name:'test generation',startTime:Date.now(),endTime:Date.now()+5,status:'ok',attributes:{inputTokens:9,outputTokens:3}}]});
    await store.recordScore({owner:${literal(owner)},runId:result.run.runId,name:'quality',value:0.9});
    await store.recordFeedback({owner:${literal(owner)},runId:result.run.runId,kind:'up',userMessage:'raw prompt must stay outside additional projection',assistantMessage:'raw completion'});
    await store.persistObject(${literal(owner)},'restart-agent',{team:'restart-team',objectType:'agent',displayName:'durable profile',labels:['persistent']});
    console.log(JSON.stringify(result));`);
  const recovered=await runChild(`await store.refreshOwnerIndex(${literal(owner)});
    const replay=await store.createRun(${literal(owner)},${literal(key)},${literal({...input,runId:'must-not-create',idempotencyKey:idem})});
    console.log(JSON.stringify({runs:store.listRuns(${literal(owner)}),object:store.getObject(${literal(owner)},'restart-agent',{team:'restart-team',objectType:'agent'}),summary:store.summarize(${literal(owner)}),replay,persistence:store.getPersistenceStatus(),snapshot:store.exportSnapshot()}));`);
  assert.equal(recovered.runs.length,1);
  assert.equal(recovered.runs[0].runId,created.run.runId);
  assert.equal(recovered.runs[0].status,'completed');
  assert.equal(recovered.runs[0].spanCount,2);
  assert.equal(recovered.runs[0].scoreCount,1);
  assert.equal(recovered.object.object.profile.displayName,'durable profile');
  assert.equal(recovered.summary.quality.averageScores.quality,0.9);
  assert.equal(recovered.replay.replayed,true);
  assert.equal(recovered.replay.run.runId,created.run.runId);
  assert.equal(recovered.persistence.authoritative,'postgres');
  assert.equal(recovered.persistence.degraded,false);
  assert.equal(recovered.snapshot.runs[0].feedback[0].userMessage,undefined);
  assert.equal(recovered.snapshot.runs[0].feedback[0].assistantMessage,undefined);
});

test('separate replicas serialize idempotency, disjoint span appends and object patches', {skip:!databaseUrl}, async () => {
  const owner=`pg-replicas-${randomUUID()}`, key='replica-key', idem='concurrent-create';
  const results=await Promise.all([1,2].map(replica=>runChild(`const result=await store.createRun(${literal(owner)},${literal(key)},${literal({...input,runId:`replica-${replica}-${randomUUID()}`,idempotencyKey:idem})});console.log(JSON.stringify(result));`)));
  assert.equal(results[0].run.runId,results[1].run.runId);
  assert.deepEqual(results.map(result=>result.replayed).sort(),[false,true]);
  const runId=results[0].run.runId;
  await Promise.all([1,2].map(replica=>runChild(`const result=await store.appendSpans({owner:${literal(owner)},keyId:${literal(key)},runId:${literal(runId)},spans:[{spanId:${literal(`bbbb00000000000${replica}`)},name:'parallel span',startTime:Date.now(),endTime:Date.now()+2}]});console.log(JSON.stringify(result));`)));
  await Promise.all([
    runChild(`const result=await store.persistObject(${literal(owner)},'restart-agent',{team:'restart-team',objectType:'agent',labels:['parallel']});console.log(JSON.stringify(result));`),
    runChild(`const result=await store.persistObject(${literal(owner)},'restart-agent',{team:'restart-team',objectType:'agent',description:'parallel description'});console.log(JSON.stringify(result));`),
  ]);
  const recovered=await runChild(`await store.refreshOwnerIndex(${literal(owner)});console.log(JSON.stringify({runs:store.listRuns(${literal(owner)}),object:store.getObject(${literal(owner)},'restart-agent',{team:'restart-team',objectType:'agent'})}));`);
  assert.equal(recovered.runs.length,1);
  assert.equal(recovered.runs[0].spanCount,3);
  assert.deepEqual(recovered.object.object.profile.labels,['parallel']);
  assert.equal(recovered.object.object.profile.description,'parallel description');
  const conflict=await runChild(`try { await store.ensureRun('other-owner','other-key',${literal({...input,runId})});console.log(JSON.stringify({failed:false})); } catch(error) { console.log(JSON.stringify({failed:true,error:error.name})); }`);
  assert.deepEqual(conflict,{failed:true,error:'PublicObservabilityConflictError'});
});

test('failed index commit rolls back trace/quality writes; tombstones prevent replica resurrection', {skip:!databaseUrl}, async () => {
  const owner=`pg-rollback-${randomUUID()}`, runId=`rollback-${randomUUID()}`;
  await runChild(`console.log(JSON.stringify(await store.createRun(${literal(owner)},'rollback-key',${literal({...input,runId})})));`);
  const p=await connect();
  const name=`reject_public_index_${randomUUID().replaceAll('-','')}`;
  try {
    await p.query(`create function public.${name}() returns trigger language plpgsql as $$ begin if NEW.owner = '${owner}' then raise exception 'forced index failure'; end if; return NEW; end $$; create trigger ${name} before update on public.studio_public_observability_runs for each row execute function public.${name}()`);
    const failed=await runChild(`const failures=[];
      try { await store.recordScore({owner:${literal(owner)},runId:${literal(runId)},name:'rollback score',value:1}); } catch { failures.push('quality'); }
      try { await store.appendSpans({owner:${literal(owner)},keyId:'rollback-key',runId:${literal(runId)},spans:[{spanId:'cccc000000000001',name:'rollback span',startTime:Date.now(),endTime:Date.now()+1}]}); } catch { failures.push('trace'); }
      console.log(JSON.stringify(failures));`);
    assert.deepEqual(failed,['quality','trace']);
    assert.equal(Number((await p.query('select count(*) from public.studio_public_observability_scores where account_scope_id=$1',[owner])).rows[0].count),0);
    assert.equal(Number((await p.query('select count(*) from public.studio_trace_spans where account_scope_id=$1',[owner])).rows[0].count),1);
    await p.query(`drop trigger ${name} on public.studio_public_observability_runs; drop function public.${name}()`);
    await p.query('insert into public.studio_telemetry_tombstones(request_id,account_scope_id,environment,run_id) values($1,$2,$3,$4)',[randomUUID(),owner,'test',runId]);
    const deleted=await runChild(`await store.refreshOwnerIndex(${literal(owner)});let rejected=false;
      try { await store.ensureRun(${literal(owner)},'rollback-key',${literal({...input,runId})}); } catch { rejected=true; }
      console.log(JSON.stringify({runs:store.listRuns(${literal(owner)}),rejected}));`);
    assert.deepEqual(deleted,{runs:[],rejected:true});
  } finally {
    await p.query(`drop trigger if exists ${name} on public.studio_public_observability_runs; drop function if exists public.${name}()`);
    await p.end();
  }
});


test('physical expiry deletes run authority and its idempotency aliases', {skip:!databaseUrl}, async()=>{
  const owner=`pg-expiry-${randomUUID()}`,runId=`expiry-${randomUUID()}`;
  await runChild(`console.log(JSON.stringify(await store.createRun(${literal(owner)},'expiry-key',${literal({...input,runId,idempotencyKey:'expire-once'})})));`);
  const p=await connect();
  try {
    await p.query('update public.studio_public_observability_runs set expires_at_ms=$1 where environment=$2 and run_id=$3',[Date.now()-1,'test',runId]);
    const after=await runChild(`await store.refreshOwnerIndex(${literal(owner)});console.log(JSON.stringify(store.listRuns(${literal(owner)})));`);
    assert.deepEqual(after,[]);
    assert.equal(Number((await p.query('select count(*) from public.studio_public_observability_runs where environment=$1 and run_id=$2',['test',runId])).rows[0].count),0);
    assert.equal(Number((await p.query('select count(*) from public.studio_public_observability_idempotency where environment=$1 and owner=$2',['test',owner])).rows[0].count),0);
  } finally { await p.end(); }
});


test('a trace/span ID already owned by another run cannot be silently acknowledged', {skip:!databaseUrl}, async()=>{
  const owner=`pg-span-conflict-${randomUUID()}`,first=`first-${randomUUID()}`,second=`second-${randomUUID()}`,traceId=randomUUID().replaceAll('-','');
  const result=await runChild(`
    await store.createRun(${literal(owner)},'conflict-key',${literal({...input,runId:first,traceId})});
    await store.createRun(${literal(owner)},'conflict-key',${literal({...input,runId:second,traceId})});
    const spans=[{spanId:'dddd000000000001',name:'conflicting span',startTime:Date.now(),endTime:Date.now()+1}];
    await store.appendSpans({owner:${literal(owner)},keyId:'conflict-key',runId:${literal(first)},spans});
    let rejected=false;
    try { await store.appendSpans({owner:${literal(owner)},keyId:'conflict-key',runId:${literal(second)},spans}); } catch { rejected=true; }
    console.log(JSON.stringify({rejected,run:await store.getRun(${literal(owner)},${literal(second)})}));
  `);
  assert.equal(result.rejected,true);
  assert.equal(result.run.spanCount,1);
});


test('two first-start replicas initialize a fresh schema without DDL/write deadlocks', {skip:!databaseUrl}, async()=>{
  const p=await connect();
  const name=`dobs_fresh_${randomUUID().replaceAll('-','')}`;
  const url=new URL(databaseUrl!);url.pathname=`/${name}`;
  try {
    await p.query(`create database ${name}`);
    const owner=`fresh-owner-${randomUUID()}`;
    const results=await Promise.all([1,2].map(replica=>runChild(`console.log(JSON.stringify(await store.createRun(${literal(owner)},'fresh-key',${literal({...input,runId:`fresh-${replica}`,idempotencyKey:'first-start'})})));`,url.toString())));
    assert.equal(results[0].run.runId,results[1].run.runId);
    assert.deepEqual(results.map(result=>result.replayed).sort(),[false,true]);
  } finally {
    await p.query(`drop database if exists ${name} with (force)`);
    await p.end();
  }
});

test('request-local PG read views survive another owner evicting the shared cache', {skip:!databaseUrl}, async()=>{
  const first=`view-first-${randomUUID()}`,second=`view-second-${randomUUID()}`,runId=`view-${randomUUID()}`;
  await runChild(`console.log(JSON.stringify(await store.createRun(${literal(first)},'view-key',${literal({...input,runId})})));`);
  const p=await connect();
  try {
    await p.query(`insert into public.studio_public_observability_runs(environment,run_id,owner,account_scope_id,payload,updated_at_ms,expires_at_ms)
      select environment,$2||'-'||n,$2,$2,
        jsonb_set(jsonb_set(payload,'{run,runId}',to_jsonb($2||'-'||n)),'{run,owner}',to_jsonb($2::text)),updated_at_ms+n,expires_at_ms
      from public.studio_public_observability_runs cross join generate_series(1,2000) n where run_id=$1`,[runId,second]);
    const result=await runChild(`const firstView=await store.refreshOwnerIndex(${literal(first)});
      const secondView=await store.refreshOwnerIndex(${literal(second)});
      console.log(JSON.stringify({first:firstView.listRuns(${literal(first)}).length,second:secondView.listRuns(${literal(second)}).length,shared:store.listRuns(${literal(first)}).length}));`);
    assert.deepEqual(result,{first:1,second:50,shared:0});
  } finally {
    await p.query('delete from public.studio_public_observability_runs where owner=$1',[second]);
    await p.end();
  }
});

test('authenticated account attribution and session tombstones cover the new durable projection', {skip:!databaseUrl}, async()=>{
  const owner=`scope-owner-${randomUUID()}`,account=`scope-account-${randomUUID()}`,runId=`scope-${randomUUID()}`,sessionRef=`session-${randomUUID()}`;
  await runChild(`await store.createRun(${literal(owner)},'scope-key',${literal({...input,runId,sessionRef})});
    console.log(JSON.stringify(await store.appendSpans({owner:${literal(owner)},keyId:'scope-key',runId:${literal(runId)},accountScopeId:${literal(account)},spans:[{spanId:'eeee000000000001',name:'scoped span',startTime:Date.now(),endTime:Date.now()+1}]})));`);
  const p=await connect();
  try {
    const row=await p.query('select account_scope_id from public.studio_public_observability_runs where run_id=$1',[runId]);
    assert.equal(row.rows[0].account_scope_id,account);
    await p.query('insert into public.studio_telemetry_tombstones(request_id,account_scope_id,environment,session_id) values($1,$2,$3,$4)',[randomUUID(),account,'test',sessionRef]);
    const result=await runChild(`const view=await store.refreshOwnerIndex(${literal(owner)});let rejected=false;
      try { await store.appendSpans({owner:${literal(owner)},keyId:'scope-key',runId:${literal(runId)},accountScopeId:${literal(account)},run:${literal({...input,sessionRef})},spans:[{spanId:'ffff000000000001',name:'must reject',startTime:Date.now(),endTime:Date.now()+1}]}); } catch {rejected=true;}
      console.log(JSON.stringify({runs:view.listRuns(${literal(owner)}),rejected}));`);
    assert.deepEqual(result,{runs:[],rejected:true});
  } finally { await p.end(); }
});

test('tombstone insertion waits for index writers, then prevents writes after deletion', {skip:!databaseUrl}, async()=>{
  const owner=`barrier-owner-${randomUUID()}`,runId=`barrier-${randomUUID()}`;
  await runChild(`console.log(JSON.stringify(await store.createRun(${literal(owner)},'barrier-key',${literal({...input,runId})})));`);
  const { PublicObservabilityPgIndex,purgePublicObservabilityIndex }=await import('./public-observability-pg-index.js');
  const { PostgresTelemetryGovernanceRepository }=await import('../observability/governance-postgres-runtime.js');
  const previous=process.env.RDK_OBSERVABILITY_ENVIRONMENT;process.env.RDK_OBSERVABILITY_ENVIRONMENT='test';
  const index=new PublicObservabilityPgIndex(databaseUrl!);const p=await connect();
  let release!:()=>void,ready!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const acquired=new Promise<void>(resolve=>{ready=resolve;});
  try {
    const write=index.mutateRun({owner,keyId:'barrier-key',runId},async existing=>{
      assert.ok(existing);ready();await gate;return {result:true,snapshot:existing};
    });
    await acquired;
    let committed=false;
    const deleting=new PostgresTelemetryGovernanceRepository(p).putIfAbsent({accountScopeId:owner,environment:'test',requestId:randomUUID(),runId,createdAt:Date.now()}).then(t=>{committed=true;return t;});
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(committed,false);
    release();await write;
    const tombstone=await deleting;await purgePublicObservabilityIndex(p,tombstone);
    const rows=await index.loadOwner(owner,35*24*60*60_000);assert.equal(rows.runs.length,0);
    await assert.rejects(index.mutateRun({owner,keyId:'barrier-key',runId},async()=>({result:true,snapshot:{run:{...input,runId,owner,keyId:'barrier-key',traceId:'a'.repeat(32),status:'running',createdAt:Date.now(),updatedAt:Date.now(),spanCount:0,errorSpanCount:0,scoreCount:0,feedbackCount:0,evaluationCount:0,metadata:{}},spans:[],scores:[],feedback:[],evaluations:[]}})),/observability_run_deleted/);
  } finally {
    release();await index.close();await p.end();
    if(previous===undefined) delete process.env.RDK_OBSERVABILITY_ENVIRONMENT;else process.env.RDK_OBSERVABILITY_ENVIRONMENT=previous;
  }
});


test('non-root trace and per-fragment session tombstones protect multi-trace run projections', {skip:!databaseUrl}, async()=>{
  const owner=`fragment-tombstone-${randomUUID()}`,runId=`fragment-run-${randomUUID()}`;
  const traceA=randomUUID().replaceAll('-',''),traceB=randomUUID().replaceAll('-',''),sessionB=`fragment-session-${randomUUID()}`;
  await runChild(`console.log(JSON.stringify(await store.appendSpans({owner:${literal(owner)},keyId:'fragment-key',runId:${literal(runId)},traceId:${literal(traceA)},run:${literal(input)},spans:[
    {traceId:${literal(traceA)},spanId:'aaaa00000000000a',name:'root fragment',startTime:Date.now(),endTime:Date.now()+1},
    {traceId:${literal(traceB)},spanId:'bbbb00000000000b',name:'non-root fragment',startTime:Date.now(),endTime:Date.now()+1,attributes:{sessionRef:${literal(sessionB)}}}
  ]})));`);
  const p=await connect();
  try {
    const spans=await p.query('select trace_id,session_id from public.studio_trace_spans where account_scope_id=$1 order by span_id',[owner]);
    assert.equal(spans.rows.length,2);
    assert.ok(spans.rows.every((span:any)=>span.session_id===sessionB));
    await p.query('insert into public.studio_telemetry_tombstones(request_id,account_scope_id,environment,session_id) values($1,$2,$3,$4)',[randomUUID(),owner,'test',sessionB]);
    const blocked=await runChild(`const view=await store.refreshOwnerIndex(${literal(owner)}); console.log(JSON.stringify({runs:view.listRuns(${literal(owner)}),trace:await store.getTrace(${literal(owner)},${literal(runId)})}));`);
    assert.deepEqual(blocked.runs,[]);
    // Current conversation binding attributes every fragment in this Run to
    // the same session; deleting that session removes both fragments.
    assert.equal(blocked.trace,null);
    // A second explicit trace selector still guards the non-root fragment when
    // session metadata is absent or a backup restores the original projection.
    await p.query('delete from public.studio_telemetry_tombstones where account_scope_id=$1',[owner]);
    await runChild(`console.log(JSON.stringify(await store.appendSpans({owner:${literal(owner)},keyId:'fragment-key',runId:${literal(runId)},traceId:${literal(traceA)},run:${literal(input)},spans:[
      {traceId:${literal(traceB)},spanId:'bbbb00000000000b',name:'non-root fragment',startTime:Date.now(),endTime:Date.now()+1}
    ]})));`);
    await p.query('insert into public.studio_telemetry_tombstones(request_id,account_scope_id,environment,trace_id) values($1,$2,$3,$4)',[randomUUID(),owner,'test',traceB]);
    const traceBlocked=await runChild(`const view=await store.refreshOwnerIndex(${literal(owner)});console.log(JSON.stringify({runs:view.listRuns(${literal(owner)}),trace:await store.getTrace(${literal(owner)},${literal(runId)})}));`);
    assert.deepEqual(traceBlocked.runs,[]);
    assert.ok(traceBlocked.trace?.every((span:any)=>span.traceId!==traceB));
  } finally { await p.end(); }
});
