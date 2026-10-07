import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { after, before, test } from 'node:test';
import { createOtlpIngestGuard } from './ingest-guard.js';

let server: Server;
let baseUrl = '';
let previousLimit: string | undefined;

before(async () => {
  previousLimit = process.env.RDK_OTLP_MAX_REQUESTS_PER_MINUTE;
  process.env.RDK_OTLP_MAX_REQUESTS_PER_MINUTE = '2';
  const app = express();
  app.use(createOtlpIngestGuard());
  app.post('/v1/traces', (_req, res) => res.status(200).json({ ok: true }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('guard test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousLimit === undefined) delete process.env.RDK_OTLP_MAX_REQUESTS_PER_MINUTE;
  else process.env.RDK_OTLP_MAX_REQUESTS_PER_MINUTE = previousLimit;
});

test('OTLP guard returns retryable 429 with rate limit headers', async () => {
  const headers = { Authorization: 'Bearer guard-test-token' };
  assert.equal((await fetch(`${baseUrl}/v1/traces`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/v1/traces`, { method: 'POST', headers })).status, 200);
  const limited = await fetch(`${baseUrl}/v1/traces`, { method: 'POST', headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after') !== null, true);
  const body = await limited.json() as { retryable: boolean; code: string };
  assert.equal(body.retryable, true);
  assert.equal(body.code, 'otlp_rate_limited');
});
