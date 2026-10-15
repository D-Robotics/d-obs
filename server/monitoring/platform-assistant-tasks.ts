/** Durable, owner-scoped assistant turns. Execution leases never replay side effects. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { platformAssistantHistoryContent, type PlatformAssistantResult, type PlatformAssistantProposal,
  type PlatformAssistantOperationResult } from '../observability/platform-assistant.js';
import { validatePlatformAssistantContext, type PlatformAssistantWorkContext } from '../observability/platform-assistant-context.js';
import { redactPlatformAssistantText } from '../observability/platform-assistant-redaction.js';

const MAX_TASKS = 200;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const EXECUTION_LEASE_MS = 15 * 60_000;
const PROCESS_INSTANCE = randomUUID();
const queues = new Map<string, Promise<void>>();
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stamp = z.string().datetime();
const statusSchema = z.enum(['running', 'awaiting_confirmation', 'completed', 'failed', 'interrupted']);
const feedbackSchema = z.enum(['helpful', 'not_helpful']);
const contextSchema = z.record(z.unknown());
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8_000) }).strict()).max(12);
const operationSchema = z.object({ id: z.string().min(1).max(512), description: z.string().max(500),
  status: z.number().int().min(100).max(599), ok: z.boolean(), data: z.unknown() }).strict();
const proposalMetadataSchema = z.object({ operationId: z.string().min(1).max(512), description: z.string().max(500),
  preview: z.string().max(32_000), expiresAt: z.number().int().positive() }).strict();
const proposalSchema = proposalMetadataSchema.extend({ token: z.string().min(1).max(32_000) });
const responseSchema = z.object({ reply: z.string().max(8_000), operations: z.array(operationSchema).max(6),
  historyContent: z.string().max(8_000), proposal: proposalMetadataSchema.optional() }).strict();
const responseInputSchema = z.object({ reply: z.string().max(32_000), operations: z.array(operationSchema).max(6),
  historyContent: z.string().optional(), proposal: proposalSchema.optional(), diagnostics: z.unknown().optional() }).strict();
const leaseSchema = z.object({ pid: z.number().int().positive(), processBirth: z.string().min(1).max(128), instance: uuid, nonce: uuid,
  expiresAt: z.number().int().positive() }).strict();
const taskSchema = z.object({ id: uuid, revision, goal: z.string().min(1).max(8_000), context: contextSchema,
  status: statusSchema, createdAt: stamp, updatedAt: stamp, history: historySchema,
  response: responseSchema.nullable(), pending: proposalSchema.nullable(), lease: leaseSchema.nullable(),
  mutationDigests: z.array(digest).max(64).default([]),
  feedback: z.object({ label: feedbackSchema, recordedAt: stamp }).strict().nullable(), error: z.string().max(160).nullable() }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), scopeHash: digest, tasks: z.array(taskSchema).max(MAX_TASKS) }).strict();
const envelopeSchema = z.object({ sha256: digest, payload: stateSchema }).strict();
const lockSchema = z.object({ pid: z.number().int().positive(), processBirth: z.string().min(1).max(128), nonce: uuid }).strict();
type StoredTask = z.infer<typeof taskSchema>;
type State = z.infer<typeof stateSchema>;
type Lock = z.infer<typeof lockSchema>;
export type PlatformAssistantTaskStatus = z.infer<typeof statusSchema>;
export type PlatformAssistantTaskFeedback = z.infer<typeof feedbackSchema>;
export type PlatformAssistantTaskHistory = z.infer<typeof historySchema>;
export type PlatformAssistantTaskResponse = z.infer<typeof responseSchema>;
export type PlatformAssistantTaskDetail = Omit<StoredTask, 'pending' | 'lease' | 'context' | 'mutationDigests'> & { context: PlatformAssistantWorkContext };
export type PlatformAssistantTaskSummary = Pick<PlatformAssistantTaskDetail, 'id' | 'revision' | 'goal' | 'status' | 'createdAt' | 'updatedAt' | 'feedback' | 'error'> & {
  operationCount: number; failedOperationCount: number; confirmationExpiresAt: number | null;
};
export interface PlatformAssistantTaskOptions { stateDir?: string }
export class PlatformAssistantTaskError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'PlatformAssistantTaskError'; }
}
function fail(code: string, status = 400): never { throw new PlatformAssistantTaskError('platform_assistant_task_' + code, status); }
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const iso = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value); if (!result.success) fail('invalid_input'); return result.data;
}
function scopeHash(scope: string): string {
  if (typeof scope !== 'string' || !scope || scope !== scope.trim() || scope.length > 2_048 || /[\u0000-\u001f\u007f]/.test(scope)) fail('identity_required', 401);
  return hash(scope);
}
function workContext(value: unknown): PlatformAssistantWorkContext {
  try { return validatePlatformAssistantContext(value); } catch { fail('invalid_context'); }
}
function processBirth(pid: number): string | null {
  try { process.kill(pid, 0); } catch (error) { if (errno(error, 'ESRCH')) return null; }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!started || !/^\d+$/.test(started) || !boot) fail('process_identity_unavailable', 503);
      return boot + ':' + started;
    }
    const birth = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000,
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!birth) return null; return birth;
  } catch (error) {
    try { process.kill(pid, 0); } catch (probe) { if (errno(probe, 'ESRCH')) return null; }
    fail('process_identity_unavailable', 503);
  }
}
const PROCESS_BIRTH = processBirth(process.pid) ?? fail('process_identity_unavailable', 503);
function alive(holder: { pid: number; processBirth: string }): boolean {
  return holder.pid === process.pid ? holder.processBirth === PROCESS_BIRTH : processBirth(holder.pid) === holder.processBirth;
}
function equalToken(expected: string, submitted: string): boolean {
  const a = Buffer.from(expected); const b = Buffer.from(submitted); return a.length === b.length && timingSafeEqual(a, b);
}
const RECEIPT_MARKER = '\n安全操作回执：';
function credentialValues(value: unknown): Set<string> {
  const secrets = new Set<string>(); const seen = new WeakSet<object>(); let remaining = 20_000;
  const visit = (item: unknown, sensitive = false, depth = 0): void => {
    if (--remaining < 0 || depth > 20) return;
    if (typeof item === 'string') { if (sensitive && item) secrets.add(item); return; }
    if (!item || typeof item !== 'object' || seen.has(item)) return; seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      visit(child, sensitive || /^(?:token|apikeys?|password|passwd|secrets?|authorization|cookies?|credentials?|accesskey|secretkey|privatekey|clientsecret|accesstoken|refreshtoken|probetoken|ingesttoken|sessiontoken)$/.test(normalized)
        || /(?:apikey|password|secret|authorization|cookie|accesstoken|refreshtoken|probetoken|ingesttoken)$/.test(normalized), depth + 1);
    }
  };
  visit(value); return secrets;
}
function scrubText(text: string, secrets: ReadonlySet<string>): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  return redactPlatformAssistantText(result);
}
/** Reuse the same credential filtering and proof-aware projection as model history. */
function safeText(text: string, operations: PlatformAssistantOperationResult[] = []): string {
  return scrubText(text, credentialValues(operations)).slice(0, 8_000);
}
function safePreview(text: string, operations: PlatformAssistantOperationResult[]): string {
  const safe = scrubText(text, credentialValues(operations)); if (safe.length > 32_000) fail('preview_too_large'); return safe;
}
function safeData(value: unknown, additionalSecrets: ReadonlySet<string> = new Set()): unknown {
  const secrets = new Set([...credentialValues(value), ...additionalSecrets]);
  const seen = new WeakSet<object>(); let remaining = 20_000;
  const scrub = (item: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 20) return { truncated: true };
    if (typeof item === 'string') return scrubText(item, secrets);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return { truncated: true }; seen.add(item);
    return Array.isArray(item) ? item.map((child) => scrub(child, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child, depth + 1)]));
  };
  const receipt = { id: 'assistant-task-snapshot', description: '', ok: true, status: 200, data: scrub(value) };
  const safe = platformAssistantHistoryContent('', [receipt]);
  const parsed = JSON.parse(safe.slice(safe.lastIndexOf(RECEIPT_MARKER) + RECEIPT_MARKER.length));
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  return Array.isArray(items) && items[0] && Object.hasOwn(items[0], 'data') ? items[0].data : { truncated: true };
}
function safeHistory(history: PlatformAssistantTaskHistory, operations: PlatformAssistantOperationResult[]): PlatformAssistantTaskHistory {
  return history.slice(-12).map((item) => ({ role: item.role, content: safeText(item.content, operations) }));
}
function safeResponse(response: PlatformAssistantResult): PlatformAssistantTaskResponse {
  const secrets = credentialValues(response.operations);
  const operations = response.operations.map((item) => ({ id: safeText(item.id, response.operations),
    description: safeText(item.description, response.operations), status: item.status, ok: item.ok, data: safeData(item.data, secrets) }));
  const reply = safeText(response.reply, response.operations);
  const proposal = response.proposal && { operationId: safeText(response.proposal.operationId, response.operations),
    description: safeText(response.proposal.description, response.operations), preview: safePreview(response.proposal.preview, response.operations), expiresAt: response.proposal.expiresAt };
  return parse(responseSchema, { reply, operations, historyContent: platformAssistantHistoryContent(reply, operations), ...(proposal ? { proposal } : {}) });
}

