import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueRunLocator } from './run-locator.js';
import { createRunObservabilityService } from './run-observability-service.js';

const START = Date.parse('2026-10-08T08:28:26.000Z');
const END = Date.parse('2026-10-08T08:28:42.000Z');

function fakeDb(candidateRows: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('from public.agent_run_records')) {
        return {
          rows: [
            {
              run_fact: {
                run_id: 'run-test',
                outcome: 'success',
                started_at: new Date(START).toISOString(),
                completed_at: new Date(END).toISOString(),
                elapsed_ms: 16_000,
                client_type: 'desktop',
                app_version: '1.4.4',
              },
            },
          ],
        };
      }
      if (sql.includes('from public.studio_trace_spans')) {
        assert.ok(sql.includes("coalesce(run_id, '') = ''"), '候选查询必须限定未绑定 span');
        assert.ok(sql.includes('studio_telemetry_tombstones'), '候选查询必须带治理过滤');
        return { rows: candidateRows };
      }
      return { rows: [] };
    },
  };
}

const emptyTraceAdapter = {
  readByRun: async () => ({ fragments: [], spanCount: 0, truncated: false }),
  readByTrace: async () => ({ fragments: [], spanCount: 0, truncated: false }),
};

function buildService(db: ReturnType<typeof fakeDb>) {
  return createRunObservabilityService({
    db: db as unknown as Parameters<typeof createRunObservabilityService>[0]['db'],
    traceAdapter: emptyTraceAdapter,
    now: () => Date.parse('2026-10-08T09:00:00.000Z'),
    protectedReadReady: () => true,
  });
}

test('run-start 绑定失败的 client span 以软关联候选展示，不进入权威链路', async () => {
  const db = fakeDb([
    {
      span_id: 'b112049a694a44b1',
      trace_id: '756451c3fbaca2a10a9ac7d42b6de671',
      name: 'studio.agent_chat',
      service_name: 'rdk-studio-client',
      start_time_ms: String(START - 1_000),
      end_time_ms: String(END + 1_000),
      outcome: 'ok',
      client_operation_id: 'op-104e10ab0537852292b2a4e9ac6c5ed6',
      attributes: { 'rdk.propagation.reason': 'invalid_run_start' },
    },
  ]);
  const locator = issueRunLocator({
    accountScopeId: 'lx199710',
    environment: 'production',
    runId: 'run-test',
    now: Date.parse('2026-10-08T08:50:00.000Z'),
    ttlMs: 30 * 60_000,
  });
  assert.ok(locator, 'locator 签发失败');
  const result = await buildService(db)(locator, { kind: 'owner', accountScopeId: 'lx199710' });
  assert.equal(result.status, 'found');
  if (result.status !== 'found') return;
  const detail = result.detail;
  assert.equal(detail.traces.length, 0, '未绑定 span 不得进入权威瀑布');
  assert.equal(detail.unboundCandidates.basis, 'owner_and_time_window');
  assert.equal(detail.unboundCandidates.spans.length, 1);
  const span = detail.unboundCandidates.spans[0]!;
  assert.equal(span.name, 'studio.agent_chat');
  assert.equal(span.serviceName, 'rdk-studio-client');
  assert.equal(span.propagationReason, 'invalid_run_start');
  assert.equal(span.startOffsetMs, -1_000);
  assert.equal(span.durationMs, END + 1_000 - (START - 1_000));
  assert.equal(span.clientOperationId, 'op-104e10ab0537852292b2a4e9ac6c5ed6');
  assert.match(span.spanRef, /^span-/);
  assert.match(span.traceRef ?? '', /^trace-/);
});

test('时间窗外或已绑定 run 的 span 不作为候选；无窗口时不发候选查询', async () => {
  const outside = Date.parse('2026-10-07T08:28:26.000Z');
  const db = fakeDb([
    {
      span_id: 'aaaaaaaaaaaaaaaa',
      trace_id: '756451c3fbaca2a10a9ac7d42b6de671',
      name: 'studio.agent_chat',
      service_name: 'rdk-studio-client',
      start_time_ms: String(outside),
      end_time_ms: String(outside + 1_000),
      outcome: 'ok',
      client_operation_id: 'op-outside',
      attributes: {},
    },
  ]);
  const locator = issueRunLocator({
    accountScopeId: 'lx199710',
    environment: 'production',
    runId: 'run-test',
    now: Date.parse('2026-10-08T08:50:00.000Z'),
    ttlMs: 30 * 60_000,
  });
  const result = await buildService(db)(locator, { kind: 'owner', accountScopeId: 'lx199710' });
  if (result.status !== 'found') throw new Error('expected found');
  assert.ok(
    db.calls.some((sql) => sql.includes('from public.studio_trace_spans')),
    '有起止时间时应发起候选查询',
  );
  assert.equal(result.detail.unboundCandidates.spans.length, 1, '过滤发生在 SQL 侧，行数即返回数');
});

test('run 缺起止时间时跳过候选查询且 payload 仍完整', async () => {
  const db = fakeDb([]);
  db.query = async (sql: string) => {
    db.calls.push(sql);
    if (sql.includes('from public.agent_run_records')) {
      return {
        rows: [
          {
            run_fact: { run_id: 'run-test', outcome: 'success', client_type: 'desktop' },
          },
        ],
      };
    }
    return { rows: [] };
  };
  const locator = issueRunLocator({
    accountScopeId: 'lx199710',
    environment: 'production',
    runId: 'run-test',
    now: Date.parse('2026-10-08T08:50:00.000Z'),
    ttlMs: 30 * 60_000,
  });
  const result = await buildService(db)(locator, { kind: 'owner', accountScopeId: 'lx199710' });
  if (result.status !== 'found') throw new Error('expected found');
  assert.equal(result.detail.unboundCandidates.basis, 'owner_and_time_window');
  assert.equal(result.detail.unboundCandidates.spans.length, 0);
  assert.equal(
    db.calls.some((sql) => sql.includes('from public.studio_trace_spans')),
    false,
    '无时间窗不得发起候选查询',
  );
});
