import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import express from 'express';
import {
  INGEST_TOKEN_SUBJECT_PATTERN,
  ingestOwnerForToken,
  prepareIngestToken,
} from './ingest-token-store.js';
import { createAiEcosystemRouter } from './ai-ecosystem-routes.js';

const ORIGINAL_TOKEN = process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
const ORIGINAL_DB = process.env.RDK_CHAT_CREDITS_DB_URL;

async function withServer(handler: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createAiEcosystemRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await handler(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('prepareIngestToken 校验对象类型与 ID，签发派生稳定的 owner', () => {
  assert.throws(() => prepareIngestToken({ subjectType: 'robot', subjectId: 'x-1' }), /invalid_subject_type/);
  assert.throws(() => prepareIngestToken({ subjectType: 'user', subjectId: 'bad id!' }), /invalid_subject_id/);
  const prepared = prepareIngestToken({ subjectType: 'user', subjectId: 'u-20260901-abcd', displayName: '演示' });
  assert.equal(prepared.subjectType, 'user');
  assert.equal(prepared.subjectId, 'u-20260901-abcd');
  assert.match(prepared.token, /^[a-f0-9]{64}$/);
  assert.ok(INGEST_TOKEN_SUBJECT_PATTERN.test('tenant-alpha:prod'));
  assert.ok(INGEST_TOKEN_SUBJECT_PATTERN.test('u-20260901-abcd'));
  assert.equal(ingestOwnerForToken(prepared.token), `public_${createHash('sha256').update(prepared.token).digest('hex')}`);
});

const VALID_METRIC_PAYLOAD = () => ({
  resourceMetrics: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ingest-token-auth-test' } }] },
    scopeMetrics: [{
      metrics: [{
        name: 'ingest_token_auth_test_metric',
        gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: String(BigInt(Date.now()) * 1_000_000n) }] },
      }],
    }],
  }],
});

test('配置固定 token 时未知凭据在注册表不可达下 fail-closed 拒绝', async () => {
  process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = 'configured-token';
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  try {
    await withServer(async (baseUrl) => {
      const ok = await fetch(`${baseUrl}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer configured-token' },
        body: JSON.stringify(VALID_METRIC_PAYLOAD()),
      });
      assert.equal(ok.status, 200);
      const rejected = await fetch(`${baseUrl}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer some-unknown-token' },
        body: JSON.stringify(VALID_METRIC_PAYLOAD()),
      });
      assert.equal(rejected.status, 401);
    });
  } finally {
    if (ORIGINAL_TOKEN === undefined) delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
    else process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_DB !== undefined) process.env.RDK_CHAT_CREDITS_DB_URL = ORIGINAL_DB;
  }
});

test('未配置固定 token 时保持匿名凭据隔离（开放模式不变）', async () => {
  delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer any-anonymous-token' },
        body: JSON.stringify(VALID_METRIC_PAYLOAD()),
      });
      assert.equal(response.status, 200);
    });
  } finally {
    if (ORIGINAL_TOKEN === undefined) delete process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN;
    else process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_DB !== undefined) process.env.RDK_CHAT_CREDITS_DB_URL = ORIGINAL_DB;
  }
});
