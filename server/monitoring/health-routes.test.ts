import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { after, before, test } from 'node:test';
import { createHealthRouter } from './health-routes.js';

let server: Server;
let baseUrl = '';
let previousNodeEnv: string | undefined;
let previousDatabaseUrl: string | undefined;

before(async () => {
  previousNodeEnv = process.env.NODE_ENV;
  previousDatabaseUrl = process.env.RDK_CHAT_CREDITS_DB_URL;
  delete process.env.NODE_ENV;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  const app = express();
  app.use(createHealthRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('health test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDatabaseUrl === undefined) delete process.env.RDK_CHAT_CREDITS_DB_URL;
  else process.env.RDK_CHAT_CREDITS_DB_URL = previousDatabaseUrl;
});

test('healthz is a cheap liveness response and does not require postgres', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; status: string; checks?: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.status, 'alive');
  assert.equal('checks' in body, false);
});

test('readyz is usable in local degraded mode without postgres', async () => {
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; status: string; checks: { database: { status: string } } };
  assert.equal(body.ok, true);
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.database.status, 'disabled');
});
