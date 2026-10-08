/**
 * run 级 score / 反馈的按天聚合（eval 消费者）。
 *
 * 这两张表此前只有写入没有读取；这里提供运营侧的日粒度趋势（反馈量、好评率、
 * 平均评分），让"用户觉得 run 好不好"成为可看、可跟踪的信号。聚合全部在 SQL
 * 侧完成，只回传数字，不含任何消息正文。
 */

export type QualityTrendPoint = {
  day: string;
  feedbackCount: number;
  positiveCount: number;
  positiveRate: number | null;
  scoreCount: number;
  avgScore: number | null;
};

export type QualityTrend = {
  configured: boolean;
  windowDays: number;
  series: QualityTrendPoint[];
  totals: {
    feedbackCount: number;
    positiveCount: number;
    positiveRate: number | null;
    scoreCount: number;
    avgScore: number | null;
  };
};

type PgResult = { rows: Array<Record<string, unknown>> };
type PgPool = { query: (text: string, params?: unknown[]) => Promise<PgResult> };

let poolReady: Promise<PgPool> | null = null;

async function pool(): Promise<PgPool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('public observability database is not configured');
  if (!poolReady) {
    poolReady = import('pg' as string).then((module) => {
      const Pool = (module.default as { Pool: new (config: { connectionString: string; max: number }) => PgPool }).Pool;
      return new Pool({ connectionString, max: 2 });
    }).catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emptyQualityTrend(windowDays: number): QualityTrend {
  return {
    configured: false,
    windowDays,
    series: [],
    totals: { feedbackCount: 0, positiveCount: 0, positiveRate: null, scoreCount: 0, avgScore: null },
  };
}

export async function loadQualityTrend(windowDays = 30): Promise<QualityTrend> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) return emptyQualityTrend(windowDays);
  const days = Math.max(1, Math.min(90, Math.floor(windowDays)));
  const p = await pool();
  let result;
  // 表尚未建立（首次写入前的新部署）时直接按"无数据"返回：查了也是
  // 42P01，应用层能吞，但 PG 会把每条都写进服务端日志变成持续噪音。
  const ready = await p.query(
    `select to_regclass('public.studio_public_observability_feedback') is not null
       and to_regclass('public.studio_public_observability_scores') is not null as ready`,
  );
  if (ready.rows[0]?.ready !== true) return { ...emptyQualityTrend(days), configured: true };
  try {
    result = await p.query(
    `with span as (
       select generate_series(
                (now() - make_interval(days => $1::int - 1))::date,
                now()::date,
                interval '1 day')::date as day
     ), fb as (
       select created_at::date as day,
              count(*) as c,
              sum(case when kind = 'up' then 1 else 0 end)::int as pos
         from public.studio_public_observability_feedback
        where created_at >= now() - make_interval(days => $1::int)
        group by 1
     ), sc as (
       select created_at::date as day,
              count(*) as c,
              avg(value) as v
         from public.studio_public_observability_scores
        where created_at >= now() - make_interval(days => $1::int)
        group by 1
     )
     select span.day::text as day,
            coalesce(fb.c, 0) as feedback_count,
            coalesce(fb.pos, 0) as positive_count,
            coalesce(sc.c, 0) as score_count,
            sc.v as avg_score
       from span
       left join fb on fb.day = span.day
       left join sc on sc.day = span.day
      order by span.day`,
    [days],
    );
  } catch (error) {
    // 表尚未建立（首次写入前的新部署）：视为"无数据"而不是故障。
    if ((error as { code?: string }).code === '42P01') return { ...emptyQualityTrend(days), configured: true };
    throw error;
  }
  const series: QualityTrendPoint[] = result.rows.map((row) => {
    const feedbackCount = finite(row.feedback_count);
    const positiveCount = finite(row.positive_count);
    const scoreCount = finite(row.score_count);
    const avg = row.avg_score == null ? null : Number(row.avg_score);
    return {
      day: String(row.day ?? ''),
      feedbackCount,
      positiveCount,
      positiveRate: feedbackCount > 0 ? positiveCount / feedbackCount : null,
      scoreCount,
      avgScore: avg != null && Number.isFinite(avg) ? Math.round(avg * 1000) / 1000 : null,
    };
  });
  const totals = series.reduce(
    (acc, point) => {
      acc.feedbackCount += point.feedbackCount;
      acc.positiveCount += point.positiveCount;
      acc.scoreCount += point.scoreCount;
      acc.scoreSum += point.avgScore != null ? point.avgScore * point.scoreCount : 0;
      return acc;
    },
    { feedbackCount: 0, positiveCount: 0, scoreCount: 0, scoreSum: 0 },
  );
  return {
    configured: true,
    windowDays: days,
    series,
    totals: {
      feedbackCount: totals.feedbackCount,
      positiveCount: totals.positiveCount,
      positiveRate: totals.feedbackCount > 0 ? totals.positiveCount / totals.feedbackCount : null,
      scoreCount: totals.scoreCount,
      avgScore: totals.scoreCount > 0 ? Math.round((totals.scoreSum / totals.scoreCount) * 1000) / 1000 : null,
    },
  };
}
