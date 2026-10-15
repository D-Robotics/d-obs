import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPlatformAssistant } from './platform-assistant.js';
import { projectPlatformAssistantData } from './platform-assistant-projection.js';

test('a current Grafana answer requires a real API receipt', async () => {
  let calls = 0;
  const result = await runPlatformAssistant({ message: '目前 Grafana 有什么？' }, {
    enabled: () => true,
    operations: [{ id: 'GET /api/ops/observability/grafana/dashboards', method: 'GET',
      path: '/api/ops/observability/grafana/dashboards', mutating: false, group: 'Grafana', description: '读取大盘目录' }],
    complete: async () => { calls++; return JSON.stringify({ reply: '目前 Grafana 共有 4 个大盘。' }); },
    execute: async () => { throw new Error('unexpected_execution'); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.operations, []);
  assert.match(result.reply, /platform_assistant_no_evidence/);
  assert.doesNotMatch(result.reply, /4 个大盘/);
});

test('large account receipts retain unavailable sources and time precision', () => {
  const projected = projectPlatformAssistantData({ report: {
    turns: { recent: Array.from({ length: 80 }, () => ({ channel: 'fixture', padding: 'x'.repeat(1000) })) },
    timeWindow: { hours: 24, precision: 'timestamp' }, registrationScope: 'all_history',
    sourceAvailability: { runs: { status: 'ok' }, turns: { status: 'ok' }, usage: { status: 'unavailable' } },
    dataCompleteness: 'partial',
  } }, 4000) as any;
  assert.equal(projected.report.sourceAvailability.usage.status, 'unavailable');
  assert.equal(projected.report.timeWindow.precision, 'timestamp');
  assert.equal(projected.report.registrationScope, 'all_history');
  assert.equal(projected.report.dataCompleteness, 'partial');
  assert.ok(JSON.stringify(projected).length <= 4000);
});

test('account source limits and Grafana definitions reach model with their actual receipts', async () => {
  const id = 'GET /api/ops/observability/account-activity';
  let calls = 0;
  const result = await runPlatformAssistant({ message: '查询指定账号最近一天的行为。' }, {
    enabled: () => true, operations: [{ id, method: 'GET', path: id.slice(4), mutating: false,
      group: '账号行为', description: '读取指定账号行为', parameters: { query: { identifier: '必填账号' } } }],
    complete: async (messages) => {
      assert.match(messages[0].content, /unavailable.*不能解释为零记录/);
      assert.match(messages[0].content, /实时指标值必须再读取对应 PromQL/);
      if (calls++ === 0) return JSON.stringify({ operation: { id, query: { identifier: 'fixture-user', hours: 24 } } });
      const evidence = messages.find((entry) => entry.content.includes('platformOperationResult'))!;
      assert.match(evidence.content, /timestamp/);
      assert.match(evidence.content, /unavailable/);
      return JSON.stringify({ reply: '数据不完整：用量源不可用，无法判断活跃天数；注册资料为全历史。' });
    },
    execute: async () => ({ status: 200, ok: true, data: { report: {
      sourceAvailability: { usage: { status: 'unavailable' } }, dataCompleteness: 'partial',
      timeWindow: { hours: 24, precision: 'timestamp' }, registrationScope: 'all_history',
    } } }),
  });
  assert.equal(result.operations.length, 1);
  assert.match(result.reply, /数据不完整/);
  assert.match(result.reply, /零值或空列表不能证明没有活动/);
  assert.match(result.reply, /最近 24 小时/);
  assert.match(result.reply, /自然日/);
});

test('later account failures retain their own identifier and time window', async () => {
  const id = 'GET /api/ops/observability/account-activity';
  const outputs = ['first', 'second'];
  const result = await runPlatformAssistant({ message: '对比这两个指定账号的行为。' }, {
    enabled: () => true, operations: [{ id, method: 'GET', path: id.slice(4), mutating: false,
      group: '账号行为', description: '读取账号行为' }],
    complete: async () => outputs.length
      ? JSON.stringify({ operation: { id, query: { identifier: outputs.shift() } } })
      : JSON.stringify({ reply: '第二个账号没有活动。' }),
    execute: async (_id, args) => ({ status: 200, ok: true, data: { report: {
      identifier: args.query?.identifier, sourceAvailability: { runs: { status: args.query?.identifier === 'first' ? 'ok' : 'unavailable' } },
      timeWindow: { hours: args.query?.identifier === 'first' ? 24 : 48 },
    } } }),
  });
  assert.equal(result.operations.length, 2);
  assert.match(result.reply, /账号 "first"：[\s\S]*最近 24 小时/);
  assert.match(result.reply, /账号 "second"：[\s\S]*账号查询不完整：[\s\S]*零值或空列表不能证明没有活动[\s\S]*最近 48 小时/);
  assert.doesNotMatch(result.reply, /第二个账号没有活动/);
});

const grafanaCatalog = ['dashboards', 'datasources'].map((name) => ({
  id: `GET /api/ops/observability/grafana/${name}`, method: 'GET',
  path: `/api/ops/observability/grafana/${name}`, mutating: false, group: 'Grafana', description: '读取目录',
}));
test('compound Grafana listing retrieves an omitted datasource once before accepting the answer', async () => {
  const outputs = [{ operation: { id: grafanaCatalog[0].id } }, { reply: '已有四个大盘。' },
    { operation: { id: grafanaCatalog[1].id } }, { reply: '原生 Grafana 有四个大盘和一个数据源。' }];
  const executed: string[] = [];
  const result = await runPlatformAssistant({ message: '看看当前原生 Grafana 有哪些大盘，以及配置了哪些数据源。' }, {
    enabled: () => true, operations: grafanaCatalog,
    complete: async (messages) => {
      if (outputs.length === 2) assert.match(messages.at(-1)!.content, /尚未调用.*grafana\/datasources/);
      return JSON.stringify(outputs.shift());
    },
    execute: async (id) => { executed.push(id); return { status: 200, ok: true, data: { source: 'grafana-api' } }; },
  });
  assert.deepEqual(executed, grafanaCatalog.map((entry) => entry.id));
  assert.equal(result.operations.length, 2);
  assert.doesNotMatch(result.reply, /incomplete_query/);
});
test('compound Grafana listing fails closed after bounded correction and never replays a GET', async () => {
  for (const failed of [false, true]) {
    let calls = 0; const executed: string[] = [];
    const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源。' }, {
      enabled: () => true, operations: grafanaCatalog,
      complete: async () => JSON.stringify(calls++ === 0
        ? { operation: { id: grafanaCatalog[0].id } } : { reply: '全部查询完成，所有配置正常。' }),
      execute: async (id) => { executed.push(id); return { status: failed ? 503 : 200, ok: !failed, data: {} }; },
    });
    assert.equal(calls, failed ? 1 : 3);
    assert.deepEqual(executed, [grafanaCatalog[0].id]);
    assert.match(result.reply, /platform_assistant_incomplete_query/);
    assert.doesNotMatch(result.reply, /全部查询完成|所有配置正常/);
  }
});

