import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVisionDeviceRunner, VISION_RUNNER_CONTRACT } from './vision-workshop-device-runner.mjs';

const TOKEN = 'fixture-private-sdk-token-at-least-24';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const TUNING = { gamma: { strength: 1.2 } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const RAW = Buffer.from([0, 0, 0, 2, 0, 1, 255, 3]);
const META = { scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 };
const fixtureSource = `
import { readFile, writeFile, mkdir, symlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const [mode, requestFile, rawFile, tuningFile, root] = process.argv.slice(2);
const hash = value => createHash('sha256').update(value).digest('hex');
if (mode === 'ignore-sigterm-child') {
  process.on('SIGTERM', () => {});
  await writeFile(requestFile, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  const jobDir = process.cwd();
  const save = result => writeFile(join(jobDir, 'result.json'), JSON.stringify(result));
  if (mode === 'nonzero') { await save({ passed: true }); process.exit(7); }
  else if (mode === 'oversized-result') {
    const file = await open(join(jobDir, 'result.json'), 'w'); await file.truncate(96 * 1024 * 1024 + 1); await file.close();
  }
  else if (mode === 'missing-result') process.stdout.write('passed=true PRIVATE_LOG_ONLY');
  else if (mode === 'output-limit') {
    process.stdout.write('PRIVATE_STDOUT'.repeat(13000)); process.stderr.write('PRIVATE_STDERR'.repeat(13000));
    await save({ passed: true });
  } else if (mode === 'slow' || mode === 'slow-with-child') {
    if (mode === 'slow-with-child') {
      spawn(process.execPath, [process.argv[1], 'ignore-sigterm-child', join(root, 'child.pid')], { stdio: 'ignore' });
      for (let index = 0; index < 100; index++) { try { await readFile(join(root, 'child.pid')); break; } catch { await new Promise(done => setTimeout(done, 5)); } }
    }
    await writeFile(join(root, 'started.pid'), String(process.pid)); setInterval(() => {}, 1000);
  } else if (request.operation === 'capture_raw') {
    const bytes = Buffer.from([0,0,0,2,0,1,255,3]);
    const metadata = { scene: request.inputs.scene, width:2,height:2,bitDepth:10,bayer:'RGGB',packing:'unpacked16le',stride:4,blackLevel:0,whiteLevel:1023 };
    await mkdir(join(jobDir, 'artifacts'));
    await writeFile(join(jobDir, 'artifacts', 'frame.raw'), bytes);
    let artifactFile = 'artifacts/frame.raw';
    if (mode === 'symlink') { await symlink(join(root, 'outside.raw'), join(jobDir, 'leak.raw')); artifactFile = 'leak.raw'; }
    if (mode === 'traversal') artifactFile = '../outside.raw';
    if (mode === 'invalid-packing') { metadata.bitDepth = 12; metadata.packing = 'mipi-raw10'; }
    await save({ filename: 'captured.raw', metadata, artifactFile, ...(mode === 'bad-hash' ? { sha256: '0'.repeat(64) } : {}) });
  } else if (request.operation === 'preview_start') {
    await save({ running: true, width: 1, height: 1, fps: 30 });
  } else if (request.operation === 'preview_stop') {
    await save({ running: false });
  } else if (request.operation === 'controls_get' || request.operation === 'controls_set') {
    const requested = request.inputs.values ?? {};
    await save({ controls: { exposureUs: { value: mode === 'wrong-control-readback' ? 4900 : requested.exposureUs ?? 1000, min: 100, max: 5000, step: 100, writable: true, active: mode !== 'inactive-control-readback' }, autoExposure: { value: requested.autoExposure ?? false, writable: true } } });
  } else if (request.operation === 'preview_frame' || request.operation === 'capture_frame') {
    await writeFile(join(jobDir, 'camera.png'), Buffer.from('${PNG.toString('base64')}', 'base64'));
    await save({ filename: 'camera.png', mimeType: 'image/png', artifactFile: 'camera.png', capturedAt: '2026-10-13T00:00:00.000Z', tuningHash: hash(JSON.stringify(${JSON.stringify(TUNING)})) });
  } else if (request.operation === 'process_raw') {
    const raw = await readFile(rawFile); const tuning = await readFile(tuningFile);
    if (hash(raw) !== request.inputs.raw.sha256 || hash(tuning) !== request.inputs.tuningHash) process.exit(8);
    if (request.inputs.raw.contentBase64 !== undefined) process.exit(9);
    const png = mode === 'invalid-image' ? Buffer.from('not a PNG') : Buffer.from('${PNG.toString('base64')}', 'base64');
    await writeFile(join(jobDir, 'processed.png'), png);
    await writeFile(join(jobDir, 'loaded.json'), tuning);
    const readback = await readFile(join(jobDir, 'loaded.json'));
    const witness = { rawHash: hash(raw), tuningHash: hash(tuning), readbackHash: hash(readback) };
    if (mode === 'missing-replay-witness') delete witness.readbackHash;
    if (mode === 'wrong-raw-witness') witness.rawHash = '0'.repeat(64);
    if (mode === 'wrong-tuning-witness') witness.tuningHash = '0'.repeat(64);
    if (mode === 'wrong-replay-readback') witness.readbackHash = '0'.repeat(64);
    await save({ filename: 'processed.png', mimeType: 'image/png', artifactFile: 'processed.png', ...witness });
  } else if (['apply_tuning', 'restore_tuning'].includes(request.operation)) {
    // Fixture simulates load/readback via two real files, not a real ISP device.
    const bytes = await readFile(tuningFile); await writeFile(join(jobDir, 'loaded.json'), bytes);
    const readback = await readFile(join(jobDir, 'loaded.json'));
    await save({ appliedHash: hash(bytes), readbackHash: mode === 'wrong-readback' ? '0'.repeat(64) : hash(readback) });
  } else await save({ passed: true, facts: { sensorModel: request.context.sensorModel, jobId: request.context.jobId }, checks: [{ label:'fixture check', passed:true }] });
}
`;

// Allow subprocess startup under parallel CI load; explicit timeout cases keep their own short budgets.
async function start({ modes = {}, timeoutMs = 5000, identity = {}, operations = ['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vision-runner-test-'));
  const fixture = join(dir, 'fixture-sdk.mjs'); await writeFile(fixture, fixtureSource, { mode: 0o600 });
  await writeFile(join(dir, 'outside.raw'), RAW);
  const commands = Object.fromEntries(operations.map(operation => [operation, { argv: [process.execPath, fixture, modes[operation] ?? operation, '{requestFile}',
    operation === 'process_raw' ? '{rawFile}' : '-', ['process_raw', 'apply_tuning', 'restore_tuning'].includes(operation) ? '{tuningFile}' : '-', dir] }]));
  const config = { token: TOKEN, board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-1', ...identity, jobRoot: join(dir, 'jobs'), timeoutMs, commands };
  const context = Object.fromEntries(['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'].flatMap(key => config[key] === undefined ? [] : [[key, config[key]]]));
  const server = createVisionDeviceRunner(config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (operation, inputs = {}, overrides = {}, fetchOptions = {}) => {
    const response = await fetch(url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: VISION_RUNNER_CONTRACT, operation,
        context: { jobId: 'job-' + Math.random().toString(16).slice(2), experimentId: 'experiment-a', ...context }, inputs, ...overrides }), ...fetchOptions });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => { server.closeIdleConnections(); await new Promise(done => server.close(done)); await rm(dir, { recursive: true, force: true }); };
  return { server, config, context, dir, url, request, close };
}
function inputs(operation) {
  if (operation === 'capture_raw') return { scene: '逆光' };
  if (operation === 'apply_tuning') return { tuning: TUNING, tuningHash: sha(JSON.stringify(TUNING)) };
  if (operation === 'process_raw') return { raw: { filename: 'frame.raw', metadata: META, sha256: sha(RAW), contentBase64: RAW.toString('base64') }, ...inputs('apply_tuning') };
  return {};
}
const delay = ms => new Promise(done => setTimeout(done, ms));
async function readEventually(path) {
  // writeFile creates the PID file before writing its contents. Wait for the
  // complete handshake, otherwise Number('') becomes process-group PID 0.
  for (let index = 0; index < 100; index++) {
    try {
      const value = await readFile(path, 'utf8');
      if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 1) return value;
    } catch { /* fixture has not published its PID */ }
    await delay(10);
  }
  throw new Error('fixture did not start');
}
async function waitForDead(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Expected an actual fixture PID');
  for (let index = 0; index < 100; index++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(10);
  }
  let state = '';
  try { state = execFileSync('ps', ['-o', 'pid=,ppid=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* process may exit during diagnostics */ }
  assert.fail('SDK process was not killed: pid=' + pid + ' state=' + state);
}

test('all endpoints require bearer auth and advertised capabilities list only configured SDK operations', async () => {
  const runner = await start({ operations: ['probe'] });
  try {
    for (const path of ['/capabilities', '/execute']) {
      const response = await fetch(runner.url + path);
      assert.equal(response.status, 401); assert.deepEqual(await response.json(), { ok: false, error: 'vision_runner_unauthorized' });
    }
    const capabilities = await fetch(runner.url + '/capabilities', { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await capabilities.json();
    assert.deepEqual(body.operations, ['probe']); assert.equal(body.sdkVersion, 'fixture-sdk-1');
    assert.doesNotMatch(JSON.stringify(body), /fixture-private|fixture-sdk\.mjs|commands/);
    assert.equal((await runner.request('capture_raw', inputs('capture_raw'))).status, 503);
  } finally { await runner.close(); }
});

test('fixed SDK fixture commands write real artifacts, hashes and receipts for all six atomic operations', async () => {
  const runner = await start();
  try {
    for (const operation of ['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning']) {
      const result = await runner.request(operation, inputs(operation));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.ok, true); assert.equal(result.body.contract, VISION_RUNNER_CONTRACT); assert.equal(result.body.operation, operation);
      if (operation === 'capture_raw') {
        assert.deepEqual(Buffer.from(result.body.result.contentBase64, 'base64'), RAW);
        assert.equal(result.body.result.sha256, sha(RAW)); assert.deepEqual(result.body.result.metadata, META);
        assert.equal(result.body.result.artifactFile, undefined);
      } else if (operation === 'process_raw') {
        assert.deepEqual(Buffer.from(result.body.result.contentBase64, 'base64'), PNG);
        assert.equal(result.body.result.sha256, sha(PNG));
        assert.equal(result.body.result.rawHash, sha(RAW));
        assert.equal(result.body.result.tuningHash, sha(JSON.stringify(TUNING)));
        assert.equal(result.body.result.readbackHash, sha(JSON.stringify(TUNING)));
      } else if (operation === 'apply_tuning') {
        assert.equal(result.body.result.appliedHash, sha(JSON.stringify(TUNING)));
        assert.equal(result.body.result.readbackHash, sha(JSON.stringify(TUNING)));
      } else assert.equal(result.body.result.facts.jobId, result.body.jobId);
      // Private transient job files are cleaned after producing the response.
      await delay(10);
    }
    assert.deepEqual(await readdir(join(runner.dir, 'jobs')), []);
  } finally { await runner.close(); }
});

test('client-supplied commands, paths, endpoints, Sensor/SDK mismatches and noncanonical bytes cannot reach an SDK command', async () => {
  const runner = await start();
  try {
    const cases = [
      ['probe', { command: 'touch /tmp/pwn' }, {}], ['bringup', { configFile: '/etc/passwd' }, {}],
      ['probe', {}, { url: 'https://evil.test', command: ['sh', '-c', 'echo pwn'] }],
      ['probe', {}, { context: { jobId: 'job', experimentId: 'exp', board: 'RDK X5', sensorModel: 'IMX999', sdkVersion: 'fixture-sdk-1' } }],
      ['probe', {}, { context: { jobId: 'job', experimentId: 'exp', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'other-sdk' } }],
      ['probe', {}, { context: { experimentId: 'exp', board: 'RDK X5', sensorModel: 'IMX415' } }],
      ['process_raw', { ...inputs('process_raw'), raw: { ...inputs('process_raw').raw, sha256: '0'.repeat(64) } }, {}],
      ['process_raw', { ...inputs('process_raw'), tuningHash: '0'.repeat(64) }, {}],
      ['process_raw', { ...inputs('process_raw'), raw: { ...inputs('process_raw').raw, filename: '../frame.raw' } }, {}],
      ['process_raw', { ...inputs('process_raw'), raw: { ...inputs('process_raw').raw, contentBase64: RAW.toString('base64') + '\n' } }, {}],
      ['process_raw', { ...inputs('process_raw'), raw: { ...inputs('process_raw').raw, contentBase64: 'AB==' } }, {}],
    ];
    for (const [operation, parameters, override] of cases) {
      const result = await runner.request(operation, parameters, override);
      assert.ok([400, 409].includes(result.status), JSON.stringify(result));
      assert.equal(result.body.ok, false); await delay(5);
    }
    // The request schema carries no argv from the remote caller.
    assert.deepEqual(await readdir(runner.dir), ['fixture-sdk.mjs', 'outside.raw']);
  } finally { await runner.close(); }
});

test('stdout cannot claim success and nonzero exits, missing receipts and combined log limits fail without log disclosure', async () => {
  for (const mode of ['nonzero', 'missing-result', 'output-limit', 'oversized-result']) {
    const runner = await start({ modes: { probe: mode }, operations: ['probe'] });
    try {
      const result = await runner.request('probe');
      assert.equal(result.status, 502); assert.equal(result.body.ok, false);
      assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|passed=true/);
    } finally { await runner.close(); }
  }
});

test('a multi-megabyte Raw uses bounded canonical base64 validation without exhausting the regexp stack', async () => {
  const runner = await start({ operations: ['process_raw'], timeoutMs: 2000 });
  try {
    const bytes = Buffer.alloc(12 * 1024 * 1024);
    const metadata = { ...META, width: 2048, height: 3072, stride: 4096 };
    const result = await runner.request('process_raw', { ...inputs('apply_tuning'), raw: { filename: 'large.raw', metadata, sha256: sha(bytes), contentBase64: bytes.toString('base64') } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.result.sha256, sha(PNG));
  } finally { await runner.close(); }
});

test('the declared request budget rejects oversized uploads before executing an SDK command', async () => {
  const runner = await start({ operations: ['probe'] });
  try {
    const result = await new Promise((done, reject) => {
      const request = httpRequest(runner.url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(96 * 1024 * 1024 + 1) } });
      request.once('response', response => { let content = ''; response.on('data', bytes => { content += bytes; }); response.once('end', () => { done({ status: response.statusCode, body: JSON.parse(content) }); request.destroy(); }); });
      request.once('error', reject); request.end('{}');
    });
    assert.equal(result.status, 413); assert.equal(result.body.error, 'vision_runner_request_limit');
    assert.deepEqual(await readdir(runner.dir), ['fixture-sdk.mjs', 'outside.raw']);
  } finally { await runner.close(); }
});

test('SDK output traversal, symlinks, false hashes, wrong Raw packing and invalid image/readback are rejected', async () => {
  for (const [operation, mode] of [['capture_raw', 'traversal'], ['capture_raw', 'symlink'], ['capture_raw', 'bad-hash'],
    ['capture_raw', 'invalid-packing'], ['process_raw', 'invalid-image'], ['process_raw', 'missing-replay-witness'],
    ['process_raw', 'wrong-raw-witness'], ['process_raw', 'wrong-tuning-witness'], ['process_raw', 'wrong-replay-readback'],
    ['apply_tuning', 'wrong-readback']]) {
    const runner = await start({ modes: { [operation]: mode }, operations: [operation] });
    try {
      const result = await runner.request(operation, inputs(operation));
      assert.equal(result.status, 502, `${mode}: ${JSON.stringify(result.body)}`); assert.equal(result.body.ok, false);
      assert.equal(result.body.result, undefined);
    } finally { await runner.close(); }
  }
});

test('one device execution holds a serial lock; timeout kills the child and releases the lock', async () => {
  const runner = await start({ modes: { pipeline_validate: 'slow' }, timeoutMs: 250, operations: ['pipeline_validate', 'probe'] });
  try {
    const first = runner.request('pipeline_validate'); const pid = Number(await readEventually(join(runner.dir, 'started.pid')));
    assert.equal((await runner.request('probe')).status, 429);
    assert.equal((await first).status, 504);
    await waitForDead(pid); await delay(20);
    assert.equal((await runner.request('probe')).status, 200);
  } finally { await runner.close(); }
});

test('a disconnected caller kills the SDK process group, including a child that ignores SIGTERM', async () => {
  const runner = await start({ modes: { pipeline_validate: 'slow-with-child' }, timeoutMs: 2000, operations: ['pipeline_validate', 'probe'] });
  try {
    const controller = new AbortController();
    const first = runner.request('pipeline_validate', {}, {}, { signal: controller.signal });
    const rejected = assert.rejects(first, /abort/i);
    const pid = Number(await readEventually(join(runner.dir, 'started.pid')));
    const childPid = Number(await readEventually(join(runner.dir, 'child.pid')));
    controller.abort(); await rejected; await waitForDead(pid); await waitForDead(childPid); await delay(20);
    assert.equal((await runner.request('probe')).status, 200);
  } finally { await runner.close(); }
});

test('private config rejects weak credentials, shell strings, unapproved placeholders and unsafe executable paths', () => {
  const base = { token: TOKEN, board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-1', commands: { probe: { argv: [process.execPath, '/private/sdk.mjs', '{requestFile}'] } } };
  for (const override of [
    { token: 'short' }, { token: TOKEN + '\n' }, { board: undefined }, { sensorModel: '' }, { sdkVersion: '' }, { timeoutMs: 120001 },
    { commands: { probe: { argv: 'sh -c echo pwn' } } }, { commands: { probe: { argv: ['node', '/private/sdk.mjs'] } } },
    { commands: { probe: { argv: [process.execPath, '{clientCommand}'] } } },
    { commands: { probe: { argv: [process.execPath, '{rawFile}'] } } }, { commands: { invented: { argv: [process.execPath] } } },
  ]) assert.throws(() => createVisionDeviceRunner({ ...base, ...override }), /vision_runner_/);
});
test('runner checks complete declared identity for arbitrary boards and camera families', async () => {
  const runner = await start({ identity: { board: 'Fixture board B', sensorVendor: 'OmniVision', sensorModel: 'OV9281', cameraInterface: 'CSI-2', cameraMode: '1280x720@60', sdkVersion: 'sdk-other' }, operations: ['probe'] });
  try {
    const response = await fetch(runner.url + '/capabilities', { headers: { authorization: `Bearer ${TOKEN}` } });
    const capabilities = await response.json();
    for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode']) assert.equal(capabilities[field], runner.config[field]);
    for (const field of ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode']) {
      const result = await runner.request('probe', {}, { context: { ...runner.context, jobId: 'job', experimentId: 'exp', [field]: 'different' } });
      assert.equal(result.status, 409);
    }
    assert.equal((await runner.request('probe')).status, 200);
  } finally { await runner.close(); }
});

test('CLI starts from a private config without installed dependencies or a real device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vision-runner-cli-'));
  const config = join(dir, 'runner.json');
  await writeFile(config, JSON.stringify({ token: TOKEN, board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'fixture-sdk-1', commands: {} }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('tools/vision-workshop-device-runner.mjs'), '--config', config, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI startup timeout')), 2000);
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('configured operations')) { clearTimeout(timer); done(); } });
      child.once('error', reject); child.once('exit', code => { if (!output.includes('configured operations')) { clearTimeout(timer); reject(new Error(`CLI exited ${code}`)); } });
    });
    assert.match(output, /127\.0\.0\.1:\d+; 0 configured operations/); assert.doesNotMatch(output, /fixture-private/);
  } finally { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; await rm(dir, { recursive: true, force: true }); }
});

