import type { Request, Response, Router } from 'express';
import {
  requireObservabilityAccessTenantAware,
  resolveAdminTenantScope,
  tenantScopeGate,
} from './observability-route-kit.js';
import { getOpsObservabilityPool } from './observability-store.js';
import { alertEvidenceTimestamp, readAlertEvidenceSnapshot } from './studio-alert-evidence-store.js';

export function registerAlertEvidenceRoutes(router: Router): void {
  router.get('/api/ops/observability/alerts/:alertKey/evidence',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      const rawAt = req.query.at;
      const at = rawAt === undefined ? undefined : alertEvidenceTimestamp(rawAt);
      if (rawAt !== undefined && (!at || typeof rawAt !== 'string')) {
        res.status(400).json({ ok: false, error: 'invalid_alert_evidence_time' });
        return;
      }
      try {
        const tenantId = req.opsTenantAccess?.tenantId ?? await resolveAdminTenantScope(req) ?? 'platform';
        const snapshot = await readAlertEvidenceSnapshot(await getOpsObservabilityPool(), String(req.params.alertKey), at ?? undefined, tenantId);
        if (!snapshot) {
          res.status(404).json({ ok: false, error: 'alert_evidence_not_found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, ...snapshot });
      } catch {
        res.status(503).json({ ok: false, error: 'alert_evidence_unavailable' });
      }
    });
}
