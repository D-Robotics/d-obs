import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { renderVisionWorkshopPage, VISION_WORKSHOP_SCRIPT } from './vision-workshop-page.js';

type Event = { preventDefault(): void; target?: Node; key?: string; shiftKey?: boolean };
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  textContent = '';
  className = '';
  value = '';
  id = '';
  type = '';
  disabled = false;
  hidden = false;
  open = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: Event) => unknown>> = {};
  files: Array<{ name: string; size: number }> = [];
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); },
    toggle: (name: string, enabled: boolean) => { const names = this.className.split(' ').filter(item => item && item !== name); if (enabled) names.push(name); this.className = names.join(' '); },
  };
  constructor(readonly tagName: string) {}
  get innerHTML(): never { throw new Error('Untrusted HTML read'); }
  set innerHTML(_value: string) { throw new Error('Untrusted HTML write'); }
  get isConnected(): boolean { return this.tagName === 'body' || Boolean(this.parent?.isConnected); }
  appendChild(node: Node): Node { node.parent = this; this.children.push(node); return node; }
  replaceChildren(...nodes: Node[]) { this.children.forEach(node => { node.parent = null; }); this.children = []; nodes.forEach(node => this.appendChild(node)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, listener: (event: Event) => unknown) { (this.listeners[name] ||= []).push(listener); }
  querySelectorAll(selector: string) { const tags = selector.split(','); return all(this).slice(1).filter(node => tags.includes(node.tagName)); }
  focus() {}
  click() { return this.fire('click'); }
  reset() {}
  async fire(type: string) { for (const listener of this.listeners[type] || []) await listener({ preventDefault() {}, target: this }); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const content = (node: Node): string => all(node).map(item => item.textContent).join(' ');
const settle = () => new Promise(resolve => setImmediate(resolve));
const capability = { bringup: { status: 'unavailable', reason: 'adapter_not_configured' }, capture: { status: 'unavailable' }, apply: { status: 'unavailable' }, limits: { maxRawBytes: 67108864 } };
const sample = { id: 'sample-1', filename: 'backlight.raw', metadata: { scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 } };
const baseline = { id: 'baseline-1', hash: 'baseline-hash', tuning: { sharpen: { strength: 0 } }, rules: [{ path: '/sharpen/strength', label: '锐化强度', min: 0, max: 10 }] };
const candidate = { id: 'candidate-1', title: '细节候选', hash: 'a'.repeat(64), baselineHash: baseline.hash, patches: [{ path: '/sharpen/strength', value: 2, reason: '保留边缘细节' }], source: 'model', model: 'test-model', verification: 'unverified' };
const experiment = () => ({ id: 'experiment-1', title: '逆光实验', goal: '减少噪声，保留细节', targetId: undefined as string | undefined, board: undefined as string | undefined, sensorVendor: undefined as string | undefined, sensorModel: undefined as string | undefined, sdkVersion: undefined as string | undefined, cameraInterface: undefined as string | undefined, cameraMode: undefined as string | undefined, createdAt: '2026-10-12T01:00:00Z', baseline: null as any, baselineHistory: [] as any[], samples: [] as any[], candidates: [] as any[], processedImages: [] as any[], cameraFrames: [] as any[], evaluations: [] as any[], comparisons: [] as any[], deviceRuns: [] as any[], aiDebugRuns: [] as any[], selectedCandidateId: null as string | null });
type Experiment = ReturnType<typeof experiment>;
type Request = { path: string; options: { method?: string; headers: Record<string, string>; body?: unknown; credentials: string } };
function setup(options: { experiment?: Experiment; failedList?: boolean; failedCandidate?: boolean; failedCapabilities?: boolean; capabilities?: Record<string, unknown>; token?: string; session?: string; deviceResults?: Record<string, unknown>; failedDevice?: string; debugRun?: any; debugPollRun?: any; failedDebug?: boolean; failedDebugPoll?: boolean; readiness?: any; failedReadiness?: boolean; calibrationTasks?: any[]; calibrationAssets?: any[]; failedCalibrationList?: boolean; failedCalibrationRun?: boolean; pluginPackages?: any[]; failedPluginPackages?: boolean; packageBlob?: Blob } = {}) {
  const ids = new Map<string, Node>();
  const body = new Node('body');
  ['logsLink', 'consoleLink', 'experimentCount', 'newExperiment', 'experimentList', 'workspace', 'feedback', 'hardwareNotice', 'atomicCapabilities', 'pluginPackageLinks', 'createModal', 'closeModal', 'createForm', 'createSubmit', 'createError', 'experimentTitle', 'experimentGoal', 'sensorModel', 'sdkVersion', 'experimentBoard', 'sensorVendor', 'cameraInterface', 'cameraMode', 'adapterTarget', 'createReadiness', 'createDeviceDetails'].forEach(id => { const node = new Node(id.endsWith('Form') ? 'form' : 'div'); node.id = id; ids.set(id, node); body.appendChild(node); });
  const steps = [0, 1, 2, 3].map(index => { const node = new Node('button'); node.dataset.step = String(index); body.appendChild(node); return node; });
  let current = options.experiment;
  let calibrationTasks = options.calibrationTasks || []; const calibrationAssets = options.calibrationAssets || [];
  const requests: Request[] = [];
  const timers = new Map<number, () => unknown>(); let nextTimerId = 0;
  const urlClass = class extends URL { static createObjectURL() { return 'blob:test-preview'; } static revokeObjectURL() {} };
  const context = vm.createContext({
    document: {
      body, activeElement: null,
      createElement: (tag: string) => new Node(tag),
      getElementById: (id: string) => ids.get(id) || all(body).find(node => node.id === id),
      addEventListener() {},
      querySelectorAll: (selector: string) => selector === '[data-step]' ? steps : selector.includes('#workspace') ? all(ids.get('workspace')!).filter(node => ['button', 'input', 'select', 'textarea'].includes(node.tagName)) : [],
    },
    location: { pathname: '/dobs/ops-observability/vision-workshop', href: 'https://example.test/dobs/ops-observability/vision-workshop' },
    sessionStorage: { getItem: (key: string) => key === 'd_obs_admin_token' ? options.token : key === 'd_obs_sso_session' ? options.session : null },
    localStorage: { getItem: () => null },
    window: { addEventListener() {} }, history: { replaceState() {} },
    URL: urlClass, setTimeout: (callback: () => unknown) => { const id = ++nextTimerId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id), Blob, Uint8Array, atob, btoa, crypto: webcrypto,
    fetch: async (path: string, requestOptions: Request['options']) => {
      requests.push({ path, options: requestOptions });
      let status = 200;
      let data: unknown = { ok: true };
      if (path.endsWith('/capabilities')) { status = options.failedCapabilities ? 503 : 200; data = options.failedCapabilities ? { ok: false, error: 'capabilities_unavailable' } : { ok: true, ...(options.capabilities || capability) }; }
      else if (path.endsWith('/readiness')) { status = options.failedReadiness ? 503 : 200; data = options.failedReadiness ? { ok: false, error: 'readiness_unavailable' } : { ok: true, readiness: options.readiness || { evidenceSource: 'persisted-experiment', stages: [], recovery: { status: 'not_recorded' }, aiDebug: { canStart: true } } }; }
      else if (path.endsWith('/plugin-packages')) { status = options.failedPluginPackages ? 503 : 200; data = options.failedPluginPackages ? { ok: false, error: 'package_manifest_unavailable' } : { ok: true, packages: options.pluginPackages || [] }; }
      else if (path.endsWith('/calibration/tasks') && requestOptions.method === 'POST') { const task = { ...JSON.parse(String(requestOptions.body)), id: 'task-1', status: 'queued', hardwareVerification: 'unverified', qualityVerification: 'unverified' }; calibrationTasks = [...calibrationTasks, task]; data = { ok: true, task }; }
      else if (path.endsWith('/calibration/tasks')) { status = options.failedCalibrationList ? 503 : 200; data = options.failedCalibrationList ? { ok: false, error: 'calibration_store_unavailable' } : { ok: true, tasks: calibrationTasks }; }
      else if (path.endsWith('/calibration/assets')) data = { ok: true, assets: calibrationAssets };
      else if (path.endsWith('/calibration/tasks/task-1/run')) { calibrationTasks = calibrationTasks.map(task => ({ ...task, status: options.failedCalibrationRun ? 'failed' : 'completed', ...(options.failedCalibrationRun ? { error: 'vision_calibration_dark_capture_required' } : {}) })); status = options.failedCalibrationRun ? 422 : 200; data = options.failedCalibrationRun ? { ok: false, error: 'vision_calibration_dark_capture_required' } : { ok: true, task: calibrationTasks[0] }; }
      else if (path.endsWith('/experiments') && requestOptions.method === 'POST') { current = { ...experiment(), ...JSON.parse(String(requestOptions.body)) }; data = { ok: true, experiment: current }; }
      else if (path.endsWith('/experiments')) { status = options.failedList ? 503 : 200; data = options.failedList ? { ok: false, error: 'storage_unavailable' } : { ok: true, experiments: current ? [current] : [] }; }
      else if (path.endsWith('/experiments/experiment-1')) data = { ok: true, experiment: current };
      else if (path.endsWith('/samples') && current) { current = { ...current, samples: [sample] }; data = { ok: true, sample }; }
      else if (path.endsWith('/candidates') && options.failedCandidate) { status = 503; data = { ok: false, error: 'model_gateway_unavailable' }; }
      else if (path.endsWith('/selection') && current) { current = { ...current, selectedCandidateId: JSON.parse(String(requestOptions.body)).candidateId }; data = { ok: true, experiment: current }; }
      else if (path.endsWith('/ai-debug') && current) { status = options.failedDebug ? 503 : 202; const run = options.debugRun || { id: 'debug-1', source: 'model', status: 'queued', goal: 'Fixture goal', maxRounds: 4, iterations: [], createdAt: '2026-10-13T10:00:00Z' }; if (!options.failedDebug) current = { ...current, aiDebugRuns: [...current.aiDebugRuns, run] }; data = options.failedDebug ? { ok: false, error: 'vision_visual_planner_unavailable' } : { ok: true, run }; }
      else if (path.endsWith('/ai-debug/runs/debug-1/cancel') && current) { const run = { ...current.aiDebugRuns.at(-1), cancelRequested: true }; current = { ...current, aiDebugRuns: [run] }; data = { ok: true, run }; }
      else if (path.endsWith('/ai-debug/runs/debug-1/restore-original') && current) { const run = { ...current.aiDebugRuns.at(-1), final: { restored: true, reason: '实际完整配置恢复并回读' } }; current = { ...current, aiDebugRuns: [run] }; data = { ok: true, run }; }
      else if (path.endsWith('/ai-debug/runs/debug-1') && current) { status = options.failedDebugPoll ? 503 : 200; const run = options.debugPollRun || current.aiDebugRuns.at(-1); if (!options.failedDebugPoll) current = { ...current, aiDebugRuns: [run] }; data = options.failedDebugPoll ? { ok: false, error: 'vision_debug_state_unavailable' } : { ok: true, run }; }
      else if (path.includes('/device/') && current) {
        const operation = path.split('/').at(-1)!;
        const failed = options.failedDevice === operation;
        const result = options.deviceResults?.[operation] || {};
        status = failed ? 502 : 200;
        if (!['preview_frame', 'controls_get'].includes(operation)) current = { ...current, deviceRuns: [...current.deviceRuns, { operation, adapterId: current.targetId, status: failed ? 'failed' : 'completed', createdAt: '2026-10-13T10:00:00Z', evidence: failed ? { code: 'sdk_readback_failed' } : { result } }] };
        data = failed ? { ok: false, error: 'sdk_readback_failed' } : operation === 'preview_frame' ? { ok: true, frame: result } : { ok: true, result, ...(operation === 'tuning_export' ? { artifact: result } : {}) };
      }
      return { status, ok: status < 400, json: async () => data, blob: async () => options.packageBlob || ({}) };
    },
  });
  vm.runInContext(VISION_WORKSHOP_SCRIPT, context);
  return { ids, body, steps, requests, async step(index: number) { await steps[index].fire('click'); await settle(); }, async nextTimer() { const entry = timers.entries().next().value; assert.ok(entry, 'no pending timer'); timers.delete(entry[0]); await entry[1](); await settle(); }, workspace: ids.get('workspace')!, feedback: ids.get('feedback')! };
}
function byText(root: Node, text: string) { const node = all(root).find(node => node.tagName === 'button' && node.textContent === text); assert.ok(node, 'button missing: ' + text); return node; }
function fieldControl(root: Node, label: string) { const node = all(root).find(node => node.tagName === 'label' && node.textContent === label); assert.ok(node, 'field missing: ' + label); return node.children[0]; }

test('workshop shell is camera-neutral and does not prefill unrecorded hardware identity', () => {
  const html = renderVisionWorkshopPage();
  assert.match(html, /通用视觉原子能力/);
  assert.doesNotMatch(html, /IMX415|Sony|RDK X5/);
  assert.doesNotMatch(html, /id="sensorModel"[^>]*value=/);
  assert.doesNotMatch(html, /<script\s+src=/);
  new vm.Script(VISION_WORKSHOP_SCRIPT);
});

test('read requests retain the /dobs prefix and current auth, with no implicit hardware operation', async () => {
  const h = setup({ experiment: experiment(), token: 'admin-fixture', session: 'session-fixture' });
  await settle();
  assert.equal(h.requests.length, 5);
  assert.ok(h.requests.some(request => request.path.endsWith('/readiness')));
  assert.ok(h.requests.some(request => request.path.endsWith('/plugin-packages')));
  for (const request of h.requests) {
    assert.match(request.path, /^\/dobs\/api\/ops\/observability\/vision-workshop\//);
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.headers['x-admin-token'], 'admin-fixture');
    assert.equal(request.options.headers['x-rdk-sso-session'], 'session-fixture');
    assert.ok(!request.options.method);
  }
  assert.match(content(h.workspace), /点亮状态：未经平台确认/);
  assert.doesNotMatch(content(h.workspace), /相机已点亮|采集成功|已上板验证/);
});

test('storage failure is visible and never masquerades as an empty experiment list', async () => {
  const h = setup({ failedList: true });
  await settle();
  assert.match(content(h.workspace), /工作台暂时无法加载.*storage_unavailable/);
  assert.match(content(h.feedback), /storage_unavailable/);
  assert.doesNotMatch(content(h.workspace), /尚未选择实验|创建第一个实验/);
});

test('import sends the real Raw bytes and all mandatory acquisition metadata', async () => {
  const h = setup({ experiment: experiment() });
  await settle(); await h.step(1);
  const file = { name: 'capture.raw', size: 8 };
  fieldControl(h.workspace, 'Raw 文件').files = [file];
  for (const [label, value] of Object.entries({ '采集场景': '逆光', '宽度（像素）': '2', '高度（像素）': '2', '有效位深': '10', 'Bayer 排列': 'RGGB', '数据布局': 'unpacked16le', 'Stride（字节 / 行）': '4', 'Black level': '0', 'White level': '1023' })) fieldControl(h.workspace, label).value = value;
  const form = all(h.workspace).find(node => node.tagName === 'form')!;
  await form.fire('submit'); await settle();
  const upload = h.requests.find(request => request.options.method === 'POST')!;
  assert.equal(upload.options.body, file);
  assert.equal(upload.options.headers['content-type'], 'application/octet-stream');
  assert.equal(upload.options.headers['X-RDK-Ops-Action'], 'observability');
  assert.deepEqual(JSON.parse(decodeURIComponent(upload.options.headers['x-vision-sample'])), { filename: 'capture.raw', scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 });
  assert.match(content(h.feedback), /Raw 样本已导入/);
  assert.equal(byText(h.workspace, '查看 Raw 预览').disabled, false, 'successful refresh must release the UI busy state');
});

test('the form cannot invent a compatible Raw layout or upload a truncated frame', async () => {
  const h = setup({ experiment: experiment() });
  await settle(); await h.step(1);
  assert.equal(fieldControl(h.workspace, 'Bayer 排列').value, '');
  assert.equal(fieldControl(h.workspace, '数据布局').value, '');
  assert.equal(fieldControl(h.workspace, 'Black level').value, '');
  fieldControl(h.workspace, 'Raw 文件').files = [{ name: 'truncated.raw', size: 7 }];
  fieldControl(h.workspace, '高度（像素）').value = '2';
  fieldControl(h.workspace, 'Stride（字节 / 行）').value = '4';
  await all(h.workspace).find(node => node.tagName === 'form')!.fire('submit'); await settle();
  assert.match(content(h.feedback), /Raw 文件大小必须等于 stride × height/);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('model failure preserves the error and does not claim a generated candidate', async () => {
  const current = { ...experiment(), baseline, baselineHistory: [baseline], samples: [sample] };
  const h = setup({ experiment: current, failedCandidate: true });
  await settle(); await h.step(2);
  await byText(h.workspace, '生成 AI 参数候选').fire('click'); await settle();
  assert.match(content(h.feedback), /model_gateway_unavailable/);
  assert.doesNotMatch(content(h.feedback), /候选已生成/);
  assert.match(content(h.workspace), /还没有参数候选/);
  assert.equal(byText(h.workspace, '生成 AI 参数候选').disabled, false);
});

test('dynamic experiment and patch text cannot inject HTML; zero baseline values stay visible', async () => {
  const current = { ...experiment(), title: '<img src=x onerror=alert(1)>', baseline, baselineHistory: [baseline], samples: [sample], candidates: [{ ...candidate, patches: [{ ...candidate.patches[0], reason: '<script>unsafe()</script>' }] }] };
  const h = setup({ experiment: current });
  await settle(); await h.step(2);
  assert.match(content(h.workspace), /<img src=x onerror=alert\(1\)>/);
  assert.match(content(h.workspace), /0 → 2/);
  assert.match(content(h.workspace), /<script>unsafe\(\)<\/script>/);
  assert.equal(all(h.workspace).filter(node => node.tagName === 'img' || node.tagName === 'script').length, 0);
});

test('final tuning requires an evaluated current candidate while the experiment record remains exportable', async () => {
  const output = { id: 'result-1', sampleId: sample.id, candidateId: candidate.id, filename: 'isp.png', verification: 'unverified' };
  const current = { ...experiment(), baseline, baselineHistory: [baseline], samples: [sample], candidates: [candidate], processedImages: [output] };
  const h = setup({ experiment: current });
  await settle(); await h.step(3);
  assert.equal(byText(h.workspace, '保存候选选择').disabled, true);
  assert.equal(byText(h.workspace, '下载 tuning 文件').disabled, true);
  assert.equal(byText(h.workspace, '下载调优交付包').disabled, false);
  const rated = setup({ experiment: { ...current, evaluations: [{ id: 'review-1', imageId: output.id, rating: 4, notes: '细节较好，暗部仍有噪声' }] } });
  await settle(); await rated.step(3);
  const selection = fieldControl(rated.workspace, '交付候选'); selection.value = candidate.id; await selection.fire('change');
  assert.equal(byText(rated.workspace, '保存候选选择').disabled, false);
  await byText(rated.workspace, '保存候选选择').fire('click'); await settle();
  assert.equal(byText(rated.workspace, '下载调优交付包').disabled, false);
  assert.match(content(rated.workspace), /参数应用与画质验收状态分别记录/);
});

test('creating an import experiment omits blank SDK fields accepted only as optional values by the real route', async () => {
  const h = setup(); await settle();
  h.ids.get('experimentTitle')!.value = '实际导入实验';
  h.ids.get('experimentGoal')!.value = '逆光场景';
  h.ids.get('sensorModel')!.value = 'IMX415';
  h.ids.get('sdkVersion')!.value = '';
  await h.ids.get('createForm')!.fire('submit'); await settle();
  const create = h.requests.find(request => request.path.endsWith('/experiments') && request.options.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(create.options.body)), { title: '实际导入实验', goal: '逆光场景', sensorModel: 'IMX415' });
  assert.match(content(h.feedback), /实验已创建/);
});

test('configured adapter capabilities are disclosed as configuration, with no automatic probe', async () => {
  const h = setup({ capabilities: { ...capability, modelEnabled: false, bringup: { status: 'available', verification: 'configured-adapter' }, mcpEndpoint: '/api/ops/vision-workshop/mcp', atomicOperations: ['POST /api/ops/observability/vision-workshop/experiments/:id/device/probe'], deviceAdapters: [{ id: 'camera-sdk', label: '现场适配器', board: 'Customer board', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'fixture-sdk', operations: ['probe', 'bringup'] }] } });
  await settle();
  assert.match(content(h.ids.get('hardwareNotice')!), /已登记相机连接.*在线与出图需检查/);
  assert.match(content(h.ids.get('atomicCapabilities')!), /不能证明设备在线、相机已点亮或参数已应用/);
  assert.match(content(h.ids.get('atomicCapabilities')!), /\/dobs\/api\/ops\/vision-workshop\/mcp/);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('unknown capabilities and disabled models are explicit, without false adapter or model readiness', async () => {
  const unknown = setup({ failedCapabilities: true }); await settle();
  assert.match(content(unknown.ids.get('hardwareNotice')!), /状态未确认/);
  assert.doesNotMatch(content(unknown.ids.get('hardwareNotice')!), /尚未接入/);
  const h = setup({ experiment: { ...experiment(), baseline, samples: [sample] }, capabilities: { ...capability, modelEnabled: false } });
  await settle(); await h.step(2);
  assert.equal(byText(h.workspace, '生成 AI 参数候选').disabled, true);
  assert.match(content(h.workspace), /模型网关尚未启用/);
});

test('download keeps authentication and prefix for both candidate tuning and ZIP', async () => {
  const output = { id: 'result-1', sampleId: sample.id, candidateId: candidate.id, filename: 'isp.png' };
  const current = { ...experiment(), baseline, baselineHistory: [baseline], samples: [sample], candidates: [candidate], processedImages: [output], evaluations: [{ id: 'review-1', imageId: output.id, rating: 4, notes: '候选效果可用' }], selectedCandidateId: candidate.id };
  const h = setup({ experiment: current, token: 'download-admin', session: 'download-session' });
  await settle(); await h.step(3);
  await byText(h.workspace, '下载 tuning 文件').fire('click');
  await byText(h.workspace, '下载调优交付包').fire('click');
  const downloads = h.requests.filter(request => request.path.endsWith('/tuning') || request.path.endsWith('/bundle'));
  assert.equal(downloads.length, 2);
  for (const download of downloads) {
    assert.match(download.path, /^\/dobs\/api\/ops\/observability\/vision-workshop\/experiments\/experiment-1\//);
    assert.equal(download.options.credentials, 'same-origin');
    assert.equal(download.options.headers['x-admin-token'], 'download-admin');
    assert.equal(download.options.headers['x-rdk-sso-session'], 'download-session');
  }
});

test('unrecorded camera context stays unknown and a generic import experiment does not invent defaults', async () => {
  const h = setup(); await settle();
  h.ids.get('experimentTitle')!.value = '通用导入实验'; h.ids.get('experimentGoal')!.value = '真实画质目标';
  await h.ids.get('createForm')!.fire('submit'); await settle();
  const create = h.requests.find(request => request.options.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(create.options.body)), { title: '通用导入实验', goal: '真实画质目标' });
  assert.match(content(h.workspace), /板卡 \/ 设备平台 未记录/);
  assert.match(content(h.workspace), /Sensor 未记录/);
  assert.doesNotMatch(content(h.workspace), /IMX415|Sony|RDK X5/);
});

test('manually recorded alternate camera context is transmitted as facts without changing raw formats', async () => {
  const h = setup(); await settle();
  h.ids.get('experimentTitle')!.value = '另一相机实验'; h.ids.get('experimentGoal')!.value = '真实画质目标';
  for (const [id, value] of Object.entries({ experimentBoard: 'Customer carrier', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'verified-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'verified-mode' })) h.ids.get(id)!.value = value;
  await h.ids.get('createForm')!.fire('submit'); await settle();
  const create = h.requests.find(request => request.options.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(create.options.body)), { title: '另一相机实验', goal: '真实画质目标', board: 'Customer carrier', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'verified-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'verified-mode' });
  await h.step(1);
  const packing = fieldControl(h.workspace, '数据布局');
  assert.deepEqual(packing.children.map(option => option.value), ['', 'unpacked16le', 'mipi-raw10', 'mipi-raw12']);
});

test('selecting a server-configured adapter delegates identity matching to the backend using only targetId', async () => {
  const profile = { id: 'camera-profile', label: '已配置相机', board: 'Customer carrier', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'verified-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'verified-mode', operations: ['probe'] };
  const h = setup({ capabilities: { ...capability, deviceAdapters: [profile] } }); await settle();
  h.ids.get('experimentTitle')!.value = '适配器实验'; h.ids.get('experimentGoal')!.value = '真实画质目标';
  h.ids.get('sensorModel')!.value = 'manual-draft';
  const adapter = h.ids.get('adapterTarget')!; adapter.value = profile.id; await adapter.fire('change');
  assert.equal(h.ids.get('sensorModel')!.value, 'OV5647'); assert.equal(h.ids.get('sensorModel')!.disabled, true);
  await h.ids.get('createForm')!.fire('submit'); await settle();
  const create = h.requests.find(request => request.options.method === 'POST')!;
  assert.deepEqual(JSON.parse(String(create.options.body)), { title: '适配器实验', goal: '真实画质目标', targetId: 'camera-profile' });
  assert.equal(h.requests.filter(request => request.path.includes('/device/')).length, 0);
});

const cameraProfile = { id: 'usb-camera', label: '真实 USB 相机适配器', board: 'RDK S100', sensorModel: 'verified-uvc', sdkVersion: 'verified-v4l2', cameraInterface: 'USB UVC', cameraMode: '1280x720 MJPEG', operations: ['probe', 'pipeline_validate', 'bringup', 'preview_start', 'preview_stop', 'preview_frame', 'controls_get', 'controls_set', 'capture_frame', 'apply_tuning', 'restore_tuning'] };
const cameraCapabilities = { ...capability, modelEnabled: true, deviceAdapters: [cameraProfile] };
const cameraExperiment = () => ({ ...experiment(), targetId: cameraProfile.id, board: cameraProfile.board, sensorModel: cameraProfile.sensorModel, sdkVersion: cameraProfile.sdkVersion });

test('USB camera actions use configured capabilities and never enable unsupported RAW or ISP processing', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: cameraCapabilities, token: 'fixture-auth' }); await settle();
  assert.equal(h.requests.filter(request => request.path.includes('/device/')).length, 0);
  assert.equal(byText(h.workspace, '探测相机').disabled, false);
  assert.equal(byText(h.workspace, '开始实时预览').disabled, false);
  await byText(h.workspace, '探测相机').fire('click'); await settle();
  const probe = h.requests.find(request => request.path.endsWith('/device/probe'))!;
  assert.deepEqual(JSON.parse(String(probe.options.body)), {});
  assert.equal(probe.options.headers['x-admin-token'], 'fixture-auth');
  assert.equal(probe.options.headers['X-RDK-Ops-Action'], 'observability');
  await h.step(1);
  assert.equal(byText(h.workspace, '从设备采集 RAW').disabled, true);
  assert.equal(byText(h.workspace, '保存视频画面').disabled, false);
  assert.match(content(h.workspace), /没有 Bayer RAW 采集能力/);
  await h.step(3);
  assert.equal(byText(h.workspace, '在 SDK 中处理 RAW').disabled, true);
});

test('camera controls send only changed values and show actual SDK readback rather than the requested value', async () => {
  const descriptors = { exposureUs: { value: 100, min: 10, max: 200, step: 1, writable: true }, autoExposure: { value: false, writable: true }, gain: { value: 2, min: 1, max: 5, writable: false } };
  const h = setup({ experiment: cameraExperiment(), capabilities: cameraCapabilities, deviceResults: { controls_get: { controls: descriptors }, controls_set: { controls: { ...descriptors, exposureUs: { ...descriptors.exposureUs, value: 124 } } } } }); await settle();
  await byText(h.workspace, '读取相机参数').fire('click'); await settle();
  assert.equal(fieldControl(h.workspace, '曝光时间').value, '100');
  assert.equal(fieldControl(h.workspace, '增益').disabled, true);
  fieldControl(h.workspace, '曝光时间').value = '125';
  await all(h.workspace).find(node => node.tagName === 'form')!.fire('submit'); await settle();
  const update = h.requests.find(request => request.path.endsWith('/device/controls_set'))!;
  assert.deepEqual(JSON.parse(String(update.options.body)), { values: { exposureUs: 125 } });
  assert.equal(fieldControl(h.workspace, '曝光时间').value, '124');
  assert.match(content(h.workspace), /实际回读：124/);
  fieldControl(h.workspace, '曝光时间').value = '201';
  await all(h.workspace).find(node => node.tagName === 'form')!.fire('submit'); await settle();
  assert.equal(h.requests.filter(request => request.path.endsWith('/device/controls_set')).length, 1);
  assert.match(content(h.feedback), /超出设备支持范围/);
});

test('device readback failure refreshes the failure record and never reports successful application', async () => {
  const h = setup({ experiment: { ...cameraExperiment(), baseline, candidates: [candidate] }, capabilities: cameraCapabilities, failedDevice: 'apply_tuning' }); await settle(); await h.step(2);
  await byText(h.workspace, '应用候选并回读').fire('click'); await settle();
  assert.match(content(h.feedback), /sdk_readback_failed/);
  assert.doesNotMatch(content(h.feedback), /已应用并回读匹配/);
  assert.equal(byText(h.workspace, '应用候选并回读').disabled, false);
});

test('live preview uses authenticated frame bytes and stops through the same bound adapter', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: cameraCapabilities, deviceResults: { preview_start: { running: true }, preview_frame: { contentBase64: 'AA==', mimeType: 'image/png', width: 1, height: 1 }, preview_stop: { running: false } } }); await settle();
  await byText(h.workspace, '开始实时预览').fire('click'); await settle();
  assert.ok(h.requests.some(request => request.path.endsWith('/device/preview_frame')));
  const preview = all(h.workspace).find(node => node.id === 'livePreview')!;
  assert.ok(all(preview).some(node => node.tagName === 'img'));
  assert.equal(byText(h.workspace, '开始实时预览').disabled, true);
  await byText(h.workspace, '停止实时预览').fire('click'); await settle();
  assert.ok(h.requests.some(request => request.path.endsWith('/device/preview_stop')));
  assert.equal(byText(h.workspace, '开始实时预览').disabled, false);
});

test('actual camera frames can seed bounded AI candidates and be rated without claiming identical RAW input', async () => {
  const frame = { id: 'frame-1', filename: 'actual.png', width: 1280, height: 720, mimeType: 'image/png', tuningHash: baseline.hash, hash: 'frame-hash' };
  const after = { ...frame, id: 'frame-2', candidateId: candidate.id, tuningHash: candidate.hash };
  const h = setup({ experiment: { ...cameraExperiment(), baseline, candidates: [candidate], cameraFrames: [frame, after], evaluations: [{ imageId: after.id, rating: 4, notes: '真实视频画面观察' }] }, capabilities: cameraCapabilities }); await settle(); await h.step(2);
  assert.equal(byText(h.workspace, '生成 AI 参数候选').disabled, false);
  assert.match(content(h.workspace), /UVC 使用处理后画面统计/);
  await h.step(3);
  assert.match(content(h.workspace), /独立视频采集帧/);
  assert.equal(byText(h.workspace, '保存当前区域的客观统计').disabled, true);
  const selection = fieldControl(h.workspace, '交付候选');
  assert.ok(selection.children.some(option => option.value === candidate.id));
  assert.ok(h.requests.some(request => request.path.endsWith('/frames/frame-1')));
});

test('same RAW comparison sends an exact bounded ROI and retains output-version evidence', async () => {
  const before = { id: 'before', sampleId: sample.id, width: 100, height: 80, filename: 'before.png', mimeType: 'image/png', tuningHash: baseline.hash };
  const after = { ...before, id: 'after', filename: 'after.png', candidateId: candidate.id, tuningHash: candidate.hash };
  const h = setup({ experiment: { ...experiment(), baseline, candidates: [candidate], samples: [sample], processedImages: [before, after] } }); await settle(); await h.step(3);
  assert.equal(byText(h.workspace, '保存当前区域的客观统计').disabled, false);
  const scope = fieldControl(h.workspace, '观察区域'); scope.value = 'roi'; await scope.fire('change');
  for (const [key, value] of Object.entries({ x: 10, y: 15, width: 30, height: 20 })) fieldControl(h.workspace, 'ROI ' + key).value = String(value);
  await byText(h.workspace, '保存当前区域的客观统计').fire('click'); await settle();
  const compare = h.requests.find(request => request.path.endsWith('/comparisons'))!;
  assert.deepEqual(JSON.parse(String(compare.options.body)), { baselineImageId: before.id, candidateImageId: after.id, roi: { x: 10, y: 15, width: 30, height: 20 } });
  assert.match(content(h.feedback), /不代表画质达标/);
});

test('saved baseline recovery and RAW bundle inclusion use explicit versions and retain authentication', async () => {
  const h = setup({ experiment: { ...cameraExperiment(), baseline, samples: [sample], baselineHistory: [baseline, { ...baseline, id: 'old-baseline' }] }, capabilities: cameraCapabilities, session: 'recovery-fixture' }); await settle(); await h.step(3);
  const restore = fieldControl(h.workspace, '恢复到已保存参数版本'); restore.value = 'baseline:old-baseline'; await restore.fire('change');
  await byText(h.workspace, '恢复所选参数并回读').fire('click'); await settle();
  const recovery = h.requests.find(request => request.path.endsWith('/device/restore_tuning'))!;
  assert.deepEqual(JSON.parse(String(recovery.options.body)), { baselineId: 'old-baseline' });
  assert.equal(recovery.options.headers['x-rdk-sso-session'], 'recovery-fixture');
  fieldControl(h.workspace, '交付包中的 RAW').value = '1'; await byText(h.workspace, '下载调优交付包').fire('click');
  assert.ok(h.requests.some(request => request.path.endsWith('/bundle?includeRaw=1')));
});

test('camera receipt presents compact device facts with lengthy driver output collapsed and frame-aware progress', async () => {
  const result = { facts: { cameraName: 'Verified UVC', interface: 'USB', rawSupported: false, socIspSupported: false, driverInfo: 'Long driver output '.repeat(200), formats: 'MJPEG modes '.repeat(100) } };
  const h = setup({ experiment: { ...cameraExperiment(), cameraFrames: [{ id: 'frame-1', filename: 'frame.png', width: 2, height: 1, mimeType: 'image/png' }], deviceRuns: [{ operation: 'probe', status: 'completed', evidence: { result } }] }, capabilities: cameraCapabilities }); await settle();
  assert.match(content(h.ids.get('experimentList')!), /1 张实际相机画面/);
  const details = all(h.workspace).find(node => node.tagName === 'details' && content(node).includes('查看设备原始回执'))!;
  assert.ok(details); assert.equal(details.attributes.open, undefined);
  assert.ok(all(details).some(node => node.tagName === 'code' && node.textContent.includes('Long driver output')));
  const largePrimary = all(h.workspace).filter(node => node.tagName === 'div' && node.className === 'meta-value' && node.textContent.length > 120);
  assert.equal(largePrimary.length, 0);
  assert.match(content(h.workspace), /相机采图/);
  assert.match(content(h.workspace), /参数调优/);
});

test('inactive manual controls stay disabled until automatic mode changes and a fresh readback confirms activation', async () => {
  const descriptors = { exposureUs: { value: 100, min: 10, max: 200, step: 1, writable: true, active: false }, autoExposure: { value: true, writable: true } };
  const h = setup({ experiment: cameraExperiment(), capabilities: cameraCapabilities, deviceResults: { controls_get: { controls: descriptors }, controls_set: { controls: { ...descriptors, autoExposure: { value: false, writable: true }, exposureUs: { ...descriptors.exposureUs, active: true } } } } }); await settle();
  await byText(h.workspace, '读取相机参数').fire('click'); await settle();
  assert.equal(fieldControl(h.workspace, '曝光时间').disabled, true);
  assert.equal(fieldControl(h.workspace, '自动曝光').disabled, false);
  assert.match(content(h.workspace), /先关闭自动模式并应用，再调整此项/);
  fieldControl(h.workspace, '曝光时间').value = '150';
  fieldControl(h.workspace, '自动曝光').value = 'false';
  await all(h.workspace).find(node => node.tagName === 'form')!.fire('submit'); await settle();
  const update = h.requests.find(request => request.path.endsWith('/device/controls_set'))!;
  assert.deepEqual(JSON.parse(String(update.options.body)), { values: { autoExposure: false } });
  assert.equal(fieldControl(h.workspace, '曝光时间').disabled, false);
});

test('saving camera baseline rereads the device rather than using an earlier probe snapshot', async () => {
  const stale = { config: { kind: 'uvc-controls-v1', controls: { gamma: 100 } }, rules: [{ path: '/controls/gamma', label: 'Gamma', min: 72, max: 500, step: 1 }] };
  const fresh = { ...stale, config: { ...stale.config, controls: { gamma: 120 } } };
  const h = setup({ experiment: { ...cameraExperiment(), deviceRuns: [{ operation: 'probe', status: 'completed', evidence: { result: { facts: { cameraName: 'Fixture UVC' }, baseline: stale } } }] }, capabilities: cameraCapabilities, deviceResults: { probe: { facts: { cameraName: 'Fixture UVC' }, baseline: fresh } } }); await settle();
  await byText(h.workspace, '保存设备当前参数为基线').fire('click'); await settle();
  const mutationPaths = h.requests.filter(request => request.options.method === 'POST').map(request => request.path.split('/').at(-1));
  assert.deepEqual(mutationPaths, ['probe', 'baseline']);
  const saved = h.requests.find(request => request.path.endsWith('/baseline'))!;
  assert.deepEqual(JSON.parse(String(saved.options.body)), fresh);
});

const debugCapabilities = { ...cameraCapabilities, aiDebug: { status: 'available' } };
const debugRun = (status = 'running') => ({ id: 'debug-1', source: 'model', status, goal: '保留文字细节，改善过曝', maxRounds: 4, iterations: [] as any[], cancelRequested: false, original: { hash: 'a'.repeat(64), frameId: 'original-frame', frameHash: 'a'.repeat(64), controls: { exposureUs: { value: 100, min: 10, max: 200, writable: true } } }, createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z' });

test('AI-native debugging starts from a natural-language goal without manual baseline or sample preparation', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, token: 'debug-auth', debugRun: debugRun('queued') }); await settle();
  const manual = all(h.workspace).find(node => node.tagName === 'details' && node.className.includes('manual-tools'))!;
  assert.equal(manual.open, false);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, false);
  fieldControl(h.workspace, '希望改善的画面问题').value = '文字和物体需要清晰，减少高光溢出';
  await byText(h.workspace, '让 AI 开始调试').fire('click'); await settle();
  const start = h.requests.find(request => request.path.endsWith('/ai-debug'))!;
  assert.deepEqual(JSON.parse(String(start.options.body)), { goal: '文字和物体需要清晰，减少高光溢出', maxRounds: 4 });
  assert.equal(start.options.headers['x-admin-token'], 'debug-auth');
  assert.equal(start.options.headers['X-RDK-Ops-Action'], 'observability');
  assert.equal(h.requests.filter(request => request.path.endsWith('/baseline') || request.path.endsWith('/evaluations') || request.path.endsWith('/samples')).length, 0);
  assert.equal(byText(h.workspace, 'AI 正在调试…').disabled, true);
  assert.equal(byText(h.workspace, '探测相机').disabled, true);
});

test('cancel requests remain pending until the async device run reports completion of recovery', async () => {
  const running = debugRun(); const canceled = { ...running, status: 'canceled', cancelRequested: true, stopReason: '用户停止', final: { restored: true, reason: '原始参数实际回读匹配' }, updatedAt: '2026-10-13T10:01:00Z' };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [running] }, capabilities: debugCapabilities, debugPollRun: canceled }); await settle();
  await byText(h.workspace, '停止并恢复原始参数').fire('click'); await settle();
  assert.match(content(h.workspace), /已请求停止 · 等待恢复回执/);
  assert.equal(byText(h.workspace, '正在停止并恢复…').disabled, true);
  assert.ok(h.requests.some(request => request.path.endsWith('/ai-debug/runs/debug-1/cancel')));
  await h.nextTimer();
  assert.match(content(h.workspace), /已停止/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, false);
  assert.equal(byText(h.workspace, '探测相机').disabled, false);
});

