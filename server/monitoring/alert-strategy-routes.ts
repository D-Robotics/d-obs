/**
 * 自定义告警策略 CRUD 路由（P2 策略引擎）。
 *
 * 可见性：租户视角（组员头/租户 token/管理员 ?tenant=）= 本租户 + platform
 * 公共层合并；平台全局 = 仅 platform。写入：平台管理员可管 platform 与任意
 * 租户；SSO 组员中仅 owner 可写本租户；member 只读（P3 再评估放宽）。
 */
import { type Request, type Response } from 'express';

import {
  isAlertDeliveryChannel,
} from './alert-notification-channels.js';
import {
  STRATEGY_COMPARATORS,
  STRATEGY_SEVERITIES,
  configureStrategyPoolForTest,
  createStrategy,
  deleteStrategy,
  getStrategy,
  getStrategyPool,
  listStrategies,
  updateStrategy,
  type StrategyRuleInput,
} from './alert-strategy-store.js';
import {
  clientErrorCode,
  queryText,
  requireOpsMutationGuard,
  resolveAdminTenantScope,
  tenantScopeGate,
  requireObservabilityAccessTenantAware,
} from './observability-route-kit.js';
import { isOpsAdminRequest, resolveOpsActorId } from './observability-access.js';
import type { Router } from 'express';

export { configureStrategyPoolForTest };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并规范化规则行数组；非法抛带机器码的 Error（clientErrorCode 放行）。 */
function parseRuleRows(raw: unknown): StrategyRuleInput[] {
  if (!Array.isArray(raw) || raw.length < 1) throw new Error('strategy_rules_required');
  if (raw.length > 10) throw new Error('strategy_rules_limit');
  return raw.map((entry) => {
    if (!isPlainObject(entry)) throw new Error('strategy_rule_invalid');
    const query = String(entry.query ?? '').trim();
    if (!query || query.length > 2000) throw new Error('strategy_rule_query_invalid');
    const durationSeconds = Number(entry.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 86_400) {
      throw new Error('strategy_rule_duration_invalid');
    }
    const comparator = String(entry.comparator ?? '');
    if (!(STRATEGY_COMPARATORS as readonly string[]).includes(comparator)) {
      throw new Error('strategy_rule_comparator_invalid');
    }
    const threshold = Number(entry.threshold);
    if (!Number.isFinite(threshold)) throw new Error('strategy_rule_threshold_invalid');
    const severity = String(entry.severity ?? '');
    if (!(STRATEGY_SEVERITIES as readonly string[]).includes(severity)) {
      throw new Error('strategy_rule_severity_invalid');
    }
    const sendIntervalMinutes = Number(entry.sendIntervalMinutes ?? 0);
    if (
      !Number.isFinite(sendIntervalMinutes) ||
      sendIntervalMinutes < 0 ||
      sendIntervalMinutes > 1440
    ) {
      throw new Error('strategy_rule_interval_invalid');
    }
    return {
      query,
      durationSeconds: Math.floor(durationSeconds),
      comparator: comparator as StrategyRuleInput['comparator'],
      threshold,
      severity: severity as StrategyRuleInput['severity'],
      sendIntervalMinutes: Math.floor(sendIntervalMinutes),
      noDataAlert: entry.noDataAlert === true,
    };
  });
}

function parseStrategyBody(body: unknown): {
  name: string;
  description: string;
  enabled: boolean;
  notificationChannel: string;
  rules: StrategyRuleInput[];
} {
  if (!isPlainObject(body)) throw new Error('strategy_payload_invalid');
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('strategy_name_invalid');
  const description = String(body.description ?? '')
    .trim()
    .slice(0, 300);
  const enabled = body.enabled !== false;
  const notificationChannel = String(body.notificationChannel ?? 'default').trim();
  if (
    notificationChannel !== 'default' &&
    notificationChannel !== 'none' &&
    !isAlertDeliveryChannel(notificationChannel)
  ) {
    throw new Error('strategy_channel_invalid');
  }
  return {
    name,
    description,
    enabled,
    notificationChannel,
    rules: parseRuleRows(body.rules),
  };
}

