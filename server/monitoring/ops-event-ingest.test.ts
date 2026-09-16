/**
 * 事件级埋点摄取回归测试：批级严格校验、单条丢弃语义、幂等指纹契约，
 * 以及 HTTP 层的鉴权/限速/失败回执与"异常不穿透 async handler"防线。
 *
 * HTTP 用例注入 fake 身份解析器与写入器并起 ephemeral 端口的真实 express
 * 应用，不依赖中心库；仅 401 用例走真实 fail-closed 路径（无库 + 无 token 文件）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';

import {
  OPS_EVENTS_INGEST_SCHEMA,
  createOpsEventIngestRouter,
  parseOpsEventIngestBatch,
  resetOpsEventIngestRateLimiterForTests,
  type OpsEventIngestOptions,
} from './ops-event-ingest.js';
import type { ProbeReportIdentity } from './external-probe-ingest.js';
import type { OpsEventInput } from './ops-event-store.js';

function baseEvent(): Record<string, unknown> {
  return {
    eventId: '0b74e5c1-1111-4a2b-9c3d-1234567890ab',
    component: 'sim2real-web',
    eventCode: 'run_created',
    outcome: 'ok',
  };
}

function baseBatch(): Record<string, unknown> {
  return { schema: OPS_EVENTS_INGEST_SCHEMA, producedBy: 'sim2real-web', events: [baseEvent()] };
}

function fakeIdentity(): ProbeReportIdentity {
  return { scopeId: 'sim2real', source: 'tenant:sim2real' };
}

async function withTestApp(
  options: OpsEventIngestOptions,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createOpsEventIngestRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postJson(url: string, body: unknown, token = 'tenant-token-ignored-by-fake') {
  return fetch(`${url}/api/ops/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rdk-tenant-probe-token': token },
    body: JSON.stringify(body),
  });
}

test('合法批次完整解析：可选字段透传，未知 correlation 键丢弃', () => {
  const raw = baseBatch();
  (raw.events as unknown[])[0] = {
    ...baseEvent(),
    severityHint: 'warning',
    safeSummary: 'run entered training',
    metadata: { engine: 'starter-ppo', iterations: 42, cuda: true, dead: null },
    correlation: { runId: 'run-1', userId: 'u1', evil: 'drop-me' },
    occurredAt: '2026-09-15T08:00:00Z',
    dedupeWithinMs: 5 * 60_000,
  };
  const parsed = parseOpsEventIngestBatch(raw);
  assert.ok(parsed.ok);
  assert.equal(parsed.producedBy, 'sim2real-web');
  assert.equal(parsed.dropped, 0);
  const event = parsed.events[0];
  assert.equal(event.severityHint, 'warning');
  assert.equal(event.correlation?.runId, 'run-1');
  assert.equal(event.correlation?.userId, 'u1');
  assert.equal((event.correlation as Record<string, unknown>)?.evil, undefined);
  assert.equal(event.metadata?.engine, 'starter-ppo');
  assert.equal(event.dedupeWithinMs, 5 * 60_000);
  assert.equal(event.occurredAt, '2026-09-15T08:00:00Z');
});

test('批级拒绝：非对象、错 schema、错 producedBy、空 events、超 64 条、字节超限', () => {
  assert.equal(parseOpsEventIngestBatch(null).ok, false);
  assert.equal(parseOpsEventIngestBatch('x').ok, false);
  assert.equal(
    parseOpsEventIngestBatch({ ...baseBatch(), schema: 'rdk.dobs.ops-events.v2' }).ok,
    false,
  );
  assert.equal(parseOpsEventIngestBatch({ ...baseBatch(), producedBy: '' }).ok, false);
  assert.equal(parseOpsEventIngestBatch({ ...baseBatch(), events: [] }).ok, false);
  const tooMany = baseBatch();
  tooMany.events = Array.from({ length: 65 }, () => baseEvent());
  assert.equal(parseOpsEventIngestBatch(tooMany).ok, false);
  assert.equal(parseOpsEventIngestBatch(baseBatch(), { requestBytes: 300 * 1024 }).ok, false);
});

test('单条身份/枚举字段非法整条丢弃，计数 dropped', () => {
  const raw = baseBatch();
  raw.events = [
    { ...baseEvent(), outcome: 'boom' },
    { ...baseEvent(), severityHint: 'fatal' },
    { ...baseEvent(), occurredAt: 'not-a-date' },
    { ...baseEvent(), eventId: '' },
    { ...baseEvent(), component: '???' },
    baseEvent(),
  ];
  const parsed = parseOpsEventIngestBatch(raw);
  assert.ok(parsed.ok);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.dropped, 5);
});

test('载荷字段非法按缺失处理：safeSummary 非字符串、metadata 值类型过滤', () => {
  const raw = baseBatch();
  raw.events = [
    {
      ...baseEvent(),
      safeSummary: 123,
      metadata: { ok: 'yes', nul: null, fun: () => 1, nan: Number.NaN, bad: undefined },
    },
  ];
  const parsed = parseOpsEventIngestBatch(raw);
  assert.ok(parsed.ok);
  const event = parsed.events[0];
  assert.equal(event.safeSummary, undefined);
  assert.deepEqual(event.metadata, { ok: 'yes', nul: null });
});

test('dedupeWithinMs 负数/非数值按缺失处理，超过 1h 钳制到 1h', () => {
  const negative = parseOpsEventIngestBatch({
    ...baseBatch(),
    events: [{ ...baseEvent(), dedupeWithinMs: -5 }],
  });
  assert.ok(negative.ok);
  assert.equal(negative.events[0].dedupeWithinMs, undefined);
  const huge = parseOpsEventIngestBatch({
    ...baseBatch(),
    events: [{ ...baseEvent(), dedupeWithinMs: 24 * 60 * 60_000 }],
  });
  assert.ok(huge.ok);
  assert.equal(huge.events[0].dedupeWithinMs, 60 * 60_000);
});

test('HTTP：正常批次 202，写入器收到 eventId 幂等指纹与默认去重窗口', async () => {
  const recorded: OpsEventInput[] = [];
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => true,
      recordEvent: async (input) => {
        recorded.push(input);
        return true;
      },
    },
    async (baseUrl) => {
      const response = await postJson(baseUrl, baseBatch());
      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.accepted, 1);
      assert.equal(body.dropped, 0);
      assert.equal(body.tenant, 'sim2real');
    },
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].component, 'sim2real-web');
  assert.equal(recorded[0].eventCode, 'run_created');
  assert.deepEqual(recorded[0].fingerprintParts, [baseEvent().eventId]);
  assert.equal(recorded[0].dedupeWithinMs, 60 * 60_000);
  // 归属租户来自 token 解析出的身份，写入器必须收到它——否则租户事件会混进
  // 平台看板与平台告警规则。
  assert.equal(recorded[0].tenantId, 'sim2real');
});

test('HTTP：平台 token 的事件归属 platform，正文无法伪造 tenantId', async () => {
  const recorded: OpsEventInput[] = [];
  await withTestApp(
    {
      resolveIdentity: async () => ({ scopeId: 'platform', source: '106.53' }),
      storeConfigured: () => true,
      recordEvent: async (input) => {
        recorded.push(input);
        return true;
      },
    },
    async (baseUrl) => {
      // 正文里塞一个冒充的 tenantId：解析器不接受该字段，身份只认 token。
      const batch = baseBatch();
      (batch.events as Array<Record<string, unknown>>)[0].tenantId = 'victim-team';
      const response = await postJson(baseUrl, batch);
      assert.equal(response.status, 202);
    },
  );
  assert.equal(recorded[0].tenantId, 'platform');
});

test('HTTP：混合批次 accepted/dropped 分开计数', async () => {
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => true,
      recordEvent: async () => true,
    },
    async (baseUrl) => {
      const response = await postJson(baseUrl, {
        ...baseBatch(),
        events: [baseEvent(), { ...baseEvent(), outcome: 'nope' }],
      });
      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.accepted, 1);
      assert.equal(body.dropped, 1);
    },
  );
});

test('HTTP：批级问题返回 400/413，且写入器一次都不被调用', async () => {
  let writes = 0;
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => true,
      recordEvent: async () => {
        writes += 1;
        return true;
      },
    },
    async (baseUrl) => {
      const badSchema = await postJson(baseUrl, { schema: 'wrong', events: [] });
      assert.equal(badSchema.status, 400);
      const tooMany = await postJson(baseUrl, {
        ...baseBatch(),
        events: Array.from({ length: 65 }, () => baseEvent()),
      });
      assert.equal(tooMany.status, 413);
    },
  );
  assert.equal(writes, 0);
});

test('HTTP：中心库未配置 503；写全部失败 503（retryable）', async () => {
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => false,
      recordEvent: async () => true,
    },
    async (baseUrl) => {
      const response = await postJson(baseUrl, baseBatch());
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as Record<string, unknown>).error, 'ops_event_store_unavailable');
    },
  );
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => true,
      recordEvent: async () => false,
    },
    async (baseUrl) => {
      const response = await postJson(baseUrl, baseBatch());
      assert.equal(response.status, 503);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.retryable, true);
    },
  );
});

test('HTTP：限速 429——固定窗口内超出配额的请求被拒', async () => {
  resetOpsEventIngestRateLimiterForTests();
  const fixedNow = Date.now();
  await withTestApp(
    {
      resolveIdentity: async () => fakeIdentity(),
      storeConfigured: () => true,
      recordEvent: async () => true,
      now: () => fixedNow,
      rateLimitPerMinute: 2,
    },
    async (baseUrl) => {
      assert.equal((await postJson(baseUrl, baseBatch())).status, 202);
      assert.equal((await postJson(baseUrl, baseBatch())).status, 202);
      const limited = await postJson(baseUrl, baseBatch());
      assert.equal(limited.status, 429);
    },
  );
});

test('HTTP：身份解析器抛异常 → 500 回执，不穿透 async handler', async () => {
  await withTestApp(
    {
      resolveIdentity: async () => {
        throw new Error('boom');
      },
      storeConfigured: () => true,
      recordEvent: async () => true,
    },
    async (baseUrl) => {
      const response = await postJson(baseUrl, baseBatch());
      assert.equal(response.status, 500);
    },
  );
});

test('HTTP：真实 fail-closed 鉴权——无 token / 错 token 一律 401', async () => {
  const savedDb = process.env.RDK_CHAT_CREDITS_DB_URL;
  const savedPath = process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH = '/nonexistent/d-obs-ops-event-test-token';
  try {
    await withTestApp({}, async (baseUrl) => {
      const noToken = await fetch(`${baseUrl}/api/ops/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseBatch()),
      });
      assert.equal(noToken.status, 401);
      const badToken = await fetch(`${baseUrl}/api/ops/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rdk-tenant-probe-token': 'a'.repeat(64) },
        body: JSON.stringify(baseBatch()),
      });
      assert.equal(badToken.status, 401);
    });
  } finally {
    if (savedDb !== undefined) process.env.RDK_CHAT_CREDITS_DB_URL = savedDb;
    if (savedPath !== undefined) process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH = savedPath;
    else delete process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH;
  }
});
