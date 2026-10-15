import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderVisionKnowledgeSection, VISION_WORKSHOP_KNOWLEDGE_SCRIPT } from './vision-workshop-knowledge-page.js';
import { VISION_CAMERA_FIELD_EXPERIENCE } from './vision-workshop-field-experience.js';

type Event = { preventDefault(): void };
class Element {
  children: Element[] = [];
  textContent = '';
  className = '';
  id = '';
  type = '';
  value = '';
  open = false;
  hidden = false;
  disabled = false;
  href = '';
  target = '';
  rel = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: Event) => unknown>> = {};
  constructor(readonly tagName: string) {}
  get innerHTML(): never { throw new Error('Knowledge HTML read'); }
  set innerHTML(_value: string) { throw new Error('Knowledge HTML write'); }
  appendChild(node: Element) { this.children.push(node); return node; }
  replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: Event) => unknown) { (this.listeners[name] ||= []).push(listener); }
  async fire(name: string) { for (const listener of this.listeners[name] || []) await listener({ preventDefault() {} }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const text = (node: Element): string => all(node).map(item => item.textContent).join(' ');
const buttons = (node: Element) => all(node).filter(item => item.tagName === 'button');

test('field experience is visibly separated from reviewed facts and never becomes an implicit hardware action', async () => {
  const experience = structuredClone(VISION_CAMERA_FIELD_EXPERIENCE);
  experience.entries[0].guidance = '<script>untrusted field report</script>';
  const response = { ...detail(), knowledge: { ...detail().knowledge, teamExperience: experience } };
  const h = setup(path => path.startsWith('/knowledge?') ? { ...index(), entries: index().entries.map(entry => ({ ...entry, teamExperience: { provenance: experience.provenance } })) } : response);
  await h.open();
  assert.match(text(h.get('cameraKnowledgeList')), /用户报告的现场经验.*待复核/);
  await buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  const contents = text(h.get('cameraKnowledgeDetail'));
  assert.match(contents, /团队现场经验 · 用户报告，历史案例待复核/);
  assert.match(contents, /<script>untrusted field report<\/script>/);
  assert.match(contents, /3\.3\.3.*1\.0\.17/);
  assert.match(contents, /专家流程采集字段/);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(path => path.startsWith('/knowledge')));
});
const index = (title = 'X5 IMX415 接入知识') => ({ ok: true, entries: [{
  id: 'x5-imx415', title, summary: '预检前置条件与 ISP 调优证据',
  verification: { documentation: 'verified', hardware: 'unverified' },
  readiness: { status: 'adapter_unavailable', reason: '匹配的原生 SDK 适配器未配置' },
}] });
const detail = () => ({ ok: true, knowledge: {
  id: 'x5-imx415', title: 'X5 IMX415 接入知识', summary: '资料已核对，设备尚未连接',
  verification: { documentation: 'verified', hardware: 'unverified' },
  facts: [{ id: 'official-image', title: '官方系统', value: '≥ 3.5.0', sourceIds: ['vendor-guide'] }],
  requiredAtomics: [{ id: 'raw-capture', label: 'Bayer RAW 采集', operations: ['capture_raw'],
    prerequisites: ['固定实际位深、Bayer、packing 与 stride'], evidence: ['真实单帧字节与 SHA-256'], notes: '视频帧不能作为 Bayer RAW 证据' }],
  workflow: ['只读核对系统与 SDK', '固定参数基线后采集实际 RAW'], limitations: ['本次没有 IMX415 真机点亮证据'],
  sources: [{ title: '厂商资料', url: 'https://example.test/imx415', locator: '第 2 页', sha256: 'a'.repeat(64) }] as Array<{ title: string; url: string; locator: string; sha256?: string }>,
}, readiness: { status: 'adapter_unavailable', reason: '未配置匹配适配器', adapters: [],
  atomics: [{ id: 'raw-capture', status: 'unavailable', missingOperations: ['capture_raw'] }] } });

function setup(respond: (path: string) => unknown | Promise<unknown> = path => path.startsWith('/knowledge?') ? index() : detail(), missingRoot = false) {
  const ids = new Map<string, Element>();
  const body = new Element('body');
  const markup = renderVisionKnowledgeSection();
  for (const match of markup.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)) {
    const node = new Element(match[1]); node.id = match[2]; ids.set(node.id, node); body.appendChild(node);
  }
  if (missingRoot) ids.delete('cameraKnowledge');
  const requests: string[] = [];
  vm.runInNewContext(VISION_WORKSHOP_KNOWLEDGE_SCRIPT, {
    $: (id: string) => ids.get(id),
    clean: (value: unknown) => value == null ? '' : String(value),
    arr: (value: unknown) => Array.isArray(value) ? value : [],
    make: (tag: string, className?: string, value?: unknown) => { const node = new Element(tag); node.className = className || ''; if (value !== undefined) node.textContent = String(value); return node; },
    append: (parent: Element, ...nodes: Element[]) => { nodes.forEach(node => parent.appendChild(node)); return parent; },
    request: async (path: string) => { requests.push(path); return respond(path); },
    URL,
  });
  const get = (id: string) => ids.get(id)!;
  const open = async () => { get('cameraKnowledge').open = true; await get('cameraKnowledge').fire('toggle'); };
  const search = async (query: string) => { get('cameraKnowledgeQuery').value = query; await get('cameraKnowledgeSearch').fire('submit'); };
  return { get, body, requests, open, search };
}

