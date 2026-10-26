import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from './bridge.mjs';

const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
test('stdio bridge negotiates the MCP version used by older Studio clients', async () => {
  const { responses } = await run([rpc(1, 'initialize', { protocolVersion: '2024-11-05' })], '/missing-camera-bridge-config');
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
});
const endpoint = '/dobs/api/ops/vision-workshop/mcp';
const secret = 'fixture-camera-private-credential-never-printed';
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const tool = name => ({ name, description: 'Fixture reviewed tool', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
const reply = (response, message, result) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };

async function withFixture(handler, body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'camera-mcp-bridge-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let message; try { message = JSON.parse(Buffer.concat(chunks).toString()); } catch { message = null; }
    requests.push({ url: request.url, headers: request.headers, message });
    try { await handler(request, response, message); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + endpoint;
  const credentialFile = path.join(directory, 'credential.txt');
  const configFile = path.join(directory, 'connection.json');
  await writeFile(credentialFile, '  ' + secret + '\n', { mode: 0o600 });
  const saveConfig = async (patch = {}, mode = 0o600) => {
    await writeFile(configFile, JSON.stringify({ url, auth: { type: 'admin', credentialFile }, ...patch }), { mode });
    await chmod(configFile, mode); return configFile;
  };
  await saveConfig();
  try { await body({ url, directory, requests, credentialFile, configFile, saveConfig }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
}
async function run(messages, configFile, timeoutMs = 10_000) {
  const child = spawn(process.execPath, [bridge], { env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: configFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stdin.on('error', () => {});
  child.stdin.end(typeof messages === 'string' ? messages : messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  const status = await exit; clearTimeout(timer);
  assert.equal(status.code, 0, 'bridge subprocess must exit normally: ' + stderr);
  assert.equal(stderr, '', 'bridge must not log on stderr');
  const lines = stdout.trim().split('\n').filter(Boolean);
  const responses = lines.map(line => JSON.parse(line));
  assert.ok(responses.every(response => response.jsonrpc === '2.0'));
  assert.ok(lines.every(line => Buffer.byteLength(line) + 1 <= 96 * 1024 * 1024));
  assert.ok(!stdout.includes(secret), 'credentials must not appear on stdout');
  return { responses, stdout };
}

test('default private config path is independent of shell environment and initialize/ping do not claim remote readiness', async () => {
  assert.equal(resolveConfigPath({}, '/owner-home'), path.join('/owner-home', '.config', 'rdk-camera-workshop', 'connection.json'));
  const directory = await mkdtemp(path.join(tmpdir(), 'camera-mcp-unconfigured-'));
  try {
    const { responses } = await run([
      rpc(1, 'initialize', { protocolVersion: '2025-03-26' }),
      { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'ping'), rpc(3, 'tools/list'),
    ], path.join(directory, 'missing.json'));
    assert.equal(responses.length, 3);
    assert.equal(responses.find(item => item.id === 1).result.protocolVersion, '2025-03-26');
    assert.deepEqual(responses.find(item => item.id === 2).result, {});
    assert.match(responses.find(item => item.id === 3).error.message, /unconfigured/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP requests inherit the exact admin credential and action guard while only reviewed typed tools are listed', async () => {
  await withFixture((request, response, message) => {
    assert.equal(request.url, endpoint);
    assert.equal(request.headers['x-admin-token'], secret);
    assert.equal(request.headers['x-rdk-sso-session'], undefined);
    assert.equal(request.headers['x-rdk-ops-action'], 'observability');
    reply(response, message, { tools: [tool('vision_camera_knowledge_search'), tool('vision_workshop_runtime_status'), tool('vision_experiment_create'), tool('vision_workshop_execute'), tool('vision_unreviewed_shell'), tool('platform_operations_execute')] });
  }, async ({ configFile, requests }) => {
    const { responses } = await run([rpc(1, 'tools/list')], configFile);
    assert.deepEqual(responses[0].result.tools.map(item => item.name), ['vision_camera_knowledge_search', 'vision_workshop_runtime_status', 'vision_experiment_create']);
    assert.equal(requests.length, 1);
  });
});

test('SSO auth uses the SSO header without creating an admin identity and errors redact echoed credentials', async () => {
  await withFixture((request, response, message) => {
    assert.equal(request.headers['x-rdk-sso-session'], secret); assert.equal(request.headers['x-admin-token'], undefined);
    reply(response, message, { isError: true, content: [{ type: 'text', text: 'upstream failed with ' + secret }] });
  }, async ({ saveConfig, credentialFile }) => {
    const configFile = await saveConfig({ auth: { type: 'sso', credentialFile } });
    const { responses } = await run([rpc(1, 'tools/call', { name: 'vision_camera_knowledge_search', arguments: { q: 'IMX415' } })], configFile);
    assert.equal(responses[0].result.isError, true); assert.match(responses[0].result.content[0].text, /\[redacted\]/);
  });
});

test('workflow tools are discoverable read-only atoms and forward only owned-evidence selectors', async () => {
  await withFixture((_request, response, message) => {
    if (message.method === 'tools/list') reply(response, message, { tools: [tool('vision_camera_workflow'), tool('vision_camera_stream_analyze'), tool('unreviewed_driver_shell')] });
    else reply(response, message, { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }], isError: false });
  }, async ({ configFile, requests }) => {
    const args = { experimentId: 'owned-experiment', runIds: ['saved-run'], expectedFps: 30, tolerancePercent: 5, minimumDurationSeconds: 60 };
    const { responses } = await run([rpc(1, 'tools/list'), rpc(2, 'tools/call', { name: 'vision_camera_workflow', arguments: { experimentId: 'owned-experiment' } }), rpc(3, 'tools/call', { name: 'vision_camera_stream_analyze', arguments: args }), rpc(4, 'tools/call', { name: 'vision_camera_stream_analyze', arguments: { ...args, samples: [{ fps: 30 }] } })], configFile);
    const byId = new Map(responses.map(response => [response.id, response]));
    assert.deepEqual(byId.get(1).result.tools.map(item => item.name), ['vision_camera_workflow', 'vision_camera_stream_analyze']);
    assert.ok(byId.get(1).result.tools.every(item => item.annotations.readOnlyHint && item.annotations.idempotentHint));
    assert.deepEqual(JSON.parse(byId.get(3).result.content[0].text), args);
    assert.ok(byId.get(4).error); assert.equal(requests.length, 3, 'fabricated frame samples must never reach the service');
  });
});

test('A1/B/A2 response atom is discoverable read-only and forwards archive selectors, never paths or metrics', async () => {
  await withFixture((_request, response, message) => {
    if (message.method === 'tools/list') reply(response, message, { tools: [tool('vision_camera_response_analyze')] });
    else reply(response, message, { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }], isError: false });
  }, async ({ configFile, requests }) => {
    const args = { experimentId: 'owned-experiment', baselineFrameIds: ['a1', 'a2', 'a3'], candidateFrameIds: ['b1', 'b2', 'b3'], restoredFrameIds: ['r1', 'r2', 'r3'], roi: { x: 0, y: 0, width: 10, height: 10 } };
    const { responses } = await run([rpc(1, 'tools/list'), rpc(2, 'tools/call', { name: 'vision_camera_response_analyze', arguments: args }), ...[{ path: '/private/frame.png' }, { metrics: { improved: true } }, { contentBase64: 'ZmFrZQ==' }].map((extra, index) => rpc(index + 3, 'tools/call', { name: 'vision_camera_response_analyze', arguments: { ...args, ...extra } }))], configFile);
    const byId = new Map(responses.map(response => [response.id, response]));
    assert.equal(byId.get(1).result.tools[0].annotations.readOnlyHint, true); assert.equal(byId.get(1).result.tools[0].annotations.idempotentHint, true);
    assert.equal(byId.get(1).result.tools[0].annotations.destructiveHint, false);
    assert.deepEqual(JSON.parse(byId.get(2).result.content[0].text), args);
    for (const id of [3, 4, 5]) assert.ok(byId.get(id).error);
    assert.equal(requests.length, 2, 'only discovery and bounded archive selectors reach the server');
  });
});

test('unknown tools, generic execution, arbitrary target fields and malformed argument containers are rejected locally', async () => {
  await withFixture((_request, response) => response.end(), async ({ configFile, requests }) => {
    const inputs = [
      { name: 'vision_workshop_execute', arguments: { operationId: 'POST arbitrary' } },
      { name: 'vision_unreviewed_shell', arguments: {} },
      { name: 'vision_camera_probe', arguments: { experimentId: 'x', host: 'external.invalid' } },
      { name: 'vision_camera_probe', arguments: { experimentId: 'x', path: '/arbitrary' } },
      { name: 'vision_camera_probe', arguments: { experimentId: 'x', command: 'unsafe' } },
      { name: 'vision_camera_probe', arguments: [] },
    ];
    const { responses } = await run(inputs.map((params, index) => rpc(index, 'tools/call', params)), configFile);
    assert.equal(responses.length, inputs.length); assert.ok(responses.every(item => item.error.code === -32602)); assert.equal(requests.length, 0);
  });
});

test('reviewed experiment and baseline aliases can be forwarded without a generic operation executor', async () => {
  await withFixture((_request, response, message) => reply(response, message, { content: [{ type: 'text', text: JSON.stringify(message.params) }], isError: false }), async ({ configFile, requests }) => {
    const names = ['vision_workshop_runtime_status', 'vision_experiment_list', 'vision_experiment_get', 'vision_experiment_create', 'vision_tuning_baseline_import'];
    const args = [{}, { limit: 10, offset: 10 }, { experimentId: 'fixture' }, { title: 'IMX415', goal: '资料核对', board: 'RDK X5' }, { experimentId: 'fixture', config: { exposure: 1 }, rules: [] }];
    const { responses } = await run(names.map((name, index) => rpc(index, 'tools/call', { name, arguments: args[index] })), configFile);
    assert.ok(responses.every(item => item.result.isError === false)); assert.deepEqual(requests.map(item => item.message.params.name), names);
    assert.deepEqual(requests[1].message.params.arguments, { limit: 10, offset: 10 });
  });
});

test('a saved tuning artifact ID is forwarded without requiring model-supplied file bytes', async () => {
  await withFixture((_request, response, message) => reply(response, message, { content: [{ type: 'text', text: 'fixture' }], isError: false }), async ({ configFile, requests }) => {
    const args = { experimentId: 'experiment', artifactId: 'saved-artifact' };
    const { responses } = await run([rpc(1, 'tools/call', { name: 'vision_isp_tuning_load', arguments: args })], configFile);
    assert.equal(responses[0].result.isError, false); assert.deepEqual(requests[0].message.params.arguments, args);
  });
});

test('bounded catalog pages and named knowledge sections retain their exact typed arguments', async () => {
  await withFixture((_request, response, message) => reply(response, message, { content: [{ type: 'text', text: 'fixture' }], isError: false }), async ({ configFile, requests }) => {
    const inputs = [{ name: 'vision_workshop_capabilities', arguments: { search: 'tuning', limit: 4, offset: 4 } }, { name: 'vision_camera_knowledge_get', arguments: { knowledgeId: 'x5-yahboom-imx415', section: 'facts' } }];
    const { responses } = await run(inputs.map((params, index) => rpc(index, 'tools/call', params)), configFile);
    assert.ok(responses.every(item => item.result.isError === false));
    assert.deepEqual(requests.map(item => item.message.params), inputs);
  });
});

test('redirects are denied and never follow the credential to a different path', async () => {
  await withFixture((_request, response) => { response.writeHead(307, { location: '/credential-destination' }); response.end(); }, async ({ configFile, requests }) => {
    const { responses } = await run([rpc(1, 'tools/list')], configFile);
    assert.match(responses[0].error.message, /remote_transport_failed/); assert.equal(requests.length, 1); assert.equal(requests[0].url, endpoint);
  });
});

test('timeouts and disconnects have no automatic retry or recovery claim', async () => {
  for (const disconnect of [false, true]) {
    await withFixture((request, _response) => { if (disconnect) request.socket.destroy(); }, async ({ saveConfig, requests }) => {
      // Allow the cold child-process fetch to reach the server under concurrent typechecks.
      // The fixture never replies: the same single-request/no-retry assertions still test timeout handling.
      const configFile = await saveConfig({ timeoutMs: 1000 });
      const { responses } = await run([rpc(1, 'tools/call', { name: 'vision_isp_apply', arguments: { experimentId: 'fixture', candidateId: 'candidate' } })], configFile);
      assert.match(responses[0].error.message, /execution outcome unknown.*no automatic retry.*deviceRuns.*Restoration is unconfirmed/);
      assert.equal(requests.length, 1);
    });
  }
});

test('invalid URLs, config schemas and credentials fail before opening a remote connection', async () => {
  await withFixture((_request, response) => response.end(), async ({ saveConfig, requests, credentialFile }) => {
    for (const url of ['http://external.invalid' + endpoint, 'https://user:secret@example.invalid' + endpoint, 'https://example.invalid/arbitrary', 'https://example.invalid' + endpoint + '?token=secret', 'https://example.invalid' + endpoint + '#secret', 'https://example.invalid' + endpoint + '?']) {
      const { responses } = await run([rpc(1, 'tools/list')], await saveConfig({ url })); assert.match(responses[0].error.message, /url_invalid/);
    }
    const { responses } = await run([rpc(1, 'tools/list')], await saveConfig({ auth: { type: 'admin', credentialFile, token: secret } }));
    assert.match(responses[0].error.message, /config_invalid/); assert.equal(requests.length, 0);
  });
});

test('private files must be outside the package and POSIX files have exact owner-only permissions', async () => {
  await withFixture((_request, response) => response.end(), async ({ configFile, saveConfig, credentialFile, requests }) => {
    const inside = await run([rpc(1, 'tools/list')], bridge); assert.match(inside.responses[0].error.message, /private_file_inside_package/);
    if (process.platform !== 'win32') {
      await chmod(configFile, 0o644);
      const looseConfig = await run([rpc(1, 'tools/list')], configFile); assert.match(looseConfig.responses[0].error.message, /permissions_invalid/);
      await saveConfig(); await chmod(credentialFile, 0o644);
      const looseCredential = await run([rpc(1, 'tools/list')], configFile); assert.match(looseCredential.responses[0].error.message, /permissions_invalid/);
    }
    assert.equal(requests.length, 0);
  });
});

test('oversized input is rejected once and the next valid newline message is still processed', async () => {
  const input = 'x'.repeat(24 * 1024 * 1024 + 1) + '\n' + JSON.stringify(rpc(2, 'ping')) + '\n';
  const { responses } = await run(input, path.join(tmpdir(), 'missing-camera-config.json'));
  assert.equal(responses.length, 2); assert.match(responses[0].error.message, /input_too_large/); assert.deepEqual(responses[1].result, {});
});

test('oversized upstream output and invalid JSON-RPC receipts are real errors', async () => {
  for (const oversized of [true, false]) {
    await withFixture((_request, response, message) => {
      response.writeHead(200, { 'content-type': 'application/json', ...(oversized ? { 'content-length': String(96 * 1024 * 1024 + 1) } : {}) });
      response.end(oversized ? '{}' : JSON.stringify({ jsonrpc: '2.0', id: message.id + 100, result: { tools: [] } }));
    }, async ({ configFile }) => {
      const { responses } = await run([rpc(1, 'tools/list')], configFile);
      assert.match(responses[0].error.message, oversized ? /response_too_large/ : /response_invalid/);
    });
  }
});

test('reads have bounded parallelism and all tool calls execute serially in input order', async () => {
  let running = 0; let maximum = 0;
  await withFixture(async (_request, response, message) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 35)); running--;
    reply(response, message, message.method === 'tools/list' ? { tools: [tool('vision_camera_probe')] } : { content: [{ type: 'text', text: 'fixture result, hardware unverified' }], isError: false });
  }, async ({ configFile, requests }) => {
    const reads = await run(Array.from({ length: 9 }, (_, index) => rpc(index, 'tools/list')), configFile);
    assert.equal(reads.responses.length, 9); assert.ok(maximum > 1 && maximum <= 4);
    maximum = 0; requests.length = 0;
    await run(Array.from({ length: 6 }, (_, index) => rpc(index, 'tools/call', { name: 'vision_camera_probe', arguments: { experimentId: String(index) } })), configFile);
    assert.equal(maximum, 1); assert.deepEqual(requests.map(item => item.message.id), [0, 1, 2, 3, 4, 5]);
  });
});

test('parse errors and unknown methods keep stdout strictly JSON-RPC and never reflect submitted secrets', async () => {
  const input = secret + '\n' + JSON.stringify(rpc(1, secret)) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'ping' }) + '\n';
  const { responses } = await run(input, path.join(tmpdir(), 'missing-camera-config.json'));
  assert.deepEqual(responses.map(item => item.error.code), [-32700, -32601, -32600]);
});

