/**
 * Device persistence layer with TTL-based read cache.
 *
 * devices.json is the single source of truth for registered boards.
 * A 3-second TTL cache avoids redundant disk I/O when multiple Socket.IO
 * events or API routes call readDevices() within the same request burst.
 * The cache is invalidated on every write to ensure consistency.
 *
 * 写入安全：
 * - 原子写入：先写临时文件再 rename，避免写入中途崩溃导致 JSON 损坏。
 * - 串行写入：通过 Promise 链保证并发 writeDevices 调用按序执行，
 *   避免两个请求同时读-改-写导致后者覆盖前者的修改。
 *
 * In Electron production builds, RDK_DATA_DIR points to the app's
 * user-data directory instead of the project root.
 */
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RequestHandler, Response } from 'express';
import type { Device } from '../shared/types.js';
import type { DeviceConnectionHistoryEntry } from '../shared/device-connection-history.js';
import { isWebCloudDeployment } from './studio-deployment.js';
import { resolveConfiguredDataDir } from './knowledge-common/storage-location-settings.js';

let _legacyMigrated = false;

let _sudoInvokerHomeMemo: string | null | undefined;

type StorageRequestContext = {
  cookieHeader: string;
  setCookie?: (cookie: string) => void;
};

const storageRequestContext = new AsyncLocalStorage<StorageRequestContext>();

function appendSetCookie(response: Response, cookie: string): void {
  const existing = response.getHeader('Set-Cookie');
  if (!existing) {
    response.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(existing)) {
    response.setHeader('Set-Cookie', [...existing.map(String), cookie]);
    return;
  }
  response.setHeader('Set-Cookie', [String(existing), cookie]);
}

export const storageRequestContextMiddleware: RequestHandler = (request, response, next) => {
  storageRequestContext.run(
    {
      cookieHeader: String(request.headers.cookie ?? ''),
      setCookie: (cookie) => appendSetCookie(response, cookie),
    },
    next,
  );
};

export function runWithStorageCookieHeader<T>(cookieHeader: string, fn: () => T): T {
  return storageRequestContext.run({ cookieHeader }, fn);
}

/**
 * `sudo npm run desktop` 时 effective uid 为 root，但 `os.homedir()` 会落到 root 的家目录，
 * 与用户在设备管理里保存的 `~/.rdk-studio/data` 不一致。若环境中有 SUDO_USER，则解析其主目录。
 */
