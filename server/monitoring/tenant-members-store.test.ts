/**
 * 租户组员回归测试：ID 校验、CRUD 冲突语义、租户隔离、active 过滤、
 * owner 计数、以及“数据库不可用异常不上抛”（fail-closed 由调用方处理）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addMember,
  countMembersByTenant,
  countOwners,
  findMembership,
  listMembers,
  listMembershipsForUser,
  removeMember,
  setMemberRole,
  validSsoUserId,
} from './tenant-members-store.js';

/**
 * 假连接池：内存表实现成员语义（tenant/join 状态由 rows 模拟），
 * 供纯函数级回归；不模拟 SQL 语法，只按各函数用到的 SQL 形状返回结果。
 */
function fakePool(tenants: Array<{ tenantId: string; status: string }>) {
  const members: Array<Record<string, unknown>> = [];
  let now = 0;
  return {
    members,
    tenants,
    query: async (text: string, params?: unknown[]) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      const tenantId = String(params?.[0] ?? '');
      if (sql.startsWith('create table') || sql.startsWith('create index')) {
        return { rows: [] };
      }
      if (sql.startsWith('select status')) {
        const tenant = tenants.find((t) => t.tenantId === tenantId);
        return { rows: tenant ? [{ status: tenant.status }] : [] };
      }
      if (sql.startsWith('insert into')) {
        const [tid, uid, displayName, role, addedBy] = params as string[];
        const tenant = tenants.find((t) => t.tenantId === tid);
        if (!tenant) throw new Error('tenant_not_found');
        if (tenant.status !== 'active') return { rows: [] };
        if (members.some((m) => m.tenant_id === tid && m.sso_user_id === uid)) {
          return { rows: [] };
        }
        const row = {
          tenant_id: tid,
          sso_user_id: uid,
          display_name: displayName,
          role,
          added_by: addedBy,
          created_at: new Date(now++ * 1000),
        };
        members.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('delete from')) {
        const uid = String(params?.[1] ?? '');
        const index = members.findIndex(
          (m) => m.tenant_id === tenantId && m.sso_user_id === uid,
        );
        if (index < 0) return { rows: [] };
        const [row] = members.splice(index, 1);
        return { rows: [row] };
      }
      if (sql.startsWith('update ')) {
        const uid = String(params?.[1] ?? '');
        const role = String(params?.[2] ?? '');
        const row = members.find((m) => m.tenant_id === tenantId && m.sso_user_id === uid);
        if (!row) return { rows: [] };
        row.role = role;
        return { rows: [row] };
      }
      if (sql.startsWith('select count(*)') && sql.includes('role = ')) {
        return {
          rows: [
            {
              owners: members.filter(
                (m) => m.tenant_id === tenantId && m.role === 'owner',
              ).length,
            },
          ],
        };
      }
      if (sql.startsWith('select tenant_id, count(*)')) {
        return {
          rows: Object.entries(
            members.reduce<Record<string, number>>((acc, m) => {
              acc[String(m.tenant_id)] = (acc[String(m.tenant_id)] ?? 0) + 1;
              return acc;
            }, {}),
          ).map(([tid, count]) => ({ tenant_id: tid, members: count })),
        };
      }
      // select 成员查询（list/find/memberships 共用 MEMBER_SELECT 形状）：
      // 按 SQL 文本区分语境——`and m.tenant_id = $1`（listMembers，按租户列
      // 全员）、`and m.sso_user_id = $1`（memberships，按用户列全部）、
      // `tenant_id = $1 and m.sso_user_id = $2`（findMembership，按对精确查）。
      const activeTenants = new Set(tenants.filter((t) => t.status === 'active').map((t) => t.tenantId));
      let rows: Array<Record<string, unknown>>;
      if (sql.includes('m.sso_user_id = $1')) {
        rows = members.filter((m) => activeTenants.has(String(m.tenant_id)) && m.sso_user_id === String(params?.[0] ?? ''));
      } else if (sql.includes('m.tenant_id = $1 and m.sso_user_id = $2')) {
        rows = members.filter(
          (m) =>
            activeTenants.has(String(m.tenant_id)) &&
            m.tenant_id === String(params?.[0] ?? '') &&
            m.sso_user_id === String(params?.[1] ?? ''),
        );
      } else {
        rows = members.filter(
          (m) => activeTenants.has(String(m.tenant_id)) && m.tenant_id === String(params?.[0] ?? ''),
        );
      }
      return { rows };
    },
  };
}

