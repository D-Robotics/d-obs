/**
 * 数据库面板表白名单回归（RDK_DB_PANEL_TABLES）。
 *
 * 默认不配置 = 不限制（保持历史行为）；配置后目录列表、关系图、表详情、整表
 * CSV 导出四个面都必须一致收敛，否则可以靠猜表名绕过。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

/** 仓库根（本测试位于 server/monitoring/ 下）。 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/**
 * 白名单防漂移。
 *
 * 生产 `RDK_DB_PANEL_TABLES` 用的是 `ops/db-panel-allowlist.txt` 的内容，而那份名单是
 * 从代码推导出来的。代码里新增一张表的读写、而没人同步名单时，面板会漏掉本该可见的表
 * （运维排查时才发现）。这里重算一遍可达表集合并断言全部在名单里，漏了就直接失败。
 */
test('ops/db-panel-allowlist.txt 覆盖所有运行时可达的表（防漂移）', async () => {
  const root = SERVER_ROOT;
  const seen = new Set<string>();
  const queue = ['server/main.ts'];
  const resolveRef = (from: string, spec: string): string | null => {
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base.replace(/\.js$/, '.ts'), base]) {
      if (existsSync(candidate)) return path.relative(root, candidate);
    }
    return null;
  };
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(path.join(root, file), 'utf8');
    // 静态 from '...' 与动态 import('...') 都要跟（租户 store 就是动态导入的）。
    for (const match of source.matchAll(/(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const next = resolveRef(path.join(root, file), match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  const touched = new Set<string>();
  for (const file of seen) {
    if (file.endsWith('.test.ts')) continue;
    const source = await readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(
      /\b(?:from|into|update|join)\s+(?:public\.)?((?:studio|agent|conversation|ops)_[a-z0-9_]+)/gi,
    )) {
      touched.add(match[1].toLowerCase());
    }
  }
  const listed = new Set(
    (await readFile(path.join(root, 'ops/db-panel-allowlist.txt'), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => line.split(',').map((name) => name.trim()))
      .filter(Boolean),
  );
  assert.ok(listed.size > 20, `名单条目过少（${listed.size}），检查文件是否被破坏`);
  const missing = [...touched].filter((table) => !listed.has(table)).sort();
  assert.deepEqual(
    missing,
    [],
    `以下运行时可达的表不在 ops/db-panel-allowlist.txt 里，请补上并同步生产 RDK_DB_PANEL_TABLES：${missing.join(', ')}`,
  );
});
