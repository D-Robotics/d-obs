#!/usr/bin/env node
/**
 * d-obs log bridge: rdkstudio journald → d-obs OTLP/HTTP logs。
 *
 * 背景：rdstudio-otel-collector 是裁剪版发行（仅 otlp receiver，无 journald），
 * 且应用侧自 2026-09-10 起基本不向 collector 发 OTLP；rdstudio 各 systemd 单元
 * 的真实日志在 journald 里。本桥轮询 journalctl（--after-cursor 续传）跟随指定
 * 单元，批量转换为 OTLP/HTTP JSON logs 推给 d-obs（凭据归账
 * owner=service:rdkstudio-web），让 d-obs 日志查询与事故根因关联对 rdkstudio
 * 故障有料可查。
 *
 * 设计约束：低敏感（service.name 只取单元名、body 截断 1000 由 d-obs 侧白名单
 * 二次把关）、有界队列（溢出丢最旧并计数）、断点续传（--after-cursor +
 * --show-cursor 轮询，游标显式落盘，重启不重不漏；本机 systemd 的
 * --cursor-file 不落盘故不采用）、失败退避重试、绝不向 journald 回写日志
 * （防自反馈）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = String(process.env.RDK_LOG_BRIDGE_ENDPOINT ?? 'http://127.0.0.1:18093').replace(/\/+$/, '');
const TOKEN = String(process.env.RDK_LOG_BRIDGE_TOKEN ?? '').trim();
const UNITS = String(process.env.RDK_LOG_BRIDGE_UNITS ?? '')
  .split(',')
  .map((unit) => unit.trim())
  .filter(Boolean);
const STATE_DIR = String(process.env.RDK_LOG_BRIDGE_STATE_DIR ?? '/var/lib/d-obs-log-bridge');
const CURSOR_FILE = path.join(STATE_DIR, 'journal-cursor');
const HOST_NAME = String(process.env.RDK_LOG_BRIDGE_HOST ?? '') || hostname();
const BOOTSTRAP_SINCE = String(process.env.RDK_LOG_BRIDGE_BOOTSTRAP ?? '-15m');
const FLUSH_INTERVAL_MS = Number(process.env.RDK_LOG_BRIDGE_FLUSH_MS ?? 3_000);
const FLUSH_BATCH = Number(process.env.RDK_LOG_BRIDGE_BATCH ?? 100);
const QUEUE_LIMIT = Number(process.env.RDK_LOG_BRIDGE_QUEUE ?? 5_000);
const POLL_INTERVAL_MS = Number(process.env.RDK_LOG_BRIDGE_POLL_MS ?? 5_000);
const MAX_BODY = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** journal PRIORITY(syslog) → OTel severityNumber：0-3 err+、4 warning、5-6 info、7 debug。 */
function severityFromPriority(raw) {
  const priority = Number(raw);
  if (!Number.isFinite(priority)) return { text: 'INFO', number: 9 };
  if (priority <= 3) return { text: 'ERROR', number: 17 };
  if (priority === 4) return { text: 'WARN', number: 13 };
  if (priority <= 6) return { text: 'INFO', number: 9 };
  return { text: 'DEBUG', number: 5 };
}

function unitToService(unit) {
  const name = String(unit ?? '').replace(/\.service$/, '');
  // journalctl -u 会带上 systemd 管理器自身的启停消息（_SYSTEMD_UNIT=init.scope），
  // 它们不属于任何业务单元，归入 service=systemd 保留启停信号。
  return UNITS.includes(name) ? name : 'systemd';
}

const MERGE_WINDOW_MS = 2_000;
const MERGE_BODY_LIMIT = 8_000;

/**
 * 多行重组：journald 把 stdout 多行输出（pretty JSON dump、堆栈）按行拆成
 * 独立条目，直接上报就是碎片噪音。这里把「同单元同进程 2 秒内、且行长像
 * 续行」的条目并回上一条。
 *
 * 续行判定（保守）：行首为闭合碎片（} ] " , 空白缩进），或行首为 { [ 但
 * 括号不平衡（pretty dump 的起始行）；平衡的 { 开头视为独立的单行 JSON
 * 日志，不并。[tag] message 形态（[ 后紧跟字母）始终视为新消息开头。
 */
