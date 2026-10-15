import { CLIENT_ERROR_NON_ACTIONABLE_API_CODES } from '../../shared/client-error-telemetry.js';
import type { AlertEvidence, AlertEvidenceGroup, AlertEvidenceSample } from './studio-alert-evidence-types.js';

type Pool = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
const EVENT_RULES = new Set(['tool-failure-repeat', 'sso-infrastructure-failure', 'api-5xx-spike']);
const RUN_RULES = new Set(['ai-run-degraded-rate', 'ai-auth-or-quota']);
// Only explicitly infrastructure-owned signals may declare account dimensions
// inapplicable. Missing collectors and future/custom rules are not proof of that.
const INFRASTRUCTURE_RULES = new Set([
  'agent-model-target-degraded', 'process-unhandled-error', 'disk-space',
  'node-memory-pressure', 'node-cpu-load', 'evolution-worker-health',
  'otlp-trace-freshness', 'service-crash-signature', 'nginx-5xx-log',
  'postgres-error-log', 'internal-health', 'public-health', 'central-database',
  'synthetic-login', 'synthetic-ai-chat', 'synthetic-tool-call',
  'external-dns', 'external-tls', 'external-health', 'external-entry-asset',
]);
const GROUP_LIMIT = 8;
const SAMPLE_LIMIT = 20;

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number))) : 0;
}

// The selected columns are identifiers and codes, never arbitrary error text.
// Reject path/credential-shaped content even if a producer put it in a label.
function label(value: unknown, max = 120): string | null {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f/\\=<>]/.test(text)) return null;
  if (/\bBearer\s|\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{12,})|\b(?:password|token|secret|cookie|authorization|api[_-]?key)\s*:/i.test(text)) return null;
  return /^[\p{L}\p{N}_.:@+ ()-]+$/u.test(text) ? text : null;
}

function version(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(text) && text.length <= 64 ? text.replace(/^v/, '') : null;
}

function moduleLabel(row: Record<string, unknown>): string {
  const explicit = label(row.module_hint);
  if (explicit) return explicit;
  if (row.tool_name === 'device_file_download_to_local') return '设备文件传输';
  return label(row.component) ?? '未标明组件';
}

function projectGroup(row: Record<string, unknown>): AlertEvidenceGroup {
  return {
    accountId: label(row.account_id, 160),
    appVersion: version(row.app_version),
    clientType: label(row.client_type, 32),
    module: moduleLabel(row),
    failureCount: count(row.failure_count),
    runCount: count(row.run_count),
  };
}

function projectSample(row: Record<string, unknown>): AlertEvidenceSample | null {
  const eventId = label(row.event_id, 100);
  const occurred = Date.parse(String(row.occurred_at ?? ''));
  if (!eventId || !Number.isFinite(occurred)) return null;
  return {
    eventId,
    occurredAt: new Date(occurred).toISOString(),
    accountId: label(row.account_id, 160),
    appVersion: version(row.app_version),
    clientType: label(row.client_type, 32),
    module: moduleLabel(row),
    toolName: label(row.tool_name, 120),
    failureCategory: label(row.failure_category, 80),
    failureDetail: label(row.failure_detail, 120),
  };
}

const CLIENT_PROBLEM_SQL = `e.event_code = 'client_error' and e.outcome = 'error'
  and e.metadata->>'operational' = 'true'
  and coalesce(e.metadata->>'environment', 'production') not in ('development', 'test')
  and not (coalesce(e.metadata->>'code', '') = any($5::text[]))
  and coalesce(e.metadata->>'route', '') not like '%://localhost:5173/%'
  and coalesce(e.safe_summary, '') !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
  and not (coalesce(e.metadata->>'source', '') = 'resource_error'
           and coalesce(e.metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)')
  and not (coalesce(e.metadata->>'source', '') = 'api_error' and coalesce(e.metadata->>'status', '') ~ '^5[0-9]{2}$')
  and not (coalesce(e.metadata->>'source', '') = 'electron_child_gone'
           and (lower(coalesce(e.metadata->>'code', '')) in ('15', 'sigterm') or coalesce(e.safe_summary, '') ~* 'signal=SIGTERM'))
  and not (coalesce(e.metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
           and coalesce(e.metadata->>'code', '') = '1073807364' and coalesce(e.safe_summary, '') ~* '(killed|embedded server exited)')
  and coalesce(e.safe_summary, '') !~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
  and coalesce(e.metadata->>'top_frame', '') not like '%://localhost:5173/%'`;

