/** Frozen action-outcome evidence for offline evaluation; never a diagnosis label or a replay executor. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { RemediationRun } from './alert-remediation.js';
import type { ObservabilityActionRecord } from './observability-action-loop.js';
import { MAX_REFS, REF_PATTERN } from './observability-action-proof.js';

export const ACTION_REGRESSION_CONTRACT = 'rdk.observability-action-regression.v1';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const actionId = z.string().regex(/^action-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const stamp = z.string().datetime();
const snapshotSchema = z.object({
  contract: z.literal(ACTION_REGRESSION_CONTRACT),
  purpose: z.literal('action_outcome_regression'),
  labelAuthority: z.literal('server_verified_remediation_run'),
  diagnosisAccuracyMeasured: z.literal(false),
  automaticallyReplayed: z.literal(false),
  sourceActionId: actionId,
  environment: z.enum(['production', 'staging', 'development', 'test']),
  origin: z.enum(['human', 'ai-copilot']),
  evidenceRefs: z.array(z.string().regex(REF_PATTERN)).min(1).max(MAX_REFS),
  execution: z.object({
    runId: z.string().uuid(), playbookId: z.string().min(1).max(96).regex(/^[a-z][a-z0-9-]*$/),
    startedAt: stamp, finishedAt: stamp,
    stepOutcomes: z.array(z.boolean()).min(1).max(100),
  }).strict(),
  expectedOutcome: z.object({
    actionStatus: z.enum(['succeeded', 'verification_failed']),
    remediationStatus: z.enum(['succeeded', 'failed']),
    verificationOk: z.boolean(), verificationCheckedAt: stamp,
  }).strict(),
}).strict();
const caseSchema = z.object({
  id: z.string().regex(/^case-[a-f0-9]{32}$/), contentHash: sha, capturedAt: stamp,
  snapshot: snapshotSchema,
}).strict();
const envelopeSchema = z.object({ ownerHash: sha, sha256: sha, regressionCase: caseSchema }).strict();
const MAX_FILE_BYTES = 64 * 1024;

export type ObservabilityActionRegressionCase = z.infer<typeof caseSchema>;
export class ObservabilityActionRegressionError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
function fail(code: string, status = 409): never { throw new ObservabilityActionRegressionError(code, status); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function ownerDigest(owner: string): string {
  if (typeof owner !== 'string' || !owner || owner !== owner.trim() || owner.length > 256 || /[\u0000-\u001f\u007f]/.test(owner)) fail('action_regression_identity_required', 401);
  return hash({ owner });
}
function caseId(ownerHash: string, sourceActionId: string): string { return 'case-' + hash({ ownerHash, sourceActionId }).slice(0, 32); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Retain only fixed codes, booleans, times and existing evidence refs; free text and actor identities stay out. */
export function buildActionRegressionSnapshot(action: ObservabilityActionRecord, run: RemediationRun | null): z.infer<typeof snapshotSchema> {
  const execution = action.execution;
  const verification = execution?.verification;
  if (action.type !== 'remediate' || !['succeeded', 'verification_failed'].includes(action.status) ||
    !execution?.accepted || !execution.finishedAt || !verification || verification.pending || !verification.checks?.length) {
    fail('action_regression_verified_outcome_required');
  }
  if (!run || !['succeeded', 'failed'].includes(run.status) || !run.finishedAt || !run.steps?.length ||
    execution.runId !== run.id || action.environment !== run.environment || action.playbookId !== run.playbookId || execution.playbookId !== run.playbookId) {
    fail('action_regression_exact_run_required');
  }
  const succeeded = run.status === 'succeeded';
  if (verification.ok !== succeeded || (action.status === 'succeeded') !== succeeded ||
    run.steps.some(step => typeof step.ok !== 'boolean') ||
    (succeeded ? run.steps.some(step => !step.ok) : run.steps.every(step => step.ok))) {
    fail('action_regression_outcome_mismatch');
  }
  const parsed = snapshotSchema.safeParse({
    contract: ACTION_REGRESSION_CONTRACT, purpose: 'action_outcome_regression', labelAuthority: 'server_verified_remediation_run',
    diagnosisAccuracyMeasured: false, automaticallyReplayed: false,
    sourceActionId: action.id, environment: action.environment, origin: action.origin,
    evidenceRefs: [...new Set(action.evidenceRefs)].sort(),
    execution: { runId: run.id, playbookId: run.playbookId, startedAt: run.startedAt, finishedAt: run.finishedAt, stepOutcomes: run.steps.map(step => step.ok) },
    expectedOutcome: { actionStatus: action.status, remediationStatus: run.status, verificationOk: verification.ok, verificationCheckedAt: verification.checkedAt },
  });
  if (!parsed.success) fail('action_regression_invalid_evidence');
  if (parsed.data.execution.finishedAt < parsed.data.execution.startedAt || verification.checkedAt < run.finishedAt) fail('action_regression_invalid_evidence');
  return parsed.data;
}