test('AI iteration evidence shows visual reasons and actual readback while never recording a human score', async () => {
  const run = { ...debugRun('completed'), stopReason: '已完成本次观察', best: { frameId: 'after-frame', frameHash: 'b'.repeat(64), iteration: 1, reason: '高光区减小，文字仍可辨认' }, final: { restored: false, reason: '保留实际最佳控制版本' }, iterations: [{ index: 1, source: 'model', model: 'verified-vision-model', action: 'adjust', notes: '<script>必须保留文字</script>', assessment: { issue: 'exposure', improved: true, sceneUsable: true, goalSatisfied: false, reason: '文字与边缘仍存在，亮部有细节' }, before: { frameId: 'original-frame', frameHash: 'a'.repeat(64), controls: { exposureUs: { value: 100 } } }, requestedValues: { exposureUs: 80 }, readback: { exposureUs: { value: 80 } }, after: { frameId: 'after-frame', frameHash: 'b'.repeat(64) }, createdAt: '2026-10-13T10:00:30Z' }] };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /来源：AI 视觉判断.*verified-vision-model/);
  assert.match(content(h.workspace), /文字与边缘仍存在，亮部有细节/);
  assert.match(content(h.workspace), /实际回读.*曝光.*100.*80.*80/);
  assert.match(content(h.workspace), /<script>必须保留文字<\/script>/);
  assert.ok(h.requests.some(request => request.path.endsWith('/frames/after-frame')));
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  await byText(h.workspace, '恢复本次运行前的参数').fire('click'); await settle();
  const restore = h.requests.find(request => request.path.endsWith('/restore-original'))!;
  assert.deepEqual(JSON.parse(String(restore.options.body)), {});
  assert.equal(h.requests.filter(request => request.path.endsWith('/device/controls_set') || request.path.endsWith('/evaluations')).length, 0);
});

