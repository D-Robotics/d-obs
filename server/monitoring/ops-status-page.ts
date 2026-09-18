/**
 * 公开状态页：只读、无鉴权信息、不含任何租户/用户标识。
 *
 * 数据面收敛到三个低敏感信号：worker 是否活着（最近评估时间）、
 * 启用检查的健康分布、进行中的平台事故（标题/严重度/状态/时间）。
 * 与运营看板的边界：这里没有配置、通道、审计、事件流，也不出现
 * webhook、token、租户键或任何人的身份。
 */
import { getOpsObservabilityPool } from './observability-store.js';

/** 供路由与测试复用的入口：取共享池 → 聚合 → 渲染（一次调用完成）。 */
export async function renderStatusPage(): Promise<string> {
  const data = await getStatusPageData(await getOpsObservabilityPool());
  return renderStatusPageHtml(data);
}

export interface StatusPageData {
  fetchedAt: string;
  worker: {
    /** worker 状态表是否存在且最近 5 分钟内有评估。 */
    alive: boolean;
    lastCheckedAt: string | null;
    workerVersion: string | null;
  };
  checks: {
    total: number;
    healthy: number;
    observing: number;
    firing: number;
    disabled: number;
  };
  incidents: Array<{
    title: string;
    severity: 'warning' | 'critical';
    status: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    summary: string;
  }>;
}

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type QueryPool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
};

const STALE_WORKER_MS = 5 * 60_000;

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? '');
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function bounded(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\0\r\n\t]/g, ' ')
    .trim()
    .slice(0, max);
}

/** 事故摘要去掉一切身份/配置细节，只保留现象描述。 */
function incidentSummary(value: unknown): string {
  const raw = String(value ?? '');
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  return bounded(cleaned, 240);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[character] ?? character);
}

function statusLabel(value: unknown): string {
  return ({ open: '进行中', acknowledged: '已确认', silenced: '已静默' } as Record<string, string>)[String(value)] ?? String(value ?? '');
}

function fmtTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

export async function getStatusPageData(p: QueryPool): Promise<StatusPageData> {
  const [workerResult, checksResult, incidentsResult] = await Promise.all([
    p
      .query(
        `select last_run_at, worker_version from public.studio_alert_worker_status where singleton = true`,
      )
      .catch(() => ({ rows: [] })),
    // observing 与读面板语义一致：不健康但触发连击未达 openAfter（failure_streak>0
    // 且未进入 unhealthy），这里直接用 unhealthy 分桶，observing 由失败连击推。
    p
      .query(
        `select count(*)::int total,
                count(*) filter (where not enabled)::int disabled,
                count(*) filter (where enabled and active and not unhealthy)::int healthy,
                count(*) filter (where enabled and active and unhealthy)::int firing,
                count(*) filter (where enabled and not active and failure_streak > 0)::int observing
         from public.studio_alert_checks
         where coalesce(tenant_id, 'platform') = 'platform'`,
      )
      .catch(() => ({ rows: [] })),
    p
      .query(
        `select title, severity, status, first_seen_at, last_seen_at, summary
         from public.studio_alert_incidents
         where status in ('open', 'acknowledged', 'silenced')
           and coalesce(tenant_id, 'platform') = 'platform'
         order by (status = 'open') desc, last_seen_at desc
         limit 20`,
      )
      .catch(() => ({ rows: [] })),
  ]);
  const workerRow = workerResult.rows[0];
  const checkRow = checksResult.rows[0] ?? {};
  const lastCheckedAt = isoOrNull(workerRow?.last_run_at);
  const total = Number(checkRow.total ?? 0) || 0;
  const healthy = Number(checkRow.healthy ?? 0) || 0;
  const firing = Number(checkRow.firing ?? 0) || 0;
  const observing = Number(checkRow.observing ?? 0) || 0;
  const disabled = Number(checkRow.disabled ?? 0) || 0;
  return {
    fetchedAt: new Date().toISOString(),
    worker: {
      alive: Boolean(
        lastCheckedAt && Date.now() - Date.parse(lastCheckedAt) < STALE_WORKER_MS,
      ),
      lastCheckedAt,
      workerVersion: workerRow ? bounded(workerRow.worker_version, 24) || null : null,
    },
    checks: { total, healthy, observing, firing, disabled },
    incidents: incidentsResult.rows.map((row) => ({
      title: bounded(row.title, 200) || '未命名事故',
      severity: row.severity === 'critical' ? 'critical' : 'warning',
      status: bounded(row.status, 24) || 'open',
      firstSeenAt: isoOrNull(row.first_seen_at),
      lastSeenAt: isoOrNull(row.last_seen_at),
      summary: incidentSummary(row.summary),
    })),
  };
}

