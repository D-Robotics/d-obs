/**
 * 指标字典：让"不会 PromQL、不知道有哪些指标"的人也能查。
 *
 * 三个数据面：prometheus（d-obs 自身 /metrics 暴露的运营指标，深度历史在
 * Prometheus）、otlp（用户应用经 OTLP 落库的指标，走平台内指标查询）、
 * pattern（按前缀归类的动态指标，如 rdk_upstream_*）。
 * keywords 是中文/口语关键词，供自然语言查询的确定性匹配层使用——模型通道
 * 关闭或失败时，查询完全靠这一层兜底。
 */

export type MetricPlane = 'prometheus' | 'otlp' | 'pattern';

export type MetricCatalogEntry = {
  metric: string;
  plane: MetricPlane;
  category: string;
  zhName: string;
  description: string;
  labels: string[];
  unit?: string;
  keywords: string[];
};

export const METRIC_CATALOG: MetricCatalogEntry[] = [
  // ===== OTLP 摄取 =====
  {
    metric: 'rdk_ai_otlp_spans_received_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '收到的 Span 总量', unit: '个',
    description: 'OTLP 链路上报累计接收的 span 数量（含后来被拒的）。',
    labels: [], keywords: ['span', '跨度', '链路', '接收', '收到', '总量'],
  },
  {
    metric: 'rdk_ai_otlp_spans_accepted_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '接受的 Span', unit: '个',
    description: '通过低敏感白名单校验、成功入库的 span 数量。',
    labels: [], keywords: ['span', '接受', '入库', '成功'],
  },
  {
    metric: 'rdk_ai_otlp_spans_rejected_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '被拒绝的 Span', unit: '个',
    description: '被低敏感策略、非法 ID 或超限字段拒绝的 span 数量；持续增长说明某应用上报了不合规数据。',
    labels: [], keywords: ['span', '拒绝', '被拒', '拒收', '不合规'],
  },
  {
    metric: 'rdk_ai_otlp_runs_created_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '新建 Run 数', unit: '次',
    description: '由 OTLP trace 摄取物化出来的 run（一次 Agent/服务运行）数量。',
    labels: [], keywords: ['run', '运行', '次数', 'agent'],
  },
  {
    metric: 'rdk_ai_otlp_metric_points_received_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '收到的指标点', unit: '个',
    description: 'OTLP metrics 上报累计接收的数据点数量。',
    labels: [], keywords: ['指标', '数据点', '接收', 'metrics'],
  },
  {
    metric: 'rdk_ai_otlp_log_records_received_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '收到的日志条数', unit: '条',
    description: 'OTLP logs 上报累计接收的日志记录数量。',
    labels: [], keywords: ['日志', 'log', '接收', '收到'],
  },
  {
    metric: 'rdk_ai_otlp_log_records_accepted_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '接受的日志条数', unit: '条',
    description: '通过白名单校验、成功落库的日志记录数量。',
    labels: [], keywords: ['日志', 'log', '接受', '入库'],
  },
  {
    metric: 'rdk_ai_otlp_log_records_rejected_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: '被拒绝的日志条数', unit: '条',
    description: '被低敏感策略或超限拒绝的日志记录数量。',
    labels: [], keywords: ['日志', 'log', '拒绝', '被拒'],
  },
  {
    metric: 'rdk_ai_otlp_traces_request_errors_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: 'Trace 请求错误', unit: '次',
    description: 'OTLP trace 请求在摄取前被整体拒绝（如鉴权失败、payload 非法）的次数。',
    labels: [], keywords: ['trace', '请求错误', '失败', '400'],
  },
  {
    metric: 'rdk_ai_otlp_metrics_request_errors_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: 'Metrics 请求错误', unit: '次',
    description: 'OTLP metrics 请求在摄取前被整体拒绝的次数；常见原因是 SDK 报文格式不被理解。',
    labels: [], keywords: ['metrics', '指标请求', '请求错误', '失败'],
  },
  {
    metric: 'rdk_ai_otlp_logs_request_errors_total', plane: 'prometheus', category: 'OTLP 摄取',
    zhName: 'Logs 请求错误', unit: '次',
    description: 'OTLP logs 请求在摄取前被整体拒绝的次数。',
    labels: [], keywords: ['log', '日志请求', '请求错误', '失败'],
  },
  // ===== 队列与持久化 =====
  {
    metric: 'rdk_observability_metric_queue_depth', plane: 'prometheus', category: '队列与持久化',
    zhName: '指标落库队列深度', unit: '条',
    description: '异步指标持久化队列当前积压数量；持续 >0 说明落库慢或卡住，正常应在 0 附近波动。',
    labels: [], keywords: ['队列', '积压', '堆积', '深度', '落库', '卡'],
  },
  {
    metric: 'rdk_observability_metric_queue_dropped_total', plane: 'prometheus', category: '队列与持久化',
    zhName: '指标落库丢弃数', unit: '个',
    description: '队列满或写库连续失败时被丢弃的指标点数量；增长意味着指标数据在丢失。',
    labels: [], keywords: ['队列', '丢弃', '丢数据', '丢失', '丢点'],
  },
  {
    metric: 'rdk_ai_upstream_metric_points_dropped_total', plane: 'prometheus', category: '队列与持久化',
    zhName: '上游指标点超限丢弃', unit: '个',
    description: '超过有界上游序列上限后被拒绝的指标点数量。',
    labels: [], keywords: ['上游', '超限', '丢弃', '上限'],
  },
  // ===== 摄取时延（直方图） =====
  {
    metric: 'rdk_ai_otlp_trace_ingest_duration_ms', plane: 'prometheus', category: '摄取时延',
    zhName: 'Trace 摄取耗时', unit: 'ms',
    description: '单次 OTLP trace 摄取（含校验与入库路径）的耗时直方图。',
    labels: ['le'], keywords: ['trace', '摄取', '耗时', '延迟', '慢'],
  },
  {
    metric: 'rdk_ai_otlp_metric_ingest_duration_ms', plane: 'prometheus', category: '摄取时延',
    zhName: 'Metrics 摄取耗时', unit: 'ms',
    description: '单次 OTLP metrics 摄取的耗时直方图。',
    labels: ['le'], keywords: ['metrics', '指标', '摄取', '耗时', '延迟'],
  },
  // ===== 动态模式 =====
  {
    metric: 'rdk_upstream_*', plane: 'pattern', category: '上游业务指标',
    zhName: '上游应用指标镜像',
    description: '用户应用经 OTLP 上报的每个指标都会镜像为 rdk_upstream_<指标名>（当前值）与 rdk_upstream_<指标名>_samples_total（样本计数），保留 PromQL 长历史。',
    labels: ['service', 'route', 'host', 'device'], keywords: ['上游', '镜像', '业务指标'],
  },
  {
    metric: 'rdk_edge_device_*', plane: 'pattern', category: '边缘设备',
    zhName: '边缘设备指标',
    description: '每台在线边缘设备的心跳与最新样本（CPU/内存/温度/磁盘等）经 /edge-metrics 暴露，标签带设备身份。',
    labels: ['device', 'tenant', 'model'], keywords: ['设备', '板子', '边缘', '心跳', '温度', 'cpu', '内存'],
  },
  // ===== 平台内 OTLP 落库（数据面说明） =====
  {
    metric: 'otlp://<用户应用指标>', plane: 'otlp', category: '应用指标（平台内查询）',
    zhName: '应用 OTLP 指标',
    description: '接入应用（如 checkout-api、ml-inference-svc）上报的指标落在平台内，按 service/环境标签直接画折线，默认保留 14 天；在下方指标查询输入指标名即可，不必经过 Prometheus。',
    labels: ['service', 'environment', 'route', 'model', 'provider'], keywords: ['应用', '服务', '接口', '业务', '请求量', '耗时', 'token'],
  },
];

