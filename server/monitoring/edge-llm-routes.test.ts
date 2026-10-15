import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { EdgeLlmService, type EdgeLlmAdapterConfig } from './edge-llm-service.js';
import { registerEdgeLlmRoutes, EDGE_LLM_API as API, EDGE_LLM_OPERATIONS } from './edge-llm-routes.js';
import { EDGE_LLM_RUNNER_CONTRACT as CONTRACT } from './edge-llm-operations.js';
import { executePlatformOperation, listPlatformOperations } from './platform-operations.js';

let directory: string; let service: EdgeLlmService; let adapters: EdgeLlmAdapterConfig[]; let origin: string; let runnerOrigin: string; let servers: Server[]; let router: Router;
let saved: Record<string, string | undefined>; let requests: Array<Record<string, any>>; let jobs: Map<string, Record<string, any>>;
let submitMode: 'queued' | 'drop' | 'malicious'; let malicious: (receipt: Record<string, any>) => unknown; let runnerGets: number;
const token = 'fixture-private-runner-token-0123456789'; const sha256 = 'a'.repeat(64);
const catalog = () => ({ ok: true, contract: CONTRACT, board: 'X5', backend: 'cpu', models: [{ id: 'qwen2.5-0.5b', label: 'Qwen text', sha256, quantization: 'Q4_K_M', sizeBytes: 1000 }], runtime: { available: true, version: 'fixture-runtime' }, deployment: { modelId: 'qwen2.5-0.5b', ready: true } });
const headers = (user = 'alice') => ({ 'x-fixture-user': user, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' });
const get = (suffix: string, user = 'alice') => fetch(origin + API + suffix, { headers: headers(user) });
const post = (body: unknown, user = 'alice', extra = {}) => fetch(origin + API + '/jobs', { method: 'POST', headers: { ...headers(user), ...extra }, body: JSON.stringify(body) });
async function json(response: Response, status = 200): Promise<any> { const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result; }
async function listen(app: express.Express) { const server = createServer(app); servers.push(server); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string'); return 'http://127.0.0.1:' + address.port; }
async function settled(id: string) { const deadline = Date.now() + 3000; for (;;) { const job = await service.getJob('sso:alice', id, { refresh: false }); if (job.status !== 'submitting') return job; assert.ok(Date.now() < deadline, 'background submission did not settle'); await new Promise((done) => setTimeout(done, 10)); } }
function success(id: string, result: Record<string, unknown>) { const job = jobs.get(id)!; jobs.set(id, { ...job, status: 'succeeded', updatedAt: new Date(Date.now() + 10).toISOString(), result }); }
beforeEach(async () => {
  servers = []; requests = []; jobs = new Map(); runnerGets = 0; submitMode = 'queued'; malicious = (receipt) => receipt;
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS }; process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: (req) => { const id = req.header('x-fixture-user'); return id ? { id, email: 'shared@example.invalid' } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const runner = express(); runner.use(express.json());
  runner.use((req, res, next) => { if (req.header('authorization') !== 'Bearer ' + token) res.sendStatus(403); else next(); });
  runner.get('/catalog', (_req, res) => res.json(catalog()));
  runner.post('/jobs', (req, res) => { requests.push(req.body); const timestamp = new Date().toISOString(); const job = { id: req.body.id, operation: req.body.operation, status: 'queued', createdAt: timestamp, updatedAt: timestamp }; jobs.set(job.id, job); const receipt = { ok: true, contract: CONTRACT, job }; if (submitMode === 'drop') res.destroy(); else res.status(202).json(submitMode === 'malicious' ? malicious(receipt) : receipt); });
  runner.get('/jobs/:id', (req, res) => { runnerGets++; const job = jobs.get(String(req.params.id)); if (!job) res.sendStatus(404); else res.json({ ok: true, contract: CONTRACT, job }); });
  runnerOrigin = await listen(runner); adapters = Array.from({ length: 5 }, (_, index) => ({ id: index ? 'x5-' + index : 'x5', label: 'Fixture X5 ' + index, board: 'X5' as const, url: runnerOrigin, token }));
  directory = await mkdtemp(join(tmpdir(), 'd-obs-edge-llm-')); service = new EdgeLlmService({ dataDir: directory, adapters, requestTimeoutMs: 1000 });
  const app = express(); app.use(express.json()); router = express.Router(); registerEdgeLlmRoutes(router, { getService: () => service });
  router.post('/fixture-execute', async (req, res) => res.json(await executePlatformOperation(router, req, res, req.body.operationId, req.body.args ?? {}))); app.use('/dobs', router); app.use(router); origin = await listen(app);
});
afterEach(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); } resetObservabilityAccessAdapter(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(directory, { recursive: true, force: true }); });

test('real HTTP and MCP reuse authenticated identity, mutation guard and read-only constraints', async () => {
  for (const auth of [{}, { 'x-admin-token': 'wrong' }, { 'x-fixture-user': 'outsider' }, { 'x-tenant-token': 'tenant-only' }] as Record<string, string>[]) assert.equal((await fetch(origin + API + '/capabilities', { headers: auth })).status, 403);
  const capability = await json(await fetch(origin + '/dobs' + API + '/capabilities', { headers: { ...headers(), 'x-rdk-ops-read-only': '1' } })); assert.equal(capability.readOnly, true); assert.equal(capability.targets[0].board, 'X5'); assert.ok(!JSON.stringify(capability).includes(token)); assert.ok(!JSON.stringify(capability).includes(runnerOrigin));
  assert.equal((await post({ targetId: 'x5', operation: 'probe' }, 'alice', { 'x-rdk-ops-action': '' })).status, 400);
  assert.equal((await post({ targetId: 'x5', operation: 'probe' }, 'alice', { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post({ targetId: 'x5', operation: 'probe' }, 'alice', { 'x-rdk-ops-read-only': '1' })).status, 403);
  for (const extra of [{ url: 'http://unsafe' }, { token }, { owner: 'bob' }, { command: 'sh' }, { metrics: { tokensPerSecond: 999 } }, { id: 'chosen-by-client' }]) assert.equal((await post({ targetId: 'x5', operation: 'probe', ...extra })).status, 400);
  assert.deepEqual(listPlatformOperations(router).map((item) => item.id).sort(), Object.keys(EDGE_LLM_OPERATIONS).sort());
  const mcp = await json(await fetch(origin + '/fixture-execute', { method: 'POST', headers: { ...headers(), 'x-rdk-ops-read-only': '1' }, body: JSON.stringify({ operationId: 'POST ' + API + '/jobs', args: { body: { targetId: 'x5', operation: 'probe' } } }) })); assert.equal(mcp.status, 403); assert.equal(requests.length, 0);
});

test('202 registers durable pending work; same-email accounts cannot list, query or export each other', async () => {
  const created = (await json(await post({ targetId: 'x5', operation: 'deploy', modelId: 'qwen2.5-0.5b' }), 202)).job; assert.equal(created.status, 'submitting'); assert.equal(created.result, undefined);
  const pending = await settled(created.id); assert.equal(pending.status, 'queued'); assert.equal(pending.modelSha256, sha256); assert.equal(requests.length, 1); assert.equal(requests[0].id, created.id);
  assert.equal((await post({ targetId: 'x5', operation: 'stop' })).status, 409); assert.equal(requests.length, 1);
  assert.deepEqual((await json(await get('/jobs', 'bob'))).jobs, []); const before = runnerGets; assert.equal((await get('/jobs/' + created.id, 'bob')).status, 404); assert.equal((await get('/jobs/' + created.id + '/report', 'bob')).status, 404); assert.equal(runnerGets, before);
  service = new EdgeLlmService({ dataDir: directory, adapters }); const persisted = (await json(await get('/jobs'))).jobs[0]; assert.equal(persisted.id, created.id); assert.equal(persisted.status, 'queued');
  const report = await get('/jobs/' + created.id + '/report'); assert.match(report.headers.get('content-disposition')!, /attachment/); const raw = await report.text(); assert.ok(!raw.includes('ownerHash')); assert.ok(!raw.includes(token)); assert.ok(!raw.includes(runnerOrigin));
  assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(join(directory, 'manifest.json'))).mode & 0o777, 0o600);
  jobs.set(created.id, { ...jobs.get(created.id), status: 'running', updatedAt: new Date(Date.now() + 5).toISOString(), result: { modelId: 'qwen2.5-0.5b', progress: 'hash_check_started' } }); assert.equal((await json(await get('/jobs/' + created.id))).job.result.progress, 'hash_check_started');
  const { result: _partial, ...previous } = jobs.get(created.id)!; jobs.set(created.id, { ...previous, status: 'failed', updatedAt: new Date(Date.now() + 10).toISOString(), error: 'edge_llm_model_integrity_failure' });
  const failed = (await json(await get('/jobs/' + created.id))).job; assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'edge_llm_model_integrity_failure'); assert.equal(failed.result.progress, 'hash_check_started');
});

