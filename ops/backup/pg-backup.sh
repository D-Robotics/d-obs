#!/usr/bin/env bash
#
# d-obs 中心库备份：pg_dump custom 格式 + 完整性校验 + sha256 + 保留期清理 + 可选异地。
#
# 用法（生产，systemd timer 每日驱动；也可手动执行）：
#   RDK_CHAT_CREDITS_DB_URL='postgres://user@localhost:5432/d_obs' ops/backup/pg-backup.sh
#
# 环境变量：
#   RDK_CHAT_CREDITS_DB_URL   必填，与 /etc/d-obs.env 同源
#   BACKUP_DIR                备份目录（默认 /var/backups/d-obs，权限 0700）
#   BACKUP_KEEP_DAYS          保留天数（默认 14，只清理本脚本命名模式的文件）
#   BACKUP_OFFSITE_DEST       可选，异地目标（rsync 语法的 host:path，配了就 rsync 推送）
#   PG_DOCKER                 PG 跑在容器里时填容器名（如 rdk-credits-pg），
#                             pg_dump/pg_restore 经 docker exec 执行，dump 走 stdout 落盘
#   PGDUMP_BIN / PGRESTORE_BIN 显式二进制覆盖（优先于 PG_DOCKER；宿主机直装 PG 时才需要）
#
# 为什么这么写（与 ops/deploy.sh 同一套哲学）：
#   * 备份后立即 pg_restore --list 校验目录可读 —— 没过完整性闸门的"备份成功"不算成功；
#   * sha256 sidecar 与产物绑定，异地传输后可核；
#   * 清理只认自己的命名前缀，绝不碰目录里别的东西；
#   * 任何一步失败立即退出非零，journald 能看到，timer 的 Persistent=true 会补跑。
set -euo pipefail

DB_URL="${RDK_CHAT_CREDITS_DB_URL:-}"
[ -n "$DB_URL" ] || { echo "[db-backup] 缺少 RDK_CHAT_CREDITS_DB_URL" >&2; exit 2; }

BACKUP_DIR="${BACKUP_DIR:-/var/backups/d-obs}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
OFFSITE="${BACKUP_OFFSITE_DEST:-}"
PG_DOCKER="${PG_DOCKER:-}"
DOCKER_MODE=0

if [ -n "${PGDUMP_BIN:-}" ]; then
  PGDUMP="$PGDUMP_BIN"; PGRESTORE="$PGRESTORE_BIN"
elif [ -n "$PG_DOCKER" ]; then
  DOCKER_MODE=1
else
  PGDUMP="pg_dump"; PGRESTORE="pg_restore"
fi

# run_pg <tool> [args...]：宿主机二进制，或 docker exec 进 PG 容器。
run_pg() {
  if [ "$DOCKER_MODE" = "1" ]; then docker exec -i "$PG_DOCKER" "$@"; else "$@"; fi
}

umask 077
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/d-obs-db-$STAMP.dump"

echo "[db-backup] 开始备份（custom 格式经 stdout 落盘，容器/宿主机均适用）"
run_pg pg_dump --format=custom "$DB_URL" > "$OUT"

SIZE="$(wc -c < "$OUT" | tr -d ' ')"
[ "$SIZE" -gt 1024 ] || { echo "[db-backup] 备份过小（${SIZE}B），疑似失败，保留现场退出" >&2; exit 1; }

# 完整性闸门：custom 格式的目录必须能完整列出，截断/损坏的 dump 在这里被拦下。
# 容器模式：pg_restore 看不到宿主机文件，把 dump 拷进容器临时目录校验后删除。
if [ "$DOCKER_MODE" = "1" ]; then
  docker cp "$OUT" "$PG_DOCKER:/tmp/.d-obs-backup-verify.dump"
  docker exec "$PG_DOCKER" pg_restore --list /tmp/.d-obs-backup-verify.dump > /dev/null
  docker exec "$PG_DOCKER" rm -f /tmp/.d-obs-backup-verify.dump
else
  "$PGRESTORE" --list "$OUT" > /dev/null
fi

HASH="$(sha256sum "$OUT" | awk '{print $1}')"
printf '%s  %s\n' "$HASH" "$(basename "$OUT")" > "$OUT.sha256"

echo "[db-backup] 完成：$OUT（$(du -h "$OUT" | cut -f1)，sha256 ${HASH:0:12}…）"

if [ -n "$OFFSITE" ]; then
  echo "[db-backup] 异地推送 -> $OFFSITE"
  rsync -a --checksum "$OUT" "$OUT.sha256" "$OFFSITE/"
  echo "[db-backup] 异地完成"
fi

# 保留期：只清理本脚本产物，别的东西（手动拷贝、别的工具的文件）不动。
PRUNED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'd-obs-db-*.dump' -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')"
PRUNED_SHA="$(find "$BACKUP_DIR" -maxdepth 1 -name 'd-obs-db-*.dump.sha256' -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')"
echo "[db-backup] 保留 ${KEEP_DAYS} 天内备份；本轮清理 dump=${PRUNED} sha256=${PRUNED_SHA}"
echo "[db-backup] 现有备份：$(ls -1t "$BACKUP_DIR"/d-obs-db-*.dump 2>/dev/null | wc -l | tr -d ' ') 份"
