import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { OPS_OBSERVABILITY_SCRIPT_ASSISTANT } from './observability-page-assistant.js';
import { platformAssistantHistoryContent, type PlatformAssistantOperationResult } from '../observability/platform-assistant.js';

type UiEvent = { target: MiniElement; preventDefault(): void };
class MiniElement {
  id = ''; className = ''; value = ''; type = ''; hidden = false; disabled = false; inert = false;
  children: MiniElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: UiEvent) => unknown>>();
  private text = '';
  private classes = new Set<string>();
  classList = { add: (value: string) => this.classes.add(value), remove: (value: string) => this.classes.delete(value) };
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error('Assistant history test forbids unsafe HTML'); }
  appendChild(child: MiniElement) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(name: string, callback: (event: UiEvent) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  dispatch(name: string) { return this.listeners.get(name)?.map((callback) => callback({ target: this, preventDefault() {} })); }
  click() { return this.dispatch('click'); }
  focus() {}
  descendants(): MiniElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector: string): MiniElement[] {
    return this.descendants().filter((element) => selector.split(',').some((part) => {
      const value = part.trim();
      if (value.startsWith('#')) return element.id === value.slice(1);
      if (value.startsWith('.')) return element.className.split(' ').includes(value.slice(1));
      return element.tagName === value.split(':')[0].toUpperCase();
    }));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

type ResponseFixture = { status: number; data: Record<string, unknown> };
type RequestFixture = { path: string; options: { method: string; headers: Record<string, string>; body?: string } };
function harness() {
  const body = new MiniElement('BODY');
  const requests: RequestFixture[] = [];
  let chat: ResponseFixture = { status: 200, data: { ok: true, reply: '默认回复', operations: [] } };
  let confirmation: ResponseFixture = { status: 200, data: { ok: true, reply: '默认确认回复', operations: [] } };
  const context = vm.createContext({
    document: { body, createElement: (tag: string) => new MiniElement(tag.toUpperCase()), getElementById: (value: string) => body.querySelector('#' + value), addEventListener() {} },
    state: { view: 'investigate', viewSource: 'investigate' },
    obsAuthState: { version: 1, me: { admin: true, user: { id: 'operator-fixture' } } },
    opsTenantMode: false, opsMemberMode: false, obsActiveTenant: () => '', adminTenantQuery: () => '',
    base: '/dobs', apiHeaders: () => ({ 'content-type': 'application/json', 'x-rdk-sso-session': 'fixture-session-secret', 'X-RDK-Ops-Action': 'observability' }),
    fetch: async (path: string, options: RequestFixture['options']) => {
      requests.push({ path, options });
      const response = path.includes('/confirm') ? confirmation : chat;
      return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.data };
    },
  });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_ASSISTANT + '\nglobalThis.assistant = PlatformAssistant;', context);
  const assistant = (context as unknown as { assistant: { submit(): Promise<void> } }).assistant;
  const input = body.querySelector('#platformAssistantInput');
  const log = body.querySelector('.platform-assistant-conversation');
  assert.ok(input); assert.ok(log);
  return {
    requests, log,
    setChat(data: Record<string, unknown>, status = 200) { chat = { status, data }; },
    setConfirm(data: Record<string, unknown>, status = 200) { confirmation = { status, data }; },
    async send(message: string) { input.value = message; await assistant.submit(); },
    async confirm() {
      const button = log.querySelectorAll('button').find((element) => element.textContent === '确认执行');
      assert.ok(button, 'Expected a pending mutation confirmation');
      await Promise.all(button.click() ?? []);
    },
    lastPayload() { return JSON.parse(requests.at(-1)!.options.body!) as { message: string; history: Array<{ role: string; content: string }> }; },
  };
}

const proof = 'proof-v1-valid-fixture-signed-evidence-material';
const actionId = 'action-6eac57a5-df73-48d4-a5ed-1b9c5c08b328';
function proposal(operationId: string, token: string) {
  return { token, operationId, description: '创建证据化观察提案', preview: '{"password":"preview-password-secret"}', expiresAt: Date.now() + 300_000 };
}
function result(id: string, data: unknown): PlatformAssistantOperationResult { return { id, description: '真实业务回执', status: 200, ok: true, data }; }

