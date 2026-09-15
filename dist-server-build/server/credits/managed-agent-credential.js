/**
 * Studio 受管 Agent credential 编排：为每个已认证 owner 解析独立网关凭据并计入其额度。
 * 该用户每日额度。key 本身是自验证凭证(中心库里有=真),用它时无需任何 SSO 校验。
 *
 * 桌面 embedded 没有本地中心库时,直登请求会先转发给中心账户服务。中心只校验一次密码、短信/邮箱
 * 验证码或微信授权,并返回自己的会话。桌面随后以 `/api/sso/me` 验明该会话的用户身份后才导入本地;
 * 这样一次性验证码不会被本地和中心重复消费,也不会把未经验证的 IdP token 当作中心身份。
 *
 * web-cloud / 中心部署直接按已验证的 SSO user id 建账和发 key,不依赖登录方式。中心不可达时不创建
 * 桌面会话,从而避免本地登录成功却无法进入需要中心身份的额度和 API Key 页面。
 *
 * 安全前提:RDK_CREDITS_CENTRAL_URL 在生产必须是 HTTPS。密码和一次性验证码绝不向远端明文 HTTP 发送。
 */
import { isWebCloudDeployment } from '../studio-deployment.js';
import { resolveServerAccountCloudOrigin } from '../account-cloud-origin.js';
import { timestampAfterUserRevocation } from '../credential-revocation-tombstones.js';
import { beginVerifiedCredentialSession, credentialOperationIsCurrent, credentialRevocationStateAvailable, credentialRuntimeState, isManagedCredentialCacheUnavailable, getCachedManagedAgentCredential, getCentralCreditsSession, getDesktopHostCachedKey, invalidateRequestManagedAgentCredentialCache, isCredentialRevocationStoreUnavailable, loadCredentialCache, provisionFromLocalCentralStore, readCredentialEntryForUser, resetManagedCredentialCacheRuntimeForTest, saveCredentialCache, warnRevocationStoreUnavailable, warnCredentialCacheUnavailable, warnOnce, } from './managed-agent-credential-cache.js';
export { clearManagedAgentCredentialForCentralSession, clearManagedAgentCredentialForUser, getCachedManagedAgentCredential, getCentralCreditsSession, getDesktopHostCachedKey, currentCredentialGeneration, invalidateCentralSession, invalidateRequestManagedAgentCredentialCache, listManagedAgentCredentialUsers, provisionLocalCentralCreditsOnLogin, setManagedKeyPersistenceTestHooksForTest, } from './managed-agent-credential-cache.js';
const SESSION_HEADER = 'x-rdk-sso-session';
function centralUrl() {
    return resolveServerAccountCloudOrigin();
}
/**
 * 是否可向该中心地址发送登录凭据。远端只允许 HTTPS,回环地址允许 HTTP 便于本机测试。
 */
let _blockedWarned = false;
function centralTransportOkForCredentials(base) {
    if (/^https:\/\//i.test(base))
        return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base))
        return true;
    if (!_blockedWarned) {
        _blockedWarned = true;
        console.warn(`[credits] 安全默认已拦截:RDK_CREDITS_CENTRAL_URL=${base} 是远端明文 http,` +
            `不会发送登录凭据。请给中心配置 HTTPS。`);
    }
    return false;
}
// Keep the facade's references pointed at the single cache-module state object.
const _locallyLoggedOutUsers = credentialRuntimeState.locallyLoggedOutUsers;
const _credentialGenerations = credentialRuntimeState.credentialGenerations;
const requestManagedCredentialCache = credentialRuntimeState.requestManagedCredentialCache;
const _lazyKeyFetchCooldown = credentialRuntimeState.lazyKeyFetchCooldown;
const REQUEST_MANAGED_CREDENTIAL_TTL_MS = 60_000;
/**
 * Login hooks are intentionally best-effort and run after the SSO response has
 * been committed.  A first prompt can therefore arrive while the owner key is
 * still being provisioned (local Postgres/gateway or the remote desktop
 * bootstrap path).  Keep that race bounded: callers wait for the current
 * owner flight, then re-read the credential cache.  Managed credentials never
 * fall back to a shared environment key here.
 */
