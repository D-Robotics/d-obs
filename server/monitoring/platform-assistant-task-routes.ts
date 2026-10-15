/** Persistent task facade. Legacy token-only clients keep their original contract. */
import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response, Router } from 'express';
import { getSessionSsoUser } from './observability-access-adapter.js';
import { sessionOwner } from './ssh-log-routes.js';
import { clientErrorCode, requireOpsMutationGuard, tenantScopeGate } from './observability-route-kit.js';
import { inspectPlatformMutation, claimPlatformMutation, proposePlatformMutation } from './platform-assistant-authorization.js';
import { PlatformAssistantTaskError, PlatformAssistantTaskService, type PlatformAssistantTaskDetail } from './platform-assistant-tasks.js';
import { executePlatformOperation, visiblePlatformOperations } from './platform-operations.js';
import { platformAssistantReadback } from './platform-assistant-verification.js';
import { callGatewayChat, copilotModelEnabled } from '../observability/copilot-model.js';
import { resolvePlatformAssistantChatTarget } from '../observability/platform-assistant-model.js';
import { runPlatformAssistant, validatePlatformAssistantInput, platformAssistantHistoryContent,
  platformAssistantMutationDigest,
  type PlatformAssistantInput, type PlatformAssistantDeps, type PlatformAssistantResult, type PlatformAssistantOperationResult } from '../observability/platform-assistant.js';
import { loadPluginAssistantContext } from './plugin-assistant-context.js';
import { platformAssistantExperience } from './platform-assistant-experience.js';

const API = '/api/ops/observability/assistant';
let configured: PlatformAssistantTaskService | undefined;
export function getConfiguredPlatformAssistantTasks(): PlatformAssistantTaskService {
  const stateDir = process.env.RDK_PLATFORM_ASSISTANT_TASK_STATE_DIR;
  if (!configured || (stateDir && configured.stateDir !== stateDir)) configured = new PlatformAssistantTaskService({ stateDir });
  return configured;
}

/** Credential-only clients are isolated; SSO tasks survive session refresh under the same account. */
export function platformAssistantTaskScope(req: Request): string {
  const user = getSessionSsoUser(req);
  const token = req.header('x-admin-token') || req.header('x-tenant-token');
  const owner = user ? `sso:${user.id}` : token ? `credential:${createHash('sha256').update(token).digest('hex')}` : sessionOwner(req);
  return JSON.stringify({ owner, tenant: req.opsTenantAccess?.tenantId ?? (typeof req.query.tenant === 'string' ? req.query.tenant : 'platform'),
    role: req.opsTenantAccess?.role ?? req.opsTenantAccess?.source ?? 'admin' });
}

export type PlatformAssistantTaskRouteOptions = {
  getTasks?: () => PlatformAssistantTaskService;
  /** Trusted composition/test dependencies; callers cannot supply these through HTTP. */
  complete?: PlatformAssistantDeps['complete']; enabled?: () => boolean;
  claimMutation?: typeof claimPlatformMutation;
};

