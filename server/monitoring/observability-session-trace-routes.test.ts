import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { registerSessionTraceRoutes } from './observability-session-trace-routes.js';

test('session trace reads enforce admin access, same-origin context, and governance readiness', async () => {
  const saved = { db: process.env.RDK_CHAT_CREDITS_DB_URL, token: process.env.RDK_CREDITS_ADMIN_TOKEN };
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused-test-database';
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'session-trace-route-test-token';
  const app = express();
  const router = express.Router();
  registerSessionTraceRoutes(router);
  app.use(router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/ops/observability/sessions`;
  const admin = { 'x-admin-token': process.env.RDK_CREDITS_ADMIN_TOKEN };
  try {
    for (const headers of [{}, { 'x-admin-token': 'incorrect' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) {
      assert.equal((await fetch(url, { headers })).status, 403);
    }
    const missingGuard = await fetch(url, { headers: admin });
    assert.equal(missingGuard.status, 400);
    assert.equal(((await missingGuard.json()) as { error: string }).error, 'missing_ops_context_guard');
    const crossOrigin = await fetch(url, { headers: { ...admin,
      'x-rdk-ops-action': 'observability-context', origin: 'https://another-site.example' } });
    assert.equal(crossOrigin.status, 403);
    const notReady = await fetch(url, { headers: { ...admin,
      'x-rdk-ops-action': 'observability-context' } });
    assert.equal(notReady.status, 503);
    assert.equal(((await notReady.json()) as { error: string }).error, 'telemetry_governance_unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved.db === undefined) delete process.env.RDK_CHAT_CREDITS_DB_URL;
    else process.env.RDK_CHAT_CREDITS_DB_URL = saved.db;
    if (saved.token === undefined) delete process.env.RDK_CREDITS_ADMIN_TOKEN;
    else process.env.RDK_CREDITS_ADMIN_TOKEN = saved.token;
  }
});
