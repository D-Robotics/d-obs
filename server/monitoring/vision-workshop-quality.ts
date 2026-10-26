/** Objective observations of saved ISP output bytes; these are not image-quality scores. */
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export interface VisionOutputRoi { x: number; y: number; width: number; height: number }
export interface VisionOutputStatistics {
  pixelCount: number;
  sampledPixels: number;
  meanLuma: number;
  stdLuma: number;
  nearBlackRatio: number;
  nearWhiteRatio: number;
  channelMeans: { r: number; g: number; b: number };
  lumaHistogram: number[];
  channelHistograms: { r: number[]; g: number[]; b: number[] };
  roi: VisionOutputRoi;
  method: 'png-output-statistics';
  limitations: string[];
}
export interface VisionOutputDelta {
  meanLuma: number; stdLuma: number; nearBlackRatio: number; nearWhiteRatio: number;
  channelMeans: { r: number; g: number; b: number };
}
export interface VisionOutputComparison {
  baseline: VisionOutputStatistics; candidate: VisionOutputStatistics;
  delta: VisionOutputDelta; method: 'png-output-comparison'; limitations: string[];
}
export type VisionQualityErrorCode = 'vision_quality_invalid_png' | 'vision_quality_unavailable' | 'vision_quality_invalid_roi' | 'vision_quality_dimension_mismatch' | 'vision_quality_limit_exceeded';
export class VisionQualityError extends Error {
  constructor(public readonly code: VisionQualityErrorCode, public readonly reason: string, public readonly status: number) {
    super(code); this.name = 'VisionQualityError';
  }
}

const MAX_ENCODED_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_SAMPLES = 65_536;
const HISTOGRAM_BINS = 32;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const INVALID = (reason: string): never => { throw new VisionQualityError('vision_quality_invalid_png', reason, 400); };
const UNAVAILABLE = (reason: string): never => { throw new VisionQualityError('vision_quality_unavailable', reason, 415); };
const LIMIT = (reason: string): never => { throw new VisionQualityError('vision_quality_limit_exceeded', reason, 413); };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
interface ParsedPng { width: number; height: number; channels: number; alpha: boolean; transparentColor?: number[]; compressed: Buffer[]; decodedBytes: number }

