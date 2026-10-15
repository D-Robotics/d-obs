import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// A real loopback daemon with a deliberately missing SDK bridge. This verifies
// HTTP/protocol behavior and unready receipts, never a sensor or ISP pipeline.
const CONTRACT = 'rdk.vision-device-runner.v1';
const TOKEN = 'x5-http-fixture-private-token-0123456789';
const IDENTITY = {
  board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-unavailable',
  sensorVendor: 'Sony', cameraInterface: 'MIPI CSI-2', cameraMode: 'fixture-unverified-mode',
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function vacantLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startDaemon() {
  const dir = await mkdtemp(join(tmpdir(), 'vision-x5-http-'));
  const port = await vacantLoopbackPort();
  const stateDir = join(dir, 'state');
  const configFile = join(dir, 'camera.json');
  const config = {
    token: TOKEN, ...IDENTITY, nativeLibrary: join(dir, 'intentionally-missing-sdk.so'),
    sensorConfig: 'imx415-30fps-2lane', csiPort: 0, port, stateDir,
    colorMatrix: 'bt709', colorRange: 'limited', blackLevel: 0, whiteLevel: 1023, discardFrames: 1,
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./vision-x5-camera.py', import.meta.url)), '--config', configFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupError;
  let stderr = '';
  child.on('error', error => { startupError = error; });
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) {
        // Only the daemon's sanitized error code is relevant. No config/token.
        throw new Error(`Local daemon exited: ${stderr.trim().replaceAll(TOKEN, '[private]')}`);
      }
      try {
        const response = await fetch(url + '/capabilities', {
          headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(500),
        });
        if (response.status === 200) return { url, stateDir, close };
      } catch { /* Wait only for the child we started on loopback. */ }
      await delay(25);
    }
    throw new Error('Local daemon did not become available');
  } catch (error) {
    await close();
    throw error;
  }
}

function task(operation = 'probe', overrides = {}) {
  return {
    contract: CONTRACT, operation,
    context: { ...IDENTITY, experimentId: 'fixture-experiment', jobId: 'fixture-job' }, inputs: {},
    ...overrides,
  };
}

async function request(url, { path = '/execute', method = 'POST', token = TOKEN, body = task(), contentType = 'application/json' } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(method === 'POST' ? { 'content-type': contentType } : {}) },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const payload = await response.json();
  assert.ok(!JSON.stringify(payload).includes(TOKEN));
  return { status: response.status, payload };
}

async function rejects(url, options, error, status = 422) {
  const response = await request(url, options);
  assert.equal(response.status, status);
  assert.deepEqual(response.payload, { ok: false, error });
}

