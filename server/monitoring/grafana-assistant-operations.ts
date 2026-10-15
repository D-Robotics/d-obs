/** Explicit native Grafana reads; no proxy transport, writes or credentials are published. */
export const GRAFANA_ASSISTANT_API = '/api/ops/observability/grafana';

type GrafanaOperationDeclaration = {
  tenantAccessible: boolean; group: string; description: string; query?: Record<string, string>;
};

export const GRAFANA_ASSISTANT_OPERATIONS: Record<string, GrafanaOperationDeclaration> = {
  [`GET ${GRAFANA_ASSISTANT_API}/dashboards`]: {
    tenantAccessible: false, group: 'Grafana 原生大盘',
    description: '读取原生 Grafana 看板目录、实际 UID、标题、文件夹和标签；与 d-obs 自定义看板分开。最多返回100项，mayHaveMore表示本次查询可能未覆盖全部。',
    query: { q: '可选标题关键词，最多120字符。', limit: '可选目录返回上限，1–100，默认100。' },
  },
  [`GET ${GRAFANA_ASSISTANT_API}/dashboards/:uid`]: {
    tenantAccessible: false, group: 'Grafana 原生大盘',
    description: '按真实目录 UID 读取 Grafana 看板面板、数据源引用和完整有界 PromQL；缺少 UID 时先调用 Grafana dashboards 目录查询。仅返回查询定义，不代表实时指标。需要当前指标数据时，可用现有 prom/query 查询未脱敏且无模板变量的 PromQL。原生看板写入归 ops/grafana provisioning 管理，本次不提供原生写操作。',
  },
  [`GET ${GRAFANA_ASSISTANT_API}/datasources`]: {
    tenantAccessible: false, group: 'Grafana 原生大盘',
    description: '读取原生 Grafana 数据源的 UID、名称、类型、默认状态和只读属性；不返回URL、账号、密码、请求头或秘密配置。',
  },
};
