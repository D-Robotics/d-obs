export type WorkerLeaseQueryResult = { rows: Array<{ acquired?: boolean }> };

export type WorkerLeasePool = {
  query: (text: string, params?: unknown[]) => Promise<WorkerLeaseQueryResult>;
  end: () => Promise<void>;
};

export type WorkerLease = {
  acquired: boolean;
  release: () => Promise<void>;
};

const DEFAULT_LEASE_KEY = 'd-obs:alert-worker:v1';

function requiredByEnvironment(): boolean {
  const configured = String(process.env.RDK_ALERT_WORKER_LOCK_REQUIRED ?? '').trim();
  if (configured) return configured === '1' || configured.toLowerCase() === 'true';
  return String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function leaseKey(): string {
  return String(process.env.RDK_ALERT_WORKER_LOCK_KEY ?? '').trim() || DEFAULT_LEASE_KEY;
}

/** Acquire a session-scoped advisory lock. max=1 ensures unlock runs on the same session. */
export async function acquireWorkerLease(options: {
  connectionString?: string;
  key?: string;
  required?: boolean;
} = {}): Promise<WorkerLease> {
  const connectionString = String(options.connectionString ?? process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  const required = options.required ?? requiredByEnvironment();
  if (!connectionString) {
    if (required) throw new Error('alert_worker_lease_database_not_configured');
    return { acquired: true, release: async () => undefined };
  }

  const pg = await import('pg' as string);
  const Pool = (pg as unknown as { default?: { Pool?: new (config: Record<string, unknown>) => WorkerLeasePool } }).default?.Pool;
  if (!Pool) throw new Error('alert_worker_lease_pg_unavailable');
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 3_000,
    application_name: 'd-obs-alert-worker-lease',
  });
  const lockName = options.key || leaseKey();
  try {
    const result = await pool.query(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [lockName],
    );
    const acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      await pool.end().catch(() => undefined);
      return { acquired: false, release: async () => undefined };
    }
    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        await pool.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    if (required) throw error;
    return { acquired: true, release: async () => undefined };
  }
}
