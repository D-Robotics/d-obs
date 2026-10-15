import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformAssistantHistoryContent, runPlatformAssistant,
  type PlatformAssistantOperation, type PlatformAssistantOperationResult } from './platform-assistant.js';

const marker = '\n安全操作回执：';
function receipts(history: string): unknown {
  const start = history.lastIndexOf(marker); assert.ok(start >= 0, 'the history must contain a structured receipt');
  return JSON.parse(history.slice(start + marker.length));
}
function values(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, child]) => [...(name === key ? [child] : []), ...values(child, key)]);
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value); for (const child of Object.values(value)) freeze(child);
}
function receipt(data: unknown): PlatformAssistantOperationResult {
  return { id: 'POST /api/ops/observability/actions/evidence-proof', description: '签发证据凭证', status: 200, ok: true, data };
}

test('confirmed IDs and signed proof enter safe history unchanged without forwarding credentials or changing the original receipt', () => {
  const proof = 'evidence.exact-byte-proof_AbC123.sig';
  const operations = [receipt({ id: 'proof-receipt-id', evidenceProof: proof,
    board: { id: 'board-real-id', name: '真实看板' }, token: 'fixture-only-token', password: 'fixture-only-password',
    nested: { credentials: { username: 'fixture-credential-user', value: 'fixture-credential-value' } },
    evidenceRefs: ['event:real-ref'], note: 'password=fixture-only-inline-password',
  })];
  const before = JSON.stringify(operations); freeze(operations);
  const history = platformAssistantHistoryContent('回执已返回 fixture-only-token fixture-credential-value。', operations);
  assert.ok(history.length <= 8_000);
  const parsed = receipts(history);
  assert.deepEqual(values(parsed, 'evidenceProof'), [proof]);
  assert.ok(values(parsed, 'id').includes('board-real-id'));
  assert.match(history, /event:real-ref/);
  for (const secret of ['fixture-only-token', 'fixture-only-password', 'fixture-credential-user',
    'fixture-credential-value', 'fixture-only-inline-password']) assert.ok(!history.includes(secret), secret);
  assert.equal(JSON.stringify(operations), before, 'operator-visible original receipts must retain their actual values');
});

test('large earlier payloads keep later proof and object IDs while history remains valid and bounded', () => {
  const proof = 'signed-' + 'p'.repeat(1_800) + '-signature';
  const operations = [receipt({ noisyPayload: 'large noisy evidence '.repeat(8_000),
    events: Array.from({ length: 1_000 }, (_, index) => ({ text: 'detail '.repeat(50), sequence: index })),
    nested: { credentials: { token: 'nested-large-secret', password: 'nested-large-password' } },
    boardId: 'real-board-after-noise', actionId: 'real-action-after-noise', evidenceProof: proof,
  })];
  const before = JSON.stringify(operations); freeze(operations);
  const history = platformAssistantHistoryContent('答复'.repeat(8_000), operations);
  assert.ok(history.length <= 8_000);
  const parsed = receipts(history);
  assert.deepEqual(values(parsed, 'evidenceProof'), [proof]);
  assert.deepEqual(values(parsed, 'boardId'), ['real-board-after-noise']);
  assert.deepEqual(values(parsed, 'actionId'), ['real-action-after-noise']);
  assert.doesNotMatch(history, /nested-large-secret|nested-large-password/);
  assert.equal(JSON.stringify(operations), before);
});

test('a signed proof that cannot fit is explicitly omitted instead of forwarding a clipped unusable proof', () => {
  const proof = 'oversized-signature-' + 'p'.repeat(40_000);
  const operations = [receipt({ evidenceProof: proof, boardId: 'still-visible-id' })];
  const before = JSON.stringify(operations); freeze(operations);
  const history = platformAssistantHistoryContent('已返回回执。', operations);
  assert.ok(history.length <= 8_000);
  const parsed = receipts(history);
  assert.deepEqual(values(parsed, 'evidenceProof'), []);
  assert.ok(values(parsed, 'evidenceProofOmitted').includes(true));
  assert.deepEqual(values(parsed, 'boardId'), ['still-visible-id']);
  assert.ok(!history.includes('oversized-signature-'));
  assert.equal(JSON.stringify(operations), before);
});

