import assert from 'node:assert/strict';
import test from 'node:test';
import { redactTelemetryPayload } from '../../shared/telemetry-data-governance.js';
import { createStudioTraceContentEntry, normalizeStudioTraceContent } from '../../shared/studio-trace-content.js';
import { STUDIO_TRACE_CONTENT_SCHEMA } from '../../shared/studio-trace-content.js';

test('native ordinary query survives producer and reader normalization; public metadata stays masked', () => {
  const payload = { query: 'RDK X5', limit: 5 };
  for (const input of [payload, JSON.stringify(payload)]) {
    const body = createStudioTraceContentEntry('tool_input', input);
    assert.ok(body);
    assert.deepEqual(JSON.parse(body.entries[0].text), payload);
    assert.equal(body.redacted, false);
    assert.deepEqual(normalizeStudioTraceContent(body), body);
  }
  const publicPayload = redactTelemetryPayload(payload);
  assert.ok(publicPayload.ok);
  assert.deepEqual(publicPayload.value, { query: '[REDACTED]', limit: 5 });
});

test('query text retains ordinary intent while embedded token and email stay redacted', () => {
  const body = createStudioTraceContentEntry('tool_input', {
    query: 'RDK X5 token=synthetic-query-secret reader@example.test',
  });
  assert.ok(body);
  assert.match(JSON.parse(body.entries[0].text).query, /RDK X5/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-query-secret|reader@example/);
  assert.equal(body.redacted, true);
  assert.deepEqual(normalizeStudioTraceContent(body), body);
});

test('existing redacted query JSON remains byte-stable for receipt and retry replay', () => {
  const body = { schema: STUDIO_TRACE_CONTENT_SCHEMA,
    entries: [{ kind: 'tool_input', text: '{"query":"[REDACTED]","radius":3,"rdkstudiobodyfieldq":"existing field"}' }],
    redacted: true, truncated: false };
  assert.deepEqual(normalizeStudioTraceContent(body), body);
});

test('nested query credentials and all non-query sensitive fields keep their original policy', () => {
  const body = createStudioTraceContentEntry('tool_input', {
    query: { text: 'RDK X5', token: 'synthetic-token', email: 'nested@example.test',
      nested: [{ query: 'camera', api_key: 'synthetic-api-key' }] },
    username: 'synthetic-user', path: 'synthetic-path', Query: 'synthetic-uppercase-query',
    querystring: 'synthetic-querystring', search_params: { text: 'synthetic-search-params' },
  });
  assert.ok(body);
  assert.deepEqual(JSON.parse(body.entries[0].text), {
    query: { text: 'RDK X5', token: '[REDACTED]', email: '[REDACTED]',
      nested: [{ query: 'camera', api_key: '[REDACTED]' }] },
    username: '[REDACTED]', path: '[REDACTED]', Query: '[REDACTED]',
    querystring: '[REDACTED]', search_params: '[REDACTED]',
  });
  assert.doesNotMatch(JSON.stringify(body), /synthetic-|nested@example/);
  assert.deepEqual(normalizeStudioTraceContent(body), body);
});

test('frozen native objects and original alias-like keys round trip without collision or mutation', () => {
  const payload = Object.freeze({ query: 'RDK X5', rdkstudiobodyfieldq: 'original alias',
    rdkstudiobodyfieldrdkstudiobodyfieldq: 'second alias',
    nested: Object.freeze({ query: 'camera', rdkstudiobodyfieldq: 'nested alias' }) });
  const body = createStudioTraceContentEntry('tool_input', payload);
  assert.ok(body);
  assert.deepEqual(JSON.parse(body.entries[0].text), payload);
  assert.equal(body.redacted, false);
  assert.deepEqual(normalizeStudioTraceContent(body), body);
  assert.equal(payload.query, 'RDK X5');
});

test('query traversal keeps array/depth budgets and rejects cyclic or revoked values', () => {
  const body = createStudioTraceContentEntry('tool_input', {
    query: Object.freeze(Array.from({ length: 70 }, () => Object.freeze({ query: 'RDK X5' }))),
  });
  assert.ok(body);
  assert.deepEqual(JSON.parse(body.entries[0].text).query, Array(64).fill({ query: 'RDK X5' }));
  assert.equal(body.truncated, true);
  let deep: unknown = { api_key: 'synthetic-depth-secret' };
  for (let index = 0; index < 10; index++) deep = { query: deep };
  const bounded = createStudioTraceContentEntry('tool_input', deep);
  assert.ok(bounded);
  assert.equal(bounded.truncated, true);
  assert.doesNotMatch(JSON.stringify(bounded), /synthetic-depth-secret/);
  const cyclic: Record<string, unknown> = {};
  cyclic.query = [cyclic];
  assert.equal(createStudioTraceContentEntry('tool_input', cyclic), undefined);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(createStudioTraceContentEntry('tool_input', revoked.proxy), undefined);
});
