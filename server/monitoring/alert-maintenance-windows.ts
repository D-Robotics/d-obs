/**
 * 静默窗口（维护期）：按规则键精确匹配或全局匹配的「跳投递但保留记录」策略。
 *
 * 与事故级 silence_until 的区别：那是给一个已发生的事故消音；这里是在计划内
 * 维护期间预防性地拦住通知（Grafana mute timings 语义），worker 每轮仍然评估、
 * 落库、事故照常打开，只是渠道投递被抑制为 maintenance_window_suppressed。
 * 依赖状态机的「未投递 → 冷却后重试」语义：窗口结束前的最后一轮抑制会在
 * 窗口过期后由下一轮 opened/reminder 自动补发，无需改状态机。
 */
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

export interface MaintenanceWindow {
  id: number;
  /** 规则键精确匹配；空串 = 全部规则（全局维护）。 */
  alertKey: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  /** 自动清理时间（endsAt + 24h）；删除只是清理，不影响抑制语义（过期即失效）。 */
  expiredAt: string | null;
}

export function ensureMaintenanceWindowSchema(p: Pool): Promise<void> {
  return p
    .query(
      `
      create table if not exists public.studio_alert_maintenance_windows (
        id bigserial primary key,
        alert_key text not null default '',
        starts_at timestamptz not null,
        ends_at timestamptz not null,
        reason text not null,
        created_by text not null,
        created_at timestamptz not null default now(),
        expired_at timestamptz null,
        constraint studio_alert_maintenance_windows_time_check
          check (ends_at > starts_at),
        constraint studio_alert_maintenance_windows_key_len_check
          check (char_length(alert_key) <= 160),
        constraint studio_alert_maintenance_windows_reason_len_check
          check (char_length(reason) between 3 and 400)
      )`,
    )
    .then(() =>
      Promise.all([
        p.query(
          `create index if not exists studio_alert_maintenance_windows_active_idx
             on public.studio_alert_maintenance_windows (starts_at, ends_at)`,
        ),
        p.query(
          `create index if not exists studio_alert_maintenance_windows_key_idx
             on public.studio_alert_maintenance_windows (alert_key)`,
        ),
      ]),
    )
    .then(() => undefined);
}

/** 未来 ±7 天内的窗口（含已过期未清理的，供审计视图如实展示）。 */
export async function listMaintenanceWindows(p: Pool): Promise<MaintenanceWindow[]> {
  await ensureMaintenanceWindowSchema(p);
  const result = await p.query(
    `select id, alert_key, starts_at, ends_at, reason, created_by, created_at, expired_at
     from public.studio_alert_maintenance_windows
     where starts_at >= now() - interval '7 days'
     order by starts_at desc
     limit 100`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    alertKey: String(row.alert_key ?? ''),
    startsAt: new Date(row.starts_at as string).toISOString(),
    endsAt: new Date(row.ends_at as string).toISOString(),
    reason: String(row.reason ?? ''),
    createdBy: String(row.created_by ?? ''),
    createdAt: new Date(row.created_at as string).toISOString(),
    expiredAt: row.expired_at ? new Date(row.expired_at as string).toISOString() : null,
  }));
}

export async function createMaintenanceWindow(
  p: Pool,
  input: { alertKey: string; minutes: number; reason: string; createdBy: string },
): Promise<MaintenanceWindow> {
  await ensureMaintenanceWindowSchema(p);
  const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(Number(input.minutes) || 0)));
  const reason = String(input.reason ?? '').trim().slice(0, 400);
  if (reason.length < 3) throw new Error('maintenance_reason_required');
  const alertKey = String(input.alertKey ?? '').trim().slice(0, 160);
  const result = await p.query(
    `insert into public.studio_alert_maintenance_windows
       (alert_key, starts_at, ends_at, reason, created_by)
     values ($1, now(), now() + make_interval(mins => $2::int), $3, $4)
     returning id, alert_key, starts_at, ends_at, reason, created_by, created_at, expired_at`,
    [alertKey, minutes, reason, String(input.createdBy ?? '').slice(0, 160) || 'ops-admin'],
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    alertKey: String(row.alert_key ?? ''),
    startsAt: new Date(row.starts_at as string).toISOString(),
    endsAt: new Date(row.ends_at as string).toISOString(),
    reason: String(row.reason ?? ''),
    createdBy: String(row.created_by ?? ''),
    createdAt: new Date(row.created_at as string).toISOString(),
    expiredAt: null,
  };
}

export async function deleteMaintenanceWindow(p: Pool, id: number): Promise<boolean> {
  await ensureMaintenanceWindowSchema(p);
  const result = await p.query(
    `delete from public.studio_alert_maintenance_windows where id = $1`,
    [Math.floor(Number(id))],
  );
  return Boolean(result.rowCount);
}

/**
 * worker 每轮调用：删除 ends_at + 24h 之前的行（保留一天审计窗口），
 * 返回当前生效的 alert_key 集合（'' 表示全局生效）。
 */
export async function collectActiveMaintenanceKeys(p: Pool): Promise<Set<string>> {
  await ensureMaintenanceWindowSchema(p);
  await p
    .query(
      `delete from public.studio_alert_maintenance_windows
       where ends_at < now() - interval '24 hours'`,
    )
    .catch(() => undefined);
  const result = await p.query(
    `select alert_key from public.studio_alert_maintenance_windows
     where starts_at <= now() and ends_at > now()`,
  );
  return new Set(result.rows.map((row) => String(row.alert_key ?? '')));
}

/**
 * 抑制判定：transition 命中生效窗口时返回命中的窗口（供落库审计），
 * 否则 null。critical 不豁免——维护窗口语义就是「这段时间别喊我」；
 * 真正的严重事故在窗口结束后的下一轮 reminder 会立即补发。
 */
export function maintenanceSuppression(
  alertKey: string,
  activeKeys: ReadonlySet<string>,
): { suppressed: true; reason: string } | null {
  if (activeKeys.has('') || activeKeys.has(alertKey)) {
    return {
      suppressed: true,
      reason: activeKeys.has('')
        ? 'maintenance_window_active_global'
        : 'maintenance_window_active_rule',
    };
  }
  return null;
}
