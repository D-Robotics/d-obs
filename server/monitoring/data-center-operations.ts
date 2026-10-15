/** Reviewed pure capability declarations. */
import type { PlatformOperationMetadata } from './platform-operation-metadata.js';
export const DATA_CENTER_API = '/api/ops/observability/data-center';
export const DATA_CENTER_CONTRACT = 'rdk.data-center.v1';
const meta = (description: string, body?: Record<string, string>, query?: Record<string, string>): PlatformOperationMetadata => ({ group: '数据闭环中心', tenantAccessible: false, description, ...(body ? { body } : {}), ...(query ? { query } : {}) });
const assetBody = { title: '资产标题', kind: 'raw/image/video/log/metric/event/sensor/document/model/other', source: 'cloud或edge，只表示来源声明', project: '项目名称', targetId: '可选来源设备或云服务ID，闭环需填写', description: '可选说明', tags: '可选标签数组' };
export const DATA_CENTER_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  ['GET ' + DATA_CENTER_API + '/capabilities']: meta('发现文件接收、外部引用、固定快照与申报指标验收能力及额度；未提供远程采集执行和自动训练。'),
  ['GET ' + DATA_CENTER_API + '/overview']: meta('读取当前账号资产、云端/终端分布、最近采集任务与待验收闭环。'),
  ['GET ' + DATA_CENTER_API + '/assets']: meta('按当前身份列出数据资产，外部引用未下载或验证内容。', undefined, { kind: '可选资产类别', source: '可选cloud/edge', project: '可选项目精确匹配', search: '可选标题、说明及标签搜索' }),
  ['POST ' + DATA_CENTER_API + '/assets']: meta('登记不含凭据的https/s3/gs外部引用；不访问地址，不能作为实际采集完成证明。', { ...assetBody, referenceUri: '无userinfo、query、fragment的引用URI' }),
  ['POST ' + DATA_CENTER_API + '/assets/upload']: meta('受保护二进制HTTP上传真实文件，最长64MiB，SHA256核验。Agent通过capabilities.binaryUpload发现协议，不能用JSON伪造文件。'),
  ['GET ' + DATA_CENTER_API + '/assets/:id']: meta('读取本账号数据资产身份、SHA256、存放方式和真实文件字节数。'),
  ['GET ' + DATA_CENTER_API + '/assets/:id/content']: meta('下载本账号已上传文件；核验SHA256，固定attachment与octet-stream，不代理外部引用。'),
  ['DELETE ' + DATA_CENTER_API + '/assets/:id']: meta('删除未被固定数据集、闭环证据或已完成采集任务引用的资产并回收存储额度。'),
  ['GET ' + DATA_CENTER_API + '/tasks']: meta('列出当前账号采集规划与接收状态；只有实际文件到达才计入已收数量。'),
  ['POST ' + DATA_CENTER_API + '/tasks']: meta('创建采集规划，不连接或控制终端。签发限定任务的token后采集端可上传。', { title: '任务名称', source: 'cloud/edge', project: '项目', targetId: '明确目标设备/云服务ID', kind: '文件类别', expectedCount: '1–1000个预期不同文件', description: '可选说明' }),
  ['POST ' + DATA_CENTER_API + '/tasks/:id/status']: meta('更新采集状态；只有实际上传文件数量等于expectedCount且文件完整才能completed，失败/取消清除采集token。', { status: 'collecting/completed/failed/cancelled', notes: '可选说明' }),
  ['POST ' + DATA_CENTER_API + '/tasks/:id/token']: meta('轮换单任务采集token；旧token立即失效，明文只在这次响应出现。token只能上传该任务范围，不能读取平台。', {}),
  ['GET ' + DATA_CENTER_API + '/datasets']: meta('列出当前账号固定版本的数据集快照。'),
  ['GET ' + DATA_CENTER_API + '/datasets/:id']: meta('读取固定数据集资产身份、版本、哈希和来源快照。'),
  ['POST ' + DATA_CENTER_API + '/datasets']: meta('创建不可变数据集；同项目同名称版本递增，关联资产必须属当前账号与同项目。', { name: '数据集名称', project: '项目', assetIds: '1–300个不重复真实资产ID', description: '可选说明' }),
  ['GET ' + DATA_CENTER_API + '/loops']: meta('列出数据改善闭环，区分已应用与已验收。'),
  ['GET ' + DATA_CENTER_API + '/loops/:id']: meta('读取闭环目标、固定基线、改善阈值与阶段证据。'),
  ['POST ' + DATA_CENTER_API + '/loops']: meta('基于固定数据集与实际上传基线证据建立改善目标。', { title: '名称', goal: '改善目标', project: '项目', targetId: '绑定验证设备/云服务ID', datasetId: '当前账号固定数据集ID', baseline: '{metric,value,unit?,assetId,version}，assetId在该数据集且已上传', criterion: '{direction:increase|decrease,threshold:非负绝对改善值}' }),
  ['POST ' + DATA_CENTER_API + '/loops/:id/evidence']: meta('按analysis→evaluation→deployment→verification登记真实文件证据；验收绑定不同文件、目标与候选版本，平台按固定阈值判定申报数值。部署不等同验收。', { stage: 'analysis/evaluation/deployment/verification', assetId: '已上传同项目同目标资产ID', version: '分析版本或候选版本；deployment/verification必须等于evaluation', targetId: '必须等于闭环目标', notes: '证据说明', baselineValue: 'verification必须与固定baseline.value一致', candidateValue: 'verification必须为有限数值' }),
  ['GET ' + DATA_CENTER_API + '/manifest']: meta('下载仅含当前身份可见数据的JSON清单；不包含采集token/hash。'),
};
