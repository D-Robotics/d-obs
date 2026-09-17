/**
 * 告警配置覆写前备份回归。
 *
 * 背景（真机发现）：线上生效的告警配置是主站 worker 的
 * `/var/lib/rdstudio-alert-worker/config.json`（26 条规则），其中 3 条
 * （moss-model-target-degraded / l4-shadow-* / l4-canary-*）不在 d-obs 的 schema 里。
 * 告警配置是活的运维数据、且可能被多个部署共用，任何一次只认识自己那套键的写入
 * 都可能静默丢掉别人的规则。备份不能阻止丢字段，但让误写可恢复，所以固化成回归。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { loadAlertConfig, mergeAndValidateAlertConfig, saveAlertConfig } from './alert-config.js';

let dir: string;
let configPath: string;
let savedEnvPath: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(async () => {
  savedEnvPath = process.env.RDK_ALERT_CONFIG_PATH;
  savedNodeEnv = process.env.NODE_ENV;
  dir = await mkdtemp(path.join(tmpdir(), 'dobs-alert-config-'));
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

test('首次写入不产生备份；覆写时产生备份且内容等于上一版', async () => {
  const first = mergeAndValidateAlertConfig(await loadAlertConfig(), {});
  await saveAlertConfig(first);
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.includes('.bak-')),
    [],
    '首次写入没有可备份内容',
  );

  const second = mergeAndValidateAlertConfig(await loadAlertConfig(), {
    global: { enabled: false },
  });
  await saveAlertConfig(second);
  const backups = (await readdir(dir)).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 1, '第二次写入应留下 1 份备份');
  const backup = JSON.parse(await readFile(path.join(dir, backups[0]), 'utf8'));
  assert.equal(backup.global.enabled, first.global.enabled, '备份内容是覆写前那一版');
  assert.equal((await loadAlertConfig()).global.enabled, false, '主文件是覆写后那一版');
});

test('备份保留上限 5 份，且同秒内连续写入不互相覆盖', async () => {
  for (let i = 0; i < 8; i += 1) {
    const next = mergeAndValidateAlertConfig(await loadAlertConfig(), {
      global: { cooldownMinutes: 5 + i },
    });
    await saveAlertConfig(next);
  }
  const backups = (await readdir(dir)).filter((name) => name.includes('.bak-')).sort();
  assert.equal(backups.length, 5, `应保留 5 份，实际 ${backups.length}`);
  // 文件名含毫秒 → 同秒内多次写入各自成档；字典序即时间序。
  assert.match(backups.at(-1) ?? '', /\.bak-\d{8}T\d{9}Z$/);
  for (const name of backups) {
    const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    assert.ok(Object.keys(parsed.rules ?? {}).length > 0, `${name} 应可解析`);
  }
});

test('含未知规则键的配置文件不再被静默丢弃，而是留档到 preservedRules', async () => {
  // 这份文件模拟「别的部署写的、含 d-obs 不认识的规则键」的配置。
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: null,
        global: { enabled: true },
        notification: {},
        synthetic: {},
        logSignatures: {},
        rules: { 'l4-canary-ready-for-approval': { enabled: true, severity: 'warning' } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // 未知键不进入受管 rules（不会被面板当成本服务的规则去编辑/校验），但会被原样留档，
  // 保存时写回文件——这样与其它部署共用一份配置时也不会静默关掉别人的告警。
  const loaded = await loadAlertConfig();
  assert.equal('l4-canary-ready-for-approval' in loaded.rules, false, '不受管规则不进入 rules');
  assert.deepEqual(loaded.preservedRules['l4-canary-ready-for-approval'], {
    enabled: true,
    severity: 'warning',
  });
});

test('共用配置文件：不认识的规则键与旧键原样保留、往返不丢', async () => {
  const foreign = { enabled: true, severity: 'critical', threshold: 7 };
  // 旧键的取值会被合并进已知规则 agent-model-target-degraded，因此必须是 schema 合法字段
  // （severity 不是可配项——写成 severity 会让整份配置校验失败并回落到默认值）。
  const legacy = { enabled: true, threshold: 1, criticalThreshold: 2 };
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: null,
        global: { enabled: true },
        notification: {},
        synthetic: {},
        logSignatures: {},
        rules: {
          'l4-canary-ready-for-approval': foreign,
          'moss-model-target-degraded': legacy,
          'api-5xx-spike': { enabled: false },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const loaded = await loadAlertConfig();
  // 两条外部规则被原样留档；已知键照常管理。
  assert.deepEqual(loaded.preservedRules['l4-canary-ready-for-approval'], foreign);
  assert.deepEqual(loaded.preservedRules['moss-model-target-degraded'], legacy);
  assert.equal(loaded.rules['api-5xx-spike'].enabled, false);
  // 旧键的**取值**同时迁移到新键（既有行为），但旧键本身不会被搬走。
  assert.equal(loaded.rules['agent-model-target-degraded'].threshold, legacy.threshold);
  assert.equal(
    loaded.rules['agent-model-target-degraded'].criticalThreshold,
    legacy.criticalThreshold,
  );

  // 面板公开视图如实列出「不归本面板管」的规则键。
  // 旧键不在其中：它对应一条本面板**能编辑**的规则（改动会写到旧键上），
  // 报成「别人管理的规则」会让运维以为这条规则不归面板管。
  const { toPublicAlertConfig } = await import('./alert-config.js');
  assert.deepEqual(toPublicAlertConfig(loaded).unmanagedRuleKeys, [
    'l4-canary-ready-for-approval',
  ]);

  // 保存后：文件里两条外部规则仍在（值不变），且不出现内部字段 preservedRules。
  await saveAlertConfig(mergeAndValidateAlertConfig(loaded, { global: { cooldownMinutes: 11 } }));
  const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(onDisk.rules['l4-canary-ready-for-approval'], foreign);
  assert.deepEqual(onDisk.rules['moss-model-target-degraded'], legacy);
  assert.equal('preservedRules' in onDisk, false, '不应把内部字段写到磁盘');
  assert.equal(onDisk.global.cooldownMinutes, 11, '本次修改照常生效');

  // 再读一遍仍然一致（往返闭合）。
  const reloaded = await loadAlertConfig();
  assert.deepEqual(reloaded.preservedRules['l4-canary-ready-for-approval'], foreign);
  assert.equal(reloaded.global.cooldownMinutes, 11);
});

test('全新安装（无配置文件）不产生 preservedRules', async () => {
  const fresh = await loadAlertConfig();
  assert.deepEqual(fresh.preservedRules, {});
  const { toPublicAlertConfig } = await import('./alert-config.js');
  assert.deepEqual(toPublicAlertConfig(fresh).unmanagedRuleKeys, []);
});
