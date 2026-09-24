import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { __testables } from './observability-object-registry.js';

const { computeEffectiveBindings, sanitizeRegistryLabels, OBJECT_ID_PATTERN } = __testables;

test('绑定：无自定义行时代码映射原样生效（host/self 保持原始语义，由调用方解析本机）', () => {
  const rows = computeEffectiveBindings(
    { 'disk-space': 'host/self', 'postgres-error-log': 'database/postgresql' },
    [],
  );
  const disk = rows.find((row) => row.ruleKey === 'disk-space');
  assert.equal(disk?.objectId, 'host/self');
  assert.equal(disk?.source, 'default');
  assert.equal(rows.find((row) => row.ruleKey === 'postgres-error-log')?.source, 'default');
});

test('绑定：自定义行覆盖默认；代码映射之外的键也能携带自定义绑定', () => {
  const rows = computeEffectiveBindings(
    { 'disk-space': 'host/self', 'api-5xx-spike': 'service/rdkstudio-web' },
    [
      { rule_key: 'disk-space', object_id: 'host/edge-server-01' },
      { rule_key: 'custom-latency-rule', object_id: 'service/new-api' },
    ],
  );
  assert.equal(rows.find((row) => row.ruleKey === 'disk-space')?.objectId, 'host/edge-server-01');
  assert.equal(rows.find((row) => row.ruleKey === 'disk-space')?.source, 'custom');
  assert.equal(rows.find((row) => row.ruleKey === 'api-5xx-spike')?.objectId, 'service/rdkstudio-web');
  assert.equal(rows.find((row) => row.ruleKey === 'custom-latency-rule')?.source, 'custom');
});

test('绑定：脏行（空键 / 空对象 / 超长截断后为空）被忽略，不产生幽灵绑定', () => {
  const rows = computeEffectiveBindings({ 'disk-space': 'host/self' }, [
    { rule_key: '', object_id: 'host/x' },
    { rule_key: 'ok-key', object_id: '' },
    { rule_key: null, object_id: 'host/x' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruleKey, 'disk-space');
});

test('标签消毒：非对象 / 超过 16 键拒绝；键值裁剪净化', () => {
  assert.equal('error' in sanitizeRegistryLabels('not-an-object'), true);
  assert.equal('error' in sanitizeRegistryLabels(['array']), true);
  const tooMany: Record<string, string> = {};
  for (let i = 0; i < 17; i++) tooMany[`k${i}`] = 'v';
  assert.equal('error' in sanitizeRegistryLabels(tooMany), true);
  const clean = sanitizeRegistryLabels({ team: '  edge-team  ', empty: '   ' });
  assert.deepEqual('labels' in clean ? clean.labels : null, { team: 'edge-team', empty: '' });
});

test('对象 ID 形状：type/id 结构，拒绝无类型前缀或空 id', () => {
  assert.equal(OBJECT_ID_PATTERN.test('host/my-server'), true);
  assert.equal(OBJECT_ID_PATTERN.test('service/gateway/model'), true);
  assert.equal(OBJECT_ID_PATTERN.test('my-server'), false);
  assert.equal(OBJECT_ID_PATTERN.test('host/'), false);
  assert.equal(OBJECT_ID_PATTERN.test('host/has space'), false);
});

test('源码级：事故对象解析必须走可编辑绑定解析器，不得回退写死静态映射', () => {
  const delivery = readFileSync(new URL('./studio-alert-delivery.ts', import.meta.url), 'utf8');
  assert.ok(
    delivery.includes('resolveAlertRuleObjectTarget'),
    'studio-alert-delivery 应使用 resolveAlertRuleObjectTarget（自定义绑定优先）',
  );
  assert.ok(
    !delivery.includes('alertRuleObjectTarget('),
    'studio-alert-delivery 不得直连静态映射 alertRuleObjectTarget',
  );
});
