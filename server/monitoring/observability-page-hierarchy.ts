/** Final presentation layer: context → decisions → supporting evidence.
 * Keep all colors tied to the existing light/dark palette, and keep data and
 * permissions in their owning renderers. This layer also owns tab keyboard UX.
 */
export const OPS_OBSERVABILITY_HIERARCHY_STYLE = `
  body.ops-observability{
    --ui-surface:var(--c378);
    --ui-canvas:var(--c327);
    --ui-subtle:color-mix(in srgb,var(--ui-canvas) 72%,var(--ui-surface));
    --ui-border:color-mix(in srgb,var(--text) 13%,var(--ui-surface));
    --green-soft:color-mix(in srgb,var(--green) 8%,var(--ui-surface));
    background:var(--ui-canvas);background-image:none;line-height:1.6;
  }
  body.ops-observability main{background:var(--ui-canvas);padding:28px 32px 56px}
  body.ops-observability main:before{display:none}
  body.ops-observability main>*{max-width:1560px;margin-inline:auto}
  body.ops-observability .app-shell{grid-template-columns:224px minmax(0,1fr)}
  body.ops-observability .side-nav{padding:20px 12px;background:var(--ui-surface)}
  body.ops-observability .global-tab{color:var(--muted);background:transparent}
  body.ops-observability .global-tab:hover{color:var(--text);background:var(--ui-subtle)}
  body.ops-observability .global-tab.active{color:var(--text);background:var(--ui-subtle)}
  body.ops-observability .nav-primary .module-tab{min-height:42px;font-size:13px}
  body.ops-observability .nav-group{padding-top:4px;border:0}
  body.ops-observability .nav-group+.nav-group{margin-top:4px}
  body.ops-observability .nav-section-toggle{min-height:34px;font-size:12px;color:var(--muted);font-weight:600}
  body.ops-observability .nav-section-toggle:hover{background:var(--ui-subtle);color:var(--text)}
  body.ops-observability .nav-group-items{margin:4px 0;padding-left:8px;border-left:1px solid var(--ui-border)}
  body.ops-observability .module-tab{font-size:13px;color:var(--muted);min-height:38px}
  body.ops-observability .module-tab:hover{background:var(--ui-subtle);color:var(--text)}
  body.ops-observability .module-tab.active{background:var(--green-soft);color:var(--green-strong);box-shadow:inset 3px 0 0 var(--green);font-weight:650}
  body.ops-observability .page-head{gap:24px;align-items:flex-start;padding-bottom:22px;margin-bottom:24px;border-bottom:1px solid var(--ui-border)}
  body.ops-observability .page-kicker{font-size:12px;letter-spacing:.02em;color:var(--muted);margin-bottom:7px}
  body.ops-observability .page-head h1{font-size:28px;letter-spacing:-.025em;line-height:1.3;margin-bottom:7px}
  body.ops-observability .page-head .page-intro{color:var(--muted)!important;opacity:1;font-size:13px!important;max-width:640px}
  body.ops-observability .page-head-actions{max-width:500px}
  body.ops-observability #pageKicker[hidden]{display:none}
  body.ops-observability .domain-context{font-size:12px;color:var(--muted);padding:0 4px}
  body.ops-observability .workspace-options{position:relative;font-size:12px}
  body.ops-observability .workspace-options>summary{cursor:pointer;color:var(--muted);padding:8px 10px;border-radius:8px}
  body.ops-observability .workspace-options>div{position:absolute;right:0;top:100%;z-index:20;width:240px;padding:16px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:10px;box-shadow:var(--shadow)}
  body.ops-observability .workspace-options p{margin:10px 0 0;color:var(--muted);font-size:12px}
  body.ops-observability .workspace-options:has(#runChecks.hidden),body.ops-observability .workspace-options:has(#runChecks.focus-context-hidden){display:none}
  body.ops-observability #view-alerts[data-active-module="alerts/center"]>.module-switcher,
  body.ops-observability #view-signals[data-active-module="signals/panels"]>.module-switcher{display:none}
  body.ops-observability .workspace-facts #fresh{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  body.ops-observability .workspace-facts{white-space:normal;flex-wrap:wrap;row-gap:4px;font-size:12px}
  body.ops-observability #fresh{font-size:12px}
  body.ops-observability .env-pill{background:var(--ui-subtle);border-color:var(--ui-border);box-shadow:none}
  body.ops-observability .btn{box-shadow:none;transform:none}
  body.ops-observability .btn:hover{box-shadow:none;transform:none;background:var(--ui-subtle)}
  body.ops-observability .btn.primary{box-shadow:none}
  body.ops-observability .btn.primary:hover{background:var(--green-strong)}
  body.ops-observability :is(button,a,input,select,textarea,summary):focus-visible{outline:2px solid var(--green);outline-offset:3px}
  body.ops-observability .view:not(.hidden){gap:20px;grid-template-columns:minmax(0,1fr);min-width:0}
  body.ops-observability .overview-stack{gap:24px;grid-template-columns:minmax(0,1fr);min-width:0}
  body.ops-observability .panel{background:var(--ui-surface);border-color:var(--ui-border);box-shadow:none;border-radius:12px}
  body.ops-observability .panel>.section-head{border-bottom:0;padding-bottom:0}
  body.ops-observability .panel>.section-head:after,
  body.ops-observability .section-head h2:before,
  body.ops-observability .overview-stack>.panel:before,
  body.ops-observability .overview-stack>details:before,
  body.ops-observability .overview-stack>.incident-section:before{display:none}
  body.ops-observability .section-head h2,body.ops-observability .table-title h2{font-size:16px;line-height:1.4}
  body.ops-observability .section-head .hint,body.ops-observability .hint{font-size:12px;line-height:1.6;color:var(--muted)}
  body.ops-observability .section-head .right{font-size:12px}
  body.ops-observability .section,body.ops-observability .impact-panel,body.ops-observability .north-star-panel{padding:22px}
  body.ops-observability .table-title{background:var(--ui-subtle);padding:16px 20px}
  body.ops-observability :is(.rules-head,.metric-head,.template-head){background:var(--ui-subtle);font-size:12px;border-color:var(--ui-border)}
  body.ops-observability :is(.rule-row,.metric-row,.template-row){background:var(--ui-surface);box-shadow:none;font-size:13px}
  body.ops-observability :is(.rule-row,.metric-row,.template-row):nth-child(even){background:var(--ui-surface)}
  body.ops-observability :is(.rule-row,.metric-row,.template-row):hover{background:var(--ui-subtle);box-shadow:none}
  body.ops-observability :is(.summary-card,.metric,.check,.north-star-card,.pulse-card,.incident-card){box-shadow:none;transform:none}
  body.ops-observability :is(.north-star-card,.pulse-card,.incident-card):hover{transform:none;box-shadow:none}
  body.ops-observability .module-switcher{gap:6px;background:var(--ui-subtle);padding:5px;border:1px solid var(--ui-border);border-radius:10px;margin:0 0 18px;scrollbar-width:thin;box-shadow:none}
  body.ops-observability .module-switch-tab{min-height:40px;padding:8px 14px;border:1px solid transparent;border-radius:7px;font-size:13px;color:var(--muted);box-shadow:none}
  body.ops-observability .module-switch-tab:hover{background:var(--ui-surface);color:var(--text)}
  body.ops-observability .module-switch-tab.is-active{background:var(--ui-surface);border-color:var(--ui-border);color:var(--text);font-weight:650;box-shadow:0 1px 2px var(--c394)}
  body.ops-observability .module-switch-tab.is-active:after{display:none}
  body.ops-observability .detail-sections{margin-top:0;background:var(--ui-surface);box-shadow:none;border-color:var(--ui-border)}
  body.ops-observability .detail-sections[open]{box-shadow:none}
  body.ops-observability .detail-summary{padding:16px 20px;font-size:14px;gap:12px;min-height:52px;color:var(--text)}
  body.ops-observability .detail-summary span{font-size:12px;line-height:1.5}
  body.ops-observability .detail-sections[open]>.detail-summary{background:var(--ui-subtle)}
  body.ops-observability .detail-sections>*:not(.detail-summary){margin:18px}
  body.ops-observability .detail-sections>*:not(.detail-summary):is(.panel,.table-panel){box-shadow:none}
  body.ops-observability .overview-primary,body.ops-observability .overview-secondary{display:grid;gap:18px;min-width:0}
  body.ops-observability .overview-group-head{display:flex;align-items:baseline;gap:14px;margin:0}
  body.ops-observability .overview-group-head h2{font-size:13px;margin:0;font-weight:650;color:var(--text)}
  body.ops-observability .overview-group-head p{font-size:12px;color:var(--muted);margin:0}
  body.ops-observability .overview-group-title{font-size:13px;margin:0;font-weight:650;color:var(--text)}
  body.ops-observability .overview-group-hint{font-size:12px;color:var(--muted);margin:0}
  body.ops-observability .overview-incident-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:16px 0;border-bottom:1px solid var(--ui-border)}
  body.ops-observability .overview-incident-row:last-child{border-bottom:0;padding-bottom:0}
  body.ops-observability .overview-incident-copy strong{font-size:14px}
  body.ops-observability .overview-incident-title{display:flex;align-items:center;gap:8px}
  body.ops-observability .overview-incident-copy p{margin:6px 0;font-size:13px;color:var(--text);line-height:1.6}
  body.ops-observability .overview-incident-copy small{display:block;font-size:12px;color:var(--muted);line-height:1.6}
  body.ops-observability .overview-incident-actions{display:flex;align-items:center}
  body.ops-observability .overview-primary>.hero{padding:22px 24px;border-left:4px solid var(--blue);background:color-mix(in srgb,var(--blue) 5%,var(--ui-surface));box-shadow:none}
  body.ops-observability .overview-primary>.hero.healthy{border-left-color:var(--c27);background:color-mix(in srgb,var(--c27) 5%,var(--ui-surface))}
  body.ops-observability .overview-primary>.hero.warning{border-left-color:var(--orange);background:color-mix(in srgb,var(--orange) 6%,var(--ui-surface))}
  body.ops-observability .overview-primary>.hero.critical{border-left-color:var(--red);background:color-mix(in srgb,var(--red) 5%,var(--ui-surface))}
  body.ops-observability .overview-primary>.hero.stale{border-left-color:var(--orange);background:var(--ui-subtle)}
  body.ops-observability .overview-primary .hero-title{font-size:21px;line-height:1.4;color:var(--text)}
  body.ops-observability .overview-primary .hero-detail{font-size:13px;color:var(--muted)}
  body.ops-observability .overview-primary>.metrics{gap:0;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-surface);overflow:hidden}
  body.ops-observability .overview-primary>.metrics>.metric{border:0;border-right:1px solid var(--ui-border);border-radius:0;padding:18px 22px;background:transparent}
  body.ops-observability .overview-primary>.metrics>.metric:last-child{border-right:0}
  body.ops-observability .metric .label{font-size:12px;color:var(--muted)}
  body.ops-observability .metric .value{font-size:28px;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  body.ops-observability .metric .detail{font-size:12px;line-height:1.5;margin-top:6px}
  body.ops-observability .overview-secondary{border-top:1px solid var(--ui-border);padding-top:24px}
  body.ops-observability .impact-grid{gap:18px}
  body.ops-observability .impact-row{border:0;border-bottom:1px solid var(--ui-border);background:transparent;border-radius:0;padding:12px 0}
  body.ops-observability .impact-row strong{font-size:13px}
  body.ops-observability .impact-row small,body.ops-observability .impact-signal{font-size:12px}
  body.ops-observability .impact-health-metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
  body.ops-observability .impact-health-metrics .metric{padding:0;border:0;background:transparent}
  body.ops-observability .impact-health-metrics .value{font-size:23px;overflow-wrap:anywhere}
  body.ops-observability .north-star-panel{background:var(--ui-surface)}
  body.ops-observability .north-star-card{border-color:var(--ui-border);background:var(--ui-subtle);padding:16px}
  body.ops-observability .north-star-value{font-size:27px}
  body.ops-observability .north-star-meta,body.ops-observability .north-star-target,body.ops-observability .check-summary{font-size:12px;line-height:1.6}
  body.ops-observability .overview-product-definition{display:grid;gap:4px;padding:12px 0;border-bottom:1px solid var(--ui-border)}
  body.ops-observability .overview-product-definition span,body.ops-observability .overview-product-definition small{font-size:12px;color:var(--muted)}
  body.ops-observability .overview-product-definition strong{font-size:13px}
  body.ops-observability .overview-diagnostics{background:var(--ui-subtle)}
  body.ops-observability .overview-diagnostics .panel{box-shadow:none}
  body.ops-observability .remediate-item{background:transparent;border:0;border-bottom:1px solid var(--ui-border);border-radius:0;padding:14px 0}
  body.ops-observability .remediate-item:last-child{border-bottom:0}
  body.ops-observability .remediate-body strong{font-size:14px}
  body.ops-observability .remediate-body small{font-size:12px;line-height:1.6;overflow-wrap:anywhere}
  body.ops-observability .action-loop-card{box-shadow:none}
  body.ops-observability .action-loop-meta,body.ops-observability .action-loop-evidence{font-size:12px;line-height:1.6}
  body.ops-observability .signals-query-card{padding:22px;background:var(--ui-surface);border-color:var(--ui-border);box-shadow:none;margin-bottom:18px}
  body.ops-observability .signals-toolbar{align-items:flex-end;gap:14px}
  body.ops-observability .signals-toolbar label{align-items:stretch;flex-direction:column;gap:6px;white-space:normal;font-size:12px;color:var(--muted);min-width:0}
  body.ops-observability .signals-toolbar input,body.ops-observability .signals-toolbar select{height:38px;font-size:13px;min-width:0;width:100%}
  body.ops-observability .signals-toolbar label:not(.grow){flex:1 1 140px}
  body.ops-observability .signals-toolbar label.grow{flex:2 1 250px}
  body.ops-observability .signals-toolbar .btn{height:38px}
  body.ops-observability .nl-hero input{height:42px;font-size:14px}
  body.ops-observability .nl-hero .btn{height:42px}
  body.ops-observability .nl-hint{font-size:12px;line-height:1.6}
  body.ops-observability .query-manual{margin-top:18px;padding-top:16px;border-top:1px solid var(--ui-border)}
  body.ops-observability .query-manual>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--text)}
  body.ops-observability .query-manual>summary span{color:var(--muted);font-weight:400;font-size:12px;margin-left:8px}
  body.ops-observability .signals-chart-wrap{background:var(--ui-surface);border-color:var(--ui-border);padding:18px}
  body.ops-observability :is(.signals-empty,.impact-empty,.empty){font-size:13px;line-height:1.65;padding:24px 16px}
  body.ops-observability .signals-log-table{font-size:13px}
  body.ops-observability .signals-log-table th,body.ops-observability .signals-log-table td{padding:11px 12px;line-height:1.6}
  body.ops-observability .signals-log-table th{font-size:12px;background:var(--ui-subtle)}
  body.ops-observability .trace-native-hero{background:var(--ui-subtle);border-left:0;padding:18px 20px}
  body.ops-observability .trace-native-hero .page-kicker,body.ops-observability .trace-native-hero .copilot-kicker,body.ops-observability .trace-native-hero p{display:none}
  body.ops-observability .trace-native-hero p,body.ops-observability .trace-coverage-notice,body.ops-observability .trace-row-coverage{font-size:12px;line-height:1.6}
  body.ops-observability .trace-detail{box-shadow:var(--shadow);border-color:var(--ui-border)}
  body.ops-observability .trace-detail-head{background:var(--ui-subtle);padding:20px}
  body.ops-observability :is(.trace-detail-facts span,.trace-detail-facts small,.trace-context-grid span,.trace-fragment-head span,.trace-evidence-source span,.trace-evidence-item small,.trace-span-label small,.trace-span-attributes summary){font-size:12px;line-height:1.6}
  body.ops-observability :is(.trace-detail-facts strong,.trace-context-grid strong,.trace-fragment-head strong,.trace-span-label strong,.trace-evidence-source strong,.trace-evidence-item p){font-size:13px;line-height:1.6}
  body.ops-observability .trace-attribute-grid span{font-size:11px}
  body.ops-observability .trace-attribute-grid strong{font-size:12px}
  body.ops-observability .ic-toolbar{padding:12px 20px;border-top:1px solid var(--ui-border);background:var(--ui-subtle);margin-bottom:0}
  body.ops-observability .ic-table{font-size:13px}
  body.ops-observability #incidentList{max-width:100%;min-width:0;overflow-x:auto;scrollbar-width:thin}
  body.ops-observability .ic-table th{font-size:12px;padding:12px 16px;background:var(--ui-subtle)}
  body.ops-observability .ic-table td{padding:14px 16px}
  body.ops-observability .summary-card{background:transparent;border:0;border-radius:0;border-right:1px solid var(--ui-border)}
  body.ops-observability .summary-label,body.ops-observability .summary-detail{font-size:12px}
  body.ops-observability .summary-value{font-size:27px;color:var(--text)}
  body.ops-observability .summary-value.bad{color:var(--red)}
  body.ops-observability .metric .value{color:var(--text)}
  body.ops-observability .metric .value.bad{color:var(--red)}
  body.ops-observability .metric .value.warn{color:var(--orange)}
  body.ops-observability .metric .value.good{color:var(--c27)}
  body.ops-observability main a:not(.btn){color:var(--green-strong)}
  body.ops-observability .ic-summary-priority{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin:0;padding:0}
  body.ops-observability .ic-filter-card{padding:20px;text-align:left;cursor:pointer;color:var(--text);font:inherit}
  body.ops-observability .ic-filter-card:hover{background:var(--ui-subtle)}
  body.ops-observability .ic-filter-card[aria-pressed="true"]{background:var(--green-soft);box-shadow:inset 0 -3px 0 var(--green)}
  body.ops-observability .ic-analysis{grid-column:1/-1;border:0;border-top:1px solid var(--ui-border);border-radius:0;background:var(--ui-subtle)}
  body.ops-observability .ic-analysis .detail-summary{min-height:46px;padding:12px 20px;font-size:13px}
  body.ops-observability .ic-secondary-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
  body.ops-observability .ic-secondary-metric{display:grid;gap:4px}
  body.ops-observability .ic-secondary-metric .summary-value{font-size:22px;font-weight:650;color:var(--text)}
  body.ops-observability .ic-stage-filter,body.ops-observability .ic-list-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;color:var(--muted);font-size:12px}
  body.ops-observability .ic-stage-filter{background:var(--green-soft)}
  body.ops-observability .ic-stage-filter .btn,body.ops-observability .ic-list-footer .btn{margin-left:auto}
  body.ops-observability .ic-list-footer .ic-hint{font-size:12px;margin:0}
  body.ops-observability .database-stack{min-width:0;grid-template-columns:minmax(0,1fr);gap:18px}
  body.ops-observability .database-table-scroll{min-width:0;width:100%;overflow:auto}
  body.ops-observability .database-metric-label,body.ops-observability .database-metric-detail,body.ops-observability .database-source-time{font-size:12px;line-height:1.6}
  body.ops-observability .database-health-copy span,body.ops-observability .database-health-meta,body.ops-observability .database-panel-head p{font-size:12px;line-height:1.6}
  body.ops-observability .database-table th{font-size:12px}
  body.ops-observability .database-table td{font-size:13px;padding-top:13px;padding-bottom:13px}
  body.ops-observability .domain-note{background:var(--ui-subtle);border:1px solid var(--ui-border);border-left:0;box-shadow:none;font-size:12px;line-height:1.6}
  body.ops-observability .shell-status{box-shadow:none;background:var(--ui-surface)}
  body.ops-observability .shell-status small{font-size:12px}
  body.ops-observability :is(.command-item-copy span,.command-palette-head p,.command-palette-foot){font-size:12px}
  body.ops-observability .command-item-copy strong{font-size:14px}
  body.ops-observability .command-item{padding:12px}
  @media(max-width:1280px){
    body.ops-observability main{padding:24px 24px 48px}
    body.ops-observability .app-shell{grid-template-columns:204px minmax(0,1fr)}
  }
  @media(max-width:1120px){
    body.ops-observability .page-head{flex-direction:column;gap:16px}
    body.ops-observability .page-head-actions{align-items:flex-start;width:100%;max-width:none}
    body.ops-observability .page-head-controls,body.ops-observability .workspace-facts{justify-content:flex-start}
  }
  @media(max-width:900px){
    body.ops-observability .overview-primary>.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
    body.ops-observability .overview-primary>.metrics>.metric:nth-child(2n){border-right:0}
    body.ops-observability .overview-primary>.metrics>.metric:nth-child(-n+2){border-bottom:1px solid var(--ui-border)}
    body.ops-observability .ic-summary-priority,body.ops-observability .ic-secondary-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
    body.ops-observability .impact-grid{grid-template-columns:1fr}
  }
  @media(max-width:720px){
    body.ops-observability .app-shell{display:block}
    body.ops-observability main{padding:20px 16px 36px}
    body.ops-observability .page-head{gap:14px;padding-bottom:18px;margin-bottom:18px}
    body.ops-observability .page-head h1{font-size:24px}
    body.ops-observability .page-head-copy,body.ops-observability .page-head-actions{overflow:visible;min-width:0;max-width:100%}
    body.ops-observability .workspace-facts{max-width:100%;width:100%;min-width:0}
    body.ops-observability .workspace-facts #fresh{max-width:100%;width:100%;white-space:normal;overflow-wrap:anywhere}
    body.ops-observability .page-head-controls{gap:8px}
    body.ops-observability .overview-stack{gap:20px}
    body.ops-observability .overview-group-head{flex-direction:column;gap:3px}
    body.ops-observability .overview-incident-row{grid-template-columns:minmax(0,1fr)}
    body.ops-observability .overview-primary>.hero{padding:18px;flex-wrap:wrap;gap:12px}
    body.ops-observability .overview-primary>.hero .right{margin-left:0;flex-basis:100%;font-size:12px}
    body.ops-observability .overview-primary .hero-title{font-size:18px}
    body.ops-observability .overview-primary>.metrics>.metric{padding:16px}
    body.ops-observability .metric .value{font-size:26px}
    body.ops-observability .section,body.ops-observability .impact-panel,body.ops-observability .north-star-panel{padding:18px}
    body.ops-observability .detail-summary{align-items:flex-start;flex-wrap:wrap;padding:16px;gap:4px 12px}
    body.ops-observability .detail-summary span{flex-basis:100%;order:2}
    body.ops-observability .detail-sections>*:not(.detail-summary){margin:14px}
    body.ops-observability .module-switcher{margin-bottom:14px;gap:4px}
    body.ops-observability .module-switch-tab{padding:8px 12px}
    body.ops-observability .signals-query-card{padding:18px}
    body.ops-observability .signals-toolbar{gap:12px}
    body.ops-observability .signals-toolbar label,body.ops-observability .signals-toolbar label.grow{flex:1 1 100%}
    body.ops-observability .query-manual>summary span{display:block;margin-left:0}
    body.ops-observability .impact-health-metrics{grid-template-columns:1fr}
    body.ops-observability .impact-health-metrics .metric+.metric{padding-top:12px;border-top:1px solid var(--ui-border)}
    body.ops-observability .operator-metrics-group:not(.operator-metrics-usage) .operator-metrics-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
    body.ops-observability .operator-metrics-group:not(.operator-metrics-usage) .operator-metrics-kpi:last-child{grid-column:1/-1}
    body.ops-observability .side-nav{padding:0}
    body.ops-observability .side-nav:not(:has(.mobile-expanded)) #obsAccountBar{display:none}
    body.ops-observability .module-tab.active{color:var(--green-strong)}
  }
  @media(prefers-reduced-motion:reduce){body.ops-observability *,body.ops-observability *:before,body.ops-observability *:after{scroll-behavior:auto;transition:none;animation:none}}
`;

