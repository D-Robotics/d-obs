import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RdkLogCaptureService, type RdkLogCaptureOptions } from './rdk-log-capture.js';
import { SshLogCollectorError, type SshLogDeviceProbe, type SshLogRecord, type SshLogSession, type SshLogSource, type SshLogStartInput } from './ssh-log-collector.js';

const sources: SshLogSource[] = [
  { id: 'kernel', label: 'Kernel', type: 'kernel' }, { id: 'journal', label: 'Journal', type: 'journal' },
  { id: 'rdk-logcat', label: 'Logcat', type: 'logcat' }, { id: 'rdk-dmesg', label: 'Dmesg', type: 'dmesg' },
];
const matches = (code: string) => (error: unknown) => error instanceof SshLogCollectorError && error.code === code;
class FakeCollector {
  probeCalls = 0;
  starts: SshLogStartInput[] = [];
  stopped: string[] = [];
  failAt?: number;
  probeResult: SshLogDeviceProbe = { targetId: 'x5', targetLabel: 'X5', probedAt: '2026-10-10T01:00:00.000Z', status: 'ready', model: 'D-Robotics RDK X5', os: 'Ubuntu 22.04', kernel: '6.1-rdk', capabilities: sources.map((source) => ({ source, status: 'readable' })) };
  stored = new Map<string, { actorId: string; session: SshLogSession; records: SshLogRecord[] }>();
  listTargets() { return [{ id: 'x5', label: 'X5', sources }]; }
  async probeTarget(targetId: string) { assert.equal(targetId, 'x5'); this.probeCalls++; return structuredClone(this.probeResult); }
  async start(input: SshLogStartInput, actorId: string) {
    this.starts.push(input);
    if (this.starts.length === this.failAt) throw new SshLogCollectorError(429, 'concurrency_limit', 'Slots are full');
    const session: SshLogSession = { id: `session-${this.starts.length}`, targetId: input.targetId, targetLabel: 'X5', sourceId: input.sourceId, sourceLabel: input.sourceId, state: 'running', startedAt: '2026-10-10T01:00:00.000Z', recordCount: 1, byteCount: 4 };
    this.stored.set(session.id, { actorId, session, records: [{ seq: 1, receivedAt: '2026-10-10T01:00:00.000Z', stream: 'stdout', text: 'raw\n' }] });
    return { ...session };
  }
  read(id: string, actorId: string, after = 0, limit = 500) {
    const entry = this.stored.get(id);
    if (!entry || entry.actorId !== actorId) throw new SshLogCollectorError(404, 'unknown_session', 'Missing');
    const records = entry.records.slice(after, after + limit);
    const cursor = records.at(-1)?.seq ?? after;
    return { session: { ...entry.session }, records: structuredClone(records), cursor, hasMore: cursor < entry.records.length };
  }
  async stop(id: string, actorId: string) { const result = this.read(id, actorId); this.stopped.push(id); this.stored.get(id)!.session = { ...result.session, state: 'stopped', stopReason: 'user' }; return this.read(id, actorId).session; }
}
function harness(t: TestContext, overrides: Partial<RdkLogCaptureOptions> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'rdk-capture-'));
  const collector = new FakeCollector();
  const options: RdkLogCaptureOptions = { collector, stateDir, now: () => Date.parse('2026-10-10T01:00:00.000Z'), ...overrides };
  const service = new RdkLogCaptureService(options);
  t.after(async () => { await service.dispose(); rmSync(stateDir, { recursive: true, force: true }); });
  return { service, collector, stateDir, options };
}
const input = { targetId: 'x5', profileId: 'x5-isp', question: '摄像头不出图，查看 ISP 链路' };

