/** Explicit server configuration for cross-account action approval, never a client grant. */
type ApprovalEnvironment = { RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES?: string; RDK_FLYWHEEL_ADMIN_USER_IDS?: string };
const MAX_CONFIG_LENGTH = 65_536;
const MAX_SUBJECTS = 64;
const MAX_SCOPES_PER_SUBJECT = 16;
const ID = /^[\p{L}\p{N}][\p{L}\p{N}_.@:-]{0,255}$/u;
const RESERVED = new Set(['all', 'any', 'anonymous', '*']);
function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) && !RESERVED.has(value.toLowerCase());
}
function parseConfiguration(raw: string): Record<string, string[]> {
  if (raw.length > MAX_CONFIG_LENGTH) throw new Error('action_approval_scope_config_invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('action_approval_scope_config_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('action_approval_scope_config_invalid');
  const entries = Object.entries(parsed);
  if (entries.length > MAX_SUBJECTS) throw new Error('action_approval_scope_config_invalid');
  const result: Record<string, string[]> = Object.create(null);
  for (const [subject, scopes] of entries) {
    if (!identifier(subject) || ['__proto__', 'prototype', 'constructor'].includes(subject)
      || !Array.isArray(scopes) || scopes.length > MAX_SCOPES_PER_SUBJECT
      || scopes.some(scope => typeof scope !== 'string' || scope.length > 256 || !scope.startsWith('studio:') || !identifier(scope.slice(7)))) {
      throw new Error('action_approval_scope_config_invalid');
    }
    result[subject] = [...new Set(scopes)];
  }
  return result;
}

/** The caller has already checked admin authority and the authentic SSO session. */
export function resolveObservabilityActionApprovalScopes(
  genuineSsoUserId: string | undefined, ownAccountScopeId: string, environment: ApprovalEnvironment = process.env,
): string[] {
  const configured = String(environment.RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES ?? '');
  if (configured.length > MAX_CONFIG_LENGTH) throw new Error('action_approval_scope_config_invalid');
  const raw = configured.trim();
  if (!raw || !genuineSsoUserId) return [ownAccountScopeId];
  const config = parseConfiguration(raw);
  const admins = new Set(String(environment.RDK_FLYWHEEL_ADMIN_USER_IDS ?? '').split(/[\s,]+/).filter(Boolean));
  // A matching admin token is not sufficient to make an ordinary SSO user an
  // approval delegate. Both the subject and target must be explicitly active
  // SSO administrators; stale/unknown configured IDs never acquire a grant.
  if (!admins.has(genuineSsoUserId)) return [ownAccountScopeId];
  const allowed = (config[genuineSsoUserId] ?? []).filter(scope => admins.has(scope.slice(7)));
  return [...new Set([ownAccountScopeId, ...allowed])];
}
