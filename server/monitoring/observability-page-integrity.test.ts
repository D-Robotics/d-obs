/**
 * 整页内联脚本完整性回归。
 *
 * 工作台是一个 HTML 壳 + 二十多个 TS 字符串模块拼成的**单个**内联 <script>：
 * 任意一个模块出现语法错误，整个页面会白屏（所有视图、登录屏一起失效），而
 * 普通单测只 import 模块字符串、不会解析它们。这里按 observability-page.ts 的
 * 真实拼接顺序取出页面里的每个 <script> 块并做一次编译，任何语法错误立即失败。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

/** 仓库根（本测试位于 server/monitoring/ 下）。 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('页面脚本模板字面量里没有会被吃掉的单反斜杠正则转义', async () => {
  // 页面 JS 全部写在 TS 模板字面量里，`\s` / `\.` / `\+` 这类**单反斜杠**会被模板
  // 字面量当转义吃掉（`\s`→`s`、`\.`→`.`），正则悄悄失效且不报错。真实事故：
  // `replace(/^moss\./,'')` 上线后变成 `replace(/^moss./,'')`，把 mossy-thing 误截。
  // 这类问题只有真实求值或本检查能发现，故做成语义无关的源码级断言。
  const modules = [
    'observability-page-script-a.ts',
    'observability-page-script-b.ts',
    'observability-page-script-c.ts',
    'observability-page.ts',
    'observability-page-tenants.ts',
    'observability-page-overview.ts',
    'observability-page-investigation.ts',
    'observability-page-traces.ts',
    'observability-page-script-traces.ts',
    'observability-page-database.ts',
    'observability-page-script-database.ts',
    'observability-page-action-loop.ts',
    'observability-page-copilot.ts',
    'observability-page-script-copilot.ts',
    'observability-page-tenant-scope.ts',
  ];
  const suspicious = /(?<!\\)\\[sdwSDW.+?()[\]{}|]/;
  const hits: string[] = [];
  for (const name of modules) {
    const absolute = path.join(SERVER_ROOT, 'server/monitoring', name);
    let source: string;
    try {
      source = await readFile(absolute, 'utf8');
    } catch {
      continue; // 模块清单里允许有已删除的文件
    }
    source.split('\n').forEach((line, index) => {
      // 合法的 JS 转义（\n \t \r \' \" \` \u \x \\）不在集合内，命中即为 bug。
      if (suspicious.test(line)) hits.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, [], `以下位置的单反斜杠会被模板字面量吃掉：${hits.join(', ')}`);
});
