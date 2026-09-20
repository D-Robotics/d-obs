/**
 * Token 按模型拆分的纯聚合回归测试：共享分母、排序稳定性、
 * 模型名归一化与空输入降级。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildModelTokenMetrics,
  emptyModelTokenMetrics,
  type ModelTokenMetricRow,
} from './model-token-metrics.js';

function row(model: string, promptTokens: number, completionTokens: number): ModelTokenMetricRow {
  return { day: '2026-09-16', model, promptTokens, completionTokens };
}

test('share 用总 token 作分母并按总量降序排列', () => {
  const metrics = buildModelTokenMetrics(
    [
      row('qwen3.6-plus', 100, 100),
      row('deepseek-v3', 50, 50),
      row('qwen3.6-plus', 100, 0),
    ],
    30,
  );
  assert.equal(metrics.configured, true);
  assert.equal(metrics.models.length, 2);
  assert.deepEqual(
    metrics.models.map((item) => item.model),
    ['qwen3.6-plus', 'deepseek-v3'],
  );
  assert.deepEqual(
    metrics.models.map((item) => item.totalTokens),
    [300, 100],
  );
  assert.deepEqual(
    metrics.models.map((item) => item.runs),
    [2, 1],
  );
  assert.equal(metrics.models[0]!.share, 0.75);
  assert.equal(metrics.models[1]!.share, 0.25);
});

test('同 token 总量时按模型名稳定排序', () => {
  const metrics = buildModelTokenMetrics(
    [row('b-model', 10, 10), row('a-model', 20, 0)],
    7,
  );
  assert.deepEqual(
    metrics.models.map((item) => item.model),
    ['a-model', 'b-model'],
  );
});

test('空/未知模型名归一为 unknown，并正常汇总 token', () => {
  const metrics = buildModelTokenMetrics(
    [row('', 10, 5), row('  ', 3, 3), row('known', 0, 0)],
    7,
  );
  assert.equal(metrics.models.length, 2);
  // known 总量为 0；unknown 合并两条空名 run，token 正常汇总。
  const names = metrics.models.map((item) => item.model).sort();
  assert.deepEqual(names, ['known', 'unknown']);
  const unknown = metrics.models.find((item) => item.model === 'unknown')!;
  assert.equal(unknown.runs, 2);
  assert.equal(unknown.totalTokens, 21);
  assert.equal(unknown.share, 1);
});

test('totals 与模型行一致；空输入返回 unconfigured 空结构', () => {
  const metrics = buildModelTokenMetrics([row('m', 7, 3), row('m2', 1, 1)], 30);
  assert.deepEqual(metrics.totals, { runs: 2, promptTokens: 8, completionTokens: 4, totalTokens: 12, cost: null });
  const empty = emptyModelTokenMetrics(30);
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.models, []);
  assert.deepEqual(empty.totals, { runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null });
  const builtEmpty = buildModelTokenMetrics([], 30);
  assert.equal(builtEmpty.configured, true);
  assert.deepEqual(builtEmpty.models, []);
  assert.equal(builtEmpty.totals.totalTokens, 0);
});

test('配置单价时按模型计算成本，未配置价格的模型保持 null', () => {
  const metrics = buildModelTokenMetrics(
    [row('priced', 1_000_000, 500_000), row('unpriced', 10, 10)],
    30,
    { priced: { inputPerM: 2, outputPerM: 8, currency: 'CNY' } },
  );
  const priced = metrics.models.find((item) => item.model === 'priced')!;
  assert.equal(priced.cost?.totalCost, 6);
  assert.equal(priced.cost?.inputCost, 2);
  assert.equal(priced.cost?.outputCost, 4);
  assert.equal(priced.cost?.currency, 'CNY');
  const unpriced = metrics.models.find((item) => item.model === 'unpriced')!;
  assert.equal(unpriced.cost, null);
  assert.equal(metrics.totals.cost?.totalCost, 6);
  assert.equal(metrics.totals.cost?.currency, 'CNY');
});
