/**
 * Shared account-plane origin resolver for server-side relay and session repair.
 * Desktop packages may inject either RDK_ACCOUNT_CLOUD_ORIGIN or the legacy
 * RDK_CREDITS_CENTRAL_URL; direct DB deployments must stay local.
 */
export function resolveServerAccountCloudOrigin(env = process.env): string {
  if (String(env.RDK_CHAT_CREDITS_DB_URL ?? '').trim()) return '';
  return String(env.RDK_ACCOUNT_CLOUD_ORIGIN || env.RDK_CREDITS_CENTRAL_URL || '')
    .trim()
    .replace(/\/+$/, '');
}
