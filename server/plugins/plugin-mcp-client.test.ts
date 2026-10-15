import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { PluginMcpClient, PluginMcpError } from './plugin-mcp-client.js';

type RpcRequest = { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };
const readTool = (name = 'inspect') => ({ name, description: 'Read device evidence', inputSchema: { type: 'object', properties: { device: { type: 'string' } } }, annotations: { readOnlyHint: true } });
type FixtureOptions = {
  response?: (rpc: RpcRequest, req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
  tools?: unknown[];
  version?: string;
  sse?: boolean;
  secret?: string;
};
async function fixture(options: FixtureOptions = {}) {
  const requests: Array<{ rpc?: RpcRequest; method?: string; authorization?: string; version?: string; session?: string }> = [];
  let initializeCount = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const rpc = raw ? JSON.parse(raw) as RpcRequest : undefined;
    requests.push({ rpc, method: req.method, authorization: req.headers.authorization,
      version: req.headers['mcp-protocol-version'] as string | undefined, session: req.headers['mcp-session-id'] as string | undefined });
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (!rpc) { res.writeHead(400).end(); return; }
    if (options.response && await options.response(rpc, req, res)) return;
    let result: unknown;
    if (rpc.method === 'initialize') {
      initializeCount += 1;
      res.setHeader('MCP-Session-Id', `fixture-session-${initializeCount}`);
      result = { protocolVersion: options.version ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: options.tools ?? [readTool(), { ...readTool('mutate'), annotations: { readOnlyHint: false } }] };
    else if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(rpc.params?.arguments) }], structuredContent: { read: true } };
    else { res.writeHead(400).end(); return; }
    if (options.sse && rpc.method !== 'initialize') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\r\n\r\n');
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\r\n\r\n`);
      const output = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\r\n\r\n`;
      // Exercise CRLF and UTF-8/parser chunk boundaries without waiting on timing.
      for (let i = 0; i < output.length; i += 13) res.write(output.slice(i, i + 13));
      res.end();
    } else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = (overrides: ConstructorParameters<typeof PluginMcpClient>[0] = {}) => new PluginMcpClient({ connectors: { device: { url: `http://127.0.0.1:${port}/mcp`, readOnlyTools: ['inspect', 'mutate'], ...(options.secret ? { credentialEnv: 'MCP_FIXTURE_TOKEN' } : {}) } },
    env: options.secret ? { MCP_FIXTURE_TOKEN: options.secret } : {}, ...overrides });
  return { requests, client, url: `http://127.0.0.1:${port}/mcp`, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
const code = (expected: string) => (error: unknown) => error instanceof PluginMcpError && error.code === expected;
function json(res: ServerResponse, rpc: RpcRequest, result: unknown) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); }

test('Streamable HTTP performs initialization, session/version headers, discovery, call and DELETE cleanup', async () => {
  const f = await fixture({ secret: 'fixture-secret-token' });
  const client = f.client();
  try {
    assert.deepEqual(client.listConnectors(), [{ id: 'device', configured: true, readOnlyTools: ['inspect', 'mutate'] }]);
    const tools = await client.discover('device');
    assert.deepEqual(tools.map((tool) => tool.name), ['inspect']);
    const receipt = await client.call('device', 'inspect', { device: 'rdk-x5' });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.isError, false);
    assert.deepEqual(receipt.structuredContent, { read: true });
    assert.deepEqual(f.requests.map((request) => request.rpc?.method ?? request.method), [
      'initialize', 'notifications/initialized', 'tools/list', 'DELETE', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE',
    ]);
    for (const request of f.requests) {
      assert.equal(request.authorization, 'Bearer fixture-secret-token');
      if (request.rpc?.method === 'initialize') assert.equal(request.session, undefined);
      else { assert.match(request.session!, /^fixture-session-\d$/); assert.equal(request.version, '2025-11-25'); }
    }
    assert.equal(JSON.stringify([tools, receipt, client.listConnectors()]).includes('fixture-secret-token'), false);
  } finally { await client.dispose(); await f.close(); }
});

test('SSE notifications and response chunks are parsed without executing server requests', async () => {
  const f = await fixture({ sse: true });
  try { const receipt = await f.client().call('device', 'inspect', { device: '边缘设备' }); assert.equal(receipt.status, 'succeeded'); }
  finally { await f.close(); }
});

