/**
 * Versioned panel contract shared by the workbench, API clients and plugins.
 *
 * The registry deliberately contains capability metadata only. Rendering is
 * still owned by the current workbench, while external connectors can inspect
 * this contract before sending a panel definition to the platform.
 */

export const PANEL_REGISTRY_SCHEMA = 'rdk.observability.panel-registry.v1';
export const PANEL_SPEC_VERSION = '1.0.0';
export const PANEL_REGISTRY_VERSION = '1.0.0';

export const PANEL_KINDS = [
  'line',
  'bar',
  'stat',
  'table',
  'heatmap',
  'topology',
  'flamegraph',
  'logs',
  'trace',
] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

export const PANEL_DATA_SOURCE_IDS = [
  'metrics',
  'logs',
  'traces',
  'events',
  'topology',
] as const;
export type PanelDataSourceId = (typeof PANEL_DATA_SOURCE_IDS)[number];

export type PanelFilterValue = string | number | boolean | null;

export type PanelQuery = {
  /** Registered source name, for example metrics or traces. */
  dataSource: string;
  /** Metric name for metric sources. */
  metric: string | null;
  /** Source-native query (PromQL, SQL-like filter, or a connector query). */
  query: string | null;
  filters: Record<string, PanelFilterValue>;
  groupBy: string[];
  limit: number;
};

export type PanelTransform = {
  type: string;
  field: string | null;
  value: PanelFilterValue;
  options: Record<string, PanelFilterValue>;
};

export type PanelThreshold = {
  value: number;
  color: string;
  label: string | null;
};

export type PanelViz = {
  title: string | null;
  description: string | null;
  unit: string | null;
  legend: 'auto' | 'show' | 'hide';
  colorScheme: string | null;
  stacked: boolean;
  orientation: 'auto' | 'horizontal' | 'vertical';
  thresholds: PanelThreshold[];
};

export type PanelInteractions = {
  hover: boolean;
  select: boolean;
  zoom: boolean;
  pan: boolean;
  crossFilter: boolean;
};

export type PanelDrilldown = {
  label: string;
  target: string;
  params: Record<string, PanelFilterValue>;
};

export type PanelRefresh = {
  mode: 'manual' | 'poll' | 'stream';
  intervalSeconds: number;
  staleAfterSeconds: number | null;
};

export type PanelSpec = {
  version: string;
  kind: PanelKind;
  query: PanelQuery;
  transform: PanelTransform[];
  viz: PanelViz;
  interactions: PanelInteractions;
  drilldown: PanelDrilldown[];
  refresh: PanelRefresh;
};

export type PanelRendererCapability = {
  id: string;
  kind: string;
  version: string;
  label: string;
  dataSources: string[];
  features: string[];
};

export type PanelDataSourceCapability = {
  id: string;
  version: string;
  signals: string[];
  protocols: string[];
  features: string[];
};

export type PanelRegistrySummary = {
  schema: string;
  version: string;
  specVersion: string;
  renderers: Array<Pick<PanelRendererCapability, 'id' | 'kind' | 'version'>>;
  dataSources: Array<Pick<PanelDataSourceCapability, 'id' | 'version' | 'signals'>>;
};

type JsonObject = Record<string, unknown>;

const MAX_QUERY_TEXT = 2_000;
const MAX_FILTERS = 32;
const MAX_GROUP_BY = 16;
const MAX_TRANSFORMS = 16;
const MAX_DRILLDOWNS = 8;

const rendererRegistry = new Map<string, PanelRendererCapability>();
const dataSourceRegistry = new Map<string, PanelDataSourceCapability>();

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max);
}

function optionalText(value: unknown, max = MAX_QUERY_TEXT): string | null {
  const text = cleanText(value, max);
  return text || null;
}

function filterValue(value: unknown): PanelFilterValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function normalizeMap(value: unknown): Record<string, PanelFilterValue> {
  if (!isObject(value)) return {};
  const result: Record<string, PanelFilterValue> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_FILTERS)) {
    const normalizedKey = cleanText(key, 120);
    if (normalizedKey) result[normalizedKey] = filterValue(raw);
  }
  return result;
}

function normalizeStringList(value: unknown, max: number, itemMax = 120): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .slice(0, max)
    .map((item) => cleanText(item, itemMax))
    .filter(Boolean))];
}

