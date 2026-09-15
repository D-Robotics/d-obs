/**
 * 运营鉴权回归测试：fail-closed 语义、timing-safe 比对、SSO 会话优先级、
 * 租户 token 显式拒绝。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Request } from 'express';

import {
  hasInvalidAdminToken,
  hasInvalidTenantToken,
  isOpsAdminRequest,
  resolveOpsActorId,
} from './observability-access.js';
import {
  configureObservabilityAccess,
  resetObservabilityAccessAdapter,
  type ObservabilityAccessAdapter,
} from './observability-access-adapter.js';

const ENV_KEYS = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_FLYWHEEL_ADMIN_USER_IDS'] as const;
let savedEnv: Record<string, string | undefined>;

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function fakeRequest(headers: Record<string, string>): Request {
  return {
    headers,
    header(name: string): string | undefined {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

const loopbackAdapter: ObservabilityAccessAdapter = {
  getSessionSsoUser: () => null,
  isMultiUserWebDeployment: () => false,
  allowsAnonymousLocalOperator: () => true,
  resolveChatPrincipalAccountId: () => '',
};

const publicAdapter: ObservabilityAccessAdapter = {
  getSessionSsoUser: () => null,
  isMultiUserWebDeployment: () => true,
  allowsAnonymousLocalOperator: () => false,
  resolveChatPrincipalAccountId: () => '',
};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  resetObservabilityAccessAdapter();
});

afterEach(() => {
  setEnv(savedEnv);
  resetObservabilityAccessAdapter();
});

test('未配置 admin token 时 fail-closed：任何 token 都不匹配', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: undefined });
  configureObservabilityAccess(publicAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-admin-token': 'anything' })), false);
  assert.equal(isOpsAdminRequest(fakeRequest({})), false);
});

test('正确 token 放行；错误 token 拒绝且标记 invalid', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) });
  configureObservabilityAccess(publicAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-admin-token': 'a'.repeat(64) })), true);
  const wrong = fakeRequest({ 'x-admin-token': 'b'.repeat(64) });
  assert.equal(isOpsAdminRequest(wrong), false);
  assert.equal(hasInvalidAdminToken(wrong), true);
  assert.equal(hasInvalidAdminToken(fakeRequest({})), false);
});

test('token 长度不一致不抛异常（timingSafeEqual 前置长度守卫）', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) });
  configureObservabilityAccess(publicAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-admin-token': 'short' })), false);
  assert.equal(hasInvalidAdminToken(fakeRequest({ 'x-admin-token': 'short' })), true);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-admin-token': '' })), false);
});

test('多用户部署：无 token 无会话一律拒绝；SSO 白名单用户放行', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: undefined, RDK_FLYWHEEL_ADMIN_USER_IDS: 'u-1' });
  const multiUserAdapter: ObservabilityAccessAdapter = {
    ...publicAdapter,
    getSessionSsoUser: (req) =>
      (req.headers['x-test-user'] as string | undefined) === 'u-1'
        ? { id: 'u-1', email: 'ops@example.com' }
        : (req.headers['x-test-user'] as string | undefined) === 'u-2'
          ? { id: 'u-2' }
          : null,
  };
  configureObservabilityAccess(multiUserAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({})), false);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-test-user': 'u-2' })), false);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-test-user': 'u-1' })), true);
});

test('浏览器残留错误 token 不遮蔽有效 SSO 会话', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64), RDK_FLYWHEEL_ADMIN_USER_IDS: 'u-1' });
  const staleTokenButSession = fakeRequest({ 'x-admin-token': 'stale-wrong-token', 'x-test-user': 'u-1' });
  configureObservabilityAccess({
    ...publicAdapter,
    getSessionSsoUser: () => ({ id: 'u-1' }),
  });
  assert.equal(hasInvalidAdminToken(staleTokenButSession), false);
  assert.equal(isOpsAdminRequest(staleTokenButSession), true);
});

test('单用户回环部署允许匿名本地操作者', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: undefined });
  configureObservabilityAccess(loopbackAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({})), true);
});

test('带错误 token 时回环部署同样拒绝（显式凭证不得降级为匿名）', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) });
  configureObservabilityAccess(loopbackAdapter);
  assert.equal(isOpsAdminRequest(fakeRequest({ 'x-admin-token': 'wrong' })), false);
});

test('resolveOpsActorId：SSO 用户 > admin token > 匿名 ops-admin', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) });
  configureObservabilityAccess({
    ...publicAdapter,
    getSessionSsoUser: (req) =>
      req.headers['x-test-user'] ? { id: 'u-1', email: 'ops@example.com' } : null,
  });
  assert.equal(resolveOpsActorId(fakeRequest({ 'x-test-user': '1' })), 'ops@example.com');
  assert.equal(resolveOpsActorId(fakeRequest({ 'x-admin-token': 'a'.repeat(64) })), 'admin-token');
  // 未装配 adapter（fail-closed 默认）时无会话；带有效 token 仍是 admin-token。
  resetObservabilityAccessAdapter();
  assert.equal(resolveOpsActorId(fakeRequest({ 'x-admin-token': 'a'.repeat(64) })), 'admin-token');
  // 单用户回环匿名操作者归为通用 ops-admin。
  configureObservabilityAccess(loopbackAdapter);
  assert.equal(resolveOpsActorId(fakeRequest({})), 'ops-admin');
});

test('租户 token：带错 token 且无会话/管理员凭证时显式拒绝', () => {
  setEnv({ RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) });
  configureObservabilityAccess(publicAdapter);
  assert.equal(hasInvalidTenantToken(fakeRequest({})), false);
  assert.equal(hasInvalidTenantToken(fakeRequest({ 'x-tenant-token': 'not-a-token' })), true);
  // 租户 token 通道与管理员互斥：值恰好等于 admin token 也按管理员处理。
  assert.equal(hasInvalidTenantToken(fakeRequest({ 'x-tenant-token': 'a'.repeat(64) })), false);
});
