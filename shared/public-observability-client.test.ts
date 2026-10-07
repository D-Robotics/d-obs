import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicObservabilityClient, PublicObservabilityApiError } from './public-observability-client.js';

test('public observability client retries idempotent requests with backoff', async () => {
  let calls = 0;
  const client = createPublicObservabilityClient({
    baseUrl: 'http://127.0.0.1:47110',
    authorization: 'test-token',
    maxRetries: 1,
    retryBaseDelayMs: 10,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, code: 'busy', retryable: true }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { runs: [], limit: 50 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await client.listRuns();
  assert.deepEqual(result.runs, []);
  assert.equal(calls, 2);
});

test('public observability client does not retry non-idempotent run creation without a key', async () => {
  let calls = 0;
  const client = createPublicObservabilityClient({
    baseUrl: 'http://127.0.0.1:47110',
    authorization: 'test-token',
    maxRetries: 2,
    retryBaseDelayMs: 10,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, code: 'busy', retryable: true }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await assert.rejects(
    client.createRun({ projectId: 'p', environment: 'test', service: 'svc', name: 'run' }),
    (error: unknown) => error instanceof PublicObservabilityApiError && error.retryable,
  );
  assert.equal(calls, 1);
});
