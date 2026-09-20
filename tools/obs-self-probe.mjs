#!/usr/bin/env node
/**
 * d-obs 自身外部看门狗探针：部署在**异于 d-obs 主机**的机器上，回答
 * "d-obs 平台自己挂了，谁知道？"这个问题。
 *
 * 与 rl-platform-probe 的关键区别：d-obs 是告警平台本身，它挂掉时
 * "上报给 d-obs" 这条路也断了。所以本探针有两条独立通道：
 *   1) 仪表盘通道（可选）：d-obs 可达时，把检查结果按平台探针协议上报，
 *      复用 external-health / external-entry-asset 两个白名单 key；
 *   2) 旁路通知通道（关键）：连续 N 次失败后，直接把告警 POST 到
 *      飞书/通用 Webhook —— 不经过 d-obs，平台死亡也能叫醒人；恢复后发恢复通知。
 *
 * 检查项：
 *   external-health       GET <target>/status            200 即可（公开状态页）
 *   external-entry-asset  GET <target>/ops-observability 200 且 >1KB（工作台入口）
 *
 * 防抖：状态文件记录连击；失败达到 FAILS_TO_ALERT 告警一次，持续失败按
 * NOTIFY_COOLDOWN_MINUTES 限频重发；连续 OKS_TO_RECOVER 次成功后发恢复。
 *
 * 用法（异机，systemd timer 每分钟驱动，单次执行）：
 *   RDK_OBS_SELF_PROBE_TARGET=https://obs.example.com \
 *   RDK_OBS_SELF_PROBE_STATE_FILE=/var/lib/d-obs-self-probe/state.json \
 *   RDK_OBS_SELF_PROBE_FEISHU_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx' \
 *   [RDK_OBS_SELF_PROBE_FEISHU_SIGN_SECRET=...] \
 *   [RDK_OBS_SELF_PROBE_WEBHOOK_URL=https://hooks.example/xyz] \
 *   [RDK_OBS_SELF_PROBE_REPORT_URL=https://obs.example.com  RDK_OBS_SELF_PROBE_TOKEN_FILE=/path/token] \
 *   node tools/obs-self-probe.mjs
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import path from 'node:path';

const TARGET = String(process.env.RDK_OBS_SELF_PROBE_TARGET || '').trim();
const REPORT_URL = String(process.env.RDK_OBS_SELF_PROBE_REPORT_URL || '').trim();
const TOKEN_FILE = String(process.env.RDK_OBS_SELF_PROBE_TOKEN_FILE || '').trim();
const STATE_FILE =
  String(process.env.RDK_OBS_SELF_PROBE_STATE_FILE || '').trim() || '/var/lib/d-obs-self-probe/state.json';
const FAILS_TO_ALERT = Math.max(1, Number(process.env.RDK_OBS_SELF_PROBE_FAILS_TO_ALERT) || 2);
const OKS_TO_RECOVER = Math.max(1, Number(process.env.RDK_OBS_SELF_PROBE_OKS_TO_RECOVER) || 2);
const COOLDOWN_MS = Math.max(0, Number(process.env.RDK_OBS_SELF_PROBE_NOTIFY_COOLDOWN_MINUTES) || 30) * 60_000;
const FEISHU_WEBHOOK = String(process.env.RDK_OBS_SELF_PROBE_FEISHU_WEBHOOK || '').trim();
const FEISHU_SECRET = String(process.env.RDK_OBS_SELF_PROBE_FEISHU_SIGN_SECRET || '').trim();
const GENERIC_WEBHOOK = String(process.env.RDK_OBS_SELF_PROBE_WEBHOOK_URL || '').trim();
const TIMEOUT_MS = Math.max(1000, Number(process.env.RDK_OBS_SELF_PROBE_TIMEOUT_MS) || 8000);

async function timedGet(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, ms: Date.now() - started, bytes: body.length };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, bytes: 0, error: String(error?.cause || error).slice(0, 120) };
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { consecutiveFails: 0, consecutiveOks: 0, alerted: false, lastNotifyAt: 0 };
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

function feishuBody(text) {
  // 飞书自定义机器人签名：timestamp + "\n" + secret 作为 HMAC-SHA256 的 key，消息体为空。
  const body = { msg_type: 'text', content: { text } };
  if (FEISHU_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = timestamp;
    body.sign = createHmac('sha256', `${timestamp}\n${FEISHU_SECRET}`).update('').digest('base64');
  }
  return body;
}

async function notify(text) {
  const results = [];
  if (FEISHU_WEBHOOK) {
    results.push(
      fetch(FEISHU_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(feishuBody(text)),
      }).then((r) => `feishu=${r.status}`).catch((e) => `feishu=ERR:${String(e).slice(0, 60)}`),
    );
  }
  if (GENERIC_WEBHOOK) {
    results.push(
      fetch(GENERIC_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'd-obs-self-probe', text, at: new Date().toISOString() }),
      }).then((r) => `webhook=${r.status}`).catch((e) => `webhook=ERR:${String(e).slice(0, 60)}`),
    );
  }
  return results.length ? (await Promise.all(results)).join(' ') : 'no-channel-configured';
}

async function main() {
  if (!TARGET) {
    console.error('[obs-self-probe] 缺少 RDK_OBS_SELF_PROBE_TARGET');
    process.exitCode = 2;
    return;
  }
  if (!FEISHU_WEBHOOK && !GENERIC_WEBHOOK) {
    console.error('[obs-self-probe] 警告：未配置任何旁路通知渠道（飞书/通用 Webhook），d-obs 宕机将无人被叫醒');
  }

  const status = await timedGet(`${TARGET}/status`);
  const workbench = await timedGet(`${TARGET}/ops-observability`);
  const healthy = status.ok && workbench.ok && workbench.bytes > 1024;

  const state = await readState();
  const now = Date.now();
  if (healthy) {
    state.consecutiveFails = 0;
    state.consecutiveOks += 1;
  } else {
    state.consecutiveFails += 1;
    state.consecutiveOks = 0;
  }

  // 1) 旁路通知（不依赖 d-obs）
  let notifyResult = '';
  if (!healthy && state.consecutiveFails >= FAILS_TO_ALERT) {
    const detail = `status=${status.status || 'unreachable'} workbench=${workbench.status || 'unreachable'} (${TARGET})`;
    if (!state.alerted) {
      notifyResult = await notify(`[d-obs 看门狗] d-obs 连续 ${state.consecutiveFails} 轮不可达，疑似宕机：${detail}`);
      state.alerted = true;
      state.lastNotifyAt = now;
    } else if (now - (state.lastNotifyAt || 0) >= COOLDOWN_MS) {
      notifyResult = await notify(`[d-obs 看门狗] d-obs 仍不可达（持续提醒）：${detail}`);
      state.lastNotifyAt = now;
    }
  } else if (healthy && state.alerted && state.consecutiveOks >= OKS_TO_RECOVER) {
    notifyResult = await notify(`[d-obs 看门狗] d-obs 已恢复（连续 ${state.consecutiveOks} 轮正常）：${TARGET}/status 200`);
    state.alerted = false;
    state.lastNotifyAt = now;
  }

  // 2) 仪表盘通道：d-obs 可达时顺手上报（复用平台探针白名单 key），不可达就跳过。
  let reportStatus = 'skipped';
  if (healthy && REPORT_URL && TOKEN_FILE) {
    try {
      const token = String(await readFile(TOKEN_FILE, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('token not 64-hex');
      const checks = [
        {
          key: 'external-health',
          title: `d-obs 状态页 (${TARGET})`,
          enabled: true,
          ok: status.ok,
          active: !status.ok,
          failures: status.ok ? 0 : 1,
          successes: status.ok ? 1 : 0,
          detail: status.ok ? `/status 200 · ${status.ms}ms` : `/status ${status.status || 'unreachable'}`,
        },
        {
          key: 'external-entry-asset',
          title: `d-obs 工作台入口 (${TARGET})`,
          enabled: true,
          ok: workbench.ok && workbench.bytes > 1024,
          active: !(workbench.ok && workbench.bytes > 1024),
          failures: workbench.ok ? 0 : 1,
          successes: workbench.ok ? 1 : 0,
          detail: workbench.ok ? `工作台 200 · ${(workbench.bytes / 1024).toFixed(1)}KB` : `工作台不可用 · ${workbench.error || workbench.status}`,
        },
      ];
      const response = await fetch(`${REPORT_URL}/api/health/external-probe-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rdk-external-probe-token': token, 'user-agent': 'd-obs-self-probe/1' },
        body: JSON.stringify({ generatedAt: new Date().toISOString(), source: '106.53', checks }),
      });
      reportStatus = String(response.status);
    } catch (error) {
      reportStatus = `ERR:${String(error).slice(0, 60)}`;
    }
  }

  await writeState(state);
  console.log(
    `[obs-self-probe] status=${status.ok ? 'ok' : 'FAIL'} workbench=${workbench.ok ? 'ok' : 'FAIL'} state=${state.alerted ? 'ALERTING' : 'ok'} notify=${notifyResult || '-'} report=${reportStatus}`,
  );
  if (!healthy) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[obs-self-probe] fatal:', error);
  process.exitCode = 1;
});
