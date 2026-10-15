/** Private single-host data custody. Devices upload bytes; no network fetching or remote execution. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const DATA_CENTER_CONTRACT = 'rdk.data-center.v1';
const MiB = 1024 * 1024;
const MAX_DATASET_ASSETS = 300;
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\x00-\x1f\x7f]/.test(v));
const prose = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const uuid = z.string().uuid();
const stamp = z.string().datetime();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const dataAssetKindSchema = z.enum(['raw', 'image', 'video', 'log', 'metric', 'event', 'sensor', 'document', 'model', 'other']);
export const dataSourceSchema = z.enum(['cloud', 'edge']);
const commonAsset = z.object({ title: text(160), kind: dataAssetKindSchema, source: dataSourceSchema, project: text(120), targetId: text(160).optional(), description: prose(2000).optional(), tags: z.array(text(60)).max(20).default([]), collectedAt: stamp.optional() }).strict();
const reference = z.string().max(2000).refine((value) => {
  try {
    const uri = new URL(value);
    return ['https:', 's3:', 'gs:'].includes(uri.protocol) && !!uri.hostname && !uri.username && !uri.password && !uri.search && !uri.hash && !/[\x00-\x20\x7f\\]/.test(value) && !/%(?:00|0a|0d)/i.test(value) && !/(?:token|secret|password|credential|signature|apikey|api-key)=/i.test(decodeURIComponent(uri.pathname));
  } catch { return false; }
}, 'Use a reference without credentials, query strings or fragments');
export const externalAssetInputSchema = commonAsset.extend({ referenceUri: reference }).strict();
export const uploadAssetInputSchema = commonAsset.extend({ filename: text(200).refine((v) => !/[\\/]/.test(v) && v !== '.' && v !== '..'), mimeType: z.string().max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/), sha256: sha, taskId: uuid.optional() }).strict();
export const collectionUploadInputSchema = uploadAssetInputSchema.partial({ title: true, kind: true, source: true, project: true }).strict();
export const taskInputSchema = z.object({ title: text(160), source: dataSourceSchema, project: text(120), targetId: text(160), kind: dataAssetKindSchema, expectedCount: z.number().int().min(1).max(1000), description: prose(2000).optional() }).strict();
export const taskStatusInputSchema = z.object({ status: z.enum(['collecting', 'completed', 'failed', 'cancelled']), notes: prose(2000).optional() }).strict();
export const datasetInputSchema = z.object({ name: text(160), project: text(120), assetIds: z.array(uuid).min(1).max(MAX_DATASET_ASSETS), description: prose(2000).optional() }).strict();
const baselineSchema = z.object({ metric: text(120), value: z.number().finite(), unit: text(40).optional(), assetId: uuid, version: text(160) }).strict();
const criterionSchema = z.object({ direction: z.enum(['increase', 'decrease']), threshold: z.number().finite().min(0) }).strict();
export const loopInputSchema = z.object({ title: text(160), goal: prose(2000), project: text(120), targetId: text(160), datasetId: uuid, baseline: baselineSchema, criterion: criterionSchema }).strict();
export const evidenceInputSchema = z.object({ stage: z.enum(['analysis', 'evaluation', 'deployment', 'verification']), assetId: uuid, version: text(160), targetId: text(160), notes: prose(2000), baselineValue: z.number().finite().optional(), candidateValue: z.number().finite().optional() }).strict();
const provenanceSchema = z.object({ system: z.literal('vision-workshop'), experimentId: uuid, artifactId: text(160), artifactType: z.enum(['raw', 'processed', 'candidate', 'receipt']), version: text(160).optional() }).strict();
const assetSchema = commonAsset.extend({ id: uuid, sizeBytes: z.number().int().min(0), storage: z.enum(['uploaded', 'external']), filename: text(200).optional(), mimeType: text(100).optional(), sha256: sha.optional(), taskId: uuid.optional(), referenceUri: reference.optional(), provenance: provenanceSchema.optional(), createdAt: stamp }).strict();
const taskSchema = taskInputSchema.extend({ id: uuid, status: z.enum(['planned', 'collecting', 'completed', 'failed', 'cancelled']), assetIds: z.array(uuid).max(1000), notes: prose(2000).optional(), createdAt: stamp, updatedAt: stamp }).strict();
const datasetSchema = datasetInputSchema.extend({ id: uuid, version: z.number().int().min(1), assets: z.array(assetSchema).min(1).max(MAX_DATASET_ASSETS), createdAt: stamp }).strict();
const evidenceSchema = evidenceInputSchema.extend({ id: uuid, sha256: sha, createdAt: stamp, measurementSource: z.literal('reported').optional(), improvement: z.number().finite().optional(), passed: z.boolean().optional(), criterion: criterionSchema.optional() }).strict();
const loopSchema = loopInputSchema.extend({ id: uuid, status: z.enum(['open', 'analyzed', 'evaluated', 'deployed', 'verified', 'verification_failed']), evidence: z.array(evidenceSchema).max(64), createdAt: stamp, updatedAt: stamp }).strict();
const accountSchema = z.object({ ownerHash: sha, assets: z.array(assetSchema).max(10000), tasks: z.array(taskSchema).max(2000), datasets: z.array(datasetSchema).max(2000), loops: z.array(loopSchema).max(2000), collectionTokens: z.record(sha) }).strict();
const storeSchema = z.object({ schemaVersion: z.literal(1), accounts: z.array(accountSchema).max(2000) }).strict();
const envelopeSchema = z.object({ sha256: sha, payload: storeSchema }).strict();
type Store = z.infer<typeof storeSchema>;
type Account = z.infer<typeof accountSchema>;
export type DataAsset = z.infer<typeof assetSchema>;
export type DataTask = z.infer<typeof taskSchema>;
export type DataDataset = z.infer<typeof datasetSchema>;
export type DataLoop = z.infer<typeof loopSchema>;
export type DataEvidence = z.infer<typeof evidenceSchema>;
export type DataAssetProvenance = z.infer<typeof provenanceSchema>;
export interface DataCenterLimits { maxAssetBytes: number; maxUploadedBytes: number; maxAssets: number; maxTasks: number; maxDatasets: number; maxLoops: number }
export interface DataCenterOptions extends Partial<DataCenterLimits> { dataDir?: string }
export class DataCenterError extends Error { constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'DataCenterError'; } }
function fail(code: string, status = 400): never { throw new DataCenterError('data_center_' + code, status); }
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const queues = new Map<string, Promise<void>>();
function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  return value;
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const validId = (value: string) => { if (!uuid.safeParse(value).success) fail('not_found', 404); return value; };
const terminal = (task: DataTask) => ['completed', 'failed', 'cancelled'].includes(task.status);

export class DataCenterService {
  readonly dataDir: string;
  readonly limits: DataCenterLimits;
  constructor(options: DataCenterOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.RDK_DATA_CENTER_STATE_DIR ?? join(homedir(), '.local', 'state', 'd-obs', 'data-center'));
    const limit = (value: number | undefined, fallback: number, ceiling: number) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) throw new Error('Invalid data center quota');
      return result;
    };
    this.limits = { maxAssetBytes: limit(options.maxAssetBytes, 64 * MiB, 64 * MiB), maxUploadedBytes: limit(options.maxUploadedBytes, 2 * 1024 * MiB, 10 * 1024 * MiB), maxAssets: limit(options.maxAssets, 2000, 10000), maxTasks: limit(options.maxTasks, 500, 2000), maxDatasets: limit(options.maxDatasets, 500, 2000), maxLoops: limit(options.maxLoops, 500, 2000) };
  }
  capabilities() {
    return { quota: { ...this.limits, maxDatasetAssets: MAX_DATASET_ASSETS }, maxDatasetAssets: MAX_DATASET_ASSETS, assetKinds: dataAssetKindSchema.options, sources: dataSourceSchema.options, collection: { status: 'available', mode: 'scoped-token-upload', remoteExecution: 'unavailable', description: '采集任务规划与真实文件接收；不宣称终端已连接或远程命令已执行。' }, externalReferences: { status: 'available', validation: 'syntax-only', fetched: false }, verification: { method: 'reported-metric-threshold', measurementSource: 'reported', description: '对证据关联的申报指标按固定基线和阈值判定；平台不冒充设备测量。' } };
  }
  async listAssets(owner: string, filter: { kind?: string; source?: string; project?: string; search?: string } = {}) {
    return this.transaction(owner, (_store, account) => account.assets.filter((asset) => (!filter.kind || asset.kind === filter.kind) && (!filter.source || asset.source === filter.source) && (!filter.project || asset.project === filter.project) && (!filter.search || `${asset.title} ${asset.description ?? ''} ${asset.project} ${asset.tags.join(' ')}`.toLowerCase().includes(filter.search.toLowerCase()))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async getAsset(owner: string, assetId: string) { return this.transaction(owner, (_store, account) => this.asset(account, assetId)); }
  async createAsset(owner: string, input: unknown): Promise<DataAsset> {
    const parsed = externalAssetInputSchema.parse(input);
    return this.transaction(owner, async (store, account) => {
      this.assertQuota(store, 'assets');
      const asset: DataAsset = { ...parsed, id: randomUUID(), sizeBytes: 0, storage: 'external', createdAt: iso() };
      account.assets.push(asset); await this.save(store); return asset;
    });
  }
  async uploadAsset(owner: string, input: unknown, data: Buffer): Promise<DataAsset> {
    const parsed = uploadAssetInputSchema.parse(input); this.validateBytes(parsed.sha256, data);
    return this.transaction(owner, (store, account) => this.archive(store, account, parsed, data));
  }
  /** Trusted composition-root bridge only. HTTP metadata cannot declare this provenance. */
  async importVerifiedAsset(owner: string, input: unknown, data: Buffer, provenance: DataAssetProvenance): Promise<DataAsset> {
    const parsed = uploadAssetInputSchema.parse(input); const origin = provenanceSchema.parse(provenance); this.validateBytes(parsed.sha256, data);
    return this.transaction(owner, async (store, account) => {
      const existing = account.assets.find((asset) => asset.provenance?.system === origin.system && asset.provenance.experimentId === origin.experimentId && asset.provenance.artifactId === origin.artifactId && asset.provenance.artifactType === origin.artifactType && asset.sha256 === parsed.sha256 && asset.project === parsed.project);
      if (existing) { await this.bytes(existing); return existing; }
      return this.archive(store, account, parsed, data, origin);
    });
  }
  async readAsset(owner: string, assetId: string): Promise<{ asset: DataAsset; data: Buffer }> { return this.transaction(owner, async (_store, account) => { const asset = this.asset(account, assetId); return { asset, data: await this.bytes(asset) }; }); }
  async deleteAsset(owner: string, assetId: string) {
    return this.transaction(owner, async (store, account) => {
      const asset = this.asset(account, assetId);
      if (account.datasets.some((dataset) => dataset.assetIds.includes(asset.id)) || account.loops.some((loop) => loop.baseline.assetId === asset.id || loop.evidence.some((item) => item.assetId === asset.id)) || account.tasks.some((task) => task.status === 'completed' && task.assetIds.includes(asset.id))) fail('asset_in_use', 409);
      account.assets = account.assets.filter((item) => item.id !== asset.id);
      for (const task of account.tasks) if (task.assetIds.includes(asset.id)) { task.assetIds = task.assetIds.filter((id) => id !== asset.id); task.updatedAt = iso(); }
      // Commit logical deletion first. Interrupted unlink is safely cleaned by recovery.
      await this.save(store); if (asset.storage === 'uploaded') await unlink(this.blob(asset.id)).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; });
      return { id: asset.id, deleted: true };
    });
  }
  async listTasks(owner: string) { return this.transaction(owner, (_store, account) => [...account.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async createTask(owner: string, input: unknown): Promise<DataTask> {
    const parsed = taskInputSchema.parse(input);
    return this.transaction(owner, async (store, account) => { this.assertQuota(store, 'tasks'); const now = iso(); const task: DataTask = { ...parsed, id: randomUUID(), status: 'planned', assetIds: [], createdAt: now, updatedAt: now }; account.tasks.push(task); await this.save(store); return task; });
  }
  async updateTaskStatus(owner: string, taskId: string, input: unknown): Promise<DataTask> {
    const parsed = taskStatusInputSchema.parse(input);
    return this.transaction(owner, async (store, account) => {
      const task = this.task(account, taskId);
      if (terminal(task) || (task.status === 'planned' && parsed.status === 'completed')) fail('invalid_task_transition', 409);
      if (parsed.status === 'completed') { if (task.assetIds.length !== task.expectedCount) fail('collection_incomplete', 409); for (const id of task.assetIds) await this.bytes(this.asset(account, id)); }
      task.status = parsed.status; task.updatedAt = iso(); if (parsed.notes !== undefined) task.notes = parsed.notes;
      if (terminal(task)) delete account.collectionTokens[task.id];
      await this.save(store); return task;
    });
  }
  async rotateCollectionToken(owner: string, taskId: string) {
    return this.transaction(owner, async (store, account) => {
      const task = this.task(account, taskId); if (terminal(task)) fail('task_closed', 409);
      const token = randomBytes(32).toString('base64url'); account.collectionTokens[task.id] = digest(token); await this.save(store);
      return { token, taskId: task.id, ingestPath: '/api/data-center/ingest/' + task.id };
    });
  }
  async validateCollectionToken(taskId: string, token: string): Promise<void> {
    validId(taskId); if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('invalid_collection_token', 403);
    await this.transaction('', (store) => {
      const supplied = Buffer.from(digest(token), 'hex');
      const account = store.accounts.find((entry) => { const expected = entry.collectionTokens[taskId]; return expected && timingSafeEqual(supplied, Buffer.from(expected, 'hex')); });
      if (!account) fail('invalid_collection_token', 403); if (terminal(this.task(account, taskId))) fail('task_closed', 409);
    }, true);
  }
  async ingestAsset(taskId: string, token: string, input: unknown, data: Buffer): Promise<DataAsset> {
    validId(taskId); if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('invalid_collection_token', 403);
    const parsed = collectionUploadInputSchema.parse(input); this.validateBytes(parsed.sha256, data);
    return this.transaction('', async (store) => {
      const supplied = Buffer.from(digest(token), 'hex');
      const account = store.accounts.find((entry) => { const expected = entry.collectionTokens[taskId]; return expected && timingSafeEqual(supplied, Buffer.from(expected, 'hex')); });
      if (!account) fail('invalid_collection_token', 403);
      if (parsed.taskId !== undefined && parsed.taskId !== taskId) fail('collection_scope_mismatch', 403);
      const task = this.task(account, taskId);
      for (const key of ['source', 'kind', 'project', 'targetId'] as const) if (parsed[key] !== undefined && parsed[key] !== task[key]) fail('collection_scope_mismatch', 403);
      const scoped = uploadAssetInputSchema.parse({ ...parsed, title: parsed.title ?? (task.title + ' · ' + parsed.filename).slice(0, 160), kind: task.kind, source: task.source, project: task.project, targetId: task.targetId, taskId });
      return this.archive(store, account, scoped, data);
    }, true);
  }
  async listDatasets(owner: string) { return this.transaction(owner, (_store, account) => [...account.datasets].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async getDataset(owner: string, datasetId: string) { return this.transaction(owner, (_store, account) => this.dataset(account, datasetId)); }
  async createDataset(owner: string, input: unknown): Promise<DataDataset> {
    const parsed = datasetInputSchema.parse(input);
    if (new Set(parsed.assetIds).size !== parsed.assetIds.length) fail('duplicate_asset_ids');
    return this.transaction(owner, async (store, account) => {
      this.assertQuota(store, 'datasets'); const assets = parsed.assetIds.map((id) => this.asset(account, id));
      if (assets.some((asset) => asset.project !== parsed.project)) fail('project_mismatch', 409);
      for (const asset of assets) if (asset.storage === 'uploaded') await this.bytes(asset);
      const version = Math.max(0, ...account.datasets.filter((dataset) => dataset.name === parsed.name && dataset.project === parsed.project).map((dataset) => dataset.version)) + 1;
      const dataset: DataDataset = { ...parsed, id: randomUUID(), version, assets: structuredClone(assets), createdAt: iso() }; account.datasets.push(dataset); await this.save(store); return dataset;
    });
  }
  /** Internal driver bridge: atomically bind verified outputs and a fixed run snapshot. */
  async archiveCollectionRun(owner: string, input: {
    runId: string; pipelineId: string; pipelineVersion: number; moduleId: string; upstreamId: string;
    name: string; project: string; source: 'cloud' | 'edge'; targetId?: string; createDataset: boolean;
    artifacts: Array<{ filename: string; mimeType: string; kind: 'log' | 'document'; bytes: Buffer; sha256: string; role: string }>;
  }): Promise<{assetIds: string[]; datasetId?: string}> {
    uuid.parse(input.runId); uuid.parse(input.pipelineId);
    if (input.artifacts.length < 1 || input.artifacts.length > 2) fail('invalid_collection_artifacts');
    const prepared = input.artifacts.map(item => {
      const metadata = uploadAssetInputSchema.parse({title:(input.name+' · '+item.role).slice(0,160),kind:item.kind,source:input.source,project:input.project,targetId:input.targetId,filename:item.filename,mimeType:item.mimeType,sha256:item.sha256,tags:['collection-run:'+input.runId,'module:'+input.moduleId,item.role],description:JSON.stringify({contract:'rdk.collection-lineage.v1',pipelineId:input.pipelineId,pipelineVersion:input.pipelineVersion,runId:input.runId,moduleId:input.moduleId,upstreamId:input.upstreamId}).slice(0,2000)});
      this.validateBytes(metadata.sha256,item.bytes);return {metadata,bytes:item.bytes};
    });
    const fixedId = (role:string) => { const h=digest('rdk.collection-archive.v1:'+input.runId+':'+role);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32); };
    if(new Set(input.artifacts.map(a=>a.role)).size!==input.artifacts.length)fail('invalid_collection_artifacts');
    return this.transaction(owner,async (store,account) => {
      const previous=account.datasets.find(d=>d.id===fixedId('dataset'));
      if(previous){const expectedIds=input.artifacts.map(a=>fixedId(a.role));if(previous.project!==input.project||previous.assetIds.length!==expectedIds.length||previous.assetIds.some(id=>!expectedIds.includes(id)))fail('collection_output_changed',409);for(const [index,item] of prepared.entries()){const asset=this.asset(account,expectedIds[index]!);await this.bytes(asset);if(asset.sha256!==item.metadata.sha256||asset.project!==input.project)fail('collection_output_changed',409);}return {assetIds:previous.assetIds,datasetId:previous.id};}
      if(input.createDataset)this.assertQuota(store,'datasets');
      const assets: DataAsset[] = [];
      for (const [index,item] of prepared.entries()) {
        const assetId=fixedId(input.artifacts[index]!.role);
        const existing = account.assets.find(a => a.id===assetId);
        if (existing) {await this.bytes(existing);if(existing.sha256!==item.metadata.sha256)fail('collection_output_changed',409);assets.push(existing);} else assets.push(await this.archive(store,account,item.metadata,item.bytes,undefined,false,assetId));
      }
      const assetIds = [...new Set(assets.map(a=>a.id))];
      let dataset:DataDataset|undefined;
      if (input.createDataset && !dataset) {
        this.assertQuota(store,'datasets');
        const name=(input.name+' · 采集结果').slice(0,160);
        const version=Math.max(0,...account.datasets.filter(d=>d.project===input.project&&d.name===name).map(d=>d.version))+1;
        dataset=datasetSchema.parse({id:fixedId('dataset'),name,project:input.project,version,assetIds,assets,description:'collection-run:'+input.runId,createdAt:iso()});account.datasets.push(dataset);
      }
      await this.save(store);return {assetIds,...(dataset?{datasetId:dataset.id}:{})};
    });
  }
  async listLoops(owner: string) { return this.transaction(owner, (_store, account) => [...account.loops].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async getLoop(owner: string, loopId: string) { return this.transaction(owner, (_store, account) => this.loop(account, loopId)); }
  async createLoop(owner: string, input: unknown): Promise<DataLoop> {
    const parsed = loopInputSchema.parse(input);
    return this.transaction(owner, async (store, account) => {
      this.assertQuota(store, 'loops'); const dataset = this.dataset(account, parsed.datasetId); const baseline = this.asset(account, parsed.baseline.assetId);
      if (dataset.project !== parsed.project || baseline.project !== parsed.project || baseline.targetId !== parsed.targetId || !dataset.assetIds.includes(baseline.id)) fail('baseline_scope_mismatch', 409);
      await this.bytes(baseline);
      const now = iso(); const loop: DataLoop = { ...parsed, id: randomUUID(), status: 'open', evidence: [], createdAt: now, updatedAt: now }; account.loops.push(loop); await this.save(store); return loop;
    });
  }
  async addEvidence(owner: string, loopId: string, input: unknown): Promise<DataLoop> {
    const parsed = evidenceInputSchema.parse(input);
    return this.transaction(owner, async (store, account) => {
      const loop = this.loop(account, loopId); if (loop.evidence.length >= 64) fail('evidence_quota_exceeded', 409);
      const allowed = { open: 'analysis', analyzed: 'evaluation', evaluated: 'deployment', deployed: 'verification', verification_failed: 'verification', verified: '' }[loop.status];
      if (allowed !== parsed.stage) fail('invalid_loop_transition', 409);
      const asset = this.asset(account, parsed.assetId);
      if (parsed.targetId !== loop.targetId || asset.targetId !== loop.targetId || asset.project !== loop.project) fail('evidence_scope_mismatch', 409);
      await this.bytes(asset); await this.bytes(this.asset(account, loop.baseline.assetId));
      if (loop.evidence.some((evidence) => evidence.assetId === asset.id && evidence.stage === parsed.stage)) fail('duplicate_evidence', 409);
      for (const prior of loop.evidence) await this.bytes(this.asset(account, prior.assetId));
      const evidence: DataEvidence = { ...parsed, id: randomUUID(), sha256: asset.sha256!, createdAt: iso() };
      if (parsed.stage === 'analysis') loop.status = 'analyzed';
      if (parsed.stage === 'evaluation') { if (parsed.version === loop.baseline.version) fail('candidate_version_required', 409); loop.status = 'evaluated'; }
      const evaluation = loop.evidence.find((item) => item.stage === 'evaluation');
      if (parsed.stage === 'deployment' || parsed.stage === 'verification') { if (parsed.version !== evaluation?.version) fail('candidate_version_mismatch', 409); }
      if (parsed.stage === 'deployment') loop.status = 'deployed';
      if (parsed.stage === 'verification') {
        if (parsed.baselineValue === undefined || parsed.candidateValue === undefined || parsed.baselineValue !== loop.baseline.value) fail('invalid_verification_measurements', 409);
        if (asset.id === loop.baseline.assetId || asset.sha256 === this.asset(account, loop.baseline.assetId).sha256 || loop.evidence.some((item) => item.assetId === asset.id || item.sha256 === asset.sha256)) fail('independent_verification_asset_required', 409);
        const improvement = loop.criterion.direction === 'increase' ? parsed.candidateValue - parsed.baselineValue : parsed.baselineValue - parsed.candidateValue;
        if (!Number.isFinite(improvement)) fail('invalid_verification_measurements');
        evidence.improvement = improvement; evidence.passed = improvement >= loop.criterion.threshold; evidence.criterion = { ...loop.criterion }; evidence.measurementSource = 'reported';
        loop.status = evidence.passed ? 'verified' : 'verification_failed';
      } else if (parsed.baselineValue !== undefined || parsed.candidateValue !== undefined) fail('measurements_only_for_verification');
      loop.evidence.push(evidence); loop.updatedAt = iso(); await this.save(store); return loop;
    });
  }
  async overview(owner: string) {
    return this.transaction(owner, (_store, account) => ({ counts: { assets: account.assets.length, tasks: account.tasks.length, datasets: account.datasets.length, loops: account.loops.length, uploadedBytes: account.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0) }, sources: { cloud: account.assets.filter((asset) => asset.source === 'cloud').length, edge: account.assets.filter((asset) => asset.source === 'edge').length }, recentTasks: [...account.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), pendingLoops: [...account.loops].filter((loop) => loop.status !== 'verified').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), quota: { ...this.limits, maxDatasetAssets: MAX_DATASET_ASSETS } }));
  }
  async manifest(owner: string) { return this.transaction(owner, (_store, account) => ({ contract: DATA_CENTER_CONTRACT, exportedAt: iso(), assets: account.assets, tasks: account.tasks, datasets: account.datasets, loops: account.loops, provenance: { collection: 'uploaded-bytes-or-external-reference', externalReferenceValidation: 'syntax-only', verification: 'reported-metric-threshold', remoteExecution: 'unavailable' } })); }
  /** Internal operator backup, under the same cross-process lock as all mutations. */
  async backupState(outputDir: string) {
    const destination = resolve(outputDir);
    if (destination === this.dataDir || destination.startsWith(this.dataDir + '/')) fail('invalid_backup_directory');
    return this.transaction('', async (store) => {
      await mkdir(destination, { mode: 0o700 }); await this.privateDirectory(join(destination, 'blobs'));
      try {
        for (const account of store.accounts) for (const asset of account.assets) if (asset.storage === 'uploaded') {
          const bytes = await this.bytes(asset); const file = await open(join(destination, 'blobs', asset.id + '.bin'), 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        }
        const payload = storeSchema.parse(clone(store)); for (const account of payload.accounts) account.collectionTokens = {};
        const file = await open(join(destination, 'manifest.json'), 'wx', 0o600); try { await file.writeFile(JSON.stringify({ sha256: digest(JSON.stringify(payload)), payload })); await file.sync(); } finally { await file.close(); }
        await this.syncDirectory(join(destination, 'blobs')); await this.syncDirectory(destination);
        return { path: destination, assets: store.accounts.reduce((sum, account) => sum + account.assets.length, 0), completedAt: iso() };
      } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
    }, true);
  }

  private asset(account: Account, id: string): DataAsset { const asset = account.assets.find((asset) => asset.id === validId(id)); if (!asset) fail('not_found', 404); return asset; }
  private task(account: Account, id: string): DataTask { const task = account.tasks.find((task) => task.id === validId(id)); if (!task) fail('not_found', 404); return task; }
  private dataset(account: Account, id: string): DataDataset { const dataset = account.datasets.find((dataset) => dataset.id === validId(id)); if (!dataset) fail('not_found', 404); return dataset; }
  private loop(account: Account, id: string): DataLoop { const loop = account.loops.find((loop) => loop.id === validId(id)); if (!loop) fail('not_found', 404); return loop; }
  private blob(id: string) { return join(this.dataDir, 'blobs', validId(id) + '.bin'); }
  private validateBytes(hash: string, data: Buffer) { if (!Buffer.isBuffer(data) || !data.length || data.length > this.limits.maxAssetBytes) fail('upload_size_exceeded', 413); if (digest(data) !== hash) fail('hash_mismatch', 422); }
  private assertQuota(store: Store, field: 'assets' | 'tasks' | 'datasets' | 'loops', bytes = 0) {
    const bound = { assets: this.limits.maxAssets, tasks: this.limits.maxTasks, datasets: this.limits.maxDatasets, loops: this.limits.maxLoops }[field];
    if (store.accounts.reduce((count, account) => count + account[field].length, 0) >= bound) fail('quota_exceeded', 409);
    if (store.accounts.reduce((sum, account) => sum + account.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), 0) + bytes > this.limits.maxUploadedBytes) fail('storage_quota_exceeded', 409);
  }
  private async archive(store: Store, account: Account, input: z.infer<typeof uploadAssetInputSchema>, data: Buffer, provenance?: DataAssetProvenance, persist = true, fixedId?:string): Promise<DataAsset> {
    let task: DataTask | undefined;
    if (input.taskId) {
      task = this.task(account, input.taskId); if (terminal(task)) fail('task_closed', 409);
      if (input.source !== task.source || input.project !== task.project || input.targetId !== task.targetId || input.kind !== task.kind) fail('collection_scope_mismatch', 403);
      const prior = account.assets.find((asset) => asset.taskId === task!.id && asset.sha256 === input.sha256);
      if (prior) { await this.bytes(prior); return prior; }
      if (task.assetIds.length >= task.expectedCount) fail('collection_count_exceeded', 409);
    }
    this.assertQuota(store, 'assets', data.length);
    const asset: DataAsset = { ...input, id: fixedId??randomUUID(), sizeBytes: data.length, storage: 'uploaded', ...(provenance ? { provenance } : {}), createdAt: iso() };
    const file = await open(this.blob(asset.id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await this.syncDirectory(join(this.dataDir, 'blobs'));
    account.assets.push(asset); if (task) { task.assetIds.push(asset.id); task.status = 'collecting'; task.updatedAt = iso(); }
    // A failure keeps the public manifest unchanged. Any orphan is reclaimed under the next lock.
    if(persist)await this.save(store); return asset;
  }
  private async bytes(asset: DataAsset): Promise<Buffer> {
    if (asset.storage !== 'uploaded' || !asset.sha256 || !asset.sizeBytes) fail('content_unavailable', 409);
    try {
      const data = await this.readSafe(this.blob(asset.id), this.limits.maxAssetBytes);
      if (data.length !== asset.sizeBytes || digest(data) !== asset.sha256) fail('asset_integrity_failure', 503);
      return data;
    } catch (error) { if (error instanceof DataCenterError) throw error; fail('asset_integrity_failure', 503); }
  }
  private async privateDirectory(dir: string) { await mkdir(dir, { recursive: true, mode: 0o700 }); const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_state_directory', 503); await chmod(dir, 0o700); }
  private async readSafe(filename: string, limit: number) {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) fail('state_integrity_failure', 503); return await file.readFile(); } finally { await file.close(); }
  }
  private async syncDirectory(directory: string) { const file = await open(directory, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } }
  private async save(store: Store) {
    const payload = storeSchema.parse(store); const content = JSON.stringify({ sha256: digest(JSON.stringify(payload)), payload });
    if (Buffer.byteLength(content) > 32 * MiB) fail('metadata_quota_exceeded', 409);
    const temporary = join(this.dataDir, 'manifest-' + randomUUID() + '.tmp');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(this.dataDir, 'manifest.json')); await this.syncDirectory(this.dataDir);
  }
  private async load(): Promise<Store> {
    let store: Store;
    try { const bytes = await this.readSafe(join(this.dataDir, 'manifest.json'), 32 * MiB); const raw = JSON.parse(bytes.toString()) as unknown; const envelope = envelopeSchema.parse(raw); if (digest(JSON.stringify(envelope.payload)) !== envelope.sha256) fail('state_integrity_failure', 503); store = envelope.payload; }
    catch (error) {
      if (codeIs(error, 'ENOENT')) {
        let initialized = false; try { await lstat(join(this.dataDir, 'initialized')); initialized = true; } catch (cause) { if (!codeIs(cause, 'ENOENT')) throw cause; }
        if (initialized || (await readdir(join(this.dataDir, 'blobs'))).length) fail('state_integrity_failure', 503);
        store = { schemaVersion: 1, accounts: [] };
        // Persist an empty commit before writing the first blob. A missing
        // historical manifest is never interpreted as permission to destroy data.
        await this.save(store);
      } else if (error instanceof DataCenterError) throw error; else fail('state_integrity_failure', 503);
    }
    try {
      const marker = await open(join(this.dataDir, 'initialized'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await marker.writeFile(DATA_CENTER_CONTRACT + '\n'); await marker.sync(); } finally { await marker.close(); } await this.syncDirectory(this.dataDir);
    } catch (error) { if (!codeIs(error, 'EEXIST')) throw error; }
    const ids = new Set<string>(); const owners = new Set<string>();
    for (const account of store.accounts) {
      if (owners.has(account.ownerHash)) fail('state_integrity_failure', 503); owners.add(account.ownerHash);
      for (const asset of account.assets) { if (ids.has(asset.id) || (asset.storage === 'uploaded' && (!asset.sha256 || !asset.filename || !asset.mimeType || asset.sizeBytes < 1)) || (asset.storage === 'external' && (!asset.referenceUri || asset.sizeBytes !== 0 || asset.sha256))) fail('state_integrity_failure', 503); ids.add(asset.id); }
      for (const field of ['tasks', 'datasets', 'loops'] as const) for (const entity of account[field]) { if (ids.has(entity.id)) fail('state_integrity_failure', 503); ids.add(entity.id); }
      for (const asset of account.assets) if (asset.taskId && !account.tasks.some((task) => task.id === asset.taskId && task.assetIds.includes(asset.id))) fail('state_integrity_failure', 503);
      for (const task of account.tasks) { if (new Set(task.assetIds).size !== task.assetIds.length || task.assetIds.length > task.expectedCount || task.assetIds.some((id) => !account.assets.some((asset) => asset.id === id && asset.taskId === task.id && asset.storage === 'uploaded' && asset.project === task.project && asset.targetId === task.targetId && asset.source === task.source && asset.kind === task.kind)) || (task.status === 'completed' && task.assetIds.length !== task.expectedCount)) fail('state_integrity_failure', 503); }
      for (const dataset of account.datasets) { if (dataset.assetIds.length !== dataset.assets.length || dataset.assetIds.some((id, index) => dataset.assets[index]?.id !== id || !account.assets.some((asset) => asset.id === id && JSON.stringify(asset) === JSON.stringify(dataset.assets[index])))) fail('state_integrity_failure', 503); }
      for (const loop of account.loops) {
        const baseline = account.assets.find((asset) => asset.id === loop.baseline.assetId);
        if (!baseline || baseline.storage !== 'uploaded' || baseline.project !== loop.project || baseline.targetId !== loop.targetId || !account.datasets.some((dataset) => dataset.id === loop.datasetId && dataset.project === loop.project && dataset.assetIds.includes(loop.baseline.assetId))) fail('state_integrity_failure', 503);
        let expected: DataLoop['status'] = 'open'; let candidateVersion: string | undefined; const evidenceHashes = new Set<string>();
        for (const item of loop.evidence) {
          const stage = { open: 'analysis', analyzed: 'evaluation', evaluated: 'deployment', deployed: 'verification', verification_failed: 'verification', verified: '' }[expected];
          const asset = account.assets.find((asset) => asset.id === item.assetId);
          if (item.stage !== stage || !asset || asset.storage !== 'uploaded' || asset.project !== loop.project || asset.targetId !== loop.targetId || item.targetId !== loop.targetId || asset.sha256 !== item.sha256 || ids.has(item.id)) fail('state_integrity_failure', 503);
          ids.add(item.id);
          if (item.stage === 'analysis') expected = 'analyzed';
          else if (item.stage === 'evaluation') { if (item.version === loop.baseline.version) fail('state_integrity_failure', 503); candidateVersion = item.version; expected = 'evaluated'; }
          else if (item.stage === 'deployment') { if (item.version !== candidateVersion) fail('state_integrity_failure', 503); expected = 'deployed'; }
          else {
            if (item.baselineValue !== loop.baseline.value || item.candidateValue === undefined || item.version !== candidateVersion || item.sha256 === baseline.sha256 || evidenceHashes.has(item.sha256) || item.measurementSource !== 'reported') fail('state_integrity_failure', 503);
            const improvement = loop.criterion.direction === 'increase' ? item.candidateValue - item.baselineValue : item.baselineValue - item.candidateValue;
            if (!Number.isFinite(improvement) || item.improvement !== improvement || item.passed !== (improvement >= loop.criterion.threshold) || JSON.stringify(item.criterion) !== JSON.stringify(loop.criterion)) fail('state_integrity_failure', 503);
            expected = item.passed ? 'verified' : 'verification_failed';
          }
          if (item.stage !== 'verification' && (item.baselineValue !== undefined || item.candidateValue !== undefined || item.passed !== undefined || item.improvement !== undefined || item.criterion !== undefined || item.measurementSource !== undefined)) fail('state_integrity_failure', 503);
          evidenceHashes.add(item.sha256);
        }
        if (loop.status !== expected) fail('state_integrity_failure', 503);
      }
      for (const taskId of Object.keys(account.collectionTokens)) if (!account.tasks.some((task) => task.id === taskId && !terminal(task))) fail('state_integrity_failure', 503);
    }
    // Only committed files survive recovery. Cleanup is serialized with writers.
    const live = new Set(store.accounts.flatMap((account) => account.assets.filter((asset) => asset.storage === 'uploaded').map((asset) => asset.id + '.bin')));
    for (const name of await readdir(join(this.dataDir, 'blobs'))) { if (!/^[a-f0-9-]{36}\.bin$/.test(name)) fail('state_integrity_failure', 503); if (!live.has(name)) await unlink(join(this.dataDir, 'blobs', name)); }
    for (const name of await readdir(this.dataDir)) if (/^manifest-[a-f0-9-]{36}\.tmp$/.test(name)) await unlink(join(this.dataDir, name));
    return store;
  }
  private async lock() {
    const filename = join(this.dataDir, 'store.lock'); const deadline = Date.now() + 12_000;
    do { const claim = await this.claim(filename); if (claim) return claim; await this.recoverClaim(filename); await pause(25); } while (Date.now() < deadline);
    fail('busy', 503);
  }
  private async claim(filename: string): Promise<(() => Promise<void>) | null> {
    const token = randomUUID(); const temporary = filename + '.owner.' + process.pid + '.' + token + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); } finally { await file.close(); }
    try {
      // Publish complete immutable ownership; link never replaces another claim.
      try { await link(temporary, filename); } catch (error) { if (codeIs(error, 'EEXIST')) return null; throw error; }
      return async () => { const owner = await this.lockOwner(filename); if (owner?.pid === process.pid && owner.token === token) await unlink(filename).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; }); };
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async lockOwner(filename: string): Promise<{ pid: number; token: string } | null> {
    try { const content = await this.readSafe(filename, 1024); return z.object({ pid: z.number().int().min(1).max(2147483647), token: uuid }).strict().parse(JSON.parse(content.toString())); }
    catch (error) { if (codeIs(error, 'ENOENT')) return null; fail('state_lock_integrity_failure', 503); }
  }
  private alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return !codeIs(error, 'ESRCH'); } }
  private async recoverClaim(filename: string, depth = 0): Promise<void> {
    const owner = await this.lockOwner(filename); if (!owner || this.alive(owner.pid)) return;
    if (depth >= 3) fail('state_lock_recovery_required', 503);
    const recovery = filename + '.recover-' + owner.token; let release = await this.claim(recovery);
    if (!release) { await this.recoverClaim(recovery, depth + 1); release = await this.claim(recovery); if (!release) return; }
    try { const current = await this.lockOwner(filename); if (current?.pid === owner.pid && current.token === owner.token && !this.alive(current.pid)) await unlink(filename).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; }); }
    finally { await release(); }
  }
  private async transaction<T>(owner: string, action: (store: Store, account: Account) => T | Promise<T>, internal = false): Promise<T> {
    if (!internal && (typeof owner !== 'string' || !owner.trim() || owner.length > 500 || owner === 'ops-admin')) fail('identity_required', 403);
    const previous = queues.get(this.dataDir) ?? Promise.resolve(); let releaseQueue!: () => void; const next = new Promise<void>((done) => { releaseQueue = done; }); queues.set(this.dataDir, next); await previous;
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      await this.privateDirectory(this.dataDir); await this.privateDirectory(join(this.dataDir, 'blobs')); releaseLock = await this.lock(); const store = await this.load(); const ownerHash = digest(owner);
      let account = store.accounts.find((account) => account.ownerHash === ownerHash);
      if (!account) { if (store.accounts.length >= 2000) fail('account_quota_exceeded', 409); account = { ownerHash, assets: [], tasks: [], datasets: [], loops: [], collectionTokens: {} }; if (!internal) store.accounts.push(account); }
      return clone(await action(store, account));
    } finally { try { await releaseLock?.(); } finally { releaseQueue(); if (queues.get(this.dataDir) === next) queues.delete(this.dataDir); } }
  }
}
