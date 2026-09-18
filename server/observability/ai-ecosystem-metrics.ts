type UpstreamMetric = {
  value: number;
  samples: number;
  lastTimestampMs: number;
  labels: Record<string, string>;
};

const counters = new Map<string, number>();
const upstreamMetrics = new Map<string, UpstreamMetric>();
const MAX_UPSTREAM_SERIES = 256;

const LABEL_ALIASES: Record<string, string> = {
  'service.name': 'service',
  'service.version': 'version',
  'deployment.environment.name': 'environment',
  'gen_ai.system': 'provider',
  'gen_ai.provider.name': 'provider',
  'gen_ai.request.model': 'model',
  'gen_ai.response.model': 'model',
  'project.id': 'project',
  'http.route': 'route',
};

function increment(name: string, value = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

function metricName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^[^a-zA-Z_:]+/, '').slice(0, 96);
  return normalized || 'unknown';
}

function labelValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).replace(/[\0\n\r]/g, '').slice(0, 96)
    : '';
}

/** Map only stable, low-cardinality OTLP attributes into Prometheus labels. */
export function normalizeMetricLabels(attributes: Record<string, unknown>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(attributes)) {
    const alias = LABEL_ALIASES[key] ?? (Object.values(LABEL_ALIASES).includes(key) ? key : undefined);
    if (!alias) continue;
    const value = labelValue(rawValue);
    if (value) labels[alias] = value;
  }
  return labels;
}

function seriesKey(name: string, labels: Record<string, string>): string {
  return `${name}\u0000${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\u0001')}`;
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

export function recordUpstreamMetric(name: string, value: number, timestampMs = Date.now(), labels: Record<string, string> = {}): void {
  const normalizedName = metricName(name);
  const normalizedLabels = normalizeMetricLabels(labels);
  const key = seriesKey(normalizedName, normalizedLabels);
  if (!Number.isFinite(value) || upstreamMetrics.size >= MAX_UPSTREAM_SERIES && !upstreamMetrics.has(key)) return;
  const current = upstreamMetrics.get(key) ?? { value: 0, samples: 0, lastTimestampMs: timestampMs, labels: normalizedLabels };
  current.value = value;
  current.samples += 1;
  current.lastTimestampMs = timestampMs;
  upstreamMetrics.set(key, current);
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
  const renderedNames = new Set<string>();
  for (const [key, metric] of [...upstreamMetrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = key.split('\u0000', 1)[0] || 'unknown';
    const exported = `rdk_upstream_${name}`;
    if (!renderedNames.has(exported)) {
      lines.push(help(exported, `Latest value received for upstream OTLP metric ${name}.`, 'gauge'));
      lines.push(help(`${exported}_samples_total`, `Number of samples received for upstream OTLP metric ${name}.`, 'counter'));
      renderedNames.add(exported);
    }
    const labels = Object.entries(metric.labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => `${label}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
      .join(',');
    const suffix = labels ? `{${labels}}` : '';
    lines.push(`${exported}${suffix} ${Number.isFinite(metric.value) ? metric.value : 0}`);
    lines.push(`${exported}_samples_total${suffix} ${metric.samples}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetAiEcosystemMetricsForTest(): void {
  counters.clear();
  upstreamMetrics.clear();
}
