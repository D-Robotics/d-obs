import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAiSemanticAttributes,
  resolveAiRunId,
  resolveAiSessionBinding,
} from '../../shared/ai-observability-semantics.js';
import { persistStudioTraceSpans } from './studio-trace-store.js';
import { PostgresStudioTraceReadAdapter } from './trace-read-adapter.js';
import { normalizeStudioTraceBatch, STUDIO_TRACE_BATCH_SCHEMA } from '../../shared/studio-observability.js';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);
const legacySpan = {
  schema: 'rdk.studio.trace-span.v1' as const,
  traceId: TRACE, spanId: SPAN, runId: 'run-turn-2', source: 'server' as const,
  name: 'moss.session', startTime: 1_700_000_000_000, endTime: 1_700_000_001_000,
  status: 'ok' as const, attributes: {},
};

test('OTLP keeps separate run identities for two turns of one conversation', () => {
  for (const alias of ['gen_ai.conversation.id', 'conversation.id']) {
    const attributes = { [alias]: 'conversation-shared' };
    assert.equal(resolveAiRunId(attributes, TRACE), TRACE);
    assert.equal(resolveAiRunId(attributes, 'c'.repeat(32)), 'c'.repeat(32));
    assert.equal(normalizeAiSemanticAttributes(attributes).sessionRef, 'conversation-shared');
    assert.equal(resolveAiRunId({ ...attributes, 'moss.run.id': 'run-turn-2' }, TRACE), 'run-turn-2');
  }
});

test('Moss session aliases agree before becoming an authoritative conversation binding', () => {
  assert.deepEqual(resolveAiSessionBinding({ 'moss.session.id': 'session-1', sessionKey: 'session-1' }),
    { sessionId: 'session-1', conflict: false });
  assert.equal(normalizeAiSemanticAttributes({ 'moss.session.id': 'session-1' }).sessionRef, 'session-1');
  assert.deepEqual(resolveAiSessionBinding({ 'moss.session.id': 'session-1', sessionRef: 'session-2' }),
    { conflict: true });
  assert.equal(normalizeAiSemanticAttributes({ 'moss.session.id': 'session-1', sessionRef: 'session-2' }).sessionRef, undefined);
  assert.deepEqual(resolveAiSessionBinding({ sessionId: 'session-1' }, 'session-2'), { conflict: true });
  assert.deepEqual(resolveAiSessionBinding({ sessionRef: 'session\u0000-1' }), { conflict: true });
});

test('explicit canonical conversation stays distinct from the internal Moss session key', async () => {
  const attributes = { 'rdk.session.id': 'session-1', 'moss.session.id': 'acct:namespace:local:studio:session-1',
    sessionKey: 'acct:namespace:local:studio:session-1' };
  assert.deepEqual(resolveAiSessionBinding(attributes, 'session-1'), { sessionId: 'session-1', conflict: false });
  assert.equal(normalizeAiSemanticAttributes(attributes).sessionRef, 'session-1');
  assert.deepEqual(resolveAiSessionBinding({ ...attributes, 'rdk.session.id': 'session-2' }, 'session-1'), { conflict: true });
  const result = await readRow('session-1', attributes);
  assert.equal(result.fragments[0].spans[0].sessionId, 'session-1');
  assert.deepEqual(result.fragments[0].integrity, []);
  assert.equal(result.fragments[0].spans[0].attributes['rdk.session.id'], 'session-1');
  const scoped = await readRow('project/thread-1', { 'rdk.session.id': 'project/thread-1',
    'moss.session.id': 'acct:namespace:studio:project/thread-1' });
  assert.equal(scoped.fragments[0].spans[0].attributes['rdk.session.id'], 'project/thread-1');
  assert.deepEqual(scoped.fragments[0].integrity, []);
});

async function capturePersistence(attributes: Record<string, string>, sessionId?: string, written = 1) {
  const previousDb = process.env.RDK_CHAT_CREDITS_DB_URL;
  process.env.RDK_CHAT_CREDITS_DB_URL ||= 'postgresql://conversation-binding-test:local@127.0.0.1/unused';
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  try {
    const ok = await persistStudioTraceSpans({
      spans: [{ ...legacySpan, attributes }], ownerUserId: 'credential-owner',
      accountScopeId: 'account-1', sessionId,
      pool: { async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows: [], rowCount: written };
      } },
    });
    return { ok, queries, insert: queries.find(query => query.sql.includes('insert into public.studio_trace_spans')) };
  } finally {
    if (previousDb === undefined) delete process.env.RDK_CHAT_CREDITS_DB_URL;
    else process.env.RDK_CHAT_CREDITS_DB_URL = previousDb;
  }
}

