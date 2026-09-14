/**
 * 中心积分账户存储(Postgres `credit_account` 表)—— 公开客户端、几千用户的「权威用户/额度记录层」。
 *
 * 定位:system-of-record + 运营管理层。运行时的每用户每日 enforcement 落在 **Studio 托管网关**
 * (per-user key + 计数);本模块负责账户记录、额度设置、卡/券/积分发放、运营查询,
 * 由上层(gateway-admin-client)把 limit 变化推到网关。表初始由 Supabase 用户导入建立。
 *
 * 单一中心后端:仅在共享服务器(web-cloud / 网关侧)启用,需配置 RDK_CHAT_CREDITS_DB_URL;
 * 桌面本地 server 不直接当权威(本地不可信)。pg 走懒加载(optionalDependency),与
 * chat-credits-ledger 一致——未配 DB URL 时本模块不可用、调用即抛,不影响桌面默认路径。
 *
 * 架构与迁移背景见 docs/credits-quota-architecture-plan.md。
 */
import { readStudioAgentEnv } from '../agent/studio-agent-env.js';

// 不静态依赖 @types/pg(CLI 构建图含本模块时可能无 pg 类型,见 build:cli):本模块只用到 query/connect,
// 定义最小局部类型即可。pg 仍按需懒加载(下方 await import('pg'),用 any 模块避免 TS7016 缺声明)。
type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type PoolClient = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  release: () => void;
};
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  connect: () => Promise<PoolClient>;
};

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

/** 中心积分库是否已配置(决定本模块是否可用)。 */
export function isCentralCreditStoreEnabled(): boolean {
  return centralDbUrl().length > 0;
}

let _poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  if (!centralDbUrl()) {
    throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置:中心积分库不可用(仅共享服务器/网关侧启用)');
  }
  // 缓存 Promise<Pool>(在 await 之前赋值),并发首调共用同一次构造,避免漏建重复 Pool(与 _pgSchemaReady 一致)。
  if (!_poolReady) {
    _poolReady = (async () => {
      // 懒加载 pg(optionalDependency),与 chat-credits-ledger 一致;桌面默认路径无需安装 pg。
      // specifier 用非字面量('pg' as string)→ tsc 不解析 'pg' 的声明(CLI 构建无 @types/pg 否则 TS7016),
      // 两个 build 都把模块当 any;运行时 'pg' as string === 'pg'。只用到 Pool 构造 + query/connect。
      const pgMod = (await import('pg' as string)) as {
        default: {
          Pool: new (cfg: {
            connectionString: string;
            max?: number;
            connectionTimeoutMillis?: number;
            statement_timeout?: number;
            query_timeout?: number;
          }) => Pool;
        };
      };
      // 与 chat-credits-ledger 同款超时:中心库直连(隧道)劣化时给显式上限,让首字前的账户查询走 fail-open
      // 而非无限等。宽松值,避免波及扣费/发卡等写路径。
      return new pgMod.default.Pool({
        connectionString: centralDbUrl(),
        max: 4,
        connectionTimeoutMillis: 4000,
        statement_timeout: 8000,
        query_timeout: 8000,
      });
    })().catch((err) => {
      _poolReady = null; // 构造失败重置,允许后续重试
      throw err;
    });
  }
  return _poolReady;
}

/** 业务日历日(默认 Asia/Shanghai,与 chat-credits 时区一致),用于每日额度滚动。 */
function todayYmd(): string {
  const tz = String(process.env.RDK_CHAT_CREDITS_TIMEZONE ?? '').trim() || 'Asia/Shanghai';
  try {
    // en-CA → YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export interface CreditAccount {
  ssoUserId: string;
  displayName: string | null;
  /** 每日对话上限;0 = 无 per-user 覆盖(由全局默认 / 网关默认决定)。 */
  dailyLimit: number;
  dailyUsed: number;
  dailyDate: string | null;
  dailyBonus: number;
  resetCardBalance: number;
  /** 累计已用重置卡数(消耗计数;从加列起统计,历史无账本不回溯)。 */
  resetCardUsed: number;
  voucherBalance: number;
  pointsBalance: number;
  /** 该用户在 Studio 托管网关的专属 key(per-user enforcement 用);null=尚未发放。 */
  gatewayUserKey: string | null;
}

// daily_date 用 to_char 投影成 'YYYY-MM-DD' 字符串:node-pg 默认把 DATE 列解析成 JS Date,String(Date) 是
// "Tue Jun 23" 与 todayYmd() 的 "2026-06-23" 永不相等 → sameDay 恒 false → 用量/bonus 永远显示 0。源头投成字符串最稳。
const COLS =
  "sso_user_id, display_name, daily_limit, daily_used, to_char(daily_date, 'YYYY-MM-DD') as daily_date, daily_bonus, reset_card_balance, reset_card_used, voucher_balance, points_balance, gateway_user_key";

function rowToAccount(r: Record<string, unknown>): CreditAccount {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    ssoUserId: String(r.sso_user_id ?? ''),
    displayName: r.display_name == null ? null : String(r.display_name),
    dailyLimit: num(r.daily_limit),
    dailyUsed: num(r.daily_used),
    dailyDate: r.daily_date == null ? null : String(r.daily_date).slice(0, 10),
    dailyBonus: num(r.daily_bonus),
    resetCardBalance: num(r.reset_card_balance),
    resetCardUsed: num(r.reset_card_used),
    voucherBalance: num(r.voucher_balance),
    pointsBalance: num(r.points_balance),
    gatewayUserKey: r.gateway_user_key == null ? null : String(r.gateway_user_key),
  };
}

