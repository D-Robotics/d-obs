import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Metadata, credentials, type Client } from '@grpc/grpc-js';
import express from 'express';
import { after, before, test } from 'node:test';
import { createPublicObservabilityClient } from '../../shared/public-observability-client.js';
import { createPublicObservabilityRouter } from '../public-api/public-observability-routes.js';
import { createAiEcosystemRouter } from './ai-ecosystem-routes.js';
import { startAiEcosystemGrpcServer } from './ai-ecosystem-grpc.js';
import {
  encodeMetricsProtobuf,
  encodeTraceProtobuf,
  metricsServiceClient,
  traceServiceClient,
} from './ai-ecosystem-protobuf.js';

let server: Server;
let baseUrl = '';
let previousToken: string | undefined;

before(async () => {
  previousToken = process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
  process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = 'ecosystem-test-token';
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Ecosystem endpoints must be mounted before the public API auth facade;
  // `/v1/traces` is not a public run CRUD route.
  app.use(createAiEcosystemRouter());
  app.use(createPublicObservabilityRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousToken === undefined) delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
  else process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = previousToken;
});

function otlpSpan(runId: string): Record<string, unknown> {
  const start = Date.now();
  return {
    traceId: '11111111111111111111111111111111',
    spanId: '2222222222222222',
    name: 'chat completion',
    startTimeUnixNano: String(start * 1_000_000),
    endTimeUnixNano: String((start + 5) * 1_000_000),
    status: { code: 1 },
    attributes: [
      { key: 'moss.run.id', value: { stringValue: runId } },
      { key: 'gen_ai.request.model', value: { stringValue: 'test-model' } },
      { key: 'gen_ai.system', value: { stringValue: 'test-provider' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '8' } },
    ],
  };
}

