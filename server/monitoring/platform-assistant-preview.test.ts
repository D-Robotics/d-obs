import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Request } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { inspectPlatformMutation, proposePlatformMutation } from './platform-assistant-authorization.js';
import type { PlatformAssistantArgs, PlatformAssistantOperation } from '../observability/platform-assistant.js';

const operation: PlatformAssistantOperation = { id: 'PUT /api/ops/observability/preview-fixture/:id',
  description: '审阅完整变更参数', group: '测试', method: 'PUT', path: '/api/ops/observability/preview-fixture/:id', mutating: true };
const keys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET', 'RDK_CHAT_CREDITS_DB_URL'];
let saved: Record<string, string | undefined>;
const request = { header: (name: string) => name === 'x-admin-token' ? 'preview-fixture-admin' : undefined, query: {} } as unknown as Request;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'preview-fixture-admin';
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = 'preview-fixture-secret';
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused-preview-fixture.invalid/db';
  configureObservabilityAccess({ getSessionSsoUser: () => ({ id: 'preview-fixture-actor' }),
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetObservabilityAccessAdapter();
});

test('a long proposal retains its trailing target and flags while secrets stay redacted and exact args stay encrypted', () => {
  const args: PlatformAssistantArgs = { params: { id: 'confirmed-target' }, query: { tenant: 'fixture-team' }, body: {
    description: 'reviewable context '.repeat(560),
    apiKey: 'fixture-only-hidden-api-key', accessToken: 'fixture-only-hidden-access-token',
    trailingTarget: 'must-be-visible-after-eight-thousand-characters', allowDeletion: false,
  } };
  const original = JSON.stringify(args);
  const proposal = proposePlatformMutation(request, operation, args);
  assert.ok(proposal.preview.length > 8_000, 'long previews must not stop at the old truncation boundary');
  assert.ok(proposal.preview.indexOf('trailingTarget') > 8_000);
  assert.match(proposal.preview, /must-be-visible-after-eight-thousand-characters/);
  assert.match(proposal.preview, /"allowDeletion": false/);
  assert.match(proposal.preview, /\[REDACTED\]/);
  assert.doesNotMatch(proposal.preview, /fixture-only-hidden-api-key|fixture-only-hidden-access-token/);
  assert.deepEqual(inspectPlatformMutation(request, proposal.token).args, args);
  assert.equal(JSON.stringify(args), original);
});

test('pretty-print expansion falls back to a complete compact preview rather than hiding later parameters', () => {
  let nested: unknown = Array.from({ length: 1_800 }, () => 'x');
  for (let depth = 0; depth < 8; depth++) nested = { nested };
  const args: PlatformAssistantArgs = { params: { id: 'compact-target' }, body: {
    nested, password: 'fixture-only-hidden-password', trailingTarget: 'compact-tail-still-visible', enabled: false,
  } };
  assert.ok(JSON.stringify(args, null, 2).length > 32_000, 'this fixture must exercise pretty-print expansion');
  assert.ok(JSON.stringify(args).length < 16_000, 'the underlying business arguments fit the assistant limit');
  const proposal = proposePlatformMutation(request, operation, args);
  assert.ok(proposal.preview.length <= 32_000);
  assert.doesNotMatch(proposal.preview, /\n/);
  assert.match(proposal.preview, /compact-tail-still-visible/);
  assert.match(proposal.preview, /"enabled":false/);
  assert.doesNotMatch(proposal.preview, /fixture-only-hidden-password/);
  assert.deepEqual(inspectPlatformMutation(request, proposal.token).args, args);
});

test('oversized encrypted authorizations fail closed instead of returning a partial reviewable proposal', () => {
  const args = { body: { description: 'x'.repeat(33_000), trailingTarget: 'never-approved' } };
  assert.throws(() => proposePlatformMutation(request, operation, args), /platform_assistant_authorization_too_large/);
});