/** 建表(幂等;与 Supabase 导入脚本所建结构一致)。 */
export async function ensureSchema(): Promise<void> {
  const p = await pool();
  await p.query(`
    create table if not exists credit_account (
      sso_user_id text primary key,
      display_name text,
      daily_limit integer not null default 0,
      daily_used integer not null default 0,
      daily_date date,
      daily_bonus integer not null default 0,
      reset_card_balance integer not null default 0,
      voucher_balance integer not null default 0,
      points_balance integer not null default 0,
      gateway_user_key text,
      gateway_key_set_at timestamptz,
      source text default 'lazy_create',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  // 向后兼容:旧表(Supabase 导入时建)补列。
  await p.query(`alter table credit_account add column if not exists gateway_user_key text`);
  await p.query(
    `alter table credit_account add column if not exists gateway_key_set_at timestamptz`,
  );
  // 重置卡「最近一次使用日期」记录（运营留痕用）。注意:不再用它做每业务日幂等拦截——重置卡一天内不限次,
  // 有几张刷几次,卡余额本身即是限额(见 useResetCard)。
  await p.query(`alter table credit_account add column if not exists last_reset_card_date date`);
  // 累计已用重置卡数(消耗计数):运营查"某用户用了多少重置卡"。从加列起统计,历史无账本不回溯。
  await p.query(
    `alter table credit_account add column if not exists reset_card_used integer not null default 0`,
  );
  // 三端账号同步的最小锚点列(v1.3.2 目标"账号换端不丢失"的地基):最近一次登录来自哪个渠道/设备、
  // 何时最近一次同步过。仅记录,尚无跨端一致性校验逻辑——那是后续产品功能。
  await p.query(`alter table credit_account add column if not exists last_active_device text`);
  await p.query(`alter table credit_account add column if not exists last_login_channel text`);
  await p.query(`alter table credit_account add column if not exists last_synced_at timestamptz`);
  // 渠道归因(v1.4.0「决策渠道归因覆盖率≥80%」):首触获客渠道 + 落地 UTM/来源/邀请码。first-touch 语义——
  // 只在首次有值时写入,后续登录不覆盖(coalesce),保证「用户从哪来」这个归因维度稳定。
  await p.query(`alter table credit_account add column if not exists acquisition_channel text`);
  await p.query(`alter table credit_account add column if not exists acquisition_source text`);
  await p.query(`alter table credit_account add column if not exists acquisition_campaign text`);
  await p.query(`alter table credit_account add column if not exists acquisition_referrer text`);
  await p.query(`alter table credit_account add column if not exists acquisition_at timestamptz`);
  // 多 key:一个用户可有多把 key(默认 + 自建),都归属同一 sso_user_id(共用一份每日额度)。
  // key_id = 网关里这把 key 的唯一 userId(每把一个);gateway_key = 实际 sk-… 凭证。
  await p.query(`
    create table if not exists credit_user_key (
      key_id text primary key,
      sso_user_id text not null,
      name text not null default 'API Key',
      gateway_key text not null,
      is_default boolean not null default false,
      created_at timestamptz not null default now()
    );
  `);
  await p.query(
    `create index if not exists credit_user_key_sso_idx on credit_user_key (sso_user_id)`,
  );
  // 防并发首登发出多把默认 key:先把每个用户多余的 is_default 降级为普通 key(保留最早一把,不删数据),
  // 再建部分唯一索引兜底——DB 层保证「一个用户至多一把默认 key」。幂等:无重复时 update 是 no-op、索引 if not exists。
  await p.query(`
    update credit_user_key set is_default = false
     where key_id in (
       select key_id from (
         select key_id,
                row_number() over (partition by sso_user_id order by created_at asc, key_id asc) as rn
           from credit_user_key where is_default
       ) t where t.rn > 1
     )
  `);
  await p.query(
    `create unique index if not exists credit_user_key_one_default on credit_user_key (sso_user_id) where is_default`,
  );
  // 默认网关 key 的两阶段发放意图。网关可能已经创建成功、但中心库写入超时；
  // 保留 intent + 幂等键即可在下一次登录/对账时安全恢复，而不是再发一把不可找回的孤儿 key。
  await p.query(`
    create table if not exists credit_gateway_key_provision_intent (
      intent_id text primary key,
      key_id text not null unique,
      sso_user_id text not null,
      name text not null,
      is_default boolean not null default true,
      idempotency_key text not null unique,
      gateway_key text,
      status text not null default 'pending'
        check (status in ('pending', 'gateway_created', 'failed')),
      attempt_count integer not null default 0,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await p.query(
    `create index if not exists credit_gateway_key_intent_owner_idx
     on credit_gateway_key_provision_intent (sso_user_id, status, updated_at desc)`,
  );
  // 全局配置(k/v)。default_daily_limit = 运营设的"大家的默认每日额度"(per-user daily_limit=0 时用它)。
  await p.query(
    `create table if not exists credit_setting (key text primary key, value text not null, updated_at timestamptz not null default now())`,
  );
  // 每次对话的原子预占记录：桌面 HTTP 重试、SSE 重连或同消息并发只会扣一次；
  // 失败退款按同一 key 删除记录后再减计数，也不会把别的成功对话误退。
  await p.query(`
    create table if not exists credit_daily_reservation (
      sso_user_id text not null,
      business_date date not null,
      idempotency_key text not null,
      refunded_at timestamptz,
      created_at timestamptz not null default now(),
      primary key (sso_user_id, business_date, idempotency_key)
    )
  `);
  await p.query(
    `alter table credit_daily_reservation add column if not exists refunded_at timestamptz`,
  );
  await p.query(
    `create index if not exists credit_daily_reservation_effect_lookup
       on credit_daily_reservation (sso_user_id, idempotency_key, business_date desc)`,
  );
}

let _globalDefaultCache: { value: number; at: number } | null = null;
let _globalDefaultRefreshInFlight = false;

/**
 * 全局默认每日额度:运营在 credit_setting('default_daily_limit') 设的值;未设则回退 env RDK_STUDIO_AGENT_DAILY_CHAT_LIMIT。
 * 5s 缓存 + stale-while-revalidate：该值是运营低频配置，过期时先返回旧值、异步后台刷新，
 * 绝不把一次 pg 往返（隔隧道 700ms+）卡在每条消息的计费闸门关键路径上。
 */
export async function getGlobalDefaultLimit(): Promise<number> {
  const envFallback = Math.max(0, Math.round(Number(readStudioAgentEnv('dailyChatLimit')) || 0));
  if (!isCentralCreditStoreEnabled()) return envFallback;
  const refresh = async () => {
    if (_globalDefaultRefreshInFlight) return;
    _globalDefaultRefreshInFlight = true;
    try {
      const p = await pool();
      const { rows } = await p.query(
        `select value from credit_setting where key = 'default_daily_limit'`,
      );
      const v = rows[0] != null ? Math.max(0, Math.round(Number(rows[0].value) || 0)) : envFallback;
      _globalDefaultCache = { value: v, at: Date.now() };
    } catch {
      // 失败不更新缓存时间戳：下次调用会再试；期间继续用旧值（fail-open 语义不变）。
    } finally {
      _globalDefaultRefreshInFlight = false;
    }
  };
  if (_globalDefaultCache) {
    if (Date.now() - _globalDefaultCache.at < 5000) return _globalDefaultCache.value;
    void refresh(); // 过期：先返回旧值，后台刷新
    return _globalDefaultCache.value;
  }
  // 冷启动无缓存：只能同步查一次（后续全部享受 stale-while-revalidate）。
  await refresh();
  // 闭包内赋值不被控制流分析计入，重读模块变量并显式断言。
  const cached = _globalDefaultCache as { value: number; at: number } | null;
  return cached ? cached.value : envFallback;
}

/** 运营设全局默认每日额度(对所有 per-user 未覆盖的用户 + 新用户生效)。 */
export async function setGlobalDefaultLimit(n: number): Promise<number> {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const p = await pool();
  await p.query(
    `insert into credit_setting (key, value, updated_at) values ('default_daily_limit', $1, now())
       on conflict (key) do update set value = $1, updated_at = now()`,
    [String(v)],
  );
  _globalDefaultCache = { value: v, at: Date.now() };
  return v;
}

let _defaultResetCardsCache: { value: number; at: number } | null = null;

/**
 * 新用户默认重置卡张数:运营在 credit_setting('default_reset_cards') 设的值;未设则回退 env
 * RDK_STUDIO_AGENT_DEFAULT_RESET_CARDS(默认 0)。5s 缓存。**仅在账户懒创建时**用于初始化 reset_card_balance,
 * 不补发给存量账户(那是 grant-all 的事)。
 */
export async function getDefaultResetCards(): Promise<number> {
  const envFallback = Math.max(
    0,
    Math.round(Number(process.env.RDK_STUDIO_AGENT_DEFAULT_RESET_CARDS) || 0),
  );
  if (!isCentralCreditStoreEnabled()) return envFallback;
  if (_defaultResetCardsCache && Date.now() - _defaultResetCardsCache.at < 5000)
    return _defaultResetCardsCache.value;
  try {
    const p = await pool();
    const { rows } = await p.query(
      `select value from credit_setting where key = 'default_reset_cards'`,
    );
    const v = rows[0] != null ? Math.max(0, Math.round(Number(rows[0].value) || 0)) : envFallback;
    _defaultResetCardsCache = { value: v, at: Date.now() };
    return v;
  } catch {
    return envFallback;
  }
}

/** 运营设"新用户默认重置卡张数"(只影响之后懒创建的新账户,不补发给存量用户)。 */
export async function setDefaultResetCards(n: number): Promise<number> {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const p = await pool();
  await p.query(
    `insert into credit_setting (key, value, updated_at) values ('default_reset_cards', $1, now())
       on conflict (key) do update set value = $1, updated_at = now()`,
    [String(v)],
  );
  _defaultResetCardsCache = { value: v, at: Date.now() };
  return v;
}

export interface UserKeyRecord {
  keyId: string;
  ssoUserId: string;
  name: string;
  gatewayKey: string;
  isDefault: boolean;
  createdAt: string;
}

function rowToUserKey(r: Record<string, unknown>): UserKeyRecord {
  return {
    keyId: String(r.key_id ?? ''),
    ssoUserId: String(r.sso_user_id ?? ''),
    name: String(r.name ?? 'API Key'),
    gatewayKey: String(r.gateway_key ?? ''),
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at == null ? '' : String(r.created_at),
  };
}

const USER_KEY_COLS = 'key_id, sso_user_id, name, gateway_key, is_default, created_at';

export type GatewayKeyProvisionIntentStatus = 'pending' | 'gateway_created' | 'failed';

export type GatewayKeyProvisionIntent = {
  intentId: string;
  keyId: string;
  ssoUserId: string;
  name: string;
  isDefault: boolean;
  idempotencyKey: string;
  gatewayKey: string | null;
  status: GatewayKeyProvisionIntentStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const GATEWAY_KEY_INTENT_COLS = `intent_id, key_id, sso_user_id, name, is_default,
  idempotency_key, gateway_key, status, attempt_count, last_error, created_at, updated_at`;

function rowToGatewayKeyProvisionIntent(r: Record<string, unknown>): GatewayKeyProvisionIntent {
  const status = String(r.status ?? 'pending');
  return {
    intentId: String(r.intent_id ?? ''),
    keyId: String(r.key_id ?? ''),
    ssoUserId: String(r.sso_user_id ?? ''),
    name: String(r.name ?? 'RDK Studio'),
    isDefault: Boolean(r.is_default),
    idempotencyKey: String(r.idempotency_key ?? ''),
    gatewayKey: r.gateway_key == null ? null : String(r.gateway_key),
    status: status === 'gateway_created' || status === 'failed' ? status : ('pending' as const),
    attemptCount: Number.isFinite(Number(r.attempt_count)) ? Number(r.attempt_count) : 0,
    lastError: r.last_error == null ? null : String(r.last_error).slice(0, 240),
    createdAt: r.created_at == null ? '' : String(r.created_at),
    updatedAt: r.updated_at == null ? '' : String(r.updated_at),
  };
}

/** Start or resume a durable default-key provisioning intent. */
export async function beginGatewayKeyProvisionIntent(input: {
  intentId: string;
  keyId: string;
  ssoUserId: string;
  name: string;
  idempotencyKey: string;
  isDefault?: boolean;
}): Promise<GatewayKeyProvisionIntent> {
  const id = String(input.ssoUserId ?? '').trim();
  if (!id || !input.intentId || !input.keyId || !input.idempotencyKey) {
    throw new Error('beginGatewayKeyProvisionIntent: 参数不能为空');
  }
  const p = await pool();
  const { rows } = await p.query(
    `insert into credit_gateway_key_provision_intent
       (intent_id, key_id, sso_user_id, name, is_default, idempotency_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (intent_id) do update
       set updated_at = now()
     returning ${GATEWAY_KEY_INTENT_COLS}`,
    [
      input.intentId,
      input.keyId,
      id,
      String(input.name || 'RDK Studio').slice(0, 64),
      input.isDefault !== false,
      input.idempotencyKey,
    ],
  );
  return rowToGatewayKeyProvisionIntent(rows[0]);
}

/** Persist the one-time gateway response before attempting the local insert. */
export async function recordGatewayKeyProvisioned(
  intentId: string,
  gatewayKey: string,
): Promise<GatewayKeyProvisionIntent | null> {
  if (!intentId || !gatewayKey) throw new Error('recordGatewayKeyProvisioned: 参数不能为空');
  const p = await pool();
  const { rows } = await p.query(
    `update credit_gateway_key_provision_intent
        set gateway_key = $2, status = 'gateway_created', attempt_count = attempt_count + 1,
            last_error = null, updated_at = now()
      where intent_id = $1
      returning ${GATEWAY_KEY_INTENT_COLS}`,
    [intentId, gatewayKey],
  );
  return rows[0] ? rowToGatewayKeyProvisionIntent(rows[0]) : null;
}

/** Record a bounded, redacted failure while keeping any previously saved key for recovery. */
export async function recordGatewayKeyProvisionFailure(
  intentId: string,
  lastError: string,
): Promise<void> {
  if (!intentId) return;
  const p = await pool();
  await p.query(
    `update credit_gateway_key_provision_intent
        set status = 'failed', attempt_count = attempt_count + 1,
            last_error = left($2, 240), updated_at = now()
      where intent_id = $1`,
    [intentId, String(lastError ?? '').slice(0, 240)],
  );
}

export async function clearGatewayKeyProvisionIntent(intentId: string): Promise<void> {
  if (!intentId) return;
  const p = await pool();
  await p.query(`delete from credit_gateway_key_provision_intent where intent_id = $1`, [intentId]);
}

/** 列某用户全部 key(默认 key 排最前,其余按创建时间)。 */
export async function listUserKeys(ssoUserId: string): Promise<UserKeyRecord[]> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return [];
  const p = await pool();
  const { rows } = await p.query(
    `select ${USER_KEY_COLS} from credit_user_key where sso_user_id = $1 order by is_default desc, created_at asc`,
    [id],
  );
  return rows.map(rowToUserKey);
}

export async function countUserKeys(ssoUserId: string): Promise<number> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return 0;
  const p = await pool();
  const { rows } = await p.query(
    `select count(*)::int as n from credit_user_key where sso_user_id = $1`,
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getDefaultUserKey(ssoUserId: string): Promise<UserKeyRecord | null> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return null;
  const p = await pool();
  const { rows } = await p.query(
    `select ${USER_KEY_COLS} from credit_user_key where sso_user_id = $1 and is_default = true limit 1`,
    [id],
  );
  return rows[0] ? rowToUserKey(rows[0]) : null;
}

/** 落库一把新 key(网关创建成功后调)。 */
export async function insertUserKey(rec: {
  keyId: string;
  ssoUserId: string;
  name: string;
  gatewayKey: string;
  isDefault?: boolean;
}): Promise<UserKeyRecord> {
  const p = await pool();
  const { rows } = await p.query(
    `insert into credit_user_key (key_id, sso_user_id, name, gateway_key, is_default)
       values ($1, $2, $3, $4, $5)
     returning ${USER_KEY_COLS}`,
    [
      rec.keyId,
      String(rec.ssoUserId).trim(),
      rec.name.slice(0, 64),
      rec.gatewayKey,
      Boolean(rec.isDefault),
    ],
  );
  return rowToUserKey(rows[0]);
}

/** 轮换某把 key 的网关凭证(网关 rotate 后落新 gateway_key;keyId/owner 不变,per-owner 计数不受影响)。 */
export async function updateUserKeyGatewayKey(keyId: string, gatewayKey: string): Promise<void> {
  const kid = String(keyId ?? '').trim();
  if (!kid || !gatewayKey) throw new Error('updateUserKeyGatewayKey: 参数不能为空');
  const p = await pool();
  await p.query(`update credit_user_key set gateway_key = $2 where key_id = $1`, [kid, gatewayKey]);
}

/** 删一把 key(校验归属);返回被删记录(供调用方去网关同步删除)。默认 key 不允许删。 */
export async function deleteUserKey(
  ssoUserId: string,
  keyId: string,
): Promise<UserKeyRecord | null> {
  const id = String(ssoUserId ?? '').trim();
  const kid = String(keyId ?? '').trim();
  if (!id || !kid) return null;
  const p = await pool();
  const { rows } = await p.query(
    `delete from credit_user_key where sso_user_id = $1 and key_id = $2 and is_default = false returning ${USER_KEY_COLS}`,
    [id, kid],
  );
  return rows[0] ? rowToUserKey(rows[0]) : null;
}

/** 记录某用户的网关专属 key(首次发放后持久化;网关 GET 取不回完整 key,故必须存这里)。 */
export async function setGatewayUserKey(ssoUserId: string, key: string): Promise<void> {
  const id = String(ssoUserId ?? '').trim();
  if (!id || !key) throw new Error('setGatewayUserKey: 参数不能为空');
  const p = await pool();
  await p.query(
    `update credit_account set gateway_user_key = $2, gateway_key_set_at = now(), updated_at = now() where sso_user_id = $1`,
    [id, key],
  );
  // 轮换/首发默认 key 后失效 owner-scoped credential 短 TTL 缓存。
  void import('./managed-agent-credential.js')
    .then((m) => m.invalidateRequestManagedAgentCredentialCache(id))
    .catch(() => {});
}

/**
 * 更新账号同步锚点(最近登录渠道/设备/时间)。best-effort:账户不存在时静默 no-op(0 行更新),
 * 不像 setGatewayUserKey 那样抛错——调用方(登录审计路径)是旁路记录,不应因此中断登录流程。
 */
export async function updateAccountSyncAnchors(
  ssoUserId: string,
  anchors: { loginChannel?: string | null; activeDevice?: string | null },
): Promise<void> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return;
  const p = await pool();
  await p.query(
    `update credit_account
        set last_login_channel = coalesce($2, last_login_channel),
            last_active_device = coalesce($3, last_active_device),
            last_synced_at = now()
      where sso_user_id = $1`,
    [id, anchors.loginChannel?.trim() || null, anchors.activeDevice?.trim() || null],
  );
}

/**
 * first-touch 渠道归因写入(v1.4.0)。只在对应列**当前为空**时写(coalesce 保留旧值),保证「用户从哪来」
 * 稳定不被后续登录覆盖。best-effort:账户不存在时 0 行更新静默 no-op(登录钩子旁路,绝不中断登录)。
 * 传入的字段做长度收窄,避免脏数据落库。
 */
export async function recordAcquisitionAttribution(
  ssoUserId: string,
  attr: {
    channel?: string | null;
    source?: string | null;
    campaign?: string | null;
    referrer?: string | null;
  },
): Promise<void> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return;
  const clip = (v: string | null | undefined, n: number): string | null => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, n) : null;
  };
  const channel = clip(attr.channel, 64);
  const source = clip(attr.source, 128);
  const campaign = clip(attr.campaign, 128);
  const referrer = clip(attr.referrer, 256);
  if (!channel && !source && !campaign && !referrer) return;
  const p = await pool();
  await p.query(
    `update credit_account
        set acquisition_channel = coalesce(acquisition_channel, $2),
            acquisition_source = coalesce(acquisition_source, $3),
            acquisition_campaign = coalesce(acquisition_campaign, $4),
            acquisition_referrer = coalesce(acquisition_referrer, $5),
            acquisition_at = coalesce(acquisition_at, now())
      where sso_user_id = $1`,
    [id, channel, source, campaign, referrer],
  );
}

