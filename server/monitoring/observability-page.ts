import { OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT, OPS_OBSERVABILITY_ALERT_EVIDENCE_STYLE } from './observability-page-alert-evidence.js';
import { PLUGIN_CENTER_HTML, PLUGIN_CENTER_STYLE, PLUGIN_CENTER_SCRIPT } from './observability-page-plugins.js';
import { PLUGIN_CENTER_SHELL_SCRIPT } from './observability-page-plugin-shell.js';
import { COLLECTION_WORKSPACE_HTML, COLLECTION_WORKSPACE_STYLE, COLLECTION_WORKSPACE_SCRIPT } from './collection-workspace-page.js';
import { DATA_CENTER_WORKSPACE_HTML, DATA_CENTER_WORKSPACE_STYLE, DATA_CENTER_WORKSPACE_SCRIPT } from './data-center-page.js';
import { integrateCollectionScriptA, integrateCollectionNavScript, COLLECTION_SHELL_IDENTITY_SCRIPT, COLLECTION_SHELL_STYLE } from './observability-page-collection-integration.js';
import { OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT, OPS_OBSERVABILITY_SIMPLE_NAV_STYLE, simplifyMobileTourScript } from './observability-page-simple-nav.js';
import { OPS_OBSERVABILITY_SIMPLE_OVERVIEW_SCRIPT, OPS_OBSERVABILITY_SIMPLE_OVERVIEW_STYLE } from './observability-page-simple-overview.js';
import { OPS_OBSERVABILITY_SIMPLE_PRESENTATION_SCRIPT, OPS_OBSERVABILITY_SIMPLE_STYLE } from './observability-page-simple-presentation.js';
import { OPS_OBSERVABILITY_FOCUS_STYLE } from './observability-page-focus-style.js';
import { OPS_OBSERVABILITY_RESTRAINT_STYLE, OPS_OBSERVABILITY_SCRIPT_RESTRAINT } from './observability-page-restraint.js';
import { OPS_OBSERVABILITY_SCRIPT_FOCUS } from './observability-page-focus.js';
import { OPS_OBSERVABILITY_STYLE } from './observability-page-style.js';
import { OPS_OBSERVABILITY_HIERARCHY_STYLE, OPS_OBSERVABILITY_SCRIPT_HIERARCHY } from './observability-page-hierarchy.js';
import {
  OPS_OBSERVABILITY_PALETTE_DARK,
  OPS_OBSERVABILITY_PALETTE_LIGHT,
} from './observability-page-palette.js';
import { OPS_OBSERVABILITY_SCRIPT_A } from './observability-page-script-a.js';
import { OPS_OBSERVABILITY_SCRIPT_STRATEGIES } from './observability-page-script-strategies.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW } from './observability-page-script-overview.js';
import { OPS_OBSERVABILITY_SCRIPT_B } from './observability-page-script-b.js';
import { OPS_OBSERVABILITY_SCRIPT_C } from './observability-page-script-c.js';
import { OPS_OBSERVABILITY_SCRIPT_SLO } from './observability-page-script-slo.js';
import { OPS_OBSERVABILITY_SCRIPT_MODEL_POOL } from './observability-page-script-model-pool.js';
import { OPS_OBSERVABILITY_SCRIPT_INVESTIGATION } from './observability-page-script-investigation.js';
import { OPS_OBSERVABILITY_SCRIPT_USABILITY } from './observability-page-script-usability.js';
import { OPS_OBSERVABILITY_SCRIPT_COPILOT } from './observability-page-script-copilot.js';
import { OPS_OBSERVABILITY_ASSISTANT_STYLE, OPS_OBSERVABILITY_SCRIPT_ASSISTANT } from './observability-page-assistant.js';
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
import {
  OPS_OBSERVABILITY_TENANTS_STYLE,
  OPS_OBSERVABILITY_SCRIPT_TENANTS,
} from './observability-page-tenants.js';
import { OPS_OBSERVABILITY_SIGNALS_STYLE } from './observability-page-signals-style.js';
import { OPS_OBSERVABILITY_SCRIPT_SIGNALS } from './observability-page-script-signals.js';
import {
  OPS_OBSERVABILITY_SSH_LOGS_HTML,
  OPS_OBSERVABILITY_SSH_LOGS_STYLE,
  OPS_OBSERVABILITY_SCRIPT_SSH_LOGS,
} from './observability-page-ssh-logs.js';
import {
  OPS_OBSERVABILITY_UI_STYLE,
  OPS_OBSERVABILITY_SCRIPT_UI,
} from './observability-page-ui.js';

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
  <title>d-obs · 总览</title>
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
  <style>${OPS_OBSERVABILITY_PALETTE_LIGHT + '\n' + OPS_OBSERVABILITY_PALETTE_DARK + '\n' + OPS_OBSERVABILITY_STYLE + '\n' + OPS_OBSERVABILITY_SLO_STYLE + '\n' + OPS_OBSERVABILITY_UNIFIED_STYLE + '\n' + OPS_OBSERVABILITY_INVESTIGATION_STYLE + '\n' + OPS_OBSERVABILITY_COPILOT_STYLE + '\n' + OPS_OBSERVABILITY_TRACES_STYLE + '\n' + OPS_OBSERVABILITY_DATABASE_STYLE + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_STYLE + '\n' + OPS_OBSERVABILITY_LEARNING_STYLE + '\n' + OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE + '\n' + OPS_OBSERVABILITY_COCKPIT_STYLE + '\n' + OPS_OBSERVABILITY_UX_STYLE + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_STYLE + '\n.detail-sections{margin-top:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}.detail-summary{cursor:pointer;display:flex;align-items:center;gap:9px;padding:12px 16px;color:var(--text);font-size:12px}.detail-summary span{color:var(--muted);font-weight:400}.detail-sections[open]>.detail-summary{border-bottom:1px solid var(--line)}.detail-sections>*:not(.detail-summary){margin:12px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.model-pool-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}.model-pool-toolbar h2{margin:0 0 4px}.model-pool-toolbar p{margin:0;color:var(--muted);font-size:11px}.model-pool-editor{padding:16px}.model-pool-editor .section-head{margin-bottom:12px}.model-pool-editor .fields{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:10px}.model-pool-editor .field.full{grid-column:1/-1}.model-pool-summary{margin-bottom:12px}.model-pool-actions{display:flex;gap:8px;flex-wrap:wrap}.model-pool-actions .danger,.model-pool-editor .danger,.table-panel .danger{color:var(--danger,#b42318);border-color:color-mix(in srgb,var(--danger,#b42318) 35%,var(--line))}.model-pool-filter{min-width:116px;margin-left:auto}.model-pool-unused{display:inline-flex;padding:3px 7px;border-radius:999px;background:var(--panel2);color:var(--muted);font-size:10px}.model-pool-advanced{padding:0;overflow:hidden}.model-pool-advanced-summary{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;list-style:none}.model-pool-advanced-summary::-webkit-details-marker{display:none}.model-pool-advanced-summary:before{content:"+";color:var(--green);font-size:15px}.model-pool-advanced[open] .model-pool-advanced-summary:before{content:"-"}.model-pool-advanced-summary span{color:var(--muted);font-size:11px;font-weight:400}.model-pool-advanced-body{padding:0 16px 16px;border-top:1px solid var(--line)}.model-pool-subsection{padding-top:16px}.model-pool-subsection+.model-pool-subsection{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}.model-pool-subsection h3{margin:0 0 4px;font-size:14px}.model-pool-subsection .fields{margin-top:12px}.domain-switcher{display:flex;align-items:center;gap:4px;margin-left:auto;margin-right:12px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}.domain-tab{border:0;border-radius:7px;padding:7px 12px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.domain-tab[aria-selected="true"]{background:var(--green);color:var(--c2);font-weight:700}.domain-hint{color:var(--muted);font-size:11px;white-space:nowrap}.domain-note{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--muted);font-size:12px}.domain-note strong{color:var(--text)}.module-switcher{display:flex;gap:4px;margin:0 0 14px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);flex-wrap:wrap}.module-switch-tab{flex:1 1 130px;border:0;border-radius:8px;padding:8px 12px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-align:left}.module-switch-tab small{display:block;margin-top:2px;font-size:10px;font-weight:400;color:inherit;opacity:.75}.module-switch-tab:hover{color:var(--text)}.module-switch-tab.is-active{background:var(--c23);color:var(--green);font-weight:600;box-shadow:inset 0 0 0 1px var(--c56)}.view-module{display:none}.view-module.is-active{display:block}#settingsNotices{display:none;flex-direction:column;gap:8px;margin:0 0 12px}#settingsNotices:empty{margin:0}#settingsActions{display:none}#view-platform[data-active-module="platform/general"] #settingsActions,#view-platform[data-active-module="platform/probing"] #settingsActions,#view-platform[data-active-module="platform/logs"] #settingsActions,#view-platform[data-active-module="platform/heal"] #settingsActions,#view-platform[data-active-module="platform/general"] #settingsNotices,#view-platform[data-active-module="platform/probing"] #settingsNotices,#view-platform[data-active-module="platform/logs"] #settingsNotices,#view-platform[data-active-module="platform/heal"] #settingsNotices{display:flex}@media (max-width:720px){.module-switch-tab{flex:1 1 100%}}' + OPS_OBSERVABILITY_PRODUCT_STYLE + '\n' + OPS_OBSERVABILITY_MOBILE_TOUR_STYLE + '\n' + OPS_OBSERVABILITY_TENANTS_STYLE + '\n' + OPS_OBSERVABILITY_SIGNALS_STYLE + '\n' + OPS_OBSERVABILITY_SSH_LOGS_STYLE}</style>
  <style>${OPS_OBSERVABILITY_HIERARCHY_STYLE + '\n' + OPS_OBSERVABILITY_FOCUS_STYLE + '\n' + OPS_OBSERVABILITY_UI_STYLE + '\n' + OPS_OBSERVABILITY_ALERT_EVIDENCE_STYLE}</style>
  <style>${OPS_OBSERVABILITY_ASSISTANT_STYLE}</style>
  <style>${OPS_OBSERVABILITY_RESTRAINT_STYLE}</style>
