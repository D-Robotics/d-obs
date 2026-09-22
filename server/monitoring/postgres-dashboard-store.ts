import {
  POSTGRES_AI_VIEWS,
  isPostgresAiQueryableTable,
  isPostgresTableSecretColumn,
  postgresTableDescription,
} from './postgres-dashboard-catalog.js';

/**
 * Central PostgreSQL dashboard data. Catalog identifiers are validated and quoted before use;
 * hard credentials are never selected by table detail or export queries.
 */

export type PostgresQueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
  fields?: Array<{ name: string }>;
};
export type PostgresDashboardClient = {
  query: (text: string, params?: unknown[]) => Promise<PostgresQueryResult>;
  release: () => void;
};
export type PostgresDashboardPool = {
  query: (text: string, params?: unknown[]) => Promise<PostgresQueryResult>;
  connect?: () => Promise<PostgresDashboardClient>;
};

type DatabaseStatus = 'healthy' | 'warning' | 'critical';

const DATA_SOURCES = [
  {
    key: 'conversation_turns',
    label: '对话归档',
    table: 'conversation_turns',
    timestamp: 'recorded_at',
    color: '#00665f',
  },
  {
    key: 'agent_run_records',
    label: 'Agent Run',
    table: 'agent_run_records',
    timestamp: 'started_at',
    color: '#2f7da8',
  },
  {
    key: 'studio_daily_usage',
    label: '日活 / 登录',
    table: 'studio_daily_usage',
    timestamp: 'created_at',
    color: '#7c5ce5',
  },
  {
    key: 'product_events',
    label: '产品事件',
    table: 'product_events',
    timestamp: 'occurred_at',
    color: '#d97706',
  },
  {
    key: 'studio_ops_events',
    label: '运维事件',
    table: 'studio_ops_events',
    timestamp: 'occurred_at',
    color: '#d9363e',
  },
  {
    key: 'chat_feedback',
    label: '用户反馈',
    table: 'chat_feedback',
    timestamp: 'recorded_at',
    color: '#c2418c',
  },
  {
    key: 'credit_account',
    label: '积分账户',
    table: 'credit_account',
    timestamp: 'updated_at',
    color: '#64748b',
  },
] as const;

const DASHBOARD_QUERY_TIMEOUT_MS = 10_000;
const TABLE_DETAIL_QUERY_TIMEOUT_MS = 5_000;
const MAX_TABLE_PREVIEW_PAGE = 2_000;

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

