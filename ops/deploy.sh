#!/usr/bin/env bash
#
# d-obs 一键发布：本机构建 → 打包 → 上传 → 双向校验 → 切软链 → 重启 → 健康检查（失败自动回滚）
#
# 用法：
#   ops/deploy.sh --tag tenant-id-ux                # 用当前 HEAD 发布
#   ops/deploy.sh --tag tenant-id-ux --dry-run      # 只在本机构建打包，不碰服务器
#   ops/deploy.sh --tag hotfix --allow-dirty        # 允许带未提交改动发布（会打警告）
#   ops/deploy.sh --tag deps --with-deps            # package.json 变了：连本地 node_modules 一起传
#
# 为什么这么写（每条都是踩过的坑）：
#   * 默认拒绝脏工作区。发布产物必须能对应到一个 commit，否则「线上 == HEAD」无法证明，
#     事后没人能说清线上跑的到底是哪份代码。
#   * 依赖不从本地上传。服务器到 npm registry 不通，但每次传 180MB node_modules 又太慢；
#     改为在服务器上 `cp -al` 硬链上一版 node_modules（秒级）。硬链而不是软链：删旧 release
#     不会把新 release 的依赖一起删掉。package.json 只比对 dependencies/devDependencies 段
#     （scripts 等变更不该触发全量依赖重传）。
#   * 上传前后都校验 sha256。曾经因为 `tar --czf`（少一个横杠）失败被 `2>/dev/null` 吞掉，
#     scp 了一个上一轮的旧包，却对外宣称发布成功。所以这里所有命令都不吞 stderr，
#     并且「本地算哈希 → 服务器上核对解压前/后的文件」。
#   * 切软链后健康检查不过就自动滚回上一版，不留半死状态。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="root@47.110.142.255"
PORT="18093"
TAG=""
DRY_RUN=0
ALLOW_DIRTY=0
WITH_DEPS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag 需要值}"; shift 2 ;;
    --host) HOST="${2:?--host 需要值}"; shift 2 ;;
    --port) PORT="${2:?--port 需要值}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --with-deps) WITH_DEPS=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 本机前置检查
cd "$ROOT"
command -v git >/dev/null || { echo "缺少 git" >&2; exit 1; }
export COPYFILE_DISABLE=1

HEAD_SHA="$(git rev-parse HEAD)"
HEAD_SHORT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ -n "$TAG" ] || TAG="$HEAD_SHORT"

if [ -n "$(git status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" = "1" ]; then
    echo "警告：工作区有未提交改动，本次发布的产物无法用 commit 复现（HEAD=$HEAD_SHORT）" >&2
  else
    echo "工作区有未提交改动，拒绝发布。先提交，或显式加 --allow-dirty（并自行承担线上无法溯源）。" >&2
    git status --short >&2
    exit 1
  fi
fi

RELEASE="${TAG}-$(date +%Y%m%d-%H%M%S)"
say "发布 $RELEASE（$BRANCH @ $HEAD_SHORT）"

# ---------------------------------------------------------------- 构建 + 打包
say "构建"
npm run build:clean

STAGE="$(mktemp -d)"
TGZ="$(mktemp -t d-obs-rel).tgz"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cp -R "$ROOT/dist/server" "$ROOT/dist/shared" "$STAGE/"
cp "$ROOT/package.json" "$STAGE/"
# ops/ 与 tools/ 一并随包：systemd 单元（备份 timer、探针、保留期清理）引用
# /opt/d-obs/current/{ops,tools} 下的脚本，发布必须保持它们与代码同版本。
cp -R "$ROOT/ops" "$ROOT/tools" "$STAGE/"
find "$STAGE" -name '*.d.ts' -delete
if [ "$WITH_DEPS" = "1" ]; then
  say "打包依赖（本地 node_modules 整树）"
  cp -R "$ROOT/node_modules" "$STAGE/node_modules"
fi

