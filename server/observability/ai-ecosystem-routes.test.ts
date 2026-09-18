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
  const prometheus = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(prometheus, /rdk_ai_otlp_spans_accepted_total\s+[1-9]/);
  assert.match(prometheus, /rdk_upstream_gen_ai_client_token_usage\{model="test-model",service="metrics-agent"\}\s+20/);

  const capabilities = await (await fetch(`${baseUrl}/api/v1/ecosystem/capabilities`)).json() as { data: { protocols: string[] } };
  assert.deepEqual(capabilities.data.protocols, ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc', 'prometheus exposition']);
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
  await grpcCall(metricClient, {
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{
      name: 'gen_ai.grpc.metric',
      gauge: { dataPoints: [{ asDouble: 7.5, timeUnixNano: String(Date.now() * 1_000_000) }] },
    }] }] }],
  });
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
