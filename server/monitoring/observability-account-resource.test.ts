import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccountActivity, getAccountEventLog } from './observability-account-activity.js';

// Store-only fixtures: no authentication/session adapter, credentials or real DB.
const observedName = 'fixture-observed-username';
const existingId = 'fixture-existing-account-id';
function fixturePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      assert.match(sql.trim(), /^select\b/i, 'Account inspection must remain read-only');
      if (sql.includes('where sso_user_name = $1::text')) {
        return { rows: params[0] === observedName ? [{ sso_user_id: existingId }] : [] };
      }
      const ids = Array.isArray(params[0]) ? params[0] as string[] : [];
      if (!ids.includes(existingId)) return { rows: [] };
      if (sql.includes('from public.credit_account')) return { rows: [{ created_at: '2026-01-01T00:00:00Z', source: 'fixture' }] };
      if (sql.includes('from public.agent_run_records') && sql.includes('count(*)::int total')) return { rows: [{ total: 2, errors: 0, total_tokens: 50, last_started_at: '2026-01-02T00:00:00Z' }] };
      if (sql.includes('from public.conversation_turns') && sql.includes('count(*)::int total')) return { rows: [{ total: 3, errors: 0, last_recorded_at: '2026-01-02T00:00:00Z' }] };
      if (sql.includes('from public.studio_daily_usage')) return { rows: [{ active_days: 1, first_day: '2026-01-02', last_day: '2026-01-02' }] };
      if (sql.includes('select session_id, max(at)')) return { rows: [{ session_id: 'fixture-account-session' }] };
      if (sql.includes('group by event_code')) return { rows: [{ event_code: 'fixture.event', total: 1 }] };
      if (sql.includes('from public.studio_ops_events')) return { rows: [{ event_code: 'fixture.event', occurred_at: '2026-01-02T00:00:00Z', outcome: 'ok', safe_summary: 'fixture metadata only' }] };
      return { rows: [] };
    },
  };
}

test('observed usernames resolve through the existing conversation account index using bound parameters', async () => {
  const pool = fixturePool();
  const report = await getAccountActivity(pool, observedName, 168);
  assert.deepEqual(report.resolvedIds, [observedName, existingId]);
  assert.ok(report.registeredAt);
  assert.equal(report.runs.total, 2);
  assert.equal(report.turns.total, 3);
  assert.equal(report.sourceAvailability.accountResolution.status, 'ok');
  assert.equal(report.dataCompleteness, 'complete');
  assert.deepEqual(pool.calls[0].params, [observedName]);
  assert.match(pool.calls[0].sql, /from public\.conversation_turns[\s\S]*where sso_user_name = \$1::text/);
  assert.ok(pool.calls.some((call) => Array.isArray(call.params[0]) && call.params[0].includes(existingId)));
  assert.equal(pool.calls.some((call) => call.sql.includes(observedName) || call.sql.includes(existingId)), false);
});

test('an opaque display reference or unknown identifier can return an empty report without proving an account exists', async () => {
  for (const identifier of ['user:fixture-opaque-ref', 'fixture-unknown-identifier']) {
    const report = await getAccountActivity(fixturePool(), identifier, 168);
    assert.deepEqual(report.resolvedIds, [identifier], 'The input is always retained even when not resolved');
    assert.equal(report.registeredAt, null);
    assert.equal(report.runs.total, 0);
    assert.equal(report.turns.total, 0);
    assert.equal(report.usage.activeDays, 0);
    assert.deepEqual(report.opsEvents, []);
  }
});

test('missing source tables fail soft, so an empty HTTP-shaped report is not source-availability proof', async () => {
  let calls = 0;
  const report = await getAccountActivity({ async query(sql: string) {
    calls++;
    assert.match(sql.trim(), /^select\b/i);
    throw Object.assign(new Error('fixture missing table'), { code: '42P01' });
  } }, observedName, 168);
  assert.ok(calls > 5);
  assert.deepEqual(report.resolvedIds, [observedName]);
  assert.equal(report.registeredAt, null);
  assert.equal(report.runs.total, 0);
  assert.equal(report.turns.total, 0);
  assert.equal(report.dataCompleteness, 'partial');
  assert.equal(report.sourceAvailability.runs.status, 'unavailable');
  assert.deepEqual(report.sourceAvailability.runs.errorCodes, ['42P01']);
  assert.match(report.warnings.join(' '), /不能解释为没有活动/);
});

test('account event drilldown resolves the same real account mapping and uses bounded session correlation', async () => {
  const pool = fixturePool();
  const log = await getAccountEventLog(pool, observedName, 24, { limit: 1000, eventCode: 'fixture.event' });
  assert.deepEqual(log.resolvedIds, [observedName, existingId]);
  assert.equal(log.events.length, 1);
  const last = pool.calls.at(-1)!;
  assert.match(last.sql, /event_code = \$5/);
  assert.deepEqual(last.params, [[observedName, existingId], log.timeWindow.from, log.timeWindow.to, ['fixture-account-session'], 'fixture.event', 200]);
  assert.equal(Date.parse(log.timeWindow.to) - Date.parse(log.timeWindow.from), 24 * 3_600_000);
  assert.equal(log.sourceAvailability.events.status, 'ok');
  assert.equal(log.dataCompleteness, 'complete');
  assert.doesNotMatch(last.sql, /select[\s\S]*(?:user_message|assistant_message)/i);
});
