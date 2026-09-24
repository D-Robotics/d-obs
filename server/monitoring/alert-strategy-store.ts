/**
 * 自定义告警策略存储（吸收理想 op-observability「策略:规则行一对多」模型）。
 *
 * 策略 = 租户/平台（tenant_id='platform' 即公共层，所有租户可见）自定义的
 * PromQL 阈值告警：一条策略包含 1–10 条规则行（查询 + 持续时长 + 比较符 +
 * 阈值 + 级别 + 发送间隔 + 无数据告警）。恢复不需要独立条件——全部序列不再
 * 命中即恢复（见 alert-strategy-engine.ts）。
 *
 * 表结构幂等自建；DDL 与 tools/init-schema.sql 双向同步。写入走参数化查询；
 * 读写侧的租户过滤由路由层 resolveTenantScope 决定 scope 后传入。
 */
import { randomBytes, randomUUID } from 'node:crypto';

export const STRATEGY_COMPARATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'] as const;
export type StrategyComparator = (typeof STRATEGY_COMPARATORS)[number];

export const STRATEGY_SEVERITIES = ['warning', 'critical'] as const;
export type StrategySeverity = (typeof STRATEGY_SEVERITIES)[number];

export interface StrategyRuleRow {
  id: string;
  strategyId: string;
  position: number;
  query: string;
  durationSeconds: number;
  comparator: StrategyComparator;
  threshold: number;
  severity: StrategySeverity;
  sendIntervalMinutes: number;
  noDataAlert: boolean;
}

export interface AlertStrategy {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  notificationChannel: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  rules: StrategyRuleRow[];
}

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};
/** 引擎/路由侧共用的最小池接口（与相邻 store 同款结构类型，不依赖 pg 声明）。 */
export type StrategyPool = Pool;

let strategyPool: Promise<Pool> | null = null;
let testPool: Pool | null = null;

/** 回归测试注入点：整体替换默认池解析并重置 schema 缓存。 */
export function configureStrategyPoolForTest(p: Pool | null): void {
  testPool = p;
  schemaReady = null;
}

