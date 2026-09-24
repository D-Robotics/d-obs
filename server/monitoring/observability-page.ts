import { OPS_OBSERVABILITY_STYLE } from './observability-page-style.js';
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
  <style>${OPS_OBSERVABILITY_PALETTE_LIGHT + '\n' + OPS_OBSERVABILITY_PALETTE_DARK + '\n' + OPS_OBSERVABILITY_STYLE + '\n' + OPS_OBSERVABILITY_SLO_STYLE + '\n' + OPS_OBSERVABILITY_UNIFIED_STYLE + '\n' + OPS_OBSERVABILITY_INVESTIGATION_STYLE + '\n' + OPS_OBSERVABILITY_COPILOT_STYLE + '\n' + OPS_OBSERVABILITY_TRACES_STYLE + '\n' + OPS_OBSERVABILITY_DATABASE_STYLE + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_STYLE + '\n' + OPS_OBSERVABILITY_LEARNING_STYLE + '\n' + OPS_OBSERVABILITY_OPERATOR_METRICS_STYLE + '\n' + OPS_OBSERVABILITY_COCKPIT_STYLE + '\n' + OPS_OBSERVABILITY_UX_STYLE + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_STYLE + '\n.detail-sections{margin-top:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}.detail-summary{cursor:pointer;display:flex;align-items:center;gap:9px;padding:12px 16px;color:var(--text);font-size:12px}.detail-summary span{color:var(--muted);font-weight:400}.detail-sections[open]>.detail-summary{border-bottom:1px solid var(--line)}.detail-sections>*:not(.detail-summary){margin:12px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.model-pool-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px}.model-pool-toolbar h2{margin:0 0 4px}.model-pool-toolbar p{margin:0;color:var(--muted);font-size:11px}.model-pool-editor{padding:16px}.model-pool-editor .section-head{margin-bottom:12px}.model-pool-editor .fields{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:10px}.model-pool-editor .field.full{grid-column:1/-1}.model-pool-summary{margin-bottom:12px}.model-pool-actions{display:flex;gap:8px;flex-wrap:wrap}.model-pool-actions .danger,.model-pool-editor .danger,.table-panel .danger{color:var(--danger,#b42318);border-color:color-mix(in srgb,var(--danger,#b42318) 35%,var(--line))}.model-pool-filter{min-width:116px;margin-left:auto}.model-pool-unused{display:inline-flex;padding:3px 7px;border-radius:999px;background:var(--panel2);color:var(--muted);font-size:10px}.model-pool-advanced{padding:0;overflow:hidden}.model-pool-advanced-summary{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;list-style:none}.model-pool-advanced-summary::-webkit-details-marker{display:none}.model-pool-advanced-summary:before{content:"+";color:var(--green);font-size:15px}.model-pool-advanced[open] .model-pool-advanced-summary:before{content:"-"}.model-pool-advanced-summary span{color:var(--muted);font-size:11px;font-weight:400}.model-pool-advanced-body{padding:0 16px 16px;border-top:1px solid var(--line)}.model-pool-subsection{padding-top:16px}.model-pool-subsection+.model-pool-subsection{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}.model-pool-subsection h3{margin:0 0 4px;font-size:14px}.model-pool-subsection .fields{margin-top:12px}.domain-switcher{display:flex;align-items:center;gap:4px;margin-left:auto;margin-right:12px;padding:3px;border:1px solid var(--line);border-radius:10px;background:var(--panel2)}.domain-tab{border:0;border-radius:7px;padding:7px 12px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.domain-tab[aria-selected="true"]{background:var(--green);color:var(--c2);font-weight:700}.domain-hint{color:var(--muted);font-size:11px;white-space:nowrap}.domain-note{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--muted);font-size:12px}.domain-note strong{color:var(--text)}.module-switcher{display:flex;gap:4px;margin:0 0 14px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);flex-wrap:wrap}.module-switch-tab{flex:1 1 130px;border:0;border-radius:8px;padding:8px 12px;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-align:left}.module-switch-tab small{display:block;margin-top:2px;font-size:10px;font-weight:400;color:inherit;opacity:.75}.module-switch-tab:hover{color:var(--text)}.module-switch-tab.is-active{background:var(--c23);color:var(--green);font-weight:600;box-shadow:inset 0 0 0 1px var(--c56)}.view-module{display:none}.view-module.is-active{display:block}#settingsNotices{display:none;flex-direction:column;gap:8px;margin:0 0 12px}#settingsNotices:empty{margin:0}#settingsActions{display:none}#view-platform[data-active-module="platform/general"] #settingsActions,#view-platform[data-active-module="platform/probing"] #settingsActions,#view-platform[data-active-module="platform/logs"] #settingsActions,#view-platform[data-active-module="platform/heal"] #settingsActions,#view-platform[data-active-module="platform/general"] #settingsNotices,#view-platform[data-active-module="platform/probing"] #settingsNotices,#view-platform[data-active-module="platform/logs"] #settingsNotices,#view-platform[data-active-module="platform/heal"] #settingsNotices{display:flex}@media (max-width:720px){.module-switch-tab{flex:1 1 100%}}' + OPS_OBSERVABILITY_PRODUCT_STYLE + '\n' + OPS_OBSERVABILITY_MOBILE_TOUR_STYLE + '\n' + OPS_OBSERVABILITY_TENANTS_STYLE + '\n' + OPS_OBSERVABILITY_SIGNALS_STYLE}</style>
