/**
 * OpsUI 组件层行为回归（observability-page-ui.ts）：
 * 用 vm + 最小 DOM 桩执行「页面实际拼装的组件脚本」，覆盖对话框开关通道
 * （Esc / 遮罩 / 焦点圈定 / 滚动锁计数 / 嵌套栈）、toast 播报语义与暂停、
 * 异步状态角色切换、表格可访问性补齐。结构断言面向行为契约，不测 CSS 几何。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';

interface StubNode {
  tagName: string;
  children: StubNode[];
  parentNode: StubNode | null;
  attrs: Record<string, string>;
  listeners: Record<string, Array<(event?: unknown) => unknown>>;
  queryList: StubNode[] | null;
  textContent: string;
  className: string;
  id: string;
  type: string;
  disabled: boolean;
  focusCalls: number;
  opsui?: unknown;
  appendChild(child: StubNode): StubNode;
  replaceChildren(...nodes: StubNode[]): void;
  removeChild(child: StubNode): StubNode;
  remove(): void;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  removeAttribute(key: string): void;
  addEventListener(type: string, listener: (event?: unknown) => unknown): void;
  dispatch(type: string, event?: unknown): Promise<void>;
  focus(): void;
  querySelectorAll(): StubNode[];
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
  };
}

// document.activeElement 的桩：焦点语义是组件层行为契约的一部分。
let activeStub: StubNode | null = null;

function el(tag: string): StubNode {
  const classes = new Set<string>();
  const node: any = {
    tagName: String(tag).toUpperCase(),
    children: [] as StubNode[],
    parentNode: null,
    attrs: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(event?: unknown) => unknown>>,
    queryList: null,
    textContent: '',
    className: '',
    id: '',
    type: '',
    disabled: false,
    focusCalls: 0,
    appendChild(child: StubNode) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    replaceChildren(...replacements: StubNode[]) {
      node.children.splice(0, node.children.length, ...replacements);
    },
    removeChild(child: StubNode) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    setAttribute(key: string, value: string) {
      node.attrs[key] = String(value);
    },
    getAttribute(key: string) {
      return node.attrs[key] ?? null;
    },
    removeAttribute(key: string) {
      delete node.attrs[key];
    },
    addEventListener(type: string, listener: (event?: unknown) => unknown) {
      (node.listeners[type] ||= []).push(listener);
    },
    async dispatch(type: string, event: unknown = {}) {
      for (const listener of node.listeners[type] ?? []) {
        await listener({ preventDefault() {}, stopPropagation() {}, target: node, ...(event as Record<string, unknown>) });
      }
    },
    focus() {
      node.focusCalls += 1;
      activeStub = node;
    },
    querySelectorAll() {
      return node.queryList ?? [];
    },
  };
  Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] ?? null });
  // className 与 classList 同步：页面脚本两种写法都用，桩必须保持同一份状态。
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (value: string) => {
      classes.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    },
  });
  Object.defineProperty(node, 'classList', {
    get: () => ({
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    }),
  });
  return node as StubNode;
}

function setup() {
  activeStub = null;
  const ids = new Map<string, StubNode>();
  // 页面壳静态包含 #toast；桩同样预先挂载，保持一致。
  const toastShell = el('div');
  toastShell.id = 'toast';
  ids.set('toast', toastShell);
  const docListeners: Record<string, Array<(event?: unknown) => unknown>> = {};
  const timers: Array<{ delay: number; fired: boolean }> = [];
  const removedTimers: unknown[] = [];
  const body = el('body');
  const documentStub = {
    body,
    documentElement: el('html'),
    createElement: (tag: string) => el(tag),
    getElementById: (id: string) => {
      if (!ids.has(id)) {
        const created = el('div');
        created.id = id;
        ids.set(id, created);
      }
      return ids.get(id)!;
    },
    addEventListener: (type: string, listener: (event?: unknown) => unknown) => {
      (docListeners[type] ||= []).push(listener);
    },
    removeEventListener(type: string, listener: (event?: unknown) => unknown) {
      docListeners[type] = (docListeners[type] ?? []).filter((item) => item !== listener);
    },
    execCommand: () => true,
  };
  const context = vm.createContext({
    document: documentStub,
    Date,
    setTimeout: (fn: () => void, delay: number) => {
      const timer = { delay, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      removedTimers.push(timer);
    },
  });
  // 组件片段运行在页面共享 IIFE 内；这里按页面真实求值方式包一层，
  // 并通过 globalThis 导出 OpsUI 供断言使用。
  vm.runInContext('(function(){\n' + OPS_OBSERVABILITY_SCRIPT_UI + '\nglobalThis.OpsUI=OpsUI;})();', context);
  return {
    context,
    body,
    ids,
    timers,
    removedTimers,
    activeElement: () => activeStub,
    setActive(node: StubNode | null) {
      activeStub = node;
    },
    fireDocument(type: string, event: Record<string, unknown> = {}) {
      return Promise.all((docListeners[type] ?? []).map((listener) => listener({
        preventDefault() {},
        stopPropagation() {},
        key: '',
        ...event,
      })));
    },
    OpsUI: (context as { OpsUI?: Record<string, unknown> }).OpsUI as {
      dialog(options: Record<string, unknown>): {
        shell: StubNode;
        panel: StubNode;
        open(): void;
        close(): void;
        isOpen(): boolean;
        destroy(): void;
      };
      toast(message: string, ok?: boolean): StubNode;
      state(root: StubNode, options: Record<string, unknown>): StubNode | null;
      table(options: Record<string, unknown>): StubNode;
    },
  };
}

test('OpsUI 命名空间只暴露四个组件工厂', () => {
  const { OpsUI } = setup();
  assert.deepEqual(Object.keys(OpsUI).sort(), ['dialog', 'state', 'table', 'toast']);
});

test('对话框：open/close 走统一通道并联动 body 滚动锁', () => {
  const { OpsUI, body } = setup();
  const dialog = OpsUI.dialog({ id: 'sample-drawer', label: '样例抽屉' });
  const shell = dialog.shell;
  assert.equal(shell.attrs.role, 'dialog');
  assert.equal(shell.attrs['aria-modal'], 'true');
  assert.equal(shell.attrs['aria-label'], '样例抽屉');
  assert.equal(shell.opsui, dialog, 'api 应挂在 shell 上供按 id 取回的调用点使用');
  assert.equal(shell.classList.contains('open'), false);

  dialog.open();
  assert.equal(dialog.isOpen(), true);
  assert.equal(shell.classList.contains('open'), true);
  assert.equal(body.classList.contains('opsui-modal-open'), true, '打开时锁定 body 滚动');
  assert.equal(dialog.panel.attrs.tabindex, '-1', '无焦点元素时面板获得 tabindex=-1 兜底');
  assert.ok(dialog.panel.focusCalls >= 1, '初始焦点落入对话框内');

  dialog.open();
  assert.equal(body.classList.contains('opsui-modal-open'), true, 'open 幂等，不重复加锁');

  dialog.close();
  assert.equal(dialog.isOpen(), false);
  assert.equal(shell.classList.contains('open'), false);
  assert.equal(body.classList.contains('opsui-modal-open'), false, '关闭后解锁滚动');
  dialog.close();
  assert.equal(body.classList.contains('opsui-modal-open'), false, 'close 幂等');

  dialog.destroy();
  assert.equal(shell.parentNode, null, 'destroy 从父节点摘除');
});

test('对话框：Esc 与遮罩点击关闭，嵌套时只关最上层', async () => {
  const { OpsUI, fireDocument } = setup();
  const first = OpsUI.dialog({ id: 'drawer-a', label: 'A' });
  const second = OpsUI.dialog({ id: 'drawer-b', label: 'B' });
  first.open();
  second.open();

  await fireDocument('keydown', { key: 'Escape' });
  assert.equal(second.isOpen(), false, 'Esc 只关闭最上层对话框');
  assert.equal(first.isOpen(), true, '下层对话框不受影响');

  await fireDocument('keydown', { key: 'Escape' });
  assert.equal(first.isOpen(), false, '再次 Esc 关闭下层');

  first.open();
  await first.shell.dispatch('click', { target: first.shell.children[0], preventDefault() {} });
  assert.equal(first.isOpen(), true, '点面板本身不关闭（面板是遮罩的子节点）');
  await first.shell.dispatch('click', { target: first.shell, preventDefault() {} });
  assert.equal(first.isOpen(), false, '点遮罩空白处关闭');
});

test('对话框：Tab 焦点圈定在面板内循环', async () => {
  const harness = setup();
  const { OpsUI, fireDocument, setActive } = harness;
  const dialog = OpsUI.dialog({ id: 'trap-drawer', label: '圈定' });
  const buttonA = el('button');
  const buttonB = el('button');
  dialog.panel.appendChild(buttonA);
  dialog.panel.appendChild(buttonB);
  dialog.panel.queryList = [buttonA, buttonB];
  dialog.open();

  setActive(buttonB);
  await fireDocument('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(buttonA.focusCalls, 2, '末元素 Tab 循回首元素（含 open 时对首元素的一次初始聚焦）');

  setActive(buttonA);
  await fireDocument('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(buttonB.focusCalls, 1, '首元素 Shift+Tab 循环到末元素');

  setActive(buttonA);
  await fireDocument('keydown', { key: 'Escape' });
  assert.equal(dialog.isOpen(), false);
  assert.equal(harness.body.classList.contains('opsui-modal-open'), false);
});

test('toast：成败区分播报语义，重复文案去重并重置计时', () => {
  const { OpsUI, ids, timers, removedTimers } = setup();
  const toastNode = ids.get('toast')!;
  assert.ok(toastNode, '页面壳提供 #toast 节点');

  OpsUI.toast('已保存');
  assert.equal(toastNode.textContent, '已保存');
  assert.equal(toastNode.classList.contains('show'), true);
  assert.equal(toastNode.classList.contains('ok'), true);
  assert.equal(toastNode.attrs.role, 'status');
  assert.equal(toastNode.attrs['aria-live'], 'polite');
  assert.equal(timers.length, 1);

  const before = timers.length;
  OpsUI.toast('已保存');
  assert.equal(removedTimers.length, 1, '旧计时器被清理');
  assert.equal(timers.length - removedTimers.length, 1, '去重路径重置计时后仍只有一个存活计时器');
  assert.equal(timers.length, before + 1);

  OpsUI.toast('保存失败', false);
  assert.equal(toastNode.classList.contains('bad'), true);
  assert.equal(toastNode.attrs.role, 'alert', '失败提示按 alert 立即播报');
  assert.equal(toastNode.attrs['aria-live'], 'assertive');
});

test('toast：悬停暂停自动关闭，移开后按剩余时长继续', async () => {
  const { OpsUI, ids, timers } = setup();
  const toastNode = ids.get('toast')!;
  OpsUI.toast('提示');
  const scheduled = timers.length;

  await toastNode.dispatch('mouseenter');
  OpsUI.toast('新提示');
  assert.equal(timers.length, scheduled, '悬停期间不安排自动关闭');

  await toastNode.dispatch('mouseleave');
  assert.equal(timers.length, scheduled + 1, '移开后恢复自动关闭');
});

test('state：加载/空/失败三种角色与重试', async () => {
  const { OpsUI } = setup();
  const loadingRoot = el('div');
  OpsUI.state(loadingRoot, { kind: 'loading', title: '正在加载指标…', hint: '请稍候。' });
  const loadingPanel = loadingRoot.children[0];
  assert.equal(loadingPanel.className, 'panel load-state loading');
  assert.equal(loadingPanel.attrs.role, 'status');
  assert.equal(loadingPanel.attrs['aria-live'], 'polite');
  assert.equal(loadingPanel.attrs['aria-hidden'], undefined, '加载图标自身标记 aria-hidden');
  assert.match(loadingPanel.children[0].attrs['aria-hidden'] ?? '', /true/);
  assert.equal(loadingPanel.children[1].children[0].textContent, '正在加载指标…');

  const emptyRoot = el('div');
  OpsUI.state(emptyRoot, { kind: 'empty', title: '没有匹配的事故' });
  const empty = emptyRoot.children[0];
  assert.equal(empty.className, 'signals-empty');
  assert.equal(empty.attrs.role, 'status');
  assert.equal(empty.textContent, '没有匹配的事故');

  const errorRoot = el('div');
  let retried = 0;
  OpsUI.state(errorRoot, { kind: 'error', title: '加载失败', hint: '请检查网络后重试。', retry: () => { retried += 1; } });
  const errorPanel = errorRoot.children[0];
  assert.equal(errorPanel.className, 'panel load-state error');
  assert.equal(errorPanel.attrs.role, 'alert', '失败态按 alert 播报');
  assert.equal(errorPanel.attrs['aria-live'], 'assertive');
  const retry = errorPanel.children[2];
  assert.equal(retry.tagName, 'BUTTON');
  assert.equal(retry.textContent, '重试');
  await retry.dispatch('click');
  assert.equal(retried, 1, '点击重试触发回调');
});

test('table：sr-only caption、th scope=col 与空态', () => {
  const { OpsUI } = setup();
  const table = OpsUI.table({
    title: '告警历史',
    columns: ['时间', '动作'],
    rows: [['2026-10-11 10:00', '触发'], [null, '恢复']],
  });
  assert.equal(table.className, 'panel table-panel');
  const scroll = table.children[1];
  const tableNode = scroll.children[0];
  const caption = tableNode.children[0];
  assert.equal(caption.tagName, 'CAPTION');
  assert.equal(caption.className, 'sr-only');
  assert.match(caption.textContent, /告警历史：2 行 × 2 列/);
  const headerCells = tableNode.children[1].children[0].children;
  assert.equal(headerCells.length, 2);
  assert.equal(headerCells[0].attrs.scope, 'col');
  const bodyRow = tableNode.children[2].children[0].children;
  assert.equal(bodyRow[0].textContent, '2026-10-11 10:00');
  assert.equal(bodyRow[1].textContent, '触发');
  const nullCellRow = tableNode.children[2].children[1].children;
  assert.equal(nullCellRow[0].textContent, '', 'null 单元格渲染为空字符串（textContent 纪律）');
  assert.equal(nullCellRow[1].textContent, '恢复');

  const emptyTable = OpsUI.table({ title: '通知投递', columns: ['时间'], rows: [], empty: '暂无通知记录' });
  const empty = emptyTable.children[1];
  assert.equal(empty.className, 'empty');
  assert.equal(empty.attrs.role, 'status');
  assert.equal(empty.textContent, '暂无通知记录');
});