test('debug progress retrieval failure stays explicit and keeps polling without inventing completion', async () => {
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [debugRun()] }, capabilities: debugCapabilities, failedDebugPoll: true }); await settle();
  await h.nextTimer();
  assert.match(content(h.workspace), /进度读取失败.*vision_debug_state_unavailable.*设备任务状态尚未确认/);
  assert.equal(byText(h.workspace, 'AI 正在调试…').disabled, true);
  await h.nextTimer();
  assert.equal(h.requests.filter(request => request.path.endsWith('/ai-debug/runs/debug-1')).length, 2);
});

test('unavailable visual planner blocks autonomous debugging even when statistics-only candidate generation is enabled', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: { ...cameraCapabilities, aiDebug: { status: 'unavailable', reason: '实际看图模型未启用' } } }); await settle();
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  assert.match(content(h.workspace), /实际看图模型未启用/);
  assert.equal(h.requests.filter(request => request.path.endsWith('/ai-debug')).length, 0);
});

test('frame candidate eligibility ignores old-baseline samples and caps only matching current PNG evidence', async () => {
  const oldFrames = Array.from({ length: 20 }, (_, index) => ({ id: 'old-' + index, mimeType: 'image/png', tuningHash: 'old-baseline' }));
  const empty = setup({ experiment: { ...cameraExperiment(), baseline, cameraFrames: oldFrames }, capabilities: cameraCapabilities }); await settle(); await empty.step(2);
  assert.equal(byText(empty.workspace, '生成 AI 参数候选').disabled, true);
  const current = setup({ experiment: { ...cameraExperiment(), baseline, cameraFrames: [...oldFrames, { id: 'current-frame', mimeType: 'image/png', tuningHash: baseline.hash }] }, capabilities: cameraCapabilities }); await settle(); await current.step(2);
  assert.equal(byText(current.workspace, '生成 AI 参数候选').disabled, false);
});

