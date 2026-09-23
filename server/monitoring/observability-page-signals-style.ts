/** 观测查询 / 边缘设备视图样式（配色复用全局 palette token）。 */
export const OPS_OBSERVABILITY_SIGNALS_STYLE = `
.signals-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:0 0 12px}
.nav-primary .module-tab{background:transparent}
.nav-primary .module-tab.active{background:var(--c422)}
.signals-toolbar label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
.signals-toolbar input,.signals-toolbar select{min-width:160px}
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
.signals-empty{color:var(--muted);font-size:12px;padding:18px 0;text-align:center}
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
body.obs-kiosk header,body.obs-kiosk .side-nav,body.obs-kiosk .page-head,body.obs-kiosk .workspace-toolbar,body.obs-kiosk .module-switcher,body.obs-kiosk .skip-link{display:none!important}
body.obs-kiosk .app-shell{display:block}
body.obs-kiosk #mainContent{padding:12px}
.board-modal{position:fixed;inset:0;background:rgba(2,6,23,.62);display:flex;align-items:center;justify-content:center;z-index:90;padding:16px}
.board-modal-box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;width:100%;max-width:420px;max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
.board-modal-box.panel-editor{max-width:940px}
.panel-editor-split{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:14px;align-items:start}
.panel-editor-form{display:flex;flex-direction:column;gap:10px}
.panel-editor-preview strong{display:block;font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:600}
.panel-preview{min-height:200px;max-height:380px;overflow:auto;padding:8px}
@media(max-width:880px){.panel-editor-split{grid-template-columns:1fr}}
.panel-time-select{height:24px;font-size:10px;max-width:96px;flex:0 0 auto}
.board-modal-box h3{margin:0;font-size:14px}
.board-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
.board-field input,.board-field select{width:100%}
.board-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
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