import { randomUUID } from 'node:crypto';
import { VisionWorkshopError } from './vision-workshop-service.js';
import { quantizeVisionNumericValue, type VisionNumericPrecision } from './vision-workshop-model.js';

export const VISION_DEVICE_OPERATIONS = ['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning', 'preview_start', 'preview_stop', 'preview_frame', 'capture_frame', 'controls_get', 'controls_set', 'restore_tuning', 'tuning_get', 'tuning_load', 'tuning_export', 'calibration_apply'] as const;
export type VisionDeviceOperation = typeof VISION_DEVICE_OPERATIONS[number];
export type VisionCameraControl = { value: number; min: number; max: number; step?: number; writable: boolean; active?: boolean; nativeName?: string; unit?: string; nativePrecision?: VisionNumericPrecision } | { value: boolean; writable: boolean; active?: boolean; nativeName?: string; unit?: string };
export type VisionCameraControls = Record<string, VisionCameraControl>;
const CONTROL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const unsafeControl = (): never => { throw new VisionWorkshopError('vision_camera_controls_invalid', 'Camera controls must contain actual bounded values and supported ranges', 502); };
/** SDK names are data; only operator-configured SDK commands may interpret them. */
export function validateVisionCameraControls(input: unknown): VisionCameraControls {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 64) unsafeControl();
  const controls: VisionCameraControls = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!CONTROL_KEY.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !value || typeof value !== 'object' || Array.isArray(value)) unsafeControl();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(field => !['value', 'min', 'max', 'step', 'writable', 'active', 'nativeName', 'unit', 'nativePrecision'].includes(field)) || typeof row.writable !== 'boolean' || row.active !== undefined && typeof row.active !== 'boolean') unsafeControl();
    if (row.nativePrecision !== undefined && (typeof row.value === 'boolean' || !['float32', 'seconds-float32-us'].includes(row.nativePrecision as string))) unsafeControl();
    for (const field of ['nativeName', 'unit']) if (row[field] !== undefined && (typeof row[field] !== 'string' || !(row[field] as string).trim() || (row[field] as string).length > 120 || /[\x00-\x1f\x7f]/.test(row[field] as string))) unsafeControl();
    if (typeof row.value === 'boolean') { if (['min', 'max', 'step'].some(field => row[field] !== undefined)) unsafeControl(); }
    else if (![row.value, row.min, row.max].every(number => typeof number === 'number' && Number.isFinite(number)) || (row.min as number) > (row.max as number) || (row.value as number) < (row.min as number) || (row.value as number) > (row.max as number) || (row.step !== undefined && (typeof row.step !== 'number' || !Number.isFinite(row.step) || row.step <= 0))) unsafeControl();
    controls[key] = { ...row } as VisionCameraControl;
  }
  return controls;
}
export function validateVisionControlValues(input: unknown, controls?: VisionCameraControls): Record<string, number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).length > 64) throw new VisionWorkshopError('vision_camera_controls_request_invalid', 'Supply supported camera control values');
  const values: Record<string, number | boolean> = {};
  for (const [key, requested] of Object.entries(input as Record<string, unknown>)) {
    // The X5 CPROC getter exposes float32 values; normalize before dispatch and
    // readback comparison. Other SDK/UVC values retain their own precision.
    const control = controls?.[key];
    const precision = control && typeof control.value === 'number' ? control.nativePrecision : undefined;
    const fallback = control?.nativeName === 'hbn_isp_cproc_attr_t.manual_attr.' + (key === 'brightness' ? 'bright' : key)
      && ['brightness', 'contrast', 'saturation', 'hue'].includes(key) ? 'float32' : undefined;
    const value = typeof requested === 'number' ? quantizeVisionNumericValue(requested, precision ?? fallback) : requested;
    if (!CONTROL_KEY.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !(typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) throw new VisionWorkshopError('vision_camera_controls_request_invalid', 'Supply supported finite camera control values');
    if (controls) {
      const control = controls[key];
      if (!control?.writable || typeof control.value !== typeof value) throw new VisionWorkshopError('vision_camera_control_unavailable', 'Camera control is unsupported or read-only: ' + key, 409);
      if (typeof requested === 'number' && 'min' in control && (requested < control.min || requested > control.max)) throw new VisionWorkshopError('vision_camera_control_out_of_range', 'Camera control is outside its supported range or step: ' + key, 409);
      const automaticSwitch = key === 'exposureUs' ? 'autoExposure' : key === 'whiteBalanceTemperature' ? 'autoWhiteBalance' : undefined;
      if (typeof value === 'number' && control.active === false && !(automaticSwitch && (input as Record<string, unknown>)[automaticSwitch] === false && controls[automaticSwitch]?.writable)) throw new VisionWorkshopError('vision_camera_control_inactive', 'Disable the corresponding automatic mode before changing this control: ' + key, 409);
      if (typeof value === 'number' && 'min' in control && (value < control.min || value > control.max || control.step !== undefined && Math.abs((value - control.min) / control.step - Math.round((value - control.min) / control.step)) > 1e-6)) throw new VisionWorkshopError('vision_camera_control_out_of_range', 'Camera control is outside its supported range or step: ' + key, 409);
    }
    values[key] = value as number | boolean;
  }
  return values;
}
export interface VisionDeviceProfile {
  id: string; label: string; board: string; sensorModel: string; sdkVersion: string; operations: VisionDeviceOperation[];
  sensorVendor?: string; cameraInterface?: string; cameraMode?: string;
}
export interface VisionDeviceContext {
  jobId: string; experimentId: string; board: string; sensorModel: string; sdkVersion?: string;
  sensorVendor?: string; cameraInterface?: string; cameraMode?: string;
}
export interface VisionDeviceAdapter {
  profile: VisionDeviceProfile;
  execute(operation: VisionDeviceOperation, context: VisionDeviceContext, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export const VISION_DEVICE_CONTRACT = 'rdk.vision-device-runner.v1';
export class VisionDeviceExecutionError extends VisionWorkshopError {
  constructor(code: string, message: string, status: number, public readonly receipt: Record<string, string | number>) {
    super(code, message, status);
  }
}
async function failureCode(response: Response): Promise<{ adapterCode?: string; sdkCode?: number }> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 8192) { await reader.cancel(); return {}; }
      chunks.push(next.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ...(typeof body?.error === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(body.error) ? { adapterCode: body.error } : {}),
      ...(Number.isSafeInteger(body?.sdkCode) && Math.abs(body.sdkCode) <= 2 ** 31 ? { sdkCode: body.sdkCode } : {}) };
  } catch { return {}; } finally { reader.releaseLock(); }
}
// Registries may be reconstructed per request; leases must be process-wide.
const activeDeviceOperations = new Map<string, symbol>();
const identityFields = ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'] as const;
function identityText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
}

