/** Scoped content components; surrounding workspace layout stays independent. */
export const OPS_OBSERVABILITY_TRACE_CONTENT_STYLE = `
    #nativeTraceDetail .trace-conversation{margin:0 0 20px;border:1px solid var(--line);border-radius:12px;background:var(--c2);min-width:0}
    #nativeTraceDetail .trace-conversation-head,#nativeTraceDetail .trace-span-content-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-height:44px;padding:12px 16px;cursor:pointer;font-size:13px;line-height:1.5;overflow-wrap:anywhere;color:var(--text)}
    #nativeTraceDetail .trace-conversation-head>span{color:var(--muted);font-size:12px}
    #nativeTraceDetail .trace-conversation-body{padding:0 16px 16px;min-width:0}
    #nativeTraceDetail .trace-content-note{display:block;color:var(--muted);font-size:12px;line-height:1.65;margin:8px 0;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-span-content{grid-column:1/-1;min-width:0;border-top:1px solid var(--line)}
    #nativeTraceDetail .trace-span-content-head{padding:8px 0}
    #nativeTraceDetail .trace-span-content-body{padding:0 0 8px;min-width:0}
    #nativeTraceDetail .trace-content-badge{display:inline-block;flex:0 0 auto;padding:2px 7px;border-radius:6px;background:var(--panel2);color:var(--muted);font-size:11px;line-height:1.6}
    #nativeTraceDetail .trace-content-badge.warning,#nativeTraceDetail .trace-content-note.warning,#nativeTraceDetail .trace-content-empty.warning{color:var(--warn,var(--text));background:var(--panel2)}
    #nativeTraceDetail .trace-content-entry{margin:8px 0;border:0;border-bottom:1px solid var(--line);border-radius:0;min-width:0;overflow:hidden;background:transparent}
    #nativeTraceDetail .trace-content-entry-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:36px;padding:4px 0;cursor:pointer;font-size:13px;line-height:1.6;background:transparent;color:var(--text);overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-entry.user_input .trace-content-role{color:var(--accent,#268577)}
    #nativeTraceDetail .trace-content-entry.model_output .trace-content-role{color:var(--purple,#6851b5)}
    #nativeTraceDetail .trace-content-sequence{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;min-width:24px}
    #nativeTraceDetail .trace-content-entry-body{padding:0 0 8px;min-width:0}
    #nativeTraceDetail .trace-content-footer{margin:0;min-width:0}
    #nativeTraceDetail .trace-content-footer[open]{padding-bottom:6px}
    #nativeTraceDetail .trace-content-more-toggle{display:flex;align-items:center;gap:6px;min-height:44px;width:fit-content;max-width:100%;padding:4px 0;color:var(--muted);font-size:11px;line-height:1.5;cursor:pointer;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-footer>.trace-content-controls{margin:4px 0}
    #nativeTraceDetail .trace-content-entry:last-child{border-bottom:0}
    #nativeTraceDetail .trace-content-controls{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;flex:0 1 auto;min-width:0}
    #nativeTraceDetail .trace-content-action,#nativeTraceDetail .trace-content-source-toggle{display:flex;align-items:center;justify-content:flex-start;min-height:44px;min-width:44px;max-width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--c2);color:var(--text);font:inherit;font-size:12px;line-height:1.5;cursor:pointer;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-action:disabled,#nativeTraceDetail .trace-content-action[aria-disabled="true"]{cursor:default;opacity:.65}
    #nativeTraceDetail .trace-content-copy-status{flex:0 1 auto;min-width:0;max-width:36ch;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-raw{margin:4px 0 10px;min-width:0}
    #nativeTraceDetail .trace-content-raw>summary{width:fit-content}
    #nativeTraceDetail .trace-content-text{margin:8px 0 0;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font:12px/1.75 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:480px;overflow:auto;min-width:0;max-width:100%;tab-size:2;overscroll-behavior:contain}
    #nativeTraceDetail .trace-content-prose{color:var(--text);font-size:14px;line-height:1.9;min-width:0;overflow-wrap:anywhere;word-break:break-word}
    #nativeTraceDetail .trace-content-paragraph{margin:8px 0;white-space:pre-wrap}
    #nativeTraceDetail .trace-content-message{margin:10px 0;padding:0 0 8px;border-bottom:1px solid var(--line);min-width:0}
    #nativeTraceDetail .trace-content-message:last-child{border-bottom:0;padding-bottom:0}
    #nativeTraceDetail .trace-content-message-role{display:block;margin-top:8px;color:var(--muted);font-size:12px;line-height:1.6}
    #nativeTraceDetail .trace-content-preview{margin:4px 0 8px;min-width:0}
    #nativeTraceDetail .trace-content-full-body{margin:8px 0;min-width:0}
    #nativeTraceDetail .trace-content-full-body>summary{width:fit-content}
    #nativeTraceDetail .trace-content-source-details{margin:0;padding:0;border:0;min-width:0;flex:0 1 auto}
    #nativeTraceDetail .trace-content-source-details[open]{flex-basis:100%}
    #nativeTraceDetail .trace-content-source-toggle{font-size:11px;color:var(--muted);border-color:transparent}
    #nativeTraceDetail .trace-content-source{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:5px 12px;font-size:11px;line-height:1.6;color:var(--muted);margin:6px 0;min-width:0}
    #nativeTraceDetail .trace-content-source dt,#nativeTraceDetail .trace-content-source dd{margin:0;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-source dd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    #nativeTraceDetail .trace-content-empty{margin:12px 0;color:var(--muted);font-size:13px;line-height:1.7;overflow-wrap:anywhere}
    #nativeTraceDetail .trace-content-entry [hidden]{display:none!important}
    #nativeTraceDetail .trace-conversation-head:before,#nativeTraceDetail .trace-span-content-head:before,#nativeTraceDetail .trace-content-entry-head:before,#nativeTraceDetail summary.trace-content-action:before,#nativeTraceDetail .trace-content-source-toggle:before,#nativeTraceDetail .trace-content-more-toggle:before{content:'›';flex:0 0 auto;width:12px;font-size:16px;line-height:1;color:var(--muted)}
    #nativeTraceDetail details[open]>.trace-conversation-head:before,#nativeTraceDetail details[open]>.trace-span-content-head:before,#nativeTraceDetail details[open]>.trace-content-entry-head:before,#nativeTraceDetail details[open]>summary.trace-content-action:before,#nativeTraceDetail details[open]>.trace-content-source-toggle:before,#nativeTraceDetail details[open]>.trace-content-more-toggle:before{content:'⌄'}
    #nativeTraceDetail .trace-conversation summary:focus-visible,#nativeTraceDetail .trace-span-content summary:focus-visible,#nativeTraceDetail .trace-content-action:focus-visible{outline:2px solid var(--accent,var(--text));outline-offset:3px}
    @media(max-width:720px){#nativeTraceDetail .trace-conversation-head{padding:10px 12px}#nativeTraceDetail .trace-conversation-body{padding:0 10px 12px}#nativeTraceDetail .trace-content-entry-head{min-height:44px;padding:4px 0}#nativeTraceDetail .trace-content-entry-body{padding:0 0 8px}#nativeTraceDetail .trace-content-text{padding:10px;max-height:360px}#nativeTraceDetail .trace-content-source{grid-template-columns:minmax(0,1fr)}#nativeTraceDetail .trace-content-source dt{margin-top:6px}#nativeTraceDetail .trace-content-copy-status{flex-basis:100%;min-width:0}}
    @media(prefers-reduced-motion:reduce){#nativeTraceDetail .trace-conversation *,#nativeTraceDetail .trace-span-content *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
