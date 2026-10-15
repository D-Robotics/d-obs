import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { visionCrc32 } from './vision-workshop-export.js';
import { analyzeVisionProcessedPng } from './vision-workshop-quality.js';
import { planVisionCameraDebug, visionDebugImageHash, type VisionAiDebugInput, type VisionDebugModelCaller } from './vision-workshop-ai-model.js';

function png(): Buffer {
  const chunk = (name: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const payload = Buffer.concat([Buffer.from(name), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(visionCrc32(payload)); return Buffer.concat([length, payload, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 20, 40, 60, 60, 80, 100, 0, 100, 120, 140, 140, 160, 180]))), chunk('IEND', Buffer.alloc(0))]);
}
const bytes = png();
const image = { mimeType: 'image/png' as const, contentBase64: bytes.toString('base64') };
const input = (extra: Partial<VisionAiDebugInput> = {}): VisionAiDebugInput => ({ goal: '减轻高光并保留可识别文字', round: 0, maxRounds: 4,
  controls: { exposureUs: { value: 15600, min: 1000, max: 62600, step: 100, writable: true, active: false }, autoExposure: { value: true, writable: true } },
  originalImage: image, currentImage: image, bestImage: image, currentStatistics: analyzeVisionProcessedPng(bytes), history: [], ...extra });
const valid = { action: 'adjust', values: { autoExposure: false, exposureUs: 8000 }, notes: '关闭自动曝光后小幅降低曝光并重新观察真实图像。',
  assessment: { improved: false, sceneUsable: true, goalSatisfied: false, issue: 'exposure', reason: '当前图像仍有局部反光，尚未调整。', regressions: [] }, done: false };
const caller = (decision: unknown): VisionDebugModelCaller => async () => ({ model: 'explicit-fixture-vision', toolCalls: [{ name: 'camera_debug_decision', arguments: JSON.stringify(decision) }] });

test('AI debug submits actual images and a supported bounded tool schema, never only text statistics', async () => {
  const result = await planVisionCameraDebug(input(), async request => {
    assert.equal(request.tool_choice, 'auto');
    const content = request.messages[1]!.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.filter(part => part.type === 'image_url').length, 3);
    for (const part of content.filter(part => part.type === 'image_url')) assert.equal(part.image_url.url, 'data:image/png;base64,' + image.contentBase64);
    const tool = request.tools[0] as any;
    assert.deepEqual(Object.keys(tool.function.parameters.properties.values.properties), ['exposureUs', 'autoExposure']);
    assert.equal(tool.function.parameters.properties.values.additionalProperties, false);
    assert.equal(tool.function.parameters.properties.values.maxProperties, 3);
    return caller(valid)(request);
  });
  assert.equal(result.source, 'model'); assert.equal(result.modelInput, 'camera_images_controls_and_history');
  assert.deepEqual(result.values, valid.values); assert.match(visionDebugImageHash(image), /^[a-f0-9]{64}$/);
});

test('tool decisions reject invented controls, inactive writes, off-step and out-of-range values', async () => {
  for (const values of [{ exposureUs: 8000 }, { exposureUs: 8050, autoExposure: false }, { exposureUs: 0, autoExposure: false }, { imaginaryIsp: 1 }]) {
    await assert.rejects(planVisionCameraDebug(input(), caller({ ...valid, values })));
  }
  await assert.rejects(planVisionCameraDebug(input(), caller({ ...valid, action: 'stop' })), /output_invalid/);
  await assert.rejects(planVisionCameraDebug(input(), caller({ ...valid, done: true })), /output_invalid/);
});

test('blank scene and lower brightness cannot be accepted as improvement or completed quality', async () => {
  for (const assessment of [{ ...valid.assessment, sceneUsable: false, improved: true }, { ...valid.assessment, sceneUsable: false, goalSatisfied: true }]) {
    await assert.rejects(planVisionCameraDebug(input(), caller({ ...valid, assessment })), /output_invalid/);
  }
  const stopped = await planVisionCameraDebug(input(), caller({ ...valid, action: 'stop', values: undefined, done: true,
    assessment: { ...valid.assessment, sceneUsable: false, issue: 'scene', reason: '画面无法辨认，需检查镜头或对准实际物体。' } }));
  assert.equal(stopped.assessment.goalSatisfied, false); assert.equal(stopped.action, 'stop');
});

