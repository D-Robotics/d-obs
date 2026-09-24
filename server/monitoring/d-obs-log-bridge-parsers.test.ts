/** d-obs log bridge 解析器回归：docker 行、nginx 行、PG 行内级别。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDockerLogLine, parseNginxLine, pgLinePriority } from '../../tools/d-obs-log-bridge.mjs';

test('docker 日志行：时间戳与消息分离，非法行返回 null', () => {
  const parsed = parseDockerLogLine('2026-09-24T11:37:00.066390681Z 2026-09-24 11:37:00.066 UTC [2278309] ERROR: deadlock detected');
  assert.equal(parsed.timeMs, Date.parse('2026-09-24T11:37:00.066390681Z'));
  assert.match(parsed.message, /^2026-09-24 11:37:00\.066 UTC/);
  assert.equal(parseDockerLogLine('no-timestamp-line'), null);
  assert.equal(parseDockerLogLine('not-a-date message'), null);
});

test('PG 行内级别：ERROR/FATAL → 3，WARNING → 4，LOG/未知 → 6', () => {
  assert.equal(pgLinePriority('2026-09-24 11:37:00.066 UTC [2278309] ERROR:  deadlock detected'), '3');
  assert.equal(pgLinePriority('2026-09-24 11:37:00.066 UTC [1] FATAL:  the database system is shutting down'), '3');
  assert.equal(pgLinePriority('2026-09-24 11:37:00.066 UTC [1] WARNING:  could not write'), '4');
  assert.equal(pgLinePriority('2026-09-24 11:37:00.066 UTC [1] LOG:  checkpoint starting: time'), '6');
  assert.equal(pgLinePriority('plain message without level'), '6');
});

test('nginx error.log 行：时间（本地时区）、级别、消息三分', () => {
  const parsed = parseNginxLine('2026/09/24 19:34:06 [error] 3426828#3426828: *3663240 upstream timed out while reading response header');
  assert.ok(parsed);
  assert.equal(parsed.priority, '3');
  assert.match(parsed.message, /^3426828#3426828:/);
  const epoch = Date.parse('2026-09-24T19:34:06+08:00');
  // 断言按本地时区解释；若执行机不是 +08:00 则跳过精确断言
  if (new Date().getTimezoneOffset() === -480) {
    assert.equal(parsed.timeMs, epoch);
  }
  const warn = parseNginxLine('2026/09/24 19:34:06 [warn] 1#1: *2 upstream server temporarily disabled');
  assert.equal(warn.priority, '4');
  const crit = parseNginxLine('2026/09/24 19:34:06 [crit] 1#1: *2 open() failed');
  assert.equal(crit.priority, '3');
  const debug = parseNginxLine('2026/09/24 19:34:06 [debug] 1#1: *2 http wait request handler');
  assert.equal(debug.priority, '7');
  assert.equal(parseNginxLine('not an nginx line'), null);
});
