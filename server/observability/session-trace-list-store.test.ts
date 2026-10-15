import assert from 'node:assert/strict';
import test from 'node:test';
import { getRunTraceList, type RunTraceListPage } from './run-trace-list-store.js';
import { projectSessionTracePage } from './session-trace-list-store.js';

test('sessions keep accounts separate, omit unassigned runs, and retain only opaque identities', async () => {
  const now = Date.now() - 1_000;
  const rows = [
    { account_scope_id: 'account-a', run_id: 'private-run-identity-a', session_id: 'same-session' },
    { account_scope_id: 'account-b', run_id: 'private-run-identity-b', session_id: 'same-session' },
    { account_scope_id: 'account-a', run_id: 'private-run-identity-c', session_id: null },
  ].map((identity, index) => ({ ...identity,
    run_environment: 'production', started_at: new Date(now - index * 1000),
    created_at: new Date(now), sort_time_ms: now - index * 1000,
    tie_breaker: identity.run_id, outcome: 'completed', app_version: '1.4.4',
  }));
  const pool = { async query(sql: string) {
    if (sql.includes('with candidates as')) {
      assert.match(sql, /studio_telemetry_tombstones/);
      return { rows };
    }
    return { rows: [] };
  } };
  const runs = await getRunTraceList({ hours: 24, pool });
  const result = projectSessionTracePage(runs);
  assert.equal(result.sessions.length, 2);
  assert.notEqual(result.sessions[0].sessionRef, result.sessions[1].sessionRef);
  assert.equal(result.unassignedRunCount, 1);
  assert.equal(result.sessions[0].runs[0].locator.startsWith('v1.'), true);
  for (const session of result.sessions) {
    for (const run of session.runs) assert.match(run.runRef, /^run-[0-9a-f]{16}$/);
  }
  const serialized = JSON.stringify(result);
  for (const raw of ['account-a', 'account-b', 'same-session', 'private-run-identity-a', 'private-run-identity-b', 'private-run-identity-c']) {
    assert.equal(serialized.includes(raw), false);
  }
});

test('session aggregates are bounded page samples and duplicates never inflate counts', async () => {
  const page = await getRunTraceList({ hours: 24, pool: { async query(sql: string) {
    return { rows: sql.includes('with candidates as') ? [{
      account_scope_id: 'a', run_id: 'one', session_id: 'session',
      run_environment: 'production', started_at: new Date(),
      outcome: 'failed', sort_time_ms: Date.now(), tie_breaker: 'one',
    }] : [] };
  } } });
  const one = page.runTraces[0];
  one.coverage.spanCount = 7;
  one.coverage.state = 'partial';
  const two = { ...one, runRef: 'run-second', outcome: 'completed',
    coverage: { ...one.coverage, state: 'complete' as const, spanCount: 11 },
    startedAt: '2026-10-01T00:00:00.000Z' };
  const result = projectSessionTracePage({ ...page,
    runTraces: [one, one, two],
    runTracePage: { ...page.runTracePage, nextCursor: 'opaque-next-page' },
  } as RunTraceListPage);
  assert.equal(result.sessions[0].runCount, 2);
  assert.equal(result.sessions[0].spanCount, 18);
  assert.equal(result.sessions[0].completeRunCount, 1);
  assert.equal(result.sessions[0].errorCount, 1);
  assert.equal(result.sessions[0].startedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(result.page.nextCursor, 'opaque-next-page');
});
