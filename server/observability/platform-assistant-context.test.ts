import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlatformAssistantContext } from './platform-assistant-context.js';
import { platformAssistantContextArguments, type PlatformAssistantOperation } from './platform-assistant.js';

test('work context accepts real references and scope, rejecting authority and arbitrary content', () => {
  const context = { view: 'traces', environment: 'staging', timeWindow: { hours: 24, from: '2026-10-12T00:00:00Z', to: '2026-10-13T00:00:00Z' },
    selection: { runLocator: 'signed-locator', runRef: 'anonymous-run' }, filters: { status: 'failed' } };
  assert.deepEqual(validatePlatformAssistantContext(context), context);
  for (const bad of [{ role: 'admin' }, { selection: { token: 'secret' } }, { filters: { query: 'x'.repeat(201) } },
    { timeWindow: { hours: '24' } }, { environment: 'another-host' }, { selection: { deviceId: 'a\nb' } },
    { timeWindow: { from: '2026-10-13T00:00:00Z', to: '2026-10-12T00:00:00Z' } }]) {
    assert.throws(() => validatePlatformAssistantContext(bad), /invalid_context/);
  }
});

const read: PlatformAssistantOperation = { id: 'GET /runs/:locator', method: 'GET', path: '/runs/:locator', mutating: false,
  group: 'runs', description: '读取运行', parameters: { query: { environment: '环境', hours: '范围' } } };
test('only matching selected parameters and declared read ranges are inherited; explicit arguments win', () => {
  const context = { environment: 'staging' as const, timeWindow: { hours: 24 }, selection: { runLocator: 'selected-run', deviceId: 'other-object' } };
  assert.deepEqual(platformAssistantContextArguments(read, {}, context), { params: { locator: 'selected-run' }, query: { environment: 'staging', hours: 24 } });
  assert.deepEqual(platformAssistantContextArguments(read, { params: { locator: 'requested-run' }, query: { environment: 'test', hours: 2 } }, context),
    { params: { locator: 'requested-run' }, query: { environment: 'test', hours: 2 } });
  assert.deepEqual(platformAssistantContextArguments({ ...read, parameters: {} }, {}, context), { params: { locator: 'selected-run' } });
  assert.deepEqual(platformAssistantContextArguments(read, {}, { selection: { runRef: 'anonymous-only' } }), {});
});
test('writes can target a selected object but never inherit page filters into saved configuration', () => {
  const mutation = { ...read, mutating: true, method: 'POST' };
  assert.deepEqual(platformAssistantContextArguments(mutation, { body: { threshold: 3 } }, { selection: { runLocator: 'selected-run' }, timeWindow: { hours: 24 } }),
    { body: { threshold: 3 }, params: { locator: 'selected-run' } });
});
