import assert from 'node:assert/strict';
import test from 'node:test';
import { readRunConversationContext } from './run-conversation-context.js';
import { createRunObservabilityService } from './run-observability-service.js';
import { issueRunLocator, scopedDisplayRef } from './run-locator.js';
import { PostgresStudioTraceReadAdapter } from './trace-read-adapter.js';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const START = new Date(NOW - 60_000).toISOString();
const scope = { accountScopeId: 'account-context', environment: 'production' as const };
const archive = (id: string, runId = 'run-context', sessionId = 'session-context', extra = {}) => ({
  id, run_id: runId, session_id: sessionId, recorded_at: new Date(NOW - 10_000).toISOString(),
  user_message: '检查摄像头 token=synthetic-secret', assistant_message: '摄像头正常。',
  content_expired: false, ...extra,
});

async function read(options: {
  current?: Array<Record<string, unknown>>; history?: Array<Record<string, unknown>>;
  sessionId?: string; conflict?: boolean; failCurrent?: boolean; failHistory?: boolean; startedAt?: string | null;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const result = await readRunConversationContext({
    scope, runId: 'run-context', sessionId: options.sessionId ?? 'session-context',
    startedAt: options.startedAt === undefined ? START : options.startedAt, now: NOW,
    identifierConflict: options.conflict,
    db: { async query(sql, params = []) {
      calls.push({ sql, params });
      const history = sql.includes('c.recorded_at < $6');
      if (history ? options.failHistory : options.failCurrent) throw new Error('offline');
      return { rows: history ? options.history ?? [] : options.current ?? [] };
    } },
  });
  return { result, calls };
}

test('current turn uses scoped exact Run, while history uses exact session before admission', async () => {
  const { result, calls } = await read({ current: [archive('current')], history: [archive('prior', 'prior-run')] });
  assert.equal(result.binding, 'bound');
  assert.equal(result.sessionRef, scopedDisplayRef('session', scope.accountScopeId, scope.environment, 'session-context'));
  assert.equal(result.currentTurn.availability, 'available');
  if (result.currentTurn.availability !== 'available') throw new Error('missing turn');
  assert.equal(result.currentTurn.turn.runRef, result.runRef);
  assert.equal(result.currentTurn.turn.content.availability, 'available');
  assert.equal(result.history.turns.length, 1);
  assert.notEqual(result.history.turns[0].runRef, result.runRef);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /synthetic-secret|account-context|session-context|run-context/);
  assert.match(serialized, /REDACTED/);
  const current = calls.find(call => !call.sql.includes('c.recorded_at < $6'))!;
  const history = calls.find(call => call.sql.includes('c.recorded_at < $6'))!;
  assert.match(current.sql, /c.run_id = \$3/);
  assert.doesNotMatch(current.sql, /recorded_at\s+between|interval '.*minutes/);
  assert.match(history.sql, /c.session_id = \$4/);
  assert.equal(history.params[5], START);
  for (const call of calls) {
    assert.deepEqual(call.params.slice(0, 4), ['account-context', 'production', 'run-context', 'session-context']);
    assert.match(call.sql, /c.sso_user_id = \$1/);
    assert.match(call.sql, /c.environment = \$2/);
    assert.doesNotMatch(call.sql, /case when c.client_type|coalesce.*production/);
    // All bound parameter slots have an explicit use; no missing $4 in current lookup.
    const indices = new Set([...call.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
    assert.deepEqual([...indices].sort(), [1, 2, 3, 4, 5, 6]);
  }
});

test('a neighboring archive never substitutes for the exact current Run', async () => {
  const { result } = await read({ current: [], history: [archive('neighbor', 'neighbor-run')] });
  assert.deepEqual(result.currentTurn, { availability: 'missing' });
  assert.equal(result.history.availability, 'available');
});

test('unbound or conflicting session identities cause no archive queries or bodies', async () => {
  for (const options of [{ sessionId: '' }, { conflict: true }]) {
    const { result, calls } = await read({ ...options, current: [archive('private')], history: [archive('private-history')] });
    assert.equal(calls.length, 0);
    assert.equal(result.binding, options.conflict ? 'conflict' : 'unbound');
    assert.deepEqual(result.history.turns, []);
    assert.doesNotMatch(JSON.stringify(result), /摄像头/);
  }
});

test('duplicate current turns or a different session stop both current and prior body presentation', async () => {
  for (const current of [[archive('one'), archive('two')], [archive('one', 'run-context', 'session-other')]]) {
    const { result } = await read({ current, history: [archive('private-history')] });
    assert.equal(result.binding, 'conflict');
    assert.deepEqual(result.currentTurn, { availability: 'conflict' });
    assert.deepEqual(result.history.turns, []);
    assert.doesNotMatch(JSON.stringify(result), /摄像头/);
  }
});

test('archive read failures remain distinguishable from absent data', async () => {
  const { result } = await read({ failCurrent: true, failHistory: true });
  assert.equal(result.currentTurn.availability, 'unavailable');
  assert.equal(result.history.availability, 'unavailable');
  const missingTime = await read({ startedAt: null });
  assert.equal(missingTime.calls.length, 1);
});

test('expired archive bodies are withheld and metadata retention is relative to now', async () => {
  const { result, calls } = await read({
    startedAt: new Date(NOW - 34 * 24 * 60 * 60_000).toISOString(),
    current: [archive('current', 'run-context', 'session-context', { content_expired: true })],
    history: [archive('prior', 'prior-run', 'session-context', { content_expired: true })],
  });
  assert.equal(result.currentTurn.availability, 'expired');
  assert.deepEqual(result.history.turns[0].content, { availability: 'expired' });
  assert.doesNotMatch(JSON.stringify(result), /摄像头|synthetic-secret/);
  for (const call of calls) {
    assert.equal(call.params[4], new Date(NOW - 7 * 24 * 60 * 60_000).toISOString());
    assert.match(call.sql, /case when c.recorded_at > \$5::timestamptz then c.user_message else null/);
    assert.match(call.sql, /c.recorded_at > \$5::timestamptz - interval '28 days'/);
  }
});

test('deletion tombstones filter archive data without relying on already deleted spans', async () => {
  const { calls } = await read();
  for (const call of calls) {
    assert.match(call.sql, /studio_telemetry_tombstones t/);
    assert.match(call.sql, /t.account_scope_id = \$1 and t.environment = \$2/);
    assert.match(call.sql, /t.session_id = c.session_id/);
    assert.match(call.sql, /t.run_id = c.run_id/);
    assert.doesNotMatch(call.sql, /from public.studio_trace_spans/);
    assert.doesNotMatch(call.sql, /and t.trace_id is null/);
  }
});

test('prior context is bounded to eight chronological turns with stable scoped references', async () => {
  const history = Array.from({ length: 9 }, (_, index) => archive('turn-' + index, 'run-' + index));
  const { result } = await read({ history });
  assert.equal(result.history.turns.length, 8);
  assert.equal(result.history.truncated, true);
  const other = await readRunConversationContext({
    db: { async query() { return { rows: [archive('turn-7', 'run-7')] }; } },
    scope: { ...scope, accountScopeId: 'another-account' },
    runId: 'run-context', sessionId: 'session-context', startedAt: START, now: NOW,
  });
  assert.notEqual(result.history.turns[0].turnRef, other.history.turns[0].turnRef);
});

test('Run detail uses authoritative shared session references and suppresses disputed span content', async () => {
  for (const [sessionId, canonical] of [['session-context', true], ['session-other', true], ['local:studio:session-context', false]] as const) {
    let archiveQueries = 0;
    const service = createRunObservabilityService({
      now: () => NOW, protectedReadReady: () => true,
      db: { async query(sql) {
        if (sql.includes('from public.agent_run_records')) return { rows: [{ run_fact: {
          run_id: 'run-context', session_id: 'session-context', started_at: START,
          completed_at: new Date(NOW - 10_000).toISOString(), client_type: 'desktop', app_version: '1.4.4',
        } }] };
        if (sql.includes('from public.conversation_turns')) { archiveQueries++; return { rows: [] }; }
        return { rows: [] };
      } },
      traceAdapter: {
        async readByRun() { return { spanCount: 1, truncated: false, fragments: [{ traceId: 'a'.repeat(32), integrity: [], spans: [{
          traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), runId: 'run-context', sessionId,
          sourceSegment: 'moss', name: 'moss.session', kind: 'internal', startTimeUnixMs: NOW - 60_000,
          endTimeUnixMs: NOW - 10_000, outcome: 'ok', status: 'ok',
          attributes: { [canonical ? 'rdk.session.id' : 'moss.session.id']: sessionId },
          resource: { serviceName: 'moss', serviceInstanceId: 'instance', deploymentEnvironment: 'production',
            surface: 'desktop', studioVersion: '1.4.4', mossVersion: '1.0.0', mocVersion: '1.0.0' },
          sampling: { decision: 'retained', policyVersion: 'test' },
          content: { schema: 'rdk.studio.trace-content.v1', redacted: false, truncated: false,
            entries: [{ kind: 'user_input', text: '私有对话正文' }] },
        }] }] }; },
        async readByTrace() { return { spanCount: 0, truncated: false, fragments: [] }; },
      },
    });
    const locator = issueRunLocator({ ...scope, runId: 'run-context', now: NOW, ttlMs: 600_000 });
    const lookup = await service(locator, { kind: 'owner', accountScopeId: scope.accountScopeId });
    assert.equal(lookup.status, 'found');
    if (lookup.status !== 'found') throw new Error('not found');
    assert.equal(lookup.detail.run.sessionRef, scopedDisplayRef('session', scope.accountScopeId, scope.environment, 'session-context'));
    if (sessionId === 'session-other') {
      assert.equal(archiveQueries, 0);
      assert.equal(lookup.detail.conversationContext.binding, 'conflict');
      assert.deepEqual(lookup.detail.traces[0].spans[0].content, { availability: 'unavailable' });
      assert.ok(lookup.detail.coverage.reasonCodes.includes('identifier_conflict'));
      assert.doesNotMatch(JSON.stringify(lookup.detail), /私有对话正文/);
    } else {
      assert.equal(archiveQueries, 2);
      assert.equal(lookup.detail.conversationContext.binding, 'bound');
    }
  }
});

test('long canonical conversation IDs stay intact through database projection and Run detail binding', async () => {
  for (const length of [161, 200]) {
    const sessionId = 's'.repeat(length);
    const db = { async query(sql: string) {
      if (sql.includes('from public.agent_run_records')) return { rows: [{ run_fact: {
        run_id: 'run-context', session_id: sessionId, started_at: START,
        completed_at: new Date(NOW - 10_000).toISOString(), client_type: 'desktop', app_version: '1.4.4',
      } }] };
      if (sql.includes('from public.studio_trace_spans') && !sql.includes("coalesce(run_id, '') = ''")) return { rows: [{
        trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), run_id: 'run-context', session_id: sessionId,
        source: 'server', source_segment: 'moss', name: 'moss.session',
        start_time_ms: NOW - 60_000, end_time_ms: NOW - 10_000, status: 'ok',
        attributes: { 'rdk.session.id': sessionId, 'moss.session.id': 'internal-agent-key' },
        content: { schema: 'rdk.studio.trace-content.v1', redacted: false, truncated: false,
          entries: [{ kind: 'user_input', text: '完整标识对应的正文' }] },
        content_availability: 'available',
      }] };
      return { rows: [] };
    } };
    const read = await new PostgresStudioTraceReadAdapter(db).readByRun(scope, 'run-context');
    assert.equal(read.fragments[0].spans[0].attributes['rdk.session.id'], sessionId);
    const locator = issueRunLocator({ ...scope, runId: 'run-context', now: NOW, ttlMs: 600_000 });
    const lookup = await createRunObservabilityService({ db, now: () => NOW, protectedReadReady: () => true })(
      locator, { kind: 'owner', accountScopeId: scope.accountScopeId });
    assert.equal(lookup.status, 'found');
    if (lookup.status !== 'found') throw new Error('not found');
    assert.equal(lookup.detail.conversationContext.binding, 'bound');
    assert.equal(lookup.detail.traces[0].spans[0].content.availability, 'available');
    assert.ok(!lookup.detail.coverage.reasonCodes.includes('identifier_conflict'));
    assert.equal(lookup.detail.traces[0].spans[0].attributes['rdk.session.id'], undefined);
  }
});

test('persisted explicit session identity suppresses another conversation even without an rdk attribute', async () => {
  for (const attributes of [{}, { 'moss.session.id': 'local:studio:session-context' }]) {
    let archiveQueries = 0;
    const db = { async query(sql: string) {
      if (sql.includes('from public.agent_run_records')) return { rows: [{ run_fact: {
        run_id: 'run-context', session_id: 'session-context', started_at: START,
        completed_at: new Date(NOW - 10_000).toISOString(), client_type: 'desktop', app_version: '1.4.4',
      } }] };
      if (sql.includes('from public.conversation_turns')) { archiveQueries++; return { rows: [] }; }
      if (sql.includes('from public.studio_trace_spans') && !sql.includes("coalesce(run_id, '') = ''")) return { rows: [{
        trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), run_id: 'run-context',
        session_id: Object.keys(attributes).length ? null : 'session-other',
        source: 'server', source_segment: 'moss', name: 'moss.session',
        start_time_ms: NOW - 60_000, end_time_ms: NOW - 10_000, status: 'ok', attributes,
        content: { schema: 'rdk.studio.trace-content.v1', redacted: false, truncated: false,
          entries: [{ kind: 'user_input', text: '另一会话的正文' }] }, content_availability: 'available',
      }] };
      return { rows: [] };
    } };
    const locator = issueRunLocator({ ...scope, runId: 'run-context', now: NOW, ttlMs: 600_000 });
    const lookup = await createRunObservabilityService({ db, now: () => NOW, protectedReadReady: () => true })(
      locator, { kind: 'owner', accountScopeId: scope.accountScopeId });
    assert.equal(lookup.status, 'found');
    if (lookup.status !== 'found') throw new Error('not found');
    if (Object.keys(attributes).length) {
      assert.equal(archiveQueries, 2);
      assert.equal(lookup.detail.conversationContext.binding, 'bound');
      assert.equal(lookup.detail.traces[0].spans[0].content.availability, 'available');
    } else {
      assert.equal(archiveQueries, 0);
      assert.equal(lookup.detail.conversationContext.binding, 'conflict');
      assert.equal(lookup.detail.traces[0].spans[0].content.availability, 'unavailable');
      assert.ok(lookup.detail.coverage.reasonCodes.includes('identifier_conflict'));
      assert.doesNotMatch(JSON.stringify(lookup.detail), /另一会话的正文/);
    }
  }
});
