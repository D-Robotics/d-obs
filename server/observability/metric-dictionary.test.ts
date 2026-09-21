import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  METRIC_CATALOG,
  matchMetricCatalog,
  parseWindowMinutes,
} from './metric-dictionary.js';
import { nlQuery, promqlForSpec } from './nl-query-service.js';

test('指标字典：条目结构完整、指标名唯一', () => {
  const seen = new Set<string>();
  for (const entry of METRIC_CATALOG) {
    assert.ok(entry.metric, 'metric required');
    assert.ok(!seen.has(entry.metric), `duplicate metric: ${entry.metric}`);
    seen.add(entry.metric);
    assert.ok(entry.zhName && entry.description && entry.category);
    assert.ok(['prometheus', 'otlp', 'pattern'].includes(entry.plane));
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length >= 2);
  }
});

test('时间窗口解析：中文短语换算分钟并收敛到合法范围', () => {
  assert.equal(parseWindowMinutes('最近30分钟的错误').minutes, 30);
  assert.equal(parseWindowMinutes('过去2小时的span').minutes, 120);
  assert.equal(parseWindowMinutes('近7天的日志').minutes, 7 * 24 * 60);
  assert.equal(parseWindowMinutes('看一下队列').minutes, 240);
  assert.equal(parseWindowMinutes('最近99999天的数据').minutes, 20_160);
});

test('确定性匹配：中文口语能命中正确指标', () => {
  assert.equal(matchMetricCatalog('最近1小时有多少span被拒绝')[0]?.entry.metric, 'rdk_ai_otlp_spans_rejected_total');
  assert.equal(matchMetricCatalog('指标队列是不是堆积了')[0]?.entry.metric, 'rdk_observability_metric_queue_depth');
  assert.equal(matchMetricCatalog('日志被拒了多少')[0]?.entry.metric, 'rdk_ai_otlp_log_records_rejected_total');
});

test('PromQL 生成：counter 走 increase，直方图走 p95 分位', () => {
  assert.equal(
    promqlForSpec({ metric: 'rdk_ai_otlp_spans_rejected_total', plane: 'prometheus', agg: 'rate', windowMinutes: 60, labels: {}, explanation: '' }),
    'sum(increase(rdk_ai_otlp_spans_rejected_total[60m]))',
  );
  assert.equal(
    promqlForSpec({ metric: 'rdk_ai_otlp_trace_ingest_duration_ms', plane: 'prometheus', agg: 'p95', windowMinutes: 60, labels: {}, explanation: '' }),
    'histogram_quantile(0.95, sum by (le) (rate(rdk_ai_otlp_trace_ingest_duration_ms_bucket[60m])))',
  );
  assert.equal(
    promqlForSpec({ metric: 'rdk_observability_metric_queue_depth', plane: 'prometheus', agg: 'avg', windowMinutes: 30, labels: {}, explanation: '' }),
    'avg_over_time(rdk_observability_metric_queue_depth[30m])',
  );
  assert.equal(
    promqlForSpec({ metric: 'rdk_observability_metric_queue_depth', plane: 'prometheus', agg: 'avg', windowMinutes: 30, labels: { device: 'x"1' }, explanation: '' }),
    'avg_over_time(rdk_observability_metric_queue_depth{device="x1"}[30m])',
  );
});

test('自然语言查询（模型关闭）：规则层命中并解释来源', async () => {
  const result = await nlQuery('最近1小时有多少span被拒绝', []);
  assert.equal(result.source, 'rules');
  assert.equal(result.spec.metric, 'rdk_ai_otlp_spans_rejected_total');
  assert.equal(result.spec.plane, 'prometheus');
  assert.equal(result.spec.windowMinutes, 60);
  assert.ok(result.promql && result.promql.includes('increase('));
});

test('自然语言查询：提到已知服务名时走平台内 OTLP 查询', async () => {
  const result = await nlQuery('checkout-api 最近的请求量怎么样', [
    { metric: 'checkout.requests.total', service: 'checkout-api' },
    { metric: 'checkout.duration.ms', service: 'checkout-api' },
  ]);
  assert.equal(result.source, 'rules');
  assert.equal(result.spec.plane, 'otlp');
  assert.equal(result.spec.metric, 'checkout.requests.total');
  assert.equal(result.spec.labels.service, 'checkout-api');
  assert.equal(result.promql, null);
});

test('自然语言查询：完全无法识别时给字典兜底而不是报错', async () => {
  const result = await nlQuery('今天午饭吃什么', []);
  assert.equal(result.spec.metric, '');
  assert.ok(result.notice);
});
