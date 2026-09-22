type UpstreamMetric = {
  value: number;
  samples: number;
  lastTimestampMs: number;
  labels: Record<string, string>;
};

type HistogramData = {
  bounds: number[];
  counts: number[];
  sum: number;
  count: number;
};

const counters = new Map<string, number>();
const upstreamMetrics = new Map<string, UpstreamMetric>();
const histograms = new Map<string, HistogramData>();
const MAX_HISTOGRAMS = 128;
let signalQueueDepth = 0;
let signalQueueDroppedSeen = 0;

/**
 * Fleet metrics need more than the original single-service pilot limit, but
 * the bound must remain explicit so a caller cannot turn arbitrary labels into
 * an unbounded in-memory cardinality sink.  Keep the default conservative and
 * allow operators to tune it per deployment without changing the contract.
 */
function maxUpstreamSeries(): number {
  const configured = Number(process.env.RDK_OBSERVABILITY_MAX_UPSTREAM_SERIES ?? '');
  if (!Number.isFinite(configured)) return 10_000;
  return Math.max(256, Math.min(100_000, Math.floor(configured)));
}

/** 异步落库队列指标（由 metrics-store 摄取路径回调：depth 为当前深度，dropped 为累计值，内部换算增量）。 */
export function recordMetricQueueGauges(depth: number, droppedTotal: number): void {
  signalQueueDepth = Math.max(0, Math.floor(depth));
  if (Number.isFinite(droppedTotal) && droppedTotal > signalQueueDroppedSeen) {
    increment('rdk_observability_metric_queue_dropped_total', droppedTotal - signalQueueDroppedSeen);
    signalQueueDroppedSeen = droppedTotal;
  }
}

/** OTLP 摄取耗时直方图默认分桶（毫秒）：快速路径与慢持久化路径都要看得到。 */
export const DEFAULT_INGEST_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

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
  'robot.id': 'robot',
  'rdk.robot.id': 'robot',
  'robot.serial': 'robot',
  'rdk.robot.serial': 'robot',
  'device.id': 'device',
  'rdk.device.id': 'device',
  'host.id': 'device',
  'host.name': 'host',
  'host.hostname': 'host',
  'site.id': 'site',
  'rdk.site.id': 'site',
  'deployment.site': 'site',
  'firmware.version': 'firmware',
  'rdk.firmware.version': 'firmware',
  'device.firmware.version': 'firmware',
  'model.version': 'model_version',
  'rdk.model.version': 'model_version',
  'gen_ai.response.model.version': 'model_version',
};

