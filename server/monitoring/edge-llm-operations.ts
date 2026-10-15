import type { PlatformOperationMetadata } from './platform-operation-metadata.js';

export const EDGE_LLM_API = '/api/ops/observability/edge-llm';
export const EDGE_LLM_CONTRACT = 'rdk.edge-llm.v1';
export const EDGE_LLM_RUNNER_CONTRACT = 'rdk.edge-llm-runner.v1';
export const EDGE_LLM_JOB_OPERATIONS = ['probe', 'deploy', 'benchmark', 'stop'] as const;
export type EdgeLlmOperation = typeof EDGE_LLM_JOB_OPERATIONS[number];
const meta = (description: string, body?: Record<string, string>): PlatformOperationMetadata => ({ group: '端侧文本模型', tenantAccessible: false, description, ...(body ? { body } : {}) });
export const EDGE_LLM_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  ['GET ' + EDGE_LLM_API + '/capabilities']: meta('发现服务端已配置的 RDK X5 CPU 文本模型 runner 和任务能力；配置目标不代表硬件已连接。'),
  ['GET ' + EDGE_LLM_API + '/targets/:targetId']: meta('查询可信 runner 的真实模型目录、运行时和部署状态；不接受客户端地址或命令。'),
  ['GET ' + EDGE_LLM_API + '/jobs']: meta('读取本账号持久化任务列表；submitting/queued/running/unknown 均未完成。'),
  ['POST ' + EDGE_LLM_API + '/jobs']: meta('提交固定 probe/deploy/benchmark/stop 操作，先保存任务再后台发送；202 仅表示已登记。unknown先查询同一ID；无活跃任务时stop可恢复设备状态，必须核验推理端口空闲及旧ID已被runner永久终结，旧任务标superseded且原结果仍未知，不能宣称失败或成功。', { targetId: 'capabilities 返回的服务端目标 ID', operation: 'probe/deploy/benchmark/stop', modelId: 'deploy/benchmark 必填，必须来自目标实际目录；probe/stop 不填写' }),
  ['GET ' + EDGE_LLM_API + '/jobs/:id']: meta('查询本账号同一任务 ID 的 runner 回执并保存真实状态；不会重新提交、自动重试或创建任务。'),
  ['GET ' + EDGE_LLM_API + '/jobs/:id/report']: meta('下载本账号持久化 JSON 任务报告；保留最近真实结果和错误，不伪造指标或完成状态。'),
};
