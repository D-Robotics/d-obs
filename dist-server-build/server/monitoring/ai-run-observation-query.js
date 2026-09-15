/**
 * Latest-run aggregation used by the alert worker.
 *
 * Acceptance-audit and actuation-guard partial outcomes are intentional agent
 * behavior. Legacy visible replies without a tool call are likewise not
 * degraded runs, so neither class contributes to the partial failure count.
 */
export const AI_RUN_OBSERVATION_QUERY = `with latest as (
  select distinct on (run_id) run_id, outcome, error_detail, tool_call_count, completion_tokens
  from public.agent_run_records
  where started_at >= now() - make_interval(mins => $1::int)
    and started_at <= now() + interval '5 minutes'
    and coalesce(client_type, '') <> 'local-dev'
  order by run_id, created_at desc
)
select count(*)::int total,
       count(*) filter (where outcome = 'error')::int errors,
       count(*) filter (
         where outcome = 'completed_partial'
           and not (
             coalesce(error_detail, '') ~ 'partial_reason=(acceptance_audit|actuation_guard|tool_intent_only|tool_loop_guard)'
             or (coalesce(error_detail, '') = '' and tool_call_count = 0 and coalesce(completion_tokens, 0) > 0)
           )
       )::int partials
from latest`;
