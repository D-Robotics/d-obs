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
