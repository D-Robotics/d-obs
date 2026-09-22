/**
 * 业务指标 Prometheus 抓取端点的渲染层：把平台内 OTLP 落库序列的最新值
 * 输出为 exposition 格式，供 Prometheus 抓取（业务指标进 Grafana 的通道）。
 * 指标名加 otlp_ 前缀并净化（OTLP 点号名 → 下划线），避免与自监控指标冲突。
 */

export type BusinessMetricSeries = {
  metric: string;
  labels: Record<string, unknown>;
  lastValue: number | null;
  lastTsMs: number | null;
};

export function prometheusMetricName(value: string): string {
  const sanitized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_:]/g, '_')
    .replace(/^[^a-zA-Z_:]+/, '')
    .slice(0, 120);
  return sanitized ? `otlp_${sanitized}` : '';
}

function escapeLabelValue(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function prometheusLabelName(value: string): string {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[^a-zA-Z_]/, '')
    .slice(0, 120) || 'label';
}

export function renderBusinessMetricsExposition(series: BusinessMetricSeries[]): string {
  const lines: string[] = [];
  const families = new Map<string, number>();
  for (const item of series) {
    if (!item || item.lastValue == null || !Number.isFinite(item.lastValue)) continue;
    const name = prometheusMetricName(item.metric);
    if (!name) continue;
    const labelPairs = Object.entries(item.labels ?? {})
      .filter(([, value]) => value != null && value !== '')
      .map(([key, value]) => `${prometheusLabelName(key)}="${escapeLabelValue(String(value))}"`);
    if (!families.has(name)) {
      families.set(name, 1);
      lines.push(`# HELP ${name} OTLP business metric (latest sample, source: ${item.metric}).`);
      lines.push(`# TYPE ${name} gauge`);
    }
    const labels = labelPairs.length ? `{${labelPairs.join(',')}}` : '';
    lines.push(`${name}${labels} ${item.lastValue}`);
  }
  lines.push('');
  return lines.join('\n');
}