test('plans use only actually readable probe capabilities and versioned profiles', async (t) => {
  const { service, collector } = harness(t);
  collector.probeResult.capabilities[0]!.status = 'unreadable';
  collector.probeResult.capabilities[1]!.status = 'missing_command';
  const plan = await service.plan(input, 'alice');
  assert.equal(plan.ready, true);
  assert.equal(plan.profileVersion, '1.0.0');
  assert.deepEqual(plan.sources.map((source) => source.id), ['rdk-logcat', 'rdk-dmesg']);
  assert.equal(plan.deviceSnapshot.model, 'D-Robotics RDK X5');
  assert.deepEqual(plan.deviceSnapshot.readableSourceIds, ['rdk-logcat', 'rdk-dmesg']);
  assert.ok(plan.warnings.some((warning) => warning.includes('不保证跨源严格同步')));
  assert.ok(plan.warnings.some((warning) => warning.includes('历史行数参数不限制')));
  const profiles = service.listProfiles(); profiles[0]!.version = 'changed';
  assert.equal(service.listProfiles()[0]!.version, '1.0.0');
  await service.plan(input, 'alice');
  assert.equal(collector.probeCalls, 1, 'recent owner probe is reused');
  await service.plan(input, 'bob');
  assert.equal(collector.probeCalls, 2, 'another actor cannot reuse the owner probe');
});

test('probe failures are visible and prevent starting unavailable or arbitrary sources', async (t) => {
  const { service, collector } = harness(t);
  collector.probeResult = { ...collector.probeResult, status: 'failed', error: 'probe_timeout' };
  const plan = await service.plan(input, 'alice');
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.sources, []);
  assert.ok(plan.warnings.some((warning) => warning.includes('probe_timeout')));
  await assert.rejects(() => service.start(input, 'alice'), matches('no_readable_sources'));
  assert.equal(collector.starts.length, 0);
  await assert.rejects(() => service.probe('x5; touch /tmp/bad', 'alice'), matches('unknown_target'));
  await assert.rejects(() => service.plan({ ...input, sourceIds: ['rdk-logcat;id'] }, 'alice'), matches('source_unreadable'));
  await assert.rejects(() => service.start({ ...input, remoteCommand: 'id' } as typeof input, 'alice'), matches('invalid_request'));
  await assert.rejects(() => service.plan({ ...input, sourceIds: ['kernel', 'journal', 'rdk-logcat', 'rdk-dmesg'] }, 'alice'), matches('invalid_sources'));
  await assert.rejects(() => service.start({ ...input, durationSeconds: 99999 }, 'alice'), matches('invalid_request'));
});

test('partial group start failure stops already started sources and persists the failed group', async (t) => {
  const { service, collector } = harness(t);
  collector.failAt = 2;
  const group = await service.start(input, 'alice');
  assert.equal(group.state, 'failed');
  assert.equal(group.error, 'concurrency_limit');
  assert.deepEqual(collector.stopped, ['session-1']);
  assert.equal(service.list('alice')[0]!.sessions[0]!.state, 'stopped');
  assert.equal(service.read(group.id, 'alice').state, 'failed');
});

test('bundle preserves complete raw multiline records and marker stream positions', async (t) => {
  const { service, collector } = harness(t);
  const group = await service.start({ ...input, sourceIds: ['rdk-logcat', 'kernel'] }, 'alice');
  const entry = collector.stored.get(group.sessions[0]!.id)!;
  const text = '中文第一行\n' + 'x'.repeat(24000) + '\n  multiline trace\nno final newline';
  entry.records = [{ seq: 1, receivedAt: group.startedAt, stream: 'stdout', text }, { seq: 2, receivedAt: group.startedAt, stream: 'stderr', text: '\npermission warning\n' }];
  entry.session.recordCount = 2;
  const marked = service.mark(group.id, { label: '复现掉帧' }, 'alice');
  assert.deepEqual(marked.markers[0]!.positions[0], { sessionId: entry.session.id, seq: 2 });
  await service.stop(group.id, 'alice');
  const bundle = service.bundle(group.id, 'alice');
  assert.equal(bundle.contract, 'rdk.log-capture-bundle.v1');
  assert.equal(bundle.manifest.state, 'stopped');
  assert.equal(bundle.streams[0]!.records.map((record) => record.text).join(''), text + '\npermission warning\n');
  assert.equal(bundle.manifest.markers[0]!.label, '复现掉帧');
  assert.match(bundle.clockNote, /不保证跨源严格同步/);
});

