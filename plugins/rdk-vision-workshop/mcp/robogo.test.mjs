import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoboGo,normalizeTrainingJob} from './robogo.mjs';

test('official OAuth and MCP contract keeps credentials private and tracks the same Run',async()=>{
  const actions=[];
  const actual={id:'fixture-run',name:'fixture-job'};
  const detail='https://robogo.d-robotics.cc/train-job/detail/fixture-job';
  let returnedId=actual.id;
  const live=createRoboGo(async(url,opts)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/register')) {
      const data=JSON.parse(opts.body);
      assert.deepEqual(data.redirect_uris,['http://127.0.0.1:19080/robogo/callback']);
      assert.equal(data.token_endpoint_auth_method,'none');
      return Response.json({client_id:'fixture-client'});
    }
    if(path.endsWith('/token')) {
      assert.equal(opts.body.get('code'),'fixture-code');
      assert.ok(opts.body.get('code_verifier').length>=43);
      return Response.json({access_token:'fixture-access-token',expires_in:300});
    }
    assert.equal(opts.headers.Authorization,'Bearer fixture-access-token');
    const msg=JSON.parse(opts.body);
    if(msg.method==='initialize') return Response.json({id:msg.id,result:{protocolVersion:'2025-06-18'}});
    if(msg.method==='notifications/initialized') return new Response(null,{status:202});
    const {name,arguments:args}=msg.params;
    actions.push([name,args]);
    const data=args.action==='prepare_create'?{plan_ref:'fixture-plan'}:args.action==='list'?{jobs:[actual]}:
      {name:actual.name,id:returnedId,status:args.action==='get'?'Running':'Submitted'};
    const structuredContent={display:{ok:true,data:{name:actual.name}},payload:{ok:true,data}};
    return new Response('event: message\ndata: '+JSON.stringify({id:msg.id,result:{structuredContent}})+'\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
  });
  assert.equal(live.connected(),false);
  await assert.rejects(live.refresh('fixture-run'),/robogo_login_required/);
  const auth=new URL((await live.authorize('http://127.0.0.1:19080')).url);
  assert.equal(auth.origin,'https://sso.d-robotics.cc');
  assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  await assert.rejects(live.callback(new URLSearchParams({state:'bad',code:'fixture-code'})),/robogo_oauth_state_invalid/);
  await live.callback(new URLSearchParams({state:auth.searchParams.get('state'),code:'fixture-code'}));
  const ref=await live.prepare({job_name:'fixture'});
  assert.equal((await live.submit(ref)).id,'fixture-run');
  const refreshed=await live.refresh('fixture-run',{receipt:detail});
  assert.equal(refreshed.state,'running');
  assert.equal(refreshed.source,'robogo');
  assert.equal(refreshed.name,actual.name);
  assert.ok(!JSON.stringify(refreshed).includes('fixture-access-token'));
  assert.deepEqual(actions,[
    ['training_jobs',{action:'prepare_create',input:{job_name:'fixture'}}],
    ['execute_plan',{plan_ref:'fixture-plan'}],
    ['training_jobs',{action:'get',input:{name:actual.name}}],
  ]);
  assert.equal((await live.refresh(actual.id)).id,actual.id);
  assert.deepEqual(actions.at(-2),['training_jobs',{action:'list',input:{}}]);
  await assert.rejects(live.refresh('another-run',{receipt:detail}),/robogo_run_receipt_invalid/);
  returnedId='unrelated-job';
  await assert.rejects(live.refresh(actual.id,{name:actual.name}),/robogo_run_receipt_invalid/);
  assert.throws(()=>normalizeTrainingJob({job_id:'fixture-run',status:'unrecognized'}),/robogo_run_receipt_invalid/);
});
