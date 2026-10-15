/** Platform assistant facade; endpoint guards remain authoritative for every tool. */
import { loadPluginAssistantContext } from './plugin-assistant-context.js';
import { sessionOwner } from './ssh-log-routes.js';
import type { RequestHandler, Router } from 'express';
import { hasInvalidAdminToken, hasInvalidTenantToken, isOpsAdminRequest } from './observability-access.js';
import { clientErrorCode, requireOpsMutationGuard, tenantScopeGate } from './observability-route-kit.js';
import { callGatewayChat, copilotModelEnabled } from '../observability/copilot-model.js';
import { resolvePlatformAssistantChatTarget } from '../observability/platform-assistant-model.js';
import { runPlatformAssistant, platformAssistantHistoryContent } from '../observability/platform-assistant.js';
import { proposePlatformMutation, inspectPlatformMutation, claimPlatformMutation } from './platform-assistant-authorization.js';
import { executePlatformOperation, visiblePlatformOperations } from './platform-operations.js';
import { registerPlatformAssistantTaskRoutes } from './platform-assistant-task-routes.js';

export const requirePlatformAssistantAccess: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.opsTenantAccess || (!hasInvalidAdminToken(req) && !hasInvalidTenantToken(req) && isOpsAdminRequest(req))) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: 'not_authorized' });
};

export function registerPlatformAssistantRoutes(router: Router): void {
  registerPlatformAssistantTaskRoutes(router, requirePlatformAssistantAccess);
  router.get('/api/ops/observability/assistant/capabilities', tenantScopeGate, requirePlatformAssistantAccess, async (req, res) => {
    const readOnly = req.header('x-rdk-ops-read-only') === '1';
    res.json({ ok: true, modelEnabled: copilotModelEnabled() && !!(await resolvePlatformAssistantChatTarget()), readOnlyExecutionSupported: true, mutationConfirmationRequired: true, taskPersistenceSupported: true,
      operations: visiblePlatformOperations(router, req).filter((operation) => !readOnly || !operation.mutating) });
  });
  router.post('/api/ops/observability/assistant/confirm', tenantScopeGate, requirePlatformAssistantAccess, requireOpsMutationGuard, async (req, res) => {
    if (req.header('x-rdk-ops-read-only') === '1') { res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); return; }
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => key !== 'token')) {
        res.status(400).json({ ok: false, error: 'platform_assistant_invalid_authorization' }); return;
      }
      const authorization = inspectPlatformMutation(req, req.body.token);
      const operation = visiblePlatformOperations(router, req).find((item) => item.id === authorization.operationId && item.mutating);
      if (!operation) { res.status(403).json({ ok: false, error: 'unknown_platform_operation' }); return; }
      // Claim before side effects, shared by all instances. A timeout is never retried.
      await claimPlatformMutation(authorization);
      const result = await executePlatformOperation(router, req, res, operation.id, authorization.args);
      const reply = result.ok ? '已执行确认的变更，请查看操作回执。' : '变更结果未确认或未完成，请查看回执；请先查询当前状态。';
      const operations = [{ id: operation.id, description: operation.description, ...result }];
      res.json({ ok: true, reply, operations, historyContent: platformAssistantHistoryContent(reply, operations) });
    } catch (error) {
      const code = clientErrorCode(error, 'platform_assistant_authorization_failed');
      res.status(code === 'platform_assistant_authorization_store_unavailable' ? 503 : code === 'platform_assistant_authorization_already_used' ? 409 : 400).json({ ok: false, error: code });
    }
  });
  let active = 0;
  const inFlight = new Set<string>();
  router.post('/api/ops/observability/assistant/chat', tenantScopeGate, requirePlatformAssistantAccess, requireOpsMutationGuard, async (req, res) => {
    const principal = req.opsTenantAccess?.tenantId ?? String(req.header('x-rdk-sso-session') ?? req.header('cookie') ?? req.header('x-admin-token') ?? 'local-operator');
    if (active >= 4 || inFlight.has(principal)) {
      res.status(429).json({ ok: false, error: 'platform_assistant_busy' });
      return;
    }
    active++;
    inFlight.add(principal);
    try {
      const input = req.body;
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.message !== 'string') {
        res.status(400).json({ ok: false, error: 'invalid_assistant_request' });
        return;
      }
      const target = copilotModelEnabled() ? await resolvePlatformAssistantChatTarget() : null;
      const readOnly = req.header('x-rdk-ops-read-only') === '1';
      const response = await runPlatformAssistant(input, {
        businessContext: req.opsTenantAccess ? [] : await loadPluginAssistantContext(sessionOwner(req)),
        operations: visiblePlatformOperations(router, req).filter((operation) => !readOnly || !operation.mutating),
        proposeMutation: (operation, args) => proposePlatformMutation(req, operation, args),
        execute: (id, args) => executePlatformOperation(router, req, res, id, args),
        enabled: () => !!target,
        complete: (messages) => {
          if (!target) throw new Error('platform_assistant_model_unavailable');
          return callGatewayChat(target, messages, 35_000, { maxTokens: 4_096 });
        },
      });
      res.json({ ok: true, ...response });
    } catch (error) {
      const code = clientErrorCode(error, 'platform_assistant_unavailable');
      res.status(/^platform_assistant_(?:invalid_(?:input|history|context)|message_too_large)$/.test(code) ? 400 : 503).json({ ok: false, error: code });
    } finally {
      active--;
      inFlight.delete(principal);
    }
  });
}
