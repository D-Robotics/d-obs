import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import express from 'express';
import { visionWorkshopJsonIngress } from './vision-workshop-json-ingress.js';
import { VISION_WORKSHOP_API, VISION_WORKSHOP_MCP } from './vision-workshop-operations.js';
test('SDK effect/MCP JSON is bounded independently while unrelated routes keep the 2 MiB budget',async()=>{
  const app=express();app.use(visionWorkshopJsonIngress());app.use(express.json({limit:'2mb'}));
  app.post('*',(req,res)=>res.json({bytes:Buffer.byteLength(req.body.payload??'')}));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.type}));
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
  try{
    const body=JSON.stringify({payload:'a'.repeat(3*1024*1024)});
    for(const route of [VISION_WORKSHOP_API+'/experiments/fixture/device/tuning_load',VISION_WORKSHOP_MCP]){
      const response=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(response.status,200);assert.equal((await response.json() as any).bytes,3*1024*1024);
    }
    for(const route of ['/unrelated',VISION_WORKSHOP_API+'/experiments/fixture/device/controls_set']){
      const response=await fetch(origin+route,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(response.status,413);
    }
    const oversized=await new Promise<number>((resolve,reject)=>{
      const req=request(origin+VISION_WORKSHOP_MCP,{method:'POST',headers:{'content-type':'application/json','content-length':String(25*1024*1024)}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('ingress_timeout')));req.end();
    });assert.equal(oversized,413);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
