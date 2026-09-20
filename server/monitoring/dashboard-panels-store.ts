/**
 * 自定义面板：把常用指标查询（metric + 时间窗）保存为一等卡片。
 * 按 owner（SSO 账号或运营 token 身份）隔离；表结构与
 * tools/observability-signals-schema.sql 同源。
 */

export type PanelSpec = {
  metric: string;
  windowMinutes: number;
};

export type PanelRecord = {
  id: string;
  title: string;
  spec: PanelSpec;
  position: number;
  createdAt: string;
  updatedAt: string;
};

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('central database is not configured');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = (await import('pg' as string)) as {
        default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
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
create table if not exists public.studio_obs_dashboard_panels (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  owner text not null,
  spec jsonb not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_obs_dashboard_panels_owner_idx
  on public.studio_obs_dashboard_panels (owner, position);
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = p.query(ENSURE_SCHEMA_SQL).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

const METRIC_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,95}$/;

export function normalizePanelSpec(value: unknown): PanelSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const metric = String(input.metric ?? '').trim();
  if (!METRIC_PATTERN.test(metric)) return null;
  const windowMinutes = Math.trunc(Number(input.windowMinutes));
  if (!Number.isFinite(windowMinutes)) return null;
  return {
    metric,
    windowMinutes: Math.max(5, Math.min(60 * 24 * 14, windowMinutes)),
  };
}

function rowToPanel(row: Record<string, unknown>): PanelRecord {
  const spec = normalizePanelSpec(row.spec);
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    spec: spec ?? { metric: 'unknown', windowMinutes: 240 },
    position: Number(row.position ?? 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

export async function createPanel(input: {
  owner: string;
  title: string;
  spec: PanelSpec;
}): Promise<PanelRecord> {
  const p = await pool();
  await ensureSchema(p);
  const positionRow = await p.query(
    `select coalesce(max(position), -1) + 1 as next from public.studio_obs_dashboard_panels where owner = $1`,
    [input.owner],
  );
  const position = Math.trunc(Number(positionRow.rows[0]?.next ?? 0));
  const result = await p.query(
    `insert into public.studio_obs_dashboard_panels (title, owner, spec, position)
     values ($1, $2, $3::jsonb, $4) returning *`,
    [input.title, input.owner, JSON.stringify(input.spec), position],
  );
  return rowToPanel(result.rows[0] ?? {});
}

export async function listPanels(owner: string): Promise<PanelRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select * from public.studio_obs_dashboard_panels where owner = $1 order by position, created_at limit 100`,
    [owner],
  );
  return result.rows.map(rowToPanel);
}

export async function deletePanel(owner: string, panelId: string): Promise<boolean> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `delete from public.studio_obs_dashboard_panels where owner = $1 and id = $2`,
    [owner, panelId],
  );
  return (result.rowCount ?? 0) > 0;
}
