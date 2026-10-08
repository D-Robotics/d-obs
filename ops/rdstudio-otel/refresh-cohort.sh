#!/bin/bash
# 每月刷新 relay 导出名单（90 天活跃账号），热生效。
set -euo pipefail
docker exec rdk-credits-pg psql -U rdk -d rdk_credits -Atc "
select distinct sso_user_id from public.agent_run_records
where created_at > now() - interval '90 days' and sso_user_id is not null;" > /tmp/cohort-accounts.txt
TARGET=/var/lib/rdstudio-otel-collector/export-cohort-scope-refs
/opt/node-v22.16.0-linux-x64/bin/node /opt/d-obs-otel-attestation-renew/cohort-expand.mjs \
  /tmp/cohort-accounts.txt "$TARGET.new" >> /var/log/otel-attestation-renew.log 2>&1
install -o rdstudio-otel -g rdstudio-otel -m 600 "$TARGET.new" "$TARGET"
rm -f "$TARGET.new" /tmp/cohort-accounts.txt
echo "$(date -Is) [cohort] refreshed -> $(grep -c . "$TARGET") refs" >> /var/log/otel-attestation-renew.log