/** Parse and CRC-check every chunk before selecting the supported decoder. */
function parsePng(data: Buffer): ParsedPng {
  if (!Buffer.isBuffer(data)) return INVALID('PNG input must be a Buffer');
  if (data.length > MAX_ENCODED_BYTES) return LIMIT('PNG encoded input exceeds 64 MiB');
  if (data[0] === 0xff && data[1] === 0xd8) return UNAVAILABLE('JPEG objective statistics are unavailable; use an actual PNG output');
  if (data.length < 45 || !data.subarray(0, 8).equals(SIGNATURE)) return INVALID('PNG signature or content is incomplete');
  let offset = 8; let chunks = 0;
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | undefined;
  let paletteEntries = 0; let transparency = false; let transparentColor: number[] | undefined; let hasData = false; let dataEnded = false; let ended = false;
  let animation = false;
  const compressed: Buffer[] = [];
  while (offset < data.length) {
    if (++chunks > 20_000) return LIMIT('PNG chunk count exceeds 20,000');
    if (data.length - offset < 12) return INVALID('PNG chunk is truncated');
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) return INVALID('PNG chunk payload is truncated');
    const end = offset + 12 + length;
    const kindBytes = data.subarray(offset + 4, offset + 8);
    if (kindBytes.some(byte => !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)))) return INVALID('PNG chunk type must contain ASCII letters');
    const kind = kindBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(kind) || (kind.charCodeAt(2) & 32)) return INVALID('PNG chunk type or reserved bit is invalid');
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return INVALID('PNG chunk CRC does not match');
    if (!header && kind !== 'IHDR') return INVALID('PNG IHDR must be the first chunk');
    if (kind === 'IHDR') {
      if (header || offset !== 8 || length !== 13) return INVALID('PNG IHDR is duplicated or malformed');
      const width = data.readUInt32BE(offset + 8); const height = data.readUInt32BE(offset + 12);
      const depth = data[offset + 16]!; const color = data[offset + 17]!; const interlace = data[offset + 20]!;
      const legalDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || !legalDepths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || ![0, 1].includes(interlace)) return INVALID('PNG dimensions or pixel format are invalid');
      if (width > 8192 || height > 8192) return LIMIT('PNG dimensions exceed 8192 pixels');
      header = { width, height, depth, color, interlace };
    } else if (kind === 'PLTE') {
      if (paletteEntries || hasData || !length || length % 3 || length > 768 || [0, 4].includes(header!.color)) return INVALID('PNG palette is invalid or out of order');
      paletteEntries = length / 3;
      if (header!.color === 3 && paletteEntries > 2 ** header!.depth) return INVALID('PNG palette exceeds the index bit depth');
    } else if (kind === 'tRNS') {
      const color = header!.color;
      if (transparency || hasData || [4, 6].includes(color) || (color === 0 && length !== 2) || (color === 2 && length !== 6) || (color === 3 && (!paletteEntries || !length || length > paletteEntries))) return INVALID('PNG transparency is invalid or out of order');
      transparency = true;
      if (color === 0 || color === 2) {
        transparentColor = Array.from({ length: color === 0 ? 1 : 3 }, (_, index) => data.readUInt16BE(offset + 8 + index * 2));
        if (transparentColor.some(value => value >= 2 ** header!.depth)) return INVALID('PNG transparent color exceeds the declared bit depth');
      }
    } else if (kind === 'IDAT') {
      if (dataEnded || (header!.color === 3 && !paletteEntries)) return INVALID('PNG IDAT is nonconsecutive or missing its palette');
      hasData = true; compressed.push(data.subarray(offset + 8, end - 4));
    } else if (kind === 'IEND') {
      if (!hasData || length !== 0 || end !== data.length) return INVALID('PNG IEND or trailing content is invalid');
      ended = true; break;
    } else {
      if (kind[0] === kind[0]!.toUpperCase()) return UNAVAILABLE('PNG contains an unsupported critical chunk');
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) animation = true;
    }
    if (hasData && kind !== 'IDAT') dataEnded = true;
    offset = end;
  }
  if (!header || !hasData || !ended) return INVALID('PNG data or end chunk is missing');
  if (animation) return UNAVAILABLE('Animated PNG is not supported for paired ISP-output statistics');
  if (header.color === 3) return UNAVAILABLE('Indexed-color PNG objective statistics are unavailable; use 8-bit RGB or grayscale PNG');
  if (header.depth !== 8 || header.interlace !== 0) return UNAVAILABLE('Only noninterlaced 8-bit grayscale, RGB, grayscale-alpha or RGBA PNG is supported');
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[header.color]!;
  const decodedBytes = (1 + header.width * channels) * header.height;
  if (decodedBytes > MAX_DECODED_BYTES) return LIMIT('PNG decoded scanlines exceed 64 MiB');
  return { width: header.width, height: header.height, channels, alpha: [4, 6].includes(header.color), ...(transparentColor ? { transparentColor } : {}), compressed, decodedBytes };
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left); const aboveDistance = Math.abs(prediction - above); const cornerDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= cornerDistance ? left : aboveDistance <= cornerDistance ? above : upperLeft;
}
/** Reverse filtering in place, retaining scanline filter bytes to avoid a second decoded image. */
function decodePixels(png: ParsedPng): Buffer {
  const compressed = Buffer.concat(png.compressed);
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    inflated = inflateSync(compressed, { maxOutputLength: png.decodedBytes, info: true }) as unknown as typeof inflated;
  } catch { return INVALID('PNG compressed pixels are invalid or exceed the declared scanlines'); }
  if (inflated.engine.bytesWritten !== compressed.length || inflated.buffer.length !== png.decodedBytes) return INVALID('PNG compressed stream has trailing bytes or an incorrect decoded length');
  const pixels = inflated.buffer; const rowBytes = png.width * png.channels; const stride = rowBytes + 1;
  for (let y = 0; y < png.height; y++) {
    const row = y * stride; const filter = pixels[row]!;
    if (filter > 4) return INVALID('PNG scanline filter must be 0–4');
    for (let index = 0; index < rowBytes; index++) {
      const position = row + 1 + index;
      const left = index >= png.channels ? pixels[position - png.channels]! : 0;
      const above = y ? pixels[position - stride]! : 0;
      const upperLeft = y && index >= png.channels ? pixels[position - stride - png.channels]! : 0;
      const prediction = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      pixels[position] = (pixels[position]! + prediction) & 255;
    }
    // Check the complete image, including pixels outside the requested ROI.
    if (png.alpha || png.transparentColor) for (let x = 0; x < png.width; x++) {
      const position = row + 1 + x * png.channels;
      if (png.alpha && pixels[position + png.channels - 1] !== 255) return UNAVAILABLE('PNG contains transparent or semitransparent pixels; objective output statistics require an opaque image');
      if (png.transparentColor && png.transparentColor.every((value, channel) => pixels[position + channel] === value)) return UNAVAILABLE('PNG transparent-color pixels cannot be used as visible ISP-output observations');
    }
  }
  return pixels;
}
function normalizeRoi(png: ParsedPng, input?: VisionOutputRoi): VisionOutputRoi {
  if (input === undefined) return { x: 0, y: 0, width: png.width, height: png.height };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['x', 'y', 'width', 'height'].includes(key)) || ![input.x, input.y, input.width, input.height].every(value => typeof value === 'number' && Number.isSafeInteger(value)) || input.x < 0 || input.y < 0 || input.width < 1 || input.height < 1 || input.x + input.width > png.width || input.y + input.height > png.height) {
    throw new VisionQualityError('vision_quality_invalid_roi', 'ROI must be an integer rectangle within the output image', 400);
  }
  return { x: input.x, y: input.y, width: input.width, height: input.height };
}
const OBSERVATION_LIMITS = [
  '亮度由 8-bit 输出颜色码值按固定权重计算，未做线性化、ICC 或 Gamma 校正。',
  'stdLuma 表示 ROI 内亮度变化，不能当作噪声或 SNR；这些统计不是画质总分。',
  'nearBlackRatio 与 nearWhiteRatio 分别使用输出亮度 ≤1/255、≥254/255，不代表 Sensor 饱和或黑电平状态。',
  '未进行标定，不能给出校准 SNR、MTF 或色差；仍需结合人工评价和真实场景验证。',
  '直方图为采样像素的码值占比分布，未做线性化或校准，不构成色度测量或画质总分。',
];
function statistics(png: ParsedPng, roi: VisionOutputRoi): VisionOutputStatistics {
  const pixels = decodePixels(png);
  const pixelCount = roi.width * roi.height; const sampledPixels = Math.min(pixelCount, MAX_SAMPLES);
  const stride = 1 + png.width * png.channels;
  let rSum = 0; let gSum = 0; let bSum = 0; let mean = 0; let sumSquares = 0; let nearBlack = 0; let nearWhite = 0;
  const lumaBins = new Array<number>(HISTOGRAM_BINS).fill(0);
  const rBins = new Array<number>(HISTOGRAM_BINS).fill(0); const gBins = new Array<number>(HISTOGRAM_BINS).fill(0); const bBins = new Array<number>(HISTOGRAM_BINS).fill(0);
  for (let index = 0; index < sampledPixels; index++) {
    // Equal intervals span the complete ROI; small ROIs inspect every pixel.
    const pixel = pixelCount <= MAX_SAMPLES ? index : Math.floor((index + 0.5) * pixelCount / sampledPixels);
    const x = roi.x + pixel % roi.width; const y = roi.y + Math.floor(pixel / roi.width);
    const position = y * stride + 1 + x * png.channels;
    const r = pixels[position]!;
    const g = png.channels < 3 ? r : pixels[position + 1]!;
    const b = png.channels < 3 ? r : pixels[position + 2]!;
    // BT.709 weights applied to encoded output values, not calibrated radiance.
    const luma = (2126 * r + 7152 * g + 722 * b) / (10000 * 255);
    const difference = luma - mean; mean += difference / (index + 1); sumSquares += difference * (luma - mean);
    rSum += r; gSum += g; bSum += b;
    if (luma <= 1 / 255) nearBlack++;
    if (luma >= 254 / 255) nearWhite++;
    lumaBins[Math.min(HISTOGRAM_BINS - 1, Math.floor(luma * HISTOGRAM_BINS))]!++;
    rBins[Math.min(HISTOGRAM_BINS - 1, (r * HISTOGRAM_BINS) >> 8)]!++;
    gBins[Math.min(HISTOGRAM_BINS - 1, (g * HISTOGRAM_BINS) >> 8)]!++;
    bBins[Math.min(HISTOGRAM_BINS - 1, (b * HISTOGRAM_BINS) >> 8)]!++;
  }
  const limitations = [...OBSERVATION_LIMITS];
  if (png.alpha) limitations.push('输出含 Alpha 通道；仅在全图 Alpha 均为 255 时统计，不进行背景合成。');
  if (sampledPixels < pixelCount) limitations.push('大 ROI 使用最多 65,536 个等间距像素采样，可能遗漏局部细节或周期性结构。');
  const share = (bins: number[]) => bins.map(count => count / sampledPixels);
  return {
    pixelCount, sampledPixels, meanLuma: mean, stdLuma: Math.sqrt(Math.max(0, sumSquares / sampledPixels)),
    nearBlackRatio: nearBlack / sampledPixels, nearWhiteRatio: nearWhite / sampledPixels,
    channelMeans: { r: rSum / sampledPixels / 255, g: gSum / sampledPixels / 255, b: bSum / sampledPixels / 255 },
    lumaHistogram: share(lumaBins), channelHistograms: { r: share(rBins), g: share(gBins), b: share(bBins) },
    roi: { ...roi }, method: 'png-output-statistics', limitations,
  };
}

