/**
 * d-obs 运维事件旁路。
 *
 * 这里只保存告警计算需要的低敏感结构化信号，严禁写入用户提示词、工具参数/结果、
 * Cookie、Token、密钥或原始堆栈。账号/会话/设备标识仅允许进入受运营权限保护的 correlation
 * 字段，用于按需关联既有归档；概览接口必须只返回不可逆引用，不能回传原始标识。
 * 写入失败永远不能影响登录、AI 或 API 主链路。
 */
import { createHash } from 'node:crypto';
import { sanitizeClientErrorLocations } from '../../shared/client-error-location-redaction.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

export type OpsEventOutcome = 'ok' | 'error' | 'rejected' | 'degraded';
export type OpsEventSeverityHint = 'info' | 'warning' | 'critical';

export interface OpsEventCorrelation {
  userId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  deviceId?: string | null;
  deviceModel?: string | null;
  clientType?: string | null;
  channel?: string | null;
  /** 客户端自报版本（semver）；仅遥测归因用，不参与权限判断。 */
  appVersion?: string | null;
  /**
   * Deployment environment is always overwritten with the server-derived
   * value by the sanitizer.  It is retained in correlation (rather than only
   * metadata) so event→run joins use the same scoped tuple as unified traces.
   */
  environment?: string | null;
}

/**
 * 读取某个租户最近的租户事件（`studio_ops_events_tenant`），供租户视图展示。
 *
 * 返回的列与平台视图的事件查询保持一致（同为 snake_case 原始行），这样
 * observability-store 的既有映射可以原样复用，不需要第二套字段转换。
 * 只按 `tenant_id` 过滤——调用方传入的 tenantScope 来自服务端解析的身份，
 * 因此租户之间不会互见。
 */
export async function listTenantOpsEvents(
  tenantId: string,
  hours: number,
  limit = 50,
): Promise<{ rows: Array<Record<string, unknown>> }> {
  const tenant = resolveOpsEventTenantId({ tenantId: String(tenantId ?? '').trim() });
  if (tenant === OPS_EVENT_PLATFORM_TENANT) return { rows: [] };
  const windowHours = Math.max(1, Math.min(168, Math.floor(Number(hours) || 24)));
  const maxRows = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  await ensureOpsEventSchema();
  const p = await pool();
  try {
    return await p.query(
      `select id, occurred_at, component, event_code, outcome, severity_hint,
              safe_summary, metadata, correlation
         from public.${OPS_EVENT_TENANT_TABLE}
        where tenant_id = $1
          and occurred_at >= now() - make_interval(hours => $2::int)
          and occurred_at <= now() + interval '5 minutes'
        order by occurred_at desc
        limit $3`,
      [tenant, windowHours, maxRows],
    );
  } catch (error) {
    // 全新库首份租户事件到达前没有这张表：租户看板应显示空事件列表而不是 500。
    if ((error as { code?: string }).code === '42P01') return { rows: [] };
    throw error;
  }
}

export interface OpsEventInput {
  /**
   * 归属租户：'platform' = 平台自身埋点，其它 = 该租户探针上报。
   * 由摄取层用 token 解析出的身份填入，**不接受事件正文里的同名声明**。
   */
  tenantId?: string;
  component: string;
  eventCode: string;
  outcome: OpsEventOutcome;
  severityHint?: OpsEventSeverityHint;
  safeSummary?: string;
  fingerprintParts?: Array<string | number | null | undefined>;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  correlation?: OpsEventCorrelation;
  occurredAt?: string;
  dedupeWithinMs?: number;
}

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

export function isOpsEventStoreConfigured(): boolean {
  return centralDbUrl().length > 0;
}

let poolReady: Promise<Pool> | null = null;
let testPool: Pool | null = null;

/**
 * 回归测试注入点：整体替换默认池解析并重置 schema 缓存。
 * 与 tenant-store / observability-store 同款接缝——没有它，任何走到
 * `ensureOpsEventSchema` 的集成测试都会去构造真实 pg 池并连库失败。
 */
export function configureOpsEventPoolForTest(p: Pool | null): void {
  testPool = p;
  schemaReady = null;
}