<style>${OPS_OBSERVABILITY_SIMPLE_NAV_STYLE + OPS_OBSERVABILITY_SIMPLE_STYLE + OPS_OBSERVABILITY_SIMPLE_OVERVIEW_STYLE}</style>
<style>${COLLECTION_WORKSPACE_STYLE + DATA_CENTER_WORKSPACE_STYLE + COLLECTION_SHELL_STYLE}</style>
<style>${PLUGIN_CENTER_STYLE}</style>
</head>
<body class="ops-observability">
  <a class="skip-link" href="#mainContent">跳到主要内容</a>
  <header>
    <div class="brand"><div class="brand-mark" aria-hidden="true">d</div><div class="brand-copy">d-obs<small>数据与可观测中心</small></div></div>
    <button id="globalSearchTrigger" class="global-search-trigger" type="button" aria-label="搜索工作台模块、对象与事故" aria-haspopup="dialog" aria-controls="commandPaletteBackdrop"><span class="global-search-copy"><strong>搜索或跳转…</strong><small>按名称、ID 或任务查找已注册对象、事故和工作台模块</small></span><kbd>⌘ K</kbd></button>
    <button id="themeToggle" class="theme-toggle" type="button" title="切换亮色 / 暗色主题" aria-label="切换主题">◐</button>
    <div id="headerTelemetryStatus" class="header-live unknown" role="status" aria-live="polite">Telemetry 未确认</div>
  </header>
  <div class="app-shell">
    <aside class="side-nav">
      <nav class="module-tabs" id="moduleTabs" aria-label="可观测中心模块">
        <div class="nav-primary"></div>
        <div class="nav-main" aria-label="常用工作区">
          <button class="module-tab" data-view="overview" aria-controls="view-overview" aria-label="总览" title="查看生产状态与待处理事项">总览</button>
          <button class="module-tab" data-view="collection/tasks" aria-controls="view-collection" aria-label="采集工作区" title="配置云端与终端采集流程、查看来源和运行记录">采集工作区</button>
          <button class="module-tab" data-view="data/assets" aria-controls="view-data" aria-label="数据资产与闭环" title="管理数据资产、数据集版本和改善闭环">数据资产与闭环</button>
          <button class="module-tab" data-view="alerts/center" aria-controls="view-alerts" aria-label="告警中心" title="认领、处理与跟进告警">告警中心<span id="incidentCount" class="tab-count" title="进行中事故数" hidden>—</span></button>
          <button class="module-tab" data-view="traces" aria-controls="view-traces" aria-label="链路追踪" title="查看运行、模型与工具调用证据">链路追踪</button>
          <button class="module-tab" data-view="signals" aria-controls="view-signals" aria-label="观测查询" title="查询指标与日志">观测查询</button>
          <button class="module-tab" data-view="devices" aria-controls="view-devices" aria-label="边缘设备" title="查看设备状态与端侧日志">边缘设备</button>
        </div>
        <div class="nav-secondary-label">更多工作区</div>
        <details class="nav-group" id="nav-group-data" data-nav-group="data">
          <summary class="nav-section-toggle" aria-controls="nav-group-data-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">分析与洞察</span><span id="navReviewNotice" class="tab-count" hidden>待审核</span></summary>
          <div class="nav-group-items" id="nav-group-data-items">
            <button class="module-tab" data-view="investigate" aria-controls="view-investigate" aria-label="事故调查" title="关联异常、证据与影响范围">事故调查</button>
            <button class="module-tab" data-view="operator-metrics" aria-controls="view-operator-metrics" aria-label="用户增长" title="查看用户活跃与模型用量">用户增长</button>
            <button class="module-tab" data-view="signals/panels" aria-controls="view-signals" aria-label="自定义看板" title="搭建与查看指标看板">自定义看板</button>
            <button class="module-tab" data-view="signals/quality" aria-controls="view-signals" aria-label="质量与反馈" title="查看运行评分与用户反馈">质量与反馈</button>
            <button class="module-tab" data-view="service-levels" aria-controls="view-service-levels" aria-label="服务可靠性" title="查看 SLO 与错误预算">服务可靠性</button>
            <button class="module-tab" data-view="skill-loop" aria-controls="view-skill-loop" aria-label="Skill 数据闭环" title="查看采集、反馈与候选审核">Skill 数据闭环<span id="skillLoopCount" class="tab-count" hidden>—</span></button>
            <button class="module-tab" data-view="evolution" aria-controls="view-evolution" aria-label="每日自我进化" title="查看进化证据与质量闸门">每日自我进化<span id="evolutionCount" class="tab-count" hidden>—</span></button>
          </div>
        </details>
        <details class="nav-group" id="nav-group-infra" data-nav-group="infra">
          <summary class="nav-section-toggle" aria-controls="nav-group-infra-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">数据与资产</span></summary>
          <div class="nav-group-items" id="nav-group-infra-items">
            <button class="module-tab" data-view="data-health" aria-controls="view-data-health" aria-label="数据健康" title="检查业务数据是否持续入库">数据健康</button>
            <button class="module-tab" data-view="database" aria-controls="view-database" aria-label="数据库" title="查看数据库状态与只读资产">数据库</button>
            <a class="module-tab" id="edgeLlmWorkspaceLink" href="./ops-observability/edge-llm" title="部署 X5 文本模型并进行性能实测" onclick="var p=location.pathname;this.href=(p.endsWith('/')?p.slice(0,-1):p)+'/edge-llm'">端侧大模型<span aria-hidden="true">↗</span></a>
            <a class="module-tab" href="/dobs/grafana/" target="_blank" rel="noopener noreferrer" title="在新窗口打开基础设施大盘">Grafana 大盘<span aria-hidden="true">↗</span></a>
          </div>
        </details>
        <details class="nav-group" id="nav-group-advanced" data-nav-group="advanced">
          <summary class="nav-section-toggle" aria-controls="nav-group-advanced-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">配置与管理</span></summary>
          <div class="nav-group-items" id="nav-group-advanced-items">
            <button class="module-tab" data-view="alerts/rules" aria-controls="view-alerts" aria-label="告警策略" title="维护规则、阈值与通知路由">告警策略<span id="ruleCount" class="tab-count" title="触发中的策略数" hidden>—</span></button>
            <button class="module-tab" data-view="alerts/strategies" aria-controls="view-alerts" aria-label="自定义策略" title="维护 PromQL 阈值策略">自定义策略</button>
            <button class="module-tab" data-view="alerts/channels" aria-controls="view-alerts" aria-label="通知模板" title="配置通知渠道与降噪">通知模板</button>
            <button class="module-tab" data-view="alerts/silence" aria-controls="view-alerts" aria-label="告警屏蔽" title="管理计划内维护窗口">告警屏蔽</button>
            <button class="module-tab" data-view="platform" aria-controls="view-platform" aria-label="平台配置" title="管理模型池、拨测与系统设置">平台配置</button>
            <button class="module-tab" data-view="tenants" aria-controls="view-tenants" aria-label="租户管理" title="管理接入团队与凭据">租户管理</button>
          </div>
        </details>
        <button id="startWorkbenchTour" class="nav-help" type="button" aria-haspopup="dialog" title="查看工作台使用指南"><span aria-hidden="true">?</span>使用指南</button>
      </nav>
    </aside>
    <main id="mainContent" tabindex="-1">
    <div class="page-head">
      <div class="page-head-copy"><div id="pageKicker" class="page-kicker" hidden>可观测中心 / 总览</div><h1 id="pageTitle">总览</h1><p id="pageIntro" class="page-intro">掌握运行状态，处理需要关注的事项。</p></div>
      <div class="page-head-actions">
        <div class="workspace-facts" aria-label="工作区状态"><span id="fresh" role="status" aria-live="polite">正在读取策略与巡检状态…</span><span id="globalIncidentFact" class="workspace-fact"><strong>— 个进行中</strong></span><span id="scopeStatus" class="scope-status unknown" role="status" aria-live="polite">等待真实数据</span></div>
        <div class="page-head-controls">
          <label id="overviewScopeBar" class="scope-control" for="overviewWindow">时间窗口<select id="overviewWindow" aria-label="选择总览与 Trace 时间窗口"><option value="2">最近 2 小时</option><option value="24" selected>最近 24 小时</option><option value="168">最近 7 天</option></select></label>
          <span id="domainContext" class="domain-context" aria-label="当前数据域">云侧</span>
          <button id="refresh" class="btn" type="button">刷新</button>
          <details id="workspaceOptions" class="workspace-options"><summary>巡检选项</summary><div><button id="runChecks" class="btn" type="button">立即评估</button><p>重新运行巡检并读取最新结果。</p></div></details>
        </div>
      </div>
    </div>
    <section id="view-overview" class="view hidden" aria-label="当前态势与行动">
      <div id="overviewContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在汇总生产态势</strong><small>读取检查、事故、通知与审计数据…</small></div></div>
    </section>
    <section id="view-service-levels" class="view hidden" aria-label="SLO 与错误预算">
      <div id="serviceLevelContent" class="overview-stack" aria-live="polite"></div>
    </section>
    <section id="view-signals" class="view hidden" aria-label="指标、日志与自定义看板">
      <div class="module-switcher" role="tablist" aria-label="观测查询子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/metrics" aria-selected="true">指标查询<small>OTLP metrics 平台内查询</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/logs" aria-selected="false">日志查询<small>低敏感字段检索</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/promql" aria-selected="false">PromQL 查询<small>深度历史 · 直查 Prometheus</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/panels" aria-selected="false">自定义看板<small>多看板 · 拖拽排序 · 模板导入导出</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/quality" aria-selected="false">质量与反馈<small>评分与反馈按天趋势</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/catalog" aria-selected="false">指标字典<small>有哪些指标、都是啥意思</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/tokens" aria-selected="false">接入凭据<small>按人/服务/租户签发上报凭据</small></button></div>
      <div class="view-module is-active" data-view-module="signals/metrics" role="tabpanel" aria-label="指标查询">
        <div class="signals-query-card">
          <div class="nl-hero">
            <span class="nl-hero-mark" aria-hidden="true">⌕</span>
            <input id="nlQueryInput" type="text" autocomplete="off" spellcheck="false" aria-label="自然语言查询" placeholder="想查看什么？如：最近一小时的请求量" />
            <button id="nlQueryBtn" class="btn primary" type="button">智能查询</button>
          </div>
          <p class="nl-hint">输入问题查看指标，也可以按指标名查询。</p>
          <div id="nlQueryResult" aria-live="polite"></div>
          <details class="query-manual" id="metricManualQuery"><summary>按指标名精确查询<span>选择指标、时间范围与账号</span></summary>
          <div class="signals-toolbar">
            <label class="grow">指标名<input id="signalMetricInput" list="signalMetricList" type="text" autocomplete="off" spellcheck="false" placeholder="如 rdk_ai_otlp_spans_received_total" /><datalist id="signalMetricList"></datalist></label>
            <label>时间窗口<select id="signalMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option></select></label>
            <label>账号（可选）<input id="signalSsoUser" type="text" autocomplete="off" spellcheck="false" placeholder="留空查看全部账号" /></label>
            <button id="signalQueryBtn" class="btn primary" type="button">查询</button>
            <button id="signalSavePanelBtn" class="btn" type="button">存入看板</button>
          </div>
          </details>
        </div>
        <div id="signalsMetricChart" class="signals-chart-wrap" aria-live="polite"><div class="signals-empty">输入问题或选择指标，查询结果会显示在这里。</div></div>
        <details id="signals-anomalies" class="detail-sections"><summary class="detail-summary"><strong>统计异常检测</strong><span>对落库序列做 z-score 粗筛（最新值偏离基线 ≥3.5 个标准差），命中后请下钻确认</span></summary>
          <div class="signals-toolbar">
            <label>时间窗口<select id="anomalyMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option></select></label>
            <button id="anomalyDetectBtn" class="btn" type="button">检测</button>
          </div>
          <div id="metricAnomaliesContent" aria-live="polite"><div class="signals-empty">点击「检测」扫描所选窗口内的统计异常</div></div>
        </details>
      </div>
      <div class="view-module" data-view-module="signals/logs" role="tabpanel" aria-label="日志查询" hidden>
        <div class="signals-query-card">
          <div class="signals-toolbar">
            <label>应用<select id="signalLogService"><option value="">全部应用</option></select></label>
            <label>归属<select id="signalLogOwner"><option value="">全部来源</option></select></label>
            <label>最低级别<select id="signalLogSeverity"><option value="1">全部</option><option value="9" selected>INFO+</option><option value="13">WARN+</option><option value="17">ERROR+</option></select></label>
            <label>时间窗口<select id="signalLogMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option></select></label>
            <button id="signalLogQueryBtn" class="btn primary" type="button">查询</button>
          </div>
          <p class="domain-note">应用与归属清单来自近 14 天落库聚合；按应用隔离视图，归属对应接入凭据（d-obs 平台自身 / rdkstudio 主站等）。</p>
        </div>
        <div id="signalsLogTable" aria-live="polite"><div class="signals-empty">设置条件并点击查询</div></div>
      </div>
      <div class="view-module" data-view-module="signals/promql" role="tabpanel" aria-label="PromQL 查询" hidden>
        <p class="signals-note">PromQL 直查 Prometheus 深度历史（服务端代理、表达式经校验）；平台内 OTLP 落库序列请用「指标查询」。</p>
        <div class="signals-query-card">
          <div class="signals-toolbar">
            <label class="grow">PromQL<input id="promqlInput" type="text" autocomplete="off" spellcheck="false" placeholder="如 sum(rate(http_requests_total[5m])) by (service)" /></label>
            <label>时间窗口<select id="promqlMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option></select></label>
            <button id="promqlRunBtn" class="btn primary" type="button">执行查询</button>
            <a id="promqlNativeLink" class="btn" href="/dobs/prometheus/graph" target="_blank" rel="noopener noreferrer">原生界面打开</a>
          </div>
        </div>
        <div id="promqlResult" class="signals-chart-wrap" aria-live="polite"><div class="signals-empty">输入 PromQL 并点击「执行查询」；超过 14 天的深度历史，可到原生界面按当前表达式与时间范围继续查询</div></div>
      </div>
      <div class="view-module" data-view-module="signals/panels" role="tabpanel" aria-label="自定义看板" hidden>
        <div class="board-workspace-head">
          <div class="board-title-group">
            <h2 id="boardName" class="board-name">正在读取看板…</h2>
            <div class="board-context"><span id="boardScopeBadge" class="board-scope-badge" hidden></span><span id="boardPanelCount">— 个面板</span><span id="boardQueryStatus" role="status" aria-live="polite">正在读取看板…</span></div>
          </div>
          <div class="board-primary-actions">
            <button id="boardEditBtn" class="btn" type="button" aria-pressed="false" hidden>编辑看板</button>
            <button id="boardAddPanelBtn" class="btn primary" type="button" hidden>添加面板</button>
            <button id="boardVariablesEditBtn" class="btn" type="button" hidden>设置变量</button>
            <label id="boardVisibilityWrap" class="board-compact-label" hidden>共享<select id="boardVisibility"><option value="private">仅自己</option><option value="team">运营团队可查看</option></select></label>
            <button id="boardDuplicateBtn" class="btn" type="button" hidden>复制到我的看板</button>
            <details class="focus-tools" id="boardMoreTools"><summary class="btn">更多操作</summary><div class="focus-tools-body">
              <label class="board-compact-label">自动刷新<select id="boardAutoRefresh"><option value="0" selected>关闭</option><option value="10000">10 秒</option><option value="30000">30 秒</option><option value="60000">1 分钟</option><option value="300000">5 分钟</option></select></label>
              <button id="boardNewBtn" class="btn" type="button">新建看板</button>
              <button id="boardTemplateBtn" class="btn" type="button">业务模板</button>
              <button id="boardAiBtn" class="btn" type="button">AI 生成</button>
              <button id="boardKioskBtn" class="btn" type="button" title="全屏展示当前看板">大屏模式</button>
              <button id="boardRangeToggleBtn" class="btn" type="button" title="设定起止时间">自定义区间</button>
              <button id="boardImportBtn" class="btn" type="button" title="导入看板模板 JSON">导入模板</button>
              <button id="boardExportBtn" class="btn" type="button" title="导出看板模板 JSON">导出模板</button>
              <button id="boardGrafanaExportBtn" class="btn" type="button" title="导出 Grafana dashboard JSON">导出 Grafana</button>
              <button id="boardRenameBtn" class="btn" type="button" hidden>重命名</button>
              <button id="boardDeleteBtn" class="btn danger" type="button" hidden>删除看板</button>
            </div></details>
          </div>
        </div>
        <div class="board-toolbar board-filter-toolbar">
          <div class="board-toolbar-group">
            <label class="board-compact-label board-picker">切换看板<select id="boardSelect"></select></label>
            <label class="board-compact-label">时间范围<select id="boardWindow"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option><option value="20160">最近 14 天</option><option value="custom" hidden>自定义区间</option></select></label>
            <label class="board-compact-label hidden" id="boardServiceWrap">服务<select id="boardServiceFilter"></select></label>
          </div>
          <button id="boardRefreshBtn" class="btn" type="button" title="重新加载当前看板">刷新</button>
        </div>
        <div id="boardRangeBar" class="board-toolbar board-range-bar hidden">
          <label class="board-compact-label">从<input id="boardRangeFrom" type="datetime-local" /></label>
          <label class="board-compact-label">至<input id="boardRangeTo" type="datetime-local" /></label>
          <button id="boardRangeApplyBtn" class="btn primary" type="button">应用区间</button>
          <button id="boardRangeClearBtn" class="btn" type="button">清除区间</button>
        </div>
        <input id="boardImportFile" type="file" accept=".json,application/json" class="hidden" />
        <div class="board-filter-row"><div id="boardVariables" class="board-variables" aria-label="看板变量"></div><button id="boardResetFiltersBtn" class="btn" type="button" hidden>重置筛选</button></div>
        <div class="board-status-bar"><p id="boardHelp" class="board-help hint">查看模式 · 筛选仅影响当前展示。</p><span id="boardSaveStatus" class="board-save-status" role="status" aria-live="polite"></span><button id="boardSaveRetryBtn" class="btn" type="button">重试保存</button></div>
        <div id="signalsPanelGrid" class="signals-panel-grid" aria-live="polite"><div class="signals-empty">正在读取看板…</div></div>
      </div>
      <div class="view-module" data-view-module="signals/quality" role="tabpanel" aria-label="质量与反馈" hidden>
        <div id="signalsQualityContent" aria-live="polite"><div class="signals-empty">正在读取质量趋势…</div></div>
        <details class="detail-sections"><summary class="detail-summary"><strong>失败后迭代周期</strong><span>失败运行到下一次运行 / 下一次成功的间隔分布——研发反馈周期的直接度量</span></summary>
          <div id="runIterationContent" aria-live="polite"><div class="signals-empty">正在读取迭代周期…</div></div>
          <p class="domain-note">口径：按用户运行时间线配对（运行记录无任务级键，为近似度量）；成功 = outcome ∈ success/succeeded/ok，其余按失败计；配对窗口 72 小时。反馈周期越短，同一问题的迭代收敛越快。</p>
        </details>
      </div>
      <div class="view-module" data-view-module="signals/catalog" role="tabpanel" aria-label="指标字典" hidden>
        <p class="domain-note">不确定指标名？先在这里找：每个指标都有中文说明和标签；点指标名可自动填入指标查询。<strong>应用指标</strong>类走平台内查询（保留 14 天），<strong>其余</strong>走 Prometheus 深度历史。</p>
        <div id="metricCatalogContent" aria-live="polite"><div class="signals-empty">正在读取指标字典…</div></div>
      </div>
      <div class="view-module" data-view-module="signals/tokens" role="tabpanel" aria-label="接入凭据" hidden><details id="signals-tokens" class="detail-sections" open><summary class="detail-summary"><strong>生态接入凭据</strong><span>身份只在凭据层：遥测数据按 owner 归账、零 PII，注册表负责 owner → 对象映射</span></summary>
        <p class="domain-note"><strong>快速接入</strong>　应用侧使用官方 OpenTelemetry SDK，无需安装任何私有 SDK：<code>OTEL_EXPORTER_OTLP_ENDPOINT=https://rdkstudio.d-robotics.cc/dobs</code> ＋ <code>OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer 上方签发的凭据'</code>。traces / metrics / logs 三信号 <code>/v1/*</code> 均可直接接收（HTTP JSON、HTTP protobuf、gRPC），Python、Java、Go、Node.js 等官方 SDK 均适用。点「发送测试指标」可立即验证采集链路。</p>
        <div class="signals-toolbar">
          <label>对象类型<select id="ingestTokenSubjectType"><option value="user">用户（sso_user_id）</option><option value="service">服务</option><option value="tenant">租户</option></select></label>
          <label>对象 ID<input id="ingestTokenSubjectId" type="text" autocomplete="off" spellcheck="false" placeholder="如 u-20260901-abcd / checkout-api / tenant-alpha" /></label>
          <label>显示名<input id="ingestTokenDisplayName" type="text" autocomplete="off" spellcheck="false" placeholder="可留空" /></label>
          <button id="ingestTokenIssueBtn" class="btn primary" type="button">签发</button>
          <button id="selftestMetricBtn" class="btn" type="button">发送测试指标</button>
          <button id="selftestLogBtn" class="btn" type="button">发送测试日志</button>
        </div>
        <details class="detail-sections"><summary class="detail-summary"><strong>验证本凭据</strong><span>从你自己的机器发送真实 OTLP 报文并查回落库，一步确认凭据、网络与数据面（以下命令已验证，可直接复制）</span></summary>
          <pre style="margin:8px 0 4px;padding:12px;border:1px solid rgba(148,163,184,.25);border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.55">NOW_NS="$(date +%s)000000000"
