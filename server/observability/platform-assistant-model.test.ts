import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePlatformAssistantChatTarget } from './platform-assistant-model.js';

const explicit = {
  RDK_PLATFORM_ASSISTANT_BASE_URL: 'https://assistant-gateway.example/v1/',
  RDK_PLATFORM_ASSISTANT_MODEL: 'assistant-public-model',
  RDK_PLATFORM_ASSISTANT_API_KEY: 'assistant-client-key',
};

test('dedicated assistant configuration takes precedence over all Studio defaults', async () => {
  const target = await resolvePlatformAssistantChatTarget({
    ...explicit,
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL: 'https://public.example/v1',
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_MODEL: 'public-model',
    RDK_STUDIO_AGENT_BASE_URL: 'https://base.example/v1',
    RDK_STUDIO_AGENT_MODEL: 'base-model',
    RDK_STUDIO_AGENT_API_KEY: 'studio-client-key',
  });
  assert.deepEqual(target, { baseUrl: 'https://assistant-gateway.example/v1', model: 'assistant-public-model', apiKey: 'assistant-client-key' });
});

test('canonical public gateway configuration is preferred over the managed upstream defaults', async () => {
  assert.deepEqual(await resolvePlatformAssistantChatTarget({
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL: 'https://public.example/v1/',
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_MODEL: 'public-model',
    RDK_STUDIO_AGENT_BASE_URL: 'https://base.example/v1',
    RDK_STUDIO_AGENT_MODEL: 'base-model',
    RDK_STUDIO_AGENT_API_KEY: 'studio-client-key',
  }), { baseUrl: 'https://public.example/v1', model: 'public-model', apiKey: 'studio-client-key' });
});

test('canonical base/model/key remain valid fallback without public gateway overrides', async () => {
  assert.deepEqual(await resolvePlatformAssistantChatTarget({
    RDK_STUDIO_AGENT_BASE_URL: 'http://127.0.0.1:8050/v1',
    RDK_STUDIO_AGENT_MODEL: 'studio-model',
    RDK_STUDIO_AGENT_API_KEY: 'studio-client-key',
  }), { baseUrl: 'http://127.0.0.1:8050/v1', model: 'studio-model', apiKey: 'studio-client-key' });
});

test('partial explicit configuration falls back per field and whitespace is normalized', async () => {
  const env = Object.freeze({
    RDK_PLATFORM_ASSISTANT_MODEL: ' assistant-model ',
    RDK_PLATFORM_ASSISTANT_BASE_URL: '   ',
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL: ' https://public.example/v1/ ',
    RDK_STUDIO_AGENT_API_KEY: ' client-key ',
  });
  assert.deepEqual(await resolvePlatformAssistantChatTarget(env), { baseUrl: 'https://public.example/v1', model: 'assistant-model', apiKey: 'client-key' });
  assert.equal(env.RDK_STUDIO_AGENT_API_KEY, ' client-key ');
});

test('missing endpoint, model or client credential returns null', async () => {
  assert.equal(await resolvePlatformAssistantChatTarget({}), null);
  for (const key of Object.keys(explicit)) {
    const env: Record<string, string | undefined> = { ...explicit };
    delete env[key];
    assert.equal(await resolvePlatformAssistantChatTarget(env), null, key);
  }
});

test('only HTTPS and actual loopback HTTP targets are accepted', async () => {
  for (const baseUrl of ['https://remote.example/v1', 'http://localhost:8050/v1', 'http://127.0.0.1:8050/v1', 'http://127.9.8.7:8050/v1', 'http://[::1]:8050/v1']) {
    assert.notEqual(await resolvePlatformAssistantChatTarget({ ...explicit, RDK_PLATFORM_ASSISTANT_BASE_URL: baseUrl }), null, baseUrl);
  }
  for (const baseUrl of ['http://remote.example/v1', 'http://192.168.1.5:8050/v1', 'http://127.0.0.1.evil.example/v1', 'http://localhost.evil.example/v1', 'http://[2001:db8::1]/v1', 'ftp://localhost/v1', 'not-a-url']) {
    assert.equal(await resolvePlatformAssistantChatTarget({ ...explicit, RDK_PLATFORM_ASSISTANT_BASE_URL: baseUrl }), null, baseUrl);
  }
});

test('URL credentials, query strings, fragments and parser control characters are rejected', async () => {
  for (const baseUrl of [
    'https://user:pass@remote.example/v1', 'https://user@remote.example/v1',
    'https://remote.example/v1?token=value', 'https://remote.example/v1?',
    'https://remote.example/v1#fragment', 'https://remote.example/v1#',
    'https://remote.exa\nmple/v1', 'https://remote.example/a path', 'https:\\remote.example\\v1',
  ]) {
    assert.equal(await resolvePlatformAssistantChatTarget({ ...explicit, RDK_PLATFORM_ASSISTANT_BASE_URL: baseUrl }), null, baseUrl);
  }
});

test('unsafe explicit configuration is rejected instead of silently using a different Studio endpoint', async () => {
  assert.equal(await resolvePlatformAssistantChatTarget({
    ...explicit,
    RDK_PLATFORM_ASSISTANT_BASE_URL: 'http://untrusted.example/v1',
    RDK_STUDIO_AGENT_GATEWAY_PUBLIC_BASE_URL: 'https://valid.example/v1',
  }), null);
});

test('model and client key control characters cannot enter gateway requests', async () => {
  assert.equal(await resolvePlatformAssistantChatTarget({ ...explicit, RDK_PLATFORM_ASSISTANT_API_KEY: 'client-key\r\nx-identity: admin' }), null);
  assert.equal(await resolvePlatformAssistantChatTarget({ ...explicit, RDK_PLATFORM_ASSISTANT_MODEL: 'model\0injection' }), null);
});

test('generic request or provider fields are not server configuration sources', async () => {
  assert.equal(await resolvePlatformAssistantChatTarget({
    BASE_URL: 'https://request.example/v1', MODEL: 'request-model', API_KEY: 'request-key',
    OPENAI_BASE_URL: 'https://provider.example/v1', OPENAI_MODEL: 'provider-model', OPENAI_API_KEY: 'provider-key',
  }), null);
});
