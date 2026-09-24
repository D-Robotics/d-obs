#!/usr/bin/env node
/**
 * d-obs log bridge: rdkstudio journald / docker 容器 / 任意文件 → d-obs OTLP/HTTP logs。
 *
 * 背景：rdstudio-otel-collector 是裁剪版发行（仅 otlp receiver，无 journald），
 * 且应用侧自 2026-09-10 起基本不向 collector 发 OTLP；rdstudio 各 systemd 单元
 * 的真实日志在 journald 里。本桥轮询采集三类源，批量转换为 OTLP/HTTP JSON
 * logs 推给 d-obs（凭据归账），让日志查询与事故根因关联对 rdkstudio 故障
 * 有料可查：
 *   1. journald：RDK_LOG_BRIDGE_UNITS 逗号分隔的 systemd 单元（journalctl
 *      --after-cursor 显式落盘续传；本机 systemd 的 --cursor-file 不落盘故不采用）；
 *   2. docker 容器：RDK_LOG_BRIDGE_DOCKER `容器#service[#级别白名单]`，docker
 *      logs --timestamps --since 轮询，PG 等按行内级别（ERROR/FATAL/...）过滤；
 *   3. 文件 tail：RDK_LOG_BRIDGE_FILES `/path#service[#级别白名单]`，按 inode+offset
 *      续传（支持轮转），nginx error.log 等时间戳/级别在行内解析。
 *
 * 设计约束：低敏感（service 只取单元名/配置名、body 截断 1000 由 d-obs 侧白名单
 * 二次把关）、有界队列（溢出丢最旧）、多行重组（同源 2 秒内续行并回上一条）、
 * 失败退避重试、绝不向日志源回写日志（防自反馈）。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, fstatSync, statSync, writeFileSync, readFileSync } from 'node:fs';
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
const POLL_INTERVAL_MS = Number(process.env.RDK_LOG_BRIDGE_POLL_MS ?? 5_000);
const FLUSH_INTERVAL_MS = Number(process.env.RDK_LOG_BRIDGE_FLUSH_MS ?? 3_000);
const FLUSH_BATCH = Number(process.env.RDK_LOG_BRIDGE_BATCH ?? 100);
const QUEUE_LIMIT = Number(process.env.RDK_LOG_BRIDGE_QUEUE ?? 5_000);
const MAX_BODY = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MERGE_WINDOW_MS = 2_000;
const MERGE_BODY_LIMIT = 8_000;

/** `a#b#LEVELS` → { a, b, levels? }；levels 为逗号分隔的白名单。 */
function parseSourceSpec(raw) {
  const parts = String(raw ?? '').split('#').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    a: parts[0],
    service: parts[1],
    levels: parts[2] ? new Set(parts[2].split(',').map((level) => level.trim().toUpperCase())) : null,
  };
}

const DOCKER_SOURCES = String(process.env.RDK_LOG_BRIDGE_DOCKER ?? '')
  .split(',')
  .map(parseSourceSpec)
  .filter(Boolean);
const FILE_SOURCES = String(process.env.RDK_LOG_BRIDGE_FILES ?? '')
  .split(',')
  .map(parseSourceSpec)
  .filter(Boolean);

/** journal 单元之外的自定义 service 名（docker/文件源），直接作为 service.name。 */
const EXTRA_SERVICES = new Set([...DOCKER_SOURCES, ...FILE_SOURCES].map((source) => source.service));

function fail(message) {
  process.stderr.write(`[d-obs-log-bridge] fatal: ${message}\n`);
  process.exit(78);
}

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
  return UNITS.includes(name) || EXTRA_SERVICES.has(name) ? name : 'systemd';
}

/** PG 风格行内级别（"... UTC [pid] LEVEL: ..."）→ syslog PRIORITY。 */
export function pgLinePriority(message) {
  const match = /\s(EMERGENCY|ALERT|CRITICAL|ERROR|FATAL|WARNING|NOTICE|LOG|DEBUG|HINT|DETAIL|STATEMENT):\s/.exec(String(message));
  const level = match?.[1] ?? 'LOG';
  if (level === 'EMERGENCY' || level === 'ALERT' || level === 'CRITICAL' || level === 'ERROR' || level === 'FATAL') return '3';
  if (level === 'WARNING') return '4';
  return '6';
}

