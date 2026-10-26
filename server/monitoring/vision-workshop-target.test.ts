import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { analyzeVisionTargetChart, buildVisionTargetChartPng, deltaE76, srgbToLab, VISION_TARGET_COLUMNS, VISION_TARGET_PATCHES, VisionQualityError } from './vision-workshop-quality.js';

function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
function rgbPng(width: number, height: number, rows: Buffer): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
/** 与 buildVisionTargetChartPng 同布局，但允许对每个色块做通道变换，用于构造受控偏差。 */
function chartPng(transform: (r: number, g: number, b: number) => [number, number, number]): Buffer {
  const cell = 40; const width = VISION_TARGET_COLUMNS * cell; const height = 2 * cell;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3); rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const patch = VISION_TARGET_PATCHES[Math.floor(y / cell) * VISION_TARGET_COLUMNS + Math.floor(x / cell)]!;
      const [r, g, b] = transform(patch.reference.r, patch.reference.g, patch.reference.b);
      const position = row + 1 + x * 3;
      rows[position] = r; rows[position + 1] = g; rows[position + 2] = b;
    }
  }
  return rgbPng(width, height, rows);
}

test('sRGB to Lab conversions match published D65 reference values and ΔE76 is the Lab distance', () => {
  const white = srgbToLab(255, 255, 255);
  assert.ok(Math.abs(white.L - 100) < 0.02 && Math.abs(white.a) < 0.02 && Math.abs(white.b) < 0.02);
  const red = srgbToLab(255, 0, 0);
  assert.ok(Math.abs(red.L - 53.24) < 0.05 && Math.abs(red.a - 80.09) < 0.05 && Math.abs(red.b - 67.20) < 0.05);
  assert.ok(Math.abs(deltaE76(white, red) - Math.sqrt((100 - 53.24) ** 2 + 80.09 ** 2 + 67.20 ** 2)) < 0.01);
});

test('exact reference chart roundtrips with near-zero error on every patch and summary', () => {
  const analysis = analyzeVisionTargetChart(buildVisionTargetChartPng());
  assert.equal(analysis.patches.length, 24); assert.equal(analysis.method, 'target-chart-v1');
  for (const patch of analysis.patches) assert.ok(patch.deltaE < 0.01, patch.name + ' deltaE ' + patch.deltaE);
  assert.ok(analysis.meanDeltaE < 0.01 && analysis.maxDeltaE < 0.01);
  assert.ok(analysis.grayMaxLumaDelta < 0.01);
  assert.ok(Math.abs(analysis.whiteBalanceOffset.aStar) < 0.01 && Math.abs(analysis.whiteBalanceOffset.bStar) < 0.01);
  assert.ok(analysis.sampledPixels > 0);
  assert.match(analysis.limitations.join(' '), /未经光谱校准/);
  assert.match(analysis.limitations.join(' '), /不构成画质总分/);
});

test('a single drifted patch surfaces as a targeted delta while every other patch stays exact', () => {
  const dimmed = analyzeVisionTargetChart(chartPng((r, g, b) => r === 255 && g === 0 && b === 0 ? [204, 0, 0] : [r, g, b]));
  const red = dimmed.patches.find(patch => patch.name === '纯红')!;
  const plantGreen = dimmed.patches.find(patch => patch.name === '植物绿')!;
  assert.ok(red.deltaE > 5, '纯红 deltaE ' + red.deltaE);
  assert.ok(red.deltaE > plantGreen.deltaE);
  assert.ok(plantGreen.deltaE < 0.01, '未受扰色块应保持精确');
  assert.equal(dimmed.grayMaxLumaDelta, 0, 'gray row is untouched by the single-patch drift');
  assert.ok(Math.abs(dimmed.whiteBalanceOffset.aStar) < 0.01 && Math.abs(dimmed.whiteBalanceOffset.bStar) < 0.01);
  assert.ok(dimmed.maxDeltaE > dimmed.meanDeltaE);
});

test('undersized images and broken PNG fail with explicit errors instead of fabricated scores', () => {
  assert.throws(() => analyzeVisionTargetChart(rgbPng(120, 40, Buffer.alloc((1 + 120 * 3) * 40))), (error: unknown) => error instanceof VisionQualityError && error.code === 'vision_quality_invalid_png');
  assert.throws(() => analyzeVisionTargetChart(Buffer.from([255, 216, 255, 217])), (error: unknown) => error instanceof VisionQualityError && error.code === 'vision_quality_unavailable');
});