/** All means and population standard deviation use normalized [0,1] output code values. */
export function analyzeVisionProcessedPng(data: Buffer, roi?: VisionOutputRoi): VisionOutputStatistics {
  const png = parsePng(data);
  return statistics(png, normalizeRoi(png, roi));
}

/** A bounded viewing derivative; the archived sensor/ISP output remains unchanged. */
export function prepareVisionModelPng(source: Buffer): { data: Buffer; width: number; height: number; sourceWidth: number; sourceHeight: number; sourceSha256: string; sha256: string; method: 'area-average-png-preview' } {
  const png = parsePng(source); const pixels = decodePixels(png);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const scale = Math.min(1, 1280 / png.width, 720 / png.height);
  let width = Math.max(1, Math.floor(png.width * scale)); let height = Math.max(1, Math.floor(png.height * scale));
  const chunk = (kind: string, payload: Buffer): Buffer => {
    const type = Buffer.from(kind); const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, payload])));
    return Buffer.concat([size, type, payload, crc]);
  };
  for (;;) {
    const rows = Buffer.alloc((1 + width * 3) * height); const stride = 1 + png.width * png.channels;
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * png.height / height); const y1 = Math.floor((y + 1) * png.height / height);
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * png.width / width); const x1 = Math.floor((x + 1) * png.width / width);
        let red = 0; let green = 0; let blue = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
          const position = sy * stride + 1 + sx * png.channels; const value = pixels[position]!;
          red += value; green += png.channels < 3 ? value : pixels[position + 1]!; blue += png.channels < 3 ? value : pixels[position + 2]!;
        }
        const count = (x1 - x0) * (y1 - y0); const position = y * (1 + width * 3) + 1 + x * 3;
        rows[position] = Math.round(red / count); rows[position + 1] = Math.round(green / count); rows[position + 2] = Math.round(blue / count);
      }
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const data = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    if (data.length <= 1024 * 1024) return { data, width, height, sourceWidth: png.width, sourceHeight: png.height, sourceSha256, sha256: createHash('sha256').update(data).digest('hex'), method: 'area-average-png-preview' };
    if (width === 1 && height === 1) return LIMIT('Model preview cannot fit its image budget');
    width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
  }
}

