import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { RdkLogCaptureService } from './rdk-log-capture.js';
import { SshLogCollectorError, type SshLogCollector, type SshLogRecord, type SshLogSession, type SshLogSource, type SshLogStartInput } from './ssh-log-collector.js';
import { registerRdkLogRoutes } from './rdk-log-routes.js';

const API = '/api/ops/observability/rdk-logs';
const sources: SshLogSource[] = [{ id: 'kernel', label: '内核', type: 'kernel' }, { id: 'logcat', label: '媒体日志', type: 'logcat' }];
class FixtureCollector {
  starts = 0; probes = 0;
  rows = new Map<string, { actor: string; session: SshLogSession; records: SshLogRecord[] }>();
  listTargets() { return [{ id: 'x5', label: '测试 X5', sources }]; }
  async probeTarget(targetId: string) {
    if (targetId !== 'x5') throw new SshLogCollectorError(404, 'unknown_target', 'Unknown');
    this.probes++;
    return { targetId, targetLabel: '测试 X5', probedAt: new Date().toISOString(), status: 'ready' as const, model: 'D-Robotics RDK X5', os: 'test OS', kernel: 'test kernel', capabilities: sources.map((source) => ({ source, status: 'readable' as const })) };
  }
  async start(input: SshLogStartInput, actor: string) {
    this.starts++;
    const id = randomUUID();
    const text = `E/TRACE ISP timeout token=RAW_SECRET\n${'x'.repeat(1800)}\n`;
    const session: SshLogSession = { id, targetId: input.targetId, targetLabel: '测试 X5', sourceId: input.sourceId, sourceLabel: sources.find((source) => source.id === input.sourceId)!.label, state: 'running', startedAt: new Date().toISOString(), recordCount: 1, byteCount: Buffer.byteLength(text) };
    this.rows.set(id, { actor, session, records: [{ seq: 1, receivedAt: session.startedAt, stream: 'stdout', text }] });
    return { ...session };
  }
  read(id: string, actor: string, after = 0, limit = 500) {
    const row = this.rows.get(id);
    if (!row || row.actor !== actor) throw new SshLogCollectorError(404, 'unknown_session', 'Unknown');
    const records = row.records.filter((record) => record.seq > after).slice(0, limit);
    return { session: { ...row.session }, records, cursor: records.at(-1)?.seq ?? after, hasMore: false };
  }
  async stop(id: string, actor: string) { const row = this.read(id, actor); this.rows.get(id)!.session.state = 'stopped'; return { ...row.session, state: 'stopped' as const }; }
}
let server: Server; let origin: string; let dir: string; let collector: FixtureCollector; let service: RdkLogCaptureService;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
  configureObservabilityAccess({ getSessionSsoUser: (req) => { const id = req.header('x-fixture-user'); return id ? { id, email: 'shared@example.invalid' } : null; }, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await mkdtemp(path.join(tmpdir(), 'rdk-logs-routes-'));
  collector = new FixtureCollector(); service = new RdkLogCaptureService({ collector, stateDir: dir });
  const app = express(); app.use(express.json()); const router = express.Router();
  registerRdkLogRoutes(router, { getService: () => service, getCollector: () => collector as unknown as SshLogCollector,
    callModel: async (messages) => {
      assert.doesNotMatch(JSON.stringify(messages), /RAW_SECRET/);
      const payload = JSON.parse(messages[1]!.content) as { items: Array<{ ref: string }> };
      return { model: 'fixture-model', text: JSON.stringify({ headline: 'ISP超时需要验证', summary: '尚不能确定根因', hypotheses: [{ title: '媒体链路可能超时', evidenceRefs: [payload.items[0]!.ref], nextCheck: '补采启动前日志' }] }) };
    } });
  app.use('/prefix', router); app.use(router); server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await service?.dispose();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) await rm(dir, { force: true, recursive: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  resetObservabilityAccessAdapter();
});
function headers(actor = 'alice') { return { 'content-type': 'application/json', 'x-fixture-user': actor, 'x-rdk-ops-action': 'observability' }; }
async function post(suffix: string, value: unknown, actor = 'alice') { return fetch(origin + API + suffix, { method: 'POST', headers: headers(actor), body: JSON.stringify(value) }); }
async function start() { const response = await post('/captures', { targetId: 'x5', question: '相机ISP启动超时' }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json() as { capture: { id: string } }).capture.id; }

test('RDK API/MCP are admin guarded without a database; mutations require same-origin action guard', async () => {
  for (const suffix of ['/capabilities', '/profiles', '/targets', '/captures']) {
    assert.equal((await fetch(origin + API + suffix)).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-admin-token': 'wrong' } })).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-fixture-user': 'outsider' } })).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-tenant-token': 'tenant-only' } })).status, 403);
  }
  assert.equal((await fetch(origin + '/prefix' + API + '/capabilities', { headers: headers() })).status, 200);
  const input = { targetId: 'x5', profileId: 'x5-isp' };
  assert.equal((await fetch(origin + API + '/captures', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': 'alice' }, body: JSON.stringify(input) })).status, 400);
  assert.equal((await fetch(origin + API + '/captures', { method: 'POST', headers: { ...headers(), origin: 'https://foreign.invalid' }, body: JSON.stringify(input) })).status, 403);
  for (const value of [{ ...input, command: 'bad' }, { ...input, host: 'unconfigured' }, { ...input, sourceIds: ['unknown'] }, { ...input, durationSeconds: 99999 }]) assert.ok((await post('/captures', value)).status >= 400);
  assert.equal(collector.starts, 0);
});

test('plan, grouped capture, cursors, markers, evidence, model references and raw bundle complete one investigation', async () => {
  const planResponse = await post('/plan', { targetId: 'x5', question: 'ISP超时' });
  assert.equal(planResponse.status, 200);
  const plan = (await planResponse.json() as { plan: { profileId: string; sources: unknown[] } }).plan;
  assert.equal(plan.profileId, 'x5-isp'); assert.equal(plan.sources.length, 2);
  const id = await start();
  const response = await fetch(origin + API + '/captures/' + id, { headers: headers() });
  const read = await response.json() as { streams: Array<{ session: SshLogSession; records: SshLogRecord[]; cursor: number }> };
  assert.equal(read.streams.length, 2); assert.match(read.streams[0]!.records[0]!.text, /RAW_SECRET/);
  const cursors = Object.fromEntries(read.streams.map((stream) => [stream.session.id, stream.cursor]));
  const tail = await fetch(origin + API + '/captures/' + id + '?cursors=' + encodeURIComponent(JSON.stringify(cursors)), { headers: headers() });
  assert.ok((await tail.json() as typeof read).streams.every((stream) => !stream.records.length));
  assert.equal((await post('/captures/' + id + '/markers', { label: '复现超时' })).status, 200);
  const evidenceResponse = await fetch(origin + API + '/captures/' + id + '/evidence', { headers: headers() });
  const evidenceText = await evidenceResponse.text(); assert.doesNotMatch(evidenceText, /RAW_SECRET/); assert.match(evidenceText, /rlog:/);
  const analysis = await post('/captures/' + id + '/analysis', { mode: 'model' });
  assert.equal(analysis.status, 200, await analysis.clone().text());
  assert.equal((await analysis.json() as { analysis: { source: string } }).analysis.source, 'model');
  assert.equal((await post('/captures/' + id + '/stop', {})).status, 200);
  const bundleResponse = await fetch(origin + API + '/captures/' + id + '/bundle', { headers: headers() });
  assert.match(bundleResponse.headers.get('content-disposition')!, /attachment/);
  const bundle = await bundleResponse.text(); assert.match(bundle, /RAW_SECRET/); assert.match(bundle, /x{1800}/); assert.match(bundle, /复现超时/);
});

test('REST and agent tools cannot read, mark, stop or analyze another account capture', async () => {
  const id = await start();
  for (const suffix of ['', '/evidence', '/bundle']) assert.equal((await fetch(origin + API + '/captures/' + id + suffix, { headers: headers('bob') })).status, 404);
  for (const suffix of ['/stop', '/markers', '/analysis']) assert.equal((await post('/captures/' + id + suffix, suffix === '/markers' ? { label: 'bad' } : {}, 'bob')).status, 404);
  const mcp = await fetch(origin + '/api/ops/rdk-logs/mcp', { method: 'POST', headers: headers('bob'), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rdk_logs_read_capture', arguments: { captureId: id } } }) });
  const result = await mcp.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(result.result.isError, true); assert.match(result.result.content[0]!.text, /unknown_capture/); assert.doesNotMatch(JSON.stringify(result), /RAW_SECRET/);
});

test('MCP discovery and tools use the same allowlisted lifecycle, reject arbitrary arguments and keep notifications side-effect free', async () => {
  const rpc = async (message: unknown) => fetch(origin + '/api/ops/rdk-logs/mcp', { method: 'POST', headers: headers(), body: JSON.stringify(message) });
  const tools = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const json = await tools.json() as { result: { tools: Array<{ name: string }> } };
  assert.ok(json.result.tools.some((tool) => tool.name === 'rdk_logs_analyze'));
  const bad = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rdk_logs_start_capture', arguments: { targetId: 'x5', command: 'uname' } } });
  assert.equal((await bad.json() as { result: { isError: boolean } }).result.isError, true);
  assert.equal(collector.starts, 0);
  const notify = await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'rdk_logs_start_capture', arguments: { targetId: 'x5' } } });
  assert.equal(notify.status, 202); assert.equal(collector.starts, 0);
  const started = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rdk_logs_start_capture', arguments: { targetId: 'x5', question: 'ISP' } } });
  const result = await started.json() as { result: { content: Array<{ text: string }> } };
  const capture = JSON.parse(result.result.content[0]!.text) as { id: string };
  assert.ok(capture.id); assert.equal(collector.starts, 2);
});
