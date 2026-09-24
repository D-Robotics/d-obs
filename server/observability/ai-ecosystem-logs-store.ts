/**
 * OTLP logs 落库与查询（低敏感白名单，与 traces 同一策略家族）。
 *
 * 表结构与 tools/observability-signals-schema.sql 同源；store 首次写入时执行
 * 相同的幂等 DDL，独立部署可以不手工跑 SQL。保留策略按
 * RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS（默认 14 天）周期清理。
 */

export type NormalizedLogRecord = {
  service: string;
  environment: string;
  severityText: string;
  severityNumber: number;
  body: string;
  attributes: Record<string, string | number | boolean>;
  traceId: string | null;
  spanId: string | null;
  timestampMs: number;
};

export type LogQueryOptions = {
  owner?: string;
  service?: string;
  severityMin?: number;
  fromMs?: number;
  toMs?: number;
  limit?: number;
};

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
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
create table if not exists public.studio_observability_logs (
  id bigint generated always as identity primary key,
  owner text not null,
  service text not null default 'unknown',
  environment text not null default 'unknown',
  severity_text text not null default 'INFO',
  severity_number int not null default 9 check (severity_number between 1 and 24),
  body text null,
  attributes jsonb not null default '{}'::jsonb,
  trace_id text null,
  span_id text null,
  timestamp_ms bigint not null,
  received_at timestamptz not null default now()
);
create index if not exists studio_observability_logs_owner_time_idx
  on public.studio_observability_logs (owner, timestamp_ms desc);
create index if not exists studio_observability_logs_received_idx
  on public.studio_observability_logs (received_at);
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

export function signalRetentionDays(): number {
  const configured = Number(process.env.RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS ?? '');
  if (!Number.isFinite(configured)) return 14;
  return Math.max(1, Math.min(365, Math.floor(configured)));
}

const CLEANUP_INTERVAL_MS = 30 * 60_000;
let lastCleanupAt = 0;

async function cleanupExpired(p: Pool): Promise<void> {
  await p.query(
    `delete from public.studio_observability_logs
     where received_at < now() - ($1 || ' days')::interval`,
    [String(signalRetentionDays())],
  );
}

/** 摄取路径调用：每 30 分钟至多触发一次保留清理，失败静默（清理失败不阻断写入）。 */
export function maybeCleanupExpiredLogs(): void {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  void pool()
    .then((p) => cleanupExpired(p))
    .catch(() => undefined);
}

const INSERT_CHUNK = 100;

