import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredVisionDevices, VisionDeviceRegistry, VISION_DEVICE_CONTRACT, type VisionDeviceProfile } from './vision-workshop-device.js';

const profile: VisionDeviceProfile = { id: 'x5-imx415', label: 'X5 Sony IMX415', board: 'RDK X5', sensorModel: 'IMX415', sdkVersion: 'sdk-test', operations: ['probe', 'capture_raw', 'apply_tuning'] };
const context = { experimentId: 'experiment', board: 'RDK X5' as const, sensorModel: 'IMX415', sdkVersion: 'sdk-test' };
test('device registry is empty unless SDK operations are explicitly registered', () => {
  const devices = configuredVisionDevices({}); assert.deepEqual(devices.list(), []);
  assert.throws(() => devices.get('x5-imx415'), /Configure a matching camera SDK/);
});
test('device context binds Sensor, SDK and supported operation before calling adapter', async () => {
  let called = 0;
  const devices = new VisionDeviceRegistry([{ profile, execute: async (_operation, received) => { called++; assert.match(received.jobId, /^[0-9a-f-]{36}$/); return { facts: { sensorModel: 'IMX415' } }; } }]);
  await assert.rejects(devices.execute(profile.id, 'probe', { ...context, sensorModel: 'IMX477' }, {}), /board, camera, SDK or pipeline/);
  await assert.rejects(devices.execute(profile.id, 'capture_raw', { ...context, sdkVersion: undefined }, {}), /SDK version/);
  await assert.rejects(devices.execute(profile.id, 'pipeline_validate', context, {}), /does not implement/);
  await devices.execute(profile.id, 'probe', context, {}); assert.equal(called, 1);
  const exposed = devices.list(); exposed[0].operations.length = 0; assert.equal(devices.list()[0].operations.length, 3);
});
test('server configuration hides credentials and binds request receipt to its job', async () => {
  const config = { ...profile, url: 'http://127.0.0.1:49381', token: 'test-private-token-0123456789' };
  let payload: Record<string, unknown> | undefined;
  const fetcher = (async (_url: unknown, init: RequestInit) => { payload = JSON.parse(String(init.body)); assert.equal((init.headers as Record<string, string>).authorization, 'Bearer ' + config.token); const received = payload!.context as Record<string, unknown>; return new Response(JSON.stringify({ ok: true, contract: VISION_DEVICE_CONTRACT, operation: payload!.operation, jobId: received.jobId, result: { facts: { sensorModel: 'IMX415' } } })); }) as typeof fetch;
  const devices = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([config]) }, fetcher);
  assert.ok(!JSON.stringify(devices.list()).includes(config.token)); assert.ok(!JSON.stringify(devices.list()).includes(config.url));
  await devices.execute(profile.id, 'probe', context, {}); assert.equal(payload!.contract, VISION_DEVICE_CONTRACT);
  const mismatched = configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([config]) }, (async () => new Response(JSON.stringify({ ok: true, contract: VISION_DEVICE_CONTRACT, operation: 'probe', jobId: 'different', result: {} }))) as typeof fetch);
  await assert.rejects(mismatched.execute(profile.id, 'probe', context, {}), /receipt does not match/);
});
test('invalid private config fails closed instead of silently disabling atomics', () => {
  for (const url of ['http://example.com', 'file:///tmp/runner', 'https://user:secret@example.com', 'https://example.com?token=x']) assert.throws(() => configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([{ ...profile, url, token: 'test-private-token-0123456789' }]) }), /Invalid server device adapter/);
  for (const key of ['board', 'sensorModel', 'sdkVersion']) assert.throws(() => configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: JSON.stringify([{ ...profile, [key]: undefined, url: 'http://127.0.0.1:49381', token: 'test-private-token-0123456789' }]) }), /Invalid server device adapter/);
  assert.throws(() => configuredVisionDevices({ RDK_VISION_DEVICE_ADAPTERS: '{' }), /Invalid server device adapter/);
});
test('configured camera identity binds board, vendor, SDK, interface and mode without hardcoded hardware families', async () => {
  const generic: VisionDeviceProfile = { id: 'generic-fixture', label: 'Other camera', board: 'Test board B', sensorModel: 'OV9281', sensorVendor: 'OmniVision', sdkVersion: 'sdk-v2', cameraInterface: 'CSI-2', cameraMode: '1280x720@60', operations: ['probe'] };
  let called = 0;
  const devices = new VisionDeviceRegistry([{ profile: generic, execute: async () => { called++; return { facts: { fixture: true } }; } }]);
  const snapshot = { experimentId: 'generic-exp', board: generic.board, sensorModel: generic.sensorModel, sdkVersion: generic.sdkVersion, sensorVendor: generic.sensorVendor, cameraInterface: generic.cameraInterface, cameraMode: generic.cameraMode };
  for (const field of ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'] as const) {
    await assert.rejects(devices.execute(generic.id, 'probe', { ...snapshot, [field]: 'different' }, {}), /board, camera, SDK or pipeline/);
  }
  await assert.rejects(devices.execute(generic.id, 'probe', { ...snapshot, cameraMode: undefined }, {}), /pipeline/);
  await devices.execute(generic.id, 'probe', snapshot, {}); assert.equal(called, 1);
  const replacement = new VisionDeviceRegistry([{ profile: { ...generic, cameraMode: '640x480@120' }, execute: async () => ({ facts: { fixture: true } }) }]);
  await assert.rejects(replacement.execute(generic.id, 'probe', snapshot, {}), /pipeline/);
  await replacement.execute(generic.id, 'probe', { ...snapshot, cameraMode: '640x480@120' }, {});
  // An unconfigured mode cannot be inferred from a client-supplied mode.
  await assert.rejects(new VisionDeviceRegistry([{ profile, execute: async () => ({}) }]).execute(profile.id, 'probe', { ...context, cameraMode: 'HDR' }, {}), /pipeline/);
});
test('device lease is shared across registries and is released on failure', async () => {
  let release: (() => void) | undefined;
  const first = new VisionDeviceRegistry([{ profile, execute: () => new Promise((resolve) => { release = () => resolve({ facts: { sensorModel: 'IMX415' } }); }) }]);
  const second = new VisionDeviceRegistry([{ profile, execute: async () => { throw new Error('SDK failed'); } }]);
  const running = first.execute(profile.id, 'probe', context, {});
  await assert.rejects(second.execute(profile.id, 'probe', context, {}), /Another operation/);
  release!(); await running;
  await assert.rejects(second.execute(profile.id, 'probe', context, {}), /SDK failed/);
  await assert.rejects(second.execute(profile.id, 'probe', context, {}), /SDK failed/);
});
test('changing a configured identity cannot execute concurrently under the same adapter id', async () => {
  let release!: () => void;
  const first = new VisionDeviceRegistry([{ profile, execute: () => new Promise(resolve => { release = () => resolve({ facts: { fixture: true } }); }) }]);
  const replacementProfile = { ...profile, board: 'Fixture board C', sensorModel: 'AR0234', sensorVendor: 'onsemi', sdkVersion: 'sdk-c', cameraInterface: 'CSI-2', cameraMode: 'fixture-mode-c' };
  let called = 0;
  const replacement = new VisionDeviceRegistry([{ profile: replacementProfile, execute: async () => { called++; return { facts: { fixture: true } }; } }]);
  const nextContext = { experimentId: 'new-experiment', board: replacementProfile.board, sensorModel: replacementProfile.sensorModel, sensorVendor: replacementProfile.sensorVendor, sdkVersion: replacementProfile.sdkVersion, cameraInterface: replacementProfile.cameraInterface, cameraMode: replacementProfile.cameraMode };
  const running = first.execute(profile.id, 'probe', context, {});
  await assert.rejects(replacement.execute(profile.id, 'probe', nextContext, {}), /Another operation/);
  release(); await running;
  await assert.rejects(replacement.execute(profile.id, 'probe', context, {}), /pipeline/);
  await replacement.execute(profile.id, 'probe', nextContext, {}); assert.equal(called, 1);
});

