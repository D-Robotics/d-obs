/**
 * 值班升级链回归测试：候选 SQL 语义（open / 未 ack / 通知超时 / 升级间隔 /
 * 次数上限）、候选摘要文案、超时环境变量钳制、ackTimeoutMinutes 回显。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ackTimeoutMinutes,
  collectEscalationCandidates,
  DEFAULT_ACK_TIMEOUT_MINUTES,
  MAX_ESCALATIONS_PER_INCIDENT,
} from './alert-escalation.js';

/**
 * 假池：模拟 incidents 表的 UPDATE...RETURNING 语义。
 * 行内字段由测试用例直接构造，池只执行 SQL where 里的谓词判定。
 */
function fakePool(rows: Array<Record<string, unknown>>) {
  const state = rows.map((row) => ({ ...row }));
  const captured: { sql: string; params: unknown[] }[] = [];
  return {
    captured,
    state,
    query: async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      captured.push({ sql, params: params ?? [] });
      if (sql.startsWith('alter table')) return { rows: [] };
      if (sql.startsWith('update public.studio_alert_incidents')) {
        const maxEscalations = Number(params?.[0]);
        const ackTimeout = Number(params?.[1]);
        const now = Date.now();
        const matched = state.filter((row) => {
          if (row.status !== 'open') return false;
          if (row.acknowledged_at != null) return false;
          if (Number(row.escalation_count ?? 0) >= maxEscalations) return false;
          const lastNotified = row.last_notified_at ? (row.last_notified_at as Date).getTime() : null;
          if (lastNotified === null) return false;
          if (now - lastNotified < ackTimeout * 60_000) return false;
          const lastEscalated = row.last_escalated_at
            ? (row.last_escalated_at as Date).getTime()
            : null;
          if (lastEscalated !== null && now - lastEscalated < ackTimeout * 60_000) return false;
          return true;
        });
        matched.forEach((row) => {
          row.escalation_count = Number(row.escalation_count ?? 0) + 1;
          row.last_escalated_at = new Date(now);
        });
        return {
          rows: matched.map((row) => ({
            alert_key: row.alert_key,
            title: row.title,
            severity: row.severity,
            summary: row.summary,
            first_seen_at: row.first_seen_at,
            escalation_count: row.escalation_count,
          })),
          rowCount: matched.length,
        };
      }
      throw new Error('unexpected_sql: ' + sql.slice(0, 60));
    },
  };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

function incident(overrides: Record<string, unknown> = {}) {
  return {
    alert_key: 'disk-space',
    title: '磁盘使用率过高',
    severity: 'warning',
    summary: '磁盘使用率 91%',
    first_seen_at: minutesAgo(120),
    status: 'open',
    acknowledged_at: null,
    escalation_count: 0,
    last_escalated_at: null,
    last_notified_at: minutesAgo(30),
    ...overrides,
  };
}

test('升级候选：已通知超时未 ack 的 open 事故被选中并推进计数', async () => {
  const p = fakePool([incident()]);
  const candidates = await collectEscalationCandidates(p, { ackTimeoutMinutes: 15 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].alertKey, 'disk-space');
  assert.equal(candidates[0].escalatedCount, 1);
  assert.equal(candidates[0].severity, 'warning');
  assert.match(candidates[0].summary, /第 1 次升级/);
  assert.match(candidates[0].summary, /15 分钟无人确认/);
  assert.equal(p.state[0].escalation_count, 1);
});

test('不升级：已确认、已恢复、通知未超时、升级间隔未到、超过次数上限', async () => {
  const p = fakePool([
    incident({ alert_key: 'a-acked', acknowledged_at: minutesAgo(5) }),
    incident({ alert_key: 'a-resolved', status: 'resolved' }),
    incident({ alert_key: 'a-fresh', last_notified_at: minutesAgo(5) }),
    incident({ alert_key: 'a-cooling', last_escalated_at: minutesAgo(5), last_notified_at: minutesAgo(40) }),
    incident({ alert_key: 'a-maxed', escalation_count: 3, last_notified_at: minutesAgo(90) }),
    incident({ alert_key: 'a-unnotified', last_notified_at: null }),
  ]);
  const candidates = await collectEscalationCandidates(p, { ackTimeoutMinutes: 15 });
  assert.equal(candidates.length, 0);
  // a-maxed 起始就是 3（上限已满），不是本轮递增的。
  assert.deepEqual(
    p.state.map((row) => [row.alert_key, Number(row.escalation_count)]),
    [
      ['a-acked', 0],
      ['a-resolved', 0],
      ['a-fresh', 0],
      ['a-cooling', 0],
      ['a-maxed', 3],
      ['a-unnotified', 0],
    ],
  );
});

test('升级间隔独立于 ack 超时：第二次升级也要再等一个完整窗口', async () => {
  const row = incident({
    alert_key: 'a-twice',
    escalation_count: 1,
    last_escalated_at: minutesAgo(20),
    last_notified_at: minutesAgo(40),
  });
  const p = fakePool([row]);
  const first = await collectEscalationCandidates(p, { ackTimeoutMinutes: 15 });
  assert.equal(first.length, 1);
  assert.equal(first[0].escalatedCount, 2);
  assert.match(first[0].summary, /第 2 次升级/);
});

test('SQL 形状：上限与超时作为参数注入，不拼接进语句文本', async () => {
  const p = fakePool([]);
  await collectEscalationCandidates(p, { ackTimeoutMinutes: 20, maxEscalations: 2 });
  const update = p.captured.find((entry) => entry.sql.startsWith('update'));
  assert.ok(update, 'UPDATE...RETURNING was issued');
  assert.deepEqual(update.params, [2, 20]);
});

test('默认与环境变量：ackTimeoutMinutes 钳制在 5..720 分钟', () => {
  assert.equal(ackTimeoutMinutes(), DEFAULT_ACK_TIMEOUT_MINUTES);
  assert.equal(DEFAULT_ACK_TIMEOUT_MINUTES, 15);
  assert.ok(MAX_ESCALATIONS_PER_INCIDENT >= 1);
  const original = process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES;
  try {
    process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES = '2';
    assert.equal(ackTimeoutMinutes(), 5);
    process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES = '9999';
    assert.equal(ackTimeoutMinutes(), 720);
    process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES = '45';
    assert.equal(ackTimeoutMinutes(), 45);
    process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES = 'not-a-number';
    assert.equal(ackTimeoutMinutes(), DEFAULT_ACK_TIMEOUT_MINUTES);
  } finally {
    if (original === undefined) delete process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES;
    else process.env.RDK_ALERT_ACK_TIMEOUT_MINUTES = original;
  }
});
