/** Bounded admin-only projections of the existing anonymous-Viewer Grafana API. */
import { isIP } from 'node:net';
import type { Request, Response, Router } from 'express';
import { isOpsAdminRequest, requireObservabilityAccess } from './observability-route-kit.js';
import { redactPlatformAssistantText } from '../observability/platform-assistant-redaction.js';
import { GRAFANA_ASSISTANT_API } from './grafana-assistant-operations.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PANELS = 80;
const MAX_TARGETS = 8;
const UID = /^[A-Za-z0-9_-]{1,128}$/;
type RecordValue = Record<string, unknown>;
export type GrafanaAssistantOptions = {
  baseUrl?: string; timeoutMs?: number; maxResponseBytes?: number; fetchImpl?: typeof fetch;
};
class GrafanaReadError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max = 160): string {
  if (typeof value !== 'string') return '';
  return redactPlatformAssistantText(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').trim()).slice(0, max);
}
function validUid(value: unknown): value is string { return typeof value === 'string' && UID.test(value); }
function configuration(options: GrafanaAssistantOptions): URL {
  let url: URL;
  try { url = new URL(options.baseUrl ?? process.env.RDK_GRAFANA_API_URL ?? DEFAULT_BASE_URL); }
  catch { throw new GrafanaReadError(503, 'grafana_invalid_configuration'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  if (!local || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^\/[A-Za-z0-9_/-]*$/.test(url.pathname) || url.pathname.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new GrafanaReadError(503, 'grafana_invalid_configuration');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}
function checkQuery(req: Request, allowed: string[]): void {
  // The generic executor carries an administrator's selected tenant view.
  // Grafana remains platform-wide and never obtains tenant access from it.
  if (Object.keys(req.query).some((key) => ![...allowed, 'tenant'].includes(key))) {
    throw new GrafanaReadError(400, 'invalid_grafana_query');
  }
}
async function read(options: GrafanaAssistantOptions, path: string, query?: URLSearchParams, notFound = false): Promise<unknown> {
  const base = configuration(options);
  const url = new URL(base.toString()); url.pathname = base.pathname.replace(/\/+$/, '') + path; url.search = query?.toString() ?? '';
  const timeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! > 0 ? Math.min(8000, options.timeoutMs!) : 8000;
  const maxBytes = Number.isSafeInteger(options.maxResponseBytes) && options.maxResponseBytes! > 0
    ? Math.min(MAX_RESPONSE_BYTES, options.maxResponseBytes!) : MAX_RESPONSE_BYTES;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (notFound && response.status === 404) throw new GrafanaReadError(404, 'grafana_dashboard_not_found');
      throw new GrafanaReadError(502, [401, 403].includes(response.status) ? 'grafana_upstream_access_denied' : 'grafana_upstream_failed');
    }
    if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new GrafanaReadError(502, 'grafana_invalid_response');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new GrafanaReadError(502, 'grafana_upstream_response_too_large');
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new GrafanaReadError(502, 'grafana_upstream_response_too_large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GrafanaReadError(502, 'grafana_invalid_response'); }
  } catch (error) {
    if (error instanceof GrafanaReadError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new GrafanaReadError(504, 'grafana_upstream_timeout');
    throw new GrafanaReadError(502, 'grafana_unreachable');
  }
}
function dashboardList(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.some((item) => !object(item) || !validUid(item.uid) || typeof item.title !== 'string' || item.type !== 'dash-db')) {
    throw new GrafanaReadError(502, 'grafana_invalid_response');
  }
  return value.slice(0, limit).map((item: RecordValue) => ({
    uid: item.uid, title: text(item.title), folderUid: validUid(item.folderUid) ? item.folderUid : null,
    folderTitle: text(item.folderTitle), tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 20).map((tag) => text(tag, 80)) : [],
    path: '/dobs/grafana/d/' + item.uid,
  }));
}
function datasourceRef(value: unknown): { uid: string; type: string } | null {
  if (typeof value === 'string') return value ? { uid: text(value, 128), type: '' } : null;
  if (!object(value) || typeof value.uid !== 'string') return null;
  return { uid: text(value.uid, 128), type: text(value.type, 80) };
}
function detail(value: unknown, uid: string) {
  if (!object(value) || !object(value.dashboard) || value.dashboard.uid !== uid || typeof value.dashboard.title !== 'string' || !Array.isArray(value.dashboard.panels)) {
    throw new GrafanaReadError(502, 'grafana_invalid_response');
  }
  const dashboard = value.dashboard; const meta = object(value.meta) ? value.meta : {};
  const rawPanels: RecordValue[] = []; let scanned = 0; let scanTruncated = false;
  const walk = (panels: unknown[], depth = 0): void => {
    for (const panel of panels) {
      if (++scanned > 1000 || depth > 8) { scanTruncated = true; return; }
      if (!object(panel)) throw new GrafanaReadError(502, 'grafana_invalid_response');
      if (panel.type === 'row' && Array.isArray(panel.panels)) walk(panel.panels, depth + 1);
      else rawPanels.push(panel);
    }
  };
  walk(dashboard.panels as unknown[]);
  const panels = rawPanels.slice(0, MAX_PANELS).map((panel) => {
    const datasource = datasourceRef(panel.datasource); const targets = Array.isArray(panel.targets) ? panel.targets : [];
    return {
      id: Number.isSafeInteger(panel.id) ? panel.id : null, title: text(panel.title), type: text(panel.type, 80), datasource,
      targets: targets.slice(0, MAX_TARGETS).map((target) => {
        if (!object(target)) throw new GrafanaReadError(502, 'grafana_invalid_response');
        const source = datasourceRef(target.datasource) ?? datasource;
        const expr = typeof target.expr === 'string' ? target.expr : '';
        const sanitized = redactPlatformAssistantText(expr.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''));
        const complete = expr.length > 0 && expr.length <= 2000;
        return {
          refId: text(target.refId, 40), datasource: source, hidden: target.hide === true,
          ...(complete ? { expr: sanitized } : {}),
          expressionOmitted: expr.length > 2000, expressionRedacted: expr !== sanitized,
          hasTemplateVariables: expr.includes('$'),
          queryExecutableViaPlatform: complete && expr === sanitized && !expr.includes('$') && source?.type === 'prometheus',
        };
      }), targetCount: targets.length, targetsTruncated: targets.length > MAX_TARGETS,
    };
  });
  const variables = object(dashboard.templating) && Array.isArray(dashboard.templating.list) ? dashboard.templating.list : [];
  return {
    uid, title: text(dashboard.title), version: Number.isSafeInteger(dashboard.version) ? dashboard.version : null,
    provisioned: typeof meta.provisioned === 'boolean' ? meta.provisioned : null,
    readOnly: true, folderUid: validUid(meta.folderUid) ? meta.folderUid : null, folderTitle: text(meta.folderTitle),
    path: '/dobs/grafana/d/' + uid, panels, panelCount: rawPanels.length, panelCountIsLowerBound: scanTruncated,
    panelsTruncated: scanTruncated || rawPanels.length > MAX_PANELS,
    variables: variables.slice(0, 40).filter(object).map((variable) => ({ name: text(variable.name, 80), type: text(variable.type, 80), multi: variable.multi === true, includeAll: variable.includeAll === true })),
    variablesTruncated: variables.length > 40,
  };
}
function datasources(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => !object(item) || !validUid(item.uid) || typeof item.name !== 'string' || typeof item.type !== 'string')) {
    throw new GrafanaReadError(502, 'grafana_invalid_response');
  }
  return value.slice(0, 100).map((item: RecordValue) => ({
    uid: item.uid, name: text(item.name), type: text(item.type, 80), isDefault: item.isDefault === true,
    readOnly: typeof item.readOnly === 'boolean' ? item.readOnly : null,
  }));
}