test('camera controls are checked against actual capabilities before writes and require matching readback', async () => {
  const camera = { ...profile, id: 'camera-controls-fixture', operations: ['controls_get', 'controls_set'] as const };
  const controls = { exposureUs: { value: 1000, min: 100, max: 5000, step: 100, writable: true }, gain: { value: 2, min: 0, max: 8, step: 1, writable: false }, autoExposure: { value: false, writable: true } };
  const calls: string[] = []; let mismatch = false;
  const registry = new VisionDeviceRegistry([{ profile: { ...camera, operations: [...camera.operations] }, execute: async (operation, _context, inputs) => {
    calls.push(operation); if (operation === 'controls_get') return { controls: structuredClone(controls) };
    const values = inputs.values as Record<string, number | boolean>;
    return { controls: { ...structuredClone(controls), exposureUs: { ...controls.exposureUs, value: mismatch ? 4000 : Number(values.exposureUs ?? 1000) }, autoExposure: { value: values.autoExposure ?? false, writable: true } } };
  } }]);
  for (const values of [{ unknownField: 1 }, { gain: 3 }, { exposureUs: 6000 }, { exposureUs: 1050 }, { autoExposure: 1 }]) {
    await assert.rejects(registry.execute(camera.id, 'controls_set', context, { values }));
    assert.ok(!calls.includes('controls_set')); calls.length = 0;
  }
  const set = await registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200, autoExposure: true } });
  assert.equal((set.result.controls as any).exposureUs.value, 1200); assert.deepEqual(calls, ['controls_get', 'controls_set']);
  mismatch = true; await assert.rejects(registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200 } }), /readback does not match/);
});

