import { TelemetryDeletionCoordinator } from './governance-deletion.js';
import { createCentralPostgresTelemetryAuditGuard } from './governance-postgres-audit-sink.js';
import {
  ConfirmedAbsentDeadLetterPurgeAdapter,
  DelegatedTelemetryPurgeAdapter,
  PostgresBackendMappingPurgeAdapter,
  PostgresGovernanceScopeProvider,
  PostgresPayloadPurgeAdapter,
  PostgresPrimaryTelemetryPurgeAdapter,
  PostgresTelemetryGovernanceRepository,
  createStudioTraceOutboxPurgeAdapters,
  type GovernanceQueryExecutor,
  type ScopedBackendDeletionClient,
  type ScopedTelemetryPurgeBoundary,
} from './governance-postgres-runtime.js';
import {
  getTelemetryGovernanceRuntimeHealth,
  type TelemetryGovernanceHealthSnapshot,
  type TelemetryGovernanceRuntimeHealth,
} from './governance-runtime-health.js';
import {
  BoundedTelemetryPurgeAdapter,
  PostgresTelemetryRetentionWorker,
  ScopedTelemetryDeletionService,
  TelemetryDeletionRetryWorker,
  TelemetryGovernanceRuntimeWorker,
  TelemetryTombstoneReplayWorker,
  type TelemetryGovernanceScopeProvider,
} from './governance-runtime-worker.js';
import type { TelemetryAuditGuard } from './governance-audit.js';
import { registerScopedBackendDeletionCapability } from './governance-backend-capabilities.js';
import type { TelemetryDeletionRequest, TelemetryDeletionResult } from './governance-deletion.js';
import { createCollectorQueuePurgeBoundary } from './collector-queue-purge.js';

interface ClosableGovernanceQueryExecutor extends GovernanceQueryExecutor {
  end?(): Promise<void>;
}

export interface TelemetryGovernanceRuntimeOptions {
  db?: ClosableGovernanceQueryExecutor;
  audit?: TelemetryAuditGuard;
  scopeProvider?: TelemetryGovernanceScopeProvider;
  cacheBoundary?: ScopedTelemetryPurgeBoundary;
  collectorQueueBoundary?: ScopedTelemetryPurgeBoundary;
  backendDeletionClients?: Readonly<Record<string, ScopedBackendDeletionClient | undefined>>;
  health?: TelemetryGovernanceRuntimeHealth;
  operationTimeoutMs?: number;
  intervalMs?: number;
  /** Tests may force the configured branch without mutating process env. */
  configured?: boolean;
}

export interface TelemetryGovernanceRuntimeHandle {
  readonly worker: TelemetryGovernanceRuntimeWorker;
  readonly deletionService: ScopedTelemetryDeletionService;
  readonly restoreGate: Promise<{
    ready: boolean;
    replayed: number;
    pendingTargets: number;
    retentionFailures: number;
  }>;
  health(): TelemetryGovernanceHealthSnapshot;
  stop(): Promise<void>;
}

export type TelemetryGovernanceRuntimeStartResult =
  | { status: 'disabled'; handle: null }
  | { status: 'started' | 'already_started'; handle: TelemetryGovernanceRuntimeHandle }
  | { status: 'failed'; handle: null };

export type TelemetryGovernanceRestoreReadiness =
  | 'disabled'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'stopped';

let startPromise: Promise<TelemetryGovernanceRuntimeStartResult> | null = null;
let activeHandle: TelemetryGovernanceRuntimeHandle | null = null;
let exitHookInstalled = false;
let restoreReadiness: TelemetryGovernanceRestoreReadiness | 'idle' = 'idle';

function configuredFromEnvironment(): boolean {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim().length > 0;
}

async function defaultDatabase(): Promise<ClosableGovernanceQueryExecutor> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central governance database is not configured');
  const pgMod = (await import('pg' as string)) as {
    default: {
      Pool: new (config: {
        connectionString: string;
        max: number;
      }) => ClosableGovernanceQueryExecutor;
    };
  };
  return new pgMod.default.Pool({ connectionString, max: 2 });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    activeHandle?.worker.stop();
  });
}