test('a particular dashboard datasource reference does not require a global catalog', async () => {
  const id = 'GET /api/ops/observability/grafana/dashboards/:uid';
  let calls = 0;
  const result = await runPlatformAssistant({ message: '读取原生 Grafana 大盘 UID a，告诉我有哪些面板、数据源引用。' }, {
    enabled: () => true, operations: [...grafanaCatalog, { id, method: 'GET',
      path: '/api/ops/observability/grafana/dashboards/:uid', mutating: false, group: 'Grafana', description: '读取定义' }],
    complete: async () => JSON.stringify(calls++ === 0 ? { operation: { id, params: { uid: 'a' } } } : { reply: '该大盘引用 Prometheus 数据源。' }),
    execute: async () => ({ status: 200, ok: true, data: { dashboard: { uid: 'a' } } }),
  });
  assert.equal(calls, 2);
  assert.equal(result.operations.length, 1);
  assert.doesNotMatch(result.reply, /incomplete_query/);
});

test('coverage correction cannot replay or dispatch unrelated operations', async () => {
  for (const id of [grafanaCatalog[0].id, 'GET /api/ops/observability/overview']) {
    const outputs = [{ operation: { id: grafanaCatalog[0].id } }, { reply: '已查到大盘。' }, { operation: { id } }];
    const executed: string[] = [];
    const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源。' }, {
      enabled: () => true, operations: [...grafanaCatalog, ...(!grafanaCatalog.some((entry) => entry.id === id)
        ? [{ id, method: 'GET', path: id.slice(4), mutating: false, group: '测试', description: '读取' }] : [])],
      complete: async () => JSON.stringify(outputs.shift()),
      execute: async (operation) => { executed.push(operation); return { status: 200, ok: true, data: {} }; },
    });
    assert.deepEqual(executed, [grafanaCatalog[0].id]);
    assert.match(result.reply, /incomplete_query/);
  }
});
test('model errors and malformed final replies cannot hide an incomplete catalog', async () => {
  for (const mode of ['throw', 'malformed']) {
    let calls = 0;
    const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源。' }, {
      enabled: () => true, operations: grafanaCatalog,
      complete: async () => {
        if (calls++ === 0) return JSON.stringify({ operation: { id: grafanaCatalog[0].id } });
        if (mode === 'throw') throw new Error('fixture_gateway_failure');
        return calls === 2 ? '{broken' : JSON.stringify({ reply: '两个目录均已读取。' });
      },
      execute: async () => ({ status: 200, ok: true, data: {} }),
    });
    assert.equal(result.operations.length, 1);
    assert.match(result.reply, /incomplete_query/);
    assert.doesNotMatch(result.reply, /查询已完成|两个目录均已读取/);
  }
});
test('explicitly declining the datasource catalog does not trigger another read', async () => {
  let calls = 0;
  const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板，不要查询数据源目录。' }, {
    enabled: () => true, operations: grafanaCatalog,
    complete: async () => JSON.stringify(calls++ === 0 ? { operation: { id: grafanaCatalog[0].id } } : { reply: '原生看板目录已查询。' }),
    execute: async () => ({ status: 200, ok: true, data: {} }),
  });
  assert.equal(calls, 2);
  assert.equal(result.operations.length, 1);
  assert.doesNotMatch(result.reply, /incomplete_query/);
});
test('the correction does not consume the final reply after the sixth read', async () => {
  const extra = Array.from({ length: 4 }, (_, index) => ({ id: `GET /api/ops/observability/fixture-${index}`,
    method: 'GET', path: `/api/ops/observability/fixture-${index}`, mutating: false, group: '测试', description: '读取' }));
  const outputs = [...[grafanaCatalog[0], ...extra].map(({ id }) => ({ operation: { id } })),
    { reply: '大盘已查询。' }, { operation: { id: grafanaCatalog[1].id } }, { reply: '原生 Grafana 大盘和数据源目录均已读取。' }];
  const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源。' }, {
    enabled: () => true, operations: [...grafanaCatalog, ...extra],
    complete: async () => JSON.stringify(outputs.shift()), execute: async () => ({ status: 200, ok: true, data: {} }),
  });
  assert.equal(outputs.length, 0);
  assert.equal(result.operations.length, 6);
  assert.doesNotMatch(result.reply, /execution_limit|incomplete_query/);
});

