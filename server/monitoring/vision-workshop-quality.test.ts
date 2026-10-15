import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { analyzeVisionProcessedPng, compareVisionProcessedPng, VisionQualityError, type VisionQualityErrorCode } from './vision-workshop-quality.js';

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
function png(width: number, height: number, color: number, scanlines: Buffer, options: { depth?: number; interlace?: number; compressed?: Buffer; beforeData?: Buffer[]; afterData?: Buffer[] } = {}): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = options.depth ?? 8; header[9] = color; header[12] = options.interlace ?? 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...(options.beforeData || []), chunk('IDAT', options.compressed ?? deflateSync(scanlines)), ...(options.afterData || []), chunk('IEND', Buffer.alloc(0))]);
}
function gray(width: number, height: number, pixels: number[]): Buffer {
  assert.equal(pixels.length, width * height);
  const lines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) lines[y * (width + 1) + 1 + x] = pixels[y * width + x]!;
  return png(width, height, 0, lines);
}
const approx = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const fails = (code: VisionQualityErrorCode, status?: number) => (error: unknown) => error instanceof VisionQualityError && error.code === code && (status === undefined || error.status === status);

test('actual grayscale output uses normalized code values and fixed endpoint thresholds', () => {
  const result = analyzeVisionProcessedPng(gray(3, 2, [0, 1, 2, 253, 254, 255]));
  assert.equal(result.pixelCount, 6); assert.equal(result.sampledPixels, 6);
  approx(result.meanLuma, 0.5);
  approx(result.nearBlackRatio, 2 / 6); approx(result.nearWhiteRatio, 2 / 6);
  approx(result.channelMeans.r, 0.5); approx(result.channelMeans.g, 0.5); approx(result.channelMeans.b, 0.5);
  assert.ok(result.stdLuma > 0.49 && result.stdLuma < 0.5);
  assert.deepEqual(result.roi, { x: 0, y: 0, width: 3, height: 2 });
  assert.equal(result.method, 'png-output-statistics');
  assert.match(result.limitations.join(' '), /stdLuma.*不能当作噪声或 SNR/);
  assert.match(result.limitations.join(' '), /不代表 Sensor 饱和/);
});

test('RGB observations use the declared luma weights without pretending to be calibrated color', () => {
  const result = analyzeVisionProcessedPng(png(3, 1, 2, Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255])));
  approx(result.meanLuma, 1 / 3);
  approx(result.channelMeans.r, 1 / 3); approx(result.channelMeans.g, 1 / 3); approx(result.channelMeans.b, 1 / 3);
  assert.equal(result.nearBlackRatio, 0); assert.equal(result.nearWhiteRatio, 0);
  assert.match(result.limitations.join(' '), /未做线性化、ICC 或 Gamma 校正/);
});

test('all five PNG filters reconstruct the same known RGB pixel values', () => {
  // Five precomputed scanlines exercise None/Sub/Up/Average/Paeth. Each pixel's
  // G and B code values are respectively R+10 and R+20.
  const lines = Buffer.from([
    0, 10, 20, 30, 40, 50, 60,
    1, 20, 30, 40, 30, 30, 30,
    2, 10, 10, 10, 10, 10, 10,
    3, 25, 30, 35, 20, 20, 20,
    4, 10, 10, 10, 10, 10, 10,
  ]);
  const result = analyzeVisionProcessedPng(png(2, 5, 2, lines));
  approx(result.channelMeans.r, 45 / 255); approx(result.channelMeans.g, 55 / 255); approx(result.channelMeans.b, 65 / 255);
  approx(result.meanLuma, (2126 * 45 + 7152 * 55 + 722 * 65) / (10000 * 255));
  approx(result.stdLuma, Math.sqrt(425) / 255);
});

for (const [color, scanline] of [[4, [0, 0, 255, 255, 255]], [6, [0, 0, 0, 0, 255, 255, 255, 255, 255]]] as const) {
  test(`opaque PNG color type ${color} retains its actual color-code observations`, () => {
    const result = analyzeVisionProcessedPng(png(2, 1, color, Buffer.from(scanline)));
    approx(result.meanLuma, 0.5); approx(result.stdLuma, 0.5);
    assert.match(result.limitations.join(' '), /全图 Alpha 均为 255/);
  });
}

test('transparent and semitransparent color values cannot masquerade as visible output statistics', () => {
  const grayAlpha = png(2, 1, 4, Buffer.from([0, 0, 0, 255, 255]));
  const rgba = png(2, 1, 6, Buffer.from([0, 0, 0, 0, 127, 255, 255, 255, 255]));
  const transparentRed = png(2, 1, 2, Buffer.from([0, 255, 0, 0, 0, 255, 0]), { beforeData: [chunk('tRNS', Buffer.from([0, 255, 0, 0, 0, 0]))] });
  [grayAlpha, rgba, transparentRed].forEach(image => assert.throws(() => analyzeVisionProcessedPng(image), fails('vision_quality_unavailable', 415)));
  assert.throws(() => analyzeVisionProcessedPng(rgba, { x: 1, y: 0, width: 1, height: 1 }), fails('vision_quality_unavailable', 415), 'an opaque ROI must not hide transparency elsewhere in the output');
});

