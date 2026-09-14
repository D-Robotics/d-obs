import { createHash } from 'node:crypto';
import type {
  StudioDeploymentEnvironment,
  StudioNormalizedTraceSpan,
  StudioTraceBatch,
} from '../../shared/studio-observability.js';
import { ensureUnifiedStudioTraceSchema } from './studio-trace-schema.js';

export interface StudioTraceIngestionScope {
  /** Server-derived authenticated account/tenant key. Never read from the body. */
  accountScopeId: string;
  /** Server-owned deployment environment, not the producer resource value. */
  environment: StudioDeploymentEnvironment;
  /** Optional opaque reference derived from an authenticated device/session binding. */
  deviceRef?: string;
}

export type StudioTraceIngestionAck = {
  status: 'accepted' | 'duplicate';
  batchId: string;
  accepted: number;
  duplicates: number;
  conflicts: number;
};

export type StudioTraceIngestionResult =
  | { ok: true; ack: StudioTraceIngestionAck }
  | {
      ok: false;
      reason:
        | 'invalid_scope'
        | 'device_binding_mismatch'
        | 'batch_id_conflict'
        | 'tombstoned'
        | 'store_unavailable';
      retryable: boolean;
    };

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type StudioTraceDbClient = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  release?: () => void;
};
export type StudioTraceDbPool = {
  connect: () => Promise<StudioTraceDbClient>;
};

function cleanScopePart(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, max);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

export function studioTraceContentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function spanRows(batch: StudioTraceBatch): Array<Record<string, unknown>> {
  return batch.spans.map((span: StudioNormalizedTraceSpan) => ({
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId ?? null,
    run_id: span.runId ?? null,
    session_id: span.sessionId ?? null,
    client_operation_id: span.clientOperationId ?? null,
    source_segment: span.sourceSegment,
    legacy_source: span.sourceSegment === 'client' ? 'client' : 'server',
    name: span.name,
    span_kind: span.kind,
    start_time_ms: span.startTimeUnixMs,
    end_time_ms: span.endTimeUnixMs,
    outcome: span.outcome,
    otel_status: span.status,
    legacy_status: span.status === 'error' ? 'error' : 'ok',
    attributes: span.attributes,
    service_name: span.resource.serviceName,
    service_instance_id: span.resource.serviceInstanceId,
    surface: span.resource.surface,
    studio_version: span.resource.studioVersion,
    moss_version: span.resource.mossVersion,
    moc_version: span.resource.mocVersion,
    sampling_decision: span.sampling.decision,
    sampling_policy_version: span.sampling.policyVersion,
    sampling_reason: span.sampling.reason ?? null,
    canonical_hash: studioTraceContentHash(span),
  }));
}

const INSERT_SPANS_SQL = `
  insert into public.studio_trace_spans (
    account_scope_id, environment, trace_id, span_id, parent_span_id, run_id,
    owner_user_id, source, source_segment, session_id, client_operation_id,
    name, span_kind, start_time_ms, end_time_ms, status, otel_status, outcome,
    status_message, attributes, moc_version, producer_version, service_name,
    service_instance_id, surface, studio_version, moss_version,
    sampling_decision, sampling_policy_version, sampling_reason,
    canonical_hash, batch_id, received_at, governance_expires_at
  )
  select
    $1, $2, x.trace_id, x.span_id, x.parent_span_id, x.run_id,
    $1, x.legacy_source, x.source_segment, x.session_id, x.client_operation_id,
    x.name, x.span_kind, x.start_time_ms, x.end_time_ms, x.legacy_status,
    x.otel_status, x.outcome, null, x.attributes, x.moc_version, $3,
    x.service_name, x.service_instance_id, x.surface, x.studio_version,
    x.moss_version, x.sampling_decision, x.sampling_policy_version,
    x.sampling_reason, x.canonical_hash, $4, now(),
    to_timestamp(x.start_time_ms / 1000.0) + interval '35 days'
  from jsonb_to_recordset($5::jsonb) as x(
    trace_id text, span_id text, parent_span_id text, run_id text,
    session_id text, client_operation_id text, source_segment text,
    legacy_source text, name text, span_kind text, start_time_ms bigint,
    end_time_ms bigint, outcome text, otel_status text, legacy_status text,
    attributes jsonb, service_name text, service_instance_id text, surface text,
    studio_version text, moss_version text, moc_version text,
    sampling_decision text, sampling_policy_version text, sampling_reason text,
    canonical_hash text
  )
  on conflict (account_scope_id, environment, trace_id, span_id) do nothing
  returning trace_id, span_id
`;

