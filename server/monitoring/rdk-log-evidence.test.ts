import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeRdkLogEvidence, buildRdkLogEvidence, callRdkLogGateway, evidenceOnlyRdkAnalysis, redactRdkModelText, rdkLogModelEnabled, resolveRdkLogModelTarget, type RdkEvidenceInput } from './rdk-log-evidence.js';

function fixture(texts: string[]): RdkEvidenceInput {
  return { capture: { id: 'capture-a', profileId: 'x5-isp', question: 'ISP启动超时', deviceSnapshot: { model: 'RDK X5', os: 'Ubuntu', note: 'api_key="private"' } },
    streams: [{ session: { id: 'session-a', targetId: 'x5', targetLabel: 'X5', sourceId: 'logcat', sourceLabel: '媒体日志', state: 'stopped', startedAt: '2026-10-10T01:00:00Z', recordCount: texts.length, byteCount: texts.join('').length },
      records: texts.map((text, index) => ({ seq: index + 1, receivedAt: '2026-10-10T01:00:00Z', stream: 'stdout', text })) }] };
}

test('server evidence reassembles split lines and cites original chunk spans without changing raw output', () => {
  const input = fixture(['[sensor_lib] init done\nE/TRACE ISP ti', 'meout token=PRIVATE_TOKEN\n']);
  const evidence = buildRdkLogEvidence(input);
  assert.equal(evidence.summary.lines, 2);
  assert.equal(evidence.summary.errors, 1);
  const error = evidence.items.find((item) => item.severity === 'error')!;
  assert.equal(error.ref, 'rlog:session-a:1-2');
  assert.equal(error.module, 'ISP');
  assert.match(error.text, /timeout/);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_TOKEN|private/);
  assert.match(input.streams[0]!.records[1]!.text, /PRIVATE_TOKEN/);
  assert.ok(evidence.warnings.some((item) => item.includes('不保证严格同步')));
});

test('evidence is bounded, preserves abnormal context over ordinary lines and exposes clipping', () => {
  const evidence = buildRdkLogEvidence(fixture(Array.from({ length: 180 }, (_, i) => i === 179 ? 'E/ ISP timeout\n' : `[camera] frame ${i} ok\n`)));
  assert.ok(evidence.items.length <= 120);
  assert.ok(evidence.items.some((item) => item.text.includes('timeout')));
  assert.equal(evidence.summary.lines, 180);
  assert.ok(evidence.warnings.some((item) => item.includes('摘录')));
  const giant = buildRdkLogEvidence(fixture(['x'.repeat(80_000)]));
  assert.ok(giant.items[0]!.text.length <= 1200);
  assert.ok(giant.warnings.some((item) => item.includes('单行长度')));
});

test('redaction happens before clipping and handles bearer, assignment, URL passwords and PEM blocks', () => {
  const value = redactRdkModelText('Bearer secret auth token=abcdef password="secret with spaces" postgresql://user:PASS@db/x\n-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----');
  assert.doesNotMatch(value, /abcdef|secret with spaces|PASS@|\nSECRET\n|Bearer secret/);
  assert.match(value, /REDACTED/);
});

test('model evidence masks multiline PEM across chunks, JSON credential keys, Basic auth and complete cookies', () => {
  const input = fixture(['-----BEGIN RSA PRIVATE KEY-----\nPEM_BODY_SECRET_A\n', 'PEM_BODY_SECRET_B\n-----END RSA PRIVATE KEY-----\n',
    '{"api_key":"JSON_KEY_SECRET","password":"JSON_PASSWORD_SECRET"}\nAuthorization: Basic QkFTSUNfU0VDUkVU\nCookie: a=COOKIE_SECRET_A; b=COOKIE_SECRET_B\nE/ ISP timeout\n']);
  const evidence = buildRdkLogEvidence(input);
  assert.doesNotMatch(JSON.stringify(evidence), /PEM_BODY_SECRET|JSON_KEY_SECRET|JSON_PASSWORD_SECRET|QkFTSUNfU0VDUkVU|COOKIE_SECRET/);
  assert.match(JSON.stringify(input), /PEM_BODY_SECRET/);
  assert.equal(evidence.summary.errors, 1);
});

test('one huge multiline chunk respects the evidence line scan budget', () => {
  const evidence = buildRdkLogEvidence(fixture(['x\n'.repeat(100_100)]));
  assert.equal(evidence.summary.lines, 100_000);
  assert.ok(evidence.warnings.some((item) => item.includes('扫描')));
});

test('PEM markers after giant prefixes and split across chunks are detected before display clipping', () => {
  const evidence = buildRdkLogEvidence(fixture(['x'.repeat(33_000) + '-----BEGIN RSA PRIV',
    'ATE KEY-----\nPRIVATE_BODY_AFTER_CLIP\n-----END RSA PRIVATE KEY-----\nE/ ISP timeout\n']));
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_BODY_AFTER_CLIP/);
  assert.equal(evidence.summary.errors, 1);
  assert.equal(redactRdkModelText('x'.repeat(32_000)).length, 32_000);
});

