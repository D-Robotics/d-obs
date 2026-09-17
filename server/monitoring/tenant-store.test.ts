/** 租户注册纯函数回归测试：ID 规则、保留字、token 格式与哈希。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configureTenantPoolForTest,
  findTenantByToken,
  generateTenantToken,
  hashTenantToken,
  invalidateTenantTokenCache,
  rotateTenantToken,
  setTenantStatus,
  validTenantId,
} from './tenant-store.js';

test('tenantId 规则：小写字母开头，小写字母数字连字符，2-40 字符', () => {
  assert.equal(validTenantId('team-a'), true);
  assert.equal(validTenantId('ab'), true);
  // 首字符后至少还要 1 个字符。
  assert.equal(validTenantId('a'), false);
  assert.equal(validTenantId('A-team'), false);
  assert.equal(validTenantId('1team'), false);
  assert.equal(validTenantId('team_a'), false);
  assert.equal(validTenantId(''), false);
  assert.equal(validTenantId('x'.repeat(41)), false);
  assert.equal(validTenantId(undefined), false);
});

test('保留字 tenantId 被拒绝（platform 命名空间与本地地址）', () => {
  for (const reserved of ['platform', 'admin', 'self', 'default', '106.53']) {
    assert.equal(validTenantId(reserved), false, reserved);
  }
});

test('租户 token：64-hex 随机、不可预测；哈希确定且与原文可区分', () => {
  const a = generateTenantToken();
  const b = generateTenantToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.match(b, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.equal(hashTenantToken(a), hashTenantToken(a));
  assert.notEqual(hashTenantToken(a), hashTenantToken(b));
  assert.equal(hashTenantToken(a).length, 64);
  // 哈希不等于原文（库中只存哈希的前提）。
  assert.notEqual(hashTenantToken(a), a);
});

test('listTenants：全新库尚未建拨测表时退回不带最近上报的查询（不再 503）', async () => {
  const { configureTenantPoolForTest, listTenants, invalidateTenantTokenCache } = await import(
    './tenant-store.js'
  );
  invalidateTenantTokenCache();
  const queries: string[] = [];
  const missingTable = Object.assign(new Error('relation "public.studio_external_probe_status" does not exist'), {
    code: '42P01',
  });
  configureTenantPoolForTest({
    query: async (text: string) => {
      queries.push(text);
      if (/create (table|index)/.test(text)) return { rows: [] };
      // 首次带 join 的查询模拟真库缺表；退回查询（无 join）正常返回。
      if (text.includes('studio_external_probe_status')) throw missingTable;
      return {
        rows: [
          {
            tenant_id: 'team-a',
            display_name: 'A 队',
            status: 'active',
            created_at: new Date(0),
            created_by: 'test',
            last_report_at: null,
          },
        ],
      };
    },
  });
  try {
    const tenants = await listTenants();
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].tenantId, 'team-a');
    // 退回的查询不含 join 到缺失表。
    assert.ok(queries.some((q) => q.includes('null as last_report_at')));
    assert.equal(tenants[0].lastReportAt, null);
  } finally {
    configureTenantPoolForTest(null);
  }
});

test('listTenants：非缺表错误仍然抛出（不退化成静默空列表）', async () => {
  const { configureTenantPoolForTest, listTenants } = await import('./tenant-store.js');
  configureTenantPoolForTest({
    query: async (text: string) => {
      if (/create (table|index)/.test(text)) return { rows: [] };
      throw Object.assign(new Error('permission denied for table studio_obs_tenants'), {
        code: '42501',
      });
    },
  });
  try {
    await assert.rejects(() => listTenants(), /permission denied/);
  } finally {
    configureTenantPoolForTest(null);
  }
});

test('token 轮换/停用后旧 token 立即失效（60s 缓存必须被显式清掉）', async () => {
  // 真机验证时发现：直接改库（绕开服务）删租户后旧 token 还能读 60 秒——那是
  // findTenantByToken 的短缓存。服务自己的撤销路径必须清缓存，否则「轮换 token」
  // 之后旧凭据仍能用一分钟，安全语义就错了。这里用假池子把这条语义钉住。
  const activeRow = {
    tenant_id: 'team-a',
    display_name: 'Team A',
    status: 'active',
    created_at: new Date('2026-09-01T00:00:00Z'),
    created_by: 'tester',
  };
  let tokenRows: Array<Record<string, unknown>> = [activeRow];
  let tokenRotated = false;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/create table|create index|alter table/i.test(text)) return { rows: [] };
      if (/probe_token_hash = \$1/i.test(text)) {
        // 模拟库：轮换后旧哈希查不到任何行
        return { rows: tokenRotated ? [] : tokenRows };
      }
      if (/update public\.studio_obs_tenants set probe_token_hash/i.test(text)) {
        tokenRotated = true;
        return { rows: [{ tenant_id: params?.[0] }], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  configureTenantPoolForTest(pool as never);
  try {
    const token = generateTenantToken();
    // 第一次解析：命中数据库并写入缓存
    const first = await findTenantByToken(token);
    assert.equal(first?.tenantId, 'team-a');

    // 轮换：旧 token 的哈希在库里已不存在
    const rotated = await rotateTenantToken('team-a');
    assert.match(rotated, /^[a-f0-9]{64}$/);

    // 关键断言：旧 token 必须立刻解析不到（缓存若没清，这里会拿到 team-a）
    assert.equal(await findTenantByToken(token), null, '轮换后旧 token 不得再解析出租户');

    // 新 token 也应当解析不到：库里已换哈希，而上面那行假池子模拟"查不到旧行"
    assert.equal(await findTenantByToken(rotated), null);
  } finally {
    configureTenantPoolForTest(null);
    invalidateTenantTokenCache();
  }
});

test('停用租户后缓存清空：即使库里仍是 active 行也不复用旧结论', async () => {
  const activeRow = {
    tenant_id: 'team-b',
    display_name: 'Team B',
    status: 'active',
    created_at: new Date('2026-09-01T00:00:00Z'),
    created_by: 'tester',
  };
  let disabled = false;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/create table|create index|alter table/i.test(text)) return { rows: [] };
      if (/probe_token_hash = \$1/i.test(text)) return { rows: disabled ? [] : [activeRow] };
      if (/update public\.studio_obs_tenants set status/i.test(text)) {
        disabled = true;
        return { rows: [{ tenant_id: params?.[0] }], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  configureTenantPoolForTest(pool as never);
  try {
    const token = generateTenantToken();
    assert.equal((await findTenantByToken(token))?.tenantId, 'team-b');
    await setTenantStatus('team-b', 'disabled');
    assert.equal(await findTenantByToken(token), null, '停用后旧 token 不得继续可用');
  } finally {
    configureTenantPoolForTest(null);
    invalidateTenantTokenCache();
  }
});
