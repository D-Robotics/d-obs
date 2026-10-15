import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueStudioTraceBatch, flushStudioTraceOutbox, studioTraceOutboxPathForTest } from './trace-batch-outbox.js';
import { normalizeStudioTraceBatch, STUDIO_TRACE_BATCH_SCHEMA } from '../../shared/studio-observability.js';
import {
  normalizeStudioTraceContent,
  createStudioTraceContentEntry,
  STUDIO_TRACE_CONTENT_SCHEMA,
  STUDIO_TRACE_CONTENT_MAX_BYTES,
} from '../../shared/studio-trace-content.js';
import { ingestStudioTraceBatchWithPool } from './scoped-trace-ingestion.js';
import { resetUnifiedStudioTraceSchemaForTest, UNIFIED_STUDIO_TRACE_SCHEMA_SQL } from './studio-trace-schema.js';
import { PostgresStudioTraceReadAdapter } from './trace-read-adapter.js';
import { createRunObservabilityService } from './run-observability-service.js';
import { issueRunLocator } from './run-locator.js';
import { PostgresTelemetryRetentionWorker } from './governance-runtime-worker.js';
import { TelemetryGovernanceRuntimeHealth } from './governance-runtime-health.js';

const NOW = Date.parse('2026-10-10T10:00:00Z');
const START = NOW - 60_000;
const content = {
  schema: STUDIO_TRACE_CONTENT_SCHEMA,
  entries: [
    { kind: 'user_input', text: '请解释这段代码。\n保留换行。' },
    { kind: 'model_output', text: '这里是模型回复。' },
    { kind: 'tool_input', text: JSON.stringify({ command: 'echo hello', api_key: 'test-secret' }) },
    { kind: 'tool_output', text: 'hello\n' },
  ],
  truncated: false, redacted: false,
};
function makeBatch() {
  return {
    schema: STUDIO_TRACE_BATCH_SCHEMA, batchId: 'a'.repeat(64),
    producerVersion: '1.4.4', mocVersion: '1.0.0', createdAt: NOW,
    spans: [{
      traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), runId: 'run-content',
      sessionId: 'session-content', name: 'moss.llm.request', sourceSegment: 'moss',
      kind: 'internal', startTimeUnixMs: START, endTimeUnixMs: START + 1000,
      outcome: 'ok', status: 'ok', attributes: { 'gen_ai.request.model': 'test-model' }, content,
      resource: { serviceName: 'rdk-studio', serviceInstanceId: 'test-instance',
        deploymentEnvironment: 'production', surface: 'web-cloud', studioVersion: '1.4.4',
        mossVersion: '1.0.0', mocVersion: '1.0.0' },
      sampling: { decision: 'retained', policyVersion: 'test-policy' },
    }],
  };
}

function row(extra: Record<string, unknown> = {}) {
  return { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), run_id: 'run-content',
    source: 'server', source_segment: 'moss', name: 'moss.llm.request', span_kind: 'internal',
    start_time_ms: START, end_time_ms: START + 1000, outcome: 'ok', status: 'ok',
    studio_version: '1.4.4', moc_version: '1.0.0', sampling_decision: 'retained',
    attributes: {}, content, content_availability: 'available', ...extra };
}

test('native batch retains multiline content independently of metadata and redacts structured secrets', () => {
  const result = normalizeStudioTraceBatch(makeBatch(), { now: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const body = result.batch.spans[0].content;
  assert.equal(body?.entries[0].text, content.entries[0].text);
  assert.equal(body?.entries[1].text, content.entries[1].text);
  assert.equal(body?.redacted, true);
  assert.doesNotMatch(JSON.stringify(body), /test-secret/);
  assert.equal(body?.entries[2].text, '{"api_key":"[REDACTED]","command":"echo hello"}');
  assert.equal(result.batch.spans[0].attributes.content, undefined);
  assert.deepEqual(normalizeStudioTraceContent(body), body, 'normalization remains idempotent');
});

test('unknown content cannot discard valid spans; UTF8 entries and total content stay bounded', () => {
  const input = makeBatch();
  const bad = { ...input, spans: [{ ...input.spans[0], content: { schema: 'unknown', entries: [] } }] };
  const result = normalizeStudioTraceBatch(bad, { now: NOW });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.batch.spans[0].content, undefined);
  const long = normalizeStudioTraceContent({ ...content,
    entries: Array.from({ length: 32 }, () => ({ kind: 'model_output', text: '多行😀\n'.repeat(3000) })) });
  assert.ok(long);
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= STUDIO_TRACE_CONTENT_MAX_BYTES);
  assert.ok(long.entries.every(entry => Buffer.byteLength(entry.text) <= 8192));
});

