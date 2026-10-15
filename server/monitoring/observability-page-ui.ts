/**
 * 工作台共享 UI 组件层（OpsUI）。
 *
 * 页面是无框架的单文件 HTML：样式与脚本以 TS 模板串拼装，全部脚本片段共享同一
 * IIFE 作用域（同名函数声明会静默互相覆盖，见 script-a 内 2026-09-24 事故注记）。
 * 因此组件层只向共享作用域暴露一个命名空间 `OpsUI`，内部实现全部封闭在工厂
 * IIFE 里；调用方一律通过 `OpsUI.dialog / OpsUI.toast / OpsUI.state / OpsUI.table`
 * 访问，后续新增组件也挂在同一命名空间下，杜绝散装全局名。
 *
 * 生产约束（对全部组件生效）：
 *  - 安全：只走 createElement + textContent，任何组件不写 innerHTML（页面级
 *    运行时守卫测试会拦截违规写入）；
 *  - 可访问性：对话框实现焦点圈定与归还、Esc / 遮罩关闭、body 滚动锁（计数制，
 *    支持嵌套）；toast 按成败区分 role=status / role=alert 播报语义；异步状态
 *    加载用 role=status、失败用 role=alert；表格补 sr-only caption 与 th scope；
 *  - 动效：加载旋转与抽屉过渡在 prefers-reduced-motion 下停用；
 *  - 桩环境安全：组件会在测试的最小 DOM 桩里求值与运行，所有可选能力
 *    （querySelectorAll、activeElement、removeEventListener）先判存在再调用。
 */
export const OPS_OBSERVABILITY_UI_STYLE = `
    /* ---- OpsUI 组件层样式：sr-only 工具类、模态滚动锁、异步状态、焦点可见性 ---- */
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
    body.opsui-modal-open{overflow:hidden}
    .toast{cursor:default;pointer-events:none}
    .load-state{display:flex;align-items:flex-start;gap:12px;padding:16px}
    .load-state .load-state-icon{flex:none;box-sizing:border-box;width:22px;height:22px;border:2px solid var(--line);border-top-color:var(--green);border-radius:50%;animation:opsui-spin .8s linear infinite}
    .load-state.error .load-state-icon{border:0;background:color-mix(in srgb,var(--danger,#b42318) 14%,transparent);color:var(--danger,#b42318);animation:none;font-size:14px;font-weight:700}
    .load-state .copy strong{display:block;font-size:13px}
    .load-state .copy span{display:block;margin-top:3px;color:var(--muted);font-size:11px}
    .load-state .btn{margin-top:10px}
    .load-state .copy{min-width:0}
    @keyframes opsui-spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){
      .load-state .load-state-icon{animation:none}
      .drawer,.event-drawer,.drawer-backdrop,.event-drawer-backdrop{transition:none!important}
    }
    .drawer-backdrop:focus-visible,.drawer a:focus-visible,.drawer button:focus-visible,.drawer input:focus-visible,.drawer select:focus-visible,.drawer textarea:focus-visible{outline:2px solid var(--green);outline-offset:1px}
  `;