/** nginx error.log 行：`YYYY/MM/DD HH:MM:SS [level] message` → {timeMs, priority, message}。 */
export function parseNginxLine(line) {
  const match = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.*)$/.exec(line);
  if (!match) return null;
  const [datePart, timePart] = match[1].split(' ');
  const [year, month, day] = datePart.split('/').map(Number);
  const [hours, minutes, seconds] = timePart.split(':').map(Number);
  const timeMs = new Date(year, month - 1, day, hours, minutes, seconds).getTime();
  const level = match[2].toUpperCase();
  const priority =
    level === 'EMERG' || level === 'ALERT' || level === 'CRIT' || level === 'ERROR' ? '3'
      : level === 'WARN' ? '4'
        : level === 'DEBUG' ? '7'
          : '6';
  return { timeMs, priority, message: match[3], level };
}

const pending = [];
let dropped = 0;
let lastDropReportAt = 0;

/**
 * 多行重组：journald/管道把 stdout 多行输出（pretty JSON dump、堆栈）按行拆成
 * 独立条目，直接上报就是碎片噪音。这里把「同源 2 秒内、且行长像续行」的
 * 条目并回上一条。
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

async function postBatch(records) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(buildOtlpPayload(records)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const data = await response.json().catch(() => null);
    return Number(data?.accepted ?? records.length);
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

function journalctlArgs(cursor) {
  const args = ['-o', 'json', '--show-cursor'];
  // 本机 systemd 的 --cursor-file 不落盘，改用显式 --after-cursor + --show-cursor：
  // 每轮轮询从上次游标之后取条目，游标在解析成功后持久化，重启不重不漏。
  if (cursor) args.push(`--after-cursor=${cursor}`);
  else args.push(`--since=${BOOTSTRAP_SINCE}`);
  for (const unit of UNITS) args.push('-u', unit);
  return args;
}

function readCursor() {
  try {
    return existsSync(CURSOR_FILE) ? readFileSync(CURSOR_FILE, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

function writeCursor(cursor) {
  try {
    writeFileSync(CURSOR_FILE, cursor + '\n');
  } catch {
    // 游标写失败只影响重启后的续传起点，不阻断采集。
  }
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

/** `2026-09-24T11:37:00.066Z message` → {timeMs, message}；解析失败返回 null。 */
export function parseDockerLogLine(line) {
  const spaceAt = line.indexOf(' ');
  if (spaceAt <= 0) return null;
  const timeMs = Date.parse(line.slice(0, spaceAt));
  if (!Number.isFinite(timeMs)) return null;
  return { timeMs, message: line.slice(spaceAt + 1) };
}

function dockerCursorFile(container) {
  return path.join(STATE_DIR, `docker-${container.replace(/[^A-Za-z0-9_.-]/g, '_')}.cursor`);
}

