/**
 * Agent run 结构化打标 —— 写入中心 Postgres 独立表 `agent_run_records`(与 credits 共用同一个
 * rdk_credits 库,见 RDK_CHAT_CREDITS_DB_URL)。不复用 conversation_turns(该表是"不 ALTER"的既定
 * 契约,见 supabase/migrations 注释),这里另起一张关系型表,承载 run 级证据链:谁、哪个设备、
 * 跑了什么工具(有序)、成功/失败分类、耗时、token 用量——供北极星指标(任务成功率、月度完成
 * 真机任务真实用户数)统计使用。
 *
 * 与 central-telemetry-store.ts 同款懒加载 pg pool 模式,中心写入旁路失败不影响 run 主链路。
 */
import { resolveStudioDeploymentProfile } from './studio-deployment.js';
import { reportAgentRunToCentral } from './central-telemetry-http-client.js';
import { recordOpsEvent } from './monitoring/ops-event-store.js';
import { resolveStudioTraceStoreEnvironment } from './observability/studio-trace-store.js';
import {
  buildTelemetrySourceId,
  clientReportedStudioVersion,
  normalizeStudioTelemetryVersion,
} from './telemetry-identity.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

export function isAgentRunTelemetryConfigured(): boolean {
  return centralDbUrl().length > 0;
}

let _poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  if (!centralDbUrl()) {
    throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置:中心遥测库不可用');
  }
  if (!_poolReady) {
    _poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 4 });
    })().catch((err) => {
      _poolReady = null;
      throw err;
    });
  }
  return _poolReady;
}

const logErr = String(process.env.RDK_CENTRAL_TELEMETRY_LOG_ERRORS ?? '').trim() === '1';

function warnOnce(scope: string, err: unknown): void {
  if (!logErr) return;
  console.warn(
    `[central-run-telemetry] ${scope} insert failed:`,
    err instanceof Error ? err.message : err,
  );
}

/** 幂等建表,进程内只跑一次(缓存 Promise,与 pool() 同款单例模式)。 */
let _schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      await p.query(`
        create table if not exists public.agent_run_records (
          id uuid primary key default gen_random_uuid(),
          source_id text,
          environment text not null default 'production',
          run_id text not null,
          sso_user_id text null,
          device_id text null,
          device_model text null,
          channel text not null default 'studio',
          outcome text not null,
          error_category text null,
          error_detail text null,
          tool_sequence text[] not null default '{}'::text[],
          tool_call_count int not null default 0,
          started_at timestamptz not null,
          completed_at timestamptz not null,
          elapsed_ms int not null default 0,
          first_event_ms int null,
          first_text_ms int null,
          prompt_tokens int null,
          completion_tokens int null,
          model text null,
          created_at timestamptz not null default now()
        );
      `);
      // 旧生产库可能由早期版本创建，CREATE TABLE IF NOT EXISTS 不会补齐新增列。
      await p.query(
        `alter table public.agent_run_records add column if not exists error_category text`,
      );
      await p.query(
        `alter table public.agent_run_records add column if not exists error_detail text`,
      );
      // 统一可观测性按服务端环境关联；旧中心库由 DEFAULT='production' 安全补齐。
      await p.query(
        `alter table public.agent_run_records add column if not exists environment text not null default 'production'`,
      );
      await p.query(`alter table public.agent_run_records add column if not exists source_id text`);
      await p.query(`alter table public.agent_run_records add column if not exists app_version text`);
      await p.query(`drop index if exists public.agent_run_records_source_id_uidx`);
      await p.query(
        `create unique index if not exists agent_run_records_source_environment_uidx
           on public.agent_run_records (source_id, environment) where source_id is not null`,
      );
      // 自愈加列:自动重试次数(重试可观测性,支撑「成功率剩余损耗归因」)。旧库幂等补列。
      await p.query(
        `alter table public.agent_run_records add column if not exists retry_count int not null default 0`,
      );
      await p.query(
        `alter table public.agent_run_records add column if not exists first_event_ms int`,
      );
      await p.query(
        `alter table public.agent_run_records add column if not exists first_text_ms int`,
      );
      await p.query(
        `create index if not exists agent_run_records_run_id_idx on public.agent_run_records (run_id)`,
      );
      await p.query(
        `create index if not exists agent_run_records_sso_user_environment_started_idx on public.agent_run_records (sso_user_id, environment, started_at desc)`,
      );
      await p.query(
        `create index if not exists agent_run_records_device_model_outcome_idx on public.agent_run_records (device_model, outcome)`,
      );
      await p.query(
        `create index if not exists agent_run_records_started_at_idx on public.agent_run_records (started_at desc)`,
      );
      // 来源维度:web-cloud / desktop / miniapp / web-self-host / local-dev。老行 null。
      await p.query(
        `alter table public.agent_run_records add column if not exists client_type text`,
      );
      await p.query(
        `create index if not exists agent_run_records_client_type_idx on public.agent_run_records (client_type) where client_type is not null`,
      );
      // 运维事件按需关联会话上下文；只存稳定会话 id，不复制聊天正文。
      await p.query(
        `alter table public.agent_run_records add column if not exists session_id text`,
      );
      await p.query(
        `create index if not exists agent_run_records_session_id_idx on public.agent_run_records (session_id) where session_id is not null`,
      );
    })().catch((err) => {
      _schemaReady = null;
      throw err;
    });
  }
  return _schemaReady;
}

