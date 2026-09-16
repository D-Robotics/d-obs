#!/usr/bin/env node
/**
 * 清理过期的租户事件行（studio_ops_events_tenant）。
 *
 * 为什么需要单独一个脚本：平台事件表由**主站部署**的告警 worker 做保留期清理
 * （`delete from studio_ops_events where occurred_at < now() - interval '30 days'`），
 * 而租户事件表是 d-obs 新引入的、主站那份 worker 不认识它。d-obs 自带 worker 的
 * 清理逻辑只在 d-obs 自己跑 worker 时生效——线上并不跑它，所以这里给一个可独立
 * 调度（systemd timer / cron）的清理入口，避免该表无界增长。
 *
 * 用法：
 *   RDK_CHAT_CREDITS_DB_URL=... node tools/trim-tenant-events.mjs [保留天数]
 * 默认保留 30 天，与平台事件表一致。失败以非零码退出，便于 systemd 记录。
 */
import pg from 'pg';

const RETENTION_DAYS = Math.max(1, Math.min(3650, Number(process.argv[2]) || 30));
const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
if (!connectionString) {
  console.error('[trim-tenant-events] RDK_CHAT_CREDITS_DB_URL 未配置');
  process.exit(2);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  const result = await client.query(
    `delete from public.studio_ops_events_tenant
      where occurred_at < now() - make_interval(days => $1::int)`,
    [RETENTION_DAYS],
  );
  console.log(
    `[trim-tenant-events] 已删除 ${result.rowCount ?? 0} 行（保留 ${RETENTION_DAYS} 天）`,
  );
} catch (error) {
  console.error('[trim-tenant-events] 失败:', String(error?.message ?? error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
