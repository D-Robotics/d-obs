import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPlatformAssistant, platformAssistantMutationDigest, type PlatformAssistantDeps, type PlatformAssistantOperation, type PlatformAssistantOperationResult } from './platform-assistant.js';

const mutation: PlatformAssistantOperation = { id: 'POST /boards', description: '创建看板', group: 'boards', path: '/boards', method: 'POST', mutating: true };
const read: PlatformAssistantOperation = { id: 'GET /boards/:boardId', description: '读取看板', group: 'boards', path: '/boards/:boardId', method: 'GET', mutating: false };
const receipt: PlatformAssistantOperationResult = { id: mutation.id, description: mutation.description, ok: true, status: 201, data: { board: { id: 'b1', name: '错误率' } } };
const args = { body: { name: '错误率' } };
function deps(extra: Partial<PlatformAssistantDeps> = {}): PlatformAssistantDeps {
  return { operations: [mutation, read], enabled: () => true, execute: async () => { throw new Error('unexpected_execution'); },
    complete: async () => JSON.stringify({ reply: '看板已创建。' }), continuation: { receipt, args }, ...extra };
}
test('confirmed mutation seeds actual receipts; readback happens before planning and cannot re-execute the write', async () => {
  const calls: string[] = [];
  const result = await runPlatformAssistant({ message: '创建错误率看板并检查配置。' }, deps({
    continuation: { receipt, args, readback: { id: read.id, args: { params: { boardId: 'b1' } } } },
    execute: async (id, input) => { calls.push(id); assert.deepEqual(input, { params: { boardId: 'b1' } }); return { ok: true, status: 200, data: { board: { id: 'b1', name: '错误率' } } }; },
    complete: async (messages) => { assert.match(messages[0].content, /禁止再次提案/); assert.match(messages.at(-1)!.content, /read_changed_resource/);
      return JSON.stringify({ reply: '看板已创建，读回名称为错误率。' }); },
  }));
  assert.deepEqual(calls, [read.id]); assert.deepEqual(result.operations.map((item) => item.id), [mutation.id, read.id]);
  assert.match(result.reply, /读回名称/);
});
test('a new change after confirmation produces a separate card, while repeated exact writes are refused', async () => {
  for (const repeated of [false, true]) {
    let proposed = 0; let executed = 0;
    const result = await runPlatformAssistant({ message: '创建两张不同看板。' }, deps({
      complete: async () => JSON.stringify({ operation: { id: mutation.id, body: { name: repeated ? '错误率' : '延迟' } } }),
      execute: async () => { executed++; return { ok: true, status: 201, data: {} }; },
      proposeMutation: (_operation, next) => { proposed++; assert.equal(next.body?.name, '延迟'); return { token: 'next-exact-token', operationId: mutation.id, description: '创建第二张看板', preview: JSON.stringify(next), expiresAt: Date.now() + 60_000 }; },
    }));
    assert.equal(executed, 0); assert.equal(result.operations.length, 1);
    assert.equal(proposed, repeated ? 0 : 1);
    if (repeated) assert.match(result.reply, /duplicate_mutation/); else assert.equal(result.proposal?.token, 'next-exact-token');
  }
});
test('failed readback keeps the confirmed receipt and stops before model planning or further effects', async () => {
  let models = 0;
  const result = await runPlatformAssistant({ message: '创建看板并检查。' }, deps({
    continuation: { receipt, args, readback: { id: read.id, args: { params: { boardId: 'b1' } } } },
    complete: async () => { models++; throw new Error('must_not_plan'); }, execute: async () => ({ ok: false, status: 503, data: { error: 'db_unavailable' } }),
  }));
  assert.equal(models, 0); assert.equal(result.operations[0].ok, true); assert.equal(result.operations[1].ok, false);
  assert.match(result.reply, /尚不能确认最终状态/);
});
test('a previous confirmation in the same task turn cannot be proposed again after another change', async () => {
  let proposed = 0;
  const result = await runPlatformAssistant({ message: '创建错误率和延迟两张看板。' }, deps({
    continuation: { receipt: { ...receipt, data: { board: { id: 'b2', name: '延迟' } } }, args: { body: { name: '延迟' } } },
    blockedMutationDigests: [platformAssistantMutationDigest(mutation.id, args)],
    complete: async () => JSON.stringify({ operation: { id: mutation.id, ...args } }),
    proposeMutation: () => { proposed++; throw new Error('must_not_repropose'); },
  }));
  assert.equal(proposed, 0); assert.match(result.reply, /duplicate_mutation/); assert.equal(result.operations[0].data && (result.operations[0].data as any).board.name, '延迟');
});
test('disabled model retains an already executed mutation; continuation never grants another write', async () => {
  const result = await runPlatformAssistant({ message: '创建看板' }, deps({ enabled: () => false }));
  assert.equal(result.operations.length, 1); assert.equal(result.operations[0].status, 201); assert.match(result.reply, /model_disabled/);
  await assert.rejects(() => runPlatformAssistant({ message: '检查' }, deps({ continuation: { receipt: { ...receipt, id: read.id }, args } })), /invalid_continuation/);
});

test('queued actions cannot be described as verified; only the same action with actual positive checks can pass', async () => {
  const execute = { ...mutation, id: 'POST /api/ops/observability/actions/:id/execute', path: '/api/ops/observability/actions/:id/execute', description: '执行处置' };
  const detail = { ...read, id: 'GET /api/ops/observability/actions/:id', path: '/api/ops/observability/actions/:id' };
  for (const state of ['executing', 'wrong-action', 'wrong-run', 'succeeded'] as const) {
    const pending = { id: 'a1', status: 'executing', execution: { runId: 'r1', verification: { pending: true, ok: false, checks: [] } } };
    const observed = state === 'executing' ? pending : { id: state === 'wrong-action' ? 'a2' : 'a1', status: 'succeeded',
      execution: { runId: state === 'wrong-run' ? 'r2' : 'r1', verification: { ok: true, checkedAt: '2026-10-13T00:00:00Z', checks: [{ name: 'health', ok: true }] } } };
    const result = await runPlatformAssistant({ message: '执行行动 a1，并检查修复结果。' }, deps({ operations: [execute, detail],
      continuation: { receipt: { ...receipt, id: execute.id, data: { action: pending } }, args: { params: { id: 'a1' } }, readback: { id: detail.id, args: { params: { id: 'a1' } } } },
      execute: async () => ({ ok: true, status: 200, data: { action: observed } }), complete: async () => JSON.stringify({ reply: '后置验证已通过。' }),
    }));
    if (state === 'succeeded') assert.match(result.reply, /后置验证已通过/);
    else { assert.doesNotMatch(result.reply, /后置验证已通过/); assert.match(result.reply, /post_verification_unconfirmed/); }
  }
});
