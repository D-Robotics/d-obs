import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectAlertEvidence } from './studio-alert-evidence.js';
import { deliverWithAlertEvidenceSnapshot, toolFailureObservation, TOOL_FAILURE_OBSERVATION_QUERY } from './studio-alert-worker.js';
import { DEFAULT_ALERT_CONFIG } from './alert-config.js';
import type { AlertTransition } from './studio-alert-state.js';

const AT = '2026-10-15T09:43:57.000Z';

test('tool observation distinguishes two runs from six failed calls without weakening the call threshold', () => {
  const config = structuredClone(DEFAULT_ALERT_CONFIG);
  config.rules['tool-failure-repeat'].threshold = 3;
  const observation = toolFailureObservation(config, {
    tool_name: 'device_file_download_to_local', n: 6, event_count: 6, run_count: 2,
  });
  assert.equal(observation.unhealthy, true);
  assert.match(observation.summary, /2 个 run/);
  assert.match(observation.summary, /6 次失败/);
  const oneRun = toolFailureObservation(config, { tool_name: 'x', n: 4, event_count: 4, run_count: 1 });
  assert.equal(oneRun.unhealthy, true, 'A repeatedly failing single run must still trigger');
  assert.match(oneRun.summary, /1 个 run/);
});

test('infrastructure evidence declares account dimensions inapplicable and performs no business query', async () => {
  const evidence = await collectAlertEvidence({ query: async () => { throw new Error('must not query'); } }, 'disk-space', 10, AT);
  assert.equal(evidence.applicability, 'infrastructure');
  assert.equal(evidence.windowStart, '2026-10-15T09:33:57.000Z');
  assert.equal(evidence.windowEnd, AT);
  assert.deepEqual(evidence.groups, []);
  assert.deepEqual(evidence.samples, []);
});

test('unsupported business and unknown/custom rules declare missing evidence rather than account dimensions inapplicable', async () => {
  const noQuery = { query: async () => { throw new Error('Unsupported sources must not query unrelated business data'); } };
  for (const key of ['llm-token-budget', 'north-star-first-success-rate', 'future-rule', 'strategy-custom', 't.team.health']) {
    const evidence = await collectAlertEvidence(noQuery, key, 10, AT);
    assert.equal(evidence.applicability, 'business', key + ' must not be declared infrastructure without explicit classification');
    assert.deepEqual(evidence.groups, []);
    assert.deepEqual(evidence.samples, []);
  }
});

test('notification delivery observes a saved snapshot first; snapshot failure preserves facts and declares missing history', async () => {
  const evidence = { windowStart: '2026-10-15T09:33:57.000Z', windowEnd: AT, eventCount: 6, runCount: 2,
    totalGroups: 0, groups: [], samples: [], applicability: 'business' as const };
  const transition = (): AlertTransition => ({ kind: 'opened', key: 'tool-failure-repeat', title: 'failure', severity: 'warning',
    summary: 'six calls', at: AT, evidence });
  const pool = { query: async () => ({ rows: [] }) };
  const order: string[] = [];
  const successful = transition();
  const result = await deliverWithAlertEvidenceSnapshot(pool, successful, async () => {
    order.push('deliver');
    assert.equal(successful.evidenceUnavailable, undefined);
    return 'delivered';
  }, { recordSnapshot: async (_pool, input) => { order.push('snapshot'); assert.equal(input.at, AT); assert.equal(input.evidence, evidence); } });
  assert.equal(result, 'delivered');
  assert.deepEqual(order, ['snapshot', 'deliver']);
  const failed = transition();
  let reported = false;
  await deliverWithAlertEvidenceSnapshot(pool, failed, async () => {
    assert.equal(failed.evidenceUnavailable, true);
    assert.equal(failed.evidence, evidence, 'The notification still has the collected operational facts');
  }, { recordSnapshot: async () => { throw new Error('fixture snapshot write failed'); }, onSnapshotError: () => { reported = true; } });
  assert.equal(reported, true, 'A failed write must remain observable');
  const disconnected = transition();
  await deliverWithAlertEvidenceSnapshot(null, disconnected, async () => {
    assert.equal(disconnected.evidenceUnavailable, true, 'No database cannot produce an exact historical link');
  });
});

