/**
 * DSH-native observability action queue.
 *
 * This is deliberately a small HTTP adapter around the action state machine.
 * It does not create an Agent/Moss runtime and it never accepts a command from
 * the browser.  Device/service side effects remain behind the existing
 * allowlisted remediation playbooks.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { getSessionSsoUser, isMultiUserWebDeployment, resolveChatPrincipalAccountId, } from './observability-access-adapter.js';
import { isOpsAdminRequest } from './observability-access.js';
import { applyActionVerification, claimObservabilityAction, completeReadOnlyObservabilityAction, decideObservabilityAction, ensureObservabilityActionSchema, executeClaimedObservabilityAction, getObservabilityActionForScopes, insertObservabilityAction, issueObservabilityEvidenceProof, listObservabilityActionsForScopes, markActionRegression, proposeObservabilityAction, updateObservabilityAction, verifyObservabilityEvidenceProof, } from './observability-action-loop.js';
import { ensureRemediationSchema, getRemediationRun, requestRemediation, } from './alert-remediation.js';
import { loadAlertConfig } from './alert-config.js';
import { getPostgresDashboardPool } from './postgres-dashboard-store.js';
import { getOpsEventDetail } from './observability-store.js';
import { recordOpsEvent } from './ops-event-store.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';
import { opaqueObservabilityRef } from './observability-opaque-ref.js';
import { authorizeTelemetryAccess, } from '../observability/governance-access-control.js';
const ACTION_ID_PATTERN = /^action-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_REF_PATTERN = /^event:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_EVIDENCE_REFS = 32;
const ACTION_RUN_LOOKUP_GRACE_MS = 2 * 60_000;
const ACTION_GOVERNANCE_PERMISSION = 'telemetry.read';
function cleanIdentity(value, max = 256) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, '')
        .trim()
        .slice(0, max);
}
function body(req) {
    return req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
}
/**
 * The public dashboard currently has only opaque event refs.  A caller cannot
 * safely bind those refs to a raw run id because the detail endpoint exposes
 * only a redacted run reference.  Reject a client-supplied binding until a
 * server-only correlation lookup is available; accepting it would let a
 * legitimate event be attributed to an unrelated run in the audit trail.
 */
