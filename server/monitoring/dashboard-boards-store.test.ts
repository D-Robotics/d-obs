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
  parseBoardTemplate,
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
