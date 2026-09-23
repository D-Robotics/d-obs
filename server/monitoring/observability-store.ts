/**
 * 生产可观测看板的数据聚合层。
 *
 * 概览只返回跨租户的低敏感运维信号、聚合计数与不可逆关联引用。对话上下文只能由
 * 运营管理员通过单事件详情接口按需读取，且必须精确匹配账号 + 会话、限量、截断、再次脱敏。
 * 任何接口都不返回 Cookie、Token、密钥、工具参数/结果或原始堆栈。
 */
import {
  ensureOpsEventSchema,
  listTenantOpsEvents,
  sanitizeOpsSummary,
} from './ops-event-store.js';
import { validTenantId } from './tenant-store.js';
import { ALERT_RULE_OBJECT_TARGETS, loadAlertConfig } from './alert-config.js';
import os from 'node:os';
import { ackTimeoutMinutes, MAX_ESCALATIONS_PER_INCIDENT } from './alert-escalation.js';
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
let testPool: Pool | null = null;

/** 回归测试注入点：整体替换默认池解析并重置事故/审计 schema 缓存。 */
export function configureOpsObservabilityPoolForTest(p: Pool | null): void {
  testPool = p;
  incidentSchemaReady = null;
}

async function pool(): Promise<Pool> {
  if (testPool) return testPool;
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

/**
 * 维护窗口路由等平台运营面板入口共享的池访问器：
 * 与 store 内部同一份池（含测试注入语义），调用方拿到后只做有界 SQL。
 */
export async function getOpsObservabilityPool(): Promise<Pool> {
  return pool();
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
  /** null = 平台全局视图；否则为本视图归属（'platform' 或租户 tenantId）。 */
  tenantScope: string | null;
  tenantLabel: string | null;
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
    escalationCount: number;
    lastEscalatedAt: string | null;
    lastNotifiedAt: string | null;
  }>;
  /** 计划内维护窗口（仅平台视图；租户视图恒为空数组）。 */
  maintenanceWindows: Array<{
    id: number;
    scope: 'global' | 'rule';
    alertKey: string;
    startsAt: string;
    endsAt: string;
    reason: string;
    createdBy: string;
    active: boolean;
  }>;
  /** 值班升级链配置回显（仅平台视图）：ack 超时分钟数与每事故最大升级次数。 */
  escalationPolicy: {
    ackTimeoutMinutes: number;
    maxEscalations: number;
  } | null;
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

let incidentObjectBackfillDone = false;

type OpsIncidentAction = 'acknowledge' | 'assign' | 'silence' | 'reopen' | 'close';

function incidentKey(value: string): string {
  const key = String(value ?? '').trim();
  // 命名空间化的租户 key 形如 t.<tenantId>.<checkKey>，点是分隔符。
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(key) || !key.split('.').every(Boolean)) {
    throw new Error('invalid_incident_key');
  }
  return key;
}

export type OpsTenantScope = string | null;

/** 租户视图的空进化面板：每日自我进化属于平台域，不向租户暴露。 */
function emptyEvolutionOverview(): EvolutionOverview {
  return {
    enabled: false,
    cadence: '',
    mode: 'candidate_only',
    workerVersion: '',
    lastRunAt: null,
    nextRunAt: null,
    currentStage: '',
    lastStatus: 'never',
    lastSummary: '租户视图不包含平台自我进化数据',
    evidenceCount: 0,
    readyCandidates: 0,
    gatePassRate: null,
    runs: [],
  };
}

/**
 * 从命名空间化 alert_key 推导归属：t.<tenantId>.* → tenantId；其余 → platform。
 * 只在调用方没有更权威的 scope（如 admin 全局视图操作指定 key）时使用。
 */
export function tenantScopeFromAlertKey(alertKey: string): string {
  const parts = String(alertKey ?? '').split('.');
  // 回验租户 id 形状：只有 createTenant 会写合法 id，但历史/越权写入的行不该被
  // 当成某个（可能不存在的）租户归属。
  if (parts.length >= 3 && parts[0] === 't' && validTenantId(parts[1])) return parts[1];
  return 'platform';
}

