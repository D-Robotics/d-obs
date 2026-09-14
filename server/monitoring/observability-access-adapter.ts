/**
 * D-010 可观测域访问端口。
 *
 * `server/monitoring` / `server/observability` 域内不得直接 import Studio
 * 组合根的 SSO 会话、部署 profile 或 chat principal 模块；组合根在装配期
 * 通过 `configureObservabilityAccess` 注入实现。未注入时所有判定 fail
 * closed：视为多用户公网部署、无匿名本地操作者、无会话用户。
 *
 * 域内调用方一律使用下方同名包装函数，保持调用形状与既有守卫断言稳定。
 */
import type { Request } from 'express';

export interface ObservabilitySessionUser {
  id: string;
  email?: string;
  name?: string;
}

export interface ObservabilityAccessAdapter {
  /** 请求对应的 SSO 会话用户；匿名调用者返回 null。 */
  getSessionSsoUser(request: Request): ObservabilitySessionUser | null;
  /** 多租户 web 部署（web-self-host / web-cloud）返回 true。 */
  isMultiUserWebDeployment(): boolean;
  /** 仅单用户回环绑定部署返回 true（本地操作者即管理员）。 */
  allowsAnonymousLocalOperator(): boolean;
  /** 解析 chat principal 的账号 id；无法解析时返回空串。 */
  resolveChatPrincipalAccountId(request: Request): string;
}

const FAIL_CLOSED_ADAPTER: ObservabilityAccessAdapter = {
  getSessionSsoUser: () => null,
  // 未装配时不猜测本地单用户形态，按最严格的部署形态处理。
  isMultiUserWebDeployment: () => true,
  allowsAnonymousLocalOperator: () => false,
  resolveChatPrincipalAccountId: () => '',
};

let currentAdapter: ObservabilityAccessAdapter | null = null;

/** 组合根装配期调用；重复装配以最后一次为准。 */
export function configureObservabilityAccess(adapter: ObservabilityAccessAdapter): void {
  currentAdapter = adapter;
}

/** 测试专用：恢复 fail-closed 默认。 */
export function resetObservabilityAccessAdapter(): void {
  currentAdapter = null;
}

export function getObservabilityAccessAdapter(): ObservabilityAccessAdapter {
  return currentAdapter ?? FAIL_CLOSED_ADAPTER;
}

export function getSessionSsoUser(req: Request): ObservabilitySessionUser | null {
  return getObservabilityAccessAdapter().getSessionSsoUser(req);
}

export function isMultiUserWebDeployment(): boolean {
  return getObservabilityAccessAdapter().isMultiUserWebDeployment();
}

export function deploymentAllowsAnonymousLocalOperator(): boolean {
  return getObservabilityAccessAdapter().allowsAnonymousLocalOperator();
}

export function resolveChatPrincipalAccountId(req: Request): string {
  return getObservabilityAccessAdapter().resolveChatPrincipalAccountId(req);
}
