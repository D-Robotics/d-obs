const stageText={snapshot:'读取原始 ISP',saved:'原始 ISP 已保存',checking:'核对设备和当前配置',
  gamma_before:'采集调整前实拍',gamma_plan:'等待 AI 生成候选',gamma_apply:'应用有界 Gamma',
  gamma_verify:'独立回读并采集新图',gamma_saved:'实拍与回读齐备',gamma_reloaded:'已重载并采得新帧',
  restore:'恢复期初 ISP',readback:'独立读取当前 ISP',stop:'停止采流',stopped:'原值已恢复，采流已停止',reverted:'已恢复期初 ISP'};
const errors={
  camera_gamma_round_locked:'请先完成上一轮取舍，并核对原值恢复。每个工位最多两轮。',
  camera_binding_invalid:'先关联本工位相机实验。',
  camera_capture_busy:'相机正在执行本工位另一项操作。',
  camera_isp_snapshot_missing:'请先保存本工位原始 ISP。',
  camera_isp_snapshot_changed:'当前相机或配置发生变化。请核对工位并恢复本工位原值。',
  camera_isp_stream_required:'请先确认相机正在出图，再采实拍和独立回读。',
  camera_recovery_required:'请先核对并恢复已保存的原始 ISP。',
  camera_isp_restore_unconfirmed:'恢复尚未核对。请保留本轮记录，并用同一快照处理。',
  camera_stop_unconfirmed:'ISP 已回读，采流停止还需核对。',
  camera_gamma_candidate_rejected:'候选超出了课堂 Gamma 允许范围。换一个更具体的观察目标后重试。',
  vision_model_disabled:'视觉模型未配置。请助教核对课程模型服务。',
  vision_model_no_adjustment:'AI 本次未给出合格候选。可以修改观察目标重试，当前未增加已完成轮数。',
  camera_gamma_freshness_failed:'候选应用后未取得匹配的新帧。请先核对恢复。',
  camera_gamma_reload_required:'先取得已验证候选和恢复后实拍，再重载。',
  camera_isp_evidence_unavailable:'暂时读不到归档图。请核对工位相机服务。',
};
const explain=code=>errors[code]??'本工位操作未完成 · '+(code??'请刷新后重试');
const names={original:'原始ISP',beforeReadback:'调前ISP回读',gammaReadback:'Gamma参数回读',decisionReadback:'取舍确认回读',
  resetReadback:'下一轮前恢复回读',readback:'工位恢复回读',reloadReadback:'重载回读',
  before:'调前实拍',after:'调后实拍',restored:'恢复后实拍',reloaded:'重载实拍'};
const images=new Set(['before','after','restored','reloaded']);
const previewRetryDelays=[300,900];
const evidenceChanged='ISP 工位记录已更新，请重新下载成果包。';
const transportError=()=>Object.assign(new Error('暂时无法读取工位数据，请重试。'),{retryable:true});
const receiptFields=['beforeReadback','gammaReadback','decisionReadback','resetReadback'];
const roundFields=['before','after','restored',...receiptFields];
const roundEntries=(round,fields)=>fields.filter(name=>round[name]).map(name=>({name,round:round.number,asset:round[name]}));
const sessionEntries=(status,fields)=>fields.filter(name=>status?.[name]).map(name=>({name,asset:status[name]}));
const entryKey=({name,round})=>`${round??0}:${name}`;
const artifacts=status=>[...sessionEntries(status,['original','readback','reloadReadback','reloaded']),
  ...(status?.rounds??[]).flatMap(round=>roundEntries(round,roundFields))];