/** The caller derives scope from authenticated identity plus tenant/view, never client input. */
export class PlatformAssistantTaskService {
  readonly stateDir: string;
  constructor(options: PlatformAssistantTaskOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env.RDK_PLATFORM_ASSISTANT_TASK_STATE_DIR ?? join(homedir(), '.local', 'state', 'd-obs', 'assistant-tasks'));
  }
  async create(scope: string, input: { goal: string; context?: PlatformAssistantWorkContext; history?: PlatformAssistantTaskHistory }): Promise<PlatformAssistantTaskDetail> {
    const checked = parse(z.object({ goal: z.string().trim().min(1).max(8_000), context: contextSchema.optional(), history: historySchema.optional() }).strict(), input);
    const context = workContext(checked.context ?? {});
    return this.transaction(scope, (state) => {
      if (state.tasks.length >= MAX_TASKS) fail('quota_exceeded', 409);
      const now = iso(); const goal = safeText(checked.goal);
      const item: StoredTask = { id: randomUUID(), revision: 1, goal, context: parse(contextSchema, safeData(context)),
        status: 'running', createdAt: now, updatedAt: now, history: safeHistory(checked.history ?? [], []),
        response: null, pending: null, lease: this.lease(), mutationDigests: [], feedback: null, error: null };
      state.tasks.push(item); return this.detail(item);
    }, true);
  }
  async list(scope: string): Promise<{ tasks: PlatformAssistantTaskSummary[]; stats: ReturnType<PlatformAssistantTaskService['stats']> }> {
    return this.transaction(scope, (state) => ({ tasks: [...state.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => this.summary(item)), stats: this.stats(state) }));
  }
  async get(scope: string, id: string): Promise<PlatformAssistantTaskDetail> {
    return this.transaction(scope, (state) => this.detail(this.item(state, id)));
  }
  async claim(scope: string, id: string, expectedRevision: number, context?: PlatformAssistantWorkContext): Promise<PlatformAssistantTaskDetail> {
    const checked = context === undefined ? undefined : workContext(context);
    return this.transaction(scope, (state) => {
      const item = this.item(state, id); this.cas(item, expectedRevision);
      if (item.status === 'running') fail('busy', 409);
      if (item.pending && item.pending.expiresAt > Date.now()) fail('confirmation_required', 409);
      item.status = 'running'; item.pending = null; item.lease = this.lease(); item.error = null; item.feedback = null;
      // A new explicit user turn may intentionally repeat an action after checking its state.
      item.mutationDigests = [];
      if (checked !== undefined) item.context = parse(contextSchema, safeData(checked));
      // Old confirmation metadata cannot be mistaken for the current turn's authorization.
      if (item.response) delete item.response.proposal;
      this.touch(item); return this.detail(item);
    }, true);
  }
  async finish(scope: string, id: string, expectedRevision: number, input: { response: PlatformAssistantResult; history?: PlatformAssistantTaskHistory; status?: Exclude<PlatformAssistantTaskStatus, 'running'> }): Promise<PlatformAssistantTaskDetail> {
    const checked = parse(z.object({ response: responseInputSchema, history: historySchema.optional(), status: statusSchema.exclude(['running']).optional() }).strict(), input);
    return this.transaction(scope, (state) => {
      const item = this.item(state, id); this.cas(item, expectedRevision);
      if (item.status !== 'running' || !item.lease || item.lease.pid !== process.pid || item.lease.instance !== PROCESS_INSTANCE) fail('not_claimed', 409);
      const response = checked.response as PlatformAssistantResult;
      const uncertain = response.operations.some((operation) => operation.data && typeof operation.data === 'object'
        && !Array.isArray(operation.data) && (operation.data as Record<string, unknown>).outcome === 'unknown');
      const status = checked.status ?? (uncertain ? 'interrupted' : response.proposal ? 'awaiting_confirmation' : response.operations.some((operation) => !operation.ok)
        || /platform_assistant_[a-z_]+/.test(response.reply) ? 'failed' : 'completed');
      if (uncertain && (status === 'completed' || status === 'awaiting_confirmation')) fail('invalid_status');
      if ((status === 'awaiting_confirmation') !== Boolean(response.proposal)) fail('invalid_status');
      item.response = safeResponse(response); item.status = status;
      item.history = safeHistory(checked.history ?? [...item.history, { role: 'assistant' as const, content: item.response.historyContent }].slice(-12), response.operations);
      item.goal = safeText(item.goal, response.operations); item.context = parse(contextSchema, safeData(item.context, credentialValues(response.operations)));
      item.pending = response.proposal ? { ...clone(item.response.proposal!), token: response.proposal.token } : null;
      item.lease = null; item.error = uncertain ? 'platform_assistant_task_outcome_unknown' : status === 'failed' ? 'platform_assistant_task_response_failed'
        : status === 'interrupted' ? 'platform_assistant_task_interrupted' : null;
      this.touch(item); return this.detail(item);
    }, true);
  }
  /** Server-only: routes must verify the token's exact principal authorization before exposing it. */
  async getPending(scope: string, id: string): Promise<PlatformAssistantProposal | null> {
    return this.transaction(scope, (state) => {
      const item = this.item(state, id); return item.status === 'awaiting_confirmation' && item.pending && item.pending.expiresAt > Date.now() ? clone(item.pending) : null;
    });
  }
  /** Server-only digests cover the current user turn across all subsequent confirmations. */
  async getMutationDigests(scope: string, id: string): Promise<string[]> {
    return this.transaction(scope, (state) => clone(this.item(state, id).mutationDigests));
  }
  /** Consume the exact stored confirmation BEFORE claiming API authorization or executing effects. */
  async claimConfirmation(scope: string, id: string, expectedRevision: number, token: string, mutationDigest?: string): Promise<{ task: PlatformAssistantTaskDetail; proposal: PlatformAssistantProposal }> {
    if (typeof token !== 'string' || !token || token.length > 32_000) fail('invalid_confirmation');
    if (mutationDigest !== undefined) parse(digest, mutationDigest);
    return this.transaction(scope, (state) => {
      const item = this.item(state, id); this.cas(item, expectedRevision);
      if (item.status !== 'awaiting_confirmation' || !item.pending) fail('confirmation_unavailable', 409);
      if (item.pending.expiresAt <= Date.now()) fail('confirmation_expired', 409);
      if (!equalToken(item.pending.token, token)) fail('invalid_confirmation', 403);
      if (mutationDigest !== undefined) {
        if (item.mutationDigests.includes(mutationDigest)) fail('duplicate_mutation', 409);
        if (item.mutationDigests.length >= 64) fail('mutation_limit', 409);
        // Reserve before downstream authorization/side effects; failures never authorize a replay.
        item.mutationDigests.push(mutationDigest);
      }
      const proposal = clone(item.pending); item.pending = null; item.status = 'running'; item.lease = this.lease(); item.error = null;
      if (item.response) delete item.response.proposal;
      this.touch(item); return { task: this.detail(item), proposal };
    }, true);
  }
  async feedback(scope: string, id: string, expectedRevision: number, label: PlatformAssistantTaskFeedback): Promise<PlatformAssistantTaskDetail> {
    parse(feedbackSchema, label);
    return this.transaction(scope, (state) => {
      const item = this.item(state, id); this.cas(item, expectedRevision);
      if (item.status === 'running' || !item.response) fail('feedback_unavailable', 409);
      item.feedback = { label, recordedAt: iso() }; this.touch(item); return this.detail(item);
    }, true);
  }
  async exportCases(scope: string) {
    return this.transaction(scope, (state) => ({ schemaVersion: 1 as const, source: 'actual_assistant_tasks' as const,
      labelAuthority: 'operator' as const, verification: 'not_evaluated' as const, exportedAt: iso(), stats: this.stats(state),
      cases: state.tasks.filter((item) => item.response).map((item) => ({ id: item.id, revision: item.revision, goal: item.goal, context: clone(item.context),
        status: item.status, history: clone(item.history), response: clone(item.response), feedback: clone(item.feedback), createdAt: item.createdAt, updatedAt: item.updatedAt,
        verification: 'not_evaluated' as const })) }));
  }
  private lease() { return { pid: process.pid, processBirth: PROCESS_BIRTH, instance: PROCESS_INSTANCE, nonce: randomUUID(), expiresAt: Date.now() + EXECUTION_LEASE_MS }; }
  private detail(item: StoredTask): PlatformAssistantTaskDetail {
    const { pending: _pending, lease: _lease, mutationDigests: _digests, ...result } = item; return clone(result) as PlatformAssistantTaskDetail;
  }
  private summary(item: StoredTask): PlatformAssistantTaskSummary {
    return { id: item.id, revision: item.revision, goal: item.goal, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt,
      feedback: clone(item.feedback), error: item.error, operationCount: item.response?.operations.length ?? 0,
      failedOperationCount: item.response?.operations.filter((operation) => !operation.ok).length ?? 0, confirmationExpiresAt: item.pending?.expiresAt ?? null };
  }
  private stats(state: State) {
    return { total: state.tasks.length, running: state.tasks.filter((item) => item.status === 'running').length,
      awaitingConfirmation: state.tasks.filter((item) => item.status === 'awaiting_confirmation').length,
      reportedCompleted: state.tasks.filter((item) => item.status === 'completed').length,
      failed: state.tasks.filter((item) => item.status === 'failed').length, interrupted: state.tasks.filter((item) => item.status === 'interrupted').length,
      helpful: state.tasks.filter((item) => item.feedback?.label === 'helpful').length,
      notHelpful: state.tasks.filter((item) => item.feedback?.label === 'not_helpful').length, validatedSuccess: null,
      labelAuthority: 'operator' as const, completionAuthority: 'assistant_response_status' as const, verification: 'not_evaluated' as const };
  }
  private item(state: State, id: string): StoredTask {
    if (!uuid.safeParse(id).success) fail('not_found', 404);
    const item = state.tasks.find((task) => task.id === id); if (!item) fail('not_found', 404); return item;
  }
  private cas(item: StoredTask, expected: number) {
    if (!revision.safeParse(expected).success) fail('invalid_input');
    if (item.revision !== expected) fail('stale_revision', 409);
  }
  private touch(item: StoredTask) { if (item.revision >= Number.MAX_SAFE_INTEGER) fail('revision_limit', 409); item.revision++; item.updatedAt = iso(); }
  private validate(state: State, expectedScope: string) {
    if (state.scopeHash !== expectedScope || new Set(state.tasks.map((item) => item.id)).size !== state.tasks.length) fail('corrupt_state', 503);
    for (const item of state.tasks) {
      try { validatePlatformAssistantContext(item.context); } catch { fail('corrupt_state', 503); }
      if (new Set(item.mutationDigests).size !== item.mutationDigests.length) fail('corrupt_state', 503);
      if (item.updatedAt < item.createdAt || (item.status === 'running') !== Boolean(item.lease)
        || (item.status === 'awaiting_confirmation') !== Boolean(item.pending)
        || (item.pending && (!item.response?.proposal || item.pending.operationId !== item.response.proposal.operationId || item.pending.expiresAt !== item.response.proposal.expiresAt))) fail('corrupt_state', 503);
    }
  }
  private async readSafe(filename: string, limit: number): Promise<string> {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await file.stat(); if (!info.isFile() || info.size > limit) fail('corrupt_state', 503);
      if ((info.mode & 0o077) !== 0) fail('unsafe_state_permissions', 503); return await file.readFile('utf8'); }
    finally { await file.close(); }
  }
  private async read(scope: string): Promise<{ state: State; changed: boolean }> {
    let state: State;
    try {
      const stored = JSON.parse(await this.readSafe(join(this.stateDir, scope + '.json'), MAX_STATE_BYTES));
      const envelope = envelopeSchema.safeParse(stored);
      // Check original bytes' values before applying the optional old-state digest default.
      if (!envelope.success || hash(canonical(stored.payload)) !== envelope.data.sha256) fail('corrupt_state', 503);
      state = envelope.data.payload;
    } catch (error) {
      if (errno(error, 'ENOENT')) {
        try { await lstat(join(this.stateDir, scope + '.initialized')); fail('missing_state', 503); }
        catch (cause) { if (!errno(cause, 'ENOENT')) throw cause; }
        state = { schemaVersion: 1, scopeHash: scope, tasks: [] };
      } else { if (error instanceof PlatformAssistantTaskError) throw error; fail('corrupt_state', 503); }
    }
    this.validate(state, scope); let changed = false;
    for (const item of state.tasks) if (item.lease && (item.lease.expiresAt <= Date.now() || !alive(item.lease) || (item.lease.pid === process.pid && item.lease.instance !== PROCESS_INSTANCE))) {
      const expired = item.lease.expiresAt <= Date.now();
      item.status = 'interrupted'; item.lease = null; item.pending = null; item.error = expired ? 'platform_assistant_task_lease_expired' : 'platform_assistant_task_process_interrupted';
      if (item.response) delete item.response.proposal;
      this.touch(item); changed = true;
    }
    return { state, changed };
  }
  private async save(state: State): Promise<void> {
    this.validate(state, state.scopeHash); const payload = stateSchema.parse(state); const text = JSON.stringify({ sha256: hash(canonical(payload)), payload });
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) fail('quota_exceeded', 409);
    const temporary = join(this.stateDir, '.' + state.scopeHash + '.' + randomUUID() + '.tmp');
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      const target = join(this.stateDir, state.scopeHash + '.json'); await rename(temporary, target); await chmod(target, 0o600);
      try {
        const marker = await open(join(this.stateDir, state.scopeHash + '.initialized'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await marker.writeFile('d-obs.assistant-tasks.v1'); await marker.sync(); } finally { await marker.close(); }
      } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
      const directory = await open(this.stateDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch((error) => { if (!errno(error, 'ENOENT')) throw error; }); }
  }
  private async lockRecord(filename: string): Promise<Lock | null> {
    try { return lockSchema.parse(JSON.parse(await this.readSafe(filename, 1024))); }
    catch (error) { if (errno(error, 'ENOENT')) return null; fail('unsafe_lock', 503); }
  }
  private async exclusive(filename: string): Promise<(() => Promise<void>) | null> {
    const record: Lock = { pid: process.pid, processBirth: PROCESS_BIRTH, nonce: randomUUID() }; const temporary = filename + '.' + record.nonce + '.tmp';
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, filename); } catch (error) { if (errno(error, 'EEXIST')) return null; throw error; }
      return async () => { const held = await this.lockRecord(filename); if (held?.nonce === record.nonce && held.pid === record.pid) await unlink(filename); };
    } finally { await unlink(temporary).catch((error) => { if (!errno(error, 'ENOENT')) throw error; }); }
  }
  private async recoverLock(filename: string, depth = 0): Promise<void> {
    const held = await this.lockRecord(filename); if (!held || alive(held)) return;
    if (depth >= 3) fail('lock_recovery_required', 503);
    const recovery = filename + '.recover-' + held.nonce; let release = await this.exclusive(recovery);
    if (!release) { await this.recoverLock(recovery, depth + 1); release = await this.exclusive(recovery); if (!release) return; }
    try { const current = await this.lockRecord(filename); if (current?.nonce === held.nonce && current.pid === held.pid && current.processBirth === held.processBirth && !alive(current)) await unlink(filename); }
    finally { await release(); }
  }
  private async lock(scope: string): Promise<() => Promise<void>> {
    const filename = join(this.stateDir, scope + '.lock'); const deadline = Date.now() + 3_000;
    do { const release = await this.exclusive(filename); if (release) return release; await this.recoverLock(filename); await pause(20); } while (Date.now() < deadline);
    fail('writer_busy', 409);
  }
  private async transaction<T>(scope: string, action: (state: State) => T, mutating = false): Promise<T> {
    const owner = scopeHash(scope); const key = join(this.stateDir, owner); const previous = queues.get(key) ?? Promise.resolve();
    let complete!: () => void; const pending = new Promise<void>((done) => { complete = done; }); const tail = previous.then(() => pending); queues.set(key, tail);
    await previous;
    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const info = await lstat(this.stateDir);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_state_path', 503); await chmod(this.stateDir, 0o700);
      const release = await this.lock(owner);
      try {
        const { state, changed } = await this.read(owner);
        // Commit recovery before any caller CAS check; even a stale request must not erase it.
        if (changed) await this.save(state);
        const result = action(state); if (mutating) await this.save(state); return clone(result);
      } finally { await release(); }
    } finally { complete(); if (queues.get(key) === tail) queues.delete(key); }
  }
}