test('server allowlist and live readOnlyHint are both required', async () => {
  const f = await fixture();
  const client = f.client();
  try {
    await assert.rejects(() => client.call('device', 'not-allowed', {}), code('tool_not_allowed'));
    assert.equal(f.requests.length, 0);
    await assert.rejects(() => client.call('device', 'mutate', {}), code('tool_not_read_only'));
    assert.equal(f.requests.some((req) => req.rpc?.method === 'tools/call'), false);
    await assert.rejects(() => client.call('device', 'inspect', { bad: undefined }), code('invalid_json'));
  } finally { await client.dispose(); await f.close(); }
});

test('a destructiveHint tool is denied even when its read-only annotation and server allowlist say yes', async () => {
  const f = await fixture({ tools: [{ ...readTool(), annotations: { readOnlyHint: true, destructiveHint: true } }] });
  try { await assert.rejects(() => f.client().call('device', 'inspect', {}), code('tool_not_read_only')); }
  finally { await f.close(); }
});

test('MCP isError=true creates a failed receipt and both text/structured content redact credentials', async () => {
  const secret = 'fixture-secret-token';
  const f = await fixture({ secret, response: (rpc, _req, res) => {
    if (rpc.method !== 'tools/call') return false;
    json(res, rpc, { isError: true, content: [{ type: 'text', text: `Access failed: ${secret}` }], structuredContent: { nested: { token: secret } } }); return true;
  } });
  try {
    const result = await f.client().call('device', 'inspect', {});
    assert.equal(result.status, 'failed'); assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(JSON.stringify(result), /\[redacted\]/);
  } finally { await f.close(); }
});

test('JSON-RPC errors, mismatched ids, unsupported server requests and protocol versions fail closed', async (t) => {
  for (const [label, envelope, expected] of [
    ['id', (rpc: RpcRequest) => ({ jsonrpc: '2.0', id: (rpc.id ?? 0) + 1, result: {} }), 'response_id_mismatch'],
    ['error', (rpc: RpcRequest) => ({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'server-secret-token' } }), 'rpc_error'],
    ['request', () => ({ jsonrpc: '2.0', id: 'request-1', method: 'sampling/createMessage' }), 'unsupported_server_request'],
  ] as const) await t.test(label, async () => {
    const f = await fixture({ response: (rpc, _req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(envelope(rpc))); return true; } });
    try { await assert.rejects(() => f.client().discover('device'), (error: unknown) => code(expected)(error) && !(error as Error).message.includes('server-secret-token')); }
    finally { await f.close(); }
  });
  const f = await fixture({ version: '2026-07-28' });
  try { await assert.rejects(() => f.client().discover('device'), code('unsupported_protocol')); }
  finally { await f.close(); }
});

test('discovery traverses pagination and refuses duplicate/repeated/unbounded lists', async (t) => {
  const f = await fixture({ response: (rpc, _req, res) => {
    if (rpc.method !== 'tools/list') return false;
    json(res, rpc, rpc.params?.cursor ? { tools: [readTool('second')] } : { tools: [readTool()], nextCursor: 'second-page' }); return true;
  } });
  try {
    const client = f.client({ connectors: { device: { url: f.url, readOnlyTools: ['inspect', 'second'] } } });
    assert.deepEqual((await client.discover('device')).map((tool) => tool.name), ['inspect', 'second']);
    assert.equal(f.requests.filter((req) => req.rpc?.method === 'tools/list').length, 2);
  } finally { await f.close(); }
  for (const [label, makeResult, expected] of [
    ['repeat cursor', () => ({ tools: [], nextCursor: 'repeat' }), 'invalid_pagination'],
    ['duplicate', () => ({ tools: [readTool(), readTool()] }), 'invalid_response'],
    ['tools bound', () => ({ tools: Array.from({ length: 257 }, (_, n) => readTool(`tool-${n}`)) }), 'too_many_tools'],
    ['pages bound', (rpc: RpcRequest) => ({ tools: [], nextCursor: `page-${rpc.id}` }), 'too_many_pages'],
  ] as const) await t.test(label, async () => {
    const tooMany = await fixture({ response: (rpc, _req, res) => {
      if (rpc.method !== 'tools/list') return false; json(res, rpc, makeResult(rpc)); return true;
    } });
    try { await assert.rejects(() => tooMany.client().discover('device'), code(expected)); }
    finally { await tooMany.close(); }
  });
});

