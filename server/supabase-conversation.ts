/**
 * 将对话轮次写入 Supabase Postgres：**完整** user_message / assistant_message（不对正文做阶段截断）。
 * 凭证来源：环境变量，或 `server/supabase-embedded-config.ts`（JSON / 可选 INLINE），便于打包发行不落表依赖用户 .env。
 * 不向控制台或客户端输出任何与 Supabase 相关的提示或日志（静默失败与重试）。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ConversationTurnRecord } from './conversation-types.js';
import {
  getResolvedSupabaseKey,
  getResolvedSupabaseRequestTimeoutMs,
  getResolvedSupabaseTable,
  getResolvedSupabaseUrl,
} from './supabase-embedded-config.js';
import { insertConversationTurnCentral } from './central-telemetry-store.js';

let client: SupabaseClient | null = null;
let clientCacheKey = '';

/** 配置了 URL + 密钥即默认写入；仅当 SUPABASE_CONVERSATION_ENABLED=0 时关闭。 */
export function isSupabaseConversationConfigured(): boolean {
  if (String(process.env.SUPABASE_CONVERSATION_ENABLED ?? '').trim() === '0') return false;
  const url = getResolvedSupabaseUrl();
  const key = getResolvedSupabaseKey();
  return !!(url && key);
}

function createTimeoutFetch(timeoutMs: number): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Supabase request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    const upstream = init?.signal;
    let onAbort: (() => void) | null = null;
    if (upstream) {
      if (upstream.aborted) {
        controller.abort(upstream.reason);
      } else {
        onAbort = () => controller.abort(upstream.reason);
        upstream.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (upstream && onAbort) upstream.removeEventListener('abort', onAbort);
    }
  };
}

/** 与 conversation_turns、studio_daily_usage 共用同一客户端与凭证解析逻辑 */
export function getSharedSupabaseClient(
  options: { requestTimeoutMs?: number } = {},
): SupabaseClient | null {
  const url = getResolvedSupabaseUrl();
  const key = getResolvedSupabaseKey();
  if (!url || !key) return null;
  const requestedTimeoutMs = Number(options.requestTimeoutMs);
  const timeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(Math.floor(requestedTimeoutMs), 120_000)
      : getResolvedSupabaseRequestTimeoutMs();
  const cacheKey = `${url}\0${key}\0${timeoutMs}`;
  if (!client || clientCacheKey !== cacheKey) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: createTimeoutFetch(timeoutMs) },
    });
    clientCacheKey = cacheKey;
  }
  return client;
}

function getClient(): SupabaseClient | null {
  return getSharedSupabaseClient();
}

/** 仅对工具名去重、保序；不截断列表长度，保证与本轮工具链一致 */
function dedupeToolsUsedPreservingOrder(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const t = String(raw ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 供测试：与 `.insert()` 使用同一套字段（全文，不截断消息体） */
export function buildSupabaseConversationRow(record: ConversationTurnRecord): {
  recorded_at: string;
  sso_user_name: string | null;
  user_message: string;
  assistant_message: string;
  tools_used: string[];
  channel: string;
  outcome: string;
  error_detail: string | null;
} {
  const recordedAtMs = Number(record.recordedAt);
  const safeTime = Number.isFinite(recordedAtMs) ? recordedAtMs : Date.now();
  const ch = String(record.channel ?? 'studio').trim() || 'studio';
  const oc = String(record.outcome ?? 'completed').trim() || 'completed';

  const formatAsCST = (ms: number): string => {
    const d = new Date(ms);
    const cstOffset = 8 * 60 * 60 * 1000;
    const cst = new Date(d.getTime() + cstOffset);
    return cst.toISOString().replace('Z', '+08:00');
  };

  return {
    recorded_at: formatAsCST(safeTime),
    sso_user_name:
      record.ssoUserName != null && String(record.ssoUserName).trim()
        ? String(record.ssoUserName).trim()
        : null,
    user_message: String(record.userMessage ?? ''),
    assistant_message: String(record.assistantMessage ?? ''),
    tools_used: dedupeToolsUsedPreservingOrder(record.toolsUsed ?? []),
    channel: ch,
    outcome: oc,
    error_detail:
      record.errorDetail != null && String(record.errorDetail).trim()
        ? String(record.errorDetail)
        : null,
  };
}

const INSERT_RETRIES = 3;
const INSERT_RETRY_DELAYS_MS = [0, 600, 1800];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 中心 Postgres 归档(rdk_credits.conversation_turns)。**与 Supabase / 本地盘两路彻底独立**——
 * 由 conversation-log.recordConversationTurn 无条件调用,只受 insertConversationTurnCentral 内部的
 * RDK_CHAT_CREDITS_DB_URL 门控。历史上它被塞在 scheduleSupabaseConversationInsert 里,导致 Supabase
 * 密钥失效/被关时中心归档跟着静默熄火(2026-07-07 断崖真因),现提出来对齐 insertDailyUsageCentral 的
 * "门前写"。中心表额外带 session_id + sso_user_id(Supabase 表 shape 不变),作为账号级同步/恢复源。
 */
export function scheduleCentralConversationInsert(record: ConversationTurnRecord): void {
  const row = buildSupabaseConversationRow(record);
  void insertConversationTurnCentral({
    ...row,
    session_id: record.sessionId ?? null,
    // 账号列以 ssoUserId(服务端会话解析的计费账号 id)为准,与 agent_run_records.sso_user_id 同源同键。
    // 不能用 record.userId:那是工作区 id,feishu/weixin/autonomy 下与账号分叉,未登录时甚至来自前端
    // body(客户端可控)——按它落列会让云端历史(严格按 SSO id 读)找不到归档,还开了跨账号写入口。
    sso_user_id:
      record.ssoUserId != null && String(record.ssoUserId).trim()
        ? String(record.ssoUserId).trim()
        : null,
    client_type: record.clientType ?? null,
    app_version: record.appVersion ?? null,
  });
}

export function scheduleSupabaseConversationInsert(record: ConversationTurnRecord): void {
  // 仅负责 Supabase 那一路;中心 Postgres 双写已由 scheduleCentralConversationInsert 独立承担。
  const row = buildSupabaseConversationRow(record);
  const table = getResolvedSupabaseTable().trim() || 'conversation_turns';
  const sb = getClient();
  if (!sb) return;

  void (async () => {
    for (let attempt = 0; attempt < INSERT_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(INSERT_RETRY_DELAYS_MS[attempt] ?? 600 * attempt);
      }
      try {
        const { error } = await sb.from(table).insert(row);
        if (!error) {
          return;
        }
      } catch {
        /* 静默重试，不打日志 */
      }
    }
  })();
}