test('model only receives server built redacted evidence and returns only owned real references', async () => {
  const evidence = buildRdkLogEvidence(fixture(['E/ ISP failed api_key=VERY_SECRET\n']));
  const actual = evidence.items[0]!.ref;
  const analysis = await analyzeRdkLogEvidence(evidence, '检查ISP', async (messages) => {
    assert.doesNotMatch(JSON.stringify(messages), /VERY_SECRET/);
    assert.match(messages[0]!.content, /非可信数据/);
    assert.match(messages[1]!.content, /rlog:session-a/);
    return { model: 'fixture-model', text: JSON.stringify({ headline: 'ISP需要调查', summary: '证据不足以确定根因', hypotheses: [{ title: '可能初始化失败', evidenceRefs: [actual, 'rlog:other:9-9'], nextCheck: '补采启动前日志' }, { title: '伪造证据', evidenceRefs: ['fake'] }], missingEvidence: ['启动前日志'] }) };
  });
  assert.equal(analysis.source, 'model');
  assert.equal(analysis.evidenceDigest, evidence.digest);
  assert.equal(analysis.hypotheses.length, 1);
  assert.deepEqual(analysis.hypotheses[0]!.evidenceRefs, [actual]);
});

test('invalid citations, model outage and empty evidence are explicit errors rather than AI success', async () => {
  const evidence = buildRdkLogEvidence(fixture(['E/ ISP timeout\n']));
  await assert.rejects(analyzeRdkLogEvidence(evidence, '', async () => ({ model: 'fixture', text: '{"hypotheses":[{"title":"fake","evidenceRefs":["fake"]}]}' })), /rdk_log_model_invalid_output/);
  await assert.rejects(analyzeRdkLogEvidence(evidence, '', async () => { throw new Error('SECRET_PROVIDER_CREDENTIAL'); }), /rdk_log_model_unavailable/);
  await assert.rejects(analyzeRdkLogEvidence(buildRdkLogEvidence(fixture([])), '', async () => { throw new Error('should not call'); }), /rdk_log_no_evidence/);
  const rule = evidenceOnlyRdkAnalysis(evidence);
  assert.equal(rule.source, 'evidence');
  assert.match(rule.summary, /不能直接确定根因/);
});

test('model uses a dedicated gateway inference credential, never a masked admin-config provider key', () => {
  const names = ['RDK_LOG_AI_ENABLED', 'RDK_COPILOT_MODEL_ENABLED', 'RDK_LOG_AI_GATEWAY_KEY', 'RDK_LOG_AI_MODEL', 'RDK_LOG_AI_GATEWAY_URL', 'RDK_GATEWAY_ADMIN_URL'];
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    process.env.RDK_LOG_AI_ENABLED = '1';
    assert.equal(rdkLogModelEnabled(), false);
    process.env.RDK_LOG_AI_GATEWAY_KEY = 'fixture-dedicated-key';
    process.env.RDK_LOG_AI_MODEL = 'fixture-alias';
    process.env.RDK_GATEWAY_ADMIN_URL = 'http://127.0.0.1:3100';
    assert.equal(rdkLogModelEnabled(), true);
    assert.deepEqual(resolveRdkLogModelTarget(), { baseUrl: 'http://127.0.0.1:3100/v1', model: 'fixture-alias', apiKey: 'fixture-dedicated-key' });
    for (const url of ['http://remote.example/v1', 'file:///tmp/model', 'https://user:secret@example.com/v1', 'https://example.com/v1?token=secret']) {
      process.env.RDK_LOG_AI_GATEWAY_URL = url;
      assert.equal(rdkLogModelEnabled(), false);
    }
    process.env.RDK_LOG_AI_GATEWAY_URL = 'https://gateway.example/v1/';
    assert.equal(resolveRdkLogModelTarget()?.baseUrl, 'https://gateway.example/v1');
    process.env.RDK_LOG_AI_ENABLED = '0';
    assert.equal(rdkLogModelEnabled(), false);
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test('gateway inference rejects redirects and oversized bodies before parsing, with only the dedicated credential', async () => {
  const target = { baseUrl: 'https://fixture.example/v1', model: 'fixture-alias', apiKey: 'fixture-service-key' };
  const answer = await callRdkLogGateway(target, [{ role: 'user', content: 'synthetic' }], async (url, init) => {
    assert.equal(url, 'https://fixture.example/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-service-key');
    assert.equal(JSON.parse(String(init?.body)).model, 'fixture-alias');
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 3000);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  assert.equal(answer, '{"ok":true}');
  await assert.rejects(callRdkLogGateway(target, [], async () => new Response('sensitive upstream body', { status: 401 })), /rdk_log_gateway_http_error/);
  await assert.rejects(callRdkLogGateway(target, [], async () => new Response('body', { headers: { 'content-length': String(1024 * 1024 + 1) } })), /rdk_log_gateway_body_limit/);
  let cancelled = false;
  await assert.rejects(callRdkLogGateway(target, [], async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled = true; } }))), /rdk_log_gateway_body_limit/);
  assert.equal(cancelled, true);
});
