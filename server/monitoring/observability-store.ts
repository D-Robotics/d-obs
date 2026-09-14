/**
 * 生产可观测看板的数据聚合层。
 *
 * 概览只返回跨租户的低敏感运维信号、聚合计数与不可逆关联引用。对话上下文只能由
 * 运营管理员通过单事件详情接口按需读取，且必须精确匹配账号 + 会话、限量、截断、再次脱敏。
 * 任何接口都不返回 Cookie、Token、密钥、工具参数/结果或原始堆栈。
 */
import { ensureOpsEventSchema, sanitizeOpsSummary } from './ops-event-store.js';
import { loadAlertConfig } from './alert-config.js';
import { CLIENT_ERROR_NON_ACTIONABLE_API_CODES } from '../../shared/client-error-telemetry.js';
import type {
  OpsEventContextSummary,
  OpsEventDetail,
} from './observability-event-detail-types.js';
export type { OpsEventContextSummary, OpsEventDetail } from './observability-event-detail-types.js';
import {
  normalizeEventEnvironment,
  OBSERVABILITY_SCOPED_RUN_JOIN_SQL,
} from './observability-query-scope.js';
import { getEvolutionOverview, type EvolutionOverview } from '../evolution/evolution-store.js';
import { opaqueObservabilityRef } from './observability-opaque-ref.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

export function isOpsObservabilityConfigured(): boolean {
  return centralDbUrl().length > 0;
}

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 3 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, maxLength = 500): string {
  return sanitizeOpsSummary(value, maxLength);
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? '');
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function safeMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    'tool_name',
    'failure_category',
    'failure_detail',
    'error_code',
    'tool_call_id',
    'attempt',
    'retry_count',
    'run_id',
    'route',
    'method',
    'status',
    'duration_ms',
    'channel',
    'client_type',
    'app_version',
    'environment',
    'source',
    'release',
    'error_name',
    'code',
    'top_frame',
    'fatal',
    'operational',
    'occurrence_count',
  ];
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const item = source[key];
    if (typeof item === 'string') result[key] = text(item, 160);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    else if (typeof item === 'boolean' || item === null) result[key] = item;
  }
  return result;
}

function safeStringArray(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => text(item, 120))
    .filter(Boolean);
}

function eventContextFromRow(row: Record<string, unknown>): OpsEventContextSummary {
  const userRef = opaqueObservabilityRef(row.actor_user_id, 'user');
  const deviceRef = opaqueObservabilityRef(row.context_device_id, 'device');
  const deviceModel = text(row.context_device_model, 120) || null;
  const sessionRef = opaqueObservabilityRef(row.context_session_id, 'session');
  return {
    user: userRef
      ? {
          displayName: text(row.actor_user_name, 120) || null,
          ref: userRef,
        }
      : null,
    clientType: text(row.context_client_type, 32) || null,
    channel: text(row.context_channel, 64) || null,
    appVersion: text(row.context_app_version, 64) || null,
    device: deviceModel || deviceRef ? { model: deviceModel, ref: deviceRef } : null,
    runRef: opaqueObservabilityRef(row.context_run_id, 'run'),
    sessionRef,
    detailsAvailable: Boolean(
      userRef || deviceModel || deviceRef || row.context_run_id || sessionRef,
    ),
  };
}