test('declining datasource mutations still requires the requested datasource read', async () => {
  const outputs = [{ operation: { id: grafanaCatalog[0].id } }, { reply: '看板已读取。' },
    { operation: { id: grafanaCatalog[1].id } }, { reply: '看板和数据源目录均已读取。' }];
  const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源，不要修改数据源。' }, {
    enabled: () => true, operations: grafanaCatalog, complete: async () => JSON.stringify(outputs.shift()),
    execute: async () => ({ status: 200, ok: true, data: {} }),
  });
  assert.equal(outputs.length, 0);
  assert.equal(result.operations.length, 2);
  assert.doesNotMatch(result.reply, /incomplete_query/);
});

test('a failed corrective read stops before the model can replay it', async () => {
  const outputs = [{ operation: { id: grafanaCatalog[0].id } }, { reply: '已读取看板目录。' },
    { operation: { id: grafanaCatalog[1].id } }, { operation: { id: grafanaCatalog[1].id } }];
  const executed: string[] = [];
  const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源。' }, {
    enabled: () => true, operations: grafanaCatalog, complete: async () => JSON.stringify(outputs.shift()),
    execute: async (id) => { executed.push(id); return { status: id === grafanaCatalog[0].id ? 200 : 503, ok: id === grafanaCatalog[0].id, data: {} }; },
  });
  assert.deepEqual(executed, grafanaCatalog.map((entry) => entry.id));
  assert.equal(outputs.length, 1);
  assert.match(result.reply, /incomplete_query/);
});

