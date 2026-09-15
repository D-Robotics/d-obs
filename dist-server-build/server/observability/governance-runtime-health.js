export const TELEMETRY_GOVERNANCE_HEALTH_COUNTERS = [
    'retention.runs',
    'retention.low_sensitivity_deleted',
    'retention.payload_deleted',
    'retention.failures',
    'retention.timeouts',
    'deletion.runs',
    'deletion.completed',
    'deletion.pending',
    'deletion.retry_attempts',
    'deletion.retry_resolved',
    'deletion.retry_failed',
    'queue.tombstone_discarded',
    'restore.expired_discarded',
    'restore.tombstone_discarded',
    'payload.sink_rejected',
];
const RETENTION_FAILURE_ALERT_THRESHOLD = 3;
const DELETION_STALLED_MS = 15 * 60_000;
function boundedCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
/**
 * Process-local health projection. Keys and alert codes are fixed; callers
 * cannot attach account, user, run, trace, session, grant, or backend IDs.
 */
export class TelemetryGovernanceRuntimeHealth {
    counters = new Map();
    deletionPending = 0;
    deletionOldestRetryAgeMs = 0;
    retentionConsecutiveFailures = 0;
    deletionConsecutiveFailures = 0;
    increment(key, amount = 1) {
        const count = boundedCount(amount);
        if (!count)
            return;
        this.counters.set(key, (this.counters.get(key) ?? 0) + count);
    }
    recordRetentionSuccess(input) {
        this.increment('retention.runs');
        this.increment('retention.low_sensitivity_deleted', input.lowSensitivityDeleted);
        this.increment('retention.payload_deleted', input.payloadDeleted);
        this.retentionConsecutiveFailures = 0;
    }
    recordRetentionFailure(reason) {
        this.increment('retention.runs');
        this.increment('retention.failures');
        if (reason === 'timeout')
            this.increment('retention.timeouts');
        this.retentionConsecutiveFailures += 1;
    }
    recordDeletionResult(input) {
        this.increment('deletion.runs');
        this.increment(input.completed ? 'deletion.completed' : 'deletion.pending');
        this.deletionConsecutiveFailures = input.completed
            ? 0
            : this.deletionConsecutiveFailures + Math.max(1, boundedCount(input.pendingTargets));
    }
    recordDeletionRetry(resolved) {
        this.increment('deletion.retry_attempts');
        this.increment(resolved ? 'deletion.retry_resolved' : 'deletion.retry_failed');
        this.deletionConsecutiveFailures = resolved
            ? Math.max(0, this.deletionConsecutiveFailures - 1)
            : this.deletionConsecutiveFailures + 1;
    }
    setDeletionBacklog(input) {
        this.deletionPending = boundedCount(input.pending);
        this.deletionOldestRetryAgeMs = boundedCount(input.oldestRetryAgeMs);
    }
    snapshot() {
        const counters = Object.fromEntries(TELEMETRY_GOVERNANCE_HEALTH_COUNTERS.map((key) => [key, this.counters.get(key) ?? 0]));
        const alerts = [];
        if (this.retentionConsecutiveFailures >= RETENTION_FAILURE_ALERT_THRESHOLD) {
            alerts.push('retention_cleanup_failing');
        }
        if (this.deletionPending > 0)
            alerts.push('deletion_retry_backlog');
        if (this.deletionPending > 0 && this.deletionOldestRetryAgeMs >= DELETION_STALLED_MS) {
            alerts.push('deletion_retry_stalled');
        }
        if ((counters['payload.sink_rejected'] ?? 0) > 0) {
            alerts.push('payload_sink_noncompliant');
        }
        return Object.freeze({
            status: alerts.length > 0 ? 'degraded' : 'healthy',
            counters: Object.freeze(counters),
            gauges: Object.freeze({
                deletionPending: this.deletionPending,
                deletionOldestRetryAgeMs: this.deletionOldestRetryAgeMs,
                retentionConsecutiveFailures: this.retentionConsecutiveFailures,
                deletionConsecutiveFailures: this.deletionConsecutiveFailures,
            }),
            alerts: Object.freeze(alerts),
        });
    }
}
const processTelemetryGovernanceHealth = new TelemetryGovernanceRuntimeHealth();
/** Shared process health source for worker composition and monitoring adapters. */
export function getTelemetryGovernanceRuntimeHealth() {
    return processTelemetryGovernanceHealth;
}
