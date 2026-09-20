/**
 * 公共转义辅助回归：SSR 字符串模板的唯一 escapeHtml 来源。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml } from './observability-html.js';

test('转义全部 HTML 元字符', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
});

test('非字符串输入安全转换', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml({ evil: '<b>' }), '[object Object]');
  assert.equal(escapeHtml(['<i>']), '&lt;i&gt;');
});
