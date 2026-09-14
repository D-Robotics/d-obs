/**
 * d-obs standalone entry.
 *
 * Mounts the full observability workbench without the RDK Studio composition
 * root. Access control keeps the upstream semantics from D-010: admin token
 * via RDK_CREDITS_ADMIN_TOKEN (x-admin-token header, timing-safe, fail-closed)
 * plus an optional SSO admin allowlist in RDK_FLYWHEEL_ADMIN_USER_IDS.
 *
 * External probe ingest is mounted at the upstream-compatible path
 * /api/health/external-probe-report and authenticated by the standalone
 * 256-bit token file (RDK_EXTERNAL_PROBE_TOKEN_PATH).
 */
import express from 'express';
import { createOpsObservabilityRouter } from './monitoring/observability-routes.js';
import { SESSION_TRACE_HTML } from './agent-observability/session-trace-page.js';
import {
  externalProbeTokenMatches,
  parseExternalProbeReport,
  recordExternalProbeReport,
} from './monitoring/external-probe-ingest.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/session-trace', (_request, response) => {
  response.type('html').send(SESSION_TRACE_HTML);
});
app.post('/api/health/external-probe-report', async (req, res) => {
  if (!(await externalProbeTokenMatches(req.header('x-rdk-external-probe-token')))) {
    res.status(401).json({ ok: false, error: 'invalid_probe_token' });
    return;
  }
  const report = parseExternalProbeReport(req.body);
  if (!report) {
    res.status(400).json({ ok: false, error: 'invalid_probe_report' });
    return;
  }
  try {
    await recordExternalProbeReport(report);
    res.status(202).json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: 'probe_store_unavailable' });
  }
});
app.use(createOpsObservabilityRouter());

const port = Number(process.env.PORT ?? 47110);
const server = app.listen(port, () => {
  console.log(`[d-obs] observability workbench listening on http://127.0.0.1:${port}/ops-observability`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
