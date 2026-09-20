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
  recordOtlpLogIngest,
  recordOtlpMetricIngest,
  recordOtlpRequestError,
  recordOtlpTraceIngest,
  recordUpstreamMetric,
  normalizeMetricLabels,
  renderPrometheusMetrics,
  observeHistogram,
  recordMetricQueueGauges,
} from './ai-ecosystem-metrics.js';
import { insertLogRecords, type NormalizedLogRecord } from './ai-ecosystem-logs-store.js';
import { enqueueMetricPoints, metricQueueDepth, metricQueueDroppedTotal } from './ai-ecosystem-metrics-store.js';
import { decodeLogsProtobuf, decodeMetricsProtobuf, decodeTraceProtobuf } from './ai-ecosystem-protobuf.js';
import { renderDevicePrometheusMetrics } from '../monitoring/device-prometheus.js';

export type Principal = { owner: string; keyId: string };
type JsonObject = Record<string, unknown>;

const store = getPublicObservabilityStore();
const MAX_OTLP_SPANS = 512;
const MAX_OTLP_METRIC_POINTS = 512;
const MAX_OTLP_LOGS = 512;
const MAX_LOG_BODY = 1_000;

/** logs 的低敏感属性白名单：与 traces 的语义映射同族，永不收 payload/凭据/URL query。 */
const LOG_ATTRIBUTE_ALLOW = new Set([
  'service.name',
  'service.version',
  'deployment.environment.name',
  'gen_ai.system',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'project.id',
  'http.route',
  'robot.id',
  'rdk.robot.id',
  'robot.serial',
  'rdk.robot.serial',
  'device.id',
  'rdk.device.id',
  'host.name',
  'site.id',
  'rdk.site.id',
  'firmware.version',
  'rdk.firmware.version',
  'model.version',
  'rdk.model.version',
  'http.status_code',
  'http.method',
  'error.type',
  'error.kind',
  'otel.scope.name',
  'otel.scope.version',
]);

const SEVERITY_NAMES: Array<{ max: number; name: string }> = [
  { max: 4, name: 'TRACE' },
  { max: 8, name: 'DEBUG' },
  { max: 12, name: 'INFO' },
  { max: 16, name: 'WARN' },
  { max: 20, name: 'ERROR' },
  { max: 24, name: 'FATAL' },
];

function severityFromNumber(value: number): string {
  return SEVERITY_NAMES.find((entry) => value <= entry.max)?.name ?? 'INFO';
}

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

function requestBody(req: Request, signal: 'traces' | 'metrics' | 'logs'): JsonObject {
  if (!isProtobufContentType(req)) return object(req.body);
  if (!Buffer.isBuffer(req.body)) throw new Error('invalid_otlp_protobuf_body');
  if (signal === 'traces') return decodeTraceProtobuf(req.body);
  if (signal === 'metrics') return decodeMetricsProtobuf(req.body);
  return decodeLogsProtobuf(req.body);
}

async function ingestTraces(req: Request, res: Response): Promise<void> {
  const identity = requirePrincipal(req, res);
  if (!identity) return;
  let body: JsonObject;
  const startedAt = Date.now();
  try {
    body = requestBody(req, 'traces');
  } catch {
    recordOtlpRequestError('traces');
    res.status(400).json({ ok: false, error: 'invalid_otlp_protobuf_body', code: 'invalid_otlp_protobuf_body' });
    return;
  }
  const result = await ingestTracePayload(body, identity);
  observeHistogram('rdk_ai_otlp_trace_ingest_duration_ms', Date.now() - startedAt);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'invalid_otlp_trace_payload', code: 'invalid_otlp_trace_payload' });
    return;
  }
  res.status(200).json({ partialSuccess: { rejectedSpans: result.rejected, ...(result.rejected ? { errorMessage: 'Some spans were rejected by the low-sensitivity policy.' } : {}) } });
}

async function ingestLogs(req: Request, res: Response): Promise<void> {
  const identity = requirePrincipal(req, res);
  if (!identity) return;
  let body: JsonObject;
  try {
    body = requestBody(req, 'logs');
  } catch {
    recordOtlpRequestError('logs');
    res.status(400).json({ ok: false, error: 'invalid_otlp_protobuf_body', code: 'invalid_otlp_protobuf_body' });
    return;
  }
  const startedAt = Date.now();
  const result = await ingestLogPayload(body, identity);
  observeHistogram('rdk_ai_otlp_log_ingest_duration_ms', Date.now() - startedAt);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'invalid_otlp_log_payload', code: 'invalid_otlp_log_payload' });
    return;
  }
  res.status(200).json({
    partialSuccess: {
      rejectedLogRecords: result.rejectedRecords,
      ...(result.rejectedRecords ? { errorMessage: 'Some log records were rejected by the low-sensitivity policy or storage limit.' } : {}),
    },
  });
}

