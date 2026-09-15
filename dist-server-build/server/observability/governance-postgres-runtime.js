import { REQUIRED_TELEMETRY_PURGE_TARGETS, } from './governance-deletion.js';
import { purgeStudioTraceOutboxByTombstone } from './trace-batch-outbox.js';
/** Enumerates only server-owned scope keys; record cleanup remains per scope. */
export class PostgresGovernanceScopeProvider {
    db;
    constructor(db) {
        this.db = db;
    }
    async listAuthoritativePartitions() {
        const result = await this.db.query(`select distinct scoped.account_scope_id, scoped.environment
       from (
         select account_scope_id, environment from public.studio_trace_spans
         union
         select account_scope_id, environment from public.studio_telemetry_payload_grants
         union
         select account_scope_id, environment from public.studio_telemetry_tombstones
         union
         select account_scope_id, environment from public.studio_trace_backend_mappings
         union
         select account_scope_id, environment from public.agent_run_observability
         where account_scope_id is not null
         union
         select r.sso_user_id as account_scope_id,
                coalesce(
                  nullif(to_jsonb(r)->>'environment', ''),
                  case when coalesce(r.client_type, '') = 'local-dev'
                    then 'development' else 'production' end
                ) as environment
         from public.agent_run_records r
         where nullif(trim(r.sso_user_id), '') is not null
       ) scoped
       where nullif(trim(scoped.account_scope_id), '') is not null
       order by scoped.account_scope_id asc, scoped.environment asc
       limit 10001`);
        if (result.rows.length > 10_000) {
            // A silently truncated partition list could declare restored data ready
            // without applying retention/tombstones to every account.
            throw Object.assign(new Error('governance partition capacity exceeded'), {
                code: 'scope_capacity_exceeded',
            });
        }
        return result.rows.flatMap((row) => {
            const accountScopeId = clean(row.account_scope_id);
            const environment = clean(row.environment, 32);
            return accountScopeId && validEnvironment(environment)
                ? [{ accountScopeId, environment }]
                : [];
        });
    }
}
const SELECTOR_KEYS = ['userId', 'runId', 'traceId', 'sessionId', 'grantId'];
function clean(value, max = 256) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .trim()
        .slice(0, max);
}
function validEnvironment(value) {
    return ['production', 'staging', 'development', 'test'].includes(String(value));
}
function epoch(value) {
    if (value instanceof Date)
        return value.getTime();
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}
function rowCount(result) {
    return Math.max(0, Number(result.rowCount ?? result.rows.length) || 0);
}
function cleanSelector(input = {}) {
    const output = {};
    for (const key of SELECTOR_KEYS) {
        const value = clean(input[key], 256);
        if (value)
            output[key] = value;
    }
    return output;
}
function selectorParams(tombstone) {
    return [
        tombstone.accountScopeId,
        tombstone.environment,
        tombstone.userId ?? null,
        tombstone.runId ?? null,
        tombstone.traceId ?? null,
        tombstone.sessionId ?? null,
        tombstone.grantId ?? null,
    ];
}
function tombstoneFromRow(row) {
    const accountScopeId = clean(row.account_scope_id);
    const environment = clean(row.environment, 32);
    const tombstoneId = clean(row.tombstone_id);
    const requestId = clean(row.request_id);
    const createdAt = epoch(row.created_at);
    if (!accountScopeId ||
        !validEnvironment(environment) ||
        !tombstoneId ||
        !requestId ||
        !Number.isFinite(createdAt)) {
        return null;
    }
    return {
        tombstoneId,
        requestId,
        accountScopeId,
        environment,
        createdAt,
        ...cleanSelector({
            userId: clean(row.user_id),
            runId: clean(row.run_id),
            traceId: clean(row.trace_id),
            sessionId: clean(row.session_id),
            grantId: clean(row.grant_id),
        }),
    };
}
function ledgerEntryFromRow(row) {
    const target = clean(row.target, 64);
    const status = clean(row.status, 32);
    const reasonCode = clean(row.reason_code, 64);
    const environment = clean(row.environment, 32);
    if (!REQUIRED_TELEMETRY_PURGE_TARGETS.includes(target) ||
        (status !== 'pending' && status !== 'resolved') ||
        !['target_unavailable', 'timeout', 'backend_unavailable', 'unknown_failure'].includes(reasonCode) ||
        !validEnvironment(environment)) {
        return null;
    }
    return {
        tombstoneId: clean(row.tombstone_id),
        accountScopeId: clean(row.account_scope_id),
        environment,
        target: target,
        status,
        reasonCode: reasonCode,
        attempts: Math.max(1, Math.floor(Number(row.attempts) || 1)),
        retryAfter: epoch(row.retry_after),
        updatedAt: epoch(row.updated_at),
    };
}
/** Durable scope-first tombstone and retry-ledger repository. */
export class PostgresTelemetryGovernanceRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async putIfAbsent(input) {
        const accountScopeId = clean(input.accountScopeId);
        const requestId = clean(input.requestId);
        if (!accountScopeId || !requestId || !validEnvironment(input.environment)) {
            throw new TypeError('invalid deletion tombstone scope');
        }
        const selector = cleanSelector(input);
        const result = await this.db.query(`insert into public.studio_telemetry_tombstones
         (request_id, account_scope_id, environment, user_id, run_id,
          trace_id, session_id, grant_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9 / 1000.0))
       on conflict (account_scope_id, environment, request_id) do update
         set request_id = excluded.request_id
       returning tombstone_id, request_id, account_scope_id, environment,
                 user_id, run_id, trace_id, session_id, grant_id, created_at`, [
            requestId,
            accountScopeId,
            input.environment,
            selector.userId ?? null,
            selector.runId ?? null,
            selector.traceId ?? null,
            selector.sessionId ?? null,
            selector.grantId ?? null,
            input.createdAt,
        ]);
        const tombstone = result.rows[0] ? tombstoneFromRow(result.rows[0]) : null;
        if (!tombstone ||
            tombstone.requestId !== requestId ||
            tombstone.accountScopeId !== accountScopeId ||
            tombstone.environment !== input.environment ||
            SELECTOR_KEYS.some((key) => (tombstone[key] ?? '') !== (selector[key] ?? ''))) {
            // Reusing an idempotency key with another selector must never widen an
            // earlier tombstone or purge a different target.
            throw Object.assign(new Error('deletion request conflict'), {
                code: 'deletion_request_conflict',
            });
        }
        return tombstone;
    }
    async upsertFailure(entry) {
        await this.db.query(`insert into public.studio_telemetry_deletion_ledger
         (tombstone_id, account_scope_id, environment, target, status,
          reason_code, attempts, retry_after, updated_at)
       values ($1,$2,$3,$4,'pending',$5,$6,to_timestamp($7 / 1000.0),
               to_timestamp($8 / 1000.0))
       on conflict (tombstone_id, target) do update set
         status = 'pending',
         reason_code = excluded.reason_code,
         attempts = greatest(public.studio_telemetry_deletion_ledger.attempts,
                             excluded.attempts),
         retry_after = excluded.retry_after,
         updated_at = excluded.updated_at
       where public.studio_telemetry_deletion_ledger.account_scope_id = excluded.account_scope_id
         and public.studio_telemetry_deletion_ledger.environment = excluded.environment`, [
            entry.tombstoneId,
            entry.accountScopeId,
            entry.environment,
            entry.target,
            entry.reasonCode,
            Math.max(1, Math.floor(entry.attempts)),
            entry.retryAfter,
            entry.updatedAt,
        ]);
    }
    async markResolved(input) {
        await this.db.query(`update public.studio_telemetry_deletion_ledger
       set status = 'resolved', updated_at = to_timestamp($5 / 1000.0)
       where tombstone_id = $1 and account_scope_id = $2
         and environment = $3 and target = $4`, [input.tombstoneId, input.accountScopeId, input.environment, input.target, input.resolvedAt]);
    }
    async listPending(input) {
        const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)));
        const result = await this.db.query(`select ledger.tombstone_id, ledger.account_scope_id, ledger.environment,
              ledger.target, ledger.status, ledger.reason_code, ledger.attempts,
              ledger.retry_after, ledger.updated_at,
              tombstone.request_id, tombstone.user_id, tombstone.run_id,
              tombstone.trace_id, tombstone.session_id, tombstone.grant_id,
              tombstone.created_at
       from public.studio_telemetry_deletion_ledger ledger
       join public.studio_telemetry_tombstones tombstone
         on tombstone.tombstone_id = ledger.tombstone_id
        and tombstone.account_scope_id = ledger.account_scope_id
        and tombstone.environment = ledger.environment
       where ledger.status = 'pending'
         and ledger.retry_after <= to_timestamp($1 / 1000.0)
       order by ledger.retry_after asc, ledger.tombstone_id asc, ledger.target asc
       limit $2`, [input.now, limit]);
        return result.rows.flatMap((row) => {
            const entry = ledgerEntryFromRow(row);
            const tombstone = tombstoneFromRow(row);
            return entry && tombstone ? [{ entry, tombstone }] : [];
        });
    }
    async listTombstones(input) {
        const accountScopeId = clean(input.accountScopeId);
        if (!accountScopeId || !validEnvironment(input.environment))
            return [];
        const result = await this.db.query(`select tombstone_id, request_id, account_scope_id, environment,
              user_id, run_id, trace_id, session_id, grant_id, created_at
       from public.studio_telemetry_tombstones
       where account_scope_id = $1 and environment = $2
       order by created_at asc, tombstone_id asc
       limit $3`, [accountScopeId, input.environment, Math.max(1, Math.min(10_000, input.limit ?? 5_000))]);
        return result.rows
            .map(tombstoneFromRow)
            .filter((item) => Boolean(item));
    }
}
/**
 * Scope-check a requested target before a tombstone is created. It also fills
 * a unique run/session correlation for trace- or grant-only deletion so payload
 * stores can be purged without a broad lookup after primary spans are removed.
 */