test('lost POST response recovers only by querying the durable same ID and never retries a mutation', async () => {
  submitMode = 'drop'; const created = (await json(await post({ targetId: 'x5', operation: 'deploy', modelId: 'qwen2.5-0.5b' }), 202)).job;
  assert.equal((await settled(created.id)).status, 'unknown'); assert.equal(requests.length, 1);
  assert.equal((await post({ targetId: 'x5', operation: 'deploy', modelId: 'qwen2.5-0.5b' })).status, 409); assert.equal(requests.length, 1);
  service = new EdgeLlmService({ dataDir: directory, adapters }); jobs.set(created.id, { ...jobs.get(created.id), status: 'running', updatedAt: new Date(Date.now() + 5).toISOString() });
  assert.equal((await json(await get('/jobs/' + created.id))).job.status, 'running');
  success(created.id, { board: 'X5', backend: 'cpu', modelId: 'qwen2.5-0.5b', modelSha256: sha256, ready: true, token, endpoint: runnerOrigin, notes: 'private ' + token + ' at ' + runnerOrigin });
  const completed = (await json(await get('/jobs/' + created.id))).job; assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.ready, true); assert.ok(!JSON.stringify(completed).includes(token)); assert.ok(!JSON.stringify(completed).includes(runnerOrigin)); assert.equal(requests.length, 1);
  jobs.delete(created.id); assert.equal((await json(await get('/jobs/' + created.id))).job.status, 'succeeded'); assert.equal(requests.length, 1);
});