test('final assessment cannot add another adjustment and cancel propagates without a fallback', async () => {
  await assert.rejects(planVisionCameraDebug(input({ assessmentOnly: true }), caller(valid)), /output_invalid/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(planVisionCameraDebug(input({ signal: controller.signal }), async () => { throw new Error('private provider error'); }), /canceled/);
  await assert.rejects(planVisionCameraDebug(input(), async () => { throw new Error('private provider error'); }), /^Error: vision_ai_debug_model_unavailable$/);
});

test('model must select one approved function and bounded valid camera image bytes', async () => {
  for (const response of [{ model: 'fixture', toolCalls: [] }, { model: 'fixture', toolCalls: [{ name: 'exec_command', arguments: '{}' }] },
    { model: 'fixture', toolCalls: [{ name: 'camera_debug_decision', arguments: 'not JSON' }] }]) {
    await assert.rejects(planVisionCameraDebug(input(), async () => response), /output_invalid/);
  }
  let calls = 0;
  for (const img of [{ mimeType: 'image/png', contentBase64: 'bad' }, { mimeType: 'image/png', contentBase64: Buffer.from('a private file').toString('base64') },
    { mimeType: 'image/jpeg', contentBase64: image.contentBase64 }]) {
    await assert.rejects(planVisionCameraDebug(input({ currentImage: img as typeof image }), async () => { calls++; return { model: '', toolCalls: [] }; }), /image_invalid/);
  }
  assert.equal(calls, 0);
});

test('invalid tool call is reported to the model once and never silently pruned or executed', async () => {
  let calls = 0;
  const repaired = await planVisionCameraDebug(input(), async request => {
    calls++;
    if (calls === 1) return caller({ ...valid, values: { exposureUs: 8050, autoExposure: false } })(request);
    assert.match(String(request.messages.at(-1)?.content), /工具拒绝.*尚未执行任何设备操作/);
    return caller(valid)(request);
  });
  assert.equal(calls, 2); assert.equal(repaired.values!.exposureUs, 8000);
  assert.equal(repaired.validationWarnings?.length, 1);
  let rejectedCalls = 0;
  await assert.rejects(planVisionCameraDebug(input(), async request => { rejectedCalls++; return caller({ ...valid, values: { exposureUs: 8050, autoExposure: false } })(request); }));
  assert.equal(rejectedCalls, 2);
});

test('highlight reduction with visible noise or detail regression cannot become a successful best image', async () => {
  const regression = { ...valid, action: 'keep', values: undefined, done: true,
    assessment: { ...valid.assessment, improved: true, regressions: ['noise'], reason: '高光减少但噪声颗粒明显增多。' } };
  await assert.rejects(planVisionCameraDebug(input(), caller(regression)), /visual_regression/);
  const restored = await planVisionCameraDebug(input(), caller({ ...regression, action: 'restore',
    assessment: { ...regression.assessment, improved: false, goalSatisfied: false, issue: 'noise' } }));
  assert.equal(restored.action, 'restore'); assert.deepEqual(restored.assessment.regressions, ['noise']);
  await assert.rejects(planVisionCameraDebug(input(), caller({ ...valid, assessment: { ...valid.assessment, regressions: undefined } })), /output_invalid/);
});

const nativeTuning = {
  config: { kind: 'x5-hbn-isp-v2', snapshotId: 'PRIVATE_SNAPSHOT', modules: { nr2d: { mode: 0, values: { sigma_scale_0_0: 2 }, privateSdkBytes: 'PRIVATE_SDK_BYTES' } }, library: { contentBase64: 'PRIVATE_LIBRARY_BYTES' } },
  rules: [{ path: '/modules/nr2d/values/sigma_scale_0_0', label: 'Fixture AUTO sigma first slot', min: 1, max: 4, precision: 'float32' as const }],
};
const nativeValid = { ...valid, values: undefined, patches: [{ path: nativeTuning.rules[0].path, value: 2.1, reason: '小幅修改实际AUTO叶子后重新比较噪声和细节' }] };

test('native model receives only qualified numeric leaves and returns precision-normalized patches', async () => {
  const result = await planVisionCameraDebug(input({ tuning: nativeTuning }), async request => {
    const serialized = JSON.stringify(request);
    for (const privateValue of ['PRIVATE_SNAPSHOT', 'PRIVATE_SDK_BYTES', 'PRIVATE_LIBRARY_BYTES', 'privateSdkBytes', 'contentBase64']) assert.equal(serialized.includes(privateValue), false);
    const tool = request.tools[0] as any;
    assert.equal(tool.function.parameters.properties.values, undefined);
    assert.equal(tool.function.parameters.properties.patches.maxItems, 3);
    assert.deepEqual(tool.function.parameters.properties.patches.items.properties.path.enum, [nativeTuning.rules[0].path]);
    const content = request.messages[1].content;
    assert.ok(Array.isArray(content));
    const evidence = JSON.parse(content.filter(part => part.type === 'text').at(-1)!.text);
    assert.deepEqual(evidence.tuning.values, [{ ...nativeTuning.rules[0], current: 2 }]);
    return caller(nativeValid)(request);
  });
  assert.equal(result.values, undefined); assert.equal(result.patches?.[0].value, Math.fround(2.1));
  assert.equal(nativeTuning.config.modules.nr2d.values.sigma_scale_0_0, 2);
});

test('native decisions cannot invent paths, exceed bounds, mix channels or bypass qualification through flat controls', async () => {
  for (const decision of [
    { ...nativeValid, patches: [{ ...nativeValid.patches[0], path: '/modules/exposure/unqualified' }] },
    { ...nativeValid, patches: [{ ...nativeValid.patches[0], value: 5 }] },
    { ...nativeValid, patches: Array.from({ length: 4 }, () => nativeValid.patches[0]) },
    { ...nativeValid, values: { exposureUs: 8000, autoExposure: false } },
    valid,
    { ...nativeValid, action: 'keep' },
  ]) await assert.rejects(planVisionCameraDebug(input({ tuning: nativeTuning }), caller(decision)));
  await assert.rejects(planVisionCameraDebug(input(), caller(nativeValid)), /output_invalid/);
  await assert.rejects(planVisionCameraDebug(input({ tuning: nativeTuning, assessmentOnly: true }), caller(nativeValid)), /output_invalid/);
  await assert.rejects(planVisionCameraDebug(input({ tuning: { ...nativeTuning, config: { ...nativeTuning.config, kind: 'invented-native-kind' } } }), caller(nativeValid)), /input_invalid/);
});

test('native patches retain rule step checks and do not open inactive or absent AE/AWB fields', async () => {
  const tuning = { ...nativeTuning, rules: [{ ...nativeTuning.rules[0], step: 0.5 }] };
  await assert.rejects(planVisionCameraDebug(input({ tuning }), caller(nativeValid)), /vision_patch_invalid/);
  const result = await planVisionCameraDebug(input({ tuning }), caller({ ...nativeValid, patches: [{ ...nativeValid.patches[0], value: 2.5 }] }));
  assert.equal(result.patches?.[0].value, 2.5);
});

const previewProvenance = { width: 2, height: 2, sourceWidth: 3840, sourceHeight: 2160, sourceSha256: '1'.repeat(64), sha256: visionDebugImageHash(image), method: 'area-average-png-preview' as const };
test('model image evidence binds bounded preview bytes to the original source and records dimensions', async () => {
  const preview = { ...image, provenance: previewProvenance };
  const stopped = { ...valid, action: 'stop', values: undefined, done: true };
  await planVisionCameraDebug(input({ originalImage: preview, currentImage: preview, bestImage: preview }), async request => {
    const content = request.messages[1].content;
    assert.ok(Array.isArray(content));
    const evidence = JSON.parse(content.filter(part => part.type === 'text').at(-1)!.text);
    assert.deepEqual(evidence.images.original, previewProvenance);
    assert.deepEqual(evidence.images.best, previewProvenance); assert.deepEqual(evidence.images.current, previewProvenance);
    return caller(stopped)(request);
  });
  let calls = 0;
  for (const provenance of [
    { ...previewProvenance, sha256: '0'.repeat(64) }, { ...previewProvenance, sourceSha256: 'invalid' },
    { ...previewProvenance, width: 3 }, { ...previewProvenance, height: 721 },
    { ...previewProvenance, sourceWidth: 1 }, { ...previewProvenance, method: 'invented-preview' },
    { ...previewProvenance, privateBytes: 'not allowed' },
  ]) await assert.rejects(planVisionCameraDebug(input({ currentImage: { ...image, provenance } as any }), async request => { calls++; return caller(stopped)(request); }), /image_invalid/);
  assert.equal(calls, 0);
});
