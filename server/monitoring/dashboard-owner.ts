import type { Request } from 'express';
import { getSessionSsoUser } from './observability-access-adapter.js';
import { resolveOpsActor } from './observability-route-kit.js';
import { migrateDashboardOwner } from './dashboard-boards-store.js';

const owners = new WeakMap<Request, Promise<string>>();
/** Keep display names out of dashboard ownership; leave other audit actors unchanged. */
export function resolveDashboardOwner(req: Request): Promise<string> {
  const cached = owners.get(req);
  if (cached) return cached;
  const owner = (async () => {
    const user = getSessionSsoUser(req);
    if (!user) return resolveOpsActor(req);
    if (!user.id || /[\u0000-\u001f\u007f]/.test(user.id)) throw new Error('invalid_dashboard_identity');
    const stable = `sso:${user.id}`;
    const aliases = [user.id];
    if (typeof user.email === 'string' && user.email.trim() && !/[\u0000-\u001f\u007f]/.test(user.email)) aliases.push(user.email);
    // Names may collide and change. They must never grant access to old rows.
    await migrateDashboardOwner(aliases, stable);
    return stable;
  })();
  owners.set(req, owner);
  return owner;
}
