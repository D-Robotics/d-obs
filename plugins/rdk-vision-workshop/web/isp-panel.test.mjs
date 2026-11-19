import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createIspPanel} from './isp-panel.mjs';

class Element {
  constructor(tag,text='',className) {
    this.tag=tag;
    this.textContent=text;
    this.className=className;
    this.children=[];
    this.attributes=new Map();
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  setAttribute(name,value) { this.attributes.set(name,value); }
  get childElementCount() { return this.children.length; }
  querySelectorAll(tag) {
    return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);
  }
  text() { return [this.textContent,...this.children.map(child=>child.text())].join(' '); }
}

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const image=bytes=>new Response(bytes,{headers:{'Content-Type':'image/png'}});
const archiveError=(code,status)=>Response.json({error:code},{status});

function station(experimentId,captureNames=['before','after']) {
  const original=Buffer.from(JSON.stringify({experimentId,gamma:'fixture baseline'}));
  const captures=Object.fromEntries(captureNames.map((name,index)=>{
    const bytes=Buffer.from(experimentId+'-'+name);
    return [name,{bytes,sha256:hash(bytes),sdkTimestampNs:String(100+index)}];
  }));
  const round={number:1};
  for(const [name,{sha256,sdkTimestampNs}] of Object.entries(captures)) round[name]={sha256,sdkTimestampNs};
  return {original,captures,isp:{experimentId,original:{hash:hash(original)},rounds:[round]}};
}

function setup(t,onRead,onStatus=current=>Response.json({isp:current.isp})) {
  const dom=new Map(['isp-status','isp-help','isp-detail','isp-actions'].map(id=>[id,new Element('div')]));
  const experiments=new Map(['first','second'].map(id=>[id,station(id)]));
  const requests=[];
  let binding='first';
  t.mock.method(globalThis,'fetch',async path=>{
    const params=new URL(path,'http://127.0.0.1').searchParams;
    const name=params.get('file');
    const current=experiments.get(binding);
    if(!name) return onStatus(current);
    if(name==='original') {
      assert.equal(params.get('sha256'),current.isp.original.hash);
      return new Response(current.original,{headers:{'Content-Type':'application/json'}});
    }
    const capture=current.captures[name];
    assert.equal(params.get('round'),'1');
    assert.equal(params.get('sha256'),capture.sha256);
    requests.push([binding,name]);
    return onRead({name,capture});
  });
  const panel=createIspPanel({key:'fixture',$:id=>dom.get(id),element:(...args)=>new Element(...args),
    button:(label,click,style)=>{
      const control=new Element('button',label,style);
      control.click=click;
      return control;
    },
    getBinding:()=>({experimentId:binding}),
  });
  return {panel,detail:dom.get('isp-detail'),experiments,requests,
    bind:id=>{ binding=id;panel.syncBinding(); },
  };
}

test('preview retries transport and archive errors while serializing full frame reads and retaining evidence bytes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const after=Promise.withResolvers();
  let beforeAttempts=0;
  const {panel,detail,requests,experiments}=setup(t,async({name,capture})=>{
    if(name==='after') {
      return {ok:true,blob:async()=>{
        await after.promise;
        return image(capture.bytes).blob();
      }};
    }
    beforeAttempts++;
    if(beforeAttempts===1) throw new TypeError('Failed to fetch');
    if(beforeAttempts===2) return archiveError('camera_isp_evidence_unavailable',422);
    return image(capture.bytes);
  });
  panel.syncBinding();
  await turn();
  assert.match(detail.text(),/正在重试读取相机原件/);
  assert.doesNotMatch(detail.text(),/Failed to fetch/);
  t.mock.timers.tick(300);
  await turn();
  assert.deepEqual(requests,[['first','before'],['first','after']]);
  after.resolve();
  await turn();
  assert.equal(beforeAttempts,2);
  t.mock.timers.tick(900);
  await turn();
  assert.equal(beforeAttempts,3);
  assert.equal(detail.querySelectorAll('img').length,2);
  const {files}=await panel.evidence();
  const captures=experiments.get('first').captures;
  assert.deepEqual(files.map(file=>file.name),['工位-原始ISP.json','Gamma-第1轮-调前实拍.png','Gamma-第1轮-调后实拍.png']);
  assert.equal(hash(Buffer.from(await files[1].arrayBuffer())),captures.before.sha256);
  assert.equal(hash(Buffer.from(await files[2].arrayBuffer())),captures.after.sha256);
  assert.equal(requests.length,4);
});

