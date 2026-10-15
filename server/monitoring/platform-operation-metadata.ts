import { VISION_CALIBRATION_OPERATIONS } from './vision-workshop-calibration-operations.js';
import { PLUGIN_OPERATIONS } from './plugin-operations.js';
import { RSI_LEARNING_OPERATIONS, RSI_FAILURE_OPERATIONS, RSI_LEARNING_EXCLUSIONS } from './rsi-learning-operations.js';
import { COLLECTION_WORKSPACE_OPERATIONS } from './collection-workspace-operations.js';
/**
 * Reviewed REST capability declarations and guidance for the operations assistant.
 *
 * Keys identify explicitly published HTTP operations. Tenant visibility is declared
 * here, while execution retains the original handlers and their guards,
 * validation, tenant scope, audit, and action-state transitions. Caller identity
 * and credentials are inherited from the request, never supplied by the model.
 */
import { VISION_WORKSHOP_OPERATIONS } from './vision-workshop-operations.js';
import { EDGE_LLM_OPERATIONS } from './edge-llm-operations.js';
import { DATA_CENTER_OPERATIONS } from './data-center-operations.js';
import { DATA_CENTER_VISION_OPERATIONS } from './data-center-vision-operations.js';
import { GRAFANA_ASSISTANT_OPERATIONS } from './grafana-assistant-operations.js';

export type PlatformOperationMetadata = {
  /** Capability visibility only; the HTTP handler still enforces tenant authorization. */
  tenantAccessible: boolean;
  group: string;
  description: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
};

const tenantView = '可选管理员数据视角：已存在的租户 ID；platform 或省略为平台视角。租户身份仍由原路由限定。';
const days30 = '可选回看天数，1–90，默认 30。';
const minutes240 = '可选回看分钟数，5–20160，默认 240。';
const boardSpec = '看板定义：windowMinutes(5–20160)；可选 range:{fromMs,toMs}（跨度≤14天）、filters:{service}、variables≤20({name,label,type:custom/textbox,value,options})；panels≤48，每项按面板定义，支持 OTLP 与完整 PromQL。';
const boardPanel = '面板定义：title、metric；source 为 otlp(默认)或 prometheus；Prometheus queries≤8({refId,expr,legendFormat,instant})，保留完整表达式，metric可为空；可选 chart(line/bar/stat/table)、width(1/2)、windowMinutes、unit、reducer(last/sum/avg/min/max)、warnValue、critValue、libraryId。';
const strategyBody: Record<string, string> = {
  name: '必填策略名称，1–80 字符。',
  description: '可选策略说明，最多 300 字符。',
  enabled: '可选启用状态，默认 true。',
  notificationChannel: '可选 default/none/feishu/dingtalk/wecom/slack/telegram/webhook，默认 default。',
  rules: '必填 1–10 条规则；每项含 query(≤2000字符 PromQL)、durationSeconds(0–86400)、comparator(gt/gte/lt/lte/eq/ne)、threshold(有限数)、severity(warning/critical)、可选 sendIntervalMinutes(0–1440)、noDataAlert(boolean)。',
};
const capturePlanBody: Record<string, string> = {
  targetId: '必填服务端已配置的设备目标 ID，最多 64 字符；先列 targets。',
  profileId: '可选 x5-isp/runtime；省略时按问题选择相机 ISP 或运行日志模板。',
  question: '可选调查问题，最多 2000 字符。',
  sourceIds: '可选 1–3 个该目标已配置日志来源 ID；不能传入命令或连接参数。',
};

