#!/usr/bin/env bash
#
# d-obs 容灾恢复（DR）：在备用机（VPS）上从异地备份把 d-obs 拉起来。
#
# 前置（平时就位，灾难发生时零依赖生产机）：
#   * /var/backups/d-obs/ 有异地推送的 d-obs-db-*.dump（生产备份 timer 自动维护）
#   * /opt/d-obs-dr/current/ 有 d-obs 代码（server/ shared/ package.json + node_modules；
#     每次 release 后从生产同步一次）
#   * docker + postgres:16-alpine 镜像
#
# 用法（备用机上）：
#   ops/dr/restore-standby.sh              # 用最新 dump 恢复并起 web（仅 web，无 worker）
#   ops/dr/restore-standby.sh <dump 文件>   # 指定 dump
#
# 语义：
#   * PG 起在 docker（127.0.0.1:5433，数据卷 d-obs-dr-pgdata），库名 d_obs
#   * d-obs web 起在 127.0.0.1:18093（仅回环；对外暴露由操作者按需挂反代/改防火墙）
#   * 不启动 worker：避免双副本重复告警；SSO 中继不配置 → 登录面 fail-closed 503，
#     admin token 通道照常（token 值与生产一致，来自恢复的库外环境需操作者提供
#     RDK_CREDITS_ADMIN_TOKEN 环境变量）
#   * 结束打印 RTO；验证标准：GET /status 200
set -euo pipefail

DR_DIR="${DR_DIR:-/opt/d-obs-dr}"
DUMP_DIR="${DUMP_DIR:-/var/backups/d-obs}"
PG_CONTAINER="${DR_PG_CONTAINER:-d-obs-dr-pg}"
PG_PORT="${DR_PG_PORT:-5433}"
PG_PASSWORD="${DR_PG_PASSWORD:-d-obs-dr-standby}"
WEB_PORT="${DR_WEB_PORT:-18093}"
NODE_BIN="${DR_NODE_BIN:-/opt/d-obs-watchdog/bin/node}"

START=$(date +%s)
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$DUMP_DIR"/d-obs-db-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "[dr] 找不到异地备份 dump" >&2; exit 2; }
echo "[dr] 恢复源：$DUMP"

# 1) PG 容器（数据持久卷；已存在则直接启动）
if docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  docker start "$PG_CONTAINER" >/dev/null
else
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -p "127.0.0.1:$PG_PORT:5432" \
    -v d-obs-dr-pgdata:/var/lib/postgresql/data \
    postgres:16-alpine >/dev/null
fi
echo "[dr] 等待 PG 就绪…"
for _ in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

DB_URL="postgresql://postgres:$PG_PASSWORD@127.0.0.1:$PG_PORT/d_obs"
# 容器内 PG 永远监听 5432（PG_PORT 只是宿主机映射），restore/建库走容器内地址。
DB_URL_INNER="postgresql://postgres:$PG_PASSWORD@127.0.0.1:5432/d_obs"
docker exec "$PG_CONTAINER" psql -U postgres -qc "drop database if exists d_obs" 
docker exec "$PG_CONTAINER" psql -U postgres -qc "create database d_obs"
echo "[dr] 恢复 dump（464MB 级约 1-2 分钟）…"
docker cp "$DUMP" "$PG_CONTAINER:/tmp/.dr.dump"
docker exec "$PG_CONTAINER" pg_restore --no-owner --no-privileges --dbname="$DB_URL_INNER" /tmp/.dr.dump
docker exec "$PG_CONTAINER" rm -f /tmp/.dr.dump
echo "[dr] 恢复完成（$(($(date +%s) - START))s）"

# 2) d-obs web（仅回环；无 worker；无 SSO → 登录面 fail-closed）
cd "$DR_DIR/current"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
PORT="$WEB_PORT" \
RDK_CHAT_CREDITS_DB_URL="$DB_URL" \
RDK_CREDITS_ADMIN_TOKEN="${RDK_CREDITS_ADMIN_TOKEN:?需要提供生产相同的 RDK_CREDITS_ADMIN_TOKEN}" \
RDK_ALERT_SHADOW_MODE=true \
nohup "$NODE_BIN" server/main.js > /tmp/d-obs-dr-web.log 2>&1 &
echo "[dr] d-obs web 启动中（pid $!，端口 127.0.0.1:$WEB_PORT）…"
for _ in $(seq 1 20); do
  sleep 1
  CODE="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$WEB_PORT/status" || true)"
  [ "$CODE" = "200" ] && break
done
[ "$CODE" = "200" ] || { echo "[dr] /status 未就绪（最后 $CODE），查看 /tmp/d-obs-dr-web.log" >&2; exit 1; }

echo "[dr] RTO：$(($(date +%s) - START))s（从开始恢复到 /status 200）"
echo "[dr] 后续（操作者决策）：对外暴露入口、补 SSO 中继配置、评估是否切换 worker。"
