/** Observe actual tool receipts; never retain arguments, response bodies or credentials. */
import type { Request } from 'express';
import { RsiFailureInboxService, RsiFailureInboxError } from '../evolution/rsi-failure-inbox.js';
import { RsiLedgerService } from '../evolution/rsi-ledger.js';
import { classify, RsiErrorCodeSchema, RsiInputSchema, type RsiInput, type RsiReason } from '../evolution/rsi-replay.js';
import { getSessionSsoUser } from './observability-access-adapter.js';
import { isOpsAdminRequest, resolveOpsActorId } from './observability-access.js';
import type { PlatformOperation, PlatformOperationResult } from './platform-operations.js';

const MACHINE_CODES: Record<string, RsiInput['errorCode']> = {
  platform_operation_timeout: 'ETIMEDOUT', platform_operation_failed: 'UPSTREAM_UNAVAILABLE',
  platform_operation_interrupted: 'UPSTREAM_UNAVAILABLE',
};
function failureInput(result: PlatformOperationResult): RsiInput | null {
  if (result.ok || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) return null;
  const input: RsiInput = { httpStatus: result.status };
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    // Read a single own data property. Unknown text is discarded, not regex-scraped.
    const error = Object.getOwnPropertyDescriptor(result.data, 'error')?.value;
    if (typeof error === 'string') {
      const code = RsiErrorCodeSchema.safeParse(error);
      const mapped = Object.hasOwn(MACHINE_CODES, error) ? MACHINE_CODES[error] : undefined;
      if (code.success) input.errorCode = code.data;
      else if (mapped) input.errorCode = mapped;
    }
  }
  return RsiInputSchema.parse(input);
}
function suggestion(input: RsiInput): RsiReason {
  const code = input.errorCode;
  if (code === 'ETIMEDOUT' || [408, 504].includes(input.httpStatus ?? 0)) return 'timeout';
  if (code === 'RATE_LIMITED' || input.httpStatus === 429) return 'rate_limited';
  if (code === 'AUTH_DENIED' || [401,403].includes(input.httpStatus ?? 0)) return 'auth_denied';
  if (code === 'NOT_FOUND' || input.httpStatus === 404) return 'not_found';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'EINVAL' || [400,422].includes(input.httpStatus ?? 0)) return 'invalid_input';
  if (code === 'UPSTREAM_UNAVAILABLE' || code === 'EAI_AGAIN' || (input.httpStatus ?? 0) >= 500) return 'upstream_unavailable';
  return 'unknown';
}
export type RsiFailureObserverOptions = {
  inbox?: RsiFailureInboxService; ledger?: RsiLedgerService;
  owner?: (req: Request) => string; allowed?: (req: Request) => boolean; maximumPending?: number;
};
export class RsiFailureObserver {
  private inbox: RsiFailureInboxService;
  private ledger: RsiLedgerService;
  private pending = new Set<Promise<void>>();
  private maximumPending: number;
  constructor(private options: RsiFailureObserverOptions = {}) {
    this.inbox = options.inbox ?? new RsiFailureInboxService();
    this.ledger = options.ledger ?? new RsiLedgerService();
    this.maximumPending = options.maximumPending ?? 32;
  }
  capture(req: Request, operation: PlatformOperation, result: PlatformOperationResult): void {
    try {
      if (result.ok || req.opsTenantAccess || req.header('x-rdk-ops-read-only') === '1' ||
        operation.path.startsWith('/api/ops/observability/evolution/learning') ||
        !(this.options.allowed ? this.options.allowed(req) : isOpsAdminRequest(req)) || this.pending.size >= this.maximumPending) return;
      const user = getSessionSsoUser(req);
      const owner = this.options.owner ? this.options.owner(req) : user ? 'sso:' + user.id : resolveOpsActorId(req);
      if (!owner || owner === 'ops-admin') return;
      const input = failureInput(result); if (!input) return;
      const operationId = operation.id;
      // A failed mutating receipt does not establish whether its side effect happened.
      const executionOutcome = operation.mutating ? 'unknown' as const : 'failed' as const;
      const task = this.observe(owner, operationId, input, executionOutcome).catch(() => {});
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    } catch { /* Observability must not change the original operation result. */ }
  }
  private async observe(owner: string, operationId: string, input: RsiInput, executionOutcome: 'failed'|'unknown'): Promise<void> {
    const overview = await this.inbox.overview(owner);
    let classification: { loopId: string; activeVersionId: string; reason: RsiReason } | undefined;
    if (overview.activeLoopId) {
      // Binding is explicit. A later rollback or candidate can invalidate live use.
      try {
        const loop = await this.ledger.getLoop(owner, overview.activeLoopId);
        const active = loop.versions.find(version => version.id === loop.activeVersionId);
        const accepted = loop.decisions.some(decision => decision.action === 'accept' && decision.versionId === active?.id &&
          loop.replays.some(replay => replay.id === decision.replayId && replay.candidateVersionId === active?.id && replay.report.gate.passed));
        const liveEvidence = loop.provenance?.length === loop.cases.length && loop.cases.every(item => {
          const reference = loop.provenance!.find(ref => ref.caseId === item.id);
          const evidence = overview.records.find(evidence => evidence.id === reference?.evidenceId);
          return item.source === 'operator' && evidence?.status === 'confirmed' && evidence.fingerprint === reference?.fingerprint &&
            evidence.expectedReason === item.expectedReason && evidence.slice === item.slice;
        });
        if (active?.status === 'accepted' && accepted && !loop.candidateVersionId && liveEvidence) {
          classification = { loopId: loop.id, activeVersionId: active.id, reason: classify(input, active.rules).reason };
        }
      } catch { /* The observed failure can still be retained without a prediction. */ }
    }
    const observation = { operationId, input, executionOutcome, receiptFailure: true as const, suggestedReason: suggestion(input) };
    try { await this.inbox.record(owner, { ...observation, ...(classification ? { classification } : {}) }); }
    catch (error) {
      // A binding can change while we load the accepted version. Preserve the
      // actual receipt and drop only its now-stale prediction.
      if (classification && error instanceof RsiFailureInboxError && error.code === 'rsi_inbox_binding_required') await this.inbox.record(owner, observation);
      else throw error;
    }
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.pending]); }
}
let configured: RsiFailureObserver | undefined;
export function observeRsiPlatformFailure(req: Request, operation: PlatformOperation, result: PlatformOperationResult): void {
  (configured ??= new RsiFailureObserver()).capture(req, operation, result);
}
export function configureRsiFailureObserverForTests(observer?: RsiFailureObserver): void { configured = observer; }
export async function flushRsiPlatformFailures(): Promise<void> { await configured?.flush(); }