curl -s -X POST 'https://rdkstudio.d-robotics.cc/dobs/v1/metrics' \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer 替换为你的凭据' \
  -d "{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"my-app\"}}]},\"scopeMetrics\":[{\"scope\":{\"name\":\"d-obs-onboarding\"},\"metrics\":[{\"name\":\"demo.ping.gauge\",\"gauge\":{\"dataPoints\":[{\"asDouble\":1,\"timeUnixNano\":\"$NOW_NS\"}]}}]}]}]}"
# 期望 {"partialSuccess":{"rejectedDataPoints":0}}；随后在「观测查询 → 指标查询」输入 demo.ping.gauge、窗口最近 1 小时，应看到 1 个数据点</pre>
          <pre style="margin:4px 0 8px;padding:12px;border:1px solid rgba(148,163,184,.25);border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.55">NOW_NS="$(date +%s)000000000"
curl -s -X POST 'https://rdkstudio.d-robotics.cc/dobs/v1/logs' \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer 替换为你的凭据' \
  -d "{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"my-app\"}}]},\"scopeLogs\":[{\"scope\":{\"name\":\"d-obs-onboarding\"},\"logRecords\":[{\"timeUnixNano\":\"$NOW_NS\",\"observedTimeUnixNano\":\"$NOW_NS\",\"severityText\":\"INFO\",\"severityNumber\":9,\"body\":{\"stringValue\":\"d-obs 接入验证\"}}]}]}]}"
