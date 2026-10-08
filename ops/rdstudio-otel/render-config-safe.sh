#!/usr/bin/env bash
set -euo pipefail

# Render a Collector candidate without replacing the last config that passed
# the host capability digest gate. A release may change the renderer before
# its production evidence is renewed; keeping the previous config prevents a
# restart loop and leaves the capability validator in control.
ENV_FILE="${STUDIO_OTEL_ENV_FILE:-/etc/rdstudio-otel-collector.env}"
CONFIG_FILE="${STUDIO_OTEL_CONFIG_FILE:-/var/lib/rdstudio-otel-collector/config.yaml}"
CAPABILITY_FILE="${STUDIO_OTEL_SCOPE_ISOLATION_CAPABILITY_FILE:-/etc/rdstudio-otel/scope-isolation-capability.json}"
GENERATOR="${STUDIO_OTEL_CONFIG_GENERATOR:-/opt/rdstudio-web-opt/current/ops/otel-collector/collector-config-v1.mjs}"
NODE="${STUDIO_OTEL_NODE:-/opt/node-v22.16.0-linux-x64/bin/node}"
CANDIDATE="${CONFIG_FILE}.candidate.$$"

cleanup() { rm -f "$CANDIDATE"; }
trap cleanup EXIT

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

"$NODE" "$GENERATOR" \
  --cohort "${STUDIO_OTEL_ROLLOUT_COHORT:?missing STUDIO_OTEL_ROLLOUT_COHORT}" \
  --mode "${STUDIO_OTEL_COLLECTOR_MODE:?missing STUDIO_OTEL_COLLECTOR_MODE}" \
  --out "$CANDIDATE"

expected="$(python3 - "$CAPABILITY_FILE" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['pipelineConfigSha256'])
PY
)"
candidate_sha="$(sha256sum "$CANDIDATE" | awk '{print $1}')"

if [[ "$candidate_sha" == "$expected" ]]; then
  install -o rdstudio-otel -g rdstudio-otel -m 0640 "$CANDIDATE" "$CONFIG_FILE"
  echo "[rdstudio-otel] rendered and accepted config sha256=$candidate_sha"
  exit 0
fi

if [[ -f "$CONFIG_FILE" ]]; then
  current_sha="$(sha256sum "$CONFIG_FILE" | awk '{print $1}')"
  if [[ "$current_sha" == "$expected" ]]; then
    echo "[rdstudio-otel] renderer candidate sha256=$candidate_sha differs from attested sha256=$expected; retaining current config" >&2
    exit 0
  fi
fi

echo "[rdstudio-otel] no config matches attested sha256=$expected (candidate=$candidate_sha)" >&2
exit 1
