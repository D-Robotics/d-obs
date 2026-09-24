/**
 * 通知预算优先级排序回归测试：critical 新开/升级必须排在 warning 提醒与
 * 恢复之前，同级内保持 reconcile 的稳定产出顺序。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertStatePathWritable, prioritizeAlertTransitions } from './studio-alert-worker.js';
import type { AlertTransition } from './studio-alert-state.js';

function transition(
  kind: AlertTransition['kind'],
  severity: AlertTransition['severity'],
  key: string,
): AlertTransition {
  return {
    kind,
    key,
    title: key,
    severity,
    summary: '',
    at: '2026-09-15T00:00:00Z',
  } as AlertTransition;
}

test('critical opened/escalated 排在 warning 之前，resolved 最后', () => {
  const input = [
    transition('resolved', 'critical', 'r'),
    transition('reminder', 'warning', 'm'),
    transition('opened', 'warning', 'w-open'),
    transition('opened', 'critical', 'c-open'),
    transition('escalated', 'critical', 'c-esc'),
  ];
  const output = prioritizeAlertTransitions(input);
  assert.deepEqual(
    output.map((t) => `${t.kind}:${t.key}`),
    ['escalated:c-esc', 'opened:c-open', 'opened:w-open', 'reminder:m', 'resolved:r'],
  );
});

test('同级内保持输入顺序（稳定排序）', () => {
  const input = [
    transition('opened', 'warning', 'a'),
    transition('opened', 'warning', 'b'),
    transition('opened', 'warning', 'c'),
  ];
  const output = prioritizeAlertTransitions(input);
  assert.deepEqual(
    output.map((t) => t.key),
    ['a', 'b', 'c'],
  );
});

test('空列表与单元素列表', () => {
  assert.deepEqual(prioritizeAlertTransitions([]), []);
  const single = [transition('reminder', 'warning', 'x')];
  assert.deepEqual(prioritizeAlertTransitions(single), single);
});

test('不修改输入数组（返回新数组）', () => {
  const input = [transition('resolved', 'warning', 'a'), transition('opened', 'critical', 'b')];
  const copy = [...input];
  prioritizeAlertTransitions(input);
  assert.deepEqual(
    input.map((t) => t.key),
    copy.map((t) => t.key),
  );
});

test('状态路径可写探测：可写目录通过且不留残留文件', async () => {
  const previous = process.env.RDK_ALERT_STATE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'alert-state-probe-'));
  try {
    process.env.RDK_ALERT_STATE_PATH = path.join(dir, 'nested', 'state.json');
    await assertStatePathWritable();
    const entries = await readdir(path.join(dir, 'nested'));
    assert.deepEqual(entries, []);
  } finally {
    process.env.RDK_ALERT_STATE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('状态路径可写探测：目录被文件占据时拒绝（阻止评估与投递）', async () => {
  const previous = process.env.RDK_ALERT_STATE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'alert-state-blocked-'));
  try {
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, '', { encoding: 'utf8' });
    process.env.RDK_ALERT_STATE_PATH = path.join(blocker, 'state.json');
    await assert.rejects(() => assertStatePathWritable());
  } finally {
    process.env.RDK_ALERT_STATE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
