/**
 * 账号行为视角（只读聚合）：按 SSO 账号检索其跨表行为足迹。
 *
 * 标识锚 = sso_user_id（agent_run_records / conversation_turns /
 * studio_daily_usage / credit_account 四表统一归账键，north-star 同源）；
 * 输入若不是任何账号的 id，先经 conversation_turns.sso_user_name 反查 id。
 * 配置审计与事故处置流水按 actor 精确匹配（actor 落库经 PII 脱敏，邮箱
 * 一律为 '[REDACTED]'——按邮箱检索命中不了是纪律的边界，不是缺陷）。
 *
 * 全部只读、逐源 fail-soft（表不存在/库异常显式标 unavailable，不拖垮整体）；
 * 不返回对话正文与消息内容，只返回行为元数据。
 */
type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

export interface AccountSourceAvailability {
  status: 'ok' | 'partial' | 'unavailable';
  successfulQueries: number;
  failedQueries: number;
  errorCodes?: string[];
}
export interface AccountTimeWindow {
  hours: number;
  from: string;
  to: string;
  precision: 'timestamp';
}

export interface AccountActivityReport {
  identifier: string;
  /** 实际参与聚合的账号 id（含 name 反查得到的别名 id）。 */
  resolvedIds: string[];
  timeWindow: AccountTimeWindow;
  sourceAvailability: Record<string, AccountSourceAvailability>;
  dataCompleteness: 'complete' | 'partial';
  warnings: string[];
  registrationScope: 'all_history';
  registeredAt: string | null;
  registeredSource: string | null;
  runs: {
    total: number;
    errors: number;
    totalTokens: number;
    lastStartedAt: string | null;
    recent: Array<Record<string, unknown>>;
  };
  turns: {
    total: number;
    errors: number;
    lastRecordedAt: string | null;
    recent: Array<Record<string, unknown>>;
  };
  usage: { activeDays: number; firstDay: string | null; lastDay: string | null;
    precision: 'day'; fromDay: string | null; toDay: string | null; timeZone: string | null };
  configAudit: Array<Record<string, unknown>>;
  /** 登录/退出记录（与配置变更同表但语义不同，拆开呈现）。 */
  loginAudit: Array<Record<string, unknown>>;
  incidentActivity: Array<Record<string, unknown>>;
  opsEvents: Array<Record<string, unknown>>;
}

function timeWindow(hours: number): AccountTimeWindow {
  const to = Date.now();
  return { hours, from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString(), precision: 'timestamp' };
}

function emptyReport(identifier: string, resolvedIds: string[], window: AccountTimeWindow): AccountActivityReport {
  return {
    identifier,
    resolvedIds,
    timeWindow: window,
    sourceAvailability: {},
    dataCompleteness: 'complete',
    warnings: [],
    registrationScope: 'all_history',
    registeredAt: null,
    registeredSource: null,
    runs: { total: 0, errors: 0, totalTokens: 0, lastStartedAt: null, recent: [] },
    turns: { total: 0, errors: 0, lastRecordedAt: null, recent: [] },
    usage: { activeDays: 0, firstDay: null, lastDay: null, precision: 'day', fromDay: null, toDay: null, timeZone: null },
    configAudit: [],
    loginAudit: [],
    incidentActivity: [],
    opsEvents: [],
  };
}

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : value ? new Date(String(value)) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

class AccountQuerySources {
  readonly availability: Record<string, AccountSourceAvailability> = {};
  constructor(private readonly p: Pool) {}
  async query(source: string, sql: string, params: unknown[]): Promise<PgQueryResult | null> {
    const state = this.availability[source] ??= { status: 'ok', successfulQueries: 0, failedQueries: 0 };
    try {
      const result = await this.p.query(sql, params);
      state.successfulQueries++;
      state.status = state.failedQueries ? 'partial' : 'ok';
      return result;
    } catch (error) {
      const rawCode = (error as { code?: unknown } | null)?.code;
      const errorCode = typeof rawCode === 'string' && /^[A-Z0-9]{5}$/.test(rawCode) ? rawCode : 'account_source_unavailable';
      state.failedQueries++;
      state.status = state.successfulQueries ? 'partial' : 'unavailable';
      state.errorCodes = [...new Set([...(state.errorCodes ?? []), errorCode])];
      // Never return or log the SQL message: it may echo an account or secret.
      if (rawCode !== '42P01') console.warn('[account-activity] source unavailable:', source, errorCode);
      return null;
    }
  }
  metadata() {
    const partial = Object.values(this.availability).some((source) => source.status !== 'ok');
    return { sourceAvailability: this.availability, dataCompleteness: partial ? 'partial' as const : 'complete' as const,
      warnings: partial ? ['部分数据源不可用；这些来源的空列表或零值是兼容占位，不能解释为没有活动。'] : [] };
  }
}

