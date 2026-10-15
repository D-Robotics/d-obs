/** Versioned recipes and truthful receipts over existing collectors. No arbitrary DAG or shell. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const COLLECTION_WORKSPACE_CONTRACT = 'rdk.collection-workspace.v1';
export interface CollectionModuleDescriptor {
  moduleId: string; version: string; mode: 'pull' | 'receiver' | 'import'; label: string; description: string;
  available: boolean; reason?: string; configSchema: { fields: Array<Record<string, unknown>> };
  targets: Array<Record<string, unknown>>; canStart: boolean; canStop: boolean;
}
export interface CollectionInspection {
  state: 'connecting' | 'running' | 'completed' | 'stopped' | 'failed'; recordCount: number; byteCount: number;
  error?: string; startedAt?: string; endedAt?: string;
}
export interface CollectionArtifact { filename: string; mimeType: string; kind: 'log' | 'document'; bytes: Buffer; rawBytes?: Buffer; rawFilename?: string }
export interface CollectionWorkspaceDriver {
  moduleId: string; version: string;
  describe(owner: string): CollectionModuleDescriptor | Promise<CollectionModuleDescriptor>;
  validate(config: unknown, owner: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  start?(config: Record<string, unknown>, owner: string): Promise<{ upstreamId: string }>;
  inspect?(upstreamId: string, owner: string): Promise<CollectionInspection>;
  stop?(upstreamId: string, owner: string): Promise<unknown>;
  export?(upstreamId: string, owner: string): Promise<CollectionArtifact>;
}
export interface CollectionPipelineVersion {
  version: number; name: string; project: string; source: 'cloud' | 'edge'; moduleId: string; moduleVersion: '1.0.0';
  config: Record<string, unknown>; filter?: { keywords: string[]; mode: 'include' | 'exclude' }; quality?: { minBytes: number };
  createDataset: boolean; createdAt: string;
}
export interface CollectionPipeline {
  id: string; name: string; project: string; source: 'cloud' | 'edge'; moduleId: string; moduleVersion: '1.0.0';
  currentVersion: number; versions: CollectionPipelineVersion[]; createdAt: string; updatedAt: string;
}
export interface CollectionNodeState {
  id: 'source' | 'filter' | 'quality' | 'archive'; kind: 'source' | 'filter' | 'quality' | 'archive';
  state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';
  startedAt?: string; endedAt?: string; byteCount?: number; error?: string;
}
export interface CollectionRun {
  id: string; pipelineId: string; pipelineVersion: number; moduleId: string; moduleVersion: '1.0.0'; upstreamId?: string; origin?: 'started' | 'adopted';
  state: 'starting' | 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'; upstreamState?: CollectionInspection['state'];
  nodeStates: CollectionNodeState[]; assetIds: string[]; datasetId?: string; startedAt: string; endedAt?: string;
  recordCount: number; byteCount: number; error?: string; archiveState: 'pending' | 'completed' | 'failed'; archiveError?: string;
  unknownUntil?: string;
}
export type CollectionArchive = (owner: string, run: CollectionRun, pipeline: CollectionPipelineVersion, artifact: CollectionArtifact) => Promise<{ assetIds: string[]; datasetId?: string }>;
export interface CollectionWorkspaceOptions {
  stateDir: string; drivers: CollectionWorkspaceDriver[]; archive: CollectionArchive; now?: () => number; pollIntervalMs?: number;
}
export class CollectionWorkspaceError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'CollectionWorkspaceError'; }
}

const MiB = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * MiB;
const MAX_PIPELINES = 200;
const MAX_VERSIONS = 50;
const MAX_RUNS = 1000;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.string().datetime();
const short = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\x00-\x1f\x7f]/.test(v));
const opaque = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
function fail(code: string, status = 400): never { throw new CollectionWorkspaceError('collection_' + code, status); }
function errno(error: unknown, code: string) { return (error as NodeJS.ErrnoException)?.code === code; }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) fail('invalid_request'); return result.data; }
function clone<T>(value: T): T { if (Buffer.isBuffer(value)) return Buffer.from(value) as T; if (Array.isArray(value)) return value.map(clone) as T; if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T; return value; }
function safeCode(error: unknown, fallback: string): string { const code = (error as { code?: unknown })?.code; return typeof code === 'string' && /^[a-z0-9_-]{1,100}$/.test(code) ? code : 'collection_' + fallback; }
function safeConfig(value: unknown): boolean {
  let count = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++count > 300 || depth > 5) return false;
    if (node === null || typeof node === 'boolean') return true;
    if (typeof node === 'number') return Number.isFinite(node) && Math.abs(node) <= 1e12;
    if (typeof node === 'string') return node.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(node) && !/\b(?:Bearer\s+\S{12,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(node);
    if (Array.isArray(node)) return node.length <= 64 && node.every((entry) => visit(entry, depth + 1));
    if (!node || typeof node !== 'object' || Object.getPrototypeOf(node) !== Object.prototype) return false;
    return Object.entries(node).length <= 40 && Object.entries(node).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) && !/^(?:constructor|prototype|token|secret|password|credentials?|authorization|api[_-]?key|url|endpoint|host|port|path|identityFile|command|cmd|shell|owner|accountId)$/i.test(key) && visit(entry, depth + 1));
  };
  return !!value && typeof value === 'object' && !Array.isArray(value) && visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024;
}
const configSchema = z.record(z.unknown()).refine(safeConfig);
const filterSchema = z.object({ keywords: z.array(short(100)).min(1).max(20), mode: z.enum(['include', 'exclude']) }).strict();
const qualitySchema = z.object({ minBytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES) }).strict();
const recipeSchema = z.object({ name: short(160), project: short(120), source: z.enum(['cloud', 'edge']), moduleId: opaque, moduleVersion: z.literal('1.0.0'), config: configSchema, filter: filterSchema.optional(), quality: qualitySchema.optional(), createDataset: z.boolean() }).strict();
const saveSchema = recipeSchema.extend({ pipelineId: uuid.optional() }).strict();
const versionSchema = recipeSchema.extend({ version: z.number().int().min(1).max(MAX_VERSIONS), createdAt: stamp }).strict();
const pipelineSchema = recipeSchema.omit({ config: true, filter: true, quality: true, createDataset: true }).extend({ id: uuid, currentVersion: z.number().int().min(1).max(MAX_VERSIONS), versions: z.array(versionSchema).min(1).max(MAX_VERSIONS), createdAt: stamp, updatedAt: stamp }).strict();
const nodeSchema = z.object({ id: z.enum(['source', 'filter', 'quality', 'archive']), kind: z.enum(['source', 'filter', 'quality', 'archive']), state: z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'interrupted']), startedAt: stamp.optional(), endedAt: stamp.optional(), byteCount: z.number().int().min(0).max(MAX_ARTIFACT_BYTES).optional(), error: short(120).optional() }).strict();
const inspectionSchema = z.object({ state: z.enum(['connecting', 'running', 'completed', 'stopped', 'failed']), recordCount: z.number().int().min(0).max(1e9), byteCount: z.number().int().min(0).max(1e12), error: short(120).optional(), startedAt: stamp.optional(), endedAt: stamp.optional() }).strict();
const runSchema = z.object({ id: uuid, pipelineId: uuid, pipelineVersion: z.number().int().min(1).max(MAX_VERSIONS), moduleId: opaque, moduleVersion: z.literal('1.0.0'), upstreamId: opaque.optional(), origin: z.enum(['started', 'adopted']).optional(), state: z.enum(['starting', 'running', 'completed', 'stopped', 'failed', 'interrupted']), upstreamState: inspectionSchema.shape.state.optional(), nodeStates: z.array(nodeSchema).min(3).max(4), assetIds: z.array(uuid).max(10), datasetId: uuid.optional(), startedAt: stamp, endedAt: stamp.optional(), recordCount: z.number().int().min(0).max(1e9), byteCount: z.number().int().min(0).max(1e12), error: short(120).optional(), archiveState: z.enum(['pending', 'completed', 'failed']), archiveError: short(120).optional(), unknownUntil: stamp.optional() }).strict();
const leaseSchema = z.object({ pid: z.number().int().min(1).max(2147483647), instanceId: uuid, token: uuid }).strict();
const ownership = { ownerId: short(500), ownerHash: sha };
const storeSchema = z.object({ schemaVersion: z.literal(1), pipelines: z.array(z.object({ ...ownership, pipeline: pipelineSchema }).strict()).max(MAX_PIPELINES), runs: z.array(z.object({ ...ownership, run: runSchema, startLease: leaseSchema.optional(), finalizeLease: leaseSchema.optional() }).strict()).max(MAX_RUNS) }).strict();
const envelopeSchema = z.object({ sha256: sha, payload: storeSchema }).strict();
type Store = z.infer<typeof storeSchema>;
type RunEntry = Store['runs'][number];
type Lease = z.infer<typeof leaseSchema>;
const queues = new Map<string, Promise<void>>();
const instances = new Map<string, Set<string>>();
const terminal = (state: CollectionInspection['state'] | undefined) => state !== undefined && ['completed', 'stopped', 'failed'].includes(state);
const active = (run: CollectionRun) => ['starting', 'running'].includes(run.state) && !terminal(run.upstreamState);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class CollectionWorkspaceService {
  readonly stateDir: string;
  private readonly drivers = new Map<string, CollectionWorkspaceDriver>();
  private readonly archive: CollectionArchive;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly instanceId = randomUUID();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private disposed = false;
  private readonly refreshing = new Map<string, Promise<CollectionRun>>();

  constructor(options: CollectionWorkspaceOptions) {
    this.stateDir = resolve(options.stateDir); this.archive = options.archive; this.now = options.now ?? Date.now;
    this.interval = options.pollIntervalMs ?? 1000;
    if (!options.stateDir || !Number.isSafeInteger(this.interval) || this.interval < 0 || this.interval > 60_000 || (this.interval > 0 && this.interval < 25)) throw new Error('Invalid collection workspace options');
    for (const driver of options.drivers) {
      if (!opaque.safeParse(driver.moduleId).success || driver.version !== '1.0.0' || this.drivers.has(driver.moduleId) || typeof driver.describe !== 'function' || typeof driver.validate !== 'function') throw new Error('Invalid collection driver');
      this.drivers.set(driver.moduleId, driver);
    }
    const set = instances.get(this.stateDir) ?? new Set<string>(); set.add(this.instanceId); instances.set(this.stateDir, set);
  }
  async modules(owner: string): Promise<CollectionModuleDescriptor[]> {
    this.owner(owner); const descriptions = [];
    for (const driver of this.drivers.values()) { const descriptor = await driver.describe(owner); if (descriptor.moduleId !== driver.moduleId || descriptor.version !== driver.version) fail('invalid_module_descriptor', 503); descriptions.push(clone(descriptor)); }
    return descriptions;
  }
  async listPipelines(owner: string): Promise<CollectionPipeline[]> { return this.transaction(owner, (store) => store.pipelines.filter((entry) => entry.ownerId === owner).map((entry) => entry.pipeline).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async savePipeline(owner: string, input: unknown): Promise<CollectionPipeline> {
    this.owner(owner); const parsed = parse(saveSchema, input); const driver = this.driver(parsed.moduleId, parsed.moduleVersion); const config = await this.validate(driver, parsed.config, owner);
    return this.transaction(owner, async (store) => {
      let pipeline: CollectionPipeline;
      if (parsed.pipelineId) pipeline = this.pipeline(store, owner, parsed.pipelineId);
      else { if (store.pipelines.length >= MAX_PIPELINES) fail('pipeline_quota_exceeded', 409); const now = this.iso(); pipeline = { id: randomUUID(), name: parsed.name, project: parsed.project, source: parsed.source, moduleId: parsed.moduleId, moduleVersion: parsed.moduleVersion, currentVersion: 1, versions: [], createdAt: now, updatedAt: now }; store.pipelines.push({ ownerId: owner, ownerHash: hash(owner), pipeline }); }
      if (pipeline.versions.length >= MAX_VERSIONS) fail('version_quota_exceeded', 409);
      const version: CollectionPipelineVersion = { ...this.recipe(parsed), config, version: pipeline.versions.length + 1, createdAt: this.iso() };
      pipeline.versions.push(version); Object.assign(pipeline, { name: version.name, project: version.project, source: version.source, moduleId: version.moduleId, moduleVersion: version.moduleVersion, currentVersion: version.version, updatedAt: version.createdAt }); await this.save(store); return pipeline;
    });
  }
  async startRun(owner: string, pipelineId: string, version?: number): Promise<CollectionRun> {
    this.owner(owner);
    const reserved = await this.transaction(owner, async (store) => {
      const pipeline = this.pipeline(store, owner, pipelineId); const selected = this.version(pipeline, version); const driver = this.driver(selected.moduleId, selected.moduleVersion); const descriptor = await driver.describe(owner);
      if (!descriptor.available || !descriptor.canStart || descriptor.mode !== 'pull' || !driver.start || !driver.inspect || !driver.export) fail('module_execution_unavailable', 503);
      const config = await this.validate(driver, selected.config, owner); this.capacity(store, owner);
      const run = this.newRun(pipeline.id, selected); const lease = this.lease(); store.runs.push({ ownerId: owner, ownerHash: hash(owner), run, startLease: lease }); await this.save(store); return { run, recipe: { ...selected, config }, lease };
    });
    this.poll();
    try {
      const driver = this.driver(reserved.recipe.moduleId, reserved.recipe.moduleVersion); const response = await driver.start!(clone(reserved.recipe.config), owner); const upstreamId = parse(opaque, response.upstreamId);
      await this.transaction(owner, async (store) => { const entry = this.entry(store, owner, reserved.run.id); if (entry.startLease?.token !== reserved.lease.token) fail('start_receipt_conflict', 409); entry.run.upstreamId = upstreamId; entry.run.state = 'running'; delete entry.startLease; await this.save(store); });
      return await this.refresh(owner, reserved.run.id);
    } catch (error) {
      await this.transaction(owner, async (store) => { const entry = this.entry(store, owner, reserved.run.id); if (!entry.run.upstreamId) { this.interrupt(entry.run, 'collection_start_unconfirmed'); entry.run.unknownUntil = this.unknownExpiry(reserved.recipe, entry.run.startedAt); delete entry.startLease; await this.save(store); } }).catch(() => undefined);
      return await this.transaction(owner, (store) => this.entry(store, owner, reserved.run.id).run);
    }
  }
  async listRuns(owner: string): Promise<CollectionRun[]> {
    this.owner(owner); this.poll();
    const runs = await this.transaction(owner, (store) => store.runs.filter((entry) => entry.ownerId === owner).map((entry) => entry.run));
    const result: CollectionRun[] = []; for (const run of runs) result.push(run.upstreamId && run.archiveState !== 'completed' ? await this.refresh(owner, run.id) : run);
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async getRun(owner: string, id: string): Promise<CollectionRun> { const run = await this.transaction(owner, (store) => this.entry(store, owner, id).run); this.poll(); return run.upstreamId && run.archiveState !== 'completed' ? this.refresh(owner, id) : run; }
  async stopRun(owner: string, id: string): Promise<CollectionRun> {
    const run = await this.getRun(owner, id); if (!run.upstreamId && run.state === 'starting') fail('run_starting', 409); if (!run.upstreamId) return run; if (terminal(run.upstreamState)) return this.finalizeRun(owner, id);
    const driver = this.driver(run.moduleId, run.moduleVersion); const descriptor = await driver.describe(owner); if (!descriptor.canStop || !driver.stop) fail('module_stop_unavailable', 503);
    try { await driver.stop(run.upstreamId, owner); } catch (error) { await this.transaction(owner, async (store) => { this.entry(store, owner, id).run.error = safeCode(error, 'stop_unconfirmed'); await this.save(store); }); throw new CollectionWorkspaceError('collection_stop_unconfirmed', 502); }
    const stopped = await this.refresh(owner, id); return terminal(stopped.upstreamState) ? this.finalizeRun(owner, id) : stopped;
  }
  async adoptRun(owner: string, input: unknown): Promise<CollectionRun> {
    this.owner(owner); const schema = saveSchema.omit({ pipelineId: true, moduleVersion: true, filter: true, quality: true }).extend({ upstreamId: opaque }).strict(); const parsed = parse(schema, input); const driver = this.driver(parsed.moduleId, '1.0.0'); const descriptor = await driver.describe(owner);
    if (!descriptor.available || !driver.inspect || !driver.export) fail('module_adoption_unavailable', 503);
    const config = await this.validate(driver, parsed.config, owner); let inspection: CollectionInspection;
    try { inspection = parse(inspectionSchema, await driver.inspect(parsed.upstreamId, owner)); } catch (error) { throw new CollectionWorkspaceError(safeCode(error, 'upstream_not_authorized'), (error as { status?: number })?.status === 404 ? 404 : 403); }
    const run = await this.transaction(owner, async (store) => {
      const existing = store.runs.find((entry) => entry.ownerId === owner && entry.run.moduleId === parsed.moduleId && entry.run.upstreamId === parsed.upstreamId); if (existing) return existing.run;
      if (store.pipelines.length >= MAX_PIPELINES) fail('pipeline_quota_exceeded', 409); if (!terminal(inspection.state)) this.capacity(store, owner); else if (store.runs.length >= MAX_RUNS) fail('run_quota_exceeded', 409);
      const now = this.iso(); const version: CollectionPipelineVersion = { name: parsed.name, project: parsed.project, source: parsed.source, moduleId: parsed.moduleId, moduleVersion: '1.0.0', config, createDataset: parsed.createDataset, version: 1, createdAt: now };
      const pipeline: CollectionPipeline = { id: randomUUID(), name: version.name, project: version.project, source: version.source, moduleId: version.moduleId, moduleVersion: version.moduleVersion, currentVersion: 1, versions: [version], createdAt: now, updatedAt: now }; store.pipelines.push({ ownerId: owner, ownerHash: hash(owner), pipeline });
      const run = this.newRun(pipeline.id, version); run.origin = 'adopted'; run.upstreamId = parsed.upstreamId; this.inspection(run, inspection); store.runs.push({ ownerId: owner, ownerHash: hash(owner), run }); await this.save(store); return run;
    });
    this.poll(); return run;
  }
  async finalizeRun(owner: string, id: string): Promise<CollectionRun> {
    const current = await this.getRun(owner, id); if (current.archiveState === 'completed') return current;
    if (!current.upstreamId || !terminal(current.upstreamState)) fail('run_not_terminal', 409);
    const reserved = await this.transaction(owner, async (store) => {
      const entry = this.entry(store, owner, id); if (entry.finalizeLease && this.leaseAlive(entry.finalizeLease)) return null;
      const pipeline = this.version(this.pipeline(store, owner, entry.run.pipelineId), entry.run.pipelineVersion); entry.finalizeLease = this.lease(); await this.save(store); return { run: entry.run, pipeline, lease: entry.finalizeLease };
    });
    if (!reserved) return this.transaction(owner, (store) => this.entry(store, owner, id).run);
    let working = clone(reserved.run);
    try {
      const driver = this.driver(working.moduleId, working.moduleVersion); if (!driver.export) fail('export_unavailable', 503);
      const exported = await driver.export(working.upstreamId!, owner);
      if (!Buffer.isBuffer(exported.bytes) || exported.bytes.length > MAX_ARTIFACT_BYTES || !short(200).safeParse(exported.filename).success || /[\\/]/.test(exported.filename) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(exported.mimeType) || !['log', 'document'].includes(exported.kind)) fail('invalid_artifact', 502);
      let artifact: CollectionArtifact = { filename: exported.filename, mimeType: exported.mimeType, kind: exported.kind, bytes: Buffer.from(exported.bytes) };
      const filter = working.nodeStates.find((node) => node.kind === 'filter');
      if (filter && reserved.pipeline.filter) {
        filter.state = 'running'; filter.startedAt = this.iso(); delete filter.error;
        if (!artifact.mimeType.startsWith('text/') || artifact.bytes.length > 16 * MiB) fail('filter_requires_bounded_text', 415);
        let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes); } catch { fail('filter_invalid_utf8', 415); }
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []; if (lines.length > 200_000) fail('filter_line_limit', 413);
        const keywords = reserved.pipeline.filter.keywords.map((value) => value.toLowerCase()); const include = reserved.pipeline.filter.mode === 'include';
        const bytes = Buffer.from(lines.filter((line) => keywords.some((word) => line.toLowerCase().includes(word)) === include).join(''));
        artifact = { ...artifact, bytes, rawBytes: artifact.bytes, rawFilename: artifact.filename }; filter.state = 'completed'; filter.endedAt = this.iso(); filter.byteCount = bytes.length;
      }
      const quality = working.nodeStates.find((node) => node.kind === 'quality')!; quality.state = 'running'; quality.startedAt = this.iso(); quality.byteCount = artifact.bytes.length; delete quality.error;
      if (!artifact.bytes.length || artifact.bytes.length < (reserved.pipeline.quality?.minBytes ?? 1)) { quality.state = 'failed'; quality.error = 'collection_quality_min_bytes'; quality.endedAt = this.iso(); fail('quality_min_bytes', 422); }
      quality.state = 'completed'; quality.endedAt = this.iso();
      return await this.transaction(owner, async (store) => {
        const entry = this.entry(store, owner, id); if (entry.finalizeLease?.token !== reserved.lease.token) fail('archive_receipt_conflict', 409);
        const archiveNode = working.nodeStates.find((node) => node.kind === 'archive')!; archiveNode.state = 'running'; archiveNode.startedAt = this.iso(); archiveNode.byteCount = artifact.bytes.length; delete archiveNode.error;
        const result = await this.archive(owner, clone(working), clone(reserved.pipeline), artifact);
        const receipt = parse(z.object({ assetIds: z.array(uuid).min(1).max(10), datasetId: uuid.optional() }).strict(), result);
        if (new Set(receipt.assetIds).size !== receipt.assetIds.length || (reserved.pipeline.createDataset && !receipt.datasetId)) fail('invalid_archive_receipt', 502);
        archiveNode.state = 'completed'; archiveNode.endedAt = this.iso(); working.assetIds = receipt.assetIds; if (receipt.datasetId) working.datasetId = receipt.datasetId;
        working.archiveState = 'completed'; delete working.archiveError; delete working.error; working.state = working.upstreamState === 'failed' ? 'failed' : working.upstreamState === 'stopped' ? 'stopped' : 'completed'; if (working.upstreamState === 'failed') working.error = reserved.run.error ?? 'collection_source_failed'; working.endedAt = this.iso(); entry.run = working; delete entry.finalizeLease; await this.save(store); return entry.run;
      });
    } catch (error) {
      return this.transaction(owner, async (store) => {
        const entry = this.entry(store, owner, id); if (entry.finalizeLease?.token !== reserved.lease.token) return entry.run;
        working.archiveState = 'failed'; working.archiveError = safeCode(error, 'archive_failed'); working.state = 'failed'; working.error = working.archiveError; working.endedAt = this.iso();
        const archiveNode = working.nodeStates.find((node) => node.kind === 'archive')!; archiveNode.state = working.nodeStates.some((node) => node.kind !== 'archive' && node.state === 'failed') ? 'skipped' : 'failed'; archiveNode.error = working.archiveError; archiveNode.endedAt = this.iso();
        for (const node of working.nodeStates) if (node.state === 'running' || node.state === 'pending') { node.state = node.kind === 'filter' ? 'failed' : 'skipped'; if (node.kind === 'filter') node.error = working.archiveError; }
        entry.run = working; delete entry.finalizeLease; await this.save(store); return entry.run;
      });
    }
  }
  async withExclusiveStorageLock<T>(action: () => Promise<T>): Promise<T> { return this.transaction('', async () => action(), true); }
  async backupTo(outputDir: string): Promise<{ path: string; completedAt: string }> {
    const output = resolve(outputDir); if (output === this.stateDir || output.startsWith(this.stateDir + '/')) fail('invalid_backup_directory');
    return this.transaction('', async (store) => {
      await mkdir(output, { mode: 0o700 });
      try { const snapshot = clone(store); for (const entry of snapshot.runs) { delete entry.startLease; delete entry.finalizeLease; if (entry.run.state === 'starting') this.interrupt(entry.run, 'collection_backup_start_unconfirmed'); }
        await this.writeAtomic(join(output, 'manifest.json'), this.envelope(snapshot)); return { path: output, completedAt: this.iso() };
      } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
    }, true);
  }
  async dispose(): Promise<void> { this.disposed = true; if (this.timer) clearInterval(this.timer); await this.polling; const set = instances.get(this.stateDir); set?.delete(this.instanceId); if (!set?.size) instances.delete(this.stateDir); }

  private owner(owner: string) { if (this.disposed) fail('service_closed', 503); if (!short(500).safeParse(owner).success || owner === 'ops-admin') fail('identity_required', 403); }
  private iso() { return new Date(this.now()).toISOString(); }
  private driver(id: string, version: string): CollectionWorkspaceDriver { const driver = this.drivers.get(id); if (!driver || driver.version !== version) fail('module_version_unavailable', 503); return driver; }
  private async validate(driver: CollectionWorkspaceDriver, config: unknown, owner: string) { if (!safeConfig(config)) fail('invalid_configuration'); try { return parse(configSchema, await driver.validate(clone(config), owner)); } catch (error) { if (error instanceof CollectionWorkspaceError) throw error; throw new CollectionWorkspaceError(safeCode(error, 'invalid_configuration'), (error as { status?: number })?.status === 404 ? 404 : 400); } }
  private recipe(input: z.infer<typeof saveSchema>): z.infer<typeof recipeSchema> { const { pipelineId: _id, ...recipe } = input; return recipe; }
  private pipeline(store: Store, owner: string, id: string): CollectionPipeline { if (!uuid.safeParse(id).success) fail('pipeline_not_found', 404); const entry = store.pipelines.find((entry) => entry.ownerId === owner && entry.pipeline.id === id); if (!entry) fail('pipeline_not_found', 404); return entry.pipeline; }
  private version(pipeline: CollectionPipeline, version = pipeline.currentVersion): CollectionPipelineVersion { if (!Number.isSafeInteger(version)) fail('invalid_version'); const found = pipeline.versions.find((entry) => entry.version === version); if (!found) fail('version_not_found', 404); return found; }
  private entry(store: Store, owner: string, id: string): RunEntry { if (!uuid.safeParse(id).success) fail('run_not_found', 404); const entry = store.runs.find((entry) => entry.ownerId === owner && entry.run.id === id); if (!entry) fail('run_not_found', 404); return entry; }
  private capacity(store: Store, owner: string) { if (store.runs.length >= MAX_RUNS) fail('run_quota_exceeded', 409); const occupied = (run: CollectionRun) => active(run) || (run.state === 'interrupted' && !run.upstreamId && !!run.unknownUntil && Date.parse(run.unknownUntil) > this.now()); if (store.runs.filter((entry) => occupied(entry.run)).length >= 4 || store.runs.filter((entry) => entry.ownerId === owner && occupied(entry.run)).length >= 2) fail('concurrency_limit', 429); }
  private unknownExpiry(version: CollectionPipelineVersion, startedAt: string) { const value = version.config.durationSeconds; const duration = typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1800 ? value : 1800; return new Date(Date.parse(startedAt) + (duration + 120) * 1000).toISOString(); }
  private newRun(pipelineId: string, version: CollectionPipelineVersion): CollectionRun { const now = this.iso(); const kinds: CollectionNodeState['kind'][] = ['source', ...(version.filter ? ['filter' as const] : []), 'quality', 'archive']; return { id: randomUUID(), pipelineId, pipelineVersion: version.version, moduleId: version.moduleId, moduleVersion: version.moduleVersion, origin: 'started', state: 'starting', nodeStates: kinds.map((kind) => ({ id: kind, kind, state: kind === 'source' ? 'running' : 'pending', ...(kind === 'source' ? { startedAt: now } : {}) })), assetIds: [], startedAt: now, recordCount: 0, byteCount: 0, archiveState: 'pending' }; }
  private inspection(run: CollectionRun, result: CollectionInspection) {
    run.upstreamState = result.state; run.recordCount = result.recordCount; run.byteCount = result.byteCount; const source = run.nodeStates[0];
    delete run.unknownUntil; if (!result.error) { delete source.error; if (run.archiveState !== 'failed') delete run.error; }
    if (result.startedAt) source.startedAt = result.startedAt;
    if (terminal(result.state)) { source.state = result.state === 'failed' ? 'failed' : 'completed'; source.endedAt = result.endedAt ?? this.iso(); source.byteCount = Math.min(result.byteCount, MAX_ARTIFACT_BYTES); if (result.error) { source.error = result.error; run.error = result.error; } run.state = run.archiveState === 'failed' || result.state === 'failed' ? 'failed' : run.archiveState === 'completed' ? result.state === 'stopped' ? 'stopped' : 'completed' : 'running'; }
    else if (run.archiveState !== 'completed') { run.state = 'running'; source.state = 'running'; delete source.endedAt; delete run.endedAt; }
  }
  private refresh(owner: string, id: string): Promise<CollectionRun> {
    const key = owner + ':' + id; const existing = this.refreshing.get(key); if (existing) return existing;
    const promise = (async () => {
      const run = await this.transaction(owner, (store) => this.entry(store, owner, id).run); if (!run.upstreamId || run.archiveState === 'completed') return run;
      try { const driver = this.driver(run.moduleId, run.moduleVersion); if (!driver.inspect) fail('inspect_unavailable', 503); const result = parse(inspectionSchema, await driver.inspect(run.upstreamId, owner)); return await this.transaction(owner, async (store) => { const entry = this.entry(store, owner, id); if (!entry.finalizeLease && entry.run.archiveState !== 'completed') { this.inspection(entry.run, result); await this.save(store); } return entry.run; }); }
      catch (error) { return this.transaction(owner, async (store) => { const entry = this.entry(store, owner, id); if (!entry.finalizeLease && entry.run.archiveState !== 'completed') { this.interrupt(entry.run, safeCode(error, 'inspect_unconfirmed')); await this.save(store); } return entry.run; }); }
    })(); this.refreshing.set(key, promise); void promise.finally(() => { if (this.refreshing.get(key) === promise) this.refreshing.delete(key); }).catch(() => undefined); return promise;
  }
  private interrupt(run: CollectionRun, code: string) { run.state = 'interrupted'; run.error = code; run.endedAt = this.iso(); delete run.upstreamState; run.nodeStates[0].state = 'interrupted'; run.nodeStates[0].error = code; for (const node of run.nodeStates.slice(1)) if (node.state === 'pending' || node.state === 'running') node.state = 'skipped'; }
  private lease(): Lease { return { pid: process.pid, instanceId: this.instanceId, token: randomUUID() }; }
  private alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return !errno(error, 'ESRCH'); } }
  private leaseAlive(lease: Lease) { return this.alive(lease.pid) && (lease.pid !== process.pid || instances.get(this.stateDir)?.has(lease.instanceId)); }
  private poll() { if (this.timer || !this.interval || this.disposed) return; this.timer = setInterval(() => { if (!this.polling) { this.polling = this.tick().catch(() => undefined).finally(() => { this.polling = undefined; }); } }, this.interval); this.timer.unref(); }
  private async tick() { const pending = await this.transaction('', (store) => store.runs.filter((entry) => entry.run.upstreamId && entry.run.archiveState === 'pending' && entry.run.state !== 'interrupted').map((entry) => ({ owner: entry.ownerId, id: entry.run.id })), true); for (const entry of pending) { if (this.disposed) return; const run = await this.refresh(entry.owner, entry.id); if (terminal(run.upstreamState)) await this.finalizeRun(entry.owner, entry.id); } }

  private envelope(store: Store): Buffer { const payload = storeSchema.parse(store); const buffer = Buffer.from(JSON.stringify({ sha256: hash(JSON.stringify(payload)), payload })); if (buffer.length > 16 * MiB) fail('metadata_quota_exceeded', 409); return buffer; }
  private async save(store: Store) { await this.writeAtomic(join(this.stateDir, 'manifest.json'), this.envelope(store)); }
  private async writeAtomic(filename: string, data: Buffer) { const temporary = filename + '.' + randomUUID() + '.tmp'; const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(data); await file.sync(); } finally { await file.close(); } await rename(temporary, filename); const directory = await open(filename.slice(0, filename.lastIndexOf('/')), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
  private async readSafe(filename: string, limit: number) { const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) fail('state_integrity_failure', 503); return await file.readFile(); } finally { await file.close(); } }
  private async load(): Promise<Store> {
    let store: Store;
    try { const envelope = envelopeSchema.parse(JSON.parse((await this.readSafe(join(this.stateDir, 'manifest.json'), 16 * MiB)).toString())); if (envelope.sha256 !== hash(JSON.stringify(envelope.payload))) fail('state_integrity_failure', 503); store = envelope.payload; }
    catch (error) { if (errno(error, 'ENOENT')) { try { await lstat(join(this.stateDir, 'initialized')); fail('state_integrity_failure', 503); } catch (cause) { if (!errno(cause, 'ENOENT')) throw cause; } store = { schemaVersion: 1, pipelines: [], runs: [] }; await this.save(store); } else if (error instanceof CollectionWorkspaceError) throw error; else fail('state_integrity_failure', 503); }
    try { const marker = await open(join(this.stateDir, 'initialized'), 'wx', 0o600); try { await marker.writeFile(COLLECTION_WORKSPACE_CONTRACT); await marker.sync(); } finally { await marker.close(); } } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
    const ids = new Set<string>(); let changed = false;
    for (const entry of store.pipelines) { if (entry.ownerHash !== hash(entry.ownerId) || ids.has(entry.pipeline.id) || entry.pipeline.currentVersion !== entry.pipeline.versions.length || entry.pipeline.versions.some((version, index) => version.version !== index + 1)) fail('state_integrity_failure', 503); ids.add(entry.pipeline.id); const latest = entry.pipeline.versions.at(-1)!; for (const key of ['name', 'project', 'source', 'moduleId', 'moduleVersion'] as const) if (entry.pipeline[key] !== latest[key]) fail('state_integrity_failure', 503); }
    for (const entry of store.runs) {
      if (entry.ownerHash !== hash(entry.ownerId) || ids.has(entry.run.id)) fail('state_integrity_failure', 503); ids.add(entry.run.id);
      const pipeline = store.pipelines.find((item) => item.ownerId === entry.ownerId && item.pipeline.id === entry.run.pipelineId)?.pipeline; const version = pipeline?.versions.find((version) => version.version === entry.run.pipelineVersion);
      if (!version || version.moduleId !== entry.run.moduleId || version.moduleVersion !== entry.run.moduleVersion || JSON.stringify(entry.run.nodeStates.map((node) => node.id)) !== JSON.stringify(['source', ...(version.filter ? ['filter'] : []), 'quality', 'archive']) || entry.run.nodeStates.some((node) => node.id !== node.kind) || new Set(entry.run.assetIds).size !== entry.run.assetIds.length) fail('state_integrity_failure', 503);
      if (entry.run.archiveState === 'completed' && (!entry.run.assetIds.length || (version.createDataset && !entry.run.datasetId) || entry.run.nodeStates.at(-1)?.state !== 'completed' || !terminal(entry.run.upstreamState))) fail('state_integrity_failure', 503);
      if (entry.run.archiveState === 'completed' && (entry.run.state !== (entry.run.upstreamState === 'failed' ? 'failed' : entry.run.upstreamState === 'stopped' ? 'stopped' : 'completed') || entry.run.nodeStates.slice(1).some((node) => node.state !== 'completed') || !entry.run.nodeStates.at(-1)?.byteCount || entry.run.nodeStates[0].state !== (entry.run.upstreamState === 'failed' ? 'failed' : 'completed'))) fail('state_integrity_failure', 503);
      if (['completed', 'stopped'].includes(entry.run.state) && entry.run.archiveState !== 'completed') fail('state_integrity_failure', 503);
      if ((!entry.run.upstreamId && entry.run.state === 'running') || (entry.startLease && entry.run.state !== 'starting')) fail('state_integrity_failure', 503);
      if (entry.run.state === 'starting' && (!entry.startLease || !this.leaseAlive(entry.startLease))) { this.interrupt(entry.run, 'collection_start_interrupted'); entry.run.unknownUntil = this.unknownExpiry(version, entry.run.startedAt); delete entry.startLease; changed = true; }
      if (entry.finalizeLease && !this.leaseAlive(entry.finalizeLease)) { delete entry.finalizeLease; entry.run.archiveState = 'failed'; entry.run.archiveError = 'collection_archive_interrupted'; entry.run.state = 'failed'; const node = entry.run.nodeStates.at(-1)!; node.state = 'failed'; node.error = entry.run.archiveError; changed = true; }
    }
    if (changed) await this.save(store); return store;
  }
  private async claim(filename: string): Promise<(() => Promise<void>) | null> {
    const token = randomUUID(); const temporary = filename + '.owner.' + process.pid + '.' + token + '.tmp'; const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
    try { try { await link(temporary, filename); } catch (error) { if (errno(error, 'EEXIST')) return null; throw error; } return async () => { const current = await this.lockOwner(filename); if (current?.pid === process.pid && current.token === token) await unlink(filename).catch((error) => { if (!errno(error, 'ENOENT')) throw error; }); }; } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async lockOwner(filename: string): Promise<{ pid: number; token: string } | null> { try { return z.object({ pid: z.number().int().min(1).max(2147483647), token: uuid }).strict().parse(JSON.parse((await this.readSafe(filename, 1024)).toString())); } catch (error) { if (errno(error, 'ENOENT')) return null; fail('state_lock_integrity_failure', 503); } }
  private async recoverClaim(filename: string, depth = 0): Promise<void> { const owner = await this.lockOwner(filename); if (!owner || this.alive(owner.pid)) return; if (depth >= 3) fail('state_lock_recovery_required', 503); const recovery = filename + '.recover-' + owner.token; let release = await this.claim(recovery); if (!release) { await this.recoverClaim(recovery, depth + 1); release = await this.claim(recovery); if (!release) return; } try { const current = await this.lockOwner(filename); if (current?.pid === owner.pid && current.token === owner.token && !this.alive(current.pid)) await unlink(filename).catch((error) => { if (!errno(error, 'ENOENT')) throw error; }); } finally { await release(); } }
  private async lock() { const filename = join(this.stateDir, 'store.lock'); const deadline = Date.now() + 12_000; do { const release = await this.claim(filename); if (release) return release; await this.recoverClaim(filename); await sleep(25); } while (Date.now() < deadline); fail('store_busy', 503); }
  private async transaction<T>(owner: string, action: (store: Store) => T | Promise<T>, internal = false): Promise<T> {
    if (!internal) this.owner(owner); const previous = queues.get(this.stateDir) ?? Promise.resolve(); let releaseQueue!: () => void; const next = new Promise<void>((done) => { releaseQueue = done; }); queues.set(this.stateDir, next); await previous;
    let release: (() => Promise<void>) | undefined;
    try { await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const stat = await lstat(this.stateDir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_state_directory', 503); await chmod(this.stateDir, 0o700); release = await this.lock(); const store = await this.load(); return clone(await action(store)); }
    finally { try { await release?.(); } finally { releaseQueue(); if (queues.get(this.stateDir) === next) queues.delete(this.stateDir); } }
  }
}
