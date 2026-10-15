/** The external connector exercises the real HTTP transport and declarative host together. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginMcpClient } from './plugin-mcp-client.js';
import { PluginRuntime } from './plugin-runtime.js';
import { PluginError, type PluginExecutionContext } from './plugin-types.js';

const TOOL_NAME = 'rdk:inspect';
const TOKEN = 'mcp-integration-server-only-secret';
const manifest = {
  schemaVersion: 1, id: 'external-rdk-evidence', version: '1.0.0', label: 'External RDK evidence',
  description: 'A separately supplied declarative package backed by a server-configured MCP connector.',
  configSchema: { type: 'object', properties: { deviceId: { type: 'string', minLength: 1 } }, required: ['deviceId'], additionalProperties: false },
  tools: [{ id: 'inspect-device', description: 'Read RDK device evidence',
    inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'], additionalProperties: false },
    source: { type: 'mcp', connectorId: 'fixture', toolName: TOOL_NAME }, defaults: { device: '${config.deviceId}' } }],
  dataSources: [{ id: 'device', toolId: 'inspect-device', resultPath: 'device' }],
  panels: [{ id: 'device-temperature', title: 'Temperature', dataSourceId: 'device', kind: 'stat', valuePath: 'temperature', unit: '°C' }],
  workflows: [{ id: 'evidence-review', title: 'Read and verify device evidence', steps: [
    { toolId: 'inspect-device', label: 'Initial evidence' }, { toolId: 'inspect-device', label: 'Verification evidence' },
  ] }],
  prompts: [{ id: 'review-guide', text: 'Use the returned device evidence and receipt to explain the state.' }],
};

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), 'd-obs-plugin-mcp-integration-'));
  const seen: Array<{ method?: string; rpcMethod?: string; session?: string; version?: string; auth?: string; arguments?: unknown }> = [];
  let holdCall = false;
  let sequence = 0;
  let callArrived: (() => void) | undefined;
  let callDisconnected: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { callArrived = resolve; });
  const disconnected = new Promise<void>((resolve) => { callDisconnected = resolve; });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const rpc = raw ? JSON.parse(raw) as { id: number; method: string; params: { arguments?: unknown } } : undefined;
    seen.push({ method: req.method, rpcMethod: rpc?.method, session: req.headers['mcp-session-id'] as string | undefined,
      version: req.headers['mcp-protocol-version'] as string | undefined, auth: req.headers.authorization, arguments: rpc?.params?.arguments });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (!rpc) { res.writeHead(400).end(); return; }
    let result: unknown;
    if (rpc.method === 'initialize') {
      sequence += 1; res.setHeader('MCP-Session-Id', `integration-session-${sequence}`);
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'real-http-fixture', version: '1' } };
    } else if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: [{ name: TOOL_NAME, description: 'Read device evidence', annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] } }] };
    else if (rpc.method === 'tools/call') {
      if (holdCall) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
        res.once('close', () => callDisconnected?.()); callArrived?.(); return;
      }
      const args = rpc.params.arguments as { device: string };
      result = { content: [{ type: 'text', text: `${args.device} evidence` }], structuredContent: { device: { id: args.device, online: true, temperature: 42.5 }, credentialEcho: TOKEN } };
    } else { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = new PluginMcpClient({ env: { FIXTURE_TOKEN: TOKEN, RDK_PLUGIN_MCP_CONNECTORS: JSON.stringify({
    fixture: { url: `http://127.0.0.1:${port}/mcp`, credentialEnv: 'FIXTURE_TOKEN', readOnlyTools: [TOOL_NAME] },
  }) } });
  const runtime = new PluginRuntime({ stateDir });
  const context: PluginExecutionContext = {
    canExecutePlatform: () => false,
    executePlatform: async () => { throw new Error('unexpected_platform_execution'); },
    canExecuteMcp: (connectorId, toolName) => client.listConnectors().some((connector) => connector.id === connectorId && connector.readOnlyTools.includes(toolName)),
    executeMcp: async (connectorId, toolName, args, signal) => {
      const receipt = await client.call(connectorId, toolName, args, signal);
      if (receipt.isError) throw new PluginError('plugin_mcp_tool_failed', 502);
      return receipt.structuredContent ?? receipt.content;
    }, timeoutMs: 5000,
  };
  return { runtime, client, context, seen, stateDir, arrived, disconnected, hold() { holdCall = true; }, async close() {
    runtime.dispose(); await client.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(stateDir, { recursive: true, force: true });
  } };
}
async function bounded(promise: Promise<unknown>, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture_timeout')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

test('a separately supplied package publishes, queries, runs a workflow and rolls back through real HTTP MCP', async () => {
  const f = await setup();
  try {
    const draft = await f.runtime.saveDraft('sso:alice', { manifest, config: { deviceId: 'rdk-x5' } });
    const published = await f.runtime.publish('sso:alice', manifest.id, { expectedRevision: draft.revision });
    const result = await f.runtime.query('sso:alice', manifest.id, 'device', {}, f.context);
    assert.deepEqual(result.data, { id: 'rdk-x5', online: true, temperature: 42.5 });
    assert.equal(result.version, '1.0.0'); assert.match(result.receipt.id, /^[0-9a-f-]{36}$/);
    const workflow = await f.runtime.runWorkflow('sso:alice', manifest.id, 'evidence-review', {}, f.context);
    assert.equal(workflow.steps.length, 2);
    assert.deepEqual(workflow.steps.map((step) => (step.data as { device: { id: string } }).device.id), ['rdk-x5', 'rdk-x5']);
    assert.equal(JSON.stringify(workflow).includes(TOKEN), false);
    assert.match(JSON.stringify(workflow), /\[redacted\]/);
    assert.equal(f.seen.filter((entry) => entry.rpcMethod === 'tools/call').length, 3);
    for (const entry of f.seen) {
      assert.equal(entry.auth, `Bearer ${TOKEN}`);
      if (entry.rpcMethod !== 'initialize') { assert.match(entry.session!, /^integration-session-/); assert.equal(entry.version, '2025-11-25'); }
    }
    await assert.rejects(() => f.runtime.query('sso:bob', manifest.id, 'device', {}, f.context), (error: unknown) => error instanceof PluginError && error.code === 'plugin_not_found');
    const changed = await f.runtime.saveDraft('sso:alice', { manifest: { ...manifest, version: '1.1.0' }, config: { deviceId: 'rdk-s600' }, expectedRevision: published.revision });
    const next = await f.runtime.publish('sso:alice', manifest.id, { expectedRevision: changed.revision });
    assert.equal((await f.runtime.query('sso:alice', manifest.id, 'device', {}, f.context)).version, '1.1.0');
    const old = await f.runtime.rollback('sso:alice', manifest.id, { expectedRevision: next.revision, version: '1.0.0' });
    assert.equal(old.published?.config.deviceId, 'rdk-x5');
    assert.deepEqual((await f.runtime.query('sso:alice', manifest.id, 'device', {}, f.context)).data, { id: 'rdk-x5', online: true, temperature: 42.5 });
    const reloaded = new PluginRuntime({ stateDir: f.stateDir });
    assert.equal((await reloaded.detail('sso:alice', manifest.id)).revision, old.revision); reloaded.dispose();
  } finally { await f.close(); }
});

test('disabling an external plugin cancels the real MCP stream and prevents new executions', async () => {
  const f = await setup();
  try {
    const draft = await f.runtime.saveDraft('sso:alice', { manifest, config: { deviceId: 'rdk-x5' } });
    const published = await f.runtime.publish('sso:alice', manifest.id, { expectedRevision: draft.revision });
    f.hold();
    const pending = f.runtime.query('sso:alice', manifest.id, 'device', {}, f.context);
    const outcome = pending.then(() => null, (error: unknown) => error);
    await bounded(f.arrived);
    await f.runtime.setEnabled('sso:alice', manifest.id, { enabled: false, expectedRevision: published.revision });
    const interrupted = await outcome;
    assert.ok(interrupted instanceof PluginError); assert.equal(interrupted.code, 'plugin_execution_interrupted');
    await bounded(f.disconnected);
    const count = f.seen.filter((entry) => entry.rpcMethod === 'tools/call').length;
    await assert.rejects(() => f.runtime.query('sso:alice', manifest.id, 'device', {}, f.context), (error: unknown) => error instanceof PluginError && error.code === 'plugin_disabled');
    assert.equal(f.seen.filter((entry) => entry.rpcMethod === 'tools/call').length, count);
  } finally { await f.close(); }
});

test('revoked server read-only permission fails before an external MCP call', async () => {
  const f = await setup();
  try {
    const draft = await f.runtime.saveDraft('sso:alice', { manifest, config: { deviceId: 'rdk-x5' } });
    await f.runtime.publish('sso:alice', manifest.id, { expectedRevision: draft.revision });
    await assert.rejects(() => f.runtime.query('sso:alice', manifest.id, 'device', {}, { ...f.context, canExecuteMcp: () => false }),
      (error: unknown) => error instanceof PluginError && error.code === 'plugin_mcp_tool_denied');
    assert.equal(f.seen.length, 0);
  } finally { await f.close(); }
});