# --no-xattrs：macOS 的 bsdtar 会把 com.apple.provenance 塞进扩展头，远端 GNU tar
# 解压时刷一屏 "Ignoring unknown extended header keyword" 噪音，容易盖住真正的报错。
tar --no-xattrs --exclude='.DS_Store' --exclude='.git' -czf "$TGZ" -C "$STAGE" .
[ -s "$TGZ" ] || { echo "打包失败：$TGZ 为空" >&2; exit 1; }

# 入口必须在包里 —— 这是「scp 了旧包/空包」的第一道闸
tar -tzf "$TGZ" | grep -qx './server/main.js' || { echo "包内缺少 ./server/main.js，拒绝上传" >&2; exit 1; }
tar -tzf "$TGZ" | grep -qx './package.json' || { echo "包内缺少 ./package.json，拒绝上传" >&2; exit 1; }
JS_COUNT="$(tar -tzf "$TGZ" | grep -c '\.js$' || true)"
HASH="$(shasum -a 256 "$TGZ" | awk '{print $1}')"
say "包就绪：$TGZ（$JS_COUNT 个 js，$(du -h "$TGZ" | cut -f1)，sha256 ${HASH:0:12}…）"

REMOTE_TGZ="/tmp/d-obs-${RELEASE}.tgz"
if [ "$DRY_RUN" = "1" ]; then
  say "dry-run：跳过上传与远端操作。远端将执行："
  cat <<EOF
  scp $TGZ $HOST:$REMOTE_TGZ
  远端: 校验 sha256=$HASH
  远端: mkdir -p /opt/d-obs/releases/$RELEASE && tar -xzf $REMOTE_TGZ -C 该目录
  远端: 硬链上一版 node_modules（package.json 一致时）
  远端: ln -sfn releases/$RELEASE /opt/d-obs/current && systemctl restart d-obs
  远端: 健康检查 http://127.0.0.1:$PORT/ops-observability 必须 200，否则自动回滚
EOF
  exit 0
fi

# ---------------------------------------------------------------- 上传 + 远端校验
say "上传"
scp -q "$TGZ" "$HOST:$REMOTE_TGZ"
printf '%s\n' "$HASH" > "$TGZ.sha256"
scp -q "$TGZ.sha256" "$HOST:${REMOTE_TGZ}.sha256"

say "远端发布"
if ssh "$HOST" \
  "RELEASE='$RELEASE' REMOTE_TGZ='$REMOTE_TGZ' HASH='$HASH' PORT='$PORT' WITH_DEPS='$WITH_DEPS' bash -s" <<'REMOTE'
set -euo pipefail
REL_DIR="/opt/d-obs/releases/$RELEASE"
CUR_LINK="/opt/d-obs/current"

say() { printf '\033[1m== %s\033[0m\n' "$*"; }

[ -f "$REMOTE_TGZ" ] || { echo "上传的包不存在：$REMOTE_TGZ" >&2; exit 1; }
ACTUAL="$(sha256sum "$REMOTE_TGZ" | awk '{print $1}')"
if [ "$ACTUAL" != "$HASH" ]; then
  echo "sha256 不一致，拒绝解压：本地=$HASH 服务器=$ACTUAL" >&2
  echo "（上传被截断或被中间设备改写，重跑一次发布即可）" >&2
  exit 1
fi
say "sha256 校验通过"

PREV="$(readlink -f "$CUR_LINK")"
[ -d "$PREV" ] || { echo "current 软链异常：$PREV" >&2; exit 1; }

if [ -e "$REL_DIR" ]; then echo "release 目录已存在：$REL_DIR" >&2; exit 1; fi
mkdir "$REL_DIR"
tar -xzf "$REMOTE_TGZ" -C "$REL_DIR"
[ -f "$REL_DIR/server/main.js" ] || { echo "解压后缺少 server/main.js" >&2; exit 1; }
[ -f "$REL_DIR/package.json" ] || { echo "解压后缺少 package.json" >&2; exit 1; }
say "解压完成：$REL_DIR"

