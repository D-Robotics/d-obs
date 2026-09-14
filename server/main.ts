/**
 * d-obs standalone entry.
 *
 * Mounts the full observability workbench without the RDK Studio composition
 * root. Access control keeps the upstream semantics from D-010: admin token
 * via RDK_CREDITS_ADMIN_TOKEN (x-admin-token header, timing-safe, fail-closed)
 * plus an optional SSO admin allowlist in RDK_FLYWHEEL_ADMIN_USER_IDS.
 */
import express from 'express';
import { createOpsObservabilityRouter } from './monitoring/observability-routes.js';
import { SESSION_TRACE_HTML } from './agent-observability/session-trace-page.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.get('/session-trace', (_request, response) => {
  response.type('html').send(SESSION_TRACE_HTML);
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
