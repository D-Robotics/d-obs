import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAMERA_WORKSHOP_PLUGIN_TEMPLATE } from './plugin-camera-workshop.js';
import { PluginError, PluginRuntime, validatePluginPackage } from './plugin-runtime.js';
import type { PluginExecutionContext } from './plugin-types.js';
import { VISION_WORKSHOP_API, VISION_WORKSHOP_OPERATIONS } from '../monitoring/vision-workshop-operations.js';
import { getVisionCameraKnowledge, visionKnowledgeReadiness } from '../monitoring/vision-workshop-knowledge.js';

const pack = CAMERA_WORKSHOP_PLUGIN_TEMPLATE;
const errorCode = (code: string) => (error: unknown) => error instanceof PluginError && error.code === code;

async function fixture(t: TestContext) {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), 'd-obs-camera-plugin-'));
  const runtime = new PluginRuntime({ stateDir });
  t.after(async () => { runtime.dispose(); await fs.rm(stateDir, { recursive: true, force: true }); });
  const knowledge = getVisionCameraKnowledge('x5-yahboom-imx415')!;
  const readiness = visionKnowledgeReadiness(knowledge, []);
  const calls: Array<{ operationId: string; args: Record<string, unknown> }> = [];
  const allowed = new Set(pack.manifest.tools.map(tool => tool.source.type === 'platform' ? tool.source.operationId : ''));
  const ctx: PluginExecutionContext = {
    canExecutePlatform: operationId => allowed.has(operationId),
    executePlatform: async (operationId, args) => {
      calls.push({ operationId, args });
      let data: unknown;
      if (operationId === 'GET ' + VISION_WORKSHOP_API + '/knowledge/:knowledgeId') data = { ok: true, knowledge, readiness };
      else if (operationId === 'GET ' + VISION_WORKSHOP_API + '/knowledge') data = { ok: true, entries: [{ id: knowledge.id, readiness }] };
      else if (operationId === 'GET ' + VISION_WORKSHOP_API + '/capabilities') data = { ok: true, deviceAdapters: [], aiDebug: { status: 'unavailable' } };
      else if (operationId === 'GET ' + VISION_WORKSHOP_API + '/experiments') data = { ok: true, experiments: [] };
      else if (operationId === 'GET ' + VISION_WORKSHOP_API + '/experiments/:id') data = { ok: true, experiment: { id: (args.params as Record<string, unknown>).id, deviceRuns: [{ state: 'unknown' }] } };
      else if (operationId.endsWith('/ai-debug/runs/:runId')) data = { ok: true, run: { id: (args.params as Record<string, unknown>).runId, status: 'failed', restore: 'unknown' } };
      else if (operationId.endsWith('/ai-debug/runs')) data = { ok: true, runs: [] };
      else throw new Error('unexpected_operation');
      return { ok: true, status: 200, data };
    },
  };
  const draft = await runtime.saveDraft('camera-owner', { manifest: pack.manifest, config: pack.config });
  await runtime.publish('camera-owner', pack.manifest.id, { expectedRevision: draft.revision }, ctx);
  return { runtime, ctx, calls, knowledge, readiness };
}