export function renderStatusPageHtml(data: StatusPageData): string {
  const escapeHtml = (value: unknown): string =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
          c
        ] ?? c,
    );
  const statusLabel = (s: string): string =>
    ({ open: '进行中', acknowledged: '已确认', silenced: '已静默' })[s] ?? s;
  const fmtTime = (v: string | null): string => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN');
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务状态 · d-obs</title>
<style>
:root{--bg:#f6f7f8;--panel:#fff;--line:#e4e6e8;--text:#1a1d1f;--muted:#6f7478;--green:#0a8a6e;--orange:#c97a10;--red:#d9363e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:48px 20px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;margin-bottom:28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
.dot.ok{background:var(--green)}.dot.warn{background:var(--orange)}.dot.down{background:var(--red)}
.label{font-weight:600}
.note{color:var(--muted);font-size:12px;margin-top:4px}
.incident{padding:12px 0;border-bottom:1px solid var(--line)}
.incident:last-child{border-bottom:0;padding-bottom:0}
.incident .row .label{font-size:13px}
.sev{font-size:11px;border-radius:4px;padding:1px 7px}
.sev.critical{background:#fdecec;color:var(--red)}.sev.warning{background:#fdf3e5;color:var(--orange)}
.sev.acknowledged,.sev.silenced{background:#eef1f4;color:var(--muted)}
footer{color:var(--muted);font-size:11px;margin-top:26px;text-align:center}
a{color:inherit}
</style>
</head>
<body>
<div class="wrap">
<h1>服务状态</h1>
<div class="sub">d-obs · 每分钟自动巡检 · 本页为公开只读视图（不含配置与用户数据）</div>
<div class="card">
  <div class="row"><span class="dot ${data.worker.alive ? 'ok' : 'down'}"></span><span class="label">${data.worker.alive ? '巡检系统正常' : '巡检心跳超时'}</span></div>
  <div class="note">${data.worker.lastCheckedAt ? '最近评估：' + new Date(data.worker.lastCheckedAt).toLocaleString('zh-CN') : '尚无巡检记录'}${data.worker.workerVersion ? ' · Worker v' + data.worker.workerVersion : ''}</div>
</div>
<div class="card">
  <div class="row"><span class="dot ${data.checks.firing > 0 ? 'warn' : 'ok'}"></span><span class="label">健康检查 ${data.checks.healthy}/${data.checks.total - data.checks.disabled} 项正常</span></div>
  <div class="note">${data.checks.firing > 0 ? data.checks.firing + ' 项检查正在触发告警' : '所有启用检查均正常'}${data.checks.observing ? ' · ' + data.checks.observing + ' 项观察中' : ''}</div>
</div>
<div class="card">
  <div class="row"><span class="dot ${data.incidents.some(i => i.severity === 'critical') ? 'down' : data.incidents.length ? 'warn' : 'ok'}"></span><span class="label">当前事故 ${data.incidents.length} 个</span></div>
  ${data.incidents.length ? data.incidents.map(i => `
  <div class="incident">
    <div class="row"><span class="label">${escapeHtml(i.title)}</span><span class="sev ${i.severity}">${i.severity === 'critical' ? '严重' : '警告'}</span><span class="sev ${i.status}">${statusLabel(i.status)}</span></div>
    <div class="note">${escapeHtml(i.summary || '—')}</div>
    <div class="note">开始 ${fmtTime(i.firstSeenAt)} · 最近更新 ${fmtTime(i.lastSeenAt)}</div>
  </div>`).join('') : '<div class="note">没有进行中的事故。</div>'}
</div>
<footer>数据每次访问实时生成 · 状态异常请以告警通知为准 · 生成时间 ${new Date(data.fetchedAt).toLocaleString('zh-CN')}</footer>
</div>
</body>
</html>`;
}
