type UpstreamMetric = {
  value: number;
  samples: number;
  lastTimestampMs: number;
};

const counters = new Map<string, number>();
const upstreamMetrics = new Map<string, UpstreamMetric>();

function increment(name: string, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

function metricName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^[^a-zA-Z_:]+/, '').slice(0, 96);
  return normalized || 'unknown';
}

export function recordOtlpTraceIngest(input: {
  received: number;
  accepted: number;
  rejected: number;
  runs: number;
}): void {
  increment('rdk_ai_otlp_spans_received_total', input.received);
  increment('rdk_ai_otlp_spans_accepted_total', input.accepted);
  increment('rdk_ai_otlp_spans_rejected_total', input.rejected);
  increment('rdk_ai_otlp_runs_created_total', input.runs);
  if (input.rejected > 0) increment('rdk_ai_otlp_ingest_errors_total');
}

export function recordOtlpMetricIngest(accepted: number): void {
  increment('rdk_ai_otlp_metric_points_received_total', accepted);
}

export function recordOtlpRequestError(signal: 'traces' | 'metrics'): void {
  increment(`rdk_ai_otlp_${signal}_request_errors_total`);
}

export function recordUpstreamMetric(name: string, value: number, timestampMs = Date.now()): void {
  const normalizedName = metricName(name);
  if (!Number.isFinite(value) || upstreamMetrics.size >= 256 && !upstreamMetrics.has(normalizedName)) return;
  const current = upstreamMetrics.get(normalizedName) ?? { value: 0, samples: 0, lastTimestampMs: timestampMs };
  current.value = value;
  current.samples += 1;
  current.lastTimestampMs = timestampMs;
  upstreamMetrics.set(normalizedName, current);
}

function help(name: string, description: string, type: 'counter' | 'gauge'): string {
  return `# HELP ${name} ${description}\n# TYPE ${name} ${type}`;
}

/** Prometheus exposition format; names are bounded to avoid exporter cardinality surprises. */
export function renderPrometheusMetrics(): string {
  const lines = [
    '# d-obs AI-native observability metrics',
    help('rdk_ai_otlp_spans_received_total', 'OTLP trace spans received by d-obs.', 'counter'),
    `rdk_ai_otlp_spans_received_total ${counters.get('rdk_ai_otlp_spans_received_total') ?? 0}`,
    help('rdk_ai_otlp_spans_accepted_total', 'OTLP trace spans accepted by d-obs.', 'counter'),
    `rdk_ai_otlp_spans_accepted_total ${counters.get('rdk_ai_otlp_spans_accepted_total') ?? 0}`,
    help('rdk_ai_otlp_spans_rejected_total', 'OTLP trace spans rejected by d-obs.', 'counter'),
    `rdk_ai_otlp_spans_rejected_total ${counters.get('rdk_ai_otlp_spans_rejected_total') ?? 0}`,
    help('rdk_ai_otlp_runs_created_total', 'Runs materialized from OTLP trace ingestion.', 'counter'),
    `rdk_ai_otlp_runs_created_total ${counters.get('rdk_ai_otlp_runs_created_total') ?? 0}`,
    help('rdk_ai_otlp_metric_points_received_total', 'OTLP metric data points received by d-obs.', 'counter'),
    `rdk_ai_otlp_metric_points_received_total ${counters.get('rdk_ai_otlp_metric_points_received_total') ?? 0}`,
    help('rdk_ai_otlp_traces_request_errors_total', 'OTLP trace requests rejected before ingestion.', 'counter'),
    `rdk_ai_otlp_traces_request_errors_total ${counters.get('rdk_ai_otlp_traces_request_errors_total') ?? 0}`,
    help('rdk_ai_otlp_metrics_request_errors_total', 'OTLP metric requests rejected before ingestion.', 'counter'),
    `rdk_ai_otlp_metrics_request_errors_total ${counters.get('rdk_ai_otlp_metrics_request_errors_total') ?? 0}`,
  ];
  for (const [name, metric] of [...upstreamMetrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const exported = `rdk_upstream_${name}`;
    lines.push(help(exported, `Latest value received for upstream OTLP metric ${name}.`, 'gauge'));
    lines.push(`${exported} ${Number.isFinite(metric.value) ? metric.value : 0}`);
    lines.push(help(`${exported}_samples_total`, `Number of samples received for upstream OTLP metric ${name}.`, 'counter'));
    lines.push(`${exported}_samples_total ${metric.samples}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetAiEcosystemMetricsForTest(): void {
  counters.clear();
  upstreamMetrics.clear();
}