export async function getAccount(ssoUserId: string): Promise<CreditAccount | null> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return null;
  const p = await pool();
  const { rows } = await p.query(`select ${COLS} from credit_account where sso_user_id = $1`, [id]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

/** 取账户,不存在则按 SSO 身份懒创建(导入未覆盖的新用户)。 */
export async function ensureAccount(
  ssoUserId: string,
  displayName?: string | null,
): Promise<CreditAccount> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) throw new Error('ensureAccount: ssoUserId 不能为空');
  // 新账户默认发 N 张重置卡(运营 default_reset_cards)。仅 INSERT 分支生效——ON CONFLICT(存量账户)不碰
  // reset_card_balance,避免每次触达都补发。合成 im:/system: 账户无自助补额入口、本就不限量,不发。
  const defaultResetCards = /^(im|system):/.test(id) ? 0 : await getDefaultResetCards();
  const p = await pool();
  const { rows } = await p.query(
    `insert into credit_account (sso_user_id, display_name, source, reset_card_balance)
       values ($1, $2, 'lazy_create', $3)
     on conflict (sso_user_id) do update set
       display_name = coalesce(excluded.display_name, credit_account.display_name),
       updated_at = now()
     returning ${COLS}`,
    [id, displayName ?? null, defaultResetCards],
  );
  return rowToAccount(rows[0]);
}