function coalesceTenant(alertKey: string): string {
  return tenantScopeFromAlertKey(alertKey);
}

function auditActor(value: string): string {
  const actor = text(value, 160);
  return actor || 'ops-admin';
}

let incidentSchemaReady: Promise<void> | null = null;
/** 探针 ingest 复用同一份告警域 bootstrap（模块自身不 import ingest，无环）。 */
export async function ensureIncidentOperationsSchema(p: Pool): Promise<void> {
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
    `alter table public.studio_alert_incidents add column if not exists object_id text null`,
    `alter table public.studio_alert_incidents add column if not exists resolution_note text null`,
    `alter table public.studio_alert_incidents add column if not exists silence_until timestamptz null`,
    `alter table public.studio_alert_incidents add column if not exists silence_reason text null`,
    `alter table public.studio_alert_incidents add column if not exists tenant_id text not null default 'platform'`,
    // 值班升级链 / 维护窗口：web 端 store 幂等建列（与 alert-escalation.ts /
    // alert-maintenance-windows.ts 的定义一致），保证只跑过老版本 worker
    // （或从没跑过）的库也能出看板、状态页。表结构以维护模块为准，这里只
    // 补 incidents 的两列，避免两份 create table 漂移。
    `alter table public.studio_alert_incidents add column if not exists escalation_count int not null default 0`,
    `alter table public.studio_alert_incidents add column if not exists last_escalated_at timestamptz null`,
    `create index if not exists studio_alert_incidents_tenant_idx on public.studio_alert_incidents (tenant_id)`,
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
    `alter table public.studio_alert_configuration_audit add column if not exists details jsonb null`,
    `create table if not exists public.studio_alert_checks (
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
    )`,
    `alter table public.studio_alert_checks add column if not exists tenant_id text not null default 'platform'`,
    `create index if not exists studio_alert_checks_tenant_idx on public.studio_alert_checks (tenant_id)`,
    `create index if not exists studio_alert_checks_checked_idx
       on public.studio_alert_checks (checked_at desc)`,
    `create table if not exists public.studio_alert_notifications (
      id uuid primary key default gen_random_uuid(),
      occurred_at timestamptz not null default now(),
      alert_key text not null,
      transition text not null,
      severity text not null,
      delivered boolean not null,
      channel text not null,
      error text null,
      attempt_count int not null default 1
    )`,
    `alter table public.studio_alert_notifications add column if not exists tenant_id text not null default 'platform'`,
    `create index if not exists studio_alert_notifications_tenant_idx on public.studio_alert_notifications (tenant_id)`,
    `create index if not exists studio_alert_notifications_occurred_idx
       on public.studio_alert_notifications (occurred_at desc)`,
      ]) {
        await p.query(statement);
      }
      // 事故对象身份回填：按「规则→对象」映射补齐存量事故的 object_id（幂等，只补空值）
      void (async () => {
        const hostTarget = `host/${os.hostname()}`;
        for (const [ruleKey, rawTarget] of Object.entries(ALERT_RULE_OBJECT_TARGETS)) {
          const target = rawTarget === 'host/self' ? hostTarget : rawTarget;
          await p
            .query(
              'update public.studio_alert_incidents set object_id = $1 where alert_key = $2 and object_id is null',
              [target, ruleKey],
            )
            .catch(() => undefined);
        }
      })().catch(() => undefined);
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
  /** Structured, restore-ready snapshot for reversible control-plane changes
   *  (model-pool routing/replacement). Must never contain raw credentials —
   *  callers store a fingerprint instead. */
  details?: unknown;
}): Promise<void> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const details =
    input.details === undefined || input.details === null ? null : JSON.stringify(input.details);
  await p.query(
    `insert into public.studio_alert_configuration_audit (actor, action, summary, details)
     values ($1, $2, $3, $4::jsonb)`,
    [auditActor(input.actor), text(input.action, 64), text(input.summary, 800), details],
  );
}

/** Latest restore-ready snapshot recorded for a control-plane action. Used by
 *  the model-pool rollback endpoint to recover the pre-change target without
 *  storing raw keys anywhere. */
