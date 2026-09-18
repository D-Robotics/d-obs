import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import {
  inferAiSpanKind,
  mapAiSpanKindHint,
  normalizeAiSemanticAttributes,
  resolveAiRunId,
  type AiObservabilityScalar,
} from '../../shared/ai-observability-semantics.js';
import { getPublicObservabilityStore } from '../public-api/public-observability-store.js';
import {
  recordOtlpMetricIngest,
  recordOtlpRequestError,
  recordOtlpTraceIngest,
  recordUpstreamMetric,
  renderPrometheusMetrics,
} from './ai-ecosystem-metrics.js';
import { decodeMetricsProtobuf, decodeTraceProtobuf } from './ai-ecosystem-protobuf.js';

export type Principal = { owner: string; keyId: string };
type JsonObject = Record<string, unknown>;

const store = getPublicObservabilityStore();
const MAX_OTLP_SPANS = 512;
const MAX_OTLP_METRIC_POINTS = 512;

function text(value: unknown, max = 256): string {
  if (typeof value === 'string') return value.replace(/\0/g, '').trim().slice(0, max);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex').slice(0, max);
  return '';
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function scalar(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const item = value as JsonObject;
  return item.stringValue ?? item.boolValue ?? item.intValue ?? item.doubleValue
    ?? item.string_value ?? item.bool_value ?? item.int_value ?? item.double_value;
}

function attributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const item of value.slice(0, 64)) {
      const row = object(item);
      const key = text(row.key, 120);
      if (key) result[key] = scalar(row.value);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(object(value)).slice(0, 64)) result[key] = scalar(raw);
  return result;
}

function resourceAttributes(value: unknown): Record<string, unknown> {
  return attributes(object(value).attributes);
}

