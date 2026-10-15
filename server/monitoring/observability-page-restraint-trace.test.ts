import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_INVESTIGATION } from './observability-page-script-investigation.js';
import { OPS_OBSERVABILITY_SCRIPT_RESTRAINT } from './observability-page-restraint.js';
import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';

const bodyContent = (entries: Array<{ kind: string; text: string }>) => ({
  availability: 'available', schema: 'rdk.studio.trace-content.v1', entries, redacted: false, truncated: false,
});
function fixture(outcome: string | null = 'completed', elapsedMs = 1250) {
  const run = { runRef: 'restraint-run', sessionRef: 'restraint-session', locator: 'restraint-locator', outcome,
    startedAt: '2026-10-12T01:00:00Z', completedAt: '2026-10-12T01:00:01Z', elapsedMs, firstTextMs: 180,
    retryCount: 1, toolCallCount: 2, environment: 'production', producer: { surface: 'desktop', studioVersion: '1.4.4' },
    coverage: { state: 'complete', spanCount: 1, traceCount: 1 } };
  return { run, coverage: run.coverage,
    conversationContext: { binding: 'bound', runRef: run.runRef, sessionRef: run.sessionRef,
      currentTurn: { availability: 'available', turn: { turnRef: 'restraint-turn', runRef: run.runRef,
        content: bodyContent([{ kind: 'user_input', text: '收敛测试的用户问题' }, { kind: 'model_output', text: '收敛测试的助手回答' }]) } },
      history: { availability: 'missing', turns: [] } },
    traces: [{ traceRef: 'restraint-trace', durationMs: elapsedMs, spans: [{ spanRef: 'restraint-span', name: 'moss.session',
      startOffsetMs: 0, durationMs: elapsedMs, status: 'ok', outcome: 'completed', sourceSegment: 'moss', attributes: {},
      content: bodyContent([{ kind: 'user_input', text: '收敛测试的用户问题' }, { kind: 'model_output', text: '收敛测试的助手回答' }]) }] }],
    evidence: { availability: { runFact: 'available', runSummary: 'available', operations: 'missing', productEvents: 'missing' }, items: [] },
    advancedExport: { availability: 'not_authorized' } };
}

