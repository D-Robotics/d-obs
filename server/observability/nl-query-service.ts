/**
 * 自然语言 → 指标查询。
 *
 * 两层：确定性关键词层永远先跑（字典匹配 + 时间窗口解析 + 平台内落库序列
 * 索引）；模型通道（复用事故副驾的模型池主路由）可用且规则层拿不准时，让
 * 模型把问题转成严格查询 spec——输出逐字段校验：指标必须在目录或已知落库
 * 序列里、聚合在白名单内、标签键必须属于该指标，任何不合法都回落规则层。
 */
import {
  METRIC_CATALOG,
  catalogEntry,
  matchMetricCatalog,
  parseWindowMinutes,
  type MetricCatalogEntry,
} from './metric-dictionary.js';
import { callGatewayChat, copilotModelEnabled, extractJson, resolveGatewayChatTarget } from './copilot-model.js';

export type NlQueryAgg = 'latest' | 'avg' | 'max' | 'rate' | 'p95';

export type NlQuerySpec = {
  metric: string;
  plane: 'prometheus' | 'otlp';
  agg: NlQueryAgg;
  windowMinutes: number;
  labels: Record<string, string>;
  explanation: string;
};

export type NlQueryResult = {
  source: 'rules' | 'model';
  question: string;
  spec: NlQuerySpec;
  promql: string | null;
  alternatives: Array<{ metric: string; zhName: string }>;
  notice: string | null;
};

const AGGS = new Set<NlQueryAgg>(['latest', 'avg', 'max', 'rate', 'p95']);

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// ===== PromQL 生成 =====

// Prometheus 计数器以 _total 结尾；OTLP 指标天生带点号（checkout.requests.total）。
function isCounterMetric(metric: string): boolean {
  return /(^|[._])total$/.test(metric);
}

