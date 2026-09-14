/**
 * Evidence-first AI SRE action loop.
 *
 * The copilot may propose an action, but only this module can transition it to
 * execution.  The state machine is deliberately small and fail-closed:
 * unknown playbooks, missing evidence, account mismatches, stale approvals and
 * arbitrary commands are rejected before any side effect is attempted.
 */
import { randomUUID } from 'node:crypto';
import {
  getRemediationPlaybook,
  isRemediationPlaybookActionEnabled,
  requestRemediation,
  type RemediationRequestResult,
} from './alert-remediation.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import {
  MAX_REFS,
  REF_PATTERN,
} from './observability-action-proof.js';

export {
  MAX_REFS,
  OBSERVABILITY_EVIDENCE_PROOF_TTL_MS,
  REF_PATTERN,
  issueObservabilityEvidenceProof,
  verifyObservabilityEvidenceProof,
} from './observability-action-proof.js';
export { ensureObservabilityActionSchema } from './observability-action-schema.js';
export { resetObservabilityActionSchemaReadinessForTest } from './observability-action-schema.js';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';

export type ObservabilityActionType = 'investigate' | 'observe' | 'escalate' | 'remediate';
export type ObservabilityActionStatus =
  | 'pending_approval'
  | 'approved'
  | 'denied'
  | 'completed'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'verification_failed';
export type ObservabilityActionDecision = 'approve' | 'deny';
export type ObservabilityActionEnvironment = StudioDeploymentEnvironment;

const ACTION_ENVIRONMENTS: readonly ObservabilityActionEnvironment[] = [
  'production',
  'staging',
  'development',
  'test',
];

/** Resolve deployment scope from server configuration, never from HTTP body data. */
export function resolveObservabilityActionEnvironment(value?: unknown): ObservabilityActionEnvironment {
  const requested = String(value ?? '').trim().toLowerCase();
  if (ACTION_ENVIRONMENTS.includes(requested as ObservabilityActionEnvironment)) {
    return requested as ObservabilityActionEnvironment;
  }
  const configured = String(process.env.RDK_OBSERVABILITY_ENVIRONMENT ?? '').trim().toLowerCase();
  if (ACTION_ENVIRONMENTS.includes(configured as ObservabilityActionEnvironment)) {
    return configured as ObservabilityActionEnvironment;
  }
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

export interface ObservabilityActionVerification {
  ok: boolean;
  /** The exact remediation run is still running (or not visible yet). */
  pending?: boolean;
  checkedAt: string;
  detail: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface ObservabilityActionExecution {
  accepted: boolean;
  runId?: string;
  startedAt: string;
  finishedAt: string | null;
  playbookId: string;
  request: RemediationRequestResult;
  verification?: ObservabilityActionVerification;
  error?: string;
}

export interface ObservabilityActionRecord {
  id: string;
  accountScopeId: string;
  environment: ObservabilityActionEnvironment;
  runId: string | null;
  type: ObservabilityActionType;
  title: string;
  rationale: string;
  playbookId: string | null;
  evidenceRefs: string[];
  requiresApproval: boolean;
  status: ObservabilityActionStatus;
  proposedBy: string;
  approvedBy: string | null;
  /** Short-lived authorization window; it never extends beyond the proposal TTL. */
  approvalExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  execution: ObservabilityActionExecution | null;
  regressionMarker: string | null;
  /** Optimistic-concurrency revision for every durable state transition. */
  revision: number;
}

export interface ActionProposalInput {
  accountScopeId: string;
  /** Server-derived deployment scope; HTTP callers must not provide this. */
  environment?: ObservabilityActionEnvironment;
  runId?: string | null;
  type: ObservabilityActionType;
  title: string;
  rationale?: string;
  playbookId?: string | null;
  evidenceRefs: string[];
  requiresApproval?: boolean;
  proposedBy: string;
}

export interface ActionExecutionResult {
  action: ObservabilityActionRecord;
  verification: ObservabilityActionVerification;
}

/**
 * An approval is a short-lived authorization, not a standing permission.  The
 * value is intentionally exported so the UI and focused tests can explain the
 * same expiry window without duplicating a magic number.
 */
export const OBSERVABILITY_ACTION_APPROVAL_TTL_MS = 15 * 60_000;

/** Apply an independently collected post-check. This is intentionally separate
 * from executeApprovedObservabilityAction so a no-block systemd launch can be
 * verified by a later worker/HTTP request against fresh telemetry. */
export function applyActionVerification(
  action: ObservabilityActionRecord,
  verification: ObservabilityActionVerification,
): ObservabilityActionRecord {
  if (action.status !== 'executing') {
    throw new Error('action_not_awaiting_verification');
  }
  const execution = action.execution;
  if (!execution) throw new Error('action_execution_missing');
  if (verification.pending && !verification.ok && action.status === 'executing') {
    // A queued/no-block playbook is not a failure. Keep the action open until
    // the exact remediation run reaches a terminal state, with no fabricated
    // finish time or regression marker.
    return {
      ...action,
      status: 'executing',
      updatedAt: nowIso(),
      execution: { ...execution, finishedAt: null, verification },
    };
  }
  const status: ObservabilityActionStatus = verification.ok ? 'succeeded' : 'verification_failed';
  const finishedAt = nowIso();
  return {
    ...action,
    status,
    updatedAt: nowIso(),
    execution: { ...execution, finishedAt, verification },
    regressionMarker: verification.ok
      ? action.regressionMarker
      : (action.regressionMarker ?? 'post-check-failed'),
  };
}

const MAX_TEXT = 500;
const REMEDIATION_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, max = MAX_TEXT): string {
  return sanitizeOpsSummary(value, max).trim();
}

function cleanRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.map((item) => text(item, 180)).filter((item) => REF_PATTERN.test(item))),
  ].slice(0, MAX_REFS);
}

function validateRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs = value.map((item) => text(item, 180));
  if (refs.some((ref) => !REF_PATTERN.test(ref))) throw new Error('action_evidence_ref_invalid');
  return [...new Set(refs)].slice(0, MAX_REFS);
}

function nowIso(): string {
  return new Date().toISOString();
}

function validRemediationRunId(value: unknown): value is string {
  return typeof value === 'string' && REMEDIATION_RUN_ID_PATTERN.test(value.trim());
}

export function isObservabilityActionApprovalExpired(
  action: Pick<ObservabilityActionRecord, 'createdAt'> &
    Partial<Pick<ObservabilityActionRecord, 'approvalExpiresAt'>>,
  now = new Date(),
): boolean {
  const createdAt = Date.parse(String(action.createdAt ?? ''));
  const nowMs = now.getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(nowMs)) return true;
  const explicitExpiry = Date.parse(String(action.approvalExpiresAt ?? ''));
  const derivedExpiry = createdAt + OBSERVABILITY_ACTION_APPROVAL_TTL_MS;
  // Never let a malformed/legacy explicit value extend the original proposal
  // window. The earlier of the two deadlines is authoritative.
  const expiry = Number.isFinite(explicitExpiry)
    ? Math.min(explicitExpiry, derivedExpiry)
    : derivedExpiry;
  return nowMs >= expiry;
}

const transitions: Record<ObservabilityActionStatus, readonly ObservabilityActionStatus[]> = {
  pending_approval: ['approved', 'denied'],
  approved: ['executing', 'denied', 'completed'],
  denied: [],
  completed: [],
  executing: ['succeeded', 'failed', 'verification_failed'],
  succeeded: [],
  failed: [],
  verification_failed: [],
};

