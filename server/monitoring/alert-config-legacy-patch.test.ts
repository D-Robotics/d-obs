/**
 * 告警配置 PATCH 旧规则键别名回归。
 *
 * 背景（2026-10-08 生产排障发现）：存量配置里的 moss-model-target-degraded 是
 * 旧键，读入时映射为 agent-model-target-degraded；但 PATCH 合并循环遍历的是
 * 现键集合，旧键补丁被静默忽略——调用方以为改了阈值，实际什么都没改。
 * 当天 agent-model-target-degraded 的阈值调优第一次 PUT 就这样落空。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  loadAlertConfig,
  mergeAndValidateAlertConfig,
  type AlertConfigPatch,
} from './alert-config.js';

let dir: string;
let configPath: string;
let savedEnvPath: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(async () => {
  savedEnvPath = process.env.RDK_ALERT_CONFIG_PATH;
  savedNodeEnv = process.env.NODE_ENV;
  dir = await mkdtemp(path.join(tmpdir(), 'dobs-alert-config-legacy-patch-'));
  configPath = path.join(dir, 'config.json');
  process.env.RDK_ALERT_CONFIG_PATH = configPath;
  process.env.NODE_ENV = 'development';
});

afterEach(async () => {
  if (savedEnvPath === undefined) delete process.env.RDK_ALERT_CONFIG_PATH;
  else process.env.RDK_ALERT_CONFIG_PATH = savedEnvPath;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('PATCH 旧键 moss-model-target-degraded 等价于改 agent-model-target-degraded', async () => {
  const current = await loadAlertConfig();
  const merged = mergeAndValidateAlertConfig(current, {
    rules: { 'moss-model-target-degraded': { threshold: 3, criticalThreshold: 6 } },
  } as never as AlertConfigPatch);

  const rule = merged.rules['agent-model-target-degraded'];
  assert.equal(rule.threshold, 3, '旧键补丁必须落到现键规则');
  assert.equal(rule.criticalThreshold, 6);
  assert.equal(rule.enabled, current.rules['agent-model-target-degraded'].enabled, '未提及字段继承');
});

test('旧键补丁同样获得审计盖章', async () => {
  const merged = mergeAndValidateAlertConfig(
    await loadAlertConfig(),
    {
      rules: { 'moss-model-target-degraded': { threshold: 3, criticalThreshold: 6 } },
    } as never as AlertConfigPatch,
    new Date(),
    { actor: 'admin-token' },
  );
  assert.equal(merged.rules['agent-model-target-degraded'].updatedBy, 'admin-token');
  assert.equal(merged.rules['agent-model-target-degraded'].createdBy, 'admin-token');
});

test('现键与旧键同时出现时，现键值优先', async () => {
  const merged = mergeAndValidateAlertConfig(await loadAlertConfig(), {
    rules: {
      'agent-model-target-degraded': { threshold: 4, criticalThreshold: 8 },
      'moss-model-target-degraded': { threshold: 3, criticalThreshold: 6 },
    },
  } as never as AlertConfigPatch);
  assert.equal(merged.rules['agent-model-target-degraded'].threshold, 3);
});

test('未知键（unmanaged）仍被忽略，不产生新规则', async () => {
  const merged = mergeAndValidateAlertConfig(await loadAlertConfig(), {
    rules: { 'l4-canary-ready-for-approval': { enabled: true } },
  } as never as AlertConfigPatch);
  assert.equal(
    (merged.rules as Record<string, unknown>)['l4-canary-ready-for-approval'],
    undefined,
    'unmanaged 键保持不进 schema 规则集',
  );
});