export interface DailyConsumeResult {
  ok: boolean;
  /** 本次调用是否真的新增了一次计数；幂等重放为 false，调用方不得据此退款。 */
  reserved: boolean;
  /** A durable refund tombstone fenced this exact effect key. */
  cancelled: boolean;
  used: number;
  limit: number;
  /** 当日额度卡加成（已含在 limit 内，单列供展示拆分） */
  bonus: number;
  remaining: number;
  unlimited: boolean;
}

/**
 * 每条用户消息计一次:原子递增 `daily_used`(按业务日 `todayYmd()` 滚动重置),并判定是否超限。
 * 有效上限 = (per-user `daily_limit`>0 ? daily_limit : `globalDefaultLimit`) + `daily_bonus`。
 * per-user 与全局默认都 ≤0 → 视为不限量(始终放行,但仍记 used 以便统计)。账户不存在则懒创建。
 * 这是「中心库 = 唯一计数源」的写入点:站内 gate 与(将来)网关都经此累加,保证服务器统计准确。
 *
 * 性能注记:旧实现是 ensureAccount + begin + insert reservation + update + cleanup + commit 六次
 * 串行跨云往返,隧道抖动时单条消息的预占能耗到 2s+。现合并为单条 CTE SQL(单语句天然原子),
 * 超限才回退一次补查;热路径 1 次往返。
 */
