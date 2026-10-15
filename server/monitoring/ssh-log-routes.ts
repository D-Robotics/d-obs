/** SSH runtime logs: private, bounded local captures, independent of OTLP/PG. */
import type { Request, RequestHandler, Response, Router } from 'express';
import { homedir } from 'node:os';
import path from 'node:path';
import { hasInvalidAdminToken, hasInvalidTenantToken, isOpsAdminRequest, resolveOpsActorId } from './observability-access.js';
import { getSessionSsoUser } from './observability-access-adapter.js';
import { clientErrorCode, requireOpsMutationGuard } from './observability-route-kit.js';
import { parseSshLogTargets, SshLogCollector, SshLogCollectorError } from './ssh-log-collector.js';

export const SSH_LOG_CONTRACT = 'rdk.ssh-logs.v1';
const API = '/api/ops/observability/ssh-logs';
let configuredCollector: SshLogCollector | undefined;

export function getConfiguredSshLogCollector(): SshLogCollector {
  if (!configuredCollector) {
    configuredCollector = new SshLogCollector({
      targets: parseSshLogTargets(process.env.RDK_SSH_LOG_TARGETS ?? '[]'),
      stateDir: process.env.RDK_SSH_LOG_STATE_DIR || path.join(homedir(), '.local', 'state', 'd-obs', 'ssh-logs'),
    });
  }
  return configuredCollector;
}

export async function disposeConfiguredSshLogCollector(): Promise<void> {
  const collector = configuredCollector;
  configuredCollector = undefined;
  await collector?.dispose();
}

/** Same admin authority as ops, without requiring the telemetry database. */
export const requireSshLogAccess: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (hasInvalidAdminToken(req) || hasInvalidTenantToken(req) || !isOpsAdminRequest(req)) {
    res.status(403).json({ ok: false, error: 'not_authorized' });
    return;
  }
  next();
};

export function sessionOwner(req: Request): string {
  const user = getSessionSsoUser(req);
  return user ? `sso:${user.id}` : resolveOpsActorId(req);
}

function failure(res: Response, error: unknown): void {
  if (error instanceof SshLogCollectorError) {
    res.status(error.status).json({ ok: false, error: error.code });
    return;
  }
  res.status(503).json({ ok: false, error: clientErrorCode(error, 'ssh_logs_unavailable') });
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new SshLogCollectorError(400, 'invalid_ssh_log_request', 'Invalid SSH log request');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new SshLogCollectorError(400, 'invalid_ssh_log_request', 'Invalid SSH log request');
  }
  return number;
}

export function registerSshLogRoutes(router: Router, getCollector = getConfiguredSshLogCollector): void {
  router.get(`${API}/targets`, requireSshLogAccess, (_req, res) => {
    try {
      res.json({ ok: true, contract: SSH_LOG_CONTRACT, targets: getCollector().listTargets() });
    } catch (error) { failure(res, error); }
  });

  router.get(`${API}/sessions`, requireSshLogAccess, (req, res) => {
    try {
      res.json({ ok: true, contract: SSH_LOG_CONTRACT, sessions: getCollector().list(sessionOwner(req)) });
    } catch (error) { failure(res, error); }
  });

  router.post(`${API}/sessions`, requireSshLogAccess, requireOpsMutationGuard, async (req, res) => {
    try {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ ok: false, error: 'invalid_ssh_log_request' });
        return;
      }
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some((key) => !['targetId', 'sourceId', 'lines', 'durationSeconds', 'follow'].includes(key)) ||
        typeof input.targetId !== 'string' || typeof input.sourceId !== 'string' ||
        (input.follow !== undefined && typeof input.follow !== 'boolean')) {
        res.status(400).json({ ok: false, error: 'invalid_ssh_log_request' });
        return;
      }
      const session = await getCollector().start({
        targetId: input.targetId,
        sourceId: input.sourceId,
        lines: integer(input.lines, 200, 0, 10_000),
        durationSeconds: integer(input.durationSeconds, 300, 5, 1_800),
        follow: input.follow !== false,
      }, sessionOwner(req));
      res.status(201).json({ ok: true, contract: SSH_LOG_CONTRACT, session });
    } catch (error) { failure(res, error); }
  });

  router.get(`${API}/sessions/:id`, requireSshLogAccess, (req, res) => {
    try {
      const result = getCollector().read(
        String(req.params.id), sessionOwner(req),
        integer(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER),
        integer(req.query.limit, 500, 1, 500),
      );
      res.json({ ok: true, contract: SSH_LOG_CONTRACT, ...result });
    } catch (error) { failure(res, error); }
  });

  router.post(`${API}/sessions/:id/stop`, requireSshLogAccess, requireOpsMutationGuard, async (req, res) => {
    try {
      const session = await getCollector().stop(String(req.params.id), sessionOwner(req));
      res.json({ ok: true, contract: SSH_LOG_CONTRACT, session });
    } catch (error) { failure(res, error); }
  });

  router.get(`${API}/sessions/:id/export`, requireSshLogAccess, async (req, res) => {
    try {
      const id = String(req.params.id);
      const text = await getCollector().exportText(id, sessionOwner(req));
      // Filename comes only from the already validated, owned session identity.
      res.attachment(`ssh-logs-${id.replace(/[^a-zA-Z0-9-]/g, '')}.txt`);
      res.type('text/plain; charset=utf-8').send(text);
    } catch (error) { failure(res, error); }
  });
}
