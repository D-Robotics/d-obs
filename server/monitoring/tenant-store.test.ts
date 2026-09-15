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
