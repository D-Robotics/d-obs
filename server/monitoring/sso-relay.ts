/**
 * 主站 SSO 登录中继与会话校验（D-010：鉴权不复制）。
 *
 * d-obs 不持有账号、密码或 SSO 加密密钥；RDK_SSO_RELAY_BASE_URL 指向主站
 * （rdstudio-web）时，把账号密码登录转发到主站 /api/sso/direct/login，用
 * 主站 /api/sso/me 远程验证会话（会话 id 必须回显一致）。未配置中继时本
 * 模块整体 fail-closed：登录端点 503、会话水合为空操作，现有 ops-token /
 * tenant-token 入口不受影响。
 *
 * 会话验证结果缓存 60 秒（正/负都缓存；网络错误不缓存），供 D-010 访问
 * 适配器的同步 getSessionSsoUser 读取——远程校验是异步的，由路由顶部的
 * 水合中间件先行完成。
 */
import type { Request } from 'express';

import {
  configureObservabilityAccess,
  type ObservabilitySessionUser,
} from './observability-access-adapter.js';

export const SSO_RELAY_SESSION_HEADER = 'x-rdk-sso-session';
/** 组员模式下的当前租户头（工作台租户切换器写入）。 */
export const SSO_RELAY_TENANT_HEADER = 'x-rdk-obs-tenant';
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

export async function verifySsoRelaySession(
  sessionId: string,
  options: { fetchImpl?: typeof fetch; env?: EnvLike } = {},
): Promise<ObservabilitySessionUser | null> {
  const sid = normalizeSsoRelaySessionId(sessionId);
  if (!sid || !ssoRelayConfigured(options.env)) return null;
  const cached = sessionCache.get(sid);
  if (cached && Date.now() - cached.at < SESSION_CACHE_TTL_MS) return cached.user;
  const base = relayBaseUrl(options.env);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${base}/api/sso/me`, {
      headers: {
        accept: 'application/json',
        'user-agent': 'd-obs-sso-relay/1',
        [SSO_RELAY_SESSION_HEADER]: sid,
      },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    // 网络/超时错误不代表会话无效：不缓存负结果，调用方按未登录（fail-closed）处理。
    return null;
  }
  const payload = (await response.json().catch(() => null)) as
    | { user?: { id?: unknown; name?: unknown; email?: unknown } | null; sessionId?: unknown }
    | null;
  if (!response.ok || !payload) return null;
  const id = String(payload.user?.id ?? '').trim();
  // 主站 /api/sso/me 必须回显同一 sessionId 且带出 user.id 才认有效。
  const valid = Boolean(id) && normalizeSsoRelaySessionId(payload.sessionId) === sid;
  const user = valid
    ? {
        id,
        name: String(payload.user?.name ?? '').trim() || undefined,
        email: String(payload.user?.email ?? '').trim() || undefined,
      }
    : null;
  rememberSession(sid, user);
  return user;
}

export async function loginViaSsoRelay(
  input: { userName: string; password: string },
  options: { fetchImpl?: typeof fetch; env?: EnvLike } = {},
): Promise<{ user: SsoRelayUser; sessionId: string }> {
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
    return { user, sessionId };
  }
  const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
  const code =
    String(data?.error ?? '').trim() ||
    (response.status === 429 ? 'login_rate_limited' : 'sso_login_failed');
  throw new SsoRelayError(status, code);
}

export async function logoutViaSsoRelay(
  sessionId: string,
  options: { fetchImpl?: typeof fetch; env?: EnvLike } = {},
): Promise<void> {
  const sid = normalizeSsoRelaySessionId(sessionId);
  forgetSsoRelaySession(sid);
  if (!sid || !ssoRelayConfigured(options.env)) return;
  const base = relayBaseUrl(options.env);
  // 尽力吊销主站会话；失败不影响本地登出（缓存已清，60s 内自然失效）。
  await (options.fetchImpl ?? fetch)(`${base}/api/sso/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'd-obs-sso-relay/1',
      [SSO_RELAY_SESSION_HEADER]: sid,
    },
    body: '{}',
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  }).catch(() => undefined);
}

// ---- 登录防爆破（进程内存限流，按客户端地址） ----

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export function ssoRelayLoginRateAllow(
  ip: string,
  options: { env?: EnvLike; now?: () => number } = {},
): boolean {
  const max = Math.max(
    1,
    Number(options.env?.RDK_SSO_RELAY_LOGIN_RATE_MAX ?? process.env.RDK_SSO_RELAY_LOGIN_RATE_MAX) ||
      LOGIN_RATE_DEFAULT_MAX,
  );
  const now = (options.now ?? Date.now)();
  const key = String(ip || 'unknown').slice(0, 64);
  const entry = loginAttempts.get(key);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/** 测试专用：清空登录限流计数。 */
export function resetSsoRelayLoginRateForTest(): void {
  loginAttempts.clear();
}

// ---- 请求水合 + D-010 访问适配器装配 ----

/** 请求带 SSO 会话头时，先远程验证并写入同步缓存；路由守卫随后同步读取。 */
export async function hydrateSsoRelaySession(req: Request): Promise<void> {
  const sid = normalizeSsoRelaySessionId(req.header(SSO_RELAY_SESSION_HEADER));
  if (!sid || !ssoRelayConfigured()) return;
  await verifySsoRelaySession(sid).catch(() => null);
}

/**
 * 组合根装配：把中继会话解析注入 D-010 访问端口。standalone 部署视为多用户
 * 公网形态（不允许匿名本地操作者），与未装配时的 fail-closed 默认一致；
 * 区别仅在于带有效主站会话头的请求可以解析出 SSO 用户（管理员白名单、
 * 审计署名、组员作用域由此点亮）。
 */
export function configureSsoRelayObservabilityAccess(): void {
  configureObservabilityAccess({
    getSessionSsoUser: (req) => {
      const sid = normalizeSsoRelaySessionId(req.header(SSO_RELAY_SESSION_HEADER));
      return sid ? getSsoRelaySessionUser(sid) : null;
    },
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: (req) => {
      const sid = normalizeSsoRelaySessionId(req.header(SSO_RELAY_SESSION_HEADER));
      return sid ? (getSsoRelaySessionUser(sid)?.id ?? '') : '';
    },
  });
}
