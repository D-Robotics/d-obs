/**
 * 桌面 / 无直连中心库形态的**遥测 HTTP 上报**客户端（对话归档 + run 打标 + scope 隔离 trace batch）。
 *
 * 背景（2026-07-17）：增长看板的「对话总量 / 成功率 / DAU」「run 总量 / 任务成功率」只由**配了
 * RDK_CHAT_CREDITS_DB_URL 且能直连中心 PG 的进程**（web-cloud 服务端）写库。桌面内嵌服务器没有直连库
 * （中心 PG 只在服务器本机 SSH 隧道后、不公网），故桌面对话/run 从不进中心表 → 看板只统计到网页版。
 *
 * 本模块把桌面产生的对话/run **经中心 HTTP API + 登录 ccSid** 回传中心库，与计费 central-http-client.ts
 * 走同一条已在生产跑通的 desktop→central 通道（同 baseUrl RDK_CREDITS_CENTRAL_URL、同 x-rdk-sso-session
 * 鉴权）。中心侧 telemetry-ingest-routes.ts 以 SSO 会话解析属主（绝不信 body 的 userId），落
 * insertConversationTurnCentral / insertAgentRunCentral / ingestStudioTraceBatch。
 *
 * 纪律：
 *  - 旁路、fire-and-forget，**任何失败都不得影响对话/run 主链路**（吞错、有限重试、短超时）。
 *  - 单用户桌面先写 0600 本地 outbox 再上传；多用户 web-self-host 不落共享文件，保留即时 HTTP 旁路。
 *  - 与直连库**互斥**：仅当本进程 isCentralTelemetryConfigured()=false 时才由 store 改道到这里，web-cloud
 *    永远直连、绝不 HTTP 上报 → 不会双计。
 *  - 正文含用户对话内容：**强制 https**（localhost 例外）传输，明文 http 不上报（避免内容/凭据明文外泄），
 *    与 managed-agent-credential.ts 的 centralTransportOkForCredentials 同一安全默认。
 *  - kill-switch：RDK_TELEMETRY_REPORT_ENABLED=0/false/off 关闭上报（默认开）。
 *  - dispatcher 显式声明专属、**绝不代理**（不隐式继承模型 provider 的全局 undici 单例，见
 *    central-http-client.ts 同款踩坑）。
 */
import { Agent as UndiciAgent } from 'undici';
import type { ClientErrorTelemetryEvent } from '../shared/client-error-telemetry.js';
import type { StudioTraceBatch } from '../shared/studio-observability.js';
import type { ConversationTurnCentralRow } from './central-telemetry-store.js';
import type { AgentRunRecordCentralRow } from './central-run-telemetry-store.js';
import { resolveStudioDeploymentProfile } from './studio-deployment.js';
import {
  enqueueCentralTelemetry,
  flushCentralTelemetryOutbox,
  type CentralTelemetryOutboxItem,
} from './central-telemetry-outbox.js';
import {
  enqueueStudioTraceBatch,
  flushStudioTraceOutbox,
  type TraceBatchOutboxItem,
  type TraceBatchUploadAck,
} from './observability/trace-batch-outbox.js';

let directDispatcher: UndiciAgent | null = null;
function getDirectDispatcher(): UndiciAgent {
  if (!directDispatcher) directDispatcher = new UndiciAgent();
  return directDispatcher;
}

const REPORT_TIMEOUT_MS = 6000;
const REPORT_RETRY_DELAYS_MS = [0, 350, 1200];

