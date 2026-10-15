import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDGE_LLM_CONTRACT, BENCHMARK_SUITE, createEdgeLlmRunner, verifyGguf, downloadGgufModel,
  normalizeEdgeLlmConfig, startEdgeLlmRunnerFromEnv } from './edge-llm-runner.mjs';

const TOKEN = 'fixture-token-is-private-and-long-enough';
const MODEL = Buffer.from('GGUF\x03\x00\x00\x00fixture-model-bytes');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const facts = async () => ({ platform: 'linux', architecture: 'arm64', ramBytes: 8 * 1024 ** 3,
  freeRamBytes: 6 * 1024 ** 3, freeDiskBytes: 30 * 1024 ** 3, configuredBoard: 'X5', detectedBoard: null,
  identityVerification: 'unverified', boardIdentityStatus: 'unavailable' });

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function fixtureSource(mode) {
  return `#!/usr/bin/env node
import {createServer} from 'node:http';
import {appendFile,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('llama-server version fixture-b1234');process.exit(0)}
const value=flag=>args[args.indexOf(flag)+1];
if(value('-ngl')!=='0'||value('--host')!=='127.0.0.1'||value('--threads')!=='4'||value('--parallel')!=='1') process.exit(9);
const modelPath=value('--model');
if((await readFile(modelPath)).subarray(0,4).toString()!=='GGUF')process.exit(10);
const mode=${JSON.stringify(mode)};
const server=createServer(async(req,res)=>{
 if(req.url==='/health'){res.writeHead(mode==='bad-health'?503:200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok'}));return}
 if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return}
 let raw='';for await(const chunk of req)raw+=chunk;
 const input=JSON.parse(raw);await appendFile(join(dirname(modelPath),'requests.jsonl'),JSON.stringify(input)+'\\n');
 if(input.model!==value('--alias')){res.writeHead(400);res.end();return}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const event=obj=>res.write('data: '+JSON.stringify(obj)+'\\n\\n');
 event({choices:[{delta:{role:'assistant'}}]});
 setTimeout(()=>event({choices:[{delta:{content:mode==='empty'?'':'你好'}}]}),25);
 setTimeout(()=>{
  if(mode!=='empty')event({choices:[{delta:{content:'，模型运行正常。'}}]});
  if(mode==='incomplete'){res.end();return}
  event({choices:[{delta:{},finish_reason:'stop'}],...(mode==='no-tokens'?{}:mode==='timings'?{timings:{predicted_n:7,predicted_per_second:23.5}}:{usage:{completion_tokens:mode==='zero-tokens'?0:7}})});
  res.end('data: [DONE]\\n\\n');
 },75);
});
server.listen(Number(value('--port')),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
}
async function setup({ mode = 'normal', modelHash = sha(MODEL), withModel = true, systemProbe = facts } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'edge-llm-test-'));
  const binary = join(root, 'fake-llama-server'); await writeFile(binary, fixtureSource(mode), { mode: 0o700 });
  const modelDir = join(root, 'models');
  const config = { board: 'X5', binary, modelDir, port: await freePort(), threads: 4, contextSize: 2048,
    startupTimeoutMs: 1000, requestTimeoutMs: 1000, models: [{ id: 'qwen-fixture', label: 'Qwen fixture',
      path: join(modelDir, 'qwen-fixture.gguf'), sha256: modelHash, sizeBytes: MODEL.length, quantization: 'Q4_K_M' }] };
  const stateDir = join(root, 'state');
  const runner = await createEdgeLlmRunner(config, { token: TOKEN, stateDir, systemProbe });
  if (withModel) await writeFile(config.models[0].path, MODEL, { mode: 0o600 });
  runner.server.listen(0, '127.0.0.1'); await once(runner.server, 'listening');
  const url = `http://127.0.0.1:${runner.server.address().port}`;
  const request = async (method, path, body, authenticated = true) => {
    const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const submit = (operation, inputs = {}, id = randomUUID()) => request('POST', '/jobs', { contract: EDGE_LLM_CONTRACT, id, operation, inputs });
  const close = async () => { await runner.close(); await rm(root, { recursive: true, force: true }); };
  return { root, config, stateDir, runner, request, submit, close };
}
async function finished(runner, id) {
  for (let index = 0; index < 300; index++) {
    const job = runner.getJob(id);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await delay(10);
  }
  assert.fail('job did not finish');
}
async function operation(context, name, inputs = {}) {
  const response = await context.submit(name, inputs); assert.equal(response.status, 202, JSON.stringify(response.body));
  return finished(context.runner, response.body.job.id);
}

test('control requires auth, catalog hides configured paths and URLs, caller inputs cannot inject shell or paths', async () => {
  const context = await setup();
  try {
    for (const path of ['/catalog', '/jobs/' + randomUUID()]) assert.equal((await context.request('GET', path, undefined, false)).status, 401);
    const catalog = await context.request('GET', '/catalog');
    assert.equal(catalog.body.contract, EDGE_LLM_CONTRACT); assert.equal(catalog.body.backend, 'cpu');
    assert.equal(catalog.body.runtime.available, true); assert.equal(catalog.body.deployment.ready, false);
    assert.doesNotMatch(JSON.stringify(catalog.body), /fake-llama-server|\/models\/|fixture-token/);
    for (const inputs of [{ modelId: 'qwen-fixture', command: 'touch /tmp/no' }, { modelId: 'qwen-fixture', url: 'https://evil.test/model' }, { modelId: '../outside' }, { path: '/tmp/model.gguf' }]) {
      assert.ok([400, 404].includes((await context.submit('deploy', inputs)).status));
    }
    const probe = await operation(context, 'probe');
    assert.equal(probe.status, 'succeeded'); assert.equal(probe.result.identityVerification, 'unverified');
    assert.equal(probe.result.configuredBoard, 'X5'); assert.equal(probe.result.detectedBoard, null);
    assert.equal((await lstat(context.stateDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(context.stateDir, 'state.json'))).mode & 0o777, 0o600);
  } finally { await context.close(); }
});

test('real HTTP fixture deployment and streaming benchmark measure three cases after a warmup', async () => {
  const context = await setup();
  try {
    const deployed = await operation(context, 'deploy', { modelId: 'qwen-fixture' });
    assert.equal(deployed.status, 'succeeded', JSON.stringify(deployed)); assert.equal(deployed.result.ready, true);
    assert.equal(deployed.result.modelSha256, sha(MODEL)); assert.equal(deployed.result.gpuLayers, 0);
    assert.equal((await context.runner.catalog()).deployment.ready, true);
    const benchmark = await operation(context, 'benchmark', { modelId: 'qwen-fixture' });
    assert.equal(benchmark.status, 'succeeded', JSON.stringify(benchmark));
    assert.equal(benchmark.result.suite, BENCHMARK_SUITE); assert.equal(benchmark.result.measurementSource, 'runner');
    assert.equal(benchmark.result.accuracyEvaluated, false); assert.equal(benchmark.result.cases.length, 3);
    for (const entry of benchmark.result.cases) {
      assert.ok(entry.ttftMs >= 20 && entry.totalMs > entry.ttftMs); assert.equal(entry.generatedTokens, 7);
      assert.ok(entry.tokensPerSecond > 0); assert.equal(entry.metricStatus, 'available'); assert.equal(entry.outputPresent, true);
    }
    const requests = (await readFile(join(context.config.modelDir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 5); // One deploy validation plus four benchmark calls.
    assert.equal(requests[1].cache_prompt, false);
    assert.equal(requests[1].max_tokens, 96); assert.equal(requests[1].messages[0].content, '请用一句中文介绍你能做什么。');
    assert.doesNotMatch(JSON.stringify(benchmark), /你好|模型运行正常|fixture-token|fake-llama-server|请用/);
    const stopped = await operation(context, 'stop'); assert.equal(stopped.result.stopped, true); assert.equal(stopped.result.ownedProcess, true);
    assert.equal(stopped.result.inferencePortAvailable, true); assert.deepEqual(stopped.result.abandonedJobIds, []);
    assert.equal((await context.runner.catalog()).deployment.ready, false);
  } finally { await context.close(); }
});

test('missing or contradictory zero token counts are unavailable; actual output and timing still required', async () => {
  for (const mode of ['no-tokens', 'zero-tokens']) {
  const context = await setup({ mode });
  try {
    assert.equal((await operation(context, 'deploy', { modelId: 'qwen-fixture' })).status, 'succeeded');
    const benchmark = await operation(context, 'benchmark'); assert.equal(benchmark.status, 'succeeded');
    for (const entry of benchmark.result.cases) {
      assert.equal(entry.generatedTokens, null); assert.equal(entry.tokensPerSecond, null);
      assert.equal(entry.metricStatus, 'partial'); assert.ok(entry.unavailableReasons.length); assert.ok(entry.ttftMs > 0);
    }
  } finally { await context.close(); }
  }
});

test('runtime timings are accepted as token evidence without estimating tokens from characters', async () => {
  const context = await setup({ mode: 'timings' });
  try {
    assert.equal((await operation(context, 'deploy', { modelId: 'qwen-fixture' })).status, 'succeeded');
    const benchmark = await operation(context, 'benchmark');
    assert.equal(benchmark.result.cases[0].tokenSource, 'timings'); assert.equal(benchmark.result.cases[0].generatedTokens, 7);
    assert.equal(benchmark.result.cases[0].tokensPerSecond, 23.5); assert.equal(benchmark.result.cases[0].runtimeTokensPerSecond, 23.5);
    assert.equal(benchmark.result.cases[0].rateDefinition, 'runtime_timings_predicted_per_second');
  } finally { await context.close(); }
});

test('GGUF hash mismatch and invalid magic fail before starting the runtime', async () => {
  const context = await setup({ modelHash: '0'.repeat(64) });
  try {
    const job = await operation(context, 'deploy', { modelId: 'qwen-fixture' });
    assert.equal(job.status, 'failed'); assert.equal(job.error, 'edge_llm_model_hash_mismatch');
    assert.equal((await context.runner.catalog()).deployment.ready, false);
    await writeFile(context.config.models[0].path, Buffer.from('NOT_GGUF'));
    await assert.rejects(verifyGguf(context.config.models[0].path, sha(Buffer.from('NOT_GGUF'))), /invalid_gguf_magic/);
    const linked = join(context.config.modelDir, 'symlink.gguf'); await symlink(context.config.models[0].path, linked);
    await assert.rejects(verifyGguf(linked, sha(Buffer.from('NOT_GGUF'))));
  } finally { await context.close(); }
});

test('download rejects redirects and bad hashes, removes temporary bytes, and installs verified bytes atomically', async () => {
  const context = await setup({ withModel: false });
  try {
    const config = normalizeEdgeLlmConfig(context.config);
    const model = { ...config.models[0], url: 'https://fixed.example/model.gguf' };
    await assert.rejects(downloadGgufModel(model, config, { fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://other.example/model' } });
    } }), /redirect_rejected/);
    await assert.rejects(downloadGgufModel({ ...model, sha256: '0'.repeat(64) }, config, { fetchImpl: async () => new Response(MODEL) }), /hash_mismatch/);
    assert.deepEqual(await readdir(config.modelDir), []);
    let requests = 0;
    const verified = await downloadGgufModel({ ...model, redirectHosts: ['fixed-cdn.example'] }, config, { fetchImpl: async (url, options) => {
      assert.equal(options.headers, undefined); assert.equal(options.redirect, 'manual'); requests++;
      if (requests === 1) return new Response('', { status: 302, headers: { location: 'https://fixed-cdn.example/model?signature=PRIVATE_CDN_SIGNATURE' } });
      assert.equal(url, 'https://fixed-cdn.example/model?signature=PRIVATE_CDN_SIGNATURE'); return new Response(MODEL);
    } });
    assert.equal(requests, 2);
    assert.equal(verified.sha256, sha(MODEL)); assert.deepEqual(await readFile(model.path), MODEL);
    assert.deepEqual(await readdir(config.modelDir), ['qwen-fixture.gguf']);
    for (const location of ['http://fixed-cdn.example/model', 'https://user:secret@fixed-cdn.example/model', 'https://unlisted.example/model', 'https://fixed-cdn.example:444/model']) {
      await assert.rejects(downloadGgufModel({ ...model, redirectHosts: ['fixed-cdn.example'] }, config, {
        fetchImpl: async () => new Response('', { status: 302, headers: { location } }),
      }), /redirect_rejected/);
    }
    requests = 0;
    await assert.rejects(downloadGgufModel({ ...model, redirectHosts: ['fixed-cdn.example'] }, config, {
      fetchImpl: async () => { requests++; return new Response('', { status: 302, headers: { location: 'https://fixed-cdn.example/loop' } }); },
    }), /redirect_rejected/);
    assert.equal(requests, 5);
  } finally { await context.close(); }
});

test('idempotent jobs replay their status and reject different parameters or concurrent work', async () => {
  const context = await setup();
  try {
    const id = randomUUID(); const first = await context.submit('deploy', { modelId: 'qwen-fixture' }, id);
    assert.equal(first.status, 202); assert.ok(['queued', 'running'].includes(first.body.job.status));
    const replay = await context.submit('deploy', { modelId: 'qwen-fixture' }, id); assert.equal(replay.status, 202);
    assert.equal((await context.submit('stop', {}, id)).status, 409);
    assert.equal((await context.submit('probe')).status, 409);
    const completed = await finished(context.runner, id); assert.equal(completed.status, 'succeeded');
    const get = await context.request('GET', '/jobs/' + id); assert.deepEqual(get.body.job, completed);
    assert.deepEqual((await context.submit('deploy', { modelId: 'qwen-fixture' }, id)).body.job, completed);
    const requests = (await readFile(join(context.config.modelDir, 'requests.jsonl'), 'utf8')).trim().split('\n'); assert.equal(requests.length, 1);
    await context.runner.close();
    const restarted = await createEdgeLlmRunner(context.config, { token: TOKEN, stateDir: context.stateDir, systemProbe: facts });
    try { assert.deepEqual(restarted.getJob(id), completed); } finally { await restarted.close(); }
  } finally { await context.close(); }
});

test('restart marks interrupted jobs unknown and never reexecutes them', async () => {
  const context = await setup();
  try {
    await context.runner.close();
    const id = randomUUID(); const timestamp = new Date().toISOString();
    await writeFile(join(context.stateDir, 'state.json'), JSON.stringify({ contract: EDGE_LLM_CONTRACT,
      jobs: [{ request: { id, operation: 'deploy', inputs: { modelId: 'qwen-fixture' } },
        job: { id, operation: 'deploy', status: 'running', createdAt: timestamp, updatedAt: timestamp } }],
      deployment: { modelId: 'qwen-fixture', ready: true } }), { mode: 0o600 });
    // Stored request includes the same wire contract, so recovery revalidates its allowlisted inputs.
    const stored = JSON.parse(await readFile(join(context.stateDir, 'state.json'), 'utf8')); stored.jobs[0].request.contract = EDGE_LLM_CONTRACT;
    await writeFile(join(context.stateDir, 'state.json'), JSON.stringify(stored), { mode: 0o600 });
    const restarted = await createEdgeLlmRunner(context.config, { token: TOKEN, stateDir: context.stateDir, systemProbe: facts });
    try {
      assert.equal(restarted.getJob(id).status, 'unknown'); assert.equal(restarted.getJob(id).error, 'edge_llm_interrupted_by_restart');
      assert.equal((await restarted.catalog()).deployment.ready, false);
      const replay = await restarted.submit({ contract: EDGE_LLM_CONTRACT, id, operation: 'deploy', inputs: { modelId: 'qwen-fixture' } });
      assert.equal(replay.status, 'unknown'); assert.equal((await readdir(context.config.modelDir)).includes('requests.jsonl'), false);
    } finally { await restarted.close(); }
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test('stop never signals a foreign process and deployment refuses an occupied inference port', async () => {
  const context = await setup(); let foreign;
  try {
    const config = context.config;
    foreign = spawn(config.binary, ['--model', config.models[0].path, '--host', '127.0.0.1', '--port', String(config.port), '-ngl', '0',
      '--threads', '4', '--parallel', '1', '--alias', 'qwen-fixture'], { stdio: 'ignore' });
    await once(foreign, 'spawn');
    for (let index = 0; index < 100; index++) { try { if ((await fetch(`http://127.0.0.1:${config.port}/health`)).ok) break; } catch {} await delay(10); }
    const stopped = await operation(context, 'stop'); assert.equal(stopped.status, 'failed'); assert.equal(stopped.error, 'edge_llm_inference_port_in_use');
    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    const deploy = await operation(context, 'deploy', { modelId: 'qwen-fixture' });
    assert.equal(deploy.status, 'failed'); assert.equal(deploy.error, 'edge_llm_inference_port_in_use');
    await context.runner.close(); assert.doesNotThrow(() => process.kill(foreign.pid, 0));
  } finally {
    if (foreign && foreign.exitCode === null) { foreign.kill('SIGTERM'); await once(foreign, 'exit'); }
    await rm(context.root, { recursive: true, force: true });
  }
});

test('recovery stop persists abandoned IDs before execution and rejects delayed deploys across restart', async () => {
  const context = await setup();
  try {
    const oldId = randomUUID();
    const stopped = await operation(context, 'stop', { abandonJobIds: [oldId] });
    assert.equal(stopped.status, 'succeeded'); assert.equal(stopped.result.inferencePortAvailable, true);
    assert.deepEqual(stopped.result.abandonedJobIds, [oldId]);
    const late = await context.submit('deploy', { modelId: 'qwen-fixture' }, oldId);
    assert.equal(late.status, 409); assert.equal(late.body.error, 'edge_llm_job_abandoned');
    assert.equal((await context.request('GET', '/jobs/' + oldId)).body.error, 'edge_llm_job_abandoned');
    assert.equal((await readdir(context.config.modelDir)).includes('requests.jsonl'), false);
    await context.runner.close();
    const restarted = await createEdgeLlmRunner(context.config, { token: TOKEN, stateDir: context.stateDir, systemProbe: facts });
    try {
      await assert.rejects(restarted.submit({ contract: EDGE_LLM_CONTRACT, id: oldId, operation: 'deploy', inputs: { modelId: 'qwen-fixture' } }), /job_abandoned/);
      const fresh = await restarted.submit({ contract: EDGE_LLM_CONTRACT, id: randomUUID(), operation: 'deploy', inputs: { modelId: 'qwen-fixture' } });
      assert.equal((await finished(restarted, fresh.id)).status, 'succeeded');
    } finally { await restarted.close(); }
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test('empty output or incomplete streams fail deployment and stop the newly started owned process', async () => {
  for (const mode of ['empty', 'incomplete']) {
    const context = await setup({ mode });
    try {
      const job = await operation(context, 'deploy', { modelId: 'qwen-fixture' });
      assert.equal(job.status, 'failed'); assert.match(job.error, /inference_(empty_output|incomplete)/);
      assert.equal((await context.runner.catalog()).deployment.ready, false);
      const testPort = createServer(); testPort.listen(context.config.port, '127.0.0.1'); await once(testPort, 'listening');
      await new Promise(done => testPort.close(done));
    } finally { await context.close(); }
  }
});

test('runtime deploy checks the real architecture and env startup enforces a 0600 token file', async () => {
  const context = await setup({ systemProbe: async () => ({ ...(await facts()), platform: 'darwin', architecture: 'arm64' }) });
  try {
    const job = await operation(context, 'deploy', { modelId: 'qwen-fixture' }); assert.equal(job.error, 'edge_llm_unsupported_architecture');
    const tokenPath = join(context.root, 'token'); const configPath = join(context.root, 'config.json');
    await writeFile(tokenPath, TOKEN, { mode: 0o644 }); await writeFile(configPath, JSON.stringify(context.config), { mode: 0o600 });
    await assert.rejects(startEdgeLlmRunnerFromEnv({ RDK_EDGE_LLM_CONFIG: configPath, RDK_EDGE_LLM_TOKEN_FILE: tokenPath,
      RDK_EDGE_LLM_STATE_DIR: join(context.root, 'another-state') }), /insecure_admin_file/);
  } finally { await context.close(); }
});
