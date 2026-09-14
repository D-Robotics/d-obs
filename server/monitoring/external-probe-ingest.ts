/**
 * 106.53 异地探针的低敏感心跳摄取。
 *
 * 入口位于 /api/health/external-probe-report（SSO 公共豁免范围），因此必须同时通过
 * 独立 256-bit token。只接受固定检查 key、布尔状态、计数和短摘要。
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sanitizeOpsSummary } from './ops-event-store.js';

const TOKEN_PATH =
  String(process.env.RDK_EXTERNAL_PROBE_TOKEN_PATH ?? '').trim() ||
  '/var/lib/rdstudio-alert-worker/external-probe-token';
const ALLOWED_KEYS = new Set([
  'external-dns',
  'external-tls',
  'external-health',
  'external-entry-asset',
]);

type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

let cachedToken = '';
let cachedTokenAt = 0;
async function expectedToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedTokenAt < 60_000) return cachedToken;
  const token = String(await readFile(TOKEN_PATH, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('external probe token is not configured');
  cachedToken = token;
  cachedTokenAt = Date.now();
  return token;
}

export async function externalProbeTokenMatches(provided: unknown): Promise<boolean> {
  const actual = String(provided ?? '').trim();
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  try {
    const expected = await expectedToken();
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface ExternalProbeReport {
  generatedAt: string;
  source: '106.53';
  checks: Array<{
    key: string;
    title: string;
    enabled: boolean;
    ok: boolean;
    active: boolean;
    failures: number;
    successes: number;
    detail: string;
  }>;
}

export function parseExternalProbeReport(value: unknown): ExternalProbeReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const generatedAt = String(input.generatedAt ?? '').trim();
  if (!Number.isFinite(Date.parse(generatedAt))) return null;
  if (input.source !== '106.53' || !Array.isArray(input.checks)) return null;
  const checks: ExternalProbeReport['checks'] = [];
  for (const raw of input.checks.slice(0, 8)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const key = String(item.key ?? '').trim();
    if (
      !ALLOWED_KEYS.has(key) ||
      typeof item.enabled !== 'boolean' ||
      typeof item.ok !== 'boolean' ||
      typeof item.active !== 'boolean'
    ) {
      return null;
    }
    checks.push({
      key,
      title: sanitizeOpsSummary(item.title, 120) || key,
      enabled: item.enabled,
      ok: item.ok,
      active: item.active,
      failures: Math.max(0, Math.min(1000, Math.floor(Number(item.failures) || 0))),
      successes: Math.max(0, Math.min(1000, Math.floor(Number(item.successes) || 0))),
      detail: sanitizeOpsSummary(item.detail, 300),
    });
  }
  if (checks.length !== ALLOWED_KEYS.size || new Set(checks.map((item) => item.key)).size !== checks.length) {
    return null;
  }
  return { generatedAt: new Date(generatedAt).toISOString(), source: '106.53', checks };
}

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

export async function recordExternalProbeReport(report: ExternalProbeReport): Promise<void> {
  const p = await pool();
  await p.query(`
    create table if not exists public.studio_external_probe_status (
      source text primary key,
      reported_at timestamptz not null,
      status text not null,
      checks jsonb not null default '[]'::jsonb
    )
  `);
  await p.query(
    `insert into public.studio_external_probe_status (source, reported_at, status, checks)
     values ($1, $2, $3, $4::jsonb)
     on conflict (source) do update
       set reported_at = excluded.reported_at,
           status = excluded.status,
           checks = excluded.checks`,
    [
      report.source,
      report.generatedAt,
      report.checks.some((item) => item.active) ? 'critical' : 'healthy',
      JSON.stringify(report.checks),
    ],
  );
  for (const check of report.checks) {
    const severity = check.key === 'external-dns' ? 'warning' : 'critical';
    await p.query(
      `insert into public.studio_alert_checks
         (alert_key, title, category, enabled, severity, unhealthy, active, summary, checked_at,
          failure_streak, success_streak)
         values ($1, $2, 'probe', $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (alert_key) do update
         set title = excluded.title,
             category = 'probe',
             enabled = excluded.enabled,
             severity = excluded.severity,
             unhealthy = excluded.unhealthy,
             active = excluded.active,
             summary = excluded.summary,
             checked_at = excluded.checked_at,
             failure_streak = excluded.failure_streak,
             success_streak = excluded.success_streak`,
      [
        check.key,
        check.title,
        check.enabled,
        severity,
        check.enabled ? !check.ok : false,
        check.enabled ? check.active : false,
        check.enabled ? `异地 106.53：${check.detail}` : '规则已停用',
        report.generatedAt,
        check.failures,
        check.successes,
      ],
    );
    if (check.enabled && check.active) {
      await p.query(
        `insert into public.studio_alert_incidents
           (alert_key, title, severity, status, summary, first_seen_at, last_seen_at, occurrence_count)
         values ($1, $2, $3, 'open', $4, $5, $5, 1)
         on conflict (alert_key) do update
           set status = case when public.studio_alert_incidents.status = 'resolved'
                                or (public.studio_alert_incidents.status = 'silenced'
                                    and coalesce(public.studio_alert_incidents.silence_until, now()) <= now())
                           then 'open' else public.studio_alert_incidents.status end,
               summary = excluded.summary,
               last_seen_at = excluded.last_seen_at,
               severity = excluded.severity,
               occurrence_count = public.studio_alert_incidents.occurrence_count + 1,
               silence_until = case when public.studio_alert_incidents.status = 'silenced'
                                        and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                     then null else public.studio_alert_incidents.silence_until end,
               silence_reason = case when public.studio_alert_incidents.status = 'silenced'
                                         and coalesce(public.studio_alert_incidents.silence_until, now()) <= now()
                                      then null else public.studio_alert_incidents.silence_reason end,
               acknowledged_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_at end,
               acknowledged_by = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.acknowledged_by end,
               resolved_at = case when public.studio_alert_incidents.status = 'resolved' then null else public.studio_alert_incidents.resolved_at end`,
        [check.key, check.title, severity, check.detail, report.generatedAt],
      );
    } else {
      await p.query(
        `update public.studio_alert_incidents
         set status = 'resolved', last_seen_at = $2, resolved_at = $2,
             summary = '异地拨测已恢复'
         where alert_key = $1 and status = 'open'`,
        [check.key, report.generatedAt],
      );
    }
  }
}
