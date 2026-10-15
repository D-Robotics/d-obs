import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { parseSshLogTargets, SshLogCollector } from './ssh-log-collector.js';
import { registerSshLogRoutes } from './ssh-log-routes.js';

const API = '/api/ops/observability/ssh-logs';
let origin: string;
let server: Server;
let collector: SshLogCollector;
let stateDir: string;
let spawnCount: number;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = { RDK_CREDITS_ADMIN_TOKEN: process.env.RDK_CREDITS_ADMIN_TOKEN, RDK_FLYWHEEL_ADMIN_USER_IDS: process.env.RDK_FLYWHEEL_ADMIN_USER_IDS };
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'test-admin-token';
  process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'user-a,user-b';
  configureObservabilityAccess({
    getSessionSsoUser: (req) => {
      const id = String(req.header('x-test-user') ?? '');
      return id ? { id, email: String(req.header('x-test-email') ?? 'shared@example.invalid') } : null;
    },
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });
  stateDir = await mkdtemp(path.join(tmpdir(), 'dobs-ssh-routes-'));
  const identityFile = path.join(stateDir, 'server-only-key');
  await writeFile(identityFile, 'test fixture; never used by SSH', { mode: 0o600 });
  spawnCount = 0;
  collector = new SshLogCollector({
    targets: parseSshLogTargets(JSON.stringify([{ id: 'x5', label: '测试 X5', host: 'configured-x5', user: 'sunrise', identityFile }])),
    stateDir,
    // Exercise the actual capture lifecycle using a local process, never SSH.
    spawnProcess: () => {
      spawnCount += 1;
      return spawn(process.execPath, ['-e', "process.stdout.write('isp init\\n'+'x'.repeat(1800)+'\\n');process.stderr.write('sensor warning\\n');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerSshLogRoutes(router, () => collector);
  app.use('/prefixed', router);
  app.use(router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await collector?.dispose();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetObservabilityAccessAdapter();
});

function headers(user = 'user-a'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-test-user': user, 'x-rdk-ops-action': 'observability' };
}

async function start(user = 'user-a'): Promise<string> {
  const response = await fetch(origin + API + '/sessions', {
    method: 'POST', headers: headers(user), body: JSON.stringify({ targetId: 'x5', sourceId: 'kernel' }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { session: { id: string } }).session.id;
}

test('SSH API is admin-gated without a telemetry database, redacts connection data, and works under a prefix', async () => {
  for (const suffix of ['/targets', '/sessions']) {
    assert.equal((await fetch(origin + API + suffix)).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-admin-token': 'wrong' } })).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-test-user': 'ordinary-user' } })).status, 403);
    assert.equal((await fetch(origin + API + suffix, { headers: { 'x-tenant-token': 'tenant-token' } })).status, 403);
  }
  const response = await fetch(origin + '/prefixed' + API + '/targets', { headers: { 'x-admin-token': 'test-admin-token' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.match(text, /rdk\.ssh-logs\.v1/);
  assert.match(text, /测试 X5/);
  for (const privateValue of ['configured-x5', 'sunrise', 'server-only-key', 'identityFile']) assert.ok(!text.includes(privateValue));
});

test('create rejects CSRF, runtime commands, arbitrary targets and invalid limits before spawning', async () => {
  const input = { targetId: 'x5', sourceId: 'kernel' };
  const missingGuard = await fetch(origin + API + '/sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'user-a' }, body: JSON.stringify(input) });
  assert.equal(missingGuard.status, 400);
  const foreignOrigin = await fetch(origin + API + '/sessions', { method: 'POST', headers: { ...headers(), origin: 'https://foreign.invalid' }, body: JSON.stringify(input) });
  assert.equal(foreignOrigin.status, 403);
  for (const body of [
    { ...input, command: 'touch /tmp/injected' }, { ...input, host: 'unconfigured' },
    { ...input, targetId: 'unconfigured' }, { ...input, sourceId: 'unconfigured' },
    { ...input, durationSeconds: -1 }, { ...input, lines: 0.5 }, { ...input, follow: 'yes' },
  ]) {
    const response = await fetch(origin + API + '/sessions', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    assert.ok(response.status >= 400 && response.status < 500, await response.text());
  }
  assert.equal(spawnCount, 0);
});

test('capture can be read, stopped and exported; stable account IDs isolate users sharing an email', async () => {
  const id = await start();
  let result: { records: Array<{ text: string }>; cursor: number; session: { state: string } } | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(origin + API + '/sessions/' + id + '?after=0&limit=500', { headers: headers() });
    assert.equal(response.status, 200);
    result = await response.json() as NonNullable<typeof result>;
    if (result!.records.map((record) => record.text).join('').includes('sensor warning')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(result);
  assert.match(result.records.map((record) => record.text).join(''), /x{1800}/);
  for (const suffix of ['', '/export']) {
    const response = await fetch(origin + API + '/sessions/' + id + suffix, { headers: headers('user-b') });
    assert.equal(response.status, 404);
  }
  assert.equal((await fetch(origin + API + '/sessions/' + id + '/stop', { method: 'POST', headers: headers('user-b') })).status, 404);
  const otherList = await (await fetch(origin + API + '/sessions', { headers: headers('user-b') })).json() as { sessions: unknown[] };
  assert.deepEqual(otherList.sessions, []);
  const stopped = await fetch(origin + API + '/sessions/' + id + '/stop', { method: 'POST', headers: headers() });
  assert.equal(stopped.status, 200);
  assert.equal(((await stopped.json()) as { session: { state: string } }).session.state, 'stopped');
  const exported = await fetch(origin + '/prefixed' + API + '/sessions/' + id + '/export', { headers: headers() });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
  const raw = await exported.text();
  assert.match(raw, /isp init/);
  assert.match(raw, /sensor warning/);
  assert.match(raw, /x{1800}/);
  const delta = await fetch(origin + API + '/sessions/' + id + '?after=' + result.cursor, { headers: headers() });
  assert.equal(delta.status, 200);
  const invalid = await fetch(origin + API + '/sessions/' + id + '?after=-1', { headers: headers() });
  assert.equal(invalid.status, 400);
});