test('noise and detail regression stay model observations and restored device output is distinct from a historical AI best', async () => {
  const run = { ...debugRun('completed'), goalSatisfied: false, best: { frameId: 'rejected-best', frameHash: 'b'.repeat(64), reason: '先前模型推荐，实际需检查' },
    final: { restored: true, reason: 'operator_restored_original', frameId: 'fresh-restored', frameHash: 'c'.repeat(64), hash: 'a'.repeat(64), streamVerification: 'verified', visualVerification: 'unverified' },
    iterations: [{ index: 2, source: 'model', model: 'verified-vision-model', action: 'restore', notes: '噪点和文字损失明显，恢复原始参数', assessment: { issue: 'noise', improved: false, sceneUsable: true, goalSatisfied: false, reason: '变暗后颗粒增加，不是画质改善', regressions: ['noise', 'detail'] }, before: { frameId: 'rejected-best', frameHash: 'b'.repeat(64) }, createdAt: '2026-10-13T10:00:30Z' }] };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /AI 观察：噪点 \/ 颗粒/);
  assert.match(content(h.workspace), /AI 观察到画质回退：噪点或颗粒增加、文字或边缘细节丢失/);
  assert.match(content(h.workspace), /AI 曾推荐的历史观察（当前设备已恢复）/);
  assert.match(content(h.workspace), /最终设备实际画面.*恢复原始参数并回读后重新采集/);
  assert.doesNotMatch(content(h.workspace), /当前最佳观察结果/);
  assert.ok(h.requests.some(request => request.path.endsWith('/frames/fresh-restored')));
  assert.equal(h.requests.filter(request => request.path.endsWith('/evaluations')).length, 0);
});

