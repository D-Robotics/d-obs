/**
 * Product metadata carried beside an untouched official DSH `session.prompt`
 * request. DSH still owns the RPC envelope and session protocol; this object
 * is the thin Studio pre-admission input (billing, device, expert and context).
 */
export const STUDIO_PROMPT_COMMAND_VERSION = 1;
export const STUDIO_DSH_PROMPT_CARRIER_HEADER = 'x-rdk-studio-prompt-command';
export const STUDIO_DSH_PROMPT_CARRIER_HEADER_VALUE = '1';
/** One protocol limit shared by public carrier admission and run materialization. */
export const STUDIO_PROMPT_ATTACHMENT_LIMIT = 12;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function requiredText(label, value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}
function messageText(value) {
    if (typeof value !== 'string' || value.includes('\u0000')) {
        throw new TypeError('message must be a string without NUL bytes');
    }
    return value;
}
function cloneJsonRecord(value) {
    let clone;
    try {
        clone = JSON.parse(JSON.stringify(value));
    }
    catch {
        throw new TypeError('Studio prompt admission must be JSON serializable');
    }
    const cloned = record(clone);
    if (!cloned)
        throw new TypeError('Studio prompt admission must be a JSON object');
    const freeze = (item) => {
        if (Array.isArray(item)) {
            for (const child of item)
                freeze(child);
            return Object.freeze(item);
        }
        const object = record(item);
        if (!object)
            return item;
        for (const child of Object.values(object))
            freeze(child);
        return Object.freeze(object);
    };
    return freeze(cloned);
}
export function normalizeStudioPromptCommand(value) {
    const input = record(value);
    if (!input || input.version !== STUDIO_PROMPT_COMMAND_VERSION) {
        throw new TypeError('Unsupported Studio prompt command version');
    }
    const externalSessionId = requiredText('externalSessionId', input.externalSessionId).trim();
    const message = messageText(input.message);
    const admission = record(input.admission);
    if (!admission)
        throw new TypeError('Studio prompt admission must be an object');
    if (admission.sessionId !== externalSessionId || admission.message !== message) {
        throw new TypeError('Studio prompt command and admission identity do not match');
    }
    if ('runId' in admission || 'canonicalRunId' in admission) {
        throw new TypeError('Studio prompt admission cannot choose the official run id');
    }
    if (!message.trim() &&
        (!Array.isArray(admission.attachments) || admission.attachments.length === 0)) {
        throw new TypeError('Studio prompt requires a message or attachment');
    }
    return Object.freeze({
        version: STUDIO_PROMPT_COMMAND_VERSION,
        externalSessionId,
        message,
        admission: cloneJsonRecord(admission),
    });
}
export function normalizeStudioDshPromptCarrierEnvelope(value) {
    const input = record(value);
    if (!input || !('dsh' in input) || !('studio' in input)) {
        throw new TypeError('Studio DSH prompt carrier envelope is invalid');
    }
    return Object.freeze({
        dsh: input.dsh,
        studio: normalizeStudioPromptCommand(input.studio),
    });
}
