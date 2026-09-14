/**
 * d-obs standalone entry.
 *
 * Mounts the full observability workbench without the RDK Studio composition
 * root. Access control keeps the Studio semantics from D-010: admin token via
 * RDK_CREDITS_ADMIN_TOKEN, and (when shared with Studio) SSO session headers.
 */
import express from 'express';
import { createOpsObservabilityRouter } from './monitoring/observability-routes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
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