test('native ISP/calibration tools preserve actual schemas and enforce semantic read/write annotations', async () => {
  const reads = ['vision_isp_tuning_get', 'vision_isp_tuning_export', 'vision_calibration_asset_list', 'vision_calibration_task_list', 'vision_calibration_task_get', 'vision_calibration_task_result', 'vision_calibration_apply_plan'];
  const writes = ['vision_isp_tuning_load', 'vision_calibration_asset_import', 'vision_calibration_task_create', 'vision_calibration_task_run', 'vision_calibration_apply'];
  const names = [...reads, ...writes];
  await withFixture((_request, response, message) => reply(response, message, message.method === 'tools/list'
    ? { tools: [...names.map(name => ({ ...tool(name), annotations: { readOnlyHint: true } })), tool('vision_unreviewed_shell')] }
    : { content: [{ type: 'text', text: 'SDK protocol fixture; hardware unverified' }], isError: false }), async ({ configFile, requests }) => {
    const args = name => name === 'vision_isp_tuning_load' ? { experimentId: 'fixture', contentBase64: 'e30=', sha256: 'a'.repeat(64) }
      : name === 'vision_calibration_asset_import' ? { experimentId: 'fixture', measurement: {} }
      : name === 'vision_calibration_task_create' ? { experimentId: 'fixture', operation: 'blc', inputs: [], options: {} }
      : name === 'vision_calibration_task_list' ? { experimentId: 'fixture' }
      : name.includes('task_') || name.includes('apply') ? { experimentId: 'fixture', taskId: 'fixture-task' } : { experimentId: 'fixture' };
    const { responses } = await run([rpc(1, 'tools/list'), ...names.map((name, index) => rpc(index + 2, 'tools/call', { name, arguments: args(name) }))], configFile);
    const catalog = responses.find(item => item.id === 1).result.tools;
    assert.deepEqual(catalog.map(item => item.name), names);
    for (const listed of catalog) {
      assert.equal(listed.annotations.readOnlyHint, reads.includes(listed.name));
      assert.equal(listed.annotations.idempotentHint, reads.includes(listed.name));
      assert.equal(listed.annotations.destructiveHint, writes.includes(listed.name));
      assert.deepEqual(listed.inputSchema, tool(listed.name).inputSchema);
    }
    assert.ok(responses.filter(item => item.id !== 1).every(item => item.result?.isError === false), JSON.stringify(responses.filter(item => item.error)));
    assert.deepEqual(requests.filter(item => item.message.method === 'tools/call').map(item => item.message.params.name), names);
    assert.ok(requests.every(item => item.url === endpoint && item.headers['x-admin-token'] === secret && item.headers['x-rdk-ops-action'] === 'observability'));
    const rejected = await run(['path', 'command', 'result'].map((key, index) => rpc(index, 'tools/call', { name: 'vision_calibration_apply', arguments: { experimentId: 'fixture', taskId: 'task', [key]: 'untrusted' } })), configFile);
    assert.ok(rejected.responses.every(item => item.error.code === -32602)); assert.equal(requests.length, names.length + 1);
  });
});