const visionCatalog = ['capabilities', 'experiments'].map((name) => ({
  id: `GET /api/ops/observability/vision-workshop/${name}`, method: 'GET',
  path: `/api/ops/observability/vision-workshop/${name}`, mutating: false, group: '视觉 Workshop', description: '读取实际视觉能力或实验目录',
}));
const visionCompoundQuestion = '视觉 Workshop 目前有哪些我能看到的实验？设备适配器、采集和应用参数能力是否已配置？请同时读取实际能力和实验列表，只查询，不连接或操作设备。';
const visionData = (id: string) => id === visionCatalog[0].id
  ? { capabilities: { devices: [], modelEnabled: false } } : { experiments: [] };

test('the exact SSO Vision compound question retrieves either omitted catalog before accepting a real reply', async () => {
  for (const first of [0, 1]) {
    const missing = 1 - first;
    const outputs = [{ operation: { id: visionCatalog[first].id } },
      { reply: '设备能力尚未配置，当前没有你能看到的实验。' },
      { operation: { id: visionCatalog[missing].id } }, { reply: '能力和实验列表均已读取，当前没有实验，设备适配器尚未配置。' }];
    const executed: string[] = [];
    const result = await runPlatformAssistant({ message: visionCompoundQuestion }, {
      enabled: () => true, operations: visionCatalog,
      complete: async (messages) => {
        if (outputs.length === 2) {
          assert.match(messages.at(-1)!.content, /视觉 Workshop 能力清单与实验目录/);
          assert.ok(messages.at(-1)!.content.includes(visionCatalog[missing].id));
        }
        return JSON.stringify(outputs.shift());
      },
      execute: async (id) => { executed.push(id); return { status: 200, ok: true, data: visionData(id) }; },
    });
    assert.deepEqual(executed, [visionCatalog[first].id, visionCatalog[missing].id]);
    assert.equal(outputs.length, 0); assert.equal(result.operations.length, 2);
    assert.doesNotMatch(result.reply, /incomplete_query/);
  }
});

test('explicit Chinese and English Vision compound requests share the same two-receipt guard', async () => {
  for (const message of ['请读取视觉工坊实验列表与能力。', '请只读查询当前视觉 Workshop 的能力和已有实验列表。', 'List Vision Workshop experiments and capabilities.']) {
    const outputs = [{ operation: { id: visionCatalog[0].id } }, { reply: '能力已查询。' },
      { operation: { id: visionCatalog[1].id } }, { reply: '实际能力和实验目录已读取。' }];
    const result = await runPlatformAssistant({ message }, {
      enabled: () => true, operations: visionCatalog, complete: async () => JSON.stringify(outputs.shift()),
      execute: async (id) => ({ status: 200, ok: true, data: visionData(id) }),
    });
    assert.equal(outputs.length, 0, message); assert.equal(result.operations.length, 2, message);
    assert.doesNotMatch(result.reply, /incomplete_query/, message);
  }
});

