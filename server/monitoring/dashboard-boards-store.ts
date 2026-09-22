/**
 * 自定义看板：把面板（指标查询卡片）组织成可命名的看板，支持导入/导出模板。
 * 按 owner（SSO 账号或运营 token 身份）隔离；表结构与
 * tools/observability-signals-schema.sql 同源。
 * 取代旧的 studio_obs_dashboard_panels 扁平列表（旧数据在 ensureSchema 时
 * 一次性迁入每人一个「默认看板」）。
 */

export const BOARD_PANEL_CHARTS = ['line', 'bar', 'stat'] as const;
export type BoardPanelChart = (typeof BOARD_PANEL_CHARTS)[number];

export type BoardPanel = {
  title: string;
  metric: string;
  /** null = 跟随看板全局时间维度 */
  windowMinutes: number | null;
  chart: BoardPanelChart;
  /** 1 = 半宽，2 = 整行 */
  width: 1 | 2;
  /** stat 大数字阈值着色：最新值 ≥ warn 显示警示色，≥ crit 显示严重色 */
  warnValue: number | null;
  critValue: number | null;
};

export type BoardSpec = {
  windowMinutes: number;
  /** 绝对时间范围（看板 brush 缩放/自定义区间）；非空时优先于 windowMinutes */
  range: { fromMs: number; toMs: number } | null;
  /** 看板变量筛选：按 series.labels.service 过滤全部面板（空串 = 全部） */
  filters: { service: string } | null;
  panels: BoardPanel[];
};

export type BoardRecord = {
  id: string;
  name: string;
  spec: BoardSpec;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export const BOARD_WINDOW_MINUTES_MIN = 5;
export const BOARD_WINDOW_MINUTES_MAX = 60 * 24 * 14;
const BOARD_PANELS_MAX = 48;
const BOARDS_PER_OWNER_MAX = 20;
// OTLP 指标名天生带点号，正则必须放行。
const METRIC_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_.:]{0,127}$/;

export const DEFAULT_BOARD_SPEC: BoardSpec = { windowMinutes: 240, range: null, filters: null, panels: [] };

function clampWindow(value: unknown): number | null {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(BOARD_WINDOW_MINUTES_MIN, Math.min(BOARD_WINDOW_MINUTES_MAX, n));
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function parseThreshold(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeBoardPanel(value: unknown): BoardPanel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const title = cleanText(input.title, 120);
  const metric = String(input.metric ?? '').trim();
  if (!title || !METRIC_PATTERN.test(metric)) return null;
  const windowMinutes = input.windowMinutes == null ? null : clampWindow(input.windowMinutes);
  if (input.windowMinutes != null && windowMinutes == null) return null;
  const chart = BOARD_PANEL_CHARTS.includes(input.chart as BoardPanelChart)
    ? (input.chart as BoardPanelChart)
    : 'line';
  const width = Number(input.width) === 2 ? 2 : 1;
  return {
    title,
    metric,
    windowMinutes,
    chart,
    width,
    warnValue: parseThreshold(input.warnValue),
    critValue: parseThreshold(input.critValue),
  };
}

/** 绝对时间范围：非法/超跨度一律剥离为 null（不因坏 range 拒绝整个 spec）。 */
function parseBoardRange(value: unknown, nowMs: number): { fromMs: number; toMs: number } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const fromMs = Math.trunc(Number(input.fromMs));
  const toMs = Math.trunc(Number(input.toMs));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (fromMs < 0 || toMs <= fromMs) return null;
  if (toMs - fromMs > BOARD_WINDOW_MINUTES_MAX * 60_000) return null;
  if (fromMs > nowMs + 60_000) return null;
  return { fromMs, toMs };
}

/** 看板变量：目前仅 service 维度；结构不合法时整体剥离为 null（不因坏 filters 拒绝 spec）。 */
function parseBoardFilters(value: unknown): { service: string } | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const service = String((value as Record<string, unknown>).service ?? '').trim().slice(0, 120);
  if (!service) return null;
  return { service };
}

export function normalizeBoardSpec(value: unknown, nowMs: number = Date.now()): BoardSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const windowMinutes = clampWindow(input.windowMinutes ?? DEFAULT_BOARD_SPEC.windowMinutes);
  if (windowMinutes == null) return null;
  if (input.panels != null && !Array.isArray(input.panels)) return null;
  const panels: BoardPanel[] = [];
  for (const raw of (input.panels ?? []).slice(0, BOARD_PANELS_MAX)) {
    const panel = normalizeBoardPanel(raw);
    if (!panel) return null;
    panels.push(panel);
  }
  return { windowMinutes, range: parseBoardRange(input.range, nowMs), filters: parseBoardFilters(input.filters), panels };
}

/** 看板名：非空、去 \0、≤120 字符；不合法返回 null。 */
export function normalizeBoardName(value: unknown): string | null {
  const name = cleanText(value, 120);
  return name ? name : null;
}

