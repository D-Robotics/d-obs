/**
 * Grafana 看板 JSON 兼容层（纯函数，无 IO）。
 * 导入：识别 Grafana dashboard JSON（panels[].type/targets/gridPos、time.from、
 * schemaVersion），映射为 d-obs BoardSpec——PromQL 表达式提取指标名与区间窗口，
 * 含模板变量（$xxx）的表达式跳过；gridPos.w 映射半宽/整行。
 * 导出：把 d-obs 看板映射回 Grafana 可导入的 JSON（targets.expr = 指标名）。
 */

import { normalizeBoardSpec, type BoardPanel, type BoardRecord, type BoardSpec } from './dashboard-boards-store.js';

export type GrafanaImportResult = {
  name: string;
  spec: BoardSpec;
  mapped: number;
  skipped: number;
};

const GRAFANA_TYPE_MAP: Record<string, BoardPanel['chart']> = {
  timeseries: 'line',
  barchart: 'bar',
  bargauge: 'bar',
  stat: 'stat',
  gauge: 'stat',
  table: 'table',
};

const METRIC_TOKEN = /[a-zA-Z_:][a-zA-Z0-9_.:]*/g;
const RANGE_VECTOR = /\[(\d+(?:\.\d+)?)\s*([smhdw])\]/;

// PromQL 函数与关键字：指标名提取时跳过（函数名后随左括号）。
const PROMQL_KEYWORDS = new Set([
  'sum', 'avg', 'min', 'max', 'count', 'count_values', 'stddev', 'stdvar', 'quantile',
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv', 'predict_linear',
  'histogram_quantile', 'histogram_count', 'histogram_sum', 'histogram_fraction',
  'abs', 'absent', 'absent_over_time', 'ceil', 'floor', 'round', 'exp', 'ln', 'log2', 'log10',
  'sqrt', 'clamp', 'clamp_max', 'clamp_min', 'sgn', 'changes', 'resets',
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time', 'count_over_time',
  'quantile_over_time', 'stddev_over_time', 'stdvar_over_time', 'last_over_time',
  'present_over_time', 'mad_over_time', 'utime', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'offset', 'bool', 'topk', 'bottomk', 'time', 'vector',
  'scalar', 'label_replace', 'label_join', 'and', 'or', 'unless', 'atan2', 'pi',
]);

function extractMetricFromPromQL(expr: string): string | null {
  METRIC_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = METRIC_TOKEN.exec(expr)) !== null) {
    if (PROMQL_KEYWORDS.has(match[0])) continue;
    const next = expr.slice(match.index + match[0].length).match(/^\s*\(/);
    if (next) continue;
    return match[0];
  }
  return null;
}

function durationToMinutes(value: number, unit: string): number {
  switch (unit) {
    case 's': return value / 60;
    case 'm': return value;
    case 'h': return value * 60;
    case 'd': return value * 24 * 60;
    case 'w': return value * 7 * 24 * 60;
    default: return NaN;
  }
}

export function grafanaDurationToMinutes(from: unknown): number | null {
  const match = /^now-(\d+)([smhdw])$/.exec(String(from ?? '').trim());
  if (!match) return null;
  const minutes = durationToMinutes(Number(match[1]), match[2]);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
}

function minutesToGrafanaDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `now-${minutes / 10_080}w`;
  if (minutes % 1440 === 0) return `now-${minutes / 1440}d`;
  if (minutes % 60 === 0) return `now-${minutes / 60}h`;
  return `now-${minutes}m`;
}

function looksLikeGrafanaDashboard(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion != null && Array.isArray(input.panels)) return true;
  if (!Array.isArray(input.panels) || !input.panels.length) return false;
  const first = input.panels[0] as Record<string, unknown> | null;
  return !!first && typeof first === 'object' && typeof first.type === 'string'
    && (Array.isArray(first.targets) || first.gridPos != null);
}

