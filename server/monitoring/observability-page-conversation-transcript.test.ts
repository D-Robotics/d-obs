import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_TRACE_CONTENT } from './observability-page-script-trace-content.js';

type Entry = { kind: string; text: string };
const content = (entries: Entry[], availability = 'available') => ({
  availability, schema: 'rdk.studio.trace-content.v1', entries, redacted: false, truncated: false,
});

function harness() {
  const innerHTMLWrites: unknown[] = [];
  const copies: string[] = [];
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const make = (tag = 'div', className = '', text = ''): any => {
    const events = new Map<string, Array<(event: unknown) => unknown>>();
    let open = false;
    const node: any = {
      tagName: tag, className, textContent: text, children: [], attributes: {},
      parentElement: null, hidden: false, disabled: false,
      appendChild(child: any) { child.parentElement = node; node.children.push(child); return child; },
      setAttribute(key: string, value: unknown) { node.attributes[key] = String(value); },
      addEventListener(name: string, callback: (event: unknown) => unknown) {
        events.set(name, [...events.get(name) || [], callback]);
      },
      async fire(name: string) {
        for (const callback of events.get(name) || []) await callback({ target: node });
      },
    };
    Object.defineProperty(node, 'open', { get: () => open, set(value) {
      const changed = open !== Boolean(value); open = Boolean(value);
      if (changed) for (const callback of events.get('toggle') || []) callback({ target: node });
    } });
    Object.defineProperty(node, 'innerHTML', { set(value) { innerHTMLWrites.push(value); } });
    return node;
  };
  const root = make();
  const context = vm.createContext({
    make,
    add: (parent: any, tag: string, className: string, text: string) => parent.appendChild(make(tag, className, text)),
    traceList: (value: unknown) => Array.isArray(value) ? value : [],
    when: (value: unknown) => String(value || ''),
    navigator: { clipboard: { writeText: async (text: string) => { copies.push(text); } } },
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_TRACE_CONTENT + '\n globalThis.hooks = {' +
    'bound: renderTraceBoundConversation, item: renderTraceContentItem };', context);
  const visible = (node: any): boolean => {
    if (node.hidden) return false;
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.tagName === 'details' && !parent.open && parent.children[0] !== node) return false;
    return visible(parent);
  };
  const text = (node = root) => walk(node).map((item) => item.textContent).join('\n');
  const visibleText = (node = root) => walk(node).filter(visible).map((item) => item.textContent).join('\n');
  const byClass = (node: any, className: string) => walk(node).find((item) => item.className === className);
  return { root, hooks: (context as any).hooks, walk, text, visibleText, byClass, copies, innerHTMLWrites };
}

function detail(availability: string, binding = 'bound') {
  return {
    run: { runRef: 'current-run', sessionRef: 'current-session' },
    conversationContext: { binding, runRef: 'current-run', sessionRef: 'current-session',
      currentTurn: { availability }, history: { availability: 'missing', turns: [], truncated: false } },
    traces: [{ traceRef: 'current-trace', startedAt: '2026-10-12T01:00:00Z', spans: [{
      spanRef: 'current-span', name: 'moss.session', startedAt: '2026-10-12T01:00:00Z',
      durationMs: 100, startOffsetMs: 0,
      content: content([
        { kind: 'user_input', text: '本轮采集问题：摄像头能用吗？' },
        { kind: 'model_output', text: JSON.stringify({ content: [{ type: 'text', text: '本轮采集回答：摄像头可用。' }], stopReason: 'end_turn' }) },
      ]),
    }] }],
  };
}

for (const availability of ['missing', 'unavailable']) {
  test(`本轮精确归档 ${availability} 时，上方上下文默认显示当前 Trace 具体对话并保留归档状态`, () => {
    const h = harness();
    const fixture = detail(availability);
    const panel = h.hooks.bound(h.root, fixture);
    assert.equal(panel.open, true);
    assert.match(h.visibleText(panel), /本轮采集问题：摄像头能用吗？/);
    assert.match(h.visibleText(panel), /本轮采集回答：摄像头可用。/);
    assert.doesNotMatch(h.visibleText(panel), /"stopReason"|"content"/);
    assert.match(h.visibleText(panel), availability === 'missing' ? /尚未发现与本 Run 精确关联的归档/ : /对话归档暂不可用/);
    assert.match(h.text(panel), /current-span/);
  });
}

