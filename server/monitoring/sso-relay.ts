/**
 * 主站 SSO 登录中继与会话校验（D-010：鉴权不复制）。
 *
 * d-obs 不持有账号、密码或 SSO 加密密钥；RDK_SSO_RELAY_BASE_URL 指向主站
 * （rdstudio-web）时，把账号密码登录转发到主站 /api/sso/direct/login，用
 * 主站 /api/sso/me 远程验证会话。未配置中继时本模块整体 fail-closed：
 * 登录端点 503、会话水合为空操作，现有 ops-token / tenant-token 入口不受影响。
 *
 * 会话按候选链解析（顺序与主站 getSessionIdCandidatesFromRequest 一致）：
 *   1. `x-rdk-sso-session` 头；
 *   2. `rdk_sso_session` Cookie —— 与主站同源部署时的**免登**通道（Cookie 是
 *      `Path=/; HttpOnly`，浏览器会自动把它发给 /dobs/*）；
 *   3. `x-rdk-sso-session-cloud` 云镜像 → 主站用中央会话重建本地会话，回显
 *      新的 sessionId（桌面/嵌入式形态本地 Cookie 带不到时走这条）。
 * 转发给主站时只带 SSO 白名单内的 Cookie，不顺带外发同源其它 Cookie；登录成功
 * 时把主站下发的 Set-Cookie 透传回浏览器，使 d-obs 登录同时成为主站登录态。
 *
 * 会话验证结果缓存 60 秒（正/负都缓存；网络错误不缓存），供 D-010 访问
 * 适配器的同步 getSessionSsoUser 读取——远程校验是异步的，由路由顶部的
 * 水合中间件先行完成并把身份挂到 req 上。
 */
import { createHash } from 'node:crypto';

import type { Request } from 'express';

import {
  configureObservabilityAccess,
  type ObservabilitySessionUser,
} from './observability-access-adapter.js';

export const SSO_RELAY_SESSION_HEADER = 'x-rdk-sso-session';
/** 组员模式下的当前租户头（工作台租户切换器写入）。 */
export const SSO_RELAY_TENANT_HEADER = 'x-rdk-obs-tenant';
/**
 * 主站会话的云镜像头（与主站 `CLOUD_SESSION_HEADER` 同名）。桌面/嵌入式形态下
 * 本地 Cookie 带不到，主站靠这个头做「中央会话懒恢复」；d-obs 原样转发即可。
 */
export const SSO_RELAY_CLOUD_SESSION_HEADER = 'x-rdk-sso-session-cloud';
/**
 * 主站 HttpOnly 会话 Cookie（`Path=/`）。与主站同源部署时浏览器会自动把它发给
 * `/dobs/*`，因此它是**免登**通道：用户在主站登录过，d-obs 无需再问一次密码。
 * 取值是 64-hex 本地会话 id，与 `x-rdk-sso-session` 头同源同义。
 */
export const SSO_RELAY_SESSION_COOKIE = 'rdk_sso_session';
/**
 * 主站 web-cloud 加密会话 Cookie。取值是不透明密文（非 64-hex），d-obs 不解析、
 * 只随 Cookie 转发给主站，由主站自己解码。
 */
export const SSO_RELAY_CLOUD_SESSION_COOKIE = 'rdk_sso_web_session';
/** 允许转发给主站 / 回写给浏览器的 Cookie 名（白名单，避免顺带外发无关 Cookie）。 */
const SSO_RELAY_FORWARDED_COOKIES = [SSO_RELAY_SESSION_COOKIE, SSO_RELAY_CLOUD_SESSION_COOKIE];
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/i;
const SESSION_CACHE_TTL_MS = 60_000;
const RELAY_TIMEOUT_MS = 10_000;
const LOGIN_RATE_WINDOW_MS = 15 * 60_000;
const LOGIN_RATE_DEFAULT_MAX = 20;
export const ssoRelayLoginRateDefaultMaxForTest = (): number => LOGIN_RATE_DEFAULT_MAX;

type EnvLike = Record<string, string | undefined>;

export class SsoRelayError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = 'SsoRelayError';
  }
}

export interface SsoRelayUser {
  id: string;
  name?: string;
  email?: string;
}

export function ssoRelayConfigured(env: EnvLike = process.env): boolean {
  return /^https?:\/\//i.test(relayBaseUrl(env));
}

