/**
 * Read-only readiness probe for the durable remediation-run store.
 *
 * The table is owned by the checked-in Supabase migration.  Web requests and
 * the root-owned runner must not acquire DDL privileges or race schema changes;
 * an absent/partial migration therefore fails closed with one stable error.
 */

export const REMEDIATION_SCHEMA_TABLE = 'public.studio_remediation_runs';

const REQUIRED_COLUMNS = [
  'id',
  'environment',
  'started_at',
  'finished_at',
  'playbook_id',
  'trigger',
  'triggered_by',
  'status',
  'summary',
  'steps',
] as const;

const REQUIRED_NOT_NULL_COLUMNS = [
  'id',
  'environment',
  'started_at',
  'playbook_id',
  'trigger',
  'triggered_by',
  'status',
  'steps',
] as const;

const REQUIRED_CONSTRAINTS = [
  'studio_remediation_runs_pkey',
  'studio_remediation_runs_environment_check',
] as const;

const REQUIRED_INDEXES = ['studio_remediation_runs_environment_started_idx'] as const;

const values = (items: readonly string[]): string =>
  items.map((item) => `('${item.replaceAll("'", "''")}')`).join(', ');

/** The probe is intentionally SELECT-only; no request-time CREATE/ALTER path exists. */
export const REMEDIATION_SCHEMA_READINESS_SQL = `
with target as (
  select c.oid, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'studio_remediation_runs'
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
        and column_info.table_name = 'studio_remediation_runs'
        and column_info.column_name = required.column_name
    )
  ) as columns_ready,
  not exists (
    select 1 from required_not_null required
    where not exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'studio_remediation_runs'
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
        and index_info.tablename = 'studio_remediation_runs'
        and index_info.indexname = required.index_name
    )
  ) as indexes_ready,
  has_table_privilege(current_user, '${REMEDIATION_SCHEMA_TABLE}', 'select')
    and has_table_privilege(current_user, '${REMEDIATION_SCHEMA_TABLE}', 'insert')
    and has_table_privilege(current_user, '${REMEDIATION_SCHEMA_TABLE}', 'update')
    as privileges_ready
`;

type PgResult = { rows: Array<Record<string, unknown>> };
export type RemediationSchemaPool = {
  query: (text: string, params?: unknown[]) => Promise<PgResult>;
};

function sqlTrue(value: unknown): boolean {
  return value === true || value === 1 || value === 't' || value === 'true';
}

function readinessError(): Error {
  return new Error('remediation_schema_unavailable');
}

function isReady(row: Record<string, unknown> | undefined): boolean {
  return Boolean(
    row &&
      sqlTrue(row.relation_exists) &&
      sqlTrue(row.rls_enabled) &&
      sqlTrue(row.columns_ready) &&
      sqlTrue(row.nullability_ready) &&
      sqlTrue(row.constraints_ready) &&
      sqlTrue(row.indexes_ready) &&
      sqlTrue(row.privileges_ready),
  );
}

let readinessByPool = new WeakMap<object, Promise<void>>();

export async function ensureRemediationSchema(p: RemediationSchemaPool): Promise<void> {
  if (!p || typeof p.query !== 'function') throw readinessError();
  const key = p as object;
  const previous = readinessByPool.get(key);
  if (previous) return previous;
  const check = (async () => {
    let result: PgResult;
    try {
      result = await p.query(REMEDIATION_SCHEMA_READINESS_SQL);
    } catch {
      throw readinessError();
    }
    if (!isReady(result.rows[0])) throw readinessError();
  })().catch((error) => {
    readinessByPool.delete(key);
    throw error instanceof Error && error.message === 'remediation_schema_unavailable'
      ? error
      : readinessError();
  });
  readinessByPool.set(key, check);
  return check;
}

/** Test-only cache reset; production never mutates schema readiness state. */
export function resetRemediationSchemaReadinessForTest(): void {
  readinessByPool = new WeakMap<object, Promise<void>>();
}