test('AI admission rejects every missing executor prerequisite even when global AI is available', async () => {
  for (const missing of ['probe', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning']) {
    const incomplete = { ...cameraProfile, operations: cameraProfile.operations.filter(operation => operation !== missing && !(missing === 'controls_set' && operation === 'apply_tuning')) };
    const h = setup({ experiment: cameraExperiment(), capabilities: { ...debugCapabilities, deviceAdapters: [incomplete] } }); await settle();
    assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true, missing);
    assert.match(content(h.workspace), /AI 调试条件尚未齐备.*下一步：补齐/);
    assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  }
});

test('native ISP history shows actual requested leaves and separates getter success from new-frame verification', async () => {
  const readbackHash = 'a'.repeat(64);
  const run = { ...debugRun('completed'), iterations: [{ index: 1, action: 'adjust', source: 'model', requestedPatches: [{ path: '/modules/nr2d/auto_attr.sigma_scale_0_0', value: 2.1, reason: '本轮实际允许的叶子' }], readbackHash, notes: '检查细节与噪声', assessment: { improved: false, sceneUsable: true, goalSatisfied: false, issue: 'noise', reason: '尚无可靠提升' }, before: {}, after: { tuningHash: readbackHash }, createdAt: '2026-10-15T09:00:00Z' }] };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /原生 ISP 字段/); assert.match(content(h.workspace), /auto_attr.sigma_scale_0_0/);
  assert.match(content(h.workspace), /完整配置回读与调整后新帧一致/);
  const noFrame = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [{ ...run, iterations: [{ ...run.iterations[0], after: undefined }] }] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(noFrame.workspace), /完整配置已回读，尚未获得匹配的新帧验证/);
});

