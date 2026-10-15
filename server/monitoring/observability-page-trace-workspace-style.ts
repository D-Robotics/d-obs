/** Native Trace workspace presentation. Shared navigation and permissions stay in their owners. */
export const OPS_OBSERVABILITY_TRACE_WORKSPACE_STYLE = `
  body.ops-observability #view-traces :is(#nativeTraceContent,#nativeSessionTraceContent){gap:16px}
  body.ops-observability #view-traces .trace-native-hero{padding:0 0 4px;border:0;border-radius:0;background:transparent;gap:16px;box-shadow:none}
  body.ops-observability #view-traces .trace-native-hero h2{font-size:16px;font-weight:650;line-height:1.5;margin:0}
  body.ops-observability #view-traces .trace-mode-switch{padding:3px;border-radius:10px;background:var(--ui-subtle,var(--c10))}
  body.ops-observability #view-traces .trace-mode-switch .ic-tab{min-height:44px;padding:8px 14px;border-radius:7px;font-size:13px}
  body.ops-observability #view-traces .trace-mode-switch .ic-tab.is-active{background:var(--ui-surface,var(--c2));color:var(--text);box-shadow:0 1px 3px var(--c75)}
  body.ops-observability #view-traces .trace-privacy{padding:5px 9px;background:var(--ui-subtle,var(--c10));color:var(--muted);font-size:11px;font-weight:500}
  body.ops-observability #view-traces .trace-list-note{font-size:12px;line-height:1.7}
  body.ops-observability #view-traces .trace-list-note .trace-privacy{display:none}
  body.ops-observability #view-traces .trace-coverage-notice{margin:0;padding:12px 16px;line-height:1.6}
  body.ops-observability #view-traces .trace-coverage-title{flex-wrap:wrap;gap:4px 16px}
  body.ops-observability #view-traces .trace-coverage-title strong{font-size:13px}
  body.ops-observability #view-traces .trace-coverage-title span{font-size:12px}
  body.ops-observability #view-traces .trace-coverage-notice :is(p,small){font-size:12px;line-height:1.7}
  body.ops-observability #view-traces .trace-ingestion-help>summary{min-height:44px;padding:8px 0;font-size:12px;line-height:1.7;cursor:pointer}
  body.ops-observability #view-traces .trace-ingestion-help[open]>summary{border-bottom:1px solid var(--line)}
  body.ops-observability:has(#view-traces:not(.hidden)) .page-head-controls :is(button,select){height:44px;min-height:44px}
  body.ops-observability:has(#view-traces:not(.hidden)) header :is(.theme-toggle,.global-search-trigger){height:44px;min-height:44px;min-width:44px}
  body.ops-observability #view-traces .trace-stats{border:1px solid var(--line);border-radius:12px;background:var(--ui-surface,var(--c2))}
  body.ops-observability #view-traces .trace-stat{padding:16px;min-width:0}
  body.ops-observability #view-traces .trace-stat strong{font-size:24px;font-weight:650;color:var(--text);line-height:1.4}
  body.ops-observability #view-traces .trace-stat.critical strong{color:var(--red)}
  body.ops-observability #view-traces .trace-stat.warning strong{color:var(--orange)}
  body.ops-observability #view-traces .trace-stat small{font-size:11px;line-height:1.6}
  body.ops-observability #view-traces .trace-toolbar{gap:12px;padding:16px;background:var(--ui-subtle,var(--c10))}
  body.ops-observability #view-traces :is(.trace-environment,.trace-search){font-size:12px;min-width:0}
  body.ops-observability #view-traces .trace-toolbar :is(input,select,.btn){height:44px;min-height:44px;font-size:13px}
  body.ops-observability #view-traces .trace-filters .btn{min-width:54px}
  body.ops-observability #view-traces .trace-results{padding:0 16px}
  body.ops-observability #view-traces .trace-row{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:10px 20px;padding-top:18px;padding-bottom:18px;min-width:0}
  body.ops-observability #view-traces .trace-row-openable{cursor:pointer;border-radius:4px;transition:background-color .12s ease}
  body.ops-observability #view-traces .trace-row-openable:hover{background:var(--ui-subtle,var(--c10))}
  body.ops-observability #view-traces .trace-row-openable:focus-visible{outline:2px solid var(--green);outline-offset:3px}
  body.ops-observability #view-traces .trace-identity{min-width:0;gap:8px}
  body.ops-observability #view-traces .trace-identity strong{font-size:14px;line-height:1.5}
  body.ops-observability #view-traces .trace-identity span:not(.state-dot):not(.trace-outcome){font-size:12px;line-height:1.6}
  body.ops-observability #view-traces .trace-outcome{font-size:11px;padding:4px 8px}
  body.ops-observability #view-traces .trace-timing{grid-template-columns:repeat(5,minmax(0,1fr));overflow:visible}
  body.ops-observability #view-traces .trace-timing :is(span,strong){font-size:12px;line-height:1.6}
  body.ops-observability #view-traces .trace-row-coverage{gap:6px;font-size:12px}
  body.ops-observability #view-traces .trace-tools span{font-size:11px;line-height:1.6}
  body.ops-observability #view-traces :is(.trace-meta,.trace-row-hint,.trace-count,.trace-pagination){font-size:12px;line-height:1.6}
  body.ops-observability #view-traces .trace-pagination .btn{min-height:44px;height:auto}
  body.ops-observability #view-traces .trace-empty{min-height:240px;padding:28px 20px;gap:10px}
  body.ops-observability #view-traces .trace-empty strong{font-size:16px}
  body.ops-observability #view-traces .trace-empty span{font-size:13px;line-height:1.8}

  /* Conversation owns the reading column; low-frequency diagnostics are disclosures. */
  body.ops-observability #nativeTraceDetail.trace-detail{display:block;isolation:isolate;border:1px solid var(--line);border-radius:16px;overscroll-behavior:contain;background:var(--ui-surface,var(--c2))}
  body.ops-observability #nativeTraceDetail.trace-detail:has(>.trace-coverage-notice){display:block}
  body.ops-observability #nativeTraceDetail>.trace-detail-head{align-items:center;padding:16px 20px;background:var(--ui-surface,var(--c2));backdrop-filter:none}
  body.ops-observability #nativeTraceDetail>.trace-detail-head>.trace-detail-actions{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:8px}
  body.ops-observability #nativeTraceDetail>.trace-detail-head p{font-size:12px;line-height:1.6;color:var(--muted)}
  body.ops-observability #nativeTraceDetail .trace-detail-title{font-size:16px;font-weight:650;white-space:normal;overflow-wrap:anywhere;line-height:1.4}
  body.ops-observability #nativeTraceDetail .trace-detail-close{height:44px;min-width:64px}
  body.ops-observability #nativeTraceDetail>.trace-detail-head .btn{height:44px;min-height:44px}
  body.ops-observability #nativeTraceDetail .trace-detail-body{min-width:0}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-coverage-notice{margin:16px 20px 0;padding:12px 16px}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-detail-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 0;padding:18px 20px}
  body.ops-observability #nativeTraceDetail .trace-detail-fact{padding:2px 12px}
  body.ops-observability #nativeTraceDetail .trace-detail-fact :is(span,strong){font-size:12px;line-height:1.65}
  body.ops-observability #nativeTraceDetail .trace-detail-fact strong{font-size:13px;font-weight:600}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-conversation{margin:0 20px 20px}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-context{margin:0 20px 16px}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-detail-section{padding:16px 20px;border-right:0}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-detail-section:not(:has(.trace-evidence-sources)){border-right:0}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure{margin:0 20px 12px;border:1px solid var(--line);border-radius:10px;min-width:0;background:var(--ui-surface,var(--c2))}
  body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-detail-section.trace-detail-disclosure{padding:0}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure>summary{min-height:52px;padding:12px 16px;cursor:pointer;color:var(--text);font-size:14px;line-height:1.6;overflow-wrap:anywhere}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure>.trace-section-head{justify-content:flex-start;align-items:center;margin:0;gap:8px 12px}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure>.trace-section-head:before{content:"";flex:0 0 7px;width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg)}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure[open]>.trace-section-head:before{transform:rotate(45deg)}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure>*:not(summary){margin:12px 16px}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure[open]>summary{border-bottom:1px solid var(--line)}
  body.ops-observability #nativeTraceDetail .trace-detail-disclosure>.trace-detail-section{padding:16px;border:0}
  body.ops-observability #nativeTraceDetail :is(.trace-section-head span,.trace-fragment-head span,.trace-span-label small,.trace-evidence-item small,.trace-context-note){font-size:12px;line-height:1.7}
  body.ops-observability #nativeTraceDetail :is(.trace-context-grid,.trace-evidence-sources){grid-template-columns:repeat(4,minmax(0,1fr))}
  body.ops-observability #nativeTraceDetail .trace-span-row{grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:12px;padding:12px}
  body.ops-observability #nativeTraceDetail .trace-span-label strong{font-size:12px;white-space:normal;overflow-wrap:anywhere}
  body.ops-observability #nativeTraceDetail .trace-span-track>small{font-size:11px}
  body.ops-observability #nativeTraceDetail .trace-advanced{padding:16px 20px;font-size:12px}
  body.ops-observability #nativeTraceDetail .trace-advanced :is(strong,span){font-size:12px;line-height:1.7}
  body.ops-observability #nativeTraceDetail .trace-detail-state{min-height:280px;gap:12px;padding:32px 20px}
  body.ops-observability #nativeTraceDetail .trace-detail-state strong{font-size:16px}
  body.ops-observability #nativeTraceDetail .trace-detail-state p{font-size:13px;line-height:1.8}
  body.ops-observability #nativeTraceDetail>.trace-detail-state.loading:before{content:"";width:18px;height:18px;flex:0 0 18px;border:2px solid var(--line);border-top-color:var(--green);border-radius:50%;animation:trace-detail-pending .85s linear infinite}
  body.ops-observability #nativeTraceDetail>.trace-detail-state.ready,body.ops-observability #nativeTraceDetail:has(.trace-detail-body:not(:empty))>.trace-detail-state{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;min-height:0;padding:10px 20px;gap:6px 12px;background:var(--ui-subtle,var(--c10));border-bottom:1px solid var(--line);text-align:left}
  body.ops-observability #nativeTraceDetail>.trace-detail-state.ready strong,body.ops-observability #nativeTraceDetail:has(.trace-detail-body:not(:empty))>.trace-detail-state strong{font-size:12px;font-weight:500;line-height:1.7}
  body.ops-observability #nativeTraceDetail>.trace-detail-state small{font-size:11px;line-height:1.7}
  body.ops-observability #nativeTraceDetail :is(.trace-detail-state,.trace-detail-disclosure) .btn{height:auto;min-height:44px}
  body.ops-observability #nativeTraceDetail :is(button,a,summary,input,select):focus-visible{outline:2px solid var(--green);outline-offset:3px}
  body.ops-observability #nativeTraceDetail [aria-busy="true"]{cursor:progress}

  @media(max-width:1100px){
    body.ops-observability #view-traces .trace-row,body.ops-observability #view-traces .trace-workspace.has-detail .trace-row{grid-template-columns:minmax(0,1fr)}
    body.ops-observability #view-traces :is(.trace-meta,.trace-row-hint){grid-column:1/-1;text-align:left}
    body.ops-observability #view-traces .trace-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
    body.ops-observability #nativeTraceDetail :is(.trace-context-grid,.trace-evidence-sources){grid-template-columns:repeat(2,minmax(0,1fr))}
  }
  @media(max-width:720px){
    body.ops-observability #view-traces .trace-native-hero{flex-wrap:wrap;gap:12px}
    body.ops-observability #view-traces .trace-native-hero>div:first-child{flex:1 1 100%}
    body.ops-observability #view-traces .trace-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    body.ops-observability #view-traces .trace-stat{padding:14px}
    body.ops-observability #view-traces .trace-stat:nth-child(3){border-right:1px solid var(--line)}
    body.ops-observability #view-traces .trace-stat:nth-child(2n){border-right:0}
    body.ops-observability #view-traces .trace-stat:nth-child(-n+4){border-bottom:1px solid var(--line)}
    body.ops-observability #view-traces .trace-toolbar{grid-template-columns:100px minmax(0,1fr);gap:12px;padding:12px}
    body.ops-observability #view-traces .trace-filters{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    body.ops-observability #view-traces .trace-timing{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    body.ops-observability #view-traces .trace-timing div{padding:0 8px}
    body.ops-observability #nativeTraceDetail.trace-detail{border-radius:12px}
    body.ops-observability #nativeTraceDetail>.trace-detail-head{padding:12px}
    body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-coverage-notice{margin:12px 12px 0}
    body.ops-observability #nativeTraceDetail .trace-detail-body>.trace-detail-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 0;padding:16px 12px}
    body.ops-observability #nativeTraceDetail .trace-detail-fact:nth-child(2n+1){border-left:0}
    body.ops-observability #nativeTraceDetail .trace-detail-body>:is(.trace-conversation,.trace-context,.trace-detail-disclosure){margin-left:12px;margin-right:12px}
    body.ops-observability #nativeTraceDetail .trace-span-row{grid-template-columns:minmax(0,1fr)}
    body.ops-observability #nativeTraceDetail .trace-advanced{padding:14px 12px}
  }
  @keyframes trace-detail-pending{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){body.ops-observability #view-traces .trace-row-openable{transition:none}body.ops-observability #nativeTraceDetail>.trace-detail-state.loading:before{animation:none}}
`;
