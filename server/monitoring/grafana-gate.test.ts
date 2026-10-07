import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRAFANA_GATE_TTL_SECONDS,
  issueGrafanaGate,
  verifyGrafanaGate,
} from './grafana-gate.js';

const SECRET = 'grafana-test-secret-that-is-not-an-admin-token';

test('Grafana gate is opaque and does not contain the admin credential', () => {
  const token = issueGrafanaGate({
    environment: { RDK_GRAFANA_GATE_SECRET: SECRET, RDK_CREDITS_ADMIN_TOKEN: 'admin-secret' },
    nowMs: 1_700_000_000_000,
  });
  assert.ok(token);
  assert.notEqual(token, 'admin-secret');
  assert.equal(token.includes('admin-secret'), false);
  assert.equal(
    verifyGrafanaGate(token, {
      environment: { RDK_GRAFANA_GATE_SECRET: SECRET },
      nowMs: 1_700_000_000_000,
    }),
    true,
  );
});

test('Grafana gate expires, rejects tampering, and is bounded to the short TTL', () => {
  const now = 1_700_000_000_000;
  const token = issueGrafanaGate({
    environment: { RDK_GRAFANA_GATE_SECRET: SECRET },
    nowMs: now,
  });
  assert.ok(token);
  assert.equal(
    verifyGrafanaGate(token, { environment: { RDK_GRAFANA_GATE_SECRET: SECRET }, nowMs: now + 1_000 }),
    true,
  );
  assert.equal(
    verifyGrafanaGate(token, {
      environment: { RDK_GRAFANA_GATE_SECRET: SECRET },
      nowMs: now + (GRAFANA_GATE_TTL_SECONDS + 31) * 1_000,
    }),
    false,
  );
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(
    verifyGrafanaGate(tampered, { environment: { RDK_GRAFANA_GATE_SECRET: SECRET }, nowMs: now }),
    false,
  );
});

test('Grafana gate derives a stable fallback from the admin token without exposing it', () => {
  const env = { RDK_CREDITS_ADMIN_TOKEN: 'a'.repeat(64) };
  const token = issueGrafanaGate({ environment: env, nowMs: 1_700_000_000_000 });
  assert.ok(token);
  assert.equal(
    verifyGrafanaGate(token, { environment: env, nowMs: 1_700_000_000_000 }),
    true,
  );
  assert.equal(token.includes(env.RDK_CREDITS_ADMIN_TOKEN), false);
  assert.equal(
    verifyGrafanaGate(token, {
      environment: { RDK_CREDITS_ADMIN_TOKEN: 'b'.repeat(64) },
      nowMs: 1_700_000_000_000,
    }),
    false,
  );
});

test('Grafana gate fails closed when no secret is configured', () => {
  assert.equal(issueGrafanaGate({ environment: {}, nowMs: 1_700_000_000_000 }), null);
  assert.equal(verifyGrafanaGate('v1.1.nonce.signature', { environment: {} }), false);
});
