-- Unified observability 基础表（同源）：
-- 1) studio_trace_spans / studio_trace_ingestion_receipts /
--    studio_trace_span_conflicts：逐字拷贝自本仓
--    server/observability/studio-trace-schema.ts 的
--    UNIFIED_STUDIO_TRACE_SCHEMA_SQL（运行时写入路径同源）；
--    修改须双向同步，禁止单侧漂移。
-- 2) studio_trace_backend_mappings / agent_run_observability：拷贝自
--    rdstudio-web-master supabase/migrations/2026-08-26-unified-observability.sql
--    （backend_mappings 建表；agent_run_observability 为迁移后最终形态：
--    durable-run-observability-store.ts 基础列 + 迁移追加的 scope 列/PK）。
--    治理 scope discovery 与 cleanup_expired_studio_telemetry 需要这些表存在。

create table if not exists public.studio_trace_spans (
  trace_id text not null,
  span_id text not null,
  parent_span_id text null,
  run_id text null,
  owner_user_id text not null,
  source text not null check (source in ('client', 'server')),
  name text not null,
  start_time_ms bigint not null,
  end_time_ms bigint not null,
  status text not null check (status in ('ok', 'error')),
  status_message text null,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  account_scope_id text not null,
  environment text not null default 'production'
    constraint studio_trace_spans_environment_check
    check (environment in ('production', 'staging', 'development', 'test')),
  source_segment text not null
    constraint studio_trace_spans_source_segment_check
    check (source_segment in ('client', 'studio_transport', 'moss')),
  session_id text null,
  client_operation_id text null,
  span_kind text not null default 'internal'
    constraint studio_trace_spans_span_kind_check
    check (span_kind in ('internal', 'client', 'server')),
  outcome text not null default 'ok'
    constraint studio_trace_spans_outcome_check
    check (outcome in (
      'ok', 'error', 'cancelled', 'denied', 'blocked', 'incomplete', 'replayed', 'suppressed'
    )),
  otel_status text not null default 'ok'
    constraint studio_trace_spans_otel_status_check
    check (otel_status in ('unset', 'ok', 'error')),
  moc_version text not null default '0.0.0',
  producer_version text not null default '0.0.0',
  service_name text not null default 'rdk-studio',
  service_instance_id text not null default 'legacy',
  surface text not null default 'web-cloud',
  studio_version text not null default '0.0.0',
  moss_version text not null default '0.0.0',
  sampling_decision text not null default 'pending'
    constraint studio_trace_spans_sampling_decision_check
    check (sampling_decision in ('pending', 'retained', 'dropped')),
  sampling_policy_version text not null default 'legacy',
  sampling_reason text null,
  canonical_hash text null,
  batch_id text null,
  received_at timestamptz not null default now(),
  governance_expires_at timestamptz null,
  primary key (account_scope_id, environment, trace_id, span_id),
  check (end_time_ms >= start_time_ms)
);

alter table public.studio_trace_spans add column if not exists account_scope_id text;
alter table public.studio_trace_spans add column if not exists environment text not null default 'production';
alter table public.studio_trace_spans add column if not exists source_segment text;
alter table public.studio_trace_spans add column if not exists session_id text null;
alter table public.studio_trace_spans add column if not exists client_operation_id text null;
alter table public.studio_trace_spans add column if not exists span_kind text not null default 'internal';
alter table public.studio_trace_spans add column if not exists outcome text not null default 'ok';
alter table public.studio_trace_spans add column if not exists otel_status text not null default 'ok';
alter table public.studio_trace_spans add column if not exists moc_version text not null default '0.0.0';
alter table public.studio_trace_spans add column if not exists producer_version text not null default '0.0.0';
alter table public.studio_trace_spans add column if not exists service_name text not null default 'rdk-studio';
alter table public.studio_trace_spans add column if not exists service_instance_id text not null default 'legacy';
alter table public.studio_trace_spans add column if not exists surface text not null default 'web-cloud';
alter table public.studio_trace_spans add column if not exists studio_version text not null default '0.0.0';
alter table public.studio_trace_spans add column if not exists moss_version text not null default '0.0.0';
alter table public.studio_trace_spans add column if not exists sampling_decision text not null default 'pending';
alter table public.studio_trace_spans add column if not exists sampling_policy_version text not null default 'legacy';
alter table public.studio_trace_spans add column if not exists sampling_reason text null;
alter table public.studio_trace_spans add column if not exists canonical_hash text null;
alter table public.studio_trace_spans add column if not exists batch_id text null;
alter table public.studio_trace_spans add column if not exists received_at timestamptz not null default now();
alter table public.studio_trace_spans add column if not exists governance_expires_at timestamptz null;

update public.studio_trace_spans set account_scope_id = owner_user_id where account_scope_id is null;
update public.studio_trace_spans
set source_segment = case when source = 'client' then 'client' else 'moss' end
where source_segment is null;
update public.studio_trace_spans
set governance_expires_at = to_timestamp(start_time_ms / 1000.0) + interval '35 days'
where governance_expires_at is null;
alter table public.studio_trace_spans alter column run_id drop not null;
alter table public.studio_trace_spans alter column account_scope_id set not null;
alter table public.studio_trace_spans alter column source_segment set not null;