test('legacy OTLP persistence promotes a declared session identity into the scoped session column', async () => {
  const result = await capturePersistence({ sessionRef: 'session-1' });
  assert.equal(result.ok, true);
  assert.ok(result.insert);
  const rows = JSON.parse(String(result.insert.params[3])) as Array<Record<string, unknown>>;
  assert.equal(rows[0].session_id, 'session-1');
  assert.deepEqual(result.insert.params.slice(0, 3), ['account-1', result.insert.params[1], 'credential-owner']);
  assert.match(result.insert.sql, /session_id = coalesce\(public\.studio_trace_spans\.session_id, excluded\.session_id\)/);
  assert.match(result.insert.sql, /public\.studio_trace_spans\.session_id = excluded\.session_id/);
  assert.match(result.insert.sql, /canonical_hash is null/);
});

test('conflicting or absent session identities never get inferred from run ID or receipt time', async () => {
  const conflicting = await capturePersistence({ 'moss.session.id': 'session-1', sessionRef: 'session-2' });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.queries.length, 0);
  assert.equal((await capturePersistence({ sessionId: 'session-1' }, 'session-2')).ok, false);
  const unbound = await capturePersistence({});
  assert.ok(unbound.insert);
  assert.equal(JSON.parse(String(unbound.insert.params[3]))[0].session_id, null);
  const explicit = await capturePersistence({}, 'session-1');
  assert.ok(explicit.insert);
  assert.equal(JSON.parse(String(explicit.insert.params[3]))[0].session_id, 'session-1');
});

test('legacy persistence reports a rejected session rebind instead of claiming success', async () => {
  assert.equal((await capturePersistence({ sessionRef: 'session-2' }, undefined, 0)).ok, false);
});

async function readRow(sessionId: string | null, attributes: Record<string, unknown>) {
  const adapter = new PostgresStudioTraceReadAdapter({ async query() {
    return { rows: [{ trace_id: TRACE, span_id: SPAN, run_id: 'run-turn-2', session_id: sessionId,
      source: 'server', source_segment: 'moss', name: 'moss.session',
      start_time_ms: legacySpan.startTime, end_time_ms: legacySpan.endTime, attributes }] };
  } });
  return adapter.readByRun({ accountScopeId: 'account-1', environment: 'test' }, 'run-turn-2');
}

test('read adapter exposes only consistent session bindings and marks disagreements', async () => {
  const consistent = await readRow('session-1', { 'moss.session.id': 'session-1', sessionKey: 'session-1' });
  assert.equal(consistent.fragments[0].spans[0].sessionId, 'session-1');
  assert.deepEqual(consistent.fragments[0].integrity, []);
  const conflict = await readRow('session-1', { sessionId: 'session-2' });
  assert.equal(conflict.fragments[0].spans[0].sessionId, undefined);
  assert.deepEqual(conflict.fragments[0].integrity,
    [{ code: 'identifier_conflict', traceId: TRACE, spanId: SPAN, field: 'session_id' }]);
  const aliasConflict = await readRow(null, { 'moss.session.id': 'session-1', sessionKey: 'session-2' });
  assert.equal(aliasConflict.fragments[0].spans[0].sessionId, undefined);
  assert.equal(aliasConflict.fragments[0].integrity[0].code, 'identifier_conflict');
});

test('read adapter preserves coherent historical session aliases without truncating their identities', async () => {
  const sessionId = 's'.repeat(180);
  const historic = await readRow(null, { 'moss.session.id': sessionId, sessionKey: sessionId });
  assert.equal(historic.fragments[0].spans[0].sessionId, sessionId);
  assert.deepEqual(historic.fragments[0].integrity, []);
});

