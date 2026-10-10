/** Grafana 浏览器门禁交接：执行实际内联脚本，失败必须留在工作台。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';

type Reply = { status: number; error?: string; invalidJson?: boolean };

function setup(options: { href?: string; popupBlocked?: boolean } = {}) {
  const href = options.href ?? '/dobs/grafana/';
  const attrs: Record<string, string> = { href };
  const toast = { textContent: '', className: '' };
  const openCalls: Array<{ url: string; target: string }> = [];
  const navigations: string[] = [];
  const sameTabNavigations: string[] = [];
  const order: string[] = [];
  const fetchCalls: Array<{ url: string; init: { credentials: string; headers: Record<string, string> } }> = [];
  const listeners: Array<(event: { preventDefault(): void }) => Promise<void>> = [];
  const popup = {
    opener: {} as unknown,
    closed: false,
    location: { replace: (url: string) => navigations.push(url) },
    close() { this.closed = true; },
  };
  let resolveResponse!: (response: unknown) => void;
  let rejectResponse!: (error: Error) => void;
  let prevented = 0;
  const link = {
    getAttribute: (key: string) => attrs[key] ?? null,
    setAttribute: (key: string, value: string) => { attrs[key] = value; },
    removeAttribute: (key: string) => { delete attrs[key]; },
    addEventListener: (_type: string, listener: typeof listeners[number]) => listeners.push(listener),
  };
  const context = vm.createContext({
    document: {
      body: null,
      documentElement: null,
      querySelector(selector: string) {
        assert.equal(selector, 'a.module-tab[href^="/dobs/grafana/"]');
        return link;
      },
      getElementById: (id: string) => id === 'toast' ? toast : null,
    },
    window: {
      open(url: string, target: string) {
        order.push('open');
        openCalls.push({ url, target });
        return options.popupBlocked ? null : popup;
      },
    },
    location: {
      href: 'https://example.test/dobs/ops-observability',
      pathname: '/dobs/ops-observability',
      assign: (url: string) => sameTabNavigations.push(url),
    },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: (key: string) => key === 'd_obs_admin_token' ? 'test-admin-token' : null },
    fetch(url: string, init: typeof fetchCalls[number]['init']) {
      order.push('fetch');
      fetchCalls.push({ url, init });
      return new Promise((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
    },
    setTimeout: () => 0,
    clearTimeout() {},
    URL,
  });
  // SCRIPT_A 是主 IIFE 的开头片段；闭合并导出实际函数，避免复制实现。
  vm.runInContext(`${OPS_OBSERVABILITY_SCRIPT_A}\n globalThis.initHandoff=initGrafanaLink;})();`, context);
  (context.initHandoff as () => void)();
  return {
    attrs, toast, popup, openCalls, fetchCalls, navigations, sameTabNavigations, order,
    get prevented() { return prevented; },
    click: () => listeners[0]({ preventDefault() { prevented += 1; } }),
    reply({ status, error, invalidJson }: Reply) {
      resolveResponse({
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (invalidJson) throw new Error('invalid JSON'); return { ok: false, error }; },
      });
    },
    fail: () => rejectResponse(new Error('network unavailable')),
  };
}

test('Grafana 交接：同步预开安全标签，204 后保留原看板路径与查询参数', async () => {
  const href = '/dobs/grafana/d/production?orgId=1&from=now-6h#panel-7';
  const h = setup({ href });
  const click = h.click();
  assert.deepEqual(h.order, ['open', 'fetch']);
  assert.deepEqual(h.openCalls, [{ url: 'about:blank', target: '_blank' }]);
  assert.equal(h.popup.opener, null, '新标签立即断开 opener');
  assert.deepEqual(h.navigations, [], '会话交换完成前不可访问 Grafana');
  assert.equal(h.attrs['aria-busy'], 'true');
  assert.equal(h.fetchCalls[0].url, '/dobs/api/ops/grafana/session');
  assert.equal(h.fetchCalls[0].init.credentials, 'same-origin');
  assert.equal(h.fetchCalls[0].init.headers['x-admin-token'], 'test-admin-token');
  h.reply({ status: 204 });
  await click;
  assert.deepEqual(h.navigations, [href]);
  assert.deepEqual(h.sameTabNavigations, []);
  assert.equal(h.attrs['aria-busy'], undefined);
});

for (const failure of [
  { status: 401, expected: '登录会话已失效' },
  { status: 403, error: 'not_authorized', expected: '无运营访问权限' },
  { status: 403, error: 'tenant_scope_only', expected: '当前租户凭证不能访问 Grafana' },
  { status: 503, error: 'central_store_disabled', expected: '门禁尚未配置' },
  { status: 503, invalidJson: true, expected: '访问服务暂不可用' },
  { status: 404, expected: 'HTTP 404' },
]) {
  test(`Grafana 交接：${failure.status} / ${failure.error ?? '无错误码'} 留在工作台并提示原因`, async () => {
    const h = setup();
    const click = h.click();
    h.reply(failure);
    await click;
    assert.equal(h.popup.closed, true, '失败应关闭预开的空白标签');
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.sameTabNavigations, []);
    assert.ok(h.toast.textContent.includes(failure.expected), h.toast.textContent);
    assert.equal(h.toast.className, 'toast show bad');
    assert.equal(h.attrs['aria-busy'], undefined);
  });
}

test('Grafana 交接：网络失败可见且不导航，再次点击可以重试', async () => {
  const h = setup();
  const click = h.click();
  h.fail();
  await click;
  assert.equal(h.popup.closed, true);
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.sameTabNavigations, []);
  assert.match(h.toast.textContent, /连接失败.*检查网络/);
  const retry = h.click();
  assert.equal(h.fetchCalls.length, 2);
  h.reply({ status: 403 });
  await retry;
});

test('Grafana 交接：弹窗被拦截时只在成功后同标签打开原路径', async () => {
  const href = '/dobs/grafana/d/service?var-service=api';
  const h = setup({ href, popupBlocked: true });
  const denied = h.click();
  h.reply({ status: 403 });
  await denied;
  assert.deepEqual(h.sameTabNavigations, []);
  const accepted = h.click();
  h.reply({ status: 204 });
  await accepted;
  assert.deepEqual(h.sameTabNavigations, [href]);
});

test('Grafana 交接：请求未完成时重复点击只发一次交换请求', async () => {
  const h = setup();
  const first = h.click();
  await h.click();
  assert.equal(h.openCalls.length, 1);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.prevented, 2);
  h.reply({ status: 204 });
  await first;
});

test('Grafana 交接：用户提前关闭新标签后保留工作台并允许再次打开', async () => {
  const h = setup();
  const click = h.click();
  h.popup.close();
  h.reply({ status: 204 });
  await click;
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.sameTabNavigations, []);
  assert.match(h.toast.textContent, /标签页已关闭.*再次点击/);
});