/**
 * 旧 legacy 退款回执在 30 天后可清理；`credit-effect:*` 是 durable journal 的
 * fencing receipt，不能按业务日删除，否则暂停/网络分区后的迟到 consume 会失去 tombstone。
 * 清理移到成功路径后台旁路，避免给预占热路径增加一次跨云 RTT。
 */
const staleReservationCleanupAt = new Map<string, number>();
const STALE_RESERVATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
function scheduleStaleReservationCleanup(p: Pool, ssoUserId: string, today: string): void {
  const now = Date.now();
  const last = staleReservationCleanupAt.get(ssoUserId) ?? 0;
  if (now - last < STALE_RESERVATION_CLEANUP_INTERVAL_MS) return;
  staleReservationCleanupAt.set(ssoUserId, now);
  if (staleReservationCleanupAt.size > 50_000) {
    for (const [uid, at] of staleReservationCleanupAt) {
      if (now - at >= STALE_RESERVATION_CLEANUP_INTERVAL_MS) staleReservationCleanupAt.delete(uid);
    }
  }
  void p
    .query(
      `delete from credit_daily_reservation
        where sso_user_id = $1
          and business_date < ($2::date - interval '30 days')
          and refunded_at is not null
          and idempotency_key not like 'credit-effect:%'`,
      [ssoUserId, today],
    )
    .catch(() => {
      /* 后台清理失败无业务影响：下次成功路径或超限回退路径会再试 */
    });
}