# 期望 {"partialSuccess":{"rejectedLogRecords":0}}；随后在「观测查询 → 日志查询」按应用 my-app 过滤可见</pre>
          <p class="domain-note">内置「发送测试指标 / 测试日志」按钮使用平台内部身份（selftest 隔离 owner），验证的是采集链路；上面两条命令使用你的凭据，验证的是「你的凭据 + 你的网络 + 数据面」整条链路。</p>
        </details>
        <div id="selftestMetricHint" class="domain-note hidden" aria-live="polite"></div>
        <div id="ingestTokenSecretHint" class="domain-note hidden" aria-live="polite"></div>
        <div id="ingestTokensContent" aria-live="polite"><div class="signals-empty">正在读取凭据清单…</div></div>
      </details></div>
    </section>
    <section id="view-devices" class="view hidden" aria-label="边缘设备与心跳">
      <div class="module-switcher" role="tablist" aria-label="边缘设备子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="devices/list" aria-selected="true">设备清单<small>在线状态与板级指标下钻</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="devices/logs" aria-selected="false">RDK 日志调查<small>选择设备与日志源，实时采集</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="devices/register" aria-selected="false">注册设备<small>签发 token 与部署 edge-agent</small></button></div>
      <div class="view-module is-active" data-view-module="devices/list" role="tabpanel" aria-label="设备清单"><details id="devices-list" class="detail-sections" open><summary class="detail-summary"><strong>设备清单</strong><span>在线状态、最近心跳与板级指标下钻</span></summary><div id="devicesContent" aria-live="polite"><div class="signals-empty">正在读取设备清单…</div></div></details></div>
      <div class="view-module" data-view-module="devices/register" role="tabpanel" aria-label="注册设备" hidden><details id="devices-register" class="detail-sections" open><summary class="detail-summary"><strong>注册设备</strong><span>签发设备 token 并部署 edge-agent</span></summary>
        <div class="signals-toolbar">
          <label>设备 ID<input id="newDeviceId" type="text" autocomplete="off" spellcheck="false" placeholder="如 rdk-x5-01" /></label>
          <label>显示名称<input id="newDeviceName" type="text" autocomplete="off" placeholder="可留空" /></label>
          <label>型号<input id="newDeviceModel" type="text" autocomplete="off" placeholder="如 RDK X5 / S600" /></label>
          <button id="registerDeviceBtn" class="btn primary" type="button">注册设备</button>
        </div>
        <div id="newDeviceTokenHint" class="token-reveal hidden"></div>
        <div class="hint">板端部署：把 <code>tools/edge-agent.mjs</code> 复制到设备，token 存入文件，配置 <code>RDK_OBS_REPORT_URL</code> 与 <code>RDK_DEVICE_TOKEN_FILE</code> 后运行（或挂载 systemd 单元）；弱网时样本会缓冲在设备本地并自动补传。</div>
      </details></div>