test('X5 daemon without native SDK gives real unready receipts and rejects invalid HTTP operations', { timeout: 20000 }, async t => {
  const fixture = await startDaemon();
  try {
    await t.test('capabilities advertises only implemented offline reads', async () => {
      const { status, payload } = await request(fixture.url, { method: 'GET', path: '/capabilities' });
      assert.equal(status, 200);
      assert.deepEqual(payload, {
        ok: true, contract: CONTRACT, ...IDENTITY, operations: ['probe', 'pipeline_validate'],
        implementation: 'x5-hbn-native-v1', hardwareVerified: false, sdkAvailable: false,
        nativeIspFormat: 'x5-hbn-isp-controls-v1', rawReplay: false, modeQualifications: { exposure:'qualification_required', awb:'qualification_required', hdr_exposure:'qualification_required' }, calibrationBindings: [],
      });
    });
    await t.test('probe records host filesystem evidence and unavailable native SDK', async () => {
      const { status, payload } = await request(fixture.url);
      assert.equal(status, 200);
      assert.equal(payload.ok, true);
      assert.equal(payload.contract, CONTRACT);
      assert.equal(payload.operation, 'probe');
      assert.equal(payload.jobId, 'fixture-job');
      const facts = payload.result.facts;
      assert.equal(facts.nativeSdkAvailable, false);
      assert.equal(facts.nativeSdkReason, 'native_sdk_unavailable');
      assert.equal(facts.hardwareVerified, false);
      assert.equal(facts.streaming, false);
      assert.equal(facts.writeOutcome, 'idle');
      assert.equal(facts.rawReplay, false);
      assert.equal(facts.environment.contract, 'rdk.vision-x5-preflight.v1');
      assert.equal(facts.environment.source, 'host-filesystem');
      assert.equal(facts.environment.ready, false);
      assert.equal(facts.environment.passed, false);
      assert.equal(facts.environment.hardwareVerified, false);
      assert.deepEqual(facts.environment.executedCommands, []);
      assert.ok(facts.environment.blockingReasons.includes('sdk_runtime_verified'));
      assert.ok(facts.environment.blockingReasons.includes('actual_frame_verified'));
      assert.equal(payload.result.baseline, undefined);
    });
    await t.test('pipeline validation cannot pass without a real current stream frame', async () => {
      const { status, payload } = await request(fixture.url, { body: task('pipeline_validate') });
      assert.equal(status, 200);
      assert.deepEqual(payload.result, {
        passed: false,
        checks: [{ name: 'native-sdk-and-config', passed: false }, { name: 'actual-current-stream-frame', passed: false }],
        evidence: { hardwareVerified: false, reason: 'actual_stream_required' },
      });
    });
    await t.test('absent and incorrect bearer tokens deny both reads and execution', async () => {
      for (const token of [null, 'wrong-private-token', 'wrong-é-token']) {
        await rejects(fixture.url, { token, method: 'GET', path: '/capabilities' }, 'unauthorized', 401);
        await rejects(fixture.url, { token }, 'unauthorized', 401);
      }
    });
    await t.test('unrecognized routes are not mapped to camera operations', async () => {
      await rejects(fixture.url, { method: 'GET', path: '/execute' }, 'not_found', 404);
      await rejects(fixture.url, { path: '/capabilities' }, 'not_found', 404);
    });
    await t.test('malformed and nonfinite JSON return sanitized failures', async () => {
      await rejects(fixture.url, { body: '{' }, 'camera_operation_failed');
      await rejects(fixture.url, { body: JSON.stringify(task()).replace('"inputs":{}', '"inputs":{"value":NaN}') }, 'nonfinite_json');
    });
    await t.test('content encoding and oversized request bodies fail before execution', async () => {
      await rejects(fixture.url, { contentType: 'text/plain' }, 'invalid_request_encoding');
      await rejects(fixture.url, { body: ' '.repeat(65537) }, 'request_limit');
    });
    await t.test('contract and exact envelope keys are required', async () => {
      for (const body of [null, [], task('probe', { contract: 'another-contract' }), { ...task(), extra: true }, { operation: 'probe' }]) {
        await rejects(fixture.url, { body }, 'invalid_contract');
      }
    });
    await t.test('every configured profile identity field is enforced', async () => {
      for (const key of Object.keys(IDENTITY)) {
        const context = { ...task().context, [key]: 'other-profile' };
        await rejects(fixture.url, { body: task('probe', { context }) }, 'profile_mismatch');
      }
      await rejects(fixture.url, { body: task('probe', { context: { ...task().context, extra: true } }) }, 'profile_mismatch');
      await rejects(fixture.url, { body: task('probe', { context: null }) }, 'profile_mismatch');
    });
    await t.test('job and experiment identities must be bounded safe strings', async () => {
      for (const key of ['jobId', 'experimentId']) {
        for (const value of ['', '../another-job', 'a'.repeat(129), 42, null]) {
          await rejects(fixture.url, { body: task('probe', { context: { ...task().context, [key]: value } }) }, 'invalid_job_identity');
        }
      }
    });
    await t.test('operation input schemas remain closed', async () => {
      await rejects(fixture.url, { body: task('probe', { inputs: { command: 'echo unsafe' } }) }, 'invalid_inputs');
      await rejects(fixture.url, { body: task('pipeline_validate', { inputs: { cameraMode: 'other' } }) }, 'invalid_inputs');
      await rejects(fixture.url, { body: task('probe', { inputs: null }) }, 'operation_unavailable');
    });
    await t.test('undeclared bringup and ISP writes fail with SDK unavailable', async () => {
      for (const operation of ['bringup', 'preview_start', 'controls_get']) {
        await rejects(fixture.url, { body: task(operation) }, 'native_sdk_unavailable');
      }
      await rejects(fixture.url, { body: task('process_raw') }, 'native_sdk_unavailable');
      assert.deepEqual(await readdir(fixture.stateDir), []);
    });
    await t.test('a rejected request does not prevent a later truthful validation', async () => {
      const { status, payload } = await request(fixture.url, { body: task('pipeline_validate', { context: { ...task().context, jobId: 'next-job' } }) });
      assert.equal(status, 200);
      assert.equal(payload.jobId, 'next-job');
      assert.equal(payload.result.passed, false);
    });
  } finally {
    await fixture.close();
  }
});
