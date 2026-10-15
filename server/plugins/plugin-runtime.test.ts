import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginError, PluginRuntime, validatePluginPackage } from './plugin-runtime.js';
import { BUILTIN_PLUGIN_TEMPLATES } from './plugin-builtins.js';
import type { PluginExecutionContext, PluginManifest } from './plugin-types.js';

const operationId = 'GET /api/ops/observability/devices';
function manifest(id = 'third-party', version = '1.0.0'): PluginManifest {
  return validatePluginPackage({ schemaVersion: 1, id, version, label: '第三方诊断', description: '独立声明式包', dependencies: [],
    configSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['limit'], additionalProperties: false },
    tools: [{ id: 'devices', description: '读取设备', source: { type: 'platform', operationId }, inputSchema: {
      type: 'object', properties: { query: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } }, additionalProperties: false,
    }, defaults: { query: { limit: '${config.limit}' } } }],
    dataSources: [{ id: 'devices', toolId: 'devices', resultPath: 'data.devices' }],
    panels: [{ id: 'devices', title: '设备', dataSourceId: 'devices', kind: 'table' }],
    workflows: [{ id: 'diagnose', title: '诊断', steps: [{ toolId: 'devices', label: '采集设备' }, { toolId: 'devices', args: { query: { limit: 1 } } }] }],
    prompts: [{ id: 'guide', text: '依据真实数据诊断。' }],
  }, { limit: 2 }).manifest;
}
const errorCode = (code: string) => (error: unknown) => error instanceof PluginError && error.code === code;
async function fixture(t: TestContext) {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), 'd-obs-plugins-'));
  const runtime = new PluginRuntime({ stateDir, builtins: BUILTIN_PLUGIN_TEMPLATES });
  t.after(async () => { runtime.dispose(); await fs.rm(stateDir, { recursive: true, force: true }); });
  const calls: unknown[] = [];
  const ctx: PluginExecutionContext = { canExecutePlatform: (id) => id === operationId,
    executePlatform: async (id, args) => { calls.push({ id, args }); return { ok: true, status: 200, data: { devices: [{ deviceId: 'rdk-x5', online: true }] } }; } };
  const install = async (id = 'third-party', version = '1.0.0') => {
    const draft = await runtime.saveDraft('alice', { manifest: manifest(id, version), config: { limit: 2 } });
    return runtime.publish('alice', id, { expectedRevision: draft.revision }, ctx);
  };
  return { runtime, stateDir, calls, ctx, install };
}

test('third-party manifest executes real adapters, data source and sequential workflow without core changes', async (t) => {
  const { runtime, calls, ctx, install } = await fixture(t); const published = await install();
  assert.equal(published.enabled, true); assert.equal(published.draft, null);
  const query = await runtime.query('alice', 'third-party', 'devices', {}, ctx);
  assert.deepEqual(query.data, [{ deviceId: 'rdk-x5', online: true }]); assert.ok(query.receipt.id); assert.equal(query.version, '1.0.0');
  const workflow = await runtime.runWorkflow('alice', 'third-party', 'diagnose', {}, ctx);
  assert.equal(workflow.steps.length, 2); assert.equal(workflow.steps[0].label, '采集设备'); assert.ok(workflow.receipt.id);
  assert.deepEqual(calls, [{ id: operationId, args: { query: { limit: 2 } } }, { id: operationId, args: { query: { limit: 2 } } }, { id: operationId, args: { query: { limit: 1 } } }]);
});

test('owners cannot read, mutate or execute another owner’s installed plugin', async (t) => {
  const { runtime, ctx, install } = await fixture(t); await install();
  assert.deepEqual((await runtime.catalog('bob')).plugins, []);
  await assert.rejects(runtime.detail('bob', 'third-party'), errorCode('plugin_not_found'));
  await assert.rejects(runtime.callTool('bob', 'third-party', 'devices', {}, ctx), errorCode('plugin_not_found'));
  const own = await runtime.saveDraft('bob', { manifest: manifest(), config: { limit: 1 } }); assert.equal(own.revision, 1);
  assert.equal((await runtime.detail('alice', 'third-party')).revision, 2);
});

