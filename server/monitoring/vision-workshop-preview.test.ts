import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { analyzeVisionProcessedPng, prepareVisionModelPng } from './vision-workshop-quality.js';
import { visionCrc32 } from './vision-workshop-export.js';

function png(width: number, height: number, channels: 3 | 4, pixel: (index: number, channel: number) => number) {
  const chunk = (kind: string, bytes: Buffer) => {
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(bytes.length); prefix.write(kind, 4);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE(visionCrc32(Buffer.concat([Buffer.from(kind), bytes])));
    return Buffer.concat([prefix, bytes, suffix]);
  };
  const rows = Buffer.alloc((1 + width * channels) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) rows[y * (1 + width * channels) + 1 + x * channels + c] = pixel(y * width + x, c);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('viewing derivative preserves small RGB codes, aspect and immutable source binding', () => {
  const source = png(4, 2, 3, (index, channel) => (index * 20 + channel * 10) % 256); const before = Buffer.from(source);
  const result = prepareVisionModelPng(source);
  assert.deepEqual(source, before);
  assert.equal(result.sourceSha256, hash(source)); assert.equal(result.sha256, hash(result.data));
  assert.equal(result.width, 4); assert.equal(result.height, 2); assert.equal(result.sourceWidth, 4); assert.equal(result.sourceHeight, 2);
  assert.deepEqual(analyzeVisionProcessedPng(result.data).channelMeans, analyzeVisionProcessedPng(source).channelMeans);
});

test('high entropy full resolution input fits the actual model budget without changing the archived bytes', () => {
  let state = 123456789;
  const source = png(1920, 1080, 3, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; });
  const originalHash = hash(source); assert.ok(source.length > 1024 * 1024);
  const result = prepareVisionModelPng(source);
  assert.ok(result.data.length <= 1024 * 1024); assert.ok(result.width <= 1280 && result.height <= 720);
  assert.equal(result.width / result.height, 16 / 9); assert.equal(result.sourceSha256, originalHash); assert.equal(hash(source), originalHash);
  assert.equal(analyzeVisionProcessedPng(result.data).pixelCount, result.width * result.height);
  assert.equal(result.method, 'area-average-png-preview'); assert.notEqual(result.sha256, result.sourceSha256);
});

test('corrupt or transparent images cannot become trusted model derivatives', () => {
  const transparent = png(1, 1, 4, (_index, channel) => channel === 3 ? 127 : 255);
  assert.throws(() => prepareVisionModelPng(transparent), /vision_quality_unavailable/);
  const corrupt = png(1, 1, 3, () => 50); corrupt[16] ^= 1;
  assert.throws(() => prepareVisionModelPng(corrupt), /vision_quality_invalid_png/);
});
