/** Import owned Vision artifacts through their verified byte readers. No device actions. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { DATA_CENTER_VISION_OPERATIONS } from './data-center-vision-operations.js';
import { getConfiguredDataCenterService } from './data-center-routes.js';
import { type DataCenterService, DataCenterError } from './data-center-service.js';
import { getConfiguredVisionWorkshopService } from './vision-workshop-routes.js';
import { VisionWorkshopError, type VisionWorkshopService } from './vision-workshop-service.js';

const API = '/api/ops/observability/data-center';
const importInput = z.object({ project: z.string().trim().min(1).max(120) }).strict();
type Options = { getDataService?: () => DataCenterService; getVisionService?: () => VisionWorkshopService };
const imports = new Map<string, Promise<void>>();
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Serialize snapshot assembly as well as asset writes; retries reuse immutable artifacts. */
async function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = imports.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = previous.then(() => gate);
  imports.set(key, pending);
  await previous;
  try { return await action(); }
  finally { release(); if (imports.get(key) === pending) imports.delete(key); }
}

export async function importVisionExperiment(
  data: DataCenterService, vision: VisionWorkshopService, accountId: string, experimentId: string, project: string,
): Promise<{ assetIds: string[]; datasetId: string; experimentId: string; qualityVerification: 'unverified' }> {
  const parsed = importInput.parse({ project });
  return serial(accountId + ':' + experimentId + ':' + parsed.project, async () => {
    const experiment = await vision.getExperiment(accountId, experimentId);
    if (!experiment.samples.length && !experiment.processedImages.length && !experiment.candidates.length) {
      throw new VisionWorkshopError('vision_import_no_artifacts', '实验尚无可纳管的真实样本或参数', 409);
    }
    const assetIds: string[] = [];
    const add = async (artifactId: string, artifactType: 'raw' | 'processed' | 'candidate' | 'receipt', bytes: Buffer,
      filename: string, kind: string, mimeType: string, origin: 'cloud' | 'edge', description: string, version?: string) => {
      const asset = await data.importVerifiedAsset(accountId, {
        title: (experiment.title + ' · ' + filename).slice(0, 120), project: parsed.project, source: origin,
        ...(experiment.targetId ? { targetId: experiment.targetId } : {}), kind, filename, mimeType,
        sha256: hash(bytes), description: description.slice(0, 2000), tags: ['vision-workshop'],
      }, bytes, { system: 'vision-workshop', experimentId: experiment.id, artifactId, artifactType, ...(version ? { version } : {}) });
      assetIds.push(asset.id);
    };
    try {
      for (const sample of experiment.samples) {
        const actual = await vision.readRawSample(accountId, experiment.id, sample.id);
        if (hash(actual.data) !== sample.hash) throw new VisionWorkshopError('vision_import_snapshot_changed', 'Raw snapshot changed', 409);
        await add(sample.id, 'raw', actual.data, sample.filename, 'raw', 'application/octet-stream', sample.source === 'runner' ? 'edge' : 'cloud',
          '视觉实验 ' + experiment.id + '；原模块来源 ' + sample.source + '；采集元数据 ' + JSON.stringify(sample.metadata), sample.hash);
      }
      for (const image of experiment.processedImages) {
        const actual = await vision.readProcessedImage(accountId, experiment.id, image.id);
        if (hash(actual.data) !== image.hash) throw new VisionWorkshopError('vision_import_snapshot_changed', 'Image snapshot changed', 409);
        await add(image.id, 'processed', actual.data, image.filename, 'image', image.mimeType, image.source === 'runner' ? 'edge' : 'cloud',
          '视觉实验 ' + experiment.id + '；Raw ' + image.sampleId + '；原模块来源 ' + image.source + '；参数版本 ' + (image.tuningHash ?? '未记录'), image.tuningHash);
      }
      for (const candidate of experiment.candidates) {
        const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
        await add(candidate.id, 'candidate', bytes, 'candidate-' + candidate.id + '.json', 'document', 'application/json', 'cloud',
          '不可变参数候选；基线 ' + candidate.baselineHash + '；样本 ' + candidate.sampleIds.join(', ') + '；实际效果尚未验证', candidate.hash);
      }
      // One provenance report retains the original relationships and exact receipts.
      const report = Buffer.from(JSON.stringify({ contract: 'rdk.vision-data-provenance.v1', experimentId: experiment.id,
        baselineHistory: experiment.baselineHistory, samples: experiment.samples, processedImages: experiment.processedImages,
        candidates: experiment.candidates, evaluations: experiment.evaluations, comparisons: experiment.comparisons,
        deviceRuns: experiment.deviceRuns, selectedCandidateId: experiment.selectedCandidateId,
        qualityVerification: 'unverified', note: '应用及回读记录不等于实机质量验收。' }, null, 2) + '\n');
      // Report identity includes the content hash, so a changed experiment creates a new snapshot.
      await add('report-' + hash(report), 'receipt', report, 'vision-provenance.json', 'document', 'application/json', 'cloud',
        '视觉实验原始来源、参数和回执关联；不自动将实验标记为改善验收通过', hash(report));
      const sorted = [...assetIds].sort();
      const name = ('视觉实验 · ' + experiment.title).slice(0, 120);
      const existing = (await data.listDatasets(accountId)).find((entry) => entry.project === parsed.project && entry.name === name &&
        JSON.stringify([...entry.assetIds].sort()) === JSON.stringify(sorted));
      const dataset = existing ?? await data.createDataset(accountId, { name, project: parsed.project, assetIds,
        description: '从视觉实验 ' + experiment.id + ' 纳入的不可变快照，保留真实字节、原模块来源和版本关系。' });
      return { assetIds, datasetId: dataset.id, experimentId: experiment.id, qualityVerification: 'unverified' };
    } catch (error) {
      if (assetIds.length) {
        const partial = new Error('vision_import_partial') as Error & { assetIds: string[]; causeCode?: string };
        partial.assetIds = assetIds;
        partial.causeCode = error instanceof DataCenterError || error instanceof VisionWorkshopError ? error.code : 'import_unavailable';
        throw partial;
      }
      throw error;
    }
  });
}

