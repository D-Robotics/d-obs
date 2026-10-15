import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunTraceList } from './run-trace-list-store.js';
import { projectSessionTracePage } from './session-trace-list-store.js';

const RUN_ID = 'c6554a38-3889-4212-bbb3-0ca2c6467f82';
const TRACE_ID = 'a'.repeat(32);
const spanId = (index: number) => index.toString(16).padStart(16, '0');
const topology = (count = 6) => Array.from({ length: count }, (_, index) => ({
  traceId: TRACE_ID, spanId: spanId(index + 1), parentSpanId: index ? spanId(index) : null,
}));

function makePool(coverageOverrides: Record<string, unknown> = {}) {
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
                session_id: 'raw-session-a',
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
                trace_count: 1,
                span_topology: topology(),
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
                ...coverageOverrides,
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
  assert.equal(row.traceCount, 1);
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
  const aggregate = fixture.calls.find((call) => call.sql.includes('visible_spans as'));
  assert.match(aggregate?.sql ?? '', /filter \(where s\.topology_index <= 512\)/);
  assert.match(aggregate?.sql ?? '', /tombstone\.session_id = s\.session_id/);
  assert.ok(!JSON.stringify(row).includes(TRACE_ID), 'raw topology identifiers must not be returned');
  assert.equal(fixture.calls.length, 3, 'topology checks must remain batched without per-run reads');
});

for (const { name, reason, overrides } of [
  { name: 'missing parent', reason: 'invalid_parent', overrides: {
    span_topology: topology().map((edge, index) => index ? edge : { ...edge, parentSpanId: 'f'.repeat(16) }),
  } },
  { name: 'self parent', reason: 'topology_cycle', overrides: {
    span_topology: topology().map((edge, index) => index ? edge : { ...edge, parentSpanId: edge.spanId }),
  } },
  { name: 'two-node cycle', reason: 'topology_cycle', overrides: {
    span_topology: topology().map((edge, index) => index ? edge : { ...edge, parentSpanId: spanId(2) }),
  } },
  { name: 'duplicate span identity', reason: 'duplicate_identity', overrides: {
    span_topology: topology().map((edge, index) => index === 5 ? { ...edge, spanId: spanId(1) } : edge),
  } },
  { name: 'multiple trace fragments', reason: 'multiple_fragments', overrides: {
    trace_count: 2,
    span_topology: topology().map((edge, index) => index === 5 ? { ...edge, traceId: 'b'.repeat(32), parentSpanId: null } : edge),
  } },
]) {
  test(`run and session lists refuse complete coverage for ${name}`, async () => {
    const fixture = makePool(overrides);
    const page = await getRunTraceList({ hours: 24, pool: fixture.pool });
    const row = page.runTraces[0];
    assert.equal(row.coverage.state, 'partial');
    assert.deepEqual(row.coverage.missingSegments, [], 'all segment types are present; the graph is the failure');
    assert.ok(row.coverage.reasonCodes.some((code) => code === reason));
    assert.equal(projectSessionTracePage(page).sessions[0].completeRunCount, 0);
    const serialized = JSON.stringify(page);
    for (const raw of [TRACE_ID, spanId(1), RUN_ID, 'raw-session-a']) {
      assert.equal(serialized.includes(raw), false, 'topology checks must preserve opaque identities');
    }
    assert.equal(fixture.calls.length, 3);
  });
}

test('combined fragments and self-parent retain both structural reasons instead of complete coverage', async () => {
  const fixture = makePool({ trace_count: 2,
    span_topology: topology().map((edge, index) => index === 0
      ? { ...edge, parentSpanId: edge.spanId }
      : index === 5 ? { ...edge, traceId: 'b'.repeat(32), parentSpanId: null } : edge),
  });
  const page = await getRunTraceList({ hours: 24, pool: fixture.pool });
  assert.equal(page.runTraces[0].coverage.state, 'partial');
  assert.deepEqual(page.runTraces[0].coverage.reasonCodes, ['multiple_fragments', 'topology_cycle']);
  assert.equal(projectSessionTracePage(page).sessions[0].completeRunCount, 0);
});

test('bounded topology samples cannot prove complete coverage beyond 512 spans', async () => {
  const fixture = makePool({ span_count: 513,
    span_topology: topology(512).map((edge, index) => index ? edge : { ...edge, parentSpanId: spanId(513) }),
  });
  const page = await getRunTraceList({ hours: 24, pool: fixture.pool });
  assert.equal(page.runTraces[0].coverage.state, 'partial');
  assert.equal(page.runTraces[0].coverage.truncated, true);
  assert.deepEqual(page.runTraces[0].coverage.reasonCodes, []);
  assert.equal(projectSessionTracePage(page).sessions[0].completeRunCount, 0);
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