test('authenticated ingestion stores redacted native body with a seven-day deadline, not attributes', async () => {
  resetUnifiedStudioTraceSchemaForTest();
  const parsed = normalizeStudioTraceBatch(makeBatch(), { now: NOW });
  assert.ok(parsed.ok);
  let persisted: Record<string, unknown>[] = [];
  const client = { async query(sql: string, params: unknown[] = []) {
    if (sql.includes('insert into public.studio_trace_spans')) {
      assert.match(sql, /interval '7 days'/);
      assert.match(sql, /content_expires_at/);
      assert.deepEqual(params.slice(0, 2), ['account-content', 'production']);
      persisted = JSON.parse(String(params[4]));
      return { rows: [{ trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) }] };
    }
    if (sql.includes('studio_trace_ingestion_receipts') && sql.trimStart().startsWith('insert')) {
      return { rows: [{ batch_id: 'a'.repeat(64) }], rowCount: 1 };
    }
    return { rows: [] };
  }, release() {} };
  const result = await ingestStudioTraceBatchWithPool({ pool: { async connect() { return client; } },
    scope: { accountScopeId: 'account-content', environment: 'production' }, batch: parsed.batch });
  assert.equal(result.ok, true);
  assert.equal(persisted.length, 1);
  assert.doesNotMatch(JSON.stringify(persisted), /test-secret/);
  assert.deepEqual(persisted[0].content, parsed.batch.spans[0].content);
  assert.match(UNIFIED_STUDIO_TRACE_SCHEMA_SQL, /add column if not exists content_expires_at/);
});

test('read adapter retains full bodies under scoped query and hides expired bodies', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let expired = false;
  const adapter = new PostgresStudioTraceReadAdapter({ async query(sql, params = []) {
    queries.push({ sql, params });
    return { rows: [row(expired ? { content: null, content_availability: 'expired' } : {})] };
  } });
  const scope = { accountScopeId: 'account-content', environment: 'production' as const };
  const first = await adapter.readByRun(scope, 'run-content');
  assert.equal(first.fragments[0].spans[0].content?.entries[0].text, content.entries[0].text);
  assert.doesNotMatch(JSON.stringify(first), /test-secret/);
  assert.deepEqual(queries[0].params.slice(0, 3), ['account-content', 'production', 'run-content']);
  assert.match(queries[0].sql, /case when content_expires_at > now\(\) then content else null/);
  assert.match(queries[0].sql, /studio_telemetry_tombstones/);
  expired = true;
  const second = await adapter.readByTrace(scope, 'b'.repeat(32));
  assert.equal(second.fragments[0].spans[0].content, undefined);
  assert.equal(second.fragments[0].spans[0].contentAvailability, 'expired');
});

async function detailWith(extra: Record<string, unknown> = {}, account = 'account-content') {
  let calls = 0;
  const service = createRunObservabilityService({ now: () => NOW, protectedReadReady: () => true,
    db: { async query(sql) {
      calls++;
      if (sql.includes('from public.agent_run_records')) return { rows: [{ run_fact: {
        run_id: 'run-content', started_at: new Date(START).toISOString(),
        completed_at: new Date(START + 1000).toISOString(), outcome: 'success', app_version: '1.4.4',
      } }] };
      if (sql.includes("coalesce(run_id, '') = ''")) return { rows: [] };
      if (sql.includes('from public.studio_trace_spans')) return { rows: [row(extra)] };
      return { rows: [] };
    } } });
  const locator = issueRunLocator({ accountScopeId: 'account-content', environment: 'production',
    runId: 'run-content', now: NOW, ttlMs: 600_000 });
  return { result: await service(locator, { kind: 'owner', accountScopeId: account }), calls };
}

