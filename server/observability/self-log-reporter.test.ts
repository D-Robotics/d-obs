/** 自观测日志回灌：severity/service 映射、有界队列、静默失败、进程守卫接线。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configureSelfLogStore,
  flushSelfLogs,
  installSelfProcessGuards,
  recordSelfLog,
} from './self-log-reporter.js';
import type { NormalizedLogRecord } from './ai-ecosystem-logs-store.js';

type CapturedCall = { owner: string; records: NormalizedLogRecord[] };

function captureStore(calls: CapturedCall[], fail = false) {
  configureSelfLogStore(async (owner, records) => {
    if (fail) throw new Error('db unavailable');
    calls.push({ owner, records });
    return records.length;
  });
}

test('recordSelfLog：error 映射 ERROR/17、service 按组件推断、结构化属性齐备', async () => {
  const calls: CapturedCall[] = [];
  captureStore(calls);
  recordSelfLog('web', { level: 'error', summary: '[ops-events] checkpoint: db write failed', errorName: 'Error', topFrame: 'at main.ts:1:1', tag: '[web]' });
  const inserted = await flushSelfLogs();
  assert.equal(inserted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.owner, 'service:d-obs');
  const record = calls[0]!.records[0]!;
  assert.equal(record.service, 'd-obs-web');
  assert.equal(record.severityText, 'ERROR');
  assert.equal(record.severityNumber, 17);
  assert.equal(record.environment, 'production');
  assert.equal(record.body, '[ops-events] checkpoint: db write failed');
  assert.equal(record.attributes['process.role'], 'web');
  assert.equal(record.attributes['error.name'], 'Error');
  assert.equal(record.attributes['error.top_frame'], 'at main.ts:1:1');
  assert.equal(record.attributes['log.tag'], '[web]');
  assert.equal(record.traceId, null);
  assert.ok(record.timestampMs > 0);
});

test('recordSelfLog：warn 映射 WARN/13，worker 组件落 d-obs-worker', async () => {
  const calls: CapturedCall[] = [];
  captureStore(calls);
  recordSelfLog('alert-worker', { level: 'warn', summary: 'delivery retry exceeded' });
  await flushSelfLogs();
  const record = calls[0]!.records[0]!;
  assert.equal(record.service, 'd-obs-worker');
  assert.equal(record.severityText, 'WARN');
  assert.equal(record.severityNumber, 13);
  assert.equal(record.attributes['process.role'], 'alert-worker');
});

test('recordSelfLog：空摘要不产生记录，超长摘要截断', async () => {
  const calls: CapturedCall[] = [];
  captureStore(calls);
  recordSelfLog('web', { level: 'error', summary: '   ' });
  recordSelfLog('web', { level: 'error', summary: 'x'.repeat(600) });
  await flushSelfLogs();
  assert.equal(calls[0]!.records.length, 1);
  assert.equal(calls[0]!.records[0]!.body.length, 500);
});

test('队列上限 128：溢出丢最旧', async () => {
  const calls: CapturedCall[] = [];
  captureStore(calls);
  for (let index = 0; index < 130; index += 1) {
    recordSelfLog('web', { level: 'error', summary: `event-${index}` });
  }
  await flushSelfLogs();
  const records = calls[0]!.records;
  assert.equal(records.length, 128);
  assert.equal(records[0]!.body, 'event-2');
  assert.equal(records[127]!.body, 'event-129');
});

test('落库失败静默：flush 返回 0 且队列清空，不向外抛错', async () => {
  const calls: CapturedCall[] = [];
  captureStore(calls, true);
  recordSelfLog('web', { level: 'error', summary: 'boom' });
  const inserted = await flushSelfLogs();
  assert.equal(inserted, 0);
  assert.equal(calls.length, 0);
  const again = await flushSelfLogs();
  assert.equal(again, 0);
});

test('installSelfProcessGuards：幂等，不重复挂监听', () => {
  installSelfProcessGuards();
  const listenerCount = process.listenerCount('unhandledRejection');
  const monitorCount = process.listenerCount('uncaughtExceptionMonitor');
  assert.ok(listenerCount >= 1);
  assert.ok(monitorCount >= 1);
  installSelfProcessGuards();
  assert.equal(process.listenerCount('unhandledRejection'), listenerCount);
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitorCount);
});