test('本轮精确归档 available 优先于 Trace 采集，历史仍默认折叠', () => {
  const h = harness();
  const fixture: any = detail('available');
  fixture.conversationContext.currentTurn.turn = {
    turnRef: 'exact-turn', runRef: 'current-run', recordedAt: '2026-10-12T01:00:00Z',
    content: content([{ kind: 'user_input', text: '精确归档问题' }, { kind: 'model_output', text: '精确归档回答' }]),
  };
  fixture.conversationContext.history = { availability: 'available', truncated: false, turns: [{
    turnRef: 'prior-turn', runRef: 'prior-run', recordedAt: '2026-10-11T01:00:00Z',
    content: content([{ kind: 'user_input', text: '仅此前归档问题' }]),
  }] };
  const panel = h.hooks.bound(h.root, fixture);
  assert.match(h.visibleText(panel), /精确归档问题/);
  assert.match(h.visibleText(panel), /精确归档回答/);
  assert.doesNotMatch(h.text(panel), /本轮采集问题|本轮采集回答/);
  assert.doesNotMatch(h.visibleText(panel), /仅此前归档问题/);
  assert.match(h.text(panel), /仅此前归档问题/);
});

test('绑定冲突禁止 Trace 对话回退，也不展示夹带归档与软关联候选正文', () => {
  const h = harness();
  const fixture: any = detail('available', 'conflict');
  const privateTurn = { turnRef: 'private-turn', content: content([{ kind: 'user_input', text: '冲突私有归档' }]) };
  fixture.conversationContext.currentTurn.turn = privateTurn;
  fixture.conversationContext.history = { availability: 'available', turns: [privateTurn] };
  fixture.unboundCandidates = { spans: [{ content: content([{ kind: 'user_input', text: '软关联候选正文' }]) }] };
  const panel = h.hooks.bound(h.root, fixture);
  assert.match(h.visibleText(panel), /绑定冲突|标识发生冲突/);
  assert.doesNotMatch(h.text(panel), /本轮采集问题|本轮采集回答|冲突私有归档|软关联候选正文/);
});

test('归档 missing 不读取暂不可用 Trace 中夹带的 entries 或软关联正文', () => {
  const h = harness();
  const fixture: any = detail('missing');
  fixture.traces[0].spans[0].content.availability = 'unavailable';
  fixture.unboundCandidates = { spans: [{ content: content([{ kind: 'model_output', text: '软关联不能当本轮回答' }]) }] };
  const panel = h.hooks.bound(h.root, fixture);
  assert.doesNotMatch(h.text(panel), /本轮采集问题|本轮采集回答|软关联不能当本轮回答/);
  assert.match(h.visibleText(panel), /尚未发现与本 Run 精确关联的归档/);
});

test('上下文 Run 与详情不一致时，不能将当前 Trace 当成该绑定的对话', () => {
  const h = harness();
  const fixture = detail('missing');
  fixture.conversationContext.runRef = 'different-run';
  const panel = h.hooks.bound(h.root, fixture);
  assert.doesNotMatch(h.text(panel), /本轮采集问题|本轮采集回答/);
});

test('已过保留期的归档不通过 Trace 重新展示对话', () => {
  const h = harness();
  const panel = h.hooks.bound(h.root, detail('expired'));
  assert.match(h.visibleText(panel), /本轮正文已过保留期/);
  assert.doesNotMatch(h.text(panel), /本轮采集问题|本轮采集回答/);
});

test('仅有模型输入和工具调用时，不冒充本轮用户问题与模型回答', () => {
  const h = harness();
  const fixture = detail('missing');
  fixture.traces[0]!.spans[0]!.content.entries = [
    { kind: 'model_input', text: JSON.stringify({ messages: [{ role: 'user', content: '仅输入快照的此前问题' }] }) },
    { kind: 'model_output', text: JSON.stringify({ content: [{ type: 'tool_use', name: 'private_tool', input: { query: '仅工具请求' } }], stopReason: 'tool_use' }) },
    { kind: 'tool_output', text: '仅工具结果' },
  ];
  const panel = h.hooks.bound(h.root, fixture);
  assert.doesNotMatch(h.text(panel), /仅输入快照的此前问题|private_tool|仅工具请求|仅工具结果/);
  assert.match(h.visibleText(panel), /尚未发现与本 Run 精确关联的归档/);
});

test('模型输出 text envelope 默认显示段落，完整 JSON 可查看并原样复制，HTML 始终作为文本', async () => {
  const h = harness();
  const message = '你好\n\n<img src=x onerror="globalThis.compromised=true">';
  const original = JSON.stringify({ content: [{ type: 'text', text: message }], stopReason: 'end_turn' });
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text: original }, entryKey: 'transcript:model-output' });
  assert.equal(card.open, true);
  assert.match(h.visibleText(card), /你好/);
  assert.match(h.visibleText(card), /<img src=x onerror=/);
  assert.doesNotMatch(h.visibleText(card), /"stopReason"|"content"|"type"/);
  assert.deepEqual(h.innerHTMLWrites, []);
  assert.equal(h.walk(card).filter((node) => ['img', 'script', 'a'].includes(node.tagName)).length, 0);
  const raw = h.byClass(card, 'trace-content-raw');
  assert.ok(raw, '转换成可读对话之后仍应有查看原文入口');
  raw.parentElement.open = true;
  raw.open = true;
  assert.match(h.visibleText(card), /"stopReason":"end_turn"/);
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(h.copies, [original]);
});

