/**
 * 对话归档 / 日活 PV / SSO 登录审计 / 反馈(赞踩) —— 写入中心 Postgres(与 credits 共用同一个
 * rdk_credits 库,见 RDK_CHAT_CREDITS_DB_URL,表 conversation_turns / studio_daily_usage /
 * chat_feedback,前两张 schema 对齐 `supabase/migrations/2026-05-08-*.sql`)。
 *
 * 定位:Supabase→Postgres 迁移(见 docs/db-migration-supabase-to-postgres.md)的双写路径。与
 * server/supabase-conversation.ts 等三个 Supabase 写入点各自独立、互不阻塞——本模块写入失败
 * 不影响 Supabase 那一路,反之亦然。待双写观察确认一致后,通过现有 SUPABASE_*_ENABLED=0
 * 关闭 Supabase 那一路即可完成切换,不需要再改代码。
 *
 * pg 走懒加载(optionalDependency),与 credits/central-credit-store.ts 一致——未配置
 * RDK_CHAT_CREDITS_DB_URL 时本模块不可用、调用即返回 false,不影响桌面默认路径。
 */
import { resolveStudioDeploymentProfile } from './studio-deployment.js';
import { reportConversationTurnToCentral } from './central-telemetry-http-client.js';
import { buildTelemetrySourceId, normalizeStudioTelemetryVersion, } from './telemetry-identity.js';
function centralDbUrl() {
    return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}
export function isCentralTelemetryConfigured() {
    return centralDbUrl().length > 0;
}
let _poolReady = null;
async function pool() {
    if (!centralDbUrl()) {
        throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置:中心遥测库不可用');
    }
    if (!_poolReady) {
        _poolReady = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 4 });
        })().catch((err) => {
            _poolReady = null;
            throw err;
        });
    }
    return _poolReady;
}
const logErr = String(process.env.RDK_CENTRAL_TELEMETRY_LOG_ERRORS ?? '').trim() === '1';
function warnOnce(scope, err) {
    if (!logErr)
        return;
    console.warn(`[central-telemetry] ${scope} insert failed:`, err instanceof Error ? err.message : err);
}
/**
 * 幂等建表,进程内只跑一次(缓存 Promise,与 pool() 同款单例模式)。三张表 schema 对齐
 * supabase/migrations/2026-05-01-chat-feedback.sql、2026-05-08-conversation-turns-current.sql、
 * 2026-05-08-studio-daily-usage.sql(去掉 RLS/grant,纯 Postgres 无需这些 Supabase 专属语句)。
 */