# 依赖：package.json 未变则硬链上一版（快、且不会因删旧 release 断链）
if [ "$WITH_DEPS" != "1" ]; then
  if [ ! -d "$PREV/node_modules" ]; then
    echo "上一版没有 node_modules，无法复用；请用 --with-deps 发布" >&2; exit 1
  fi
  deps_of() {
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps({"dependencies":d.get("dependencies",{}),"devDependencies":d.get("devDependencies",{})},sort_keys=True))' "$1"
  }
  if [ "$(deps_of "$REL_DIR/package.json")" != "$(deps_of "$PREV/package.json")" ]; then
    echo "package.json 与上一版不同（依赖可能变了），拒绝复用旧 node_modules。" >&2
    echo "确认本地 node_modules 已装好后，用 --with-deps 重新发布。" >&2
    exit 1
  fi
  cp -al "$PREV/node_modules" "$REL_DIR/node_modules"
  say "复用依赖（硬链自 $PREV）"
fi

say "切换软链并重启"
ln -sfn "releases/$RELEASE" "$CUR_LINK"
if ! systemctl restart d-obs; then
  echo "重启失败，回滚" >&2
fi

healthy=0
for _ in $(seq 1 15); do
  sleep 1
  if systemctl is-active --quiet d-obs \
     && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ops-observability" || true)" = "200" ]; then
    healthy=1; break
  fi
done

if [ "$healthy" != "1" ]; then
  echo "健康检查未通过，自动回滚到 $PREV" >&2
  journalctl -u d-obs -n 20 --no-pager >&2 || true
  ln -sfn "$PREV" "$CUR_LINK"
  systemctl restart d-obs || true
  sleep 3
  echo "已回滚：current -> $(readlink -f "$CUR_LINK")，active=$(systemctl is-active d-obs)" >&2
  exit 1
fi

rm -f "$REMOTE_TGZ" "$REMOTE_TGZ.sha256"

# 告警 worker 与 Web 同库同版：worker 单元（rdk-observability-worker.service，
# timer 每分钟 oneshot）的 current 软链指向本 release。它曾独立部署在
# /opt/rdk-observability/releases，与 Web 漂移 10 天导致新告警信号不上线；
# 单元 ExecStart 的 server/（无 dist 前缀）布局由 drop-in override.conf 对齐。
# 回滚时两处软链要一起切。
WORKER_LINK=/opt/rdk-observability/current
if [ -d /opt/rdk-observability ] && [ "$(readlink -f "$WORKER_LINK" 2>/dev/null || true)" != "$REL_DIR" ]; then
  PREV_WORKER="$(readlink -f "$WORKER_LINK" 2>/dev/null || true)"
  ln -sfn "$REL_DIR" "$WORKER_LINK"
  say "worker 同步：$WORKER_LINK -> $REL_DIR（上一版 $PREV_WORKER）"
fi

say "发布成功"
echo "current  -> $(readlink -f "$CUR_LINK")"
echo "上一版   -> $PREV"
echo "回滚命令 -> ln -sfn $PREV $CUR_LINK && systemctl restart d-obs && ln -sfn $PREV /opt/rdk-observability/current"
echo "release 数：$(ls -1 /opt/d-obs/releases | wc -l)，占用 $(du -sh /opt/d-obs/releases | cut -f1)"
REMOTE
then
  say "完成：$RELEASE"
  echo "回滚点：上一版 release 仍在 /opt/d-obs/releases（建议保留 current + 上一个，其余可删）"
else
  # 远端拒绝了这次发布（sha256 不符 / 依赖不允许复用 / 健康检查回滚等）：
  # 清掉服务器上的上传包，别在 /tmp 里越堆越多；未切换的 release 目录留着便于排查。
  ssh "$HOST" "rm -f '$REMOTE_TGZ' '${REMOTE_TGZ}.sha256'" || true
  echo "发布未完成（见上面的远端报错）。服务器 /tmp 的上传包已清理；" >&2
  echo "若留下了半成品 release 目录，确认无用后删：rm -rf /opt/d-obs/releases/$RELEASE" >&2
  exit 1
fi
