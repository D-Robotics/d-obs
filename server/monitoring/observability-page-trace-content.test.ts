import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_TRACE_DETAIL } from './observability-page-script-trace-detail.js';
import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';
import { OPS_OBSERVABILITY_TRACE_CONTENT_STYLE } from './observability-page-trace-content-style.js';
import { OPS_OBSERVABILITY_TRACES_STYLE } from './observability-page-traces-style.js';

const schema = 'rdk.studio.trace-content.v1';
function content(entries: Array<{ kind: string; text: string }>, flags = {}) {
  return { availability: 'available', schema, entries, redacted: false, truncated: false, ...flags };
}
function span(ref: string, startedAt: string, durationMs: number, body?: unknown) {
  return { spanRef: ref, name: ref, parentSpanRef: null, startedAt, startOffsetMs: 0,
    durationMs, status: 'ok', outcome: 'completed', sourceSegment: 'moss',
    service: { name: 'moss' }, attributes: {}, content: body };
}

function harness(options: { clipboard?: { writeText(text: string): Promise<void> }; fullPage?: boolean } = {}) {
  const innerHTMLWrites: unknown[] = [];
  const document: any = { activeElement: null, scrollingElement: { scrollTop: 0, scrollLeft: 0 }, addEventListener() {} };
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const element = (tag = 'div', className = '', text = ''): any => {
    const events = new Map<string, Array<(event: any) => unknown>>();
    let opened = false;
    const node: any = { tagName: tag, className, textContent: text, style: {}, attributes: {}, dataset: {}, children: [],
      hidden: false, disabled: false, parentElement: null, scrollTop: 0, scrollLeft: 0, isConnected: true,
      appendChild(child: any) { child.parentElement = node; node.children.push(child); return child; },
      replaceChildren(...children: any[]) { node.children.forEach((child: any) => { child.parentElement = null; }); node.children = []; children.forEach((child) => node.appendChild(child)); },
      setAttribute(key: string, value: unknown) {
        node.attributes[key] = String(value);
        if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase())] = String(value);
      },
      getAttribute(key: string) { return node.attributes[key] ?? null; },
      addEventListener(name: string, callback: (event: any) => unknown) { events.set(name, [...events.get(name) || [], callback]); },
      async fire(name: string) { for (const callback of events.get(name) || []) await callback({ target: node }); },
      focus() { document.activeElement = node; },
      remove() { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child: any) => child !== node); },
      querySelectorAll(selector: string) {
        return walk(node).slice(1).filter((item) => {
          const match = selector.match(/^([a-z]+)?\[([^\]]+)\]$/);
          if (match) return (!match[1] || item.tagName === match[1]) && item.attributes[match[2]] != null;
          if (selector.startsWith('.')) return item.className.split(' ').includes(selector.slice(1));
          return item.tagName === selector;
        });
      },
      classList: { add(name: string) { node.className += ' ' + name; } },
    };
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    Object.defineProperty(node, 'open', { get: () => opened, set(value) {
      const changed = opened !== Boolean(value); opened = Boolean(value);
      if (changed) for (const callback of events.get('toggle') || []) callback({ target: node });
    } });
    Object.defineProperty(node, 'innerHTML', { set(value) { innerHTMLWrites.push(value); } });
    return node;
  };
  const root = element();
  const state: any = { traceDetailData: null, traceDetailLocator: 'fixture-locator', traceDetailStatus: 'ready' };
  const context = vm.createContext({
    state, document, navigator: options.clipboard ? { clipboard: options.clipboard } : {}, make: element,
    add: (parent: any, tag: string, className: string, text: string) => parent.appendChild(element(tag, className, text)),
    traceList: (value: unknown) => Array.isArray(value) ? value : [],
    traceText: (value: unknown, fallback: string, max = 160) => value == null ? fallback : String(value).slice(0, max),
    traceDuration: (value: unknown) => String(value || 0) + 'ms',
    traceSegmentName: (value: unknown) => String(value), traceReasonName: (value: unknown) => String(value),
    fmt: (value: unknown) => String(Number(value) || 0), when: (value: unknown) => String(value || ''),
    outcomeName: (value: unknown) => String(value || ''), traceClientLabel: (value: unknown) => String(value || ''),
    nativeTraceIdentity: 'fixture-account', obsActiveTenant: () => 'fixture-tenant',
    applyAuthMode() {}, obsLogout() {},
    $: () => null, setTimeout: (callback: () => void) => callback(), clearTimeout() {},
  });
  vm.runInContext((options.fullPage ? OPS_OBSERVABILITY_SCRIPT_TRACES : OPS_OBSERVABILITY_SCRIPT_TRACE_DETAIL) +
    '\n globalThis.hooks={context:renderTraceBoundConversation,conversation:renderTraceConversation,span:renderTraceSpanContent,item:renderTraceContentItem,waterfall:renderTraceWaterfalls,items:traceConversationItems' +
    (options.fullPage ? ',detail:renderNativeTraceDetail' : '') + '};', context);
  const visible = (node: any): boolean => {
    if (node.hidden) return false;
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.tagName === 'details' && !parent.open && parent.children[0] !== node) return false;
    return visible(parent);
  };
  const text = (node = root) => walk(node).map((item) => item.textContent).join('\n');
  const formattedText = (card: any) => {
    const formatted = walk(card).find((node) => node.className === 'trace-content-formatted');
    const paragraphs = walk(formatted).filter((node) => node.className === 'trace-content-paragraph');
    return paragraphs.length ? paragraphs.map((node) => node.textContent).join('\n\n') : walk(formatted).find((node) => node.tagName === 'pre').textContent;
  };
  return { root, state, hooks: (context as any).hooks, walk, element, visible, document, innerHTMLWrites,
    all: () => walk(root), text, formattedText,
    visibleText: (node = root) => walk(node).filter(visible).map((item) => item.textContent).join('\n') };
}