export const OPS_OBSERVABILITY_SCRIPT_UI = `
      // ============================== OpsUI 组件层 ==============================
      // 只暴露 OpsUI 命名空间；实现细节封闭在工厂 IIFE 内，避免共享作用域重名。
      const OpsUI=(function(){
        // ---- 模态滚动锁（计数制）：嵌套对话框全关后才解锁 body 滚动 ----
        let modalLockCount=0;
        let dialogStack=[];
        function lockScroll(){modalLockCount++;document.body.classList.add('opsui-modal-open')}
        function unlockScroll(){modalLockCount=Math.max(0,modalLockCount-1);if(!modalLockCount)document.body.classList.remove('opsui-modal-open')}
        const FOCUS_SELECTOR='a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
        function focusableNodes(panel){
          try{
            const found=panel.querySelectorAll?panel.querySelectorAll(FOCUS_SELECTOR):[];
            return Array.prototype.filter.call(found,function(node){return node&&node.disabled!==true&&node.getAttribute('tabindex')!=='-1'});
          }catch(error){return[]}
        }
        function focusNode(node){if(node&&typeof node.focus==='function'){try{node.focus()}catch(error){}}}
        // ---- 对话框（抽屉/模态通用）----
        // options:
        //   id            挂载节点 id（可选；同 id 复用时调用方自行判重）
        //   label         aria-label（必填其一；标题随内容变化时用 label 而非 labelledby）
        //   backdropClass 遮罩类名，默认 'drawer-backdrop'
        //   panelClass    面板类名，默认 'drawer'
        //   closeOnBackdrop 点击遮罩空白处关闭，默认 true
        //   closeOnEscape Esc 关闭，默认 true（嵌套时只关最上层）
        // 返回 api：{shell,panel,open,close,isOpen,destroy}；open/close 幂等。
        function dialog(options){
          const opts=options||{};
          const shell=document.createElement('div');
          if(opts.id)shell.id=opts.id;
          shell.className=(opts.backdropClass||'drawer-backdrop')+' opsui-dialog-backdrop';
          shell.setAttribute('role','dialog');
          shell.setAttribute('aria-modal','true');
          if(opts.label)shell.setAttribute('aria-label',String(opts.label));
          const panel=document.createElement('div');
          panel.className=opts.panelClass||'drawer';
          shell.appendChild(panel);
          let open=false;
          let returnFocus=null;
          function isTopmost(){return dialogStack[dialogStack.length-1]===shell}
          function onKeydown(event){
            if(!open||!isTopmost())return;
            if(event.key==='Escape'&&opts.closeOnEscape!==false){event.preventDefault();api.close();return}
            if(event.key!=='Tab')return;
            const nodes=focusableNodes(panel);
            if(!nodes.length)return;
            const active=document.activeElement||null;
            let index=-1;
            for(let i=0;i<nodes.length;i++){if(nodes[i]===active){index=i;break}}
            if(event.shiftKey){if(index<=0){event.preventDefault();focusNode(nodes[nodes.length-1])}}
            else if(index===nodes.length-1||index===-1){event.preventDefault();focusNode(nodes[0])}
          }
          function onBackdropClick(event){if(open&&opts.closeOnBackdrop!==false&&event.target===shell)api.close()}
          shell.addEventListener('click',onBackdropClick);
          document.addEventListener('keydown',onKeydown);
          const api={
            shell:shell,
            panel:panel,
            isOpen:function(){return open},
            open:function(){
              if(open)return;
              open=true;
              try{
                const active=document.activeElement||null;
                returnFocus=active&&typeof active.focus==='function'?active:null;
              }catch(error){returnFocus=null}
              lockScroll();
              shell.classList.add('open');
              dialogStack.push(shell);
              panel.setAttribute('tabindex','-1');
              const nodes=focusableNodes(panel);
              focusNode(nodes.length?nodes[0]:panel);
            },
            close:function(){
              if(!open)return;
              open=false;
              shell.classList.remove('open');
              dialogStack=dialogStack.filter(function(node){return node!==shell});
              unlockScroll();
              if(returnFocus){focusNode(returnFocus);returnFocus=null}
            },
            destroy:function(){
              api.close();
              if(typeof shell.removeEventListener==='function')shell.removeEventListener('click',onBackdropClick);
              if(typeof document.removeEventListener==='function')document.removeEventListener('keydown',onKeydown);
              if(shell.parentNode&&typeof shell.parentNode.removeChild==='function')shell.parentNode.removeChild(shell);
            }
          };
          // 调用方常按 id 取回 shell（如 closeAlertDetail），把 api 挂在节点上
          // 提供统一开关通道，避免绕过焦点归还与滚动锁直接改 class。
          shell.opsui=api;
          return api;
        }
        // ---- 轻提示 ----
        // toast(message, ok=true)：沿用页面既有签名；ok===false 时按 role=alert /
        // aria-live=assertive 立即播报。策略取「最后一次操作结果优先」：新消息立即
        // 替换当前内容（不排队堆栈，避免旧结果掩盖最新状态），相同文案重复触发只
        // 重置计时；悬停或键盘聚焦时暂停自动关闭，移开后按剩余时长继续。
        let toastNode=null;
        let toastTimer=null;
        let toastDeadline=0;
        let toastPaused=false;
        const TOAST_MIN_MS=2000;
        const TOAST_MAX_MS=10000;
        function hideToast(){if(toastTimer){clearTimeout(toastTimer);toastTimer=null}if(toastNode){toastNode.className='toast';toastNode.removeAttribute('role');toastNode.removeAttribute('aria-live')}}
        function scheduleToastHide(delay){
          if(toastTimer)clearTimeout(toastTimer);
          toastTimer=setTimeout(function(){toastTimer=null;hideToast()},delay);
        }
        function bindToastPause(node){
          node.addEventListener('mouseenter',function(){toastPaused=true;if(toastTimer){clearTimeout(toastTimer);toastTimer=null}});
          node.addEventListener('mouseleave',function(){toastPaused=false;scheduleToastHide(Math.max(TOAST_MIN_MS,toastDeadline-Date.now()))});
          node.addEventListener('focusin',function(){toastPaused=true;if(toastTimer){clearTimeout(toastTimer);toastTimer=null}});
          node.addEventListener('focusout',function(){toastPaused=false;scheduleToastHide(Math.max(TOAST_MIN_MS,toastDeadline-Date.now()))});
        }
        function toast(message,ok){
          if(!toastNode){
            toastNode=document.getElementById?document.getElementById('toast'):null;
            if(!toastNode){
              toastNode=document.createElement('div');
              toastNode.id='toast';
              document.body.appendChild(toastNode);
            }
            bindToastPause(toastNode);
          }
          const text=String(message==null?'':message);
          const failure=ok===false;
          const duration=Math.min(TOAST_MAX_MS,Math.max(TOAST_MIN_MS,failure?6000:3600));
          const visible=toastNode.classList.contains('show');
          if(visible&&toastNode.textContent===text){
            toastDeadline=Date.now()+duration;
            if(!toastPaused)scheduleToastHide(duration);
            return toastNode;
          }
          toastNode.textContent=text;
          toastNode.className='toast show '+(failure?'bad':'ok');
          toastNode.setAttribute('role',failure?'alert':'status');
          toastNode.setAttribute('aria-live',failure?'assertive':'polite');
          toastDeadline=Date.now()+duration;
          if(!toastPaused)scheduleToastHide(duration);
          return toastNode;
        }
        // ---- 异步状态（加载 / 空 / 失败+重试）----
        // state(node, options)：
        //   kind  'loading' | 'empty' | 'error'（缺省 loading）
        //   title 主文案；error 缺省「加载失败」，empty 缺省「暂无数据」
        //   hint  次级说明（error 时建议给可行动的重试指引）
        //   retry error 时的重试回调（渲染「重试」按钮）
        //   className 额外类名
        // 角色语义：loading/empty → role=status（polite），error → role=alert。
        // 结构与旧 renderLoadPanel 兼容：panel.load-state.loading|.error +
        // load-state-icon + copy(strong+span)，CSS 沿用既有类名。
        function state(node,options){
          if(!node)return null;
          const opts=options||{};
          const kind=opts.kind==='error'?'error':opts.kind==='empty'?'empty':'loading';
          node.replaceChildren();
          if(kind==='empty'){
            const empty=document.createElement('div');
            empty.className=opts.className?'signals-empty '+opts.className:'signals-empty';
            empty.setAttribute('role','status');
            empty.textContent=String(opts.title||'暂无数据');
            node.appendChild(empty);
            return empty;
          }
          const panel=document.createElement('section');
          panel.className='panel load-state '+kind+(opts.className?' '+opts.className:'');
          panel.setAttribute('role',kind==='error'?'alert':'status');
          panel.setAttribute('aria-live',kind==='error'?'assertive':'polite');
          const icon=document.createElement('div');
          icon.className='load-state-icon';
          icon.setAttribute('aria-hidden','true');
          if(kind==='error')icon.textContent='!';
          panel.appendChild(icon);
          const copy=document.createElement('div');
          copy.className='copy';
          const strong=document.createElement('strong');
          strong.textContent=String(opts.title||(kind==='error'?'加载失败':'正在加载…'));
          copy.appendChild(strong);
          const hint=document.createElement('span');
          hint.textContent=String(opts.hint||(kind==='error'?'请稍后重试。':'已发起真实数据请求，请稍候。'));
          copy.appendChild(hint);
          panel.appendChild(copy);
          if(kind==='error'&&typeof opts.retry==='function'){
            const retry=document.createElement('button');
            retry.type='button';
            retry.className='btn';
            retry.textContent='重试';
            // 重试通常触发异步加载并由加载方接管容器渲染；此处不做同步禁用，
            // 与旧 renderLoadPanel 行为一致，避免按钮状态与容器状态竞态。
            retry.addEventListener('click',function(){opts.retry()});
            panel.appendChild(retry);
          }
          node.appendChild(panel);
          return panel;
        }
        // ---- 数据表 ----
        // table(options)：
        //   title    可见面板标题（h2，沿用 table-panel 布局）
        //   columns  表头文案数组
        //   rows     行二维数组；单元格一律 textContent 写入，null/undefined 渲染为空
        //   empty    空态文案（role=status 播报）
        // 可访问性：sr-only caption 概述「标题 + 行×列」；表头补 scope="col"；
        // 外层 .scroll 维持既有横向滚动（移动端不挤压列）。
        let tableSequence=0;
        function table(options){
          const opts=options||{};
          const panel=document.createElement('section');
          panel.className='panel table-panel';
          const head=document.createElement('div');
          head.className='table-title';
          const title=document.createElement('h2');
          title.textContent=String(opts.title||'');
          head.appendChild(title);
          panel.appendChild(head);
          const columns=Array.isArray(opts.columns)?opts.columns:[];
          const rows=Array.isArray(opts.rows)?opts.rows:[];
          if(!rows.length){
            const empty=document.createElement('div');
            empty.className='empty';
            empty.setAttribute('role','status');
            empty.textContent=String(opts.empty||'暂无数据');
            panel.appendChild(empty);
            return panel;
          }
          const scroll=document.createElement('div');
          scroll.className='scroll';
          const tableNode=document.createElement('table');
          tableSequence++;
          const caption=document.createElement('caption');
          caption.className='sr-only';
          caption.id='opsui-table-caption-'+tableSequence;
          caption.textContent=String(opts.title||'数据表')+'：'+rows.length+' 行 × '+columns.length+' 列';
          tableNode.appendChild(caption);
          const thead=document.createElement('thead');
          const headRow=document.createElement('tr');
          columns.forEach(function(value){
            const th=document.createElement('th');
            th.setAttribute('scope','col');
            th.textContent=value==null?'':String(value);
            headRow.appendChild(th);
          });
          thead.appendChild(headRow);
          tableNode.appendChild(thead);
          const tbody=document.createElement('tbody');
          rows.forEach(function(row){
            const tr=document.createElement('tr');
            (Array.isArray(row)?row:[]).forEach(function(value){
              const td=document.createElement('td');
              td.textContent=value==null?'':String(value);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          tableNode.appendChild(tbody);
          scroll.appendChild(tableNode);
          panel.appendChild(scroll);
          return panel;
        }
        return {dialog:dialog,toast:toast,state:state,table:table};
      })();
`;
