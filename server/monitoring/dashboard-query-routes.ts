import type { Router } from 'express';
import { queryMetricRanges } from '../observability/ai-ecosystem-metrics-store.js';
import { clientErrorCode, requireObservabilityAccess, requireOpsMutationGuard } from './observability-route-kit.js';
import { DashboardQueryError, queryDashboardPanel, type DashboardQueryDependencies } from './dashboard-query.js';
import { listDashboardTemplates } from './dashboard-templates.js';

export function registerDashboardQueryRoutes(router: Router, dependencies: Partial<DashboardQueryDependencies> = {}): void {
  const noStore = (_req: unknown, res: { setHeader: (name: string, value: string) => unknown }, next: () => void) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  router.get('/api/ops/observability/boards/templates', noStore, requireObservabilityAccess, (_req, res) => {
    res.json({ ok: true, templates: listDashboardTemplates() });
  });
  router.post('/api/ops/observability/boards/query', noStore, requireObservabilityAccess, requireOpsMutationGuard, async (req, res) => {
    try {
      const result = await queryDashboardPanel(req.body, { queryMetric: queryMetricRanges, ...dependencies });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error instanceof DashboardQueryError ? error.status : 503).json({ ok: false, error: clientErrorCode(error, 'board_query_unavailable') });
    }
  });
}
