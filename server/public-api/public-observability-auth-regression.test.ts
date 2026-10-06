import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { after, before, test } from 'node:test';
import { createPublicObservabilityRouter } from './public-observability-routes.js';

let server: Server;
let baseUrl = '';
const previousNodeEnv = process.env.NODE_ENV;
const previousToken = process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
const previousDynamic = process.env.RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS;

before(async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
  delete process.env.RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS;
  const app = express();
  app.use(express.json());
  app.use(createPublicObservabilityRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousToken === undefined) delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
  else process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = previousToken;
  if (previousDynamic === undefined) delete process.env.RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS;
  else process.env.RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS = previousDynamic;
});

test('production public observability API fails closed when fixed token is missing', async () => {
  const response = await fetch(`${baseUrl}/api/v1/observability/runs`, {
    headers: { authorization: 'Bearer attacker-chosen-token' },
  });
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, 'invalid_observability_token');
});
