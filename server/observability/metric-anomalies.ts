/**
 * 指标统计异常检测 v1：对每条序列取"最后一个点 vs 之前窗口"的 z-score。
 * 纯函数、即时计算（无状态、无模型）——适合作为第一层粗筛，命中后再人工下钻。
 */

export type SeriesPoints = {
  metric: string;
  labels: Record<string, string>;
  points: Array<{ ts: number; value: number }>;
};

export type SeriesAnomaly = {
  metric: string;
  labels: Record<string, string>;
  value: number;
  baseline: number;
  deviation: number;
  score: number;
  ts: number;
  sampleSize: number;
};

export type AnomalyDetectOptions = {
  /** z-score 阈值，默认 3.5（粗筛宁缺勿滥） */
  threshold?: number;
  /** 基线至少需要的点数，默认 10 */
  minBaseline?: number;
};

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function detectSeriesAnomalies(series: SeriesPoints[], options: AnomalyDetectOptions = {}): SeriesAnomaly[] {
  const threshold = Number.isFinite(options.threshold) && options.threshold! > 0 ? options.threshold! : 3.5;
  const minBaseline = Number.isFinite(options.minBaseline) && options.minBaseline! >= 2 ? options.minBaseline! : 10;
  const anomalies: SeriesAnomaly[] = [];
  for (const item of series) {
    const points = [...(item.points ?? [])].filter((point) => Number.isFinite(point.value)).sort((a, b) => a.ts - b.ts);
    if (points.length < minBaseline + 1) continue;
    const baselinePoints = points.slice(0, -1).map((point) => point.value);
    const last = points[points.length - 1];
    const avg = mean(baselinePoints);
    const deviation = stdDev(baselinePoints, avg);
    if (deviation <= 0) continue;
    const score = Math.abs(last.value - avg) / deviation;
    if (score < threshold) continue;
    anomalies.push({
      metric: item.metric,
      labels: item.labels ?? {},
      value: last.value,
      baseline: Math.round(avg * 1000) / 1000,
      deviation: Math.round(deviation * 1000) / 1000,
      score: Math.round(score * 100) / 100,
      ts: last.ts,
      sampleSize: baselinePoints.length,
    });
  }
  return anomalies.sort((a, b) => b.score - a.score);
}

// ===== 带存储的扫描（供告警 worker / anomalies 路由 / 事故关联共用） =====

import { queryMetricRanges, queryMetricSeries } from './ai-ecosystem-metrics-store.js';

export type ScanMetricAnomaliesOptions = {
  windowMinutes: number;
  /** z 阈值；缺省 3.5 */
  threshold?: number;
  /** 扫描样本数最多的前 N 个指标，默认 20 */
  metricsLimit?: number;
  maxPoints?: number;
};

/** 扫描落库指标窗口内异常，按 z 分数降序。存储不可用时抛错由调用方决定降级。 */
export async function scanRecentMetricAnomalies(options: ScanMetricAnomaliesOptions): Promise<SeriesAnomaly[]> {
  const metricsLimit = options.metricsLimit ?? 20;
  const maxPoints = options.maxPoints ?? 120;
  const seriesList = await queryMetricSeries({ limit: 500 });
  const byMetric = new Map<string, number>();
  for (const row of seriesList) byMetric.set(row.metric, (byMetric.get(row.metric) ?? 0) + 1);
  const metrics = [...byMetric.entries()].sort((a, b) => b[1] - a[1]).slice(0, metricsLimit).map(([metric]) => metric);
  if (!metrics.length) return [];
  const to = Date.now();
  const from = to - options.windowMinutes * 60_000;
  const perMetric = await Promise.all(
    metrics.map((metric) =>
      queryMetricRanges({ metric, fromMs: from, toMs: to, maxPoints }).catch(() => []),
    ),
  );
  return detectSeriesAnomalies(
    perMetric.flatMap((ranges, index) =>
      (ranges as Array<{ labels?: unknown; points?: Array<{ ts: number; value: number }> }>).map((item) => ({
        metric: metrics[index],
        labels: (item.labels ?? {}) as Record<string, string>,
        points: item.points ?? [],
      })),
    ),
    { threshold: options.threshold },
  );
}
