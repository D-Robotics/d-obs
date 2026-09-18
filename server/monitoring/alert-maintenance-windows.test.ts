/**
 * 维护窗口回归测试：抑制判定纯函数、active 键集合收集、创建/删除/列表
 * SQL 语义（假池按 SQL 形状返回）、reason 必填与分钟数钳制。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectActiveMaintenanceKeys,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  listMaintenanceWindows,
  maintenanceSuppression,
  type MaintenanceWindow,
} from './alert-maintenance-windows.js';

type Row = Record<string, unknown>;

/** 假池：按 SQL 形状路由，维护一张内存窗口表。 */
function fakePool(initial: Array<Partial<MaintenanceWindow>> = []) {
  const rows: Row[] = initial.map((item, index) => ({
    id: index + 1,
    alert_key: item.alertKey ?? '',
    starts_at: new Date(item.startsAt ?? Date.now() - 60_000),
    ends_at: new Date(item.endsAt ?? Date.now() + 60_000),
    reason: item.reason ?? '测试维护窗口',
    created_by: item.createdBy ?? 'ops-test',
    created_at: new Date(),
    expired_at: null,
  }));
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      queries.push(sql);
      if (sql.startsWith('create table') || sql.startsWith('create index')) {
        return { rows: [] };
      }
      if (sql.startsWith('delete from')) {
        // collectActiveMaintenanceKeys 的过期清理（ends_at < now - 24h）。
        if (sql.includes('ends_at < now() - interval')) {
          rows.forEach((row) => {
            const endsAt = row.ends_at as Date;
            if (endsAt.getTime() < Date.now() - 24 * 3600_000) row.__deleted = true;
          });
          return { rows: [], rowCount: 0 };
        }
        const id = Number(params?.[0]);
        const index = rows.findIndex((row) => Number(row.id) === id);
        if (index < 0) return { rows: [], rowCount: 0 };
        rows.splice(index, 1);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('select alert_key from')) {
        // active 集合：starts_at <= now < ends_at。
        return {
          rows: rows
            .filter(
              (row) =>
                (row.starts_at as Date).getTime() <= Date.now() &&
                (row.ends_at as Date).getTime() > Date.now(),
            )
            .map((row) => ({ alert_key: row.alert_key })),
        };
      }
      if (sql.startsWith('select id, alert_key')) {
        return { rows: rows.map((row) => ({ ...row })) };
      }
      if (sql.startsWith('insert into')) {
        const [alertKey, minutes, reason, createdBy] = params as [string, number, string, string];
        const row: Row = {
          id: rows.length + 100,
          alert_key: alertKey,
          starts_at: new Date(),
          ends_at: new Date(Date.now() + minutes * 60_000),
          reason,
          created_by: createdBy,
          created_at: new Date(),
          expired_at: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      throw new Error('unexpected_sql: ' + sql.slice(0, 60));
    },
  };
}

test('维护窗口抑制判定：全局键抑制所有规则，规则键只抑制精确匹配', () => {
  assert.deepEqual(maintenanceSuppression('disk-space', new Set([''])), {
    suppressed: true,
    reason: 'maintenance_window_active_global',
  });
  assert.deepEqual(maintenanceSuppression('disk-space', new Set(['disk-space'])), {
    suppressed: true,
    reason: 'maintenance_window_active_rule',
  });
  assert.equal(maintenanceSuppression('disk-space', new Set(['api-5xx-spike'])), null);
  assert.equal(maintenanceSuppression('disk-space', new Set()), null);
  // 全局与规则键同时命中时按全局语义上报（更高优先级的原因码）。
  const suppression = maintenanceSuppression('api-5xx-spike', new Set(['', 'api-5xx-spike']));
  assert.ok(suppression);
  assert.equal(suppression.reason, 'maintenance_window_active_global');
});

test('collectActiveMaintenanceKeys：只返回当前生效的键集合', async () => {
  const p = fakePool([
    { alertKey: '', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() },
    { alertKey: 'disk-space', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() },
    { alertKey: 'api-5xx-spike', startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 120_000).toISOString() },
    { alertKey: 'nginx-5xx-log', startsAt: new Date(Date.now() - 120_000).toISOString(), endsAt: new Date(Date.now() - 60_000).toISOString() },
  ]);
  const keys = await collectActiveMaintenanceKeys(p);
  assert.deepEqual([...keys].sort(), ['', 'disk-space']);
});

test('createMaintenanceWindow：reason 必填、分钟数钳制、返回归一化窗口', async () => {
  const p = fakePool();
  const created = await createMaintenanceWindow(p, {
    alertKey: 'disk-space',
    minutes: 30,
    reason: '数据库计划升级',
    createdBy: 'ops-admin',
  });
  assert.equal(created.alertKey, 'disk-space');
  assert.equal(created.reason, '数据库计划升级');
  assert.equal(created.createdBy, 'ops-admin');
  assert.ok(Date.parse(created.endsAt) > Date.now() + 29 * 60_000);

  await assert.rejects(
    createMaintenanceWindow(p, { alertKey: '', minutes: 30, reason: '  ', createdBy: 'x' }),
    /maintenance_reason_required/,
  );
  // 超上限钳制到 7 天，低于下限钳到 5 分钟（由 SQL 侧 make_interval 执行，
  // 假池只验证传入值被钳制后的 insert 参数）。
  const clamped = await createMaintenanceWindow(p, {
    alertKey: '',
    minutes: 999_999,
    reason: '年度维护演练',
    createdBy: 'ops-admin',
  });
  assert.ok(clamped.endsAt && Date.parse(clamped.endsAt) > 0);
});

test('deleteMaintenanceWindow：命中返回 true，未命中返回 false', async () => {
  const p = fakePool([{ alertKey: 'disk-space' }]);
  assert.equal(await deleteMaintenanceWindow(p, 1), true);
  assert.equal(await deleteMaintenanceWindow(p, 999), false);
});

test('listMaintenanceWindows：±7 天内按开始时间倒序返回', async () => {
  const p = fakePool([
    { alertKey: 'disk-space' },
    { alertKey: '', reason: '全局维护' },
  ]);
  const windows = await listMaintenanceWindows(p);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].id, 1);
  assert.equal(windows[1].alertKey, '');
  assert.equal(windows[1].reason, '全局维护');
});