test('generic section loads only when first expanded, then reuses its directory until an explicit search', async () => {
  assert.ok(!/IMX415|RDK X5/.test(renderVisionKnowledgeSection()));
  assert.match(renderVisionKnowledgeSection(), /id="cameraKnowledgeList"/);
  assert.match(renderVisionKnowledgeSection(), /maxlength="160"/);
  const h = setup(); assert.equal(h.requests.length, 0);
  await h.get('cameraKnowledge').fire('toggle'); assert.equal(h.requests.length, 0);
  await h.open(); assert.deepEqual(h.requests, ['/knowledge?q=']);
  assert.match(text(h.get('cameraKnowledgeList')), /资料已核对.*真机未验证.*适配器未配置/);
  h.get('cameraKnowledge').open = false; await h.get('cameraKnowledge').fire('toggle');
  await h.open(); assert.equal(h.requests.length, 1);
  await h.search(' IMX415 / ISP & RAW ');
  assert.equal(h.requests[1], '/knowledge?q=IMX415%20%2F%20ISP%20%26%20RAW');
  await buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  assert.equal(h.requests[2], '/knowledge/x5-imx415');
  assert.ok(h.requests.every(path => path.startsWith('/knowledge')));
  assert.equal(h.get('cameraKnowledgeDetail').hidden, false);
});

test('detail shows documented facts, actual readiness, atomics, prerequisites, receipts and source locators', async () => {
  const h = setup(); await h.open(); await buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  const content = text(h.get('cameraKnowledgeDetail'));
  for (const value of ['资料已核对', '真机未验证', '适配器未配置', '≥ 3.5.0', 'vendor-guide', 'Bayer RAW 采集', 'capture_raw', '尚缺操作', '执行前提', 'stride', '需保留的实际回执', 'SHA-256：' + 'a'.repeat(64), '只读核对系统', '没有 IMX415 真机点亮证据', '第 2 页']) assert.ok(content.includes(value), value);
  const links = all(h.get('cameraKnowledgeDetail')).filter(node => node.tagName === 'a');
  assert.equal(links[0].href, 'https://example.test/imx415');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(buttons(h.get('cameraKnowledgeDetail')).length, 0);
});

