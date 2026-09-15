export const DEFAULT_STUDIO_RUNTIME_CAPABILITIES = {
    profile: 'local-dev',
    webCloud: false,
    auth: {
        loginRequired: true,
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
        localLlmManager: true,
        customMcpServers: true,
    },
    data: {
        cookieOnly: false,
        serverPersistence: true,
        chatAttachments: true,
        supabase: true,
    },
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
export const WEB_CLOUD_SAFE_STUDIO_RUNTIME_CAPABILITIES = {
    ...DEFAULT_STUDIO_RUNTIME_CAPABILITIES,
    profile: 'web-cloud',
    webCloud: true,
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
        localLlmManager: false,
        customMcpServers: false,
    },
    data: {
        cookieOnly: true,
        serverPersistence: false,
        chatAttachments: true,
        supabase: true,
    },
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
/**
 * Chat attachments require a server-owned file plus manifest for subsequent tool calls.
 * Keep every composer entry point on one capability decision so picker/drop/paste cannot
 * drift into different Web Cloud behavior. web-cloud 的隔离/配额由服务端存储层保证
 * （attachment-storage-scope / attachment-storage-quota），此处只看能力判据。
 */
export function resolveChatAttachmentRuntimePolicy(capabilities) {
    const enabled = capabilities.data.chatAttachments;
    return {
        enabled,
        allowFilePicker: enabled,
        allowFileDrop: enabled,
        allowClipboardFiles: enabled,
    };
}
export function tabSupportedByRuntime(tab, capabilities) {
    // Fail closed: only explicitly-listed live tabs are supported; unknown tabs
    // fall through to false so normalizeTabForRuntimeCapabilities redirects them
    // to 'dashboard' instead of silently mounting a retired surface.
    switch (tab) {
        case 'dashboard':
        case 'ai-chat-hub':
            return capabilities.ai.chat;
        case 'flasher':
            return capabilities.desktop.flashing || capabilities.flasher.webLocalBridge;
        case 'terminal':
            return capabilities.device.terminal;
        case 'files':
            return capabilities.device.files;
        case 'vnc':
            return capabilities.device.vnc;
        case 'ide':
            return capabilities.device.codeServer;
        case 'local-models':
            // The page is also the capability-recovery destination: Web users need to see why
            // host management is unavailable and which full-client boundary applies.
            return true;
        case 'dr-embed':
            return capabilities.desktop.embeddedBrowser;
        case 'plugins':
            // Plugin center is available on every deployment profile.
            return true;
        case 'block-programming':
            // Gated by the STUDIO_SHOW_BLOCK_PROGRAMMING product flag (normalizeTabForFeatures),
            // not by runtime capabilities; always runtime-supported when the flag is on.
            return true;
        default:
            return false;
    }
}
export function normalizeTabForRuntimeCapabilities(tab, capabilities) {
    return tabSupportedByRuntime(tab, capabilities) ? tab : 'dashboard';
}