function invalid(): never { throw new VisionWorkshopError('vision_device_config_invalid', 'Invalid server device adapter configuration', 503); }
function strictRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export class VisionDeviceRegistry {
  private adapters = new Map<string, VisionDeviceAdapter>();
  constructor(adapters: VisionDeviceAdapter[] = []) {
    if (adapters.length > 20) invalid();
    for (const adapter of adapters) {
      const profile = adapter.profile;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile.id) || this.adapters.has(profile.id) || !identityText(profile.label)
        || !identityFields.slice(0, 3).every(key => identityText(profile[key]))
        || !identityFields.slice(3).every(key => profile[key] === undefined || identityText(profile[key]))
        || !Array.isArray(profile.operations) || !profile.operations.length || new Set(profile.operations).size !== profile.operations.length || profile.operations.some((operation) => !VISION_DEVICE_OPERATIONS.includes(operation))) invalid();
      const snapshot = { ...profile, operations: [...profile.operations] };
      this.adapters.set(profile.id, { profile: snapshot, execute: adapter.execute.bind(adapter) });
    }
  }
  list(): VisionDeviceProfile[] { return [...this.adapters.values()].map((adapter) => ({ ...adapter.profile, operations: [...adapter.profile.operations] })); }
  get(id: string): VisionDeviceAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new VisionWorkshopError('vision_device_adapter_unavailable', 'Configure a matching camera SDK adapter before device operations', 503);
    return adapter;
  }
  acquireSession(id: string): { execute: (operation: VisionDeviceOperation, context: Omit<VisionDeviceContext, 'jobId'>, inputs: Record<string, unknown>) => ReturnType<VisionDeviceRegistry['execute']>; release: () => void } {
    this.get(id);
    if (activeDeviceOperations.has(id)) throw new VisionWorkshopError('vision_device_busy', 'Another operation is using this device adapter', 429);
    const token = Symbol(id); activeDeviceOperations.set(id, token);
    return { execute: (operation, context, inputs) => this.executeLeased(id, operation, context, inputs, token), release: () => { if (activeDeviceOperations.get(id) === token) activeDeviceOperations.delete(id); } };
  }
  async execute(id: string, operation: VisionDeviceOperation, context: Omit<VisionDeviceContext, 'jobId'>, inputs: Record<string, unknown>): Promise<{ jobId: string; profile: VisionDeviceProfile; result: Record<string, unknown> }> {
    return this.executeLeased(id, operation, context, inputs);
  }
  private async executeLeased(id: string, operation: VisionDeviceOperation, context: Omit<VisionDeviceContext, 'jobId'>, inputs: Record<string, unknown>, session?: symbol): ReturnType<VisionDeviceRegistry['execute']> {
    const adapter = this.get(id);
    if (!adapter.profile.operations.includes(operation)) throw new VisionWorkshopError('vision_device_operation_unavailable', 'This SDK adapter does not implement the operation', 503);
    if (!context.sdkVersion) throw new VisionWorkshopError('vision_device_sdk_required', 'Record the matching SDK version before execution', 409);
    if (!identityFields.every(key => context[key] === adapter.profile[key])) throw new VisionWorkshopError('vision_device_profile_mismatch', 'Experiment board, camera, SDK or pipeline differs from the configured adapter', 409);
    if (session ? activeDeviceOperations.get(id) !== session : activeDeviceOperations.has(id)) throw new VisionWorkshopError('vision_device_busy', 'Another operation is using this device adapter', 429);
    if (!session) activeDeviceOperations.set(id, Symbol(id));
    try {
      const jobId = randomUUID();
      let requestedControls: Record<string, number | boolean> | undefined;
      if (operation === 'controls_set') {
        if (!adapter.profile.operations.includes('controls_get')) throw new VisionWorkshopError('vision_camera_control_unavailable', 'Read supported camera controls before setting values', 409);
        const before = await adapter.execute('controls_get', { ...context, jobId: randomUUID() }, {});
        requestedControls = validateVisionControlValues(inputs.values, validateVisionCameraControls(before.controls));
        inputs = { values: requestedControls };
      }
      const result = await adapter.execute(operation, { ...context, jobId }, inputs);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new VisionWorkshopError('vision_device_invalid_result', 'Device adapter returned an invalid result', 502);
      if (operation === 'controls_get' || operation === 'controls_set') {
        result.controls = validateVisionCameraControls(result.controls);
        if (requestedControls) for (const [key, expected] of Object.entries(requestedControls)) {
          const actual = (result.controls as VisionCameraControls)[key];
          if (!actual || typeof actual.value !== typeof expected || (typeof expected === 'boolean' ? actual.value !== expected : typeof actual.value !== 'number' || actual.active === false || Math.abs(actual.value - expected) > Math.max(1e-8, 'step' in actual ? (actual.step ?? 0) / 2 : 0))) throw new VisionWorkshopError('vision_camera_control_readback_mismatch', 'Camera control readback does not match requested value: ' + key, 502);
        }
      }
      if (operation === 'preview_start' && (result.running !== true || ![result.width, result.height].every(value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 16384) || result.fps !== undefined && (typeof result.fps !== 'number' || !Number.isFinite(result.fps) || result.fps <= 0 || result.fps > 1000))) throw new VisionWorkshopError('vision_device_invalid_receipt', 'Preview start requires actual dimensions and running state', 502);
      if (operation === 'preview_stop' && result.running !== false) throw new VisionWorkshopError('vision_device_invalid_receipt', 'Preview stop requires a stopped receipt', 502);
      if ((operation === 'capture_frame' || operation === 'preview_frame') && result.controls !== undefined) result.controls = validateVisionCameraControls(result.controls);
      return { jobId, profile: { ...adapter.profile, operations: [...adapter.profile.operations] }, result };
    } finally { if (!session) activeDeviceOperations.delete(id); }
  }
}