/** Actual Trace scripts and RESTRAINT run against only the DOM nodes this fixture mounts. */
function harness(initial = fixture()) {
  const document: any = { activeElement: null, addEventListener() {} };
  const timers: Array<() => void> = [];
  const walk = (node: any): any[] => [node, ...node.children.flatMap(walk)];
  const dataName = (name: string) => name.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
  const matches = (node: any, selector: string) => selector.split(',').some((part) => {
    const value = part.trim();
    if (value.startsWith('.')) return node.className.split(' ').includes(value.slice(1));
    const match = /^([\w-]+)?\[([^\]]+)\]$/.exec(value);
    if (match) return (!match[1] || node.tagName === match[1].toUpperCase()) && node.getAttribute(match[2]) !== null;
    return node.tagName === value.toUpperCase();
  });
  let body: any;
  const make = (tag = 'div', className = '', text = ''): any => {
    const listeners = new Map<string, Function[]>();
    let opened = false;
    const node: any = { tagName: tag.toUpperCase(), className, textContent: text, children: [], attributes: {}, dataset: {},
      style: {}, parentElement: null, hidden: false, disabled: false, scrollTop: 0, scrollLeft: 0,
      appendChild(child: any) { child.remove(); child.parentElement = node; node.children.push(child); return child; },
      replaceChildren(...children: any[]) { node.children.slice().forEach((child: any) => child.remove()); children.forEach((child) => node.appendChild(child)); },
      remove() { if (node.parentElement) { if (node.contains(document.activeElement)) document.activeElement = body; node.parentElement.children = node.parentElement.children.filter((child: any) => child !== node); node.parentElement = null; } },
      contains(other: any) { return Boolean(other) && walk(node).includes(other); },
      querySelectorAll(selector: string) { return walk(node).slice(1).filter((child) => matches(child, selector)); },
      querySelector(selector: string) { return node.querySelectorAll(selector)[0] || null; },
      setAttribute(name: string, value: unknown) { node.attributes[name] = String(value); if (name.startsWith('data-')) node.dataset[dataName(name)] = String(value); },
      getAttribute(name: string) { return name.startsWith('data-') ? node.dataset[dataName(name)] ?? null : node.attributes[name] ?? null; },
      addEventListener(name: string, callback: Function) { listeners.set(name, [...listeners.get(name) || [], callback]); },
      fire(name: string) { listeners.get(name)?.forEach((callback) => callback({ target: node })); },
      focus() { if (node.isConnected && !node.disabled) document.activeElement = node; },
    };
    Object.defineProperty(node, 'open', { get: () => opened, set(value) { const changed = opened !== Boolean(value); opened = Boolean(value); if (changed) node.fire('toggle'); } });
    Object.defineProperty(node, 'isConnected', { get: () => Boolean(body?.contains(node)) });
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    node.classList = { add: (name: string) => { node.className += ' ' + name; }, contains: (name: string) => node.className.split(' ').includes(name) };
    return node;
  };
  body = make('body'); document.body = body; document.activeElement = body; document.scrollingElement = body;
  const byId = (id: string) => walk(body).find((node) => node.id === id) || null;
  const host = make(); host.id = 'nativeRunTraceHost'; body.appendChild(host);
  const traceContent = make(); traceContent.id = 'nativeTraceContent'; host.appendChild(traceContent);
  document.querySelectorAll = (selector: string) => walk(body).filter((node) => matches(node, selector));
  document.querySelector = (selector: string) => document.querySelectorAll(selector)[0] || null;
  const state: any = { view: 'traces', viewChild: 'runs', viewSource: 'traces/runs', overviewHours: 24,
    overview: { runTraces: [initial.run], runTracePage: { environment: 'production', limit: 40, nextCursor: null } } };
  let nextDetail = initial;
  const requests: string[] = [];
  const context = vm.createContext({ document, state, make, $: byId,
    add: (parent: any, tag: string, cls: string, text: string) => parent.appendChild(make(tag, cls, text)),
    fmt: (value: unknown) => String(Number(value) || 0), pct: (value: number) => String(value * 100) + '%', when: (value: unknown) => String(value || '—'),
    // These unrelated surfaces are intentionally absent: the RESTRAINT initializer sees zero module lists.
    renderOverview() {}, renderActionLoopMount() {}, setView() {}, applyAuthMode() {}, obsLogout() {}, obsActiveTenant: () => 'restraint-tenant',
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout() {}, AbortController, URL,
    base: '/dobs', contextRequestHeaders: () => ({}),
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, detail: nextDetail }) }; },
  });
  const outcomeSource = OPS_OBSERVABILITY_SCRIPT_INVESTIGATION.split('\n').find((line) => line.includes('function outcomeName('));
  assert.ok(outcomeSource, 'use the actual outcome labels for errors and unknown outcomes');
  vm.runInContext(outcomeSource + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\nglobalThis.baseFacts=renderTraceRunFacts;\n' +
    OPS_OBSERVABILITY_SCRIPT_RESTRAINT + '\nglobalThis.hooks={render:renderNativeTraces,open:openRunObservability,retry:retryRunObservability};', context);
  const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let turn = 0; timers.length; turn++) {
      assert.ok(turn < 20);
      timers.splice(0).forEach((callback) => callback());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const visible = (node: any): boolean => {
    if (node.hidden) return false;
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.tagName === 'DETAILS' && !parent.open && parent.children[0] !== node) return false;
    return visible(parent);
  };
  const text = (node = body) => walk(node).map((item) => item.textContent).join('\n');
  const visibleText = (node = body) => walk(node).filter(visible).map((item) => item.textContent).join('\n');
  const metrics = () => walk(body).find((node) => node.dataset.traceDisclosureKey === 'detail:run-facts');
  return { state, hooks: (context as any).hooks, baseFacts: (context as any).baseFacts, make, byId, metrics, requests, document,
    walk, text, visibleText, settle, setDetail: (detail: typeof initial) => { nextDetail = detail; } };
}

