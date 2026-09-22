/** 跨信号关联纯函数回归：证据组合、窗口、空态摘要、上限裁剪。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIncidentCorrelation } from './incident-correlate.js';

const NOW = 1_800_000_000_000;
const INCIDENT = {
  alertKey: 'metric-anomaly',
  title: '指标统计异常',
  severity: 'warning',
  status: 'open',
  summary: '最高 z=7',
  firstSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
  lastSeenAt: new Date(NOW - 5 * 60_000).toISOString(),
};

test('三类证据都汇聚：metric-anomaly / log-error / device-offline', () => {
  const result = buildIncidentCorrelation({
    incident: INCIDENT,
    anomalies: [{ metric: 'checkout.duration.ms', labels: {}, value: 100, baseline: 10, deviation: 2, score: 7.5, ts: NOW - 60_000, sampleSize: 30 }],
    errorLogs: [{ service: 'checkout-api', severityText: 'ERROR', body: 'connection refused', timestampMs: NOW - 120_000 }],
    offlineDevices: [{ deviceId: 'edge-node-01', online: false, lastSeenAt: new Date(NOW - 3600_000).toISOString() }],
    nowMs: NOW,
  });
  assert.deepEqual(result.evidence.map((item) => item.kind), ['metric-anomaly', 'log-error', 'device-offline']);
  assert.match(result.summary, /1 条指标异常、1 条错误日志、1 台离线设备/);
  assert.equal(result.window.fromMs, Date.parse(INCIDENT.firstSeenAt));
  assert.equal(result.window.toMs, NOW);
});

test('空证据：给出窗口长度摘要而非空列表报错', () => {
  const result = buildIncidentCorrelation({ incident: INCIDENT, anomalies: [], errorLogs: [], offlineDevices: [], nowMs: NOW });
  assert.deepEqual(result.evidence, []);
  assert.match(result.summary, /暂未发现跨信号异常证据/);
});

test('每类证据最多 4 条（信号多样性优先），limit 再裁总量', () => {
  const anomalies = Array.from({ length: 10 }, (_, i) => ({
    metric: `m${i}`, labels: {}, value: i, baseline: 0, deviation: 1, score: 5 + i, ts: NOW, sampleSize: 20,
  }));
  const result = buildIncidentCorrelation({
    incident: { ...INCIDENT, firstSeenAt: 'not-a-date' },
    anomalies,
    errorLogs: [],
    offlineDevices: [],
    nowMs: NOW,
    limit: 5,
  });
  // 10 条异常在类内就被裁到 4 条——总量 limit(5) 不会打破跨信号多样性。
  assert.equal(result.evidence.length, 4);
  assert.equal(result.window.fromMs, NOW - 60 * 60_000);
});
