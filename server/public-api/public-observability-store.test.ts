import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getPublicObservabilityStore,
} from './public-observability-store.js';
import type { PublicObservabilitySnapshot } from './public-observability-repository.js';

test('public observability exposes a bounded persistence boundary', async () => {
  const store = getPublicObservabilityStore();
  const status = store.getPersistenceStatus();
  assert.equal(status.mode, 'process-memory-cache');
  assert.equal(status.authoritative, 'process-cache');
  assert.equal(status.degraded, true);
  assert.equal(status.limits.maxRuns, 2_000);
  assert.equal(status.limits.maxObjectProfiles, 5_000);
  assert.equal(status.limits.maxSpansPerRun, 256);
  assert.deepEqual(status.durableProjections, ['studio-trace-store', 'public-observability-quality-store']);

  const runId = `snapshot-source-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await store.createRun('snapshot-test-owner', 'snapshot-test-key', {
    runId,
    projectId: 'snapshot-project',
    environment: 'test',
    service: 'snapshot-service',
    objectType: 'agent',
    objectId: runId,
  });
  store.upsertObject('snapshot-test-owner', runId, {
    team: 'snapshot-team',
    objectType: 'agent',
    displayName: 'Snapshot source',
    labels: ['snapshot'],
  });

  const snapshot = store.exportSnapshot();
  assert.equal(snapshot.schema, 'rdk.public.observability.snapshot.v1');
  assert.equal(snapshot.persistenceMode, 'process-memory-cache');
  assert.ok(snapshot.runs.some((item) => item.run.runId === runId));
  assert.ok(snapshot.objectProfiles.some((item) => item.objectId === runId));

  const importedRunId = `${runId}-imported`;
  const imported = structuredClone(snapshot) as PublicObservabilitySnapshot;
  const source = imported.runs.find((item) => item.run.runId === runId);
  assert.ok(source);
  source.run.runId = importedRunId;
  source.spans = source.spans.map((span) => ({ ...span, runId: importedRunId }));
  const result = store.importSnapshot(imported);
  assert.equal(result.importedRuns, 1);
  assert.equal(result.skippedRuns, imported.runs.length - 1);
  assert.ok((await store.getRun('snapshot-test-owner', importedRunId))?.runId === importedRunId);
});

test('invalid public observability snapshots fail closed', () => {
  const store = getPublicObservabilityStore();
  assert.throws(
    () => store.importSnapshot({ schema: 'unknown', persistenceMode: 'process-memory-cache', runs: [], objectProfiles: [] }),
    /invalid public observability snapshot schema/,
  );
  assert.throws(
    () => store.importSnapshot({ schema: 'rdk.public.observability.snapshot.v1', persistenceMode: 'process-memory-cache' }),
    /invalid public observability snapshot payload/,
  );
});

test('snapshot handoff carries deletion selectors and does not resurrect purged runs', async () => {
  const store = getPublicObservabilityStore();
  const sourceRunId = `snapshot-tombstone-source-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await store.createRun('snapshot-tombstone-owner', 'snapshot-tombstone-key', {
    runId: sourceRunId,
    projectId: 'snapshot-project',
    environment: 'test',
    service: 'snapshot-service',
  });
  const snapshot = store.exportSnapshot();
  assert.ok(Array.isArray(snapshot.tombstones));
  assert.equal(typeof snapshot.quarantineAllTelemetry, 'boolean');
  const source = snapshot.runs.find((item) => item.run.runId === sourceRunId);
  assert.ok(source);
  const restoredRunId = `${sourceRunId}-restored`;
  const restored = structuredClone(source) as typeof source;
  restored.run.runId = restoredRunId;
  restored.spans = restored.spans.map((span) => ({ ...span, runId: restoredRunId }));
  snapshot.runs = [restored];
  snapshot.tombstones = [{
    tombstoneId: `tombstone-${restoredRunId}`,
    requestId: `request-${restoredRunId}`,
    accountScopeId: 'snapshot-tombstone-owner',
    environment: 'test',
    runId: restoredRunId,
    createdAt: Date.now(),
  }];
  const result = store.importSnapshot(snapshot);
  assert.equal(result.importedRuns, 0);
  assert.equal(result.skippedRuns, 1);
  assert.equal(await store.getRun('snapshot-tombstone-owner', restoredRunId), null);
});
