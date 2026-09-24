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
  getLatestOpsConfigurationAuditDetails,
  getOpsEventDetail,
  getOpsIncidentSummary,
  getOpsObservabilityOverview,
  getOpsObservabilityPool,
  isOpsObservabilityConfigured,
  listOpsIncidents,
  recordOpsConfigurationAudit,
  recordOpsNotificationTest,
  updateOpsIncident,
} from './observability-store.js';
import {
  deleteManualObject,
  listAlertRuleObjectBindings,
  listRegisteredObjects,
  registerManualObject,
  setAlertRuleObjectBinding,
  updateRegisteredObjectIdentity,
} from './observability-object-registry.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { renderStatusPage } from './ops-status-page.js';
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  listMaintenanceWindows,
} from './alert-maintenance-windows.js';
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
import { queryLogs } from '../observability/ai-ecosystem-logs-store.js';
import { queryMetricRanges, queryMetricSeries } from '../observability/ai-ecosystem-metrics-store.js';
import {
  invalidateDeviceTokenCache,
  listDevices,
  queryDeviceSamples,
  registerDevice,
  rotateDeviceToken,
  setDeviceStatus,
  DEVICE_ID_PATTERN,
} from './device-registry.js';
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
  alertConfigFileState,
  alertConfigFromFileState,
  alertConfigValidationMessage,
  applyPanelAlertConfigPatch,
  loadAlertConfig,
  toPublicAlertConfig,
  type AlertConfigPatch,
} from './alert-config.js';
import { getRemediationOverview } from './alert-remediation.js';
import { isAlertDeliveryChannel } from './alert-notification-channels.js';
import { sendAlertTestNotification } from './studio-alert-worker.js';
import { getConfiguredServiceLevelOverview } from './service-level-objectives.js';
import {
  getGatewayConfigSummary,
  getGatewayProviderHealth,
  preflightGatewayTarget,
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
  hasInvalidTenantToken,
  isOpsAdminRequest,
  resolveOpsActorId,
  resolveTenantMemberAccess,
  resolveTenantTokenAccess,
  type ResolvedTenantAccess,
} from './observability-access.js';
import {
  SSO_RELAY_TENANT_HEADER,
  SsoRelayError,
  configureSsoRelayObservabilityAccess,
  forgetSsoRelaySession,
  hydrateSsoRelaySession,
  loginViaSsoRelay,
  logoutViaSsoRelay,
  ssoRelayConfigured,
  ssoRelayLoginRateAllow,
  ssoRelayRequestSessionId,
  ssoRelaySessionCandidates,
  ssoRelayUpstreamCookieHeader,
} from './sso-relay.js';
import { clientAddress } from '../trusted-proxy.js';

const execFileAsync = promisify(execFile);
// 共享横切件与域路由（2026-09 拆分：observability-routes.ts 保留核心编排，
// 观测信号/数据库资产/洞察聚合/链路证据/租户/模型池 各域见同名路由文件）。
import {
  clientErrorCode,
  queryInteger,
  queryText,
  requireObservabilityAccess,
  requireObservabilityAccessTenantAware,
  requireOpsMutationGuard,
  resolveObservabilityAccess,
  resolveAdminTenantScope,
  resolveOpsActor,
  tenantScopeGate,
} from './observability-route-kit.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { registerDatabaseRoutes } from './observability-database-routes.js';
import { registerInsightRoutes } from './observability-insight-routes.js';
import { registerTraceRoutes } from './observability-trace-routes.js';
import { registerTenantRoutes } from './observability-tenant-routes.js';
import { registerModelPoolRoutes } from './observability-model-pool-routes.js';
export { isOpsAdminRequest } from './observability-access.js';
export { isProtectedAgentFrontendModel } from './observability-route-kit.js';
let configWriteQueue: Promise<void> = Promise.resolve();