export async function consumeDaily(
  ssoUserId: string,
  globalDefaultLimit: number,
  idempotencyKey?: string,
  fencedIdempotency = false,
): Promise<DailyConsumeResult> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) throw new Error('consumeDaily: ssoUserId 不能为空');
  const today = todayYmd();
  // 合成渠道/系统账户(im:* 飞书微信 / system:* 定时任务)默认不受全局默认额度约束:它们无登录会话、无重置卡/券自助
  // 补额度入口,之前共享 key 时本就无限。→ gdl 置 0,daily_limit=0(默认)即 unlimited;仍逐条计入 daily_used(可记账)。
  // 运营可对单个合成账户显式 setDailyLimit(>0)来封顶。审查 H3/M3:否则它们会因运营设的全局默认额度被 429 打挂。
  const synthetic = /^(im|system):/.test(id);
  const gdl = synthetic ? 0 : Math.max(0, Math.round(Number(globalDefaultLimit) || 0));
  const p = await pool();
  const key = String(idempotencyKey ?? '')
    .trim()
    .slice(0, 256);
  const fencedDefaultResetCards =
    fencedIdempotency && key
      ? /^(im|system):/.test(id)
        ? 0
        : await getDefaultResetCards()
      : undefined;

  const execute = async (queryable: Pick<Pool, 'query'>): Promise<DailyConsumeResult> => {
    const buildResult = (
      ok: boolean,
      reserved: boolean,
      dl: number,
      bonus: number,
      used: number,
      cancelled = false,
    ): DailyConsumeResult => {
      const unlimited = dl <= 0 && gdl <= 0;
      const limit = unlimited ? 0 : (dl > 0 ? dl : gdl) + bonus;
      return {
        ok,
        reserved,
        cancelled,
        used,
        limit,
        bonus,
        remaining: unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - used),
        unlimited,
      };
    };

    // res=幂等预占行(无 key 不插)。增量 = 无 key 时恒 +1;有 key 时取 res 命中数(重放为 0)。
    // 重放跳过限额检查(不新增计数)；新计数超限则 update 条件不满足、无返回行 → 下方回退处理。
    // 注:PG 不允许单语句两次修改同一张表,故账户懒创建/预占清理不进这条 SQL(见下方回退路径)。
    const consumeAttempt = () =>
      queryable.query(
        `with res as (
         insert into credit_daily_reservation (sso_user_id, business_date, idempotency_key)
         select $1, $2, $4
          where $4 <> ''
            and (
              $5 = false
              or not exists (
                select 1 from credit_daily_reservation prior
                 where prior.sso_user_id = $1 and prior.idempotency_key = $4
              )
            )
         on conflict (sso_user_id, business_date, idempotency_key) do update
           set refunded_at = null, created_at = now()
           where credit_daily_reservation.refunded_at is not null and $5 = false
         returning idempotency_key
       )
       update credit_account
         set daily_used = (case when daily_date = $2 then daily_used else 0 end)
               + (case when $4 = '' then 1 else (select count(*)::int from res) end),
             daily_bonus = (case when daily_date = $2 then daily_bonus else 0 end),
             daily_date = $2,
             updated_at = now()
       where sso_user_id = $1
         and (
           ($4 <> '' and (select count(*) from res) = 0)
           or (daily_limit <= 0 and $3 <= 0)
           or (case when daily_date = $2 then daily_used else 0 end)
                < (case when daily_limit > 0 then daily_limit else $3 end)
                  + (case when daily_date = $2 then daily_bonus else 0 end)
         )
       returning daily_used, daily_limit, daily_bonus,
                 (case when $4 = '' then 1 else (select count(*)::int from res) end) as did_reserve,
                 (
                   $5 = true
                   and (select count(*) from res) = 0
                   and exists (
                     select 1 from credit_daily_reservation prior
                      where prior.sso_user_id = $1
                        and prior.idempotency_key = $4
                        and prior.refunded_at is not null
                   )
                 ) as was_cancelled`,
        [id, today, gdl, key, fencedIdempotency],
      );
    const consumeSuccess = (row: Record<string, unknown>): DailyConsumeResult => {
      const didReserve = Number(row.did_reserve) || 0;
      return buildResult(
        true,
        didReserve === 1,
        Number(row.daily_limit) || 0,
        Number(row.daily_bonus) || 0,
        Number(row.daily_used) || 0,
        row.was_cancelled === true,
      );
    };

    const { rows } = await consumeAttempt();
    if (rows[0]) {
      scheduleStaleReservationCleanup(p, id, today);
      return consumeSuccess(rows[0]);
    }

    // 无返回行 = 超限 或 账户不存在(新用户)。回退 SQL：撤销本次预占 + 顺手清理旧业务日预占 + 读当前投影。
    const fallback = await queryable.query(
      `with del as (
         delete from credit_daily_reservation
         where sso_user_id = $1 and business_date = $2 and idempotency_key = $3 and $3 <> ''
           and refunded_at is null
         returning idempotency_key
       ),
       cleanup as (
         delete from credit_daily_reservation
         where sso_user_id = $1
           and business_date < ($2::date - interval '30 days')
           and refunded_at is not null
           and idempotency_key not like 'credit-effect:%'
         returning idempotency_key
       )
       select daily_limit, daily_used,
              to_char(daily_date, 'YYYY-MM-DD') as daily_date, daily_bonus
         from credit_account where sso_user_id = $1`,
      [id, today, key],
    );
    const acc = fallback.rows[0];
    if (!acc) {
      if (fencedDefaultResetCards === undefined) {
        await ensureAccount(id);
      } else {
        await queryable.query(
          `insert into credit_account (sso_user_id, source, reset_card_balance)
             values ($1, 'lazy_create', $2)
           on conflict (sso_user_id) do nothing`,
          [id, fencedDefaultResetCards],
        );
      }
      const retry = await consumeAttempt();
      if (retry.rows[0]) {
        scheduleStaleReservationCleanup(p, id, today);
        return consumeSuccess(retry.rows[0]);
      }
      return buildResult(false, false, 0, 0, 0);
    }
    const sameDay = String(acc.daily_date ?? '').slice(0, 10) === today;
    return buildResult(
      false,
      false,
      Number(acc.daily_limit) || 0,
      sameDay ? Number(acc.daily_bonus) || 0 : 0,
      sameDay ? Number(acc.daily_used) || 0 : 0,
    );
  };

  if (!fencedIdempotency || !key) return execute(p);
  const fence = await p.connect();
  try {
    await fence.query('begin');
    await fence.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [id, key]);
    const result = await execute(fence);
    await fence.query('commit');
    return result;
  } catch (error) {
    await fence.query('rollback').catch(() => {});
    throw error;
  } finally {
    fence.release();
  }
}

/**
 * 退还一次每日计数（失败的对话不应计费）：仅当账户停留在「今天」这个业务日时把 daily_used 减 1、下限 0。
 * 跨业务日（daily_date != today）不动——昨天的计数已随窗口翻篇，今天从 0 起算，无可退之物。
 * 与 consumeDaily 的 +1 严格对称，使「先扣后退」净效果为零。存储错误向 durable
 * reconciler 抛出，由 journal 租约重试；兼容调用方可在更外层选择 best-effort。
 */
export type DailyRefundOutcome = 'applied' | 'replayed' | 'expired' | 'tombstoned' | 'missing';

