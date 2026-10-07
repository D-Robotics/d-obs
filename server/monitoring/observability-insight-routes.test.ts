import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRegisteredObjects, registeredObjectToCatalogObject } from './observability-insight-routes.js';

test('告警对象目录合并持久化 OTLP 注册表，而不是只看内存 run', () => {
  const result = mergeRegisteredObjects(
    { generatedAt: 1, total: 0, limit: 200, objects: [] },
    [{
      owner: 'public-owner',
      objectId: 'device/rdk-s100-0003',
      objectType: 'device',
      displayName: 'rdk-s100-0003',
      labels: { 'device.id': 'rdk-s100-0003', 'host.name': 'orion-lab' },
      signalKinds: ['metrics'],
      firstSeenAt: '2026-09-23T13:22:38.000Z',
      lastSeenAt: '2026-09-23T13:22:38.000Z',
    }],
  );

  assert.equal(result.total, 1);
  assert.equal(result.objects[0]?.objectId, 'device/rdk-s100-0003');
  assert.deepEqual(result.objects[0]?.profile?.labels, ['device.id=rdk-s100-0003', 'host.name=orion-lab']);
});

test('告警对象注册表映射尊重类型、搜索和归档筛选', () => {
  const item = registeredObjectToCatalogObject({
    owner: 'public-owner',
    objectId: 'service/d-obs',
    objectType: 'service',
    displayName: 'd-obs',
    labels: { signal_source: 'self' },
    signalKinds: ['metrics'],
    firstSeenAt: '2026-09-23T13:22:38.000Z',
    lastSeenAt: '2026-09-23T13:22:38.000Z',
  });
  assert.equal(item.profile?.archived, false);
  assert.equal(
    mergeRegisteredObjects({ generatedAt: 1, total: 0, limit: 200, objects: [] }, [
      {
        owner: 'public-owner', objectId: 'service/d-obs', objectType: 'service', displayName: 'd-obs',
        labels: { signal_source: 'self' }, signalKinds: ['metrics'],
        firstSeenAt: '2026-09-23T13:22:38.000Z', lastSeenAt: '2026-09-23T13:22:38.000Z',
      },
    ], { objectType: 'device' }).total,
    0,
  );
  assert.equal(
    mergeRegisteredObjects({ generatedAt: 1, total: 0, limit: 200, objects: [] }, [
      {
        owner: 'public-owner', objectId: 'service/d-obs', objectType: 'service', displayName: 'd-obs',
        labels: { signal_source: 'self' }, signalKinds: ['metrics'],
        firstSeenAt: '2026-09-23T13:22:38.000Z', lastSeenAt: '2026-09-23T13:22:38.000Z',
      },
    ], { q: 'missing' }).total,
    0,
  );
});
