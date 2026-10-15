import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { validateVisionBaseline, validateVisionIspPatches } from './vision-workshop-model.js';
import { validateVisionRaw } from './vision-workshop-raw.js';
import type { VisionCameraControls, VisionDeviceOperation } from './vision-workshop-device.js';
import type { VisionAiDebugRun } from './vision-workshop-ai-debug.js';
import { visionAcceptancePlanInput, visionAcceptanceRecordInput, evaluateVisionAcceptance, visionDeliveryTargets, type VisionAcceptancePlan, type VisionAcceptanceRecord, type VisionAcceptanceImage } from './vision-workshop-delivery.js';

export type VisionJsonValue = null | boolean | number | string | VisionJsonValue[] | VisionJsonObject;
export interface VisionJsonObject { [key: string]: VisionJsonValue }
export interface VisionNumericRule { path: string; label: string; min: number; max: number; step?: number; precision?: 'float32' | 'seconds-float32-us' }
export interface VisionParameterPatch { path: string; value: number; reason: string }
export interface VisionRawMetadata {
  scene: string;
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12 | 14 | 16;
  bayer: 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';
  packing: 'unpacked16le' | 'mipi-raw10' | 'mipi-raw12';
  stride: number;
  blackLevel: number;
  whiteLevel: number;
  exposureUs?: number;
  gain?: number;
}
export interface VisionCameraIdentity { board?: string; sensorVendor?: string; sensorModel?: string; sdkVersion?: string; cameraInterface?: string; cameraMode?: string }
export interface VisionExperimentInput extends VisionCameraIdentity { title: string; goal: string; targetId?: string }
export interface VisionBaseline { id: string; hash: string; tuning: VisionJsonObject; rules: VisionNumericRule[]; createdAt: string }
export interface VisionRawSample { id: string; filename: string; hash: string; byteLength: number; metadata: VisionRawMetadata; source: 'uploaded' | 'runner'; adapterId?: string; createdAt: string }
export interface VisionCameraFrame extends VisionCameraIdentity {
  id: string; filename: string; mimeType: 'image/png' | 'image/jpeg'; hash: string; byteLength: number;
  width: number; height: number; adapterId: string; source: 'runner'; scene?: string;
  controls?: VisionCameraControls; tuningHash?: string; candidateId?: string; capturedAt?: string;
  verification: 'unverified'; createdAt: string;
}
export interface VisionCandidate {
  id: string; title: string; hash: string; tuning: VisionJsonObject; patches: VisionParameterPatch[];
  baselineId: string; baselineHash: string; sampleIds: string[]; sampleHashes: string[]; frameIds: string[]; frameHashes: string[]; modelInput?: string;
  source: 'model' | 'manual'; model?: string; verification: 'unverified'; createdAt: string;
}
export interface VisionProcessedImage {
  id: string; sampleId: string; candidateId?: string; filename: string; mimeType: 'image/png' | 'image/jpeg';
  hash: string; byteLength: number; width: number; height: number; tuningHash?: string; source: 'uploaded' | 'runner'; adapterId?: string; verification: 'unverified'; createdAt: string;
}
export interface VisionEvaluation { id: string; imageId: string; rating: 1 | 2 | 3 | 4 | 5; notes: string; source: 'manual'; createdAt: string }
export interface VisionComparison {
  id: string; baselineImageId: string; candidateImageId: string; sampleId: string; candidateId: string;
  baselineImageHash: string; candidateImageHash: string; baselineTuningHash: string; candidateTuningHash: string;
  source: 'computed'; method: 'png-output-comparison'; metrics: VisionJsonObject; createdAt: string;
}
export interface VisionDeviceRunInput extends VisionCameraIdentity {
  operation: VisionDeviceOperation;
  adapterId: string; sensorModel: string; sdkVersion?: string; status: 'completed' | 'failed';
  candidateId?: string; sampleId?: string; evidence: VisionJsonObject;
}
export interface VisionDeviceRun extends VisionDeviceRunInput { id: string; createdAt: string }
export interface VisionExperiment extends VisionCameraIdentity {
  id: string; title: string; goal: string;
  targetId?: string; baseline: VisionBaseline | null; baselineHistory: VisionBaseline[];
  samples: VisionRawSample[]; candidates: VisionCandidate[]; processedImages: VisionProcessedImage[]; cameraFrames: VisionCameraFrame[];
  evaluations: VisionEvaluation[]; comparisons: VisionComparison[]; deviceRuns: VisionDeviceRun[]; aiDebugRuns: VisionAiDebugRun[]; selectedCandidateId: string | null; bytesStored: number; createdAt: string; updatedAt: string;
  acceptancePlan?: VisionAcceptancePlan; acceptancePlans?: VisionAcceptancePlan[]; acceptanceRecords?: VisionAcceptanceRecord[];
  deliveryTargetId?: string; vendorArtifacts?: VisionVendorArtifact[];
}
export interface VisionVendorArtifact { id: string; filename: string; hash: string; byteLength: number; bindingHash: string; sourceReadbackHash: string; createdAt: string; artifactRole: 'vendor_effect_library_candidate' }
export interface VisionCapabilities {
  bringup: VisionDeviceCapability; capture: VisionDeviceCapability; apply: VisionDeviceCapability;
  rawUpload: { status: 'available' }; candidateGeneration: { status: 'available'; verification: 'unverified' } | { status: 'unavailable'; reason: string };
  limits: { maxRawBytes: number; maxExperimentBytes: number; maxTotalBytes: number; maxExperiments: number; maxImageBytes: number };
  modelEnabled?: boolean; modelInput?: string;
  deviceAdapters?: Array<{ id: string; label: string; board: string; sensorModel: string; sensorVendor?: string; sdkVersion: string; cameraInterface?: string; cameraMode?: string; operations: string[] }>;
  supportedFormats: {
    raw: { packing: VisionRawMetadata['packing'][]; bitDepths: VisionRawMetadata['bitDepth'][]; bayer: VisionRawMetadata['bayer'][]; maxPixels: number };
    processedImages: VisionProcessedImage['mimeType'][];
    objectiveComparison: { format: 'image/png'; bitDepth: 8; colorModels: Array<'gray' | 'rgb' | 'gray-alpha' | 'rgba'>; interlaced: false; opaqueOnly: true; maxDecodedBytes: number };
  };
}
export type VisionDeviceCapability = { status: 'unavailable'; reason: string } | { status: 'available'; verification: 'configured-adapter' };
export interface VisionExportManifest {
  schemaVersion: 1; exportedAt: string; experiment: VisionExperiment; capabilities: VisionCapabilities;
  selectedTuning: VisionJsonObject | null; provenance: { raw: 'uploaded' | 'uploaded_or_runner'; processed: 'uploaded' | 'uploaded_or_runner'; evaluation: 'manual'; boardValidation: 'unavailable' | 'parameters_applied_quality_unverified' };
}
export interface VisionHandbookData extends VisionCameraIdentity {
  title: string; goal: string;
  stages: Array<{ title: string; status: 'unavailable' | 'pending' | 'recorded'; detail: string }>;
  selectedCandidate: VisionCandidate | null; samples: VisionRawSample[]; processedImages: VisionProcessedImage[]; cameraFrames: VisionCameraFrame[];
  evaluations: VisionEvaluation[]; comparisons: VisionComparison[]; cautions: string[];
}
export interface VisionWorkshopOptions { dataDir?: string; maxRawBytes?: number; maxExperimentBytes?: number; maxTotalBytes?: number; maxExperiments?: number; maxImageBytes?: number }
export interface VisionCandidateInput { title?: string; baselineHash: string; baselineId?: string; patches: VisionParameterPatch[]; sampleIds: string[]; frameIds?: string[]; modelInput?: string; source: 'model' | 'manual'; model?: string }
export interface VisionProcessedImageInput { sampleId: string; candidateId?: string; filename?: string; mimeType: 'image/png' | 'image/jpeg' }
export class VisionWorkshopError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'VisionWorkshopError'; }
}

