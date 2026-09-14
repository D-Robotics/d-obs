import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { replaceFileWithRetry } from './atomic-file-replace.js';
import { resolveDataDir } from './storage.js';

export type CredentialRevocationKind = 'localSession' | 'cloudSession' | 'user';

type TombstoneRecord = {
  v: 1;
  createdAt: number;
  expiresAt: number;
  hashes: Partial<Record<CredentialRevocationKind, string[]>>;
};

export type CredentialRevocationInput = {
  localSessionIds?: Iterable<string | undefined>;
  cloudSessionIds?: Iterable<string | undefined>;
  userIds?: Iterable<string | undefined>;
  expiresAt: number;
};

type TombstoneTestHooks = {
  beforeCreate?: () => void | Promise<void>;
  readdirSync?: (directory: string) => string[];
  readFileSync?: (filePath: string) => string;
  maxActiveSubjects?: number;
  maxActiveFiles?: number;
  maxPendingTombstones?: number;
  now?: () => number;
};

const TOMBSTONE_DIRECTORY = 'credential-revocation-tombstones';
const MAX_PENDING_TOMBSTONES = 256;
const MAX_ACTIVE_TOMBSTONE_SUBJECTS = 16_384;
const MAX_ACTIVE_TOMBSTONE_FILES = 4_096;
const RETRY_DELAY_MS = 5_000;
const EXPIRY_BUCKET_MS = 60 * 60 * 1000;

let testHooks: TombstoneTestHooks | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, TombstoneRecord>();
let activeDirectory = '';
let hydrated = false;
let activeRevision = 0;
const activeFiles = new Map<string, number>();
let lastHydrationWarning = '';
let persistenceTail: Promise<void> = Promise.resolve();
const activeHashes = new Map<
  CredentialRevocationKind,
  Map<
    string,
    {
      createdAt: number;
      expiresAt: number;
      observedRevision: number;
      durableExpiresAt: number;
    }
  >
>();

export class CredentialRevocationStoreUnavailableError extends Error {
  constructor() {
    super('credential revocation tombstones are temporarily unavailable');
    this.name = 'CredentialRevocationStoreUnavailableError';
  }
}

function tombstoneDirectory(): string {
  return path.join(resolveDataDir(), TOMBSTONE_DIRECTORY);
}

function tombstoneNow(): number {
  return testHooks?.now?.() ?? Date.now();
}

function hashCredential(kind: CredentialRevocationKind, raw: string): string {
  return crypto.createHash('sha256').update(`rdk-studio:${kind}:v1\0${raw}`).digest('hex');
}

function normalizedHashes(
  kind: CredentialRevocationKind,
  values: Iterable<string | undefined> | undefined,
): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const normalized = String(value ?? '').trim();
    if (normalized) unique.add(hashCredential(kind, normalized));
  }
  return [...unique].sort();
}

function buildRecord(input: CredentialRevocationInput): TombstoneRecord | null {
  const createdAt = tombstoneNow();
  // Bucket expiry to one-hour boundaries so immediate idempotent retries reuse
  // an existing durable record, while a genuinely longer revocation still
  // extends its lifetime and gets a new commit point.
  const requestedExpiry = Math.max(createdAt + 1, Math.floor(input.expiresAt));
  const expiresAt = Math.ceil(requestedExpiry / EXPIRY_BUCKET_MS) * EXPIRY_BUCKET_MS;
  const localSession = normalizedHashes('localSession', input.localSessionIds);
  const cloudSession = normalizedHashes('cloudSession', input.cloudSessionIds);
  const user = normalizedHashes('user', input.userIds);
  if (!localSession.length && !cloudSession.length && !user.length) return null;
  return {
    v: 1,
    createdAt,
    expiresAt,
    hashes: {
      ...(localSession.length ? { localSession } : {}),
      ...(cloudSession.length ? { cloudSession } : {}),
      ...(user.length ? { user } : {}),
    },
  };
}

