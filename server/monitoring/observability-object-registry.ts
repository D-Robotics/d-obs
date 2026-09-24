import os from 'node:os';
/**
 * 告警对象自动注册表：OTLP resource attributes → 监控对象。
 *
 * 设计口径（三期统一接入）：任何接入方（应用 / 端侧设备 / 服务器 agent）只要以
 * OTLP 上报，resource 里的身份属性（device.id / robot.id / host.name / service.name /
 * project.id）就自动登记为告警对象——对象注册从此不需要手工维护，告警、看板、
 * 处置都挂在同一个对象模型上。登记是尽力而为（fire-and-forget），失败不影响摄入主链路。
 *
 * 规则↔对象绑定（studio_obs_object_bindings）：ALERT_RULE_OBJECT_TARGETS 的代码映射
 * 是默认兜底，数据库里的自定义绑定优先生效——绑定从此可在工作台编辑，不需要发版。
 */
import { getOpsObservabilityPool } from './observability-store.js';
import { ALERT_RULE_OBJECT_TARGETS, alertRuleObjectTarget } from './alert-config.js';

export type RegisteredObject = {
  owner: string;
  objectId: string;
  objectType: string;
  displayName: string;
  labels: Record<string, unknown>;
  signalKinds: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

type RegistryPool = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

let schemaReady: Promise<void> | null = null;

async function ensureRegistrySchema(p: RegistryPool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await p.query(
        `create table if not exists public.studio_obs_object_registry (
      owner text not null,
      object_id text not null,
      object_type text not null default 'unknown'
        constraint studio_obs_object_registry_type_check
        check (object_type in ('service','host','device','robot','project','database','gateway','unknown')),
      display_name text not null default '',
      labels jsonb not null default '{}'::jsonb,
      signal_kinds text[] not null default '{}',
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      primary key (owner, object_id)
    )`,
      );
      // 类型枚举扩展（database/gateway）对已建表做幂等迁移
      await p
        .query(`alter table public.studio_obs_object_registry
        drop constraint if exists studio_obs_object_registry_type_check;
      alter table public.studio_obs_object_registry
        add constraint studio_obs_object_registry_type_check
        check (object_type in ('service','host','device','robot','project','database','gateway','unknown'))`)
        .catch(() => undefined);
      // 规则↔对象自定义绑定（代码映射 ALERT_RULE_OBJECT_TARGETS 是默认兜底）
      await p.query(
        `create table if not exists public.studio_obs_object_bindings (
      rule_key text primary key,
      object_id text not null,
      updated_by text not null default '',
      updated_at timestamptz not null default now()
    )`,
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function resetRegistrySchemaForTest(): void {
  schemaReady = null;
}

function text(value: unknown, max = 160): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
        .replace(/\0/g, '')
        .trim()
        .slice(0, max)
    : '';
}

/** 从 resource attributes 推导对象身份：设备 > 机器人 > 主机 > 服务 > 项目。 */
function identityFromAttributes(
  attrs: Record<string, unknown>,
): { objectId: string; objectType: string; displayName: string } {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = text(attrs[key]);
      if (value) return value;
    }
    return '';
  };
  const device = pick('device.id', 'rdk.device.id');
  if (device) return { objectId: `device/${device}`, objectType: 'device', displayName: device };
  const robot = pick('robot.id', 'rdk.robot.id');
  if (robot) return { objectId: `robot/${robot}`, objectType: 'robot', displayName: robot };
  const host = pick('host.name', 'host.id');
  if (host) return { objectId: `host/${host}`, objectType: 'host', displayName: host };
  const service = pick('service.name');
  if (service) return { objectId: `service/${service}`, objectType: 'service', displayName: service };
  const project = pick('project.id');
  if (project) return { objectId: `project/${project}`, objectType: 'project', displayName: project };
  return { objectId: 'unknown/anonymous', objectType: 'unknown', displayName: '未声明身份' };
}

const ARRAY_KEY: Record<string, string> = {
  metrics: 'resourceMetrics',
  logs: 'resourceLogs',
  traces: 'resourceSpans',
};

