/**
 * 告警配置的 PG 存储层（单例行，存原文 text）。
 *
 * 动机：告警配置此前只在本地 JSON 文件——多实例部署时 web 与 worker 各读各的
 * 文件，配置分叉且互相覆盖。这里把「同一份配置原文」放进中心库：
 *  - 读：PG 可达且行存在 → PG 原文优先；PG 可达但为空且文件有内容 → 自动导入；
 *    PG 不可用 → 回落文件（与历史行为一致）。
 *  - 写：保持原子文件写（面板最小 diff 写盘机制不变）+ 尽力同步 PG。
 *
 * 表结构与 ops 侧 DDL 注释同源；显式设 RDK_ALERT_CONFIG_PG=0 可整体关闭
 * （完全回到纯文件行为）。
 */

export type AlertConfigPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

let poolReady: Promise<AlertConfigPool> | null = null;
async function pool(): Promise<AlertConfigPool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => AlertConfigPool };
      };
      return new pgMod.default.Pool({ connectionString, max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

const ENSURE_SCHEMA_SQL = `
create table if not exists public.studio_alert_config (
  singleton boolean primary key default true check (singleton),
  raw_text text not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: AlertConfigPool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p.query(ENSURE_SCHEMA_SQL).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export function alertConfigPgStoreEnabled(): boolean {
  return String(process.env.RDK_ALERT_CONFIG_PG ?? '').trim() !== '0'
    && Boolean(String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim());
}

/** PG 里的配置原文；行为存在但不可解析/出错时抛错，由调用方决定回落。 */
export async function readAlertConfigRawText(): Promise<string | null> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select raw_text from public.studio_alert_config where singleton = true limit 1`,
  );
  const raw = result.rows[0]?.raw_text;
  return typeof raw === 'string' ? raw : null;
}

export async function writeAlertConfigRawText(text: string, updatedBy = ''): Promise<void> {
  const p = await pool();
  await ensureSchema(p);
  await p.query(
    `insert into public.studio_alert_config (singleton, raw_text, revision, updated_by)
     values (true, $1, 1, $2)
     on conflict (singleton) do update set
       raw_text = excluded.raw_text,
       revision = public.studio_alert_config.revision + 1,
       updated_at = now(),
       updated_by = excluded.updated_by`,
    [text, String(updatedBy ?? '').slice(0, 120)],
  );
}

/** 读失败告警节流：PG 故障时 worker 每分钟至多告警一次，不刷日志。 */
let lastWarnAt = 0;
export function warnAlertConfigStoreOnce(message: string): void {
  if (Date.now() - lastWarnAt < 60_000) return;
  lastWarnAt = Date.now();
  console.warn(`[alert-config] ${message}`);
}
