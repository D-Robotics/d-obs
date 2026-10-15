import type { JsonSchema, PluginPackage } from './plugin-types.js';
import { validatePluginPackage } from './plugin-runtime.js';
import { CAMERA_WORKSHOP_PLUGIN_TEMPLATE } from './plugin-camera-workshop.js';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const platformArguments: JsonSchema = object({
  params: { type: 'object', additionalProperties: { type: 'string', maxLength: 256 } },
  query: { type: 'object', additionalProperties: true },
});
const overview = {
  id: 'overview', description: '读取当前身份允许的平台总览，保留服务端权限与租户隔离。', inputSchema: platformArguments,
  source: { type: 'platform', operationId: 'GET /api/ops/observability/overview' }, defaults: { query: { hours: '${config.hours}', traceLimit: 10 } },
};
const logs = {
  id: 'recent-errors', description: '读取真实错误日志；中心库不可用时返回失败。', inputSchema: platformArguments,
  source: { type: 'platform', operationId: 'GET /api/ops/observability/logs' },
  defaults: { query: { minutes: '${config.minutes}', severityMin: 17, limit: 30 } },
};
const configSchema = object({
  hours: { type: 'integer', minimum: 1, maximum: 168, description: '平台总览回看小时数' },
  minutes: { type: 'integer', minimum: 5, maximum: 20160, description: '日志回看分钟数' },
}, ['hours', 'minutes']);

/** These editable examples are catalog entries; creating a runtime never installs them. */
export const BUILTIN_PLUGIN_TEMPLATES: PluginPackage[] = [
  validatePluginPackage({
    schemaVersion: 1, id: 'rdk-device-diagnostics', version: '1.0.0', label: 'RDK 设备诊断',
    description: '设备清单、近期错误与平台总览组成可复用诊断包；所有数据复用已注册的只读平台接口。',
    dependencies: [], configSchema,
    tools: [
      { id: 'devices', description: '读取已注册 RDK 设备、在线状态与最近心跳。', inputSchema: platformArguments,
        source: { type: 'platform', operationId: 'GET /api/ops/observability/devices' } },
      { id: 'device-samples', description: '提供 params.deviceId，读取指定 RDK 的真实心跳指标样本。',
        inputSchema: object({ params: object({ deviceId: { type: 'string', minLength: 1, maxLength: 64 } }, ['deviceId']),
          query: object({ minutes: { type: 'integer', minimum: 5, maximum: 20160 }, points: { type: 'integer', minimum: 20, maximum: 500 } }) }, ['params']),
        source: { type: 'platform', operationId: 'GET /api/ops/observability/devices/:deviceId/samples' }, defaults: { query: { minutes: 240, points: 80 } } },
      overview, logs,
    ],
    dataSources: [
      { id: 'devices', toolId: 'devices', resultPath: 'data.devices' },
      { id: 'overview', toolId: 'overview', resultPath: 'data.overview' },
      { id: 'recent-errors', toolId: 'recent-errors', resultPath: 'data.logs' },
    ],
    panels: [
      { id: 'devices', title: 'RDK 设备与在线状态', dataSourceId: 'devices', kind: 'table', columns: [
        { key: 'deviceId', label: '设备' }, { key: 'model', label: '型号' }, { key: 'online', label: '在线' }, { key: 'lastSeenAt', label: '最近心跳' },
      ] },
      { id: 'open-incidents', title: '待处理事故', dataSourceId: 'overview', kind: 'stat', valuePath: 'summary.openIncidents', unit: '起' },
      { id: 'recent-errors', title: '近期错误证据', dataSourceId: 'recent-errors', kind: 'table' },
    ],
    workflows: [{ id: 'diagnostic-evidence', title: '收集设备诊断证据', steps: [
      { toolId: 'devices', label: '设备与心跳状态' }, { toolId: 'overview', label: '平台健康与事故' }, { toolId: 'recent-errors', label: '近期错误日志' },
    ] }],
    prompts: [{ id: 'diagnostic-guide', text: '先查看设备在线状态，再检查平台事故和错误日志。区分已有证据、推断和缺失数据；给出下一步只读调查建议，引用真实执行凭据。' }],
  }, { hours: 24, minutes: 240 }),
  validatePluginPackage({
    schemaVersion: 1, id: 'observability-health', version: '1.0.0', label: '可观测健康巡检',
    description: '通过平台总览和真实错误日志检查可观测服务健康，包含可编辑参数、面板、巡检流程和提示词。',
    dependencies: [], configSchema, tools: [overview, logs],
    dataSources: [{ id: 'overview', toolId: 'overview', resultPath: 'data.overview' }, { id: 'errors', toolId: 'recent-errors', resultPath: 'data.logs' }],
    panels: [
      { id: 'healthy-checks', title: '健康检查', dataSourceId: 'overview', kind: 'stat', valuePath: 'summary.healthyChecks', unit: '项' },
      { id: 'critical-incidents', title: '严重事故', dataSourceId: 'overview', kind: 'stat', valuePath: 'summary.criticalIncidents', unit: '起' },
      { id: 'checks', title: '检查状态', dataSourceId: 'overview', kind: 'table', valuePath: 'checks', columns: [
        { key: 'title', label: '检查项' }, { key: 'status', label: '状态' }, { key: 'summary', label: '证据' },
      ] },
      { id: 'errors', title: '近期错误日志', dataSourceId: 'errors', kind: 'table' },
    ],
    workflows: [{ id: 'health-review', title: '可观测健康巡检', steps: [
      { toolId: 'overview', label: '检查与事故' }, { toolId: 'recent-errors', label: '错误证据' },
    ] }],
    prompts: [{ id: 'health-guide', text: '根据真实健康检查、事故与错误日志形成巡检结论。明确数据时间窗和缺失数据，对异常提出可验证的下一步调查。' }],
  }, { hours: 24, minutes: 240 }),
  CAMERA_WORKSHOP_PLUGIN_TEMPLATE,
];
