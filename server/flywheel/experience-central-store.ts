/**
 * Experience 轨迹中心库汇聚 —— run 级低敏 summary 的权威存储与运营读取。
 *
 * 设计约束（对齐 ops-event-store.ts）：
 *  - 只保存聚合计数与固定码值，严禁写入工具入参、结果正文、提示词或原始标识；
 *  - accountKey 仅允许不可逆哈希（宿主调用方传入前已哈希）；
 *  - 写入失败永远不能影响 AI 主链路（调用方 fire-and-forget）；
 *  - run_id 唯一索引保证重复上报幂等（同一 run 多次 finalize 只落一笔）。
 */
import { createHash } from 'node:crypto';
import type { ExperienceRunSummary } from './experience-types.js';

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

export function isExperienceCentralStoreConfigured(): boolean {
  return centralDbUrl().length > 0;
}

let poolReady: Promise<Pool> | null = null;
async function pool(): Promise<Pool> {
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!poolReady) {
    poolReady = (async () => {
      const pgMod = await import('pg' as string);
      const PgPool = (pgMod as { default?: { Pool: new (cfg: unknown) => Pool } }).default?.Pool;
      if (!PgPool) throw new Error('pg 模块不可用');
      return new PgPool({ connectionString: centralDbUrl(), max: 2 });
    })().catch((error) => {
      poolReady = null;
      throw error;
    });
  }
  return poolReady;
}

