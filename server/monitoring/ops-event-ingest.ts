/**
 * 事件级埋点摄取（多团队版）。
 *
 * 入口 POST /api/ops/events（SSO 公共豁免范围），鉴权与拨测上报共用同一套
 * 256-bit 探针 token：平台 x-rdk-external-probe-token 或租户
 * x-rdk-tenant-probe-token，任一命中即接受（resolveProbeReportIdentity）。
 * 事件逐条经 recordOpsEvent 消毒、指纹去重后写入 studio_ops_events，工作台
 * 总览与告警 worker 按既有 event_code 惯例直接消费。
 *
 * 契约：schema 固定 'rdk.dobs.ops-events.v1'；eventId 作为指纹成分 + 默认 1h
 * 去重窗口，客户端按 eventId 幂等重试。批次上限 64 条 / 256KB；单条身份/枚举
 * 字段非法只跳过该条（计数 dropped），批级问题整批拒绝。
 *
 * 防线：写入失败与任何异常只影响回执，绝不让异常穿透 Express 4 的 async
 * handler（与拨测摄取同一要求）；每身份 120 req/min 固定窗口限速，封顶单租户
 * 7680 行/分钟的写入放大。
 */
import { Router, type Request, type Response } from 'express';

import {
  resolveProbeReportIdentity,
  type ProbeReportIdentity,
} from './external-probe-ingest.js';
import {
  isOpsEventStoreConfigured,
  recordOpsEvent,
  type OpsEventCorrelation,
  type OpsEventInput,
  type OpsEventOutcome,
  type OpsEventSeverityHint,
} from './ops-event-store.js';

export const OPS_EVENTS_INGEST_SCHEMA = 'rdk.dobs.ops-events.v1' as const;

const MAX_EVENTS = 64;
const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_DEDUPE_MS = 60 * 60_000;

const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/;
const PRODUCER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const OUTCOMES = new Set<string>(['ok', 'error', 'rejected', 'degraded']);
const SEVERITIES = new Set<string>(['info', 'warning', 'critical']);
const CORRELATION_STRING_KEYS = [
  'userId',
  'sessionId',
  'runId',
  'deviceId',
  'deviceModel',
  'clientType',
  'channel',
  'appVersion',
] as const;

export interface IngestedOpsEvent {
  eventId: string;
  component: string;
  eventCode: string;
  outcome: OpsEventOutcome;
  severityHint?: OpsEventSeverityHint;
  safeSummary?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  correlation?: OpsEventCorrelation;
  occurredAt?: string;
  dedupeWithinMs?: number;
}

export type OpsEventIngestRejection =
  | 'invalid_schema'
  | 'invalid_producer'
  | 'empty_batch'
  | 'item_limit'
  | 'request_bytes_limit';

export type OpsEventIngestBatchResult =
  | { ok: true; producedBy: string; events: IngestedOpsEvent[]; dropped: number }
  | { ok: false; reason: OpsEventIngestRejection };

/** 身份/枚举字段非法整条丢弃；可选载荷字段非法按缺失处理（下游还会消毒）。 */
function normalizeEvent(value: unknown): IngestedOpsEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const eventId = String(raw.eventId ?? '').trim();
  const component = String(raw.component ?? '').trim();
  const eventCode = String(raw.eventCode ?? '').trim();
  const outcome = String(raw.outcome ?? '').trim();
  if (!EVENT_ID_RE.test(eventId) || !SLUG_RE.test(component) || !SLUG_RE.test(eventCode)) {
    return null;
  }
  if (!OUTCOMES.has(outcome)) return null;
  const severityRaw = raw.severityHint === undefined ? '' : String(raw.severityHint ?? '').trim();
  if (severityRaw && !SEVERITIES.has(severityRaw)) return null;
  const occurredAt = typeof raw.occurredAt === 'string' ? raw.occurredAt.trim() : '';
  if (occurredAt && !Number.isFinite(Date.parse(occurredAt))) return null;

  const safeSummary =
    typeof raw.safeSummary === 'string' && raw.safeSummary.trim()
      ? raw.safeSummary.slice(0, 4_000)
      : undefined;
  const metadata = normalizeMetadata(raw.metadata);
  const correlation = normalizeCorrelation(raw.correlation);
  const dedupeWithinMs = clampDedupeMs(raw.dedupeWithinMs);
  return {
    eventId,
    component,
    eventCode,
    outcome: outcome as OpsEventOutcome,
    ...(severityRaw ? { severityHint: severityRaw as OpsEventSeverityHint } : {}),
    ...(safeSummary ? { safeSummary } : {}),
    ...(metadata ? { metadata } : {}),
    ...(correlation ? { correlation } : {}),
    ...(occurredAt ? { occurredAt: occurredAt.slice(0, 40) } : {}),
    ...(dedupeWithinMs !== undefined ? { dedupeWithinMs } : {}),
  };
}

function normalizeMetadata(
  value: unknown,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (rawValue === undefined) continue;
    if (typeof rawValue === 'string') {
      if (rawValue.trim()) out[rawKey] = rawValue.slice(0, 240);
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      out[rawKey] = rawValue;
    } else if (typeof rawValue === 'boolean' || rawValue === null) {
      out[rawKey] = rawValue;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeCorrelation(value: unknown): OpsEventCorrelation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: OpsEventCorrelation = {};
  let any = false;
  for (const key of CORRELATION_STRING_KEYS) {
    const candidate = raw[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      out[key] = candidate.trim().slice(0, 200);
      any = true;
    }
  }
  return any ? out : undefined;
}

function clampDedupeMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(DEFAULT_DEDUPE_MS, Math.trunc(n));
}

