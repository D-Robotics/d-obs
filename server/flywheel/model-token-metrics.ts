/**
 * Pure aggregation for token consumption split by upstream model.
 *
 * Rows come from the same deduplicated agent_run_records projection as the
 * operator metrics totals (one row per run_id).  Only bounded, low-sensitivity
 * fields leave the server: model name, run count, and numeric token sums.
 */
export type ModelTokenMetricRow = {
  day: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

export type ModelTokenBreakdown = {
  model: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  share: number | null;
};

export type ModelTokenMetrics = {
  configured: boolean;
  windowDays: number;
  models: ModelTokenBreakdown[];
  totals: {
    runs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

const MAX_MODELS = 24;
const LABEL_MAX = 96;

export function emptyModelTokenMetrics(windowDays: number): ModelTokenMetrics {
  return {
    configured: false,
    windowDays,
    models: [],
    totals: { runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function normalizeLabel(value: unknown): string {
  const label = String(value ?? '')
    .trim()
    .slice(0, LABEL_MAX);
  return label || 'unknown';
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function buildModelTokenMetrics(
  rows: ModelTokenMetricRow[],
  windowDays: number,
): ModelTokenMetrics {
  const byModel = new Map<
    string,
    { runs: number; promptTokens: number; completionTokens: number }
  >();
  for (const row of rows) {
    const model = normalizeLabel(row.model);
    const current = byModel.get(model) ?? { runs: 0, promptTokens: 0, completionTokens: 0 };
    current.runs += 1;
    current.promptTokens += finiteNumber(row.promptTokens);
    current.completionTokens += finiteNumber(row.completionTokens);
    byModel.set(model, current);
  }

  const models = [...byModel.entries()].map(([model, value]) => ({
    model,
    runs: value.runs,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.promptTokens + value.completionTokens,
    share: null as number | null,
  }));
  const totalTokens = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const runs = models.reduce((sum, item) => sum + item.runs, 0);
  for (const item of models) {
    item.share = totalTokens > 0 ? item.totalTokens / totalTokens : null;
  }
  models.sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));

  return {
    configured: true,
    windowDays,
    models: models.slice(0, MAX_MODELS),
    totals: {
      runs,
      promptTokens: models.reduce((sum, item) => sum + item.promptTokens, 0),
      completionTokens: models.reduce((sum, item) => sum + item.completionTokens, 0),
      totalTokens,
    },
  };
}
