import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeGatewayConfigSummary } from './observability-model-pool-routes.js';

test('model pool config sent to the workbench never includes upstream API keys', () => {
  const safe = sanitizeGatewayConfigSummary({
    modelMapping: {
      primary: {
        baseUrl: 'https://provider.example/v1',
        model: 'model-a',
        label: 'Primary',
        apiKey: 'sk-secret-provider-key',
        fallbacks: ['backup'],
        weight: 100,
      },
    },
    fallbackPolicy: { mode: 'ordered' },
  });

  const mapping = (safe.modelMapping as Record<string, Record<string, unknown>>).primary;
  assert.equal(mapping.apiKey, undefined);
  assert.deepEqual(mapping, {
    baseUrl: 'https://provider.example/v1',
    model: 'model-a',
    label: 'Primary',
    fallbacks: ['backup'],
    weight: 100,
  });
  assert.deepEqual(safe.fallbackPolicy, { mode: 'ordered' });
});
