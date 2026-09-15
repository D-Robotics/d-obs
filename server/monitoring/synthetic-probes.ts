/**
 * 登录 → AI 对话 → 只读工具调用的真实业务拨测。
 *
 * 默认关闭；启用前必须配置专用 canary 账号。每轮会产生两个真实 AI run 并消耗该账号额度，
 * 所以由 worker 按 synthetic.intervalMinutes 调度，而不是每分钟执行。
 */
import type { AlertConfig, AlertRuleKey } from './alert-config.js';
import { runSyntheticDshProbe } from './dsh-synthetic-probe-client.js';
import { syntheticProbeSigningConfigured } from './synthetic-probe-auth.js';
import { sanitizeOpsSummary } from './ops-event-store.js';

export interface SyntheticProbeResult {
  key: Extract<AlertRuleKey, 'synthetic-login' | 'synthetic-ai-chat' | 'synthetic-tool-call'>;
  ok: boolean;
  elapsedMs: number;
  summary: string;
}

function internalBaseUrl(): string {
  const healthUrl =
    String(process.env.RDK_ALERT_INTERNAL_HEALTH_URL ?? '').trim() ||
    'http://127.0.0.1:18090/api/health';
  try {
    const url = new URL(healthUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'http://127.0.0.1:18090';
  }
}

function probeTimeoutMs(config: AlertConfig, key: AlertRuleKey): number {
  const critical = config.rules[key].criticalThreshold;
  return Math.max(5_000, Math.min(120_000, Math.ceil(critical)));
}

async function loginCanary(config: AlertConfig): Promise<{
  result: SyntheticProbeResult;
  sessionId: string;
}> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${internalBaseUrl()}/api/sso/direct/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'rdstudio-synthetic-probe/1',
      },
      body: JSON.stringify({
        method: 'account',
        userName: config.synthetic.username,
        password: config.synthetic.password,
      }),
      signal: AbortSignal.timeout(probeTimeoutMs(config, 'synthetic-login')),
    });
    const elapsedMs = Date.now() - startedAt;
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      sessionId?: string;
      error?: string;
    } | null;
    const sessionId = String(data?.sessionId ?? '').trim();
    if (!response.ok || data?.ok !== true || !/^[a-f0-9]{64}$/i.test(sessionId)) {
      return {
        result: {
          key: 'synthetic-login',
          ok: false,
          elapsedMs,
          summary: `真实登录失败：HTTP ${response.status} / ${sanitizeOpsSummary(data?.error, 120) || '无有效会话'}`,
        },
        sessionId: '',
      };
    }
    const verifyResponse = await fetch(`${internalBaseUrl()}/api/sso/me`, {
      method: 'GET',
      headers: {
        'x-rdk-sso-session': sessionId,
        'user-agent': 'rdstudio-synthetic-probe/1',
      },
      signal: AbortSignal.timeout(probeTimeoutMs(config, 'synthetic-login')),
    });
    const verified = (await verifyResponse.json().catch(() => null)) as {
      user?: { id?: string } | null;
      sessionId?: string;
    } | null;
    if (
      !verifyResponse.ok ||
      !verified?.user?.id ||
      String(verified.sessionId ?? '') !== sessionId
    ) {
      return {
        result: {
          key: 'synthetic-login',
          ok: false,
          elapsedMs: Date.now() - startedAt,
          summary: `登录返回会话，但 /api/sso/me 验证失败（HTTP ${verifyResponse.status}）`,
        },
        sessionId: '',
      };
    }
    return {
      result: {
        key: 'synthetic-login',
        ok: true,
        elapsedMs,
        summary: `专用 canary 账号登录成功，${elapsedMs}ms`,
      },
      sessionId,
    };
  } catch (error) {
    return {
      result: {
        key: 'synthetic-login',
        ok: false,
        elapsedMs: Date.now() - startedAt,
        summary: `真实登录请求失败：${sanitizeOpsSummary(error, 180) || 'unknown_error'}`,
      },
      sessionId: '',
    };
  }
}

