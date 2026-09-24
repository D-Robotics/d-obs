/**
 * 告警投递深链回归：「查看看板」入口（飞书卡按钮 / {{dashboardUrl}} 模板变量 /
 * webhook payload）必须携带 #alert=<key> 深链，看板端解析后直达该策略的告警详情。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AlertConfig } from './alert-config.js';
import {
  alertDetailDeepLink,
  buildFeishuAlertCard,
} from './studio-alert-delivery.js';
import type { AlertTransition } from './studio-alert-state.js';

const config = {
  global: { environmentLabel: 'production / 47110' },
  notification: {
    titlePrefix: 'RDK Studio',
    actionGuide: '查看看板、服务日志与依赖健康状态。',
    dashboardUrl: 'http://127.0.0.1:47110/ops-observability#alerts',
  },
} as unknown as AlertConfig;

const transition: AlertTransition = {
  kind: 'opened',
  key: 'nginx-5xx-log',
  title: 'Nginx 5xx 日志异常',
  severity: 'critical',
  summary: '5 分钟内 Nginx 5xx 18 次（502/503/504 共 15 次）',
  at: '2026-09-24T07:22:03.000Z',
  firstSeenAt: '2026-09-24T07:21:03.000Z',
  failureStreak: 2,
};

function cardActions(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const elements = card.elements as Array<Record<string, unknown>>;
  const action = elements.find((element) => element.tag === 'action') as {
    actions: Array<Record<string, unknown>>;
  };
  return action.actions;
}

test('alertDetailDeepLink：剥离既有锚点后生成 #alert=<key> 深链', () => {
  assert.equal(
    alertDetailDeepLink(config, 'nginx-5xx-log'),
    'http://127.0.0.1:47110/ops-observability#alert=nginx-5xx-log',
  );
});

test('飞书卡「查看看板」按钮携带 #alert=<key> 深链，指向本次告警', () => {
  const card = buildFeishuAlertCard(transition, config);
  const viewButton = cardActions(card).find(
    (button) =>
      (button.text as { content?: string } | undefined)?.content === '查看看板',
  );
  assert.ok(viewButton, '卡片应包含「查看看板」按钮');
  assert.equal(
    viewButton.url,
    'http://127.0.0.1:47110/ops-observability#alert=nginx-5xx-log',
  );
});
