const stageText={snapshot:'读取原始 ISP',saved:'原始 ISP 已保存',checking:'核对设备和当前配置',
  gamma_before:'采集调整前实拍',gamma_plan:'AI 正在分析调前画面并生成候选',gamma_proposed:'AI 候选已就绪，等你确认',gamma_apply:'应用有界 Gamma',
  gamma_verify:'独立回读并采集新图',gamma_saved:'实拍与回读齐备',gamma_reloaded:'已重载并采得新帧',
  exposure_manual:'切换到手动曝光',exposure_before:'读取手动曝光并拍摄调前图',exposure_apply:'缩短曝光时间',
  exposure_verify:'独立回读曝光并拍摄调后图',
  learner_ready:'已核对工位可写参数',learner_before:'采集调整前实拍',learner_apply:'写入所选单项参数',
  learner_verify:'独立回读并采集调后新图',learner_saved:'单项实验已取得回读',
  restore:'恢复期初 ISP',readback:'独立读取当前 ISP',stop:'停止采流',stopped:'原值已恢复，采流已停止',reverted:'已恢复期初 ISP'};
const errors={
  camera_credential_missing:'已找到相机连接配置，但缺少凭据文件。请在相机插件重新配置工位凭据，再刷新。',
  camera_archive_quota_full:'证据存储额度已满。请联系助教处理额度，再重试采集或生成候选。',
  camera_gamma_baseline_moved:'AI 提案后，工位期初回读已改变。候选已作废，本次没有写入。请先和助教核对是否有其他工作台在使用这台相机。',
  camera_gamma_proposal_changed:'本轮候选已更新。请查看当前方案后再应用。',
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
  camera_exposure_unavailable:'本工位缺少可验证的手动曝光、增益或传感器行周期。请核对相机适配器。',
  camera_exposure_no_room:'手动曝光已接近该模式的最短曝光时间。增加固定光照后重新布置演示场景。',
  camera_exposure_freshness_failed:'未取到与曝光回读匹配的新实拍，本次对照未验收。',
  camera_exposure_readback_mismatch:'曝光或其他 ISP 读值与计划不符，本次对照未验收。',
  camera_learner_control_unavailable:'这项参数当前不可写。重新读取工位权限后选择可写项。',
  camera_learner_control_changed:'工位范围或当前值已变化。重新读取参数后再试。',
  camera_learner_value_out_of_range:'候选超出工位范围或不符合步进。按界面给出的范围和步进填写。',
  camera_learner_value_unchanged:'候选量化后与当前值相同。请选择一个可区分的值。',
  camera_learner_readback_mismatch:'独立回读未证实只有所选参数变化。请先恢复期初 ISP。',
  camera_learner_freshness_failed:'未取得与调后回读匹配的新图。请先恢复期初 ISP。',
  camera_learner_trial_locked:'请先核对当前单项实验的实拍和回读。',
  vision_camera_control_unavailable:'此工位未确认该参数可写。请重新检查适配器和模式。',
  vision_camera_control_inactive:'当前参数由自动模式接管。请使用助教准备的手动工位。',
  vision_camera_control_out_of_range:'工位拒绝了这个值。先核对恢复，再检查参数范围和步进。',
  camera_isp_evidence_unavailable:'暂时读不到归档图。请核对工位相机服务。',
};
const explain=code=>errors[code]??'本工位操作未完成 · '+(code??'请刷新后重试');
const names={original:'原始ISP',beforeReadback:'调前ISP回读',gammaReadback:'Gamma参数回读',decisionReadback:'取舍确认回读',
  resetReadback:'下一轮前恢复回读',readback:'工位恢复回读',reloadReadback:'重载回读',
  before:'调前实拍',after:'调后实拍',restored:'恢复后实拍',reloaded:'重载实拍',
  afterReadback:'调后ISP回读',restorationReadback:'恢复期初ISP回读'};
