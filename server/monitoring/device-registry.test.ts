import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDeviceHeartbeat } from './device-registry.js';

test('device heartbeat keeps agent version and sanitizes weak-network samples', () => {
  const now = Date.now();
  const parsed = parseDeviceHeartbeat({
    model: 'X5\u0000',
    firmware: 'fw-2.1.0',
    agentVersion: '1.1.0',
    samples: [
      { ts: now - 1000, metrics: { cpu: 42.1234567, temperature: '63.5', 'bad key': 1, secret: 'drop' } },
      { ts: now - 1000, metrics: { cpu: 99 } },
      { ts: now + 10 * 60_000, metrics: { cpu: 1 } },
      { ts: now - 8 * 24 * 60 * 60_000, metrics: { cpu: 1 } },
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.model, 'X5');
  assert.equal(parsed.agentVersion, '1.1.0');
  assert.equal(parsed.samples.length, 1);
  assert.deepEqual(parsed.samples[0]?.metrics, { cpu: 42.123457, temperature: 63.5 });
});

test('empty or malformed heartbeat samples produce a safe empty sample list', () => {
  assert.deepEqual(parseDeviceHeartbeat({ model: 42, samples: [{ ts: 'nope', metrics: { cpu: 1 } }] }), {
    model: '',
    firmware: '',
    agentVersion: '',
    samples: [],
  });
  assert.equal(parseDeviceHeartbeat(null), null);
});