test('large actual engine receipts retain later source status and identifiers in bounded structured history', async () => {
  const operation: PlatformAssistantOperation = { id: 'GET /api/ops/observability/learning', description: '读取学习数据',
    group: '学习', method: 'GET', path: '/api/ops/observability/learning', mutating: false };
  let round = 0;
  const result = await runPlatformAssistant({ message: '查询学习数据源状态' }, {
    operations: [operation], enabled: () => true,
    complete: async () => ++round === 1 ? JSON.stringify({ operation: { id: operation.id } }) : JSON.stringify({ reply: '技能可用，经验未配置，进化不可用。' }),
    execute: async () => ({ ok: true, status: 200, data: { learning: {
      noisy: 'noise '.repeat(20_000), skill: { status: 'ok', overview: { noisy: 'data '.repeat(10_000) } },
      observation: { experience: { status: 'not_configured' }, evolution: { status: 'unavailable' } },
      boardId: 'real-after-noise', evidenceProof: 'signed-proof-after-noise', token: 'never-forward-later-token',
    } } }),
  });
  const data = result.operations[0].data as { truncated: boolean; preview: string; structuredData: unknown };
  assert.equal(data.truncated, true); assert.ok(data.preview.length > 0);
  assert.ok(JSON.stringify(data).length <= 12_000);
  assert.deepEqual(values(data.structuredData, 'status').sort(), ['not_configured', 'ok', 'unavailable']);
  const history = receipts(result.historyContent!);
  assert.deepEqual(values(history, 'boardId'), ['real-after-noise']);
  assert.deepEqual(values(history, 'evidenceProof'), ['signed-proof-after-noise']);
  assert.doesNotMatch(result.historyContent!, /never-forward-later-token/);
});

test('a later model turn uses a confirmed history ID to prepare an update proposal without executing it', async () => {
  const create: PlatformAssistantOperation = { id: 'POST /api/ops/observability/boards', description: '创建看板',
    group: '自定义看板', method: 'POST', path: '/api/ops/observability/boards', mutating: true };
  const update: PlatformAssistantOperation = { id: 'PUT /api/ops/observability/boards/:boardId', description: '更新看板',
    group: '自定义看板', method: 'PUT', path: '/api/ops/observability/boards/:boardId', mutating: true,
    parameters: { body: { name: '可选新名称。' } } };
  let writes = 0;
  const propose = (operation: PlatformAssistantOperation, args: unknown) => ({ token: 'fixture-encrypted-authorization',
    operationId: operation.id, description: operation.description, preview: JSON.stringify(args), expiresAt: Date.now() + 300_000 });
  const first = await runPlatformAssistant({ message: '创建名为历史验收的看板' }, { operations: [create, update],
    enabled: () => true, complete: async () => JSON.stringify({ operation: { id: create.id, body: { name: '历史验收' } } }),
    proposeMutation: propose, execute: async () => { writes++; throw new Error('must-not-write-before-confirmation'); },
  });
  assert.equal(first.proposal?.operationId, create.id); assert.equal(writes, 0);
  // This is the trusted confirm response's separate history field, rather than
  // text invented by the prior model or a proposal that has not been executed.
  const confirmed = platformAssistantHistoryContent('已执行确认的变更，请查看操作回执。', [{
    id: create.id, description: create.description, status: 201, ok: true,
    data: { board: { id: 'board-created-by-confirm-route', name: '历史验收' }, token: 'never-forward-created-token' },
  }]);
  let observedId = '';
  const next = await runPlatformAssistant({ message: '把刚才创建的看板改名为更新验收', history: [
    { role: 'user', content: '创建名为历史验收的看板' },
    { role: 'assistant', content: first.historyContent! }, { role: 'assistant', content: confirmed },
  ] }, { operations: [create, update], enabled: () => true,
    complete: async (messages) => {
      const history = messages.filter(item => item.role === 'assistant').find(item => item.content.includes('board-created-by-confirm-route'))!;
      assert.ok(history); assert.doesNotMatch(JSON.stringify(messages), /never-forward-created-token/);
      observedId = String(values(receipts(history.content), 'id').find(id => id === 'board-created-by-confirm-route'));
      return JSON.stringify({ operation: { id: update.id, params: { boardId: observedId }, body: { name: '更新验收' } } });
    }, proposeMutation: propose, execute: async () => { writes++; throw new Error('must-not-execute-a-new-mutation'); },
  });
  assert.equal(observedId, 'board-created-by-confirm-route');
  assert.equal(next.proposal?.operationId, update.id);
  assert.match(next.proposal!.preview, /board-created-by-confirm-route/); assert.match(next.proposal!.preview, /更新验收/);
  assert.equal(next.operations.length, 0); assert.equal(writes, 0);
});
