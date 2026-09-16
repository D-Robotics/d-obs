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

test('未知规则键不会被备份机制掩盖：主文件仍按 schema 归一（记录当前行为）', async () => {
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
  // 当前行为：load 只按已知键重建 rules，未知键在读取阶段即被丢弃（因此**不要**把
  // d-obs 指向别的部署正在用的配置文件后随意保存）。本用例把该行为固定下来，避免
  // 将来悄悄变化；真要共用文件需先让 schema 透传未知键。
  const loaded = await loadAlertConfig();
  assert.equal('l4-canary-ready-for-approval' in loaded.rules, false);
});
