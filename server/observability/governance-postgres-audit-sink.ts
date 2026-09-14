import {
  TelemetryAuditGuard,
  type TelemetryAuditEvent,
  type TelemetryAuditSink,
} from './governance-audit.js';

export interface TelemetryAuditQueryExecutor {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Durable append adapter for the migration-owned studio_telemetry_audit table.
 * The recordset insert keeps the same path usable for bounded transactional
 * batches without constructing dynamic SQL or ever interpolating identifiers.
 */
export class PostgresTelemetryAuditSink implements TelemetryAuditSink {
  constructor(private readonly executor: TelemetryAuditQueryExecutor) {}

  async append(event: Readonly<TelemetryAuditEvent>): Promise<void> {
    await this.appendBatch([event]);
  }

  async appendBatch(events: readonly Readonly<TelemetryAuditEvent>[]): Promise<void> {
    if (events.length < 1 || events.length > 128) {
      throw new TypeError('telemetry audit batch size is invalid');
    }
    const rows = events.map((event) => ({
      event_version: event.eventVersion,
      occurred_at: event.occurredAt,
      actor_ref: event.actorRef,
      actor_role: event.actorRole,
      account_scope_ref: event.accountScopeRef,
      action: event.action,
      target_type: event.targetType,
      target_ref: event.targetRef,
      decision: event.decision,
      purpose_code: event.purposeCode,
      request_correlation_ref: event.requestCorrelationRef,
      result: event.result,
    }));
    await this.executor.query(
      `insert into public.studio_telemetry_audit
         (event_version, occurred_at, actor_ref, actor_role, account_scope_ref,
          action, target_type, target_ref, decision, purpose_code,
          request_correlation_ref, result)
       select x.event_version, x.occurred_at, x.actor_ref, x.actor_role,
              x.account_scope_ref, x.action, x.target_type, x.target_ref,
              x.decision, x.purpose_code, x.request_correlation_ref, x.result
       from jsonb_to_recordset($1::jsonb) as x(
         event_version integer, occurred_at timestamptz, actor_ref text,
         actor_role text, account_scope_ref text, action text, target_type text,
         target_ref text, decision text, purpose_code text,
         request_correlation_ref text, result text
       )`,
      [JSON.stringify(rows)],
    );
  }
}

type Pool = TelemetryAuditQueryExecutor;
let centralPoolPromise: Promise<Pool> | null = null;

function centralDatabaseUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

function auditReferenceSecret(): string {
  return (
    String(process.env.RDK_TELEMETRY_AUDIT_REFERENCE_SECRET ?? '').trim() ||
    String(process.env.SSO_CLIENT_SECRET ?? '').trim()
  );
}

async function centralPool(): Promise<Pool> {
  const connectionString = centralDatabaseUrl();
  if (!connectionString) throw new Error('central telemetry audit database is not configured');
  if (!centralPoolPromise) {
    centralPoolPromise = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (config: { connectionString: string; max: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      centralPoolPromise = null;
      throw error;
    });
  }
  return centralPoolPromise;
}

export function isCentralTelemetryAuditConfigured(): boolean {
  return centralDatabaseUrl().length > 0 && auditReferenceSecret().length >= 16;
}

const centralExecutor: TelemetryAuditQueryExecutor = {
  async query(text, params) {
    const pool = await centralPool();
    return pool.query(text, params);
  },
};

/**
 * Safe to create even on a profile without audit configuration. In that case
 * protected observability operations fail closed on append while Agent runtime
 * paths that never call the guard remain unaffected.
 */
export function createCentralPostgresTelemetryAuditGuard(): TelemetryAuditGuard {
  const configured = isCentralTelemetryAuditConfigured();
  const sink: TelemetryAuditSink = configured
    ? new PostgresTelemetryAuditSink(centralExecutor)
    : {
        append: async () => {
          throw new Error('central telemetry audit is not configured');
        },
      };
  return new TelemetryAuditGuard(
    sink,
    configured ? auditReferenceSecret() : 'unconfigured-audit-reference',
  );
}