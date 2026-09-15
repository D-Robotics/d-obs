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
    'proposed_by',
    'approved_by',
    'approval_expires_at',
    'created_at',
    'updated_at',
    'execution',
    'regression_marker',
    'revision',
];
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
    'proposed_by',
    'created_at',
    'updated_at',
    'revision',
];
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
];
const REQUIRED_INDEXES = [
    'studio_observability_actions_scope_created_idx',
    'studio_observability_actions_scope_status_idx',
    'studio_observability_actions_scope_run_idx',
];
const values = (items) => items.map((item) => `('${item.replaceAll("'", "''")}')`).join(', ');
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
function sqlTrue(value) {
    return value === true || value === 1 || value === 't' || value === 'true';
}
function readinessError() {
    return new Error('action_schema_unavailable');
}
function isReady(row) {
    return Boolean(row &&
        sqlTrue(row.relation_exists) &&
        sqlTrue(row.rls_enabled) &&
        sqlTrue(row.columns_ready) &&
        sqlTrue(row.nullability_ready) &&
        sqlTrue(row.constraints_ready) &&
        sqlTrue(row.indexes_ready) &&
        sqlTrue(row.privileges_ready));
}
let readinessByPool = new WeakMap();
export async function ensureObservabilityActionSchema(p) {
    if (!p || typeof p.query !== 'function')
        throw readinessError();
    const key = p;
    const previous = readinessByPool.get(key);
    if (previous)
        return previous;
    const check = (async () => {
        let result;
        try {
            result = (await p.query(OBSERVABILITY_ACTION_SCHEMA_READINESS_SQL));
        }
        catch {
            throw readinessError();
        }
        if (!isReady(result.rows[0]))
            throw readinessError();
    })().catch((error) => {
        readinessByPool.delete(key);
        throw error instanceof Error && error.message === 'action_schema_unavailable'
            ? error
            : readinessError();
    });
    readinessByPool.set(key, check);
    return check;
}
/** Test-only cache reset; production never mutates schema readiness state. */
export function resetObservabilityActionSchemaReadinessForTest() {
    readinessByPool = new WeakMap();
}