export type AgentRunRecordCentralRow = {
  source_id?: string | null;
  run_id: string;
  sso_user_id: string | null;
  device_id: string | null;
  device_model: string | null;
  channel: string;
  outcome: string;
  error_category: string | null;
  error_detail: string | null;
  tool_sequence: string[];
  tool_call_count: number;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  first_event_ms?: number | null;
  first_text_ms?: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model: string | null;
  retry_count?: number;
  /** RDK Studio 客户端会话 id；仅用于运营权限下精确关联对话归档。 */
  session_id?: string | null;
  /** 仅传输本轮失败工具名（可重复表示失败次数）；不含参数、结果或错误正文。 */
  failed_tool_sequence?: string[];
  /** 低敏失败类别；不传工具参数、命令、结果或原始错误正文。 */
  failed_tool_events?: Array<{
    toolName: string;
    category: string;
    toolCallId?: string | null;
    attempt?: number;
    code?: string | null;
    detail?: string;
  }>;
  /** 来源形态:web-cloud / desktop / miniapp / web-self-host / local-dev。缺省按本进程部署形态兜底。 */
  client_type?: string | null;
  app_version?: string | null;
};

/**
 * 中心 run 打标。**自路由**:本进程直连中心库 → 直插;否则(桌面等无库形态)→ 经 HTTP 上报到 web-cloud
 * 中心(reportAgentRunToCentral)。两路互斥,不双计。静默失败、有限重试(run 生命周期旁路,绝不拖慢/中断主链路)。
 */