const QUARANTINE_CONFLICTS_SQL = `
  insert into public.studio_trace_span_conflicts (
    account_scope_id, environment, trace_id, span_id, batch_id,
    existing_hash, incoming_hash, reason_code, observed_at
  )
  select $1, $2, x.trace_id, x.span_id, $3,
         coalesce(existing.canonical_hash, 'legacy-unhashed'),
         x.canonical_hash, 'immutable_identity_conflict', now()
  from jsonb_to_recordset($4::jsonb) as x(
    trace_id text, span_id text, canonical_hash text
  )
  join public.studio_trace_spans existing
    on existing.account_scope_id = $1
   and existing.environment = $2
   and existing.trace_id = x.trace_id
   and existing.span_id = x.span_id
  where existing.canonical_hash is distinct from x.canonical_hash
  on conflict do nothing
  returning trace_id, span_id
`;

const MATCHING_TOMBSTONE_SQL = `
  select 1
  from public.studio_telemetry_tombstones tombstone
  where tombstone.account_scope_id = $1
    and tombstone.environment = $2
    and (tombstone.user_id is null or tombstone.user_id = $1)
    and tombstone.grant_id is null
    and exists (
      select 1
      from jsonb_to_recordset($3::jsonb) as x(
        run_id text, trace_id text, session_id text
      )
      where (tombstone.run_id is null or tombstone.run_id = x.run_id)
        and (tombstone.trace_id is null or tombstone.trace_id = x.trace_id)
        and (tombstone.session_id is null or tombstone.session_id = x.session_id)
    )
  limit 1
`;

/**
 * Commit one normalized batch atomically. No network or Agent-path exception is
 * allowed to escape this boundary; a caller receives a deterministic retry hint.
 */
