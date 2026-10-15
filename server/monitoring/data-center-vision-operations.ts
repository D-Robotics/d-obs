import type { PlatformOperationMetadata } from './platform-operation-metadata.js';
const API = '/api/ops/observability/data-center';
export const DATA_CENTER_VISION_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  ['GET ' + API + '/vision-experiments']: { tenantAccessible: false, group: '数据闭环中心', description: '列出当前身份真实视觉实验的样本与候选数量；没有实验返回空列表。' },
  ['POST ' + API + '/imports/vision/:id']: { tenantAccessible: false, group: '数据闭环中心', description: '将当前身份视觉实验的已校验实际文件、候选和回执纳入数据资产与不可变数据集；幂等重试，不操作设备，不宣称画质已验收。', body: { project: '资产所属项目名称，必填。' } },
};
