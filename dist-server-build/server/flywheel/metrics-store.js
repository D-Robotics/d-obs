import { classifyOpsDataHealth, } from '../../shared/ops-data-health.js';
import { readConversationAggregate, readDailyActiveUsers } from './conversation-aggregate-store.js';
function centralDbUrl() {
    return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}
export function isFlywheelMetricsConfigured() {
    return centralDbUrl().length > 0;
}
let _poolReady = null;
async function pool() {
    if (!centralDbUrl()) {
        throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置:中心库不可用');
    }
    if (!_poolReady) {
        _poolReady = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 2 });
        })().catch((err) => {
            _poolReady = null;
            throw err;
        });
    }
    return _poolReady;
}
const REAL_DEVICE_TOOL_PREDICATE = `exists (
  select 1 from unnest(r.tool_sequence) t
  where t like 'device\\_%' or t like 'board\\_%' or t like 'fleet\\_%'
)`;
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function clampDays(days) {
    if (!Number.isFinite(days) || days < 1)
        return 30;
    return Math.min(Math.floor(days), 180);
}
function shortScalar(value, max = 160) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
}
export async function getFlywheelOverview(daysInput = 30) {
    const days = clampDays(daysInput);
    const p = await pool();
    // —— 用户面 ——
    const [acctTotal, acctNewRaw, dau, todayQ] = await Promise.all([
        p.query(`select count(*)::int n, max(created_at)::text last_at
         from credit_account`),
        p.query(`select
         count(*) filter (where created_at >= now() - interval '7 days')::int n7,
         count(*) filter (where created_at >= now() - interval '30 days')::int n30
       from credit_account`),
        readDailyActiveUsers(p, days),
        // dauToday 的「今天」以 DB 的 current_date 为准(与上面 day 分组同源同时区),避免拿序列最后一行
        // ——那是「最近一个有活动的日子」,今天还没人活跃时会把昨天的 DAU 冒充成今天。
        p.query(`select current_date::text as today`),
    ]);
    const todayStr = String(todayQ.rows[0]?.today ?? '');
    // 有机新增:credit_account.created_at 是「入库时间」而非真实注册时间——迁移导入(supabase_sync/import)
    // 会把 7000+ 历史账户的 created_at 灌到迁移当日,若直接按 created_at 算「近 N 天新增」会把整批迁移
    // 误报成新增。故剔除迁移来源,只计有机入库(lazy_create / 未来真实注册来源)。source 列旧库可能没有 → 兜底回原始计数。
    let newAccounts7d = num(acctNewRaw.rows[0]?.n7);
    let newAccounts30d = num(acctNewRaw.rows[0]?.n30);
    let migratedAccounts = 0;
    try {
        const org = await p.query(`select
         count(*) filter (where created_at >= now() - interval '7 days'
           and coalesce(source, '') not in ('supabase_sync', 'supabase_import'))::int n7,
         count(*) filter (where created_at >= now() - interval '30 days'
           and coalesce(source, '') not in ('supabase_sync', 'supabase_import'))::int n30,
         count(*) filter (where coalesce(source, '') in ('supabase_sync', 'supabase_import'))::int migrated
       from credit_account`);
        newAccounts7d = num(org.rows[0]?.n7);
        newAccounts30d = num(org.rows[0]?.n30);
        migratedAccounts = num(org.rows[0]?.migrated);
    }
    catch {
        // source 列尚未建(旧库)→ 保留原始 created_at 计数,迁移基线记 0
    }
    // —— 用户旅程 ——
    // 注册 cohort 和窗口参与层级分开呈现，避免把“全部活跃用户”误当作“新增用户转化”。
    // 三条活动流都使用稳定 sso_user_id；旧表缺列时整段降级为 configured=false，不用展示名猜账号。
    let journey = {
        configured: false,
        registeredAccounts: 0,
        activatedAccounts: 0,
        activationRate: null,
        activeUsers: 0,
        runUsers: 0,
        successfulRunUsers: 0,
        feedbackUsers: null,
    };
    let journeyLastEventAt = null;
    try {
        const journeyQ = await p.query(`with new_accounts as (
         select sso_user_id, created_at
           from credit_account
          where created_at >= now() - make_interval(days => $1::int)
            and coalesce(source, '') not in ('supabase_sync', 'supabase_import')
       ),
       activity as (
         select nullif(trim(sso_user_id), '') actor, created_at activity_at
           from studio_daily_usage
          where created_at >= now() - make_interval(days => $1::int)
         union all
         select nullif(trim(sso_user_id), '') actor, recorded_at activity_at
           from conversation_turns
          where recorded_at >= now() - make_interval(days => $1::int)
         union all
         select nullif(trim(sso_user_id), '') actor, started_at activity_at
           from agent_run_records
          where started_at >= now() - make_interval(days => $1::int)
       ),
       first_activity as (
         select actor, min(activity_at) first_at
           from activity
          where actor is not null
          group by actor
       ),
       run_users as (
         select nullif(trim(sso_user_id), '') actor,
                bool_or(outcome in ('completed', 'completed_partial')) has_success
           from agent_run_records
          where started_at >= now() - make_interval(days => $1::int)
            and nullif(trim(sso_user_id), '') is not null
          group by 1
       )
       select
         (select count(*)::int from new_accounts) registered,
         (select count(*)::int
            from new_accounts n
            join first_activity a on a.actor = n.sso_user_id and a.first_at >= n.created_at) activated,
         (select count(*)::int from first_activity) active_users,
         (select count(*)::int from run_users) run_users,
         (select count(*) filter (where has_success)::int from run_users) successful_run_users,
         (select max(activity_at)::text from activity) last_activity_at`, [days]);
        const registeredAccounts = num(journeyQ.rows[0]?.registered);
        const activatedAccounts = num(journeyQ.rows[0]?.activated);
        journeyLastEventAt = shortScalar(journeyQ.rows[0]?.last_activity_at, 64);
        journey = {
            configured: true,
            registeredAccounts,
            activatedAccounts,
            activationRate: registeredAccounts > 0 ? activatedAccounts / registeredAccounts : null,
            activeUsers: num(journeyQ.rows[0]?.active_users),
            runUsers: num(journeyQ.rows[0]?.run_users),
            successfulRunUsers: num(journeyQ.rows[0]?.successful_run_users),
            feedbackUsers: null,
        };
    }
    catch {
        // 旧库缺 sso_user_id/source 等稳定维度时保持“未配置”，不退回展示名做不可靠关联。
    }
    // —— run 面 ——
    const [runDaily, runAgg, realDevice, realDeviceEver, latency, errCats] = await Promise.all([
        p.query(`select date(started_at)::text as day,
              count(*)::int total,
              count(*) filter (where outcome = 'completed')::int completed,
              count(*) filter (where outcome = 'completed_partial')::int partial,
              count(*) filter (where outcome = 'error')::int error,
              count(*) filter (where outcome = 'cancelled')::int cancelled
       from agent_run_records
       where started_at >= now() - make_interval(days => $1::int)
       group by 1 order by 1`, [days]),
        p.query(`select count(*)::int total,
              count(*) filter (where outcome in ('completed','completed_partial'))::int ok,
              count(*) filter (where outcome = 'error')::int err,
              max(started_at)::text last_at
       from agent_run_records
       where started_at >= now() - make_interval(days => $1::int)`, [days]),
        p.query(`select count(distinct r.sso_user_id)::int users, count(*)::int runs
       from agent_run_records r
       where r.started_at >= date_trunc('month', now())
         and r.sso_user_id is not null
         and r.device_id is not null
         and ${REAL_DEVICE_TOOL_PREDICATE}`),
        // 真机维度是否曾接入(全表任一 run 落过 device_id)。全为 null → 结构性未接入,看板显示「未接入」而非误导性 0。
        p.query(`select count(*)::int n from agent_run_records where device_id is not null`),
        p.query(`select percentile_cont(0.5) within group (order by elapsed_ms) p50,
              percentile_cont(0.9) within group (order by elapsed_ms) p90
       from agent_run_records
       where started_at >= now() - make_interval(days => $1::int)
         and outcome in ('completed','completed_partial')`, [days]),
        p.query(`select coalesce(nullif(trim(error_category), ''), '(未分类)') category, count(*)::int n
       from agent_run_records
       where started_at >= now() - make_interval(days => $1::int) and outcome = 'error'
       group by 1 order by n desc limit 8`, [days]),
    ]);
    // —— 对话面 / 反馈面 / 渠道面 ——
    const conversationAggregate = await readConversationAggregate(p, days);
    const convAgg = conversationAggregate.result;
    const conversationSource = conversationAggregate.source;
    let feedbackAvailable = false;
    let fbAgg = { rows: [{ up: 0, down: 0 }] };
    let fbDown = { rows: [] };
    let fbConfigured = { rows: [{ n: 0, last_at: null }] };
    try {
        [fbAgg, fbDown, fbConfigured] = await Promise.all([
            p.query(`select count(*) filter (where kind = 'up')::int up,
                count(*) filter (where kind = 'down')::int down
         from chat_feedback
         where recorded_at >= now() - make_interval(days => $1::int)`, [days]),
            p.query(`select recorded_at::text, comment, user_message
         from chat_feedback
         where kind = 'down'
         order by recorded_at desc limit 10`),
            // 表可查询即代表反馈结构已接入；0 行只是当前还没有生产样本。
            p.query(`select count(*)::int n, max(recorded_at)::text last_at from chat_feedback`),
        ]);
        feedbackAvailable = true;
    }
    catch {
        // 反馈表未建时保持其余 overview 可用，由 dataHealth 显示未配置。
    }
    if (feedbackAvailable && journey.configured) {
        try {
            const feedbackUsers = await p.query(`select count(distinct nullif(trim(r.sso_user_id), ''))::int users
           from chat_feedback f
           join agent_run_records r on r.run_id = f.run_id
          where f.recorded_at >= now() - make_interval(days => $1::int)
            and nullif(trim(r.sso_user_id), '') is not null`, [days]);
            journey.feedbackUsers = num(feedbackUsers.rows[0]?.users);
        }
        catch {
            // feedbackUsers 保持 null：反馈总量仍可展示，但无法可靠关联到稳定账号。
        }
    }
    // channels 保留旧接口语义：studio_daily_usage 中的“成功登录入口渠道”。
    // 新 UI 使用 loginBreakdown；两种来源不可相加，因为它们的分母和维度不同。
    let legacyChannelsAvailable = false;
    let legacyChannelRows = [];
    try {
        const legacy = await p.query(`select coalesce(nullif(trim(login_channel), ''), '(未标注)') channel,
              count(*)::int logins,
              count(distinct coalesce(sso_user_id, anonymous_id))::int users,
              max(created_at)::text last_at
       from studio_daily_usage
       where event_type = 'sso_login'
         and created_at >= now() - make_interval(days => $1::int)
       group by 1 order by logins desc`, [days]);
        legacyChannelsAvailable = true;
        legacyChannelRows = legacy.rows;
    }
    catch {
        // 旧部署缺表/缺列时不能拖垮整张 overview。
    }
    const channels = legacyChannelRows.map((row) => ({
        channel: String(row.channel),
        logins: num(row.logins),
        users: num(row.users),
    }));
    // studio_ops_events 只覆盖 direct/login，并由 alert worker 保留最近 30 天；
    // 因此它是“直登方式尝试”，不是全部登录方式，也不能被 90/180 天总窗口误导。
    const directLoginWindowDays = Math.min(days, 30);
    let directLoginAvailable = false;
    let directLoginRows = [];
    try {
        const directLogin = await p.query(`select case
                when lower(trim(metadata->>'method')) in ('account','email','sms')
                  then lower(trim(metadata->>'method'))
                else '(其他/未标注)'
              end method,
              count(*) filter (where outcome = 'ok')::int successes,
              count(*) filter (where outcome = 'rejected')::int rejected,
              count(*) filter (where outcome = 'error')::int errors,
              max(occurred_at)::text last_at
         from studio_ops_events
        where event_code = 'sso_login_attempt'
          and occurred_at >= now() - make_interval(days => $1::int)
        group by 1
        order by successes desc, rejected desc, errors desc`, [directLoginWindowDays]);
        directLoginAvailable = true;
        directLoginRows = directLogin.rows;
    }
    catch {
        // 旧库尚未建 studio_ops_events 或 metadata.method 时继续使用入口渠道。
    }
    const loginBreakdown = directLoginRows.length > 0 || (directLoginAvailable && !legacyChannelRows.length)
        ? {
            source: 'studio_ops_events',
            dimension: 'direct_method',
            effectiveWindowDays: directLoginWindowDays,
            items: directLoginRows.map((row) => ({
                key: String(row.method),
                successes: num(row.successes),
                rejected: num(row.rejected),
                errors: num(row.errors),
                // 运维登录事件刻意不持久化可枚举用户，不能用 0 冒充真实去重用户数。
                uniqueUsers: null,
            })),
        }
        : legacyChannelsAvailable
            ? {
                source: 'studio_daily_usage',
                dimension: 'entry_channel',
                effectiveWindowDays: days,
                items: legacyChannelRows.map((row) => ({
                    key: String(row.channel),
                    successes: num(row.logins),
                    rejected: 0,
                    errors: 0,
                    uniqueUsers: num(row.users),
                })),
            }
            : {
                source: 'unavailable',
                dimension: 'unavailable',
                effectiveWindowDays: days,
                items: [],
            };
    const loginLastAt = (loginBreakdown.source === 'studio_ops_events' ? directLoginRows : legacyChannelRows)
        .map((row) => shortScalar(row.last_at, 64))
        .filter((value) => Boolean(value))
        .sort()
        .at(-1) ?? null;
    // —— 获客渠道归因(first-touch):credit_account.acquisition_channel 分布 + 覆盖率 ——
    let acquisition = {
        channels: [],
        attributedAccounts: 0,
        totalAccounts: num(acctTotal.rows[0]?.n),
        coverageRate: null,
        lastAttributedAt: null,
    };
    let acquisitionConfigured = false;
    try {
        const [acqDist, acqCov] = await Promise.all([
            p.query(`select coalesce(nullif(trim(acquisition_channel), ''), '(未归因)') channel, count(*)::int n
         from credit_account group by 1 order by n desc limit 12`),
            p.query(`select count(*) filter (where nullif(trim(acquisition_channel), '') is not null)::int attributed,
                count(*)::int total,
                max(acquisition_at)::text last_at
         from credit_account`),
        ]);
        const attributed = num(acqCov.rows[0]?.attributed);
        const total = num(acqCov.rows[0]?.total);
        acquisitionConfigured = true;
        acquisition = {
            channels: acqDist.rows.map((r) => ({ channel: String(r.channel), accounts: num(r.n) })),
            attributedAccounts: attributed,
            totalAccounts: total,
            coverageRate: total > 0 ? attributed / total : null,
            lastAttributedAt: shortScalar(acqCov.rows[0]?.last_at, 64),
        };
    }
    catch {
        // acquisition_* 列尚未建(旧库首次启动前)→ 保持默认,不影响其余指标
    }
    let runsWithRetry = null;
    try {
        const result = await p.query(`select count(*) filter (where coalesce(retry_count, 0) > 0)::int n
       from agent_run_records where started_at >= now() - make_interval(days => $1::int)`, [days]);
        runsWithRetry = num(result.rows[0]?.n);
    }
    catch {
        // The retry_count column may not exist on older deployments.
    }
    const runTotal = num(runAgg.rows[0]?.total);
    const runOk = num(runAgg.rows[0]?.ok);
    const runErr = num(runAgg.rows[0]?.err);
    const convTotal = num(convAgg.rows[0]?.total);
    const convOk = num(convAgg.rows[0]?.ok);
    // 对话来源拆分(client_type)。新列,旧库可能没有 → 独立 try 守护,缺列则空(看板不渲染拆分,不报错)。
    let convByClient = [];
    if (conversationSource === 'central') {
        try {
            const bc = await p.query(`select coalesce(nullif(trim(client_type), ''), '(未标注)') ct, count(*)::int n
         from conversation_turns
         where recorded_at >= now() - make_interval(days => $1::int)
         group by 1 order by n desc`, [days]);
            convByClient = bc.rows.map((r) => ({ clientType: String(r.ct), count: num(r.n) }));
        }
        catch {
            convByClient = []; // client_type 列尚未建(旧库)→ 不拆分
        }
    }
    const clientTaggedTurns = convByClient
        .filter((row) => row.clientType !== '(未标注)')
        .reduce((sum, row) => sum + row.count, 0);
    const clientCoverageRate = conversationSource === 'supabase' ? null : convTotal > 0 ? clientTaggedTurns / convTotal : null;
    let conversationSessionCount = null;
    let sessionCoverageRate = null;
    if (conversationSource === 'central') {
        try {
            const sessions = await p.query(`select count(distinct (
                  coalesce(nullif(trim(sso_user_id), ''), '(anonymous)'),
                  nullif(trim(session_id), '')
                )) filter (where nullif(trim(session_id), '') is not null)::int sessions,
                count(*) filter (where nullif(trim(session_id), '') is not null)::int tagged
           from conversation_turns
          where recorded_at >= now() - make_interval(days => $1::int)`, [days]);
            conversationSessionCount = num(sessions.rows[0]?.sessions);
            sessionCoverageRate = convTotal > 0 ? num(sessions.rows[0]?.tagged) / convTotal : null;
        }
        catch {
            // 旧库没有 session_id 时不能把 0 冒充真实会话数。
        }
    }
    const conversationCoverage = [clientCoverageRate, sessionCoverageRate]
        .filter((value) => value != null)
        .reduce((lowest, value) => (lowest == null ? value : Math.min(lowest, value)), null);
    // 总量仍服从用户选择的 30/90/180 天窗口；链路健康只看最近 7 天，避免上线前的历史
    // 空维度在未来一个月持续把已修复的数据链路误报为 partial。
    const conversationHealthWindowDays = Math.min(days, 7);
    let conversationHealthSamples = convTotal;
    let conversationHealthCoveredSamples = conversationCoverage == null ? null : Math.floor(convTotal * conversationCoverage);
    let conversationHealthCoverage = conversationCoverage;
    if (conversationSource === 'central') {
        try {
            const healthCoverage = await p.query(`select count(*)::int total,
                count(*) filter (where nullif(trim(client_type), '') is not null)::int client_tagged,
                count(*) filter (where nullif(trim(session_id), '') is not null)::int session_tagged
           from conversation_turns
          where recorded_at >= now() - make_interval(days => $1::int)`, [conversationHealthWindowDays]);
            const total = num(healthCoverage.rows[0]?.total);
            const covered = Math.min(num(healthCoverage.rows[0]?.client_tagged), num(healthCoverage.rows[0]?.session_tagged));
            conversationHealthSamples = total;
            conversationHealthCoveredSamples = covered;
            conversationHealthCoverage = total > 0 ? covered / total : null;
        }
        catch {
            // 旧库缺维度列时保留原窗口的保守覆盖率。
        }
    }
    const loginSamples = loginBreakdown.items.reduce((sum, row) => sum + row.successes + row.rejected + row.errors, 0);
    const loginHealthState = loginBreakdown.source === 'unavailable'
        ? 'not_configured'
        : loginBreakdown.source === 'studio_daily_usage' && loginSamples > 0
            ? 'partial'
            : loginBreakdown.source === 'studio_ops_events' && loginSamples > 0
                ? 'partial'
                : classifyOpsDataHealth({ configured: true, sampleCount: loginSamples });
    const feedbackSamples = num(fbAgg.rows[0]?.up) + num(fbAgg.rows[0]?.down);
    const dataHealth = {
        users: {
            state: classifyOpsDataHealth({
                configured: true,
                sampleCount: num(acctTotal.rows[0]?.n),
            }),
            source: 'credit_account + studio_daily_usage',
            sampleCount: num(acctTotal.rows[0]?.n),
            lastEventAt: shortScalar(acctTotal.rows[0]?.last_at, 64),
            coverageRate: null,
        },
        runs: {
            state: classifyOpsDataHealth({ configured: true, sampleCount: runTotal }),
            source: 'agent_run_records',
            sampleCount: runTotal,
            lastEventAt: shortScalar(runAgg.rows[0]?.last_at, 64),
            coverageRate: null,
        },
        conversations: {
            state: classifyOpsDataHealth({
                configured: true,
                sampleCount: conversationHealthSamples,
                coverageRate: conversationHealthCoverage,
            }),
            source: conversationSource === 'supabase'
                ? 'supabase.conversation_turns (migration read)'
                : 'conversation_turns',
            sampleCount: conversationHealthSamples,
            lastEventAt: shortScalar(convAgg.rows[0]?.last_at, 64),
            coverageRate: conversationHealthCoverage,
            coveredSamples: conversationHealthCoveredSamples ?? undefined,
            eligibleSamples: conversationHealthSamples,
            effectiveWindowDays: conversationHealthWindowDays,
            reason: conversationHealthSamples > 0 &&
                conversationHealthCoverage != null &&
                conversationHealthCoverage < 0.8
                ? 'missing_dimension'
                : undefined,
        },
        feedback: {
            state: classifyOpsDataHealth({
                configured: feedbackAvailable,
                sampleCount: feedbackSamples,
            }),
            source: 'chat_feedback',
            sampleCount: feedbackSamples,
            lastEventAt: shortScalar(fbConfigured.rows[0]?.last_at, 64),
            coverageRate: null,
        },
        acquisition: {
            state: classifyOpsDataHealth({
                configured: acquisitionConfigured,
                sampleCount: acquisition.totalAccounts,
                coverageRate: acquisition.coverageRate,
            }),
            source: 'credit_account.acquisition_*',
            sampleCount: acquisition.totalAccounts,
            lastEventAt: acquisition.lastAttributedAt,
            coverageRate: acquisition.coverageRate,
            coveredSamples: acquisition.attributedAccounts,
            eligibleSamples: acquisition.totalAccounts,
            reason: acquisition.coverageRate != null && acquisition.coverageRate < 0.8
                ? 'missing_dimension'
                : undefined,
        },
        loginChannels: {
            state: loginHealthState,
            source: loginBreakdown.source,
            sampleCount: loginSamples,
            lastEventAt: loginLastAt,
            coverageRate: null,
            effectiveWindowDays: loginBreakdown.effectiveWindowDays,
            reason: loginBreakdown.source === 'studio_ops_events'
                ? 'direct_login_only'
                : loginBreakdown.source === 'studio_daily_usage'
                    ? 'legacy_fallback'
                    : 'source_unavailable',
        },
        journey: {
            state: classifyOpsDataHealth({
                configured: journey.configured,
                sampleCount: Math.max(journey.registeredAccounts, journey.activeUsers),
            }),
            source: 'credit_account + studio_daily_usage + conversation_turns + agent_run_records',
            sampleCount: Math.max(journey.registeredAccounts, journey.activeUsers),
            lastEventAt: journeyLastEventAt,
            coverageRate: null,
        },
    };
    return {
        generatedAt: new Date().toISOString(),
        windowDays: days,
        users: {
            totalAccounts: num(acctTotal.rows[0]?.n),
            newAccounts7d,
            newAccounts30d,
            migratedAccounts,
            dauToday: num(dau.rows.find((r) => String(r.day) === todayStr)?.dau),
            dailyActive: dau.rows.map((r) => ({ day: String(r.day), dau: num(r.dau) })),
        },
        journey,
        runs: {
            daily: runDaily.rows.map((r) => ({
                day: String(r.day),
                total: num(r.total),
                completed: num(r.completed),
                partial: num(r.partial),
                error: num(r.error),
                cancelled: num(r.cancelled),
            })),
            // 成功率口径:completed+completed_partial / (同窗全部非取消 run)。cancelled 是用户主动行为,不计分母。
            successRate: runOk + runErr > 0 ? runOk / (runOk + runErr) : null,
            totalRuns: runTotal,
            realDeviceUsersThisMonth: num(realDevice.rows[0]?.users),
            realDeviceRunsThisMonth: num(realDevice.rows[0]?.runs),
            realDeviceConfigured: num(realDeviceEver.rows[0]?.n) > 0,
            latency: {
                p50Ms: latency.rows[0]?.p50 == null ? null : Math.round(Number(latency.rows[0].p50)),
                p90Ms: latency.rows[0]?.p90 == null ? null : Math.round(Number(latency.rows[0].p90)),
            },
            topErrorCategories: errCats.rows.map((r) => ({
                category: String(r.category),
                count: num(r.n),
            })),
            runsWithRetry,
        },
        conversations: {
            total: convTotal,
            completed: convOk,
            error: num(convAgg.rows[0]?.err),
            successRate: convTotal > 0 ? convOk / convTotal : null,
            sessionCount: conversationSessionCount,
            sessionCoverageRate,
            clientCoverageRate,
            byClient: convByClient,
        },
        feedback: {
            up: num(fbAgg.rows[0]?.up),
            down: num(fbAgg.rows[0]?.down),
            recentDown: fbDown.rows.map((r) => ({
                recordedAt: String(r.recorded_at ?? ''),
                comment: r.comment == null ? null : String(r.comment),
                userMessage: r.user_message == null ? null : String(r.user_message),
            })),
            configured: feedbackAvailable,
        },
        channels,
        loginBreakdown,
        acquisition,
        dataHealth,
    };
}