async function pool(): Promise<Pool> {
  if (testPool) return testPool;
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

let schemaReady: Promise<void> | null = null;
export async function ensureOpsEventSchema(): Promise<void> {
  if (!isOpsEventStoreConfigured()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = await pool();
      // 租户事件表：结构与平台表一致，多一个非空 tenant_id（不带默认值，避免
      // 误写平台归属）。它只由 d-obs 的事件摄取写入。
      await p.query(`
        create table if not exists public.${OPS_EVENT_TENANT_TABLE} (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null,
          component text not null,
          event_code text not null,
          outcome text not null,
          severity_hint text not null default 'warning',
          fingerprint text not null,
          safe_summary text null,
          metadata jsonb not null default '{}'::jsonb,
          correlation jsonb not null default '{}'::jsonb,
          tenant_id text not null,
          created_at timestamptz not null default now()
        )
      `);
      await p.query(
        `create index if not exists ${OPS_EVENT_TENANT_TABLE}_tenant_time_idx
         on public.${OPS_EVENT_TENANT_TABLE} (tenant_id, occurred_at desc)`,
      );
      await p.query(
        `create index if not exists ${OPS_EVENT_TENANT_TABLE}_code_outcome_idx
         on public.${OPS_EVENT_TENANT_TABLE} (event_code, outcome, occurred_at desc)`,
      );
      await p.query(`
        create table if not exists public.studio_ops_events (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null,
          component text not null,
          event_code text not null,
          outcome text not null,
          severity_hint text not null default 'warning',
          fingerprint text not null,
          safe_summary text null,
          metadata jsonb not null default '{}'::jsonb,
          correlation jsonb not null default '{}'::jsonb,
          tenant_id text not null default 'platform',
          created_at timestamptz not null default now()
        )
      `);
      await p.query(
        `alter table public.studio_ops_events
         add column if not exists correlation jsonb not null default '{}'::jsonb`,
      );
      // 旧库升级：历史行没有租户归属，一律归 platform（它们确实是平台时期写入的）。
      await p.query(
        `alter table public.studio_ops_events
         add column if not exists tenant_id text not null default 'platform'`,
      );
      await p.query(
        `create index if not exists studio_ops_events_tenant_idx
         on public.studio_ops_events (tenant_id, occurred_at desc)`,
      );
      await p.query(
        `create index if not exists studio_ops_events_occurred_idx
         on public.studio_ops_events (occurred_at desc)`,
      );
      await p.query(
        `create index if not exists studio_ops_events_code_outcome_idx
         on public.studio_ops_events (event_code, outcome, occurred_at desc)`,
      );
      await p.query(
        `create index if not exists studio_ops_events_fingerprint_idx
         on public.studio_ops_events (fingerprint, occurred_at desc)`,
      );
      await p.query(
        `create index if not exists studio_ops_events_run_correlation_idx
         on public.studio_ops_events ((correlation->>'run_id'))
         where correlation->>'run_id' is not null`,
      );
      await p.query(
        `create index if not exists studio_ops_events_user_correlation_idx
         on public.studio_ops_events ((correlation->>'user_id'), occurred_at desc)
         where correlation->>'user_id' is not null`,
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(api[_-]?key|token|secret|password|authorization|cookie|set-cookie|x-rdk-sso-session|ccSid|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token)\s*[:=]\s*["']?[^,\s;"']+/gi,
  /\b(?:eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sb_secret_[A-Za-z0-9_-]{8,})\b/gi,
  /(?:postgres(?:ql)?|mysql|redis):\/\/[^@\s/]+@/gi,
  /([?&](?:token|key|secret|signature|sign|password|access_token|session)=)[^&#\s]+/gi,
  /\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+/gi,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
];

const DIRECT_IDENTIFIER_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b1\d{10}\b/g,
];

function redactWithPatterns(value: string, patterns: RegExp[]): string {
  let text = value;
  for (const pattern of patterns) {
    text = text.replace(pattern, (_match, rawLabel?: string | number) => {
      // RegExp replacers without a capture group receive the numeric match
      // offset as their second argument. Treat only an actual string capture
      // as a label, otherwise offsets such as "7=[REDACTED]" leak into output.
      const label = typeof rawLabel === 'string' ? rawLabel : '';
      if (!label) return '[REDACTED]';
      return `${label}${/[=:]$/.test(label) ? '' : '='}[REDACTED]`;
    });
  }
  return text;
}

export function sanitizeOpsSummary(value: unknown, maxLength = 500): string {
  let text = (value instanceof Error ? value.message : String(value ?? '')).slice(0, 8_192);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  text = sanitizeClientErrorLocations(text);
  text = redactWithPatterns(text, CREDENTIAL_PATTERNS);
  text = redactWithPatterns(text, DIRECT_IDENTIFIER_PATTERNS);
  return text.slice(0, Math.max(0, maxLength));
}

function safeSlug(value: unknown, fallback: string): string {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return slug || fallback;
}

function safeMetadata(
  metadata: OpsEventInput['metadata'],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata ?? {}).slice(0, 32)) {
    const key = safeSlug(rawKey, '').slice(0, 64);
    if (!key || rawValue === undefined) continue;
    if (typeof rawValue === 'string') out[key] = sanitizeOpsSummary(rawValue, 240);
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) out[key] = rawValue;
    else if (typeof rawValue === 'boolean' || rawValue === null) out[key] = rawValue;
  }
  return out;
}

function safeCorrelationValue(
  value: unknown,
  maxLength: number,
  options: { preserveDirectIdentifier?: boolean } = {},
): string {
  let text = String(value ?? '')
    .slice(0, 8_192)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = redactWithPatterns(text, CREDENTIAL_PATTERNS);
  if (!options.preserveDirectIdentifier) {
    text = redactWithPatterns(text, DIRECT_IDENTIFIER_PATTERNS);
  }
  return text.slice(0, Math.max(0, maxLength));
}

export function sanitizeOpsEventCorrelation(
  correlation: OpsEventCorrelation | undefined,
): Record<string, string> {
  const source: Record<keyof OpsEventCorrelation, unknown> = {
    userId: correlation?.userId,
    sessionId: correlation?.sessionId,
    runId: correlation?.runId,
    deviceId: correlation?.deviceId,
    deviceModel: correlation?.deviceModel,
    clientType: correlation?.clientType,
    channel: correlation?.channel,
    appVersion: correlation?.appVersion,
    // Never trust a producer/body supplied environment.  The observability
    // store resolves it from process configuration and NODE_ENV instead.
    environment: resolveStudioTraceStoreEnvironment(),
  };
  const out: Record<string, string> = {};
  const keys: Array<[keyof OpsEventCorrelation, string, number]> = [
    ['userId', 'user_id', 240],
    ['sessionId', 'session_id', 240],
    ['runId', 'run_id', 200],
    ['deviceId', 'device_id', 200],
    ['deviceModel', 'device_model', 160],
    ['clientType', 'client_type', 32],
    ['channel', 'channel', 64],
    ['appVersion', 'app_version', 64],
  ];
  for (const [inputKey, outputKey, maxLength] of keys) {
    // userId comes from the authenticated server session and may legitimately be
    // an email/phone account identifier. Every other correlation value can be
    // supplied by telemetry clients, so direct identifiers are redacted there.
    // Credential-shaped content is redacted for all fields.
    const value = safeCorrelationValue(source[inputKey], maxLength, {
      preserveDirectIdentifier: inputKey === 'userId',
    });
    if (value) out[outputKey] = value;
  }
  out.environment = resolveStudioTraceStoreEnvironment();
  return out;
}

export function buildOpsEventFingerprint(input: OpsEventInput): string {
  const parts = [
    // 租户进指纹：否则知道目标指纹的租户可以预置一行，把平台/别家的同名事件
    // 在去重窗口内压掉（跨租户事件压制）。
    resolveOpsEventTenantId(input),
    safeSlug(input.component, 'unknown'),
    safeSlug(input.eventCode, 'unknown'),
    input.outcome,
    ...(input.fingerprintParts ?? []).map((part) => safeSlug(part, '')),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

/**
 * 事件归属租户。摄取层用探针 token 解析出的身份传入；缺省/非法值一律归
 * `platform`，保证「没有明确租户身份的事件不会被误算进某个租户」。
 * 与租户 id 规则保持一致（小写字母开头、字母数字连字符、2-40 字符）。
 */
const OPS_EVENT_TENANT_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function resolveOpsEventTenantId(input: Pick<OpsEventInput, 'tenantId'>): string {
  const raw = String(input?.tenantId ?? '').trim();
  return OPS_EVENT_TENANT_PATTERN.test(raw) ? raw : 'platform';
}

/**
 * 事件物理隔离。
 *
 * 平台事件与租户事件**分表存放**，而不是靠每个读取方记得加 `tenant_id` 过滤：
 * 读 `studio_ops_events` 的消费者不止本仓库——线上告警规则评估跑在主站部署
 * （`/opt/rdstudio-web-opt/.../studio-alert-worker.js`），它的同一份逻辑没有
 * 租户过滤，且改动它意味着改主站代码并发布业务站。分表之后，任何既有消费者
 * （主站 worker、主站看板、flywheel 指标）读到的天然只有平台事件，隔离由存储
 * 结构保证，不依赖跨仓库协同。README/docs/event-ingest.md 有说明。
 *
 * `tenant_id` 列仍然保留并继续写入：平台表里它恒为 'platform'，作为纵深防御
 * （即使将来有人在平台表里混入租户行，读取侧的过滤仍能挡住）。
 */
export const OPS_EVENT_PLATFORM_TABLE = 'studio_ops_events';
export const OPS_EVENT_TENANT_TABLE = 'studio_ops_events_tenant';

/** 归属决定落到哪张表：platform → 平台表，其它 → 租户表。 */
export function opsEventTableForTenant(tenantId: unknown): string {
  return resolveOpsEventTenantId({ tenantId: String(tenantId ?? '').trim() }) === OPS_EVENT_PLATFORM_TENANT
    ? OPS_EVENT_PLATFORM_TABLE
    : OPS_EVENT_TENANT_TABLE;
}

/** 平台归属判定（供平台看板/告警规则复用，避免各处硬编码字面量）。 */
export const OPS_EVENT_PLATFORM_TENANT = 'platform';

/**
 * 写入一条低敏感运维事件。返回值只供测试/诊断；业务调用应 fire-and-forget。
 */
export async function recordOpsEvent(input: OpsEventInput): Promise<boolean> {
  if (!isOpsEventStoreConfigured()) return false;
  try {
    await ensureOpsEventSchema();
    const p = await pool();
    const tenantId = resolveOpsEventTenantId(input);
    // 租户事件落独立表：平台侧任何消费者（含其它部署）无需过滤即天然隔离。
    const table = opsEventTableForTenant(tenantId);
    const fingerprint = buildOpsEventFingerprint(input);
    const correlation = sanitizeOpsEventCorrelation(input.correlation);
    const dedupeWithinMs = Math.max(
      0,
      Math.min(60 * 60_000, Math.floor(Number(input.dedupeWithinMs) || 0)),
    );
    if (dedupeWithinMs > 0) {
      const recent = await p.query(
        `select 1
         from public.${table}
         where fingerprint = $1
           and occurred_at >= now() - make_interval(secs => $2::double precision)
           and coalesce(correlation->>'user_id', '') = $3
           and tenant_id = $4
         limit 1`,
        [fingerprint, dedupeWithinMs / 1_000, correlation.user_id ?? '', tenantId],
      );
      if (recent.rows.length > 0) return true;
    }
    await p.query(
      `insert into public.${table}
         (occurred_at, component, event_code, outcome, severity_hint, fingerprint, safe_summary, metadata, correlation, tenant_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        input.occurredAt && Number.isFinite(Date.parse(input.occurredAt))
          ? input.occurredAt
          : new Date().toISOString(),
        safeSlug(input.component, 'unknown'),
        safeSlug(input.eventCode, 'unknown'),
        input.outcome,
        input.severityHint ?? (input.outcome === 'error' ? 'warning' : 'info'),
        fingerprint,
        input.safeSummary ? sanitizeOpsSummary(input.safeSummary) : null,
        JSON.stringify(safeMetadata(input.metadata)),
        JSON.stringify(correlation),
        tenantId,
      ],
    );
    return true;
  } catch (error) {
    if (String(process.env.RDK_ALERT_LOG_ERRORS ?? '').trim() === '1') {
      console.warn(
        '[ops-events] insert failed:',
        error instanceof Error ? sanitizeOpsSummary(error.message, 240) : 'unknown',
      );
    }
    return false;
  }
}
