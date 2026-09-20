/**
 * 模型单价表（每百万 token 的 input/output 价格）。成本归因的唯一真源：
 * 运营指标按模型聚合 token 后乘以单价得到成本；未配置价格的模型优雅降级
 * （不显示成本）。表结构与 tools/observability-signals-schema.sql 同源。
 */

export type ModelPriceRecord = {
  model: string;
  inputPerM: number;
  outputPerM: number;
  currency: string;
  updatedAt: string;
  updatedBy: string;
};

export type ModelPriceMap = Record<string, { inputPerM: number; outputPerM: number; currency: string }>;

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

const ENSURE_SCHEMA_SQL = `
create table if not exists public.studio_model_prices (
  model text primary key,
  input_per_m double precision not null default 0,
  output_per_m double precision not null default 0,
  currency text not null default 'CNY',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p.query(ENSURE_SCHEMA_SQL).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

const MODEL_MAX = 96;

function cleanModel(value: unknown): string {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, MODEL_MAX);
}

function clampPrice(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(1e9, Math.round(parsed * 1e6) / 1e6);
}

function rowToPrice(row: Record<string, unknown>): ModelPriceRecord {
  return {
    model: String(row.model ?? ''),
    inputPerM: Number(row.input_per_m ?? 0),
    outputPerM: Number(row.output_per_m ?? 0),
    currency: String(row.currency ?? 'CNY').slice(0, 8),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
    updatedBy: String(row.updated_by ?? ''),
  };
}

export async function listModelPrices(): Promise<ModelPriceRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select * from public.studio_model_prices order by model limit 200`,
  );
  return result.rows.map(rowToPrice);
}

export async function upsertModelPrice(input: {
  model: string;
  inputPerM: number;
  outputPerM: number;
  currency?: string;
  updatedBy?: string;
}): Promise<ModelPriceRecord> {
  const model = cleanModel(input.model);
  if (!model) throw new Error('invalid_model');
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `insert into public.studio_model_prices (model, input_per_m, output_per_m, currency, updated_by)
     values ($1, $2, $3, $4, $5)
     on conflict (model) do update set
       input_per_m = excluded.input_per_m,
       output_per_m = excluded.output_per_m,
       currency = excluded.currency,
       updated_at = now(),
       updated_by = excluded.updated_by
     returning *`,
    [
      model,
      clampPrice(input.inputPerM),
      clampPrice(input.outputPerM),
      String(input.currency ?? 'CNY').replace(/\0/g, '').trim().slice(0, 8) || 'CNY',
      String(input.updatedBy ?? '').replace(/\0/g, '').trim().slice(0, 120),
    ],
  );
  return rowToPrice(result.rows[0] ?? {});
}

/** 供聚合层一次性取价；查询失败由调用方降级（返回 undefined = 不展示成本）。 */
export async function loadModelPriceMap(): Promise<ModelPriceMap | undefined> {
  const prices = await listModelPrices();
  const map: ModelPriceMap = {};
  for (const price of prices) {
    map[price.model] = { inputPerM: price.inputPerM, outputPerM: price.outputPerM, currency: price.currency };
  }
  return Object.keys(map).length ? map : undefined;
}

export { clampPrice };