const databaseUrl = String(process.env.DOBS_ALERT_EVIDENCE_TEST_DATABASE_URL ?? '').trim();
type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

test('alert evidence uses full scoped PostgreSQL aggregates and bounded safe samples', { skip: !databaseUrl, timeout: 20_000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/dobs_alert_evidence_test', 'Refuse any shared database');
  assert.equal(url.username, 'dobs_alert_fixture', 'Refuse a production role');
  const pg = await import('pg' as string);
  const PgClient = (pg as unknown as { default: { Client: new (options: { connectionString: string }) => Client } }).default.Client;
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();
  const existing = await client.query("select tablename from pg_tables where schemaname='public'");
  assert.equal(existing.rows.length, 0, 'Fixture must start empty');
  try {
    await client.query(`
      create table public.studio_ops_events(id text,occurred_at timestamptz,component text,event_code text,outcome text,metadata jsonb,correlation jsonb,tenant_id text,safe_summary text);
      create table public.agent_run_records(sso_user_id text,run_id text,started_at timestamptz,created_at timestamptz,outcome text,error_category text,error_detail text,client_type text,app_version text,environment text,tool_call_count int,completion_tokens int);
    `);
    const reset = async () => client.query('truncate public.studio_ops_events,public.agent_run_records');
    const event = async (id: string, overrides: Record<string, unknown> = {}) => {
      const row = { at: '2026-10-15T09:42:00Z', component: 'moss-tool', code: 'tool_call', outcome: 'error',
        metadata: { tool_name: 'device_file_download_to_local', tool_call_id: id, failure_category: 'device_state', code: 'not_a_file' },
        correlation: { user_id: 'sample-operator', run_id: 'run-1', environment: 'production', app_version: '1.4.6', client_type: 'desktop' },
        tenant: 'platform', ...overrides };
      await client.query('insert into public.studio_ops_events values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)',
        [id,row.at,row.component,row.code,row.outcome,JSON.stringify(row.metadata),JSON.stringify(row.correlation),row.tenant,'Sensitive prompt /private/workspace/file.txt password=do-not-return']);
    };
    await t.test('six calls in two runs match only the selected tool, tenant and evaluation window', async () => {
      await reset();
      for (let i = 0; i < 6; i++) await event('failure-' + i, { correlation: { user_id: 'sample-operator', run_id: i < 3 ? 'run-1' : 'run-2', environment: 'production', app_version: '1.4.6', client_type: 'desktop' } });
      await event('success', { outcome: 'ok' });
      await event('foreign', { tenant: 'other-tenant' });
      await event('old', { at: '2026-10-15T09:20:00Z' });
      await event('future', { at: '2026-10-15T09:44:00Z' });
      await event('local', { metadata: { tool_name: 'device_file_download_to_local', client_type: 'local-dev' } });
      await event('other-tool', { metadata: { tool_name: 'device_file_download_to_local_extra' } });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT, 'platform', 'device_file_download_to_local');
      assert.equal(evidence.applicability, 'business');
      assert.equal(evidence.eventCount, 6);
      assert.equal(evidence.runCount, 2);
      assert.equal(evidence.totalGroups, 1);
      assert.deepEqual(evidence.groups, [{ accountId: 'sample-operator', appVersion: '1.4.6', clientType: 'desktop', module: '设备文件传输', failureCount: 6, runCount: 2 }]);
      assert.equal(evidence.samples.length, 6);
      assert.ok(evidence.samples.every((sample) => sample.failureDetail === 'not_a_file'));
      const top = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      assert.equal(top.eventCount, 6, 'Without a tool parameter choose the actual top failing tool');
    });
    await t.test('the worker query keeps six failed-call threshold units while reporting two real runs', async () => {
      await reset();
      const occurredAt = new Date().toISOString();
      for (let i = 0; i < 6; i++) await event('worker-' + i, { at: occurredAt,
        correlation: { user_id: 'account-a', run_id: i < 3 ? 'run-a' : 'run-b', environment: 'production' } });
      const result = await client.query(TOOL_FAILURE_OBSERVATION_QUERY, [10]);
      assert.equal(result.rows[0].n, 6);
      assert.equal(result.rows[0].event_count, 6);
      assert.equal(result.rows[0].run_count, 2);
      const observation = toolFailureObservation(DEFAULT_ALERT_CONFIG, result.rows[0]);
      assert.equal(observation.unhealthy, true);
      assert.match(observation.summary, /2 个 run/);
    });
    await t.test('worker failure units share the collector account/environment/run/call identity', async () => {
      await reset();
      const occurredAt = new Date().toISOString();
      for (const [id, account, environment] of [['account-a-prod', 'account-a', 'production'], ['account-b-prod', 'account-b', 'production'], ['account-a-stage', 'account-a', 'staging'], ['duplicate-a-prod', 'account-a', 'production']]) {
        await event(id, { at: occurredAt, metadata: { tool_name: 'device_file_download_to_local', tool_call_id: 'same-call' },
          correlation: { user_id: account, run_id: 'same-run', environment } });
      }
      const result = await client.query(TOOL_FAILURE_OBSERVATION_QUERY, [10]);
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, new Date(Date.parse(occurredAt) + 1000));
      assert.equal(result.rows[0].n, 3, 'Account or environment changes identify independent failed calls');
      assert.equal(result.rows[0].run_count, 3);
      assert.equal(evidence.groups.reduce((total, group) => total + group.failureCount, 0), result.rows[0].n);
      assert.equal(evidence.eventCount, 4, 'A duplicated stored event is not an additional failed call');
    });
    await t.test('totals remain complete beyond group/sample caps and runs use account/environment/run identity', async () => {
      await reset();
      for (let group = 0; group < 10; group++) for (let i = 0; i < 3; i++) await event('g' + group + '-' + i, {
        correlation: { user_id: 'account-' + group, run_id: 'same-run-id', environment: group % 2 ? 'production' : 'staging', app_version: group % 2 ? '1.4.6' : '1.4.7', client_type: group % 2 ? 'desktop' : 'web' },
      });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      assert.equal(evidence.eventCount, 30);
      assert.equal(evidence.runCount, 10);
      assert.equal(evidence.totalGroups, 10);
      assert.equal(evidence.groups.length, 8);
      assert.equal(evidence.samples.length, 20);
      assert.ok(evidence.groups.every((group) => group.failureCount === 3 && group.runCount === 1));
      await event('same-account-other-environment', { correlation: { user_id: 'account-0', run_id: 'same-run-id', environment: 'production' } });
      assert.equal((await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT)).runCount, 11);
    });
    await t.test('missing run identity never becomes a fabricated run and explicit module wins', async () => {
      await reset();
      await event('unknown-run', { correlation: {}, component: 'device-tools', metadata: { tool_name: 'device_file_download_to_local', feature_module: '文件管理', app_version: '1.4.6', client_type: 'desktop' } });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      assert.equal(evidence.eventCount, 1);
      assert.equal(evidence.runCount, 0);
      assert.equal(evidence.groups[0].runCount, 0);
      assert.equal(evidence.groups[0].accountId, null);
      assert.equal(evidence.groups[0].module, '文件管理');
      assert.equal(evidence.groups[0].appVersion, '1.4.6');
      await reset();
      await event('unknown-tool', { component: 'device-tools', metadata: { tool_name: 'custom_tool' } });
      assert.equal((await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT)).groups[0].module, 'device-tools');
    });
    await t.test('call retries deduplicate failure units without changing the raw event total', async () => {
      await reset();
      await event('duplicate-1', { metadata: { tool_name: 'device_file_download_to_local', tool_call_id: 'one-call' } });
      await event('duplicate-2', { metadata: { tool_name: 'device_file_download_to_local', tool_call_id: 'one-call' } });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      assert.equal(evidence.eventCount, 2);
      assert.equal(evidence.groups[0].failureCount, 1);
      assert.equal(evidence.runCount, 1);
    });
    await t.test('group dimensions follow the declared module rather than splitting by transport component', async () => {
      await reset();
      await event('module-a', { component: 'component-a', metadata: { tool_name: 'device_file_download_to_local', module: '设备工作台', surface: 'fallback' } });
      await event('module-b', { component: 'component-b', metadata: { tool_name: 'device_file_download_to_local', feature_module: '设备工作台', module: 'unused' } });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      assert.equal(evidence.totalGroups, 1);
      assert.equal(evidence.groups[0].module, '设备工作台');
      assert.equal(evidence.groups[0].failureCount, 2);
      await reset();
      await event('surface-only', { metadata: { tool_name: 'custom_tool', surface: '硬件面板' } });
      assert.equal((await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT)).groups[0].module, '硬件面板');
    });
    await t.test('evidence never contains raw summaries, prompt/argument fields, paths or credentials', async () => {
      await reset();
      await event('safe-id', { metadata: { tool_name: 'device_file_download_to_local', feature_module: '/private/secret/path', module: 'password=do-not-return', code: 'Bearer confidential-secret', prompt: 'confidential prompt', arguments: '/private/tool/arguments', token: 'secret-token' }, correlation: { user_id: 'safe-account', environment: 'production', run_id: 'safe-run', app_version: '/private/version/path', client_type: 'desktop' } });
      const evidence = await collectAlertEvidence(client, 'tool-failure-repeat', 10, AT);
      const serialized = JSON.stringify(evidence);
      assert.doesNotMatch(serialized, /private|password|Bearer|confidential|secret-token|Sensitive prompt|arguments/);
      assert.equal(evidence.groups[0].appVersion, null);
      assert.equal(evidence.samples[0].failureDetail, null);
    });
    await t.test('AI failure/auth evidence uses latest scoped run facts and exposes no pretend event ids', async () => {
      await reset();
      await client.query(`insert into public.agent_run_records values
        ('account-a','same-run','2026-10-15T09:42:00Z','2026-10-15T09:42:01Z','error','auth','api_key=secret','desktop','1.4.6','production',1,0),
        ('account-a','same-run','2026-10-15T09:42:00Z','2026-10-15T09:42:02Z','completed',null,null,'desktop','1.4.6','production',1,20),
        ('account-b','same-run','2026-10-15T09:42:00Z','2026-10-15T09:42:01Z','error','quota_exceeded','token=secret','web','1.4.7','production',1,0),
        ('account-c','partial','2026-10-15T09:42:00Z','2026-10-15T09:42:01Z','completed_partial',null,'partial_reason=acceptance_audit','desktop','1.4.6','production',1,0)`);
      const ai = await collectAlertEvidence(client, 'ai-run-degraded-rate', 10, AT);
      const auth = await collectAlertEvidence(client, 'ai-auth-or-quota', 10, AT);
      assert.equal(ai.runCount, 1);
      assert.equal(auth.runCount, 1);
      assert.equal(ai.groups[0].accountId, 'account-b');
      assert.deepEqual(ai.samples, []);
      assert.doesNotMatch(JSON.stringify(auth), /api_key|token=secret/);
    });
    await t.test('SSO/API evidence keeps real event dimensions and excludes normal credential rejection', async () => {
      await reset();
      await event('login-error', { code: 'sso_login_attempt', component: 'sso-relay', metadata: { code: 'upstream_unavailable', surface: '登录' }, correlation: { user_id: 'account-a', environment: 'production' } });
      await event('bad-password', { code: 'sso_login_attempt', outcome: 'rejected' });
      await event('api-error', { code: 'http_5xx', component: 'http-server', metadata: { status: 500, module: '工作台' }, correlation: {} });
      assert.equal((await collectAlertEvidence(client, 'sso-infrastructure-failure', 10, AT)).eventCount, 1);
      const api = await collectAlertEvidence(client, 'api-5xx-spike', 10, AT);
      assert.equal(api.eventCount, 1);
      assert.equal(api.samples[0].failureDetail, 'HTTP 500');
      assert.equal(api.groups[0].module, '工作台');
    });
    await t.test('client failure occurrences are weighted while eventCount remains the stored record count', async () => {
      await reset();
      await event('client-batch', { code: 'client_error', metadata: { operational: 'true', source: 'window_error', occurrence_count: 20, module: '工作台', environment: 'production' } });
      const evidence = await collectAlertEvidence(client, 'api-5xx-spike', 10, AT);
      assert.equal(evidence.eventCount, 1);
      assert.equal(evidence.samples.length, 1);
      assert.equal(evidence.groups[0].failureCount, 20);
    });
  } finally {
    await client.query('drop table if exists public.studio_ops_events,public.agent_run_records');
    await client.end();
  }
});
