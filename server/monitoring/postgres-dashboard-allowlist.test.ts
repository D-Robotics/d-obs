/**
 * 数据库面板表白名单回归（RDK_DB_PANEL_TABLES）。
 *
 * 默认不配置 = 不限制（保持历史行为）；配置后目录列表、关系图、表详情、整表
 * CSV 导出四个面都必须一致收敛，否则可以靠猜表名绕过。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  PostgresTableDetailError,
  collectPostgresTableCsvExport,
  collectPostgresTableDetail,
  isPostgresDashboardTableAllowed,
  postgresDashboardTableAllowlist,
} from './postgres-dashboard-store.js';

const ENV_KEY = 'RDK_DB_PANEL_TABLES';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

test('未配置白名单：不限制（保持历史行为）', () => {
  assert.equal(postgresDashboardTableAllowlist({}).size, 0);
  assert.equal(isPostgresDashboardTableAllowed('public', 'studio_ops_events', {}), true);
  assert.equal(isPostgresDashboardTableAllowed('anything', 'any_table', {}), true);
  // 空白配置同样视为未配置。
  assert.equal(isPostgresDashboardTableAllowed('public', 'x', { [ENV_KEY]: '   ' }), true);
});

test('白名单条目：裸表名默认 public，schema.table 原样，大小写不敏感', () => {
  const allowlist = postgresDashboardTableAllowlist({
    [ENV_KEY]: 'studio_ops_events, ops_ai.masked_events  other_table',
  });
  assert.deepEqual(
    [...allowlist].sort(),
    ['ops_ai.masked_events', 'public.other_table', 'public.studio_ops_events'].sort(),
  );
  const env = { [ENV_KEY]: 'studio_ops_events' };
  assert.equal(isPostgresDashboardTableAllowed('public', 'studio_ops_events', env), true);
  assert.equal(isPostgresDashboardTableAllowed('PUBLIC', 'STUDIO_OPS_EVENTS', env), true);
  assert.equal(isPostgresDashboardTableAllowed('public', 'studio_users', env), false);
  // 同名表在别的 schema 下不放行（除非条目里显式写了 schema）。
  assert.equal(isPostgresDashboardTableAllowed('archive', 'studio_ops_events', env), false);
  // 显式 schema 条目只放行该 schema。
  const scoped = { [ENV_KEY]: 'ops_ai.masked_events' };
  assert.equal(isPostgresDashboardTableAllowed('ops_ai', 'masked_events', scoped), true);
  assert.equal(isPostgresDashboardTableAllowed('public', 'masked_events', scoped), false);
});

test('进程环境变量生效（生产路径读 process.env）', () => {
  process.env[ENV_KEY] = 'studio_alert_incidents';
  assert.equal(isPostgresDashboardTableAllowed('public', 'studio_alert_incidents'), true);
  assert.equal(isPostgresDashboardTableAllowed('public', 'conversation_turns'), false);
  assert.equal(postgresDashboardTableAllowlist().size, 1);
});

test('白名单外：详情与 CSV 导出都在触库前按“不存在”拒绝（不确认表是否存在）', async () => {
  process.env[ENV_KEY] = 'studio_alert_incidents';
  // 池被调用即失败：证明拦截发生在任何 SQL 之前。
  const untouchedPool = {
    query: async () => {
      throw new Error('pool_should_not_be_used');
    },
    connect: async () => {
      throw new Error('pool_should_not_be_used');
    },
  };
  for (const run of [
    () => collectPostgresTableDetail(untouchedPool, { schemaName: 'public', tableName: 'studio_users' }),
    () => collectPostgresTableCsvExport(untouchedPool, { schemaName: 'public', tableName: 'studio_users' }),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof PostgresTableDetailError, String(error));
      assert.equal((error as PostgresTableDetailError).status, 404);
      return true;
    });
  }
  // 白名单内的表不会被拦截（这里池故意报错，说明已经走到查询阶段）。
  await assert.rejects(
    () =>
      collectPostgresTableDetail(untouchedPool, {
        schemaName: 'public',
        tableName: 'studio_alert_incidents',
      }),
    /pool_should_not_be_used/,
  );
});
