#!/usr/bin/env node
/**
 * RDK 边缘设备采集 agent：跑在 D-Robotics RDK 开发板（X5/S600 等）上，
 * 周期采集 CPU / 内存 / 负载 / 温度 / 磁盘 / BPU 利用率等指标，
 * 上报 d-obs 心跳接口 POST {RDK_OBS_REPORT_URL}/api/edge/heartbeat
 *（请求头 x-rdk-device-token）。零 npm 依赖，仅用 node:stdlib。
 *
 * 弱网离线缓冲（store-and-forward）：上报失败（网络错 / 非 2xx）时把样本
 * 落盘 JSONL outbox（默认 /var/lib/rdk-edge-agent/outbox.jsonl）；恢复后
 * 每次心跳把 outbox 里的旧样本并入 samples 一起上报——按 ts 去重，
 * 单次心跳最多 240 个样本（服务端约束），超过 7 天的旧样本直接丢弃
 *（服务端会拒），outbox 上限 5000 条、超出丢最旧。上报成功后截断 outbox。
 *
 * 环境变量：
 *   RDK_OBS_REPORT_URL               必配，d-obs 基址，如 https://obs.example.com
 *   RDK_DEVICE_TOKEN_FILE            必配，64-hex 设备 token 文件路径
 *   RDK_DEVICE_ID                    可选，日志标识设备（服务端不靠它鉴权）
 *   RDK_EDGE_MODEL / RDK_EDGE_FIRMWARE  可选；缺省从 /proc/device-tree/model 读型号
 *   RDK_EDGE_AGENT_INTERVAL_SECONDS  采集间隔秒数，默认 60
 *   RDK_EDGE_OUTBOX_PATH             离线缓冲文件，默认 /var/lib/rdk-edge-agent/outbox.jsonl
 *
 * 用法：
 *   node tools/edge-agent.mjs           # 常驻采集（systemd 服务）
 *   node tools/edge-agent.mjs --once    # 只采集+上报一轮（cron / timer 调试）
 *
 * systemd 部署见 ops/edge-agent/rdk-edge-agent.service 头部说明。
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const REPORT_URL = String(process.env.RDK_OBS_REPORT_URL || '').trim();
const TOKEN_FILE = String(process.env.RDK_DEVICE_TOKEN_FILE || '').trim();
const DEVICE_ID = String(process.env.RDK_DEVICE_ID || '').trim() || hostname();
const INTERVAL_SECONDS = (() => {
  const value = Number(process.env.RDK_EDGE_AGENT_INTERVAL_SECONDS);
  return Number.isFinite(value) && value >= 1 ? value : 60;
})();
const OUTBOX_PATH =
  String(process.env.RDK_EDGE_OUTBOX_PATH || '').trim() || '/var/lib/rdk-edge-agent/outbox.jsonl';
const INTERVAL_OVERRIDE_PATH = `${dirname(OUTBOX_PATH)}/interval.txt`; // 下行命令 set-interval 的持久化
const AGENT_PATH = fileURLToPath(import.meta.url);
let intervalSeconds = INTERVAL_SECONDS; // 运行期可被下行命令修改

const MAX_SAMPLES_PER_HEARTBEAT = 240; // 服务端单次心跳上限
const OUTBOX_MAX_ENTRIES = 5000; // 超出丢最旧
const SAMPLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // >7 天服务端会拒，直接丢弃
const REPORT_TIMEOUT_MS = 15000;

function log(message) {
  console.log(`[edge-agent] ${message}`);
}

function shortError(error) {
  return String(error?.message || error).slice(0, 160);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---- 采集：每个函数只负责往 metrics 里填自己的字段，单项失败不影响其他项 ----

let prevCpuTotals = null; // CPU 需两轮差值；首次采集无前值时跳过该项

async function collectCpu(metrics) {
  const text = await readFile('/proc/stat', 'utf8');
  const parts = (text.split('\n', 1)[0] || '').trim().split(/\s+/);
  if (parts[0] !== 'cpu') throw new Error('unexpected /proc/stat');
  const ticks = parts.slice(1).map(Number);
  const idle = (ticks[3] || 0) + (ticks[4] || 0); // idle + iowait
  const total = ticks.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  if (prevCpuTotals && total > prevCpuTotals.total) {
    const busy = total - prevCpuTotals.total - (idle - prevCpuTotals.idle);
    metrics.cpu_percent = round1(Math.min(100, Math.max(0, (busy / (total - prevCpuTotals.total)) * 100)));
  }
  prevCpuTotals = { total, idle };
}

async function collectMemory(metrics) {
  const info = {};
  for (const line of (await readFile('/proc/meminfo', 'utf8')).split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (match) info[match[1]] = Number(match[2]);
  }
  const totalKb = info.MemTotal;
  if (!totalKb) throw new Error('MemTotal missing');
  const availableKb = info.MemAvailable ?? info.MemFree;
  metrics.mem_total_mb = Math.round(totalKb / 1024);
  if (availableKb != null) {
    const usedKb = totalKb - availableKb;
    metrics.mem_used_mb = Math.round(usedKb / 1024);
    metrics.mem_percent = round1((usedKb / totalKb) * 100);
  }
}

async function collectLoad(metrics) {
  const first = (await readFile('/proc/loadavg', 'utf8')).trim().split(/\s+/)[0];
  const load1 = Number(first);
  if (Number.isFinite(load1)) metrics.load1 = load1;
}

async function collectTemperature(metrics) {
  let maxC = null;
  let zones;
  try {
    zones = (await readdir('/sys/class/thermal')).filter((name) => name.startsWith('thermal_zone'));
  } catch {
    return; // 没有 thermal_zone 就跳过
  }
  for (const zone of zones) {
    try {
      const milliC = Number((await readFile(join('/sys/class/thermal', zone, 'temp'), 'utf8')).trim());
      if (!Number.isFinite(milliC)) continue;
      const celsius = milliC / 1000;
      if (maxC == null || celsius > maxC) maxC = celsius;
    } catch {
      // 单个 zone 读不到就跳过
    }
  }
  if (maxC != null) metrics.temp_c = round1(maxC);
}

async function collectDisk(metrics) {
  const { stdout } = await execFileP('df', ['-kP', '/']);
  const rows = stdout.trim().split('\n').filter(Boolean);
  if (rows.length < 2) throw new Error('unexpected df output');
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const fields = rows[rows.length - 1].trim().split(/\s+/);
  const blocksKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  if (!Number.isFinite(blocksKb) || blocksKb <= 0) throw new Error('unexpected df fields');
  metrics.disk_total_gb = round2(blocksKb / 1048576);
  if (Number.isFinite(usedKb)) {
    metrics.disk_used_gb = round2(usedKb / 1048576);
    metrics.disk_percent = round1((usedKb / blocksKb) * 100);
  }
}

// BPU 尽力而为：文件不存在 / debugfs 未挂载 / 权限不足都静默跳过，绝不报错。
// 常见路径：/sys/devices/system/bpu/bpu*/core_util*、/sys/kernel/debug/bpu*/...
async function readUtilFile(filePath) {
  const raw = (await readFile(filePath, 'utf8')).trim().split(/\s+/)[0];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  // 归一化尽力而为：>100 视为千分数（如 BPU sysfs 常见的 core_utilization）
  return Math.min(100, round1(value > 100 ? value / 10 : value));
}

