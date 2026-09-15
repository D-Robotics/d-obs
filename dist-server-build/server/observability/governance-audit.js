import { createHmac } from 'node:crypto';
export const TELEMETRY_AUDIT_ACTIONS = [
    'read',
    'search',
    'advanced_link',
    'payload_read',
    'payload_capture',
    'grant_change',
    'policy_change',
    'retention_change',
    'deletion',
    'redaction_failure',
    'access_denial',
];
export class TelemetryAuditUnavailableError extends Error {
    code = 'telemetry_audit_unavailable';
    constructor() {
        super('required telemetry audit durability is unavailable');
        this.name = 'TelemetryAuditUnavailableError';
    }
}
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const REF_PATTERN = /^ref_[A-Za-z0-9_-]{32,64}$/;
function boundedCode(value, fallback) {
    const code = String(value ?? '')
        .trim()
        .toLowerCase();
    return CODE_PATTERN.test(code) ? code : fallback;
}
function ref(secret, domain, value) {
    return `ref_${createHmac('sha256', secret)
        .update(`${domain}\0${String(value ?? '').trim()}`)
        .digest('base64url')}`;
}
export function createContentFreeAuditEvent(input, secret) {
    if (String(secret).length < 16)
        throw new TypeError('audit reference secret is too short');
    const timestamp = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : Date.now();
    const targetIdentifier = String(input.targetIdentifier ?? input.targetType);
    const event = {
        eventVersion: 1,
        occurredAt: new Date(timestamp).toISOString(),
        actorRef: ref(secret, 'actor', input.actorId),
        actorRole: input.actorRole,
        accountScopeRef: ref(secret, 'account-scope', input.accountScopeId),
        action: input.action,
        targetType: input.targetType,
        targetRef: ref(secret, input.targetType, targetIdentifier),
        decision: input.decision,
        purposeCode: boundedCode(input.purposeCode, 'unspecified'),
        requestCorrelationRef: ref(secret, 'request', input.requestCorrelationId),
        result: input.result,
    };
    assertContentFreeAuditEvent(event);
    return event;
}
export function assertContentFreeAuditEvent(event) {
    const expectedKeys = [
        'accountScopeRef',
        'action',
        'actorRef',
        'actorRole',
        'decision',
        'eventVersion',
        'occurredAt',
        'purposeCode',
        'requestCorrelationRef',
        'result',
        'targetRef',
        'targetType',
    ];
    const actualKeys = Object.keys(event).sort((left, right) => left.localeCompare(right));
    if (actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index]) ||
        event.eventVersion !== 1 ||
        !Number.isFinite(Date.parse(event.occurredAt)) ||
        !REF_PATTERN.test(event.actorRef) ||
        !REF_PATTERN.test(event.accountScopeRef) ||
        !REF_PATTERN.test(event.targetRef) ||
        !REF_PATTERN.test(event.requestCorrelationRef) ||
        !TELEMETRY_AUDIT_ACTIONS.includes(event.action) ||
        !['account_owner', 'telemetry_administrator'].includes(event.actorRole) ||
        !['allowed', 'denied'].includes(event.decision) ||
        !['trace', 'run', 'session', 'grant', 'policy', 'retention', 'account'].includes(event.targetType) ||
        !['authorized', 'denied', 'completed', 'failed', 'redacted', 'scheduled'].includes(event.result) ||
        !CODE_PATTERN.test(event.purposeCode)) {
        throw new TypeError('telemetry audit event is not content-free');
    }
}
/**
 * All protected work is invoked only after its content-free authorization event
 * has been durably appended. An append failure leaves the callback untouched.
 */
export class TelemetryAuditGuard {
    sink;
    referenceSecret;
    constructor(sink, referenceSecret) {
        this.sink = sink;
        this.referenceSecret = referenceSecret;
    }
    async append(input) {
        const event = Object.freeze(createContentFreeAuditEvent(input, this.referenceSecret));
        try {
            await this.sink.append(event);
            return event;
        }
        catch {
            throw new TelemetryAuditUnavailableError();
        }
    }
    async runProtected(input, operation) {
        await this.append({ ...input, decision: 'allowed', result: 'authorized' });
        return operation();
    }
    async deny(input) {
        await this.append({ ...input, decision: 'denied', result: 'denied' });
        throw new Error('not_found');
    }
}
