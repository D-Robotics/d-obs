/** Isolated real software path. Synthetic sessions; never production SSO/hardware. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { parseArgs } = await import('node:util');
const { resolve } = await import('node:path');
const { values } = parseArgs({ options: { 'studio-root': { type: 'string' }, 'platform-root': { type: 'string' }, python: { type: 'string' }, 'output-dir': { type: 'string' } }, strict: true });
if (!values['studio-root'] || !values['platform-root'] || !values.python) {
    console.error('Usage: node compiled-software-e2e.mjs --studio-root <release> --platform-root <release> --python <venvpython> [--output-dir <private-new-dir>]');
    process.exit(2);
}
const candidateRoots = { studio: await realpath(resolve(values['studio-root'])), platform: await realpath(resolve(values['platform-root'])) };
const compiledRoot = (root, subdirs, file) => { for (const sub of subdirs) {
    const dir = join(root, sub);
    if (existsSync(join(dir, file)))
        return dir;
} throw new Error('Compiled camera module missing: ' + file); };
const STUDIO = compiledRoot(candidateRoots.studio, ['dist-server', ''], 'server/vision-workshop/bridge.js');
const DOBS = compiledRoot(candidateRoots.platform, ['dist', ''], 'server/monitoring/vision-workshop-routes.js');
const PYTHON = resolve(values.python);
// Keep the venv entry point: dereferencing its symlink changes Python's sys.prefix.
const { access, stat } = await import('node:fs/promises');
const { constants } = await import('node:fs');
const pythonTarget = await realpath(PYTHON);
if (!(await stat(pythonTarget)).isFile()) throw new Error('Python executable target is not a regular file');
await access(PYTHON, constants.X_OK);
const CALIBRATION_SCRIPT = join(candidateRoots.platform, 'tools/vision-x5-calibration.py');
if (!existsSync(CALIBRATION_SCRIPT))
    throw new Error('Candidate calibration Python script missing');
export const output = resolve(values['output-dir'] || join(dirname(fileURLToPath(import.meta.url)), 'compiled-proof-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + randomBytes(4).toString('hex')));
await mkdir(output, { recursive: true, mode: 0o700 });
const hash = (v) => createHash('sha256').update(v).digest('hex');
const runnerSha256AtStart = hash(await readFile(fileURLToPath(import.meta.url)));
const initialRuntimeFiles = [
  [STUDIO,'server/vision-workshop/bridge.js'],[STUDIO,'server/vision-workshop/account-assertion.js'],[STUDIO,'server/routes/vision-workshop-routes.js'],
  [DOBS,'server/monitoring/vision-workshop-access.js'],[DOBS,'server/monitoring/vision-workshop-routes.js'],[DOBS,'server/monitoring/vision-workshop-calibration.js'],
].map(([root,file])=>join(root,file)).concat(CALIBRATION_SCRIPT);
const initialRuntimeHashes = new Map(await Promise.all(initialRuntimeFiles.map(async file=>[file,hash(await readFile(file))])));
const sourcePath = (root, filename) => join(root, filename.replace(/\.ts$/, '.js'));
const source = async (root, filename) => import(pathToFileURL(sourcePath(root, filename)).href);
export const BLACK = { R: 64, Gr: 66, Gb: 68, B: 70 };
export function rawFrame(jitter = 0) {
    const data = Buffer.alloc(32 * 32 * 2), channels = ['R', 'Gr', 'Gb', 'B'];
    for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
            data.writeUInt16LE(BLACK[channels[y % 2 * 2 + x % 2]] + jitter, (y * 32 + x) * 2);
    return data;
}
export const metadata = { scene: 'synthetic-known-black-levels-not-camera', width: 32, height: 32, bitDepth: 12, bayer: 'RGGB', packing: 'unpacked16le', stride: 64, blackLevel: 0, whiteLevel: 4095, exposureUs: 1000, gain: 1 };
let emergencyCleanup;
function zipEntries(bytes) {
    const entries = new Map();
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
        assert.equal(bytes.readUInt16LE(offset + 8), 0, 'only actual store ZIP format expected');
        const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
        const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
        const begin = offset + 30 + nameLength + extraLength;
        entries.set(name, bytes.subarray(begin, begin + size));
        offset = begin + size;
    }
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    return entries;
}
export async function startSoftwareBackend() {
    const dir = await realpath(await mkdtemp(join(output, 'private-state-')));
    const names = ['RDK_DATA_DIR', 'RDK_VISION_STATE_DIR', 'RDK_VISION_BRIDGE_SECRET', 'RDK_VISION_BRIDGE_STATE_DIR', 'RDK_VISION_BRIDGE_ADAPTER_OWNERS', 'RDK_VISION_CALIBRATION_PYTHON', 'RDK_VISION_CALIBRATION_SCRIPT_PATH'];
    const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
    const secret = randomBytes(48).toString('hex');
    Object.assign(process.env, { RDK_DATA_DIR: join(dir, 'studio'), RDK_VISION_STATE_DIR: join(dir, 'vision'), RDK_VISION_BRIDGE_SECRET: secret, RDK_VISION_BRIDGE_STATE_DIR: join(dir, 'nonces'), RDK_VISION_BRIDGE_ADAPTER_OWNERS: '{}', RDK_VISION_CALIBRATION_PYTHON: PYTHON, RDK_VISION_CALIBRATION_SCRIPT_PATH: CALIBRATION_SCRIPT });
    await mkdir(join(dir, 'studio'), { mode: 0o700 });
    const nativeFetch = globalThis.fetch;
    let signedForwards = 0, forbiddenNetworkAttempts = 0, unrelatedCalls = 0;
    globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            forbiddenNetworkAttempts++;
            throw new Error('Fixture forbids non-loopback network');
        }
        return nativeFetch(input, init);
    };
    const openedServers = [];
    let resetAccess = () => { };
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        for (const server of openedServers.reverse())
            if (server.listening) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(() => resolve()));
            }
        resetAccess();
        globalThis.fetch = nativeFetch;
        for (const key of names)
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        await rm(dir, { recursive: true, force: true });
        assert.equal((await readdir(output)).includes(dir.split('/').at(-1)), false);
        closed = true;
    };
    emergencyCleanup = close;
    const express = createRequire(pathToFileURL(join(DOBS, 'package.json')))('express');
    const { VisionWorkshopService } = await source(DOBS, 'server/monitoring/vision-workshop-service.ts');
    const { VisionDeviceRegistry } = await source(DOBS, 'server/monitoring/vision-workshop-device.ts');
    const { configureObservabilityAccess, resetObservabilityAccessAdapter } = await source(DOBS, 'server/monitoring/observability-access-adapter.ts');
    resetAccess = resetObservabilityAccessAdapter;
    const { requireVisionWorkshopAccess } = await source(DOBS, 'server/monitoring/vision-workshop-access.ts');
    const { registerVisionWorkshopRoutes, VISION_WORKSHOP_API: API } = await source(DOBS, 'server/monitoring/vision-workshop-routes.ts');
    const { createVisionWorkshopBridge, VisionWorkshopBridgeError } = await source(STUDIO, 'server/vision-workshop/bridge.ts');
    const { cameraAccountAssertion } = await source(STUDIO, 'server/vision-workshop/account-assertion.ts');
    const { createVisionWorkshopRouter } = await source(STUDIO, 'server/routes/vision-workshop-routes.ts');
    const { globalErrorHandler } = await source(STUDIO, 'server/api-helpers.ts');
    configureObservabilityAccess({ getSessionSsoUser: () => null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
    const service = new VisionWorkshopService({ dataDir: join(dir, 'vision') }), registry = new VisionDeviceRegistry();
    const app = express();
    app.use(express.json({ limit: '24mb' }));
    const router = express.Router();
    router.get(API + '/fixture-scope-escape', requireVisionWorkshopAccess, (req, res) => {
        const child = Object.create(req);
        child.originalUrl = child.url = '/api/ops/non-camera-fixture';
        requireVisionWorkshopAccess(child, res, () => { unrelatedCalls++; res.json({ ok: true }); });
    });
    registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => registry, modelEnabled: () => false, generateCandidate: () => { throw new Error('No model calls in this fixture'); }, planDebug: () => { throw new Error('No hardware/model calls in this fixture'); } });
    app.use(router);
    const backend = createServer(app);
    const listen = async (server) => { openedServers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };
    const backendOrigin = await listen(backend);
    const bridge = createVisionWorkshopBridge({ configuredUrl: () => backendOrigin, configuredBridgeSecret: () => secret, deploymentProfile: () => 'web-cloud', bindsLoopback: () => false, pluginEnabled: () => true, pluginInstalled: () => true, fetcher: async (input, init) => {
            const headers = new Headers(init?.headers);
            assert.ok(headers.get('x-rdk-camera-assertion'));
            assert.ok(headers.get('x-rdk-camera-signature'));
            assert.equal(headers.get('cookie'), null);
            assert.equal(headers.get('x-admin-token'), null);
            signedForwards++;
            return fetch(input, init);
        } });
    const studioApp = express();
    studioApp.use(express.json({ limit: '24mb' }));
    studioApp.use(createVisionWorkshopRouter({ bridge, multiUser: () => true, resolveIdentity: (req) => {
            const session = /(?:^|;\s*)synthetic_camera_session=([AB])(?:;|$)/.exec(req.headers.cookie || '')?.[1];
            if (!session)
                throw new VisionWorkshopBridgeError('vision_workshop_login_required', 401);
            return { ssoUserId: 'synthetic-account-' + session };
        } }));
    studioApp.use(globalErrorHandler);
    const studio = createServer(studioApp), studioOrigin = await listen(studio), base = studioOrigin + '/api/vision-workshop';
    const request = (path, options = {}) => {
        const method = options.method || 'GET', binary = Buffer.isBuffer(options.body);
        return fetch(base + path, { method, headers: { cookie: 'synthetic_camera_session=' + (options.account || 'A'), ...(method === 'POST' ? { origin: studioOrigin, 'x-requested-with': 'XMLHttpRequest', 'content-type': binary ? 'application/octet-stream' : 'application/json' } : {}), ...options.headers }, ...(options.body === undefined ? {} : { body: binary ? new Uint8Array(options.body) : JSON.stringify(options.body) }) });
    };
    const json = async (response, expected = 200) => { assert.equal(response.status, expected, await response.clone().text()); return response.json(); };
    const tool = async (name, args = {}, account = 'A') => json(await request('/mcp', { method: 'POST', account, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }));
    const decodeTool = (rpc) => { assert.equal(rpc.result.isError, false, JSON.stringify(rpc)); return JSON.parse(rpc.result.content[0].text).data; };
    const scopeDenied = async () => {
        const target = API + '/fixture-scope-escape';
        const headers = cameraAccountAssertion({ secret, ssoUserId: 'synthetic-account-A', method: 'GET', path: target, headers: {} });
        const response = await fetch(backendOrigin + target, { headers });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, 'vision_bridge_scope_denied');
        assert.equal(unrelatedCalls, 0);
    };
    return { dir, studioOrigin, backendOrigin, base, request, json, tool, decodeTool, scopeDenied, service, close, counters: () => ({ signedForwards, forbiddenNetworkAttempts, unrelatedCalls, physicalAdapterExecuteCalls: 0, configuredAdapters: registry.list().length }) };
}
export async function runHttpProof() {
    const env = await startSoftwareBackend();
    const started = new Date().toISOString();
    let proof = { ok: false };
    try {
        const numpy = spawnSync(PYTHON, ['-c', 'import numpy; print(numpy.__version__)'], { encoding: 'utf8' });
        assert.equal(numpy.status, 0, numpy.stderr);
        const caps = await env.json(await env.request('/capabilities'));
        assert.equal(caps.connection.status, 'connected');
        assert.deepEqual(caps.deviceAdapters, []);
        assert.equal(caps.modelEnabled, false);
        const index = await env.json(await env.request('/knowledge?q=IMX415'));
        assert.ok(index.entries.length);
        const knowledge = await env.json(await env.request('/knowledge/' + index.entries[0].id));
        assert.equal(knowledge.knowledge.verification.hardware, 'unverified');
        const experiment = (await env.json(await env.request('/experiments', { method: 'POST', body: { title: 'Synthetic cross-repository BLC proof', goal: 'Software only; no board connected', board: 'RDK X5', sensorModel: 'IMX415' } }), 201)).experiment;
        assert.equal(experiment.targetId, undefined);
        const samples = [];
        for (const jitter of [-1, 0, 1]) {
            const bytes = rawFrame(jitter);
            const sample = (await env.json(await env.request('/experiments/' + experiment.id + '/samples', { method: 'POST', body: bytes, headers: { 'x-vision-sample': encodeURIComponent(JSON.stringify({ ...metadata, filename: 'synthetic-dark-' + jitter + '.raw' })) } }), 201)).sample;
            assert.equal(sample.hash, hash(bytes));
            samples.push(sample);
        }
        const task = (await env.json(await env.request('/experiments/' + experiment.id + '/calibration/tasks', { method: 'POST', body: { operation: 'blc', inputs: samples.map(sample => ({ sampleId: sample.id, capture: { target: 'lens_covered_dark', source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'synthetic-raw12', exposureUs: 1000, analogGain: 1, lightBlocked: true } })) } }), 201)).task;
        const completed = (await env.json(await env.request('/experiments/' + experiment.id + '/calibration/tasks/' + task.id + '/run', { method: 'POST', body: {} }))).task;
        assert.equal(completed.status, 'completed');
        assert.equal(completed.execution.exitCode, 0);
        assert.equal(completed.execution.executor, 'cpu-offline-numpy');
        const result = (await env.json(await env.request('/experiments/' + experiment.id + '/calibration/tasks/' + task.id + '/result'))).result;
        assert.deepEqual(result.parameters.values, BLACK);
        assert.equal(result.hardwareVerification, 'unverified');
        assert.equal(result.qualityVerification, 'unverified');
        const resultPath = join(env.dir, 'vision/calibration', hash('sso:synthetic-account-A'), experiment.id, task.id + '.result.json'), stored = await readFile(resultPath);
        assert.equal(hash(stored), completed.result.sha256);
        const bundleResponse = await env.request('/experiments/' + experiment.id + '/bundle?includeRaw=1');
        assert.equal(bundleResponse.status, 200);
        const bundle = Buffer.from(await bundleResponse.arrayBuffer());
        const entries = zipEntries(bundle);
        assert.ok(entries.has('calibration/tasks.json'));
        assert.deepEqual(JSON.parse(entries.get('calibration/' + task.id + '/result.json').toString()), JSON.parse(stored.toString()));
        for (const suffix of ['', '/bundle', '/samples/' + samples[0].id + '/download', '/calibration/tasks/' + task.id + '/result'])
            assert.equal((await env.request('/experiments/' + experiment.id + suffix, { account: 'B' })).status, 404);
        const archivedResult = entries.get('calibration/' + task.id + '/result.json');
        assert.equal(archivedResult.equals(stored), true, 'ZIP must preserve the already-verified Python result bytes');
        const archivedTask = JSON.parse(entries.get('calibration/tasks.json').toString()).tasks.find(entry => entry.id === task.id);
        assert.equal(hash(archivedResult), archivedTask.result.sha256, 'ZIP task ledger must hash the included result bytes');
        const mcpExperiment = env.decodeTool(await env.tool('vision_experiment_create', { title: 'Typed MCP inherited owner', goal: 'Synthetic subject-scoped test' })).experiment;
        assert.equal((await env.service.getExperiment('sso:synthetic-account-A', mcpExperiment.id)).id, mcpExperiment.id);
        assert.equal((await env.tool('vision_experiment_get', { experimentId: mcpExperiment.id }, 'B')).result.isError, true);
        const nonVision = await env.request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vision_workshop_execute', arguments: { operationId: 'GET /api/ops/observability/metrics' } } } });
        assert.equal(nonVision.status, 400);
        assert.equal((await nonVision.json()).code, 'vision_workshop_operation_denied');
        await env.scopeDenied();
        assert.equal(env.counters().forbiddenNetworkAttempts, 0);
        const hashes = [];
        for (const [root, filename] of [[STUDIO, 'server/vision-workshop/bridge.ts'], [STUDIO, 'server/vision-workshop/account-assertion.ts'], [STUDIO, 'server/routes/vision-workshop-routes.ts'], [DOBS, 'server/monitoring/vision-workshop-access.ts'], [DOBS, 'server/monitoring/vision-workshop-routes.ts'], [DOBS, 'server/monitoring/vision-workshop-calibration.ts']]) {
            const path = sourcePath(root, filename);
            hashes.push({ path, sha256: hash(await readFile(path)) });
        }
        hashes.push({ path: CALIBRATION_SCRIPT, sha256: hash(await readFile(CALIBRATION_SCRIPT)) });
        for(const [file,expected] of initialRuntimeHashes)assert.equal(hash(await readFile(file)),expected,'Runtime file changed during fixture: '+file);
        assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),runnerSha256AtStart,'Runner file changed during fixture');
        await writeFile(join(output, 'http-result.json'), JSON.stringify(result, null, 2));
        await writeFile(join(output, 'http-bundle.zip'), bundle);
        proof = { ok: true, evidence: 'Real Studio router and signer → loopback HTTP → real d-obs routes/store → real Python/NumPy, with synthetic accounts only', started, finished: new Date().toISOString(), syntheticAccounts: ['synthetic-account-A', 'synthetic-account-B'], numpy: numpy.stdout.trim(), experimentId: experiment.id, taskId: task.id, knownBlackLevels: BLACK, result: { parameters: result.parameters.values, hardwareVerification: result.hardwareVerification, qualityVerification: result.qualityVerification, resultFileSha256: hash(stored), bundleSha256: hash(bundle), bundleResultFileSha256: hash(entries.get('calibration/' + task.id + '/result.json')), bundleEntries: [...entries.keys()] }, checks: ['connected capabilities with zero adapters', 'IMX415 reviewed knowledge', 'unbound experiment', 'three RAW12 uploads and independent byte hashes', 'actual CPU BLC subprocess exit0', 'known per-Bayer black levels', 'owned ZIP includes calibration tasks/results', 'account B denied experiment/raw/result/bundle', 'typed MCP Object.create(req) owner retained', 'non-vision operation denied', 'inherited context cannot escape camera scope'], counters: env.counters(), sources: hashes };
    }
    finally {
        await env.close();
        proof.cleanup = { serversClosed: true, privateStateRemoved: true, environmentRestored: true };
        proof.passed = proof.ok === true;
        proof.cleanupCompleted = true;
        proof.hardwareOps = 0;
        proof.candidateRoots = candidateRoots;
        proof.runtimeRoots = { studio: STUDIO, platform: DOBS };
        proof.nodeVersion = process.version;
        proof.runnerSha256 = runnerSha256AtStart;
        await writeFile(join(output, 'http-proof.json'), JSON.stringify(proof, null, 2) + '\n');
    }
    console.log(JSON.stringify({ passed: proof.passed, cleanupCompleted: proof.cleanupCompleted, hardwareOps: 0, nodeVersion: process.version, candidateRoots, proof: join(output, 'http-proof.json'), blackLevels: BLACK, cleanup: proof.cleanup, counters: proof.counters }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        await runHttpProof();
        process.exit(0);
    }
    catch (error) {
        let cleanupCompleted = false;
        try {
            await emergencyCleanup?.();
            cleanupCompleted = true;
        }
        catch { }
        const failure = { passed: false, cleanupCompleted, hardwareOps: 0, nodeVersion: process.version, candidateRoots, error: String(error) };
        await writeFile(join(output, 'failure-proof.json'), JSON.stringify(failure, null, 2));
        console.error(JSON.stringify(failure));
        process.exit(1);
    }
}