test('正文按输入起点与输出结束排序，角色和来源按需展示', () => {
  const h = harness();
  const detail = { traces: [{ traceRef: 'trace-one', startedAt: '2026-10-10T01:00:00Z', spans: [
    span('moss.session', '2026-10-10T01:00:00Z', 9000, content([
      { kind: 'user_input', text: '请帮我检查摄像头。' }, { kind: 'model_output', text: '摄像头工作正常。' },
    ])),
    span('moss.tool.invoke', '2026-10-10T01:00:03Z', 1000, content([
      { kind: 'tool_input', text: '{"device":"camera"}' }, { kind: 'tool_output', text: '{"ready":true}' },
    ])),
    span('moss.llm.request', '2026-10-10T01:00:05Z', 1000, content([{ kind: 'model_output', text: '工具已确认摄像头可用。' }])),
  ] }] };
  h.hooks.conversation(h.root, detail);
  const cards = h.all().filter((node) => node.className.startsWith('trace-content-entry '));
  assert.deepEqual(cards.map(h.formattedText), [
    '请帮我检查摄像头。', '{\n  "device": "camera"\n}', '{\n  "ready": true\n}', '工具已确认摄像头可用。', '摄像头工作正常。',
  ]);
  assert.deepEqual(cards.map((node) => node.attributes['data-trace-content-kind']), ['user_input', 'tool_input', 'tool_output', 'model_output', 'model_output']);
  assert.equal(cards[0].open, true);
  assert.equal(cards[1].open, false);
  assert.ok(h.text(cards[1]).includes('工具调用 · 参数'));
  assert.ok(h.text(cards[3]).includes('模型回复'));
  assert.ok(!h.visibleText().includes('moss.llm.request'));
  const source = h.walk(cards[3]).find((node) => node.className === 'trace-content-source-details');
  source.parentElement.open = true;
  source.open = true;
  assert.ok(h.visibleText().includes('moss.llm.request'));
});

test('普通中文按段落保留换行，恶意 HTML 和 Markdown 只作为文本', () => {
  const h = harness();
  const text = '第一段\n保留这一行\n\n第二段 <img src=x onerror="globalThis.compromised=true"> [点击](javascript:alert(2))';
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text }, entryKey: 'fixture:prose' });
  assert.deepEqual(h.walk(card).filter((node) => node.className === 'trace-content-paragraph').map((node) => node.textContent), [
    '第一段\n保留这一行', '第二段 <img src=x onerror="globalThis.compromised=true"> [点击](javascript:alert(2))',
  ]);
  assert.equal(h.walk(card).filter((node) => node.tagName === 'pre').length, 0);
  const body = h.walk(card).find((node) => node.className === 'trace-content-entry-body');
  assert.equal(body.children[0].className, 'trace-content-formatted');
  assert.equal(body.children.at(-1).className, 'trace-content-footer');
  assert.deepEqual(h.innerHTMLWrites, []);
  assert.equal(h.all().filter((node) => ['script', 'img', 'a'].includes(node.tagName)).length, 0);
});

test('合法 JSON 默认缩进，可切换原文，再返回格式化视图', () => {
  const h = harness();
  const original = '{"query":"synthetic","nested":{"ready":true},"html":"<script>x</script>"}';
  const card = h.hooks.item(h.root, { entry: { kind: 'tool_input', text: original }, entryKey: 'fixture:json', options: { toolOpen: true } });
  const raw = h.walk(card).find((node) => node.className === 'trace-content-raw');
  const formatted = h.walk(card).find((node) => node.className === 'trace-content-formatted');
  assert.equal(h.formattedText(card), JSON.stringify(JSON.parse(original), null, 2));
  assert.equal(formatted.hidden, false);
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(formatted.hidden, true);
  assert.equal(card.attributes['data-trace-body-mode'], 'raw');
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
  raw.open = false;
  assert.equal(formatted.hidden, false);
  assert.equal(card.attributes['data-trace-body-mode'], 'formatted');
  assert.deepEqual(h.innerHTMLWrites, []);
});

test('无效或截断 JSON 保留原始文本，关闭 JSON 格式选项仍可阅读', () => {
  const h = harness();
  const text = '{"query":"unfinished';
  const broken = h.hooks.item(h.root, { entry: { kind: 'tool_output', text }, entryKey: 'fixture:broken' });
  assert.equal(h.formattedText(broken), text);
  assert.equal(h.walk(broken).filter((node) => node.className === 'trace-content-raw').length, 0);
  const plain = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: '{"ready":true}' }, entryKey: 'fixture:plain-json', options: { formatJson: false } });
  assert.equal(h.formattedText(plain), '{"ready":true}');
});

test('JSON 缩进保留大整数、重复键、原键顺序和数字 token', () => {
  const h = harness();
  const original = '{"id":9007199254740993,"ordered":1e+09,"id":7,"z":-0}';
  const card = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: original }, entryKey: 'fixture:tokens' });
  assert.equal(h.formattedText(card), '{\n  "id": 9007199254740993,\n  "ordered": 1e+09,\n  "id": 7,\n  "z": -0\n}');
  const raw = h.walk(card).find((node) => node.className === 'trace-content-raw');
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
});