const images=new Set(['before','after','restored','reloaded']);
const previewRetryDelays=[300,900];
const evidenceChanged='ISP 工位记录已更新，请重新下载成果包。';
const transportError=()=>Object.assign(new Error('暂时无法读取工位数据，请重试。'),{retryable:true});
const receiptFields=['beforeReadback','gammaReadback','decisionReadback','resetReadback'];
const roundFields=['before','after','restored',...receiptFields];
const exposureReceipts=['beforeReadback','afterReadback','restorationReadback'];
const exposureEntries=(exposure,fields)=>fields.filter(name=>exposure?.[name]).map(name=>({name,scope:'exposure',asset:exposure[name]}));
const learnerReceipts=['beforeReadback','afterReadback','decisionReadback','restorationReadback'];
const learnerEntries=(adjustment,fields)=>fields.filter(name=>adjustment[name]).map(name=>({
  name,scope:'learner',trial:adjustment.number,asset:adjustment[name],
}));
const roundEntries=(round,fields)=>fields.filter(name=>round[name]).map(name=>({name,round:round.number,asset:round[name]}));
const sessionEntries=(status,fields)=>fields.filter(name=>status?.[name]).map(name=>({name,asset:status[name]}));
const entryKey=({name,round,scope,trial})=>`${scope==='learner'?'learner-'+trial:scope??round??0}:${name}`;
const proposalEntry=proposal=>({name:'before',scope:'gamma-proposal',asset:proposal.before});
const artifacts=status=>[...sessionEntries(status,['original','readback','reloadReadback','reloaded']),
  ...(status?.rounds??[]).flatMap(round=>roundEntries(round,roundFields)),
  ...exposureEntries(status?.exposure,['before','after',...exposureReceipts]),
  ...(status?.adjustments??[]).flatMap(item=>learnerEntries(item,['before','after','restored',...learnerReceipts]))];

