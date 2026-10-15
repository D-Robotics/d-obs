/** Executes the production incident renderer; focuses on genuine filters and stale pagination. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_UI } from './observability-page-ui.js';

class DomNode {
  tagName: string;
  children: DomNode[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => unknown>> = {};
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = {};
  parentNode: DomNode | null = null;
  className = ''; textContent = ''; id = ''; type = ''; disabled = false; open = false;
  classList = { add: (...names: string[]) => { this.className += ' ' + names.join(' '); }, toggle() {}, contains: (name: string) => this.className.split(' ').includes(name), remove() {} };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  appendChild(node: DomNode) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes: DomNode[]) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(type: string, listener: () => unknown) { (this.listeners[type] ||= []).push(listener); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  set innerHTML(_value: string) { throw new Error('Incident analytics must use safe DOM rendering'); }
}
const all = (node: DomNode): DomNode[] => [node, ...node.children.flatMap(all)];
const text = (node: DomNode): string => all(node).map(child => child.textContent).join(' ');
const findButton = (root: DomNode, label: string) => all(root).find(node => node.tagName === 'BUTTON' && (node.textContent === label || node.attrs['aria-label'] === label))!;
const response = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const summary = { pending: 1, processing: 1, closed: 3, criticalActive: 1, warningActive: 1, todayNew: 2, mttaMinutes: 5, mttrMinutes: 12, windowDays: 7, daily: [{ day: '10-10', count: 2 }] };
const incident = (key: string, stage: string, severity = 'warning') => ({ key, title: key, stage, severity, status: stage === 'pending' ? 'open' : 'acknowledged', firstSeenAt: '2026-10-10T00:00:00Z' });

function setup() {
  const ids = new Map(['incidentList', 'incidentSummary', 'toast'].map(id => { const node = new DomNode('div'); node.id = id; return [id, node] as const; }));
  let serve: (path: string) => unknown = path => response(200, path.includes('/summary') ? { ok: true, summary } : { ok: true, incidents: [incident('pending-marker', 'pending'), incident('processing-marker', 'processing', 'critical')], total: 2 });
  const calls: string[] = [];
  const storage = new Map<string, string>();
  const context = vm.createContext({
    document: { body: new DomNode('body'), documentElement: new DomNode('html'), createElement: (tag: string) => new DomNode(tag), createElementNS: (_ns: string, tag: string) => new DomNode(tag), getElementById: (id: string) => ids.get(id) ?? null, querySelector: () => null, querySelectorAll: () => [] },
    window: {}, location: { pathname: '/ops-observability' },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: (path: string) => { calls.push(path); return Promise.resolve(serve(path)); },
    setTimeout: () => 0, clearTimeout() {}, console: { warn() {} }, URL, URLSearchParams,
  });
  vm.runInContext(`${OPS_OBSERVABILITY_SCRIPT_UI}
${OPS_OBSERVABILITY_SCRIPT_A}
    state.viewChild='center';state.config={definitions:[]};
    obsAuthState.me={user:{id:'user-a'},admin:true};
    globalThis.obs={loadIncidentCenter,loadMoreIncidentCenter,renderIncidentCenter,
      getData:()=>icData,getError:()=>icPageError,
      setIdentity:(userId,tenant)=>{obsAuthState.me={user:{id:userId},admin:true};sessionStorage.setItem('d_obs_active_tenant',tenant);}
    };
  })();`, context);
  const obs = context.obs as { loadIncidentCenter(): Promise<void>; loadMoreIncidentCenter(): Promise<void>; renderIncidentCenter(): void; getData(): { incidents: Array<{ key: string; title: string }> }; getError(): string; setIdentity(user: string, tenant: string): void };
  return { obs, calls, list: ids.get('incidentList')!, summary: ids.get('incidentSummary')!, serve(fn: typeof serve) { serve = fn; } };
}

test('Pending and processing cards genuinely filter stages; clear restores active list', async () => {
  const h = setup(); await h.obs.loadIncidentCenter();
  await findButton(h.summary, '查看待认领事故').listeners.click[0]();
  assert.match(text(h.list), /pending-marker/); assert.doesNotMatch(text(h.list), /processing-marker/);
  await findButton(h.summary, '查看处理中事故').listeners.click[0]();
  assert.match(text(h.list), /processing-marker/); assert.doesNotMatch(text(h.list), /pending-marker/);
  await findButton(h.list, '清除阶段筛选').listeners.click[0]();
  assert.match(text(h.list), /pending-marker/); assert.match(text(h.list), /processing-marker/);
  assert.ok(h.calls.filter(path => !path.includes('/summary')).every(path => path.includes('state=active')));
});

test('Response metrics and charts are secondary native details without fake click actions', async () => {
  const h = setup(); await h.obs.loadIncidentCenter();
  const details = all(h.summary).find(node => node.id === 'incidentAnalytics')!;
  assert.equal(details.tagName, 'DETAILS'); assert.equal(details.open, false);
  assert.match(text(details), /平均认领 MTTA.*平均恢复 MTTR/);
  assert.equal(all(details).filter(node => node.tagName === 'BUTTON' || node.listeners.click?.length).length, 0);
  assert.equal(h.summary.children.filter(node => node.tagName === 'BUTTON').length, 4);
  details.open = true; details.listeners.toggle[0]();
  await h.obs.loadIncidentCenter();
  assert.equal(all(h.summary).find(node => node.id === 'incidentAnalytics')!.open, true);
});

test('Incomplete summary payload preserves unknown counts instead of zero-valued charts', async () => {
  const h = setup();
  h.serve(path => response(200, path.includes('/summary') ? { ok: true, summary: {} } : { ok: true, incidents: [], total: 0 }));
  await h.obs.loadIncidentCenter();
  assert.match(text(h.summary), /处置概览尚未确认/);
  assert.ok(all(h.summary).filter(node => node.className.includes('summary-value')).every(node => node.textContent === '—'));
  assert.equal(all(h.summary).filter(node => node.className === 'ic-viz').length, 0);
  assert.ok(findButton(h.summary, '重试'));
});

test('Partial stage results disclose incompleteness and load more through the existing offset API', async () => {
  const h = setup();
  h.serve(path => response(200, path.includes('/summary') ? { ok: true, summary } : { ok: true, incidents: path.includes('offset=1') ? [incident('older-pending', 'pending')] : [incident('newer-processing', 'processing')], total: 2 }));
  await h.obs.loadIncidentCenter(); await findButton(h.summary, '查看待认领事故').listeners.click[0]();
  assert.match(text(h.list), /已加载记录中没有待认领事故/);
  assert.doesNotMatch(text(h.list), /没有匹配的事故/);
  await findButton(h.list, '加载更多事故').listeners.click[0]();
  assert.match(text(h.list), /older-pending/); assert.doesNotMatch(text(h.list), /newer-processing/);
  assert.ok(h.calls.some(path => path.includes('offset=1')));
});

for (const change of ['identity', 'tenant', 'reload']) {
  for (const status of [200, 503]) {
    test(`Stale pagination ${status} cannot replace data/errors after ${change} changes`, async () => {
      const h = setup();
      h.serve(path => response(200, path.includes('/summary') ? { ok: true, summary } : { ok: true, incidents: [incident('original', 'pending')], total: 2 }));
      await h.obs.loadIncidentCenter();
      let resolvePage!: (value: unknown) => void;
      h.serve(path => path.includes('offset=1') ? new Promise(resolve => { resolvePage = resolve; }) : response(200, path.includes('/summary') ? { ok: true, summary } : { ok: true, incidents: [incident('current-marker', 'pending')], total: 1 }));
      const pending = h.obs.loadMoreIncidentCenter();
      if (change === 'identity') h.obs.setIdentity('user-b', '');
      if (change === 'tenant') h.obs.setIdentity('user-a', 'tenant-b');
      await h.obs.loadIncidentCenter();
      resolvePage(response(status, status === 200 ? { ok: true, incidents: [incident('stale-marker', 'pending')], total: 2 } : { ok: false, error: 'central_store_disabled' }));
      await pending;
      assert.deepEqual(Array.from(h.obs.getData().incidents, item => item.key), ['current-marker']);
      assert.equal(h.obs.getError(), ''); assert.doesNotMatch(text(h.list), /stale-marker|更多事故加载失败/);
    });
  }
}

test('Pagination deduplicates by incident key when newer records shift server offsets', async () => {
  const h = setup();
  h.serve(path => response(200, path.includes('/summary') ? { ok: true, summary } : path.includes('offset=2') ? { ok: true, incidents: [{ ...incident('existing', 'pending'), title: 'updated-marker' }, incident('older', 'pending')], total: 3 } : { ok: true, incidents: [incident('existing', 'pending'), incident('second', 'processing')], total: 3 }));
  await h.obs.loadIncidentCenter(); await h.obs.loadMoreIncidentCenter();
  const records = Array.from(h.obs.getData().incidents);
  assert.equal(records.length, 3); assert.equal(records.filter(item => item.key === 'existing').length, 1);
  assert.equal(records.find(item => item.key === 'existing')!.title, 'updated-marker');
});