/** 从一份 OTLP payload 提取 resource 并登记对象；多个 group 去重后逐个 upsert。 */
export async function registerObjectsFromOtlp(
  body: Record<string, unknown>,
  owner: string,
  kind: keyof typeof ARRAY_KEY,
): Promise<number> {
  const arrayKey = ARRAY_KEY[kind];
  if (!arrayKey) return 0;
  const groups = Array.isArray(body[arrayKey]) ? (body[arrayKey] as Array<Record<string, unknown>>) : [];
  if (!groups.length) return 0;
  const seen = new Map<string, { attrs: Record<string, unknown> }>();
  for (const group of groups) {
    const resource =
      group.resource && typeof group.resource === 'object'
        ? ((group.resource as Record<string, unknown>).attributes as unknown)
        : null;
    const attrs: Record<string, unknown> = {};
    if (Array.isArray(resource)) {
      for (const item of resource.slice(0, 64)) {
        const row = (item ?? {}) as Record<string, unknown>;
        const key = text(row.key, 120);
        if (!key) continue;
        const value = (row.value ?? {}) as Record<string, unknown>;
        attrs[key] =
          value.stringValue ?? value.int_value ?? value.doubleValue ?? value.bool_value ?? '';
      }
    } else if (resource && typeof resource === 'object') {
      Object.assign(attrs, resource as Record<string, unknown>);
    }
    const identity = identityFromAttributes(attrs);
    if (!seen.has(identity.objectId)) seen.set(identity.objectId, { attrs });
  }
  if (!seen.size) return 0;
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  for (const [objectId, { attrs }] of seen) {
    const identity = identityFromAttributes(attrs);
    await p.query(
      `insert into public.studio_obs_object_registry
         (owner, object_id, object_type, display_name, labels, signal_kinds)
       values ($1, $2, $3, $4, $5::jsonb, array[$6::text])
       on conflict (owner, object_id) do update set
         labels = excluded.labels,
         signal_kinds = case
           when public.studio_obs_object_registry.signal_kinds @> array[$6::text]
             then public.studio_obs_object_registry.signal_kinds
           else public.studio_obs_object_registry.signal_kinds || array[$6::text] end,
         last_seen_at = now()`,
      [
        text(owner, 160) || 'anonymous',
        objectId,
        identity.objectType,
        identity.displayName,
        JSON.stringify(attrs),
        kind,
      ],
    ).catch(error => console.warn('[object-registry] upsert failed:', error && error.message));
  }
  return seen.size;
}

/** 平台已知实体自登记：服务器主机 + 自家服务/网关/数据库（每轮 worker 触发，幂等）。 */
export async function registerPlatformObjects(): Promise<number> {
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  const host = text(os.hostname(), 120) || 'production-host';
  const ipEnv = text(process.env.RDK_NODE_PUBLIC_IP, 64);
  const ipSelf = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n && !n.internal && n.family === 'IPv4')?.address;
  const ip = ipEnv || text(ipSelf, 64);
  const objects: Array<{ objectId: string; objectType: string; displayName: string; labels: Record<string, unknown>; kind: string }> = [
    { objectId: `host/${host}`, objectType: 'host', displayName: host, labels: { role: 'production', signal_source: 'node_exporter', ...(ip ? { ip } : {}) }, kind: 'metrics' },
    { objectId: 'service/d-obs', objectType: 'service', displayName: 'd-obs 可观测平台', labels: { signal_source: 'self' }, kind: 'metrics' },
    { objectId: 'service/rdkstudio-web', objectType: 'service', displayName: 'rdkstudio 主站应用', labels: { signal_source: 'synthetic-probe' }, kind: 'metrics' },
    { objectId: 'gateway/model-3100-3101', objectType: 'gateway', displayName: '模型网关 3100/3101', labels: { signal_source: 'target-health' }, kind: 'metrics' },
    { objectId: 'database/postgresql', objectType: 'database', displayName: 'PostgreSQL 中心库', labels: { signal_source: 'log-signature' }, kind: 'logs' },
  ];
  for (const item of objects) {
    await p
      .query(
        `insert into public.studio_obs_object_registry
           (owner, object_id, object_type, display_name, labels, signal_kinds)
         values ('platform', $1, $2, $3, $4::jsonb, array[$5::text])
         on conflict (owner, object_id) do update set
           display_name = excluded.display_name,
           labels = excluded.labels,
           last_seen_at = now()`,
        [item.objectId, item.objectType, item.displayName, JSON.stringify(item.labels), item.kind],
      )
      .catch((error) => console.warn('[object-registry] platform upsert failed:', error && error.message));
  }
  return objects.length;
}

