import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { registerDashboardQueryRoutes } from './dashboard-query-routes.js';
import { interpolateDashboardExpression } from './dashboard-query.js';
import { normalizeBoardSpec } from './dashboard-boards-store.js';
import type { MetricRangeQuery } from '../observability/ai-ecosystem-metrics-store.js';

const ADMIN = 'dashboard-query-test-admin';
const headers = { 'x-admin-token': ADMIN, 'x-rdk-ops-action': 'observability', 'content-type': 'application/json' };
const NOW = 1_800_000_000_000;
const promPanel = { title: 'Requests', metric: '', source: 'prometheus', queries: [{ refId: 'A', expr: 'sum(rate(requests_total{service="$service"}[$__rate_interval]))', legendFormat: '{{service}} requests' }] };
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
async function listen(server: Server) { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
async function fixture(run: (value: { request: (body?: unknown, customHeaders?: Record<string, string>) => Promise<Response>; calls: URL[]; metricCalls: MetricRangeQuery[]; mode: (value: string) => void }) => Promise<void>) {
  const keys = ['RDK_CREDITS_ADMIN_TOKEN', 'RDK_CHAT_CREDITS_DB_URL', 'RDK_FLYWHEEL_ADMIN_USER_IDS'] as const;
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.RDK_CREDITS_ADMIN_TOKEN = ADMIN; process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://unused.invalid/db'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'admin-sso';
  configureObservabilityAccess({ getSessionSsoUser: (req) => req.header('x-fixture-sso') ? { id: req.header('x-fixture-sso')! } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const calls: URL[] = []; const metricCalls: MetricRangeQuery[] = []; let mode = 'success';
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); calls.push(url);
    if (mode === 'bad-expression') return json(res, { status: 'error', errorType: 'bad_data', error: 'private upstream detail' }, 400);
    if (mode === 'failed') return json(res, { status: 'error', error: 'private secret' }, 500);
    if (mode === 'malformed') return json(res, { status: 'success', data: { resultType: 'unsupported', result: [] } });
    if (mode === 'empty') return json(res, { status: 'success', data: { resultType: 'matrix', result: [] } });
    if (mode === 'limits') return json(res, { status: 'success', data: { resultType: 'matrix', result: Array.from({ length: 101 }, (_, index) => ({ metric: { service: 'checkout' }, values: index ? [[NOW / 1000, '1']] : [...Array.from({ length: 1001 }, () => [NOW / 1000, '2']), [NOW / 1000, null]] })) } });
    return json(res, { status: 'success', data: { resultType: url.pathname.endsWith('/query') ? 'vector' : 'matrix', result: [{ metric: { service: 'checkout' }, values: [[NOW / 1000 - 60, '4.5'], [NOW / 1000, 'NaN']], value: [NOW / 1000, '7'] }] }, warnings: ['fixture warning'] });
  });
  const upstreamUrl = await listen(upstream);
  const app = express(); app.use(express.json()); const router = express.Router();
  registerDashboardQueryRoutes(router, { prometheusUrl: upstreamUrl + '/prometheus', now: () => NOW, queryMetric: async (input) => {
    metricCalls.push(input);
    return ['checkout', 'payments'].map((service) => ({ seriesId: 1, metric: 'orders.total', labels: { service, environment: 'prod' }, bucketMs: 1, points: [{ ts: NOW, value: 3 }] }));
  } });
  app.use(router); const server = createServer(app); const base = await listen(server);
  try { await run({ calls, metricCalls, mode: (value) => { mode = value; }, request: (body, customHeaders = headers) => fetch(base + '/api/ops/observability/boards/' + (body === undefined ? 'templates' : 'query'), { headers: customHeaders, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }) }); }
  finally { await Promise.all([close(server), close(upstream)]); resetObservabilityAccessAdapter(); for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}

test('real dashboard HTTP adapter keeps expressions, literals, multiple queries and millisecond timestamps', async () => {
  await fixture(async ({ request, calls }) => {
    const response = await request({ panel: { ...promPanel, queries: [...promPanel.queries, { refId: 'B', expr: 'max(queue_depth)', instant: true, legendFormat: 'depth' }] }, windowMinutes: 60, variables: { service: 'check"out' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json() as any; assert.deepEqual(data.series[0].points, [{ ts: NOW - 60000, value: 4.5 }]); assert.equal(data.series[0].name, 'checkout requests'); assert.deepEqual(data.series[1].points, [{ ts: NOW, value: 7 }]);
    assert.equal(calls[0].pathname, '/prometheus/api/v1/query_range'); assert.equal(calls[0].searchParams.get('query'), 'sum(rate(requests_total{service="check\\"out"}[60s]))');
    assert.equal(calls[0].searchParams.get('start'), String(NOW / 1000 - 3600)); assert.equal(calls[0].searchParams.get('step'), '15');
    assert.equal(calls[1].pathname, '/prometheus/api/v1/query'); assert.equal(calls[1].searchParams.get('time'), String(NOW / 1000)); assert.deepEqual(data.warnings, ['fixture warning', 'A: nonfinite_or_invalid_samples_omitted', 'fixture warning']);
  });
});

test('PromQL variable interpolation uses literal regex/string values and rejects missing or unsupported syntax', () => {
  assert.equal(interpolateDashboardExpression('rate(m{service=~"$service",path="${path}"}[$__interval])', { service: 'a.b|c', path: '/"x' }, { __interval: '30s' }), 'rate(m{service=~"a\\\\.b\\\\|c",path="/\\"x"}[30s])');
  for (const expr of ['m{a="$missing"}', 'm{a="${service:regex}"}', 'm[$__unsupported]', 'm[$__interval']) assert.throws(() => interpolateDashboardExpression(expr, {}, {}));
  assert.throws(() => interpolateDashboardExpression('$metric', { metric: 'up or secret' }, {}), /invalid_board_variable_literal/);
});

test('query validation fails closed before any upstream call and OTLP supports controlled label filters', async () => {
  await fixture(async ({ request, calls, metricCalls }) => {
    for (const body of [
      { panel: promPanel, variables: {} },
      { panel: promPanel, variables: { service: 's' }, url: 'http://untrusted.invalid' },
      { panel: promPanel, variables: { service: 's' }, filters: { service: 's' } },
      { panel: promPanel, variables: { service: 's' }, range: { fromMs: NOW, toMs: NOW - 1 } },
      { panel: { ...promPanel, queries: [{ refId: 'A', expr: 'up\0' }] } },
      { panel: { title: 'OTLP', metric: 'orders.total' }, filters: { arbitrary: 'value' } },
    ]) assert.equal((await request(body)).status, 400);
    assert.equal(calls.length, 0); assert.equal(metricCalls.length, 0);
    const response = await request({ panel: { title: 'Legacy', metric: 'orders.total' }, windowMinutes: 240, filters: { service: '$service', environment: 'prod' }, variables: { service: 'checkout' } });
    assert.equal(response.status, 200); const data = await response.json() as any; assert.equal(data.series.length, 1); assert.equal(data.series[0].labels.service, 'checkout'); assert.equal(metricCalls[0].metric, 'orders.total');
  });
});

test('upstream bad PromQL, outage, malformed payload and empty results have distinct truthful responses', async () => {
  await fixture(async ({ request, mode }) => {
    const body = { panel: promPanel, variables: { service: 'checkout' } };
    for (const [state, status, error] of [['bad-expression', 400, 'invalid_promql'], ['failed', 502, 'prometheus_query_failed'], ['malformed', 502, 'prometheus_query_failed']] as const) {
      mode(state); const response = await request(body); assert.equal(response.status, status); const data = await response.json() as any; assert.equal(data.error, error); assert.doesNotMatch(JSON.stringify(data), /private|secret/);
    }
    mode('empty'); const response = await request(body); assert.equal(response.status, 200); assert.deepEqual((await response.json() as any).series, []);
  });
});

test('series and point limits, invalid numeric samples and variable legends are reported without semantic substitution', async () => {
  await fixture(async ({ request, mode }) => {
    mode('limits');
    const response = await request({ panel: { ...promPanel, queries: [{ ...promPanel.queries[0], legendFormat: '$service {{service}}' }] }, variables: { service: 'checkout' } });
    assert.equal(response.status, 200); const data = await response.json() as any;
    assert.equal(data.series.length, 100); assert.equal(data.series[0].points.length, 1000); assert.equal(data.series[0].name, 'checkout checkout');
    assert.deepEqual(data.warnings, ['A: series_limit_100', 'A: nonfinite_or_invalid_samples_omitted', 'A: point_limit_1000']);
  });
});

test('identity and CSRF guards reject query/template access without touching either source', async () => {
  await fixture(async ({ request, calls, metricCalls }) => {
    const body = { panel: promPanel, variables: { service: 'checkout' } };
    const refusedHeaders: Record<string, string>[] = [{}, { ...headers, 'x-admin-token': 'wrong' }, { 'content-type': 'application/json', 'x-fixture-sso': 'member' }, { 'content-type': 'application/json', 'x-tenant-token': 'tenant-only' }];
    for (const bad of refusedHeaders) {
      const response = await request(body, bad); assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await request(undefined, bad)).status, 403);
    }
    assert.equal((await request(body, { 'content-type': 'application/json', 'x-admin-token': ADMIN })).status, 400);
    assert.equal((await request(body, { ...headers, origin: 'https://outside.invalid' })).status, 403);
    assert.equal(calls.length, 0); assert.equal(metricCalls.length, 0);
    const templates = await request(); assert.equal(templates.status, 200); const data = await templates.json() as any; assert.equal(data.templates.length, 3); for (const template of data.templates) assert.deepEqual(normalizeBoardSpec(template.spec), template.spec);
  });
});