function metricPoints(body: JsonObject): Array<{ name: string; value: number; timestampMs: number; labels: Record<string, string> }> {
  const result: Array<{ name: string; value: number; timestampMs: number; labels: Record<string, string> }> = [];
  const groups = Array.isArray(body.resourceMetrics) ? body.resourceMetrics : [];
  for (const group of groups) {
    const resource = resourceAttributes(object(group).resource);
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
          const labels = normalizeMetricLabels({
            ...resource,
            ...attributes(item.attributes),
          });
          result.push({
            name,
            value,
            timestampMs: otlpTime(item.timeUnixNano ?? item.time_unix_nano, Date.now()),
            labels,
          });
          if (result.length >= MAX_OTLP_METRIC_POINTS) return result;
        }
      }
    }
  }
  return result;
}

export async function ingestMetricPayload(body: JsonObject, identity: Principal): Promise<OtlpIngestResult> {
  const points = metricPoints(body);
  if (!points.length) {
    recordOtlpRequestError('metrics');
    return { valid: false, accepted: 0, rejected: 0, runs: 0 };
  }
  for (const point of points) recordUpstreamMetric(point.name, point.value, point.timestampMs, point.labels);
  // 内存 gauge 承担 /metrics 当前值；落库走有界异步队列（5s 批量 flush），
  // 摄取延迟不再包含 DB。入队即视为接受，容量丢弃计入 rejected 并在
  // rdk_observability_metric_queue_dropped_total 暴露。
  const rejected = enqueueMetricPoints(identity.owner, points);
  recordMetricQueueGauges(metricQueueDepth(), metricQueueDroppedTotal());
  recordOtlpMetricIngest(points.length);
  return { valid: true, accepted: points.length - rejected, rejected, runs: 0 };
}

function logBody(value: unknown): string {
  const anyValue = object(value);
  if ('stringValue' in anyValue || 'string_value' in anyValue) {
    return text(anyValue.stringValue ?? anyValue.string_value, MAX_LOG_BODY);
  }
  const scalarValue = scalar(anyValue);
  if (scalarValue === undefined || scalarValue === null) return '';
  if (typeof scalarValue === 'string') return text(scalarValue, MAX_LOG_BODY);
  try {
    return JSON.stringify(scalarValue).slice(0, MAX_LOG_BODY);
  } catch {
    return '';
  }
}