export async function listRegisteredObjects(ownerFilter?: string): Promise<RegisteredObject[]> {
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  const result = await p.query(
    `select owner, object_id, object_type, display_name, labels, signal_kinds, first_seen_at, last_seen_at
     from public.studio_obs_object_registry
     ${ownerFilter ? 'where owner = $1' : ''}
     order by last_seen_at desc
     limit 200`,
    ownerFilter ? [ownerFilter] : [],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  return result.rows.map((row) => ({
    owner: String(row.owner ?? ''),
    objectId: String(row.object_id ?? ''),
    objectType: String(row.object_type ?? 'unknown'),
    displayName: String(row.display_name ?? ''),
    labels:
      row.labels && typeof row.labels === 'object' ? (row.labels as Record<string, unknown>) : {},
    signalKinds: Array.isArray(row.signal_kinds) ? row.signal_kinds.map(String) : [],
    firstSeenAt: row.first_seen_at ? new Date(String(row.first_seen_at)).toISOString() : null,
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
  }));
}

/** —— 规则↔对象绑定：代码映射为默认兜底，studio_obs_object_bindings 自定义覆盖 —— */

export type EffectiveAlertRuleObjectBinding = {
  ruleKey: string;
  objectId: string;
  source: 'default' | 'custom';
};

/** 纯函数：静态映射 + 自定义行 → 生效绑定（自定义优先）。供测试直接断言。 */
export function computeEffectiveBindings(
  staticTargets: Record<string, string>,
  customRows: Array<{ rule_key: unknown; object_id: unknown }>,
): EffectiveAlertRuleObjectBinding[] {
  const custom = new Map<string, string>();
  for (const row of customRows) {
    const key = text(row.rule_key, 160);
    const objectId = text(row.object_id, 160);
    if (key && objectId) custom.set(key, objectId);
  }
  const keys = new Set<string>([...Object.keys(staticTargets), ...custom.keys()]);
  return [...keys]
    .sort()
    .map((ruleKey) => ({
      ruleKey,
      objectId: custom.get(ruleKey) ?? alertRuleObjectTarget(ruleKey),
      source: custom.has(ruleKey) ? ('custom' as const) : ('default' as const),
    }));
}

let bindingsCache: { rows: Array<{ rule_key: string; object_id: string }>; loadedAt: number } | null = null;
const BINDINGS_CACHE_TTL_MS = 60_000;

async function loadCustomBindingRows(p: RegistryPool): Promise<Array<{ rule_key: string; object_id: string }>> {
  if (bindingsCache && Date.now() - bindingsCache.loadedAt < BINDINGS_CACHE_TTL_MS) {
    return bindingsCache.rows;
  }
  await ensureRegistrySchema(p);
  const result = await p
    .query(`select rule_key, object_id from public.studio_obs_object_bindings`)
    .catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const rows = result.rows
    .map((row) => ({ rule_key: text(row.rule_key, 160), object_id: text(row.object_id, 160) }))
    .filter((row) => row.rule_key && row.object_id);
  bindingsCache = { rows, loadedAt: Date.now() };
  return rows;
}

/** 生效绑定列表（自定义覆盖 + 代码默认兜底），供工作台绑定编辑器。 */
export async function listAlertRuleObjectBindings(): Promise<{ bindings: EffectiveAlertRuleObjectBinding[] }> {
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  const custom = await loadCustomBindingRows(p);
  return { bindings: computeEffectiveBindings(ALERT_RULE_OBJECT_TARGETS, custom) };
}

/**
 * 事故/通知的对象解析：自定义绑定优先，miss 回代码默认（含 service/<key> 动态兜底）。
 * 返回原始映射值（'host/self' 由调用方解析为本机主机名，租户命名空间由调用方拼装）。
 */
export async function resolveAlertRuleObjectTarget(ruleKey: string): Promise<string> {
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  const custom = await loadCustomBindingRows(p);
  const hit = custom.find((row) => row.rule_key === ruleKey);
  return hit ? hit.object_id : alertRuleObjectTarget(ruleKey);
}

/** 保存/清除一条自定义绑定（objectId=null 清除，回默认）。 */
export async function setAlertRuleObjectBinding(
  ruleKey: string,
  objectId: string | null,
  updatedBy: string,
): Promise<void> {
  const key = text(ruleKey, 160);
  if (!key) throw new Error('invalid_rule_key');
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  if (objectId == null || !String(objectId).trim()) {
    await p.query(`delete from public.studio_obs_object_bindings where rule_key = $1`, [key]);
  } else {
    const target = text(objectId, 160);
    if (!/^[a-z]+\/.+/.test(target)) throw new Error('invalid_object_id');
    await p.query(
      `insert into public.studio_obs_object_bindings (rule_key, object_id, updated_by)
       values ($1, $2, $3)
       on conflict (rule_key) do update set object_id = excluded.object_id, updated_by = excluded.updated_by, updated_at = now()`,
      [key, target, text(updatedBy, 120)],
    );
  }
  bindingsCache = null;
}

/** —— 注册表编辑：显示名 / 标签 / 手动登记 / 手动条目删除 —— */

const OBJECT_ID_PATTERN = /^[a-z]+\/[^\s/]+(?:\/[^\s/]+)*$/;

export function sanitizeRegistryLabels(
  input: unknown,
): { labels: Record<string, string> } | { error: string } {
  if (input == null) return { labels: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'invalid_labels' };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 16) return { error: 'invalid_labels' };
  const labels: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = text(rawKey, 120);
    if (!key) return { error: 'invalid_labels' };
    const value = text(rawValue, 120);
    labels[key] = value;
  }
  return { labels };
}

