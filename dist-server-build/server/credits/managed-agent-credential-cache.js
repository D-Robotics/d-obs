/**
 * Owner-scoped credential cache and session state for the managed Agent lane.
 *
 * This module deliberately contains persistence/state mechanics only.  The
 * public facade remains `managed-agent-credential.ts`; keeping the state here
 * prevents the facade from becoming a second monolith while preserving one
 * process-local source of truth for logout and generation fences.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replaceFileSyncWithRetry } from '../atomic-file-replace.js';
import { CredentialRevocationStoreUnavailableError, captureCredentialRevocationFence, isCredentialRevoked, latestCredentialRevocationAt, } from '../credential-revocation-tombstones.js';
import { resolveDataDir } from '../storage.js';
import { isWebCloudDeployment } from '../studio-deployment.js';
export const CENTRAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_MANAGED_CREDENTIAL_TTL_MS = 60_000;
/**
 * A cache snapshot that cannot be read or validated is not an empty cache.
 * Callers must stop before writing a replacement, otherwise a transient
 * permission/parse error could erase another owner's still-valid key.
 */
export class ManagedCredentialCacheUnavailableError extends Error {
    constructor() {
        super('managed Agent credential cache is temporarily unavailable');
        this.name = 'ManagedCredentialCacheUnavailableError';
    }
}
/** Mutable runtime state shared by the facade and this cache module. */
export const credentialRuntimeState = {
    centralSession: null,
    locallyLoggedOutUsers: new Set(),
    credentialGenerations: new Map(),
    requestManagedCredentialCache: new Map(),
    lazyKeyFetchCooldown: new Map(),
};
const warnedScopes = new Set();
export function warnOnce(scope, ...args) {
    if (warnedScopes.has(scope))
        return;
    warnedScopes.add(scope);
    console.warn(...args);
}
export function isCredentialRevocationStoreUnavailable(error) {
    return Boolean(error instanceof CredentialRevocationStoreUnavailableError ||
        (error &&
            typeof error === 'object' &&
            error.name === 'CredentialRevocationStoreUnavailableError'));
}
export function isManagedCredentialCacheUnavailable(error) {
    return Boolean(error instanceof ManagedCredentialCacheUnavailableError ||
        (error &&
            typeof error === 'object' &&
            error.name === 'ManagedCredentialCacheUnavailableError'));
}
export function warnRevocationStoreUnavailable() {
    warnOnce('managed-agent-revocation-store-unavailable', '[credits] managed Agent credential lookup blocked: credential revocation state unavailable');
}
export function warnCredentialCacheUnavailable() {
    warnOnce('managed-agent-cache-unavailable', '[credits] managed Agent credential cache unavailable; credential lookup blocked');
}
/**
 * Probe the tombstone store before publishing any cached/centrally resolved
 * credential.  An unreadable store is an authentication decision, so callers
 * must fail closed instead of treating it as an empty cache.
 */
export function credentialRevocationStateAvailable() {
    try {
        captureCredentialRevocationFence();
        return true;
    }
    catch (error) {
        if (!isCredentialRevocationStoreUnavailable(error))
            throw error;
        warnRevocationStoreUnavailable();
        return false;
    }
}
function credentialCacheFile() {
    return path.join(resolveDataDir(), 'managed-agent-credential.json');
}
/**
 * Pre-DSH desktop builds persisted this snapshot under the Moss name.  It is
 * read only for an exact requested owner and is never enumerated into a
 * canonical cache wholesale.
 */