export function createReassembler() {
  let last = null;
  function isContinuation(entry, message) {
    if (!last) return false;
    if (String(entry._SYSTEMD_UNIT ?? '') !== last.unit) return false;
    if (String(entry._PID ?? '') !== last.pid) return false;
    const timeUs = Number(entry.__REALTIME_TIMESTAMP ?? 0);
    if (Number.isFinite(timeUs) && timeUs / 1000 - last.timeMs > MERGE_WINDOW_MS) return false;
    const trimmedStart = message.trimStart();
    const head = trimmedStart[0];
    if (!head) return false;
    if (/^\[[A-Za-z]/.test(trimmedStart)) return false;
    if ('}",)]'.includes(head)) return true;
    if (head === '{' || head === '[') {
      // 平衡且闭合 → 独立单行 JSON；不平衡 → pretty dump 起始行。
      const open = head === '{' ? ['{', '}'] : ['[', ']'];
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (const ch of trimmedStart) {
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === open[0]) depth += 1;
        else if (ch === open[1]) depth -= 1;
      }
      return inString || depth !== 0;
    }
    return false;
  }
  return {
    push(entry) {
      const message = typeof entry.MESSAGE === 'string' ? entry.MESSAGE : '';
      if (!message.trim()) return null;
      if (last && isContinuation(entry, message)) {
        if (last.body.length + message.length + 1 <= MERGE_BODY_LIMIT) {
          last.body += `\n${message}`;
        }
        last.timeEndMs = Number(entry.__REALTIME_TIMESTAMP ?? 0) / 1000;
        return null;
      }
      const record = {
        unit: String(entry._SYSTEMD_UNIT ?? ''),
        pid: String(entry._PID ?? ''),
        timeMs: Number(entry.__REALTIME_TIMESTAMP ?? 0) / 1000,
        priority: entry.PRIORITY,
        body: message,
      };
      last = record;
      return record;
    },
    /** flush 后调用：上一条可能已发出，续行不能再并入。 */
    flushed(record) {
      if (last === record) last = null;
    },
  };
}

const pending = [];
let dropped = 0;
let lastDropReportAt = 0;
const reassembler = createReassembler();

function enqueue(entry) {
  const record = reassembler.push(entry);
  if (!record) return;
  if (pending.length >= QUEUE_LIMIT) {
    pending.shift();
    dropped += 1;
    const now = Date.now();
    if (now - lastDropReportAt >= 60_000) {
      lastDropReportAt = now;
      process.stderr.write(`[d-obs-log-bridge] queue overflow, dropped total=${dropped}\n`);
    }
  }
  pending.push(record);
}

function toLogRecord(record) {
  if (!record.body.trim()) return null;
  const severity = severityFromPriority(record.priority);
  const timestampMs = Math.round(record.timeMs);
  return {
    timeUnixNano: (BigInt(Number.isFinite(timestampMs) ? timestampMs : 0) * 1_000_000n).toString(),
    severityText: severity.text,
    severityNumber: severity.number,
    body: record.body.slice(0, MAX_BODY),
  };
}

/** 按单元分组打包为 OTLP/HTTP JSON logs resourceLogs（输入为重组后的记录）。 */
export function buildOtlpPayload(records) {
  const groups = new Map();
  for (const record of records) {
    const logRecord = toLogRecord(record);
    if (!logRecord) continue;
    const service = unitToService(record.unit);
    let group = groups.get(service);
    if (!group) {
      group = {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: service } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
            { key: 'host.name', value: { stringValue: HOST_NAME } },
          ],
        },
        scopeLogs: [{ scope: { name: 'd-obs-log-bridge', version: '1.0.0' }, logRecords: [] }],
      };
      groups.set(service, group);
    }
    group.scopeLogs[0].logRecords.push(logRecord);
  }
  return { resourceLogs: [...groups.values()] };
}

