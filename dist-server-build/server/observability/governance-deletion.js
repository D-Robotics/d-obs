export const REQUIRED_TELEMETRY_PURGE_TARGETS = [
    'primary_storage',
    'cache',
    'outbox',
    'retry_queue',
    'dead_letter_queue',
    'payload_store',
    'backend_mapping',
];
const clean = (value, max = 256) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, max);
function cleanSelector(selector = {}) {
    const output = {};
    for (const key of ['userId', 'runId', 'traceId', 'sessionId', 'grantId']) {
        const value = clean(selector[key], 256);
        if (value)
            output[key] = value;
    }
    return output;
}
function validEnvironment(value) {
    return ['production', 'staging', 'development', 'test'].includes(String(value));
}
function failureCode(error) {
    const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code ?? '').toLowerCase()
        : '';
    if (code === 'timeout' || code === 'etimedout')
        return 'timeout';
    if (code === 'unavailable' || code === 'econnrefused')
        return 'backend_unavailable';
    return 'unknown_failure';
}
export class TelemetryDeletionCoordinator {
    tombstones;
    ledger;
    audit;
    adapters;
    constructor(tombstones, adapters, ledger, audit) {
        this.tombstones = tombstones;
        this.ledger = ledger;
        this.audit = audit;
        this.adapters = new Map(adapters.map((adapter) => [adapter.target, adapter]));
    }
    async delete(request) {
        if (!request.access.allowed || request.access.permission !== 'telemetry.delete') {
            throw new Error('not_found');
        }
        const access = request.access;
        const requestId = clean(request.requestId, 256);
        if (!requestId)
            throw new TypeError('deletion request id is required');
        if (!validEnvironment(request.environment)) {
            throw new TypeError('deletion environment is required');
        }
        const now = Number.isFinite(request.now) ? Number(request.now) : Date.now();
        return this.audit.runProtected({
            actorId: access.actorId,
            actorRole: access.role,
            accountScopeId: access.accountScopeId,
            action: 'deletion',
            targetType: 'account',
            targetIdentifier: JSON.stringify({
                environment: request.environment,
                ...cleanSelector(request.selector),
            }),
            purposeCode: request.purposeCode,
            requestCorrelationId: request.requestCorrelationId,
            occurredAt: now,
        }, async () => {
            // Tombstone durability is always established before touching any backend.
            const tombstone = await this.tombstones.putIfAbsent({
                requestId,
                accountScopeId: access.accountScopeId,
                environment: request.environment,
                createdAt: now,
                ...cleanSelector(request.selector),
            });
            const pendingTargets = [];
            const notApplicableTargets = [];
            for (const target of REQUIRED_TELEMETRY_PURGE_TARGETS) {
                const adapter = this.adapters.get(target);
                if (!adapter) {
                    pendingTargets.push(target);
                    await this.ledger.upsertFailure({
                        tombstoneId: tombstone.tombstoneId,
                        accountScopeId: tombstone.accountScopeId,
                        environment: tombstone.environment,
                        target,
                        status: 'pending',
                        reasonCode: 'target_unavailable',
                        attempts: 1,
                        retryAfter: now + 60_000,
                        updatedAt: now,
                    });
                    continue;
                }
                if (adapter.applicability === 'not_applicable' &&
                    adapter.notApplicableReason === 'store_absent_by_design') {
                    notApplicableTargets.push(target);
                    await this.ledger.markResolved({
                        tombstoneId: tombstone.tombstoneId,
                        accountScopeId: tombstone.accountScopeId,
                        environment: tombstone.environment,
                        target,
                        resolvedAt: now,
                    });
                    continue;
                }
                try {
                    await adapter.purge(tombstone);
                    await this.ledger.markResolved({
                        tombstoneId: tombstone.tombstoneId,
                        accountScopeId: tombstone.accountScopeId,
                        environment: tombstone.environment,
                        target,
                        resolvedAt: now,
                    });
                }
                catch (error) {
                    pendingTargets.push(target);
                    await this.ledger.upsertFailure({
                        tombstoneId: tombstone.tombstoneId,
                        accountScopeId: tombstone.accountScopeId,
                        environment: tombstone.environment,
                        target,
                        status: 'pending',
                        reasonCode: failureCode(error),
                        attempts: 1,
                        retryAfter: now + 60_000,
                        updatedAt: now,
                    });
                }
            }
            return {
                tombstone,
                completed: pendingTargets.length === 0,
                pendingTargets,
                notApplicableTargets,
            };
        });
    }
}
export async function retryDeletionLedgerEntry(input) {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    if (input.entry.status !== 'pending' ||
        input.entry.target !== input.adapter.target ||
        input.entry.tombstoneId !== input.tombstone.tombstoneId ||
        input.entry.accountScopeId !== input.tombstone.accountScopeId ||
        input.entry.environment !== input.tombstone.environment ||
        input.entry.retryAfter > now) {
        return false;
    }
    try {
        await input.adapter.purge(input.tombstone);
        await input.ledger.markResolved({
            tombstoneId: input.tombstone.tombstoneId,
            accountScopeId: input.tombstone.accountScopeId,
            environment: input.tombstone.environment,
            target: input.adapter.target,
            resolvedAt: now,
        });
        return true;
    }
    catch (error) {
        const attempts = input.entry.attempts + 1;
        await input.ledger.upsertFailure({
            ...input.entry,
            reasonCode: failureCode(error),
            attempts,
            retryAfter: now + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 10)),
            updatedAt: now,
        });
        return false;
    }
}
export function isTombstoned(record, tombstones) {
    return tombstones.some((tombstone) => {
        if (tombstone.accountScopeId !== record.accountScopeId)
            return false;
        if (tombstone.environment !== record.environment)
            return false;
        for (const key of ['userId', 'runId', 'traceId', 'sessionId', 'grantId']) {
            if (tombstone[key] !== undefined && tombstone[key] !== record[key])
                return false;
        }
        return true;
    });
}
/** Apply retention and all durable tombstones before restored data becomes readable/exportable. */
export function filterRestoredTelemetry(input) {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    return input.records.filter((record) => Number.isFinite(record.expiresAt) &&
        record.expiresAt > now &&
        !isTombstoned(record, input.tombstones));
}
