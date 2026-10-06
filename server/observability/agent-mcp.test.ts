/**
 * MCP 工具面协议回归：initialize/tools list/tools call/ping/通知/错误路径。
 * 工具集用假实现注入，不触数据库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildObservabilityMcpTools, handleMcpJsonRpc, type McpTool } from './agent-mcp.js';

const SERVER = { name: 'd-obs-test', version: '0.0.1' };

const fakeTools: McpTool[] = [
  {
    name: 'echo',
    description: '原样返回 args',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    handler: async (args) => ({ got: args }),
  },
  {
    name: 'boom',
    description: '必定抛错',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('kaput');
    },
  },
];

test('initialize：协议版本回显，不支持时回落，并带 serverInfo', async () => {
  const echo = await handleMcpJsonRpc(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    fakeTools,
    SERVER,
  );
  assert.equal((echo?.result as Record<string, unknown>).protocolVersion, '2025-03-26');
  assert.deepEqual((echo?.result as Record<string, unknown>).serverInfo, SERVER);

  const fallback = await handleMcpJsonRpc(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    fakeTools,
    SERVER,
  );
  assert.equal((fallback?.result as Record<string, unknown>).protocolVersion, '2025-06-18');
});

test('tools/list 与 tools/call：成功、未知工具、handler 抛错（isError=true）', async () => {
  const list = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, fakeTools, SERVER);
  assert.deepEqual((list?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name), ['echo', 'boom']);

  const called = await handleMcpJsonRpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } },
    fakeTools,
    SERVER,
  );
  const ok = called?.result as { content: Array<{ type: string; text: string }>; isError: boolean };
  assert.equal(ok.isError, false);
  assert.equal(ok.content[0].type, 'text');
  assert.match(ok.content[0].text, /"got":\s*\{\s*"value":\s*"hi"\s*\}/);

  const unknown = await handleMcpJsonRpc(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
    fakeTools,
    SERVER,
  );
  assert.equal((unknown?.error as { code: number }).code, -32602);

  const failed = await handleMcpJsonRpc(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom' } },
    fakeTools,
    SERVER,
  );
  assert.equal((failed?.result as { isError: boolean }).isError, true);
  assert.match((failed?.result as { content: Array<{ text: string }> }).content[0].text, /kaput/);
});

test('通知无 id 返回 null（HTTP 层 202）；ping/未知方法/坏报文', async () => {
  assert.equal(await handleMcpJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeTools, SERVER), null);

  const ping = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, fakeTools, SERVER);
  assert.deepEqual(ping?.result, {});

  const notFound = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, fakeTools, SERVER);
  assert.equal((notFound?.error as { code: number }).code, -32601);

  assert.equal(((await handleMcpJsonRpc('not-json', fakeTools, SERVER)) as { error?: { code: number } }).error?.code, -32600);
  assert.equal(((await handleMcpJsonRpc({ jsonrpc: '2.0', id: 9 }, fakeTools, SERVER)) as { error?: { code: number } }).error?.code, -32600);
});

test('buildObservabilityMcpTools：query_metric 的 minutes/from-to 参数走不同窗口', async () => {
  let captured: Record<string, unknown> = {};
  const tools = buildObservabilityMcpTools({
    listSeries: async () => [],
    queryRanges: async (input) => {
      captured = input as Record<string, unknown>;
      return [];
    },
    queryLogs: async () => [],
    metricCatalog: () => [],
    listDevices: async () => [],
    nlQuery: async () => ({}),
  }, () => 1_000_000);

  const byName = (name: string) => tools.find((tool) => tool.name === name);
  assert.equal(tools.length, 6);

  await byName('query_metric')!.handler({ metric: 'm', minutes: 60 });
  assert.deepEqual(captured, { metric: 'm', fromMs: undefined, toMs: undefined, windowMinutes: 60, maxPoints: 240 });

  await byName('query_metric')!.handler({ metric: 'm', fromMs: 500_000, toMs: 900_000, points: 50 });
  assert.deepEqual(captured, { metric: 'm', fromMs: 500_000, toMs: 900_000, windowMinutes: undefined, maxPoints: 50 });

  await assert.rejects(() => byName('query_metric')!.handler({ metric: '' }), /metric is required/);
});

test('buildObservabilityMcpTools：注入 runIterationCycle 时注册 get_run_iteration_cycle，未注入不出现', async () => {
  const without = buildObservabilityMcpTools({
    listSeries: async () => [],
    queryRanges: async () => [],
    queryLogs: async () => [],
    metricCatalog: () => [],
    listDevices: async () => [],
    nlQuery: async () => ({}),
  });
  assert.equal(without.some((tool) => tool.name === 'get_run_iteration_cycle'), false);

  let capturedDays = 0;
  const withDep = buildObservabilityMcpTools({
    listSeries: async () => [],
    queryRanges: async () => [],
    queryLogs: async () => [],
    metricCatalog: () => [],
    listDevices: async () => [],
    nlQuery: async () => ({}),
    runIterationCycle: async (days) => {
      capturedDays = days;
      return { days, runsTotal: 10, caveat: 'ok' };
    },
  });
  const tool = withDep.find((item) => item.name === 'get_run_iteration_cycle');
  assert.ok(tool, 'get_run_iteration_cycle should be registered');
  const result = (await tool.handler({ days: 7 })) as { days: number };
  assert.equal(capturedDays, 7);
  assert.equal(result.days, 7);
  // 缺省 days=30，且越界被收敛
  await tool.handler({});
  assert.equal(capturedDays, 30);
  await tool.handler({ days: 999 });
  assert.equal(capturedDays, 90);
});
