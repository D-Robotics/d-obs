import { normalizeBoardPanel, type BoardPanel } from './dashboard-boards-store.js';
import type { MetricRangeQuery, MetricRangeSeries } from '../observability/ai-ecosystem-metrics-store.js';

export type DashboardSeries = { name: string; labels: Record<string, unknown>; points: Array<{ ts: number; value: number }> };
export type DashboardQueryResult = { series: DashboardSeries[]; warnings?: string[] };
export type DashboardQueryDependencies = {
  queryMetric: (input: MetricRangeQuery) => Promise<MetricRangeSeries[]>;
  prometheusUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
};
export class DashboardQueryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const FILTER_LABELS = new Set(['service', 'version', 'environment', 'provider', 'model', 'project', 'route', 'robot', 'device', 'host', 'site', 'firmware', 'model_version', 'sso_user_id', 'sso_user_name']);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stringMap(value: unknown, variable = false): Record<string, string> {
  if (value == null) return {};
  if (!object(value) || Object.keys(value).length > 20) throw new DashboardQueryError(variable ? 'invalid_board_variables' : 'invalid_board_filters');
  const result: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(value)) {
    if ((variable ? !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || name.startsWith('__') : !FILTER_LABELS.has(name)) || typeof text !== 'string' || text.length > 500 || CONTROL.test(text)) throw new DashboardQueryError(variable ? 'invalid_board_variables' : 'invalid_board_filters');
    result[name] = text;
  }
  return result;
}