export async function resolveAuthorizedDeletionSelector(db, input) {
    const accountScopeId = clean(input.accountScopeId);
    if (!accountScopeId || !validEnvironment(input.environment))
        return null;
    const selector = cleanSelector(input.selector);
    if (selector.userId && selector.userId !== accountScopeId)
        return null;
    if (Object.keys(selector).length === 0 ||
        (selector.userId && Object.keys(selector).length === 1)) {
        return selector;
    }
    let grantResolved = false;
    if (selector.grantId) {
        const grant = await db.query(`select scope_kind, scope_id
       from public.studio_telemetry_payload_grants
       where account_scope_id = $1 and environment = $2 and grant_id::text = $3
       limit 1`, [accountScopeId, input.environment, selector.grantId]);
        const row = grant.rows[0];
        if (!row)
            return null;
        const scopeId = clean(row.scope_id, 200);
        if (row.scope_kind === 'run') {
            if (selector.runId && selector.runId !== scopeId)
                return null;
            selector.runId = scopeId;
        }
        else if (row.scope_kind === 'session') {
            if (selector.sessionId && selector.sessionId !== scopeId)
                return null;
            selector.sessionId = scopeId;
        }
        else {
            return null;
        }
        grantResolved = true;
    }
    const candidates = await db.query(`select distinct candidate.run_id, candidate.trace_id, candidate.session_id
     from (
       select run_id, trace_id, session_id
       from public.studio_trace_spans
       where account_scope_id = $1 and environment = $2
       union all
       select run_id, trace_id, session_id
       from public.studio_trace_backend_mappings
       where account_scope_id = $1 and environment = $2
       union all
       select run_id, null::text as trace_id, session_id
       from public.agent_run_observability
       where account_scope_id = $1 and environment = $2
       union all
       select r.run_id, null::text as trace_id,
              to_jsonb(r)->>'session_id' as session_id
       from public.agent_run_records r
       where r.sso_user_id = $1
         and coalesce(
           nullif(to_jsonb(r)->>'environment', ''),
           case when coalesce(r.client_type, '') = 'local-dev'
             then 'development' else 'production' end
         ) = $2
     ) candidate
     where ($3::text is null or candidate.run_id = $3)
       and ($4::text is null or candidate.trace_id = $4)
       and ($5::text is null or candidate.session_id = $5)
     order by candidate.run_id nulls last, candidate.trace_id nulls last,
              candidate.session_id nulls last
     limit 3`, [
        accountScopeId,
        input.environment,
        selector.runId ?? null,
        selector.traceId ?? null,
        selector.sessionId ?? null,
    ]);
    if (candidates.rows.length === 0)
        return grantResolved ? selector : null;
    for (const key of ['run_id', 'trace_id', 'session_id']) {
        const values = [...new Set(candidates.rows.map((row) => clean(row[key], 256)).filter(Boolean))];
        if (values.length !== 1)
            continue;
        if (key === 'run_id' && !selector.runId)
            selector.runId = values[0];
        if (key === 'trace_id' && !selector.traceId)
            selector.traceId = values[0];
        if (key === 'session_id' && !selector.sessionId)
            selector.sessionId = values[0];
    }
    return selector;
}
export class PostgresPrimaryTelemetryPurgeAdapter {
    db;
    target = 'primary_storage';
    constructor(db) {
        this.db = db;
    }
    async purge(tombstone) {
        const params = selectorParams(tombstone);
        await this.db.query(`with matching_spans as materialized (
         select trace_id, span_id, batch_id
         from public.studio_trace_spans
         where account_scope_id = $1 and environment = $2
           and ($3::text is null or owner_user_id = $3)
           and ($4::text is null or run_id = $4)
           and ($5::text is null or trace_id = $5)
           and ($6::text is null or session_id = $6)
           and $7::text is null
       ), deleted_receipts as (
         delete from public.studio_trace_ingestion_receipts receipt
         where receipt.account_scope_id = $1 and receipt.environment = $2
           and receipt.batch_id in (
             select batch_id from matching_spans where batch_id is not null
           )
         returning receipt.batch_id
       ), deleted_conflicts as (
         delete from public.studio_trace_span_conflicts conflict
         where conflict.account_scope_id = $1 and conflict.environment = $2
           and conflict.trace_id in (select trace_id from matching_spans)
         returning conflict.trace_id
       )
       delete from public.studio_trace_spans span
       using matching_spans matched
       where span.account_scope_id = $1 and span.environment = $2
         and span.trace_id = matched.trace_id and span.span_id = matched.span_id`, params);
        await this.db.query(`delete from public.agent_run_observability summary
       where summary.account_scope_id = $1 and summary.environment = $2
         and ($3::text is null or $3 = $1)
         and ($4::text is null or summary.run_id = $4)
         and ($6::text is null or summary.session_id = $6)
         and $5::text is null and $7::text is null`, params);
        await this.db.query(`delete from public.agent_run_records run_fact
       where run_fact.sso_user_id = $1
         and coalesce(
           nullif(to_jsonb(run_fact)->>'environment', ''),
           case when coalesce(run_fact.client_type, '') = 'local-dev'
             then 'development' else 'production' end
         ) = $2
         and ($3::text is null or $3 = $1)
         and ($4::text is null or run_fact.run_id = $4)
         and ($6::text is null or to_jsonb(run_fact)->>'session_id' = $6)
         and $5::text is null and $7::text is null`, params);
    }
}
export class PostgresPayloadPurgeAdapter {
    db;
    target = 'payload_store';
    constructor(db) {
        this.db = db;
    }
    async purge(tombstone) {
        const params = selectorParams(tombstone);
        await this.db.query(`delete from public.studio_telemetry_payload_grants grant_row
       where grant_row.account_scope_id = $1 and grant_row.environment = $2
         and ($3::text is null or $3 = $1)
         and ($7::text is null or grant_row.grant_id::text = $7)
         and (
           ($4::text is null and $6::text is null)
           or (grant_row.scope_kind = 'run' and grant_row.scope_id = $4)
           or (grant_row.scope_kind = 'session' and grant_row.scope_id = $6)
         )
         and ($5::text is null or $4::text is not null or $6::text is not null)`, params);
        // Defensive cleanup for restored/pre-constraint stores. Normal rows are
        // removed by the grant FK cascade.
        await this.db.query(`delete from public.studio_telemetry_payloads payload
       where payload.account_scope_id = $1 and payload.environment = $2
         and ($3::text is null or $3 = $1)
         and ($7::text is null or payload.grant_id::text = $7)
         and (
           ($4::text is null and $6::text is null)
           or (payload.scope_kind = 'run' and payload.scope_id = $4)
           or (payload.scope_kind = 'session' and payload.scope_id = $6)
         )
         and ($5::text is null or $4::text is not null or $6::text is not null)`, params);
    }
}
export class PostgresBackendMappingPurgeAdapter {
    db;
    clients;
    target = 'backend_mapping';
    constructor(db, clients) {
        this.db = db;
        this.clients = clients;
    }
    async purge(tombstone) {
        const params = selectorParams(tombstone);
        // Backup tools may restore mappings after tombstones or with triggers
        // disabled. Re-apply the read/export guard before contacting any backend.
        await this.db.query(`update public.studio_trace_backend_mappings mapping
       set tombstoned_at = coalesce(mapping.tombstoned_at, to_timestamp($8 / 1000.0)),
           updated_at = now()
       where mapping.account_scope_id = $1 and mapping.environment = $2
         and ($3::text is null or $3 = $1)
         and ($4::text is null or mapping.run_id = $4)
         and ($5::text is null or mapping.trace_id = $5)
         and ($6::text is null or mapping.session_id = $6)
         and $7::text is null`, [...params, tombstone.createdAt]);
        const result = await this.db.query(`select mapping_id, backend, backend_trace_id
       from public.studio_trace_backend_mappings mapping
       where mapping.account_scope_id = $1 and mapping.environment = $2
         and ($3::text is null or $3 = $1)
         and ($4::text is null or mapping.run_id = $4)
         and ($5::text is null or mapping.trace_id = $5)
         and ($6::text is null or mapping.session_id = $6)
         and $7::text is null
         and mapping.tombstoned_at is not null
       order by mapping.mapping_id asc`, params);
        const deletedMappingIds = [];
        for (const row of result.rows) {
            const backend = clean(row.backend, 64);
            const backendTraceId = clean(row.backend_trace_id, 512);
            const mappingId = clean(row.mapping_id, 64);
            const client = this.clients[backend];
            if (!backend || !backendTraceId || !mappingId || !client) {
                throw Object.assign(new Error('scoped backend deletion unavailable'), {
                    code: 'unavailable',
                });
            }
            await client.deleteTrace({
                accountScopeId: tombstone.accountScopeId,
                environment: tombstone.environment,
                backendTraceId,
            });
            deletedMappingIds.push(mappingId);
        }
        if (deletedMappingIds.length > 0) {
            await this.db.query(`delete from public.studio_trace_backend_mappings
         where account_scope_id = $1 and environment = $2
           and mapping_id = any($3::bigint[])
           and tombstoned_at is not null`, [tombstone.accountScopeId, tombstone.environment, deletedMappingIds]);
        }
    }
}
export class DelegatedTelemetryPurgeAdapter {
    target;
    boundary;
    constructor(target, boundary) {
        this.target = target;
        this.boundary = boundary;
    }
    purge(tombstone) {
        return this.boundary.purge(tombstone);
    }
}
/** The application has no DLQ; deterministic rejects are dropped and counted. */
export class ConfirmedAbsentDeadLetterPurgeAdapter {
    target = 'dead_letter_queue';
    applicability = 'not_applicable';
    notApplicableReason = 'store_absent_by_design';
    async purge() {
        // Lifecycle coordinators recognize the explicit applicability marker and
        // never call this method. Throwing prevents accidental fake success.
        throw Object.assign(new Error('dead-letter store is not configured'), {
            code: 'not_applicable',
        });
    }
}
function collectorPersistentQueueActive() {
    const mode = clean(process.env.STUDIO_OTEL_COLLECTOR_MODE, 32);
    return (process.env.STUDIO_TRACE_COLLECTOR_EXPORT === '1' || mode === 'shadow' || mode === 'gateway');
}
/**
 * The application retry target includes both its durable outbox and, when
 * enabled, the Collector's persistent exporter queues. The repository has no
 * scoped Collector queue deletion control plane, so that configured portion
 * must stay pending instead of being reported as purged.
 */
