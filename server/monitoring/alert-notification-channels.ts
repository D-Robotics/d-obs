/**
 * 通知渠道注册表与各渠道投递封装。
 *
 * 设计目标：新增一个渠道真的只改这一处——往 ALERT_CHANNEL_REGISTRY 里加一个
 * 完整的渠道描述对象（id/文案/字段名/payload 构造/应答校验/发送实现）。
 * 类型联合、字段映射、看板选项、统一投递入口全部从注册表派生，配置 schema、
 * worker 投递编排和看板 UI 都从注册表取元数据。
 */
import { createHmac } from 'node:crypto';

import { sendWebhookPayload } from '../analytics-cloud-forward.js';
import { sanitizeOpsSummary } from './ops-event-store.js';

export type AlertChannelSendResult = { ok: boolean; status?: number; error?: string };

export type AlertChannelSendOptions = {
  message: string;
  title: string;
  secret?: string;
  /** 通用 Webhook 收到的结构化 JSON。 */
  payload: unknown;
  /** 飞书交互卡片；提供时优先于 message。 */
  feishuCard?: Record<string, unknown>;
};

/** 渠道完整定义：新增渠道 = 在 ALERT_CHANNEL_REGISTRY 里加一项。 */
export type AlertChannelDefinition = {
  id: string;
  label: string;
  description: string;
  /** 渠道在 AlertConfig.notification 里的 Webhook URL 字段名。 */
  webhookField: string;
  /** 渠道可选密钥字段名（不使用密钥的渠道省略）。 */
  secretField?: string;
  send(url: string, options: AlertChannelSendOptions): Promise<AlertChannelSendResult>;
};

const CHANNEL_TIMEOUT_MS = 15_000;

/** 企微 markdown 上限 4096 字节；按字节截断并保留多字节字符边界。 */
function truncateUtf8(text: string, maxBytes: number): string {
  let current = text;
  while (Buffer.byteLength(current, 'utf8') > maxBytes) {
    const ratio = maxBytes / Buffer.byteLength(current, 'utf8');
    const cut = Math.max(1, Math.floor(current.length * ratio * 0.95));
    current = current.slice(0, cut);
  }
  return current.length === text.length
    ? current
    : `${current}\n…[已截断 ${text.length - current.length} 字符]`;
}