test('capture read, list, stop, mark and bundle enforce actor ownership', async (t) => {
  const { service } = harness(t);
  const group = await service.start(input, 'alice');
  assert.deepEqual(service.list('bob'), []);
  assert.throws(() => service.read(group.id, 'bob'), matches('unknown_capture'));
  await assert.rejects(() => service.stop(group.id, 'bob'), matches('unknown_capture'));
  assert.throws(() => service.mark(group.id, { label: 'wrong' }, 'bob'), matches('unknown_capture'));
  assert.throws(() => service.bundle(group.id, 'bob'), matches('unknown_capture'));
  assert.throws(() => service.read(group.id, ''), matches('invalid_actor'));
});

test('restart restores captures and markers privately, retention prunes expired records', async (t) => {
  let now = Date.parse('2026-10-10T01:00:00.000Z');
  const { service, stateDir, options } = harness(t, { now: () => now, retentionMs: 1000 });
  const group = await service.start(input, 'alice');
  service.mark(group.id, { label: '复现' }, 'alice');
  await service.stop(group.id, 'alice');
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  for (const file of readdirSync(stateDir)) assert.equal(statSync(join(stateDir, file)).mode & 0o777, 0o600);
  const restored = new RdkLogCaptureService(options);
  assert.equal(restored.read(group.id, 'alice').markers[0]!.label, '复现');
  assert.equal(restored.bundle(group.id, 'alice').streams.length, 3);
  assert.deepEqual(restored.list('bob'), []);
  now += 2000;
  assert.deepEqual(restored.list('alice'), []);
  assert.throws(() => restored.bundle(group.id, 'alice'), matches('unknown_capture'));
  assert.deepEqual(readdirSync(stateDir), []);
});

test('capture and probe quotas reject without spawning additional SSH sessions', async (t) => {
  const { service, collector } = harness(t, { maxGroups: 1, maxProbes: 1 });
  await service.start(input, 'alice');
  const started = collector.starts.length;
  await assert.rejects(() => service.start(input, 'alice'), matches('capture_limit'));
  assert.equal(collector.starts.length, started);
  await assert.rejects(() => service.probe('x5', 'bob'), matches('probe_limit'));
  const tiny = harness(t, { maxStateBytes: 1024 });
  await assert.rejects(() => tiny.service.probe('x5', 'alice'), matches('capture_storage_limit'));
  assert.equal(tiny.collector.probeCalls, 0);
});

test('later failed source stops sibling streams and marks capture failed', async (t) => {
  const { service, collector } = harness(t);
  const group = await service.start(input, 'alice');
  collector.stored.get(group.sessions[0]!.id)!.session.state = 'failed';
  service.read(group.id, 'alice');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collector.stopped.length, 2);
  assert.equal(service.read(group.id, 'alice').state, 'failed');
});

test('background monitor stops siblings after a source failure without browser polling', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { service, collector } = harness(t);
  const group = await service.start(input, 'alice');
  collector.stored.get(group.sessions[0]!.id)!.session.state = 'failed';
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collector.stopped.length, 2);
  assert.equal(service.read(group.id, 'alice').state, 'failed');
  t.mock.timers.reset();
});

test('questions redact credential assignments and markers are bounded', async (t) => {
  const { service, stateDir } = harness(t);
  const group = await service.start({ ...input, question: 'ISP token=PRIVATE_TOKEN Bearer SECRET_VALUE' }, 'alice');
  assert.doesNotMatch(group.question, /PRIVATE_TOKEN|SECRET_VALUE/);
  for (let index = 0; index < 64; index++) service.mark(group.id, { label: `复现 ${index}` }, 'alice');
  assert.throws(() => service.mark(group.id, { label: 'overflow' }, 'alice'), matches('marker_limit'));
  assert.throws(() => service.mark(group.id, { label: 'bad\nlabel' }, 'alice'), matches('invalid_marker'));
  assert.doesNotMatch(readFileSync(join(stateDir, `group-${group.id}.json`), 'utf8'), /PRIVATE_TOKEN|SECRET_VALUE/);
});
