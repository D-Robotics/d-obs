import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireWorkerLease } from './worker-lease.js';

test('worker lease degrades locally when no central database is configured', async () => {
  const originalUrl = process.env.RDK_CHAT_CREDITS_DB_URL;
  const originalRequired = process.env.RDK_ALERT_WORKER_LOCK_REQUIRED;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  process.env.RDK_ALERT_WORKER_LOCK_REQUIRED = '0';
  try {
    const lease = await acquireWorkerLease();
    assert.equal(lease.acquired, true);
    await lease.release();
  } finally {
    if (originalUrl === undefined) delete process.env.RDK_CHAT_CREDITS_DB_URL;
    else process.env.RDK_CHAT_CREDITS_DB_URL = originalUrl;
    if (originalRequired === undefined) delete process.env.RDK_ALERT_WORKER_LOCK_REQUIRED;
    else process.env.RDK_ALERT_WORKER_LOCK_REQUIRED = originalRequired;
  }
});

test('worker lease fails closed in required mode without a central database', async () => {
  const originalUrl = process.env.RDK_CHAT_CREDITS_DB_URL;
  const originalRequired = process.env.RDK_ALERT_WORKER_LOCK_REQUIRED;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  process.env.RDK_ALERT_WORKER_LOCK_REQUIRED = '1';
  try {
    await assert.rejects(acquireWorkerLease(), /alert_worker_lease_database_not_configured/);
  } finally {
    if (originalUrl === undefined) delete process.env.RDK_CHAT_CREDITS_DB_URL;
    else process.env.RDK_CHAT_CREDITS_DB_URL = originalUrl;
    if (originalRequired === undefined) delete process.env.RDK_ALERT_WORKER_LOCK_REQUIRED;
    else process.env.RDK_ALERT_WORKER_LOCK_REQUIRED = originalRequired;
  }
});