const factLabels = ['运行结果', '开始时间', '完成时间', '总耗时', '首字延迟', '重试 / 工具', '运行环境', '生产方'];

test('actual Trace + RESTRAINT keeps primary dialogue readable and folds all eight original Run facts', async () => {
  const detail = fixture();
  const h = harness(detail); h.hooks.render(); h.hooks.open(detail.run); await h.settle();
  assert.match(h.visibleText(), /收敛测试的用户问题/);
  assert.match(h.visibleText(), /收敛测试的助手回答/);
  assert.equal(h.visibleText().split('收敛测试的用户问题').length - 1, 1);
  assert.equal(h.visibleText().split('收敛测试的助手回答').length - 1, 1);
  const metrics = h.metrics();
  assert.equal(metrics.tagName, 'DETAILS'); assert.equal(metrics.open, false);
  assert.match(h.visibleText(metrics), /运行指标\n成功 · 1\.3 s · 2 次工具/);
  assert.doesNotMatch(h.visibleText(h.byId('nativeTraceDetail')), /开始时间|完成时间|首字延迟|重试 \/ 工具|Studio 1\.4\.4/);
  const original = h.make(); h.baseFacts(original, detail);
  const originalFacts = h.walk(original).filter((node) => node.className === 'trace-detail-fact');
  const wrappedFacts = h.walk(metrics).filter((node) => node.className === 'trace-detail-fact');
  assert.equal(originalFacts.length, 8); assert.equal(wrappedFacts.length, 8);
  assert.deepEqual(wrappedFacts.map((node) => h.text(node)), originalFacts.map((node) => h.text(node)), 'the wrapper must render the original complete values');
  metrics.open = true;
  factLabels.forEach((label) => assert.match(h.visibleText(metrics), new RegExp(label.replace('/', '\\/'))));
  assert.match(h.visibleText(metrics), /production|Studio 1\.4\.4|180 ms/);
});

for (const [outcome, expected] of [['error', '失败'], ['unknown', 'unknown'], [null, '状态待确认']] as const) {
  test(`closed Run metrics summary explicitly retains outcome ${String(outcome)}`, async () => {
    const detail = fixture(outcome); const h = harness(detail); h.hooks.render(); h.hooks.open(detail.run); await h.settle();
    const metrics = h.metrics(); assert.equal(metrics.open, false);
    assert.match(h.visibleText(metrics), new RegExp(expected));
    assert.doesNotMatch(h.visibleText(metrics), /成功|健康|正常/);
    assert.match(h.visibleText(), /收敛测试的用户问题|收敛测试的助手回答/);
  });
}

test('actual native detail refresh restores the stable Run metrics disclosure and its keyboard focus', async () => {
  const detail = fixture(); const h = harness(detail); h.hooks.render(); h.hooks.open(detail.run); await h.settle();
  const before = h.metrics(); assert.equal(before.dataset.traceDisclosureKey, 'detail:run-facts');
  before.open = true; before.children[0].focus();
  const refreshed = fixture('error', 3200); h.setDetail(refreshed);
  h.hooks.retry(); await h.settle();
  const after = h.metrics();
  assert.equal(h.requests.length, 2, 'refresh must really reread the run endpoint');
  assert.ok(h.requests.every((path) => path === '/dobs/api/ops/observability/runs/restraint-locator'));
  assert.notEqual(after, before, 'a new backend snapshot rebuilds the detail body');
  assert.equal(after.dataset.traceDisclosureKey, 'detail:run-facts'); assert.equal(after.open, true);
  assert.equal(h.document.activeElement, after.children[0]);
  assert.match(h.visibleText(after), /失败 · 3\.2 s · 2 次工具/);
  factLabels.forEach((label) => assert.ok(h.visibleText(after).includes(label)));
  after.open = false; h.setDetail(fixture('unknown', 4200)); h.hooks.retry(); await h.settle();
  assert.equal(h.metrics().open, false, 'the same native key also restores the user\'s collapsed choice');
  assert.match(h.visibleText(h.metrics()), /unknown · 4\.2 s/);
  assert.doesNotMatch(h.visibleText(h.metrics()), /开始时间|完成时间/);
});