async function collectBpu(metrics) {
  const roots = ['/sys/devices/system/bpu', '/sys/kernel/debug'];
  for (const root of roots) {
    let entries;
    try {
      entries = (await readdir(root)).filter((name) => name.startsWith('bpu'));
    } catch {
      continue;
    }
    for (const name of entries) {
      const index = name.match(/bpu(\d+)/);
      const label = index ? `bpu${index[1]}` : name.replace(/[^a-z0-9]/gi, '');
      let files;
      try {
        files = (await readdir(join(root, name))).filter((f) => /util/i.test(f));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const util = await readUtilFile(join(root, name, file));
          if (util == null) continue;
          const key =
            files.length > 1
              ? `${label}_${file.replace(/[^a-z0-9]/gi, '').toLowerCase().replace(/util$/, '')}util`
              : `${label}_util`;
          metrics[key] = util;
        } catch {
          // 读不到就跳过
        }
      }
    }
  }
}

async function collectUptime(metrics) {
  const seconds = Number((await readFile('/proc/uptime', 'utf8')).trim().split(/\s+/)[0]);
  if (Number.isFinite(seconds)) metrics.uptime_s = round1(seconds);
}

async function collectSample(ts) {
  const metrics = {};
  const dropped = [];
  for (const [name, collect] of Object.entries({
    cpu: collectCpu,
    mem: collectMemory,
    load: collectLoad,
    temp: collectTemperature,
    disk: collectDisk,
    bpu: collectBpu,
    uptime: collectUptime,
  })) {
    try {
      await collect(metrics);
    } catch {
      dropped.push(name); // 单项采集失败不影响其他项，轮日志里报 drop=<names>
    }
  }
  return { ts, metrics, dropped };
}