test('JSON 字符串内的括号和转义保持字面值，空对象与数组安全缩进', () => {
  const h = harness();
  const original = String.raw`{"text":"say \"brace}\" [end]","slash":"\\","nested":[{},[],{"v":true}]}`;
  const card = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: original }, entryKey: 'fixture:escapes' });
  const formatted = h.formattedText(card);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(original));
  assert.ok(formatted.includes(String.raw`"text": "say \"brace}\" [end]"`));
  assert.ok(formatted.includes(String.raw`"slash": "\\"`));
  assert.ok(formatted.includes('{}'));
  assert.ok(formatted.includes('[]'));
});

test('JSON 深度和格式化长度超限时诚实退回原文，scalar 与 null 按普通正文展示', () => {
  const h = harness();
  const deepText = '['.repeat(35) + '0' + ']'.repeat(35);
  const deep = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: deepText }, entryKey: 'fixture:deep' });
  assert.equal(h.formattedText(deep), deepText);
  assert.ok(h.text(deep).includes('按原文展示'));
  assert.ok(!h.text(deep).includes('已截断'));
  assert.equal(h.walk(deep).filter((node) => node.className === 'trace-content-raw').length, 0);
  const lengthText = JSON.stringify({ items: Array.from({ length: 50 }, (_, n) => ({ n })) });
  const bounded = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: lengthText }, entryKey: 'fixture:format-limit', options: { maxFormattedCharacters: 256 } });
  assert.equal(h.formattedText(bounded), lengthText);
  assert.ok(h.text(bounded).includes('按原文展示'));
  for (const text of ['9007199254740993', 'null', '"quoted"']) {
    const scalar = h.hooks.item(h.root, { entry: { kind: 'model_output', text }, entryKey: 'fixture:scalar:' + text });
    assert.equal(h.formattedText(scalar), text);
    assert.equal(h.walk(scalar).filter((node) => node.tagName === 'pre').length, 0);
  }
});

test('模型工具调用只依据明确 tool_use 内容，最终模型回复保留原角色事实', () => {
  const h = harness();
  const bodies = [
    JSON.stringify({ content: [{ type: 'tool_use', name: 'fixture-tool', input: {} }] }),
    '已完成检查。',
    JSON.stringify({ content: [], stopReason: 'tool_use' }),
    JSON.stringify({ content: [{ type: 'text', text: '最终回答' }], stopReason: 'end_turn' }),
    '普通文字中提到 tool_use，仍是回复。',
  ];
  h.hooks.span(h.root, span('moss.llm.request', '', 0, content(bodies.map((text) => ({ kind: 'model_output', text })))));
  const cards = h.all().filter((node) => node.className.startsWith('trace-content-entry '));
  assert.deepEqual(cards.map((card) => h.walk(card).find((node) => node.className === 'trace-content-role').textContent), ['模型调用工具', '模型回复', '模型调用工具', '模型回复', '模型回复']);
  assert.ok(cards.every((card) => card.attributes['data-trace-content-kind'] === 'model_output'));
  assert.deepEqual(cards.map((card) => card.open), [false, true, false, true, true]);
  const forced = h.hooks.item(h.root, { entry: { kind: 'model_output', text: bodies[0] }, entryKey: 'fixture:forced-tool-model', options: { initialOpen: true } });
  assert.equal(forced.open, true, '显式初始展开优先于工具调用默认折叠');
});

test('长文只做显示预览，原生展开可查看和收起全部返回内容', () => {
  const h = harness();
  const text = '中😀'.repeat(1500);
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text }, entryKey: 'fixture:long', options: { previewCharacters: 100 } });
  const preview = h.walk(card).find((node) => node.className === 'trace-content-preview');
  const full = h.walk(card).find((node) => node.className === 'trace-content-full-body');
  assert.equal(h.walk(preview).find((node) => node.className === 'trace-content-paragraph').textContent, Array.from(text).slice(0, 100).join(''));
  assert.equal(h.walk(full).find((node) => node.className === 'trace-content-paragraph').textContent, text);
  assert.equal(full.attributes['data-trace-disclosure-key'], 'fixture:long:body');
  assert.equal(preview.hidden, false);
  full.open = true;
  assert.equal(preview.hidden, true);
  full.open = false;
  assert.equal(preview.hidden, false);
  assert.ok(!h.text(card).includes('已截断'));
});

test('复制原文有进行中状态，完成后恢复按钮且复制的是未格式化的完整 DTO', async () => {
  const h = harness();
  const original = '{"query":"synthetic","limit":3}';
  const writes: string[] = [];
  let finish!: () => void;
  const copyText = (text: string) => { writes.push(text); return new Promise<void>((resolve) => { finish = resolve; }); };
  const card = h.hooks.item(h.root, { entry: { kind: 'tool_input', text: original }, entryKey: 'fixture:copy', options: { copyText } });
  const button = h.walk(card).find((node) => node.tagName === 'button');
  const status = h.walk(card).find((node) => node.className === 'trace-content-copy-status');
  const pending = button.fire('click');
  assert.equal(button.disabled, false);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.equal(status.textContent, '正在复制…');
  assert.deepEqual(writes, [original]);
  assert.equal(status.attributes.role, 'status');
  assert.equal(button.attributes['aria-describedby'], status.id);
  finish(); await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.equal(status.textContent, '原文已复制。');
});

test('复制 pending 防重入且保持键盘焦点，完成后不抢走用户转移的焦点', async () => {
  const h = harness();
  let finish!: () => void;
  let writes = 0;
  const card = h.hooks.item(h.root, { entry: { kind: 'user_input', text: '合成正文' }, entryKey: 'fixture:copy-focus', options: {
    copyText: () => { writes += 1; return new Promise<void>((resolve) => { finish = resolve; }); },
  } });
  const button = h.walk(card).find((node) => node.tagName === 'button');
  button.focus();
  const first = button.fire('click');
  await button.fire('click');
  assert.equal(writes, 1, 'pending 期间重复鼠标或键盘触发不再次写剪贴板');
  assert.equal(button.disabled, false);
  assert.equal(h.document.activeElement, button);
  finish(); await first;
  assert.equal(h.document.activeElement, button, '复制成功保留同一按钮的键盘焦点');
  const next = button.fire('click');
  assert.equal(writes, 2, '完成后仍允许再次复制');
  const other = h.element('button');
  other.focus();
  finish(); await next;
  assert.equal(h.document.activeElement, other, '用户转移焦点后完成复制不得抢回焦点');
});

