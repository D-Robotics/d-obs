import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunTraceList } from './run-trace-list-store.js';

const RUN_ID = 'c6554a38-3889-4212-bbb3-0ca2c6467f82';

function makePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
  return {
    calls,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes('with candidates as')) {
          return {
            rows: [
              {
                account_scope_id: 'account-a',
                run_id: RUN_ID,
                run_environment: 'production',
                started_at: startedAt,
                completed_at: startedAt,
                outcome: 'completed',
                elapsed_ms: 1_200,
                first_text_ms: 200,
                retry_count: 0,
                tool_call_count: 1,
                tool_sequence: ['device.query'],
                prompt_tokens: 10,
                completion_tokens: 20,
                model: 'test-model',
                client_type: 'web-cloud',
                app_version: '1.5.0',
                tie_breaker: '9:account-a:36:' + RUN_ID,
                sort_time_ms: Date.parse(startedAt),
              },
            ],
          };
        }
        if (sql.includes('studio_trace_spans')) {
          return {
            rows: [
              {
                account_scope_id: 'account-a',
                run_id: RUN_ID,
                span_count: 6,
                trace_count: 2,
                client_span_count: 1,
                server_span_count: 3,
                client_duration_ms: 84,
                has_client: true,
                has_studio_transport: true,
                has_moss_root: true,
                has_moss_children: true,
                trace_surface: 'web-cloud',
                studio_version: '1.5.0',
                moss_version: '1.2.0',
                moc_version: '1.1.0',
              },
            ],
          };
        }
        if (sql.includes('agent_run_observability')) {
          return { rows: [{ account_scope_id: 'account-a', run_id: RUN_ID }] };
        }
        throw new Error('unexpected query');
      },
    },
  };
}

test('run list projects persisted spans and summaries into coverage', async () => {
  const fixture = makePool();
  const page = await getRunTraceList({
    hours: 24,
    environment: 'production',
    limit: 40,
    runId: RUN_ID,
    pool: fixture.pool,
  });
  assert.equal(page.runTraces.length, 1);
  const row = page.runTraces[0];
  assert.equal(row.coverage.state, 'complete');
  assert.equal(row.coverage.spanCount, 6);
  assert.equal(row.traceCount, 2);
  assert.deepEqual(row.coverage.observedSegments, [
    'client',
    'studio_transport',
    'moss_root',
    'terminal',
    'moss_children',
  ]);
  assert.equal(row.clientSpanCount, 1);
  assert.equal(row.clientDurationMs, 84);
  assert.equal(row.evidence.runSummary, true);
  assert.equal(row.producer.mocVersion, '1.1.0');
  assert.ok(!JSON.stringify(row).includes(RUN_ID), 'raw run id must not be returned');
  const candidate = fixture.calls.find((call) => call.sql.includes('with candidates as'));
  assert.equal(candidate?.params.at(-1), RUN_ID);
});

test('unsafe run id lookup is ignored while preserving opaque list output', async () => {
  const fixture = makePool();
  const page = await getRunTraceList({
    hours: 24,
    environment: 'production',
    pool: fixture.pool,
    runId: '<raw-id>',
  });
  assert.equal(page.runTraces.length, 1);
  const candidate = fixture.calls.find((call) => call.sql.includes('with candidates as'));
  assert.equal(candidate?.params.at(-1), null);
  assert.ok(!JSON.stringify(page).includes(RUN_ID));
});
