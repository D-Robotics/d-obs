/**
 * OTLP metrics 持久化与查询。
 *
 * series = (owner, metric, 归一化 labels)；样本以 (series_id, ts_ms) 主键
 * upsert（重复时间戳取最新值）。查询侧按时间桶均值降采样，供工作台直接绘图。
 * 保留策略与 logs 同参数（RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS）。
 */

export type PersistMetricPoint = {
  name: string;
  value: number;
  timestampMs: number;
  labels: Record<string, string>;
};

export type MetricSeriesSummary = {
  seriesId: number;
  owner: string;
  metric: string;
  labels: Record<string, unknown>;
  lastTsMs: number | null;
  lastValue: number | null;
};

export type MetricSeriesQuery = {
  owner?: string;
  metric?: string;
  limit?: number;
};

export type MetricRangeQuery = MetricSeriesQuery & {
  fromMs: number;
  toMs: number;
  /** 期望返回的最大点数/系列；服务端换算成时间桶宽做均值降采样。 */
  maxPoints?: number;
};

export type MetricRangeSeries = {
  seriesId: number;
  metric: string;
  labels: Record<string, unknown>;
  bucketMs: number;
  points: Array<{ ts: number; value: number }>;
};

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
create table if not exists public.studio_observability_metric_series (
  series_id bigint generated always as identity primary key,
  owner text not null,
  metric text not null,
  labels jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (owner, metric, fingerprint)
);
create index if not exists studio_observability_metric_series_metric_idx
  on public.studio_observability_metric_series (metric);
