/**
 * 面板保存告警配置的写盘语义。
 *
 * 背景：d-obs 与主站共用同一个告警配置文件（`/var/lib/rdstudio-alert-worker/config.json`），
 * 线上跑告警的 worker 读的就是它。面板展示的是「默认值 ⊕ 文件」，而老实现保存时
 * 直接序列化这份合并结果，于是：
 *   - 一次只改一条规则的保存，会把 d-obs 的**全部**规则键物化进文件 →
 *     worker 开始评估它原本没在评估的规则（通知是开着的，会真的发消息）；
 *   - 文件里由其它系统管理的规则键 / 旧键会被挪动或丢失。
 * 这些测试锁住修复后的语义：以磁盘原文为基准，只写真正改动的字段。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_ALERT_CONFIG,
  alertConfigFileState,
  alertConfigFromFileState,
  applyPanelAlertConfigPatch,
  planAlertConfigWrite,
  toPublicAlertConfig,
} from './alert-config.js';

/** 共用文件的真实形态：部分规则 + 一条未知规则 + 一条旧键 + 未知顶层字段。 */
const SHARED_FILE = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  // 其它部署写的、d-obs 不认识的顶层字段，必须原样保留
  schemaNote: 'managed by rdstudio-alert-worker',
  global: { enabled: true, environmentLabel: 'prod' },
  notification: {
    enabled: true,
    shadowMode: false,
    channel: 'feishu',
    feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
    // 未知的嵌套字段，同样要保留
    customTag: 'keep-me',
  },
  rules: {
    'disk-space': { enabled: true, threshold: 5, criticalThreshold: 10 },
    'l4-shadow-ready-to-observe': { enabled: true, threshold: 1, criticalThreshold: 2 },
    'moss-model-target-degraded': { enabled: true, threshold: 3, criticalThreshold: 6 },
  },
};