// ---- outbox（store-and-forward）：JSONL，每行 {ts, metrics}；原子写（tmp+rename）崩溃安全 ----

function compactOutbox(entries) {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  if (sorted.length > OUTBOX_MAX_ENTRIES) sorted.splice(0, sorted.length - OUTBOX_MAX_ENTRIES); // 丢最旧
  return sorted;
}

async function loadOutbox() {
  let raw;
  try {
    raw = await readFile(OUTBOX_PATH, 'utf8');
  } catch {
    return [];
  }
  const byTs = new Map(); // 按 ts 去重，同 ts 保留后出现的
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && Number.isFinite(entry.ts) && entry.metrics && typeof entry.metrics === 'object') {
        byTs.set(entry.ts, { ts: entry.ts, metrics: entry.metrics });
      }
    } catch {
      // 坏行直接忽略
    }
  }
  return [...byTs.values()];
}

async function writeOutbox(entries) {
  await mkdir(dirname(OUTBOX_PATH), { recursive: true });
  const tmp = `${OUTBOX_PATH}.tmp`;
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(tmp, body ? `${body}\n` : '', 'utf8');
  await rename(tmp, OUTBOX_PATH);
}

// ---- 上报 ----

async function reportHeartbeat(token, model, firmware, samples) {
  const response = await fetch(`${REPORT_URL}/api/edge/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rdk-device-token': token,
      'user-agent': 'd-obs-edge-agent/1',
    },
    body: JSON.stringify({ model, firmware, samples: samples.map(({ ts, metrics }) => ({ ts, metrics })) }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  return { ok: response.status >= 200 && response.status < 300, status: response.status };
}

async function runRound(token, model, firmware) {
  const now = Date.now();
  const sample = await collectSample(now);

  const buffered = (await loadOutbox()).filter((entry) => entry.ts >= now - SAMPLE_MAX_AGE_MS); // >7 天直接丢弃
  const byTs = new Map();
  for (const entry of buffered) byTs.set(entry.ts, entry);
  byTs.set(sample.ts, sample); // 当前样本优先，覆盖同 ts 的缓冲项
  const all = [...byTs.values()].sort((a, b) => a.ts - b.ts); // 旧→新，FIFO 追平积压
  const send = all.slice(-MAX_SAMPLES_PER_HEARTBEAT); // 最多 240，最新的优先上报
  const sentTs = new Set(send.map((entry) => entry.ts));

  try {
    const { ok, status } = await reportHeartbeat(token, model, firmware, send);
    if (!ok) throw new Error(`HTTP ${status}`);
    const remaining = all.filter((entry) => !sentTs.has(entry.ts)); // 成功后截断已上报样本
    await writeOutbox(remaining);
    await handleCommands(token);
    log(
      `dev=${DEVICE_ID} samples=${send.length} report=ok status=${status} outbox=${remaining.length}` +
        (sample.dropped.length ? ` drop=${sample.dropped.join(',')}` : ''),
    );
  } catch (error) {
    // 失败：当前样本并入 outbox（未发送的旧样本原样保留，下轮再试）
    const remaining = compactOutbox(all);
    await writeOutbox(remaining);
    log(
      `dev=${DEVICE_ID} samples=${send.length} report=fail buffered=+1 outbox=${remaining.length}` +
        ` error=${shortError(error)}` +
        (sample.dropped.length ? ` drop=${sample.dropped.join(',')}` : ''),
    );
  }
}

// ---- 下行命令：认领 → 执行 → 回执（v1 只有 ping / set-interval / update-agent） ----

async function ackCommand(token, commandId, status, result) {
  const response = await fetch(`${REPORT_URL}/api/edge/commands/${encodeURIComponent(commandId)}/ack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rdk-device-token': token,
      'user-agent': 'd-obs-edge-agent/1',
    },
    body: JSON.stringify({ status, result }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  if (!(response.status >= 200 && response.status < 300)) throw new Error(`ack HTTP ${response.status}`);
}

async function handleCommands(token) {
  let commands = [];
  try {
    const response = await fetch(`${REPORT_URL}/api/edge/commands/claim`, {
      method: 'POST',
      headers: { 'x-rdk-device-token': token, 'user-agent': 'd-obs-edge-agent/1' },
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.ok) return;
    commands = Array.isArray(data.commands) ? data.commands : [];
  } catch {
    return; // 认领失败不打断上报主流程
  }
  for (const cmd of commands) {
    let status = 'ok';
    let result = '';
    try {
      if (cmd.type === 'ping') {
        result = 'pong';
      } else if (cmd.type === 'set-interval') {
        const seconds = Number(cmd.payload?.intervalSeconds);
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) throw new Error('bad intervalSeconds');
        intervalSeconds = seconds;
        await mkdir(dirname(INTERVAL_OVERRIDE_PATH), { recursive: true });
        await writeFile(INTERVAL_OVERRIDE_PATH, String(seconds), 'utf8');
        result = `interval=${seconds}s`;
      } else if (cmd.type === 'update-agent') {
        const script = await fetch(`${REPORT_URL}/api/edge/agent-script`, { signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) });
        if (!(script.status >= 200 && script.status < 300)) throw new Error(`script HTTP ${script.status}`);
        const source = await script.text();
        if (!source.includes('d-obs-edge-agent') || source.length < 1000) throw new Error('script marker missing');
        const tmp = `${AGENT_PATH}.update`;
        await writeFile(tmp, source, 'utf8');
        await rename(tmp, AGENT_PATH);
        result = `updated ${source.length}B, restarting`;
        await ackCommand(token, cmd.id, status, result).catch(() => {});
        log(`dev=${DEVICE_ID} command=update-agent applied, exiting for supervisor restart`);
        process.exit(0);
      } else {
        throw new Error(`unknown type ${cmd.type}`);
      }
    } catch (error) {
      status = 'failed';
      result = shortError(error);
    }
    try {
      await ackCommand(token, cmd.id, status, result);
    } catch { /* 回执失败不影响下一轮 */ }
    log(`dev=${DEVICE_ID} command=${cmd.type} ${status} ${result}`);
  }
}