/** 解析账号 id 集合：输入 id 恒在内；用户名经 conversation_turns 反查合并。 */
async function resolveAccountIds(sources: AccountQuerySources, identifier: string): Promise<string[]> {
  const resolved = new Set<string>([identifier]);
  const nameMatch = await sources.query(
    'accountResolution',
    `select distinct nullif(trim(sso_user_id), '') as sso_user_id
       from public.conversation_turns
      where sso_user_name = $1::text and sso_user_id is not null
      limit 5`,
    [identifier],
  );
  for (const row of nameMatch?.rows ?? []) {
    const id = String(row.sso_user_id ?? '').trim();
    if (id) resolved.add(id);
  }
  return [...resolved];
}

/**
 * 聚合某账号（或用户名）在时间窗内的行为足迹。hours ∈ [1, 8760]。
 * 每源 limit 收敛，避免单账号超大历史拖垮响应。
 */
export async function getAccountActivity(
  p: Pool,
  identifierRaw: string,
  hoursInput = 168,
): Promise<AccountActivityReport> {
  const identifier = String(identifierRaw ?? '').trim().slice(0, 120);
  if (!identifier) throw new Error('account_identifier_required');
  const hours = Math.max(1, Math.min(8_760, Math.floor(Number(hoursInput) || 168)));
  const window = timeWindow(hours);
  const sources = new AccountQuerySources(p);
  const report = emptyReport(identifier, [identifier], window);

  // 名字 → id 反查（仅当按 name 记账的表里能找到映射）。
  const nameMatch = await sources.query(
    'accountResolution',
    `select distinct nullif(trim(sso_user_id), '') as sso_user_id
       from public.conversation_turns
      where sso_user_name = $1::text and sso_user_id is not null
      limit 5`,
    [identifier],
  );
  const resolved = new Set<string>([identifier]);
  for (const row of nameMatch?.rows ?? []) {
    const id = String(row.sso_user_id ?? '').trim();
    if (id) resolved.add(id);
  }
  report.resolvedIds = [...resolved];
  const ids = report.resolvedIds;

  // 注册账本：最早账号创建时间与来源。
  const registered = await sources.query(
    'registration',
    `select min(created_at) as created_at, min(source) as source
       from public.credit_account
      where nullif(trim(sso_user_id), '') = any($1::text[])`,
    [ids],
  );
  report.registeredAt = iso(registered?.rows[0]?.created_at);
  report.registeredSource = registered?.rows[0]?.source
    ? String(registered.rows[0].source)
    : null;

  // Agent Run 行为：总量/错误/token/最近 20 条（元数据，不含 prompt/正文）。
  const runsSummary = await sources.query(
    'runs',
    `select count(*)::int total,
            count(*) filter (where outcome = 'error')::int errors,
            coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0)::bigint total_tokens,
            max(started_at) as last_started_at
       from public.agent_run_records
      where nullif(trim(sso_user_id), '') = any($1::text[])
        and started_at >= $2::timestamptz and started_at <= $3::timestamptz`,
    [ids, window.from, window.to],
  );
  report.runs.total = Number(runsSummary?.rows[0]?.total ?? 0);
  report.runs.errors = Number(runsSummary?.rows[0]?.errors ?? 0);
  report.runs.totalTokens = Number(runsSummary?.rows[0]?.total_tokens ?? 0);
  report.runs.lastStartedAt = iso(runsSummary?.rows[0]?.last_started_at);
  const runsRecent = await sources.query(
    'runs',
    `select run_id,
            to_jsonb(r)->>'environment' environment,
            outcome, error_category, started_at, completed_at, elapsed_ms,
            coalesce(prompt_tokens, 0) prompt_tokens, coalesce(completion_tokens, 0) completion_tokens,
            model, channel, client_type, device_id, session_id
       from public.agent_run_records r
      where nullif(trim(sso_user_id), '') = any($1::text[])
        and started_at >= $2::timestamptz and started_at <= $3::timestamptz
      order by started_at desc
      limit 20`,
    [ids, window.from, window.to],
  );
  report.runs.recent = runsRecent?.rows ?? [];

  // 对话轮次：只给元数据（时间/渠道/结果/工具数），不给正文。
  const turnsSummary = await sources.query(
    'turns',
    `select count(*)::int total,
            count(*) filter (where outcome <> 'completed')::int errors,
            max(recorded_at) as last_recorded_at
       from public.conversation_turns
      where nullif(trim(sso_user_id), '') = any($1::text[])
        and recorded_at >= $2::timestamptz and recorded_at <= $3::timestamptz`,
    [ids, window.from, window.to],
  );
  report.turns.total = Number(turnsSummary?.rows[0]?.total ?? 0);
  report.turns.errors = Number(turnsSummary?.rows[0]?.errors ?? 0);
  report.turns.lastRecordedAt = iso(turnsSummary?.rows[0]?.last_recorded_at);
  const turnsRecent = await sources.query(
    'turns',
    `select recorded_at, channel, outcome, error_detail, session_id,
            coalesce(array_length(tools_used, 1), 0) tools_count, app_version
       from public.conversation_turns
      where nullif(trim(sso_user_id), '') = any($1::text[])
        and recorded_at >= $2::timestamptz and recorded_at <= $3::timestamptz
      order by recorded_at desc
      limit 15`,
    [ids, window.from, window.to],
  );
  report.turns.recent = turnsRecent?.rows ?? [];

  // 活跃天数（与 north-star 活跃口径同源）。
  const usage = await sources.query(
    'usage',
    `select count(distinct usage_date)::int active_days,
            min(usage_date)::text first_day, max(usage_date)::text last_day,
            $2::timestamptz::date::text from_day, $3::timestamptz::date::text to_day,
            current_setting('TimeZone') as time_zone
       from public.studio_daily_usage
      where nullif(trim(sso_user_id), '') = any($1::text[])
        and usage_date >= $2::timestamptz::date and usage_date <= $3::timestamptz::date`,
    [ids, window.from, window.to],
  );
  report.usage.activeDays = Number(usage?.rows[0]?.active_days ?? 0);
  report.usage.firstDay = usage?.rows[0]?.first_day ? String(usage.rows[0].first_day) : null;
  report.usage.lastDay = usage?.rows[0]?.last_day ? String(usage.rows[0].last_day) : null;
  report.usage.fromDay = usage?.rows[0]?.from_day ? String(usage.rows[0].from_day) : null;
  report.usage.toDay = usage?.rows[0]?.to_day ? String(usage.rows[0].to_day) : null;
  report.usage.timeZone = usage?.rows[0]?.time_zone ? String(usage.rows[0].time_zone) : null;

  // 配置审计（剔除登录噪音）+ 登录记录 + 事故处置流水：actor 是邮箱/姓名/
  // 账本文本（写侧已脱敏）。sso_login/sso_logout 是会话事件不是配置变更，
  // 混在一起会淹没真实变更（生产实测 lx199710 首行即登录）。
  const actorMatch = await sources.query(
    'configAudit',
    `select occurred_at, action, summary
       from public.studio_alert_configuration_audit
      where actor = any($1::text[])
        and occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz
        and action not in ('sso_login', 'sso_logout')
      order by occurred_at desc
      limit 20`,
    [ids, window.from, window.to],
  );
  report.configAudit = actorMatch?.rows ?? [];
  const loginAudit = await sources.query(
    'loginAudit',
    `select occurred_at, action
       from public.studio_alert_configuration_audit
      where actor = any($1::text[])
        and occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz
        and action in ('sso_login', 'sso_logout')
      order by occurred_at desc
      limit 10`,
    [ids, window.from, window.to],
  );
  report.loginAudit = loginAudit?.rows ?? [];
  const incidentActivity = await sources.query(
    'incidentActivity',
    `select occurred_at, alert_key, action, summary
       from public.studio_alert_incident_activity
      where actor = any($1::text[])
        and occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz
      order by occurred_at desc
      limit 20`,
    [ids, window.from, window.to],
  );
  report.incidentActivity = incidentActivity?.rows ?? [];

  // 平台事件流水：身份在 metadata/correlation jsonb 的 sso_user_id。
  const opsEvents = await sources.query(
    'opsEvents',
    `select occurred_at, component, event_code, outcome, safe_summary
       from public.studio_ops_events
      where occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz
        and (metadata->>'sso_user_id' = any($1::text[])
          or correlation->>'sso_user_id' = any($1::text[]))
      order by occurred_at desc
      limit 15`,
    [ids, window.from, window.to],
  );
  report.opsEvents = opsEvents?.rows ?? [];
  Object.assign(report, sources.metadata());
  return report;
}