test('a failed preview has a local retry and polling does not restart exhausted or permanent errors',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let beforeAttempts=0,afterAttempts=0;
  const {panel,detail}=setup(t,({name,capture})=>{
    if(name==='after') {
      afterAttempts++;
      return archiveError('camera_archive_missing',404);
    }
    if(++beforeAttempts<=3) throw new TypeError('Failed to fetch');
    return image(capture.bytes);
  });
  panel.syncBinding();
  await turn();
  for(const delay of [300,900]) {
    t.mock.timers.tick(delay);
    await turn();
  }
  assert.equal(beforeAttempts,3);
  assert.equal(afterAttempts,1);
  await panel.poll();
  await turn();
  assert.equal(beforeAttempts,3);
  assert.equal(afterAttempts,1);
  assert.match(detail.text(),/暂时无法打开实拍预览/);
  assert.doesNotMatch(detail.text(),/Failed to fetch/);
  const retryBefore=detail.querySelectorAll('button').find(control=>control.attributes.get('aria-label')==='重试调前实拍预览');
  assert.ok(retryBefore);
  retryBefore.click();
  retryBefore.click();
  await turn();
  assert.equal(beforeAttempts,4);
  assert.equal(afterAttempts,1);
  assert.equal(detail.querySelectorAll('img').length,1);
  assert.ok(detail.querySelectorAll('button').some(control=>control.attributes.get('aria-label')==='重试调后实拍预览'));
});

test('switching experiments ignores late frames and skips archived reads still queued for the old experiment',async t=>{
  const first=Promise.withResolvers();
  const {panel,detail,bind,requests,experiments}=setup(t,({capture})=>{
    if(capture.bytes.toString()==='first-before') {
      return {ok:true,blob:async()=>{
        await first.promise;
        return image(capture.bytes).blob();
      }};
    }
    return image(capture.bytes);
  });
  panel.syncBinding();
  await turn();
  assert.deepEqual(requests,[['first','before']]);
  const oldExport=assert.rejects(panel.evidence(),/ISP 工位记录已更新/);
  bind('second');
  await turn();
  first.resolve();
  await oldExport;
  await turn();
  assert.deepEqual(requests,[['first','before'],['second','before'],['second','after']]);
  assert.equal(detail.querySelectorAll('img').length,2);
  const {receipt,files}=await panel.evidence();
  assert.equal(receipt.experimentId,'second');
  const captures=experiments.get('second').captures;
  assert.equal(hash(Buffer.from(await files[1].arrayBuffer())),captures.before.sha256);
  assert.equal(hash(Buffer.from(await files[2].arrayBuffer())),captures.after.sha256);
});


test('a status response for the previous experiment cannot start image reads after switching',async t=>{
  let secondPolls=0;
  const {panel,bind,requests,detail}=setup(t,({capture})=>image(capture.bytes),current=>{
    if(current.isp.experimentId==='second'&&++secondPolls===1) {
      return Response.json({isp:station('first').isp});
    }
    return Response.json({isp:current.isp});
  });
  panel.syncBinding();
  await turn();
  assert.equal(detail.querySelectorAll('img').length,2);
  bind('second');
  await turn();
  assert.equal(detail.querySelectorAll('img').length,0);
  assert.deepEqual(requests,[['first','before'],['first','after']]);
  await panel.poll();
  await turn();
  assert.equal(detail.querySelectorAll('img').length,2);
  assert.deepEqual(requests,[['first','before'],['first','after'],['second','before'],['second','after']]);
});
