/** 链路/事件证据域路由：AEAD run locator 明细（治理就绪闸门 + 审计）与运维事件详情。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  OPS_EVENT_ID_PATTERN,
  observabilityRequestCorrelationId,
  requireObservabilityAccess,
  requireOpsContextGuard,
  requireTelemetryGovernanceReadiness,
  resolveTraceAccess,
} from './observability-route-kit.js';
import { getOpsEventDetail } from './observability-store.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import { getRunObservability, RunObservabilityStoreUnavailableError } from '../observability/run-observability-service.js';
import { TelemetryAuditUnavailableError } from '../observability/governance-audit.js';
import { createCentralPostgresTelemetryAuditGuard } from '../observability/governance-postgres-audit-sink.js';
export function registerTraceRoutes(router: Router): void {
  /**
   * Scoped native Agent Run detail.  The locator is an AEAD token issued by
   * the server (the overview listing is the only producer); this endpoint
   * never accepts a raw run id and delegates redaction/tombstone filtering to
   * the DSH-safe run observability service.
   */
  router.get(
    '/api/ops/observability/runs/:locator',
    requireObservabilityAccess,
    requireOpsContextGuard,
    requireTelemetryGovernanceReadiness,
    async (req: Request, res: Response) => {
      const requestCorrelationId = observabilityRequestCorrelationId(req);
      const locator = String(req.params.locator ?? '')
        .trim()
        .slice(0, 4_096);
      const resolved = resolveTraceAccess(req, locator);
      const audit = createCentralPostgresTelemetryAuditGuard();
      const actor = resolved.actor;
      const auditScope = resolved.accountScopeId || 'unresolved-scope';

      if (!actor || !resolved.accessScope) {
        try {
          if (actor) {
            await audit.append({
              actorId: actor.actorId,
              actorRole: actor.role,
              accountScopeId: auditScope,
              action: 'access_denial',
              targetType: 'run',
              targetIdentifier: locator || 'invalid-locator',
              decision: 'denied',
              purposeCode: 'operations_trace_review',
              requestCorrelationId,
              result: 'denied',
            });
          }
          res.status(actor ? 404 : 401).json({
            ok: false,
            error: actor ? 'run_not_found' : 'authentication_required',
            requestCorrelationId,
          });
        } catch (error) {
          res.status(503).json({
            ok: false,
            error:
              error instanceof TelemetryAuditUnavailableError
                ? error.code
                : 'telemetry_audit_unavailable',
            retryable: true,
            requestCorrelationId,
          });
        }
        return;
      }

      try {
        await audit.append({
          actorId: actor.actorId,
          actorRole: actor.role,
          accountScopeId: auditScope,
          action: 'read',
          targetType: 'run',
          targetIdentifier: locator,
          decision: 'allowed',
          purposeCode: 'operations_trace_review',
          requestCorrelationId,
          result: 'authorized',
        });
        const result = await getRunObservability(locator, resolved.accessScope);
        if (result.status === 'not_found') {
          await audit.append({
            actorId: actor.actorId,
            actorRole: actor.role,
            accountScopeId: auditScope,
            action: 'read',
            targetType: 'run',
            targetIdentifier: locator,
            decision: 'denied',
            purposeCode: 'operations_trace_review',
            requestCorrelationId,
            result: 'denied',
          });
          res.status(404).json({
            ok: false,
            error: 'run_not_found',
            requestCorrelationId,
          });
          return;
        }
        await audit.append({
          actorId: actor.actorId,
          actorRole: actor.role,
          accountScopeId: auditScope,
          action: 'read',
          targetType: 'run',
          targetIdentifier: locator,
          decision: 'allowed',
          purposeCode: 'operations_trace_review',
          requestCorrelationId,
          result: 'completed',
        });
        if (result.detail.advancedExport.availability === 'available') {
          try {
            await audit.append({
              actorId: actor.actorId,
              actorRole: actor.role,
              accountScopeId: auditScope,
              action: 'advanced_link',
              targetType: 'trace',
              targetIdentifier: result.detail.run.runRef,
              decision: 'allowed',
              purposeCode: 'operations_trace_review',
              requestCorrelationId,
              result: 'completed',
            });
          } catch {
            // Keep the local low-sensitivity detail, but fail closed for an
            // optional external destination that was not durably audited.
            result.detail.advancedExport = { availability: 'unavailable' };
          }
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail: result.detail, requestCorrelationId });
      } catch (error) {
        if (error instanceof TelemetryAuditUnavailableError) {
          res.status(503).json({
            ok: false,
            error: error.code,
            retryable: true,
            requestCorrelationId,
          });
          return;
        }
        if (error instanceof RunObservabilityStoreUnavailableError) {
          res.status(503).json({
            ok: false,
            error: error.code,
            retryable: true,
            requestCorrelationId,
          });
          return;
        }
        console.warn(
          '[run-observability] detail failed:',
          sanitizeOpsSummary(error, 180) || 'unknown_error',
        );
        res.status(500).json({
          ok: false,
          error: 'run_observability_failed',
          retryable: true,
          requestCorrelationId,
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/events/:eventId',
    requireObservabilityAccess,
    requireOpsContextGuard,
    async (req: Request, res: Response) => {
      const eventId = String(req.params.eventId ?? '').trim();
      if (!OPS_EVENT_ID_PATTERN.test(eventId)) {
        res.status(400).json({ ok: false, error: 'invalid_ops_event_id' });
        return;
      }
      try {
        const detail = await getOpsEventDetail(eventId);
        if (!detail) {
          res.status(404).json({ ok: false, error: 'ops_event_not_found' });
          return;
        }
        res.json({ ok: true, detail });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'ops_event_detail_failed'),
        });
      }
    },
  );
}