function normalizeVersion(value: unknown): string {
  const candidate = cleanText(value, 32);
  if (/^1(?:\.\d+){0,2}$/.test(candidate)) {
    const parts = candidate.split('.').map(Number);
    return `${parts[0]}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
  }
  return PANEL_SPEC_VERSION;
}

function versionMajor(value: unknown): number | null {
  const match = /^([0-9]+)(?:\.[0-9]+){0,2}$/.exec(cleanText(value, 32));
  return match ? Number(match[1]) : null;
}

function normalizeKind(value: unknown): PanelKind {
  const candidate = cleanText(value, 32).toLowerCase();
  const aliases: Record<string, PanelKind> = {
    timeseries: 'line',
    time_series: 'line',
    flame_graph: 'flamegraph',
    traces: 'trace',
    topology_graph: 'topology',
  };
  const normalized = aliases[candidate] ?? candidate;
  return (PANEL_KINDS as readonly string[]).includes(normalized)
    ? normalized as PanelKind
    : 'stat';
}

function normalizeQuery(value: unknown): PanelQuery {
  const input = isObject(value) ? value : {};
  const requestedSource = cleanText(input.dataSource ?? input.source ?? 'metrics', 64) || 'metrics';
  // Unknown sources are reduced to the stable metrics source until a plugin
  // registers the source. This keeps old clients renderable after upgrades.
  const dataSource = dataSourceRegistry.has(requestedSource) ? requestedSource : 'metrics';
  const limitNumber = Math.trunc(Number(input.limit ?? 100));
  return {
    dataSource,
    metric: optionalText(input.metric, 200),
    query: optionalText(input.query, MAX_QUERY_TEXT),
    filters: normalizeMap(input.filters),
    groupBy: normalizeStringList(input.groupBy, MAX_GROUP_BY),
    limit: Number.isFinite(limitNumber) ? Math.max(1, Math.min(10_000, limitNumber)) : 100,
  };
}

function normalizeTransform(value: unknown): PanelTransform | null {
  if (!isObject(value)) return null;
  const type = cleanText(value.type, 64).toLowerCase();
  if (!type) return null;
  return {
    type,
    field: optionalText(value.field, 120),
    value: filterValue(value.value),
    options: normalizeMap(value.options),
  };
}

function normalizeViz(value: unknown, kind: PanelKind): PanelViz {
  const input = isObject(value) ? value : {};
  const legend = ['auto', 'show', 'hide'].includes(String(input.legend))
    ? String(input.legend) as PanelViz['legend']
    : 'auto';
  const orientation = ['auto', 'horizontal', 'vertical'].includes(String(input.orientation))
    ? String(input.orientation) as PanelViz['orientation']
    : 'auto';
  const thresholds: PanelThreshold[] = [];
  if (Array.isArray(input.thresholds)) {
    for (const raw of input.thresholds.slice(0, 8)) {
      if (!isObject(raw)) continue;
      const valueNumber = Number(raw.value);
      const color = cleanText(raw.color, 32);
      if (Number.isFinite(valueNumber) && color) {
        thresholds.push({ value: valueNumber, color, label: optionalText(raw.label, 80) });
      }
    }
  }
  return {
    title: optionalText(input.title, 120),
    description: optionalText(input.description, 500),
    unit: optionalText(input.unit, 64),
    legend,
    colorScheme: optionalText(input.colorScheme, 64),
    stacked: Boolean(input.stacked),
    orientation: kind === 'bar' ? orientation : 'auto',
    thresholds,
  };
}

function normalizeInteractions(value: unknown): PanelInteractions {
  const input = isObject(value) ? value : {};
  return {
    hover: input.hover !== false,
    select: input.select !== false,
    zoom: Boolean(input.zoom),
    pan: Boolean(input.pan),
    crossFilter: Boolean(input.crossFilter),
  };
}

function normalizeDrilldowns(value: unknown): PanelDrilldown[] {
  if (!Array.isArray(value)) return [];
  const result: PanelDrilldown[] = [];
  for (const raw of value.slice(0, MAX_DRILLDOWNS)) {
    if (!isObject(raw)) continue;
    const label = cleanText(raw.label, 120);
    const target = cleanText(raw.target, 240);
    if (label && target) result.push({ label, target, params: normalizeMap(raw.params) });
  }
  return result;
}

function normalizeRefresh(value: unknown): PanelRefresh {
  const input = isObject(value) ? value : {};
  const mode = ['manual', 'poll', 'stream'].includes(String(input.mode))
    ? String(input.mode) as PanelRefresh['mode']
    : 'poll';
  const interval = Math.trunc(Number(input.intervalSeconds ?? 60));
  const stale = input.staleAfterSeconds == null ? null : Math.trunc(Number(input.staleAfterSeconds));
  return {
    mode,
    intervalSeconds: Number.isFinite(interval) ? Math.max(5, Math.min(86_400, interval)) : 60,
    staleAfterSeconds: stale != null && Number.isFinite(stale) ? Math.max(0, Math.min(172_800, stale)) : null,
  };
}

function fallbackQuery(value: unknown): PanelQuery {
  const input = isObject(value) ? value : {};
  return normalizeQuery({
    dataSource: input.query && isObject(input.query) ? input.query.dataSource : 'metrics',
    metric: input.query && isObject(input.query) ? input.query.metric : null,
  });
}

/** Return a safe stat panel for unknown/future panel kinds or spec versions. */
export function compatibilityFallback(value: unknown): PanelSpec {
  const input = isObject(value) ? value : {};
  return {
    version: PANEL_SPEC_VERSION,
    kind: 'stat',
    query: fallbackQuery(value),
    transform: [],
    viz: normalizeViz(input.viz, 'stat'),
    interactions: normalizeInteractions(input.interactions),
    drilldown: normalizeDrilldowns(input.drilldown),
    refresh: normalizeRefresh(input.refresh),
  };
}

export type PanelValidation =
  | { ok: true; value: PanelSpec }
  | { ok: false; errors: string[] };

/** Strict validation for API/plugin boundaries. Use normalizePanelSpec for UI input. */
export function validatePanelSpec(value: unknown): PanelValidation {
  if (!isObject(value)) return { ok: false, errors: ['panel_spec_object_required'] };
  const errors: string[] = [];
  if (versionMajor(value.version) !== 1) errors.push('unsupported_panel_spec_version');
  if (!PANEL_KINDS.includes(value.kind as PanelKind)) errors.push('unsupported_panel_kind');
  if (!isObject(value.query)) errors.push('panel_query_required');
  if (!Array.isArray(value.transform)) errors.push('panel_transform_array_required');
  if (!isObject(value.viz)) errors.push('panel_viz_required');
  if (!isObject(value.interactions)) errors.push('panel_interactions_required');
  if (!Array.isArray(value.drilldown)) errors.push('panel_drilldown_array_required');
  if (!isObject(value.refresh)) errors.push('panel_refresh_required');
  if (errors.length) return { ok: false, errors };
  const normalized = normalizePanelSpec(value);
  return normalized ? { ok: true, value: normalized } : { ok: false, errors: ['invalid_panel_spec'] };
}

/** Normalize loose/user supplied input to the current versioned contract. */
export function normalizePanelSpec(value: unknown): PanelSpec {
  const input = isObject(value) ? value : {};
  if (versionMajor(input.version) !== null && versionMajor(input.version) !== 1) return compatibilityFallback(value);
  const kindCandidate = cleanText(input.kind, 32).toLowerCase();
  const knownKind = (PANEL_KINDS as readonly string[]).includes(kindCandidate)
    || ['timeseries', 'time_series', 'flame_graph', 'traces', 'topology_graph'].includes(kindCandidate);
  if (kindCandidate && !knownKind) return compatibilityFallback(value);
  const kind = normalizeKind(input.kind ?? 'stat');
  const transforms = Array.isArray(input.transform)
    ? input.transform.slice(0, MAX_TRANSFORMS).map(normalizeTransform).filter((item): item is PanelTransform => item !== null)
    : [];
  return {
    version: PANEL_SPEC_VERSION,
    kind,
    query: normalizeQuery(input.query),
    transform: transforms,
    viz: normalizeViz(input.viz, kind),
    interactions: normalizeInteractions(input.interactions),
    drilldown: normalizeDrilldowns(input.drilldown),
    refresh: normalizeRefresh(input.refresh),
  };
}

export function isPanelSpecCompatible(value: unknown): boolean {
  if (!isObject(value)) return false;
  return versionMajor(value.version) === 1 && PANEL_KINDS.includes(value.kind as PanelKind);
}

function cleanCapabilityText(value: unknown, fallback: string): string {
  return cleanText(value, 120) || fallback;
}

export function registerPanelRenderer(capability: PanelRendererCapability): PanelRendererCapability {
  const normalized: PanelRendererCapability = {
    id: cleanCapabilityText(capability.id, 'renderer'),
    kind: cleanCapabilityText(capability.kind, 'stat'),
    version: cleanCapabilityText(capability.version, PANEL_REGISTRY_VERSION),
    label: cleanCapabilityText(capability.label, capability.kind || 'Panel'),
    dataSources: normalizeStringList(capability.dataSources, 32, 64),
    features: normalizeStringList(capability.features, 32, 64),
  };
  rendererRegistry.set(normalized.id, normalized);
  return { ...normalized, dataSources: [...normalized.dataSources], features: [...normalized.features] };
}

export function registerPanelDataSource(capability: PanelDataSourceCapability): PanelDataSourceCapability {
  const normalized: PanelDataSourceCapability = {
    id: cleanCapabilityText(capability.id, 'source'),
    version: cleanCapabilityText(capability.version, PANEL_REGISTRY_VERSION),
    signals: normalizeStringList(capability.signals, 32, 64),
    protocols: normalizeStringList(capability.protocols, 32, 120),
    features: normalizeStringList(capability.features, 32, 64),
  };
  dataSourceRegistry.set(normalized.id, normalized);
  return { ...normalized, signals: [...normalized.signals], protocols: [...normalized.protocols], features: [...normalized.features] };
}

const defaultRendererFeatures: Record<string, string[]> = {
  line: ['zoom', 'cross-filter', 'thresholds'],
  bar: ['group-by', 'stacked', 'cross-filter'],
  stat: ['thresholds', 'drilldown'],
  table: ['sort', 'column-filter', 'drilldown'],
  heatmap: ['bucket-grid', 'zoom', 'cross-filter'],
  topology: ['pan', 'zoom', 'selection', 'drilldown'],
  flamegraph: ['zoom', 'selection', 'drilldown'],
  logs: ['search', 'facets', 'trace-correlation'],
  trace: ['waterfall', 'span-selection', 'log-correlation'],
};

for (const kind of PANEL_KINDS) {
  registerPanelRenderer({
    id: kind,
    kind,
    version: PANEL_REGISTRY_VERSION,
    label: kind,
    dataSources: kind === 'logs' ? ['logs'] : kind === 'trace' || kind === 'flamegraph' ? ['traces'] : kind === 'topology' ? ['topology'] : ['metrics'],
    features: defaultRendererFeatures[kind] ?? [],
  });
}

registerPanelDataSource({ id: 'metrics', version: PANEL_REGISTRY_VERSION, signals: ['metrics'], protocols: ['otlp/http-json', 'otlp/http-protobuf', 'prometheus'], features: ['time-series', 'labels', 'aggregation'] });
registerPanelDataSource({ id: 'logs', version: PANEL_REGISTRY_VERSION, signals: ['logs'], protocols: ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc'], features: ['search', 'facets', 'correlation'] });
registerPanelDataSource({ id: 'traces', version: PANEL_REGISTRY_VERSION, signals: ['traces'], protocols: ['otlp/http-json', 'otlp/http-protobuf', 'otlp/grpc'], features: ['waterfall', 'span-links', 'correlation'] });
registerPanelDataSource({ id: 'events', version: PANEL_REGISTRY_VERSION, signals: ['incidents', 'deployments', 'changes'], protocols: ['internal-api', 'webhook'], features: ['timeline', 'correlation'] });
registerPanelDataSource({ id: 'topology', version: PANEL_REGISTRY_VERSION, signals: ['objects', 'dependencies'], protocols: ['internal-api', 'otlp'], features: ['graph', 'health'] });

export function listPanelRenderers(): PanelRendererCapability[] {
  return [...rendererRegistry.values()].map((item) => ({ ...item, dataSources: [...item.dataSources], features: [...item.features] }));
}

export function listPanelDataSources(): PanelDataSourceCapability[] {
  return [...dataSourceRegistry.values()].map((item) => ({ ...item, signals: [...item.signals], protocols: [...item.protocols], features: [...item.features] }));
}

/** Small, additive capability payload safe to expose from the public endpoint. */
export function getPanelRegistrySummary(): PanelRegistrySummary {
  return {
    schema: PANEL_REGISTRY_SCHEMA,
    version: PANEL_REGISTRY_VERSION,
    specVersion: PANEL_SPEC_VERSION,
    renderers: listPanelRenderers().map(({ id, kind, version }) => ({ id, kind, version })),
    dataSources: listPanelDataSources().map(({ id, version, signals }) => ({ id, version, signals })),
  };
}

export const panelRegistrySummary = getPanelRegistrySummary;
