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
import type {
  PublicObservabilityCatalogObject,
  PublicObservabilityObjectDetail,
  PublicObservabilityObjectListResult,
} from '../../shared/public-observability-client.js';
import {
  listRegisteredObjects,
  type RegisteredObject,
} from './observability-object-registry.js';
import { getFlywheelObservation } from '../flywheel/flywheel-observation.js';
import { getFlywheelOverview } from '../flywheel/metrics-store.js';
import { getOperatorMetrics } from '../flywheel/operator-metrics-store.js';

type ObjectListFilters = {
  team?: string;
  objectType?: string;
  q?: string;
  ownerTeam?: string;
  label?: string;
  archived?: boolean;
  limit?: number;
};

function registeredObjectTimestamp(value: string | null, fallback = Date.now()): number {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function registeredObjectLabels(labels: Record<string, unknown>): string[] {
  return Object.entries(labels)
    .slice(0, 16)
    .map(([key, value]) => {
      const normalized = String(value ?? '').replace(/\0/g, '').trim().slice(0, 120);
      return normalized ? `${key}=${normalized}` : key;
    })
    .filter(Boolean);
}

export function registeredObjectToCatalogObject(item: RegisteredObject): PublicObservabilityCatalogObject {
  const createdAt = registeredObjectTimestamp(item.firstSeenAt);
  const updatedAt = registeredObjectTimestamp(item.lastSeenAt, createdAt);
  const labels = registeredObjectLabels(item.labels);
  return {
    objectType: item.objectType,
    objectId: item.objectId,
    objectName: item.displayName || item.objectId,
    versions: [],
    runCount: 0,
    errorRate: null,
    lastSeenAt: updatedAt,
    profile: {
      objectType: item.objectType,
      objectId: item.objectId,
      ...(item.displayName ? { displayName: item.displayName } : {}),
      labels,
      archived: false,
      createdAt,
      updatedAt,
    },
  };
}

function objectSearchText(item: PublicObservabilityCatalogObject): string {
  return [
    item.objectId,
    item.objectName,
    item.team,
    item.objectType,
    item.profile?.displayName,
    item.profile?.ownerTeam,
    item.profile?.description,
    ...(item.profile?.labels ?? []),
  ].map((value) => String(value ?? '').toLowerCase()).join(' ');
}

/** Merge durable OTLP registry objects into the in-process run catalog. */
export function mergeRegisteredObjects(
  catalog: PublicObservabilityObjectListResult,
  registered: readonly RegisteredObject[],
  filters: ObjectListFilters = {},
): PublicObservabilityObjectListResult {
  const objects = catalog.objects.map((item) => ({
    ...item,
    ...(item.profile ? { profile: { ...item.profile, labels: [...item.profile.labels] } } : {}),
  }));
  for (const registeredItem of registered) {
    const candidate = registeredObjectToCatalogObject(registeredItem);
    if (filters.team || filters.ownerTeam) continue;
    if (filters.objectType && candidate.objectType !== filters.objectType) continue;
    if (filters.archived === true) continue;
    if (filters.label && !(candidate.profile?.labels ?? []).some((label) => label.toLowerCase() === filters.label!.toLowerCase() || label.toLowerCase().startsWith(`${filters.label!.toLowerCase()}=`))) continue;
    if (filters.q && !objectSearchText(candidate).includes(filters.q.toLowerCase())) continue;
    const existing = objects.find((item) =>
      item.objectId === candidate.objectId && (!item.objectType || !candidate.objectType || item.objectType === candidate.objectType),
    );
    if (!existing) {
      objects.push(candidate);
      continue;
    }
    existing.objectName ||= candidate.objectName;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt);
    if (!existing.profile) existing.profile = candidate.profile;
    else existing.profile.labels = [...new Set([...existing.profile.labels, ...(candidate.profile?.labels ?? [])])].slice(0, 16);
  }
  objects.sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.runCount - a.runCount);
  const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? catalog.limit ?? 100)));
  return { generatedAt: Date.now(), total: objects.length, limit, objects: objects.slice(0, limit) };
}

function registeredObjectDetail(item: RegisteredObject, store: ReturnType<typeof getPublicObservabilityStore>): PublicObservabilityObjectDetail {
  const catalog = registeredObjectToCatalogObject(item);
  return {
    object: {
      ...catalog,
      firstSeenAt: catalog.profile?.createdAt ?? catalog.lastSeenAt,
      environments: [],
      services: [],
      releases: [],
      projects: [],
    },
    summary: store.summarize('*', { objectId: item.objectId }),
    recentRuns: [],
  };
}

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
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const filters = {
          team: queryText(query, 'team', 120),
          objectType: queryText(query, 'objectType', 120),
          q: queryText(query, 'q', 120),
          ownerTeam: queryText(query, 'ownerTeam', 120) ?? queryText(query, 'owner_team', 120),
          label: queryText(query, 'label', 64),
          archived: queryBoolean(query, 'archived'),
          limit: queryInteger(query, 'limit', 200, 1, 200),
        };
        const inProcess = publicObservabilityStore.listObjects('*', filters);
        const registered = await listRegisteredObjects().catch(() => [] as RegisteredObject[]);
        const objects = mergeRegisteredObjects(inProcess, registered, filters);
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
    async (req: Request, res: Response) => {
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
          const registered = await listRegisteredObjects().catch(() => [] as RegisteredObject[]);
          const registeredItem = registered.find((item) => item.objectId === objectId && (!queryText(query, 'objectType', 120) || item.objectType === queryText(query, 'objectType', 120)));
          if (registeredItem) {
            res.setHeader('Cache-Control', 'no-store');
            res.json({ ok: true, detail: registeredObjectDetail(registeredItem, publicObservabilityStore) });
            return;
          }
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