function parseRecord(
  raw: string,
  now: number,
): { status: 'active'; record: TombstoneRecord } | { status: 'expired' } | { status: 'invalid' } {
  try {
    const value = JSON.parse(raw) as Partial<TombstoneRecord>;
    if (
      value.v !== 1 ||
      !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.expiresAt) ||
      !value.hashes ||
      typeof value.hashes !== 'object'
    ) {
      return { status: 'invalid' };
    }
    const hashes: TombstoneRecord['hashes'] = {};
    for (const kind of ['localSession', 'cloudSession', 'user'] as const) {
      const candidates = value.hashes[kind];
      if (!Array.isArray(candidates)) continue;
      const valid = candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && /^[a-f0-9]{64}$/i.test(candidate),
      );
      if (valid.length)
        hashes[kind] = [...new Set(valid.map((candidate) => candidate.toLowerCase()))];
    }
    if (!Object.keys(hashes).length) return { status: 'invalid' };
    const record = {
      v: 1 as const,
      createdAt: Number(value.createdAt),
      expiresAt: Number(value.expiresAt),
      hashes,
    };
    return record.expiresAt <= now ? { status: 'expired' } : { status: 'active', record };
  } catch {
    return { status: 'invalid' };
  }
}

function addRecordToHashes(
  target: typeof activeHashes,
  record: TombstoneRecord,
  observedRevision: number,
  durable: boolean,
): void {
  if (record.expiresAt <= tombstoneNow()) return;
  for (const kind of ['localSession', 'cloudSession', 'user'] as const) {
    let byHash = target.get(kind);
    if (!byHash) {
      byHash = new Map<
        string,
        {
          createdAt: number;
          expiresAt: number;
          observedRevision: number;
          durableExpiresAt: number;
        }
      >();
      target.set(kind, byHash);
    }
    for (const hash of record.hashes[kind] ?? []) {
      const previous = byHash.get(hash);
      byHash.set(hash, {
        createdAt: Math.max(previous?.createdAt ?? 0, record.createdAt),
        expiresAt: Math.max(previous?.expiresAt ?? 0, record.expiresAt),
        observedRevision: Math.max(previous?.observedRevision ?? 0, observedRevision),
        durableExpiresAt: Math.max(previous?.durableExpiresAt ?? 0, durable ? record.expiresAt : 0),
      });
    }
  }
}

function addActiveRecord(record: TombstoneRecord, durable = false): void {
  activeRevision += 1;
  addRecordToHashes(activeHashes, record, activeRevision, durable);
}

function recordAlreadyDurable(record: TombstoneRecord): boolean {
  const now = tombstoneNow();
  let subjects = 0;
  for (const kind of ['localSession', 'cloudSession', 'user'] as const) {
    for (const hash of record.hashes[kind] ?? []) {
      subjects += 1;
      const durableExpiresAt = activeHashes.get(kind)?.get(hash)?.durableExpiresAt ?? 0;
      if (durableExpiresAt <= now || durableExpiresAt < record.expiresAt) return false;
    }
  }
  return subjects > 0;
}

function configuredCapacity(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback));
}

function maxActiveSubjects(): number {
  return configuredCapacity(testHooks?.maxActiveSubjects, MAX_ACTIVE_TOMBSTONE_SUBJECTS);
}

function maxActiveFiles(): number {
  return configuredCapacity(testHooks?.maxActiveFiles, MAX_ACTIVE_TOMBSTONE_FILES);
}

function maxPendingTombstones(): number {
  return configuredCapacity(testHooks?.maxPendingTombstones, MAX_PENDING_TOMBSTONES);
}

function pruneExpiredActiveHashes(now = tombstoneNow()): void {
  for (const [kind, byHash] of activeHashes) {
    for (const [hash, entry] of byHash) {
      if (entry.expiresAt <= now) byHash.delete(hash);
    }
    if (byHash.size === 0) activeHashes.delete(kind);
  }
}

function activeSubjectCount(target: typeof activeHashes = activeHashes): number {
  let count = 0;
  for (const byHash of target.values()) count += byHash.size;
  return count;
}

