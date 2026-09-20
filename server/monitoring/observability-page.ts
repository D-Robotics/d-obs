import { OPS_OBSERVABILITY_STYLE } from './observability-page-style.js';
import {
  OPS_OBSERVABILITY_PALETTE_DARK,
  OPS_OBSERVABILITY_PALETTE_LIGHT,
} from './observability-page-palette.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW } from './observability-page-script-overview.js';
import { OPS_OBSERVABILITY_SCRIPT_B } from './observability-page-script-b.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_SLO } from './observability-page-script-slo.js';
import { OPS_OBSERVABILITY_SCRIPT_MODEL_POOL } from './observability-page-script-model-pool.js';
import { OPS_OBSERVABILITY_SCRIPT_INVESTIGATION } from './observability-page-script-investigation.js';
import { OPS_OBSERVABILITY_SCRIPT_USABILITY } from './observability-page-script-usability.js';
import { OPS_OBSERVABILITY_SCRIPT_COPILOT } from './observability-page-script-copilot.js';
import { OPS_TENANT_SCOPE_JS } from './observability-page-tenant-scope.js';
import { OPS_OBSERVABILITY_COPILOT_STYLE } from './observability-page-copilot-style.js';
import { OPS_OBSERVABILITY_INVESTIGATION_STYLE } from './observability-page-investigation-style.js';
import { OPS_OBSERVABILITY_ACTION_LOOP_STYLE } from './observability-page-action-loop-style.js';
import { OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT } from './observability-page-action-loop.js';
import { OPS_OBSERVABILITY_SLO_STYLE } from './observability-page-slo-style.js';
import { OPS_OBSERVABILITY_SCRIPT_TRACES } from './observability-page-script-traces.js';
import { OPS_OBSERVABILITY_SCRIPT_OBJECTS } from './observability-page-script-objects.js';
import {
  OPS_OBSERVABILITY_VERSION_DISTRIBUTION_SCRIPT,
  OPS_OBSERVABILITY_VERSION_DISTRIBUTION_STYLE,
} from './observability-page-version-distribution.js';
import { OPS_OBSERVABILITY_UNIFIED_STYLE } from './observability-page-unified-style.js';
import { OPS_OBSERVABILITY_TRACES_STYLE } from './observability-page-traces-style.js';
import { OPS_OBSERVABILITY_DATABASE_STYLE } from './observability-page-database-style.js';
import { OPS_OBSERVABILITY_SCRIPT_DATABASE } from './observability-page-script-database.js';
import { OPS_OBSERVABILITY_SCRIPT_DATABASE_GRAPH } from './observability-page-script-database-graph.js';
import {
  OPS_OBSERVABILITY_LEARNING_STYLE,
  OPS_OBSERVABILITY_SCRIPT_LEARNING,
} from './observability-page-learning.js';
import {
  OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE,
  OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS,
} from './observability-page-operator-metrics.js';
import {
  OPS_OBSERVABILITY_COCKPIT_STYLE,
  OPS_OBSERVABILITY_COCKPIT_SCRIPT,
} from './observability-page-cockpit.js';
import {
  OPS_OBSERVABILITY_UX_STYLE,
  OPS_OBSERVABILITY_SCRIPT_UX,
} from './observability-page-ux.js';
import {
  OPS_OBSERVABILITY_MOBILE_TOUR_STYLE,
  OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR,
} from './observability-page-mobile-tour.js';
import { OPS_OBSERVABILITY_PRODUCT_STYLE } from './observability-page-product-style.js';
import { OPS_OBSERVABILITY_BRAND_STYLE } from './observability-page-brand-style.js';
import {
  OPS_OBSERVABILITY_TENANTS_STYLE,
  OPS_OBSERVABILITY_SCRIPT_TENANTS,
} from './observability-page-tenants.js';
import { OPS_OBSERVABILITY_SIGNALS_STYLE } from './observability-page-signals-style.js';
import { OPS_OBSERVABILITY_SCRIPT_SIGNALS } from './observability-page-script-signals.js';

/**
 * 独立生产可观测与告警工作台。
 *
 * HTML 壳不包含运维数据；所有动态内容通过受运营权限保护的 API 获取。
 * 页面只使用安全 DOM API 渲染服务端数据，避免把告警摘要当作 HTML 执行。
 */
