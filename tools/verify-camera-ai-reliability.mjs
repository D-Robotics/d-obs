/** Runs against a freshly extracted 1.5.7 package. Uses an isolated fake adapter and workbench. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(process.argv[2] ?? process.exit(2));
const config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers;
const course = config['rdk-vision-workshop'];
const camera = config['rdk-camera-workshop'];
const run = promisify(execFile);
const manifest = JSON.parse(await readFile(join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const env = { ...process.env };
const rpc = async (server, method, params = {}) => {
  const child = run(process.execPath, [join(root, ...server.args)], { env, timeout: 8000 });
  child.child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  const { stdout } = await child;
  const reply = JSON.parse(stdout);
  assert.ok(reply.result, 'expected an MCP result for ' + method);
  return reply.result;
};
const call = async (server, name, args = {}, isError = false) => {
  const result = await rpc(server, 'tools/call', { name, arguments: args });
  assert.equal(result.isError, isError, name);
  return JSON.parse(result.content[0].text);
};

assert.equal(manifest.version, '1.5.7');
for (const entry of manifest.files) {
  const data = await readFile(join(root, entry.path));
  assert.equal(data.byteLength, entry.bytes, entry.path);
  assert.equal(hash(data), entry.sha256, entry.path);
}
assert.equal(camera.permissions.default, 'approval');
for (const name of ['vision_workshop_runtime_status', 'vision_camera_readiness', 'vision_camera_workflow']) {
  assert.equal(camera.permissions.tools[name], 'readonly', name);
}
for (const name of ['vision_isp_tuning_get', 'vision_camera_probe', 'vision_pipeline_validate', 'vision_camera_capture_frame', 'vision_isp_apply', 'vision_isp_restore', 'vision_ai_debug_start']) {
  assert.equal(camera.permissions.tools[name] ?? camera.permissions.default, 'approval', name);
}
const directory = await mkdtemp(join(tmpdir(), 'camera-ai-157-test-'));
env.RDK_VISION_COURSE_SESSION_DIR = directory;
// Prevent the direct camera bridge check from reading the operator's real connection.
env.RDK_CAMERA_WORKSHOP_CONFIG = join(directory, 'unconfigured.json');
const { startWorkbench } = await import(pathToFileURL(join(root, 'mcp', 'workbench.mjs')).href);
const experimentId = randomUUID();
let probeCalls = 0;
const view = await startWorkbench({}, 0, { async preflight(binding, report) {
  assert.equal(binding.experimentId, experimentId);
  probeCalls++;
  report('service', { status: 'passed' });
  report('board', { status: 'blocked', code: 'vision_device_history_capacity' });
} });
try {
  const worker = join(root, 'mcp', 'workbench-session.mjs');
  const scope = hash(worker + '|persistent-workbench').slice(0, 32);
  const registration = join(directory, scope);
  await mkdir(registration);
  await writeFile(join(registration, 'session-learner-isp-v5'), view.url);
  const tools = new Map((await rpc(course, 'tools/list')).tools.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools.get('vision_course_view').inputSchema.properties), []);
  assert.equal(tools.get('vision_course_camera_status').annotations.readOnlyHint, true);
  for (const name of ['vision_course_sync', 'vision_course_preflight', 'vision_course_camera', 'vision_course_isp']) {
    assert.equal(course.permissions.tools[name], 'approval', name);
    assert.equal(tools.get(name).annotations.readOnlyHint, false, name);
  }
  assert.deepEqual(await call(camera, 'vision_plugin_version'), { version: manifest.version });
  const unbound = await call(course, 'vision_course_camera_status');
  assert.equal(unbound.cameraBinding.status, 'unbound');
  assert.equal(unbound.latestPreflight, null);
  view.update({ camera: { experimentId } });
  const revision = view.read().revision;
  const foundView = await call(course, 'vision_course_view');
  assert.equal(foundView.url, view.url);
  assert.match(foundView.instruction, /studio_open_url/);
  assert.deepEqual(await call(course, 'vision_course_view', { camera: { experimentId: randomUUID() } }, true), { error: 'invalid_arguments' });
  assert.equal(view.read().revision, revision);
  const before = await call(course, 'vision_course_camera_status');
  assert.deepEqual(before.cameraBinding, { source: 'workbench', status: 'bound', experimentId });
  assert.equal(before.baselineRequested, false);
  assert.equal(before.latestPreflight, null);
  assert.equal(probeCalls, 0);
  await call(course, 'vision_course_preflight', { run: true });
  const blocked = await call(course, 'vision_course_camera_status');
  assert.deepEqual(blocked.cameraBinding, before.cameraBinding);
  assert.equal(blocked.latestPreflight.checks.board.code, 'vision_device_history_capacity');
  assert.equal(blocked.latestPreflight.checks.frame.status, 'waiting');
  assert.equal(view.read().revision, revision);
  assert.equal(probeCalls, 1);
  console.log('Verified released tool permissions, version, original workbench launch and bound preflight status with isolated adapter');
} finally {
  await new Promise(resolve => view.server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
