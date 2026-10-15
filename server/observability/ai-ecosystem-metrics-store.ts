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
  /** 按账号标签过滤（labels->>'sso_user_id'；摄入白名单已放行该标签）。 */
  ssoUserId?: string;
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

type MetricDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
type MetricClient = MetricDb & { release(): void };
type Pool = MetricDb & { connect(): Promise<MetricClient>; end(): Promise<void>; on(event: 'error', listener: (error: Error) => void): void };

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number; connectionTimeoutMillis?: number; statement_timeout?: number; lock_timeout?: number }) => Pool };
      };
      const p = new pgMod.default.Pool({ connectionString, max: 2, connectionTimeoutMillis: 3_000, statement_timeout: 3_000, lock_timeout: 3_000 });
      p.on('error', () => console.warn('[metrics-store] idle PostgreSQL connection failed'));
      return p;
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
  const configured = String(process.env.RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS ?? '').trim();
  const days = configured ? Number(configured) : Number.NaN;
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

// Reception acknowledges only committed samples. The legacy enqueue name and
// gauge functions remain compatible with both shared HTTP/gRPC ingestion paths.
const METRIC_QUEUE_CAPACITY = 8_192;
let metricQueueDropped = 0;
let metricPendingPoints = 0;
const metricWrites = new Set<Promise<number>>();

export async function enqueueMetricPoints(owner: string, points: PersistMetricPoint[]): Promise<number> {
  if (!String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim()) {
    metricQueueDropped += points.length;
    return points.length;
  }
  const valid = points.filter(point => Number.isFinite(point.value) && Number.isFinite(point.timestampMs));
  const invalid = points.length - valid.length;
  if (metricPendingPoints + valid.length > METRIC_QUEUE_CAPACITY) {
    metricQueueDropped += points.length;
    return points.length;
  }
  metricQueueDropped += invalid;
  metricPendingPoints += valid.length;
  const write = persistMetricPoints(owner, valid);
  metricWrites.add(write);
  try { await write; return invalid; }
  finally { metricWrites.delete(write); metricPendingPoints -= valid.length; }
}

export function metricQueueDepth(): number { return metricPendingPoints; }
export function metricQueueDroppedTotal(): number { return metricQueueDropped; }
/** Wait for reception writes already in flight; failures are reported to their callers. */
export async function flushMetricQueueNow(): Promise<void> { await Promise.all([...metricWrites]); }
export function resetAiEcosystemMetricQueueForTest(): void { metricQueueDropped = 0; }
export async function closeAiEcosystemMetricStoreForTest(): Promise<void> {
  if (poolReady) await (await poolReady).end();
  poolReady = null;
  schemaReady = null;
}

export async function persistMetricPoints(owner: string, points: PersistMetricPoint[]): Promise<number> {
  if (!points.length) return 0;
  const p = await pool();
  await ensureSchema(p);
  maybeCleanupExpiredMetricSamples();
  const db = await p.connect();
  try {
  await db.query('begin');
  // 先为出现过的 (metric, labels) 解析/创建 series_id，再分块批量 upsert 样本。
  const seriesCache = new Map<string, number>();
  const samples: Array<{ seriesId: number; tsMs: number; value: number }> = [];
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    const fp = fingerprint(point.labels);
    const cacheKey = `${point.name}\u0000${fp}`;
    let seriesId = seriesCache.get(cacheKey);
    if (seriesId === undefined) {
      const result = await db.query(
        `insert into public.studio_observability_metric_series (owner, metric, labels, fingerprint)
         values ($1, $2, $3::jsonb, $4)
         on conflict (owner, metric, fingerprint) do update set metric = excluded.metric
         returning series_id`,
        [owner, point.name, JSON.stringify(point.labels), fp],
      );
      seriesId = Number(result.rows[0]?.series_id);
      if (!Number.isFinite(seriesId)) throw new Error('metric_series_unavailable');
      seriesCache.set(cacheKey, seriesId);
    }
    samples.push({ seriesId, tsMs: Math.trunc(point.timestampMs), value: point.value });
  }
  const CHUNK = 200;
  // 去重后再入 SQL：不同 datapoint 经白名单标签归一化可能坍缩到同一
  // (series_id, ts_ms)，bulk on conflict 命中同一行两次会令整批落库失败并
  // 永久卡死写队列。保留后到值，与 upsert 的"重复时间戳取最新"语义一致。
  const deduped = new Map<string, { seriesId: number; tsMs: number; value: number }>();
  for (const sample of samples) deduped.set(`${sample.seriesId}:${sample.tsMs}`, sample);
  const ordered = [...deduped.values()];
  for (let offset = 0; offset < ordered.length; offset += CHUNK) {
    const chunk = ordered.slice(offset, offset + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((sample, index) => {
      const base = index * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(sample.seriesId, sample.tsMs, sample.value);
    });
    await db.query(
      `insert into public.studio_observability_metric_samples (series_id, ts_ms, value)
       values ${values.join(',')}
       on conflict (series_id, ts_ms) do update set value = excluded.value`,
      params,
    );
  }
  await db.query('commit');
  return samples.length;
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); }
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
  if (options.ssoUserId) {
    params.push(options.ssoUserId);
    conditions.push(`s.labels->>'sso_user_id' = $${params.length}`);
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
  const maxPoints = Math.max(20, Math.min(500, Math.floor(options.maxPoints ?? 200)));
  const bucketMs = Math.max(1, Math.ceil((toMs - fromMs) / maxPoints));
  // 桶聚合下推到 SQL（floor(ts/bucket) + avg），避免把最多 5 万行原始样本拉到进程内。
  const conditions: string[] = ['m.ts_ms >= $1', 'm.ts_ms <= $2'];
  const params: unknown[] = [fromMs, toMs, bucketMs];
  if (options.owner) {
    params.push(options.owner);
    conditions.push(`s.owner = $${params.length}`);
  }
  if (options.metric) {
    params.push(options.metric);
    conditions.push(`s.metric = $${params.length}`);
  }
  if (options.ssoUserId) {
    params.push(options.ssoUserId);
    conditions.push(`s.labels->>'sso_user_id' = $${params.length}`);
  }
  const result = await p.query(
    `select s.series_id, s.metric, s.labels,
            (floor(m.ts_ms / $3::bigint) * $3::bigint)::bigint as bucket_ts,
            avg(m.value) as bucket_value
       from public.studio_observability_metric_series s
       join public.studio_observability_metric_samples m on m.series_id = s.series_id
       where ${conditions.join(' and ')}
       group by s.series_id, s.metric, s.labels, bucket_ts
       order by s.series_id, bucket_ts
       limit 20000`,
    params,
  );
  const grouped = new Map<number, MetricRangeSeries>();
  for (const row of result.rows) {
    const seriesId = Number(row.series_id);
    let entry = grouped.get(seriesId);
    if (!entry) {
      entry = { seriesId, metric: String(row.metric ?? ''), labels: parseLabels(row.labels), bucketMs, points: [] };
      grouped.set(seriesId, entry);
    }
    const ts = Number(row.bucket_ts);
    const value = Number(row.bucket_value);
    if (Number.isFinite(ts) && Number.isFinite(value)) entry.points.push({ ts, value });
  }
  return [...grouped.values()];
}
