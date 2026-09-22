/** 业务指标 exposition 渲染回归：名称净化、标签转义、非法值跳过、HELP/TYPE 去重。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prometheusMetricName, renderBusinessMetricsExposition } from './business-metrics-exposition.js';

test('指标名净化：点号转下划线 + otlp_ 前缀', () => {
  assert.equal(prometheusMetricName('checkout.duration.ms'), 'otlp_checkout_duration_ms');
  assert.equal(prometheusMetricName('http:requests:total'), 'otlp_http:requests:total');
  assert.equal(prometheusMetricName('9invalid'), 'otlp_invalid');
  assert.equal(prometheusMetricName(''), '');
});

test('exposition 渲染：标签转义、HELP/TYPE 每族一次、非法值跳过', () => {
  const text = renderBusinessMetricsExposition([
    { metric: 'checkout.requests.total', labels: { service: 'checkout-api', route: '/x"y' }, lastValue: 12.5, lastTsMs: 1 },
    { metric: 'checkout.requests.total', labels: { service: 'other' }, lastValue: 3, lastTsMs: 2 },
    { metric: 'bad.metric', labels: {}, lastValue: NaN, lastTsMs: 3 },
    { metric: 'null.metric', labels: {}, lastValue: null, lastTsMs: 4 },
  ]);
  const lines = text.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('# TYPE otlp_checkout_requests_total ')).length, 1);
  assert.ok(lines.some((line) => line === 'otlp_checkout_requests_total{service="checkout-api",route="/x\\"y"} 12.5'));
  assert.ok(lines.some((line) => line === 'otlp_checkout_requests_total{service="other"} 3'));
  assert.ok(!text.includes('bad_metric'));
  assert.ok(!text.includes('null_metric'));
});

test('空输入渲染为空文本', () => {
  assert.equal(renderBusinessMetricsExposition([]), '');
});