export function registerPlatformAssistantTaskRoutes(router: Router, requireAccess: RequestHandler, options: PlatformAssistantTaskRouteOptions = {}): void {
  const service = options.getTasks ?? getConfiguredPlatformAssistantTasks;
  const active = new Set<string>();
  const failure = (res: Response, error: unknown) => {
    const code = error instanceof PlatformAssistantTaskError ? error.code : clientErrorCode(error, 'platform_assistant_task_unavailable');
    const status = error instanceof PlatformAssistantTaskError ? error.status : /^platform_assistant_(?:invalid_|message_too_large)/.test(code) ? 400 : 503;
    res.status(status).json({ ok: false, error: code });
  };
  const publicTask = async (req: Request, task: PlatformAssistantTaskDetail) => {
    const pending = await service().getPending(platformAssistantTaskScope(req), task.id);
    if (!pending || !task.response) return task;
    try {
      inspectPlatformMutation(req, pending.token);
      return { ...task, response: { ...task.response, proposal: pending } };
    } catch {
      // A refreshed login may read its task, but cannot inherit another session's confirmation.
      return { ...task, response: { ...task.response, proposal: { ...task.response.proposal, expiresAt: 0 } } };
    }
  };
  const dependencies = async (req: Request, res: Response, task?: PlatformAssistantTaskDetail): Promise<PlatformAssistantDeps> => {
    const target = !options.complete && copilotModelEnabled() ? await resolvePlatformAssistantChatTarget() : null;
    const readOnly = req.header('x-rdk-ops-read-only') === '1';
    return {
      blockedMutationDigests: task ? await service().getMutationDigests(platformAssistantTaskScope(req), task.id) : [],
      businessContext: [
        ...(task ? await platformAssistantExperience(service(), platformAssistantTaskScope(req), task.context, task.id) : []),
        ...(!req.opsTenantAccess && !options.complete ? await loadPluginAssistantContext(sessionOwner(req)) : []),
      ],
      operations: visiblePlatformOperations(router, req).filter((item) => !readOnly || !item.mutating),
      enabled: options.enabled ?? (() => Boolean(target)),
      complete: options.complete ?? ((messages) => {
        if (!target) throw new Error('platform_assistant_model_unavailable');
        return callGatewayChat(target, messages, 35_000, { maxTokens: 4_096 });
      }),
      proposeMutation: (operation, args) => proposePlatformMutation(req, operation, args),
      execute: (id, args) => executePlatformOperation(router, req, res, id, args),
    };
  };
  const enter = (req: Request, res: Response): string | undefined => {
    const scope = platformAssistantTaskScope(req);
    if (active.size >= 4 || active.has(scope)) { res.status(429).json({ ok: false, error: 'platform_assistant_busy' }); return undefined; }
    active.add(scope); return scope;
  };
  const finish = async (scope: string, task: PlatformAssistantTaskDetail, response: PlatformAssistantResult, history = task.history) => service().finish(scope, task.id, task.revision,
    { response, history: [...history, { role: 'assistant' as const, content: platformAssistantHistoryContent(response.reply, response.operations) }].slice(-12) });
  const recordFailure = async (scope: string, task: PlatformAssistantTaskDetail | undefined, receipts: PlatformAssistantOperationResult[] = []) => {
    if (!task) return;
    try { await service().finish(scope, task.id, task.revision, { status: 'failed', response: {
      reply: '任务未能继续完成。已有操作请以回执为准；请先查询当前状态，不要重复提交变更。（platform_assistant_task_interrupted）', operations: receipts,
    } }); } catch { /* Persisted leases recover as interrupted; never retry a side effect. */ }
  };

  router.get(`${API}/tasks`, tenantScopeGate, requireAccess, async (req, res) => {
    try { res.json({ ok: true, persistenceEnabled: true, ...await service().list(platformAssistantTaskScope(req)) }); } catch (error) { failure(res, error); }
  });
  router.get(`${API}/tasks/cases`, tenantScopeGate, requireAccess, async (req, res) => {
    try {
      const cases = await service().exportCases(platformAssistantTaskScope(req));
      if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="assistant-task-cases.json"');
      res.json({ ok: true, ...cases });
    } catch (error) { failure(res, error); }
  });
  router.get(`${API}/tasks/:taskId`, tenantScopeGate, requireAccess, async (req, res) => {
    try { res.json({ ok: true, task: await publicTask(req, await service().get(platformAssistantTaskScope(req), String(req.params.taskId))) }); }
    catch (error) { failure(res, error); }
  });
  router.post(`${API}/tasks/:taskId/feedback`, tenantScopeGate, requireAccess, requireOpsMutationGuard, async (req, res) => {
    if (req.header('x-rdk-ops-read-only') === '1') { res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); return; }
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['rating', 'expectedRevision'].includes(key))
        || !['helpful', 'not_helpful'].includes(body.rating) || !Number.isSafeInteger(body.expectedRevision)) throw new Error('platform_assistant_invalid_feedback');
      const task = await service().feedback(platformAssistantTaskScope(req), String(req.params.taskId), body.expectedRevision, body.rating);
      res.json({ ok: true, task: await publicTask(req, task) });
    } catch (error) { failure(res, error); }
  });
  router.post(`${API}/chat`, tenantScopeGate, requireAccess, requireOpsMutationGuard, async (req, res, next) => {
    if (req.body?.taskId === undefined) { next(); return; }
    const scope = enter(req, res); if (!scope) return;
    let task: PlatformAssistantTaskDetail | undefined;
    try {
      const raw = req.body;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['taskId', 'message', 'history', 'context'].includes(key))
        || (raw.taskId !== null && typeof raw.taskId !== 'string')) throw new Error('platform_assistant_invalid_input');
      const { taskId, ...request } = raw;
      const input = validatePlatformAssistantInput(request);
      input.context = { ...input.context, tenant: req.opsTenantAccess?.tenantId ?? (typeof req.query.tenant === 'string' ? req.query.tenant : 'platform') };
      if (taskId === null) task = await service().create(scope, { goal: input.message, context: input.context });
      else {
        const previous = await service().get(scope, taskId);
        task = await service().claim(scope, taskId, previous.revision, input.context);
        // Stored safe history is authoritative for an existing task; clients cannot replace it.
        input.history = task.history;
      }
      const history = [...task.history, { role: 'user' as const, content: input.message }].slice(-11);
      const response = await runPlatformAssistant(input, await dependencies(req, res, task));
      task = await finish(scope, task, response, history);
      res.json({ ok: true, ...response, task: await publicTask(req, task) });
    } catch (error) { await recordFailure(scope, task); failure(res, error); }
    finally { active.delete(scope); }
  });
  router.post(`${API}/confirm`, tenantScopeGate, requireAccess, requireOpsMutationGuard, async (req, res, next) => {
    if (req.body?.taskId === undefined) { next(); return; }
    if (req.header('x-rdk-ops-read-only') === '1') { res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); return; }
    const scope = enter(req, res); if (!scope) return;
    let task: PlatformAssistantTaskDetail | undefined; const receipts: PlatformAssistantOperationResult[] = [];
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['token', 'taskId'].includes(key))
        || typeof body.taskId !== 'string') throw new Error('platform_assistant_invalid_authorization');
      const authorization = inspectPlatformMutation(req, body.token);
      const catalog = visiblePlatformOperations(router, req);
      const operation = catalog.find((item) => item.id === authorization.operationId && item.mutating);
      if (!operation) throw new Error('platform_assistant_invalid_authorization');
      const previous = await service().get(scope, body.taskId);
      task = (await service().claimConfirmation(scope, previous.id, previous.revision, body.token, platformAssistantMutationDigest(operation.id, authorization.args))).task;
      await (options.claimMutation ?? claimPlatformMutation)(authorization);
      const executed = await executePlatformOperation(router, req, res, operation.id, authorization.args);
      const receipt = { id: operation.id, description: operation.description, ...executed }; receipts.push(receipt);
      const unknown = executed.data && typeof executed.data === 'object' && (executed.data as Record<string, unknown>).outcome === 'unknown';
      let response: PlatformAssistantResult;
      if (!receipt.ok || unknown) response = { reply: '变更结果未确认或未完成，已停止后续操作。请先查询当前状态，避免重复提交。', operations: receipts };
      else {
        const deps = await dependencies(req, res, task);
        const latestRequest = [...task.history].reverse().find((item) => item.role === 'user')?.content ?? task.goal;
        response = await runPlatformAssistant({ message: latestRequest, history: task.history.slice(-12), context: task.context }, {
          ...deps, continuation: { receipt, args: authorization.args, readback: platformAssistantReadback(operation, authorization.args, receipt, catalog) },
        });
      }
      task = await finish(scope, task, response);
      res.json({ ok: true, ...response, task: await publicTask(req, task) });
    } catch (error) { await recordFailure(scope, task, receipts); failure(res, error); }
    finally { active.delete(scope); }
  });
}