test('untrusted knowledge stays text and only explicit HTTPS sources without credentials are clickable', async () => {
  const data = detail(); const malicious = '<img src=x onerror=alert(1)>';
  data.knowledge.title = malicious; data.knowledge.facts[0].value = malicious;
  data.knowledge.sources = [
    { title: malicious, url: 'https://example.test/safe', locator: malicious },
    ...['javascript:alert(1)', 'data:text/html,<script>', 'http://example.test', '//example.test', 'https://user:secret@example.test', 'https://example.test\\@evil.test', 'https://example.test/\nunsafe'].map(url => ({ title: '不可点击资料', url, locator: '' })),
  ];
  const h = setup(path => path.startsWith('/knowledge?') ? index(malicious) : data);
  await h.open(); await buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  const nodes = all(h.get('cameraKnowledgeDetail'));
  assert.equal(nodes.filter(node => node.tagName === 'a').length, 1);
  assert.equal(nodes.find(node => node.tagName === 'a')!.href, 'https://example.test/safe');
  assert.equal(nodes.filter(node => node.tagName === 'img' || node.tagName === 'script').length, 0);
  assert.ok(text(h.get('cameraKnowledgeDetail')).includes(malicious));
  assert.match(text(h.get('cameraKnowledgeDetail')), /来源链接不可用/);
  assert.ok(!text(h.get('cameraKnowledgeDetail')).includes('secret'));
});

test('failed directory reads show an error and retry the same search without implicit hardware action', async () => {
  let calls = 0;
  const h = setup(() => { if (calls++ === 0) throw new Error('knowledge_source_unavailable'); return index(); });
  h.get('cameraKnowledgeQuery').value = 'ISP'; await h.open();
  assert.match(text(h.get('cameraKnowledgeStatus')), /读取接入知识失败.*knowledge_source_unavailable/);
  assert.equal(h.get('cameraKnowledgeSubmit').disabled, false);
  assert.equal(h.get('cameraKnowledgeList').children.length, 0);
  await buttons(h.get('cameraKnowledgeStatus'))[0].fire('click');
  assert.deepEqual(h.requests, ['/knowledge?q=ISP', '/knowledge?q=ISP']);
  assert.match(text(h.get('cameraKnowledgeList')), /X5 IMX415/);
});

test('failed detail reads clear partial evidence and provide an explicit retry', async () => {
  let details = 0;
  const h = setup(path => {
    if (path.startsWith('/knowledge?')) return index();
    if (details++ === 0) throw new Error('knowledge_detail_unavailable');
    return detail();
  });
  await h.open(); await buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  assert.match(text(h.get('cameraKnowledgeDetail')), /读取接入知识失败.*knowledge_detail_unavailable/);
  assert.ok(!text(h.get('cameraKnowledgeDetail')).includes('资料已核对'));
  await buttons(h.get('cameraKnowledgeDetail'))[0].fire('click');
  assert.match(text(h.get('cameraKnowledgeDetail')), /Bayer RAW 采集/);
  assert.deepEqual(h.requests, ['/knowledge?q=', '/knowledge/x5-imx415', '/knowledge/x5-imx415']);
});

test('late directory and detail responses cannot replace a newer search', async () => {
  let finishOldIndex!: (value: unknown) => void; let finishDetail!: (value: unknown) => void;
  const h = setup(path => path === '/knowledge?q=' ? new Promise(resolve => { finishOldIndex = resolve; })
    : path === '/knowledge/x5-imx415' ? new Promise(resolve => { finishDetail = resolve; }) : index('新搜索结果'));
  const pendingIndex = h.open(); await h.search('ISP');
  finishOldIndex(index('过期目录')); await pendingIndex;
  assert.ok(!text(h.get('cameraKnowledgeList')).includes('过期目录'));
  const pendingDetail = buttons(h.get('cameraKnowledgeList'))[0].fire('click');
  await h.search('RAW'); finishDetail(detail()); await pendingDetail;
  assert.equal(h.get('cameraKnowledgeDetail').hidden, true);
  assert.equal(h.get('cameraKnowledgeDetail').children.length, 0);
  assert.match(text(h.get('cameraKnowledgeList')), /新搜索结果/);
});

test('missing knowledge DOM preserves existing page startup and invalid receipts stay errors', async () => {
  assert.deepEqual(setup(undefined, true).requests, []);
  const h = setup(() => ({ ok: true, entries: null })); await h.open();
  assert.match(text(h.get('cameraKnowledgeStatus')), /知识目录回执不完整/);
  assert.ok(!text(h.get('cameraKnowledgeStatus')).includes('没有匹配'));
});