export interface OpsObservabilityOverview {
  generatedAt: string;
  windowHours: number;
  alerting: {
    enabled: boolean;
    webhookConfigured: boolean;
    shadowMode: boolean;
    channel: string;
    configUpdatedAt: string | null;
    workerVersion: string | null;
    lastCheckedAt: string | null;
    status: 'healthy' | 'warning' | 'critical' | 'stale';
  };
  summary: {
    totalChecks: number;
    healthyChecks: number;
    observingChecks: number;
    disabledChecks: number;
    openIncidents: number;
    criticalIncidents: number;
    deliveredNotifications: number;
  };
  ai: {
    total: number;
    completed: number;
    partial: number;
    errors: number;
    cancelled: number;
    successRate: number | null;
  };
  signals: {
    toolFailures: number;
    clientErrors: number;
    loginSuccess: number;
    loginRejected: number;
    loginInfrastructureErrors: number;
    api5xx: number;
    processErrors: number;
    totalEvents: number;
  };
  evolution: EvolutionOverview;
  checks: Array<{
    key: string;
    title: string;
    severity: string;
    category: string;
    enabled: boolean;
    status: 'healthy' | 'observing' | 'warning' | 'critical' | 'disabled';
    summary: string;
    checkedAt: string | null;
    failureStreak: number;
    successStreak: number;
  }>;
  trend: Array<{
    bucket: string;
    aiErrors: number;
    toolFailures: number;
    clientErrors: number;
    apiErrors: number;
    loginErrors: number;
  }>;
  incidents: Array<{
    key: string;
    title: string;
    severity: string;
    status: string;
    summary: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    resolvedAt: string | null;
    occurrences: number;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    assignee: string | null;
    silenceUntil: string | null;
    silenceReason: string | null;
  }>;
  incidentActivity: Array<{
    occurredAt: string | null;
    alertKey: string;
    action: string;
    actor: string;
    summary: string;
  }>;
  configurationAudit: Array<{
    occurredAt: string | null;
    actor: string;
    action: string;
    summary: string;
  }>;
  notifications: Array<{
    occurredAt: string | null;
    alertKey: string;
    transition: string;
    severity: string;
    delivered: boolean;
    channel: string;
    error: string | null;
  }>;
  events: Array<{
    id: string;
    occurredAt: string | null;
    component: string;
    eventCode: string;
    outcome: string;
    severity: string;
    summary: string;
    metadata: Record<string, string | number | boolean | null>;
    context: OpsEventContextSummary;
  }>;
}

type OpsIncidentAction = 'acknowledge' | 'assign' | 'silence' | 'reopen';

function incidentKey(value: string): string {
  const key = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(key)) throw new Error('invalid_incident_key');
  return key;
}

function auditActor(value: string): string {
  const actor = text(value, 160);
  return actor || 'ops-admin';
}

let incidentSchemaReady: Promise<void> | null = null;
async function ensureIncidentOperationsSchema(p: Pool): Promise<void> {
  if (!incidentSchemaReady) {
    incidentSchemaReady = (async () => {
      await p.query(`
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
    )
  `);
      for (const statement of [
    `alter table public.studio_alert_incidents add column if not exists acknowledged_at timestamptz null`,
    `alter table public.studio_alert_incidents add column if not exists acknowledged_by text null`,
    `alter table public.studio_alert_incidents add column if not exists assignee text null`,
    `alter table public.studio_alert_incidents add column if not exists silence_until timestamptz null`,
    `alter table public.studio_alert_incidents add column if not exists silence_reason text null`,
    `create index if not exists studio_alert_incidents_silence_idx on public.studio_alert_incidents (silence_until) where status = 'silenced'`,
    `create table if not exists public.studio_alert_incident_activity (
      id bigserial primary key,
      occurred_at timestamptz not null default now(),
      alert_key text not null,
      action text not null,
      actor text not null,
      summary text not null
    )`,
    `create index if not exists studio_alert_incident_activity_alert_idx on public.studio_alert_incident_activity (alert_key, occurred_at desc)`,
    `create table if not exists public.studio_alert_configuration_audit (
      id bigserial primary key,
      occurred_at timestamptz not null default now(),
      actor text not null,
      action text not null,
      summary text not null
    )`,
      ]) {
        await p.query(statement);
      }
    })().catch((error) => {
      incidentSchemaReady = null;
      throw error;
    });
  }
  await incidentSchemaReady;
}

export async function recordOpsConfigurationAudit(input: {
  actor: string;
  action: string;
  summary: string;
}): Promise<void> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  await p.query(
    `insert into public.studio_alert_configuration_audit (actor, action, summary)
     values ($1, $2, $3)`,
    [auditActor(input.actor), text(input.action, 64), text(input.summary, 800)],
  );
}

