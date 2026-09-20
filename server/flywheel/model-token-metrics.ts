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

export type ModelTokenCost = {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
};

export type ModelTokenBreakdown = {
  model: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  share: number | null;
  cost: ModelTokenCost | null;
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
    cost: ModelTokenCost | null;
  };
};

export type ModelPriceMap = Record<string, { inputPerM: number; outputPerM: number; currency: string }>;

const MAX_MODELS = 24;
const LABEL_MAX = 96;

export function emptyModelTokenMetrics(windowDays: number): ModelTokenMetrics {
  return {
    configured: false,
    windowDays,
    models: [],
    totals: { runs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null },
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
  prices?: ModelPriceMap,
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

  // 成本 = token / 1e6 × 单价；模型未配置价格时保持 null（不猜价）。
  const costFor = (model: string, promptTokens: number, completionTokens: number): ModelTokenCost | null => {
    const price = prices?.[model];
    if (!price) return null;
    const inputCost = (promptTokens / 1_000_000) * price.inputPerM;
    const outputCost = (completionTokens / 1_000_000) * price.outputPerM;
    return {
      inputCost: Math.round(inputCost * 1e6) / 1e6,
      outputCost: Math.round(outputCost * 1e6) / 1e6,
      totalCost: Math.round((inputCost + outputCost) * 1e6) / 1e6,
      currency: price.currency,
    };
  };

  const models = [...byModel.entries()].map(([model, value]) => ({
    model,
    runs: value.runs,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.promptTokens + value.completionTokens,
    share: null as number | null,
    cost: costFor(model, value.promptTokens, value.completionTokens),
  }));
  const totalTokens = models.reduce((sum, item) => sum + item.totalTokens, 0);
  const runs = models.reduce((sum, item) => sum + item.runs, 0);
  for (const item of models) {
    item.share = totalTokens > 0 ? item.totalTokens / totalTokens : null;
  }
  models.sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));

  const costedModels = models.filter((item) => item.cost);
  const cost: ModelTokenCost | null = costedModels.length
    ? {
        inputCost: Math.round(costedModels.reduce((sum, item) => sum + (item.cost?.inputCost ?? 0), 0) * 1e6) / 1e6,
        outputCost: Math.round(costedModels.reduce((sum, item) => sum + (item.cost?.outputCost ?? 0), 0) * 1e6) / 1e6,
        totalCost: Math.round(costedModels.reduce((sum, item) => sum + (item.cost?.totalCost ?? 0), 0) * 1e6) / 1e6,
        currency: costedModels[0]?.cost?.currency ?? 'CNY',
      }
    : null;

  return {
    configured: true,
    windowDays,
    models: models.slice(0, MAX_MODELS),
    totals: {
      runs,
      promptTokens: models.reduce((sum, item) => sum + item.promptTokens, 0),
      completionTokens: models.reduce((sum, item) => sum + item.completionTokens, 0),
      totalTokens,
      cost,
    },
  };
}
