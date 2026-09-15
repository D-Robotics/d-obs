/**
 * Bounded Agent Run listing for the operations dashboard.
 *
 * The detail reader lives in run-observability-service.ts.  This module only
 * selects the latest low-sensitivity row for each run and issues opaque,
 * short-lived locators.  It deliberately does not select prompts, output,
 * error detail, dispatch JSON, or account identifiers for the response.
 */
import { getPostgresDashboardPool } from '../monitoring/postgres-dashboard-store.js';
import { clientReportedStudioVersion } from '../telemetry-identity.js';
import { issueRunLocator, issueScopeCursor, verifyScopeCursor, runDisplayRef, scopedDisplayRef, } from './run-locator.js';
import { projectStudioTraceCoverage } from '../../shared/studio-trace-coverage.js';
export const OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE = 'ops-admin';
export class InvalidTraceCursorError extends Error {
    code = 'invalid_trace_cursor';
    constructor() {
        super('invalid_trace_cursor');
    }
}
const ENVIRONMENTS = new Set([
    'production',
    'staging',
    'development',
    'test',
]);
function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
function text(value, max = 160) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, max);
}
function iso(value) {
    if (value instanceof Date)
        return value.toISOString();
    const raw = text(value, 64);
    return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}
function stringArray(value, max = 24) {
    if (!Array.isArray(value))
        return [];
    return value
        .slice(0, max)
        .map((item) => text(item, 100))
        .filter(Boolean);
}
function environment(value) {
    const candidate = text(value, 24).toLowerCase();
    return ENVIRONMENTS.has(candidate) ? candidate : 'production';
}
function surface(value) {
    const candidate = text(value, 32).toLowerCase();
    if (candidate === 'desktop' || candidate === 'electron')
        return 'desktop';
    if (candidate === 'web-self-host' || candidate === 'self-host')
        return 'web-self-host';
    if (candidate === 'local-dev')
        return 'local-dev';
    if (candidate === 'miniapp')
        return 'miniapp';
    return 'web-cloud';
}
function tieBreaker(accountScopeId, runId) {
    return `${accountScopeId.length}:${accountScopeId}:${runId.length}:${runId}`.slice(0, 512);
}
function fallbackPage(environmentValue, limit, windowStart, windowEnd, snapshotAt) {
    return {
        runTraces: [],
        runTracePage: {
            environment: environmentValue,
            limit,
            nextCursor: null,
            windowStart: new Date(windowStart).toISOString(),
            windowEnd: new Date(windowEnd).toISOString(),
            snapshotAt: new Date(snapshotAt).toISOString(),
        },
    };
}
/** Read the latest account-scoped row for each run, with no raw identifiers returned. */
export async function getRunTraceList(options) {
    const hours = Math.max(1, Math.min(168, Math.floor(Number(options.hours) || 24)));
    const environmentValue = ENVIRONMENTS.has(options.environment ?? 'production')
        ? (options.environment ?? 'production')
        : 'production';
    const limit = Math.max(1, Math.min(80, Math.floor(Number(options.limit) || 40)));
    const cursorScope = options.cursorScope ?? {
        kind: 'administrator',
        selectedAccountScopeId: OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE,
    };
    const now = Date.now();
    let cursor = null;
    if (options.cursor) {
        cursor = verifyScopeCursor(options.cursor, cursorScope, environmentValue, now);
        if (!cursor)
            throw new InvalidTraceCursorError();
    }
    const windowEnd = cursor?.windowEnd ?? now;
    const windowStart = cursor?.windowStart ?? windowEnd - hours * 60 * 60_000;
    const snapshotAt = cursor?.snapshotAt ?? windowEnd;
    const pool = options.pool ?? (await getPostgresDashboardPool());
    // `environment` is present on current central rows.  The JSON fallback is
    // retained for older rows created before the explicit column was added.
    const result = await pool.query(`with candidates as (
       select r.run_id,
              nullif(trim(r.sso_user_id), '') account_scope_id,
              case
                when coalesce(to_jsonb(r)->>'client_type', '') = 'local-dev' then 'development'
                else coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production')
              end run_environment,
              r.device_id, r.device_model, r.channel, r.outcome,
              r.started_at, r.completed_at, r.elapsed_ms,
              to_jsonb(r)->>'first_text_ms' first_text_ms,
              to_jsonb(r)->>'retry_count' retry_count, r.tool_call_count, r.tool_sequence,
              r.prompt_tokens, r.completion_tokens, r.model,
              to_jsonb(r)->>'error_category' error_category,
              to_jsonb(r)->>'client_type' client_type,
              to_jsonb(r)->>'app_version' app_version,
              nullif(trim(to_jsonb(r)->>'session_id'), '') session_id,
              r.created_at
         from public.agent_run_records r
        where r.started_at >= to_timestamp($1::double precision / 1000.0)
          and r.started_at <= to_timestamp($2::double precision / 1000.0)
          and r.created_at <= to_timestamp($3::double precision / 1000.0)
          and nullif(trim(r.sso_user_id), '') is not null
          and (coalesce(to_jsonb(r)->>'client_type', '') <> 'local-dev' or $4::text = 'development')
     ), latest as (
       select distinct on (account_scope_id, run_environment, run_id) *
         from candidates
        where run_environment = $4
          and not exists (
            select 1
              from public.studio_telemetry_tombstones tombstone
             where tombstone.account_scope_id = candidates.account_scope_id
               and tombstone.environment = candidates.run_environment
               and (tombstone.user_id is null or tombstone.user_id = candidates.account_scope_id)
               and (tombstone.run_id is null or tombstone.run_id = candidates.run_id)
               and (tombstone.session_id is null or tombstone.session_id = candidates.session_id)
               and tombstone.trace_id is null
               and tombstone.grant_id is null
          )
        order by account_scope_id, run_environment, run_id, created_at desc
     ), keyed as (
       select latest.*,
              floor(extract(epoch from started_at) * 1000)::bigint sort_time_ms,
              length(account_scope_id)::text || ':' || account_scope_id || ':' ||
                length(run_id)::text || ':' || run_id tie_breaker
         from latest
     )
     select * from keyed
      where $5::bigint is null
         or sort_time_ms < $5::bigint
         or (sort_time_ms = $5::bigint and tie_breaker > $6::text)
      order by sort_time_ms desc, tie_breaker
      limit $7::int`, [
        windowStart,
        windowEnd,
        snapshotAt,
        environmentValue,
        cursor?.sortTime ?? null,
        cursor?.tieBreaker ?? '',
        limit + 1,
    ]);
    const rows = result.rows.slice(0, limit);
    const nextRow = rows.at(-1);
    const nextCursor = result.rows.length > limit && nextRow
        ? issueScopeCursor({
            accountScopeId: cursorScope.kind === 'owner'
                ? cursorScope.accountScopeId
                : OPS_OBSERVABILITY_TRACE_CURSOR_SCOPE,
            environment: environmentValue,
            sortTime: number(nextRow.sort_time_ms),
            tieBreaker: text(nextRow.tie_breaker, 512),
            windowStart,
            windowEnd,
            snapshotAt,
        })
        : null;
    const runTraces = rows.flatMap((row) => {
        const accountScopeId = text(row.account_scope_id, 256);
        const runId = text(row.run_id, 200);
        const runEnvironment = environment(row.run_environment);
        if (!accountScopeId || !runId)
            return [];
        const locator = issueRunLocator({
            accountScopeId,
            environment: runEnvironment,
            runId,
        });
        if (!locator)
            return [];
        const runRef = runDisplayRef(accountScopeId, runEnvironment, runId);
        const clientType = text(row.client_type, 32) || null;
        const studioVersion = clientReportedStudioVersion(row.app_version) ?? null;
        const producerSurface = surface(clientType);
        const observedSegments = [];
        const coverage = projectStudioTraceCoverage({
            surface: producerSurface,
            ...(studioVersion ? { studioVersion } : {}),
            admittedAt: iso(row.started_at) ? Date.parse(String(iso(row.started_at))) : undefined,
            observedSegments,
            hasRunSummary: false,
        });
        return [
            {
                runRef,
                locator,
                environment: runEnvironment,
                startedAt: iso(row.started_at),
                completedAt: iso(row.completed_at),
                outcome: text(row.outcome, 40) || 'unknown',
                elapsedMs: number(row.elapsed_ms),
                firstTextMs: number(row.first_text_ms),
                retryCount: number(row.retry_count),
                toolCallCount: number(row.tool_call_count),
                toolSequence: stringArray(row.tool_sequence),
                userRef: scopedDisplayRef('user', accountScopeId, runEnvironment, accountScopeId),
                sessionRef: scopedDisplayRef('session', accountScopeId, runEnvironment, text(row.session_id, 256)),
                deviceRef: scopedDisplayRef('device', accountScopeId, runEnvironment, text(row.device_id, 256)),
                promptTokens: number(row.prompt_tokens),
                completionTokens: number(row.completion_tokens),
                model: text(row.model, 120) || null,
                errorCategory: text(row.error_category, 120) || null,
                clientType,
                channel: text(row.channel, 64) || null,
                appVersion: studioVersion,
                deviceModel: text(row.device_model, 120) || null,
                clientSpanCount: 0,
                serverSpanCount: 0,
                clientDurationMs: 0,
                traceCount: 0,
                coverage: { ...coverage, spanCount: 0, observedSegments },
                producer: {
                    surface: producerSurface,
                    studioVersion,
                    mossVersion: null,
                    mocVersion: null,
                },
                evidence: { runSummary: false, operations: 0, productEvents: 0 },
            },
        ];
    });
    return {
        runTraces,
        runTracePage: {
            environment: environmentValue,
            limit,
            nextCursor,
            windowStart: new Date(windowStart).toISOString(),
            windowEnd: new Date(windowEnd).toISOString(),
            snapshotAt: new Date(snapshotAt).toISOString(),
        },
    };
}
export function emptyRunTraceListPage(hours, environmentValue = 'production') {
    const now = Date.now();
    return fallbackPage(environmentValue, 40, now - Math.max(1, Math.min(168, Math.floor(Number(hours) || 24))) * 60 * 60_000, now, now);
}
