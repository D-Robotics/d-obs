import {
  REQUIRED_TELEMETRY_PURGE_TARGETS,
  TelemetryDeletionCoordinator,
  retryDeletionLedgerEntry,
  type DeletionLedgerEntry,
  type TelemetryDeletionRequest,
  type TelemetryDeletionResult,
  type TelemetryPurgeAdapter,
  type TelemetryPurgeTarget,
} from './governance-deletion.js';
import { TelemetryGovernanceRuntimeHealth } from './governance-runtime-health.js';
import {
  PostgresTelemetryGovernanceRepository,
  resolveAuthorizedDeletionSelector,
  retentionCounts,
  type GovernanceQueryExecutor,
  type PendingDeletionWork,
  type ScopedGovernancePartition,
} from './governance-postgres-runtime.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 2_000;
const DEFAULT_WORKER_INTERVAL_MS = 15 * 60_000;

function boundedTimeout(value: unknown): number {
  const timeout = Number(value);
  return Number.isFinite(timeout)
    ? Math.max(50, Math.min(30_000, Math.floor(timeout)))
    : DEFAULT_OPERATION_TIMEOUT_MS;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(Object.assign(new Error('governance operation timed out'), { code: 'timeout' })),
          boundedTimeout(timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failureReason(error: unknown): DeletionLedgerEntry['reasonCode'] {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '').toLowerCase()
      : '';
  if (code === 'timeout' || code === 'etimedout') return 'timeout';
  if (code === 'unavailable' || code === 'econnrefused') return 'backend_unavailable';
  return 'unknown_failure';
}

function nextRetryAt(now: number, attempts: number): number {
  return now + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(10, attempts - 1));
}

export type RetentionRunResult =
  | {
      ok: true;
      lowSensitivityDeleted: number;
      payloadDeleted: number;
    }
  | { ok: false; reason: 'invalid_scope' | 'timeout' | 'store_unavailable' };

/** Runs one account/environment cleanup without fetching global records. */
export class PostgresTelemetryRetentionWorker {
  constructor(
    private readonly db: GovernanceQueryExecutor,
    private readonly health: TelemetryGovernanceRuntimeHealth,
    private readonly operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  ) {}

  recordScopeDiscoveryFailure(): void {
    this.health.recordRetentionFailure('store_unavailable');
  }

  async runScope(
    partition: ScopedGovernancePartition,
    now = Date.now(),
  ): Promise<RetentionRunResult> {
    const accountScopeId = String(partition.accountScopeId ?? '')
      .trim()
      .slice(0, 256);
    if (
      !accountScopeId ||
      !['production', 'staging', 'development', 'test'].includes(partition.environment)
    ) {
      return { ok: false, reason: 'invalid_scope' };
    }
    try {
      const result = await within(
        this.db.query(
          `select low_sensitivity_deleted, payload_deleted
           from public.cleanup_expired_studio_telemetry(
             $1, $2, to_timestamp($3 / 1000.0)
           )`,
          [accountScopeId, partition.environment, now],
        ),
        this.operationTimeoutMs,
      );
      const counts = retentionCounts(result);
      this.health.recordRetentionSuccess(counts);
      return { ok: true, ...counts };
    } catch (error) {
      const reason = failureReason(error) === 'timeout' ? 'timeout' : 'store_unavailable';
      this.health.recordRetentionFailure(reason);
      return { ok: false, reason };
    }
  }
}

/** Adds a hard bound around a sink/cache/queue/backend purge implementation. */
export class BoundedTelemetryPurgeAdapter implements TelemetryPurgeAdapter {
  readonly target: TelemetryPurgeTarget;
  readonly applicability?: TelemetryPurgeAdapter['applicability'];
  readonly notApplicableReason?: TelemetryPurgeAdapter['notApplicableReason'];

  constructor(
    private readonly delegate: TelemetryPurgeAdapter,
    private readonly timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  ) {
    this.target = delegate.target;
    this.applicability = delegate.applicability;
    this.notApplicableReason = delegate.notApplicableReason;
  }

  purge(tombstone: Parameters<TelemetryPurgeAdapter['purge']>[0]): Promise<void> {
    return within(this.delegate.purge(tombstone), this.timeoutMs);
  }
}

export type ScopedTelemetryDeletionServiceInput = TelemetryDeletionRequest;

/**
 * Resolves the target inside authoritative scope before the durable audit and
 * tombstone mutation. Foreign and nonexistent targets share the same result.
 */
