/**
 * 页面脚本语法冒烟：运营工作台最终 HTML 里每个 <script> 块都必须是合法 JS。
 *
 * 页面壳由 20+ 个 TS 模板串常量拼接而成，拼接处的转义错误（比如脚本里出现
 * 未转义的反引号/`${}`）只有语法解析才能抓住——typecheck 管不到字符串内部。
 * 这里用 new Function 做纯语法解析（不执行），覆盖范围 = observability-page.ts
 * 实际拼装的内容，新接线脚本自动纳入，无需登记。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

test('工作台 HTML 内所有 <script> 块都是合法 JS（语法冒烟）', () => {
  const blocks = [...OPS_OBSERVABILITY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  assert.ok(blocks.length >= 2, `预期至少 2 个 script 块，实际 ${blocks.length}`);
  blocks.forEach((body, index) => {
    assert.doesNotThrow(
      () => new Function(body),
      `第 ${index + 1} 个 <script> 块语法错误（长度 ${body.length}）`,
    );
  });
});