test('accepts OTLP/HTTP JSON and exposes the run through the public SDK', async () => {
  const runId = `otel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ecosystem-test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'otel-agent' } },
            { key: 'deployment.environment.name', value: { stringValue: 'test' } },
            { key: 'project.id', value: { stringValue: 'ecosystem' } },
          ],
        },
        scopeSpans: [{ spans: [otlpSpan(runId)] }],
      }],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { partialSuccess: { rejectedSpans: 0 } });

  const client = createPublicObservabilityClient({ baseUrl, authorization: 'ecosystem-test-token' });
  const run = await client.getRun(runId);
  assert.equal(run.projectId, 'ecosystem');
  assert.equal(run.service, 'otel-agent');
  assert.equal((await client.getTrace(runId)).trace[0]?.kind, 'generation');

  const evaluation = await client.recordEvaluation(runId, {
    name: 'groundedness',
    value: 0.92,
    threshold: 0.85,
    evaluator: 'offline-judge-v3',
    dataset: 'support-regression',
    modelVersion: 'test-model-v2',
    promptVersion: 'answer-v1',
    metadata: { experiment: 'candidate', variant: 'b' },
  });
  assert.equal(evaluation.status, 'passed');
  assert.equal(evaluation.evaluator, 'offline-judge-v3');
  assert.deepEqual((await client.getEvaluations(runId)).map((item) => item.evaluationId), [evaluation.evaluationId]);
});

test('accepts Phoenix/Langfuse-compatible OTLP aliases and exposes Prometheus metrics', async () => {
  const runId = `alias-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${baseUrl}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: { 'x-api-key': 'ecosystem-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'phoenix-agent' } }] },
        scopeSpans: [{ spans: [otlpSpan(runId)] }],
      }],
    }),
  });
  assert.equal(response.status, 200);

  const metricsResponse = await fetch(`${baseUrl}/v1/metrics`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ecosystem-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceMetrics: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'metrics-agent' } },
          { key: 'gen_ai.request.model', value: { stringValue: 'test-model' } },
          { key: 'rdk.robot.id', value: { stringValue: 'robot-01' } },
          { key: 'rdk.firmware.version', value: { stringValue: 'fw-2.1.0' } },
        ] },
        scopeMetrics: [{
          metrics: [{
            name: 'gen_ai.client.token.usage',
            sum: { dataPoints: [{ asInt: '20', timeUnixNano: String(Date.now() * 1_000_000) }] },
          }],
        }],
      }],
    }),
  });
  assert.equal(metricsResponse.status, 200);
  assert.equal((await metricsResponse.json() as { partialSuccess: { rejectedDataPoints: number } }).partialSuccess.rejectedDataPoints, 1);
  const prometheus = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(prometheus, /rdk_ai_otlp_spans_accepted_total\s+[1-9]/);
  assert.match(prometheus, /rdk_upstream_gen_ai_client_token_usage\{firmware="fw-2\.1\.0",model="test-model",robot="robot-01",service="metrics-agent"\}\s+20/);

  const capabilities = await (await fetch(`${baseUrl}/api/v1/ecosystem/capabilities`)).json() as {
    data: {
      protocols: string[];
      edgeMetricsEndpoint?: string;
      evaluationEndpoints?: { record: string; list: string };
      apiVersion?: string;
      contract?: { error?: string; errorShape?: { retryable?: boolean; requestId?: string } };
      persistence?: { mode?: string; authoritative?: string; degraded?: boolean; limits?: { maxRuns?: number } };
      panelRegistry?: {
        schema?: string;
        version?: string;
        specVersion?: string;
        renderers?: Array<{ id: string; kind: string; version: string }>;
        dataSources?: Array<{ id: string; version: string; signals: string[] }>;
      };
    };
  };
  assert.deepEqual(capabilities.data.protocols, ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc', 'prometheus exposition']);
  assert.equal(capabilities.data.edgeMetricsEndpoint, '/edge-metrics');
  assert.deepEqual(capabilities.data.evaluationEndpoints, {
    record: '/api/v1/observability/runs/:runId/evaluations',
    list: '/api/v1/observability/runs/:runId/evaluations',
  });
  assert.equal(capabilities.data.apiVersion, '1.0.0');
  assert.equal(capabilities.data.contract?.error, 'rdk.observability.problem.v1');
  assert.equal(capabilities.data.contract?.errorShape?.retryable, false);
  assert.equal(capabilities.data.contract?.errorShape?.requestId, 'optional_correlation_id');
  assert.equal(capabilities.data.persistence?.mode, 'process-memory-cache');
  assert.equal(capabilities.data.persistence?.authoritative, 'process-cache');
  assert.equal(capabilities.data.persistence?.degraded, true);
  assert.equal(capabilities.data.persistence?.limits?.maxRuns, 2_000);
  assert.equal(capabilities.data.panelRegistry?.schema, 'rdk.observability.panel-registry.v1');
  assert.equal(capabilities.data.panelRegistry?.specVersion, '1.0.0');
  assert.ok(capabilities.data.panelRegistry?.renderers?.some((item) => item.kind === 'topology'));
  assert.ok(capabilities.data.panelRegistry?.dataSources?.some((item) => item.id === 'traces'));

  const openapi = await (await fetch(`${baseUrl}/api/v1/ecosystem/openapi.json`)).json() as {
    openapi: string;
    info: { version: string };
    paths: Record<string, unknown>;
  };
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(openapi.info.version, '1.0.0');
  assert.ok(openapi.paths['/v1/traces']);
  assert.ok(openapi.paths['/api/v1/observability/catalog']);
  assert.ok(openapi.paths['/api/v1/observability/runs/{runId}/scores']);
  assert.ok(openapi.paths['/api/v1/observability/runs/{runId}/spans:batch']);
});

