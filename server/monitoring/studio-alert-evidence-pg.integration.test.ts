import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureAlertEvidenceSchema, readAlertEvidenceSnapshot, recordAlertEvidenceSnapshot } from './studio-alert-evidence-store.js';
import type { AlertEvidence } from './studio-alert-evidence-types.js';
import { configureOpsObservabilityPoolForTest as configureObjectResolverPool } from './observability-store.js';
import { recordIncident, recordIncidentSnapshots } from './studio-alert-delivery.js';
import { reconcileAlertState, type AlertObservation } from './studio-alert-state.js';

const databaseUrl = String(process.env.DOBS_ALERT_EVIDENCE_TEST_DATABASE_URL ?? '').trim();
type Client = {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

test('alert history and recurrent incidents use a dedicated real PostgreSQL fixture', { skip: !databaseUrl, timeout: 20_000 }, async (t) => {
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/dobs_alert_evidence_test');
  assert.equal(parsed.username, 'dobs_alert_fixture');
  const pg = await import('pg' as string);
  const PgClient = (pg as unknown as { default: { Client: new (options: { connectionString: string }) => Client } }).default.Client;
  const rawClient = new PgClient({ connectionString: databaseUrl });
  // Production uses a pool; serialize this one-connection fixture so parallel
  // list/count queries exercise SQL without relying on pg's deprecated queue.
  let queryTail = Promise.resolve();
  const client: Client = {
    connect: () => rawClient.connect(),
    end: async () => { await queryTail; await rawClient.end(); },
    query: (sql, params) => {
      const result = queryTail.then(() => rawClient.query(sql, params));
      queryTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  await client.connect();
  const existing = await client.query("select tablename from pg_tables where schemaname = 'public'");
  assert.equal(existing.rows.length, 0, 'Refuse preexisting fixture data');
  const store = await import(process.env.DOBS_ALERT_EVIDENCE_BASELINE_STORE ?? './observability-store.js');
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 1_000).toISOString();
  const evidence: AlertEvidence = { windowStart: new Date(Date.now() - 600_000).toISOString(), windowEnd: at, eventCount: 6, runCount: 2, totalGroups: 1, groups: [{ accountId: 'account-a', appVersion: '1.4.6', clientType: 'desktop', module: 'agent-tool', failureCount: 6, runCount: 2 }], samples: [], applicability: 'business' };
  try {
    await t.test('exact historical snapshots are immutable and tenant isolated; old cards find the newest', async () => {
      await recordAlertEvidenceSnapshot(client, { key: 'tool-failure-repeat', at, evidence });
      await recordAlertEvidenceSnapshot(client, { key: 'tool-failure-repeat', at, evidence: { ...evidence, eventCount: 999 } });
      await recordAlertEvidenceSnapshot(client, { key: 'tool-failure-repeat', at: later, evidence: { ...evidence, eventCount: 7 } });
      await recordAlertEvidenceSnapshot(client, { key: 'tool-failure-repeat', at, tenantId: 'team-a', evidence: { ...evidence, eventCount: 1 } });
      assert.equal((await readAlertEvidenceSnapshot(client, 'tool-failure-repeat', at))?.evidence.eventCount, 6);
      assert.equal((await readAlertEvidenceSnapshot(client, 'tool-failure-repeat'))?.evidence.eventCount, 7);
      assert.equal((await readAlertEvidenceSnapshot(client, 'tool-failure-repeat', at, 'team-a'))?.evidence.eventCount, 1);
      assert.equal(await readAlertEvidenceSnapshot(client, 'tool-failure-repeat', at, 'team-b'), null);
      assert.equal(await readAlertEvidenceSnapshot(client, 'tool-failure-repeat', new Date(Date.now() - 60_000).toISOString()), null);
    });
    await t.test('retention preserves evidence longer than the 30-day source event window', async () => {
      await ensureAlertEvidenceSchema(client);
      await client.query(`insert into public.studio_alert_evidence_snapshots (tenant_id,alert_key,occurred_at,evidence)
        values ('platform','retained-34-days',now()-interval '34 days',$1::jsonb),
               ('platform','expired-36-days',now()-interval '36 days',$1::jsonb)`, [JSON.stringify(evidence)]);
      await recordAlertEvidenceSnapshot(client, { key: 'tool-failure-repeat', at, evidence });
      assert.ok(await readAlertEvidenceSnapshot(client, 'retained-34-days'));
      assert.equal(await readAlertEvidenceSnapshot(client, 'expired-36-days'), null);
    });
    await t.test('30-day incident center includes today recurrence, recent resolution and all active incidents', async () => {
      store.configureOpsObservabilityPoolForTest(client);
      await store.ensureIncidentOperationsSchema(client);
      await client.query(`insert into public.studio_alert_incidents
        (alert_key,title,severity,status,first_seen_at,last_seen_at,resolved_at,object_id,tenant_id) values
        ('recurrent','Recurrent','warning','open',now()-interval '50 days',now(),null,'service/fixture','platform'),
        ('still-active','Old active','warning','acknowledged',now()-interval '60 days',now()-interval '59 days',null,'service/fixture','platform'),
        ('recently-resolved','Resolved','warning','resolved',now()-interval '50 days',now()-interval '49 days',now(),'service/fixture','platform'),
        ('recent-last-seen','Recently seen','warning','resolved',now()-interval '50 days',now(),now()-interval '49 days','service/fixture','platform'),
        ('old-resolved','Old resolved','warning','resolved',now()-interval '60 days',now()-interval '59 days',now()-interval '58 days','service/fixture','platform'),
        ('tenant-active','Foreign active','warning','open',now()-interval '60 days',now(),null,'service/fixture','team-a')`);
      const report = await store.listOpsIncidents({ state: 'all', tenantScope: 'platform', days: 30 });
      assert.deepEqual(report.incidents.map((item: { key: string }) => item.key).sort(), ['recent-last-seen', 'recently-resolved', 'recurrent', 'still-active']);
      assert.equal(report.total, 4);
      assert.equal(report.incidents[0].key, 'recurrent');
      const active = await store.listOpsIncidents({ state: 'active', tenantScope: 'platform', days: 1 });
      assert.equal(active.total, 2);
      const closed = await store.listOpsIncidents({ state: 'closed', tenantScope: 'platform', days: 30 });
      assert.equal(closed.total, 2);
    });
    await t.test('snapshot then transition reopens a resolved incident at the new Pending first-seen time', async () => {
      configureObjectResolverPool(client);
      await client.query(`insert into public.studio_alert_incidents
        (alert_key,title,severity,status,first_seen_at,last_seen_at,resolved_at,acknowledged_at,acknowledged_by,object_id,tenant_id)
        values ('tool-failure-repeat','Old tool failure','warning','resolved',now()-interval '60 days',now()-interval '59 days',now()-interval '58 days',now()-interval '60 days','old-owner','service/fixture','platform')`);
      const observation: AlertObservation = { key: 'tool-failure-repeat', title: 'Tool failures', summary: '6 calls in 2 runs', severity: 'warning', unhealthy: true, openAfter: 2, evidence };
      const pendingAt = new Date(Date.now() - 60_000);
      const pending = reconcileAlertState({ version: 1, keys: {} }, [observation], pendingAt);
      const openedAt = new Date();
      const opened = reconcileAlertState(pending.state, [observation], openedAt);
      assert.equal(opened.transitions.length, 1);
      await recordIncidentSnapshots(client, [observation], opened.state, openedAt.toISOString());
      await recordIncident(client, opened.transitions[0], true);
      const row = (await client.query("select * from public.studio_alert_incidents where alert_key='tool-failure-repeat'")).rows[0];
      assert.equal(row.status, 'open');
      assert.equal((row.first_seen_at as Date).toISOString(), pendingAt.toISOString());
      assert.equal((row.last_seen_at as Date).toISOString(), openedAt.toISOString());
      assert.equal(row.resolved_at, null);
      assert.equal(row.acknowledged_at, null);
      assert.equal(row.acknowledged_by, null);
      assert.equal(row.tenant_id, 'platform');
    });
    await t.test('snapshot and transition preserve an existing active incident first-seen and ownership', async () => {
      configureObjectResolverPool(client);
      await client.query(`insert into public.studio_alert_incidents
        (alert_key,title,severity,status,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,object_id,tenant_id)
        values ('central-database','Existing database failure','warning','acknowledged',now()-interval '50 days',now()-interval '1 hour',now()-interval '49 days','current-owner','database/fixture','platform')`);
      const before = (await client.query("select first_seen_at, acknowledged_at from public.studio_alert_incidents where alert_key='central-database'")).rows[0];
      const observation: AlertObservation = { key: 'central-database', title: 'Database failure', summary: 'unavailable', severity: 'warning', unhealthy: true };
      const opened = reconcileAlertState({ version: 1, keys: {} }, [observation]);
      await recordIncidentSnapshots(client, [observation], opened.state, opened.transitions[0].at);
      await recordIncident(client, opened.transitions[0], true);
      const row = (await client.query("select * from public.studio_alert_incidents where alert_key='central-database'")).rows[0];
      assert.equal(row.status, 'acknowledged');
      assert.equal((row.first_seen_at as Date).toISOString(), (before.first_seen_at as Date).toISOString());
      assert.equal((row.acknowledged_at as Date).toISOString(), (before.acknowledged_at as Date).toISOString());
      assert.equal(row.acknowledged_by, 'current-owner');
      assert.equal(row.tenant_id, 'platform');
    });
    await t.test('a transition can directly reopen an old resolved incident with its current Pending timestamp', async () => {
      configureObjectResolverPool(client);
      await client.query(`insert into public.studio_alert_incidents
        (alert_key,title,severity,status,first_seen_at,last_seen_at,resolved_at,object_id,tenant_id)
        values ('api-5xx-spike','Old API failure','warning','resolved',now()-interval '60 days',now()-interval '59 days',now()-interval '58 days','service/fixture','platform')`);
      const firstSeenAt = new Date(Date.now() - 60_000).toISOString();
      await recordIncident(client, { kind: 'opened', key: 'api-5xx-spike', title: 'API failure', severity: 'warning', summary: 'new failure', at, firstSeenAt }, true);
      const row = (await client.query("select * from public.studio_alert_incidents where alert_key='api-5xx-spike'")).rows[0];
      assert.equal(row.status, 'open');
      assert.equal((row.first_seen_at as Date).toISOString(), firstSeenAt);
      assert.equal(row.resolved_at, null);
    });
    await t.test('tenant snapshot followed by its notification transition never enters platform scope', async () => {
      configureObjectResolverPool(client);
      // Dynamic tenant strategy keys use the same runtime incident pipeline.
      const observation = { key: 't.team-a.tool-failure-repeat', title: 'Tenant tool failures', summary: 'tenant failure', severity: 'warning', unhealthy: true } as unknown as AlertObservation;
      const opened = reconcileAlertState({ version: 1, keys: {} }, [observation]);
      await recordIncidentSnapshots(client, [observation], opened.state, opened.transitions[0].at);
      const before = (await client.query('select tenant_id from public.studio_alert_incidents where alert_key=$1', [observation.key])).rows[0];
      assert.equal(before.tenant_id, 'team-a', 'Snapshot must already have the tenant identity before notification delivery');
      await recordIncident(client, opened.transitions[0], true);
      const after = (await client.query('select tenant_id from public.studio_alert_incidents where alert_key=$1', [observation.key])).rows[0];
      assert.equal(after.tenant_id, 'team-a');
      const own = await store.listOpsIncidents({ state: 'all', tenantScope: 'team-a', days: 30 });
      assert.ok(own.incidents.some((item: { key: string }) => item.key === observation.key));
      const platform = await store.listOpsIncidents({ state: 'all', tenantScope: 'platform', days: 30 });
      assert.equal(platform.incidents.some((item: { key: string }) => item.key === observation.key), false);
    });
  } finally {
    store.configureOpsObservabilityPoolForTest(null);
    configureObjectResolverPool(null);
    const tables = await client.query("select tablename from pg_tables where schemaname = 'public'");
    for (const row of tables.rows) await client.query(`drop table public."${String(row.tablename).replaceAll('"', '""')}" cascade`);
    await client.end();
  }
});
