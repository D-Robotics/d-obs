import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { EDGE_LLM_CONTRACT, EDGE_LLM_JOB_OPERATIONS, EDGE_LLM_RUNNER_CONTRACT, type EdgeLlmOperation } from './edge-llm-operations.js';

const MiB = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * MiB;
const MAX_STATE_BYTES = 32 * MiB;
const MAX_JOBS = 500;
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
const textSchema = z.string().trim().min(1).max(160).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const operationSchema = z.enum(EDGE_LLM_JOB_OPERATIONS);
const runnerStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']);
const timestampSchema = z.string().max(40).refine((value) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const jsonObjectSchema = z.record(z.unknown());
const terminal = (status: string) => status === 'succeeded' || status === 'failed' || status === 'superseded';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])); return value; }
const stateHash = (value: unknown) => hash(JSON.stringify(canonical(value)));
const now = () => new Date().toISOString();
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const clone = <T>(value: T): T => structuredClone(value);

export class EdgeLlmError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'EdgeLlmError'; }
}
function fail(code: string, status = 400): never { throw new EdgeLlmError(code, status); }
export interface EdgeLlmAdapterConfig { id: string; label: string; board: 'X5'; url: string; token: string }
export interface EdgeLlmTarget { id: string; label: string; board: 'X5'; backend: 'cpu'; operations: EdgeLlmOperation[] }
const adapterSchema = z.object({ id: idSchema, label: textSchema, board: z.literal('X5'), url: z.string().min(1).max(2000), token: z.string().min(24).max(4096).refine((value) => !/[\x00-\x20\x7f]/.test(value)) }).strict();
function adaptersFrom(input: unknown): EdgeLlmAdapterConfig[] {
  const parsed = z.array(adapterSchema).max(20).safeParse(input);
  if (!parsed.success) fail('edge_llm_config_invalid', 503);
  const ids = new Set<string>();
  for (const adapter of parsed.data) {
    if (ids.has(adapter.id)) fail('edge_llm_config_invalid', 503); ids.add(adapter.id);
    let url: URL; try { url = new URL(adapter.url); } catch { fail('edge_llm_config_invalid', 503); }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback) || /%2f|%5c|%2e/i.test(url.pathname)) fail('edge_llm_config_invalid', 503);
    adapter.url = url.toString().replace(/\/$/, '');
  }
  return parsed.data;
}
export function configuredEdgeLlmAdapters(env: NodeJS.ProcessEnv = process.env): EdgeLlmAdapterConfig[] {
  let parsed: unknown; try { parsed = JSON.parse(env.RDK_EDGE_LLM_ADAPTERS || '[]'); } catch { fail('edge_llm_config_invalid', 503); }
  return adaptersFrom(parsed);
}
const target = (adapter: EdgeLlmAdapterConfig): EdgeLlmTarget => ({ id: adapter.id, label: adapter.label, board: 'X5', backend: 'cpu', operations: [...EDGE_LLM_JOB_OPERATIONS] });