/** 钉钉加签：sign = urlencode(base64(HMAC_SHA256(`${ts}\n${secret}`, secret)))。 */
function dingtalkSignedUrl(url: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = encodeURIComponent(
    createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
  );
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}timestamp=${timestamp}&sign=${sign}`;
}

/**
 * 钉钉/企微即使业务失败也回 HTTP 200 + errcode!=0；telegram 用 ok 字段。
 * 必须解析应答体，否则失败会被当成成功。
 */
function parseJsonBusinessResult(
  channelId: string,
  status: number,
  body: string,
): AlertChannelSendResult {
  if (!(status >= 200 && status < 300)) {
    return { ok: false, status, error: `http_${status}` };
  }
  if (!body) return { ok: true, status };
  try {
    const parsed = JSON.parse(body) as { errcode?: number; errmsg?: string; ok?: boolean };
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      return { ok: false, status, error: `${channelId}_${parsed.errcode}` };
    }
    if (typeof parsed.ok === 'boolean' && !parsed.ok) {
      return { ok: false, status, error: `${channelId}_rejected` };
    }
    return { ok: true, status };
  } catch {
    // 非 JSON 应答按 HTTP 状态判定（slack 返回纯文本 ok）。
    return { ok: true, status };
  }
}

async function postJsonChannel(
  options: { buildBody(message: string, title: string): string; signUrl?(url: string, secret: string): string },
  url: string,
  send: AlertChannelSendOptions,
  channelId: string,
): Promise<AlertChannelSendResult> {
  const target = send.secret && options.signUrl ? options.signUrl(url, send.secret) : url;
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: options.buildBody(send.message, send.title),
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
    });
    const text = await response.text();
    // 应答体只用于 errcode/ok 判定，不落日志（与飞书路径一致的脱敏纪律）。
    return parseJsonBusinessResult(channelId, response.status, text);
  } catch (error) {
    return { ok: false, error: sanitizeOpsSummary(error, 240) || 'delivery_failed' };
  }
}

/** 渠道 id 元组：与 ALERT_CHANNEL_REGISTRY 的键保持同步（测试兜底）。 */
const ALERT_CHANNEL_IDS = ['feishu', 'dingtalk', 'wecom', 'slack', 'telegram', 'webhook'] as const;

export type AlertDeliveryChannel = (typeof ALERT_CHANNEL_IDS)[number];

export const ALERT_CHANNEL_REGISTRY = {
  feishu: {
    id: 'feishu',
    label: '飞书机器人',
    description: '飞书自定义机器人，支持签名校验与交互卡片',
    webhookField: 'feishuWebhookUrl',
    secretField: 'feishuSignSecret',
    send: async (url, options) => sendWebhookPayload(url, options.payload, {
      feishuSignSecret: options.secret,
      forceFeishuFormat: true,
      feishuText: options.message,
      feishuCard: options.feishuCard,
      logTag: 'alert-worker',
      suppressResponseBodyInLogs: true,
    }),
  },
  dingtalk: {
    id: 'dingtalk',
    label: '钉钉机器人',
    description: '钉钉自定义机器人（markdown 消息），支持加签',
    webhookField: 'dingtalkWebhookUrl',
    secretField: 'dingtalkSignSecret',
    send: (url, options) => postJsonChannel({
      buildBody: (message, title) => JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: truncateUtf8(title, 60), text: truncateUtf8(message, 18_000) },
      }),
      signUrl: dingtalkSignedUrl,
    }, url, options, 'dingtalk'),
  },
  wecom: {
    id: 'wecom',
    label: '企业微信机器人',
    description: '企业微信群机器人（markdown 消息）',
    webhookField: 'wecomWebhookUrl',
    secretField: undefined,
    send: (url, options) => postJsonChannel({
      buildBody: (message) => JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: truncateUtf8(message, 3_800) },
      }),
    }, url, options, 'wecom'),
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    description: 'Slack Incoming Webhook',
    webhookField: 'slackWebhookUrl',
    secretField: undefined,
    send: (url, options) => postJsonChannel({
      buildBody: (message) => JSON.stringify({ text: truncateUtf8(message, 30_000) }),
    }, url, options, 'slack'),
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    description: 'Telegram Bot sendMessage（URL 自带 chat_id 查询参数）',
    webhookField: 'telegramWebhookUrl',
    secretField: undefined,
    send: (url, options) => postJsonChannel({
      // 不用 parse_mode：Telegram 的 Markdown 方言对未转义的 _*[ 很脆弱，
      // 纯文本最稳，模板本身就是多行纯文本。
      buildBody: (message) => JSON.stringify({ text: truncateUtf8(message, 4_000) }),
    }, url, options, 'telegram'),
  },
  webhook: {
    id: 'webhook',
    label: '通用 Webhook',
    description: '向你的告警平台发送结构化 JSON，可附 Bearer',
    webhookField: 'webhookUrl',
    secretField: 'bearerSecret',
    send: async (url, options) => sendWebhookPayload(url, options.payload, {
      bearerSecret: options.secret,
      logTag: 'alert-worker',
      suppressResponseBodyInLogs: true,
    }),
  },
} as const satisfies Record<string, AlertChannelDefinition>;

export const ALERT_DELIVERY_CHANNELS = ALERT_CHANNEL_IDS;

export function isAlertDeliveryChannel(value: unknown): value is AlertDeliveryChannel {
  return (
    typeof value === 'string' &&
    (ALERT_DELIVERY_CHANNELS as readonly string[]).includes(value)
  );
}

/** 渠道在 AlertConfig.notification 里的 Webhook URL 字段名（值保持字面量类型，供 config 索引）。 */
export const ALERT_CHANNEL_WEBHOOK_FIELDS = Object.fromEntries(
  ALERT_DELIVERY_CHANNELS.map((channel) => [channel, ALERT_CHANNEL_REGISTRY[channel].webhookField]),
) as { [K in AlertDeliveryChannel]: (typeof ALERT_CHANNEL_REGISTRY)[K]['webhookField'] };

/** 渠道可选密钥字段名（未列出的渠道不使用密钥）。 */
export const ALERT_CHANNEL_SECRET_FIELDS = Object.fromEntries(
  ALERT_DELIVERY_CHANNELS
    .filter((channel) => ALERT_CHANNEL_REGISTRY[channel].secretField)
    .map((channel) => [channel, ALERT_CHANNEL_REGISTRY[channel].secretField]),
) as {
  [K in AlertDeliveryChannel as (typeof ALERT_CHANNEL_REGISTRY)[K]['secretField'] extends string ? K : never]:
    (typeof ALERT_CHANNEL_REGISTRY)[K]['secretField']
};

export const ALERT_CHANNEL_LABELS = Object.fromEntries(
  ALERT_DELIVERY_CHANNELS.map((channel) => [channel, ALERT_CHANNEL_REGISTRY[channel].label]),
) as Record<AlertDeliveryChannel, string>;

export const ALERT_CHANNEL_DESCRIPTIONS = Object.fromEntries(
  ALERT_DELIVERY_CHANNELS.map((channel) => [channel, ALERT_CHANNEL_REGISTRY[channel].description]),
) as Record<AlertDeliveryChannel, string>;

/** 看板渠道选择器用的选项（顺序即展示顺序）。 */
export function alertChannelOptions(): Array<{
  value: AlertDeliveryChannel;
  label: string;
  description: string;
}> {
  return ALERT_DELIVERY_CHANNELS.map((channel) => ({
    value: channel,
    label: ALERT_CHANNEL_LABELS[channel],
    description: ALERT_CHANNEL_DESCRIPTIONS[channel],
  }));
}

/**
 * 统一渠道投递入口：所有渠道都走注册表里的 send 实现。
 * feishu/webhook 复用 analytics-cloud-forward 的成熟路径（加签、卡片、Bearer），
 * 其余渠道在本模块的 postJsonChannel 专用封装。
 */
export async function sendAlertChannelPayload(
  channel: AlertDeliveryChannel,
  url: string,
  options: AlertChannelSendOptions,
): Promise<AlertChannelSendResult> {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return { ok: false, error: 'webhook_not_configured' };
  return ALERT_CHANNEL_REGISTRY[channel].send(trimmed, options);
}
