#!/opt/node-v22.16.0-linux-x64/bin/node
// 扩量 rdstudio-otel-collector 的 export cohort 名单（应用侧 → collector 转发门控）。
// 部署位置：生产主机 47.110.142.255，名单文件 /var/lib/rdstudio-otel-collector/export-cohort-scope-refs
// （0600，rdstudio-otel:rdstudio-otel）。转发器每次批量都会重读该文件，改动热生效、无需重启。
//
// 用法（生产主机 root）：
//   docker exec rdk-credits-pg psql -U rdk -d rdk_credits -Atc \
//     "select distinct sso_user_id from public.agent_run_records
//      where created_at > now() - interval '90 days' and sso_user_id is not null;" > /tmp/accounts.txt
//   node cohort-expand.mjs /tmp/accounts.txt /var/lib/rdstudio-otel-collector/export-cohort-scope-refs.new
//   # 校验行数与 64KB 上限后：install -o rdstudio-otel -g rdstudio-otel -m 600 <new> <target>
//
// 正确性自检：旧灰度名单（2026-08-27 版）的 3 个 ref 应能由 ztc_host/qiaolongli/lx199710 复算命中。

import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const [accountsFile, outFile] = process.argv.slice(2);
if (!accountsFile || !outFile) {
  console.error('usage: cohort-expand.mjs <accounts.txt> <out-file>');
  process.exit(1);
}

const key = readFileSync('/etc/rdstudio-otel/credentials/scope-hash-key', 'utf8').trim();
if (Buffer.byteLength(key, 'utf8') < 32) throw new Error('scope-hash-key too short');

// 与 server/observability/collector-relay-forwarder.ts deriveStudioCollectorScopeRef 逐字节一致
const derive = (account, environment) =>
  'scope-v1:' +
  createHmac('sha256', key)
    .update(`scope-v1\0${environment}\0${account}`)
    .digest('hex')
    .slice(0, 32);

const accounts = readFileSync(accountsFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const refs = [...new Set(accounts.map((account) => derive(account, 'production')))];
if (refs.length === 0) throw new Error('no accounts');
if (!refs.every((ref) => /^scope-v1:[0-9a-f]{32}$/.test(ref))) throw new Error('format violation');

const body = `${refs.sort().join('\n')}\n`;
// 应用侧 configuredCohortScopeRefs 上限 64KB
if (Buffer.byteLength(body) > 64 * 1024) throw new Error(`exceeds 64KB app limit (${Buffer.byteLength(body)}B)`);

writeFileSync(outFile, body, { mode: 0o600 });
console.log(`wrote ${refs.length} refs (${Buffer.byteLength(body)} bytes) -> ${outFile}`);