/** Candidate-minus-baseline observations; matching dimensions do not imply matching capture evidence. */
export function compareVisionProcessedPng(before: Buffer, after: Buffer, roi?: VisionOutputRoi): VisionOutputComparison {
  if (Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.length + after.length > MAX_ENCODED_BYTES) return LIMIT('Paired PNG encoded input exceeds 64 MiB');
  const beforePng = parsePng(before); const afterPng = parsePng(after);
  if (beforePng.width !== afterPng.width || beforePng.height !== afterPng.height) throw new VisionQualityError('vision_quality_dimension_mismatch', 'Paired ISP outputs must have the same dimensions', 409);
  const rectangle = normalizeRoi(beforePng, roi);
  const baseline = statistics(beforePng, rectangle); const candidate = statistics(afterPng, rectangle);
  const delta: VisionOutputDelta = {
    meanLuma: candidate.meanLuma - baseline.meanLuma, stdLuma: candidate.stdLuma - baseline.stdLuma,
    nearBlackRatio: candidate.nearBlackRatio - baseline.nearBlackRatio, nearWhiteRatio: candidate.nearWhiteRatio - baseline.nearWhiteRatio,
    channelMeans: { r: candidate.channelMeans.r - baseline.channelMeans.r, g: candidate.channelMeans.g - baseline.channelMeans.g, b: candidate.channelMeans.b - baseline.channelMeans.b },
  };
  return { baseline, candidate, delta, method: 'png-output-comparison', limitations: [
    ...new Set([...baseline.limitations, ...candidate.limitations]),
    'delta 为候选减基线，不表示好坏或达标；对比需同一 Raw、匹配 SDK 与可追溯的基础配置。',
  ] };
}