async function pool(): Promise<Pool> {
  if (testPool) return testPool;
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!strategyPool) {
    strategyPool = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      strategyPool = null;
      throw error;
    });
  }
  return strategyPool;
}

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await p.query(`
        create table if not exists public.studio_alert_strategies (
          id text primary key,
          tenant_id text not null default 'platform',
          name text not null,
          description text not null default '',
          enabled boolean not null default true,
          notification_channel text not null default 'default',
          created_by text not null default '',
          created_at timestamptz not null default now(),
          updated_by text not null default '',
          updated_at timestamptz not null default now()
        )
      `);
      await p.query(
        `create index if not exists studio_alert_strategies_tenant_idx
           on public.studio_alert_strategies (tenant_id)`,
      );
      await p.query(`
        create table if not exists public.studio_alert_strategy_rules (
          id text primary key,
          strategy_id text not null references public.studio_alert_strategies(id) on delete cascade,
          position int not null default 0,
          query text not null,
          duration_seconds int not null default 120,
          comparator text not null default 'gt',
          threshold double precision not null default 0,
          severity text not null default 'warning',
          send_interval_minutes int not null default 0,
          no_data_alert boolean not null default false
        )
      `);
      await p.query(
        `create index if not exists studio_alert_strategy_rules_strategy_idx
           on public.studio_alert_strategy_rules (strategy_id, position)`,
      );
      await p.query(`
        create table if not exists public.studio_alert_strategy_states (
          strategy_id text not null,
          rule_id text not null,
          series_key text not null,
          series_labels jsonb not null default '{}'::jsonb,
          first_hit_at timestamptz not null,
          last_hit_at timestamptz not null,
          last_value double precision,
          last_notify_at timestamptz,
          primary key (strategy_id, rule_id, series_key)
        )
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

/** 供引擎/路由复用（幂等，重复调用无副作用）。 */
export function ensureStrategyTables(p: Pool): Promise<void> {
  return ensureSchema(p);
}

/** 路由/引擎侧获取默认池（测试注入时返回测试池）。 */
export async function getStrategyPool(): Promise<Pool> {
  return pool();
}

function ruleRowToStrategyRule(row: Record<string, unknown>): StrategyRuleRow {
  return {
    id: String(row.id ?? ''),
    strategyId: String(row.strategy_id ?? ''),
    position: Number(row.position ?? 0),
    query: String(row.query ?? ''),
    durationSeconds: Number(row.duration_seconds ?? 120),
    comparator: (String(row.comparator ?? 'gt') as StrategyComparator),
    threshold: Number(row.threshold ?? 0),
    severity: row.severity === 'critical' ? 'critical' : 'warning',
    sendIntervalMinutes: Number(row.send_interval_minutes ?? 0),
    noDataAlert: row.no_data_alert === true,
  };
}

const STRATEGY_SELECT = `
  select s.id, s.tenant_id, s.name, s.description, s.enabled, s.notification_channel,
         s.created_by, s.created_at, s.updated_by, s.updated_at
    from public.studio_alert_strategies s`;

async function attachRules(p: Pool, strategies: AlertStrategy[]): Promise<AlertStrategy[]> {
  if (!strategies.length) return strategies;
  const ids = strategies.map((strategy) => strategy.id);
  const rulesResult = await p.query(
    `select id, strategy_id, position, query, duration_seconds, comparator, threshold,
            severity, send_interval_minutes, no_data_alert
       from public.studio_alert_strategy_rules
      where strategy_id = any($1::text[])
      order by strategy_id, position, id`,
    [ids],
  );
  const byStrategy = new Map<string, StrategyRuleRow[]>();
  for (const row of rulesResult.rows) {
    const rule = ruleRowToStrategyRule(row);
    const list = byStrategy.get(rule.strategyId) ?? [];
    list.push(rule);
    byStrategy.set(rule.strategyId, list);
  }
  return strategies.map((strategy) => ({
    ...strategy,
    rules: byStrategy.get(strategy.id) ?? [],
  }));
}

function rowToStrategy(row: Record<string, unknown>, rules: StrategyRuleRow[]): AlertStrategy {
  return {
    id: String(row.id ?? ''),
    tenantId: String(row.tenant_id ?? 'platform'),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    enabled: row.enabled === true,
    notificationChannel: String(row.notification_channel ?? 'default'),
    createdBy: String(row.created_by ?? ''),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updatedBy: String(row.updated_by ?? ''),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
    rules,
  };
}

/**
 * 可见策略清单：scope 非空 = 该租户视角（本租户 + platform 公共层合并可见，
 * 借鉴理想 WhereIn{0,tenantId} 的公共+私有语义）；scope null = 平台全局
 * （仅 platform 行）。
 */
export async function listStrategies(
  p: Pool,
  tenantScope: string | null,
): Promise<AlertStrategy[]> {
  await ensureSchema(p);
  const where =
    tenantScope != null
      ? `where s.tenant_id = $1::text or s.tenant_id = 'platform'`
      : `where s.tenant_id = 'platform'`;
  const result = await p.query(`${STRATEGY_SELECT} ${where} order by s.created_at desc`, tenantScope != null ? [tenantScope] : []);
  return attachRules(
    p,
    result.rows.map((row) => rowToStrategy(row, [])),
  );
}

export async function getStrategy(
  p: Pool,
  id: string,
): Promise<AlertStrategy | null> {
  await ensureSchema(p);
  const result = await p.query(`${STRATEGY_SELECT} where s.id = $1::text`, [id]);
  if (!result.rows[0]) return null;
  const [strategy] = await attachRules(p, [rowToStrategy(result.rows[0], [])]);
  return strategy;
}

export interface StrategyRuleInput {
  query: string;
  durationSeconds: number;
  comparator: StrategyComparator;
  threshold: number;
  severity: StrategySeverity;
  sendIntervalMinutes: number;
  noDataAlert: boolean;
}

export interface StrategyInput {
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  notificationChannel: string;
  rules: StrategyRuleInput[];
}

export function newStrategyId(): string {
  return randomBytes(5).toString('hex');
}

export function newStrategyRuleId(): string {
  return randomUUID();
}

export async function createStrategy(
  p: Pool,
  input: StrategyInput,
  actor: string,
): Promise<AlertStrategy> {
  await ensureSchema(p);
  const id = newStrategyId();
  const now = 'now()';
  await p.query(
    `insert into public.studio_alert_strategies
       (id, tenant_id, name, description, enabled, notification_channel, created_by, created_at, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, ${now}, $7, ${now})`,
    [
      id,
      input.tenantId,
      input.name,
      input.description,
      input.enabled,
      input.notificationChannel,
      actor,
    ],
  );
  await replaceStrategyRules(p, id, input.rules);
  const created = await getStrategy(p, id);
  if (!created) throw new Error('strategy_create_failed');
  return created;
}

async function replaceStrategyRules(
  p: Pool,
  strategyId: string,
  rules: StrategyRuleInput[],
): Promise<void> {
  await p.query(`delete from public.studio_alert_strategy_rules where strategy_id = $1::text`, [
    strategyId,
  ]);
  let position = 0;
  for (const rule of rules) {
    await p.query(
      `insert into public.studio_alert_strategy_rules
         (id, strategy_id, position, query, duration_seconds, comparator, threshold,
          severity, send_interval_minutes, no_data_alert)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newStrategyRuleId(),
        strategyId,
        position,
        rule.query,
        rule.durationSeconds,
        rule.comparator,
        rule.threshold,
        rule.severity,
        rule.sendIntervalMinutes,
        rule.noDataAlert,
      ],
    );
    position += 1;
  }
}

export async function updateStrategy(
  p: Pool,
  id: string,
  input: Omit<StrategyInput, 'tenantId'>,
  actor: string,
): Promise<AlertStrategy | null> {
  await ensureSchema(p);
  const result = await p.query(
    `update public.studio_alert_strategies
        set name = $2, description = $3, enabled = $4, notification_channel = $5,
            updated_by = $6, updated_at = now()
      where id = $1::text
      returning id`,
    [id, input.name, input.description, input.enabled, input.notificationChannel, actor],
  );
  if (!result.rows[0]) return null;
  await replaceStrategyRules(p, id, input.rules);
  return getStrategy(p, id);
}

export async function deleteStrategy(p: Pool, id: string): Promise<boolean> {
  await ensureSchema(p);
  // 规则行带 on delete cascade；状态行无外键，显式清理。
  await p.query(`delete from public.studio_alert_strategy_states where strategy_id = $1::text`, [
    id,
  ]);
  const result = await p.query(
    `delete from public.studio_alert_strategies where id = $1::text returning id`,
    [id],
  );
  return Boolean(result.rows[0]);
}

/** 评估引擎用：启用中的全部策略（平台 + 租户）。 */
export async function listEnabledStrategiesWithRules(p: Pool): Promise<AlertStrategy[]> {
  await ensureSchema(p);
  const result = await p.query(`${STRATEGY_SELECT} where s.enabled = true order by s.id`);
  return attachRules(
    p,
    result.rows.map((row) => rowToStrategy(row, [])),
  );
}
