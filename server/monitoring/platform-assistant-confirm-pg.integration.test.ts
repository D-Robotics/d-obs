import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { claimPlatformMutation, inspectPlatformMutation, proposePlatformMutation } from './platform-assistant-authorization.js';
import { registerPlatformAssistantRoutes, requirePlatformAssistantAccess } from './platform-assistant-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations, visiblePlatformOperations } from './platform-operations.js';

const connectionString = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();
const API = '/api/ops/observability/assistant';
type ControlClient = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

test('assistant confirmation uses exact encrypted arguments and single-use PostgreSQL claims', {
  skip: !connectionString, timeout: 25_000,
}, async (t) => {
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_CREDITS_ADMIN_TOKEN', 'RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET', 'RDK_FLYWHEEL_ADMIN_USER_IDS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CHAT_CREDITS_DB_URL = connectionString;
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'assistant-confirm-fixture-token';
  process.env.RDK_PLATFORM_ASSISTANT_AUTHORIZATION_SECRET = 'assistant-confirm-fixture-secret';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'actor-a,actor-b';
  configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')! } : null,
    isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => ControlClient } }).default.Client;
  const control = new Client({ connectionString }); await control.connect();
  const changes: Array<{ id: string; body: unknown; query: unknown; actor: string | undefined }> = [];
  const router = express.Router();
  registerPlatformAssistantRoutes(router);
  const operationId = 'PATCH /api/ops/observability/fixture/:id';
  registerPlatformOperations(router, { [operationId]: { description: '调整确认测试对象', group: '测试', tenantAccessible: false } });
  router.patch('/api/ops/observability/fixture/:id', requirePlatformAssistantAccess, requireOpsMutationGuard, (req, res) => {
    changes.push({ id: String(req.params.id), body: req.body, query: req.query, actor: req.header('fixture-actor') });
    res.json({ ok: true, changes: changes.length });
  });
  // Test-only proposal assembly; confirmation below uses the production route and executor.
  router.post(API + '/fixture-proposal', requirePlatformAssistantAccess, requireOpsMutationGuard, (req, res) => {
    const operation = visiblePlatformOperations(router, req).find((item) => item.id === operationId)!;
    const now = typeof req.body.issuedAt === 'number' ? req.body.issuedAt : Date.now();
    const proposal = proposePlatformMutation(req, operation, req.body.args, now);
    const inspected = inspectPlatformMutation(req, proposal.token, now);
    res.json({ ...proposal, nonceHash: createHash('sha256').update(inspected.nonce).digest('hex') });
  });
  const app = express(); app.use(express.json()); app.use(router);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { 'content-type': 'application/json', 'x-admin-token': 'assistant-confirm-fixture-token', 'x-rdk-ops-action': 'observability', 'fixture-actor': 'actor-a' };
  const args = () => ({ params: { id: randomUUID() }, query: { source: 'confirmed' }, body: { threshold: 17 } });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const proposal = async (input = args(), issuedAt?: number) => {
    const response = await post(API + '/fixture-proposal', { args: input, issuedAt }); assert.equal(response.status, 200);
    return await response.json() as { token: string; nonceHash: string; expiresAt: number };
  };
  try {
    await t.test('confirmation dispatches the original route once with exact arguments and actor', async () => {
      const input = args(); const item = await proposal(input);
      assert.equal(changes.length, 0, 'generating a proposal must not execute the mutation');
      const response = await post(API + '/confirm', { token: item.token });
      assert.equal(response.status, 200); const result = await response.json() as any;
      assert.equal(result.operations[0].ok, true);
      assert.deepEqual(changes[0], { id: input.params.id, body: input.body, query: input.query, actor: 'actor-a' });
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 409);
      assert.equal(changes.length, 1);
      const persisted = await control.query('select nonce_hash,operation_id from public.studio_assistant_mutation_claims where nonce_hash=$1', [item.nonceHash]);
      assert.equal(persisted.rows.length, 1); assert.equal(persisted.rows[0].operation_id, operationId);
    });

    await t.test('concurrent confirmations across requests have only one winner', async () => {
      const initial = changes.length; const item = await proposal();
      const responses = await Promise.all(Array.from({ length: 12 }, () => post(API + '/confirm', { token: item.token })));
      assert.equal(responses.filter((response) => response.status === 200).length, 1);
      assert.equal(responses.filter((response) => response.status === 409).length, 11);
      assert.equal(changes.length, initial + 1);
    });

    await t.test('actor, view, tampering, extra arguments, read-only mode and mutation guards cannot bypass confirmation', async () => {
      const initial = changes.length; const item = await proposal();
      const bytes = Buffer.from(item.token, 'base64url'); bytes[bytes.length - 1] ^= 1;
      const cases: Array<[string, unknown, Record<string, string>, number]> = [
        [API + '/confirm', { token: item.token }, { 'fixture-actor': 'actor-b' }, 400],
        [API + '/confirm?tenant=other-team', { token: item.token }, {}, 400],
        [API + '/confirm', { token: bytes.toString('base64url') }, {}, 400],
        [API + '/confirm', { token: item.token, body: { threshold: 999 } }, {}, 400],
        [API + '/confirm', { token: item.token }, { 'x-rdk-ops-read-only': '1' }, 403],
        [API + '/confirm', { token: item.token }, { 'x-rdk-ops-action': '' }, 400],
        [API + '/confirm', { token: item.token }, { origin: 'https://foreign.invalid' }, 403],
        [API + '/confirm', { token: item.token }, { 'x-admin-token': 'wrong', 'fixture-actor': '' }, 403],
      ];
      for (const [path, body, extra, status] of cases) assert.equal((await post(path, body, extra)).status, status);
      assert.equal(changes.length, initial);
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 200, 'rejected attempts must not consume a valid claim');
      assert.equal(changes.length, initial + 1);
    });

    await t.test('expiry is rechecked by PostgreSQL after the claim waits on a lock', async () => {
      const initial = changes.length;
      const item = await proposal(args(), Date.now() - 5 * 60_000 + 1_000);
      await control.query('begin'); await control.query('lock table public.studio_assistant_mutation_claims in access exclusive mode');
      const pending = post(API + '/confirm', { token: item.token });
      try {
        const deadline = Date.now() + 2_000;
        while (true) {
          const waiting = await control.query("select count(*)::int as count from pg_stat_activity where application_name='d-obs-assistant-authorization' and wait_event_type='Lock'");
          if (Number(waiting.rows[0].count) > 0) break;
          if (Date.now() > deadline) assert.fail('confirmation did not wait on its claim insert');
          await delay(20);
        }
        await delay(Math.max(0, item.expiresAt - Date.now()) + 50);
      } finally { await control.query('commit'); }
      assert.equal((await pending).status, 400);
      assert.equal(changes.length, initial);
      const claims = await control.query('select nonce_hash from public.studio_assistant_mutation_claims where nonce_hash=$1', [item.nonceHash]);
      assert.equal(claims.rows.length, 0, 'an expired claim must never be inserted');
    });

    await t.test('missing claim store fails closed and does not consume or dispatch a mutation', async () => {
      const initial = changes.length; const item = await proposal();
      delete process.env.RDK_CHAT_CREDITS_DB_URL;
      try { assert.equal((await post(API + '/confirm', { token: item.token })).status, 503); }
      finally { process.env.RDK_CHAT_CREDITS_DB_URL = connectionString; }
      assert.equal(changes.length, initial);
      assert.equal((await post(API + '/confirm', { token: item.token })).status, 200);
      assert.equal(changes.length, initial + 1);
      const req = { header: (name: string) => headers[name as keyof typeof headers], query: {} } as unknown as express.Request;
      const expiredAt = Date.now() - 100;
      const expired = proposePlatformMutation(req, { id: operationId, method: 'PATCH', path: '/api/ops/observability/fixture/:id', group: 'fixture', description: 'fixture', mutating: true }, args(), expiredAt - 5 * 60_000);
      const value = inspectPlatformMutation(req, expired.token, expiredAt - 1);
      await assert.rejects(claimPlatformMutation(value), /invalid_or_expired_authorization/);
    });

    await t.test('an unresponsive PostgreSQL handshake fails closed within the connection timeout', async () => {
      const initial = changes.length; const item = await proposal();
      const sockets = new Set<Socket>();
      const stalled = createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
      const stalledAddress = stalled.address(); assert.ok(stalledAddress && typeof stalledAddress !== 'string');
      process.env.RDK_CHAT_CREDITS_DB_URL = `postgresql://fixture@127.0.0.1:${stalledAddress.port}/fixture`;
      const started = Date.now();
      try {
        const response = await post(API + '/confirm', { token: item.token });
        assert.equal(response.status, 503); assert.ok(Date.now() - started < 6_000, 'connection setup must be bounded');
        assert.equal(changes.length, initial);
      } finally {
        process.env.RDK_CHAT_CREDITS_DB_URL = connectionString;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => stalled.close(() => resolve()));
      }
    });

    await t.test('schema initialization is bounded when PostgreSQL catalog locks block creation', async () => {
      const initial = changes.length; const item = await proposal();
      const database = `dobs_assistant_schema_${randomUUID().replace(/-/g, '')}`;
      await control.query(`create database "${database}"`);
      const url = new URL(connectionString); url.pathname = `/${database}`;
      const schemaControl = new Client({ connectionString: url.toString() });
      await schemaControl.connect();
      try {
        await schemaControl.query('begin');
        await schemaControl.query('lock table pg_catalog.pg_namespace in access exclusive mode');
        process.env.RDK_CHAT_CREDITS_DB_URL = url.toString();
        const started = Date.now();
        const response = await post(API + '/confirm', { token: item.token });
        assert.equal(response.status, 503); assert.ok(Date.now() - started < 6_000, 'schema DDL must respect statement_timeout');
        assert.equal(changes.length, initial);
      } finally {
        process.env.RDK_CHAT_CREDITS_DB_URL = connectionString;
        await schemaControl.query('rollback'); await schemaControl.end();
        await control.query(`drop database "${database}"`);
      }
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await control.end();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetObservabilityAccessAdapter();
  }
});
