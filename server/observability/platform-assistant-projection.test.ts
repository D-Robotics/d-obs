import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPlatformAssistantData, formatModelPoolSnapshot, formatServiceLevelSnapshot } from './platform-assistant-projection.js';
import { calculateServiceLevelMeasurement, SERVICE_LEVEL_OBJECTIVES } from '../monitoring/service-level-objectives.js';

test('large overview retains late SLOs and error budgets while sampling bulky checks and traces', () => {
  const serviceLevels = {
    generatedAt: '2026-10-12T08:00:00Z', summary: { healthy: 2, breached: 1 },
    objectives: [{ id: 'chat-success', target: 99.9, current: 98.7, errorBudget: { remainingPercent: -15, allowedBad: 10, remainingBad: -2 } }],
  };
  const value = { ok: true, overview: {
    summary: { openIncidents: 1, healthyChecks: 46 },
    checks: Array.from({ length: 47 }, (_, id) => ({ id, status: 'healthy', description: 'x'.repeat(1_000) })),
    events: Array.from({ length: 30 }, (_, id) => ({ id, text: 'y'.repeat(1_000) })),
    runTraces: Array.from({ length: 8 }, (_, id) => ({ id, spans: 'z'.repeat(2_000) })),
    serviceLevels,
  } };
  const projected = projectPlatformAssistantData(value) as any;
  assert.deepEqual(projected.overview.serviceLevels, serviceLevels);
  assert.deepEqual(projected.overview.summary, value.overview.summary);
  assert.equal(projected.overview.checks.totalItems, 47);
  assert.ok(projected.overview.checks.includedItems < 47);
  assert.ok(JSON.stringify(projected).length <= 12_000);
});

test('small evidence is preserved and an evidence proof has priority over bulky log records', () => {
  const small = { summary: { count: 1 }, records: [{ id: 'a' }] };
  assert.deepEqual(projectPlatformAssistantData(small), small);
  const evidenceProof = 'signed-'.repeat(300);
  const projected = projectPlatformAssistantData({ records: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(1_000) })), evidenceProof }) as any;
  assert.equal(projected.evidenceProof, evidenceProof);
});

test('nested structures, escaping and excessive keys always respect the serialized budget', () => {
  for (const budget of [100, 400, 1_000, 12_000]) {
    for (const value of [
      '\"\\\n'.repeat(10_000),
      Array.from({ length: 100 }, () => ({ text: '\"\\\n'.repeat(1_000), other: [1, 2, 3] })),
      Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['key'+i, 'x'.repeat(500)])),
    ]) assert.ok(JSON.stringify(projectPlatformAssistantData(value, budget)).length <= budget);
  }
});

test('projection handles deeply nested and cyclic results with explicit truncation', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const projected = projectPlatformAssistantData(cyclic);
  assert.match(JSON.stringify(projected), /truncated/);
  assert.ok(JSON.stringify(projected).length <= 12_000);
});