test('原生剪贴板适配保持绑定，拒绝复制和无剪贴板显示真实失败状态', async () => {
  const writes: string[] = [];
  const clipboard = { writeText: async (text: string) => { writes.push(text); } };
  const h = harness({ clipboard });
  const card = h.hooks.item(h.root, { entry: { kind: 'user_input', text: '完整原文' }, entryKey: 'fixture:native-copy' });
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(writes, ['完整原文']);
  const failed = h.hooks.item(h.root, { entry: { kind: 'model_output', text: '正文' }, entryKey: 'fixture:failed-copy', options: { copyText: async () => { throw new Error('synthetic rejection'); } } });
  const button = h.walk(failed).find((node) => node.tagName === 'button');
  await button.fire('click');
  assert.equal(button.disabled, false);
  assert.ok(h.text(failed).includes('复制失败'));
  assert.ok(!h.text(failed).includes('原文已复制'));
  const unavailable = harness();
  const noClipboard = unavailable.hooks.item(unavailable.root, { entry: { kind: 'user_input', text: '正文' }, entryKey: 'fixture:no-clipboard' });
  assert.equal(unavailable.walk(noClipboard).find((node) => node.tagName === 'button').disabled, true);
  assert.ok(unavailable.text().includes('当前环境不支持直接复制'));
});

test('空、脱敏、实际截断状态分别保留，脱敏仍显示可读正文', () => {
  const h = harness();
  h.hooks.span(h.root, span('moss.tool.invoke', '', 0, content([
    { kind: 'tool_input', text: '' }, { kind: 'tool_output', text: 'token=[REDACTED]\n已完成' },
  ], { truncated: true, redacted: true })));
  assert.ok(h.text().includes('内容为空'));
  assert.ok(h.text().includes('已脱敏'));
  assert.ok(h.text().includes('已截断'));
  assert.ok(h.text().includes('不能代表完整正文'));
  assert.ok(h.text().includes('token=[REDACTED]'));
});

test('未采集、过期、暂不可用和 malformed DTO 不泄露夹带 entries 或软关联正文', () => {
  for (const [availability, expected] of [['not_captured', '历史内容无法补回'], ['expired', '已过保留期'], ['unavailable', '暂不可用']] as const) {
    const h = harness();
    h.hooks.conversation(h.root, { traces: [{ spans: [span('moss.session', '', 0, { availability, schema, entries: [{ kind: 'user_input', text: '不得展示' }] })] }],
      summary: { availability: 'available', value: { prompt: '摘要中未授权原文' } },
      unboundCandidates: { spans: [span('soft-candidate', '', 0, content([{ kind: 'user_input', text: '软关联正文' }]))] } });
    assert.ok(h.text().includes(expected));
    assert.ok(!/不得展示|摘要中未授权原文|软关联正文/.test(h.text()));
  }
  const h = harness();
  h.hooks.span(h.root, span('broken', '', 0, { availability: 'available', schema: 'foreign', entries: [{ kind: 'user_input', text: '不得展示' }] }));
  assert.ok(h.text().includes('暂不可用'));
  assert.ok(!h.text().includes('不得展示'));
  assert.equal(h.hooks.item(h.root, { entry: { kind: 'system_prompt', text: '不得展示' }, entryKey: 'fixture:invalid' }), null);
});

test('加载与读取失败状态明确区别于没有正文', () => {
  const h = harness();
  const loading = h.hooks.conversation(h.root, null, { loading: true });
  assert.equal(loading.attributes['aria-busy'], 'true');
  assert.equal(h.walk(loading).find((node) => node.attributes.role === 'status').textContent, '正在读取对话与工具内容…');
  const failed = h.hooks.conversation(h.root, null, { error: '服务暂不可用' });
  assert.ok(h.walk(failed).find((node) => node.attributes.role === 'alert').textContent.includes('正文读取失败'));
  assert.ok(!h.text(failed).includes('没有可展示的正文'));
});

test('独立片段按绝对时间或 offset 排序，来源折叠且序号可关闭', () => {
  const h = harness();
  const later = span('later-model', '', 10, content([{ kind: 'model_output', text: '后一个片段' }])); later.startOffsetMs = 30;
  const earlier = span('earlier-user', '', 0, content([{ kind: 'user_input', text: '先一个片段' }])); earlier.startOffsetMs = 20;
  h.hooks.conversation(h.root, { traces: [
    { traceRef: 'trace-later', startedAt: '2026-10-10T01:00:01Z', spans: [later] },
    { traceRef: 'trace-earlier', startedAt: '2026-10-10T01:00:00Z', spans: [earlier] },
  ] }, { showSequence: false });
  const cards = h.all().filter((node) => node.className.startsWith('trace-content-entry '));
  assert.deepEqual(cards.map(h.formattedText), ['先一个片段', '后一个片段']);
  assert.equal(h.all().filter((node) => node.className === 'trace-content-sequence').length, 0);
  assert.ok(!h.visibleText().includes('trace-earlier'));
  assert.ok(h.text().includes('trace-earlier'));
});

