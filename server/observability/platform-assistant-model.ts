/** Assistant gateway configuration comes only from trusted server environment. */
import { isIP } from 'node:net';
import { readStudioAgentEnv, type StudioAgentEnvironment } from '../agent/studio-agent-env.js';

export type PlatformAssistantChatTarget = { baseUrl: string; model: string; apiKey: string };

function readAssistantEnv(env: StudioAgentEnvironment, key: string): string {
  return String(env[key] ?? '').trim();
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
}

function safeBaseUrl(value: string): string | null {
  if (!value || value.length > 4_096 || /[\u0000-\u0020\u007f?#\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Does not read masked admin configuration, discover upstream keys, or mutate env. */
export async function resolvePlatformAssistantChatTarget(
  env: StudioAgentEnvironment = process.env,
): Promise<PlatformAssistantChatTarget | null> {
  const configuredBaseUrl = readAssistantEnv(env, 'RDK_PLATFORM_ASSISTANT_BASE_URL')
    || readStudioAgentEnv('gatewayPublicBaseUrl', env, readStudioAgentEnv('baseUrl', env));
  const model = readAssistantEnv(env, 'RDK_PLATFORM_ASSISTANT_MODEL')
    || readStudioAgentEnv('gatewayPublicModel', env, readStudioAgentEnv('model', env));
  const apiKey = readAssistantEnv(env, 'RDK_PLATFORM_ASSISTANT_API_KEY') || readStudioAgentEnv('apiKey', env);
  const baseUrl = safeBaseUrl(configuredBaseUrl);
  if (!baseUrl || !model || !apiKey || model.length > 512 || apiKey.length > 16_384
    || /[\u0000-\u001f\u007f]/.test(model) || /[\u0000-\u001f\u007f]/.test(apiKey)) return null;
  return { baseUrl, model, apiKey };
}
