/** Pure reviewed calibration declarations; no handler/store/process imports. */
import type { PlatformOperationMetadata } from './platform-operation-metadata.js';
import { VISION_WORKSHOP_API } from './vision-workshop-operations.js';
const VISION_CALIBRATION_API = VISION_WORKSHOP_API + '/experiments/:id/calibration';
const meta = (description: string, body?: Record<string, string>): PlatformOperationMetadata => ({ tenantAccessible: false, group: '视觉 Workshop', description, ...(body ? { body } : {}) });
export const VISION_CALIBRATION_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  ['POST ' + VISION_CALIBRATION_API + '/assets']: meta('导入有账户与原图归属证据的色卡线性RGB测量JSON；文件哈希不证明测量或光源正确。', { measurement: '明确的色卡ROI、原资产ID、线性RGB测量、参考sRGB/linear-sRGB、D65白点与记录光源，不接受文件路径。' }),
  ['GET ' + VISION_CALIBRATION_API + '/assets']: meta('列出本身份实验色卡测量资产及原图哈希。'),
  ['POST ' + VISION_CALIBRATION_API + '/tasks']: meta('创建BLC/LSC/CCM/AWB离线标定任务，解析本身份已有Raw/测量资产及输入哈希；不连接设备。', { operation: 'blc/lsc/ccm/awb。', inputs: '1–32个{sampleId,capture}或CCM单个{artifactId}；只能引用本实验资产。', options: '算法数值门限；LSC/AWB必须提供四通道blackLevels，LSC还需网格。' }),
  ['GET ' + VISION_CALIBRATION_API + '/tasks']: meta('读取持久离线任务的真实状态；重启后的中断任务保持interrupted。'),
  ['GET ' + VISION_CALIBRATION_API + '/tasks/:taskId']: meta('读取本身份任务及输入、执行、失败、输出哈希证据。'),
  ['POST ' + VISION_CALIBRATION_API + '/tasks/:taskId/run']: meta('由固定服务器Python算法执行离线标定，重新校验实际输入字节；失败/缺NumPy明确记录，不伪造结果，最长120秒。', {}),
  ['GET ' + VISION_CALIBRATION_API + '/tasks/:taskId/result']: meta('读取经过文件哈希核对的SDK中性标定值与数值统计；硬件及画质均unverified。'),
  ['GET ' + VISION_CALIBRATION_API + '/tasks/:taskId/apply-plan']: meta('生成匹配身份、输入/输出lineage和SDK转换约束的应用规划；规划不执行板端写入。'),
};