test('Vision correction is bounded and a required failure stops immediately without a replay', async () => {
  for (const mode of ['ignored', 'initial-failed', 'corrective-failed']) {
    let calls = 0; const executed: string[] = [];
    const outputs = [{ operation: { id: visionCatalog[0].id } }, { reply: '全部实验和能力均已查询完成。' },
      ...(mode === 'ignored' ? [{ reply: '全部实验和能力均已查询完成。' }] : [{ operation: { id: visionCatalog[1].id } }]),
      { operation: { id: visionCatalog[1].id } }];
    const result = await runPlatformAssistant({ message: visionCompoundQuestion }, {
      enabled: () => true, operations: visionCatalog,
      complete: async () => { calls++; return JSON.stringify(outputs.shift()); },
      execute: async (id) => {
        executed.push(id); const failed = mode === 'initial-failed' || (mode === 'corrective-failed' && id === visionCatalog[1].id);
        return { status: failed ? 503 : 200, ok: !failed, data: failed ? { error: 'fixture_vision_unavailable' } : visionData(id) };
      },
    });
    assert.equal(calls, mode === 'initial-failed' ? 1 : 3, mode);
    assert.deepEqual(executed, mode === 'corrective-failed' ? visionCatalog.map(({ id }) => id) : [visionCatalog[0].id], mode);
    assert.match(result.reply, /视觉 Workshop 查询尚不完整/); assert.match(result.reply, /incomplete_query/);
    assert.doesNotMatch(result.reply, /全部实验和能力均已查询完成|Grafana/);
  }
});

test('Vision coverage cannot duplicate a catalog read or dispatch unrelated corrective work', async () => {
  const unrelated = { id: 'GET /api/ops/observability/overview', method: 'GET', path: '/api/ops/observability/overview', mutating: false, group: '测试', description: '读取总览' };
  for (const mode of ['direct-duplicate', 'corrective-duplicate', 'corrective-unrelated']) {
    const outputs = [{ operation: { id: visionCatalog[0].id } },
      ...(mode === 'direct-duplicate' ? [] : [{ reply: '能力已经读取。' }]),
      { operation: { id: mode === 'corrective-unrelated' ? unrelated.id : visionCatalog[0].id } }];
    const executed: string[] = [];
    const result = await runPlatformAssistant({ message: visionCompoundQuestion }, {
      enabled: () => true, operations: [...visionCatalog, unrelated], complete: async () => JSON.stringify(outputs.shift()),
      execute: async (id) => { executed.push(id); return { status: 200, ok: true, data: visionData(id) }; },
    });
    assert.deepEqual(executed, [visionCatalog[0].id], mode); assert.match(result.reply, /incomplete_query/);
  }
});

test('every terminal response preserves incomplete Vision coverage including errors, invalid instructions and execution limit', async () => {
  const detail = { id: 'GET /api/ops/observability/vision-workshop/experiments/:id', method: 'GET', path: '/api/ops/observability/vision-workshop/experiments/:id', mutating: false, group: '视觉 Workshop', description: '读取实际实验' };
  const extras = Array.from({ length: 5 }, (_, index) => ({ id: `GET /api/ops/observability/vision-terminal-${index}`, method: 'GET', path: `/api/ops/observability/vision-terminal-${index}`, mutating: false, group: '测试', description: '读取' }));
  for (const mode of ['throw', 'malformed', 'unknown', 'missing-param', 'execution-limit']) {
    let calls = 0;
    const result = await runPlatformAssistant({ message: visionCompoundQuestion }, {
      enabled: () => true, operations: [...visionCatalog, detail, ...extras],
      complete: async () => {
        if (calls++ === 0) return JSON.stringify({ operation: { id: visionCatalog[0].id } });
        if (mode === 'throw') throw new Error('fixture_gateway_failure');
        if (mode === 'malformed') return calls === 2 ? '{broken' : JSON.stringify({ reply: '两项目录均已查询完成。' });
        if (mode === 'unknown') return JSON.stringify({ operation: { id: 'GET /unknown' } });
        if (mode === 'missing-param') return JSON.stringify({ operation: { id: detail.id } });
        return calls <= 6 ? JSON.stringify({ operation: { id: extras[calls - 2].id } }) : JSON.stringify({ reply: '两项目录均已查询完成。' });
      },
      execute: async (id) => ({ status: 200, ok: true, data: visionData(id) }),
    });
    assert.equal(result.operations.length, mode === 'execution-limit' ? 6 : 1, mode);
    assert.match(result.reply, /incomplete_query/, mode); assert.doesNotMatch(result.reply, /两项目录均已查询完成/);
  }
});

