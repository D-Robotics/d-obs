import express from 'express';
import { Router } from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerVisionWorkshopRoutes } from '../server/monitoring/vision-workshop-routes.js';
import { VisionWorkshopService } from '../server/monitoring/vision-workshop-service.js';
import { VisionDeviceRegistry } from '../server/monitoring/vision-workshop-device.js';

const token = 'bridge-e2e-token';
process.env.RDK_CREDITS_ADMIN_TOKEN = token;
const service = new VisionWorkshopService({ dataDir: mkdtempSync(join(tmpdir(), 'bridge-e2e-state-')) });
const app = express();
app.use(express.json({ limit: '2mb' }));
const router = Router();
registerVisionWorkshopRoutes(router, { getService: () => service, getDevices: () => new VisionDeviceRegistry([]), modelEnabled: () => false });
app.use('/dobs', router);
const server = app.listen(Number(process.argv[2] || 0), '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
const headers = { 'content-type': 'application/json', 'x-admin-token': token, 'x-rdk-ops-action': 'observability' };
const created = await fetch(`http://127.0.0.1:${port}/dobs/api/ops/observability/vision-workshop/experiments`, {
  method: 'POST', headers, body: JSON.stringify({ title: '连接器黑盒端到端', goal: 'doctor 与工具往返验证' }),
});
const experiment = created.status === 201 ? (await created.json()).experiment : null;
process.stdout.write(JSON.stringify({ ready: true, port, seeded: Boolean(experiment) }) + '\n');