function readDockerCursor(container) {
  try {
    return existsSync(dockerCursorFile(container)) ? readFileSync(dockerCursorFile(container), 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

function writeDockerCursor(container, cursorMs) {
  try {
    writeFileSync(dockerCursorFile(container), String(cursorMs));
  } catch {
    // 写失败只影响续传起点。
  }
}

async function pollDockerSource(source) {
  const container = source.a;
  const cursorMs = Number(readDockerCursor(container)) || 0;
  const since = cursorMs ? new Date(cursorMs).toISOString() : BOOTSTRAP_SINCE;
  await new Promise((resolve) => {
    const child = spawn('docker', ['logs', '--timestamps', '--since', since, '--tail', '20000', container], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffer = '';
    let latestMs = cursorMs;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newlineAt = buffer.lastIndexOf('\n');
      if (newlineAt < 0) return;
      const complete = buffer.slice(0, newlineAt + 1);
      buffer = buffer.slice(newlineAt + 1);
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseDockerLogLine(line);
        if (!parsed) continue;
        if (parsed.timeMs <= cursorMs) continue; // --since 边界重放去重
        const priority = pgLinePriority(parsed.message);
        const level = { 3: 'ERROR', 4: 'WARNING', 6: 'LOG' }[priority] ?? 'LOG';
        if (source.levels && !source.levels.has(level)) continue;
        enqueue({
          MESSAGE: parsed.message,
          PRIORITY: priority,
          __REALTIME_TIMESTAMP: String(BigInt(parsed.timeMs) * 1000n),
          _SYSTEMD_UNIT: source.service,
        });
        if (parsed.timeMs > latestMs) latestMs = parsed.timeMs;
      }
    });
    child.on('exit', () => {
      if (latestMs > cursorMs) writeDockerCursor(container, latestMs);
      resolve();
    });
    child.on('error', () => resolve());
  });
}

const fileStates = new Map();

function fileStateKey(filePath) {
  return filePath.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function pollFileSource(source) {
  const key = fileStateKey(source.a);
  let state = fileStates.get(key);
  if (!state) {
    state = { inode: null, offset: 0, remainder: Buffer.alloc(0) };
    fileStates.set(key, state);
  }
  let stat;
  try {
    stat = statSync(source.a);
  } catch {
    return; // 文件暂不存在（未创建/轮转间隙），下轮再看。
  }
  if (state.inode !== null && stat.ino !== state.inode) {
    state.inode = null;
    state.offset = 0;
    state.remainder = Buffer.alloc(0);
  }
  if (state.inode === null) state.inode = stat.ino;
  if (stat.size <= state.offset) return;
  let fd;
  try {
    fd = openSync(source.a, 'r');
    const length = Math.min(stat.size - state.offset, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, state.offset);
    closeSync(fd);
    state.offset += bytesRead;
    let chunk = Buffer.concat([state.remainder, buffer.subarray(0, bytesRead)]);
    let newlineAt = chunk.lastIndexOf(0x0a);
    if (newlineAt < 0) {
      state.remainder = chunk;
      return;
    }
    const complete = chunk.subarray(0, newlineAt);
    state.remainder = chunk.subarray(newlineAt + 1);
    for (const rawLine of complete.toString('utf8').split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim()) continue;
      const parsed = parseNginxLine(line) ?? { timeMs: Date.now(), priority: '6', message: line };
      const level = { 3: 'ERROR', 4: 'WARN', 6: 'INFO', 7: 'DEBUG' }[parsed.priority] ?? 'INFO';
      if (source.levels && !source.levels.has(level)) continue;
      if (parsed.priority === '7') continue; // debug 默认不采
      enqueue({
        MESSAGE: parsed.message,
        PRIORITY: parsed.priority,
        __REALTIME_TIMESTAMP: String(BigInt(parsed.timeMs) * 1000n),
        _SYSTEMD_UNIT: source.service,
      });
    }
  } catch (error) {
    process.stderr.write(`[d-obs-log-bridge] file poll failed (${source.a}): ${error?.message ?? error}\n`);
    if (fd !== undefined) closeSync(fd);
  }
}

let stopping = false;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAll();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
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

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (!TOKEN) fail('RDK_LOG_BRIDGE_TOKEN is required');
  if (!UNITS.length && !DOCKER_SOURCES.length && !FILE_SOURCES.length) fail('no sources configured');
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

  const sourceSummary = [
    UNITS.length ? `journal: ${UNITS.length} units` : null,
    DOCKER_SOURCES.length ? `docker: ${DOCKER_SOURCES.map((s) => s.a).join(',')}` : null,
    FILE_SOURCES.length ? `files: ${FILE_SOURCES.map((s) => s.a).join(',')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
  process.stderr.write(`[d-obs-log-bridge] ${sourceSummary} → ${ENDPOINT}\n`);
  scheduleFlush();
  void (async () => {
    while (!stopping) {
      const tasks = [pollOnce()];
      for (const source of DOCKER_SOURCES) tasks.push(pollDockerSource(source));
      for (const source of FILE_SOURCES) tasks.push(pollFileSource(source));
      await Promise.all(tasks);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  })();
}