function clientRunBinding(input) {
    const requested = cleanIdentity(input.runId, 256);
    if (requested)
        throw new Error('action_run_binding_unavailable');
    return null;
}
function normalizeActionScope(value) {
    const raw = cleanIdentity(value, 256);
    if (!raw)
        return '';
    const accountId = raw.startsWith('studio:') ? raw.slice('studio:'.length) : raw;
    if (!accountId || ['*', 'all', 'any', 'anonymous'].includes(accountId.toLowerCase())) {
        return '';
    }
    return `studio:${accountId}`;
}
function actionAuthorizationRevision(req, actorId) {
    // Bind the governance decision to the authenticated session/token without
    // persisting the credential itself. This is only a stale-authorization
    // guard; account scope still comes from the server-side principal below.
    const sessionMaterial = String(req.header('cookie') ?? req.header('x-admin-token') ?? 'no-session-material').slice(0, 8_192);
    return createHash('sha256')
        .update(`observability-action-authorization-v1\0${actorId}\0${sessionMaterial}`)
        .digest('base64url');
}
function resolveActionActor(req) {
    if (!isOpsAdminRequest(req))
        return null;
    const user = getSessionSsoUser(req);
    // A multi-tenant admin token is sufficient for the legacy read-only ops
    // surface, but it is not an account identity.  Do not let the action API
    // invent `operator-token` and then issue proofs for a real user's events:
    // without an SSO subject there is no safe ownership/entitlement mapping.
    // Single-user desktop/self-host deployments keep their explicit local
    // operator scope below.
    if (isMultiUserWebDeployment() && !cleanIdentity(user?.id))
        return null;
    let accountId = cleanIdentity(user?.id);
    if (!accountId) {
        accountId = cleanIdentity(resolveChatPrincipalAccountId(req));
    }
    // A single-user desktop/self-host process has no SSO principal.  Keep its
    // action history isolated from any web-cloud account and from arbitrary
    // request body claims.  A token-only web-cloud operator gets a distinct,
    // stable operator scope as well.
    if (!accountId || accountId === 'anonymous') {
        accountId = isMultiUserWebDeployment() ? 'operator-token' : 'local-operator';
    }
    const accountScopeId = normalizeActionScope(accountId);
    if (!accountScopeId)
        return null;
    const actorId = cleanIdentity(user?.id || user?.email) || accountId;
    // Keep the action API tenant-isolated while the entitlement model is being
    // finalized: every request is authorized only for its authenticated scope.
    // The shared governance decision makes that invariant explicit and prevents
    // a future query from accidentally treating a client-supplied scope as an
    // administrator grant.
    const governanceActor = {
        actorId,
        role: 'account_owner',
        authenticatedAccountScopeId: accountScopeId,
        entitledAccountScopeIds: [accountScopeId],
        permissions: [ACTION_GOVERNANCE_PERMISSION],
        authorizationRevision: actionAuthorizationRevision(req, actorId),
    };
    const decision = authorizeTelemetryAccess(governanceActor, {
        permission: ACTION_GOVERNANCE_PERMISSION,
        selectedAccountScopeId: accountScopeId,
    });
    if (!decision.allowed)
        return null;
    return {
        actorId,
        accountScopeId,
        allowedAccountScopeIds: [decision.accountScopeId],
        isSessionUser: Boolean(user?.id),
    };
}
function sameOrigin(req) {
    const origin = cleanIdentity(req.header('origin'), 512);
    if (!origin)
        return true;
    try {
        return new URL(origin).host === req.get('host');
    }
    catch {
        return false;
    }
}
const requireActionAccess = (req, res, next) => {
    if (!resolveActionActor(req)) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
    }
    next();
};
const requireActionContext = (req, res, next) => {
    if (req.header('x-rdk-ops-action') !== 'observability-context' || !sameOrigin(req)) {
        res.status(400).json({ ok: false, error: 'invalid_observability_context' });
        return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
};
const requireActionMutation = (req, res, next) => {
    if (req.header('x-rdk-ops-action') !== 'observability' || !sameOrigin(req)) {
        res.status(400).json({ ok: false, error: 'invalid_observability_mutation' });
        return;
    }
    next();
};
function safeActionId(value) {
    const id = cleanIdentity(value, 128);
    return ACTION_ID_PATTERN.test(id) ? id : null;
}
function safeErrorCode(error, fallback) {
    const raw = error instanceof Error ? error.message : '';
    return /^[a-z][a-z0-9_]{2,80}$/.test(raw) ? raw : fallback;
}
function actionStoreReady(options) {
    return Boolean(options.getPool || String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim());
}
async function openActionPool(options) {
    if (!actionStoreReady(options))
        throw new Error('action_store_unavailable');
    const pool = await (options.getPool ?? getPostgresDashboardPool)();
    await ensureObservabilityActionSchema(pool);
    return pool;
}
function eventUserRef(accountId) {
    return opaqueObservabilityRef(accountId, 'user') ?? '';
}
/**
 * Only event refs can be issued by this public adapter.  Other ref kinds are
 * still supported by the pure action module for server-side copilot packets,
 * but accepting guessed incident/trace strings here would turn the proof into
 * an authorization oracle.
 */
async function validateEvidenceRefs(refs, actor, options) {
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_EVIDENCE_REFS) {
        throw new Error('action_evidence_required');
    }
    const normalized = [...new Set(refs.map((ref) => cleanIdentity(ref, 180)))];
    if (normalized.some((ref) => !EVENT_REF_PATTERN.test(ref))) {
        throw new Error('action_evidence_ref_unsupported');
    }
    const readEvent = options.getEventDetail ?? getOpsEventDetail;
    const currentEnvironment = resolveStudioTraceStoreEnvironment();
    for (const ref of normalized) {
        const match = EVENT_REF_PATTERN.exec(ref);
        if (!match)
            throw new Error('action_evidence_ref_invalid');
        const detail = await readEvent(match[1]);
        if (!detail)
            throw new Error('action_evidence_not_found');
        // The event store stamps this field from server configuration at ingest.
        // Never fall back to client metadata or the current process when a legacy
        // row is missing it: an unscoped event must not authorize a cross-
        // environment action.
        if (detail.event.environment !== currentEnvironment) {
            throw new Error('action_evidence_not_found');
        }
        // In a multi-tenant SSO request, an event with a known user correlation
        // must belong to an explicitly authorized scope.  The current default
        // allowlist contains only the authenticated scope; future entitlement
        // configuration must flow through resolveActionActor rather than a body
        // field. Missing correlation is rejected rather than widening a proof.
        if (isMultiUserWebDeployment()) {
            const allowedUserRefs = new Set(actor.allowedAccountScopeIds.map((scope) => eventUserRef(scope.replace(/^studio:/, ''))));
            if (!detail.context.user ||
                !allowedUserRefs.has(detail.context.user.ref)) {
                throw new Error('action_evidence_not_found');
            }
        }
    }
    return { refs: normalized, environment: currentEnvironment };
}
function writeAudit(action, actor, record) {
    void recordOpsEvent({
        component: 'observability-action',
        eventCode: action,
        outcome: 'ok',
        severityHint: record.type === 'remediate' ? 'warning' : 'info',
        safeSummary: `DSH observability action ${action}`,
        metadata: { action_id: record.id, action_type: record.type, status: record.status },
        correlation: { userId: actor.actorId },
    }).catch(() => undefined);
}
function remediationPool(pool) {
    // Both repositories use the same pg client.  The remediation type also
    // includes `end()` for its short-lived callers; verification only queries,
    // so this structural adapter deliberately does not close the shared pool.
    return pool;
}
function failedClaimRecord(action, error) {
    const finishedAt = new Date().toISOString();
    const code = safeErrorCode(error, 'action_execution_failed');
    const playbookId = action.playbookId ?? 'unknown';
    return {
        ...action,
        status: 'failed',
        updatedAt: finishedAt,
        execution: {
            accepted: false,
            startedAt: action.execution?.startedAt ?? action.updatedAt,
            finishedAt,
            playbookId,
            request: { accepted: false, error: code },
            error: code,
        },
        regressionMarker: action.regressionMarker ?? 'action-execution-error',
    };
}
async function persistClaimFailure(pool, action, error) {
    try {
        return await updateObservabilityAction(pool, failedClaimRecord(action, error), 'executing');
    }
    catch {
        // The response still reports the original failure. A later operator can
        // recover the row if the database itself was unavailable during cleanup.
        return null;
    }
}
export function createObservabilityActionRouter(options = {}) {
    const router = Router();
    router.post('/api/ops/observability/actions/evidence-proof', requireActionAccess, requireActionMutation, async (req, res) => {
        const actor = resolveActionActor(req);
        if (!actor)
            return;
        try {
            const input = body(req);
            const requestedRunId = clientRunBinding(input);
            const evidence = await validateEvidenceRefs(input.evidenceRefs, actor, options);
            const proof = issueObservabilityEvidenceProof({
                accountScopeIds: [actor.accountScopeId],
                evidenceRefs: evidence.refs,
                environment: evidence.environment,
                runId: requestedRunId,
            });
            res.setHeader('Cache-Control', 'no-store');
            res
                .status(201)
                .json({
                ok: true,
                evidenceRefs: evidence.refs,
                environment: evidence.environment,
                runId: requestedRunId,
                evidenceProof: proof,
            });
        }
        catch (error) {
            res
                .status(400)
                .json({ ok: false, error: safeErrorCode(error, 'action_evidence_proof_failed') });
        }
    });
    router.get('/api/ops/observability/actions', requireActionAccess, requireActionContext, async (req, res) => {
        const actor = resolveActionActor(req);
        if (!actor)
            return;
        try {
            const pool = await openActionPool(options);
            const actions = await listObservabilityActionsForScopes(pool, [...actor.allowedAccountScopeIds], Number(req.query.limit));
            res.setHeader('Cache-Control', 'no-store');
            res.json({ ok: true, actions });
        }
        catch (error) {
            res
                .status(503)
                .json({ ok: false, error: safeErrorCode(error, 'action_store_unavailable') });
        }
    });
    router.post('/api/ops/observability/actions', requireActionAccess, requireActionMutation, async (req, res) => {
        const actor = resolveActionActor(req);
        if (!actor)
            return;
        try {
            const input = body(req);
            const runId = clientRunBinding(input);
            const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [];
            const environment = resolveStudioTraceStoreEnvironment();
            if (!verifyObservabilityEvidenceProof(input.evidenceProof, {
                accountScopeId: actor.accountScopeId,
                evidenceRefs,
                environment,
                runId,
            })) {
                throw new Error('action_evidence_proof_invalid');
            }
            const action = proposeObservabilityAction({
                accountScopeId: actor.accountScopeId,
                environment,
                runId,
                type: cleanIdentity(input.type, 32),
                title: cleanIdentity(input.title, 240),
                rationale: cleanIdentity(input.rationale, 500),
                playbookId: cleanIdentity(input.playbookId, 96) || null,
                evidenceRefs,
                requiresApproval: typeof input.requiresApproval === 'boolean' ? input.requiresApproval : undefined,
                proposedBy: actor.actorId,
            });
            const pool = await openActionPool(options);
            await insertObservabilityAction(pool, action);
            writeAudit('action_proposed', actor, action);
            res.status(201).json({ ok: true, action });
        }
        catch (error) {
            const code = safeErrorCode(error, 'invalid_action');
            res
                .status(code === 'action_store_unavailable' ? 503 : 400)
                .json({ ok: false, error: code });
        }
    });
    router.get('/api/ops/observability/actions/:id', requireActionAccess, requireActionContext, async (req, res) => {
        const actor = resolveActionActor(req);
        const id = safeActionId(req.params.id);
        if (!actor)
            return;
        if (!id) {
            res.status(400).json({ ok: false, error: 'invalid_action_id' });
            return;
        }
        try {
            const action = await getObservabilityActionForScopes(await openActionPool(options), id, [...actor.allowedAccountScopeIds]);
            if (!action) {
                res.status(404).json({ ok: false, error: 'action_not_found' });
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.json({ ok: true, action });
        }
        catch (error) {
            res
                .status(503)
                .json({ ok: false, error: safeErrorCode(error, 'action_store_unavailable') });
        }
    });
    router.post('/api/ops/observability/actions/:id/decision', requireActionAccess, requireActionMutation, async (req, res) => {
        await transitionAction(req, res, options, 'decision');
    });
    router.post('/api/ops/observability/actions/:id/complete', requireActionAccess, requireActionMutation, async (req, res) => {
        await transitionAction(req, res, options, 'complete');
    });
    router.post('/api/ops/observability/actions/:id/execute', requireActionAccess, requireActionMutation, async (req, res) => {
        const actor = resolveActionActor(req);
        const id = safeActionId(req.params.id);
        if (!actor)
            return;
        if (!id) {
            res.status(400).json({ ok: false, error: 'invalid_action_id' });
            return;
        }
        let pool;
        let claimed = null;
        try {
            pool = await openActionPool(options);
            const current = await getObservabilityActionForScopes(pool, id, [...actor.allowedAccountScopeIds]);
            if (!current) {
                res.status(404).json({ ok: false, error: 'action_not_found' });
                return;
            }
            // Resolve configuration before claiming. A config/store failure must
            // not leave a durable action in `executing` with no execution record.
            const config = await (options.getAlertConfig ?? loadAlertConfig)();
            const execute = options.executeRemediation ??
                ((cfg, playbookId, triggeredBy) => requestRemediation(cfg, playbookId, 'manual', triggeredBy));
            // The CAS claim happens before requestRemediation.  This is the key
            // difference from the old Moss-era route, which claimed after the
            // side effect and could launch two concurrent playbooks.
            claimed = await claimObservabilityAction(pool, current);
            if (!claimed) {
                res.status(409).json({ ok: false, error: 'action_state_conflict' });
                return;
            }
            const result = await executeClaimedObservabilityAction(claimed, {
                executePlaybook: (playbookId, action) => execute(config, playbookId, action.approvedBy ?? actor.actorId),
            });
            const persisted = await updateObservabilityAction(pool, result.action, 'executing');
            writeAudit('action_execute', actor, persisted);
            const pending = persisted.status === 'executing';
            const ok = pending || persisted.status === 'succeeded';
            res.status(pending ? 202 : ok ? 200 : 409).json({
                ok,
                pending,
                ...(ok ? {} : { error: 'action_execution_failed' }),
                action: persisted,
                verification: result.verification,
            });
        }
        catch (error) {
            if (pool && claimed) {
                const recovered = await persistClaimFailure(pool, claimed, error);
                if (recovered) {
                    writeAudit('action_execute_failed', actor, recovered);
                    res.status(409).json({
                        ok: false,
                        error: safeErrorCode(error, 'action_execution_rejected'),
                        action: recovered,
                    });
                    return;
                }
            }
            const code = safeErrorCode(error, 'action_execution_rejected');
            res
                .status(code === 'action_store_unavailable' ? 503 : 409)
                .json({ ok: false, error: code });
        }
    });
    router.post('/api/ops/observability/actions/:id/verify', requireActionAccess, requireActionMutation, async (req, res) => {
        const actor = resolveActionActor(req);
        const id = safeActionId(req.params.id);
        if (!actor)
            return;
        if (!id) {
            res.status(400).json({ ok: false, error: 'invalid_action_id' });
            return;
        }
        try {
            const pool = await openActionPool(options);
            const current = await getObservabilityActionForScopes(pool, id, [...actor.allowedAccountScopeIds]);
            if (!current) {
                res.status(404).json({ ok: false, error: 'action_not_found' });
                return;
            }
            const executionRunId = current.execution?.runId;
            if (!executionRunId)
                throw new Error('action_execution_run_missing');
            await ensureRemediationSchema(remediationPool(pool));
            const run = await getRemediationRun(remediationPool(pool), executionRunId);
            const startedAt = Date.parse(current.execution?.startedAt ?? '');
            const missingBeyondGrace = !run &&
                (!Number.isFinite(startedAt) || Date.now() - startedAt >= ACTION_RUN_LOOKUP_GRACE_MS);
            const terminal = Boolean((run && ['succeeded', 'failed', 'rejected'].includes(run.status)) || missingBeyondGrace);
            const verification = {
                ok: run?.status === 'succeeded',
                pending: !terminal,
                checkedAt: new Date().toISOString(),
                detail: run
                    ? `remediation run ${run.status}`
                    : missingBeyondGrace
                        ? 'exact remediation run is still missing after the lookup grace period'
                        : 'exact remediation run is not visible yet',
                checks: [
                    {
                        name: 'remediation-run',
                        ok: run?.status === 'succeeded',
                        detail: run?.summary ?? (missingBeyondGrace ? 'run_missing' : 'pending'),
                    },
                ],
            };
            const next = applyActionVerification(current, verification);
            const persisted = await updateObservabilityAction(pool, next, current.status);
            writeAudit('action_post_check', actor, persisted);
            const pending = persisted.status === 'executing';
            const ok = pending || verification.ok;
            res.status(pending ? 202 : ok ? 200 : 409).json({
                ok,
                pending,
                ...(ok ? {} : { error: 'action_verification_failed' }),
                action: persisted,
                verification,
            });
        }
        catch (error) {
            const code = safeErrorCode(error, 'action_verification_rejected');
            res
                .status(code === 'action_store_unavailable' ? 503 : 409)
                .json({ ok: false, error: code });
        }
    });
    router.post('/api/ops/observability/actions/:id/regression', requireActionAccess, requireActionMutation, async (req, res) => {
        const actor = resolveActionActor(req);
        const id = safeActionId(req.params.id);
        if (!actor)
            return;
        if (!id) {
            res.status(400).json({ ok: false, error: 'invalid_action_id' });
            return;
        }
        try {
            const pool = await openActionPool(options);
            const current = await getObservabilityActionForScopes(pool, id, [...actor.allowedAccountScopeIds]);
            if (!current) {
                res.status(404).json({ ok: false, error: 'action_not_found' });
                return;
            }
            const next = markActionRegression(current, cleanIdentity(body(req).marker, 160));
            const persisted = await updateObservabilityAction(pool, next, current.status);
            writeAudit('action_regression_marked', actor, persisted);
            res.json({ ok: true, action: persisted });
        }
        catch (error) {
            const code = safeErrorCode(error, 'regression_marker_rejected');
            res
                .status(code === 'action_store_unavailable' ? 503 : 409)
                .json({ ok: false, error: code });
        }
    });
    return router;
}
async function transitionAction(req, res, options, kind) {
    const actor = resolveActionActor(req);
    const id = safeActionId(req.params.id);
    if (!actor)
        return;
    if (!id) {
        res.status(400).json({ ok: false, error: 'invalid_action_id' });
        return;
    }
    try {
        const pool = await openActionPool(options);
        const current = await getObservabilityActionForScopes(pool, id, [...actor.allowedAccountScopeIds]);
        if (!current) {
            res.status(404).json({ ok: false, error: 'action_not_found' });
            return;
        }
        const next = kind === 'decision'
            ? decideObservabilityAction(current, cleanIdentity(body(req).decision, 16), actor.actorId)
            : completeReadOnlyObservabilityAction(current, actor.actorId);
        const persisted = await updateObservabilityAction(pool, next, current.status);
        writeAudit(kind === 'decision' ? 'action_decision' : 'action_completed', actor, persisted);
        res.json({ ok: true, action: persisted });
    }
    catch (error) {
        const code = safeErrorCode(error, kind === 'decision' ? 'action_decision_rejected' : 'action_completion_rejected');
        res.status(code === 'action_store_unavailable' ? 503 : 409).json({ ok: false, error: code });
    }
}