${OPS_OBSERVABILITY_SSH_LOGS_HTML}
    </section>
    <section id="view-data-health" class="view hidden" aria-label="业务数据新鲜度">
      <div id="dataHealthContent" class="database-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取数据健康状态</strong><small>仅查询聚合数量和最近写入时间…</small></div></div>
    </section>
    <section id="view-operator-metrics" class="view hidden" aria-label="用户增长">
      <div id="operatorMetricsContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取运营指标</strong><small>汇总中心库日粒度数据…</small></div></div>
    </section>
    <section id="view-database" class="view hidden" aria-label="PostgreSQL 运行与资产">
      <div id="databaseContent" class="database-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取数据库状态</strong><small>查询运行指标、关系和表资产…</small></div></div>
    </section>
    <section id="view-skill-loop" class="view hidden" aria-label="Skill 数据闭环">
      <div id="skillLoopContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取 Skill 数据闭环</strong><small>汇总事件埋点、运行经验和 Skill 台账…</small></div></div>
    </section>
    <section id="view-evolution" class="view hidden" aria-label="每日自我进化">
      <div class="view-actions"><span class="view-actions-note">候选只读观测，需人工审核后才会发布</span><button id="runEvolution" class="btn primary" type="button">立即生成候选</button></div>
      <div id="evolutionModuleContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取每日自我进化</strong><small>汇总进化 worker、运行经验和候选状态…</small></div></div>
      <div id="evolutionContent" class="overview-stack hidden"></div>
    </section>
    <section id="view-investigate" class="view hidden" aria-label="异常、证据与影响范围">
      <div id="investigationContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在建立调查视图</strong><small>关联异常趋势、代表事件与影响范围…</small></div></div>
    </section>
    <section id="view-traces" class="view hidden" aria-label="链路追踪">
      <div id="nativeRunTraceHost" class="view-module is-active" data-view-module="traces/runs" role="tabpanel" aria-label="运行证据链">
      <div id="nativeTraceContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取链路证据</strong><small>加载运行、模型、工具调用和审批记录…</small></div></div>
      __LANGFUSE_DASHBOARD_EMBED__
      </div>
      <div class="view-module" data-view-module="traces/session" role="tabpanel" aria-label="会话 Trace" hidden><div id="nativeSessionTraceContent" class="overview-stack" aria-live="polite"></div></div>
    </section>
    <section id="view-tenants" class="view hidden" aria-label="团队接入与探针凭据">
      <div class="module-switcher" role="tablist" aria-label="租户管理子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="tenants/list" aria-selected="true">租户列表<small>状态 · 心跳 · 凭据操作</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="tenants/create" aria-selected="false">创建租户<small>新团队接入与 token 签发</small></button></div>
      <div class="view-module is-active" data-view-module="tenants/list" role="tabpanel" aria-label="租户列表"><details class="detail-sections" open><summary class="detail-summary"><strong>租户列表</strong><span>状态、最近上报时间与凭据操作</span></summary><div id="tenantsContent"></div></details></div>
      <div class="view-module" data-view-module="tenants/create" role="tabpanel" aria-label="创建租户" hidden><details class="detail-sections" open><summary class="detail-summary"><strong>创建租户</strong><span>为新团队创建租户并签发探针 token</span></summary>
        <div class="tenant-toolbar">
          <label class="field">租户 ID<input id="newTenantId" type="text" autocomplete="off" spellcheck="false" placeholder="如 sim2real、team-a" /></label>
          <label class="field">显示名称<input id="newTenantName" type="text" autocomplete="off" placeholder="团队或项目名，可用中文，可留空" /></label>
          <button id="createTenantBtn" class="btn primary" type="button">创建租户</button>
        </div>
        <div id="newTenantIdHint" class="hint">租户 ID 是标识符不是名字：它会拼进告警键 <code>t.&lt;ID&gt;.&lt;检查项&gt;</code>（点作分隔符），并出现在 URL 与请求头里，因此只能用小写 ASCII 字母/数字/连字符（2–40 字符，需字母开头；<code>platform</code> 等保留字不可用）。中文名请填「显示名称」。</div>
      </details></div>
    </section>
    <section id="view-platform" class="view hidden" aria-label="全局巡检与运行配置">
      <div class="module-switcher" role="tablist" aria-label="系统配置子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/model-pool" aria-selected="true">模型池<small>路由目标 · 健康 · 容量</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/general" aria-selected="false">评估器<small>评估开关与环境标签</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/probing" aria-selected="false">业务拨测<small>Canary 真实探测</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/logs" aria-selected="false">日志签名<small>错误识别规则</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/heal" aria-selected="false">自愈策略<small>自动恢复与冷却</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/accounts" aria-selected="false">账号行为<small>SSO 账号行为审计</small></button></div>
      <div class="view-module is-active" data-view-module="platform/model-pool" role="tabpanel" aria-label="模型池"><div id="modelPoolContent"></div></div>
      <div class="view-module" data-view-module="platform/general" role="tabpanel" aria-label="评估器设置" hidden><div id="settingsContentGeneral"></div></div>
      <div class="view-module" data-view-module="platform/probing" role="tabpanel" aria-label="真实业务拨测" hidden><div id="settingsContentProbing"></div></div>
      <div class="view-module" data-view-module="platform/logs" role="tabpanel" aria-label="日志错误签名" hidden><div id="settingsContentLogs"></div></div>
      <div class="view-module" data-view-module="platform/heal" role="tabpanel" aria-label="自愈策略" hidden><div id="settingsContentHeal"></div></div>
      <div class="view-module" data-view-module="platform/accounts" role="tabpanel" aria-label="账号行为视角" hidden><div class="panel"><div class="toolbar"><div><strong>账号行为视角</strong><small style="display:block;color:var(--muted)">按 SSO 账号聚合 Agent Run、会话轮次、活跃天数、配置变更、事故处置与事件流水；只读审计，不含对话正文。</small></div></div><div class="fields" style="grid-template-columns:2fr 1fr auto;align-items:end;padding:12px"><div><label style="font-size:11px;color:var(--muted)">账号 ID 或用户名</label><input id="accountIdentifier" type="text" placeholder="如 lx199710" style="width:100%" /></div><div><label style="font-size:11px;color:var(--muted)">时间窗</label><select id="accountHours" style="width:100%"><option value="24">最近 24 小时</option><option value="168" selected>最近 7 天</option><option value="720">最近 30 天</option><option value="2160">最近 90 天</option><option value="8760">最近 1 年</option></select></div><button id="accountSearchBtn" class="btn primary" type="button">检索</button></div><div id="accountActivityResult"></div></div></div>
      <div id="settingsNotices" aria-live="polite"></div>
      <div class="form-actions" id="settingsActions"><button class="btn primary" id="saveSettings" type="button">保存系统设置</button><span class="feedback" id="settingsFeedback"></span></div>
    </section>
    <section id="view-alerts" class="view hidden" aria-label="告警中心与策略">
      <div class="module-switcher" role="tablist" aria-label="告警子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/center" aria-selected="true">告警中心<small>处置队列 · MTTA / MTTR</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/rules" aria-selected="false">告警策略<small>指标 / 日志 / 拨测阈值</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/strategies" aria-selected="false">自定义策略<small>PromQL 阈值 · 公共与租户</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/metrics" aria-selected="false">指标与数据源<span id="metricCount" class="tab-count">—</span></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/objects" aria-selected="false">告警对象<span id="objectCount" class="tab-count">—</span></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/channels" aria-selected="false">通知模板<span id="channelCount" class="tab-count">—</span></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="alerts/silence" aria-selected="false">告警屏蔽<small>计划内维护窗口</small></button></div>
      <div class="view-module" data-view-module="alerts/rules" role="tabpanel" aria-label="告警策略" hidden>
        <div class="panel strategy-card"><div class="toolbar"><label class="search-wrap" aria-label="策略搜索"><input id="ruleSearch" class="search" type="text" name="ops-observability-rule-filter" autocomplete="off" data-lpignore="true" data-1p-ignore="true" readonly placeholder="请输入策略名称或数据源" /></label><div class="filter-anchor"><button id="filterTrigger" class="btn filter-trigger" type="button">⌁ <span id="filterText">筛选</span></button><div id="ruleFilters" class="filter-popover hidden"><div class="filter-row"><span>监控类型</span><div id="categoryFilter" class="segmented" aria-label="规则类型筛选"><button data-category="all" class="active">全部</button><button data-category="metric">指标</button><button data-category="log">日志</button><button data-category="probe">拨测</button></div></div><div class="filter-row"><span>策略状态</span><div id="statusFilter" class="segmented" aria-label="策略状态筛选"><button data-status="all" class="active">全部</button><button data-status="enabled">生效</button><button data-status="disabled">停用</button></div></div><div class="filter-footer"><button id="clearFilters" class="filter-clear" type="button">清空全部条件</button><button id="closeFilters" class="btn primary" type="button">关闭</button></div></div></div></div>
          <div id="ruleSummary" class="rule-summary" aria-label="告警策略摘要"></div><div class="rules-panel"><div class="rules-head"><div>策略名称 / 数据源</div><div>监控类型</div><div>触发条件</div><div>执行周期</div><div>通知模板</div><div>创建人 / 创建时间</div><div>告警启停</div><div>操作</div></div><div id="rulesList"></div></div>
        </div>
      </div>
      <div class="view-module is-active" data-view-module="alerts/center" role="tabpanel" aria-label="告警中心">
        <div class="panel"><div id="incidentSummary" class="rule-summary" aria-label="处置概览"></div><div class="ic-toolbar"><div class="ic-tabs" id="incidentTabs"><button class="ic-tab is-active" data-ic-scope="all" data-ic-state="active" type="button">全部待处置</button><button class="ic-tab" data-ic-scope="mine" data-ic-state="active" type="button">我的</button><button class="ic-tab" data-ic-scope="all" data-ic-state="closed" type="button">已关闭</button></div><div class="ic-tabs" id="incidentSev"><button class="ic-tab is-active" data-ic-sev="" type="button">全部级别</button><button class="ic-tab" data-ic-sev="critical" type="button">严重</button><button class="ic-tab" data-ic-sev="warning" type="button">告警</button></div></div><div id="incidentList" role="region" aria-label="事故处置队列，可横向滚动查看完整字段" tabindex="0"></div></div>
      </div>
      <div class="view-module" data-view-module="alerts/strategies" role="tabpanel" aria-label="自定义策略" hidden>
        <div class="panel"><div class="toolbar"><div><strong>自定义策略</strong><small style="display:block;color:var(--muted)">PromQL 阈值策略：公共层（平台）对所有租户可见，租户策略只在本租户触发。</small></div><div style="flex:1"></div><button id="strategyCreateBtn" class="btn primary" type="button">新建策略</button></div><div id="strategyList" class="rules-panel"></div><div class="hint" style="margin:8px 12px 12px">评估每分钟执行：PromQL 查询 → 持续时长判定 → 触发/恢复事故；恢复无需配置，查询回到阈值内自动闭环。</div></div>
      </div>
      <div class="view-module" data-view-module="alerts/metrics" role="tabpanel" aria-label="指标管理与数据源" hidden><div id="metricsContent"></div></div>
      <div class="view-module" data-view-module="alerts/objects" role="tabpanel" aria-label="告警对象" hidden><div class="notice">这里是对象注册表和对象选择入口；点击左侧对象即可查看最近 run、标签与归属信息。</div><div class="hint" style="margin:0 12px 12px">最近同步：<span id="objectLoadedAt">—</span></div><div id="objectsContent"></div></div>
      <div class="view-module" data-view-module="alerts/silence" role="tabpanel" aria-label="告警屏蔽" hidden>
        <div class="panel"><div class="toolbar"><div><strong>告警屏蔽</strong><small style="display:block;color:var(--muted)">计划内维护期间不投递通知（事故照常记录）；窗口结束后下一轮自动补发。</small></div></div><div class="fields" style="grid-template-columns:2fr 1fr 2fr auto;align-items:end;padding:12px"><div><label style="font-size:11px;color:var(--muted)">规则键（留空=全部规则）</label><input id="silenceAlertKey" type="text" placeholder="如 disk-space" style="width:100%" /></div><div><label style="font-size:11px;color:var(--muted)">屏蔽时长</label><select id="silenceMinutes" style="width:100%"><option value="30">30 分钟</option><option value="60" selected>1 小时</option><option value="120">2 小时</option><option value="360">6 小时</option><option value="720">12 小时</option><option value="1440">24 小时</option></select></div><div><label style="font-size:11px;color:var(--muted)">屏蔽原因（必填）</label><input id="silenceReason" type="text" placeholder="如：数据库计划升级" style="width:100%" /></div><button id="silenceCreateBtn" class="btn primary" type="button">创建屏蔽窗口</button></div><div id="silenceList" class="rules-panel"></div><span class="feedback" id="silenceFeedback"></span></div>
      </div>
      <div class="view-module" data-view-module="alerts/channels" role="tabpanel" aria-label="通知模板" hidden><div id="templateSummary"></div><div class="notice">策略可继承默认发送模板，也可直接绑定指定渠道；模板未配置时只评估和记录，不会误判为已投递。</div><div id="templateEditorZone" class="template-editor-zone hidden"><div class="template-editor-head"><div><h3>编辑通知模板</h3><span>修改发送策略、降噪规则和渠道凭据</span></div><button id="closeTemplateEditor" class="btn" type="button">收起编辑</button></div><div id="policyContent"></div><div class="level-routing"><strong>分级路由</strong><label>严重级渠道<select id="criticalChannel"><option value="">继承规则设置</option><option value="default">默认渠道</option><option value="feishu">飞书机器人</option><option value="dingtalk">钉钉机器人</option><option value="wecom">企业微信</option><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="webhook">通用 Webhook</option><option value="none">不发送</option></select></label><label>告警级渠道<select id="warningChannel"><option value="">继承规则设置</option><option value="default">默认渠道</option><option value="feishu">飞书机器人</option><option value="dingtalk">钉钉机器人</option><option value="wecom">企业微信</option><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="webhook">通用 Webhook</option><option value="none">不发送</option></select></label><small>覆盖各策略自身渠道：严重级可路由到值班群，留空=继承；选“不发送”则该级别静默</small></div><div id="channelContent" class="channel-grid"></div></div></div>
    </section>
    ${COLLECTION_WORKSPACE_HTML}
    ${DATA_CENTER_WORKSPACE_HTML}
    ${PLUGIN_CENTER_HTML}
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
    <section class="command-palette"><div class="command-palette-head"><div class="command-palette-head-copy"><h2 id="commandPaletteTitle">搜索对象、事故或模块</h2><p>输入至少两个字符查找已注册对象和可见事故；模块结果始终保留。</p></div><button id="closeCommandPalette" class="btn command-palette-close" type="button">关闭</button></div><label class="command-search-wrap" aria-label="搜索对象、事故或模块"><input id="commandPaletteSearch" class="command-search" type="search" autocomplete="off" placeholder="搜索对象、事故、告警、Trace、SLO…" /></label><div id="commandPaletteResults" class="command-results" role="listbox" aria-label="对象、事故和工作台模块结果"></div><div class="command-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></div></section>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>
  <script>${OPS_TENANT_SCOPE_JS + OPS_OBSERVABILITY_SCRIPT_UI + integrateCollectionScriptA(OPS_OBSERVABILITY_SCRIPT_A) + '\n' + OPS_OBSERVABILITY_ALERT_EVIDENCE_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_STRATEGIES + '\n' + OPS_OBSERVABILITY_SCRIPT_INVESTIGATION + '\n' + OPS_OBSERVABILITY_SCRIPT_USABILITY + '\n' + OPS_OBSERVABILITY_SCRIPT_COPILOT + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE_GRAPH + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_SCRIPT_MODEL_POOL + '\n' + OPS_OBSERVABILITY_SCRIPT_SLO + '\n' + OPS_OBSERVABILITY_SCRIPT_OBJECTS + '\n' + OPS_OBSERVABILITY_SCRIPT_B + '\n' + OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS + '\n' + OPS_OBSERVABILITY_SCRIPT_LEARNING + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_SCRIPT + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_UX + '\n' + OPS_OBSERVABILITY_SCRIPT_SIGNALS + '\n' + OPS_OBSERVABILITY_SCRIPT_SSH_LOGS + '\n' + integrateCollectionNavScript(OPS_OBSERVABILITY_SIMPLE_NAV_SCRIPT) + '\n' + simplifyMobileTourScript(OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR) + '\n' + OPS_OBSERVABILITY_SCRIPT_TENANTS + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_HIERARCHY + '\n' + OPS_OBSERVABILITY_SCRIPT_FOCUS + '\n' + OPS_OBSERVABILITY_SCRIPT_RESTRAINT + '\n' + OPS_OBSERVABILITY_SCRIPT_ASSISTANT + '\n' + OPS_OBSERVABILITY_SIMPLE_OVERVIEW_SCRIPT + '\n' + OPS_OBSERVABILITY_SIMPLE_PRESENTATION_SCRIPT + '\n' + COLLECTION_WORKSPACE_SCRIPT + '\n' + DATA_CENTER_WORKSPACE_SCRIPT + '\n' + COLLECTION_SHELL_IDENTITY_SCRIPT + '\n' + PLUGIN_CENTER_SCRIPT + '\n' + PLUGIN_CENTER_SHELL_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_C}</script>
</body>
</html>`;
