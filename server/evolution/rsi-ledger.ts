import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  BASELINE_RULES, DEFAULT_RSI_BUDGET, DEMO_CASES, ReplayReportSchema, RsiBudgetSchema,
  RsiCasesSchema, RsiRuleSchema, RsiRulesSchema,
  proposeRules, runReplay,
} from './rsi-replay.js';

const MAX_LOOPS = 50;
const MAX_VERSIONS = 100;
const MAX_REPLAYS = 100;
const MAX_DECISIONS = 300;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.string().datetime();
const label = z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are forbidden');
export const createLoopInputSchema = z.object({ title: label, cases: RsiCasesSchema, rules: RsiRulesSchema.optional() }).strict().refine(
  (input) => ['frozen', 'adaptive', 'holdout'].every((slice) => input.cases.some((item) => item.slice === slice)),
  'Every evaluation slice requires at least one case',
);
const evidenceProvenanceSchema = z.array(z.object({
  caseId: z.string().min(1).max(96), evidenceId: uuid, fingerprint: sha,
  operationId: z.string().min(1).max(300).regex(/^(GET|POST|PUT|PATCH|DELETE) \/api\/ops\/observability\/[A-Za-z0-9_:/.-]+$/),
  observedAt: stamp, confirmedAt: stamp,
}).strict()).min(3).max(200);
export const mutationInputSchema = z.object({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const rollbackInputSchema = mutationInputSchema.extend({ versionId: uuid }).strict();

const proposalSchema = z.object({
  status: z.enum(['proposed', 'no_change', 'conflict', 'rule_limit']), rules: RsiRulesSchema,
  addedRule: RsiRuleSchema.nullable(), evidenceCaseIds: z.array(z.string().min(1).max(96)).max(200),
  reason: z.string().min(1).max(500),
}).strict();
const versionSchema = z.object({
  id: uuid, parentVersionId: uuid.nullable(), loadedVersionId: uuid.nullable(), rules: RsiRulesSchema,
  rulesHash: sha, proposal: proposalSchema.nullable(), status: z.enum(['initial', 'pending', 'accepted', 'rejected']), createdAt: stamp,
}).strict();
const replaySchema = z.object({
  id: uuid, activeVersionId: uuid, parentVersionId: uuid, candidateVersionId: uuid, loadedVersionId: uuid,
  casesHash: sha, activeRulesHash: sha, candidateRulesHash: sha,
  counterfactualLoadedVersionId: uuid, counterfactualProposal: proposalSchema, counterfactualRulesHash: sha,
  proposalBudget: z.object({ adaptiveCaseCount: z.number().int().min(0).max(200), maxNewRulesPerProposal: z.literal(1), proposalsPerVariant: z.literal(1), labelAccess: z.literal('adaptive_only') }).strict(),
  budget: RsiBudgetSchema, report: ReplayReportSchema, reportHash: sha, createdAt: stamp,
}).strict();
const decisionSchema = z.object({
  id: uuid, action: z.enum(['accept', 'reject', 'rollback']), versionId: uuid, fromVersionId: uuid,
  toVersionId: uuid, replayId: uuid.nullable(), casesHash: sha, revision: z.number().int().positive(), createdAt: stamp,
}).strict();
const loopSchema = z.object({
  id: uuid, title: label, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cases: RsiCasesSchema, casesHash: sha, initialVersionId: uuid, activeVersionId: uuid,
  candidateVersionId: uuid.nullable(), versions: z.array(versionSchema).min(1).max(MAX_VERSIONS),
  provenance: evidenceProvenanceSchema.optional(),
  replays: z.array(replaySchema).max(MAX_REPLAYS), decisions: z.array(decisionSchema).max(MAX_DECISIONS),
  createdAt: stamp, updatedAt: stamp,
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), ownerHash: sha, loops: z.array(loopSchema).max(MAX_LOOPS) }).strict();
const envelopeSchema = z.object({ sha256: sha, payload: stateSchema }).strict();
const lockSchema = z.object({ pid: z.number().int().positive(), nonce: uuid, createdAt: stamp }).strict();
export type RsiLoop = z.infer<typeof loopSchema>;
export type RsiVersion = z.infer<typeof versionSchema>;
export type RsiReplayEvidence = z.infer<typeof replaySchema>;
type State = z.infer<typeof stateSchema>;
type Lock = z.infer<typeof lockSchema>;
export interface RsiLedgerOptions { stateDir?: string; rootDir?: string }
export class RsiLedgerError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'RsiLedgerError'; }
}
function fail(code: string, status = 400): never { throw new RsiLedgerError('rsi_' + code, status); }
const codeIs = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const queues = new Map<string, Promise<void>>();
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const iso = () => new Date().toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function ownerHash(owner: string): string {
  if (typeof owner !== 'string' || !owner.trim() || owner !== owner.trim() || owner.length > 512 || /[\u0000-\u001f\u007f]/.test(owner)) fail('identity_required', 401);
  return createHash('sha256').update(owner).digest('hex');
}
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) fail('invalid_input'); return result.data;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if (codeIs(error, 'ESRCH')) return false; return true; }
}

