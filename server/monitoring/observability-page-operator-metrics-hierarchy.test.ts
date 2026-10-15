import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS } from './observability-page-operator-metrics.js';

function fixture(): any {
  return {
    windowDays: 7, totalAccounts: 4620,
    totals: { newAccounts: 42, activeUsersPeak: 113, conversations: 260, runs: 190, promptTokens: 15000, completionTokens: 1000, totalTokens: 16000 },
    daily: [
      { day: '2026-10-09', newAccounts: 20, activeUsers: 100, conversations: 120, runs: 90, promptTokens: 7000, completionTokens: 400, totalTokens: 7400 },
      { day: '2026-10-10', newAccounts: 22, activeUsers: 113, conversations: 140, runs: 100, promptTokens: 8000, completionTokens: 600, totalTokens: 8600 },
    ],
    sources: { accounts: 'credit_account', activity: 'conversation_turns', tokens: 'agent_run_records', dispatch: 'dispatch receipt' },
    modelTokens: { configured: true, models: [{ model: 'model-a', runs: 190, totalTokens: 16000, share: 1, cost: { totalCost: 2, inputCost: 1.8, outputCost: .2, currency: 'CNY' } }], totals: { cost: { totalCost: 2, currency: 'CNY' } } },
    dispatch: { configured: true, runsWithPlan: 80, dispatchRate: .5, autoPreflightRuns: 20, successRate: .9, latency: { p95Ms: 2200 }, daily: [{ day: '2026-10-10', runsWithPlan: 80, dispatchRuns: 40, autoPreflightRuns: 20, approvedPreflightRuns: 10, modelDispatchRuns: 10, successRate: .9, p50ElapsedMs: 1500, p95ElapsedMs: 2200 }] },
  };
}

