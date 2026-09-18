import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { after, before, test } from 'node:test';
import {
  createPublicObservabilityClient,
  PublicObservabilityApiError,
} from '../../shared/public-observability-client.js';
import { createPublicObservabilityRouter } from './public-observability-routes.js';

let server: Server;
let baseUrl = '';

before(async () => {
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
});

test('public observability SDK can create, append, query and score a run', async () => {
  const runId = `route-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const client = createPublicObservabilityClient({ baseUrl, authorization: 'route-test-token' });
  const created = await client.createRun({
    runId,
    projectId: 'test-project',
    environment: 'test',
    service: 'route-test',
    objectType: 'agent',
    objectId: runId,
    idempotencyKey: `idempotency-${runId}`,
  });
  assert.equal(created.run.runId, runId);
  assert.equal(created.replayed, false);

  const replayed = await client.createRun({
    runId,
    projectId: 'test-project',
    environment: 'test',
    service: 'route-test',
    idempotencyKey: `idempotency-${runId}`,
  });
  assert.equal(replayed.replayed, true);

  const appended = await client.appendSpans(runId, {
    status: 'completed',
    spans: [{ name: 'tool.call', kind: 'tool', startTime: Date.now(), endTime: Date.now() + 1 }],
  });
  assert.equal(appended.accepted, 1);
  assert.equal(appended.run.status, 'completed');

  await client.recordScore(runId, { name: 'quality', value: 0.9 });
  await client.recordFeedback(runId, { kind: 'up', comment: 'good' });
  const summary = await client.getSummary({ objectId: runId, windowMinutes: 60 });
  assert.equal(summary.quality.scoreCount, 1);
  assert.equal(summary.quality.feedbackCount, 1);
  assert.equal(summary.quality.positiveFeedbackRate, 1);

  const listed = await client.listRuns({ objectId: runId });
  assert.equal(listed.runs.length, 1);
  assert.equal((await client.getTrace(runId)).trace.length, 2);
});

test('public observability API isolates bearer token scopes', async () => {
  const runId = `scope-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = createPublicObservabilityClient({ baseUrl, authorization: 'scope-owner-token' });
  const other = createPublicObservabilityClient({ baseUrl, authorization: 'scope-other-token' });
  await owner.createRun({ runId, projectId: 'p', environment: 'test', service: 'scope-test' });

  await assert.rejects(
    () => other.getRun(runId),
    (error: unknown) => error instanceof PublicObservabilityApiError && error.status === 404,
  );
  await assert.rejects(
    () => owner.getRun('missing-run'),
    (error: unknown) => error instanceof PublicObservabilityApiError && error.status === 404,
  );

  const response = await fetch(`${baseUrl}/api/v1/observability/runs`, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 401);
});
