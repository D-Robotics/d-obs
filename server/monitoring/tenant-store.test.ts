/** 租户注册纯函数回归测试：ID 规则、保留字、token 格式与哈希。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  generateTenantToken,
  hashTenantToken,
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
