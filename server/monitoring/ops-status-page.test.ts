/**
 * 公开状态页回归测试：聚合数据的三桶分型、事故脱敏（URL/邮箱）、
 * worker 心跳判定、渲染 HTML 不含身份/配置字段、XSS 转义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStatusPageData, renderStatusPageHtml, type StatusPageData } from './ops-status-page.js';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function fakePool() {
  return {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('studio_alert_worker_status')) {
        return {
          rows: [{ last_run_at: minutesAgo(1), worker_version: '2026.9.17' }],
        };
      }
      if (sql.includes('studio_alert_checks')) {
        return {
          rows: [
            {
              total: 24,
              disabled: 2,
              healthy: 18,
              firing: 3,
              observing: 1,
            },
          ],
        };
      }
      if (sql.includes('studio_alert_incidents')) {
        return {
          rows: [
            {
              title: '磁盘使用率过高 <script>alert(1)</script>',
              severity: 'critical',
              status: 'open',
              first_seen_at: minutesAgo(30),
              last_seen_at: minutesAgo(5),
              summary: '主站 db-1 磁盘 92%；联系 ops@example.com 或见 https://internal.example/run/1',
            },
            {
              title: 'API 5xx 激增',
              severity: 'warning',
              status: 'acknowledged',
              first_seen_at: minutesAgo(90),
              last_seen_at: minutesAgo(20),
              summary: null,
            },
          ],
        };
      }
      throw new Error('unexpected_sql: ' + sql.slice(0, 60));
    },
  };
}

test('getStatusPageData：三桶分型、心跳判定、事故归一化', async () => {
  const data = await getStatusPageData(fakePool());
  assert.equal(data.worker.alive, true);
  assert.equal(data.worker.workerVersion, '2026.9.17');
  assert.deepEqual(data.checks, {
    total: 24,
    healthy: 18,
    observing: 1,
    firing: 3,
    disabled: 2,
  });
  assert.equal(data.incidents.length, 2);
  assert.equal(data.incidents[0].severity, 'critical');
  assert.equal(data.incidents[1].severity, 'warning');
  assert.equal(data.incidents[1].status, 'acknowledged');
  assert.equal(data.incidents[1].summary, '');
});

test('事故摘要脱敏：URL 与邮箱被占位符替换', async () => {
  const data = await getStatusPageData(fakePool());
  assert.ok(!data.incidents[0].summary.includes('example.com'));
  assert.ok(data.incidents[0].summary.includes('[url]'));
  assert.ok(data.incidents[0].summary.includes('[email]'));
});

test('worker 心跳超时（>5 分钟）判为不存活', async () => {
  const p = {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('studio_alert_worker_status')) {
        return { rows: [{ last_run_at: minutesAgo(12), worker_version: 'x' }] };
      }
      return { rows: [] };
    },
  };
  const data = await getStatusPageData(p);
  assert.equal(data.worker.alive, false);
  assert.deepEqual(data.checks, {
    total: 0,
    healthy: 0,
    observing: 0,
    firing: 0,
    disabled: 0,
  });
  assert.deepEqual(data.incidents, []);
});

test('渲染 HTML：转义标题、包含状态摘要、不含鉴权或配置面字段', () => {
  const data: StatusPageData = {
    fetchedAt: new Date().toISOString(),
    worker: { alive: true, lastCheckedAt: minutesAgo(1), workerVersion: '1.0' },
    checks: { total: 10, healthy: 9, observing: 0, firing: 1, disabled: 0 },
    incidents: [
      {
        title: '<b>磁盘</b> & "风险"',
        severity: 'critical',
        status: 'open',
        firstSeenAt: minutesAgo(30),
        lastSeenAt: minutesAgo(5),
        summary: "摘要 <i>x</i> 'y'",
      },
    ],
  };
  const html = renderStatusPageHtml(data);
  assert.ok(html.includes('&lt;b&gt;磁盘&lt;/b&gt;'));
  assert.ok(!html.includes('<b>磁盘</b>'));
  assert.ok(html.includes('当前事故 1 个'));
  assert.ok(html.includes('健康检查 9/10 项正常'));
  // 公开页绝不能出现的字段名。
  for (const forbidden of [
    'webhook',
    'token',
    'tenant_id',
    'alertKey',
    'channel',
    'password',
    'secret',
  ]) {
    assert.ok(!html.toLowerCase().includes(forbidden.toLowerCase()), 'leaked: ' + forbidden);
  }
});

test('渲染 HTML：空事故与不健康 worker 的降级文案', () => {
  const html = renderStatusPageHtml({
    fetchedAt: new Date().toISOString(),
    worker: { alive: false, lastCheckedAt: null, workerVersion: null },
    checks: { total: 0, healthy: 0, observing: 0, firing: 0, disabled: 0 },
    incidents: [],
  });
  assert.ok(html.includes('巡检心跳超时'));
  assert.ok(html.includes('尚无巡检记录'));
  assert.ok(html.includes('没有进行中的事故'));
});