export async function updateOpsIncident(
  keyInput: string,
  input: { action: OpsIncidentAction; actor: string; assignee?: string; minutes?: number; reason?: string },
): Promise<void> {
  const key = incidentKey(keyInput);
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const actor = auditActor(input.actor);
  const action = input.action;
  let summary = '';
  let result: PgQueryResult;
  if (action === 'acknowledge') {
    summary = '已确认，等待处置或恢复';
    result = await p.query(
      `update public.studio_alert_incidents
       set status = case when status = 'resolved' then status else 'acknowledged' end,
           acknowledged_at = now(), acknowledged_by = $2
       where alert_key = $1
       returning alert_key`,
      [key, actor],
    );
  } else if (action === 'assign') {
    const assignee = text(input.assignee, 160);
    if (!assignee) throw new Error('incident_assignee_required');
    summary = `已指派给 ${assignee}`;
    result = await p.query(
      `update public.studio_alert_incidents set assignee = $2 where alert_key = $1 returning alert_key`,
      [key, assignee],
    );
  } else if (action === 'silence') {
    const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(Number(input.minutes) || 0)));
    const reason = text(input.reason, 400);
    if (!reason) throw new Error('incident_silence_reason_required');
    summary = `已静默 ${minutes} 分钟：${reason}`;
    result = await p.query(
      `update public.studio_alert_incidents
       set status = case when status = 'resolved' then status else 'silenced' end,
           silence_until = now() + make_interval(mins => $2::int), silence_reason = $3
       where alert_key = $1
       returning alert_key`,
      [key, minutes, reason],
    );
  } else {
    summary = '已重新打开事故';
    result = await p.query(
      `update public.studio_alert_incidents
       set status = 'open', acknowledged_at = null, acknowledged_by = null,
           silence_until = null, silence_reason = null, resolved_at = null
       where alert_key = $1
       returning alert_key`,
      [key],
    );
  }
  if (!result.rowCount) throw new Error('incident_not_found');
  await p.query(
    `insert into public.studio_alert_incident_activity (alert_key, action, actor, summary)
     values ($1, $2, $3, $4)`,
    [key, action, actor, summary],
  );
}