test('explicit fixture SDK validates preview frame bytes, controls readback and tuning restoration over HTTP', async () => {
  const operations = ['preview_start', 'preview_frame', 'preview_stop', 'capture_frame', 'controls_get', 'controls_set', 'restore_tuning'];
  const runner = await start({ operations });
  try {
    const preview = await runner.request('preview_start'); assert.equal(preview.status, 200); assert.equal(preview.body.result.running, true);
    for (const operation of ['preview_frame', 'capture_frame']) {
      const result = await runner.request(operation); assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(Buffer.from(result.body.result.contentBase64, 'base64'), PNG);
      assert.equal(result.body.result.sha256, sha(PNG)); assert.equal(result.body.result.width, 1); assert.equal(result.body.result.metadata, undefined);
    }
    const get = await runner.request('controls_get'); assert.equal(get.body.result.controls.exposureUs.active, true);
    const set = await runner.request('controls_set', { values: { exposureUs: 1200, autoExposure: true } });
    assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.result.controls.exposureUs.value, 1200);
    assert.equal(set.body.result.controls.autoExposure.value, true);
    const restored = await runner.request('restore_tuning', inputs('apply_tuning')); assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.result.readbackHash, sha(JSON.stringify(TUNING)));
    assert.equal((await runner.request('preview_stop')).body.result.running, false);
    assert.equal((await runner.request('capture_frame', { command: 'fake-camera' })).status, 400);
  } finally { await runner.close(); }
  const mismatch = await start({ operations: ['controls_set'], modes: { controls_set: 'wrong-control-readback' } });
  try { assert.equal((await mismatch.request('controls_set', { values: { exposureUs: 1200 } })).body.error, 'vision_runner_control_readback_mismatch'); }
  finally { await mismatch.close(); }
  const inactive = await start({ operations: ['controls_set'], modes: { controls_set: 'inactive-control-readback' } });
  try { assert.equal((await inactive.request('controls_set', { values: { exposureUs: 1200 } })).body.error, 'vision_runner_control_readback_mismatch'); }
  finally { await inactive.close(); }
});