async function runAgentDshProbe(input: {
  config: AlertConfig;
  sessionId: string;
  key: 'synthetic-ai-chat' | 'synthetic-tool-call';
  message: string;
  expectedTool: string | null;
}): Promise<SyntheticProbeResult> {
  // 签名材料缺失时拒绝执行（fail closed，零耗时）：无签名的 AI/工具拨测会被
  // 服务端拒收，与其发出必然失败的请求，不如在这里直接给出可操作原因。
  if (!syntheticProbeSigningConfigured()) {
    return {
      key: input.key,
      ok: false,
      elapsedMs: 0,
      summary:
        '未配置 RDK_SYNTHETIC_PROBE_HMAC_SECRET（或 SSO_DIRECT_AES_KEY 兜底），已拒绝执行未签名的拨测请求',
    };
  }
  const startedAt = Date.now();
  const timeoutMs = probeTimeoutMs(input.config, input.key);
  try {
    const outcome = await runSyntheticDshProbe({
      baseUrl: internalBaseUrl(),
      ssoSessionId: input.sessionId,
      sessionIdPrefix: `${input.config.synthetic.sessionIdPrefix}-${input.key}`,
      message: input.message,
      expectedTool: input.expectedTool,
      ...(input.expectedTool ? {} : { expectedAssistantMarker: 'RDK_PROBE_OK' }),
      timeoutMs,
    });
    return {
      key: input.key,
      ok: true,
      elapsedMs: outcome.elapsedMs,
      summary: input.expectedTool
        ? `官方 DSH 对话完成且 ${input.expectedTool} 工具调用成功，${outcome.elapsedMs}ms`
        : `官方 DSH 对话完成，${outcome.elapsedMs}ms`,
    };
  } catch (error) {
    return {
      key: input.key,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      summary: `AI 拨测请求失败：${sanitizeOpsSummary(error, 180) || 'unknown_error'}`,
    };
  }
}

export function syntheticCredentialsConfigured(config: AlertConfig): boolean {
  return Boolean(config.synthetic.username.trim() && config.synthetic.password);
}

async function logoutCanary(sessionId: string): Promise<void> {
  await fetch(`${internalBaseUrl()}/api/sso/logout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rdk-sso-session': sessionId,
      'user-agent': 'rdstudio-synthetic-probe/1',
    },
    body: '{}',
    signal: AbortSignal.timeout(8_000),
  }).catch(() => undefined);
}

export async function runSyntheticProbeCycle(config: AlertConfig): Promise<SyntheticProbeResult[]> {
  const login = await loginCanary(config);
  const results = [login.result];
  if (!login.sessionId) {
    if (config.rules['synthetic-ai-chat'].enabled) {
      results.push({
        key: 'synthetic-ai-chat',
        ok: false,
        elapsedMs: 0,
        summary: '前置真实登录失败，未执行 AI 对话拨测',
      });
    }
    if (config.rules['synthetic-tool-call'].enabled) {
      results.push({
        key: 'synthetic-tool-call',
        ok: false,
        elapsedMs: 0,
        summary: '前置真实登录失败，未执行工具调用拨测',
      });
    }
    return results;
  }

  if (config.rules['synthetic-tool-call'].enabled) {
    const transaction = await runAgentDshProbe({
      config,
      sessionId: login.sessionId,
      key: 'synthetic-tool-call',
      message:
        '这是 d-obs 系统拨测。你必须调用只读 device_list_all 工具查看当前设备列表，然后简短结束；不要调用其他工具。',
      expectedTool: 'device_list_all',
    });
    if (config.rules['synthetic-ai-chat'].enabled) {
      results.push({
        ...transaction,
        key: 'synthetic-ai-chat',
        summary: transaction.ok
          ? `AI 对话完成并进入工具执行链，${transaction.elapsedMs}ms`
          : `AI/工具单事务拨测失败：${transaction.summary}`,
      });
    }
    results.push(transaction);
  } else if (config.rules['synthetic-ai-chat'].enabled) {
    results.push(
      await runAgentDshProbe({
        config,
        sessionId: login.sessionId,
        key: 'synthetic-ai-chat',
        message: '这是 d-obs 系统拨测。请不要调用工具，只回复固定字符串 RDK_PROBE_OK。',
        expectedTool: null,
      }),
    );
  }
  await logoutCanary(login.sessionId);
  return results;
}
