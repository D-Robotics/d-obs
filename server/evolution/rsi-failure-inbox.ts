import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PLATFORM_OPERATION_METADATA } from '../monitoring/platform-operation-metadata.js';
import { RsiCasesSchema, RsiInputSchema, RsiReasonSchema, RsiSliceSchema, type RsiCase } from './rsi-replay.js';

const MAX_RECORDS = 500;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.string().datetime();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationId = z.string().min(1).max(512).regex(/^(GET|POST|PUT|PATCH|DELETE) \/api\/ops\/observability\/[A-Za-z0-9_/.:\-]+$/);
const isFailure = (value: { input: z.infer<typeof RsiInputSchema>; receiptFailure?: true }) =>
  value.input.errorCode !== undefined || (value.input.httpStatus !== undefined && (value.input.httpStatus >= 400 || value.receiptFailure === true));
const classificationSchema = z.object({ loopId: uuid, activeVersionId: uuid, reason: RsiReasonSchema }).strict();
const recordInputSchema = z.object({ operationId, input: RsiInputSchema, receiptFailure: z.literal(true).optional(),
  executionOutcome: z.enum(['failed', 'unknown']).default('failed'), suggestedReason: RsiReasonSchema.optional(), classification: classificationSchema.optional(),
}).strict().refine(isFailure, 'A failure requires a known error code, error HTTP status or explicit failed receipt with a status');
const mutationInputSchema = z.object({ expectedRevision: revision }).strict();
const confirmInputSchema = mutationInputSchema.extend({ expectedReason: RsiReasonSchema, slice: RsiSliceSchema }).strict();
const bindInputSchema = mutationInputSchema.extend({ loopId: uuid.nullable() }).strict();
const casesInputSchema = mutationInputSchema.extend({ evidenceIds: z.array(uuid).min(3).max(200) }).strict();
const recordSchema = z.object({
  id: uuid, source: z.literal('platform_operation'), operationId, input: RsiInputSchema, receiptFailure: z.literal(true).optional(),
  executionOutcome: z.enum(['failed', 'unknown']), fingerprint: sha, observedAt: stamp, lastSeenAt: stamp,
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.enum(['unconfirmed', 'confirmed', 'excluded']),
  suggestedReason: RsiReasonSchema.nullable(), classification: classificationSchema.nullable(),
  expectedReason: RsiReasonSchema.nullable(), slice: RsiSliceSchema.nullable(), confirmedAt: stamp.nullable(),
}).strict().refine(isFailure, 'A failure requires a known error code, error HTTP status or explicit failed receipt with a status');
const stateSchema = z.object({ schemaVersion: z.literal(1), ownerHash: sha, revision,
  activeLoopId: uuid.nullable(), records: z.array(recordSchema).max(MAX_RECORDS),
}).strict();
const envelopeSchema = z.object({ sha256: sha, payload: stateSchema }).strict();
const lockSchema = z.object({ pid: z.number().int().positive(), nonce: uuid, createdAt: stamp }).strict();
type State = z.infer<typeof stateSchema>;
type Lock = z.infer<typeof lockSchema>;
export type RsiFailureRecord = z.infer<typeof recordSchema>;
export interface RsiEvidenceProvenance { caseId: string; evidenceId: string; fingerprint: string; operationId: string; observedAt: string; confirmedAt: string }
export interface RsiFailureInboxOverview {
  revision: number; activeLoopId: string | null; records: RsiFailureRecord[];
  counts: { total: number; unconfirmed: number; confirmed: number; excluded: number; observations: number };
  capabilities: { source: 'platform_operation'; labelAuthority: 'operator'; maxRecordsPerOwner: number; maxCasesPerLoop: number; storesRawPayloads: false; diagnosisOnly: true };
}
export interface RsiFailureInboxOptions { stateDir?: string; rootDir?: string; operationIds?: Iterable<string> }
export class RsiFailureInboxError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'RsiFailureInboxError'; }
}
function fail(code: string, status = 400): never { throw new RsiFailureInboxError('rsi_inbox_' + code, status); }
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const queues = new Map<string, Promise<void>>();
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const iso = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function ownerHash(owner: string): string {
  if (typeof owner !== 'string' || !owner.trim() || owner !== owner.trim() || owner.length > 512 || /[\u0000-\u001f\u007f]/.test(owner)) fail('identity_required', 401);
  return createHash('sha256').update(owner).digest('hex');
}
function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value); if (!result.success) fail('invalid_input'); return result.data;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !codeIs(error, 'ESRCH'); }
}
function fingerprint(item: Pick<RsiFailureRecord, 'operationId' | 'input' | 'executionOutcome'>): string {
  return hash({ operationId: item.operationId, input: item.input, executionOutcome: item.executionOutcome });
}

