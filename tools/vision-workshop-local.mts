/** Local operator workbench. Private config and state stay outside the checkout. */
import { visionWorkshopJsonIngress } from '../server/monitoring/vision-workshop-json-ingress.js';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { configureObservabilityAccess } from '../server/monitoring/observability-access-adapter.js';
import { registerVisionWorkshopRoutes } from '../server/monitoring/vision-workshop-routes.js';

const configFile = process.argv[2];
if (!configFile) throw new Error('Usage: node --import tsx tools/vision-workshop-local.mts /private/workbench.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535 || !path.isAbsolute(config.stateDir)) throw new Error('Invalid local workbench configuration');
process.env.RDK_VISION_DEVICE_ADAPTERS = JSON.stringify(config.adapters);
process.env.RDK_VISION_STATE_DIR = config.stateDir;
if (config.model) {
  process.env.RDK_VISION_AI_ENABLED = '1';
  process.env.RDK_VISION_AI_URL = config.model.baseUrl;
  process.env.RDK_VISION_AI_KEY = config.model.apiKey;
  process.env.RDK_VISION_AI_MODEL = config.model.model;
}
// This listener is deliberately loopback-only: its administrator is the local
// operator. Production deployment continues to use the existing SSO/admin gate.
configureObservabilityAccess({ getSessionSsoUser: () => null, isMultiUserWebDeployment: () => false,
  allowsAnonymousLocalOperator: () => true, resolveChatPrincipalAccountId: () => '' });
const app = express();
app.use(visionWorkshopJsonIngress());
app.use(express.json({ limit: '2mb' }));
const router = express.Router();
registerVisionWorkshopRoutes(router);
app.use(router);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Camera workbench: http://127.0.0.1:${config.port}/ops-observability/vision-workshop`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
