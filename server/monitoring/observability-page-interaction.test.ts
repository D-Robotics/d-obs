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
  innerHTMLWrites: string[];
  fetchCalls: Array<{ url: string; method: string }>;
  confirmCalls: string[];
  setConfirm(v: boolean): void;
  asyncErrors: Error[];
  text(node: StubNode): string;
  all(node: StubNode): StubNode[];
  byClass(node: StubNode, cls: string): StubNode[];
}

function setup(): Harness {
  const innerHTMLWrites: string[] = [];
  const fetchCalls: Array<{ url: string; method: string }> = [];
  const confirmCalls: string[] = [];
  let confirmResult = false;
  const asyncErrors: Error[] = [];
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
  const docListeners: Record<string, Array<(e?: unknown) => unknown>> = {};
  const body = el('body');
  const documentStub = {
    createElement: (t: string) => el(t),
    createElementNS: (_ns: string, t: string) => el(t),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, el('div'));
      return byId.get(id)!;
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
    fetch: (url: string, init?: { method?: string }) => {
      fetchCalls.push({ url: String(url), method: String(init?.method ?? 'GET') });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
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
      "renderMaintenancePanel:typeof renderMaintenancePanel!=='undefined'?renderMaintenancePanel:null" +
      "};})();";
    return s.slice(0, -'})();'.length) + hook;
  })();
  vm.runInContext(src, context, { timeout: 10_000 });
  const obs = (context as { __obs?: Record<string, unknown> }).__obs ?? {};
  assert.equal(typeof obs.renderActionCenter, 'function', '主 IIFE 内应能取到 renderActionCenter');
  assert.equal(typeof obs.renderMaintenancePanel, 'function', '主 IIFE 内应能取到 renderMaintenancePanel');

  const text = (node: StubNode): string =>
    (node.textContent ?? '') + node.children.map((c) => text(c)).join('');
  const all = (node: StubNode): StubNode[] =>
    [node, ...node.children.flatMap((c) => all(c))];
  const byClass = (node: StubNode, cls: string): StubNode[] =>
    all(node).filter((n) => n.classList.contains(cls));

  return {
    obs,
    innerHTMLWrites,
    fetchCalls,
    confirmCalls,
    setConfirm: (v: boolean) => {
      confirmResult = v;
    },
    asyncErrors,
    text,
    all,
    byClass,
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

test('页面脚本在 DOM 桩中完整求值：render 函数成为可调用全局', () => {
  const h = setup();
  assert.equal(typeof h.obs.renderActionCenter, 'function');
  assert.equal(typeof h.obs.renderMaintenancePanel, 'function');
  assert.equal(h.innerHTMLWrites.length, 0, '求值阶段不得写 innerHTML');
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

test('全局守卫：全部交互完成后 innerHTML 写入数仍为 0', () => {
  const h = setup();
  (h.obs.renderActionCenter as (o: unknown) => StubNode)(OVERVIEW_FIXTURE);
  (h.obs.renderMaintenancePanel as (o: unknown) => StubNode)({ maintenanceWindows: [] });
  assert.equal(h.innerHTMLWrites.length, 0, `发现 innerHTML 写入：${h.innerHTMLWrites.join(' | ')}`);
  assert.deepEqual(h.asyncErrors, [], '交互过程中不得产生未捕获异常');
});