function legacyCredentialCacheFile() {
    return path.join(resolveDataDir(), 'managed-moss-key.json');
}
let persistenceTestHooks = null;
function parseCachedEntry(value) {
    if (typeof value === 'string') {
        const key = value.trim();
        return key ? { key } : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const item = value;
    const key = typeof item.key === 'string' && item.key.trim() ? item.key.trim() : undefined;
    const sid = typeof item.sid === 'string' && item.sid.trim() ? item.sid.trim() : undefined;
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) && item.updatedAt > 0
        ? item.updatedAt
        : undefined;
    return key || sid
        ? { ...(key ? { key } : {}), ...(sid ? { sid } : {}), ...(updatedAt ? { updatedAt } : {}) }
        : null;
}
export function loadCredentialCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(credentialCacheFile(), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new ManagedCredentialCacheUnavailableError();
        }
        const out = {};
        for (const [uid, value] of Object.entries(raw)) {
            const entry = parseCachedEntry(value);
            if (!entry)
                throw new ManagedCredentialCacheUnavailableError();
            const revokedUserAt = latestCredentialRevocationAt('user', uid);
            if ((entry.sid && isCredentialRevoked('cloudSession', entry.sid)) ||
                (revokedUserAt > 0 && (!entry.updatedAt || entry.updatedAt <= revokedUserAt))) {
                continue;
            }
            out[uid] = entry;
        }
        return out;
    }
    catch (error) {
        // A missing first-run snapshot is an ordinary empty cache.  Any other
        // read/parse/validation failure is an unavailable snapshot: callers must
        // fail closed and must not overwrite other owners' entries with `{}`.
        if (isCredentialRevocationStoreUnavailable(error))
            throw error;
        if (error?.code === 'ENOENT')
            return {};
        if (isManagedCredentialCacheUnavailable(error))
            throw error;
        throw new ManagedCredentialCacheUnavailableError();
    }
}
/** Persist a small private JSON snapshot atomically and durably. */
export function saveCredentialCacheAt(filePath, cache) {
    let temporaryPath = '';
    let fileDescriptor = null;
    try {
        const dir = resolveDataDir();
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const dest = filePath;
        temporaryPath = `${dest}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(fileDescriptor, JSON.stringify(cache), { encoding: 'utf8' });
        fs.fsyncSync(fileDescriptor);
        fs.closeSync(fileDescriptor);
        fileDescriptor = null;
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(temporaryPath, 0o600);
            }
            catch {
                /* 外部文件系统可能不支持 POSIX mode */
            }
        }
        replaceFileSyncWithRetry(temporaryPath, dest, persistenceTestHooks?.renameSync ?? fs.renameSync);
        temporaryPath = '';
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(dest, 0o600);
            }
            catch {
                /* 外部文件系统可能不支持 POSIX mode */
            }
        }
        try {
            const directoryDescriptor = fs.openSync(dir, 'r');
            try {
                fs.fsyncSync(directoryDescriptor);
            }
            finally {
                fs.closeSync(directoryDescriptor);
            }
        }
        catch {
            /* Windows/network filesystems may not support directory fsync. */
        }
    }
    catch (error) {
        if (fileDescriptor !== null) {
            try {
                fs.closeSync(fileDescriptor);
            }
            catch {
                /* exact cleanup below */
            }
        }
        if (temporaryPath) {
            try {
                fs.unlinkSync(temporaryPath);
            }
            catch {
                /* preserve existing snapshot */
            }
        }
        /* 缓存落盘失败不阻断；重启后需重新登录以恢复 owner-scoped credential。 */
        warnOnce('managed-agent-cache-persist-failed', '[credits] managed Agent credential snapshot persist failed', String(error?.code ?? 'UNKNOWN'));
    }
}
/** Test-only hook for deterministic Windows rename/lock failure coverage. */
export function setManagedKeyPersistenceTestHooksForTest(hooks) {
    persistenceTestHooks = hooks;
}
export function saveCredentialCache(cache) {
    saveCredentialCacheAt(credentialCacheFile(), cache);
}
/** Read one legacy record without exposing or iterating any other account. */
export function readLegacyCredentialEntry(userId) {
    const id = String(userId ?? '').trim();
    if (!id)
        return null;
    try {
        const raw = JSON.parse(fs.readFileSync(legacyCredentialCacheFile(), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        if (!Object.prototype.hasOwnProperty.call(raw, id))
            return null;
        const entry = parseCachedEntry(raw[id]);
        if (!entry)
            return null;
        const revokedUserAt = latestCredentialRevocationAt('user', id);
        if ((entry.sid && isCredentialRevoked('cloudSession', entry.sid)) ||
            (revokedUserAt > 0 && (!entry.updatedAt || entry.updatedAt <= revokedUserAt))) {
            return null;
        }
        return entry;
    }
    catch (error) {
        if (isCredentialRevocationStoreUnavailable(error))
            throw error;
        return null;
    }
}
/** Read legacy records only for the host-fallback ambiguity check. */
export function readLegacyCredentialCandidates() {
    const out = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(legacyCredentialCacheFile(), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return out;
        for (const [uid, value] of Object.entries(raw)) {
            const entry = parseCachedEntry(value);
            if (!entry)
                continue;
            const revokedUserAt = latestCredentialRevocationAt('user', uid);
            if ((entry.sid && isCredentialRevoked('cloudSession', entry.sid)) ||
                (revokedUserAt > 0 && (!entry.updatedAt || entry.updatedAt <= revokedUserAt))) {
                continue;
            }
            out.set(uid, entry);
        }
    }
    catch (error) {
        if (isCredentialRevocationStoreUnavailable(error))
            throw error;
        /* malformed/locked legacy file is treated as no fallback candidate */
    }
    return out;
}
/** Resolve canonical first, then one exact legacy record; migrate only that record. */
export function readCredentialEntryForUser(userId) {
    const id = String(userId ?? '').trim();
    if (!id)
        return null;
    const canonical = loadCredentialCache()[id];
    if (canonical)
        return canonical;
    const legacy = readLegacyCredentialEntry(id);
    if (!legacy)
        return null;
    const migrated = { ...loadCredentialCache(), [id]: legacy };
    saveCredentialCache(migrated);
    return legacy;
}
function advanceCredentialGeneration(ssoUserId) {
    const next = (credentialRuntimeState.credentialGenerations.get(ssoUserId) ?? 0) + 1;
    credentialRuntimeState.credentialGenerations.set(ssoUserId, next);
    return next;
}
export function beginVerifiedCredentialSession(ssoUserId) {
    const generation = advanceCredentialGeneration(ssoUserId);
    credentialRuntimeState.locallyLoggedOutUsers.delete(ssoUserId);
    return generation;
}
export function credentialOperationIsCurrent(ssoUserId, generation) {
    return ((credentialRuntimeState.credentialGenerations.get(ssoUserId) ?? 0) === generation &&
        !credentialRuntimeState.locallyLoggedOutUsers.has(ssoUserId));
}
export function currentCredentialGeneration(ssoUserId) {
    return credentialRuntimeState.credentialGenerations.get(ssoUserId) ?? 0;
}
/**
 * 登出 / 切户时清掉该用户全部桌面凭据：中心会话、按请求缓存和本机
 * canonical snapshot。中心账户本身不删除；再次登录会建立新 generation。
 */
export function clearManagedAgentCredentialForUser(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (!id)
        return;
    advanceCredentialGeneration(id);
    if (!isWebCloudDeployment())
        credentialRuntimeState.locallyLoggedOutUsers.add(id);
    if (credentialRuntimeState.centralSession?.ssoUserId === id) {
        credentialRuntimeState.centralSession = null;
    }
    invalidateRequestManagedAgentCredentialCache(id);
    try {
        const cache = loadCredentialCache();
        if (Object.prototype.hasOwnProperty.call(cache, id)) {
            delete cache[id];
            saveCredentialCache(cache);
        }
    }
    catch (error) {
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else if (isManagedCredentialCacheUnavailable(error))
            warnCredentialCacheUnavailable();
        /* in-memory fence already prevents reuse if persistence is unavailable */
    }
    // Remove the exact owner from the pre-DSH legacy file as well.  Do not
    // migrate or rewrite any other account's record while handling logout.
    try {
        const legacyPath = legacyCredentialCacheFile();
        const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const legacy = { ...raw };
            if (Object.prototype.hasOwnProperty.call(legacy, id)) {
                delete legacy[id];
                saveCredentialCacheAt(legacyPath, legacy);
            }
        }
    }
    catch {
        /* The in-memory generation fence still prevents reuse in this process. */
    }
}
/** Remove exactly the cache records carrying a known central session id. */
export function clearManagedAgentCredentialForCentralSession(sessionId) {
    const sid = String(sessionId ?? '').trim();
    if (!/^[a-f0-9]{64}$/i.test(sid))
        return;
    let canonical;
    let legacy;
    try {
        canonical = loadCredentialCache();
        legacy = readLegacyCredentialCandidates();
    }
    catch (error) {
        if (!isCredentialRevocationStoreUnavailable(error) &&
            !isManagedCredentialCacheUnavailable(error)) {
            throw error;
        }
        // We cannot safely identify every owner while revocation or cache state is
        // unreadable. Clear only an already-bound in-memory owner.
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else
            warnCredentialCacheUnavailable();
        if (credentialRuntimeState.centralSession?.sid === sid) {
            const owner = credentialRuntimeState.centralSession.ssoUserId;
            advanceCredentialGeneration(owner);
            if (!isWebCloudDeployment())
                credentialRuntimeState.locallyLoggedOutUsers.add(owner);
            credentialRuntimeState.centralSession = null;
            invalidateRequestManagedAgentCredentialCache(owner);
        }
        else {
            credentialRuntimeState.requestManagedCredentialCache.clear();
        }
        return;
    }
    const matched = new Set();
    for (const [userId, entry] of Object.entries(canonical)) {
        if (entry.sid === sid)
            matched.add(userId);
    }
    for (const [userId, entry] of legacy) {
        if (entry.sid === sid)
            matched.add(userId);
    }
    if (matched.size === 0)
        return;
    for (const userId of matched) {
        advanceCredentialGeneration(userId);
        if (!isWebCloudDeployment())
            credentialRuntimeState.locallyLoggedOutUsers.add(userId);
        if (credentialRuntimeState.centralSession?.ssoUserId === userId) {
            credentialRuntimeState.centralSession = null;
        }
        invalidateRequestManagedAgentCredentialCache(userId);
        delete canonical[userId];
    }
    saveCredentialCache(canonical);
    try {
        const legacyPath = legacyCredentialCacheFile();
        const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const next = { ...raw };
            for (const userId of matched)
                delete next[userId];
            saveCredentialCacheAt(legacyPath, next);
        }
    }
    catch {
        /* in-memory generation fences remain authoritative for this process */
    }
}
/** Remove a user's dead central session while retaining its per-user key. */
export function invalidateCentralSession(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (!id)
        return;
    advanceCredentialGeneration(id);
    if (credentialRuntimeState.centralSession?.ssoUserId === id) {
        credentialRuntimeState.centralSession = null;
    }
    try {
        const cache = loadCredentialCache();
        const entry = cache[id];
        if (entry?.sid) {
            delete entry.sid;
            saveCredentialCache(cache);
        }
    }
    catch (error) {
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else if (isManagedCredentialCacheUnavailable(error))
            warnCredentialCacheUnavailable();
        /* best-effort:磁盘清理失败不阻断,内存态已清 */
    }
}
function hydrateCentralSessionFromCache(ssoUserId) {
    if (credentialRuntimeState.locallyLoggedOutUsers.has(ssoUserId))
        return;
    const entry = readCredentialEntryForUser(ssoUserId);
    const staleSameUser = !!credentialRuntimeState.centralSession &&
        credentialRuntimeState.centralSession.ssoUserId === ssoUserId &&
        Date.now() - credentialRuntimeState.centralSession.at > CENTRAL_SESSION_TTL_MS;
    if (entry?.sid &&
        (!credentialRuntimeState.centralSession ||
            credentialRuntimeState.centralSession.ssoUserId !== ssoUserId ||
            staleSameUser)) {
        credentialRuntimeState.centralSession = { ssoUserId, sid: entry.sid, at: Date.now() };
    }
}
export function getCentralCreditsSession(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (!id || credentialRuntimeState.locallyLoggedOutUsers.has(id))
        return null;
    if (!credentialRevocationStateAvailable())
        return null;
    if (!credentialRuntimeState.centralSession ||
        credentialRuntimeState.centralSession.ssoUserId !== id ||
        Date.now() - credentialRuntimeState.centralSession.at > CENTRAL_SESSION_TTL_MS) {
        try {
            hydrateCentralSessionFromCache(id);
        }
        catch (error) {
            if (!isCredentialRevocationStoreUnavailable(error) &&
                !isManagedCredentialCacheUnavailable(error)) {
                throw error;
            }
            if (isCredentialRevocationStoreUnavailable(error))
                warnRevocationStoreUnavailable();
            else
                warnCredentialCacheUnavailable();
            return null;
        }
    }
    if (credentialRuntimeState.centralSession &&
        credentialRuntimeState.centralSession.ssoUserId === id &&
        Date.now() - credentialRuntimeState.centralSession.at <= CENTRAL_SESSION_TTL_MS) {
        return credentialRuntimeState.centralSession.sid;
    }
    return null;
}
export function getCachedManagedAgentCredential(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (!id || credentialRuntimeState.locallyLoggedOutUsers.has(id))
        return null;
    try {
        return readCredentialEntryForUser(id)?.key?.trim() || null;
    }
    catch (error) {
        if (!isCredentialRevocationStoreUnavailable(error) &&
            !isManagedCredentialCacheUnavailable(error)) {
            throw error;
        }
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else
            warnCredentialCacheUnavailable();
        return null;
    }
}
export function listManagedAgentCredentialUsers() {
    try {
        return Object.keys(loadCredentialCache()).filter((id) => !credentialRuntimeState.locallyLoggedOutUsers.has(id));
    }
    catch (error) {
        if (!isCredentialRevocationStoreUnavailable(error) &&
            !isManagedCredentialCacheUnavailable(error)) {
            throw error;
        }
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else
            warnCredentialCacheUnavailable();
        return [];
    }
}
export function getDesktopHostCachedKey() {
    if (!credentialRevocationStateAvailable())
        return null;
    try {
        const cache = loadCredentialCache();
        if (credentialRuntimeState.centralSession &&
            Date.now() - credentialRuntimeState.centralSession.at <= CENTRAL_SESSION_TTL_MS &&
            !credentialRuntimeState.locallyLoggedOutUsers.has(credentialRuntimeState.centralSession.ssoUserId)) {
            return (readCredentialEntryForUser(credentialRuntimeState.centralSession.ssoUserId)?.key?.trim() ||
                null);
        }
        const candidates = new Map();
        for (const [userId, entry] of Object.entries(cache)) {
            if (credentialRuntimeState.locallyLoggedOutUsers.has(userId))
                continue;
            const key = entry.key?.trim();
            if (key)
                candidates.set(userId, key);
        }
        for (const [userId, entry] of readLegacyCredentialCandidates()) {
            if (credentialRuntimeState.locallyLoggedOutUsers.has(userId) || candidates.has(userId)) {
                continue;
            }
            const key = entry.key?.trim();
            if (key)
                candidates.set(userId, key);
        }
        if (candidates.size !== 1)
            return null;
        const [[userId, key]] = [...candidates.entries()];
        if (!cache[userId]) {
            const legacy = readLegacyCredentialEntry(userId);
            if (legacy)
                saveCredentialCache({ ...cache, [userId]: legacy });
        }
        return key;
    }
    catch (error) {
        if (!isCredentialRevocationStoreUnavailable(error) &&
            !isManagedCredentialCacheUnavailable(error)) {
            throw error;
        }
        if (isCredentialRevocationStoreUnavailable(error))
            warnRevocationStoreUnavailable();
        else
            warnCredentialCacheUnavailable();
        return null;
    }
}
export function invalidateRequestManagedAgentCredentialCache(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (id)
        credentialRuntimeState.requestManagedCredentialCache.delete(id);
    else
        credentialRuntimeState.requestManagedCredentialCache.clear();
}
export function getRequestManagedCredential(ssoUserId) {
    const cached = credentialRuntimeState.requestManagedCredentialCache.get(ssoUserId);
    return cached && Date.now() - cached.at < REQUEST_MANAGED_CREDENTIAL_TTL_MS ? cached.key : null;
}
export function cacheRequestManagedCredential(ssoUserId, key) {
    credentialRuntimeState.requestManagedCredentialCache.set(ssoUserId, {
        key,
        at: Date.now(),
    });
}
export async function provisionLocalCentralCreditsOnLogin(ssoUserId, deps) {
    const id = String(ssoUserId ?? '').trim();
    if (!id || !deps.isCentralCreditStoreEnabled())
        return false;
    await deps.ensureAccount(id, null);
    if (deps.isGatewayAdminConfigured()) {
        await deps.ensureDefaultUserKey(id);
        deps.onDefaultKeyReady?.(id);
    }
    return true;
}
export async function provisionFromLocalCentralStore(ssoUserId) {
    const centralStore = await import('./central-credit-store.js');
    if (!centralStore.isCentralCreditStoreEnabled())
        return false;
    const gatewayAdmin = await import('./gateway-admin-client.js');
    return provisionLocalCentralCreditsOnLogin(ssoUserId, {
        isCentralCreditStoreEnabled: () => true,
        ensureAccount: centralStore.ensureAccount,
        isGatewayAdminConfigured: gatewayAdmin.isGatewayAdminConfigured,
        ensureDefaultUserKey: async (id) => {
            const { ensureDefaultUserKey } = await import('./user-keys.js');
            await ensureDefaultUserKey(id);
        },
        onDefaultKeyReady: invalidateRequestManagedAgentCredentialCache,
    });
}
export function resetManagedCredentialCacheRuntimeForTest() {
    credentialRuntimeState.centralSession = null;
    credentialRuntimeState.locallyLoggedOutUsers.clear();
    credentialRuntimeState.credentialGenerations.clear();
    credentialRuntimeState.requestManagedCredentialCache.clear();
    credentialRuntimeState.lazyKeyFetchCooldown.clear();
    warnedScopes.clear();
    persistenceTestHooks = null;
}
