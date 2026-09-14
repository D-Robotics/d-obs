import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StudioTraceBatch } from '../../shared/studio-observability.js';
import { resolveDataDir } from '../storage.js';
import type { TelemetryDeletionTombstone } from './governance-deletion.js';

const OUTBOX_SCHEMA = 1 as const;
const MAX_ITEMS_PER_ACCOUNT = 256;
const MAX_BYTES_PER_ACCOUNT = 32 * 1024 * 1024;
const MAX_FLUSH_ITEMS = 16;
const MAX_AGE_MS = 35 * 24 * 60 * 60_000;
const MAX_TOMBSTONES_PER_ACCOUNT = 4_096;

export interface TraceBatchOutboxItem {
  batchId: string;
  accountScopeId: string;
  batch: StudioTraceBatch;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastAttemptAt: number | null;
}

interface TraceBatchOutboxFile {
  schemaVersion: typeof OUTBOX_SCHEMA;
  accountScopeId: string;
  items: TraceBatchOutboxItem[];
  tombstones: TelemetryDeletionTombstone[];
  counters: {
    queued: number;
    acknowledged: number;
    duplicateAcknowledged: number;
    expired: number;
    saturationDropped: number;
    retries: number;
    tombstoneDiscarded: number;
  };
}

export type TraceBatchUploadAck =
  | { ok: true; status: 'accepted' | 'duplicate' }
  | { ok: false; retryable: boolean };

const mutationTails = new Map<string, Promise<void>>();

function cleanAccount(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 256);
}

function accountFileKey(accountScopeId: string): string {
  return createHash('sha256').update(`studio-trace-outbox\0${accountScopeId}`).digest('hex');
}

function outboxPath(accountScopeId: string): string {
  return path.join(
    resolveDataDir(),
    'studio-trace-outbox',
    `${accountFileKey(accountScopeId)}.json`,
  );
}

function emptyOutbox(accountScopeId: string): TraceBatchOutboxFile {
  return {
    schemaVersion: OUTBOX_SCHEMA,
    accountScopeId,
    items: [],
    tombstones: [],
    counters: {
      queued: 0,
      acknowledged: 0,
      duplicateAcknowledged: 0,
      expired: 0,
      saturationDropped: 0,
      retries: 0,
      tombstoneDiscarded: 0,
    },
  };
}

function normalizeTombstone(
  raw: unknown,
  accountScopeId: string,
): TelemetryDeletionTombstone | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<TelemetryDeletionTombstone>;
  const environment = String(value.environment ?? '');
  const tombstoneId = String(value.tombstoneId ?? '')
    .trim()
    .slice(0, 256);
  const requestId = String(value.requestId ?? '')
    .trim()
    .slice(0, 256);
  const createdAt = Number(value.createdAt);
  if (
    cleanAccount(value.accountScopeId) !== accountScopeId ||
    !['production', 'staging', 'development', 'test'].includes(environment) ||
    !tombstoneId ||
    !requestId ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }
  const normalized: TelemetryDeletionTombstone = {
    tombstoneId,
    requestId,
    accountScopeId,
    environment: environment as TelemetryDeletionTombstone['environment'],
    createdAt,
  };
  for (const key of ['userId', 'runId', 'traceId', 'sessionId', 'grantId'] as const) {
    const selector = String(value[key] ?? '')
      .trim()
      .slice(0, 256);
    if (selector) normalized[key] = selector;
  }
  return normalized;
}

function normalizeItem(raw: unknown, accountScopeId: string): TraceBatchOutboxItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Partial<TraceBatchOutboxItem>;
  if (cleanAccount(item.accountScopeId) !== accountScopeId) return null;
  const batch = item.batch;
  const batchId = String(item.batchId ?? '')
    .trim()
    .toLowerCase();
  if (!batch || batch.batchId !== batchId || !/^[0-9a-f]{64}$/.test(batchId)) return null;
  const createdAt = Number(item.createdAt);
  const expiresAt = Number(item.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  return {
    batchId,
    accountScopeId,
    batch,
    createdAt,
    expiresAt: Math.min(expiresAt, batchRetentionDeadline(batch, createdAt + MAX_AGE_MS)),
    attempts: Math.max(0, Math.trunc(Number(item.attempts) || 0)),
    nextAttemptAt: Number.isFinite(Number(item.nextAttemptAt))
      ? Number(item.nextAttemptAt)
      : createdAt,
    lastAttemptAt: Number.isFinite(Number(item.lastAttemptAt)) ? Number(item.lastAttemptAt) : null,
  };
}