export class ScopedTelemetryDeletionService {
  constructor(
    private readonly db: GovernanceQueryExecutor,
    private readonly coordinator: TelemetryDeletionCoordinator,
    private readonly health: TelemetryGovernanceRuntimeHealth,
  ) {}

  async delete(request: ScopedTelemetryDeletionServiceInput): Promise<TelemetryDeletionResult> {
    if (!request.access.allowed || request.access.permission !== 'telemetry.delete') {
      throw new Error('not_found');
    }
    const selector = await resolveAuthorizedDeletionSelector(this.db, {
      accountScopeId: request.access.accountScopeId,
      environment: request.environment,
      selector: request.selector,
    });
    if (selector === null) throw new Error('not_found');
    const result = await this.coordinator.delete({ ...request, selector });
    this.health.recordDeletionResult({
      completed: result.completed,
      pendingTargets: result.pendingTargets.length,
    });
    return result;
  }
}

export class TelemetryDeletionRetryWorker {
  private readonly adapters: ReadonlyMap<TelemetryPurgeTarget, TelemetryPurgeAdapter>;

  constructor(
    private readonly repository: PostgresTelemetryGovernanceRepository,
    adapters: readonly TelemetryPurgeAdapter[],
    private readonly health: TelemetryGovernanceRuntimeHealth,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.target, adapter]));
  }

  async runOnce(input: { now?: number; limit?: number } = {}): Promise<{
    attempted: number;
    resolved: number;
    pending: number;
  }> {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    let work: PendingDeletionWork[];
    try {
      work = await this.repository.listPending({ now, limit: input.limit });
    } catch {
      this.health.setDeletionBacklog({ pending: 1, oldestRetryAgeMs: 0 });
      return { attempted: 0, resolved: 0, pending: 1 };
    }
    const oldestRetryAgeMs = work.reduce(
      (maximum, item) => Math.max(maximum, now - item.entry.updatedAt),
      0,
    );
    this.health.setDeletionBacklog({ pending: work.length, oldestRetryAgeMs });
    let attempted = 0;
    let resolved = 0;
    for (const item of work) {
      const adapter = this.adapters.get(item.entry.target);
      if (!adapter) {
        const attempts = item.entry.attempts + 1;
        await this.repository
          .upsertFailure({
            ...item.entry,
            reasonCode: 'target_unavailable',
            attempts,
            retryAfter: nextRetryAt(now, attempts),
            updatedAt: now,
          })
          .catch(() => undefined);
        this.health.recordDeletionRetry(false);
        attempted += 1;
        continue;
      }
      attempted += 1;
      if (
        adapter.applicability === 'not_applicable' &&
        adapter.notApplicableReason === 'store_absent_by_design'
      ) {
        const markedResolved = await this.repository
          .markResolved({
            tombstoneId: item.tombstone.tombstoneId,
            accountScopeId: item.tombstone.accountScopeId,
            environment: item.tombstone.environment,
            target: adapter.target,
            resolvedAt: now,
          })
          .then(
            () => true,
            () => false,
          );
        if (markedResolved) resolved += 1;
        this.health.recordDeletionRetry(markedResolved);
        continue;
      }
      const completed = await retryDeletionLedgerEntry({
        entry: item.entry,
        tombstone: item.tombstone,
        adapter,
        ledger: this.repository,
        now,
      }).catch(() => false);
      if (completed) resolved += 1;
      this.health.recordDeletionRetry(completed);
    }
    const pending = Math.max(0, work.length - resolved);
    this.health.setDeletionBacklog({ pending, oldestRetryAgeMs: pending ? oldestRetryAgeMs : 0 });
    return { attempted, resolved, pending };
  }
}

/** Replays every durable tombstone before a restored store is declared ready. */
export class TelemetryTombstoneReplayWorker {
  private readonly adapters: ReadonlyMap<TelemetryPurgeTarget, TelemetryPurgeAdapter>;