export async function insertLogRecords(owner: string, records: NormalizedLogRecord[]): Promise<number> {
  if (!records.length) return 0;
  const p = await pool();
  await ensureSchema(p);
  maybeCleanupExpiredLogs();
  let inserted = 0;
  for (let offset = 0; offset < records.length; offset += INSERT_CHUNK) {
    const chunk = records.slice(offset, offset + INSERT_CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((record, index) => {
      const base = index * 11;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`,
      );
      params.push(
        owner,
        record.service,
        record.environment,
        record.severityText,
        record.severityNumber,
        record.body,
        JSON.stringify(record.attributes),
        record.traceId,
        record.spanId,
        record.timestampMs,
        new Date().toISOString(),
      );
    });
    const result = await p.query(
      `insert into public.studio_observability_logs
         (owner, service, environment, severity_text, severity_number, body,
          attributes, trace_id, span_id, timestamp_ms, received_at)
       values ${values.join(',')}`,
      params,
    );
    inserted += result.rowCount ?? chunk.length;
  }
  return inserted;
}

function rowToLog(row: Record<string, unknown>): Record<string, unknown> {
  const timestamp = Number(row.timestamp_ms);
  return {
    id: String(row.id ?? ''),
    owner: String(row.owner ?? ''),
    service: String(row.service ?? 'unknown'),
    environment: String(row.environment ?? 'unknown'),
    severityText: String(row.severity_text ?? 'INFO'),
    severityNumber: Number(row.severity_number ?? 9),
    body: typeof row.body === 'string' ? row.body : '',
    attributes: row.attributes && typeof row.attributes === 'object' ? row.attributes : {},
    traceId: typeof row.trace_id === 'string' ? row.trace_id : null,
    spanId: typeof row.span_id === 'string' ? row.span_id : null,
    timestampMs: Number.isFinite(timestamp) ? timestamp : 0,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at ?? ''),
  };
}

export async function queryLogs(options: LogQueryOptions = {}): Promise<Record<string, unknown>[]> {
  const p = await pool();
  await ensureSchema(p);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.owner) {
    params.push(options.owner);
    conditions.push(`owner = $${params.length}`);
  }
  if (options.service) {
    params.push(options.service);
    conditions.push(`service = $${params.length}`);
  }
  if (options.severityMin !== undefined) {
    params.push(Math.max(1, Math.min(24, Math.floor(options.severityMin))));
    conditions.push(`severity_number >= $${params.length}`);
  }
  if (options.fromMs !== undefined) {
    params.push(Math.trunc(options.fromMs));
    conditions.push(`timestamp_ms >= $${params.length}`);
  }
  if (options.toMs !== undefined) {
    params.push(Math.trunc(options.toMs));
    conditions.push(`timestamp_ms <= $${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, Math.floor(options.limit ?? 100))));
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const result = await p.query(
    `select id, owner, service, environment, severity_text, severity_number, body,
            attributes, trace_id, span_id, timestamp_ms, received_at
       from public.studio_observability_logs
       ${where}
       order by timestamp_ms desc
       limit $${params.length}`,
    params,
  );
  return result.rows.map(rowToLog);
}

export async function logServicesForOwner(owner?: string): Promise<string[]> {
  const p = await pool();
  await ensureSchema(p);
  const params: unknown[] = [];
  let where = '';
  if (owner) {
    params.push(owner);
    where = 'where owner = $1';
  }
  const result = await p.query(
    `select distinct service from public.studio_observability_logs ${where} order by service limit 100`,
    params,
  );
  return result.rows.map((row) => String(row.service ?? '')).filter(Boolean);
}

export type LogFacet = {
  service: string;
  owner: string;
  ownerLabel: string;
  subjectType: string;
  rows: number;
  lastAtMs: number;
};

/**
 * 应用维度聚合：近 N 天内每个 (service, owner) 的日志量与最近时间，
 * 并 join 接入凭据注册表把 owner 哈希翻成可读的应用归属名。
 * 注册表为空/不存在时降级为不带归属名的聚合，保证 facets 始终可用。
 */
export async function logFacets(sinceMs: number): Promise<LogFacet[]> {
  const p = await pool();
  await ensureSchema(p);
  const base = String(Math.max(0, Math.trunc(sinceMs)));
  const joined = `select l.service, l.owner,
         coalesce(nullif(t.display_name, ''), '') as owner_label,
         coalesce(t.subject_type, '') as subject_type,
         count(*)::int as rows,
         max(l.timestamp_ms)::bigint as last_at
    from public.studio_observability_logs l
    left join public.studio_obs_ingest_tokens t
      on t.owner = l.owner and t.status = 'active'
   where l.timestamp_ms >= $1
   group by l.service, l.owner, owner_label, subject_type
   order by last_at desc
   limit 300`;
  const plain = `select service, owner, '' as owner_label, '' as subject_type,
         count(*)::int as rows, max(timestamp_ms)::bigint as last_at
    from public.studio_observability_logs
   where timestamp_ms >= $1
   group by service, owner
   order by last_at desc
   limit 300`;
  let result;
  try {
    result = await p.query(joined, [base]);
  } catch {
    result = await p.query(plain, [base]);
  }
  return result.rows.map((row) => ({
    service: String(row.service ?? 'unknown'),
    owner: String(row.owner ?? ''),
    ownerLabel: String(row.owner_label ?? ''),
    subjectType: String(row.subject_type ?? ''),
    rows: Number(row.rows ?? 0),
    lastAtMs: Number(row.last_at ?? 0),
  }));
}