/** Only finite error categories and reviewed operation templates enter this owner-scoped inbox. */
export class RsiFailureInboxService {
  readonly stateDir: string;
  private readonly operationIds: Set<string>;
  constructor(options: RsiFailureInboxOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? options.rootDir ?? process.env.RDK_RSI_FAILURE_STATE_DIR ?? join(homedir(), '.local', 'state', 'd-obs', 'rsi-failures'));
    this.operationIds = new Set(options.operationIds ?? Object.keys(PLATFORM_OPERATION_METADATA));
    if ([...this.operationIds].some((id) => !operationId.safeParse(id).success)) fail('invalid_operation_registry');
  }
  async overview(owner: string): Promise<RsiFailureInboxOverview> { return clone(this.summary(await this.read(ownerHash(owner)))); }
  async record(owner: string, input: unknown): Promise<RsiFailureRecord> {
    const parsed = parseInput(recordInputSchema, input);
    if (!this.operationIds.has(parsed.operationId)) fail('unregistered_operation');
    return this.mutate(owner, (state) => {
      if (parsed.classification && parsed.classification.loopId !== state.activeLoopId) fail('binding_required', 409);
      const key = fingerprint(parsed); const now = iso();
      const existing = state.records.find((item) => item.fingerprint === key);
      if (existing) {
        if (existing.count >= Number.MAX_SAFE_INTEGER) fail('count_limit', 409);
        existing.count += 1; existing.lastSeenAt = now;
        existing.suggestedReason = parsed.suggestedReason ?? null; existing.classification = clone(parsed.classification ?? null);
        if (parsed.receiptFailure === true) existing.receiptFailure = true;
        this.touch(state); return existing;
      }
      if (state.records.length >= MAX_RECORDS) {
        // Preserve confirmed examples. Evict the least recently seen non-confirmed observation.
        const evictable = state.records.filter((item) => item.status !== 'confirmed').sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0];
        if (!evictable) fail('record_limit', 409);
        state.records.splice(state.records.findIndex((item) => item.id === evictable.id), 1);
      }
      const item: RsiFailureRecord = { id: randomUUID(), source: 'platform_operation', operationId: parsed.operationId,
        input: clone(parsed.input), executionOutcome: parsed.executionOutcome, fingerprint: key, observedAt: now, lastSeenAt: now,
        ...(parsed.receiptFailure === true ? { receiptFailure: true as const } : {}),
        count: 1, status: 'unconfirmed', suggestedReason: parsed.suggestedReason ?? null, classification: clone(parsed.classification ?? null),
        expectedReason: null, slice: null, confirmedAt: null };
      state.records.push(item); this.touch(state); return item;
    });
  }
  async confirm(owner: string, id: string, input: unknown): Promise<RsiFailureRecord> {
    const parsed = parseInput(confirmInputSchema, input);
    return this.mutate(owner, (state) => {
      const item = this.item(state, id); this.cas(state, parsed.expectedRevision);
      if (item.status !== 'unconfirmed') fail('record_finalized', 409);
      item.status = 'confirmed'; item.expectedReason = parsed.expectedReason; item.slice = parsed.slice; item.confirmedAt = iso();
      this.touch(state); return item;
    });
  }
  async exclude(owner: string, id: string, input: unknown): Promise<RsiFailureRecord> {
    const parsed = parseInput(mutationInputSchema, input);
    return this.mutate(owner, (state) => {
      const item = this.item(state, id); this.cas(state, parsed.expectedRevision);
      if (item.status === 'excluded') fail('record_finalized', 409);
      item.status = 'excluded'; this.touch(state); return item;
    });
  }
  async bindLoop(owner: string, input: unknown): Promise<RsiFailureInboxOverview> {
    const parsed = parseInput(bindInputSchema, input);
    return this.mutate(owner, (state) => {
      this.cas(state, parsed.expectedRevision); state.activeLoopId = parsed.loopId; this.touch(state); return this.summary(state);
    });
  }
  async buildCases(owner: string, input: unknown): Promise<{ cases: RsiCase[]; provenance: RsiEvidenceProvenance[] }> {
    const parsed = parseInput(casesInputSchema, input);
    const state = await this.read(ownerHash(owner)); this.cas(state, parsed.expectedRevision);
    if (new Set(parsed.evidenceIds).size !== parsed.evidenceIds.length) fail('duplicate_evidence');
    const records = parsed.evidenceIds.map((id) => this.item(state, id));
    if (records.some((item) => item.status !== 'confirmed')) fail('confirmation_required', 409);
    if (!['frozen', 'adaptive', 'holdout'].every((slice) => records.some((item) => item.slice === slice))) fail('slices_required');
    const cases: RsiCase[] = records.map((item) => ({ id: 'evidence.' + item.id, source: 'operator', input: clone(item.input), expectedReason: item.expectedReason!, slice: item.slice! }));
    const checked = RsiCasesSchema.safeParse(cases); if (!checked.success) fail('invalid_case_isolation');
    const provenance = records.map((item) => ({ caseId: 'evidence.' + item.id, evidenceId: item.id, fingerprint: item.fingerprint,
      operationId: item.operationId, observedAt: item.observedAt, confirmedAt: item.confirmedAt! }));
    // Labels enter the replay only through the explicit confirmation above; suggestions never become truth.
    return clone({ cases: checked.data, provenance });
  }
  private summary(state: State): RsiFailureInboxOverview {
    return { revision: state.revision, activeLoopId: state.activeLoopId, records: [...state.records].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
      counts: { total: state.records.length, unconfirmed: state.records.filter((item) => item.status === 'unconfirmed').length,
        confirmed: state.records.filter((item) => item.status === 'confirmed').length, excluded: state.records.filter((item) => item.status === 'excluded').length,
        observations: state.records.reduce((sum, item) => Math.min(Number.MAX_SAFE_INTEGER, sum + item.count), 0) },
      capabilities: { source: 'platform_operation', labelAuthority: 'operator', maxRecordsPerOwner: MAX_RECORDS, maxCasesPerLoop: 200, storesRawPayloads: false, diagnosisOnly: true } };
  }
  private item(state: State, id: string): RsiFailureRecord {
    if (!uuid.safeParse(id).success) fail('not_found', 404);
    const item = state.records.find((record) => record.id === id); if (!item) fail('not_found', 404); return item;
  }
  private cas(state: State, expected: number) { if (state.revision !== expected) fail('stale_revision', 409); }
  private touch(state: State) { if (state.revision >= Number.MAX_SAFE_INTEGER) fail('revision_limit', 409); state.revision += 1; }
  private validate(state: State, expectedOwner: string) {
    if (state.ownerHash !== expectedOwner || new Set(state.records.map((item) => item.id)).size !== state.records.length || new Set(state.records.map((item) => item.fingerprint)).size !== state.records.length) fail('corrupt_state', 503);
    for (const item of state.records) {
      if (!this.operationIds.has(item.operationId) || fingerprint(item) !== item.fingerprint || item.lastSeenAt < item.observedAt) fail('corrupt_state', 503);
      const confirmed = item.expectedReason !== null && item.slice !== null && item.confirmedAt !== null;
      const unlabeled = item.expectedReason === null && item.slice === null && item.confirmedAt === null;
      if ((item.status === 'confirmed' && !confirmed) || (item.status === 'unconfirmed' && !unlabeled) || (!confirmed && !unlabeled) || (item.confirmedAt !== null && item.confirmedAt < item.observedAt)) fail('corrupt_state', 503);
    }
  }
  private async read(owner: string): Promise<State> {
    try {
      const directory = await lstat(this.stateDir); if (!directory.isDirectory() || directory.isSymbolicLink()) fail('unsafe_state_path', 503);
      const file = await open(join(this.stateDir, owner + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat(); if (!info.isFile() || info.size > MAX_STATE_BYTES) fail('corrupt_state', 503);
        const envelope = envelopeSchema.safeParse(JSON.parse(await file.readFile('utf8')));
        if (!envelope.success || hash(envelope.data.payload) !== envelope.data.sha256) fail('corrupt_state', 503);
        this.validate(envelope.data.payload, owner); return envelope.data.payload;
      } finally { await file.close(); }
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return { schemaVersion: 1, ownerHash: owner, revision: 1, activeLoopId: null, records: [] };
      if (error instanceof RsiFailureInboxError) throw error; fail('corrupt_state', 503);
    }
  }
  private async save(state: State) {
    this.validate(state, state.ownerHash);
    const text = JSON.stringify({ sha256: hash(state), payload: state }); if (Buffer.byteLength(text) > MAX_STATE_BYTES) fail('state_quota', 409);
    const target = join(this.stateDir, state.ownerHash + '.json'); const temporary = join(this.stateDir, '.' + state.ownerHash + '.' + randomUUID() + '.tmp');
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, target); await chmod(target, 0o600);
      const directory = await open(this.stateDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; }); }
  }
  private async lockRecord(path: string): Promise<Lock | null> {
    try {
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) fail('unsafe_lock', 503);
      return lockSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) { if (codeIs(error, 'ENOENT')) return null; if (error instanceof RsiFailureInboxError) throw error; fail('unsafe_lock', 503); }
  }
  private async exclusive(path: string, record: Lock): Promise<boolean> {
    const temporary = path + '.' + record.nonce + '.tmp';
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      // The hard link is exclusive and makes an already complete lock record visible atomically.
      try { await link(temporary, path); return true; } catch (error) { if (codeIs(error, 'EEXIST')) return false; throw error; }
    } finally { await unlink(temporary).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; }); }
  }
  private async release(path: string, nonce: string) { const record = await this.lockRecord(path); if (record?.nonce === nonce) await unlink(path); }
  private async lock(owner: string): Promise<() => Promise<void>> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const info = await lstat(this.stateDir);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_state_path', 503); await chmod(this.stateDir, 0o700);
    const lockPath = join(this.stateDir, owner + '.lock'); const guardPath = join(this.stateDir, owner + '.guard'); const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const guard: Lock = { pid: process.pid, nonce: randomUUID(), createdAt: iso() };
      if (!(await this.exclusive(guardPath, guard))) {
        const held = await this.lockRecord(guardPath); if (held && !alive(held.pid)) fail('stale_lock', 503); await pause(20); continue;
      }
      let acquired: Lock | null = null;
      try {
        const held = await this.lockRecord(lockPath); if (held && !alive(held.pid)) await this.release(lockPath, held.nonce);
        const record: Lock = { pid: process.pid, nonce: randomUUID(), createdAt: iso() };
        if (await this.exclusive(lockPath, record)) acquired = record;
      } finally { await this.release(guardPath, guard.nonce); }
      if (acquired) { const nonce = acquired.nonce; return () => this.release(lockPath, nonce); }
      await pause(20);
    }
    fail('writer_busy', 409);
  }
  private async mutate<T>(owner: string, operation: (state: State) => T): Promise<T> {
    const digest = ownerHash(owner); const key = join(this.stateDir, digest); const previous = queues.get(key) ?? Promise.resolve();
    let complete!: () => void; const pending = new Promise<void>((done) => { complete = done; }); const tail = previous.then(() => pending); queues.set(key, tail);
    await previous;
    try { const release = await this.lock(digest); try { const state = await this.read(digest); const result = operation(state); await this.save(state); return clone(result); } finally { await release(); } }
    finally { complete(); if (queues.get(key) === tail) queues.delete(key); }
  }
}
export function createRsiFailureInboxService(options: RsiFailureInboxOptions = {}) { return new RsiFailureInboxService(options); }
