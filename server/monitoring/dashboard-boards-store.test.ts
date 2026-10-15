/**
 * 看板 store 纯函数回归：spec/名称归一化与导入模板解析。
 * 数据库部分（pool/迁移）不在单测覆盖内，走本地 E2E。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_BOARD_SPEC,
  normalizeBoardName,
  normalizeBoardPanel,
  normalizeBoardSpec,
  normalizeBoardWriteSpec,
  parseBoardTemplate,
  configureDashboardPoolForTest,
  createBoard,
  deleteBoard,
  listBoards,
  updateBoard,
} from './dashboard-boards-store.js';

test('normalizeBoardName：去 \\0、裁剪、120 上限，空值拒绝', () => {
  assert.equal(normalizeBoardName('  运营核心看板 \0'), '运营核心看板');
  assert.equal(normalizeBoardName('x'.repeat(200)), 'x'.repeat(120));
  assert.equal(normalizeBoardName('   '), null);
  assert.equal(normalizeBoardName('\0\0'), null);
  assert.equal(normalizeBoardName(undefined), null);
});

test('normalizeBoardSpec：默认值与字段钳制', () => {
  assert.deepEqual(normalizeBoardSpec({}), { windowMinutes: 240, range: null, filters: null, panels: [] });
  const spec = normalizeBoardSpec({
    windowMinutes: 3,
    panels: [{ title: '订单时延', metric: 'http.server.duration', windowMinutes: 999999, chart: 'heatmap', width: 9 }],
  });
  assert.ok(spec);
  assert.equal(spec.windowMinutes, 5);
  assert.deepEqual(spec.panels, [
    { title: '订单时延', metric: 'http.server.duration', windowMinutes: 20160, chart: 'line', width: 1, warnValue: null, critValue: null, libraryId: null },
  ]);
});

test('normalizeBoardSpec：看板变量 filters（合法保留，非法剥离为 null）', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(normalizeBoardSpec({ filters: { service: 'checkout-api' }, panels: [] }, now)?.filters, { service: 'checkout-api' });
  assert.equal(normalizeBoardSpec({ filters: { service: '   ' }, panels: [] }, now)?.filters, null);
  assert.equal(normalizeBoardSpec({ filters: 'checkout-api', panels: [] }, now)?.filters, null);
  assert.equal(normalizeBoardSpec({ filters: { other: 1 }, panels: [] }, now)?.filters, null);
});

test('normalizeBoardSpec：绝对时间范围（合法保留，非法/超跨度/未来起点剥离）', () => {
  const now = 1_800_000_000_000;
  const ok = normalizeBoardSpec({ range: { fromMs: now - 3_600_000, toMs: now }, panels: [] }, now);
  assert.deepEqual(ok?.range, { fromMs: now - 3_600_000, toMs: now });
  const tooWide = normalizeBoardSpec({ range: { fromMs: now - 40 * 24 * 3_600_000, toMs: now }, panels: [] }, now);
  assert.equal(tooWide?.range, null);
  const future = normalizeBoardSpec({ range: { fromMs: now + 3_600_000, toMs: now + 7_200_000 }, panels: [] }, now);
  assert.equal(future?.range, null);
  const inverted = normalizeBoardSpec({ range: { fromMs: now, toMs: now - 1 }, panels: [] }, now);
  assert.equal(inverted?.range, null);
  const garbage = normalizeBoardSpec({ range: 'yesterday', panels: [] }, now);
  assert.equal(garbage?.range, null);
});

test('normalizeBoardPanel：stat 阈值字段解析（可空、非有限数容忍为 null）', () => {
  assert.deepEqual(normalizeBoardPanel({ title: 't', metric: 'm', warnValue: '12.5', critValue: 80 }), {
    title: 't', metric: 'm', windowMinutes: null, chart: 'line', width: 1, warnValue: 12.5, critValue: 80, libraryId: null,
  });
  assert.deepEqual(normalizeBoardPanel({ title: 't', metric: 'm', warnValue: 'oops' }), {
    title: 't', metric: 'm', windowMinutes: null, chart: 'line', width: 1, warnValue: null, critValue: null, libraryId: null,
  });
});

test('normalizeBoardSpec：OTLP 点号指标放行，坏结构拒绝', () => {
  assert.ok(normalizeBoardPanel({ title: 't', metric: 'otlp_metric.with.dots', windowMinutes: null }));
  assert.equal(normalizeBoardSpec({ windowMinutes: 60, panels: [{ title: 't', metric: 'has space' }] }), null);
  assert.equal(normalizeBoardSpec({ windowMinutes: 60, panels: { title: 'not-array' } }), null);
  assert.equal(normalizeBoardSpec({ windowMinutes: 'NaN-ish' }), null);
  assert.equal(normalizeBoardSpec(null), null);
  assert.equal(normalizeBoardSpec([1, 2]), null);
  assert.notEqual(normalizeBoardSpec(DEFAULT_BOARD_SPEC), null);
});

test('normalizeBoardSpec：面板数量截到 48 且坏面板整体拒绝', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ title: 'p' + i, metric: 'm_' + i }));
  const spec = normalizeBoardSpec({ panels: many });
  assert.ok(spec);
  assert.equal(spec.panels.length, 48);
  assert.equal(normalizeBoardSpec({ panels: [{ title: 'ok', metric: 'm' }, 'garbage'] }), null);
});

test('API board edits reject more than 48 panels while legacy template normalization remains compatible', () => {
  const panels = Array.from({ length: 49 }, (_, index) => ({ title: 'p' + index, metric: 'm' + index }));
  assert.equal(normalizeBoardWriteSpec({ panels }), null);
  assert.equal(normalizeBoardWriteSpec({ panels: panels.slice(0, 48) })?.panels.length, 48);
  assert.equal(normalizeBoardSpec({ panels })?.panels.length, 48);
});

test('parseBoardTemplate：完整导出 / title 变体 / 裸 spec / 拒绝垃圾', () => {
  const spec = { windowMinutes: 1440, panels: [{ title: 'QPS', metric: 'rdk.qps', windowMinutes: null, chart: 'bar', width: 2 }] };
  assert.deepEqual(parseBoardTemplate({ kind: 'd-obs-board', version: 1, name: '核心看板', spec }), {
    name: '核心看板',
    spec: { windowMinutes: 1440, range: null, filters: null, panels: [{ title: 'QPS', metric: 'rdk.qps', windowMinutes: null, chart: 'bar', width: 2, warnValue: null, critValue: null, libraryId: null }] },
  });
  assert.equal(parseBoardTemplate({ title: '老导出', spec })?.name, '老导出');
  assert.equal(parseBoardTemplate({ windowMinutes: 60, panels: [] })?.name, null);
  assert.equal(parseBoardTemplate({ name: '坏面板', spec: { panels: [{ title: '', metric: 'm' }] } }), null);
  assert.equal(parseBoardTemplate('{"trick": true}'), null);
  assert.equal(parseBoardTemplate(42), null);
});

test('query panel definitions preserve complete PromQL and optional presentation fields without changing legacy shapes', () => {
  const expr = 'sum by (service) (rate(http_requests_total{service="$service",status=~"5.."}[$__rate_interval]))';
  const panel = normalizeBoardPanel({ title: 'Errors', metric: '', source: 'prometheus', queries: [{ refId: 'A', expr, legendFormat: '{{service}}', instant: false }], unit: 'ops', reducer: 'avg' });
  assert.ok(panel); assert.equal(panel.metric, ''); assert.equal(panel.queries?.[0].expr, expr); assert.equal(panel.unit, 'ops'); assert.equal(panel.reducer, 'avg');
  const legacy = normalizeBoardPanel({ title: 'Legacy', metric: 'orders.total' });
  assert.ok(legacy); for (const field of ['source', 'queries', 'unit', 'reducer']) assert.equal(Object.hasOwn(legacy, field), false);
  assert.equal(normalizeBoardPanel({ title: 'p', metric: '', source: 'prometheus' }), null);
  assert.equal(normalizeBoardPanel({ title: 'p', metric: 'm', source: 'remote' }), null);
  assert.equal(normalizeBoardPanel({ title: 'p', metric: '', source: 'prometheus', queries: [{ refId: 'A', expr: 'up' }, { refId: 'A', expr: 'down' }] }), null);
  assert.equal(normalizeBoardPanel({ title: 'p', metric: '', source: 'prometheus', queries: Array.from({ length: 9 }, (_, i) => ({ refId: 'Q' + i, expr: 'up' })) }), null);
  assert.equal(normalizeBoardPanel({ title: 'p', metric: 'm', reducer: 'unsafe' }), null);
});

test('board variable definitions preserve supported types and reject duplicate, reserved and oversized definitions', () => {
  const variables = [{ name: 'service', label: '服务', type: 'custom', value: 'checkout', options: ['checkout', 'payments'] }, { name: 'route', label: '路由', type: 'textbox', value: '/orders' }];
  assert.deepEqual(normalizeBoardSpec({ panels: [], variables })?.variables, variables);
  assert.equal(Object.hasOwn(normalizeBoardSpec({ panels: [] })!, 'variables'), false);
  for (const invalid of [[variables[0], variables[0]], [{ ...variables[0], name: '__interval' }], [{ ...variables[0], type: 'query' }], Array.from({ length: 21 }, (_, i) => ({ ...variables[0], name: 'v' + i }))]) assert.equal(normalizeBoardSpec({ variables: invalid }), null);
});

test('team boards are readable across owners while all writes remain owner scoped and copies default private', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const seen: string[] = [];
  configureDashboardPoolForTest({ query: async (sql, params = []) => {
    seen.push(sql);
    if (sql.startsWith('select count')) return { rows: [{ total: rows.filter((row) => row.owner === params[0]).length }] };
    if (sql.startsWith('select coalesce')) return { rows: [{ next: rows.length }] };
    if (sql.startsWith('insert into public.studio_obs_dashboards (owner, name')) {
      const row = { id: 'board-' + rows.length, owner: params[0], name: params[1], spec: JSON.parse(String(params[2])), position: params[3], visibility: params[4], created_at: '', updated_at: '' }; rows.push(row); return { rows: [row] };
    }
    if (sql.startsWith('select *')) {
      assert.match(sql, /owner = \$1/);
      return { rows: rows.filter((row) => row.owner === params[0] || (sql.includes("visibility = 'team'") && row.visibility === 'team')) };
    }
    if (sql.startsWith('update public.studio_obs_dashboards set')) {
      assert.match(sql, /where owner = \$\d+ and id = \$\d+/);
      const row = rows.find((row) => row.owner === params.at(-2) && row.id === params.at(-1));
      if (!row) return { rows: [] };
      for (const match of sql.matchAll(/(visibility|name|spec) = \$(\d+)/g)) row[match[1]] = match[1] === 'spec' ? JSON.parse(String(params[Number(match[2]) - 1])) : params[Number(match[2]) - 1];
      return { rows: [row] };
    }
    if (sql.startsWith('delete from public.studio_obs_dashboards')) {
      assert.match(sql, /where owner = \$1 and id = \$2/);
      const index = rows.findIndex((row) => row.owner === params[0] && row.id === params[1]);
      if (index < 0) return { rows: [], rowCount: 0 }; rows.splice(index, 1); return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  } });
  try {
    const privateBoard = await createBoard({ owner: 'alice', name: 'Private' });
    const shared = await createBoard({ owner: 'alice', name: 'Shared', visibility: 'team' });
    assert.equal(privateBoard.visibility, 'private'); assert.equal(privateBoard.editable, true);
    const bobView = await listBoards('bob'); assert.equal(bobView.length, 1); assert.equal(bobView[0].id, shared.id); assert.equal(bobView[0].editable, false); assert.equal(Object.hasOwn(bobView[0], 'owner'), false);
    assert.equal(await updateBoard('bob', shared.id, { name: 'Takeover', visibility: 'private' }), null);
    assert.equal(await deleteBoard('bob', shared.id), false);
    const copy = await createBoard({ owner: 'bob', name: 'My copy', spec: shared.spec }); assert.equal(copy.visibility, 'private'); assert.equal(copy.editable, true);
    await updateBoard('alice', shared.id, { visibility: 'private' });
    assert.deepEqual((await listBoards('bob')).map((row) => row.id), [copy.id]);
    assert.ok(seen.some((sql) => sql.includes('add column if not exists visibility')));
  } finally { configureDashboardPoolForTest(null); }
});
