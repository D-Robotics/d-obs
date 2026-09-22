/** Grafana JSON 兼容层回归：识别、面板映射、模板变量跳过、时间窗解析、导出回环。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGrafanaDashboard, toGrafanaDashboard } from './grafana-compat.js';

const GRAFANA_SAMPLE = {
  schemaVersion: 39,
  title: 'Grafana 老看板',
  time: { from: 'now-6h', to: 'now' },
  panels: [
    {
      type: 'timeseries',
      title: '请求量',
      targets: [{ expr: 'sum(rate(checkout_requests_total[5m])) by (service)', refId: 'A' }],
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
    },
    {
      type: 'stat',
      title: '时延',
      targets: [{ expr: 'checkout_duration_ms', refId: 'A' }],
      gridPos: { x: 12, y: 0, w: 6, h: 8 },
    },
    {
      type: 'timeseries',
      title: '按服务细分',
      targets: [{ expr: 'sum(rate(http_requests_total[5m])) by ($service)', refId: 'A' }],
      gridPos: { x: 0, y: 8, w: 24, h: 8 },
    },
    { type: 'text', title: '说明', gridPos: { x: 0, y: 16, w: 12, h: 4 } },
    {
      type: 'row',
      title: '折叠行',
      panels: [{
        type: 'table',
        title: '',
        targets: [{ expr: 'probe_success', refId: 'A' }],
        gridPos: { x: 0, y: 20, w: 24, h: 8 },
      }],
    },
  ],
};

test('Grafana 导入：类型映射、指标提取、区间窗口、gridPos 宽度、row 展开', () => {
  const result = parseGrafanaDashboard(GRAFANA_SAMPLE);
  assert.ok(result);
  assert.equal(result.name, 'Grafana 老看板');
  assert.equal(result.spec.windowMinutes, 360);
  assert.equal(result.mapped, 3);
  assert.equal(result.skipped, 2);
  const [line, stat, table] = result.spec.panels;
  assert.deepEqual(
    [line.chart, line.metric, line.windowMinutes, line.width],
    ['line', 'checkout_requests_total', 5, 1],
  );
  assert.deepEqual([stat.chart, stat.metric, stat.width], ['stat', 'checkout_duration_ms', 1]);
  assert.deepEqual([table.chart, table.metric], ['table', 'probe_success']);
});

test('Grafana 识别保护：d-obs 自有格式不被误判', () => {
  const own = { windowMinutes: 60, panels: [{ title: 't', metric: 'm' }] };
  assert.equal(parseGrafanaDashboard(own), null);
  assert.equal(parseGrafanaDashboard({ schemaVersion: 39, panels: [] }), null);
  assert.equal(parseGrafanaDashboard('nope'), null);
});

test('Grafana 导出：time/panels 结构可被反向解析（回环一致）', () => {
  const board = {
    name: '回环看板',
    spec: {
      windowMinutes: 360,
      range: null,
      filters: null,
      panels: [
        { title: 'QPS', metric: 'rdk.qps', windowMinutes: null, chart: 'line' as const, width: 2 as const, warnValue: null, critValue: null },
        { title: '水位', metric: 'rdk.level', windowMinutes: 60, chart: 'stat' as const, width: 1 as const, warnValue: 80, critValue: 90 },
      ],
    },
  };
  const grafana = toGrafanaDashboard(board) as { time: { from: string }; panels: Array<{ type: string; targets: Array<{ expr: string }>; gridPos: { w: number } }> };
  assert.equal(grafana.time.from, 'now-6h');
  assert.deepEqual(grafana.panels.map((panel) => panel.type), ['timeseries', 'stat']);
  assert.deepEqual(grafana.panels.map((panel) => panel.targets[0].expr), ['rdk.qps', 'rdk.level']);
  assert.deepEqual(grafana.panels.map((panel) => panel.gridPos.w), [24, 12]);
  const roundTrip = parseGrafanaDashboard(grafana);
  assert.ok(roundTrip);
  assert.equal(roundTrip.name, '回环看板');
  assert.equal(roundTrip.spec.windowMinutes, 360);
  assert.deepEqual(roundTrip.spec.panels.map((panel) => [panel.metric, panel.chart]), [['rdk.qps', 'line'], ['rdk.level', 'stat']]);
});