test('wrong contracts, IDs, operations and hollow success cannot become completed tasks', async () => {
  submitMode = 'malicious'; const mutations = [
    (value: Record<string, any>) => ({ ...value, contract: 'fake' }),
    (value: Record<string, any>) => ({ ...value, job: { ...value.job, id: '00000000-0000-4000-8000-000000000000' } }),
    (value: Record<string, any>) => ({ ...value, job: { ...value.job, operation: 'deploy' } }),
    (value: Record<string, any>) => ({ ...value, job: { ...value.job, status: 'succeeded', result: { board: 'S600', backend: 'cpu', stopped: true } } }),
    (value: Record<string, any>) => ({ ...value, job: { ...value.job, status: 'succeeded', result: {} } }),
  ];
  for (let index = 0; index < mutations.length; index++) { malicious = mutations[index]; const created = (await json(await post({ targetId: adapters[index].id, operation: 'stop' }), 202)).job; const job = await settled(created.id); assert.equal(job.status, 'unknown'); assert.match(job.lastQueryError!, /edge_llm_(invalid|empty)/); assert.equal(job.result, undefined); }
});

test('benchmark preserves nullable measured metrics and refuses wrong model hashes or false hardware proof', async () => {
  const probe = (await json(await post({ targetId: 'x5', operation: 'probe' }), 202)).job; await settled(probe.id);
  success(probe.id, { board: 'X5', backend: 'cpu', configuredBoard: 'X5', detectedBoard: null, identityVerification: 'verified', runtime: { available: true } }); assert.equal((await json(await get('/jobs/' + probe.id))).job.status, 'unknown');
  success(probe.id, { board: 'X5', backend: 'cpu', configuredBoard: 'X5', detectedBoard: null, identityVerification: 'unverified', runtime: { available: true } }); assert.equal((await json(await get('/jobs/' + probe.id))).job.status, 'succeeded');
  const benchmark = (await json(await post({ targetId: 'x5', operation: 'benchmark', modelId: 'qwen2.5-0.5b' }), 202)).job; await settled(benchmark.id);
  const result = { board: 'X5', backend: 'cpu', modelId: 'qwen2.5-0.5b', modelSha256: 'b'.repeat(64), suite: 'qwen-text-smoke-v1', measurementSource: 'runner', cases: ['case1', 'case2', 'case3'].map((id) => ({ id, ttftMs: 20, totalMs: 100, generatedTokens: null, tokensPerSecond: null, metricStatus: 'partial', unavailableReasons: ['runtime_did_not_report_token_counts'], outputPresent: true })) };
  success(benchmark.id, result); assert.equal((await json(await get('/jobs/' + benchmark.id))).job.status, 'unknown'); result.modelSha256 = sha256; success(benchmark.id, result);
  const completed = (await json(await get('/jobs/' + benchmark.id))).job; assert.equal(completed.status, 'succeeded'); assert.equal(completed.result.cases[0].generatedTokens, null); assert.equal(completed.result.cases[0].tokensPerSecond, null); assert.equal(completed.result.measurementSource, 'runner');
});

