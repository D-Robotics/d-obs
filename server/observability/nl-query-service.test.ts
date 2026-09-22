/**
 * NL 查询规则层回归：落库指标名直查（含点号）、service 联动、未命中回落。
 * 测试环境未启用模型通道（RDK_COPILOT_MODEL_ENABLED），只会走规则层。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nlQuery } from './nl-query-service.js';

const SERIES_INDEX = [
  { metric: 'checkout.requests.total', service: 'checkout-api' },
  { metric: 'checkout.duration.ms', service: 'checkout-api' },
  { metric: 'otel.sdk.span.started', service: '' },
];

test('问题里出现落库指标名 → 精确命中平台内序列', async () => {
  const result = await nlQuery('看一下 checkout.requests.total 最近1小时', SERIES_INDEX);
  assert.equal(result.source, 'rules');
  assert.equal(result.spec.metric, 'checkout.requests.total');
  assert.equal(result.spec.plane, 'otlp');
  assert.equal(result.spec.agg, 'rate');
  assert.equal(result.spec.windowMinutes, 60);
});

test('指标名 + service 名同时出现 → 附带 service 标签', async () => {
  const result = await nlQuery('checkout-api 的 checkout.duration.ms 趋势', SERIES_INDEX);
  assert.equal(result.spec.metric, 'checkout.duration.ms');
  assert.deepEqual(result.spec.labels, { service: 'checkout-api' });
});

test('只提 service 不提指标名 → 原有 service 提示词路径不受影响', async () => {
  const result = await nlQuery('checkout-api 最近请求多吗', SERIES_INDEX);
  assert.ok(['checkout.requests.total', 'checkout.duration.ms', ''].includes(result.spec.metric));
});

test('完全未命中 → 回落提示 spec（metric 为空），不抛错', async () => {
  const result = await nlQuery('今天天气怎么样', SERIES_INDEX);
  assert.equal(result.spec.metric, '');
});

test('空问题 → nl_query_empty', async () => {
  await assert.rejects(() => nlQuery('   ', SERIES_INDEX), /nl_query_empty/);
});
