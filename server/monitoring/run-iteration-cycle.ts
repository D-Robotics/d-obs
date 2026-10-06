/**
 * 失败后迭代周期（研发反馈周期）聚合。
 *
 * 度量 agent_run_records 中「失败运行 → 下一次运行（重试）」与「失败运行 → 下一次成功（修复）」
 * 的间隔分布。反馈周期是研发效率的核心变量：周期越短，同一问题的迭代收敛越快。
 *
 * 口径边界（诚实标注，随响应返回）：
 * - 运行记录无任务级键，按 sso_user_id 的时间线配对——是研发迭代周期的近似，不是精确任务闭环；
 * - 上游 outcome 为自由文本。成功词表 = {completed, success, succeeded, ok}；失败词表 =
 *   {error, failed, cancelled, canceled, timeout, aborted}；两表都不命中的取值（如
 *   completed_partial）计为「中性」，不参与迭代配对——响应携带 outcome 分布供交叉核对
 *   （2026-10-05 生产实测词表：completed/completed_partial/error/cancelled）；
 * - 配对窗口 72 小时，避免把数天后的无关运行算进同一次迭代；
 * - 数据源 RDK_CHAT_CREDITS_DB_URL，未配置或查询失败时抛错，由路由按 503 降级，不拖垮其余视图。
 */

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

const SUCCESS_OUTCOME_WORDS = ['completed', 'success', 'succeeded', 'ok'];
const FAILURE_OUTCOME_WORDS = ['error', 'failed', 'cancelled', 'canceled', 'timeout', 'aborted'];
const PAIRING_WINDOW_HOURS = 72;

export function isSuccessOutcome(outcome: unknown): boolean {
  const value = String(outcome ?? '')
    .trim()
    .toLowerCase();
  return SUCCESS_OUTCOME_WORDS.includes(value);
}

