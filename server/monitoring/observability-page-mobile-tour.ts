/**
 * 移动端底部导航与首次访问导览。
 *
 * 底部 tab：≤520px 时复用现有 .side-nav / .module-tabs / .module-tab DOM（按钮
 * 本来就带 data-view 和 click 路由），CSS 把它变成 fixed 底栏；前 5 个高频模块
 * 平铺（脚本搬进 .nav-primary，resize 回桌面时还原），其余模块折叠进"更多"
 * 表。不引入新按钮或新路由逻辑。
 *
 * 导览：localStorage 标记一次性；步骤卡定位在底部栏上方，60 秒内可走完，
 * 任意时刻可跳过；键盘可达（Esc 跳过），不遮住正在浏览的数据。
 */
export const OPS_OBSERVABILITY_MOBILE_TOUR_STYLE = `
    /* 选择器都带 body.ops-observability 前缀：product-style 的移动端规则包在
       @scope (body.ops-observability) 里，scoped 选择器特异性比裸类名高，
       不加前缀会被同名的 720px scoped 规则压掉。 */
    @media(max-width:520px){
      body.ops-observability .app-shell{display:block;padding-bottom:calc(64px + env(safe-area-inset-bottom))}
      body.ops-observability .side-nav{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:30;width:100%;height:auto;max-height:70vh;overflow:visible;border-right:0;border-top:1px solid var(--line);padding:0;background:var(--c2);box-shadow:0 -6px 18px var(--c63)}
      body.ops-observability .global-nav{display:none}
      body.ops-observability .module-tabs{display:flex;flex-wrap:nowrap;overflow:visible;gap:0;padding:0 calc(6px + env(safe-area-inset-right)) 0 calc(6px + env(safe-area-inset-left))}
      /* 折叠态：主 tab 由脚本搬进 .nav-primary（display:contents 在 <details> 上
         布局不生效，Chrome 已知行为），组容器整体隐藏。 */
      body.ops-observability .module-tabs:not(.mobile-expanded) .nav-group{display:none}
      body.ops-observability .module-tabs:not(.mobile-expanded) .nav-primary{display:flex;flex-wrap:nowrap;gap:0}
      body.ops-observability .module-tabs:not(.mobile-expanded) .module-tab:not(.mobile-primary){display:none}
      body.ops-observability .module-tab{flex:1 1 0;min-width:0;height:56px;flex-direction:column;justify-content:center;gap:3px;padding:6px 2px;border-radius:9px;font-size:10px;line-height:1.1;text-align:center;white-space:nowrap;overflow:hidden}
      body.ops-observability .module-tab:before{width:auto;margin:0;font-size:17px}
      body.ops-observability .module-tab .tab-count{position:absolute;top:5px;right:calc(50% - 26px);transform:scale(.9)}
      body.ops-observability .module-tab.active{box-shadow:inset 0 3px 0 var(--c373)}
      body.ops-observability .mobile-more-toggle{display:flex}
      body.ops-observability .mobile-more-toggle.expanded:before{content:"⌄"}
      /* 展开态：全部模块以网格列出（从底栏向上展开） */
      body.ops-observability .module-tabs.mobile-expanded{flex-direction:column;flex-wrap:wrap;max-height:62vh;overflow:auto;border-top:1px solid var(--line);background:var(--c2);padding:8px 10px calc(12px + env(safe-area-inset-bottom))}
      body.ops-observability .module-tabs.mobile-expanded .nav-group{display:block;margin:0}
      body.ops-observability .module-tabs.mobile-expanded .nav-section-toggle{display:flex}
      body.ops-observability .module-tabs.mobile-expanded .nav-group[open] .nav-section-toggle{min-height:40px;font-size:11px}
      body.ops-observability .module-tabs.mobile-expanded .nav-group-items{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:0}
      body.ops-observability .module-tabs.mobile-expanded .module-tab{display:flex;flex-direction:row;justify-content:flex-start;height:42px;font-size:12px;text-align:left;padding:7px 10px;gap:8px;white-space:nowrap}
      body.ops-observability .module-tabs.mobile-expanded .module-tab:before{width:20px;text-align:center}
      body.ops-observability .mobile-more-toggle{position:absolute;top:-46px;right:10px;width:56px;height:38px;border:1px solid var(--line);border-radius:10px;background:var(--c2);color:var(--text);font-size:11px;box-shadow:0 -4px 14px var(--c374);cursor:pointer;align-items:center;justify-content:center;flex-direction:column;gap:2px}
      body.ops-observability .mobile-more-toggle:before{content:"•••";font-size:13px;letter-spacing:1px}
      body.ops-observability .mobile-more-toggle span{font-size:9px}
    }
    @media(min-width:521px){body.ops-observability .mobile-more-toggle{display:none}}

    .tour-card{position:fixed;left:50%;bottom:calc(74px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:70;width:min(430px,calc(100vw - 24px));padding:15px 16px 13px;border:1px solid var(--c357);border-radius:13px;background:var(--c2);box-shadow:0 16px 44px var(--c131)}
    @media(min-width:521px){.tour-card{bottom:26px;left:26px;transform:none}}
    .tour-step-chip{display:inline-flex;align-items:center;gap:6px;margin-bottom:7px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
    .tour-step-chip strong{color:var(--green)}
    .tour-card h3{margin:0 0 5px;font-size:14px;line-height:1.3;color:var(--c375)}
    .tour-card p{margin:0;font-size:11px;line-height:1.55;color:var(--muted)}
    .tour-card p kbd{padding:1px 5px;border:1px solid var(--c367);border-bottom-width:2px;border-radius:4px;background:var(--c44);font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--c376)}
    .tour-progress{display:flex;gap:4px;margin:11px 0 0}
    .tour-progress i{flex:1;height:3px;border-radius:2px;background:var(--c377)}
    .tour-progress i.done{background:var(--green)}
    .tour-actions{display:flex;align-items:center;gap:8px;margin-top:11px}
    .tour-actions .btn{height:30px;padding:4px 13px;font-size:11px}
    .tour-skip{margin-left:auto;border:0;background:transparent;color:var(--muted);font-size:11px;cursor:pointer}
    .tour-skip:hover{color:var(--text)}
    @media(prefers-reduced-motion:reduce){.tour-card{transition:none}}
`;

