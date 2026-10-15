import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { PlatformAssistantTaskError, PlatformAssistantTaskService } from './platform-assistant-tasks.js';
import type { PlatformAssistantResult } from '../observability/platform-assistant.js';

const owner = 'sso:alice|tenant:team-a|view:platform';
const otherOwner = 'sso:bob|tenant:team-a|view:platform';
const otherTenant = 'sso:alice|tenant:team-b|view:platform';
const moduleUrl = new URL('./platform-assistant-tasks.ts', import.meta.url).href;
const scopeDigest = (scope: string) => createHash('sha256').update(scope).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const error = (code: string, status?: number) => (cause: unknown) => cause instanceof PlatformAssistantTaskError
  && cause.code === 'platform_assistant_task_' + code && (status === undefined || cause.status === status);
let directory: string;
let service: PlatformAssistantTaskService;
const response: PlatformAssistantResult = { reply: '已查询当前状态。', operations: [{
  id: 'GET /api/ops/observability/overview', description: '读取总览', status: 200, ok: true, data: { total: 2 },
}] };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'd-obs-assistant-tasks-')); service = new PlatformAssistantTaskService({ stateDir: directory }); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const stateFile = () => join(directory, scopeDigest(owner) + '.json');
async function stateFixture(update: (payload: { tasks: Array<{ id: string; mutationDigests?: string[]; lease: { pid: number; processBirth: string; instance: string; expiresAt: number } | null }> }) => void) {
  const envelope = JSON.parse(await readFile(stateFile(), 'utf8')); update(envelope.payload);
  envelope.sha256 = createHash('sha256').update(canonical(envelope.payload)).digest('hex'); await writeFile(stateFile(), JSON.stringify(envelope));
}
async function completed() {
  const task = await service.create(owner, { goal: '查询当前平台状态', context: { view: 'overview', tenant: 'team-a' } });
  return service.finish(owner, task.id, task.revision, { response });
}
function child(code: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: globalThis.process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    process.stdout.on('data', (data: Buffer) => { stdout += data.toString(); }); process.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    process.on('error', reject); process.on('close', (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}
function fixturePrefix() {
  return `import { PlatformAssistantTaskService } from ${JSON.stringify(moduleUrl)}; const service = new PlatformAssistantTaskService({stateDir:${JSON.stringify(directory)}}); const scope=${JSON.stringify(owner)};`;
}

test('owner and tenant scopes isolate details, claims, confirmations, feedback and exports', async () => {
  const task = await completed();
  for (const scope of [otherOwner, otherTenant]) {
    assert.deepEqual((await service.list(scope)).tasks, []);
    await assert.rejects(service.get(scope, task.id), error('not_found', 404));
    await assert.rejects(service.claim(scope, task.id, task.revision), error('not_found', 404));
    await assert.rejects(service.getPending(scope, task.id), error('not_found', 404));
    await assert.rejects(service.claimConfirmation(scope, task.id, task.revision, 'private-token'), error('not_found', 404));
    await assert.rejects(service.feedback(scope, task.id, task.revision, 'helpful'), error('not_found', 404));
    assert.deepEqual((await service.exportCases(scope)).cases, []);
  }
  for (const scope of ['', ' ' + owner, owner + '\0']) await assert.rejects(service.list(scope), error('identity_required', 401));
  await assert.rejects(service.get(owner, '../outside'), error('not_found', 404));
  const disk = await readFile(stateFile(), 'utf8'); assert.ok(!disk.includes(owner)); assert.ok(!disk.includes(otherOwner));
});

test('tasks and safe history survive service recreation with private file permissions and distinct summary views', async () => {
  const task = await completed(); const restarted = new PlatformAssistantTaskService({ stateDir: directory });
  assert.deepEqual(await restarted.get(owner, task.id), task);
  const overview = await restarted.list(owner); assert.equal(overview.tasks.length, 1);
  assert.equal(overview.tasks[0].operationCount, 1); assert.equal('history' in overview.tasks[0], false);
  assert.equal('response' in overview.tasks[0], false); assert.equal('pending' in task, false); assert.equal('lease' in task, false);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(stateFile())).mode & 0o777, 0o600);
  assert.equal((await lstat(join(directory, scopeDigest(owner) + '.initialized'))).mode & 0o777, 0o600);
  assert.ok(task.history[0].content.includes('安全操作回执：')); assert.equal(task.response!.operations[0].id, response.operations[0].id);
});