export async function insertAgentRunCentral(row: AgentRunRecordCentralRow): Promise<boolean> {
  const clientType = (row.client_type ?? '').toString().trim() || resolveStudioDeploymentProfile();
  // Environment is authoritative process state. Never accept a caller-provided destination.
  const environment = resolveStudioTraceStoreEnvironment();
  const appVersion = normalizeStudioTelemetryVersion(row.app_version);
  // 只信客户端自报版本：ops 事件不允许回落服务端环境版本，避免把云端版本记到桌面事件上。
  const clientVersion = clientReportedStudioVersion(row.app_version);
  if (!isAgentRunTelemetryConfigured()) {
    reportAgentRunToCentral({ ...row, client_type: clientType, app_version: appVersion });
    // 旁路已安排，但本进程没有本地落库；HTTP 摄取路由据此回 503，避免伪装成已写入中心。
    return false;
  }
  try {
    const p = await pool();
    await ensureSchema(p);
    const sourceId =
      String(row.source_id ?? '').trim() ||
      buildTelemetrySourceId('run', [row.run_id, row.sso_user_id, row.session_id, row.started_at]);
    const insertResult = await p.query(
      `insert into public.agent_run_records
         (source_id, environment, run_id, sso_user_id, device_id, device_model, channel, outcome, error_category, error_detail,
          tool_sequence, tool_call_count, started_at, completed_at, elapsed_ms, first_event_ms, first_text_ms,
          prompt_tokens, completion_tokens, model, retry_count, client_type, session_id, app_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
       on conflict (source_id, environment) where source_id is not null do nothing`,
      [
        sourceId,
        environment,
        row.run_id,
        row.sso_user_id,
        row.device_id,
        row.device_model,
        row.channel,
        row.outcome,
        row.error_category,
        row.error_detail,
        row.tool_sequence,
        row.tool_call_count,
        row.started_at,
        row.completed_at,
        row.elapsed_ms,
        row.first_event_ms == null ? null : Math.max(0, Math.floor(row.first_event_ms)),
        row.first_text_ms == null ? null : Math.max(0, Math.floor(row.first_text_ms)),
        row.prompt_tokens,
        row.completion_tokens,
        row.model,
        Math.max(0, Math.floor(row.retry_count ?? 0)),
        clientType || null,
        String(row.session_id ?? '').trim() || null,
        appVersion,
      ],
    );
    // A replay is already represented; do not emit duplicate tool-error events.
    if (insertResult.rowCount === 0) return true;
    const failedToolEvents = row.failed_tool_events?.length
      ? row.failed_tool_events
      : (row.failed_tool_sequence ?? []).map((toolName, index) => ({
          toolName,
          // 老客户端只报失败工具名、不传错误正文：不能伪造成 execution_failed 污染分类桶。
          category: 'legacy_unclassified',
          toolCallId: null,
          attempt: index + 1,
          code: null,
          detail: '旧版客户端仅上报失败工具名，未传错误正文，无法分类',
        }));
    for (const rawEvent of failedToolEvents) {
      const toolName = String(rawEvent?.toolName ?? '')
        .trim()
        .slice(0, 200);
      if (!toolName) continue;
      const failureCategory =
        String(rawEvent?.category ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '')
          .slice(0, 64) || 'execution_failed';
      const safeDetail = String(rawEvent?.detail ?? '').trim().slice(0, 160);
      const safeCode = String(rawEvent?.code ?? '').trim().slice(0, 32);
      const safeToolCallId = String(rawEvent?.toolCallId ?? '').trim().slice(0, 200);
      const attempt = Math.max(1, Math.floor(Number(rawEvent?.attempt) || 1));
      void recordOpsEvent({
        component: 'agent-tool',
        eventCode: 'tool_call',
        outcome: 'error',
        severityHint: 'warning',
        safeSummary: `工具 ${toolName} 调用失败（${failureCategory}）`,
        fingerprintParts: [toolName, failureCategory],
        metadata: {
          tool_name: toolName,
          failure_category: failureCategory,
          failure_detail: safeDetail || null,
          error_code: safeCode || null,
          tool_call_id: safeToolCallId || null,
          attempt,
          retry_count: Math.max(0, Math.floor(row.retry_count ?? 0)),
          channel: String(row.channel ?? '').slice(0, 64),
          client_type: clientType.slice(0, 32),
          environment,
          run_id: String(row.run_id ?? '').slice(0, 120),
          ...(clientVersion ? { app_version: clientVersion } : {}),
        },
        correlation: {
          userId: row.sso_user_id,
          sessionId: row.session_id,
          runId: row.run_id,
          deviceId: row.device_id,
          deviceModel: row.device_model,
          clientType,
          channel: row.channel,
          environment,
          appVersion: clientVersion,
        },
        occurredAt: row.completed_at,
      });
    }
    return true;
  } catch (err) {
    warnOnce('agent_run_records', err);
    return false;
  }
}