function batchRetentionDeadline(batch: StudioTraceBatch, fallback: number): number {
  let deadline = fallback;
  const batchCreatedAt = Number(batch.createdAt);
  if (Number.isFinite(batchCreatedAt)) deadline = Math.min(deadline, batchCreatedAt + MAX_AGE_MS);
  for (const span of batch.spans) {
    const eventTime = Number(span.startTimeUnixMs);
    if (Number.isFinite(eventTime)) deadline = Math.min(deadline, eventTime + MAX_AGE_MS);
  }
  return deadline;
}

async function readOutbox(accountScopeId: string): Promise<TraceBatchOutboxFile> {
  try {
    const raw = JSON.parse(
      await fs.promises.readFile(outboxPath(accountScopeId), 'utf8'),
    ) as Partial<TraceBatchOutboxFile>;
    if (raw.schemaVersion !== OUTBOX_SCHEMA || raw.accountScopeId !== accountScopeId) {
      return emptyOutbox(accountScopeId);
    }
    const counters = raw.counters ?? emptyOutbox(accountScopeId).counters;
    return {
      schemaVersion: OUTBOX_SCHEMA,
      accountScopeId,
      items: Array.isArray(raw.items)
        ? raw.items
            .map((item) => normalizeItem(item, accountScopeId))
            .filter((item): item is TraceBatchOutboxItem => Boolean(item))
        : [],
      tombstones: Array.isArray(raw.tombstones)
        ? raw.tombstones
            .map((item) => normalizeTombstone(item, accountScopeId))
            .filter((item): item is TelemetryDeletionTombstone => Boolean(item))
        : [],
      counters: {
        queued: Math.max(0, Number(counters.queued) || 0),
        acknowledged: Math.max(0, Number(counters.acknowledged) || 0),
        duplicateAcknowledged: Math.max(0, Number(counters.duplicateAcknowledged) || 0),
        expired: Math.max(0, Number(counters.expired) || 0),
        saturationDropped: Math.max(0, Number(counters.saturationDropped) || 0),
        retries: Math.max(0, Number(counters.retries) || 0),
        tombstoneDiscarded: Math.max(0, Number(counters.tombstoneDiscarded) || 0),
      },
    };
  } catch {
    return emptyOutbox(accountScopeId);
  }
}

async function writeOutbox(value: TraceBatchOutboxFile): Promise<void> {
  const filePath = outboxPath(value.accountScopeId);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') await fs.promises.chmod(temp, 0o600).catch(() => undefined);
  await fs.promises.rename(temp, filePath);
}

async function withAccountLock<T>(accountScopeId: string, work: () => Promise<T>): Promise<T> {
  const prior = mutationTails.get(accountScopeId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationTails.set(accountScopeId, tail);
  await prior.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (mutationTails.get(accountScopeId) === tail) mutationTails.delete(accountScopeId);
  }
}

function serializedBytes(value: TraceBatchOutboxFile): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function pruneExpired(value: TraceBatchOutboxFile, now: number): number {
  const before = value.items.length;
  value.items = value.items.filter((item) => item.expiresAt > now);
  const removed = before - value.items.length;
  value.counters.expired += removed;
  return removed;
}

function trimSaturation(value: TraceBatchOutboxFile): number {
  let removed = 0;
  while (
    value.items.length > 0 &&
    (value.items.length > MAX_ITEMS_PER_ACCOUNT || serializedBytes(value) > MAX_BYTES_PER_ACCOUNT)
  ) {
    value.items.shift();
    removed += 1;
  }
  value.counters.saturationDropped += removed;
  return removed;
}

function retryDelayMs(attempts: number, random: () => number): number {
  const exponential = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts)));
  return exponential + Math.floor(Math.max(0, Math.min(1, random())) * exponential * 0.25);
}

