/**
 * Agent 网关 admin 客户端 —— 给每个 SSO 用户在网关 provision 专属 key + 配额,实现「集中、不可绕」的
 * per-user enforcement(网关是所有客户端唯一必经点)。
 *
 * 网关 admin API(/admin/users,Bearer GATEWAY_ADMIN_KEY):
 *   POST {action:'create', userId, data:{label?, limits?:{rpm,tpm,daily}}} → 201 {userId, key}(生成 key)
 *   POST {action:'update', userId, data:{label?,enabled?,limits?}}         → 200 {ok}
 *   POST {action:'rotate', userId}                                          → 200 {userId, newKey}
 *   POST {action:'delete', userId}                                         → 200 {ok}
 *   GET  /admin/users → {users:[{userId,label,enabled,limits,keyPreview}]}
 * 注意:GET 只返回 keyPreview(截断),取不回完整 key → 首次 create 拿到的 key 必须由调用方持久化
 *      (存 credit_account.gateway_user_key);后续登录从那里取,不重复 create(create 会重置 key)。
 * limits.daily = 网关「每日请求数」(非对话数;per-conversation 需后续网关计数改造)。
 *
 * 仅共享服务器侧使用(网关在同机 127.0.0.1:3100)。工具本身不动线上;用它批量发 key 属 Stage 3 门控。
 */
function gatewayBaseUrl() {
    return String(process.env.RDK_GATEWAY_ADMIN_URL ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
}
const DEFAULT_GATEWAY_ADMIN_TIMEOUT_MS = 8_000;
const MAX_GATEWAY_ADMIN_TIMEOUT_MS = 30_000;
// `/admin/users` and `/admin/config` grow with the number of provisioned
// accounts.  Keep a bounded body guard, but do not make the first few thousand
// users fail once the JSON crosses the old 512 KiB limit.  Operators can lower
// this for a constrained deployment; values are still clamped to a safe range.
const DEFAULT_GATEWAY_ADMIN_RESPONSE_BYTES = 8 * 1024 * 1024;
const MIN_GATEWAY_ADMIN_RESPONSE_BYTES = 512 * 1024;
const MAX_GATEWAY_ADMIN_RESPONSE_BYTES = 32 * 1024 * 1024;
function gatewayAdminResponseBytes() {
    const configured = Number(process.env.RDK_GATEWAY_ADMIN_MAX_RESPONSE_BYTES ?? DEFAULT_GATEWAY_ADMIN_RESPONSE_BYTES);
    if (!Number.isFinite(configured))
        return DEFAULT_GATEWAY_ADMIN_RESPONSE_BYTES;
    return Math.max(MIN_GATEWAY_ADMIN_RESPONSE_BYTES, Math.min(MAX_GATEWAY_ADMIN_RESPONSE_BYTES, Math.round(configured)));
}
function gatewayAdminTimeoutMs() {
    const configured = Number(process.env.RDK_GATEWAY_ADMIN_TIMEOUT_MS ?? DEFAULT_GATEWAY_ADMIN_TIMEOUT_MS);
    if (!Number.isFinite(configured))
        return DEFAULT_GATEWAY_ADMIN_TIMEOUT_MS;
    return Math.max(1_000, Math.min(MAX_GATEWAY_ADMIN_TIMEOUT_MS, Math.round(configured)));
}
function isLoopbackHostname(hostname) {
    const host = hostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
    return (host === 'localhost' ||
        host === '::1' ||
        host === '0:0:0:0:0:0:0:1' ||
        /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host));
}
/** Admin API may use plain HTTP only on loopback or with an explicit local-test opt-in. */
function resolveGatewayAdminUrl() {
    const base = gatewayBaseUrl();
    let url;
    try {
        url = new URL(base);
    }
    catch {
        throw new Error('网关 admin URL 无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('网关 admin URL 必须使用 http 或 https');
    }
    if (url.protocol === 'http:' &&
        !isLoopbackHostname(url.hostname) &&
        String(process.env.RDK_GATEWAY_ADMIN_ALLOW_INSECURE ?? '').trim() !== '1') {
        throw new Error('网关 admin 远程连接必须使用 HTTPS');
    }
    return url.toString().replace(/\/$/, '');
}
function gatewayAdminKey() {
    return String(process.env.GATEWAY_ADMIN_KEY ?? '').trim();
}
/** 网关 admin 是否可用(需配置 admin key)。 */
export function isGatewayAdminConfigured() {
    return gatewayAdminKey().length > 0;
}
async function readResponseTextBounded(response, maxBytes) {
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error('响应过大');
    }
    if (!response.body)
        return response.text();
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            const chunk = next.value;
            total += chunk.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('响应过大');
            }
            chunks.push(chunk);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}
