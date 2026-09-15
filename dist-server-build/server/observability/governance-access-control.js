import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
const clean = (value, max = 256) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, max);
export function authorizeTelemetryAccess(actor, request) {
    const actorId = clean(actor.actorId);
    const authenticatedScope = clean(actor.authenticatedAccountScopeId);
    const authorizationRevision = clean(actor.authorizationRevision, 128);
    if (!actorId ||
        !authenticatedScope ||
        !authorizationRevision ||
        !actor.permissions.includes(request.permission)) {
        return { allowed: false, publicReason: 'not_found' };
    }
    if (actor.role === 'account_owner') {
        const selected = clean(request.selectedAccountScopeId || authenticatedScope);
        return selected === authenticatedScope
            ? {
                allowed: true,
                accountScopeId: authenticatedScope,
                actorId,
                role: actor.role,
                permission: request.permission,
                authorizationRevision,
            }
            : { allowed: false, publicReason: 'not_found' };
    }
    const selected = clean(request.selectedAccountScopeId);
    const entitled = new Set((actor.entitledAccountScopeIds ?? []).map((scope) => clean(scope)));
    if (!selected || !entitled.has(selected))
        return { allowed: false, publicReason: 'not_found' };
    return {
        allowed: true,
        accountScopeId: selected,
        actorId,
        role: actor.role,
        permission: request.permission,
        authorizationRevision,
    };
}
/** Every governed repository query starts with this authoritative predicate. */
export function authoritativeScopePredicate(decision, placeholder = 1) {
    if (!Number.isSafeInteger(placeholder) || placeholder < 1) {
        throw new TypeError('invalid SQL placeholder');
    }
    return { sql: `account_scope_id = $${placeholder}`, values: [decision.accountScopeId] };
}
/** A foreign identifier and a missing identifier intentionally have the same result. */
export async function idorSafeScopedLookup(input) {
    const identifier = clean(input.opaqueIdentifier, 512);
    if (!input.decision.allowed || !identifier)
        return { found: false, publicReason: 'not_found' };
    const value = await input.repository.findInAccountScope(input.decision.accountScopeId, identifier);
    return value === null ? { found: false, publicReason: 'not_found' } : { found: true, value };
}
function digest(secret, domain, value) {
    return createHmac('sha256', secret).update(`${domain}\0${value}`).digest('base64url');
}
function cursorKey(secret) {
    return createHash('sha256').update(`governance-cursor-v1\0${secret}`).digest();
}
function sealCursor(secret, payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
    cipher.setAAD(Buffer.from('governance-cursor-v1'));
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
    ]);
    return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher
        .getAuthTag()
        .toString('base64url')}`;
}
function unsealCursor(secret, token) {
    const [version, encodedIv, encodedCiphertext, encodedTag, ...rest] = String(token ?? '').split('.');
    if (version !== 'v1' || !encodedIv || !encodedCiphertext || !encodedTag || rest.length)
        return null;
    try {
        const iv = Buffer.from(encodedIv, 'base64url');
        const ciphertext = Buffer.from(encodedCiphertext, 'base64url');
        const tag = Buffer.from(encodedTag, 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4_096)
            return null;
        const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), iv);
        decipher.setAAD(Buffer.from('governance-cursor-v1'));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    }
    catch {
        return null;
    }
}
export function issueGovernanceCursor(input) {
    const secret = clean(input.secret, 1_024);
    const position = clean(input.position, 512);
    if (!secret || secret.length < 16 || !position)
        return null;
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const ttlMs = Math.max(30_000, Math.min(30 * 60_000, input.ttlMs ?? 10 * 60_000));
    const payload = {
        version: 1,
        scopeDigest: digest(secret, 'scope', input.decision.accountScopeId),
        authorizationDigest: digest(secret, 'authorization', `${input.decision.actorId}\0${input.decision.authorizationRevision}`),
        permission: input.decision.permission,
        position,
        expiresAt: now + ttlMs,
    };
    return sealCursor(secret, payload);
}
export function verifyGovernanceCursor(input) {
    if (!input.decision.allowed)
        return null;
    const secret = clean(input.secret, 1_024);
    if (secret.length < 16)
        return null;
    try {
        const parsed = unsealCursor(secret, input.token);
        if (!parsed)
            return null;
        const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
        if (parsed.version !== 1 ||
            parsed.permission !== input.decision.permission ||
            parsed.scopeDigest !== digest(secret, 'scope', input.decision.accountScopeId) ||
            parsed.authorizationDigest !==
                digest(secret, 'authorization', `${input.decision.actorId}\0${input.decision.authorizationRevision}`) ||
            !Number.isFinite(parsed.expiresAt) ||
            Number(parsed.expiresAt) <= now) {
            return null;
        }
        const position = clean(parsed.position, 512);
        return position ? { position } : null;
    }
    catch {
        return null;
    }
}
/** Prevent a desktop outbox partition from being sent after an account switch. */
export function mayDrainTelemetryPartition(input) {
    return (input.access.allowed &&
        clean(input.partitionAccountScopeId) === input.access.accountScopeId &&
        clean(input.activeCredentialAccountScopeId) === input.access.accountScopeId);
}
