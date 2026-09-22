/**
 * 库面板：跨看板复用的面板定义，按 owner 隔离。
 * v1 语义：从库面板添加 = 插入副本（不做引用联动/自动传播）。
 * 表结构与 tools/observability-signals-schema.sql 同源。
 */

import { normalizeBoardPanel, type BoardPanel } from './dashboard-boards-store.js';

export type LibraryPanelRecord = {
  id: string;
  panel: BoardPanel;
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
create table if not exists public.studio_obs_library_panels (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  panel jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_obs_library_panels_owner_idx
  on public.studio_obs_library_panels (owner, updated_at desc);
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

export const LIBRARY_PANELS_PER_OWNER_MAX = 100;

function rowToLibraryPanel(row: Record<string, unknown>): LibraryPanelRecord | null {
  const panel = normalizeBoardPanel(row.panel);
  if (!panel) return null;
  return {
    id: String(row.id ?? ''),
    panel,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

export async function listLibraryPanels(owner: string, limit = 100): Promise<LibraryPanelRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select * from public.studio_obs_library_panels where owner = $1 order by updated_at desc limit $2`,
    [owner, Math.max(1, Math.min(200, limit))],
  );
  return result.rows.map(rowToLibraryPanel).filter((item): item is LibraryPanelRecord => item !== null);
}

export async function saveLibraryPanel(input: {
  owner: string;
  panel: BoardPanel;
  id?: string;
}): Promise<LibraryPanelRecord> {
  const p = await pool();
  await ensureSchema(p);
  if (input.id) {
    const updated = await p.query(
      `update public.studio_obs_library_panels set panel = $3::jsonb, updated_at = now()
       where owner = $1 and id = $2 returning *`,
      [input.owner, input.id, JSON.stringify(input.panel)],
    );
    const row = updated.rows[0] ? rowToLibraryPanel(updated.rows[0]) : null;
    if (row) return row;
  }
  const count = await p.query(
    `select count(*)::int as total from public.studio_obs_library_panels where owner = $1`,
    [input.owner],
  );
  if (Number(count.rows[0]?.total ?? 0) >= LIBRARY_PANELS_PER_OWNER_MAX) {
    throw new Error('too_many_library_panels');
  }
  const inserted = await p.query(
    `insert into public.studio_obs_library_panels (owner, panel) values ($1, $2::jsonb) returning *`,
    [input.owner, JSON.stringify(input.panel)],
  );
  const row = rowToLibraryPanel(inserted.rows[0] ?? {});
  if (!row) throw new Error('invalid_library_panel');
  return row;
}

export async function deleteLibraryPanel(owner: string, id: string): Promise<boolean> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `delete from public.studio_obs_library_panels where owner = $1 and id = $2`,
    [owner, id],
  );
  return (result.rowCount ?? 0) > 0;
}
