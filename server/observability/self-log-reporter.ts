/**
 * 平台自身日志回灌：把 d-obs web / worker 进程的 ERROR/WARN 摘要写入
 * OTLP 日志域（studio_observability_logs，owner 固定 service:d-obs），
 * 让日志查询与事故根因关联对平台自身故障有料可查。
 *
 * 约束：低敏感（只落单行摘要与结构化元数据）、有界队列、落库失败静默——
 * 回灌本身绝不产生二次错误，也不阻断宿主进程退出。
 */
import { insertLogRecords, type NormalizedLogRecord } from './ai-ecosystem-logs-store.js';

export type SelfLogLevel = 'error' | 'warn' | 'info';

export type SelfLogEntry = {
  level: SelfLogLevel;
  summary: string;
  errorName?: string;
  topFrame?: string;
  tag?: string;
};

export type SelfLogSink = (entry: SelfLogEntry) => void;

const OWNER = 'service:d-obs';
const QUEUE_LIMIT = 128;
const FLUSH_DELAY_MS = 5_000;
const MAX_SUMMARY = 500;

const SEVERITY: Record<SelfLogLevel, { text: string; number: number }> = {
  error: { text: 'ERROR', number: 17 },
  warn: { text: 'WARN', number: 13 },
  info: { text: 'INFO', number: 9 },
};

type InsertFn = typeof insertLogRecords;
let insert: InsertFn = insertLogRecords;

/** 测试注入点：替换落库实现。 */
export function configureSelfLogStore(insertFn: InsertFn): void {
  insert = insertFn;
}

function serviceForComponent(component: string): string {
  return /worker|digest|remediation/i.test(component) ? 'd-obs-worker' : 'd-obs-web';
}

const queue: NormalizedLogRecord[] = [];
let flushTimer: NodeJS.Timeout | null = null;

export function recordSelfLog(component: string, entry: SelfLogEntry): void {
  const severity = SEVERITY[entry.level] ?? SEVERITY.error;
  const summary = String(entry.summary ?? '').trim().slice(0, MAX_SUMMARY);
  if (!summary) return;
  if (queue.length >= QUEUE_LIMIT) queue.shift();
  const attributes: Record<string, string> = { 'process.role': component.slice(0, 64) };
  if (entry.errorName) attributes['error.name'] = entry.errorName.slice(0, 80);
  if (entry.topFrame) attributes['error.top_frame'] = entry.topFrame.slice(0, 240);
  if (entry.tag) attributes['log.tag'] = entry.tag.slice(0, 80);
  queue.push({
    service: serviceForComponent(component),
    environment: 'production',
    severityText: severity.text,
    severityNumber: severity.number,
    body: summary,
    attributes,
    traceId: null,
    spanId: null,
    timestampMs: Date.now(),
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushSelfLogs();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

export async function flushSelfLogs(): Promise<number> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!queue.length) return 0;
  const batch = queue.splice(0, queue.length);
  try {
    return await insert(OWNER, batch);
  } catch {
    return 0;
  }
}

type GuardGlobal = { __rdkSelfProcessGuards?: boolean };

/**
 * 进程级守卫：unhandledRejection 记录后保留进程（免得每次未处理
 * rejection 都变成一次服务闪断；崩溃签名告警继续由 journalctl 巡检
 * 覆盖）；uncaughtExceptionMonitor 只记录、不改变默认崩溃语义。
 */
export function installSelfProcessGuards(): void {
  const guardGlobal = globalThis as typeof globalThis & GuardGlobal;
  if (guardGlobal.__rdkSelfProcessGuards) return;
  guardGlobal.__rdkSelfProcessGuards = true;
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandledRejection:', reason);
  });
  process.on('uncaughtExceptionMonitor', (error) => {
    console.error('[process] uncaughtException:', error);
  });
  // oneshot worker 跑完即退，靠 beforeExit 补刷最后一批。
  process.once('beforeExit', () => {
    void flushSelfLogs();
  });
}