export const PLATFORM_OPERATION_METADATA: Record<string, PlatformOperationMetadata> = {
  ...RSI_LEARNING_OPERATIONS,
  ...RSI_FAILURE_OPERATIONS,
  ...GRAFANA_ASSISTANT_OPERATIONS,
  ...VISION_WORKSHOP_OPERATIONS,
  ...VISION_CALIBRATION_OPERATIONS,
  ...EDGE_LLM_OPERATIONS,
  ...DATA_CENTER_OPERATIONS,
  ...DATA_CENTER_VISION_OPERATIONS,
  ...COLLECTION_WORKSPACE_OPERATIONS,
  ...PLUGIN_OPERATIONS,
  'GET /api/ops/observability/access': {
    tenantAccessible: false,
    group: '平台总览', description: '读取当前请求的运营访问状态和管理员标志。',
  },
  'GET /api/ops/observability/overview': {
    tenantAccessible: true,
    group: '平台总览', description: '读取检查、事故、告警状态、行动队列、SLO 和低敏运行链路列表；租户视角按原路由隔离。',
    query: {
      hours: '可选回看小时数，1–168，默认 24。', tenant: tenantView,
      traceEnvironment: '可选 production/staging/development/test，默认 production。',
      traceLimit: '可选链路分页大小，1–80，默认 40。',
      traceCursor: '可选上一页返回的服务端分页游标，最多 4096 字符。',
      traceRunId: '可选精确匹配的原始 Run ID，最多 200 字符；列表返回匿名 runRef 与详情 locator。',
    },
  },
  'GET /api/ops/observability/search': {
    tenantAccessible: true,
    group: '平台总览', description: '搜索对象和事故，返回状态与工作台跳转路径；保留原租户过滤。',
    query: { q: '可选关键词，最多 120 字符。', limit: '可选返回上限，1–50，默认 12。', tenant: tenantView },
  },
  'GET /api/ops/observability/account-activity': {
    tenantAccessible: false,
    group: '账号行为', description: '按 SSO ID 或用户名聚合运行、会话、用量、配置审计、登录审计和事故；管理员专用。',
    query: { identifier: '必填被查询账号的 SSO ID 或用户名。', hours: '可选回看小时数，1–8760，默认 168。' },
  },
  'GET /api/ops/observability/account-activity/events': {
    tenantAccessible: false,
    group: '账号行为', description: '查询指定账号的运维事件明细；管理员专用。',
    query: { identifier: '必填被查询账号的 SSO ID 或用户名。', hours: '可选回看小时数，1–8760，默认 168。', limit: '可选条数，1–200，默认 200。', eventCode: '可选事件码，最多 80 字符。' },
  },
  'GET /api/ops/observability/config': {
    tenantAccessible: true,
    group: '告警配置', description: '读取告警定义、阈值、通知渠道和拨测配置；秘密字段只返回是否配置，租户身份仅获得只读标志。',
  },
  'PUT /api/ops/observability/config': {
    tenantAccessible: false,
    group: '告警配置', description: '按补丁更新告警配置并记录配置审计；先读取当前配置以保留现有规则。',
    body: {
      global: '可选全局告警设置的局部补丁，字段沿用 GET config 的 global。',
      notification: '可选通知设置局部补丁；渠道/模板/影子模式及渠道秘密按现有配置字段提交；clear* 标志可清除对应已保存秘密。',
      synthetic: '可选业务拨测设置局部补丁；clearPassword 可清除已保存拨测密码。',
      logSignatures: '可选日志采样规则局部补丁，字段沿用 GET config 的 logSignatures。',
      rules: '可选以规则 key 为键的阈值/窗口/样本下限/通知渠道局部补丁；审计署名由服务器产生。',
      pinRuleKeys: '可选字符串数组，将只存在于默认配置中的指定规则显式固定到配置文件。',
    },
  },
  'POST /api/ops/observability/run-checks': {
    tenantAccessible: false,
    group: '告警配置', description: '立即启动一轮告警 worker 检查与评估；使用现有 systemd 服务。',
  },
  'POST /api/ops/observability/test-notification': {
    tenantAccessible: false,
    group: '告警配置', description: '向已配置渠道真实投递测试通知并记录投递结果。',
    body: { channel: '可选 feishu/dingtalk/wecom/slack/telegram/webhook，省略使用默认通知渠道。' },
  },
  'GET /api/ops/observability/maintenance-windows': {
    tenantAccessible: false,
    group: '告警维护窗口', description: '列出平台维护窗口及静默结束时间。',
  },
  'POST /api/ops/observability/maintenance-windows': {
    tenantAccessible: false,
    group: '告警维护窗口', description: '创建维护窗口，静默通知投递并继续记录事故；仅运营管理员。',
    body: { alertKey: '可选单条规则 key；空字符串或省略表示全部规则。', minutes: '必填持续分钟数，5–10080。', reason: '必填维护原因，至少 3 字符。' },
  },
  'DELETE /api/ops/observability/maintenance-windows/:windowId': {
    tenantAccessible: false,
    group: '告警维护窗口', description: '按正整数 windowId 删除维护窗口，恢复后续评估的通知投递。',
  },
  'GET /api/ops/observability/strategies': {
    tenantAccessible: true,
    group: '告警策略', description: '列出自定义告警策略及当前身份是否可写；租户视角合并本租户和平台公共层。',
    query: { tenant: tenantView },
  },
  'POST /api/ops/observability/strategies': {
    tenantAccessible: true,
    group: '告警策略', description: '创建含 PromQL 规则的告警策略；平台管理员或本租户 SSO owner 可写。',
    query: { tenant: tenantView }, body: strategyBody,
  },
  'PUT /api/ops/observability/strategies/:strategyId': {
    tenantAccessible: true,
    group: '告警策略', description: '完整更新指定 strategyId 的告警策略；需管理员或该租户 SSO owner 权限。',
    body: strategyBody,
  },
  'DELETE /api/ops/observability/strategies/:strategyId': {
    tenantAccessible: true,
    group: '告警策略', description: '删除指定 strategyId 的告警策略；原路由校验租户 owner 或管理员权限。',
  },
  'GET /api/ops/observability/incidents': {
    tenantAccessible: true,
    group: '事故处置', description: '分页列出事故，可按当前操作者、状态、严重度和目标过滤。',
    query: { scope: '可选 mine/all，默认 all。', state: '可选 active/closed/all，默认 all。', severity: '可选 critical/warning。', target: '可选目标关键词，最多 200 字符。', days: days30, limit: '可选每页条数，1–200，默认 50。', offset: '可选分页偏移，0–100000，默认 0。', tenant: tenantView },
  },
  'GET /api/ops/observability/alerts/:alertKey/evidence': {
    tenantAccessible: true,
    group: '事故调查', description: '读取指定告警发生时的账号、版本、客户端、模块和失败样本快照；保留原路由的租户鉴权。',
    query: { at: '可选告警发生时间，带时区的 ISO 时间；精确匹配历史快照，省略时读取该规则最近快照。', tenant: tenantView },
  },
  'GET /api/ops/observability/incidents/summary': {
    tenantAccessible: true,
    group: '事故处置', description: '读取事故汇总与趋势，按当前身份或管理员租户视角过滤。',
    query: { days: '可选回看天数，1–90，默认 7。', tenant: tenantView },
  },
  'POST /api/ops/observability/incidents/:incidentKey/actions': {
    tenantAccessible: true,
    group: '事故处置', description: '确认、指派、静默、重开、关闭事故或添加备注；SSO 组员仅能处置本租户事故，探针 token 保持只读。',
    body: { action: '必填 acknowledge/assign/silence/reopen/close/note。', assignee: 'assign 时必填被指派操作者，最多 160 字符。', minutes: 'silence 时指定静默分钟数，服务端限制 5–10080。', reason: 'silence 时必填原因，最多400字符；close/note 时必填解决方案/备注，2–500字符；其他动作可省略。' },
  },
  'GET /api/ops/observability/incidents/:alertKey/correlate': {
    tenantAccessible: false,
    group: '事故调查', description: '按事故 alertKey 汇聚事故窗口内异常指标、错误日志和离线设备证据。',
  },
  'GET /api/ops/observability/copilot/status': {
    tenantAccessible: false,
    group: '事故调查', description: '查询事故副驾模型研判是否已启用。',
  },
  'POST /api/ops/observability/copilot/analysis': {
    tenantAccessible: false,
    group: '事故调查', description: '让已配置模型根据证据索引进行事故研判；返回证据引用，不执行处置。',
    body: { question: '可选事故调查问题。', evidenceIndex: '必填非空真实证据索引数组，每项含 ref/kind/label。', posture: '可选运行态势对象，字段 openIncidents、criticalIncidents、aiErrors。', warning: '可选证据覆盖或数据可用性警示字符串数组，最多6项，每项≤160字符。' },
  },
  'GET /api/ops/observability/metrics/series': {
    tenantAccessible: false,
    group: '指标查询', description: '列出已落库指标序列和标签，可按指标或被观察 SSO 用户过滤。',
    query: { metric: '可选指标名，最多 96 字符。', ssoUserId: '可选被观察用户的 SSO ID，最多 120 字符。', limit: '可选序列上限，1–500，默认 200。' },
  },
  'GET /api/ops/observability/metrics/query': {
    tenantAccessible: false,
    group: '指标查询', description: '查询指标时间序列，支持最近窗口或绝对时间范围，跨度 5 分钟至 14 天。',
    query: { metric: '可选指标名，最多 96 字符。', ssoUserId: '可选被观察用户的 SSO ID，最多 120 字符。', minutes: minutes240, fromMs: '可选起始毫秒时间戳；与 toMs 指定绝对范围。', toMs: '可选结束毫秒时间戳，默认当前时间。', points: '可选聚合点数，20–500，默认 240。' },
  },
  'GET /api/ops/observability/metrics/anomalies': {
    tenantAccessible: false,
    group: '指标查询', description: '扫描最近指标异常，最多返回 50 个候选异常。',
    query: { minutes: '可选扫描窗口分钟数，30–20160，默认 240。', threshold: '可选异常判定阈值，有限数；省略使用服务默认值。' },
  },
  'GET /api/ops/observability/metrics/catalog': {
    tenantAccessible: false,
    group: '指标查询', description: '读取指标中文名称、说明、标签和 OTLP/Prometheus/动态前缀归属。',
  },
  'POST /api/ops/observability/nl-query': {
    tenantAccessible: false,
    group: '指标查询', description: '把自然语言问题解析成真实指标查询 spec；使用已落库指标索引。',
    body: { question: '必填非空自然语言指标问题。' },
  },
  'GET /api/ops/observability/prom/query': {
    tenantAccessible: false,
    group: '指标查询', description: '通过已配置 Prometheus 执行有界 PromQL 范围查询，返回最多 24 个序列。',
    query: { query: '必填有效 PromQL，最多 2000 字符。', minutes: minutes240 },
  },
  'GET /api/ops/observability/logs/facets': {
    tenantAccessible: false,
    group: '日志查询', description: '读取最近 14 天日志筛选维度。',
  },
  'GET /api/ops/observability/logs': {
    tenantAccessible: false,
    group: '日志查询', description: '查询落库低敏日志，可按 service、接入对象 owner 和严重度过滤。',
    query: { service: '可选 service 名称前缀，最多 160 字符。', owner: '可选日志来源 owner，最多 160 字符。', severityMin: '可选最低严重度，1–24，默认 1；9=INFO，13=WARN，17=ERROR。', minutes: minutes240, limit: '可选条数，1–500，默认 100。' },
  },
  'GET /api/ops/observability/sessions': {
    tenantAccessible: false,
    group: '运行链路', description: '读取受治理保护的会话链路分页列表；保留原上下文守卫和治理就绪检查。',
    query: { environment: '可选 production/staging/development/test，默认 production。', hours: '可选回看小时数，1–168，默认 24。', limit: '可选分页大小，1–80，默认 40。', cursor: '可选上一页服务端返回的游标，最多 4096 字符。' },
  },
  'GET /api/ops/observability/runs/:locator': {
    tenantAccessible: false,
    group: '运行链路', description: '按 overview 返回的加密 locator 读取完整运行证据；禁止用原始 Run ID 代替 locator，保留治理授权与审计。',
  },
  'GET /api/ops/observability/events/:eventId': {
    tenantAccessible: false,
    group: '运行链路', description: '按 UUID eventId 读取运维事件详情、低敏上下文和关联运行信息。',
  },
  'GET /api/ops/observability/objects': {
    tenantAccessible: false,
    group: '对象资产', description: '读取对象资产页的聚合目录，合并运行目录与持久化 OTLP 注册表；查询全部观测对象、服务和设备等资产的总量、类型与列表时使用，返回 generatedAt/total/limit/objects 快照。',
    query: { team: '可选团队。', objectType: '可选对象类型。', q: '可选关键词。', ownerTeam: '可选负责团队。', owner_team: 'ownerTeam 的兼容别名。', label: '可选标签，最多 64 字符。', archived: '可选是否归档，boolean。', limit: '可选上限，1–200，默认 200。' },
  },
  'GET /api/ops/observability/objects/:objectId': {
    tenantAccessible: false,
    group: '对象资产', description: '读取指定 objectId 的对象画像、汇总和最近运行。',
    query: { team: '可选团队。', objectType: '可选对象类型。', projectId: '可选项目 ID。', environment: '可选运行环境。', service: '可选服务。', status: '可选 queued/running/completed/failed/cancelled。', windowMinutes: '可选回看分钟数，1–10080，默认 1440。' },
  },
  'GET /api/ops/observability/object-registry': {
    tenantAccessible: false,
    group: '对象资产', description: '仅列出接入对象注册记录的显示名、标签、来源和信号类型；用于查询接入来源或注册信息，不包含完整运行资产目录，不能替代 /objects 的聚合资产列表。',
  },
  'POST /api/ops/observability/object-registry': {
    tenantAccessible: false,
    group: '对象资产', description: '手动登记观测对象并记录审计。',
    body: { objectType: '必填对象类型，例如 service/host/device/robot/project/database/gateway。', objectId: '必填对象 ID。', displayName: '可选显示名。', labels: '可选键值标签对象。' },
  },
  'PATCH /api/ops/observability/object-registry': {
    tenantAccessible: false,
    group: '对象资产', description: '编辑指定来源 owner 和 objectId 对象的显示名与标签。',
    body: { owner: '必填注册表中该对象的来源 owner，不是调用者身份。', objectId: '必填对象 ID。', displayName: '可选新显示名。', labels: '可选新键值标签对象。' },
  },
  'DELETE /api/ops/observability/object-registry': {
    tenantAccessible: false,
    group: '对象资产', description: '删除手动登记对象；自动发现对象仍由其接入信号维护。',
    query: { owner: '必填对象来源 owner；手动登记通常为 manual。', objectId: '必填对象 ID。' },
  },
  'GET /api/ops/observability/object-bindings': {
    tenantAccessible: false,
    group: '对象资产', description: '列出告警规则与观测对象的生效绑定和默认映射。',
  },
  'PUT /api/ops/observability/object-bindings': {
    tenantAccessible: false,
    group: '对象资产', description: '更新规则与对象的自定义绑定，后续告警评估使用新映射。',
    body: { bindings: '必填以规则 key 为键、objectId 为值的对象，最多 200 项；null 或空字符串恢复默认绑定。' },
  },
  'GET /api/ops/observability/database': {
    tenantAccessible: false,
    group: '数据库资产', description: '读取 PostgreSQL 运行状态、只读资产目录和有界聚合。',
    query: { hours: '可选回看小时数，1–720，默认 24。' },
  },
  'GET /api/ops/observability/database/tables/:tableName': {
    tenantAccessible: false,
    group: '数据库资产', description: '分页预览白名单数据库表或导出脱敏 CSV；不接受 SQL，CSV 返回认证下载地址。',
    query: { format: '可选 json/csv，默认 json；csv 导出整表。', schema: '可选 schema 名称，默认 public，最多 128 字符。', sort: '可选目录中实际存在的排序列。', direction: '可选 asc/desc。', page: 'JSON 预览页码，1–2000，默认 1。', pageSize: 'JSON 每页行数，1–50，默认 25。' },
  },
  'GET /api/ops/observability/learning': {
    tenantAccessible: false,
    group: '运营洞察', description: '读取技能数据闭环、经验与进化的只读投影；各模块独立报告可用性。',
    query: { days: days30 },
  },
  'GET /api/ops/observability/operator-metrics': {
    tenantAccessible: false,
    group: '运营洞察', description: '读取按天聚合的运营指标。',
    query: { days: '可选回看天数，1–180，默认 30。' },
  },
  'GET /api/ops/observability/quality/summary': {
    tenantAccessible: false,
    group: '运营洞察', description: '读取运行评分、评测和反馈趋势。',
    query: { days: days30 },
  },
  'GET /api/ops/observability/runs/iteration-cycle': {
    tenantAccessible: false,
    group: '运营洞察', description: '读取失败到重试、失败到下次成功的迭代间隔分布。',
    query: { days: days30 },
  },
  'GET /api/ops/observability/boards': {
    tenantAccessible: false,
    group: '自定义看板', description: '列出自己的私有看板与运营团队共享看板，editable标明是否为原作者。',
  },
  'GET /api/ops/observability/boards/templates': {
    tenantAccessible: false,
    group: '自定义看板', description: '读取可复制的业务看板模板、实际指标来源及数据源要求；不创建看板。',
  },
  'POST /api/ops/observability/boards/query': {
    tenantAccessible: false,
    group: '自定义看板', description: '只读执行一个 OTLP 或 Prometheus 面板查询并返回时间序列和警告；不保存面板或看板。',
    body: { panel: boardPanel, windowMinutes: minutes240, range: '可选绝对毫秒时间范围，跨度5分钟至14天。', variables: '可选变量名到单个字符串字面值的映射；不接受任意表达式。', filters: '可选OTLP受控标签筛选；Prometheus筛选需写入查询匹配器。' },
  },
  'POST /api/ops/observability/boards': {
    tenantAccessible: false,
    group: '自定义看板', description: '创建当前运营身份拥有的自定义看板。',
    body: { name: '可选看板名，1–120 字符，默认未命名看板。', spec: `可选${boardSpec}`, visibility: '可选private(默认)或team；team仅已有平台运营权限的账号可查看。' },
  },
  'POST /api/ops/observability/boards/import': {
    tenantAccessible: false,
    group: '自定义看板', description: '导入 d-obs 或 Grafana 看板 JSON 模板，返回映射与跳过结果。',
    body: { template: '必填 d-obs 看板模板或 Grafana dashboard JSON 对象。' },
  },
  'POST /api/ops/observability/boards/from-nl': {
    tenantAccessible: false,
    group: '自定义看板', description: '根据自然语言描述和实际落库指标生成并保存看板。',
    body: { question: '必填看板需求，最多 500 字符。' },
  },
  'PUT /api/ops/observability/boards/:boardId': {
    tenantAccessible: false,
    group: '自定义看板', description: '更新当前身份拥有的指定 boardId 看板名称或完整面板定义。',
    body: { name: '可选新看板名，1–120 字符。', spec: `可选${boardSpec}`, visibility: '可选private或team；仅原作者可修改或撤销共享。' },
  },
  'DELETE /api/ops/observability/boards/:boardId': {
    tenantAccessible: false,
    group: '自定义看板', description: '删除当前身份拥有的指定 boardId 看板。',
  },
  'GET /api/ops/observability/boards/:boardId/export/grafana': {
    tenantAccessible: false,
    group: '自定义看板', description: '导出当前身份的指定 boardId 看板为 Grafana dashboard JSON，返回认证下载地址。',
  },
  'GET /api/ops/observability/library/panels': {
    tenantAccessible: false,
    group: '面板库', description: '列出当前运营身份保存的可复用库面板。',
  },
  'POST /api/ops/observability/library/panels': {
    tenantAccessible: false,
    group: '面板库', description: '新增或更新库面板；更新已有 id 时同步当前身份看板中的引用面板。',
    body: { id: '可选已有库面板 ID；省略时新增。', panel: `必填${boardPanel}` },
  },
  'DELETE /api/ops/observability/library/panels/:panelId': {
    tenantAccessible: false,
    group: '面板库', description: '删除当前身份拥有的指定 panelId 库面板。',
  },
  'GET /api/ops/observability/devices': {
    tenantAccessible: false,
    group: '边缘设备', description: '列出已注册边缘设备、在线状态、最近心跳及离线时间阈值。',
  },
  'POST /api/ops/observability/devices': {
    tenantAccessible: false,
    group: '边缘设备', description: '注册边缘设备并签发一次性明文设备 token；响应中的秘密须由用户妥善保存。',
    body: { deviceId: '必填设备 ID。', displayName: '可选显示名。', tenantId: '可选设备所属租户 ID。', model: '可选设备型号。', labels: '可选键值标签对象。' },
  },
  'POST /api/ops/observability/devices/:deviceId/token': {
    tenantAccessible: false,
    group: '边缘设备', description: '轮换指定 deviceId 的设备 token，旧 token 立即失效，新明文只返回一次。',
  },
  'POST /api/ops/observability/devices/:deviceId/status': {
    tenantAccessible: false,
    group: '边缘设备', description: '启用或停用指定 deviceId 的设备接入。',
    body: { status: '必填 active/disabled。' },
  },
  'GET /api/ops/observability/devices/:deviceId/samples': {
    tenantAccessible: false,
    group: '边缘设备', description: '读取指定 deviceId 的心跳指标样本。',
    query: { minutes: minutes240, points: '可选聚合点数，20–500，默认 240。' },
  },
  'GET /api/ops/observability/devices/:deviceId/commands': {
    tenantAccessible: false,
    group: '边缘设备', description: '列出指定 deviceId 已下发命令及认领、执行状态。',
  },
  'POST /api/ops/observability/devices/:deviceId/commands': {
    tenantAccessible: false,
    group: '边缘设备', description: '向设备下发白名单 ping、采样间隔调整或 agent 更新命令，并记录审计。',
    body: { type: '必填 ping/set-interval/update-agent。', payload: 'set-interval 需 {intervalSeconds:5–3600}；ping/update-agent 为 {}，不接受任意脚本。' },
  },
  'GET /api/ops/observability/ingest-tokens': {
    tenantAccessible: false,
    group: '接入凭据', description: '列出生态接入凭据元信息和状态，历史明文 token 不可读取。',
  },
  'POST /api/ops/observability/ingest-tokens': {
    tenantAccessible: false,
    group: '接入凭据', description: '签发 user/service/tenant 生态接入凭据；明文 token 只返回一次。',
    body: { subjectType: '必填 user/service/tenant。', subjectId: '必填接入主体 ID。', displayName: '可选显示名。', labels: '可选键值标签对象。' },
  },
  'POST /api/ops/observability/ingest-tokens/:tokenId/rotate': {
    tenantAccessible: false,
    group: '接入凭据', description: '轮换指定 tokenId 的生态接入凭据，旧 token 失效，新明文只返回一次。',
  },
  'POST /api/ops/observability/ingest-tokens/:tokenId/revoke': {
    tenantAccessible: false,
    group: '接入凭据', description: '吊销指定 tokenId 的生态接入凭据并更新鉴权缓存。',
  },
  'POST /api/ops/observability/selftest/metric': {
    tenantAccessible: false,
    group: '接入自检', description: '经真实 OTLP ingest 管线写入一个 rdk.obs.selftest 测试指标；约 5 秒后可查。',
  },
  'POST /api/ops/observability/selftest/log': {
    tenantAccessible: false,
    group: '接入自检', description: '经真实 OTLP ingest 管线写入一条测试日志；约 5 秒后可按 INFO 查询。',
  },
  'GET /api/ops/observability/model-prices': {
    tenantAccessible: false,
    group: '模型成本', description: '列出每百万输入、输出 token 的模型单价及币种。',
  },
  'PUT /api/ops/observability/model-prices/:model': {
    tenantAccessible: false,
    group: '模型成本', description: '更新指定 model 的输入、输出 token 单价并记录审计。',
    body: { inputPerM: '必填每百万输入 token 单价，非负有限数。', outputPerM: '必填每百万输出 token 单价，非负有限数。', currency: '可选币种，沿用模型价格服务默认值。' },
  },
  'GET /api/ops/observability/model-pool': {
    tenantAccessible: false,
    group: '模型池', description: '读取模型目标健康状态、脱敏路由配置和受保护的 Agent 主路由。',
  },
  'POST /api/ops/observability/model-pool/probe': {
    tenantAccessible: false,
    group: '模型池', description: '对模型池单目标发起一次真实探测并更新健康统计。',
    body: { model: '必填现有模型目标名称，1–120 字符。' },
  },
  'POST /api/ops/observability/model-pool/cleanup': {
    tenantAccessible: false,
    group: '模型池', description: '清理没有路由引用的模型目标；服务端重新检查目标未被使用，Agent 主路由受保护。',
    body: { frontendModel: '可选关联映射名称；不能为受保护 Agent 主路由。', target: '必填 {baseUrl,model}；baseUrl 为 HTTP/HTTPS 且≤512字符，model≤160字符。', confirm: '必填 CLEANUP，表示明确确认该清理操作。' },
  },
  'PUT /api/ops/observability/model-pool/routing': {
    tenantAccessible: false,
    group: '模型池', description: '调整模型映射的 fallback 顺序和权重；保留 Agent 主路由保护与审计。',
    body: { frontendModel: '必填现有 frontend 映射名称，不能为受保护 Agent 主路由。', fallbacks: '必填不重复的 fallback 名称数组，最多 8 个；可为空数组。', weight: '可选路由权重，0–1000 的有限数。' },
  },
  'PUT /api/ops/observability/model-pool/replace': {
    tenantAccessible: false,
    group: '模型池', description: '真实预探测新模型目标，通过后替换映射并保存不含 Key 的旧目标快照。',
    body: { frontendModel: '必填待替换映射名称，不能为受保护 Agent 主路由。', target: '必填 {baseUrl,model,apiKey,label?}；baseUrl 必须 HTTPS，apiKey 为20–512字符且只用于本次提交。', confirm: '必填 REPLACE，表示明确确认该替换操作。' },
  },
  'POST /api/ops/observability/model-pool/rollback': {
    tenantAccessible: false,
    group: '模型池', description: '从最近替换审计恢复旧目标；需重新提供旧 Key，预探测通过后才写入。',
    body: { frontendModel: '必填待回滚映射名称，不能为受保护 Agent 主路由。', apiKey: '必填原目标 Key，20–512 字符，仅本次提交；快照不保存 Key。', confirm: '必填 ROLLBACK，表示明确确认该回滚操作。' },
  },
  'GET /api/ops/observability/tenants': {
    tenantAccessible: false,
    group: '租户管理', description: '列出租户及组员数，平台管理员专用。',
  },
  'POST /api/ops/observability/tenants': {
    tenantAccessible: false,
    group: '租户管理', description: '创建租户并返回一次性明文探针 token；平台管理员专用。',
    body: { tenantId: '必填新租户 ID。', displayName: '可选租户显示名。' },
  },
  'POST /api/ops/observability/tenants/:tenantId/token': {
    tenantAccessible: true,
    group: '租户管理', description: '轮换指定 tenantId 的探针 token；平台管理员或本租户 SSO owner 可执行，旧 token 立即失效。',
  },
  'POST /api/ops/observability/tenants/:tenantId/status': {
    tenantAccessible: false,
    group: '租户管理', description: '启用或停用指定 tenantId；平台管理员专用。',
    body: { status: '必填 active/disabled。' },
  },
  'GET /api/ops/observability/tenants/:tenantId/members': {
    tenantAccessible: true,
    group: '租户组员', description: '列出租户组员；管理员和该租户 SSO 组员可读，探针 token 不可读取。',
  },
  'POST /api/ops/observability/tenants/:tenantId/members': {
    tenantAccessible: true,
    group: '租户组员', description: '添加指定租户的 SSO 组员；需平台管理员或本租户 owner 权限。',
    body: { ssoUserId: '必填被添加组员的 SSO ID。', displayName: '可选组员显示名。', role: '可选 owner/member，默认 member。' },
  },
  'POST /api/ops/observability/tenants/:tenantId/members/:ssoUserId/role': {
    tenantAccessible: true,
    group: '租户组员', description: '调整指定组员的角色；服务端防止降级最后一名 owner。',
    body: { role: '必填 owner/member。' },
  },
  'DELETE /api/ops/observability/tenants/:tenantId/members/:ssoUserId': {
    tenantAccessible: true,
    group: '租户组员', description: '删除指定租户组员；需管理员或本租户 owner，最后一名 owner 受保护。',
  },
  'GET /api/ops/observability/remediation': {
    tenantAccessible: false,
    group: '证据行动环', description: '读取白名单自愈剧本、当前启用状态和近期执行结果。',
  },
  'POST /api/ops/observability/actions/evidence-proof': {
    tenantAccessible: false,
    group: '证据行动环', description: '校验当前账户可访问的事件证据，签发短时证据 proof；web-cloud 需有 SSO 身份的运营管理员。',
    body: { evidenceRefs: '必填 1–32 个真实 event:<UUID> 引用；环境与账户归属由服务器核验。' },
  },
  'GET /api/ops/observability/actions': {
    tenantAccessible: false,
    group: '证据行动环', description: '列出当前认证账户范围的行动和来源采纳统计；保留 SSO 身份与上下文守卫。',
    query: { limit: '可选行动返回条数，1–100，默认20。' },
  },
  'POST /api/ops/observability/actions': {
    tenantAccessible: false,
    group: '证据行动环', description: '凭已签发 proof 创建调查、观察、升级或自愈提案；自愈仍须后续独立审批和执行。',
    body: { type: '必填 investigate/observe/escalate/remediate。', title: '必填提案标题，最多 240 字符。', rationale: '可选证据化理由，最多 500 字符。', playbookId: 'remediate 时指定现有白名单剧本 ID，最多 96 字符；其他类型不可提供。', evidenceRefs: '必填与 evidence-proof 返回一致的事件引用数组。', evidenceProof: '必填 evidence-proof 端点签发的有效短时 proof。', requiresApproval: '可选 boolean；仅 investigate/observe 可显式设false，escalate/remediate始终需要审批。', origin: '可选 human/ai-copilot；助手生成提案应使用 ai-copilot。' },
  },
  'GET /api/ops/observability/actions/:id': {
    tenantAccessible: false,
    group: '证据行动环', description: '读取当前账户可访问的行动详情、审批、执行与验证状态；id 为 action-UUID。',
  },
  'GET /api/ops/observability/actions/:id/regression': {
    tenantAccessible: false,
    group: '证据行动环', description: '读取当前账户行动绑定的真实验收结果回归案例；包含内容哈希与证据引用，不代表诊断准确率。',
    query: { download: '可选 1，导出安全案例 JSON 附件。' },
  },
  'POST /api/ops/observability/actions/:id/repropose': {
    tenantAccessible: false,
    group: '证据行动环', description: '为 failed/verification_failed 行动重建提案，重新验证原证据并重新进入审批。',
  },
  'POST /api/ops/observability/actions/:id/decision': {
    tenantAccessible: false,
    group: '证据行动环', description: '批准或拒绝当前身份可访问的行动；自愈提案人不能自批，审批必须保持原权限与有效期。',
    body: { decision: '必填 approve/deny。' },
  },
  'POST /api/ops/observability/actions/:id/complete': {
    tenantAccessible: false,
    group: '证据行动环', description: '完成已经批准的只读调查、观察或升级行动；自愈需执行与后置验证。',
  },
  'POST /api/ops/observability/actions/:id/execute': {
    tenantAccessible: false,
    group: '证据行动环', description: '执行已审批且仍有效的白名单自愈行动，使用 CAS 避免并发重复执行；可能返回执行中。',
  },
  'POST /api/ops/observability/actions/:id/verify': {
    tenantAccessible: false,
    group: '证据行动环', description: '按精确 remediation run 验证执行中行动；运行未可见时保留两分钟宽限，更新验收或失败状态。',
  },
  'POST /api/ops/observability/actions/:id/regression': {
    tenantAccessible: false,
    group: '证据行动环', description: '把独立验收过的行动结果保存为带哈希的评测案例，再绑定到行动；未独立验收或结果未知时拒绝，不代表诊断准确率。',
    body: { marker: '可选旧客户端兼容字段，服务端忽略；回归引用由真实案例 ID 与内容哈希生成。' },
  },
  'GET /api/ops/observability/ssh-logs/targets': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '列出服务端已配置的 SSH 日志目标和来源；不返回连接秘密，不依赖中心数据库。',
  },
  'GET /api/ops/observability/ssh-logs/sessions': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '列出当前身份的 SSH 日志采集会话。',
  },
  'POST /api/ops/observability/ssh-logs/sessions': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '启动有界 SSH 日志采集，使用已配置目标和来源；会占用 SSH 资源与本地存储。',
    body: { targetId: '必填已配置目标 ID。', sourceId: '必填该目标已配置来源 ID。', lines: '可选初始行数，0–10000，默认 200。', durationSeconds: '可选采集秒数，5–1800，默认 300。', follow: '可选是否持续跟踪，默认 true。' },
  },
  'GET /api/ops/observability/ssh-logs/sessions/:id': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '分页读取当前身份拥有的 SSH 会话日志快照，保留序列游标以继续读取。',
    query: { after: '可选上次读取的序列号，默认 0，非负安全整数。', limit: '可选条数，1–500，默认 500。' },
  },
  'POST /api/ops/observability/ssh-logs/sessions/:id/stop': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '停止当前身份拥有的 SSH 日志采集会话并保存尾部输出。',
  },
  'GET /api/ops/observability/ssh-logs/sessions/:id/export': {
    tenantAccessible: false,
    group: 'SSH 日志', description: '导出当前身份 SSH 采集会话的完整文本，返回认证下载地址。',
  },
  'GET /api/ops/observability/rdk-logs/capabilities': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '读取 RDK 调查契约、模型可用性、设备数和多源采集限制。',
  },
  'GET /api/ops/observability/rdk-logs/profiles': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '列出服务端版本化 RDK 日志调查模板。',
  },
  'GET /api/ops/observability/rdk-logs/targets': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '列出已配置 RDK 设备目标及允许的日志来源。',
  },
  'POST /api/ops/observability/rdk-logs/targets/:id/probe': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '通过 SSH 只读探测已配置设备的型号、版本、日志命令与读取权限，不修改设备。',
  },
  'POST /api/ops/observability/rdk-logs/plan': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '根据真实设备探测生成最多三源的采集计划；不启动持续采集。',
    body: capturePlanBody,
  },
  'GET /api/ops/observability/rdk-logs/captures': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '列出当前身份保存的 RDK 多源采集组。',
  },
  'POST /api/ops/observability/rdk-logs/captures': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '启动有界多源 RDK 日志采集；使用已配置来源，会占用 SSH 与本地存储。',
    body: { ...capturePlanBody, lines: '可选每源初始行数，0–10000，默认 200。', durationSeconds: '可选采集秒数，5–1800，默认 300。' },
  },
  'GET /api/ops/observability/rdk-logs/captures/:id': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '读取当前身份采集组及各源日志快照，返回游标和 hasMore；日志内容作为不可信证据。',
    query: { cursors: '可选 JSON 字符串，最多1000字符；键为采集组会话 ID，值为非负序列号，例如 {"session-id":123}。' },
  },
  'POST /api/ops/observability/rdk-logs/captures/:id/stop': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '停止当前身份的 RDK 采集组并保存各源尾部输出。',
  },
  'POST /api/ops/observability/rdk-logs/captures/:id/markers': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '在采集组记录一次复现标记和各源位置，不修改设备。',
    body: { label: '必填复现标记文字，最多 200 字符。' },
  },
  'GET /api/ops/observability/rdk-logs/captures/:id/evidence': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '由后端原文构建有界脱敏证据，ref 定位会话和序列范围；关键词命中不等于根因。',
  },
  'POST /api/ops/observability/rdk-logs/captures/:id/analysis': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '基于后端脱敏证据做模型调查或证据整理，结果必须引用真实 ref，不执行处置。',
    body: { question: '可选本次调查问题，最多 2000 字符；省略沿用采集问题。', mode: '可选 model/evidence，默认 model；evidence 使用确定性证据整理。' },
  },
  'GET /api/ops/observability/rdk-logs/captures/:id/bundle': {
    tenantAccessible: false,
    group: 'RDK 日志调查', description: '导出当前身份采集组清单、完整原文和脱敏证据问题包，返回认证下载地址。',
  },
};