async function buildRuntime(
  options: TelemetryGovernanceRuntimeOptions,
): Promise<TelemetryGovernanceRuntimeHandle> {
  const db = options.db ?? (await defaultDatabase());
  const health = options.health ?? getTelemetryGovernanceRuntimeHealth();
  const repository = new PostgresTelemetryGovernanceRepository(db);
  const adapters = [
    new PostgresPrimaryTelemetryPurgeAdapter(db),
    new PostgresPayloadPurgeAdapter(db),
    new PostgresBackendMappingPurgeAdapter(db, options.backendDeletionClients ?? {}),
    ...createStudioTraceOutboxPurgeAdapters(
      options.collectorQueueBoundary ?? createCollectorQueuePurgeBoundary(),
    ),
    ...(options.cacheBoundary
      ? [new DelegatedTelemetryPurgeAdapter('cache', options.cacheBoundary)]
      : []),
    new ConfirmedAbsentDeadLetterPurgeAdapter(),
  ].map((adapter) => new BoundedTelemetryPurgeAdapter(adapter, options.operationTimeoutMs));
  const audit = options.audit ?? createCentralPostgresTelemetryAuditGuard();
  const releaseBackendCapabilities = Object.entries(options.backendDeletionClients ?? {}).flatMap(
    ([destination, client]) =>
      client ? [registerScopedBackendDeletionCapability(destination)] : [],
  );
  const coordinator = new TelemetryDeletionCoordinator(repository, adapters, repository, audit);
  const retention = new PostgresTelemetryRetentionWorker(db, health, options.operationTimeoutMs);
  const retries = new TelemetryDeletionRetryWorker(repository, adapters, health);
  const replay = new TelemetryTombstoneReplayWorker(repository, adapters, health);
  let stopped = false;
  const worker = new TelemetryGovernanceRuntimeWorker(
    options.scopeProvider ?? new PostgresGovernanceScopeProvider(db),
    retention,
    retries,
    replay,
    (ready) => {
      if (!stopped) restoreReadiness = ready ? 'ready' : 'failed';
    },
    options.operationTimeoutMs,
  );
  const restoreGate = worker
    .runRestoreGate()
    .then((result) => {
      if (!stopped) restoreReadiness = result.ready ? 'ready' : 'failed';
      return result;
    })
    .catch(() => {
      if (!stopped) restoreReadiness = 'failed';
      return {
        ready: false,
        replayed: 0,
        pendingTargets: 1,
        retentionFailures: 1,
      };
    });
  void restoreGate.then(() => {
    // Do not overlap the initial restore pass with the periodic worker. This
    // also keeps a stop during startup from resurrecting a timer afterwards.
    if (!stopped) worker.start(options.intervalMs);
  });
  return {
    worker,
    deletionService: new ScopedTelemetryDeletionService(db, coordinator, health),
    restoreGate,
    health: () => health.snapshot(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      worker.stop();
      for (const release of releaseBackendCapabilities) release();
      await db.end?.().catch(() => undefined);
    },
  };
}

/** Idempotent, fail-open startup; only central-DB profiles activate workers. */
export async function startTelemetryGovernanceRuntime(
  options: TelemetryGovernanceRuntimeOptions = {},
): Promise<TelemetryGovernanceRuntimeStartResult> {
  const configured = options.configured ?? configuredFromEnvironment();
  if (!configured) {
    restoreReadiness = 'disabled';
    return { status: 'disabled', handle: null };
  }
  if (activeHandle) return { status: 'already_started', handle: activeHandle };
  if (startPromise) {
    const result = await startPromise;
    return result.status === 'started' && result.handle
      ? { status: 'already_started', handle: result.handle }
      : result;
  }
  restoreReadiness = 'pending';
  startPromise = buildRuntime(options)
    .then((handle): TelemetryGovernanceRuntimeStartResult => {
      activeHandle = handle;
      installExitHook();
      return { status: 'started', handle };
    })
    .catch((): TelemetryGovernanceRuntimeStartResult => {
      restoreReadiness = 'failed';
      return { status: 'failed', handle: null };
    })
    .finally(() => {
      startPromise = null;
    });
  return startPromise;
}

export async function stopTelemetryGovernanceRuntime(): Promise<void> {
  const pending = startPromise ? await startPromise : null;
  const handle = activeHandle ?? pending?.handle ?? null;
  activeHandle = null;
  await handle?.stop();
  restoreReadiness = configuredFromEnvironment() ? 'stopped' : 'disabled';
}

export function telemetryGovernanceRuntimeForTest(): TelemetryGovernanceRuntimeHandle | null {
  return activeHandle;
}

/** The only production mutation entry into the runtime deletion coordinator. */
export async function requestScopedTelemetryDeletion(
  request: TelemetryDeletionRequest,
): Promise<TelemetryDeletionResult> {
  if (!activeHandle) {
    throw Object.assign(new Error('telemetry governance runtime unavailable'), {
      code: 'telemetry_governance_unavailable',
    });
  }
  return activeHandle.deletionService.delete(request);
}

/** Protected telemetry reads stay closed until retention and tombstones replay. */
export function telemetryGovernanceRestoreReadiness(): TelemetryGovernanceRestoreReadiness {
  if (restoreReadiness === 'idle') {
    return configuredFromEnvironment() ? 'pending' : 'disabled';
  }
  return restoreReadiness;
}

export function telemetryGovernanceProtectedReadsReady(): boolean {
  return telemetryGovernanceRestoreReadiness() === 'ready';
}