function homedirOfSudoInvoker(): string | null {
  if (_sudoInvokerHomeMemo !== undefined) return _sudoInvokerHomeMemo;
  const sudoUser = String(process.env.SUDO_USER ?? '').trim();
  if (!sudoUser || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    _sudoInvokerHomeMemo = null;
    return null;
  }
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('dscl', ['.', '-read', `/Users/${sudoUser}`, 'NFSHomeDirectory'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line = out.split('\n').find((l) => /NFSHomeDirectory/i.test(l));
      const home = line?.replace(/^[^:]+:\s*/, '').trim();
      if (home && home.startsWith('/')) {
        _sudoInvokerHomeMemo = home;
        return home;
      }
    } else if (process.platform !== 'win32') {
      const out = execFileSync('getent', ['passwd', sudoUser], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const parts = out.split(':');
      if (parts.length >= 6 && parts[5]?.startsWith('/')) {
        _sudoInvokerHomeMemo = parts[5];
        return parts[5];
      }
    }
  } catch {
    /* dscl/getent 不可用或非标准环境 */
  }
  if (process.platform === 'darwin') {
    _sudoInvokerHomeMemo = path.join('/Users', sudoUser);
    return _sudoInvokerHomeMemo;
  }
  if (process.platform !== 'win32') {
    _sudoInvokerHomeMemo = path.join('/home', sudoUser);
    return _sudoInvokerHomeMemo;
  }
  _sudoInvokerHomeMemo = null;
  return null;
}

export function resolveDefaultDataDir() {
  const base = homedirOfSudoInvoker() ?? os.homedir();
  return path.join(base, '.rdk-studio', 'data');
}

export function resolveDataDir() {
  const envDataDir = String(process.env.RDK_DATA_DIR ?? '').trim();
  if (envDataDir) return envDataDir;
  return resolveConfiguredDataDir(resolveDefaultDataDir());
}

/** SSO 会话落盘路径（与 devices.json 同目录，重启后端后可恢复登录态） */
export function getSsoSessionsFilePath() {
  return path.join(resolveDataDir(), 'sso-sessions.json');
}

/**
 * SSO 登录审计 JSONL（每行一条 JSON）。需设置 SSO_LOGIN_AUDIT_JSONL_ENABLED=1 才会写入；
 * 路径可用 RDK_SSO_LOGIN_AUDIT_JSONL_PATH 覆盖。
 */
export function getSsoLoginAuditFilePath() {
  const override = String(process.env.RDK_SSO_LOGIN_AUDIT_JSONL_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'sso-login-audit.jsonl');
}

/**
 * 前端埋点/行为事件 JSONL（每行一条 JSON）。
 * 优先 `RDK_ANALYTICS_JSONL_PATH`（可指向用户工作区下的路径，如 .../workspace/.rdk-studio/analytics-events.jsonl）；
 * 未设置时用 `RDK_DATA_DIR` 或 ~/.rdk-studio/data/analytics-events.jsonl。
 */
export function getAnalyticsEventsFilePath() {
  const override = String(process.env.RDK_ANALYTICS_JSONL_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'analytics-events.jsonl');
}

/** 可选第二份镜像（同一内容再写一份，便于工作区与全局数据目录各留一份） */
export function getAnalyticsEventsMirrorFilePath(): string | undefined {
  const mirror = String(process.env.RDK_ANALYTICS_JSONL_MIRROR ?? '').trim();
  return mirror ? path.resolve(mirror) : undefined;
}

/** 完整对话轮次 JSONL（用户提问 + AI 最终回复）；默认本机保存，可用 CONVERSATION_LOG_ENABLED=0 关闭 */
export function getConversationTurnsFilePath() {
  const override = String(process.env.CONVERSATION_LOG_JSONL_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'conversation-turns.jsonl');
}

export function getAgentRunSnapshotsFilePath() {
  const override = String(process.env.RDK_AGENT_RUN_SNAPSHOTS_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'agent-run-snapshots.json');
}

export function getAgentRunEventsFilePath() {
  const override = String(process.env.RDK_AGENT_RUN_EVENTS_JSONL_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'agent-run-events.jsonl');
}

export function getStudioTaskDatabasePath() {
  const override = String(process.env.RDK_STUDIO_TASK_DB_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'studio-tasks.sqlite');
}

export function getStudioTaskWorktreesRoot() {
  const override = String(process.env.RDK_STUDIO_TASK_WORKTREES_ROOT ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'task-worktrees');
}

export function getChatCreditsFilePath() {
  const override = String(process.env.RDK_CHAT_CREDITS_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(), 'chat-credits.json');
}

function getDataFilePath() {
  const dataDir = resolveDataDir();
  return path.join(dataDir, 'devices.json');
}

/** Windows/索引类软件偶发 EBUSY/EPERM，短重试可提高 rename 成功率 */
async function renameAtomic(tmpPath: string, dataFilePath: string) {
  const max = 6;
  for (let attempt = 0; attempt < max; attempt += 1) {
    try {
      await fs.rename(tmpPath, dataFilePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        (code === 'EBUSY'
          || code === 'EPERM'
          || code === 'EACCES'
          || code === 'UNKNOWN')
        && attempt < max - 1
      ) {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function chmodPrivateFile(filePath: string) {
  if (process.platform === 'win32') return;
  await fs.chmod(filePath, 0o600).catch(() => {
    /* best effort: Windows / external filesystems may not support POSIX mode */
  });
}

type DeviceWithSecrets = Device & {
  password?: unknown;
  sshPassword?: unknown;
};

function hasDeviceSecret(device: DeviceWithSecrets): boolean {
  return (
    Object.prototype.hasOwnProperty.call(device, 'password') ||
    Object.prototype.hasOwnProperty.call(device, 'sshPassword')
  );
}

function stripDeviceSecrets(device: DeviceWithSecrets): Device {
  const { password: _password, sshPassword: _sshPassword, ...safe } = device;
  return safe as Device;
}

const WEB_CLOUD_DEVICES_COOKIE = 'rdk_studio_devices';
const WEB_CLOUD_DEVICES_COOKIE_MAX_BYTES = 3600;
const WEB_CLOUD_DEVICES_MAX_COUNT = 12;
const WEB_CLOUD_DEVICES_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;
const DEVICE_CONNECTION_HISTORY_FILE = 'device-connection-history.json';
const DEVICE_CONNECTION_HISTORY_MAX_COUNT = 100;
const WEB_CLOUD_DEVICE_HISTORY_COOKIE = 'rdk_studio_device_history';
const WEB_CLOUD_DEVICE_HISTORY_MAX_COUNT = 10;
const WEB_CLOUD_DEVICE_HISTORY_COOKIE_MAX_BYTES = 3600;
const WEB_CLOUD_DEVICE_HISTORY_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

function getWebCloudCookieSecret(): string {
  const secret = String(process.env.RDK_STUDIO_COOKIE_SECRET ?? '').trim();
  if (secret.length < 32) {
    throw new Error('RDK_STUDIO_COOKIE_SECRET must be set to at least 32 characters.');
  }
  return secret;
}

/**
 * 轮换宽限期用的旧 secret（`RDK_STUDIO_COOKIE_SECRET_PREVIOUS`，逗号分隔，仅用于校验旧 cookie，不签名）。
 * 轮换流程：把旧值放进 PREVIOUS、新值放进 SECRET，旧 cookie 仍可校验通过、下次写入自动用新值重签；
 * 过宽限期（≥ cookie 最大寿命或等流量自然重签）后移除 PREVIOUS。避免轮换瞬间清空所有用户设备列表。
 */
function getWebCloudCookiePreviousSecrets(): string[] {
  return String(process.env.RDK_STUDIO_COOKIE_SECRET_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
}

function parseCookieHeader(header: string, name: string): string {
  const prefix = `${name}=`;
  for (const part of String(header || '').split(';')) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    const raw = item.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

function signCookiePayloadWith(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function signCookiePayload(payload: string): string {
  // 签名永远用当前主 secret；旧 secret 只参与校验。
  return signCookiePayloadWith(getWebCloudCookieSecret(), payload);
}

function verifySignedCookiePayload(payload: string, signature: string): boolean {
  const sigBuf = Buffer.from(signature);
  // 依次用 当前 + 宽限期旧 secret 校验，任一通过即有效（支持无损轮换）。
  for (const secret of [getWebCloudCookieSecret(), ...getWebCloudCookiePreviousSecrets()]) {
    const expected = Buffer.from(signCookiePayloadWith(secret, payload));
    if (sigBuf.length === expected.length && crypto.timingSafeEqual(sigBuf, expected)) {
      return true;
    }
  }
  return false;
}

function readWebCloudDevicesFromCookie(): Device[] {
  const context = storageRequestContext.getStore();
  const cookie = parseCookieHeader(context?.cookieHeader ?? '', WEB_CLOUD_DEVICES_COOKIE);
  if (!cookie) return [];
  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return [];
  const payload = parts[1] ?? '';
  const signature = parts[2] ?? '';
  if (!payload || !signature || !verifySignedCookiePayload(payload, signature)) return [];
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      devices?: DeviceWithSecrets[];
    };
    if (!Array.isArray(parsed.devices)) return [];
    return parsed.devices.slice(0, WEB_CLOUD_DEVICES_MAX_COUNT).map(stripDeviceSecrets);
  } catch {
    return [];
  }
}

function writeWebCloudDevicesToCookie(devices: Device[]): void {
  const context = storageRequestContext.getStore();
  if (!context?.setCookie) return;
  const sanitized = (devices as DeviceWithSecrets[]).map(stripDeviceSecrets);
  if (sanitized.length > WEB_CLOUD_DEVICES_MAX_COUNT) {
    throw Object.assign(
      new Error(`web-cloud device cookie supports at most ${WEB_CLOUD_DEVICES_MAX_COUNT} devices`),
      { code: 'WEB_CLOUD_DEVICE_COOKIE_LIMIT' },
    );
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, devices: sanitized }), 'utf-8').toString(
    'base64url',
  );
  const value = `v1.${payload}.${signCookiePayload(payload)}`;
  const cookie = `${WEB_CLOUD_DEVICES_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${WEB_CLOUD_DEVICES_COOKIE_MAX_AGE_SECONDS}`;
  if (Buffer.byteLength(cookie, 'utf-8') > WEB_CLOUD_DEVICES_COOKIE_MAX_BYTES) {
    throw Object.assign(
      new Error('web-cloud device cookie is too large; remove unused devices or use the desktop client'),
      { code: 'WEB_CLOUD_DEVICE_COOKIE_TOO_LARGE' },
    );
  }
  context.setCookie(cookie);
}

type DeviceConnectionHistoryInput = Omit<DeviceConnectionHistoryEntry, 'id' | 'occurredAt'> & {
  occurredAt?: string;
};

type WebCloudDeviceHistoryCookie = {
  v: 1;
  histories: Record<string, DeviceConnectionHistoryEntry[]>;
};

function deviceConnectionHistoryOwnerKey(ownerKey?: string | null): string {
  const normalized = String(ownerKey ?? '').trim();
  return normalized || 'anonymous';
}

function normalizeDeviceConnectionHistoryEntry(value: unknown): DeviceConnectionHistoryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<DeviceConnectionHistoryEntry>;
  const event = raw.event;
  if (
    event !== 'connected'
    && event !== 'reconnected'
    && event !== 'disconnected'
    && event !== 'removed'
    && event !== 'failed'
  ) return null;
  const name = String(raw.name ?? '').trim().slice(0, 120);
  const host = String(raw.host ?? '').trim().slice(0, 255);
  const username = String(raw.username ?? '').trim().slice(0, 96);
  const occurredAt = String(raw.occurredAt ?? '').trim();
  const port = Number(raw.port ?? 22);
  if (!name || !host || !username || !occurredAt || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  const id = String(raw.id ?? '').trim().slice(0, 160);
  if (!id) return null;
  const deviceId = String(raw.deviceId ?? '').trim().slice(0, 160) || undefined;
  const detail = String(raw.detail ?? '').trim().slice(0, 240) || undefined;
  return {
    id,
    event,
    occurredAt,
    ...(deviceId ? { deviceId } : {}),
    name,
    host,
    port,
    username,
    ...(detail ? { detail } : {}),
  };
}

function deviceConnectionHistoryIdentity(entry: DeviceConnectionHistoryEntry): string {
  return `${entry.host.toLowerCase()}:${entry.port}`;
}

function normalizeDeviceConnectionHistory(value: unknown): DeviceConnectionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const seenIdentities = new Set<string>();
  const entries: DeviceConnectionHistoryEntry[] = [];
  for (const raw of value) {
    const entry = normalizeDeviceConnectionHistoryEntry(raw);
    if (!entry) continue;
    // 历史按时间倒序存储：同一设备（同地址）只保留最新一条事件，
    // 避免「删除+重连」后同一台设备在历史里算成两条。
    const identity = deviceConnectionHistoryIdentity(entry);
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    entries.push(entry);
  }
  return entries.slice(0, DEVICE_CONNECTION_HISTORY_MAX_COUNT);
}

function readSignedCookiePayload(name: string): unknown | null {
  const context = storageRequestContext.getStore();
  const cookie = parseCookieHeader(context?.cookieHeader ?? '', name);
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payload = parts[1] ?? '';
  const signature = parts[2] ?? '';
  if (!payload || !signature || !verifySignedCookiePayload(payload, signature)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as unknown;
  } catch {
    return null;
  }
}

function writeSignedCookiePayload(
  name: string,
  payloadValue: unknown,
  maxAgeSeconds: number,
  maxBytes: number,
): void {
  const context = storageRequestContext.getStore();
  if (!context?.setCookie) return;
  const payload = Buffer.from(JSON.stringify(payloadValue), 'utf-8').toString('base64url');
  const value = `v1.${payload}.${signCookiePayload(payload)}`;
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
  if (Buffer.byteLength(cookie, 'utf-8') > maxBytes) {
    throw Object.assign(new Error(`${name} cookie is too large`), {
      code: 'WEB_CLOUD_DEVICE_HISTORY_COOKIE_TOO_LARGE',
    });
  }
  context.setCookie(cookie);
}

function readWebCloudDeviceConnectionHistory(ownerKey?: string | null): DeviceConnectionHistoryEntry[] {
  const parsed = readSignedCookiePayload(WEB_CLOUD_DEVICE_HISTORY_COOKIE) as
    | Partial<WebCloudDeviceHistoryCookie>
    | null;
  if (!parsed || parsed.v !== 1 || !parsed.histories || typeof parsed.histories !== 'object') return [];
  return normalizeDeviceConnectionHistory(parsed.histories[deviceConnectionHistoryOwnerKey(ownerKey)]);
}

function writeWebCloudDeviceConnectionHistory(
  ownerKey: string | null | undefined,
  entries: DeviceConnectionHistoryEntry[],
): void {
  const parsed = readSignedCookiePayload(WEB_CLOUD_DEVICE_HISTORY_COOKIE) as
    | Partial<WebCloudDeviceHistoryCookie>
    | null;
  const histories: Record<string, DeviceConnectionHistoryEntry[]> =
    parsed?.v === 1 && parsed.histories && typeof parsed.histories === 'object'
      ? { ...parsed.histories }
      : {};
  const key = deviceConnectionHistoryOwnerKey(ownerKey);
  histories[key] = normalizeDeviceConnectionHistory(entries).slice(0, WEB_CLOUD_DEVICE_HISTORY_MAX_COUNT);
  writeSignedCookiePayload(
    WEB_CLOUD_DEVICE_HISTORY_COOKIE,
    { v: 1, histories },
    WEB_CLOUD_DEVICE_HISTORY_COOKIE_MAX_AGE_SECONDS,
    WEB_CLOUD_DEVICE_HISTORY_COOKIE_MAX_BYTES,
  );
}

function getDeviceConnectionHistoryFilePath(): string {
  return path.join(resolveDataDir(), DEVICE_CONNECTION_HISTORY_FILE);
}

async function readDesktopDeviceConnectionHistory(): Promise<DeviceConnectionHistoryEntry[]> {
  const content = await fs.readFile(getDeviceConnectionHistoryFilePath(), 'utf-8').catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  });
  try {
    return normalizeDeviceConnectionHistory(JSON.parse(content));
  } catch {
    return [];
  }
}

let _deviceHistoryWriteChain: Promise<void> = Promise.resolve();

function serializedWriteDeviceConnectionHistory(fn: () => Promise<void>): Promise<void> {
  const next = _deviceHistoryWriteChain.then(fn, fn);
  _deviceHistoryWriteChain = next.catch(() => {});
  return next;
}

export async function readDeviceConnectionHistory(ownerKey?: string | null): Promise<DeviceConnectionHistoryEntry[]> {
  if (isWebCloudDeployment()) return readWebCloudDeviceConnectionHistory(ownerKey);
  return readDesktopDeviceConnectionHistory();
}

export async function appendDeviceConnectionHistory(
  input: DeviceConnectionHistoryInput,
  ownerKey?: string | null,
): Promise<DeviceConnectionHistoryEntry> {
  const entry = normalizeDeviceConnectionHistoryEntry({
    ...input,
    id: crypto.randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
  if (!entry) throw new Error('Invalid device connection history entry');

  if (isWebCloudDeployment()) {
    const current = readWebCloudDeviceConnectionHistory(ownerKey);
    writeWebCloudDeviceConnectionHistory(ownerKey, [entry, ...current]);
    return entry;
  }

  await serializedWriteDeviceConnectionHistory(async () => {
    const current = await readDesktopDeviceConnectionHistory();
    const next = [entry, ...current].slice(0, DEVICE_CONNECTION_HISTORY_MAX_COUNT);
    const dataFilePath = getDeviceConnectionHistoryFilePath();
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    const tmpPath = `${dataFilePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await chmodPrivateFile(tmpPath);
    await renameAtomic(tmpPath, dataFilePath);
    await chmodPrivateFile(dataFilePath);
  });
  return entry;
}

export async function clearDeviceConnectionHistory(ownerKey?: string | null): Promise<void> {
  if (isWebCloudDeployment()) {
    writeWebCloudDeviceConnectionHistory(ownerKey, []);
    return;
  }
  await serializedWriteDeviceConnectionHistory(async () => {
    const dataFilePath = getDeviceConnectionHistoryFilePath();
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    const tmpPath = `${dataFilePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmpPath, '[]', { encoding: 'utf-8', mode: 0o600 });
    await chmodPrivateFile(tmpPath);
    await renameAtomic(tmpPath, dataFilePath);
    await chmodPrivateFile(dataFilePath);
  });
}

async function migrateLegacyDataIfNeeded(targetFilePath: string) {
  if (_legacyMigrated) return;
  _legacyMigrated = true;
  if (String(process.env.RDK_DATA_DIR ?? '').trim()) return;

  const legacyPath = path.resolve(process.cwd(), 'data', 'devices.json');
  if (legacyPath === targetFilePath) return;

  const targetExists = await fs.access(targetFilePath).then(() => true).catch(() => false);
  if (targetExists) return;

  const legacyExists = await fs.access(legacyPath).then(() => true).catch(() => false);
  if (!legacyExists) return;

  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
  await fs.copyFile(legacyPath, targetFilePath);
  await chmodPrivateFile(targetFilePath);
}

let _deviceCache: { data: Device[]; expiresAt: number } | null = null;
const DEVICE_CACHE_TTL_MS = 3000;

const _webCloudDeviceCache = new Map<string, { data: Device[]; expiresAt: number }>();
const WEB_CLOUD_DEVICE_CACHE_TTL_MS = 500;
const WEB_CLOUD_DEVICE_CACHE_MAX_ENTRIES = 500;

/**
 * 下一轮 `readDevices()` 强制读盘/重读 Cookie，不返回 TTL 内的内存快照。
 * 供套件端 SSH/SFTP 前使用，避免刚写入的密码等字段仍被短 TTL 挡住。
 */
export function invalidateDevicesReadCache(): void {
  _deviceCache = null;
  _webCloudDeviceCache.clear();
}

export async function readDevices(): Promise<Device[]> {
  if (isWebCloudDeployment()) {
    const context = storageRequestContext.getStore();
    const cookieHeader = context?.cookieHeader ?? '';
    if (cookieHeader) {
      const cached = _webCloudDeviceCache.get(cookieHeader);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }
    const devices = readWebCloudDevicesFromCookie();
    if (cookieHeader && devices.length > 0) {
      _webCloudDeviceCache.set(cookieHeader, {
        data: devices,
        expiresAt: Date.now() + WEB_CLOUD_DEVICE_CACHE_TTL_MS,
      });
      if (_webCloudDeviceCache.size > WEB_CLOUD_DEVICE_CACHE_MAX_ENTRIES) {
        const now = Date.now();
        for (const [key, entry] of _webCloudDeviceCache) {
          if (entry.expiresAt <= now) _webCloudDeviceCache.delete(key);
        }
      }
    }
    return devices;
  }
  if (_deviceCache && _deviceCache.expiresAt > Date.now()) {
    return _deviceCache.data;
  }
  const dataFilePath = getDataFilePath();
  await migrateLegacyDataIfNeeded(dataFilePath);
  const content = await fs.readFile(dataFilePath, 'utf-8').catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
      await fs.writeFile(dataFilePath, '[]', { encoding: 'utf-8', mode: 0o600 });
      await chmodPrivateFile(dataFilePath);
      return '[]';
    }
    throw error;
  });

  const parsed = JSON.parse(content) as DeviceWithSecrets[];
  const devices = parsed.map(stripDeviceSecrets);
  if (parsed.some(hasDeviceSecret)) {
    await writeDevices(devices).catch(() => {
      /* best effort legacy secret migration; returned data is still sanitized */
    });
  }
  _deviceCache = { data: devices, expiresAt: Date.now() + DEVICE_CACHE_TTL_MS };
  return devices;
}