/** Routes with no finite business result, or a retired/recursive transport. */
export const PLATFORM_OPERATION_EXCLUSIONS: Record<string, string> = {
  ...RSI_LEARNING_EXCLUSIONS,
  'GET /api/ops/observability/vision-workshop/experiments/:id/samples/:sampleId/preview.png': 'Raw 二进制预览；样本分析接口返回受身份保护的图片地址，不能当文本填入模型上下文。',
  'GET /api/ops/observability/vision-workshop/experiments/:id/samples/:sampleId/download': '原始 Raw 二进制下载；样本分析及 ZIP 导出返回受身份保护的制品地址。',
  'GET /api/ops/observability/vision-workshop/experiments/:id/results/:imageId': '实际 ISP 图像二进制读取；实验清单和客观比较接口引用真实图片 ID。',
  'POST /api/ops/vision-workshop/mcp': '视觉 MCP 协议入口；由 reviewed 视觉原子 REST 能力覆盖，避免递归传输。',
  'POST /api/ops/mcp': 'MCP 协议入口；通过平台 REST 能力目录查询与执行，避免递归调用工具传输。',
  'POST /api/ops/rdk-logs/mcp': 'RDK MCP 协议入口；其功能由 /api/ops/observability/rdk-logs 下 REST 路由覆盖。',
  'POST /api/ops/observability/remediate': '已退役，固定返回 410 action_proposal_required；改用 evidence-proof、actions、decision、execute 与 verify。',
  'POST /api/ops/observability/run-evolution': '已退役，固定返回 410 action_proposal_required；使用证据化行动 API，保留原白名单与审批限制。',
};

/** Downloads return an authenticated URL instead of filling model context. */
export const PLATFORM_OPERATION_DOWNLOADS: string[] = [
  'GET /api/ops/observability/vision-workshop/plugin-packages/:kind/download',
  'GET /api/ops/observability/vision-workshop/experiments/:id/tuning',
  'GET /api/ops/observability/vision-workshop/experiments/:id/bundle',
  'GET /api/ops/observability/database/tables/:tableName', // Only when format=csv.
  'GET /api/ops/observability/boards/:boardId/export/grafana',
  'GET /api/ops/observability/ssh-logs/sessions/:id/export',
  'GET /api/ops/observability/rdk-logs/captures/:id/bundle',
];
