import { createHash } from 'node:crypto';

/**
 * Stable identity for the one default key owned by an SSO account.
 *
 * The raw account id is deliberately not embedded in any gateway identifier:
 * intent rows and idempotency headers can appear in operational traces, while
 * a stable digest still lets a retry find the same gateway-side create.
 */
export type DefaultGatewayKeyProvisionIdentity = {
  intentId: string;
  keyId: string;
  idempotencyKey: string;
};

export function defaultGatewayKeyProvisionIdentity(
  ssoUserId: string,
): DefaultGatewayKeyProvisionIdentity {
  const owner = String(ssoUserId ?? '').trim();
  if (!owner) throw new Error('defaultGatewayKeyProvisionIdentity: ssoUserId 不能为空');
  const digest = createHash('sha256').update(owner).digest('hex').slice(0, 32);
  return {
    intentId: `default:${digest}`,
    keyId: `k_default_${digest}`,
    idempotencyKey: `rdk-studio:default:${digest}`,
  };
}

/** Keep recovery metadata useful without persisting credentials or huge bodies. */
export function summarizeGatewayProvisionError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error ?? 'unknown_error');
  return raw
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._~-]+/g, '[redacted]')
    .replace(/(authorization|api[-_ ]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 240);
}
