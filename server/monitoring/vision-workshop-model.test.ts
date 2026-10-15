import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeVisionRaw } from './vision-workshop-raw.js';
import { generateVisionIspCandidate, resolveVisionModelTarget, validateVisionBaseline, validateVisionIspPatches, visionModelEnabled,
  type VisionCameraContext, type VisionModelInput, type VisionNumericRule } from './vision-workshop-model.js';

const tuning = { isp: { gamma: { strength: 1 }, noise: 2 }, 'a/b': { '~gain': [3] }, api_key: 'UNRELATED_SECRET' };
const rules: VisionNumericRule[] = [{ path: '/isp/gamma/strength', label: 'Gamma 强度', min: 0.5, max: 2 }, { path: '/a~1b/~0gain/0', label: '已有数值', min: 0, max: 5 }];
const raw = Buffer.alloc(8); [0, 512, 256, 1023].forEach((value, index) => raw.writeUInt16LE(value, index * 2));
const statistics = analyzeVisionRaw(raw, { scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4, blackLevel: 0, whiteLevel: 1023 }).statistics;
function input(overrides: Partial<VisionModelInput> = {}): VisionModelInput {
  return { baseline: tuning, rules, rawStatistics: statistics, goal: '降低高光过曝，阴影适度提亮', ...overrides };
}

test('baseline validation clones an existing JSON tree and resolves escaped pointer and array leaves', () => {
  const baseline = validateVisionBaseline(tuning, rules);
  assert.deepEqual(baseline.tuning, tuning);
  assert.notEqual(baseline.tuning, tuning);
  assert.notEqual(baseline.tuning.isp, tuning.isp);
  assert.deepEqual(baseline.rules, rules);
  assert.deepEqual(validateVisionIspPatches(tuning, rules, [{ path: '/a~1b/~0gain/0', value: 5, reason: '已有字段范围内的待验证建议' }]),
    [{ path: '/a~1b/~0gain/0', value: 5, reason: '已有字段范围内的待验证建议' }]);
});

test('invalid baseline paths, values, ranges, unsafe keys and oversized structures are rejected', () => {
  for (const override of [
    { path: 'isp/gamma/strength' }, { path: '/isp/missing' }, { path: '/isp/gamma' }, { path: '/isp/~2bad' },
    { path: '/a~1b/~0gain/01' }, { path: '/isp/constructor' }, { path: '/isp/gamma/strength\0' },
    { min: 2, max: 1 }, { min: 1.1 }, { max: Infinity }, { label: '' },
  ]) assert.throws(() => validateVisionBaseline(tuning, [{ ...rules[0], ...override }]), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline(tuning, [rules[0], rules[0]]), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline(tuning, []), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline(tuning, Array.from({ length: 129 }, () => rules[0])), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline({ ...tuning, invalid: NaN }, rules), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline(JSON.parse('{"__proto__":{"polluted":true},"n":1}'), [{ path: '/n', label: 'n', min: 0, max: 2 }]), /vision_baseline_invalid/);
  let accessorRead = false;
  const accessor = { ...tuning }; Object.defineProperty(accessor, 'read', { enumerable: true, get() { accessorRead = true; return 1; } });
  assert.throws(() => validateVisionBaseline(accessor, rules), /vision_baseline_invalid/);
  assert.equal(accessorRead, false);
  const cycle: Record<string, unknown> = { ...tuning }; cycle.self = cycle;
  assert.throws(() => validateVisionBaseline(cycle, rules), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline({ ...tuning, payload: 'x'.repeat(1024 * 1024) }, rules), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline({ ...tuning, payload: Array.from({ length: 50_001 }, () => 0) }, rules), /vision_baseline_invalid/);
  let deep: unknown = 0; for (let index = 0; index < 33; index++) deep = { nested: deep };
  assert.throws(() => validateVisionBaseline({ ...tuning, deep }, rules), /vision_baseline_invalid/);
});