test('稳定标识不含正文和时间，同一 entry 在汇总与 span 详情中拥有不同命名空间', () => {
  const makeDetail = (text: string, time: string) => ({ traces: [{ traceRef: 'trace-one', startedAt: time, spans: [span('span-one', time, 1, content([{ kind: 'user_input', text }]))] }] });
  const first = harness(); first.hooks.conversation(first.root, makeDetail('第一次正文', '2026-10-10T01:00:00Z'));
  const second = harness(); second.hooks.conversation(second.root, makeDetail('更新正文', '2026-10-12T01:00:00Z'));
  const keys = (h: ReturnType<typeof harness>) => h.all().filter((node) => node.attributes['data-trace-disclosure-key']).map((node) => node.attributes['data-trace-disclosure-key']);
  assert.deepEqual(keys(first), keys(second));
  first.hooks.span(first.root, makeDetail('第一次正文', '') .traces[0]!.spans[0]);
  assert.equal(new Set(keys(first)).size, keys(first).length);
});

test('实际详情组装保留正文、父子瀑布和安全属性，不重复插入汇总', () => {
  const h = harness({ fullPage: true });
  const parent = span('parent', '2026-10-10T01:00:00Z', 2000, content([{ kind: 'user_input', text: '合成用户输入' }]));
  const child = { ...span('child', '2026-10-10T01:00:01Z', 300, content([{ kind: 'model_output', text: '合成模型输出' }])), parentSpanRef: 'parent', startOffsetMs: 1000, attributes: { model: 'model-safe' } };
  h.state.traceDetailData = { run: { runRef: 'fixture-run', producer: {} }, coverage: { state: 'complete' }, traces: [{ traceRef: 'trace-safe', durationMs: 2000, spans: [parent, child] }] };
  h.hooks.detail(h.root);
  assert.equal(h.all().filter((node) => node.className === 'trace-conversation').length, 1);
  assert.equal(h.all().filter((node) => node.className.startsWith('trace-span-row ')).length, 2);
  assert.equal(h.all().filter((node) => node.className === 'trace-span-content').length, 2);
  assert.equal(h.all().filter((node) => node.className === 'trace-span-label')[1].style.paddingLeft, '12px');
  assert.ok(h.text().includes('合成用户输入'));
  assert.ok(h.text().includes('合成模型输出'));
  assert.ok(h.text().includes('model-safe'));
  assert.ok(OPS_OBSERVABILITY_TRACES_STYLE.includes(OPS_OBSERVABILITY_TRACE_CONTENT_STYLE));
  assert.doesNotMatch(OPS_OBSERVABILITY_TRACE_CONTENT_STYLE, /grid-template-areas|\.trace-detail\{/);
});

test('实际运行详情直接展示本轮正文，模型实际输入默认收起且可按角色展开', () => {
  const h = harness({ fullPage: true });
  h.state.traceDetailOverview = { clientType: 'desktop', appVersion: '1.4.4', sessionRef: 'stale-session' };
  h.state.traceDetailData = {
    run: { runRef: 'current-run', sessionRef: 'bound-session', producer: {} },
    coverage: { state: 'complete' },
    conversationContext: { binding: 'bound', runRef: 'current-run', sessionRef: 'bound-session',
      currentTurn: { availability: 'available', turn: { turnRef: 'current-turn', runRef: 'current-run',
        recordedAt: '2026-10-12T01:00:00Z', content: content([
          { kind: 'user_input', text: '本轮具体问题：检查摄像头' },
          { kind: 'model_output', text: '本轮具体回复：摄像头正常' },
        ]) } }, history: { availability: 'missing', turns: [], truncated: false } },
    traces: [{ traceRef: 'model-trace', spans: [span('model-call', '2026-10-12T01:00:00Z', 100,
      content([{ kind: 'model_input', text: JSON.stringify({ messages: [
        { role: 'user', content: '模型实际读取的此前问题' },
        { role: 'assistant', content: '模型实际读取的此前回答' },
        { role: 'user', content: '本轮具体问题：检查摄像头' },
      ] }) }]))] }],
  };
  h.hooks.detail(h.root);
  const visible = h.visibleText();
  assert.ok(visible.includes('本轮具体问题：检查摄像头'));
  assert.ok(visible.includes('本轮具体回复：摄像头正常'));
  assert.ok(!visible.includes('模型实际读取的此前问题'));
  assert.ok(!visible.includes('模型实际读取的此前回答'));
  assert.ok(visible.includes('模型与工具证据'));
  const evidence = h.all().find(node => node.className === 'trace-conversation');
  assert.equal(evidence.open, false);
  evidence.open = true;
  assert.ok(h.visibleText().includes('模型实际读取的此前问题'));
  assert.ok(h.visibleText().includes('模型实际读取的此前回答'));
  assert.ok(h.visibleText().includes('模型实际输入（含上下文）'));
  const body = h.all().find(node => node.className === 'trace-detail-body');
  const classes = body.children.map((node: any) => node.className);
  assert.ok(classes.indexOf('trace-conversation trace-bound-context') < classes.indexOf('trace-detail-facts'));
  assert.ok(classes.indexOf('trace-conversation') < classes.indexOf('trace-detail-facts'));
  const metadata = h.all().find(node => node.className === 'trace-context trace-detail-disclosure');
  metadata.open = true;
  assert.ok(h.visibleText().includes('运行元信息'));
  assert.ok(h.visibleText().includes('见上方正文区'));
  assert.ok(!h.text().includes('上下文摘要'));
  assert.ok(!h.text().includes('提示词、模型输出和工具参数不会在这里出现'));
  assert.ok(!h.text().includes('stale-session'));
});

test('对话上下文按服务端绑定展示本轮，历史归档与实际模型输入分别标注', () => {
  const h = harness();
  const turn = (turnRef: string, runRef: string, text: string) => ({ turnRef, runRef,
    recordedAt: '2026-10-12T01:00:00Z', content: content([{ kind: 'user_input', text }]) });
  h.state.traceDetailOverview = { sessionRef: 'stale-list-session' };
  const panel = h.hooks.context(h.root, { run: { runRef: 'current-run', sessionRef: 'authoritative-session' },
    conversationContext: { binding: 'bound', runRef: 'current-run', sessionRef: 'authoritative-session',
      currentTurn: { availability: 'available', turn: turn('current-turn', 'current-run', '本轮用户请求') },
      history: { availability: 'available', turns: [turn('prior-turn', 'prior-run', '此前用户请求')], truncated: true } } });
  assert.equal(panel.open, true);
  assert.ok(!h.visibleText().includes('authoritative-session'));
  assert.ok(h.text().includes('authoritative-session'));
  assert.ok(h.visibleText().includes('本轮用户请求'));
  assert.ok(!h.visibleText().includes('此前用户请求'));
  assert.ok(!h.text().includes('stale-list-session'));
  const history = h.all().find(node => node.className === 'trace-context-history');
  history.open = true;
  assert.ok(h.visibleText().includes('authoritative-session'));
  assert.ok(h.visibleText().includes('此前用户请求'));
  assert.ok(h.text().includes('模型实际使用的上下文以本次模型输入快照为准'));
  assert.ok(h.text().includes('仅返回最近 8 轮'));
  assert.ok(h.text().includes('current-turn'));
  assert.ok(h.text().includes('prior-run'));
});

test('绑定冲突或未绑定时不展示夹带的本轮和历史正文，读取失败保持明确状态', () => {
  for (const binding of ['conflict', 'unbound']) {
    const h = harness();
    const turn = { turnRef: 'private-turn', content: content([{ kind: 'user_input', text: '不能展示的归档' }]) };
    h.hooks.context(h.root, { conversationContext: { binding,
      currentTurn: { availability: 'available', turn }, history: { availability: 'available', turns: [turn] } } });
    assert.ok(!h.text().includes('不能展示的归档'));
    assert.ok(h.text().includes(binding === 'conflict' ? '绑定冲突' : '未绑定会话'));
  }
  const h = harness();
  h.hooks.context(h.root, { conversationContext: { binding: 'bound',
    currentTurn: { availability: 'unavailable' }, history: { availability: 'unavailable' } } });
  assert.ok(h.text().includes('归档暂不可用'));
  assert.ok(!h.text().includes('没有已归档'));
});

test('模型输入快照保留消息角色和此前上下文，缺失及实际截断均明确说明', () => {
  const h = harness();
  const messages = JSON.stringify({ messages: [{ role: 'user', content: '此前问题' },
    { role: 'assistant', content: '此前回答' }, { role: 'user', content: '本轮问题' }] });
  h.hooks.conversation(h.root, { traces: [{ traceRef: 'trace-input', spans: [
    span('model-input', '2026-10-12T01:00:00Z', 100, content([{ kind: 'model_input', text: messages }], { truncated: true })),
  ] }] });
  assert.ok(h.text().includes('模型实际输入（含上下文）'));
  assert.ok(h.text().includes('此前问题'));
  assert.ok(h.text().includes('此前回答'));
  assert.ok(h.text().includes('快照已截断'));
  const missing = harness();
  missing.hooks.conversation(missing.root, { traces: [{ spans: [
    span('only-user', '', 1, content([{ kind: 'user_input', text: '本轮问题' }])),
  ] }] });
  assert.ok(missing.text().includes('模型实际上下文未采集'));
});

test('真实详情的归档和采集重复正文只默认显示一次，模型输入与工具按需展开', () => {
  const h = harness({ fullPage: true, clipboard: { writeText: async () => {} } });
  const user = '当前用户问题：查看相机';
  const answer = '当前助手回答：相机可用';
  h.state.traceDetailData = {
    run: { runRef: 'dedup-run', sessionRef: 'dedup-session', producer: {} }, coverage: { state: 'complete' },
    conversationContext: { binding: 'bound', runRef: 'dedup-run', sessionRef: 'dedup-session',
      currentTurn: { availability: 'available', turn: { turnRef: 'dedup-turn', runRef: 'dedup-run',
        content: content([{ kind: 'user_input', text: user }, { kind: 'model_output', text: answer }]) } },
      history: { availability: 'missing', turns: [] } },
    traces: [{ traceRef: 'dedup-trace', spans: [span('dedup-span', '', 1, content([
      { kind: 'user_input', text: user },
      { kind: 'model_input', text: JSON.stringify({ messages: [{ role: 'user', content: user }] }) },
      { kind: 'tool_input', text: '{"camera":"front"}' },
      { kind: 'tool_output', text: '{"ready":true}' },
      { kind: 'model_output', text: JSON.stringify({ content: [{ type: 'text', text: answer }], stopReason: 'end_turn' }) },
    ]))] }],
  };
  h.hooks.detail(h.root);
  const evidence = h.all().find((node) => node.className === 'trace-conversation');
  assert.equal(evidence.open, false);
  assert.equal(h.visibleText().split(user).length - 1, 1);
  assert.equal(h.visibleText().split(answer).length - 1, 1);
  const evidenceCards = h.walk(evidence).filter((node) => node.className.startsWith('trace-content-entry '));
  assert.deepEqual(evidenceCards.map((node) => node.attributes['data-trace-content-kind']), ['model_input', 'tool_input', 'tool_output']);
  assert.doesNotMatch(h.visibleText(), /"camera"|"ready"/);
  evidence.open = true;
  assert.match(h.visibleText(), /模型实际输入（含上下文）|工具调用 · 参数|工具调用 · 结果/);
  const tool = evidenceCards.find((node) => node.attributes['data-trace-content-kind'] === 'tool_input');
  tool.open = true;
  assert.match(h.visibleText(), /"camera": "front"/);
  assert.ok(h.walk(tool).some((node) => node.attributes['data-trace-disclosure-key']?.endsWith(':more')));
});

test('归档缺失时主对话来自已采集正文，下方不再重复且缺失状态继续可见', () => {
  const h = harness({ fullPage: true });
  h.state.traceDetailData = {
    run: { runRef: 'captured-run', sessionRef: 'captured-session', producer: {} }, coverage: { state: 'complete' },
    conversationContext: { binding: 'bound', runRef: 'captured-run', sessionRef: 'captured-session',
      currentTurn: { availability: 'missing' }, history: { availability: 'missing', turns: [] } },
    traces: [{ traceRef: 'captured-trace', spans: [span('captured-span', '', 1, content([
      { kind: 'user_input', text: '只默认显示一次的问题' },
      { kind: 'model_output', text: '只默认显示一次的回答' },
    ]))] }],
  };
  h.hooks.detail(h.root);
  const evidence = h.all().find((node) => node.className === 'trace-conversation');
  assert.equal(evidence.open, false);
  assert.equal(h.visibleText().split('只默认显示一次的问题').length - 1, 1);
  assert.equal(h.visibleText().split('只默认显示一次的回答').length - 1, 1);
  assert.match(h.visibleText(), /尚未发现与本 Run 精确关联的归档/);
  evidence.open = true;
  assert.match(h.visibleText(), /没有额外模型输入或工具正文/);
  assert.equal(h.walk(evidence).filter((node) => node.className.startsWith('trace-content-entry ')).length, 0);
});

test('没有主对话时采集正文仍直接可读，归档外不同模型说明留在可展开的证据中', () => {
  const h = harness();
  const fixture: any = { run: { runRef: 'partial-run' }, traces: [{ traceRef: 'partial-trace', spans: [span('partial-span', '', 1,
    content([{ kind: 'user_input', text: '采集问题' }, { kind: 'model_output', text: '不同的模型说明' }]))] }] };
  const fallback = h.hooks.conversation(h.root, fixture);
  assert.equal(fallback.open, true);
  assert.match(h.visibleText(fallback), /采集问题|不同的模型说明/);
  fixture.conversationContext = { binding: 'bound', runRef: 'partial-run', sessionRef: 'partial-session',
    currentTurn: { availability: 'available', turn: { runRef: 'partial-run', turnRef: 'partial-turn',
      content: content([{ kind: 'user_input', text: '采集问题' }, { kind: 'model_output', text: '归档的正式回答' }]) } } };
  const evidence = h.hooks.conversation(h.root, fixture);
  assert.equal(evidence.open, false);
  assert.doesNotMatch(h.text(evidence), /采集问题|归档的正式回答/);
  assert.match(h.text(evidence), /不同的模型说明/);
  evidence.open = true;
  assert.match(h.visibleText(evidence), /不同的模型说明/);
});

test('正文只保留一个原文与来源入口，收起该入口会恢复阅读视图，复制仍取完整原文', async () => {
  const writes: string[] = [];
  const h = harness();
  const original = '{"ready":true,"id":9007199254740993}';
  const card = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: original },
    source: { spanRef: 'compact-source' }, entryKey: 'compact:tool', options: { toolOpen: true, copyText: async (text: string) => { writes.push(text); } } });
  const footer = h.walk(card).find((node) => node.className === 'trace-content-footer');
  const raw = h.walk(card).find((node) => node.className === 'trace-content-raw');
  assert.equal(footer.tagName, 'details');
  assert.equal(footer.open, false);
  assert.match(h.visibleText(card), /原文与来源/);
  assert.doesNotMatch(h.visibleText(card), /复制原文|查看原文|compact-source/);
  footer.open = true;
  assert.match(h.visibleText(card), /复制原文|查看原文|来源/);
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(card.attributes['data-trace-body-mode'], 'raw');
  assert.match(h.visibleText(card), /"id":9007199254740993/);
  footer.open = false;
  assert.equal(card.attributes['data-trace-body-mode'], 'formatted');
  assert.match(h.visibleText(card), /"id": 9007199254740993/);
  footer.open = true;
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(writes, [original]);
});

