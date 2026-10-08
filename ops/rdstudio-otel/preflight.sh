#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${STUDIO_OTEL_ENV_FILE:-/etc/rdstudio-otel-collector.env}"
CAPABILITY_FILE="${STUDIO_OTEL_SCOPE_ISOLATION_CAPABILITY_FILE:-/etc/rdstudio-otel/scope-isolation-capability.json}"
EVIDENCE_FILE="${STUDIO_OTEL_SCOPE_ISOLATION_EVIDENCE_FILE:-/etc/rdstudio-otel/scope-isolation-evidence.json}"
CONFIG_FILE="${STUDIO_OTEL_CONFIG_FILE:-/var/lib/rdstudio-otel-collector/config.yaml}"
METRICS_URL="${STUDIO_OTEL_METRICS_URL:-http://127.0.0.1:8888/metrics}"

fail() { echo "[rdstudio-otel-preflight] $*" >&2; logger -t rdstudio-otel-preflight -p daemon.err -- "$*" || true; exit 1; }

[[ -r "$ENV_FILE" ]] || fail "missing environment file: $ENV_FILE"
[[ -r "$CAPABILITY_FILE" ]] || fail "missing capability file: $CAPABILITY_FILE"
[[ -r "$EVIDENCE_FILE" ]] || fail "missing evidence file: $EVIDENCE_FILE"
[[ -r "$CONFIG_FILE" ]] || fail "missing rendered config: $CONFIG_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ "${STUDIO_TRACE_LOCAL_OTLP_ENDPOINT:-}" == "http://127.0.0.1:18093" ]] \
  || fail "local OTLP endpoint is not d-obs: ${STUDIO_TRACE_LOCAL_OTLP_ENDPOINT:-unset}"
token_file="${STUDIO_TRACE_LOCAL_OTLP_TOKEN_FILE:-}"
[[ -n "$token_file" && -r "$token_file" ]] || fail "local OTLP token file is unreadable"
mode="$(stat -c '%a' "$token_file" 2>/dev/null || true)"
[[ "$mode" == "400" || "$mode" == "440" || "$mode" == "600" || "$mode" == "640" ]] \
  || fail "local OTLP token file mode is too broad: ${mode:-unknown}"

python3 - "$CAPABILITY_FILE" "$EVIDENCE_FILE" "$CONFIG_FILE" <<'PY' || fail "capability/evidence digest or expiry check failed"
import datetime as dt
import hashlib
import json
import sys

cap = json.load(open(sys.argv[1], encoding='utf-8'))
evidence = json.load(open(sys.argv[2], encoding='utf-8'))
config_sha = hashlib.sha256(open(sys.argv[3], 'rb').read()).hexdigest()
if cap.get('pipelineConfigSha256') != config_sha:
    raise SystemExit('rendered config does not match capability')
evidence_sha = hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest()
if cap.get('verificationEvidenceSha256') != evidence_sha:
    raise SystemExit('evidence does not match capability')
now = dt.datetime.now(dt.timezone.utc)
valid_until = dt.datetime.fromisoformat(str(evidence.get('validUntil', '')).replace('Z', '+00:00'))
if valid_until <= now:
    raise SystemExit('evidence is expired')
if valid_until - now < dt.timedelta(days=3):
    raise SystemExit('evidence expires in less than 3 days')
if evidence.get('status') != 'passed':
    raise SystemExit('evidence status is not passed')
PY

systemctl is-active --quiet rdstudio-otel-collector.service || fail "collector service is not active"
metrics="$(curl -fsS --max-time 5 "$METRICS_URL")" || fail "collector metrics endpoint unavailable"
grep -q 'otelcol_exporter_sent_spans{[^}]*exporter="otlp_http/local_transition"' <<<"$metrics" \
  || fail "local transition exporter has no sent span counter"
if grep -q 'otelcol_exporter_send_failed_spans{[^}]*exporter="otlp_http/local_transition"[^}]*} [1-9]' <<<"$metrics"; then
  fail "local transition exporter reports failed spans"
fi

echo "[rdstudio-otel-preflight] ok endpoint=${STUDIO_TRACE_LOCAL_OTLP_ENDPOINT} config_sha=$(sha256sum "$CONFIG_FILE" | awk '{print $1}')"