export async function getLatestOpsConfigurationAuditDetails(
  action: string,
  frontendModel: string,
): Promise<{ details: Record<string, unknown> | null; occurredAt: string | null } | null> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const result = await p.query(
    `select details, occurred_at
     from public.studio_alert_configuration_audit
     where action = $1
       and jsonb_typeof(details) = 'object'
       and details->>'frontendModel' = $2
       and jsonb_exists(details, 'previous')
     order by id desc
     limit 5`,
    [text(action, 64), text(frontendModel, 120)],
  );
  for (const row of result.rows) {
    let parsed: unknown = row.details;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        continue;
      }
    }
    if (parsed && typeof parsed === 'object' && parsed !== null) {
      return { details: parsed as Record<string, unknown>, occurredAt: iso(row.occurred_at) };
    }
  }
  return null;
}

export async function updateOpsIncident(
  keyInput: string,
  input: { action: OpsIncidentAction; actor: string; assignee?: string; minutes?: number; reason?: string },
  tenantScope: OpsTenantScope = null,
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
       where alert_key = $1 and coalesce(tenant_id, 'platform') = $3
       returning alert_key`,
      [key, actor, tenantScope ?? coalesceTenant(key)],
    );
  } else if (action === 'assign') {
    const assignee = text(input.assignee, 160);
    if (!assignee) throw new Error('incident_assignee_required');
    summary = `已指派给 ${assignee}`;
    result = await p.query(
      `update public.studio_alert_incidents set assignee = $2
        where alert_key = $1 and coalesce(tenant_id, 'platform') = $3
        returning alert_key`,
      [key, assignee, tenantScope ?? coalesceTenant(key)],
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
       where alert_key = $1 and coalesce(tenant_id, 'platform') = $4
       returning alert_key`,
      [key, minutes, reason, tenantScope ?? coalesceTenant(key)],
    );
  } else if (action === 'close') {
    // 蓝图语义：结案必须沉淀解决方案（等价于他们的"关闭强制填解决方案"），
    // 这是 MTTR 之外的第二份运营资产——复盘时知道每起事故是怎么处置的。
    const resolution = text(input.reason, 500);
    if (resolution.length < 2) throw new Error('incident_resolution_required');
    summary = `已结案：${resolution}`;
    result = await p.query(
      `update public.studio_alert_incidents
       set status = 'resolved', resolved_at = coalesce(resolved_at, now()), resolution_note = $2
       where alert_key = $1 and coalesce(tenant_id, 'platform') = $3
       returning alert_key`,
      [key, resolution, tenantScope ?? coalesceTenant(key)],
    );
  } else {
    summary = '已重新打开事故';
    result = await p.query(
      `update public.studio_alert_incidents
       set status = 'open', acknowledged_at = null, acknowledged_by = null,
           silence_until = null, silence_reason = null, resolved_at = null, resolution_note = null
       where alert_key = $1 and coalesce(tenant_id, 'platform') = $2
       returning alert_key`,
      [key, tenantScope ?? coalesceTenant(key)],
    );
  }
  if (!result.rowCount) throw new Error('incident_not_found');
  await p.query(
    `insert into public.studio_alert_incident_activity (alert_key, action, actor, summary)
     values ($1, $2, $3, $4)`,
    [key, action, actor, summary],
  );
}

/** 告警中心的处置阶段映射：open=待认领，acknowledged/silenced=处理中，resolved=已关闭。 */
function incidentStage(status: string): 'pending' | 'processing' | 'closed' {
  if (status === 'open') return 'pending';
  if (status === 'resolved') return 'closed';
  return 'processing';
}