export function parseOpsEventIngestBatch(
  value: unknown,
  options: { requestBytes?: number } = {},
): OpsEventIngestBatchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== OPS_EVENTS_INGEST_SCHEMA) return { ok: false, reason: 'invalid_schema' };
  const requestBytes = Number(
    options.requestBytes ?? JSON.stringify(value).length,
  );
  if (Number.isFinite(requestBytes) && requestBytes > MAX_BODY_BYTES) {
    return { ok: false, reason: 'request_bytes_limit' };
  }
  const producedBy = String(raw.producedBy ?? '').trim();
  if (!PRODUCER_RE.test(producedBy)) return { ok: false, reason: 'invalid_producer' };
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    return { ok: false, reason: 'empty_batch' };
  }
  if (raw.events.length > MAX_EVENTS) return { ok: false, reason: 'item_limit' };
  const events: IngestedOpsEvent[] = [];
  for (const candidate of raw.events) {
    const event = normalizeEvent(candidate);
    if (event) events.push(event);
  }
  return { ok: true, producedBy, events, dropped: raw.events.length - events.length };
}

const rateWindows = new Map<string, { windowStart: number; count: number }>();

function allowRequest(scopeId: string, now: number, limit: number): boolean {
  const entry = rateWindows.get(scopeId);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateWindows.set(scopeId, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

/** 测试隔离钩子；生产路径不需要重置（Map 以身份数为上界）。 */
export function resetOpsEventIngestRateLimiterForTests(): void {
  rateWindows.clear();
}

export interface OpsEventIngestOptions {
  resolveIdentity?: (
    platformHeader: unknown,
    tenantHeader: unknown,
  ) => Promise<ProbeReportIdentity | null>;
  recordEvent?: (input: OpsEventInput) => Promise<boolean>;
  storeConfigured?: () => boolean;
  now?: () => number;
  rateLimitPerMinute?: number;
}

export function createOpsEventIngestRouter(options: OpsEventIngestOptions = {}): Router {
  const router = Router();
  const resolveIdentity = options.resolveIdentity ?? resolveProbeReportIdentity;
  const recordEvent = options.recordEvent ?? recordOpsEvent;
  const storeConfigured = options.storeConfigured ?? isOpsEventStoreConfigured;
  const now = options.now ?? (() => Date.now());
  const rateLimitPerMinute = options.rateLimitPerMinute ?? RATE_LIMIT_PER_MINUTE;

  router.post('/api/ops/events', async (req: Request, res: Response) => {
    // Express 4 的 async handler 不捕获 rejection：任何异常必须就地转成 5xx
    // 回执，不允许穿透造成进程崩溃（拨测摄取的同一防线）。
    try {
      const identity = await resolveIdentity(
        req.header('x-rdk-external-probe-token'),
        req.header('x-rdk-tenant-probe-token'),
      );
      if (!identity) {
        res.status(401).json({ ok: false, error: 'invalid_probe_token' });
        return;
      }
      if (!allowRequest(identity.scopeId, now(), rateLimitPerMinute)) {
        res.status(429).json({ ok: false, error: 'rate_limited' });
        return;
      }
      if (!storeConfigured()) {
        res.status(503).json({ ok: false, error: 'ops_event_store_unavailable' });
        return;
      }
      const requestBytes = Buffer.byteLength(JSON.stringify(req.body ?? null));
      const parsed = parseOpsEventIngestBatch(req.body, { requestBytes });
      if (!parsed.ok) {
        const status =
          parsed.reason === 'request_bytes_limit' || parsed.reason === 'item_limit' ? 413 : 400;
        res.status(status).json({ ok: false, reason: parsed.reason });
        return;
      }
      let accepted = 0;
      let failed = 0;
      for (const event of parsed.events) {
        const written = await recordEvent({
          // 归属租户取 token 解析出的身份（不是正文里的声明）：平台规则与看板按
          // tenant_id 过滤，租户上报的事件不会再被当成平台信号。
          tenantId: identity.scopeId,
          component: event.component,
          eventCode: event.eventCode,
          outcome: event.outcome,
          ...(event.severityHint ? { severityHint: event.severityHint } : {}),
          ...(event.safeSummary ? { safeSummary: event.safeSummary } : {}),
          ...(event.metadata ? { metadata: event.metadata } : {}),
          ...(event.correlation ? { correlation: event.correlation } : {}),
          ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
          // eventId 进指纹 + 默认 1h 去重窗口：客户端按 eventId 重试天然幂等。
          fingerprintParts: [event.eventId],
          dedupeWithinMs: event.dedupeWithinMs ?? DEFAULT_DEDUPE_MS,
        });
        if (written) accepted += 1;
        else failed += 1;
      }
      if (parsed.events.length > 0 && accepted === 0) {
        // 预检通过但一条都没写进去：中心库中途不可用，让客户端稍后重试。
        res.status(503).json({ ok: false, error: 'ops_event_store_unavailable', retryable: true });
        return;
      }
      res.status(202).json({
        ok: true,
        accepted,
        dropped: parsed.dropped,
        failed,
        tenant: identity.scopeId,
      });
    } catch {
      res.status(500).json({ ok: false, error: 'ops_event_ingest_failed' });
    }
  });
  return router;
}