function eventSource(alertKey: string, tenantId: string): string {
  const table = tenantId === 'platform' ? 'studio_ops_events' : 'studio_ops_events_tenant';
  const predicate = alertKey === 'tool-failure-repeat'
    ? "e.event_code = 'tool_call' and e.outcome = 'error'"
    : alertKey === 'sso-infrastructure-failure'
      ? "e.event_code = 'sso_login_attempt' and e.outcome = 'error'"
      : `((e.event_code = 'http_5xx' and e.outcome = 'error'
            and not (coalesce(e.metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
                     and coalesce(e.metadata->>'status', '') in ('503', '504')))
          or (${CLIENT_PROBLEM_SQL}))`;
  return `select e.id::text event_id, e.occurred_at,
      coalesce(nullif(trim(e.correlation->>'user_id'), ''), nullif(trim(e.metadata->>'sso_user_id'), '')) account_id,
      coalesce(nullif(trim(e.correlation->>'environment'), ''), nullif(trim(e.metadata->>'environment'), ''), 'production') environment,
      coalesce(nullif(trim(e.correlation->>'run_id'), ''), nullif(trim(e.metadata->>'run_id'), '')) run_id,
      coalesce(nullif(trim(e.correlation->>'app_version'), ''), nullif(trim(e.metadata->>'app_version'), ''), nullif(trim(e.metadata->>'release'), '')) app_version,
      coalesce(nullif(trim(e.correlation->>'client_type'), ''), nullif(trim(e.metadata->>'client_type'), '')) client_type,
      coalesce(nullif(trim(e.metadata->>'feature_module'), ''), nullif(trim(e.metadata->>'module'), ''), nullif(trim(e.metadata->>'surface'), '')) module_hint,
      nullif(trim(e.component), '') component,
      coalesce(nullif(trim(e.metadata->>'tool_name'), ''), 'unknown') tool_name,
      coalesce(nullif(trim(e.metadata->>'failure_category'), ''), nullif(trim(e.metadata->>'error_category'), '')) failure_category,
      coalesce(nullif(trim(e.metadata->>'error_code'), ''), nullif(trim(e.metadata->>'code'), ''),
               case when e.metadata->>'status' ~ '^[45][0-9]{2}$' then 'HTTP ' || (e.metadata->>'status') end) failure_detail,
      case when coalesce(e.metadata->>'failure_category', '') = 'legacy_unclassified'
           then coalesce(nullif(e.metadata->>'run_id', ''), nullif(e.correlation->>'run_id', ''), e.id::text)
           else coalesce(nullif(e.metadata->>'tool_call_id', ''), nullif(e.metadata->>'attempt', ''), e.id::text)
      end failure_unit,
      -- The client telemetry ingress bounds each stored batch to 1..100 occurrences.
      -- Other event types represent one occurrence per stored record.
      case when e.event_code = 'client_error' then greatest(1,
        case when e.metadata->>'occurrence_count' ~ '^[0-9]{1,9}$'
             then least(100, (e.metadata->>'occurrence_count')::int)
             when e.metadata->>'occurrence_count' ~ '^[0-9]+$' then 100 else 1 end)
        else 1 end failure_weight
    from public.${table} e
    where e.occurred_at >= $1::timestamptz - make_interval(mins => $2::int)
      and e.occurred_at <= $1::timestamptz
      and e.tenant_id = $3::text
      and coalesce(e.metadata->>'client_type', '') <> 'local-dev'
      and coalesce(e.correlation->>'client_type', '') <> 'local-dev'
      and (${predicate})`;
}

function runSource(alertKey: string): string {
  const predicate = alertKey === 'ai-auth-or-quota'
    ? `lower(coalesce(error_category, '')) in ('auth', 'quota_exceeded', 'rate_limit')
       or lower(coalesce(error_detail, '')) ~ '(no_api_key|unauthori[sz]ed|api.?key|token.*limit|quota|余额不足|用量上限)'`
    : `outcome = 'error' or (outcome = 'completed_partial'
       and not (coalesce(error_detail, '') ~ 'partial_reason=(acceptance_audit|actuation_guard|tool_intent_only|tool_loop_guard)'
         or (coalesce(error_detail, '') = '' and tool_call_count = 0 and coalesce(completion_tokens, 0) > 0)))`;
  return `select null::text event_id, started_at occurred_at, account_id, environment, run_id,
      run_json->>'app_version' app_version, run_json->>'client_type' client_type,
      coalesce(nullif(trim(run_json->>'feature_module'), ''), nullif(trim(run_json->>'module'), ''), nullif(trim(run_json->>'surface'), '')) module_hint,
      'agent_run_records'::text component, null::text tool_name, error_category failure_category,
      null::text failure_detail, run_id failure_unit, 1::int failure_weight
    from (
      select distinct on (nullif(trim(r.sso_user_id), ''),
        coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production'), r.run_id)
        nullif(trim(r.sso_user_id), '') account_id,
        coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production') environment,
        r.run_id, r.started_at, r.outcome, r.error_category, r.error_detail,
        r.tool_call_count, r.completion_tokens, to_jsonb(r) run_json
      from public.agent_run_records r
      where r.started_at >= $1::timestamptz - make_interval(mins => $2::int)
        and r.started_at <= $1::timestamptz and r.created_at <= $1::timestamptz
        and coalesce(r.client_type, '') <> 'local-dev' and $3::text = 'platform'
      order by nullif(trim(r.sso_user_id), ''), coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production'), r.run_id, r.created_at desc
    ) latest where (${predicate})`;
}

