/**
 * C2：产品化会话 Trace 查看页（独立 HTML 壳）。
 *
 * 设计约束：
 * - HTML 壳不含任何运行数据；数据来自 GET /api/agent/session-observability（SSO + 账号命名空间隔离）。
 * - 渲染一律走 textContent / createElement，服务端摘要中的字段（工具名、executor 等）
 *   可能来自模型输出或设备侧，绝不按 HTML 执行（与运营可观测页同款 XSS 纪律）。
 * - 未登录/无权限时展示明确引导，而不是裸露 JSON。
 */
// This page is itself a template literal.  Keep backslashes in the embedded
// browser script (notably the pathname regex) so the served HTML remains valid
// JavaScript after interpolation.
export const SESSION_TRACE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>RDK Studio · 会话 Trace</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, 'Segoe UI', 'PingFang SC', sans-serif; background: #0b1220; color: #e2e8f0; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; border-bottom: 1px solid rgba(148,163,184,.18); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; }
    .brand-mark { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg,#6366f1,#22d3ee); display: grid; place-items: center; font-size: 14px; }
    .brand small { display: block; font-weight: 400; color: #94a3b8; font-size: 11px; letter-spacing: .12em; }
    .product-nav { display: flex; gap: 14px; font-size: 13px; }
    .product-nav a { color: #94a3b8; text-decoration: none; }
    .product-nav a:hover { color: #e2e8f0; }
    main { max-width: 1080px; margin: 0 auto; padding: 26px 22px 60px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .kicker { color: #818cf8; font-size: 12px; letter-spacing: .14em; margin-bottom: 6px; }
    .hint { color: #94a3b8; font-size: 13px; margin: 0 0 18px; }
    .query-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 22px; }
    input { flex: 1 1 260px; background: #101a2e; border: 1px solid rgba(148,163,184,.3); color: #e2e8f0; border-radius: 8px; padding: 9px 12px; font-size: 13px; }
    input:focus { outline: 1px solid #6366f1; }
    button { background: #6366f1; color: #fff; border: 0; border-radius: 8px; padding: 9px 18px; font-size: 13px; cursor: pointer; }
    button:hover { background: #4f46e5; }
    .notice { background: rgba(99,102,241,.08); border: 1px solid rgba(99,102,241,.35); border-radius: 10px; padding: 12px 14px; font-size: 13px; color: #c7d2fe; margin-bottom: 16px; }
    .notice.error { background: rgba(244,63,94,.08); border-color: rgba(244,63,94,.4); color: #fda4af; }
    .run-card { background: #101a2e; border: 1px solid rgba(148,163,184,.16); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
    .run-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .run-title { font-weight: 600; font-size: 14px; word-break: break-all; }
    .pill { font-size: 11px; border-radius: 999px; padding: 2px 10px; border: 1px solid rgba(148,163,184,.35); color: #cbd5e1; white-space: nowrap; }
    .pill.ok { color: #6ee7b7; border-color: rgba(16,185,129,.5); }
    .pill.err { color: #fda4af; border-color: rgba(244,63,94,.5); }
    .pill.warn { color: #fcd34d; border-color: rgba(245,158,11,.5); }
    .pill.run { color: #93c5fd; border-color: rgba(59,130,246,.5); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 10px; margin-bottom: 12px; }
    .stat { background: rgba(15,23,42,.6); border-radius: 8px; padding: 10px 12px; }
    .stat b { display: block; font-size: 12px; color: #94a3b8; font-weight: 500; margin-bottom: 4px; }
    .stat span { font-size: 13px; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(148,163,184,.12); word-break: break-all; }
    th { color: #94a3b8; font-weight: 500; }
    .sub { color: #94a3b8; font-size: 12px; margin: 10px 0 6px; }
    .empty { color: #94a3b8; font-size: 13px; padding: 26px; text-align: center; background: #101a2e; border-radius: 12px; border: 1px dashed rgba(148,163,184,.3); }
    code { background: rgba(148,163,184,.14); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><div class="brand-mark">T</div><div>RDK Studio<small>SESSION TRACE</small></div></div>
    <nav class="product-nav"><a href="./">工作台</a><a href="./ops-observability#overview">可观测中心</a></nav>
  </header>
  <main>
    <div class="kicker">质量治理 / 会话追踪</div>
    <h1>会话 Trace 查看</h1>
    <p class="hint">查看当前账号会话内每一轮 Agent run 的全链路观测：状态 / 模型 / 工具调用 / 完成度。数据按账号命名空间隔离，请输入当前账号的会话 ID。</p>
    <div class="query-bar">
      <input id="sessionId" placeholder="会话 sessionId（粘贴工作台会话 id）" autocomplete="off" />
      <input id="deviceId" placeholder="设备 deviceId（可选）" style="flex:0 1 200px" autocomplete="off" />
      <button id="load">查看 Trace</button>
    </div>
    <div class="query-bar" style="margin-top:10px">
      <span class="hint" style="align-self:center;margin:0">跨账号全局视图暂未开放；为保护账号隔离，请按会话 ID 查询。</span>
    </div>
    <div id="status"></div>
    <div id="runs"></div>
  </main>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var sessionInput = document.getElementById('sessionId');
      var deviceInput = document.getElementById('deviceId');
      var statusBox = document.getElementById('status');
      var runsBox = document.getElementById('runs');
      sessionInput.value = params.get('sessionId') || '';
      deviceInput.value = params.get('deviceId') || '';

      function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
        return node;
      }

      function notice(text, isError) {
        statusBox.replaceChildren();
        statusBox.appendChild(el('div', 'notice' + (isError ? ' error' : ''), text));
      }

      function fmtTime(ts) {
        if (!ts) return '—';
        try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(ts); }
      }

      function statusPill(status) {
        var cls = '';
        if (status === 'completed') cls = 'ok';
        else if (status === 'error' || status === 'force_cancelled') cls = 'err';
        else if (status === 'completed_partial' || status === 'interrupted' || status === 'cancelled') cls = 'warn';
        else if (status === 'running') cls = 'run';
        return el('span', 'pill ' + cls, status || 'unknown');
      }

      function stat(label, value) {
        var box = el('div', 'stat');
        box.appendChild(el('b', '', label));
        box.appendChild(el('span', '', value === undefined || value === null || value === '' ? '—' : String(value)));
        return box;
      }

      function toolTable(tools) {
        if (!tools || !tools.length) return null;
        var table = el('table');
        var thead = el('thead');
        var hr = el('tr');
        ['工具', '调用次数', '错误', '执行器', '权限边界'].forEach(function (t) { hr.appendChild(el('th', '', t)); });
        thead.appendChild(hr); table.appendChild(thead);
        var tbody = el('tbody');
        tools.forEach(function (tool) {
          var tr = el('tr');
          tr.appendChild(el('td', '', tool.toolName));
          tr.appendChild(el('td', '', tool.count));
          tr.appendChild(el('td', '', tool.errors));
          tr.appendChild(el('td', '', (tool.executors || []).join(', ')));
          tr.appendChild(el('td', '', (tool.permissionBoundaries || []).join(', ')));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
      }

      function renderRun(run) {
        var card = el('div', 'run-card');
        var head = el('div', 'run-head');
        head.appendChild(el('span', 'run-title', run.runId));
        var completion = run.completion || {};
        head.appendChild(statusPill(completion.status));
        if (run.channel) head.appendChild(el('span', 'pill', run.channel));
        if (completion.elapsedMs) head.appendChild(el('span', 'pill', (completion.elapsedMs / 1000).toFixed(1) + ' s'));
        card.appendChild(head);

        var prompt = run.prompt || {};
        var context = run.context || {};
        var grid = el('div', 'grid');
        grid.appendChild(stat('模型', prompt.model || prompt.provider));
        grid.appendChild(stat('开始时间', fmtTime(run.startedAt)));
        grid.appendChild(stat('技能命中', (context.matchedSkills || []).join(', ')));
        grid.appendChild(stat('记忆写入', context.memoryWriteCount + ' 条' + ((context.memoryWriteKinds || []).length ? '（' + context.memoryWriteKinds.join('/') + '）' : '')));
        grid.appendChild(stat('附件', context.attachmentsCount));
        grid.appendChild(stat('注册工具数', (run.registeredTools || []).length));
        card.appendChild(grid);

        if (
          completion.errorCategory ||
          completion.errorDetail ||
          (completion.failedToolNames || []).length
        ) {
          var failureBits = [];
          if (completion.errorCategory) failureBits.push('分类：' + completion.errorCategory);
          if ((completion.failedToolNames || []).length) {
            failureBits.push('失败工具：' + completion.failedToolNames.join(', '));
          }
          if (completion.errorDetail) failureBits.push('详情：' + completion.errorDetail);
          card.appendChild(el('div', 'sub failure-diagnostics', failureBits.join(' · ')));
        }

        var deliveries = run.channelDeliveries || {};
        if (deliveries.attempts) {
          card.appendChild(el('div', 'sub', '渠道投递：尝试 ' + deliveries.attempts + ' · 失败 ' + deliveries.failures));
        }
        var table = toolTable(run.tools || []);
        if (table) {
          card.appendChild(el('div', 'sub', '工具调用明细'));
          card.appendChild(table);
        }
        return card;
      }

      async function load() {
        var sessionId = sessionInput.value.trim();
        runsBox.replaceChildren();
        if (!sessionId) { notice('请输入会话 sessionId。', true); return; }
        notice('正在读取会话 Trace…');
        // 兼容 /rdkstudio 等部署前缀：base 与本页 pathname 同源推导。
        var base = location.pathname.replace(/\/session-trace\/?$/, '');
        var url = base + '/api/agent/session-observability?sessionId=' + encodeURIComponent(sessionId);
        var deviceId = deviceInput.value.trim();
        if (deviceId) url += '&deviceId=' + encodeURIComponent(deviceId);
        try {
          var res = await fetch(url, { credentials: 'include' });
          if (res.status === 401 || res.status === 403) {
            notice('尚未登录或无权限：请先在 RDK Studio 工作台登录后再查看。', true);
            return;
          }
          if (res.status === 404) { notice('设备不存在或不属于当前账号。', true); return; }
          var body = await res.json().catch(function () { return {}; });
          if (!res.ok) { notice(String(body.error || '读取失败'), true); return; }
          var runs = Array.isArray(body.runs) ? body.runs : [];
          statusBox.replaceChildren();
          if (!runs.length) {
            runsBox.appendChild(el('div', 'empty', '该会话暂无 run 观测记录（可能尚未发起过 Agent 运行，或服务重启后内存观测已清空）。'));
            return;
          }
          runs.forEach(function (run) { runsBox.appendChild(renderRun(run)); });
        } catch (e) {
          notice('请求失败：' + (e instanceof Error ? e.message : String(e)), true);
        }
      }

      document.getElementById('load').addEventListener('click', load);
      sessionInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });

      if (sessionInput.value) load();
    })();
  </script>
</body>
</html>`;
