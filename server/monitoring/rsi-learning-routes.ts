import type { Request, RequestHandler, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import {
  createRsiLedgerService,
  createLoopInputSchema,
  mutationInputSchema,
  rollbackInputSchema,
  RsiLedgerError,
  type RsiLedgerService,
} from '../evolution/rsi-ledger.js';
import { classify, RsiInputSchema } from '../evolution/rsi-replay.js';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { RSI_LEARNING_API, RSI_LEARNING_CONTRACT, RSI_LEARNING_OPERATIONS } from './rsi-learning-operations.js';
export { RSI_LEARNING_API, RSI_LEARNING_CONTRACT, RSI_LEARNING_OPERATIONS } from './rsi-learning-operations.js';

let configuredService: RsiLedgerService | undefined;
export function getConfiguredRsiLearningService(): RsiLedgerService {
  return configuredService ??= createRsiLedgerService();
}

export type RsiLearningRouteOptions = {
  service?: RsiLedgerService;
  getService?: () => RsiLedgerService;
  access?: RequestHandler;
  owner?: (req: Request) => string;
};

const emptyInput = z.object({}).strict();
const loopId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const classifyQueryInput = RsiInputSchema.extend({
  httpStatus: z.string().regex(/^[1-5][0-9]{2}$/).transform(Number).optional(),
}).strict();

function failure(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'rsi_invalid_request' });
    return;
  }
  if (error instanceof RsiLedgerError && /^rsi_[a-z0-9_]+$/.test(error.code)) {
    res.status(error.status).json({ ok: false, error: error.code });
    return;
  }
  // File system paths, submitted payloads and internal errors stay server-side.
  res.status(503).json({ ok: false, error: 'rsi_learning_unavailable' });
}

export function registerRsiLearningRoutes(router: Router, options: RsiLearningRouteOptions = {}): void {
  const service = options.getService ?? (() => options.service ?? getConfiguredRsiLearningService());
  const access = options.access ?? requireSshLogAccess;
  const owner = options.owner ?? sessionOwner;
  const identity: RequestHandler = (req, res, next) => {
    if (req.opsTenantAccess) {
      res.status(403).json({ ok: false, error: 'rsi_operator_scope_required' });
      return;
    }
    const resolved = owner(req);
    if (!resolved.trim() || resolved === 'ops-admin') {
      res.status(403).json({ ok: false, error: 'rsi_identity_required' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.header('x-rdk-ops-read-only') === '1') res.setHeader('x-rdk-ops-read-only', '1');
    next();
  };
  const writable: RequestHandler = (req, res, next) => {
    if (req.header('x-rdk-ops-read-only') === '1') {
      res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' });
      return;
    }
    next();
  };
  const wrap = (handler: (req: Request, res: Response) => unknown, querySchema: z.ZodTypeAny = emptyInput): RequestHandler => async (req, res) => {
    try {
      querySchema.parse(req.query);
      await handler(req, res);
    } catch (error) { failure(res, error); }
  };
  const reply = (res: Response, data: object, status = 200) =>
    res.status(status).json({ ok: true, contract: RSI_LEARNING_CONTRACT, ...data });
  const get = (suffix: string, handler: (req: Request, res: Response) => unknown, querySchema: z.ZodTypeAny = emptyInput) =>
    router.get(RSI_LEARNING_API + suffix, access, identity, wrap(handler, querySchema));
  const post = (suffix: string, handler: (req: Request, res: Response) => unknown) =>
    router.post(RSI_LEARNING_API + suffix, access, identity, requireOpsMutationGuard, writable, wrap(handler));

  get('/capabilities', (req, res) => reply(res, { capabilities: service().capabilities(), readOnly: req.header('x-rdk-ops-read-only') === '1' }));
  get('/loops', async (req, res) => reply(res, { overview: await service().overview(owner(req)), readOnly: req.header('x-rdk-ops-read-only') === '1' }));
  get('/loops/:id', async (req, res) => reply(res, { loop: await service().getLoop(owner(req), loopId.parse(req.params.id)) }));
  get('/loops/:id/classify', async (req, res) => {
    const loop = await service().getLoop(owner(req), loopId.parse(req.params.id));
    const active = loop.versions.find((version) => version.id === loop.activeVersionId);
    if (!active) throw new Error('Missing active RSI version');
    reply(res, { activeVersionId: active.id, classification: classify(classifyQueryInput.parse(req.query), active.rules) });
  }, classifyQueryInput);
  post('/loops', async (req, res) => reply(res, { loop: await service().createLoop(owner(req), createLoopInputSchema.parse(req.body)) }, 201));
  post('/demo', async (req, res) => {
    emptyInput.parse(req.body === undefined ? {} : req.body);
    reply(res, { loop: await service().seedDemo(owner(req)) }, 201);
  });
  for (const action of ['propose', 'replay', 'accept', 'reject'] as const) {
    post(`/loops/:id/${action}`, async (req, res) => reply(res, {
      loop: await service()[action](owner(req), loopId.parse(req.params.id), mutationInputSchema.parse(req.body)),
    }));
  }
  post('/loops/:id/rollback', async (req, res) => reply(res, {
    loop: await service().rollback(owner(req), loopId.parse(req.params.id), rollbackInputSchema.parse(req.body)),
  }));

  registerPlatformOperations(router, RSI_LEARNING_OPERATIONS);
}