test('single Vision reads, explicit refusals, explanation questions and experiment IDs never activate compound coverage', async () => {
  const detail = { id: 'GET /api/ops/observability/vision-workshop/experiments/:id', method: 'GET', path: '/api/ops/observability/vision-workshop/experiments/:id', mutating: false, group: '视觉 Workshop', description: '读取实验详情' };
  const scenarios = [
    { message: '列出当前视觉 Workshop 实验列表。', id: visionCatalog[1].id },
    { message: '查询当前 Vision Workshop 设备适配器和采集能力是否配置。', id: visionCatalog[0].id },
    { message: '列出视觉工坊实验列表，不要读取能力。', id: visionCatalog[1].id },
    { message: '查询视觉 Workshop 能力，不用读取实验目录。', id: visionCatalog[0].id },
    { message: 'List Vision Workshop experiments; do not read capabilities.', id: visionCatalog[1].id },
    { message: '读取视觉 Workshop 实验 ID fixture 有哪些能力和实验列表。', id: detail.id },
    { message: 'Read Vision Workshop experiment ID fixture and its capabilities.', id: detail.id },
    { message: '平台当前有哪些实验列表和设备能力？', id: visionCatalog[0].id },
    { message: '如何查看视觉工坊实验列表和能力？', id: visionCatalog[0].id },
    { message: 'How do I list Vision Workshop experiments and capabilities?', id: visionCatalog[0].id },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const result = await runPlatformAssistant({ message: scenario.message }, {
      enabled: () => true, operations: [...visionCatalog, detail],
      complete: async () => JSON.stringify(calls++ === 0 ? { operation: { id: scenario.id, ...(scenario.id === detail.id ? { params: { id: 'fixture' } } : {}) } } : { reply: '已读取本次请求对应的真实结果。' }),
      execute: async (id) => ({ status: 200, ok: true, data: visionData(id) }),
    });
    assert.equal(calls, 2, scenario.message); assert.equal(result.operations.length, 1, scenario.message);
    assert.doesNotMatch(result.reply, /incomplete_query/, scenario.message);
  }
});

test('Vision correction can use the sixth read and still accept the final two-receipt answer', async () => {
  const extras = Array.from({ length: 4 }, (_, index) => ({ id: `GET /api/ops/observability/vision-limit-${index}`, method: 'GET', path: `/api/ops/observability/vision-limit-${index}`, mutating: false, group: '测试', description: '读取' }));
  const outputs = [...[visionCatalog[0], ...extras].map(({ id }) => ({ operation: { id } })),
    { reply: '能力已读取。' }, { operation: { id: visionCatalog[1].id } }, { reply: '实际能力与实验目录均已查询。' }];
  const result = await runPlatformAssistant({ message: visionCompoundQuestion }, {
    enabled: () => true, operations: [...visionCatalog, ...extras], complete: async () => JSON.stringify(outputs.shift()),
    execute: async (id) => ({ status: 200, ok: true, data: visionData(id) }),
  });
  assert.equal(outputs.length, 0); assert.equal(result.operations.length, 6);
  assert.doesNotMatch(result.reply, /execution_limit|incomplete_query/);
});

test('joint explicit Grafana and Vision compound requests require all four successful GET receipts', async () => {
  const outputs = [{ operation: { id: grafanaCatalog[0].id } }, { operation: { id: visionCatalog[0].id } }, { reply: '已查询两个模块。' },
    { operation: { id: grafanaCatalog[1].id } }, { operation: { id: visionCatalog[1].id } }, { reply: 'Grafana 大盘和数据源、视觉 Workshop 能力与实验目录均已读取。' }];
  const executed: string[] = [];
  const result = await runPlatformAssistant({ message: '列出当前 Grafana 所有看板和数据源，同时读取视觉工坊实验列表与能力。' }, {
    enabled: () => true, operations: [...grafanaCatalog, ...visionCatalog], complete: async () => JSON.stringify(outputs.shift()),
    execute: async (id) => { executed.push(id); return { status: 200, ok: true, data: id.includes('vision-workshop') ? visionData(id) : {} }; },
  });
  assert.equal(outputs.length, 0); assert.equal(result.operations.length, 4);
  assert.deepEqual(new Set(executed), new Set([...grafanaCatalog, ...visionCatalog].map(({ id }) => id)));
  assert.doesNotMatch(result.reply, /incomplete_query/);
});