function mapIncidentRow(row: Record<string, unknown>) {
  const iso = (value: unknown): string | null => {
    const date = value instanceof Date ? value : value ? new Date(String(value)) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  return {
    key: String(row.alert_key ?? ''),
    title: String(row.title ?? ''),
    severity: String(row.severity ?? 'warning'),
    status: String(row.status ?? 'open'),
    stage: incidentStage(String(row.status ?? 'open')),
    summary: String(row.summary ?? ''),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    resolvedAt: iso(row.resolved_at),
    occurrences: Number(row.occurrence_count ?? 1),
    acknowledgedAt: iso(row.acknowledged_at),
    acknowledgedBy: row.acknowledged_by ? text(row.acknowledged_by, 160) : null,
    objectId: row.object_id ? text(row.object_id, 200) : null,
    assignee: row.assignee ? text(row.assignee, 160) : null,
    resolutionNote: row.resolution_note ? text(row.resolution_note, 500) : null,
    silenceUntil: iso(row.silence_until),
    silenceReason: row.silence_reason ? text(row.silence_reason, 400) : null,
    lastNotifiedAt: iso(row.last_notified_at),
  };
}

export type OpsIncidentListQuery = {
  scope?: 'all' | 'mine';
  actor?: string;
  state?: 'active' | 'closed' | 'all';
  severity?: 'critical' | 'warning';
  target?: string;
  days?: number;
  limit?: number;
  offset?: number;
};

/** 告警中心列表：scope=mine 只看与当前操作者相关的（已认领/被指派/已结案留痕）。 */
export async function listOpsIncidents(query: OpsIncidentListQuery = {}): Promise<{
  incidents: ReturnType<typeof mapIncidentRow>[];
  total: number;
}> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const conditions: string[] = [];
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.severity === 'critical' || query.severity === 'warning') {
    conditions.push(`severity = ${push(query.severity)}`);
  }
  if (query.target) {
    conditions.push(`object_id = ${push(query.target)}`);
  }
  if (query.state === 'active') conditions.push(`status in ('open','acknowledged','silenced')`);
  else if (query.state === 'closed') conditions.push(`status = 'resolved'`);
  const days = Math.max(1, Math.min(90, Math.floor(Number(query.days) || 30)));
  conditions.push(`first_seen_at >= now() - make_interval(days => ${push(days)}::int)`);
  if (query.scope === 'mine' && query.actor) {
    const actor = push(query.actor);
    conditions.push(`(acknowledged_by = ${actor} or assignee = ${actor})`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  const limit = Math.max(1, Math.min(200, Math.floor(Number(query.limit) || 50)));
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const [rowsResult, countResult] = await Promise.all([
    p.query(
      `select alert_key, title, severity, status, summary, first_seen_at, last_seen_at,
              resolved_at, occurrence_count, acknowledged_at, acknowledged_by, assignee, object_id,
              resolution_note, silence_until, silence_reason, last_notified_at
       from public.studio_alert_incidents
       ${where}
       order by (status in ('open','acknowledged','silenced')) desc, first_seen_at desc
       limit ${limit} offset ${offset}`,
      params,
    ),
    p.query(`select count(*)::int total from public.studio_alert_incidents ${where}`, params),
  ]);
  return {
    incidents: rowsResult.rows.map((row) => mapIncidentRow(row as Record<string, unknown>)),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

/** 大盘统计：待认领/处理中/已关闭、级别分布、今日新增、MTTA/MTTR（分钟）。 */
export async function getOpsIncidentSummary(days = 7): Promise<{
  pending: number;
  processing: number;
  closed: number;
  todayNew: number;
  criticalActive: number;
  warningActive: number;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  windowDays: number;
}> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const windowDays = Math.max(1, Math.min(90, Math.floor(Number(days) || 7)));
  const result = await p.query(
    `select
       count(*) filter (where status = 'open')::int pending_count,
       count(*) filter (where status in ('acknowledged','silenced'))::int processing_count,
       count(*) filter (where status = 'resolved')::int closed_count,
       count(*) filter (where first_seen_at >= now() - interval '24 hours')::int today_new,
       count(*) filter (where severity = 'critical' and status in ('open','acknowledged','silenced'))::int critical_active,
       count(*) filter (where severity = 'warning' and status in ('open','acknowledged','silenced'))::int warning_active,
       avg(extract(epoch from (acknowledged_at - first_seen_at)))
         filter (where acknowledged_at is not null and first_seen_at >= now() - make_interval(days => $1::int))::double precision avg_ack_seconds,
       avg(extract(epoch from (resolved_at - first_seen_at)))
         filter (where resolved_at is not null and first_seen_at >= now() - make_interval(days => $1::int))::double precision avg_resolve_seconds
     from public.studio_alert_incidents`,
    [windowDays],
  );
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const toMinutes = (value: unknown): number | null => {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds / 60)) : null;
  };
  return {
    pending: Number(row.pending_count ?? 0),
    processing: Number(row.processing_count ?? 0),
    closed: Number(row.closed_count ?? 0),
    todayNew: Number(row.today_new ?? 0),
    criticalActive: Number(row.critical_active ?? 0),
    warningActive: Number(row.warning_active ?? 0),
    mttaMinutes: toMinutes(row.avg_ack_seconds),
    mttrMinutes: toMinutes(row.avg_resolve_seconds),
    windowDays,
  };
}