test('折叠的模型证据仍在摘要提示真实截断，读取错误保持展开和 alert 语义', () => {
  const h = harness();
  const fixture = { run: { runRef: 'truncated-run' },
    conversationContext: { binding: 'bound', runRef: 'truncated-run', currentTurn: { availability: 'available',
      turn: { turnRef: 'truncated-turn', content: content([{ kind: 'user_input', text: '本轮问题' }]) } } },
    traces: [{ traceRef: 'truncated-trace', spans: [span('truncated-span', '', 1,
      content([{ kind: 'model_input', text: '{"messages":[{"role":"user","content":"截断上下文"}]}' }], { truncated: true }))] }] };
  const panel = h.hooks.conversation(h.root, fixture);
  assert.equal(panel.open, false);
  assert.match(h.visibleText(panel), /已截断/);
  assert.doesNotMatch(h.visibleText(panel), /截断上下文/);
  const failed = h.hooks.conversation(h.root, fixture, { error: '正文接口 503' });
  assert.equal(failed.open, true);
  assert.match(h.visibleText(failed), /正文读取失败：正文接口 503/);
  assert.ok(h.walk(failed).some((node) => node.attributes.role === 'alert'));
});

test('主对话可读但模型正文不可用或过期时，折叠摘要仍明确显示读取状态', () => {
  for (const [availability, hint] of [['unavailable', '暂不可用'], ['expired', '已过保留期']] as const) {
    const h = harness();
    const fixture = { run: { runRef: 'status-run' },
      conversationContext: { binding: 'bound', runRef: 'status-run', currentTurn: { availability: 'available',
        turn: { turnRef: 'status-turn', content: content([{ kind: 'user_input', text: '已返回本轮问题' }]) } },
        history: { availability: 'unavailable', turns: [] } },
      traces: [{ traceRef: 'status-trace', spans: [span('status-span', '', 1,
        { availability, schema, entries: [{ kind: 'model_input', text: '不可展示的夹带上下文' }] })] }] };
    const bound = h.hooks.context(h.root, fixture);
    assert.match(h.visibleText(), /已返回本轮问题/);
    assert.match(h.visibleText(bound), /历史暂不可用/);
    const evidence = h.hooks.conversation(h.root, fixture);
    assert.equal(evidence.open, false);
    assert.match(h.visibleText(evidence), new RegExp(hint));
    assert.doesNotMatch(h.text(evidence), /不可展示的夹带上下文/);
    evidence.open = true;
    assert.match(h.visibleText(evidence), new RegExp(hint));
  }
});