async function reclaimExpiredActiveFiles(now = tombstoneNow()): Promise<void> {
  for (const [filePath, expiresAt] of activeFiles) {
    if (expiresAt > now) continue;
    try {
      await fsPromises.unlink(filePath);
      activeFiles.delete(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') activeFiles.delete(filePath);
    }
  }
}

async function recordFitsActiveCapacity(record: TombstoneRecord): Promise<boolean> {
  pruneExpiredActiveHashes();
  await reclaimExpiredActiveFiles();
  if (activeFiles.size >= maxActiveFiles()) return false;
  let addedSubjects = 0;
  for (const kind of ['localSession', 'cloudSession', 'user'] as const) {
    const existing = activeHashes.get(kind);
    for (const hash of record.hashes[kind] ?? []) {
      if (!existing?.has(hash)) addedSubjects += 1;
    }
  }
  return activeSubjectCount() + addedSubjects <= maxActiveSubjects();
}

async function withPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = persistenceTail;
  let release!: () => void;
  persistenceTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function warnHydrationFailure(code: string): void {
  if (lastHydrationWarning === code) return;
  lastHydrationWarning = code;
  console.warn('[auth] credential revocation tombstone hydration failed closed', { code });
}

function ensureHydrated(): void {
  const directory = tombstoneDirectory();
  if (directory !== activeDirectory) {
    activeDirectory = directory;
    hydrated = false;
    activeHashes.clear();
    activeFiles.clear();
  }
  if (hydrated) return;
  const now = tombstoneNow();
  let names: string[];
  try {
    names = (testHooks?.readdirSync ?? ((target) => fs.readdirSync(target)))(directory).filter(
      (name) => name.endsWith('.json'),
    );
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN');
    if (code === 'ENOENT') {
      activeHashes.clear();
      for (const record of pending.values())
        addRecordToHashes(activeHashes, record, activeRevision, false);
      if (activeSubjectCount() > maxActiveSubjects()) {
        warnHydrationFailure('CAPACITY_EXCEEDED');
        throw new CredentialRevocationStoreUnavailableError();
      }
      activeFiles.clear();
      hydrated = true;
      lastHydrationWarning = '';
      return;
    }
    // Do not memoize a failed scan as an empty revocation set. Callers fail
    // closed and the next lookup retries after permissions/storage recover.
    warnHydrationFailure(code);
    throw new CredentialRevocationStoreUnavailableError();
  }

  const hydratedHashes: typeof activeHashes = new Map();
  const hydratedFiles = new Map<string, number>();
  const observedRevision = activeRevision + 1;
  let hydratedFileCount = 0;
  for (const name of names) {
    const filePath = path.join(directory, name);
    let raw = '';
    try {
      raw = testHooks?.readFileSync
        ? testHooks.readFileSync(filePath)
        : fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      warnHydrationFailure(String((error as NodeJS.ErrnoException)?.code ?? 'READ_FAILED'));
      throw new CredentialRevocationStoreUnavailableError();
    }
    const parsed = parseRecord(raw, now);
    if (parsed.status === 'active') {
      hydratedFileCount += 1;
      if (hydratedFileCount > maxActiveFiles()) {
        warnHydrationFailure('CAPACITY_EXCEEDED');
        throw new CredentialRevocationStoreUnavailableError();
      }
      addRecordToHashes(hydratedHashes, parsed.record, observedRevision, true);
      if (activeSubjectCount(hydratedHashes) > maxActiveSubjects()) {
        warnHydrationFailure('CAPACITY_EXCEEDED');
        throw new CredentialRevocationStoreUnavailableError();
      }
      hydratedFiles.set(filePath, parsed.record.expiresAt);
      continue;
    }
    if (parsed.status === 'invalid') {
      // A corrupt active tombstone is indistinguishable from a lost logout.
      // Keep it for operator recovery and deny credential publication until it
      // can be read again, instead of silently deleting the revocation record.
      warnHydrationFailure('INVALID_TOMBSTONE');
      throw new CredentialRevocationStoreUnavailableError();
    }
    // Expired tombstones no longer affect the authentication decision.
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* best-effort GC */
    }
  }
  for (const record of pending.values()) {
    addRecordToHashes(hydratedHashes, record, observedRevision, false);
  }
  if (activeSubjectCount(hydratedHashes) > maxActiveSubjects()) {
    warnHydrationFailure('CAPACITY_EXCEEDED');
    throw new CredentialRevocationStoreUnavailableError();
  }
  activeHashes.clear();
  for (const [kind, values] of hydratedHashes) activeHashes.set(kind, values);
  activeFiles.clear();
  for (const [filePath, expiresAt] of hydratedFiles) activeFiles.set(filePath, expiresAt);
  activeRevision = observedRevision;
  hydrated = true;
  lastHydrationWarning = '';
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
  try {
    handle = await fsPromises.open(directory, 'r');
    await handle.sync();
  } catch {
    // Windows and some network filesystems do not support opening/fsyncing a
    // directory. File fsync above is the required commit point there.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function persistRecord(record: TombstoneRecord): Promise<string> {
  await testHooks?.beforeCreate?.();
  const directory = tombstoneDirectory();
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fsPromises.chmod(directory, 0o700).catch(() => undefined);
  }

  let handle: Awaited<ReturnType<typeof fsPromises.open>> | null = null;
  let temporaryPath = '';
  let destinationPath = '';
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      destinationPath = path.join(
        directory,
        `${record.createdAt}-${process.pid}-${crypto.randomBytes(10).toString('hex')}.json`,
      );
      temporaryPath = `${destinationPath}.tmp`;
      try {
        handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST' || attempt === 3) throw error;
      }
    }
    if (!handle) throw new Error('credential revocation tombstone open failed');
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== 'win32') {
      await fsPromises.chmod(temporaryPath, 0o600).catch(() => undefined);
    }
    await replaceFileWithRetry(temporaryPath, destinationPath, fsPromises.rename);
    temporaryPath = '';
    await fsyncDirectoryBestEffort(directory);
    return destinationPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (temporaryPath) await fsPromises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function recordKey(record: TombstoneRecord): string {
  return JSON.stringify(record.hashes);
}