async function withConfigFile<T>(
  content: string | null,
  run: (dir: string, file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'd-obs-alert-config-'));
  const file = path.join(dir, 'config.json');
  const previous = process.env.RDK_ALERT_CONFIG_PATH;
  process.env.RDK_ALERT_CONFIG_PATH = file;
  try {
    if (content !== null) await writeFile(file, content, 'utf8');
    return await run(dir, file);
  } finally {
    if (previous === undefined) delete process.env.RDK_ALERT_CONFIG_PATH;
    else process.env.RDK_ALERT_CONFIG_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

test('原样保存（没有任何改动）不碰文件：不写、不备份', async () => {
  const original = `${JSON.stringify(SHARED_FILE, null, 2)}\n`;
  await withConfigFile(original, async (dir, file) => {
    // 模拟面板：它拿到 GET 的公开配置后原样回传
    const fileState = await alertConfigFileState();
    const current = alertConfigFromFileState(fileState);
    const patch = { global: { ...current.global }, rules: { ...current.rules } };
    const result = await applyPanelAlertConfigPatch(patch as never);

    assert.equal(result.changed, false);
    assert.equal(await readFile(file, 'utf8'), original, '文件内容必须一个字节都没变');
    const backups = (await readdir(dir)).filter((name) => name.includes('.bak-'));
    assert.deepEqual(backups, [], '没有改动就不该产生备份');
  });
});

test('改一条规则只写那一条，默认规则不被物化进共用文件', async () => {
  const original = `${JSON.stringify(SHARED_FILE, null, 2)}\n`;
  await withConfigFile(original, async (_dir, file) => {
    const before = await readJson(file);
    const result = await applyPanelAlertConfigPatch({
      rules: { 'disk-space': { enabled: false } },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.plan.changedRuleKeys, ['disk-space']);
    const after = await readJson(file);
    // 关键断言：文件里的规则键集合只能多出「被改的那条」，d-obs 的默认规则一条都不许进来
    const unknownAdded = Object.keys(after.rules).filter((key) => !(key in before.rules));
    assert.deepEqual(unknownAdded, [], '不得新增任何文件里原本没有的规则键');
    assert.equal(after.rules['disk-space'].enabled, false);
    assert.equal(after.rules['disk-space'].threshold, 5, '未提及的字段保持原值');
    // 别人管理的规则与未知字段原样保留
    assert.deepEqual(after.rules['l4-shadow-ready-to-observe'], before.rules['l4-shadow-ready-to-observe']);
    assert.deepEqual(after.rules['moss-model-target-degraded'], before.rules['moss-model-target-degraded']);
    assert.equal(after.schemaNote, 'managed by rdstudio-alert-worker');
    assert.equal(after.notification.customTag, 'keep-me');
    assert.equal(after.notification.feishuWebhookUrl, SHARED_FILE.notification.feishuWebhookUrl);
  });
});

test('文件里只有旧键时，改动写到旧键上（线上 worker 读的是旧键）', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async (_dir, file) => {
    // 面板展示的键是改名后的 agent-model-target-degraded，文件里只有 moss- 旧键
    const result = await applyPanelAlertConfigPatch({
      rules: { 'agent-model-target-degraded': { enabled: false } },
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.plan.changedRuleKeys, ['moss-model-target-degraded']);
    assert.deepEqual(result.plan.aliasedRuleKeys, {
      'agent-model-target-degraded': 'moss-model-target-degraded',
    });
    const after = await readJson(file);
    assert.equal(after.rules['moss-model-target-degraded'].enabled, false, '旧键必须被更新');
    assert.equal(
      after.rules['agent-model-target-degraded'],
      undefined,
      '不得新写一个 worker 不认识的键',
    );
  });
});

test('文件不存在时：有改动才整份写出，没有改动就不建文件', async () => {
  await withConfigFile(null, async (_dir, file) => {
    const fileState = await alertConfigFileState();
    const current = alertConfigFromFileState(fileState);
    const noop = planAlertConfigWrite(fileState, current, current);
    assert.equal(noop.changed, false, '没有改动不该凭空创建配置文件');

    const result = await applyPanelAlertConfigPatch({ global: { environmentLabel: 'staging' } });
    assert.equal(result.changed, true);
    assert.equal(result.plan.fullWrite, true);
    const written = await readJson(file);
    assert.equal(written.global.environmentLabel, 'staging');
    // 首次安装是「物化」语义：整份配置写出来当基准文档
    assert.ok(Object.keys(written.rules).length >= Object.keys(DEFAULT_ALERT_CONFIG.rules).length);
  });
});

test('配置文件损坏时退回安全默认，且保存会整份重写（有备份可回滚）', async () => {
  await withConfigFile('{ this is not json', async (dir, file) => {
    const fileState = await alertConfigFileState();
    assert.equal(fileState.parseable, false);
    const current = alertConfigFromFileState(fileState);
    // 解析失败 → 不吃环境变量 fallback，通知一律关掉（安全默认）
    assert.equal(current.notification.enabled, DEFAULT_ALERT_CONFIG.notification.enabled);

    await applyPanelAlertConfigPatch({ global: { environmentLabel: 'recovered' } });
    const written = await readJson(file);
    assert.equal(written.global.environmentLabel, 'recovered');
    const backups = (await readdir(dir)).filter((name) => name.includes('.bak-'));
    assert.equal(backups.length, 1, '覆写损坏文件前必须留备份');
    assert.equal(await readFile(path.join(dir, backups[0]), 'utf8'), '{ this is not json');
  });
});

test('公开配置如实标注：哪些规则只在默认值里、配置文件是否存在', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async () => {
    const fileState = await alertConfigFileState();
    const config = alertConfigFromFileState(fileState);
    const publicConfig = toPublicAlertConfig(config, { fileRuleKeys: fileState.presentRuleKeys });

    assert.equal(publicConfig.configFilePresent, true);
    // 文件里没有的规则键必须被标出来，否则面板会把「没在评估的规则」显示成已启用
    assert.ok(publicConfig.defaultOnlyRuleKeys.includes('api-5xx-spike'));
    assert.ok(!publicConfig.defaultOnlyRuleKeys.includes('disk-space'));
    assert.ok(
      !publicConfig.defaultOnlyRuleKeys.includes('agent-model-target-degraded'),
      '只有旧键存在时，不能把改名后的键算成「未写入」',
    );
    // 别人管理的规则键如实上报
    assert.deepEqual(publicConfig.unmanagedRuleKeys, ['l4-shadow-ready-to-observe']);
  });

  // 文件不存在：全部规则都只是默认值
  await withConfigFile(null, async () => {
    const fileState = await alertConfigFileState();
    const publicConfig = toPublicAlertConfig(alertConfigFromFileState(fileState), {
      fileRuleKeys: null,
    });
    assert.equal(publicConfig.configFilePresent, false);
    assert.deepEqual(publicConfig.defaultOnlyRuleKeys, []);
  });
});

