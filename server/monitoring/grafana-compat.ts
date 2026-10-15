/**
 * Classic Grafana JSON interoperability (pure functions, no datasource IO).
 * PromQL is retained verbatim: rate windows are not dashboard time windows.
 * Unsupported query semantics are rejected; display/layout losses are reported.
 * OTLP metric names are never exported as if they were Prometheus queries.
 */
import {
  BOARD_WINDOW_MINUTES_MAX, BOARD_WINDOW_MINUTES_MIN, normalizeBoardPanel, normalizeBoardSpec,
  type BoardPanel, type BoardPanelQuery, type BoardRecord, type BoardSpec, type BoardVariable,
} from './dashboard-boards-store.js';

export type GrafanaCompatibilityDetail = {
  code: string; message: string; panelTitle?: string; panelIndex?: number; variableName?: string;
};
type CompatibilityReport = { mapped: number; skipped: number; warnings: string[]; details: GrafanaCompatibilityDetail[] };
export type GrafanaImportResult = CompatibilityReport & { name: string; spec: BoardSpec };
export type GrafanaExportResult = CompatibilityReport & { dashboard: Record<string, unknown> };

const GRAFANA_TYPE_MAP: Record<string, BoardPanel['chart']> = {
  timeseries: 'line', graph: 'line', barchart: 'bar', bargauge: 'bar', stat: 'stat', gauge: 'stat', table: 'table',
};
const REDUCER_IMPORT: Record<string, NonNullable<BoardPanel['reducer']>> = {
  last: 'last', lastNotNull: 'last', sum: 'sum', total: 'sum', mean: 'avg', min: 'min', max: 'max',
};
const REDUCER_EXPORT = { last: 'lastNotNull', sum: 'sum', avg: 'mean', min: 'min', max: 'max' };
const BUILT_IN_VARIABLES = new Set(['__interval', '__rate_interval', '__range', '__range_s']);
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INVALID_TEXT = /[\u0000-\u001f\u007f]/;
const MAX_PANELS = 48;
const MAX_SCAN_PANELS = 4096;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max: number): string { return String(value ?? '').replace(/\0/g, '').trim().slice(0, max); }
function report(): CompatibilityReport { return { mapped: 0, skipped: 0, warnings: [], details: [] }; }
function warn(result: CompatibilityReport, code: string, message: string, context: Partial<GrafanaCompatibilityDetail> = {}): void {
  result.details.push({ ...context, code, message });
  result.warnings.push(context.panelTitle ? `面板「${context.panelTitle}」：${message}`
    : context.variableName ? `变量「${context.variableName}」：${message}` : message);
}
function durationToMinutes(value: number, unit: string): number {
  return value * ({ s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 }[unit] ?? NaN);
}
export function grafanaDurationToMinutes(from: unknown): number | null {
  const match = /^now-(\d+)([smhdw])$/.exec(String(from ?? '').trim());
  if (!match) return null;
  const minutes = durationToMinutes(Number(match[1]), match[2]);
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.round(minutes)) : null;
}
function minutesToGrafanaDuration(minutes: number): string {
  if (minutes % 10080 === 0) return `now-${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `now-${minutes / 1440}d`;
  if (minutes % 60 === 0) return `now-${minutes / 60}h`;
  return `now-${minutes}m`;
}
function absoluteTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  if (/^\d{11,16}$/.test(value)) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function importTime(input: Record<string, unknown>, result: CompatibilityReport): Pick<BoardSpec, 'windowMinutes' | 'range'> {
  const time = object(input.time);
  if (!time) return { windowMinutes: 240, range: null };
  const relative = grafanaDurationToMinutes(time.from);
  if (relative != null && (time.to === 'now' || time.to == null)) {
    const bounded = Math.min(BOARD_WINDOW_MINUTES_MAX, Math.max(BOARD_WINDOW_MINUTES_MIN, relative));
    if (bounded !== relative) warn(result, 'time_range_bounded', `时间窗口超出支持范围，已调整为 ${bounded} 分钟。`);
    return { windowMinutes: bounded, range: null };
  }
  const fromMs = absoluteTime(time.from);
  const toMs = absoluteTime(time.to);
  if (fromMs != null && toMs != null && fromMs >= 0 && toMs > fromMs
    && toMs - fromMs <= BOARD_WINDOW_MINUTES_MAX * 60000 && fromMs <= Date.now() + 60000) {
    return { windowMinutes: Math.max(BOARD_WINDOW_MINUTES_MIN, Math.ceil((toMs - fromMs) / 60000)), range: { fromMs, toMs } };
  }
  warn(result, 'unsupported_time_range', '不支持该时间表达式或时间跨度，已使用最近 4 小时；请重新选择时间范围。');
  return { windowMinutes: 240, range: null };
}
function dashboardObject(value: unknown): Record<string, unknown> | null {
  const raw = object(value);
  if (!raw) return null;
  const wrapped = object(raw.dashboard);
  const resource = raw.kind === 'Dashboard' && raw.apiVersion === 'dashboard.grafana.app/v1' ? object(raw.spec) : null;
  const input = wrapped ?? resource ?? raw;
  if (!Array.isArray(input.panels)) return null;
  if (input.schemaVersion != null) return input;
  return input.panels.some((panel) => {
    const p = object(panel);
    return p && typeof p.type === 'string' && (Array.isArray(p.targets) || p.gridPos != null || p.type === 'row');
  }) ? input : null;
}

/** Saved option values avoid treating Grafana's custom key:value labels as query values. */
function customOptions(raw: Record<string, unknown>, result: CompatibilityReport, name: string): string[] | null {
  if (Array.isArray(raw.options) && raw.options.length) {
    if (raw.options.length > 100) return null;
    const options: string[] = [];
    let renamed = false;
    for (const item of raw.options) {
      const option = object(item);
      if (!option || typeof option.value !== 'string' || option.value.length > 500 || INVALID_TEXT.test(option.value)) return null;
      options.push(option.value);
      if (option.text != null && option.text !== option.value) renamed = true;
    }
    if (renamed) warn(result, 'variable_option_labels', '保留选项值；独立的选项显示名称已省略。', { variableName: name });
    return options;
  }
  if (typeof raw.query !== 'string') return [];
  const options = raw.query.split(/(?<!\\),/).map((part) => part.trim().replace(/\\,/g, ','));
  if (options.length > 100 || options.some((option) => option.length > 500 || INVALID_TEXT.test(option))) return null;
  if (options.some((option) => /\s:\s/.test(option))) return null;
  return options.filter(Boolean);
}
function importVariables(input: Record<string, unknown>, result: CompatibilityReport): BoardVariable[] {
  const list = object(input.templating)?.list;
  if (!Array.isArray(list)) return [];
  const variables: BoardVariable[] = [];
  const names = new Set<string>();
  for (const rawValue of list.slice(0, MAX_SCAN_PANELS)) {
    const raw = object(rawValue);
    const name = text(raw?.name, 100);
    const context = { variableName: name || '(未命名)' };
    if (names.has(name)) {
      const existing = variables.findIndex((variable) => variable.name === name);
      if (existing >= 0) variables.splice(existing, 1);
      warn(result, 'invalid_variable', '变量名称重复，全部同名定义已跳过；引用它的面板也将跳过。', context); continue;
    }
    if (!raw || typeof raw.name !== 'string' || raw.name !== name || !VARIABLE_NAME.test(name) || name.startsWith('__')) {
      warn(result, 'invalid_variable', '变量名称无效或重复，已跳过。', context); continue;
    }
    names.add(name);
    if (variables.length >= 20) { warn(result, 'variable_limit', '仅支持 20 个变量，该变量已跳过。', context); continue; }
    if (raw.type !== 'custom' && raw.type !== 'textbox') {
      warn(result, 'unsupported_variable_type', `不支持 ${text(raw.type, 60) || '未知'} 类型变量，已跳过；引用它的面板也将跳过。`, context); continue;
    }
    const current = object(raw.current);
    if (raw.multi === true || raw.includeAll === true || Array.isArray(current?.value)) {
      warn(result, 'unsupported_variable_selection', '不支持多选或 All 变量，已跳过；引用它的面板也将跳过。', context); continue;
    }
    const options = raw.type === 'custom' ? customOptions(raw, result, name) : undefined;
    const value = current?.value ?? (raw.type === 'textbox' ? raw.query : options?.[0]) ?? '';
    if (options === null || typeof value !== 'string' || value.length > 500 || INVALID_TEXT.test(value)) {
      warn(result, 'invalid_variable_value', '变量值或选项超出支持范围，已跳过。', context); continue;
    }
    variables.push({ name, label: text(raw.label ?? name, 120), type: raw.type, value, ...(options !== undefined ? { options } : {}) });
  }
  if (list.length > MAX_SCAN_PANELS) warn(result, 'variable_scan_limit', '变量数量过多，超出检查上限的变量已跳过。');
  return variables;
}
function unsupportedReference(expr: string, variableNames: Set<string>): string | null {
  const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const match of expr.matchAll(pattern)) {
    const name = match[1] ?? match[3];
    if (match[2] || (!BUILT_IN_VARIABLES.has(name) && !variableNames.has(name))) return match[0];
  }
  return null;
}
function datasourceKind(value: unknown, inputs: Map<string, string>): string {
  if (value == null || value === '') return 'unspecified';
  const source = object(value);
  if (source) {
    if (typeof source.uid === 'string' && datasourceKind(source.uid, inputs) === 'mixed') return 'mixed';
    if (typeof source.type === 'string' && source.type) return source.type;
    return datasourceKind(source.uid, inputs);
  }
  if (typeof value !== 'string') return 'unknown';
  if (/^(?:--\s*)?mixed(?:\s*--)?$/i.test(value) || value === '-Mixed-') return 'mixed';
  if (/^prometheus$/i.test(value) || value === '${DS_PROMETHEUS}') return 'prometheus';
  const input = /^\$\{([^}]+)\}$/.exec(value);
  return input ? inputs.get(input[1]) ?? 'unknown' : 'unknown';
}
function datasourceIdentity(value: unknown): string {
  const source = object(value);
  return String(source ? source.uid ?? '(default)' : value ?? '(default)');
}
function importThresholds(defaults: Record<string, unknown>, result: CompatibilityReport, context: Partial<GrafanaCompatibilityDetail>): Pick<BoardPanel, 'warnValue' | 'critValue'> {
  const thresholds = object(defaults.thresholds);
  if (!thresholds) return { warnValue: null, critValue: null };
  if (thresholds.mode && thresholds.mode !== 'absolute') {
    warn(result, 'unsupported_threshold_mode', '百分比阈值无法映射为绝对值，阈值已省略。', context);
    return { warnValue: null, critValue: null };
  }
  const finite = (Array.isArray(thresholds.steps) ? thresholds.steps : []).flatMap((value) => {
    const step = object(value);
    return typeof step?.value === 'number' && Number.isFinite(step.value) ? [{ value: step.value, color: step.color }] : [];
  });
  if (finite.length > 2) warn(result, 'threshold_limit', '仅保留前两个绝对阈值，其余阈值和自定义颜色已省略。', context);
  else if (finite.length) warn(result, 'threshold_colors', '保留绝对阈值；颜色使用平台统一的警告/严重配色。', context);
  if (finite.length === 1 && finite[0].color === 'red') return { warnValue: null, critValue: finite[0].value };
  return { warnValue: finite[0]?.value ?? null, critValue: finite[1]?.value ?? null };
}

function mapGrafanaPanel(raw: Record<string, unknown>, result: CompatibilityReport, panelIndex: number, variables: Set<string>, inputs: Map<string, string>): BoardPanel | null {
  const title = text(raw.title, 120) || `面板 ${panelIndex + 1}`;
  const context = { panelTitle: title, panelIndex };
  const reject = (code: string, message: string): null => { warn(result, code, `${message}，已跳过。`, context); return null; };
  const type = String(raw.type ?? '');
  const chart = Object.hasOwn(GRAFANA_TYPE_MAP, type) ? GRAFANA_TYPE_MAP[type] : undefined;
  if (!chart) return reject('unsupported_panel_type', `不支持 ${text(type, 60) || '未知'} 面板类型`);
  if (Array.isArray(raw.transformations) && raw.transformations.length) return reject('unsupported_transformations', '面板包含数据转换，无法保留其计算语义');
  if (raw.repeat) return reject('unsupported_repeat', '不支持变量重复面板');
  if (raw.timeShift) return reject('unsupported_time_shift', '不支持面板时间偏移');
  if (datasourceKind(raw.datasource, inputs) === 'mixed') return reject('mixed_datasource', '不支持混合数据源面板');
  const targets = Array.isArray(raw.targets) ? raw.targets : [];
  const visible = targets.filter((target) => object(target)?.hide !== true);
  if (targets.length !== visible.length) warn(result, 'hidden_targets', '隐藏的查询未导入。', context);
  if (!visible.length) return reject('no_queries', '面板没有可执行的 Prometheus 查询');
  if (visible.length > 8) return reject('query_limit', '一个面板最多支持 8 个查询，不能截断导入');
  const queries: BoardPanelQuery[] = [];
  const refs = new Set<string>();
  let unspecified = false;
  const identities = new Set<string>();
  for (const [i, rawTarget] of visible.entries()) {
    const target = object(rawTarget);
    if (!target || typeof target.expr !== 'string') return reject('unsupported_query', '目标缺少完整的 PromQL 表达式');
    const source = target.datasource ?? raw.datasource;
    const kind = datasourceKind(source, inputs);
    if (kind !== 'prometheus' && kind !== 'unspecified') return reject('unsupported_datasource', `查询使用不支持的 ${text(kind, 60)} 数据源`);
    if (kind === 'unspecified') unspecified = true;
    else identities.add(datasourceIdentity(source));
    const expr = target.expr.trim();
    if (!expr || expr.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(expr)) return reject('invalid_query', '表达式为空、超过 2000 字符或包含非法控制字符');
    const reference = unsupportedReference(expr, variables);
    if (reference) return reject('unsupported_query_variable', `表达式引用了未支持的变量 ${reference}`);
    const refId = target.refId == null ? String.fromCharCode(65 + i) : String(target.refId);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(refId) || refs.has(refId)) return reject('invalid_query_reference', '查询 refId 无效或重复');
    if (target.legendFormat != null && (typeof target.legendFormat !== 'string' || target.legendFormat.length > 200)) return reject('invalid_legend', '查询图例超出支持范围');
    const legendReference = typeof target.legendFormat === 'string' ? unsupportedReference(target.legendFormat, variables) : null;
    if (legendReference) return reject('unsupported_legend_variable', `图例引用了未支持的变量 ${legendReference}`);
    if (target.instant != null && typeof target.instant !== 'boolean') return reject('invalid_query_mode', '查询 instant 模式无效');
    if (target.instant === true && target.range === true) warn(result, 'both_query_modes', '查询同时请求即时和区间结果；已保留即时模式。', context);
    if (target.interval || target.intervalFactor || target.step) warn(result, 'query_step', '查询步长由平台按看板时间范围计算，原查询步长已省略。', context);
    if (target.exemplar === true) warn(result, 'query_exemplars', 'Exemplar 链接未导入。', context);
    refs.add(refId);
    queries.push({ refId, expr, ...(target.legendFormat != null ? { legendFormat: target.legendFormat as string } : {}), ...(target.instant != null ? { instant: target.instant as boolean } : {}) });
  }
  if (identities.size > 1) return reject('multiple_prometheus_datasources', '多个查询指向不同的 Prometheus 数据源，不能合并为本地单一数据源');
  if (unspecified) warn(result, 'datasource_assumed', 'JSON 未声明数据源，按 PromQL 导入并使用平台配置的 Prometheus；请确认指标来源。', context);
  else warn(result, 'datasource_rebound', '查询已绑定到平台配置的 Prometheus；原 Grafana 数据源 UID 未保留。', context);
  let windowMinutes: number | null = null;
  if (raw.timeFrom) {
    windowMinutes = grafanaDurationToMinutes(`now-${raw.timeFrom}`);
    if (windowMinutes == null || windowMinutes < BOARD_WINDOW_MINUTES_MIN || windowMinutes > BOARD_WINDOW_MINUTES_MAX) return reject('unsupported_panel_time', '面板相对时间窗口超出支持范围');
  }
  const fieldConfig = object(raw.fieldConfig);
  const defaults = object(fieldConfig?.defaults) ?? {};
  const reduceOptions = object(object(raw.options)?.reduceOptions);
  const calcs = Array.isArray(reduceOptions?.calcs) ? reduceOptions.calcs : [];
  if (calcs.length > 1 || (calcs.length === 1 && !Object.hasOwn(REDUCER_IMPORT, String(calcs[0])))) return reject('unsupported_reducer', '不支持该面板归约计算');
  if (reduceOptions?.values === true) return reject('unsupported_reducer_values', '面板显示每个原始值，无法映射为单值归约');
  if (reduceOptions?.fields) return reject('unsupported_reducer_fields', '不支持按字段选择器归约');
  if (typeof defaults.unit !== 'undefined' && (typeof defaults.unit !== 'string' || defaults.unit.length > 80)) return reject('invalid_unit', '单位超出支持范围');
  if (Array.isArray(fieldConfig?.overrides) && fieldConfig.overrides.length) warn(result, 'field_overrides', '字段覆盖规则未导入；使用统一的面板字段设置。', context);
  if (Array.isArray(defaults.mappings) && defaults.mappings.length) warn(result, 'value_mappings', '值映射未导入。', context);
  if (type === 'gauge' || type === 'bargauge') warn(result, 'panel_visualization', '仪表盘映射为数字/柱图，原仪表样式已省略。', context);
  if (type === 'graph' && raw.bars === true) warn(result, 'legacy_graph_style', '旧版 graph 面板映射为折线图，原柱图样式已省略。', context);
  if (raw.description || (Array.isArray(raw.links) && raw.links.length)) warn(result, 'panel_links', '面板说明及链接未导入。', context);
  if (/\$(?:\{|[A-Za-z_])/.test(title)) warn(result, 'panel_title_variables', '标题中的变量保留为文本，未联动替换。', context);
  if (raw.libraryPanel) warn(result, 'library_panel', '面板定义已复制；Grafana 库面板关联未保留。', context);
  const grid = object(raw.gridPos);
  const width = Number(grid?.w) >= 18 ? 2 : 1;
  if (grid && (!([12, 24].includes(Number(grid.w))) || Number(grid.h) !== 8)) warn(result, 'panel_layout', '布局已调整为平台半宽/整行网格，原位置及高度未保留。', context);
  const panel = normalizeBoardPanel({
    title, source: 'prometheus', metric: '', queries, windowMinutes, chart, width,
    ...importThresholds(defaults, result, context), libraryId: null,
    ...(defaults.unit != null ? { unit: defaults.unit } : {}),
    ...(calcs.length ? { reducer: REDUCER_IMPORT[String(calcs[0])] } : {}),
  });
  return panel ?? reject('invalid_panel', '面板定义超出平台支持范围');
}

export function parseGrafanaDashboard(value: unknown): GrafanaImportResult | null {
  const input = dashboardObject(value);
  if (!input || !(input.panels as unknown[]).length) return null;
  const result = report();
  const variables = importVariables(input, result);
  const variableNames = new Set(variables.map((variable) => variable.name));
  const inputs = new Map<string, string>();
  for (const raw of Array.isArray(input.__inputs) ? input.__inputs : []) {
    const entry = object(raw);
    if (entry?.type === 'datasource' && typeof entry.name === 'string' && typeof entry.pluginId === 'string') inputs.set(entry.name, entry.pluginId);
  }
  const flat: unknown[] = [];
  let scanned = 0;
  const flatten = (panels: unknown[], depth: number): void => {
    for (const panel of panels) {
      if (++scanned > MAX_SCAN_PANELS) return;
      const raw = object(panel);
      if (raw?.type === 'row') {
        warn(result, 'row_layout', '分组行已展开，折叠与重复布局未保留。', { panelTitle: text(raw.title, 120) || '分组行' });
        if (Array.isArray(raw.panels) && depth < 16) flatten(raw.panels, depth + 1);
        else if (Array.isArray(raw.panels) && raw.panels.length) warn(result, 'row_depth', '分组嵌套过深，嵌套面板已跳过。');
      } else flat.push(panel);
    }
  };
  flatten(input.panels as unknown[], 0);
  if (scanned > MAX_SCAN_PANELS) warn(result, 'panel_scan_limit', '面板数量过多，超出检查上限的面板已跳过。');
  const panels: BoardPanel[] = [];
  for (const [index, value] of flat.entries()) {
    const raw = object(value);
    if (panels.length >= MAX_PANELS) { result.skipped += 1; warn(result, 'panel_limit', '仅支持 48 个面板，该面板已跳过。', { panelIndex: index, panelTitle: text(raw?.title, 120) }); continue; }
    if (!raw) { result.skipped += 1; warn(result, 'invalid_panel', '无效面板已跳过。', { panelIndex: index }); continue; }
    const panel = mapGrafanaPanel(raw, result, index, variableNames, inputs);
    if (panel) panels.push(panel); else result.skipped += 1;
  }
  const spec = normalizeBoardSpec({ ...importTime(input, result), panels, ...(variables.length ? { variables } : {}) });
  if (!spec) return null;
  if (input.refresh) warn(result, 'refresh_interval', 'Grafana 自动刷新间隔未导入；使用平台刷新设置。');
  const annotations = object(input.annotations)?.list;
  if (Array.isArray(annotations) && annotations.length) warn(result, 'annotations', 'Grafana 注释与告警标记未导入。');
  if (Array.isArray(input.links) && input.links.length) warn(result, 'dashboard_links', 'Grafana 看板链接未导入。');
  result.mapped = panels.length;
  return { name: text(input.title, 120) || 'Grafana 导入', spec, ...result };
}

/** This wrapper exposes loss metadata without changing the legacy raw-JSON export API. */
export function exportGrafanaDashboard(board: Pick<BoardRecord, 'name' | 'spec'>): GrafanaExportResult {
  const result = report();
  const panels: Record<string, unknown>[] = [];
  let x = 0;
  let y = 0;
  for (const [index, panel] of board.spec.panels.entries()) {
    const context = { panelTitle: panel.title, panelIndex: index };
    if (panel.source !== 'prometheus') {
      result.skipped += 1;
      warn(result, 'otlp_panel_not_exported', 'OTLP 面板没有等价的 Prometheus 查询，已跳过；请先配置真实的 PromQL 面板。', context);
      continue;
    }
    const queries = panel.queries?.length ? panel.queries : panel.metric ? [{ refId: 'A', expr: panel.metric }] : [];
    if (!queries.length || queries.length > 8) { result.skipped += 1; warn(result, 'invalid_export_queries', 'Prometheus 查询为空或超出上限，已跳过。', context); continue; }
    if (!panel.queries?.length && !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(panel.metric)) {
      result.skipped += 1; warn(result, 'invalid_prometheus_metric', '指标名不是合法的 Prometheus 简单选择器，已跳过；请提供完整 PromQL。', context); continue;
    }
    const width = panel.width === 2 ? 24 : 12;
    if (x && width === 24) { y += 8; x = 0; }
    const gridPos = { x, y, w: width, h: 8 };
    if (width === 24 || x === 12) { y += 8; x = 0; } else x = 12;
    const steps: Array<{ color: string; value: number | null }> = [{ color: 'green', value: null }];
    if (panel.warnValue != null) steps.push({ color: 'yellow', value: panel.warnValue });
    if (panel.critValue != null) steps.push({ color: 'red', value: panel.critValue });
    const type = panel.chart === 'line' ? 'timeseries' : panel.chart === 'bar' ? 'barchart' : panel.chart === 'table' ? 'table' : 'stat';
    panels.push({
      id: index + 1, type, title: panel.title, datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' },
      targets: queries.map((query) => ({ ...query, datasource: { type: 'prometheus', uid: '${DS_PROMETHEUS}' }, ...(query.instant !== undefined ? { range: !query.instant } : {}) })),
      gridPos, fieldConfig: { defaults: { ...(panel.unit ? { unit: panel.unit } : {}), thresholds: { mode: 'absolute', steps } }, overrides: [] },
      options: { reduceOptions: { calcs: [REDUCER_EXPORT[panel.reducer ?? 'last']], fields: '', values: false } },
      ...(panel.windowMinutes != null ? { timeFrom: minutesToGrafanaDuration(panel.windowMinutes).slice(4) } : {}),
    });
    if (panel.libraryId) warn(result, 'library_panel_detached', '已导出当前面板定义；平台库面板关联未保留。', context);
  }
  if (board.spec.filters?.service) warn(result, 'service_filter_not_exported', '平台的 OTLP 服务筛选未导出；Prometheus 查询中的服务条件保持原样。');
  const variables = board.spec.variables ?? [];
  const dashboard: Record<string, unknown> = {
    __inputs: [{ name: 'DS_PROMETHEUS', label: 'Prometheus', description: 'Choose the Prometheus datasource containing these metrics.', type: 'datasource', pluginId: 'prometheus', pluginName: 'Prometheus' }],
    annotations: { list: [] }, editable: true, fiscalYearStartMonth: 0, graphTooltip: 0, id: null, links: [], liveNow: false,
    panels, refresh: '', schemaVersion: 39, tags: ['d-obs'],
    templating: { list: variables.map((variable) => ({
      name: variable.name, label: variable.label, type: variable.type,
      query: variable.type === 'custom' ? (variable.options ?? []).map((option) => option.replace(/,/g, '\\,')).join(',') : variable.value,
      current: { text: variable.value, value: variable.value }, multi: false, includeAll: false,
      options: variable.type === 'custom' ? (variable.options ?? []).map((option) => ({ text: option, value: option, selected: option === variable.value })) : [],
    })) },
    time: board.spec.range ? { from: new Date(board.spec.range.fromMs).toISOString(), to: new Date(board.spec.range.toMs).toISOString() }
      : { from: minutesToGrafanaDuration(board.spec.windowMinutes), to: 'now' },
    timezone: 'browser', title: board.name, uid: '', version: 1, weekStart: '',
  };
  result.mapped = panels.length;
  dashboard.xDObs = { ...result, format: 'd-obs-grafana-compat-v1' };
  return { dashboard, ...result };
}
export function toGrafanaDashboard(board: Pick<BoardRecord, 'name' | 'spec'>): Record<string, unknown> {
  return exportGrafanaDashboard(board).dashboard;
}