/** Single values are literals, never executable fragments or variable formatters. */
export function interpolateDashboardExpression(expr: string, variables: Record<string, string>, builtins: Record<string, string>): string {
  let output = ''; let quote = ''; let escaped = false; let regexString = false;
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i];
    if (escaped) { output += char; escaped = false; continue; }
    if (quote && char === '\\' && quote !== '`') { output += char; escaped = true; continue; }
    if (char === '$') {
      const tail = expr.slice(i);
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(tail);
      if (!match) {
        if (tail.startsWith('${')) throw new DashboardQueryError('unsupported_board_variable');
        output += char; continue; // A regular expression end anchor is not a variable.
      }
      const name = match[1] || match[2];
      const value = Object.hasOwn(builtins, name) ? builtins[name] : Object.hasOwn(variables, name) ? variables[name] : undefined;
      if (value === undefined) throw new DashboardQueryError(name.startsWith('__') ? 'unsupported_board_variable' : 'undefined_board_variable');
      let literal = value;
      if (quote) {
        if (regexString) literal = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (quote === '`') {
          if (literal.includes('`')) throw new DashboardQueryError('invalid_board_variable_literal');
        } else literal = literal.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
      } else if (!/^(?:[A-Za-z_:][A-Za-z0-9_.:]*|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|[smhdwy])?)$/.test(literal)) {
        throw new DashboardQueryError('invalid_board_variable_literal');
      }
      output += literal; i += match[0].length - 1; continue;
    }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'" || char === '`') { quote = char; regexString = /(?:=~|!~)\s*$/.test(output); }
    output += char;
  }
  if (quote || escaped || output.length > 8000) throw new DashboardQueryError('invalid_promql');
  return output;
}

function interpolateText(text: string, variables: Record<string, string>, builtins: Record<string, string> = {}): string {
  if (/\$\{[^}]*[:][^}]*\}|\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(text)) throw new DashboardQueryError('unsupported_board_variable');
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, first: string, second: string) => {
    const name = first || second;
    if (Object.hasOwn(builtins, name)) return builtins[name];
    if (!Object.hasOwn(variables, name)) throw new DashboardQueryError(name.startsWith('__') ? 'unsupported_board_variable' : 'undefined_board_variable');
    return variables[name];
  });
}

function seriesName(panel: BoardPanel, refId: string, legend: string | undefined, labels: Record<string, unknown>): string {
  if (legend) return legend.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => String(labels[name] ?? ''));
  const name = String(labels.__name__ ?? panel.metric ?? '');
  const rest = Object.fromEntries(Object.entries(labels).filter(([key]) => key !== '__name__'));
  return `${refId}${name ? ' · ' + name : ''}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`;
}
function points(raw: unknown, refId: string, warnings: string[]): Array<{ ts: number; value: number }> {
  if (!Array.isArray(raw)) { warnings.push(`${refId}: invalid_samples_omitted`); return []; }
  const numeric = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && !!value.trim()) && Number.isFinite(Number(value));
  const valid = raw.filter((pair) => Array.isArray(pair) && pair.length >= 2 && numeric(pair[0]) && numeric(pair[1]));
  if (valid.length !== raw.length) warnings.push(`${refId}: nonfinite_or_invalid_samples_omitted`);
  if (valid.length > 1000) warnings.push(`${refId}: point_limit_1000`);
  return valid.slice(0, 1000).map((pair) => ({ ts: Math.round(Number(pair[0]) * 1000), value: Number(pair[1]) }));
}

export async function queryDashboardPanel(value: unknown, dependencies: DashboardQueryDependencies): Promise<DashboardQueryResult> {
  if (!object(value) || Object.keys(value).some((key) => !['panel', 'windowMinutes', 'range', 'variables', 'filters'].includes(key))) throw new DashboardQueryError('invalid_board_query');
  const panel = normalizeBoardPanel(value.panel);
  if (!panel) throw new DashboardQueryError('invalid_panel_spec');
  const variables = stringMap(value.variables, true);
  const filters = stringMap(value.filters);
  const minutes = Number(value.windowMinutes ?? panel.windowMinutes ?? 240);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 20160) throw new DashboardQueryError('invalid_time_range');
  let toMs = dependencies.now?.() ?? Date.now(); let fromMs = toMs - minutes * 60000;
  if (value.range != null) {
    if (!object(value.range)) throw new DashboardQueryError('invalid_time_range');
    fromMs = Number(value.range.fromMs); toMs = Number(value.range.toMs);
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs - fromMs < 300000 || toMs - fromMs > 20160 * 60000) throw new DashboardQueryError('invalid_time_range');
  }
  const step = Math.max(15, Math.ceil((toMs - fromMs) / 1000 / 240));
  const builtins = { __interval: `${step}s`, __rate_interval: `${Math.max(60, step * 4)}s`, __range: `${Math.ceil((toMs - fromMs) / 1000)}s`, __range_s: String(Math.ceil((toMs - fromMs) / 1000)) };
  if (panel.source !== 'prometheus') {
    if (panel.queries?.length) throw new DashboardQueryError('otlp_queries_not_supported');
    const resolvedFilters = Object.fromEntries(Object.entries(filters).map(([name, text]) => [name, interpolateText(text, variables)]));
    const raw = await dependencies.queryMetric({ metric: panel.metric, fromMs, toMs, maxPoints: 240, ...(resolvedFilters.sso_user_id ? { ssoUserId: resolvedFilters.sso_user_id } : {}) });
    return { series: raw.filter((row) => Object.entries(resolvedFilters).every(([key, text]) => !text || String(row.labels[key] ?? '') === text)).map((row) => ({ name: row.metric + ' ' + JSON.stringify(row.labels), labels: row.labels, points: row.points })) };
  }
  if (Object.values(filters).some(Boolean)) throw new DashboardQueryError('prometheus_filters_require_query_matchers');
  const base = String(dependencies.prometheusUrl ?? process.env.RDK_PROMETHEUS_QUERY_URL ?? '').trim().replace(/\/$/, '');
  if (!base) throw new DashboardQueryError('prometheus_not_configured', 501);
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { throw new DashboardQueryError('prometheus_not_configured', 501); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new DashboardQueryError('prometheus_not_configured', 501);
  const queries = panel.queries?.length ? panel.queries : [{ refId: 'A', expr: panel.metric }];
  // Validate every expression before dispatching any request.
  const resolved = queries.map((query) => ({ ...query, expr: interpolateDashboardExpression(query.expr, variables, builtins), ...(query.legendFormat !== undefined ? { legendFormat: interpolateText(query.legendFormat, variables, builtins) } : {}) }));
  const results = await Promise.all(resolved.map(async (query): Promise<DashboardQueryResult> => {
    const url = new URL(base + (query.instant ? '/api/v1/query' : '/api/v1/query_range'));
    url.searchParams.set('query', query.expr);
    if (query.instant) url.searchParams.set('time', String(toMs / 1000));
    else { url.searchParams.set('start', String(fromMs / 1000)); url.searchParams.set('end', String(toMs / 1000)); url.searchParams.set('step', String(step)); }
    let response: Response;
    try { response = await (dependencies.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' }); }
    catch { throw new DashboardQueryError('prometheus_unreachable', 502); }
    const payload = await response.json().catch(() => null) as Record<string, any> | null;
    if (response.status === 400 || payload?.errorType === 'bad_data') throw new DashboardQueryError('invalid_promql');
    if (!response.ok || payload?.status !== 'success' || !payload.data) throw new DashboardQueryError('prometheus_query_failed', 502);
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.slice(0, 8).map((text: unknown) => String(text).slice(0, 500)) : [];
    if (payload.warnings?.length > 8) warnings.push(`${query.refId}: upstream_warnings_truncated`);
    const data = payload.data;
    let rows: any[];
    if (data.resultType === 'scalar') rows = [{ metric: {}, value: data.result }];
    else if ((data.resultType === 'matrix' || data.resultType === 'vector') && Array.isArray(data.result)) rows = data.result;
    else throw new DashboardQueryError('prometheus_query_failed', 502);
    if (rows.length > 100) warnings.push(`${query.refId}: series_limit_100`);
    const usableRows = rows.slice(0, 100).filter(object);
    if (usableRows.length !== Math.min(rows.length, 100)) warnings.push(`${query.refId}: invalid_series_omitted`);
    const series = usableRows.map((row) => {
      const labels = object(row.metric) ? row.metric : {};
      return { name: seriesName(panel, query.refId, query.legendFormat, labels), labels, points: points(data.resultType === 'vector' || data.resultType === 'scalar' ? [row.value] : row.values, query.refId, warnings) };
    });
    return { series, ...(warnings.length ? { warnings } : {}) };
  }));
  const warnings = results.flatMap((result) => result.warnings ?? []);
  return { series: results.flatMap((result) => result.series), ...(warnings.length ? { warnings } : {}) };
}