export async function writeDevices(devices: Device[]) {
  _deviceCache = null;
  if (isWebCloudDeployment()) {
    writeWebCloudDevicesToCookie(devices);
    return;
  }
  const dataFilePath = getDataFilePath();
  await migrateLegacyDataIfNeeded(dataFilePath);
  await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
  // 原子写入：先写临时文件再 rename，防止写入中途崩溃导致 JSON 损坏。
  // 临时名带随机后缀：同进程内不走串行链的直接 writeDevices（如 readDevices 里的 legacy secret 迁移）
  // 与某次 serializedWriteDevices 并发时，仅按 pid 命名会共用同一 tmp 文件、互相覆盖导致 rename 出错配内容。
  const tmpPath = dataFilePath + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  const sanitized = (devices as DeviceWithSecrets[]).map(stripDeviceSecrets);
  await fs.writeFile(tmpPath, JSON.stringify(sanitized, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await chmodPrivateFile(tmpPath);
  await renameAtomic(tmpPath, dataFilePath);
  await chmodPrivateFile(dataFilePath);
}

/**
 * 串行化写入：保证并发 writeDevices 调用按序执行。
 *
 * 使用场景：多个 Socket.IO 事件或 API 路由同时触发设备状态更新时，
 * 如果不串行化，后一个 writeDevices 可能基于过期数据覆盖前一个的修改。
 *
 * 用法：在需要读-改-写的场景中，用 serializedWriteDevices 替代直接调用 writeDevices。
 * 例如：await serializedWriteDevices(async () => {
 *   const devices = await readDevices();
 *   devices.push(newDevice);
 *   await writeDevices(devices);
 * });
 */
let _writeChain: Promise<void> = Promise.resolve();

export function serializedWriteDevices(fn: () => Promise<void>): Promise<void> {
  if (isWebCloudDeployment()) {
    return fn();
  }
  const next = _writeChain.then(fn, fn);
  _writeChain = next.catch(() => {});
  return next;
}