async function postBatch(entries) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(buildOtlpPayload(entries)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const data = await response.json().catch(() => null);
    return Number(data?.accepted ?? entries.length);
  } finally {
    clearTimeout(timeout);
  }
}

let retryCount = 0;
async function flush() {
  if (!pending.length) return;
  const batch = pending.splice(0, Math.min(FLUSH_BATCH, pending.length));
  for (const record of batch) reassembler.flushed(record);
  try {
    await postBatch(batch);
    retryCount = 0;
  } catch (error) {
    retryCount += 1;
    pending.unshift(...batch.slice(0, Math.max(0, QUEUE_LIMIT - pending.length)));
    if (retryCount <= 3 || retryCount % 20 === 0) {
      process.stderr.write(`[d-obs-log-bridge] flush failed (${retryCount}): ${error?.message ?? error}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(5, retryCount))));
  }
}

function journalctlArgs(cursor) {
  const args = ['-o', 'json', '--show-cursor'];
  // 本机 systemd 的 --cursor-file 不落盘，改用显式 --after-cursor + --show-cursor：
  // 每轮轮询从上次游标之后取条目，游标在解析成功后持久化，重启不重不漏。
  if (cursor) args.push(`--after-cursor=${cursor}`);
  else args.push(`--since=${BOOTSTRAP_SINCE}`);
  for (const unit of UNITS) args.push('-u', unit);
  return args;
}

let stopping = false;

/** 解析一轮 journalctl 输出：JSON 行入队，末尾 '-- cursor: …' 返回新游标。 */
export function parseJournalOutput(chunk, onEntry) {
  let cursor = null;
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('-- cursor:')) {
      cursor = trimmed.slice('-- cursor:'.length).trim();
      continue;
    }
    try {
      onEntry(JSON.parse(trimmed));
    } catch {
      // 非完整 JSON 行（截断/污染）直接丢弃。
    }
  }
  return cursor;
}

function pollOnce() {
  return new Promise((resolve) => {
    const child = spawn('journalctl', journalctlArgs(readCursor()), { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffer = '';
    let latestCursor = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newlineAt = buffer.lastIndexOf('\n');
      if (newlineAt < 0) return;
      const complete = buffer.slice(0, newlineAt + 1);
      buffer = buffer.slice(newlineAt + 1);
      const cursor = parseJournalOutput(complete, (entry) => enqueue(entry));
      if (cursor) {
        latestCursor = cursor;
        writeCursor(cursor);
      }
    });
    child.on('exit', () => {
      // 尾部无换行的残余不丢：按完整块再解析一次（journalctl 结束前必输出 cursor 行）。
      if (buffer.trim()) {
        const cursor = parseJournalOutput(buffer, (entry) => enqueue(entry));
        if (cursor) {
          latestCursor = cursor;
          writeCursor(cursor);
        }
      }
      resolve(latestCursor);
    });
  });
}

function readCursor() {
  try {
    return existsSync(CURSOR_FILE) ? fsReadFileSync(CURSOR_FILE, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

function writeCursor(cursor) {
  try {
    fsWriteFileSync(CURSOR_FILE, cursor + '\n');
  } catch {
    // 游标写失败只影响重启后的续传起点，不阻断采集。
  }
}

let flushing = false;
let flushTimer = null;
async function flushAll() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.length) {
      await flush();
      // flush 失败已退避重排队，停住等下一周期。
      if (retryCount > 0) break;
    }
  } finally {
    flushing = false;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAll();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function fail(message) {
  process.stderr.write(`[d-obs-log-bridge] fatal: ${message}\n`);
  process.exit(78);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (!TOKEN) fail('RDK_LOG_BRIDGE_TOKEN is required');
  if (!UNITS.length) fail('RDK_LOG_BRIDGE_UNITS is required');
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
      void (async () => {
        while (pending.length && retryCount < 3) await flush();
        process.exit(0);
      })();
    });
  }

  process.stderr.write(
    `[d-obs-log-bridge] polling units: ${UNITS.join(', ')} → ${ENDPOINT} (cursor: ${CURSOR_FILE})\n`,
  );
  scheduleFlush();
  void (async () => {
    while (!stopping) {
      await pollOnce();
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
}