-- Fresh tables receive validated constraints above. On an older/self-hosted
-- table, add the same write-time guards as NOT VALID: PostgreSQL enforces them
-- for every new/updated row without making startup fail on unverifiable legacy
-- values. A later governed cleanup can validate those historical rows.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_environment_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_environment_check
      check (environment in ('production', 'staging', 'development', 'test')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_source_segment_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_source_segment_check
      check (source_segment in ('client', 'studio_transport', 'moss')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_span_kind_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_span_kind_check
      check (span_kind in ('internal', 'client', 'server')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_outcome_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_outcome_check
      check (outcome in (
        'ok', 'error', 'cancelled', 'denied', 'blocked', 'incomplete', 'replayed', 'suppressed'
      )) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_otel_status_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_otel_status_check
      check (otel_status in ('unset', 'ok', 'error')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.studio_trace_spans'::regclass
      and conname = 'studio_trace_spans_sampling_decision_check'
  ) then
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_sampling_decision_check
      check (sampling_decision in ('pending', 'retained', 'dropped')) not valid;
  end if;
end $$;

do $$
declare current_pk text;
begin
  select pg_get_constraintdef(oid) into current_pk
  from pg_constraint
  where conrelid = 'public.studio_trace_spans'::regclass and contype = 'p';
  if current_pk is null or current_pk not like '%account_scope_id%environment%trace_id%span_id%' then
    alter table public.studio_trace_spans drop constraint if exists studio_trace_spans_pkey;
    alter table public.studio_trace_spans
      add constraint studio_trace_spans_pkey
      primary key (account_scope_id, environment, trace_id, span_id);
  end if;
end $$;

create index if not exists studio_trace_spans_owner_run_idx
  on public.studio_trace_spans (owner_user_id, run_id, start_time_ms);
create index if not exists studio_trace_spans_scope_run_v2_idx
  on public.studio_trace_spans (account_scope_id, environment, run_id, start_time_ms, span_id)
  where run_id is not null;
create index if not exists studio_trace_spans_scope_trace_v2_idx
  on public.studio_trace_spans (account_scope_id, environment, trace_id, start_time_ms, span_id);
create index if not exists studio_trace_spans_client_operation_v2_idx
  on public.studio_trace_spans (account_scope_id, environment, client_operation_id)
  where client_operation_id is not null;
create index if not exists studio_trace_spans_retention_v2_idx
  on public.studio_trace_spans (received_at);
create index if not exists studio_trace_spans_scope_governance_expiry_idx
  on public.studio_trace_spans (account_scope_id, environment, governance_expires_at);

create table if not exists public.studio_trace_ingestion_receipts (
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  batch_id text not null,
  payload_hash text not null,
  producer_version text not null,
  moc_version text not null,
  device_ref text null,
  item_count integer not null check (item_count between 1 and 128),
  accepted_count integer not null default 0,
  duplicate_count integer not null default 0,
  conflict_count integer not null default 0,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '35 days'),
  primary key (account_scope_id, environment, batch_id)
);
create index if not exists studio_trace_ingestion_receipts_expiry_idx
  on public.studio_trace_ingestion_receipts (account_scope_id, environment, expires_at);

create table if not exists public.studio_trace_span_conflicts (
  account_scope_id text not null,
  environment text not null,
  trace_id text not null,
  span_id text not null,
  batch_id text not null,
  existing_hash text not null,
  incoming_hash text not null,
  reason_code text not null default 'immutable_identity_conflict',
  observed_at timestamptz not null default now(),
  primary key (account_scope_id, environment, trace_id, span_id, incoming_hash)
);
create index if not exists studio_trace_span_conflicts_scope_observed_idx
  on public.studio_trace_span_conflicts (account_scope_id, environment, observed_at desc);

-- backend mappings：以下拷贝自 studio migration 2026-08-26-unified-observability.sql

create table if not exists public.studio_trace_backend_mappings (
  mapping_id bigint generated always as identity primary key,
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  run_id text not null check (length(run_id) between 1 and 200),
  session_id text null check (session_id is null or length(session_id) between 1 and 200),
  trace_id text not null check (trace_id ~ '^[0-9a-f]{32}$'),
  backend text not null check (backend in ('langfuse')),
  backend_project_ref text null
    check (backend_project_ref is null or backend_project_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
  backend_trace_id text not null check (length(backend_trace_id) between 1 and 512),
  verified boolean not null default false,
  verified_at timestamptz null,
  tombstoned_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '35 days'),
  check (not verified or verified_at is not null),
  unique (account_scope_id, environment, backend, trace_id),
  unique (account_scope_id, environment, backend, backend_trace_id)
);

create index if not exists studio_trace_backend_mappings_scope_run_active_idx
  on public.studio_trace_backend_mappings
    (account_scope_id, environment, run_id, backend, expires_at, verified_at desc)
  where verified = true and tombstoned_at is null;
create index if not exists studio_trace_backend_mappings_scope_project_active_idx
  on public.studio_trace_backend_mappings
    (account_scope_id, environment, backend, backend_project_ref, verified_at desc)
  where verified = true and tombstoned_at is null and backend_project_ref is not null;
create index if not exists studio_trace_backend_mappings_scope_trace_idx
  on public.studio_trace_backend_mappings (account_scope_id, environment, trace_id);

-- agent_run_observability：基础列来自 durable-run-observability-store.ts，
-- scope 列/主键为 unified migration 追加后的最终形态。
create table if not exists public.agent_run_observability (
  observability_id bigint generated by default as identity primary key,
  run_id text not null,
  session_id text not null,
  account_scope_id text null,
  environment text not null default 'production',
  summary jsonb not null,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint agent_run_observability_environment_check
    check (environment in ('production', 'staging', 'development', 'test'))
);

create unique index if not exists agent_run_observability_scope_identity_uidx
  on public.agent_run_observability
    (account_scope_id, environment, run_id, session_id);
create index if not exists agent_run_observability_scope_run_idx
  on public.agent_run_observability
    (account_scope_id, environment, run_id, updated_at desc)
  where account_scope_id is not null;
create index if not exists agent_run_observability_scope_session_idx
  on public.agent_run_observability
    (account_scope_id, environment, session_id, updated_at desc)
  where account_scope_id is not null;
