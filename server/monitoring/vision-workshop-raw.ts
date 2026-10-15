/** Bounded Bayer decoding for workshop evidence. The preview is not ISP output. */
import { deflateSync } from 'node:zlib';

export type VisionRawMetadata = {
  scene: string; width: number; height: number; bitDepth: 8 | 10 | 12 | 14 | 16;
  bayer: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';
  packing: 'unpacked16le' | 'mipi-raw10' | 'mipi-raw12';
  stride: number; blackLevel: number; whiteLevel: number; exposureUs?: number; gain?: number;
};
export type VisionRawStatistics = {
  method: 'spatial_bayer_blocks'; pixelCount: number; sampleCount: number; sampled: boolean;
  meanNormalized: number; saturationRatio: number; blackLevelRatio: number;
  channelMeans: { R: number; G: number; B: number };
  channelMeansNormalized: { R: number; G: number; B: number }; min: number; max: number;
};
export type VisionRawAnalysis = {
  metadata: VisionRawMetadata; statistics: VisionRawStatistics; previewPng: Buffer;
  preview: { width: number; height: number; kind: 'raw-bayer-preview'; label: string }; warnings: string[];
};

export const VISION_RAW_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_SAMPLES = 65_536;
const fail = (detail: string): never => { throw new Error(`vision_raw_invalid: ${detail}`); };
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(label);
  return value;
}

export function validateVisionRawMetadata(input: unknown): VisionRawMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('metadata');
  const row = input as Record<string, unknown>;
  if (typeof row.scene !== 'string' || !row.scene.trim() || row.scene.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(row.scene)) return fail('scene');
  const width = integer(row.width, 2, 8192, 'width');
  const height = integer(row.height, 2, 8192, 'height');
  if (width % 2 || height % 2 || width * height > MAX_PIXELS) return fail('Bayer dimensions or pixel limit');
  if (![8, 10, 12, 14, 16].includes(row.bitDepth as number)) return fail('bitDepth');
  const bitDepth = row.bitDepth as VisionRawMetadata['bitDepth'];
  if (!['RGGB', 'BGGR', 'GRBG', 'GBRG'].includes(row.bayer as string)) return fail('bayer');
  if (!['unpacked16le', 'mipi-raw10', 'mipi-raw12'].includes(row.packing as string)) return fail('packing');
  const packing = row.packing as VisionRawMetadata['packing'];
  if (packing === 'mipi-raw10' && (bitDepth !== 10 || width % 4)) return fail('RAW10 requires 10 bits and width divisible by 4');
  if (packing === 'mipi-raw12' && bitDepth !== 12) return fail('RAW12 requires 12 bits');
  const rowBytes = packing === 'unpacked16le' ? width * 2 : packing === 'mipi-raw10' ? width / 4 * 5 : width / 2 * 3;
  const stride = integer(row.stride, rowBytes, rowBytes + 4096, 'stride');
  if (stride * height > VISION_RAW_MAX_BYTES) return fail('byte limit');
  const sensorMaximum = 2 ** bitDepth - 1;
  const blackLevel = integer(row.blackLevel, 0, sensorMaximum - 1, 'blackLevel');
  const whiteLevel = integer(row.whiteLevel, blackLevel + 1, sensorMaximum, 'whiteLevel');
  const result: VisionRawMetadata = { scene: row.scene.trim(), width, height, bitDepth,
    bayer: row.bayer as VisionRawMetadata['bayer'], packing, stride, blackLevel, whiteLevel };
  for (const [field, maximum] of [['exposureUs', 60_000_000], ['gain', 65_536]] as const) {
    if (row[field] !== undefined) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0 || row[field] > maximum) return fail(field);
      result[field] = row[field];
    }
  }
  return result;
}

/** The declared stride includes row padding; a file must contain exactly one frame. */
export function validateVisionRaw(data: Buffer, input: unknown): VisionRawMetadata {
  const metadata = validateVisionRawMetadata(input);
  if (!Buffer.isBuffer(data) || data.length !== metadata.stride * metadata.height || data.length > VISION_RAW_MAX_BYTES) return fail('byte count must equal stride × height');
  // Packed groups cannot exceed their declared bit depth. For unpacked words,
  // validate every pixel, including pixels omitted from the bounded statistics.
  if (metadata.packing === 'unpacked16le' && metadata.bitDepth < 16) {
    const maximum = 2 ** metadata.bitDepth - 1;
    for (let y = 0; y < metadata.height; y++) {
      const row = y * metadata.stride;
      for (let x = 0; x < metadata.width; x++) {
        const offset = row + x * 2;
        if ((data[offset]! | data[offset + 1]! << 8) > maximum) return fail('pixel exceeds declared bitDepth; check packing and alignment');
      }
    }
  }
  return metadata;
}

