/** Existing drivers keep their ownership, limits and configured connection identities. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getConfiguredSshLogCollector } from './ssh-log-routes.js';
import { getConfiguredRdkLogCaptureService } from './rdk-log-routes.js';
import { getConfiguredDataCenterService } from './data-center-routes.js';
import type { SshLogCollector } from './ssh-log-collector.js';
import type { RdkLogCaptureService } from './rdk-log-capture.js';
import { CollectionWorkspaceError, type CollectionWorkspaceDriver, type CollectionArchive } from './collection-workspace-service.js';

const id = z.string().min(1).max(64).regex(/^[a-zA-Z0-9._:-]+$/);
const sshConfig = z.object({ targetId: id, sourceId: id, lines: z.number().int().min(0).max(10000).default(200), durationSeconds: z.number().int().min(5).max(1800).default(300), follow: z.boolean().default(true) }).strict();
const rdkConfig = z.object({ targetId: id, profileId: z.enum(['runtime','x5-isp']).default('runtime'), sourceIds: z.array(id).min(1).max(3).optional(), question: z.string().max(2000).default(''), lines: z.number().int().min(0).max(10000).default(200), durationSeconds: z.number().int().min(5).max(1800).default(300) }).strict();
export function createCollectionDrivers(options: { ssh?: () => SshLogCollector; rdk?: () => RdkLogCaptureService } = {}): CollectionWorkspaceDriver[] {
  const ssh = options.ssh ?? getConfiguredSshLogCollector; const rdk = options.rdk ?? getConfiguredRdkLogCaptureService;
  const targets = () => ssh().listTargets().map(target => ({ id: target.id, label: target.label, sources: target.sources.map(source => ({ id: source.id, label: source.label, type: source.type })) }));
  const targetField = () => ({ key:'targetId', label:'采集目标', type:'select', required:true, options:targets().map(t => ({ value:t.id,label:t.label })) });
  const bounds = [{ key:'lines',label:'历史行数',type:'number',min:0,max:10000,default:200 },{ key:'durationSeconds',label:'采集时长（秒）',type:'number',min:5,max:1800,default:300 }];
  function validateTarget(targetId: string, sourceIds: string[]) {
    const target = targets().find(t => t.id === targetId);
    if (!target) throw new CollectionWorkspaceError('collection_target_not_configured',404);
    if (sourceIds.some(sourceId => !target.sources.some(s => s.id === sourceId)) || new Set(sourceIds).size !== sourceIds.length) throw new CollectionWorkspaceError('collection_source_not_configured',400);
  }
  return [{
    moduleId:'ssh-logs',version:'1.0.0',
    describe:() => ({ moduleId:'ssh-logs',version:'1.0.0',mode:'pull',label:'SSH 单源日志',description:'通过已配置目标采集日志，保留原始字节与真实会话回执。',available:targets().some(t => t.sources.length > 0),reason:targets().length ? undefined : '尚未配置 SSH 目标',canStart:true,canStop:true,targets:targets(),configSchema:{fields:[targetField(),{key:'sourceId',label:'日志来源',type:'select',required:true,options:targets().flatMap(t => t.sources.map(s => ({value:s.id,label:t.label+' · '+s.label,targetId:t.id})))},...bounds,{key:'follow',label:'持续读取',type:'boolean',default:true}]}}),
    validate:(config) => { const input=sshConfig.parse(config);validateTarget(input.targetId,[input.sourceId]);return input; },
    start:async (config,owner) => ({ upstreamId:(await ssh().start(sshConfig.parse(config),owner)).id }),
    inspect:async (upstreamId,owner) => { const session=ssh().read(upstreamId,owner,0,1).session;return {state:session.state,recordCount:session.recordCount,byteCount:session.byteCount,startedAt:session.startedAt,endedAt:session.endedAt,error:session.error ? 'ssh_collection_failed' : undefined}; },
    stop:async (upstreamId,owner) => ssh().stop(upstreamId,owner),
    export:async (upstreamId,owner) => ({filename:'ssh-'+upstreamId+'.txt',mimeType:'text/plain',kind:'log',bytes:Buffer.from(await ssh().exportText(upstreamId,owner),'utf8')}),
  },{
    moduleId:'rdk-logs',version:'1.0.0',
    describe:() => ({moduleId:'rdk-logs',version:'1.0.0',mode:'pull',label:'RDK 多源日志',description:'组合运行或 ISP 日志来源，保存设备探测、来源、时间标记和完整采集包。',available:targets().some(t => t.sources.length > 0),reason:targets().length ? undefined : '尚未配置 RDK SSH 目标',canStart:true,canStop:true,targets:targets(),configSchema:{fields:[targetField(),{key:'profileId',label:'采集模板',type:'select',default:'runtime',options:rdk().listProfiles().map(p=>({value:p.id,label:p.label}))},{key:'sourceIds',label:'日志来源（最多 3 个，留空由模板选择）',type:'multiselect',options:targets().flatMap(t => t.sources.map(s => ({value:s.id,label:s.label,targetId:t.id})))},{key:'question',label:'调查问题',type:'text',default:''},...bounds]}}),
    validate:(config) => { const input=rdkConfig.parse(config);validateTarget(input.targetId,input.sourceIds??[]);return input; },
    start:async (config,owner) => ({ upstreamId:(await rdk().start(rdkConfig.parse(config),owner)).id }),
    inspect:async (upstreamId,owner) => {const group=rdk().read(upstreamId,owner);return {state:group.state,startedAt:group.startedAt,endedAt:group.endedAt,recordCount:group.sessions.reduce((n,s)=>n+s.recordCount,0),byteCount:group.sessions.reduce((n,s)=>n+s.byteCount,0),error:group.error?'rdk_collection_failed':undefined};},
    stop:async (upstreamId,owner) => rdk().stop(upstreamId,owner),
    export:async (upstreamId,owner) => { const bundle=rdk().bundle(upstreamId,owner);if(!bundle.streams.some(s=>s.records.some(r=>r.text.length>0)))throw new CollectionWorkspaceError('collection_no_records',422);bundle.exportedAt=bundle.manifest.endedAt??bundle.manifest.startedAt;return{filename:'rdk-'+upstreamId+'.json',mimeType:'application/json',kind:'document',bytes:Buffer.from(JSON.stringify(bundle),'utf8')}; },
  }];
}

/** Run tags are a lookup aid; content hash and owned file bytes remain authoritative. */
export const archiveCollectionRun: CollectionArchive = async (owner,run,pipeline,artifact) => {
  const data = getConfiguredDataCenterService();
  return data.archiveCollectionRun(owner, { runId:run.id,pipelineId:run.pipelineId,pipelineVersion:run.pipelineVersion,moduleId:run.moduleId,upstreamId:run.upstreamId??'',name:pipeline.name,project:pipeline.project,source:pipeline.source,targetId:typeof pipeline.config.targetId==='string'?pipeline.config.targetId:undefined,createDataset:pipeline.createDataset,artifacts:[...(artifact.rawBytes ? [{filename:artifact.rawFilename??'original.txt',mimeType:artifact.mimeType,kind:artifact.kind,bytes:artifact.rawBytes,role:'original'}] : []),{...artifact,role:artifact.rawBytes?'filtered':'original'}].map(item=>({...item,sha256:createHash('sha256').update(item.bytes).digest('hex')})) });
};
