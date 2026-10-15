/** Final visual system for the task-first workspace. Component behaviour stays
 * in the owning modules; this layer gives every view the same quiet shell. */
export const OPS_OBSERVABILITY_FOCUS_STYLE = `
  body.ops-observability{
    --focus-canvas:#f6f5f2;--focus-surface:#ffffff;--focus-subtle:#f2f1ee;
    --focus-text:#242522;--focus-muted:#70716b;--focus-line:#e6e5e0;--focus-line-strong:#d5d4ce;
    --focus-brand:#b65126;--focus-brand-strong:#96401c;--focus-brand-soft:#f8eee7;
    --status-positive:#298153;--status-warning:#ad781b;--status-negative:#c34646;
    --bg:var(--focus-canvas);--panel:var(--focus-surface);--panel2:var(--focus-subtle);
    --ui-canvas:var(--focus-canvas);--ui-surface:var(--focus-surface);--ui-subtle:var(--focus-subtle);--ui-border:var(--focus-line);
    --text:var(--focus-text);--muted:var(--focus-muted);--line:var(--focus-line);--line2:var(--focus-line-strong);
    --green:var(--focus-brand);--green-strong:var(--focus-brand-strong);--green-soft:var(--focus-brand-soft);
    --orange:var(--status-warning);--red:var(--status-negative);
    --shell:var(--focus-surface);--shell-head:var(--focus-surface);--shell-side:var(--focus-surface);
    --shadow:0 14px 44px rgba(28,29,25,.12);--shadow-soft:none;
    background:var(--focus-canvas);color:var(--text);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    letter-spacing:0;-webkit-font-smoothing:antialiased;
  }
  html[data-theme="dark"] body.ops-observability{
    --focus-canvas:#17191c;--focus-surface:#202226;--focus-subtle:#282b30;
    --focus-text:#ededeb;--focus-muted:#a7aaa7;--focus-line:#34373c;--focus-line-strong:#4b4e53;
    --focus-brand:#ec956d;--focus-brand-strong:#f3ab89;--focus-brand-soft:#372c27;
    --status-positive:#79bf94;--status-warning:#dbb66a;--status-negative:#ec8c8c;
    --shadow:0 14px 44px rgba(0,0,0,.3);
  }
  body.ops-observability header{
    height:64px;padding:0 28px;gap:18px;background:var(--focus-surface);color:var(--text);
    border-bottom:1px solid var(--line);box-shadow:none;
  }
  body.ops-observability header .brand{min-width:180px;gap:10px}
  body.ops-observability header .brand-mark{
    width:32px;height:32px;border-radius:9px;background:var(--focus-brand-soft);
    color:var(--green);box-shadow:none;font-size:15px;
  }
  body.ops-observability header .brand-copy{color:var(--text);font-size:14px;font-weight:650;letter-spacing:0}
  body.ops-observability header .brand-copy small{color:var(--muted);font-size:10px;letter-spacing:.02em;text-transform:none}
  body.ops-observability header .domain-switcher{background:var(--focus-subtle);border:0;border-radius:8px;padding:3px;gap:2px}
  body.ops-observability header .domain-tab{color:var(--muted);font-size:12px;padding:6px 12px}
  body.ops-observability header .domain-tab[aria-selected="true"]{color:var(--text);background:var(--focus-surface);box-shadow:none;font-weight:600}
  body.ops-observability header .global-search-trigger{
    flex:0 1 280px;min-width:140px;min-height:36px;margin-left:auto;padding:7px 10px;
    background:var(--focus-subtle);border:1px solid transparent;border-radius:8px;color:var(--muted);box-shadow:none;
  }
  body.ops-observability header .global-search-trigger:hover{background:var(--focus-subtle);border-color:var(--line2);color:var(--text);transform:none}
  body.ops-observability header .global-search-trigger:before{content:"";display:block;flex:0 0 17px;width:17px;height:17px;color:var(--muted);background:currentColor;border-radius:0;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round'%3E%3Ccircle cx='8.5' cy='8.5' r='5.5'/%3E%3Cpath d='m12.5 12.5 4 4'/%3E%3C/svg%3E") center/contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round'%3E%3Ccircle cx='8.5' cy='8.5' r='5.5'/%3E%3Cpath d='m12.5 12.5 4 4'/%3E%3C/svg%3E") center/contain no-repeat}
  body.ops-observability header .global-search-trigger:after{content:none;display:none}
  body.ops-observability header .global-search-copy strong{font-size:12px;font-weight:400}
  body.ops-observability header .global-search-trigger kbd{background:var(--focus-surface);border-color:var(--line);color:var(--muted);font-size:10px}
  body.ops-observability header .theme-toggle{height:34px;min-width:34px;color:var(--muted);border-color:transparent;background:transparent;border-radius:8px}
  body.ops-observability header .theme-toggle:hover{background:var(--focus-subtle);color:var(--text)}
  body.ops-observability header .header-live{color:var(--muted);background:transparent;border:0;padding:5px 0;font-size:12px}
  body.ops-observability header .header-live:before{box-shadow:none;background:var(--muted)}
  body.ops-observability header .header-live.live:before{box-shadow:none;background:var(--status-positive)}
  body.ops-observability header .header-live.stale:before{box-shadow:none;background:var(--orange)}
  body.ops-observability header .header-live.error:before,body.ops-observability header .header-live.unauthorized:before{box-shadow:none;background:var(--red)}
  /* Keep shell foregrounds semantic: the legacy palette uses its panel color
     as the header foreground in dark mode. */
  html[data-theme="dark"] body.ops-observability header,
  html[data-theme="dark"] body.ops-observability header .brand-copy{color:var(--text)}
  html[data-theme="dark"] body.ops-observability header .brand-copy small,
  html[data-theme="dark"] body.ops-observability header .domain-tab,
  html[data-theme="dark"] body.ops-observability header .global-search-trigger,
  html[data-theme="dark"] body.ops-observability header .global-search-trigger:before,
  html[data-theme="dark"] body.ops-observability header .global-search-trigger kbd,
  html[data-theme="dark"] body.ops-observability header .theme-toggle{color:var(--muted)}
  html[data-theme="dark"] body.ops-observability header .domain-switcher,
  html[data-theme="dark"] body.ops-observability header .global-search-trigger{background:var(--focus-subtle);border-color:transparent}
  html[data-theme="dark"] body.ops-observability header .domain-tab[aria-selected="true"]{background:var(--focus-surface);color:var(--text)}
  html[data-theme="dark"] body.ops-observability header .global-search-trigger kbd{background:var(--focus-surface);border-color:var(--line)}

  body.ops-observability .app-shell{grid-template-columns:224px minmax(0,1fr);min-height:calc(100vh - 64px)}
  body.ops-observability .side-nav{top:64px;height:calc(100vh - 64px);padding:24px 14px;background:var(--focus-surface);border-right-color:var(--line);box-shadow:none}
  body.ops-observability .nav-primary{display:none}
  body.ops-observability .nav-main{display:grid;gap:5px}
  body.ops-observability .nav-main:empty{display:none}
  body.ops-observability .nav-main .module-tab{min-height:44px;padding:11px 12px;font-size:14px;color:var(--text);border-radius:9px;font-weight:500}
  body.ops-observability .module-tab{min-height:39px;padding:9px 12px;color:var(--muted);font-size:13px;border-radius:8px}
  body.ops-observability .module-tab:before{color:var(--muted);font-size:16px;flex:0 0 20px}
  body.ops-observability .module-tab:hover{background:var(--focus-subtle);color:var(--text)}
  body.ops-observability .module-tab.active{background:var(--green-soft);color:var(--green-strong);box-shadow:none;font-weight:600}
  body.ops-observability .module-tab.active:before{color:var(--green-strong)}
  body.ops-observability .tab-count{background:var(--focus-subtle);color:var(--muted);font-size:11px;line-height:20px;min-width:22px;text-align:center}
  body.ops-observability .module-tab.active .tab-count{background:var(--focus-surface);color:var(--green-strong)}
  body.ops-observability .nav-secondary-label{margin:27px 12px 8px;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:.02em}
  body.ops-observability .nav-group,body.ops-observability .nav-group+.nav-group{border:0;margin-top:3px;padding-top:0}
  body.ops-observability .nav-section-toggle{min-height:39px;margin:0;padding:8px 12px;color:var(--muted);font-size:12px;font-weight:500}
  body.ops-observability .nav-group-items{gap:2px;margin:2px 0 8px;padding-left:10px;border-left:0}
  body.ops-observability .nav-toggle-caret{border-left-color:var(--muted);opacity:.7}
  body.ops-observability .side-nav-footer{border-color:var(--line);padding:18px 10px 0;gap:10px;font-size:12px}
  body.ops-observability .side-nav-footer .btn{height:34px;font-size:12px}
  body.ops-observability #startWorkbenchTour{color:var(--muted);background:transparent;border-color:transparent;box-shadow:none}
  body.ops-observability #startWorkbenchTour:hover{background:var(--focus-subtle);color:var(--text)}
  body.ops-observability .nav-help{display:flex;align-items:center;gap:9px;min-height:38px;margin:26px 8px 0;padding:8px 5px;font:inherit;font-size:12px;cursor:pointer;border:0;border-radius:7px;text-align:left}
  body.ops-observability .nav-help>span{display:grid;place-items:center;width:18px;height:18px;border:1px solid var(--line2);border-radius:50%;font-size:11px}
  body.ops-observability .focus-context-hidden{display:none!important}

  body.ops-observability main{width:100%;max-width:1560px;margin:0 auto;padding:36px 44px 64px;background:var(--focus-canvas)}
  body.ops-observability main>*{max-width:1360px}
  body.ops-observability .page-head{gap:28px;padding:0;margin-bottom:24px;border-bottom:0;align-items:flex-start}
  body.ops-observability .page-head h1{font-size:32px;font-weight:650;line-height:1.25;letter-spacing:-.035em;margin:0 0 9px}
  body.ops-observability .page-kicker{font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--muted);margin-bottom:7px}
  body.ops-observability .page-head .page-intro{font-size:13px!important;line-height:1.7;color:var(--muted)!important;max-width:600px}
  body.ops-observability .page-head-actions{gap:9px}
  body.ops-observability .page-head-controls{gap:8px}
  body.ops-observability .workspace-facts,body.ops-observability #fresh{font-size:12px;color:var(--muted)}
  body.ops-observability .env-pill{border:0;border-radius:6px;background:var(--focus-subtle);font-size:11px;font-weight:500;color:var(--muted);box-shadow:none}
  body.ops-observability .env-pill:before{content:none;display:none}
  body.ops-observability .scope-control select{height:34px;border-color:var(--line);background:var(--focus-surface);font-weight:500}
  body.ops-observability .btn{height:36px;padding:7px 13px;border:1px solid var(--line2);border-radius:8px;background:var(--focus-surface);color:var(--text);font-size:12px;font-weight:500;box-shadow:none;transform:none}
  body.ops-observability .btn:hover{background:var(--focus-subtle);border-color:var(--line2);color:var(--text);box-shadow:none;transform:none}
  body.ops-observability .btn.primary{background:var(--green);border-color:var(--green);color:#fff;box-shadow:none}
  body.ops-observability .btn.primary:hover{background:var(--green-strong);border-color:var(--green-strong);color:#fff;box-shadow:none}
  html[data-theme="dark"] body.ops-observability .btn.primary{color:#241c17}
  body.ops-observability :is(button,a,input,select,textarea,summary):focus-visible{outline:2px solid var(--green);outline-offset:3px}
  body.ops-observability .panel{border:1px solid var(--line);border-radius:14px;background:var(--focus-surface);box-shadow:none}
  body.ops-observability :is(.section,.impact-panel,.north-star-panel,.action-center,.coverage-panel,.incident-section){padding:24px}
  body.ops-observability .incident-section{padding:22px}
  body.ops-observability .section-head{margin-bottom:14px}
  body.ops-observability .section-head h2,body.ops-observability .table-title h2{font-size:16px;font-weight:600;line-height:1.4;letter-spacing:-.01em}
  body.ops-observability .section-head .hint,body.ops-observability .hint{font-size:12px;line-height:1.7;color:var(--muted)}
  body.ops-observability .section-head .right{font-size:12px}
  body.ops-observability .section-head h2:before,body.ops-observability .overview-stack>.panel:before,body.ops-observability .overview-stack>details:before{display:none}
  body.ops-observability :is(.metric,.summary-card,.north-star-card,.pulse-card,.incident-card,.check){box-shadow:none;transform:none}
  body.ops-observability :is(.north-star-card,.pulse-card,.incident-card):hover{box-shadow:none;transform:none}
  body.ops-observability .metric .value,body.ops-observability .summary-value,body.ops-observability .north-star-value{font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums}
  body.ops-observability .metric .value.good{color:var(--status-positive)}
  body.ops-observability .module-switcher{background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0;margin-bottom:24px;gap:24px;overflow-x:auto;scrollbar-width:thin}
  body.ops-observability .module-switch-tab{min-height:44px;padding:9px 0 12px;border:0;border-bottom:2px solid transparent;border-radius:0;font-size:13px;background:transparent;color:var(--muted);box-shadow:none;white-space:nowrap}
  body.ops-observability .module-switch-tab:hover{background:transparent;color:var(--text)}
  body.ops-observability .module-switch-tab.is-active{background:transparent;border-color:var(--green);color:var(--text);font-weight:600;box-shadow:none}
  body.ops-observability .detail-sections{background:var(--focus-surface);border-color:var(--line);box-shadow:none;border-radius:12px}
  body.ops-observability .detail-summary{padding:17px 22px;font-size:14px;font-weight:500;min-height:54px;color:var(--text)}
  body.ops-observability .detail-summary span{font-size:12px;line-height:1.6;color:var(--muted)}
  body.ops-observability .detail-sections[open]>.detail-summary{background:var(--focus-surface);border-color:var(--line)}
  body.ops-observability .detail-sections>*:not(.detail-summary){margin:20px}
  body.ops-observability .detail-sections>*:not(.detail-summary):is(.panel,.table-panel){border:0;box-shadow:none}
  body.ops-observability .overview-stack{gap:28px}
  body.ops-observability .overview-primary{gap:20px}
  body.ops-observability #overviewContent :is(.overview-group,.focus-overview,.focus-detail-body,.remediate-list){grid-template-columns:minmax(0,1fr)}
  body.ops-observability #overviewContent :is(.overview-group,.focus-overview,.focus-detail-body,.remediate-list)>*{min-width:0}
  body.ops-observability #overviewContent :is(.overview-incident-copy,.remediate-body,.check-summary,.incident-summary,.hero-title,.hero-detail,.overview-product-definition,.action-loop-identity>div){min-width:0;overflow-wrap:anywhere}
  body.ops-observability .overview-primary>.overview-group-head,body.ops-observability .overview-secondary>.overview-group-head{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}
  body.ops-observability .overview-primary>.hero{padding:22px 24px;border:1px solid var(--line);border-radius:14px;border-left-width:1px;background:var(--focus-surface);box-shadow:none}
  body.ops-observability .overview-primary>.hero:is(.healthy,.warning,.critical,.stale){background:var(--focus-surface);border-color:var(--line);border-left-width:1px}
  body.ops-observability .overview-primary>.hero:after{display:none}
  body.ops-observability .overview-primary .hero-title{font-size:23px;font-weight:600;line-height:1.35;color:var(--text)}
  body.ops-observability .overview-primary .hero-detail{font-size:13px;line-height:1.7;color:var(--muted)}
  body.ops-observability .overview-primary .hero-icon{background:var(--focus-subtle);color:var(--muted);box-shadow:none}
  body.ops-observability .overview-primary>.hero.healthy .hero-icon{color:var(--status-positive);background:color-mix(in srgb,var(--status-positive) 9%,var(--focus-surface))}
  body.ops-observability .overview-primary>.hero:is(.warning,.stale) .hero-icon{color:var(--orange);background:color-mix(in srgb,var(--orange) 9%,var(--focus-surface))}
  body.ops-observability .overview-primary>.hero.critical .hero-icon{color:var(--red);background:color-mix(in srgb,var(--red) 9%,var(--focus-surface))}
  body.ops-observability .overview-primary>.metrics{border-color:var(--line);border-radius:14px;background:var(--focus-surface)}
  body.ops-observability .overview-primary>.metrics>.metric{padding:18px 20px;border-right-color:var(--line)}
  body.ops-observability .overview-group-head h2,body.ops-observability .overview-group-title{font-size:14px;font-weight:600}
  body.ops-observability .overview-incident-row{padding:17px 0;border-color:var(--line)}
  body.ops-observability .focus-overview{display:grid;gap:14px;min-width:0}
  body.ops-observability .focus-overview>details{margin:0;border:1px solid var(--line);border-radius:12px;background:var(--focus-surface);box-shadow:none;min-width:0}
  body.ops-observability .focus-overview>details>summary{display:flex;align-items:center;gap:12px;padding:19px 22px;list-style:none;cursor:pointer;font-size:14px;font-weight:500;color:var(--text)}
  body.ops-observability .focus-overview>details>summary::-webkit-details-marker{display:none}
  body.ops-observability .focus-overview>details>summary:after{content:"⌄";margin-left:auto;color:var(--muted);font-size:15px;transition:transform .16s ease}
  body.ops-observability .focus-overview>details[open]>summary:after{transform:rotate(180deg)}
  body.ops-observability .focus-overview>details>summary span{font-size:12px;font-weight:400;color:var(--muted);line-height:1.6}
  body.ops-observability .focus-overview>details[open]>summary{border-bottom:1px solid var(--line)}
  body.ops-observability .focus-overview>details>.focus-detail-body{padding:22px;display:grid;gap:22px;min-width:0}
  body.ops-observability .focus-overview .overview-secondary{padding:0;border:0;gap:24px}
  body.ops-observability .focus-overview .panel{border:0;padding:0;box-shadow:none;background:transparent}
  body.ops-observability .focus-overview .north-star-card{background:var(--focus-subtle);border:0;border-radius:9px}
  body.ops-observability .focus-inline-empty{margin:0;border:0;border-radius:0;background:transparent;box-shadow:none}
  body.ops-observability .focus-inline-empty>.detail-summary{display:none}
  body.ops-observability .focus-inline-empty>*:not(.detail-summary){margin:0}
  body.ops-observability :is(.rules-head,.metric-head,.template-head){background:var(--focus-subtle);font-size:12px;letter-spacing:0;text-transform:none}
  body.ops-observability :is(.rule-row,.metric-row,.template-row){box-shadow:none;background:var(--focus-surface);font-size:13px}
  body.ops-observability :is(.rule-row,.metric-row,.template-row):hover{background:var(--focus-subtle);box-shadow:none}
  body.ops-observability .rule-title,body.ops-observability .incident-title{font-size:13px;font-weight:600;color:var(--text)}
  body.ops-observability .rule-meta{font-size:11px;color:var(--muted)}
  body.ops-observability .signals-query-card,body.ops-observability .signals-chart-wrap{background:var(--focus-surface);border-color:var(--line);box-shadow:none}
  body.ops-observability .domain-note{padding:12px 16px;background:var(--focus-subtle);border:0;border-radius:8px;font-size:12px;box-shadow:none}
  body.ops-observability .table-title,body.ops-observability .ic-toolbar,body.ops-observability .ic-table th{background:var(--focus-subtle);border-color:var(--line)}
  body.ops-observability .shell-status{background:var(--focus-surface);box-shadow:none}
  body.ops-observability .tour-card{border-color:var(--line);background:var(--focus-surface);box-shadow:var(--shadow);border-radius:14px}
  body.ops-observability .tour-card h3{font-size:16px;color:var(--text);font-weight:600}
  body.ops-observability .tour-card p{font-size:13px;color:var(--muted);line-height:1.7}
  body.ops-observability .board-toolbar{gap:12px 18px;align-items:flex-end;margin-bottom:18px}
  body.ops-observability .board-toolbar-group{gap:10px}
  body.ops-observability .board-toolbar-group.board-toolbar-actions{margin-left:auto;border:0;padding-left:0}
  body.ops-observability .board-compact-label{gap:6px;font-size:12px;color:var(--muted)}
  body.ops-observability .board-toolbar select{height:36px;border-color:var(--line2);background:var(--focus-surface);border-radius:8px;font-size:12px}
  body.ops-observability .board-toolbar .btn{height:36px;padding:7px 12px}
  body.ops-observability .focus-tools{min-width:0}
  body.ops-observability .focus-tools>summary{display:flex;align-items:center;gap:10px;list-style:none;width:max-content;cursor:pointer}
  body.ops-observability .focus-tools>summary::-webkit-details-marker{display:none}
  body.ops-observability .focus-tools>summary:after{content:"⌄";font-size:14px;color:var(--muted)}
  body.ops-observability .focus-tools[open]>summary:after{transform:rotate(180deg)}
  body.ops-observability .board-toolbar:has(.focus-tools[open]) .board-toolbar-actions{flex:1 0 100%;margin:0;align-items:flex-start}
  body.ops-observability .focus-tools[open]{flex:1 1 0}
  body.ops-observability .focus-tools-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px;padding:18px;background:var(--focus-subtle);border-radius:12px;border:1px solid var(--line)}
  body.ops-observability .focus-tools-body .btn{width:100%;height:auto;min-height:36px;white-space:normal;text-align:center;justify-content:center}
  body.ops-observability .focus-tools-body .board-compact-label{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;min-width:0}
  body.ops-observability .focus-tools-body select{max-width:100%;min-width:0;flex:1 1 90px}
  body.ops-observability .focus-tools-body .btn.danger{color:var(--red);border-color:color-mix(in srgb,var(--red) 35%,var(--line));background:var(--focus-surface)}

  @media(max-width:1280px){
    body.ops-observability main{padding:30px 28px 56px}
    body.ops-observability header{padding:0 22px;gap:14px}
    body.ops-observability header .brand{min-width:174px}
  }
  @media(max-width:1120px){
    body.ops-observability .page-head{gap:16px;flex-direction:column}
    body.ops-observability .page-head h1{font-size:30px}
    body.ops-observability .page-head-actions{width:100%;max-width:none;align-items:flex-start}
    body.ops-observability .page-head-controls,body.ops-observability .workspace-facts{justify-content:flex-start}
  }
  @media(min-width:721px) and (max-width:900px){
    body.ops-observability .app-shell{grid-template-columns:200px minmax(0,1fr)}
    body.ops-observability .side-nav{padding:22px 10px;top:64px;height:calc(100vh - 64px)}
    body.ops-observability main{padding:28px 22px 48px}
    body.ops-observability header .brand{min-width:154px}
    body.ops-observability header .global-search-trigger{min-width:100px}
  }
  @media(max-width:720px){
    body.ops-observability #overviewContent .remediate-item{flex-wrap:wrap}
    body.ops-observability #overviewContent .remediate-body{flex:1 1 100%}
    body.ops-observability header{height:60px;padding:0 14px;gap:8px}
    body.ops-observability header .brand{min-width:0;gap:7px}
    body.ops-observability header .brand-mark{width:28px;height:28px;font-size:14px}
    body.ops-observability header .brand-copy{font-size:12px}
    body.ops-observability header .domain-tab{padding:6px 8px;font-size:11px}
    body.ops-observability header .global-search-trigger{flex:0 0 34px;min-width:34px;min-height:34px;padding:5px;justify-content:center}
    body.ops-observability header .theme-toggle{min-width:30px;height:32px}
    body.ops-observability .app-shell{display:block;min-height:calc(100vh - 60px);padding-bottom:calc(68px + env(safe-area-inset-bottom))}
    body.ops-observability main{padding:24px 16px 36px}
    body.ops-observability .page-head{gap:14px;margin-bottom:24px;padding:0}
    body.ops-observability .page-head h1{font-size:27px}
    body.ops-observability .page-head .page-intro{font-size:12px!important;max-width:100%}
    body.ops-observability .workspace-facts{gap:6px 12px}
    body.ops-observability .page-head-controls{flex-wrap:wrap}
    body.ops-observability .page-head-actions .btn{min-width:0}
    body.ops-observability .module-switcher{gap:20px;margin-bottom:20px}
    body.ops-observability .module-switch-tab{font-size:12px;padding:8px 0 11px}
    body.ops-observability .overview-stack{gap:22px}
    body.ops-observability .overview-primary{gap:16px}
    body.ops-observability .overview-primary>.hero{padding:22px 20px}
    body.ops-observability .overview-primary .hero-title{font-size:20px}
    body.ops-observability .overview-primary>.metrics>.metric{padding:18px}
    body.ops-observability :is(.section,.impact-panel,.north-star-panel,.action-center,.coverage-panel,.incident-section){padding:20px}
    body.ops-observability .detail-summary{padding:17px 18px}
    body.ops-observability .board-toolbar{gap:12px}
    body.ops-observability .board-toolbar-group{width:100%;gap:8px}
    body.ops-observability .board-compact-label{flex:1 1 130px;min-width:0}
    body.ops-observability .board-compact-label select{max-width:100%;min-width:0}
    body.ops-observability .board-toolbar .board-toolbar-actions{margin:0;align-items:flex-start}
    body.ops-observability .focus-tools-body{grid-template-columns:repeat(2,minmax(0,1fr));padding:14px;gap:8px}
    body.ops-observability .focus-overview>details>summary{flex-wrap:wrap;gap:5px 12px;padding:18px}
    body.ops-observability .focus-overview>details>summary span{order:2;flex-basis:100%}
    body.ops-observability .focus-overview>details>.focus-detail-body{padding:18px;gap:20px}
    body.ops-observability .side-nav{position:fixed;left:0;right:0;bottom:0;top:auto;height:auto;padding:0;border-right:0;border-top:1px solid var(--line);background:var(--focus-surface);box-shadow:none}
    body.ops-observability .side-nav:not(:has(.mobile-expanded)) .side-nav-footer{display:none}
    body.ops-observability .nav-secondary-label{display:none}
    body.ops-observability .module-tabs:not(.mobile-expanded){display:flex;gap:0;padding:4px max(5px,env(safe-area-inset-right)) env(safe-area-inset-bottom) max(5px,env(safe-area-inset-left))}
    body.ops-observability .module-tabs:not(.mobile-expanded) .nav-primary{display:flex;flex:5 1 0;gap:0;min-width:0}
    body.ops-observability .module-tabs:not(.mobile-expanded) .nav-main{display:none}
    body.ops-observability .module-tabs:not(.mobile-expanded) .nav-help{display:none}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab.mobile-primary{position:relative;min-height:56px;height:56px;padding:6px 2px;gap:4px;flex:1 1 0;font-size:10px;line-height:1.2;border-radius:8px}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab.active{box-shadow:none;background:var(--green-soft)}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab:before{flex:0 0 auto;line-height:20px;font-size:18px}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab.mobile-more-toggle{
      position:static;display:flex;flex:1 1 0;min-width:0;width:auto;height:56px;min-height:56px;
      margin:0;padding:6px 2px;border:0;border-radius:8px;background:transparent;color:var(--muted);box-shadow:none;gap:4px;
    }
    body.ops-observability .module-tabs:not(.mobile-expanded) .mobile-more-toggle span{font-size:10px}
    body.ops-observability .side-nav:has(.mobile-expanded){max-height:min(80vh,calc(100dvh - 64px));overflow:auto;overscroll-behavior:contain}
    body.ops-observability .module-tabs.mobile-expanded{padding:14px 14px 12px;max-height:none;overflow:visible;gap:12px;background:var(--focus-surface);border-top:0}
    body.ops-observability .module-tabs.mobile-expanded .nav-primary{display:grid;grid-template-columns:1fr 1fr;gap:5px}
    body.ops-observability .module-tabs.mobile-expanded .nav-main:empty{display:none}
    body.ops-observability .module-tabs.mobile-expanded .nav-group{margin:0;display:block}
    body.ops-observability .module-tabs.mobile-expanded .nav-section-toggle{font-size:12px;min-height:36px}
    body.ops-observability .module-tabs.mobile-expanded .module-tab{min-height:42px;height:auto;font-size:12px;flex-direction:row;padding:10px;gap:8px;white-space:normal}
    body.ops-observability .module-tabs.mobile-expanded .module-tab:before{flex:0 0 20px;font-size:17px}
    body.ops-observability .module-tabs.mobile-expanded .mobile-more-toggle{position:static;width:100%;height:38px;display:flex;flex-direction:row;justify-content:center;border:1px solid var(--line);background:var(--focus-subtle);box-shadow:none}
    body.ops-observability .module-tabs.mobile-expanded .mobile-more-toggle span{font-size:12px}
    body.ops-observability .module-tabs.mobile-expanded .nav-help{display:flex;width:100%;margin:0;padding:10px;border-top:1px solid var(--line);border-radius:0}
    body.ops-observability .side-nav:has(.mobile-expanded) .side-nav-footer{padding:12px 24px calc(12px + env(safe-area-inset-bottom));max-height:none;overflow:visible}
  }
  @media(max-width:520px){
    body.ops-observability header{padding:0 10px;gap:6px}
    body.ops-observability header .domain-tab{padding:6px;font-size:10px}
    body.ops-observability main{padding:22px 14px 30px}
    body.ops-observability .page-head h1{font-size:26px}
    body.ops-observability .workspace-fact{padding:0;min-height:20px}
    body.ops-observability .focus-overview>details>summary{padding:17px}
    body.ops-observability .focus-overview>details>.focus-detail-body{padding:17px}
    body.ops-observability .focus-tools-body{grid-template-columns:minmax(0,1fr)}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab .tab-count{right:calc(50% - 23px);top:1px;min-width:16px;line-height:16px;font-size:9px;padding:0 4px}
  }

  /* One coherent icon set; text labels remain the accessible names. */
  body.ops-observability .module-tab[data-view="overview"]:before{content:"";width:18px;height:18px;flex:0 0 18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%223%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%2213%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%2213%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%223%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%2213%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3Crect%20x%3D%2213%22%20y%3D%2213%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat}
  body.ops-observability .module-tab[data-view="alerts/center"]:before{content:"";width:18px;height:18px;flex:0 0 18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12%203a6%206%200%200%200-6%206c0%205-2%205-2%207h16c0-2-2-2-2-7a6%206%200%200%200-6-6Z%22%2F%3E%3Cpath%20d%3D%22M10%2020h4%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12%203a6%206%200%200%200-6%206c0%205-2%205-2%207h16c0-2-2-2-2-7a6%206%200%200%200-6-6Z%22%2F%3E%3Cpath%20d%3D%22M10%2020h4%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat}
  body.ops-observability .module-tab[data-view="traces"]:before{content:"";width:18px;height:18px;flex:0 0 18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%225%22%20cy%3D%225%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%225%22%20cy%3D%2217%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2217%22%20cy%3D%2211%22%20r%3D%222%22%2F%3E%3Cpath%20d%3D%22M5%207v8m2-10h3a7%207%200%200%201%207%204%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%225%22%20cy%3D%225%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%225%22%20cy%3D%2217%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2217%22%20cy%3D%2211%22%20r%3D%222%22%2F%3E%3Cpath%20d%3D%22M5%207v8m2-10h3a7%207%200%200%201%207%204%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat}
  body.ops-observability .module-tab[data-view="signals"]:before{content:"";width:18px;height:18px;flex:0 0 18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%2017h3l3-10%204%2014%203-11%202%207h3%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%2017h3l3-10%204%2014%203-11%202%207h3%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat}
  body.ops-observability .module-tab[data-view="devices"]:before{content:"";width:18px;height:18px;flex:0 0 18px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%226%22%20y%3D%226%22%20width%3D%2212%22%20height%3D%2212%22%20rx%3D%222%22%2F%3E%3Cpath%20d%3D%22M9%202v4m6-4v4M9%2018v4m6-4v4M2%209h4m-4%206h4m12-6h4m-4%206h4%22%2F%3E%3Crect%20x%3D%229%22%20y%3D%229%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Crect%20x%3D%226%22%20y%3D%226%22%20width%3D%2212%22%20height%3D%2212%22%20rx%3D%222%22%2F%3E%3Cpath%20d%3D%22M9%202v4m6-4v4M9%2018v4m6-4v4M2%209h4m-4%206h4m12-6h4m-4%206h4%22%2F%3E%3Crect%20x%3D%229%22%20y%3D%229%22%20width%3D%226%22%20height%3D%226%22%20rx%3D%221%22%2F%3E%3C%2Fsvg%3E") center / contain no-repeat}
  @media(max-width:720px){
    body.ops-observability .module-tabs.mobile-expanded .nav-toggle-label{display:block;flex:1 1 auto;text-align:left;color:var(--text)}
    body.ops-observability .module-tabs.mobile-expanded .nav-section-toggle{justify-content:flex-start;gap:9px}
    body.ops-observability .module-tabs .tab-count:not([hidden]){display:inline-flex;align-items:center;justify-content:center}
    body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab .tab-count:not([hidden]){position:absolute;top:2px;right:calc(50% - 23px);min-width:17px;height:17px;padding:0 4px;font-size:9px;line-height:17px;background:var(--focus-brand-soft);color:var(--focus-brand-strong)}
    body.ops-observability #refresh{width:auto;min-width:78px;flex:0 0 auto;font-size:12px;white-space:nowrap}
    body.ops-observability .page-head-controls>.workspace-options{flex:0 0 auto}
    body.ops-observability .page-head-controls>.workspace-options>summary{white-space:nowrap;min-height:32px;padding:7px 8px;font-size:12px}
  }
  @media(prefers-reduced-motion:reduce){body.ops-observability *,body.ops-observability *:before,body.ops-observability *:after{transition:none;animation:none;scroll-behavior:auto}}
`;