export const OPS_OBSERVABILITY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>d-obs · 可观测中心</title>
  <script>
    // 这是唯一的可观测工作台入口；无 hash 时只补上默认总览锚点，不再跳回第二套 UI。
    (function () {
      if (location.hash === '') {
        history.replaceState(null, '', location.pathname + location.search + '#overview');
      }
      // 主题在首帧前恢复，避免暗色偏好下白闪（FOUC）。
      try {
        if (localStorage.getItem('ops-theme') === 'dark') {
          document.documentElement.dataset.theme = 'dark';
        }
      } catch (e) { /* localStorage 不可用（隐私模式等）则默认亮色 */ }
    })();
  </script>
  <style>${OPS_OBSERVABILITY_PALETTE_LIGHT + '\n' + OPS_OBSERVABILITY_PALETTE_DARK + '\n' + OPS_OBSERVABILITY_STYLE + '\n' + OPS_OBSERVABILITY_SLO_STYLE + '\n' + OPS_OBSERVABILITY_UNIFIED_STYLE + '\n' + OPS_OBSERVABILITY_INVESTIGATION_STYLE + '\n' + OPS_OBSERVABILITY_COPILOT_STYLE + '\n' + OPS_OBSERVABILITY_TRACES_STYLE + '\n' + OPS_OBSERVABILITY_DATABASE_STYLE + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_STYLE + '\n' + OPS_OBSERVABILITY_LEARNING_STYLE + '\n' + OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE + '\n' + OPS_OBSERVABILITY_COCKPIT_STYLE + '\n' + OPS_OBSERVABILITY_UX_STYLE + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_STYLE + '\n.detail-sections{margin-top:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}.detail-summary{cursor:pointer;display:flex;align-items:center;gap:9px;padding:12px 16px;color:var(--text);font-size:12px}.detail-summary span{color:var(--muted);font-weight:400}.detail-sections[open]>.detail-summary{border-bottom:1px solid var(--line)}.detail-sections>*:not(.detail-summary){margin:12px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.model-pool-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}.model-pool-toolbar h2{margin:0 0 4px}.model-pool-toolbar p{margin:0;color:var(--muted);font-size:11px}.model-pool-editor{padding:16px}.model-pool-editor .section-head{margin-bottom:12px}.model-pool-editor .fields{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:10px}.model-pool-editor .field.full{grid-column:1/-1}.model-pool-summary{margin-bottom:12px}.domain-switcher{display:flex;align-items:center;gap:4px;margin-left:auto;margin-right:12px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}.domain-tab{border:0;border-radius:7px;padding:7px 12px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.domain-tab[aria-selected="true"]{background:var(--accent);color:#fff;font-weight:700}.domain-hint{color:var(--muted);font-size:11px;white-space:nowrap}.domain-note{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--muted);font-size:12px}.domain-note strong{color:var(--text)}' + OPS_OBSERVABILITY_PRODUCT_STYLE + '\n' + OPS_OBSERVABILITY_MOBILE_TOUR_STYLE + '\n' + OPS_OBSERVABILITY_TENANTS_STYLE + '\n' + OPS_OBSERVABILITY_SIGNALS_STYLE + '\n' + OPS_OBSERVABILITY_BRAND_STYLE}</style>