export class StudioTraceRetryQueuePurgeAdapter {
    outbox;
    collectorQueueIsActive;
    collectorQueueBoundary;
    target = 'retry_queue';
    constructor(outbox, collectorQueueIsActive = collectorPersistentQueueActive, collectorQueueBoundary) {
        this.outbox = outbox;
        this.collectorQueueIsActive = collectorQueueIsActive;
        this.collectorQueueBoundary = collectorQueueBoundary;
    }
    async purge(tombstone) {
        await this.outbox.purge(tombstone);
        let collectorActive = true;
        try {
            collectorActive = this.collectorQueueIsActive();
        }
        catch {
            // Unknown queue state is unsafe for a deletion completion claim.
        }
        if (collectorActive) {
            if (!this.collectorQueueBoundary) {
                throw Object.assign(new Error('scoped collector retry queue deletion unavailable'), {
                    code: 'unavailable',
                });
            }
            await this.collectorQueueBoundary.purge(tombstone);
        }
    }
}
export function createStudioTraceOutboxPurgeAdapters(collectorQueueBoundary) {
    const boundary = {
        purge: async (tombstone) => {
            const result = await purgeStudioTraceOutboxByTombstone({
                authoritativeAccountScopeId: tombstone.accountScopeId,
                tombstone,
            });
            if (result.scopeMismatch) {
                throw Object.assign(new Error('outbox scope mismatch'), { code: 'unavailable' });
            }
        },
    };
    const outbox = new DelegatedTelemetryPurgeAdapter('outbox', boundary);
    return [outbox, new StudioTraceRetryQueuePurgeAdapter(outbox, undefined, collectorQueueBoundary)];
}
export function retentionCounts(result) {
    const row = result.rows[0] ?? {};
    return {
        lowSensitivityDeleted: Math.max(0, Number(row.low_sensitivity_deleted) || 0),
        payloadDeleted: Math.max(0, Number(row.payload_deleted) || 0),
    };
}
export function queryAffectedRows(result) {
    return rowCount(result);
}