test('主归档过滤模型和工具正文时保留原 DTO 索引，Run 冲突不展示夹带正文', () => {
  const h = harness();
  const fixture = { run: { runRef: 'indexed-run' },
    conversationContext: { binding: 'bound', runRef: 'indexed-run', currentTurn: { availability: 'available',
      turn: { turnRef: 'indexed-turn', runRef: 'indexed-run', content: content([
        { kind: 'model_input', text: '归档快照只应出现在模型证据中' },
        { kind: 'user_input', text: '索引稳定的问题' },
        { kind: 'tool_output', text: '归档工具只应出现在模型证据中' },
        { kind: 'model_output', text: '索引稳定的回答' },
      ]) } }, history: { availability: 'missing', turns: [] } } };
  const primary = h.hooks.context(h.root, fixture);
  const keys = h.walk(primary).filter((node) => node.attributes['data-trace-entry-key']).map((node) => node.attributes['data-trace-entry-key']);
  assert.deepEqual(keys, ['context:current:indexed-turn:1', 'context:current:indexed-turn:3']);
  assert.doesNotMatch(h.text(primary), /归档快照|归档工具/);
  const evidence = h.hooks.conversation(h.root, fixture);
  assert.equal(evidence.open, false);
  assert.match(h.text(evidence), /归档快照|归档工具/);
  const evidenceKeys = h.walk(evidence).filter((node) => node.attributes['data-trace-entry-key']).map((node) => node.attributes['data-trace-entry-key']);
  assert.deepEqual(evidenceKeys, ['content:conversation:archive:indexed-turn:0:model_input', 'content:conversation:archive:indexed-turn:2:tool_output']);
  evidence.open = true;
  assert.match(h.visibleText(evidence), /归档快照/);
  fixture.conversationContext.runRef = 'other-run';
  const conflict = h.hooks.context(h.root, fixture);
  assert.match(h.visibleText(conflict), /标识发生冲突/);
  assert.doesNotMatch(h.text(conflict), /索引稳定/);
});