/** d-obs 目标卡 v1：参考值由本模块定义并可追溯，屏显或打印后拍摄评估；非 ColorChecker 复刻。 */
export interface VisionTargetPatch { name: string; kind: 'gray' | 'color'; reference: { r: number; g: number; b: number } }
export const VISION_TARGET_COLUMNS = 12;
export const VISION_TARGET_ROWS = 2;
const VISION_TARGET_GRAY_STEPS = [0, 23, 46, 70, 93, 116, 139, 162, 186, 209, 232, 255];
const VISION_TARGET_COLORS: Array<[string, number, number, number]> = [
  ['纯红', 255, 0, 0], ['纯绿', 0, 255, 0], ['纯蓝', 0, 0, 255], ['青', 0, 255, 255],
  ['品红', 255, 0, 255], ['黄', 255, 255, 0], ['橙', 255, 128, 0], ['紫', 128, 0, 255],
  ['肤色近似', 166, 124, 91], ['植物绿', 94, 132, 89], ['深蓝', 60, 90, 160], ['暖白', 245, 242, 235],
];
export const VISION_TARGET_PATCHES: VisionTargetPatch[] = [
  ...VISION_TARGET_GRAY_STEPS.map((value, index) => ({ name: '灰阶' + String(index + 1).padStart(2, '0'), kind: 'gray' as const, reference: { r: value, g: value, b: value } })),
  ...VISION_TARGET_COLORS.map(([name, r, g, b]) => ({ name, kind: 'color' as const, reference: { r, g, b } })),
];

const srgbLinear = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
/** sRGB(D65) → CIE L*a*b*；未做色适应变换，参考与实测同空间直接比较。 */
export function srgbToLab(red: number, green: number, blue: number): { L: number; a: number; b: number } {
  const rl = srgbLinear(red), gl = srgbLinear(green), bl = srgbLinear(blue);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x), fy = f(y), fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
export function deltaE76(first: { L: number; a: number; b: number }, second: { L: number; a: number; b: number }): number {
  return Math.sqrt((first.L - second.L) ** 2 + (first.a - second.a) ** 2 + (first.b - second.b) ** 2);
}

function encodePng(width: number, height: number, rgbRows: Buffer): Buffer {
  const chunk = (kind: string, payload: Buffer): Buffer => {
    const type = Buffer.from(kind); const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, payload])));
    return Buffer.concat([size, type, payload, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rgbRows)), chunk('IEND', Buffer.alloc(0))]);
}

/** 无文字目标卡资产：纯色块栅格，参考值即像素值，供屏显或打印后拍摄。 */
export function buildVisionTargetChartPng(): Buffer {
  const cell = 130; const width = VISION_TARGET_COLUMNS * cell; const height = VISION_TARGET_ROWS * cell;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3); rows[row] = 0;
    const gridRow = Math.floor(y / cell);
    for (let x = 0; x < width; x++) {
      const patch = VISION_TARGET_PATCHES[gridRow * VISION_TARGET_COLUMNS + Math.floor(x / cell)]!;
      const position = row + 1 + x * 3;
      rows[position] = patch.reference.r; rows[position + 1] = patch.reference.g; rows[position + 2] = patch.reference.b;
    }
  }
  return encodePng(width, height, rows);
}

