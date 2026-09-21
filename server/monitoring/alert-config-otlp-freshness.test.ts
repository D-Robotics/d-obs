import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALERT_RULE_DEFINITIONS,
  DEFAULT_ALERT_CONFIG,
  LOWER_IS_WORSE_ALERT_RULE_KEYS,
  normalizeStoredAlertConfig,
} from './alert-config.js';

test('otlp-trace-freshness：定义存在、默认阈值方向正确（越高越糟）', () => {
  const definition = ALERT_RULE_DEFINITIONS.find((rule) => rule.key === 'otlp-trace-freshness');
  assert.ok(definition, 'definition missing');
  assert.equal(definition.category, 'metric');
  assert.deepEqual([...definition.fields].sort(), ['criticalThreshold', 'threshold']);
  assert.ok(!LOWER_IS_WORSE_ALERT_RULE_KEYS.has('otlp-trace-freshness'));
  const defaults = DEFAULT_ALERT_CONFIG.rules['otlp-trace-freshness'];
  assert.equal(defaults.threshold, 2_880);
  assert.equal(defaults.criticalThreshold, 8_640);
  assert.ok(defaults.criticalThreshold > defaults.threshold);
});

test('存量配置缺新键时 normalize 自动补默认值（生产灰度路径）', () => {
  const stored = {
    version: 1,
    updatedAt: new Date().toISOString(),
    global: { enabled: true },
    rules: {
      'llm-token-budget': { threshold: 99, criticalThreshold: 100 },
    },
  };
  const config = normalizeStoredAlertConfig(stored);
  assert.equal(config.rules['llm-token-budget'].threshold, 99);
  assert.equal(config.rules['otlp-trace-freshness'].threshold, 2_880);
  assert.equal(config.rules['otlp-trace-freshness'].criticalThreshold, 8_640);
});
