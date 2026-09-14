import { getResolvedSupabaseTable } from '../supabase-embedded-config.js';
import { getSharedSupabaseClient } from '../supabase-conversation.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

type ConversationAggregateRead = {
  result: PgQueryResult;
  source: 'supabase' | 'central';
};

/** DAU uses stable SSO ids first; legacy rows fall back to their anonymous/display key. */
export function readDailyActiveUsers(p: Pool, days: number): Promise<PgQueryResult> {
  return p.query(
    `select day::text as day, count(distinct actor)::int dau from (
       select usage_date as day,
              coalesce(nullif(trim(sso_user_id), ''), nullif(trim(anonymous_id), '')) as actor
         from studio_daily_usage where usage_date >= (current_date - $1::int)
       union all
       select recorded_at::date as day,
              coalesce(nullif(trim(sso_user_id), ''), nullif(trim(sso_user_name), '')) as actor
         from conversation_turns where recorded_at >= (current_date - $1::int)
     ) a
     where actor is not null
       and actor not like 'RDK Studio·%'
       and actor not like '定时任务%'
       and actor !~* 'codex-(debug|postrelease)|local-(agent|context)|-verify|moss-filter'
     group by day order by day`,
    [days],
  );
}

/** Supabase is the complete historical read source until central backfill is finished. */
async function readSupabaseConversationAggregate(days: number): Promise<PgQueryResult | null> {
  const client = getSharedSupabaseClient({ requestTimeoutMs: 30_000 });
  if (!client) return null;

  const table = getResolvedSupabaseTable().trim() || 'conversation_turns';
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [total, completed, partial, cancelled, latest] = await Promise.all([
    client.from(table).select('id', { count: 'exact', head: true }).gte('recorded_at', since),
    client.from(table).select('id', { count: 'exact', head: true }).gte('recorded_at', since).eq('outcome', 'completed'),
    client.from(table).select('id', { count: 'exact', head: true }).gte('recorded_at', since).eq('outcome', 'completed_partial'),
    client.from(table).select('id', { count: 'exact', head: true }).gte('recorded_at', since).eq('outcome', 'cancelled'),
    client.from(table).select('recorded_at').gte('recorded_at', since).order('recorded_at', { ascending: false }).limit(1),
  ]);

  if (total.error || completed.error || partial.error || cancelled.error || latest.error) return null;
  const totalCount = total.count ?? 0;
  const completedCount = completed.count ?? 0;
  const partialCount = partial.count ?? 0;
  const cancelledCount = cancelled.count ?? 0;
  return {
    rows: [{
      total: totalCount,
      ok: completedCount + partialCount,
      err: Math.max(0, totalCount - completedCount - partialCount - cancelledCount),
      last_at: latest.data?.[0]?.recorded_at ?? null,
    }],
    rowCount: 1,
  };
}

export async function readConversationAggregate(
  p: Pool,
  days: number,
): Promise<ConversationAggregateRead> {
  try {
    const result = await readSupabaseConversationAggregate(days);
    if (result) return { result, source: 'supabase' };
  } catch {
    // Supabase failure only changes the read source; writes remain independent.
  }
  return {
    result: await p.query(
      `select count(*)::int total,
              count(*) filter (where outcome in ('completed','completed_partial'))::int ok,
              count(*) filter (where outcome not in ('completed','completed_partial','cancelled'))::int err,
              max(recorded_at)::text last_at
       from conversation_turns
       where recorded_at >= now() - make_interval(days => $1::int)`,
      [days],
    ),
    source: 'central',
  };
}
