import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { callGatewayChat } from './copilot-model.js';
import { runPlatformAssistant } from './platform-assistant.js';

test('assistant output budget leaves room for a tool plan after reasoning consumes the copilot budget', async () => {
  const budgets: number[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    budgets.push(input.max_tokens);
    const completedRead = input.messages.some((message: any) => message.content.includes('platformOperationResult'));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: input.max_tokens <= 1_200 ? 'length' : 'stop', message: {
      reasoning_content: 'reasoning'.repeat(250),
      content: input.max_tokens <= 1_200 ? '' : JSON.stringify(completedRead
        ? { reply: '当前有 3 条日志记录。' } : { operation: { id: 'logs.read' } }),
    } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const target = { baseUrl: `http://127.0.0.1:${address.port}`, model: 'test', apiKey: 'test-key' };
    await assert.rejects(callGatewayChat(target, [{ role: 'user', content: 'read logs' }], 1_000), /gateway_empty_response/);
    let reads = 0;
    const result = await runPlatformAssistant({ message: '目前日志情况' }, {
      operations: [{ id: 'logs.read', method: 'GET', path: '/logs', group: 'logs', description: '读取日志', mutating: false }],
      enabled: () => true,
      complete: (messages) => callGatewayChat(target, messages, 1_000, { maxTokens: 4_096 }),
      execute: async () => { reads++; return { ok: true, status: 200, data: { count: 3 } }; },
    });
    assert.equal(reads, 1);
    assert.match(result.reply, /3 条日志记录/);
    assert.doesNotMatch(result.reply, /platform_assistant_/);
    assert.deepEqual(budgets, [1_200, 4_096, 4_096]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
