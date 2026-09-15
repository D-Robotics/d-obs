import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function getDefaultStudioConfigDir() {
    return path.join(os.homedir(), '.rdkstudio');
}
function getSettingsPath() {
    return path.join(getDefaultStudioConfigDir(), 'storage-location-settings.json');
}
function normalizeAbsoluteDir(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed || !path.isAbsolute(trimmed))
        return undefined;
    return path.resolve(trimmed);
}
function normalizeSettings(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const source = raw;
    const next = {};
    const configDir = normalizeAbsoluteDir(source.configDir);
    const dataDir = normalizeAbsoluteDir(source.dataDir);
    if (configDir)
        next.configDir = configDir;
    if (dataDir)
        next.dataDir = dataDir;
    return next;
}
export function readStorageLocationSettingsSync() {
    try {
        return normalizeSettings(JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')));
    }
    catch {
        return {};
    }
}
async function writeStorageLocationSettings(next) {
    const settingsPath = getSettingsPath();
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const tempPath = `${settingsPath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
    await fsp.rename(tempPath, settingsPath);
}
export function resolveStudioConfigDir() {
    const envDir = normalizeAbsoluteDir(process.env.RDK_STUDIO_HOME);
    if (envDir)
        return envDir;
    const settings = readStorageLocationSettingsSync();
    return settings.configDir || getDefaultStudioConfigDir();
}
export function resolveConfiguredDataDir(defaultDataDir) {
    const envDir = normalizeAbsoluteDir(process.env.RDK_DATA_DIR);
    if (envDir)
        return envDir;
    const settings = readStorageLocationSettingsSync();
    return settings.dataDir || defaultDataDir;
}
export function isStudioConfigDirOverridden() {
    return Boolean(normalizeAbsoluteDir(process.env.RDK_STUDIO_HOME) ||
        readStorageLocationSettingsSync().configDir);
}
export function isDataDirOverriddenByStorageSetting() {
    return Boolean(readStorageLocationSettingsSync().dataDir);
}
export async function setConfigurableStorageLocation(owner, dir) {
    const resolved = normalizeAbsoluteDir(dir);
    if (!resolved) {
        throw Object.assign(new Error('Storage path must be an absolute directory path.'), {
            statusCode: 400,
        });
    }
    await fsp.mkdir(resolved, { recursive: true });
    const current = readStorageLocationSettingsSync();
    if (owner === 'studio-config') {
        await writeStorageLocationSettings({ ...current, configDir: resolved });
        process.env.RDK_STUDIO_HOME = resolved;
        return;
    }
    await writeStorageLocationSettings({ ...current, dataDir: resolved });
    process.env.RDK_DATA_DIR = resolved;
}
