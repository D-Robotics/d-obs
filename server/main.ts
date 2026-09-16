/**
 * d-obs standalone entry.
 *
 * Mounts the full d-obs observability workbench standalone
 * root. Access control keeps the upstream semantics from D-010: admin token
 * via RDK_CREDITS_ADMIN_TOKEN (x-admin-token header, timing-safe, fail-closed)
 * plus an optional SSO admin allowlist in RDK_FLYWHEEL_ADMIN_USER_IDS.
 *
 * Multi-team tenancy:
 *  - External probe ingest is mounted at the upstream-compatible path
 *    /api/health/external-probe-report. It accepts either the platform token
 *    file (x-rdk-external-probe-token) or a tenant token
 *    (x-rdk-tenant-probe-token, sha256-hashed in studio_obs_tenants).
 *  - Teams self-register tenants at POST /api/ops/tenants/register, gated by
 *    RDK_TENANT_REGISTRATION_TOKEN (x-registration-token, timing-safe,
 *    fail-closed: unset means the endpoint is disabled).
 */
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createOpsObservabilityRouter } from './monitoring/observability-routes.js';
import { SESSION_TRACE_HTML } from './agent-observability/session-trace-page.js';
import {
  parseExternalProbeReport,
  recordExternalProbeReport,
  resolveProbeReportIdentity,
} from './monitoring/external-probe-ingest.js';
import { createTenant } from './monitoring/tenant-store.js';
import { createOpsEventIngestRouter } from './monitoring/ops-event-ingest.js';
import { startTelemetryGovernanceRuntime } from './observability/governance-runtime-service.js';
import { resolveTrustProxySetting } from './trusted-proxy.js';

const app = express();
app.disable('x-powered-by');
// 反代信任：默认只在直连对端是回环时采信 X-Forwarded-For，让登录限流之类按
// 真实客户端地址计数（生产是 nginx 反代到 127.0.0.1:18093）。取值说明见
// server/trusted-proxy.ts。
app.set('trust proxy', resolveTrustProxySetting());
app.use(express.json({ limit: '2mb' }));
app.get('/session-trace', (_request, response) => {
  response.type('html').send(SESSION_TRACE_HTML);
});

function registrationTokenMatches(provided: unknown): boolean {
  const expected = String(process.env.RDK_TENANT_REGISTRATION_TOKEN ?? '').trim();
  if (!expected) return false;
  const actual = String(provided ?? '').trim();
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** 团队自助注册：凭注册 token 建租户，返回一次性明文探针 token。 */
app.post('/api/ops/tenants/register', async (req, res) => {
  if (!String(process.env.RDK_TENANT_REGISTRATION_TOKEN ?? '').trim()) {
    // fail-closed：没配注册 token 就等于关闭自助注册。
    res.status(503).json({ ok: false, error: 'tenant_registration_disabled' });
    return;
  }
  if (!registrationTokenMatches(req.header('x-registration-token'))) {
    res.status(401).json({ ok: false, error: 'invalid_registration_token' });
    return;
  }
  try {
    const { tenant, token } = await createTenant({
      tenantId: req.body?.tenantId,
      displayName: req.body?.displayName,
      createdBy: 'self-registration',
    });
    res.status(201).json({
      ok: true,
      tenant,
      // 明文 token 只在创建响应里出现一次；库里只有 sha256 哈希。
      probeToken: token,
      probe: {
        reportUrl: '/api/health/external-probe-report',
        tokenHeader: 'x-rdk-tenant-probe-token',
      },
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? '');
    if (message.includes('already_exists')) {
      res.status(409).json({ ok: false, error: 'tenant_already_exists' });
      return;
    }
    res.status(400).json({ ok: false, error: message || 'tenant_registration_failed' });
  }
});

app.post('/api/health/external-probe-report', async (req, res) => {
  const identity = await resolveProbeReportIdentity(
    req.header('x-rdk-external-probe-token'),
    req.header('x-rdk-tenant-probe-token'),
  );
  if (!identity) {
    res.status(401).json({ ok: false, error: 'invalid_probe_token' });
    return;
  }
  const report = parseExternalProbeReport(req.body);
  if (!report) {
    res.status(400).json({ ok: false, error: 'invalid_probe_report' });
    return;
  }
  try {
    await recordExternalProbeReport(report, identity);
    res.status(202).json({ ok: true, tenant: identity.scopeId });
  } catch {
    res.status(503).json({ ok: false, error: 'probe_store_unavailable' });
  }
});
// 事件级埋点摄取：租户/平台 token 鉴权，逐条消毒去重后写 studio_ops_events。
app.use(createOpsEventIngestRouter());
app.use(createOpsObservabilityRouter());

const port = Number(process.env.PORT ?? 47110);

// Trace / Run 受保护读取要等治理运行时把保留策略与 tombstone 重放完
// （readiness 'ready'）才放开。standalone 入口此前从不启动它，导致链路追踪
// 视图永远返回空页。fail-open：启动失败只保持 trace 域关闭，不阻断工作台。
void startTelemetryGovernanceRuntime().catch((error) => {
  console.warn('[d-obs] telemetry governance runtime failed to start:', String(error));
});
const server = app.listen(port, () => {
  console.log(`[d-obs] observability workbench listening on http://127.0.0.1:${port}/ops-observability`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