test('candidate generation gives the model only validated numeric baseline projections and real Raw statistics', async () => {
  const candidate = await generateVisionIspCandidate(input(), async messages => {
    assert.match(messages[0]!.content, /未提供原图/);
    assert.match(messages[0]!.content, /非可信数据/);
    assert.match(messages[0]!.content, /通用 ISP 参数候选助手/);
    assert.doesNotMatch(messages[0]!.content, /RDK X5|Sony|IMX/);
    assert.doesNotMatch(JSON.stringify(messages), /UNRELATED_SECRET/);
    const message = JSON.parse(messages[1]!.content);
    assert.equal(message.modelInput, 'raw_statistics_and_baseline');
    assert.equal(Object.hasOwn(message, 'cameraContext'), false, 'absent context must not acquire a default identity');
    assert.deepEqual(message.rawStatistics, [statistics]);
    assert.deepEqual(message.baseline.values[0], { ...rules[0], current: 1 });
    return { model: 'fixture-model', text: '```json\n{"patches":[{"path":"/isp/gamma/strength","value":1.2,"reason":"适度提亮，需真机验证"}]}\n```' };
  });
  assert.equal(candidate.source, 'model');
  assert.equal(candidate.model, 'fixture-model');
  assert.equal(candidate.modelInput, 'raw_statistics_and_baseline');
  assert.deepEqual(candidate.patches, [{ path: '/isp/gamma/strength', value: 1.2, reason: '适度提亮，需真机验证' }]);
  assert.deepEqual(JSON.parse(candidate.text), { patches: candidate.patches });
  assert.equal(tuning.isp.gamma.strength, 1);
});

test('model receives only explicitly recorded camera facts and remains usable for another vendor', async () => {
  const cameraContext: VisionCameraContext = { board: 'Customer carrier', sensorVendor: 'OmniVision', sensorModel: 'OV5647', sdkVersion: 'verified-sdk', cameraInterface: 'MIPI CSI-2', cameraMode: 'verified-mode' };
  await generateVisionIspCandidate(input({ cameraContext }), async messages => {
    const message = JSON.parse(messages[1]!.content);
    assert.deepEqual(message.cameraContext, cameraContext);
    assert.doesNotMatch(messages[0]!.content, /RDK X5|Sony|IMX/);
    assert.match(messages[0]!.content, /视为未知/);
    return { model: 'fixture-model', text: JSON.stringify({ patches: [{ path: rules[0]!.path, value: 1.2, reason: '仅在已有范围内提出待验证建议' }] }) };
  });
  await generateVisionIspCandidate(input({ cameraContext: { sensorVendor: 'Recorded vendor' } }), async messages => {
    assert.deepEqual(JSON.parse(messages[1]!.content).cameraContext, { sensorVendor: 'Recorded vendor' });
    return { model: 'fixture-model', text: JSON.stringify({ patches: [{ path: rules[0]!.path, value: 1.2, reason: '待验证建议' }] }) };
  });
});

test('camera context rejects unapproved connection fields, getters and malformed facts before model invocation', async () => {
  let calls = 0;
  const call = async () => { calls++; return { model: 'fixture', text: '{}' }; };
  for (const context of [{ host: 'private.example' }, { sensorModel: '' }, { sdkVersion: 'bad\nversion' }, { cameraMode: 'x'.repeat(257) }, { board: 1 }]) await assert.rejects(generateVisionIspCandidate(input({ cameraContext: context as VisionCameraContext }), call), /vision_model_invalid_camera_context/);
  let read = false; const getter = {}; Object.defineProperty(getter, 'board', { enumerable: true, get() { read = true; return 'unknown'; } });
  await assert.rejects(generateVisionIspCandidate(input({ cameraContext: getter }), call), /vision_model_invalid_camera_context/);
  assert.equal(read, false); assert.equal(calls, 0);
});

test('an invented path, out-of-range value, duplicate, missing reason or extra operation fails the whole model candidate', async () => {
  const valid = { path: '/isp/gamma/strength', value: 1.2, reason: '待验证' };
  for (const patches of [
    [{ ...valid, path: '/isp/invented' }], [{ ...valid, value: 2.001 }], [{ ...valid, value: 0.499 }],
    [{ ...valid, value: '1.2' }], [valid, valid], [{ ...valid, reason: '' }], [{ ...valid, reason: 'x'.repeat(241) }],
    [{ ...valid, op: 'remove' }], [], Array.from({ length: 33 }, () => valid), [valid, { ...valid, path: '/bad' }],
  ]) await assert.rejects(generateVisionIspCandidate(input(), async () => ({ model: 'fixture', text: JSON.stringify({ patches }) })), /vision_model_invalid_output/);
  for (const value of [0.5, 2]) {
    assert.equal(validateVisionIspPatches(tuning, rules, [{ ...valid, value }])[0]!.value, value);
  }
});