const CATALOG_BY_METRIC = new Map(METRIC_CATALOG.map((entry) => [entry.metric, entry]));

export function catalogEntry(metric: string): MetricCatalogEntry | null {
  return CATALOG_BY_METRIC.get(metric) ?? null;
}

export type WindowParseResult = { minutes: number; matchedText: string | null };

/** 从中文问题里解析时间窗口："最近30分钟"/"过去2小时"/"近7天"；默认 240 分钟。 */
export function parseWindowMinutes(question: string, fallback = 240): WindowParseResult {
  const match = /(?:最近|近|过去|过去)\s*(\d{1,6})\s*(分钟|分钟内|个小时|小时|天|日)/.exec(question)
    ?? /(\d{1,6})\s*(分钟|个小时|小时|天|日)(?:内|以来)/.exec(question);
  if (!match) return { minutes: fallback, matchedText: null };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return { minutes: fallback, matchedText: null };
  const unit = match[2];
  const minutes = unit === '分钟' || unit === '分钟内'
    ? amount
    : unit === '个小时' || unit === '小时'
      ? amount * 60
      : amount * 24 * 60;
  const clamped = Math.max(5, Math.min(20_160, Math.trunc(minutes)));
  return { minutes: clamped, matchedText: match[0] };
}

export type CatalogMatch = { entry: MetricCatalogEntry; score: number };

/** 确定性匹配：关键词命中计分，返回按分数排序的候选（供规则层与模型校验共用）。 */
export function matchMetricCatalog(question: string, limit = 3): CatalogMatch[] {
  const q = question.toLowerCase();
  const scored: CatalogMatch[] = [];
  for (const entry of METRIC_CATALOG) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (q.includes(keyword.toLowerCase())) score += keyword.length >= 2 ? 2 : 1;
    }
    if (q.includes(entry.metric.toLowerCase())) score += 4;
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
