import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { acquireWorkerLease } from './worker-lease.js';

const connectionString = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();

type ControlClient = {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('lease loss was not reported');
    await delay(25);
  }
}

test('PostgreSQL worker lease retains its session and reports connection loss', {
  skip: !connectionString,
  timeout: 30_000,
}, async (t) => {
  const pg = await import('pg' as string);
  const Client = (pg as unknown as { default: { Client: new (config: Record<string, unknown>) => ControlClient } }).default.Client;
  const control = new Client({ connectionString, application_name: 'd-obs-lease-integration-control' });
  await control.connect();
  try {
    await t.test('a second evaluator stays excluded beyond the pool idle timeout', async () => {
      const key = `lease-integration:${randomUUID()}`;
      let losses = 0;
      const first = await acquireWorkerLease({ connectionString, key, required: true, onLost: () => { losses += 1; } });
      assert.equal(first.acquired, true);
      try {
        await delay(11_000);
        const contender = await acquireWorkerLease({ connectionString, key, required: true });
        try {
          assert.equal(contender.acquired, false, 'the first session must remain locked after 10 seconds');
        } finally {
          await contender.release();
        }
        assert.equal(first.acquired, true);
        assert.equal(losses, 0);
      } finally {
        await Promise.all([first.release(), first.release()]);
      }
      assert.equal(losses, 0, 'normal release must not be treated as a lost connection');
      const next = await acquireWorkerLease({ connectionString, key, required: true });
      try {
        assert.equal(next.acquired, true, 'release must make the key available to the next cycle');
      } finally {
        await next.release();
      }
    });

    await t.test('terminating the held PostgreSQL session reports loss exactly once', async () => {
      const key = `lease-integration:${randomUUID()}`;
      const before = await control.query("select pid from pg_stat_activity where application_name = 'd-obs-alert-worker-lease'");
      const existingPids = new Set(before.rows.map((row) => Number(row.pid)));
      const errors: Error[] = [];
      const first = await acquireWorkerLease({ connectionString, key, required: true, onLost: (error) => errors.push(error) });
      try {
        assert.equal(first.acquired, true);
        const sessions = await control.query("select pid from pg_stat_activity where application_name = 'd-obs-alert-worker-lease'");
        const heldPid = sessions.rows.map((row) => Number(row.pid)).find((pid) => !existingPids.has(pid));
        assert.ok(heldPid, 'dedicated lock session must be present');
        await control.query('select pg_terminate_backend($1)', [heldPid]);
        await waitFor(() => errors.length > 0);
        await delay(100);
        assert.equal(first.acquired, false);
        assert.equal(errors.length, 1, 'error and end events must not report loss twice');
        assert.equal(errors[0].message, 'alert_worker_lease_connection_lost');
        const next = await acquireWorkerLease({ connectionString, key, required: true });
        try {
          assert.equal(next.acquired, true, 'PostgreSQL must release a terminated session lock');
        } finally {
          await next.release();
        }
      } finally {
        await first.release();
      }
    });
  } finally {
    await control.end();
  }
});