test('sso user id 校验：4-128 字符的字母数字与 _.:@-', () => {
  assert.equal(validSsoUserId('u-1234'), true);
  assert.equal(validSsoUserId('a'.repeat(128)), true);
  assert.equal(validSsoUserId('abc:domain'), true);
  assert.equal(validSsoUserId('uid'), false);
  assert.equal(validSsoUserId(''), false);
  assert.equal(validSsoUserId('x'.repeat(129)), false);
  assert.equal(validSsoUserId('has space'), false);
  assert.equal(validSsoUserId(undefined), false);
});

test('addMember/listMembers：插入、回读、displayName 截断', async () => {
  const p = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  const member = await addMember(
    {
      tenantId: 'team-a',
      ssoUserId: 'user-1',
      displayName: 'x'.repeat(200),
      role: 'owner',
      addedBy: 'admin@example.com',
    },
    p,
  );
  assert.equal(member.tenantId, 'team-a');
  assert.equal(member.ssoUserId, 'user-1');
  assert.equal(member.role, 'owner');
  assert.equal(member.displayName.length, 80);
  const list = await listMembers('team-a', p);
  assert.equal(list.length, 1);
  assert.equal(list[0].addedBy, 'admin@example.com');
});

test('addMember 冲突语义：tenant_id_invalid / tenant_not_found / member_already_exists', async () => {
  const p = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  await assert.rejects(
    () => addMember({ tenantId: 'X', ssoUserId: 'user-1', role: 'member', addedBy: 'a' }, p),
    { message: 'tenant_id_invalid' },
  );
  await assert.rejects(
    () => addMember({ tenantId: 'nope', ssoUserId: 'user-1', role: 'member', addedBy: 'a' }, p),
    { message: 'tenant_not_found' },
  );
  await addMember({ tenantId: 'team-a', ssoUserId: 'user-1', role: 'member', addedBy: 'a' }, p);
  await assert.rejects(
    () => addMember({ tenantId: 'team-a', ssoUserId: 'user-1', role: 'member', addedBy: 'a' }, p),
    { message: 'member_already_exists' },
  );
});

test('租户隔离：租户 A 成员查不到租户 B；停用租户的成员关系不可见', async () => {
  const p = fakePool([
    { tenantId: 'team-a', status: 'active' },
    { tenantId: 'team-b', status: 'active' },
    { tenantId: 'team-c', status: 'disabled' },
  ]);
  await addMember({ tenantId: 'team-a', ssoUserId: 'user-1', role: 'owner', addedBy: 'a' }, p);
  // 停用租户不允许新增成员（insert 对 active 过滤后无行返回）。
  await assert.rejects(
    () => addMember({ tenantId: 'team-c', ssoUserId: 'user-9', role: 'member', addedBy: 'a' }, p),
    { message: 'tenant_disabled' },
  );
  // 先在 active 时加入 team-c，再停用：成员关系随之不可见。
  p.tenants[2].status = 'active';
  await addMember({ tenantId: 'team-c', ssoUserId: 'user-1', role: 'member', addedBy: 'a' }, p);
  p.tenants[2].status = 'disabled';
  assert.equal((await findMembership('team-b', 'user-1', p)) === null, true);
  assert.equal((await findMembership('team-c', 'user-1', p)) === null, true);
  const membershipA = await findMembership('team-a', 'user-1', p);
  assert.ok(membershipA);
  assert.equal(membershipA.role, 'owner');
  // team-c 停用：memberships 不返回它。
  const memberships = await listMembershipsForUser('user-1', p);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].tenantId, 'team-a');
});

test('setMemberRole / removeMember：member_not_found；计数函数', async () => {
  const p = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-0001', role: 'owner', addedBy: 'a' }, p);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-0002', role: 'member', addedBy: 'a' }, p);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-0003', role: 'owner', addedBy: 'a' }, p);
  assert.equal(await countOwners('team-a', p), 2);
  assert.equal((await countMembersByTenant(p))['team-a'], 3);
  await setMemberRole('team-a', 'u-0002', 'owner', p);
  assert.equal(await countOwners('team-a', p), 3);
  await assert.rejects(
    () => setMemberRole('team-a', 'u-0404', 'owner', p),
    { message: 'member_not_found' },
  );
  await assert.rejects(() => removeMember('team-a', 'u-0404', p), { message: 'member_not_found' });
  const removed = await removeMember('team-a', 'u-0002', p);
  assert.equal(removed.ssoUserId, 'u-0002');
  assert.equal(await countOwners('team-a', p), 2);
});

