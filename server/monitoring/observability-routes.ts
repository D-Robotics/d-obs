/**
 * 生产可观测看板 API。数据是跨租户聚合运维信号，因此复用增长看板的运营 allowlist：
 * web-cloud 仅运营账号或后台 token 可见，普通租户不能读取。
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  getSessionSsoUser,
  isMultiUserWebDeployment,
} from './observability-access-adapter.js';
import {
  getOpsEventDetail,
  getOpsObservabilityOverview,
  isOpsObservabilityConfigured,
  recordOpsConfigurationAudit,
  recordOpsNotificationTest,
  updateOpsIncident,
} from './observability-store.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import {
  createPostgresTableCsvExport,
  getPostgresDashboard,
  getPostgresTableDetail,
  PostgresTableDetailError,
  serializePostgresTableCsvLine,
} from './postgres-dashboard-store.js';
import { getFlywheelObservation } from '../flywheel/flywheel-observation.js';
import { getFlywheelOverview } from '../flywheel/metrics-store.js';
import { getOperatorMetrics } from '../flywheel/operator-metrics-store.js';
import { getPublicObservabilityStore } from '../public-api/public-observability-store.js';
import {
  getRunObservability,
  RunObservabilityStoreUnavailableError,
  type RunObservabilityAccess,
} from '../observability/run-observability-service.js';
import { inspectAdministratorRunLocator } from '../observability/run-locator.js';
import {
  authorizeTelemetryAccess,
  type TelemetryActor,
} from '../observability/governance-access-control.js';
import { TelemetryAuditUnavailableError } from '../observability/governance-audit.js';
import { createCentralPostgresTelemetryAuditGuard } from '../observability/governance-postgres-audit-sink.js';
import {
  telemetryGovernanceProtectedReadsReady,
  telemetryGovernanceRestoreReadiness,
} from '../observability/governance-runtime-service.js';
import {
  emptyRunTraceListPage,
  getRunTraceList,
  InvalidTraceCursorError,
} from '../observability/run-trace-list-store.js';
import type { TelemetryRole } from '../../shared/telemetry-data-governance.js';
import {
  alertConfigValidationMessage,
  loadAlertConfig,
  mergeAndValidateAlertConfig,
  saveAlertConfig,
  toPublicAlertConfig,
  type AlertConfigPatch,
} from './alert-config.js';
import { getRemediationOverview } from './alert-remediation.js';
import { sendAlertTestNotification } from './studio-alert-worker.js';
import { getConfiguredServiceLevelOverview } from './service-level-objectives.js';
import {
  getGatewayConfigSummary,
  getGatewayProviderHealth,
  probeGatewayProvider,
  replaceGatewayModel,
  updateGatewayModelRouting,
} from '../credits/gateway-admin-client.js';
import {
  resolveStudioGatewayPublicModel,
  type StudioAgentEnvironment,
} from '../agent/studio-agent-env.js';
import { createObservabilityActionRouter } from './observability-action-routes.js';
import {
  hasInvalidAdminToken,
  isOpsAdminRequest,
  resolveOpsActorId,
} from './observability-access.js';

const execFileAsync = promisify(execFile);
let configWriteQueue: Promise<void> = Promise.resolve();
const OPS_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Query parsing shared by the read-only compatibility surfaces below. */
function queryText(query: Record<string, unknown>, key: string, max = 120): string | undefined {
  const value = String(query[key] ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
  return value || undefined;
}

function queryInteger(
  query: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(query[key] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function queryBoolean(query: Record<string, unknown>, key: string): boolean | undefined {
  const raw = query[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

const publicObservabilityStore = getPublicObservabilityStore();

export function isProtectedAgentFrontendModel(
  frontendModel: string,
  environment: StudioAgentEnvironment = process.env,
): boolean {
  const protectedModel = resolveStudioGatewayPublicModel(environment);
  return protectedModel.length > 0 && frontendModel === protectedModel;
}

const resolveOpsActor = resolveOpsActorId;

function resolveObservabilityAccess(req: Request): {
  enabled: boolean;
  isAdmin: boolean;
  reason?: string;
} {
  // An explicitly supplied token is never allowed to silently degrade into
  // anonymous/local-operator access.  This matters for the token-only
  // bootstrap path, which runs before the global SSO middleware.
  if (hasInvalidAdminToken(req)) {
    return { enabled: false, isAdmin: false, reason: 'not_authorized' };
  }
  if (!isOpsObservabilityConfigured()) {
    return { enabled: false, isAdmin: false, reason: 'central_store_disabled' };
  }
  if (isOpsAdminRequest(req)) return { enabled: true, isAdmin: true };
  if (isMultiUserWebDeployment()) {
    return { enabled: false, isAdmin: false, reason: 'not_authorized' };
  }
  return { enabled: true, isAdmin: true };
}

/**
 * 运营管理员判定（不依赖中心库开关）：x-admin-token 常量时间匹配，或多用户
 * web 部署下 SSO 会话命中 RDK_FLYWHEEL_ADMIN_USER_IDS；单用户本地/自托管
 * 部署操作者即管理员。会话 Trace 全局视图等跨账号能力复用此闸门。
 */
export { isOpsAdminRequest } from './observability-access.js';

const requireObservabilityAccess: RequestHandler = (req, res, next) => {
  const access = resolveObservabilityAccess(req);
  if (!access.enabled) {
    res.status(access.reason === 'central_store_disabled' ? 503 : 403).json({
      ok: false,
      error: access.reason,
    });
    return;
  }
  next();
};

const requireOpsMutationGuard: RequestHandler = (req, res, next) => {
  if (req.header('x-rdk-ops-action') !== 'observability') {
    res.status(400).json({ ok: false, error: 'missing_ops_action_guard' });
    return;
  }
  const origin = String(req.header('origin') ?? '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        res.status(403).json({ ok: false, error: 'cross_origin_ops_action_denied' });
        return;
      }
    } catch {
      res.status(403).json({ ok: false, error: 'invalid_origin' });
      return;
    }
  }
  next();
};

const requireOpsContextGuard: RequestHandler = (req, res, next) => {
  if (req.header('x-rdk-ops-action') !== 'observability-context') {
    res.status(400).json({ ok: false, error: 'missing_ops_context_guard' });
    return;
  }
  const origin = String(req.header('origin') ?? '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        res.status(403).json({ ok: false, error: 'cross_origin_ops_context_denied' });
        return;
      }
    } catch {
      res.status(403).json({ ok: false, error: 'invalid_origin' });
      return;
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Protected trace reads wait for retention/tombstone replay to be ready. */
const requireTelemetryGovernanceReadiness: RequestHandler = (_req, res, next) => {
  if (telemetryGovernanceProtectedReadsReady()) {
    next();
    return;
  }
  res.status(503).json({
    ok: false,
    error: 'telemetry_governance_unavailable',
    retryable: true,
    readiness: telemetryGovernanceRestoreReadiness(),
  });
};

function observabilityRequestCorrelationId(req: Request): string {
  const supplied = String(req.header('x-request-id') ?? req.header('x-correlation-id') ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 128);
  return supplied || randomUUID();
}

function traceAuthorizationRevision(req: Request, actorId: string): string {
  // This is only a stale-session fence; the credential itself is never
  // persisted or returned.  The account scope remains server-derived below.
  return `${actorId}:${String(req.header('cookie') ?? req.header('x-admin-token') ?? '').slice(
    0,
    64,
  )}`;
}

function resolveTraceAccess(
  req: Request,
  locator: string,
): {
  actor: TelemetryActor | null;
  accessScope: RunObservabilityAccess | null;
  accountScopeId: string;
} {
  const user = getSessionSsoUser(req);
  const admin = isOpsAdminRequest(req);
  const actorId = String(user?.id ?? '').trim() || resolveOpsActor(req);
  let accountScopeId = String(user?.id ?? '').trim();
  let role: TelemetryRole = 'account_owner';

  // An explicit operations administrator may inspect the authenticated scope
  // embedded in an opaque locator.  The locator is AEAD-verified before the
  // selected scope is used; arbitrary query/body scope claims are ignored.
  if (admin && !user?.id?.trim()) {
    accountScopeId = inspectAdministratorRunLocator(locator)?.accountScopeId ?? '';
    if (accountScopeId) role = 'telemetry_administrator';
  } else if (admin && user?.id?.trim()) {
    const inspected = inspectAdministratorRunLocator(locator);
    if (inspected && inspected.accountScopeId !== user.id.trim()) {
      role = 'telemetry_administrator';
      accountScopeId = inspected.accountScopeId;
    }
  }

  if (!actorId || !accountScopeId) return { actor: null, accessScope: null, accountScopeId };
  const actor: TelemetryActor = {
    actorId,
    role,
    // For an administrator this value is the verified locator scope.  The
    // selected scope is still checked by authorizeTelemetryAccess below.
    authenticatedAccountScopeId: accountScopeId,
    entitledAccountScopeIds: [accountScopeId],
    permissions: ['telemetry.read', 'telemetry.advanced_link'],
    authorizationRevision: traceAuthorizationRevision(req, actorId),
  };
  const read = authorizeTelemetryAccess(actor, {
    permission: 'telemetry.read',
    selectedAccountScopeId: accountScopeId,
  });
  const advanced = authorizeTelemetryAccess(actor, {
    permission: 'telemetry.advanced_link',
    selectedAccountScopeId: accountScopeId,
  });
  if (!read.allowed) return { actor, accessScope: null, accountScopeId };
  const accessScope: RunObservabilityAccess =
    role === 'telemetry_administrator'
      ? {
          kind: 'administrator',
          selectedAccountScopeId: read.accountScopeId,
          advancedTraceAccess: advanced.allowed,
        }
      : {
          kind: 'owner',
          accountScopeId: read.accountScopeId,
          advancedTraceAccess: advanced.allowed,
        };
  return { actor, accessScope, accountScopeId: read.accountScopeId };
}

export function createOpsObservabilityRouter(): Router {
  const router = Router();

  // DSH-native evidence/approval/action endpoints share this authenticated
  // operations namespace but do not depend on the removed Moss runtime.
  router.use(createObservabilityActionRouter());

  // C1：Langfuse 公开看板嵌入。URL 来自服务端环境变量（运营可控），仅允许
  // http(s)；未配置时页内显示引导而非空 iframe。
  const langfuseDashboardEmbed = (): string => {
    const url = String(process.env.STUDIO_LANGFUSE_PUBLIC_DASHBOARD_URL ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return '<div class="notice">尚未配置 Langfuse 公开看板：在 Langfuse 项目里将 Dashboard 设为 Public，然后配置 <code>STUDIO_LANGFUSE_PUBLIC_DASHBOARD_URL</code> 并重启服务。</div>';
    }
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<iframe src="${safeUrl}" title="Langfuse Agent 追踪看板" loading="lazy" style="width:100%;height:72vh;border:1px solid rgba(148,163,184,.25);border-radius:12px;background:#fff"></iframe>`;
  };

  // HTML 壳本身不含任何运维数据，允许直接打开；真实数据 API 仍由下面的运营权限门控保护。
  // 这样无会话浏览器会看到明确登录引导，而不是裸露的 not_authorized JSON。
  router.get('/ops-observability', (_req: Request, res: Response) => {
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res
      .type('html')
      .send(
        OPS_OBSERVABILITY_HTML.replace('__LANGFUSE_DASHBOARD_EMBED__', langfuseDashboardEmbed()),
      );
  });

  router.get('/api/ops/observability/access', (req: Request, res: Response) => {
    if (hasInvalidAdminToken(req)) {
      res.status(403).json({ ok: false, error: 'not_authorized' });
      return;
    }
    const access = resolveObservabilityAccess(req);
    res.json({ ok: true, enabled: access.enabled, isAdmin: access.isAdmin });
  });

  router.get(
    '/api/ops/observability/overview',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const hours = queryInteger(query, 'hours', 24, 1, 168);
        const traceEnvironmentRaw = queryText(query, 'traceEnvironment', 24) ?? 'production';
        const traceEnvironment = ['production', 'staging', 'development', 'test'].includes(
          traceEnvironmentRaw,
        )
          ? (traceEnvironmentRaw as 'production' | 'staging' | 'development' | 'test')
          : null;
        if (!traceEnvironment) {
          res.status(400).json({ ok: false, error: 'invalid_trace_environment' });
          return;
        }
        const traceLimit = queryInteger(query, 'traceLimit', 40, 1, 80);
        const traceCursor = queryText(query, 'traceCursor', 4_096);
        const [overview, serviceLevels] = await Promise.all([
          getOpsObservabilityOverview(hours),
          getConfiguredServiceLevelOverview().catch(() => null),
        ]);
        let tracePage = emptyRunTraceListPage(hours, traceEnvironment);
        if (telemetryGovernanceProtectedReadsReady()) {
          try {
            tracePage = await getRunTraceList({
              hours,
              environment: traceEnvironment,
              limit: traceLimit,
              ...(traceCursor ? { cursor: traceCursor } : {}),
            });
          } catch (error) {
            if (error instanceof InvalidTraceCursorError) {
              res.status(400).json({ ok: false, error: error.code });
              return;
            }
            // A partially migrated trace schema must not hide the rest of the
            // operations dashboard.  The empty page is explicit and contains
            // no identifiers; detail reads remain protected by the governance
            // gate.
            console.warn(
              '[run-observability] list failed:',
              sanitizeOpsSummary(error, 180) || 'unknown_error',
            );
          }
        }
        res.json({ ok: true, overview: { ...overview, ...tracePage, serviceLevels } });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'observability_query_failed',
        });
      }
    },
  );

  /**
   * Central PostgreSQL read-only surfaces.  These routes intentionally call
   * the dashboard store rather than accepting SQL from the browser: the store
   * validates catalog identifiers, masks credential columns, and executes all
   * reads inside a bounded read-only transaction.
   */
  router.get(
    '/api/ops/observability/database',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const hours = queryInteger(req.query as Record<string, unknown>, 'hours', 24, 1, 24 * 30);
        const database = await getPostgresDashboard(hours);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, database });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'postgres_dashboard_query_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/database/tables/:tableName',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      let exportStarted = false;
      try {
        const query = req.query as Record<string, unknown>;
        const format = String(query.format ?? 'json')
          .trim()
          .toLowerCase();
        if (format !== 'json' && format !== 'csv') {
          res.status(400).json({ ok: false, error: 'postgres_table_export_format_invalid' });
          return;
        }
        // Keep NUL bytes intact for the dashboard store's explicit catalog
        // validation (silently stripping them here would turn malformed input
        // into a different, potentially surprising identifier).
        const schemaName =
          String(query.schema ?? 'public')
            .trim()
            .slice(0, 128) || 'public';
        const tableName = String(req.params.tableName ?? '')
          .trim()
          .slice(0, 128);
        const sortColumn = queryText(query, 'sort', 128);
        const sortDirection = queryText(query, 'direction', 8)?.toLowerCase() as
          | 'asc'
          | 'desc'
          | undefined;

        if (format === 'csv') {
          exportStarted = true;
          const tableExport = await createPostgresTableCsvExport({
            schemaName,
            tableName,
            sortColumn,
            sortDirection,
          });
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${tableExport.filename}"`);
          res.flushHeaders();
          res.write(`\uFEFF${serializePostgresTableCsvLine(tableExport.columns)}\r\n`);
          for await (const row of tableExport.rows) {
            if (res.destroyed) break;
            const ready = res.write(
              `${serializePostgresTableCsvLine(tableExport.columns.map((column) => row[column]))}\r\n`,
            );
            if (!ready) {
              await new Promise<void>((resolve) => {
                const resume = () => {
                  res.off('drain', resume);
                  res.off('close', resume);
                  resolve();
                };
                res.once('drain', resume);
                res.once('close', resume);
              });
            }
          }
          if (!res.destroyed) res.end();
          return;
        }

        const detail = await getPostgresTableDetail({
          schemaName,
          tableName,
          page: queryInteger(query, 'page', 1, 1, 2_000),
          pageSize: queryInteger(query, 'pageSize', 25, 1, 50),
          sortColumn,
          sortDirection,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail });
      } catch (error) {
        if (res.headersSent) {
          if (exportStarted) res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        if (error instanceof PostgresTableDetailError) {
          res.status(error.status).json({ ok: false, error: error.code });
          return;
        }
        res.status(503).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'postgres_table_detail_query_failed',
        });
      }
    },
  );

  /**
   * The old flywheel tabs still use these read-only aggregate endpoints.  Keep
   * them as best-effort projections so a missing legacy table degrades the
   * individual module instead of taking down the unified observability page.
   */
  router.get(
    '/api/ops/observability/learning',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const days = queryInteger(req.query as Record<string, unknown>, 'days', 30, 1, 90);
      const [skill, observation] = await Promise.allSettled([
        getFlywheelOverview(days),
        getFlywheelObservation(days),
      ]);
      const generatedAt = new Date().toISOString();
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        learning: {
          generatedAt,
          windowDays: days,
          skill:
            skill.status === 'fulfilled'
              ? { status: 'ok', overview: skill.value }
              : { status: 'unavailable' },
          observation:
            observation.status === 'fulfilled'
              ? observation.value
              : {
                  windowDays: days,
                  generatedAt,
                  experience: { status: 'unavailable' },
                  evolution: { status: 'unavailable' },
                },
        },
      });
    },
  );

  router.get(
    '/api/ops/observability/operator-metrics',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const days = queryInteger(req.query as Record<string, unknown>, 'days', 30, 1, 180);
      try {
        const metrics = await getOperatorMetrics(days);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          generatedAt: new Date().toISOString(),
          metrics,
        });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'operator_metrics_query_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/objects',
    requireObservabilityAccess,
    (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const objects = publicObservabilityStore.listObjects('*', {
          team: queryText(query, 'team', 120),
          objectType: queryText(query, 'objectType', 120),
          q: queryText(query, 'q', 120),
          ownerTeam: queryText(query, 'ownerTeam', 120) ?? queryText(query, 'owner_team', 120),
          label: queryText(query, 'label', 64),
          archived: queryBoolean(query, 'archived'),
          limit: queryInteger(query, 'limit', 200, 1, 200),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, objects });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'observability_objects_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/objects/:objectId',
    requireObservabilityAccess,
    (req: Request, res: Response) => {
      try {
        const objectId = String(req.params.objectId ?? '')
          .replace(/\0/g, '')
          .trim()
          .slice(0, 200);
        if (!objectId) {
          res.status(400).json({ ok: false, error: 'invalid_object_id' });
          return;
        }
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'windowMinutes', 1_440, 1, 10_080);
        const windowEnd = Date.now();
        const detail = publicObservabilityStore.getObject('*', objectId, {
          team: queryText(query, 'team', 120),
          objectType: queryText(query, 'objectType', 120),
          projectId: queryText(query, 'projectId', 120),
          environment: queryText(query, 'environment', 120),
          service: queryText(query, 'service', 120),
          status: queryText(query, 'status', 40) as
            | 'queued'
            | 'running'
            | 'completed'
            | 'failed'
            | 'cancelled'
            | undefined,
          windowStart: windowEnd - windowMinutes * 60_000,
          windowEnd,
        });
        if (!detail) {
          res.status(404).json({ ok: false, error: 'observability_object_not_found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'observability_object_detail_failed',
        });
      }
    },
  );

  /**
   * Scoped native Agent Run detail.  The locator is an AEAD token issued by
   * the server (the overview listing is the only producer); this endpoint
   * never accepts a raw run id and delegates redaction/tombstone filtering to
   * the DSH-safe run observability service.
   */
  router.get(
    '/api/ops/observability/runs/:locator',
    requireObservabilityAccess,
    requireOpsContextGuard,
    requireTelemetryGovernanceReadiness,
    async (req: Request, res: Response) => {
      const requestCorrelationId = observabilityRequestCorrelationId(req);
      const locator = String(req.params.locator ?? '')
        .trim()
        .slice(0, 4_096);
      const resolved = resolveTraceAccess(req, locator);
      const audit = createCentralPostgresTelemetryAuditGuard();
      const actor = resolved.actor;
      const auditScope = resolved.accountScopeId || 'unresolved-scope';

      if (!actor || !resolved.accessScope) {
        try {
          if (actor) {
            await audit.append({
              actorId: actor.actorId,
              actorRole: actor.role,
              accountScopeId: auditScope,
              action: 'access_denial',
              targetType: 'run',
              targetIdentifier: locator || 'invalid-locator',
              decision: 'denied',
              purposeCode: 'operations_trace_review',
              requestCorrelationId,
              result: 'denied',
            });
          }
          res.status(actor ? 404 : 401).json({
            ok: false,
            error: actor ? 'run_not_found' : 'authentication_required',
            requestCorrelationId,
          });
        } catch (error) {
          res.status(503).json({
            ok: false,
            error:
              error instanceof TelemetryAuditUnavailableError
                ? error.code
                : 'telemetry_audit_unavailable',
            retryable: true,
            requestCorrelationId,
          });
        }
        return;
      }

      try {
        await audit.append({
          actorId: actor.actorId,
          actorRole: actor.role,
          accountScopeId: auditScope,
          action: 'read',
          targetType: 'run',
          targetIdentifier: locator,
          decision: 'allowed',
          purposeCode: 'operations_trace_review',
          requestCorrelationId,
          result: 'authorized',
        });
        const result = await getRunObservability(locator, resolved.accessScope);
        if (result.status === 'not_found') {
          await audit.append({
            actorId: actor.actorId,
            actorRole: actor.role,
            accountScopeId: auditScope,
            action: 'read',
            targetType: 'run',
            targetIdentifier: locator,
            decision: 'denied',
            purposeCode: 'operations_trace_review',
            requestCorrelationId,
            result: 'denied',
          });
          res.status(404).json({
            ok: false,
            error: 'run_not_found',
            requestCorrelationId,
          });
          return;
        }
        await audit.append({
          actorId: actor.actorId,
          actorRole: actor.role,
          accountScopeId: auditScope,
          action: 'read',
          targetType: 'run',
          targetIdentifier: locator,
          decision: 'allowed',
          purposeCode: 'operations_trace_review',
          requestCorrelationId,
          result: 'completed',
        });
        if (result.detail.advancedExport.availability === 'available') {
          try {
            await audit.append({
              actorId: actor.actorId,
              actorRole: actor.role,
              accountScopeId: auditScope,
              action: 'advanced_link',
              targetType: 'trace',
              targetIdentifier: result.detail.run.runRef,
              decision: 'allowed',
              purposeCode: 'operations_trace_review',
              requestCorrelationId,
              result: 'completed',
            });
          } catch {
            // Keep the local low-sensitivity detail, but fail closed for an
            // optional external destination that was not durably audited.
            result.detail.advancedExport = { availability: 'unavailable' };
          }
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail: result.detail, requestCorrelationId });
      } catch (error) {
        if (error instanceof TelemetryAuditUnavailableError) {
          res.status(503).json({
            ok: false,
            error: error.code,
            retryable: true,
            requestCorrelationId,
          });
          return;
        }
        if (error instanceof RunObservabilityStoreUnavailableError) {
          res.status(503).json({
            ok: false,
            error: error.code,
            retryable: true,
            requestCorrelationId,
          });
          return;
        }
        console.warn(
          '[run-observability] detail failed:',
          sanitizeOpsSummary(error, 180) || 'unknown_error',
        );
        res.status(500).json({
          ok: false,
          error: 'run_observability_failed',
          retryable: true,
          requestCorrelationId,
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/events/:eventId',
    requireObservabilityAccess,
    requireOpsContextGuard,
    async (req: Request, res: Response) => {
      const eventId = String(req.params.eventId ?? '').trim();
      if (!OPS_EVENT_ID_PATTERN.test(eventId)) {
        res.status(400).json({ ok: false, error: 'invalid_ops_event_id' });
        return;
      }
      try {
        const detail = await getOpsEventDetail(eventId);
        if (!detail) {
          res.status(404).json({ ok: false, error: 'ops_event_not_found' });
          return;
        }
        res.json({ ok: true, detail });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'ops_event_detail_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/config',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, config: toPublicAlertConfig(await loadAlertConfig()) });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'alert_config_read_failed',
        });
      }
    },
  );

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
          config,
          protectedFrontendModel: resolveStudioGatewayPublicModel(),
        });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'model_pool_unavailable',
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
          .json({ ok: false, error: sanitizeOpsSummary(error, 240) || 'model_probe_failed' });
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
          error: sanitizeOpsSummary(error, 240) || 'model_routing_update_failed',
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
          summary: `替换模型池目标：${frontendModel} → ${model}@${new URL(baseUrl).hostname}`,
        }).catch(() => undefined);
        res.json({ ok: true, result });
      } catch (error) {
        res
          .status(400)
          .json({ ok: false, error: sanitizeOpsSummary(error, 240) || 'model_replacement_failed' });
      }
    },
  );

  router.put(
    '/api/ops/observability/config',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        let publicConfig: ReturnType<typeof toPublicAlertConfig> | null = null;
        const auditParts = Object.keys((req.body ?? {}) as Record<string, unknown>);
        const write = async () => {
          const current = await loadAlertConfig();
          const next = mergeAndValidateAlertConfig(current, (req.body ?? {}) as AlertConfigPatch);
          await saveAlertConfig(next);
          await recordOpsConfigurationAudit({
            actor: resolveOpsActor(req),
            action: 'update_config',
            summary: auditParts.length ? `更新告警配置：${auditParts.join('、')}` : '更新告警配置',
          }).catch(() => undefined);
          publicConfig = toPublicAlertConfig(next);
        };
        configWriteQueue = configWriteQueue.then(write, write);
        await configWriteQueue;
        res.json({ ok: true, config: publicConfig });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: alertConfigValidationMessage(error) || 'alert_config_write_failed',
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/incidents/:incidentKey/actions',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const incidentKey = String(req.params.incidentKey ?? '').trim();
      const action = String(req.body?.action ?? '').trim();
      if (!incidentKey) {
        res.status(400).json({ ok: false, error: 'invalid_incident_key' });
        return;
      }
      if (!['acknowledge', 'assign', 'silence', 'reopen'].includes(action)) {
        res.status(400).json({ ok: false, error: 'invalid_incident_action' });
        return;
      }
      try {
        await updateOpsIncident(incidentKey, {
          action: action as 'acknowledge' | 'assign' | 'silence' | 'reopen',
          actor: resolveOpsActor(req),
          assignee: req.body?.assignee,
          minutes: Number(req.body?.minutes),
          reason: req.body?.reason,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'incident_action_failed',
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/test-notification',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const config = await loadAlertConfig();
        const requestedChannel = req.body?.channel;
        if (
          requestedChannel !== undefined &&
          requestedChannel !== 'feishu' &&
          requestedChannel !== 'webhook'
        ) {
          res.status(400).json({ ok: false, error: 'invalid_notification_channel' });
          return;
        }
        const result = await sendAlertTestNotification(config, requestedChannel);
        await recordOpsNotificationTest(result).catch(() => undefined);
        res.status(result.delivered ? 200 : 502).json({ ok: result.delivered, result });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'notification_test_failed',
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/run-checks',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (_req: Request, res: Response) => {
      try {
        await execFileAsync('systemctl', ['start', 'rdstudio-alert-worker.service'], {
          timeout: 15_000,
          maxBuffer: 200_000,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'alert_worker_start_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/remediation',
    requireObservabilityAccess,
    async (_req, res) => {
      try {
        const config = await loadAlertConfig();
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, remediation: await getRemediationOverview(config) });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: sanitizeOpsSummary(error, 240) || 'remediation_overview_failed',
        });
      }
    },
  );

  // Compatibility shim for the retired Moss-era direct execution endpoint.
  //
  // Keep the URL so stale clients receive a deterministic, actionable response,
  // but never accept a playbook id here.  Remediation must go through the
  // evidence-proof -> proposal -> approval -> CAS-claim action API mounted
  // above.  In particular, do not call requestRemediation from this handler:
  // doing so would re-introduce a side-effecting authorization bypass.
  router.post(
    '/api/ops/observability/remediate',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    (_req, res) => {
      res.status(410).json({
        ok: false,
        error: 'action_proposal_required',
        message: '直接自愈入口已关闭；请先通过证据化行动 API 创建并审批动作。',
        actionApi: '/api/ops/observability/actions',
      });
    },
  );

  router.post(
    '/api/ops/observability/run-evolution',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    (_req: Request, res: Response) => {
      // Evolution still creates an independent DSH host.  Keep the legacy URL
      // deterministic, but do not let a dashboard mutation bypass the single
      // production composition root and the evidence/approval action loop.
      res.status(410).json({
        ok: false,
        error: 'action_proposal_required',
        message: '候选进化直达入口已关闭；请先通过证据化行动 API 创建并审批动作。',
        actionApi: '/api/ops/observability/actions',
      });
    },
  );

  return router;
}