export function createOpsObservabilityRouter(): Router {
  const router = Router();

  // 装配期（组合根职责）：把主站 SSO 中继的会话解析注入 D-010 访问端口。
  // standalone 部署此前从不装配（fail-closed），这里补上后：
  // RDK_FLYWHEEL_ADMIN_USER_IDS 白名单、审计署名、SSO 组员作用域全部点亮；
  // 未配置中继时中继自身 fail-closed，行为与装配前一致。
  configureSsoRelayObservabilityAccess();

  // SSO 会话水合：请求带 x-rdk-sso-session 时先远程验证并写入同步缓存，
  // 后续所有守卫/适配器同步读取。验证失败/网络错误都不阻断请求（按未登录
  // 处理，fail-closed 由各守卫完成）。
  router.use(async (_req, _res, next) => {
    try {
      await hydrateSsoRelaySession(_req);
    } catch {
      /* 水合失败按未登录处理 */
    }
    next();
  });

  // ---- 公开状态页（只读、无身份信息；数据库不可用时降级为「暂不可用」页） ----

  router.get('/status', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const html = await renderStatusPage();
      res.type('html').send(html);
    } catch (error) {
      console.warn(
        '[status-page] render failed:',
        sanitizeOpsSummary(error, 180) || 'unknown_error',
      );
      res
        .type('html')
        .status(503)
        .send(
          `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>服务状态 · d-obs</title></head><body style="font:14px/1.6 -apple-system,sans-serif;color:#1a1d1f;background:#f6f7f8;margin:0;display:grid;place-items:center;min-height:100vh"><div style="text-align:center"><h1 style="font-size:18px">状态页暂时不可用</h1><p style="color:#6f7478;font-size:12px">中心数据库未配置或不可达；请稍后重试。告警通知不受影响。</p></div></body></html>`,
        );
    }
  });

  // ---- 主站 SSO 登录中继（组员/管理员账号密码登录） ----

  router.post('/api/ops/auth/login', async (req: Request, res: Response) => {
    const userName = String(req.body?.userName ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!userName || !password) {
      res.status(400).json({ ok: false, error: 'missing_user_name_or_password' });
      return;
    }
    // 与凭据端点同源的 CSRF 守卫（浏览器表单 fetch 同源，Origin 必须匹配 host）。
    const origin = String(req.headers.origin ?? '').trim();
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          res.status(403).json({ ok: false, error: 'cross_origin_login_denied' });
          return;
        }
      } catch {
        res.status(403).json({ ok: false, error: 'invalid_origin' });
        return;
      }
    }
    // 客户端地址优先取 trust proxy 解析出的真实 IP（配了反代才拿得到），
    // 否则反代下所有请求共用回环地址、额度退化成全平台共享。账号维度独立限流，
    // 使攻击者换 IP 也无法持续爆破同一个账号。
    const ip = clientAddress(req);
    if (!ssoRelayLoginRateAllow(ip, { userName })) {
      res.status(429).json({ ok: false, error: 'login_rate_limited' });
      return;
    }
    try {
      const { user, sessionId, setCookies } = await loginViaSsoRelay(
        { userName, password },
        // 把真实客户端地址一并转发给主站：主站按 req.ip 限流，否则它的额度会被
        // 全部来自回环地址的 d-obs 登录退化成全平台共享桶。
        { clientIp: ip },
      );
      await recordOpsConfigurationAudit({
        actor: user.email || user.name || user.id,
        action: 'sso_login',
        summary: `账号 ${userName} 登录可观测工作台`,
      }).catch(() => undefined);
      // 主站登录成功时会下发 `rdk_sso_session` Cookie；d-obs 与主站同源，原样
      // 透传给浏览器，使这次登录同时成为主站登录态（免登闭环），也让 iframe /
      // 整表导出这类没有自定义头的请求重新带上凭证。
      for (const cookie of setCookies) res.append('Set-Cookie', cookie);
      res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email }, sessionId });
    } catch (error) {
      if (error instanceof SsoRelayError) {
        res.status(error.status).json({ ok: false, error: error.code });
        return;
      }
      res.status(503).json({ ok: false, error: 'sso_login_failed' });
    }
  });

  router.post('/api/ops/auth/logout', async (req: Request, res: Response) => {
    // 候选链（头 → Cookie）逐个失效：浏览器可能只有 Cookie（免登路径），也可能
    // 两份镜像同时存在，只清头会留下另一份在 60s 缓存后复活。
    const candidates = ssoRelaySessionCandidates(req);
    const sid = ssoRelayRequestSessionId(req) || candidates[0] || '';
    for (const candidate of candidates) forgetSsoRelaySession(candidate);
    await logoutViaSsoRelay(sid, { cookieHeader: ssoRelayUpstreamCookieHeader(req) }).catch(
      () => undefined,
    );
    if (sid) {
      await recordOpsConfigurationAudit({
        actor: resolveOpsActor(req),
        action: 'sso_logout',
        summary: '账号退出可观测工作台',
      }).catch(() => undefined);
    }
    res.json({ ok: true });
  });

  router.get('/api/ops/auth/me', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    // 会话可能来自请求头（登录后前端写入）或同源 HttpOnly Cookie（主站免登）。
    const sid = ssoRelayRequestSessionId(req);
    const user = sid ? (getSessionSsoUser(req) ?? null) : null;
    if (!user) {
      res.json({ ok: true, user: null, admin: false, relayConfigured: ssoRelayConfigured() });
      return;
    }
    let tenants: Array<{ tenantId: string; displayName: string; role: 'owner' | 'member' }> = [];
    try {
      const { listMembershipsForUser } = await import('./tenant-members-store.js');
      const memberships = await listMembershipsForUser(user.id);
      tenants = memberships.map((m) => ({
        tenantId: m.tenantId,
        displayName: m.tenantDisplayName,
        role: m.role,
      }));
    } catch {
      // 数据库不可用时组员列表为空（fail-closed，不 500：登录态本身有效）。
    }
    res.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email },
      tenants,
      admin: isOpsAdminRequest(req),
      relayConfigured: true,
    });
  });

  // Nginx uses this read-only gate for the Prometheus UI mounted under the
  // same RDK Studio origin.  Keep the browser-facing Prometheus endpoint out
  // of the d-obs app process while reusing the exact SSO/admin decision used
  // by the operations workbench.  `auth_request` only needs the status code;
  // never return user/session data from this subrequest.
  router.get('/api/ops/prometheus/auth', requireObservabilityAccess, (_req, res) => {
    res.status(204).end();
  });

  // Same gate for the Grafana UI: the container runs as an anonymous Viewer
  // for usability, so this subrequest is the only access boundary.
  router.get('/api/ops/grafana/auth', requireObservabilityAccess, (_req, res) => {
    res.status(204).end();
  });

  // Browser handoff for the Grafana gate. The workbench authenticates API
  // calls with headers (localStorage token / SSO), but a top-level navigation
  // to /dobs/grafana/ cannot carry headers. An authenticated operator may
  // exchange a session for a short-lived HttpOnly gate cookie, which nginx
  // maps back to the admin-token header inside the auth subrequest. The
  // cookie only unlocks the Grafana surface (Path=/dobs, SameSite=Lax).
  router.get('/api/ops/grafana/session', requireObservabilityAccessTenantAware, (req, res) => {
    const token = String(process.env.RDK_CREDITS_ADMIN_TOKEN ?? '').trim();
    if (!token) {
      res.status(503).json({ ok: false, error: 'central_store_disabled' });
      return;
    }
    res.setHeader(
      'set-cookie',
      `dobs_grafana_gate=${encodeURIComponent(token)}; Path=/dobs; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
    );
    res.status(204).end();
    void req;
  });

  registerSignalsRoutes(router);


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
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        const tenantAccess = req.opsTenantAccess ?? null;
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
        // 租户身份：SLO / trace 面板属于平台业务数据，不进入租户视图。
        // 管理员可用 ?tenant= 切换到某租户视角（复用同一过滤链路）。
        let tenantScope = tenantAccess ? tenantAccess.tenantId : null;
        if (!tenantScope) {
          tenantScope = await resolveAdminTenantScope(req);
        }
        const [overview, serviceLevels] = await Promise.all([
          getOpsObservabilityOverview(hours, tenantScope),
          tenantScope
            ? Promise.resolve(null)
            : getConfiguredServiceLevelOverview().catch(() => null),
        ]);
        let tracePage = emptyRunTraceListPage(hours, traceEnvironment);
        if (!tenantScope && telemetryGovernanceProtectedReadsReady()) {
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
          error: clientErrorCode(error, 'observability_query_failed'),
        });
      }
    },
  );

  registerDatabaseRoutes(router);
  registerInsightRoutes(router);
  registerTraceRoutes(router);


  router.get(
    '/api/ops/observability/config',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        // 租户视图不返回平台告警配置（通道/阈值属于平台运营数据）。
        if (req.opsTenantAccess) {
          res.json({ ok: true, config: { tenantReadOnly: true } });
          return;
        }
        const file = await alertConfigFileState();
        res.json({
          ok: true,
          config: toPublicAlertConfig(alertConfigFromFileState(file), {
            fileRuleKeys: file.parseable ? file.presentRuleKeys : null,
          }),
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'alert_config_read_failed'),
        });
      }
    },
  );

  // ---- 维护窗口（计划内静默；平台运营操作，租户 token 只读也不可写） ----

  router.get(
    '/api/ops/observability/maintenance-windows',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const windows = await listMaintenanceWindows(await getOpsObservabilityPool());
        res.json({ ok: true, windows });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'maintenance_windows_unavailable'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/maintenance-windows',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      // 租户探针/组员视图不允许变更平台维护窗口。
      if (req.opsTenantAccess) {
        res.status(403).json({ ok: false, error: 'tenant_read_only' });
        return;
      }
      const alertKey = String(req.body?.alertKey ?? '').trim();
      const minutes = Number(req.body?.minutes);
      const reason = String(req.body?.reason ?? '').trim();
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 7 * 24 * 60) {
        res.status(400).json({ ok: false, error: 'invalid_maintenance_minutes' });
        return;
      }
      if (alertKey && !/^[a-z0-9][a-z0-9.-]{0,159}$/.test(alertKey)) {
        res.status(400).json({ ok: false, error: 'invalid_maintenance_alert_key' });
        return;
      }
      try {
        const window = await createMaintenanceWindow(await getOpsObservabilityPool(), {
          alertKey,
          minutes: Math.floor(minutes),
          reason,
          createdBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'create_maintenance_window',
          summary: `创建维护窗口（${window.endsAt}，${Math.floor(minutes)} 分钟）：${
            alertKey || '全部规则'
          }，原因：${reason.slice(0, 200)}`,
        }).catch(() => undefined);
        res.status(201).json({ ok: true, window });
      } catch (error) {
        const message = clientErrorCode(error, 'maintenance_window_create_failed');
        res.status(message === 'maintenance_reason_required' ? 400 : 500).json({
          ok: false,
          error: message,
        });
      }
    },
  );

  router.delete(
    '/api/ops/observability/maintenance-windows/:windowId',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      if (req.opsTenantAccess) {
        res.status(403).json({ ok: false, error: 'tenant_read_only' });
        return;
      }
      const windowId = Number(req.params.windowId);
      if (!Number.isInteger(windowId) || windowId <= 0) {
        res.status(400).json({ ok: false, error: 'invalid_maintenance_window_id' });
        return;
      }
      try {
        const removed = await deleteMaintenanceWindow(await getOpsObservabilityPool(), windowId);
        if (!removed) {
          res.status(404).json({ ok: false, error: 'maintenance_window_not_found' });
          return;
        }
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'delete_maintenance_window',
          summary: `删除维护窗口 #${windowId}`,
        }).catch(() => undefined);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'maintenance_window_delete_failed'),
        });
      }
    },
  );

  registerTenantRoutes(router);
  registerModelPoolRoutes(router);

  router.put(
    '/api/ops/observability/config',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        let publicConfig: ReturnType<typeof toPublicAlertConfig> | null = null;
        let unchanged = false;
        const auditParts = Object.keys((req.body ?? {}) as Record<string, unknown>);
        const write = async () => {
          // 面板保存走 applyPanelAlertConfigPatch：以磁盘原文为基准做最小改动，
          // 不把面板展示的默认规则物化进共用文件（见 planAlertConfigWrite）。
          // pinRuleKeys 是唯一的例外：运维显式要求把「只在默认值里」的规则固定进文件。
          const body = (req.body ?? {}) as AlertConfigPatch & { pinRuleKeys?: unknown };
          const pinRuleKeys = Array.isArray(body.pinRuleKeys)
            ? body.pinRuleKeys.filter((key): key is string => typeof key === 'string')
            : [];
          const result = await applyPanelAlertConfigPatch(body, {
            pinRuleKeys,
            actor: resolveOpsActor(req),
          });
          unchanged = !result.changed;
          if (result.changed) {
            const changed = [...result.plan.changedFields, ...result.plan.changedRuleKeys];
            await recordOpsConfigurationAudit({
              actor: resolveOpsActor(req),
              action: 'update_config',
              summary: `更新告警配置：${changed.length ? changed.join('、') : auditParts.join('、')}`,
            }).catch(() => undefined);
          }
          publicConfig = toPublicAlertConfig(result.config, { fileRuleKeys: result.fileRuleKeys });
        };
        configWriteQueue = configWriteQueue.then(write, write);
        await configWriteQueue;
        res.json({ ok: true, unchanged, config: publicConfig });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: alertConfigValidationMessage(error) || 'alert_config_write_failed',
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/incidents/summary',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        const days = queryInteger(req.query as Record<string, unknown>, 'days', 7, 1, 90);
        // 租户身份（组员头/租户 token）自动限定本租户；管理员可用 ?tenant= 切视角。
        const tenantScope = req.opsTenantAccess
          ? req.opsTenantAccess.tenantId
          : await resolveAdminTenantScope(req);
        res.json({ ok: true, summary: await getOpsIncidentSummary(days, tenantScope) });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'incident_summary_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/incidents',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const scope = query.scope === 'mine' ? 'mine' : 'all';
        const state = ['active', 'closed', 'all'].includes(String(query.state))
          ? (String(query.state) as 'active' | 'closed' | 'all')
          : 'all';
        const severity = query.severity === 'critical' || query.severity === 'warning'
          ? (query.severity as 'critical' | 'warning')
          : undefined;
        const target = queryText(query, 'target', 200) || undefined;
        const tenantScope = req.opsTenantAccess
          ? req.opsTenantAccess.tenantId
          : await resolveAdminTenantScope(req);
        const result = await listOpsIncidents({
          scope,
          actor: scope === 'mine' ? resolveOpsActor(req) : undefined,
          state,
          severity,
          target,
          tenantScope,
          days: queryInteger(query, 'days', 30, 1, 90),
          limit: queryInteger(query, 'limit', 50, 1, 200),
          offset: queryInteger(query, 'offset', 0, 0, 100000),
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'incident_list_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/object-registry',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        const objects = await listRegisteredObjects();
        res.json({ ok: true, objects });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'object_registry_unavailable') });
      }
    },
  );

  // —— 规则↔对象绑定：代码映射是默认兜底，自定义绑定存 studio_obs_object_bindings ——
  router.get(
    '/api/ops/observability/object-bindings',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        const data = await listAlertRuleObjectBindings();
        res.json({ ok: true, ...data });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'object_bindings_unavailable') });
      }
    },
  );

  router.put(
    '/api/ops/observability/object-bindings',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const bindings = req.body?.bindings;
      if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
        res.status(400).json({ ok: false, error: 'invalid_bindings' });
        return;
      }
      const entries = Object.entries(bindings as Record<string, unknown>);
      if (entries.length > 200) {
        res.status(400).json({ ok: false, error: 'invalid_bindings' });
        return;
      }
      try {
        for (const [ruleKey, value] of entries) {
          await setAlertRuleObjectBinding(
            ruleKey,
            value == null || String(value).trim() === '' ? null : String(value),
            resolveOpsActor(req),
          );
        }
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'object_bindings_update',
          summary: `更新 ${entries.length} 条规则↔对象绑定`,
          details: bindings,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'binding_update_failed') });
      }
    },
  );

  router.post(
    '/api/ops/observability/object-registry',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const created = await registerManualObject({
          objectType: String(req.body?.objectType ?? ''),
          objectId: String(req.body?.objectId ?? ''),
          displayName: req.body?.displayName == null ? undefined : String(req.body.displayName),
          labels: req.body?.labels,
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'object_registry_manual_register',
          summary: `手动登记对象 ${created.objectId}`,
          details: created,
        });
        res.status(201).json({ ok: true, ...created });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'object_register_failed') });
      }
    },
  );

  router.patch(
    '/api/ops/observability/object-registry',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const updated = await updateRegisteredObjectIdentity(
          String(req.body?.owner ?? ''),
          String(req.body?.objectId ?? ''),
          { displayName: req.body?.displayName, labels: req.body?.labels },
        );
        if (!updated) {
          res.status(404).json({ ok: false, error: 'object_not_found' });
          return;
        }
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'object_registry_update',
          summary: `编辑对象 ${String(req.body?.objectId ?? '')} 元数据`,
          details: { owner: req.body?.owner, displayName: req.body?.displayName, labels: req.body?.labels },
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'object_update_failed') });
      }
    },
  );

  router.delete(
    '/api/ops/observability/object-registry',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const removed = await deleteManualObject(
          String(req.query.owner ?? ''),
          String(req.query.objectId ?? ''),
        );
        if (!removed) {
          res.status(404).json({ ok: false, error: 'object_not_found' });
          return;
        }
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'object_registry_manual_delete',
          summary: `删除手动登记对象 ${String(req.query.objectId ?? '')}`,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ ok: false, error: clientErrorCode(error, 'object_delete_failed') });
      }
    },
  );

  router.post(
    '/api/ops/observability/incidents/:incidentKey/actions',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const incidentKey = String(req.params.incidentKey ?? '').trim();
      const action = String(req.body?.action ?? '').trim();
      if (!incidentKey) {
        res.status(400).json({ ok: false, error: 'invalid_incident_key' });
        return;
      }
      if (!['acknowledge', 'assign', 'silence', 'reopen', 'close'].includes(action)) {
        res.status(400).json({ ok: false, error: 'invalid_incident_action' });
        return;
      }
      // 租户处置边界：SSO 组员可处置本租户事故（归属由 updateOpsIncident 的
      // 租户 WHERE 约束兜底，跨租户键按 incident_not_found 拒绝，不泄露存在性）；
      // 租户探针 token 是机器凭证，保持只读。
      let tenantScope: string | null = null;
      if (req.opsTenantAccess) {
        if (req.opsTenantAccess.source !== 'member') {
          res.status(403).json({ ok: false, error: 'tenant_read_only' });
          return;
        }
        tenantScope = req.opsTenantAccess.tenantId;
      }
      try {
        await updateOpsIncident(
          incidentKey,
          {
            action: action as 'acknowledge' | 'assign' | 'silence' | 'reopen' | 'close',
            actor: resolveOpsActor(req),
            assignee: req.body?.assignee,
            minutes: Number(req.body?.minutes),
            reason: req.body?.reason,
          },
          tenantScope,
        );
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'incident_action_failed'),
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
          !isAlertDeliveryChannel(requestedChannel)
        ) {
          res.status(400).json({ ok: false, error: 'invalid_notification_channel' });
          return;
        }
        const result = await sendAlertTestNotification(
          config,
          requestedChannel ?? config.notification.channel,
        );
        await recordOpsNotificationTest(result).catch(() => undefined);
        res.status(result.delivered ? 200 : 502).json({ ok: result.delivered, result });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'notification_test_failed'),
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
          error: clientErrorCode(error, 'alert_worker_start_failed'),
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
          error: clientErrorCode(error, 'remediation_overview_failed'),
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