test('model outages, absent statistics, invalid baseline and bounded-output failures never create a fallback candidate', async () => {
  await assert.rejects(generateVisionIspCandidate(input(), async () => { throw new Error('PRIVATE_PROVIDER_KEY'); }), error => {
    assert.equal((error as Error).message, 'vision_model_unavailable'); return true;
  });
  for (const text of ['', 'not-json', '{}', '{"patches":[]}', 'x'.repeat(65_537),
    JSON.stringify({ patches: [{ path: rules[0]!.path, value: 1.2, reason: '候选' }], execute: 'ssh' })]) {
    await assert.rejects(generateVisionIspCandidate(input(), async () => ({ model: 'fixture', text })), /vision_model_invalid_output/);
  }
  let called = false;
  const caller = async () => { called = true; return { model: 'fixture', text: '{}' }; };
  await assert.rejects(generateVisionIspCandidate(input({ baseline: {} }), caller), /vision_baseline_invalid/);
  await assert.rejects(generateVisionIspCandidate(input({ rawStatistics: { ...statistics, sampleCount: 0 } }), caller), /vision_raw_statistics_invalid/);
  await assert.rejects(generateVisionIspCandidate(input({ rawStatistics: Array.from({ length: 17 }, () => statistics) }), caller), /vision_raw_statistics_invalid/);
  await assert.rejects(generateVisionIspCandidate(input({ goal: '' }), caller), /vision_model_invalid_goal/);
  assert.equal(called, false);
});

test('processed camera observations stay separate from Bayer RAW and redact arbitrary metadata', async () => {
  const frameStatistics = { method: 'png-output-statistics', pixelCount: 4, sampledPixels: 4,
    meanLuma: 0.3, stdLuma: 0.1, nearBlackRatio: 0, nearWhiteRatio: 0,
    channelMeans: { r: 0.3, g: 0.3, b: 0.3 }, roi: { x: 0, y: 0, width: 2, height: 2 },
    limitations: ['UNTRUSTED_PROVIDER_METADATA'], privateKey: 'UNRELATED_SECRET' };
  const candidate = await generateVisionIspCandidate(input({ rawStatistics: undefined, frameStatistics }), async messages => {
    assert.match(messages[0]!.content, /不能冒充 Bayer Raw/);
    const body = JSON.parse(messages[1]!.content);
    assert.equal(body.modelInput, 'processed_frame_statistics_and_baseline');
    assert.equal(Object.hasOwn(body, 'rawStatistics'), false);
    assert.equal(body.frameStatistics[0].method, 'png-output-statistics');
    assert.doesNotMatch(JSON.stringify(messages), /UNRELATED_SECRET|UNTRUSTED_PROVIDER_METADATA/);
    return { model: 'fixture', text: JSON.stringify({ patches: [{ path: rules[0]!.path, value: 1.2, reason: '待设备回读和实际场景确认' }] }) };
  });
  assert.equal(candidate.modelInput, 'processed_frame_statistics_and_baseline');
  const call = async () => { throw new Error('must not call'); };
  await assert.rejects(generateVisionIspCandidate(input({ frameStatistics }), call), /vision_model_mixed_evidence/);
  for (const bad of [{ ...frameStatistics, method: 'spatial_bayer_blocks' }, { ...frameStatistics, meanLuma: 1.01 }, { ...frameStatistics, pixelCount: 5 }]) {
    await assert.rejects(generateVisionIspCandidate(input({ rawStatistics: undefined, frameStatistics: bad }), call), /vision_frame_statistics_invalid/);
  }
});

test('native device quantization is enforced for baseline and model candidates', () => {
  const config = { controls: { exposureUs: 15600, gamma: 84 } };
  const deviceRules = [{ path: '/controls/exposureUs', label: '曝光 µs', min: 1000, max: 62600, step: 100 },
    { path: '/controls/gamma', label: 'Gamma', min: 64, max: 300, step: 1 }];
  assert.deepEqual(validateVisionBaseline(config, deviceRules).rules, deviceRules);
  assert.equal(validateVisionIspPatches(config, deviceRules, [{ path: '/controls/gamma', value: 89, reason: '小幅调整' }])[0]!.value, 89);
  for (const value of [89.5, 300.1]) assert.throws(() => validateVisionIspPatches(config, deviceRules, [{ path: '/controls/gamma', value, reason: 'invalid' }]), /vision_patch_invalid/);
  assert.throws(() => validateVisionBaseline(config, [{ ...deviceRules[0], step: 0 }]), /vision_baseline_invalid/);
  assert.throws(() => validateVisionBaseline({ controls: { exposureUs: 15650 } }, [deviceRules[0]]), /vision_baseline_invalid/);
});

