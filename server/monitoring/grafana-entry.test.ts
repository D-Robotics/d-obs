import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import { createOpsObservabilityRouter } from './observability-routes.js';

let server: Server;
let origin: string;

before(async () => {
  const app = express();
  // Model the production prefix being stripped by nginx, plus the direct
  // standalone entry used by local previews.
  app.use('/prefixed', createOpsObservabilityRouter());
  app.use(createOpsObservabilityRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('missing external integration reports 503 and offers a valid workbench link', async () => {
  for (const [path, workbench] of [
    ['/grafana/', '/ops-observability#signals/panels'],
    ['/dobs/grafana/', '/ops-observability#signals/panels'],
    ['/prefixed/grafana/', '/prefixed/ops-observability#signals/panels'],
    ['/grafana/d/service?orgId=1', '/ops-observability#signals/panels'],
    ['/dobs/grafana/d/service/', '/ops-observability#signals/panels'],
    ['/prefixed/grafana/d/service?orgId=1', '/prefixed/ops-observability#signals/panels'],
    ['/grafana/d/prometheus', '/ops-observability#signals/panels'],
    ['/grafana/d/prometheus/chart', '/ops-observability#signals/panels'],
    ['/prometheus/graph', '/ops-observability#signals/promql'],
    ['/dobs/prometheus/graph', '/ops-observability#signals/promql'],
    ['/prefixed/prometheus/graph', '/prefixed/ops-observability#signals/promql'],
  ]) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.ok(html.includes((workbench.endsWith('signals/promql') ? 'Prometheus' : 'Grafana') + ' 尚未接入当前环境'));
    assert.ok(!html.includes('Cannot GET'));
    assert.equal(response.headers.get('location'), null, 'must not hide failure with a redirect');
    const href = html.match(/<a href="([^"]+)"/)?.[1];
    assert.ok(href);
    const target = new URL(href, origin + path);
    assert.equal(target.pathname + target.hash, workbench);
    assert.equal((await fetch(target)).status, 200, 'recovery link must reach the workbench');
  }
});

test('slash normalization preserves a deployment prefix', async () => {
  for (const path of ['/grafana', '/dobs/grafana', '/prefixed/grafana', '/prometheus', '/dobs/prometheus', '/prefixed/prometheus']) {
    const response = await fetch(origin + path, { redirect: 'manual' });
    assert.equal(response.status, 307);
    const location = response.headers.get('location');
    assert.ok(location);
    const normalized = new URL(location, origin + path);
    assert.equal(normalized.pathname, path + '/');
    assert.equal((await fetch(normalized)).status, 503);
  }
});