test('a bounded RAW result larger than two MiB remains usable through real HTTP and stdio', async () => {
  const actual = Buffer.alloc(3 * 1024 * 1024, 17).toString('base64');
  await withFixture((_request, response, message) => reply(response, message, { content: [{ type: 'text', text: JSON.stringify({ contentBase64: actual, hardwareVerified: false }) }] }), async ({ configFile, requests }) => {
    const { responses } = await run([rpc(1, 'tools/call', { name: 'vision_raw_capture', arguments: { experimentId: 'fixture', scene: 'RAW protocol fixture' } })], configFile);
    assert.equal(JSON.parse(responses[0].result.content[0].text).contentBase64, actual); assert.equal(requests.length, 1);
  });
});

test('a failed semantic read does not claim an unknown hardware write', async () => {
  await withFixture(request => request.socket.destroy(), async ({ configFile, requests }) => {
    const { responses } = await run([rpc(1, 'tools/call', { name: 'vision_calibration_task_result', arguments: { experimentId: 'fixture', taskId: 'task' } })], configFile);
    assert.match(responses[0].error.message, /transport_failed/); assert.doesNotMatch(responses[0].error.message, /execution outcome unknown|Restoration/); assert.equal(requests.length, 1);
  });
});

test('delivery tools preserve operator boundaries and candidate reload role without opening generic execution', async () => {
  const inputs = [
    ['vision_workshop_delivery', { experimentId:'fixture' }],
    ['vision_acceptance_plan_save', { experimentId:'fixture', plan:{scene:'fixture',lighting:'synthetic',criteria:[]} }],
    ['vision_delivery_target_select', {experimentId:'fixture',targetId:'vendor:fixture'}],
    ['vision_acceptance_record', {experimentId:'fixture',record:{report:'Operator fixture, no measured hardware'}}],
    ['vision_isp_tuning_load', {experimentId:'fixture',contentBase64:'e30=',sha256:'a'.repeat(64),artifactRole:'vendor_effect_library_candidate'}],
  ];
  await withFixture((_request,response,message)=>reply(response,message,message.method==='tools/list'?{tools:inputs.map(([name])=>tool(name))}:{content:[{type:'text',text:'Protocol fixture only'}],isError:false}),async({configFile,requests})=>{
    const {responses}=await run([rpc(0,'tools/list'),...inputs.map(([name,args],index)=>rpc(index+1,'tools/call',{name,arguments:args}))],configFile);
    assert.ok(responses.every(item=>item.result&&!item.error));const catalog=responses.find(item=>item.id===0).result.tools;
    for(const item of catalog) assert.equal(item.annotations.readOnlyHint,item.name==='vision_workshop_delivery');
    assert.deepEqual(requests.filter(item=>item.message.method==='tools/call').map(item=>item.message.params.arguments),inputs.map(([,args])=>args));
    const rejected=await run([rpc(9,'tools/call',{name:'vision_acceptance_record',arguments:{experimentId:'fixture',record:{},userId:'injected-owner'}})],configFile);assert.equal(rejected.responses[0].error.code,-32602);
  });
});