let _schemaReady = null;
async function ensureSchema(p) {
    if (!_schemaReady) {
        _schemaReady = (async () => {
            await p.query(`
        create table if not exists public.conversation_turns (
          id uuid not null default gen_random_uuid(),
          source_id text,
          recorded_at timestamp with time zone not null,
          sso_user_name text null,
          user_message text not null default ''::text,
          assistant_message text not null default ''::text,
          tools_used text[] not null default '{}'::text[],
          channel text not null default 'studio'::text,
          outcome text not null default 'completed'::text,
          error_detail text null,
          constraint conversation_turns_pkey primary key (id)
        );
      `);
            await p.query(`create index if not exists conversation_turns_recorded_at_idx on public.conversation_turns using btree (recorded_at desc)`);
            await p.query(`create index if not exists conversation_turns_sso_user_name_idx on public.conversation_turns using btree (sso_user_name)`);
            await p.query(`create index if not exists conversation_turns_channel_idx on public.conversation_turns using btree (channel)`);
            await p.query(`create index if not exists conversation_turns_outcome_idx on public.conversation_turns using btree (outcome)`);
            // 账号级同步/对话恢复地基(v1.3.2「账号换端不丢失」):补稳定的 session_id + sso_user_id 列(展示名
            // sso_user_name 会碰撞,不能做隔离/恢复键)。自愈加列;老行为 null(不参与隔离,self-gating)。
            await p.query(`alter table public.conversation_turns add column if not exists session_id text`);
            await p.query(`alter table public.conversation_turns add column if not exists sso_user_id text`);
            await p.query(`alter table public.conversation_turns add column if not exists source_id text`);
            await p.query(`alter table public.conversation_turns add column if not exists app_version text`);
            await p.query(`create unique index if not exists conversation_turns_source_id_uidx
           on public.conversation_turns (source_id) where source_id is not null`);
            await p.query(`create index if not exists conversation_turns_sso_user_id_idx on public.conversation_turns (sso_user_id) where sso_user_id is not null`);
            await p.query(`create index if not exists conversation_turns_session_id_idx on public.conversation_turns (session_id) where session_id is not null`);
            // 来源维度:区分 web-cloud / desktop / miniapp / web-self-host / local-dev。
            // 桌面对话经 HTTP 上报落库时带上;小程序由请求 surface 显式传入;其余按部署形态兜底。
            await p.query(`alter table public.conversation_turns add column if not exists client_type text`);
            await p.query(`create index if not exists conversation_turns_client_type_idx on public.conversation_turns (client_type) where client_type is not null`);
            await p.query(`
        create table if not exists public.studio_daily_usage (
          id uuid primary key default gen_random_uuid(),
          source_id text,
          created_at timestamptz not null default now(),
          usage_date date not null,
          anonymous_id text not null,
          app_version text,
          event_type text,
          login_channel text,
          sso_user_id text
        );
      `);
            await p.query(`create index if not exists studio_daily_usage_usage_date_idx on public.studio_daily_usage (usage_date desc)`);
            await p.query(`create index if not exists studio_daily_usage_created_at_idx on public.studio_daily_usage (created_at desc)`);
            await p.query(`create index if not exists studio_daily_usage_anonymous_id_idx on public.studio_daily_usage (anonymous_id)`);
            await p.query(`create index if not exists studio_daily_usage_sso_login_created_idx on public.studio_daily_usage (created_at desc) where event_type = 'sso_login'`);
            await p.query(`create index if not exists studio_daily_usage_sso_user_id_idx on public.studio_daily_usage (sso_user_id) where event_type = 'sso_login'`);
            await p.query(`alter table public.studio_daily_usage add column if not exists source_id text`);
            await p.query(`create unique index if not exists studio_daily_usage_source_id_uidx
           on public.studio_daily_usage (source_id) where source_id is not null`);
            await p.query(`
        create table if not exists public.chat_feedback (
          id uuid primary key default gen_random_uuid(),
          recorded_at timestamptz not null default now(),
          run_id text not null,
          message_id text,
          kind text not null check (kind in ('up', 'down')),
          comment text,
          sso_user_name text,
          user_message text,
          assistant_message text,
          timeline text
        );
      `);
            await p.query(`create index if not exists chat_feedback_recorded_at_idx on public.chat_feedback (recorded_at desc)`);
            await p.query(`create index if not exists chat_feedback_run_id_idx on public.chat_feedback (run_id)`);
        })().catch((err) => {
            _schemaReady = null;
            throw err;
        });
    }
    return _schemaReady;
}
/**
 * 中心对话归档。**自路由**:本进程直连中心库(RDK_CHAT_CREDITS_DB_URL)→ 直插;否则(桌面等无库形态)
 * → 经 HTTP 上报到 web-cloud 中心(reportConversationTurnToCentral)。两路互斥,绝不双计。静默失败、有限重试
 * (dual-write 旁路,不拖慢 run 生命周期)。
 */
