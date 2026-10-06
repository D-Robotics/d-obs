/** 模型池控制面域路由：健康总览、单目标真实探测、路由调整、目标替换（先预探测+快照）与回滚。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  isProtectedAgentFrontendModel,
  requireObservabilityAccess,
  requireOpsMutationGuard,
  resolveOpsActor,
} from './observability-route-kit.js';
import {
  getGatewayConfigSummary,
  getGatewayProviderHealth,
  removeGatewayModel,
  preflightGatewayTarget,
  probeGatewayProvider,
  replaceGatewayModel,
  updateGatewayModelRouting,
} from '../credits/gateway-admin-client.js';
import { getLatestOpsConfigurationAuditDetails, recordOpsConfigurationAudit } from './observability-store.js';
import { resolveStudioGatewayPublicModel } from '../agent/studio-agent-env.js';

/**
 * The gateway admin response is an internal credential-bearing payload. The
 * workbench only needs routing metadata; never send upstream credentials to a
 * browser, even when the upstream happens to include them in /admin/config.
 */
export function sanitizeGatewayConfigSummary(
  config: Awaited<ReturnType<typeof getGatewayConfigSummary>>,
): Record<string, unknown> {
  const modelMapping: Record<string, Record<string, unknown>> = {};
  for (const [frontendModel, item] of Object.entries(config.modelMapping ?? {})) {
    modelMapping[frontendModel] = {
      baseUrl: item.baseUrl,
      model: item.model,
      ...(item.label ? { label: item.label } : {}),
      ...(item.fallbacks ? { fallbacks: item.fallbacks } : {}),
      ...(item.weight === undefined ? {} : { weight: item.weight }),
    };
  }
  return {
    modelMapping,
    ...(config.fallbackPolicy === undefined ? {} : { fallbackPolicy: config.fallbackPolicy }),
  };
}