test('preview receipts cannot claim running state without actual dimensions', async () => {
  const preview = { ...profile, id: 'preview-fixture', operations: ['preview_start', 'preview_stop'] as const };
  let result: Record<string, unknown> = { running: true };
  const registry = new VisionDeviceRegistry([{ profile: { ...preview, operations: [...preview.operations] }, execute: async () => result }]);
  await assert.rejects(registry.execute(preview.id, 'preview_start', context, {}), /actual dimensions/);
  result = { running: true, width: 640, height: 480, fps: 30 }; await registry.execute(preview.id, 'preview_start', context, {});
  await assert.rejects(registry.execute(preview.id, 'preview_stop', context, {}), /stopped receipt/);
  result = { running: false }; await registry.execute(preview.id, 'preview_stop', context, {});
});

test('inactive manual controls require an explicit writable automatic-mode switch and active readback', async () => {
  const descriptor = { exposureUs: { value: 1000, min: 100, max: 5000, step: 100, writable: true, active: false }, autoExposure: { value: true, writable: true } };
  const camera = { ...profile, id: 'inactive-control-fixture', operations: ['controls_get', 'controls_set'] as const };
  let writes = 0; let remainsInactive = false;
  const registry = new VisionDeviceRegistry([{ profile: { ...camera, operations: [...camera.operations] }, execute: async (operation, _context, inputs) => {
    if (operation === 'controls_get') return { controls: structuredClone(descriptor) };
    writes++; const values = inputs.values as Record<string, number | boolean>;
    return { controls: { exposureUs: { ...descriptor.exposureUs, value: Number(values.exposureUs ?? 1000), active: !remainsInactive && values.autoExposure === false }, autoExposure: { value: values.autoExposure ?? true, writable: true } } };
  } }]);
  await assert.rejects(registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200 } }), /automatic mode/);
  await assert.rejects(registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200, autoExposure: true } }), /automatic mode/);
  assert.equal(writes, 0);
  const result = await registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200, autoExposure: false } });
  assert.equal((result.result.controls as any).exposureUs.active, true);
  remainsInactive = true;
  await assert.rejects(registry.execute(camera.id, 'controls_set', context, { values: { exposureUs: 1200, autoExposure: false } }), /readback does not match/);
});
