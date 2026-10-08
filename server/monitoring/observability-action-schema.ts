/**
 * Read-only readiness check for the evidence-first observability action store.
 *
 * The action table is provisioned by a checked-in Supabase/Postgres migration.
 * Request handling must never acquire DDL privileges or race another request
 * while running CREATE/ALTER statements, so this module only inspects the
 * catalog and the current connection's table privileges.  A missing or
 * partially-applied migration fails closed with one stable error code.
 */
import type { ActionStorePool } from './observability-action-loop.js';

export const OBSERVABILITY_ACTION_SCHEMA_TABLE = 'public.studio_observability_actions';

const REQUIRED_COLUMNS = [
  'id',
  'account_scope_id',
  'environment',
  'run_id',
  'type',
  'title',
  'rationale',
  'playbook_id',
  'evidence_refs',
  'requires_approval',
  'status',
  'origin',
  'proposed_by',
  'approved_by',
  'approval_expires_at',
  'created_at',
  'updated_at',
  'execution',
  'regression_marker',
  'revision',
] as const;

const REQUIRED_NOT_NULL_COLUMNS = [
  'id',
  'account_scope_id',
  'environment',
  'type',
  'title',
  'rationale',
  'evidence_refs',
  'requires_approval',
  'status',
  'origin',
  'proposed_by',
  'created_at',
  'updated_at',
  'revision',
] as const;

const REQUIRED_CONSTRAINTS = [
  'studio_observability_actions_pkey',
  'studio_observability_actions_id_check',
  'studio_observability_actions_account_scope_check',
  'studio_observability_actions_environment_check',
  'studio_observability_actions_type_check',
  'studio_observability_actions_status_check',
  'studio_observability_actions_playbook_check',
  'studio_observability_actions_evolution_disabled_check',
  'studio_observability_actions_evidence_refs_check',
  'studio_observability_actions_revision_check',
  'studio_observability_actions_approval_expiry_check',
  'studio_observability_actions_approval_separation_check',
  'studio_observability_actions_text_length_check',
  'studio_observability_actions_execution_object_check',
] as const;

const REQUIRED_INDEXES = [
  'studio_observability_actions_scope_created_idx',
  'studio_observability_actions_scope_status_idx',
  'studio_observability_actions_scope_run_idx',
] as const;

const values = (items: readonly string[]): string =>
  items.map((item) => `('${item.replaceAll("'", "''")}')`).join(', ');

/** The SQL is intentionally a SELECT-only catalog probe. */
export const OBSERVABILITY_ACTION_SCHEMA_READINESS_SQL = `
with target as (
  select c.oid, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'studio_observability_actions'
),
required_columns(column_name) as (values ${values(REQUIRED_COLUMNS)}),
required_not_null(column_name) as (values ${values(REQUIRED_NOT_NULL_COLUMNS)}),
required_constraints(constraint_name) as (values ${values(REQUIRED_CONSTRAINTS)}),
required_indexes(index_name) as (values ${values(REQUIRED_INDEXES)})
select
  exists(select 1 from target) as relation_exists,
  coalesce((select relrowsecurity from target), false) as rls_enabled,
  not exists (
    select 1 from required_columns required
    where not exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'studio_observability_actions'
        and column_info.column_name = required.column_name
    )
  ) as columns_ready,
  not exists (
    select 1 from required_not_null required
    where not exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'studio_observability_actions'
        and column_info.column_name = required.column_name
        and column_info.is_nullable = 'NO'
    )
  ) as nullability_ready,
  not exists (
    select 1 from required_constraints required
    where not exists (
      select 1 from pg_constraint constraint_info
      where constraint_info.conrelid = (select oid from target)
        and constraint_info.conname = required.constraint_name
    )
  ) as constraints_ready,
  not exists (
    select 1 from required_indexes required
    where not exists (
      select 1 from pg_indexes index_info
      where index_info.schemaname = 'public'
        and index_info.tablename = 'studio_observability_actions'
        and index_info.indexname = required.index_name
    )
  ) as indexes_ready,
  has_table_privilege(current_user, '${OBSERVABILITY_ACTION_SCHEMA_TABLE}', 'select')
    and has_table_privilege(current_user, '${OBSERVABILITY_ACTION_SCHEMA_TABLE}', 'insert')
    and has_table_privilege(current_user, '${OBSERVABILITY_ACTION_SCHEMA_TABLE}', 'update')
    as privileges_ready
`;

type PgResult = { rows: Array<Record<string, unknown>> };

function sqlTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 't' || value === 'true';
}

/**
 * 供 worker warn / web console.warn 消费的失败细节。历史上该模块把探测查询
 * 失败与目录检查不过统一吞成裸 `action_schema_unavailable`，生产连续两天
 * 无法回答"为什么 503"，因此这里必须保留类别或底层错误文本。
 */
function probeFailureDetail(reasons: readonly string[]): string {
  const detail = reasons
    .filter(Boolean)
    .join('; ')
    .replace(/[^\w .,:()=|/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return detail || 'unknown';
}

function readinessError(detail?: string): Error {
  return new Error(
    detail ? `action_schema_unavailable: ${detail}` : 'action_schema_unavailable',
  );
}

type ReadinessRow = Record<string, unknown> & {
  relation_exists?: unknown;
  rls_enabled?: unknown;
  columns_ready?: unknown;
  nullability_ready?: unknown;
  constraints_ready?: unknown;
  indexes_ready?: unknown;
  privileges_ready?: unknown;
};

function readinessReasons(row: ReadinessRow | undefined): string[] {
  if (!row) return ['probe returned no row'];
  const checks: Array<[string, unknown]> = [
    ['relation missing', row.relation_exists],
    ['rls disabled', row.rls_enabled],
    ['columns incomplete', row.columns_ready],
    ['nullability incomplete', row.nullability_ready],
    ['constraints incomplete', row.constraints_ready],
    ['indexes incomplete', row.indexes_ready],
    ['privileges insufficient', row.privileges_ready],
  ];
  return checks
    .filter(([, value]) => !sqlTrue(value))
    .map(([name]) => name);
}

let readinessByPool = new WeakMap<object, Promise<void>>();

export async function ensureObservabilityActionSchema(p: ActionStorePool): Promise<void> {
  if (!p || typeof p.query !== 'function') throw readinessError();
  const key = p as object;
  const previous = readinessByPool.get(key);
  if (previous) return previous;
  const check = (async () => {
    let result: PgResult;
    try {
      result = (await p.query(OBSERVABILITY_ACTION_SCHEMA_READINESS_SQL)) as PgResult;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      throw readinessError(`probe query failed: ${probeFailureDetail([raw])}`);
    }
    const reasons = readinessReasons(result.rows[0] as ReadinessRow | undefined);
    if (reasons.length > 0) throw readinessError(probeFailureDetail(reasons));
  })().catch((error) => {
    readinessByPool.delete(key);
    throw error instanceof Error && error.message.startsWith('action_schema_unavailable')
      ? error
      : readinessError(probeFailureDetail([error instanceof Error ? error.message : String(error)]));
  });
  readinessByPool.set(key, check);
  return check;
}

/** Test-only cache reset; production never mutates schema readiness state. */
export function resetObservabilityActionSchemaReadinessForTest(): void {
  readinessByPool = new WeakMap<object, Promise<void>>();
}
