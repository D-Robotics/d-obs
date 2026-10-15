import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Execute with the active d-obs MainPID environment and its Node binary.
// Only GET requests and an optional read-only metadata SELECT are issued.
// Bodies, identities, signed locators and secrets
// remain in memory; only status, public runRef, kinds/counts and DOM booleans emit.
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('invalid_argument');
  return index < 0 ? fallback : args[index + 1];
};
const base = path.resolve(option('--base', '/opt/d-obs/current'));
const origin = new URL(option('--origin', 'http://127.0.0.1:18093'));
const wanted = option('--run', '');
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('invalid_origin');
const token = String(process.env.RDK_CREDITS_ADMIN_TOKEN || '').trim();
if (!token) throw new Error('trusted_server_credential_missing');
const headers = { 'x-admin-token': token, 'x-rdk-ops-action': 'observability-context', 'x-rdk-ops-read-only': '1' };
const routeUrl = route => origin.href.replace(/\/$/, '') + route;
const emit = (stage, value = {}) => process.stdout.write(JSON.stringify({ stage, ...value }) + '\n');
const check = (ok, stage, value = {}) => { emit(stage, { ok, ...value }); if (!ok) throw new Error(stage + '_failed'); };
const safeRef = value => /^run-[a-zA-Z0-9_-]{1,100}$/.test(String(value || '')) ? value : 'scoped-run';
const allowedKinds = new Set(['user_input', 'model_input', 'model_output', 'tool_input', 'tool_output']);
async function get(route, requestHeaders = headers, json = true) {
  const response = await fetch(routeUrl(route), { method: 'GET', headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(45000) });
  const text = await response.text();
  let value = null;
  if (json) { try { value = JSON.parse(text); } catch {} }
  return { status: response.status, value, text: json ? undefined : text };
}