test('expired sessions reinitialize exactly once and continue with the new session', async () => {
  let expired = false;
  const f = await fixture({ response: (rpc, _req, res) => {
    if (rpc.method === 'tools/list' && !expired) { expired = true; res.writeHead(404).end(); return true; } return false;
  } });
  try {
    assert.equal((await f.client().discover('device')).length, 1);
    assert.equal(f.requests.filter((req) => req.rpc?.method === 'initialize').length, 2);
    assert.equal(f.requests.filter((req) => req.rpc?.method === 'tools/list').at(-1)?.session, 'fixture-session-2');
  } finally { await f.close(); }
});

test('timeout, AbortSignal and client disposal bound work and prevent further calls', async (t) => {
  for (const mode of ['timeout', 'abort', 'dispose', 'pre-abort'] as const) await t.test(mode, async () => {
    const f = await fixture({ response: () => true });
    const client = f.client({ timeoutMs: mode === 'timeout' ? 40 : 1000 });
    const abort = new AbortController();
    if (mode === 'pre-abort') abort.abort();
    const pending = client.discover('device', abort.signal);
    if (mode === 'abort') setTimeout(() => abort.abort(), 20);
    if (mode === 'dispose') setTimeout(() => { void client.dispose(); }, 20);
    try {
      await assert.rejects(() => pending, code(mode === 'timeout' ? 'timeout' : 'aborted'));
      if (mode === 'pre-abort') assert.equal(f.requests.length, 0);
      await client.dispose();
      await assert.rejects(() => client.discover('device'), code('disposed'));
    } finally { await f.close(); }
  });
});

test('oversized JSON and SSE responses are cancelled at the byte limit', async (t) => {
  for (const sse of [false, true]) await t.test(sse ? 'SSE' : 'JSON', async () => {
    const f = await fixture({ response: (_rpc, _req, res) => {
      res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
      res.end('x'.repeat(1024 * 1024 + 1)); return true;
    } });
    try { await assert.rejects(() => f.client().discover('device'), code('response_too_large')); }
    finally { await f.close(); }
  });
});

test('redirects are rejected without sending credentials to the redirected endpoint', async () => {
  let reached = 0;
  const target = await fixture({ response: () => { reached += 1; return true; } });
  const source = await fixture({ secret: 'redirect-secret', response: (_rpc, _req, res) => { res.writeHead(307, { location: target.url }).end(); return true; } });
  try { await assert.rejects(() => source.client().discover('device'), code('redirect_rejected')); assert.equal(reached, 0); }
  finally { await source.close(); await target.close(); }
});

test('only trusted server configuration can supply destinations and environment credential references', async () => {
  for (const url of ['http://example.com/mcp', 'http://127.attacker.example/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=x', 'https://example.com/mcp#fragment', 'https://10.0.0.1/mcp', 'file:///tmp/mcp', 'https://[::ffff:127.0.0.1]/mcp']) {
    assert.throws(() => new PluginMcpClient({ connectors: { test: { url, readOnlyTools: [] } } }), PluginMcpError);
  }
  assert.throws(() => new PluginMcpClient({ env: { RDK_PLUGIN_MCP_CONNECTORS: 'secret-not-json' } }), (error: unknown) => error instanceof PluginMcpError && !error.message.includes('secret-not-json'));
  assert.throws(() => new PluginMcpClient({ connectors: { test: { url: 'https://example.com/mcp', readOnlyTools: [], headers: { authorization: 'secret' } } } as never }), code('invalid_connector'));
  const client = new PluginMcpClient({ env: { RDK_PLUGIN_MCP_CONNECTORS: JSON.stringify({ local: { url: 'http://localhost:1/mcp', credentialEnv: 'MISSING', readOnlyTools: ['inspect'] } }) } });
  assert.deepEqual(client.listConnectors(), [{ id: 'local', configured: false, readOnlyTools: ['inspect'] }]);
  await assert.rejects(() => client.discover('local'), code('credential_unavailable'));
  assert.doesNotThrow(() => new PluginMcpClient({ env: { RDK_PLUGIN_MCP_PRIVATE_HOSTS: '10.0.0.1' }, connectors: { internal: { url: 'https://10.0.0.1/mcp', readOnlyTools: [] } } }));
});

test('remote JSON schemas cannot request external references', async () => {
  const f = await fixture({ tools: [{ ...readTool(), inputSchema: { type: 'object', properties: { token: { $ref: 'https://attacker.invalid/schema' } } } }] });
  try { await assert.rejects(() => f.client().discover('device'), code('invalid_response')); }
  finally { await f.close(); }
});
