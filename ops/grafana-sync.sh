#!/usr/bin/env bash
#
# 把仓库里的 Grafana 配置与看板同步到服务器并生效。
#
#   ops/grafana-sync.sh                # 同步 provisioning + dashboards，重启容器
#   ops/grafana-sync.sh --dry-run      # 只 rsync -n 预览
#
# 唯一真源是本仓库 ops/grafana/；服务器 /opt/d-obs/grafana 只是部署目标。
# 改容器本身（镜像版本、环境变量、端口）请用 ops/grafana-container.sh。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@47.110.142.255}"
REMOTE_BASE="/opt/d-obs/grafana"
CONTAINER="d-obs-grafana"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SRC_PROVISIONING="$ROOT/ops/grafana/provisioning"
SRC_DASHBOARDS="$ROOT/ops/grafana/dashboards"
for dir in "$SRC_PROVISIONING" "$SRC_DASHBOARDS"; do
  test -d "$dir" || { echo "缺少 $dir" >&2; exit 1; }
done
# JSON 必须先过本机校验，避免把坏看板推上线。
for file in "$SRC_DASHBOARDS"/*.json; do
  python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$file" || { echo "JSON 校验失败：$file" >&2; exit 1; }
done

RSYNC_FLAGS=(-av --delete)
(( DRY_RUN )) && RSYNC_FLAGS+=(-n)

rsync "${RSYNC_FLAGS[@]}" "$SRC_PROVISIONING/" "$HOST:$REMOTE_BASE/provisioning/"
rsync "${RSYNC_FLAGS[@]}" "$SRC_DASHBOARDS/" "$HOST:$REMOTE_BASE/dashboards/"
(( DRY_RUN )) && { echo "dry-run 完成，未重启容器"; exit 0; }

ssh -o BatchMode=yes "$HOST" "docker restart $CONTAINER >/dev/null"
for _ in $(seq 1 30); do
  if ssh -o BatchMode=yes "$HOST" "curl -sf -m 3 http://127.0.0.1:3000/api/health >/dev/null"; then
    echo "Grafana 同步完成且健康：https://rdkstudio.d-robotics.cc/dobs/grafana/"
    exit 0
  fi
  sleep 2
done
echo "重启后 60s 内健康检查未通过，请查看：ssh $HOST docker logs --tail 50 $CONTAINER" >&2
exit 1
