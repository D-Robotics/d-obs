import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { resolveGatewayChatTarget } from './copilot-model.js';

const keys = ['RDK_PLATFORM_ASSISTANT_BASE_URL', 'RDK_PLATFORM_ASSISTANT_MODEL', 'RDK_PLATFORM_ASSISTANT_API_KEY', 'RDK_STUDIO_AGENT_BASE_URL', 'RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL', 'RDK_STUDIO_AGENT_MODEL', 'RDK_STUDIO_AGENT_GATEWAY_PUBLIC_MODEL', 'RDK_STUDIO_AGENT_API_KEY', 'RDK_GATEWAY_ADMIN_URL', 'GATEWAY_ADMIN_KEY'];
let saved: Record<string, string | undefined>;
let originalFetch: typeof fetch;
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.RDK_GATEWAY_ADMIN_URL = 'http://127.0.0.1:43100';
  process.env.GATEWAY_ADMIN_KEY = 'fixture-admin';
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('incident copilot prefers configured gateway client credentials without fetching masked admin config', async () => {
  process.env.RDK_PLATFORM_ASSISTANT_BASE_URL = 'http://127.0.0.1:3100/v1';
  process.env.RDK_PLATFORM_ASSISTANT_MODEL = 'frontend-model';
  process.env.RDK_PLATFORM_ASSISTANT_API_KEY = 'fixture-client-key';
  globalThis.fetch = async () => { throw new Error('admin config must not be read'); };
  assert.deepEqual(await resolveGatewayChatTarget(), { baseUrl: 'http://127.0.0.1:3100/v1', model: 'frontend-model', apiKey: 'fixture-client-key' });
});

test('legacy masked provider keys cannot become inference credentials', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ modelMapping: {
    masked: { baseUrl: 'https://provider.invalid/v1', model: 'provider-model', apiKey: '***' },
    preview: { baseUrl: 'https://provider.invalid/v1', model: 'provider-model', apiKey: 'sk-preview...tail' },
    marker: { baseUrl: 'https://provider.invalid/v1', model: 'provider-model', apiKey: '[REDACTED]' },
  } }), { headers: { 'content-type': 'application/json' } });
  assert.equal(await resolveGatewayChatTarget(), null);
});

test('legacy full provider credentials retain compatibility when no gateway client is configured', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ modelMapping: {
    provider: { baseUrl: 'https://provider.invalid/v1', model: 'provider-model', apiKey: 'fixture-full-provider-key' },
  } }), { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await resolveGatewayChatTarget(), { baseUrl: 'https://provider.invalid/v1', model: 'provider-model', apiKey: 'fixture-full-provider-key' });
});
