// Black-box end-to-end harness for the rdk-camera-workshop connector.
// Boots the real vision-workshop HTTP service as a detached local process,
// then verifies the shipped bridge and setup CLI against it: doctor success,
// real tools/call round-trip, and the failure contract. The service must run
// detached because some sandboxed environments refuse cross-process loopback
// connects to in-process listeners.
// Run: node --import tsx --test tools/vision-workshop-bridge-e2e.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(repoRoot, 'plugins', 'rdk-camera-workshop', 'mcp', 'bridge.mjs');
const setup = path.join(repoRoot, 'plugins', 'rdk-camera-workshop', 'mcp', 'setup.mjs');
const serverEntry = path.join(repoRoot, 'tools', 'vision-workshop-bridge-e2e-server.mts');
const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('bridge black box: doctor connects, tools round-trip, failure contract holds', async () => {
  const service = spawn(process.execPath, ['--import', 'tsx', serverEntry], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const readyLine = await new Promise((resolve, reject) => {
    let out = '';
    service.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
    });
    service.stderr.on('data', chunk => { out = out; });
    setTimeout(() => reject(new Error('bridge-e2e service not ready: ' + out.slice(0, 200))), 30_000);
  });
  assert.equal(readyLine.ready, true);
  assert.equal(readyLine.seeded, true);
  const origin = `http://127.0.0.1:${readyLine.port}/dobs`;
  const { deadPort } = await new Promise(resolve => {
    const dead = createServer(); dead.listen(0, '127.0.0.1', () => { const port = dead.address().port; dead.close(() => resolve({ deadPort: port })); });
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-e2e-config-'));
  const credentialFile = path.join(directory, 'credential'); const config = path.join(directory, 'connection.json');
  const writeConfig = async url => {
    await writeFile(credentialFile, 'bridge-e2e-token', { mode: 0o600 });
    await writeFile(config, JSON.stringify({ url, auth: { type: 'admin', credentialFile }, timeoutMs: 15000 }, null, 2) + '\n', { mode: 0o600 });
  };
  try {
    await writeConfig(origin + '/api/ops/vision-workshop/mcp');

    const doctorRun = spawnSync(process.execPath, [setup, 'doctor'], { env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: config }, encoding: 'utf8' });
    assert.equal(doctorRun.status, 0, doctorRun.stderr);
    const status = JSON.parse(doctorRun.stdout);
    assert.equal(status.status, 'connected'); assert.equal(status.runtime, 'responded'); assert.equal(status.hardware, 'unverified');
    assert.ok(status.toolCount > 10);
    assert.ok(!doctorRun.stdout.includes(directory));

    const child = spawn(process.execPath, [bridge], { env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    const exited = new Promise(resolve => child.on('close', resolve));
    child.stdin.end([rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-e2e', version: '1.0.0' } }),
      rpc(11, 'tools/call', { name: 'vision_experiment_list', arguments: {} })].join('\n') + '\n');
    assert.equal(await exited, 0);
    const call = stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.id === 11);
    assert.equal(call.error, undefined);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.data.experiments[0].title, '连接器黑盒端到端');
    assert.equal(payload.data.total, 1);

    await writeConfig(`http://127.0.0.1:${deadPort}/dobs/api/ops/vision-workshop/mcp`);
    const failureRun = spawnSync(process.execPath, [setup, 'doctor'], { env: { ...process.env, RDK_CAMERA_WORKSHOP_CONFIG: config }, encoding: 'utf8' });
    assert.equal(failureRun.status, 1);
    assert.equal(failureRun.stdout, '');
    const failure = JSON.parse(failureRun.stderr);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.code, 'camera_bridge_remote_transport_failed');
    assert.match(failure.advice, /无法访问相机服务/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    service.kill();
  }
});