test('fail-closed：未配置中心库时 store 抛错而非静默返回（由调用方 503/403）', async () => {
  const saved = process.env.RDK_CHAT_CREDITS_DB_URL;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  try {
    await assert.rejects(() => listMembers('team-a'), /central database/);
    await assert.rejects(() => listMembershipsForUser('u-0001'), /central database/);
  } finally {
    if (saved !== undefined) process.env.RDK_CHAT_CREDITS_DB_URL = saved;
  }
});

test('并发防锁死：两个 owner 同时被降级/移除，只有一个成功', async () => {
  const { resetTenantMutationLocksForTest } = await import('./tenant-members-store.js');
  const reset = () => resetTenantMutationLocksForTest();
  // 降级：两个并发请求各自把一名 owner 降为 member，若判定与写入之间存在窗口，
  // 两个都会成功、租户就此没有任何 owner。
  reset();
  const demotePool = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  await addMember(
    { tenantId: 'team-a', ssoUserId: 'u-owner-1', role: 'owner', addedBy: 'test' },
    demotePool,
  );
  await addMember(
    { tenantId: 'team-a', ssoUserId: 'u-owner-2', role: 'owner', addedBy: 'test' },
    demotePool,
  );
  const demotions = await Promise.allSettled([
    setMemberRole('team-a', 'u-owner-1', 'member', demotePool),
    setMemberRole('team-a', 'u-owner-2', 'member', demotePool),
  ]);
  const fulfilled = demotions.filter((r) => r.status === 'fulfilled');
  const rejected = demotions.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, '只能有一个 owner 被降级');
  assert.equal(rejected.length, 1);
  assert.equal(
    String((rejected[0] as PromiseRejectedResult).reason?.message),
    'last_owner_role_required',
  );
  assert.equal(await countOwners('team-a', demotePool), 1);

  // 移除：同样的竞态，最后必须还剩一个 owner。
  reset();
  const removePool = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  await addMember(
    { tenantId: 'team-a', ssoUserId: 'u-owner-1', role: 'owner', addedBy: 'test' },
    removePool,
  );
  await addMember(
    { tenantId: 'team-a', ssoUserId: 'u-owner-2', role: 'owner', addedBy: 'test' },
    removePool,
  );
  const removals = await Promise.allSettled([
    removeMember('team-a', 'u-owner-1', removePool),
    removeMember('team-a', 'u-owner-2', removePool),
  ]);
  assert.equal(removals.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    String((removals.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason?.message),
    'last_owner_required',
  );
  assert.equal(await countOwners('team-a', removePool), 1);
});

test('防锁死边界：非 last owner 的降级/移除照常成功；不存在的成员报 member_not_found', async () => {
  const { resetTenantMutationLocksForTest } = await import('./tenant-members-store.js');
  resetTenantMutationLocksForTest();
  const pool = fakePool([{ tenantId: 'team-a', status: 'active' }]);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-owner', role: 'owner', addedBy: 'test' }, pool);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-peer', role: 'owner', addedBy: 'test' }, pool);
  await addMember({ tenantId: 'team-a', ssoUserId: 'u-member', role: 'member', addedBy: 'test' }, pool);
  // 还有另一个 owner 时可降级。
  const demoted = await setMemberRole('team-a', 'u-peer', 'member', pool);
  assert.equal(demoted.role, 'member');
  // 普通 member 可移除。
  await removeMember('team-a', 'u-member', pool);
  // 剩 u-owner（owner）与 u-peer（已降为 member）。
  assert.equal((await listMembers('team-a', pool)).length, 2);
  // 不存在 → member_not_found（而不是防锁死错误）。
  await assert.rejects(
    () => setMemberRole('team-a', 'u-missing', 'member', pool),
    /member_not_found/,
  );
  await assert.rejects(() => removeMember('team-a', 'u-missing', pool), /member_not_found/);
});
