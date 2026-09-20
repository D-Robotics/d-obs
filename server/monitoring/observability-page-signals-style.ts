/** 观测查询 / 边缘设备视图样式（配色复用全局 palette token）。 */
export const OPS_OBSERVABILITY_SIGNALS_STYLE = `
.signals-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:0 0 12px}
.signals-toolbar label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
.signals-toolbar input,.signals-toolbar select{min-width:160px}
.signals-chart-wrap{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:12px;overflow:hidden}
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
.devices-table{width:100%;border-collapse:collapse;font-size:12px}
.devices-table th,.devices-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
.devices-table th{color:var(--muted);font-weight:500;font-size:11px}
.device-pill{display:inline-block;border-radius:999px;font-size:10px;padding:2px 8px;font-weight:600}
.device-pill.online{background:rgba(16,185,129,.15);color:#10b981}
.device-pill.offline{background:rgba(148,163,184,.18);color:var(--muted)}
.device-detail{border:1px solid var(--line);border-radius:8px;background:var(--panel2);padding:12px;margin:8px 0 12px}
.device-detail .signals-chart-wrap{margin-top:8px}
.token-reveal{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);border-radius:6px;padding:8px;margin:8px 0}
`;