</head>
<body class="ops-observability">
  <a class="skip-link" href="#mainContent">跳到主要内容</a>
  <header>
    <div class="brand"><div class="brand-mark" aria-hidden="true">d</div><div class="brand-copy">可观测中心<small>d-obs · Reliability Operations</small></div></div>
    <div id="domainSwitcher" class="domain-switcher" role="tablist" aria-label="观测数据域"><button class="domain-tab" data-domain-tab="cloud" type="button" role="tab" aria-selected="true">云侧</button><button class="domain-tab" data-domain-tab="edge" type="button" role="tab" aria-selected="false">端侧</button><span id="domainHint" class="domain-hint">RDK Studio · 服务 · 服务器</span></div>
    <button id="themeToggle" class="theme-toggle" type="button" title="切换亮色 / 暗色主题" aria-label="切换主题">◐</button>
    <div id="headerTelemetryStatus" class="header-live unknown" role="status" aria-live="polite">Telemetry 未确认</div>
  </header>
  <div class="app-shell">
    <aside class="side-nav">
      <nav class="global-nav" aria-label="可观测中心入口">
        <a class="global-tab active" href="./ops-observability#overview" aria-current="page">可观测中心</a>
      </nav>
      <nav class="module-tabs" aria-label="可观测中心模块">
        <div class="nav-primary">
          <button class="module-tab" data-view="overview" aria-controls="view-overview" title="判断生产是否影响用户，并查看当前待办">运营总览<span id="overviewCount" class="tab-count" title="进行中事故数" hidden>—</span></button>
          <button class="module-tab" data-view="operator-metrics" aria-controls="view-operator-metrics" title="查看新增用户、DAU、对话次数和 Agent Run 趋势">用户增长</button>
        </div>
        <details class="nav-group" id="nav-group-core" data-nav-group="core">
          <summary class="nav-section-toggle" aria-controls="nav-group-core-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">处置与证据</span><span class="nav-group-alert" id="navCoreAlert" hidden></span></summary>
          <div class="nav-group-items" id="nav-group-core-items">
            <button class="module-tab" data-view="investigate" aria-controls="view-investigate" title="从异常、证据和影响范围定位事故">事故调查<span id="incidentCount" class="tab-count" title="进行中事故数">—</span></button>
            <button class="module-tab" data-view="alerts" aria-controls="view-alerts" title="维护告警规则、阈值和通知路由">告警策略<span id="ruleCount" class="tab-count">—</span></button>
            <button class="module-tab" data-view="traces" aria-controls="view-traces" title="从事故证据下钻单次 Agent 与会话运行">链路追踪</button>
            <button class="module-tab" data-view="service-levels" aria-controls="view-service-levels" title="查看用户旅程 SLO、错误预算和风险目标">SLO 与错误预算</button>
          </div>
        </details>
        <details class="nav-group" id="nav-group-data" data-nav-group="data">
          <summary class="nav-section-toggle" aria-controls="nav-group-data-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">数据与资产</span></summary>
          <div class="nav-group-items" id="nav-group-data-items">
            <button class="module-tab" data-view="signals" aria-controls="view-signals" title="查询 OTLP 指标与日志，维护自定义面板">观测查询</button>
            <button class="module-tab" data-view="devices" aria-controls="view-devices" title="查看边缘设备心跳、在线状态与板级指标">边缘设备</button>
            <button class="module-tab" data-view="data-health" aria-controls="view-data-health" title="查看关键业务数据是否持续入库">数据健康</button>
            <button class="module-tab" data-view="database" aria-controls="view-database" title="查看 PostgreSQL 运行状态、关系与数据表">数据库</button>
            <a class="module-tab" href="/dobs/prometheus/graph" target="_blank" rel="noopener noreferrer" title="在 Prometheus 中使用 PromQL 查询时序指标">Prometheus 查询</a>
          </div>
        </details>
        <details class="nav-group" id="nav-group-learning" data-nav-group="learning">
          <summary class="nav-section-toggle" aria-controls="nav-group-learning-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">学习与进化</span></summary>
          <div class="nav-group-items" id="nav-group-learning-items">
            <button class="module-tab" data-view="skill-loop" aria-controls="view-skill-loop" title="查看 Skill 埋点、运行反馈、候选审核和发布回流">Skill 数据闭环<span id="skillLoopCount" class="tab-count" title="待人工审核数量">—</span></button>
            <button class="module-tab" data-view="evolution" aria-controls="view-evolution" title="查看每日自我进化的证据、质量闸门和候选">每日自我进化<span id="evolutionCount" class="tab-count" title="待审核候选数量">—</span></button>
          </div>
        </details>
        <details class="nav-group" id="nav-group-advanced" data-nav-group="advanced">
          <summary class="nav-section-toggle" aria-controls="nav-group-advanced-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">系统配置</span></summary>
          <div class="nav-group-items" id="nav-group-advanced-items">
            <button class="module-tab" data-view="model-pool" aria-controls="view-platform" title="查看模型池目标健康、路由优先级与网关容量">模型池</button>
            <button class="module-tab" data-view="tenants" aria-controls="view-tenants" title="注册接入团队、轮换探针 token、停用或启用租户">租户管理</button>
            <button class="module-tab" data-view="platform" aria-controls="view-platform" title="低频全局配置，改动会影响巡检">系统设置</button>
          </div>
        </details>
      </nav>
    </aside>
    <main id="mainContent" tabindex="-1">
    <div class="page-head">
      <div class="page-head-copy"><div id="pageKicker" class="page-kicker">可观测中心 / 总览</div><h1 id="pageTitle">生产可观测与告警</h1><p id="pageIntro" class="page-intro">先判断生产影响，再处理事故、维护告警，最后下钻到链路证据。</p><p id="fresh" role="status" aria-live="polite">正在读取策略与巡检状态…</p></div>
      <div class="page-head-actions"><span class="env-pill">production</span><button id="runChecks" class="btn" type="button">立即评估</button><button id="refresh" class="btn" type="button">刷新数据</button></div>
    </div>
    <div id="overviewScopeBar" class="scope-bar" role="region" aria-label="总览与 Trace 共用观察范围">
      <div class="scope-copy"><strong>可靠性证据范围</strong><span>production</span><small>仅总览 / Trace 继承</small></div>
      <label class="scope-control" for="overviewWindow">时间窗口<select id="overviewWindow" aria-label="选择总览与 Trace 时间窗口"><option value="2">最近 2 小时</option><option value="24" selected>最近 24 小时</option><option value="168">最近 7 天</option></select></label>
      <span id="scopeStatus" class="scope-status unknown" role="status" aria-live="polite">等待真实数据</span>
    </div>
    <div class="global-command-bar" role="region" aria-label="快速导航">
      <button id="globalSearchTrigger" class="global-search-trigger" type="button" aria-haspopup="dialog" aria-controls="commandPaletteBackdrop"><span class="global-search-copy"><strong>快速搜索</strong><small>指标、事故、Trace、SLO 或任意模块</small></span><kbd>⌘ K</kbd></button>
      <div class="workspace-facts" aria-label="工作区状态"><span id="globalIncidentFact" class="workspace-fact"><strong>— 个进行中</strong></span><span id="globalFreshnessFact" class="workspace-fact">等待评估</span><span id="globalViewFact" class="workspace-fact">当前视图</span></div>
    </div>
    <section id="view-overview" class="view hidden" aria-labelledby="overviewHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 总览</div><h2 id="overviewHeading">当前态势与行动</h2><p>先看用户影响和待办，再按证据进入对应调查链路。</p></div><div class="right" id="overviewWindowLabel">统一窗口 · 最近 24 小时</div></div>
      <div class="domain-note"><strong>云侧数据域</strong>　RDK Studio、d-obs、OTLP gateway、服务器资源与云端应用链路。</div>
      <div id="overviewContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在汇总生产态势</strong><small>读取检查、事故、通知与审计数据…</small></div></div>
    </section>
    <section id="view-service-levels" class="view hidden" aria-labelledby="serviceLevelsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / SLO</div><h2 id="serviceLevelsHeading">SLO 与错误预算</h2><p>用 28 天用户旅程定义目标；内部参考线只用于运营判断，不构成合同 SLA。</p></div><div class="right" id="serviceLevelPolicyVersion">策略版本由服务端返回</div></div>
      <div id="serviceLevelContent" class="overview-stack" aria-live="polite"></div>
    </section>
    <section id="view-signals" class="view hidden" aria-labelledby="signalsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 观测查询</div><h2 id="signalsHeading">指标、日志与自定义面板</h2><p>查询 OTLP 落库的指标与日志，把常用查询保存为面板；深度历史仍可到 Prometheus 查询。</p></div><div class="right">OTLP 落库 · 管理员只读</div></div>
      <details id="signals-metrics" class="detail-sections" open><summary class="detail-summary"><strong>指标查询</strong><span>OTLP metrics 持久化后的平台内查询</span></summary>
        <div class="signals-toolbar">
          <label>指标名<input id="signalMetricInput" list="signalMetricList" type="text" autocomplete="off" spellcheck="false" placeholder="如 rdk_ai_otlp_spans_received_total" /><datalist id="signalMetricList"></datalist></label>
          <label>时间窗口<select id="signalMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option></select></label>
          <button id="signalQueryBtn" class="btn primary" type="button">查询</button>
          <button id="signalSavePanelBtn" class="btn" type="button">保存为面板</button>
        </div>
        <div id="signalsMetricChart" class="signals-chart-wrap" aria-live="polite"><div class="signals-empty">输入指标名并点击查询</div></div>
      </details>
      <details id="signals-logs" class="detail-sections" open><summary class="detail-summary"><strong>日志查询</strong><span>OTLP logs 落库后的平台内检索（低敏感字段）</span></summary>
        <div class="signals-toolbar">
          <label>服务<input id="signalLogService" type="text" autocomplete="off" spellcheck="false" placeholder="service.name，可留空" /></label>
          <label>最低级别<select id="signalLogSeverity"><option value="1">全部</option><option value="9" selected>INFO+</option><option value="13">WARN+</option><option value="17">ERROR+</option></select></label>
          <label>时间窗口<select id="signalLogMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option></select></label>
          <button id="signalLogQueryBtn" class="btn primary" type="button">查询</button>
        </div>
        <div id="signalsLogTable" aria-live="polite"><div class="signals-empty">设置条件并点击查询</div></div>
      </details>
      <details id="signals-panels" class="detail-sections" open><summary class="detail-summary"><strong>自定义面板</strong><span>保存的常用指标查询，一屏总览</span></summary>
        <div id="signalsPanelGrid" class="signals-panel-grid" aria-live="polite"><div class="signals-empty">正在读取面板…</div></div>
      </details>
      <details id="signals-quality" class="detail-sections" open><summary class="detail-summary"><strong>质量与反馈</strong><span>run 级评分与用户反馈的按天趋势</span></summary>
        <div id="signalsQualityContent" aria-live="polite"><div class="signals-empty">正在读取质量趋势…</div></div>
      </details>
    </section>
    <section id="view-devices" class="view hidden" aria-labelledby="devicesHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 边缘设备</div><h2 id="devicesHeading">边缘设备与心跳</h2><p>注册 RDK 板级设备、查看心跳与在线状态，下钻板级指标（CPU / 内存 / 温度 / BPU）。</p></div><div class="right">设备 token 只显示一次</div></div>
      <div class="domain-note"><strong>端侧数据域</strong>　机器人、RDK 板、固件和 edge-agent 样本；端侧 Prometheus 查询使用 <code>plane="edge"</code>。</div>
      <details id="devices-register" class="detail-sections" open><summary class="detail-summary"><strong>注册设备</strong><span>签发设备 token 并部署 edge-agent</span></summary>
        <div class="signals-toolbar">
          <label>设备 ID<input id="newDeviceId" type="text" autocomplete="off" spellcheck="false" placeholder="如 rdk-x5-01" /></label>
          <label>显示名称<input id="newDeviceName" type="text" autocomplete="off" placeholder="可留空" /></label>
          <label>型号<input id="newDeviceModel" type="text" autocomplete="off" placeholder="如 RDK X5 / S600" /></label>
          <button id="registerDeviceBtn" class="btn primary" type="button">注册设备</button>
        </div>
        <div id="newDeviceTokenHint" class="token-reveal hidden"></div>
        <div class="hint">板端部署：把 <code>tools/edge-agent.mjs</code> 复制到设备，token 存入文件，配置 <code>RDK_OBS_REPORT_URL</code> 与 <code>RDK_DEVICE_TOKEN_FILE</code> 后运行（或挂载 systemd 单元）；弱网时样本会缓冲在设备本地并自动补传。</div>
      </details>
      <details id="devices-list" class="detail-sections" open><summary class="detail-summary"><strong>设备清单</strong><span>在线状态、最近心跳与板级指标下钻</span></summary><div id="devicesContent" aria-live="polite"><div class="signals-empty">正在读取设备清单…</div></div></details>
    </section>
    <section id="view-data-health" class="view hidden" aria-labelledby="dataHealthHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 数据健康</div><h2 id="dataHealthHeading">业务数据新鲜度</h2><p>检查关键业务数据是否持续入库，只展示数量、趋势和最近写入时间。</p></div><div class="right">业务入库 · 只读聚合</div></div>
      <div id="dataHealthContent" class="database-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取数据健康状态</strong><small>仅查询聚合数量和最近写入时间…</small></div></div>
    </section>
    <section id="view-operator-metrics" class="view hidden" aria-labelledby="operatorMetricsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 用户增长</div><h2 id="operatorMetricsHeading">用户增长</h2><p>在同一套可观测数据里查看新增用户、DAU、对话次数和 Agent Run，判断用户从注册到使用的增长趋势。</p></div><div id="operatorMetricsWindowLabel" class="right">近 30 天 · 独立运营窗口</div></div>
      <div id="operatorMetricsContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取运营指标</strong><small>汇总中心库日粒度数据…</small></div></div>
    </section>
    <section id="view-database" class="view hidden" aria-labelledby="databaseHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 数据库</div><h2 id="databaseHeading">PostgreSQL 运行与资产</h2><p>查看运行状态、库表关系与表维护状态。</p></div><div class="right">中心 PG · 全程只读</div></div>
      <div id="databaseContent" class="database-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取数据库状态</strong><small>查询运行指标、关系和表资产…</small></div></div>
    </section>
    <section id="view-skill-loop" class="view hidden" aria-labelledby="skillLoopHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 学习与进化</div><h2 id="skillLoopHeading">Skill 数据闭环</h2><p>把埋点采集、运行反馈、候选证据、审核发布和命中率放在同一条可追溯链路。</p></div><div class="right">近 30 天 · 独立学习窗口</div></div>
      <div id="skillLoopContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取 Skill 数据闭环</strong><small>汇总事件埋点、运行经验和 Skill 台账…</small></div></div>
    </section>
    <section id="view-evolution" class="view hidden" aria-labelledby="evolutionHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 学习与进化</div><h2 id="evolutionHeading">每日自我进化</h2><p>查看证据聚合、质量闸门和可审核候选；候选从匿名失败信号生成，需要人工审核，不会直接修改生产代码、自动部署或降低质量闸门。</p></div><div class="right">CANDIDATE ONLY · 只读观测 <button id="runEvolution" class="btn primary" type="button">立即生成候选</button></div></div>
      <div id="evolutionModuleContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取每日自我进化</strong><small>汇总进化 worker、运行经验和候选状态…</small></div></div>
      <div id="evolutionContent" class="overview-stack hidden"></div>
    </section>
    <section id="view-investigate" class="view hidden" aria-labelledby="investigationHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 事故调查</div><h2 id="investigationHeading">异常、证据与影响范围</h2><p>形成可复核的根因假设；只读调查，不直接执行处置。</p></div><div class="right">证据先行 · 只读调查</div></div>
      <div id="investigationContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在建立调查视图</strong><small>关联异常趋势、代表事件与影响范围…</small></div></div>
    </section>
    <section id="view-traces" class="view hidden" aria-labelledby="tracesHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 链路追踪</div><h2 id="tracesHeading">单次运行证据链</h2><p>定位单次 Agent / 会话运行，适合从事故证据继续下钻。</p></div><div class="right">只读调查</div></div>
      <div id="nativeTraceContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取链路证据</strong><small>加载运行、模型、工具调用和审批记录…</small></div></div>
      <details id="traces-agent" class="detail-sections"><summary class="detail-summary"><strong>Agent Trace</strong><span>调用树、token 成本与工具调用</span></summary>__LANGFUSE_DASHBOARD_EMBED__</details>
      <details id="traces-session" class="detail-sections"><summary class="detail-summary"><strong>会话 Trace</strong><span>按 sessionId 查看 run、模型、工具与审批</span></summary><div class="right">数据按登录账号隔离</div><div class="notice">standalone d-obs 不承载 Agent 会话观测（没有 <code>/api/agent/session-observability</code>）：请用上方「单次运行证据链」按运行/会话筛选与下钻，或到业务站的会话 Trace 页查看完整链路。</div></details>
    </section>
    <section id="view-tenants" class="view hidden" aria-labelledby="tenantsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 租户管理</div><h2 id="tenantsHeading">团队接入与探针凭据</h2><p>注册租户、签发与轮换探针 token、停用或启用团队；所有操作均写入审计日志。</p></div><div class="right">探针 token 仅显示一次</div></div>
      <details class="detail-sections" open><summary class="detail-summary"><strong>创建租户</strong><span>为新团队创建租户并签发探针 token</span></summary>
        <div class="tenant-toolbar">
          <label class="field">租户 ID<input id="newTenantId" type="text" autocomplete="off" spellcheck="false" placeholder="如 sim2real、team-a" /></label>
          <label class="field">显示名称<input id="newTenantName" type="text" autocomplete="off" placeholder="团队或项目名，可用中文，可留空" /></label>
          <button id="createTenantBtn" class="btn primary" type="button">创建租户</button>
        </div>
        <div id="newTenantIdHint" class="hint">租户 ID 是标识符不是名字：它会拼进告警键 <code>t.&lt;ID&gt;.&lt;检查项&gt;</code>（点作分隔符），并出现在 URL 与请求头里，因此只能用小写 ASCII 字母/数字/连字符（2–40 字符，需字母开头；<code>platform</code> 等保留字不可用）。中文名请填「显示名称」。</div>
      </details>
      <details class="detail-sections" open><summary class="detail-summary"><strong>租户列表</strong><span>状态、最近上报时间与凭据操作</span></summary><div id="tenantsContent"></div></details>
    </section>
    <section id="view-platform" class="view hidden" aria-labelledby="platformHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 系统设置</div><h2 id="platformHeading">全局巡检与运行配置</h2><p>低频高级配置；改动会影响全局巡检、模型路由与通知。</p></div><div class="right">敏感配置只保存在服务器</div></div>
      <details id="platform-model" class="detail-sections"><summary class="detail-summary"><strong>模型池</strong><span>运行状态、容量与模型配置</span></summary><div id="modelPoolContent"></div></details>
      <details id="platform-settings" class="detail-sections" open><summary class="detail-summary"><strong>系统配置</strong><span>评估器、真实业务拨测和日志采集签名</span></summary><div id="settingsContent"></div></details>
    </section>
    <section id="view-alerts" class="view hidden" aria-labelledby="alertsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 告警策略</div><h2 id="alertsHeading">检测、阈值与通知</h2><p>维护规则、阈值和通知路由；事故处置请进入“事故调查”。</p></div><div class="right">按规则独立窗口 · 每分钟评估</div></div>
      <details id="alerts-metrics" class="detail-sections"><summary class="detail-summary"><strong>指标管理与数据源</strong><span><span id="metricCount">—</span> 项指标 · 按需核对状态和阈值</span></summary><div id="metricsContent"></div></details>
      <details id="alerts-rules" class="detail-sections" open><summary class="detail-summary"><strong>告警策略</strong><span>指标、日志与拨测规则</span></summary>
        <div class="panel strategy-card"><div class="toolbar"><label class="search-wrap" aria-label="策略搜索"><input id="ruleSearch" class="search" type="text" name="ops-observability-rule-filter" autocomplete="off" data-lpignore="true" data-1p-ignore="true" readonly placeholder="请输入策略名称或数据源" /></label><div class="filter-anchor"><button id="filterTrigger" class="btn filter-trigger" type="button">⌁ <span id="filterText">筛选</span></button><div id="ruleFilters" class="filter-popover hidden"><div class="filter-row"><span>监控类型</span><div id="categoryFilter" class="segmented" aria-label="规则类型筛选"><button data-category="all" class="active">全部</button><button data-category="metric">指标</button><button data-category="log">日志</button><button data-category="probe">拨测</button></div></div><div class="filter-row"><span>策略状态</span><div id="statusFilter" class="segmented" aria-label="策略状态筛选"><button data-status="all" class="active">全部</button><button data-status="enabled">生效</button><button data-status="disabled">停用</button></div></div><div class="filter-footer"><button id="clearFilters" class="filter-clear" type="button">清空全部条件</button><button id="closeFilters" class="btn primary" type="button">关闭</button></div></div></div></div>
          <div id="ruleSummary" class="rule-summary" aria-label="告警策略摘要"></div><div class="rules-panel"><div class="rules-head"><div>策略名称 / 数据源</div><div>监控类型</div><div>触发条件</div><div>执行周期</div><div>通知模板</div><div>告警启停</div><div>操作</div></div><div id="rulesList"></div></div>
        </div>
      </details>
      <details id="alerts-objects" class="detail-sections advanced-section"><summary class="detail-summary"><strong>告警对象</strong><span><span id="objectCount">—</span> 个对象 · <span id="objectStatusCount">—</span> 个当前筛选 · 对象详情固定 24 小时 · 不继承总览窗口</span></summary><div class="notice">这里是对象注册表和对象选择入口；点击左侧对象即可查看最近 run、标签与归属信息。</div><div class="hint" style="margin:0 12px 12px">最近同步：<span id="objectLoadedAt">—</span></div><div id="objectsContent"></div></details>
      <details id="alerts-channels" class="detail-sections"><summary class="detail-summary"><strong>通知模板</strong><span><span id="channelCount">—</span> 个渠道 · 路由、降噪与恢复通知</span></summary><div id="templateSummary"></div><div class="notice">策略可继承默认发送模板，也可直接绑定指定渠道；模板未配置时只评估和记录，不会误判为已投递。</div><div id="templateEditorZone" class="template-editor-zone hidden"><div class="template-editor-head"><div><h3>编辑通知模板</h3><span>修改发送策略、降噪规则和渠道凭据</span></div><button id="closeTemplateEditor" class="btn" type="button">收起编辑</button></div><div id="policyContent"></div><div id="channelContent" class="channel-grid"></div></div></details>
    </section>
    </main>
  </div>
  <div id="ruleDrawer" class="drawer-backdrop" role="dialog" aria-modal="true" aria-label="编辑告警策略">
    <aside class="drawer">
      <div class="drawer-head"><div><h2 id="editorTitle">编辑告警策略</h2><p id="editorSubtitle"></p></div><button id="closeEditor" class="btn">关闭</button></div>
      <div id="editorBody" class="drawer-body"></div>
      <div class="drawer-foot"><span id="editorFeedback" class="feedback"></span><button id="testRule" class="btn">测试已保存规则</button><button id="cancelEditor" class="btn">取消</button><button id="saveRule" class="btn primary">保存策略</button></div>
    </aside>
  </div>
  <div id="eventDrawer" class="event-drawer-backdrop" role="dialog" aria-modal="true" aria-label="事件调查详情" aria-hidden="true">
    <aside class="event-drawer">
      <div class="event-drawer-head"><div class="event-drawer-heading"><div class="page-kicker">故障调查 / 单事件证据</div><h2 id="eventDrawerTitle">事件上下文</h2><div id="eventDrawerMeta" class="event-drawer-meta" aria-live="polite"></div></div><div class="event-drawer-actions"><button id="focusSimilarEvents" class="btn primary" type="button">聚焦同类异常</button><button id="copyEventId" class="btn" type="button" disabled>复制证据 ID</button><button id="closeEventDrawer" class="btn" type="button" aria-label="关闭事件详情">关闭</button></div></div>
      <div id="eventDrawerBody" class="event-drawer-body" aria-live="polite"></div>
    </aside>
  </div>
  <div id="commandPaletteBackdrop" class="command-palette-backdrop" role="dialog" aria-modal="true" aria-labelledby="commandPaletteTitle" aria-hidden="true">
    <section class="command-palette"><div class="command-palette-head"><div class="command-palette-head-copy"><h2 id="commandPaletteTitle">跳转到可观测模块</h2><p>按任务进入，当前上下文和登录权限保持不变。</p></div><button id="closeCommandPalette" class="btn command-palette-close" type="button">关闭</button></div><label class="command-search-wrap" aria-label="搜索模块"><input id="commandPaletteSearch" class="command-search" type="search" autocomplete="off" placeholder="搜索事故、告警、Trace、SLO…" /></label><div id="commandPaletteResults" class="command-results" role="listbox" aria-label="可观测模块结果"></div><div class="command-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></div></section>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>
  <script>${OPS_TENANT_SCOPE_JS + OPS_OBSERVABILITY_SCRIPT_A + '\n' + OPS_OBSERVABILITY_SCRIPT_INVESTIGATION + '\n' + OPS_OBSERVABILITY_SCRIPT_USABILITY + '\n' + OPS_OBSERVABILITY_SCRIPT_COPILOT + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE_GRAPH + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_SCRIPT_MODEL_POOL + '\n' + OPS_OBSERVABILITY_SCRIPT_SLO + '\n' + OPS_OBSERVABILITY_SCRIPT_OBJECTS + '\n' + OPS_OBSERVABILITY_SCRIPT_B + '\n' + OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS + '\n' + OPS_OBSERVABILITY_SCRIPT_LEARNING + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_SCRIPT + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_UX + '\n' + OPS_OBSERVABILITY_SCRIPT_SIGNALS + '\n' + OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR + '\n' + OPS_OBSERVABILITY_SCRIPT_TENANTS + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_C}</script>
</body>
</html>`;
