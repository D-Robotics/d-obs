import { sanitizeOpsSummary } from './ops-event-store.js';
/** 快照重聚合间隔:北极星是天级口径,6h 足够新鲜,也把大 CTE 成本压到每日 4 次。 */
export const NORTH_STAR_REFRESH_INTERVAL_HOURS = 6;
const NORTH_STAR_RULES = [
    ['north-star-skill-hit-rate', 'Skill 命中率回落'],
    ['north-star-ai-human-consistency', 'AI 审核一致率回落'],
    ['north-star-retention-d1', '新账号次日留存回落'],
    ['north-star-first-success-rate', '新账号首次成功率回落'],
];
function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function rateOf(part, total) {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum <= 0)
        return null;
    return num(part) / totalNum;
}
function observation(config, input) {
    const rule = config.rules[input.key];
    return {
        ...input,
        enabled: rule.enabled,
        openAfter: rule.openAfter,
        resolveAfter: rule.resolveAfter,
    };
}
function percent(rate) {
    return rate == null ? '-' : `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}
function rateObservation(config, key, title, rate, samples, summary) {
    const rule = config.rules[key];
    const value = rate == null ? null : rate * 100;
    if (rate == null || value == null) {
        return observation(config, {
            key,
            title,
            severity: 'warning',
            unhealthy: false,
            unknown: true,
            remindersEnabled: false,
            summary: `${summary};指标当前不可用,暂不评估`,
        });
    }
    if (samples < rule.minSamples) {
        return observation(config, {
            key,
            title,
            severity: 'warning',
            unhealthy: false,
            unknown: true,
            remindersEnabled: false,
            summary: `${summary};样本 ${samples} < ${rule.minSamples},暂不评估`,
        });
    }
    const unhealthy = value < rule.threshold;
    return observation(config, {
        key,
        title,
        // 该指标越低越糟:跌破 criticalThreshold(低于 threshold)时升级为严重。
        severity: value < rule.criticalThreshold ? 'critical' : 'warning',
        unhealthy,
        // 天级指标最多 6h 刷新一次;按冷却间隔重复提醒同一数值只是噪音。
        remindersEnabled: false,
        summary,
    });
}
export async function ensureNorthStarSchema(pool) {
    await pool.query(`create table if not exists public.studio_north_star_snapshots (
       snapshot_day date primary key,
       skill_hit_rate_7d double precision null,
       skill_hit_samples_7d integer not null default 0,
       ai_human_consistency double precision null,
       ai_human_sample integer not null default 0,
       d1_retention_rate double precision null,
       d1_eligible integer not null default 0,
       first_success_rate double precision null,
       registered_30d integer not null default 0,
       computed_at timestamptz not null default now()
     )`);
}
/** 一次性跑全部北极星聚合。单路失败只把对应指标置 null,不拖垮其它指标。 */
export async function collectNorthStarSnapshot(pool) {
    let skillHitRate7d = null;
    let skillHitSamples7d = 0;
    try {
        const hit = await pool.query(`select count(*)::int total,
              count(*) filter (where coalesce((properties->>'matched_count')::int, 0) > 0)::int hit
       from public.product_events
       where event_name = 'skill_matched'
         and occurred_at >= now() - interval '7 days'`);
        skillHitSamples7d = num(hit.rows[0]?.total);
        skillHitRate7d = rateOf(hit.rows[0]?.hit, hit.rows[0]?.total);
    }
    catch {
        // product_events 尚未建表(旧部署)→ 该指标保持不可用。
    }
    let aiHumanConsistency = null;
    let aiHumanSample = 0;
    try {
        const consistency = await pool.query(`select count(*)::int total,
              count(*) filter (where (ai_verdict = 'approve') = (human_verdict = 'approve'))::int agree
       from public.skill_review_queue
       where ai_verdict is not null and human_verdict is not null`);
        aiHumanSample = num(consistency.rows[0]?.total);
        aiHumanConsistency = rateOf(consistency.rows[0]?.agree, consistency.rows[0]?.total);
    }
    catch {
        // 审核队列表未配置。
    }
    let d1RetentionRate = null;
    let d1Eligible = 0;
    let firstSuccessRate = null;
    let registered30d = 0;
    try {
        // 口径与 flywheel/metrics-store.ts 的 journey CTE 保持一致:
        // 剔除迁移导入账户、以稳定 sso_user_id 关联活动;留存只看 d1(样本最多、噪声最小)。
        const journey = await pool.query(`with new_accounts as (
         select sso_user_id, created_at
           from public.credit_account
          where created_at >= now() - interval '30 days'
            and coalesce(source, '') not in ('supabase_sync', 'supabase_import')
       ),
       cohort_runs as (
         select n.sso_user_id actor, n.created_at,
                min(r.started_at) filter (
                  where r.outcome in ('completed', 'completed_partial')
                ) first_success_at
           from new_accounts n
           left join public.agent_run_records r
             on nullif(trim(r.sso_user_id), '') = n.sso_user_id
            and r.started_at >= n.created_at
          group by n.sso_user_id, n.created_at
       ),
       retention_cohort as (
         select a.sso_user_id actor, a.created_at::date registered_day
           from public.credit_account a
          where a.created_at::date >= current_date - 31
            and a.created_at::date < current_date - 1
            and coalesce(a.source, '') not in ('supabase_sync', 'supabase_import')
       ),
       activity as (
         select nullif(trim(sso_user_id), '') actor, created_at activity_at
           from public.studio_daily_usage
          where created_at >= now() - interval '31 days'
         union all
         select nullif(trim(sso_user_id), ''), recorded_at
           from public.conversation_turns
          where recorded_at >= now() - interval '31 days'
         union all
         select nullif(trim(sso_user_id), ''), started_at
           from public.agent_run_records
          where started_at >= now() - interval '31 days'
       )
       select
         (select count(*)::int from new_accounts) registered_30d,
         (select count(*)::int from cohort_runs where first_success_at is not null) first_success_users,
         (select count(*)::int from retention_cohort) d1_eligible,
         (select count(*)::int from retention_cohort c
           where exists (
             select 1 from activity a
              where a.actor = c.actor
                and a.activity_at::date = c.registered_day + 1
           )) d1_retained`);
        registered30d = num(journey.rows[0]?.registered_30d);
        firstSuccessRate = rateOf(journey.rows[0]?.first_success_users, registered30d);
        d1Eligible = num(journey.rows[0]?.d1_eligible);
        d1RetentionRate = rateOf(journey.rows[0]?.d1_retained, journey.rows[0]?.d1_eligible);
    }
    catch {
        // 旧库缺 sso_user_id/source 等稳定维度 → 留存与首次成功率保持不可用。
    }
    return {
        snapshotDay: '',
        computedAt: new Date().toISOString(),
        skillHitRate7d,
        skillHitSamples7d,
        aiHumanConsistency,
        aiHumanSample,
        d1RetentionRate,
        d1Eligible,
        firstSuccessRate,
        registered30d,
    };
}
/** 重聚合并把结果 upsert 到当日快照行。失败返回 null,由调用方降级。 */
export async function refreshNorthStarSnapshot(pool) {
    const snapshot = await collectNorthStarSnapshot(pool);
    try {
        await ensureNorthStarSchema(pool);
        await pool.query(`insert into public.studio_north_star_snapshots
         (snapshot_day, skill_hit_rate_7d, skill_hit_samples_7d, ai_human_consistency,
          ai_human_sample, d1_retention_rate, d1_eligible, first_success_rate,
          registered_30d, computed_at)
       values (current_date, $1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (snapshot_day) do update set
         skill_hit_rate_7d = excluded.skill_hit_rate_7d,
         skill_hit_samples_7d = excluded.skill_hit_samples_7d,
         ai_human_consistency = excluded.ai_human_consistency,
         ai_human_sample = excluded.ai_human_sample,
         d1_retention_rate = excluded.d1_retention_rate,
         d1_eligible = excluded.d1_eligible,
         first_success_rate = excluded.first_success_rate,
         registered_30d = excluded.registered_30d,
         computed_at = excluded.computed_at`, [
            snapshot.skillHitRate7d,
            snapshot.skillHitSamples7d,
            snapshot.aiHumanConsistency,
            snapshot.aiHumanSample,
            snapshot.d1RetentionRate,
            snapshot.d1Eligible,
            snapshot.firstSuccessRate,
            snapshot.registered30d,
        ]);
        snapshot.snapshotDay = new Date().toISOString().slice(0, 10);
        return snapshot;
    }
    catch {
        // 写快照失败不阻断告警评估:聚合值仍然可用,只是无法复用缓存。
        return snapshot;
    }
}
async function readLatestSnapshot(pool) {
    try {
        const result = await pool.query(`select snapshot_day::text snapshot_day, skill_hit_rate_7d, skill_hit_samples_7d,
              ai_human_consistency, ai_human_sample, d1_retention_rate, d1_eligible,
              first_success_rate, registered_30d, computed_at::text computed_at
       from public.studio_north_star_snapshots
       order by snapshot_day desc
       limit 1`);
        const row = result.rows[0];
        if (!row)
            return null;
        return {
            snapshotDay: String(row.snapshot_day ?? ''),
            computedAt: String(row.computed_at ?? ''),
            skillHitRate7d: row.skill_hit_rate_7d == null ? null : Number(row.skill_hit_rate_7d),
            skillHitSamples7d: num(row.skill_hit_samples_7d),
            aiHumanConsistency: row.ai_human_consistency == null ? null : Number(row.ai_human_consistency),
            aiHumanSample: num(row.ai_human_sample),
            d1RetentionRate: row.d1_retention_rate == null ? null : Number(row.d1_retention_rate),
            d1Eligible: num(row.d1_eligible),
            firstSuccessRate: row.first_success_rate == null ? null : Number(row.first_success_rate),
            registered30d: num(row.registered_30d),
        };
    }
    catch {
        return null;
    }
}
function snapshotAgeHours(snapshot) {
    const computed = Date.parse(snapshot.computedAt);
    if (!Number.isFinite(computed))
        return Number.POSITIVE_INFINITY;
    return Math.max(0, (Date.now() - computed) / 3_600_000);
}
/**
 * 北极星观测:优先读快照(分钟级巡检只花一次单行读),过期才重聚合。
 * 任何依赖不可用时返回 unknown 观测,不 resolve 既有事故。
 */
export async function collectNorthStarObservations(pool, config) {
    let snapshot = await readLatestSnapshot(pool);
    let staleNote = '';
    const refreshDue = !snapshot ||
        snapshotAgeHours(snapshot) >= NORTH_STAR_REFRESH_INTERVAL_HOURS ||
        snapshot.snapshotDay !== new Date().toISOString().slice(0, 10);
    if (refreshDue) {
        try {
            const refreshed = await refreshNorthStarSnapshot(pool);
            if (refreshed) {
                snapshot = refreshed;
            }
            else if (snapshot) {
                const ageHours = Math.round(snapshotAgeHours(snapshot));
                staleNote = `;快照已 ${ageHours}h 未刷新`;
            }
        }
        catch (error) {
            const reason = sanitizeOpsSummary(error, 160);
            if (snapshot) {
                staleNote = `;快照刷新失败${reason ? `(${reason})` : ''}`;
            }
        }
    }
    if (!snapshot) {
        return NORTH_STAR_RULES.map(([key, title]) => observation(config, {
            key,
            title,
            severity: 'warning',
            unhealthy: false,
            unknown: true,
            summary: '北极星快照不可用,当前无法评估',
        }));
    }
    const hitRule = config.rules['north-star-skill-hit-rate'];
    const consistencyRule = config.rules['north-star-ai-human-consistency'];
    const retentionRule = config.rules['north-star-retention-d1'];
    const firstSuccessRule = config.rules['north-star-first-success-rate'];
    return [
        rateObservation(config, 'north-star-skill-hit-rate', NORTH_STAR_RULES[0][1], snapshot.skillHitRate7d, snapshot.skillHitSamples7d, `Skill 命中率(7 天)${percent(snapshot.skillHitRate7d)}(样本 ${snapshot.skillHitSamples7d}，预警 <${hitRule.threshold}%，严重 <${hitRule.criticalThreshold}%)${staleNote}`),
        rateObservation(config, 'north-star-ai-human-consistency', NORTH_STAR_RULES[1][1], snapshot.aiHumanConsistency, snapshot.aiHumanSample, `AI 审核一致率 ${percent(snapshot.aiHumanConsistency)}(样本 ${snapshot.aiHumanSample}，产品目标 ≥90%，预警 <${consistencyRule.threshold}%，严重 <${consistencyRule.criticalThreshold}%)${staleNote}`),
        rateObservation(config, 'north-star-retention-d1', NORTH_STAR_RULES[2][1], snapshot.d1RetentionRate, snapshot.d1Eligible, `新账号次日留存 ${percent(snapshot.d1RetentionRate)}(30 天注册 cohort，样本 ${snapshot.d1Eligible}，预警 <${retentionRule.threshold}%，严重 <${retentionRule.criticalThreshold}%)${staleNote}`),
        rateObservation(config, 'north-star-first-success-rate', NORTH_STAR_RULES[3][1], snapshot.firstSuccessRate, snapshot.registered30d, `新账号首次成功率 ${percent(snapshot.firstSuccessRate)}(30 天注册 ${snapshot.registered30d}，预警 <${firstSuccessRule.threshold}%，严重 <${firstSuccessRule.criticalThreshold}%)${staleNote}`),
    ];
}
