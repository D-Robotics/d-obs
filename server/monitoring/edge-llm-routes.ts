import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { EdgeLlmError, EdgeLlmService } from './edge-llm-service.js';
import { EDGE_LLM_API, EDGE_LLM_CONTRACT, EDGE_LLM_OPERATIONS } from './edge-llm-operations.js';
export { EDGE_LLM_API, EDGE_LLM_CONTRACT, EDGE_LLM_OPERATIONS } from './edge-llm-operations.js';
let configuredService: EdgeLlmService | undefined;
export function getConfiguredEdgeLlmService(): EdgeLlmService { return configuredService ??= new EdgeLlmService(); }
function failure(res: Response, error: unknown) { const known = error instanceof EdgeLlmError; res.status(known ? error.status : error instanceof z.ZodError ? 400 : 503).json({ ok: false, contract: EDGE_LLM_CONTRACT, error: known ? error.code : error instanceof z.ZodError ? 'edge_llm_invalid_request' : 'edge_llm_unavailable' }); }
const identity: RequestHandler = (req, res, next) => { if (sessionOwner(req) === 'ops-admin') { res.status(403).json({ ok: false, error: 'edge_llm_identity_required' }); return; } if (req.header('x-rdk-ops-read-only') === '1') res.setHeader('x-rdk-ops-read-only', '1'); next(); };
export function registerEdgeLlmRoutes(router: Router, options: { getService?: () => EdgeLlmService } = {}): void {
  const service = options.getService ?? getConfiguredEdgeLlmService;
  const wrap = (handler: (req: Request, res: Response) => unknown): RequestHandler => async (req, res) => { try { z.object({}).strict().parse(req.query); await handler(req, res); } catch (error) { failure(res, error); } };
  const reply = (res: Response, data: object, status = 200) => res.status(status).json({ ok: true, contract: EDGE_LLM_CONTRACT, ...data });
  const get = (suffix: string, handler: (req: Request, res: Response) => unknown) => router.get(EDGE_LLM_API + suffix, requireSshLogAccess, identity, wrap(handler));
  get('/capabilities', (req, res) => reply(res, { ...service().capabilities(), readOnly: req.header('x-rdk-ops-read-only') === '1', atomicOperations: Object.keys(EDGE_LLM_OPERATIONS) }));
  get('/targets/:targetId', async (req, res) => reply(res, await service().getTarget(String(req.params.targetId))));
  get('/jobs', async (req, res) => reply(res, { jobs: await service().listJobs(sessionOwner(req)) }));
  router.post(EDGE_LLM_API + '/jobs', requireSshLogAccess, identity, requireOpsMutationGuard, (req, res, next) => { if (req.header('x-rdk-ops-read-only') === '1') res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); else next(); }, wrap(async (req, res) => reply(res, { job: await service().submitJob(sessionOwner(req), req.body) }, 202)));
  get('/jobs/:id', async (req, res) => reply(res, { job: await service().getJob(sessionOwner(req), String(req.params.id)) }));
  get('/jobs/:id/report', async (req, res) => { const report = await service().exportReport(sessionOwner(req), String(req.params.id)); res.attachment('edge-llm-' + report.job.id + '.json').type('application/json').send(JSON.stringify(report)); });
  registerPlatformOperations(router, EDGE_LLM_OPERATIONS);
}