export interface AccountEventLog {
  identifier: string;
  resolvedIds: string[];
  timeWindow: AccountTimeWindow;
  sourceAvailability: Record<string, AccountSourceAvailability>;
  dataCompleteness: 'complete' | 'partial';
  warnings: string[];
  /** 窗口内该账号出现过的事件类型（供前端筛选下拉）。 */
  codes: Array<{ eventCode: string; total: number }>;
  events: Array<Record<string, unknown>>;
}

/**
 * 事件日志明细下钻：相对概览的 15 条收口放开到 ≤200 条，可按事件类型筛选。
 * 归账双通道：①事件直接携带 sso_user_id；②事件带 session_id 时经
 * agent_run_records / conversation_turns 反查归属（生产事件上报方目前不打
 * sso_user_id 标签，session 桥接是主要出数通道）。与 getAccountActivity
 * 同一套标识解析与 fail-soft 语义。
 */
export async function getAccountEventLog(
  p: Pool,
  identifierRaw: string,
  hoursInput = 168,
  options: { limit?: number; eventCode?: string } = {},
): Promise<AccountEventLog> {
  const identifier = String(identifierRaw ?? '').trim().slice(0, 120);
  if (!identifier) throw new Error('account_identifier_required');
  const hours = Math.max(1, Math.min(8_760, Math.floor(Number(hoursInput) || 168)));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 200)));
  const eventCode = String(options.eventCode ?? '').trim().slice(0, 80);
  const window = timeWindow(hours);
  const sources = new AccountQuerySources(p);
  const ids = await resolveAccountIds(sources, identifier);
  // session 桥接：该账号最近 50 个已存在会话（run/turn 两表），供窗口内事件归账。
  const sessionMatch = await sources.query(
    'sessionCorrelation',
    `select session_id, max(at) as last_at from (
       select nullif(trim(session_id), '') as session_id, started_at as at
         from public.agent_run_records
        where nullif(trim(sso_user_id), '') = any($1::text[]) and session_id is not null
       union all
       select nullif(trim(session_id), ''), recorded_at
         from public.conversation_turns
        where nullif(trim(sso_user_id), '') = any($1::text[]) and session_id is not null
     ) t group by session_id order by last_at desc limit 50`,
    [ids],
  );
  const sessionIds = (sessionMatch?.rows ?? [])
    .map((row) => String(row.session_id ?? '').trim())
    .filter(Boolean);
  const codesResult = await sources.query(
    'eventCodes',
    `select event_code, count(*)::int total
       from public.studio_ops_events
      where occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz
        and (metadata->>'sso_user_id' = any($1::text[])
          or correlation->>'sso_user_id' = any($1::text[])
          ${sessionIds.length ? `or metadata->>'session_id' = any($4::text[])
          or correlation->>'session_id' = any($4::text[])` : ''})
      group by event_code
      order by total desc, event_code
      limit 30`,
    sessionIds.length ? [ids, window.from, window.to, sessionIds] : [ids, window.from, window.to],
  );
  const conditions = [
    'occurred_at >= $2::timestamptz and occurred_at <= $3::timestamptz',
    "(metadata->>'sso_user_id' = any($1::text[]) or correlation->>'sso_user_id' = any($1::text[])" +
      (sessionIds.length
        ? ` or metadata->>'session_id' = any($4::text[]) or correlation->>'session_id' = any($4::text[]))`
        : ')'),
  ];
  const params: unknown[] = sessionIds.length ? [ids, window.from, window.to, sessionIds] : [ids, window.from, window.to];
  if (eventCode) {
    params.push(eventCode);
    conditions.push(`event_code = $${params.length}`);
  }
  params.push(limit);
  const eventsResult = await sources.query(
    'events',
    `select occurred_at, component, event_code, outcome, safe_summary
       from public.studio_ops_events
      where ${conditions.join(' and ')}
      order by occurred_at desc
      limit $${params.length}`,
    params,
  );
  return {
    identifier,
    resolvedIds: ids,
    timeWindow: window,
    ...sources.metadata(),
    codes: (codesResult?.rows ?? []).map((row) => ({
      eventCode: String(row.event_code ?? ''),
      total: Number(row.total ?? 0),
    })),
    events: eventsResult?.rows ?? [],
  };
}