const envNames = ['RDK_VISION_AI_ENABLED', 'RDK_VISION_AI_KEY', 'RDK_VISION_AI_MODEL', 'RDK_VISION_AI_URL',
  'RDK_LOG_AI_GATEWAY_KEY', 'RDK_LOG_AI_MODEL', 'RDK_LOG_AI_GATEWAY_URL', 'RDK_GATEWAY_ADMIN_URL'];
function isolateEnvironment(action: () => Promise<void> | void): Promise<void> {
  const saved = envNames.map(name => process.env[name]);
  for (const name of envNames) delete process.env[name];
  return Promise.resolve().then(action).finally(() => envNames.forEach((name, index) => {
    if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
  }));
}

test('vision inference is opt-in, uses dedicated credentials, and permits only HTTPS or loopback HTTP targets', async () => {
  await isolateEnvironment(async () => {
    process.env.RDK_LOG_AI_GATEWAY_KEY = 'fixture-log-key'; process.env.RDK_LOG_AI_MODEL = 'fixture-log-model';
    process.env.RDK_LOG_AI_GATEWAY_URL = 'http://127.0.0.1:3100/v1';
    assert.equal(visionModelEnabled(), false);
    process.env.RDK_VISION_AI_ENABLED = '1';
    assert.equal(visionModelEnabled(), true);
    assert.deepEqual(resolveVisionModelTarget(), { apiKey: 'fixture-log-key', model: 'fixture-log-model', baseUrl: 'http://127.0.0.1:3100/v1' });
    process.env.RDK_VISION_AI_KEY = 'fixture-vision-key'; process.env.RDK_VISION_AI_MODEL = 'fixture-vision-model';
    process.env.RDK_VISION_AI_URL = 'https://fixture.example/v1/';
    assert.deepEqual(resolveVisionModelTarget(), { apiKey: 'fixture-vision-key', model: 'fixture-vision-model', baseUrl: 'https://fixture.example/v1' });
    for (const url of ['http://remote.example/v1', 'file:///tmp/model', 'https://user:secret@example.com/v1', 'https://example.com/v1?token=x', 'https://example.com/v1#fragment']) {
      process.env.RDK_VISION_AI_URL = url;
      assert.equal(resolveVisionModelTarget(), null);
      assert.equal(visionModelEnabled(), false);
    }
    process.env.RDK_VISION_AI_URL = 'http://[::1]:3100/v1';
    assert.equal(visionModelEnabled(), true);
    process.env.RDK_VISION_AI_ENABLED = '0';
    await assert.rejects(generateVisionIspCandidate(input()), /vision_model_disabled/);
  });
});

test('default gateway call has a timeout signal, rejects redirects and oversized bodies without leaking upstream errors', async () => {
  await isolateEnvironment(async () => {
    process.env.RDK_VISION_AI_ENABLED = '1'; process.env.RDK_VISION_AI_KEY = 'fixture-vision-key';
    process.env.RDK_VISION_AI_MODEL = 'fixture-model'; process.env.RDK_VISION_AI_URL = 'https://fixture.example/v1';
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://fixture.example/v1/chat/completions');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal instanceof AbortSignal);
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-vision-key');
        assert.equal(JSON.parse(String(init?.body)).model, 'fixture-model');
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"patches":[{"path":"/isp/gamma/strength","value":1.25,"reason":"需验证"}]}' } }] }));
      };
      assert.equal((await generateVisionIspCandidate(input())).patches[0]!.value, 1.25);
      globalThis.fetch = async () => new Response('UPSTREAM_PRIVATE_ERROR', { status: 403 });
      await assert.rejects(generateVisionIspCandidate(input()), /^Error: vision_model_unavailable$/);
      globalThis.fetch = async () => new Response('body', { headers: { 'content-length': String(1024 * 1024 + 1) } });
      await assert.rejects(generateVisionIspCandidate(input()), /vision_model_unavailable/);
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }));
      await assert.rejects(generateVisionIspCandidate(input()), /vision_model_unavailable/);
      assert.equal(cancelled, true);
    } finally { globalThis.fetch = savedFetch; }
  });
});
