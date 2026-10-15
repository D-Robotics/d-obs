/** Pure reviewed declarations: importable without HTTP handlers, adapters or stores. */
import type { PlatformOperationMetadata } from './platform-operation-metadata.js';

export const VISION_WORKSHOP_CONTRACT = 'rdk.vision-workshop.v1';
export const VISION_WORKSHOP_API = '/api/ops/observability/vision-workshop';
export const VISION_WORKSHOP_MCP = '/api/ops/vision-workshop/mcp';

const meta = (description: string, body?: Record<string, string>, query?: Record<string, string>): PlatformOperationMetadata => ({ tenantAccessible: false, group: '视觉 Workshop', description, ...(body ? { body } : {}), ...(query ? { query } : {}) });
export const VISION_WORKSHOP_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  ['GET ' + VISION_WORKSHOP_API + '/knowledge']: meta('检索相机接入与 ISP 调试知识（含 RDK X5、亚博 IMX415）：返回资料核对状态、来源与所需原子能力；知识记录不证明硬件就绪，不触发设备操作。', undefined, { q: '可选关键词，最多160字符，例如 IMX415、ISP、接线。', board: '可选板型过滤，最多100字符。', sensorModel: '可选Sensor型号过滤，最多100字符。' }),
  ['GET ' + VISION_WORKSHOP_API + '/knowledge/:knowledgeId']: meta('读取一份相机知识的接线与版本前提、调试顺序、原子操作准入与证据要求；按当前registry区分未配置与仅配置未验证，不调用硬件。'),
  ['GET ' + VISION_WORKSHOP_API + '/capabilities']: meta('发现通用视觉原子能力、实际支持的文件格式、已配置的相机/SDK适配器与模型状态；未配置设备能力明确不可用。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/readiness']: meta('只读投影本身份实验的配置、已保存执行/资产/CPU标定证据与恢复阻塞；不探测设备，不声明当前在线、SDK资格或画质通过。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/workflow']: meta('按本身份实验、实际适配器与恢复账本评估新型号相机接入、点亮、采流、ISP与交付阶段，返回下一步真实原子工具及所需证据。无驱动时列适配工程缺口，不执行硬件或生成虚假通过。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/stream-analysis']: meta('只读分析本实验归档SDK帧号与时间证据，按配置及故障边界分组，发现重复帧、计数/时序异常；不接受外部帧样本，不证明当前在线或长期稳定。', undefined, { runIds: '可选JSON字符串数组，1–128个本实验deviceRuns或AI运行ID。', expectedFps: '可选比较目标，正数≤1000；调用者目标不构成厂商帧率或时钟资格。', tolerancePercent: '可选0–100百分比容差，默认由分析契约定义。', minimumDurationSeconds: '可选最短观测时长，正数≤3600；未达到时不能作时序通过结论。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/delivery']: meta('读取本实验的交付缺口、参数版本、验收标准与记录；显式区分operator录入、独立验证和自包含tuning可部署性。'),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/delivery-target']: meta('显式选择delivery.targets返回的交付版本，不写硬件、不代表验收完成。', { targetId: '本实验delivery.targets返回的版本ID。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/vendor-artifacts/:artifactId/download']: meta('下载本实验已校验归档的厂商候选JSON原字节；与原始归档库区分，校验SHA256，不能指定路径。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/handbook']: meta('下载本实验的调优操作手册，包含实际前提、步骤、证据、失败恢复与交付检查。'),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/acceptance-plan']: meta('保存场景、照明及明确验收阈值；新标准生成新版本，旧验收记录不自动延用。', { scene: '实际验收场景。', lighting: '实际照明和固定条件。', criteria: '1–32项{id,label,kind:visual|measurement,required,unit?,operator:lte|gte|between?,minimum?,maximum?,method?}；至少一项必验。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/acceptance-records']: meta('绑定当前标准、真实参数与图像归档操作者提供的测量/观察。服务器计算阈值结论，不把录入值当独立测量或模型判断当人工认证。', { planId: '当前验收标准ID。', candidateId: 'delivery.targets返回的参数版本ID。', imageIds: '同实验真实图像ID，至少一张匹配参数hash。', observations: '唯一criterionId及measurement value或visual verdict+notes。', report: '测量记录原文；数值测量时必填，记录SHA256。', notes: '可选本轮说明。' }),
  ['GET ' + VISION_WORKSHOP_API + '/plugin-packages']: meta('读取服务端已发布视觉插件包的实际版本与下载元数据；未发布返回不可用，不接受客户端文件路径。'),
  ['GET ' + VISION_WORKSHOP_API + '/plugin-packages/:kind/download']: meta('按固定 kind=platform 或 studio 下载已发布插件包；校验服务端固定文件，不接受路径或URL。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments']: meta('列出当前身份的视觉实验；Raw、参数、图像和评价按实验归档。'),
  ['POST ' + VISION_WORKSHOP_API + '/experiments']: meta('创建通用视觉实验，不连接设备；未知的相机上下文保持未记录。', { title: '实验名称。', goal: '画质目标与场景。', board: '可选实际板卡/设备平台。', sensorVendor: '可选实际相机厂商。', sensorModel: '可选实际Sensor型号，无默认值。', cameraInterface: '可选实际相机接口。', cameraMode: '可选本次相机工作模式，须与选定适配器一致。', sdkVersion: '使用的SDK版本；板端写操作前须与adapter版本一致，不推测缺失版本。', targetId: '可选服务端设备适配器ID，不能传地址或命令。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id']: meta('读取本账号实验的不可变参数历史、Raw清单、结果图、设备回执和人工评价。'),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug']: meta('授权模型基于实时真实图像、控制回读和历史观察自主调用相机原子能力；异步最多6次调整加最后一次评估，失败或取消恢复原始配置。', { goal: '现场具体画面目标；不得把普通PNG/JPEG称为Bayer Raw或已验证ISP。', maxRounds: '可选1–6次实际调整，默认4；模型提前停止有原因。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug/runs']: meta('列出本身份实验自主相机调试历史，保留来源为模型的决策和真实原子证据。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug/runs/:runId']: meta('查询自主相机调试进度、帧哈希、实际控制、模型图像评估、停止原因及恢复回执。'),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug/runs/:runId/cancel']: meta('请求取消运行并恢复实际原始配置；cancelRequested不代表已经停止或恢复完成。', {}),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug/runs/:runId/restore-original']: meta('运行结束后恢复其保存的完整实际原始配置，验证应用和回读哈希。', {}),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/baseline']: meta('导入已验证基础tuning配置及可调数值路径；历史候选保持原版本。', { config: '实际SDK或设备控制基础tuning JSON对象。', rules: '1–32项{path,label,min,max,step?}，path为已有数值字段的JSON Pointer，禁止编造字段。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/samples']: meta('导入实际Raw文件；Agent小文件可用JSON，其余使用binaryUpload说明中的受保护HTTP地址。上传不是设备采集证明。', { filename: '可选原文件名。', metadata: 'scene,width,height,bitDepth,bayer,packing,stride,blackLevel,whiteLevel；可选exposureUs,gain。', contentBase64: '小文件canonical base64；大Raw走application/octet-stream并附x-vision-sample元数据。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/samples/:sampleId']: meta('分析保存Raw的真实字节，返回统计、SHA-256与预览/下载地址；预览不是ISP输出。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/frames/:frameId']: meta('读取归档的实际相机PNG/JPEG帧；不作为Bayer Raw或校准ISP验收证明。'),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/frames/:frameId/analysis']: meta('从归档相机PNG实际字节计算输出码值统计，可选ROI；不是校准噪声、MTF或色差，不声明不同采集帧为相同Raw。', undefined, { roi: '可选JSON字符串{x,y,width,height}，像素矩形须在图像内。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/candidates']: meta('用保存Raw统计或实际相机帧输出统计和受限基础参数生成AI候选；关联原配置/Raw哈希，未上板，不会回退规则伪装模型。', { goal: '可选本轮优化目标，默认实验目标。', frameIds: '可选1–16个当前基线配置哈希匹配的PNG相机帧ID；省略且无Raw时使用最新最多16张匹配帧。旧帧不冒充当前配置证据。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/results']: meta('导入与Raw及候选关联的实际PNG/JPEG结果图；明确标为外部导入，不能伪造板端验证。', { sampleId: '同实验Raw样本ID。', candidateId: '可选同实验参数候选ID，省略代表基础配置。', filename: '可选原文件名。', mimeType: 'image/png或image/jpeg。', contentBase64: '小文件canonical base64，大文件走binaryUpload。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/evaluations']: meta('评价已保存的真实结果图；评分明确为人工评价。', { imageId: '同实验结果图ID。', rating: '整数1–5。', notes: '评价说明。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/comparisons']: meta('从同Raw、同基础参数版本的真实PNG结果计算亮度、端点占比、通道均值和ROI标准差差异；不接受客户端指标，不代表SNR/MTF或画质验收。', { baselineImageId: '不关联候选的基础配置PNG图像ID。', candidateImageId: '关联候选、同Raw且同尺寸的PNG图像ID。', roi: '可选{x,y,width,height}像素区域。' }),
  ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/selection']: meta('选定已有实际结果图和人工评价的候选；不会标成完整上板验收通过。', { candidateId: '同实验候选ID。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/tuning']: meta('下载候选tuning文件，保留未完成完整验证的状态。', undefined, { candidateId: '可选候选ID；省略用选定候选。' }),
  ['GET ' + VISION_WORKSHOP_API + '/experiments/:id/bundle']: meta('导出参数、调优手册、原版本/Raw哈希、结果图和评价ZIP；如无选定候选则不包含tuning。', undefined, { includeRaw: '设1包含原始Raw，默认不包含大文件。' }),
  ...Object.fromEntries((['probe', 'pipeline_validate', 'bringup', 'capture_raw', 'process_raw', 'apply_tuning', 'preview_start', 'preview_stop', 'preview_frame', 'capture_frame', 'controls_get', 'controls_set', 'restore_tuning', 'tuning_get', 'tuning_load', 'tuning_export', 'calibration_apply'] as const).map((operation) => ['POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/' + operation, meta('调用服务端配置、相机与SDK上下文匹配的适配器执行' + operation + (operation === 'bringup' ? '（启动已适配的驱动与模式，不生成新Sensor驱动）' : '') + '，记录真实回执；未配置直接报不可用，不接受客户端命令/连接地址。操作最长约120秒；若结果unknown，先查询实验deviceRuns，禁止自动重试。', operation === 'capture_raw' ? { scene: '本次采集场景名称。' } : operation === 'process_raw' ? { sampleId: '已保存Raw样本ID。', candidateId: '可选参数候选ID，省略用基础配置。' } : operation === 'apply_tuning' ? { candidateId: '已保存候选ID；应用后必须回读相同配置哈希。' } : operation === 'capture_frame' ? { scene: '可选场景名称，保存实际PNG/JPEG相机帧，不能作为Bayer Raw。', candidateId: '可选已应用候选；设备实际配置哈希须匹配。' } : operation === 'controls_set' ? { values: '设备controls_get中已声明且可写的控制键与数值/布尔值，须在实际范围和步长内；返回真实回读。' } : operation === 'restore_tuning' ? { baselineId: '可选历史基线ID；省略默认当前基线，不能同时传candidateId。', candidateId: '可选历史候选ID；实际应用和回读哈希均须匹配。' } : operation === 'tuning_load' ? { contentBase64: '有界SDK效果库JSON字节的canonical base64，不接受文件路径；最大16MiB字节。', sha256: '实际JSON字节SHA-256；加载后独立读取公开SDK模块，未公开字段仍未验证。', artifactRole: '加载本轮生成候选须填vendor_effect_library_candidate，强制私有生成回执与真实SDK重载校验；省略按旧显式导入，不获得候选验证证明。' } : operation === 'calibration_apply' ? { taskId: '当前身份/实验已完成且校验输出哈希的标定任务ID，服务端读取可信结果。', options: 'AWB需要{illuminantId}明确选记录光源；其它标定省略。' } : {})])),
};
