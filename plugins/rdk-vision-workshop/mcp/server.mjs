#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { plan, guideMarkdown, tuningHandoffMarkdown } from './course.mjs';
import { guideCourse, guideSchema } from './guide.mjs';
import { labels, steps, stepEntries } from './steps.mjs';
import { workbenchSession } from './workbench-session.mjs';

const plugin=JSON.parse(readFileSync(new URL('../plugin.json',import.meta.url),'utf8'));
const emptySchema={type:'object',properties:{},additionalProperties:false};
const stageIds=[...new Set([...plan.schedule,...plan.parallel].map(s=>s.id).concat(Object.keys(steps)))];
const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const tools=[
  { name:'vision_course_plan',description:'读取飞书 180 分钟课堂时间表、并行训练窗口与阶段要求。',inputSchema:emptySchema,annotations:readOnly },
  { name:'vision_course_stage',description:'查看当前阶段的操作和所需回执。',inputSchema:{type:'object',properties:{stageId:{type:'string',enum:stageIds}},required:['stageId'],additionalProperties:false},annotations:readOnly },
  { name:'vision_course_next',description:'按时钟、已有回执和 RoboGO Run 引导下一步，记录 A/B/C 完成路径。只读规划。',inputSchema:guideSchema,annotations:readOnly },
  { name:'vision_course_view',description:'在本机打开当前工位的可视化工作台。传入保存的 resume 可继续之前的进度。',inputSchema:guideSchema,annotations:readOnly },
  { name:'vision_course_sync',description:'同步当前 Studio 工作台。空参数读取最新进度；有 patch 时把本轮真实工具回执转交给学员界面。本工具只更新工位记录。',inputSchema:{type:'object',properties:{patch:guideSchema,clearBlockers:{type:'array',items:{type:'string'}}},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false} },
  { name:'vision_course_camera',description:'在当前已关联的相机实验里拍照、采集 RAW/ISP/渲染三图或重试渲染。用于「帮我拍张照」「采集基线图」。拍摄异步执行，调用回执仅表示开始。照片、三图和原件下载在返回的工作台，可通过只读 vision_course_camera_status 查询验收状态。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['photo','baseline','retake','render']},scene:{type:'string',minLength:1,maxLength:100}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false} },
  { name:'vision_course_camera_status',description:'查看刚才在课堂工位采集的照片或 RAW、ISP、重渲染三张基线。返回逐项进度、产物回执及并排展示的本机工作台地址，无需板端命令。',inputSchema:emptySchema,annotations:readOnly },
  { name:'vision_course_preflight',description:'检查工位相机服务、X5 板端连接、已开启相机流的实时帧。run:true 发起检查，空参数读取本轮状态。仅查询相机，不调参、不启动采流、不重启或烧录。',inputSchema:{type:'object',properties:{run:{type:'boolean'}},additionalProperties:false},annotations:readOnly },
  { name:'vision_course_isp',description:'两轮课堂 Gamma。save 保存期初配置；gamma 用 round（1 跟做，2 自主）和 goal 获取前后实拍及回读；decision 用 round、choice（keep 或 restore）和 reason 保存取舍；revert 恢复期初配置以继续第二轮；reload 重载候选并采新帧；restore 恢复并停流。异步受理后查询 vision_course_isp_status，写入和停流按用户授权执行。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['save','gamma','decision','reload','revert','restore']},goal:{type:'string',minLength:1,maxLength:180},round:{type:'integer',enum:[1,2]},choice:{type:'string',enum:['keep','restore']},reason:{type:'string',minLength:1,maxLength:180}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false} },
  { name:'vision_course_isp_status',description:'查询工位原始快照、恢复、独立回读与停流进度，返回回执 ID、哈希和工位页面链接。',inputSchema:emptySchema,annotations:readOnly },
];

const content=data=>({content:[{type:'text',text:JSON.stringify(data)}],isError:false});
const reply=(req,body)=>({jsonrpc:'2.0',id:req.id,...body});
const rpcError=(req,code,message)=>reply(req,{error:{code,message}});
const invalid=(req,error)=>reply(req,{result:{content:[{type:'text',text:JSON.stringify({error:error.message})}],isError:true}});

const session=workbenchSession(process.env.RDK_VISION_COURSE_SESSION_DIR);

export async function dispatch(req) {
  if (!req || req.jsonrpc!=='2.0' || typeof req.method!=='string') return rpcError(req??{},-32600,'Invalid request');
  if (req.id===undefined) return null;
  const respond=result=>reply(req,{result});
  try {
    if (req.method==='initialize') return respond({protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:plugin.name,version:plugin.version}});
    if (req.method==='ping') return respond({});
    if (req.method==='tools/list') return respond({tools});
    if (req.method!=='tools/call') return rpcError(req,-32601,'Method not found');
    const {name,arguments:args={}}=req.params??{};
    if (!args || typeof args!=='object'||Array.isArray(args)) throw new Error('invalid_arguments');
    if (name==='vision_course_plan') {
      if (Object.keys(args).length) throw new Error('invalid_arguments');
      return respond(content({...plan,guideMarkdown,tuningHandoffMarkdown}));
    }
    if (name==='vision_course_stage') {
      if (Object.keys(args).some(k=>k!=='stageId')) throw new Error('invalid_arguments');
      if (!stageIds.includes(args.stageId)) throw new Error('unknown_stage');
      const scheduled=[...plan.schedule,...plan.parallel].find(s=>s.id===args.stageId);
      const action=steps[args.stageId];
      return respond(content({schema:plan.schema,executionStatus:'planning_only',
        stage:{id:args.stageId,...scheduled,...action,...(stepEntries[args.stageId]?{entry:stepEntries[args.stageId]}:{}),
          requiredEvidence:(action?.fields??[]).map(key=>({key,label:labels[key]}))}}));
    }
    if (name==='vision_course_next') return respond(content(guideCourse(plan,args)));
    if (name==='vision_course_view') {
      guideCourse(plan,args);
      const url=await session.open();
      if (Object.keys(args).length) await session.sync({patch:args});
      return respond(content({url,title:'视觉 Pipeline · 课堂工作台',scope:'this_computer',
        instruction:'使用 Studio 网页入口打开此地址，也可在本机浏览器打开。结束对话后仍可回到同一工位。'}));
    }
    if (name==='vision_course_sync') {
      if (Object.keys(args).some(key=>!['patch','clearBlockers'].includes(key))) throw new Error('invalid_arguments');
      const body=Object.keys(args).length?{patch:args.patch??{},clearBlockers:args.clearBlockers}:undefined;
      const updated=await session.sync(body);
      return respond(content({...guideCourse(plan,updated.resume),revision:updated.revision}));
    }
    if (name==='vision_course_camera') {
      if (!Object.hasOwn(args,'action')||Object.keys(args).some(key=>!['action','scene'].includes(key))) throw new Error('invalid_arguments');
      return respond(content(await session.camera(args)));
    }
    if (name==='vision_course_camera_status') {
      if (Object.keys(args).length) throw new Error('invalid_arguments');
      return respond(content(await session.camera()));
    }
    if (name==='vision_course_preflight') {
      if(Object.keys(args).some(k=>k!=='run')||args.run!==undefined&&typeof args.run!=='boolean') throw new Error('invalid_arguments');
      return respond(content(await session.preflight(args.run)));
    }
    if(name==='vision_course_isp') {
      if(!Object.hasOwn(args,'action')||Object.keys(args).some(k=>!['action','goal'].includes(k))) throw new Error('invalid_arguments');
      return respond(content(await session.isp(args)));
    }
    if(name==='vision_course_isp_status') {
      if(Object.keys(args).length) throw new Error('invalid_arguments');
      return respond(content(await session.isp()));
    }
    throw new Error('unknown_tool');
  } catch(error) {
    return invalid(req,error);
  }
}

const entry=process.argv[1];
if (entry && existsSync(entry) && import.meta.url===pathToFileURL(realpathSync(entry)).href) {
  const rx=createInterface({input:process.stdin,crlfDelay:Infinity});
  rx.on('line',async line=>{
    let input;
    try { input=JSON.parse(line); } catch { process.stdout.write(JSON.stringify(rpcError({id:null},-32700,'Parse error'))+'\n'); return; }
    const result=await dispatch(input);
    if (result) process.stdout.write(JSON.stringify(result)+'\n');
  });
}
