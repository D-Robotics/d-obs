#!/usr/bin/env node
/**
 * 强化学习（sim2real）平台外部探针：把平台健康状态上报给 d-obs。
 *
 * 检查两项（dns/tls 对本机服务不适用，上报为停用）：
 *   external-health       GET /healthz 200
 *   external-entry-asset  GET / 入口页可加载
 *
 * 用法（平台自带探针）：
 *   RDK_RL_PROBE_TARGET=http://127.0.0.1:18102 \
 *   RDK_RL_PROBE_REPORT_URL=http://127.0.0.1:47110 \
 *   RDK_RL_PROBE_TOKEN_FILE=/path/to/64-hex-token \
 *   node tools/rl-platform-probe.mjs
 *
 * 租户模式（团队接入）：token 来自租户注册响应的 probeToken，请求头改用
 *   x-rdk-tenant-probe-token：
 *   RDK_RL_PROBE_TOKEN_FILE=/path/to/tenant-token \
 *   RDK_RL_PROBE_AS_TENANT=1 \
 *   node tools/rl-platform-probe.mjs
 *
 * 契约：source 固定 '106.53'（探针身份标识）；4 个 check key 必须齐全；
 * token 为 64 位 hex。持续运行时由调用方（systemd timer / cron）驱动，
 * 本脚本单次执行一次上报。
 */
import { readFile } from 'node:fs/promises';

const TARGET = String(process.env.RDK_RL_PROBE_TARGET || '').trim() || 'http://127.0.0.1:18102';
const REPORT_URL = String(process.env.RDK_RL_PROBE_REPORT_URL || '').trim() || 'http://127.0.0.1:47110';
const TOKEN_FILE =
  String(process.env.RDK_RL_PROBE_TOKEN_FILE || '').trim() || '/var/lib/rdstudio-alert-worker/external-probe-token';
const TENANT_MODE = String(process.env.RDK_RL_PROBE_AS_TENANT || '').trim() === '1';

async function timedGet(url, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text().catch(() => '');
    return { ok: response.ok, status: response.status, ms: Date.now() - started, bytes: body.length };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, bytes: 0, error: String(error?.cause || error).slice(0, 120) };
  }
}

async function main() {
  const token = String(await readFile(TOKEN_FILE, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    console.error(`[rl-probe] token file ${TOKEN_FILE} is not 64-hex`);
    process.exitCode = 2;
    return;
  }

  const health = await timedGet(`${TARGET}/healthz`);
  const entry = await timedGet(`${TARGET}/`);

  const checks = [
    {
      key: 'external-dns',
      title: 'RL 平台 DNS',
      enabled: false,
      ok: true,
      active: false,
      failures: 0,
      successes: 0,
      detail: '本机直连部署，不适用 DNS 检查',
    },
    {
      key: 'external-tls',
      title: 'RL 平台 TLS',
      enabled: false,
      ok: true,
      active: false,
      failures: 0,
      successes: 0,
      detail: '本机 HTTP 部署，不适用 TLS 检查',
    },
    {
      key: 'external-health',
      title: `RL 平台健康 (${TARGET})`,
      enabled: true,
      ok: health.ok,
      active: !health.ok,
      failures: health.ok ? 0 : 1,
      successes: health.ok ? 1 : 0,
      detail: health.ok
        ? `/healthz 200 · ${health.ms}ms`
        : `/healthz ${health.status || 'unreachable'} · ${health.error || health.ms + 'ms'}`,
    },
    {
      key: 'external-entry-asset',
      title: 'RL 平台入口页',
      enabled: true,
      ok: entry.ok && entry.bytes > 1024,
      active: !(entry.ok && entry.bytes > 1024),
      failures: entry.ok ? 0 : 1,
      successes: entry.ok ? 1 : 0,
      detail: entry.ok ? `入口 200 · ${(entry.bytes / 1024).toFixed(1)}KB` : `入口不可用 · ${entry.error || entry.status}`,
    },
  ];

  const response = await fetch(`${REPORT_URL}/api/health/external-probe-report`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 租户探针用租户 token 头；平台探针沿用原头。同一 64-hex token 格式。
      [TENANT_MODE ? 'x-rdk-tenant-probe-token' : 'x-rdk-external-probe-token']: token,
      'user-agent': 'd-obs-rl-platform-probe/1',
    },
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: '106.53',
      checks,
    }),
  });
  console.log(
    `[rl-probe]${TENANT_MODE ? ' tenant' : ''} healthz=${health.ok ? 'ok' : 'FAIL'} entry=${entry.ok ? 'ok' : 'FAIL'} report=${response.status}`,
  );
  if (!response.ok) {
    console.error('[rl-probe] report rejected:', await response.text().catch(() => ''));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[rl-probe] fatal:', error);
  process.exitCode = 1;
});
