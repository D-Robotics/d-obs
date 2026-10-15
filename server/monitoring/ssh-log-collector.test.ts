import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import {
  parseSshLogTargets, SshLogCollector, SshLogCollectorError,
  type SshLogCollectorOptions, type SshLogSpawnProcess,
} from './ssh-log-collector.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: (NodeJS.Signals | number | undefined)[] = [];
  closed = false;
  closeOnKill = true;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.close(null, 'SIGTERM'));
    return true;
  }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
  ready(id: string): void { this.stderr.write(`\x1ed-obs-ready:${id}\x1f\n`); }
}

function harness(t: TestContext, overrides: Partial<SshLogCollectorOptions> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'd-obs-ssh-'));
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const children: FakeChild[] = [];
  const spawnProcess: SshLogSpawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const targets = parseSshLogTargets(JSON.stringify([{ id: 'x5', label: '开发板 X5', host: 'x5', user: 'sunrise' }]));
  const collector = new SshLogCollector({ targets, stateDir, spawnProcess, ...overrides });
  t.after(async () => {
    await collector.dispose();
    for (const child of children) child.close(null, 'SIGTERM');
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { collector, children, calls, stateDir, targets, spawnProcess };
}

const input = { targetId: 'x5', sourceId: 'kernel' };
const errorCode = (code: string) => (error: unknown) => error instanceof SshLogCollectorError && error.code === code;

test('RDK probes use strict SSH and only report actual remote read capabilities', async (t) => {
  const { collector, calls, children } = harness(t);
  const pending = collector.probeTarget('x5');
  const command = calls[0]!.args.at(-1)!;
  assert.ok(calls[0]!.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(!calls[0]!.args.includes('-p'), 'SSH alias configured port is preserved');
  assert.match(command, /exec timeout --signal=TERM --kill-after=2s 20s sh -c/);
  assert.match(command, /\/proc\/device-tree\/model/);
  assert.match(command, /logcat -d -t 1 -v threadtime/);
  assert.doesNotMatch(command, /sudo|logcat -c/);
  children[0]!.stdout.write('model\tD-Robotics RDK X5\nos\t"Ubuntu 22.04"\nkernel\t6.1.83\ndeviceTime\t2026-10-10T01:00:00Z\nsource0\tunreadable\nsource1\treadable\nsource2\tmissing_command\nsource3\treadable\ncomplete\tyes\n');
  children[0]!.close();
  const result = await pending;
  assert.equal(result.status, 'ready');
  assert.equal(result.model, 'D-Robotics RDK X5');
  assert.equal(result.os, 'Ubuntu 22.04');
  assert.deepEqual(result.capabilities.map((entry) => entry.status), ['unreadable', 'readable', 'missing_command', 'readable']);
});

test('fixed probe script rejects missing units and journal permission hints with exit zero', async (t) => {
  const commandDir = mkdtempSync(join(tmpdir(), 'rdk-probe-commands-'));
  t.after(() => rmSync(commandDir, { recursive: true, force: true }));
  // Run the generated read-only script with controlled command implementations, never SSH a real device.
  writeFileSync(join(commandDir, 'timeout'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --*|[0-9]*s) shift ;; *) break ;; esac; done\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(join(commandDir, 'systemctl'), '#!/bin/sh\nfor unit; do :; done\ncase "$unit" in missing.service) printf "not-found\\n" ;; *) printf "loaded\\n" ;; esac\n', { mode: 0o700 });
  writeFileSync(join(commandDir, 'journalctl'), '#!/bin/sh\ncase "$*" in *readable.service*|*--dmesg*) printf \'{"MESSAGE":"readable record"}\\n\' ;; *empty.service*) exit 0 ;; *) printf "Hint: You are currently not seeing messages from other users. Insufficient permissions.\\n" >&2; exit 0 ;; esac\n', { mode: 0o700 });
  const targets = parseSshLogTargets(JSON.stringify([{ id: 'x5', host: 'x5', sources: [
    { id: 'journal', type: 'journal' }, { id: 'kernel', type: 'kernel' },
    { id: 'missing', type: 'unit', unit: 'missing.service' }, { id: 'empty', type: 'unit', unit: 'empty.service' },
    { id: 'readable', type: 'unit', unit: 'readable.service' },
  ] }]));
  const spawnProcess: SshLogSpawnProcess = (_command, args, options) => spawn('sh', ['-c', args.at(-1)!], { ...options,
    env: { ...process.env, PATH: `${commandDir}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  const { collector } = harness(t, { targets, spawnProcess });
  const result = await collector.probeTarget('x5');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.capabilities.slice(0, 5).map((entry) => entry.status), ['unavailable', 'readable', 'unavailable', 'unavailable', 'readable']);
});

test('fixed RDK logcat and dmesg commands cannot accept arbitrary commands or clear buffers', async (t) => {
  const { collector, calls } = harness(t);
  await collector.start({ targetId: 'x5', sourceId: 'rdk-logcat', lines: 20 }, 'alice');
  assert.match(calls[0]!.args.at(-1)!, /logcat -v threadtime '\*:V'$/);
  assert.doesNotMatch(calls[0]!.args.at(-1)!, /logcat.*-(?:c|t|d)\b/);
  await collector.start({ targetId: 'x5', sourceId: 'rdk-dmesg' }, 'alice');
  assert.match(calls[1]!.args.at(-1)!, /dmesg --follow$/);
  await assert.rejects(() => collector.start({ targetId: 'x5', sourceId: 'rdk-logcat;touch BAD' }, 'alice'), errorCode('unknown_source'));
});

test('probe errors expose safe codes and never replace missing remote model with the server model', async (t) => {
  const { collector, children } = harness(t);
  const pending = collector.probeTarget('x5');
  children[0]!.stderr.write('private host and credential path diagnostics');
  children[0]!.close(255);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'probe_failed');
  assert.equal(result.model, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private host|credential path/);
});

test('probe output is bounded and a transport without close retains its concurrency slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { collector, children } = harness(t, { maxConcurrent: 1 });
  const pending = collector.probeTarget('x5');
  const child = children[0]!;
  child.closeOnKill = false;
  child.stdout.write('x'.repeat(1024 * 1024));
  child.stdout.write('x'.repeat(1024 * 1024));
  t.mock.timers.tick(2000);
  t.mock.timers.tick(1000);
  assert.equal((await pending).error, 'probe_output_limit');
  await assert.rejects(() => collector.start(input, 'alice'), errorCode('concurrency_limit'));
  child.close(null, 'SIGKILL');
  await collector.start(input, 'alice');
  t.mock.timers.reset();
});

test('server allowlist rejects injected connection fields and invalid source options', () => {
  for (const patch of [
    { host: '-oProxyCommand=touch bad' }, { host: 'x5; touch bad' }, { host: 'x5\n' },
    { user: 'user;id' }, { port: '22' }, { port: 0 }, { identityFile: '~/.ssh/id_ed25519' },
    { sources: [{ id: 'unit', type: 'unit', unit: '--output=json' }] },
    { sources: [{ id: 'unit', type: 'unit', unit: 'camera.service;id' }] },
    { sources: [{ id: 'file', type: 'file', path: 'relative.log' }] },
    { sources: [{ id: 'file', type: 'file', path: '/tmp/log\nwhoami' }] },
  ]) {
    assert.throws(() => parseSshLogTargets(JSON.stringify([{ id: 'x5', host: 'x5', ...patch }])), errorCode('invalid_config'));
  }
  assert.throws(() => parseSshLogTargets('not JSON'), errorCode('invalid_config'));
  assert.throws(() => parseSshLogTargets('[{"id":"x5","host":"x5"},{"id":"x5","host":"another"}]'), errorCode('invalid_config'));
  assert.deepEqual(parseSshLogTargets(' '), []);
  assert.equal(parseSshLogTargets('[{"id":"x5","host":"2001:db8::5"}]')[0]?.sources.length, 2);
});

test('SSH is noninteractive, enforces host checks and safely quotes configured file paths', async (t) => {
  const targets = parseSshLogTargets(JSON.stringify([{
    id: 'x5', label: 'X5', host: 'x5-alias', user: 'sunrise', port: 2222,
    sources: [{ id: 'isp', label: 'ISP', type: 'file', path: "/var/log/isp 'quoted' $(touch NEVER).log" }],
  }]));
  const { collector, calls } = harness(t, { targets });
  const publicTargets = collector.listTargets();
  assert.deepEqual(Object.keys(publicTargets[0]!).sort(), ['id', 'label', 'sources']);
  publicTargets[0]!.sources[0]!.path = '/changed';
  await collector.start({ targetId: 'x5', sourceId: 'isp', lines: 25, follow: false }, 'alice');
  const call = calls[0]!;
  assert.equal(call.command, 'ssh');
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']) {
    assert.ok(call.args.includes(option), option);
  }
  assert.ok(call.args.includes('-T'));
  assert.ok(call.args.includes('-n'));
  assert.equal(call.args.includes('-F'), false, 'server-owned SSH aliases remain usable');
  assert.deepEqual(call.args.slice(-3, -1), ['--', 'x5-alias']);
  assert.match(call.args.at(-1)!, /exec timeout --signal=TERM --kill-after=2s 302s tail -n 25 -- '\/var\/log\/isp '\\''quoted'\\'' \$\(touch NEVER\)\.log'$/);
  assert.equal(call.args.at(-1)!.includes('/changed'), false);
});

test('capture preserves multiline, long output, UTF-8 split chunks and a final non-newline', async (t) => {
  const { collector, children, stateDir } = harness(t);
  assert.equal(parseSshLogTargets('[{"id":"x5","host":"x5"}]')[0]?.port, undefined);
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  child.ready(session.id);
  const text = '中文 ISP 第一行\n' + 'x'.repeat(12000) + '\n堆栈\n  at camera.ts:9\n没有换行';
  const bytes = Buffer.from(text);
  child.stdout.write(bytes.subarray(0, 1));
  child.stdout.write(bytes.subarray(1, 5));
  child.stdout.write(bytes.subarray(5));
  child.stderr.write('camera warning\n  detail without newline');
  child.close();
  const result = collector.read(session.id, 'alice', 0, 2);
  assert.equal(result.session.state, 'completed');
  assert.equal(result.records.length, 2);
  assert.equal(result.hasMore, true);
  const rest = collector.read(session.id, 'alice', result.cursor);
  const records = [...result.records, ...rest.records];
  assert.equal(records.map((record) => record.text).join(''), text + 'camera warning\n  detail without newline');
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
  assert.equal(records.at(-1)?.stream, 'stderr');
  assert.equal(rest.session.byteCount, Buffer.byteLength(text + 'camera warning\n  detail without newline'));
  assert.equal(await collector.exportText(session.id, 'alice'), text + 'camera warning\n  detail without newline');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(stateDir, `${session.id}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateDir, `${session.id}.meta.json`)).mode & 0o777, 0o600);
});

test('connecting only becomes running after remote readiness, stripping a marker split across chunks', async (t) => {
  const { collector, children } = harness(t);
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  child.emit('spawn');
  assert.equal(collector.read(session.id, 'alice').session.state, 'connecting');
  const marker = `\x1ed-obs-ready:${session.id}\x1f\n`;
  child.stderr.write('banner\n' + marker.slice(0, 12));
  assert.equal(collector.read(session.id, 'alice').session.state, 'connecting');
  child.stderr.write(marker.slice(12));
  const running = collector.read(session.id, 'alice');
  assert.equal(running.session.state, 'running');
  assert.equal(await collector.exportText(session.id, 'alice'), 'banner\n');
  await collector.stop(session.id, 'alice');
  assert.equal(collector.read(session.id, 'alice').session.stopReason, 'user');
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('another actor cannot list, stop, read or export a session; cursors and arbitrary requests are rejected', async (t) => {
  const { collector } = harness(t);
  const session = await collector.start(input, 'alice');
  assert.deepEqual(collector.list('bob'), []);
  assert.throws(() => collector.read(session.id, 'bob'), errorCode('unknown_session'));
  await assert.rejects(() => collector.stop(session.id, 'bob'), errorCode('unknown_session'));
  await assert.rejects(() => collector.exportText(session.id, 'bob'), errorCode('unknown_session'));
  assert.throws(() => collector.read(session.id, 'alice', -1), errorCode('invalid_cursor'));
  assert.throws(() => collector.read(session.id, 'alice', 1), errorCode('invalid_cursor'));
  await assert.rejects(() => collector.start({ ...input, host: 'evil' } as typeof input, 'alice'), errorCode('invalid_request'));
  await assert.rejects(() => collector.start({ ...input, lines: Number.NaN }, 'alice'), errorCode('invalid_request'));
  await assert.rejects(() => collector.start({ ...input, durationSeconds: 1801 }, 'alice'), errorCode('invalid_request'));
  await assert.rejects(() => collector.start({ ...input, targetId: 'another' }, 'alice'), errorCode('unknown_target'));
});

test('byte budget stops an unterminated long record on a valid UTF-8 boundary', async (t) => {
  const { collector, children } = harness(t, { maxSessionBytes: 7 });
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  child.stdout.write('你好世界'.repeat(1000));
  const result = collector.read(session.id, 'alice');
  assert.equal(result.session.stopReason, 'byte_limit');
  assert.equal(result.session.byteCount, 6);
  assert.equal(await collector.exportText(session.id, 'alice'), '你好');
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.stdout.write('ignored after limit');
  assert.equal(collector.read(session.id, 'alice').session.byteCount, 6);
});

test('duration stop escalates to SIGKILL, and stopped but live children still occupy concurrency slots', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { collector, children } = harness(t, { maxConcurrent: 1 });
  const session = await collector.start({ ...input, durationSeconds: 1 }, 'alice');
  const child = children[0]!;
  child.closeOnKill = false;
  t.mock.timers.tick(1000);
  assert.deepEqual(child.signals, ['SIGTERM']);
  await assert.rejects(() => collector.start(input, 'alice'), errorCode('concurrency_limit'));
  t.mock.timers.tick(2000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.close(null, 'SIGKILL');
  assert.equal(collector.read(session.id, 'alice').session.stopReason, 'duration_limit');
  await collector.start(input, 'alice');
  t.mock.timers.reset();
});

test('simultaneous start calls reserve slots synchronously', async (t) => {
  const { collector, children } = harness(t, { maxConcurrent: 1 });
  const results = await Promise.allSettled([collector.start(input, 'alice'), collector.start(input, 'bob')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(children.length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && errorCode('concurrency_limit')(rejected.reason));
});

test('SSH failure retains stderr and stream/spawn errors become failed sessions', async (t) => {
  const { collector, children } = harness(t);
  const failed = await collector.start(input, 'alice');
  children[0]!.stderr.write('Host key verification failed.\n');
  children[0]!.close(255);
  const result = collector.read(failed.id, 'alice');
  assert.equal(result.session.state, 'failed');
  assert.equal(result.session.stopReason, 'ssh_exit');
  assert.match(result.session.error!, /255/);
  assert.equal(await collector.exportText(failed.id, 'alice'), 'Host key verification failed.\n');
  const streamFailed = await collector.start(input, 'alice');
  children[1]!.stderr.emit('error', new Error('read failed'));
  assert.equal(collector.read(streamFailed.id, 'alice').session.stopReason, 'stream_error');
  const spawnFailed = await collector.start(input, 'alice');
  children[2]!.emit('error', new Error('spawn ssh ENOENT'));
  assert.equal(collector.read(spawnFailed.id, 'alice').session.stopReason, 'ssh_error');
});

test('explicit server identity is redacted even when SSH diagnostics split its path', async (t) => {
  const keyDir = mkdtempSync(join(tmpdir(), 'd-obs-key-'));
  const identityFile = join(keyDir, 'private-key');
  writeFileSync(identityFile, 'test key');
  t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const targets = parseSshLogTargets(JSON.stringify([{ id: 'x5', host: 'x5', identityFile }]));
  const { collector, children, calls } = harness(t, { targets });
  assert.equal(JSON.stringify(collector.listTargets()).includes(identityFile), false);
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  child.stderr.write('Load key "' + identityFile.slice(0, 7));
  child.stderr.write(identityFile.slice(7) + '": invalid format\n');
  child.close(255);
  assert.equal(await collector.exportText(session.id, 'alice'), 'Load key "[identity file]": invalid format\n');
  assert.ok(calls[0]!.args.includes('IdentitiesOnly=yes'));
});

test('completed captures replay after restart; persisted records repair stale metadata counts', async (t) => {
  const { collector, children, stateDir, targets } = harness(t);
  const session = await collector.start(input, 'alice');
  children[0]!.stdout.write('ISP output\nlast fragment');
  children[0]!.close();
  const metaPath = join(stateDir, `${session.id}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.session.recordCount = 0;
  meta.session.byteCount = 0;
  writeFileSync(metaPath, JSON.stringify(meta));
  const replay = new SshLogCollector({ targets, stateDir });
  t.after(() => replay.dispose());
  assert.equal(replay.list('alice')[0]?.recordCount, 1);
  assert.equal(replay.read(session.id, 'alice').session.state, 'completed');
  assert.equal(await replay.exportText(session.id, 'alice'), 'ISP output\nlast fragment');
  assert.throws(() => replay.read(session.id, 'bob'), errorCode('unknown_session'));
});

test('torn persisted records surface a recovery error while preserving preceding complete output', async (t) => {
  const { collector, children, stateDir, targets } = harness(t);
  const session = await collector.start(input, 'alice');
  children[0]!.stdout.write('good saved output\n');
  children[0]!.close();
  appendFileSync(join(stateDir, `${session.id}.jsonl`), '{"seq":2,"text":"partial');
  const replay = new SshLogCollector({ targets, stateDir });
  t.after(() => replay.dispose());
  assert.equal(replay.read(session.id, 'alice').session.stopReason, 'recovery_error');
  assert.equal(await replay.exportText(session.id, 'alice'), 'good saved output\n');
});

test('partial/orphan files count toward the disk limit after restart', async (t) => {
  const { stateDir, targets } = harness(t);
  writeFileSync(join(stateDir, '00000000-0000-4000-8000-000000000000.meta.json.tmp'), 'x'.repeat(2000));
  const replay = new SshLogCollector({ targets, stateDir, maxTotalBytes: 8400 });
  t.after(() => replay.dispose());
  await assert.rejects(() => replay.start(input, 'alice'), errorCode('disk_limit'));
});

test('restart marks interrupted captures failed, and retention removes only expired finished sessions', async (t) => {
  let time = 2_000_000;
  const { collector, children, stateDir, targets } = harness(t, { now: () => time });
  const session = await collector.start(input, 'alice');
  children[0]!.stdout.write('before restart');
  children[0]!.close();
  const metaPath = join(stateDir, `${session.id}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.session.state = 'running';
  delete meta.session.endedAt;
  writeFileSync(metaPath, JSON.stringify(meta));
  const replay = new SshLogCollector({ targets, stateDir, now: () => time, retentionMs: 1000 });
  t.after(() => replay.dispose());
  assert.equal(replay.read(session.id, 'alice').session.stopReason, 'server_restart');
  time += 999;
  assert.equal(replay.list('alice').length, 1);
  time += 1;
  assert.deepEqual(replay.list('alice'), []);
  assert.equal(readdirSync(stateDir).length, 0);
  assert.throws(() => replay.read(session.id, 'alice'), errorCode('unknown_session'));
});

test('global disk budget stops without evicting retained logs and bounds new sessions', async (t) => {
  const { collector, children } = harness(t, { maxTotalBytes: 8400 });
  const session = await collector.start(input, 'alice');
  children[0]!.stdout.write('keep\n');
  children[0]!.stdout.write('x'.repeat(1000));
  const result = collector.read(session.id, 'alice');
  assert.equal(result.session.stopReason, 'disk_limit');
  assert.equal(await collector.exportText(session.id, 'alice'), 'keep\n');
  await assert.rejects(() => collector.start(input, 'alice'), errorCode('disk_limit'));
});

test('session count cap and shutdown are explicit', async (t) => {
  const { collector, children } = harness(t, { maxSessions: 1 });
  const session = await collector.start(input, 'alice');
  children[0]!.close();
  await assert.rejects(() => collector.start(input, 'alice'), errorCode('session_limit'));
  await collector.dispose();
  assert.equal(collector.read(session.id, 'alice').session.state, 'completed');
  await assert.rejects(() => collector.start(input, 'alice'), errorCode('collector_closed'));
});

test('stop drains a real subprocess stdout/stderr tail written during SIGTERM before returning', async (t) => {
  const script = `
    process.on('SIGTERM', () => {
      process.stdout.write('末尾 stdout\\n');
      process.stderr.write('末尾 stderr without newline');
      setTimeout(() => process.exit(0), 30);
    });
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const { collector } = harness(t, {
    spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', script], options),
  });
  const session = await collector.start(input, 'alice');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (collector.read(session.id, 'alice').session.state === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(collector.read(session.id, 'alice').session.state, 'running');
  const stopped = await collector.stop(session.id, 'alice');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopReason, 'user');
  const text = await collector.exportText(session.id, 'alice');
  assert.match(text, /ready\n/);
  assert.match(text, /末尾 stdout\n/);
  assert.match(text, /末尾 stderr without newline/);
});

test('stop lets a split UTF-8 character finish during pipe drain', async (t) => {
  const { collector, children } = harness(t);
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  const character = Buffer.from('中');
  child.stdout.write(character.subarray(0, 1));
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => {
      child.stdout.write(character.subarray(1));
      child.close(null, 'SIGTERM');
    });
    return true;
  };
  await collector.stop(session.id, 'alice');
  assert.equal(await collector.exportText(session.id, 'alice'), '中');
  assert.equal(collector.read(session.id, 'alice').session.byteCount, 3);
});

test('async dispose waits for SIGKILL and child close before resolving', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { collector, children } = harness(t);
  const session = await collector.start(input, 'alice');
  const child = children[0]!;
  child.closeOnKill = false;
  let settled = false;
  const disposal = collector.dispose().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.stdout.write('final shutdown tail');
  child.close(null, 'SIGKILL');
  await disposal;
  assert.equal(settled, true);
  assert.equal(collector.read(session.id, 'alice').session.stopReason, 'collector_shutdown');
  assert.equal(await collector.exportText(session.id, 'alice'), 'final shutdown tail');
  t.mock.timers.reset();
});