export interface VisionTargetPatchObservation { name: string; kind: 'gray' | 'color'; reference: { r: number; g: number; b: number }; observed: { r: number; g: number; b: number }; deltaE: number }
export interface VisionTargetAnalysis {
  patches: VisionTargetPatchObservation[];
  meanDeltaE: number; maxDeltaE: number;
  grayMaxLumaDelta: number;
  whiteBalanceOffset: { aStar: number; bStar: number };
  sampledPixels: number;
  method: 'target-chart-v1';
  limitations: string[];
}

/** 目标卡客观评估：假定卡片满幅、正对、无畸变（构图要求见协议文档）；输出为与参考 sRGB 的 Lab 距离，非画质总分。 */
export function analyzeVisionTargetChart(data: Buffer): VisionTargetAnalysis {
  const png = parsePng(data);
  if (png.width < 240 || png.height < 80) return INVALID('目标卡分析需要至少 240×80 的图像');
  const pixels = decodePixels(png);
  const stride = 1 + png.width * png.channels;
  const cellW = png.width / VISION_TARGET_COLUMNS; const cellH = png.height / VISION_TARGET_ROWS;
  const patches: VisionTargetPatchObservation[] = [];
  let sampledPixels = 0; let grayASum = 0; let grayBSum = 0; let grayCount = 0; let grayMaxLumaDelta = 0;
  let colorDeltaESum = 0; let colorDeltaEMax = 0; let colorCount = 0;
  VISION_TARGET_PATCHES.forEach((patch, index) => {
    const gridRow = Math.floor(index / VISION_TARGET_COLUMNS); const column = index % VISION_TARGET_COLUMNS;
    const halfW = cellW * 0.2; const halfH = cellH * 0.2;
    const x0 = Math.max(0, Math.round((column + 0.5) * cellW - halfW)); const x1 = Math.min(png.width, Math.round((column + 0.5) * cellW + halfW));
    const y0 = Math.max(0, Math.round((gridRow + 0.5) * cellH - halfH)); const y1 = Math.min(png.height, Math.round((gridRow + 0.5) * cellH + halfH));
    const total = (x1 - x0) * (y1 - y0); const step = Math.max(1, Math.floor(Math.sqrt(total / 2048)));
    let rSum = 0; let gSum = 0; let bSum = 0; let count = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const position = y * stride + 1 + x * png.channels;
      const red = pixels[position]!; const green = png.channels < 3 ? red : pixels[position + 1]!; const blue = png.channels < 3 ? red : pixels[position + 2]!;
      rSum += red; gSum += green; bSum += blue; count++;
    }
    sampledPixels += count;
    const observed = { r: rSum / count, g: gSum / count, b: bSum / count };
    const observedLab = srgbToLab(observed.r, observed.g, observed.b);
    const referenceLab = srgbToLab(patch.reference.r, patch.reference.g, patch.reference.b);
    const deltaE = deltaE76(observedLab, referenceLab);
    if (patch.kind === 'gray') { grayASum += observedLab.a; grayBSum += observedLab.b; grayCount++; grayMaxLumaDelta = Math.max(grayMaxLumaDelta, Math.abs(observedLab.L - referenceLab.L)); }
    else { colorDeltaESum += deltaE; colorCount++; colorDeltaEMax = Math.max(colorDeltaEMax, deltaE); }
    patches.push({ name: patch.name, kind: patch.kind, reference: { ...patch.reference }, observed, deltaE });
  });
  return {
    patches,
    meanDeltaE: colorDeltaESum / colorCount, maxDeltaE: colorDeltaEMax,
    grayMaxLumaDelta, whiteBalanceOffset: { aStar: grayASum / grayCount, bStar: grayBSum / grayCount },
    sampledPixels, method: 'target-chart-v1',
    limitations: [
      '参考值为模块定义的 sRGB 数值；屏显或打印介质未经光谱校准，ΔE 含显示与拍摄路径的全部偏差。',
      '采样假定目标卡满幅、正对且无畸变；未做自动定位，构图偏差会直接进入误差。',
      'ΔE76 为 Lab 欧氏距离，非感知精确度量；灰阶亮度偏差与白平衡偏移同样不构成画质总分。',
    ],
  };
}
