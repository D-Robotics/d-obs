const demoRoot='/isp-demo/';
export async function renderIspDemo({$,element,button}) {
  const tabs=$('isp-demo-tabs'), panel=$('isp-demo-panel');
  try {
    const response=await fetch(demoRoot+'manifest.json');
    if(!response.ok) throw new Error();
    const {samples}=await response.json();
    const controls=samples.map(sample=>button(sample.title,()=>select(sample),'ghost'));
    tabs.replaceChildren(...controls);
    function select(sample) {
      for(const [index,control] of controls.entries()) {
        const selected=samples[index]===sample;
        control.setAttribute('aria-pressed',String(selected));
        control.className='button '+(selected?'primary':'ghost');
      }
      const grid=element('div','','comparison-images isp-demo-pair');
      for(const [stage,label] of [['before','调前'],['after','调后']]) {
        const data=sample[stage];
        const figure=element('figure','','comparison-frame');
        const img=element('img');img.src=demoRoot+data.image;img.alt=sample.title+' · '+label+'实拍';
        const caption=element('figcaption',label+'读值 · '+data.value);
        caption.append(element('small',data.field+' · 回读 '+data.readbackHash.slice(0,12),'isp-demo-receipt'));
        figure.append(img,caption);grid.append(figure);
      }
      const source=element('div',sample.device+' · '+sample.date+' · '+sample.source,'isp-demo-source');
      const detail=element('a','下载实拍与参数索引','button plain');
      detail.href=demoRoot+'manifest.json';detail.download='讲师-ISP实拍回读索引.json';
      panel.replaceChildren(element('p',sample.context,'action-copy'),grid,
        element('p',sample.observation,'isp-demo-observation'),source,detail);
    }
    select(samples[0]);
  } catch {panel.replaceChildren(element('p','演示素材加载失败，请重新打开课堂工作台。','capture-error'));}
}
