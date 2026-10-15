/** 观测查询 / 边缘设备视图样式（配色复用全局 palette token）。 */
export const OPS_OBSERVABILITY_SIGNALS_STYLE = `
.signals-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}
.nav-primary .module-tab{background:transparent}
.nav-primary .module-tab.active{background:var(--c422)}
.signals-toolbar label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);white-space:nowrap}
.signals-toolbar label.grow{flex:1 1 300px}
.signals-toolbar input,.signals-toolbar select{height:32px;border:1px solid var(--line2);border-radius:7px;background:var(--panel);color:var(--text);padding:0 10px;outline:none;font-size:12px}
.signals-toolbar input{min-width:170px}
.signals-toolbar label.grow input{width:100%;min-width:0;flex:1 1 auto}
.signals-toolbar select{min-width:112px;cursor:pointer}
.signals-toolbar input:focus,.signals-toolbar select:focus{border-color:var(--green);box-shadow:0 0 0 2px var(--c23)}
.signals-toolbar input::placeholder{color:var(--muted);opacity:.65}
.signals-query-card{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:16px;margin:0 0 12px;box-shadow:0 4px 12px var(--c21),0 0 1px var(--c22)}
.signals-query-card .signals-toolbar{margin:12px 0 0}
.signals-query-divider{border-top:1px dashed var(--line2);margin:14px -16px 0}
.nl-hero{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.nl-hero-mark{flex:0 0 auto;width:36px;height:36px;border-radius:8px;background:var(--panel2);color:var(--green);display:grid;place-items:center;font-size:17px}
.nl-hero input{flex:1 1 auto;min-width:0;height:36px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);color:var(--text);padding:0 12px;font-size:13px;outline:none}
.nl-hero input:focus{border-color:var(--green);box-shadow:0 0 0 2px var(--c23)}
.nl-hero input::placeholder{color:var(--muted);opacity:.65}
.nl-hero .btn{height:36px;border-radius:8px;padding:0 16px}
.nl-hint{margin:8px 1px 0;font-size:11px;color:var(--muted)}
#nlQueryResult{margin-top:12px}
#nlQueryResult:empty{display:none}
.signals-note{margin:0 0 10px;color:var(--muted);font-size:12px}
.board-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px}
.board-toolbar-group{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.board-toolbar-group.board-toolbar-actions{padding-left:8px;border-left:1px solid var(--line)}
.board-compact-label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}
.board-compact-label select,.board-compact-label input{height:30px;font-size:12px;min-width:0}
.board-toolbar .btn{height:30px;padding:0 11px;font-size:12px}
.board-range-bar{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}
.board-range-bar .board-compact-label input{width:190px}
.signals-chart-wrap{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:12px;overflow:hidden;position:relative}
.signals-chart-wrap svg{display:block;width:100%;height:auto}
.signals-legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:11px;color:var(--muted)}
.signals-legend .swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle}
.signals-empty{color:var(--muted);font-size:12px;padding:22px 12px;text-align:center}
.signals-chart-wrap>.signals-empty{padding:40px 12px}
.signals-log-table{width:100%;border-collapse:collapse;font-size:12px}
.signals-log-table th,.signals-log-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.signals-log-table th{color:var(--muted);font-weight:500;font-size:11px}
.signals-log-sev{display:inline-block;min-width:44px;text-align:center;border-radius:4px;font-size:10px;padding:2px 4px;font-weight:600}
.signals-log-sev.ERROR,.signals-log-sev.FATAL{background:rgba(239,68,68,.15);color:#ef4444}
.signals-log-sev.WARN{background:rgba(245,158,11,.15);color:#d97706}
.signals-log-sev.INFO,.signals-log-sev.DEBUG,.signals-log-sev.TRACE{background:rgba(59,130,246,.12);color:#3b82f6}
.signals-panel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.signals-panel-card{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:12px}
.signals-panel-card h4{margin:0 0 8px;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.signals-panel-card h4>span:first-child{flex:1;min-width:0}
.signals-panel-card h4 div{font-weight:400;color:var(--muted);font-size:11px;margin-top:2px;word-break:break-all}
.signals-panel-card.full{grid-column:1/-1}
.signals-panel-card.dragging{opacity:.45;outline:2px dashed #3b82f6;outline-offset:2px}
.signals-panel-card.drop-target{outline:2px solid #3b82f6;outline-offset:2px}
.panel-actions{display:flex;flex-wrap:wrap;gap:4px;flex-shrink:0;justify-content:flex-end}
.signals-stat-value{font-size:34px;font-weight:700;line-height:1.1}
.signals-stat-value.warn{color:#f59e0b}
.signals-stat-value.crit{color:#ef4444}
.signals-stat-meta{margin-top:6px;font-size:11px;color:var(--muted);word-break:break-all}
.signals-chart-tip{position:absolute;display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:10px;color:var(--muted);pointer-events:none;z-index:5;box-shadow:0 4px 12px rgba(0,0,0,.28);min-width:80px}
.signals-chart-tip strong{color:var(--text);font-size:10px}
.signals-chart-tip span{display:flex;align-items:center}
.signals-chart-tip .swatch{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;flex-shrink:0}
.signals-chart-brush{position:absolute;background:rgba(59,130,246,.14);border:1px solid rgba(59,130,246,.5);border-radius:2px;pointer-events:none;z-index:4}
.board-confirm-text{margin:0;font-size:12px;color:var(--muted);line-height:1.6}
body.obs-kiosk header,body.obs-kiosk .side-nav,body.obs-kiosk .page-head,body.obs-kiosk .module-switcher,body.obs-kiosk .skip-link{display:none!important}
body.obs-kiosk .app-shell{display:block}
body.obs-kiosk #mainContent{padding:12px}
.board-modal{position:fixed;inset:0;background:rgba(2,6,23,.62);display:flex;align-items:center;justify-content:center;z-index:90;padding:16px}
.board-modal-box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;width:100%;max-width:420px;max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
.board-modal-box.panel-editor{max-width:940px}
.panel-editor-split{display:grid;grid-template-columns:minmax(250px,360px) minmax(0,1fr);gap:18px;align-items:start}
.panel-editor-form{display:flex;flex-direction:column;gap:10px}
.panel-editor-preview strong{display:block;font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:600}
.panel-preview{min-height:200px;max-height:380px;overflow:auto;padding:8px}
.board-status-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.board-status-bar .board-help{margin:0;flex:1}
.board-save-status{font-size:11px;color:var(--muted)}
.board-save-status.error,.board-editor-validation{color:var(--danger,#b42318);font-size:12px}
#boardSaveStatus:not(.error)+#boardSaveRetryBtn{display:none}
.board-variables:empty{display:none}
.board-variables input{max-width:210px}
.board-stat-series+.board-stat-series{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.board-query-editor{display:flex;flex-direction:column;gap:8px}
.board-query-row,.board-variable-row{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);margin-top:8px}
.board-query-head{display:flex;justify-content:space-between;align-items:center;font-size:12px}
.board-field textarea{width:100%;resize:vertical;min-height:64px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);background:var(--panel);border:1px solid var(--line2);border-radius:7px;padding:8px}
.board-library-picker{display:flex;flex-wrap:wrap;gap:6px;align-items:end}
.board-library-picker .board-field{flex:1 1 160px}
.board-query-warning{margin-top:8px;font-size:11px;color:var(--warn,#b45309);overflow-wrap:anywhere}
.board-template-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.board-template-card{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}
.board-template-card p{margin:0;line-height:1.6}
.board-template-card .btn{align-self:flex-start;margin-top:auto}
#view-signals [hidden],.board-modal [hidden]{display:none!important}
.board-panel-source{overflow-wrap:anywhere}
@media(max-width:560px){.signals-panel-grid{grid-template-columns:minmax(0,1fr)}.board-toolbar-group.board-toolbar-actions{padding-left:0;border-left:0}.board-range-bar .board-compact-label input{width:160px}.board-modal{padding:8px}.board-modal-box{max-height:94vh}.board-variable-row{padding:8px}.board-variables .board-compact-label{max-width:100%}}
@media(max-width:880px){.panel-editor-split{grid-template-columns:1fr}}
.panel-time-select{height:24px;font-size:10px;max-width:96px;flex:0 0 auto}
.board-modal-box h3{margin:0;font-size:14px}
.board-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
.board-field input,.board-field select{width:100%}
.board-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
body.ops-observability #view-signals .board-workspace-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
body.ops-observability #view-signals .board-title-group{flex:1 1 280px;min-width:0}
body.ops-observability #view-signals .board-name{margin:0 0 8px;font-size:20px;font-weight:650;line-height:1.4;overflow-wrap:anywhere}
body.ops-observability #view-signals .board-context{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;font-size:12px;color:var(--muted)}
body.ops-observability #view-signals .board-scope-badge{padding:3px 8px;border-radius:6px;background:var(--focus-subtle,var(--panel2));color:var(--text);font-size:11px}
body.ops-observability #view-signals .board-primary-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
body.ops-observability #view-signals .board-primary-actions .btn{min-height:36px}
body.ops-observability #view-signals .board-primary-actions select{max-width:220px;min-height:36px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);color:var(--text);padding:6px 8px}
body.ops-observability #view-signals .board-workspace-head:has(.focus-tools[open]) .board-primary-actions{flex:1 0 100%;justify-content:flex-start}
body.ops-observability #view-signals .board-filter-toolbar{align-items:flex-end;gap:14px;margin-bottom:16px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
body.ops-observability #view-signals .board-filter-toolbar .board-toolbar-group{flex:1;align-items:flex-end;gap:16px;min-width:0}
body.ops-observability #view-signals .board-filter-toolbar .board-compact-label{flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
body.ops-observability #view-signals .board-picker{flex:1 1 240px;max-width:360px}
body.ops-observability #view-signals #boardSelect{width:100%;max-width:100%}
body.ops-observability #view-signals .board-filter-row{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:16px}
body.ops-observability #view-signals .board-filter-row:has(#boardVariables:empty):has(#boardResetFiltersBtn[hidden]){display:none}
body.ops-observability #view-signals .board-variables{display:flex;align-items:flex-end;flex-wrap:wrap;flex:1;gap:12px 16px;min-width:0}
body.ops-observability #view-signals .board-variables .board-compact-label{flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
body.ops-observability #view-signals .board-variables input,body.ops-observability #view-signals .board-variables select{min-height:36px;max-width:240px;min-width:120px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);color:var(--text);padding:6px 10px;font-size:12px}
body.ops-observability #view-signals .board-status-bar{margin-bottom:16px;font-size:12px}
body.ops-observability #view-signals .board-query-status.error{color:var(--red)}
body.ops-observability #view-signals .signals-panel-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
body.ops-observability #view-signals .signals-panel-card{min-width:0;padding:16px;border-radius:12px;background:var(--panel)}
body.ops-observability #view-signals .signals-panel-card h4{align-items:flex-start;gap:12px;margin-bottom:8px;font-size:14px;font-weight:600}
body.ops-observability #view-signals .panel-actions{align-items:center;gap:6px}
body.ops-observability #view-signals .panel-actions>.btn{min-height:30px}
body.ops-observability #view-signals .panel-action-menu{position:relative;min-width:0}
body.ops-observability #view-signals .panel-action-menu>summary{display:flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:4px 10px;border:1px solid var(--line2);border-radius:7px;list-style:none;font-size:12px;cursor:pointer;background:var(--panel);color:var(--text)}
body.ops-observability #view-signals .panel-action-menu>summary::-webkit-details-marker{display:none}
body.ops-observability #view-signals .panel-action-menu>summary:after{content:"⌄";color:var(--muted)}
body.ops-observability #view-signals .panel-action-menu[open]{z-index:20}
body.ops-observability #view-signals .panel-action-menu-body{position:absolute;right:0;top:calc(100% + 6px);z-index:20;display:grid;gap:4px;min-width:160px;padding:6px;border:1px solid var(--line);border-radius:9px;background:var(--panel);box-shadow:0 10px 28px rgba(0,0,0,.16)}
body.ops-observability #view-signals .panel-action-menu-body .btn{width:100%;min-height:34px;text-align:left;justify-content:flex-start;padding:6px 10px;border:0;background:transparent}
body.ops-observability #view-signals .panel-action-menu-body .btn:hover{background:var(--focus-subtle,var(--panel2))}
body.ops-observability #view-signals .panel-action-menu-body .btn.danger{color:var(--red)}
body.ops-observability #view-signals .board-panel-query-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:24px;margin-bottom:8px;font-size:11px;line-height:1.5;color:var(--muted)}
body.ops-observability #view-signals .board-panel-query-status .btn{min-height:26px;padding:3px 8px;font-size:11px}
body.ops-observability #view-signals .query-error .board-panel-query-status{color:var(--red)}
body.ops-observability #view-signals .board-panel-previous{opacity:.6}
@media(max-width:1100px){body.ops-observability #view-signals .signals-panel-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:720px){body.ops-observability #view-signals .board-workspace-head{gap:12px;margin-bottom:16px}body.ops-observability #view-signals .board-name{font-size:18px}body.ops-observability #view-signals .board-primary-actions{width:100%;justify-content:flex-start}body.ops-observability #view-signals .board-filter-toolbar{padding:12px;gap:12px}body.ops-observability #view-signals .board-filter-toolbar .board-toolbar-group{flex:1 1 100%;width:100%;gap:12px}body.ops-observability #view-signals .board-picker{flex:1 1 100%;max-width:none;width:100%}body.ops-observability #view-signals .board-variables .board-compact-label{flex:1 1 140px;max-width:100%}body.ops-observability #view-signals .board-variables input,body.ops-observability #view-signals .board-variables select{max-width:100%;width:100%}body.ops-observability #view-signals .signals-panel-card{padding:12px}body.ops-observability #view-signals .signals-panel-card h4{gap:8px}}
.board-modal-box.panel-query-dialog{max-width:1160px;height:min(88vh,880px);max-height:calc(100dvh - 32px);padding:0;gap:0;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.24)}
.panel-query-dialog>h3{flex:0 0 auto;padding:18px 22px;border-bottom:1px solid var(--line);font-size:16px;font-weight:650}
.panel-query-dialog>.panel-editor-split{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:20px 22px;grid-template-columns:minmax(0,1.3fr) minmax(300px,1fr);gap:24px;scrollbar-gutter:stable}
.panel-query-dialog .panel-editor-form{min-width:0;gap:14px}
.panel-query-dialog .panel-editor-preview{position:sticky;top:0;min-width:0}
.panel-query-dialog .panel-editor-preview>strong{font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px}
.panel-query-dialog .panel-editor-preview>.btn{margin-bottom:10px}
.panel-query-dialog .panel-preview{min-height:220px;max-height:400px;padding:14px}
.panel-query-dialog .board-field{gap:6px;font-size:12px}
.panel-query-dialog .board-field input,.panel-query-dialog .board-field select,.panel-query-dialog .board-field textarea{box-sizing:border-box;width:100%;min-width:0;min-height:38px;border:1px solid var(--line2);border-radius:7px;padding:8px 10px;background:var(--panel);color:var(--text);font-size:13px;line-height:1.5}
.panel-query-dialog .board-field textarea{min-height:88px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.panel-query-dialog .board-field input:focus-visible,.panel-query-dialog .board-field select:focus-visible,.panel-query-dialog .board-field textarea:focus-visible{outline:2px solid var(--green);outline-offset:2px}
.panel-query-dialog .board-query-row{gap:12px;margin-top:0;padding:14px}
.panel-query-dialog .board-query-head{font-size:13px;font-weight:600}
.panel-query-dialog .board-query-options{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,.7fr);gap:12px}
.panel-query-dialog .board-query-editor>.hint{margin:2px 0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.panel-query-dialog .panel-display-details,.panel-query-dialog .panel-library-details{border:0;border-top:1px solid var(--line);border-radius:0;padding:0;background:transparent}
.panel-query-dialog .panel-display-details>summary,.panel-query-dialog .panel-library-details>summary{padding:12px 0;cursor:pointer;color:var(--text);font-size:13px;font-weight:600;outline-offset:2px}
.panel-query-dialog .panel-display-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:2px 0 12px}
.panel-query-dialog .board-library-picker{padding:2px 0 12px}
.panel-query-dialog .panel-editor-footer{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 22px;border-top:1px solid var(--line);background:var(--panel)}
.panel-query-dialog .panel-editor-footer>.board-editor-validation{flex:1;min-width:0;line-height:1.5;overflow-wrap:anywhere}
.panel-query-dialog .panel-editor-footer>.board-editor-validation:empty{display:none}
.panel-query-dialog .panel-editor-footer-actions{flex:0 0 auto;margin:0 0 0 auto}
.panel-query-dialog .panel-editor-footer-actions .btn{min-height:38px;padding:0 18px;font-size:13px}
@media(max-width:880px){.panel-query-dialog>.panel-editor-split{grid-template-columns:minmax(0,1fr);gap:20px}.panel-query-dialog .panel-editor-preview{position:static}}
@media(max-width:560px){.board-modal-box.panel-query-dialog{height:calc(100dvh - 16px);max-height:calc(100dvh - 16px)}.panel-query-dialog>h3{padding:16px;font-size:15px}.panel-query-dialog>.panel-editor-split{padding:16px;scrollbar-gutter:auto}.panel-query-dialog .board-query-options,.panel-query-dialog .panel-display-grid{grid-template-columns:minmax(0,1fr)}.panel-query-dialog .panel-editor-footer{padding:12px 16px;gap:10px;flex-wrap:wrap}.panel-query-dialog .panel-editor-footer>.board-editor-validation{flex-basis:100%}.panel-query-dialog .panel-editor-footer-actions .btn{min-height:42px}}
.devices-table{width:100%;border-collapse:collapse;font-size:12px}
.devices-table th,.devices-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
.devices-table th{color:var(--muted);font-weight:500;font-size:11px}
.device-pill{display:inline-block;border-radius:999px;font-size:10px;padding:2px 8px;font-weight:600}
.device-pill.online{background:rgba(16,185,129,.15);color:#10b981}
.device-pill.offline{background:rgba(148,163,184,.18);color:var(--muted)}
.device-detail{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:12px;margin:8px 0 12px}
.device-detail .signals-chart-wrap{margin-top:8px}
.token-reveal{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);border-radius:6px;padding:8px;margin:8px 0}
    #alertDetailDrawer .drawer{transform:translateX(100%);transition:transform .18s ease}
    #alertDetailDrawer.open .drawer{transform:translateX(0)}
    #alertDetailDrawer .drawer-body{display:flex;flex-direction:column}
    .alert-detail-status{display:flex;align-items:center;gap:8px}.alert-detail-status strong{font-size:13px}.alert-detail-status span:last-child{color:var(--muted);font-size:10px}
    .alert-detail-status .state-dot{margin-top:0}
    .alert-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .alert-detail-cell{border:1px solid var(--line);border-radius:7px;padding:9px 10px;background:var(--c28)}
    .alert-detail-cell span{display:block;font-size:9px;color:var(--muted)}
    .alert-detail-cell strong{display:block;margin-top:3px;font-size:11px;font-weight:600}
    .alert-detail-cell strong:empty{display:none}
    #alertDetailDrawer table{margin:8px 0}
`;
