-- Additive migration for the existing central conversation archive.
-- Legacy rows remain unbound; neither Run nor environment can be guessed.
begin;

alter table public.conversation_turns add column if not exists run_id text;
alter table public.conversation_turns add column if not exists environment text;

create index if not exists conversation_turns_account_environment_run_idx
  on public.conversation_turns (sso_user_id, environment, run_id)
  where run_id is not null;
create index if not exists conversation_turns_account_environment_session_idx
  on public.conversation_turns
    (sso_user_id, environment, session_id, recorded_at desc, id desc)
  where session_id is not null;

commit;
