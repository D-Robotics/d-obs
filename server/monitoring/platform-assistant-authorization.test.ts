import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Request } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { inspectPlatformMutation, proposePlatformMutation } from './platform-assistant-authorization.js';
import type { PlatformAssistantOperation } from '../observability/platform-assistant.js';

const operation: PlatformAssistantOperation = {
  id: 'PATCH /api/ops/observability/fixture/:id', description: '调整测试对象', group: '测试',
  path: '/api/ops/observability/fixture/:id', method: 'PATCH', mutating: true,
};
const args = { params: { id: 'object-1' }, query: { tenant: 'team-a' }, body: { threshold: 12, apiKey: 'fixture-only-secret', tokenBudget: 1200, accessToken: 'fixture-access-token' } };
const keys = ['RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET', 'RDK_OBSERVABILITY_LOCATOR_SECRET', 'RDK_CREDITS_ADMIN_TOKEN', 'RDK_CHAT_CREDITS_DB_URL'];
let saved: Record<string, string | undefined>;

function request(overrides: Record<string, string> = {}, tenantId?: string, role: 'owner' | 'member' = 'owner', view = ''): Request {
  const headers = { 'x-admin-token': 'fixture-admin-token', 'fixture-actor': 'actor-a', ...overrides };
  return {
    header: (name: string) => headers[name.toLowerCase() as keyof typeof headers], query: view ? { tenant: view } : {},
    opsTenantAccess: tenantId ? { tenantId, displayName: tenantId, source: 'member', role } : undefined,
  } as unknown as Request;
}

beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = 'fixture-authorization-secret';
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin-token';
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused-fixture.invalid/db';
  delete process.env.RDK_OBSERVABILITY_LOCATOR_SECRET;
  configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetObservabilityAccessAdapter();
});

test('proposal encrypts exact arguments, redacts its preview and leaves input untouched', () => {
  const original = JSON.stringify(args);
  const proposal = proposePlatformMutation(request(), operation, args, 100_000);
  assert.deepEqual(inspectPlatformMutation(request(), proposal.token, 100_001).args, args);
  assert.equal(proposal.expiresAt, 400_000);
  assert.match(proposal.preview, /\[REDACTED\]/);
  assert.doesNotMatch(proposal.preview, /fixture-only-secret/);
  assert.doesNotMatch(proposal.preview, /fixture-access-token/);
  assert.match(proposal.preview, /"tokenBudget": 1200/);
  assert.doesNotMatch(Buffer.from(proposal.token, 'base64url').toString('utf8'), /fixture-only-secret|threshold/);
  assert.equal(JSON.stringify(args), original);
});

test('authorization binds actor, credentials, tenant, role and selected tenant view', () => {
  const req = request({}, 'team-a', 'owner', 'team-a');
  const proposal = proposePlatformMutation(req, operation, args);
  const mismatches = [
    request({ 'fixture-actor': 'actor-b' }, 'team-a', 'owner', 'team-a'),
    request({ 'x-admin-token': 'different-credential' }, 'team-a', 'owner', 'team-a'),
    request({}, 'team-b', 'owner', 'team-a'),
    request({}, 'team-a', 'member', 'team-a'),
    request({}, 'team-a', 'owner', 'team-b'),
  ];
  for (const other of mismatches) assert.throws(() => inspectPlatformMutation(other, proposal.token), /invalid_or_expired_authorization/);
  assert.equal(inspectPlatformMutation(req, proposal.token).operationId, operation.id);
});

test('expired, malformed and cryptographically tampered tokens are rejected', () => {
  const req = request();
  const proposal = proposePlatformMutation(req, operation, args, 100_000);
  const bytes = Buffer.from(proposal.token, 'base64url'); bytes[bytes.length - 1] ^= 1;
  for (const token of [bytes.toString('base64url'), '', null, 'x'.repeat(32_001), 'invalid/token']) {
    assert.throws(() => inspectPlatformMutation(req, token, 100_001), /invalid_or_expired_authorization/);
  }
  assert.throws(() => inspectPlatformMutation(req, proposal.token, proposal.expiresAt), /invalid_or_expired_authorization/);
});

test('blank dedicated secrets fall back, while missing DB or all secrets fails closed', () => {
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = '  ';
  process.env.RDK_OBSERVABILITY_LOCATOR_SECRET = '';
  assert.ok(proposePlatformMutation(request(), operation, args).token);
  delete process.env.RDK_CREDITS_ADMIN_TOKEN;
  assert.throws(() => proposePlatformMutation(request(), operation, args), /authorization_unconfigured/);
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  assert.throws(() => proposePlatformMutation(request(), operation, args), /authorization_store_unavailable/);
  assert.throws(() => proposePlatformMutation(request(), { ...operation, mutating: false }, args), /invalid_authorization/);
});