</head>
<body class="ops-observability">
  <a class="skip-link" href="#mainContent">跳到主要内容</a>
  <header>
    <div class="brand"><div class="brand-mark" aria-hidden="true">d</div><div class="brand-copy">可观测中心<small>d-obs · Reliability Operations</small></div></div>
    <div id="domainSwitcher" class="domain-switcher" role="tablist" aria-label="观测数据域"><button class="domain-tab" data-domain-tab="cloud" type="button" role="tab" aria-selected="true">云侧</button><button class="domain-tab" data-domain-tab="edge" type="button" role="tab" aria-selected="false">端侧</button><span id="domainHint" class="domain-hint">RDK Studio · 服务 · 服务器</span></div>
    <button id="globalSearchTrigger" class="global-search-trigger" type="button" aria-haspopup="dialog" aria-controls="commandPaletteBackdrop"><span class="global-search-copy"><strong>快速搜索</strong><small>指标、事故、Trace、SLO 或任意模块</small></span><kbd>⌘ K</kbd></button>
    <button id="themeToggle" class="theme-toggle" type="button" title="切换亮色 / 暗色主题" aria-label="切换主题">◐</button>
    <div id="headerTelemetryStatus" class="header-live unknown" role="status" aria-live="polite">Telemetry 未确认</div>
  </header>
  <div class="app-shell">
    <aside class="side-nav">
      <nav class="global-nav" aria-label="可观测中心入口">
        <a class="global-tab active" href="./ops-observability#overview" aria-current="page">可观测中心</a>
      </nav>
      <nav class="module-tabs" aria-label="可观测中心模块">
        <!-- 移动端底栏的搬运目标（≤520px 脚本把高频 tab 物理移入）；桌面布局
             由基础样式隐藏，桌面侧的高频入口在下方"运营"折叠组内。 -->
        <div class="nav-primary"></div>
        <details class="nav-group" id="nav-group-primary" data-nav-group="primary" open>
          <summary class="nav-section-toggle" aria-controls="nav-group-primary-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">运营</span></summary>
          <div class="nav-group-items" id="nav-group-primary-items">
            <button class="module-tab" data-view="overview" aria-controls="view-overview" title="判断生产是否影响用户，并查看当前待办">运营总览<span id="overviewCount" class="tab-count" title="进行中事故数" hidden>—</span></button>
            <button class="module-tab" data-view="operator-metrics" aria-controls="view-operator-metrics" title="查看新增用户、DAU、对话次数和 Agent Run 趋势">用户增长</button>
            <button class="module-tab" data-view="signals/panels" aria-controls="view-signals" title="搭建与查看自定义看板：多看板、拖拽排序、模板导入导出、大屏模式">看板</button>
          </div>
        </details>
        <details class="nav-group" id="nav-group-core" data-nav-group="core">
          <summary class="nav-section-toggle" aria-controls="nav-group-core-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">告警与事故</span><span class="nav-group-alert" id="navCoreAlert" hidden></span></summary>
          <div class="nav-group-items" id="nav-group-core-items">
            <button class="module-tab" data-view="investigate" aria-controls="view-investigate" title="从异常、证据和影响范围定位事故">事故调查<span id="incidentCount" class="tab-count" title="进行中事故数">—</span></button>
            <button class="module-tab" data-view="alerts/center" aria-controls="view-alerts" title="待认领、处理中与已关闭的处置队列，用 MTTA / MTTR 衡量响应效率">告警中心</button>
            <button class="module-tab" data-view="alerts/strategies" aria-controls="view-alerts" title="自定义 PromQL 阈值策略：公共层与租户策略">自定义策略</button>
            <button class="module-tab" data-view="alerts/rules" aria-controls="view-alerts" title="维护告警规则、阈值和通知路由">告警策略<span id="ruleCount" class="tab-count" title="触发中的策略数" hidden>—</span></button>
            <button class="module-tab" data-view="alerts/metrics" aria-controls="view-alerts" title="系统指标的数据源、状态和阈值">指标与数据源<span id="metricCount" class="tab-count">—</span></button>
            <button class="module-tab" data-view="alerts/objects" aria-controls="view-alerts" title="对象注册表与选择入口">告警对象<span id="objectCount" class="tab-count">—</span></button>
            <button class="module-tab" data-view="alerts/channels" aria-controls="view-alerts" title="通知渠道的路由与降噪">通知模板<span id="channelCount" class="tab-count">—</span></button>
            <button class="module-tab" data-view="alerts/silence" aria-controls="view-alerts" title="计划内维护的告警屏蔽窗口">告警屏蔽</button>
            <button class="module-tab" data-view="traces" aria-controls="view-traces" title="从事故证据下钻单次 Agent 与会话运行">链路追踪</button>
          </div>
        </details>
        <details class="nav-group" id="nav-group-data" data-nav-group="data">
          <summary class="nav-section-toggle" aria-controls="nav-group-data-items"><span class="nav-toggle-caret" aria-hidden="true"></span><span class="nav-toggle-label">信号与分析</span></summary>
          <div class="nav-group-items" id="nav-group-data-items">
            <button class="module-tab" data-view="signals" aria-controls="view-signals" title="查询 OTLP 指标与日志，维护自定义面板">观测查询</button>
            <button class="module-tab" data-view="signals/quality" aria-controls="view-signals" title="run 评分与用户反馈的按天趋势">质量与反馈</button>
            <button class="module-tab" data-view="service-levels" aria-controls="view-service-levels" title="查看用户旅程 SLO、错误预算和风险目标">SLO 与错误预算</button>
            <button class="module-tab" data-view="devices" aria-controls="view-devices" title="查看边缘设备心跳、在线状态与板级指标">边缘设备</button>
            <button class="module-tab" data-view="data-health" aria-controls="view-data-health" title="查看关键业务数据是否持续入库">数据入库健康</button>
            <button class="module-tab" data-view="database" aria-controls="view-database" title="查看 PostgreSQL 运行状态、关系与数据表">数据库状态</button>
            <a class="module-tab" href="/dobs/grafana/" target="_blank" rel="noopener noreferrer" title="Grafana 大盘：基础设施指标可视化（d-obs 自监控看板已预配）">Grafana 大盘</a>
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
            <button class="module-tab" data-view="platform" aria-controls="view-platform" title="模型池路由、真实业务拨测、日志签名、自愈策略与全局设置">平台配置</button>
            <button class="module-tab" data-view="tenants" aria-controls="view-tenants" title="注册接入团队、轮换探针 token、停用或启用租户">租户管理</button>
          </div>
        </details>
      </nav>
    </aside>
    <main id="mainContent" tabindex="-1">
    <div class="page-head">
      <div class="page-head-copy"><div id="pageKicker" class="page-kicker">可观测中心 / 总览</div><h1 id="pageTitle">生产可观测与告警</h1><p id="pageIntro" class="page-intro">先判断生产影响，再处理事故、维护告警，最后下钻到链路证据。</p><p id="fresh" role="status" aria-live="polite">正在读取策略与巡检状态…</p></div>
      <div class="page-head-actions"><span class="env-pill">production</span><button id="runChecks" class="btn" type="button">立即评估</button><button id="refresh" class="btn" type="button">刷新数据</button></div>
    </div>
    <div class="workspace-toolbar">
    <div id="overviewScopeBar" class="scope-bar" role="region" aria-label="总览与 Trace 共用观察范围">
      <div class="scope-copy"><strong>观察范围</strong><small>总览与链路追踪</small></div>
      <label class="scope-control" for="overviewWindow">时间窗口<select id="overviewWindow" aria-label="选择总览与 Trace 时间窗口"><option value="2">最近 2 小时</option><option value="24" selected>最近 24 小时</option><option value="168">最近 7 天</option></select></label>
      <span id="scopeStatus" class="scope-status unknown" role="status" aria-live="polite">等待真实数据</span>
    </div>
    <div class="global-command-bar" role="region" aria-label="快速导航">
        <div class="workspace-facts" aria-label="工作区状态"><span id="globalIncidentFact" class="workspace-fact"><strong>— 个进行中</strong></span><span id="globalFreshnessFact" class="workspace-fact">等待评估</span><span id="globalViewFact" class="workspace-fact">当前视图</span></div>
    </div>
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
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 观测查询</div><h2 id="signalsHeading">指标、日志与自定义看板</h2><p>查询 OTLP 落库的指标与日志；常用查询可组织为可拖拽排序的看板，并以模板导入导出。深度历史仍可前往 Prometheus 查询。</p></div><div class="right">OTLP 落库 · 管理员只读</div></div>
      <div class="module-switcher" role="tablist" aria-label="观测查询子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/metrics" aria-selected="true">指标查询<small>OTLP metrics 平台内查询</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/logs" aria-selected="false">日志查询<small>低敏感字段检索</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/promql" aria-selected="false">PromQL 查询<small>深度历史 · 直查 Prometheus</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/panels" aria-selected="false">自定义看板<small>多看板 · 拖拽排序 · 模板导入导出</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/quality" aria-selected="false">质量与反馈<small>评分与反馈按天趋势</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/catalog" aria-selected="false">指标字典<small>有哪些指标、都是啥意思</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="signals/tokens" aria-selected="false">接入凭据<small>按人/服务/租户签发上报凭据</small></button></div>
      <div class="view-module is-active" data-view-module="signals/metrics" role="tabpanel" aria-label="指标查询">
        <div class="signals-query-card">
          <div class="nl-hero">
            <span class="nl-hero-mark" aria-hidden="true">⌕</span>
            <input id="nlQueryInput" type="text" autocomplete="off" spellcheck="false" aria-label="自然语言查询" placeholder="用一句中文描述你想看什么，如：最近1小时有多少 span 被拒绝 / checkout-api 最近的请求量" />
            <button id="nlQueryBtn" class="btn primary" type="button">智能查询</button>
          </div>
          <p class="nl-hint">服务端把问题映射到指标字典里的指标并自动出图；识别不了时换个说法，或到「指标字典」直接选。</p>
          <div id="nlQueryResult" aria-live="polite"></div>
          <div class="signals-query-divider" role="presentation"></div>
          <div class="signals-toolbar">
            <label class="grow">指标名<input id="signalMetricInput" list="signalMetricList" type="text" autocomplete="off" spellcheck="false" placeholder="如 rdk_ai_otlp_spans_received_total" /><datalist id="signalMetricList"></datalist></label>
            <label>时间窗口<select id="signalMinutes"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option></select></label>
            <button id="signalQueryBtn" class="btn primary" type="button">查询</button>
            <button id="signalSavePanelBtn" class="btn" type="button">存入看板</button>
          </div>
        </div>
        <div id="signalsMetricChart" class="signals-chart-wrap" aria-live="polite"><div class="signals-empty">输入指标名并点击查询</div></div>
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
            <a class="btn" href="/dobs/prometheus/graph" target="_blank" rel="noopener noreferrer">原生界面打开</a>
          </div>
        </div>
        <div id="promqlResult" class="signals-chart-wrap" aria-live="polite"><div class="signals-empty">输入 PromQL 并点击「执行查询」；超过 14 天的深度历史请到原生界面</div></div>
      </div>
      <div class="view-module" data-view-module="signals/panels" role="tabpanel" aria-label="自定义看板" hidden>
        <div class="board-toolbar">
          <div class="board-toolbar-group">
            <label class="board-compact-label">看板<select id="boardSelect"></select></label>
            <label class="board-compact-label">时间维度<select id="boardWindow"><option value="60">最近 1 小时</option><option value="240" selected>最近 4 小时</option><option value="1440">最近 24 小时</option><option value="10080">最近 7 天</option><option value="20160">最近 14 天</option><option value="custom" hidden>自定义区间</option></select></label>
            <label class="board-compact-label hidden" id="boardServiceWrap">服务<select id="boardServiceFilter"></select></label>
            <label class="board-compact-label">自动刷新<select id="boardAutoRefresh"><option value="0" selected>关闭</option><option value="10000">10 秒</option><option value="30000">30 秒</option><option value="60000">1 分钟</option><option value="300000">5 分钟</option></select></label>
            <button id="boardRefreshBtn" class="btn" type="button" title="重新加载当前看板的面板数据">刷新</button>
            <button id="boardKioskBtn" class="btn" type="button" title="全屏展示当前看板，适合监控大屏">大屏</button>
          </div>
          <div class="board-toolbar-group board-toolbar-actions">
            <button id="boardAddPanelBtn" class="btn primary" type="button">添加面板</button>
            <button id="boardNewBtn" class="btn" type="button">新建</button>
            <button id="boardAiBtn" class="btn" type="button">AI 生成</button>
            <button id="boardRangeToggleBtn" class="btn" type="button" title="设定起止时间区间，替代相对时间维度">自定义区间</button>
            <button id="boardImportBtn" class="btn" type="button" title="导入看板模板 JSON，生成新看板">导入</button>
            <button id="boardExportBtn" class="btn" type="button" title="导出当前看板为模板 JSON">导出</button>
            <button id="boardGrafanaExportBtn" class="btn" type="button" title="导出为 Grafana 可直接导入的 dashboard JSON">Grafana 格式</button>
            <button id="boardRenameBtn" class="btn" type="button" title="重命名当前看板">重命名</button>
            <button id="boardDeleteBtn" class="btn" type="button" title="删除当前看板">删除</button>
          </div>
        </div>
        <div id="boardRangeBar" class="board-toolbar board-range-bar hidden">
          <label class="board-compact-label">从<input id="boardRangeFrom" type="datetime-local" /></label>
          <label class="board-compact-label">至<input id="boardRangeTo" type="datetime-local" /></label>
          <button id="boardRangeApplyBtn" class="btn primary" type="button">应用区间</button>
          <button id="boardRangeClearBtn" class="btn" type="button">清除区间</button>
        </div>
        <input id="boardImportFile" type="file" accept=".json,application/json" class="hidden" />
        <p class="domain-note">拖拽面板卡片可调整排序；全局时间维度即时生效，单个面板可在编辑中单独设定。导出的 JSON 即看板模板，导入后将创建新看板。</p>
        <div id="signalsPanelGrid" class="signals-panel-grid" aria-live="polite"><div class="signals-empty">正在读取看板…</div></div>
      </div>
      <div class="view-module" data-view-module="signals/quality" role="tabpanel" aria-label="质量与反馈" hidden>
        <div id="signalsQualityContent" aria-live="polite"><div class="signals-empty">正在读取质量趋势…</div></div>
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
        <div id="selftestMetricHint" class="domain-note hidden" aria-live="polite"></div>
        <div id="ingestTokenSecretHint" class="domain-note hidden" aria-live="polite"></div>
        <div id="ingestTokensContent" aria-live="polite"><div class="signals-empty">正在读取凭据清单…</div></div>
      </details></div>
    </section>
    <section id="view-devices" class="view hidden" aria-labelledby="devicesHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 边缘设备</div><h2 id="devicesHeading">边缘设备与心跳</h2><p>注册 RDK 板级设备、查看心跳与在线状态，下钻板级指标（CPU / 内存 / 温度 / BPU）。</p></div><div class="right">设备 token 只显示一次</div></div>
      <div class="domain-note"><strong>端侧数据域</strong>　机器人、RDK 板、固件和 edge-agent 样本；端侧 Prometheus 查询使用 <code>plane="edge"</code>。</div>
      <div class="module-switcher" role="tablist" aria-label="边缘设备子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="devices/list" aria-selected="true">设备清单<small>在线状态与板级指标下钻</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="devices/register" aria-selected="false">注册设备<small>签发 token 与部署 edge-agent</small></button></div>
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
    <section id="view-traces" class="view hidden" aria-label="链路追踪">
      <div class="module-switcher" role="tablist" aria-label="链路追踪子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="traces/runs" aria-selected="true">运行证据链<small>单次运行下钻</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="traces/agent" aria-selected="false">Agent Trace<small>调用树 · token · 工具</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="traces/session" aria-selected="false">会话 Trace<small>按会话重放</small></button></div>
      <div class="view-module is-active" data-view-module="traces/runs" role="tabpanel" aria-label="运行证据链">
      <div id="nativeTraceContent" class="overview-stack" aria-live="polite"><div class="shell-status" role="status"><span class="shell-spinner" aria-hidden="true"></span><strong>正在读取链路证据</strong><small>加载运行、模型、工具调用和审批记录…</small></div></div>
      </div>
      <div class="view-module" data-view-module="traces/agent" role="tabpanel" aria-label="Agent Trace" hidden>__LANGFUSE_DASHBOARD_EMBED__</div>
      <div class="view-module" data-view-module="traces/session" role="tabpanel" aria-label="会话 Trace" hidden><div class="right">数据按登录账号隔离</div><div class="notice">standalone d-obs 不承载 Agent 会话观测（没有 <code>/api/agent/session-observability</code>）：请用「运行证据链」按运行/会话筛选与下钻，或到业务站的会话 Trace 页查看完整链路。</div></div>
    </section>
    <section id="view-tenants" class="view hidden" aria-labelledby="tenantsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 租户管理</div><h2 id="tenantsHeading">团队接入与探针凭据</h2><p>注册租户、签发与轮换探针 token、停用或启用团队；所有操作均写入审计日志。</p></div><div class="right">探针 token 仅显示一次</div></div>
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
    <section id="view-platform" class="view hidden" aria-labelledby="platformHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 系统设置</div><h2 id="platformHeading">全局巡检与运行配置</h2><p>低频高级配置；改动会影响全局巡检、模型路由与通知。</p></div><div class="right">敏感配置只保存在服务器</div></div>
      <div class="module-switcher" role="tablist" aria-label="系统配置子模块"><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/model-pool" aria-selected="true">模型池<small>路由目标 · 健康 · 容量</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/general" aria-selected="false">评估器<small>评估开关与环境标签</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/probing" aria-selected="false">业务拨测<small>Canary 真实探测</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/logs" aria-selected="false">日志签名<small>错误识别规则</small></button><button class="module-switch-tab" type="button" role="tab" data-module-tab="platform/heal" aria-selected="false">自愈策略<small>自动恢复与冷却</small></button></div>
      <div class="view-module is-active" data-view-module="platform/model-pool" role="tabpanel" aria-label="模型池"><div id="modelPoolContent"></div></div>
      <div class="view-module" data-view-module="platform/general" role="tabpanel" aria-label="评估器设置" hidden><div id="settingsContentGeneral"></div></div>
      <div class="view-module" data-view-module="platform/probing" role="tabpanel" aria-label="真实业务拨测" hidden><div id="settingsContentProbing"></div></div>
      <div class="view-module" data-view-module="platform/logs" role="tabpanel" aria-label="日志错误签名" hidden><div id="settingsContentLogs"></div></div>
      <div class="view-module" data-view-module="platform/heal" role="tabpanel" aria-label="自愈策略" hidden><div id="settingsContentHeal"></div></div>
      <div id="settingsNotices" aria-live="polite"></div>
      <div class="form-actions" id="settingsActions"><button class="btn primary" id="saveSettings" type="button">保存系统设置</button><span class="feedback" id="settingsFeedback"></span></div>
    </section>
    <section id="view-alerts" class="view hidden" aria-labelledby="alertsHeading">
      <div class="view-head"><div><div class="eyebrow">可观测中心 / 告警策略</div><h2 id="alertsHeading">检测、阈值与通知</h2><p>维护规则、阈值和通知路由；事故处置请进入“事故调查”。</p></div><div class="right">按规则独立窗口 · 每分钟评估</div></div>
      <div class="view-module is-active" data-view-module="alerts/rules" role="tabpanel" aria-label="告警策略">
        <div class="panel strategy-card"><div class="toolbar"><label class="search-wrap" aria-label="策略搜索"><input id="ruleSearch" class="search" type="text" name="ops-observability-rule-filter" autocomplete="off" data-lpignore="true" data-1p-ignore="true" readonly placeholder="请输入策略名称或数据源" /></label><div class="filter-anchor"><button id="filterTrigger" class="btn filter-trigger" type="button">⌁ <span id="filterText">筛选</span></button><div id="ruleFilters" class="filter-popover hidden"><div class="filter-row"><span>监控类型</span><div id="categoryFilter" class="segmented" aria-label="规则类型筛选"><button data-category="all" class="active">全部</button><button data-category="metric">指标</button><button data-category="log">日志</button><button data-category="probe">拨测</button></div></div><div class="filter-row"><span>策略状态</span><div id="statusFilter" class="segmented" aria-label="策略状态筛选"><button data-status="all" class="active">全部</button><button data-status="enabled">生效</button><button data-status="disabled">停用</button></div></div><div class="filter-footer"><button id="clearFilters" class="filter-clear" type="button">清空全部条件</button><button id="closeFilters" class="btn primary" type="button">关闭</button></div></div></div></div>
          <div id="ruleSummary" class="rule-summary" aria-label="告警策略摘要"></div><div class="rules-panel"><div class="rules-head"><div>策略名称 / 数据源</div><div>监控类型</div><div>触发条件</div><div>执行周期</div><div>通知模板</div><div>创建人 / 创建时间</div><div>告警启停</div><div>操作</div></div><div id="rulesList"></div></div>
        </div>
      </div>
      <div class="view-module" data-view-module="alerts/center" role="tabpanel" aria-label="告警中心" hidden>
        <div class="panel"><div id="incidentSummary" class="rule-summary" aria-label="处置概览"></div><div class="ic-toolbar"><div class="ic-tabs" id="incidentTabs"><button class="ic-tab is-active" data-ic-scope="all" data-ic-state="active" type="button">全部待处置</button><button class="ic-tab" data-ic-scope="mine" data-ic-state="active" type="button">我的</button><button class="ic-tab" data-ic-scope="all" data-ic-state="closed" type="button">已关闭</button></div><div class="ic-tabs" id="incidentSev"><button class="ic-tab is-active" data-ic-sev="" type="button">全部级别</button><button class="ic-tab" data-ic-sev="critical" type="button">严重</button><button class="ic-tab" data-ic-sev="warning" type="button">告警</button></div></div><div id="incidentList"></div></div>
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
  <script>${OPS_TENANT_SCOPE_JS + OPS_OBSERVABILITY_SCRIPT_A + '\n' + OPS_OBSERVABILITY_SCRIPT_STRATEGIES + '\n' + OPS_OBSERVABILITY_SCRIPT_INVESTIGATION + '\n' + OPS_OBSERVABILITY_SCRIPT_USABILITY + '\n' + OPS_OBSERVABILITY_SCRIPT_COPILOT + '\n' + OPS_OBSERVABILITY_SCRIPT_TRACES + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE + '\n' + OPS_OBSERVABILITY_SCRIPT_DATABASE_GRAPH + '\n' + OPS_OBSERVABILITY_SCRIPT_OVERVIEW + '\n' + OPS_OBSERVABILITY_SCRIPT_MODEL_POOL + '\n' + OPS_OBSERVABILITY_SCRIPT_SLO + '\n' + OPS_OBSERVABILITY_SCRIPT_OBJECTS + '\n' + OPS_OBSERVABILITY_SCRIPT_B + '\n' + OPS_OBSERVABILITY_SCRIPT_OPERATOR_METRICS + '\n' + OPS_OBSERVABILITY_SCRIPT_LEARNING + '\n' + OPS_OBSERVABILITY_VERSION_DISTRIBUTION_SCRIPT + '\n' + OPS_OBSERVABILITY_COCKPIT_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_UX + '\n' + OPS_OBSERVABILITY_SCRIPT_SIGNALS + '\n' + OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR + '\n' + OPS_OBSERVABILITY_SCRIPT_TENANTS + '\n' + OPS_OBSERVABILITY_ACTION_LOOP_SCRIPT + '\n' + OPS_OBSERVABILITY_SCRIPT_C}</script>
</body>
</html>`;