export async function insertConversationTurnCentral(row) {
    const clientType = (row.client_type ?? '').toString().trim() || resolveStudioDeploymentProfile();
    const appVersion = normalizeStudioTelemetryVersion(row.app_version);
    if (!isCentralTelemetryConfigured()) {
        // 无直连库:桌面/无库形态改道 HTTP 上报(带上来源形态);web-cloud 永不走这里(已配库)。
        reportConversationTurnToCentral({ ...row, client_type: clientType, app_version: appVersion });
        // 旁路已安排，但本进程没有本地落库；HTTP 摄取路由据此回 503，避免伪装成已写入中心。
        return false;
    }
    try {
        const p = await pool();
        await ensureSchema(p);
        const sourceId = String(row.source_id ?? '').trim() ||
            buildTelemetrySourceId('conversation', [
                row.recorded_at,
                row.sso_user_id,
                row.session_id,
                row.channel,
                row.user_message,
                row.assistant_message,
                row.outcome,
            ]);
        await p.query(`insert into public.conversation_turns
         (source_id, recorded_at, sso_user_name, user_message, assistant_message, tools_used, channel, outcome, error_detail, session_id, sso_user_id, client_type, app_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (source_id) where source_id is not null do nothing`, [
            sourceId,
            row.recorded_at,
            row.sso_user_name,
            row.user_message,
            row.assistant_message,
            row.tools_used,
            row.channel,
            row.outcome,
            row.error_detail,
            (row.session_id ?? '').toString().trim() || null,
            (row.sso_user_id ?? '').toString().trim() || null,
            clientType || null,
            appVersion,
        ]);
        return true;
    }
    catch (err) {
        warnOnce('conversation_turns', err);
        return false;
    }
}
export async function listCloudConversationSessions(ssoUserId, limit = 50) {
    const id = String(ssoUserId ?? '').trim();
    if (!id || !isCentralTelemetryConfigured())
        return [];
    const lim = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
    const p = await pool();
    await ensureSchema(p);
    // 每会话取:轮数、起止时间、最早一条非空用户消息作标题。按最近活动倒序。
    const { rows } = await p.query(`select session_id,
            count(*)::int turn_count,
            min(recorded_at) first_at,
            max(recorded_at) last_at,
            max(channel) channel,
            (array_remove(array_agg(nullif(trim(user_message), '') order by recorded_at asc), null))[1] title
     from public.conversation_turns
     where sso_user_id = $1 and session_id is not null
     group by session_id
     order by last_at desc
     limit $2`, [id, lim]);
    return rows.map((r) => ({
        sessionId: String(r.session_id),
        title: (r.title == null ? '' : String(r.title)).slice(0, 120) || '(无标题会话)',
        turnCount: Number(r.turn_count) || 0,
        firstAt: r.first_at == null ? '' : new Date(r.first_at).toISOString(),
        lastAt: r.last_at == null ? '' : new Date(r.last_at).toISOString(),
        channel: r.channel == null ? 'studio' : String(r.channel),
    }));
}
export async function getCloudConversationTurns(ssoUserId, sessionId, limit = 200) {
    const id = String(ssoUserId ?? '').trim();
    const sid = String(sessionId ?? '').trim();
    if (!id || !sid || !isCentralTelemetryConfigured())
        return [];
    const lim = Math.min(Math.max(1, Math.floor(limit) || 200), 500);
    const p = await pool();
    await ensureSchema(p);
    // 双重过滤 sso_user_id + session_id:即便前端传了别人的 sessionId,也取不到(隔离键是 sso_user_id)。
    const { rows } = await p.query(`select recorded_at, user_message, assistant_message, outcome
     from public.conversation_turns
     where sso_user_id = $1 and session_id = $2
     order by recorded_at asc
     limit $3`, [id, sid, lim]);
    return rows.map((r) => ({
        recordedAt: r.recorded_at == null ? '' : new Date(r.recorded_at).toISOString(),
        userMessage: String(r.user_message ?? ''),
        assistantMessage: String(r.assistant_message ?? ''),
        outcome: String(r.outcome ?? 'completed'),
    }));
}
export async function insertDailyUsageCentral(row) {
    if (!isCentralTelemetryConfigured())
        return;
    try {
        const p = await pool();
        await ensureSchema(p);
        await p.query(`insert into public.studio_daily_usage
         (source_id, usage_date, anonymous_id, app_version, event_type, login_channel, sso_user_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (source_id) where source_id is not null do nothing`, [row.source_id ?? null, row.usage_date, row.anonymous_id, row.app_version, row.event_type, row.login_channel, row.sso_user_id]);
    }
    catch (err) {
        warnOnce('studio_daily_usage', err);
    }
}
/**
 * 独立表(不落 conversation_turns 兜底表,避免境外驻留问题在反馈上复现)。
 * 与 Supabase 那一路(writeChatFeedback)完全独立、静默失败,不影响提交结果。
 */
export async function insertChatFeedbackCentral(row) {
    if (!isCentralTelemetryConfigured())
        return;
    try {
        const p = await pool();
        await ensureSchema(p);
        await p.query(`insert into public.chat_feedback
         (recorded_at, run_id, message_id, kind, comment, sso_user_name, user_message, assistant_message, timeline)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            row.recorded_at,
            row.run_id,
            row.message_id,
            row.kind,
            row.comment,
            row.sso_user_name,
            row.user_message,
            row.assistant_message,
            row.timeline,
        ]);
    }
    catch (err) {
        warnOnce('chat_feedback', err);
    }
}
