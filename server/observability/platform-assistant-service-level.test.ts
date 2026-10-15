import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPlatformAssistant } from './platform-assistant.js';

const overview = { id: 'overview.read', method: 'GET', path: '/api/ops/observability/overview', group: 'overview', description: '读取平台总览', mutating: false };
const serviceLevels = { policy: { windowDays: 30 }, summary: { total: 1, exhausted: 1 }, objectives: [{
  key: 'chat', title: '对话成功率', targetPercent: 99.9, compliancePercent: 98.7,
  status: 'budget_exhausted', dataAvailable: true, sampleCount: 1000, minimumSamples: 100,
  errorBudget: { allowedBad: 1, consumedBad: 13, remainingBad: -12, remainingPercent: -1200 },
}] };

test('SLO answer missing requested error budget is completed from the actual overview without another API call', async () => {
  let completions = 0; let reads = 0;
  const result = await runPlatformAssistant({ message: '当前 SLO 和错误预算情况怎么样' }, {
    operations: [overview], enabled: () => true,
    complete: async () => completions++ === 0 ? JSON.stringify({ operation: { id: overview.id } }) : JSON.stringify({ reply: '当前 SLO 对话成功率为 98.7%。' }),
    execute: async () => { reads++; return { ok: true, status: 200, data: { overview: { serviceLevels } } }; },
  });
  assert.equal(reads, 1); assert.equal(completions, 2);
  assert.match(result.reply, /错误预算：剩余 -1200%/);
  assert.match(result.reply, /剩余坏事件 -12 次/);
  assert.doesNotMatch(result.reply, /platform_assistant_/);
});

test('SLO error budget survives a generic fallback after multiple large reads', async () => {
  const other = { id: 'logs.read', method: 'GET', path: '/logs', group: 'logs', description: '读取日志', mutating: false };
  let completions = 0; let reads = 0;
  const result = await runPlatformAssistant({ message: '当前平台 SLO 与错误预算情况' }, {
    operations: [overview, other], enabled: () => true,
    complete: async () => {
      if (completions++ >= 5) throw new Error('model_failure');
      return JSON.stringify({ operation: { id: completions === 1 ? overview.id : other.id, query: { page: completions } } });
    },
    execute: async (id) => {
      reads++;
      return { ok: true, status: 200, data: id === overview.id ? { overview: {
        checks: Array.from({ length: 50 }, (_, index) => ({ index, evidence: 'x'.repeat(1000) })), serviceLevels,
      } } : { entries: Array.from({ length: 20 }, () => ({ text: 'y'.repeat(1000) })) } };
    },
  });
  assert.equal(reads, 5);
  assert.match(result.reply, /错误预算：剩余 -1200%/);
  assert.match(result.reply, /对话成功率/);
  assert.doesNotMatch(result.reply, /platform_assistant_/);
});

test('an SLO query with no overview receipt does not fabricate a budget summary', async () => {
  const result = await runPlatformAssistant({ message: '当前 SLO 与错误预算' }, {
    operations: [overview], enabled: () => true,
    complete: async () => { throw new Error('model_failure'); },
    execute: async () => { throw new Error('must_not_execute'); },
  });
  assert.match(result.reply, /platform_assistant_model_unavailable/);
  assert.equal(result.operations.length, 0);
  assert.doesNotMatch(result.reply, /错误预算：/);
});
