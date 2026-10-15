import type { Request, RequestHandler, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import {
  RsiFailureInboxError, RsiFailureInboxService, type RsiFailureInboxOverview,
} from '../evolution/rsi-failure-inbox.js';
import { RsiLedgerError, type RsiLedgerService, type RsiLoop } from '../evolution/rsi-ledger.js';
import { RsiReasonSchema, RsiSliceSchema } from '../evolution/rsi-replay.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { registerPlatformOperations } from './platform-operations.js';
import { getConfiguredRsiLearningService } from './rsi-learning-routes.js';
import { RSI_FAILURE_OPERATIONS, RSI_LEARNING_API, RSI_LEARNING_CONTRACT } from './rsi-learning-operations.js';
import { requireSshLogAccess, sessionOwner } from './ssh-log-routes.js';

export { RSI_FAILURE_OPERATIONS } from './rsi-learning-operations.js';

let configuredService: RsiFailureInboxService | undefined;
export function getConfiguredRsiFailureInboxService(): RsiFailureInboxService {
  return configuredService ??= new RsiFailureInboxService();
}

export type RsiFailureRouteOptions = {
  service?: RsiFailureInboxService;
  getService?: () => RsiFailureInboxService;
  ledger?: RsiLedgerService;
  getLedger?: () => RsiLedgerService;
  access?: RequestHandler;
  owner?: (req: Request) => string;
};

const emptyInput = z.object({}).strict();
const uuid = z.string().uuid();
const revisionInput = z.object({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const confirmInput = revisionInput.extend({ expectedReason: RsiReasonSchema, slice: RsiSliceSchema }).strict();
const experimentInput = revisionInput.extend({
  evidenceIds: z.array(uuid).min(3).max(200).refine((ids) => new Set(ids).size === ids.length),
  title: z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();
const bindingInput = revisionInput.extend({ loopId: uuid.nullable() }).strict();

function failure(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ ok: false, error: 'rsi_invalid_request' });
    return;
  }
  if ((error instanceof RsiFailureInboxError || error instanceof RsiLedgerError)
    && /^rsi_[a-z0-9_]+$/.test(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    res.status(error.status).json({ ok: false, error: error.code });
    return;
  }
  res.status(503).json({ ok: false, error: 'rsi_learning_unavailable' });
}

/** Acceptance must refer to the exact active rules and the frozen case set. */
function acceptedActive(loop: RsiLoop): boolean {
  const active = loop.versions.find((version) => version.id === loop.activeVersionId);
  if (active?.status !== 'accepted') return false;
  return loop.decisions.some((decision) => decision.action === 'accept' && decision.versionId === active.id
    && decision.toVersionId === active.id && decision.casesHash === loop.casesHash && loop.replays.some((replay) =>
      replay.id === decision.replayId && replay.candidateVersionId === active.id && replay.casesHash === loop.casesHash
      && replay.candidateRulesHash === active.rulesHash && replay.report.gate.passed));
}

function observedEvidence(loop: RsiLoop): boolean {
  return !!loop.provenance && loop.provenance.length === loop.cases.length && loop.cases.every((item) =>
    item.source === 'operator' && loop.provenance!.some((evidence) => evidence.caseId === item.id));
}
function currentEvidence(loop: RsiLoop, inbox: RsiFailureInboxOverview): boolean {
  return observedEvidence(loop) && loop.cases.every(item => {
    const reference = loop.provenance!.find(ref => ref.caseId === item.id)!;
    const record = inbox.records.find(record => record.id === reference.evidenceId);
    return record?.status === 'confirmed' && record.fingerprint === reference.fingerprint &&
      record.expectedReason === item.expectedReason && record.slice === item.slice;
  });
}

export function registerRsiFailureRoutes(router: Router, options: RsiFailureRouteOptions = {}): void {
  const service = options.getService ?? (() => options.service ?? getConfiguredRsiFailureInboxService());
  const ledger = options.getLedger ?? (() => options.ledger ?? getConfiguredRsiLearningService());
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
  const wrap = (handler: (req: Request, res: Response) => unknown): RequestHandler => async (req, res) => {
    try { emptyInput.parse(req.query); await handler(req, res); }
    catch (error) { failure(res, error); }
  };
  const reply = (req: Request, res: Response, data: object, status = 200) => res.status(status).json({
    ok: true, contract: RSI_LEARNING_CONTRACT, ...data, readOnly: req.header('x-rdk-ops-read-only') === '1',
  });
  const post = (suffix: string, handler: (req: Request, res: Response) => unknown) =>
    router.post(RSI_LEARNING_API + suffix, access, identity, requireOpsMutationGuard, writable, wrap(handler));
  const overview = async (account: string): Promise<RsiFailureInboxOverview & { binding: object | null }> => {
    const result = await service().overview(account);
    if (!result.activeLoopId) return { ...result, binding: null };
    let loop: RsiLoop;
    try { loop = await ledger().getLoop(account, result.activeLoopId); }
    catch (error) {
      if (error instanceof RsiLedgerError && error.code === 'rsi_not_found') {
        return { ...result, binding: { loopId: result.activeLoopId, activeVersionId: null, usable: false, state: 'missing' } };
      }
      throw error;
    }
    const state = loop.candidateVersionId ? 'candidate_pending' : !observedEvidence(loop) ? 'unobserved' : !currentEvidence(loop,result) ? 'evidence_excluded'
      : acceptedActive(loop) ? 'accepted' : 'unaccepted';
    return { ...result, binding: { loopId: loop.id, activeVersionId: loop.activeVersionId, usable: state === 'accepted', state } };
  };

  router.get(RSI_LEARNING_API + '/evidence', access, identity, wrap(async (req, res) =>
    reply(req, res, { overview: await overview(owner(req)) })));
  post('/evidence/:id/confirm', async (req, res) => {
    const account = owner(req);
    const evidence = await service().confirm(account, uuid.parse(req.params.id), confirmInput.parse(req.body));
    reply(req, res, { evidence, overview: await overview(account) });
  });
  post('/evidence/:id/exclude', async (req, res) => {
    const account = owner(req);
    const evidence = await service().exclude(account, uuid.parse(req.params.id), revisionInput.parse(req.body));
    reply(req, res, { evidence, overview: await overview(account) });
  });
  post('/evidence/experiment', async (req, res) => {
    const account = owner(req);
    const { title, ...input } = experimentInput.parse(req.body);
    const frozen = await service().buildCases(account, input);
    const loop = await ledger().createLoopFromEvidence(account, { title, cases: frozen.cases }, frozen.provenance);
    reply(req, res, { loop, overview: await overview(account) }, 201);
  });
  post('/binding', async (req, res) => {
    const account = owner(req);
    const input = bindingInput.parse(req.body);
    if (input.loopId) {
      const loop = await ledger().getLoop(account, input.loopId);
      if (loop.candidateVersionId) throw new RsiLedgerError('rsi_candidate_pending', 409);
      if (!observedEvidence(loop)) throw new RsiLedgerError('rsi_binding_observed_evidence_required', 409);
      if (!currentEvidence(loop,await service().overview(account))) throw new RsiLedgerError('rsi_binding_evidence_retired', 409);
      if (!acceptedActive(loop)) throw new RsiLedgerError('rsi_binding_acceptance_required', 409);
    }
    await service().bindLoop(account, input);
    reply(req, res, { overview: await overview(account) });
  });

  registerPlatformOperations(router, RSI_FAILURE_OPERATIONS);
}