create table if not exists public.studio_observability_metric_samples (
  series_id bigint not null,
  ts_ms bigint not null,
  value double precision not null,
  primary key (series_id, ts_ms)
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

function fingerprint(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join('\u0001');
}

const CLEANUP_INTERVAL_MS = 30 * 60_000;
let lastCleanupAt = 0;

async function cleanupExpired(p: Pool): Promise<void> {
  const days = Number(process.env.RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS ?? '');
  const retentionDays = Number.isFinite(days) ? Math.max(1, Math.min(365, Math.floor(days))) : 14;
  await p.query(
    `delete from public.studio_observability_metric_samples
     where ts_ms < (extract(epoch from now()) * 1000 - $1::bigint * 86400000)`,
    [String(retentionDays)],
  );
  // 无样本的孤儿 series 一并回收。
  await p.query(
    `delete from public.studio_observability_metric_series s
     where not exists (
       select 1 from public.studio_observability_metric_samples m
       where m.series_id = s.series_id
     ) and s.created_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
}

/** 摄取路径调用：每 30 分钟至多触发一次保留清理，失败静默。 */
export function maybeCleanupExpiredMetricSamples(): void {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  void pool()
    .then((p) => cleanupExpired(p))
    .catch(() => undefined);
}

export async function persistMetricPoints(owner: string, points: PersistMetricPoint[]): Promise<number> {
  if (!points.length) return 0;
  const p = await pool();
  await ensureSchema(p);
  maybeCleanupExpiredMetricSamples();
  // 先为出现过的 (metric, labels) 解析/创建 series_id，再分块批量 upsert 样本。
  const seriesCache = new Map<string, number>();
  const samples: Array<{ seriesId: number; tsMs: number; value: number }> = [];
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    const fp = fingerprint(point.labels);
    const cacheKey = `${point.name}\u0000${fp}`;
    let seriesId = seriesCache.get(cacheKey);
    if (seriesId === undefined) {
      const result = await p.query(
        `insert into public.studio_observability_metric_series (owner, metric, labels, fingerprint)
         values ($1, $2, $3::jsonb, $4)
         on conflict (owner, metric, fingerprint) do update set metric = excluded.metric
         returning series_id`,
        [owner, point.name, JSON.stringify(point.labels), fp],
      );
      seriesId = Number(result.rows[0]?.series_id);
      if (!Number.isFinite(seriesId)) continue;
      seriesCache.set(cacheKey, seriesId);
    }
    samples.push({ seriesId, tsMs: Math.trunc(point.timestampMs), value: point.value });
  }
  const CHUNK = 200;
  for (let offset = 0; offset < samples.length; offset += CHUNK) {
    const chunk = samples.slice(offset, offset + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((sample, index) => {
      const base = index * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(sample.seriesId, sample.tsMs, sample.value);
    });
    await p.query(
      `insert into public.studio_observability_metric_samples (series_id, ts_ms, value)
       values ${values.join(',')}
       on conflict (series_id, ts_ms) do update set value = excluded.value`,
      params,
    );
  }
  return samples.length;
}

function parseLabels(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function queryMetricSeries(options: MetricSeriesQuery = {}): Promise<MetricSeriesSummary[]> {
  const p = await pool();
  await ensureSchema(p);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.owner) {
    params.push(options.owner);
    conditions.push(`s.owner = $${params.length}`);
  }
  if (options.metric) {
    params.push(options.metric);
    conditions.push(`s.metric = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, Math.floor(options.limit ?? 200))));
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const result = await p.query(
    `select s.series_id, s.owner, s.metric, s.labels,
            max(m.ts_ms) as last_ts_ms,
            (array_agg(m.value order by m.ts_ms desc))[1] as last_value
       from public.studio_observability_metric_series s
       join public.studio_observability_metric_samples m on m.series_id = s.series_id
       ${where}
       group by s.series_id
       order by s.metric, s.series_id
       limit $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    seriesId: Number(row.series_id),
    owner: String(row.owner ?? ''),
    metric: String(row.metric ?? ''),
    labels: parseLabels(row.labels),
    lastTsMs: row.last_ts_ms == null ? null : Number(row.last_ts_ms),
    lastValue: row.last_value == null ? null : Number(row.last_value),
  }));
}

export async function queryMetricRanges(options: MetricRangeQuery): Promise<MetricRangeSeries[]> {
  const p = await pool();
  await ensureSchema(p);
  const fromMs = Math.trunc(options.fromMs);
  const toMs = Math.trunc(options.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const conditions: string[] = ['m.ts_ms >= $1', 'm.ts_ms <= $2'];
  const params: unknown[] = [fromMs, toMs];
  if (options.owner) {
    params.push(options.owner);
    conditions.push(`s.owner = $${params.length}`);
  }
  if (options.metric) {
    params.push(options.metric);
    conditions.push(`s.metric = $${params.length}`);
  }
  const result = await p.query(
    `select s.series_id, s.metric, s.labels, m.ts_ms, m.value
       from public.studio_observability_metric_series s
       join public.studio_observability_metric_samples m on m.series_id = s.series_id
       where ${conditions.join(' and ')}
       order by s.series_id, m.ts_ms
       limit 50000`,
    params,
  );
  const maxPoints = Math.max(20, Math.min(500, Math.floor(options.maxPoints ?? 200)));
  const bucketMs = Math.max(1, Math.ceil((toMs - fromMs) / maxPoints));
  const grouped = new Map<number, MetricRangeSeries>();
  for (const row of result.rows) {
    const seriesId = Number(row.series_id);
    let entry = grouped.get(seriesId);
    if (!entry) {
      entry = { seriesId, metric: String(row.metric ?? ''), labels: parseLabels(row.labels), bucketMs, points: [] };
      grouped.set(seriesId, entry);
    }
    const tsMs = Number(row.ts_ms);
    const value = Number(row.value);
    if (!Number.isFinite(tsMs) || !Number.isFinite(value)) continue;
    const bucket = Math.floor(tsMs / bucketMs) * bucketMs;
    const last = entry.points.at(-1);
    if (last && last.ts === bucket) {
      // 同桶均值降采样：增量平均。
      last.value = last.value + (value - last.value) / 2;
    } else {
      entry.points.push({ ts: bucket, value });
    }
  }
  return [...grouped.values()];
}