test('draft isolation, immutable publication, CAS and rollback preserve active content', async (t) => {
  const { runtime, ctx, install, calls } = await fixture(t); let detail = await install();
  await assert.rejects(runtime.setEnabled('alice', detail.id, { enabled: false, expectedRevision: 1 }), errorCode('plugin_revision_conflict'));
  detail = await runtime.saveDraft('alice', { manifest: manifest(), config: { limit: 4 }, expectedRevision: detail.revision });
  await runtime.query('alice', detail.id, 'devices', {}, ctx); assert.deepEqual(calls[0], { id: operationId, args: { query: { limit: 2 } } });
  await assert.rejects(runtime.publish('alice', detail.id, { expectedRevision: detail.revision }), errorCode('plugin_version_exists'));
  assert.equal((await runtime.detail('alice', detail.id)).published!.config.limit, 2);
  detail = await runtime.saveDraft('alice', { manifest: manifest('third-party', '1.1.0'), config: { limit: 4 }, expectedRevision: detail.revision });
  detail = await runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx); assert.equal(detail.history.length, 2);
  detail = await runtime.rollback('alice', detail.id, { version: '1.0.0', expectedRevision: detail.revision }); assert.equal(detail.published!.config.limit, 2);
  detail = await runtime.setEnabled('alice', detail.id, { enabled: false, expectedRevision: detail.revision });
  await assert.rejects(runtime.query('alice', detail.id, 'devices', {}, ctx), errorCode('plugin_disabled'));
  await runtime.uninstall('alice', detail.id, { expectedRevision: detail.revision });
  assert.deepEqual((await runtime.catalog('alice')).events.map((entry) => entry.action), ['draft_saved', 'published', 'draft_saved', 'draft_saved', 'published', 'rolled_back', 'disabled', 'uninstalled']);
});

test('same-version object key reordering preserves the original publication and remains readable after restart', async (t) => {
  const { runtime, stateDir, ctx } = await fixture(t);
  const pack = manifest();
  pack.configSchema = { type: 'object', properties: {
    limit: { type: 'integer', minimum: 1, maximum: 10 },
    settings: { type: 'object', properties: { mode: { type: 'string', enum: ['safe', 'diagnostic'] }, window: { type: 'integer', minimum: 1 } },
      required: ['mode', 'window'], additionalProperties: false },
  }, required: ['limit', 'settings'], additionalProperties: false };
  const config = { limit: 2, settings: { mode: 'safe', window: 4 } };
  const reverseObjectKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseObjectKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)])) : value;
  let detail = await runtime.saveDraft('alice', { manifest: pack, config });
  detail = await runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx);
  const originalPublication = JSON.stringify(detail.published);
  const originalHistory = JSON.stringify(detail.history);
  detail = await runtime.saveDraft('alice', { manifest: reverseObjectKeys(pack), config: reverseObjectKeys(config), expectedRevision: detail.revision });
  assert.deepEqual(Object.keys(detail.draft!.config), ['settings', 'limit']);
  assert.deepEqual(Object.keys(detail.draft!.manifest.configSchema.properties!), ['settings', 'limit']);
  assert.deepEqual(Object.keys(detail.draft!.manifest.configSchema.properties!.settings.properties!), ['window', 'mode']);
  detail = await runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx);
  assert.equal(detail.draft, null);
  assert.equal(detail.history.length, 1);
  assert.equal(JSON.stringify(detail.published), originalPublication);
  assert.equal(JSON.stringify(detail.history), originalHistory);
  const restored = new PluginRuntime({ stateDir }); t.after(() => restored.dispose());
  assert.deepEqual(await restored.detail('alice', detail.id), detail);
  assert.deepEqual((await restored.query('alice', detail.id, 'devices', {}, ctx)).data, [{ deviceId: 'rdk-x5', online: true }]);
});

test('same-version numeric configuration changes still fail without changing published content or revision', async (t) => {
  const { runtime, ctx, install } = await fixture(t);
  let detail = await install(); const originalPublication = JSON.stringify(detail.published); const originalHistory = JSON.stringify(detail.history);
  detail = await runtime.saveDraft('alice', { manifest: manifest(), config: { limit: 3 }, expectedRevision: detail.revision });
  await assert.rejects(runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx), errorCode('plugin_version_exists'));
  const current = await runtime.detail('alice', detail.id);
  assert.equal(current.revision, detail.revision);
  assert.equal(JSON.stringify(current.published), originalPublication);
  assert.equal(JSON.stringify(current.history), originalHistory);
  assert.equal(current.draft!.config.limit, 3);
});

test('same-version workflow step array reordering remains a content change', async (t) => {
  const { runtime, ctx, install } = await fixture(t);
  let detail = await install(); const originalHistory = JSON.stringify(detail.history); const changed = manifest();
  changed.workflows[0].steps.reverse();
  detail = await runtime.saveDraft('alice', { manifest: changed, config: { limit: 2 }, expectedRevision: detail.revision });
  await assert.rejects(runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx), errorCode('plugin_version_exists'));
  assert.equal(JSON.stringify((await runtime.detail('alice', detail.id)).history), originalHistory);
});

