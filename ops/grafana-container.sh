#!/usr/bin/env bash
#
# 以标准参数重建 d-obs-grafana 容器（host 网络、只读挂载、匿名只读访问）。
#
#   ops/grafana-container.sh            # 按 env 文件 + 本仓库默认值重建
#
# 管理员密码保存在服务器 /opt/d-obs/grafana/.admin-password（600，不入库）。
# 匿名访问只给 Viewer 且由 nginx 的 /_dobs_grafana_auth 统一鉴权把关，
# 公网无法绕过 d-obs 会话直接打开 Grafana。
set -euo pipefail

HOST="${DEPLOY_HOST:-root@47.110.142.255}"
CONTAINER="d-obs-grafana"
IMAGE="grafana/grafana-oss:11.4.0"
REMOTE_BASE="/opt/d-obs/grafana"

ssh -o BatchMode=yes "$HOST" bash -s "$CONTAINER" "$IMAGE" "$REMOTE_BASE" <<'REMOTE'
set -euo pipefail
CONTAINER=$1; IMAGE=$2; BASE=$3

PW=$(cat "$BASE/.admin-password" 2>/dev/null || true)
if [ -z "$PW" ]; then
  PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
  umask 077; printf '%s' "$PW" > "$BASE/.admin-password"
  echo "已生成新的管理员密码（写入 $BASE/.admin-password）"
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  -e GF_SECURITY_ADMIN_PASSWORD="$PW" \
  -e GF_USERS_ALLOW_SIGN_UP=false \
  -e GF_SERVER_DOMAIN=rdkstudio.d-robotics.cc \
  -e GF_SERVER_ROOT_URL=https://rdkstudio.d-robotics.cc/dobs/grafana/ \
  -e GF_SERVER_SERVE_FROM_SUB_PATH=true \
  -e GF_AUTH_ANONYMOUS_ENABLED=true \
  -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
  -e GF_AUTH_ANONYMOUS_HIDE_VERSION=true \
  -e GF_AUTH_BASIC_ENABLED=true \
  -v "$BASE/provisioning:/etc/grafana/provisioning:ro" \
  -v "$BASE/dashboards:/var/lib/grafana/dashboards:ro" \
  -v "$BASE/data:/var/lib/grafana" \
  "$IMAGE"

for _ in $(seq 1 30); do
  if curl -sf -m 3 http://127.0.0.1:3000/api/health >/dev/null; then
    echo "Grafana 容器已按标准参数重建且健康。"
    exit 0
  fi
  sleep 2
done
echo "健康检查未通过：docker logs --tail 50 $CONTAINER" >&2
exit 1
REMOTE
