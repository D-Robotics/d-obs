import type { PlatformOperationMetadata } from './platform-operation-metadata.js';

export const PLUGIN_API = '/api/ops/observability/plugins';
const operation = (description: string, fields: Partial<PlatformOperationMetadata> = {}): PlatformOperationMetadata => ({ tenantAccessible: false, group: '插件与诊断', description, ...fields });
const revision = '必填当前插件 revision，防止覆盖其他操作者或晚到请求的更新。';
const args = '可选合法 JSON 对象；必须符合插件工具的 inputSchema，不得提供身份、请求头、任意 URL 或凭据。';
export const PLUGIN_OPERATIONS: Record<string, PlatformOperationMetadata> = {
  [`GET ${PLUGIN_API}/capabilities`]: operation('读取插件宿主能力、生命周期约定和安全的服务端 MCP 连接器清单。'),
  [`GET ${PLUGIN_API}/catalog`]: operation('读取当前账号的插件清单与可安装模板；模板存在不表示已安装或启用。'),
  [`GET ${PLUGIN_API}`]: operation('列出当前账号已安装插件、版本、草稿和启停状态。'),
  [`GET ${PLUGIN_API}/:id`]: operation('读取当前账号指定插件的配置、草稿、已发布版本与不可变历史。'),
  [`POST ${PLUGIN_API}/draft`]: operation('保存声明式插件包与配置的草稿；不发布、不执行诊断、不影响当前生效版本。', { body: { manifest: '必填 rdk.plugin.v1 声明，包含 id/version/tools/dataSources/panels/workflows/configSchema。', config: '必填配置 JSON 对象，不含凭据。', expectedRevision: '更新已有插件时必填当前 revision；首次创建省略。' } }),
  [`POST ${PLUGIN_API}/:id/publish`]: operation('校验并发布已保存草稿，登记实际工具、数据源和诊断流程；失败保持旧版本。', { body: { expectedRevision: revision } }),
  [`POST ${PLUGIN_API}/:id/enabled`]: operation('启用或停用当前账号插件；停用撤销执行登记并取消在途查询。', { body: { enabled: '必填真实布尔值。', expectedRevision: revision } }),
  [`POST ${PLUGIN_API}/:id/rollback`]: operation('恢复历史插件版本和配置，生成新的 revision；历史记录保留。', { body: { version: '必填历史 manifest.version 字符串。', expectedRevision: revision } }),
  [`DELETE ${PLUGIN_API}/:id`]: operation('卸载当前账号插件，撤销其登记；有依赖插件时拒绝，须先处理依赖。', { body: { expectedRevision: revision } }),
  [`GET ${PLUGIN_API}/:id/data/:sourceId`]: operation('实际执行已启用插件的数据源查询，返回真实数据与运行回执；未配置和读取失败不表示零值。', { query: { args } }),
  [`GET ${PLUGIN_API}/:id/tools/:toolId`]: operation('实际调用插件只读诊断工具，保留原业务权限与外部 MCP 的只读白名单。', { query: { args } }),
  [`POST ${PLUGIN_API}/:id/workflows/:workflowId/run`]: operation('按固定已发布版本运行只读诊断流程，返回逐步真实回执；不会执行设备动作或自动处置。', { body: { args } }),
};