/** Local evidence ledger. It never edits application code, deploys, or executes device commands. */
export class RsiLedgerService {
  readonly stateDir: string;
  constructor(options: RsiLedgerOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? options.rootDir ?? process.env.RDK_RSI_STATE_DIR ?? join(homedir(), '.local', 'state', 'd-obs', 'rsi'));
  }
  capabilities() {
    return { mode: 'bounded_deterministic_rule_replay', productionCodeModified: false, automaticPromotion: false,
      persistence: 'owner_scoped_local_json', concurrency: 'process_queue_and_exclusive_file_lock',
      quota: { maxLoopsPerOwner: MAX_LOOPS, maxCasesPerLoop: 200, maxVersionsPerLoop: MAX_VERSIONS, maxReplaysPerLoop: MAX_REPLAYS, maxDecisionsPerLoop: MAX_DECISIONS, maxStateBytesPerOwner: MAX_STATE_BYTES },
      budget: { ...DEFAULT_RSI_BUDGET }, noRetention: 'one_proposal_from_initial_rules_per_round',
      demo: { source: 'synthetic', creation: 'explicit_seed_only' },
    };
  }
  async overview(owner: string) {
    const state = await this.read(ownerHash(owner));
    const loops = state.loops.map((loop) => {
      const acceptedRounds = loop.decisions.filter((decision) => decision.action === 'accept').length;
      const inheritedRounds = loop.decisions.filter((decision) => decision.action === 'accept' && this.version(loop, decision.versionId).loadedVersionId !== loop.initialVersionId).length;
      const active = this.version(loop, loop.activeVersionId);
      const latestReplay = loop.replays.at(-1) ?? null;
      return { id: loop.id, title: loop.title, revision: loop.revision, initialVersionId: loop.initialVersionId,
        activeVersionId: loop.activeVersionId, candidateVersionId: loop.candidateVersionId, activeRuleCount: active.rules.length,
        caseCount: loop.cases.length, acceptedRounds, inheritedRounds, replayCount: loop.replays.length,
        source: this.source(loop), synthetic: loop.cases.length > 0 && loop.cases.every((item) => item.source === 'synthetic'),
        status: loop.candidateVersionId ? (latestReplay?.candidateVersionId === loop.candidateVersionId ? (latestReplay.report.gate.passed ? 'ready_to_accept' : 'gate_failed') : 'candidate_pending') : 'active',
        createdAt: loop.createdAt, updatedAt: loop.updatedAt };
    });
    const counts = { loops: loops.length, acceptedRounds: loops.reduce((sum, loop) => sum + loop.acceptedRounds, 0), inheritedRounds: loops.reduce((sum, loop) => sum + loop.inheritedRounds, 0), replays: loops.reduce((sum, loop) => sum + loop.replayCount, 0), pendingCandidates: loops.filter((loop) => loop.candidateVersionId).length };
    return clone({ status: loops.length ? 'ready' as const : 'empty' as const, loops, counts, capabilities: this.capabilities() });
  }
  async detail(owner: string, id: string): Promise<RsiLoop> { return clone(this.loop(await this.read(ownerHash(owner)), id)); }
  async getLoop(owner: string, id: string): Promise<RsiLoop> { return this.detail(owner, id); }
  async createLoop(owner: string, input: unknown): Promise<RsiLoop> {
    const parsed = parseInput(createLoopInputSchema, input);
    return this.createParsedLoop(owner, parsed);
  }
  /** Only the server's confirmed-observation route supplies these immutable references. */
  async createLoopFromEvidence(owner: string, input: unknown, provenanceInput: unknown): Promise<RsiLoop> {
    const parsed = parseInput(createLoopInputSchema, input);
    const provenance = parseInput(evidenceProvenanceSchema, provenanceInput);
    if (provenance.length !== parsed.cases.length || new Set(provenance.map(item => item.evidenceId)).size !== provenance.length ||
      new Set(provenance.map(item => item.caseId)).size !== provenance.length ||
      parsed.cases.some(item => item.source !== 'operator' || !provenance.some(ref => ref.caseId === item.id))) fail('invalid_evidence_provenance');
    return this.createParsedLoop(owner, parsed, provenance);
  }
  private async createParsedLoop(owner: string, parsed: z.infer<typeof createLoopInputSchema>, provenance?: z.infer<typeof evidenceProvenanceSchema>): Promise<RsiLoop> {
    return this.mutate(owner, (state) => {
      if (state.loops.length >= MAX_LOOPS) fail('loop_limit', 409);
      const now = iso(); const rules = clone(parsed.rules ?? BASELINE_RULES); const initialId = randomUUID();
      const loop: RsiLoop = { id: randomUUID(), title: parsed.title, revision: 1, cases: clone(parsed.cases), casesHash: hash(parsed.cases), initialVersionId: initialId, activeVersionId: initialId, candidateVersionId: null,
        versions: [{ id: initialId, parentVersionId: null, loadedVersionId: null, rules, rulesHash: hash(rules), proposal: null, status: 'initial', createdAt: now }], replays: [], decisions: [], createdAt: now, updatedAt: now,
        ...(provenance ? { provenance: clone(provenance) } : {}) };
      state.loops.push(loop); return loop;
    });
  }
  async seedDemo(owner: string): Promise<RsiLoop> { return this.createLoop(owner, { title: '合成错误分类 · 两轮继承示例', cases: clone(DEMO_CASES), rules: clone(BASELINE_RULES) }); }
  async propose(owner: string, id: string, input: unknown): Promise<RsiLoop> {
    const { expectedRevision } = parseInput(mutationInputSchema, input);
    return this.mutate(owner, (state) => {
      const loop = this.loop(state, id); this.cas(loop, expectedRevision);
      if (loop.candidateVersionId) fail('candidate_pending', 409);
      if (loop.versions.length >= MAX_VERSIONS) fail('version_limit', 409);
      const parent = this.version(loop, loop.activeVersionId);
      const proposal = proposeRules(loop.cases.filter((item) => item.slice === 'adaptive'), parent.rules);
      if (proposal.status !== 'proposed') fail('proposal_' + proposal.status, 409);
      const version: RsiVersion = { id: randomUUID(), parentVersionId: parent.id, loadedVersionId: parent.id,
        rules: proposal.rules, rulesHash: hash(proposal.rules), proposal, status: 'pending', createdAt: iso() };
      loop.versions.push(version); loop.candidateVersionId = version.id; this.touch(loop); return loop;
    });
  }
  async replay(owner: string, id: string, input: unknown): Promise<RsiLoop> {
    const { expectedRevision } = parseInput(mutationInputSchema, input);
    return this.mutate(owner, (state) => {
      const loop = this.loop(state, id); this.cas(loop, expectedRevision);
      if (loop.replays.length >= MAX_REPLAYS) fail('replay_limit', 409);
      const candidate = this.candidate(loop); const active = this.version(loop, loop.activeVersionId); const initial = this.version(loop, loop.initialVersionId);
      const adaptive = loop.cases.filter((item) => item.slice === 'adaptive');
      const counterfactualProposal = proposeRules(adaptive, initial.rules);
      const budget = { ...DEFAULT_RSI_BUDGET };
      const report = ReplayReportSchema.parse(runReplay({ cases: loop.cases, activeRules: active.rules, candidateRules: candidate.rules, noRetentionRules: counterfactualProposal.rules, budget }));
      const replay: RsiReplayEvidence = { id: randomUUID(), activeVersionId: active.id, parentVersionId: active.id, candidateVersionId: candidate.id, loadedVersionId: candidate.loadedVersionId!, casesHash: loop.casesHash,
        activeRulesHash: active.rulesHash, candidateRulesHash: candidate.rulesHash, counterfactualLoadedVersionId: initial.id, counterfactualProposal, counterfactualRulesHash: hash(counterfactualProposal.rules),
        proposalBudget: { adaptiveCaseCount: adaptive.length, maxNewRulesPerProposal: 1, proposalsPerVariant: 1, labelAccess: 'adaptive_only' }, budget, report, reportHash: hash(report), createdAt: iso() };
      loop.replays.push(replay); this.touch(loop); return loop;
    });
  }
  async accept(owner: string, id: string, input: unknown): Promise<RsiLoop> {
    const { expectedRevision } = parseInput(mutationInputSchema, input);
    return this.mutate(owner, (state) => {
      const loop = this.loop(state, id); this.cas(loop, expectedRevision); const candidate = this.candidate(loop);
      const replay = loop.replays.at(-1); if (!replay) fail('gate_required', 409);
      if (replay.candidateVersionId !== candidate.id || replay.activeVersionId !== loop.activeVersionId || replay.parentVersionId !== candidate.parentVersionId || replay.casesHash !== loop.casesHash) fail('stale_replay', 409);
      const active = this.version(loop, loop.activeVersionId); const initial = this.version(loop, loop.initialVersionId);
      const counterfactual = proposeRules(loop.cases.filter((item) => item.slice === 'adaptive'), initial.rules);
      const report = runReplay({ cases: loop.cases, activeRules: active.rules, candidateRules: candidate.rules, noRetentionRules: counterfactual.rules, budget: replay.budget });
      if (hash(report) !== replay.reportHash || hash(counterfactual) !== hash(replay.counterfactualProposal) || replay.activeRulesHash !== active.rulesHash || replay.candidateRulesHash !== candidate.rulesHash || replay.counterfactualLoadedVersionId !== initial.id) fail('stale_replay', 409);
      if (!report.gate.passed) fail('gate_failed', 409);
      this.decide(loop, 'accept', candidate.id, candidate.id, replay.id); candidate.status = 'accepted';
      loop.activeVersionId = candidate.id; loop.candidateVersionId = null; this.touch(loop); return loop;
    });
  }
  async reject(owner: string, id: string, input: unknown): Promise<RsiLoop> {
    const { expectedRevision } = parseInput(mutationInputSchema, input);
    return this.mutate(owner, (state) => {
      const loop = this.loop(state, id); this.cas(loop, expectedRevision); const candidate = this.candidate(loop);
      const replay = loop.replays.at(-1); this.decide(loop, 'reject', candidate.id, loop.activeVersionId, replay?.candidateVersionId === candidate.id ? replay.id : null);
      candidate.status = 'rejected'; loop.candidateVersionId = null; this.touch(loop); return loop;
    });
  }
  async rollback(owner: string, id: string, input: unknown): Promise<RsiLoop> {
    const { expectedRevision, versionId } = parseInput(rollbackInputSchema, input);
    return this.mutate(owner, (state) => {
      const loop = this.loop(state, id); this.cas(loop, expectedRevision);
      if (loop.candidateVersionId) fail('candidate_pending', 409);
      if (versionId === loop.activeVersionId || !this.ancestors(loop).has(versionId)) fail('rollback_ancestor_required', 409);
      const target = this.version(loop, versionId);
      if (target.status !== 'initial' && target.status !== 'accepted') fail('rollback_ancestor_required', 409);
      this.decide(loop, 'rollback', versionId, versionId, null); loop.activeVersionId = versionId; this.touch(loop); return loop;
    });
  }
  private source(loop: RsiLoop) { const sources = new Set(loop.cases.map((item) => item.source)); return sources.size === 1 ? [...sources][0] : sources.size ? 'mixed' : 'empty'; }
  private loop(state: State, id: string): RsiLoop {
    if (!uuid.safeParse(id).success) fail('not_found', 404); const loop = state.loops.find((item) => item.id === id); if (!loop) fail('not_found', 404); return loop;
  }
  private version(loop: RsiLoop, id: string): RsiVersion { const version = loop.versions.find((item) => item.id === id); if (!version) fail('corrupt_state', 503); return version; }
  private candidate(loop: RsiLoop): RsiVersion {
    if (!loop.candidateVersionId) fail('candidate_required', 409); const candidate = this.version(loop, loop.candidateVersionId);
    if (candidate.status !== 'pending' || candidate.parentVersionId !== loop.activeVersionId || candidate.loadedVersionId !== loop.activeVersionId) fail('stale_candidate', 409); return candidate;
  }
  private ancestors(loop: RsiLoop): Set<string> {
    const result = new Set<string>(); let id = this.version(loop, loop.activeVersionId).parentVersionId;
    while (id) { if (result.has(id)) fail('corrupt_state', 503); result.add(id); id = this.version(loop, id).parentVersionId; } return result;
  }
  private cas(loop: RsiLoop, revision: number) { if (loop.revision !== revision) fail('stale_revision', 409); }
  private touch(loop: RsiLoop) { if (loop.revision >= Number.MAX_SAFE_INTEGER) fail('revision_limit', 409); loop.revision += 1; loop.updatedAt = iso(); }
  private decide(loop: RsiLoop, action: 'accept' | 'reject' | 'rollback', versionId: string, toVersionId: string, replayId: string | null) {
    if (loop.decisions.length >= MAX_DECISIONS) fail('decision_limit', 409);
    loop.decisions.push({ id: randomUUID(), action, versionId, fromVersionId: loop.activeVersionId, toVersionId, replayId, casesHash: loop.casesHash, revision: loop.revision + 1, createdAt: iso() });
  }
  private validate(state: State, expectedOwner: string) {
    if (state.ownerHash !== expectedOwner || new Set(state.loops.map((loop) => loop.id)).size !== state.loops.length) fail('corrupt_state', 503);
    for (const loop of state.loops) {
      if (loop.provenance && (loop.provenance.length !== loop.cases.length ||
        new Set(loop.provenance.map(item => item.caseId)).size !== loop.provenance.length ||
        new Set(loop.provenance.map(item => item.evidenceId)).size !== loop.provenance.length ||
        loop.cases.some(item => item.source !== 'operator' || !loop.provenance!.some(ref => ref.caseId === item.id)))) fail('corrupt_state', 503);
      if (hash(loop.cases) !== loop.casesHash || new Set(loop.versions.map((version) => version.id)).size !== loop.versions.length || new Set(loop.replays.map((replay) => replay.id)).size !== loop.replays.length || new Set(loop.decisions.map((decision) => decision.id)).size !== loop.decisions.length) fail('corrupt_state', 503);
      const initial = loop.versions[0]; if (initial.id !== loop.initialVersionId || initial.status !== 'initial' || initial.parentVersionId !== null || initial.loadedVersionId !== null || initial.proposal !== null) fail('corrupt_state', 503);
      const previous = new Set<string>();
      for (const version of loop.versions) {
        if (hash(version.rules) !== version.rulesHash) fail('corrupt_state', 503);
        if (version.id !== initial.id) {
          if (!version.parentVersionId || !previous.has(version.parentVersionId) || version.loadedVersionId !== version.parentVersionId || !version.proposal || version.proposal.status !== 'proposed' || hash(version.proposal.rules) !== version.rulesHash || version.status === 'initial') fail('corrupt_state', 503);
          const parent = this.version(loop, version.parentVersionId); if (parent.status !== 'initial' && parent.status !== 'accepted') fail('corrupt_state', 503);
          if (version.rules.length !== parent.rules.length + 1 || hash(version.rules.slice(1)) !== hash(parent.rules)) fail('corrupt_state', 503);
        }
        previous.add(version.id);
      }
      const active = this.version(loop, loop.activeVersionId); if (active.status !== 'initial' && active.status !== 'accepted') fail('corrupt_state', 503);
      const pending = loop.versions.filter((version) => version.status === 'pending'); if (pending.length !== Number(loop.candidateVersionId !== null) || (pending.length && pending[0].id !== loop.candidateVersionId)) fail('corrupt_state', 503);
      if (loop.candidateVersionId) {
        const candidate = this.version(loop, loop.candidateVersionId);
        if (candidate.parentVersionId !== loop.activeVersionId || candidate.loadedVersionId !== loop.activeVersionId) fail('corrupt_state', 503);
      }
      for (const replay of loop.replays) {
        const candidate = this.version(loop, replay.candidateVersionId); const parent = this.version(loop, replay.activeVersionId);
        if (candidate.parentVersionId !== parent.id || replay.parentVersionId !== parent.id || replay.loadedVersionId !== parent.id || replay.casesHash !== loop.casesHash || replay.activeRulesHash !== parent.rulesHash || replay.candidateRulesHash !== candidate.rulesHash || replay.counterfactualLoadedVersionId !== initial.id || hash(replay.counterfactualProposal.rules) !== replay.counterfactualRulesHash || hash(replay.report) !== replay.reportHash) fail('corrupt_state', 503);
      }
      let decidedActiveId = initial.id; let lastDecisionRevision = 0;
      for (const decision of loop.decisions) {
        const version = this.version(loop, decision.versionId); this.version(loop, decision.fromVersionId); this.version(loop, decision.toVersionId);
        const replay = decision.replayId ? loop.replays.find((item) => item.id === decision.replayId) : null;
        if (decision.casesHash !== loop.casesHash || decision.revision > loop.revision || decision.revision <= lastDecisionRevision || decision.fromVersionId !== decidedActiveId || (decision.replayId && !replay)) fail('corrupt_state', 503);
        if (decision.action === 'accept') {
          if (version.status !== 'accepted' || version.parentVersionId !== decidedActiveId || !replay?.report.gate.passed || replay.candidateVersionId !== version.id || replay.activeVersionId !== decidedActiveId || decision.toVersionId !== version.id) fail('corrupt_state', 503);
          decidedActiveId = version.id;
        }
        if (decision.action === 'reject' && (version.status !== 'rejected' || version.parentVersionId !== decidedActiveId || decision.toVersionId !== decidedActiveId)) fail('corrupt_state', 503);
        if (decision.action === 'rollback') {
          const temporary = { ...loop, activeVersionId: decidedActiveId };
          if (decision.toVersionId !== version.id || !this.ancestors(temporary).has(version.id) || (version.status !== 'initial' && version.status !== 'accepted')) fail('corrupt_state', 503);
          decidedActiveId = version.id;
        }
        lastDecisionRevision = decision.revision;
      }
      if (decidedActiveId !== loop.activeVersionId || loop.versions.some((version) => (version.status === 'accepted' && !loop.decisions.some((decision) => decision.action === 'accept' && decision.versionId === version.id)) || (version.status === 'rejected' && !loop.decisions.some((decision) => decision.action === 'reject' && decision.versionId === version.id)))) fail('corrupt_state', 503);
      this.ancestors(loop);
    }
  }
  private async read(owner: string): Promise<State> {
    const path = join(this.stateDir, owner + '.json');
    try {
      const directory = await lstat(this.stateDir); if (!directory.isDirectory() || directory.isSymbolicLink()) fail('unsafe_state_path', 503);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_STATE_BYTES) fail('corrupt_state', 503);
        const raw: unknown = JSON.parse(await file.readFile('utf8')); const envelope = envelopeSchema.safeParse(raw);
        if (!envelope.success || hash(envelope.data.payload) !== envelope.data.sha256) fail('corrupt_state', 503);
        this.validate(envelope.data.payload, owner); return envelope.data.payload;
      } finally { await file.close(); }
    } catch (error) {
      if (codeIs(error, 'ENOENT')) return { schemaVersion: 1, ownerHash: owner, loops: [] };
      if (error instanceof RsiLedgerError) throw error; fail('corrupt_state', 503);
    }
  }
  private async save(state: State) {
    this.validate(state, state.ownerHash);
    const text = JSON.stringify({ sha256: hash(state), payload: state }); if (Buffer.byteLength(text) > MAX_STATE_BYTES) fail('state_quota', 409);
    const target = join(this.stateDir, state.ownerHash + '.json'); const temporary = join(this.stateDir, '.' + state.ownerHash + '.' + randomUUID() + '.tmp');
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, target); await chmod(target, 0o600); const directory = await open(this.stateDir, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } }
    finally { await unlink(temporary).catch((error) => { if (!codeIs(error, 'ENOENT')) throw error; }); }
  }
  private async lockRecord(path: string): Promise<Lock | null> {
    try {
      const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) fail('unsafe_lock', 503);
      return lockSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    }
    catch (error) { if (codeIs(error, 'ENOENT')) return null; if (error instanceof RsiLedgerError) throw error; fail('unsafe_lock', 503); }
  }
  private async exclusive(path: string, record: Lock): Promise<boolean> {
    const temporary = path + '.' + record.nonce + '.tmp';
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
      // link provides exclusive creation while making the complete record visible atomically.
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
        const held = await this.lockRecord(lockPath);
        // The guard serializes lock creation and dead-owner cleanup across processes.
        if (held && !alive(held.pid)) await this.release(lockPath, held.nonce);
        const record: Lock = { pid: process.pid, nonce: randomUUID(), createdAt: iso() };
        if (await this.exclusive(lockPath, record)) acquired = record;
      } finally { await this.release(guardPath, guard.nonce); }
      if (acquired) { const nonce = acquired.nonce; return () => this.release(lockPath, nonce); }
      await pause(20);
    }
    fail('writer_busy', 409);
  }
  private async mutate(owner: string, operation: (state: State) => RsiLoop | Promise<RsiLoop>): Promise<RsiLoop> {
    const digest = ownerHash(owner); const key = join(this.stateDir, digest); const previous = queues.get(key) ?? Promise.resolve();
    let complete!: () => void; const pending = new Promise<void>((done) => { complete = done; }); const tail = previous.then(() => pending); queues.set(key, tail);
    await previous;
    try { const release = await this.lock(digest); try { const state = await this.read(digest); const result = await operation(state); await this.save(state); return clone(result); } finally { await release(); } }
    finally { complete(); if (queues.get(key) === tail) queues.delete(key); }
  }
}
export function createRsiLedgerService(options: RsiLedgerOptions = {}) { return new RsiLedgerService(options); }
