/** RDK Studio visual layer for the observability workbench.
 *
 * This is intentionally a final, small override layer. The existing styles
 * own component layout and state colours; this layer aligns the shell,
 * surfaces, controls and trace workspace with the RDK Studio visual language.
 */
export const OPS_OBSERVABILITY_BRAND_STYLE = `
@scope (body.ops-observability){
  :scope{
    --rdk-ink:#272b3f;
    --rdk-ink-2:#1f2333;
    --rdk-teal:#00665f;
    --rdk-mint:#00a67e;
    --rdk-bg:#f2f3f5;
    --rdk-panel:#ffffff;
    --rdk-panel-soft:#f7f8f9;
    --rdk-line:rgba(39,43,63,.11);
    --rdk-line-strong:rgba(39,43,63,.20);
    --rdk-muted:#697078;
    --rdk-shadow:0 10px 28px rgba(39,43,63,.08),0 1px 2px rgba(39,43,63,.06);
    --rdk-shadow-hover:0 14px 34px rgba(39,43,63,.14),0 2px 4px rgba(39,43,63,.08);
  }
  :scope.theme-dark{
    --rdk-ink:#e9edf4;
    --rdk-ink-2:#151923;
    --rdk-bg:#11141b;
    --rdk-panel:#1b202a;
    --rdk-panel-soft:#232934;
    --rdk-line:rgba(233,237,244,.12);
    --rdk-line-strong:rgba(233,237,244,.22);
    --rdk-muted:#9ca6b5;
    --rdk-shadow:0 12px 30px rgba(0,0,0,.22),0 1px 2px rgba(0,0,0,.3);
    --rdk-shadow-hover:0 16px 38px rgba(0,0,0,.35),0 2px 4px rgba(0,0,0,.3);
  }
  :scope{background:var(--rdk-bg);color:var(--rdk-ink)}
  header{height:60px;padding:0 26px;background:var(--rdk-ink);border-bottom:0;box-shadow:0 1px 0 rgba(255,255,255,.06)}
  .brand{min-width:238px;gap:11px}.brand-mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(145deg,var(--rdk-mint),var(--rdk-teal));box-shadow:0 5px 14px rgba(0,166,126,.28);font-size:15px}.brand-copy{color:#fff;font-size:14px;letter-spacing:.02em}.brand-copy small{color:rgba(255,255,255,.58);font-size:9px;letter-spacing:.08em}
  .header-context{color:rgba(255,255,255,.58)}.header-product{color:rgba(255,255,255,.9)}.header-divider{background:rgba(255,255,255,.2)}.header-live{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:rgba(255,255,255,.84)}
  .theme-toggle{height:32px;min-width:36px;margin-left:12px;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(255,255,255,.08);color:#fff}.theme-toggle:hover{border-color:var(--rdk-mint);background:rgba(0,166,126,.18);color:#fff}
  .domain-switcher{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.08)}.domain-tab{color:rgba(255,255,255,.62)}.domain-tab[aria-selected="true"]{background:var(--rdk-teal);color:#fff}.domain-hint{color:rgba(255,255,255,.6)}
  .app-shell{grid-template-columns:244px minmax(0,1fr);min-height:calc(100vh - 60px)}
  .side-nav{top:60px;height:calc(100vh - 60px);padding:20px 14px;background:var(--rdk-ink-2);border-right:0;box-shadow:8px 0 24px rgba(39,43,63,.10)}
  .global-nav{margin-bottom:18px;padding-bottom:16px;border-bottom-color:rgba(255,255,255,.10)}.global-nav .nav-section,.nav-title,.nav-section{color:rgba(255,255,255,.42)}
  .global-tab{min-height:40px;padding:10px 12px;border-radius:9px;color:rgba(255,255,255,.68)}.global-tab:hover{background:rgba(255,255,255,.08);color:#fff}.global-tab.active{background:rgba(0,166,126,.18);color:#fff}.global-tab.active:before{border-color:var(--rdk-mint)}
  .nav-group{border-top-color:rgba(255,255,255,.10)}.nav-section-toggle{min-height:42px;margin-top:10px;padding:9px 11px;color:rgba(255,255,255,.60);border-radius:9px}.nav-section-toggle:hover{background:rgba(255,255,255,.07);color:#fff}.nav-toggle-caret{border-top-color:rgba(255,255,255,.45)}.nav-group-items{border-left-color:rgba(255,255,255,.14)}
  .nav-primary .module-tab,.module-tab{min-height:40px;padding:9px 11px;border-radius:9px;color:rgba(255,255,255,.66);background:transparent;box-shadow:none}.module-tab:hover{background:rgba(255,255,255,.08);color:#fff}.module-tab.active,.nav-primary .module-tab.active{background:var(--rdk-teal);color:#fff;box-shadow:0 5px 14px rgba(0,102,95,.28)}.module-tab.active:before{color:#fff}.tab-count,.module-tab.active .tab-count{background:rgba(255,255,255,.16);color:#fff}
  main{padding:32px 42px 64px;background:var(--rdk-bg)}
  .page-head{margin-bottom:24px}.page-kicker,.view-head .eyebrow{color:var(--rdk-teal);font-size:10px;font-weight:750;letter-spacing:.1em}.page-head h1{font-size:32px;letter-spacing:-.045em;color:var(--rdk-ink)}.page-head .page-intro{color:var(--rdk-muted)!important}.page-head #fresh{color:var(--rdk-muted)}
  .env-pill{height:32px;border-color:rgba(0,166,126,.24);background:rgba(0,166,126,.09);color:var(--rdk-teal);box-shadow:none}.env-pill:before{background:var(--rdk-mint);box-shadow:0 0 0 3px rgba(0,166,126,.16)}
  .btn{height:36px;padding:6px 14px;border:1px solid var(--rdk-line-strong);border-radius:8px;background:var(--rdk-panel);color:var(--rdk-ink);font-size:12px;font-weight:650;box-shadow:0 1px 2px rgba(39,43,63,.04)}.btn:hover{border-color:var(--rdk-teal);background:var(--rdk-panel);color:var(--rdk-teal);box-shadow:0 5px 14px rgba(0,102,95,.12);transform:translateY(-1px)}.btn.primary{background:var(--rdk-teal);border-color:var(--rdk-teal);color:#fff;box-shadow:0 6px 16px rgba(0,102,95,.22)}.btn.primary:hover{background:#087a67;border-color:#087a67;color:#fff}.btn:focus-visible,.module-tab:focus-visible,.global-tab:focus-visible{outline:3px solid rgba(0,166,126,.28);outline-offset:2px}
  .global-command-bar{top:60px;margin-bottom:28px;padding:10px;border-color:var(--rdk-line);border-radius:12px;background:color-mix(in srgb,var(--rdk-panel) 92%,transparent);box-shadow:var(--rdk-shadow);backdrop-filter:blur(16px)}.global-search-trigger{min-height:42px;border-color:var(--rdk-line);border-radius:9px;background:var(--rdk-panel-soft)}.global-search-trigger:hover{border-color:rgba(0,102,95,.35);box-shadow:0 4px 12px rgba(0,102,95,.10)}
  .scope-bar{border-color:var(--rdk-line);border-radius:10px;background:var(--rdk-panel);box-shadow:none}
  .view-head{margin-bottom:18px}.view-head h2{font-size:22px;color:var(--rdk-ink)}.view-head p{color:var(--rdk-muted)}.view-head .right{color:var(--rdk-muted)}
  .panel,.detail-sections,.shell-status{border-color:var(--rdk-line);border-radius:14px;background:var(--rdk-panel);box-shadow:var(--rdk-shadow)}.detail-summary{min-height:56px;padding:16px 20px}.detail-sections[open]>.detail-summary{background:var(--rdk-panel-soft);border-bottom-color:var(--rdk-line)}.detail-summary:hover{background:rgba(0,166,126,.06)}
  .section,.action-center,.coverage-panel,.north-star-panel,.impact-panel,.incident-section{padding:22px}.section-head{margin-bottom:18px}.section-head h2,.table-title h2{font-size:16px;color:var(--rdk-ink)}.hint{color:var(--rdk-muted)}
  .metric,.summary-card,.pulse-card,.north-star-card,.incident-card,.trace-stat{border-color:var(--rdk-line);border-radius:11px;background:var(--rdk-panel);box-shadow:none}.metric:hover,.summary-card:hover,.north-star-card:hover{border-color:rgba(0,102,95,.28);box-shadow:var(--rdk-shadow-hover)}.metric .label,.summary-label{color:var(--rdk-muted)}
  .situation-hero{border-radius:14px;background:linear-gradient(135deg,#272b3f 0%,#164c4b 58%,#00665f 100%);box-shadow:0 14px 30px rgba(39,43,63,.18)}
  .trace-native-hero{border-left:0;border-top:4px solid var(--rdk-teal);border-radius:14px;background:linear-gradient(135deg,var(--rdk-panel),rgba(0,166,126,.08));box-shadow:var(--rdk-shadow)}.trace-privacy{background:rgba(0,166,126,.10);color:var(--rdk-teal)}
  .trace-stats{gap:12px}.trace-stat{border-top:3px solid var(--rdk-teal);padding:16px}.trace-stat strong{color:var(--rdk-ink);font-size:22px}.trace-workspace{gap:16px}.trace-explorer,.trace-detail{border-radius:14px;box-shadow:var(--rdk-shadow)}.trace-toolbar{padding:14px 16px;background:var(--rdk-panel-soft);border-bottom-color:var(--rdk-line)}.trace-toolbar .search,.trace-environment select{height:40px;border-color:var(--rdk-line-strong);border-radius:8px;background:var(--rdk-panel);color:var(--rdk-ink)}.trace-filters .btn{height:36px}.trace-filters .active{border-color:var(--rdk-teal);background:rgba(0,166,126,.10);color:var(--rdk-teal)}.trace-row{padding:18px 2px}.trace-row-openable:hover{background:rgba(0,166,126,.045)}.trace-row.selected{background:rgba(0,166,126,.08);box-shadow:inset -3px 0 0 var(--rdk-teal)}.trace-timing div,.trace-context-item,.trace-detail-fact,.trace-evidence-source{border-radius:8px;background:var(--rdk-panel-soft)}.trace-detail-head{background:color-mix(in srgb,var(--rdk-panel) 92%,transparent);border-bottom-color:var(--rdk-line)}
  .toast{border-color:var(--rdk-line-strong);border-radius:10px;background:var(--rdk-panel);box-shadow:var(--rdk-shadow-hover)}
  @media(max-width:1240px){main{padding:28px 24px 56px}}@media(max-width:900px){header{padding:0 16px}.brand{min-width:0}.header-context,.domain-hint{display:none}.app-shell{grid-template-columns:68px minmax(0,1fr)}.side-nav{padding:14px 7px}.global-nav{padding-bottom:10px}.global-tab{font-size:0;justify-content:center}.global-tab:before{margin:0}.nav-section-toggle{justify-content:center;font-size:0}.nav-toggle-label,.nav-group-alert{display:none}.nav-group-items{display:none}.module-tab{justify-content:center;font-size:0}.module-tab:before{font-size:16px}.tab-count{display:none}}@media(max-width:520px){main{padding:22px 14px 48px}.app-shell{display:block}.side-nav{position:static;width:100%;height:auto;border-bottom:1px solid var(--rdk-line);box-shadow:none;padding:7px}.module-tab{font-size:11px;justify-content:flex-start}.module-tab:before{font-size:13px}.nav-group-items{display:grid}.nav-section-toggle{justify-content:flex-start;font-size:11px}.nav-toggle-label{display:block}.page-head h1{font-size:27px}.page-head-actions{width:100%}}
}
`;
