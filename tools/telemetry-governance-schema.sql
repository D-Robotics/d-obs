-- Additive telemetry governance storage. Application code must always derive
-- account_scope_id from authenticated server identity before using these tables.

do $$
begin
  if to_regclass('public.studio_trace_spans') is not null then
    alter table public.studio_trace_spans
      add column if not exists governance_expires_at timestamptz;
    update public.studio_trace_spans
    set governance_expires_at = to_timestamp(start_time_ms / 1000.0) + interval '35 days'
    where governance_expires_at is null;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'studio_trace_spans'
        and column_name = 'account_scope_id'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'studio_trace_spans'
        and column_name = 'environment'
    ) then
      create index if not exists studio_trace_spans_scope_governance_expiry_idx
        on public.studio_trace_spans (account_scope_id, environment, governance_expires_at);
    end if;
  end if;
end $$;

create table if not exists public.studio_telemetry_payload_grants (
  grant_id uuid primary key default gen_random_uuid(),
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  scope_kind text not null check (scope_kind in ('run', 'session')),
  scope_id text not null check (scope_id not in ('*', 'all', 'any')),
  payload_classes text[] not null check (cardinality(payload_classes) between 1 and 5),
  purpose_code text not null check (purpose_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  approver_actor_ref text not null check (approver_actor_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  consent_subject_ref text not null check (consent_subject_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  consent_granted_at timestamptz not null,
  consent_expires_at timestamptz not null,
  destination text not null,
  created_at timestamptz not null default now(),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  check (starts_at >= created_at),
  check (expires_at > starts_at),
  check (expires_at <= starts_at + interval '7 days'),
  check (consent_granted_at <= starts_at),
  check (consent_expires_at >= starts_at)
);

create unique index if not exists studio_telemetry_payload_grants_scope_id_uidx
  on public.studio_telemetry_payload_grants (account_scope_id, environment, grant_id);
create index if not exists studio_telemetry_payload_grants_active_idx
  on public.studio_telemetry_payload_grants
    (account_scope_id, environment, scope_kind, scope_id, expires_at)
  where revoked_at is null;

create table if not exists public.studio_telemetry_payloads (
  payload_id uuid primary key default gen_random_uuid(),
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  grant_id uuid not null,
  scope_kind text not null check (scope_kind in ('run', 'session')),
  scope_id text not null,
  payload_class text not null check (
    payload_class in ('prompt', 'response', 'tool_arguments', 'tool_result', 'sanitized_exception')
  ),
  destination text not null,
  -- Only a bounded, already-redacted value may cross into this column.
  redacted_payload jsonb not null,
  encoded_bytes integer not null check (encoded_bytes between 0 and 32768),
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > captured_at),
  check (expires_at <= captured_at + interval '7 days'),
  foreign key (account_scope_id, environment, grant_id)
    references public.studio_telemetry_payload_grants (account_scope_id, environment, grant_id)
    on delete cascade
);

create index if not exists studio_telemetry_payloads_scope_expiry_idx
  on public.studio_telemetry_payloads (account_scope_id, environment, expires_at);
create index if not exists studio_telemetry_payloads_scope_target_idx
  on public.studio_telemetry_payloads
    (account_scope_id, environment, scope_kind, scope_id, captured_at desc);

create table if not exists public.studio_telemetry_audit (
  audit_id bigint generated always as identity primary key,
  event_version integer not null default 1 check (event_version = 1),
  occurred_at timestamptz not null,
  actor_ref text not null check (actor_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  actor_role text not null check (actor_role in ('account_owner', 'telemetry_administrator')),
  account_scope_ref text not null check (account_scope_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  action text not null check (action in (
    'read', 'search', 'advanced_link', 'payload_read', 'payload_capture',
    'grant_change', 'policy_change', 'retention_change', 'deletion',
    'redaction_failure', 'access_denial'
  )),
  target_type text not null check (target_type in (
    'trace', 'run', 'session', 'grant', 'policy', 'retention', 'account'
  )),
  target_ref text not null check (target_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  decision text not null check (decision in ('allowed', 'denied')),
  purpose_code text not null check (purpose_code ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  request_correlation_ref text not null check (request_correlation_ref ~ '^ref_[A-Za-z0-9_-]{32,64}$'),
  result text not null check (result in (
    'authorized', 'denied', 'completed', 'failed', 'redacted', 'scheduled'
  )),
  appended_at timestamptz not null default now()
);

create index if not exists studio_telemetry_audit_scope_time_idx
  on public.studio_telemetry_audit (account_scope_ref, occurred_at desc, audit_id desc);

create or replace function public.reject_studio_telemetry_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'studio_telemetry_audit is append-only';
end;
$$;

drop trigger if exists studio_telemetry_audit_append_only on public.studio_telemetry_audit;
create trigger studio_telemetry_audit_append_only
before update or delete on public.studio_telemetry_audit
for each row execute function public.reject_studio_telemetry_audit_mutation();

drop trigger if exists studio_telemetry_audit_no_truncate on public.studio_telemetry_audit;
create trigger studio_telemetry_audit_no_truncate
before truncate on public.studio_telemetry_audit
for each statement execute function public.reject_studio_telemetry_audit_mutation();

create table if not exists public.studio_telemetry_tombstones (
  tombstone_id uuid primary key default gen_random_uuid(),
  request_id text not null,
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  user_id text null,
  run_id text null,
  trace_id text null,
  session_id text null,
  grant_id text null,
  created_at timestamptz not null default now(),
  constraint studio_telemetry_tombstones_scope_request_key
    unique (account_scope_id, environment, request_id),
  constraint studio_telemetry_tombstones_scope_identity_key
    unique (tombstone_id, account_scope_id, environment)
);

create index if not exists studio_telemetry_tombstones_scope_created_idx
  on public.studio_telemetry_tombstones (account_scope_id, environment, created_at desc);
create index if not exists studio_telemetry_tombstones_scope_run_idx
  on public.studio_telemetry_tombstones (account_scope_id, environment, run_id)
  where run_id is not null;
create index if not exists studio_telemetry_tombstones_scope_trace_idx
  on public.studio_telemetry_tombstones (account_scope_id, environment, trace_id)
  where trace_id is not null;
create index if not exists studio_telemetry_tombstones_scope_session_idx
  on public.studio_telemetry_tombstones (account_scope_id, environment, session_id)
  where session_id is not null;

create or replace function public.apply_studio_telemetry_tombstone_to_backend_mappings()
returns trigger
language plpgsql
as $$
begin
  if new.grant_id is null
     and to_regclass('public.studio_trace_backend_mappings') is not null then
    execute $query$
      update public.studio_trace_backend_mappings mapping
      set tombstoned_at = coalesce(mapping.tombstoned_at, $1),
          updated_at = now()
      where mapping.account_scope_id = $2
        and mapping.environment = $3
        and ($4 is null or mapping.run_id = $4)
        and ($5 is null or mapping.trace_id = $5)
        and ($6 is null or mapping.session_id = $6)
    $query$
    using new.created_at, new.account_scope_id, new.environment,
          new.run_id, new.trace_id, new.session_id;
  end if;
  return new;
end;
$$;

drop trigger if exists studio_telemetry_tombstone_backend_mapping_guard
  on public.studio_telemetry_tombstones;
create trigger studio_telemetry_tombstone_backend_mapping_guard
after insert on public.studio_telemetry_tombstones
for each row execute function public.apply_studio_telemetry_tombstone_to_backend_mappings();

create table if not exists public.studio_telemetry_deletion_ledger (
  tombstone_id uuid not null,
  account_scope_id text not null,
  environment text not null check (environment in ('production', 'staging', 'development', 'test')),
  target text not null check (target in (
    'primary_storage', 'cache', 'outbox', 'retry_queue', 'dead_letter_queue',
    'payload_store', 'backend_mapping'
  )),
  status text not null check (status in ('pending', 'resolved')),
  reason_code text not null check (reason_code in (
    'target_unavailable', 'timeout', 'backend_unavailable', 'unknown_failure'
  )),
  attempts integer not null default 1 check (attempts > 0),
  retry_after timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tombstone_id, target),
  foreign key (tombstone_id, account_scope_id, environment)
    references public.studio_telemetry_tombstones
      (tombstone_id, account_scope_id, environment)
    on delete cascade
);

create index if not exists studio_telemetry_deletion_ledger_retry_idx
  on public.studio_telemetry_deletion_ledger (status, retry_after)
  where status = 'pending';
create index if not exists studio_telemetry_deletion_ledger_scope_idx
  on public.studio_telemetry_deletion_ledger
    (account_scope_id, environment, updated_at desc);

-- Idempotent and account-scoped by construction. The caller repeats per account;
-- it never fetches globally and filters in application memory.
create or replace function public.cleanup_expired_studio_telemetry(
  p_account_scope_id text,
  p_environment text,
  p_now timestamptz default now()
)
returns table (low_sensitivity_deleted bigint, payload_deleted bigint)
language plpgsql
as $$
declare
  v_low bigint := 0;
  v_payload bigint := 0;
  v_aux bigint := 0;
begin
  if nullif(trim(p_account_scope_id), '') is null
     or p_environment not in ('production', 'staging', 'development', 'test') then
    raise exception 'account scope and environment are required';
  end if;

  delete from public.studio_telemetry_payloads payload
  using public.studio_telemetry_payload_grants grant_row
  where payload.account_scope_id = p_account_scope_id
    and payload.environment = p_environment
    and grant_row.account_scope_id = payload.account_scope_id
    and grant_row.environment = payload.environment
    and grant_row.grant_id = payload.grant_id
    and (
      payload.expires_at <= p_now
      or grant_row.expires_at <= p_now
      or grant_row.consent_expires_at <= p_now
      or grant_row.revoked_at <= p_now
    );
  get diagnostics v_payload = row_count;

  -- A later grant revocation or consent expiry must shorten already-captured
  -- payload retention immediately. Payload rows were counted above; removing
  -- the now-inactive policy row is safe after its cascading children are gone.
  delete from public.studio_telemetry_payload_grants
  where account_scope_id = p_account_scope_id
    and environment = p_environment
    and (
      expires_at <= p_now
      or consent_expires_at <= p_now
      or revoked_at <= p_now
    );

  if to_regclass('public.studio_trace_spans') is not null then
    delete from public.studio_trace_spans
    where account_scope_id = p_account_scope_id
      and environment = p_environment
      and coalesce(
        governance_expires_at,
        to_timestamp(start_time_ms / 1000.0) + interval '35 days'
      ) <= p_now;
    get diagnostics v_low = row_count;
  end if;

  if to_regclass('public.studio_trace_ingestion_receipts') is not null then
    delete from public.studio_trace_ingestion_receipts
    where account_scope_id = p_account_scope_id
      and environment = p_environment
      and expires_at <= p_now;
    get diagnostics v_aux = row_count;
    v_low := v_low + v_aux;
  end if;

  if to_regclass('public.studio_trace_span_conflicts') is not null then
    delete from public.studio_trace_span_conflicts
    where account_scope_id = p_account_scope_id
      and environment = p_environment
      and observed_at <= p_now - interval '35 days';
    get diagnostics v_aux = row_count;
    v_low := v_low + v_aux;
  end if;

  if to_regclass('public.agent_run_observability') is not null then
    delete from public.agent_run_observability
    where account_scope_id = p_account_scope_id
      and environment = p_environment
      and updated_at <= p_now - interval '35 days';
    get diagnostics v_aux = row_count;
    v_low := v_low + v_aux;
  end if;

  if to_regclass('public.agent_run_records') is not null then
    delete from public.agent_run_records run_fact
    where run_fact.sso_user_id = p_account_scope_id
      and coalesce(
        nullif(to_jsonb(run_fact)->>'environment', ''),
        case when coalesce(run_fact.client_type, '') = 'local-dev'
          then 'development' else 'production' end
      ) = p_environment
      and run_fact.started_at <= p_now - interval '35 days';
    get diagnostics v_aux = row_count;
    v_low := v_low + v_aux;
  end if;

  if to_regclass('public.studio_trace_backend_mappings') is not null then
    delete from public.studio_trace_backend_mappings
    where account_scope_id = p_account_scope_id
      and environment = p_environment
      and expires_at <= p_now;
    get diagnostics v_aux = row_count;
    v_low := v_low + v_aux;
  end if;

  return query select v_low, v_payload;
end;
$$;

-- Product analytics remains a separate table. This nullable value is populated
-- only from a server-issued admission binding; client properties are never copied.
do $$
begin
  if to_regclass('public.product_events') is not null then
    alter table public.product_events
      add column if not exists authoritative_run_id text null;
    alter table public.product_events
      add column if not exists environment text not null default 'production';
    alter table public.product_events
      drop constraint if exists product_events_environment_check;
    alter table public.product_events
      add constraint product_events_environment_check
      check (environment in ('production', 'staging', 'development', 'test'));
    create index if not exists product_events_scope_authoritative_run_idx
      on public.product_events
        (sso_user_id, environment, authoritative_run_id, occurred_at desc)
      where authoritative_run_id is not null;
    comment on column public.product_events.authoritative_run_id is
      'Nullable canonical moss.run.id accepted only from a server-signed run-admission binding; never inferred by session or time.';
  end if;
end $$;

comment on table public.studio_telemetry_audit is
  'Append-only, content-free authorization and governance audit; all identities are keyed references.';
comment on table public.studio_telemetry_tombstones is
  'Durable scope-first read/export denial records, replayed before restored telemetry becomes visible.';