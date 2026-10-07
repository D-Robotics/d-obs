import { createHash } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';

type Bucket = { startedAt: number; count: number };

const WINDOW_MS = 60_000;
const buckets = new Map<string, Bucket>();
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, bucket] of buckets) {
    if (bucket.startedAt < cutoff) buckets.delete(key);
  }
}, WINDOW_MS);
cleanupTimer.unref();

function limitPerMinute(): number {
  const configured = Number.parseInt(String(process.env.RDK_OTLP_MAX_REQUESTS_PER_MINUTE ?? '600'), 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(100_000, configured)) : 600;
}

function credentialKey(req: Request): string {
  const authorization = String(req.header('authorization') ?? '').trim();
  const apiKey = String(req.header('x-api-key') ?? req.header('api-key') ?? '').trim();
  const credential = authorization || apiKey;
  const digest = createHash('sha256').update(credential).digest('hex').slice(0, 16);
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${digest}`;
}

function isOtlpPath(path: string): boolean {
  return /(?:^|\/)v1\/(?:traces|metrics|logs)$/.test(path);
}

function guard(req: Request, res: Response, next: NextFunction): void {
  if (!isOtlpPath(req.path) || req.method !== 'POST') {
    next();
    return;
  }
  const now = Date.now();
  const key = credentialKey(req);
  const existing = buckets.get(key);
  const bucket = existing && now - existing.startedAt < WINDOW_MS
    ? existing
    : { startedAt: now, count: 0 };
  bucket.count += 1;
  buckets.set(key, bucket);
  const remaining = Math.max(0, limitPerMinute() - bucket.count);
  res.set('X-RateLimit-Limit', String(limitPerMinute()));
  res.set('X-RateLimit-Remaining', String(remaining));
  if (bucket.count > limitPerMinute()) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + WINDOW_MS - now) / 1_000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ ok: false, error: 'otlp_rate_limited', code: 'otlp_rate_limited', retryable: true });
    return;
  }
  next();
}

export function createOtlpIngestGuard(): Router {
  const router = Router();
  router.use(guard);
  return router;
}