export async function ingestStudioTraceBatchWithPool(input: {
  pool: StudioTraceDbPool;
  scope: StudioTraceIngestionScope;
  batch: StudioTraceBatch;
}): Promise<StudioTraceIngestionResult> {
  const accountScopeId = cleanScopePart(input.scope.accountScopeId, 256);
  const environment = input.scope.environment;
  const deviceRef = cleanScopePart(input.scope.deviceRef, 200);
  if (!accountScopeId || !['production', 'staging', 'development', 'test'].includes(environment)) {
    return { ok: false, reason: 'invalid_scope', retryable: false };
  }
  if (deviceRef && input.batch.deviceRef && input.batch.deviceRef !== deviceRef) {
    return { ok: false, reason: 'device_binding_mismatch', retryable: false };
  }

  const rows = spanRows(input.batch);
  const payloadHash = studioTraceContentHash({
    ...input.batch,
    deviceRef: deviceRef || undefined,
  });
  let client: StudioTraceDbClient | undefined;
  try {
    client = await input.pool.connect();
    await ensureUnifiedStudioTraceSchema(client);
    await client.query('begin');
    const tombstone = await client.query(MATCHING_TOMBSTONE_SQL, [
      accountScopeId,
      environment,
      JSON.stringify(
        rows.map((row) => ({
          run_id: row.run_id,
          trace_id: row.trace_id,
          session_id: row.session_id,
        })),
      ),
    ]);
    if (tombstone.rows.length > 0) {
      await client.query('rollback');
      return { ok: false, reason: 'tombstoned', retryable: false };
    }
    const receipt = await client.query(
      `insert into public.studio_trace_ingestion_receipts
         (account_scope_id, environment, batch_id, payload_hash, producer_version,
          moc_version, device_ref, item_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (account_scope_id, environment, batch_id) do nothing
       returning batch_id`,
      [
        accountScopeId,
        environment,
        input.batch.batchId,
        payloadHash,
        input.batch.producerVersion,
        input.batch.mocVersion,
        deviceRef || null,
        rows.length,
      ],
    );

    if (!receipt.rowCount) {
      const existing = await client.query(
        `select payload_hash, accepted_count, duplicate_count, conflict_count
         from public.studio_trace_ingestion_receipts
         where account_scope_id = $1 and environment = $2 and batch_id = $3`,
        [accountScopeId, environment, input.batch.batchId],
      );
      const row = existing.rows[0];
      if (!row || row.payload_hash !== payloadHash) {
        await client.query('rollback');
        return { ok: false, reason: 'batch_id_conflict', retryable: false };
      }
      await client.query('commit');
      return {
        ok: true,
        ack: {
          status: 'duplicate',
          batchId: input.batch.batchId,
          accepted: Number(row.accepted_count ?? 0),
          duplicates: Number(row.duplicate_count ?? rows.length),
          conflicts: Number(row.conflict_count ?? 0),
        },
      };
    }

    const inserted = await client.query(INSERT_SPANS_SQL, [
      accountScopeId,
      environment,
      input.batch.producerVersion,
      input.batch.batchId,
      JSON.stringify(rows),
    ]);
    const conflicts = await client.query(QUARANTINE_CONFLICTS_SQL, [
      accountScopeId,
      environment,
      input.batch.batchId,
      JSON.stringify(
        rows.map((row) => ({
          trace_id: row.trace_id,
          span_id: row.span_id,
          canonical_hash: row.canonical_hash,
        })),
      ),
    ]);
    const accepted = Number(inserted.rowCount ?? inserted.rows.length);
    const conflictCount = Number(conflicts.rowCount ?? conflicts.rows.length);
    const duplicates = Math.max(0, rows.length - accepted - conflictCount);
    await client.query(
      `update public.studio_trace_ingestion_receipts
       set accepted_count = $4, duplicate_count = $5, conflict_count = $6
       where account_scope_id = $1 and environment = $2 and batch_id = $3`,
      [accountScopeId, environment, input.batch.batchId, accepted, duplicates, conflictCount],
    );
    await client.query('commit');
    return {
      ok: true,
      ack: {
        status: 'accepted',
        batchId: input.batch.batchId,
        accepted,
        duplicates,
        conflicts: conflictCount,
      },
    };
  } catch {
    if (client) await client.query('rollback').catch(() => undefined);
    return { ok: false, reason: 'store_unavailable', retryable: true };
  } finally {
    client?.release?.();
  }
}

let poolPromise: Promise<StudioTraceDbPool> | null = null;
async function defaultPool(): Promise<StudioTraceDbPool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('RDK_CHAT_CREDITS_DB_URL is not configured');
  if (!poolPromise) {
    poolPromise = import('pg' as string)
      .then((pgMod) => {
        const PoolCtor = (
          pgMod as { default: { Pool: new (config: unknown) => StudioTraceDbPool } }
        ).default.Pool;
        return new PoolCtor({ connectionString, max: 3 });
      })
      .catch((error) => {
        poolPromise = null;
        throw error;
      });
  }
  return poolPromise;
}

export async function ingestStudioTraceBatch(input: {
  scope: StudioTraceIngestionScope;
  batch: StudioTraceBatch;
}): Promise<StudioTraceIngestionResult> {
  try {
    return await ingestStudioTraceBatchWithPool({ ...input, pool: await defaultPool() });
  } catch {
    return { ok: false, reason: 'store_unavailable', retryable: true };
  }
}