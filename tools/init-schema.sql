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

-- worker 的 recordIncident upsert 与路由侧静默/认领操作依赖这些列；
-- 只建表不加列会让 worker 写 incident 时报错被静默吞掉。
alter table public.studio_alert_incidents
  add column if not exists acknowledged_at timestamptz null;
alter table public.studio_alert_incidents
  add column if not exists acknowledged_by text null;
alter table public.studio_alert_incidents
  add column if not exists assignee text null;
alter table public.studio_alert_incidents
  add column if not exists silence_until timestamptz null;
alter table public.studio_alert_incidents
  add column if not exists silence_reason text null;

create index if not exists studio_alert_incidents_silence_idx
  on public.studio_alert_incidents (silence_until) where status = 'silenced';

-- 告警通知投递记录（worker 每轮 transition 落库；测试通知同表）
create table if not exists public.studio_alert_notifications (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  alert_key text not null,
  transition text not null,
  severity text not null,
  delivered boolean not null,
  channel text not null,
  error text null,
  attempt_count int not null default 1
);

create index if not exists studio_alert_notifications_occurred_idx
  on public.studio_alert_notifications (occurred_at desc);

-- worker 运行状态单例行（看板“告警基础状态”卡片读取）
create table if not exists public.studio_alert_worker_status (
  singleton boolean primary key default true check (singleton),
  last_run_at timestamptz not null,
  enabled boolean not null,
  shadow_mode boolean not null,
  channel_configured boolean not null,
  channel text not null,
  config_updated_at timestamptz null,
  check_count int not null,
  active_count int not null,
  worker_version text not null
);

-- 自愈运行审计（readiness 探针要求列集/约束/索引齐全且 RLS 启用；
-- DDL 与上游 2026-08-31-remediation-environment.sql 迁移同源）
create table if not exists public.studio_remediation_runs (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'production',
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  playbook_id text not null,
  trigger text not null default 'manual',
  triggered_by text not null default '',
  status text not null default 'running',
  summary text null,
  steps jsonb not null default '[]'::jsonb,
  constraint studio_remediation_runs_environment_check
    check (environment in ('production', 'staging', 'development', 'test'))
);

create index if not exists studio_remediation_runs_environment_started_idx
  on public.studio_remediation_runs (environment, started_at desc);

-- 控制面数据：仅服务器连接角色可写；直连自有库的部署至少启用 RLS。
alter table public.studio_remediation_runs enable row level security;