function mapGrafanaPanel(raw: Record<string, unknown>): { panel: BoardPanel } | { skipped: string } {
  const type = String(raw.type ?? '');
  if (type === 'row') {
    const nested = Array.isArray(raw.panels) ? (raw.panels as Record<string, unknown>[]) : [];
    return { skipped: `row:${nested.length}` };
  }
  const chart = GRAFANA_TYPE_MAP[type];
  if (!chart) return { skipped: `type:${type}` };
  const title = String(raw.title ?? '').replace(/\0/g, '').trim();
  const targets = Array.isArray(raw.targets) ? (raw.targets as Record<string, unknown>[]) : [];
  const expr = String(targets[0]?.expr ?? '').trim();
  if (expr.includes('$')) return { skipped: 'templated' };
  const metric = extractMetricFromPromQL(expr);
  if (!metric) return { skipped: 'no-metric' };
  let windowMinutes: number | null = null;
  const range = RANGE_VECTOR.exec(expr);
  if (range) {
    const minutes = durationToMinutes(Number(range[1]), range[2]);
    if (Number.isFinite(minutes) && minutes >= 5) windowMinutes = Math.min(20160, Math.round(minutes));
  }
  const gridPos = (raw.gridPos ?? {}) as Record<string, unknown>;
  const width = Number(gridPos.w) >= 18 ? 2 : 1;
  return {
    panel: {
      title: title || metric,
      metric,
      windowMinutes,
      chart,
      width,
      warnValue: null,
      libraryId: null,
      critValue: null,
    },
  };
}

export function parseGrafanaDashboard(value: unknown): GrafanaImportResult | null {
  if (!looksLikeGrafanaDashboard(value)) return null;
  const input = value as Record<string, unknown>;
  const flatPanels: Record<string, unknown>[] = [];
  for (const raw of input.panels as Record<string, unknown>[]) {
    if (raw && typeof raw === 'object' && raw.type === 'row' && Array.isArray(raw.panels)) {
      flatPanels.push(...(raw.panels as Record<string, unknown>[]));
    } else {
      flatPanels.push(raw);
    }
  }
  const panels: BoardPanel[] = [];
  let skipped = 0;
  for (const raw of flatPanels) {
    if (!raw || typeof raw !== 'object') { skipped += 1; continue; }
    const mapped = mapGrafanaPanel(raw);
    if ('panel' in mapped) panels.push(mapped.panel);
    else skipped += 1;
  }
  if (!panels.length) return null;
  const windowMinutes = grafanaDurationToMinutes((input.time as Record<string, unknown> | undefined)?.from) ?? 240;
  const name = String(input.title ?? '').replace(/\0/g, '').trim().slice(0, 120) || 'Grafana 导入';
  const spec = normalizeBoardSpec({ windowMinutes, panels });
  if (!spec) return null;
  return { name, spec, mapped: panels.length, skipped };
}

export function toGrafanaDashboard(board: Pick<BoardRecord, 'name' | 'spec'>): Record<string, unknown> {
  let y = 0;
  const panels = board.spec.panels.map((panel) => {
    const type = panel.chart === 'line' ? 'timeseries'
      : panel.chart === 'bar' ? 'barchart'
        : panel.chart === 'table' ? 'table'
          : 'stat';
    const grid = { x: 0, y, w: panel.width === 2 ? 24 : 12, h: 8 };
    y += panel.width === 2 ? 9 : 9;
    return {
      id: y,
      type,
      title: panel.title,
      datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
      targets: [{ expr: panel.metric, refId: 'A' }],
      gridPos: grid,
      fieldConfig: { defaults: {}, overrides: [] },
      options: {},
    };
  });
  return {
    annotations: { list: [] },
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    id: null,
    links: [],
    liveNow: false,
    panels,
    refresh: '',
    schemaVersion: 39,
    tags: ['d-obs'],
    templating: { list: [] },
    time: { from: minutesToGrafanaDuration(board.spec.windowMinutes), to: 'now' },
    timezone: 'browser',
    title: board.name,
    uid: '',
    version: 1,
    weekStart: '',
  };
}
