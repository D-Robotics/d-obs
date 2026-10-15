import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPlatformAssistant, type PlatformAssistantOperation } from './platform-assistant.js';

async function request(operation: PlatformAssistantOperation, args: Record<string, unknown>) {
  let executions = 0; let proposals = 0;
  const result = await runPlatformAssistant({ message: '继续操作平台' }, {
    operations: [operation], enabled: () => true,
    complete: async () => JSON.stringify({ operation: { id: operation.id, ...args } }),
    execute: async () => { executions++; throw new Error('must_not_execute'); },
    proposeMutation: async () => { proposals++; return { token: 'test-only', operationId: operation.id, description: operation.description, preview: JSON.stringify(args), expiresAt: Date.now() + 1000 }; },
  });
  return { result, executions, proposals };
}

test('a mutation missing its target asks for a readable target without generating a confirmation', async () => {
  const { result, executions, proposals } = await request({ id: 'boards.update', group: 'boards', method: 'PUT', path: '/boards/:boardId', description: '更新看板', mutating: true }, { body: { name: 'fixture' } });
  assert.equal(executions, 0); assert.equal(proposals, 0); assert.equal(result.proposal, undefined);
  assert.match(result.reply, /请提供看板名称或标识/);
  assert.match(result.reply, /尚未执行/);
});

test('mandatory query and body fields are clarified before reads or mutation proposals', async () => {
  const cases = [
    { operation: { id: 'account.read', group: 'account', method: 'GET', path: '/account', description: '读取账号', mutating: false, parameters: { query: { identifier: '必填账号', hours: '可选时间' } } }, args: { query: { hours: 1 } }, label: /要查询的账号/ },
    { operation: { id: 'windows.create', group: 'windows', method: 'POST', path: '/windows', description: '创建维护窗口', mutating: true, parameters: { body: { minutes: '必填分钟', reason: '必填原因' } } }, args: { body: { minutes: null, reason: ' ' } }, label: /持续分钟数、原因/ },
  ];
  for (const { operation, args, label } of cases) {
    const { result, executions, proposals } = await request(operation, args);
    assert.equal(executions, 0); assert.equal(proposals, 0); assert.match(result.reply, label);
  }
});

test('false and zero are present values and API type validation remains authoritative', async () => {
  const { result, executions, proposals } = await request({ id: 'price.update', group: 'prices', method: 'PUT', path: '/prices/:model', description: '更新单价', mutating: true, parameters: { body: { input: '必填价格', enabled: '必填状态' } } }, { params: { model: 'vendor/model' }, body: { input: 0, enabled: false } });
  assert.equal(executions, 0); assert.equal(proposals, 1); assert.equal(result.proposal?.operationId, 'price.update');
});

test('an account question can request the missing identifier without claiming live account data', async () => {
  for (const reply of ['请提供要查询的账号。', '请选择要查看的账户或用户名。', '您想查询哪个账号？',
    '请提供要查询的账号标识（SSO ID 或用户名），我再帮你查询该账号最近 7 天的运行、会话、用量和登录情况。\n\n说明：该查询按账号聚合运行、会话、用量、配置审计、登录审计和事故等数据，默认回看 7 天（168 小时），需要明确的账号标识，我不会自行猜测或使用他人账号。',
    '缺少必要参数，无法查询：账号行为接口要求提供明确的账号标识（SSO ID 或用户名），当前请求中没有该标识，我不会猜测或使用他人账号。\n\n请提供以下任一标识后我再执行查询：\n- 账号的 SSO ID\n- 或账号用户名\n\n收到后我将调用账号行为聚合接口，查询该账号最近 7 天（168 小时）的运行、会话、用量、配置审计、登录审计和事故数据，并如实返回平台结果。你也可以指定其他回看小时数（1–720）。',
  ]) {
    let executions = 0;
    const result = await runPlatformAssistant({ message: '查询一个账号最近七天的行为和用量' }, {
      operations: [], enabled: () => true, complete: async () => JSON.stringify({ reply }),
      execute: async () => { executions++; throw new Error('must_not_execute'); },
    });
    assert.equal(executions, 0); assert.match(result.reply, /账号|账户|用户名/);
    assert.doesNotMatch(result.reply, /platform_assistant_no_evidence/);
  }
});