test('running claims reject concurrent work and stale CAS revisions cannot finish, resume or relabel', async () => {
  const running = await service.create(owner, { goal: '查询总览' });
  await assert.rejects(service.claim(owner, running.id, running.revision), error('busy', 409));
  await assert.rejects(service.feedback(owner, running.id, running.revision, 'helpful'), error('feedback_unavailable', 409));
  await assert.rejects(service.finish(owner, running.id, running.revision + 1, { response }), error('stale_revision', 409));
  const done = await service.finish(owner, running.id, running.revision, { response });
  await assert.rejects(service.finish(owner, done.id, done.revision, { response }), error('not_claimed', 409));
  await assert.rejects(service.claim(owner, done.id, running.revision), error('stale_revision', 409));
  const attempts = await Promise.allSettled([service.claim(owner, done.id, done.revision), new PlatformAssistantTaskService({ stateDir: directory }).claim(owner, done.id, done.revision)]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  const next = attempts.find((item) => item.status === 'fulfilled'); assert.equal(next?.status, 'fulfilled');
  if (next?.status !== 'fulfilled') throw new Error('missing successful claim');
  assert.equal(next.value.status, 'running'); assert.equal(next.value.revision, done.revision + 1);
  await assert.rejects(service.feedback(owner, done.id, done.revision, 'not_helpful'), error('stale_revision', 409));
});

test('follow-up claims atomically store current selections while keeping the original goal and history', async () => {
  const done = await completed();
  const context = { view: 'devices', tenant: 'team-a', selection: { deviceId: 'current-x5' }, filters: { query: 'errors' } };
  await assert.rejects(service.claim(owner, done.id, done.revision - 1, context), error('stale_revision', 409));
  assert.deepEqual((await service.get(owner, done.id)).context, done.context);
  await assert.rejects(service.claim(owner, done.id, done.revision, { ...context, authority: 'admin' } as typeof context), error('invalid_context'));
  const current = await service.claim(owner, done.id, done.revision, context);
  assert.deepEqual(current.context, context); assert.equal(current.goal, done.goal); assert.deepEqual(current.history, done.history);
  assert.deepEqual((await new PlatformAssistantTaskService({ stateDir: directory }).get(owner, done.id)).context, context);
});

test('unknown side-effect outcomes can never be recorded as completed even with a successful HTTP receipt', async () => {
  const task = await service.create(owner, { goal: '确认实际执行结果' });
  const unknown: PlatformAssistantResult = { reply: '结果尚未确认。', operations: [{ ...response.operations[0],
    id: 'POST /api/ops/observability/actions/:id/execute', ok: true, status: 200, data: { outcome: 'unknown' },
  }] };
  await assert.rejects(service.finish(owner, task.id, task.revision, { response: unknown, status: 'completed' }), error('invalid_status'));
  const done = await service.finish(owner, task.id, task.revision, { response: unknown });
  assert.equal(done.status, 'interrupted'); assert.equal(done.error, 'platform_assistant_task_outcome_unknown');
  assert.equal((await service.list(owner)).stats.reportedCompleted, 0);
});

test('private pending authorization is recoverable but public details and cases never expose it; consumption is exact and single use', async () => {
  const running = await service.create(owner, { goal: '准备创建看板' });
  const proposal = { token: 'encrypted.private.confirmation.token', operationId: 'POST /api/ops/observability/boards',
    description: '创建看板', preview: '{"body":{"name":"错误分析"}}', expiresAt: Date.now() + 60_000 };
  const waiting = await service.finish(owner, running.id, running.revision, { response: { reply: '请确认创建看板。', operations: [], proposal } });
  assert.equal(waiting.status, 'awaiting_confirmation'); assert.equal('token' in waiting.response!.proposal!, false);
  const restarted = new PlatformAssistantTaskService({ stateDir: directory });
  assert.deepEqual(await restarted.getPending(owner, waiting.id), proposal);
  assert.ok(!JSON.stringify(await restarted.get(owner, waiting.id)).includes(proposal.token));
  assert.ok(!JSON.stringify(await restarted.exportCases(owner)).includes(proposal.token));
  await assert.rejects(restarted.claim(owner, waiting.id, waiting.revision), error('confirmation_required', 409));
  await assert.rejects(restarted.claimConfirmation(owner, waiting.id, waiting.revision, 'another.token'), error('invalid_confirmation', 403));
  assert.deepEqual(await restarted.getPending(owner, waiting.id), proposal);
  const claims = await Promise.allSettled([service.claimConfirmation(owner, waiting.id, waiting.revision, proposal.token), restarted.claimConfirmation(owner, waiting.id, waiting.revision, proposal.token)]);
  assert.equal(claims.filter((item) => item.status === 'fulfilled').length, 1);
  const claimed = claims.find((item) => item.status === 'fulfilled'); if (claimed?.status !== 'fulfilled') throw new Error('missing confirmation');
  assert.equal(claimed.value.proposal.token, proposal.token); assert.equal(claimed.value.task.status, 'running');
  assert.equal(await restarted.getPending(owner, waiting.id), null);
  assert.ok(!JSON.stringify(claimed.value.task).includes(proposal.token)); assert.ok(!JSON.stringify(claimed.value.task.response).includes('proposal'));
  const finished = await service.finish(owner, waiting.id, claimed.value.task.revision, { response });
  await assert.rejects(service.claimConfirmation(owner, finished.id, finished.revision, proposal.token), error('confirmation_unavailable', 409));
  assert.ok(!(await readFile(stateFile(), 'utf8')).includes(proposal.token));
});

test('one user turn remembers A then B confirmations and blocks another A across service recreation without exposing private digests', async () => {
  const a = scopeDigest('mutation-A'); const b = scopeDigest('mutation-B');
  const proposal = (token: string) => ({ token, operationId: 'POST /api/ops/observability/boards', description: '创建看板', preview: '{}', expiresAt: Date.now() + 60_000 });
  let task = await service.create(owner, { goal: '创建 A 和 B 两个看板' }); assert.deepEqual(await service.getMutationDigests(owner, task.id), []);
  task = await service.finish(owner, task.id, task.revision, { response: { reply: '请确认 A', operations: [], proposal: proposal('confirm-A') } });
  const first = await service.claimConfirmation(owner, task.id, task.revision, 'confirm-A', a);
  assert.deepEqual(await service.getMutationDigests(owner, task.id), [a]);
  task = await service.finish(owner, task.id, first.task.revision, { response: { reply: '请确认 B', operations: [], proposal: proposal('confirm-B') } });
  const second = await service.claimConfirmation(owner, task.id, task.revision, 'confirm-B', b);
  task = await service.finish(owner, task.id, second.task.revision, { response: { reply: '错误重复提案 A', operations: [], proposal: proposal('repeat-A') } });
  const restarted = new PlatformAssistantTaskService({ stateDir: directory });
  assert.deepEqual(await restarted.getMutationDigests(owner, task.id), [a, b]);
  await assert.rejects(restarted.claimConfirmation(owner, task.id, task.revision, 'repeat-A', a), error('duplicate_mutation', 409));
  assert.equal((await restarted.getPending(owner, task.id))!.token, 'repeat-A');
  assert.equal((await restarted.get(owner, task.id)).revision, task.revision);
  for (const output of [await restarted.get(owner, task.id), await restarted.list(owner), await restarted.exportCases(owner)]) {
    const text = JSON.stringify(output); assert.ok(!text.includes('mutationDigests')); assert.ok(!text.includes(a)); assert.ok(!text.includes(b));
  }
  await assert.rejects(restarted.getMutationDigests(otherOwner, task.id), error('not_found', 404));
});

test('confirmation reservation survives downstream authorization failure, while a new explicit user turn resets its mutation history', async () => {
  const mutation = scopeDigest('once-only-intent');
  const proposal = { token: 'authorization-before-downstream-failure', operationId: 'POST /api/ops/observability/boards', description: '创建看板', preview: '{}', expiresAt: Date.now() + 60_000 };
  let task = await service.create(owner, { goal: '创建看板并查看状态' });
  task = await service.finish(owner, task.id, task.revision, { response: { reply: '待确认', operations: [], proposal } });
  await assert.rejects(service.claimConfirmation(owner, task.id, task.revision, proposal.token, 'not-sha256'), error('invalid_input'));
  const consumed = await service.claimConfirmation(owner, task.id, task.revision, proposal.token, mutation);
  task = await service.finish(owner, task.id, consumed.task.revision, { status: 'failed', response: { reply: '下游授权存储暂不可用，未重试。', operations: [] } });
  assert.deepEqual(await service.getMutationDigests(owner, task.id), [mutation]);
  task = await service.claim(owner, task.id, task.revision);
  assert.deepEqual(await service.getMutationDigests(owner, task.id), []);
  assert.equal(task.goal, '创建看板并查看状态');
  task = await service.finish(owner, task.id, task.revision, { response: { reply: '用户新的明确请求', operations: [], proposal: { ...proposal, token: 'new-turn-confirmation' } } });
  const next = await service.claimConfirmation(owner, task.id, task.revision, 'new-turn-confirmation', mutation);
  assert.equal(next.task.status, 'running'); assert.deepEqual(await service.getMutationDigests(owner, task.id), [mutation]);
});

test('old persisted tasks without mutation digests retain checksum integrity and adopt an empty private history', async () => {
  const task = await completed();
  await stateFixture((state) => { delete state.tasks.find((item) => item.id === task.id)!.mutationDigests; });
  const restarted = new PlatformAssistantTaskService({ stateDir: directory });
  assert.deepEqual(await restarted.get(owner, task.id), task); assert.deepEqual(await restarted.getMutationDigests(owner, task.id), []);
  await stateFixture((state) => { state.tasks.find((item) => item.id === task.id)!.mutationDigests = [scopeDigest('dup'), scopeDigest('dup')]; });
  await assert.rejects(restarted.list(owner), error('corrupt_state', 503));
});

test('expired confirmation stays visible as metadata but cannot execute and may only be replanned under a new claim', async () => {
  const running = await service.create(owner, { goal: '准备变更' });
  const proposal = { token: 'expired.exact.token', operationId: 'POST /api/ops/observability/boards', description: '创建看板', preview: '{}', expiresAt: Date.now() - 1 };
  const waiting = await service.finish(owner, running.id, running.revision, { response: { reply: '待确认', operations: [], proposal } });
  assert.equal(await service.getPending(owner, waiting.id), null);
  await assert.rejects(service.claimConfirmation(owner, waiting.id, waiting.revision, proposal.token), error('confirmation_expired', 409));
  const next = await service.claim(owner, waiting.id, waiting.revision);
  assert.equal(next.status, 'running'); assert.equal(next.response!.proposal, undefined); assert.equal(await service.getPending(owner, waiting.id), null);
});

test('confirmation recovery preserves full authorized previews beyond the chat text budget', async () => {
  const running = await service.create(owner, { goal: '创建完整看板' });
  const preview = JSON.stringify({ body: { name: '完整参数', spec: { panels: Array.from({ length: 48 }, (_, index) => ({ title: 'panel-' + index, metric: 'm'.repeat(240) })) }, tail: '必须看见最后一个参数' } });
  assert.ok(preview.length > 8_000 && preview.length < 32_000);
  const task = await service.finish(owner, running.id, running.revision, { response: { reply: '待确认', operations: [], proposal: {
    token: 'full.preview.confirmation', operationId: 'POST /api/ops/observability/boards', description: '创建看板', preview, expiresAt: Date.now() + 60_000,
  } } });
  assert.equal(task.response!.proposal!.preview, preview); assert.ok(task.response!.proposal!.preview.includes('必须看见最后一个参数'));
  assert.equal((await new PlatformAssistantTaskService({ stateDir: directory }).getPending(owner, task.id))!.preview, preview);
});

test('once-only credential values are scrubbed from goal, history, replies and aliased receipts while genuine proof survives', async () => {
  const token = 'opaque.fixture.once.token'; const probe = 'opaque.fixture.probe.token';
  const running = await service.create(owner, { goal: '查询 token=initial.secret 然后核对 ' + token });
  const sensitive: PlatformAssistantResult = { reply: `已返回 ${token} 和 ${probe}。`, operations: [{
    id: 'POST /api/ops/observability/tenants', description: '创建租户', status: 201, ok: true,
    data: { token, probeToken: probe, note: token, nested: { echo: probe }, evidenceProof: 'signed-proof-for-next-turn',
      log: 'Authorization: Bearer unlabelled-bearer-value\npassword=log-secret' },
  }] };
  const task = await service.finish(owner, running.id, running.revision, { response: sensitive, history: [
    { role: 'user', content: '之前返回 ' + token }, { role: 'assistant', content: 'probe=' + probe },
  ] });
  const disk = await readFile(stateFile(), 'utf8');
  for (const secret of [token, probe, 'initial.secret', 'unlabelled-bearer-value', 'log-secret']) { assert.ok(!disk.includes(secret), secret); assert.ok(!JSON.stringify(task).includes(secret), secret); }
  assert.ok(disk.includes('signed-proof-for-next-turn')); assert.ok(task.response!.historyContent.includes('signed-proof-for-next-turn'));
  assert.equal((task.response!.operations[0].data as Record<string, unknown>).token, '[REDACTED]');
  assert.equal((task.response!.operations[0].data as Record<string, unknown>).note, '[REDACTED]');
  assert.equal(sensitive.operations[0].data && (sensitive.operations[0].data as Record<string, unknown>).token, token);
});

test('oversized history is refused and large receipts preserve identifiers and explicit truncation instead of raw payloads', async () => {
  await assert.rejects(service.create(owner, { goal: '测试', history: Array.from({ length: 13 }, () => ({ role: 'user' as const, content: '查询' })) }), error('invalid_input'));
  const running = await service.create(owner, { goal: '查询很多数据' });
  const data = { deviceId: 'actual-device-x5', evidenceProof: 'p'.repeat(20_000), rows: Array.from({ length: 1_000 }, (_, id) => ({ id, value: 'x'.repeat(200) })) };
  const task = await service.finish(owner, running.id, running.revision, { response: { reply: '查询已返回。', operations: [{ ...response.operations[0], data }] } });
  assert.ok(task.response!.historyContent.length <= 8_000);
  assert.ok(JSON.stringify(task.response!.operations[0].data).includes('actual-device-x5'));
  assert.ok(JSON.stringify(task.response!.operations[0].data).includes('truncated'));
  assert.ok(!JSON.stringify(task).includes('p'.repeat(20_000)));
  assert.ok(!JSON.stringify(task).includes('…[截断]"') || !(task.response!.operations[0].data as Record<string, unknown>).evidenceProof);
});

test('feedback is explicit operator labeling and exported real cases never assert validation success', async () => {
  const good = await completed();
  const failed = await service.create(owner, { goal: '查询不可用来源' });
  const done = await service.finish(owner, failed.id, failed.revision, { response: { reply: '来源不可用。', operations: [{ ...response.operations[0], ok: false, status: 503, data: { error: 'source_unavailable' } }] } });
  const label = await service.feedback(owner, good.id, good.revision, 'helpful');
  await assert.rejects(service.feedback(owner, good.id, good.revision, 'not_helpful'), error('stale_revision', 409));
  await service.feedback(owner, done.id, done.revision, 'not_helpful');
  await assert.rejects(service.feedback(owner, label.id, label.revision, 'verified' as 'helpful'), error('invalid_input'));
  const exported = await service.exportCases(owner);
  assert.equal(exported.source, 'actual_assistant_tasks'); assert.equal(exported.labelAuthority, 'operator'); assert.equal(exported.verification, 'not_evaluated');
  assert.equal(exported.cases.length, 2); assert.equal(exported.stats.helpful, 1); assert.equal(exported.stats.notHelpful, 1);
  assert.equal(exported.stats.reportedCompleted, 1); assert.equal(exported.stats.failed, 1); assert.equal(exported.stats.validatedSuccess, null);
  assert.ok(exported.cases.every((item) => item.verification === 'not_evaluated'));
  const restarted = new PlatformAssistantTaskService({ stateDir: directory });
  assert.equal((await restarted.get(owner, label.id)).feedback!.label, 'helpful');
});

test('process exit recovers running tasks as interrupted, persists recovery and never repeats confirmation or side effects', async () => {
  const run = await child(fixturePrefix() + `const task=await service.create(scope,{goal:'未完成的实际任务'}); console.log(JSON.stringify(task));`);
  assert.equal(run.status, 0, run.stderr); const created = JSON.parse(run.stdout);
  const restored = await service.get(owner, created.id);
  assert.equal(restored.status, 'interrupted'); assert.equal(restored.revision, created.revision + 1); assert.equal(restored.error, 'platform_assistant_task_process_interrupted');
  assert.equal(restored.response, null); assert.equal(await service.getPending(owner, restored.id), null);
  const second = new PlatformAssistantTaskService({ stateDir: directory }); assert.deepEqual(await second.get(owner, restored.id), restored);
  await assert.rejects(service.claim(owner, restored.id, created.revision), error('stale_revision', 409));
  const next = await service.claim(owner, restored.id, restored.revision); assert.equal(next.status, 'running');
  const interruptedConfirm = await child(fixturePrefix() + `const task=await service.create(scope,{goal:'确认后进程中断'}); const proposal={token:'used-confirmation-token',operationId:'POST /api/ops/observability/boards',description:'创建看板',preview:'{}',expiresAt:Date.now()+60000}; const waiting=await service.finish(scope,task.id,task.revision,{response:{reply:'待确认',operations:[],proposal}}); const claim=await service.claimConfirmation(scope,task.id,waiting.revision,proposal.token); console.log(JSON.stringify(claim.task));`);
  assert.equal(interruptedConfirm.status, 0, interruptedConfirm.stderr);
  const confirmed = await service.get(owner, JSON.parse(interruptedConfirm.stdout).id); assert.equal(confirmed.status, 'interrupted');
  assert.equal(await service.getPending(owner, confirmed.id), null);
  assert.ok(!(await readFile(stateFile(), 'utf8')).includes('used-confirmation-token'));
});

test('abandoned live-process leases expire and reused PIDs cannot keep an old execution running', async () => {
  const expired = await service.create(owner, { goal: '进程仍存活但已丢失的执行' });
  await stateFixture((state) => { state.tasks.find((item) => item.id === expired.id)!.lease!.expiresAt = Date.now() - 1; });
  await assert.rejects(service.finish(owner, expired.id, expired.revision, { response }), error('stale_revision', 409));
  const restored = await service.get(owner, expired.id); assert.equal(restored.status, 'interrupted'); assert.equal(restored.error, 'platform_assistant_task_lease_expired');
  const reused = await service.create(owner, { goal: 'PID 已复用的旧执行' });
  await stateFixture((state) => { state.tasks.find((item) => item.id === reused.id)!.lease!.processBirth = 'different-process-birth'; });
  const recovered = await service.get(owner, reused.id); assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.error, 'platform_assistant_task_process_interrupted');
  assert.equal(recovered.response, null); assert.equal(await service.getPending(owner, reused.id), null);
  const lockFile = join(directory, scopeDigest(owner) + '.lock');
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, processBirth: 'old-process-with-reused-pid', nonce: randomUUID() }), { mode: 0o600 });
  assert.equal((await service.list(owner)).tasks.length, 2);
});