export function registerModelPoolRoutes(router: Router): void {
  router.get(
    '/api/ops/observability/model-pool',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        const [health, config] = await Promise.all([
          getGatewayProviderHealth(),
          getGatewayConfigSummary(),
        ]);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          health,
          config: sanitizeGatewayConfigSummary(config),
          protectedFrontendModel: resolveStudioGatewayPublicModel(),
        });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'model_pool_unavailable'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/model-pool/probe',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const model = String(req.body?.model ?? '').trim();
      if (!model || model.length > 120) {
        res.status(400).json({ ok: false, error: 'invalid_model' });
        return;
      }
      try {
        const result = await probeGatewayProvider(model);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'probe_model_pool',
          summary: `探测模型池目标：${model}`,
        }).catch(() => undefined);
        res.json({ ok: true, result });
      } catch (error) {
        res
          .status(502)
          .json({ ok: false, error: clientErrorCode(error, 'model_probe_failed') });
      }
    },
  );

  router.post(
    '/api/ops/observability/model-pool/cleanup',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const frontendModel = String(req.body?.frontendModel ?? '').trim();
      const rawTarget = req.body?.target;
      const baseUrl = String(rawTarget?.baseUrl ?? '').trim();
      const model = String(rawTarget?.model ?? '').trim();
      const protectedRoute = frontendModel ? isProtectedAgentFrontendModel(frontendModel) : false;
      if (protectedRoute || req.body?.confirm !== 'CLEANUP') {
        res.status(400).json({
          ok: false,
          error: protectedRoute ? 'agent_route_locked' : 'cleanup_confirmation_required',
        });
        return;
      }
      if (!baseUrl || baseUrl.length > 512 || !model || model.length > 160) {
        res.status(400).json({ ok: false, error: 'invalid_cleanup_target' });
        return;
      }
      let normalizedBaseUrl = '';
      try {
        const parsed = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
        normalizedBaseUrl = parsed.toString().replace(/\/$/, '');
      } catch {
        res.status(400).json({ ok: false, error: 'invalid_cleanup_target' });
        return;
      }
      try {
        // Only orphaned targets can be cleaned from this quick action. A target
        // still referenced by a route must be changed through routing first.
        const health = await getGatewayProviderHealth();
        const current = (health.targets ?? []).find(
          (target) =>
            target.baseUrl.replace(/\/$/, '') === normalizedBaseUrl && target.model === model,
        );
        if (!current) {
          res.status(404).json({ ok: false, error: 'model_target_not_found' });
          return;
        }
        if (current && ((current.roles ?? []).includes('primary') || (current.frontendModels ?? []).length)) {
          res.status(409).json({ ok: false, error: 'model_target_in_use' });
          return;
        }
        const result = await removeGatewayModel({
          ...(frontendModel ? { frontendModel } : {}),
          baseUrl: normalizedBaseUrl,
          model,
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'cleanup_model_pool_target',
          summary: `清理无路由引用的模型目标：${model}@${new URL(normalizedBaseUrl).hostname}`,
          details: { frontendModel: frontendModel || null, target: { baseUrl: normalizedBaseUrl, model } },
        }).catch(() => undefined);
        res.json({ ok: true, result });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'model_cleanup_failed'),
        });
      }
    },
  );

  router.put(
    '/api/ops/observability/model-pool/routing',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const frontendModel = String(req.body?.frontendModel ?? '').trim();
      const fallbacks = Array.isArray(req.body?.fallbacks)
        ? req.body.fallbacks.map((value: unknown) => String(value).trim()).filter(Boolean)
        : null;
      const weight = req.body?.weight === undefined ? undefined : Number(req.body.weight);
      const protectedRoute = isProtectedAgentFrontendModel(frontendModel);
      if (
        !frontendModel ||
        protectedRoute ||
        !fallbacks ||
        fallbacks.length > 8 ||
        new Set(fallbacks).size !== fallbacks.length
      ) {
        res
          .status(400)
          .json({ ok: false, error: protectedRoute ? 'agent_route_locked' : 'invalid_routing' });
        return;
      }
      if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1000)) {
        res.status(400).json({ ok: false, error: 'invalid_weight' });
        return;
      }
      try {
        const result = await updateGatewayModelRouting(frontendModel, {
          fallbacks,
          ...(weight === undefined ? {} : { weight }),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'update_model_pool_routing',
          summary: `调整模型池路由：${frontendModel} → ${fallbacks.join('、')}`,
        }).catch(() => undefined);
        res.json({ ok: true, result });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'model_routing_update_failed'),
        });
      }
    },
  );

  router.put(
    '/api/ops/observability/model-pool/replace',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const frontendModel = String(req.body?.frontendModel ?? '').trim();
      const target = req.body?.target;
      const protectedRoute = isProtectedAgentFrontendModel(frontendModel);
      if (protectedRoute || !frontendModel || !target || req.body?.confirm !== 'REPLACE') {
        res.status(400).json({
          ok: false,
          error: protectedRoute ? 'agent_route_locked' : 'replacement_confirmation_required',
        });
        return;
      }
      const baseUrl = String(target.baseUrl ?? '').trim();
      const model = String(target.model ?? '').trim();
      const apiKey = String(target.apiKey ?? '').trim();
      const label = String(target.label ?? '')
        .trim()
        .slice(0, 120);
      if (!/^https:\/\//i.test(baseUrl) || !model || apiKey.length < 20 || apiKey.length > 512) {
        res.status(400).json({ ok: false, error: 'invalid_replacement_target' });
        return;
      }
      // Pre-flight the NEW target with one tiny real completion BEFORE any
      // gateway config is written: a replace that points Agent traffic at a
      // dead upstream is the most expensive control-plane mistake here.
      const preflight = await preflightGatewayTarget({ baseUrl, model, apiKey });
      if (!preflight.ok) {
        res.status(400).json({
          ok: false,
          error: 'model_replacement_preflight_failed',
          preflight: {
            status: preflight.status,
            elapsedMs: preflight.elapsedMs,
            errorCategory: preflight.errorCategory ?? 'http',
          },
        });
        return;
      }
      // Snapshot the previous target so a bad replace is one-click reversible.
      // The old api key is never persisted — only a fingerprint plus the
      // non-secret fields needed to reason about the snapshot.
      let previousSnapshot: Record<string, unknown> | null = null;
      try {
        const config = await getGatewayConfigSummary();
        const existing = config?.modelMapping?.[frontendModel];
        if (existing) {
          previousSnapshot = {
            baseUrl: String(existing.baseUrl ?? ''),
            model: String(existing.model ?? ''),
            label: existing.label ? String(existing.label) : null,
            apiKeyFingerprint: existing.apiKey
              ? String(existing.apiKey).slice(0, 6) + '…' + String(existing.apiKey).slice(-4)
              : null,
          };
        }
      } catch {
        previousSnapshot = null;
      }
      try {
        const result = await replaceGatewayModel(frontendModel, {
          baseUrl,
          model,
          apiKey,
          ...(label ? { label } : {}),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'replace_model_pool_target',
          summary: `替换模型池目标：${frontendModel} → ${model}@${new URL(baseUrl).hostname}（预探测 ${preflight.elapsedMs}ms 通过）`,
          details: {
            frontendModel,
            previous: previousSnapshot,
            next: { baseUrl, model, label: label || null },
            preflight: { ok: true, elapsedMs: preflight.elapsedMs, status: preflight.status },
          },
        }).catch(() => undefined);
        res.json({ ok: true, result, preflight });
      } catch (error) {
        res
          .status(400)
          .json({ ok: false, error: clientErrorCode(error, 'model_replacement_failed') });
      }
    },
  );

  router.post(
    '/api/ops/observability/model-pool/rollback',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const frontendModel = String(req.body?.frontendModel ?? '').trim();
      const protectedRoute = isProtectedAgentFrontendModel(frontendModel);
      if (!frontendModel || protectedRoute || req.body?.confirm !== 'ROLLBACK') {
        res.status(400).json({
          ok: false,
          error: protectedRoute ? 'agent_route_locked' : 'rollback_confirmation_required',
        });
        return;
      }
      const snapshot = await getLatestOpsConfigurationAuditDetails(
        'replace_model_pool_target',
        frontendModel,
      );
      const previous =
        snapshot?.details &&
        typeof snapshot.details.previous === 'object' &&
        snapshot.details.previous !== null
          ? (snapshot.details.previous as Record<string, unknown>)
          : null;
      const baseUrl = previous ? String(previous.baseUrl ?? '').trim() : '';
      const model = previous ? String(previous.model ?? '').trim() : '';
      if (!/^https:\/\//i.test(baseUrl) || !model) {
        // A rollback needs the original upstream plus its key. Keys are never
        // persisted (only fingerprints), so the operator must re-enter the
        // credential: fail closed with the snapshot info instead of guessing.
        res.status(409).json({
          ok: false,
          error: 'rollback_snapshot_incomplete',
          snapshot: { occurredAt: snapshot?.occurredAt ?? null, previous },
        });
        return;
      }
      const apiKey = String(req.body?.apiKey ?? '').trim();
      if (apiKey.length < 20 || apiKey.length > 512) {
        res.status(409).json({
          ok: false,
          error: 'rollback_api_key_required',
          snapshot: { occurredAt: snapshot?.occurredAt ?? null, previous },
        });
        return;
      }
      const label = previous?.label ? String(previous.label).slice(0, 120) : '';
      try {
        const preflight = await preflightGatewayTarget({ baseUrl, model, apiKey });
        if (!preflight.ok) {
          res.status(400).json({
            ok: false,
            error: 'rollback_preflight_failed',
            preflight: {
              status: preflight.status,
              elapsedMs: preflight.elapsedMs,
              errorCategory: preflight.errorCategory ?? 'http',
            },
          });
          return;
        }
        const result = await replaceGatewayModel(frontendModel, {
          baseUrl,
          model,
          apiKey,
          ...(label ? { label } : {}),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'rollback_model_pool_target',
          summary: `回滚模型池目标：${frontendModel} → ${model}@${new URL(baseUrl).hostname}（恢复自 ${snapshot?.occurredAt ?? '未知时间'} 的替换前快照）`,
        }).catch(() => undefined);
        res.json({ ok: true, result, preflight });
      } catch (error) {
        res
          .status(400)
          .json({ ok: false, error: clientErrorCode(error, 'model_rollback_failed') });
      }
    },
  );
}
