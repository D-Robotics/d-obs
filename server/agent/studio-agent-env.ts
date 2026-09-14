/** Canonical server-side environment contract for Studio's Agent integration. */
export const STUDIO_AGENT_ENV_KEYS = {
  apiKey: 'RDK_STUDIO_AGENT_API_KEY',
  baseUrl: 'RDK_STUDIO_AGENT_BASE_URL',
  gatewayPublicBaseUrl: 'RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL',
  gatewayPublicModel: 'RDK_STUDIO_AGENT_GATEWAY_PUBLIC_MODEL',
  dailyChatLimit: 'RDK_STUDIO_AGENT_DAILY_CHAT_LIMIT',
  enforceDesktopCredits: 'RDK_STUDIO_AGENT_CHAT_CREDITS_ENFORCE_DESKTOP',
  healthUrl: 'RDK_STUDIO_AGENT_HEALTH_URL',
  healthKey: 'RDK_STUDIO_AGENT_HEALTH_KEY',
  healthTimeoutMs: 'RDK_STUDIO_AGENT_HEALTH_TIMEOUT_MS',
  healthLatencyBudgetMs: 'RDK_STUDIO_AGENT_HEALTH_LATENCY_BUDGET_MS',
  model: 'RDK_STUDIO_AGENT_MODEL',
  provider: 'RDK_STUDIO_AGENT_PROVIDER',
} as const;

export type StudioAgentEnvName = keyof typeof STUDIO_AGENT_ENV_KEYS;
export type StudioAgentEnvironment = Record<string, string | undefined>;

export function readStudioAgentEnv(
  name: StudioAgentEnvName,
  env: StudioAgentEnvironment = process.env,
  fallback = '',
): string {
  const canonicalKey = STUDIO_AGENT_ENV_KEYS[name];
  const canonicalValue = String(env[canonicalKey] ?? '').trim();
  if (canonicalValue) return canonicalValue;
  return String(fallback).trim();
}

/** Actual upstream model for Studio's managed Agent lane. No product-name alias fallback. */
export function resolveStudioManagedAgentModel(
  env: StudioAgentEnvironment = process.env,
): string {
  return readStudioAgentEnv('model', env, readStudioAgentEnv('gatewayPublicModel', env));
}

/** Public model id handed to external gateway clients. */
export function resolveStudioGatewayPublicModel(
  env: StudioAgentEnvironment = process.env,
): string {
  return readStudioAgentEnv('gatewayPublicModel', env, readStudioAgentEnv('model', env));
}

/** Resolve canonical placeholders while leaving unrelated provider variables generic. */
export function readStudioAgentEnvPlaceholder(
  environmentKey: string,
  env: StudioAgentEnvironment = process.env,
): string {
  const entry = (Object.entries(STUDIO_AGENT_ENV_KEYS) as [StudioAgentEnvName, string][]).find(
    ([, canonicalKey]) => canonicalKey === environmentKey,
  );
  if (!entry) return String(env[environmentKey] ?? '');
  if (entry[0] === 'model') {
    return resolveStudioManagedAgentModel(env);
  }
  return readStudioAgentEnv(entry[0], env);
}
