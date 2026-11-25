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
  { name:'vision_course_view',description:'启动本机可视化工作台并返回访问地址。Studio 面板需要单独打开。传入保存的 resume 可继续之前的进度。',inputSchema:guideSchema,annotations:readOnly },
  { name:'vision_course_sync',description:'同步当前 Studio 工作台。空参数读取最新进度；有 patch 时把本轮真实工具回执转交给学员界面。本工具只更新工位记录。',inputSchema:{type:'object',properties:{patch:guideSchema,clearBlockers:{type:'array',items:{type:'string'}}},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false} },
  { name:'vision_course_camera',description:'在当前已关联的相机实验里拍照、采集 RAW/ISP/渲染三图或重试渲染。用于「帮我拍张照」「采集基线图」。拍摄异步执行，调用回执仅表示开始。照片、三图和原件下载在返回的工作台，可通过只读 vision_course_camera_status 查询验收状态。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['photo','baseline','retake','render']},scene:{type:'string',minLength:1,maxLength:100}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false} },
  { name:'vision_course_camera_status',description:'查询当前工位的相机实验关联、最近一次预检、已归档照片和三图进度。用户要在 Studio 聊天看本轮照片时，传入拍照回执中的 photoRequestId。photoPreview 为 ready 时 Studio 直接展示已归档照片，pending 时可稍后查询，capture_failed 时检查 capture.errors.photo。空参数只查状态。工位关联以 cameraBinding 为准，baselineRequested 为 false 时尚无三图采集记录。此工具不会重新探测或采集。',inputSchema:{type:'object',properties:{photoRequestId:{type:'string',pattern:'^[a-f0-9-]{36}$'}},additionalProperties:false},annotations:readOnly },
  { name:'vision_course_preflight',description:'检查工位相机服务、X5 板端连接、已开启相机流的实时帧。run:true 发起检查，空参数读取本轮状态。仅查询相机，不调参、不启动采流、不重启或烧录。',inputSchema:{type:'object',properties:{run:{type:'boolean'}},additionalProperties:false},annotations:readOnly },
  { name:'vision_course_isp',description:'课堂 Gamma 和单项 ISP。save 保存期初；gamma_prepare 按学员画面目标读取实拍并生成候选，不写板；用户要求执行时用 gamma_apply，并带上当前 candidateId；gamma_discard 可丢弃本轮候选；gamma 为已有客户端的一步试调；decision 记录 Gamma 取舍。learner_options 读取本工位可写项；learner_apply 只执行一个工位已解锁的 field，传本次真实回读 expected 和明确数值 value；可带 goal 和 reason，工作台会显示；learner_decision 按 trial 记录取舍。revert 恢复原值；restore 恢复并停流。异步受理后查询 vision_course_isp_status。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['save','gamma','gamma_prepare','gamma_apply','gamma_discard','decision','reload','revert','restore','learner_options','learner_apply','learner_decision']},goal:{type:'string',minLength:1,maxLength:180},round:{type:'integer',enum:[1,2]},choice:{type:'string',enum:['keep','restore']},reason:{type:'string',minLength:1,maxLength:180},field:{type:'string',pattern:'^[a-zA-Z]{1,40}$'},expected:{type:'number'},value:{type:'number'},trial:{type:'integer',minimum:1},candidateId:{type:'string',pattern:'^[a-f0-9-]{36}$'}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false} },
  { name:'vision_course_isp_status',description:'查询工位原始快照、单项实操、恢复、独立回读与停流进度。要在聊天显示调前调后实拍，按回执传一个 Gamma round 或单项 trial。ispPreview 为 ready 时已交付对照图。空参数只查状态。',inputSchema:{type:'object',properties:{round:{type:'integer',enum:[1,2]},trial:{type:'integer',minimum:1}},additionalProperties:false},annotations:readOnly },
  { name:'vision_course_detection_status',description:'在 Studio 聊天展示当前工位选定模型最近一张已校验的板端检测归档帧、类别和置信度。只读，不启动检测。持续预览使用返回的工作台地址。',inputSchema:emptySchema,annotations:readOnly },
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
      const current=await session.sync();
      const legacy=current.workbenchUi!==2;
      const nextStep=guideCourse(plan,current.resume).nextStep;
      return respond(content({url,...(legacy?{previousWorkbench:true}:{}),title:'视觉 Pipeline · 课堂工作台',scope:'this_computer',
        openInStudio:{url,target:'local'},nextStep,
        instruction:(legacy?'原工位仍运行旧界面。可继续原工位。需要新版界面时请先导出进度和成果，结束实验后重启电脑，再打开工作台。':'')+'请用 openInStudio 的原始参数调用 studio_open_url。工具不可用时给出可点击的 [打开课堂工作台] 链接。请按 nextStep 给出当前一个动作和验收条件。仅打开课堂时无需连接设备或启动采集。'}));
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
      if (Object.keys(args).some(key=>key!=='photoRequestId')||
          Object.hasOwn(args,'photoRequestId')&&(typeof args.photoRequestId!=='string'||!/^[a-f0-9-]{36}$/.test(args.photoRequestId))) {
        throw new Error('invalid_arguments');
      }
      return respond(content(await session.cameraStatus(args.photoRequestId)));
    }
    if (name==='vision_course_preflight') {
      if(Object.keys(args).some(k=>k!=='run')||args.run!==undefined&&typeof args.run!=='boolean') throw new Error('invalid_arguments');
      return respond(content(await session.preflight(args.run)));
    }
    if(name==='vision_course_isp') {
      if(!Object.hasOwn(args,'action')||Object.keys(args).some(k=>!['action','goal','round','choice','reason','field','expected','value','trial','candidateId'].includes(k))) throw new Error('invalid_arguments');
      return respond(content(await session.isp(args)));
    }
    if(name==='vision_course_isp_status') {
      const keys=Object.keys(args);
      if(keys.length>1||keys.some(key=>key!=='round'&&key!=='trial')||
          Object.hasOwn(args,'round')&&![1,2].includes(args.round)||
          Object.hasOwn(args,'trial')&&(!Number.isSafeInteger(args.trial)||args.trial<1)) throw new Error('invalid_arguments');
      return respond(content(await session.isp(undefined,keys.length?args:undefined)));
    }
    if(name==='vision_course_detection_status') {
      if(Object.keys(args).length) throw new Error('invalid_arguments');
      return respond(content(await session.detection()));
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
