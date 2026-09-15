/**
 * 可选：将客户端上报的同一 JSON 体异步转发到你的云端入口（API 网关 / 自建 ingest / 经 Lambda 写 OSS 等）。
 * 失败不影响 200 与本地落盘；仅打 warn 日志。
 *
 * 飞书群「自定义机器人」Webhook：URL 形如
 * https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
 * 默认使用 text 消息体，且鉴权在 URL 路径中，不要带 Bearer；
 * 调用方传入 feishuCard 时改发 interactive 卡片（彩色 header + 结构化内容），签名算法与 text 相同。
 * 若机器人开启了「签名校验」，配置 ANALYTICS_CLOUD_FEISHU_SIGN_SECRET，将按官方算法附带 timestamp、sign。
 * 设置 ANALYTICS_CLOUD_FEISHU_WEBHOOK=1，或 URL 匹配飞书 hook 时自动按飞书格式封装（过长会截断）。
 */
import { createHmac } from 'node:crypto';
const FORWARD_TIMEOUT_MS = 15_000;
/** 飞书自定义机器人 text 单条不宜过大，留余量避免被拒 */
const FEISHU_TEXT_MAX = 18_000;
const FORWARD_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
function parseForwardUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return FORWARD_ALLOWED_PROTOCOLS.has(url.protocol) ? url : null;
    }
    catch {
        return null;
    }
}
function describeForwardUrl(url) {
    return `${url.protocol}//${url.host}`;
}
function stringifyPayload(payload) {
    try {
        return JSON.stringify(payload);
    }
    catch {
        return JSON.stringify({ fallback: String(payload) });
    }
}
function isFeishuBotHookUrl(url) {
    return /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\//i.test(url)
        || /open\.larksuite\.com\/open-apis\/bot\/v2\/hook\//i.test(url);
}
/** 飞书开放平台：sign = BASE64(HMAC_SHA256(签名字符串, secret))，签名字符串 = timestamp + "\\n" + secret */
function feishuBotSign(secret, timestampSec) {
    const stringToSign = `${timestampSec}\n${secret}`;
    return createHmac('sha256', secret).update(stringToSign).digest('base64');
}
function appendFeishuSign(base, signSecret) {
    const sec = String(signSecret ?? '').trim();
    if (sec) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        base.timestamp = timestamp;
        base.sign = feishuBotSign(sec, timestamp);
    }
    return base;
}
function buildFeishuTextBody(payload, signSecret) {
    let raw = typeof payload === 'string' ? payload : stringifyPayload(payload);
    if (raw.length > FEISHU_TEXT_MAX) {
        const omitted = raw.length - FEISHU_TEXT_MAX;
        raw = `${raw.slice(0, FEISHU_TEXT_MAX)}\n…[truncated ${omitted} chars]`;
    }
    return JSON.stringify(appendFeishuSign({ msg_type: 'text', content: { text: raw } }, signSecret));
}
/** 飞书交互卡片：header 模板色 + markdown/按钮元素，告警/恢复/自愈用不同颜色区分。 */
function buildFeishuCardBody(card, signSecret) {
    return JSON.stringify(appendFeishuSign({ msg_type: 'interactive', card }, signSecret));
}
/**
 * 可等待的通用 Webhook 投递。告警 worker 用返回值决定是否更新去重状态；
 * 普通旁路调用仍可使用下方 fire-and-forget 包装。
 */
export async function sendWebhookPayload(url, payload, options) {
    const trimmed = String(url ?? '').trim();
    if (!trimmed)
        return { ok: false, error: 'webhook_not_configured' };
    const parsedUrl = parseForwardUrl(trimmed);
    const logTag = options?.logTag ?? 'analytics';
    if (!parsedUrl) {
        console.warn(`[${logTag}] cloud webhook url ignored: expected http(s) URL`);
        return { ok: false, error: 'invalid_webhook_url' };
    }
    const feishuMode = Boolean(options?.forceFeishuFormat)
        || isFeishuBotHookUrl(parsedUrl.href);
    try {
        const bearerSecret = String(options?.bearerSecret ?? '').trim();
        const feishuSignSecret = String(options?.feishuSignSecret ?? '').trim();
        const headers = { 'Content-Type': 'application/json' };
        let body;
        if (feishuMode) {
            body = options?.feishuCard
                ? buildFeishuCardBody(options.feishuCard, feishuSignSecret || undefined)
                : buildFeishuTextBody(options?.feishuText ?? payload, feishuSignSecret || undefined);
            headers['Content-Type'] = 'application/json; charset=utf-8';
        }
        else {
            if (bearerSecret)
                headers.Authorization = `Bearer ${bearerSecret}`;
            body = stringifyPayload(payload);
        }
        const res = await fetch(parsedUrl.href, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
            console.warn(`[${logTag}] cloud webhook status:`, describeForwardUrl(parsedUrl), res.status, ...(options?.suppressResponseBodyInLogs ? [] : [text.slice(0, 500)]));
            return { ok: false, status: res.status, error: `http_${res.status}` };
        }
        if (feishuMode && text) {
            try {
                const j = JSON.parse(text);
                if (typeof j.code === 'number' && j.code !== 0) {
                    console.warn(`[${logTag}] feishu webhook:`, j.code, j.msg ?? text.slice(0, 200));
                    return { ok: false, status: res.status, error: `feishu_${j.code}` };
                }
            }
            catch {
                /* 非 JSON 则按 HTTP 成功处理 */
            }
        }
        return { ok: true, status: res.status };
    }
    catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[${logTag}] cloud forward failed:`, error);
        return { ok: false, error };
    }
}
/**
 * 通用 HTTP 旁路转发（埋点、对话归档等共用）。飞书 URL 自动走 text + 可选加签。
 */
export function forwardWebhookPayload(url, payload, options) {
    void sendWebhookPayload(url, payload, options);
}
export function forwardAnalyticsCloudWebhook(payload) {
    const url = String(process.env.ANALYTICS_CLOUD_WEBHOOK_URL ?? '').trim();
    if (!url || process.env.ANALYTICS_CLOUD_FORWARD_ENABLED === '0')
        return;
    forwardWebhookPayload(url, payload, {
        bearerSecret: String(process.env.ANALYTICS_CLOUD_WEBHOOK_SECRET ?? '').trim() || undefined,
        feishuSignSecret: String(process.env.ANALYTICS_CLOUD_FEISHU_SIGN_SECRET ?? '').trim() || undefined,
        logTag: 'analytics',
        forceFeishuFormat: process.env.ANALYTICS_CLOUD_FEISHU_WEBHOOK === '1',
    });
}