  constructor(
    private readonly repository: PostgresTelemetryGovernanceRepository,
    adapters: readonly TelemetryPurgeAdapter[],
    private readonly health: TelemetryGovernanceRuntimeHealth,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.target, adapter]));
  }

  async replayPartitions(
    partitions: readonly ScopedGovernancePartition[],
    input: { now?: number; maxTombstonesPerPartition?: number } = {},
  ): Promise<{ ready: boolean; replayed: number; pendingTargets: number; truncated: boolean }> {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const limit = Math.max(1, Math.min(10_000, input.maxTombstonesPerPartition ?? 5_000));
    let replayed = 0;
    let pendingTargets = 0;
    let truncated = false;
    for (const partition of partitions) {
      let tombstones;
      try {
        tombstones = await this.repository.listTombstones({ ...partition, limit });
      } catch {
        pendingTargets += REQUIRED_TELEMETRY_PURGE_TARGETS.length;
        continue;
      }
      if (tombstones.length >= limit) truncated = true;
      for (const tombstone of tombstones) {
        replayed += 1;
        for (const target of REQUIRED_TELEMETRY_PURGE_TARGETS) {
          const adapter = this.adapters.get(target);
          if (!adapter) {
            pendingTargets += 1;
            await this.repository
              .upsertFailure({
                tombstoneId: tombstone.tombstoneId,
                accountScopeId: tombstone.accountScopeId,
                environment: tombstone.environment,
                target,
                status: 'pending',
                reasonCode: 'target_unavailable',
                attempts: 1,
                retryAfter: now + 60_000,
                updatedAt: now,
              })
              .catch(() => undefined);
            continue;
          }
          if (
            adapter.applicability === 'not_applicable' &&
            adapter.notApplicableReason === 'store_absent_by_design'
          ) {
            try {
              await this.repository.markResolved({
                tombstoneId: tombstone.tombstoneId,
                accountScopeId: tombstone.accountScopeId,
                environment: tombstone.environment,
                target,
                resolvedAt: now,
              });
            } catch {
              pendingTargets += 1;
            }
            continue;
          }
          try {
            await adapter.purge(tombstone);
            await this.repository.markResolved({
              tombstoneId: tombstone.tombstoneId,
              accountScopeId: tombstone.accountScopeId,
              environment: tombstone.environment,
              target,
              resolvedAt: now,
            });
          } catch (error) {
            pendingTargets += 1;
            await this.repository
              .upsertFailure({
                tombstoneId: tombstone.tombstoneId,
                accountScopeId: tombstone.accountScopeId,
                environment: tombstone.environment,
                target,
                status: 'pending',
                reasonCode: failureReason(error),
                attempts: 1,
                retryAfter: now + 60_000,
                updatedAt: now,
              })
              .catch(() => undefined);
          }
        }
      }
    }
    this.health.setDeletionBacklog({ pending: pendingTargets, oldestRetryAgeMs: 0 });
    return {
      ready: pendingTargets === 0 && !truncated,
      replayed,
      pendingTargets,
      truncated,
    };
  }
}

export interface TelemetryGovernanceScopeProvider {
  listAuthoritativePartitions(): Promise<readonly ScopedGovernancePartition[]>;
}

/**
 * Non-overlapping background orchestration. Errors are absorbed into health
 * state and never surface on an Agent/chat promise chain.
 */
export class TelemetryGovernanceRuntimeWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly scopeProvider: TelemetryGovernanceScopeProvider,
    private readonly retention: PostgresTelemetryRetentionWorker,
    private readonly deletionRetries: TelemetryDeletionRetryWorker,
    private readonly tombstoneReplay: TelemetryTombstoneReplayWorker,
    private readonly onRestoreStateChange?: (ready: boolean) => void,
    private readonly operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  ) {}

  async runOnce(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const restore = await this.runRestoreGate(now);
      try {
        this.onRestoreStateChange?.(restore.ready);
      } catch {
        // Health projection is a side channel and cannot stop cleanup/retries.
      }
      await this.deletionRetries.runOnce({ now });
    } finally {
      this.running = false;
    }
  }

  async runRestoreGate(now = Date.now()): Promise<{
    ready: boolean;
    replayed: number;
    pendingTargets: number;
    retentionFailures: number;
  }> {
    let partitions: readonly ScopedGovernancePartition[];
    try {
      partitions = await within(
        Promise.resolve(this.scopeProvider.listAuthoritativePartitions()),
        this.operationTimeoutMs,
      );
    } catch {
      this.retention.recordScopeDiscoveryFailure();
      return { ready: false, replayed: 0, pendingTargets: 0, retentionFailures: 1 };
    }
    let retentionFailures = 0;
    for (const partition of partitions) {
      const result = await this.retention.runScope(partition, now);
      if (!result.ok) retentionFailures += 1;
    }
    const replay = await this.tombstoneReplay.replayPartitions(partitions, { now });
    return {
      ready: retentionFailures === 0 && replay.ready,
      replayed: replay.replayed,
      pendingTargets: replay.pendingTargets,
      retentionFailures,
    };
  }

  start(intervalMs = DEFAULT_WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    const boundedInterval = Math.max(60_000, Math.min(24 * 60 * 60_000, intervalMs));
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), boundedInterval);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}