import { DEFAULT_STUDIO_RUNTIME_CAPABILITIES } from '../shared/studio-runtime-capabilities.js';
import { envFlagEnabled } from './chat-credits-env.js';
export function resolveStudioDeploymentProfile() {
    const explicit = String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE ?? '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
    if (explicit === 'desktop' ||
        explicit === 'local-dev' ||
        explicit === 'web-self-host' ||
        explicit === 'web-cloud') {
        return explicit;
    }
    if (String(process.env.RDK_PACKAGED_DESKTOP ?? '').trim() === '1')
        return 'desktop';
    if (process.env.NODE_ENV === 'production')
        return 'web-self-host';
    return 'local-dev';
}
export function resolveStudioTelemetryClientType(clientSurface) {
    return clientSurface === 'miniapp' ? 'miniapp' : resolveStudioDeploymentProfile();
}
export function isWebCloudDeployment() {
    return resolveStudioDeploymentProfile() === 'web-cloud';
}
export const DEFAULT_STUDIO_BIND_HOST = '127.0.0.1';
/** Single source of truth for the HTTP listener bind host and its safe default. */
export function resolveStudioBindHost() {
    return String(process.env.RDK_STUDIO_BIND_HOST ?? '').trim() || DEFAULT_STUDIO_BIND_HOST;
}
/**
 * Anonymous single-operator fallbacks are safe only while the HTTP listener is
 * unreachable from other hosts. Keep this aligned with server/index.ts's
 * default bind address and fail closed for wildcard/LAN/public addresses.
 */
export function studioServerBindsLoopback() {
    const bindHost = resolveStudioBindHost().toLowerCase();
    return (bindHost === '127.0.0.1' ||
        bindHost === 'localhost' ||
        bindHost === '::1' ||
        bindHost === '::ffff:127.0.0.1');
}
export function deploymentAllowsAnonymousLocalOperator() {
    return !isWebCloudDeployment() && studioServerBindsLoopback();
}
/**
 * 公网部署 fail-closed:生产环境(非打包桌面)必须**显式**声明部署 profile,拒绝静默回退。
 * 历史事故(2026-06):web-cloud 服务器漏配 RDK_STUDIO_DEPLOYMENT_PROFILE →
 * resolveStudioDeploymentProfile() 静默落到 'web-self-host' → 宿主 exec/read 等 Agent 工具未被禁 →
 * 任意登录用户在共享服务器上 RCE + 跨租户读盘。这里在启动期就拒绝"production 无显式 profile",
 * 逼运维显式选 web-cloud(公网多租户)或 web-self-host(自托管),杜绝危险的静默默认值。
 */
export function assertDeploymentProfileExplicit() {
    const explicit = String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE ?? '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
    const isExplicit = explicit === 'desktop' ||
        explicit === 'local-dev' ||
        explicit === 'web-self-host' ||
        explicit === 'web-cloud';
    if (isExplicit)
        return;
    if (String(process.env.RDK_PACKAGED_DESKTOP ?? '').trim() === '1')
        return; // 打包桌面壳 = desktop
    if (process.env.NODE_ENV === 'production') {
        throw new Error('[deployment] NODE_ENV=production 必须显式设置 RDK_STUDIO_DEPLOYMENT_PROFILE=' +
            'web-cloud(公网多租户)或 web-self-host(自托管)。拒绝静默回退到 web-self-host:' +
            '该回退会在可能公网、可能多租户的服务器上保留宿主 exec/read 等 Agent 工具,' +
            '导致登录用户 RCE + 跨租户读盘(见 2026-06 web-cloud profile RCE 事故)。');
    }
}
/**
 * 单运营者自托管「逃生舱」:web-self-host 默认按"多用户共享"对待并剥离宿主 exec/read/write/subagent
 * 等工具(见 isMultiUserWebDeployment + tool-capability-manifest 的 unavailableInWebCloud)。
 * 仅当运营者确认自己是该机**唯一**用户、自担风险时,显式设 RDK_SELF_HOST_TRUSTED_OPERATOR=1 恢复宿主工具。
 * web-cloud 永不信任此开关(多租户公网不存在"可信单运营者")。
 */
export function selfHostTrustsOperatorHostTools() {
    return (resolveStudioDeploymentProfile() === 'web-self-host' &&
        String(process.env.RDK_SELF_HOST_TRUSTED_OPERATOR ?? '').trim() === '1');
}
/** True when this deployment may admit the operator's own host filesystem to Agent tools. */
export function deploymentExposesOperatorHostPaths(deployment) {
    return (deployment === 'desktop' ||
        deployment === 'local-dev' ||
        (deployment === 'web-self-host' && selfHostTrustsOperatorHostTools()));
}
/**
 * 多用户 web 部署:同一进程可能同时服务多个 SSO 用户(web-self-host / web-cloud)。
 * desktop / local-dev 视为单用户。用于"进程级共享态(无 per-user owner)不可跨用户持久/共享"的判定,
 * 如审批的全局自动放行——多用户下必须降级为本会话,避免 A 的全局放行命中 B 的 run。
 */
