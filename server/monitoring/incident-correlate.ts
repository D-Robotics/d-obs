/**
 * 跨信号根因关联 v1：把一个告警事故窗口内的异常指标、错误日志、离线设备
 * 汇聚成证据清单（与事故副驾 evidenceIndex 同构：ref/kind/label）。
 * 纯函数——存储读取在路由层完成，这里只做组合与摘要。
 */

import type { SeriesAnomaly } from '../observability/metric-anomalies.js';

export type CorrelatedIncident = {
  alertKey: string;
  title: string;
  severity: string;
  status: string;
  summary: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
};

export type CorrelationLogRow = {
  service?: string;
  severityText?: string;
  body?: string;
  timestampMs?: number;
};

export type CorrelationDeviceRow = {
  deviceId: string;
  online?: boolean;
  lastSeenAt?: string | null;
};

export type CorrelationEvidence = { ref: string; kind: string; label: string };

export type IncidentCorrelation = {
  window: { fromMs: number; toMs: number };
  evidence: CorrelationEvidence[];
  summary: string;
};

export function buildIncidentCorrelation(input: {
  incident: CorrelatedIncident;
  anomalies: SeriesAnomaly[];
  errorLogs: CorrelationLogRow[];
  offlineDevices: CorrelationDeviceRow[];
  nowMs: number;
  /** 证据清单上限，默认 12 */
  limit?: number;
}): IncidentCorrelation {
  const firstSeenMs = Date.parse(input.incident.firstSeenAt);
  const fromMs = Number.isFinite(firstSeenMs) ? firstSeenMs : input.nowMs - 60 * 60_000;
  const window = { fromMs, toMs: input.nowMs };
  const evidence: CorrelationEvidence[] = [];

  for (const anomaly of input.anomalies.slice(0, 4)) {
    evidence.push({
      ref: `metric:${anomaly.metric}`,
      kind: 'metric-anomaly',
      label: `${anomaly.metric} 最新 ${anomaly.value} 偏离基线 ${anomaly.baseline}±${anomaly.deviation}（z=${anomaly.score}）`,
    });
  }
  for (const log of input.errorLogs.slice(0, 4)) {
    evidence.push({
      ref: `log:${log.timestampMs ?? 0}:${(log.service ?? 'unknown').slice(0, 60)}`,
      kind: 'log-error',
      label: `[${(log.severityText ?? 'ERROR').toUpperCase()}] ${(log.service ?? 'unknown')}: ${(log.body ?? '').slice(0, 120)}`,
    });
  }
  for (const device of input.offlineDevices.slice(0, 4)) {
    evidence.push({
      ref: `device:${device.deviceId}`,
      kind: 'device-offline',
      label: `边缘设备 ${device.deviceId} 离线（最近心跳 ${device.lastSeenAt ?? '从未'}）`,
    });
  }

  const parts: string[] = [];
  if (input.anomalies.length) parts.push(`${input.anomalies.length} 条指标异常`);
  if (input.errorLogs.length) parts.push(`${input.errorLogs.length} 条错误日志`);
  if (input.offlineDevices.length) parts.push(`${input.offlineDevices.length} 台离线设备`);
  const summary = parts.length
    ? `事故「${input.incident.title}」窗口内关联到：${parts.join('、')}。`
    : `事故「${input.incident.title}」窗口内暂未发现跨信号异常证据（窗口 ${Math.round((input.nowMs - fromMs) / 60_000)} 分钟）。`;

  return { window, evidence: evidence.slice(0, input.limit ?? 12), summary };
}
