/** console 桥接的日志域接线：'[process]' 信号要进、事件库自报告前缀不进、warn 降噪一致。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNodeConsoleErrorOpsEvent,
  installNodeConsoleErrorTelemetry,
} from './node-console-error-telemetry.js';
import type { SelfLogEntry } from '../observability/self-log-reporter.js';

function withTelemetry(
  component: string,
  sink: (entry: SelfLogEntry) => void,
  run: () => void,
): void {
  const restore = installNodeConsoleErrorTelemetry({ component, force: true, selfLogSink: sink });
  try {
    run();
  } finally {
    restore();
  }
}

test('console.error 喂日志域：摘要、错误名、首帧、tag 齐备，ops 事件通路并存', () => {
  const entries: SelfLogEntry[] = [];
  const opsEvents: unknown[] = [];
  withTelemetry(
    'web',
    (entry) => entries.push(entry),
    () => {
      // recorder 默认走 recordOpsEvent（需要 DB），测试里 console 打印在安装后
      // 走 patched 通路——ops 事件失败静默，不影响断言日志域条目。
      console.error('[web] load failed:', new Error('db unavailable'));
    },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.level, 'error');
  assert.equal(entries[0]!.summary, '[web] load failed: Error: db unavailable');
  assert.equal(entries[0]!.errorName, 'Error');
  assert.equal(entries[0]!.tag, '[web]');
  assert.ok(entries[0]!.topFrame);
  assert.ok(buildNodeConsoleErrorOpsEvent('web', ['x', new Error('y')]));
  void opsEvents;
});

test("'[process]' 前缀进日志域（ops 事件通路跳过它们）", () => {
  const entries: SelfLogEntry[] = [];
  withTelemetry(
    'web',
    (entry) => entries.push(entry),
    () => {
      console.error('[process] unhandledRejection:', new Error('late cleanup failure'));
    },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.level, 'error');
  assert.match(entries[0]!.summary, /^\[process\] unhandledRejection:/);
});

test("'[ops-events] insert failed' 前缀不进日志域，防回灌自我循环", () => {
  const entries: SelfLogEntry[] = [];
  withTelemetry(
    'web',
    (entry) => entries.push(entry),
    () => {
      console.error('[ops-events] insert failed: connection refused');
    },
  );
  assert.equal(entries.length, 0);
});

test('console.warn 降噪：无错误语义的普通告警不进日志域，命中关键词的进', () => {
  const entries: SelfLogEntry[] = [];
  withTelemetry(
    'alert-worker',
    (entry) => entries.push(entry),
    () => {
      console.warn('[alert-worker] status snapshot skipped');
      console.warn('[alert-worker] status snapshot failed: timeout after 8000ms');
    },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.level, 'warn');
  assert.match(entries[0]!.summary, /timeout/);
});
