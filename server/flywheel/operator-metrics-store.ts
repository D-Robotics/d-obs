/**
 * Low-sensitivity operator metrics used by the unified observability page.
 *
 * This is intentionally kept separate from FlywheelOverview.  The latter is
 * also consumed by the product growth surface and its schema is deliberately
 * small on the DSH baseline.  Queries here are bounded aggregates only: no
 * account ids, prompts, model output, dispatch reasons, or raw JSON leave the
 * server.
 */
import { getPostgresDashboardPool } from '../monitoring/postgres-dashboard-store.js';
import { readDailyActiveUsers } from './conversation-aggregate-store.js';
import {
  buildAgentDispatchMetrics,
  emptyAgentDispatchMetrics,
  type AgentDispatchMetrics,
} from './agent-dispatch-metrics.js';
import {
  buildModelTokenMetrics,
  emptyModelTokenMetrics,
  type ModelTokenMetrics,
  type ModelTokenMetricRow,
} from './model-token-metrics.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type QueryPool = { query: (sql: string, params?: unknown[]) => Promise<PgQueryResult> };

export interface OperatorDailyPoint {
  day: string;
  newAccounts: number;
  activeUsers: number;
  conversations: number;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OperatorMetrics {
  windowDays: number;
  daily: OperatorDailyPoint[];
  dispatch: AgentDispatchMetrics;
  modelTokens: ModelTokenMetrics;
  totals: {
    newAccounts: number;
    activeUsersPeak: number;
    conversations: number;
    runs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  sources: {
    accounts: string;
    activity: string;
    tokens: string;
    dispatch: string;
  };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function clampDays(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(180, Math.floor(value)));
}

function day(value: unknown): string {
  return String(value ?? '')
    .trim()
    .slice(0, 32);
}

function emptyResult(): PgQueryResult {
  return { rows: [] };
}

/**
 * Read-only aggregate projection.  Every optional source is isolated so a
 * rolling schema upgrade (for example an old database without `source` or
 * `agent_dispatch_plan`) degrades that metric instead of failing the page.
 */
export async function getOperatorMetrics(daysInput = 30): Promise<OperatorMetrics> {
  const windowDays = clampDays(daysInput);
  const pool = (await getPostgresDashboardPool()) as QueryPool;

  let accounts: PgQueryResult = emptyResult();
  let accountSource = 'credit_account.created_at（剔除 supabase_sync / supabase_import）';
  try {
    accounts = await pool.query(
      `select created_at::date::text as day, count(*)::int new_accounts
         from public.credit_account
        where created_at >= now() - make_interval(days => $1::int)
          and coalesce(source, '') not in ('supabase_sync', 'supabase_import')
        group by 1 order by 1`,
      [windowDays],
    );
  } catch {
    // Older central stores may not have credit_account.source yet.
    accountSource = 'credit_account.created_at（旧表无 source，未剔除迁移账号）';
    try {
      accounts = await pool.query(
        `select created_at::date::text as day, count(*)::int new_accounts
           from public.credit_account
          where created_at >= now() - make_interval(days => $1::int)
          group by 1 order by 1`,
        [windowDays],
      );
    } catch {
      accounts = emptyResult();
    }
  }

  // One row per run_id prevents retries/backfills from inflating cost and run
  // totals.  Only numeric aggregates are selected from the run table.
  const [runs, conversations, active, modelRuns] = await Promise.all([
    pool
      .query(
        `with latest_run as (
           select distinct on (run_id)
                  started_at::date::text as day,
                  coalesce(prompt_tokens, 0)::bigint prompt_tokens,
                  coalesce(completion_tokens, 0)::bigint completion_tokens
             from public.agent_run_records
            where started_at >= now() - make_interval(days => $1::int)
              and started_at <= now() + interval '5 minutes'
            order by run_id, coalesce(completed_at, started_at) desc, created_at desc
         )
         select day,
                count(*)::int runs,
                coalesce(sum(prompt_tokens), 0)::bigint prompt_tokens,
                coalesce(sum(completion_tokens), 0)::bigint completion_tokens,
                coalesce(sum(prompt_tokens + completion_tokens), 0)::bigint total_tokens
           from latest_run
          group by 1 order by 1`,
        [windowDays],
      )
      .catch(() => emptyResult()),
    pool
      .query(
        `select recorded_at::date::text as day, count(*)::int conversations
           from public.conversation_turns
          where recorded_at >= now() - make_interval(days => $1::int)
          group by 1 order by 1`,
        [windowDays],
      )
      .catch(() => emptyResult()),
    readDailyActiveUsers(pool, windowDays).catch(() => emptyResult()),
    pool
      .query(
        `with latest_run as (
           select distinct on (run_id)
                  started_at::date::text as day,
                  coalesce(model, '') model,
                  coalesce(prompt_tokens, 0)::bigint prompt_tokens,
                  coalesce(completion_tokens, 0)::bigint completion_tokens
             from public.agent_run_records
            where started_at >= now() - make_interval(days => $1::int)
              and started_at <= now() + interval '5 minutes'
            order by run_id, coalesce(completed_at, started_at) desc, created_at desc
         )
         select day, model, prompt_tokens, completion_tokens
           from latest_run`,
        [windowDays],
      )
      .catch(() => emptyResult()),
  ]);

  // Dispatch receipts are optional during rolling upgrades.  The query only
  // projects an explicit whitelist of booleans/counters; prompt and reason
  // fields are never selected or returned.
  let dispatch = emptyAgentDispatchMetrics(windowDays);
  try {
    const dispatchRows = await pool.query(
      `select started_at::date::text as day,
              coalesce(outcome, '') outcome,
              elapsed_ms,
              coalesce(agent_dispatch_plan->>'executionMode', 'single_agent') execution_mode,
              agent_dispatch_plan->>'classifierEligible' = 'true' classifier_eligible,
              agent_dispatch_plan->>'classifierRequired' = 'true' classifier_required,
              agent_dispatch_plan->>'eligible' = 'true' eligible,
              agent_dispatch_plan->>'required' = 'true' required,
              case
                when coalesce(agent_dispatch_plan->>'hostPreflightAssignments', '') ~ '^[0-9]+$'
                  then (agent_dispatch_plan->>'hostPreflightAssignments')::int
                else 0
              end host_preflight_assignments
         from public.agent_run_records
        where started_at >= now() - make_interval(days => $1::int)
          and started_at <= now() + interval '5 minutes'
          and agent_dispatch_plan is not null
        order by started_at asc`,
      [windowDays],
    );
    dispatch = buildAgentDispatchMetrics(
      dispatchRows.rows.map((row) => ({
        day: day(row.day),
        outcome: String(row.outcome ?? '').slice(0, 40),
        elapsedMs: row.elapsed_ms == null ? null : number(row.elapsed_ms),
        executionMode: String(row.execution_mode ?? 'single_agent').slice(0, 40),
        classifierEligible: row.classifier_eligible === true,
        classifierRequired: row.classifier_required === true,
        eligible: row.eligible === true,
        required: row.required === true,
        hostPreflightAssignments: number(row.host_preflight_assignments),
      })),
      windowDays,
    );
  } catch {
    dispatch = emptyAgentDispatchMetrics(windowDays);
  }

  // Token split by model.  The model column is optional during rolling
  // upgrades; a missing column degrades to "unconfigured" instead of failing
  // the whole metrics response.
  let modelTokens = emptyModelTokenMetrics(windowDays);
  try {
    modelTokens = buildModelTokenMetrics(
      modelRuns.rows.map(
        (row): ModelTokenMetricRow => ({
          day: day(row.day),
          model: String(row.model ?? '').slice(0, 96),
          promptTokens: number(row.prompt_tokens),
          completionTokens: number(row.completion_tokens),
        }),
      ),
      windowDays,
    );
  } catch {
    modelTokens = emptyModelTokenMetrics(windowDays);
  }

  const byDay = new Map<string, OperatorDailyPoint>();
  const ensure = (key: unknown): OperatorDailyPoint | null => {
    const normalized = day(key);
    if (!normalized) return null;
    const existing = byDay.get(normalized);
    if (existing) return existing;
    const created: OperatorDailyPoint = {
      day: normalized,
      newAccounts: 0,
      activeUsers: 0,
      conversations: 0,
      runs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    byDay.set(normalized, created);
    return created;
  };
  for (const row of accounts.rows) {
    const point = ensure(row.day);
    if (point) point.newAccounts = number(row.new_accounts);
  }
  for (const row of active.rows) {
    const point = ensure(row.day);
    if (point) point.activeUsers = number(row.dau);
  }
  for (const row of conversations.rows) {
    const point = ensure(row.day);
    if (point) point.conversations = number(row.conversations);
  }
  for (const row of runs.rows) {
    const point = ensure(row.day);
    if (point) {
      point.runs = number(row.runs);
      point.promptTokens = number(row.prompt_tokens);
      point.completionTokens = number(row.completion_tokens);
      point.totalTokens = number(row.total_tokens);
    }
  }

  const daily = [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
  const totals = daily.reduce(
    (sum, point) => ({
      newAccounts: sum.newAccounts + point.newAccounts,
      activeUsersPeak: Math.max(sum.activeUsersPeak, point.activeUsers),
      conversations: sum.conversations + point.conversations,
      runs: sum.runs + point.runs,
      promptTokens: sum.promptTokens + point.promptTokens,
      completionTokens: sum.completionTokens + point.completionTokens,
      totalTokens: sum.totalTokens + point.totalTokens,
    }),
    {
      newAccounts: 0,
      activeUsersPeak: 0,
      conversations: 0,
      runs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  );

  return {
    windowDays,
    daily,
    dispatch,
    modelTokens,
    totals,
    sources: {
      accounts: accountSource,
      activity: 'conversation_turns + studio_daily_usage（稳定账号聚合）',
      tokens: 'agent_run_records（按 run_id 取最新记录后汇总）',
      dispatch: dispatch.configured
        ? dispatch.sources
        : 'agent_run_records.agent_dispatch_plan（尚未接入或字段未迁移）',
    },
  };
}
