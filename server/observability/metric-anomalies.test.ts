/** 统计异常检测纯函数回归：尖峰命中、平坦不误报、短序列跳过、排序与字段。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectSeriesAnomalies } from './metric-anomalies.js';

function flat(n: number, value = 10): Array<{ ts: number; value: number }> {
  return Array.from({ length: n }, (_, i) => ({ ts: i * 60_000, value: value + (i % 2) }));
}

test('末点尖峰命中：z 分数、基线与时间戳字段', () => {
  const points = [...flat(30), { ts: 30 * 60_000, value: 100 }];
  const anomalies = detectSeriesAnomalies([{ metric: 'm', labels: { service: 's' }, points }]);
  assert.equal(anomalies.length, 1);
  const hit = anomalies[0];
  assert.equal(hit.metric, 'm');
  assert.equal(hit.value, 100);
  assert.equal(hit.sampleSize, 30);
  assert.ok(hit.score > 3.5);
  assert.equal(hit.ts, 30 * 60_000);
});

test('平稳序列不误报；标准差为零（常值序列）跳过', () => {
  assert.deepEqual(detectSeriesAnomalies([{ metric: 'm', labels: {}, points: flat(40, 7) }]), []);
  const constant = Array.from({ length: 30 }, (_, i) => ({ ts: i * 60_000, value: 5 }));
  assert.deepEqual(detectSeriesAnomalies([{ metric: 'm', labels: {}, points: [...constant, { ts: 30 * 60_000, value: 500 }] }]), []);
});

test('样本不足（< minBaseline+1）跳过；多条序列按分数降序', () => {
  const short = Array.from({ length: 8 }, (_, i) => ({ ts: i * 60_000, value: 1 }));
  const bigSpike = [...flat(30), { ts: 30 * 60_000, value: 300 }];
  const smallSpike = [...flat(30), { ts: 30 * 60_000, value: 30 }];
  const anomalies = detectSeriesAnomalies([
    { metric: 'short', labels: {}, points: [...short, { ts: 8 * 60_000, value: 999 }] },
    { metric: 'big', labels: {}, points: bigSpike },
    { metric: 'small', labels: {}, points: smallSpike },
  ]);
  assert.deepEqual(anomalies.map((item) => item.metric), ['big', 'small']);
});
