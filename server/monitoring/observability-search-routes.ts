/**
 * Entity search for the operations workbench.
 *
 * This is deliberately a read-only projection: it reuses the same access and
 * tenant scope gates as the incident/object views and never returns raw labels
 * or telemetry payloads.  The command palette only needs a stable identity,
 * status and a view deep link.
 */
import type { Request, Response, Router } from 'express';
import { listIngestTokens } from '../observability/ingest-token-store.js';
import {
  clientErrorCode,
  queryInteger,
  queryText,
  requireObservabilityAccessTenantAware,
  resolveAdminTenantScope,
  tenantScopeGate,
} from './observability-route-kit.js';
import { listOpsIncidents } from './observability-store.js';
import { listRegisteredObjects, type RegisteredObject } from './observability-object-registry.js';

export type ObservabilitySearchResult = {
  type: 'object' | 'incident';
  id: string;
  title: string;
  status: string;
  view: 'alerts' | 'investigate';
  deepLink: string;
};

function searchable(values: unknown[]): string {
  return values
    .map((value) => String(value ?? '').replace(/\0/g, '').trim().toLocaleLowerCase())
    .filter(Boolean)
    .join(' ');
}

function matchesQuery(values: unknown[], query: string): boolean {
  return !query || searchable(values).includes(query.toLocaleLowerCase());
}

export function registeredObjectToSearchResult(item: RegisteredObject): ObservabilitySearchResult {
  return {
    type: 'object',
    id: item.objectId,
    title: item.displayName || item.objectId,
    status: item.lastSeenAt ? 'registered' : 'unknown',
    view: 'alerts',
    deepLink: '#alerts/objects',
  };
}

export function incidentToSearchResult(incident: {
  key: string;
  title: string;
  status: string;
}): ObservabilitySearchResult {
  return {
    type: 'incident',
    id: incident.key,
    title: incident.title || incident.key,
    status: incident.status,
    view: 'alerts',
    deepLink: '#alerts/center',
  };
}

/** Pure projection used by route and unit tests. */
export function filterObservabilitySearchResults(
  objects: readonly RegisteredObject[],
  incidents: readonly { key: string; title: string; status: string; summary?: string | null; objectId?: string | null }[],
  query: string,
  limit: number,
): ObservabilitySearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const objectResults = objects
    .filter((item) => matchesQuery([
      item.objectId,
      item.displayName,
      item.objectType,
      ...Object.entries(item.labels).flatMap(([key, value]) => [`${key}=${String(value ?? '')}`, key, value]),
    ], normalizedQuery))
    .map(registeredObjectToSearchResult);
  const incidentResults = incidents
    .filter((item) => matchesQuery([item.key, item.title, item.status, item.summary, item.objectId], normalizedQuery))
    .map(incidentToSearchResult);
  // Active incidents are more actionable; keep deterministic ordering for the
  // palette and for screen readers when the same query is repeated.
  const statusRank: Record<string, number> = { open: 0, acknowledged: 1, silenced: 2, resolved: 3 };
  return [...incidentResults, ...objectResults]
    .sort((a, b) => (statusRank[a.status] ?? 4) - (statusRank[b.status] ?? 4) || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, Math.max(1, Math.min(50, limit)));
}

async function tenantObjectOwners(tenantScope: string | null): Promise<string[] | null> {
  if (!tenantScope) return null;
  const tokens = await listIngestTokens().catch(() => []);
  return tokens
    .filter((item) => item.status === 'active' && item.subjectType === 'tenant' && item.subjectId === tenantScope)
    .map((item) => item.owner)
    .filter(Boolean);
}

export function registerSearchRoutes(router: Router): void {
  router.get(
    '/api/ops/observability/search',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      try {
        const query = queryText(req.query as Record<string, unknown>, 'q', 120) ?? '';
        const limit = queryInteger(req.query as Record<string, unknown>, 'limit', 12, 1, 50);
        const tenantScope = req.opsTenantAccess?.tenantId ?? (await resolveAdminTenantScope(req));
        const owners = await tenantObjectOwners(tenantScope);
        let objects: RegisteredObject[] = [];
        if (owners === null) {
          objects = await listRegisteredObjects();
        } else {
          const scoped = await Promise.all(owners.map((owner) => listRegisteredObjects(owner).catch(() => [] as RegisteredObject[])));
          objects = scoped.flat();
        }
        const incidentPage = await listOpsIncidents({
          state: 'all',
          tenantScope,
          days: 90,
          limit: 200,
          offset: 0,
        });
        const results = filterObservabilitySearchResults(objects, incidentPage.incidents, query, limit);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, query, results });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'observability_search_unavailable') });
      }
    },
  );
}