export function createIspPanel({key,$,element,button,openDialog,field,notify,getBinding,pick}) {
  let binding, status, posting=false, polling=false, bindingRevision=0;
  let imageReads=Promise.resolve();
  const previews=new Map();
  async function request(path='/camera/isp',body) {
    const headers={'X-Workshop-Session':key,...(body?{'Content-Type':'application/json'}:{})};
    let response;
    try { response=await fetch(path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})}); }
    catch { throw transportError(); }
    if(!response.ok) {
      const code=(await response.json().catch(()=>({}))).error;
      const retryable=code==='camera_isp_evidence_unavailable'||response.status===408||response.status===429||response.status>=500;
      throw Object.assign(new Error(explain(code)),{retryable});
    }
    return response;
  }
  async function readFile({name,round,asset}) {
    const params=new URLSearchParams({file:name,sha256:asset.hash??asset.sha256});
    if(round) params.set('round',round);
    const response=await request('/camera/isp?'+params);
    let blob;
    try { blob=await response.blob(); }
    catch { throw transportError(); }
    const ext=images.has(name)?(blob.type==='image/png'?'.png':'.jpg'):'.json';
    return new File([blob],(round?'Gamma-第'+round+'轮-':'工位-')+names[name]+ext,{type:blob.type});
  }
  function readImage(entry,isCurrent) {
    // A full-resolution archive frame can be several megabytes. Share one queue with export.
    const queued=imageReads.then(()=>{
      if(!isCurrent()) throw new Error(evidenceChanged);
      return previews.get(entryKey(entry))?.file??readFile(entry);
    });
    imageReads=queued.catch(()=>{});
    return queued;
  }

  async function populate(entry,cached) {
    const isCurrent=()=>previews.get(entryKey(entry))===cached;
    for(let attempt=0;attempt<=previewRetryDelays.length&&isCurrent();attempt++) {
      try {
        const file=await readImage(entry,isCurrent);
        if(!isCurrent()) return;
        cached.url=URL.createObjectURL(file);
        cached.file=file;
        cached.state='ready';
        render();
        return;
      } catch(error) {
        if(!isCurrent()) return;
        const delay=previewRetryDelays[attempt];
        if(!error.retryable||delay===undefined) {
          cached.state='failed';
          render();
          return;
        }
        cached.state='retrying';
        render();
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
  }

  function retryPreview(entry,cached) {
    if(previews.get(entryKey(entry))!==cached||cached.state!=='failed') return;
    cached.state='pending';
    render();
    void populate(entry,cached);
  }
  function apply(next) {
    if(next&&next.experimentId!==binding) return;
    if(JSON.stringify(status)===JSON.stringify(next)) return;
    status=next;
    const entries=new Map(artifacts(next).filter(entry=>images.has(entry.name)).map(entry=>[entryKey(entry),entry]));
    for(const [slot,previous] of previews) if(previous.hash!==entries.get(slot)?.asset.sha256) {
      if(previous.url) URL.revokeObjectURL(previous.url);
      previews.delete(slot);
    }
    for(const [slot,entry] of entries) if(!previews.has(slot)) {
      const cached={hash:entry.asset.sha256,state:'pending'};
      previews.set(slot,cached);
      void populate(entry,cached);
    }
    render();
  }
  async function poll() {
    if(polling||posting||!key||!binding) return;
    const revision=bindingRevision;
    polling=true;
    try {
      const data=await(await request()).json();
      if(!posting&&bindingRevision===revision) apply(data.isp);
    } catch {}
    finally {
      polling=false;
      if(bindingRevision!==revision) void poll();
    }
  }
  async function start(body) {
    if(posting||status?.running) return;
    const revision=bindingRevision;
    posting=true;render();
    try {
      const {isp}=await(await request('/camera/isp',body)).json();
      if(bindingRevision===revision) apply(isp);
    } catch(error) {
      if(bindingRevision===revision) notify(error.message);
    } finally {
      posting=false;render();
      if(bindingRevision!==revision) void poll();
    }
  }
  function confirm(action) {
    const final=action==='restore';
    openDialog(final?'恢复期初 ISP 并停流':'恢复期初 ISP，继续采流',[
      element('p',final?'恢复原始配置，独立回读一致后停止采流。':'独立确认恢复原值，并采一张恢复后实拍。已记录的取舍会保留。'),
    ],()=>start({action}),final?'恢复并停流':'恢复原值');
  }
  function openTrial(number) {
    const guided=number===1;
    const goals=[['看清阴影中的文字，保留亮部细节','阴影中文字'],['区分暗部相邻区域，保持亮部稳定','暗部层次']];
    openDialog(guided?'第 1 轮 · 跟做':'第 2 轮 · 自主',[
      element('p','保持机位、光照和目标不变。只调整当前生效的 Gamma 曲线。'),
      guided?field('goal','选一个观察目标',{options:goals,value:goals[0][0]}):
        field('goal','写出你自己的观察目标',{max:180,placeholder:'例如让左侧暗部更清楚，同时保持右侧亮部细节'}),
    ],({goal})=>start({action:'gamma',round:number,goal}),'生成并应用候选');
  }
  function openDecision(round) {
    openDialog(`第 ${round.number} 轮 · 记录取舍`,[
      element('p','先看调前、调后两张实拍和参数回读，再记录你看到的改善或代价。'),
      field('choice','选择',{options:[['','请选择'],['keep','保留调整'],['restore','恢复原值']]}),
      field('reason','写下理由',{max:180,placeholder:'例如阴影中文字更清楚，亮部仍有纹理'}),
    ],({choice,reason})=>start({action:'decision',round:round.number,choice,reason}),'保存取舍并核对回读');
  }
  function imageCard(entry) {
    const {name}=entry;
    const card=element('figure','','camera-archive-preview');
    const cached=previews.get(entryKey(entry));
    if(cached?.url) {
      const img=element('img');img.src=cached.url;img.alt=names[name];card.append(img);
    } else if(cached?.state==='failed') {
      const retry=button('重试预览',()=>retryPreview(entry,cached),'plain');
      retry.setAttribute('aria-label','重试'+names[name]+'预览');
      card.append(element('p','暂时无法打开实拍预览。','capture-error'),retry);
    } else {
      const message=cached?.state==='retrying'?'正在重试读取相机原件':'正在读取相机原件';
      card.append(element('p',message,'action-copy'));
    }
    card.append(element('figcaption',names[name]+' · SDK '+entry.asset.sdkTimestampNs));
    return card;
  }
  function receiptsList(entries) {
    const list=element('ul','','review-list');
    for(const {name,asset} of entries) {
      const item=element('li',names[name]+' · '+asset.receiptId,'isp-receipt');
      if(asset.curvePreview) item.append(element('small','曲线采样（0 / 16 / 32 / 48 / 63） · '+asset.curvePreview.points.join(' / ')));
      item.append(element('small','SHA-256 '+asset.hash));
      list.append(item);
    }
    return list;
  }
  function roundCard(number,round,done,busy) {
    const card=element('article','','isp-round');
    const current=done===number-1;
    const head=element('div','','action-head');
    const state=round?.decision?'已验收':round?'待记录取舍':current?'待实拍与回读':'等待上一轮';
    head.append(element('h3',number===1?'第 1 轮 · 跟做':'第 2 轮 · 自主'),element('span',state,'status-tag'+(round?.decision?' ok':'')));
    card.append(head);
    card.append(element('p',round?.goal??(number===1?'选一个观察目标，跟着完成一次有界调整。':'自己写目标，再验证同一场景的画面变化。'),'action-copy'));
    if(!round) return card;
    const frames=element('div','','capture-cards isp-pair');
    for(const entry of roundEntries(round,['before','after','restored'])) frames.append(imageCard(entry));
    card.append(frames,receiptsList(roundEntries(round,receiptFields)));
    if(round.decision) card.append(element('p','取舍 · '+(round.decision.choice==='keep'?'保留调整':'恢复原值')+' · '+round.decision.reason,'isp-decision'));
    const actions=element('div','','button-row');
    if(!round.decision&&!status.stop) {
      const decide=button('记录保留或恢复',()=>openDecision(round),'primary');decide.disabled=busy;actions.append(decide);
    }
    const before=previews.get(`${number}:before`)?.file, after=previews.get(`${number}:after`)?.file;
    if(before&&after) actions.append(button('送入盲选对照',()=>pick([before,after],round.gammaReadback),'plain'));
    if(actions.childElementCount) card.append(actions);
    return card;
  }
  function render() {
    const badge=$('isp-status'),help=$('isp-help'),summary=$('isp-detail'),actions=$('isp-actions');
    const busy=posting||Boolean(status?.running);
    const rounds=status?.rounds??[];
    const done=rounds.filter(round=>round.decision).length;
    badge.textContent=busy?'进行中':status?.error?'需要处理':`${done} / 2 轮已验收`;
    badge.className='status-tag'+(status?.error?' blocked':done===2?' ok':'');
    help.textContent=status?.error?explain(status.error):busy?(stageText[status?.stage]??'等待相机回执'):
      !binding?'先关联本工位相机实验。':status?.stop?'原值已恢复，采流已停止。':
        !status?.original?'先保存期初 ISP。两轮都留实拍、回读和自己的判断。':
        rounds.at(-1)&&!rounds.at(-1).decision?'核对本轮实拍和独立回读，再选择保留或恢复。':
        done===1&&status.changesActive?'第 1 轮取舍已留档。先恢复期初配置，再用同一基线做第 2 轮。':
        done===2?'两轮证据已保存。继续做盲选对照，或下载个人成果包。':'选择观察目标，开始当前轮。';
    summary.replaceChildren();actions.replaceChildren();
    const cards=element('div','','isp-rounds');
    for(const number of [1,2]) cards.append(roundCard(number,rounds.find(round=>round.number===number),done,busy));
    summary.append(cards);
    if(!binding) return;
    if(!status?.original) {
      const save=button('保存原始 ISP',()=>start({action:'save'}),'primary');save.disabled=busy;actions.append(save);return;
    }
    summary.append(receiptsList(sessionEntries(status,['original','readback','reloadReadback'])));
    if(status.reloaded) summary.append(imageCard({name:'reloaded',asset:status.reloaded}));
    if(status.stop) summary.append(element('p','停流回执 · '+status.stop.receiptId,'isp-decision'));
    if(status.comparisonIssue) summary.append(element('p','已独立回读原值，恢复后实拍仍待补。','capture-error'));
    if(!status.stop&&!status.changesActive&&!status.recoveryPending&&rounds.length===done&&done<2) {
      actions.append(button(done===0?'开始第 1 轮跟做':'开始第 2 轮自主',()=>openTrial(done+1),'primary'));
    }
    if(!status.stop) {
      if(status.recoveryPending||status.changesActive&&rounds.at(-1)?.decision) {
        actions.append(button(done===1?'恢复原值，准备第 2 轮':'恢复原值，继续采流',()=>confirm('revert'),'ghost'));
      } else if(done===2&&status.restored&&status.gammaReadback) {
        actions.append(button('重载第 2 轮候选',()=>openDialog('重载第 2 轮候选',[
          element('p','独立核对这份候选，再保存一张重载后的新图。'),
        ],()=>start({action:'reload'}),'重载并回读'),'ghost'));
      }
      actions.append(button('课后恢复并停流',()=>confirm('restore'),'plain'));
    }
    if(busy) for(const control of actions.querySelectorAll('button')) control.disabled=true;
  }
  function syncBinding() {
    const id=getBinding()?.experimentId??null;
    if(id===binding) return;
    binding=id;bindingRevision++;apply(undefined);render();void poll();
  }
  async function evidence() {
    const receipt=status;
    if(!receipt?.original) return;
    const revision=bindingRevision;
    const isCurrent=()=>bindingRevision===revision&&binding===receipt.experimentId&&status===receipt;
    const files=await Promise.all(artifacts(receipt).map(entry=>images.has(entry.name)?readImage(entry,isCurrent):readFile(entry)));
    if(!isCurrent()) throw new Error(evidenceChanged);
    return {receipt,files};
  }
  return {syncBinding,poll,evidence};
}