test('accepts OTLP/HTTP protobuf and standard OTLP/gRPC traces and metrics', async () => {
  const runId = `protobuf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const protobufTrace = encodeTraceProtobuf({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'protobuf-agent' } }] },
      scopeSpans: [{ spans: [{
        traceId: Buffer.from('33333333333333333333333333333333', 'hex'),
        spanId: Buffer.from('4444444444444444', 'hex'),
        name: 'protobuf generation',
        startTimeUnixNano: String(Date.now() * 1_000_000),
        endTimeUnixNano: String((Date.now() + 2) * 1_000_000),
        status: { code: 1 },
        attributes: [{ key: 'moss.run.id', value: { stringValue: runId } }],
      }] }],
    }],
  });
  const httpResponse = await fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ecosystem-test-token', 'Content-Type': 'application/x-protobuf' },
    body: protobufTrace,
  });
  assert.equal(httpResponse.status, 200);
  assert.equal((await httpResponse.json() as { partialSuccess: { rejectedSpans: number } }).partialSuccess.rejectedSpans, 0);
  const httpMetricResponse = await fetch(`${baseUrl}/v1/metrics`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ecosystem-test-token', 'Content-Type': 'application/x-protobuf' },
    body: encodeMetricsProtobuf({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: 'gen_ai.http.protobuf.metric',
        sum: { dataPoints: [{ asInt: '9', timeUnixNano: String(Date.now() * 1_000_000) }] },
      }] }] }],
    }),
  });
  assert.equal(httpMetricResponse.status, 200);
  assert.equal((await httpMetricResponse.json() as { partialSuccess: { rejectedDataPoints: number } }).partialSuccess.rejectedDataPoints, 1);

  const grpcRuntime = await startAiEcosystemGrpcServer({ host: '127.0.0.1', port: 0 });
  const metadata = new Metadata();
  metadata.set('authorization', 'Bearer ecosystem-test-token');
  const traceClient = new traceServiceClient(grpcRuntime.address, credentials.createInsecure());
  const metricClient = new metricsServiceClient(grpcRuntime.address, credentials.createInsecure());
  const grpcCall = <T>(client: Client, request: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
    (client as unknown as { Export: (body: Record<string, unknown>, metadata: Metadata, callback: (error: Error | null, response: T) => void) => void })
      .Export(request, metadata, (error, response) => error ? reject(error) : resolve(response));
  });
  const grpcTrace = await grpcCall<{ partialSuccess?: { rejectedSpans?: string } }>(traceClient, {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'grpc-agent' } }] },
      scopeSpans: [{ spans: [{
        traceId: Buffer.from('55555555555555555555555555555555', 'hex'),
        spanId: Buffer.from('6666666666666666', 'hex'),
        name: 'grpc generation',
        startTimeUnixNano: String(Date.now() * 1_000_000),
        endTimeUnixNano: String((Date.now() + 2) * 1_000_000),
        attributes: [{ key: 'moss.run.id', value: { stringValue: `${runId}-grpc` } }],
      }] }],
    }],
  });
  assert.equal(grpcTrace.partialSuccess?.rejectedSpans, '0');
  const grpcMetric = await grpcCall<{ partialSuccess?: { rejectedDataPoints?: string } }>(metricClient, {
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{
      name: 'gen_ai.grpc.metric',
      gauge: { dataPoints: [{ asDouble: 7.5, timeUnixNano: String(Date.now() * 1_000_000) }] },
    }] }] }],
  });
  assert.equal(grpcMetric.partialSuccess?.rejectedDataPoints, '1');
  traceClient.close();
  metricClient.close();
  grpcRuntime.server.forceShutdown();

  const run = await createPublicObservabilityClient({ baseUrl, authorization: 'ecosystem-test-token' }).getRun(`${runId}-grpc`);
  assert.equal(run.service, 'grpc-agent');
  const prometheus = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(prometheus, /rdk_upstream_gen_ai_grpc_metric\s+7\.5/);
});

test('rejects OTLP writes without an API key', async () => {
  const response = await fetch(`${baseUrl}/v1/traces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [] }),
  });
  assert.equal(response.status, 401);
});

