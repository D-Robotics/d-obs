import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configureDashboardPoolForTest } from './dashboard-boards-store.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';

test('HTTP board create and PUT reject panel overflow before any schema, migration or write query', async () => {
  const keys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_CHAT_CREDITS_DB_URL'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'board-write-limits-admin';
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused.invalid/db';
  configureObservabilityAccess({ getSessionSsoUser: () => null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  let databaseCalls = 0;
  configureDashboardPoolForTest({ query: async () => { databaseCalls++; throw new Error('unexpected_database_call'); } });
  const app = express(); app.use(express.json()); const router = express.Router(); registerSignalsRoutes(router); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const panels = Array.from({ length: 49 }, (_, index) => ({ title: 'p' + index, metric: 'm' + index }));
    for (const [method, path] of [['POST', '/api/ops/observability/boards'], ['PUT', '/api/ops/observability/boards/00000000-0000-4000-8000-000000000000']]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'x-admin-token': 'board-write-limits-admin', 'x-rdk-ops-action': 'observability', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Too many', spec: { panels } }) });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { ok: false, error: 'invalid_board_spec' });
    }
    assert.equal(databaseCalls, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    configureDashboardPoolForTest(null); resetObservabilityAccessAdapter();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
