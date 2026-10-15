/** Bounded SDK-effect JSON ingress, installed before the global 2 MiB parser. */
import express, { type RequestHandler } from 'express';
import { VISION_WORKSHOP_API, VISION_WORKSHOP_MCP } from './vision-workshop-operations.js';
const effectRoute=new RegExp('^'+VISION_WORKSHOP_API.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/experiments/[^/]{1,100}/device/tuning_load$');
const MAX_BYTES=24*1024*1024;
export function visionWorkshopJsonIngress(): RequestHandler {
  const parser=express.json({limit:MAX_BYTES});
  return (req,res,next)=>{
    const route=req.url.split('?')[0];
    if(req.method!=='POST' || !(route===VISION_WORKSHOP_MCP || effectRoute.test(route))) { next(); return; }
    if(Number(req.headers['content-length'])>MAX_BYTES){
      res.set('Connection','close').set('Cache-Control','no-store').status(413).json({ok:false,error:'vision_request_limit'});return;
    }
    parser(req,res,next);
  };
}