/** The composition root must also explicitly register GRAFANA_ASSISTANT_OPERATIONS. */
export function registerGrafanaAssistantRoutes(router: Router, options: GrafanaAssistantOptions = {}): void {
  const handler = (callback: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await callback(req)); }
    catch (error) {
      const failure = error instanceof GrafanaReadError ? error : new GrafanaReadError(502, 'grafana_invalid_response');
      res.status(failure.status).json({ ok: false, error: failure.message });
    }
  };
  const noCache = (_req: Request, res: Response, next: () => void) => { res.setHeader('Cache-Control', 'no-store'); next(); };
  const requireGrafanaAdmin = (req: Request, res: Response, next: () => void) => {
    if (!isOpsAdminRequest(req)) { res.status(403).json({ ok: false, error: 'not_authorized' }); return; }
    next();
  };
  router.get(GRAFANA_ASSISTANT_API + '/dashboards', noCache, requireObservabilityAccess, requireGrafanaAdmin, handler(async (req) => {
    checkQuery(req, ['q', 'limit']);
    if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 120 || /[\x00-\x1f\x7f-\x9f]/.test(req.query.q))) {
      throw new GrafanaReadError(400, 'invalid_grafana_query');
    }
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if ((req.query.limit !== undefined && typeof req.query.limit !== 'string') || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new GrafanaReadError(400, 'invalid_grafana_limit');
    }
    const query = new URLSearchParams({ type: 'dash-db', limit: String(limit) });
    if (typeof req.query.q === 'string' && req.query.q.trim()) query.set('query', req.query.q.trim());
    const value = await read(options, '/api/search', query); const dashboards = dashboardList(value, limit);
    return { ok: true, scope: 'platform', source: 'grafana-api', containsLiveMetrics: false, dashboards, returnedCount: dashboards.length, limit, mayHaveMore: (value as unknown[]).length >= limit };
  }));
  router.get(GRAFANA_ASSISTANT_API + '/dashboards/:uid', noCache, requireObservabilityAccess, requireGrafanaAdmin, handler(async (req) => {
    checkQuery(req, []); const uid = req.params.uid;
    if (!validUid(uid)) throw new GrafanaReadError(400, 'invalid_grafana_dashboard_uid');
    return { ok: true, scope: 'platform', source: 'grafana-api', containsLiveMetrics: false, dashboard: detail(await read(options, '/api/dashboards/uid/' + encodeURIComponent(uid), undefined, true), uid) };
  }));
  router.get(GRAFANA_ASSISTANT_API + '/datasources', noCache, requireObservabilityAccess, requireGrafanaAdmin, handler(async (req) => {
    checkQuery(req, []); const value = await read(options, '/api/datasources');
    return { ok: true, scope: 'platform', source: 'grafana-api', containsLiveMetrics: false, datasources: datasources(value), returnedCount: Math.min(100, (value as unknown[]).length), truncated: (value as unknown[]).length > 100 };
  }));
}