test('model pool fallback describes real counts, degraded targets and routing without a JSON dump', () => {
  const result = formatModelPoolSnapshot({
    health: { summary: { totalTargets: 2, healthy: 1, cooldown: 1, halfOpen: 0, degraded: 1 }, targets: [{ label: 'backup', model: 'm2', state: 'cooldown', lastHealthError: 'quota_or_limit' }] },
    config: { modelMapping: { primary: { model: 'm1', fallbacks: ['backup'] } }, fallbackPolicy: { enabled: true, failureThreshold: 3 } },
    protectedFrontendModel: '',
  });
  assert.ok(result);
  assert.match(result, /2 个目标：1 个健康、1 个冷却/);
  assert.match(result, /backup：冷却，原因 quota_or_limit/);
  assert.match(result, /primary → m1；fallback：backup/);
  assert.match(result, /处于启用状态/);
  assert.doesNotMatch(result, /\{"/);
  assert.equal(formatModelPoolSnapshot({}), null);
});

test('SLO snapshot follows the real measurement schema and retains exhausted negative error budgets', () => {
  const measurement = calculateServiceLevelMeasurement(SERVICE_LEVEL_OBJECTIVES[0], {
    objective: { good: 998, total: 1_000 }, fast: { good: 99, total: 100 }, slow: { good: 599, total: 600 },
  });
  const result = formatServiceLevelSnapshot({ overview: { serviceLevels: {
    generatedAt: '2026-10-12T08:00:00Z', policy: { windowDays: 28 },
    summary: { total: 1, healthy: 0, atRisk: 0, exhausted: 1, slaBreached: 0, noData: 0 },
    objectives: [measurement],
  } } });
  assert.ok(result);
  assert.match(result, /SLO 与错误预算（28 天滚动窗口）/);
  assert.match(result, /公网服务可用性：SLO 未达标；SLO 目标 99\.9%/);
  assert.match(result, /当前 SLI：99\.8%/);
  assert.match(result, /错误预算：剩余 -100%；允许坏事件 1 次、已消耗 2 次、剩余坏事件 -1 次/);
  assert.match(result, /样本 1000 \/ 最少 60/);
  assert.match(result, /数据生成时间：2026-10-12T08:00:00Z/);
  assert.doesNotMatch(result, /全部达标|预算充足|剩余 0%/);
});

test('SLO absent samples are unknown and insufficient samples retain the actual reference budget', () => {
  const absent = calculateServiceLevelMeasurement(SERVICE_LEVEL_OBJECTIVES[0], {
    objective: null, fast: null, slow: null,
  });
  const insufficient = calculateServiceLevelMeasurement(SERVICE_LEVEL_OBJECTIVES[1], {
    objective: { good: 10, total: 10 }, fast: null, slow: null,
  });
  const result = formatServiceLevelSnapshot({ overview: { serviceLevels: { objectives: [absent, insufficient] } } });
  assert.ok(result);
  const missingSection = result.slice(result.indexOf('公网服务可用性'), result.indexOf('托管 Agent 网关可用性'));
  assert.match(missingSection, /样本不足/);
  assert.match(missingSection, /暂无有效样本，当前 SLI 与错误预算尚不可判定/);
  assert.doesNotMatch(missingSection, /当前 SLI：0%|错误预算：剩余 0%|：达标/);
  assert.match(result, /样本不足，当前指标与错误预算仅供参考，尚不能确认 SLO 达标/);
  assert.match(result, /错误预算：剩余 100%；允许坏事件 0\.05 次、已消耗 0 次、剩余坏事件 0\.05 次/);
});

test('SLO missing fields never use invented defaults or values from unrelated overview data', () => {
  assert.equal(formatServiceLevelSnapshot({ serviceLevels: { objectives: [] } }), null);
  for (const serviceLevels of [null, undefined]) {
    const result = formatServiceLevelSnapshot({ overview: { serviceLevels, summary: { healthy: 999, errorBudget: 100 } } });
    assert.ok(result);
    assert.match(result, /本轮概览未提供 SLO 数据，错误预算暂不可用/);
    assert.doesNotMatch(result, /999|100%|0 项|全部达标/);
  }
  const result = formatServiceLevelSnapshot({ overview: { serviceLevels: {
    summary: { total: 3, healthy: '3' }, objectives: [
      { key: 'missing', targetPercent: '99.9', compliancePercent: null, status: 'unknown', errorBudget: null },
      { title: 'zero-budget', dataAvailable: true, errorBudget: { allowedBad: 0, consumedBad: 0, remainingBad: 0, remainingPercent: null } },
    ],
  } } });
  assert.ok(result);
  assert.match(result, /3 项目标/);
  assert.match(result, /SLO 目标百分比未提供/);
  assert.match(result, /当前 SLI：未提供/);
  assert.match(result, /错误预算：未提供/);
  assert.match(result, /剩余百分比未提供；允许坏事件 0 次、已消耗 0 次、剩余坏事件 0 次/);
  assert.doesNotMatch(result, /3 项达标|99\.9%|剩余 0%/);
  assert.match(formatServiceLevelSnapshot({ overview: { serviceLevels: { objectives: [] } } })!, /未返回 SLO 目标明细，错误预算明细未提供/);
});

test('SLO snapshot reads projected objective samples and discloses omitted fields and objectives', () => {
  const measurement = calculateServiceLevelMeasurement(SERVICE_LEVEL_OBJECTIVES[0], {
    objective: { good: 998, total: 1_000 }, fast: null, slow: null,
  });
  const data = { overview: {
    checks: Array.from({ length: 50 }, () => ({ description: 'x'.repeat(1_000) })),
    serviceLevels: { summary: { total: 40, exhausted: 40 }, objectives: Array.from({ length: 40 }, () => measurement) },
  } };
  const projected = projectPlatformAssistantData(data) as any;
  assert.ok(projected.overview.serviceLevels.objectives.items.length < 40);
  const result = formatServiceLevelSnapshot(projected);
  assert.ok(result);
  assert.match(result, /40 项目标/);
  assert.match(result, /错误预算：剩余 -100%/);
  assert.match(result, /压缩或截断数据/);
  assert.match(result, /未列出的目标或字段无法确认/);
  assert.ok(result.length <= 6_000);
  const omitted = formatServiceLevelSnapshot({ overview: { serviceLevels: {
    _assistantProjection: { truncated: true }, summary: { total: 5 }, objectives: { truncated: true },
  } } });
  assert.match(omitted!, /错误预算明细未提供/);
  assert.match(omitted!, /压缩或截断数据/);
});

test('SLO output and long text are bounded with an explicit truncation notice', () => {
  const value = { overview: { serviceLevels: { objectives: Array.from({ length: 30 }, (_, index) => ({
    key: `key-${index}`, title: 'x'.repeat(500), status: 'y'.repeat(200), targetPercent: 99,
    dataAvailable: true, compliancePercent: 97, sampleCount: 100, minimumSamples: 60,
    errorBudget: { remainingPercent: -50, allowedBad: 1, consumedBad: 3, remainingBad: -2 },
  })) } } };
  const result = formatServiceLevelSnapshot(value);
  assert.ok(result);
  assert.ok(result.length <= 6_000);
  assert.match(result, /错误预算/);
  assert.match(result, /摘要已截断|压缩或截断数据/);
});