export function promqlForSpec(spec: NlQuerySpec): string {
  const selector = Object.keys(spec.labels).length
    ? `{${Object.entries(spec.labels).map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`).join(',')}}`
    : '';
  const rateWindow = `${Math.max(5, Math.min(60, spec.windowMinutes))}m`;
  if (isCounterMetric(spec.metric)) return `sum(increase(${spec.metric}${selector}[${rateWindow}]))`;
  if (spec.agg === 'p95' || /(_ms|duration)$/.test(spec.metric)) {
    return `histogram_quantile(0.95, sum by (le) (rate(${spec.metric}_bucket${selector}[${rateWindow}])))`;
  }
  if (spec.agg === 'max') return `max_over_time(${spec.metric}${selector}[${rateWindow}])`;
  if (spec.agg === 'avg') return `avg_over_time(${spec.metric}${selector}[${rateWindow}])`;
  return `${spec.metric}${selector}`;
}

// ===== 规则层 =====

const AGG_HINTS: Array<{ agg: NlQueryAgg; words: string[] }> = [
  { agg: 'p95', words: ['p95', 'p90', '分位', '尾延迟'] },
  { agg: 'rate', words: ['速率', '增长率', '每分钟', '每秒', '趋势', '增长'] },
  { agg: 'max', words: ['最大', '峰值', '最高'] },
  { agg: 'avg', words: ['平均', '均值', '多少', '几个'] },
];

function aggFromQuestion(question: string, entry: MetricCatalogEntry): NlQueryAgg {
  const q = question.toLowerCase();
  for (const hint of AGG_HINTS) {
    if (hint.words.some((word) => q.includes(word))) return hint.agg;
  }
  if (isCounterMetric(entry.metric)) return 'rate';
  if (/(_ms|duration)$/.test(entry.metric)) return 'p95';
  return 'latest';
}

export type OtlpSeriesIndexEntry = { metric: string; service: string };

const SERVICE_METRIC_HINTS: Array<{ agg: NlQueryAgg; match: RegExp; words: string[] }> = [
  { agg: 'p95', match: /duration|latency|_ms/, words: ['p95', '分位', '尾延迟', '慢'] },
  { agg: 'avg', match: /duration|latency|_ms/, words: ['耗时', '延迟'] },
  { agg: 'rate', match: /total|count|requests/, words: ['请求量', '调用量', '次数', '速率', 'qps', '多少'] },
];

function specFromRules(
  question: string,
  seriesIndex: OtlpSeriesIndexEntry[],
): { spec: NlQuerySpec; alternatives: Array<{ metric: string; zhName: string }> } | null {
  const { minutes } = parseWindowMinutes(question);
  const lower = question.toLowerCase();
  // 用户应用指标：问题里直接出现落库指标名（OTLP 指标带点号）→ 精确命中，最强信号。
  const metricHit = seriesIndex.find((row) => row.metric && lower.includes(row.metric.toLowerCase()));
  if (metricHit) {
    const serviceHit = seriesIndex.find((row) => row.service && lower.includes(row.service.toLowerCase()));
    return {
      spec: {
        metric: metricHit.metric,
        plane: 'otlp',
        agg: isCounterMetric(metricHit.metric) ? 'rate' : 'avg',
        windowMinutes: minutes,
        labels: serviceHit ? { service: serviceHit.service } : {},
        explanation: `问题中出现了落库指标 ${metricHit.metric}，直接查询平台内序列。`,
      },
      alternatives: [],
    };
  }
  // 问题里提到某个已知 service 名 → otlp 平台内查询。
  const service = seriesIndex.find((row) => row.service && lower.includes(row.service.toLowerCase()));
  if (service) {
    const candidates = seriesIndex.filter((row) => row.service === service.service);
    for (const hint of SERVICE_METRIC_HINTS) {
      if (!hint.words.some((word) => lower.includes(word))) continue;
      const metric = candidates.find((row) => hint.match.test(row.metric))?.metric;
      if (metric) {
        return {
          spec: {
            metric, plane: 'otlp', agg: hint.agg, windowMinutes: minutes,
            labels: { service: service.service },
            explanation: `问题提到了服务 ${service.service}，查询平台内落库的 ${metric}。`,
          },
          alternatives: [],
        };
      }
    }
  }
  const matches = matchMetricCatalog(question);
  if (matches.length) {
    const best = matches[0].entry;
    if (best.plane === 'otlp') return null;
    return {
      spec: {
        metric: best.metric,
        plane: 'prometheus',
        agg: aggFromQuestion(question, best),
        windowMinutes: minutes,
        labels: {},
        explanation: `${best.zhName}：${best.description}`,
      },
      alternatives: matches.slice(1).map((m) => ({ metric: m.entry.metric, zhName: m.entry.zhName })),
    };
  }
  return null;
}

// ===== 模型层 =====

function buildModelPrompt(question: string, seriesIndex: OtlpSeriesIndexEntry[]): string {
  const catalog = [
    '可用指标（只能从中选择）：',
    ...METRIC_CATALOG.map((entry) => `- ${entry.metric} | plane=${entry.plane} | ${entry.zhName} | ${entry.description} | 标签:${entry.labels.join(',') || '无'}`),
    seriesIndex.length ? '\n平台内落库序列（plane=otlp，metric 需完全一致）：' : '',
    ...seriesIndex.slice(0, 60).map((row) => `- ${row.metric} | service=${row.service}`),
  ].filter(Boolean).join('\n');
  const rules = [
    '输出严格 JSON，不要多余文字：',
    '{"metric":"指标名","plane":"prometheus|otlp","agg":"latest|avg|max|rate|p95","windowMinutes":数字,"labels":{"标签":"值"},"explanation":"一句话中文解释"}',
    'metric 必须来自上面列表，不得编造；labels 的键必须属于该指标的标签；无法确定时输出 {"metric":"","explanation":"无法确定"}。',
  ].join('\n');
  return `${catalog}\n\n${rules}\n\n用户问题：${cleanText(question, 500)}`;
}

function validateModelSpec(raw: unknown, seriesIndex: OtlpSeriesIndexEntry[]): NlQuerySpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const metric = cleanText(row.metric, 200);
  // OTLP 指标名允许点号（gen_ai.client.token.usage 等）；Prometheus 名不含点。
  if (!metric || !/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(metric)) return null;
  const known = catalogEntry(metric);
  if (known && known.plane === 'pattern') return null;
  const inSeries = seriesIndex.some((s) => s.metric === metric);
  const plane: NlQuerySpec['plane'] = known
    ? (known.plane === 'otlp' ? 'otlp' : 'prometheus')
    : (inSeries ? 'otlp' : 'prometheus');
  if (!known && !inSeries) return null;
  if (known && known.plane === 'otlp' && row.plane === 'prometheus') return null;
  const agg = AGGS.has(row.agg as NlQueryAgg) ? row.agg as NlQueryAgg : (isCounterMetric(metric) ? 'rate' : 'avg');
  const windowRaw = Number(row.windowMinutes);
  const windowMinutes = Number.isFinite(windowRaw) ? Math.max(5, Math.min(20_160, Math.trunc(windowRaw))) : 240;
  const labels: Record<string, string> = {};
  if (row.labels && typeof row.labels === 'object' && !Array.isArray(row.labels)) {
    for (const [key, value] of Object.entries(row.labels as Record<string, unknown>).slice(0, 8)) {
      if (known && !known.labels.includes(key)) continue;
      const cleaned = cleanText(value, 120);
      if (cleaned) labels[key.slice(0, 64)] = cleaned;
    }
  }
  return {
    metric, plane, agg, windowMinutes, labels,
    explanation: cleanText(row.explanation, 400) || '模型生成的查询。',
  };
}

async function modelSpec(question: string, seriesIndex: OtlpSeriesIndexEntry[]): Promise<NlQuerySpec | null> {
  if (!copilotModelEnabled()) return null;
  try {
    const target = await resolveGatewayChatTarget();
    if (!target) return null;
    const content = await callGatewayChat(
      target,
      [
        { role: 'system', content: '你是可观测平台的查询助手，把中文自然语言转成一次指标查询。只输出 JSON。' },
        { role: 'user', content: buildModelPrompt(question, seriesIndex) },
      ],
      12_000,
    );
    return validateModelSpec(extractJson(content), seriesIndex);
  } catch {
    return null;
  }
}

// ===== 入口 =====

export async function nlQuery(
  question: string,
  seriesIndex: OtlpSeriesIndexEntry[],
): Promise<NlQueryResult> {
  const q = cleanText(question, 500);
  if (!q) throw new Error('nl_query_empty');
  const rules = specFromRules(q, seriesIndex);
  const modeled = rules ? null : await modelSpec(q, seriesIndex);
  const chosen = modeled ?? rules?.spec ?? null;
  if (!chosen) {
    // 规则与模型都没命中：回落字典里最泛的入口提示，而不是硬失败。
    const fallback = catalogEntry('otlp://<用户应用指标>');
    if (!fallback) throw new Error('nl_query_no_match');
    return {
      source: 'rules',
      question: q,
      spec: {
        metric: '', plane: 'otlp', agg: 'avg', windowMinutes: parseWindowMinutes(q).minutes,
        labels: {}, explanation: '无法定位到具体指标，请在指标字典里浏览或直接输入指标名。',
      },
      promql: null,
      alternatives: [],
      notice: '未能识别目标指标；可换一种问法，或在指标字典里直接选择。',
    };
  }
  return {
    source: modeled ? 'model' : 'rules',
    question: q,
    spec: chosen,
    promql: chosen.metric && chosen.plane === 'prometheus' ? promqlForSpec(chosen) : null,
    alternatives: modeled ? [] : rules?.alternatives ?? [],
    notice: null,
  };
}