export async function getOpsObservabilityOverview(
  hoursInput = 24,
): Promise<OpsObservabilityOverview> {
  const hours = Math.max(1, Math.min(168, Math.floor(Number(hoursInput) || 24)));
  await ensureOpsEventSchema();
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const alertConfig = await loadAlertConfig();
  const [
    checksResult,
    workerStatusResult,
    incidentSummaryResult,
    incidentsResult,
    incidentActivityResult,
    configurationAuditResult,
    notificationsResult,
    runSummaryResult,
    runTrendResult,
    signalSummaryResult,
    signalTrendResult,
    eventsResult,
    evolution,
  ] = await Promise.all([
    p.query(
      `select alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at,
              failure_streak, success_streak
       from public.studio_alert_checks
       order by active desc, unhealthy desc, severity desc, alert_key`,
    ),
    p
      .query(
        `select last_run_at, enabled, shadow_mode, channel_configured, channel,
                config_updated_at, check_count, active_count, worker_version
         from public.studio_alert_worker_status where singleton = true`,
      )
      .catch((error) => {
        if ((error as { code?: string }).code === '42P01') return { rows: [] };
        throw error;
      }),
    p.query(
      `select count(*) filter (where status in ('open', 'acknowledged', 'silenced'))::int open_incidents,
              count(*) filter (where status in ('open', 'acknowledged', 'silenced') and severity = 'critical')::int critical_incidents
       from public.studio_alert_incidents`,
    ),
    p.query(
      `select alert_key, title, severity, status, summary, first_seen_at, last_seen_at,
              resolved_at, occurrence_count, acknowledged_at, acknowledged_by, assignee,
              silence_until, silence_reason
       from public.studio_alert_incidents
       where last_seen_at >= now() - make_interval(hours => $1::int) or status = 'open'
       order by (status = 'open') desc, last_seen_at desc
       limit 50`,
      [hours],
    ),
    p.query(
      `select occurred_at, alert_key, action, actor, summary
       from public.studio_alert_incident_activity
       where occurred_at >= now() - make_interval(hours => $1::int)
       order by occurred_at desc
       limit 50`,
      [hours],
    ),
    p.query(
      `select occurred_at, actor, action, summary
       from public.studio_alert_configuration_audit
       where occurred_at >= now() - make_interval(hours => $1::int)
       order by occurred_at desc
       limit 25`,
      [hours],
    ),
    p.query(
      `select occurred_at, alert_key, transition, severity, delivered, channel, error
       from public.studio_alert_notifications
       where occurred_at >= now() - make_interval(hours => $1::int)
       order by occurred_at desc
       limit 50`,
      [hours],
    ),
    p.query(
      `with latest as (
         select distinct on (run_id) run_id, outcome
         from public.agent_run_records
         where started_at >= now() - make_interval(hours => $1::int)
           and started_at <= now() + interval '5 minutes'
           and coalesce(client_type, '') <> 'local-dev'
         order by run_id, created_at desc
       )
       select count(*)::int total,
              count(*) filter (where outcome = 'completed')::int completed,
              count(*) filter (where outcome = 'completed_partial')::int partial,
              count(*) filter (where outcome = 'error')::int errors,
              count(*) filter (where outcome = 'cancelled')::int cancelled
       from latest`,
      [hours],
    ),
    p.query(
      `with latest as (
         select distinct on (run_id) run_id, outcome, started_at
         from public.agent_run_records
         where started_at >= now() - make_interval(hours => $1::int)
           and started_at <= now() + interval '5 minutes'
           and coalesce(client_type, '') <> 'local-dev'
         order by run_id, created_at desc
       )
       select date_trunc('hour', started_at) bucket,
              count(*) filter (where outcome = 'error')::int ai_errors
       from latest
       group by 1 order by 1`,
      [hours],
    ),
    p.query(
      `select count(*)::int total_events,
              count(*) filter (
                where event_code = 'tool_call' and outcome = 'error'
                  and coalesce(metadata->>'client_type', '') <> 'local-dev'
              )::int tool_failures,
              coalesce(sum(
                case when event_code = 'client_error' and outcome = 'error'
                          and coalesce(metadata->>'operational', 'true') = 'true'
                          and coalesce(metadata->>'environment', 'production') not in ('development', 'test')
                          and not (coalesce(metadata->>'code', '') = any($2::text[]))
                          and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
                          and safe_summary !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
                          and not (
                            coalesce(metadata->>'source', '') = 'resource_error'
                            and coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
                          )
                          and not (
                            coalesce(metadata->>'source', '') = 'api_error'
                            and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
                          )
                          and not (
                            coalesce(metadata->>'source', '') = 'electron_child_gone'
                            and (
                              lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
                              or safe_summary ~* 'signal=SIGTERM'
                            )
                          )
                          and not (
                            coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
                            and coalesce(metadata->>'code', '') = '1073807364'
                            and safe_summary ~* '(killed|embedded server exited)'
                          )
                          and safe_summary !~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
                          and coalesce(metadata->>'top_frame', '') not like '%://localhost:5173/%'
                          and safe_summary not like '%http://localhost:5173/%'
                     then greatest(
                       1,
                       case when metadata->>'occurrence_count' ~ '^[0-9]+$'
                            then (metadata->>'occurrence_count')::int else 1 end
                     )
                     else 0 end
              ), 0)::int client_errors,
              count(*) filter (where event_code = 'sso_login_attempt' and outcome = 'ok')::int login_success,
              count(*) filter (where event_code = 'sso_login_attempt' and outcome = 'rejected')::int login_rejected,
              count(*) filter (where event_code = 'sso_login_attempt' and outcome = 'error')::int login_errors,
              count(*) filter (
                where event_code = 'http_5xx' and outcome = 'error'
                  and not (
                    coalesce(metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
                    and coalesce(metadata->>'status', '') in ('503', '504')
                  )
              )::int api_5xx,
              count(*) filter (where event_code = 'process_unhandled_error' and outcome = 'error')::int process_errors
       from public.studio_ops_events
       where occurred_at >= now() - make_interval(hours => $1::int)
         and occurred_at <= now() + interval '5 minutes'
         and coalesce(metadata->>'client_type', '') <> 'local-dev'`,
      [hours, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
    ),
    p.query(
      `select date_trunc('hour', occurred_at) bucket,
              count(*) filter (
                where event_code = 'tool_call' and outcome = 'error'
                  and coalesce(metadata->>'client_type', '') <> 'local-dev'
              )::int tool_failures,
              coalesce(sum(
                case when event_code = 'client_error' and outcome = 'error'
                          and coalesce(metadata->>'operational', 'true') = 'true'
                          and coalesce(metadata->>'environment', 'production') not in ('development', 'test')
                          and not (coalesce(metadata->>'code', '') = any($2::text[]))
                          and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
                          and safe_summary !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
                          and not (
                            coalesce(metadata->>'source', '') = 'resource_error'
                            and coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
                          )
                          and not (
                            coalesce(metadata->>'source', '') = 'api_error'
                            and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
                          )
                          and not (
                            coalesce(metadata->>'source', '') = 'electron_child_gone'
                            and (
                              lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
                              or safe_summary ~* 'signal=SIGTERM'
                            )
                          )
                          and not (
                            coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
                            and coalesce(metadata->>'code', '') = '1073807364'
                            and safe_summary ~* '(killed|embedded server exited)'
                          )
                          and safe_summary !~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
                          and coalesce(metadata->>'top_frame', '') not like '%://localhost:5173/%'
                          and safe_summary not like '%http://localhost:5173/%'
                     then greatest(
                       1,
                       case when metadata->>'occurrence_count' ~ '^[0-9]+$'
                            then (metadata->>'occurrence_count')::int else 1 end
                     )
                     else 0 end
              ), 0)::int client_errors,
              count(*) filter (
                where event_code = 'http_5xx' and outcome = 'error'
                  and not (
                    coalesce(metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
                    and coalesce(metadata->>'status', '') in ('503', '504')
                  )
              )::int api_errors,
              count(*) filter (where event_code = 'sso_login_attempt' and outcome = 'error')::int login_errors
       from public.studio_ops_events
       where occurred_at >= now() - make_interval(hours => $1::int)
         and occurred_at <= now() + interval '5 minutes'
         and coalesce(metadata->>'client_type', '') <> 'local-dev'
       group by 1 order by 1`,
      [hours, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
    ),
    p.query(
      `with recent_events as (
         select id, occurred_at, component, event_code, outcome, severity_hint,
                safe_summary, metadata, correlation
         from public.studio_ops_events
         where occurred_at >= now() - make_interval(hours => $1::int)
           and occurred_at <= now() + interval '5 minutes'
           and coalesce(metadata->>'client_type', '') <> 'local-dev'
           and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
           and safe_summary !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
           and not (
             event_code = 'client_error'
             and coalesce(metadata->>'source', '') = 'resource_error'
             and coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
           )
           and not (
             event_code = 'client_error'
             and (
               coalesce(metadata->>'operational', 'true') = 'false'
               or (
                 coalesce(metadata->>'source', '') = 'api_error'
                 and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
               )
               or (
                 coalesce(metadata->>'source', '') = 'electron_child_gone'
                 and (
                   lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
                   or safe_summary ~* 'signal=SIGTERM'
                 )
               )
               or (
                 coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
                 and coalesce(metadata->>'code', '') = '1073807364'
                 and safe_summary ~* '(killed|embedded server exited)'
               )
               or safe_summary ~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
             )
           )
           and not (
             event_code = 'http_5xx'
             and coalesce(metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
             and coalesce(metadata->>'status', '') in ('503', '504')
           )
         order by occurred_at desc
         limit 100
       )
       select e.*,
              coalesce(nullif(e.correlation->>'user_id', ''), run.sso_user_id) actor_user_id,
              actor.sso_user_name actor_user_name,
              coalesce(
                nullif(e.correlation->>'client_type', ''),
                run.client_type,
                nullif(e.metadata->>'client_type', '')
              ) context_client_type,
              coalesce(
                nullif(e.correlation->>'channel', ''),
                run.channel,
                nullif(e.metadata->>'channel', '')
              ) context_channel,
              coalesce(
                nullif(e.correlation->>'app_version', ''),
                nullif(run.run_json->>'app_version', ''),
                nullif(e.metadata->>'app_version', '')
              ) context_app_version,
              coalesce(nullif(e.correlation->>'device_id', ''), run.device_id) context_device_id,
              coalesce(nullif(e.correlation->>'device_model', ''), run.device_model) context_device_model,
              coalesce(
                nullif(e.correlation->>'session_id', ''),
                nullif(run.run_json->>'session_id', '')
              ) context_session_id,
              coalesce(
                nullif(e.correlation->>'run_id', ''),
                nullif(e.metadata->>'run_id', '')
              ) context_run_id
       from recent_events e
       left join lateral (
         select r.sso_user_id, r.device_id, r.device_model, r.channel, r.client_type,
                to_jsonb(r) run_json
         from public.agent_run_records r
         where r.run_id = coalesce(
           nullif(e.correlation->>'run_id', ''),
           nullif(e.metadata->>'run_id', '')
         )
${OBSERVABILITY_SCOPED_RUN_JOIN_SQL}
         order by r.created_at desc
         limit 1
       ) run on true
       left join lateral (
         select c.sso_user_name
         from public.conversation_turns c
         where c.sso_user_id = coalesce(
           nullif(e.correlation->>'user_id', ''),
           run.sso_user_id
         )
           and nullif(trim(c.sso_user_name), '') is not null
         order by c.recorded_at desc
         limit 1
       ) actor on true
       order by e.occurred_at desc`,
      [hours],
    ),
    getEvolutionOverview(p),
  ]);

  const checks = checksResult.rows.map((row) => {
    const enabled = row.enabled !== false;
    const active = row.active === true;
    const unhealthy = row.unhealthy === true;
    const severity = text(row.severity, 24) || 'warning';
    const key = text(row.alert_key, 120);
    const checkedAt = iso(row.checked_at);
    const externalStale =
      key.startsWith('external-') &&
      (!checkedAt || Date.now() - Date.parse(checkedAt) > 3 * 60_000);
    return {
      key,
      title: text(row.title, 200),
      severity,
      category: text(row.category, 24) || 'metric',
      enabled,
      status: (!enabled
        ? 'disabled'
        : externalStale
          ? 'critical'
          : active
            ? severity === 'critical'
              ? 'critical'
              : 'warning'
            : unhealthy
              ? 'observing'
              : 'healthy') as 'healthy' | 'observing' | 'warning' | 'critical' | 'disabled',
      summary: externalStale ? '异地拨测心跳超过 3 分钟未上报' : text(row.summary, 800),
      checkedAt,
      failureStreak: number(row.failure_streak),
      successStreak: number(row.success_streak),
    };
  });
  const lastCheckedAt =
    checks
      .map((check) => check.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const workerStatus = (workerStatusResult.rows[0] ?? {}) as Record<string, unknown>;
  const workerLastRunAt = iso(workerStatus.last_run_at);
  const effectiveLastCheckedAt = workerLastRunAt ?? lastCheckedAt;
  const isStale =
    !effectiveLastCheckedAt || Date.now() - Date.parse(effectiveLastCheckedAt) > 3 * 60_000;
  const incidentSummary = incidentSummaryResult.rows[0] ?? {};
  const openIncidents = number(incidentSummary.open_incidents);
  const criticalIncidents = number(incidentSummary.critical_incidents);
  const status = isStale
    ? 'stale'
    : criticalIncidents > 0 || checks.some((check) => check.status === 'critical')
      ? 'critical'
      : openIncidents > 0 || checks.some((check) => check.status === 'warning')
        ? 'warning'
        : 'healthy';

  const run = runSummaryResult.rows[0] ?? {};
  const totalRuns = number(run.total);
  const completed = number(run.completed);
  const partial = number(run.partial);
  const successful = completed + partial;
  const signal = signalSummaryResult.rows[0] ?? {};
  const webhookConfigured =
    typeof workerStatus.channel_configured === 'boolean'
      ? workerStatus.channel_configured
      : Boolean(
          alertConfig.notification.channel === 'feishu'
            ? alertConfig.notification.feishuWebhookUrl
            : alertConfig.notification.webhookUrl,
        );

  const trendByBucket = new Map<
    string,
    {
      bucket: string;
      aiErrors: number;
      toolFailures: number;
      clientErrors: number;
      apiErrors: number;
      loginErrors: number;
    }
  >();
  for (const row of runTrendResult.rows) {
    const bucket = iso(row.bucket);
    if (!bucket) continue;
    trendByBucket.set(bucket, {
      bucket,
      aiErrors: number(row.ai_errors),
      toolFailures: 0,
      clientErrors: 0,
      apiErrors: 0,
      loginErrors: 0,
    });
  }
  for (const row of signalTrendResult.rows) {
    const bucket = iso(row.bucket);
    if (!bucket) continue;
    const current = trendByBucket.get(bucket) ?? {
      bucket,
      aiErrors: 0,
      toolFailures: 0,
      clientErrors: 0,
      apiErrors: 0,
      loginErrors: 0,
    };
    current.toolFailures = number(row.tool_failures);
    current.clientErrors = number(row.client_errors);
    current.apiErrors = number(row.api_errors);
    current.loginErrors = number(row.login_errors);
    trendByBucket.set(bucket, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
    alerting: {
      enabled:
        typeof workerStatus.enabled === 'boolean'
          ? workerStatus.enabled
          : alertConfig.global.enabled,
      webhookConfigured,
      shadowMode:
        typeof workerStatus.shadow_mode === 'boolean'
          ? workerStatus.shadow_mode
          : alertConfig.notification.shadowMode || !alertConfig.notification.enabled,
      channel: text(workerStatus.channel, 24) || alertConfig.notification.channel,
      configUpdatedAt: iso(workerStatus.config_updated_at) ?? alertConfig.updatedAt,
      workerVersion: text(workerStatus.worker_version, 24) || null,
      lastCheckedAt: effectiveLastCheckedAt,
      status,
    },
    summary: {
      totalChecks: checks.length,
      healthyChecks: checks.filter((check) => check.status === 'healthy').length,
      observingChecks: checks.filter((check) => check.status === 'observing').length,
      disabledChecks: checks.filter((check) => check.status === 'disabled').length,
      openIncidents,
      criticalIncidents,
      deliveredNotifications: notificationsResult.rows.filter((row) => row.delivered === true)
        .length,
    },
    ai: {
      total: totalRuns,
      completed,
      partial,
      errors: number(run.errors),
      cancelled: number(run.cancelled),
      successRate: totalRuns > 0 ? successful / totalRuns : null,
    },
    signals: {
      toolFailures: number(signal.tool_failures),
      clientErrors: number(signal.client_errors),
      loginSuccess: number(signal.login_success),
      loginRejected: number(signal.login_rejected),
      loginInfrastructureErrors: number(signal.login_errors),
      api5xx: number(signal.api_5xx),
      processErrors: number(signal.process_errors),
      totalEvents: number(signal.total_events),
    },
    evolution,
    checks,
    trend: [...trendByBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    incidents: incidentsResult.rows.map((row) => ({
      key: text(row.alert_key, 120),
      title: text(row.title, 200),
      severity: text(row.severity, 24),
      status: text(row.status, 24),
      summary: text(row.summary, 800),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      resolvedAt: iso(row.resolved_at),
      occurrences: number(row.occurrence_count),
      acknowledgedAt: iso(row.acknowledged_at),
      acknowledgedBy: row.acknowledged_by ? text(row.acknowledged_by, 160) : null,
      assignee: row.assignee ? text(row.assignee, 160) : null,
      silenceUntil: iso(row.silence_until),
      silenceReason: row.silence_reason ? text(row.silence_reason, 400) : null,
    })),
    incidentActivity: incidentActivityResult.rows.map((row) => ({
      occurredAt: iso(row.occurred_at),
      alertKey: text(row.alert_key, 120),
      action: text(row.action, 32),
      actor: text(row.actor, 160),
      summary: text(row.summary, 800),
    })),
    configurationAudit: configurationAuditResult.rows.map((row) => ({
      occurredAt: iso(row.occurred_at),
      actor: text(row.actor, 160),
      action: text(row.action, 64),
      summary: text(row.summary, 800),
    })),
    notifications: notificationsResult.rows.map((row) => ({
      occurredAt: iso(row.occurred_at),
      alertKey: text(row.alert_key, 120),
      transition: text(row.transition, 32),
      severity: text(row.severity, 24),
      delivered: row.delivered === true,
      channel: text(row.channel, 48),
      error: row.error ? text(row.error, 240) : null,
    })),
    events: eventsResult.rows.map((row) => ({
      id: text(row.id, 64),
      occurredAt: iso(row.occurred_at),
      component: text(row.component, 96),
      eventCode: text(row.event_code, 120),
      outcome: text(row.outcome, 32),
      severity: text(row.severity_hint, 24),
      summary: text(row.safe_summary, 500),
      metadata: safeMetadata(row.metadata),
      context: eventContextFromRow(row),
    })),
  };
}

export async function getOpsEventDetail(eventId: string): Promise<OpsEventDetail | null> {
  await ensureOpsEventSchema();
  const p = await pool();
  const eventResult = await p.query(
    `select e.id, e.occurred_at, e.component, e.event_code, e.outcome, e.severity_hint,
            e.safe_summary, e.metadata, e.correlation,
            e.correlation->>'environment' event_environment,
            coalesce(nullif(e.correlation->>'user_id', ''), run.sso_user_id) actor_user_id,
            actor.sso_user_name actor_user_name,
            coalesce(
              nullif(e.correlation->>'client_type', ''),
              run.client_type,
              nullif(e.metadata->>'client_type', '')
            ) context_client_type,
            coalesce(
              nullif(e.correlation->>'channel', ''),
              run.channel,
              nullif(e.metadata->>'channel', '')
            ) context_channel,
            coalesce(
              nullif(e.correlation->>'app_version', ''),
              nullif(run.run_json->>'app_version', ''),
              nullif(e.metadata->>'app_version', '')
            ) context_app_version,
            coalesce(nullif(e.correlation->>'device_id', ''), run.device_id) context_device_id,
            coalesce(nullif(e.correlation->>'device_model', ''), run.device_model) context_device_model,
            coalesce(
              nullif(e.correlation->>'session_id', ''),
              nullif(run.run_json->>'session_id', '')
            ) context_session_id,
            coalesce(
              nullif(e.correlation->>'run_id', ''),
              nullif(e.metadata->>'run_id', '')
            ) context_run_id,
            run.outcome run_outcome,
            run.run_json->>'error_category' run_error_category,
            run.run_json->>'retry_count' run_retry_count,
            run.tool_sequence, run.tool_call_count, run.elapsed_ms,
            run.model, run.started_at, run.completed_at
     from public.studio_ops_events e
     left join lateral (
       select r.sso_user_id, r.device_id, r.device_model, r.channel, r.client_type,
              r.outcome, r.tool_sequence, r.tool_call_count, r.elapsed_ms, r.model,
              r.started_at, r.completed_at, to_jsonb(r) run_json
       from public.agent_run_records r
       where r.run_id = coalesce(
         nullif(e.correlation->>'run_id', ''),
         nullif(e.metadata->>'run_id', '')
       )
${OBSERVABILITY_SCOPED_RUN_JOIN_SQL}
         order by r.created_at desc
         limit 1
     ) run on true
     left join lateral (
       select c.sso_user_name
       from public.conversation_turns c
       where c.sso_user_id = coalesce(
         nullif(e.correlation->>'user_id', ''),
         run.sso_user_id
       )
         and nullif(trim(c.sso_user_name), '') is not null
       order by c.recorded_at desc
       limit 1
     ) actor on true
     where e.id = $1::uuid
     limit 1`,
    [eventId],
  );
  const row = eventResult.rows[0];
  if (!row) return null;

  const userId = String(row.actor_user_id ?? '').trim();
  const sessionId = String(row.context_session_id ?? '').trim();
  let conversation: OpsEventDetail['conversation'] = {
    status: 'missing-correlation',
    turns: [],
  };
  if (userId && sessionId) {
    const conversationResult = await p.query(
      `select recorded_at, user_message, assistant_message, tools_used, outcome
       from public.conversation_turns
       where sso_user_id = $1 and session_id = $2
       order by abs(extract(epoch from (recorded_at - $3::timestamptz))) asc
       limit 3`,
      [userId, sessionId, iso(row.occurred_at) ?? new Date().toISOString()],
    );
    const turns = conversationResult.rows
      .map((turn) => ({
        recordedAt: iso(turn.recorded_at),
        userMessage: text(turn.user_message, 2_400),
        assistantMessage: text(turn.assistant_message, 2_400),
        toolsUsed: safeStringArray(turn.tools_used),
        outcome: text(turn.outcome, 40),
      }))
      .sort((left, right) => String(left.recordedAt).localeCompare(String(right.recordedAt)));
    conversation = {
      status: turns.length ? 'available' : 'not-found',
      turns,
    };
  }

  const runRef = opaqueObservabilityRef(row.context_run_id, 'run');
  // `context_run_id` comes from the event payload and may remain present when
  // the scoped lateral join rejects the run (for example, user/environment
  // mismatch). Do not expose an opaque ref with an otherwise empty run object;
  // that would make an unjoined run look like a valid detail record.
  const hasJoinedRun = [
    row.run_outcome,
    row.started_at,
    row.completed_at,
    row.model,
    row.tool_sequence,
    row.tool_call_count,
    row.elapsed_ms,
  ].some((value) => value !== null && value !== undefined);
  const context = eventContextFromRow(
    hasJoinedRun ? row : { ...row, context_run_id: null },
  );
  return {
    event: {
      id: text(row.id, 64),
      occurredAt: iso(row.occurred_at),
      component: text(row.component, 96),
      eventCode: text(row.event_code, 120),
      outcome: text(row.outcome, 32),
      severity: text(row.severity_hint, 24),
      summary: text(row.safe_summary, 500),
      metadata: safeMetadata(row.metadata),
      environment: normalizeEventEnvironment(row.event_environment),
    },
    context,
    run: runRef && hasJoinedRun
      ? {
          ref: runRef,
          outcome: text(row.run_outcome, 40),
          toolSequence: safeStringArray(row.tool_sequence),
          toolCallCount: number(row.tool_call_count),
          elapsedMs: number(row.elapsed_ms),
          model: text(row.model, 120) || null,
          errorCategory: text(row.run_error_category, 80) || null,
          retryCount: number(row.run_retry_count),
          startedAt: iso(row.started_at),
          completedAt: iso(row.completed_at),
        }
      : null,
    conversation,
  };
}

export async function recordOpsNotificationTest(input: {
  delivered: boolean;
  channel: string;
  error?: string;
}): Promise<void> {
  const p = await pool();
  await p.query(
    `insert into public.studio_alert_notifications
       (alert_key, transition, severity, delivered, channel, error)
     values ('notification-test', 'test', 'warning', $1, $2, $3)`,
    [
      input.delivered,
      text(input.channel, 48) || 'unknown',
      input.error ? text(input.error, 240) : null,
    ],
  );
}
