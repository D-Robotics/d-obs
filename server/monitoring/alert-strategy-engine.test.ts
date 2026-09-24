/**
 * 自定义策略引擎回归：比较符语义（NaN/±Inf 按 0）、事故键命名空间（租户
 * 前缀推导）、评估状态机的首触时间戳/持续时长/恢复/重复通知节流。
 *
 * 评估循环的 PromQL 数据源用全局 fetch 替换注入（与 tenant-member-access
 * 的中继注入同款思路）；数据库用按 SQL 语境分发的假池。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  strategyComparatorHolds,
  strategyIncidentKey,
  evaluateStrategies,
} from './alert-strategy-engine.js';
import { configureStrategyPoolForTest } from './alert-strategy-store.js';

let savedFetch: typeof fetch;
let savedEnv: string | undefined;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedEnv = process.env.RDK_PROMETHEUS_QUERY_URL;
  process.env.RDK_PROMETHEUS_QUERY_URL = 'http://prom.test';
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = savedFetch;
  if (savedEnv === undefined) delete process.env.RDK_PROMETHEUS_QUERY_URL;
  else process.env.RDK_PROMETHEUS_QUERY_URL = savedEnv;
  configureStrategyPoolForTest(null);
});

test('比较符：六种运算与 NaN/±Inf 按 0', () => {
  assert.equal(strategyComparatorHolds('gt', 5, 1), true);
  assert.equal(strategyComparatorHolds('gt', 1, 1), false);
  assert.equal(strategyComparatorHolds('gte', 1, 1), true);
  assert.equal(strategyComparatorHolds('lt', 0, 1), true);
  assert.equal(strategyComparatorHolds('lte', 1, 1), true);
  assert.equal(strategyComparatorHolds('eq', 1, 1), true);
  assert.equal(strategyComparatorHolds('ne', 2, 1), true);
  // NaN/Infinity 按 0：0 > -1 命中；0 > 1 不命中。
  assert.equal(strategyComparatorHolds('gt', Number.NaN, -1), true);
  assert.equal(strategyComparatorHolds('gt', Number.POSITIVE_INFINITY, 1), false);
});

test('事故键命名空间：platform 裸键、租户 t. 前缀', () => {
  assert.equal(strategyIncidentKey('ab123', 'platform', 'deadbeef'), 'strat-ab123-deadbeef');
  assert.equal(
    strategyIncidentKey('ab123', 'sim2real', 'deadbeef'),
    't.sim2real.strat-ab123-deadbeef',
  );
});

type Row = Record<string, unknown>;
type FakePool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
};

/** 假池：内存策略/规则行/状态表 + 事故表，SQL 语境分发。 */
function fakeStrategyDb(input: {
  strategies: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
}): FakePool & { states: Row[]; incidents: Row[]; notifies: number } {
  const db = {
    strategies: input.strategies,
    rules: input.rules,
    states: [] as Row[],
    incidents: [] as Row[],
    notifies: 0,
    query: async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(create (table|index)|alter table)/.test(sql)) return { rows: [] };
      if (sql.startsWith('select s.id, s.tenant_id') && sql.includes('where s.enabled = true')) {
        return { rows: db.strategies };
      }
      if (sql.startsWith('select id, strategy_id, position')) {
        return { rows: db.rules };
      }
      if (sql.startsWith('insert into public.studio_alert_strategy_states')) {
        const [sid, rid, skey, labels, now, value] = params as [string, string, string, string, Date, number];
        const found = db.states.find(
          (row) => row.strategy_id === sid && row.rule_id === rid && row.series_key === skey,
        );
        if (found) {
          found.last_hit_at = now;
          found.last_value = value;
          return { rows: [], rowCount: 1 };
        }
        db.states.push({
          strategy_id: sid,
          rule_id: rid,
          series_key: skey,
          series_labels: JSON.parse(labels),
          first_hit_at: now,
          last_hit_at: now,
          last_value: value,
          last_notify_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('select first_hit_at from public.studio_alert_strategy_states')) {
        const row = db.states.find(
          (item) =>
            item.strategy_id === params?.[0] &&
            item.rule_id === params?.[1] &&
            item.series_key === params?.[2],
        );
        return { rows: row ? [{ first_hit_at: row.first_hit_at }] : [] };
      }
      if (sql.startsWith('delete from public.studio_alert_strategy_states where strategy_id')) {
        const [sid, rid, keep] = params as [string, string, string[]];
        db.states = db.states.filter(
          (row) => row.strategy_id !== sid || row.rule_id !== rid || keep.includes(String(row.series_key)),
        );
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('min(first_hit_at) as first_hit_at')) {
        const rows = db.states.filter(
          (row) => row.strategy_id === params?.[0] && row.series_key === params?.[1],
        );
        if (!rows.length) return { rows: [] };
        const first = rows
          .map((row) => (row.first_hit_at as Date).getTime())
          .reduce((a, b) => Math.min(a, b));
        const notifies = rows
          .map((row) => (row.last_notify_at as Date | null)?.getTime() ?? 0)
          .reduce((a, b) => Math.max(a, b));
        return { rows: [{ first_hit_at: new Date(first), last_notify_at: notifies ? new Date(notifies) : null }] };
      }
      if (sql.startsWith('update public.studio_alert_strategy_states set last_notify_at')) {
        db.notifies += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('status in', ) || sql.includes("status in ('open','acknowledged','silenced')")) {
        const pattern = String(params?.[0] ?? '').replace(/%/g, '');
        return { rows: db.incidents.filter((row) => String(row.alert_key).includes(pattern)) };
      }
      if (sql.startsWith('delete from public.studio_alert_strategy_states\n        where last_hit_at') ||
          sql.replace(/\s+/g, ' ').startsWith('delete from public.studio_alert_strategy_states where last_hit_at')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
  return db;
}

function promResult(series: Array<[string, number]>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/query')) {
      return Response.json({
        data: {
          result: series.map(([key, value]) => ({
            metric: key === 'none' ? {} : { instance: key },
            value: [0, String(value)],
          })),
        },
      });
    }
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
}

const NOW = new Date('2026-09-24T12:00:00Z');

function seedRows(): { strategies: Row[]; rules: Row[] } {
  return {
    strategies: [
      {
        id: 's001',
        tenant_id: 'platform',
        name: '测试策略',
        description: '',
        enabled: true,
        notification_channel: 'default',
        created_by: 't',
        created_at: new Date(0),
        updated_by: 't',
        updated_at: new Date(0),
      },
    ],
    rules: [
      {
        id: 'r1',
        strategy_id: 's001',
        position: 0,
        query: 'up',
        duration_seconds: 120,
        comparator: 'gt',
        threshold: 0.5,
        severity: 'critical',
        send_interval_minutes: 0,
        no_data_alert: false,
      },
    ],
  };
}

test('评估状态机：首触记时间戳，持续不足不触发', async () => {
  const db = fakeStrategyDb(seedRows());
  configureStrategyPoolForTest(db);
  // 首轮：命中但 first_hit_at = now，持续 120s 不足 → 无转换。
  (globalThis as { fetch: unknown }).fetch = promResult([['host-a', 1]]);
  let transitions = await evaluateStrategies(db, NOW);
  assert.equal(transitions.length, 0);
  assert.equal(db.states.length, 1);

  // 第二轮（>120s 后）：满足持续时长 → opened。
  const later = new Date(NOW.getTime() + 180_000);
  transitions = await evaluateStrategies(db, later);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition.kind, 'opened');
  assert.equal(transitions[0].transition.key, 'strat-s001-' + String(db.states[0].series_key).slice(0, 8));
  assert.equal(transitions[0].transition.severity, 'critical');
  assert.equal(db.notifies, 1);
});

test('评估状态机：不再命中删状态并 resolved；值回到阈值内即恢复', async () => {
  const db = fakeStrategyDb(seedRows());
  configureStrategyPoolForTest(db);
  (globalThis as { fetch: unknown }).fetch = promResult([['host-a', 1]]);
  await evaluateStrategies(db, NOW);
  const later = new Date(NOW.getTime() + 180_000);
  await evaluateStrategies(db, later);
  // 模拟事故已建：活跃事故键与状态序列 hash 对齐。
  const hash8 = String(db.states[0].series_key).slice(0, 8);
  db.incidents = [{ alert_key: `strat-s001-${hash8}`, status: 'open' }];
  // 值回落 → 状态行删除 → resolved。
  (globalThis as { fetch: unknown }).fetch = promResult([['host-a', 0.1]]);
  const transitions = await evaluateStrategies(db, new Date(later.getTime() + 60_000));
  assert.equal(db.states.length, 0);
  assert.equal(transitions.filter((entry) => entry.transition.kind === 'resolved').length, 1);
});

test('无数据告警：零序列且 no_data_alert 视为命中', async () => {
  const rows = seedRows();
  rows.rules[0].no_data_alert = true;
  const db = fakeStrategyDb(rows);
  configureStrategyPoolForTest(db);
  (globalThis as { fetch: unknown }).fetch = promResult([]);
  await evaluateStrategies(db, NOW);
  const transitions = await evaluateStrategies(db, new Date(NOW.getTime() + 180_000));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].transition.kind, 'opened');
  assert.ok(String(transitions[0].transition.summary).includes('无数据'));
});

test('多序列独立成事故：不同标签序列各自触发', async () => {
  const db = fakeStrategyDb(seedRows());
  configureStrategyPoolForTest(db);
  (globalThis as { fetch: unknown }).fetch = promResult([
    ['host-a', 1],
    ['host-b', 2],
  ]);
  await evaluateStrategies(db, NOW);
  const transitions = await evaluateStrategies(db, new Date(NOW.getTime() + 180_000));
  assert.equal(transitions.length, 2);
  const keys = transitions.map((entry) => entry.transition.key);
  assert.equal(new Set(keys).size, 2);
  assert.ok(String(transitions[0].transition.summary).includes('host-a'));
});
