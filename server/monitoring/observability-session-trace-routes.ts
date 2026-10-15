import type { Router, Request, Response } from 'express';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';
import { getSessionTraceList } from '../observability/session-trace-list-store.js';
import { InvalidTraceCursorError } from '../observability/run-trace-list-store.js';
import {
  requireObservabilityAccess,
  requireOpsContextGuard,
  requireTelemetryGovernanceReadiness,
  queryInteger,
  queryText,
  observabilityRequestCorrelationId,
} from './observability-route-kit.js';

export function registerSessionTraceRoutes(router: Router): void {
  router.get('/api/ops/observability/sessions', requireObservabilityAccess,
    requireOpsContextGuard, requireTelemetryGovernanceReadiness,
    async (req: Request, res: Response) => {
      const requestCorrelationId = observabilityRequestCorrelationId(req);
      const query = req.query as Record<string, unknown>;
      const environment = queryText(query, 'environment', 24) ?? 'production';
      if (!['production', 'staging', 'development', 'test'].includes(environment)) {
        res.status(400).json({ ok: false, error: 'invalid_trace_environment', requestCorrelationId });
        return;
      }
      try {
        const result = await getSessionTraceList({
          hours: queryInteger(query, 'hours', 24, 1, 168),
          environment: environment as StudioDeploymentEnvironment,
          limit: queryInteger(query, 'limit', 40, 1, 80),
          cursor: queryText(query, 'cursor', 4096),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, ...result, requestCorrelationId });
      } catch (error) {
        res.status(error instanceof InvalidTraceCursorError ? 400 : 503).json({
          ok: false,
          error: error instanceof InvalidTraceCursorError ? error.code : 'session_trace_unavailable',
          retryable: !(error instanceof InvalidTraceCursorError),
          requestCorrelationId,
        });
      }
    });
}
