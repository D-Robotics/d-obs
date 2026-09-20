#!/usr/bin/env bash
# 注册一个 RDK 板并通过 SSH 安装 edge-agent。
#
# 例：
#   ops/edge-agent/bootstrap.sh \
#     --board 169.254.0.49 --device-id rdk-x5-01 --model X5 \
#     --admin-token "$RDK_CREDITS_ADMIN_TOKEN"
#
# token 只在注册响应和板端 token 文件中出现，不写入仓库或 shell history（建议
# 从环境变量传入）。脚本需要本机能 SSH 到板子，默认用户 root，可用 --user 覆盖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOARD=""
USER_NAME="root"
DEVICE_ID=""
MODEL=""
FIRMWARE=""
REPORT_URL="https://rdkstudio.d-robotics.cc/dobs"
ADMIN_TOKEN="${RDK_CREDITS_ADMIN_TOKEN:-}"
REMOTE_ROOT="/opt/d-obs"

while [ $# -gt 0 ]; do
  case "$1" in
    --board) BOARD="${2:?--board 需要值}"; shift 2 ;;
    --user) USER_NAME="${2:?--user 需要值}"; shift 2 ;;
    --device-id) DEVICE_ID="${2:?--device-id 需要值}"; shift 2 ;;
    --model) MODEL="${2:?--model 需要值}"; shift 2 ;;
    --firmware) FIRMWARE="${2:?--firmware 需要值}"; shift 2 ;;
    --report-url) REPORT_URL="${2:?--report-url 需要值}"; shift 2 ;;
    --admin-token) ADMIN_TOKEN="${2:?--admin-token 需要值}"; shift 2 ;;
    --remote-root) REMOTE_ROOT="${2:?--remote-root 需要值}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$BOARD" ] || { echo "缺少 --board" >&2; exit 2; }
[ -n "$DEVICE_ID" ] || { echo "缺少 --device-id" >&2; exit 2; }
[ -n "$ADMIN_TOKEN" ] || { echo "缺少 --admin-token 或 RDK_CREDITS_ADMIN_TOKEN" >&2; exit 2; }
command -v curl >/dev/null || { echo "本机缺少 curl" >&2; exit 1; }
command -v ssh >/dev/null || { echo "本机缺少 ssh" >&2; exit 1; }
command -v scp >/dev/null || { echo "本机缺少 scp" >&2; exit 1; }

payload="$(python3 - "$DEVICE_ID" "$MODEL" "$FIRMWARE" <<'PY'
import json, sys
device, model, firmware = sys.argv[1:]
body = {'deviceId': device, 'displayName': device}
if model:
    body['model'] = model
if firmware:
    body['labels'] = {'firmware': firmware}
print(json.dumps(body))
PY
)"

response="$(curl -fsS -X POST "$REPORT_URL/api/ops/observability/devices" \
  -H "content-type: application/json" -H "x-admin-token: $ADMIN_TOKEN" \
  --data "$payload")"
token="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
device="$(printf '%s' "$response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["device"]["deviceId"])')"

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
printf '%s\n' "$token" > "$tmp_dir/device-token"
chmod 600 "$tmp_dir/device-token"
{
  printf 'RDK_OBS_REPORT_URL=%q\n' "$REPORT_URL"
  printf 'RDK_DEVICE_TOKEN_FILE=/var/lib/rdk-edge-agent/device-token\n'
  printf 'RDK_DEVICE_ID=%q\n' "$device"
  printf 'RDK_EDGE_MODEL=%q\n' "$MODEL"
  printf 'RDK_EDGE_FIRMWARE=%q\n' "$FIRMWARE"
  printf 'RDK_EDGE_OUTBOX_PATH=/var/lib/rdk-edge-agent/outbox.jsonl\n'
} > "$tmp_dir/rdk-edge-agent.env"
chmod 600 "$tmp_dir/rdk-edge-agent.env"
scp "$ROOT/tools/edge-agent.mjs" "$ROOT/ops/edge-agent/rdk-edge-agent.service" "$USER_NAME@$BOARD:/tmp/"
scp "$tmp_dir/device-token" "$tmp_dir/rdk-edge-agent.env" "$USER_NAME@$BOARD:/tmp/"
ssh "$USER_NAME@$BOARD" "set -e
  install -d -m 0755 '$REMOTE_ROOT/tools' /var/lib/rdk-edge-agent
  install -m 0755 /tmp/edge-agent.mjs '$REMOTE_ROOT/tools/edge-agent.mjs'
  install -m 0644 /tmp/rdk-edge-agent.service /etc/systemd/system/rdk-edge-agent@.service
  install -m 0600 /tmp/device-token /var/lib/rdk-edge-agent/device-token
  install -m 0600 /tmp/rdk-edge-agent.env /etc/default/rdk-edge-agent
  systemctl daemon-reload
  systemctl enable --now 'rdk-edge-agent@$device.service'
  systemctl is-active --quiet 'rdk-edge-agent@$device.service'
  rm -f /tmp/edge-agent.mjs /tmp/rdk-edge-agent.service /tmp/device-token /tmp/rdk-edge-agent.env"

echo "设备已注册并启动：$device@$BOARD"
echo "验证：ssh $USER_NAME@$BOARD journalctl -u rdk-edge-agent@$device.service -n 20 --no-pager"