function harness(source) {
  const walk = node => [node, ...node.children.flatMap(walk)];
  const make = (tagName = 'div', className = '', textContent = '') => {
    let open = false;
    const listeners = new Map();
    const node = { tagName, className, textContent, children: [], attributes: {}, parentElement: null, hidden: false,
      appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); },
    };
    Object.defineProperty(node, 'open', { get: () => open, set(value) {
      const changed = open !== Boolean(value); open = Boolean(value);
      if (changed) for (const fn of listeners.get('toggle') || []) fn({ target: node });
    } });
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('unsafe_html_write'); } });
    return node;
  };
  const context = vm.createContext({ make,
    add: (parent, tag, cls, text) => parent.appendChild(make(tag, cls, text)),
    traceList: value => Array.isArray(value) ? value : [], when: value => String(value || ''),
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(source + '\n globalThis.hooks={bound:renderTraceBoundConversation,conversation:renderTraceConversation,items:traceConversationItems,messages:traceContentMessages,role:traceContentRoleName};', context, { timeout: 5000 });
  const visible = node => {
    if (node.hidden) return false;
    const parent = node.parentElement;
    return !parent || (!(parent.tagName === 'details' && !parent.open && parent.children[0] !== node) && visible(parent));
  };
  return { make, walk, hooks: context.hooks, visibleText: node => walk(node).filter(visible).map(value => value.textContent).join('\n') };
}

function verifyDom(source, detail) {
  const h = harness(source), bound = h.hooks.bound(h.make(), detail), conversation = h.hooks.conversation(h.make(), detail);
  const items = h.hooks.items(detail), archive = detail.conversationContext;
  const captured = items.filter(item => item.entry.kind === 'user_input' || item.entry.kind === 'model_output' && (h.hooks.role(item.entry, item.span, {}) !== '模型调用工具' || h.hooks.messages(item.entry)));
  const currentEntries = archive?.currentTurn?.availability === 'available' ? archive.currentTurn.turn?.content?.entries || [] : captured.map(item => item.entry);
  const exactRun = archive?.binding === 'bound' && archive.runRef === detail.run?.runRef && archive.sessionRef === detail.run?.sessionRef;
  const displayable = exactRun ? currentEntries.filter(entry => ['user_input', 'model_output'].includes(entry.kind)).flatMap(entry => {
    const messages = h.hooks.messages(entry);
    return (messages ? messages.map(message => message.text) : [entry.text]).filter(text => typeof text === 'string' && text.trim()).map(text => ({ kind: entry.kind, sample: Array.from(text).slice(0, 64).join('') }));
  }) : [];
  const visible = h.visibleText(bound);
  const currentTextReadable = displayable.length > 0 && displayable.every(entry => visible.includes(entry.sample));
  const userReadable = displayable.some(entry => entry.kind === 'user_input') && displayable.filter(entry => entry.kind === 'user_input').every(entry => visible.includes(entry.sample));
  const assistantReadable = displayable.some(entry => entry.kind === 'model_output') && displayable.filter(entry => entry.kind === 'model_output').every(entry => visible.includes(entry.sample));
  const fallback = ['missing', 'unavailable'].includes(archive?.currentTurn?.availability);
  const currentCaptureFallback = !fallback || h.walk(bound).some(node => node.className === 'trace-archive-turn trace-captured-turn');
  const messageViews = h.walk(conversation).filter(node => node.className === 'trace-content-message-role');
  const expectedRoles = items.filter(item => item.entry.kind === 'model_input').flatMap(item => h.hooks.messages(item.entry) || []).map(message => ({ system: '系统', developer: '开发者', user: '用户', assistant: '助手', tool: '工具' }[message.role])).filter(Boolean);
  const modelInputRoleView = expectedRoles.every(role => messageViews.some(node => node.textContent === role));
  const tools = h.walk(conversation).filter(node => ['tool_input', 'tool_output'].includes(node.attributes['data-trace-content-kind']));
  const toolsCollapsed = tools.every(node => node.open === false);
  const rawControls = h.walk(conversation).filter(node => node.className === 'trace-content-raw');
  const originalsCollapsed = rawControls.every(node => node.open === false);
  return { boundOpen: bound.open === true, currentTextReadable, userReadable, assistantReadable, currentCaptureFallback, modelInputRoleView, modelInputRoleCount: expectedRoles.length, toolsCollapsed, toolEntries: tools.length, originalsCollapsed, originalControls: rawControls.length };
}

try {
  const { OPS_OBSERVABILITY_SCRIPT_TRACE_CONTENT: source } = await import(pathToFileURL(path.join(base, 'server/monitoring/observability-page-script-trace-content.js')));
  const page = await get('/ops-observability', {}, false);
  check(page.status === 200 && typeof source === 'string' && page.text.includes(source), 'served_page_wiring', { status: page.status });
  const scripts = [...page.text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  scripts.forEach(script => new vm.Script(script));
  check(scripts.length > 0, 'served_script_syntax', { scriptCount: scripts.length });
  const anonymous = await get('/api/ops/observability/overview?hours=1', {});
  check([401, 403].includes(anonymous.status), 'anonymous_overview_denied', { status: anonymous.status });
  const guard = await get('/api/ops/observability/runs/invalid-locator', { 'x-admin-token': token });
  check(guard.status === 400 && guard.value?.error === 'missing_ops_context_guard', 'detail_context_guard', { status: guard.status });

  const query = '/api/ops/observability/overview?hours=168&traceLimit=80&traceEnvironment=production';
  // traceRunId accepts a canonical UUID, while the UI exposes a scoped runRef.
  // Start with the normal overview and prefer the requested display reference.
  const preferred = await get(query);
  check(preferred.status === 200 && preferred.value?.ok === true, 'authorized_overview', { status: preferred.status, runCount: preferred.value?.overview?.runTraces?.length || 0 });
  let selected;
  const seen = new Set();
  const verifyCandidates = async candidates => {
    for (const candidate of candidates) {
      if (typeof candidate.locator !== 'string' || seen.has(candidate.runRef)) continue;
      seen.add(candidate.runRef);
      const read = await get('/api/ops/observability/runs/' + encodeURIComponent(candidate.locator));
      const detail = read.value?.detail;
      check(read.status === 200 && read.value?.ok === true && detail?.run?.runRef === candidate.runRef, 'authorized_exact_run_detail', { status: read.status, runRef: safeRef(candidate.runRef) });
      const spans = (detail.traces || []).flatMap(trace => trace.spans || []);
      const entries = spans.filter(span => span.content?.availability === 'available').flatMap(span => span.content.entries || []).filter(entry => allowedKinds.has(entry?.kind));
      const kinds = [...new Set(entries.map(entry => entry.kind))];
      const dom = verifyDom(source, detail);
      emit('conversation_projection', { status: read.status, runRef: safeRef(candidate.runRef), contentEntryCount: entries.length, contentEntryKinds: kinds, currentArchiveStatus: detail.conversationContext?.currentTurn?.availability || 'not_supported', currentArchiveEntryCount: detail.conversationContext?.currentTurn?.turn?.content?.entries?.length || 0, dom });
      if (dom.boundOpen && dom.currentTextReadable && dom.userReadable && dom.assistantReadable && dom.currentCaptureFallback && dom.modelInputRoleView && dom.toolsCollapsed && dom.originalsCollapsed) { selected = candidate; break; }
    }
  };
  const normalCandidates = [...preferred.value.overview?.runTraces || []].sort((left, right) => Number(right.runRef === wanted) - Number(left.runRef === wanted));
  await verifyCandidates(normalCandidates.slice(0, 8));
  if (!selected && process.env.RDK_CHAT_CREDITS_DB_URL) {
    const require = createRequire(path.join(base, 'package.json'));
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.RDK_CHAT_CREDITS_DB_URL, max: 1, options: '-c default_transaction_read_only=on', statement_timeout: 10000, query_timeout: 15000 });
    let metadata;
    try {
      metadata = await pool.query(`
        select s.run_id, s.account_scope_id, max(s.start_time_ms) latest_span_ms
          from public.studio_trace_spans s
          join public.agent_run_records r
            on r.run_id = s.run_id and nullif(trim(r.sso_user_id), '') = s.account_scope_id
         where s.environment = 'production'
           and case when coalesce(to_jsonb(r)->>'client_type', '') = 'local-dev' then 'development'
                    else coalesce(nullif(to_jsonb(r)->>'environment', ''), 'production') end = s.environment
           and s.start_time_ms > extract(epoch from now() - interval '7 days') * 1000
           and r.started_at > now() - interval '7 days'
           and s.content is not null
           and (s.content_expires_at is null or s.content_expires_at > now())
         group by s.run_id, s.account_scope_id
         order by latest_span_ms desc limit 4`);
    } finally { await pool.end(); }
    emit('read_only_content_run_inventory', { candidateCount: metadata.rows.length });
    const { runDisplayRef } = await import(pathToFileURL(path.join(base, 'server/observability/run-locator.js')));
    const rows = [...metadata.rows].sort((left, right) => Number(runDisplayRef(right.account_scope_id, 'production', right.run_id) === wanted) - Number(runDisplayRef(left.account_scope_id, 'production', left.run_id) === wanted));
    for (const row of rows) {
      if (selected) break;
      // The canonical ID only narrows the normal protected overview. It never
      // grants detail access: the same principal must obtain its signed locator.
      const overview = await get(query + '&traceRunId=' + encodeURIComponent(row.run_id));
      check(overview.status === 200 && overview.value?.ok === true, 'canonical_run_overview', { status: overview.status, runCount: overview.value?.overview?.runTraces?.length || 0 });
      await verifyCandidates(overview.value.overview?.runTraces || []);
    }
  }
  check(Boolean(selected), 'current_conversation_readable');
  const anonymousDetail = await get('/api/ops/observability/runs/' + encodeURIComponent(selected.locator), {});
  check([401, 403].includes(anonymousDetail.status), 'anonymous_detail_denied', { status: anonymousDetail.status });
  emit('complete', { ok: true, runRef: safeRef(selected.runRef) });
} catch (error) {
  const reason = String(error?.message || '');
  emit('failure', { ok: false, error: /^[a-z_]+$/.test(reason) ? reason : 'read_only_verification_failed' });
  process.exitCode = 1;
}
