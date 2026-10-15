import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { z, ZodError } from 'zod';
import { DataCenterError, DataCenterService, dataAssetKindSchema, dataSourceSchema } from './data-center-service.js';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { renderDataCenterCompatibilityPage } from './data-center-compatibility-page.js';
import { DATA_CENTER_API, DATA_CENTER_CONTRACT, DATA_CENTER_OPERATIONS } from './data-center-operations.js';
export { DATA_CENTER_API, DATA_CENTER_CONTRACT, DATA_CENTER_OPERATIONS } from './data-center-operations.js';
let configuredService: DataCenterService | undefined;
export function getConfiguredDataCenterService(): DataCenterService { return configuredService ??= new DataCenterService(); }
type Options = { getService?: () => DataCenterService };
function failure(res: Response, error: unknown) {
  if (error instanceof DataCenterError) { res.status(error.status).json({ ok: false, contract: DATA_CENTER_CONTRACT, error: error.code }); return; }
  if (error instanceof ZodError || error instanceof URIError) { res.status(400).json({ ok: false, contract: DATA_CENTER_CONTRACT, error: 'data_center_invalid_request' }); return; }
  const status = (error as { status?: number })?.status;
  res.status(status === 413 ? 413 : 503).json({ ok: false, contract: DATA_CENTER_CONTRACT, error: status === 413 ? 'data_center_upload_size_exceeded' : 'data_center_unavailable' });
}
function metadata(req: Request) {
  const header = req.header('x-data-asset'); if (!header || header.length > 16000) throw new DataCenterError('data_center_upload_metadata_required');
  try { return JSON.parse(decodeURIComponent(header)) as unknown; } catch { throw new DataCenterError('data_center_upload_metadata_invalid'); }
}
const identity: RequestHandler = (req, res, next) => {
  if (sessionOwner(req) === 'ops-admin') { res.status(403).json({ ok: false, error: 'data_center_identity_required' }); return; }
  if (req.header('x-rdk-ops-read-only') === '1') res.setHeader('x-rdk-ops-read-only', '1');
  next();
};
const readOnly: RequestHandler = (req, res, next) => { if (req.header('x-rdk-ops-read-only') === '1') res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); else next(); };
let receiving = 0;
const uploads = new WeakMap<Request, { processing: boolean; release: () => void }>();
const reserveUpload: RequestHandler = (req, res, next) => {
  if (!req.is('application/octet-stream')) { res.status(415).json({ ok: false, error: 'data_center_binary_content_type_required' }); return; }
  if (receiving >= 4) { res.status(429).json({ ok: false, error: 'data_center_upload_busy' }); return; }
  receiving++; let released = false; const release = () => { if (!released) { released = true; receiving--; } };
  const reservation = { processing: false, release }; uploads.set(req, reservation);
  const releaseBeforeProcessing = () => { if (!reservation.processing) release(); };
  res.once('finish', releaseBeforeProcessing); res.once('close', releaseBeforeProcessing); next();
};
export function registerDataCenterRoutes(router: Router, options: Options = {}) {
  const service = options.getService ?? getConfiguredDataCenterService;
  const wrap = (handler: (req: Request, res: Response) => unknown): RequestHandler => async (req, res) => { try { await handler(req, res); } catch (error) { failure(res, error); } };
  const binaryWrap = (handler: (req: Request, res: Response) => unknown): RequestHandler => async (req, res) => {
    const reservation = uploads.get(req); if (reservation) reservation.processing = true;
    try { await handler(req, res); } catch (error) { failure(res, error); } finally { reservation?.release(); uploads.delete(req); }
  };
  const reply = (res: Response, data: object, status = 200) => res.status(status).json({ ok: true, contract: DATA_CENTER_CONTRACT, ...data });
  const get = (suffix: string, handler: (req: Request, res: Response) => unknown) => router.get(DATA_CENTER_API + suffix, requireSshLogAccess, identity, wrap(handler));
  const post = (suffix: string, handler: (req: Request, res: Response) => unknown, binary = false) => router.post(DATA_CENTER_API + suffix, requireSshLogAccess, identity, requireOpsMutationGuard, readOnly, ...(binary ? [reserveUpload, express.raw({ type: 'application/octet-stream', limit: '64mb' })] : []), binary ? binaryWrap(handler) : wrap(handler));
  router.get('/ops-observability/data-center', (_req, res) => res.type('html').send(renderDataCenterCompatibilityPage()));
  get('/capabilities', (req, res) => reply(res, { ...service().capabilities(), readOnly: req.header('x-rdk-ops-read-only') === '1', atomicOperations: Object.keys(DATA_CENTER_OPERATIONS), binaryUpload: { path: DATA_CENTER_API + '/assets/upload', header: 'x-data-asset', contentType: 'application/octet-stream', metadataEncoding: 'encodeURIComponent(JSON.stringify(metadata))', integrity: 'sha256', maximumBytes: service().limits.maxAssetBytes }, collectionIngest: { path: '/api/data-center/ingest/:taskId', tokenHeader: 'x-collection-token', metadataHeader: 'x-data-asset', metadataEncoding: 'encodeURIComponent(JSON.stringify({filename,mimeType,sha256,title?,collectedAt?}))', remoteExecution: 'unavailable' } }));
  get('/overview', async (req, res) => reply(res, { overview: await service().overview(sessionOwner(req)) }));
  get('/assets', async (req, res) => { const filter = z.object({ kind: dataAssetKindSchema.optional(), source: dataSourceSchema.optional(), project: z.string().max(120).optional(), search: z.string().max(200).optional() }).strict().parse(req.query); reply(res, { assets: await service().listAssets(sessionOwner(req), filter) }); });
  post('/assets', async (req, res) => reply(res, { asset: await service().createAsset(sessionOwner(req), req.body) }, 201));
  post('/assets/upload', async (req, res) => reply(res, { asset: await service().uploadAsset(sessionOwner(req), metadata(req), req.body as Buffer) }, 201), true);
  get('/assets/:id', async (req, res) => reply(res, { asset: await service().getAsset(sessionOwner(req), String(req.params.id)) }));
  get('/assets/:id/content', async (req, res) => { const { asset, data } = await service().readAsset(sessionOwner(req), String(req.params.id)); res.attachment(asset.id + '.bin').type('application/octet-stream').send(data); });
  router.delete(DATA_CENTER_API + '/assets/:id', requireSshLogAccess, identity, requireOpsMutationGuard, readOnly, wrap(async (req, res) => reply(res, await service().deleteAsset(sessionOwner(req), String(req.params.id)))));
  get('/tasks', async (req, res) => reply(res, { tasks: await service().listTasks(sessionOwner(req)) }));
  post('/tasks', async (req, res) => reply(res, { task: await service().createTask(sessionOwner(req), req.body) }, 201));
  post('/tasks/:id/status', async (req, res) => reply(res, { task: await service().updateTaskStatus(sessionOwner(req), String(req.params.id), req.body) }));
  post('/tasks/:id/token', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); reply(res, await service().rotateCollectionToken(sessionOwner(req), String(req.params.id))); });
  get('/datasets', async (req, res) => reply(res, { datasets: await service().listDatasets(sessionOwner(req)) }));
  get('/datasets/:id', async (req, res) => reply(res, { dataset: await service().getDataset(sessionOwner(req), String(req.params.id)) }));
  post('/datasets', async (req, res) => reply(res, { dataset: await service().createDataset(sessionOwner(req), req.body) }, 201));
  get('/loops', async (req, res) => reply(res, { loops: await service().listLoops(sessionOwner(req)) }));
  get('/loops/:id', async (req, res) => reply(res, { loop: await service().getLoop(sessionOwner(req), String(req.params.id)) }));
  post('/loops', async (req, res) => reply(res, { loop: await service().createLoop(sessionOwner(req), req.body) }, 201));
  post('/loops/:id/evidence', async (req, res) => reply(res, { loop: await service().addEvidence(sessionOwner(req), String(req.params.id), req.body) }));
  get('/manifest', async (req, res) => { res.attachment('data-center-manifest.json').type('application/json').send(JSON.stringify(await service().manifest(sessionOwner(req)))); });
  // Collection credentials confer only permission to upload this task. Validate before buffering.
  router.post('/api/data-center/ingest/:taskId', readOnly, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    service().validateCollectionToken(String(req.params.taskId), req.header('x-collection-token') ?? '').then(() => next(), (error) => failure(res, error));
  }, reserveUpload, express.raw({ type: 'application/octet-stream', limit: '64mb' }), binaryWrap(async (req, res) => reply(res, { asset: await service().ingestAsset(String(req.params.taskId), req.header('x-collection-token') ?? '', metadata(req), req.body as Buffer) }, 201)));
  router.use((error: unknown, req: Request, res: Response, next: (error?: unknown) => void) => { if (req.path.startsWith(DATA_CENTER_API) || req.path.startsWith('/api/data-center/ingest/')) failure(res, error); else next(error); });
  registerPlatformOperations(router, DATA_CENTER_OPERATIONS);
}