test('ROI statistics and candidate deltas describe the selected rectangle only', () => {
  const before = gray(4, 2, [0, 0, 200, 200, 0, 0, 200, 200]);
  const after = gray(4, 2, [10, 10, 210, 210, 10, 10, 210, 210]);
  const roi = { x: 2, y: 0, width: 2, height: 2 };
  const result = compareVisionProcessedPng(before, after, roi);
  assert.equal(result.method, 'png-output-comparison');
  assert.equal(result.baseline.pixelCount, 4); assert.equal(result.candidate.sampledPixels, 4);
  approx(result.baseline.meanLuma, 200 / 255); approx(result.candidate.meanLuma, 210 / 255);
  approx(result.delta.meanLuma, 10 / 255); approx(result.delta.channelMeans.r, 10 / 255);
  assert.equal(result.delta.stdLuma, 0); assert.equal(result.baseline.nearBlackRatio, 0);
  approx(analyzeVisionProcessedPng(before).meanLuma, 100 / 255);
  assert.equal(analyzeVisionProcessedPng(before).nearBlackRatio, 0.5);
  assert.match(result.limitations.join(' '), /不表示好坏或达标/);
  roi.x = 0;
  assert.equal(result.baseline.roi.x, 2, 'saved ROI must not alias the caller mutable input');
});

test('comparison rejects different full-frame dimensions even if the requested ROI fits both', () => {
  assert.throws(() => compareVisionProcessedPng(gray(2, 2, [0, 0, 0, 0]), gray(3, 2, [0, 0, 0, 0, 0, 0]), { x: 0, y: 0, width: 1, height: 1 }), fails('vision_quality_dimension_mismatch', 409));
});

test('ROI must be a bounded, nonempty integer rectangle', () => {
  const image = gray(2, 2, [0, 1, 2, 3]);
  for (const roi of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 1, y: 0, width: 2, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Number.NaN, height: 1 }]) assert.throws(() => analyzeVisionProcessedPng(image, roi), fails('vision_quality_invalid_roi', 400));
});

test('large output remains bounded at 65,536 observed pixels with an explicit sampling limitation', () => {
  const size = 512; const lines = Buffer.alloc((size + 1) * size, 128);
  for (let y = 0; y < size; y++) lines[y * (size + 1)] = 0;
  const result = analyzeVisionProcessedPng(png(size, size, 0, lines));
  assert.equal(result.pixelCount, 262144); assert.equal(result.sampledPixels, 65536);
  approx(result.meanLuma, 128 / 255); assert.equal(result.stdLuma, 0);
  assert.match(result.limitations.join(' '), /可能遗漏局部细节/);
});

test('JPEG, indexed-color, 16-bit and interlaced inputs explicitly report unsupported statistics', () => {
  const inputs = [
    Buffer.from([255, 216, 255, 217]),
    png(2, 1, 3, Buffer.from([0, 0, 1]), { beforeData: [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))] }),
    png(1, 1, 0, Buffer.from([0, 0, 0]), { depth: 16 }),
    png(1, 1, 0, Buffer.from([0, 0]), { interlace: 1 }),
  ];
  inputs.forEach(image => assert.throws(() => analyzeVisionProcessedPng(image), fails('vision_quality_unavailable', 415)));
});

test('CRC errors, truncated chunks, invalid filters and incorrect scanline lengths cannot produce metrics', () => {
  const valid = gray(2, 1, [1, 2]); const badCrc = Buffer.from(valid); badCrc[16] ^= 1;
  const cases = [badCrc, valid.subarray(0, valid.length - 1), png(2, 1, 0, Buffer.from([5, 1, 2])), png(2, 1, 0, Buffer.from([0, 1])), Buffer.concat([valid, Buffer.from([0])])];
  cases.forEach(image => assert.throws(() => analyzeVisionProcessedPng(image), fails('vision_quality_invalid_png', 400)));
});

test('compressed trailing data and a compressed pixel bomb are rejected inside the declared decode budget', () => {
  const stream = deflateSync(Buffer.from([0, 1, 2]));
  const trailing = png(2, 1, 0, Buffer.alloc(0), { compressed: Buffer.concat([stream, Buffer.from('trailing')]) });
  const bomb = png(2, 1, 0, Buffer.alloc(0), { compressed: deflateSync(Buffer.alloc(1024 * 1024)) });
  [trailing, bomb].forEach(image => assert.throws(() => analyzeVisionProcessedPng(image), fails('vision_quality_invalid_png', 400)));
});

test('PNG dimensions cannot bypass the decoded-pixel memory budget by declaring a small compressed stream', () => {
  const tooLarge = png(8192, 3000, 2, Buffer.from([0]));
  assert.throws(() => analyzeVisionProcessedPng(tooLarge), fails('vision_quality_limit_exceeded', 413));
  assert.throws(() => analyzeVisionProcessedPng(png(8193, 1, 0, Buffer.from([0]))), fails('vision_quality_limit_exceeded', 413));
});

test('PNG IDAT must remain consecutive and unsupported animation does not silently become a still-image score', () => {
  const split = png(2, 1, 0, Buffer.from([0, 1, 2]), { afterData: [chunk('tEXt', Buffer.from('key\0value')), chunk('IDAT', Buffer.alloc(0))] });
  assert.throws(() => analyzeVisionProcessedPng(split), fails('vision_quality_invalid_png', 400));
  const animation = png(2, 1, 0, Buffer.from([0, 1, 2]), { beforeData: [chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]))] });
  assert.throws(() => analyzeVisionProcessedPng(animation), fails('vision_quality_unavailable', 415));
});