/**
 * 导入模板解析：接受完整导出（{name, spec}）、{title, spec} 或裸 spec
 * （{windowMinutes, panels}）。返回 {name?, spec}，不合法返回 null。
 */
export function parseBoardTemplate(value: unknown): { name: string | null; spec: BoardSpec } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.spec && typeof input.spec === 'object') {
    const spec = normalizeBoardSpec(input.spec);
    if (!spec) return null;
    return { name: normalizeBoardName(input.name ?? input.title), spec };
  }
  const spec = normalizeBoardSpec(input);
  if (!spec) return null;
  return { name: null, spec };
}

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
create table if not exists public.studio_obs_dashboards (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  name text not null,
  spec jsonb not null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_obs_dashboards_owner_idx
  on public.studio_obs_dashboards (owner, position);
`;

// 旧扁平面板表（已停写）：存在则把每个 owner 的面板收进一个「默认看板」。
// insert-select 自带幂等（已有看板的 owner 被跳过）；表不存在时静默跳过。
const MIGRATE_LEGACY_PANELS_SQL = `
insert into public.studio_obs_dashboards (owner, name, spec)
select legacy.owner, '默认看板',
       jsonb_build_object('windowMinutes', 240, 'panels', jsonb_agg(
         jsonb_build_object(
           'title', legacy.title,
           'metric', legacy.spec ->> 'metric',
           'windowMinutes', (legacy.spec ->> 'windowMinutes')::int,
           'chart', 'line',
           'width', 1
         ) order by legacy.position, legacy.created_at))
from public.studio_obs_dashboard_panels legacy
where not exists (
  select 1 from public.studio_obs_dashboards board where board.owner = legacy.owner
)
group by legacy.owner
`;

let schemaReady: Promise<void> | null = null;
async function ensureSchema(p: Pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await p.query(ENSURE_SCHEMA_SQL);
      try {
        await p.query(MIGRATE_LEGACY_PANELS_SQL);
      } catch (error) {
        if ((error as { code?: string }).code !== '42P01') throw error;
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function rowToBoard(row: Record<string, unknown>): BoardRecord {
  const spec = normalizeBoardSpec(row.spec);
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    spec: spec ?? { ...DEFAULT_BOARD_SPEC, panels: [] },
    position: Number(row.position ?? 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

export async function listBoards(owner: string): Promise<BoardRecord[]> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `select * from public.studio_obs_dashboards where owner = $1 order by position, created_at limit 100`,
    [owner],
  );
  return result.rows.map(rowToBoard);
}

export async function createBoard(input: {
  owner: string;
  name: string;
  spec?: BoardSpec;
}): Promise<BoardRecord> {
  const p = await pool();
  await ensureSchema(p);
  const countResult = await p.query(
    `select count(*)::int as total from public.studio_obs_dashboards where owner = $1`,
    [input.owner],
  );
  if (Number(countResult.rows[0]?.total ?? 0) >= BOARDS_PER_OWNER_MAX) {
    throw new Error('too_many_boards');
  }
  const positionRow = await p.query(
    `select coalesce(max(position), -1) + 1 as next from public.studio_obs_dashboards where owner = $1`,
    [input.owner],
  );
  const position = Math.trunc(Number(positionRow.rows[0]?.next ?? 0));
  const spec = input.spec ?? DEFAULT_BOARD_SPEC;
  const result = await p.query(
    `insert into public.studio_obs_dashboards (owner, name, spec, position)
     values ($1, $2, $3::jsonb, $4) returning *`,
    [input.owner, input.name, JSON.stringify(spec), position],
  );
  return rowToBoard(result.rows[0] ?? {});
}

export async function updateBoard(
  owner: string,
  boardId: string,
  patch: { name?: string; spec?: BoardSpec },
): Promise<BoardRecord | null> {
  const p = await pool();
  await ensureSchema(p);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name != null) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.spec != null) {
    params.push(JSON.stringify(patch.spec));
    sets.push(`spec = $${params.length}::jsonb`);
  }
  if (!sets.length) {
    const existing = await p.query(
      `select * from public.studio_obs_dashboards where owner = $1 and id = $2`,
      [owner, boardId],
    );
    return existing.rows[0] ? rowToBoard(existing.rows[0]) : null;
  }
  params.push(owner, boardId);
  const result = await p.query(
    `update public.studio_obs_dashboards set ${sets.join(', ')}, updated_at = now()
     where owner = $${params.length - 1} and id = $${params.length} returning *`,
    params,
  );
  return result.rows[0] ? rowToBoard(result.rows[0]) : null;
}

export async function deleteBoard(owner: string, boardId: string): Promise<boolean> {
  const p = await pool();
  await ensureSchema(p);
  const result = await p.query(
    `delete from public.studio_obs_dashboards where owner = $1 and id = $2`,
    [owner, boardId],
  );
  return (result.rowCount ?? 0) > 0;
}
