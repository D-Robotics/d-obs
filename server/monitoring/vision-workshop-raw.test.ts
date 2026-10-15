import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { analyzeVisionRaw, validateVisionRaw, validateVisionRawMetadata, type VisionRawMetadata } from './vision-workshop-raw.js';

function metadata(overrides: Partial<VisionRawMetadata> = {}): VisionRawMetadata {
  return { scene: '逆光', width: 2, height: 2, bitDepth: 10, bayer: 'RGGB', packing: 'unpacked16le', stride: 4,
    blackLevel: 0, whiteLevel: 1023, ...overrides };
}
function words(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2); values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2)); return bytes;
}
function pngPixels(png: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return inflateSync(Buffer.concat(chunks));
}

test('real unpacked pixels produce exact Bayer channel statistics and a labelled PNG preview', () => {
  const result = analyzeVisionRaw(words([1023, 512, 256, 0]), metadata());
  assert.equal(result.statistics.sampleCount, 4);
  assert.equal(result.statistics.pixelCount, 4);
  assert.equal(result.statistics.sampled, false);
  assert.deepEqual(result.statistics.channelMeans, { R: 1023, G: 384, B: 0 });
  assert.equal(result.statistics.saturationRatio, 0.25);
  assert.equal(result.statistics.blackLevelRatio, 0.25);
  assert.equal(result.statistics.meanNormalized, (1023 + 512 + 256) / (4 * 1023));
  assert.deepEqual([...result.previewPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(result.previewPng.readUInt32BE(16), 1);
  assert.equal(result.previewPng.readUInt32BE(20), 1);
  assert.deepEqual([...pngPixels(result.previewPng)], [0, 255, Math.round((384 / 1023) ** (1 / 2.2) * 255), 0]);
  assert.match(result.preview.label, /非 ISP 输出/);
  assert.ok(result.warnings.some((row) => row.includes('不能单独证明')));
});

test('RAW10 uses the MIPI four-high-byte plus interleaved two-bit layout, ignoring stride padding', () => {
  // Row 1: 0,1,1023,512. Row 2: 256,0,3,255. 0xAA is row padding.
  const bytes = Buffer.from([0, 0, 255, 128, 0x34, 0xaa, 0xaa, 64, 0, 0, 63, 0xf0, 0xaa, 0xaa]);
  const result = analyzeVisionRaw(bytes, metadata({ width: 4, stride: 7, packing: 'mipi-raw10' }));
  assert.deepEqual(result.statistics.channelMeans, { R: 511.5, G: 193, B: 127.5 });
  assert.equal(result.statistics.saturationRatio, 1 / 8);
  assert.equal(result.statistics.blackLevelRatio, 2 / 8);
  assert.equal(result.statistics.min, 0);
  assert.equal(result.statistics.max, 1023);
});

test('RAW12 decodes both low nibbles and honors a padded row', () => {
  // Each row is one pair: R=4095,G=16 / G=2048,B=15.
  const bytes = Buffer.from([255, 1, 0x0f, 0xee, 128, 0, 0xf0, 0xee]);
  const result = analyzeVisionRaw(bytes, metadata({ bitDepth: 12, whiteLevel: 4095, stride: 4, packing: 'mipi-raw12' }));
  assert.deepEqual(result.statistics.channelMeans, { R: 4095, G: 1032, B: 15 });
  assert.equal(result.statistics.saturationRatio, 0.25);
  assert.equal(result.statistics.blackLevelRatio, 0);
});

test('all Bayer layouts preserve channel identity and black/white clipping', () => {
  const expected = {
    RGGB: { R: 1, G: 2.5, B: 4 }, BGGR: { R: 4, G: 2.5, B: 1 },
    GRBG: { R: 2, G: 2.5, B: 3 }, GBRG: { R: 3, G: 2.5, B: 2 },
  };
  for (const bayer of Object.keys(expected) as VisionRawMetadata['bayer'][]) {
    const result = analyzeVisionRaw(words([1, 2, 3, 4]), metadata({ bayer, blackLevel: 2, whiteLevel: 3 }));
    assert.deepEqual(result.statistics.channelMeans, expected[bayer]);
    assert.equal(result.statistics.meanNormalized, 0.5);
    assert.equal(result.statistics.saturationRatio, 0.5);
    assert.equal(result.statistics.blackLevelRatio, 0.5);
  }
});

test('invalid byte counts, bit depths, packing, row sizes and pixel limits fail before analysis', () => {
  const invalid = [
    { width: 3 }, { height: 3 }, { width: 8192, height: 8192 }, { bitDepth: 9 }, { bayer: 'RGB' },
    { packing: 'mipi-raw10', width: 2 }, { packing: 'mipi-raw12', bitDepth: 10 }, { stride: 3 },
    { blackLevel: 1023 }, { whiteLevel: 1024 }, { blackLevel: 4, whiteLevel: 4 }, { scene: '' },
    { gain: 0 }, { exposureUs: Infinity }, { scene: 'abc\0def' },
  ];
  for (const override of invalid) assert.throws(() => validateVisionRawMetadata({ ...metadata(), ...override }), /vision_raw_invalid/);
  assert.throws(() => validateVisionRaw(Buffer.alloc(7), metadata()), /byte count/);
  assert.throws(() => validateVisionRaw(Buffer.alloc(9), metadata()), /byte count/);
  assert.throws(() => validateVisionRaw(words([0, 1024, 0, 0]), metadata()), /declared bitDepth/);
});

test('unpacked stride padding is not interpreted as pixels and sampled analysis and preview stay bounded', () => {
  const padded = Buffer.concat([words([1, 2]), Buffer.from([255, 255]), words([3, 4]), Buffer.from([255, 255])]);
  assert.deepEqual(analyzeVisionRaw(padded, metadata({ stride: 6 })).statistics.channelMeans, { R: 1, G: 2.5, B: 4 });
  const wide = metadata({ width: 1024, height: 1024, stride: 2048 });
  const data = Buffer.alloc(wide.stride * wide.height);
  const analysis = analyzeVisionRaw(data, wide);
  assert.ok(analysis.statistics.sampleCount <= 65_536);
  assert.equal(analysis.statistics.sampled, true);
  assert.ok(analysis.preview.width <= 320 && analysis.preview.height <= 240);
  assert.ok(analysis.previewPng.length < 320 * 240 * 4);
  // A bit depth violation outside the sampling grid must still be rejected.
  data.writeUInt16LE(4095, wide.stride * 17 + 18 * 2);
  assert.throws(() => validateVisionRaw(data, wide), /declared bitDepth/);
});