test('accepts OTLP logs (and aliases), rejects bodyless records, and reports logs capability', async () => {
  const logPayload = {
    resourceLogs: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'logs-agent' } },
        { key: 'deployment.environment.name', value: { stringValue: 'test' } },
      ] },
      scopeLogs: [{ logRecords: [
        {
          timeUnixNano: String(Date.now() * 1_000_000),
          severityNumber: 17,
          severityText: 'ERROR',
          body: { stringValue: 'upstream request failed' },
          attributes: [
            { key: 'http.status_code', value: { intValue: '502' } },
            // 低敏感白名单之外的字段必须被丢弃，即使内容像机密。
            { key: 'user.password', value: { stringValue: 'hunter2' } },
          ],
          traceId: '11111111111111111111111111111111',
          spanId: '2222222222222222',
        },
        // 无 body 的记录按 OTLP 语义计入 rejected。
        { severityText: 'INFO' },
      ] }],
    }],
  };
  const authed = { Authorization: 'Bearer ecosystem-test-token', 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}/v1/logs`, { method: 'POST', headers: authed, body: JSON.stringify(logPayload) });
  assert.equal(response.status, 200);
  const parsed = await response.json() as { partialSuccess: { rejectedLogRecords: number } };
  assert.ok(parsed.partialSuccess.rejectedLogRecords >= 1);

  const alias = await fetch(`${baseUrl}/api/public/otel/v1/logs`, {
    method: 'POST',
    headers: { 'x-api-key': 'ecosystem-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceLogs: [] }),
  });
  assert.equal(alias.status, 400);

  const unauthenticated = await fetch(`${baseUrl}/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(logPayload),
  });
  assert.equal(unauthenticated.status, 401);

  const prometheus = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(prometheus, /rdk_ai_otlp_log_records_received_total\s+[1-9]/);
  assert.match(prometheus, /rdk_ai_otlp_log_ingest_duration_ms_bucket\{le="[0-9.]+"\}\s+[0-9]/);

  const capabilities = await (await fetch(`${baseUrl}/api/v1/ecosystem/capabilities`)).json() as {
    data: { signals: string[]; logsEndpoint?: string };
  };
  assert.ok(capabilities.data.signals.includes('logs'));
  assert.equal(capabilities.data.logsEndpoint, '/v1/logs');
});

test('retained trace fragments batch by run while preserving trace/parent IDs and scope boundaries', async()=>{
  const { ingestTracePayload }=await import('./ai-ecosystem-routes.js');
  const { getPublicObservabilityStore }=await import('../public-api/public-observability-store.js');
  const store=getPublicObservabilityStore(), append=store.appendSpans.bind(store);
  let writes=0;
  store.appendSpans=async input=>{writes+=1;return append(input);};
  const identity={owner:`batch-owner-${Date.now()}`,keyId:'batch-key'};
  const runId=`fragment-batch-${Date.now()}`;
  const epoch=BigInt(Date.now())*1000000n;
  const span=(trace:string,id:string,status=1)=>({traceId:trace,spanId:id,parentSpanId:'a'.repeat(16),name:'fragment',startTimeUnixNano:String(epoch),endTimeUnixNano:String(epoch+1000000n),status:{code:status},attributes:[{key:'moss.run.id',value:{stringValue:runId}}]});
  try {
    const result=await ingestTracePayload({resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'first-fragment-metadata'}}]},scopeSpans:[{spans:[span('1'.repeat(32),'1'.repeat(16)),span('2'.repeat(32),'2'.repeat(16))]}]}]},identity);
    assert.deepEqual(result,{valid:true,accepted:2,rejected:0,runs:1});
    assert.equal(writes,1);
    const trace=await store.getTrace(identity.owner,runId);
    assert.deepEqual(trace?.map(item=>item.traceId).sort(),['1'.repeat(32),'2'.repeat(32)]);
    assert.ok(trace?.every(item=>item.parentSpanId==='a'.repeat(16)));
    assert.equal((await store.getRun(identity.owner,runId))?.service,'first-fragment-metadata');
    writes=0;
    await ingestTracePayload({resourceSpans:['scope-one','scope-two'].map((scope,index)=>({resource:{attributes:[{key:'rdk.telemetry.scope.ref',value:{stringValue:scope}}]},scopeSpans:[{spans:[span(String(index+3).repeat(32),String(index+3).repeat(16))]}]}))},identity);
    assert.equal(writes,2);
    // More than 64 fragments use bounded batches while preserving the 256/run budget.
    writes=0;
    const largeRun=`${runId}-large`;
    const spans=Array.from({length:65},(_,index)=>({...span((index+100).toString(16).padStart(32,'0'),(index+100).toString(16).padStart(16,'0')),attributes:[{key:'moss.run.id',value:{stringValue:largeRun}}]}));
    const large=await ingestTracePayload({resourceSpans:[{scopeSpans:[{spans}]}]},identity);
    assert.equal(large.accepted,65);assert.equal(large.rejected,0);assert.equal(writes,2);
  } finally {store.appendSpans=append;}
});

