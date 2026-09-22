/** 尾部采样纯函数回归：error/慢 trace 保留、比例采样、env 解析与默认全保留。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldKeepTrace, tailSampleConfigFromEnv } from './tail-sampling.js';

test('默认配置 ratio=1：全保留（未启用采样时行为与历史一致）', () => {
  const config = tailSampleConfigFromEnv({});
  assert.deepEqual(config, { ratio: 1, slowMs: 2000 });
  assert.equal(shouldKeepTrace({ spanCount: 3, hasError: false, durationMs: 1 }, config, () => 0.999), true);
});

test('启用采样：error 与慢 trace 永远保留，普通 trace 按 random 阈值', () => {
  const config = { ratio: 0.1, slowMs: 2000 };
  assert.equal(shouldKeepTrace({ spanCount: 1, hasError: true, durationMs: 0 }, config, () => 0.999), true);
  assert.equal(shouldKeepTrace({ spanCount: 1, hasError: false, durationMs: 2500 }, config, () => 0.999), true);
  assert.equal(shouldKeepTrace({ spanCount: 1, hasError: false, durationMs: 100 }, config, () => 0.05), true);
  assert.equal(shouldKeepTrace({ spanCount: 1, hasError: false, durationMs: 100 }, config, () => 0.2), false);
});

test('slowMs=0 关闭慢 trace 保留；env 非法值回落默认', () => {
  const config = { ratio: 0.5, slowMs: 0 };
  assert.equal(shouldKeepTrace({ spanCount: 1, hasError: false, durationMs: 999_999 }, config, () => 0.9), false);
  assert.deepEqual(tailSampleConfigFromEnv({ RDK_OTLP_TAIL_SAMPLE_RATIO: 'oops', RDK_OTLP_TAIL_SAMPLE_SLOW_MS: '-5' }), {
    ratio: 1,
    slowMs: 2000,
  });
  assert.equal(tailSampleConfigFromEnv({ RDK_OTLP_TAIL_SAMPLE_RATIO: '1.5' }).ratio, 1);
  assert.equal(tailSampleConfigFromEnv({ RDK_OTLP_TAIL_SAMPLE_RATIO: '0' }).ratio, 0);
});
