export const OPS_OBSERVABILITY_SLO_STYLE = `
    .module-tab[data-view="service-levels"]:before{content:"◎"}
    .slo-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .slo-card{padding:16px;border-top:3px solid var(--c19)}
    .slo-card.at_risk,.slo-card.no_data{border-top-color:var(--orange)}
    .slo-card.budget_exhausted,.slo-card.sla_breached{border-top-color:var(--red)}
    .slo-head{display:flex;align-items:flex-start;gap:12px}
    .slo-head h3{margin:0;font-size:14px;font-weight:600}
    .slo-head p{margin:3px 0 0;color:var(--muted);font-size:10px}
    .slo-head .slo-status{margin-left:auto;white-space:nowrap}
    .slo-status.healthy{background:var(--c40);color:var(--c3)}
    .slo-status.at_risk,.slo-status.no_data{background:var(--c43);color:var(--c81)}
    .slo-status.budget_exhausted,.slo-status.sla_breached{background:var(--c17);color:var(--red)}
    .slo-score{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:17px 0 14px}
    .slo-score span{display:block;color:var(--muted);font-size:10px}
    .slo-score strong{display:block;font-size:28px;line-height:1.2;color:var(--c82)}
    .slo-targets{text-align:right;color:var(--muted);font-size:10px}
    .slo-budget{padding:11px;border-radius:7px;background:var(--c83)}
    .slo-budget-head{display:flex;justify-content:space-between;gap:12px;font-size:10px}
    .slo-budget-head strong{font-size:11px}
    .budget-track{height:7px;border-radius:6px;background:var(--c84);overflow:hidden;margin:7px 0}
    .budget-fill{height:100%;border-radius:6px;background:var(--c19)}
    .budget-fill.warn{background:var(--orange)}
    .budget-fill.bad{background:var(--red)}
    .budget-fill.unknown{background:var(--c32)}
    .slo-budget small{display:block;color:var(--muted);font-size:9px}
    .slo-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:12px}
    .slo-facts>div{padding:8px;border:1px solid var(--line);border-radius:6px}
    .slo-facts span,.slo-facts strong{display:block}
    .slo-facts span{color:var(--muted);font-size:9px}
    .slo-facts strong{font-size:10px;margin-top:2px}
    .slo-definition{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
    .slo-definition summary{cursor:pointer;color:var(--green);font-size:10px}
    .slo-definition p{margin:6px 0 0;color:var(--muted);font-size:9px}
    @media(max-width:1050px){.slo-grid{grid-template-columns:1fr}.slo-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:520px){.slo-score{align-items:flex-start;flex-direction:column}.slo-targets{text-align:left}.slo-facts{grid-template-columns:1fr 1fr}}
`;
