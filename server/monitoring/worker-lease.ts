export type WorkerLeaseQueryResult = { rows: Array<{ acquired?: boolean }> };

export type WorkerLeaseClient = {
  query: (text: string, params?: unknown[]) => Promise<WorkerLeaseQueryResult>;
  on: (event: 'error' | 'end', listener: (error?: Error) => void) => unknown;
  removeListener: (event: 'error' | 'end', listener: (error?: Error) => void) => unknown;
  release: (destroy?: boolean) => void;
};

export type WorkerLeasePool = {
  connect: () => Promise<WorkerLeaseClient>;
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

/** Hold a dedicated session until release; pool.query would release it to the idle timeout. */
export async function acquireWorkerLease(options: {
  connectionString?: string;
  key?: string;
  required?: boolean;
  /** The evaluator must stop immediately when its lock session disappears. */
  onLost?: (error: Error) => void;
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
  let client: WorkerLeaseClient | undefined;
  let lease: WorkerLease | undefined;
  let connectionLost = false;
  let released = false;
  let disposal: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  const onConnectionLost = (error?: Error): void => {
    connectionLost = true;
    if (released || !lease?.acquired) return;
    lease.acquired = false;
    options.onLost?.(Object.assign(new Error('alert_worker_lease_connection_lost'), { cause: error }));
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      // Destroy this session rather than ever returning a possibly locked client to the pool.
      client?.release(true);
      await pool.end().catch(() => undefined);
      client?.removeListener('error', onConnectionLost);
      client?.removeListener('end', onConnectionLost);
    })();
    return disposal;
  };
  try {
    client = await pool.connect();
    client.on('error', onConnectionLost);
    client.on('end', onConnectionLost);
    const result = await client.query(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
      [lockName],
    );
    if (connectionLost) throw new Error('alert_worker_lease_connection_lost');
    const acquired = result.rows[0]?.acquired === true;
    if (!acquired) {
      released = true;
      await dispose();
      return { acquired: false, release: async () => undefined };
    }
    lease = {
      acquired: true,
      release: () => {
        if (releasePromise) return releasePromise;
        released = true;
        lease!.acquired = false;
        releasePromise = (async () => {
          if (!connectionLost) {
            await client!.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => undefined);
          }
          await dispose();
        })();
        return releasePromise;
      },
    };
    return lease;
  } catch (error) {
    released = true;
    await dispose();
    if (required) throw error;
    return { acquired: true, release: async () => undefined };
  }
}