test('missing or corrupted initialized state fails closed instead of silently losing pending work', async () => {
  const created = (await json(await post({ targetId: 'x5', operation: 'probe' }), 202)).job; await settled(created.id); const filename = join(directory, 'manifest.json'); const bytes = await readFile(filename); await writeFile(filename, '{broken');
  assert.equal((await get('/jobs')).status, 503); assert.equal(requests.length, 1); await writeFile(filename, bytes); assert.equal((await json(await get('/jobs'))).jobs[0].id, created.id);
  await unlink(filename); assert.equal((await get('/jobs')).status, 503); assert.equal(requests.length, 1);
});

test('actual runner recovery stop supersedes unknown work and tombstones a delayed old deployment', async () => {
  // This exercises the production runner protocol, including its persistent
  // abandoned-ID journal, without launching an inference process or downloading.
  const { createEdgeLlmRunner } = await import(new URL('../../tools/edge-llm-runner.mjs', import.meta.url).href);
  const portProbe = createServer(); await new Promise<void>((done) => portProbe.listen(0, '127.0.0.1', done)); const portAddress = portProbe.address(); assert.ok(portAddress && typeof portAddress !== 'string'); const inferencePort = portAddress.port; await new Promise<void>((done) => portProbe.close(() => done()));
  const runner = await createEdgeLlmRunner({ board: 'X5', binary: '/usr/bin/false', modelDir: join(directory, 'runner-models'), port: inferencePort, models: [{ id: 'qwen-fixture', label: 'Qwen fixture', path: join(directory, 'runner-models/qwen-fixture.gguf'), sha256, quantization: 'Q4_K_M' }] }, { token, stateDir: join(directory, 'runner-state'), systemProbe: async () => ({ configuredBoard: 'X5', detectedBoard: null, identityVerification: 'unverified' }) });
  try {
    await new Promise<void>((done) => runner.server.listen(0, '127.0.0.1', done)); const address = runner.server.address(); assert.ok(address && typeof address !== 'string'); const realOrigin = 'http://127.0.0.1:' + address.port;
    let delayedPayload: Record<string, unknown> | undefined; let dropOnce = true;
    const fetcher: typeof fetch = async (input, init) => { if (dropOnce && init?.method === 'POST') { dropOnce = false; delayedPayload = JSON.parse(String(init.body)) as Record<string, unknown>; throw new Error('fixture transport lost before runner accepted'); } return fetch(input, init); };
    service = new EdgeLlmService({ dataDir: directory, adapters: [{ id: 'x5', label: 'Real protocol fixture', board: 'X5', url: realOrigin, token }], fetcher });
    const original = (await json(await post({ targetId: 'x5', operation: 'deploy', modelId: 'qwen-fixture' }), 202)).job; assert.equal((await settled(original.id)).status, 'unknown'); assert.equal(runner.getJob(original.id), null);
    assert.equal((await json(await get('/jobs/' + original.id))).job.status, 'unknown'); assert.equal((await post({ targetId: 'x5', operation: 'deploy', modelId: 'qwen-fixture' })).status, 409);
    assert.equal((await post({ targetId: 'x5', operation: 'stop', abandonJobIds: [original.id] })).status, 400);
    const recovery = (await json(await post({ targetId: 'x5', operation: 'stop' }), 202)).job; assert.deepEqual(recovery.inputs, {}); await settled(recovery.id);
    let recovered: Record<string, any> | undefined; const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { recovered = (await json(await get('/jobs/' + recovery.id))).job; if (recovered?.status === 'succeeded') break; await new Promise((done) => setTimeout(done, 10)); }
    assert.equal(recovered?.status, 'succeeded'); assert.equal(recovered?.result.inferencePortAvailable, true); assert.deepEqual(recovered?.result.abandonedJobIds, [original.id]);
    const superseded = (await json(await get('/jobs/' + original.id))).job; assert.equal(superseded.status, 'superseded'); assert.equal(superseded.outcome, 'unknown'); assert.equal(superseded.supersededByJobId, recovery.id); assert.ok(superseded.lastQueryError);
    assert.ok(delayedPayload); const late = await fetch(realOrigin + '/jobs', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(delayedPayload) }); assert.equal(late.status, 409); assert.equal((await late.json() as Record<string, unknown>).error, 'edge_llm_job_abandoned'); assert.equal(runner.getJob(original.id), null);
    const fresh = (await json(await post({ targetId: 'x5', operation: 'probe' }), 202)).job; assert.notEqual(fresh.id, original.id); await settled(fresh.id);
  } finally { await runner.close(); }
});
