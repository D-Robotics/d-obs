import { VISION_CALIBRATION_OPERATIONS } from './vision-workshop-calibration-operations.js';
export { VISION_CALIBRATION_OPERATIONS } from './vision-workshop-calibration-operations.js';
/** Owned CPU calibration jobs. This module never executes an ISP/device write. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import type { McpTool } from '../observability/agent-mcp.js';
import { requireVisionWorkshopAccess, visionWorkshopOwner } from './vision-workshop-access.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { executePlatformOperation, registerPlatformOperations } from './platform-operations.js';
import type { PlatformOperationMetadata } from './platform-operation-metadata.js';
import { VISION_WORKSHOP_API } from './vision-workshop-operations.js';
import { VisionWorkshopError, type VisionExperiment, type VisionRawMetadata, type VisionWorkshopService } from './vision-workshop-service.js';
import type { VisionDeviceRegistry } from './vision-workshop-device.js';

export const VISION_CALIBRATION_CONTRACT = 'rdk.vision-calibration.v1';
export const VISION_CALIBRATION_API = VISION_WORKSHOP_API + '/experiments/:id/calibration';
const TASK_SCHEMA = 'rdk.x5-calibration-task.v1';
const RESULT_SCHEMA = 'rdk.x5-calibration-result.v1';
const MIB = 1024 * 1024;
const MAX_JSON = MIB;
const MAX_OUTPUT = 2 * MIB;
const MAX_STATE = 8 * MIB;
const MAX_DATASET = 256 * MIB;
// Only reviewed static algorithm codes can cross the subprocess boundary.
const ALGORITHM_ERRORS = new Set([
  'artifact_bytes_required', 'artifact_or_dataset_id_invalid', 'artifact_reference_invalid', 'at_least_three_frames_required',
  'awb_conflicting_temperature_labels', 'awb_explicit_gray_card_roi_required', 'awb_gains_invalid_or_unstable', 'awb_gray_card_low_signal_or_texture', 'awb_gray_card_saturated', 'awb_green_channels_inconsistent', 'awb_multiple_recorded_illuminants_required',
  'blocked_light_dark_capture_required', 'ccm_duplicate_patch', 'ccm_explicit_reference_illumination_required', 'ccm_explicit_split_required', 'ccm_invalid_or_saturated_rgb', 'ccm_overlapping_patch_rois', 'ccm_rank_or_condition_invalid', 'ccm_recorded_linear_chart_required', 'ccm_reference_encoding_required', 'ccm_roi_outside_image', 'ccm_training_and_heldout_required', 'ccm_training_or_heldout_residual_exceeded',
  'dark_sample_light_leak_saturation_or_drift', 'dataset_byte_limit', 'dataset_or_file_invalid', 'dependency_numpy_missing', 'duplicate_artifact_reference',
  'flat_field_gain_limit', 'flat_field_grid_under_sampled', 'flat_field_low_signal_or_texture', 'flat_field_saturated', 'flat_field_temporally_unstable', 'four_channel_black_levels_required',
  'illumination_measurements_invalid', 'illumination_nonuniform', 'independent_uniform_illumination_evidence_required', 'input_hash_mismatch', 'input_hash_required', 'invalid_integer', 'invalid_number',
  'local_artifact_map_invalid', 'local_artifact_missing', 'measurement_json_invalid', 'mixed_capture_modes_or_exposure', 'mixed_flat_field_illuminants', 'nonfinite_json', 'one_ccm_measurement_artifact_required',
  'raw_exact_byte_count_required', 'raw_layout_invalid', 'raw_metadata_invalid', 'raw_packing_invalid', 'raw_pixel_exceeds_bit_depth', 'recorded_capture_conditions_required', 'recorded_roi_required', 'reference_rgb_invalid', 'roi_bounds_or_bayer_alignment_invalid', 'task_manifest_invalid', 'task_manifest_limit', 'task_operation_or_inputs_invalid',
].map(code => 'calibration_' + code));
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const finite = z.number().finite();
const roi = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict();
const captureSchema = z.object({
  target: z.enum(['lens_covered_dark', 'neutral_uniform_flat_field', 'neutral_gray_card']),
  source: z.enum(['recorded-camera-artifact', 'synthetic-fixture']),
  preprocessing: z.literal('sensor_raw_unprocessed'), sensorMode: label,
  exposureUs: finite.min(1).max(60_000_000), analogGain: finite.min(.0001).max(65_536),
  lightBlocked: z.boolean().optional(), illuminantId: label.optional(), colorTemperatureK: finite.min(1000).max(25000).optional(), roi: roi.optional(),
  illuminationUniformity: z.object({ method: z.literal('independent_meter_grid'), luxSamples: z.array(finite.positive()).min(5).max(256) }).strict().optional(),
}).strict();
const blackLevels = z.object({ R: finite.min(0).max(65534), Gr: finite.min(0).max(65534), Gb: finite.min(0).max(65534), B: finite.min(0).max(65534) }).strict();
const optionsSchema = z.object({
  blackLevels: blackLevels.optional(), grid: z.object({ rows: z.number().int().min(2).max(33), cols: z.number().int().min(2).max(33) }).strict().optional(),
  maxDarkFraction: finite.min(.001).max(.5).optional(), maxFrameDriftCodes: finite.min(0).max(65535).optional(),
  maxIlluminationRelativeSpread: finite.min(.001).max(.5).optional(), maxGain: finite.min(1).max(32).optional(),
  maxCellRelativeMad: finite.min(.001).max(.5).optional(), maxFrameRelativeSpread: finite.min(.001).max(.5).optional(),
  maxCondition: finite.min(1).max(10000).optional(), maxRmse: finite.min(.000001).max(.5).optional(),
}).strict();
const inputSchema = z.object({ sampleId: uuid.optional(), artifactId: uuid.optional(), capture: captureSchema.optional() }).strict()
  .refine(row => Boolean(row.sampleId) !== Boolean(row.artifactId), 'Supply exactly one owned artifact/sample ID');
const taskInput = z.object({ operation: z.enum(['blc', 'lsc', 'ccm', 'awb']), inputs: z.array(inputSchema).min(1).max(32), options: optionsSchema.optional() }).strict();
const measurementSchema = z.object({
  target: z.literal('recorded_color_chart'), measurementSpace: z.literal('camera-linear-rgb'), preprocessing: z.string().trim().min(1).max(300),
  referenceEncoding: z.enum(['srgb', 'linear-srgb']), referenceWhitePoint: z.literal('D65'), referenceIlluminantId: label,
  imageWidth: z.number().int().min(2).max(8192), imageHeight: z.number().int().min(2).max(8192),
  illuminant: z.object({ id: label, colorTemperatureK: finite.min(1000).max(25000), source: z.enum(['recorded-camera-artifact', 'synthetic-fixture']) }).strict(),
  patches: z.array(z.object({ patchId: label, sourceArtifactId: uuid, roi, measuredLinearRgb: z.tuple([finite.min(0).lt(.995), finite.min(0).lt(.995), finite.min(0).lt(.995)]), referenceRgb: z.tuple([finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1)]), split: z.enum(['train', 'heldout']) }).strict()).min(9).max(256),
}).strict();
const assetInput = z.object({ measurement: measurementSchema }).strict();
type Capture = z.infer<typeof captureSchema>;
type TaskInput = z.infer<typeof taskInput>;
export type VisionCalibrationInput = { artifactId: string; sha256: string; bytes: number; kind: 'raw-sample' | 'measurement'; metadata?: VisionRawMetadata; capture?: Capture; source: string };
export type VisionCalibrationAsset = { id: string; kind: 'ccm-measurement'; sha256: string; bytes: number; createdAt: string; source: 'recorded-measurements'; verification: 'unverified'; sourceArtifacts: Array<{ id: string; sha256: string; kind: string }> };
export type VisionCalibrationResult = {
  schema: typeof RESULT_SCHEMA; datasetId: string; operation: TaskInput['operation']; executor: 'cpu-offline-numpy'; format: 'sdk-neutral-calibration-values-v1'; status: 'computed';
  hardwareVerification: 'unverified'; qualityVerification: 'unverified'; taskManifestSha256: string; outputSha256: string;
  inputArtifacts: Array<{ artifactId: string; sha256: string; bytes: number }>;
  parameters: { method: string; values: unknown; constraints: string[]; [key: string]: unknown }; provenanceLimitation: string;
};
export type VisionCalibrationTask = {
  id: string; operation: TaskInput['operation']; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  inputs: VisionCalibrationInput[]; options: z.infer<typeof optionsSchema>; createdAt: string; updatedAt: string;
  attempt: number; hardwareVerification: 'unverified'; qualityVerification: 'unverified';
  result?: { sha256: string; outputSha256: string; bytes: number }; error?: string;
  execution?: { executor: 'cpu-offline-numpy'; exitCode: number | null; termination?: 'timeout' | 'output_limit' | 'process_error' }; submittedManifestSha256?: string;
};
type StoredTask = VisionCalibrationTask & { coordinatorPid?: number };
type Store = { schema: typeof VISION_CALIBRATION_CONTRACT; assets: VisionCalibrationAsset[]; tasks: StoredTask[] };
export type VisionCalibrationOptions = {
  service: () => VisionWorkshopService; devices: () => VisionDeviceRegistry; requestDevices?: (request: Request) => VisionDeviceRegistry;
  /** Trusted server configuration only; never read from request arguments. */
  stateDir?: string; scriptPath?: string; pythonExecutable?: string; timeoutMs?: number;
};
const locks = new Map<string, Promise<void>>();
const activeJobs = new Set<string>();
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function fail(code: string, status = 400): never { throw new VisionWorkshopError('vision_calibration_' + code, 'Calibration request or evidence is unavailable', status); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function boundedJson(value: unknown, max = MAX_JSON): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > max) fail('json_limit', 413);
  return bytes;
}
async function readBounded(filename: string, max: number): Promise<Buffer> {
  const descriptor = await open(filename, 'r');
  try {
    const info = await descriptor.stat(); if (!info.isFile() || info.size > max) fail('asset_limit', 413);
    const bytes = Buffer.alloc(info.size + 1); let total = 0;
    while (total < bytes.length) { const { bytesRead } = await descriptor.read(bytes, total, bytes.length - total, total); if (!bytesRead) break; total += bytesRead; }
    if (total !== info.size) fail('asset_changed', 409);
    return bytes.subarray(0, total);
  } finally { await descriptor.close(); }
}
async function atomicFile(filename: string, bytes: Buffer): Promise<void> {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const descriptor = await open(temporary, 'wx', 0o600);
  try { await descriptor.writeFile(bytes); await descriptor.sync(); } finally { await descriptor.close(); }
  try { await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
}
function visible(task: StoredTask): VisionCalibrationTask { const { coordinatorPid: _private, ...output } = task; return structuredClone(output); }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
/** Preserve Python's exact float/Unicode bytes when removing the self-hash field. */
function verifyOutputHash(bytes: Buffer, expected: string): void {
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes) || text[0] !== '{' || text.at(-1) !== '}') fail('output_hash_invalid', 502);
  const parts: string[] = []; let begin = 1; let depth = 0; let quoted = false; let escaped = false;
  for (let index = 1; index < text.length - 1; index++) {
    const character = text[index];
    if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
    else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) { parts.push(text.slice(begin, index)); begin = index + 1; }
  }
  parts.push(text.slice(begin, -1)); const retained: string[] = []; let hashes = 0;
  for (const part of parts) {
    const property: unknown = JSON.parse('{' + part + '}'); if (!isRecord(property) || Object.keys(property).length !== 1) fail('output_hash_invalid', 502);
    if (Object.hasOwn(property, 'outputSha256')) { if (property.outputSha256 !== expected) fail('output_hash_invalid', 502); hashes++; }
    else retained.push(part);
  }
  if (hashes !== 1 || sha('{' + retained.join(',') + '}') !== expected) fail('output_hash_invalid', 502);
}

