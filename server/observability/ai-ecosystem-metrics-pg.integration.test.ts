import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const databaseUrl=process.env.DOBS_TEST_DATABASE_URL;
const exec=promisify(execFile);
const literal=(value:unknown)=>JSON.stringify(value);
async function child(code:string):Promise<any> {
  const script=`import { enqueueMetricPoints,queryMetricSeries,closeAiEcosystemMetricStoreForTest } from './server/observability/ai-ecosystem-metrics-store.ts';
    try { ${code} } finally { await closeAiEcosystemMetricStoreForTest(); }`;
  const result=await exec(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),timeout:30_000,env:{...process.env,RDK_CHAT_CREDITS_DB_URL:databaseUrl!,RDK_OBSERVABILITY_ENVIRONMENT:'test'},maxBuffer:1024*1024});
  return JSON.parse(result.stdout.trim());
}

test('acknowledged metrics survive process exit and retries do not duplicate samples', {skip:!databaseUrl}, async()=>{
  const owner=`metric-restart-${randomUUID()}`,name=`restart_${randomUUID().replaceAll('-','')}`,timestampMs=Date.now();
  const points=[{name,value:2,timestampMs,labels:{service:'restart'}},{name,value:3,timestampMs,labels:{service:'restart'}}];
  assert.equal(await child(`console.log(JSON.stringify(await enqueueMetricPoints(${literal(owner)},${literal(points)})));`),0);
  const first=await child(`console.log(JSON.stringify(await queryMetricSeries({owner:${literal(owner)},metric:${literal(name)}})));`);
  assert.equal(first[0].lastValue,3);
  assert.equal(await child(`console.log(JSON.stringify(await enqueueMetricPoints(${literal(owner)},${literal(points)})));`),0);
  const pg=await import('pg' as string);const p=new pg.default.Pool({connectionString:databaseUrl});
  try {
    const rows=await p.query('select count(*) from public.studio_observability_metric_samples m join public.studio_observability_metric_series s using(series_id) where s.owner=$1 and s.metric=$2',[owner,name]);
    assert.equal(Number(rows.rows[0].count),1);
  } finally { await p.end(); }
});

test('HTTP and gRPC acknowledge PG commits and return retryable errors on write failure', {skip:!databaseUrl}, async()=>{
  const name=`transport_${randomUUID().replaceAll('-','')}`;
  const result=await child(`
    const { default:express }=await import('express');
    const { createAiEcosystemRouter }=await import('./server/observability/ai-ecosystem-routes.ts');
    const { startAiEcosystemGrpcServer }=await import('./server/observability/ai-ecosystem-grpc.ts');
    const { metricsServiceClient }=await import('./server/observability/ai-ecosystem-protobuf.ts');
    const { Metadata,credentials }=await import('@grpc/grpc-js');
    const pg=await import('pg'); const p=new pg.default.Pool({connectionString:process.env.RDK_CHAT_CREDITS_DB_URL});
    process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN='durable-transport-token';
    const app=express();app.use(express.json());app.use(createAiEcosystemRouter());
    const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
    const grpc=await startAiEcosystemGrpcServer({host:'127.0.0.1',port:0});
    const client=new metricsServiceClient(grpc.address,credentials.createInsecure());
    const metadata=new Metadata();metadata.set('authorization','Bearer durable-transport-token');
    const payload=(value,ts)=>({resourceMetrics:[{scopeMetrics:[{metrics:[{name:${literal(name)},gauge:{dataPoints:[{asDouble:value,timeUnixNano:String(BigInt(ts)*1000000n)}]}}]}]}]});
    const call=body=>new Promise(resolve=>client.Export(body,metadata,(error,response)=>resolve(error?{code:error.code}:{response})));
    const post=body=>fetch('http://127.0.0.1:'+http.address().port+'/v1/metrics',{method:'POST',headers:{authorization:'Bearer durable-transport-token','content-type':'application/json'},body:JSON.stringify(body)});
    const ts=Date.now();
    const precisionPayload={resourceMetrics:[{scopeMetrics:[{metrics:[{name:${literal(name)}+'_precision',gauge:{dataPoints:Array.from({length:8},(_,point)=>({asDouble:point,timeUnixNano:String(BigInt(ts+point)*1000000n)}))}}]}]}]};
    const precisionHttp=await post(precisionPayload);
    const precisionRows=await p.query('select m.ts_ms,m.value from public.studio_observability_metric_samples m join public.studio_observability_metric_series s using(series_id) where s.metric=$1 order by m.ts_ms',[${literal(name)}+'_precision']);
    const goodHttp=await post(payload(21,ts)); const goodHttpBody=await goodHttp.json();
    const afterHttp=await p.query('select m.value from public.studio_observability_metric_samples m join public.studio_observability_metric_series s using(series_id) where s.metric=$1 and m.ts_ms=$2',[${literal(name)},ts]);
    const goodGrpc=await call(payload(22,ts+1));
    const afterGrpc=await p.query('select m.value from public.studio_observability_metric_samples m join public.studio_observability_metric_series s using(series_id) where s.metric=$1 and m.ts_ms=$2',[${literal(name)},ts+1]);
    const trigger=${literal(`reject_metric_${randomUUID().replaceAll('-','')}`)};
    await p.query('create function public.'+trigger+"() returns trigger language plpgsql as $$ begin if NEW.value = -98765 then raise exception 'forced metric failure'; end if; return NEW; end $$; create trigger "+trigger+' before insert or update on public.studio_observability_metric_samples for each row execute function public.'+trigger+'()');
    const badHttp=await post(payload(-98765,ts+2)); const badHttpBody=await badHttp.json();
    const badGrpc=await call(payload(-98765,ts+3));
    const failedWrites=await p.query('select count(*) from public.studio_observability_metric_samples m join public.studio_observability_metric_series s using(series_id) where s.metric=$1 and m.ts_ms in ($2,$3)',[${literal(name)},ts+2,ts+3]);
    await p.query('drop trigger '+trigger+' on public.studio_observability_metric_samples;drop function public.'+trigger+'()');
    console.log(JSON.stringify({precisionHttp:precisionHttp.status,precision:precisionRows.rows.map((row,index)=>({offset:Number(row.ts_ms)-ts,value:row.value})),goodHttp:goodHttp.status,goodHttpBody,httpValue:afterHttp.rows[0]?.value,goodGrpc,grpcValue:afterGrpc.rows[0]?.value,badHttp:badHttp.status,badHttpBody,badGrpc,failedWrites:Number(failedWrites.rows[0].count)}));
    client.close();grpc.server.forceShutdown();await new Promise(resolve=>http.close(resolve));await p.end();
    await closeAiEcosystemMetricStoreForTest();process.exit(0);
  `);
  assert.equal(result.precisionHttp,200);
  assert.deepEqual(result.precision,Array.from({length:8},(_,point)=>({offset:point,value:point})));
  assert.equal(result.goodHttp,200);
  assert.equal(result.goodHttpBody.partialSuccess.rejectedDataPoints,0);
  assert.equal(result.httpValue,21);
  assert.equal(result.goodGrpc.response.partialSuccess.rejectedDataPoints,'0');
  assert.equal(result.grpcValue,22);
  assert.equal(result.badHttp,503);
  assert.equal(result.badGrpc.code,14);
  assert.equal(result.failedWrites,0);
});