const catalogSchema = z.object({ ok: z.literal(true), contract: z.literal(EDGE_LLM_RUNNER_CONTRACT), board: z.literal('X5'), backend: z.literal('cpu'),
  models: z.array(z.object({ id: idSchema, label: textSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive().safe().optional(), quantization: textSchema }).strict()).max(32),
  runtime: z.object({ available: z.boolean(), version: textSchema.optional() }).strict(),
  deployment: z.object({ modelId: idSchema.optional(), ready: z.boolean() }).strict(),
}).strict();
export type EdgeLlmCatalog = z.infer<typeof catalogSchema>;
const receiptSchema = z.object({ ok: z.literal(true), contract: z.literal(EDGE_LLM_RUNNER_CONTRACT), job: z.object({
  id: z.string().uuid(), operation: operationSchema, status: runnerStatusSchema, createdAt: timestampSchema, updatedAt: timestampSchema,
  result: jsonObjectSchema.optional(), error: z.union([z.string().max(2000), jsonObjectSchema]).optional(),
}).strict() }).strict();
const inputSchema = z.object({ targetId: idSchema, operation: operationSchema, modelId: idSchema.optional() }).strict();
export type EdgeLlmJobInput = z.infer<typeof inputSchema>;
const jobSchema = z.object({ id: z.string().uuid(), targetId: idSchema, targetLabel: textSchema, board: z.literal('X5'), backend: z.literal('cpu'),
  operation: operationSchema, inputs: z.object({ modelId: idSchema.optional() }).strict(), modelSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: z.enum(['submitting', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'superseded']), createdAt: timestampSchema, updatedAt: timestampSchema,
  runnerCreatedAt: timestampSchema.optional(), runnerUpdatedAt: timestampSchema.optional(), result: jsonObjectSchema.optional(), error: z.string().max(100).optional(),
  lastQueryError: z.string().max(100).optional(), lastCheckedAt: timestampSchema.optional(),
  outcome: z.literal('unknown').optional(), supersededByJobId: z.string().uuid().optional(),
}).strict();
export type EdgeLlmJob = z.infer<typeof jobSchema>;
const storedJobSchema = jobSchema.extend({ ownerHash: z.string().regex(/^[a-f0-9]{64}$/), abandonJobIds: z.array(z.string().uuid()).max(MAX_JOBS).optional(), supersededByOwnerHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
type StoredJob = z.infer<typeof storedJobSchema>;
const stateSchema = z.object({ schemaVersion: z.literal(1), jobs: z.array(storedJobSchema).max(MAX_JOBS) }).strict();
type State = z.infer<typeof stateSchema>;
const envelopeSchema = z.object({ payload: stateSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const publicJob = ({ ownerHash, abandonJobIds: _abandonJobIds, supersededByOwnerHash, ...job }: StoredJob): EdgeLlmJob => { if (supersededByOwnerHash && supersededByOwnerHash !== ownerHash) delete job.supersededByJobId; return clone(job); };
const queues = new Map<string, Promise<void>>();
const submitting = new Set<string>();

export class EdgeLlmService {
  readonly dataDir: string;
  private readonly configured?: EdgeLlmAdapterConfig[];
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: { dataDir?: string; adapters?: EdgeLlmAdapterConfig[]; fetcher?: typeof fetch; requestTimeoutMs?: number } = {}) {
    this.dataDir = resolve(options.dataDir || process.env.RDK_EDGE_LLM_STATE_DIR || join(homedir(), '.local', 'state', 'd-obs', 'edge-llm'));
    this.configured = options.adapters === undefined ? undefined : adaptersFrom(options.adapters);
    this.fetcher = options.fetcher ?? fetch; this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) fail('edge_llm_config_invalid', 503);
  }
  private adapters() { return this.configured ?? configuredEdgeLlmAdapters(); }
  private adapter(id: string) { const adapter = this.adapters().find((item) => item.id === id); if (!adapter) fail('edge_llm_target_unavailable', 503); return adapter; }
  capabilities() { return { targets: this.adapters().map(target), operations: [...EDGE_LLM_JOB_OPERATIONS], board: 'X5', backend: 'cpu', taskExecution: 'asynchronous', unknownRecovery: 'query_same_job_id_then_verified_stop', benchmark: { inputs: 'model_id_only', measurementSource: 'runner' }, quota: { maxJobs: MAX_JOBS, maxRunnerResponseBytes: MAX_RESPONSE_BYTES, maxStateBytes: MAX_STATE_BYTES } }; }
  async getTarget(targetId: string): Promise<{ target: EdgeLlmTarget; catalog: EdgeLlmCatalog }> {
    if (!idSchema.safeParse(targetId).success) fail('edge_llm_invalid_request');
    const adapter = this.adapter(targetId); const parsed = catalogSchema.safeParse(await this.request(adapter, '/catalog'));
    if (!parsed.success || new Set(parsed.data.models.map((model) => model.id)).size !== parsed.data.models.length || (parsed.data.deployment.modelId && !parsed.data.models.some((model) => model.id === parsed.data.deployment.modelId)) || (parsed.data.deployment.ready && !parsed.data.deployment.modelId)) fail('edge_llm_invalid_catalog', 502);
    return { target: target(adapter), catalog: this.redact(parsed.data, adapter) as EdgeLlmCatalog };
  }
  async listJobs(owner: string): Promise<EdgeLlmJob[]> { return this.transaction(owner, (state, ownerHash) => state.jobs.filter((job) => job.ownerHash === ownerHash).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob)); }
  async submitJob(owner: string, raw: unknown): Promise<EdgeLlmJob> {
    const parsed = inputSchema.safeParse(raw); if (!parsed.success) fail('edge_llm_invalid_request'); const input = parsed.data;
    const adapter = this.adapter(input.targetId); let modelSha256: string | undefined;
    if (input.operation === 'deploy' || input.operation === 'benchmark') {
      if (!input.modelId) fail('edge_llm_model_required');
      const { catalog } = await this.getTarget(input.targetId);
      const model = catalog.models.find((model) => model.id === input.modelId); if (!model) fail('edge_llm_model_unavailable', 409); modelSha256 = model.sha256;
      if (input.operation === 'benchmark' && (!catalog.deployment.ready || catalog.deployment.modelId !== input.modelId)) fail('edge_llm_deployment_required', 409);
    } else if (input.modelId !== undefined) fail('edge_llm_invalid_request');
    const created = await this.transaction(owner, async (state, ownerHash) => {
      if (state.jobs.length >= MAX_JOBS) fail('edge_llm_job_quota_exceeded', 409);
      const pending = state.jobs.filter((job) => job.targetId === input.targetId && !terminal(job.status));
      if (pending.length && (input.operation !== 'stop' || pending.some((job) => job.status !== 'unknown' || submitting.has(this.dataDir + ':' + job.id)))) fail('edge_llm_job_pending', 409);
      const abandonJobIds = input.operation === 'stop' ? pending.map((job) => job.id).sort() : [];
      const timestamp = now(); const stored: StoredJob = { id: randomUUID(), ownerHash, targetId: input.targetId, targetLabel: adapter.label, board: 'X5', backend: 'cpu', operation: input.operation, inputs: input.modelId ? { modelId: input.modelId } : {}, ...(modelSha256 ? { modelSha256 } : {}), status: 'submitting', createdAt: timestamp, updatedAt: timestamp };
      if (input.operation === 'stop') stored.abandonJobIds = abandonJobIds;
      state.jobs.push(stored); await this.save(state); return { job: publicJob(stored), abandonJobIds };
    });
    // The record is durable before any runner mutation. Never retransmit this ID,
    // even when the process dies between save and POST or the reply is lost.
    const key = this.dataDir + ':' + created.job.id; submitting.add(key);
    setImmediate(() => { void this.dispatch(owner, created.job, adapter, created.abandonJobIds).catch(() => undefined).finally(() => submitting.delete(key)); });
    return created.job;
  }
  async getJob(owner: string, id: string, options: { refresh?: boolean } = {}): Promise<EdgeLlmJob> {
    if (!z.string().uuid().safeParse(id).success) fail('edge_llm_job_not_found', 404);
    const snapshot = await this.transaction(owner, (state, ownerHash) => { const job = state.jobs.find((item) => item.id === id && item.ownerHash === ownerHash); if (!job) fail('edge_llm_job_not_found', 404); return { job: publicJob(job), abandonJobIds: job.abandonJobIds ?? [] }; });
    const current = snapshot.job;
    if (options.refresh === false || terminal(current.status) || submitting.has(this.dataDir + ':' + id)) return current;
    try { const adapter = this.adapter(current.targetId); const receipt = await this.request(adapter, '/jobs/' + id); return await this.applyReceipt(owner, current, receipt, adapter, snapshot.abandonJobIds); }
    catch (error) { return this.markUnknown(owner, current, error); }
  }
  async exportReport(owner: string, id: string) { return { ok: true, contract: EDGE_LLM_CONTRACT, exportedAt: now(), job: await this.getJob(owner, id, { refresh: false }), measurementSource: 'runner', completion: 'only_succeeded_is_success' }; }
  private async dispatch(owner: string, job: EdgeLlmJob, adapter: EdgeLlmAdapterConfig, abandonJobIds: string[]) {
    try { const receipt = await this.request(adapter, '/jobs', { contract: EDGE_LLM_RUNNER_CONTRACT, id: job.id, operation: job.operation, inputs: job.operation === 'stop' ? { abandonJobIds } : job.inputs }); await this.applyReceipt(owner, job, receipt, adapter, abandonJobIds); }
    catch (error) { await this.markUnknown(owner, job, error); }
  }
  private async applyReceipt(owner: string, requested: EdgeLlmJob, raw: unknown, adapter: EdgeLlmAdapterConfig, abandonJobIds: string[]): Promise<EdgeLlmJob> {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.job.id !== requested.id || parsed.data.job.operation !== requested.operation || Date.parse(parsed.data.job.updatedAt) < Date.parse(parsed.data.job.createdAt)) fail('edge_llm_invalid_receipt', 502);
    const receipt = parsed.data.job;
    if (receipt.status === 'succeeded' && (!receipt.result || !Object.keys(receipt.result).length)) fail('edge_llm_empty_success_result', 502);
    if (receipt.status === 'succeeded') this.validateSuccess(requested, receipt.result!, abandonJobIds);
    const result = receipt.result ? this.redact(receipt.result, adapter) as Record<string, unknown> : undefined;
    if (result && Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail('edge_llm_result_limit', 502);
    return this.transaction(owner, async (state, ownerHash) => {
      const job = state.jobs.find((item) => item.id === requested.id && item.ownerHash === ownerHash); if (!job) fail('edge_llm_job_not_found', 404);
      if (terminal(job.status)) return publicJob(job);
      if (job.runnerUpdatedAt && Date.parse(receipt.updatedAt) < Date.parse(job.runnerUpdatedAt)) return publicJob(job);
      if (job.status === 'running' && receipt.status === 'queued') fail('edge_llm_invalid_state_transition', 502);
      job.status = receipt.status; job.updatedAt = now(); job.lastCheckedAt = job.updatedAt; job.runnerCreatedAt = receipt.createdAt; job.runnerUpdatedAt = receipt.updatedAt;
      if (result) {
        job.result = result;
        if (job.operation === 'stop' && Array.isArray(result.abandonedJobIds)) job.result.abandonedJobIds = result.abandonedJobIds.filter((id) => state.jobs.some((item) => item.id === id && item.ownerHash === ownerHash));
      }
      const runnerError = typeof receipt.error === 'string' && /^edge_llm_[a-z0-9_]{1,90}$/.test(receipt.error) ? receipt.error : undefined;
      if (receipt.status === 'failed') job.error = runnerError ?? 'edge_llm_runner_failed';
      else if (receipt.status === 'unknown') job.error = runnerError ?? 'edge_llm_runner_unknown';
      else delete job.error;
      delete job.lastQueryError;
      if (job.operation === 'stop' && receipt.status === 'succeeded') {
        for (const previous of state.jobs.filter((item) => (job.abandonJobIds ?? []).includes(item.id))) {
          if (previous.targetId !== job.targetId || submitting.has(this.dataDir + ':' + previous.id)) fail('edge_llm_invalid_recovery_state', 502);
          if (!terminal(previous.status)) { previous.status = 'superseded'; previous.outcome = 'unknown'; previous.updatedAt = job.updatedAt; previous.supersededByJobId = job.id; previous.supersededByOwnerHash = ownerHash; }
        }
      }
      await this.save(state); return publicJob(job);
    });
  }
  private validateSuccess(job: EdgeLlmJob, result: Record<string, unknown>, abandonJobIds: string[]) {
    const common = { board: z.literal('X5'), backend: z.literal('cpu') };
    let valid = false;
    if (job.operation === 'probe') {
      const parsed = z.object({ ...common, configuredBoard: z.literal('X5'), identityVerification: z.enum(['verified', 'unverified']), detectedBoard: z.literal('X5').nullable().optional(), runtime: z.object({ available: z.boolean(), version: z.string().max(160).optional() }).passthrough() }).passthrough().safeParse(result);
      valid = parsed.success && (parsed.data.identityVerification !== 'verified' || parsed.data.detectedBoard === 'X5');
    } else if (job.operation === 'stop') { const parsed = z.object({ ...common, stopped: z.literal(true), inferencePortAvailable: z.literal(true), abandonedJobIds: z.array(z.string().uuid()).max(MAX_JOBS) }).passthrough().safeParse(result); valid = parsed.success && new Set(parsed.data.abandonedJobIds).size === parsed.data.abandonedJobIds.length && JSON.stringify([...parsed.data.abandonedJobIds].sort()) === JSON.stringify([...abandonJobIds].sort()); }
    else {
      const base = z.object({ ...common, modelId: idSchema, modelSha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().safeParse(result);
      if (!base.success || base.data.modelId !== job.inputs.modelId || base.data.modelSha256 !== job.modelSha256) fail('edge_llm_invalid_success_evidence', 502);
      if (job.operation === 'deploy') valid = z.object({ ready: z.literal(true) }).passthrough().safeParse(result).success;
      else {
        const metric = z.number().finite().nonnegative().nullable();
        const parsed = z.object({ suite: z.literal('qwen-text-smoke-v1'), measurementSource: z.literal('runner'), cases: z.array(z.object({ id: idSchema, ttftMs: metric, totalMs: metric, generatedTokens: z.number().int().positive().nullable(), tokensPerSecond: metric, metricStatus: z.string().min(1).max(32), unavailableReasons: z.array(z.string().min(1).max(240)).max(12), outputPresent: z.literal(true) }).passthrough()).length(3) }).passthrough().safeParse(result);
        valid = parsed.success && new Set(parsed.data.cases.map((item) => item.id)).size === 3 && parsed.data.cases.every((item) => ((item.ttftMs !== null && item.totalMs !== null && item.generatedTokens !== null && item.tokensPerSecond !== null) || item.unavailableReasons.length > 0) && (item.ttftMs === null || item.totalMs === null || item.totalMs >= item.ttftMs));
      }
    }
    if (!valid) fail('edge_llm_invalid_success_evidence', 502);
  }
  private async markUnknown(owner: string, requested: EdgeLlmJob, cause: unknown): Promise<EdgeLlmJob> {
    const code = cause instanceof EdgeLlmError ? cause.code : 'edge_llm_transport_failed';
    return this.transaction(owner, async (state, ownerHash) => {
      const job = state.jobs.find((item) => item.id === requested.id && item.ownerHash === ownerHash); if (!job) fail('edge_llm_job_not_found', 404);
      if (terminal(job.status)) return publicJob(job);
      job.status = 'unknown'; job.updatedAt = now(); job.lastCheckedAt = job.updatedAt; job.lastQueryError = code; await this.save(state); return publicJob(job);
    });
  }
  private async request(adapter: EdgeLlmAdapterConfig, suffix: string, body?: object): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(adapter.url + suffix, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: 'Bearer ' + adapter.token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if ((body && response.status !== 202) || (!body && response.status !== 200)) { await response.body?.cancel(); fail(response.status === 404 ? 'edge_llm_runner_job_missing' : 'edge_llm_runner_request_failed', 502); }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); fail('edge_llm_response_limit', 502); }
      const reader = response.body?.getReader(); if (!reader) fail('edge_llm_empty_response', 502);
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('edge_llm_response_limit', 502); } chunks.push(next.value); } } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { fail('edge_llm_invalid_response', 502); }
    } catch (error) { if (error instanceof EdgeLlmError) throw error; fail('edge_llm_transport_failed', 502); }
    finally { clearTimeout(timer); }
  }
  private redact(value: unknown, adapter: EdgeLlmAdapterConfig, depth = 0): unknown {
    if (depth > 12) fail('edge_llm_result_limit', 502);
    if (typeof value === 'string') return value.split(adapter.token).join('[redacted]').split(adapter.url).join('[redacted]').replace(/https?:\/\/[^\s"<>]+/gi, '[redacted]');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (Array.isArray(value)) { if (value.length > 1000) fail('edge_llm_result_limit', 502); return value.map((item) => this.redact(item, adapter, depth + 1)); }
    if (!value || typeof value !== 'object') fail('edge_llm_invalid_receipt', 502);
    const entries = Object.entries(value); if (entries.length > 200) fail('edge_llm_result_limit', 502);
    const metricKeys = new Set(['generatedTokens', 'promptTokens', 'completionTokens', 'totalTokens', 'tokensPerSecond', 'tokenCount']);
    return Object.fromEntries(entries.filter(([key]) => !(/token|api.?key|secret|authorization|credential|password|url|endpoint|command|^env$|^__proto__$|^constructor$|^prototype$/i.test(key) && !metricKeys.has(key))).map(([key, item]) => [key, this.redact(item, adapter, depth + 1)]));
  }
  private async privateDirectory() { await mkdir(this.dataDir, { recursive: true, mode: 0o700 }); const info = await lstat(this.dataDir); if (!info.isDirectory() || info.isSymbolicLink()) fail('edge_llm_state_invalid', 503); await chmod(this.dataDir, 0o700); }
  private async readSafe(filename: string, max: number) { const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await file.stat(); if (!info.isFile() || info.size > max) fail('edge_llm_state_invalid', 503); return await file.readFile(); } finally { await file.close(); } }
  private async save(state: State) {
    const bytes = Buffer.from(JSON.stringify({ payload: state, sha256: stateHash(state) })); if (bytes.length > MAX_STATE_BYTES) fail('edge_llm_state_quota_exceeded', 409);
    const temporary = join(this.dataDir, 'manifest-' + randomUUID() + '.tmp'); const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, join(this.dataDir, 'manifest.json')); await this.syncDirectory(); } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async syncDirectory() { const directory = await open(this.dataDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
  private async load(): Promise<State> {
    try {
      const raw: unknown = JSON.parse((await this.readSafe(join(this.dataDir, 'manifest.json'), MAX_STATE_BYTES)).toString('utf8')); const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success || stateHash(parsed.data.payload) !== parsed.data.sha256 || new Set(parsed.data.payload.jobs.map((job) => job.id)).size !== parsed.data.payload.jobs.length) fail('edge_llm_state_integrity_failure', 503);
      await this.markInitialized();
      return parsed.data.payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { if (error instanceof EdgeLlmError) throw error; fail('edge_llm_state_integrity_failure', 503); }
      try { await lstat(join(this.dataDir, 'initialized')); fail('edge_llm_state_integrity_failure', 503); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
      const state: State = { schemaVersion: 1, jobs: [] }; await this.save(state);
      await this.markInitialized(); return state;
    }
  }
  private async markInitialized() { try { const marker = await open(join(this.dataDir, 'initialized'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await marker.writeFile(EDGE_LLM_CONTRACT); await marker.sync(); } finally { await marker.close(); } await this.syncDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const info = await lstat(join(this.dataDir, 'initialized')); if (!info.isFile() || info.isSymbolicLink()) fail('edge_llm_state_invalid', 503); } }
  private async lock() {
    const filename = join(this.dataDir, 'state.lock'); const deadline = Date.now() + 10_000;
    do { const release = await this.claim(filename); if (release) return release; await this.recoverClaim(filename); await pause(20); } while (Date.now() < deadline);
    fail('edge_llm_state_busy', 503);
  }
  private async claim(filename: string): Promise<(() => Promise<void>) | null> {
    const token = randomUUID(); const temporary = filename + '.owner.' + token;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(temporary, filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
      return async () => { const owner = await this.lockOwner(filename); if (owner?.pid === process.pid && owner.token === token) await unlink(filename).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); };
    } finally { await unlink(temporary); }
  }
  private async lockOwner(filename: string): Promise<{ pid: number; token: string } | null> {
    try { const raw: unknown = JSON.parse((await this.readSafe(filename, 1024)).toString()); const parsed = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict().safeParse(raw); if (!parsed.success) fail('edge_llm_state_invalid', 503); return parsed.data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
  private async recoverClaim(filename: string, depth = 0): Promise<void> {
    const owner = await this.lockOwner(filename); if (!owner || this.alive(owner.pid)) return;
    if (depth >= 3) fail('edge_llm_state_recovery_required', 503);
    const recovery = filename + '.recover-' + owner.token; let release = await this.claim(recovery);
    if (!release) { await this.recoverClaim(recovery, depth + 1); release = await this.claim(recovery); if (!release) return; }
    try { const current = await this.lockOwner(filename); if (current?.pid === owner.pid && current.token === owner.token && !this.alive(current.pid)) await unlink(filename).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    finally { await release(); }
  }
  private async transaction<T>(owner: string, action: (state: State, ownerHash: string) => T | Promise<T>): Promise<T> {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 500 || owner === 'ops-admin') fail('edge_llm_identity_required', 403);
    const previous = queues.get(this.dataDir) ?? Promise.resolve(); let releaseQueue!: () => void; const next = new Promise<void>((done) => { releaseQueue = done; }); queues.set(this.dataDir, next); await previous;
    let releaseLock: (() => Promise<void>) | undefined;
    try { await this.privateDirectory(); releaseLock = await this.lock(); return clone(await action(await this.load(), hash(owner))); }
    finally { try { await releaseLock?.(); } finally { releaseQueue(); if (queues.get(this.dataDir) === next) queues.delete(this.dataDir); } }
  }
}
