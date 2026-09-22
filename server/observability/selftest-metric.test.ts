/** 接入自检报文构造回归：OTLP gauge 结构、点号指标名、时间戳纳秒换算。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SELFTEST_METRIC, buildSelfTestMetricPayload } from './selftest-metric.js';

test('自检报文：gauge 单点、纳秒时间戳、service.name 资源属性', () => {
  const now = 1_800_000_000_123;
  const payload = buildSelfTestMetricPayload(now);
  const resource = payload.resourceMetrics[0];
  const metric = resource.scopeMetrics[0].metrics[0];
  const point = (metric.gauge as { dataPoints: Array<Record<string, unknown>> }).dataPoints[0];
  assert.equal(metric.name, 'rdk.obs.selftest');
  assert.equal(SELFTEST_METRIC.includes('.'), true, 'OTLP 指标名带点号');
  assert.equal(point.timeUnixNano, String(now * 1_000_000));
  assert.equal(typeof point.asDouble, 'number');
  assert.deepEqual(resource.resource.attributes[0].key, 'service.name');
});