const MANAGED_CREDENTIAL_PROVISION_WAIT_MS = 15_000;
const managedCredentialProvisionFlights = new Map();
function waitForPromiseBounded(promise, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        // Swallow the provisioning outcome here; the resolver must continue with
        // its normal owner-scoped lookup even when provisioning failed.
        promise.then(finish, finish);
    });
}
/**
 * Wait for the in-flight provisioning belonging to the request's generation.
 * If a generation changed because a new login started while this request was
 * importing dependencies, adopt that newer flight.  Any other generation
 * change (logout/revocation) remains fail-closed.
 */
async function waitForManagedCredentialProvision(ssoUserId, expectedGeneration) {
    let generation = expectedGeneration;
    let flight = managedCredentialProvisionFlights.get(ssoUserId);
    if (flight && flight.generation !== generation) {
        if (!credentialOperationIsCurrent(ssoUserId, generation) &&
            credentialOperationIsCurrent(ssoUserId, flight.generation)) {
            generation = flight.generation;
        }
        else {
            flight = undefined;
        }
    }
    if (flight) {
        await waitForPromiseBounded(flight.promise, MANAGED_CREDENTIAL_PROVISION_WAIT_MS);
    }
    return credentialOperationIsCurrent(ssoUserId, generation) ? generation : null;
}
/** 用中心会话 id 向中心取该用户默认 key(GET,只带 ccSid,不带凭据)。best-effort,拿不到 → null。 */
async function fetchDefaultKeyFromCentral(base, sid, timeoutMs = 15_000, fetchImpl = fetch) {
    const keyRes = await fetchImpl(`${base}/api/credits/default-key`, {
        headers: { [SESSION_HEADER]: sid },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const keyJson = (await keyRes.json().catch(() => null));
    return keyJson?.ok && typeof keyJson.key === 'string' && keyJson.key.trim()
        ? keyJson.key.trim()
        : null;
}
function normalizeCentralUser(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const value = raw;
    const id = String(value.id ?? '').trim();
    if (!id)
        return null;
    const avatar = typeof value.avatar === 'string' && value.avatar.trim() ? value.avatar.trim() : undefined;
    return {
        id,
        name: String(value.name ?? '').trim(),
        email: String(value.email ?? '').trim(),
        ...(avatar ? { avatar } : {}),
    };
}
function normalizeCentralPayload(raw) {
    return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
}
async function fetchCentralSessionUser(base, sid, fetchImpl) {
    const response = await fetchImpl(`${base}/api/sso/me`, {
        headers: { [SESSION_HEADER]: sid },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
        return null;
    const payload = normalizeCentralPayload(await response.json().catch(() => null));
    return normalizeCentralUser(payload.user);
}
async function rememberVerifiedCentralSession(base, userId, sid, fetchImpl, expectedGeneration) {
    const id = String(userId ?? '').trim();
    const sessionId = String(sid ?? '').trim();
    if (!id || !sessionId)
        return;
    const generation = expectedGeneration ?? beginVerifiedCredentialSession(id);
    if (!credentialOperationIsCurrent(id, generation))
        return;
    let updatedAt;
    try {
        // Complete the revocation check before publishing either the in-memory
        // session or a disk snapshot.  If the tombstone store is unreadable, a
        // verified login must wait rather than becoming a stale-key bypass.
        updatedAt = timestampAfterUserRevocation(id);
        const cache = loadCredentialCache();
        const prior = readCredentialEntryForUser(id);
        if (!credentialOperationIsCurrent(id, generation))
            return;
        credentialRuntimeState.centralSession = { ssoUserId: id, sid: sessionId, at: Date.now() };
        cache[id] = {
            ...(prior?.key ? { key: prior.key } : {}),
            sid: sessionId,
            updatedAt,
        };
        saveCredentialCache(cache);
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
        return;
    }
    try {
        const key = await fetchDefaultKeyFromCentral(base, sessionId, 15_000, fetchImpl);
        if (!key || !credentialOperationIsCurrent(id, generation))
            return;
        const next = loadCredentialCache();
        next[id] = { key, sid: sessionId, updatedAt };
        saveCredentialCache(next);
        invalidateRequestManagedAgentCredentialCache(id);
    }
    catch {
        /* The verified central session remains cached and can heal the key later. */
    }
}
export async function rememberVerifiedCentralSessionForUser(base, userId, sid, fetchImpl = fetch, expectedGeneration) {
    await rememberVerifiedCentralSession(base, userId, sid, fetchImpl, expectedGeneration);
}
/**
 * Relay direct authentication to the central account service exactly once. This is intentionally
 * before any local IdP request: SMS and email codes are single-use, so a second verification would
 * always fail. The returned central session is checked through `/api/sso/me` and bound to that user.
 */
export async function relayDirectSsoRequestToCentral(route, body, fetchImpl = fetch) {
    const base = centralUrl();
    if (!base || isWebCloudDeployment())
        return null;
    if (!centralTransportOkForCredentials(base)) {
        return {
            status: 503,
            payload: { ok: false, error: 'The account center must use HTTPS for desktop sign-in.' },
        };
    }
    try {
        const { isCentralCreditStoreEnabled } = await import('./central-credit-store.js');
        if (isCentralCreditStoreEnabled())
            return null;
    }
    catch {
        return {
            status: 502,
            payload: { ok: false, error: 'The account center is unavailable. Please try again shortly.' },
        };
    }
    let response;
    try {
        response = await fetchImpl(`${base}${route}`, {
            method: route === '/api/sso/direct/wechat/start' ? 'GET' : 'POST',
            headers: route === '/api/sso/direct/wechat/start'
                ? undefined
                : { 'content-type': 'application/json' },
            ...(route === '/api/sso/direct/wechat/start' ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(30_000),
        });
    }
    catch {
        return {
            status: 502,
            payload: { ok: false, error: 'The account center could not be reached. Please try again.' },
        };
    }
    const payload = normalizeCentralPayload(await response.json().catch(() => null));
    if (!response.ok || payload.ok !== true) {
        return { status: response.status, payload };
    }
    if (route !== '/api/sso/direct/login' &&
        route !== '/api/sso/direct/register' &&
        route !== '/api/sso/direct/wechat') {
        return { status: response.status, payload };
    }
    const sid = String(payload.sessionId ?? '').trim();
    if (!/^[a-f0-9]{64}$/i.test(sid)) {
        // Registration can legitimately complete without an automatic sign-in.
        return { status: response.status, payload };
    }
    let verifiedUser = null;
    try {
        verifiedUser = await fetchCentralSessionUser(base, sid, fetchImpl);
    }
    catch {
        verifiedUser = null;
    }
    const returnedUser = normalizeCentralUser(payload.user);
    if (!verifiedUser || (returnedUser && returnedUser.id !== verifiedUser.id)) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: 'The account center did not confirm this sign-in. Please sign in again.',
            },
        };
    }
    await rememberVerifiedCentralSession(base, verifiedUser.id, sid, fetchImpl);
    return {
        status: response.status,
        payload,
        centralSession: { user: verifiedUser, sessionId: sid, centralUrl: base },
    };
}
/**
 * 桌面 embedded 自愈:缓存缺 key(导入中心会话后取 key 超时/失败、或重启后)但有中心会话 →
 * 按需向中心补取一次默认 key 并落盘,让下条消息立即可用,**无需用户重新登录**(这正是"key 加载偶发失败、
 * 重登才好"的根因:此前桌面 key 只在登录一刻写入、之后只读缓存永不重取)。
 * 冷却:中心持续不可达时,避免每条消息都 6s 阻塞——同一用户失败后 30s 内不再重试(命中缓存 key 时本函数根本不触发)。
 */
const LAZY_KEY_FETCH_COOLDOWN_MS = 30_000;
async function lazyProvisionDesktopKey(ssoUserId, expectedGeneration) {
    const generation = expectedGeneration ?? _credentialGenerations.get(ssoUserId) ?? 0;
    if (!credentialOperationIsCurrent(ssoUserId, generation))
        return null;
    const base = centralUrl();
    if (!base)
        return null;
    const sid = getCentralCreditsSession(ssoUserId); // 内存/磁盘中心会话(登录时建立);无 → 无法补取
    if (!sid)
        return null;
    const last = _lazyKeyFetchCooldown.get(ssoUserId);
    if (last && Date.now() - last < LAZY_KEY_FETCH_COOLDOWN_MS)
        return null;
    _lazyKeyFetchCooldown.set(ssoUserId, Date.now());
    try {
        const key = await fetchDefaultKeyFromCentral(base, sid, 6_000); // 热路径:短超时,拿不到就落回 no_api_key(同现状)
        if (!key)
            return null;
        if (!credentialOperationIsCurrent(ssoUserId, generation))
            return null;
        const cache = loadCredentialCache();
        cache[ssoUserId] = {
            key,
            sid: cache[ssoUserId]?.sid ?? sid,
            updatedAt: cache[ssoUserId]?.updatedAt ?? timestampAfterUserRevocation(ssoUserId),
        };
        saveCredentialCache(cache);
        _lazyKeyFetchCooldown.delete(ssoUserId); // 成功后清冷却
        return key;
    }
    catch {
        return null;
    }
}
export async function resolveRequestManagedAgentCredential(ssoUserId) {
    const id = String(ssoUserId ?? '').trim();
    if (!id || _locallyLoggedOutUsers.has(id))
        return null;
    // Both the desktop snapshot and the central DB path are credential sources.
    // Do not publish either one while the durable revocation set is unknown.
    if (!credentialRevocationStateAvailable())
        return null;
    const generation = _credentialGenerations.get(id) ?? 0;
    const cached = requestManagedCredentialCache.get(id);
    if (cached && Date.now() - cached.at < REQUEST_MANAGED_CREDENTIAL_TTL_MS)
        return cached.key;
    // The post-login hook is deliberately non-blocking.  If this is the first
    // request after login, wait for that owner's provisioning flight and then
    // re-read the durable cache before touching any other provider state.
    const flightAtStart = managedCredentialProvisionFlights.get(id);
    let provisioningObserved = Boolean(flightAtStart && credentialOperationIsCurrent(id, flightAtStart.generation));
    const readyGeneration = await waitForManagedCredentialProvision(id, generation);
    if (readyGeneration === null)
        return null;
    let effectiveGeneration = readyGeneration;
    // 动态 import:把懒加载 pg 的 central-credit-store / user-keys 挡在 CLI 静态依赖图外(build:cli 无 pg 类型)。
    const { getDefaultUserKey, isCentralCreditStoreEnabled } = await import('./central-credit-store.js');
    const centralStoreEnabled = isCentralCreditStoreEnabled();
    if (!credentialOperationIsCurrent(id, effectiveGeneration)) {
        // A login hook may have started while the lazy central-store module was
        // loading.  Adopt only a newer, still-current provisioning flight; a
        // logout/revocation with no live flight stays fail-closed.
        const resumedGeneration = await waitForManagedCredentialProvision(id, effectiveGeneration);
        if (resumedGeneration === null)
            return null;
        effectiveGeneration = resumedGeneration;
        provisioningObserved = true;
    }
    // The disk snapshot is a desktop-only recovery source.  Never hydrate the
    // request cache from it in web-cloud, where cross-tenant local state must be
    // ignored even if a previous desktop session left a file behind.  When a
    // central store is configured, query that authority first so a rotated key
    // cannot be shadowed by an older desktop snapshot.
    if (provisioningObserved && !isWebCloudDeployment() && !centralStoreEnabled) {
        const provisioned = getCachedManagedAgentCredential(id);
        if (provisioned) {
            return provisioned;
        }
    }
    if (centralStoreEnabled) {
        try {
            const existing = await getDefaultUserKey(id);
            if (!credentialOperationIsCurrent(id, effectiveGeneration))
                return null;
            const existingKey = existing?.gatewayKey?.trim();
            if (existingKey) {
                requestManagedCredentialCache.set(id, { key: existingKey, at: Date.now() });
                return existingKey;
            }
            const { isGatewayAdminConfigured } = await import('./gateway-admin-client.js');
            if (!credentialOperationIsCurrent(id, effectiveGeneration))
                return null;
            if (isGatewayAdminConfigured()) {
                const { ensureDefaultUserKey } = await import('./user-keys.js');
                if (!credentialOperationIsCurrent(id, effectiveGeneration))
                    return null;
                const rec = await ensureDefaultUserKey(id); // 缺失才发;热路径多数命中只读
                if (!credentialOperationIsCurrent(id, effectiveGeneration))
                    return null;
                const issuedKey = rec.gatewayKey?.trim();
                if (issuedKey) {
                    requestManagedCredentialCache.set(id, { key: issuedKey, at: Date.now() });
                    return issuedKey;
                }
                return null;
            }
            if (isWebCloudDeployment())
                return null;
            warnOnce('gateway-admin-missing-desktop-fallback', '[credits] GATEWAY_ADMIN_KEY 未配置，已转用桌面缓存 key 退化；新的 per-user key 将无法发放:', id);
            return resolveDesktopFallbackManagedAgentCredential(id, effectiveGeneration);
        }
        catch {
            // 中心库「配了但连不上」(如本地 SSH 隧道断):桌面回退登录缓存 key 自愈,与计费闸门
            // fail-open 语义对齐(连不上中心放行、网关仍按 key 计量),避免「隧道瞬断全站瘫」;
            // web-cloud 多租户严禁跨租户回退(其缓存本就为空),保持明确缺 key 态。
            if (isWebCloudDeployment())
                return null;
            if (!credentialOperationIsCurrent(id, effectiveGeneration))
                return null;
            warnOnce('central-db-unreachable-desktop-fallback', '[credits] 中心库不可达,桌面回退登录缓存 key:', id);
            return resolveDesktopFallbackManagedAgentCredential(id, effectiveGeneration);
        }
    }
    return resolveDesktopFallbackManagedAgentCredential(id, effectiveGeneration);
}
/**
 * 桌面 embedded 兜底解析:先按 id 取登录 relay 缓存;缓存缺 key 但有中心会话 → 按需向中心补取自愈;
 * 合成渠道/系统 id(im:* / system:*)无独立缓存 → 回退本机登录用户的缓存 key(单机单登录账户为
 * 飞书/微信/autonomy 计费;审查 H2:否则桌面这些渠道每条消息都 no_api_key)。
 * 正常桌面路径与「中心库配了但连不上」的受控兜底共用本函数。
 */
async function resolveDesktopFallbackManagedAgentCredential(id, generation) {
    // A local snapshot is never an authority in web-cloud.  Keep this guard in
    // the helper itself as well as the resolver branches so a misconfigured
    // cloud instance (for example, central DB temporarily unset) cannot leak a
    // previous desktop owner's credential.
    if (isWebCloudDeployment())
        return null;
    if (!credentialOperationIsCurrent(id, generation))
        return null;
    const direct = getCachedManagedAgentCredential(id);
    if (direct)
        return direct;
    // 缓存缺 key(登录取 key 失败/重启)但有中心会话 → 按需补取一次自愈,免用户重新登录。
    // im:* / system:* 无独立 ccSid(getCentralCreditsSession 返回 null)→ 本步 no-op,自然落到下方主机 key 回退。
    const healed = await lazyProvisionDesktopKey(id, generation);
    if (!credentialOperationIsCurrent(id, generation))
        return null;
    if (healed) {
        requestManagedCredentialCache.set(id, { key: healed, at: Date.now() });
        return healed;
    }
    if (/^(im|system):/.test(id))
        return getDesktopHostCachedKey();
    return null;
}
/**
 * 登录后确保该用户进入中心计费体系。web-cloud / 中心部署直接按已验证 user id 建账和发默认 key;
 * 桌面 embedded 无本地库时:尝试用已验证的 access token 向中心 bootstrap 建会话(中心 web-cloud
 * 部署会向 IdP 校验该 token),使后续 /api/credits/* 代理和计费可用。
 */
async function provisionManagedAgentCredentialFromSsoTokenOnce(id, accessToken, generation) {
    // 本进程刚完成 IdP 校验,中心部署可直接信任该 user id。
    try {
        if (await provisionFromLocalCentralStore(id))
            return;
        if (!credentialOperationIsCurrent(id, generation))
            return;
    }
    catch {
        warnOnce('post-login-central-provision-failed', '[credits] 登录后中心建账失败;登录保持成功,请检查中心库和网关配置。');
    }
    // 桌面 embedded 无本地中心库:用已验证的 access token 向中心 bootstrap 建会话。
    const base = centralUrl();
    if (!base || !accessToken || isWebCloudDeployment())
        return;
    if (!centralTransportOkForCredentials(base))
        return;
    try {
        const existing = getCentralCreditsSession(id);
        if (existing)
            return;
        const loginRes = await fetch(`${base}/api/sso/bootstrap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken }),
            signal: AbortSignal.timeout(15_000),
        });
        const loginJson = (await loginRes.json().catch(() => null));
        const sid = loginJson?.ok && typeof loginJson.sessionId === 'string' ? loginJson.sessionId.trim() : '';
        if (!sid)
            return;
        if (!credentialOperationIsCurrent(id, generation))
            return;
        await rememberVerifiedCentralSession(base, id, sid, fetch, generation);
    }
    catch {
        /* best-effort:中心不可达则无中心会话,计费届时走 fail-open */
    }
}
/**
 * Provision one owner at a time.  SSO restore/direct-login can emit duplicate
 * post-login hooks for the same account; sharing the promise prevents those
 * callbacks from racing the generation fence or issuing duplicate key work.
 */
export function provisionManagedAgentCredentialFromSsoToken(ssoUserId, accessToken) {
    const id = String(ssoUserId ?? '').trim();
    if (!id)
        return Promise.resolve();
    const existing = managedCredentialProvisionFlights.get(id);
    if (existing) {
        // A logout/new login advances the generation.  Do not attach a new token
        // to an obsolete flight; its generation fence will prevent publication.
        if (credentialOperationIsCurrent(id, existing.generation))
            return existing.promise;
        managedCredentialProvisionFlights.delete(id);
    }
    const generation = beginVerifiedCredentialSession(id);
    const promise = provisionManagedAgentCredentialFromSsoTokenOnce(id, accessToken, generation);
    const flight = { generation, promise };
    managedCredentialProvisionFlights.set(id, flight);
    void promise.then(() => {
        if (managedCredentialProvisionFlights.get(id) === flight) {
            managedCredentialProvisionFlights.delete(id);
        }
    }, () => {
        if (managedCredentialProvisionFlights.get(id) === flight) {
            managedCredentialProvisionFlights.delete(id);
        }
    });
    return promise;
}
/** Reset in-memory credential state between isolated tests/process simulations. */
export function resetManagedAgentCredentialRuntimeForTest() {
    resetManagedCredentialCacheRuntimeForTest();
    managedCredentialProvisionFlights.clear();
}