export async function enqueueStudioTraceBatch(input: {
  accountScopeId: string;
  batch: StudioTraceBatch;
  now?: number;
}): Promise<{
  queued: boolean;
  deduplicated: boolean;
  tombstoned: boolean;
  pending: number;
  expired: number;
  saturationDropped: number;
}> {
  const accountScopeId = cleanAccount(input.accountScopeId);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  if (!accountScopeId || !/^[0-9a-f]{64}$/.test(input.batch.batchId)) {
    return {
      queued: false,
      deduplicated: false,
      tombstoned: false,
      pending: 0,
      expired: 0,
      saturationDropped: 0,
    };
  }
  return withAccountLock(accountScopeId, async () => {
    const value = await readOutbox(accountScopeId);
    const expired = pruneExpired(value, now);
    const candidate: TraceBatchOutboxItem = {
      batchId: input.batch.batchId,
      accountScopeId,
      batch: input.batch,
      createdAt: now,
      expiresAt: batchRetentionDeadline(input.batch, now + MAX_AGE_MS),
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
    };
    if (value.tombstones.some((tombstone) => tombstoneMatchesItem(candidate, tombstone))) {
      value.counters.tombstoneDiscarded += 1;
      await writeOutbox(value);
      return {
        queued: false,
        deduplicated: false,
        tombstoned: true,
        pending: value.items.length,
        expired,
        saturationDropped: 0,
      };
    }
    const deduplicated = value.items.some((item) => item.batchId === input.batch.batchId);
    if (!deduplicated) {
      value.items.push(candidate);
      value.counters.queued += 1;
    }
    const saturationDropped = trimSaturation(value);
    await writeOutbox(value);
    return {
      queued: true,
      deduplicated,
      tombstoned: false,
      pending: value.items.length,
      expired,
      saturationDropped,
    };
  });
}

/** Flush only one authenticated account partition; credentials are resolved by the caller for that account. */
export async function flushStudioTraceOutbox(input: {
  accountScopeId: string;
  upload: (item: TraceBatchOutboxItem) => Promise<TraceBatchUploadAck>;
  now?: number;
  random?: () => number;
}): Promise<{
  accepted: number;
  duplicateAcknowledged: number;
  retried: number;
  pending: number;
  expired: number;
}> {
  const accountScopeId = cleanAccount(input.accountScopeId);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const random = input.random ?? Math.random;
  if (!accountScopeId) {
    return { accepted: 0, duplicateAcknowledged: 0, retried: 0, pending: 0, expired: 0 };
  }
  return withAccountLock(accountScopeId, async () => {
    const value = await readOutbox(accountScopeId);
    const expired = pruneExpired(value, now);
    const queuedBeforeTombstones = value.items.length;
    value.items = value.items.filter(
      (item) => !value.tombstones.some((tombstone) => tombstoneMatchesItem(item, tombstone)),
    );
    value.counters.tombstoneDiscarded += queuedBeforeTombstones - value.items.length;
    let accepted = 0;
    let duplicateAcknowledged = 0;
    let retried = 0;
    const retained: TraceBatchOutboxItem[] = [];
    let attempted = 0;
    for (const item of value.items) {
      if (attempted >= MAX_FLUSH_ITEMS || item.nextAttemptAt > now) {
        retained.push(item);
        continue;
      }
      attempted += 1;
      let ack: TraceBatchUploadAck;
      try {
        ack = await input.upload(item);
      } catch {
        ack = { ok: false, retryable: true };
      }
      if (ack.ok) {
        accepted += ack.status === 'accepted' ? 1 : 0;
        duplicateAcknowledged += ack.status === 'duplicate' ? 1 : 0;
        value.counters.acknowledged += 1;
        if (ack.status === 'duplicate') value.counters.duplicateAcknowledged += 1;
        continue;
      }
      if (!ack.retryable) {
        // Deterministic policy/schema rejection cannot succeed on replay. It is
        // dropped from the retry queue but remains observable in counters/logs.
        value.counters.saturationDropped += 1;
        continue;
      }
      const attempts = item.attempts + 1;
      retained.push({
        ...item,
        attempts,
        lastAttemptAt: now,
        nextAttemptAt: now + retryDelayMs(attempts, random),
      });
      retried += 1;
      value.counters.retries += 1;
    }
    value.items = retained;
    await writeOutbox(value);
    return { accepted, duplicateAcknowledged, retried, pending: retained.length, expired };
  });
}