let schemaReady: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (!isExperienceCentralStoreConfigured()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = await pool();
      await p.query(`
        create table if not exists public.studio_experience_summaries (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null,
          run_id text not null,
          account_key text,
          client_type text,
          total int not null,
          pass_count int not null,
          fail_count int not null,
          unknown_count int not null,
          contract_hits int not null default 0,
          total_duration_ms bigint not null default 0,
          by_signal_source jsonb,
          top_reason_codes jsonb,
          failed_tools jsonb,
          content_hash text,
          created_at timestamptz not null default now()
        )
      `);
      // 存量部署补齐内容哈希列（旧行为 NULL → 校验时按 legacy 跳过，新写入一律带哈希）。
      await p.query(
        `create unique index if not exists studio_experience_summaries_run_unique
         on public.studio_experience_summaries (run_id)`,
      );
      await p.query(
        `alter table public.studio_experience_summaries add column if not exists content_hash text`,
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export interface ExperienceRecordOptions {
  /** ssoUserId 的不可逆哈希（调用方负责哈希后传入，本层不接收明文身份）。 */
  accountKey?: string | null;
  clientType?: string | null;
}

/** pg 驱动把 timestamptz 解析成 JS Date；哈希重算必须走 toISOString() 保证毫秒精度一致。 */
function toIsoMs(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** 递归按 key 排序的序列化：pg jsonb 不保证读回 key 顺序，哈希必须建在规范形上。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 内容哈希锚点（改进项 4）：对落库字段的规范形求 sha256。
 * 中心库行被篖改（改计数/换原因码/删行外补写）都能在校验时暴露。
 */
export function experienceSummaryContentHash(
  summary: ExperienceRunSummary,
  options: ExperienceRecordOptions = {},
): string {
  const canonical = canonicalJson({
    occurredAt: toIsoMs(summary.occurredAt),
    runId: summary.runId,
    accountKey: options.accountKey ?? null,
    clientType: options.clientType ?? null,
    total: summary.total,
    passCount: summary.passCount,
    failCount: summary.failCount,
    unknownCount: summary.unknownCount,
    contractHits: summary.contractHits,
    totalDurationMs: summary.totalDurationMs,
    bySignalSource: summary.bySignalSource,
    topReasonCodes: summary.topReasonCodes,
    failedTools: summary.failedTools,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 上报一条 run 级 summary。未配置中心库时静默跳过；冲突（重复 run）忽略。 */
export async function recordExperienceRunSummary(
  summary: ExperienceRunSummary,
  options: ExperienceRecordOptions = {},
): Promise<boolean> {
  if (!isExperienceCentralStoreConfigured()) return false;
  await ensureSchema();
  const p = await pool();
  const result = await p.query(
    `insert into public.studio_experience_summaries
       (occurred_at, run_id, account_key, client_type, total, pass_count, fail_count,
        unknown_count, contract_hits, total_duration_ms,
        by_signal_source, top_reason_codes, failed_tools, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (run_id) do nothing`,
    [
      summary.occurredAt,
      summary.runId,
      options.accountKey ?? null,
      options.clientType ?? null,
      summary.total,
      summary.passCount,
      summary.failCount,
      summary.unknownCount,
      summary.contractHits,
      summary.totalDurationMs,
      JSON.stringify(summary.bySignalSource),
      JSON.stringify(summary.topReasonCodes),
      JSON.stringify(summary.failedTools),
      experienceSummaryContentHash(summary, options),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface ExperienceOverview {
  configured: boolean;
  windowDays: number;
  runCount: number;
  total: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  contractHits: number;
  failRate: number | null;
  topReasonCodes: Array<{ code: string; count: number }>;
  topFailedTools: Array<{ tool: string; fails: number }>;
}

/** 运营读取：最近 N 天的全局聚合（只读中心库，不触碰本地轨迹文件）。 */
export async function getExperienceOverview(days = 7): Promise<ExperienceOverview> {
  const windowDays = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const base: ExperienceOverview = {
    configured: isExperienceCentralStoreConfigured(),
    windowDays,
    runCount: 0,
    total: 0,
    passCount: 0,
    failCount: 0,
    unknownCount: 0,
    contractHits: 0,
    failRate: null,
    topReasonCodes: [],
    topFailedTools: [],
  };
  if (!base.configured) return base;
  await ensureSchema();
  const p = await pool();
  const totals = await p.query(
    `select count(*)::int as run_count,
            coalesce(sum(total), 0)::int as total,
            coalesce(sum(pass_count), 0)::int as pass_count,
            coalesce(sum(fail_count), 0)::int as fail_count,
            coalesce(sum(unknown_count), 0)::int as unknown_count,
            coalesce(sum(contract_hits), 0)::int as contract_hits
       from public.studio_experience_summaries
      where occurred_at >= now() - ($1 || ' days')::interval`,
    [String(windowDays)],
  );
  const row = totals.rows[0];
  if (row) {
    base.runCount = Number(row.run_count ?? 0);
    base.total = Number(row.total ?? 0);
    base.passCount = Number(row.pass_count ?? 0);
    base.failCount = Number(row.fail_count ?? 0);
    base.unknownCount = Number(row.unknown_count ?? 0);
    base.contractHits = Number(row.contract_hits ?? 0);
    base.failRate = base.total > 0 ? base.failCount / base.total : null;
  }
  const reasons = await p.query(
    `select elem->>'code' as code, sum((elem->>'count')::int)::int as count
       from public.studio_experience_summaries,
            jsonb_array_elements(coalesce(top_reason_codes, '[]'::jsonb)) as elem
      where occurred_at >= now() - ($1 || ' days')::interval
      group by elem->>'code'
      order by count desc
      limit 12`,
    [String(windowDays)],
  );
  base.topReasonCodes = reasons.rows
    .map((r) => ({ code: String(r.code ?? ''), count: Number(r.count ?? 0) }))
    .filter((item) => item.code);
  const tools = await p.query(
    `select elem->>'tool' as tool, sum((elem->>'fails')::int)::int as fails
       from public.studio_experience_summaries,
            jsonb_array_elements(coalesce(failed_tools, '[]'::jsonb)) as elem
      where occurred_at >= now() - ($1 || ' days')::interval
      group by elem->>'tool'
      order by fails desc
      limit 12`,
    [String(windowDays)],
  );
  base.topFailedTools = tools.rows
    .map((r) => ({ tool: String(r.tool ?? ''), fails: Number(r.fails ?? 0) }))
    .filter((item) => item.tool);
  return base;
}

export interface ExperienceIntegrityReport {
  configured: boolean;
  windowDays: number;
  totalRows: number;
  /** 哈希锚点上线前的旧行（无 content_hash），不参与校验。 */
  legacyRows: number;
  hashedRows: number;
  /** 所有带哈希的行重算一致。 */
  verified: boolean;
  mismatchedRunIds: string[];
}

/**
 * 运营审计（改进项 4）：重算窗口内各行的内容哈希，暴露中心库被篖改的行。
 * 只读校验，不修改任何数据；窗口内最多抽验 1000 行（最新优先）。
 */
export async function verifyExperienceIntegrity(days = 7): Promise<ExperienceIntegrityReport> {
  const windowDays = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const report: ExperienceIntegrityReport = {
    configured: isExperienceCentralStoreConfigured(),
    windowDays,
    totalRows: 0,
    legacyRows: 0,
    hashedRows: 0,
    verified: true,
    mismatchedRunIds: [],
  };
  if (!report.configured) return report;
  await ensureSchema();
  const p = await pool();
  const rows = await p.query(
    `select occurred_at, run_id, account_key, client_type, total, pass_count, fail_count,
            unknown_count, contract_hits, total_duration_ms,
            by_signal_source, top_reason_codes, failed_tools, content_hash
       from public.studio_experience_summaries
      where occurred_at >= now() - ($1 || ' days')::interval
      order by occurred_at desc
      limit 1000`,
    [String(windowDays)],
  );
  report.totalRows = rows.rows.length;
  for (const row of rows.rows) {
    const storedHash = row.content_hash == null ? null : String(row.content_hash);
    if (!storedHash) {
      report.legacyRows += 1;
      continue;
    }
    report.hashedRows += 1;
    const recomputed = experienceSummaryContentHash(
      {
        runId: String(row.run_id ?? ''),
        occurredAt: toIsoMs(row.occurred_at),
        total: Number(row.total ?? 0),
        passCount: Number(row.pass_count ?? 0),
        failCount: Number(row.fail_count ?? 0),
        unknownCount: Number(row.unknown_count ?? 0),
        contractHits: Number(row.contract_hits ?? 0),
        totalDurationMs: Number(row.total_duration_ms ?? 0),
        bySignalSource: (row.by_signal_source ?? {}) as ExperienceRunSummary['bySignalSource'],
        topReasonCodes: (row.top_reason_codes ?? []) as ExperienceRunSummary['topReasonCodes'],
        failedTools: (row.failed_tools ?? []) as ExperienceRunSummary['failedTools'],
      },
      {
        accountKey: row.account_key == null ? null : String(row.account_key),
        clientType: row.client_type == null ? null : String(row.client_type),
      },
    );
    if (recomputed !== storedHash) {
      report.verified = false;
      if (report.mismatchedRunIds.length < 20) report.mismatchedRunIds.push(String(row.run_id ?? ''));
    }
  }
  return report;
}
