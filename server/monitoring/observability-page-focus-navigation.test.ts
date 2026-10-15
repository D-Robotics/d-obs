/** Run the shipped navigation/tour script against the page's actual nav markup.
 * The small DOM implements reparenting, sibling positions, event bubbling and
 * focus; it deliberately has no routing or disclosure implementation to mirror.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR } from './observability-page-mobile-tour.js';
import { OPS_OBSERVABILITY_HTML } from './observability-page.js';
import { integrateCollectionNavScript } from './observability-page-collection-integration.js';
import { OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT, simplifyMobileTourScript } from './observability-page-simple-nav.js';

type DomEvent = { target: DomNode; key?: string; preventDefault(): void };
type Listener = (event: DomEvent) => void;

class DomNode {
  id = '';
  type = '';
  dataset: Record<string, string> = {};
  children: DomNode[] = [];
  parentElement: DomNode | null = null;
  private content = '';
  private classes = new Set<string>();
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name); else this.classes.delete(name);
      return enabled;
    },
  };
  constructor(readonly tagName: string, private focusNode: (node: DomNode) => void, private detachNode: (node: DomNode) => void = () => {}) {}
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.content = String(value); }
  get nextSibling(): DomNode | null {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
  }
  appendChild(child: DomNode) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child: DomNode, before: DomNode | null) {
    if (before === child) return child;
    if (before && before.parentElement !== this) throw new Error('insertBefore reference is not a child');
    child.remove();
    child.parentElement = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.detachNode(this);
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    }
    this.parentElement = null;
  }
  contains(node: DomNode): boolean {
    for (let current: DomNode | null = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  replaceChildren(...children: DomNode[]) { [...this.children].forEach(child => child.remove()); this.content = ''; children.forEach(child => this.appendChild(child)); }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return name === 'id' ? this.id || null : name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: Listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); }
  removeEventListener(name: string, listener: Listener) { this.listeners.get(name)?.delete(listener); }
  listenerCount(name: string) { return this.listeners.get(name)?.size ?? 0; }
  dispatch(name: string, key?: string) {
    let prevented = false;
    const event: DomEvent = { target: this, key, preventDefault() { prevented = true; } };
    const path: DomNode[] = [];
    for (let node: DomNode | null = this; node; node = node.parentElement) path.push(node);
    for (const node of path) for (const listener of [...node.listeners.get(name) ?? []]) listener(event);
    return prevented;
  }
  click() { this.dispatch('click'); }
  focus() { this.focusNode(this); }
  private matchesPart(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.classes.has(name));
    return this.tagName === selector.toUpperCase();
  }
  private matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    if (!this.matchesPart(parts.pop()!)) return false;
    let ancestor = this.parentElement;
    while (parts.length) {
      const part = parts.pop()!;
      while (ancestor && !ancestor.matchesPart(part)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  }
  querySelectorAll(selector: string): DomNode[] {
    return this.children.flatMap(child => [child, ...child.descendants()]).filter(node => node.tagName !== '#TEXT' && node.matches(selector));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): DomNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  private descendants(): DomNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function parseFragment(markup: string, create: (tag: string) => DomNode) {
  const root = create('fragment');
  const stack = [root];
  for (const [token] of markup.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim().toUpperCase();
      assert.equal(stack.pop()?.tagName, tag, 'fixture fragment must stay balanced');
    } else if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)![1];
      const node = create(tag);
      for (const attribute of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], attribute[2] ?? '');
      stack.at(-1)!.appendChild(node);
      if (!token.endsWith('/>') && !['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
    } else {
      const text = create('#text'); text.textContent = token; stack.at(-1)!.appendChild(text);
    }
  }
  assert.equal(stack.length, 1);
  return root;
}

function harness(mobile = true, authGate = false) {
  let active: DomNode | null = null;
  const create: (tag: string) => DomNode = tag => new DomNode(tag.toUpperCase(), node => { active = node; }, node => {
    // Removing a focused node or its ancestor resets browser focus to the body.
    // A subsequent renderer must focus the replacement control explicitly.
    if (active && node.contains(active)) active = body;
  });
  const document = create('document');
  const body: DomNode = document.appendChild(create('body'));
  active = body;
  if (authGate) body.classList.add('auth-gate');
  const navMarkup = OPS_OBSERVABILITY_HTML.match(/<aside class="side-nav">[\s\S]*?<\/aside>/)?.[0];
  assert.ok(navMarkup, 'the harness uses the actual page navigation');
  for (const child of [...parseFragment(navMarkup, create).children]) body.appendChild(child);
  const main = body.appendChild(create('main')); main.id = 'mainContent'; main.setAttribute('tabindex', '-1');
  const mediaListeners = new Set<() => void>();
  const resizeListeners = new Set<() => void>();
  const mql = { matches: mobile, addEventListener(name: string, listener: () => void) { assert.equal(name, 'change'); mediaListeners.add(listener); } };
  let scheduled = 0;
  const context = vm.createContext({
    document: {
      body, createElement: create,
      createTextNode(text: string) { const node = create('#text'); node.textContent = text; return node; },
      getElementById: (id: string) => document.querySelector('#' + id),
      querySelector: (selector: string) => document.querySelector(selector),
      querySelectorAll: (selector: string) => document.querySelectorAll(selector),
      addEventListener: document.addEventListener.bind(document),
      removeEventListener: document.removeEventListener.bind(document),
    },
    window: {
      matchMedia(query: string) { assert.equal(query, '(max-width:720px)'); return mql; },
      addEventListener(name: string, listener: () => void) { assert.equal(name, 'resize'); resizeListeners.add(listener); },
    },
    setTimeout() { scheduled += 1; },
  });
  const byId = (id: string) => document.querySelector('#' + id);
  const tabs = document.querySelector('.module-tabs')!;
  const navMain = tabs.querySelector('.nav-main')!;
  const primary = tabs.querySelector('.nav-primary')!;
  const buttons = tabs.querySelectorAll('.module-tab');
  vm.runInContext(integrateCollectionNavScript(OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT), context);
  const originalOrder = [...navMain.children];
  const routeCalls: string[] = [];
  for (const button of buttons) if (button.dataset.view) button.addEventListener('click', () => routeCalls.push(button.dataset.view));
  vm.runInContext(simplifyMobileTourScript(OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR), context);
  const more = tabs.querySelector('.mobile-more-toggle')!;
  assert.ok(more, 'navigation enhancement must complete, including any DOM operations');
  const resize = (matches: boolean, mediaEvent = true) => {
    mql.matches = matches;
    if (mediaEvent) mediaListeners.forEach(listener => listener());
    resizeListeners.forEach(listener => listener());
  };
  return { body, document, tabs, navMain, primary, buttons, originalOrder, main, more, byId, resize, routeCalls, active: () => active, scheduled: () => scheduled };
}

const PRIMARY_VIEWS = ['overview', 'collection/tasks', 'data/assets', 'alerts/center', 'traces', 'signals', 'devices'];
const MOBILE_PRIMARY_VIEWS = ['overview', 'alerts/center', 'traces', 'signals', 'devices'];

function assertClosed(h: ReturnType<typeof harness>) {
  assert.equal(h.tabs.classList.contains('mobile-expanded'), false);
  assert.equal(h.more.classList.contains('expanded'), false);
  assert.equal(h.more.getAttribute('aria-expanded'), 'false');
}

test('实际页面提供七个直接工作区，其余路由与看板高级操作按需展开', () => {
  const h = harness(false);
  // Application links have href; only workspace route buttons have data-view.
  assert.deepEqual(h.navMain.querySelectorAll('.module-tab').filter(button => button.dataset.view).map(button => button.dataset.view), PRIMARY_VIEWS);
  const groups = h.tabs.querySelectorAll('.nav-group');
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => group.tagName === 'DETAILS' && group.getAttribute('open') === null));
  const routes = h.buttons.map(button => button.dataset.view).filter(Boolean);
  assert.equal(new Set(routes).size, routes.length, 'reorganization must not duplicate route buttons');
  for (const view of ['investigate', 'signals/panels', 'database', 'alerts/rules', 'platform', 'tenants']) assert.ok(routes.includes(view));
  const advancedMarkup = OPS_OBSERVABILITY_HTML.match(/<details class="focus-tools" id="boardMoreTools">[\s\S]*?<\/details>/)?.[0];
  assert.ok(advancedMarkup);
  const tools = parseFragment(advancedMarkup, tag => new DomNode(tag.toUpperCase(), () => {})).querySelector('details')!;
  assert.equal(tools.getAttribute('open'), null);
  assert.match(tools.querySelector('summary')!.textContent, /更多操作/);
  for (const id of ['boardAutoRefresh', 'boardNewBtn', 'boardAiBtn', 'boardImportBtn', 'boardExportBtn', 'boardDeleteBtn']) assert.ok(tools.querySelector('#' + id), 'advanced action stays reachable: ' + id);
  assert.equal(tools.querySelector('#boardAddPanelBtn'), null, 'adding a panel remains a direct action');
  assert.ok(OPS_OBSERVABILITY_HTML.includes(integrateCollectionNavScript(OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT)));
  assert.ok(OPS_OBSERVABILITY_HTML.includes(simplifyMobileTourScript(OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR)));
});

test('移动、桌面、移动切换复用原按钮且恢复原位置与完整顺序，resize 兜底也有效', () => {
  const h = harness();
  const primaryButtons = h.buttons.filter(button => MOBILE_PRIMARY_VIEWS.includes(button.dataset.view));
  assert.deepEqual(h.primary.querySelectorAll('.module-tab'), primaryButtons);
  assert.equal(h.more.parentElement, h.tabs, 'more belongs to the same bottom navigation row');
  for (let cycle = 0; cycle < 2; cycle += 1) {
    h.more.click();
    h.resize(false, cycle === 0);
    assert.deepEqual(h.navMain.children, h.originalOrder, 'restore element and whitespace sibling positions');
    assert.equal(h.primary.querySelectorAll('.module-tab').length, 0);
    assertClosed(h);
    h.resize(true, cycle === 0);
    assert.deepEqual(h.primary.querySelectorAll('.module-tab'), primaryButtons);
    assert.equal(h.tabs.querySelectorAll('.mobile-more-toggle').length, 1);
    primaryButtons[cycle].click();
  }
  assert.deepEqual(h.routeCalls, ['overview', 'alerts/center'], 'the original route listeners survive every move');
});

test('更多的展开状态、键盘关闭与选择辅助工作区一致，焦点回到可见内容', () => {
  const h = harness();
  const summary = h.tabs.querySelector('.nav-section-toggle')!;
  h.more.click();
  assert.equal(h.more.getAttribute('aria-expanded'), 'true');
  assert.equal(h.more.getAttribute('aria-controls'), h.tabs.id);
  assert.equal(h.active(), summary);
  assert.equal(summary.dispatch('keydown', 'Escape'), true);
  assertClosed(h); assert.equal(h.active(), h.more);
  h.more.click(); h.more.click(); assertClosed(h);
  h.more.click();
  const secondary = h.buttons.find(button => button.dataset.view === 'investigate')!;
  // Nested labels must preserve the original route and still close the drawer.
  const nested = secondary.appendChild(new DomNode('SPAN', () => {})); nested.textContent = '证据';
  nested.click();
  assert.deepEqual(h.routeCalls, ['investigate']);
  assertClosed(h); assert.equal(h.active(), h.main);
  h.more.click(); h.buttons.find(button => button.dataset.view === 'overview')!.click();
  assertClosed(h);
});

test('进入页面不自动导览，主动打开仅创建一个对话框，Escape 关闭并恢复指南焦点', () => {
  const h = harness();
  assert.equal(h.byId('tourCard'), null);
  assert.equal(h.scheduled(), 0, 'initial page entry must not schedule an unsolicited guide');
  const trigger = h.byId('startWorkbenchTour')!;
  trigger.click();
  const card = h.byId('tourCard')!;
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'false');
  assert.equal(h.active(), card.querySelector('button'));
  assert.match(card.textContent, /1 \/ 5/);
  trigger.click(); assert.equal(h.body.querySelectorAll('#tourCard').length, 1);
  assert.equal(h.document.listenerCount('keydown'), 1);
  assert.equal(h.active()!.dispatch('keydown', 'Escape'), true);
  assert.equal(h.byId('tourCard'), null);
  assert.equal(h.document.listenerCount('keydown'), 0, 'closing removes the guide keyboard listener');
  assert.equal(h.active(), trigger);
  trigger.click(); assert.match(h.byId('tourCard')!.textContent, /1 \/ 5/);
});

test('指南跳过与走完都清理对话框及监听，登录门禁阻止导览', () => {
  const h = harness(false);
  const trigger = h.byId('startWorkbenchTour')!;
  trigger.click(); h.byId('tourCard')!.querySelector('.tour-skip')!.click();
  assert.equal(h.byId('tourCard'), null); assert.equal(h.active(), trigger);
  trigger.click();
  for (let step = 1; step <= 5; step += 1) {
    const card = h.byId('tourCard')!;
    assert.match(card.textContent, new RegExp(step + ' / 5'));
    const next = card.querySelector('button')!;
    assert.equal(h.active(), next, 'each step retains a focused action for continuous keyboard activation');
    h.active()!.click();
    assert.equal(h.document.contains(next), false, 'the focused button was actually removed by the renderer');
    if (step < 5) {
      const replacement = h.byId('tourCard')!.querySelector('button')!;
      assert.notEqual(replacement, next);
      assert.equal(h.active(), replacement, 'focus follows the newly rendered next/complete button');
    }
  }
  assert.equal(h.byId('tourCard'), null);
  assert.equal(h.document.listenerCount('keydown'), 0); assert.equal(h.active(), trigger);
  const gated = harness(false, true); gated.byId('startWorkbenchTour')!.click();
  assert.equal(gated.byId('tourCard'), null); assert.equal(gated.document.listenerCount('keydown'), 0);
});