/** Full-window counts are calculated before limiting either groups or samples. */
function aggregationSql(source: string, toolRule: boolean): string {
  return `with raw as (${source}), keyed as (
      select raw.*,
        coalesce(module_hint,
          case when tool_name = 'device_file_download_to_local' then '设备文件传输' end,
          component, '未标明组件') module_key,
        case when run_id is not null and account_id is not null
               and environment in ('production', 'staging', 'development', 'test')
             then jsonb_build_array(account_id, environment, run_id)::text end run_key,
        jsonb_build_array(account_id, environment, run_id, failure_unit)::text failure_key
      from raw
    ), top_tool as (
      select tool_name from keyed group by tool_name
      order by count(distinct failure_key) desc, count(*) desc, tool_name limit 1
    ), selected as (
      select * from keyed ${toolRule ? 'where tool_name = coalesce($4::text, (select tool_name from top_tool))' : 'where $4::text is null'}
    ), grouped as (
      select account_id, app_version, client_type, module_key module_hint,
             ${toolRule ? 'count(distinct failure_key)' : 'sum(failure_weight)'}::bigint failure_count,
             count(distinct run_key)::int run_count
      from selected group by account_id, app_version, client_type, module_key
    ), bounded_groups as (
      select * from grouped order by failure_count desc, account_id nulls last,
        app_version nulls last, client_type nulls last, module_hint nulls last limit ${GROUP_LIMIT}
    ), bounded_samples as (
      select event_id, occurred_at, account_id, app_version, client_type, module_hint, component, tool_name, failure_category, failure_detail
      from selected where event_id is not null order by occurred_at desc, event_id desc limit ${SAMPLE_LIMIT}
    ) select (select count(*)::int from selected) event_count,
      (select count(distinct run_key)::int from selected) run_count,
      (select count(*)::int from grouped) total_groups,
      coalesce((select jsonb_agg(to_jsonb(g)) from bounded_groups g), '[]'::jsonb) groups,
      coalesce((select jsonb_agg(to_jsonb(s)) from bounded_samples s), '[]'::jsonb) samples`;
}

/** Safe operational dimensions only; no prompt, completion, tool payload or raw error text. */
export async function collectAlertEvidence(
  p: Pool,
  alertKey: string,
  windowMinutes: number,
  at: Date | string,
  tenantId = 'platform',
  toolName?: string,
): Promise<AlertEvidence> {
  const end = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(end)) throw new Error('invalid_alert_evidence_time');
  const minutes = Math.max(1, Math.min(10_080, Math.floor(Number(windowMinutes) || 1)));
  const supported = EVENT_RULES.has(alertKey) || RUN_RULES.has(alertKey);
  const evidence: AlertEvidence = {
    source: 'evaluation', capturedAt: new Date().toISOString(),
    windowStart: new Date(end - minutes * 60_000).toISOString(), windowEnd: new Date(end).toISOString(),
    eventCount: 0, runCount: 0, totalGroups: 0, groups: [], samples: [],
    applicability: INFRASTRUCTURE_RULES.has(alertKey) ? 'infrastructure' : 'business',
  };
  if (!supported) return evidence;
  if (RUN_RULES.has(alertKey) && tenantId !== 'platform') throw new Error('tenant_run_evidence_unavailable');
  const toolRule = alertKey === 'tool-failure-repeat';
  const source = EVENT_RULES.has(alertKey) ? eventSource(alertKey, tenantId) : runSource(alertKey);
  const values: unknown[] = [evidence.windowEnd, minutes, tenantId, toolRule ? toolName ?? null : null];
  if (alertKey === 'api-5xx-spike') values.push([...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]);
  const result = await p.query(aggregationSql(source, toolRule), values);
  const row = result.rows[0] ?? {};
  const records = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  evidence.eventCount = count(row.event_count);
  evidence.runCount = count(row.run_count);
  evidence.totalGroups = count(row.total_groups);
  evidence.groups = records(row.groups).slice(0, GROUP_LIMIT).map(projectGroup);
  evidence.samples = records(row.samples).slice(0, SAMPLE_LIMIT).flatMap((sample) => {
    const projected = projectSample(sample);
    return projected ? [projected] : [];
  });
  return evidence;
}
