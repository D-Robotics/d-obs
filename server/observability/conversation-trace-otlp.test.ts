import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicObservabilityStore, PublicObservabilityConflictError } from '../public-api/public-observability-store.js';
import { ingestTracePayload } from './ai-ecosystem-routes.js';

const identity = { owner: 'public_conversation-trace-binding-test', keyId: 'conversation-binding-key' };

function payload(spans: Array<{ traceId: string; spanId: string; attributes: Record<string, string> }>) {
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'binding-test' } }] },
    scopeSpans: [{ spans: spans.map(span => ({
      ...span, name: 'chat generation', startTimeUnixNano: String(Date.now() * 1_000_000),
      endTimeUnixNano: String((Date.now() + 1) * 1_000_000),
      attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
    })) }] }] };
}

test('OTLP two turns sharing a conversation retain separate run and trace identities', async () => {
  const trace1 = '1'.repeat(32), trace2 = '2'.repeat(32);
  const sessionId = 'otlp-shared-conversation';
  const result = await ingestTracePayload(payload([
    { traceId: trace1, spanId: 'a'.repeat(16), attributes: { 'gen_ai.conversation.id': sessionId } },
    { traceId: trace2, spanId: 'b'.repeat(16), attributes: { 'gen_ai.conversation.id': sessionId } },
  ]), identity);
  assert.equal(result.accepted, 2);
  const store = getPublicObservabilityStore();
  assert.equal((await store.getRun(identity.owner, trace1))?.sessionRef, sessionId);
  assert.equal((await store.getRun(identity.owner, trace2))?.sessionRef, sessionId);
  assert.equal((await store.getTrace(identity.owner, trace1))?.[0]?.traceId, trace1);
  assert.equal((await store.getTrace(identity.owner, trace2))?.[0]?.traceId, trace2);
});

test('OTLP multiple trace fragments of one run keep their producer trace IDs and full session ID', async () => {
  const trace1 = '3'.repeat(32), trace2 = '4'.repeat(32);
  const runId = 'otlp-multiple-fragments-run';
  const sessionId = 's'.repeat(200);
  const result = await ingestTracePayload(payload([
    { traceId: trace1, spanId: 'c'.repeat(16), attributes: { 'moss.run.id': runId, 'moss.session.id': sessionId } },
    { traceId: trace2, spanId: 'd'.repeat(16), attributes: { 'moss.run.id': runId, 'moss.session.id': sessionId } },
  ]), identity);
  assert.equal(result.accepted, 2);
  const store = getPublicObservabilityStore();
  assert.equal((await store.getRun(identity.owner, runId))?.sessionRef, sessionId);
  const spans = await store.getTrace(identity.owner, runId);
  assert.deepEqual(spans?.map(span => span.traceId).sort(), [trace1, trace2]);
  assert.ok(spans?.every(span => span.attributes.sessionRef === sessionId));
});

test('a later OTLP batch cannot rebind an existing Run to a different conversation', async () => {
  const traceId = '5'.repeat(32), runId = 'otlp-immutable-session-run';
  const first = await ingestTracePayload(payload([
    { traceId, spanId: 'e'.repeat(16), attributes: { 'moss.run.id': runId, 'moss.session.id': 'session-original' } },
  ]), identity);
  assert.equal(first.accepted, 1);
  const second = await ingestTracePayload(payload([
    { traceId, spanId: 'f'.repeat(16), attributes: { 'moss.run.id': runId, 'moss.session.id': 'session-other' } },
  ]), identity);
  assert.equal(second.accepted, 0);
  assert.equal(second.rejected, 1);
  const store = getPublicObservabilityStore();
  assert.equal((await store.getRun(identity.owner, runId))?.sessionRef, 'session-original');
  assert.equal((await store.getTrace(identity.owner, runId))?.length, 1);
});

test('one span batch with contradictory conversations is rejected before Run metadata changes', async () => {
  const store = getPublicObservabilityStore();
  const runId = 'otlp-conflicting-session-batch';
  const now = Date.now();
  await assert.rejects(store.appendSpans({ ...identity, runId, traceId: '6'.repeat(32),
    run: { sessionRef: 'session-1' }, spans: [
      { spanId: '1'.repeat(16), kind: 'generation', name: 'chat generation', startTime: now,
        endTime: now + 1, attributes: { sessionRef: 'session-1' } },
      { spanId: '2'.repeat(16), kind: 'generation', name: 'chat generation', startTime: now,
        endTime: now + 1, attributes: { sessionRef: 'session-2' } },
    ] }), PublicObservabilityConflictError);
  assert.equal(await store.getRun(identity.owner, runId), null);
});

test('public Run metadata updates preserve a declared conversation binding before applying other metadata', async () => {
  const store = getPublicObservabilityStore();
  const runId = 'otlp-session-metadata-immutable';
  await store.ensureRun(identity.owner, identity.keyId, { runId, projectId: 'original-project',
    environment: 'test', service: 'binding-test', sessionRef: 'session-original' });
  await assert.rejects(store.ensureRun(identity.owner, identity.keyId, { runId, projectId: 'changed-project',
    environment: 'test', service: 'binding-test', sessionRef: 'session-other' }), PublicObservabilityConflictError);
  const run = await store.getRun(identity.owner, runId);
  assert.equal(run?.sessionRef, 'session-original');
  assert.equal(run?.projectId, 'original-project');
});
