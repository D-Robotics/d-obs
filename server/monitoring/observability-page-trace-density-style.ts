/** Compact native trace lists without changing routing, data, or error semantics. */
export const OPS_OBSERVABILITY_TRACE_DENSITY_STYLE = `
  body.ops-observability:has(#view-traces:not(.hidden)) main{max-width:none;padding:24px 28px 40px}
  body.ops-observability:has(#view-traces:not(.hidden)) main>*{max-width:none}
  body.ops-observability:has(#view-traces:not(.hidden)) .page-head{margin-bottom:14px;padding-bottom:12px}
  body.ops-observability:has(#view-traces:not(.hidden)) .page-head .page-kicker{display:none}
  body.ops-observability:has(#view-traces:not(.hidden)) .page-head .page-intro{display:none}
  body.ops-observability #view-traces>.module-switcher{margin-bottom:14px}
  body.ops-observability #nativeTraceContent,body.ops-observability #nativeSessionTraceContent{gap:12px}
  body.ops-observability #nativeTraceContent .trace-native-hero>div:first-child,body.ops-observability #nativeSessionTraceContent .trace-native-hero>div:first-child{display:none}
  body.ops-observability #nativeTraceContent .trace-native-hero:not(:has(.trace-mode-switch)),body.ops-observability #nativeSessionTraceContent .trace-native-hero:not(:has(.trace-mode-switch)){display:none}
  body.ops-observability #nativeTraceContent .trace-native-hero:has(.trace-mode-switch),body.ops-observability #nativeSessionTraceContent .trace-native-hero:has(.trace-mode-switch){justify-content:flex-start;padding:0;min-height:0}
  body.ops-observability #nativeTraceContent .trace-stat{padding:10px 14px}
  body.ops-observability #nativeTraceContent .trace-stat strong{font-size:22px;line-height:1.3;margin-top:2px}
  body.ops-observability #nativeTraceContent .trace-stat small{font-size:11px;line-height:1.5}
  body.ops-observability #nativeTraceContent .trace-list-note,body.ops-observability #nativeSessionTraceContent .trace-list-note{font-size:12px;line-height:1.5}
  body.ops-observability #nativeTraceContent .trace-toolbar,body.ops-observability #nativeSessionTraceContent .trace-toolbar{padding:12px 14px;gap:10px}
  body.ops-observability #nativeTraceResults .trace-row{grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);grid-template-areas:"identity timing" "coverage tools" "meta hint";gap:6px 16px;padding-top:12px;padding-bottom:12px}
  body.ops-observability #nativeTraceResults .trace-row>*{min-width:0}
  body.ops-observability #nativeTraceResults .trace-identity{grid-area:identity}
  body.ops-observability #nativeTraceResults .trace-timing{grid-area:timing;grid-template-columns:repeat(5,minmax(0,1fr));overflow:visible}
  body.ops-observability #nativeTraceResults .trace-row-coverage{grid-area:coverage;align-self:start;gap:4px 6px;font-size:11px;line-height:1.5}
  body.ops-observability #nativeTraceResults .trace-tools{grid-area:tools;align-self:start;gap:4px}
  body.ops-observability #nativeTraceResults .trace-tools span{padding:3px 7px;font-size:11px;line-height:1.5;overflow-wrap:anywhere;max-width:100%}
  body.ops-observability #nativeTraceResults .trace-meta{grid-area:meta;font-size:11px;line-height:1.5;flex-wrap:wrap;gap:4px 12px}
  body.ops-observability #nativeTraceResults .trace-row-hint{grid-area:hint;align-self:end;font-size:11px;line-height:1.5}
  body.ops-observability #nativeTraceResults .trace-context{grid-column:1/-1}
  body.ops-observability #nativeTraceResults .trace-identity strong{font-size:13px;line-height:1.5}
  body.ops-observability #nativeTraceResults .trace-identity span:not(.state-dot):not(.trace-outcome){font-size:11px;line-height:1.5}
  body.ops-observability #nativeTraceResults .trace-timing :is(span,strong){font-size:11px;line-height:1.5}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;padding:12px}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item>div{grid-column:1;flex-wrap:wrap;gap:4px 12px;min-width:0}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item>div strong{font-size:13px;line-height:1.5;overflow-wrap:anywhere}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item>p{grid-column:1;margin:0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item>small{grid-column:1;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
  body.ops-observability #nativeSessionTraceResults .trace-evidence-item>.btn{grid-column:2;grid-row:1/4;align-self:center;min-height:44px}
  body.ops-observability #nativeTraceDetail :is(.trace-detail-fact span,.trace-context-item span,.trace-fragment-head span,.trace-span-label small,.trace-evidence-item small,.trace-section-head span){font-size:11px;line-height:1.5}
  body.ops-observability #nativeTraceDetail :is(.trace-detail-fact strong,.trace-context-item strong,.trace-span-label strong,.trace-evidence-source strong,.trace-evidence-item p){font-size:12px;line-height:1.5}
  body.ops-observability #nativeTraceDetail :is(.trace-coverage-notice p,.trace-coverage-title span,.trace-evidence-source span,.trace-span-attributes summary){font-size:11px;line-height:1.5}
  @media(max-width:1100px){body.ops-observability:has(#view-traces:not(.hidden)) .page-head{flex-direction:column;align-items:flex-start;gap:12px}body.ops-observability:has(#view-traces:not(.hidden)) .page-head-actions{width:100%;max-width:100%;min-width:0;margin-left:0;align-self:stretch;flex-wrap:wrap}body.ops-observability:has(#view-traces:not(.hidden)) .page-head-controls{min-width:0;max-width:100%;flex-wrap:wrap}body.ops-observability:has(#view-traces:not(.hidden)) .workspace-facts{flex-wrap:wrap;white-space:normal}body.ops-observability #nativeTraceResults .trace-row{grid-template-columns:minmax(0,1fr);grid-template-areas:"identity" "timing" "coverage" "tools" "meta" "hint"}body.ops-observability #nativeTraceResults .trace-row-hint{text-align:left}}
  @media(max-width:720px){body.ops-observability:has(#view-traces:not(.hidden)) main{padding:20px 14px 32px}body.ops-observability #nativeTraceContent .trace-stat{padding:10px 12px}body.ops-observability #nativeTraceResults .trace-row{padding-top:14px;padding-bottom:14px;gap:8px}body.ops-observability #nativeTraceResults .trace-timing{grid-template-columns:repeat(3,minmax(0,1fr))}body.ops-observability #nativeTraceResults .trace-identity strong{white-space:normal;overflow-wrap:anywhere}body.ops-observability #nativeSessionTraceResults .trace-evidence-item{grid-template-columns:minmax(0,1fr)}body.ops-observability #nativeSessionTraceResults .trace-evidence-item>.btn{grid-column:1;grid-row:auto;justify-self:start}}
`;
