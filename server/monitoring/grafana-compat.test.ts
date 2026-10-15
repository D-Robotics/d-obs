/** Grafana interoperability retains executable queries and reports lossy mappings. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exportGrafanaDashboard, grafanaDurationToMinutes, parseGrafanaDashboard, toGrafanaDashboard } from './grafana-compat.js';
import { normalizeBoardSpec, type BoardPanel, type BoardSpec } from './dashboard-boards-store.js';

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

test('Grafana 导入保留完整 PromQL，rate 区间不改变面板查询时间窗', () => {
  const result = parseGrafanaDashboard(GRAFANA_SAMPLE);
  assert.ok(result);
  assert.equal(result.name, 'Grafana 老看板');
  assert.equal(result.spec.windowMinutes, 360);
  assert.equal(result.mapped, 3);
  assert.equal(result.skipped, 2);
  const [line, stat, table] = result.spec.panels;
  assert.deepEqual(
    [line.chart, line.metric, line.windowMinutes, line.width, line.source],
    ['line', '', null, 1, 'prometheus'],
  );
  assert.equal(line.queries?.[0].expr, 'sum(rate(checkout_requests_total[5m])) by (service)');
  assert.deepEqual([stat.chart, stat.queries?.[0].expr, stat.width], ['stat', 'checkout_duration_ms', 1]);
  assert.deepEqual([table.chart, table.queries?.[0].expr], ['table', 'probe_success']);
  assert.ok(result.details.some((item) => item.code === 'unsupported_query_variable'));
  assert.ok(result.details.some((item) => item.code === 'unsupported_panel_type'));
  assert.ok(result.details.some((item) => item.code === 'row_layout'));
});

test('Grafana 识别保护：d-obs 自有格式不被误判', () => {
  const own = { windowMinutes: 60, panels: [{ title: 't', metric: 'm' }] };
  assert.equal(parseGrafanaDashboard(own), null);
  assert.equal(parseGrafanaDashboard({ schemaVersion: 39, panels: [] }), null);
  assert.equal(parseGrafanaDashboard('nope'), null);
});

test('Grafana 导出不能把 OTLP 点号指标伪装为 Prometheus 查询', () => {
  const board = {
    name: '回环看板',
    spec: {
      windowMinutes: 360,
      range: null,
      filters: null,
      panels: [
        { title: 'QPS', metric: 'rdk.qps', windowMinutes: null, chart: 'line' as const, width: 2 as const, warnValue: null, critValue: null, libraryId: null },
        { title: '水位', metric: 'rdk.level', windowMinutes: 60, chart: 'stat' as const, width: 1 as const, warnValue: 80, critValue: 90, libraryId: null },
      ],
    },
  };
  const grafana = toGrafanaDashboard(board) as { time: { from: string }; panels: unknown[]; xDObs: { mapped: number; skipped: number; details: Array<{ code: string }> } };
  assert.equal(grafana.time.from, 'now-6h');
  assert.deepEqual(grafana.panels, []);
  assert.equal(grafana.xDObs.skipped, 2);
  assert.equal(grafana.xDObs.mapped, 0);
  assert.ok(grafana.xDObs.details.every((detail) => detail.code === 'otlp_panel_not_exported'));
});

const PANEL: BoardPanel = { title: 'Requests', source: 'prometheus', metric: '', queries: [{ refId: 'A', expr: 'up' }], windowMinutes: null, chart: 'line', width: 1, warnValue: null, critValue: null, libraryId: null };
function dashboard(panels: unknown[], extra: Record<string, unknown> = {}) {
  return { schemaVersion: 39, title: 'Test', time: { from: 'now-6h', to: 'now' }, panels, ...extra };
}
function prometheusPanel(extra: Record<string, unknown> = {}) {
  return { type: 'timeseries', title: 'Requests', datasource: { type: 'prometheus', uid: 'production' }, targets: [{ refId: 'A', expr: 'up' }], gridPos: { x: 0, y: 0, w: 12, h: 8 }, ...extra };
}

test('完整表达式、多查询、筛选、图例、即时模式、单位、阈值和变量往返保持', () => {
  const spec: BoardSpec = {
    windowMinutes: 360, range: null, filters: null,
    variables: [
      { name: 'env', label: '环境', type: 'custom', value: 'prod', options: ['prod', 'stage', 'with,comma'] },
      { name: 'service', label: '服务', type: 'textbox', value: 'checkout' },
    ],
    panels: [{ ...PANEL, chart: 'stat', width: 2, windowMinutes: 60, unit: 'percentunit', reducer: 'avg', warnValue: 0.01, critValue: 0.05,
      queries: [
        { refId: 'A', expr: 'sum by (service) (rate(http_requests_total{env="$env",service="${service}",status=~"5.."}[$__rate_interval])) / sum by (service) (rate(http_requests_total{env="$env",service="${service}"}[$__rate_interval]))', legendFormat: '{{service}} error rate', instant: false },
        { refId: 'B', expr: 'sum(increase(http_requests_total{env="$env"}[$__range])) / $__range_s', legendFormat: 'Total', instant: true },
      ],
    }],
  };
  const result = exportGrafanaDashboard({ name: 'Error rate', spec });
  assert.equal(result.mapped, 1);
  assert.equal(result.skipped, 0);
  const roundTrip = parseGrafanaDashboard(result.dashboard);
  assert.ok(roundTrip);
  assert.deepEqual(roundTrip.spec.variables, spec.variables);
  assert.deepEqual(roundTrip.spec.panels[0], spec.panels[0]);
  assert.equal(roundTrip.spec.windowMinutes, 360);
  assert.ok(roundTrip.details.some((item) => item.code === 'datasource_rebound'));
  assert.equal((result.dashboard.__inputs as Array<{ pluginId: string }>)[0].pluginId, 'prometheus');
});

test('Grafana dashboard API wrapper 和 v1 resource、递归 row 支持', () => {
  const original = dashboard([{ type: 'row', title: 'One', panels: [{ type: 'row', title: 'Two', panels: [prometheusPanel()] }] }]);
  for (const value of [original, { dashboard: original, meta: { canEdit: true } }, { kind: 'Dashboard', apiVersion: 'dashboard.grafana.app/v1', spec: original }]) {
    const imported = parseGrafanaDashboard(value);
    assert.ok(imported);
    assert.equal(imported.mapped, 1);
    assert.equal(imported.spec.panels[0].queries?.[0].expr, 'up');
    assert.equal(imported.details.filter((detail) => detail.code === 'row_layout').length, 2);
  }
});

test('绝对时间往返保留端点，ISO 和 Unix 毫秒模型均可导入', () => {
  const fromMs = Date.UTC(2025, 9, 10, 1);
  const toMs = fromMs + 600000;
  const spec = normalizeBoardSpec({ windowMinutes: 10, range: { fromMs, toMs }, panels: [PANEL] });
  assert.ok(spec);
  const exported = toGrafanaDashboard({ name: 'Incident', spec });
  assert.deepEqual(exported.time, { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
  assert.deepEqual(parseGrafanaDashboard(exported)?.spec.range, spec.range);
  assert.deepEqual(parseGrafanaDashboard(dashboard([prometheusPanel()], { time: { from: fromMs, to: String(toMs) } }))?.spec.range, spec.range);
  const unsupported = parseGrafanaDashboard(dashboard([prometheusPanel()], { time: { from: 'now-1d/d', to: 'now-1d/d' } }));
  assert.ok(unsupported?.details.some((detail) => detail.code === 'unsupported_time_range'));
});

test('混合/未知数据源、数据转换和重复面板不能静默改变查询语义', () => {
  const imported = parseGrafanaDashboard(dashboard([
    prometheusPanel({ datasource: { type: 'mixed', uid: '-- Mixed --' } }),
    prometheusPanel({ datasource: { type: 'loki', uid: 'logs' } }),
    prometheusPanel({ transformations: [{ id: 'calculateField' }] }),
    prometheusPanel({ repeat: 'env' }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up', datasource: { type: 'prometheus', uid: 'one' } }, { refId: 'B', expr: 'up', datasource: { type: 'prometheus', uid: 'two' } }] }),
  ]));
  assert.ok(imported);
  assert.equal(imported.mapped, 0);
  assert.equal(imported.skipped, 5);
  for (const code of ['mixed_datasource', 'unsupported_datasource', 'unsupported_transformations', 'unsupported_repeat', 'multiple_prometheus_datasources']) assert.ok(imported.details.some((detail) => detail.code === code));
});

test('动态查询变量、多选变量、未知变量和格式修饰明确报告并拒绝引用面板', () => {
  const imported = parseGrafanaDashboard(dashboard([
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{env="$env"}' }] }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{service="$service"}' }] }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{region="${region:regex}"}' }] }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{region="$missing"}' }] }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'rate(http_requests_total[$__rate_interval])' }] }),
  ], { templating: { list: [
    { name: 'env', type: 'query', query: 'label_values(up, env)', current: { value: 'prod' } },
    { name: 'service', type: 'custom', query: 'checkout,api', multi: true, current: { value: ['checkout'] } },
    { name: 'region', type: 'textbox', current: { value: 'cn' } },
  ] } }));
  assert.ok(imported);
  assert.equal(imported.mapped, 1);
  assert.equal(imported.skipped, 4);
  assert.deepEqual(imported.spec.variables?.map((variable) => variable.name), ['region']);
  assert.ok(imported.details.some((detail) => detail.code === 'unsupported_variable_type'));
  assert.ok(imported.details.some((detail) => detail.code === 'unsupported_variable_selection'));
  assert.equal(imported.details.filter((detail) => detail.code === 'unsupported_query_variable').length, 4);
});

test('query/variable/panel 上限不会静默截断表达式或吞掉丢失报告', () => {
  const result = parseGrafanaDashboard(dashboard([
    prometheusPanel({ targets: Array.from({ length: 9 }, (_, i) => ({ refId: `Q${i}`, expr: 'up' })) }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'x'.repeat(2001) }] }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{env="$v20"}' }] }),
    ...Array.from({ length: 50 }, () => prometheusPanel()),
  ], { templating: { list: Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, type: 'textbox', current: { value: 'prod' } })) } }));
  assert.ok(result);
  assert.equal(result.spec.variables?.length, 20);
  assert.equal(result.mapped, 48);
  assert.equal(result.skipped, 5);
  for (const code of ['query_limit', 'invalid_query', 'variable_limit', 'unsupported_query_variable', 'panel_limit']) assert.ok(result.details.some((detail) => detail.code === code));
});

test('隐藏查询排除，字段覆盖/百分比阈值/自动刷新丢失有报告', () => {
  const result = parseGrafanaDashboard(dashboard([prometheusPanel({
    targets: [{ refId: 'A', expr: 'up' }, { refId: 'B', expr: 'rate(foo[5m])', hide: true }],
    fieldConfig: { defaults: { unit: 'ms', thresholds: { mode: 'percentage', steps: [{ value: 90, color: 'red' }] }, mappings: [{ type: 'value' }] }, overrides: [{ matcher: { id: 'byName', options: 'up' }, properties: [] }] },
  })], { refresh: '5s' }));
  assert.ok(result);
  assert.equal(result.spec.panels[0].queries?.length, 1);
  assert.equal(result.spec.panels[0].unit, 'ms');
  assert.equal(result.spec.panels[0].warnValue, null);
  for (const code of ['hidden_targets', 'field_overrides', 'unsupported_threshold_mode', 'value_mappings', 'refresh_interval']) assert.ok(result.details.some((detail) => detail.code === code));
});

test('导出网格放置左右半宽面板，整行面板不会重叠', () => {
  const spec: BoardSpec = { windowMinutes: 60, range: null, filters: null, panels: [{ ...PANEL }, { ...PANEL }, { ...PANEL, width: 2 }, { ...PANEL }] };
  const panels = toGrafanaDashboard({ name: 'Grid', spec }).panels as Array<{ gridPos: unknown }>;
  assert.deepEqual(panels.map((panel) => panel.gridPos), [
    { x: 0, y: 0, w: 12, h: 8 }, { x: 12, y: 0, w: 12, h: 8 }, { x: 0, y: 8, w: 24, h: 8 }, { x: 0, y: 16, w: 12, h: 8 },
  ]);
  assert.equal(grafanaDurationToMinutes('now-7d'), 10080);
  assert.equal(grafanaDurationToMinutes('2025-01-01'), null);
});

test('单独严重阈值不降级为警告阈值；同一数据源不同 JSON 键顺序不误判', () => {
  const spec: BoardSpec = { windowMinutes: 60, range: null, filters: null, panels: [{ ...PANEL, critValue: 90 }] };
  const roundTrip = parseGrafanaDashboard(toGrafanaDashboard({ name: 'Crit only', spec }));
  assert.equal(roundTrip?.spec.panels[0].warnValue, null);
  assert.equal(roundTrip?.spec.panels[0].critValue, 90);
  const sameSource = parseGrafanaDashboard(dashboard([prometheusPanel({ targets: [
    { refId: 'A', expr: 'up', datasource: { type: 'prometheus', uid: 'prod' } },
    { refId: 'B', expr: 'up', datasource: { uid: 'prod', type: 'prometheus' } },
  ] })]));
  assert.equal(sameSource?.mapped, 1);
  const mixed = parseGrafanaDashboard(dashboard([prometheusPanel({ datasource: { type: 'datasource', uid: '-- Mixed --' } })]));
  assert.ok(mixed?.details.some((detail) => detail.code === 'mixed_datasource'));
});

test('重复变量、特殊对象属性和字段选择器不会导入不明确的计算语义', () => {
  const imported = parseGrafanaDashboard(dashboard([
    prometheusPanel({ type: 'constructor' }),
    prometheusPanel({ targets: [{ refId: 'A', expr: 'up{env="$env"}' }] }),
    prometheusPanel({ options: { reduceOptions: { calcs: ['mean'], fields: '/^Requests$/' } } }),
  ], { templating: { list: [
    { name: 'env', type: 'textbox', current: { value: 'prod' } },
    { name: 'env', type: 'textbox', current: { value: 'stage' } },
  ] } }));
  assert.equal(imported?.mapped, 0);
  assert.equal(imported?.skipped, 3);
  assert.equal(imported?.spec.variables, undefined);
  assert.ok(imported?.details.some((detail) => detail.code === 'unsupported_reducer_fields'));
});
