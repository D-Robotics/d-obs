import assert from 'node:assert/strict';
import test from 'node:test';

import { projectStudioTraceCoverage } from '../../shared/studio-trace-coverage.js';

const BASE = {
  surface: 'desktop' as const,
  hasRunSummary: true,
  observedSegments: [],
};

test('未上报版本不得判为 version_unsupported（run fact 无 moc/moss 版本列）', () => {
  const coverage = projectStudioTraceCoverage({
    ...BASE,
    studioVersion: '1.4.4',
  });
  assert.equal(coverage.state, 'summary_only');
  assert.deepEqual(coverage.reasonCodes, ['not_received']);
  assert.equal(coverage.missingSegments.length, 5);
  assert.equal(coverage.eligible, true);
});

test('完全无版本字段时同样按片段证据判定', () => {
  const coverage = projectStudioTraceCoverage(BASE);
  assert.equal(coverage.state, 'summary_only');
  assert.deepEqual(coverage.reasonCodes, ['not_received']);
});

test('已上报且低于最低 Studio 版本仍判 version_unsupported', () => {
  const coverage = projectStudioTraceCoverage({
    ...BASE,
    studioVersion: '1.3.5',
  });
  assert.equal(coverage.state, 'summary_only');
  assert.deepEqual(coverage.reasonCodes, ['version_unsupported']);
  assert.equal(coverage.eligible, false);
});

test('已上报的旧 MOC 主版本仍判 version_unsupported', () => {
  const coverage = projectStudioTraceCoverage({
    ...BASE,
    studioVersion: '1.4.4',
    mocVersion: '0.9.1',
  });
  assert.equal(coverage.eligible, false);
  assert.deepEqual(coverage.reasonCodes, ['version_unsupported']);
});

test('上报畸形 MOC 版本按不兼容处理（fail closed）', () => {
  const coverage = projectStudioTraceCoverage({
    ...BASE,
    studioVersion: '1.4.4',
    mocVersion: 'not-a-version',
  });
  assert.equal(coverage.eligible, false);
  assert.deepEqual(coverage.reasonCodes, ['version_unsupported']);
});

test('local-dev 形态维持 legacy 语义不变', () => {
  const coverage = projectStudioTraceCoverage({
    ...BASE,
    surface: 'local-dev',
    studioVersion: '1.4.4',
  });
  assert.equal(coverage.state, 'summary_only');
  assert.deepEqual(coverage.reasonCodes, ['legacy']);
});

test('版本达标且片段齐全仍为 complete', () => {
  const coverage = projectStudioTraceCoverage({
    surface: 'web-cloud' as const,
    studioVersion: '1.4.2',
    mossVersion: '136.0.0',
    mocVersion: '1.0.0',
    hasRunSummary: true,
    observedSegments: ['client', 'studio_transport', 'moss_root', 'moss_children', 'terminal'],
  });
  assert.equal(coverage.state, 'complete');
  assert.deepEqual(coverage.missingSegments, []);
});
