import type { PlatformOperationMetadata } from './platform-operation-metadata.js';

export const RSI_LEARNING_API = '/api/ops/observability/evolution/learning';
export const RSI_LEARNING_CONTRACT = 'rdk.rsi-learning.v1';
export const RSI_LEARNING_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  [`GET ${RSI_LEARNING_API}/capabilities`]: { group: '学习与进化', tenantAccessible: false, description: '查看受控学习闭环的固定预算、支持的动作及合成演示边界。' },
  [`GET ${RSI_LEARNING_API}/loops`]: { group: '学习与进化', tenantAccessible: false, description: '查看当前管理员账号的学习证据账本及已接受、已继承轮次数。' },
  [`GET ${RSI_LEARNING_API}/loops/:id`]: { group: '学习与进化', tenantAccessible: false, description: '查看当前管理员账号一个学习闭环的版本、固定案例回放和决策证据。' },
  [`GET ${RSI_LEARNING_API}/loops/:id/classify`]: { group: '学习与进化', tenantAccessible: false, description: '用当前账号已接受的规则版本归因结构化工具失败，返回实际使用的版本。', query: { httpStatus: '可选 HTTP 状态码，100–599。', errorCode: '可选固定错误码，不接受日志正文。' } },
};
export const RSI_FAILURE_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  [`GET ${RSI_LEARNING_API}/evidence`]: { group: '学习与进化', tenantAccessible: false, description: '查看当前运营身份从真实工具调用收集的低敏失败证据、人工确认状态与实验绑定；推测原因不等于确认标签。' },
};
export const RSI_LEARNING_EXCLUSIONS: Record<string, string> = Object.fromEntries([
  '/loops', '/demo', '/loops/:id/propose', '/loops/:id/replay', '/loops/:id/accept', '/loops/:id/reject', '/loops/:id/rollback',
  '/evidence/:id/confirm', '/evidence/:id/exclude', '/evidence/experiment', '/binding',
].map(path => [`POST ${RSI_LEARNING_API}${path}`, '学习证据确认、实验修改与生效绑定通过专用页面的显式动作完成，助手只读查看。']));