function otlpTime(value: unknown, fallback: number): number {
  const numeric = Number(typeof value === 'string' ? value : scalar(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  // OTLP JSON encodes Unix nanoseconds as a string. Accept milliseconds as a
  // convenience for lightweight exporters and tests.
  return Math.trunc(numeric > 1_000_000_000_000 ? numeric / 1_000_000 : numeric);
}

function stableId(value: unknown, bytes: number, fallback: string): string {
  const raw = text(value, 256) || fallback;
  return createHash('sha256').update(raw).digest('hex').slice(0, bytes * 2);
}

function traceId(value: unknown): string {
  const normalized = text(value, 64).toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) && !/^0+$/.test(normalized)
    ? normalized
    : stableId(normalized, 16, 'otel-trace');
}

function spanId(value: unknown, fallback: string): string {
  const normalized = text(value, 32).toLowerCase();
  return /^[0-9a-f]{16}$/.test(normalized) && !/^0+$/.test(normalized)
    ? normalized
    : stableId(normalized, 8, fallback);
}

function tokenFromRequest(req: Request): { token: string; presented: string } | null {
  return credentialFromHeaders(req.header('authorization'), req.header('x-api-key') ?? req.header('api-key') ?? req.header('x-rdk-observability-token'));
}

function credentialFromHeaders(authorizationHeader: unknown, apiKeyHeader: unknown): { token: string; presented: string } | null {
  const authorization = text(authorizationHeader, 4_096);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const basic = /^Basic\s+(.+)$/i.exec(authorization)?.[1];
  const headerToken = text(apiKeyHeader, 4_000);
  if (bearer) return { token: text(bearer, 4_000), presented: `Bearer ${text(bearer, 4_000)}` };
  if (basic) return { token: `basic:${text(basic, 4_000)}`, presented: `Basic ${text(basic, 4_000)}` };
  if (headerToken) return { token: headerToken, presented: headerToken };
  return null;
}

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function principalForCredential(credential: { token: string; presented: string } | null): Principal | null {
  if (!credential) return null;
  const configured = text(process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN, 4_000);
  if (configured && !sameSecret(credential.token, configured) && !sameSecret(credential.presented, configured)) return null;
  const digest = createHash('sha256').update(credential.token).digest('hex');
  return { owner: `public_${digest}`, keyId: digest.slice(0, 32) };
}

export function principalFromGrpcMetadata(authorization: unknown, apiKey: unknown): Principal | null {
  return principalForCredential(credentialFromHeaders(authorization, apiKey));
}

function principal(req: Request): Principal | null {
  return principalForCredential(tokenFromRequest(req));
}

function requirePrincipal(req: Request, res: Response): Principal | null {
  const value = principal(req);
  if (!value) {
    res.status(401).json({ ok: false, error: 'invalid_observability_token', code: 'invalid_observability_token' });
    return null;
  }
  return value;
}

function metricValue(value: unknown): number | undefined {
  const parsed = Number(scalar(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

type NormalizedSpan = {
  runId: string;
  traceId: string;
  span: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    source: 'server';
    kind: 'agent' | 'generation' | 'tool' | 'retrieval' | 'http' | 'approval' | 'custom';
    name: string;
    startTime: number;
    endTime: number;
    status: 'ok' | 'error';
    statusMessage?: string;
    attributes: Record<string, AiObservabilityScalar>;
  };
  run: {
    projectId: string;
    environment: string;
    service: string;
    release?: string;
    sessionRef?: string;
    objectType?: string;
    objectId?: string;
    objectName?: string;
    objectVersion?: string;
    metadata: Record<string, AiObservabilityScalar>;
  };
};

function normalizeOtlpSpan(raw: unknown, resource: Record<string, unknown>, index: number): NormalizedSpan | null {
  const item = object(raw);
  const rawSpanAttributes = attributes(item.attributes);
  const mergedRaw = { ...resource, ...rawSpanAttributes };
  const semantic = normalizeAiSemanticAttributes(rawSpanAttributes, resource);
  const currentTraceId = traceId(item.traceId);
  const currentSpanId = spanId(item.spanId, `${currentTraceId}:${index}`);
  const startTime = otlpTime(item.startTimeUnixNano ?? item.start_time_unix_nano ?? item.startTime, Date.now());
  const endTime = Math.max(startTime, otlpTime(item.endTimeUnixNano ?? item.end_time_unix_nano ?? item.endTime, startTime));
  const name = text(item.name, 120) || 'otel.span';
  const kind = mapAiSpanKindHint(mergedRaw['openinference.span.kind'] ?? mergedRaw['langfuse.observation.type'])
    ?? inferAiSpanKind(name, semantic);
  const status = object(item.status).code === 2 || semantic.is_error === true ? 'error' : 'ok';
  const rawMessage = text(object(item.status).message ?? item.statusMessage, 160);
  const runId = resolveAiRunId(mergedRaw, currentTraceId);
  const canonicalAttributes: Record<string, AiObservabilityScalar> = {
    ...semantic,
    'external.name': name,
    'external.kind': kind,
  };
  return {
    runId,
    traceId: currentTraceId,
    span: {
      traceId: currentTraceId,
      spanId: currentSpanId,
      ...(text(item.parentSpanId ?? item.parent_span_id, 32) ? { parentSpanId: spanId(item.parentSpanId ?? item.parent_span_id, `${currentTraceId}:parent`) } : {}),
      source: 'server',
      kind,
      name,
      startTime,
      endTime,
      status,
      ...(status === 'error' && rawMessage ? { statusMessage: rawMessage } : {}),
      attributes: canonicalAttributes,
    },
    run: {
      projectId: semantic.projectId || text(resource['project.id'], 160) || text(resource['service.name'], 160) || 'otel',
      environment: semantic.environment || 'unknown',
      service: semantic.service || text(resource['service.name'], 160) || 'unknown',
      ...(semantic.release ? { release: semantic.release } : {}),
      ...(semantic.sessionRef ? { sessionRef: semantic.sessionRef } : {}),
      ...(semantic.objectType ? { objectType: semantic.objectType } : {}),
      ...(semantic.objectId ? { objectId: semantic.objectId } : {}),
      ...(semantic.objectName ? { objectName: semantic.objectName } : {}),
      ...(semantic.objectVersion ? { objectVersion: semantic.objectVersion } : {}),
      metadata: canonicalAttributes,
    },
  };
}

function resourceSpans(body: JsonObject): Array<{ resource: Record<string, unknown>; span: unknown }> {
  const result: Array<{ resource: Record<string, unknown>; span: unknown }> = [];
  const groups = Array.isArray(body.resourceSpans) ? body.resourceSpans : [];
  for (const group of groups) {
    const row = object(group);
    const resource = resourceAttributes(row.resource);
    const scopes = Array.isArray(row.scopeSpans)
      ? row.scopeSpans
      : Array.isArray(row.instrumentationLibrarySpans) ? row.instrumentationLibrarySpans : [];
    for (const scope of scopes) {
      for (const span of Array.isArray(object(scope).spans) ? object(scope).spans as unknown[] : []) {
        result.push({ resource, span });
        if (result.length >= MAX_OTLP_SPANS) return result;
      }
    }
  }
  return result;
}

export type OtlpIngestResult = {
  valid: boolean;
  accepted: number;
  rejected: number;
  runs: number;
};

export async function ingestTracePayload(body: JsonObject, identity: Principal): Promise<OtlpIngestResult> {
  const rows = resourceSpans(body);
  if (!rows.length) {
    recordOtlpRequestError('traces');
    return { valid: false, accepted: 0, rejected: 0, runs: 0 };
  }
  const normalized = rows
    .map((row, index) => normalizeOtlpSpan(row.span, row.resource, index))
    .filter((item): item is NormalizedSpan => Boolean(item));
  const groups = new Map<string, NormalizedSpan[]>();
  for (const item of normalized) {
    const key = `${item.runId}\u0000${item.traceId}`;
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }
  let accepted = 0;
  let rejected = rows.length - normalized.length;
  let runs = 0;
  for (const group of groups.values()) {
    const first = group[0];
    try {
      const existing = await store.getRun(identity.owner, first.runId);
      const result = await store.appendSpans({
        runId: first.runId,
        owner: identity.owner,
        keyId: identity.keyId,
        traceId: first.traceId,
        source: 'server',
        spans: group.map((item) => item.span),
        run: first.run,
      });
      accepted += result.spans.length;
      rejected += group.length - result.spans.length;
      if (!existing) runs += 1;
    } catch {
      rejected += group.length;
    }
  }
  recordOtlpTraceIngest({ received: rows.length, accepted, rejected, runs });
  return { valid: true, accepted, rejected, runs };
}

function isProtobufContentType(req: Request): boolean {
  const contentType = text(req.header('content-type'), 200).toLowerCase().split(';', 1)[0];
  return contentType === 'application/x-protobuf'
    || contentType === 'application/protobuf'
    || contentType === 'application/octet-stream';
}

function requestBody(req: Request, signal: 'traces' | 'metrics'): JsonObject {
  if (!isProtobufContentType(req)) return object(req.body);
  if (!Buffer.isBuffer(req.body)) throw new Error('invalid_otlp_protobuf_body');
  return signal === 'traces' ? decodeTraceProtobuf(req.body) : decodeMetricsProtobuf(req.body);
}

async function ingestTraces(req: Request, res: Response): Promise<void> {
  const identity = requirePrincipal(req, res);
  if (!identity) return;
  let body: JsonObject;
  try {
    body = requestBody(req, 'traces');
  } catch {
    recordOtlpRequestError('traces');
    res.status(400).json({ ok: false, error: 'invalid_otlp_protobuf_body', code: 'invalid_otlp_protobuf_body' });
    return;
  }
  const result = await ingestTracePayload(body, identity);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'invalid_otlp_trace_payload', code: 'invalid_otlp_trace_payload' });
    return;
  }
  res.status(200).json({ partialSuccess: { rejectedSpans: result.rejected, ...(result.rejected ? { errorMessage: 'Some spans were rejected by the low-sensitivity policy.' } : {}) } });
}

