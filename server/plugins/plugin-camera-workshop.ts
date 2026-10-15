import type { JsonSchema, PluginPackage } from './plugin-types.js';
import { validatePluginPackage } from './plugin-runtime.js';
import { VISION_WORKSHOP_API } from '../monitoring/vision-workshop-operations.js';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const resourceId: JsonSchema = { type: 'string', minLength: 1, maxLength: 100 };
const experimentArguments = object({ params: object({ id: resourceId }, ['id']) }, ['params']);
const emptyArguments = object({});
const get = (suffix: string) => ({ type: 'platform' as const, operationId: 'GET ' + VISION_WORKSHOP_API + suffix });

/** Editable read-only catalog package. Installing it never registers a device adapter. */
export const CAMERA_WORKSHOP_PLUGIN_TEMPLATE: PluginPackage = validatePluginPackage({
  schemaVersion: 1,
  id: 'camera-workshop',
  version: '1.2.0',
  label: '相机点亮与 ISP 助手',
  description: '把新型号资料与适配、点亮、采流、AI原生ISP调优及交付组织为证据流程，提供下一步原子能力和时序诊断。插件工作流只读取，设备写入由核心工具校验执行；配置和历史成功不代表当前或画质通过。',
  dependencies: [],
  configSchema: object({
    knowledgeId: { ...resourceId, default: 'x5-yahboom-imx415', description: '已入库相机知识 ID，默认 RDK X5 / 亚博 IMX415。' },
    experimentId: { type: 'string', maxLength: 100, default: '', description: '可选真实实验 ID；空或缺省表示未绑定。实验读取工具需显式传入所选 ID，不创建或猜测实验。' },
  }, ['knowledgeId']),
  tools: [
    { id: 'knowledge_search', description: '检索已核对相机资料、标注来源的团队经验、版本与当前适配器配置缺口；不访问硬件。',
      inputSchema: object({ query: object({ q: { type: 'string', maxLength: 160 }, board: { type: 'string', maxLength: 100 }, sensorModel: { type: 'string', maxLength: 100 } }) }),
      source: get('/knowledge') },
    { id: 'knowledge_get', description: '读取 facts、teamExperience、原子前提、来源与 registry readiness；用户经验、资料核对与硬件验收分别呈现。',
      inputSchema: object({ params: object({ knowledgeId: resourceId }, ['knowledgeId']) }, ['params']),
      source: get('/knowledge/:knowledgeId'), defaults: { params: { knowledgeId: '${config.knowledgeId}' } } },
    { id: 'vision_capabilities', description: '读取实际 deviceAdapters、设备操作和视觉模型/AI 调试状态；全局 available 不证明所选相机匹配。',
      inputSchema: emptyArguments, source: get('/capabilities') },
    { id: 'experiment_list', description: '列出当前身份真实相机实验，帮助用户选择绑定；不创建实验。',
      inputSchema: emptyArguments, source: get('/experiments') },
    { id: 'experiment_get', description: '显式提供 params.id，读取当前身份所选实验的版本、图像、deviceRuns 账本及评价；空绑定不得发起查询。',
      inputSchema: experimentArguments, source: get('/experiments/:id') },
    { id: 'experiment_readiness', description: '读取所选实验已保存的阶段证据和恢复阻塞；不访问设备，不把历史回执当当前在线或画质通过。',
      inputSchema: experimentArguments, source: get('/experiments/:id/readiness') },
    { id: 'camera_workflow', description: '读取新型号接入到ISP交付的证据阶段、恢复优先级、缺少适配工作与下一步真实工具。',
      inputSchema: experimentArguments, source: get('/experiments/:id/workflow') },
    { id: 'stream_analysis', description: '读取已保存SDK帧计数与时序诊断；不采流、不将短时记录当长期稳定。',
      inputSchema: experimentArguments, source: get('/experiments/:id/stream-analysis') },
    { id: 'ai_debug_runs', description: '显式提供 params.id，读取所选实验真实 AI 调试运行历史；运行列表不是画质成功证明。',
      inputSchema: experimentArguments, source: get('/experiments/:id/ai-debug/runs') },
    { id: 'ai_debug_status', description: '显式提供 params.id 和 params.runId，读取实际进度、模型评价、帧证据与恢复状态。',
      inputSchema: object({ params: object({ id: resourceId, runId: resourceId }, ['id', 'runId']) }, ['params']),
      source: get('/experiments/:id/ai-debug/runs/:runId') },
  ],
  dataSources: [
    { id: 'knowledge', toolId: 'knowledge_get', resultPath: 'data.knowledge' },
    { id: 'field_experience', toolId: 'knowledge_get', resultPath: 'data.knowledge.teamExperience.entries' },
    { id: 'facts', toolId: 'knowledge_get', resultPath: 'data.knowledge.facts' },
    { id: 'diagnostic_cases', toolId: 'knowledge_get', resultPath: 'data.knowledge.diagnosticCases' },
    { id: 'historical_observations', toolId: 'knowledge_get', resultPath: 'data.knowledge.historicalObservations' },
    { id: 'required_atomics', toolId: 'knowledge_get', resultPath: 'data.knowledge.requiredAtomics' },
    { id: 'sources', toolId: 'knowledge_get', resultPath: 'data.knowledge.sources' },
    { id: 'readiness', toolId: 'knowledge_get', resultPath: 'data.readiness' },
    { id: 'atomic_readiness', toolId: 'knowledge_get', resultPath: 'data.readiness.atomics' },
    { id: 'device_adapters', toolId: 'vision_capabilities', resultPath: 'data.deviceAdapters' },
    { id: 'capabilities', toolId: 'vision_capabilities', resultPath: 'data' },
    { id: 'experiments', toolId: 'experiment_list', resultPath: 'data.experiments' },
  ],
  panels: [
    { id: 'field_experience', title: '团队点亮与 ISP 经验（用户报告，历史待复核）', dataSourceId: 'field_experience', kind: 'table', columns: [{ key: 'topic', label: '阶段或问题' }, { key: 'guidance', label: '处理方法' }, { key: 'historicalExample', label: '用户报告的历史线索' }, { key: 'evidence', label: '证据要求与边界' }] },
    { id: 'knowledge_facts', title: '接线、系统与 ISP 资料', dataSourceId: 'facts', kind: 'table', columns: [{ key: 'title', label: '事项' }, { key: 'text', label: '已核对资料' }, { key: 'sourceIds', label: '来源 ID' }] },
    { id: 'diagnostic_cases', title: '镜像、MIPI / ISP 与闪连排障', dataSourceId: 'diagnostic_cases', kind: 'table', columns: [{ key: 'symptom', label: '现象' }, { key: 'interpretation', label: '判断边界' }, { key: 'nextStep', label: '处理顺序' }] },
    { id: 'historical_observations', title: '历史实测记录（不代表当前状态）', dataSourceId: 'historical_observations', kind: 'table', columns: [{ key: 'observedOn', label: '观察日期' }, { key: 'evidence', label: '证据类型' }, { key: 'observation', label: '实测记录' }, { key: 'boundary', label: '适用边界' }] },
    { id: 'required_atomics', title: '所需原子能力与验收证据', dataSourceId: 'required_atomics', kind: 'table', columns: [{ key: 'label', label: '原子能力' }, { key: 'prerequisites', label: '前提' }, { key: 'evidence', label: '回执要求' }, { key: 'notes', label: '边界' }] },
    { id: 'knowledge_sources', title: '厂商与官方来源', dataSourceId: 'sources', kind: 'table', columns: [{ key: 'title', label: '资料' }, { key: 'url', label: '公开链接' }, { key: 'locator', label: '位置' }] },
    { id: 'matching_adapter', title: '所选相机适配器配置状态', dataSourceId: 'readiness', kind: 'stat', valuePath: 'status' },
    { id: 'hardware_verification', title: '所选相机硬件验收状态', dataSourceId: 'readiness', kind: 'stat', valuePath: 'hardwareVerification' },
    { id: 'atomic_readiness', title: '所选相机当前原子能力缺口', dataSourceId: 'atomic_readiness', kind: 'table', columns: [{ key: 'id', label: '能力' }, { key: 'status', label: '配置状态' }, { key: 'missingOperations', label: '缺少操作' }] },
    { id: 'device_adapters', title: '当前已配置设备适配器', dataSourceId: 'device_adapters', kind: 'table', columns: [{ key: 'label', label: '设备' }, { key: 'board', label: '板型' }, { key: 'sensorModel', label: 'Sensor' }, { key: 'cameraInterface', label: '接口' }, { key: 'sdkVersion', label: 'SDK' }, { key: 'operations', label: '声明操作' }] },
    { id: 'ai_debug_capability', title: '平台 AI 相机调试能力（须核对所选设备）', dataSourceId: 'capabilities', kind: 'stat', valuePath: 'aiDebug.status' },
    { id: 'experiments', title: '当前身份相机实验', dataSourceId: 'experiments', kind: 'table', columns: [{ key: 'id', label: '实验 ID' }, { key: 'title', label: '实验' }, { key: 'board', label: '板型' }, { key: 'sensorModel', label: 'Sensor' }, { key: 'sdkVersion', label: 'SDK' }] },
  ],
  workflows: [{ id: 'readiness', title: '只读核对相机资料与能力缺口', steps: [
    { toolId: 'knowledge_get', label: '资料、来源与所选相机验收边界' },
    { toolId: 'vision_capabilities', label: '实际适配器、设备操作与模型状态' },
    { toolId: 'experiment_list', label: '当前身份实验与绑定候选' },
  ] }],
  prompts: [{ id: 'camera_bringup_isp_guide', text: [
    '先读取 knowledge_get 中的 teamExperience，按任务目标和已有证据规划 USB连接→采图→场景识别→发现画质问题、Studio真实MIPI点亮、ISP场景验收。已通过的步骤按需复用，用户指定阶段时从真实缺口继续。设备采图不代表识别或MIPI通过；没有实际看图/识别能力时明确缺口。',
    '优先核对OS/SDK/驱动/模组模式与匹配Tuning guide、原版效果库及可写范围，再做看图调试。旧3.3.3/1.0.17到3.4.0案例、SC835HAI客户适配、IMX415缺货、全志对标及去雾降噪效果均为用户报告线索，不是统一版本条件、当前库存或本平台通过回执。标定warning需确认默认/回退库实际加载且相关检查通过后才判为不阻塞。',
    '相机选型综合可购买性、使用量、供货与电气兼容；树莓派常用不自动证明目标板兼容。记录在目标板上未点亮、已点亮未做ISP或已调优的起点；专家步骤按输入资料、版本/接线、实际操作、配置差异、编译产物、日志、回读、新帧和恢复采集，未复现的不当作已实现自动化。按现有验收工具schema记录实际场景、照明与视觉或测量标准，比较雾感、暗部噪点、彩噪、颜色与细节。内部实机验收后按授权分级开放，不代填人工通过结论。',
    '新型号先建立准确模组/板卡/SDK/模式资料包，核对供电、lane、外部时钟、Bayer/位深、驱动源码和tuning schema。使用 camera_workflow 按保存证据选择下一原子动作；无驱动时形成AI开发任务、源码补丁、匹配头文件编译与实机验证步骤，不把已有SDK的bringup当自动生成驱动。插件没有通用驱动生成或发布API。回答先给当前结果、阻塞和下一步。',
    '采流后用 stream_analysis 核对保存SDK帧号与时间证据。计数斜率、声明fps、真实时钟和长期稳定分别验证；不跨配置、故障或重启拼出稳定通过。整板连接、Sensor I2C初始化、MIPI采流、ISP写入和图像画质是不同故障层，恢复未确认优先于新调参。',
    'AI原生ISP调试使用本次probe返回的x5-hbn-isp-v2完整快照及实际可写rules，由模型选择最多3条数值patches，经apply_tuning、独立全配置hash和新帧验证；未开放模式、AUTO未确认槽位、未知范围不能靠模型推测。UVC使用已有controls values路径，不混用。无可靠改善保留原配置；读回变更不代表图像效果或画质已改善。',
    '你是平台相机点亮与 ISP 助手。先根据用户的板型、模组、接口与目标，检索并读取 knowledgeId 对应知识，引用真实公开来源。把 documentation verified、hardware unverified、适配器 configured unverified 和实际实机通过分别陈述。静态知识是前提资料，不是可执行设备或完成验收的声明。',
    '知识搜索只返回摘要；遇到 IMX415 镜像升级、MIPI PHY stop state、-36/-37、旧 SDK、恢复失败或 USB 闪连问题，必须继续 knowledge_get 读取 vendorPrerequisites、diagnosticCases 和 historicalObservations。厂商 ROS 直接支持条件是镜像 >=3.5.0、两个指定 TROS 包 >=2.4.1；旧 ROS 升级步骤不能套给未知来源镜像，截图中两条 <3.5.0 分支不足以识别实际镜像类型。读文档、安装插件或历史试验不授权升级、烧录或重放设备写入。',
    '历史记录只说明当时观察：早期官方采集成功与后续开流失败可以同时成立，不把旧图、I2C 识别、SDK 返回 0 或 getter 成功当当前稳定出图/原生 ISP/画质验收。按本轮内核日志与新帧诊断 MIPI，再按实际头文件/库检查 SDK。闪连另按 USB 数据枚举、虚拟网卡、链路、地址/路由和服务检查；ADB、旧 ARP 或普通以太网适配器不能证明 RDK USB 网络可用，也不能只凭旧系统版本断定原因。',
    '再读取实际 vision_capabilities、所选知识 readiness 与 deviceAdapters。匹配同一个真实 adapter 的 board、sensorModel、cameraInterface、sdkVersion、cameraMode 与所需 operations，不拼接多个设备的能力，不用平台全局 available 证明当前相机可用。没有匹配 adapter 或必要操作时停止设备执行，明确 adapter 缺口与所需验收证据；不得凭空填写 targetId、SDK 版本、模组模式、sensor index、连接地址或凭据。',
    '若配置 experimentId 非空，先使用该真实 ID 查询实验；若未绑定，列出当前身份实验，让用户选择，或在用户授权后通过平台核心 vision 实验创建工具建立新实验。本插件的 GET 工具在 params.id 中显式传入该真实 ID。读取 experiment_readiness 的保存证据、缺口和 recovery；恢复未确认时先显式恢复并核对回读，再发起新调试。历史 observed 不证明当前在线。创建前记录实际场景目标、板型、sensorVendor、sensorModel、cameraInterface、cameraMode、sdkVersion，并将 targetId 绑定到服务端已经存在的匹配 adapter；知识默认值不能补齐未知设备信息。',
    '本插件 readiness 工作流只读取。用户授权点亮或调试后，后续动作走平台核心 vision 工具及其当前 operation metadata / input schema，保留原权限和租户隔离。按实际支持的能力执行 POST probe、pipeline_validate、bringup、capture_raw、process_raw、apply_tuning 或 restore_tuning；或在当前设备 AI 调试前提满足且用户授权时启动核心 ai-debug。先读核心工具 schema，只传实际声明的字段，不从提示词发明 tuning 参数、默认 index 或命令。物理接线、IR-CUT、手动焦点与旧镜像条件依知识前提核对。',
    '任何写入前先保存可恢复原始控制与基线。controls_get 返回的实际可写、active、范围和步长决定能否 controls_set；原生 ISP tuning 只允许实际 SDK/schema 中的参数。apply_tuning 后要有实际回读与新帧配置哈希关联；未知写入结果、超时或断连时先查 experiment_get 的 deviceRuns 账本及实际状态，不自动重试，恢复也须回读验证。',
    '点亮预览、真实 Bayer RAW、板端原生 ISP 生效和画质结论分别验收。image_raw、NV12、JPEG、PNG 和 UVC 控制不等于 Sensor Bayer RAW 或 X5 原生 ISP；不得宣称原生 ISP 能力已完善。RAW 回执包含真实字节哈希、位深、Bayer、packing、stride、帧号和曝光状态，回灌支持未验收时不调用 process_raw。使用匹配板端 SDK 的工具主机与配置版本。',
    'AI 自主调试必须依据本轮真实图像、控制回读与历史，让核心模型选择调整/保留/恢复/停止，不写死参数序列或复用旧帧冒充新现场。通过 ai_debug_runs 与 ai_debug_status 读取真实进度、停止原因与恢复回执。模型评价不能冒充人工评价，不代填用户评分；运行 done 或画面均值变化不代表画质通过。人工评价请求交由用户表达，实际失败、缺失证据和恢复未知必须保留。',
  ].join('\n\n') }],
}, { knowledgeId: 'x5-yahboom-imx415', experimentId: '' });