/** 写权限：平台管理员，或「SSO 组员 owner」。返回可写租户判定所需信息。 */
function resolveWriteIdentity(req: Request): {
  isAdmin: boolean;
  tenantId: string | null;
  actor: string;
} {
  const admin = isOpsAdminRequest(req);
  const access = req.opsTenantAccess ?? null;
  const isOwner =
    access?.source === 'member' && access.role === 'owner' ? access.tenantId : null;
  return {
    isAdmin: admin,
    tenantId: isOwner,
    actor: resolveOpsActorId(req),
  };
}

export function registerStrategyRoutes(router: Router): void {
  router.get(
    '/api/ops/observability/strategies',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        const tenantScope = req.opsTenantAccess
          ? req.opsTenantAccess.tenantId
          : await resolveAdminTenantScope(req);
        const strategies = await listStrategies(await getStrategyPool(), tenantScope);
        const access = req.opsTenantAccess ?? null;
        const canWrite =
          isOpsAdminRequest(req) || (access?.source === 'member' && access.role === 'owner');
        res.json({ ok: true, strategies, canWrite });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'strategy_list_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/strategies',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const identity = resolveWriteIdentity(req);
        if (!identity.isAdmin && !identity.tenantId) {
          res.status(403).json({ ok: false, error: 'strategy_write_owner_only' });
          return;
        }
        const input = parseStrategyBody(req.body);
        let tenantId = 'platform';
        if (!identity.isAdmin) {
          tenantId = identity.tenantId as string;
        } else {
          const requested = queryText(req.query as Record<string, unknown>, 'tenant', 40);
          if (requested && requested !== 'platform') {
            const { listTenants } = await import('./tenant-store.js');
            const tenants = await listTenants().catch(() => []);
            if (!tenants.some((tenant) => tenant.tenantId === requested)) {
              res.status(400).json({ ok: false, error: 'strategy_tenant_invalid' });
              return;
            }
            tenantId = requested;
          }
        }
        const created = await createStrategy(
          await getStrategyPool(),
          { ...input, tenantId },
          identity.actor,
        );
        res.status(201).json({ ok: true, strategy: created });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'strategy_create_failed') });
      }
    },
  );

  const loadAndAuthorize = async (
    req: Request,
    res: Response,
  ): Promise<{ id: string } | null> => {
    const id = String(req.params.strategyId ?? '').trim();
    const strategy = await getStrategy(await getStrategyPool(), id);
    if (!strategy) {
      res.status(404).json({ ok: false, error: 'strategy_not_found' });
      return null;
    }
    const identity = resolveWriteIdentity(req);
    const allowed =
      identity.isAdmin ||
      (identity.tenantId != null && strategy.tenantId === identity.tenantId);
    if (!allowed) {
      res.status(403).json({ ok: false, error: 'strategy_write_owner_only' });
      return null;
    }
    return { id };
  };

  router.put(
    '/api/ops/observability/strategies/:strategyId',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const target = await loadAndAuthorize(req, res);
        if (!target) return;
        const identity = resolveWriteIdentity(req);
        const input = parseStrategyBody(req.body);
        const updated = await updateStrategy(await getStrategyPool(), target.id, input, identity.actor);
        if (!updated) {
          res.status(404).json({ ok: false, error: 'strategy_not_found' });
          return;
        }
        res.json({ ok: true, strategy: updated });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'strategy_update_failed') });
      }
    },
  );

  router.delete(
    '/api/ops/observability/strategies/:strategyId',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const target = await loadAndAuthorize(req, res);
        if (!target) return;
        const removed = await deleteStrategy(await getStrategyPool(), target.id);
        if (!removed) {
          res.status(404).json({ ok: false, error: 'strategy_not_found' });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'strategy_delete_failed') });
      }
    },
  );

}