function normalizedLogAttributes(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LOG_ATTRIBUTE_ALLOW.has(key) || Object.keys(result).length >= 24) continue;
    if (typeof value === 'string') {
      const cleaned = text(value, 256);
      if (cleaned) result[key] = cleaned;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.max(-1e9, Math.min(1e9, value));
    } else if (typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

function resourceLogs(body: JsonObject): Array<{ resource: Record<string, unknown>; record: unknown }> {
  const result: Array<{ resource: Record<string, unknown>; record: unknown }> = [];
  const groups = Array.isArray(body.resourceLogs ?? body.resource_logs) ? body.resourceLogs ?? body.resource_logs : [];
  for (const group of groups as unknown[]) {
    const row = object(group);
    const resource = resourceAttributes(row.resource);
    const scopes = Array.isArray(row.scopeLogs) ? row.scopeLogs : Array.isArray(row.scope_logs) ? row.scope_logs : [];
    for (const scope of scopes as unknown[]) {
      const scopeRow = object(scope);
      const records = Array.isArray(scopeRow.logRecords) ? scopeRow.logRecords : Array.isArray(scopeRow.log_records) ? scopeRow.log_records : [];
      for (const record of records) {
        result.push({ resource, record });
        if (result.length >= MAX_OTLP_LOGS) return result;
      }
    }
  }
  return result;
}

function normalizeOtlpLog(raw: unknown, resource: Record<string, unknown>): NormalizedLogRecord | null {
  const item = object(raw);
  const rawAttributes = attributes(item.attributes);
  const merged = { ...resource, ...rawAttributes };
  const filtered = normalizedLogAttributes(merged);
  const severityNumberRaw = Number(item.severityNumber ?? item.severity_number);
  const severityNumber = Number.isFinite(severityNumberRaw)
    ? Math.max(1, Math.min(24, Math.trunc(severityNumberRaw)))
    : 9;
  const severityText = text(item.severityText ?? item.severity_text, 32) || severityFromNumber(severityNumber);
  const body = logBody(item.body);
  if (!body) return null;
  const observedRaw = item.timeUnixNano ?? item.time_unix_nano ?? item.observedTimeUnixNano ?? item.observed_time_unix_nano;
  const timestampMs = otlpTime(observedRaw, Date.now());
  const traceRaw = text(item.traceId ?? item.trace_id, 64).toLowerCase();
  const spanRaw = text(item.spanId ?? item.span_id, 32).toLowerCase();
  return {
    service: text(resource['service.name'], 160) || 'unknown',
    environment: text(resource['deployment.environment.name'], 120) || 'unknown',
    severityText: severityText.toUpperCase(),
    severityNumber,
    body,
    attributes: filtered,
    traceId: /^[0-9a-f]{32}$/.test(traceRaw) && !/^0+$/.test(traceRaw) ? traceRaw : null,
    spanId: /^[0-9a-f]{16}$/.test(spanRaw) && !/^0+$/.test(spanRaw) ? spanRaw : null,
    timestampMs,
  };
}

export async function ingestLogPayload(body: JsonObject, identity: Principal): Promise<OtlpIngestResult & { rejectedRecords: number }> {
  const rows = resourceLogs(body);
  if (!rows.length) {
    recordOtlpRequestError('logs');
    return { valid: false, accepted: 0, rejected: 0, rejectedRecords: 0, runs: 0 };
  }
  const normalized = rows
    .map((row) => normalizeOtlpLog(row.record, row.resource))
    .filter((item): item is NormalizedLogRecord => Boolean(item));
  const rejected = rows.length - normalized.length;
  let inserted = 0;
  try {
    inserted = await insertLogRecords(identity.owner, normalized);
  } catch {
    recordOtlpLogIngest({ received: rows.length, accepted: 0, rejected: rows.length });
    return { valid: true, accepted: 0, rejected: rows.length, rejectedRecords: rows.length, runs: 0 };
  }
  recordOtlpLogIngest({ received: rows.length, accepted: inserted, rejected });
  return { valid: true, accepted: inserted, rejected, rejectedRecords: rejected + (normalized.length - inserted), runs: 0 };
}

async function ingestMetrics(req: Request, res: Response): Promise<void> {
  const identity = requirePrincipal(req, res);
  if (!identity) return;
  let body: JsonObject;
  const startedAt = Date.now();
  try {
    body = requestBody(req, 'metrics');
  } catch {
    recordOtlpRequestError('metrics');
    res.status(400).json({ ok: false, error: 'invalid_otlp_protobuf_body', code: 'invalid_otlp_protobuf_body' });
    return;
  }
  const result = await ingestMetricPayload(body, identity);
  observeHistogram('rdk_ai_otlp_metric_ingest_duration_ms', Date.now() - startedAt);
  if (!result.valid) {
    res.status(400).json({ ok: false, error: 'invalid_otlp_metric_payload', code: 'invalid_otlp_metric_payload' });
    return;
  }
  res.status(200).json({
    partialSuccess: {
      rejectedDataPoints: result.rejected,
      ...(result.rejected ? { errorMessage: 'Some metric points could not be persisted.' } : {}),
    },
  });
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
  const logPaths = ['/v1/logs', '/api/public/otel/v1/logs', '/api/v1/otel/v1/logs'];
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
  router.post(logPaths, (req, res) => {
    void ingestLogs(req, res).catch(() => {
      recordOtlpRequestError('logs');
      if (!res.headersSent) res.status(503).json({ ok: false, error: 'otlp_log_ingest_unavailable', code: 'otlp_log_ingest_unavailable', retryable: true });
    });
  });
  router.get('/metrics', (req, res) => {
    if (!metricsTokenMatches(req)) {
      res.status(401).type('text/plain').send('invalid metrics token\n');
      return;
    }
    res.type('text/plain; version=0.0.4').send(renderPrometheusMetrics());
  });
  router.get('/edge-metrics', async (req, res) => {
    if (!metricsTokenMatches(req)) {
      res.status(401).type('text/plain').send('invalid metrics token\n');
      return;
    }
    try {
      res.type('text/plain; version=0.0.4').send(await renderDevicePrometheusMetrics());
    } catch {
      res.status(503).type('text/plain').send('edge metrics unavailable\n');
    }
  });
  router.get('/api/v1/ecosystem/capabilities', (_req, res) => {
    res.json({
      ok: true,
      data: {
        schema: 'rdk.ai.observability.capabilities.v2',
        signals: ['traces', 'metrics', 'logs'],
        protocols: ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc', 'prometheus exposition'],
        traceEndpoints: tracePaths,
        metricsEndpoint: metricPaths[0],
        metricEndpoints: metricPaths,
        logsEndpoint: logPaths[0],
        logEndpoints: logPaths,
        grpc: {
          serviceNames: [
            'opentelemetry.proto.collector.trace.v1.TraceService',
            'opentelemetry.proto.collector.metrics.v1.MetricsService',
            'opentelemetry.proto.collector.logs.v1.LogsService',
          ],
          portEnv: 'RDK_OTLP_GRPC_PORT',
        },
        prometheusEndpoint: '/metrics',
        edgeMetricsEndpoint: '/edge-metrics',
        semanticConventions: ['gen_ai.*', 'moss.*', 'rdk.*', 'openinference.*'],
        payloadPolicy: 'low-sensitivity; prompts, completions, tool arguments/results and credentials are not retained',
      },
    });
  });
  return router;
}
