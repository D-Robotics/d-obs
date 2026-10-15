import assert from 'node:assert/strict';
import test from 'node:test';
import { VISION_DEVICE_OPERATIONS, validateVisionCameraControls, validateVisionControlValues } from './vision-workshop-device.js';
import { generateVisionIspCandidate, validateVisionBaseline, validateVisionIspPatches } from './vision-workshop-model.js';
import { analyzeVisionRaw } from './vision-workshop-raw.js';

test('native precision descriptors and policy rules survive validation', () => {
  const rules = [{ path: '/isp/gain', label: 'SDK gain', min: 0, max: 2, precision: 'float32' }];
  assert.deepEqual(validateVisionBaseline({ isp: { gain: 1 } }, rules).rules, rules);
  const descriptor = { value: 1, min: 0, max: 2, writable: true, nativePrecision: 'float32', unit: 'SDK units' };
  assert.deepEqual(validateVisionCameraControls({ gain: descriptor }), { gain: descriptor });
});

test('float32 and seconds-float32-us requests use getter precision before dispatch/hash', () => {
  const controls = validateVisionCameraControls({
    gain: { value: 1, min: 0, max: 2, writable: true, nativePrecision: 'float32' },
    exposureUs: { value: 1000, min: 1, max: 2000, writable: true, nativePrecision: 'seconds-float32-us', unit: 'us' },
  });
  assert.deepEqual(validateVisionControlValues({ gain: 1.1, exposureUs: 1200 }, controls), {
    gain: Math.fround(1.1), exposureUs: Math.fround(1200 / 1e6) * 1e6,
  });
  const patch = validateVisionIspPatches({ isp: { exposure: 1000 } },
    [{ path: '/isp/exposure', label: 'µs', min: 1, max: 2000, precision: 'seconds-float32-us' }],
    [{ path: '/isp/exposure', value: 1200, reason: 'SDK precision fixture' }])[0]!;
  assert.equal(patch.value, Math.fround(1200 / 1e6) * 1e6);
});

test('quantized values are rechecked against the operator bounds and steps', () => {
  const controls = validateVisionCameraControls({ gain: { value: 1, min: 0, max: 1.1, writable: true, nativePrecision: 'float32' } });
  assert.throws(() => validateVisionControlValues({ gain: 1.1 }, controls), { code: 'vision_camera_control_out_of_range' });
  assert.throws(() => validateVisionIspPatches({ isp: { gain: 1 } },
    [{ path: '/isp/gain', label: 'gain', min: 0, max: 1.1, precision: 'float32' }],
    [{ path: '/isp/gain', value: 1.1, reason: 'must fail' }]), /vision_patch_invalid/);
  assert.throws(() => validateVisionControlValues({ gain: Number.MAX_VALUE }, controls), { code: 'vision_camera_controls_request_invalid' });
});

test('unknown or boolean native precision cannot enter a trusted descriptor/rule', () => {
  for (const precision of ['float16', 'shell', null, 1]) {
    assert.throws(() => validateVisionBaseline({ gain: 1 }, [{ path: '/gain', label: 'gain', min: 0, max: 2, precision }]), /vision_baseline_invalid/);
    assert.throws(() => validateVisionCameraControls({ gain: { value: 1, min: 0, max: 2, writable: true, nativePrecision: precision } }), { code: 'vision_camera_controls_invalid' });
  }
  assert.throws(() => validateVisionCameraControls({ automatic: { value: true, writable: true, nativePrecision: 'float32' } }), { code: 'vision_camera_controls_invalid' });
});

test('the four native ISP tuning/calibration operations are registered', () => {
  for (const operation of ['tuning_get', 'tuning_load', 'tuning_export', 'calibration_apply']) {
    assert.ok(VISION_DEVICE_OPERATIONS.some(known => known === operation));
  }
});

test('the model sees operator precision while candidates cannot override it', async () => {
  const rawStatistics = analyzeVisionRaw(Buffer.alloc(8), { scene: 'protocol fixture', width: 2, height: 2, stride: 4,
    bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', blackLevel: 0, whiteLevel: 1023 }).statistics;
  const input = { baseline: { gain: 1 }, rules: [{ path: '/gain', label: 'SDK gain', min: 0, max: 2, precision: 'float32' }], rawStatistics, goal: 'Precision protocol fixture' };
  const result = await generateVisionIspCandidate(input, async messages => {
    const body = JSON.parse(messages[1]!.content);
    assert.equal(body.baseline.values[0].precision, 'float32');
    return { model: 'fixture', text: JSON.stringify({ patches: [{ path: '/gain', value: 1.1, reason: 'fixture' }] }) };
  });
  assert.equal(result.patches[0]!.value, Math.fround(1.1));
  await assert.rejects(generateVisionIspCandidate(input, async () => ({ model: 'fixture', text: JSON.stringify({ patches: [{ path: '/gain', value: 1.1, reason: 'fixture', precision: 'float64' }] }) })), /vision_model_invalid_output/);
});