test('same-version schema enum array reordering remains a content change', async (t) => {
  const { runtime, ctx } = await fixture(t);
  const pack = manifest(); pack.configSchema.properties!.limit.enum = [1, 2, 3];
  let detail = await runtime.saveDraft('alice', { manifest: pack, config: { limit: 2 } });
  detail = await runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx);
  const originalHistory = JSON.stringify(detail.history);
  pack.configSchema.properties!.limit.enum.reverse();
  detail = await runtime.saveDraft('alice', { manifest: pack, config: { limit: 2 }, expectedRevision: detail.revision });
  await assert.rejects(runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx), errorCode('plugin_version_exists'));
  assert.equal(JSON.stringify((await runtime.detail('alice', detail.id)).history), originalHistory);
});

test('rejects unsupported manifests, writes, invalid references, schemas and polluted JSON', async (t) => {
  const { runtime } = await fixture(t);
  const pack = manifest(); pack.tools[0].source = { type: 'platform', operationId: 'POST /api/ops/observability/devices' };
  await assert.rejects(runtime.saveDraft('alice', { manifest: pack, config: { limit: 2 } }), errorCode('plugin_write_tool_denied'));
  const missing = manifest(); missing.dataSources[0].toolId = 'missing';
  await assert.rejects(runtime.saveDraft('alice', { manifest: missing, config: { limit: 2 } }), errorCode('plugin_unknown_tool'));
  const bad = manifest(); (bad.configSchema as unknown as Record<string, unknown>).$ref = 'https://evil.invalid/schema';
  await assert.rejects(runtime.saveDraft('alice', { manifest: bad, config: { limit: 2 } }), errorCode('plugin_invalid_schema'));
  await assert.rejects(runtime.saveDraft('alice', { manifest: manifest(), config: { limit: 999 } }), errorCode('plugin_schema_validation_failed'));
  await assert.rejects(runtime.saveDraft('alice', { manifest: manifest(), config: JSON.parse('{"__proto__":{"admin":true}}') }), errorCode('plugin_unsafe_key'));
});

test('dependency missing, version conflicts and cycles fail atomically without changing live generations', async (t) => {
  const { runtime, install, ctx } = await fixture(t);
  const pack = manifest('dependent'); pack.dependencies = [{ id: 'dependency', version: '1.0.0' }];
  let draft = await runtime.saveDraft('alice', { manifest: pack, config: { limit: 2 } });
  await assert.rejects(runtime.publish('alice', pack.id, { expectedRevision: draft.revision }, ctx), errorCode('plugin_dependency_missing'));
  let dependency = await install('dependency'); draft = await runtime.publish('alice', pack.id, { expectedRevision: draft.revision }, ctx);
  await assert.rejects(runtime.setEnabled('alice', dependency.id, { enabled: false, expectedRevision: dependency.revision }), errorCode('plugin_dependency_missing'));
  const upgrade = manifest('dependency', '1.1.0'); dependency = await runtime.saveDraft('alice', { manifest: upgrade, config: { limit: 2 }, expectedRevision: dependency.revision });
  await assert.rejects(runtime.publish('alice', dependency.id, { expectedRevision: dependency.revision }, ctx), errorCode('plugin_dependency_version_conflict'));
  const cyclic = manifest('dependency'); cyclic.dependencies = [{ id: 'dependent', version: '1.0.0' }];
  // An unpublished cycle cannot replace an immutable existing version either.
  dependency = await runtime.saveDraft('alice', { manifest: cyclic, config: { limit: 2 }, expectedRevision: dependency.revision });
  await assert.rejects(runtime.validate('alice', dependency.id, ctx), errorCode('plugin_dependency_cycle'));
  assert.equal((await runtime.detail('alice', dependency.id)).published!.manifest.version, '1.0.0');
});

