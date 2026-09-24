/**
 * 运营看板路由共享件：访问守卫、租户作用域、查询参数解析、错误码收敛、
 * trace 访问决策。被 observability-routes.ts 与各域路由文件共享；
 * 只放与具体业务域无关的横切件，域内逻辑留在各自路由文件。
 */
import { type Request, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { getSessionSsoUser, isMultiUserWebDeployment } from './observability-access-adapter.js';
import { isOpsObservabilityConfigured } from './observability-store.js';
import {
  hasInvalidAdminToken,
  hasInvalidTenantToken,
  isOpsAdminRequest,
  resolveOpsActorId,
  resolveTenantMemberAccess,
  resolveTenantTokenAccess,
  type ResolvedTenantAccess,
} from './observability-access.js';
import { SSO_RELAY_TENANT_HEADER } from './sso-relay.js';
import {
  resolveStudioGatewayPublicModel,
  type StudioAgentEnvironment,
} from '../agent/studio-agent-env.js';
import { inspectAdministratorRunLocator } from '../observability/run-locator.js';
import {
  authorizeTelemetryAccess,
  type TelemetryActor,
} from '../observability/governance-access-control.js';
import type { RunObservabilityAccess } from '../observability/run-observability-service.js';
import type { TelemetryRole } from '../../shared/telemetry-data-governance.js';
import {
  telemetryGovernanceProtectedReadsReady,
  telemetryGovernanceRestoreReadiness,
} from '../observability/governance-runtime-service.js';

export const OPS_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Query parsing shared by the read-only compatibility surfaces below. */
export function queryText(query: Record<string, unknown>, key: string, max = 120): string | undefined {
  const value = String(query[key] ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
  return value || undefined;
}

export function queryInteger(
  query: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(query[key] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function queryBoolean(query: Record<string, unknown>, key: string): boolean | undefined {
  const raw = query[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * 回给客户端的错误码。
 *
 * 只放行机器码形状（与行动路由的 safeErrorCode 同规），其余一律用调用方给的兜底码：
 * 直接把 `error.message` 回传会把 Postgres 原始错误（关系名、列名、约束名）泄露给
 * 浏览器——真机验证时 `GET /tenants` 就曾把 `关系 "public.studio_external_probe_status"
 * 不存在` 原样返回。
 */
export function clientErrorCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{2,80}$/.test(raw) ? raw : fallback;
}


export function isProtectedAgentFrontendModel(
  frontendModel: string,
  environment: StudioAgentEnvironment = process.env,
): boolean {
  const protectedModel = resolveStudioGatewayPublicModel(environment);
  return protectedModel.length > 0 && frontendModel === protectedModel;
}

export const resolveOpsActor = resolveOpsActorId;

export function resolveObservabilityAccess(req: Request): {
  enabled: boolean;
  isAdmin: boolean;
  reason?: string;
} {
  // An explicitly supplied token is never allowed to silently degrade into
  // anonymous/local-operator access.  This matters for the token-only
  // bootstrap path, which runs before the global SSO middleware.
  if (hasInvalidAdminToken(req)) {
    return { enabled: false, isAdmin: false, reason: 'not_authorized' };
  }
  // 同理：带了租户凭证却走到非租户面（没有 tenantScopeGate 的路由）时显式拒绝，
  // 不允许它退化成管理员/匿名访问。租户可达的只读面在 tenantScopeGate 里已验证
  // 身份并置 req.opsTenantAccess，走 requireObservabilityAccessTenantAware 的快路径，
  // 不会落到这里。
  if (hasInvalidTenantToken(req)) {
    // 注意与 tenantScopeGate 的 401 `invalid_tenant_token` 区分：这里是「凭证只
    // 在租户面有效，却打到了平台面」，不代表凭证无效。混用会让前端把它当成
    // 身份变化而误报（见 OBS_IDENTITY_FORBIDDEN_CODES）。
    return { enabled: false, isAdmin: false, reason: 'tenant_scope_only' };
  }
  if (!isOpsObservabilityConfigured()) {
    return { enabled: false, isAdmin: false, reason: 'central_store_disabled' };
  }
  if (isOpsAdminRequest(req)) return { enabled: true, isAdmin: true };
  if (isMultiUserWebDeployment()) {
    return { enabled: false, isAdmin: false, reason: 'not_authorized' };
  }
  return { enabled: true, isAdmin: true };
}

/**
 * 运营管理员判定（不依赖中心库开关）：x-admin-token 常量时间匹配，或多用户
 * web 部署下 SSO 会话命中 RDK_FLYWHEEL_ADMIN_USER_IDS；单用户本地/自托管
 * 部署操作者即管理员。会话 Trace 全局视图等跨账号能力复用此闸门。
 */
export { isOpsAdminRequest } from './observability-access.js';

export const requireObservabilityAccess: RequestHandler = (req, res, next) => {
  const access = resolveObservabilityAccess(req);
  if (!access.enabled) {
    res.status(access.reason === 'central_store_disabled' ? 503 : 403).json({
      ok: false,
      error: access.reason,
    });
    return;
  }
  next();
};

/**
 * 租户请求的读权限：不走管理员闸门（x-admin-token/SSO 都可能缺席），只要
 * tenantScopeGate 已经验证出活跃租户身份即放行只读面。管理员请求仍需通过
 * 原有 requireObservabilityAccess。
 */
export const requireObservabilityAccessTenantAware: RequestHandler = (req, res, next) => {
  if (req.opsTenantAccess) {
    if (!isOpsObservabilityConfigured()) {
      res.status(503).json({ ok: false, error: 'central_store_disabled' });
      return;
    }
    next();
    return;
  }
  requireObservabilityAccess(req, res, next);
};

/**
 * 租户只读作用域解析。三种结果：
 *  - null：非租户请求（管理员/SSO），走原有逻辑；
 *  - 'deny'：带了租户凭证（x-tenant-token 或组员头）但匹配不到有效身份 → 401/403 fail-closed；
 *  - 租户身份：请求被限制在该租户数据内（只读面）。
 * 管理员 token 优先于租户身份（探针 token 与 SSO 组员通道都不例外）。
 * SSO 组员通道：主站会话 + x-rdk-obs-tenant 头命中 studio_obs_tenant_members
 * 才放行；带了头但不是组员（或租户停用）→ deny。
 */
declare module 'express-serve-static-core' {
  interface Request {
    opsTenantAccess?: ResolvedTenantAccess;
  }
}

export async function resolveTenantScope(
  req: Request,
): Promise<
  | { deny: true; status: number; error: string; tenant?: undefined }
  | { deny: false; tenant: ResolvedTenantAccess }
  | null
> {
  const tokenHeader = String(req.header('x-tenant-token') ?? '').trim();
  if (tokenHeader) {
    if (isOpsAdminRequest(req)) return null; // admin token 优先
    const tenant = await resolveTenantTokenAccess(req);
    if (tenant) return { deny: false, tenant };
    return { deny: true, status: 401, error: 'invalid_tenant_token' };
  }
  const tenantHeader = String(req.header(SSO_RELAY_TENANT_HEADER) ?? '').trim();
  if (tenantHeader) {
    if (isOpsAdminRequest(req)) return null; // admin/allowlist 管理员走全局视图
    const membership = await resolveTenantMemberAccess(req);
    if (membership) return { deny: false, tenant: membership };
    return { deny: true, status: 403, error: 'not_a_member' };
  }
  return null;
}

export const tenantScopeGate: RequestHandler = async (req, res, next) => {
  const scope = await resolveTenantScope(req);
  if (!scope) {
    next();
    return;
  }
  if (scope.deny) {
    res.status(scope.status).json({ ok: false, error: scope.error });
    return;
  }
  req.opsTenantAccess = scope.tenant;
  next();
};

/**
 * 管理员视角租户解析：管理员请求可用 `?tenant=` 指定某个租户的数据视角
 * （工作台切换器写入）；租户 id 必须真实存在，`platform`/缺省 = 平台全局。
 * 非管理员请求恒返回 null，不带视角语义。与 overview 既有行为同源，供
 * 告警中心等需要同款视角切换的读面复用。
 */
export async function resolveAdminTenantScope(req: Request): Promise<string | null> {
  if (!isOpsAdminRequest(req)) return null;
  const requested = queryText(req.query as Record<string, unknown>, 'tenant', 40);
  if (!requested || requested === 'platform') return null;
  const { listTenants } = await import('./tenant-store.js');
  const tenants = await listTenants().catch(() => []);
  return tenants.some((tenant) => tenant.tenantId === requested) ? requested : null;
}

export const requireOpsMutationGuard: RequestHandler = (req, res, next) => {
  if (req.header('x-rdk-ops-action') !== 'observability') {
    res.status(400).json({ ok: false, error: 'missing_ops_action_guard' });
    return;
  }
  const origin = String(req.header('origin') ?? '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        res.status(403).json({ ok: false, error: 'cross_origin_ops_action_denied' });
        return;
      }
    } catch {
      res.status(403).json({ ok: false, error: 'invalid_origin' });
      return;
    }
  }
  next();
};

export const requireOpsContextGuard: RequestHandler = (req, res, next) => {
  if (req.header('x-rdk-ops-action') !== 'observability-context') {
    res.status(400).json({ ok: false, error: 'missing_ops_context_guard' });
    return;
  }
  const origin = String(req.header('origin') ?? '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        res.status(403).json({ ok: false, error: 'cross_origin_ops_context_denied' });
        return;
      }
    } catch {
      res.status(403).json({ ok: false, error: 'invalid_origin' });
      return;
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Protected trace reads wait for retention/tombstone replay to be ready. */
export const requireTelemetryGovernanceReadiness: RequestHandler = (_req, res, next) => {
  if (telemetryGovernanceProtectedReadsReady()) {
    next();
    return;
  }
  res.status(503).json({
    ok: false,
    error: 'telemetry_governance_unavailable',
    retryable: true,
    readiness: telemetryGovernanceRestoreReadiness(),
  });
};

export function observabilityRequestCorrelationId(req: Request): string {
  const supplied = String(req.header('x-request-id') ?? req.header('x-correlation-id') ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 128);
  return supplied || randomUUID();
}

export function traceAuthorizationRevision(req: Request, actorId: string): string {
  // This is only a stale-session fence; the credential itself is never
  // persisted or returned.  The account scope remains server-derived below.
  return `${actorId}:${String(req.header('cookie') ?? req.header('x-admin-token') ?? '').slice(
    0,
    64,
  )}`;
}

export function resolveTraceAccess(
  req: Request,
  locator: string,
): {
  actor: TelemetryActor | null;
  accessScope: RunObservabilityAccess | null;
  accountScopeId: string;
} {
  const user = getSessionSsoUser(req);
  const admin = isOpsAdminRequest(req);
  const actorId = String(user?.id ?? '').trim() || resolveOpsActor(req);
  let accountScopeId = String(user?.id ?? '').trim();
  let role: TelemetryRole = 'account_owner';

  // An explicit operations administrator may inspect the authenticated scope
  // embedded in an opaque locator.  The locator is AEAD-verified before the
  // selected scope is used; arbitrary query/body scope claims are ignored.
  if (admin && !user?.id?.trim()) {
    accountScopeId = inspectAdministratorRunLocator(locator)?.accountScopeId ?? '';
    if (accountScopeId) role = 'telemetry_administrator';
  } else if (admin && user?.id?.trim()) {
    const inspected = inspectAdministratorRunLocator(locator);
    if (inspected && inspected.accountScopeId !== user.id.trim()) {
      role = 'telemetry_administrator';
      accountScopeId = inspected.accountScopeId;
    }
  }

  if (!actorId || !accountScopeId) return { actor: null, accessScope: null, accountScopeId };
  const actor: TelemetryActor = {
    actorId,
    role,
    // For an administrator this value is the verified locator scope.  The
    // selected scope is still checked by authorizeTelemetryAccess below.
    authenticatedAccountScopeId: accountScopeId,
    entitledAccountScopeIds: [accountScopeId],
    permissions: ['telemetry.read', 'telemetry.advanced_link'],
    authorizationRevision: traceAuthorizationRevision(req, actorId),
  };
  const read = authorizeTelemetryAccess(actor, {
    permission: 'telemetry.read',
    selectedAccountScopeId: accountScopeId,
  });
  const advanced = authorizeTelemetryAccess(actor, {
    permission: 'telemetry.advanced_link',
    selectedAccountScopeId: accountScopeId,
  });
  if (!read.allowed) return { actor, accessScope: null, accountScopeId };
  const accessScope: RunObservabilityAccess =
    role === 'telemetry_administrator'
      ? {
          kind: 'administrator',
          selectedAccountScopeId: read.accountScopeId,
          advancedTraceAccess: advanced.allowed,
        }
      : {
          kind: 'owner',
          accountScopeId: read.accountScopeId,
          advancedTraceAccess: advanced.allowed,
        };
  return { actor, accessScope, accountScopeId: read.accountScopeId };
}
