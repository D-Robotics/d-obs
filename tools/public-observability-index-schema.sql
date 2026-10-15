-- Additive per-entity authority; runtime schema version is set after dependent trace/quality schemas are ready.

create table if not exists public.studio_public_observability_runs (
  environment text not null, run_id text not null, owner text not null, account_scope_id text not null,
  payload jsonb not null, updated_at_ms bigint not null, expires_at_ms bigint not null,
  primary key (environment, run_id)
);
alter table public.studio_public_observability_runs add column if not exists account_scope_id text;
update public.studio_public_observability_runs set account_scope_id=owner where account_scope_id is null;
alter table public.studio_public_observability_runs alter column account_scope_id set not null;
alter table public.studio_public_observability_runs add column if not exists expires_at_ms bigint;
update public.studio_public_observability_runs set expires_at_ms =
  least((payload->'run'->>'createdAt')::bigint, coalesce((payload->'run'->>'firstSpanAt')::bigint, (payload->'run'->>'createdAt')::bigint)) + 3024000000
  where expires_at_ms is null;
alter table public.studio_public_observability_runs alter column expires_at_ms set not null;
create index if not exists studio_public_observability_runs_expiry_idx
  on public.studio_public_observability_runs(environment, expires_at_ms);
create index if not exists studio_public_observability_runs_owner_idx
  on public.studio_public_observability_runs(environment, owner, updated_at_ms desc);
create table if not exists public.studio_public_observability_idempotency (
  environment text not null, owner text not null, key_id text not null, idempotency_key text not null,
  run_id text not null, primary key(environment, owner, key_id, idempotency_key),
  foreign key(environment, run_id) references public.studio_public_observability_runs(environment, run_id) on delete cascade
);
create table if not exists public.studio_public_observability_profiles (
  environment text not null, owner text not null, team text not null, object_type text not null, object_id text not null,
  payload jsonb not null, primary key(environment, owner, team, object_type, object_id)
);
