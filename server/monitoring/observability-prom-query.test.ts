import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import {
  configureObservabilityAccess,
  resetObservabilityAccessAdapter,
} from './observability-access-adapter.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';

const ADMIN_TOKEN = 'prom-query-test-admin';
const PRIVATE_UPSTREAM_ERROR = 'private upstream parser or storage detail';
type UpstreamMode =
  | 'success'
  | 'http400'
  | 'bad-data-payload'
  | 'execution-error-payload'
  | 'http503'
  | 'invalid-json'
  | 'invalid-payload'
  | 'disconnect';

let appServer: Server;
let upstreamServer: Server;
let origin: string;
let upstreamOrigin: string;
let upstreamMode: UpstreamMode = 'success';
const receivedQueries: URL[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

before(async () => {
  // This test process supplies fake credentials and never connects to a DB.
  process.env.RDK_CREDITS_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgresql://prom-query-test.invalid/test';
  configureObservabilityAccess({
    getSessionSsoUser: () => null,
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
  });

  upstreamServer = createServer((req, res) => {
    receivedQueries.push(new URL(req.url ?? '/', 'http://mock-prometheus.invalid'));
    if (upstreamMode === 'disconnect') {
      req.socket.destroy();
      return;
    }
    if (upstreamMode === 'invalid-json') {
      res.end('not a JSON response');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (upstreamMode === 'http400' || upstreamMode === 'bad-data-payload') {
      res.statusCode = upstreamMode === 'http400' ? 400 : 200;
      res.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: PRIVATE_UPSTREAM_ERROR }));
      return;
    }
    if (upstreamMode === 'execution-error-payload' || upstreamMode === 'http503') {
      res.statusCode = upstreamMode === 'http503' ? 503 : 200;
      res.end(JSON.stringify({ status: 'error', errorType: 'execution', error: PRIVATE_UPSTREAM_ERROR }));
      return;
    }
    if (upstreamMode === 'invalid-payload') {
      res.end(JSON.stringify({ data: { result: [] }, error: PRIVATE_UPSTREAM_ERROR }));
      return;
    }
    res.end(JSON.stringify({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [{ metric: { __name__: 'up', job: 'mock' }, values: [[1_700_000_000, '1']] }],
      },
    }));
  });
  upstreamOrigin = await listen(upstreamServer);

  const app = express();
  const router = express.Router();
  registerSignalsRoutes(router);
  app.use(router);
  appServer = createServer(app);
  origin = await listen(appServer);
});

beforeEach(() => {
  upstreamMode = 'success';
  receivedQueries.length = 0;
  process.env.RDK_PROMETHEUS_QUERY_URL = upstreamOrigin;
});

after(async () => {
  await close(appServer);
  await close(upstreamServer);
  resetObservabilityAccessAdapter();
  delete process.env.RDK_CREDITS_ADMIN_TOKEN;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  delete process.env.RDK_PROMETHEUS_QUERY_URL;
});

async function requestQuery(query: string, token = ADMIN_TOKEN): Promise<Response> {
  const params = new URLSearchParams({ query, minutes: '240' });
  return fetch(`${origin}/api/ops/observability/prom/query?${params}`, {
    headers: { 'x-admin-token': token },
  });
}

async function assertFailure(response: Response, status: number, error: string): Promise<void> {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { ok: false, error });
}

test('PromQL regex, escapes, operators, UTF-8 labels and formatted whitespace reach the backend unchanged', async () => {
  const queries = [
    'up',
    'up{job=~"api.+"}',
    'up{job!~"api.+"}',
    String.raw`up{path=~"api\\v[0-9]+",quote="\""}`,
    '5 % 2',
    '2 ^ 3',
    'up{region="华东",service="图像处理"}',
    String.raw`up{path="/api?a=1&b=2#detail"}`,
    'sum(rate(http_requests_total{job=~"api.*"}[5m])) / 2',
    'sum(\n\trate(http_requests_total{job=~"api.*"}[5m])\r\n) / 2',
  ];
  for (const query of queries) {
    const response = await requestQuery(query);
    assert.equal(response.status, 200, query);
    const payload = await response.json() as {
      ok: boolean;
      promql: string;
      series: Array<{ name: string; points: Array<{ ts: number; value: number }> }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.promql, query);
    assert.deepEqual(payload.series, [{ name: query.split('{')[0] + ' {"job":"mock"}', points: [{ ts: 1_700_000_000_000, value: 1 }] }]);
    const upstreamRequest = receivedQueries.at(-1);
    assert.ok(upstreamRequest);
    assert.equal(upstreamRequest.pathname, '/api/v1/query_range');
    assert.equal(upstreamRequest.searchParams.get('query'), query);
    assert.equal(upstreamRequest.searchParams.get('step'), '60');
  }
  assert.equal(receivedQueries.length, queries.length);
});

test('the 2000-character boundary is forwarded completely and larger queries are rejected', async () => {
  const prefix = 'up{label="';
  const suffix = '"}';
  const query = prefix + 'x'.repeat(2_000 - prefix.length - suffix.length) + suffix;
  assert.equal(query.length, 2_000);
  assert.equal((await requestQuery(query)).status, 200);
  assert.equal(receivedQueries[0]?.searchParams.get('query'), query);

  for (const oversized of [query + ' ', 'up' + ' '.repeat(2_000)]) {
    await assertFailure(await requestQuery(oversized), 400, 'invalid_promql');
  }
  assert.equal(receivedQueries.length, 1, 'rejection must happen before forwarding, never after truncation');
});

test('empty, repeated and control-character queries fail before reaching Prometheus', async () => {
  for (const query of ['', '   ', '\t\r\n', 'up\u0000', 'up\u0008', 'up\u000b', 'up\u000c', 'up\u000e', 'up\u007f', 'up\u0085']) {
    await assertFailure(await requestQuery(query), 400, 'invalid_promql');
  }
  for (const params of ['', 'query=up&query=down']) {
    const response = await fetch(`${origin}/api/ops/observability/prom/query?${params}`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    await assertFailure(response, 400, 'invalid_promql');
  }
  assert.equal(receivedQueries.length, 0);
});

test('an upstream 400 or bad_data error payload reports invalid PromQL without upstream details', async () => {
  for (const mode of ['http400', 'bad-data-payload'] as const) {
    upstreamMode = mode;
    await assertFailure(await requestQuery('up{'), 400, 'invalid_promql');
  }
  assert.equal(receivedQueries.length, 2, 'syntax validation is delegated to the backend');
});

test('upstream HTTP failures and error payloads never become successful empty series', async () => {
  for (const mode of ['http503', 'execution-error-payload', 'invalid-json', 'invalid-payload'] as const) {
    upstreamMode = mode;
    await assertFailure(await requestQuery('up'), 502, 'prometheus_query_failed');
  }
  assert.equal(receivedQueries.length, 4);
});

test('a disconnected backend returns a bounded network failure', async () => {
  upstreamMode = 'disconnect';
  await assertFailure(await requestQuery('up'), 502, 'prometheus_unreachable');
  assert.equal(receivedQueries.length, 1);
});

test('an unconfigured backend reports the existing unavailable capability', async () => {
  delete process.env.RDK_PROMETHEUS_QUERY_URL;
  await assertFailure(await requestQuery('up'), 501, 'prometheus_not_configured');
  assert.equal(receivedQueries.length, 0);
});

test('PromQL forwarding retains the operations access gate', async () => {
  await assertFailure(await requestQuery('up', 'incorrect-test-token'), 403, 'not_authorized');
  assert.equal(receivedQueries.length, 0);
});