test('Trace 模型输出正文与归档相同但额外携带工具调用时，工具原文仍保留在证据中', () => {
  const h = harness();
  const answer = '我会先查询设备文档。';
  const original = JSON.stringify({ content: [{ type: 'text', text: answer },
    { type: 'tool_use', name: 'search_docs', input: { query: 'RDK X5' } }], stopReason: 'tool_use' });
  const fixture = { run: { runRef: 'structured-run' },
    conversationContext: { binding: 'bound', runRef: 'structured-run', currentTurn: { availability: 'available',
      turn: { turnRef: 'structured-turn', content: content([{ kind: 'model_output', text: answer }]) } } },
    traces: [{ traceRef: 'structured-trace', spans: [span('structured-span', '', 1,
      content([{ kind: 'model_output', text: original }]))] }] };
  const primary = h.hooks.context(h.root, fixture);
  const evidence = h.hooks.conversation(h.root, fixture);
  assert.match(h.visibleText(primary), /我会先查询设备文档/);
  assert.equal(evidence.open, false);
  assert.equal(h.walk(evidence).filter((node) => node.attributes['data-trace-content-kind'] === 'model_output').length, 1);
  assert.match(h.text(evidence), /search_docs|RDK X5/);
  evidence.open = true;
  const raw = h.walk(evidence).find((node) => node.className === 'trace-content-raw');
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
});

test('来源只有显式 showSource 初始选项会打开外层，内层来源和原文状态不改变外层选择', () => {
  const h = harness();
  const initial = h.hooks.item(h.root, { entry: { kind: 'tool_output', text: '{"ready":true}' },
    source: { spanRef: 'initial-source' }, entryKey: 'initial:source', options: { showSource: true, toolOpen: true } });
  const initialFooter = h.walk(initial).find((node) => node.className === 'trace-content-footer');
  const initialSource = h.walk(initial).find((node) => node.className === 'trace-content-source-details');
  assert.equal(initialFooter.open, true); assert.equal(initialSource.open, true);
  initialFooter.open = false;
  initialSource.open = false; initialSource.open = true;
  assert.equal(initialFooter.open, false, '程序恢复内层来源不能替用户重新展开外层');
  const raw = h.walk(initial).find((node) => node.className === 'trace-content-raw');
  raw.open = true;
  assert.equal(initialFooter.open, false, '程序恢复内层原文不能替用户重新展开外层');
  assert.equal(initial.attributes['data-trace-body-mode'], 'formatted');
});
