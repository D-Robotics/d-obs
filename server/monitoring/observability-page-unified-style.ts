/** Layout for the unified situation view. Kept separate from the legacy page CSS so the
 * information architecture can evolve without making the shared stylesheet harder to audit. */
export const OPS_OBSERVABILITY_UNIFIED_STYLE = `
    .skip-link{position:fixed;left:14px;top:-52px;z-index:80;padding:9px 13px;border-radius:7px;background:var(--c2);color:var(--green);box-shadow:var(--shadow);font-weight:650;transition:top .16s ease}.skip-link:focus{top:8px;outline:2px solid var(--c85);outline-offset:2px}
    .detail-summary{min-height:44px}.detail-summary:hover{background:var(--c29)}.detail-summary:focus-visible{outline:2px solid var(--c11);outline-offset:-2px;border-radius:7px}.view:not(.hidden){animation:view-enter .16s ease-out}.shell-status{min-height:152px;display:grid;place-items:center;align-content:center;gap:5px;padding:30px;border:1px dashed var(--c86);border-radius:9px;background:var(--c87);color:var(--muted);text-align:center}.shell-status strong{color:var(--c88);font-size:13px}.shell-status small{font-size:11px}.shell-spinner{width:22px;height:22px;margin-bottom:5px;border:2px solid var(--c89);border-top-color:var(--green);border-radius:50%;animation:shell-spin .8s linear infinite}.empty-state{display:grid;justify-items:center;gap:7px;padding:32px;color:var(--muted);text-align:center}.empty-state strong{color:var(--c88);font-size:14px}.empty-state p{max-width:560px;margin:0;font-size:11px}.empty-state .btn{margin-top:5px}@keyframes shell-spin{to{transform:rotate(360deg)}}@keyframes view-enter{from{opacity:.55;transform:translateY(3px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.view:not(.hidden),.shell-spinner,.skip-link{animation:none;transition:none}}
    #mainContent:focus{outline:none}.page-head-actions .btn{font-weight:550}.page-head-actions #refresh:before{content:"↻";margin-right:5px}
    .nav-more>summary{list-style:none}.nav-more>summary::-webkit-details-marker{display:none}.nav-more-summary:before{content:"•••"!important;letter-spacing:1px}.nav-more-menu{display:grid;gap:4px}.nav-more.active-child>.nav-more-summary{color:var(--green);background:var(--c12);font-weight:650}.nav-more[open]>.nav-more-summary{color:var(--green)}
    .situation-hero{position:relative;overflow:hidden;padding:19px 20px;border-left:4px solid var(--c19)}
    .situation-hero.warning,.situation-hero.stale{border-left-color:var(--orange)}
    .situation-hero.critical{border-left-color:var(--red)}
    .situation-hero:after{content:"";position:absolute;right:-36px;top:-58px;width:190px;height:190px;border-radius:50%;background:var(--c90);pointer-events:none}
    .situation-hero .hero-icon{width:44px;height:44px;border-radius:50%}
    .situation-hero .hero-title{font-size:19px;font-weight:650}
    .situation-hero .hero-detail{max-width:720px}
    .situation-meta{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:7px}
    .situation-meta span{padding:3px 8px;border-radius:999px;background:var(--c91);color:var(--c92);font-size:11px}
    .unified-focus{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.75fr);gap:12px}
    .action-center,.coverage-panel{padding:16px}
    .action-center .section-head,.coverage-panel .section-head{margin-bottom:12px}
    .action-list{display:grid;gap:8px}
    .action-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 12px;border:1px solid var(--line);border-radius:7px;background:var(--c93)}
    .action-row.critical{border-color:var(--c94);background:var(--c53)}
    .action-row.warning{border-color:var(--c95);background:var(--c96)}
    .action-marker{width:8px;height:8px;border-radius:50%;background:var(--c19)}
    .action-row.warning .action-marker{background:var(--orange)}
    .action-row.critical .action-marker{background:var(--red)}
    .action-copy{min-width:0}
    .action-copy strong{display:block;font-size:12px;color:var(--c97)}
    .action-copy small{display:block;margin-top:2px;color:var(--muted);font-size:11px;line-height:1.5}
    .action-row .btn{height:30px;padding:4px 10px;font-size:11px}
    .action-clear{padding:16px;border:1px solid var(--c98);border-radius:7px;background:var(--c99);color:var(--c46);text-align:center}
    .signal-coverage{display:grid;gap:7px}
    .signal-row{width:100%;display:grid;grid-template-columns:minmax(74px,.8fr) 52px 58px 54px;align-items:center;gap:8px;padding:10px;border:1px solid var(--line);border-radius:7px;background:var(--c2);text-align:left;cursor:pointer}
    .signal-row:hover{border-color:var(--c100);background:var(--c57)}
    .signal-row:focus-visible{outline:2px solid var(--c11);outline-offset:1px}
    .signal-name{display:flex;align-items:center;gap:7px;font-weight:600}
    .signal-name .state-dot{margin:0}
    .signal-stat{color:var(--muted);font-size:10px;text-align:right}
    .signal-stat strong{display:block;color:var(--c101);font-size:12px}
    .pulse-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .pulse-card{position:relative;min-height:128px;padding:15px 16px;border-top:3px solid var(--c19);cursor:pointer;text-align:left;color:inherit}
    button.pulse-card{width:100%;border-left:0;border-right:0;border-bottom:0;background:var(--c2);font:inherit}
    .pulse-card.warning{border-top-color:var(--orange)}
    .pulse-card.critical{border-top-color:var(--red)}
    .pulse-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}
    .pulse-label span:last-child{margin-left:auto}
    .pulse-value{margin:9px 0 3px;color:var(--c102);font-size:24px;font-weight:650;line-height:1.1}
    .pulse-detail{min-height:34px;color:var(--muted);font-size:11px;line-height:1.5}
    .pulse-link{margin-top:8px;color:var(--green);font-size:11px;font-weight:600}
    .pulse-card:focus-visible{outline:2px solid var(--c11);outline-offset:2px}
    .pulse-card:hover{box-shadow:0 8px 22px var(--c103),0 0 1px var(--c22)}
    .overview-detail-intro{display:flex;align-items:center;gap:9px}
    .overview-detail-intro:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c104)}
    @media(max-width:1100px){.unified-focus{grid-template-columns:1fr}.pulse-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:900px){.nav-more{position:relative}.nav-more-summary{height:50px;justify-content:center;padding:7px;font-size:0}.nav-more-summary:before{font-size:14px}.nav-more-menu{position:fixed;left:58px;top:54px;z-index:35;width:218px;max-height:calc(100vh - 62px);overflow:auto;padding:9px;background:var(--c2);border:1px solid var(--line);border-radius:8px;box-shadow:0 14px 40px var(--c75)}.nav-more-menu .nav-section{display:block;padding:10px 11px 5px}.nav-more-menu .module-tab{height:auto;justify-content:flex-start;padding:9px 11px;font-size:11px}.nav-more-menu .module-tab:before{font-size:12px}.nav-more-menu .tab-count{display:inline-flex}}
    @media(max-width:700px){.pulse-grid{grid-template-columns:1fr}.action-row{grid-template-columns:8px minmax(0,1fr)}.action-row .btn{grid-column:2;width:max-content}.situation-hero{align-items:flex-start}.situation-hero .right{display:none}}
    @media(max-width:520px){.nav-more{flex:1;min-width:50px}.nav-more-summary{height:36px}.nav-more-menu{position:absolute;left:auto;right:0;top:42px;width:min(250px,calc(100vw - 14px));max-height:70vh}.signal-row{grid-template-columns:minmax(70px,1fr) repeat(3,48px)}.action-center,.coverage-panel{padding:13px}.page-head-actions .btn{flex:1}.shell-status{min-height:126px;padding:22px 14px}.view-head .right{display:none}}
`;
