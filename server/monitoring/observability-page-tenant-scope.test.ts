/**
 * 归属派生片段回归。
 *
 * 这个片段是页面内联脚本的一部分，页面脚本本身是巨型模版字符串、没有模块边界，
 * 所以这里直接把**同一份片段**求值成函数来断言其行为（而不是对字符串做正则），
 * 保证测的就是上线那份实现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPS_TENANT_SCOPE_JS } from './observability-page-tenant-scope.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

function loadFragment(): {
  alertKeyTenant: (key: unknown) => string;
  alertKeyScopeLabel: (key: unknown) => string;
} {
  const factory = new Function(
    `${OPS_TENANT_SCOPE_JS}\nreturn { alertKeyTenant, alertKeyScopeLabel };`,
  ) as () => { alertKeyTenant: (key: unknown) => string; alertKeyScopeLabel: (key: unknown) => string };
  return factory();
}

test('归属派生：t.<tenantId>.<key> 解析出租户，其余归平台', () => {
  const { alertKeyTenant, alertKeyScopeLabel } = loadFragment();
  assert.equal(alertKeyTenant('t.microduck.external-health'), 'microduck');
  assert.equal(alertKeyTenant('t.sim2real.external-entry'), 'sim2real');
  assert.equal(alertKeyScopeLabel('t.microduck.external-health'), '租户 microduck · ');
  // 平台裸 key（无 t. 前缀）→ 平台。
  assert.equal(alertKeyTenant('external-health'), '');
  assert.equal(alertKeyScopeLabel('external-health'), '平台 · ');
  assert.equal(alertKeyTenant('internal-health'), '');
  // 形状不符的一律按平台处理，避免把畸形 key 显示成某个租户。
  for (const bad of ['t.microduck', 't..x', 't.Microduck.x', 't.a.x', 'x.microduck.y', '', 't.-bad.x']) {
    assert.equal(alertKeyTenant(bad), '', bad);
  }
  assert.equal(alertKeyTenant(undefined), '');
  assert.equal(alertKeyTenant(null), '');
});

test('片段确实被拼进页面脚本（不是只存在于模块里）', () => {
  assert.ok(OPS_OBSERVABILITY_HTML.includes('function alertKeyTenant('));
  assert.ok(OPS_OBSERVABILITY_HTML.includes('alertKeyScopeLabel('));
});

test('租户视图不渲染平台专属的审计/通知表，全局视图才渲染', () => {
  const html = OPS_OBSERVABILITY_HTML;
  // 两张表必须包在 tenantScope 判定里：租户视图里它们结构性恒空。
  assert.ok(
    /if\(o\.tenantScope\)\{root\.appendChild\(make\('div','notice'/.test(html),
    '租赁视图应改渲染平台数据归属说明',
  );
  // 归属标签只在全局视图拼进事故副标题（租户视图里每条都是自己，属冗余）。
  assert.ok(html.includes("(o.tenantScope?'':(typeof alertKeyScopeLabel==='function'?alertKeyScopeLabel(item.key):''))"));
});

test('租户 ID 整理建议：与提交校验同规，中文/非法字符给不出合法 ID 时返回空', () => {
  const { tenantIdSuggestion } = (() => {
    const factory = new Function(
      `${OPS_TENANT_SCOPE_JS}\nreturn { tenantIdSuggestion };`,
    ) as () => { tenantIdSuggestion: (v: unknown) => string };
    return factory();
  })();
  const pattern = /^[a-z][a-z0-9-]{1,39}$/;
  // 截图里那个输入：中文被剔除后仍是合法 ID，可以直接用。
  assert.equal(tenantIdSuggestion('s测试1'), 's1');
  assert.equal(tenantIdSuggestion('Sim2Real'), 'sim2real');
  assert.equal(tenantIdSuggestion('team a'), 'team-a');
  assert.equal(tenantIdSuggestion('mujoco_lab'), 'mujoco-lab');
  assert.equal(tenantIdSuggestion('1team'), 'team');
  assert.equal(tenantIdSuggestion('  MicroDuck  '), 'microduck');
  // 纯中文 / 太短 / 首字符不是字母 → 给不出合法建议（调用方提示改用显示名称）。
  for (const bad of ['超级智能体', '_x', '-', '', '   ', '中文名']) {
    assert.equal(tenantIdSuggestion(bad), '', bad);
  }
  // 建议结果本身必须能通过服务端同规校验（否则提示就是错的）。
  for (const input of ['s测试1', 'Sim2Real', 'team a', 'mujoco_lab', '1team', 'ok-name']) {
    const out = tenantIdSuggestion(input);
    if (out) assert.ok(pattern.test(out), `${input} → ${out} 应满足服务端规则`);
  }
});