test('legacy persistence keeps a full 200-character session identity in both metadata and storage', async () => {
  const sessionId = 's'.repeat(200);
  const persisted = await capturePersistence({ sessionRef: sessionId });
  assert.equal(persisted.ok, true);
  assert.ok(persisted.insert);
  const stored = JSON.parse(String(persisted.insert.params[3]))[0];
  assert.equal(stored.session_id, sessionId);
  assert.equal(stored.attributes.sessionRef, sessionId);
});

test('read adapter compares full run identities before low-sensitivity metadata projection', async () => {
  const runId = 'r'.repeat(200);
  const adapter = new PostgresStudioTraceReadAdapter({ async query() {
    return { rows: [{ trace_id: TRACE, span_id: SPAN, run_id: runId,
      source: 'server', name: 'moss.session', start_time_ms: legacySpan.startTime,
      end_time_ms: legacySpan.endTime, attributes: { 'moss.run.id': runId, runId } }] };
  } });
  const result = await adapter.readByRun({ accountScopeId: 'account-1', environment: 'test' }, runId);
  assert.equal(result.fragments[0].spans[0].runId, runId);
  assert.deepEqual(result.fragments[0].integrity, []);
});

const NOW = Date.parse('2026-10-12T06:00:00Z');
function nativeBatch(extra: Record<string, unknown> = {}) {
  return { schema: STUDIO_TRACE_BATCH_SCHEMA, batchId: 'e'.repeat(64), producerVersion: '1.4.4',
    mocVersion: '1.0.0', createdAt: NOW, spans: [{
      traceId: TRACE, spanId: SPAN, runId: 'run-turn-2', sessionId: 'session-1',
      name: 'moss.llm.request', sourceSegment: 'moss', kind: 'internal',
      startTimeUnixMs: NOW - 1000, endTimeUnixMs: NOW, outcome: 'ok', status: 'ok', attributes: {},
      resource: { serviceName: 'rdk-studio', serviceInstanceId: 'test-instance',
        deploymentEnvironment: 'test', surface: 'web-cloud', studioVersion: '1.4.4',
        mossVersion: '1.0.0', mocVersion: '1.0.0' },
      sampling: { decision: 'retained', policyVersion: 'test-policy' }, ...extra,
    }] };
}

test('native ingestion rejects contradictory explicit Run or conversation aliases', () => {
  for (const attributes of [
    { 'moss.session.id': 'session-other' }, { sessionKey: 'session-other' },
    { 'moss.run.id': 'run-other' }, { runId: 'run-other' },
  ]) {
    assert.deepEqual(normalizeStudioTraceBatch(nativeBatch({ attributes }), { now: NOW }),
      { ok: false, reason: 'invalid_identifier', itemIndex: 0 });
  }
});

test('native ingestion promotes declared conversation aliases when the explicit field is absent', () => {
  for (const attributes of [{ 'moss.session.id': 'session-1' }, { sessionKey: 'session-1' },
    { 'gen_ai.conversation.id': 'session-1' }]) {
    const result = normalizeStudioTraceBatch(nativeBatch({ sessionId: undefined, attributes }), { now: NOW });
    assert.ok(result.ok);
    assert.equal(result.batch.spans[0].sessionId, 'session-1');
  }
});

test('native ingestion preserves full canonical and legacy identity aliases', () => {
  const sessionId = 's'.repeat(180), runId = 'r'.repeat(180);
  const attributes = { 'moss.session.id': sessionId, sessionKey: sessionId, 'moss.run.id': runId, runId };
  const result = normalizeStudioTraceBatch(nativeBatch({ sessionId, runId, attributes }), { now: NOW });
  assert.ok(result.ok);
  const span = result.batch.spans[0];
  assert.equal(span.sessionId, sessionId);
  assert.equal(span.runId, runId);
  assert.deepEqual(span.attributes, attributes);
});

test('native ingestion rejects oversized identities rather than truncating them into existing IDs', () => {
  for (const extra of [{ sessionId: 's'.repeat(201) }, { runId: 'r'.repeat(201) },
    { sessionId: undefined, attributes: { sessionKey: 's'.repeat(201) } },
    { attributes: { 'moss.run.id': 'r'.repeat(201) } }]) {
    assert.deepEqual(normalizeStudioTraceBatch(nativeBatch(extra), { now: NOW }),
      { ok: false, reason: 'invalid_identifier', itemIndex: 0 });
  }
});
