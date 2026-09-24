/** ops 事件镜像回归：severity 映射、归属回退、游标推进、空摘要过滤。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eventToLogRecord,
  mirrorOpsEventsToLogs,
  type MirrorableOpsEventRow,
} from './ops-event-log-mirror.js';
import type { NormalizedLogRecord } from '../observability/ai-ecosystem-logs-store.js';

const baseRow: MirrorableOpsEventRow = {
  occurred_at: '2026-09-24T10:00:00Z',
  component: 'agent-tool',
  event_code: 'tool_call',
  outcome: 'error',
  severity_hint: 'warning',
  safe_summary: 'tool web_search failed: upstream timeout',
  tenant_id: 'platform',
};

test('事件映射：error → ERROR/17，service 固定 rdstudio-web-opt，结构化属性齐备', () => {
  const record = eventToLogRecord(baseRow)!;
  assert.equal(record.service, 'rdstudio-web-opt');
  assert.equal(record.severityText, 'ERROR');
  assert.equal(record.severityNumber, 17);
  assert.equal(record.body, 'tool web_search failed: upstream timeout');
  assert.equal(record.attributes['event.code'], 'tool_call');
  assert.equal(record.attributes['event.component'], 'agent-tool');
  assert.equal(record.attributes['event.tenant'], 'platform');
  assert.equal(record.timestampMs, Date.parse('2026-09-24T10:00:00Z'));
});

test('事件映射：critical 副档提升 ERROR，warning → WARN，空摘要丢弃，超长截断', () => {
  const critical = eventToLogRecord({ ...baseRow, severity_hint: 'critical', outcome: 'ok' })!;
  assert.equal(critical.severityNumber, 17);
  const warn = eventToLogRecord({ ...baseRow, outcome: 'ok', severity_hint: 'warning' })!;
  assert.equal(warn.severityText, 'WARN');
  const empty = eventToLogRecord({ ...baseRow, safe_summary: '   ' });
  assert.equal(empty, null);
  const long = eventToLogRecord({ ...baseRow, safe_summary: 'x'.repeat(1500) })!;
  assert.equal(long.body.length, 1000);
});

test('mirror：按游标拉取、写入 owner 取自注册表、游标推进到末行 created_at', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const fakePool = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (/studio_obs_ingest_tokens/.test(text)) {
        return { rows: [{ owner: 'e2e-owner-rdkstudio' }] };
      }
      return {
        rows: [
          { ...baseRow, created_at: '2026-09-24T10:00:01Z' },
          { ...baseRow, created_at: '2026-09-24T10:00:02Z' },
        ],
      };
    },
  };
  const inserted: Array<{ owner: string; records: NormalizedLogRecord[] }> = [];
  const result = await mirrorOpsEventsToLogs(fakePool, '2026-09-24T09:00:00Z', async (owner, records) => {
    inserted.push({ owner, records });
    return records.length;
  });
  assert.equal(result.mirrored, 2);
  assert.equal(result.nextCursor, '2026-09-24T10:00:02Z');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.owner, 'e2e-owner-rdkstudio');
  assert.equal(inserted[0]!.records.length, 2);
  const select = queries.find((q) => /studio_ops_events/.test(q.text))!;
  assert.deepEqual(select.params[0], [
    'tool_call',
    'client_error',
    'console_error',
    'dependency_unavailable',
    'process_unhandled_error',
    'policy_refresh_failed',
  ]);
  assert.equal(select.params[1], '2026-09-24T09:00:00Z');
});

test('mirror：无新增事件时游标保持不变且不写库；注册表缺失回退平台归属', async () => {
  const fakePool = {
    query: async (text: string) => {
      if (/studio_obs_ingest_tokens/.test(text)) throw new Error('registry missing');
      return { rows: [] };
    },
  };
  const inserted: unknown[] = [];
  const result = await mirrorOpsEventsToLogs(fakePool, '2026-09-24T09:00:00Z', async (owner) => {
    inserted.push(owner);
    return 0;
  });
  assert.equal(result.mirrored, 0);
  assert.equal(result.nextCursor, '2026-09-24T09:00:00Z');
  assert.equal(inserted.length, 0);
});
