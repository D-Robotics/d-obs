-- d-obs 首次接入建表（幂等，DDL 与上游可观测域同源）
-- 用法：psql "$RDK_CHAT_CREDITS_DB_URL" -f tools/init-schema.sql
-- 说明：studio_external_probe_status 由 ingest 代码自动建表；本脚本预置探针
-- 上报写入 studio_alert_checks 所需的最小 schema，让首次上报即可成功（否则
-- 需要告警 worker 先运行一轮建表）。

create table if not exists public.studio_alert_checks (
  alert_key text primary key,
  title text not null,
  category text not null default 'metric',
  enabled boolean not null default true,
  severity text not null,
  unhealthy boolean not null,
  active boolean not null,
  summary text null,
  checked_at timestamptz not null,
  failure_streak int not null default 0,
  success_streak int not null default 0
);

alter table public.studio_alert_checks
  add column if not exists category text not null default 'metric';
alter table public.studio_alert_checks
  add column if not exists enabled boolean not null default true;

create index if not exists studio_alert_checks_checked_idx
  on public.studio_alert_checks (checked_at desc);

create table if not exists public.studio_external_probe_status (
  source text primary key,
  reported_at timestamptz not null,
  status text not null,
  checks jsonb not null default '[]'::jsonb
);

-- 探针上报 active 检查项时会级联 upsert 事故记录
create table if not exists public.studio_alert_incidents (
  alert_key text primary key,
  title text not null,
  severity text not null,
  status text not null,
  summary text null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_notified_at timestamptz null,
  resolved_at timestamptz null,
  occurrence_count int not null default 1
);