test('native apply_tuning can satisfy the configured write capability without a controls_set fallback', async () => {
  const native = { ...cameraProfile, operations: cameraProfile.operations.filter(operation => operation !== 'controls_set') };
  assert.ok(native.operations.includes('apply_tuning'));
  const h = setup({ experiment: cameraExperiment(), capabilities: { ...debugCapabilities, deviceAdapters: [native] } }); await settle();
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, false);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('connection guidance distinguishes import, missing binding and mismatched hardware', async () => {
  const imported = setup({ experiment: experiment(), capabilities: debugCapabilities }); await settle();
  assert.match(content(imported.workspace), /当前是文件导入实验.*新建设备实验/);
  assert.equal(byText(imported.workspace, '让 AI 开始调试').disabled, true);
  const missing = setup({ experiment: cameraExperiment(), capabilities: { ...debugCapabilities, deviceAdapters: [] } }); await settle();
  assert.match(content(missing.workspace), /绑定的相机连接已不可用.*恢复该连接/);
  const mismatched = setup({ experiment: { ...cameraExperiment(), sdkVersion: 'another-sdk' }, capabilities: debugCapabilities }); await settle();
  assert.match(content(mismatched.workspace), /实验与设备信息不匹配.*新建实验/);
  assert.equal(byText(mismatched.workspace, '让 AI 开始调试').disabled, true);
  assert.equal(byText(mismatched.workspace, '检查设备连接').disabled, true);
});

test('explicit connection check retains a real failure without auto-starting the driver', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, failedDevice: 'probe' }); await settle();
  assert.equal(h.requests.filter(request => request.path.includes('/device/')).length, 0);
  await byText(h.workspace, '检查设备连接').fire('click'); await settle();
  assert.match(content(h.workspace), /最近设备连接检查失败.*sdk_readback_failed/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  const calls = h.requests.filter(request => request.path.includes('/device/'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.endsWith('/probe'));
  assert.match(content(h.workspace), /启动已有驱动.*不会生成新相机驱动/);
});