function tombstoneMatchesItem(
  item: TraceBatchOutboxItem,
  tombstone: Readonly<TelemetryDeletionTombstone>,
): boolean {
  if (item.accountScopeId !== tombstone.accountScopeId) return false;
  if (tombstone.grantId) return false;
  if (tombstone.userId && tombstone.userId !== tombstone.accountScopeId) return false;

  // Invalid legacy queue items cannot establish a safe environment or scope.
  // Discarding them is the fail-closed choice once their account is tombstoned.
  if (item.batch.spans.length === 0) return true;
  return item.batch.spans.some((span) => {
    if (span.resource.deploymentEnvironment !== tombstone.environment) return false;
    if (tombstone.runId && span.runId !== tombstone.runId) return false;
    if (tombstone.traceId && span.traceId !== tombstone.traceId) return false;
    if (tombstone.sessionId && span.sessionId !== tombstone.sessionId) return false;
    return true;
  });
}

function tombstoneCoversOutboxSelector(
  existing: Readonly<TelemetryDeletionTombstone>,
  candidate: Readonly<TelemetryDeletionTombstone>,
): boolean {
  if (existing.accountScopeId !== candidate.accountScopeId) return false;
  if (existing.environment !== candidate.environment || existing.grantId) return false;
  if (existing.userId && existing.userId !== existing.accountScopeId) return false;
  for (const key of ['runId', 'traceId', 'sessionId'] as const) {
    if (existing[key] && existing[key] !== candidate[key]) return false;
  }
  return true;
}

function compactOutboxTombstonesFailClosed(
  tombstones: readonly TelemetryDeletionTombstone[],
): TelemetryDeletionTombstone[] {
  const broadByEnvironment = new Map<string, TelemetryDeletionTombstone>();
  for (const tombstone of tombstones) {
    // Grant-only deletion does not match the low-sensitivity trace outbox.
    if (tombstone.grantId || broadByEnvironment.has(tombstone.environment)) continue;
    broadByEnvironment.set(tombstone.environment, {
      tombstoneId: tombstone.tombstoneId,
      requestId: tombstone.requestId,
      accountScopeId: tombstone.accountScopeId,
      environment: tombstone.environment,
      createdAt: tombstone.createdAt,
    });
  }
  return [...broadByEnvironment.values()];
}

/**
 * Remove tombstoned batches under the same account lock used by enqueue/flush.
 * A whole batch is discarded when any span matches so a mixed batch can never
 * re-export a deleted record after restart or acknowledgement loss.
 */
export async function purgeStudioTraceOutboxByTombstone(input: {
  authoritativeAccountScopeId: string;
  tombstone: Readonly<TelemetryDeletionTombstone>;
  now?: number;
}): Promise<{ removed: number; pending: number; expired: number; scopeMismatch: boolean }> {
  const accountScopeId = cleanAccount(input.authoritativeAccountScopeId);
  if (!accountScopeId || accountScopeId !== cleanAccount(input.tombstone.accountScopeId)) {
    // Do not inspect the requested partition on a scope mismatch; this keeps
    // foreign and nonexistent partitions indistinguishable to the caller.
    return { removed: 0, pending: 0, expired: 0, scopeMismatch: true };
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  return withAccountLock(accountScopeId, async () => {
    const value = await readOutbox(accountScopeId);
    const expired = pruneExpired(value, now);
    const normalized = normalizeTombstone(input.tombstone, accountScopeId);
    if (!normalized) throw new TypeError('invalid outbox tombstone');
    const alreadyStored = value.tombstones.some(
      (item) =>
        item.tombstoneId === normalized.tombstoneId ||
        item.requestId === normalized.requestId ||
        tombstoneCoversOutboxSelector(item, normalized),
    );
    if (!alreadyStored && !normalized.grantId) {
      value.tombstones.push(normalized);
      if (value.tombstones.length > MAX_TOMBSTONES_PER_ACCOUNT) {
        // Capacity pressure must shed telemetry, never a deletion guard. A
        // broad per-environment barrier is conservative but prevents any
        // later enqueue/restore from re-exporting deleted data.
        value.tombstones = compactOutboxTombstonesFailClosed(value.tombstones);
      }
    }
    const before = value.items.length;
    value.items = value.items.filter(
      (item) => !value.tombstones.some((tombstone) => tombstoneMatchesItem(item, tombstone)),
    );
    const removed = before - value.items.length;
    value.counters.tombstoneDiscarded += removed;
    await writeOutbox(value);
    return {
      removed,
      pending: value.items.length,
      expired,
      scopeMismatch: false,
    };
  });
}

export function studioTraceOutboxPathForTest(accountScopeId: string): string {
  return outboxPath(cleanAccount(accountScopeId));
}