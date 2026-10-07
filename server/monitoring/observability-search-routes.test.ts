import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterObservabilitySearchResults,
  incidentToSearchResult,
  registeredObjectToSearchResult,
} from './observability-search-routes.js';

const object = {
  owner: 'public-owner',
  objectId: 'device/rdk-s100-0003',
  objectType: 'device',
  displayName: '实验室 X5',
  labels: { site: 'lab-a', serial: 'rdk-s100-0003' },
  signalKinds: ['metrics'],
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-07T00:00:00.000Z',
};

test('实体搜索结果只暴露稳定身份和工作台深链', () => {
  assert.deepEqual(registeredObjectToSearchResult(object), {
    type: 'object',
    id: 'device/rdk-s100-0003',
    title: '实验室 X5',
    status: 'registered',
    view: 'alerts',
    deepLink: '#alerts/objects',
  });
  assert.deepEqual(incidentToSearchResult({ key: 'disk-space', title: '磁盘空间不足', status: 'open' }), {
    type: 'incident',
    id: 'disk-space',
    title: '磁盘空间不足',
    status: 'open',
    view: 'alerts',
    deepLink: '#alerts/center',
  });
});

test('实体搜索支持对象标签、事故摘要，并把活跃事故排在前面', () => {
  const results = filterObservabilitySearchResults(
    [object],
    [
      { key: 'disk-space', title: '磁盘空间不足', status: 'open', summary: '实验室 X5 根分区使用率超过阈值', objectId: object.objectId },
      { key: 'old-incident', title: '历史事故', status: 'resolved', summary: '已恢复' },
    ],
    '实验室',
    10,
  );
  assert.deepEqual(results.map((item) => [item.type, item.id]), [
    ['incident', 'disk-space'],
    ['object', 'device/rdk-s100-0003'],
  ]);
  assert.equal(filterObservabilitySearchResults([object], [], 'serial=rdk-s100-0003', 10).length, 1);
  assert.equal(filterObservabilitySearchResults([object], [], 'missing', 10).length, 0);
});

test('实体搜索结果限制在 1 到 50 条，并保持空查询可返回默认候选', () => {
  const results = filterObservabilitySearchResults(
    Array.from({ length: 60 }, (_, index) => ({ ...object, objectId: `service/s-${index}`, displayName: `服务 ${index}` })),
    [],
    '',
    500,
  );
  assert.equal(results.length, 50);
  assert.equal(filterObservabilitySearchResults([object], [], 'missing', 0).length, 0);
});
