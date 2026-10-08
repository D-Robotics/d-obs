/**
 * 运营周报回归测试：周窗口聚合（开/恢复/MTTR/环比）、按天直方图、
 * 飞书卡片按钮跳转与文本降级、状态判定。不触发真实网络。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFeishuWeeklyOpsDigestCard,
  buildWeeklyOpsDigestText,
  collectWeeklyOpsDigest,
  weeklyDigestStatus,
  type WeeklyOpsDigest,
} from './studio-weekly-digest.js';
import { DEFAULT_ALERT_CONFIG, mergeAndValidateAlertConfig, type AlertConfig } from './alert-config.js';
import type { ErrorDigestPool } from './studio-error-digest.js';

type Row = Record<string, unknown>;
type Route = { match: RegExp; rows: (params: unknown[]) => Row[] };

/** 按 SQL 片段路由的假池；周事故查询用参数区分本周/上周窗口。 */
function fakePool(routes: Route[]): ErrorDigestPool {
  return {
    async query(text: string, params: unknown[] = []) {
      for (const route of routes) {
        if (route.match.test(text)) {
          return { rows: route.rows(params) };
        }
      }
      throw new Error(`fake pool: no route for query: ${text.slice(0, 120)}`);
    },
  };
}

function baseRoutes(options?: {
  weekly?: { opened?: number; resolved?: number; mttrAvg?: number; mttrP80?: number; previousOpened?: number };
  histogram?: Row[];
  airuns?: Row;
}): Route[] {
  const weekly = options?.weekly ?? {};
  return [
    { match: /from check_rows/, rows: () => [{ total: 2, enabled: 2, healthy: 2, active: 0, pending: 0, disabled: 0, stale: 0, categories: '[]' }] },
    {
      match: /current_incidents/,
      rows: () => [{ open_count: 0, critical_count: 0, items: '[]' }],
    },
    {
      match: /window_incidents/,
      rows: (params) => {
        const to = String(params[0]);
        const isPrevious = to === '2026-09-25T10:00:00.000Z';
        return [
          {
            opened: isPrevious ? weekly.previousOpened ?? 0 : weekly.opened ?? 0,
            resolved: isPrevious ? 0 : weekly.resolved ?? 0,
            mttr_avg: isPrevious ? null : weekly.mttrAvg ?? null,
            mttr_p80: isPrevious ? null : weekly.mttrP80 ?? null,
          },
        ];
      },
    },
    { match: /date_trunc/, rows: () => options?.histogram ?? [] },
    { match: /recent_errors/, rows: () => [{ total_events: 0, distinct_fingerprints: 0, affected_components: 0, categories: '[]', items: '[]' }] },
    { match: /from latest/, rows: () => [options?.airuns ?? { total: 0, errors: 0, partials: 0 }] },
    {
      match: /studio_alert_notifications/,
      rows: () => [{ attempts: 0, delivered: 0, failed: 0, suppressed: 0, incident_transitions: 0, recoveries: 0 }],
    },
  ];
}

function testConfig(): AlertConfig {
  return mergeAndValidateAlertConfig(DEFAULT_ALERT_CONFIG, {
    notification: { dashboardUrl: 'https://example.test/dobs/ops-observability#alerts' },
  });
}

const FRIDAY_NOW = new Date('2026-10-02T10:00:00.000Z');

test('collectWeeklyOpsDigest：窗口 168h，周聚合与环比成型', async () => {
  const p = fakePool(
    baseRoutes({
      weekly: { opened: 5, resolved: 4, mttrAvg: 95.5, mttrP80: 140, previousOpened: 8 },
      histogram: [{ day: '2026-10-01', opened: 3 }],
    }),
  );
  const digest = await collectWeeklyOpsDigest(p, { now: FRIDAY_NOW });
  assert.equal(digest.window.hours, 168);
  assert.equal(digest.weekly.incidents.opened, 5);
  assert.equal(digest.weekly.incidents.resolved, 4);
  assert.equal(digest.weekly.incidents.previousOpened, 8);
  assert.ok(Math.abs((digest.weekly.incidents.mttrAvgMinutes ?? 0) - 95.5) < 1e-6);
  assert.equal(digest.weekly.incidents.mttrP80Minutes, 140);
  assert.equal(digest.weekly.dailyHistogram.length, 7);
  const histogramDay = digest.weekly.dailyHistogram.find((entry) => entry.day === '2026-10-01');
  assert.equal(histogramDay?.count, 3);
  assert.ok(digest.weekly.dailyHistogram.some((entry) => entry.day === '2026-10-02'));
});

test('buildFeishuWeeklyOpsDigestCard：卡片含三枚跳转按钮且标题带周报标识', async () => {
  const p = fakePool(baseRoutes({ weekly: { opened: 2, resolved: 1, mttrAvg: 30 } }));
  const digest = await collectWeeklyOpsDigest(p, { now: FRIDAY_NOW });
  const card = buildFeishuWeeklyOpsDigestCard(digest, testConfig()) as {
    header: { title: { content: string } };
    elements: Array<Record<string, unknown>>;
  };
  assert.ok(card.header.title.content.includes('运营周报'));
  const action = card.elements.find((element) => element.tag === 'action') as {
    actions: Array<{ url: string }>;
  };
  const urls = action.actions.map((item) => item.url);
  assert.equal(urls.length, 3);
  assert.ok(urls.some((url) => url.endsWith('#alerts')));
  assert.ok(urls.some((url) => url.endsWith('#signals/quality')));
  assert.ok(urls.some((url) => url.endsWith('#traces')));
  assert.ok(urls.every((url) => url.startsWith('https://example.test/dobs/ops-observability')));
});

test('buildWeeklyOpsDigestText：文本含环比与看板地址', async () => {
  const p = fakePool(
    baseRoutes({ weekly: { opened: 5, resolved: 4, previousOpened: 8 }, histogram: [{ day: '2026-10-01', opened: 2 }] }),
  );
  const digest = await collectWeeklyOpsDigest(p, { now: FRIDAY_NOW });
  const text = buildWeeklyOpsDigestText(digest, testConfig());
  assert.ok(text.includes('环比 -3'));
  assert.ok(text.includes('按天事故分布'));
  assert.ok(text.includes('谛听：https://example.test/dobs/ops-observability#alerts'));
});

test('weeklyDigestStatus：严重进行中→P0，有新开事故→P1，全净→OK', async () => {
  const p = fakePool(baseRoutes());
  const quiet: WeeklyOpsDigest = await collectWeeklyOpsDigest(p, { now: FRIDAY_NOW });
  assert.equal(weeklyDigestStatus(quiet).priority, 'OK');

  const withCritical = structuredClone(quiet);
  withCritical.core.incidents.critical = 1;
  assert.equal(weeklyDigestStatus(withCritical).priority, 'P0');

  const withOpened = structuredClone(quiet);
  withOpened.weekly.incidents.opened = 1;
  assert.equal(weeklyDigestStatus(withOpened).priority, 'P1');
});
