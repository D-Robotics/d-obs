/**
 * 外部拨测上报回归测试：报告解析的严格校验、租户 alert_key 命名空间，
 * 以及"数据库不可用时身份解析 fail-closed 不抛异常"的崩溃回归。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseExternalProbeReport,
  resolveProbeReportIdentity,
  tenantAlertKey,
  type ExternalProbeReport,
} from './external-probe-ingest.js';

function baseReport(): Record<string, unknown> {
  return {
    generatedAt: '2026-09-15T00:00:00Z',
    source: '106.53',
    checks: [
      { key: 'external-dns', title: 'DNS', enabled: true, ok: true, active: false, failures: 0, successes: 10, detail: 'ok' },
      { key: 'external-tls', title: 'TLS', enabled: true, ok: true, active: false, failures: 0, successes: 10, detail: 'ok' },
      { key: 'external-health', title: 'Health', enabled: true, ok: true, active: false, failures: 0, successes: 10, detail: 'ok' },
      { key: 'external-entry-asset', title: 'Entry', enabled: true, ok: true, active: false, failures: 0, successes: 10, detail: 'ok' },
    ],
  };
}

test('合法报告完整解析，计数钳制在 [0,1000]', () => {
  const raw = baseReport();
  (raw.checks as Array<Record<string, unknown>>)[0].failures = 99999;
  (raw.checks as Array<Record<string, unknown>>)[0].successes = -5;
  const report = parseExternalProbeReport(raw);
  assert.ok(report);
  assert.equal(report.checks.length, 4);
  assert.equal(report.checks[0].failures, 1000);
  assert.equal(report.checks[0].successes, 0);
  assert.equal(report.generatedAt, '2026-09-15T00:00:00.000Z');
});

test('结构非法直接拒绝：非对象、坏时间戳、错 source、缺 checks', () => {
  assert.equal(parseExternalProbeReport(null), null);
  assert.equal(parseExternalProbeReport('x'), null);
  assert.equal(parseExternalProbeReport({ ...baseReport(), generatedAt: 'not-a-date' }), null);
  assert.equal(parseExternalProbeReport({ ...baseReport(), source: 'other' }), null);
  assert.equal(parseExternalProbeReport({ ...baseReport(), checks: undefined }), null);
});

test('检查项非法拒绝：未知 key、缺字段、重复 key、数量不符', () => {
  const unknownKey = baseReport();
  (unknownKey.checks as Array<Record<string, unknown>>)[0].key = 'external-evil';
  assert.equal(parseExternalProbeReport(unknownKey), null);

  const missingField = baseReport();
  delete (missingField.checks as Array<Record<string, unknown>>)[0].ok;
  assert.equal(parseExternalProbeReport(missingField), null);

  const duplicate = baseReport();
  (duplicate.checks as Array<Record<string, unknown>>)[1].key = 'external-dns';
  assert.equal(parseExternalProbeReport(duplicate), null);

  const partial = baseReport();
  (partial.checks as unknown[]).pop();
  assert.equal(parseExternalProbeReport(partial), null);
});

test('字段类型错误拒绝：布尔与数字强校验', () => {
  const wrongTypes = baseReport();
  (wrongTypes.checks as Array<Record<string, unknown>>)[0].ok = 'true';
  assert.equal(parseExternalProbeReport(wrongTypes), null);
  const nanFailures = baseReport();
  (nanFailures.checks as Array<Record<string, unknown>>)[0].failures = 'lots';
  const report = parseExternalProbeReport(nanFailures);
  assert.ok(report);
  assert.equal(report.checks[0].failures, 0);
});

test('租户 alert_key 命名空间：t.<tenantId>.<checkKey>，与平台裸 key 互不冲突', () => {
  assert.equal(tenantAlertKey('team-a', 'external-dns'), 't.team-a.external-dns');
  assert.notEqual(tenantAlertKey('team-a', 'external-dns'), 'external-dns');
  assert.notEqual(tenantAlertKey('team-a', 'external-dns'), tenantAlertKey('team-b', 'external-dns'));
});

test('崩溃回归：租户 token 查库失败（数据库不可用）返回 null 而非抛异常', async () => {
  // 不配置 RDK_CHAT_CREDITS_DB_URL：findTenantByToken 内部 pool() 抛
  // 'central database is not configured'。此路径此前会把异常穿透到
  // Express async handler 触发进程崩溃（可被匿名 64-hex token 触发）。
  const savedDb = process.env.RDK_CHAT_CREDITS_DB_URL;
  const savedPath = process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH;
  delete process.env.RDK_CHAT_CREDITS_DB_URL;
  process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH = '/nonexistent/d-obs-test-token';
  try {
    const identity = await resolveProbeReportIdentity(
      undefined,
      'a'.repeat(64),
    );
    assert.equal(identity, null);
    // 平台 token 文件缺失 + 租户库不可用：两类凭证都 fail-closed。
    const both = await resolveProbeReportIdentity('b'.repeat(64), 'c'.repeat(64));
    assert.equal(both, null);
  } finally {
    if (savedDb !== undefined) process.env.RDK_CHAT_CREDITS_DB_URL = savedDb;
    if (savedPath !== undefined) process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH = savedPath;
    else delete process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH;
  }
});

test('报告中的 summary/detail 会被截断清洗（不透传超长文本）', () => {
  const raw = baseReport();
  (raw.checks as Array<Record<string, unknown>>)[0].title = 'x'.repeat(500);
  (raw.checks as Array<Record<string, unknown>>)[0].detail = 'y'.repeat(2000);
  const report = parseExternalProbeReport(raw) as ExternalProbeReport;
  assert.ok(report.checks[0].title.length <= 120);
  assert.ok(report.checks[0].detail.length <= 300);
});
