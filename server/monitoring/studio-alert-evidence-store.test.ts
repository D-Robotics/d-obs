import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alertEvidenceTimestamp,
  ensureAlertEvidenceSchema,
  readAlertEvidenceSnapshot,
  recordAlertEvidenceSnapshot,
} from './studio-alert-evidence-store.js';
import type { AlertEvidence } from './studio-alert-evidence-types.js';

const at = '2026-10-15T09:43:57.000Z';
const evidence: AlertEvidence = {
  windowStart: '2026-10-15T09:33:57.000Z', windowEnd: at,
  eventCount: 6, runCount: 2, totalGroups: 1, applicability: 'business',
  groups: [{ accountId: 'account-a', appVersion: '1.4.6', clientType: 'desktop', module: 'device_file_download_to_local', failureCount: 6, runCount: 2 }],
  samples: [{ eventId: 'event-a', occurredAt: at, accountId: 'account-a', appVersion: '1.4.6', clientType: 'desktop', module: 'agent-tool', toolName: 'device_file_download_to_local', failureCategory: 'not_found', failureDetail: 'File not found' }],
};

test('timestamp validation rejects calendar/time/offset rollover while preserving valid ISO offsets', () => {
  assert.equal(alertEvidenceTimestamp('2026-10-15T17:43:57+08:00'), at);
  assert.equal(alertEvidenceTimestamp('2026-10-15T04:13:57-05:30'), at);
  assert.equal(alertEvidenceTimestamp('2024-02-29T23:00:00.123+08:00'), '2024-02-29T15:00:00.123Z');
  for (const invalid of ['2026-02-30T09:43:57Z', '2026-02-29T09:43:57Z', '2026-04-31T09:43:57Z',
    '2026-10-15T24:00:00Z', '2026-10-15T25:00:00Z', '2026-10-15T09:60:00Z', '2026-10-15T09:43:60Z',
    '2026-10-15T09:43:57+24:00', '2026-10-15T09:43:57+08:60', '2026-10-15T09:43:57+8:00',
    '2026-10-15', '1']) assert.equal(alertEvidenceTimestamp(invalid), null, invalid);
});

test('snapshot writes are parameterized, tenant-bound, bounded and whitelist operational facts', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const p = { query: async (sql: string, params: unknown[] = []) => { queries.push({ sql, params }); return { rows: [] }; } };
  await ensureAlertEvidenceSchema(p);
  await ensureAlertEvidenceSchema(p);
  assert.equal(queries.filter(({ sql }) => /create table/i.test(sql)).length, 1);
  await recordAlertEvidenceSnapshot(p, { key: "tool-failure-repeat';drop table users;--", at, tenantId: 'team-a', evidence: {
    ...evidence,
    groups: Array.from({ length: 40 }, () => ({ ...evidence.groups[0], secret: 'hidden credential' })),
    samples: Array.from({ length: 40 }, () => ({ ...evidence.samples[0], prompt: 'private prompt' })),
    secret: 'hidden credential',
  } as AlertEvidence });
  const insert = queries.find(({ sql }) => /insert into public.studio_alert_evidence_snapshots/.test(sql));
  assert.ok(insert);
  assert.equal(insert.sql.includes('drop table'), false);
  assert.ok(insert.params.includes('team-a'));
  const saved = JSON.parse(insert.params.find((value) => typeof value === 'string' && value.startsWith('{')) as string);
  assert.equal(saved.groups.length, 8);
  assert.equal(saved.samples.length, 20);
  assert.equal(JSON.stringify(saved).includes('hidden credential'), false);
  assert.equal(JSON.stringify(saved).includes('private prompt'), false);
  assert.ok(queries.some(({ sql }) => /delete from public.studio_alert_evidence_snapshots/.test(sql) && /35 days/.test(sql)));
});

test('historical reads never fall back to the latest snapshot and scrub non-contract database fields', async () => {
  const reads: Array<{ sql: string; params: unknown[] }> = [];
  const p = { query: async (sql: string, params: unknown[] = []) => {
    if (/select .*alert_key/s.test(sql)) {
      reads.push({ sql, params });
      return { rows: params.includes(at) ? [{ alert_key: 'tool-failure-repeat', occurred_at: new Date(at), evidence: { ...evidence, rawPayload: 'private payload' } }] : [] };
    }
    return { rows: [] };
  } };
  const saved = await readAlertEvidenceSnapshot(p, 'tool-failure-repeat', at);
  assert.equal(saved?.evidence.runCount, 2);
  assert.equal(saved?.occurredAt, at);
  assert.equal(JSON.stringify(saved).includes('private payload'), false);
  assert.equal(await readAlertEvidenceSnapshot(p, 'tool-failure-repeat', '2026-10-15T08:00:00.000Z'), null);
  assert.ok(reads.every(({ params }) => params.includes('platform')));
  assert.match(reads[0].sql, /occurred_at\s*=\s*\$\d+::timestamptz/);
  await readAlertEvidenceSnapshot(p, 'tool-failure-repeat', undefined, 'team-a');
  assert.ok(reads.at(-1)?.params.includes('team-a'));
  assert.match(reads.at(-1)?.sql ?? '', /order by occurred_at desc\s+limit 1/);
});

test('invalid timestamps or evidence fail before any database mutation', async () => {
  let queries = 0;
  const p = { query: async () => { queries += 1; return { rows: [] }; } };
  await assert.rejects(recordAlertEvidenceSnapshot(p, { key: 'tool-failure-repeat', at: 'yesterday', evidence }), /invalid_alert_evidence_time/);
  await assert.rejects(recordAlertEvidenceSnapshot(p, { key: 'tool-failure-repeat', at, evidence: { ...evidence, windowStart: 'no date' } }), /invalid_alert_evidence/);
  assert.equal(queries, 0);
});
