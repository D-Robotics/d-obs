/** Real module HTTP handlers against an explicit, empty loopback PostgreSQL test database. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { PLATFORM_OPERATION_METADATA } from './platform-operation-metadata.js';
import { executePlatformOperation, registerPlatformOperations } from './platform-operations.js';
import { ackDeviceCommand, claimDeviceCommands, resolveDeviceIdentity } from './device-registry.js';

const databaseUrl = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();
const DEVICES = '/api/ops/observability/devices';
const PRICES = '/api/ops/observability/model-prices';
type Json = Record<string, any>;
type ControlClient = {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Json[] }>;
};

test('device commands, token rotation and model prices use real guarded HTTP and PostgreSQL handlers', {
  skip: !databaseUrl, timeout: 40_000,
}, async (t) => {
  const selected = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(selected.hostname), 'integration fixtures must use loopback');
  assert.match(selected.pathname, /^\/dobs_[a-z0-9_]*test[a-z0-9_]*$/, 'integration fixtures must use a dedicated dobs test database');
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_CREDITS_ADMIN_TOKEN', 'RDK_FLYWHEEL_ADMIN_USER_IDS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const actor = `module-admin-${randomUUID()}`;
  process.env.RDK_CHAT_CREDITS_DB_URL = databaseUrl;
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'device-prices-fixture-admin';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = actor;
  configureObservabilityAccess({
    getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => ControlClient } }).default.Client;
  const control = new Client({ connectionString: databaseUrl });
  await control.connect();
  const tables = await control.query("select tablename from pg_tables where schemaname='public'");
  assert.deepEqual(tables.rows, [], 'this integration test must never share an existing application database');
  const router = express.Router();
  registerSignalsRoutes(router);
  registerPlatformOperations(router, Object.fromEntries(Object.entries(PLATFORM_OPERATION_METADATA)
    .filter(([, entry]) => ['边缘设备', '模型成本'].includes(entry.group))));
  router.post('/fixture/invoke', async (req, res) => {
    res.json(await executePlatformOperation(router, req, res, req.body.id, req.body.args));
  });
  const app = express(); app.use(express.json()); app.use(router);
  // Fake board-side receiver: production token resolver and command store are
  // exercised, but no agent script, SSH command, hardware or production service runs.
  app.post('/fixture/edge/claim', async (req, res) => {
    const deviceId = await resolveDeviceIdentity(req.header('x-rdk-device-token'));
    if (!deviceId) { res.status(401).json({ ok: false }); return; }
    res.json({ ok: true, commands: await claimDeviceCommands(deviceId) });
  });
  app.post('/fixture/edge/:commandId/ack', async (req, res) => {
    const deviceId = await resolveDeviceIdentity(req.header('x-rdk-device-token'));
    if (!deviceId) { res.status(401).json({ ok: false }); return; }
    const command = await ackDeviceCommand({ deviceId, commandId: String(req.params.commandId),
      status: String(req.body.status), result: String(req.body.result ?? '') });
    res.status(command ? 200 : 404).json({ ok: !!command });
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { 'content-type': 'application/json', 'x-admin-token': 'device-prices-fixture-admin',
    'x-rdk-ops-action': 'observability', 'fixture-actor': actor };
  const request = async (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(origin + path, { method, redirect: 'error', headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as Json };
  };
  const deviceA = `fixture-a-${randomUUID().slice(0, 8)}`;
  const deviceB = `fixture-b-${randomUUID().slice(0, 8)}`;
  const modelName = `fixture-provider/fixture-model-${randomUUID()}`;
  const modelPath = `${PRICES}/${encodeURIComponent(modelName)}`;
  let tokenA = ''; let tokenB = '';
  try {
    await t.test('admin registration persists metadata and hash, while public listings contain no token', async () => {
      for (const [id, tenant] of [[deviceA, 'fixture-alpha'], [deviceB, 'fixture-beta']]) {
        const result = await request(DEVICES, 'POST', { deviceId: id, tenantId: tenant, model: 'X5',
          displayName: '隔离测试设备', labels: { board: 'fake', invalid: { script: 'never-run' } } });
        assert.equal(result.status, 201); assert.equal(result.data.tokenHeader, 'x-rdk-device-token');
        assert.match(result.data.token, /^[a-f0-9]{64}$/);
        assert.equal(result.data.device.tenantId, tenant);
        assert.deepEqual(result.data.device.labels, { board: 'fake' });
        const stored = await control.query('select token_hash,created_by from public.studio_devices where device_id=$1', [id]);
        assert.equal(stored.rows[0].token_hash, createHash('sha256').update(result.data.token).digest('hex'));
        assert.equal(stored.rows[0].created_by, actor);
        if (id === deviceA) tokenA = result.data.token; else tokenB = result.data.token;
      }
      const listed = await request(DEVICES);
      assert.equal(listed.status, 200); assert.equal(listed.data.devices.length, 2);
      for (const item of listed.data.devices) {
        assert.equal(item.token, undefined); assert.equal(item.tokenHash, undefined); assert.equal(item.token_hash, undefined);
      }
      assert.doesNotMatch(JSON.stringify(listed.data), new RegExp(`${tokenA}|${tokenB}`));
    });

    await t.test('nonadmin and tenant requests cannot read or mutate the global device and pricing domains', async () => {
      const deniedHeaders: Array<Record<string, string>> = [{ 'x-admin-token': '', 'fixture-actor': '' },
        { 'x-admin-token': '', 'fixture-actor': 'fixture-ordinary-member', 'x-rdk-obs-tenant': 'fixture-alpha' },
        { 'x-admin-token': '', 'fixture-actor': '', 'x-tenant-token': 'a'.repeat(64) }];
      for (const denied of deniedHeaders) {
        for (const [path, method, body] of [[DEVICES, 'GET', undefined],
          [`${DEVICES}/${deviceA}/commands`, 'POST', { type: 'ping' }],
          [`${DEVICES}/${deviceA}/token`, 'POST', {}],
          [PRICES, 'GET', undefined], [modelPath, 'PUT', { inputPerM: 1, outputPerM: 2 }]] as const) {
          assert.equal((await request(path, method, body, denied)).status, 403);
        }
      }
      assert.deepEqual((await control.query('select * from public.studio_device_commands')).rows, []);
      const stored = await control.query('select token_hash from public.studio_devices where device_id=$1', [deviceA]);
      assert.equal(stored.rows[0].token_hash, createHash('sha256').update(tokenA).digest('hex'));
    });

    await t.test('command allowlist, payload bounds, mutation guards and read-only execution reject before persistence', async () => {
      for (const body of [{ type: 'exec', payload: { command: 'never-run' } },
        { type: 'restart' }, { type: 'set-interval', payload: { intervalSeconds: 4 } },
        { type: 'set-interval', payload: { intervalSeconds: 3601 } },
        { type: 'set-interval', payload: { intervalSeconds: 'invalid' } }, { type: 'set-interval' }]) {
        const result = await request(`${DEVICES}/${deviceA}/commands`, 'POST', body);
        assert.equal(result.status, 400); assert.match(result.data.error, /^invalid_command_(?:type|payload)$/);
      }
      assert.equal((await request(`${DEVICES}/${deviceA}/commands`, 'POST', { type: 'ping' }, { 'x-rdk-ops-action': '' })).status, 400);
      assert.equal((await request(`${DEVICES}/${deviceA}/commands`, 'POST', { type: 'ping' }, { origin: 'https://foreign.invalid' })).status, 403);
      const denied = await request('/fixture/invoke', 'POST', { id: `POST ${DEVICES}/:deviceId/commands`,
        args: { params: { deviceId: deviceA }, body: { type: 'ping' } } }, { 'x-rdk-ops-read-only': '1' });
      assert.equal(denied.data.status, 403);
      assert.equal(denied.data.data.error, 'platform_read_only_operation_denied');
      assert.deepEqual((await control.query('select * from public.studio_device_commands')).rows, []);
    });

    await t.test('valid commands are canonical, recorded and isolated between fake receiving devices', async () => {
      const issued: Json[] = [];
      for (const body of [{ type: 'ping', payload: { script: 'discarded' } },
        { type: 'set-interval', payload: { intervalSeconds: 30, script: 'discarded' } },
        { type: 'update-agent', payload: { url: 'https://never-called.invalid/script' } }]) {
        const result = await request(`${DEVICES}/${deviceA}/commands`, 'POST', body);
        assert.equal(result.status, 201); assert.equal(result.data.command.status, 'pending');
        assert.equal(result.data.command.createdBy, actor);
        assert.deepEqual(result.data.command.payload, body.type === 'set-interval' ? { intervalSeconds: 30 } : {});
        issued.push(result.data.command);
      }
      assert.deepEqual((await request('/fixture/edge/claim', 'POST', {}, { 'x-rdk-device-token': tokenB })).data.commands, []);
      assert.equal((await request(`/fixture/edge/${issued[0].id}/ack`, 'POST', { status: 'ok' }, { 'x-rdk-device-token': tokenB })).status, 404);
      const claimed = await request('/fixture/edge/claim', 'POST', {}, { 'x-rdk-device-token': tokenA });
      assert.equal(claimed.status, 200); assert.equal(claimed.data.commands.length, 3);
      assert.deepEqual(claimed.data.commands.map((item: Json) => item.id).sort(), issued.map((item) => item.id).sort());
      assert.equal((await request(`/fixture/edge/${issued[0].id}/ack`, 'POST', { status: 'ok', result: 'fake receiver accepted' },
        { 'x-rdk-device-token': tokenA })).status, 200);
      assert.equal((await request(`/fixture/edge/${issued[0].id}/ack`, 'POST', { status: 'failed' },
        { 'x-rdk-device-token': tokenA })).status, 404);
      const commands = await request(`${DEVICES}/${deviceA}/commands`);
      assert.equal(commands.status, 200); assert.equal(commands.data.commands.find((item: Json) => item.id === issued[0].id).status, 'ok');
    });

    await t.test('concurrent fake device polls cannot deliver the same pending command twice', async () => {
      const issued = await request(`${DEVICES}/${deviceA}/commands`, 'POST', { type: 'ping' });
      assert.equal(issued.status, 201);
      const id = issued.data.command.id;
      await control.query('begin');
      await control.query('select id from public.studio_device_commands where id=$1 for update', [id]);
      let completed = 0;
      const pending = [0, 1].map(async () => {
        const result = await request('/fixture/edge/claim', 'POST', {}, { 'x-rdk-device-token': tokenA });
        completed++; return result;
      });
      try {
        // The original implementation waits on the row and then returns it to
        // both callers. A SKIP LOCKED implementation may return empty instead;
        // one subsequent poll after unlock must then claim the pending command.
        for (let count = 0; count < 50 && completed < 2; count++) {
          await control.query('select pg_stat_clear_snapshot()');
          const waiting = await control.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and query like '%studio_device_commands%'");
          if (waiting.rows[0].count >= 2) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      } finally { await control.query('commit'); }
      const results = await Promise.all(pending);
      results.push(await request('/fixture/edge/claim', 'POST', {}, { 'x-rdk-device-token': tokenA }));
      for (const result of results) assert.equal(result.status, 200);
      const delivered = results.flatMap((result) => result.data.commands).filter((item: Json) => item.id === id);
      assert.equal(delivered.length, 1, 'a pending command has one receiving caller');
      const stored = await control.query('select status from public.studio_device_commands where id=$1', [id]);
      assert.equal(stored.rows[0].status, 'delivered');
    });

    await t.test('rotation and disabled status invalidate a previously cached device identity immediately', async () => {
      assert.equal(await resolveDeviceIdentity(tokenA), deviceA);
      const rotated = await request(`${DEVICES}/${deviceA}/token`, 'POST', {});
      assert.equal(rotated.status, 200); assert.notEqual(rotated.data.token, tokenA);
      assert.equal(await resolveDeviceIdentity(tokenA), null);
      tokenA = rotated.data.token; assert.equal(await resolveDeviceIdentity(tokenA), deviceA);
      assert.equal((await request(`${DEVICES}/${deviceA}/status`, 'POST', { status: 'disabled' })).status, 200);
      assert.equal(await resolveDeviceIdentity(tokenA), null);
      assert.equal((await request('/fixture/edge/claim', 'POST', {}, { 'x-rdk-device-token': tokenA })).status, 401);
      assert.equal((await request(`${DEVICES}/${deviceA}/status`, 'POST', { status: 'active' })).status, 200);
      assert.equal(await resolveDeviceIdentity(tokenA), deviceA);
      assert.equal((await request(`${DEVICES}/missing-fixture/token`, 'POST', {})).status, 404);
    });

    await t.test('invalid numeric model prices and denied mutations cannot create price rows', async () => {
      const empty = await request(PRICES);
      assert.equal(empty.status, 200); assert.deepEqual(empty.data.prices, []);
      for (const body of [{ inputPerM: -1, outputPerM: 2 }, { inputPerM: 1, outputPerM: -2 },
        { inputPerM: 'NaN', outputPerM: 2 }, { inputPerM: 1, outputPerM: 'Infinity' },
        {}, { inputPerM: 1 }, { inputPerM: null, outputPerM: 2 },
        { inputPerM: false, outputPerM: 2 }, { inputPerM: [], outputPerM: 2 },
        { inputPerM: '', outputPerM: 2 }, { inputPerM: '1.25', outputPerM: 2 },
        { inputPerM: 1, outputPerM: null }, { inputPerM: 1, outputPerM: true },
        { inputPerM: 1, outputPerM: [] }]) {
        const result = await request(modelPath, 'PUT', body);
        assert.equal(result.status, 400); assert.equal(result.data.error, 'invalid_model_price');
      }
      assert.equal((await request(modelPath, 'PUT', { inputPerM: 1, outputPerM: 2 }, { 'x-rdk-ops-action': '' })).status, 400);
      assert.equal((await request(modelPath, 'PUT', { inputPerM: 1, outputPerM: 2 }, { origin: 'https://foreign.invalid' })).status, 403);
      assert.deepEqual((await control.query('select * from public.studio_model_prices')).rows, []);
    });

    await t.test('valid pricing persists exact values, can be updated and records the real administrator audit', async () => {
      const first = await request(modelPath, 'PUT', { inputPerM: 1.25, outputPerM: 7.5, currency: 'CNY' });
      assert.equal(first.status, 200); assert.equal(first.data.price.model, modelName);
      assert.equal(first.data.price.inputPerM, 1.25); assert.equal(first.data.price.outputPerM, 7.5);
      assert.equal(first.data.price.updatedBy, actor);
      const updated = await request('/fixture/invoke', 'POST', { id: `PUT ${PRICES}/:model`,
        args: { params: { model: modelName }, body: { inputPerM: 0, outputPerM: 3.75, currency: 'USD' } } });
      assert.equal(updated.data.ok, true); assert.equal(updated.data.status, 200);
      const listed = await request(PRICES); assert.equal(listed.status, 200);
      assert.equal(listed.data.prices.length, 1);
      assert.equal(listed.data.prices[0].inputPerM, 0); assert.equal(listed.data.prices[0].outputPerM, 3.75);
      assert.equal(listed.data.prices[0].currency, 'USD');
      const persisted = await control.query('select * from public.studio_model_prices where model=$1', [modelName]);
      assert.equal(persisted.rows[0].output_per_m, 3.75); assert.equal(persisted.rows[0].updated_by, actor);
      const audit = await control.query("select actor from public.studio_alert_configuration_audit where action='model_price_update'");
      assert.equal(audit.rows.length, 2); assert.ok(audit.rows.every((row) => row.actor === actor));
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await control.end(); resetObservabilityAccessAdapter();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