function queuePending(record: TombstoneRecord): boolean {
  const now = tombstoneNow();
  for (const [key, queued] of pending) {
    if (queued.expiresAt <= now) pending.delete(key);
  }
  const key = recordKey(record);
  const previous = pending.get(key);
  // Never evict an older revocation that has not reached a durable commit
  // point. Rejecting the new logout is the safe bounded failure mode.
  if (!previous && pending.size >= maxPendingTombstones()) return false;
  pending.set(
    key,
    previous
      ? {
          ...record,
          createdAt: Math.max(previous.createdAt, record.createdAt),
          expiresAt: Math.max(previous.expiresAt, record.expiresAt),
        }
      : record,
  );
  scheduleRetry();
  return true;
}

function scheduleRetry(): void {
  if (retryTimer || pending.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void retryPendingCredentialRevocations();
  }, RETRY_DELAY_MS);
  retryTimer.unref?.();
}

async function retryPendingCredentialRevocations(): Promise<void> {
  await withPersistenceLock(async () => {
    try {
      ensureHydrated();
    } catch {
      return;
    }
    for (const [key, record] of [...pending]) {
      if (record.expiresAt <= tombstoneNow()) {
        pending.delete(key);
        continue;
      }
      if (recordAlreadyDurable(record)) {
        pending.delete(key);
        continue;
      }
      await reclaimExpiredActiveFiles();
      if (activeFiles.size >= maxActiveFiles()) break;
      try {
        const filePath = await persistRecord(record);
        pending.delete(key);
        activeFiles.set(filePath, record.expiresAt);
        addRecordToHashes(activeHashes, record, activeRevision, true);
      } catch {
        // The caller already received a retryable 503. Retain every older
        // hashes-only revocation; a full queue never evicts one for a newer id.
      }
    }
  });
  scheduleRetry();
}

/**
 * Durable logout commit point. The queued copy contains hashes only; no raw
 * session id, user id, token, or managed key is retained in memory or on disk.
 */