export function canTransitionAction(
  from: ObservabilityActionStatus,
  to: ObservabilityActionStatus,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function proposeObservabilityAction(input: ActionProposalInput): ObservabilityActionRecord {
  const accountScopeId = text(input.accountScopeId, 256);
  const environment = resolveObservabilityActionEnvironment(input.environment);
  const proposedBy = text(input.proposedBy, 256);
  const title = text(input.title, 240);
  const rationale = text(input.rationale ?? '', MAX_TEXT);
  const evidenceRefs = validateRefs(input.evidenceRefs);
  if (!accountScopeId || !proposedBy || !title) throw new Error('action_identity_required');
  if (!evidenceRefs.length) throw new Error('action_evidence_required');
  if (!['investigate', 'observe', 'escalate', 'remediate'].includes(input.type)) {
    throw new Error('action_type_invalid');
  }
  const playbookId = input.playbookId ? text(input.playbookId, 96) : null;
  if (input.type === 'remediate') {
    if (
      !playbookId ||
      !getRemediationPlaybook(playbookId) ||
      !isRemediationPlaybookActionEnabled(playbookId)
    ) {
      throw new Error('action_playbook_not_allowed');
    }
  } else if (playbookId) {
    throw new Error('action_playbook_type_mismatch');
  }
  const createdAt = nowIso();
  // Remediation and escalation are always approval-gated. Read-only
  // investigate/observe actions may be auto-approved only when explicitly
  // marked as such by the caller.
  const requiresApproval =
    input.type === 'remediate' || input.type === 'escalate' || input.requiresApproval !== false;
  const approvalExpiresAt = new Date(
    Date.parse(createdAt) + OBSERVABILITY_ACTION_APPROVAL_TTL_MS,
  ).toISOString();
  return {
    id: `action-${randomUUID()}`,
    accountScopeId,
    environment,
    runId: input.runId ? text(input.runId, 256) : null,
    type: input.type,
    title,
    rationale,
    playbookId,
    evidenceRefs,
    requiresApproval,
    status: requiresApproval ? 'pending_approval' : 'approved',
    proposedBy,
    approvedBy: requiresApproval ? null : proposedBy,
    approvalExpiresAt,
    createdAt,
    updatedAt: createdAt,
    execution: null,
    regressionMarker: null,
    revision: 0,
  };
}

export function decideObservabilityAction(
  action: ObservabilityActionRecord,
  decision: ObservabilityActionDecision,
  actorId: string,
): ObservabilityActionRecord {
  const actor = text(actorId, 256);
  if (!actor) throw new Error('action_decider_required');
  if (action.status !== 'pending_approval') throw new Error('action_not_pending_approval');
  if (isObservabilityActionApprovalExpired(action)) {
    throw new Error('action_approval_expired');
  }
  if (action.proposedBy === actor && action.type === 'remediate') {
    throw new Error('action_separation_of_duties_required');
  }
  const status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : null;
  if (!status) throw new Error('action_decision_invalid');
  return {
    ...action,
    status,
    approvedBy: status === 'approved' ? actor : null,
    approvalExpiresAt: action.approvalExpiresAt,
    updatedAt: nowIso(),
  };
}

export function markActionRegression(
  action: ObservabilityActionRecord,
  marker: string,
): ObservabilityActionRecord {
  if (!['succeeded', 'failed', 'verification_failed'].includes(action.status)) {
    throw new Error('regression_action_outcome_required');
  }
  const value = text(marker, 160);
  if (!value) throw new Error('regression_marker_required');
  return { ...action, regressionMarker: value, updatedAt: nowIso() };
}

/**
 * Read-only and escalation actions still need an explicit close event so the
 * queue does not leave approved investigation work in an ambiguous state.
 * Closing is a bookkeeping transition only; it never starts a playbook or
 * touches a device.
 */
export function completeReadOnlyObservabilityAction(
  action: ObservabilityActionRecord,
  actorId: string,
): ObservabilityActionRecord {
  const actor = text(actorId, 256);
  if (!actor) throw new Error('action_completer_required');
  if (action.status !== 'approved') throw new Error('action_completion_requires_approval');
  if (action.type === 'remediate') throw new Error('action_completion_not_allowed');
  if (isObservabilityActionApprovalExpired(action)) throw new Error('action_approval_expired');
  return {
    ...action,
    // A bookkeeping close is not a verifier verdict. Keep it distinct from
    // `succeeded`, which is reserved for an action with a positive check.
    status: 'completed',
    approvedBy: action.approvedBy ?? actor,
    updatedAt: nowIso(),
  };
}

export interface ActionExecutionDeps {
  executePlaybook?: (
    playbookId: string,
    action: ObservabilityActionRecord,
  ) => Promise<RemediationRequestResult>;
  verify?: (
    action: ObservabilityActionRecord,
    request: RemediationRequestResult,
  ) => Promise<ObservabilityActionVerification>;
}

function assertExecutableAction(
  action: ObservabilityActionRecord,
  expectedStatus: 'approved' | 'executing',
): void {
  if (action.status !== expectedStatus) {
    throw new Error(
      expectedStatus === 'approved' ? 'action_approval_required' : 'action_claim_required',
    );
  }
  if (
    action.type !== 'remediate' ||
    !action.playbookId ||
    !getRemediationPlaybook(action.playbookId) ||
    !isRemediationPlaybookActionEnabled(action.playbookId)
  ) {
    throw new Error('action_execution_not_allowed');
  }
  // Never trust a forged/legacy durable row that claims `approved` without a
  // real approver. Remediation also has a strict separation-of-duties gate at
  // the side-effect boundary, so bypassing the decision route cannot let the
  // proposer approve their own destructive action.
  const approver = text(action.approvedBy, 256);
  const proposer = text(action.proposedBy, 256);
  if (!approver) throw new Error('action_approval_required');
  if (!proposer || approver === proposer) {
    throw new Error('action_separation_of_duties_required');
  }
  if (!action.evidenceRefs.length) throw new Error('action_evidence_required');
  if (isObservabilityActionApprovalExpired(action)) throw new Error('action_approval_expired');
}

const defaultVerify = async (
  _action: ObservabilityActionRecord,
  request: RemediationRequestResult,
): Promise<ObservabilityActionVerification> => ({
  // systemd --no-block only acknowledges that a unit was queued.  It is not a
  // health proof, so the action remains `executing` until the exact run is
  // checked by applyActionVerification.
  ok: false,
  checkedAt: nowIso(),
  detail: request.accepted
    ? '白名单剧本已被 systemd 接受，等待下一轮真实遥测确认'
    : '白名单剧本未被接受',
  checks: [
    {
      name: 'playbook-accepted',
      ok: request.accepted === true,
      detail: request.reason ?? request.error ?? 'accepted',
    },
  ],
});

async function executeClaimedAction(
  action: ObservabilityActionRecord,
  deps: ActionExecutionDeps,
): Promise<ActionExecutionResult> {
  const playbookId = action.playbookId;
  if (!playbookId) throw new Error('action_execution_not_allowed');
  const startedAt = action.execution?.startedAt ?? nowIso();
  const executing: ObservabilityActionRecord =
    action.status === 'executing'
      ? action
      : { ...action, status: 'executing', updatedAt: startedAt };
  const execute =
    deps.executePlaybook ??
    (async (playbookId) => {
      // requestRemediation only accepts the fixed playbook id and starts a
      // dedicated systemd oneshot; no command supplied by the caller crosses
      // this boundary.
      return requestRemediation(
        {
          global: {
            autoRemediation: false,
            remediationCooldownMinutes: 10,
            environmentLabel: 'observability-action',
          },
          notification: {
            channel: 'webhook',
            enabled: false,
            shadowMode: true,
            webhookUrl: '',
            feishuWebhookUrl: '',
            bearerSecret: '',
            feishuSignSecret: '',
            dashboardUrl: '',
          },
        } as any,
        playbookId,
        'manual',
        action.approvedBy ?? action.proposedBy,
      );
    });
  let request: RemediationRequestResult;
  try {
    request = await execute(playbookId, executing);
  } catch (error) {
    const failed: ObservabilityActionRecord = {
      ...executing,
      status: 'failed',
      updatedAt: nowIso(),
      execution: {
        accepted: false,
        startedAt,
        finishedAt: nowIso(),
        playbookId,
        request: { accepted: false, error: text(error, 240) },
      },
    };
    return {
      action: failed,
      verification: { ok: false, checkedAt: nowIso(), detail: '动作执行异常', checks: [] },
    };
  }
  if (request.accepted && !validRemediationRunId(request.runId)) {
    const checkedAt = nowIso();
    const invalidRequest: RemediationRequestResult = {
      ...request,
      error: request.error ?? 'remediation_run_id_missing',
    };
    const failed: ObservabilityActionRecord = {
      ...executing,
      status: 'failed',
      updatedAt: checkedAt,
      execution: {
        accepted: true,
        startedAt,
        finishedAt: checkedAt,
        playbookId,
        request: invalidRequest,
        error: 'remediation_run_id_missing',
      },
      regressionMarker: action.regressionMarker ?? 'remediation-run-untraceable',
    };
    return {
      action: failed,
      verification: {
        ok: false,
        checkedAt,
        detail: '自愈已返回接受但没有可追踪的 remediation runId',
        checks: [{ name: 'remediation-run-id', ok: false, detail: 'remediation_run_id_missing' }],
      },
    };
  }
  let verification: ObservabilityActionVerification;
  try {
    verification = await (deps.verify ?? defaultVerify)(executing, request);
  } catch (error) {
    const checkedAt = nowIso();
    const failed: ObservabilityActionRecord = {
      ...executing,
      status: 'verification_failed',
      updatedAt: checkedAt,
      execution: {
        accepted: request.accepted,
        runId: request.runId,
        startedAt,
        finishedAt: checkedAt,
        playbookId,
        request,
        error: text(error, 240) || 'remediation_verification_failed',
      },
      regressionMarker: action.regressionMarker ?? 'post-check-error',
    };
    return {
      action: failed,
      verification: {
        ok: false,
        checkedAt,
        detail: '自愈执行后的验收检查异常',
        checks: [
          { name: 'post-check', ok: false, detail: text(error, 240) || 'verification_failed' },
        ],
      },
    };
  }
  // A no-block launch is not proof that the service recovered. Keep the action
  // in executing until a server-side post-check observes the exact remediation
  // run; injected verifiers may complete it immediately in tests or workers.
  const status: ObservabilityActionStatus = !request.accepted
    ? 'failed'
    : deps.verify
      ? verification.pending && !verification.ok
        ? 'executing'
        : verification.ok
          ? 'succeeded'
          : 'verification_failed'
      : 'executing';
  const finishedAt = status === 'executing' ? null : nowIso();
  const completed: ObservabilityActionRecord = {
    ...executing,
    status,
    updatedAt: nowIso(),
    execution: {
      accepted: request.accepted,
      runId: request.runId,
      startedAt,
      finishedAt,
      playbookId,
      request,
      verification,
    },
    regressionMarker:
      deps.verify && !verification.ok
        ? (action.regressionMarker ?? 'post-check-failed')
        : action.regressionMarker,
  };
  return { action: completed, verification };
}

/**
 * Execute an approved action in the legacy single-request path.
 *
 * Callers that persist actions must prefer `claimObservabilityAction` followed
 * by `executeClaimedObservabilityAction`; this convenience function is retained
 * for pure callers/tests that do not have a store to claim against.
 */
export async function executeApprovedObservabilityAction(
  action: ObservabilityActionRecord,
  deps: ActionExecutionDeps = {},
): Promise<ActionExecutionResult> {
  assertExecutableAction(action, 'approved');
  const startedAt = nowIso();
  return executeClaimedAction({ ...action, status: 'executing', updatedAt: startedAt }, deps);
}

/** Execute an action after its durable `approved -> executing` claim succeeds. */
export async function executeClaimedObservabilityAction(
  action: ObservabilityActionRecord,
  deps: ActionExecutionDeps = {},
): Promise<ActionExecutionResult> {
  assertExecutableAction(action, 'executing');
  if (action.execution) throw new Error('action_execution_already_started');
  return executeClaimedAction(action, deps);
}

type PgResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
export type ActionStorePool = { query: (sql: string, params?: unknown[]) => Promise<PgResult> };

/**
 * Atomically claim an approved remediation before invoking systemd.
 *
 * The old route executed the playbook first and used a compare-and-swap update
 * afterwards. Two concurrent HTTP requests could therefore both reach the
 * side-effect boundary and only one would lose the later CAS. This helper is
 * deliberately a single conditional UPDATE: exactly one caller receives the
 * executing record, while losers get null and must not execute anything.
 */
export async function claimObservabilityAction(
  p: ActionStorePool,
  action: ObservabilityActionRecord,
): Promise<ObservabilityActionRecord | null> {
  assertExecutableAction(action, 'approved');
  const claimed: ObservabilityActionRecord = {
    ...action,
    status: 'executing',
    updatedAt: nowIso(),
    execution: null,
    revision: Math.max(0, Math.floor(Number(action.revision) || 0)) + 1,
  };
  const result = await p.query(
    `update public.studio_observability_actions
       set status=$5, approved_by=$6, approval_expires_at=$7, updated_at=$8,
           execution=$9::jsonb, regression_marker=$10, revision=$11
     where id=$1 and account_scope_id=$2 and environment=$3 and status=$4
       and revision=$12
       and created_at > now() - interval '15 minutes'
       and (approval_expires_at is null or approval_expires_at > now())
     returning id`,
    [
      claimed.id,
      claimed.accountScopeId,
      claimed.environment,
      'approved',
      claimed.status,
      claimed.approvedBy,
      claimed.approvalExpiresAt,
      claimed.updatedAt,
      null,
      claimed.regressionMarker,
      claimed.revision,
      Math.max(0, Math.floor(Number(action.revision) || 0)),
    ],
  );
  const affected = result.rowCount ?? result.rows.length;
  return affected > 0 ? claimed : null;
}

function rowToAction(row: Record<string, unknown>): ObservabilityActionRecord {
  return {
    id: String(row.id),
    accountScopeId: String(row.account_scope_id),
    environment: resolveObservabilityActionEnvironment(row.environment),
    runId: row.run_id ? String(row.run_id) : null,
    type: String(row.type) as ObservabilityActionType,
    title: String(row.title),
    rationale: String(row.rationale ?? ''),
    playbookId: row.playbook_id ? String(row.playbook_id) : null,
    evidenceRefs: cleanRefs(row.evidence_refs),
    requiresApproval: row.requires_approval !== false,
    status: String(row.status) as ObservabilityActionStatus,
    proposedBy: String(row.proposed_by),
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvalExpiresAt: row.approval_expires_at
      ? new Date(String(row.approval_expires_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    execution:
      row.execution && typeof row.execution === 'object'
        ? (row.execution as ObservabilityActionExecution)
        : null,
    regressionMarker: row.regression_marker ? String(row.regression_marker) : null,
    revision: Number.isFinite(Number(row.revision))
      ? Math.max(0, Math.floor(Number(row.revision)))
      : 0,
  };
}

export async function insertObservabilityAction(
  p: ActionStorePool,
  action: ObservabilityActionRecord,
): Promise<void> {
  await p.query(
    `insert into public.studio_observability_actions
    (id, account_scope_id, environment, run_id, type, title, rationale, playbook_id, evidence_refs, requires_approval, status, proposed_by, approved_by, approval_expires_at, created_at, updated_at, execution, regression_marker, revision)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)`,
    [
      action.id,
      action.accountScopeId,
      action.environment,
      action.runId,
      action.type,
      action.title,
      action.rationale,
      action.playbookId,
      JSON.stringify(action.evidenceRefs),
      action.requiresApproval,
      action.status,
      action.proposedBy,
      action.approvedBy,
      action.approvalExpiresAt,
      action.createdAt,
      action.updatedAt,
      action.execution ? JSON.stringify(action.execution) : null,
      action.regressionMarker,
      action.revision,
    ],
  );
}

export async function getObservabilityAction(
  p: ActionStorePool,
  id: string,
  accountScopeId: string,
  environment = resolveObservabilityActionEnvironment(),
): Promise<ObservabilityActionRecord | null> {
  const result = await p.query(
    `select * from public.studio_observability_actions
     where id=$1 and account_scope_id=$2 and environment=$3 limit 1`,
    [text(id, 128), text(accountScopeId, 256), environment],
  );
  return result.rows[0] ? rowToAction(result.rows[0]) : null;
}

export async function getObservabilityActionForScopes(
  p: ActionStorePool,
  id: string,
  accountScopeIds: string[],
  environment = resolveObservabilityActionEnvironment(),
): Promise<ObservabilityActionRecord | null> {
  const scopes = [...new Set(accountScopeIds.map((scope) => text(scope, 256)).filter(Boolean))];
  if (!scopes.length) return null;
  const result = await p.query(
    `select * from public.studio_observability_actions
     where id=$1 and account_scope_id = any($2::text[]) and environment=$3 limit 1`,
    [text(id, 128), scopes, environment],
  );
  return result.rows[0] ? rowToAction(result.rows[0]) : null;
}

export async function listObservabilityActions(
  p: ActionStorePool,
  accountScopeId: string,
  limit = 20,
  environment = resolveObservabilityActionEnvironment(),
): Promise<ObservabilityActionRecord[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const result = await p.query(
    `select * from public.studio_observability_actions
     where account_scope_id=$1 and environment=$2 order by created_at desc limit $3`,
    [text(accountScopeId, 256), environment, boundedLimit],
  );
  return result.rows.map(rowToAction);
}

export async function listObservabilityActionsForScopes(
  p: ActionStorePool,
  accountScopeIds: string[],
  limit = 20,
  environment = resolveObservabilityActionEnvironment(),
): Promise<ObservabilityActionRecord[]> {
  const scopes = [...new Set(accountScopeIds.map((scope) => text(scope, 256)).filter(Boolean))];
  if (!scopes.length) return [];
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  const result = await p.query(
    `select * from public.studio_observability_actions
     where account_scope_id = any($1::text[]) and environment=$2 order by created_at desc limit $3`,
    [scopes, environment, boundedLimit],
  );
  return result.rows.map(rowToAction);
}

export async function updateObservabilityAction(
  p: ActionStorePool,
  action: ObservabilityActionRecord,
  expectedStatus: ObservabilityActionStatus,
): Promise<ObservabilityActionRecord> {
  // Keep the pure state machine authoritative even for callers that bypass
  // the HTTP adapter. Same-status updates are used for pending verification
  // and regression markers; every other write must be an allowed edge.
  if (action.status !== expectedStatus && !canTransitionAction(expectedStatus, action.status)) {
    throw new Error('action_transition_invalid');
  }
  const expectedRevision = Math.max(0, Math.floor(Number(action.revision) || 0));
  const persistedRevision = expectedRevision + 1;
  const result = await p.query(
    `update public.studio_observability_actions
       set status=$5, approved_by=$6, approval_expires_at=$7, updated_at=$8,
           execution=$9::jsonb, regression_marker=$10, revision=$11
     where id=$1 and account_scope_id=$2 and environment=$3 and status=$4 and revision=$12
     returning id`,
    [
      action.id,
      action.accountScopeId,
      action.environment,
      expectedStatus,
      action.status,
      action.approvedBy,
      action.approvalExpiresAt,
      action.updatedAt,
      action.execution ? JSON.stringify(action.execution) : null,
      action.regressionMarker,
      persistedRevision,
      expectedRevision,
    ],
  );
  if (result.rowCount === 0 || (result.rowCount == null && result.rows.length === 0)) {
    throw new Error('action_state_conflict');
  }
  return { ...action, revision: persistedRevision };
}