test('host onboarding keeps a local diagnostic tool available with no private config', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'camera-first-install-'));
  try {
    const child = spawn(process.execPath, [bridge], { cwd: directory, env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: path.join(directory, 'missing.json'), RDK_CAMERA_WORKSHOP_ONBOARDING: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    const exited = new Promise(resolve => child.on('close', resolve));
    child.stdin.end([rpc(0, 'initialize'), rpc(1, 'tools/list'), rpc(2, 'tools/call', { name: 'vision_connection_status', arguments: {} })].map(JSON.stringify).join('\n') + '\n');
    assert.equal(await exited, 0);
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.find(item => item.id === 1).result.tools.map(tool => tool.name), ['vision_connection_status', 'vision_plugin_version']);
    const status = JSON.parse(responses.find(item => item.id === 2).result.content[0].text);
    assert.equal(status.code, 'camera_bridge_unconfigured'); assert.equal(status.hardware, 'unverified');
    assert.ok(!stdout.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection status adds a path-free remediation hint for the reported code', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'camera-status-hint-'));
  try {
    const child = spawn(process.execPath, [bridge], { cwd: directory, env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: path.join(directory, 'missing.json'), RDK_CAMERA_WORKSHOP_ONBOARDING: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    const exited = new Promise(resolve => child.on('close', resolve));
    child.stdin.end([rpc(0, 'initialize'), rpc(4, 'tools/call', { name: 'vision_connection_status', arguments: {} })].map(JSON.stringify).join('\n') + '\n');
    assert.equal(await exited, 0);
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    const status = JSON.parse(responses.find(item => item.id === 4).result.content[0].text);
    assert.equal(status.code, 'camera_bridge_unconfigured');
    assert.match(status.hint, /configure/);
    assert.ok(!stdout.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('errors on every transport path carry the remediation hint without local paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'camera-error-hint-'));
  try {
    const child = spawn(process.execPath, [bridge], { cwd: directory, env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: path.join(directory, 'missing.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    const exited = new Promise(resolve => child.on('close', resolve));
    child.stdin.end([rpc(0, 'initialize'), rpc(6, 'tools/call', { name: 'vision_workshop_runtime_status', arguments: {} })].map(JSON.stringify).join('\n') + '\n');
    assert.equal(await exited, 0);
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    const error = responses.find(item => item.id === 6).error;
    assert.equal(error.code, -32001);
    assert.match(error.message, /camera_bridge_unconfigured: 尚未配置连接/);
    assert.ok(!stdout.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
