import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSuccessOutcome, mapIterationRow } from './run-iteration-cycle.js';

test('成功词表判定：大小写与空白不敏感，未知取值按失败计', () => {
  assert.equal(isSuccessOutcome('success'), true);
  assert.equal(isSuccessOutcome(' OK '), true);
  assert.equal(isSuccessOutcome('Succeeded'), true);
  assert.equal(isSuccessOutcome('error'), false);
  assert.equal(isSuccessOutcome('timeout'), false);
  assert.equal(isSuccessOutcome(''), false);
  assert.equal(isSuccessOutcome(null), false);
});

test('聚合行映射：字符串数值安全转数字并按口径取整', () => {
  const summary = mapIterationRow(
    {
      runs_total: '100',
      failed_total: 20,
      retry_paired: 12,
      retry_p50: '3.42',
      retry_p80: '40',
      retry_within_1h: '0.5',
      retry_within_24h: 0.9,
      recovery_paired: 9,
      recovery_p50: null,
      recovery_p80: 120,
    },
    [
      { outcome: 'success', count: 80 },
      { outcome: 'error', count: 20 },
    ],
    30,
  );
  assert.equal(summary.runsTotal, 100);
  assert.equal(summary.failedRuns, 20);
  assert.equal(summary.successRate, 0.8);
  assert.equal(summary.retry.paired, 12);
  assert.equal(summary.retry.medianMinutes, 3.4);
  assert.equal(summary.retry.p80Minutes, 40);
  assert.equal(summary.retry.within1hRate, 0.5);
  assert.equal(summary.retry.within24hRate, 0.9);
  assert.equal(summary.recovery.paired, 9);
  assert.equal(summary.recovery.medianMinutes, null);
  assert.equal(summary.recovery.p80Minutes, 120);
  assert.equal(summary.pairingWindowHours, 72);
  assert.ok(summary.caveat.includes('任务级键'));
});

test('聚合行映射：空行全缺口不抛错', () => {
  const summary = mapIterationRow({}, [], 7);
  assert.equal(summary.runsTotal, 0);
  assert.equal(summary.failedRuns, 0);
  assert.equal(summary.successRate, null);
  assert.equal(summary.retry.paired, 0);
  assert.equal(summary.retry.medianMinutes, null);
  assert.equal(summary.outcomeBreakdown.length, 0);
});