export async function persistCredentialRevocationTombstone(
  input: CredentialRevocationInput,
): Promise<boolean> {
  const record = buildRecord(input);
  if (!record) return true;
  return withPersistenceLock(async () => {
    try {
      ensureHydrated();
    } catch {
      // Capacity cannot be proven while an older revocation file is unreadable.
      // Fail closed instead of appending attacker-controlled files blindly.
      return false;
    }
    if (recordAlreadyDurable(record)) return true;
    if (!(await recordFitsActiveCapacity(record))) return false;

    // Apply the revocation to this process immediately even when durable
    // storage is temporarily unavailable; a 503 tells the renderer to retry.
    addActiveRecord(record);
    try {
      const filePath = await persistRecord(record);
      activeFiles.set(filePath, record.expiresAt);
      addRecordToHashes(activeHashes, record, activeRevision, true);
      return true;
    } catch (error) {
      const queued = queuePending(record);
      console.warn('[auth] credential revocation tombstone persist failed', {
        code: String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'),
        queued,
      });
      return false;
    }
  });
}

export function latestCredentialRevocationAt(
  kind: CredentialRevocationKind,
  raw: string | undefined,
): number {
  const normalized = String(raw ?? '').trim();
  if (!normalized) return 0;
  ensureHydrated();
  const hash = hashCredential(kind, normalized);
  const active = activeHashes.get(kind)?.get(hash);
  if (!active) return 0;
  if (active.expiresAt <= tombstoneNow()) {
    activeHashes.get(kind)?.delete(hash);
    return 0;
  }
  return active.createdAt;
}

export function isCredentialRevoked(
  kind: CredentialRevocationKind,
  raw: string | undefined,
): boolean {
  return latestCredentialRevocationAt(kind, raw) > 0;
}

/** Used only to retire a short-lived process fence after disk is authoritative. */
export function isCredentialDurablyRevoked(
  kind: CredentialRevocationKind,
  raw: string | undefined,
): boolean {
  const normalized = String(raw ?? '').trim();
  if (!normalized) return false;
  ensureHydrated();
  const entry = activeHashes.get(kind)?.get(hashCredential(kind, normalized));
  return !!entry && entry.durableExpiresAt > tombstoneNow();
}

/**
 * Captures a publication fence after a complete tombstone scan. Async auth
 * operations must compare the exact credentials again before publishing state.
 */
export function captureCredentialRevocationFence(): number {
  ensureHydrated();
  return activeRevision;
}

export function wasCredentialRevokedAfter(
  fence: number,
  kind: CredentialRevocationKind,
  raw: string | undefined,
): boolean {
  const normalized = String(raw ?? '').trim();
  if (!normalized) return false;
  ensureHydrated();
  const active = activeHashes.get(kind)?.get(hashCredential(kind, normalized));
  if (!active || active.expiresAt <= tombstoneNow()) return false;
  return active.observedRevision > fence;
}

/** Ensures a newly verified credential sorts strictly after an older logout. */
export function timestampAfterUserRevocation(userId: string, now = Date.now()): number {
  return Math.max(now, latestCredentialRevocationAt('user', userId) + 1);
}

export function setCredentialRevocationTombstoneTestHooksForTest(
  hooks: TombstoneTestHooks | null,
): void {
  testHooks = hooks;
}

export async function retryPendingCredentialRevocationsForTest(): Promise<void> {
  await retryPendingCredentialRevocations();
}

export function pendingCredentialRevocationCountForTest(): number {
  return pending.size;
}

export function credentialRevocationCapacityForTest(): {
  activeSubjects: number;
  activeFiles: number;
  pending: number;
} {
  ensureHydrated();
  pruneExpiredActiveHashes();
  return {
    activeSubjects: activeSubjectCount(),
    activeFiles: activeFiles.size,
    pending: pending.size,
  };
}

export function resetCredentialRevocationTombstoneRuntimeForTest(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  pending.clear();
  activeDirectory = '';
  hydrated = false;
  activeRevision = 0;
  activeFiles.clear();
  lastHydrationWarning = '';
  activeHashes.clear();
  testHooks = null;
}