test('multiple actual processes append without lost updates and dead writer locks are recovered', async () => {
  const workers = await Promise.all(Array.from({ length: 3 }, (_, worker) => child(fixturePrefix() + `for(let index=0;index<5;index++){const task=await service.create(scope,{goal:'worker-${worker}-'+index}); await service.finish(scope,task.id,task.revision,{response:{reply:'已完成读取',operations:[]}})};`)));
  for (const worker of workers) assert.equal(worker.status, 0, worker.stderr);
  const tasks = (await service.list(owner)).tasks; assert.equal(tasks.length, 15); assert.equal(new Set(tasks.map((item) => item.id)).size, 15);
  assert.equal(tasks.filter((item) => item.status === 'completed').length, 15);
  const lockFile = join(directory, scopeDigest(owner) + '.lock');
  const stale = await child(`import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(lockFile)},JSON.stringify({pid:process.pid,processBirth:'exited-process-birth',nonce:${JSON.stringify(randomUUID())}}),{mode:0o600});`);
  assert.equal(stale.status, 0, stale.stderr); assert.equal((await service.list(owner)).tasks.length, 15);
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.lock') || name.includes('.recover-') || name.endsWith('.tmp')));
});

test('corrupt, deleted, wrong-owner, malformed-lock and symlink state fail closed without overwriting evidence', async () => {
  const task = await completed(); const original = await readFile(stateFile(), 'utf8');
  await writeFile(stateFile(), '{broken-json');
  await assert.rejects(service.get(owner, task.id), error('corrupt_state', 503));
  await assert.rejects(service.create(owner, { goal: '不可覆盖损坏数据' }), error('corrupt_state', 503));
  assert.equal(await readFile(stateFile(), 'utf8'), '{broken-json');
  await writeFile(stateFile(), original); await unlink(stateFile());
  await assert.rejects(service.list(owner), error('missing_state', 503));
  await writeFile(stateFile(), original, { mode: 0o600 });
  const other = join(directory, scopeDigest(otherOwner) + '.json'); await writeFile(other, original, { mode: 0o600 });
  await assert.rejects(service.list(otherOwner), error('corrupt_state', 503));
  const lockFile = join(directory, scopeDigest(owner) + '.lock'); await writeFile(lockFile, '{}');
  await assert.rejects(service.list(owner), error('unsafe_lock', 503)); await unlink(lockFile);
  const target = join(directory, 'external-state'); await writeFile(target, original); await unlink(stateFile()); await symlink(target, stateFile());
  await assert.rejects(service.list(owner), error('corrupt_state', 503)); assert.equal(await readFile(target, 'utf8'), original);
  const alias = directory + '-alias'; await symlink(directory, alias);
  try { await assert.rejects(new PlatformAssistantTaskService({ stateDir: alias }).list(owner), error('unsafe_state_path', 503)); }
  finally { await unlink(alias); }
});

test('unexpectedly public state-file permissions are rejected and never silently reused', async () => {
  await completed(); const disk = await readFile(stateFile(), 'utf8'); await chmod(stateFile(), 0o644);
  await assert.rejects(service.list(owner), error('unsafe_state_permissions', 503));
  await assert.rejects(service.create(owner, { goal: '禁止复用权限错误数据' }), error('unsafe_state_permissions', 503));
  assert.equal(await readFile(stateFile(), 'utf8'), disk); assert.equal((await lstat(stateFile())).mode & 0o777, 0o644);
});
