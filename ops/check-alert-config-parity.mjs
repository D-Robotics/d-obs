#!/usr/bin/env node
/**
 * 告警配置「面板显示值 vs 线上生效值」一致性体检。
 *
 * 为什么需要它：d-obs 面板展示的是「d-obs 默认值 ⊕ 配置文件」，而线上 worker 用的是
 * 「worker 自己的默认值 ⊕ 同一个文件」。两边默认值一旦有差异，或者某个规则只在某一侧
 * 存在，面板就会显示一个**线上并不生效**的阈值——运维照着面板调参，实际什么都没改。
 * 2026-09-17 就是这么发现 4 条 north-star 规则的取值需要逐项核对（当时两边恰好相同）。
 *
 * 用法（在服务器上跑，两个产物路径按需覆盖）：
 *   node ops/check-alert-config-parity.mjs
 *   DOBS_CONFIG_JS=/opt/d-obs/current/server/monitoring/alert-config.js \
 *   WORKER_CONFIG_JS=/opt/rdstudio-web-opt/current/dist-server/server/monitoring/alert-config.js \
 *     node ops/check-alert-config-parity.mjs
 *
 * 退出码：0 = 逐字段一致；1 = 存在差异（会打印到 stdout）。
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DOBS_CONFIG_JS =
  process.env.DOBS_CONFIG_JS ?? '/opt/d-obs/current/server/monitoring/alert-config.js';
const WORKER_CONFIG_JS =
  process.env.WORKER_CONFIG_JS ??
  '/opt/rdstudio-web-opt/current/dist-server/server/monitoring/alert-config.js';
const CONFIG_FILE =
  process.env.ALERT_CONFIG_FILE ?? '/var/lib/rdstudio-alert-worker/config.json';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'production';

const load = async (p) => import(pathToFileURL(p).href);
const [dobs, worker] = await Promise.all([load(DOBS_CONFIG_JS), load(WORKER_CONFIG_JS)]);
const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));

// 两侧都把「自己的默认值 ⊕ 文件」算成生效配置
const dobsEffective = dobs.normalizeStoredAlertConfig(raw);
const workerEffective = worker.normalizeStoredAlertConfig(raw);

const RULE_FIELDS = [
  'enabled',
  'windowMinutes',
  'minSamples',
  'threshold',
  'criticalThreshold',
  'ratePercent',
  'openAfter',
  'resolveAfter',
  'notificationChannel',
];
const SECTION_FIELDS = {
  global: [
    'enabled',
    'environmentLabel',
    'cooldownMinutes',
    'maxNotificationsPerHour',
    'notifyOnRecovery',
    'remindersEnabled',
    'autoRemediation',
    'remediationCooldownMinutes',
  ],
  notification: ['enabled', 'shadowMode', 'channel', 'minSeverity', 'titlePrefix'],
  synthetic: ['intervalMinutes', 'username', 'sessionIdPrefix'],
};

const problems = [];
const dobsKeys = new Set(Object.keys(dobsEffective.rules));
const workerKeys = new Set(Object.keys(workerEffective.rules));

for (const key of [...dobsKeys].filter((k) => !workerKeys.has(k))) {
  problems.push(`只有 d-obs 知道这条规则（线上不会评估）：${key}`);
}
for (const key of [...workerKeys].filter((k) => !dobsKeys.has(k))) {
  problems.push(`只有 worker 知道这条规则（面板看不到）：${key}`);
}
for (const key of [...dobsKeys].filter((k) => workerKeys.has(k)).sort()) {
  const a = dobsEffective.rules[key] ?? {};
  const b = workerEffective.rules[key] ?? {};
  const diffs = RULE_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f])).map(
    (f) => `${f}: 面板=${JSON.stringify(a[f])} 线上=${JSON.stringify(b[f])}`,
  );
  if (diffs.length) problems.push(`规则取值不一致 ${key} -> ${diffs.join('；')}`);
}
for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
  const a = dobsEffective[section] ?? {};
  const b = workerEffective[section] ?? {};
  const diffs = fields
    .filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))
    .map((f) => `${f}: 面板=${JSON.stringify(a[f])} 线上=${JSON.stringify(b[f])}`);
  if (diffs.length) problems.push(`${section} 不一致 -> ${diffs.join('；')}`);
}

const fileKeys = Object.keys(raw.rules ?? {});
const fileOnly = fileKeys.filter((k) => !dobsKeys.has(k) && !workerKeys.has(k));
console.log(`配置文件        : ${CONFIG_FILE}`);
console.log(`文件里的规则键  : ${fileKeys.length}`);
console.log(`d-obs 生效规则  : ${dobsKeys.size}`);
console.log(`worker 生效规则 : ${workerKeys.size}`);
if (fileOnly.length) {
  console.log(`两边都不认识    : ${fileOnly.join(', ')}（会被原样保留，不参与任何一侧的评估）`);
}
if (problems.length) {
  console.log('\n发现差异：');
  for (const line of problems) console.log(`  - ${line}`);
  process.exitCode = 1;
} else {
  console.log('\n一致：面板显示的每一条规则取值都与线上生效值相同。');
}