export function increment(name: string, value = 1): void {
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

export function recordOtlpLogIngest(input: { received: number; accepted: number; rejected: number }): void {
  increment('rdk_ai_otlp_log_records_received_total', input.received);
  increment('rdk_ai_otlp_log_records_accepted_total', input.accepted);
  increment('rdk_ai_otlp_log_records_rejected_total', input.rejected);
}

export function recordOtlpRequestError(signal: 'traces' | 'metrics' | 'logs'): void {
  increment(`rdk_ai_otlp_${signal}_request_errors_total`);
}

export function recordUpstreamMetric(name: string, value: number, timestampMs = Date.now(), labels: Record<string, string> = {}): void {
  const normalizedName = metricName(name);
  const normalizedLabels = normalizeMetricLabels(labels);
  const key = seriesKey(normalizedName, normalizedLabels);
  if (!Number.isFinite(value)) return;
  if (upstreamMetrics.size >= maxUpstreamSeries() && !upstreamMetrics.has(key)) {
    increment('rdk_ai_upstream_metric_points_dropped_total');
    return;
  }
  const current = upstreamMetrics.get(key) ?? { value: 0, samples: 0, lastTimestampMs: timestampMs, labels: normalizedLabels };
  current.value = value;
  current.samples += 1;
  current.lastTimestampMs = timestampMs;
  upstreamMetrics.set(key, current);
}

/**
 * prom-client 风格的累计直方图：观测值落入升序 bounds 的分桶（含隐式 +Inf），
 * 并累计 _sum/_count。bounds 上限 32 个，超出或非有限值按默认桶处理。
 */
export function observeHistogram(
  name: string,
  value: number,
  options: { buckets?: number[] } = {},
): void {
  if (!Number.isFinite(value)) return;
  const normalizedName = metricName(name);
  const bounds = (options.buckets ?? DEFAULT_INGEST_BUCKETS_MS)
    .filter((bound) => Number.isFinite(bound) && bound > 0)
    .slice(0, 32);
  if (!histograms.has(normalizedName) && histograms.size >= MAX_HISTOGRAMS) return;
  const current = histograms.get(normalizedName) ?? { bounds, counts: new Array<number>(bounds.length).fill(0), sum: 0, count: 0 };
  if (current.bounds.length !== bounds.length) {
    // bounds 来自固定常量，这里只防御调用方传不同长度的数组。
    current.bounds = bounds;
    current.counts = new Array<number>(bounds.length).fill(0);
  }
  for (let index = 0; index < current.bounds.length; index += 1) {
    if (value <= current.bounds[index]) current.counts[index] += 1;
  }
  current.sum += value;
  current.count += 1;
  histograms.set(normalizedName, current);
}

function help(name: string, description: string, type: 'counter' | 'gauge' | 'histogram'): string {
  return `# HELP ${name} ${description}\n# TYPE ${name} ${type}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

const COUNTER_LINES: Array<[string, string]> = [
  ['rdk_ai_otlp_spans_received_total', 'OTLP trace spans received by d-obs.'],
  ['rdk_ai_otlp_spans_accepted_total', 'OTLP trace spans accepted by d-obs.'],
  ['rdk_ai_otlp_spans_rejected_total', 'OTLP trace spans rejected by d-obs.'],
  ['rdk_ai_otlp_runs_created_total', 'Runs materialized from OTLP trace ingestion.'],
  ['rdk_ai_otlp_metric_points_received_total', 'OTLP metric data points received by d-obs.'],
  ['rdk_ai_otlp_log_records_received_total', 'OTLP log records received by d-obs.'],
  ['rdk_ai_otlp_log_records_accepted_total', 'OTLP log records accepted by d-obs.'],
  ['rdk_ai_otlp_log_records_rejected_total', 'OTLP log records rejected by d-obs.'],
  ['rdk_ai_otlp_traces_request_errors_total', 'OTLP trace requests rejected before ingestion.'],
  ['rdk_ai_otlp_metrics_request_errors_total', 'OTLP metric requests rejected before ingestion.'],
  ['rdk_ai_otlp_logs_request_errors_total', 'OTLP log requests rejected before ingestion.'],
  ['rdk_observability_metric_queue_dropped_total', 'OTLP metric points dropped because the async persistence queue was full or the store failed repeatedly.'],
  ['rdk_ai_upstream_metric_points_dropped_total', 'OTLP metric points rejected after the bounded upstream series limit was reached.'],
];

/** Prometheus exposition format; names are bounded to avoid exporter cardinality surprises. */
export function renderPrometheusMetrics(): string {
  const lines = ['# d-obs AI-native observability metrics'];
  for (const [name, description] of COUNTER_LINES) {
    lines.push(help(name, description, 'counter'));
    lines.push(`${name} ${counters.get(name) ?? 0}`);
  }
  for (const [name, histogram] of [...histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(help(name, `Observations for ${name}.`, 'histogram'));
    let cumulative = 0;
    for (let index = 0; index < histogram.bounds.length; index += 1) {
      cumulative = histogram.counts[index];
      lines.push(`${name}_bucket{le="${histogram.bounds[index]}"} ${cumulative}`);
    }
    lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
    lines.push(`${name}_sum ${histogram.sum}`);
    lines.push(`${name}_count ${histogram.count}`);
  }
  lines.push(help('rdk_observability_metric_queue_depth', 'Current depth of the async OTLP metric persistence queue.', 'gauge'));
  lines.push(`rdk_observability_metric_queue_depth ${signalQueueDepth}`);
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
      .map(([label, value]) => `${label}="${escapeLabel(value)}"`)
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
  histograms.clear();
}
