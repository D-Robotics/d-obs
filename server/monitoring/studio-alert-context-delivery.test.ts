import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeishuAlertCard, alertDetailDeepLink, recordIncident, recordIncidentSnapshots } from './studio-alert-delivery.js';
import { reconcileAlertState, type AlertObservation, type AlertTransition } from './studio-alert-state.js';
import type { AlertEvidence } from './studio-alert-evidence-types.js';
import type { AlertConfig } from './alert-config.js';
import { configureOpsObservabilityPoolForTest } from './observability-store.js';

const evidence: AlertEvidence = {
  windowStart: '2026-10-15T09:33:57.000Z', windowEnd: '2026-10-15T09:43:57.000Z',
  eventCount: 6, runCount: 2, totalGroups: 1, applicability: 'business',
  groups: [{ accountId: 'sample-user', appVersion: '1.4.6', clientType: 'desktop', module: '设备文件传输', failureCount: 6, runCount: 2 }],
  samples: [],
};
const config = {
  global: { environmentLabel: 'production' },
  notification: { titlePrefix: 'RDK Studio', dashboardUrl: 'https://example.test/dobs/ops-observability#alerts', actionGuide: '查看详情' },
} as unknown as AlertConfig;
const transition: AlertTransition = {
  key: 'tool-failure-repeat', kind: 'opened', title: '工具调用连续失败', severity: 'warning',
  summary: '2 个 run（6 次失败）', at: evidence.windowEnd, evidence,
};
const content = (card: Record<string, unknown>) => JSON.stringify(card);

test('通知卡片携带同一窗口的账号、版本、客户端、功能模块及真实计数', () => {
  const body = content(buildFeishuAlertCard(transition, config));
  for (const word of ['sample-user', '1.4.6', '桌面客户端', '设备文件传输', 'SSO', '版本', '客户端', '2', '6']) assert.ok(body.includes(word), word);
  assert.ok(body.includes('at=2026-10-15T09%3A43%3A57.000Z'));
});

test('多账号或版本分别展示，卡片有界截断且保留完整影响范围提示', () => {
  const groups = Array.from({length: 8}, (_, i) => ({...evidence.groups[0]!, accountId: `sample-${i}`, appVersion: `1.4.${i}`}));
  const body = content(buildFeishuAlertCard({...transition, evidence: {...evidence, totalGroups: 12, groups}}, config));
  assert.ok(body.includes('sample-0'));
  assert.ok(body.includes('sample-3'));
  assert.ok(!body.includes('sample-7'));
  assert.ok(body.includes('12'));
});

test('缺报与基础设施维度明确区分，遥测字段不能注入飞书markdown', () => {
  const missing = {...evidence.groups[0]!, accountId: null, appVersion: null, clientType: null};
  assert.ok(content(buildFeishuAlertCard({...transition, evidence: {...evidence, groups: [missing]}}, config)).includes('未上报'));
  const infra = content(buildFeishuAlertCard({...transition, evidence: {...evidence, applicability: 'infrastructure', groups: [], totalGroups: 0}}, config));
  assert.ok(infra.includes('不适用'));
  const hostile = content(buildFeishuAlertCard({...transition, evidence: {...evidence, groups: [{...missing, accountId: '[点击](https://evil.test)<at id=all>所有人</at>'}]}}, config));
  assert.ok(!hostile.includes('<at'));
  assert.ok(!hostile.includes('[点击](https://evil.test)'));
});

test('带时间的深链保持历史窗口，旧的不带时间调用兼容', () => {
  assert.equal(alertDetailDeepLink(config, transition.key), 'https://example.test/dobs/ops-observability#alert=tool-failure-repeat');
  assert.equal(alertDetailDeepLink(config, transition.key, transition.at), 'https://example.test/dobs/ops-observability#alert=tool-failure-repeat&at=2026-10-15T09%3A43%3A57.000Z');
});

test('快照保存失败仍有核心事实但不承诺不存在的历史深链', () => {
  const body = content(buildFeishuAlertCard({...transition, evidenceUnavailable: true}, config));
  assert.ok(body.includes('sample-user'));
  assert.ok(body.includes('历史证据未保存'));
  assert.ok(!body.includes('&at='));
});

test('状态转换携带故障证据，恢复使用故障窗口，新事故不沿用旧账号', () => {
  const obs: AlertObservation = {key: transition.key, title: transition.title, severity: 'warning', summary: transition.summary, unhealthy: true, openAfter: 1, resolveAfter: 1, evidence};
  const opened = reconcileAlertState({version: 1, keys: {}}, [obs], new Date(transition.at));
  assert.deepEqual(opened.transitions[0]?.evidence, evidence);
  const resolved = reconcileAlertState(opened.state, [{...obs, unhealthy: false, evidence: {...evidence, groups: [], eventCount: 0}}], new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual(resolved.transitions[0]?.evidence, evidence);
  const reopened = reconcileAlertState(resolved.state, [{...obs, evidence: undefined}], new Date('2026-10-15T10:05:00Z'));
  assert.equal(reopened.transitions[0]?.evidence, undefined);
});

test('事故重开在两条落表路径重置首次发生时间，继续中的事故不重置', async () => {
  const sql: string[] = [];
  const p = {query: async (s: string) => { sql.push(s); return {rows: []}; }, end: async () => {}};
  configureOpsObservabilityPoolForTest(p);
  try {
  await recordIncident(p, transition, false);
  await recordIncidentSnapshots(p, [{key: transition.key, title: transition.title, severity: 'warning', summary: transition.summary, unhealthy: true}], {version: 1, keys: {[transition.key]: {active: true,notified: false,failureStreak: 2,successStreak: 0,firstSeenAt: transition.at}}}, transition.at);
  for (const q of sql.filter(s => s.includes('on conflict (alert_key)'))) {
    assert.match(q, /first_seen_at\s*=\s*case when public\.studio_alert_incidents\.status = 'resolved'/);
    assert.match(q, /then excluded\.first_seen_at else public\.studio_alert_incidents\.first_seen_at end/);
  }
  } finally { configureOpsObservabilityPoolForTest(null); }
});

test('未达到Pending门槛即恢复后，新一轮事故使用新的首次失败时间', () => {
  const obs: AlertObservation = {key: transition.key, title: transition.title, severity: 'warning', summary: transition.summary, unhealthy: true, openAfter: 2, resolveAfter: 1, evidence};
  let result = reconcileAlertState({version: 1, keys: {}}, [obs], new Date(transition.at));
  result = reconcileAlertState(result.state, [{...obs, unhealthy: false}], new Date('2026-10-15T10:00:00Z'));
  result = reconcileAlertState(result.state, [obs], new Date('2026-10-15T10:05:00Z'));
  result = reconcileAlertState(result.state, [obs], new Date('2026-10-15T10:06:00Z'));
  assert.equal(result.transitions[0]?.firstSeenAt, '2026-10-15T10:05:00.000Z');
});
