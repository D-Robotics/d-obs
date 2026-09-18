/**
 * 通知渠道注册表与各渠道投递封装。
 *
 * 设计目标：新增一个渠道只改这一处——注册表（字段名/文案/校验）+ payload 构造 +
 * 应答校验；配置 schema、worker 投递编排和看板 UI 都从注册表取元数据，不再各自
 * 硬编码 feishu/webhook 二选一。
 */
import { createHmac } from 'node:crypto';

import { sendWebhookPayload } from '../analytics-cloud-forward.js';
import { sanitizeOpsSummary } from './ops-event-store.js';

export const ALERT_DELIVERY_CHANNELS = [
  'feishu',
  'dingtalk',
  'wecom',
  'slack',
  'telegram',
  'webhook',
] as const;

export type AlertDeliveryChannel = (typeof ALERT_DELIVERY_CHANNELS)[number];

export function isAlertDeliveryChannel(value: unknown): value is AlertDeliveryChannel {
  return (
    typeof value === 'string' &&
    (ALERT_DELIVERY_CHANNELS as readonly string[]).includes(value)
  );
}

/** 渠道在 AlertConfig.notification 里的 Webhook URL 字段名。 */
export const ALERT_CHANNEL_WEBHOOK_FIELDS = {
  feishu: 'feishuWebhookUrl',
  dingtalk: 'dingtalkWebhookUrl',
  wecom: 'wecomWebhookUrl',
  slack: 'slackWebhookUrl',
  telegram: 'telegramWebhookUrl',
  webhook: 'webhookUrl',
} as const satisfies Record<AlertDeliveryChannel, string>;

/** 渠道可选密钥字段名（未列出的渠道不使用密钥）。 */
export const ALERT_CHANNEL_SECRET_FIELDS = {
  feishu: 'feishuSignSecret',
  dingtalk: 'dingtalkSignSecret',
  webhook: 'bearerSecret',
} as const satisfies Partial<Record<AlertDeliveryChannel, string>>;

export const ALERT_CHANNEL_LABELS: Record<AlertDeliveryChannel, string> = {
  feishu: '飞书机器人',
  dingtalk: '钉钉机器人',
  wecom: '企业微信机器人',
  slack: 'Slack',
  telegram: 'Telegram',
  webhook: '通用 Webhook',
};

export const ALERT_CHANNEL_DESCRIPTIONS: Record<AlertDeliveryChannel, string> = {
  feishu: '飞书自定义机器人，支持签名校验与交互卡片',
  dingtalk: '钉钉自定义机器人（markdown 消息），支持加签',
  wecom: '企业微信群机器人（markdown 消息）',
  slack: 'Slack Incoming Webhook',
  telegram: 'Telegram Bot sendMessage（URL 自带 chat_id 查询参数）',
  webhook: '向你的告警平台发送结构化 JSON，可附 Bearer',
};

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

export type AlertChannelSendResult = { ok: boolean; status?: number; error?: string };

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

function channelMessageBody(
  channel: 'dingtalk' | 'wecom' | 'slack' | 'telegram',
  message: string,
  title: string,
): string {
  switch (channel) {
    case 'dingtalk':
      return JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: truncateUtf8(title, 60), text: truncateUtf8(message, 18_000) },
      });
    case 'wecom':
      return JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: truncateUtf8(message, 3_800) },
      });
    case 'slack':
      return JSON.stringify({ text: truncateUtf8(message, 30_000) });
    case 'telegram':
      // 不用 parse_mode：Telegram 的 Markdown 方言对未转义的 _*[ 很脆弱，
      // 纯文本最稳，模板本身就是多行纯文本。
      return JSON.stringify({ text: truncateUtf8(message, 4_000) });
  }
}

/**
 * 钉钉/企微即使业务失败也回 HTTP 200 + errcode!=0；telegram 用 ok 字段。
 * 必须解析应答体，否则失败会被当成成功。
 */
function parseChannelResponse(
  channel: 'dingtalk' | 'wecom' | 'slack' | 'telegram',
  status: number,
  body: string,
): AlertChannelSendResult {
  if (!(status >= 200 && status < 300)) {
    return { ok: false, status, error: `http_${status}` };
  }
  if (channel === 'slack') return { ok: true, status };
  if (!body) return { ok: true, status };
  try {
    const parsed = JSON.parse(body) as { errcode?: number; errmsg?: string; ok?: boolean };
    if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
      return { ok: false, status, error: `${channel}_${parsed.errcode}` };
    }
    if (typeof parsed.ok === 'boolean' && !parsed.ok) {
      return { ok: false, status, error: `${channel}_rejected` };
    }
    return { ok: true, status };
  } catch {
    // 非 JSON 应答按 HTTP 状态判定（slack 返回纯文本 ok）。
    return { ok: true, status };
  }
}

async function postChannelMessage(
  channel: 'dingtalk' | 'wecom' | 'slack' | 'telegram',
  url: string,
  options: { message: string; title: string; secret?: string },
): Promise<AlertChannelSendResult> {
  const target =
    channel === 'dingtalk' && options.secret ? dingtalkSignedUrl(url, options.secret) : url;
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: channelMessageBody(channel, options.message, options.title),
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
    });
    const text = await response.text();
    // 应答体只用于 errcode/ok 判定，不落日志（与飞书路径一致的脱敏纪律）。
    return parseChannelResponse(channel, response.status, text);
  } catch (error) {
    return { ok: false, error: sanitizeOpsSummary(error, 240) || 'delivery_failed' };
  }
}

/**
 * 统一渠道投递入口：feishu/webhook 复用 analytics-cloud-forward 的成熟路径
 * （加签、卡片、Bearer），钉钉/企微/Slack/Telegram 在本模块专用封装。
 */
export async function sendAlertChannelPayload(
  channel: AlertDeliveryChannel,
  url: string,
  options: {
    message: string;
    title: string;
    secret?: string;
    /** 通用 Webhook 收到的结构化 JSON。 */
    payload: unknown;
    /** 飞书交互卡片；提供时优先于 message。 */
    feishuCard?: Record<string, unknown>;
  },
): Promise<AlertChannelSendResult> {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return { ok: false, error: 'webhook_not_configured' };
  if (channel === 'feishu') {
    return sendWebhookPayload(trimmed, options.payload, {
      feishuSignSecret: options.secret,
      forceFeishuFormat: true,
      feishuText: options.message,
      feishuCard: options.feishuCard,
      logTag: 'alert-worker',
      suppressResponseBodyInLogs: true,
    });
  }
  if (channel === 'webhook') {
    return sendWebhookPayload(trimmed, options.payload, {
      bearerSecret: options.secret,
      logTag: 'alert-worker',
      suppressResponseBodyInLogs: true,
    });
  }
  return postChannelMessage(channel, trimmed, options);
}
