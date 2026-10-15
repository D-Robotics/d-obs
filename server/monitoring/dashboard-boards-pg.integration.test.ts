import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { configureDashboardPoolForTest } from './dashboard-boards-store.js';
import { registerSignalsRoutes } from './observability-signals-routes.js';
import { createAiEcosystemRouter } from '../observability/ai-ecosystem-routes.js';
import { closeAiEcosystemMetricStoreForTest } from '../observability/ai-ecosystem-metrics-store.js';

const connectionString = String(process.env.DOBS_TEST_DATABASE_URL ?? '').trim();
type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> };

test('editable dashboards persist legacy and Grafana definitions, share read-only, and query real OTLP samples', {
  skip: !connectionString, timeout: 35_000,
}, async (t) => {
  const pg = await import('pg' as string) as { default: { Client: new (options: { connectionString: string }) => Client } };
  const control = new pg.default.Client({ connectionString });
  await control.connect();
  const database = 'dobs_dashboard_' + randomUUID().replace(/-/g, '');
  await control.query(`create database "${database}"`);
  const target = new URL(connectionString); target.pathname = '/' + database;
  const db = new pg.default.Client({ connectionString: target.toString() });
  const keys = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_FLYWHEEL_ADMIN_USER_IDS', 'RDK_PUBLIC_OBSERVABILITY_API_TOKEN', 'RDK_CREDITS_ADMIN_TOKEN'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let server: Server | undefined;
  try {
    await db.connect();
    // Deliberately start from the pre-sharing schema, with an old flat panel.
    await db.query(`create table public.studio_obs_dashboards (
      id uuid primary key default gen_random_uuid(), owner text not null, name text not null,
      spec jsonb not null, position int not null default 0,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    ); create table public.studio_obs_dashboard_panels (
      owner text not null, title text not null, spec jsonb not null,
      position int not null default 0, created_at timestamptz not null default now()
    )`);
    await db.query('insert into public.studio_obs_dashboard_panels(owner,title,spec) values($1,$2,$3::jsonb)',
      ['alice', '旧时延', JSON.stringify({ metric: 'dashboard.fixture.latency', windowMinutes: 60 })]);
    process.env.RDK_CHAT_CREDITS_DB_URL = target.toString();
    process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'alice,bob';
    process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN = 'dashboard-integration-ingest-only';
    delete process.env.RDK_CREDITS_ADMIN_TOKEN;
    configureDashboardPoolForTest(db);
    configureObservabilityAccess({
      getSessionSsoUser: (req) => req.header('fixture-actor') ? { id: req.header('fixture-actor')!, name: 'Repeated operator' } : null,
      isMultiUserWebDeployment: () => true,
      allowsAnonymousLocalOperator: () => false,
      resolveChatPrincipalAccountId: (req) => req.header('fixture-actor') ?? '',
    });
    const app = express(); app.use(express.json());
    const router = express.Router(); registerSignalsRoutes(router); app.use(router); app.use(createAiEcosystemRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const api = '/api/ops/observability/boards';
    const request = (path: string, actor = 'alice', method = 'GET', body?: unknown) => fetch(origin + path, {
      method, headers: { 'fixture-actor': actor, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let boardId = '';
    await t.test('old flat panels migrate privately and the old SQL schema upgrades without losing definitions', async () => {
      const response = await request(api); assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.boards.length, 1); assert.equal(body.boards[0].visibility, 'private');
      assert.equal(body.boards[0].editable, true); assert.equal(body.boards[0].spec.panels[0].metric, 'dashboard.fixture.latency');
      assert.equal(body.boards[0].owner, undefined);
      assert.equal((await (await request(api, 'bob')).json() as any).boards.length, 0);
    });
    await t.test('full Grafana query, variables and multi-target definitions survive JSONB persistence', async () => {
      const response = await request(api + '/import', 'alice', 'POST', { template: {
        title: '业务请求', schemaVersion: 39, time: { from: 'now-1h', to: 'now' },
        templating: { list: [{ name: 'service', label: '服务', type: 'custom', query: 'checkout,orders', current: { text: 'checkout', value: 'checkout' } }] },
        panels: [{ type: 'timeseries', title: 'QPS', datasource: { type: 'prometheus', uid: 'prometheus' },
          targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total{service="$service"}[5m]))' },
            { refId: 'B', expr: 'sum(rate(http_requests_total{service="$service",status=~"5.."}[5m]))', legendFormat: '失败' }],
          gridPos: { x: 0, y: 0, w: 24, h: 8 } }],
      } });
      assert.equal(response.status, 201); const body = await response.json() as any; boardId = body.board.id;
      const row = await db.query('select spec,visibility from public.studio_obs_dashboards where id=$1', [boardId]);
      const spec = row.rows[0].spec as any;
      assert.equal(spec.panels[0].source, 'prometheus'); assert.equal(spec.panels[0].queries.length, 2);
      assert.equal(spec.panels[0].queries[0].expr, 'sum(rate(http_requests_total{service="$service"}[5m]))');
      assert.equal(spec.variables[0].value, 'checkout'); assert.equal(row.rows[0].visibility, 'private');
    });
    await t.test('sharing grants authorized operators viewing and cloning while writes stay owner-only', async () => {
      assert.equal((await request(api + '/' + boardId, 'alice', 'PUT', { visibility: 'team' })).status, 200);
      const visible = await (await request(api, 'bob')).json() as any;
      assert.equal(visible.boards.length, 1); const shared = visible.boards[0];
      assert.equal(shared.editable, false); assert.equal(shared.visibility, 'team'); assert.equal(shared.owner, undefined);
      assert.equal((await request(api + '/' + boardId, 'bob', 'PUT', { name: '不应写入', visibility: 'private' })).status, 404);
      assert.equal((await request(api + '/' + boardId, 'bob', 'DELETE')).status, 404);
      assert.equal((await request(api + '/' + boardId + '/export/grafana', 'bob')).status, 200);
      const copy = await request(api, 'bob', 'POST', { name: '我的业务副本', spec: shared.spec });
      assert.equal(copy.status, 201); const copied = await copy.json() as any;
      assert.equal(copied.board.visibility, 'private'); assert.equal(copied.board.editable, true);
      assert.notEqual(copied.board.id, boardId);
      assert.equal((await request(api, '')).status, 403);
      assert.equal((await request(api, 'non-admin')).status, 403);
      assert.equal((await request(api + '/' + boardId, 'alice', 'PUT', { visibility: 'public' })).status, 400);
      await request(api + '/' + boardId, 'alice', 'PUT', { visibility: 'private' });
      assert.equal((await (await request(api, 'bob')).json() as any).boards.some((board: any) => board.id === boardId), false);
    });
    await t.test('standard OTLP ingestion commits before the unified panel query reads the sample', async () => {
      const timestampMs = Date.now() - 1000;
      const response = await fetch(origin + '/v1/metrics', { method: 'POST',
        headers: { authorization: 'Bearer dashboard-integration-ingest-only', 'content-type': 'application/json' },
        body: JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
          scopeMetrics: [{ metrics: [{ name: 'dashboard.fixture.latency', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(timestampMs) * 1000000n), asDouble: 23 }] } }] }] }] }),
      });
      assert.equal(response.status, 200); const ingested = await response.json() as any;
      assert.equal(Number(ingested.partialSuccess?.rejectedDataPoints ?? 0), 0);
      const queried = await request(api + '/query', 'alice', 'POST', {
        panel: { title: '实际落库时延', metric: 'dashboard.fixture.latency', source: 'otlp', chart: 'line', width: 2 },
        windowMinutes: 60, filters: { service: 'checkout' },
      });
      assert.equal(queried.status, 200); const result = await queried.json() as any;
      assert.equal(result.series.length, 1); assert.equal(result.series[0].labels.service, 'checkout');
      assert.equal(result.series[0].points.length, 1); assert.equal(result.series[0].points[0].value, 23);
      assert.ok(result.series[0].points[0].ts > 1000000000000, 'chart timestamps remain milliseconds');
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await closeAiEcosystemMetricStoreForTest();
    configureDashboardPoolForTest(null); resetObservabilityAccessAdapter();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    await db.end();
    // Resource registration uses additional production pools. Let their idle
    // connections expire; forcing termination would emit unhandled PG errors.
    const deadline = Date.now() + 12_000;
    let idle = false;
    while (Date.now() < deadline) {
      const active = await control.query('select count(*)::int as count from pg_stat_activity where datname=$1', [database]);
      if (Number(active.rows[0].count) === 0) { idle = true; break; }
      await delay(100);
    }
    if (idle) await control.query(`drop database "${database}"`);
    await control.end();
  }
});
