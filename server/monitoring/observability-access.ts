/** Shared operations-admin gate for the observability routes and action API. */
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import {
  deploymentAllowsAnonymousLocalOperator,
  getSessionSsoUser,
  isMultiUserWebDeployment,
} from './observability-access-adapter.js';

function adminTokenMatches(provided: string): boolean {
  const expected = String(process.env.RDK_CREDITS_ADMIN_TOKEN ?? '').trim();
  if (!expected || !provided) return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/**
 * A caller that presents an admin-token header is making an explicit
 * credentialed request.  Treat a malformed/incorrect token as a hard denial,
 * even on single-user deployments where an absent token is intentionally
 * allowed for the local operator.  Keeping this distinction here lets the
 * public bootstrap dispatch token-only requests before the global SSO gate
 * without accidentally turning an invalid credential into anonymous access.
 */
export function hasInvalidAdminToken(req: Request): boolean {
  const provided = String(req.header('x-admin-token') ?? '').trim();
  if (!provided || adminTokenMatches(provided)) return false;
  // A browser may retain a stale token header while carrying a valid SSO
  // session.  In that case the session remains the source of authority; the
  // token must not shadow a legitimate authenticated request.  Token-only
  // callers have no session and still fail closed below.
  return !getSessionSsoUser(req);
}

function opsAdminUserIds(): Set<string> {
  return new Set(
    String(process.env.RDK_FLYWHEEL_ADMIN_USER_IDS ?? '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Operations access is intentionally independent of the central-store
 * feature flag: the caller may need a clear 403/503 from either route family.
 * In multi-user deployments only the constant-time admin token or an
 * explicitly configured SSO administrator is accepted.
 */
export function isOpsAdminRequest(req: Request): boolean {
  const providedToken = String(req.header('x-admin-token') ?? '').trim();
  if (providedToken) {
    if (adminTokenMatches(providedToken)) return true;
    const sessionUser = getSessionSsoUser(req);
    if (!sessionUser) return false;
    return !isMultiUserWebDeployment() || opsAdminUserIds().has(sessionUser.id);
  }
  if (isMultiUserWebDeployment()) {
    const user = getSessionSsoUser(req);
    return Boolean(user && opsAdminUserIds().has(user.id));
  }
  // Single-user mode is anonymous only when the listener is actually bound to
  // loopback.  `SSO_REQUIRED=0` is not a network trust boundary: if a desktop
  // or local-dev process is deliberately exposed on LAN/0.0.0.0, an unauthenticated
  // caller must not gain access to the action/remediation surface.
  return deploymentAllowsAnonymousLocalOperator();
}

export function resolveOpsActorId(req: Request): string {
  const user = getSessionSsoUser(req);
  if (user) return user.email || user.name || user.id;
  return adminTokenMatches(String(req.header('x-admin-token') ?? '')) ? 'admin-token' : 'ops-admin';
}
