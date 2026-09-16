/**
 * 整页内联脚本完整性回归。
 *
 * 工作台是一个 HTML 壳 + 二十多个 TS 字符串模块拼成的**单个**内联 <script>：
 * 任意一个模块出现语法错误，整个页面会白屏（所有视图、登录屏一起失效），而
 * 普通单测只 import 模块字符串、不会解析它们。这里按 observability-page.ts 的
 * 真实拼接顺序取出页面里的每个 <script> 块并做一次编译，任何语法错误立即失败。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

test('页面内联脚本按真实拼接顺序可编译（防单点语法错误导致整页白屏）', () => {
  const blocks = [...OPS_OBSERVABILITY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  assert.ok(blocks.length >= 2, '页面应包含壳内小脚本与工作台主脚本两块');
  blocks.forEach((body, index) => {
    assert.ok(body.trim().length > 0, `第 ${index + 1} 个脚本块不应为空`);
    assert.doesNotThrow(
      () => new Function(body),
      `第 ${index + 1} 个内联脚本块存在语法错误`,
    );
  });
  // 主脚本是最大的那块（二十多个模块拼成），必须真的被拼进页面。
  const main = blocks.reduce((longest, body) => (body.length > longest.length ? body : longest), '');
  assert.ok(main.length > 100_000, `工作台主脚本应远大于壳内脚本，实际 ${main.length} 字符`);
  // 组装顺序里必须包含工作台的核心脚本模块（防止拼接清单被误改）。
  const combined = blocks.join('\n');
  for (const marker of ['opsMemberMode', 'applyAuthMode', 'handleForbidden', 'renderObsAccountBar']) {
    assert.ok(combined.includes(marker), `页面脚本应包含 ${marker}`);
  }
});

test('页面不引用已下线功能的 DOM id / 端点', () => {
  // 这些功能在 standalone d-obs 没有对应服务端路由，UI 已下线；残留引用会让
  // 用户再次看到必然失败的按钮。
  for (const dead of [
    'ai-query',
    'synthetic-probe',
    'databaseAiQuestion',
    'databaseAiResult',
    'runSyntheticTraceProbe',
  ]) {
    assert.equal(OPS_OBSERVABILITY_HTML.includes(dead), false, `页面不应再引用 ${dead}`);
  }
});