export const OPS_OBSERVABILITY_SCRIPT_MOBILE_TOUR = `
      (function(){
        // ---- 移动端底部 tab：标记前 5 个高频模块，≤520px 时搬进主行 ----
        // Keep the bottom bar to five task-first destinations. Growth, SLO,
        // device and setup views remain one tap away in “更多”.
        const MOBILE_PRIMARY=['overview','investigate','alerts/center','traces','signals/panels'];
        try{
          document.querySelectorAll('.module-tab').forEach(tab=>{if(MOBILE_PRIMARY.includes(tab.dataset.view))tab.classList.add('mobile-primary')});
          const tabs=document.querySelector('.module-tabs');
          const nav=document.querySelector('.side-nav');
          if(tabs&&nav&&document.createElement('button').classList){
            // <details> 上 display:contents 布局不生效，主 tab 需物理搬进
            // .nav-primary 才能成为底栏 flex 项；resize 回桌面时还原回原分组。
            const primary=document.querySelector('.nav-primary');
            const mql=window.matchMedia('(max-width:520px)');
            const moved=[];
            const applyMobileNav=()=>{
              if(!primary)return;
              if(mql.matches){
                if(moved.length)return;
                document.querySelectorAll('.module-tabs .module-tab.mobile-primary').forEach(btn=>{
                  if(btn.parentElement!==primary){moved.push({btn,parent:btn.parentElement,next:btn.nextSibling});primary.appendChild(btn)}
                });
              }else{
                while(moved.length){const {btn,parent,next}=moved.pop();parent.insertBefore(btn,next||null)}
                tabs.classList.remove('mobile-expanded');
              }
            };
            try{mql.addEventListener('change',applyMobileNav)}catch(_){/* 旧浏览器忽略动态切换 */}
            // matchMedia change 在部分嵌入视图/模拟视口下不触发，resize 兜底。
            window.addEventListener('resize',()=>{if(mql.matches!==window.__lastMobileMatch){window.__lastMobileMatch=mql.matches;applyMobileNav()}},{passive:true});
            window.__lastMobileMatch=mql.matches;
            applyMobileNav();
            const more=document.createElement('button');
            more.type='button';more.className='module-tab mobile-more-toggle';more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls','moduleTabs');
            more.innerHTML='<span>更多</span>';
            more.addEventListener('click',()=>{
              const expanded=!tabs.classList.contains('mobile-expanded');
              tabs.classList.toggle('mobile-expanded',expanded);
              more.classList.toggle('expanded',expanded);
              more.setAttribute('aria-expanded',String(expanded));
              if(!expanded&&window.matchMedia('(max-width:520px)').matches){window.scrollTo({top:0});}
            });
            nav.appendChild(more);
            // 切换主 tab 时收起"更多"面板
            tabs.addEventListener('click',event=>{const btn=event.target.closest('.module-tab');if(!btn||btn===more)return;if(btn.classList.contains('mobile-primary')||tabs.classList.contains('mobile-expanded')){tabs.classList.remove('mobile-expanded');more.classList.remove('expanded');more.setAttribute('aria-expanded','false')}});
          }
        }catch(_){/* 移动栏增强失败不影响桌面 */}

        // ---- 首次访问导览（约 60 秒，可跳过） ----
        const TOUR_KEY='d_obs_tour_done_v1';
        const TOUR_STEPS=[
          {title:'这里是全局态势',body:'打开页面先看"当前态势"：进行中告警、SLO 错误预算和今天该处理的待办都在这一屏。'},
          {title:'出了事先去"事故调查"',body:'按 影响面 → 多信号趋势 → 代表事件 的顺序下钻；证据不足时页面会明说，不会编造根因。'},
          {title:'用 ⌘K / 斜杠 快速跳转',body:'任何时候按 <kbd>⌘ K</kbd>（Mac）或 <kbd>/</kbd> 唤起命令面板，输入"事故""Trace""SLO"直接跳模块。'},
          {title:'告警与通知在"告警策略"',body:'规则、阈值、通知模板都在这里改；新环境默认影子模式（只记录不外发），确认后再开启真实投递。'},
          {title:'数据与证据可查证',body:'链路追踪、数据库只读资产、数据健康面板提供证据链；所有数据按运营权限脱敏。'}
        ];
        try{
          if(localStorage.getItem(TOUR_KEY))return;
          if(document.getElementById('tourCard'))return;
          const card=document.createElement('section');
          card.id='tourCard';card.className='tour-card';card.setAttribute('role','dialog');card.setAttribute('aria-modal','false');card.setAttribute('aria-label','工作台导览');
          let step=0;
          const finish=()=>{try{localStorage.setItem(TOUR_KEY,'1')}catch(_){}card.remove();document.removeEventListener('keydown',onKey)};
          const render=()=>{
            const s=TOUR_STEPS[step];
            card.innerHTML='';
            const chip=document.createElement('div');chip.className='tour-step-chip';
            const chipStrong=document.createElement('strong');chipStrong.textContent=(step+1)+' / '+TOUR_STEPS.length;
            chip.appendChild(chipStrong);chip.appendChild(document.createTextNode('导览'));
            card.appendChild(chip);
            const h=document.createElement('h3');h.textContent=s.title;card.appendChild(h);
            const p=document.createElement('p');p.innerHTML=s.body;card.appendChild(p);
            const progress=document.createElement('div');progress.className='tour-progress';
            TOUR_STEPS.forEach((_,i)=>{const dot=document.createElement('i');if(i<=step)dot.classList.add('done');progress.appendChild(dot)});
            card.appendChild(progress);
            const actions=document.createElement('div');actions.className='tour-actions';
            const next=document.createElement('button');next.type='button';next.className='btn';
            next.textContent=step===TOUR_STEPS.length-1?'完成':'下一步';
            next.addEventListener('click',()=>{step+=1;if(step>=TOUR_STEPS.length)finish();else render()});
            actions.appendChild(next);
            const skip=document.createElement('button');skip.type='button';skip.className='tour-skip';skip.textContent='跳过导览';
            skip.addEventListener('click',finish);
            actions.appendChild(skip);
            card.appendChild(actions);
          };
          const onKey=event=>{if(event.key==='Escape'){event.preventDefault();finish()}};
          document.addEventListener('keydown',onKey);
          render();
          document.body.appendChild(card);
        }catch(_){/* localStorage 不可用时静默跳过导览 */}
      })();
`;