test('camera package keeps the plugin host GET-only and uses declared vision API operations', () => {
  assert.deepEqual(validatePluginPackage(pack.manifest, pack.config), pack);
  for (const tool of pack.manifest.tools) {
    assert.equal(tool.source.type, 'platform');
    if (tool.source.type !== 'platform') continue;
    assert.ok(tool.source.operationId.startsWith('GET '));
    assert.ok(Object.hasOwn(VISION_WORKSHOP_OPERATIONS, tool.source.operationId), tool.source.operationId);
  }
  const edited = structuredClone(pack.manifest);
  edited.tools[0].source = { type: 'platform', operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments' };
  assert.throws(() => validatePluginPackage(edited, pack.config), errorCode('plugin_write_tool_denied'));
});

test('only knowledge and optional experiment IDs are configurable; no invented device credentials', () => {
  assert.deepEqual(Object.keys(pack.manifest.configSchema.properties!).sort(), ['experimentId', 'knowledgeId']);
  assert.equal(pack.config.knowledgeId, 'x5-yahboom-imx415');
  assert.equal(pack.config.experimentId, '');
  // Omitting an optional experiment must not fail config substitution.
  assert.doesNotThrow(() => validatePluginPackage(pack.manifest, { knowledgeId: 'x5-yahboom-imx415' }));
  assert.doesNotThrow(() => validatePluginPackage(pack.manifest, { knowledgeId: 'x5-yahboom-imx415', experimentId: 'real-experiment-id' }));
  for (const key of ['targetId', 'url', 'command']) assert.throws(() => validatePluginPackage(pack.manifest, { ...pack.config, [key]: 'invented' }), errorCode('plugin_schema_validation_failed'));
  assert.throws(() => validatePluginPackage(pack.manifest, { ...pack.config, knowledgeId: '' }), errorCode('plugin_schema_validation_failed'));
});

test('readiness workflow and panel data sources preserve unavailable adapters and unverified hardware', async t => {
  const { runtime, ctx, calls, knowledge, readiness } = await fixture(t);
  const workflow = await runtime.runWorkflow('camera-owner', pack.manifest.id, 'readiness', {}, ctx);
  assert.equal(workflow.steps.length, 3);
  assert.deepEqual(calls.map(call => call.operationId), [
    'GET ' + VISION_WORKSHOP_API + '/knowledge/:knowledgeId',
    'GET ' + VISION_WORKSHOP_API + '/capabilities',
    'GET ' + VISION_WORKSHOP_API + '/experiments',
  ]);
  assert.deepEqual(calls[0].args, { params: { knowledgeId: 'x5-yahboom-imx415' } });
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'facts', {}, ctx)).data, knowledge.facts);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'required_atomics', {}, ctx)).data, knowledge.requiredAtomics);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'sources', {}, ctx)).data, knowledge.sources);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'diagnostic_cases', {}, ctx)).data, knowledge.diagnosticCases);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'historical_observations', {}, ctx)).data, knowledge.historicalObservations);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'field_experience', {}, ctx)).data, knowledge.teamExperience.entries);
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'readiness', {}, ctx)).data, readiness);
  assert.equal(readiness.status, 'adapter_unavailable');
  assert.equal(readiness.hardwareVerification, 'unverified');
  assert.deepEqual((await runtime.query('camera-owner', pack.manifest.id, 'device_adapters', {}, ctx)).data, []);
  for (const call of calls) assert.ok(call.operationId.startsWith('GET '));
});

test('experiment and AI status reads need explicit real IDs and reject unknown write arguments before dispatch', async t => {
  const { runtime, ctx, calls } = await fixture(t);
  for (const args of [{}, { params: { id: '' } }, { params: { id: 'real-id' }, body: {} }, { params: { id: 'real-id' }, targetId: 'invented' }]) {
    await assert.rejects(runtime.callTool('camera-owner', pack.manifest.id, 'experiment_get', args, ctx), errorCode('plugin_schema_validation_failed'));
  }
  assert.equal(calls.length, 0);
  const experiment = await runtime.callTool('camera-owner', pack.manifest.id, 'experiment_get', { params: { id: 'real-id' } }, ctx);
  assert.deepEqual((experiment.data as { data: unknown }).data, { ok: true, experiment: { id: 'real-id', deviceRuns: [{ state: 'unknown' }] } });
  await assert.rejects(runtime.callTool('camera-owner', pack.manifest.id, 'ai_debug_status', { params: { id: 'real-id' } }, ctx), errorCode('plugin_schema_validation_failed'));
  const status = await runtime.callTool('camera-owner', pack.manifest.id, 'ai_debug_status', { params: { id: 'real-id', runId: 'real-run' } }, ctx);
  assert.deepEqual((status.data as { data: unknown }).data, { ok: true, run: { id: 'real-run', status: 'failed', restore: 'unknown' } });
  await assert.rejects(runtime.callTool('camera-owner', pack.manifest.id, 'vision_capabilities', { url: 'https://example.invalid' }, ctx), errorCode('plugin_schema_validation_failed'));
  await assert.rejects(runtime.callTool('camera-owner', pack.manifest.id, 'vision_capabilities', {}, { ...ctx, canExecutePlatform: () => false }), errorCode('plugin_operation_denied'));
  assert.equal(calls.length, 2);
});

test('assistant instructions keep hardware writes in authorized core tools and preserve evidence boundaries', () => {
  const prompt = pack.manifest.prompts.map(item => item.text).join('\n');
  assert.match(prompt, /没有匹配 adapter.*停止设备执行/);
  assert.match(prompt, /用户授权.*平台核心 vision 工具/);
  assert.match(prompt, /只传实际声明的字段/);
  assert.match(prompt, /deviceRuns.*不自动重试/);
  assert.match(prompt, /UVC 控制不等于 Sensor Bayer RAW 或 X5 原生 ISP/);
  assert.match(prompt, /模型评价不能冒充人工评价/);
  assert.match(prompt, /运行 done.*不代表画质通过/);
  assert.doesNotMatch(prompt, /\b(?:ssh|pkill|bash|eval)\b|sensor_index\s*[:=]\s*\d+/i);
});
