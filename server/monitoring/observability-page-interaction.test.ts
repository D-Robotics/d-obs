/**
 * 页面交互级测试：不引 DOM 框架，用 vm + 手写最小 DOM 桩执行「页面壳实际拼装的
 * 全部脚本」（剥离单个 IIFE 包装后，函数声明成为上下文全局，参数驱动的 render
 * 函数可直接调用；事件处理器通过桩元素真实触发）。
 *
 * 三层保证：
 *  1. 求值即冒烟——真实脚本在 DOM 桩中完整求值不抛错；
 *  2. 渲染结构断言——给定夹具数据，render 函数产出的 DOM 树结构与文案正确；
 *  3. 运行时安全守卫——全流程 innerHTML 零写入（textContent 纪律的运行时证明，
 *     语法测试管不到的动态路径由这条兜住）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_HTML } from './observability-page.js';

function extractScript(): string {
  const blocks = [...OPS_OBSERVABILITY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  return blocks.join('\n');
}

interface StubNode {
  tagName: string;
  children: StubNode[];
  textContent: string;
  value: string;
  type: string;
  href: string;
  id: string;
  title: string;
  disabled: boolean;
  parentNode: StubNode | null;
  attrs: Record<string, string>;
  style: Record<string, unknown>;
  listeners: Record<string, Array<(e?: unknown) => unknown>>;
  appendChild(child: StubNode): StubNode;
  removeChild(child: StubNode): StubNode;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(type: string, fn: (e?: unknown) => unknown): void;
  dispatch(type: string): Promise<void>;
  click(): void;
  focus(): void;
  classList: {
    add(...cs: string[]): void;
    remove(...cs: string[]): void;
    contains(c: string): boolean;
    toggle(c: string, force?: boolean): boolean;
  };
}

interface Harness {
  obs: Record<string, unknown>;
  body: StubNode;
  innerHTMLWrites: string[];
  fetchCalls: Array<{ url: string; method: string; body?: string }>;
  confirmCalls: string[];
  setConfirm(v: boolean): void;
  setJsonResponse(value: unknown): void;
  setIdNull(id: string): void;
  asyncErrors: Error[];
  text(node: StubNode): string;
  all(node: StubNode): StubNode[];
  byClass(node: StubNode, cls: string): StubNode[];
  byIdNode(id: string): StubNode | undefined;
}

function setup(): Harness {
  const innerHTMLWrites: string[] = [];
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
  const confirmCalls: string[] = [];
  let confirmResult = false;
  const asyncErrors: Error[] = [];
  let fetchJson: unknown = {};
  const timers: Array<{ id: number; fn: () => void }> = [];
  let timerSeq = 1;

  const el = (tag: string): StubNode => {
    const classes = new Set<string>();
    const listeners: Record<string, Array<(e?: unknown) => unknown>> = {};
    const node: any = {
      tagName: String(tag).toUpperCase(),
      children: [] as StubNode[],
      textContent: '',
      value: '',
      type: '',
      href: '',
      id: '',
      title: '',
      disabled: false,
      parentNode: null,
      attrs: {} as Record<string, string>,
      style: {} as Record<string, unknown>,
      dataset: {} as Record<string, string>,
      listeners,
      appendChild(child: StubNode) {
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      removeChild(child: StubNode) {
        const i = node.children.indexOf(child);
        if (i >= 0) node.children.splice(i, 1);
        return child;
      },
      replaceChildren(...replacements: StubNode[]) {
        node.children.splice(0, node.children.length, ...replacements);
      },
      remove() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
      setAttribute(k: string, v: string) {
        node.attrs[k] = String(v);
      },
      getAttribute(k: string) {
        return node.attrs[k] ?? null;
      },
      removeAttribute(k: string) {
        delete node.attrs[k];
      },
      querySelector: () => null,
      querySelectorAll: () => [] as StubNode[],
      closest: () => null,
      addEventListener(type: string, fn: (e?: unknown) => unknown) {
        (listeners[type] ||= []).push(fn);
      },
      async dispatch(type: string) {
        for (const fn of listeners[type] ?? []) {
          try {
            await fn({ preventDefault() {}, stopPropagation() {}, target: node });
          } catch (error) {
            asyncErrors.push(error as Error);
          }
        }
      },
      click() {
        void node.dispatch('click');
      },
      focus() {},
    };
    Object.defineProperty(node, 'firstElementChild', {
      get: () => node.children[0] ?? null,
    });
    Object.defineProperty(node, 'className', {
      get: () => [...classes].join(' '),
      set: (v: string) => {
        classes.clear();
        String(v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classes.add(c));
      },
    });
    Object.defineProperty(node, 'classList', {
      get: () => ({
        add: (...cs: string[]) =>
          cs.flatMap((c) => c.split(/\s+/)).forEach((c) => c && classes.add(c)),
        remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
        contains: (c: string) => classes.has(c),
        toggle: (c: string, force?: boolean) => {
          const on = force ?? !classes.has(c);
          if (on) classes.add(c);
          else classes.delete(c);
          return on;
        },
      }),
    });
    Object.defineProperty(node, 'innerHTML', {
      get: () => {
        throw new Error('脚本读取 innerHTML 不在预期内');
      },
      set: (v: string) => {
        innerHTMLWrites.push(String(v).slice(0, 120));
      },
    });
    return node as unknown as StubNode;
  };

  const byId = new Map<string, StubNode>();
  // 惰性挂载的节点（如告警详情抽屉）依赖 getElementById 首查返回 null；
  // 登记到 nullIds 的 id 走真实 null 语义，由脚本自行 create+append。
  const nullIds = new Set<string>();
  const docListeners: Record<string, Array<(e?: unknown) => unknown>> = {};
  const body = el('body');
  const documentStub = {
    createElement: (t: string) => el(t),
    createElementNS: (_ns: string, t: string) => el(t),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    getElementById: (id: string) => {
      if (byId.has(id)) return byId.get(id)!;
      // 动态挂载的节点（如惰性创建的抽屉）先按 id 扫真实树，模拟真实语义。
      const findById = (node: StubNode): StubNode | null => {
        if (node.id === id) return node;
        for (const child of node.children) {
          const found = findById(child);
          if (found) return found;
        }
        return null;
      };
      const attached = findById(body);
      if (attached) {
        byId.set(id, attached);
        return attached;
      }
      if (nullIds.has(id)) return null;
      const created = el('div');
      byId.set(id, created);
      return created;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: (e?: unknown) => unknown) => {
      (docListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    body,
    documentElement: el('html'),
    activeElement: null,
    visibilityState: 'visible',
    title: '',
    execCommand: () => true,
  };

  const storage = new Map<string, string>();
  const context = vm.createContext({
    document: documentStub,
    window: {
      confirm: (msg?: string) => {
        confirmCalls.push(String(msg ?? ''));
        return confirmResult;
      },
      prompt: () => null,
      scrollTo() {},
      addEventListener() {},
    },
    location: { pathname: '/ops-observability', hash: '', href: 'http://x/ops-observability', reload() {} },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({ url: String(url), method: String(init?.method ?? 'GET'), body: String(init?.body ?? '') });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (fetchJson && typeof fetchJson === 'object' ? fetchJson : {}),
        text: async () => '',
      });
    },
    setTimeout: (fn: () => void, ms?: number) => {
      timers.push({ id: timerSeq, fn });
      void ms;
      return timerSeq++;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    history: { pushState() {}, replaceState() {}, back() {}, scrollRestoration: 'auto' },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    console,
    URL,
    crypto: { randomUUID: () => 'test-uuid' },
    navigator: { clipboard: { writeText: async () => {} } },
  });

  // 不剥 IIFE（巨型 script 块是多个 IIFE 拼接）：在主 IIFE 闭合前注入导出钩子，
  // 把参数驱动的 render 函数挂到 globalThis.__obs，闭包内的 state/辅助函数保持原样。
  const src = (() => {
    const s = extractScript().trim();
    assert.ok(s.endsWith('})();'), '脚本块应以 IIFE 闭合结尾');
    const hook =
      ";globalThis.__obs={" +
      "renderActionCenter:typeof renderActionCenter!=='undefined'?renderActionCenter:null," +
      "renderMaintenancePanel:typeof renderMaintenancePanel!=='undefined'?renderMaintenancePanel:null," +
      "setView:typeof setView!=='undefined'?setView:null," +
      "consumePendingAlertDetail:typeof consumePendingAlertDetail!=='undefined'?consumePendingAlertDetail:null," +
      "renderLearningModules:typeof renderLearningModules!=='undefined'?renderLearningModules:null," +
      "renderOperatorMetrics:typeof renderOperatorMetrics!=='undefined'?renderOperatorMetrics:null," +
      "resolveViewRequest:typeof resolveViewRequest!=='undefined'?resolveViewRequest:null," +
      "renderSettings:typeof renderSettings!=='undefined'?renderSettings:null," +
      "renderModelPool:typeof renderModelPool!=='undefined'?renderModelPool:null," +
      "renderBoardPanels:typeof renderBoardPanels!=='undefined'?renderBoardPanels:null," +
      "renderObjects:typeof renderObjects!=='undefined'?renderObjects:null," +
      "setObsState:(patch)=>Object.assign(state,patch)," +
      "getObsState:()=>state" +
      "};})();";
    return s.slice(0, -'})();'.length) + hook;
  })();
  vm.runInContext(src, context, { timeout: 10_000 });
  const obs = (context as { __obs?: Record<string, unknown> }).__obs ?? {};
  assert.equal(typeof obs.renderActionCenter, 'function', '主 IIFE 内应能取到 renderActionCenter');
  assert.equal(typeof obs.renderMaintenancePanel, 'function', '主 IIFE 内应能取到 renderMaintenancePanel');

  const text = (node: StubNode): string =>
    (node.textContent ?? '') + (node.children ?? []).map((c) => text(c)).join('');
  const all = (node: StubNode): StubNode[] =>
    [node, ...(node.children ?? []).flatMap((c) => all(c))];
  const byClass = (node: StubNode, cls: string): StubNode[] =>
    all(node).filter((n) => n.classList && n.classList.contains(cls));

  return {
    obs,
    body: body as unknown as StubNode,
    innerHTMLWrites,
    fetchCalls,
    confirmCalls,
    setConfirm: (v: boolean) => {
      confirmResult = v;
    },
    setJsonResponse: (value: unknown) => {
      fetchJson = value;
    },
    setIdNull: (id: string) => {
      nullIds.add(id);
    },
    asyncErrors,
    text,
    all,
    byClass,
    byIdNode: (id: string): StubNode | undefined => byId.get(id),
  };
}

const OVERVIEW_FIXTURE = {
  incidents: [
    { status: 'open', severity: 'critical', title: '数据库连接池耗尽' },
  ],
  alerting: { shadowMode: true, webhookConfigured: false },
  summary: { disabledChecks: 2 },
  evolution: { lastStatus: 'ok', lastSummary: '' },
};

const MODEL_POOL_FIXTURE = {
  ok: true,
  protectedFrontendModel: 'agent-main',
  health: {
    now: '2026-09-21T08:00:00Z',
    summary: { totalTargets: 3, healthy: 1 },
    targets: [
      { baseUrl: 'https://api.example.com/v1', model: 'deepseek-flash', label: 'Example primary', credentialFingerprint: 'abc123f…7890', frontendModels: ['qwen3.6-plus'], roles: ['primary'], state: 'healthy', attempts: 900, successes: 855, failures: 45, successRate: 0.95, latencyP95Ms: 1200, inFlight: 2, maxInFlight: 20 },
      { baseUrl: 'https://api.minimax.example.com/v1', model: 'MiniMax-M3', label: 'MiniMax backup', frontendModels: ['moss'], roles: ['primary'], state: 'cooldown', attempts: 100, successes: 60, failures: 40, successRate: 0.6, latencyP95Ms: 5900, inFlight: 0, maxInFlight: 10, lastHealthError: 'quota_or_limit' },
      { baseUrl: 'https://orphan.example.com/v1', model: 'unused-model', state: 'unknown' },
    ],
  },
  config: {
    modelMapping: {
      'qwen3.6-plus': { baseUrl: 'https://api.example.com/v1', model: 'deepseek-flash', label: 'Example primary', weight: 100, fallbacks: ['moss'] },
      moss: { baseUrl: 'https://api.minimax.example.com/v1', model: 'MiniMax-M3', label: 'MiniMax backup', fallbacks: [] },
      'agent-main': { baseUrl: 'https://api.example.com/v1', model: 'deepseek-flash', weight: 10, fallbacks: ['qwen3.6-plus'] },
    },
  },
};

test('页面脚本在 DOM 桩中完整求值：render 函数成为可调用全局', () => {
  const h = setup();
  assert.equal(typeof h.obs.renderActionCenter, 'function');
  assert.equal(typeof h.obs.renderMaintenancePanel, 'function');
  assert.equal(h.innerHTMLWrites.length, 0, '求值阶段不得写 innerHTML');
});

test('两级路由：旧 hash 别名规范化为 视图/子模块，未知视图回落总览', () => {
  const h = setup();
  const resolve = h.obs.resolveViewRequest as (r: string) => Record<string, string>;
  assert.equal(typeof resolve, 'function', '应能取到 resolveViewRequest');
  const canon = (r: string) => JSON.stringify(resolve(r));
  assert.equal(canon('model-pool'), JSON.stringify({ name: 'platform', child: 'model-pool', source: 'platform/model-pool' }));
  assert.equal(canon('settings/probing'), JSON.stringify({ name: 'platform', child: 'probing', source: 'platform/probing' }));
  assert.equal(canon('platform'), JSON.stringify({ name: 'platform', child: 'general', source: 'platform/general' }));
  assert.equal(canon('alerts'), JSON.stringify({ name: 'alerts', child: 'rules', source: 'alerts/rules' }));
  assert.equal(canon('alerts/channels'), JSON.stringify({ name: 'alerts', child: 'channels', source: 'alerts/channels' }));
  assert.equal(canon('agent-traces'), JSON.stringify({ name: 'traces', child: 'agent', source: 'traces/agent' }));
  assert.equal(canon('session-traces'), JSON.stringify({ name: 'traces', child: 'session', source: 'traces/session' }));
  assert.equal(canon('signals'), JSON.stringify({ name: 'signals', child: 'metrics', source: 'signals/metrics' }));
  const setView = h.obs.setView as (r: string, u?: boolean) => unknown;
  setView('bogus/whatever', false);
  assert.equal((h.obs.getObsState as () => Record<string, unknown>)().view, 'overview', '未知视图回落总览');
});

test('告警深链 #alert=<key>：定位告警视图并打开详情抽屉，未知键回落列表', () => {
  const h = setup();
  const obs = h.obs;
  const consume = obs.consumePendingAlertDetail as () => void;
  assert.equal(typeof consume, 'function', '应能取到 consumePendingAlertDetail');
  const state = obs.getObsState as () => Record<string, unknown>;
  h.setIdNull('alertDetailDrawer');
  (obs.setObsState as (p: Record<string, unknown>) => unknown)({
    pendingAlertDetail: 'nginx-5xx-log',
    config: {
      definitions: [{ key: 'nginx-5xx-log', category: 'log', title: 'Nginx 5xx 日志异常' }],
      rules: {
        'nginx-5xx-log': {
          enabled: true,
          windowMinutes: 5,
          threshold: 3,
          criticalThreshold: 10,
          minSamples: 1,
          openAfter: 2,
          resolveAfter: 2,
          notificationChannel: 'default',
          createdAt: '2026-09-24T00:00:00Z',
        },
      },
      objects: null,
      global: {
        enabled: true,
        environmentLabel: 'production / 47110',
        autoRemediation: false,
        remediationCooldownMinutes: 10,
        remindersEnabled: false,
        notifyOnRecovery: true,
        cooldownMinutes: 30,
        maxNotificationsPerHour: 20,
      },
      notification: {
        channel: 'feishu',
        channels: [],
        enabled: true,
        shadowMode: false,
        minSeverity: 'warning',
        criticalChannel: '',
        warningChannel: '',
      },
    },
  });
  h.setJsonResponse({ ok: true, objects: [] });
  consume();
  assert.equal(state().view, 'alerts', '深链应定位到告警视图');
  assert.equal(state().pendingAlertDetail, null, '深链待办应被消费');
  const drawer = h.all(h.body).find((n) => n.id === 'alertDetailDrawer');
  assert.ok(drawer, '详情抽屉应挂载到 body');
  assert.ok(drawer!.classList.contains('open'), '抽屉应处于打开状态');
  assert.ok(h.text(drawer!).includes('Nginx 5xx 日志异常'), '抽屉标题应为命中策略');

  // 未知键（如租户命名空间探针）：回落到告警策略列表，不打开抽屉。
  (obs.setObsState as (p: Record<string, unknown>) => unknown)({
    pendingAlertDetail: 't.acme.probe-login',
  });
  consume();
  assert.equal(state().view, 'alerts');
  assert.equal(state().pendingAlertDetail, null);
  assert.ok(!drawer!.classList.contains('open'), '未知键不得打开详情抽屉');
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('Skill 闭环明细：拓扑下渲染待审候选与已发布 Skill 两张真实条目表', () => {
  const h = setup();
  const obs = h.obs;
  assert.equal(
    typeof obs.renderLearningModules, 'function', '应能取到 renderLearningModules');
  const flywheel = {
    skillHitRate: 0.747,
    reviewPending: 429,
    storePublished: 6,
    storeInstalls: 4,
    runsWithRetry: 440,
    lifecycle: {
      candidateWritten: 62,
      shadowStarted: 1,
      canaryStarted: 0,
      canaryPassed: 0,
      personalPromoted: 0,
      publicApproved: 0,
    },
    reviewQueueRecent: [
      {
        name: '已验证：修复电源监测页面没有BPU电压的问题',
        category: 'auto_distilled',
        source: 'auto_distilled',
        aiScore: 40,
        submittedAt: '2026-09-24T06:09:55Z',
      },
    ],
    storeRecent: [
      {
        name: 'MagicBox 情感陪伴 demo 儿童展示提示词设计',
        category: 'MagicBox',
        authorName: null,
        installs: 0,
        publishedAt: '2026-08-05T23:15:33Z',
      },
    ],
  };
  const payload = (flywheelPatch: Record<string, unknown>) => ({
    learning: {
      generatedAt: '2026-09-24T08:10:13Z',
      skill: {
        status: 'ok',
        overview: { windowDays: 30, flywheel: { ...flywheel, ...flywheelPatch }, dataHealth: {} },
      },
    },
  });
  (obs.setObsState as (p: Record<string, unknown>) => unknown)({ learning: payload({}) });
  (obs.renderLearningModules as () => void)();
  const root = h.byIdNode('skillLoopContent');
  assert.ok(root, 'skillLoopContent 容器应已渲染');
  const text = h.text(root);
  assert.ok(text.includes('闭环明细'), '应存在闭环明细区');
  assert.ok(text.includes('待人工审核候选 · 最近 1 条'), '待审明细表应带条数');
  assert.ok(text.includes('修复电源监测页面没有BPU电压的问题'), '待审候选名应渲染');
  assert.ok(text.includes('已发布 Skill · 最近 1 条'), '商店明细表应带条数');
  assert.ok(text.includes('MagicBox 情感陪伴 demo 儿童展示提示词设计'), '已发布名称应渲染');
  assert.ok(text.includes('40'), 'AI 分应渲染');

  // 台账表缺失（null）：如实显示暂不可用，不冒充空队列。
  (obs.setObsState as (p: Record<string, unknown>) => unknown)({
    learning: payload({ reviewQueueRecent: null, storeRecent: null }),
  });
  (obs.renderLearningModules as () => void)();
  const degraded = h.text(root);
  assert.ok(degraded.includes('待审明细暂不可用'), '待审明细缺失应有明确降级文案');
  assert.ok(degraded.includes('商店明细暂不可用'), '商店明细缺失应有明确降级文案');
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('运营指标折线图：日序列渲染 SVG 折线与数据点，系列切换复用同一图表', async () => {
  const h = setup();
  const obs = h.obs;
  const render = obs.renderOperatorMetrics as (root: StubNode) => void;
  assert.equal(typeof render, 'function', '应能取到 renderOperatorMetrics');
  const daily = Array.from({ length: 7 }, (_, i) => ({
    day: '2026-09-' + String(18 + i).padStart(2, '0'),
    newAccounts: 40 + i,
    activeUsers: 1000 + i * 10,
    conversations: 300 + i,
    runs: 260 + i,
    promptTokens: 1_000_000 * (i + 1),
    completionTokens: 50_000,
    totalTokens: 1_050_000 * (i + 1),
  }));
  const metricsFixture = {
    ok: true,
    metrics: {
      windowDays: 7,
      totals: {
        totalTokens: daily.reduce((s, r) => s + r.totalTokens, 0),
        promptTokens: daily.reduce((s, r) => s + r.promptTokens, 0),
        completionTokens: daily.reduce((s, r) => s + r.completionTokens, 0),
        newAccounts: 280,
        conversations: 2100,
        runs: 1820,
        activeUsersPeak: 1060,
      },
      sources: {},
      daily,
    },
  };
  h.setJsonResponse(metricsFixture);
  (obs.setView as (r: string, u?: boolean) => unknown)('operator-metrics', false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const root = h.byIdNode('operatorMetricsContent');
  assert.ok(root, 'operatorMetricsContent 容器应存在');
  render(root!);
  const text = h.text(root);
  assert.ok(text.includes('每日 token 消耗趋势'), '默认系列应为 token 消耗');
  const chart = h.all(root).find((n) => String(n.attrs?.['class'] ?? '').includes('omc-chart-svg'));
  assert.ok(chart, '应渲染折线图 SVG');
  const dots = h.all(chart).filter((n) => n.tagName.toUpperCase() === 'CIRCLE');
  assert.equal(dots.length, 7, '7 天应渲染 7 个数据点');
  assert.ok(dots[0].children.some((c) => (c as { textContent?: string }).textContent?.includes('2026-09-18')), '数据点悬停应含完整日期');
  assert.ok(text.includes('万'), '坐标轴应使用紧凑数量级');
  const lastTip = dots[6].children.find((c) => (c as { textContent?: string }).textContent?.includes('7,350,000'));
  assert.ok(lastTip, '末位数据点悬停应含当日精确 token 值');

  // 切换系列：同一 SVG 容器改画新增用户，标题与点位同步。
  const userButton = h.all(root).find((n) => n.tagName === 'BUTTON' && n.textContent === '新增用户');
  assert.ok(userButton, '应存在系列切换按钮');
  await (userButton as StubNode).dispatch('click');
  const textAfter = h.text(root);
  assert.ok(textAfter.includes('每日 新增用户趋势'), '切换后标题应为新增用户');
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('系统设置子模块：setView 记录子模块，renderSettings 分发四张配置卡', () => {
  const h = setup();
  const state = h.obs.getObsState as () => Record<string, unknown>;
  (h.obs.setView as (r: string, u?: boolean) => unknown)('platform/heal', false);
  assert.equal(state().view, 'platform');
  assert.equal(state().viewChild, 'heal');
  assert.equal(state().viewSource, 'platform/heal');
  (h.obs.setObsState as (p: Record<string, unknown>) => unknown)({
    config: {
      global: { enabled: true, environmentLabel: 'production / test', autoRemediation: false, remediationCooldownMinutes: 10 },
      synthetic: { intervalMinutes: 15, username: 'canary', passwordConfigured: true },
      logSignatures: { application: ['SyntaxError'], postgres: ['FATAL:'] },
      unmanagedRuleKeys: [],
      defaultOnlyRuleKeys: [],
      configFilePresent: true,
    },
  });
  (h.obs.renderSettings as () => void)();
  for (const id of ['settingsContentGeneral', 'settingsContentProbing', 'settingsContentLogs', 'settingsContentHeal']) {
    const node = h.byIdNode(id);
    assert.ok(node, `容器 ${id} 应存在`);
    assert.ok(
      h.byClass(node as StubNode, 'settings-card').length === 1,
      `容器 ${id} 应恰好渲染一张配置卡`,
    );
  }
  const paneInputs: Record<string, string> = {
    settingsContentGeneral: 'globalEnabled',
    settingsContentProbing: 'syntheticUser',
    settingsContentLogs: 'appSignatures',
    settingsContentHeal: 'autoRemediation',
  };
  for (const [paneId, inputId] of Object.entries(paneInputs)) {
    const pane = h.byIdNode(paneId);
    assert.ok(pane, `容器 ${paneId} 应存在`);
    const found = h
      .all(pane as StubNode)
      .find((n) => (n as unknown as { id?: string }).id === inputId || n.attrs?.id === inputId);
    assert.ok(found, `配置控件 ${inputId} 应渲染在 ${paneId} 子树内`);
  }
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('行动中心：critical 事故 + 影子模式渲染两条待办与 CTA', () => {
  const h = setup();
  const panel = (h.obs.renderActionCenter as (o: unknown) => StubNode)(OVERVIEW_FIXTURE);
  const items = h.byClass(panel, 'remediate-item');
  assert.ok(items.length >= 2, `预期 ≥2 条待办，实际 ${items.length}`);
  const text = h.text(panel);
  assert.ok(text.includes('个生产事故待处置'), '事故待办标题');
  assert.ok(text.includes('影子模式'), '影子模式提醒');
  const links = h.all(panel).filter((n) => n.href === '#overview');
  assert.ok(links.length >= 1, 'CTA 链接指向工作台锚点');
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('行动中心：空数据渲染空态文案', () => {
  const h = setup();
  const panel = (h.obs.renderActionCenter as (o: unknown) => StubNode)({
    incidents: [],
    alerting: { shadowMode: false, webhookConfigured: true },
    summary: { disabledChecks: 0 },
    evolution: { lastStatus: 'ok' },
  });
  assert.ok(h.text(panel).includes('当前没有需要运营介入的事项'));
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('维护窗口：渲染字段走 textContent，删除交互经过 confirm 与 DELETE 请求', async () => {
  const h = setup();
  const panel = (h.obs.renderMaintenancePanel as (o: unknown) => StubNode)({
    maintenanceWindows: [
      {
        id: 7,
        active: true,
        scope: 'rule',
        alertKey: 'api-5xx',
        reason: '数据库计划升级',
        startsAt: '2026-09-20T10:00:00Z',
        endsAt: '2026-09-20T12:00:00Z',
        createdBy: 'ops-1',
      },
    ],
  });
  const text = h.text(panel);
  assert.ok(text.includes('api-5xx'), '规则键渲染');
  assert.ok(text.includes('数据库计划升级'), '维护原因渲染');
  assert.ok(text.includes('创建人 ops-1'), '创建人渲染');

  const del = h.all(panel).find((n) => n.tagName === 'BUTTON' && n.textContent === '删除');
  assert.ok(del, '存在删除按钮');

  // confirm=false：确认被拒绝，不发请求。
  h.setConfirm(false);
  await del.dispatch('click');
  assert.equal(h.confirmCalls.length, 1, '删除前必须弹确认');
  assert.equal(h.fetchCalls.filter((c) => c.method === 'DELETE').length, 0, '拒绝后无请求');

  // confirm=true：发出 DELETE 且带上动作守卫头的要求由 request() 承担。
  h.setConfirm(true);
  await del.dispatch('click');
  assert.ok(
    h.fetchCalls.some((c) => c.method === 'DELETE' && c.url.includes('/maintenance-windows/7')),
    `DELETE URL 应包含窗口 id：${JSON.stringify(h.fetchCalls)}`,
  );
  assert.equal(h.innerHTMLWrites.length, 0);
});

test('模型池：拓扑与指标条按真实夹具渲染，保存权重走 PUT 并受校验拦截', async () => {
  const h = setup();
  const obs = h.obs;
  assert.equal(typeof obs.renderModelPool, 'function', '应能取到 renderModelPool');
  (obs.setObsState as (p: Record<string, unknown>) => unknown)({ modelPool: MODEL_POOL_FIXTURE });
  (obs.renderModelPool as () => void)();
  const root = h.byIdNode('modelPoolContent');
  assert.ok(root, 'modelPoolContent 应已渲染');

  const svg = h.all(root as StubNode).find((n) => String(n.attrs?.['class'] ?? '') === 'mp-topo-svg');
  assert.ok(svg, '应渲染路由拓扑 SVG');
  const svgNodes = h.all(svg as StubNode);
  assert.equal(svgNodes.filter((n) => n.attrs && n.attrs['data-route']).length, 3, '左侧应渲染 3 条业务路由');
  assert.equal(
    svgNodes.filter((n) => String(n.attrs?.['class'] ?? '').includes('mp-edge-primary')).length,
    3,
    '每条路由应有一条主目标实线',
  );
  assert.equal(
    svgNodes.filter((n) => String(n.attrs?.['class'] ?? '').includes('mp-edge-fallback')).length,
    2,
    'qwen→moss 与 agent-main→qwen 应各有一条虚线',
  );
  assert.ok(svgNodes.some((n) => n.textContent === '权重 100'), '权重标签应随线宽展示');
  assert.ok(
    svgNodes.some((n) => String(n.attrs?.['class'] ?? '').includes('mp-state-cooldown')),
    '冷却目标应有状态点着色',
  );

  const rows = h.all(root as StubNode).filter((n) => n.tagName === 'TR');
  assert.equal(rows.length, 4, '表头 + 3 个目标行');
  const pageText = h.text(root as StubNode);
  assert.ok(pageText.includes('900 次'), '调用量渲染');
  assert.ok(pageText.includes('成功 855 · 失败 45'), '成功失败拆分渲染');
  assert.ok(pageText.includes('95.0%'), '成功率渲染');
  assert.ok(pageText.includes('2 / 20'), '并发渲染');
  const fills = h.byClass(root as StubNode, 'mp-bar-fill');
  assert.ok(fills.some((n) => n.style.width === '90.0%'), '主力目标流量占比 90%');
  assert.ok(
    h.byClass(root as StubNode, 'mp-bar-good').length >= 1 && h.byClass(root as StubNode, 'mp-bar-bad').length >= 1,
    '成功率条按阈值变色',
  );

  const editorRows = h.byClass(root as StubNode, 'mp-route-row');
  assert.equal(editorRows.length, 3, '每条映射一行编辑器');
  const qwenRow = editorRows.find((r) => r.id === 'mp-route-qwen3_6-plus');
  assert.ok(qwenRow, '路由行 id 供拓扑点击定位');
  const lockedRow = editorRows.find((r) => r.classList.contains('locked'));
  assert.ok(lockedRow, 'agent-main 应渲染为锁定行');
  assert.ok(h.text(lockedRow as StubNode).includes('受保护'), '锁定行说明文案');

  const weightInput = h.all(qwenRow as StubNode).find((n) => n.tagName === 'INPUT' && n.type === 'number');
  assert.ok(weightInput, '权重输入框存在');
  assert.equal(weightInput!.value, '100', '权重预填当前值');
  const saveBtn = h.all(qwenRow as StubNode).find((n) => n.tagName === 'BUTTON');
  assert.ok(saveBtn, '保存按钮存在');

  weightInput!.value = '2000';
  await (saveBtn as StubNode).dispatch('click');
  assert.equal(h.fetchCalls.filter((c) => c.method === 'PUT').length, 0, '非法权重不得发请求');
  assert.ok(h.text(qwenRow as StubNode).includes('0-1000'), '校验反馈');

  h.setJsonResponse({ ok: true });
  weightInput!.value = '80';
  await (saveBtn as StubNode).dispatch('click');
  const put = h.fetchCalls.find((c) => c.method === 'PUT' && c.url.includes('/model-pool/routing'));
  assert.ok(put, '保存应发出 PUT /model-pool/routing');
  assert.ok(String(put?.body).includes('"frontendModel":"qwen3.6-plus"'), 'PUT body 带路由名');
  assert.ok(String(put?.body).includes('"weight":80'), 'PUT body 带新权重');

  assert.equal(h.innerHTMLWrites.length, 0, '全程不得写 innerHTML');
  assert.deepEqual(h.asyncErrors, [], '交互过程不得产生未捕获异常');
});

test('全局守卫：全部交互完成后 innerHTML 写入数仍为 0', () => {
  const h = setup();
  (h.obs.renderActionCenter as (o: unknown) => StubNode)(OVERVIEW_FIXTURE);
  (h.obs.renderMaintenancePanel as (o: unknown) => StubNode)({ maintenanceWindows: [] });
  (h.obs.setObsState as (p: Record<string, unknown>) => unknown)({ modelPool: MODEL_POOL_FIXTURE });
  (h.obs.renderModelPool as () => void)();
  assert.equal(h.innerHTMLWrites.length, 0, `发现 innerHTML 写入：${h.innerHTMLWrites.join(' | ')}`);
  assert.deepEqual(h.asyncErrors, [], '交互过程中不得产生未捕获异常');
});

test('看板：复合路由、工具条渲染、面板卡片、服务变量与删除面板的 PUT 持久化', async () => {
  const h = setup();
  const resolve = h.obs.resolveViewRequest as (r: string) => Record<string, string>;
  assert.equal(
    JSON.stringify(resolve('signals/panels')),
    JSON.stringify({ name: 'signals', child: 'panels', source: 'signals/panels' }),
    '看板复合路由应直达子页签',
  );

  const fixture = {
    id: 'b1',
    name: '回归看板',
    position: 0,
    spec: {
      windowMinutes: 60,
      range: null,
      filters: null,
      panels: [
        { title: 'P1', metric: 'm.one', windowMinutes: null, chart: 'line', width: 1, warnValue: null, critValue: null },
        { title: 'P2', metric: 'm.two', windowMinutes: 60, chart: 'stat', width: 2, warnValue: null, critValue: null },
      ],
    },
  };
  h.setJsonResponse({ ok: true, boards: [fixture] });
  (h.obs.setView as (r: string, u?: boolean) => unknown)('signals/panels', false);
  await new Promise((r) => setTimeout(r, 0));
  (h.obs.renderBoardPanels as () => void)();

  const grid = h.byIdNode('signalsPanelGrid');
  assert.ok(grid, '看板网格容器应存在');
  const cards = h.byClass(grid, 'signals-panel-card');
  assert.equal(cards.length, 2, '应渲染两张面板卡片');
  assert.equal(h.byClass(cards[0], 'panel-time-select').length, 1, '面板头部应有时间选择');

  const svc = h.byIdNode('boardServiceFilter');
  svc!.value = 'svc-a';
  await svc!.dispatch('change');
  const putWithFilters = [...h.fetchCalls].reverse().find((c) => c.method === 'PUT' && c.url.includes('/boards/b1'));
  assert.ok(putWithFilters, '服务变量变更应触发看板 PUT');
  assert.match(putWithFilters!.body!, /"filters":\{"service":"svc-a"\}/);

  const del = h.byClass(cards[0], 'panel-actions')[0].children.find((c) => c.textContent === '删除');
  await del!.dispatch('click');
  const modal = h.byClass(h.body, 'board-modal')[0];
  assert.ok(modal, '删除应弹出确认弹窗');
  const modalDel = h.all(modal).find((n) => n.textContent === '删除' && n.tagName === 'BUTTON');
  assert.ok(modalDel, '确认弹窗应有删除按钮');
  await modalDel!.dispatch('click');
  const putAfterDelete = [...h.fetchCalls].reverse().find((c) => c.method === 'PUT' && c.url.includes('/boards/b1'));
  const body = JSON.parse(putAfterDelete!.body!);
  assert.equal(body.spec.panels.length, 1, '删除面板后 spec 应只剩一张');
  assert.equal(body.spec.panels[0].title, 'P2');
});

test('告警对象：本机数据源聚合为服务器身份，扩展层渲染不得中断数据装载', async () => {
  const h = setup();
  const definitions = [
    { key: 'node-cpu-load', category: 'metric', title: 'CPU 负载' },
    { key: 'internal-health', category: 'health', title: '内部健康' },
    { key: 'nginx-5xx-log', category: 'log', title: 'Nginx 5xx' },
  ];
  const overview = {
    incidents: [],
    checks: [{ key: 'node-cpu-load', category: 'metric', checkedAt: '2026-09-24T10:00:00Z', status: 'ok' }],
  };
  (h.obs.setObsState as (p: Record<string, unknown>) => unknown)({ config: { definitions }, overview, objects: null });
  h.setJsonResponse({ ok: true, objects: [] });

  const renderObjects = h.obs.renderObjects as () => void;
  assert.equal(typeof renderObjects, 'function', 'renderObjects 应可从钩子取得');
  renderObjects();

  const root = h.byIdNode('objectsContent');
  assert.ok(root, '对象容器应存在');
  const layerNodes = h.all(root).filter((n) => n.getAttribute('data-alert-objects-layer') === '1');
  assert.equal(layerNodes.length, 1, '扩展层应渲染且只渲染一份');

  const tableText = h.text(root);
  assert.ok(tableText.includes('服务器 · 本机'), '本机指标/systemd 数据源应聚合为服务器身份');
  assert.ok(tableText.includes('网关'), 'Nginx 数据源应归入网关分类');
  assert.ok(tableText.includes('2 条规则'), '两个本机数据源应聚合到同一服务器对象');

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.asyncErrors, [], '渲染与注册表读取不得产生未捕获异常');
});