/** 手动登记对象（owner='manual'；OTLP 自动上报的同名对象仍走各自 owner，互不覆盖）。 */
export async function registerManualObject(input: {
  objectType: string;
  objectId: string;
  displayName?: string;
  labels?: unknown;
}): Promise<{ objectId: string; objectType: string; displayName: string }> {
  const objectType = text(input.objectType, 40);
  if (!['service', 'host', 'device', 'robot', 'project', 'database', 'gateway', 'unknown'].includes(objectType)) {
    throw new Error('invalid_object_type');
  }
  const objectId = text(input.objectId, 160);
  if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error('invalid_object_id');
  const labels = sanitizeRegistryLabels(input.labels);
  if ('error' in labels) throw new Error(labels.error);
  const displayName = text(input.displayName, 160) || objectId;
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  await p.query(
    `insert into public.studio_obs_object_registry
       (owner, object_id, object_type, display_name, labels, signal_kinds)
     values ('manual', $1, $2, $3, $4::jsonb, ARRAY['manual'::text])
     on conflict (owner, object_id) do update set
       object_type = excluded.object_type,
       display_name = excluded.display_name,
       labels = excluded.labels,
       last_seen_at = now()`,
    [objectId, objectType, displayName, JSON.stringify(labels.labels)],
  );
  return { objectId, objectType, displayName };
}

/** 编辑注册表条目元数据（显示名/标签）；owner+objectId 定位。 */
export async function updateRegisteredObjectIdentity(
  owner: string,
  objectId: string,
  patch: { displayName?: unknown; labels?: unknown },
): Promise<boolean> {
  const ownerKey = text(owner, 160);
  const idKey = text(objectId, 160);
  if (!ownerKey || !idKey) throw new Error('invalid_object_id');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.displayName !== undefined) {
    params.push(text(patch.displayName, 160));
    sets.push(`display_name = $${params.length}`);
  }
  if (patch.labels !== undefined) {
    const labels = sanitizeRegistryLabels(patch.labels);
    if ('error' in labels) throw new Error(labels.error);
    params.push(JSON.stringify(labels.labels));
    sets.push(`labels = $${params.length}::jsonb`);
  }
  if (!sets.length) throw new Error('nothing_to_update');
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  params.push(ownerKey, idKey);
  const result = await p.query(
    `update public.studio_obs_object_registry set ${sets.join(', ')} where owner = $${params.length - 1} and object_id = $${params.length}`,
    params,
  );
  return Boolean(result && result.rowCount);
}

/** 删除手动登记的条目；auto（platform/OTLP owner）条目不允许从这里删——它们会在下一轮自动回归。 */
export async function deleteManualObject(owner: string, objectId: string): Promise<boolean> {
  const ownerKey = text(owner, 160);
  const idKey = text(objectId, 160);
  if (!ownerKey || !idKey) throw new Error('invalid_object_id');
  if (ownerKey !== 'manual') throw new Error('manual_objects_only');
  const p = (await getOpsObservabilityPool()) as unknown as RegistryPool;
  await ensureRegistrySchema(p);
  const result = await p.query(
    `delete from public.studio_obs_object_registry where owner = 'manual' and object_id = $1`,
    [idKey],
  );
  return Boolean(result && result.rowCount);
}

export const __testables = {
  identityFromAttributes,
  resetRegistrySchemaForTest,
  computeEffectiveBindings,
  sanitizeRegistryLabels,
  OBJECT_ID_PATTERN,
};