export async function refundDaily(
  ssoUserId: string,
  idempotencyKey?: string,
  tombstoneMissing = false,
): Promise<DailyRefundOutcome> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return 'missing';
  const today = todayYmd();
  const p = await pool();
  const key = String(idempotencyKey ?? '')
    .trim()
    .slice(0, 256);
  if (key) {
    const client = await p.connect();
    try {
      await client.query('begin');
      // Serialize consume/refund for this account-scoped effect key. Without
      // this shared transaction fence, a consume could commit between the
      // missing-receipt SELECT and tombstone INSERT.
      await client.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [id, key]);
      const marked = await client.query(
        `update credit_daily_reservation
            set refunded_at = now()
          where sso_user_id = $1 and business_date = $2 and idempotency_key = $3
            and refunded_at is null
          returning idempotency_key`,
        [id, today, key],
      );
      if (marked.rows[0]) {
        await client.query(
          `update credit_account
              set daily_used = greatest(0, daily_used - 1),
                  updated_at = now()
            where sso_user_id = $1
              and daily_date = $2
              and daily_used > 0`,
          [id, today],
        );
        await client.query('commit');
        return 'applied';
      }
      const existing = await client.query(
        `select to_char(business_date, 'YYYY-MM-DD') as business_date, refunded_at
           from credit_daily_reservation
          where sso_user_id = $1 and idempotency_key = $2
          order by business_date desc
          limit 1`,
        [id, key],
      );
      const receipt = existing.rows[0];
      const receiptDate = String(receipt?.business_date ?? '').slice(0, 10);
      if (!receipt && tombstoneMissing) {
        await client.query(
          `insert into credit_daily_reservation
             (sso_user_id, business_date, idempotency_key, refunded_at)
           values ($1, $2, $3, now())
           on conflict (sso_user_id, business_date, idempotency_key) do nothing`,
          [id, today, key],
        );
      }
      if (receipt && receiptDate && receiptDate !== today && !receipt.refunded_at) {
        await client.query(
          `update credit_daily_reservation
              set refunded_at = now()
            where sso_user_id = $1 and business_date = $2 and idempotency_key = $3
              and refunded_at is null`,
          [id, receiptDate, key],
        );
      }
      await client.query('commit');
      if (!receipt) return tombstoneMissing ? 'tombstoned' : 'missing';
      return receiptDate === today ? 'replayed' : 'expired';
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const result = await p.query(
    `update credit_account
        set daily_used = greatest(0, daily_used - 1),
            updated_at = now()
      where sso_user_id = $1
        and daily_date = $2
        and daily_used > 0`,
    [id, today],
  );
  return (result.rowCount ?? 0) > 0 ? 'applied' : 'missing';
}

export interface DailyStatusProjection {
  limit: number;
  used: number;
  remaining: number;
  bonus: number;
  unlimited: boolean;
  resetCardBalance: number;
  voucherBalance: number;
  pointsBalance: number;
}

/** 只读取当前每日用量投影(按业务日重置语义,不写盘),供前端 chip 显示。账户不存在返回 null。 */
export async function getDailyStatus(
  ssoUserId: string,
  globalDefaultLimit: number,
): Promise<DailyStatusProjection | null> {
  const acc = await getAccount(String(ssoUserId ?? '').trim());
  if (!acc) return null;
  const today = todayYmd();
  const gdl = Math.max(0, Math.round(Number(globalDefaultLimit) || 0));
  const sameDay = acc.dailyDate === today;
  const used = sameDay ? acc.dailyUsed : 0;
  const bonus = sameDay ? acc.dailyBonus : 0; // 跨业务日 bonus 清零(额度卡仅当日有效,与本地 rollDailyChatWindow 一致)
  const unlimited = acc.dailyLimit <= 0 && gdl <= 0;
  const limit = unlimited ? 0 : (acc.dailyLimit > 0 ? acc.dailyLimit : gdl) + bonus;
  return {
    limit,
    used,
    remaining: unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - used),
    bonus,
    unlimited,
    resetCardBalance: acc.resetCardBalance,
    voucherBalance: acc.voucherBalance,
    pointsBalance: acc.pointsBalance,
  };
}

export interface ListUsersResult {
  total: number;
  users: CreditAccount[];
}

/** 运营后台:分页/搜索用户列表(按 sso_user_id 或 display_name 模糊匹配)。 */
export async function listUsers(
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<ListUsersResult> {
  const limit = Math.max(1, Math.min(200, Math.round(opts.limit ?? 50)));
  const offset = Math.max(0, Math.round(opts.offset ?? 0));
  const search = String(opts.search ?? '').trim();
  const where = search ? `where sso_user_id ilike $1 or coalesce(display_name, '') ilike $1` : '';
  const params = search ? [`%${search}%`] : [];
  const p = await pool();
  const totalRes = await p.query(`select count(*)::int n from credit_account ${where}`, params);
  const rowsRes = await p.query(
    `select ${COLS} from credit_account ${where} order by updated_at desc limit ${limit} offset ${offset}`,
    params,
  );
  return {
    total: Number(totalRes.rows[0]?.n ?? 0),
    users: rowsRes.rows.map(rowToAccount),
  };
}

export interface ExportAccountRow {
  ssoUserId: string;
  displayName: string | null;
  dailyLimit: number;
  dailyUsed: number;
  dailyBonus: number;
  resetCardBalance: number;
  resetCardUsed: number;
  voucherBalance: number;
  pointsBalance: number;
  source: string | null;
  createdAt: string | null;
  keyCount: number;
}

/** 导出全部账户(运营一键导出用;可选 search 过滤)。一次取全、按 sso_user_id 稳定排序,不受列表 200 上限约束。 */
export async function listAllAccountsForExport(
  opts: { search?: string } = {},
): Promise<ExportAccountRow[]> {
  const search = String(opts.search ?? '').trim();
  const where = search
    ? `where a.sso_user_id ilike $1 or coalesce(a.display_name, '') ilike $1`
    : '';
  const params = search ? [`%${search}%`] : [];
  const p = await pool();
  const res = await p.query(
    `select a.sso_user_id, a.display_name, a.daily_limit, a.daily_used, a.daily_bonus,
            a.reset_card_balance, a.reset_card_used, a.voucher_balance, a.points_balance, a.source,
            to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') as created_at,
            (select count(*)::int from credit_user_key k where k.sso_user_id = a.sso_user_id) as key_count
       from credit_account a ${where}
       order by a.sso_user_id asc`,
    params,
  );
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return res.rows.map((r: Record<string, unknown>) => ({
    ssoUserId: String(r.sso_user_id ?? ''),
    displayName: r.display_name == null ? null : String(r.display_name),
    dailyLimit: num(r.daily_limit),
    dailyUsed: num(r.daily_used),
    dailyBonus: num(r.daily_bonus),
    resetCardBalance: num(r.reset_card_balance),
    voucherBalance: num(r.voucher_balance),
    resetCardUsed: num(r.reset_card_used),
    pointsBalance: num(r.points_balance),
    source: r.source == null ? null : String(r.source),
    createdAt: r.created_at == null ? null : String(r.created_at),
    keyCount: num(r.key_count),
  }));
}

/** 运营设置某用户每日上限(0 = 取消 per-user 覆盖)。返回更新后账户,或 null(账户不存在)。 */
export async function setDailyLimit(
  ssoUserId: string,
  dailyLimit: number,
): Promise<CreditAccount | null> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return null;
  const n = Math.max(0, Math.round(Number(dailyLimit) || 0));
  const p = await pool();
  const { rows } = await p.query(
    `update credit_account set daily_limit = $2, updated_at = now() where sso_user_id = $1 returning ${COLS}`,
    [id, n],
  );
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export interface GrantInput {
  resetCards?: number;
  vouchers?: number;
  points?: number;
}

/** 发放权益(运营手动 / 兑换码兑换):累加重置卡 / 配额券 / 积分余额。原子。 */
export async function grant(ssoUserId: string, g: GrantInput): Promise<CreditAccount> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) throw new Error('grant: ssoUserId 不能为空');
  const rc = Math.max(0, Math.round(g.resetCards ?? 0));
  const vc = Math.max(0, Math.round(g.vouchers ?? 0));
  const pt = Math.max(0, Math.round(g.points ?? 0));
  await ensureAccount(id);
  const p = await pool();
  const { rows } = await p.query(
    `update credit_account set
       reset_card_balance = reset_card_balance + $2,
       voucher_balance = voucher_balance + $3,
       points_balance = points_balance + $4,
       updated_at = now()
     where sso_user_id = $1 returning ${COLS}`,
    [id, rc, vc, pt],
  );
  return rowToAccount(rows[0]);
}