test('opening creation selects the sole registered camera and still permits explicit file import', async () => {
  const h = setup({ capabilities: debugCapabilities }); await settle();
  await h.ids.get('newExperiment')!.fire('click');
  assert.equal(h.ids.get('adapterTarget')!.value, cameraProfile.id);
  assert.equal(h.ids.get('sensorModel')!.value, cameraProfile.sensorModel);
  assert.equal(h.ids.get('createDeviceDetails')!.open, false);
  assert.match(content(h.ids.get('createReadiness')!), /自动填写.*先检查连接/);
  h.ids.get('adapterTarget')!.value = ''; await h.ids.get('adapterTarget')!.fire('change');
  assert.match(content(h.ids.get('createReadiness')!), /文件导入实验/);
  assert.equal(h.ids.get('createDeviceDetails')!.open, true);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('AI uses the actual experiment goal instead of silently substituting a generic scene', async () => {
  const h = setup({ experiment: { ...cameraExperiment(), goal: '缩短运动物体拖影，同时保留暗部细节' }, capabilities: debugCapabilities }); await settle();
  assert.equal(fieldControl(h.workspace, '希望改善的画面问题').value, '缩短运动物体拖影，同时保留暗部细节');
});

test('completed execution is not styled as accepted quality and historical evidence is collapsed', async () => {
  for (const goalSatisfied of [false, true, undefined]) {
    const run = { ...debugRun('completed'), goalSatisfied, final: { restored: false, hash: 'a'.repeat(64), frameId: 'final-frame' }, best: { hash: 'a'.repeat(64), frameId: 'historical-frame' } };
    const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
    const summary = all(h.workspace).find(node => node.id === 'debugOutcome')!;
    assert.ok(!summary.className.split(' ').includes('ok'));
    assert.match(content(summary), goalSatisfied === false ? /本次目标未达成/ : goalSatisfied === true ? /AI 判断目标达到，画质待验收/ : /效果尚未确认/);
    assert.match(content(h.workspace), /本次最终参数.*保留本次选定参数.*画质验收.*尚未完成/);
    const history = all(h.workspace).filter(node => node.tagName === 'details' && /历史 AI 推荐|查看每轮判断/.test(content(node)));
    assert.equal(history.length, 2); assert.ok(history.every(node => !node.open));
    assert.ok(h.requests.some(request => request.path.endsWith('/frames/final-frame')));
  }
});

test('restoration error overrides stale restored final and suppresses its purported current image', async () => {
  const run = { ...debugRun('completed'), goalSatisfied: true, restorationError: 'getter_failed', final: { restored: true, hash: 'a'.repeat(64), frameId: 'stale-final' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /设备最终状态未确认.*当前参数未确认/);
  assert.match(content(h.workspace), /恢复未确认：getter_failed/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  assert.doesNotMatch(content(h.workspace), /最终设备状态：已恢复|此图在恢复原始参数并回读后重新采集/);
  assert.ok(!h.requests.some(request => request.path.endsWith('/frames/stale-final')));
});

test('missing final evidence and final image failure never fall back to historical output', async () => {
  const missing = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [{ ...debugRun('completed'), final: { restored: true } }] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(missing.workspace), /设备最终状态未确认/);
  const run = { ...debugRun('completed'), goalSatisfied: false, final: { restored: true, hash: 'a'.repeat(64), frameId: 'stale-final', imageError: 'capture_failed' }, best: { frameId: 'history' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /本次终态画面.*终态采图失败/);
  assert.match(content(h.workspace), /历史推荐图不能当作当前设备画面/);
  assert.ok(!h.requests.some(request => request.path.endsWith('/frames/stale-final')));
});

test('restored original assessment overrides the historical best goal result', async () => {
  const run = { ...debugRun('completed'), goalSatisfied: true,
    original: { ...debugRun().original, hash: 'a'.repeat(64), assessment: { goalSatisfied: false, sceneUsable: true, reason: '原始画面仍有反光' } },
    final: { restored: true, hash: 'a'.repeat(64), frameId: 'restored-original' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  const summary = all(h.workspace).find(node => node.id === 'debugOutcome')!;
  assert.match(content(summary), /本次目标未达成/);
  assert.match(content(h.workspace), /最终配置的 AI 观察：原始画面仍有反光/);
  assert.doesNotMatch(content(summary), /AI 判断目标达到/);
});

test('explicit failed SDK stream blocks AI even when stale readiness and matching restored hashes say otherwise', async () => {
  const run = { ...debugRun('completed'), final: { restored: true, hash: 'a'.repeat(64), streamVerification: 'failed', imageError: 'vision_device_sdk_error', frameId: 'stale-final' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /SDK 取帧失败，设备流恢复未确认/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  await byText(h.workspace, '让 AI 开始调试').fire('click'); await settle();
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.ok(!h.requests.some(request => request.path.endsWith('/frames/stale-final')));
  assert.doesNotMatch(content(h.workspace), /最终设备状态：已恢复/);
});

test('legacy configuration confirmation keeps stream verification unknown without blocking solely on absent stream metadata', async () => {
  const run = { ...debugRun('completed'), final: { restored: true, hash: 'a'.repeat(64), frameId: 'legacy-final' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities, readiness: { stages: [], recovery: { status: 'confirmed', streamVerification: 'unverified' }, aiDebug: { canStart: true } } }); await settle();
  assert.match(content(h.workspace), /参数回读已确认；设备流的新帧核验尚未记录/);
  assert.match(content(h.workspace), /已有终态图记录 · 流核验未记录/);
  assert.doesNotMatch(content(h.workspace), /已保存并核验终态新帧/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, false);
});

test('final configuration claims require the original or best configuration hash to match', async () => {
  const run = { ...debugRun('completed'), final: { restored: true, hash: 'b'.repeat(64), streamVerification: 'verified', frameId: 'wrong-final' } };
  const h = setup({ experiment: { ...cameraExperiment(), aiDebugRuns: [run] }, capabilities: debugCapabilities }); await settle();
  assert.match(content(h.workspace), /设备最终状态未确认/);
  assert.doesNotMatch(content(h.workspace), /最终设备状态：已恢复/);
  assert.ok(!h.requests.some(request => request.path.endsWith('/frames/wrong-final')));
});

test('readiness recovery fence from an earlier run is visible and prevents AI while latest run has no restoration error', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, readiness: { stages: [], recovery: { status: 'unconfirmed', reason: 'vision_ai_debug_stream_recovery_required', streamVerification: 'failed' }, aiDebug: { canStart: false, reason: 'vision_ai_debug_stream_recovery_required' } } }); await settle();
  assert.match(content(h.workspace), /SDK 取帧失败，设备流恢复未确认/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('SDK qualification and failed stream receipts are readable without automatically replaying device operations', async () => {
  for (const [id, reason, expected] of [['connection', 'native_sdk_runtime_unavailable', /原生 SDK 当前不可用.*配置登记不能证明运行兼容/], ['pipeline', 'camera_stream_capture_failed', /实际取帧失败.*不自动重启或重放失败操作/]] as const) {
    const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, readiness: { stages: [{ id, reason, status: 'failed', evidenceIds: ['failed-receipt'], missingOperations: [] }], recovery: { status: 'not_recorded' }, aiDebug: { canStart: false, reason } } }); await settle();
    assert.match(content(h.workspace), expected);
    assert.doesNotMatch(content(h.workspace), /可尝试 AI 调试/);
    assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
    assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
  }
});

test('unread readiness disables AI and blocks programmatic clicks without implicit retries', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, failedReadiness: true }); await settle();
  assert.match(content(h.workspace), /调试与恢复条件尚未读取/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  await byText(h.workspace, '让 AI 开始调试').fire('click'); await settle();
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('saved daemon cleanup and unknown write observations explain recovery without AI history or automatic actions', async () => {
  for (const [reason, expected] of [['camera_stream_cleanup_required', /保存的探测回执要求清理采集流/], ['isp_write_unconfirmed_restore_required', /保存的 ISP 写入结果未确认/]] as const) {
    const h = setup({experiment:cameraExperiment(),capabilities:debugCapabilities,readiness:{stages:[],recovery:{status:'unconfirmed',streamVerification:'unverified',source:'saved-device-probe',probeRunId:'recorded-probe',reason},aiDebug:{canStart:false,reason}}}); await settle();
    assert.match(content(h.workspace),expected); assert.match(content(h.workspace),/先显式停止.*重新检查设备连接/);
    assert.equal(byText(h.workspace,'让 AI 开始调试').disabled,true);
    assert.equal(byText(h.workspace,'检查设备连接').disabled,false,'a new explicit probe remains available to clear stale saved observations');
    assert.equal(h.requests.filter(request=>request.options.method==='POST').length,0);
  }
});

const calibrationOperations = ['POST /api/ops/observability/vision-workshop/experiments/:id/calibration/tasks'];
const fileJson = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); return { name: 'recorded-input.json', size: bytes.length, text: async () => bytes.toString(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; };

test('engineering stages consume persisted readiness without implicit hardware execution or false online status', async () => {
  const readiness = { evidenceSource: 'persisted-experiment', recovery: { status: 'unconfirmed' }, aiDebug: { canStart: false }, stages: [{ id: 'connection', status: 'configured', reason: 'device_connection_requires_probe', missingOperations: [], evidenceIds: [] }, { id: 'isp', status: 'failed', reason: 'saved_operation_failed', missingOperations: ['process_raw'], evidenceIds: ['failed-1'] }] };
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, readiness }); await settle();
  assert.match(content(h.workspace), /本实验路线.*仅投影本实验已保存的证据/);
  assert.match(content(h.workspace), /参数恢复尚未确认.*接口已配置 · 待执行.*最近执行失败/);
  assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, true);
  assert.equal(h.requests.filter(request => request.path.includes('/device/')).length, 0);
  await byText(h.workspace, '3 · 离线标定与采集条件').fire('click');
  assert.match(content(h.workspace), /离线标定 · 真实材料与任务/);
  assert.equal(all(h.workspace).find(node => node.id === 'manualEngineeringTools')!.open, true);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('readiness retrieval failure stays unknown and does not prevent exporting existing experiment records', async () => {
  const h = setup({ experiment: experiment(), failedReadiness: true }); await settle();
  assert.match(content(h.workspace), /阶段证据尚未确认.*readiness_unavailable/);
  await h.step(3); assert.equal(byText(h.workspace, '下载调优交付包').disabled, false);
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('UVC does not gain native effect-library writes from a global platform capability', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: { ...cameraCapabilities, atomicOperations: calibrationOperations } }); await settle(); await h.step(2);
  assert.match(content(h.workspace), /当前设备未提供原生 SDK 效果库接口.*UVC 控制配置不能作为完整 ISP/);
  for (const name of ['读取 SDK 参数并保存基线', '导出当前 SDK 效果库', '加载 SDK 效果库并回读']) assert.equal(byText(h.workspace, name).disabled, true);
  assert.equal(h.requests.filter(request => request.path.includes('/device/')).length, 0);
});

test('SDK effect-library export rejects incorrect actual file hashes and retains the failed feedback', async () => {
  const nativeProfile = { ...cameraProfile, operations: [...cameraProfile.operations, 'tuning_export'] }; const bytes = Buffer.from('{"actual":"sdk-file"}');
  const h = setup({ experiment: cameraExperiment(), capabilities: { ...cameraCapabilities, deviceAdapters: [nativeProfile] }, deviceResults: { tuning_export: { filename: 'actual-library.json', mimeType: 'application/json', contentBase64: bytes.toString('base64'), sha256: '0'.repeat(64) } } }); await settle(); await h.step(2);
  await byText(h.workspace, '导出当前 SDK 效果库').fire('click'); for (let i = 0; i < 8; i++) await settle();
  assert.match(content(h.feedback), /效果库文件哈希不匹配，未下载/);
  assert.doesNotMatch(content(h.feedback), /已校验并下载/);
  assert.ok(h.requests.some(request => request.path.endsWith('/device/tuning_export')));
});

test('SDK effect-library loading requires an owned restorable baseline and explicit conditions before submitting actual bytes', async () => {
  const nativeProfile = { ...cameraProfile, operations: [...cameraProfile.operations, 'tuning_load'] }; const sdkFile = fileJson({ actualSdkModule: { value: 2 } });
  const h = setup({ experiment: { ...cameraExperiment(), baseline }, capabilities: { ...cameraCapabilities, deviceAdapters: [nativeProfile] } }); await settle(); await h.step(2);
  const file = fieldControl(h.workspace, '匹配当前 Sensor 与模式的效果库文件'); file.files = [sdkFile];
  const confirmed = fieldControl(h.workspace, '已保存原始效果库，并核对相机、SDK 和模式'); const form = file.parent!.parent!;
  await form.fire('submit'); await settle(); assert.equal(h.requests.filter(request => request.path.endsWith('/device/tuning_load')).length, 0);
  (confirmed as any).checked = true; await form.fire('submit'); for (let i = 0; i < 8; i++) await settle();
  const request = h.requests.find(request => request.path.endsWith('/device/tuning_load'))!; assert.ok(request);
  const bytes = Buffer.from(await sdkFile.text()); assert.deepEqual(JSON.parse(String(request.options.body)), { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(request.options.headers['X-RDK-Ops-Action'], 'observability');
});

test('calibration inputs stay explicit and bounded while task creation does not automatically compute or write a device', async () => {
  const h = setup({ experiment: { ...experiment(), samples: [sample] }, capabilities: { ...capability, atomicOperations: calibrationOperations } }); await settle(); await h.step(2);
  assert.match(content(h.workspace), /至少 3 帧.*记录已遮光.*不在页面自动补造/);
  const file = fieldControl(h.workspace, '已记录采集条件的任务输入文件');
  file.files = [fileJson({ command: 'not-allowed', inputs: [{ sampleId: sample.id }] })]; await file.parent!.parent!.fire('submit'); await settle();
  assert.match(content(h.feedback), /不接受命令或文件路径/); assert.equal(h.requests.filter(request => request.path.endsWith('/calibration/tasks') && request.options.method === 'POST').length, 0);
  const input = { inputs: [{ sampleId: sample.id, capture: { target: 'lens_covered_dark', source: 'synthetic-fixture', preprocessing: 'sensor_raw_unprocessed', sensorMode: 'fixture-mode', exposureUs: 1000, analogGain: 1, lightBlocked: true } }] };
  file.files = [fileJson(input)]; await file.parent!.parent!.fire('submit'); await settle();
  const request = h.requests.find(request => request.path.endsWith('/calibration/tasks') && request.options.method === 'POST')!; assert.deepEqual(JSON.parse(String(request.options.body)), { operation: 'blc', ...input });
  assert.match(content(h.workspace), /待显式计算 · 不会自动排队运行/);
  assert.equal(h.requests.filter(request => request.path.endsWith('/run') || request.path.includes('/device/')).length, 0);
});

test('completed CPU calibration remains unverified and an actual calculation failure is persisted in the task list', async () => {
  const completed = { id: 'task-1', operation: 'lsc', status: 'completed', inputs: [{ artifactId: 'saved-raw' }], hardwareVerification: 'unverified', qualityVerification: 'unverified' };
  const h = setup({ experiment: experiment(), capabilities: { ...capability, atomicOperations: calibrationOperations }, calibrationTasks: [completed], failedCalibrationRun: true }); await settle(); await h.step(2);
  await byText(h.workspace, '读取标定任务与测量资产').fire('click'); await settle();
  assert.match(content(h.workspace), /已计算 · 未上板 \/ 未验收/); assert.equal(byText(h.workspace, '应用标定并核对 SDK 回读').disabled, true);
  await byText(h.workspace, '执行离线计算').fire('click'); await settle();
  assert.match(content(h.workspace), /计算失败.*vision_calibration_dark_capture_required/);
  assert.match(content(h.feedback), /vision_calibration_dark_capture_required/);
  assert.equal(byText(h.workspace, '下载标定结果 JSON').disabled, true);
});

test('calibration storage failure is unknown instead of an empty successful task list', async () => {
  const h = setup({ experiment: experiment(), capabilities: { ...capability, atomicOperations: calibrationOperations }, failedCalibrationList: true }); await settle(); await h.step(2);
  await byText(h.workspace, '读取标定任务与测量资产').fire('click'); await settle();
  assert.match(content(h.workspace), /标定记录读取失败.*calibration_store_unavailable.*任务状态尚未确认/);
  assert.match(content(h.workspace), /不能视为没有失败或已有标定结果/);
});

test('optional package failures and malformed external download paths never block a camera experiment', async () => {
  const h = setup({ experiment: cameraExperiment(), capabilities: debugCapabilities, failedPluginPackages: true }); await settle();
  assert.match(content(h.ids.get('pluginPackageLinks')!), /可选插件包暂不可用/); assert.equal(byText(h.workspace, '让 AI 开始调试').disabled, false);
  const bad = setup({ experiment: experiment(), pluginPackages: [{ kind: 'studio', name: 'bad', version: 'fake', bytes: 10, sha256: 'a'.repeat(64), downloadPath: 'https://external.test/file.zip' }] }); await settle();
  assert.match(content(bad.ids.get('pluginPackageLinks')!), /暂无经过核对的可下载插件包/);
  assert.equal(all(bad.ids.get('pluginPackageLinks')!).filter(node => node.tagName === 'button').length, 0);
});

test('package download uses authenticated fixed paths and verifies the real archive against the displayed version', async () => {
  const bytes = Buffer.from('synthetic-package-fixture'); const hash = createHash('sha256').update(bytes).digest('hex');
  const h = setup({ experiment: experiment(), token: 'token-fixture', pluginPackages: [{ kind: 'studio', name: 'RDK Camera Workshop', version: '1.0.0-fixture', bytes: bytes.length, sha256: hash, downloadPath: '/api/ops/observability/vision-workshop/plugin-packages/studio/download', requirements: ['Compatible local Studio host'] }], packageBlob: new Blob([bytes]) }); await settle();
  assert.match(content(h.ids.get('pluginPackageLinks')!), /1.0.0-fixture.*多账号云端桥接当前不可用.*不会升级旧客户端/);
  await byText(h.ids.get('pluginPackageLinks')!, '下载 Studio 插件包').fire('click'); for (let i = 0; i < 8; i++) await settle();
  const request = h.requests.find(request => request.path.endsWith('/plugin-packages/studio/download'))!; assert.ok(request); assert.equal(request.options.headers['x-admin-token'], 'token-fixture');
  assert.match(content(h.feedback), /插件包哈希已核对并下载/);
});
