#!/usr/bin/env bash
#
# d-obs 备份恢复演练：把最近（或指定）的备份恢复到临时库，抽查关键表，然后删临时库。
#
# 用法：
#   ops/backup/restore-drill.sh                     # 用 BACKUP_DIR 里最新的备份
#   ops/backup/restore-drill.sh /path/to/x.dump     # 指定备份文件
#
# 环境变量：
#   RDK_CHAT_CREDITS_DB_URL   必填（决定在哪个集群上建临时演练库，不触碰源库数据）
#   BACKUP_DIR                备份目录（默认 /var/backups/d-obs）
#   PG_DOCKER                 PG 跑在容器里时填容器名；dump 经 docker cp 拷进容器再恢复，
#                             psql/pg_restore 经 docker exec 执行（127.0.0.1:5432 在容器内同样可达）
#   PGRESTORE_BIN / PSQL_BIN  显式二进制覆盖（优先于 PG_DOCKER；宿主机直装 PG 时才需要）
#
# 验收口径：演练通过 = pg_restore 成功 + 抽查表全部存在 + 行数与源库同级（打印人工核对）。
# 建议每次备份策略变更后、以及每季度跑一次，把输出贴进工单留档。
set -euo pipefail

DB_URL="${RDK_CHAT_CREDITS_DB_URL:-}"
[ -n "$DB_URL" ] || { echo "[restore-drill] 缺少 RDK_CHAT_CREDITS_DB_URL" >&2; exit 2; }

BACKUP_DIR="${BACKUP_DIR:-/var/backups/d-obs}"
PG_DOCKER="${PG_DOCKER:-}"
DOCKER_MODE=0

if [ -n "${PSQL_BIN:-}" ] || [ -n "${PGRESTORE_BIN:-}" ]; then
  PSQL="${PSQL_BIN:-psql}"; PGRESTORE="${PGRESTORE_BIN:-pg_restore}"
elif [ -n "$PG_DOCKER" ]; then
  DOCKER_MODE=1; PSQL="psql"; PGRESTORE="pg_restore"
else
  PSQL="psql"; PGRESTORE="pg_restore"
fi

# run_pg <tool> [args...]：宿主机二进制，或 docker exec 进 PG 容器。
run_pg() {
  if [ "$DOCKER_MODE" = "1" ]; then docker exec -i "$PG_DOCKER" "$@"; else "$@"; fi
}

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$BACKUP_DIR"/d-obs-db-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "[restore-drill] 找不到备份文件" >&2; exit 2; }
echo "[restore-drill] 演练对象：$DUMP"

DRILL_DB="d_obs_drill_$(date +%s)"
DRILL_URL="${DB_URL%/*}/$DRILL_DB"

cleanup() {
  echo "[restore-drill] 清理临时库 $DRILL_DB"
  run_pg psql "$DB_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$DRILL_DB\"" > /dev/null
  if [ "$DOCKER_MODE" = "1" ]; then docker exec "$PG_DOCKER" rm -f /tmp/.d-obs-drill.dump > /dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "[restore-drill] 建临时库 $DRILL_DB"
run_pg psql "$DB_URL" -v ON_ERROR_STOP=1 -qc "create database \"$DRILL_DB\"" > /dev/null

echo "[restore-drill] 恢复（--no-owner --no-privileges，不重建角色）"
if [ "$DOCKER_MODE" = "1" ]; then
  docker cp "$DUMP" "$PG_DOCKER:/tmp/.d-obs-drill.dump"
  run_pg pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" /tmp/.d-obs-drill.dump
else
  run_pg pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" "$DUMP"
fi

echo "[restore-drill] 抽查关键表"
FAIL=0
for table in \
  studio_alert_checks \
  studio_alert_incidents \
  studio_alert_notifications \
  studio_obs_tenants \
  studio_ops_events \
  studio_trace_spans \
  agent_run_records; do
  COUNT="$(run_pg psql "$DRILL_URL" -Atc "select count(*) from public.$table" 2>/dev/null || echo 'TABLE_MISSING')"
  if [ "$COUNT" = "TABLE_MISSING" ]; then
    echo "  [缺失] $table"
    FAIL=1
  else
    echo "  [ok] $table rows=$COUNT"
  fi
done

if [ "$FAIL" != "0" ]; then
  echo "[restore-drill] 结果：FAIL —— 备份可恢复但缺少关键表，检查 schema 版本"
  exit 1
fi
echo "[restore-drill] 结果：PASS —— 备份可完整恢复（请把本次输出留档）"