for (const innerClass of ['trace-content-raw', 'trace-content-source-details']) {
  test(`native polling and reread preserve a collapsed footer with ${innerClass} still open inside`, async () => {
    const structuredFixture = () => {
      const detail = fixture();
      const envelope = JSON.stringify({ content: [{ type: 'text', text: '收敛测试的助手回答' }], stopReason: 'end_turn' });
      detail.conversationContext.currentTurn.turn.content.entries[1]!.text = envelope;
      detail.traces[0]!.spans[0]!.content.entries[1]!.text = envelope;
      return detail;
    };
    const detail = structuredFixture(); const h = harness(detail);
    h.hooks.render(); h.hooks.open(detail.run); await h.settle();
    const primaryCard = () => h.walk(h.byId('nativeTraceDetail')).find((node) =>
      node.dataset.traceEntryKey?.startsWith('context:current:') && node.dataset.traceContentKind === 'model_output');
    const beforeCard = primaryCard();
    const beforeFooter = h.walk(beforeCard).find((node) => node.className === 'trace-content-footer');
    const beforeInner = h.walk(beforeCard).find((node) => node.className === innerClass);
    beforeFooter.open = true; beforeInner.open = true; beforeFooter.open = false;
    beforeFooter.children[0].focus();
    assert.equal(beforeInner.open, true); assert.equal(beforeFooter.open, false);
    assert.match(h.visibleText(beforeCard), /收敛测试的助手回答/);
    h.state.overview = { ...h.state.overview, fetchedAt: 'poll-preserving-footer' };
    h.hooks.render(); await h.settle();
    assert.equal(primaryCard(), beforeCard, 'overview-only polling retains the current detail DOM');
    assert.equal(beforeFooter.open, false); assert.equal(beforeInner.open, true);
    assert.equal(h.document.activeElement, beforeFooter.children[0]);
    h.setDetail(structuredFixture()); h.hooks.retry(); await h.settle();
    const afterCard = primaryCard();
    const afterFooter = h.walk(afterCard).find((node) => node.className === 'trace-content-footer');
    const afterInner = h.walk(afterCard).find((node) => node.className === innerClass);
    assert.notEqual(afterCard, beforeCard, 'reread must rebuild against the new DTO');
    assert.equal(afterInner.open, true, 'the independently keyed inner choice is restored');
    assert.equal(afterFooter.open, false, 'restoring inner state must preserve the collapsed outer choice');
    assert.equal(h.document.activeElement, afterFooter.children[0], 'focus remains on the visible outer summary');
    assert.match(h.visibleText(afterCard), /收敛测试的助手回答/);
    assert.doesNotMatch(h.visibleText(afterCard), /"stopReason"|restraint-session|复制原文/);
    if (innerClass === 'trace-content-raw') assert.equal(afterCard.attributes['data-trace-body-mode'], 'formatted');
    const search = h.walk(h.byId('nativeTraceContent')).find((node) => node.dataset.traceFocusKey === 'run-list:search');
    search.focus();
    h.setDetail(structuredFixture()); h.hooks.retry(); await h.settle();
    const restoredSearch = h.walk(h.byId('nativeTraceContent')).find((node) => node.dataset.traceFocusKey === 'run-list:search');
    assert.equal(h.document.activeElement, restoredSearch, 'reread preserves external search focus rather than pulling it into the detail');
    const finalFooter = h.walk(primaryCard()).find((node) => node.className === 'trace-content-footer');
    assert.equal(finalFooter.open, false);
  });
}
