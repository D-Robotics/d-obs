import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformAssistantReadback } from './platform-assistant-verification.js';
import type { PlatformAssistantOperation, PlatformAssistantOperationResult } from '../observability/platform-assistant.js';

const operation = (path: string, method: string): PlatformAssistantOperation => ({ id: `${method} ${path}`, method, path, mutating: method !== 'GET', description: 'fixture', group: 'fixture', parameters: { query: { tenant: '视角' } } });
const receipt: PlatformAssistantOperationResult = { id: 'unused', ok: true, status: 201, description: 'fixture', data: { action: { id: 'action-a' } } };
test('returned action details are preferred over the collection, retaining explicitly authorized tenant view', () => {
  const path = '/api/ops/observability/actions';
  const plan = platformAssistantReadback(operation(path, 'POST'), { query: { tenant: 'team-b', unsupported: 'ignored' } }, receipt,
    [operation(path, 'GET'), operation(`${path}/:id`, 'GET')]);
  assert.deepEqual(plan, { id: `GET ${path}/:id`, args: { params: { id: 'action-a' }, query: { tenant: 'team-b' } } });
});
test('collection readback retains mutation perspective and never invents a detail endpoint', () => {
  const path = '/api/ops/observability/strategies';
  assert.deepEqual(platformAssistantReadback(operation(path, 'POST'), { query: { tenant: 'team-b' } }, receipt, [operation(path, 'GET')]),
    { id: `GET ${path}`, args: { query: { tenant: 'team-b' } } });
  assert.equal(platformAssistantReadback(operation(path, 'DELETE'), {}, receipt, [operation(path, 'GET')]), undefined);
  assert.equal(platformAssistantReadback(operation(path, 'POST'), {}, { ...receipt, ok: false }, [operation(path, 'GET')]), undefined);
});