export async function getOpsObservabilityOverview(
  hoursInput = 24,
  tenantScope: OpsTenantScope = null,
): Promise<OpsObservabilityOverview> {
  const hours = Math.max(1, Math.min(168, Math.floor(Number(hoursInput) || 24)));
  await ensureOpsEventSchema();
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  // 维护窗口表由维护模块自己的 ensure 幂等建（含约束），失败不阻塞总览。
  const { ensureMaintenanceWindowSchema } = await import('./alert-maintenance-windows.js');
  if (!tenantScope) {
    await ensureMaintenanceWindowSchema(p).catch(() => undefined);
  }
  // 平台告警配置只服务于平台视图；租户视图不读它，避免把通道/影子模式等
  // 平台运营配置带进租户响应（与 /config 对租户返回 tenantReadOnly 的收敛一致）。
  const alertConfig = tenantScope ? null : await loadAlertConfig();
  // 作用域 where 片段：admin（null）不加过滤；platform/租户视图只看本归属行。
  // 巡检/事故/通知表都带 tenant_id 列（缺省 'platform'），探针写入时已填好。
  const tWhere = tenantScope ? `where coalesce(tenant_id, 'platform') = $1::text` : '';
  const tIdx = tenantScope ? [tenantScope] : [];
  // 租户视图只看拨测检查，业务信号面板（events/runs/flywheel）不适用，
  // 直接跳过这些查询，避免租户误读平台全局业务数据。
  const tenantScoped = Boolean(tenantScope);
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
    maintenanceWindowsResult,
  ] = await Promise.all([
    p.query(
      `select alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at,
              failure_streak, success_streak
       from public.studio_alert_checks
       ${tenantScope ? 'where coalesce(tenant_id, $1::text) = $2::text' : ''}
       order by active desc, unhealthy desc, severity desc, alert_key`,
      tenantScope ? ['platform', tenantScope] : [],
    ),
    // 租户视图不读平台 worker 单例行：那张表是 d-obs 自身的巡检循环状态，
    // 且承载平台告警配置（通道/影子模式/版本），属于平台运营数据。
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p
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
       from public.studio_alert_incidents
       ${tWhere}`,
      tIdx,
    ),
    p.query(
      `select alert_key, title, severity, status, summary, first_seen_at, last_seen_at,
              resolved_at, occurrence_count, acknowledged_at, acknowledged_by, assignee, object_id,
              silence_until, silence_reason, escalation_count, last_escalated_at, last_notified_at
       from public.studio_alert_incidents
       ${tenantScope ? 'where (last_seen_at >= now() - make_interval(hours => $1::int) or status = \'open\') and coalesce(tenant_id, $3::text) = $2::text' : 'where last_seen_at >= now() - make_interval(hours => $1::int) or status = \'open\''}
       order by (status = 'open') desc, last_seen_at desc
       limit 50`,
      tenantScope ? [hours, tenantScope, 'platform'] : [hours],
    ),
    p.query(
      `select a.occurred_at, a.alert_key, a.action, a.actor, a.summary
       from public.studio_alert_incident_activity a
       where a.occurred_at >= now() - make_interval(hours => $1::int)
         and a.alert_key in (
           select i.alert_key from public.studio_alert_incidents i
            ${tenantScope ? 'where coalesce(i.tenant_id, $2::text) = $3::text' : ''}
         )
       order by a.occurred_at desc
       limit 50`,
      tenantScope ? [hours, 'platform', tenantScope] : [hours],
    ),
    p.query(
      tenantScope
        ? // 租户视图不返回平台配置审计流（含管理员操作记录）。
          `select occurred_at, actor, action, summary
           from public.studio_alert_configuration_audit where false`
        : `select occurred_at, actor, action, summary
           from public.studio_alert_configuration_audit
           where occurred_at >= now() - make_interval(hours => $1::int)
           order by occurred_at desc
           limit 25`,
      tenantScope ? [] : [hours],
    ),
    p.query(
      `select occurred_at, alert_key, transition, severity, delivered, channel, error
       from public.studio_alert_notifications
       where occurred_at >= now() - make_interval(hours => $1::int)
         ${tenantScope ? 'and coalesce(tenant_id, $2::text) = $3::text' : ''}
       order by occurred_at desc
       limit 50`,
      tenantScope ? [hours, 'platform', tenantScope] : [hours],
    ),
    // 运行/事件/进化面板是平台全局业务数据，租户视图不读取也不返回。
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p.query(
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
    ).catch((error) => {
      // agent_run_records 属于被观测系统的业务表，独立部署/全新库可能没有；
      // 缺表时返回空结果而不是让整个看板 500。
      if ((error as { code?: string }).code === '42P01') return { rows: [] };
      throw error;
    }),
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p.query(
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
    ).catch((error) => {
      if ((error as { code?: string }).code === '42P01') return { rows: [] };
      throw error;
    }),
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p.query(
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
         and coalesce(metadata->>'client_type', '') <> 'local-dev'
         -- 平台看板只统计平台自身埋点；租户事件按 tenant_id 隔离，不污染平台错误率。
         and tenant_id = 'platform'`,
      [hours, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
    ),
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p.query(
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
         and tenant_id = 'platform'
       group by 1 order by 1`,
      [hours, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
    ),
    // 租户视图读取该租户自己的事件表（物理隔离表），列形状与平台视图一致，
    // 因此下面的映射无需分叉；平台视图仍然只读平台事件。
    tenantScope
      ? listTenantOpsEvents(tenantScope, hours)
      : p.query(
      `with recent_events as (
         select id, occurred_at, component, event_code, outcome, severity_hint,
                safe_summary, metadata, correlation
         from public.studio_ops_events
         where occurred_at >= now() - make_interval(hours => $1::int)
           and occurred_at <= now() + interval '5 minutes'
           and coalesce(metadata->>'client_type', '') <> 'local-dev'
           and tenant_id = 'platform'
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
    ).catch((error) => {
      // recent_events 联查 agent_run_records / conversation_turns 补上下文；
      // 被观测系统未提供这些业务表时返回空事件流，不影响告警面板。
      if ((error as { code?: string }).code === '42P01') return { rows: [] };
      throw error;
    }),
    tenantScope ? Promise.resolve(null) : getEvolutionOverview(p),
    // 维护窗口与升级策略是平台运营配置：租户视图不读（恒为空）。
    tenantScope
      ? Promise.resolve({ rows: [] })
      : p
          .query(
            `select id, alert_key, starts_at, ends_at, reason, created_by
             from public.studio_alert_maintenance_windows
             where starts_at >= now() - interval '7 days'
             order by starts_at desc
             limit 50`,
          )
          .catch(() => ({ rows: [] })),
  ]);

  const checks = checksResult.rows.map((row) => {
    const enabled = row.enabled !== false;
    const active = row.active === true;
    const unhealthy = row.unhealthy === true;
    const severity = text(row.severity, 24) || 'warning';
    const key = text(row.alert_key, 120);
    const checkedAt = iso(row.checked_at);
    // 平台裸 key `external-*` 与租户命名空间 key `t.<tid>.external-*` 都要做
    // 心跳过期判定，取实际 check 名（最后一段）识别拨测检查。
    const checkName = key.split('.').at(-1) ?? key;
    const externalStale =
      checkName.startsWith('external-') &&
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
  // 租户视图看不到平台 worker 心跳（那是 d-obs 自身的巡检循环），staleness
  // 只由本租户拨测检查的 checked_at 决定；平台视图沿用 worker 优先。
  const effectiveLastCheckedAt = tenantScope
    ? lastCheckedAt
    : workerLastRunAt ?? lastCheckedAt;
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
          alertConfig &&
            (alertConfig.notification.channel === 'feishu'
              ? alertConfig.notification.feishuWebhookUrl
              : alertConfig.notification.webhookUrl),
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
    tenantScope,
    tenantLabel: tenantScope,
    alerting: {
      // 租户视图：alertConfig 为 null 且 worker 行被跳过，因此这里只会拿到
      // 默认值（enabled/shadowMode 按“不对外声明平台配置”处理）。
      enabled:
        typeof workerStatus.enabled === 'boolean'
          ? workerStatus.enabled
          : Boolean(alertConfig?.global.enabled),
      webhookConfigured,
      shadowMode:
        typeof workerStatus.shadow_mode === 'boolean'
          ? workerStatus.shadow_mode
          : Boolean(alertConfig && (alertConfig.notification.shadowMode || !alertConfig.notification.enabled)),
      channel: text(workerStatus.channel, 24) || alertConfig?.notification.channel || '',
      configUpdatedAt: iso(workerStatus.config_updated_at) ?? alertConfig?.updatedAt ?? null,
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
    evolution: evolution ?? emptyEvolutionOverview(),
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
    objectId: row.object_id ? text(row.object_id, 200) : null,
      assignee: row.assignee ? text(row.assignee, 160) : null,
      silenceUntil: iso(row.silence_until),
      silenceReason: row.silence_reason ? text(row.silence_reason, 400) : null,
      escalationCount: number(row.escalation_count),
      lastEscalatedAt: iso(row.last_escalated_at),
      lastNotifiedAt: iso(row.last_notified_at),
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
    maintenanceWindows: tenantScope
      ? []
      : maintenanceWindowsResult.rows.map((row) => {
          const startsAt = iso(row.starts_at);
          const endsAt = iso(row.ends_at);
          const now = Date.now();
          return {
            id: number(row.id),
            scope: (row.alert_key ? 'rule' : 'global') as 'global' | 'rule',
            alertKey: text(row.alert_key, 160),
            startsAt: startsAt ?? '',
            endsAt: endsAt ?? '',
            reason: text(row.reason, 400),
            createdBy: text(row.created_by, 160),
            active: Boolean(
              startsAt &&
                endsAt &&
                Date.parse(startsAt) <= now &&
                Date.parse(endsAt) > now,
            ),
          };
        }),
    escalationPolicy: tenantScope
      ? null
      : {
          ackTimeoutMinutes: ackTimeoutMinutes(),
          maxEscalations: MAX_ESCALATIONS_PER_INCIDENT,
        },
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
       -- 事件详情/行动证据校验只认平台事件：租户事件已按 tenant_id 归档，
       -- 但尚未有面向租户的展示面，不允许它们出现在平台证据链里。
       and e.tenant_id = 'platform'
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

/** 事故关联：按 alert_key 取单条告警事故（不存在返回 null）。 */
export async function getOpsIncident(alertKey: string): Promise<{
  alertKey: string;
  title: string;
  severity: string;
  status: string;
  summary: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  resolvedAt: string | null;
} | null> {
  const p = await pool();
  await ensureIncidentOperationsSchema(p);
  const result = await p.query(
    `select alert_key, title, severity, status, coalesce(summary, '') summary,
            first_seen_at, last_seen_at, resolved_at
     from public.studio_alert_incidents where alert_key = $1`,
    [text(alertKey, 160)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    alertKey: String(row.alert_key ?? ''),
    title: String(row.title ?? ''),
    severity: String(row.severity ?? ''),
    status: String(row.status ?? ''),
    summary: String(row.summary ?? ''),
    firstSeenAt: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at ?? ''),
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : null,
    resolvedAt: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : null,
  };
}
