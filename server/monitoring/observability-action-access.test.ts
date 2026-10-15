import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveObservabilityActionApprovalScopes as scopes } from './observability-action-access.js';

const admins = { RDK_FLYWHEEL_ADMIN_USER_IDS: 'alice,bob' };
test('approval entitlements default to the authenticated account and never grant token-only subjects', () => {
  assert.deepEqual(scopes('alice', 'studio:alice', admins), ['studio:alice']);
  assert.deepEqual(scopes(undefined, 'studio:local-operator', { ...admins,
    RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES: '{"alice":["studio:bob"]}' }), ['studio:local-operator']);
});
test('explicit known SSO administrators get only their configured scopes', () => {
  const environment = { ...admins, RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES: '{"bob":["studio:alice","studio:alice"]}' };
  assert.deepEqual(scopes('bob', 'studio:bob', environment), ['studio:bob', 'studio:alice']);
  assert.deepEqual(scopes('alice', 'studio:alice', environment), ['studio:alice']);
});
test('unknown or stale SSO subjects and targets cannot acquire approval rights', () => {
  const environment = { ...admins, RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES: '{"outsider":["studio:alice"],"alice":["studio:unknown"]}' };
  assert.deepEqual(scopes('outsider', 'studio:outsider', environment), ['studio:outsider']);
  assert.deepEqual(scopes('alice', 'studio:alice', environment), ['studio:alice']);
});
test('malformed, wildcard, external and unbounded configurations fail closed', () => {
  for (const raw of ['not-json', '[]', 'null', '{"alice":"studio:bob"}', '{"*":["studio:bob"]}',
    '{"alice":["studio:all"]}', '{"alice":["*"]}', '{"alice":["tenant:bob"]}',
    '{"alice":["studio:../bob"]}', '{"constructor":[]}', ' '.repeat(65_537) + '{}',
    JSON.stringify({ alice: Array.from({ length: 17 }, () => 'studio:bob') })]) {
    assert.throws(() => scopes('alice', 'studio:alice', { ...admins, RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES: raw }), /action_approval_scope_config_invalid/);
  }
});