function relayBaseUrl(env: EnvLike = process.env): string {
  return String(env.RDK_SSO_RELAY_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

export function normalizeSsoRelaySessionId(value: unknown): string {
  const sid = String(value ?? '').trim();
  return SESSION_ID_PATTERN.test(sid) ? sid.toLowerCase() : '';
}

// ---- 请求会话候选链（照搬主站 getSessionIdCandidatesFromRequest 的顺序） ----

/** 从 Cookie 头取原始值（不解码，保持浏览器原样转发）。 */
function rawRelayCookie(cookieHeader: string, name: string): string {
  const match = String(cookieHeader ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1].trim() : '';
}

function decodedRelayCookie(cookieHeader: string, name: string): string {
  const raw = rawRelayCookie(cookieHeader, name);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** 只把 SSO 相关的 Cookie 转发给主站，避免顺带外发同一 origin 的其它 Cookie。 */
export function ssoRelayUpstreamCookieHeader(req: Request): string {
  const cookieHeader = String(req.header('cookie') ?? '');
  if (!cookieHeader) return '';
  const pairs: string[] = [];
  for (const name of SSO_RELAY_FORWARDED_COOKIES) {
    const raw = rawRelayCookie(cookieHeader, name);
    if (raw) pairs.push(`${name}=${raw}`);
  }
  return pairs.join('; ');
}

/**
 * 本地会话 id 候选：`x-rdk-sso-session` 头 → `rdk_sso_session` Cookie，顺序与主站
 * 一致（主站 `pickBestSessionId` 取第一个**活跃**候选；d-obs 取第一个能通过主站
 * 校验的候选，语义等价）。
 *
 * 头里出现多个逗号分隔值时视为语义不明（典型成因是前端把镜像会话和本次登录会话
 * 写成了两个大小写不同的头，被 fetch 合并成一个值）：此时**忽略该头**并退回 Cookie
 * 通道，而不是猜哪一个——猜错会把 A 的主站会话当成 B 的 d-obs 登录态。
 */
export function ssoRelaySessionCandidates(req: Request): string[] {
  const candidates: string[] = [];
  const push = (raw: unknown) => {
    const sid = normalizeSsoRelaySessionId(raw);
    if (sid && !candidates.includes(sid)) candidates.push(sid);
  };
  const rawHeader = req.header(SSO_RELAY_SESSION_HEADER);
  const headerValues = String(rawHeader ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (headerValues.length === 1) push(headerValues[0]);
  push(decodedRelayCookie(String(req.header('cookie') ?? ''), SSO_RELAY_SESSION_COOKIE));
  return candidates;
}

/** 云镜像会话 id（桌面/嵌入式懒恢复凭据）；Cookie 形态由主站自己解码，这里不管。 */
export function ssoRelayCloudSessionId(req: Request): string {
  return normalizeSsoRelaySessionId(req.header(SSO_RELAY_CLOUD_SESSION_HEADER));
}

/** 同步取「本请求首选会话 id」：优先水合结果，其次候选链第一个。 */
export function ssoRelayRequestSessionId(req: Request): string {
  const attached = req.opsSsoSession;
  if (attached?.sessionId) return attached.sessionId;
  return ssoRelaySessionCandidates(req)[0] ?? '';
}

/**
 * 同步取「本请求已认证的 SSO 用户」：优先水合中间件挂载的结果；水合未跑（测试或
 * 其它挂载点）时退回按候选链查本地缓存。
 */
export function ssoRelayRequestUser(req: Request): ObservabilitySessionUser | null {
  if (req.opsSsoHydrated) return req.opsSsoSession?.user ?? null;
  const sid = ssoRelaySessionCandidates(req)[0];
  return sid ? getSsoRelaySessionUser(sid) : null;
}

// ---- 会话校验缓存 ----

interface CachedSession {
  user: ObservabilitySessionUser | null;
  at: number;
}
const sessionCache = new Map<string, CachedSession>();

export function getSsoRelaySessionUser(sessionId: string): ObservabilitySessionUser | null {
  const sid = normalizeSsoRelaySessionId(sessionId);
  if (!sid) return null;
  const cached = sessionCache.get(sid);
  if (!cached || Date.now() - cached.at >= SESSION_CACHE_TTL_MS) return null;
  return cached.user;
}

export function forgetSsoRelaySession(sessionId: string): void {
  const sid = normalizeSsoRelaySessionId(sessionId);
  if (sid) sessionCache.delete(sid);
}

/** 测试专用：清空会话缓存。 */
export function resetSsoRelaySessionCacheForTest(): void {
  sessionCache.clear();
}

function rememberSession(sid: string, user: ObservabilitySessionUser | null): void {
  sessionCache.set(sid, { user, at: Date.now() });
  if (sessionCache.size > 2048) {
    // 上限保护：超限时丢弃最旧的一半，避免长期运行内存无界增长。
    const entries = [...sessionCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of entries.slice(0, Math.floor(entries.length / 2))) {
      sessionCache.delete(key);
    }
  }
}

interface SsoMePayload {
  user?: { id?: unknown; name?: unknown; email?: unknown } | null;
  sessionId?: unknown;
}

function toSessionUser(payload: SsoMePayload | null): ObservabilitySessionUser | null {
  const id = String(payload?.user?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    name: String(payload?.user?.name ?? '').trim() || undefined,
    email: String(payload?.user?.email ?? '').trim() || undefined,
  };
}

/**
 * 打一次主站 `/api/sso/me`。
 *
 * 同时带上：会话头（显式候选）、云镜像头（桌面懒恢复）、以及白名单内的 SSO
 * Cookie（同源浏览器形态下会话在 HttpOnly Cookie 里，主站自己会解析；web-cloud
 * 加密 Cookie 也由此透传，d-obs 不解析密文）。
 */
async function fetchSsoMe(
  options: { fetchImpl?: typeof fetch; env?: EnvLike; cookieHeader?: string; cloudSessionId?: string },
  sessionId: string,
): Promise<{ ok: boolean; payload: SsoMePayload | null }> {
  const base = relayBaseUrl(options.env);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'd-obs-sso-relay/1',
  };
  if (sessionId) headers[SSO_RELAY_SESSION_HEADER] = sessionId;
  if (options.cloudSessionId) headers[SSO_RELAY_CLOUD_SESSION_HEADER] = options.cloudSessionId;
  if (options.cookieHeader) headers.cookie = options.cookieHeader;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/api/sso/me`, {
      headers,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as SsoMePayload | null;
    return { ok: response.ok, payload };
  } catch {
    // 网络/超时错误不代表会话无效；调用方按未登录（fail-closed）处理，且不缓存负结果。
    return { ok: false, payload: null };
  }
}

export async function verifySsoRelaySession(
  sessionId: string,
  options: { fetchImpl?: typeof fetch; env?: EnvLike; cookieHeader?: string } = {},
): Promise<ObservabilitySessionUser | null> {
  const sid = normalizeSsoRelaySessionId(sessionId);
  if (!sid || !ssoRelayConfigured(options.env)) return null;
  const cached = sessionCache.get(sid);
  if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.user;
  const { ok, payload } = await fetchSsoMe(options, sid);
  if (!ok || !payload) return null;
  // 主站 /api/sso/me 必须回显同一 sessionId 且带出 user.id 才认有效。
  const user = normalizeSsoRelaySessionId(payload.sessionId) === sid ? toSessionUser(payload) : null;
  rememberSession(sid, user);
  return user;
}

/**
 * 云镜像懒恢复：桌面/嵌入式形态下浏览器没有本地会话 Cookie，只有云会话凭据。
 * 主站 `/api/sso/me` 会用中央会话重建本地会话并回显**新**的 sessionId，因此这里
 * 不能要求回显等于入参——只要求回显出合法的 64-hex 会话 id 且带 user.id，与主站
 * `tryGetSessionSsoUserAsync` 的恢复契约一致。恢复出的会话写入缓存，后续请求按
 * 本地会话走常规校验。
 */
export async function recoverSsoRelayCloudSession(
  cloudSessionId: string,
  options: { fetchImpl?: typeof fetch; env?: EnvLike; cookieHeader?: string } = {},
): Promise<{ sessionId: string; user: ObservabilitySessionUser } | null> {
  const cloud = normalizeSsoRelaySessionId(cloudSessionId);
  if (!cloud || !ssoRelayConfigured(options.env)) return null;
  const { ok, payload } = await fetchSsoMe({ ...options, cloudSessionId: cloud }, cloud);
  if (!ok || !payload) return null;
  const recovered = normalizeSsoRelaySessionId(payload.sessionId);
  const user = toSessionUser(payload);
  if (!recovered || !user) return null;
  rememberSession(recovered, user);
  return { sessionId: recovered, user };
}

/**
 * 完整解析一个请求的 SSO 身份：先按候选链（头 → Cookie）逐个校验，全部不通过时
 * 再尝试云镜像懒恢复。返回 null = 未登录（调用方 fail-closed）。
 */
export async function resolveSsoRelaySessionUser(
  req: Request,
  options: { fetchImpl?: typeof fetch; env?: EnvLike } = {},
): Promise<{ sessionId: string; user: ObservabilitySessionUser } | null> {
  if (!ssoRelayConfigured(options.env)) return null;
  const cookieHeader = ssoRelayUpstreamCookieHeader(req);
  for (const sid of ssoRelaySessionCandidates(req)) {
    const user = await verifySsoRelaySession(sid, { ...options, cookieHeader });
    if (user) return { sessionId: sid, user };
  }
  const cloud = ssoRelayCloudSessionId(req);
  if (cloud) {
    const recovered = await recoverSsoRelayCloudSession(cloud, { ...options, cookieHeader });
    if (recovered) return recovered;
  }
  return null;
}

/**
 * 取上游响应的 Set-Cookie，只保留白名单内（SSO 会话）的 Cookie。
 * 主站登录成功时会把 `rdk_sso_session` 写进浏览器；d-obs 与主站同源，把这个
 * Set-Cookie 透传给浏览器即可让「d-obs 登录一次」同时成为「主站已登录」，
 * 也让 iframe / 整表导出这类没有自定义头的请求重新带上凭证。
 */
function forwardedSetCookies(response: Response): string[] {
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  return raw
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .filter((value) => {
      const name = value.slice(0, value.indexOf('=')).trim().toLowerCase();
      return SSO_RELAY_FORWARDED_COOKIES.includes(name);
    });
}

export async function loginViaSsoRelay(
  input: { userName: string; password: string },
  options: { fetchImpl?: typeof fetch; env?: EnvLike } = {},
): Promise<{ user: SsoRelayUser; sessionId: string; setCookies: string[] }> {
  if (!ssoRelayConfigured(options.env)) throw new SsoRelayError(503, 'sso_relay_disabled');
  const base = relayBaseUrl(options.env);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${base}/api/sso/direct/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'd-obs-sso-relay/1',
      },
      body: JSON.stringify({ method: 'account', userName: input.userName, password: input.password }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    throw new SsoRelayError(503, 'sso_relay_unavailable');
  }
  const data = (await response.json().catch(() => null)) as
    | {
        ok?: boolean;
        sessionId?: unknown;
        user?: { id?: unknown; name?: unknown; email?: unknown } | null;
        error?: unknown;
      }
    | null;
  const sessionId = normalizeSsoRelaySessionId(data?.sessionId);
  const id = String(data?.user?.id ?? '').trim();
  if (response.ok && data?.ok === true && sessionId && id) {
    const user: SsoRelayUser = {
      id,
      name: String(data.user?.name ?? '').trim() || undefined,
      email: String(data.user?.email ?? '').trim() || undefined,
    };
    // 登录即写缓存：紧跟其后的 /api/ops/auth/me 不再打一次主站。
    rememberSession(sessionId, user);
    return { user, sessionId, setCookies: forwardedSetCookies(response) };
  }
  const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
  const code =
    String(data?.error ?? '').trim() ||
    (response.status === 429 ? 'login_rate_limited' : 'sso_login_failed');
  throw new SsoRelayError(status, code);
}

export async function logoutViaSsoRelay(
  sessionId: string,
  options: { fetchImpl?: typeof fetch; env?: EnvLike; cookieHeader?: string } = {},
): Promise<void> {
  const sid = normalizeSsoRelaySessionId(sessionId);
  forgetSsoRelaySession(sid);
  if (!sid || !ssoRelayConfigured(options.env)) return;
  const base = relayBaseUrl(options.env);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'd-obs-sso-relay/1',
    [SSO_RELAY_SESSION_HEADER]: sid,
  };
  // 一并带上 Cookie 通道：主站登出会把它看到的每个候选会话都围栏掉，只发头会
  // 留下 Cookie 那份镜像在之后复活（主站 routes-session 的登出语义）。
  if (options.cookieHeader) headers.cookie = options.cookieHeader;
  // 尽力吊销主站会话；失败不影响本地登出（缓存已清，60s 内自然失效）。
  await (options.fetchImpl ?? fetch)(`${base}/api/sso/logout`, {
    method: 'POST',
    headers,
    body: '{}',
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  }).catch(() => undefined);
}

// ---- 登录防爆破（进程内存限流） ----

/**
 * 两个维度的固定窗口桶：
 *  - 按客户端地址（`RDK_SSO_RELAY_LOGIN_RATE_MAX`，默认 20/15min）：挡撞库喷洒；
 *  - 按目标账号（`RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX`，默认 10/15min）：挡针对
 *    单个账号的暴力破解，即使攻击者换 IP 也仍然受限。
 *
 * 地址维度**必须**靠 `trust proxy` 拿到真实客户端地址（见 server/trusted-proxy.ts）；
 * 否则反代下所有请求共用回环地址，额度会退化成全平台共享。
 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_RATE_ACCOUNT_DEFAULT_MAX = 10;
export const ssoRelayLoginAccountRateDefaultMaxForTest = (): number =>
  LOGIN_RATE_ACCOUNT_DEFAULT_MAX;

function rateLimitMax(
  raw: string | undefined,
  fallback: number,
): number {
  return Math.max(1, Number(raw) || fallback);
}

/** 账号维度只存哈希，避免把账号名长期留在进程内存里。 */
function accountBucketKey(userName: string): string {
  return `acct:${createHash('sha256').update(userName.trim().toLowerCase()).digest('hex').slice(0, 32)}`;
}

function consumeBucket(key: string, max: number, now: number): boolean {
  const entry = loginAttempts.get(key);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/**
 * 登录尝试放行判定。两个维度都必须在额度内。
 * 不传 `userName` 时只计地址维度（供只需要地址语义的调用方/测试使用）。
 */
export function ssoRelayLoginRateAllow(
  ip: string,
  options: { env?: EnvLike; now?: () => number; userName?: string } = {},
): boolean {
  const env = options.env ?? process.env;
  const ipMax = rateLimitMax(
    env.RDK_SSO_RELAY_LOGIN_RATE_MAX ?? process.env.RDK_SSO_RELAY_LOGIN_RATE_MAX,
    LOGIN_RATE_DEFAULT_MAX,
  );
  const accountMax = rateLimitMax(
    env.RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX ??
      process.env.RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX,
    LOGIN_RATE_ACCOUNT_DEFAULT_MAX,
  );
  const now = (options.now ?? Date.now)();
  const key = String(ip || 'unknown').slice(0, 64);
  // 两个桶都要消费：任一超限即拒绝（否则先通过的桶会被后续请求刷爆）。
  const ipAllowed = consumeBucket(key, ipMax, now);
  const userName = String(options.userName ?? '').trim();
  if (!userName) return ipAllowed;
  const accountAllowed = consumeBucket(accountBucketKey(userName), accountMax, now);
  return ipAllowed && accountAllowed;
}

/** 测试专用：清空登录限流计数。 */
export function resetSsoRelayLoginRateForTest(): void {
  loginAttempts.clear();
}

// ---- 请求水合 + D-010 访问适配器装配 ----

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * 水合中间件解析出的 SSO 身份（同步适配器读取它，避免在守卫里做异步校验）。
     * 未认证/水合失败时为 undefined。
     */
    opsSsoSession?: { sessionId: string; user: ObservabilitySessionUser };
    /** 水合中间件是否已跑过（区分「确认未登录」与「还没查」）。 */
    opsSsoHydrated?: boolean;
  }
}

/**
 * 请求水合：按候选链（`x-rdk-sso-session` 头 → `rdk_sso_session` Cookie → 云镜像
 * 懒恢复）解析会话并挂到 req 上；路由守卫随后同步读取。
 *
 * 未配置中继、无任何候选、校验失败都只是「未登录」，不抛错也不阻断请求——
 * fail-closed 由各守卫完成。
 */
export async function hydrateSsoRelaySession(req: Request): Promise<void> {
  if (!ssoRelayConfigured()) {
    req.opsSsoHydrated = true;
    return;
  }
  const resolved = await resolveSsoRelaySessionUser(req).catch(() => null);
  if (resolved) req.opsSsoSession = resolved;
  req.opsSsoHydrated = true;
}

/**
 * 组合根装配：把中继会话解析注入 D-010 访问端口。standalone 部署视为多用户
 * 公网形态（不允许匿名本地操作者），与未装配时的 fail-closed 默认一致；
 * 区别仅在于带有效主站会话（头或同源 Cookie）的请求可以解析出 SSO 用户
 * （管理员白名单、审计署名、组员作用域由此点亮）。
 */
export function configureSsoRelayObservabilityAccess(): void {
  configureObservabilityAccess({
    getSessionSsoUser: (req) => ssoRelayRequestUser(req),
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: (req) => ssoRelayRequestUser(req)?.id ?? '',
  });
}