export function createIspPanel({key,$,element,button,openDialog,field,notify,getBinding,pick,compareFrames,onEvidenceChange,initialRound}) {
  let binding, status, posting=false, polling=false, bindingRevision=0;
  let imageReads=Promise.resolve(), focusedRound=false;
  const previews=new Map();
  const proofOpen=new Map();
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
  async function readFile({name,round,scope,trial,asset}) {
    const params=new URLSearchParams({file:name,sha256:asset.hash??asset.sha256});
    if(round) params.set('round',round);
    if(scope) params.set('scope',scope);
    if(trial) params.set('trial',trial);
    const response=await request('/camera/isp?'+params);
    let blob;
    try { blob=await response.blob(); }
    catch { throw transportError(); }
    const ext=images.has(name)?(blob.type==='image/png'?'.png':'.jpg'):'.json';
    const prefix=scope==='learner'?'单项ISP-第'+trial+'次-':scope==='exposure'?'讲师-曝光-':round?'Gamma-第'+round+'轮-':'工位-';
    return new File([blob],prefix+names[name]+ext,{type:blob.type});
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
    const entries=new Map([...artifacts(next),...(next?.gammaProposal?[proposalEntry(next.gammaProposal)]:[])].filter(entry=>images.has(entry.name)).map(entry=>[entryKey(entry),entry]));
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
    onEvidenceChange?.();
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
    const exposure=status?.exposure?.recoveryPending;
    openDialog(final?'恢复期初 ISP 并停流':'恢复期初 ISP，继续采流',[
      element('p',final?'恢复原始配置，独立回读一致后停止采流。':exposure?
        '恢复期初 ISP 并独立回读。已采集的曝光证据会留在工位。':
        '独立确认恢复原值，并采一张恢复后实拍。已记录的取舍会保留。'),
    ],()=>start({action}),final?'恢复并停流':'恢复原值');
  }
  function openTrial(number) {
    const guided=number===1;
    const goals=[['看清阴影中的文字，保留亮部细节','阴影中文字'],['区分暗部相邻区域，保持亮部稳定','暗部层次']];
    openDialog(guided?'第 1 轮 · 跟做':'第 2 轮 · 自主',[
      element('p','保持机位、光照和目标不变。只调整当前生效的 Gamma 曲线。'),
      guided?field('goal','选一个观察目标',{options:goals,value:goals[0][0]}):
        field('goal','写出你自己的观察目标',{max:180,placeholder:'例如让左侧暗部更清楚，同时保持右侧亮部细节'}),
    ],({goal})=>start({action:'gamma_prepare',round:number,goal}),'让 AI 先给方案');
  }
  function openDecision(round,choice,label) {
    openDialog(`第 ${round.number} 轮 · ${label}`,[
      element('p','先看调前、调后两张实拍和参数回读，再记录你看到的改善或代价。'),
      field('reason','写下理由',{max:180,placeholder:'例如阴影中文字更清楚，亮部仍有纹理'}),
    ],({reason})=>start({action:'decision',round:round.number,choice,reason}),'保存取舍并核对回读');
  }
  function imageCard(entry,value) {
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
    const caption=element('figcaption',names[name]+(value?' · '+value:''));
    caption.append(element('small','SDK '+entry.asset.sdkTimestampNs,'isp-demo-receipt'));
    card.append(caption);
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
  function disclosure(id,title,...contents) {
    const area=element('details','','proof-details');
    area.open=proofOpen.get(id)===true;
    area.ontoggle=()=>{ if(proofOpen.has(id)||area.open) proofOpen.set(id,area.open); };
    area.append(element('summary',title),...contents);
    return area;
  }
  function curvePlot(curve,preview=false) {
    const card=element('div','','curve-plot');
    const count=preview?'当前曲线和第 1 条候选曲线 · 候选尚未下发':curve.changed+' 个节点有变化'+(curve.rows>1?' · 显示变化最多的第 '+curve.row+' / '+curve.rows+' 条':'');
    card.append(element('strong',preview?'Gamma 候选曲线':'Gamma 曲线独立回读'),element('p',count,'action-copy'));
    const canvas=element('canvas');
    canvas.width=480;canvas.height=104;
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label',(preview?'当前和候选 Gamma 曲线。':'Gamma 调前和调后的 SDK 曲线。')+count+'。横轴为输入节点，纵轴为输出等级。');
    const context=canvas.getContext?.('2d');
    if(context) {
      context.strokeStyle='#dce5f2';
      for(const y of [8,52,96]) {
        context.beginPath();context.moveTo(8,y);context.lineTo(472,y);context.stroke();
      }
      for(const [nodes,color,pattern] of [[curve.before,'#526888',[6,4]],[curve.after,'#194fc2',[]]]) {
        context.beginPath();context.strokeStyle=color;context.lineWidth=3;context.setLineDash(pattern);
        for(const [index,value] of nodes.entries()) {
          const x=8+index*464/(nodes.length-1),y=96-value*88/1023;
          if(index===0) context.moveTo(x,y);
          else context.lineTo(x,y);
        }
        context.stroke();
      }
    }
    card.append(canvas,element('small',preview?'灰色虚线 · 当前　蓝色实线 · AI 候选':'灰色虚线 · 调前　蓝色实线 · 调后','curve-legend'));
    return card;
  }
  function compareButton(prefix,labels) {
    const sources=['before','after'].map(name=>previews.get(prefix+':'+name)?.url);
    if(!compareFrames||!sources.every(Boolean)) return;
    return button('放大同一区域',()=>compareFrames(sources.map((src,index)=>({src,label:labels[index]}))),'ghost');
  }
  function proposalReasons(model,reasons) {
    const box=element('div','','ai-isp-explanation');
    box.append(element('strong','AI 为什么这样调'));
    if(model) box.append(element('small','本轮模型 · '+model));
    if(!reasons?.length) box.append(element('p','这次模型回执未提供文字理由，请依据曲线和画面对照判断。','action-copy'));
    else for(const reason of reasons) box.append(element('p',reason,'action-copy'));
    return box;
  }
  function proposeCard(proposal,busy) {
    const box=element('div','','ai-isp-proposal');
    box.append(element('p','观察目标 · '+proposal.goal,'isp-decision'));
    const pair=element('div','','ai-isp-pair');
    pair.append(imageCard(proposalEntry(proposal)),proposalReasons(proposal.model,proposal.reasons));
    box.append(pair);
    if(proposal.beforeCurve?.length===64&&proposal.curve?.length===64) {
      box.append(curvePlot({before:proposal.beforeCurve,after:proposal.curve},true));
    }
    const bar=element('div','','button-row');
    const applyButton=button('应用本次候选并拍摄对照',()=>start({
      action:'gamma_apply',round:proposal.number,candidateId:proposal.candidateId,
    }),'primary');
    const discard=button('换个观察目标',()=>start({action:'gamma_discard'}),'plain');
    applyButton.disabled=discard.disabled=busy;
    bar.append(applyButton,discard);box.append(bar);
    return box;
  }
  function roundCard(number,round,done,busy) {
    const card=element('article','','isp-round');
    card.id='isp-gamma-round-'+number;
    const current=done===number-1;
    const head=element('div','','action-head');
    const proposal=status?.gammaProposal?.number===number?status.gammaProposal:undefined;
    const state=proposal?'AI 候选待应用':round?.decision?'已验收':round?'待记录取舍':current?'待实拍与回读':'等待上一轮';
    head.append(element('h3',number===1?'第 1 轮 · 跟做':'第 2 轮 · 自主'),element('span',state,'status-tag'+(round?.decision?' ok':'')));
    card.append(head);
    card.append(element('p',round?.goal??(number===1?'选一个观察目标，跟着完成一次有界调整。':'自己写目标，再验证同一场景的画面变化。'),'action-copy'));
    if(!round) {
      if(proposal) {card.append(proposeCard(proposal,busy));return card;}
      if(current&&status?.original&&!status.stop&&!status.changesActive&&!status.recoveryPending&&(status.rounds?.length??0)===number-1) {
        const launch=button(number===1?'开始第 1 轮跟做':'开始第 2 轮自主',()=>openTrial(number),'primary');
        launch.disabled=busy;card.append(launch);
      }
      return card;
    }
    const frames=element('div','','capture-cards isp-pair');
    for(const entry of roundEntries(round,['before','after'])) frames.append(imageCard(entry));
    const content=element('div');
    content.append(frames);
    if(round.model||round.modelReasons?.length) content.append(proposalReasons(round.model,round.modelReasons));
    const actions=element('div','','button-row');
    const before=previews.get(`${number}:before`)?.file, after=previews.get(`${number}:after`)?.file;
    if(!round.decision&&!status.stop) {
      for(const [choice,label] of [['keep','保留本次调整'],['restore','恢复原值']]) {
        const decide=button(label,()=>openDecision(round,choice,label),'ghost');
        decide.disabled=busy;actions.append(decide);
      }
    }
    const zoom=compareButton(number,['调前实拍','调后实拍']);
    if(zoom) actions.append(zoom);
    if(before&&after) actions.append(button('送入盲选对照',()=>pick([before,after],round.gammaReadback),'plain'));
    if(actions.childElementCount) content.append(actions);
    if(round.decision) content.append(element('p','取舍 · '+(round.decision.choice==='keep'?'保留调整':'恢复原值')+' · '+round.decision.reason,'isp-decision'));
    if(round.curveChange) content.append(curvePlot(round.curveChange));
    const receipts=roundEntries(round,receiptFields);
    const restored=roundEntries(round,['restored']).map(entry=>imageCard(entry));
    if(receipts.length||restored.length) content.append(disclosure('round'+number,
      round.gammaReadback?'已核对 SDK 回读 · 查看详情':'查看本轮证据',...restored,receiptsList(receipts)));
    card.append(number===1&&round.decision?disclosure('completed-1','查看第 1 轮实拍与取舍',content):content);
    return card;
  }
  function renderExposure(busy) {
    const panel=$('isp-live-exposure');
    const demo=status?.exposure;
    const active=status?.running==='exposure';
    const finished=Boolean(demo?.after&&demo?.restorationReadback&&!demo.error);
    const locked=status?.changesActive||status?.rounds?.some(round=>!round.decision);
    const head=element('div','','action-head');
    head.append(element('h3','现场曝光对照'),element('span',
      active?'进行中':demo?.recoveryPending?'待恢复':finished?'对照完成，原值已恢复':demo?.error?'未验收':'待开始',
      'status-tag'+(finished?' ok':demo?.recoveryPending?' blocked':'')));
    const hint=element('p',active?(stageText[status.stage]??'正在核对相机与期初配置'):
      demo?.recoveryPending?explain(status.error??'camera_isp_restore_unconfirmed'):
      demo?.error?explain(demo.error)+(demo.restorationReadback?' 已回读原值。':''):
      !binding?'关联本工位相机实验并开启采流。':status?.stop?'本工位采流已停止。':
      status?.recoveryPending?'先恢复期初 ISP。':locked?'先完成当前 Gamma 轮的取舍并恢复期初 ISP。':
      !status?.original?'先保存期初 ISP，再固定机位和光照。':
      finished?'对照同一目标的亮部细节和暗部可见度，核对两张图的增益与曝光回读。':
      '固定机位和光照。工作台用相同增益拍两张图，将曝光时间缩短约一半，随后恢复期初 ISP。',
      'action-copy');
    hint.setAttribute('role','status');
    panel.replaceChildren(head,hint);
    const frames=exposureEntries(demo,['before','after']);
    if(frames.length) {
      const pair=element('div','','capture-cards isp-pair');
      for(const entry of frames) {
        const us=entry.name==='before'?demo.beforeUs:demo.afterUs;
        pair.append(imageCard(entry,(us/1000).toFixed(3)+' ms · 模拟增益 '+demo.gain.toFixed(3)+'×'));
      }
      panel.append(pair);
      const zoom=compareButton('exposure',['调前实拍','调后实拍']);
      if(zoom) panel.append(zoom);
      panel.append(disclosure('exposure','查看曝光和恢复回执',receiptsList(exposureEntries(demo,exposureReceipts))));
    }
    if(!binding||status?.stop) return;
    const actions=element('div','','button-row');
    const recover=demo?.recoveryPending&&!active;
    if(recover) {
      const restore=button('恢复期初 ISP 并回读',()=>confirm('revert'),'primary');restore.disabled=busy;actions.append(restore);
    } else {
      const save= !status?.original;
      const launch=button(save?'保存期初 ISP':finished?'再做一次曝光对照':'拍摄曝光对照',
        ()=>start({action:save?'save':'exposure'}),'primary');
      launch.disabled=Boolean(busy||locked||status?.recoveryPending);actions.append(launch);
    }
    panel.append(actions);
  }
  const observation={
    曝光:'观察亮部层次和暗部可见度。',
    增益:'观察暗部亮度，同时检查颗粒是否增加。',
    对比度:'观察明暗是否更分明，同时检查两端细节。',
    锐度:'放大同一条边缘，检查笔画和光晕。',
    白平衡:'观察中性白或灰是否偏色。',
  };
  const inactive={manual_mode:'自动模式下锁定。请使用助教准备的手动工位。',
    read_only:'工位回读为只读或资格未确认。',snapshot_mismatch:'当前值无法与完整 ISP 快照对应。',
    native_service_missing:'当前相机服务尚未提供单项锐度写入。'};
  const numeric=(value,unit)=>Number(value.toPrecision(9))+(unit?' '+unit:'');
  function openLearnerTrial(option) {
    const {id,label,group,value,min,max,step,linePeriod,unit}=option;
    const inputField=field('value','本轮候选值',{type:'number',value});
    const input=inputField.querySelector('input');
    input.min=min;input.max=max;input.step=step??'any';
    openDialog('试调'+label,[
      element('p','当前 '+numeric(value,unit)+' · 可用范围 '+numeric(min,unit)+' 至 '+numeric(max,unit)+
        (linePeriod?' · 按相机行周期对齐':step?' · 步进 '+numeric(step,unit):'')),
      element('p','固定机位和光照。'+observation[group]),
      inputField,
    ],({value:candidate})=>start({action:'learner_apply',field:id,expected:value,value:Number(candidate)}),'采集调前图并应用');
  }
  function learnerResult(adjustment,busy,canDecide) {
    const card=element('article','','isp-round learner-result');
    const title=element('div','','action-head');
    title.append(element('h3','第 '+adjustment.number+' 次 · '+adjustment.label),
      element('span',adjustment.decision?(adjustment.decision.choice==='keep'?'已记录保留':'已记录恢复'):
        adjustment.restorationReadback?'已核对恢复':adjustment.after?'待取舍':'采集或验证未完成','status-tag'));
    card.append(title);
    const comparison=element('div','','comparison-images isp-pair');
    for(const entry of learnerEntries(adjustment,['before','after'])) comparison.append(imageCard(entry,
      numeric(entry.name==='before'?adjustment.beforeValue:adjustment.afterValue,adjustment.unit)));
    if(comparison.childElementCount) card.append(comparison);
    if(adjustment.afterReadback) card.append(element('p','请求 '+numeric(adjustment.requested,adjustment.unit)+
      ' · 独立回读 '+numeric(adjustment.beforeValue,adjustment.unit)+' → '+numeric(adjustment.afterValue,adjustment.unit),'isp-decision'));
    const receipts=learnerEntries(adjustment,learnerReceipts);
    if(receipts.length) card.append(disclosure('learner-'+adjustment.number,'查看独立回读与哈希',receiptsList(receipts)));
    if(adjustment.goal) card.append(element('p','观察目标 · '+adjustment.goal,'isp-decision'));
    if(adjustment.reason) card.append(element('p','试调理由 · '+adjustment.reason,'action-copy'));
    if(adjustment.restored) card.append(disclosure('learner-restored-'+adjustment.number,'查看恢复后实拍',
      imageCard({name:'restored',scope:'learner',trial:adjustment.number,asset:adjustment.restored})));
    if(adjustment.decision) card.append(element('p','取舍理由 · '+adjustment.decision.reason,'isp-decision'));
    const actions=element('div','','button-row');
    const zoom=compareButton('learner-'+adjustment.number,['调前实拍','调后实拍']);
    if(zoom) actions.append(zoom);
    if(canDecide) {
      for(const [choice,label] of [['keep','保留本次参数'],['restore','恢复期初 ISP']]) {
        const control=button(label,()=>openDialog('单项实验 · '+label,[
          element('p','比对同一区域，确认独立回读，再写下观察和取舍。'),
          field('reason','理由',{max:180,placeholder:'目标区域有什么变化？是否出现副作用？'}),
        ],({reason})=>start({action:'learner_decision',trial:adjustment.number,choice,reason}),'保存取舍并核对回读'),'ghost');
        control.disabled=busy;actions.append(control);
      }
    }
    if(actions.childElementCount) card.append(actions);
    return card;
  }
  function renderLearner(busy) {
    const container=$('isp-learner-content');
    container.replaceChildren();
    const progress=element('ol','','learner-steps');
    for(const step of ['读取工位可写项','选一个参数','对照实拍与回读','记录保留或恢复']) progress.append(element('li',step));
    container.append(progress);
    const help=element('p',!binding?'先关联本工位相机实验。':!status?.original?'先保存上方的期初 ISP，再读取可写参数。':
      status.stop?'本工位已停流，可以查看已保存的单项证据。':
      status.recoveryPending?'先恢复期初 ISP，再开启下一次实验。':
      status.changesActive?'完成当前取舍。若已保留，开始下一项前请恢复期初 ISP。':
      '每次只写一个数值。实际可选范围来自工位，软件支持的项目需在本工位取得实拍与回读。','action-copy');
    container.append(help);
    const assistant=element('details','','ai-isp-explanation');
    assistant.append(element('summary','在 Studio 对话里调参'),
      element('p','你可以先说观察目标，也可以指定一个参数和数值。助手会先读取工位可写项，再执行一个符合范围的调整。','action-copy'));
    for(const text of [
      '阴影里的字看不清，先用本工位的实拍给我一个 Gamma 方案。我看完再决定是否应用。',
      '移动字卡拖影太长。先查本工位的曝光时间和可写范围，并建议一个新值。等我确认后只调曝光，留前后实拍和回读。',
    ]) assistant.append(element('p',text,'ai-isp-example'));
    container.append(assistant);
    if(status?.original&&!status.stop) {
      const actions=element('div','','button-row');
      const refresh=button('读取本工位可写参数',()=>start({action:'learner_options'}),'plain');
      refresh.disabled=Boolean(busy||status.recoveryPending||status.changesActive);
      actions.append(refresh);container.append(actions);
    }
    if(status?.learnerOptions) {
      const list=element('div','','learner-options');
      for(const [group,observe] of Object.entries(observation)) {
        const options=status.learnerOptions.filter(item=>item.group===group);
        const section=element('div','','learner-option');
        section.append(element('h4',group),element('p',observe,'action-copy'));
        if(!options.length) section.append(element('p','工位未返回可核对的数值范围。','action-copy'));
        for(const option of options) {
          const row=element('div','','learner-field');
          row.append(element('strong',option.label),element('small',option.disabled?inactive[option.disabled]:
            '当前 '+numeric(option.value,option.unit)+' · '+numeric(option.min,option.unit)+' 至 '+numeric(option.max,option.unit)));
          if(!option.disabled) {
            const adjust=button('试调'+option.label,()=>openLearnerTrial(option),'plain');
            adjust.disabled=Boolean(busy||status.recoveryPending||status.changesActive);
            row.append(adjust);
          }
          section.append(row);
        }
        list.append(section);
      }
      container.append(list);
    }
    const records=status?.adjustments??[];
    for(const adjustment of [...records].reverse()) {
      const active=status.activeAdjustment===adjustment.number;
      container.append(learnerResult(adjustment,busy,Boolean(active&&adjustment.after&&
        !adjustment.decision&&!status.recoveryPending&&!status.stop)));
    }
  }
  function render() {
    const badge=$('isp-status'),help=$('isp-help'),summary=$('isp-detail'),actions=$('isp-actions');
    const busy=posting||Boolean(status?.running);
    renderExposure(busy);
    renderLearner(busy);
    const rounds=status?.rounds??[];
    const done=rounds.filter(round=>round.decision).length;
    badge.textContent=busy?'进行中':status?.error?'需要处理':`${done} / 2 轮已验收`;
    badge.className='status-tag'+(status?.error?' blocked':done===2?' ok':'');
    help.textContent=status?.error?explain(status.error):busy?(stageText[status?.stage]??'等待相机回执'):
      !binding?'先关联本工位相机实验。':status?.stop?'原值已恢复，采流已停止。':
        !status?.original?'先保存期初 ISP。两轮都留实拍、回读和自己的判断。':
        rounds.at(-1)&&!rounds.at(-1).decision?'核对本轮实拍和独立回读，再选择保留或恢复。':
        done===1&&status.changesActive?'第 1 轮取舍已留档。先恢复期初配置，再用同一基线做第 2 轮。':
        status?.gammaProposal?'查看 AI 理由和候选曲线，确认后采一组实际对照。':
        done===2?'两轮证据已保存。继续做盲选对照，或下载个人成果包。':'选择观察目标，开始当前轮。';
    summary.replaceChildren();actions.replaceChildren();
    const cards=element('div','','isp-rounds');
    for(const number of [1,2]) cards.append(roundCard(number,rounds.find(round=>round.number===number),done,busy));
    summary.append(cards);
    if(!focusedRound&&(status?.gammaProposal?.number===initialRound||rounds.some(round=>round.number===initialRound))) {
      focusedRound=true;
      requestAnimationFrame(()=>$('isp-gamma-round-'+initialRound)?.scrollIntoView({block:'start'}));
    }
    if(!binding) return;
    if(!status?.original) {
      const save=button('保存原始 ISP',()=>start({action:'save'}),'primary');save.disabled=busy;actions.append(save);return;
    }
    summary.append(disclosure('session','查看期初 ISP 与工位回执',receiptsList(sessionEntries(status,['original','readback','reloadReadback']))));
    if(status.reloaded) summary.append(imageCard({name:'reloaded',asset:status.reloaded}));
    if(status.stop) summary.append(element('p','停流回执 · '+status.stop.receiptId,'isp-decision'));
    if(status.comparisonIssue) summary.append(element('p','已独立回读原值，恢复后实拍仍待补。','capture-error'));
    if(!status.stop) {
      if(status.recoveryPending||status.changesActive&&(status.activeAdjustment
        ?status.adjustments?.some(item=>item.number===status.activeAdjustment&&item.decision):rounds.at(-1)?.decision)) {
        actions.append(button(done===1&&!status.activeAdjustment?'恢复原值，准备第 2 轮':'恢复原值，继续采流',()=>confirm('revert'),'primary'));
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
    binding=id;bindingRevision++;proofOpen.clear();apply(undefined);render();void poll();
  }
  function evidenceIndex() {
    const rounds=(status?.rounds??[]).filter(round=>round.before&&round.after&&round.beforeReadback&&round.gammaReadback&&round.decision);
    return {rounds:rounds.length,restored:Boolean(status?.stop&&status.readback?.hash===status.original?.hash)};
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
  return {syncBinding,poll,evidence,evidenceIndex};
}