export function isMultiUserWebDeployment() {
    const profile = resolveStudioDeploymentProfile();
    return profile === 'web-self-host' || profile === 'web-cloud';
}
/**
 * 是否信任 `x-rdk-client: electron/desktop` 这个【可伪造】header 作为「桌面客户端」判据。
 * 只有桌面自带的内嵌 server(desktop)与本机 dev(local-dev,localhost 单用户)才信任它;
 * 公网 web 部署(web-self-host / web-cloud)上任意浏览器都能伪造该 header——绝不能据此提权或免计费。
 */
export function deploymentTrustsDesktopClientHeader() {
    const profile = resolveStudioDeploymentProfile();
    return profile === 'desktop' || profile === 'local-dev';
}
export function getStudioRuntimeCapabilities() {
    const profile = resolveStudioDeploymentProfile();
    const webCloud = profile === 'web-cloud';
    const desktop = profile === 'desktop';
    const fullLocalLlmAllowed = desktop ||
        (!webCloud &&
            (process.env.STUDIO_LOCAL_LLM_WEB_UI === '1' ||
                (process.env.STUDIO_LOCAL_LLM_WEB_UI !== '0' && process.env.NODE_ENV === 'development')));
    return {
        ...DEFAULT_STUDIO_RUNTIME_CAPABILITIES,
        profile,
        webCloud,
        auth: {
            loginRequired: process.env.SSO_REQUIRED !== '0',
        },
        device: {
            ssh: true,
            directSsh: true,
            tunneledSsh: true,
            terminal: true,
            files: true,
            vnc: true,
            codeServer: true,
        },
        ai: {
            chat: true,
            localLlmManager: fullLocalLlmAllowed,
            customMcpServers: !isMultiUserWebDeployment(),
        },
        data: {
            cookieOnly: webCloud,
            serverPersistence: !webCloud,
            // 聊天附件在 web-cloud 也开放（与桌面平价）：登录必须 + 按账号隔离 + 配额/定期清理
            // 由 attachment-storage-scope / attachment-storage-quota 保证；运维可显式关闭。
            chatAttachments: String(process.env.RDK_STUDIO_CHAT_ATTACHMENTS ?? '').trim() !== '0',
            supabase: true,
        },
        desktop: {
            shell: desktop,
            flashing: !webCloud,
            typecNetworking: !webCloud,
            serialTerminal: !webCloud,
            cliInstall: desktop,
            update: desktop,
            pet: desktop,
            embeddedBrowser: desktop,
        },
        flasher: {
            desktopDirectWrite: !webCloud,
            webLocalBridge: webCloud || !desktop,
        },
    };
}
export function applyClientTypeOverride(baseCapabilities, opts) {
    if (opts.isDesktopClient) {
        if (baseCapabilities.webCloud)
            return baseCapabilities;
        return {
            ...baseCapabilities,
            desktop: {
                shell: true,
                flashing: true,
                typecNetworking: true,
                serialTerminal: true,
                cliInstall: true,
                update: true,
                pet: true,
                embeddedBrowser: true,
            },
            flasher: {
                desktopDirectWrite: true,
                webLocalBridge: false,
            },
        };
    }
    return {
        ...baseCapabilities,
        desktop: {
            shell: false,
            flashing: false,
            typecNetworking: false,
            serialTerminal: false,
            cliInstall: false,
            update: false,
            pet: false,
            embeddedBrowser: false,
        },
        flasher: {
            desktopDirectWrite: false,
            webLocalBridge: true,
        },
    };
}
function parsePublicBrowserEntry(rawEntry, requireHttps) {
    const entry = rawEntry.trim();
    if (!entry) {
        throw new Error('RDK_STUDIO_WEB_PUBLIC_ORIGIN is required for web deployments.');
    }
    let url;
    try {
        url = new URL(entry);
    }
    catch {
        throw new Error('RDK_STUDIO_WEB_PUBLIC_ORIGIN must be a valid absolute URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('RDK_STUDIO_WEB_PUBLIC_ORIGIN must use http:// or https://.');
    }
    if (requireHttps && url.protocol !== 'https:') {
        throw new Error('RDK_STUDIO_WEB_PUBLIC_ORIGIN must use https:// in web-cloud profile.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('RDK_STUDIO_WEB_PUBLIC_ORIGIN must not include credentials, query, or hash.');
    }
    return url;
}
/**
 * OAuth callback URLs must come from one operator-controlled origin, never
 * from request Host/X-Forwarded-Host. Requiring it at startup makes an omitted
 * self-host/cloud setting fail closed instead of reopening host-header based
 * redirect construction. Self-host may use HTTP on a private LAN; cloud must
 * use HTTPS.
 */
export function assertWebDeploymentPublicOriginConfig() {
    const profile = resolveStudioDeploymentProfile();
    if (profile !== 'web-self-host' && profile !== 'web-cloud')
        return undefined;
    try {
        return parsePublicBrowserEntry(String(process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN ?? ''), profile === 'web-cloud');
    }
    catch (error) {
        throw new Error(`[${profile}] ${error instanceof Error ? error.message : String(error)}`);
    }
}
function normalizeCorsOrigin(rawOrigin) {
    try {
        return new URL(rawOrigin.trim()).origin;
    }
    catch {
        return rawOrigin.trim().replace(/\/$/, '');
    }
}
export function assertWebCloudDeploymentConfig() {
    // 设备危险动作闸门的全局豁免:任何多用户 web 部署(web-self-host / web-cloud)下,
    // 该开关都会对全站所有登录用户关闭危险命令审查,而非只影响设置它的运营者。
    // web-self-host 同样可能服务多个 SSO 用户,所以该闸口在所有多用户形态启动期 fail closed,
    // 即使叠加 RDK_SELF_HOST_TRUSTED_OPERATOR=1 也不放行(后者只恢复宿主工具,不免除设备危险审查)。
    if (isMultiUserWebDeployment() &&
        String(process.env.RDK_DEVICE_EXEC_DANGER_ALLOW_UNSAFE ?? '').trim() === '1') {
        const profile = resolveStudioDeploymentProfile();
        throw new Error(`[${profile}] RDK_DEVICE_EXEC_DANGER_ALLOW_UNSAFE=1 is not allowed in multi-user web deployments: it defeats the device danger gate for every signed-in user, not just the operator.`);
    }
    if (!isWebCloudDeployment())
        return;
    const fail = (message) => {
        throw new Error(`[web-cloud] ${message}`);
    };
    if (String(process.env.RDK_PACKAGED_DESKTOP ?? '').trim() === '1') {
        fail('RDK_PACKAGED_DESKTOP=1 cannot be used with RDK_STUDIO_DEPLOYMENT_PROFILE=web-cloud.');
    }
    if (process.env.NODE_ENV !== 'production') {
        fail('NODE_ENV=production is required for web-cloud deployments.');
    }
    if (process.env.SSO_REQUIRED === '0') {
        fail('SSO_REQUIRED=0 is not allowed for web-cloud deployments.');
    }
    if (String(process.env.STUDIO_LOCAL_LLM_WEB_UI ?? '').trim() === '1') {
        fail('STUDIO_LOCAL_LLM_WEB_UI=1 is not allowed for web-cloud deployments.');
    }
    // 接受未验签的 portal JWT:web-cloud 下任意结构合法 JWT(任意 sub)即可冒充他人会话。
    if (String(process.env.SSO_TRUST_PORTAL_OPAQUE_TOKEN ?? '').trim() === '1') {
        fail('SSO_TRUST_PORTAL_OPAQUE_TOKEN=1 is not allowed for web-cloud: it accepts unsigned JWTs and allows sub-spoofing impersonation.');
    }
    if (String(process.env.RDK_STUDIO_DISABLE_WEB_UI ?? '').trim() === '1') {
        fail('RDK_STUDIO_DISABLE_WEB_UI=1 disables the web app and cannot be used for web-cloud.');
    }
    if (String(process.env.EXPRESS_TRUST_PROXY ?? '').trim() !== '1') {
        fail('EXPRESS_TRUST_PROXY=1 is required behind the HTTPS reverse proxy.');
    }
    const cookieSecret = String(process.env.RDK_STUDIO_COOKIE_SECRET ?? '').trim();
    if (cookieSecret.length < 32) {
        fail('RDK_STUDIO_COOKIE_SECRET must be set to at least 32 characters for cookie-only web-cloud state.');
    }
    // 活动中心(积分/邀请)身份：匿名 fallback 一开，activityIdentity 就会信任 client 传的 userId，
    // 任意调用方可冒充他人领奖/刷分。多用户云端必须强制 SSO 身份。
    if (!envFlagEnabled('RDK_CHAT_CREDITS_ACCOUNT_REQUIRED', true) ||
        envFlagEnabled('RDK_CHAT_CREDITS_ALLOW_ANONYMOUS', false)) {
        fail('RDK_CHAT_CREDITS_ALLOW_ANONYMOUS=1 / RDK_CHAT_CREDITS_ACCOUNT_REQUIRED=0 are not allowed in web-cloud: ' +
            'activity endpoints would trust client-supplied userId and let any caller impersonate another user.');
    }
    // The browser entry can sit behind a reverse-proxy path such as /rdkstudio.
    // Keep that path for SSO redirects, but compare CORS by scheme/host/port only.
    const publicBrowserEntry = assertWebDeploymentPublicOriginConfig();
    const corsRaw = String(process.env.RDK_STUDIO_CORS_ORIGINS ?? '').trim();
    if (!corsRaw) {
        fail('RDK_STUDIO_CORS_ORIGINS must be set to the public web origin in web-cloud profile.');
    }
    else if (corsRaw === '*') {
        fail('RDK_STUDIO_CORS_ORIGINS=* is not allowed for web-cloud deployments.');
    }
    else if (publicBrowserEntry) {
        const corsOrigins = corsRaw.split(',').map(normalizeCorsOrigin);
        if (!corsOrigins.includes(publicBrowserEntry.origin)) {
            fail('RDK_STUDIO_CORS_ORIGINS must include the origin of RDK_STUDIO_WEB_PUBLIC_ORIGIN.');
        }
    }
}