export function isFailureOutcome(outcome: unknown): boolean {
  const value = String(outcome ?? '')
    .trim()
    .toLowerCase();
  return FAILURE_OUTCOME_WORDS.includes(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface IterationGapStats {
  paired: number;
  within1hRate: number | null;
  within24hRate: number | null;
  medianMinutes: number | null;
  p80Minutes: number | null;
}

export interface IterationCategoryStats {
  category: string;
  failed: number;
  recoveryPaired: number;
  medianMinutes: number | null;
  p80Minutes: number | null;
}

export interface RunIterationCycleSummary {
  days: number;
  runsTotal: number;
  successRuns: number;
  failureRuns: number;
  neutralRuns: number;
  successRate: number | null;
  outcomeBreakdown: Array<{ outcome: string; count: number }>;
  byCategory: IterationCategoryStats[];
  retry: IterationGapStats;
  recovery: IterationGapStats;
  pairingWindowHours: number;
  caveat: string;
}

/** 把聚合 SQL 的单行结果映射为响应结构。null 安全：任何缺口都落为 null/0，不抛错。 */
export function mapIterationRow(
  row: Record<string, unknown>,
  outcomeBreakdown: Array<{ outcome: string; count: number }>,
  byCategory: IterationCategoryStats[],
  days: number,
): RunIterationCycleSummary {
  const runsTotal = num(row.runs_total) ?? 0;
  const successRuns = num(row.success_total) ?? 0;
  const failureRuns = num(row.failed_total) ?? 0;
  const retry: IterationGapStats = {
    paired: num(row.retry_paired) ?? 0,
    within1hRate: num(row.retry_within_1h),
    within24hRate: num(row.retry_within_24h),
    medianMinutes: num(row.retry_p50) === null ? null : round1(num(row.retry_p50) as number),
    p80Minutes: num(row.retry_p80) === null ? null : round1(num(row.retry_p80) as number),
  };
  const recovery: IterationGapStats = {
    paired: num(row.recovery_paired) ?? 0,
    within1hRate: null,
    within24hRate: null,
    medianMinutes: num(row.recovery_p50) === null ? null : round1(num(row.recovery_p50) as number),
    p80Minutes: num(row.recovery_p80) === null ? null : round1(num(row.recovery_p80) as number),
  };
  return {
    days,
    runsTotal,
    successRuns,
    failureRuns,
    neutralRuns: Math.max(0, runsTotal - successRuns - failureRuns),
    successRate: runsTotal > 0 ? round1(successRuns / runsTotal) : null,
    outcomeBreakdown,
    byCategory,
    retry,
    recovery,
    pairingWindowHours: PAIRING_WINDOW_HOURS,
    caveat:
      '按用户运行时间线配对（运行记录无任务级键）；成功词表 completed/success/succeeded/ok，失败词表 error/failed/cancelled/canceled/timeout/aborted，两表皆不命中（如 completed_partial）计为中性、不参与配对',
  };
}

const AGGREGATE_SQL = `
with runs as (
  select sso_user_id,
         lower(btrim(outcome)) as outcome,
         started_at
    from public.agent_run_records
   where started_at >= now() - make_interval(days => $1::int)
     and coalesce(btrim(sso_user_id), '') <> ''
),
seq as (
  select sso_user_id,
         outcome,
         started_at,
         lead(started_at) over (partition by sso_user_id order by started_at) as next_started,
         min(case when outcome = any($2::text[]) then started_at end)
           over (partition by sso_user_id order by started_at rows between current row and unbounded following)
           as next_success_at
    from runs
),
failed as (
  select * from seq where outcome = any($4::text[])
),
retry_pairs as (
  select extract(epoch from (next_started - started_at)) / 60 as gap_minutes
    from failed
   where next_started is not null
     and next_started - started_at <= make_interval(hours => $3::int)
),
recovery_pairs as (
  select extract(epoch from (next_success_at - started_at)) / 60 as gap_minutes
    from failed
   where next_success_at is not null
     and next_success_at - started_at <= make_interval(hours => $3::int)
)
select
  (select count(*) from runs) as runs_total,
  (select count(*) from runs where outcome = any($2::text[])) as success_total,
  (select count(*) from failed) as failed_total,
  (select count(*) from retry_pairs) as retry_paired,
  (select percentile_cont(0.5) within group (order by gap_minutes) from retry_pairs) as retry_p50,
  (select percentile_cont(0.8) within group (order by gap_minutes) from retry_pairs) as retry_p80,
  (select avg(case when gap_minutes <= 60 then 1.0 else 0.0 end) from retry_pairs) as retry_within_1h,
  (select avg(case when gap_minutes <= 1440 then 1.0 else 0.0 end) from retry_pairs) as retry_within_24h,
  (select count(*) from recovery_pairs) as recovery_paired,
  (select percentile_cont(0.5) within group (order by gap_minutes) from recovery_pairs) as recovery_p50,
  (select percentile_cont(0.8) within group (order by gap_minutes) from recovery_pairs) as recovery_p80
`;

/** 失败类别桶映射：error_category 为空的行归「未分类」。null 安全，中位/p80 缺样本时为 null。 */
export function mapCategoryRows(rows: Array<Record<string, unknown>>): IterationCategoryStats[] {
  return rows.map((row) => ({
    category: String(row.category ?? '').trim() || '未分类',
    failed: num(row.failed) ?? 0,
    recoveryPaired: num(row.recovery_paired) ?? 0,
    medianMinutes: num(row.recovery_p50) === null ? null : round1(num(row.recovery_p50) as number),
    p80Minutes: num(row.recovery_p80) === null ? null : round1(num(row.recovery_p80) as number),
  }));
}

const CATEGORY_SQL = `
with runs as (
  select sso_user_id,
         lower(btrim(outcome)) as outcome,
         started_at
    from public.agent_run_records
   where started_at >= now() - make_interval(days => $1::int)
     and coalesce(btrim(sso_user_id), '') <> ''
),
seq as (
  select sso_user_id,
         outcome,
         error_category,
         started_at,
         min(case when outcome = any($2::text[]) then started_at end)
           over (partition by sso_user_id order by started_at rows between current row and unbounded following)
           as next_success_at
    from runs
),
failed as (
  select coalesce(nullif(btrim(error_category), ''), '未分类') as category,
         extract(epoch from (next_success_at - started_at)) / 60 as recovery_gap_minutes
    from seq
   where outcome = any($4::text[])
)
select category,
       count(*) as failed,
       count(*) filter (where recovery_gap_minutes is not null and recovery_gap_minutes <= $3::int * 60) as recovery_paired,
       percentile_cont(0.5) within group (order by recovery_gap_minutes)
         filter (where recovery_gap_minutes <= $3::int * 60) as recovery_p50,
       percentile_cont(0.8) within group (order by recovery_gap_minutes)
         filter (where recovery_gap_minutes <= $3::int * 60) as recovery_p80
  from failed
  group by 1
  order by failed desc
  limit 8
`;

const BREAKDOWN_SQL = `
select lower(btrim(outcome)) as outcome, count(*) as count
  from public.agent_run_records
 where started_at >= now() - make_interval(days => $1::int)
   and coalesce(btrim(sso_user_id), '') <> ''
 group by 1
 order by count desc
 limit 8
`;

let _poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const url = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!url) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置:中心遥测库不可用');
  if (!_poolReady) {
    _poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString: url, max: 2 });
    })().catch((err) => {
      _poolReady = null;
      throw err;
    });
  }
  return _poolReady;
}

export async function loadRunIterationCycle(days: number): Promise<RunIterationCycleSummary> {
  const p = await pool();
  const params = [days, SUCCESS_OUTCOME_WORDS, PAIRING_WINDOW_HOURS, FAILURE_OUTCOME_WORDS];
  const [aggregate, breakdown, categories] = await Promise.all([
    p.query(AGGREGATE_SQL, params),
    p.query(BREAKDOWN_SQL, [days]),
    p.query(CATEGORY_SQL, params),
  ]);
  const outcomeBreakdown = breakdown.rows
    .map((row) => ({ outcome: String(row.outcome ?? '(空)'), count: num(row.count) ?? 0 }))
    .filter((item) => item.count > 0);
  return mapIterationRow(
    aggregate.rows[0] ?? {},
    outcomeBreakdown,
    mapCategoryRows(categories.rows),
    days,
  );
}
