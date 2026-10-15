import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import {
  insertConversationTurnCentral,
  type ConversationTurnCentralRow,
} from './central-telemetry-store.js';
import { CONVERSATION_SCHEMA, type ConversationTurnRecord } from './conversation-types.js';
import { buildSupabaseConversationRow, scheduleCentralConversationInsert } from './supabase-conversation.js';

const row: ConversationTurnCentralRow = {
  recorded_at: '2026-10-12T10:00:00+08:00',
  sso_user_name: 'Test operator',
  user_message: 'Check the camera',
  assistant_message: 'The camera is ready',
  tools_used: ['camera_status'],
  channel: 'studio',
  outcome: 'completed',
  error_detail: null,
  session_id: 'session-camera',
  sso_user_id: 'account-camera',
  run_id: 'run-camera',
  environment: 'production',
  client_type: 'desktop',
  app_version: '1.4.4',
};

async function queryCapture() {
  const pg = await import('pg' as string) as {
    default: { Pool: { prototype: { query: (...args: unknown[]) => Promise<unknown> } } };
  };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const hook = mock.method(pg.default.Pool.prototype, 'query', async (sql: unknown, params?: unknown[]) => {
    calls.push({ sql: String(sql), params: params ?? [] });
    return { rows: [], rowCount: 1 };
  });
  return { calls, restore: () => hook.mock.restore() };
}

function configureWriter() {
  const values = {
    RDK_CHAT_CREDITS_DB_URL: 'postgresql://unused-trace-binding-test',
    RDK_OBSERVABILITY_ENVIRONMENT: 'staging',
    RDK_TELEMETRY_REPORT_ENABLED: '0',
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function insertFields(call: { sql: string; params: unknown[] }) {
  const columns = call.sql.match(/\((source_id,[^)]+)\)\s*values/)?.[1].split(',').map((column) => column.trim());
  assert.ok(columns, 'writer must issue a parameterized conversation insert');
  return Object.fromEntries(columns.map((column, index) => [column, call.params[index]]));
}

test('archive migration adds nullable binding keys and writer scopes exact Run to the server environment', async () => {
  const restoreEnvironment = configureWriter();
  const capture = await queryCapture();
  try {
    assert.equal(await insertConversationTurnCentral(row), true);
    const migrations = capture.calls.filter((call) => /alter table public.conversation_turns/.test(call.sql));
    assert.ok(migrations.some((call) => /add column if not exists run_id text\s*$/.test(call.sql)));
    assert.ok(migrations.some((call) => /add column if not exists environment text\s*$/.test(call.sql)));
    assert.ok(capture.calls.some((call) => /\(sso_user_id, environment, run_id\)/.test(call.sql)));
    assert.ok(capture.calls.some((call) => /\(sso_user_id, environment, session_id, recorded_at desc, id desc\)/.test(call.sql)));
    assert.equal(capture.calls.some((call) => /^\s*update public.conversation_turns/i.test(call.sql)), false,
      'existing rows must not receive inferred Run or environment bindings');
    const insert = capture.calls.find((call) => /insert into public.conversation_turns/.test(call.sql));
    assert.ok(insert);
    const fields = insertFields(insert);
    assert.equal(fields.run_id, 'run-camera');
    assert.equal(fields.environment, 'staging', 'caller-provided production is not authoritative');
    assert.equal(fields.session_id, 'session-camera');
    assert.equal(fields.sso_user_id, 'account-camera');
  } finally {
    capture.restore();
    restoreEnvironment();
  }
});

test('archive retry identity distinguishes exact Run and environment while keeping legacy rows unbound', async () => {
  const restoreEnvironment = configureWriter();
  const capture = await queryCapture();
  try {
    for (const input of [row, row, { ...row, run_id: 'run-other' }, { ...row, run_id: undefined }]) {
      assert.equal(await insertConversationTurnCentral(input), true);
    }
    process.env.RDK_OBSERVABILITY_ENVIRONMENT = 'test';
    assert.equal(await insertConversationTurnCentral(row), true);
    const fields = capture.calls.filter((call) => /insert into public.conversation_turns/.test(call.sql)).map(insertFields);
    assert.equal(fields[0].source_id, fields[1].source_id, 'replaying the same bound turn stays idempotent');
    assert.notEqual(fields[0].source_id, fields[2].source_id, 'different Runs cannot deduplicate each other');
    assert.equal(fields[3].run_id, null, 'a legacy row remains explicitly unbound');
    assert.equal(fields[4].environment, 'test');
    assert.notEqual(fields[0].source_id, fields[4].source_id, 'different server environments cannot deduplicate each other');
  } finally {
    capture.restore();
    restoreEnvironment();
  }
});

test('archive scheduler forwards the authoritative Run without changing the Supabase payload shape', async () => {
  const restoreEnvironment = configureWriter();
  const capture = await queryCapture();
  const record: ConversationTurnRecord = {
    schema: CONVERSATION_SCHEMA,
    recordedAt: Date.parse(row.recorded_at),
    sessionId: 'session-scheduler',
    runId: 'run-scheduler',
    ssoUserId: 'account-scheduler',
    userId: 'workspace-other',
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    toolsUsed: ['camera_status', 'camera_status'],
    channel: 'studio',
    outcome: 'completed',
  };
  try {
    const supabase = buildSupabaseConversationRow(record);
    assert.deepEqual(Object.keys(supabase).sort(), [
      'recorded_at', 'sso_user_name', 'user_message', 'assistant_message',
      'tools_used', 'channel', 'outcome', 'error_detail',
    ].sort());
    assert.deepEqual(supabase.tools_used, ['camera_status']);
    scheduleCentralConversationInsert(record);
    // Scheduling is intentionally fire-and-forget; the mocked writer completes
    // after its cached pool/schema promises, without a database or HTTP call.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const insert = capture.calls.find((call) => /insert into public.conversation_turns/.test(call.sql));
    assert.ok(insert);
    const fields = insertFields(insert);
    assert.equal(fields.run_id, 'run-scheduler');
    assert.equal(fields.session_id, 'session-scheduler');
    assert.equal(fields.sso_user_id, 'account-scheduler', 'workspace user id cannot become the account owner');
    assert.equal(fields.environment, 'staging');
  } finally {
    capture.restore();
    restoreEnvironment();
  }
});
