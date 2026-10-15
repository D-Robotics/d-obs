import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAccountActivity, getAccountEventLog } from './observability-account-activity.js';

const databaseUrl = String(process.env.DOBS_ACCOUNT_TEST_DATABASE_URL ?? '').trim();
type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
const tables = ['credit_account', 'agent_run_records', 'conversation_turns', 'studio_daily_usage', 'studio_alert_configuration_audit', 'studio_alert_incident_activity', 'studio_ops_events'];

test('account time windows and source availability use a dedicated real PostgreSQL fixture', { skip: !databaseUrl, timeout: 20_000 }, async (t) => {
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, '127.0.0.1', 'Fixture must use loopback');
  assert.equal(parsed.pathname, '/dobs_account_window_test', 'Refuse a production or shared database');
  assert.equal(parsed.username, 'dobs_account_fixture', 'Refuse a production role');
  const pg = await import('pg' as string);
  const PgClient = (pg as unknown as { default: { Client: new (options: { connectionString: string }) => Client } }).default.Client;
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();
  const existing = await client.query("select tablename from pg_tables where schemaname='public'");
  assert.equal(existing.rows.length, 0, 'Fixture must start empty; do not overwrite preexisting tables');
  try {
    await client.query("set time zone 'Asia/Shanghai'");
    await client.query(`
      create table public.credit_account(sso_user_id text,created_at timestamptz,source text);
      create table public.agent_run_records(sso_user_id text,run_id text,started_at timestamptz,completed_at timestamptz,outcome text,error_category text,elapsed_ms int,prompt_tokens int,completion_tokens int,model text,channel text,client_type text,device_id text,session_id text);
      create table public.conversation_turns(sso_user_id text,sso_user_name text,recorded_at timestamptz,outcome text,channel text,error_detail text,session_id text,tools_used text[],app_version text,user_message text,assistant_message text);
      create table public.studio_daily_usage(sso_user_id text,usage_date date);
      create table public.studio_alert_configuration_audit(actor text,occurred_at timestamptz,action text,summary text);
      create table public.studio_alert_incident_activity(actor text,occurred_at timestamptz,alert_key text,action text,summary text);
      create table public.studio_ops_events(occurred_at timestamptz,component text,event_code text,outcome text,safe_summary text,metadata jsonb,correlation jsonb);
      insert into public.credit_account values('fixture-account',now()-interval '300 days','fixture');
      insert into public.agent_run_records(sso_user_id,run_id,started_at,outcome,prompt_tokens,completion_tokens,session_id) values
        ('fixture-account','near-run',now()-interval '1 hour','completed',10,20,'fixture-session'),
        ('fixture-account','old-run',now()-interval '400 hours','completed',10,20,'old-session'),
        ('fixture-account','future-run',now()+interval '2 hours','completed',10,20,'future-session'),
        ('other-account','other-run',now()-interval '1 hour','completed',10,20,'other-session');
      insert into public.conversation_turns(sso_user_id,sso_user_name,recorded_at,outcome,session_id,tools_used,user_message,assistant_message) values
        ('fixture-account','fixture-name',now()-interval '1 hour','completed','fixture-session',array['query'],'fixture prompt must not be returned','fixture answer must not be returned'),
        ('fixture-account','fixture-name',now()-interval '400 hours','completed','old-session',array['query'],'old prompt','old answer'),
        ('fixture-account','fixture-name',now()+interval '2 hours','completed','future-session',array['query'],'future prompt','future answer'),
        ('other-account','other-name',now()-interval '1 hour','completed','other-session',array['query'],'foreign prompt','foreign answer');
      insert into public.studio_daily_usage values
        ('fixture-account',current_date),('fixture-account',current_date-1),('fixture-account',current_date-10),('fixture-account',current_date+1),('other-account',current_date);
      insert into public.studio_alert_configuration_audit values
        ('fixture-account',now()-interval '1 hour','config_patch','near'),('fixture-account',now()-interval '400 hours','config_patch','old'),('fixture-account',now()+interval '2 hours','config_patch','future'),('other-account',now()-interval '1 hour','config_patch','foreign'),
        ('fixture-account',now()-interval '1 hour','sso_login','near login'),('fixture-account',now()-interval '400 hours','sso_login','old login');
      insert into public.studio_alert_incident_activity values
        ('fixture-account',now()-interval '1 hour','fixture-alert','acknowledge','near'),('fixture-account',now()-interval '400 hours','fixture-alert','acknowledge','old'),('fixture-account',now()+interval '2 hours','fixture-alert','acknowledge','future'),('other-account',now()-interval '1 hour','fixture-alert','acknowledge','foreign');
      insert into public.studio_ops_events values
        (now()-interval '1 hour','fixture','direct','ok','near','{"sso_user_id":"fixture-account"}','{}'),
        (now()-interval '400 hours','fixture','old','ok','old','{"sso_user_id":"fixture-account"}','{}'),
        (now()+interval '2 hours','fixture','future','ok','future','{"sso_user_id":"fixture-account"}','{}'),
        (now()-interval '1 hour','fixture','foreign','ok','foreign','{"sso_user_id":"other-account"}','{}'),
        (now()-interval '1 hour','fixture','session','ok','near session','{"session_id":"fixture-session"}','{}');
    `);
    await t.test('hour windows exclude old, future and foreign activity while registration stays all-history', async () => {
      const report = await getAccountActivity(client, 'fixture-name', 48);
      assert.deepEqual(report.resolvedIds, ['fixture-name', 'fixture-account']);
      assert.equal(report.runs.total, 1); assert.equal(report.runs.totalTokens, 30);
      assert.equal(report.turns.total, 1); assert.equal(report.runs.recent.length, 1); assert.equal(report.turns.recent.length, 1);
      assert.equal(report.configAudit.length, 1); assert.equal(report.loginAudit.length, 1); assert.equal(report.incidentActivity.length, 1); assert.equal(report.opsEvents.length, 1);
      assert.equal(report.configAudit[0].summary, 'near'); assert.equal(report.incidentActivity[0].summary, 'near');
      assert.equal(report.registrationScope, 'all_history'); assert.ok(report.registeredAt);
      assert.equal(report.timeWindow.hours, 48); assert.equal(Date.parse(report.timeWindow.to) - Date.parse(report.timeWindow.from), 48 * 3_600_000);
      assert.equal(report.dataCompleteness, 'complete'); assert.deepEqual(report.warnings, []);
      assert.ok(Object.values(report.sourceAvailability).every((source) => source.status === 'ok'));
      assert.equal(JSON.stringify(report).includes('fixture prompt must not be returned'), false);
      assert.equal(JSON.stringify(report).includes('fixture answer must not be returned'), false);
    });
    await t.test('daily usage uses the window calendar days and declares database day precision/time zone', async () => {
      const report = await getAccountActivity(client, 'fixture-account', 48);
      assert.equal(report.usage.activeDays, 2);
      assert.equal(report.usage.precision, 'day'); assert.equal(report.usage.timeZone, 'Asia/Shanghai');
      const expected = await client.query('select $1::timestamptz::date::text from_day,$2::timestamptz::date::text to_day', [report.timeWindow.from, report.timeWindow.to]);
      assert.equal(report.usage.fromDay, expected.rows[0].from_day); assert.equal(report.usage.toDay, expected.rows[0].to_day);
    });
    await t.test('event drilldown keeps window/account isolation and real session correlation', async () => {
      const log = await getAccountEventLog(client, 'fixture-name', 48, { limit: 200 });
      assert.equal(log.events.length, 2);
      assert.deepEqual(log.events.map((row) => row.event_code).sort(), ['direct', 'session']);
      assert.equal(log.dataCompleteness, 'complete'); assert.equal(log.sourceAvailability.events.status, 'ok');
      assert.ok(log.events.every((row) => Date.parse(String(row.occurred_at)) >= Date.parse(log.timeWindow.from)));
    });
    await t.test('a missing daily table is unavailable, never a definitive zero active-day claim', async () => {
      await client.query('alter table public.studio_daily_usage rename to fixture_missing_usage');
      try {
        const report = await getAccountActivity(client, 'fixture-account', 48);
        assert.equal(report.sourceAvailability.usage.status, 'unavailable'); assert.deepEqual(report.sourceAvailability.usage.errorCodes, ['42P01']);
        assert.equal(report.dataCompleteness, 'partial'); assert.equal(report.runs.total, 1);
        assert.match(report.warnings.join(' '), /不能解释为没有活动/);
      } finally { await client.query('alter table public.fixture_missing_usage rename to studio_daily_usage'); }
    });
    await t.test('a failed recent query marks its source partial without hiding the successful aggregate', async () => {
      await client.query('alter table public.conversation_turns rename column tools_used to fixture_missing_tools');
      try {
        const report = await getAccountActivity(client, 'fixture-account', 48);
        assert.equal(report.turns.total, 1); assert.equal(report.turns.recent.length, 0);
        assert.equal(report.sourceAvailability.turns.status, 'partial'); assert.deepEqual(report.sourceAvailability.turns.errorCodes, ['42703']);
        assert.equal(report.sourceAvailability.turns.successfulQueries, 1); assert.equal(report.sourceAvailability.turns.failedQueries, 1);
        assert.equal(report.dataCompleteness, 'partial');
      } finally { await client.query('alter table public.conversation_turns rename column fixture_missing_tools to tools_used'); }
    });
    await t.test('event source failures remain explicit in the drilldown response', async () => {
      await client.query('alter table public.studio_ops_events rename to fixture_missing_events');
      try {
        const log = await getAccountEventLog(client, 'fixture-account', 48);
        assert.equal(log.events.length, 0); assert.equal(log.sourceAvailability.events.status, 'unavailable');
        assert.equal(log.sourceAvailability.eventCodes.status, 'unavailable'); assert.equal(log.sourceAvailability.sessionCorrelation.status, 'ok');
        assert.equal(log.dataCompleteness, 'partial'); assert.match(log.warnings.join(' '), /兼容占位/);
      } finally { await client.query('alter table public.fixture_missing_events rename to studio_ops_events'); }
    });
  } finally {
    for (const table of [...tables].reverse()) await client.query(`drop table if exists public.${table}`);
    await client.end();
  }
});
