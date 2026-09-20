/** 洞察聚合域路由：学习/运营指标（flywheel 只读投影）与公共观测对象目录。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  queryBoolean,
  queryInteger,
  queryText,
  requireObservabilityAccess,
} from './observability-route-kit.js';
import { getPublicObservabilityStore } from '../public-api/public-observability-store.js';
import { getFlywheelObservation } from '../flywheel/flywheel-observation.js';
import { getFlywheelOverview } from '../flywheel/metrics-store.js';
import { getOperatorMetrics } from '../flywheel/operator-metrics-store.js';
export function registerInsightRoutes(router: Router): void {
  const publicObservabilityStore = getPublicObservabilityStore();
  /**
   * The old flywheel tabs still use these read-only aggregate endpoints.  Keep
   * them as best-effort projections so a missing legacy table degrades the
   * individual module instead of taking down the unified observability page.
   */
  router.get(
    '/api/ops/observability/learning',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const days = queryInteger(req.query as Record<string, unknown>, 'days', 30, 1, 90);
      const [skill, observation] = await Promise.allSettled([
        getFlywheelOverview(days),
        getFlywheelObservation(days),
      ]);
      const generatedAt = new Date().toISOString();
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        learning: {
          generatedAt,
          windowDays: days,
          skill:
            skill.status === 'fulfilled'
              ? { status: 'ok', overview: skill.value }
              : { status: 'unavailable' },
          observation:
            observation.status === 'fulfilled'
              ? observation.value
              : {
                  windowDays: days,
                  generatedAt,
                  experience: { status: 'unavailable' },
                  evolution: { status: 'unavailable' },
                },
        },
      });
    },
  );

  router.get(
    '/api/ops/observability/operator-metrics',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const days = queryInteger(req.query as Record<string, unknown>, 'days', 30, 1, 180);
      try {
        const metrics = await getOperatorMetrics(days);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          generatedAt: new Date().toISOString(),
          metrics,
        });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'operator_metrics_query_failed'),
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/objects',
    requireObservabilityAccess,
    (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const objects = publicObservabilityStore.listObjects('*', {
          team: queryText(query, 'team', 120),
          objectType: queryText(query, 'objectType', 120),
          q: queryText(query, 'q', 120),
          ownerTeam: queryText(query, 'ownerTeam', 120) ?? queryText(query, 'owner_team', 120),
          label: queryText(query, 'label', 64),
          archived: queryBoolean(query, 'archived'),
          limit: queryInteger(query, 'limit', 200, 1, 200),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, objects });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'observability_objects_failed'),
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/objects/:objectId',
    requireObservabilityAccess,
    (req: Request, res: Response) => {
      try {
        const objectId = String(req.params.objectId ?? '')
          .replace(/\0/g, '')
          .trim()
          .slice(0, 200);
        if (!objectId) {
          res.status(400).json({ ok: false, error: 'invalid_object_id' });
          return;
        }
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'windowMinutes', 1_440, 1, 10_080);
        const windowEnd = Date.now();
        const detail = publicObservabilityStore.getObject('*', objectId, {
          team: queryText(query, 'team', 120),
          objectType: queryText(query, 'objectType', 120),
          projectId: queryText(query, 'projectId', 120),
          environment: queryText(query, 'environment', 120),
          service: queryText(query, 'service', 120),
          status: queryText(query, 'status', 40) as
            | 'queued'
            | 'running'
            | 'completed'
            | 'failed'
            | 'cancelled'
            | undefined,
          windowStart: windowEnd - windowMinutes * 60_000,
          windowEnd,
        });
        if (!detail) {
          res.status(404).json({ ok: false, error: 'observability_object_not_found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: clientErrorCode(error, 'observability_object_detail_failed'),
        });
      }
    },
  );
}