export class VisionCalibrationService {
  private readonly scriptPath: string;
  private readonly python: string;
  private readonly timeout: number;
  constructor(private readonly config: VisionCalibrationOptions) {
    const moduleRoot = fileURLToPath(new URL('../../', import.meta.url));
    const packageRoot = path.basename(moduleRoot) === 'dist' ? path.dirname(moduleRoot) : moduleRoot;
    this.scriptPath = path.resolve(config.scriptPath ?? process.env.RDK_VISION_CALIBRATION_SCRIPT_PATH ?? path.join(packageRoot, 'tools', 'vision-x5-calibration.py'));
    this.python = config.pythonExecutable ?? process.env.RDK_VISION_CALIBRATION_PYTHON ?? 'python3';
    this.timeout = config.timeoutMs ?? 120_000;
    if (!this.python || /[\x00-\x1f\x7f]/.test(this.python) || !Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 120_000) fail('server_config_invalid', 503);
  }
  private async directory(owner: string, experimentId: string): Promise<{ directory: string; experiment: VisionExperiment }> {
    // Authorize before creating directories, resolving assets or starting Python.
    const experiment = await this.config.service().getExperiment(owner, uuid.parse(experimentId));
    const root = path.resolve(this.config.stateDir ?? path.join(this.config.service().dataDir, 'calibration'));
    const directory = path.join(root, sha(owner), experiment.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { directory, experiment };
  }
  private async lockOwner(filename: string): Promise<{ pid: number; token: string } | null> {
    try {
      const owner: unknown = JSON.parse((await readBounded(filename, 256)).toString());
      if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || Number(owner.pid) > 2147483647 || !uuid.safeParse(owner.token).success) fail('lock_corrupt', 503);
      return owner as { pid: number; token: string };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async claim(filename: string): Promise<(() => Promise<void>) | null> {
    const token = randomUUID(); const temporary = filename + '.claim-' + token;
    try {
      await atomicFile(temporary, Buffer.from(JSON.stringify({ pid: process.pid, token })));
      // Publish the entire immutable owner at once, never a half-written PID.
      try { await link(temporary, filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
      return async () => { const current = await this.lockOwner(filename); if (current?.pid === process.pid && current.token === token) await rm(filename, { force: true }); };
    } finally { await rm(temporary, { force: true }); }
  }
  private async reclaim(filename: string, depth = 0): Promise<boolean> {
    const owner = await this.lockOwner(filename); if (!owner) return true; if (processAlive(owner.pid)) return false;
    if (depth >= 3) fail('lock_recovery_required', 503);
    const guard = filename + '.recover-' + owner.token;
    let release = await this.claim(guard);
    if (!release) { if (!await this.reclaim(guard, depth + 1)) return false; release = await this.claim(guard); if (!release) return false; }
    try {
      const current = await this.lockOwner(filename); if (!current) return true;
      if (current.pid !== owner.pid || current.token !== owner.token || processAlive(current.pid)) return false;
      await rm(filename, { force: true }); return true;
    } finally { await release(); }
  }
  private async lease(directory: string): Promise<() => Promise<void>> {
    const filename = path.join(directory, 'ledger.lock'); let release = await this.claim(filename);
    if (!release) { if (!await this.reclaim(filename)) fail('busy', 429); release = await this.claim(filename); }
    if (!release) fail('busy', 429); return release;
  }
  private async transaction<T>(owner: string, experimentId: string, fn: (store: Store, directory: string, experiment: VisionExperiment) => Promise<T>): Promise<T> {
    const { directory, experiment } = await this.directory(owner, experimentId);
    const previous = locks.get(directory) ?? Promise.resolve();
    let release!: () => void; const pending = new Promise<void>(done => { release = done; });
    const tail = previous.then(() => pending); locks.set(directory, tail); await previous;
    // A disk lease prevents two server processes from changing this ledger at once.
    let releaseLease: (() => Promise<void>) | undefined;
    try {
      releaseLease = await this.lease(directory);
      let store: Store;
      try {
        const parsed: unknown = JSON.parse((await readBounded(path.join(directory, 'ledger.json'), MAX_STATE)).toString());
        if (!isRecord(parsed) || parsed.schema !== VISION_CALIBRATION_CONTRACT || !Array.isArray(parsed.assets) || !Array.isArray(parsed.tasks) || parsed.assets.length > 64 || parsed.tasks.length > 128) fail('state_corrupt', 503);
        store = parsed as Store;
        for (const asset of store.assets) if (!uuid.safeParse(asset.id).success || !digest.safeParse(asset.sha256).success || asset.kind !== 'ccm-measurement' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_JSON) fail('state_corrupt', 503);
        for (const task of store.tasks) {
          if (!uuid.safeParse(task.id).success || !['blc', 'lsc', 'ccm', 'awb'].includes(task.operation) || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(task.status) || !Array.isArray(task.inputs) || task.inputs.length > 32 || task.inputs.some(input => !uuid.safeParse(input.artifactId).success || !digest.safeParse(input.sha256).success || !['raw-sample', 'measurement'].includes(input.kind))) fail('state_corrupt', 503);
          if (task.result && (!digest.safeParse(task.result.sha256).success || !digest.safeParse(task.result.outputSha256).success || !Number.isSafeInteger(task.result.bytes) || task.result.bytes > MAX_OUTPUT)) fail('state_corrupt', 503);
          if (task.status === 'running' && !activeJobs.has(path.join(directory, task.id)) && (!Number.isSafeInteger(task.coordinatorPid) || task.coordinatorPid === process.pid || !processAlive(task.coordinatorPid!))) {
            task.status = 'interrupted'; task.error = 'vision_calibration_process_interrupted'; task.updatedAt = new Date().toISOString(); delete task.coordinatorPid;
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') store = { schema: VISION_CALIBRATION_CONTRACT, assets: [], tasks: [] }; else throw error; }
      const result = await fn(store, directory, experiment);
      await atomicFile(path.join(directory, 'ledger.json'), boundedJson(store, MAX_STATE));
      return result;
    } finally {
      try { await releaseLease?.(); } finally { release(); if (locks.get(directory) === tail) locks.delete(directory); }
    }
  }
  private task(store: Store, taskId: string): StoredTask { const task = store.tasks.find(row => row.id === uuid.parse(taskId)); if (!task) fail('task_not_found', 404); return task; }
  private async raw(owner: string, experimentId: string, sampleId: string) {
    const stored = await this.config.service().readRawSample(owner, experimentId, sampleId);
    return { data: stored.data, input: { artifactId: stored.sample.id, sha256: stored.sample.hash, bytes: stored.data.length, kind: 'raw-sample' as const, metadata: stored.sample.metadata, source: stored.sample.source } };
  }
  async importAsset(owner: string, experimentId: string, input: unknown): Promise<VisionCalibrationAsset> {
    const { measurement } = assetInput.parse(input); const bytes = boundedJson(measurement);
    return this.transaction(owner, experimentId, async (store, directory, experiment) => {
      if (store.assets.length >= 64) fail('asset_quota', 409);
      const sourceArtifacts: VisionCalibrationAsset['sourceArtifacts'] = [];
      for (const sourceId of new Set(measurement.patches.map(patch => patch.sourceArtifactId))) {
        const sample = experiment.samples.find(row => row.id === sourceId);
        const frame = experiment.cameraFrames.find(row => row.id === sourceId);
        if (!sample && !frame) fail('source_artifact_not_found', 404);
        if ((sample?.metadata.width ?? frame!.width) !== measurement.imageWidth || (sample?.metadata.height ?? frame!.height) !== measurement.imageHeight) fail('measurement_dimensions_mismatch');
        if (sample) await this.config.service().readRawSample(owner, experimentId, sample.id);
        else await this.config.service().readCameraFrame(owner, experimentId, frame!.id);
        sourceArtifacts.push({ id: sourceId, sha256: sample?.hash ?? frame!.hash, kind: sample ? 'raw-sample' : 'camera-frame' });
      }
      for (const patch of measurement.patches) if (patch.roi.x + patch.roi.width > measurement.imageWidth || patch.roi.y + patch.roi.height > measurement.imageHeight) fail('measurement_roi_invalid');
      const asset: VisionCalibrationAsset = { id: randomUUID(), kind: 'ccm-measurement', sha256: sha(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), source: 'recorded-measurements', verification: 'unverified', sourceArtifacts };
      await atomicFile(path.join(directory, asset.id + '.measurement.json'), bytes); store.assets.push(asset); return structuredClone(asset);
    });
  }
  async listAssets(owner: string, experimentId: string): Promise<VisionCalibrationAsset[]> { return this.transaction(owner, experimentId, async store => structuredClone(store.assets)); }
  async createTask(owner: string, experimentId: string, input: unknown): Promise<VisionCalibrationTask> {
    const request = taskInput.parse(input);
    if (request.operation === 'ccm' ? request.inputs.length !== 1 || !request.inputs[0].artifactId || request.inputs[0].capture : request.inputs.some(row => !row.sampleId || !row.capture)) fail('input_kind_mismatch');
    const allowedOptions: Record<TaskInput['operation'], string[]> = { blc: ['maxDarkFraction', 'maxFrameDriftCodes'], lsc: ['blackLevels', 'grid', 'maxIlluminationRelativeSpread', 'maxGain', 'maxCellRelativeMad', 'maxFrameRelativeSpread'], ccm: ['maxCondition', 'maxRmse'], awb: ['blackLevels', 'maxGain'] };
    if (Object.keys(request.options ?? {}).some(key => !allowedOptions[request.operation].includes(key))) fail('option_mismatch');
    if (['lsc', 'awb'].includes(request.operation) && !request.options?.blackLevels || request.operation === 'lsc' && !request.options?.grid) fail('black_levels_or_grid_required');
    return this.transaction(owner, experimentId, async (store, directory) => {
      if (store.tasks.length >= 128) fail('task_quota', 409);
      const inputs: VisionCalibrationInput[] = [];
      for (const row of request.inputs) {
        if (row.sampleId) {
          const stored = await this.raw(owner, experimentId, row.sampleId);
          if (stored.input.metadata!.exposureUs !== undefined && stored.input.metadata!.exposureUs !== row.capture!.exposureUs || stored.input.metadata!.gain !== undefined && stored.input.metadata!.gain !== row.capture!.analogGain) fail('capture_metadata_conflict');
          inputs.push({ ...stored.input, capture: row.capture });
        } else {
          const asset = store.assets.find(asset => asset.id === row.artifactId); if (!asset) fail('asset_not_found', 404);
          const bytes = await readBounded(path.join(directory, asset.id + '.measurement.json'), MAX_JSON);
          if (sha(bytes) !== asset.sha256 || bytes.length !== asset.bytes) fail('asset_corrupt', 503);
          inputs.push({ artifactId: asset.id, sha256: asset.sha256, bytes: asset.bytes, kind: 'measurement', source: asset.source });
        }
      }
      if (new Set(inputs.map(row => row.artifactId)).size !== inputs.length) fail('duplicate_input');
      if (inputs.reduce((total, row) => total + row.bytes, 0) > MAX_DATASET) fail('dataset_limit', 413);
      const now = new Date().toISOString();
      const task: StoredTask = { id: randomUUID(), operation: request.operation, status: 'queued', inputs, options: request.options ?? {}, createdAt: now, updatedAt: now, attempt: 0, hardwareVerification: 'unverified', qualityVerification: 'unverified' };
      store.tasks.push(task); return visible(task);
    });
  }
  async listTasks(owner: string, experimentId: string): Promise<VisionCalibrationTask[]> { return this.transaction(owner, experimentId, async store => store.tasks.map(visible)); }
  async getTask(owner: string, experimentId: string, taskId: string): Promise<VisionCalibrationTask> { return this.transaction(owner, experimentId, async store => visible(this.task(store, taskId))); }
  private async result(store: Store, directory: string, taskId: string): Promise<{ task: StoredTask; result: VisionCalibrationResult; bytes: Buffer }> {
    const task = this.task(store, taskId); if (task.status !== 'completed' || !task.result) fail('result_not_available', 409);
    if (!task.submittedManifestSha256 || sha(await readBounded(path.join(directory, task.id + '.manifest.json'), MAX_JSON)) !== task.submittedManifestSha256) fail('manifest_corrupt', 503);
    const bytes = await readBounded(path.join(directory, task.id + '.result.json'), MAX_OUTPUT);
    if (bytes.length !== task.result.bytes || sha(bytes) !== task.result.sha256) fail('result_corrupt', 503);
    const result = this.validateResult(JSON.parse(bytes.toString()), task);
    verifyOutputHash(bytes, result.outputSha256);
    if (result.outputSha256 !== task.result.outputSha256) fail('result_corrupt', 503);
    return { task, result, bytes };
  }
  async getResult(owner: string, experimentId: string, taskId: string): Promise<VisionCalibrationResult> { return this.transaction(owner, experimentId, async (store, directory) => (await this.result(store, directory, taskId)).result); }
  /** Public owned evidence only; completed results pass the same byte/hash check as REST. */
  async exportEntries(owner: string, experimentId: string): Promise<Array<{ name: string; data: Buffer }>> {
    return this.transaction(owner, experimentId, async (store, directory) => {
      const tasks = store.tasks.map(visible);
      const entries: Array<{ name: string; data: Buffer }> = [{ name: 'calibration/tasks.json', data: Buffer.from(JSON.stringify({ contract: VISION_CALIBRATION_CONTRACT, hardwareVerification: 'unverified', qualityVerification: 'unverified', tasks }, null, 2)) }];
      for (const task of tasks) if (task.status === 'completed') {
        const taskId = uuid.parse(task.id);
        const { bytes } = await this.result(store, directory, taskId);
        // Preserve the exact bytes whose digest is recorded in tasks.json.
        entries.push({ name: 'calibration/' + taskId + '/result.json', data: bytes });
      }
      return entries;
    });
  }
  private validateResult(value: unknown, task: StoredTask): VisionCalibrationResult {
    if (!isRecord(value) || value.schema !== RESULT_SCHEMA || value.datasetId !== task.id || value.operation !== task.operation || value.executor !== 'cpu-offline-numpy' || value.format !== 'sdk-neutral-calibration-values-v1' || value.status !== 'computed' || value.hardwareVerification !== 'unverified' || value.qualityVerification !== 'unverified' || !digest.safeParse(value.outputSha256).success || !digest.safeParse(value.taskManifestSha256).success || !isRecord(value.parameters) || typeof value.parameters.method !== 'string' || !('values' in value.parameters) || !Array.isArray(value.parameters.constraints) || value.parameters.constraints.some(row => typeof row !== 'string') || !Array.isArray(value.inputArtifacts) || value.inputArtifacts.length !== task.inputs.length || value.inputArtifacts.some((row, index) => !isRecord(row) || row.artifactId !== task.inputs[index].artifactId || row.sha256 !== task.inputs[index].sha256 || row.bytes !== task.inputs[index].bytes) || typeof value.provenanceLimitation !== 'string') fail('output_contract_invalid', 502);
    return value as VisionCalibrationResult;
  }
  private async subprocess(manifest: string, mapping: string, output: string): Promise<{ summary: Record<string, unknown>; exitCode: number | null; termination?: 'timeout' | 'output_limit' | 'process_error' }> {
    // Do not pass service credentials, model keys, client commands or PYTHONPATH.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    return new Promise(resolve => {
      const child = spawn(this.python, [this.scriptPath, '--manifest', manifest, '--artifact-map', mapping, '--output', output], { shell: false, cwd: path.dirname(this.scriptPath), env, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let termination: 'timeout' | 'output_limit' | 'process_error' | undefined; let settled = false;
      const kill = () => { child.kill('SIGKILL'); };
      const timer = setTimeout(() => { termination = 'timeout'; kill(); }, this.timeout);
      child.stdout.on('data', (bytes: Buffer) => { stdoutBytes += bytes.length; if (stdoutBytes > 32 * 1024) { termination = 'output_limit'; kill(); } else chunks.push(bytes); });
      // Count stderr for resource limits; never include its text in client errors.
      child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > 32 * 1024) { termination = 'output_limit'; kill(); } });
      const finish = (exitCode: number | null) => {
        if (settled) return; settled = true; clearTimeout(timer);
        let summary: Record<string, unknown> = {};
        try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString()); if (isRecord(parsed)) summary = parsed; } catch { /* static failure below */ }
        resolve({ summary, exitCode, ...(termination ? { termination } : {}) });
      };
      child.on('error', () => { termination = 'process_error'; finish(null); }); child.on('close', finish);
    });
  }
  async runTask(owner: string, experimentId: string, taskId: string): Promise<VisionCalibrationTask> {
    const { directory } = await this.directory(owner, experimentId); const key = path.join(directory, uuid.parse(taskId));
    let reserved = false; let task: StoredTask;
    try { task = await this.transaction(owner, experimentId, async store => {
      const task = this.task(store, taskId);
      if (task.status === 'running' || activeJobs.has(key)) fail('task_busy', 409);
      if (task.status === 'completed') fail('task_already_completed', 409);
      if (activeJobs.size >= 2) fail('capacity_exceeded', 429);
      activeJobs.add(key); reserved = true; task.status = 'running'; task.coordinatorPid = process.pid; task.attempt++; task.updatedAt = new Date().toISOString(); delete task.error; delete task.result; delete task.execution;
      return structuredClone(task);
    }); } catch (error) { if (reserved) activeJobs.delete(key); throw error; }
    const jobDir = path.join(directory, 'job-' + randomUUID());
    let resultBytes: Buffer | undefined; let result: VisionCalibrationResult | undefined; let errorCode: string | undefined;
    let execution: VisionCalibrationTask['execution']; let submittedManifestSha256: string | undefined;
    try {
      await mkdir(jobDir, { mode: 0o700 });
      try { const script = await stat(this.scriptPath); if (!script.isFile()) fail('script_unavailable', 503); }
      catch { fail('script_unavailable', 503); }
      const artifactMap: Record<string, string> = {};
      for (const input of task.inputs) {
        const bytes = input.kind === 'raw-sample' ? (await this.raw(owner, experimentId, input.artifactId)).data : await readBounded(path.join(directory, input.artifactId + '.measurement.json'), MAX_JSON);
        if (bytes.length !== input.bytes || sha(bytes) !== input.sha256) fail('input_hash_changed', 409);
        const filename = path.join(jobDir, input.artifactId + '.input'); await atomicFile(filename, bytes); artifactMap[input.artifactId] = filename;
      }
      const manifest = { schema: TASK_SCHEMA, datasetId: task.id, operation: task.operation, inputs: task.inputs.map(row => ({ artifactId: row.artifactId, sha256: row.sha256, ...(row.metadata ? { metadata: row.metadata } : {}), ...(row.capture ? { capture: row.capture } : {}) })), options: task.options };
      const manifestBytes = boundedJson(manifest); submittedManifestSha256 = sha(manifestBytes);
      const manifestPath = path.join(jobDir, 'task.json'); const mappingPath = path.join(jobDir, 'artifact-map.json'); const outputPath = path.join(jobDir, 'result.json');
      await atomicFile(manifestPath, manifestBytes); await atomicFile(path.join(directory, task.id + '.manifest.json'), manifestBytes); await atomicFile(mappingPath, boundedJson(artifactMap));
      const run = await this.subprocess(manifestPath, mappingPath, outputPath);
      execution = { executor: 'cpu-offline-numpy', exitCode: run.exitCode, ...(run.termination ? { termination: run.termination } : {}) };
      if (run.termination) fail(run.termination === 'process_error' ? 'python_unavailable' : run.termination, 503);
      if (run.exitCode !== 0 || run.summary.ok !== true) {
        const reported = run.summary.error;
        if (typeof reported === 'string' && ALGORITHM_ERRORS.has(reported)) errorCode = 'vision_' + reported;
        else errorCode = 'vision_calibration_process_failed';
      } else {
        resultBytes = await readBounded(outputPath, MAX_OUTPUT); result = this.validateResult(JSON.parse(resultBytes.toString()), task);
        verifyOutputHash(resultBytes, result.outputSha256);
        if (run.summary.submittedManifestSha256 !== submittedManifestSha256 || run.summary.outputSha256 !== result.outputSha256 || run.summary.operation !== task.operation || run.summary.hardwareVerification !== 'unverified' || run.summary.qualityVerification !== 'unverified') fail('output_contract_invalid', 502);
      }
    } catch (error) { errorCode = error instanceof VisionWorkshopError ? error.code : 'vision_calibration_process_failed'; }
    try {
      return await this.transaction(owner, experimentId, async (store, directory) => {
        const current = this.task(store, taskId); delete current.coordinatorPid; current.updatedAt = new Date().toISOString();
        if (execution) current.execution = execution; if (submittedManifestSha256) current.submittedManifestSha256 = submittedManifestSha256;
        if (errorCode || !resultBytes || !result) { current.status = 'failed'; current.error = errorCode ?? 'vision_calibration_output_missing'; delete current.result; }
        else {
          await atomicFile(path.join(directory, current.id + '.result.json'), resultBytes);
          current.status = 'completed'; current.result = { sha256: sha(resultBytes), outputSha256: result.outputSha256, bytes: resultBytes.length }; delete current.error;
        }
        return visible(current);
      });
    } finally { activeJobs.delete(key); await rm(jobDir, { recursive: true, force: true }); }
  }
  async getApplyPlan(owner: string, experimentId: string, taskId: string, registry?: VisionDeviceRegistry): Promise<Record<string, unknown>> {
    return this.transaction(owner, experimentId, async (store, directory, experiment) => {
      const { task, result } = await this.result(store, directory, taskId);
      const profile = (registry ?? this.config.devices()).list().find(row => row.id === experiment.targetId);
      const fields = ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const;
      const matching = !!profile && fields.every(field => profile[field] === experiment[field]);
      const mappingConfigured = matching && profile!.operations.includes('calibration_apply');
      return {
        contract: VISION_CALIBRATION_CONTRACT, taskId: task.id, experimentId, operation: task.operation,
        status: mappingConfigured ? 'mapping_requires_runtime_qualification' : 'sdk_mapping_required', mappingAvailability: mappingConfigured ? 'configured-adapter' : 'unavailable', writesDevice: false, hardwareVerification: 'unverified', qualityVerification: 'unverified',
        target: { ...(experiment.targetId ? { id: experiment.targetId } : {}), ...Object.fromEntries(fields.filter(field => experiment[field] !== undefined).map(field => [field, experiment[field]])), adapterStatus: matching ? 'configured-identity-match' : profile ? 'identity-mismatch' : 'unconfigured' },
        lineage: { inputs: task.inputs, submittedManifestSha256: task.submittedManifestSha256, algorithmManifestSha256: result.taskManifestSha256, resultFileSha256: task.result!.sha256, calibrationOutputSha256: result.outputSha256 },
        calibration: { format: result.format, method: result.parameters.method, values: result.parameters.values, parameters: result.parameters },
        prerequisites: ['Use a matched SDK mapper with explicit channel order, units, coefficient ranges and quantization.', 'Bind BLC to the matching effect library; do not invent a native BLC setter.', 'Capture a complete original ISP snapshot; apply and independently read back the supported full snapshot before accepting a write.', 'Measure held-out real camera images before claiming calibration or image-quality verification.'],
      };
    });
  }
}

function routeFailure(res: Response, error: unknown): void {
  if (error instanceof VisionWorkshopError) { res.status(error.status).json({ ok: false, error: error.code }); return; }
  if (error instanceof ZodError) { res.status(400).json({ ok: false, error: 'vision_calibration_invalid_request' }); return; }
  res.status(503).json({ ok: false, error: 'vision_calibration_unavailable' });
}
export function registerVisionCalibrationRoutes(router: Router, options: VisionCalibrationOptions): VisionCalibrationService {
  const calibration = new VisionCalibrationService(options);
  const get = (suffix: string, fn: (owner: string, experimentId: string, req: Request) => Promise<unknown>) => router.get(VISION_CALIBRATION_API + suffix, requireVisionWorkshopAccess, async (req, res) => { try { z.object({}).strict().parse(req.query); res.json({ ok: true, ...(await fn(visionWorkshopOwner(req), String(req.params.id), req) as object) }); } catch (error) { routeFailure(res, error); } });
  const post = (suffix: string, fn: (owner: string, experimentId: string, req: Request) => Promise<unknown>, status = 200) => router.post(VISION_CALIBRATION_API + suffix, requireVisionWorkshopAccess, requireOpsMutationGuard,
    (req, res, next) => { if (req.header('x-rdk-ops-read-only') === '1') res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); else next(); },
    async (req, res) => { try { res.status(status).json({ ok: true, ...(await fn(visionWorkshopOwner(req), String(req.params.id), req) as object) }); } catch (error) { routeFailure(res, error); } });
  post('/assets', async (owner, exp, req) => ({ asset: await calibration.importAsset(owner, exp, req.body) }), 201);
  get('/assets', async (owner, exp) => ({ assets: await calibration.listAssets(owner, exp) }));
  post('/tasks', async (owner, exp, req) => ({ task: await calibration.createTask(owner, exp, req.body) }), 201);
  get('/tasks', async (owner, exp) => ({ tasks: await calibration.listTasks(owner, exp) }));
  get('/tasks/:taskId', async (owner, exp, req) => ({ task: await calibration.getTask(owner, exp, String(req.params.taskId)) }));
  post('/tasks/:taskId/run', async (owner, exp, req) => {
    z.object({}).strict().parse(req.body ?? {}); const task = await calibration.runTask(owner, exp, String(req.params.taskId));
    if (task.status !== 'completed') throw new VisionWorkshopError(task.error ?? 'vision_calibration_failed', 'Offline calibration failed; inspect the persisted task', task.error === 'vision_calibration_dependency_numpy_missing' ? 503 : 422);
    return { task };
  });
  get('/tasks/:taskId/result', async (owner, exp, req) => ({ result: await calibration.getResult(owner, exp, String(req.params.taskId)) }));
  get('/tasks/:taskId/apply-plan', async (owner, exp, req) => ({ plan: await calibration.getApplyPlan(owner, exp, String(req.params.taskId), options.requestDevices?.(req)) }));
  registerPlatformOperations(router, VISION_CALIBRATION_OPERATIONS); return calibration;
}

export function buildVisionCalibrationMcpTools(router: Router, req: Request, res: Response): McpTool[] {
  const exp = { experimentId: uuid }; const prop = { type: 'string', format: 'uuid' };
  const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const text = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
  const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
  const rect = object({ x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } });
  const capture = object({
    target: { type: 'string', enum: ['lens_covered_dark', 'neutral_uniform_flat_field', 'neutral_gray_card'] },
    source: { type: 'string', enum: ['recorded-camera-artifact', 'synthetic-fixture'], description: 'Recorded provenance label; synthetic fixtures cannot prove hardware calibration.' },
    preprocessing: { const: 'sensor_raw_unprocessed', type: 'string' }, sensorMode: text,
    exposureUs: number(1, 60_000_000), analogGain: number(.0001, 65_536), lightBlocked: { type: 'boolean' }, illuminantId: text, colorTemperatureK: number(1000, 25000), roi: rect,
    illuminationUniformity: object({ method: { type: 'string', const: 'independent_meter_grid' }, luxSamples: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 5, maxItems: 256 } }),
  }, ['target', 'source', 'preprocessing', 'sensorMode', 'exposureUs', 'analogGain']);
  const measurement = object({
    target: { type: 'string', const: 'recorded_color_chart' }, measurementSpace: { type: 'string', const: 'camera-linear-rgb' }, preprocessing: { type: 'string', minLength: 1, maxLength: 300 },
    referenceEncoding: { type: 'string', enum: ['srgb', 'linear-srgb'] }, referenceWhitePoint: { type: 'string', const: 'D65' }, referenceIlluminantId: text,
    imageWidth: { type: 'integer', minimum: 2, maximum: 8192 }, imageHeight: { type: 'integer', minimum: 2, maximum: 8192 },
    illuminant: object({ id: text, colorTemperatureK: number(1000, 25000), source: { type: 'string', enum: ['recorded-camera-artifact', 'synthetic-fixture'] } }),
    patches: { type: 'array', minItems: 9, maxItems: 256, items: object({ patchId: text, sourceArtifactId: prop, roi: rect, measuredLinearRgb: { type: 'array', items: { type: 'number', minimum: 0, exclusiveMaximum: .995 }, minItems: 3, maxItems: 3 }, referenceRgb: { type: 'array', items: number(0, 1), minItems: 3, maxItems: 3 }, split: { type: 'string', enum: ['train', 'heldout'] } }) },
  });
  const alias = (name: string, suffix: string, method: 'GET' | 'POST', schema: z.ZodType<Record<string, unknown>>, properties: Record<string, unknown> = {}, required: string[] = []): McpTool => ({
    name, description: VISION_CALIBRATION_OPERATIONS[method + ' ' + VISION_CALIBRATION_API + suffix].description,
    inputSchema: { type: 'object', properties: { experimentId: prop, ...properties }, required: ['experimentId', ...required], additionalProperties: false },
    handler: async args => {
      const { experimentId, taskId, ...body } = schema.parse(args); const result = await executePlatformOperation(router, req, res, method + ' ' + VISION_CALIBRATION_API + suffix, { params: { id: String(experimentId), ...(taskId ? { taskId: String(taskId) } : {}) }, ...(method === 'POST' ? { body } : {}) }, { timeoutMs: 130_000 });
      if (!result.ok) throw new Error('platform_http_' + result.status + ': ' + JSON.stringify(result.data)); return result;
    },
  });
  // Tools expose recorded capture fields; REST remains the strict authority.
  const inputProps = { operation: { type: 'string', enum: ['blc', 'lsc', 'ccm', 'awb'] }, inputs: { type: 'array', minItems: 1, maxItems: 32, items: { ...object({ sampleId: prop, artifactId: prop, capture }, []), oneOf: [{ required: ['sampleId', 'capture'] }, { required: ['artifactId'] }] } }, options: object({
    blackLevels: object(Object.fromEntries(['R', 'Gr', 'Gb', 'B'].map(channel => [channel, number(0, 65534)]))), grid: object({ rows: { type: 'integer', minimum: 2, maximum: 33 }, cols: { type: 'integer', minimum: 2, maximum: 33 } }),
    maxDarkFraction: number(.001, .5), maxFrameDriftCodes: number(0, 65535), maxIlluminationRelativeSpread: number(.001, .5), maxGain: number(1, 32), maxCellRelativeMad: number(.001, .5), maxFrameRelativeSpread: number(.001, .5), maxCondition: number(1, 10000), maxRmse: number(.000001, .5),
  }, []) };
  const target = z.object({ ...exp, taskId: uuid }).strict();
  return [
    alias('vision_calibration_asset_import', '/assets', 'POST', z.object({ ...exp, ...assetInput.shape }).strict(), { measurement }, ['measurement']),
    alias('vision_calibration_asset_list', '/assets', 'GET', z.object(exp).strict()),
    alias('vision_calibration_task_create', '/tasks', 'POST', z.object({ ...exp, ...taskInput.shape }).strict(), inputProps, ['operation', 'inputs']),
    alias('vision_calibration_task_list', '/tasks', 'GET', z.object(exp).strict()),
    alias('vision_calibration_task_get', '/tasks/:taskId', 'GET', target, { taskId: prop }, ['taskId']),
    alias('vision_calibration_task_run', '/tasks/:taskId/run', 'POST', target, { taskId: prop }, ['taskId']),
    alias('vision_calibration_task_result', '/tasks/:taskId/result', 'GET', target, { taskId: prop }, ['taskId']),
    alias('vision_calibration_apply_plan', '/tasks/:taskId/apply-plan', 'GET', target, { taskId: prop }, ['taskId']),
  ];
}
