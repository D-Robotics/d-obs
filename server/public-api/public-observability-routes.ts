import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  getPublicObservabilityStore,
  PublicObservabilityConflictError,
  type PublicObservabilityFeedbackInput,
  type PublicObservabilityRunCreateInput,
  type PublicObservabilityRunFilter,
  type PublicObservabilityScoreInput,
  type PublicObservabilitySpanBatchInput,
} from './public-observability-store.js';
import type { PublicObservabilityRunStatus } from './public-observability-store.js';

type PublicRequest = Request & { publicPrincipal?: PublicPrincipal };

interface PublicPrincipal {
  owner: string;
  keyId: string;
}

class PublicObservabilityHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PublicObservabilityHttpError';
  }
}

const store = getPublicObservabilityStore();

function text(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0]);
  const result = text(value);
  return result || undefined;
}

function queryNumber(value: unknown, fallback?: number): number | undefined {
  const raw = queryValue(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function queryBoolean(value: unknown): boolean | undefined {
  const raw = queryValue(value)?.toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return undefined;
}

function timestamp(value: unknown): number | undefined {
  const raw = queryValue(value);
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new PublicObservabilityHttpError(400, 'invalid_request_body');
  }
  return req.body as Record<string, unknown>;
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function resolvePrincipal(req: Request): PublicPrincipal | null {
  const header = text(req.header('authorization'), 4_096);
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = text(match[1], 4_000);
  if (!token) return null;
  const configured = text(process.env.RDK_PUBLIC_OBSERVABILITY_API_TOKEN, 4_000);
  if (configured && !sameSecret(token, configured)) return null;
  const digest = createHash('sha256').update(token).digest('hex');
  return {
    // Do not persist or echo the bearer token. The digest is stable for a key
    // and creates an isolated owner partition for the public API.
    owner: `public_${digest}`,
    keyId: digest.slice(0, 32),
  };
}

function principal(req: PublicRequest): PublicPrincipal {
  const value = req.publicPrincipal ?? resolvePrincipal(req);
  if (!value) throw new PublicObservabilityHttpError(401, 'invalid_observability_token');
  req.publicPrincipal = value;
  return value;
}

function runInput(body: Record<string, unknown>, idempotencyKey?: string): PublicObservabilityRunCreateInput {
  const projectId = text(body.projectId, 160);
  const environment = text(body.environment, 120);
  const service = text(body.service, 160);
  if (!projectId || !environment || !service) {
    throw new PublicObservabilityHttpError(400, 'project_id_environment_and_service_required');
  }
  return {
    ...(body as Omit<PublicObservabilityRunCreateInput, 'projectId' | 'environment' | 'service'>),
    projectId,
    environment,
    service,
    ...(idempotencyKey ? { idempotencyKey: text(idempotencyKey, 256) } : {}),
  };
}

function runFilters(query: Request['query']): PublicObservabilityRunFilter {
  const status = queryValue(query.status);
  const allowedStatuses: ReadonlySet<PublicObservabilityRunStatus> = new Set([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
  ]);
  return {
    ...(queryValue(query.team) ? { team: queryValue(query.team) } : {}),
    ...(queryValue(query.objectType) ? { objectType: queryValue(query.objectType) } : {}),
    ...(queryValue(query.objectId) ? { objectId: queryValue(query.objectId) } : {}),
    ...(queryValue(query.objectVersion) ? { objectVersion: queryValue(query.objectVersion) } : {}),
    ...(queryValue(query.projectId) ? { projectId: queryValue(query.projectId) } : {}),
    ...(queryValue(query.environment) ? { environment: queryValue(query.environment) } : {}),
    ...(queryValue(query.service) ? { service: queryValue(query.service) } : {}),
    ...(status && allowedStatuses.has(status as PublicObservabilityRunStatus)
      ? { status: status as PublicObservabilityRunStatus }
      : {}),
    ...(timestamp(query.from) !== undefined ? { from: timestamp(query.from) } : {}),
    ...(timestamp(query.to) !== undefined ? { to: timestamp(query.to) } : {}),
    ...(queryNumber(query.limit) !== undefined ? { limit: queryNumber(query.limit) } : {}),
  };
}

function summaryFilters(query: Request['query']): PublicObservabilityRunFilter & { windowStart?: number; windowEnd?: number } {
  const filters = runFilters(query);
  const windowMinutes = queryNumber(query.windowMinutes);
  if (windowMinutes === undefined || windowMinutes <= 0 || filters.from !== undefined || filters.to !== undefined) {
    return filters;
  }
  const windowEnd = Date.now();
  return { ...filters, windowStart: windowEnd - Math.min(windowMinutes, 7 * 24 * 60) * 60_000, windowEnd };
}

function publicRun(run: Record<string, unknown>): Record<string, unknown> {
  const { owner: _owner, keyId: _keyId, ...result } = run;
  return result;
}

function publicRecord(record: Record<string, unknown>): Record<string, unknown> {
  const { owner: _owner, ...result } = record;
  return result;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PublicObservabilityHttpError) {
    res.status(error.status).json({
      ok: false,
      error: error.code,
      code: error.code,
      retryable: error.retryable,
    });
    return;
  }
  if (error instanceof PublicObservabilityConflictError) {
    res.status(409).json({ ok: false, error: 'observability_run_conflict', code: 'observability_run_conflict' });
    return;
  }
  if (error instanceof Error && error.message === 'run not found') {
    res.status(404).json({ ok: false, error: 'observability_run_not_found', code: 'observability_run_not_found' });
    return;
  }
  res.status(500).json({ ok: false, error: 'observability_api_unavailable', code: 'observability_api_unavailable', retryable: true });
}

export function createPublicObservabilityRouter(): Router {
  const router = Router();

  router.use((req: PublicRequest, res, next) => {
    // The standalone app mounts this router at `/` for compatibility with
    // existing public API paths. Do not let its bearer-token gate swallow the
    // observability workbench, status page, or unrelated application routes.
    if (!req.path.startsWith('/api/v1/observability/')) {
      next();
      return;
    }
    try {
      req.publicPrincipal = resolvePrincipal(req) ?? undefined;
      if (!req.publicPrincipal) {
        res.status(401).json({ ok: false, error: 'invalid_observability_token', code: 'invalid_observability_token' });
        return;
      }
      next();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/v1/observability/runs', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const input = runInput(bodyObject(req), req.header('idempotency-key') ?? undefined);
      const result = await store.createRun(identity.owner, identity.keyId, input);
      res.setHeader('idempotent-replayed', result.replayed ? 'true' : 'false');
      res.status(result.replayed ? 200 : 201).json({
        ok: true,
        data: { run: publicRun(result.run as unknown as Record<string, unknown>), replayed: result.replayed },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/v1/observability/runs/:runId/spans:batch', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const body = bodyObject(req);
      if (!Array.isArray(body.spans)) throw new PublicObservabilityHttpError(400, 'spans_required');
      const result = await store.appendSpans({
        ...(body as Omit<PublicObservabilitySpanBatchInput, 'runId' | 'owner' | 'keyId'>),
        runId: text(req.params.runId, 200),
        owner: identity.owner,
        keyId: identity.keyId,
      });
      res.json({
        ok: true,
        data: {
          run: publicRun(result.run as unknown as Record<string, unknown>),
          spans: result.spans,
          accepted: result.spans.length,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/runs', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const filters = runFilters(req.query);
      const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
      res.json({ ok: true, data: { runs: store.listRuns(identity.owner, { ...filters, limit }).map((run) => publicRun(run as unknown as Record<string, unknown>)), limit } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/catalog', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      res.json({ ok: true, data: store.listCatalog(identity.owner, runFilters(req.query)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/objects', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      res.json({
        ok: true,
        data: store.listObjects(identity.owner, {
          ...runFilters(req.query),
          ...(queryValue(req.query.q) ? { q: queryValue(req.query.q) } : {}),
          ...(queryValue(req.query.ownerTeam) ? { ownerTeam: queryValue(req.query.ownerTeam) } : {}),
          ...(queryValue(req.query.label) ? { label: queryValue(req.query.label) } : {}),
          ...(queryBoolean(req.query.archived) !== undefined ? { archived: queryBoolean(req.query.archived) } : {}),
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/summary', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      res.json({ ok: true, data: store.summarize(identity.owner, summaryFilters(req.query)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/objects/:objectId', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const detail = store.getObject(identity.owner, text(req.params.objectId, 200), summaryFilters(req.query));
      if (!detail) throw new PublicObservabilityHttpError(404, 'observability_object_not_found');
      res.json({ ok: true, data: detail });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch('/api/v1/observability/objects/:objectId', (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const detail = store.upsertObject(identity.owner, text(req.params.objectId, 200), bodyObject(req) as never);
      res.json({ ok: true, data: detail });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/runs/:runId/trace', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const limit = Math.max(1, Math.min(256, queryNumber(req.query.limit, 256) ?? 256));
      const trace = await store.getTrace(identity.owner, text(req.params.runId, 200), limit);
      if (!trace) throw new PublicObservabilityHttpError(404, 'observability_run_not_found');
      res.json({ ok: true, data: { runId: text(req.params.runId, 200), trace, limit } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/v1/observability/runs/:runId', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const run = await store.getRun(identity.owner, text(req.params.runId, 200));
      if (!run) throw new PublicObservabilityHttpError(404, 'observability_run_not_found');
      res.json({ ok: true, data: publicRun(run as unknown as Record<string, unknown>) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/v1/observability/runs/:runId/scores', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const runId = text(req.params.runId, 200);
      const run = await store.getRun(identity.owner, runId);
      if (!run) throw new PublicObservabilityHttpError(404, 'observability_run_not_found');
      const body = bodyObject(req);
      const value = Number(body.value);
      if (!Number.isFinite(value) || !text(body.name, 120)) throw new PublicObservabilityHttpError(400, 'invalid_score');
      const score = await store.recordScore({
        ...(body as Omit<PublicObservabilityScoreInput, 'runId' | 'owner' | 'value' | 'name'>),
        runId,
        owner: identity.owner,
        name: text(body.name, 120),
        value,
      });
      res.status(201).json({ ok: true, data: publicRecord(score as unknown as Record<string, unknown>) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/v1/observability/runs/:runId/feedback', async (req: PublicRequest, res) => {
    try {
      const identity = principal(req);
      const runId = text(req.params.runId, 200);
      const run = await store.getRun(identity.owner, runId);
      if (!run) throw new PublicObservabilityHttpError(404, 'observability_run_not_found');
      const body = bodyObject(req);
      const kind = text(body.kind, 8);
      if (kind !== 'up' && kind !== 'down') throw new PublicObservabilityHttpError(400, 'invalid_feedback');
      const feedback = await store.recordFeedback({
        ...(body as Omit<PublicObservabilityFeedbackInput, 'runId' | 'owner' | 'kind'>),
        runId,
        owner: identity.owner,
        kind,
      });
      res.status(201).json({ ok: true, data: publicRecord(feedback as unknown as Record<string, unknown>) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
