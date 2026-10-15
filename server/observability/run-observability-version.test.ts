import assert from 'node:assert/strict';
import test from 'node:test';
import { issueRunLocator } from './run-locator.js';
import { createRunObservabilityService } from './run-observability-service.js';

const NOW = Date.parse('2026-10-10T08:00:00Z');
const START = NOW - 600_000;

async function readDetail(mocVersion = '0.0.0') {
  const db = {
    async query(sql: string) {
      if (sql.includes('from public.agent_run_records')) {
        return { rows: [{ run_fact: {
          run_id: 'run-version', started_at: new Date(START).toISOString(),
          completed_at: new Date(START + 1_000).toISOString(),
          app_version: '1.4.4', client_type: 'desktop', outcome: 'success',
        } }] };
      }
      if (sql.includes("coalesce(run_id, '') = ''")) return { rows: [] };
      if (sql.includes('from public.studio_trace_spans')) {
        return { rows: [{
          trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), run_id: 'run-version',
          source: 'server', source_segment: 'moss', name: 'moss.session',
          start_time_ms: START, end_time_ms: START + 1_000, status: 'ok',
          studio_version: '0.0.0', moss_version: '0.0.0', moc_version: mocVersion,
        }] };
      }
      return { rows: [] };
    },
  };
  const service = createRunObservabilityService({ db, now: () => NOW, protectedReadReady: () => true });
  const locator = issueRunLocator({
    accountScopeId: 'account-version', environment: 'production', runId: 'run-version',
    now: NOW, ttlMs: 30 * 60_000,
  });
  const result = await service(locator, { kind: 'owner', accountScopeId: 'account-version' });
  assert.equal(result.status, 'found');
  if (result.status !== 'found') throw new Error('expected Run detail');
  return result.detail;
}

test('legacy resource defaults keep the fact producer version and assess actual missing segments', async () => {
  const detail = await readDetail();
  assert.equal(detail.run.producer.studioVersion, '1.4.4');
  assert.equal(detail.run.producer.mossVersion, null);
  assert.equal(detail.run.producer.mocVersion, null);
  assert.equal(detail.coverage.eligible, true);
  assert.equal(detail.coverage.state, 'partial');
  assert.deepEqual(detail.coverage.reasonCodes, ['not_received']);
  assert.deepEqual(detail.coverage.missingSegments, ['client', 'studio_transport', 'moss_children']);
});

test('a reported older MOC version remains incompatible', async () => {
  const detail = await readDetail('0.9.1');
  assert.equal(detail.run.producer.mocVersion, '0.9.1');
  assert.equal(detail.coverage.eligible, false);
  assert.deepEqual(detail.coverage.reasonCodes, ['version_unsupported']);
});