function metricPoints(body: JsonObject): Array<{ name: string; value: number; timestampMs: number }> {
  const result: Array<{ name: string; value: number; timestampMs: number }> = [];
  const groups = Array.isArray(body.resourceMetrics) ? body.resourceMetrics : [];
  for (const group of groups) {
    const scopes: unknown[] = Array.isArray(object(group).scopeMetrics)
      ? object(group).scopeMetrics as unknown[]
      : Array.isArray(object(group).instrumentationLibraryMetrics) ? object(group).instrumentationLibraryMetrics as unknown[] : [];
    for (const scope of scopes) {
      for (const metric of Array.isArray(object(scope).metrics) ? object(scope).metrics as unknown[] : []) {
        const row = object(metric);
        const name = text(row.name, 96);
        if (!name) continue;
        const data = object(row.gauge ?? row.sum ?? row.histogram ?? row.exponentialHistogram);
        const points = Array.isArray(data.dataPoints) ? data.dataPoints : [];
        for (const point of points) {
          const item = object(point);
          const value = metricValue(item.asDouble ?? item.asInt ?? item.value ?? item.sum);
          if (value === undefined) continue;
          result.push({
            name,
            value,
            timestampMs: otlpTime(item.timeUnixNano ?? item.time_unix_nano, Date.now()),
          });
          if (result.length >= MAX_OTLP_METRIC_POINTS) return result;
        }
      }
    }
  }
  return result;
}