async function adminFetch(path, init) {
    const key = gatewayAdminKey();
    if (!key)
        throw new Error('GATEWAY_ADMIN_KEY 未配置:网关 admin 客户端不可用');
    const url = resolveGatewayAdminUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), gatewayAdminTimeoutMs());
    let res;
    try {
        res = await fetch(`${url}${path}`, {
            method: init.method,
            headers: {
                authorization: `Bearer ${key}`,
                ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
            },
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            signal: controller.signal,
        });
        // Keep the same deadline while reading the body. `fetch()` resolving only
        // means headers arrived; a stalled/chunked body must not pin a login or
        // key-management request forever.
        const text = await readResponseTextBounded(res, gatewayAdminResponseBytes()).catch((error) => {
            if (error instanceof Error && error.message === '响应过大') {
                throw new Error(`网关 admin ${init.method} ${path} 响应过大`);
            }
            throw error;
        });
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            json = { raw: text };
        }
        if (!res.ok) {
            const raw = json && typeof json === 'object' && 'error' in json
                ? String(json.error)
                : '';
            const msg = raw.replace(/bearer\s+\S+/gi, 'bearer [redacted]').slice(0, 240) || `HTTP ${res.status}`;
            throw new Error(`网关 admin ${init.method} ${path} 失败: ${msg}`);
        }
        return json;
    }
    catch (error) {
        if (error instanceof Error &&
            (/^网关 admin .*响应过大$/.test(error.message) || /失败:/.test(error.message))) {
            throw error;
        }
        const reason = controller.signal.aborted ? '超时' : '网络错误';
        throw new Error(`网关 admin ${init.method} ${path} ${reason}`, { cause: error });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 创建用户 key(首次)。返回生成的完整 key —— **调用方必须持久化**(GET 取不回)。
 * 若该 userId 已存在,网关 create 会**重置 key**;故仅在确认用户没有已存 key 时调用。
 */
export async function createUserKey(userId, opts = {}) {
    const json = (await adminFetch('/admin/users', {
        method: 'POST',
        idempotencyKey: opts.idempotencyKey,
        body: {
            action: 'create',
            userId,
            data: {
                label: opts.label ?? userId,
                // owner=该 key 归属的 sso_user_id。多 key 时网关按 owner 计量(同一用户多把 key 共用一份额度)。
                // 网关侧需支持(cutover);未支持时网关忽略此字段,不影响建 key。
                ...(opts.owner ? { owner: opts.owner } : {}),
                ...(opts.limits ? { limits: opts.limits } : {}),
            },
        },
    }));
    if (!json?.key)
        throw new Error('网关 create 未返回 key');
    return { userId: json.userId ?? userId, key: json.key };
}
/** 更新用户的 limits / enabled / label(不重置 key)。 */
export async function updateUser(userId, data) {
    await adminFetch('/admin/users', { method: 'POST', body: { action: 'update', userId, data } });
}
/** 设置某用户每日(请求)上限(便捷封装)。 */
export async function setUserDailyLimit(userId, daily) {
    await updateUser(userId, { limits: { daily: Math.max(0, Math.round(daily)) } });
}
/** 轮换 key(返回新 key,调用方需更新持久化)。 */
export async function rotateUserKey(userId) {
    const json = (await adminFetch('/admin/users', {
        method: 'POST',
        body: { action: 'rotate', userId },
    }));
    if (!json?.newKey)
        throw new Error('网关 rotate 未返回 newKey');
    return { userId: json.userId ?? userId, newKey: json.newKey };
}
export async function deleteUser(userId) {
    await adminFetch('/admin/users', { method: 'POST', body: { action: 'delete', userId } });
}
export async function listUsers() {
    const json = (await adminFetch('/admin/users', { method: 'GET' }));
    return json?.users ?? [];
}
/** 某 userId 是否已在网关有 key(用 GET 列表判断,避免误 create 重置 key)。 */
export async function userExists(userId) {
    const users = await listUsers();
    return users.some((u) => u.userId === userId);
}
export async function getGatewayProviderHealth(model) {
    const suffix = model ? `?model=${encodeURIComponent(model)}` : '';
    return (await adminFetch(`/admin/provider-health${suffix}`, { method: 'GET' }));
}
export async function getGatewayConfigSummary() {
    return (await adminFetch('/admin/config', { method: 'GET' }));
}
export async function probeGatewayProvider(model) {
    return adminFetch(`/admin/provider-probe?model=${encodeURIComponent(model)}`, { method: 'POST' });
}
export async function updateGatewayModelRouting(frontendModel, data) {
    return adminFetch('/admin/model/routing', {
        method: 'POST',
        body: { frontendModel, ...data },
    });
}
export async function replaceGatewayModel(frontendModel, target) {
    return adminFetch('/admin/model/redirect', {
        method: 'POST',
        body: { frontendModel, target },
    });
}