test('同一模型输出混合 text 与 tool_use 时，具体说明默认可见且工具原文完整保留', async () => {
  const h = harness();
  const original = JSON.stringify({ content: [
    { type: 'text', text: '我会查询摄像头文档。' },
    { type: 'tool_use', id: 'fixture-call', name: 'search_docs', input: { query: 'RDK X5' } },
  ], stopReason: 'tool_use' });
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text: original }, entryKey: 'transcript:mixed' });
  assert.equal(card.open, true, '包含实际对话文本的工具调用应默认展开');
  assert.match(h.visibleText(card), /我会查询摄像头文档。/);
  const raw = h.byClass(card, 'trace-content-raw');
  assert.ok(raw);
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(h.copies, [original]);
});

test('模型实际输入 messages 按角色和顺序显示具体消息，保留原文与安全文本语义', async () => {
  const h = harness();
  const original = JSON.stringify({ messages: [
    { role: 'user', content: '此前用户问题 <script>globalThis.compromised=true</script>' },
    { role: 'assistant', content: [{ type: 'text', text: '此前助手回答' }] },
    { role: 'user', content: '本轮用户问题' },
  ] });
  const card = h.hooks.item(h.root, { entry: { kind: 'model_input', text: original }, entryKey: 'transcript:model-input' });
  const visible = h.visibleText(card);
  assert.match(visible, /此前用户问题 <script>globalThis.compromised=true<\/script>/);
  assert.match(visible, /此前助手回答/);
  assert.match(visible, /本轮用户问题/);
  assert.ok(visible.indexOf('此前用户问题') < visible.indexOf('此前助手回答'));
  assert.ok(visible.indexOf('此前助手回答') < visible.indexOf('本轮用户问题'));
  assert.match(visible, /用户|user/);
  assert.match(visible, /助手|assistant/);
  assert.doesNotMatch(visible, /"messages"|"content"|"role"/);
  assert.deepEqual(h.innerHTMLWrites, []);
  assert.equal(h.walk(card).filter((node) => node.tagName === 'script').length, 0);
  const raw = h.byClass(card, 'trace-content-raw');
  assert.ok(raw);
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(h.copies, [original]);
});

test('普通 JSON 模型回复不能因为存在 text 属性就被误识别成对话 envelope', () => {
  const h = harness();
  const original = '{"text":"普通业务字段","result":{"ready":true}}';
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text: original }, entryKey: 'transcript:ordinary-json' });
  const formatted = h.byClass(card, 'trace-content-formatted');
  assert.equal(h.walk(formatted).find((node) => node.tagName === 'pre').textContent, JSON.stringify(JSON.parse(original), null, 2));
  assert.match(h.visibleText(card), /"text": "普通业务字段"/);
  assert.match(h.visibleText(card), /"result"/);
});

test('带业务 warnings 与 result 的 content 对象仍显示完整 JSON，不抽取为单独正文', () => {
  const h = harness();
  const original = JSON.stringify({ content: [{ type: 'text', text: '业务正文' }],
    warnings: ['相机权限未开启'], result: { ready: false } });
  const card = h.hooks.item(h.root, { entry: { kind: 'model_output', text: original }, entryKey: 'transcript:business-content' });
  const formatted = h.byClass(card, 'trace-content-formatted');
  assert.equal(h.walk(formatted).find((node) => node.tagName === 'pre').textContent, JSON.stringify(JSON.parse(original), null, 2));
  const visible = h.visibleText(card);
  assert.match(visible, /业务正文/);
  assert.match(visible, /"warnings"/);
  assert.match(visible, /相机权限未开启/);
  assert.match(visible, /"result"/);
  assert.match(visible, /"ready": false/);
});

test('模型输入 assistant 文本与 tool_calls 并存时，说明默认可读且提示结构化信息并保留原文', async () => {
  const h = harness();
  const original = JSON.stringify({ messages: [{ role: 'assistant', content: '准备调用工具',
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'x', arguments: '{}' } }],
  }] });
  const card = h.hooks.item(h.root, { entry: { kind: 'model_input', text: original }, entryKey: 'transcript:tool-calls' });
  assert.match(h.visibleText(card), /准备调用工具/);
  assert.match(h.visibleText(card), /包含工具调用|结构化内容/);
  const raw = h.byClass(card, 'trace-content-raw');
  assert.ok(raw);
  raw.parentElement.open = true;
  raw.open = true;
  assert.equal(h.walk(raw).find((node) => node.tagName === 'pre').textContent, original);
  await h.walk(card).find((node) => node.tagName === 'button').fire('click');
  assert.deepEqual(h.copies, [original]);
});
