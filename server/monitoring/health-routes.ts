import { Router, type Request, type Response } from 'express';
import {
  telemetryGovernanceRestoreReadiness,
  telemetryGovernanceProtectedReadsReady,
} from '../observability/governance-runtime-service.js';

type HealthStatus = 'up' | 'down' | 'disabled' | 'degraded';

type HealthCheck = {
  status: HealthStatus;
  latencyMs?: number;
  reason?: string;
};

type HealthPool = {
  query: (text: string) => Promise<unknown>;
};

const DB_CHECK_CACHE_MS = 5_000;
let databasePoolPromise: Promise<HealthPool | null> | null = null;
let cachedDatabaseCheck: { expiresAt: number; check: HealthCheck } | null = null;

function isProduction(): boolean {
  return String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function databaseRequired(): boolean {
  const configured = String(process.env.RDK_HEALTH_REQUIRE_DATABASE ?? '').trim();
  if (configured) return configured === '1' || configured.toLowerCase() === 'true';
  return isProduction();
}

async function healthPool(): Promise<HealthPool | null> {
  if (databasePoolPromise) return databasePoolPromise;
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) return null;
  databasePoolPromise = import('pg' as string)
    .then((module) => {
      const Pool = (module as unknown as { default?: { Pool?: new (options: Record<string, unknown>) => HealthPool } }).default?.Pool;
      if (!Pool) throw new Error('pg_pool_unavailable');
      return new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 1_500,
        idleTimeoutMillis: 5_000,
        statement_timeout: 1_500,
        application_name: 'd-obs-health',
      });
    })
    .catch((error) => {
      databasePoolPromise = null;
      throw error;
    });
  return databasePoolPromise;
}

async function databaseCheck(): Promise<HealthCheck> {
  const now = Date.now();
  if (cachedDatabaseCheck && cachedDatabaseCheck.expiresAt > now) return cachedDatabaseCheck.check;
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) {
    const check: HealthCheck = { status: 'disabled', reason: 'database_not_configured' };
    cachedDatabaseCheck = { expiresAt: now + DB_CHECK_CACHE_MS, check };
    return check;
  }
  const startedAt = Date.now();
  try {
    const pool = await healthPool();
    if (!pool) throw new Error('database_not_configured');
    await pool.query('select 1');
    const check: HealthCheck = { status: 'up', latencyMs: Date.now() - startedAt };
    cachedDatabaseCheck = { expiresAt: now + DB_CHECK_CACHE_MS, check };
    return check;
  } catch (error) {
    const check: HealthCheck = {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message.slice(0, 120) : 'database_unavailable',
    };
    cachedDatabaseCheck = { expiresAt: now + DB_CHECK_CACHE_MS, check };
    return check;
  }
}

function governanceCheck(): HealthCheck {
  const readiness = telemetryGovernanceRestoreReadiness();
  if (readiness === 'disabled') return { status: 'disabled', reason: 'governance_not_configured' };
  if (readiness === 'ready' && telemetryGovernanceProtectedReadsReady()) return { status: 'up' };
  return { status: readiness === 'failed' ? 'down' : 'degraded', reason: `restore_${readiness}` };
}

function sendJson(res: Response, statusCode: number, payload: Record<string, unknown>): void {
  res.status(statusCode).set('Cache-Control', 'no-store').json(payload);
}

async function readiness(_req: Request, res: Response): Promise<void> {
  const database = await databaseCheck();
  const governance = governanceCheck();
  const databaseOk = database.status === 'up' || (!databaseRequired() && database.status === 'disabled');
  const governanceOk = governance.status === 'up' || governance.status === 'disabled';
  const ok = databaseOk && governanceOk;
  sendJson(res, ok ? 200 : 503, {
    ok,
    status: ok ? 'ready' : 'not_ready',
    service: 'd-obs',
    uptimeMs: Math.max(0, Math.trunc(process.uptime() * 1_000)),
    checks: { database, governance },
  });
}

function liveness(_req: Request, res: Response): void {
  sendJson(res, 200, {
    ok: true,
    status: 'alive',
    service: 'd-obs',
    uptimeMs: Math.max(0, Math.trunc(process.uptime() * 1_000)),
  });
}

export function createHealthRouter(): Router {
  const router = Router();
  router.get(['/healthz', '/api/healthz'], liveness);
  router.get(['/readyz', '/api/readyz'], (req, res) => {
    void readiness(req, res).catch(() => {
      sendJson(res, 503, { ok: false, status: 'not_ready', service: 'd-obs', error: 'health_check_failed' });
    });
  });
  return router;
}