function harness(metrics: any = fixture()) {
  const innerHTMLWrites: unknown[] = [];
  const requests: Array<{ path: string; options?: any }> = [];
  const mutations: Array<{ path: string; options: any }> = [];
  const prompts: Array<string | null> = [];
  const make = (tagName = 'div', className = '', textContent = ''): any => {
    const node: any = { tagName, className, textContent, children: [], attrs: {}, style: {}, open: false, listeners: {}, parentNode: null,
      appendChild(child: any) { child.parentNode = node; node.children.push(child); return child; },
      replaceChildren() { node.children = []; },
      setAttribute(name: string, value: unknown) { node.attrs[name] = String(value); },
      addEventListener(event: string, callback: (...args: any[]) => unknown) { node.listeners[event] = callback; },
      classList: { add(...classes: string[]) { node.className += ' ' + classes.join(' '); } },
    };
    Object.defineProperty(node, 'innerHTML', { set(value) { innerHTMLWrites.push(value); } });
    return node;
  };
  const root = make();
  const state: any = { operatorMetrics: { metrics }, view: 'operator-metrics' };
  let read: (path: string) => Promise<any> = async () => ({ metrics: state.operatorMetrics.metrics });
  const context = vm.createContext({
    state, make, add: (parent: any, tag: string, cls = '', text = '') => parent.appendChild(make(tag, cls, text)),
    document: { createElementNS: (_namespace: string, tag: string) => make(tag) },
    $: (id: string) => id === 'operatorMetricsContent' ? root : null,
    buildTable: (title: string, headers: string[], rows: string[][]) => Object.assign(make('section', 'panel table-panel', title), { headers, rows }),
    renderLoadPanel: (_root: unknown, title: string, failed: boolean) => root.replaceChildren() || root.appendChild(make('div', failed ? 'error' : 'loading', title)),
    request: (path: string) => { requests.push({ path }); return read(path); },
    loadAll: async () => {}, toast: () => {}, friendlyError: (value: string) => value,
    window: { prompt: () => prompts.shift() ?? null }, apiHeaders: () => ({ 'x-admin-token': 'test-admin' }), base: '/dobs',
    fetch: async (path: string, options: any) => { mutations.push({ path, options }); return { ok: true }; },
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS + '\nglobalThis.hooks={render:renderOperatorMetrics,load:loadOperatorMetrics};', context);
  const hooks = (context as any).hooks;
  const walk = (node = root, visibleOnly = false): any[] => [node, ...(node.tagName === 'details' && !node.open && visibleOnly ? node.children.slice(0, 1) : node.children).flatMap((child: any) => walk(child, visibleOnly))];
  const text = (node = root, visibleOnly = false) => walk(node, visibleOnly).map((item) => item.textContent).join(' ');
  const disclosure = (title: string) => walk().find((node) => node.tagName === 'details' && node.children[0]?.children[0]?.textContent === title);
  hooks.render(root);
  return { root, state, hooks, walk, text, disclosure, innerHTMLWrites, requests, mutations, prompts, setRead: (next: typeof read) => { read = next; } };
}

test('首屏只有三个增长指标和主趋势，所有使用量、成本和调度按需展开', () => {
  const h = harness();
  const cards = h.walk().filter((node) => node.className.split(' ').includes('operator-metrics-kpi'));
  assert.deepEqual(cards.map((node) => node.children[0].textContent), ['新增用户', '用户总数', '日活峰值', '对话次数', 'Agent Run', 'Moss token 消耗']);
  assert.deepEqual(cards.map((node) => node.children[1].textContent), ['42', '4,620', '113', '260', '190', '16,000']);
  const daily = h.disclosure('每日运营明细');
  const usage = h.disclosure('使用量与成本');
  const dispatch = h.disclosure('Agent 调度');
  assert.ok(usage.parentNode.children.indexOf(usage) < usage.parentNode.children.indexOf(daily));
  assert.ok(dispatch.parentNode.children.indexOf(dispatch) < dispatch.parentNode.children.indexOf(daily));
  for (const title of ['使用量与成本', 'Agent 调度', '每日运营明细', '每日调度明细', '指标口径与数据来源']) assert.equal(h.disclosure(title).open, false);
  assert.deepEqual(h.walk(h.root, true).filter((node) => node.className.split(' ').includes('operator-metrics-kpi')).map((node) => node.children[0].textContent), ['新增用户', '用户总数', '日活峰值']);
  assert.equal(h.walk(h.root, true).filter((node) => node.tagName === 'svg').length, 1, '初始首屏只有一张主趋势');
  const growth = h.walk().find((node) => node.id === 'operatorGrowthChart');
  assert.deepEqual(h.walk(growth).filter((node) => node.tagName === 'button').map((node) => node.textContent), ['新增用户', '日活 DAU']);
  assert.doesNotMatch(h.text(h.root, true), /model-a/);
  assert.doesNotMatch(h.text(h.root, true), /调度成功率/);
  assert.doesNotMatch(h.text(h.root, true), /数据新鲜度/);
  usage.open = true;
  usage.listeners.toggle();
  assert.match(h.text(h.root, true), /model-a/);
  assert.match(h.text(h.root, true), /设置单价/);
  assert.equal(usage.id, 'operatorMetricsDetails-usage', '详情入口有稳定的可定位 ID');
  assert.deepEqual(Array.from(daily.children[1].rows[0]), ['10-10', '22', '113', '140', '100', '8,000', '600', '8,600']);
  assert.equal(daily.children[1].rows.length, 2, '折叠保留完整每日数值');
});

test('增长和使用量选择互不干扰，趋势切换和刷新保留详情展开状态', () => {
  const h = harness();
  const daily = h.disclosure('每日运营明细');
  daily.open = true;
  daily.listeners.toggle();
  const usage = h.disclosure('使用量与成本');
  usage.open = true;
  usage.listeners.toggle();
  const dauSeries = h.walk().find((node) => node.tagName === 'button' && node.textContent === '日活 DAU');
  dauSeries.listeners.click();
  const runSeries = h.walk().find((node) => node.tagName === 'button' && node.textContent === 'Agent Run');
  runSeries.listeners.click();
  assert.equal(h.disclosure('每日运营明细').open, true);
  assert.equal(h.disclosure('指标口径与数据来源').open, false);
  assert.match(h.text(), /每日 日活 DAU趋势/);
  assert.match(h.text(), /每日 Agent Run趋势/);
  assert.equal(h.disclosure('使用量与成本').open, true);
  const selected = h.walk().find((node) => node.tagName === 'button' && node.textContent === 'Agent Run');
  assert.equal(selected.attrs['aria-pressed'], 'true');
  h.state.operatorMetrics.metrics.totals.newAccounts = 43;
  h.hooks.render(h.root);
  assert.equal(h.disclosure('每日运营明细').open, true);
  assert.equal(h.disclosure('使用量与成本').open, true);
  assert.match(h.text(), /每日 日活 DAU趋势/);
  assert.match(h.text(), /每日 Agent Run趋势/);
  const open = h.disclosure('每日运营明细');
  open.open = false;
  open.listeners.toggle();
  h.hooks.render(h.root);
  assert.equal(h.disclosure('每日运营明细').open, false);
});

test('数据缺失与接入失败保持可见，不藏进来源或每日明细', async () => {
  const metrics = fixture();
  Object.assign(metrics, { totalAccounts: null, modelTokens: { configured: false }, dispatch: { configured: false } });
  const h = harness(metrics);
  assert.match(h.text(h.root, true), /全量用户总数暂不可用/);
  assert.match(h.text(h.root, true), /模型 token 明细暂不可用/);
  assert.match(h.text(h.root, true), /调度指标暂不可用/);
  assert.equal(h.disclosure('使用量与成本').open, false);
  assert.equal(h.disclosure('Agent 调度').open, false);
  h.state.operatorMetrics = null;
  h.hooks.render(h.root);
  assert.match(h.text(h.root, true), /运营指标暂未接入/);
  h.state.operatorMetrics = { metrics: { ...metrics, daily: [] } };
  h.hooks.render(h.root);
  assert.match(h.text(h.root, true), /当前窗口没有可展示的运营样本/);
  h.setRead(async () => { throw new Error('central_store_unavailable'); });
  await h.hooks.load(true, 7);
  assert.match(h.text(h.root, true), /运营指标加载失败：central_store_unavailable/);
  assert.equal(h.disclosure('每日运营明细'), undefined);
});

test('来源和模型仍以安全文本渲染，设置单价与时间窗口操作保留原 API 约束', async () => {
  const metrics = fixture();
  const hostile = '<img src=x onerror=alert(1)>';
  metrics.sources.accounts = hostile;
  metrics.modelTokens.models[0].model = hostile;
  const h = harness(metrics);
  assert.ok(h.text().includes(hostile));
  assert.deepEqual(h.innerHTMLWrites, []);
  const usage = h.disclosure('使用量与成本');
  usage.open = true;
  usage.listeners.toggle();
  h.prompts.push('model/a', '2', '4');
  const price = h.walk().find((node) => node.tagName === 'button' && node.textContent === '设置单价');
  assert.ok(price, '设置单价在展开的使用量与成本中仍可操作');
  await price.listeners.click();
  const mutation = h.mutations[0];
  assert.equal(mutation.path, '/dobs/api/ops/observability/model-prices/model%2Fa');
  assert.equal(mutation.options.method, 'PUT');
  assert.equal(mutation.options.credentials, 'same-origin');
  assert.equal(mutation.options.headers['x-admin-token'], 'test-admin');
  assert.deepEqual(JSON.parse(mutation.options.body), { inputPerM: 2, outputPerM: 4 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const windowButton = h.walk().find((node) => node.tagName === 'button' && node.textContent === '90 天');
  await windowButton.listeners.click();
  assert.equal(h.requests.at(-1)?.path, '/api/ops/observability/operator-metrics?days=90');
  assert.deepEqual(h.innerHTMLWrites, []);
});

test('模型单价缺失在收起状态仍明确可见，不把未知成本当成零', () => {
  const metrics = fixture();
  metrics.modelTokens.models[0].cost = null;
  metrics.modelTokens.totals.cost = null;
  const h = harness(metrics);
  assert.equal(h.disclosure('使用量与成本').open, false);
  assert.match(h.text(h.root, true), /有模型未配置单价/);
  assert.doesNotMatch(h.text(h.root, true), /0\.00/);
});