export const OPS_OBSERVABILITY_SCRIPT_HIERARCHY = `
      function syncHierarchyTabs(){
        document.querySelectorAll('.module-switcher').forEach((list,listIndex)=>{
          const tabs=Array.from(list.querySelectorAll('[role="tab"]'));
          tabs.forEach((tab,index)=>{
            const active=tab.getAttribute('aria-selected')==='true';
            tab.setAttribute('tabindex',active?'0':'-1');
            const key=tab.dataset.moduleTab;
            if(!tab.id)tab.id='module-tab-'+listIndex+'-'+index;
            const section=list.closest('.view');
            const panel=section&&Array.from(section.querySelectorAll('[data-view-module]')).find(node=>node.dataset.viewModule===key);
            if(panel){if(!panel.id)panel.id='module-panel-'+listIndex+'-'+index;tab.setAttribute('aria-controls',panel.id);panel.setAttribute('aria-labelledby',tab.id)}
          });
        });
      }
      document.querySelectorAll('.module-switcher').forEach(list=>{
        list.addEventListener('keydown',event=>{
          const tab=event.target.closest('[role="tab"]');
          if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          const tabs=Array.from(list.querySelectorAll('[role="tab"]')).filter(node=>!node.hidden&&!node.disabled);
          const index=tabs.indexOf(tab);if(index<0||!tabs.length)return;
          event.preventDefault();
          const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
          tabs[next].click();tabs[next].focus();
          if(tabs[next].scrollIntoView)tabs[next].scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
          syncHierarchyTabs();
        });
      });
      const hierarchyBaseSetView=setView;
      setView=function(requested,updateHash=true){const options=$('workspaceOptions');if(options)options.open=false;hierarchyBaseSetView(requested,updateHash);syncHierarchyTabs();syncHierarchyReviewNotice()};
      document.addEventListener('click',event=>{const options=$('workspaceOptions');if(options&&options.open&&!options.contains(event.target))options.open=false});
      document.addEventListener('keydown',event=>{const options=$('workspaceOptions');if(event.key==='Escape'&&options&&options.open){options.open=false;const summary=options.querySelector('summary');if(summary)summary.focus()}});
      function syncHierarchyReviewNotice(){
        const notice=$('navReviewNotice');if(!notice)return;
        const candidates=['skillLoopCount','evolutionCount'].some(id=>{const node=$(id);const tab=node&&node.closest('.module-tab');return node&&(!tab||!tab.hidden)&&Number(node.textContent)>0});
        notice.hidden=!candidates;notice.title=candidates?'学习与进化有候选待审核':'';
      }
      const hierarchyBaseLoadAll=loadAll;
      loadAll=async function(manual){
        const result=await hierarchyBaseLoadAll(manual);const fresh=$('fresh');
        const full=fresh&&fresh.textContent||'';const checked=state.overview&&state.overview.alerting&&state.overview.alerting.lastCheckedAt;
        if(fresh&&checked&&full.startsWith('每分钟评估')){fresh.title=full;fresh.setAttribute('aria-label',full);fresh.textContent='最近评估 '+when(checked)}
        else if(fresh){fresh.removeAttribute('title');fresh.removeAttribute('aria-label')}
        syncHierarchyReviewNotice();
        return result;
      };
      // Keep the operator's disclosure choices through auto-refresh. IDs are
      // stable across renderers; only DOM disclosure state is retained here.
      const hierarchyDisclosureState=new Map();
      document.addEventListener('toggle',event=>{const node=event.target;if(node&&node.tagName==='DETAILS'&&node.id&&node.closest('#overviewContent'))hierarchyDisclosureState.set(node.id,node.open)},true);
      const hierarchyBaseRenderOverview=renderOverview;
      renderOverview=function(){
        const root=$('overviewContent');
        if(root)root.querySelectorAll('details[id]').forEach(node=>hierarchyDisclosureState.set(node.id,node.open));
        hierarchyBaseRenderOverview();
        if(root)root.querySelectorAll('details[id]').forEach(node=>{if(hierarchyDisclosureState.has(node.id))node.open=hierarchyDisclosureState.get(node.id)});
        syncHierarchyReviewNotice();
      };
      syncHierarchyTabs();
`;