test('scoped detail exposes explicit conversation DTO and honest missing/expired states', async () => {
  const first = await detailWith();
  assert.equal(first.result.status, 'found');
  if (first.result.status !== 'found') return;
  const dto = first.result.detail.traces[0].spans[0].content;
  assert.equal(dto.availability, 'available');
  if (dto.availability === 'available') assert.equal(dto.entries[0].text, content.entries[0].text);
  assert.doesNotMatch(JSON.stringify(first.result), /test-secret/);
  for (const availability of ['expired', 'not_captured'] as const) {
    const state = await detailWith({ content: null, content_availability: availability });
    assert.equal(state.result.status, 'found');
    if (state.result.status === 'found') assert.deepEqual(state.result.detail.traces[0].spans[0].content,
      { availability });
  }
  const denied = await detailWith({}, 'other-account');
  assert.equal(denied.result.status, 'not_found');
  assert.equal(denied.calls, 0);
});

test('retention sweep clears expired bodies within account/environment while retaining expiry markers', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const worker = new PostgresTelemetryRetentionWorker({ async query(sql, params = []) {
    calls.push({ sql, params });
    return sql.startsWith('update') ? { rows: [{ span_id: 'c'.repeat(16) }], rowCount: 1 } :
      { rows: [{ low_sensitivity_deleted: 2, payload_deleted: 3 }] };
  } }, new TelemetryGovernanceRuntimeHealth());
  const result = await worker.runScope({ accountScopeId: 'account-content', environment: 'production' }, NOW);
  assert.deepEqual(result, { ok: true, lowSensitivityDeleted: 2, payloadDeleted: 4 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, ['account-content', 'production', NOW]);
  assert.match(calls[1].sql, /set content = null/);
  assert.doesNotMatch(calls[1].sql, /set content_expires_at/);
  assert.match(calls[1].sql, /interval '7 days'/);
});


test('retry outbox discards content batches at seven days while metadata keeps 35 days', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dobs-content-outbox-'));
  const previous = process.env.RDK_DATA_DIR;
  process.env.RDK_DATA_DIR = dir;
  try {
    const parsed = normalizeStudioTraceBatch(makeBatch(), { now: NOW });
    assert.ok(parsed.ok);
    await enqueueStudioTraceBatch({ accountScopeId: 'content-outbox-test', batch: parsed.batch, now: NOW });
    const file = JSON.parse(await readFile(studioTraceOutboxPathForTest('content-outbox-test'), 'utf8'));
    assert.equal(file.items[0].expiresAt, START + 7 * 24 * 60 * 60_000);
    let uploads = 0;
    await flushStudioTraceOutbox({ accountScopeId: 'content-outbox-test', now: START + 7 * 24 * 60 * 60_000,
      upload: async () => { uploads++; return { ok: true, status: 'accepted' }; } });
    assert.equal(uploads, 0);
    const expired = JSON.parse(await readFile(studioTraceOutboxPathForTest('content-outbox-test'), 'utf8'));
    assert.equal(expired.items.length, 0);
    const metadata = { ...parsed.batch, batchId: 'd'.repeat(64),
      spans: parsed.batch.spans.map(({ content: _content, ...span }) => span) };
    await enqueueStudioTraceBatch({ accountScopeId: 'content-outbox-test', batch: metadata, now: NOW });
    const kept = JSON.parse(await readFile(studioTraceOutboxPathForTest('content-outbox-test'), 'utf8'));
    assert.equal(kept.items[0].expiresAt, START + 35 * 24 * 60 * 60_000);
  } finally {
    if (previous === undefined) delete process.env.RDK_DATA_DIR;
    else process.env.RDK_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});


test('long, fenced and truncated JSON bodies redact credentials before losing JSON structure', () => {
  const marker = 'synthetic-content-credential';
  const inputs = [
    JSON.stringify({ api_key: marker, note: 'x'.repeat(12000) }),
    JSON.stringify({ accessToken: marker, clientSecret: marker, apiKey: marker }),
    '配置示例：\n```json\n' + JSON.stringify({ api_key: marker }) + '\n```',
    '{"api_key":"' + marker + '","note":"truncated',
  ];
  for (const input of inputs) {
    const captured = createStudioTraceContentEntry('tool_output', input);
    assert.ok(captured);
    assert.equal(captured.redacted, true);
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(marker));
    const normalized = normalizeStudioTraceContent(captured);
    assert.ok(normalized);
    assert.doesNotMatch(JSON.stringify(normalized), new RegExp(marker));
  }
});