function reportEnabled(): boolean {
  const raw = String(process.env.RDK_TELEMETRY_REPORT_ENABLED ?? '')
    .trim()
    .toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

function centralBaseUrl(): string {
  return String(process.env.RDK_CREDITS_CENTRAL_URL || '')
    .trim()
    .replace(/\/$/, '');
}

/** 含用户正文,强制 https;localhost/环回允许 http 供本地联调。 */
function transportOk(base: string): boolean {
  if (/^https:\/\//i.test(base)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
}

const logErr = String(process.env.RDK_CENTRAL_TELEMETRY_LOG_ERRORS ?? '').trim() === '1';
function warn(scope: string, err: unknown): void {
  if (!logErr) return;
  console.warn(`[telemetry-report] ${scope} 上报失败:`, err instanceof Error ? err.message : err);
}

/** 懒加载取当前用户中心会话 ccSid(避免与 credits 模块的静态循环依赖);无 / 过期 → null。 */
async function resolveCcSid(ssoUserId: string): Promise<string | null> {
  try {
    const mod = await import('./credits/managed-agent-credential.js');
    return mod.getCentralCreditsSession(ssoUserId);
  } catch {
    return null;
  }
}

/**
 * A relay failure is intentionally richer than the legacy boolean return:
 * callers need to distinguish a dead central session from a transient network
 * outage so an expired session does not turn into an endless retry loop.
 * `reportClientErrorsToCentral` below remains the boolean compatibility seam.
 */
export interface CentralTelemetryReportResult {
  ok: boolean;
  /** The central account session was rejected or is no longer available. */
  authExpired: boolean;
  /** Whether a caller may reasonably retry the same payload later. */
  retryable: boolean;
  /** HTTP status when the central service returned one. */
  status?: number;
  reason?: 'auth_expired' | 'unavailable';
}

type CentralTelemetryPostResult = Pick<
  CentralTelemetryReportResult,
  'ok' | 'authExpired' | 'retryable' | 'status'
>;

async function postJsonResult(
  base: string,
  sid: string,
  path: string,
  payload: unknown,
): Promise<CentralTelemetryPostResult> {
  for (let attempt = 0; attempt < REPORT_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = REPORT_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
    try {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'x-rdk-sso-session': sid, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        dispatcher: getDirectDispatcher(),
        // undici 与全局 fetch 的 dispatcher 类型 skew(见 central-http-client.ts 注释),经 unknown 中转。
      } as unknown as RequestInit & { dispatcher: UndiciAgent });
      if (r.ok) {
        return { ok: true, authExpired: false, retryable: false, status: r.status };
      }
      // 认证/参数错误重试没有意义；503/429/5xx 可能是短暂中心抖动。
      const authExpired = r.status === 401 || r.status === 403;
      const retryable = !authExpired && (r.status === 408 || r.status === 429 || r.status >= 500);
      if (!retryable || attempt === REPORT_RETRY_DELAYS_MS.length - 1) {
        warn(path, new Error(`HTTP ${r.status}`));
        return { ok: false, authExpired, retryable, status: r.status };
      }
    } catch (err) {
      if (attempt === REPORT_RETRY_DELAYS_MS.length - 1) {
        warn(path, err);
        return { ok: false, authExpired: false, retryable: true };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, authExpired: false, retryable: true };
}

/** Preserve the pre-existing fire-and-forget callers' boolean contract. */
async function postJson(
  base: string,
  sid: string,
  path: string,
  payload: unknown,
): Promise<boolean> {
  return (await postJsonResult(base, sid, path, payload)).ok;
}

/** Best-effort convergence after the central account service rejects a ccSid. */
async function invalidateCentralSessionBestEffort(ssoUserId: string): Promise<void> {
  try {
    const mod = await import('./credits/managed-agent-credential.js');
    mod.invalidateCentralSession(ssoUserId);
  } catch {
    // Telemetry must never turn a credential-cache cleanup failure into a user-visible error.
  }
}

async function postTraceBatch(
  base: string,
  sid: string,
  payload: StudioTraceBatch,
): Promise<TraceBatchUploadAck> {
  for (let attempt = 0; attempt < REPORT_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = REPORT_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/api/telemetry/trace-batches`, {
        method: 'POST',
        headers: { 'x-rdk-sso-session': sid, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        dispatcher: getDirectDispatcher(),
      } as unknown as RequestInit & { dispatcher: UndiciAgent });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
        return { ok: true, status: body?.status === 'duplicate' ? 'duplicate' : 'accepted' };
      }
      const retryable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === REPORT_RETRY_DELAYS_MS.length - 1) {
        warn('/api/telemetry/trace-batches', new Error(`HTTP ${response.status}`));
        return { ok: false, retryable };
      }
    } catch (error) {
      if (attempt === REPORT_RETRY_DELAYS_MS.length - 1) {
        warn('/api/telemetry/trace-batches', error);
        return { ok: false, retryable: true };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, retryable: true };
}

function desktopOutboxEnabled(): boolean {
  const profile = resolveStudioDeploymentProfile();
  return profile === 'desktop' || profile === 'local-dev';
}

function traceOutboxEnabled(): boolean {
  const profile = resolveStudioDeploymentProfile();
  return profile === 'desktop' || profile === 'local-dev' || profile === 'web-self-host';
}

async function uploadTraceOutboxItem(
  base: string,
  item: TraceBatchOutboxItem,
): Promise<TraceBatchUploadAck> {
  // Resolve a fresh credential for this exact account partition. Never share a
  // cached credential across an account switch.
  const sid = await resolveCcSid(item.accountScopeId);
  if (!sid) return { ok: false, retryable: true };
  return postTraceBatch(base, sid, item.batch);
}

async function uploadOutboxItem(base: string, item: CentralTelemetryOutboxItem): Promise<boolean> {
  const sid = await resolveCcSid(item.ssoUserId);
  if (!sid) return false;
  const path = item.kind === 'conversation' ? '/api/telemetry/conversation' : '/api/telemetry/run';
  return postJson(base, sid, path, item.payload);
}

async function flushPendingDesktopTelemetry(): Promise<void> {
  if (!desktopOutboxEnabled()) return;
  const base = centralBaseUrl();
  if (!base || !transportOk(base)) return;
  await flushCentralTelemetryOutbox((item) => uploadOutboxItem(base, item));
}

async function queueAndFlushTelemetry(
  base: string,
  kind: 'conversation' | 'run',
  ssoUserId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!desktopOutboxEnabled()) {
    const sid = await resolveCcSid(ssoUserId);
    if (!sid) return;
    await postJson(
      base,
      sid,
      kind === 'conversation' ? '/api/telemetry/conversation' : '/api/telemetry/run',
      payload,
    );
    return;
  }
  await enqueueCentralTelemetry({ kind, ssoUserId, payload });
  await flushPendingDesktopTelemetry();
}

const startupOutboxFlush = setTimeout(() => {
  void flushPendingDesktopTelemetry().catch(() => undefined);
}, 1500);
startupOutboxFlush.unref?.();

/** 前置门:开关 + baseUrl + https 传输 + 有 ssoUserId。返回 {base,ssoUserId} 或 null(不上报)。 */
function preflight(
  ssoUserId: string | null | undefined,
): { base: string; ssoUserId: string } | null {
  if (!reportEnabled()) return null;
  const base = centralBaseUrl();
  if (!base || !transportOk(base)) return null;
  const uid = String(ssoUserId ?? '').trim();
  if (!uid) return null; // 未登录 / 无账号 → 无从鉴权,不上报(匿名本就无法归属)
  return { base, ssoUserId: uid };
}

/** 对话归档上报(desktop→central)。fire-and-forget,吞尽错误。 */
export function reportConversationTurnToCentral(row: ConversationTurnCentralRow): void {
  const pf = preflight(row.sso_user_id);
  if (!pf) return;
  void (async () => {
    try {
      await queueAndFlushTelemetry(pf.base, 'conversation', pf.ssoUserId, { ...row });
    } catch (err) {
      warn('conversation', err);
    }
  })();
}

/** run 打标上报(desktop→central)。fire-and-forget,吞尽错误。 */
export function reportAgentRunToCentral(row: AgentRunRecordCentralRow): void {
  const pf = preflight(row.sso_user_id);
  if (!pf) return;
  void (async () => {
    try {
      await queueAndFlushTelemetry(pf.base, 'run', pf.ssoUserId, { ...row });
    } catch (err) {
      warn('run', err);
    }
  })();
}

/**
 * 客户端错误批量上报(desktop/self-host→central)。
 *
 * 与对话/run 的 fire-and-forget 不同，这里返回明确成功状态：浏览器只有在中心确认接收后才会
 * 从本地持久队列删除，网络或会话暂时不可用时留待下次启动/online 事件重试。
 */
export async function reportClientErrorsToCentralResult(
  ssoUserId: string,
  events: ClientErrorTelemetryEvent[],
): Promise<CentralTelemetryReportResult> {
  const pf = preflight(ssoUserId);
  if (events.length === 0) {
    return {
      ok: false,
      authExpired: false,
      retryable: false,
      reason: 'unavailable',
    };
  }
  if (!pf) {
    // Keep the historical best-effort behavior for disabled/missing central
    // configuration. The local caller may retry after configuration heals.
    return { ok: false, authExpired: false, retryable: true, reason: 'unavailable' };
  }
  try {
    const sid = await resolveCcSid(pf.ssoUserId);
    // A local SSO identity without a central ccSid cannot ever authenticate a
    // relay request. Report it as an auth expiry so the browser keeps the
    // queue for the next login without scheduling a 30-second outage retry.
    if (!sid) {
      return {
        ok: false,
        authExpired: true,
        retryable: false,
        reason: 'auth_expired',
      };
    }
    const result = await postJsonResult(pf.base, sid, '/api/telemetry/client-errors', { events });
    if (result.authExpired) {
      await invalidateCentralSessionBestEffort(pf.ssoUserId);
    }
    return {
      ...result,
      ...(result.authExpired
        ? { reason: 'auth_expired' as const }
        : { reason: 'unavailable' as const }),
    };
  } catch (err) {
    warn('client-errors', err);
    return { ok: false, authExpired: false, retryable: true, reason: 'unavailable' };
  }
}

/** Legacy boolean API retained for existing telemetry producers and tests. */
export async function reportClientErrorsToCentral(
  ssoUserId: string,
  events: ClientErrorTelemetryEvent[],
): Promise<boolean> {
  return (await reportClientErrorsToCentralResult(ssoUserId, events)).ok;
}

/** Replay-safe MOC trace transport for desktop and remote self-hosted profiles. */
export async function reportStudioTraceBatchToCentral(
  ssoUserId: string,
  batch: StudioTraceBatch,
): Promise<boolean> {
  if (
    batch.spans.some(
      (span) =>
        span.resource.surface === 'local-dev' ||
        span.resource.deploymentEnvironment === 'development',
    )
  ) {
    return false;
  }
  const pf = preflight(ssoUserId);
  if (!pf || batch.spans.length === 0) return false;
  try {
    if (!traceOutboxEnabled()) {
      const sid = await resolveCcSid(pf.ssoUserId);
      if (!sid) return false;
      return (await postTraceBatch(pf.base, sid, batch)).ok;
    }
    const queued = await enqueueStudioTraceBatch({
      accountScopeId: pf.ssoUserId,
      batch,
    });
    if (!queued.queued) return false;
    const flushed = await flushStudioTraceOutbox({
      accountScopeId: pf.ssoUserId,
      upload: (item) => uploadTraceOutboxItem(pf.base, item),
    });
    // Local durability is the browser acknowledgement boundary. A central
    // outage leaves the accepted batch in the account-partitioned retry queue.
    void flushed;
    return true;
  } catch (error) {
    warn('trace-batches', error);
    return false;
  }
}