async function detectModel() {
  try {
    const model = (await readFile('/proc/device-tree/model', 'utf8')).replace(/\0/g, '').trim();
    if (model) return model;
  } catch {
    // 非 RDK 环境（如本机调试）读不到就不管
  }
  return '';
}

async function main() {
  const once = process.argv.includes('--once');

  const missing = [];
  if (!REPORT_URL) missing.push('RDK_OBS_REPORT_URL');
  if (!TOKEN_FILE) missing.push('RDK_DEVICE_TOKEN_FILE');
  if (missing.length) {
    console.error(
      `[edge-agent] 缺少必配环境变量: ${missing.join(', ')}\n` +
        '[edge-agent] 配置方法见 ops/edge-agent/rdk-edge-agent.service 头部部署说明（通常写入 /etc/default/rdk-edge-agent）',
    );
    process.exitCode = 2;
    return;
  }

  let token = '';
  try {
    token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  } catch (error) {
    console.error(`[edge-agent] 无法读取 token 文件 ${TOKEN_FILE}: ${shortError(error)}`);
    process.exitCode = 2;
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    console.error(`[edge-agent] token 文件 ${TOKEN_FILE} 内容不是 64 位 hex`);
    process.exitCode = 2;
    return;
  }

  try {
    const override = Number((await readFile(INTERVAL_OVERRIDE_PATH, 'utf8')).trim());
    if (Number.isFinite(override) && override >= 5 && override <= 3600) intervalSeconds = override;
  } catch {
    // 无覆盖文件时用 env/默认值
  }

  const model = String(process.env.RDK_EDGE_MODEL || '').trim() || (await detectModel()) || 'unknown';
  const firmware = String(process.env.RDK_EDGE_FIRMWARE || '').trim() || 'unknown';

  if (once) {
    await runRound(token, model, firmware);
    return;
  }

  log(
    `dev=${DEVICE_ID} model="${model}" firmware="${firmware}" interval=${intervalSeconds}s ` +
      `report=${REPORT_URL} outbox=${OUTBOX_PATH} started`,
  );

  let stopping = false;
  let running = false;
  const wakeups = new Set();
  const sleep = (ms) =>
    new Promise((resolve) => {
      wakeups.add(resolve);
      setTimeout(() => {
        wakeups.delete(resolve);
        resolve();
      }, ms);
    });
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    for (const wake of wakeups) wake();
    if (!running) process.exit(0); // 空闲时立即退；采集/上报中则等本轮结束后退
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (!stopping) {
    running = true;
    try {
      await runRound(token, model, firmware);
    } catch (error) {
      // 主循环 catch 全部异常并继续
      console.error(`[edge-agent] round failed, continue: ${shortError(error)}`);
    }
    running = false;
    if (stopping) break;
    await sleep(intervalSeconds * 1000);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`[edge-agent] fatal: ${shortError(error)}`);
  process.exitCode = 1;
});