type Store = { schemaVersion: 1; experiments: Array<{ accountId: string; experiment: VisionExperiment }> };
const MIB = 1024 * 1024;
const MAX_METADATA_BYTES = 8 * MIB;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const queues = new Map<string, Promise<void>>();

function fail(code: string, message: string, status = 400): never { throw new VisionWorkshopError(code, message, status); }
function text(value: unknown, field: string, max = 256, optional = false): string | undefined {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return fail('invalid_input', `${field} 必须是 1–${max} 字符的文本，且不能包含控制字符`);
  }
  return value.trim();
}
const CAMERA_FIELDS = ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const;
function cameraIdentity(input: Record<string, unknown>): VisionCameraIdentity {
  const identity: VisionCameraIdentity = {};
  for (const field of CAMERA_FIELDS) {
    if (input[field] === undefined) continue;
    if (typeof input[field] === 'string' && /[\x00-\x1f\x7f]/.test(input[field])) fail('invalid_input', `${field} 不能包含控制字符`);
    const value = text(input[field], field, field === 'cameraMode' ? 256 : 120, true);
    if (value !== undefined) identity[field] = value;
  }
  return identity;
}
function targetIdentity(value: unknown): string | undefined {
  if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) fail('invalid_input', 'targetId 不能包含控制字符');
  return text(value, 'targetId', 256, true);
}
function object(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_input', `${name} 必须是对象`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail('invalid_input', `${name} 包含未允许的字段 ${key}`);
  return input;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('not_found', '实验或制品不存在', 404);
  return value;
}
function sha256(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  return value;
}
function assetName(assetId: string, kind: 'raw' | 'png' | 'jpeg' | 'json'): string { return `${id(assetId)}.${kind}`; }
function configuredLimit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Vision Workshop limit must be an integer between 1 and ${ceiling}`);
  return value;
}
function sleep(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)); }
function isCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }

/**
 * Local single-host store. Every operation is serialized across service instances
 * and processes using a directory lock; each manifest is durably replaced with
 * rename. Account identity comes exclusively from the caller's authenticated
 * context. This service deliberately has no board execution adapter.
 */
export class VisionWorkshopService {
  readonly dataDir: string;
  private readonly limits: VisionCapabilities['limits'];
  private recovered = false;

  constructor(options: VisionWorkshopOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.D_OBS_VISION_WORKSHOP_DIR ?? 'var/vision-workshop');
    const maxExperiments = configuredLimit(options.maxExperiments, 100, 100);
    const maxExperimentBytes = configuredLimit(options.maxExperimentBytes, 128 * MIB, 128 * MIB);
    this.limits = {
      maxRawBytes: configuredLimit(options.maxRawBytes, 64 * MIB, 64 * MIB),
      maxExperimentBytes,
      maxTotalBytes: configuredLimit(options.maxTotalBytes, maxExperimentBytes * maxExperiments, 128 * MIB * 100),
      maxExperiments,
      maxImageBytes: configuredLimit(options.maxImageBytes, 16 * MIB, 16 * MIB),
    };
  }

  capabilities(): VisionCapabilities {
    const unavailable = { status: 'unavailable' as const, reason: '尚未配置匹配当前相机、工作模式及 SDK 的真实设备适配器，不能执行或声明完成设备验证。' };
    return {
      bringup: { ...unavailable }, capture: { ...unavailable }, apply: { ...unavailable }, rawUpload: { status: 'available' }, candidateGeneration: { status: 'available', verification: 'unverified' }, limits: { ...this.limits },
      supportedFormats: {
        raw: { packing: ['unpacked16le', 'mipi-raw10', 'mipi-raw12'], bitDepths: [8, 10, 12, 14, 16], bayer: ['RGGB', 'BGGR', 'GRBG', 'GBRG'], maxPixels: 32 * MIB },
        processedImages: ['image/png', 'image/jpeg'],
        objectiveComparison: { format: 'image/png', bitDepth: 8, colorModels: ['gray', 'rgb', 'gray-alpha', 'rgba'], interlaced: false, opaqueOnly: true, maxDecodedBytes: 64 * MIB },
      },
    };
  }

  async listExperiments(accountId: string): Promise<VisionExperiment[]> {
    return this.transaction(accountId, (store, owner) => store.experiments.filter((entry) => entry.accountId === owner).map((entry) => entry.experiment).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async createExperiment(accountId: string, input: VisionExperimentInput): Promise<VisionExperiment> {
    return this.transaction(accountId, async (store, owner) => {
      const parsed = object(input, ['title', 'goal', ...CAMERA_FIELDS, 'targetId'], 'experiment');
      if (store.experiments.length >= this.limits.maxExperiments) fail('quota_exceeded', '实验数量已达到全局上限', 409);
      const now = new Date().toISOString();
      const experiment: VisionExperiment = {
        id: randomUUID(), title: text(parsed.title, 'title', 120)!, goal: text(parsed.goal, 'goal', 2000)!,
        ...cameraIdentity(parsed),
        ...(parsed.targetId !== undefined ? { targetId: targetIdentity(parsed.targetId) } : {}),
        baseline: null, baselineHistory: [], samples: [], candidates: [], processedImages: [], cameraFrames: [], evaluations: [], comparisons: [], deviceRuns: [], aiDebugRuns: [],
        selectedCandidateId: null, bytesStored: 0, createdAt: now, updatedAt: now,
      };
      store.experiments.push({ accountId: owner, experiment });
      await this.save(store);
      return experiment;
    });
  }

  async getExperiment(accountId: string, experimentId: string): Promise<VisionExperiment> {
    return this.transaction(accountId, (store, owner) => this.owned(store, owner, experimentId));
  }

  async setDeliveryTarget(accountId: string, experimentId: string, targetId: string): Promise<VisionExperiment> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      if (!visionDeliveryTargets(experiment).some(target => target.id === targetId)) fail('delivery_target_not_found', '交付版本不存在', 404);
      experiment.deliveryTargetId = targetId;
      await this.save(store, experiment); return experiment;
    });
  }

  /** Only SDK execution calls this after verifying the exported candidate's bytes and role. */
  async archiveVendorArtifact(accountId: string, experimentId: string, input: { bindingHash: string; sourceReadbackHash: string }, data: Buffer): Promise<VisionVendorArtifact> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      object(input, ['bindingHash', 'sourceReadbackHash'], 'vendor artifact');
      if (![input.bindingHash, input.sourceReadbackHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail('invalid_evidence', '效果库绑定与真实回读哈希无效');
      this.buffer(data, 16 * MIB, '厂商候选效果库');
      try { const parsed: unknown = JSON.parse(data.toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { fail('invalid_evidence', '候选效果库必须是有效 JSON 对象'); }
      const artifacts = experiment.vendorArtifacts ??= [], hash = sha256(data);
      const existing = artifacts.find(artifact => artifact.hash === hash && artifact.bindingHash === input.bindingHash && artifact.sourceReadbackHash === input.sourceReadbackHash);
      if (existing) { await this.readAsset(assetName(existing.id, 'json'), existing.hash, existing.byteLength); return existing; }
      if (artifacts.length >= 16) fail('quota_exceeded', '候选效果库归档数量已达到上限', 409);
      const artifact: VisionVendorArtifact = { id: randomUUID(), filename: 'vendor-effect-library-candidate.json', hash, byteLength: data.length, bindingHash: input.bindingHash, sourceReadbackHash: input.sourceReadbackHash, artifactRole: 'vendor_effect_library_candidate', createdAt: new Date().toISOString() };
      this.assertQuota(store, experiment, data.length);
      await this.storeAsset(store, experiment, assetName(artifact.id, 'json'), data, () => artifacts.push(artifact)); return artifact;
    });
  }

  async readVendorArtifact(accountId: string, experimentId: string, artifactId: string): Promise<{ artifact: VisionVendorArtifact; data: Buffer }> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId), artifact = experiment.vendorArtifacts?.find(item => item.id === id(artifactId));
      if (!artifact) fail('not_found', '候选效果库不存在', 404);
      return { artifact, data: await this.readAsset(assetName(artifact.id, 'json'), artifact.hash, artifact.byteLength) };
    });
  }

  async setAcceptancePlan(accountId: string, experimentId: string, input: unknown): Promise<VisionAcceptancePlan> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const parsed = this.validate(() => visionAcceptancePlanInput.parse(input));
      const history = experiment.acceptancePlans ??= [];
      if (history.length >= 16) fail('quota_exceeded', '验收标准版本已达到上限', 409);
      const plan = { ...parsed, id: randomUUID(), createdAt: new Date().toISOString() };
      history.push(plan); experiment.acceptancePlan = plan;
      await this.save(store, experiment); return plan;
    });
  }

  async recordAcceptance(accountId: string, experimentId: string, input: unknown): Promise<VisionAcceptanceRecord> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const parsed = this.validate(() => visionAcceptanceRecordInput.parse(input));
      const plan = experiment.acceptancePlan;
      if (!plan || plan.id !== parsed.planId) fail('acceptance_plan_changed', '验收标准已更新，请重新读取', 409);
      const target = visionDeliveryTargets(experiment).find(item => item.id === parsed.candidateId);
      if (!target) fail('acceptance_target_not_found', '参数版本不存在或仍在运行', 404);
      const evidenceImages: VisionAcceptanceImage[] = [];
      for (const imageId of parsed.imageIds) {
        const image = [...experiment.cameraFrames, ...experiment.processedImages].find(item => item.id === imageId);
        if (!image) fail('acceptance_image_not_found', '验收图像必须属于当前实验', 404);
        await this.readAsset(assetName(image.id, image.mimeType === 'image/png' ? 'png' : 'jpeg'), image.hash, image.byteLength);
        const scene = 'sampleId' in image ? experiment.samples.find(sample => sample.id === image.sampleId)?.metadata.scene : image.scene;
        evidenceImages.push({ id: image.id, hash: image.hash, tuningHash: image.tuningHash, scene, source: image.source, createdAt: image.createdAt });
      }
      if (!evidenceImages.some(image => image.tuningHash === target.hash)) fail('acceptance_target_image_required', '至少一张图像须绑定当前参数版本', 409);
      const outcomes = this.validate(() => evaluateVisionAcceptance(plan, parsed));
      const records = experiment.acceptanceRecords ??= [];
      if (records.length >= 64) fail('quota_exceeded', '验收记录已达到上限', 409);
      const body = { ...parsed, id: randomUUID(), createdAt: new Date().toISOString(), tuningHash: target.hash, evidenceImages, outcomes,
        recordedBy: sha256(owner), source: 'operator_recorded' as const, measurementAuthenticity: 'unverified' as const,
        ...(parsed.report ? { reportSha256: sha256(parsed.report) } : {}) };
      const record: VisionAcceptanceRecord = { ...body, hash: sha256(JSON.stringify(body)) };
      records.push(record); await this.save(store, experiment); return record;
    });
  }

  async setBaseline(accountId: string, experimentId: string, input: { tuning: VisionJsonObject; rules: VisionNumericRule[] }): Promise<VisionBaseline> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      object(input, ['tuning', 'rules'], 'baseline');
      if (experiment.baselineHistory.length >= 16) fail('quota_exceeded', '基线版本数量已达到上限', 409);
      const validated = this.validate(() => validateVisionBaseline(input.tuning, input.rules));
      const tuning = validated.tuning as VisionJsonObject;
      const baseline: VisionBaseline = { id: randomUUID(), hash: sha256(JSON.stringify(tuning)), tuning, rules: validated.rules, createdAt: new Date().toISOString() };
      experiment.baseline = baseline;
      experiment.baselineHistory.push(baseline);
      // Historical candidates preserve their exact baseline, tuning and evidence.
      experiment.selectedCandidateId = null;
      await this.save(store, experiment);
      return baseline;
    });
  }

  async addRawSample(accountId: string, experimentId: string, input: { filename?: string; metadata: VisionRawMetadata }, data: Buffer): Promise<VisionRawSample> {
    object(input, ['filename', 'metadata'], 'raw sample');
    return this.archiveRawSample(accountId, experimentId, input, data);
  }

  /** Only server-owned adapters may call this; do not map HTTP body fields here. */
  async addRunnerRawSample(accountId: string, experimentId: string, input: { filename?: string; metadata: VisionRawMetadata; adapterId: string }, data: Buffer): Promise<VisionRawSample> {
    object(input, ['filename', 'metadata', 'adapterId'], 'runner raw sample');
    return this.archiveRawSample(accountId, experimentId, input, data, text(input.adapterId, 'adapterId', 120)!);
  }

  private async archiveRawSample(accountId: string, experimentId: string, input: { filename?: string; metadata: VisionRawMetadata }, data: Buffer, adapterId?: string): Promise<VisionRawSample> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      this.buffer(data, this.limits.maxRawBytes, 'Raw');
      if (experiment.samples.length >= 64) fail('quota_exceeded', 'Raw 样本数量已达到上限', 409);
      const metadata = this.validate(() => validateVisionRaw(data, input.metadata)) as VisionRawMetadata;
      // A single upload represents exactly one frame; trailing frames are rejected.
      if (data.length !== metadata.stride * metadata.height) fail('invalid_raw_length', 'Raw 字节数必须等于 stride × height');
      const sample: VisionRawSample = {
        id: randomUUID(), filename: this.filename(input.filename, 'sample.raw'), hash: sha256(data),
        byteLength: data.length, metadata, source: adapterId ? 'runner' : 'uploaded', ...(adapterId ? { adapterId } : {}), createdAt: new Date().toISOString(),
      };
      this.assertQuota(store, experiment, data.length);
      await this.storeAsset(store, experiment, assetName(sample.id, 'raw'), data, () => experiment.samples.push(sample));
      return sample;
    });
  }

  async readRawSample(accountId: string, experimentId: string, sampleId: string): Promise<{ sample: VisionRawSample; data: Buffer }> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const sample = experiment.samples.find((entry) => entry.id === id(sampleId));
      if (!sample) fail('not_found', 'Raw 样本不存在', 404);
      return { sample, data: await this.readAsset(assetName(sample.id, 'raw'), sample.hash, sample.byteLength) };
    });
  }

  async createCandidate(accountId: string, experimentId: string, input: VisionCandidateInput): Promise<VisionCandidate> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      object(input, ['title', 'baselineHash', 'baselineId', 'patches', 'sampleIds', 'frameIds', 'modelInput', 'source', 'model'], 'candidate');
      const baseline = experiment.baseline;
      if (!baseline) fail('baseline_required', '请先上传真实 ISP 基线和可调数值规则', 409);
      if (input.baselineHash !== baseline.hash) fail('stale_baseline', '基线已更新，请重新生成候选', 409);
      if (input.baselineId !== undefined && input.baselineId !== baseline.id) fail('stale_baseline', '基线规则或版本已更新，请重新生成候选', 409);
      if (experiment.candidates.length >= 64) fail('quota_exceeded', '参数候选数量已达到上限', 409);
      if (input.source !== 'model' && input.source !== 'manual') fail('invalid_input', '候选来源必须是 model 或 manual');
      const model = input.source === 'model' ? text(input.model, 'model', 160)! : undefined;
      if (input.source === 'manual' && input.model !== undefined) fail('invalid_input', '人工候选不能声明模型来源');
      if (!Array.isArray(input.sampleIds) || input.sampleIds.length > 64 || new Set(input.sampleIds).size !== input.sampleIds.length || input.frameIds !== undefined && (!Array.isArray(input.frameIds) || input.frameIds.length > 64 || new Set(input.frameIds).size !== input.frameIds.length) || input.sampleIds.length + (input.frameIds?.length ?? 0) < 1) fail('invalid_input', '候选必须关联真实 Raw 样本或相机帧，且关联不重复');
      const samples = input.sampleIds.map((sampleId) => {
        const sample = experiment.samples.find((entry) => entry.id === id(sampleId));
        if (!sample) fail('not_found', '关联的 Raw 样本不存在', 404);
        return sample;
      });
      const frames = (input.frameIds ?? []).map(frameId => {
        const frame = experiment.cameraFrames.find(entry => entry.id === id(frameId));
        if (!frame) fail('not_found', '关联的相机帧不存在', 404);
        return frame;
      });
      if (input.modelInput !== undefined && !['raw_statistics_and_baseline', 'processed_frame_statistics_and_baseline'].includes(input.modelInput)) fail('invalid_input', '未知模型输入来源');
      const patches = this.validate(() => validateVisionIspPatches(baseline.tuning, baseline.rules, input.patches));
      const tuning = clone(baseline.tuning);
      for (const patch of patches) {
        const segments = patch.path.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
        let node: VisionJsonObject | VisionJsonValue[] = tuning;
        for (const segment of segments.slice(0, -1)) node = (node as VisionJsonObject)[segment] as VisionJsonObject | VisionJsonValue[];
        (node as VisionJsonObject)[segments.at(-1)!] = patch.value;
      }
      const candidate: VisionCandidate = {
        id: randomUUID(), title: text(input.title, 'title', 120, true) ?? `候选 ${experiment.candidates.length + 1}`,
        hash: sha256(JSON.stringify(tuning)), tuning, patches, baselineId: baseline.id, baselineHash: baseline.hash,
        sampleIds: samples.map((entry) => entry.id), sampleHashes: samples.map((entry) => entry.hash), frameIds: frames.map(entry => entry.id), frameHashes: frames.map(entry => entry.hash), ...(input.modelInput ? { modelInput: input.modelInput } : {}),
        source: input.source, ...(model ? { model } : {}), verification: 'unverified', createdAt: new Date().toISOString(),
      };
      experiment.candidates.push(candidate);
      await this.save(store, experiment);
      return candidate;
    });
  }

  async addProcessedImage(accountId: string, experimentId: string, input: VisionProcessedImageInput, data: Buffer): Promise<VisionProcessedImage> {
    object(input, ['sampleId', 'candidateId', 'filename', 'mimeType'], 'processed image');
    return this.archiveProcessedImage(accountId, experimentId, input, data);
  }

  /** Only server-owned adapters may call this; do not map HTTP body fields here. */
  async addRunnerProcessedImage(accountId: string, experimentId: string, input: VisionProcessedImageInput & { adapterId: string; tuningHash?: string }, data: Buffer): Promise<VisionProcessedImage> {
    object(input, ['sampleId', 'candidateId', 'filename', 'mimeType', 'adapterId', 'tuningHash'], 'runner processed image');
    return this.archiveProcessedImage(accountId, experimentId, input, data, text(input.adapterId, 'adapterId', 120)!);
  }

  private async archiveProcessedImage(accountId: string, experimentId: string, input: VisionProcessedImageInput & { tuningHash?: string }, data: Buffer, adapterId?: string): Promise<VisionProcessedImage> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      this.buffer(data, this.limits.maxImageBytes, '处理图像');
      if (experiment.processedImages.length >= 128) fail('quota_exceeded', '处理图像数量已达到上限', 409);
      const sample = experiment.samples.find((entry) => entry.id === id(input.sampleId));
      if (!sample) fail('not_found', '关联的 Raw 样本不存在', 404);
      let tuningHash = experiment.baseline?.hash;
      if (input.candidateId !== undefined) {
        const candidate = experiment.candidates.find((entry) => entry.id === id(input.candidateId));
        if (!candidate || !candidate.sampleIds.includes(sample.id)) fail('invalid_evidence', '处理图像必须关联使用了该 Raw 样本的候选');
        tuningHash = candidate.hash;
        if (input.tuningHash !== undefined && input.tuningHash !== tuningHash) fail('invalid_evidence', '执行器处理图像参数哈希与候选不匹配');
      } else if (input.tuningHash !== undefined) {
        if (!experiment.baselineHistory.some((entry) => entry.hash === input.tuningHash)) fail('invalid_evidence', '执行器处理图像必须关联实验中已有基线参数哈希');
        tuningHash = input.tuningHash;
      }
      const dimensions = imageDimensions(data, input.mimeType);
      if (dimensions.width !== sample.metadata.width || dimensions.height !== sample.metadata.height) fail('invalid_image_dimensions', '处理图像尺寸必须与所关联 Raw 样本一致');
      const image: VisionProcessedImage = {
        id: randomUUID(), sampleId: sample.id, ...(input.candidateId ? { candidateId: input.candidateId } : {}),
        filename: this.filename(input.filename, input.mimeType === 'image/png' ? 'processed.png' : 'processed.jpg'),
        mimeType: input.mimeType, hash: sha256(data), byteLength: data.length, ...dimensions, ...(tuningHash ? { tuningHash } : {}),
        source: adapterId ? 'runner' : 'uploaded', ...(adapterId ? { adapterId } : {}), verification: 'unverified', createdAt: new Date().toISOString(),
      };
      this.assertQuota(store, experiment, data.length);
      await this.storeAsset(store, experiment, assetName(image.id, input.mimeType === 'image/png' ? 'png' : 'jpeg'), data, () => experiment.processedImages.push(image));
      return image;
    });
  }

  async readProcessedImage(accountId: string, experimentId: string, imageId: string): Promise<{ image: VisionProcessedImage; data: Buffer }> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const image = experiment.processedImages.find((entry) => entry.id === id(imageId));
      if (!image) fail('not_found', '处理图像不存在', 404);
      return { image, data: await this.readAsset(assetName(image.id, image.mimeType === 'image/png' ? 'png' : 'jpeg'), image.hash, image.byteLength) };
    });
  }

  /** Processed camera frames are separate evidence; UVC images never become Bayer Raw. */
  async addCameraFrame(accountId: string, experimentId: string, input: { filename?: string; mimeType: 'image/png' | 'image/jpeg'; adapterId: string; controls?: VisionCameraControls; scene?: string; tuningHash?: string; candidateId?: string; capturedAt?: string }, data: Buffer): Promise<VisionCameraFrame> {
    object(input, ['filename', 'mimeType', 'adapterId', 'controls', 'scene', 'tuningHash', 'candidateId', 'capturedAt'], 'camera frame');
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      this.buffer(data, this.limits.maxImageBytes, '相机帧');
      if (experiment.cameraFrames.length >= 128) fail('quota_exceeded', '相机帧数量已达到上限', 409);
      if (input.tuningHash !== undefined && !/^[a-f0-9]{64}$/.test(input.tuningHash)) fail('invalid_evidence', '相机配置哈希无效');
      if (input.candidateId) {
        const candidate = experiment.candidates.find(entry => entry.id === id(input.candidateId));
        if (!candidate || candidate.hash !== input.tuningHash) fail('vision_device_readback_mismatch', '实际相机配置与关联候选不一致', 409);
      }
      if (input.capturedAt !== undefined && (!Number.isFinite(Date.parse(input.capturedAt)) || input.capturedAt.length > 64)) fail('invalid_evidence', '相机采集时间无效');
      const frame: VisionCameraFrame = {
        id: randomUUID(), filename: this.filename(input.filename, input.mimeType === 'image/png' ? 'camera.png' : 'camera.jpg'), mimeType: input.mimeType,
        hash: sha256(data), byteLength: data.length, ...imageDimensions(data, input.mimeType), ...cameraIdentity(experiment as unknown as Record<string, unknown>),
        adapterId: text(input.adapterId, 'adapterId', 120)!, source: 'runner', verification: 'unverified', createdAt: new Date().toISOString(),
        ...(input.scene ? { scene: text(input.scene, 'scene', 120) } : {}), ...(input.controls ? { controls: clone(input.controls) } : {}),
        ...(input.tuningHash ? { tuningHash: input.tuningHash } : {}), ...(input.candidateId ? { candidateId: input.candidateId } : {}), ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      };
      this.assertQuota(store, experiment, data.length);
      await this.storeAsset(store, experiment, assetName(frame.id, frame.mimeType === 'image/png' ? 'png' : 'jpeg'), data, () => experiment.cameraFrames.push(frame));
      return frame;
    });
  }

  async readCameraFrame(accountId: string, experimentId: string, frameId: string): Promise<{ frame: VisionCameraFrame; data: Buffer }> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const frame = experiment.cameraFrames.find(entry => entry.id === id(frameId));
      if (!frame) fail('not_found', '相机帧不存在', 404);
      return { frame, data: await this.readAsset(assetName(frame.id, frame.mimeType === 'image/png' ? 'png' : 'jpeg'), frame.hash, frame.byteLength) };
    });
  }

  async addEvaluation(accountId: string, experimentId: string, input: { imageId: string; rating: 1 | 2 | 3 | 4 | 5; notes: string }): Promise<VisionEvaluation> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      object(input, ['imageId', 'rating', 'notes'], 'evaluation');
      if (![...experiment.processedImages, ...experiment.cameraFrames].some((entry) => entry.id === id(input.imageId))) fail('not_found', '被评价图像不存在', 404);
      if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) fail('invalid_input', '人工评分必须为 1–5 的整数');
      if (experiment.evaluations.length >= 256) fail('quota_exceeded', '人工评价数量已达到上限', 409);
      const evaluation: VisionEvaluation = { id: randomUUID(), imageId: input.imageId, rating: input.rating, notes: text(input.notes, 'notes', 2000)!, source: 'manual', createdAt: new Date().toISOString() };
      experiment.evaluations.push(evaluation);
      await this.save(store, experiment);
      return evaluation;
    });
  }

  /** Metrics must be calculated by server code from archived bytes, never mapped from an HTTP body. */
  async recordComparison(accountId: string, experimentId: string, input: { baselineImageId: string; candidateImageId: string; metrics: VisionJsonObject }): Promise<VisionComparison> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      object(input, ['baselineImageId', 'candidateImageId', 'metrics'], 'comparison');
      if (experiment.comparisons.length >= 64) fail('quota_exceeded', '客观比较记录数量已达到上限', 409);
      const baselineImage = experiment.processedImages.find((entry) => entry.id === id(input.baselineImageId));
      const candidateImage = experiment.processedImages.find((entry) => entry.id === id(input.candidateImageId));
      if (!baselineImage || !candidateImage) fail('not_found', '被比较图像不存在', 404);
      if (baselineImage.candidateId || !candidateImage.candidateId || baselineImage.sampleId !== candidateImage.sampleId || baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) fail('invalid_comparison', '比较需要同一 Raw、同尺寸的一张基线图和一张候选图', 409);
      const candidate = experiment.candidates.find((entry) => entry.id === candidateImage.candidateId);
      if (!candidate || !baselineImage.tuningHash || baselineImage.tuningHash !== candidate.baselineHash || candidateImage.tuningHash !== candidate.hash) fail('comparison_tuning_mismatch', '基线图参数版本必须与候选生成时的基础配置一致', 409);
      if (baselineImage.mimeType !== 'image/png' || candidateImage.mimeType !== 'image/png') fail('vision_quality_unavailable', '当前客观比较只支持 PNG 输出', 415);
      const comparison: VisionComparison = {
        id: randomUUID(), baselineImageId: baselineImage.id, candidateImageId: candidateImage.id, sampleId: baselineImage.sampleId, candidateId: candidate.id,
        baselineImageHash: baselineImage.hash, candidateImageHash: candidateImage.hash, baselineTuningHash: baselineImage.tuningHash, candidateTuningHash: candidateImage.tuningHash,
        source: 'computed', method: 'png-output-comparison', metrics: boundedEvidence(input.metrics), createdAt: new Date().toISOString(),
      };
      experiment.comparisons.push(comparison);
      await this.save(store, experiment);
      return comparison;
    });
  }

  async selectCandidate(accountId: string, experimentId: string, candidateId: string): Promise<VisionExperiment> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const candidate = experiment.candidates.find((entry) => entry.id === id(candidateId));
      if (!candidate) fail('not_found', '参数候选不存在', 404);
      if (!experiment.evaluations.some((evaluation) => [...experiment.processedImages, ...experiment.cameraFrames].some((image) => image.id === evaluation.imageId && image.candidateId === candidate.id))) {
        fail('evaluation_required', '请先上传该候选的真实处理图像并完成人工评价', 409);
      }
      experiment.selectedCandidateId = candidate.id;
      experiment.deliveryTargetId = candidate.id;
      await this.save(store, experiment);
      return experiment;
    });
  }

  /** Append server-observed adapter evidence; completion does not prove image quality. */
  async recordDeviceRun(accountId: string, experimentId: string, input: VisionDeviceRunInput): Promise<VisionDeviceRun> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const parsed = object(input, ['operation', 'adapterId', ...CAMERA_FIELDS, 'status', 'candidateId', 'sampleId', 'evidence'], 'device run');
      if (!['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning', 'preview_start', 'preview_stop', 'preview_frame', 'capture_frame', 'controls_get', 'controls_set', 'restore_tuning', 'tuning_get', 'tuning_load', 'tuning_export', 'calibration_apply'].includes(input.operation) || !['completed', 'failed'].includes(input.status)) fail('invalid_input', '板端操作类型或状态无效');
      if (experiment.deviceRuns.length >= 128) fail('quota_exceeded', '板端操作记录已达到上限', 409);
      if (input.candidateId !== undefined && !experiment.candidates.some((entry) => entry.id === id(input.candidateId))) fail('not_found', '板端操作引用的候选不存在', 404);
      if (input.sampleId !== undefined && !experiment.samples.some((entry) => entry.id === id(input.sampleId))) fail('not_found', '板端操作引用的样本不存在', 404);
      const evidence = boundedEvidence(input.evidence);
      const run: VisionDeviceRun = {
        id: randomUUID(), operation: input.operation, adapterId: text(input.adapterId, 'adapterId', 120)!, ...cameraIdentity(parsed), sensorModel: text(input.sensorModel, 'sensorModel', 120)!,
        status: input.status, ...(input.candidateId ? { candidateId: input.candidateId } : {}), ...(input.sampleId ? { sampleId: input.sampleId } : {}), evidence, createdAt: new Date().toISOString(),
      };
      experiment.deviceRuns.push(run);
      await this.save(store, experiment);
      return run;
    });
  }

  /** The run ledger is written only by request-authorized orchestration, never from an HTTP body. */
  async saveAiDebugRun(accountId: string, experimentId: string, run: VisionAiDebugRun): Promise<VisionAiDebugRun> {
    return this.transaction(accountId, async (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      id(run.id);
      if (run.source !== 'model' || !['queued', 'running', 'completed', 'failed', 'canceled', 'interrupted'].includes(run.status) || !Number.isSafeInteger(run.maxRounds) || run.maxRounds < 1 || run.maxRounds > 6 || !Array.isArray(run.iterations) || run.iterations.length > 7 || !Array.isArray(run.operations) || run.operations.length > 80) fail('invalid_input', 'AI 调试运行状态超出受限协议');
      const entry = boundedEvidence(JSON.parse(JSON.stringify(run)), 40_000, 512 * 1024) as unknown as VisionAiDebugRun;
      const index = experiment.aiDebugRuns.findIndex(existing => existing.id === run.id);
      if (index < 0) { if (experiment.aiDebugRuns.length >= 16) fail('quota_exceeded', 'AI 调试历史达到上限', 409); experiment.aiDebugRuns.push(entry); }
      else experiment.aiDebugRuns[index] = entry;
      await this.save(store, experiment); return entry;
    });
  }

  async listAiDebugRuns(accountId: string, experimentId: string): Promise<VisionAiDebugRun[]> {
    return this.transaction(accountId, (store, owner) => this.owned(store, owner, experimentId).aiDebugRuns);
  }

  async readAiDebugRun(accountId: string, experimentId: string, runId: string): Promise<VisionAiDebugRun> {
    return this.transaction(accountId, (store, owner) => {
      const run = this.owned(store, owner, experimentId).aiDebugRuns.find(entry => entry.id === id(runId));
      if (!run) fail('not_found', 'AI 调试运行不存在', 404); return run;
    });
  }

  async exportManifest(accountId: string, experimentId: string): Promise<VisionExportManifest> {
    return this.transaction(accountId, (store, owner) => {
      const experiment = this.owned(store, owner, experimentId);
      const explicitTarget = experiment.deliveryTargetId ? visionDeliveryTargets(experiment).find(target => target.id === experiment.deliveryTargetId) : undefined;
      const selectedTuning = experiment.deliveryTargetId ? explicitTarget?.source === 'vendor-library' ? null : explicitTarget?.tuning ?? null : experiment.candidates.find(entry => entry.id === experiment.selectedCandidateId)?.tuning ?? null;
      return { schemaVersion: 1 as const, exportedAt: new Date().toISOString(), experiment, capabilities: this.capabilities(), selectedTuning, provenance: { raw: experiment.samples.some((sample) => sample.source === 'runner') ? 'uploaded_or_runner' as const : 'uploaded' as const, processed: experiment.processedImages.some((image) => image.source === 'runner') ? 'uploaded_or_runner' as const : 'uploaded' as const, evaluation: 'manual' as const, boardValidation: hasMatchedApply(experiment) ? 'parameters_applied_quality_unverified' as const : 'unavailable' as const } };
    });
  }

  async exportHandbook(accountId: string, experimentId: string): Promise<VisionHandbookData> {
    return this.transaction(accountId, (store, owner) => buildVisionHandbook(this.owned(store, owner, experimentId), this.capabilities()));
  }

  private owned(store: Store, accountId: string, experimentId: string): VisionExperiment {
    const record = store.experiments.find((entry) => entry.accountId === accountId && entry.experiment.id === id(experimentId));
    if (!record) fail('not_found', '实验不存在', 404);
    return record.experiment;
  }

  private async transaction<T>(accountId: string, operation: (store: Store, owner: string) => Promise<T> | T): Promise<T> {
    const owner = text(accountId, 'authenticated accountId', 500)!;
    if (/[\n\r\t]/.test(owner)) fail('invalid_input', 'authenticated accountId 不能包含空白控制字符');
    const previous = queues.get(this.dataDir) ?? Promise.resolve();
    let finish!: () => void;
    const tail = new Promise<void>((done) => { finish = done; });
    queues.set(this.dataDir, tail);
    await previous;
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await mkdir(join(this.dataDir, 'assets'), { recursive: true, mode: 0o700 });
      release = await this.lock();
      const store = await this.load();
      if (!this.recovered) { await this.recoverOrphans(store); this.recovered = true; }
      return clone(await operation(store, owner));
    } finally {
      try { await release?.(); } finally { finish(); if (queues.get(this.dataDir) === tail) queues.delete(this.dataDir); }
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const lockPath = join(this.dataDir, 'store.lock');
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await this.lockOwner(lockPath)) {
        if (await this.recoverDeadLock(lockPath)) continue;
        await sleep(25);
        continue;
      }
      const claim = await this.claimCompleteOwner(lockPath);
      if (claim) return claim.release;
      if (await this.recoverDeadLock(lockPath)) continue;
      await sleep(25);
    }
    return fail('store_busy', '实验存储忙，请稍后重试', 503);
  }

  private async claimCompleteOwner(path: string): Promise<{ token: string; release: () => Promise<void> } | null> {
    const token = randomUUID();
    const temporary = `${path}.owner.${process.pid}.${token}.tmp`;
    try {
      // Publish an immutable complete owner with link(2), which fails if a
      // claimant already exists. No process can observe a newly empty lock or
      // a half-written pid. An interrupted owner write never claims the lock.
      await this.atomicFile(temporary, Buffer.from(JSON.stringify({ pid: process.pid, token })));
      try { await link(temporary, path); } catch (error) { if (isCode(error, 'EEXIST')) return null; throw error; }
      return {
        token,
        release: async () => {
          const current = await this.lockOwner(path);
          if (current?.pid === process.pid && current.token === token) await unlink(path).catch((error) => { if (!isCode(error, 'ENOENT')) throw error; });
        },
      };
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async lockOwner(path: string): Promise<{ pid: number; token: string } | null> {
    let contents: string;
    try { contents = await readFile(path, 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) return null; throw error; }
    try {
      const owner = JSON.parse(contents) as { pid?: unknown; token?: unknown };
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || Number(owner.pid) > 2_147_483_647 || typeof owner.token !== 'string' || !UUID.test(owner.token)) throw new Error();
      return { pid: owner.pid as number, token: owner.token };
    } catch {
      // Unknown or damaged historical owners cannot be safely declared dead.
      // Operators must inspect these claims with the service stopped.
      return fail('store_lock_corrupt', '存储锁所有者无法确认；请停止服务后检查，未自动删除任何锁', 503);
    }
  }

  private lockOwnerAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return !isCode(error, 'ESRCH'); }
  }

  private async reclaimDeadClaim(path: string, depth = 0): Promise<boolean> {
    const owner = await this.lockOwner(path);
    if (!owner) return true;
    if (this.lockOwnerAlive(owner.pid)) return false;
    if (depth >= 3) return fail('store_lock_recovery_required', '异常中断的锁恢复层数超过上限；请停止服务后检查', 503);
    // A guard is unique to the dead owner's token. Only its live owner may
    // remove that stale claim; contenders cannot delete a replacement owner.
    const guardPath = `${path}.recover-${owner.token}`;
    let guard = await this.claimCompleteOwner(guardPath);
    if (!guard) {
      if (!await this.reclaimDeadClaim(guardPath, depth + 1)) return false;
      guard = await this.claimCompleteOwner(guardPath);
      if (!guard) return false;
    }
    try {
      const current = await this.lockOwner(path);
      if (!current) return true;
      if (current.pid !== owner.pid || current.token !== owner.token || this.lockOwnerAlive(current.pid)) return false;
      await unlink(path).catch((error) => { if (!isCode(error, 'ENOENT')) throw error; });
      return true;
    } finally { await guard.release(); }
  }

  private async recoverDeadLock(lockPath: string): Promise<boolean> {
    const owner = await this.lockOwner(lockPath);
    if (!owner) return true;
    if (this.lockOwnerAlive(owner.pid)) return false;
    const recoveryPath = `${lockPath}.recovery`;
    let claim = await this.claimCompleteOwner(recoveryPath);
    if (!claim) {
      if (!await this.reclaimDeadClaim(recoveryPath)) return false;
      claim = await this.claimCompleteOwner(recoveryPath);
      if (!claim) return false;
    }
    try {
      const current = await this.lockOwner(lockPath);
      if (!current) return true;
      if (current.pid !== owner.pid || current.token !== owner.token || this.lockOwnerAlive(current.pid)) return false;
      await unlink(lockPath).catch((error) => { if (!isCode(error, 'ENOENT')) throw error; });
      return true;
    } finally { await claim.release(); }
  }

  private async load(): Promise<Store> {
    let contents: string;
    try { contents = await readFile(join(this.dataDir, 'manifest.json'), 'utf8'); } catch (error) { if (isCode(error, 'ENOENT')) return { schemaVersion: 1, experiments: [] }; throw error; }
    try {
      const store = JSON.parse(contents) as Store;
      if (store.schemaVersion !== 1 || !Array.isArray(store.experiments) || store.experiments.some((entry) => typeof entry.accountId !== 'string' || !entry.experiment || !UUID.test(entry.experiment.id) || !Array.isArray(entry.experiment.samples) || !Array.isArray(entry.experiment.processedImages) || !Number.isSafeInteger(entry.experiment.bytesStored))) throw new Error('invalid store');
      for (const { experiment } of store.experiments) { experiment.deviceRuns ??= []; experiment.comparisons ??= []; experiment.cameraFrames ??= []; experiment.aiDebugRuns ??= []; for (const candidate of experiment.candidates) { candidate.frameIds ??= []; candidate.frameHashes ??= []; } }
      return store;
    } catch { return fail('store_corrupt', '实验存储损坏，已停止读取和修改', 503); }
  }

  private assertQuota(store: Store, experiment?: VisionExperiment, additionalBytes = 0): void {
    let total = 0;
    for (const entry of store.experiments) {
      const metadataBytes = Buffer.byteLength(JSON.stringify(entry.experiment));
      const bytes = entry.experiment.bytesStored + metadataBytes + (entry.experiment === experiment ? additionalBytes : 0);
      if (metadataBytes > MAX_METADATA_BYTES || bytes > this.limits.maxExperimentBytes) fail('quota_exceeded', '实验存储额度不足', 409);
      total += bytes;
    }
    if (store.experiments.length > this.limits.maxExperiments || total > this.limits.maxTotalBytes) fail('quota_exceeded', '平台实验总存储额度不足', 409);
  }

  private async save(store: Store, experiment?: VisionExperiment): Promise<void> {
    if (experiment) experiment.updatedAt = new Date().toISOString();
    this.assertQuota(store);
    await this.atomicFile(join(this.dataDir, 'manifest.json'), Buffer.from(JSON.stringify(store)));
  }

  private async atomicFile(path: string, data: Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const directory = await open(path.substring(0, path.lastIndexOf('/')), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }

  private async storeAsset(store: Store, experiment: VisionExperiment, name: string, data: Buffer, attach: () => void): Promise<void> {
    const path = join(this.dataDir, 'assets', name);
    await this.atomicFile(path, data);
    try { attach(); experiment.bytesStored += data.length; await this.save(store, experiment); }
    catch (error) {
      // rename may have succeeded before a directory fsync error. Preserve any
      // asset already referenced by the committed manifest in that case.
      let referenced = true;
      try { referenced = (await readFile(join(this.dataDir, 'manifest.json'), 'utf8')).includes(name.split('.')[0]!); }
      catch (readError) { if (isCode(readError, 'ENOENT')) referenced = false; }
      if (!referenced) await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  private async readAsset(name: string, hash: string, expectedLength: number): Promise<Buffer> {
    let data: Buffer;
    try { data = await readFile(join(this.dataDir, 'assets', name)); } catch { return fail('asset_unavailable', '归档制品缺失或不可读取', 503); }
    if (data.length !== expectedLength || sha256(data) !== hash) fail('asset_corrupt', '归档制品校验失败', 503);
    return data;
  }

  private async recoverOrphans(store: Store): Promise<void> {
    const known = new Set<string>();
    for (const { experiment } of store.experiments) {
      for (const sample of experiment.samples) known.add(assetName(sample.id, 'raw'));
      for (const image of [...experiment.processedImages, ...experiment.cameraFrames]) known.add(assetName(image.id, image.mimeType === 'image/png' ? 'png' : 'jpeg'));
      for (const artifact of experiment.vendorArtifacts ?? []) known.add(assetName(artifact.id, 'json'));
    }
    for (const file of await readdir(join(this.dataDir, 'assets'))) if (/^[0-9a-f-]+\.(raw|png|jpeg|json)(\.[0-9a-f-]+\.tmp)?$/.test(file) && !known.has(file)) await unlink(join(this.dataDir, 'assets', file));
    for (const file of await readdir(this.dataDir)) if (/^manifest\.json\.[0-9a-f-]+\.tmp$/.test(file)) await unlink(join(this.dataDir, file));
  }

  private filename(value: unknown, fallback: string): string {
    const name = text(value, 'filename', 200, true) ?? fallback;
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') fail('invalid_input', 'filename 必须是无路径的文件名');
    return name;
  }
  private buffer(data: Buffer, maximum: number, label: string): void {
    if (!Buffer.isBuffer(data) || data.length === 0) fail('invalid_input', `${label} 必须是非空文件`);
    if (data.length > maximum) fail('file_too_large', `${label} 文件超过上传限额`, 413);
  }
  private validate<T>(operation: () => T): T {
    try { return operation(); } catch (error) { if (error instanceof VisionWorkshopError) throw error; return fail('invalid_input', error instanceof Error ? error.message : '无效的实验输入'); }
  }
}

function hasMatchedApply(experiment: VisionExperiment): boolean {
  return experiment.deviceRuns.some((run) => {
    if (run.operation !== 'apply_tuning' || run.status !== 'completed' || !run.candidateId) return false;
    const candidate = experiment.candidates.find((entry) => entry.id === run.candidateId);
    const result = run.evidence.result;
    return Boolean(candidate && result && typeof result === 'object' && !Array.isArray(result) && result.appliedHash === candidate.hash && result.readbackHash === candidate.hash);
  });
}

/** Pure projection, allowing ZIP manifests and handbooks to use one snapshot. */
export function buildVisionHandbook(experiment: VisionExperiment, capabilities: VisionCapabilities): VisionHandbookData {
  const bringup = experiment.deviceRuns.findLast((run) => run.operation === 'bringup' && run.status === 'completed' && run.evidence.result && typeof run.evidence.result === 'object' && !Array.isArray(run.evidence.result) && run.evidence.result.passed === true);
  const applied = hasMatchedApply(experiment);
  const profile = capabilities.deviceAdapters?.find(adapter => adapter.id === experiment.targetId);
  const rawUnavailable = Boolean(profile && !profile.operations.includes('capture_raw') && !experiment.samples.length);
  return {
    title: experiment.title, goal: experiment.goal, board: experiment.board, sensorVendor: experiment.sensorVendor,
    sensorModel: experiment.sensorModel, sdkVersion: experiment.sdkVersion, cameraInterface: experiment.cameraInterface, cameraMode: experiment.cameraMode,
    stages: [
      { title: '相机点亮', status: bringup ? 'recorded' : capabilities.bringup.status === 'available' ? 'pending' : 'unavailable', detail: bringup ? `已保存适配器 ${bringup.adapterId} 的点亮检查通过回执（${bringup.id}）；具体检查见设备执行记录。` : capabilities.bringup.status === 'unavailable' ? capabilities.bringup.reason : '已配置 SDK 适配器，尚未保存点亮检查通过回执；配置存在不能代替设备探测。' },
      { title: 'Raw 采集归档', status: experiment.samples.length ? 'recorded' : rawUnavailable ? 'unavailable' : 'pending', detail: rawUnavailable ? '当前绑定适配器没有 Bayer Raw 采集能力；PNG/JPEG 相机帧作为独立的处理输出归档，不能作为 Raw。' : `${experiment.samples.length} 个 Raw 样本（上传 ${experiment.samples.filter((entry) => entry.source === 'uploaded').length}，执行器归档 ${experiment.samples.filter((entry) => entry.source === 'runner').length}）；每个样本保留来源、元数据和 SHA-256。` },
      { title: '相机帧采集归档', status: experiment.cameraFrames.length ? 'recorded' : profile?.operations.includes('capture_frame') ? 'pending' : 'unavailable', detail: `${experiment.cameraFrames.length} 张实际 PNG/JPEG 相机处理帧；保留场景、控制快照、配置哈希和 SHA-256，不是 Bayer Raw。` },
      { title: 'ISP 参数候选', status: experiment.candidates.length ? 'recorded' : 'pending', detail: `${experiment.candidates.length} 个基于真实基线和允许规则生成的候选；候选选择与参数应用均不能代替画质验收。` },
      { title: '效果评估', status: experiment.evaluations.length || experiment.comparisons.length ? 'recorded' : 'pending', detail: `${experiment.processedImages.length} 张处理图像（上传 ${experiment.processedImages.filter((entry) => entry.source === 'uploaded').length}，执行器归档 ${experiment.processedImages.filter((entry) => entry.source === 'runner').length}），${experiment.cameraFrames.length} 张独立采集的相机处理帧，${experiment.evaluations.length} 次人工评价，${experiment.comparisons.length} 次同 Raw 客观比较；相机帧的输出码值统计与人工观察另行记录。` },
      { title: '参数应用与回读', status: applied ? 'recorded' : 'pending', detail: applied ? '已保存与候选配置哈希一致的应用及回读回执；画质验收仍未完成。' : '尚无哈希一致的参数应用与回读回执。' },
    ],
    selectedCandidate: experiment.candidates.find((entry) => entry.id === experiment.selectedCandidateId) ?? null,
    samples: experiment.samples, processedImages: experiment.processedImages, cameraFrames: experiment.cameraFrames, evaluations: experiment.evaluations, comparisons: experiment.comparisons,
    cautions: ['候选参数必须在目标 Sensor 模式、SDK 与 ISP 版本上验证后才能用于交付。', applied ? '已保存参数应用与回读证据，画质及性能验收仍需另行完成；人工评分不能证明验收通过。' : '上传图像和人工评分仅记录用户提供的证据；尚无参数应用与回读一致的验证记录。', 'Raw Bayer 预览与原始统计不能代替真实 ISP 输出。'],
  };
}

function boundedEvidence(input: unknown, maxNodes = 4096, maxBytes = 64 * 1024): VisionJsonObject {
  let nodes = 0;
  const walk = (value: unknown, depth: number): VisionJsonValue => {
    if (++nodes > maxNodes || depth > 16) fail('invalid_input', '板端证据结构超过上限');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 4096) return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const result: VisionJsonObject = {};
      for (const [key, entry] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || /[\x00-\x1f\x7f]/.test(key)) fail('invalid_input', '板端证据包含不安全字段');
        result[key] = walk(entry, depth + 1);
      }
      return result;
    }
    return fail('invalid_input', '板端证据必须是有限 JSON 数据');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_input', '板端证据必须是 JSON 对象');
  const evidence = walk(input, 0) as VisionJsonObject;
  if (Buffer.byteLength(JSON.stringify(evidence)) > maxBytes) fail('invalid_input', '板端证据超过本次字节预算');
  return evidence;
}

export function imageDimensions(data: Buffer, mimeType: unknown): { width: number; height: number } {
  if (mimeType === 'image/png') {
    if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('invalid_image', '文件不是 PNG 图像');
    let offset = 8; let dimensions: { width: number; height: number } | undefined; let hasData = false; let ended = false;
    let depth = 0; let color = 0; let interlace = 0; let palette = false; let chunks = 0; const compressed: Buffer[] = [];
    while (offset + 12 <= data.length) {
      if (++chunks > 20_000) fail('invalid_image', 'PNG 块数量超过上限');
      const length = data.readUInt32BE(offset); const end = offset + 12 + length;
      if (end > data.length) fail('invalid_image', 'PNG 数据被截断');
      const kind = data.toString('ascii', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(kind)) fail('invalid_image', 'PNG 块类型无效');
      let crc = 0xffffffff;
      for (let index = offset + 4; index < end - 4; index += 1) crc = pngCrcTable[(crc ^ data[index]!) & 255]! ^ crc >>> 8;
      if (((crc ^ 0xffffffff) >>> 0) !== data.readUInt32BE(end - 4)) fail('invalid_image', 'PNG 块校验失败');
      if (offset === 8 && (kind !== 'IHDR' || length !== 13)) fail('invalid_image', 'PNG 缺少有效 IHDR');
      if (kind === 'IHDR') {
        if (dimensions || length !== 13) fail('invalid_image', 'PNG IHDR 无效');
        dimensions = { width: data.readUInt32BE(offset + 8), height: data.readUInt32BE(offset + 12) };
        depth = data[offset + 16]!; color = data[offset + 17]!; interlace = data[offset + 20]!;
        const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!allowedDepths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || ![0, 1].includes(interlace)) fail('invalid_image', 'PNG 像素格式无效');
      }
      if (kind === 'PLTE') { if (palette || hasData || !length || length % 3 || length > 768) fail('invalid_image', 'PNG 色板无效'); palette = true; }
      if (kind === 'IDAT') { if (length > 0) hasData = true; compressed.push(data.subarray(offset + 8, end - 4)); }
      if (kind === 'IEND') { if (length !== 0 || end !== data.length) fail('invalid_image', 'PNG 结束块无效'); ended = true; break; }
      if (!['IHDR', 'PLTE', 'IDAT'].includes(kind) && kind[0] === kind[0]?.toUpperCase()) fail('invalid_image', 'PNG 包含未知关键块');
      offset = end;
    }
    if (!dimensions || !dimensions.width || !dimensions.height || !hasData || !ended) fail('invalid_image', 'PNG 图像内容不完整');
    if (dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 32 * MIB || (color === 3 && !palette)) fail('invalid_image', 'PNG 尺寸或色板无效');
    const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
      const width = Math.max(0, Math.ceil((dimensions!.width - x!) / dx!)); const height = Math.max(0, Math.ceil((dimensions!.height - y!) / dy!));
      return { height: width ? height : 0, stride: 1 + Math.ceil(width * channels[color]! * depth / 8) };
    });
    const expected = rows.reduce((sum, row) => sum + row.height * row.stride, 0);
    if (expected > 128 * MIB) fail('invalid_image', 'PNG 解码大小超过上限');
    let inflated: Buffer;
    try { inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); } catch { return fail('invalid_image', 'PNG 像素压缩数据无效'); }
    if (inflated.length !== expected) fail('invalid_image', 'PNG 像素字节数无效');
    let rowOffset = 0;
    for (const row of rows) for (let index = 0; index < row.height; index += 1) { if (inflated[rowOffset]! > 4) fail('invalid_image', 'PNG 行过滤器无效'); rowOffset += row.stride; }
    return dimensions;
  }
  if (mimeType === 'image/jpeg') {
    if (data.length < 12 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) fail('invalid_image', '文件不是完整 JPEG 图像');
    let offset = 2; let dimensions: { width: number; height: number } | undefined;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) fail('invalid_image', 'JPEG 标记无效');
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xda) { if (!dimensions || offset + 2 > data.length) fail('invalid_image', 'JPEG 扫描数据缺少尺寸'); const length = data.readUInt16BE(offset); if (length < 6 || offset + length >= data.length - 2) fail('invalid_image', 'JPEG 扫描数据被截断'); return dimensions; }
      if (marker === 0xd9 || marker === 0x00 || marker === 0xd8) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) fail('invalid_image', 'JPEG 数据被截断');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (dimensions || length < 8) fail('invalid_image', 'JPEG 尺寸块无效');
        dimensions = { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
        if (!dimensions.width || !dimensions.height) fail('invalid_image', 'JPEG 尺寸无效');
      }
      offset += length;
    }
    fail('invalid_image', 'JPEG 缺少有效图像扫描数据');
  }
  return fail('invalid_image', '只接受 PNG 或 JPEG 图像');
}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