function readPixel(data: Buffer, metadata: VisionRawMetadata, x: number, y: number): number {
  const row = y * metadata.stride;
  if (metadata.packing === 'unpacked16le') return data[row + x * 2]! | data[row + x * 2 + 1]! << 8;
  if (metadata.packing === 'mipi-raw10') {
    const group = row + Math.floor(x / 4) * 5;
    return data[group + x % 4]! << 2 | data[group + 4]! >> ((x % 4) * 2) & 3;
  }
  const group = row + Math.floor(x / 2) * 3;
  return data[group + x % 2]! << 4 | data[group + 2]! >> ((x % 2) * 4) & 15;
}
const channelLayouts: Record<VisionRawMetadata['bayer'], Array<'R' | 'G' | 'B'>> = {
  RGGB: ['R', 'G', 'G', 'B'], BGGR: ['B', 'G', 'G', 'R'],
  GRBG: ['G', 'R', 'B', 'G'], GBRG: ['G', 'B', 'R', 'G'],
};
function position(index: number, count: number, total: number): number {
  return count === 1 ? Math.floor((total - 1) / 2) : Math.floor(index * (total - 1) / (count - 1));
}
function normalized(value: number, metadata: VisionRawMetadata): number {
  return Math.max(0, Math.min(1, (value - metadata.blackLevel) / (metadata.whiteLevel - metadata.blackLevel)));
}
function statistics(data: Buffer, metadata: VisionRawMetadata): VisionRawStatistics {
  const columns = metadata.width / 2; const rows = metadata.height / 2;
  const sampledColumns = Math.min(columns, Math.max(1, Math.floor(Math.sqrt(MAX_SAMPLES / 4 * columns / rows))));
  const sampledRows = Math.min(rows, Math.max(1, Math.floor(MAX_SAMPLES / 4 / sampledColumns)));
  const sums = { R: 0, G: 0, B: 0 }; const normalizedSums = { R: 0, G: 0, B: 0 }; const counts = { R: 0, G: 0, B: 0 };
  let sampleCount = 0; let sum = 0; let saturated = 0; let black = 0; let min = Infinity; let max = -Infinity;
  for (let cy = 0; cy < sampledRows; cy++) {
    const y = position(cy, sampledRows, rows) * 2;
    for (let cx = 0; cx < sampledColumns; cx++) {
      const x = position(cx, sampledColumns, columns) * 2;
      for (let index = 0; index < 4; index++) {
        const value = readPixel(data, metadata, x + index % 2, y + Math.floor(index / 2));
        const channel = channelLayouts[metadata.bayer][index]!;
        const linear = normalized(value, metadata);
        sums[channel] += value; normalizedSums[channel] += linear; counts[channel]++;
        sampleCount++; sum += linear;
        if (value >= metadata.whiteLevel) saturated++;
        if (value <= metadata.blackLevel) black++;
        min = Math.min(min, value); max = Math.max(max, value);
      }
    }
  }
  return { method: 'spatial_bayer_blocks', pixelCount: metadata.width * metadata.height, sampleCount,
    sampled: sampleCount < metadata.width * metadata.height, meanNormalized: sum / sampleCount,
    saturationRatio: saturated / sampleCount, blackLevelRatio: black / sampleCount,
    channelMeans: { R: sums.R / counts.R, G: sums.G / counts.G, B: sums.B / counts.B },
    channelMeansNormalized: { R: normalizedSums.R / counts.R, G: normalizedSums.G / counts.G, B: normalizedSums.B / counts.B }, min, max };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function pngChunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii'); let crc = 0xffffffff;
  for (const byte of name) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length, 0); name.copy(header, 4);
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, trailer]);
}
function preview(data: Buffer, metadata: VisionRawMetadata): { png: Buffer; width: number; height: number } {
  const sourceWidth = metadata.width / 2; const sourceHeight = metadata.height / 2;
  const scale = Math.min(1, 320 / sourceWidth, 240 / sourceHeight);
  const width = Math.max(1, Math.floor(sourceWidth * scale)); const height = Math.max(1, Math.floor(sourceHeight * scale));
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let py = 0; py < height; py++) {
    const y = position(py, height, sourceHeight) * 2;
    for (let px = 0; px < width; px++) {
      const x = position(px, width, sourceWidth) * 2; const values = { R: 0, G: 0, B: 0 };
      for (let index = 0; index < 4; index++) {
        values[channelLayouts[metadata.bayer][index]!] += normalized(readPixel(data, metadata, x + index % 2, y + Math.floor(index / 2)), metadata);
      }
      const offset = py * (1 + width * 3) + 1 + px * 3;
      scanlines[offset] = Math.round(values.R ** (1 / 2.2) * 255);
      scanlines[offset + 1] = Math.round((values.G / 2) ** (1 / 2.2) * 255);
      scanlines[offset + 2] = Math.round(values.B ** (1 / 2.2) * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return { width, height, png: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]) };
}

export function analyzeVisionRaw(data: Buffer, input: unknown): VisionRawAnalysis {
  const metadata = validateVisionRaw(data, input);
  const measured = statistics(data, metadata); const rendered = preview(data, metadata);
  const warnings = ['Raw Bayer 预览仅作查看：采用 2×2 色块、黑白电平归一化和显示 Gamma；未经 ISP，不代表调优后的输出。',
    '统计为 Raw 像素值；均值及阈值比例不能单独证明画质达标，饱和和黑电平比例以提供的 whiteLevel/blackLevel 为准。'];
  if (measured.sampled) warnings.push(`使用 ${measured.sampleCount} 个空间采样像素；局部缺陷、噪声和运动表现需另行验证。`);
  return { metadata, statistics: measured, previewPng: rendered.png,
    preview: { width: rendered.width, height: rendered.height, kind: 'raw-bayer-preview', label: 'Raw Bayer 预览（非 ISP 输出）' }, warnings };
}
