import {createHash, randomBytes} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';

const issuer='https://sso.d-robotics.cc';
const oauth=issuer+'/api/userCenterApi/oauth/';
const resource='https://mcp.d-robotics.cc/api';
const endpoint=resource+'/dcloudAgentApi/robogo';
const scope='agent.read agent.run';
const timeout=15000;
const nonce=()=>randomBytes(32).toString('base64url');
const activeStates=new Map([
 ['submitted','submitted'],['pending','queued'],['queued','queued'],['scheduling','queued'],
 ['starting','queued'],['running','running'],['succeeded','completed'],['success','completed'],
 ['completed','completed'],['artifact_ready','completed'],['failed','failed'],['cancelled','failed'],['canceled','failed'],['stopped','failed'],
]);
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const runId=v=>['string','number'].includes(typeof v)&&/^[A-Za-z0-9._:-]{1,120}$/.test(String(v))?String(v):undefined;
const jobName=v=>typeof v==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(v)?v:undefined;
function nameFromReceipt(receipt) {
  try {
    const url=new URL(receipt);
    if(url.origin!=='https://robogo.d-robotics.cc'||url.username||url.password) return;
    return jobName(url.pathname.match(/^\/train-job\/detail\/([^/]+)\/?$/)?.[1]);
  } catch { return undefined; }
}
const privateField=/(?:secret|token|password|credential|cookie|api.?key|private.?key)/i;
function reviewParameters(input) {
  for(const [key,value] of Object.entries(input)) {
    if(privateField.test(key)) throw new Error('invalid_profile');
    if(key==='epochs'&&String(value)!=='100') throw new Error('invalid_profile');
    if(['imgsz','image_size','imageSize'].includes(key)&&String(value)!=='640') throw new Error('invalid_profile');
    if(value&&typeof value==='object') reviewParameters(value);
  }
  return input;
}

async function readJson(response) {
  const type=response.headers.get('content-type')??'';
  if (type.includes('application/json')) return response.json();
  if (!type.includes('text/event-stream')) throw new Error('robogo_response_invalid');
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer='';
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(done) throw new Error('robogo_response_invalid');
      buffer+=value.replace(/\r\n/g,'\n');
      if(buffer.length>1_000_000) throw new Error('robogo_response_invalid');
      let end;
      while((end=buffer.indexOf('\n\n'))>=0) {
        const event=buffer.slice(0,end);
        buffer=buffer.slice(end+2);
        const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        if(data) {
          const message=JSON.parse(data);
          if(message.id!==undefined) return message;
        }
      }
    }
  } finally { void reader.cancel().catch(()=>{}); }
}

export function createRoboGo(send=fetch) {
  let pending, client, tokens, expiresAt=0, session, protocol='2025-06-18', sequence=0;
  let refreshing, connecting;
  const request=(url,opts)=>send(url,{...opts,redirect:'error',signal:AbortSignal.timeout(timeout)});
  async function authorize(origin) {
    const redirectUri=origin+'/robogo/callback';
    if(!client) {
      const response=await request(oauth+'register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        client_name:'RDK Studio Vision Workshop',redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],
        response_types:['code'],token_endpoint_auth_method:'none',scope,
      })});
      if(!response.ok) throw new Error('robogo_oauth_registration_failed');
      client=(await response.json()).client_id;
      if(typeof client!=='string'||!client) throw new Error('robogo_oauth_registration_failed');
    }
    const verifier=nonce(), state=nonce();
    pending={verifier,state,redirectUri,expiresAt:Date.now()+10*60*1000};
    const url=new URL(oauth+'authorize');
    url.search=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:redirectUri,state,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope,resource});
    return {url:url.href};
  }
  async function exchange(parameters) {
    const response=await request(oauth+'token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({...parameters,client_id:client,resource})});
    if(response.status===400||response.status===401) {tokens=undefined;throw new Error('robogo_login_required');}
    if(!response.ok) throw new Error('robogo_unavailable');
    const grant=await response.json();
    if(typeof grant.access_token!=='string'||!grant.access_token) throw new Error('robogo_response_invalid');
    expiresAt=Date.now()+1000*(Number.isFinite(grant.expires_in)?grant.expires_in:300);
    tokens={access:grant.access_token,refresh:grant.refresh_token??tokens?.refresh};
    session=undefined;
  }
  async function callback(query) {
    const challenge=pending;
    if(!challenge||challenge.state!==query.get('state')||Date.now()>challenge.expiresAt||query.has('iss')&&query.get('iss')!==issuer) {
      throw new Error('robogo_oauth_state_invalid');
    }
    pending=undefined;
    const code=query.get('code');
    if(!code||query.has('error')) throw new Error('robogo_login_required');
    await exchange({grant_type:'authorization_code',code,code_verifier:challenge.verifier,redirect_uri:challenge.redirectUri});
  }
  async function credential() {
    if(tokens&&Date.now()<expiresAt-10000) return tokens.access;
    if(!tokens?.refresh) throw new Error('robogo_login_required');
    refreshing??=exchange({grant_type:'refresh_token',refresh_token:tokens.refresh}).finally(()=>{refreshing=undefined;});
    await refreshing;
    return tokens.access;
  }
  async function rpc(method,params,notification=false) {
    const id=++sequence;
    const headers={'Authorization':'Bearer '+await credential(),'Content-Type':'application/json',
      'Accept':'application/json, text/event-stream','MCP-Protocol-Version':protocol};
    if(session) headers['Mcp-Session-Id']=session;
    const response=await request(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
    if(response.status===401) {tokens=undefined;session=undefined;throw new Error('robogo_login_required');}
    if(!response.ok) throw new Error('robogo_unavailable');
    if(notification) return;
    const message=await readJson(response);
    if(message.id!==id||message.error||!plain(message.result)) throw new Error('robogo_response_invalid');
    return {result:message.result,sessionId:response.headers.get('mcp-session-id')};
  }
  async function connect() {
    const {result,sessionId}=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'rdk-vision-workshop',version:'0.7.0'}});
    session=sessionId??'';
    protocol=result.protocolVersion;
    await rpc('notifications/initialized',undefined,true);
  }
  async function call(name,args) {
    await credential();
    if(session===undefined) {
      connecting??=connect().finally(()=>{connecting=undefined;});
      await connecting;
    }
    const {result}=await rpc('tools/call',{name,arguments:args});
    if(result.isError) throw new Error('robogo_tool_rejected');
    let body=result.structuredContent;
    if(!body&&Array.isArray(result.content)) {
      const output=result.content.find(item=>item.type==='text');
      try {body=JSON.parse(output?.text);} catch {throw new Error('robogo_response_invalid');}
    }
    if(!plain(body)||body.ok===false||body.success===false) throw new Error('robogo_tool_rejected');
    // The live MCP separates UI-safe display data from the machine payload.
    // In particular, the immutable job ID is only present in payload.data.
    if(Object.hasOwn(body,'payload')) {
      if(!plain(body.payload)||body.payload.ok!==true) throw new Error('robogo_tool_rejected');
      return body.payload;
    }
    return body;
  }
  return {
    authorize,callback,connected:()=>Boolean(tokens),
    async refresh(id,{name,receipt}={}) {
      if(!runId(id)) throw new Error('robogo_run_id_invalid');
      let lookup=jobName(name)??nameFromReceipt(receipt);
      if(!lookup) {
        // Earlier workshop records kept only the ID. Match it exactly against
        // the current account's job list before asking for a job by name.
        const list=await call('training_jobs',{action:'list',input:{}});
        const jobs=list.data?.jobs;
        if(!Array.isArray(jobs)) throw new Error('robogo_response_invalid');
        lookup=jobName(jobs.find(job=>runId(job?.id??job?.job_id)===id)?.name);
      }
      if(!lookup) throw new Error('robogo_run_name_required');
      const result=await call('training_jobs',{action:'get',input:{name:lookup}});
      const run=normalizeTrainingJob(result,id);
      if(run.name!==lookup) throw new Error('robogo_run_receipt_invalid');
      return run;
    },
    async prepare(input) {
      const result=await call('training_jobs',{action:'prepare_create',input});
      const data=result.data??result.result??result;
      const plan=data.plan??data;
      if(typeof plan.plan_ref!=='string'||!plan.plan_ref||plan.plan_ref.length>2048) throw new Error('robogo_plan_invalid');
      return plan.plan_ref;
    },
    async submit(ref) {
      const result=await call('execute_plan',{plan_ref:ref});
      return normalizeTrainingJob(result,undefined,{defaultStatus:'submitted',receiptAction:'execute_plan'});
    },
  };
}