/** One immutable file per owner/action. An exclusive hard link publishes complete, fsynced JSON atomically. */
export class ObservabilityActionRegressionService {
  readonly stateDir: string;
  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env.RDK_ACTION_REGRESSION_STATE_DIR ?? join(homedir(), '.local', 'state', 'd-obs', 'action-regressions'));
  }
  async save(owner: string, action: ObservabilityActionRecord, run: RemediationRun | null): Promise<ObservabilityActionRegressionCase> {
    if (action.accountScopeId !== owner) fail('action_regression_owner_mismatch', 403);
    const ownerHash = ownerDigest(owner);
    const snapshot = buildActionRegressionSnapshot(action, run);
    const contentHash = hash(snapshot);
    const id = caseId(ownerHash, action.id);
    const existing = await this.get(owner, action.id);
    if (existing) {
      if (existing.contentHash !== contentHash) fail('action_regression_result_conflict');
      return existing;
    }
    const regressionCase = caseSchema.parse({ id, contentHash, capturedAt: new Date().toISOString(), snapshot });
    const envelope = { ownerHash, sha256: hash(regressionCase), regressionCase };
    await this.directory(this.stateDir, true);
    const directory = join(this.stateDir, ownerHash);
    await this.directory(directory, true);
    const temporary = join(directory, '.' + id + '.' + randomUUID() + '.tmp');
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, join(directory, id + '.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
      const descriptor = await open(directory, constants.O_RDONLY);
      try { await descriptor.sync(); } finally { await descriptor.close(); }
      const stored = await this.get(owner, action.id);
      if (!stored || stored.contentHash !== contentHash) fail('action_regression_result_conflict');
      return stored;
    } catch (error) {
      if (error instanceof ObservabilityActionRegressionError) throw error;
      fail('action_regression_store_unavailable', 503);
    } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
  }
  async get(owner: string, sourceActionId: string): Promise<ObservabilityActionRegressionCase | null> {
    const ownerHash = ownerDigest(owner);
    if (!actionId.safeParse(sourceActionId).success) fail('action_regression_invalid_action', 400);
    const id = caseId(ownerHash, sourceActionId);
    try {
      if (!await this.directory(this.stateDir, false)) return null;
      const directory = join(this.stateDir, ownerHash);
      if (!await this.directory(directory, false)) return null;
      const file = await open(join(directory, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) fail('action_regression_corrupt_state', 503);
        const parsed = envelopeSchema.safeParse(JSON.parse(await file.readFile('utf8')));
        if (!parsed.success) fail('action_regression_corrupt_state', 503);
        const envelope = parsed.data;
        if (envelope.ownerHash !== ownerHash || envelope.regressionCase.id !== id || envelope.regressionCase.snapshot.sourceActionId !== sourceActionId ||
          envelope.sha256 !== hash(envelope.regressionCase) || envelope.regressionCase.contentHash !== hash(envelope.regressionCase.snapshot)) fail('action_regression_corrupt_state', 503);
        return envelope.regressionCase;
      } finally { await file.close(); }
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof ObservabilityActionRegressionError) throw error;
      fail('action_regression_corrupt_state', 503);
    }
  }
  private async directory(path: string, create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('action_regression_unsafe_state_path', 503);
      if (create) await chmod(path, 0o700);
      return true;
    } catch (error) {
      if (!create && isMissing(error)) return false;
      if (error instanceof ObservabilityActionRegressionError) throw error;
      fail('action_regression_store_unavailable', 503);
    }
  }
}

export function actionRegressionMarker(regressionCase: ObservabilityActionRegressionCase): string {
  return 'regression-case:' + regressionCase.id + ':' + regressionCase.contentHash;
}