let poolReady: Promise<PostgresDashboardPool> | null = null;
export async function getPostgresDashboardPool(): Promise<PostgresDashboardPool> {
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: {
          Pool: new (config: { connectionString: string; max?: number }) => PostgresDashboardPool;
        };
      };
      return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? '').trim();
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function clampHours(value: number): number {
  if (!Number.isFinite(value)) return 24;
  return Math.min(24 * 30, Math.max(1, Math.floor(value)));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export interface PostgresDatabaseDashboard {
  schema: 'rdk.studio.postgres_dashboard.v1';
  generatedAt: string;
  windowHours: number;
  bucket: 'hour' | 'day';
  health: {
    status: DatabaseStatus;
    reasons: string[];
    version: string;
    databaseSizeBytes: number;
    uptimeSeconds: number;
    sharedBuffers: string;
    connections: {
      used: number;
      max: number;
      ratio: number | null;
      active: number;
      idleInTransaction: number;
      waiting: number;
      longRunning: number;
    };
    cacheHitRatio: number | null;
    transactionRollbackRatio: number | null;
    commits: number;
    rollbacks: number;
    deadlocks: number;
    tempBytes: number;
    statsResetAt: string | null;
  };
  sources: Array<{
    key: string;
    label: string;
    color: string;
    estimatedRows: number;
    windowRows: number;
    latestAt: string | null;
    totalBytes: number;
  }>;
  trend: Array<{
    bucket: string;
    values: Record<string, number>;
  }>;
  relationshipGraph: PostgresRelationshipGraph;
  tables: Array<{
    schemaName: string;
    name: string;
    estimatedRows: number;
    deadRows: number;
    deadRowRatio: number | null;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    indexScanRatio: number | null;
    lastAutovacuumAt: string | null;
    lastAutoanalyzeAt: string | null;
    description: string;
    aiQueryable: boolean;
  }>;
}

export interface PostgresRelationshipGraph {
  schema: 'rdk.studio.postgres_relationship_graph.v1';
  databaseName: string;
  summary: {
    tableCount: number;
    foreignKeyCount: number;
    maskedViewCount: number;
    truncated: boolean;
  };
  nodes: Array<{
    id: string;
    kind: 'database' | 'schema' | 'table';
    label: string;
    schemaName?: string;
    estimatedRows?: number;
    description?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: 'contains' | 'foreign_key' | 'masked_view';
    label: string;
  }>;
}

export interface PostgresTableDetail {
  schema: 'rdk.studio.postgres_table_detail.v1';
  generatedAt: string;
  relation: {
    schemaName: string;
    name: string;
    kind: 'table' | 'partitioned_table';
    description: string;
    estimatedRows: number;
    totalBytes: number;
  };
  columns: Array<{
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue: string | null;
    description: string | null;
    primaryKey: boolean;
    previewable: boolean;
    sortable: boolean;
  }>;
  indexes: Array<{
    name: string;
    definition: string;
  }>;
  preview: {
    page: number;
    pageSize: number;
    hasMore: boolean;
    rows: Array<Record<string, unknown>>;
    hiddenColumnCount: number;
    sortColumn: string | null;
    sortDirection: PostgresTableSortDirection;
  };
}

export type PostgresTableSortDirection = 'asc' | 'desc';

export interface PostgresTableCsvExport {
  filename: string;
  columns: string[];
  sortColumn: string | null;
  sortDirection: PostgresTableSortDirection;
  rows: AsyncGenerator<Record<string, unknown>>;
}

export class PostgresTableDetailError extends Error {
  constructor(
    public readonly code:
      | 'postgres_table_invalid'
      | 'postgres_table_not_found'
      | 'postgres_table_sort_invalid',
    public readonly status: 400 | 404,
  ) {
    super(code);
    this.name = 'PostgresTableDetailError';
  }
}

function healthStatus(input: {
  connectionRatio: number | null;
  cacheHitRatio: number | null;
  idleInTransaction: number;
  waiting: number;
  longRunning: number;
}): { status: DatabaseStatus; reasons: string[] } {
  const reasons: string[] = [];
  let status: DatabaseStatus = 'healthy';
  if ((input.connectionRatio ?? 0) >= 0.9) {
    status = 'critical';
    reasons.push('数据库连接使用率已超过 90%');
  } else if ((input.connectionRatio ?? 0) >= 0.7) {
    status = 'warning';
    reasons.push('数据库连接使用率已超过 70%');
  }
  if (input.idleInTransaction >= 5) {
    status = 'critical';
    reasons.push(`${input.idleInTransaction} 个会话长时间处于 idle in transaction`);
  } else if (input.idleInTransaction > 0) {
    if (status === 'healthy') status = 'warning';
    reasons.push(`${input.idleInTransaction} 个会话处于 idle in transaction`);
  }
  if (input.waiting >= 5) {
    if (status === 'healthy') status = 'warning';
    reasons.push(`${input.waiting} 个会话正在等待锁或资源`);
  }
  if (input.longRunning >= 5) {
    if (status === 'healthy') status = 'warning';
    reasons.push(`${input.longRunning} 个查询已运行超过 30 秒`);
  }
  if (input.cacheHitRatio != null && input.cacheHitRatio < 0.95) {
    if (status === 'healthy') status = 'warning';
    reasons.push('缓存命中率低于 95%');
  }
  if (!reasons.length) reasons.push('连接、缓存与会话状态正常');
  return { status, reasons };
}

const DATABASE_SUMMARY_SQL = `
  select now() sampled_at,
         current_database() database_name,
         current_setting('server_version') version,
         current_setting('shared_buffers') shared_buffers,
         current_setting('max_connections')::int max_connections,
         pg_database_size(current_database())::bigint database_size_bytes,
         extract(epoch from (now() - pg_postmaster_start_time()))::bigint uptime_seconds,
         d.numbackends,
         d.xact_commit,
         d.xact_rollback,
         d.blks_read,
         d.blks_hit,
         d.deadlocks,
         d.temp_bytes,
         d.stats_reset
  from pg_stat_database d
  where d.datname = current_database()
`;

const SESSION_SUMMARY_SQL = `
  select count(*) filter (where state = 'active' and pid <> pg_backend_pid())::int active,
         count(*) filter (where state = 'idle in transaction')::int idle_in_transaction,
         count(*) filter (
           where state = 'active'
             and pid <> pg_backend_pid()
             and wait_event_type is not null
         )::int waiting,
         count(*) filter (
           where state = 'active'
             and pid <> pg_backend_pid()
             and query_start < now() - interval '30 seconds'
         )::int long_running
  from pg_stat_activity
  where datname = current_database()
`;

const TABLE_STATS_SQL = `
  select schemaname,
         relname,
         n_live_tup,
         n_dead_tup,
         seq_scan,
         idx_scan,
         pg_total_relation_size(relid)::bigint total_bytes,
         pg_relation_size(relid)::bigint table_bytes,
         pg_indexes_size(relid)::bigint index_bytes,
         last_autovacuum,
         last_autoanalyze,
         obj_description(relid, 'pg_class') table_comment
  from pg_stat_user_tables
  order by pg_total_relation_size(relid) desc, schemaname asc, relname asc
`;

const RELATIONSHIP_GRAPH_SQL = `
  select source_ns.nspname source_schema,
         source_table.relname source_table,
         target_ns.nspname target_schema,
         target_table.relname target_table,
         constraint_row.conname constraint_name,
         string_agg(source_column.attname, ', ' order by key_part.ordinality) source_columns,
         string_agg(target_column.attname, ', ' order by key_part.ordinality) target_columns
  from pg_constraint constraint_row
  join pg_class source_table on source_table.oid = constraint_row.conrelid
  join pg_namespace source_ns on source_ns.oid = source_table.relnamespace
  join pg_class target_table on target_table.oid = constraint_row.confrelid
  join pg_namespace target_ns on target_ns.oid = target_table.relnamespace
  cross join lateral generate_subscripts(constraint_row.conkey, 1) key_part(ordinality)
  join pg_attribute source_column
    on source_column.attrelid = source_table.oid
   and source_column.attnum = constraint_row.conkey[key_part.ordinality]
  join pg_attribute target_column
    on target_column.attrelid = target_table.oid
   and target_column.attnum = constraint_row.confkey[key_part.ordinality]
  where constraint_row.contype = 'f'
    and source_ns.nspname not in ('pg_catalog', 'information_schema')
    and target_ns.nspname not in ('pg_catalog', 'information_schema')
    and source_ns.nspname not like 'pg_toast%'
    and target_ns.nspname not like 'pg_toast%'
  group by source_ns.nspname, source_table.relname, target_ns.nspname,
           target_table.relname, constraint_row.conname
  order by source_ns.nspname, source_table.relname, constraint_row.conname
  limit 200
`;

const TABLE_DETAIL_RELATION_SQL = `
  select n.nspname schema_name,
         c.relname table_name,
         c.relkind relation_kind,
         c.reltuples::bigint estimated_rows,
         pg_total_relation_size(c.oid)::bigint total_bytes,
         obj_description(c.oid, 'pg_class') table_comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = $1
    and c.relname = $2
    and c.relkind in ('r', 'p')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
    and n.nspname not like 'pg_temp%'
  limit 1
`;

const TABLE_DETAIL_COLUMNS_SQL = `
  select a.attname column_name,
         format_type(a.atttypid, a.atttypmod) data_type,
         not a.attnotnull nullable,
         pg_get_expr(ad.adbin, ad.adrelid) default_value,
         col_description(a.attrelid, a.attnum) column_comment,
         exists (
           select 1
           from pg_index i
           where i.indrelid = a.attrelid
             and i.indisprimary
             and a.attnum = any(i.indkey)
         ) primary_key
  from pg_attribute a
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
    and a.attnum > 0
    and not a.attisdropped
  order by a.attnum
`;

const TABLE_DETAIL_INDEXES_SQL = `
  select indexname index_name, indexdef index_definition
  from pg_indexes
  where schemaname = $1 and tablename = $2
  order by indexname
`;

function normalizedCatalogName(value: unknown): string {
  const raw = String(value ?? '');
  if (raw.includes('\0')) throw new PostgresTableDetailError('postgres_table_invalid', 400);
  const name = raw.trim();
  if (!name || name.length > 128) throw new PostgresTableDetailError('postgres_table_invalid', 400);
  return name;
}

/**
 * 数据库面板默认表白名单（内容与 ops/db-panel-allowlist.txt 一致，防漂移测试兜底）。
 *
 * 为什么内嵌而不是运行时读 ops/：部署产物只带 dist，不带 ops/，默认收敛必须随代码走。
 * 为什么默认收紧：面板未设限时 admin token ≈ 共用中心库整库只读（含主站凭据表
 * credit_user_key、redemption_code 等），与本平台其余配置面的 fail-closed 姿态相悖。
 * 需要整库可见时显式设 `RDK_DB_PANEL_TABLES='*'`。
 */
export const DEFAULT_POSTGRES_DASHBOARD_TABLES: readonly string[] = [
  'agent_evolution_candidates',
  'agent_run_observability',
  'agent_run_records',
  'conversation_turns',
  'studio_alert_checks',
  'studio_alert_config',
  'studio_alert_configuration_audit',
  'studio_alert_incident_activity',
  'studio_alert_incidents',
  'studio_alert_maintenance_windows',
  'studio_alert_notifications',
  'studio_alert_worker_status',
  'studio_daily_usage',
  'studio_device_samples',
  'studio_devices',
  'studio_evolution_runs',
  'studio_evolution_worker_status',
  'studio_experience_summaries',
  'studio_external_probe_status',
  'studio_north_star_snapshots',
  'studio_obs_dashboard_panels',
  'studio_obs_dashboards',
  'studio_obs_ingest_tokens',
  'studio_obs_tenant_members',
  'studio_obs_tenants',
  'studio_observability_actions',
  'studio_observability_logs',
  'studio_observability_metric_samples',
  'studio_observability_metric_series',
  'studio_model_prices',
  'studio_ops_events',
  'studio_ops_events_tenant',
  'studio_public_observability_feedback',
  'studio_public_observability_scores',
  'studio_remediation_runs',
  'studio_sli_samples',
  'studio_telemetry_audit',
  'studio_telemetry_deletion_ledger',
  'studio_telemetry_payload_grants',
  'studio_telemetry_payloads',
  'studio_telemetry_tombstones',
  'studio_trace_backend_mappings',
  'studio_trace_ingestion_receipts',
  'studio_trace_span_conflicts',
  'studio_trace_spans',
];

/**
 * 数据库面板表白名单（`RDK_DB_PANEL_TABLES`）。
 *
 * 未配置 = 内置默认白名单（`DEFAULT_POSTGRES_DASHBOARD_TABLES`，与
 * ops/db-panel-allowlist.txt 同步）：只允许可观测相关表被列出/查看/导出，收敛
 * 「admin token ≈ 共用中心库整库只读」这个面。显式设 `*` 恢复整库可见（历史行为）；
 * 设具体名单则完全按名单放行，例如 `RDK_DB_PANEL_TABLES=studio_alert_incidents,studio_ops_events`。
 *
 * 条目写法：`table`（默认 public schema）或 `schema.table`，逗号/空白分隔。
 * 判定大小写不敏感（Postgres 未加引号的标识符会折叠为小写）。
 */
export function postgresDashboardTableAllowlist(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const raw = String(env.RDK_DB_PANEL_TABLES ?? '').trim();
  if (!raw) {
    return new Set(
      DEFAULT_POSTGRES_DASHBOARD_TABLES.map((value) => `public.${value}`.toLowerCase()),
    );
  }
  if (raw === '*') return new Set();
  const entries = raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.includes('.') ? value : `public.${value}`).toLowerCase());
  return new Set(entries);
}