export function registerDataCenterVisionBridge(router: Router, options: Options = {}): void {
  const getData = options.getDataService ?? getConfiguredDataCenterService;
  const getVision = options.getVisionService ?? getConfiguredVisionWorkshopService;
  // The fixed client source contains no credentials. Never accept a requested file path.
  router.get('/ops-observability/data-center/upload-client.mjs', async (_req, res) => {
    try {
      const source = await readFile(new URL('../../tools/data-center-upload.mjs', import.meta.url));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.attachment('data-center-upload.mjs').type('text/javascript').send(source);
    } catch { res.status(503).json({ ok: false, error: 'data_center_client_unavailable' }); }
  });
  const failure = (res: Response, error: unknown) => {
    if (error && typeof error === 'object' && 'assetIds' in error) {
      res.status(503).json({ ok: false, error: 'vision_import_partial', assetIds: error.assetIds, retrySafe: true }); return;
    }
    if (error instanceof DataCenterError || error instanceof VisionWorkshopError) { res.status(error.status).json({ ok: false, error: error.code }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ ok: false, error: 'data_center_invalid_request' }); return; }
    res.status(503).json({ ok: false, error: 'vision_import_unavailable' });
  };
  router.get(API + '/vision-experiments', requireSshLogAccess, async (req, res) => {
    try {
      const experiments = await getVision().listExperiments(sessionOwner(req));
      res.json({ ok: true, experiments: experiments.map((entry) => ({ id: entry.id, title: entry.title, targetId: entry.targetId,
        samples: entry.samples.length, images: entry.processedImages.length, candidates: entry.candidates.length,
        updatedAt: entry.updatedAt, qualityVerification: 'unverified' })) });
    } catch (error) { failure(res, error); }
  });
  let running = 0;
  router.post(API + '/imports/vision/:id', requireSshLogAccess, requireOpsMutationGuard, async (req: Request, res: Response) => {
    if (req.header('x-rdk-ops-read-only') === '1') { res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); return; }
    if (running >= 2) { res.status(429).json({ ok: false, error: 'vision_import_busy' }); return; }
    running++;
    try {
      const body = importInput.parse(req.body);
      const imported = await importVisionExperiment(getData(), getVision(), sessionOwner(req), String(req.params.id), body.project);
      res.status(201).json({ ok: true, ...imported });
    } catch (error) { failure(res, error); }
    finally { running--; }
  });
  registerPlatformOperations(router, DATA_CENTER_VISION_OPERATIONS);
}
