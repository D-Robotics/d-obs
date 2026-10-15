/** Keep the overview's first layer for state and work requiring attention.
 * Append after FOCUS: move existing safe-DOM nodes, preserving their controls,
 * identifiers and data owners through both snapshot and action-only refreshes.
 */
export const OPS_OBSERVABILITY_SCRIPT_OVERVIEW_RESTRAINT = `
      const overviewRestraintDisclosureState=new Map();
      const overviewRestraintDisclosureIds=['overviewSupportingMetrics','actionLoopEmptyDetails','actionLoopDetails'];
      function rememberOverviewRestraintDisclosures(){
        overviewRestraintDisclosureIds.forEach(id=>{const node=$(id);if(node)overviewRestraintDisclosureState.set(id,node.open)});
      }
      function overviewRestraintDisclosure(id,title,description,className=''){
        const detail=overviewDisclosure(id,title,description);
        detail.classList.add('overview-restraint-detail');if(className)detail.classList.add(className);
        if(overviewRestraintDisclosureState.has(id))detail.open=overviewRestraintDisclosureState.get(id);
        detail.addEventListener('toggle',()=>{overviewRestraintDisclosureState.set(id,detail.open)});
        return detail;
      }
      function restrainOverviewActions(){
        const mount=$('actionLoopMount');const panel=mount&&mount.querySelector('.action-loop-panel');
        if(!mount||!panel||!state.actionLoop)return;
        mount.classList.add('overview-restraint-queue');
        const loop=state.actionLoop;
        const uncertain=loop.loading||loop.error||loop.mutationError||!loop.loaded;
        const cards=Array.from(panel.querySelectorAll('.action-loop-card'));
        const finished=cards.filter(card=>['completed','denied','succeeded'].includes(card.dataset.status));
        const current=cards.filter(card=>!finished.includes(card));
        const body=panel.querySelector('.action-loop-body');
        const heading=$('actionLoopHeading');if(heading)heading.textContent=current.length||uncertain?'行动':'行动记录';
        const count=panel.querySelector('.action-loop-count');if(count)count.textContent=current.length?current.length+' 条待办'+(finished.length?' · '+finished.length+' 条记录':''):cards.length+' 条记录';
        // The workflow remains available, but does not compete with approvals,
        // execution failures or a read error for attention.
        const guideNodes=['.action-loop-flow','.action-loop-stats','.action-loop-note','.action-loop-kicker','.action-loop-orb']
          .map(selector=>panel.querySelector(selector)).filter(Boolean);
        const panelHead=panel.querySelector('.action-loop-identity');const explanation=panelHead&&panelHead.querySelector('p');
        if(explanation)guideNodes.push(explanation);
        if((current.length||uncertain)&&body){
          const more=overviewRestraintDisclosure('actionLoopDetails',finished.length?'记录与流程':'流程说明',finished.length?finished.length+' 条已结束行动':'审批、执行与验证','overview-restraint-queue-detail');
          if(finished.length){const archive=make('div','action-loop-list');finished.forEach(card=>archive.appendChild(card));more.appendChild(archive)}
          guideNodes.forEach(node=>more.appendChild(node));body.appendChild(more);
          const previous=mount.querySelector('#actionLoopEmptyDetails');if(previous){mount.appendChild(panel);previous.remove()}
          const primary=$('overviewPrimary');if(primary&&mount.parentNode!==primary)primary.appendChild(mount);
        }else{
          // Reuse the established empty disclosure ID and the original panel.
          // This is one quiet row when there is no work, with refresh/history
          // still available by opening it.
          let detail=mount.querySelector('#actionLoopEmptyDetails');
          if(!detail){detail=overviewRestraintDisclosure('actionLoopEmptyDetails','当前无待处理行动',finished.length?finished.length+' 条记录':'','overview-restraint-note');mount.appendChild(detail);detail.appendChild(panel)}
          detail.classList.add('overview-restraint-note');
          const summary=detail.querySelector('summary');if(summary){summary.replaceChildren();add(summary,'span','','当前无待处理行动'+(finished.length?' · '+finished.length+' 条记录':''))}
          if(overviewRestraintDisclosureState.has(detail.id))detail.open=overviewRestraintDisclosureState.get(detail.id);
          detail.addEventListener('toggle',()=>{overviewRestraintDisclosureState.set(detail.id,detail.open)});
          // An empty queue has no flow to explain. Keep the original refresh
          // control and available historical cards without adding a second fold.
          guideNodes.forEach(node=>node.remove());
          const secondary=$('overviewSecondary');if(secondary&&mount.parentNode!==secondary)secondary.appendChild(mount);
        }
        if(!loop.loaded&&!loop.loading&&!loop.error&&!loop.mutationError&&body){
          const empty=body.querySelector('.action-loop-empty');if(empty)empty.remove();
          const unknown=add(body,'div','action-loop-state overview-restraint-unconfirmed','行动队列尚未确认，请刷新后查看。');unknown.setAttribute('role','status');
        }
        // An independent action refresh must still precede visible errors.
        const primary=$('overviewPrimary');const metrics=primary&&primary.querySelector('.overview-metrics');
        if(primary&&metrics&&mount.parentNode===primary)primary.insertBefore(mount,metrics);
      }
      function restrainOverviewMetrics(){
        const primary=$('overviewPrimary');const secondary=$('overviewSecondary');
        const metrics=primary&&primary.querySelector('.overview-metrics');if(!metrics||!secondary)return;
        const cards=Array.from(metrics.children);
        const supporting=cards.filter(card=>{const value=card.querySelector('.value');const label=card.querySelector('.label');return label&&label.textContent==='进行中告警'||!value||(!value.classList.contains('warn')&&!value.classList.contains('bad'))});
        if(!supporting.length)return;
        const samples=supporting.filter(card=>{const value=card.querySelector('.value');return value&&value.textContent==='—'}).length;
        const detail=overviewRestraintDisclosure('overviewSupportingMetrics','运行指标',supporting.length+' 项'+(samples?' · '+samples+' 项暂无样本':''),'overview-restraint-metric-detail');
        const strip=make('div','metrics overview-restraint-supporting-metrics');strip.setAttribute('aria-label','运行支持指标');supporting.forEach(card=>strip.appendChild(card));detail.appendChild(strip);secondary.insertBefore(detail,secondary.children[0]||null);
        if(!metrics.children.length)metrics.remove();else{metrics.classList.add('overview-restraint-attention-metrics');metrics.setAttribute('aria-label','需要关注的运行指标')}
      }
      const overviewRestraintBaseRenderActionLoopMount=renderActionLoopMount;
      renderActionLoopMount=function(){rememberOverviewRestraintDisclosures();const result=overviewRestraintBaseRenderActionLoopMount();restrainOverviewActions();return result};
      const overviewRestraintBaseRenderOverview=renderOverview;
      renderOverview=function(){
        rememberOverviewRestraintDisclosures();overviewRestraintBaseRenderOverview();
        const root=$('overviewContent');if(!root||!state.overview)return;
        root.classList.add('overview-restraint');
        // Group labels repeat the page title and the health disclosure labels.
        // Keep their IDs as accessible section names rather than visible chrome.
        root.querySelectorAll('.overview-group-head').forEach(head=>head.classList.add('sr-only'));
        restrainOverviewMetrics();
      };
`;