test('显式固定（pinRuleKeys）：取值与默认值相同也能写进文件，且只加这些键', async () => {
  const original = `${JSON.stringify(SHARED_FILE, null, 2)}\n`;
  await withConfigFile(original, async (_dir, file) => {
    const before = await readJson(file);
    // 不传规则取值，只要求「把 api-5xx-spike 固定进文件」——它的取值此刻等于默认值
    const result = await applyPanelAlertConfigPatch({}, { pinRuleKeys: ['api-5xx-spike'] });

    assert.equal(result.changed, true, '显式固定必须产生写入');
    assert.deepEqual(result.plan.changedRuleKeys, ['api-5xx-spike']);
    assert.deepEqual(result.plan.pinnedRuleKeys, ['api-5xx-spike']);
    const after = await readJson(file);
    const added = Object.keys(after.rules).filter((key) => !(key in before.rules));
    assert.deepEqual(added, ['api-5xx-spike'], '只能新增被固定的那个键');
    // 固定后的取值必须等于面板原来显示的默认值（否则等于偷偷改了线上阈值）
    assert.equal(after.rules['api-5xx-spike'].threshold, DEFAULT_ALERT_CONFIG.rules['api-5xx-spike'].threshold);
    assert.equal(
      after.rules['api-5xx-spike'].criticalThreshold,
      DEFAULT_ALERT_CONFIG.rules['api-5xx-spike'].criticalThreshold,
    );
    // 已经在文件里的键不需要固定，传了也不该产生写入
    const second = await applyPanelAlertConfigPatch({}, { pinRuleKeys: ['api-5xx-spike'] });
    assert.equal(second.changed, false, '重复固定同一个键应当是空操作');
  });
});

test('固定时忽略未知键与文件里已有的键，不误写别的规则', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async (_dir, file) => {
    const before = await readJson(file);
    const result = await applyPanelAlertConfigPatch(
      {},
      { pinRuleKeys: ['disk-space', 'not-a-real-rule', 'moss-model-target-degraded'] },
    );
    assert.equal(result.changed, false, '未知键/已有键（含旧键别名）都不该触发写入');
    const after = await readJson(file);
    assert.deepEqual(Object.keys(after.rules).sort(), Object.keys(before.rules).sort());
  });
});

test('带操作者的真实改动盖上审计戳：首写建归属，再改保留归属并推进修改人', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async (_dir, file) => {
    // 值未变化的保存：不产生审计戳，也不落盘
    const noop = await applyPanelAlertConfigPatch(
      { rules: { 'disk-space': { enabled: true } } },
      { actor: 'ops@example.com' },
    );
    assert.equal(noop.changed, false, '参数没有变化的保存不得产生修改记录');

    const first = await applyPanelAlertConfigPatch(
      { rules: { 'disk-space': { enabled: false } } },
      { actor: 'ops@example.com' },
    );
    assert.equal(first.changed, true);
    const rule = (await readJson(file)).rules['disk-space'];
    assert.equal(rule.createdBy, 'ops@example.com');
    assert.ok(rule.createdAt, '首次落盘必须带创建时间');
    assert.equal(rule.updatedBy, 'ops@example.com');
    assert.equal(rule.updatedAt, rule.createdAt);

    const second = await applyPanelAlertConfigPatch(
      { rules: { 'disk-space': { threshold: 8 } } },
      { actor: 'another@example.com' },
    );
    assert.equal(second.changed, true);
    const rule2 = (await readJson(file)).rules['disk-space'];
    assert.equal(rule2.createdBy, 'ops@example.com', '创建归属保持首任记录在案的写入者');
    assert.equal(rule2.updatedBy, 'another@example.com');
    assert.notEqual(rule2.updatedAt, rule2.createdAt);
  });
});

test('提交方携带的审计字段一律剥除：归属只能由服务端写入', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async (_dir, file) => {
    const result = await applyPanelAlertConfigPatch(
      {
        rules: {
          'disk-space': {
            enabled: false,
            createdBy: 'forged',
            createdAt: '2020-01-01T00:00:00.000Z',
          },
        },
      },
      { actor: 'ops@example.com' },
    );
    assert.equal(result.changed, true);
    const rule = (await readJson(file)).rules['disk-space'];
    assert.equal(rule.createdBy, 'ops@example.com');
    assert.notEqual(rule.createdAt, '2020-01-01T00:00:00.000Z');
  });
});

test('不带操作者的写盘保持旧语义：不写审计字段（存量配置兼容）', async () => {
  await withConfigFile(`${JSON.stringify(SHARED_FILE, null, 2)}\n`, async (_dir, file) => {
    await applyPanelAlertConfigPatch({ rules: { 'disk-space': { enabled: false } } });
    const rule = (await readJson(file)).rules['disk-space'];
    assert.equal(rule.createdBy, undefined);
    assert.equal(rule.createdAt, undefined);
    assert.equal(rule.updatedBy, undefined);
    assert.equal(rule.updatedAt, undefined);
  });
});
