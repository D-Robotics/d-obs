/**
 * d-obs 服务等级策略与滚动错误预算。
 *
 * SLO 是内部工程目标；slaReferencePercent 只是运营参考线，不构成对外合同承诺。
 * 所有计算只使用低敏感聚合计数，不读取或返回用户身份、会话正文、工具参数或结果。
 */
let centralPoolReady = null;
async function centralPool() {
    const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
    if (!connectionString)
        throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
    if (!centralPoolReady) {
        centralPoolReady = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString, max: 2 });
        })().catch((error) => {
            centralPoolReady = null;
            throw error;
        });
    }
    return centralPoolReady;
}
export const SERVICE_LEVEL_POLICY_VERSION = 1;
export const SERVICE_LEVEL_WINDOW_DAYS = 28;
export const SERVICE_LEVEL_FAST_WINDOW_MINUTES = 60;
export const SERVICE_LEVEL_SLOW_WINDOW_MINUTES = 360;
export const SERVICE_LEVEL_OBJECTIVES = [
    {
        key: 'public-availability',
        title: '公网服务可用性',
        userJourney: '用户能够打开主站入口并访问健康接口',
        sliDescription: '每分钟公网健康拨测成功数 / 有效拨测总数',
        source: '独立告警 Worker → 公网 /api/health',
        goodEvent: 'HTTP 成功且健康响应包含 ok=true',
        totalEvent: '所有已完成的公网健康拨测',
        targetPercent: 99.9,
        slaReferencePercent: 99.5,
        minimumSamples: 60,
        burnRateMinimumSamples: 15,
        owner: 'Studio 平台',
    },
    {
        key: 'gateway-availability',
        title: '托管 Agent 网关可用性',
        userJourney: '用户的 AI 请求可以抵达并获得托管网关响应',
        sliDescription: '受保护网关合成拨测成功数 / 有效拨测总数',
        source: '独立告警 Worker → 托管网关 /models（或受保护 /api/health/gateway）',
        goodEvent: '网关 /models 返回 HTTP 2xx 且响应体在大小上限内完整读完',
        totalEvent: '所有已完成的网关合成拨测（超时、网络错误、5xx 均计坏）',
        targetPercent: 99.5,
        slaReferencePercent: 99,
        minimumSamples: 60,
        burnRateMinimumSamples: 15,
        owner: 'Agent 网关平台',
    },
    {
        key: 'gateway-latency',
        title: '托管 Agent 网关响应效率',
        userJourney: '用户的 AI 请求在可接受时间内获得网关响应',
        sliDescription: '低于延迟预算的成功网关拨测数 / 有效拨测总数',
        source: '独立告警 Worker → 托管网关 /models',
        goodEvent: 'HTTP 2xx 且完整响应耗时不超过 RDK_STUDIO_AGENT_HEALTH_LATENCY_BUDGET_MS',
        totalEvent: '所有已完成的网关拨测；超时、网络错误、5xx、慢响应均计坏',
        targetPercent: 99,
        slaReferencePercent: 98,
        minimumSamples: 60,
        burnRateMinimumSamples: 15,
        owner: 'Agent 网关平台',
    },
    {
        key: 'ai-ttft',
        title: 'AI 首字延迟（TTFT）',
        userJourney: '用户发起 AI 请求后能够及时看到第一段文字',
        sliDescription: '首段文字延迟不超过 TTFT 预算的完成 run 数 / 有首段文字的完成 run 总数',
        source: 'agent_run_records.first_text_ms + 托管网关 TTFT 合成拨测',
        goodEvent: 'outcome = completed 且 first_text_ms <= RDK_STUDIO_AGENT_TTFT_SLO_MS',
        totalEvent: '已完整完成且记录到首段文字的 run；可用性失败由 AI 成功率 SLO 单独覆盖',
        targetPercent: 95,
        slaReferencePercent: 90,
        minimumSamples: 20,
        burnRateMinimumSamples: 10,
        owner: 'Studio AI / Agent 网关平台',
    },
    {
        key: 'login-reliability',
        title: '登录基础设施可靠性',
        userJourney: '有效账号可以完成主站登录',
        sliDescription: '成功登录数 /（成功登录数 + 基础设施失败数）',
        source: 'studio_ops_events / sso_login_attempt',
        goodEvent: '登录请求返回 2xx/3xx',
        totalEvent: '成功和服务端/上游失败；排除密码、验证码等用户拒绝',
        targetPercent: 99.5,
        slaReferencePercent: 99,
        minimumSamples: 20,
        burnRateMinimumSamples: 10,
        owner: '身份与账号',
    },
    {
        key: 'ai-run-success',
        title: 'AI 对话成功率',
        userJourney: '用户发起的 AI 任务完整完成',
        sliDescription: '完整完成 run 数 / 可判定 run 总数',
        source: 'agent_run_records（每个 run 取最新记录）',
        goodEvent: 'outcome = completed',
        totalEvent: 'completed、completed_partial、error；排除用户取消与空响应即离场（empty_response_client_gone）',
        targetPercent: 95,
        slaReferencePercent: 90,
        minimumSamples: 20,
        burnRateMinimumSamples: 10,
        owner: 'Studio AI',
    },
    {
        key: 'tool-call-success',
        title: '工具调用成功率',
        userJourney: 'AI 能够可靠调用 Studio 与设备工具',
        sliDescription: '未记录失败的工具调用数 / 工具调用总数',
        source: 'agent_run_records + studio_ops_events / tool_call',
        goodEvent: 'run 中工具调用且无对应结构化失败事件',
        totalEvent: '所有已记录工具调用',
        targetPercent: 98,
        slaReferencePercent: 95,
        minimumSamples: 30,
        burnRateMinimumSamples: 20,
        owner: 'Agent 工具平台',
    },
];
function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
function rounded(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
function normalizeCounts(value) {
    if (!value)
        return null;
    const total = Math.floor(finiteNumber(value.total));
    const good = Math.min(total, Math.floor(finiteNumber(value.good)));
    return { good, total };
}
function burnRate(countsInput, targetPercent, minimumSamples) {
    const counts = normalizeCounts(countsInput);
    if (!counts || counts.total < minimumSamples)
        return null;
    const allowedFailureRate = 1 - targetPercent / 100;
    if (allowedFailureRate <= 0)
        return null;
    const actualFailureRate = (counts.total - counts.good) / counts.total;
    return rounded(actualFailureRate / allowedFailureRate);
}
export function calculateServiceLevelMeasurement(definition, windows) {
    const objective = normalizeCounts(windows.objective);
    const total = objective?.total ?? 0;
    const good = objective?.good ?? 0;
    const bad = Math.max(0, total - good);
    const rawCompliancePercent = total > 0 ? (good / total) * 100 : null;
    const compliancePercent = rawCompliancePercent !== null ? rounded(rawCompliancePercent) : null;
    const allowedBad = total * (1 - definition.targetPercent / 100);
    const remainingBad = allowedBad - bad;
    const remainingPercent = allowedBad > 0 ? rounded((remainingBad / allowedBad) * 100, 2) : null;
    const fastBurn = burnRate(windows.fast, definition.targetPercent, definition.burnRateMinimumSamples);
    const slowBurn = burnRate(windows.slow, definition.targetPercent, definition.burnRateMinimumSamples);
    let status = 'healthy';
    if (!objective || total < definition.minimumSamples) {
        status = 'no_data';
    }
    else if (rawCompliancePercent !== null &&
        rawCompliancePercent < definition.slaReferencePercent) {
        status = 'sla_breached';
    }
    else if (rawCompliancePercent !== null && rawCompliancePercent < definition.targetPercent) {
        status = 'budget_exhausted';
    }
    else if ((remainingPercent !== null && remainingPercent < 25) ||
        (fastBurn !== null && fastBurn > 1) ||
        (slowBurn !== null && slowBurn > 1)) {
        status = 'at_risk';
    }
    return {
        ...definition,
        windowDays: SERVICE_LEVEL_WINDOW_DAYS,
        status,
        dataAvailable: Boolean(objective),
        sampleCount: total,
        minimumSamples: definition.minimumSamples,
        goodCount: good,
        badCount: bad,
        compliancePercent,
        errorBudget: {
            allowedBad: rounded(allowedBad, 2),
            consumedBad: bad,
            remainingBad: rounded(remainingBad, 2),
            remainingPercent,
        },
        burnRate: {
            fast: fastBurn,
            fastWindowMinutes: SERVICE_LEVEL_FAST_WINDOW_MINUTES,
            slow: slowBurn,
            slowWindowMinutes: SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
        },
    };
}
export async function ensureServiceLevelSchema(p) {
    await p.query(`
    create table if not exists public.studio_sli_samples (
      id bigserial primary key,
      sli_key text not null,
      source text not null,
      sampled_at timestamptz not null,
      good_count int not null check (good_count >= 0),
      total_count int not null check (total_count > 0),
      created_at timestamptz not null default now(),
      unique (sli_key, source, sampled_at)
    )
  `);
    await p.query(`create index if not exists studio_sli_samples_key_sampled_idx
     on public.studio_sli_samples (sli_key, sampled_at desc)`);
}
export async function recordServiceLevelSamples(p, observations, sampledAt) {
    const knownKeys = new Set(SERVICE_LEVEL_OBJECTIVES.map((definition) => definition.key));
    const rows = observations.flatMap((observation) => {
        if (observation.enabled === false || observation.unknown || !observation.sli)
            return [];
        const total = Math.floor(finiteNumber(observation.sli.total));
        const good = Math.min(total, Math.floor(finiteNumber(observation.sli.good)));
        if (!knownKeys.has(observation.sli.key) || total < 1)
            return [];
        return [
            {
                sli_key: observation.sli.key,
                source: String(observation.sli.source).slice(0, 120),
                sampled_at: sampledAt,
                good_count: good,
                total_count: total,
            },
        ];
    });
    if (!rows.length)
        return;
    await p.query(`insert into public.studio_sli_samples
       (sli_key, source, sampled_at, good_count, total_count)
     select sli_key, source, sampled_at, good_count, total_count
     from jsonb_to_recordset($1::jsonb) as row(
       sli_key text,
       source text,
       sampled_at timestamptz,
       good_count int,
       total_count int
     )
     on conflict (sli_key, source, sampled_at) do nothing`, [JSON.stringify(rows)]);
}
function countsFromRow(row, prefix) {
    return {
        good: finiteNumber(row[`${prefix}_good`]),
        total: finiteNumber(row[`${prefix}_total`]),
    };
}
async function queryAvailabilityWindows(p) {
    return querySampleWindows(p, 'public-availability');
}
async function queryGatewayAvailabilityWindows(p) {
    return querySampleWindows(p, 'gateway-availability');
}
async function queryGatewayLatencyWindows(p) {
    return querySampleWindows(p, 'gateway-latency');
}
export function aiTtftBudgetMs() {
    const configured = Number.parseInt(String(process.env.RDK_STUDIO_AGENT_TTFT_SLO_MS ?? ''), 10);
    return Math.max(500, Math.min(120_000, Number.isFinite(configured) && configured > 0 ? configured : 8_000));
}
async function queryAiTtftWindows(p) {
    const result = await p.query(`with latest as (
       select distinct on (run_id) run_id, outcome, first_text_ms, started_at
       from public.agent_run_records
       where started_at >= now() - make_interval(days => $1::int)
       order by run_id, created_at desc
     ),
     run_samples as (
       select
         started_at,
         case when first_text_ms <= $4::int then 1 else 0 end good_count,
         1 total_count
       from latest
       where outcome = 'completed' and first_text_ms is not null
     ),
     synthetic_samples as (
       select sampled_at started_at, good_count, total_count
       from public.studio_sli_samples
       where sli_key = 'ai-ttft'
         and source = 'managed-agent-gateway-ttft-probe'
         and sampled_at >= now() - make_interval(days => $1::int)
     ),
     eligible as (
       select started_at, good_count, total_count from run_samples
       union all
       select started_at, good_count, total_count from synthetic_samples
     )
     select
       coalesce(sum(good_count), 0)::bigint objective_good,
       coalesce(sum(total_count), 0)::bigint objective_total,
       coalesce(sum(good_count) filter (
         where started_at >= now() - make_interval(mins => $2::int)
       ), 0)::bigint fast_good,
       coalesce(sum(total_count) filter (
         where started_at >= now() - make_interval(mins => $2::int)
       ), 0)::bigint fast_total,
       coalesce(sum(good_count) filter (
         where started_at >= now() - make_interval(mins => $3::int)
       ), 0)::bigint slow_good,
       coalesce(sum(total_count) filter (
         where started_at >= now() - make_interval(mins => $3::int)
       ), 0)::bigint slow_total
     from eligible`, [
        SERVICE_LEVEL_WINDOW_DAYS,
        SERVICE_LEVEL_FAST_WINDOW_MINUTES,
        SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
        aiTtftBudgetMs(),
    ]);
    const row = result.rows[0] ?? {};
    return {
        objective: countsFromRow(row, 'objective'),
        fast: countsFromRow(row, 'fast'),
        slow: countsFromRow(row, 'slow'),
    };
}
async function querySampleWindows(p, sliKey) {
    const result = await p.query(`select
       coalesce(sum(good_count) filter (
         where sampled_at >= now() - make_interval(days => $1::int)
       ), 0)::bigint objective_good,
       coalesce(sum(total_count) filter (
         where sampled_at >= now() - make_interval(days => $1::int)
       ), 0)::bigint objective_total,
       coalesce(sum(good_count) filter (
         where sampled_at >= now() - make_interval(mins => $2::int)
       ), 0)::bigint fast_good,
       coalesce(sum(total_count) filter (
         where sampled_at >= now() - make_interval(mins => $2::int)
       ), 0)::bigint fast_total,
       coalesce(sum(good_count) filter (
         where sampled_at >= now() - make_interval(mins => $3::int)
       ), 0)::bigint slow_good,
       coalesce(sum(total_count) filter (
         where sampled_at >= now() - make_interval(mins => $3::int)
       ), 0)::bigint slow_total
     from public.studio_sli_samples
     where sli_key = $4`, [
        SERVICE_LEVEL_WINDOW_DAYS,
        SERVICE_LEVEL_FAST_WINDOW_MINUTES,
        SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
        sliKey,
    ]);
    const row = result.rows[0] ?? {};
    return {
        objective: countsFromRow(row, 'objective'),
        fast: countsFromRow(row, 'fast'),
        slow: countsFromRow(row, 'slow'),
    };
}
async function queryLoginWindows(p) {
    const result = await p.query(`select
       count(*) filter (
         where occurred_at >= now() - make_interval(days => $1::int)
           and outcome = 'ok'
       )::bigint objective_good,
       count(*) filter (
         where occurred_at >= now() - make_interval(days => $1::int)
       )::bigint objective_total,
       count(*) filter (
         where occurred_at >= now() - make_interval(mins => $2::int)
           and outcome = 'ok'
       )::bigint fast_good,
       count(*) filter (
         where occurred_at >= now() - make_interval(mins => $2::int)
       )::bigint fast_total,
       count(*) filter (
         where occurred_at >= now() - make_interval(mins => $3::int)
           and outcome = 'ok'
       )::bigint slow_good,
       count(*) filter (
         where occurred_at >= now() - make_interval(mins => $3::int)
       )::bigint slow_total
     from public.studio_ops_events
     where event_code = 'sso_login_attempt'
       and outcome in ('ok', 'error')
       and occurred_at >= now() - make_interval(days => $1::int)`, [
        SERVICE_LEVEL_WINDOW_DAYS,
        SERVICE_LEVEL_FAST_WINDOW_MINUTES,
        SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
    ]);
    const row = result.rows[0] ?? {};
    return {
        objective: countsFromRow(row, 'objective'),
        fast: countsFromRow(row, 'fast'),
        slow: countsFromRow(row, 'slow'),
    };
}
async function queryAiRunWindows(p) {
    const result = await p.query(`with latest as (
       select distinct on (run_id) run_id, outcome, started_at
       from public.agent_run_records
       where started_at >= now() - make_interval(days => $1::int)
       order by run_id, created_at desc
     ),
     eligible as (
       select outcome, started_at
       from latest
       where outcome in ('completed', 'completed_partial', 'error')
     )
     select
       count(*) filter (where outcome = 'completed')::bigint objective_good,
       count(*)::bigint objective_total,
       count(*) filter (
         where started_at >= now() - make_interval(mins => $2::int)
           and outcome = 'completed'
       )::bigint fast_good,
       count(*) filter (
         where started_at >= now() - make_interval(mins => $2::int)
       )::bigint fast_total,
       count(*) filter (
         where started_at >= now() - make_interval(mins => $3::int)
           and outcome = 'completed'
       )::bigint slow_good,
       count(*) filter (
         where started_at >= now() - make_interval(mins => $3::int)
       )::bigint slow_total
     from eligible`, [
        SERVICE_LEVEL_WINDOW_DAYS,
        SERVICE_LEVEL_FAST_WINDOW_MINUTES,
        SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
    ]);
    const row = result.rows[0] ?? {};
    return {
        objective: countsFromRow(row, 'objective'),
        fast: countsFromRow(row, 'fast'),
        slow: countsFromRow(row, 'slow'),
    };
}
async function queryToolWindows(p) {
    const result = await p.query(`with latest as (
       select distinct on (run_id) run_id, tool_call_count, started_at
       from public.agent_run_records
       where started_at >= now() - make_interval(days => $1::int)
       order by run_id, created_at desc
     ),
     calls as (
       select
         coalesce(sum(tool_call_count), 0)::bigint objective_total,
         coalesce(sum(tool_call_count) filter (
           where started_at >= now() - make_interval(mins => $2::int)
         ), 0)::bigint fast_total,
         coalesce(sum(tool_call_count) filter (
           where started_at >= now() - make_interval(mins => $3::int)
         ), 0)::bigint slow_total
       from latest
     ),
     failures as (
       select
         count(*) filter (
           where occurred_at >= now() - make_interval(days => $1::int)
         )::bigint objective_bad,
         count(*) filter (
           where occurred_at >= now() - make_interval(mins => $2::int)
         )::bigint fast_bad,
         count(*) filter (
           where occurred_at >= now() - make_interval(mins => $3::int)
         )::bigint slow_bad
       from public.studio_ops_events
       where event_code = 'tool_call'
         and outcome = 'error'
         and occurred_at >= now() - make_interval(days => $1::int)
     )
     select
       greatest(calls.objective_total - failures.objective_bad, 0)::bigint objective_good,
       calls.objective_total,
       greatest(calls.fast_total - failures.fast_bad, 0)::bigint fast_good,
       calls.fast_total,
       greatest(calls.slow_total - failures.slow_bad, 0)::bigint slow_good,
       calls.slow_total
     from calls cross join failures`, [
        SERVICE_LEVEL_WINDOW_DAYS,
        SERVICE_LEVEL_FAST_WINDOW_MINUTES,
        SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
    ]);
    const row = result.rows[0] ?? {};
    return {
        objective: countsFromRow(row, 'objective'),
        fast: countsFromRow(row, 'fast'),
        slow: countsFromRow(row, 'slow'),
    };
}
async function tolerateMissingTelemetry(query) {
    try {
        return await query();
    }
    catch (error) {
        const code = String(error?.code ?? '');
        if (code === '42P01' || code === '42703') {
            return { objective: null, fast: null, slow: null };
        }
        throw error;
    }
}
let cachedOverview;
export async function getServiceLevelOverview(p, options) {
    if (!options?.bypassCache && cachedOverview && cachedOverview.expiresAt > Date.now()) {
        return cachedOverview.value;
    }
    await ensureServiceLevelSchema(p);
    const windows = await Promise.all([
        tolerateMissingTelemetry(() => queryAvailabilityWindows(p)),
        tolerateMissingTelemetry(() => queryGatewayAvailabilityWindows(p)),
        tolerateMissingTelemetry(() => queryGatewayLatencyWindows(p)),
        tolerateMissingTelemetry(() => queryAiTtftWindows(p)),
        tolerateMissingTelemetry(() => queryLoginWindows(p)),
        tolerateMissingTelemetry(() => queryAiRunWindows(p)),
        tolerateMissingTelemetry(() => queryToolWindows(p)),
    ]);
    const objectives = SERVICE_LEVEL_OBJECTIVES.map((definition, index) => calculateServiceLevelMeasurement(definition, windows[index]));
    const value = {
        generatedAt: new Date().toISOString(),
        policy: {
            version: SERVICE_LEVEL_POLICY_VERSION,
            status: 'baseline',
            windowDays: SERVICE_LEVEL_WINDOW_DAYS,
            fastWindowMinutes: SERVICE_LEVEL_FAST_WINDOW_MINUTES,
            slowWindowMinutes: SERVICE_LEVEL_SLOW_WINDOW_MINUTES,
            slaNote: 'SLA 百分比为内部运营参考线，不构成对外合同承诺。',
        },
        summary: {
            total: objectives.length,
            healthy: objectives.filter((item) => item.status === 'healthy').length,
            atRisk: objectives.filter((item) => item.status === 'at_risk').length,
            exhausted: objectives.filter((item) => item.status === 'budget_exhausted').length,
            slaBreached: objectives.filter((item) => item.status === 'sla_breached').length,
            noData: objectives.filter((item) => item.status === 'no_data').length,
        },
        objectives,
    };
    cachedOverview = { expiresAt: Date.now() + 30_000, value };
    return value;
}
export async function getConfiguredServiceLevelOverview() {
    return getServiceLevelOverview(await centralPool());
}
/**
 * Best-effort writer for request/worker paths that do not already own a pool.
 * A health endpoint must remain healthy when telemetry is disabled or the
 * central database is temporarily unavailable, so callers intentionally do not
 * await this helper on their critical response path.
 */
export async function recordConfiguredServiceLevelSamples(observations, sampledAt = new Date().toISOString()) {
    if (!String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim())
        return;
    const p = await centralPool();
    await ensureServiceLevelSchema(p);
    await recordServiceLevelSamples(p, observations, sampledAt);
}
export function selectWorstServiceLevelBurn(overview) {
    const candidates = overview.objectives.flatMap((objective) => {
        const values = [];
        if (objective.burnRate.fast !== null) {
            values.push({
                key: objective.key,
                title: objective.title,
                burnRate: objective.burnRate.fast,
                windowMinutes: objective.burnRate.fastWindowMinutes,
            });
        }
        if (objective.burnRate.slow !== null) {
            values.push({
                key: objective.key,
                title: objective.title,
                burnRate: objective.burnRate.slow,
                windowMinutes: objective.burnRate.slowWindowMinutes,
            });
        }
        return values;
    });
    return candidates.sort((left, right) => right.burnRate - left.burnRate)[0] ?? null;
}