test('restart recovers immutable versions; damaged or missing state never resets to empty', async (t) => {
  const { runtime, stateDir, install } = await fixture(t); const original = await install();
  const restored = new PluginRuntime({ stateDir }); t.after(() => restored.dispose());
  assert.deepEqual(await restored.detail('alice', original.id), original);
  const directory = path.join(stateDir, createHash('sha256').update('alice').digest('hex'));
  assert.equal((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777, 0o600);
  const previous = await fs.readFile(path.join(directory, 'state.previous.json'), 'utf8');
  await fs.writeFile(path.join(directory, 'state.json'), '{"schemaVersion":1}');
  await assert.rejects(restored.catalog('alice'), errorCode('plugin_state_corrupt'));
  await assert.rejects(runtime.saveDraft('alice', { manifest: manifest('another'), config: { limit: 2 } }), errorCode('plugin_state_corrupt'));
  assert.equal(await fs.readFile(path.join(directory, 'state.previous.json'), 'utf8'), previous);
  await fs.rm(path.join(directory, 'state.json'));
  await assert.rejects(restored.catalog('alice'), errorCode('plugin_state_corrupt'));
});

test('separate hosts serialize revisions and reject stale concurrent saves', async (t) => {
  const { runtime, stateDir, install } = await fixture(t); const detail = await install(); const other = new PluginRuntime({ stateDir }); t.after(() => other.dispose());
  const result = await Promise.allSettled([runtime.saveDraft('alice', { manifest: manifest('third-party', '1.1.0'), config: { limit: 3 }, expectedRevision: detail.revision }),
    other.saveDraft('alice', { manifest: manifest('third-party', '1.2.0'), config: { limit: 4 }, expectedRevision: detail.revision })]);
  assert.equal(result.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = result.find((entry) => entry.status === 'rejected') as PromiseRejectedResult; assert.ok(errorCode('plugin_revision_conflict')(rejected.reason));
  assert.equal((await other.detail('alice', detail.id)).revision, detail.revision + 1);
});

test('timeout and disable abort adapters, release registries and stop subsequent workflow steps', async (t) => {
  const { runtime, install, ctx } = await fixture(t); let detail = await install(); let aborted = 0; let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const blocked: PluginExecutionContext = { ...ctx, timeoutMs: 1000, executePlatform: async (_id, _args, signal) => {
    started(); return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  } };
  const pending = runtime.runWorkflow('alice', detail.id, 'diagnose', {}, blocked); const rejected = assert.rejects(pending, errorCode('plugin_execution_interrupted'));
  await startedPromise; detail = await runtime.setEnabled('alice', detail.id, { enabled: false, expectedRevision: detail.revision }); await rejected; assert.equal(aborted, 1);
  detail = await runtime.setEnabled('alice', detail.id, { enabled: true, expectedRevision: detail.revision });
  await assert.rejects(runtime.callTool('alice', detail.id, 'devices', {}, { ...blocked, timeoutMs: 50 }), errorCode('plugin_execution_timeout'));
  assert.equal(aborted, 2);
});

test('disable queued during execution snapshot aborts before any stale adapter can complete', async (t) => {
  const { runtime, install, ctx } = await fixture(t); const detail = await install(); let aborted = false;
  const internal = runtime as unknown as { read: (owner: string) => Promise<unknown> };
  const originalRead = internal.read.bind(runtime); let paused = false; let snapshotReady!: () => void; let releaseSnapshot!: () => void;
  const ready = new Promise<void>((resolve) => { snapshotReady = resolve; }); const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  internal.read = async (owner) => { const state = await originalRead(owner); if (!paused) { paused = true; snapshotReady(); await release; } return state; };
  const running = runtime.callTool('alice', detail.id, 'devices', {}, { ...ctx, executePlatform: async (_id, _args, signal) => {
    return new Promise((resolve, reject) => { const timer = setTimeout(() => resolve({ ok: true, data: [] }), 1000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  } });
  const rejected = assert.rejects(running, (error) => errorCode('plugin_execution_interrupted')(error) || errorCode('plugin_disabled')(error));
  await ready; const disable = runtime.setEnabled('alice', detail.id, { enabled: false, expectedRevision: detail.revision });
  await new Promise((resolve) => setTimeout(resolve, 30)); releaseSnapshot(); await disable; await rejected;
  assert.equal(aborted, true);
});

test('null configuration references are valid and inherited field names cannot bypass schema', async (t) => {
  const { runtime, ctx } = await fixture(t); const pack = manifest();
  pack.configSchema = { type: 'object', properties: { filter: { type: 'null' } }, required: ['filter'], additionalProperties: false };
  pack.tools[0].inputSchema = { type: 'object', properties: { filter: { type: 'null' } }, required: ['filter'], additionalProperties: false };
  pack.tools[0].defaults = { filter: '${config.filter}' }; pack.workflows = [];
  let detail = await runtime.saveDraft('alice', { manifest: pack, config: { filter: null } }); detail = await runtime.publish('alice', detail.id, { expectedRevision: detail.revision }, ctx);
  let received: unknown; await runtime.callTool('alice', detail.id, 'devices', {}, { ...ctx, executePlatform: async (_id, args) => { received = args; return { ok: true, data: null }; } });
  assert.deepEqual(received, { filter: null });
  await assert.rejects(runtime.callTool('alice', detail.id, 'devices', { toString: 'override' }, ctx), errorCode('plugin_schema_validation_failed'));
});

test('publication and execution require currently authorized platform and read-only MCP adapters', async (t) => {
  const { runtime, ctx } = await fixture(t); let draft = await runtime.saveDraft('alice', { manifest: manifest(), config: { limit: 2 } });
  await assert.rejects(runtime.publish('alice', draft.id, { expectedRevision: draft.revision }, { ...ctx, canExecutePlatform: () => false }), errorCode('plugin_operation_denied'));
  const pack = manifest(); pack.tools[0].source = { type: 'mcp', connectorId: 'external', toolName: 'search' };
  draft = await runtime.saveDraft('alice', { manifest: pack, config: { limit: 2 }, expectedRevision: draft.revision });
  await assert.rejects(runtime.publish('alice', draft.id, { expectedRevision: draft.revision }, ctx), errorCode('plugin_mcp_tool_denied'));
  const mcpContext: PluginExecutionContext = { ...ctx, canExecuteMcp: (connector, tool) => connector === 'external' && tool === 'search',
    executeMcp: async () => ({ ok: true, data: { devices: [{ deviceId: 'external-rdk' }] } }) };
  await runtime.publish('alice', draft.id, { expectedRevision: draft.revision }, mcpContext);
  assert.deepEqual((await runtime.query('alice', draft.id, 'devices', {}, mcpContext)).data, [{ deviceId: 'external-rdk' }]);
  await assert.rejects(runtime.query('alice', draft.id, 'devices', {}, ctx), errorCode('plugin_mcp_tool_denied'));
});

test('adapter failure cannot produce a successful execution receipt and builtins stay uninstalled', async (t) => {
  const { runtime, install, ctx } = await fixture(t); const catalog = await runtime.catalog('alice');
  assert.equal(catalog.plugins.length, 0); assert.equal(catalog.templates.length, 3); assert.ok(catalog.templates.some(template => template.manifest.id === 'camera-workshop')); await install();
  await assert.rejects(runtime.callTool('alice', 'third-party', 'devices', {}, { ...ctx, executePlatform: async () => ({ ok: false, status: 503, data: { error: 'database_unavailable' } }) }), errorCode('plugin_adapter_failed'));
  runtime.dispose(); await assert.rejects(runtime.catalog('alice'), errorCode('plugin_runtime_disposed'));
});

test('inline credentials are rejected while ordinary log text and token budget fields remain editable', async (t) => {
  const { runtime } = await fixture(t); const pack = manifest();
  pack.configSchema = { type: 'object', properties: { apiKey: { type: 'string' } }, additionalProperties: false };
  await assert.rejects(runtime.saveDraft('alice', { manifest: pack, config: { apiKey: 'credential' } }), errorCode('plugin_inline_credential_denied'));
  const valid = manifest(); valid.configSchema = { type: 'object', properties: { maxTokens: { type: 'integer' }, query: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false };
  const saved = await runtime.saveDraft('alice', { manifest: valid, config: { limit: 2, maxTokens: 1024, query: 'message contains password rejected' } });
  assert.equal(saved.draft!.config.maxTokens, 1024);
});

test('external host disable interrupts active reads and a dead host lock can be recovered', async (t) => {
  const { runtime, stateDir, install, ctx } = await fixture(t); let detail = await install();
  const external = new PluginRuntime({ stateDir }); t.after(() => external.dispose()); let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }); let aborted = false;
  const read = runtime.callTool('alice', detail.id, 'devices', {}, { ...ctx, executePlatform: async (_id, _args, signal) => {
    entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
  } }); const rejected = assert.rejects(read, errorCode('plugin_execution_interrupted'));
  await started; detail = await external.setEnabled('alice', detail.id, { enabled: false, expectedRevision: detail.revision }); await rejected; assert.equal(aborted, true);
  const directory = path.join(stateDir, createHash('sha256').update('alice').digest('hex'), '.lock');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'holder.json'), JSON.stringify({ pid: 2147483647, at: Date.now() - 60_000 }));
  detail = await runtime.setEnabled('alice', detail.id, { enabled: true, expectedRevision: detail.revision }); assert.equal(detail.enabled, true);
});

test('a mistaken result path fails explicitly instead of hiding data behind an empty successful result', async (t) => {
  const { runtime, install, ctx } = await fixture(t); await install();
  await assert.rejects(runtime.query('alice', 'third-party', 'devices', {}, { ...ctx, executePlatform: async () => ({ ok: true, data: { renamed: [] } }) }), errorCode('plugin_result_path_missing'));
});