export function normalizeTrainingJob(result,expectedId,{defaultStatus,receiptAction='training_jobs.get'}={}) {
  const data=result.data??result.result??result;
  const job=data?.job??data?.training_job??data;
  const id=runId(job?.job_id??job?.id??job?.jobId);
  const name=jobName(job?.name);
  const status=job?.status??job?.state??defaultStatus;
  const state=typeof status==='string'?activeStates.get(status.toLowerCase()):undefined;
  if(!id||!state||expectedId!==undefined&&id!==expectedId) throw new Error('robogo_run_receipt_invalid');
  const files=Array.isArray(job.artifacts)?job.artifacts:Array.isArray(data.artifacts)?data.artifacts:[];
  const models=new Set();
  for(const file of files) {
    const hash=file?.sha256;
    const kind=file?.kind??file?.type;
    const linkedId=runId(file?.job_id??file?.run_id??file?.runId??id);
    const target=file?.architecture??file?.march??file?.target;
    const x5=typeof target==='string'&&['bayes-e','x5','rdk-x5'].includes(target.toLowerCase());
    const binary=typeof file?.name==='string'&&file.name.toLowerCase().endsWith('.bin');
    const modelType=kind==='x5_int8_model'||x5&&(kind==='int8_model'||binary&&file.quantization?.toLowerCase?.()==='int8');
    if(linkedId===id&&modelType&&typeof hash==='string'&&/^[a-f0-9]{64}$/i.test(hash)) models.add(hash.toLowerCase());
  }
  const modelSha256=state==='completed'&&models.size===1?[...models][0]:undefined;
  return {id,state,source:'robogo',receipt:'RoboGO MCP '+receiptAction+' · '+id+' · '+status,
    ...(name?{name}:{}),
    ...(modelSha256?{modelSha256}:{})};
}

export async function trainingProfile(filename=process.env.RDK_VISION_ROBOGO_TRAINING_PROFILE??
    join(homedir(),'.config','rdk-vision-workshop','training-profile.json')) {
  if(!filename||!isAbsolute(filename)) throw new Error('robogo_profile_required');
  let file;
  try {
    file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const info=await file.stat();
    if(!info.isFile()||info.size>65536||process.platform!=='win32'&&info.uid!==process.getuid()) throw new Error('invalid_profile');
    const bytes=await file.readFile();
    if(bytes.length>65536) throw new Error('large_profile');
    const data=JSON.parse(bytes);
    if(!plain(data.input)||!Object.keys(data.input).length) throw new Error('invalid_profile');
    return {input:reviewParameters(data.input)};
  } catch(error) {
    throw new Error(error.code==='ENOENT'?'robogo_profile_required':'robogo_profile_invalid');
  } finally {await file?.close();}
}