test('confirming evidence proof and an action preserves safe real identifiers in the next browser turn', async () => {
  const h = harness();
  const proofReply = '证据校验已完成，签发了有效 proof。';
  const proofReceipts = [result('POST /api/ops/observability/actions/evidence-proof', {
    ok: true, evidenceProof: proof, evidenceRefs: ['event:43a624ca-0d78-4fd1-a4f2-c04e73f9dc32'], token: 'receipt-token-secret', password: 'receipt-password-secret',
  })];
  const proofHistory = platformAssistantHistoryContent(proofReply, proofReceipts);
  h.setChat({ ok: true, reply: '请确认校验证据，当前尚未执行。', historyContent: '校验证据的提案尚未执行。', operations: [], proposal: proposal('POST /api/ops/observability/actions/evidence-proof', 'proof-confirm-token-secret') });
  await h.send('为当前证据准备 proof');
  h.setConfirm({ ok: true, reply: proofReply, operations: proofReceipts, historyContent: proofHistory });
  await h.confirm();
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body!), { token: 'proof-confirm-token-secret' });
  assert.match(h.log.textContent, /证据校验已完成，签发了有效 proof/);

  h.setChat({ ok: true, reply: '观察提案参数已核对，请确认创建。', historyContent: '观察提案尚未创建，请用户确认。', operations: [], proposal: proposal('POST /api/ops/observability/actions', 'action-confirm-token-secret') });
  await h.send('使用刚才的 proof 创建观察提案');
  assert.ok(h.lastPayload().history.some((item) => item.role === 'assistant' && item.content === proofHistory));
  assert.ok(h.lastPayload().history.some((item) => item.content.includes(proof)));

  const actionReply = '观察提案已创建，当前状态为 proposed。';
  const actionReceipts = [result('POST /api/ops/observability/actions', { ok: true, action: { id: actionId, status: 'proposed' }, token: 'action-receipt-token-secret' })];
  const actionHistory = platformAssistantHistoryContent(actionReply, actionReceipts);
  h.setConfirm({ ok: true, reply: actionReply, operations: actionReceipts, historyContent: actionHistory });
  await h.confirm();
  assert.match(h.log.textContent, /观察提案已创建，当前状态为 proposed/);
  assert.equal(h.requests.filter((request) => request.path.endsWith('/confirm')).length, 2);

  h.setChat({ ok: true, reply: '将根据已有行动 ID 查询状态。', operations: [] });
  await h.send('查询刚才创建的观察提案状态');
  const payload = h.lastPayload();
  assert.ok(payload.history.some((item) => item.role === 'assistant' && item.content === actionHistory));
  assert.ok(payload.history.some((item) => item.content.includes(actionId)));
  assert.ok(payload.history.some((item) => item.content.includes(proof)));
  const serializedHistory = JSON.stringify(payload.history);
  for (const secret of ['proof-confirm-token-secret', 'action-confirm-token-secret', 'receipt-token-secret', 'receipt-password-secret', 'action-receipt-token-secret', 'preview-password-secret', 'fixture-session-secret']) {
    assert.equal(serializedHistory.includes(secret), false, secret);
  }
  assert.equal(payload.history.some((item) => item.content === payload.message), false);
  assert.ok(h.log.textContent.includes(proofReply));
  assert.ok(h.log.textContent.includes(actionReply));
});

test('server history over two thousand characters remains complete while the drawer shows the original reply', async () => {
  const h = harness();
  const reply = '显示给用户的简洁答复。';
  const historyContent = '安全摘要。'.repeat(1200) + `\n安全操作回执：{"id":"${actionId}","evidenceProof":"${proof}"}`;
  assert.ok(historyContent.length > 2000 && historyContent.length < 8000);
  h.setChat({ ok: true, reply, operations: [], historyContent });
  await h.send('创建观察提案');
  assert.ok(h.log.textContent.includes(reply));
  assert.equal(h.log.textContent.includes('安全摘要。'), false);
  h.setChat({ ok: true, reply: '继续查询', operations: [] });
  await h.send('再查看详情');
  const history = h.lastPayload().history;
  assert.equal(history.find((item) => item.role === 'assistant')?.content, historyContent);
  assert.ok(history.some((item) => item.content.includes(proof)));
});

test('older replies still populate history and failed replies cannot inject server historyContent', async () => {
  const h = harness();
  h.setChat({ ok: true, reply: '兼容旧服务答复。', operations: [] });
  await h.send('查看状态');
  h.setChat({ ok: true, reply: '校验失败（platform_assistant_unverified_completion）', operations: [], historyContent: '不应成为下一轮历史的伪造回执。' });
  await h.send('再查看状态');
  h.setChat({ ok: true, reply: '重新读取状态', operations: [] });
  await h.send('重新查询');
  const history = h.lastPayload().history;
  assert.ok(history.some((item) => item.role === 'assistant' && item.content === '兼容旧服务答复。'));
  assert.equal(history.some((item) => item.content.includes('伪造回执') || item.content.includes('platform_assistant_unverified_completion')), false);
});
