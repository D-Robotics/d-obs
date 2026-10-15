import type { PlatformOperationMetadata } from './platform-operation-metadata.js';
export const COLLECTION_WORKSPACE_API = '/api/ops/observability/collection-workspace';
const meta=(description:string,body?:Record<string,string>):PlatformOperationMetadata=>({group:'统一采集工作区',tenantAccessible:false,description,...(body?{body}:{})});
export const COLLECTION_WORKSPACE_OPERATIONS:Record<string,PlatformOperationMetadata>={
  ['GET '+COLLECTION_WORKSPACE_API+'/catalog']:meta('读取已有采集源、模块参数、真实旧任务及持续接收状态。未配置目标明确不可执行。'),
  ['GET '+COLLECTION_WORKSPACE_API+'/pipelines']:meta('读取当前稳定账号的采集流程与不可变配置版本。'),
  ['POST '+COLLECTION_WORKSPACE_API+'/pipelines']:meta('保存源→可选文本过滤→字节质量门禁→资产归档的配置新版本；不会开始采集或探测。',{pipelineId:'可选本账号流程ID，编辑生成新版本',name:'名称',project:'数据项目',source:'cloud/edge',moduleId:'服务端模块ID',moduleVersion:'目录内明确版本',config:'目录规定的参数，不能传命令、地址、密钥或任意路径',filter:'可选{keywords:纯文本关键词[],mode:include/exclude}；仅文本日志',quality:'{minBytes:最少真实字节数}',createDataset:'是否固定结果数据集，推荐true'}),
  ['POST '+COLLECTION_WORKSPACE_API+'/pipelines/:id/runs']:meta('明确启动本账号流程的固定版本，通过原SSH/RDK驱动实际采集并归档；不是登记规划。',{version:'可选版本整数，默认最新'}),
  ['GET '+COLLECTION_WORKSPACE_API+'/runs']:meta('读取本账号真实采集运行、节点状态、数量与关联资产。'),
  ['GET '+COLLECTION_WORKSPACE_API+'/runs/:id']:meta('读取固定流程版本的运行回执，不重新执行采集。'),
  ['POST '+COLLECTION_WORKSPACE_API+'/runs/:id/stop']:meta('停止本账号运行绑定的实际上游采集，保留已收结果。',{}),
  ['POST '+COLLECTION_WORKSPACE_API+'/runs/:id/finalize']:meta('仅重新归档已终止运行的真实输出；幂等绑定资产，不重新开始采集。',{}),
  ['POST '+COLLECTION_WORKSPACE_API+'/runs/adopt']:meta('将当前账号已有SSH/RDK会话纳入流程与结果归档；不启动新设备采集。',{moduleId:'ssh-logs/rdk-logs',upstreamId:'已有本账号会话或采集组ID',name:'流程名',project:'数据项目',source:'cloud/edge',config:'可复用参数模板；旧会话未保存的参数不能当作原始执行配置',createDataset:'固定结果数据集'}),
  ['POST '+COLLECTION_WORKSPACE_API+'/receivers/cloud-log-bridge/config']:meta('版本化调整现有云日志采集桥的轮询、批量和队列；daemon实际应用回执确认生效，不修改日志源或连接凭据。',{pollMs:'1000–60000',flushMs:'1000–60000',batch:'1–512',queueLimit:'512–20000'}),
  ['POST '+COLLECTION_WORKSPACE_API+'/receivers/device-heartbeat/config']:meta('给已登记设备下发set-interval采集间隔；pending/delivered表示等待，只有设备ack ok才生效。',{deviceId:'已存在登记设备ID',intervalSec:'5–3600'}),
  ['GET '+COLLECTION_WORKSPACE_API+'/receivers/device-heartbeat/:deviceId/commands']:meta('读取现有设备真实采集参数下发与确认状态。'),
};
