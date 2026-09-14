/**
 * Requests intentionally sent by an external health check must not become
 * production incidents. Keep this matcher deliberately narrow: a real OAuth
 * authorization code is never the reserved `fake` sentinel.
 */
export type ProbeRequestLike = {
  path?: unknown;
  query?: unknown;
};

export function isSyntheticSsoCallbackProbe(request: ProbeRequestLike): boolean {
  if (String(request.path ?? '') !== '/api/sso/callback') return false;
  if (!request.query || typeof request.query !== 'object') return false;
  const code = (request.query as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim().toLowerCase() === 'fake';
}