/** 白名单生效时只放行名单内的 `schema.table`（`*` 或空默认集 = 全部放行）。 */
export function isPostgresDashboardTableAllowed(
  schemaName: unknown,
  tableName: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const allowlist = postgresDashboardTableAllowlist(env);
  if (tableAllowlistEmpty(allowlist)) return true;
  return allowlist.has(`${String(schemaName ?? '').trim()}.${String(tableName ?? '').trim()}`.toLowerCase());
}

function tableAllowlistEmpty(allowlist: Set<string>): boolean {
  return allowlist.size === 0;
}

function assertTableAllowed(schemaName: string, tableName: string): void {
  if (isPostgresDashboardTableAllowed(schemaName, tableName)) return;
  // 用 404 而不是 403：白名单是「这张表不在面板里」，不需要向调用方确认它是否存在。
  throw new PostgresTableDetailError('postgres_table_not_found', 404);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

type PostgresDashboardQueryTarget = Pick<PostgresDashboardPool, 'query'>;

async function withReadOnlyStatementTimeout<T>(
  pool: PostgresDashboardPool,
  timeoutMs: number,
  work: (target: PostgresDashboardQueryTarget) => Promise<T>,
): Promise<T> {
  // Lightweight fakes used by focused tests do not expose a client. Production
  // pools do, so every real dashboard query runs inside a bounded read-only tx.
  if (!pool.connect) return work(pool);
  const client = await pool.connect();
  let transactionOpen = false;
  const target: PostgresDashboardQueryTarget = {
    query: (text, params) => client.query(text, params),
  };
  try {
    await client.query('begin isolation level repeatable read read only');
    transactionOpen = true;
    await client.query(`set local statement_timeout = '${Math.max(1, Math.floor(timeoutMs))}ms'`);
    await client.query("set local lock_timeout = '1000ms'");
    const result = await work(target);
    await client.query('commit');
    transactionOpen = false;
    return result;
  } finally {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

function relationshipNodeId(schemaName: string, tableName: string): string {
  return `table:${schemaName}.${tableName}`;
}

function relationshipDomain(tableName: string): string {
  if (tableName.startsWith('credit_') || tableName.startsWith('chat_credit_')) return '积分与账户';
  if (tableName.startsWith('studio_alert_') || tableName.startsWith('studio_ops_')) return '可观测与告警';
  if (tableName.startsWith('studio_experience_')) return '体验信号';
  if (tableName.startsWith('studio_skill_') || tableName.startsWith('skill_')) return 'Skill 治理';
  if (tableName.startsWith('campaign')) return '增长活动';
  if (tableName === 'conversation_turns' || tableName.startsWith('agent_run_')) return '对话与 Agent';
  return '产品数据';
}

function buildPostgresRelationshipGraph(
  databaseName: unknown,
  tableRows: Array<Record<string, unknown>>,
  relationshipRows: Array<Record<string, unknown>>,
): PostgresRelationshipGraph {
  const normalizedDatabaseName = String(databaseName ?? '').trim().slice(0, 128) || '当前数据库';
  const tableKeys = new Set(
    tableRows.map((row) => `${String(row.schemaname ?? 'public')}.${String(row.relname ?? '')}`),
  );
  const fkRows = relationshipRows.filter((row) => {
    const source = `${String(row.source_schema ?? '')}.${String(row.source_table ?? '')}`;
    const target = `${String(row.target_schema ?? '')}.${String(row.target_table ?? '')}`;
    return tableKeys.has(source) && tableKeys.has(target);
  });
  const includedKeys = new Set(tableKeys);
  const truncated = tableRows.length > 80;
  if (truncated) {
    const importantKeys = new Set<string>();
    for (const row of relationshipRows) {
      importantKeys.add(`${String(row.source_schema ?? '')}.${String(row.source_table ?? '')}`);
      importantKeys.add(`${String(row.target_schema ?? '')}.${String(row.target_table ?? '')}`);
    }
    for (const row of tableRows.slice(0, 80)) {
      importantKeys.add(`${String(row.schemaname ?? 'public')}.${String(row.relname ?? '')}`);
    }
    includedKeys.clear();
    for (const key of importantKeys) {
      if (includedKeys.size >= 80) break;
      if (tableKeys.has(key)) includedKeys.add(key);
    }
  }

  const tableSchemas = new Set(
    tableRows
      .map((row) => String(row.schemaname ?? '').trim())
      .filter((schemaName) => schemaName && !schemaName.startsWith('pg_')),
  );
  tableSchemas.add('public');
  const schemaNames = [...tableSchemas].sort((left, right) => left.localeCompare(right));
  const nodes: PostgresRelationshipGraph['nodes'] = [
    {
      id: 'database:current',
      kind: 'database',
      label: normalizedDatabaseName,
      description: '中心 PostgreSQL；按 schema、业务表与外键关系展示。',
    },
    ...schemaNames.map((schemaName) => ({
      id: `schema:${schemaName}`,
      kind: 'schema' as const,
      label: schemaName === 'public' ? 'public / 业务数据' : `${schemaName} / 业务数据`,
      schemaName,
      description: schemaName === 'public' ? '中心库的业务表与可观测数据。' : '中心库中的业务 schema。',
    })),
    {
      id: 'schema:ops_ai',
      kind: 'schema',
      label: 'ops_ai / 脱敏查询层',
      schemaName: 'ops_ai',
      description: '只读、脱敏视图层（历史能力，SQL 入口已下线）。',
    },
  ];
  const edges: PostgresRelationshipGraph['edges'] = [
    ...schemaNames.map((schemaName) => ({
      source: 'database:current',
      target: `schema:${schemaName}`,
      kind: 'contains' as const,
      label: '业务表',
    })),
    {
      source: 'database:current',
      target: 'schema:ops_ai',
      kind: 'contains',
      label: `${POSTGRES_AI_VIEWS.length} 个脱敏视图`,
    },
  ];
  for (const row of tableRows) {
    const schemaName = String(row.schemaname ?? 'public');
    const tableName = String(row.relname ?? '');
    const key = `${schemaName}.${tableName}`;
    if (!tableName || !includedKeys.has(key)) continue;
    const nodeId = relationshipNodeId(schemaName, tableName);
    nodes.push({
      id: nodeId,
      kind: 'table',
      label: tableName,
      schemaName,
      estimatedRows: finiteNumber(row.n_live_tup),
      description: relationshipDomain(tableName),
    });
    edges.push({
      source: `schema:${schemaName}`,
      target: nodeId,
      kind: 'contains',
      label: relationshipDomain(tableName),
    });
  }
  for (const row of fkRows) {
    const sourceSchema = String(row.source_schema ?? '');
    const sourceTable = String(row.source_table ?? '');
    const targetSchema = String(row.target_schema ?? '');
    const targetTable = String(row.target_table ?? '');
    const sourceId = relationshipNodeId(sourceSchema, sourceTable);
    const targetId = relationshipNodeId(targetSchema, targetTable);
    if (!nodes.some((node) => node.id === sourceId) || !nodes.some((node) => node.id === targetId)) continue;
    const sourceColumns = String(row.source_columns ?? '').slice(0, 240);
    const targetColumns = String(row.target_columns ?? '').slice(0, 240);
    edges.push({
      source: sourceId,
      target: targetId,
      kind: 'foreign_key',
      label: `${sourceColumns || '外键'} → ${targetColumns || '主键'}`,
    });
  }
  for (const view of POSTGRES_AI_VIEWS) {
    if (tableKeys.has(`public.${view.sourceTable}`) && includedKeys.has(`public.${view.sourceTable}`)) {
      edges.push({
        source: relationshipNodeId('public', view.sourceTable),
        target: 'schema:ops_ai',
        kind: 'masked_view',
        label: `${view.name} 脱敏投影`,
      });
    }
  }
  return {
    schema: 'rdk.studio.postgres_relationship_graph.v1',
    databaseName: normalizedDatabaseName,
    summary: {
      tableCount: tableRows.length,
      foreignKeyCount: fkRows.length,
      maskedViewCount: POSTGRES_AI_VIEWS.length,
      truncated,
    },
    nodes,
    edges,
  };
}

const HARD_SECRET_PREVIEW_COLUMNS =
  /(?:^|_)(?:password|passwd|secret|token|credential|authori[sz]ation|cookie|salt|cipher|ciphertext|encrypted)(?:_|$)|(?:^|_)(?:api|gateway|private|signing|encryption|user)_key(?:_|$)|(?:^|_)(?:password|code|secret)_hash(?:_|$)/i;

function isPreviewableColumn(name: string, dataType: string): boolean {
  const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const type = dataType.toLowerCase();
  if (/\bbytea\b/.test(type)) return false;
  if (
    /\b(?:smallint|integer|bigint|numeric|decimal|real|double precision|boolean|date|timestamp|time|interval)\b/.test(
      type,
    )
  ) {
    return true;
  }
  return !HARD_SECRET_PREVIEW_COLUMNS.test(normalizedName);
}

function isSortableColumn(dataType: string): boolean {
  const type = dataType.toLowerCase();
  return /\b(?:smallint|integer|bigint|numeric|decimal|real|double precision|money|boolean|date|timestamp|time|interval|uuid|text|character varying|character|varchar|char|citext|name|inet|cidr|macaddr|jsonb)\b/.test(
    type,
  );
}

type PostgresTableColumn = PostgresTableDetail['columns'][number];

function mapPostgresTableColumns(
  rows: Array<Record<string, unknown>>,
  schemaName: string,
  tableName: string,
): PostgresTableColumn[] {
  return rows.map((row) => {
    const name = String(row.column_name ?? '').slice(0, 128);
    const dataType = String(row.data_type ?? '').slice(0, 200);
    const previewable =
      !isPostgresTableSecretColumn(schemaName, tableName, name) &&
      isPreviewableColumn(name, dataType);
    return {
      name,
      dataType,
      nullable: Boolean(row.nullable),
      defaultValue:
        row.default_value == null
          ? null
          : previewable
            ? String(row.default_value).slice(0, 2_000)
            : '[凭据已隐藏]',
      description:
        row.column_comment == null ? null : String(row.column_comment).trim().slice(0, 500) || null,
      primaryKey: Boolean(row.primary_key),
      previewable,
      sortable: previewable && isSortableColumn(dataType),
    };
  });
}

function normalizeSortDirection(value: unknown): PostgresTableSortDirection {
  const direction = String(value ?? 'asc').trim().toLowerCase();
  if (direction !== 'asc' && direction !== 'desc') {
    throw new PostgresTableDetailError('postgres_table_sort_invalid', 400);
  }
  return direction;
}

function resolveTableSort(
  columns: PostgresTableColumn[],
  requestedColumn: unknown,
  requestedDirection: unknown,
): { column: string | null; direction: PostgresTableSortDirection } {
  const sortableColumns = columns.filter((column) => column.sortable);
  const requested = String(requestedColumn ?? '').trim();
  const column = requested
    ? sortableColumns.find((candidate) => candidate.name === requested)?.name
    : (sortableColumns.find((candidate) => candidate.primaryKey)?.name ??
      sortableColumns[0]?.name ??
      null);
  const resolvedColumn = column ?? null;
  if (requested && !resolvedColumn) {
    throw new PostgresTableDetailError('postgres_table_sort_invalid', 400);
  }
  return { column: resolvedColumn, direction: normalizeSortDirection(requestedDirection) };
}

function tableOrderClause(
  columns: PostgresTableColumn[],
  sort: { column: string | null; direction: PostgresTableSortDirection },
): string {
  if (!sort.column) return 'order by tableoid asc, ctid asc';
  const primaryKeys = columns
    .filter((column) => column.primaryKey && column.previewable && column.name !== sort.column)
    .map((column) => `${quoteIdentifier(column.name)} asc`);
  const stableTail = primaryKeys.length ? primaryKeys : ['tableoid asc', 'ctid asc'];
  return `order by ${quoteIdentifier(sort.column)} ${sort.direction} nulls last, ${stableTail.join(', ')}`;
}

function previewValue(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  let text: string;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function exportValue(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function serializePostgresTableCsvLine(values: unknown[]): string {
  return values
    .map((value) => {
      let text = value == null ? '' : String(value);
      if (typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    })
    .join(',');
}

function clampTablePage(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.min(MAX_TABLE_PREVIEW_PAGE, Math.max(1, Math.floor(value as number)))
    : 1;
}

function clampTablePageSize(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(50, Math.max(1, Math.floor(value as number))) : 25;
}

async function availableDataSources(p: PostgresDashboardPool) {
  const result = await p.query(
    `select table_name, column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = any($1::text[])`,
    [DATA_SOURCES.map((source) => source.table)],
  );
  const columns = new Set(
    result.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`),
  );
  return DATA_SOURCES.filter((source) => columns.has(`${source.table}.${source.timestamp}`));
}

function dataSourceSummarySql(sources: readonly (typeof DATA_SOURCES)[number][]): string {
  return sources
    .map(
      (source) => `select '${source.key}' source_key,
         coalesce((select n_live_tup from pg_stat_user_tables where schemaname = 'public' and relname = '${source.table}'), 0)::bigint estimated_rows,
         pg_total_relation_size('public.${source.table}'::regclass)::bigint total_bytes,
         (select count(*)::bigint from public.${source.table} where ${source.timestamp} >= now() - make_interval(hours => $1)) window_rows,
         (select max(${source.timestamp}) from public.${source.table}) latest_at`,
    )
    .join('\nunion all\n');
}

function dataSourceTrendSql(
  sources: readonly (typeof DATA_SOURCES)[number][],
  bucket: 'hour' | 'day',
): string {
  return sources
    .map(
      (source) => `select '${source.key}' source_key,
         date_trunc('${bucket}', ${source.timestamp}) bucket,
         count(*)::bigint event_count
       from public.${source.table}
       where ${source.timestamp} >= now() - make_interval(hours => $1)
       group by 2`,
    )
    .join('\nunion all\n');
}

export async function collectPostgresDashboard(
  p: PostgresDashboardPool,
  options: { hours?: number; now?: Date } = {},
): Promise<PostgresDatabaseDashboard> {
  const hours = clampHours(options.hours ?? 24);
  const bucket: 'hour' | 'day' = hours <= 48 ? 'hour' : 'day';
  const [databaseResult, sessionResult, tableResult, sources, relationshipResult] =
    await withReadOnlyStatementTimeout(p, DASHBOARD_QUERY_TIMEOUT_MS, async (target) =>
      Promise.all([
        target.query(DATABASE_SUMMARY_SQL),
        target.query(SESSION_SUMMARY_SQL),
        target.query(TABLE_STATS_SQL),
        availableDataSources(target),
        p.connect ? target.query(RELATIONSHIP_GRAPH_SQL) : Promise.resolve({ rows: [] }),
      ]),
    );
  const database = databaseResult.rows[0] ?? {};
  const sessions = sessionResult.rows[0] ?? {};
  let sourceSummaryResult: PostgresQueryResult = { rows: [] };
  let trendResult: PostgresQueryResult = { rows: [] };
  if (sources.length) {
    try {
      [sourceSummaryResult, trendResult] = await withReadOnlyStatementTimeout(
        p,
        DASHBOARD_QUERY_TIMEOUT_MS,
        (target) =>
          Promise.all([
            target.query(dataSourceSummarySql(sources), [hours]),
            target.query(dataSourceTrendSql(sources, bucket), [hours]),
          ]),
      );
    } catch {
      // A table can disappear between catalog discovery and the aggregate query.
      // Keep health/table maintenance visible and degrade only the ingestion cards.
      sourceSummaryResult = { rows: [] };
      trendResult = { rows: [] };
    }
  }

  const commits = finiteNumber(database.xact_commit);
  const rollbacks = finiteNumber(database.xact_rollback);
  const blocksRead = finiteNumber(database.blks_read);
  const blocksHit = finiteNumber(database.blks_hit);
  const usedConnections = finiteNumber(database.numbackends);
  const maxConnections = finiteNumber(database.max_connections);
  const active = finiteNumber(sessions.active);
  const idleInTransaction = finiteNumber(sessions.idle_in_transaction);
  const waiting = finiteNumber(sessions.waiting);
  const longRunning = finiteNumber(sessions.long_running);
  const connectionRatio = ratio(usedConnections, maxConnections);
  const cacheHitRatio = ratio(blocksHit, blocksHit + blocksRead);
  const status = healthStatus({
    connectionRatio,
    cacheHitRatio,
    idleInTransaction,
    waiting,
    longRunning,
  });

  const sourceRows = new Map(
    sourceSummaryResult.rows.map((row) => [String(row.source_key), row] as const),
  );
  const dashboardSources = sources.map((source) => {
    const row = sourceRows.get(source.key) ?? {};
    return {
      key: source.key,
      label: source.label,
      color: source.color,
      estimatedRows: finiteNumber(row.estimated_rows),
      windowRows: finiteNumber(row.window_rows),
      latestAt: nullableIso(row.latest_at),
      totalBytes: finiteNumber(row.total_bytes),
    };
  });

  const trendMap = new Map<string, Record<string, number>>();
  for (const row of trendResult.rows) {
    const bucketValue = nullableIso(row.bucket);
    const sourceKey = String(row.source_key ?? '');
    if (!bucketValue || !sourceKey) continue;
    const values = trendMap.get(bucketValue) ?? {};
    values[sourceKey] = finiteNumber(row.event_count);
    trendMap.set(bucketValue, values);
  }

  // 白名单过滤一次，供目录列表与关系图共用：关系图的节点/外键边都从这批行派生，
  // 只过滤 tables 会让非白名单表以节点名重新出现在图里。
  const allowedTableRows = tableResult.rows.filter((row) =>
    isPostgresDashboardTableAllowed(
      String(row.schemaname ?? 'public'),
      String(row.relname ?? ''),
    ),
  );
  const tables = allowedTableRows.map((row) => {
    const liveRows = finiteNumber(row.n_live_tup);
    const deadRows = finiteNumber(row.n_dead_tup);
    const sequentialScans = finiteNumber(row.seq_scan);
    const indexScans = finiteNumber(row.idx_scan);
    return {
      schemaName: String(row.schemaname ?? 'public').slice(0, 128),
      name: String(row.relname ?? '').slice(0, 128),
      estimatedRows: liveRows,
      deadRows,
      deadRowRatio: ratio(deadRows, liveRows + deadRows),
      totalBytes: finiteNumber(row.total_bytes),
      tableBytes: finiteNumber(row.table_bytes),
      indexBytes: finiteNumber(row.index_bytes),
      indexScanRatio: ratio(indexScans, indexScans + sequentialScans),
      lastAutovacuumAt: nullableIso(row.last_autovacuum),
      lastAutoanalyzeAt: nullableIso(row.last_autoanalyze),
      description: postgresTableDescription(String(row.relname ?? ''), row.table_comment),
      aiQueryable:
        String(row.schemaname ?? 'public') === 'public' &&
        isPostgresAiQueryableTable(String(row.relname ?? '')),
    };
  });
  const now = options.now ?? new Date();
  return {
    schema: 'rdk.studio.postgres_dashboard.v1',
    generatedAt: nullableIso(database.sampled_at) ?? now.toISOString(),
    windowHours: hours,
    bucket,
    health: {
      status: status.status,
      reasons: status.reasons,
      version: String(database.version ?? '').slice(0, 48),
      databaseSizeBytes: finiteNumber(database.database_size_bytes),
      uptimeSeconds: finiteNumber(database.uptime_seconds),
      sharedBuffers: String(database.shared_buffers ?? '').slice(0, 48),
      connections: {
        used: usedConnections,
        max: maxConnections,
        ratio: connectionRatio,
        active,
        idleInTransaction,
        waiting,
        longRunning,
      },
      cacheHitRatio,
      transactionRollbackRatio: ratio(rollbacks, commits + rollbacks),
      commits,
      rollbacks,
      deadlocks: finiteNumber(database.deadlocks),
      tempBytes: finiteNumber(database.temp_bytes),
      statsResetAt: nullableIso(database.stats_reset),
    },
    sources: dashboardSources,
    trend: [...trendMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([trendBucket, values]) => ({ bucket: trendBucket, values })),
    relationshipGraph: buildPostgresRelationshipGraph(
      database.database_name,
      allowedTableRows,
      relationshipResult.rows,
    ),
    tables,
  };
}

export async function getPostgresDashboard(hours = 24): Promise<PostgresDatabaseDashboard> {
  return collectPostgresDashboard(await getPostgresDashboardPool(), { hours });
}

export async function collectPostgresTableDetail(
  p: PostgresDashboardPool,
  options: {
    schemaName: string;
    tableName: string;
    page?: number;
    pageSize?: number;
    sortColumn?: string;
    sortDirection?: PostgresTableSortDirection;
    now?: Date;
  },
): Promise<PostgresTableDetail> {
  const schemaName = normalizedCatalogName(options.schemaName);
  const tableName = normalizedCatalogName(options.tableName);
  assertTableAllowed(schemaName, tableName);
  const page = clampTablePage(options.page);
  const pageSize = clampTablePageSize(options.pageSize);
  return withReadOnlyStatementTimeout(p, TABLE_DETAIL_QUERY_TIMEOUT_MS, async (target) => {
    const relationResult = await target.query(TABLE_DETAIL_RELATION_SQL, [schemaName, tableName]);
    const relation = relationResult.rows[0];
    if (!relation) throw new PostgresTableDetailError('postgres_table_not_found', 404);

    const [columnResult, indexResult] = await Promise.all([
      target.query(TABLE_DETAIL_COLUMNS_SQL, [schemaName, tableName]),
      target.query(TABLE_DETAIL_INDEXES_SQL, [schemaName, tableName]),
    ]);
    const columns = mapPostgresTableColumns(columnResult.rows, schemaName, tableName);
    const previewableColumns = columns.filter((column) => column.previewable);
    const sort = resolveTableSort(columns, options.sortColumn, options.sortDirection);
    const offset = (page - 1) * pageSize;
    const previewResult = previewableColumns.length
      ? await target.query(
          `select ${previewableColumns.map((column) => quoteIdentifier(column.name)).join(', ')}
           from ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}
           ${tableOrderClause(columns, sort)}
           limit $1 offset $2`,
          [pageSize + 1, offset],
        )
      : { rows: [] };
    const hasMore = previewResult.rows.length > pageSize;
    const previewRows = previewResult.rows
      .slice(0, pageSize)
      .map((row) =>
        Object.fromEntries(
          columns.map((column) => [
            column.name,
            column.previewable ? previewValue(row[column.name]) : '[凭据已隐藏]',
          ]),
        ),
      );

    return {
      schema: 'rdk.studio.postgres_table_detail.v1',
      generatedAt: (options.now ?? new Date()).toISOString(),
      relation: {
        schemaName,
        name: tableName,
        kind: relation.relation_kind === 'p' ? 'partitioned_table' : 'table',
        description: postgresTableDescription(tableName, relation.table_comment),
        estimatedRows: finiteNumber(relation.estimated_rows),
        totalBytes: finiteNumber(relation.total_bytes),
      },
      columns,
      indexes: indexResult.rows.map((row) => ({
        name: String(row.index_name ?? '').slice(0, 128),
        definition: String(row.index_definition ?? '').slice(0, 2_000),
      })),
      preview: {
        page,
        pageSize,
        hasMore,
        rows: previewRows,
        hiddenColumnCount: columns.length - previewableColumns.length,
        sortColumn: sort.column,
        sortDirection: sort.direction,
      },
    };
  });
}

export async function getPostgresTableDetail(options: {
  schemaName: string;
  tableName: string;
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDirection?: PostgresTableSortDirection;
}): Promise<PostgresTableDetail> {
  return collectPostgresTableDetail(await getPostgresDashboardPool(), options);
}

function postgresTableExportFilename(schemaName: string, tableName: string, generatedAt: Date): string {
  const safeRelation = `${schemaName}-${tableName}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `rdkstudio-pg-${safeRelation || 'table'}-${stamp}.csv`;
}

export async function collectPostgresTableCsvExport(
  pool: PostgresDashboardPool,
  options: {
    schemaName: string;
    tableName: string;
    sortColumn?: string;
    sortDirection?: PostgresTableSortDirection;
    now?: Date;
  },
): Promise<PostgresTableCsvExport> {
  const schemaName = normalizedCatalogName(options.schemaName);
  const tableName = normalizedCatalogName(options.tableName);
  assertTableAllowed(schemaName, tableName);
  const [relationResult, columnResult] = await Promise.all([
    pool.query(TABLE_DETAIL_RELATION_SQL, [schemaName, tableName]),
    pool.query(TABLE_DETAIL_COLUMNS_SQL, [schemaName, tableName]),
  ]);
  if (!relationResult.rows[0]) {
    throw new PostgresTableDetailError('postgres_table_not_found', 404);
  }
  const columns = mapPostgresTableColumns(columnResult.rows, schemaName, tableName);
  const sort = resolveTableSort(columns, options.sortColumn, options.sortDirection);
  if (!pool.connect) throw new Error('postgres_table_export_cursor_unavailable');
  const generatedAt = options.now ?? new Date();

  async function* rows(): AsyncGenerator<Record<string, unknown>> {
    if (!columns.length) return;
    const client = await pool.connect!();
    let transactionOpen = false;
    try {
      await client.query('begin isolation level repeatable read read only');
      transactionOpen = true;
      await client.query("set local statement_timeout = '15min'");
      const selectColumns = columns
        .map((column) =>
          column.previewable
            ? quoteIdentifier(column.name)
            : `null::text as ${quoteIdentifier(column.name)}`,
        )
        .join(', ');
      await client.query(
        `declare rdk_ops_table_export no scroll cursor for
         select ${selectColumns}
         from ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}
         ${tableOrderClause(columns, sort)}`,
      );
      for (;;) {
        const batch = await client.query('fetch forward 500 from rdk_ops_table_export');
        for (const row of batch.rows) {
          yield Object.fromEntries(
            columns.map((column) => [
              column.name,
              column.previewable ? exportValue(row[column.name]) : '[凭据已隐藏]',
            ]),
          );
        }
        if (batch.rows.length < 500) break;
      }
      await client.query('close rdk_ops_table_export');
      await client.query('commit');
      transactionOpen = false;
    } finally {
      if (transactionOpen) await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  return {
    filename: postgresTableExportFilename(schemaName, tableName, generatedAt),
    columns: columns.map((column) => column.name),
    sortColumn: sort.column,
    sortDirection: sort.direction,
    rows: rows(),
  };
}

export async function createPostgresTableCsvExport(options: {
  schemaName: string;
  tableName: string;
  sortColumn?: string;
  sortDirection?: PostgresTableSortDirection;
  now?: Date;
}): Promise<PostgresTableCsvExport> {
  return collectPostgresTableCsvExport(await getPostgresDashboardPool(), options);
}
