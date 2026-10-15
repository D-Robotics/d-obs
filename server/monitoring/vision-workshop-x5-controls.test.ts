import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVisionIspPatches } from './vision-workshop-model.js';
import { validateVisionControlValues, type VisionCameraControls } from './vision-workshop-device.js';

test('X5 native CPROC candidates retain the actual SDK float32 value before hashing', () => {
  const tuning = { kind: 'x5-hbn-isp-controls-v1', controls: { contrast: 1, brightness: 0 } };
  const rules = [{ path: '/controls/contrast', label: 'contrast', min: 0, max: Math.fround(1.999) }];
  const patch = validateVisionIspPatches(tuning, rules, [{ path: '/controls/contrast', value: 1.1, reason: 'test fixture' }])[0];
  assert.equal(patch.value, Math.fround(1.1));
  assert.notEqual(patch.value, 1.1);
  const other = validateVisionIspPatches({ ...tuning, kind: 'uvc-controls-v1' }, rules, [{ path: '/controls/contrast', value: 1.1, reason: 'test fixture' }])[0];
  assert.equal(other.value, 1.1);
});

test('native quantization cannot move a candidate beyond admitted bounds', () => {
  assert.throws(() => validateVisionIspPatches({ kind: 'x5-hbn-isp-controls-v1', controls: { contrast: 1 } },
    [{ path: '/controls/contrast', label: 'contrast', min: 0, max: 1.1 }],
    [{ path: '/controls/contrast', value: 1.1, reason: 'test fixture' }]), /vision_patch_invalid/);
});

test('direct native control requests use the same precision as independent getters', () => {
  const contrast = { value: 1, min: 0, max: Math.fround(1.999), writable: true,
    nativeName: 'hbn_isp_cproc_attr_t.manual_attr.contrast' };
  const controls: VisionCameraControls = { contrast };
  assert.deepEqual(validateVisionControlValues({ contrast: 1.1 }, controls), { contrast: Math.fround(1.1) });
  assert.deepEqual(validateVisionControlValues({ contrast: 1.1 }, { contrast: { ...controls.contrast, nativeName: 'contrast' } }), { contrast: 1.1 });
  assert.throws(() => validateVisionControlValues({ contrast: 1.1 }, { contrast: { ...contrast, max: 1.1 } }), { code: 'vision_camera_control_out_of_range' });
});