test('account clarification cannot conceal an unsupported current-data claim', async () => {
  for (const reply of ['请提供账号。当前平台登录正常。', '请提供账号。我查询到当前有活跃用户。', '请提供账号。已经有3条登录记录。']) {
    const result = await runPlatformAssistant({ message: '查询一个账号的最近登录情况' }, {
      operations: [], enabled: () => true, complete: async () => JSON.stringify({ reply }),
      execute: async () => { throw new Error('must_not_execute'); },
    });
    assert.match(result.reply, /platform_assistant_no_evidence/);
  }
});

test('catalog-backed account clarification uses a safe fixed parameter request for natural model wording', async () => {
  for (const reply of ['请告诉我要查哪个账号，我才能查其登录记录。', '请给出 SSO ID 或账户用户名，然后我再读取其用量。', '平台已有100条登录记录，请提供账号。']) {
    const result = await runPlatformAssistant({ message: '查询一个账号最近七天的运行、会话、用量和登录' }, {
      operations: [{ id: 'GET /api/ops/observability/account-activity', description: '查询账号行为', group: '账号行为', method: 'GET', path: '/api/ops/observability/account-activity', mutating: false, parameters: { query: { identifier: '必填账号标识' } } }],
      enabled: () => true, complete: async () => JSON.stringify({ reply }),
      execute: async () => { throw new Error('must_not_execute'); },
    });
    assert.match(result.reply, /请提供要查询的账号/);
    assert.match(result.reply, /本轮尚未查询账号数据/);
    assert.equal(result.operations.length, 0); assert.equal(result.proposal, undefined);
    assert.doesNotMatch(result.reply, /100条|platform_assistant_no_evidence/);
  }
});

test('natural target questions become catalog-backed clarification without carrying invented platform facts', async () => {
  for (const reply of ['请输入看板ID或当前名称，我再帮你修改名称。', '你想改哪个看板？请给出当前名称。', '目前已有100个看板，请告诉我要修改哪个看板。']) {
    const result = await runPlatformAssistant({ message: '我想修改某个看板，但尚未指定目标。请先询问目标，不调用查询或变更。' }, {
      operations: [{ id: 'PUT /api/ops/observability/boards/:boardId', description: '更新看板', group: '自定义看板', method: 'PUT', path: '/api/ops/observability/boards/:boardId', mutating: true }],
      enabled: () => true, complete: async () => JSON.stringify({ reply }),
      execute: async () => { throw new Error('must_not_execute'); },
      proposeMutation: () => { throw new Error('must_not_propose'); },
    });
    assert.match(result.reply, /请提供看板名称或标识/); assert.match(result.reply, /尚未执行/);
    assert.doesNotMatch(result.reply, /100个|platform_assistant_no_evidence/);
    assert.equal(result.operations.length, 0); assert.equal(result.proposal, undefined);
  }
});

test('account clarification wins over incidental run words in the full capability catalog', async () => {
  const result = await runPlatformAssistant({ message: '查询一个账号最近七天的运行、会话、用量和登录行为。' }, {
    operations: [
      { id: 'GET /api/ops/observability/account-activity', description: '查询账号行为', group: '账号行为', method: 'GET', path: '/api/ops/observability/account-activity', mutating: false, parameters: { query: { identifier: '必填账号标识' } } },
      { id: 'GET /api/ops/observability/runs/:locator', description: '读取运行详情', group: '运行链路', method: 'GET', path: '/api/ops/observability/runs/:locator', mutating: false },
    ], enabled: () => true, complete: async () => JSON.stringify({ reply: '请提供账号标识，我再查询该账号最近七天的运行、会话、用量和登录情况。' }),
    execute: async () => { throw new Error('must_not_execute'); },
  });
  assert.match(result.reply, /请提供要查询的账号/);
  assert.doesNotMatch(result.reply, /运行详情标识/);
  assert.equal(result.operations.length, 0); assert.equal(result.proposal, undefined);
});
