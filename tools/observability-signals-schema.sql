-- d-obs 扩展信号面 schema（幂等，与运行时 store 的建表语句同源）：
--   1) studio_observability_logs            OTLP logs（低敏感白名单）
--   2) studio_observability_metric_*        OTLP metrics 持久化（series + 样本）
--   3) studio_devices / studio_device_samples 边缘设备注册与心跳样本
--   4) studio_model_prices                  token 成本归因单价表
--   5) studio_obs_dashboard_panels          自定义面板（保存的指标查询）
-- 由 tools/init-schema.sql 通过 \ir 引入；各 store 首次写入时也会执行相同
-- 的幂等 DDL，两侧保持同源，修改须双向同步。
-- 保留策略：logs / metric samples / device samples 由运行时按
-- RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS（默认 14 天）周期清理，以
-- received_at / ts_ms 为准，不在此建分区。

-- ===== OTLP logs（低敏感） =====
create table if not exists public.studio_observability_logs (
  id bigint generated always as identity primary key,
  owner text not null,
  service text not null default 'unknown',
  environment text not null default 'unknown',
  severity_text text not null default 'INFO',
  severity_number int not null default 9 check (severity_number between 1 and 24),
  body text null,
  attributes jsonb not null default '{}'::jsonb,
  trace_id text null,
  span_id text null,
  timestamp_ms bigint not null,
  received_at timestamptz not null default now()
);

create index if not exists studio_observability_logs_owner_time_idx
  on public.studio_observability_logs (owner, timestamp_ms desc);
create index if not exists studio_observability_logs_received_idx
  on public.studio_observability_logs (received_at);

-- ===== OTLP metrics 持久化 =====
create table if not exists public.studio_observability_metric_series (
  series_id bigint generated always as identity primary key,
  owner text not null,
  metric text not null,
  labels jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (owner, metric, fingerprint)
);

create index if not exists studio_observability_metric_series_metric_idx
  on public.studio_observability_metric_series (metric);

create table if not exists public.studio_observability_metric_samples (
  series_id bigint not null,
  ts_ms bigint not null,
  value double precision not null,
  primary key (series_id, ts_ms)
);

-- ===== 边缘设备 =====
create table if not exists public.studio_devices (
  device_id text primary key,
  display_name text not null default '',
  token_hash text not null unique,
  tenant_id text not null default 'platform',
  model text not null default '',
  firmware text not null default '',
  labels jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  last_seen_at timestamptz null,
  last_ip text null
);

create table if not exists public.studio_device_samples (
  device_id text not null,
  ts_ms bigint not null,
  metrics jsonb not null default '{}'::jsonb,
  primary key (device_id, ts_ms)
);

-- ===== 模型单价（每百万 token） =====
create table if not exists public.studio_model_prices (
  model text primary key,
  input_per_m double precision not null default 0,
  output_per_m double precision not null default 0,
  currency text not null default 'CNY',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

-- ===== 告警配置跨副本一致读源（单例行，存原文 text；文件仍是写盘基准） =====
create table if not exists public.studio_alert_config (
  singleton boolean primary key default true check (singleton),
  raw_text text not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

-- ===== run 级评分/反馈（与 server/public-api/public-observability-quality-store.ts
-- 的运行时建表 DDL 同源；预置让"质量与反馈"趋势在首次写入前即可查询） =====
create table if not exists public.studio_public_observability_scores (
  score_id text primary key,
  account_scope_id text not null,
  environment text not null,
  run_id text not null,
  name text not null,
  value double precision not null,
  data_type text not null,
  source text not null,
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists studio_public_observability_scores_run_idx
  on public.studio_public_observability_scores (account_scope_id, environment, run_id, created_at desc);

create table if not exists public.studio_public_observability_feedback (
  feedback_id text primary key,
  account_scope_id text not null,
  environment text not null,
  run_id text not null,
  kind text not null check (kind in ('up', 'down')),
  message_id text,
  comment text,
  user_message text,
  assistant_message text,
  timeline text,
  created_at timestamptz not null default now()
);
create index if not exists studio_public_observability_feedback_run_idx
  on public.studio_public_observability_feedback (account_scope_id, environment, run_id, created_at desc);

-- ===== 自定义面板 =====
create table if not exists public.studio_obs_dashboard_panels (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  owner text not null,
  spec jsonb not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_obs_dashboard_panels_owner_idx
  on public.studio_obs_dashboard_panels (owner, position);

-- ===== 生态接入凭据（人/服务/租户三级签发；身份只在凭据层，遥测零 PII） =====
create table if not exists public.studio_obs_ingest_tokens (
  token_id text primary key,
  token_hash text not null unique,
  subject_type text not null check (subject_type in ('user', 'service', 'tenant')),
  subject_id text not null,
  display_name text not null default '',
  labels jsonb not null default '{}'::jsonb,
  owner text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  last_seen_at timestamptz null,
  revoked_at timestamptz null
);
