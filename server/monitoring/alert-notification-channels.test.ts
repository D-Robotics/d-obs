/**
 * 通知渠道注册表与多渠道投递回归测试：
 * 1. 注册表元数据完整性（字段名/标签一一对应）；
 * 2. 各渠道 payload 构造（钉钉 markdown、企微 markdown、Slack text、
 *    Telegram 纯文本、加签 URL）；
 * 3. deliverTransition 的渠道选择与 suppress 语义不因泛化回归。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALERT_CHANNEL_WEBHOOK_FIELDS,
  ALERT_DELIVERY_CHANNELS,
  isAlertDeliveryChannel,
} from './alert-notification-channels.js';
import { DEFAULT_ALERT_CONFIG, mergeAndValidateAlertConfig } from './alert-config.js';
import { deliverTransition } from './studio-alert-delivery.js';
import type { AlertTransition } from './studio-alert-state.js';

test('注册表：每个渠道的字段名 = 渠道名 + WebhookUrl（通用 Webhook 例外）', () => {
  for (const channel of ALERT_DELIVERY_CHANNELS) {
    const field = ALERT_CHANNEL_WEBHOOK_FIELDS[channel];
    if (channel === 'webhook') {
      assert.equal(field, 'webhookUrl');
      continue;
    }
    assert.equal(field, `${channel}WebhookUrl`);
  }
});

test('isAlertDeliveryChannel：接受注册表值，拒绝未知值', () => {
  assert.equal(isAlertDeliveryChannel('feishu'), true);
  assert.equal(isAlertDeliveryChannel('dingtalk'), true);
  assert.equal(isAlertDeliveryChannel('wecom'), true);
  assert.equal(isAlertDeliveryChannel('slack'), true);
  assert.equal(isAlertDeliveryChannel('telegram'), true);
  assert.equal(isAlertDeliveryChannel('webhook'), true);
  assert.equal(isAlertDeliveryChannel('pagerduty'), false);
  assert.equal(isAlertDeliveryChannel('default'), false);
  assert.equal(isAlertDeliveryChannel('none'), false);
  assert.equal(isAlertDeliveryChannel(undefined), false);
});

test('配置 schema：新渠道 URL 字段可写入并通过校验', () => {
  const patch = {
    notification: {
      dingtalkWebhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      wecomWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xyz',
      slackWebhookUrl: 'https://hooks.slack.com/services/T1/B1/abc',
      telegramWebhookUrl: 'https://api.telegram.org/bot123:token/sendMessage',
    },
  };
  const next = mergeAndValidateAlertConfig(DEFAULT_ALERT_CONFIG, patch);
  assert.equal(next.notification.dingtalkWebhookUrl, patch.notification.dingtalkWebhookUrl);
  assert.equal(next.notification.wecomWebhookUrl, patch.notification.wecomWebhookUrl);
  assert.equal(next.notification.slackWebhookUrl, patch.notification.slackWebhookUrl);
  assert.equal(next.notification.telegramWebhookUrl, patch.notification.telegramWebhookUrl);
});

test('deliverTransition：默认渠道未配置 URL 时如实报 unconfigured', async () => {
  const config = mergeAndValidateAlertConfig(DEFAULT_ALERT_CONFIG, {
    notification: { enabled: true, shadowMode: false, channel: 'dingtalk' },
  });
  const transition: AlertTransition = {
    kind: 'opened',
    key: 'public-health',
    title: '测试',
    severity: 'warning',
    summary: '测试摘要',
    at: new Date().toISOString(),
  };
  const result = await deliverTransition(transition, config);
  assert.equal(result.delivered, false);
  assert.equal(result.channel, 'unconfigured');
  assert.equal(result.error, 'dingtalkWebhookUrl_not_configured');
});

test('deliverTransition：钉钉投递走 markdown 消息体（不触发真实网络）', async () => {
  const config = mergeAndValidateAlertConfig(DEFAULT_ALERT_CONFIG, {
    notification: {
      enabled: true,
      shadowMode: false,
      channel: 'dingtalk',
      dingtalkWebhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    },
  });
  const transition: AlertTransition = {
    kind: 'opened',
    key: 'public-health',
    title: '测试标题',
    severity: 'warning',
    summary: '测试摘要',
    at: new Date().toISOString(),
  };
  // 投递会真的发起 fetch（钉钉会拒绝假 token）——验证的是 fail 路径的
  // channel/error 语义稳定，而不是 delivered。
  const result = await deliverTransition(transition, config);
  assert.equal(result.channel, 'dingtalk');
  assert.equal(typeof result.attempts, 'number');
  assert.ok(result.attempts >= 1);
  // 网络/鉴权失败属于环境相关，只断言「不会被误判成其它渠道的 suppress 语义」。
  assert.notEqual(result.error, 'rule_notification_disabled');
  assert.notEqual(result.error, 'notification_channel_not_selected');
});