test('trace sampling precedes batching and deterministic quota fallback preserves per-trace acceptance', async()=>{
  const { ingestTracePayload }=await import('./ai-ecosystem-routes.js');
  const { getPublicObservabilityStore }=await import('../public-api/public-observability-store.js');
  const identity={owner:`quota-batch-owner-${Date.now()}`,keyId:'quota-batch-key'};
  const runId=`quota-fragments-${Date.now()}`,epoch=BigInt(Date.now())*1000000n;
  const make=(trace:string,id:string,error=false)=>({traceId:trace,spanId:id,name:'sample fragment',startTimeUnixNano:String(epoch),endTimeUnixNano:String(epoch+1000000n),status:{code:error?2:1},attributes:[{key:'moss.run.id',value:{stringValue:runId}}]});
  const previousRatio=process.env.RDK_OTLP_TAIL_SAMPLE_RATIO;process.env.RDK_OTLP_TAIL_SAMPLE_RATIO='0';
  try {
    const sampled=await ingestTracePayload({resourceSpans:[{scopeSpans:[{spans:[make('5'.repeat(32),'5'.repeat(16)),make('6'.repeat(32),'6'.repeat(16),true)]}]}]},identity);
    assert.equal(sampled.accepted,1);assert.equal(sampled.rejected,0);
    assert.deepEqual((await getPublicObservabilityStore().getTrace(identity.owner,runId))?.map(item=>item.traceId),['6'.repeat(32)]);
  } finally {if(previousRatio===undefined) delete process.env.RDK_OTLP_TAIL_SAMPLE_RATIO;else process.env.RDK_OTLP_TAIL_SAMPLE_RATIO=previousRatio;}
  const store=getPublicObservabilityStore();
  const nearRun=`${runId}-near`;
  for(let batch=0;batch<4;batch++) await store.appendSpans({owner:identity.owner,keyId:identity.keyId,runId:nearRun,spans:Array.from({length:batch===3?63:64},(_,index)=>({spanId:(batch*64+index+2000).toString(16).padStart(16,'0'),startTime:Date.now(),endTime:Date.now()+1}))});
  const remaining=[make('7'.repeat(32),'7'.repeat(16)),make('8'.repeat(32),'8'.repeat(16))].map(span=>({...span,attributes:[{key:'moss.run.id',value:{stringValue:nearRun}}]}));
  const quota=await ingestTracePayload({resourceSpans:[{scopeSpans:[{spans:remaining}]}]},identity);
  assert.equal(quota.accepted,1);assert.equal(quota.rejected,1);
  assert.equal((await store.getRun(identity.owner,nearRun))?.spanCount,256);
});