export async function ingestMetricPayload(body: JsonObject, _identity: Principal): Promise<OtlpIngestResult> {
  const points = metricPoints(body);
  if (!points.length) {
    recordOtlpRequestError('metrics');
    return { valid: false, accepted: 0, rejected: 0, runs: 0 };
  }
  for (const point of points) recordUpstreamMetric(point.name, point.value, point.timestampMs);
  recordOtlpMetricIngest(points.length);
  return { valid: true, accepted: points.length, rejected: 0, runs: 0 };
}

async function ingestMetrics(req: Request, res: Response): Promise<void> {
  const identity = requirePrincipal(req, res);
  if (!identity) return;
  let body: JsonObject;
  try {
    body = requestBody(req, 'metrics');
  } catch {
    recordOtlpRequestError('metrics');
    res.status(400).json({ ok: false, error: 'invalid_otlp_protobuf_body', code: 'invalid_otlp_protobuf_body' });
    return;
  }
  const result = await ingestMetricPayload(body, identity);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'invalid_otlp_metric_payload', code: 'invalid_otlp_metric_payload' });
    return;
  }
  res.status(200).json({ partialSuccess: {} });
}

function metricsTokenMatches(req: Request): boolean {
  const expected = text(process.env.RDK_OBSERVABILITY_METRICS_TOKEN, 4_000);
  if (!expected) return true;
  const actual = text(req.header('authorization')?.replace(/^Bearer\s+/i, ''), 4_000) || text(req.header('x-api-key'), 4_000);
  return Boolean(actual) && sameSecret(actual, expected);
}

export function createAiEcosystemRouter(): Router {
  const router = Router();
  // OTLP/HTTP protobuf payloads bypass express.json and stay as bytes until
  // the signal-specific decoder below. JSON exporters continue through the
  // app-level express.json middleware.
  router.use(express.raw({
    type: ['application/x-protobuf', 'application/protobuf', 'application/octet-stream'],
    limit: '2mb',
  }));
  const tracePaths = ['/v1/traces', '/api/public/otel/v1/traces', '/api/v1/otel/v1/traces'];
  const metricPaths = ['/v1/metrics', '/api/public/otel/v1/metrics', '/api/v1/otel/v1/metrics'];
  router.post(tracePaths, (req, res) => {
    void ingestTraces(req, res).catch(() => {
      recordOtlpRequestError('traces');
      if (!res.headersSent) res.status(503).json({ ok: false, error: 'otlp_trace_ingest_unavailable', code: 'otlp_trace_ingest_unavailable', retryable: true });
    });
  });
  router.post(metricPaths, (req, res) => {
    void ingestMetrics(req, res).catch(() => {
      recordOtlpRequestError('metrics');
      if (!res.headersSent) res.status(503).json({ ok: false, error: 'otlp_metric_ingest_unavailable', code: 'otlp_metric_ingest_unavailable', retryable: true });
    });
  });
  router.get('/metrics', (req, res) => {
    if (!metricsTokenMatches(req)) {
      res.status(401).type('text/plain').send('invalid metrics token\n');
      return;
    }
    res.type('text/plain; version=0.0.4').send(renderPrometheusMetrics());
  });
  router.get('/api/v1/ecosystem/capabilities', (_req, res) => {
    res.json({
      ok: true,
      data: {
        schema: 'rdk.ai.observability.capabilities.v1',
        signals: ['traces', 'metrics'],
        protocols: ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc', 'prometheus exposition'],
        traceEndpoints: tracePaths,
        metricsEndpoint: metricPaths[0],
        metricEndpoints: metricPaths,
        grpc: {
          serviceNames: [
            'opentelemetry.proto.collector.trace.v1.TraceService',
            'opentelemetry.proto.collector.metrics.v1.MetricsService',
          ],
          portEnv: 'RDK_OTLP_GRPC_PORT',
        },
        prometheusEndpoint: '/metrics',
        semanticConventions: ['gen_ai.*', 'moss.*', 'rdk.*', 'openinference.*'],
        payloadPolicy: 'low-sensitivity; prompts, completions, tool arguments/results and credentials are not retained',
      },
    });
  });
  return router;
}
