import { normalizeBoardSpec, type BoardSpec } from './dashboard-boards-store.js';

export type DashboardTemplate = { id: string; name: string; description: string; spec: BoardSpec };
function panel(title: string, expr: string, unit = 'short', chart = 'line') {
  return { title, metric: '', source: 'prometheus', queries: [{ refId: 'A', expr }], unit, chart, reducer: 'last', width: 1 };
}
/** Metric names come from metric-dictionary.ts and shipped ops/grafana dashboards. */
export function listDashboardTemplates(): DashboardTemplate[] {
  const definitions = [
    { id: 'otlp-ingress', name: 'OTLP 接入健康', description: '接收速率、拒绝量和摄取时延；需要已配置的 Prometheus 数据源。', panels: [
      { ...panel('信号接收速率', 'sum(rate(rdk_ai_otlp_metric_points_received_total[$__rate_interval]))', 'ops'), queries: [
        { refId: 'A', expr: 'sum(rate(rdk_ai_otlp_metric_points_received_total[$__rate_interval]))', legendFormat: '指标点/s' },
        { refId: 'B', expr: 'sum(rate(rdk_ai_otlp_spans_accepted_total[$__rate_interval]))', legendFormat: 'Span/s' },
        { refId: 'C', expr: 'sum(rate(rdk_ai_otlp_log_records_accepted_total[$__rate_interval]))', legendFormat: '日志条/s' },
      ], width: 2 },
      panel('Trace 拒绝速率', 'sum(rate(rdk_ai_otlp_spans_rejected_total[$__rate_interval]))', 'ops'),
      panel('Trace 摄取 P95', 'histogram_quantile(0.95, sum by (le) (rate(rdk_ai_otlp_trace_ingest_duration_ms_bucket[$__rate_interval])))', 'ms'),
    ] },
    { id: 'metric-persistence', name: '指标持久化', description: '落库积压、丢弃与摄取性能；使用平台实际暴露的指标。', panels: [
      panel('落库队列深度', 'max(rdk_observability_metric_queue_depth)', 'short', 'stat'),
      panel('当前窗口丢弃点数', 'sum(increase(rdk_observability_metric_queue_dropped_total[$__range]))', 'short', 'stat'),
      panel('落库丢弃速率', 'sum(rate(rdk_observability_metric_queue_dropped_total[$__rate_interval]))', 'ops'),
      panel('Metrics 摄取 P95', 'histogram_quantile(0.95, sum by (le) (rate(rdk_ai_otlp_metric_ingest_duration_ms_bucket[$__rate_interval])))', 'ms'),
    ] },
    { id: 'edge-fleet', name: '边缘设备在线与新鲜度', description: '设备在线率、设备数和采样年龄；对应已提供的 edge-fleet 看板指标。', panels: [
      panel('设备在线率', '100 * max(rdk_edge_devices_online_total) / clamp_min(max(rdk_edge_devices_total), 1)', 'percent', 'stat'),
      panel('在线设备数', 'max(rdk_edge_devices_online_total)', 'short', 'stat'),
      { ...panel('设备在线状态', 'rdk_edge_device_online', 'short'), queries: [{ refId: 'A', expr: 'rdk_edge_device_online', legendFormat: '{{instance}}' }], width: 2 },
      { ...panel('设备采样年龄', 'rdk_edge_device_sample_age_seconds', 's'), queries: [{ refId: 'A', expr: 'rdk_edge_device_sample_age_seconds', legendFormat: '{{instance}}' }], width: 2 },
    ] },
  ];
  return definitions.map(({ panels, ...definition }) => {
    const spec = normalizeBoardSpec({ windowMinutes: 240, panels });
    if (!spec) throw new Error('invalid_builtin_dashboard_template');
    return { ...definition, spec };
  });
}