export interface GrantAllResult {
  affected: number;
}

/**
 * 一键给【全部账户】批量发放(单条 UPDATE,影响所有 credit_account 行)。返回受影响行数。
 * 仅作用于已存在账户(新用户由全局默认覆盖,不在此创建);全 0 输入直接短路返回 0。
 */
export async function grantAll(g: GrantInput): Promise<GrantAllResult> {
  const rc = Math.max(0, Math.round(g.resetCards ?? 0));
  const vc = Math.max(0, Math.round(g.vouchers ?? 0));
  const pt = Math.max(0, Math.round(g.points ?? 0));
  if (rc === 0 && vc === 0 && pt === 0) return { affected: 0 };
  const p = await pool();
  const res = await p.query(
    `update credit_account set
       reset_card_balance = reset_card_balance + $1,
       voucher_balance = voucher_balance + $2,
       points_balance = points_balance + $3,
       updated_at = now()`,
    [rc, vc, pt],
  );
  return { affected: res.rowCount ?? 0 };
}

export type ResetCardResult =
  | { ok: true; account: CreditAccount }
  | { ok: false; reason: 'account_not_found' | 'insufficient_reset_cards' };

/**
 * 用户使用 1 张重置卡:消耗 1 个 reset_card_balance → 清零今日 daily_used(恢复满额)。
 * 行级锁保证原子、防并发双花。**一天内不限次**:只要还有卡就能反复刷(卡余额本身即是限额,
 * 用一张扣一张),不再叠加「每业务日只能刷一次」的上限——否则有卡却刷不动,体验上像坏了。
 */
export async function useResetCard(ssoUserId: string): Promise<ResetCardResult> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return { ok: false, reason: 'account_not_found' };
  // 与 consumeDaily/grant 一致:先确保账户行存在,否则刚发放(只建 key 未建账户)的新用户会拿到 account_not_found。
  await ensureAccount(id);
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('begin');
    const today = todayYmd();
    const cur = await client.query(
      `select reset_card_balance, to_char(last_reset_card_date, 'YYYY-MM-DD') as last_reset_card_date
         from credit_account where sso_user_id = $1 for update`,
      [id],
    );
    if (!cur.rows[0]) {
      await client.query('rollback');
      return { ok: false, reason: 'account_not_found' };
    }
    if ((Number(cur.rows[0].reset_card_balance) || 0) <= 0) {
      await client.query('rollback');
      return { ok: false, reason: 'insufficient_reset_cards' };
    }
    // Resetting the projection must also close every receipt that contributed
    // to it. Otherwise a late refund for a pre-reset message can decrement a
    // newer post-reset consume. The account row lock serializes this boundary
    // with consumeDaily's account update, and both mutations commit together.
    await client.query(
      `update credit_daily_reservation
          set refunded_at = now()
        where sso_user_id = $1 and business_date = $2
          and refunded_at is null`,
      [id, today],
    );
    const upd = await client.query(
      `update credit_account set
         reset_card_balance = reset_card_balance - 1,
         reset_card_used = reset_card_used + 1,
         daily_used = 0,
         daily_bonus = (case when daily_date = $2 then daily_bonus else 0 end),
         daily_date = $2,
         last_reset_card_date = $2,
         updated_at = now()
       where sso_user_id = $1 returning ${COLS}`,
      [id, today],
    );
    await client.query('commit');
    return { ok: true, account: rowToAccount(upd.rows[0]) };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type VoucherResult =
  | { ok: true; account: CreditAccount }
  | { ok: false; reason: 'account_not_found' | 'insufficient_vouchers' };

/**
 * 用户使用 1 张配额券:消耗 1 个 voucher_balance → 今日 daily_bonus += bonus(抬高今日上限,次日随窗口清)。
 * 行级锁保证原子。bonus 由调用方传入(默认与每日上限一致 = 再来一整天额度)。
 */
export async function redeemVoucher(ssoUserId: string, bonus: number): Promise<VoucherResult> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) return { ok: false, reason: 'account_not_found' };
  const add = Math.max(1, Math.round(Number(bonus) || 0));
  // 与 consumeDaily/grant 一致:先确保账户行存在,避免刚发放的新用户拿到 account_not_found。
  await ensureAccount(id);
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('begin');
    const cur = await client.query(
      `select voucher_balance from credit_account where sso_user_id = $1 for update`,
      [id],
    );
    if (!cur.rows[0]) {
      await client.query('rollback');
      return { ok: false, reason: 'account_not_found' };
    }
    if ((Number(cur.rows[0].voucher_balance) || 0) <= 0) {
      await client.query('rollback');
      return { ok: false, reason: 'insufficient_vouchers' };
    }
    const upd = await client.query(
      `update credit_account set
         voucher_balance = voucher_balance - 1,
         daily_used = (case when daily_date = $3 then daily_used else 0 end),
         daily_bonus = (case when daily_date = $3 then daily_bonus else 0 end) + $2,
         daily_date = $3,
         updated_at = now()
       where sso_user_id = $1 returning ${COLS}`,
      [id, add, todayYmd()],
    );
    await client.query('commit');
    return { ok: true, account: rowToAccount(upd.rows[0]) };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