/** Adapter endpoints and credentials are configured only on the server. */
export function configuredVisionDevices(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): VisionDeviceRegistry {
  let input: unknown;
  try { input = JSON.parse(env.RDK_VISION_DEVICE_ADAPTERS || '[]'); } catch { invalid(); }
  if (!Array.isArray(input)) invalid();
  const adapters: VisionDeviceAdapter[] = input.map((item) => {
    const row = strictRecord(item, ['id', 'label', 'board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode', 'operations', 'url', 'token']);
    if (typeof row.id !== 'string' || !identityText(row.label) || !identityFields.slice(0, 3).every(key => identityText(row[key]))
      || !identityFields.slice(3).every(key => row[key] === undefined || identityText(row[key]))
      || typeof row.url !== 'string' || typeof row.token !== 'string' || row.token.length < 24 || row.token.length > 4096 || /[\r\n]/.test(row.token) || !Array.isArray(row.operations)) invalid();
    let url: URL;
    try { url = new URL(row.url); } catch { invalid(); }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) invalid();
    const endpoint = url.toString().replace(/\/$/, '') + '/execute'; const token = row.token;
    const profile: VisionDeviceProfile = { id: row.id, label: row.label as string, board: row.board as string, sensorModel: row.sensorModel as string, sdkVersion: row.sdkVersion as string,
      ...Object.fromEntries(identityFields.slice(3).flatMap(key => row[key] === undefined ? [] : [[key, row[key]]])), operations: row.operations as VisionDeviceOperation[] };
    return { profile, execute: async (operation, context, inputs) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({ contract: VISION_DEVICE_CONTRACT, operation, context, inputs }), signal: controller.signal });
        if (!response.ok) {
          const detail = await failureCode(response);
          throw new VisionDeviceExecutionError(response.status === 429 ? 'vision_device_busy' : 'vision_device_execution_failed',
            'Device adapter request failed', response.status === 429 ? 429 : 502,
            { jobId: context.jobId, operation, outcome: 'unconfirmed', ...detail });
        }
        if (Number(response.headers.get('content-length')) > 96 * 1024 * 1024) { await response.body?.cancel(); throw new VisionWorkshopError('vision_device_result_limit', 'Device output exceeds the response budget', 502); }
        const reader = response.body?.getReader(); if (!reader) throw new VisionWorkshopError('vision_device_empty_result', 'Missing device result', 502);
        const chunks: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 96 * 1024 * 1024) { await reader.cancel(); throw new VisionWorkshopError('vision_device_result_limit', 'Device output exceeds the response budget', 502); } chunks.push(next.value); } } finally { reader.releaseLock(); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (body.ok !== true || body.contract !== VISION_DEVICE_CONTRACT || body.jobId !== context.jobId || body.operation !== operation || !body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new VisionWorkshopError('vision_device_invalid_receipt', 'Device receipt does not match the requested operation', 502);
        return body.result as Record<string, unknown>;
      } catch (error) {
        if (error instanceof VisionWorkshopError) throw error;
        throw new VisionDeviceExecutionError('vision_device_transport_failed', 'Unable to complete the device operation; query device state before retrying', 502,
          { jobId: context.jobId, operation, outcome: 'unconfirmed' });
      } finally { clearTimeout(timer); }
    } };
  });
  return new VisionDeviceRegistry(adapters);
}
